// Helpers for the tests of T-569's release steps: publish-bundle.sh, flags.sh, and deploy-staging.sh's steps 3 and 4
// (publish-bundle.test.mjs, flags.test.mjs, deploy-staging.test.mjs). Not a test file itself.
//
//   createThrowawayDatabase(tag)  a database of the test file's own on the PostgreSQL server of DATABASE_URL, else the
//                                 local Docker database (factory spec 4: rosie/rosie is local only, not a secret),
//                                 migrated with infra/scripts/migrate.mjs into its public schema, as the staging
//                                 database is. drop() removes it; only a t569_ database this helper made is dropped.
//   releaseRoot(t)                a throwaway checkout the scripts run in: copies of the scripts and flag sets under
//                                 test and of wrangler.jsonc; this repository's compiler/, db/, bundles/ and migrate.mjs
//                                 linked in (the code the scripts run, read where it is); a fake wrangler that records
//                                 each call and never reaches Cloudflare; fake curl and sleep (script-harness.mjs). Its
//                                 HOME is empty and it holds no .dev.vars, so no test reads this Mac's sign-in or keys.
//   v0WithBuild(t, build)         bundle v0 (bundles/v0/bundle) under another build number: the manifest's bundle id and
//                                 keys rewritten as the compiler's withBundleId() does, the stored values byte for byte,
//                                 so it is a second sound bundle with an id of its own.
//   readActive(sql)               the active bundle id as K-05 readActiveBundle answers it: "<hash>/<build>" or "none".
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, cpSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

import { readActiveBundle } from "../../db/repo/bundles.ts";
import { REPO, cleanEnv, copyScript, fakeTools, readLog, tempDir, write } from "./script-harness.mjs";

const SERVER_URL = process.env.DATABASE_URL || "postgres://rosie:rosie@127.0.0.1:54329/rosie";
const V0_MANIFEST = JSON.parse(readFileSync(path.join(REPO, "bundles/v0/bundle/manifest.json"), "utf8"));

/** Bundle v0's id, from its manifest (whatever bundles/v0 holds). */
export const V0_ID = `${V0_MANIFEST.bundleId.hash}/${V0_MANIFEST.bundleId.build}`;
/** The keys of bundle v0's parts: the manifest and each stored value. */
export const V0_KEYS = [
  V0_MANIFEST.storage.manifestKey,
  ...V0_MANIFEST.storage.values.map((value) => value.key),
];

/** The scripts the release steps run, copied into a release root. */
const SCRIPTS = [
  "deploy-staging.sh",
  "publish-bundle.sh",
  "flags.sh",
  "lib.sh",
  "cf.sh",
  "post-deploy-check.sh",
  "rollback-staging.sh",
];

// The fake wrangler (CommonJS). argv: wrangler's arguments, after cf.sh's --config <file>. Every call is one JSON line
// in $FAKE_LOG; kv bulk put also logs the entries of its file. FAKE_KV=fail makes kv bulk put fail. deployments status
// answers FAKE_LIVE_VERSION at 100%, and deploy writes a deploy entry with that version, so a deploy's rollback finds
// staging still on the version it ran before and has nothing to roll back.
const FAKE_WRANGLER = String.raw`"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
const record = (entry) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\n");
record({ tool: "wrangler", args });
const has = (...words) => words.every((word) => args.includes(word));
if (has("kv", "bulk", "put")) {
  record({ tool: "kv", entries: JSON.parse(fs.readFileSync(args[args.indexOf("put") + 1], "utf8")) });
  if (process.env.FAKE_KV === "fail") {
    process.stderr.write("fake wrangler: kv bulk put failed\n");
    process.exit(1);
  }
  process.stdout.write("Success!\n");
} else if (has("deployments", "status")) {
  const versions = [{ version_id: process.env.FAKE_LIVE_VERSION, percentage: 100 }];
  process.stdout.write(JSON.stringify({ versions }) + "\n");
} else if (has("deploy")) {
  const entry = { type: "deploy", version_id: process.env.FAKE_LIVE_VERSION, targets: [] };
  fs.appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify(entry) + "\n");
} else {
  process.stderr.write("fake wrangler: " + args.join(" ") + " is not faked\n");
  process.exit(1);
}
`;

/** A migrated database of the caller's own (see the top of this file). */
export async function createThrowawayDatabase(tag) {
  const name = `t569_${tag}_${randomBytes(4).toString("hex")}`;
  const admin = postgres(SERVER_URL, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`create database ${name}`);
  const url = new URL(SERVER_URL);
  url.pathname = `/${name}`;
  let sql;
  const drop = async () => {
    await sql?.end({ timeout: 5 });
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.end({ timeout: 5 });
  };
  try {
    const env = { ...process.env, DATABASE_URL: url.href, DB_SCHEMA: "" };
    delete env.CI;
    const migrated = spawnSync(process.execPath, [path.join(REPO, "infra/scripts/migrate.mjs")], {
      env,
      encoding: "utf8",
    });
    if (migrated.status !== 0)
      throw new Error(`migrating ${name} failed:\n${migrated.stdout}${migrated.stderr}`);
    sql = postgres(url.href, { max: 2, onnotice: () => undefined });
  } catch (error) {
    await drop();
    throw error;
  }
  return { name, url: url.href, sql, drop };
}

/** A throwaway checkout to run the release scripts in (see the top of this file). */
export function releaseRoot(t) {
  const dir = tempDir(t, "release");
  const root = path.join(dir, "rosie");
  for (const script of SCRIPTS) copyScript(script, root);
  for (const file of ["flags.mjs", "staging.json", "production.json"]) {
    write(path.join(root, "infra", "flags", file), readFileSync(path.join(REPO, "infra", "flags", file)));
  }
  copyFileSync(path.join(REPO, "wrangler.jsonc"), path.join(root, "wrangler.jsonc"));
  for (const linked of ["compiler", "db", "bundles", "infra/scripts/migrate.mjs"]) {
    symlinkSync(path.join(REPO, linked), path.join(root, linked));
  }
  const recorder = path.join(dir, "fake", "wrangler.cjs");
  write(recorder, FAKE_WRANGLER);
  write(
    path.join(root, "node_modules", ".bin", "wrangler"),
    `#!/usr/bin/env bash\nexec "${process.execPath}" "${recorder}" "$@"\n`,
    0o755,
  );
  const fake = fakeTools(dir);
  const bin = path.join(dir, "bin");
  fake(path.join(bin, "curl"), "curl");
  fake(path.join(bin, "sleep"), "sleep");
  const home = path.join(dir, "home");
  write(path.join(home, ".keep"), "");
  const log = path.join(dir, "calls.ndjson");
  return {
    dir,
    root,
    /** Runs infra/scripts/<script> of the root with the variables given (and none of this shell's keys). */
    run(script, args, extra = {}) {
      const env = cleanEnv(home, {
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_LOG: log,
        DB_SCHEMA: undefined,
        ...extra,
      });
      const result = spawnSync("bash", [path.join(root, "infra", "scripts", script), ...args], {
        cwd: root,
        env,
        encoding: "utf8",
      });
      return { ...result, output: `${result.stdout}${result.stderr}` };
    },
    /** The fake commands' calls so far. */
    calls: () => readLog(log),
  };
}

/** Bundle v0 under build number `build` (see the top of this file). */
export function v0WithBuild(t, build) {
  const dir = path.join(tempDir(t, `bundle-${build}`), "bundle");
  cpSync(path.join(REPO, "bundles", "v0", "bundle"), dir, { recursive: true });
  const file = path.join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const { hash } = manifest.bundleId;
  const from = `bundle/${hash}/${manifest.bundleId.build}/`;
  const to = `bundle/${hash}/${build}/`;
  manifest.bundleId = { hash, build };
  manifest.storage.manifestKey = manifest.storage.manifestKey.replace(from, to);
  for (const value of manifest.storage.values) value.key = value.key.replace(from, to);
  writeFileSync(file, JSON.stringify(manifest));
  return {
    dir,
    id: `${hash}/${build}`,
    keys: [manifest.storage.manifestKey, ...manifest.storage.values.map((v) => v.key)],
  };
}

/** The active bundle id, through K-05 readActiveBundle (db/repo/bundles.ts). */
export async function readActive(sql) {
  const answer = await readActiveBundle(sql);
  if ("result" in answer) return `${answer.bundleId.hash}/${answer.bundleId.build}`;
  if (answer.error === "noActiveBundle") return "none";
  throw new Error(`readActiveBundle answered ${answer.error}`);
}
