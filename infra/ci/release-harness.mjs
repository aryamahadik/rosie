// Helpers for the tests of T-569's release steps: publish-bundle.sh, flags.sh, and deploy-staging.sh's steps 3 and 4
// (publish-bundle.test.mjs, flags.test.mjs, deploy-staging.test.mjs). Not a test file itself.
//
//   createThrowawayDatabase(tag)  a database of the test file's own on the PostgreSQL server of DATABASE_URL, else the
//                                 local Docker database (factory spec 4: rosie/rosie is local only, not a secret),
//                                 migrated with infra/scripts/migrate.mjs into its public schema, as the staging
//                                 database is. drop() removes it; only a t569_ database this helper made is dropped.
//   releaseRoot(t, {devVars, loginsCheck})
//                                 a throwaway checkout the scripts run in: copies of the scripts and flag sets under
//                                 test and of wrangler.jsonc; this repository's compiler/, db/, bundles/ and migrate.mjs
//                                 linked in (the code the scripts run, read where it is), and node_modules/postgres; a
//                                 fake wrangler that records each call and never reaches Cloudflare; fake curl and sleep
//                                 (script-harness.mjs). Its HOME is empty, so no test reads this Mac's sign-in or keys.
//                                 It holds no .dev.vars, unless devVars gives the text of a made-up one
//                                 (BAD_DATABASE_URLS' commented line). The logins' check deploy-staging.sh runs
//                                 (worker-logins-check.mjs, T-1093) is a stand-in that records its call and passes,
//                                 unless loginsCheck gives the text of the program to put there:
//                                 worker-logins-check.test.mjs gives the real one, with its names swapped for its own.
//   v0WithBuild(t, n)             bundle v0 (bundles/v0/bundle) under another build number, v0's own plus n (so never
//                                 v0's, whatever build bundles/v0 holds): the manifest's bundle id and keys rewritten as
//                                 the compiler's withBundleId() does, the stored values byte for byte, so it is a second
//                                 sound bundle with an id of its own.
//   readActive(sql)               the active bundle id as K-05 readActiveBundle answers it: "<hash>/<build>" or "none".
//   BAD_DATABASE_URLS             staging database URLs a script must fail on with no part of them printed: three that
//                                 do not parse, to be refused, and two of databases that do not answer (the security
//                                 reviews of rounds 1 and 2, DL-356 and DL-363); badUrlRunners(t, rig, names) runs a
//                                 script with each one named, and assertNoUrlPart(result, bad) checks its output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
  "db-url.mjs",
  "hyperdrive-list.mjs",
  "lib.sh",
  "cf.sh",
  "post-deploy-check.sh",
  "rollback-staging.sh",
];

// The fake wrangler (CommonJS). argv: wrangler's arguments, after cf.sh's --config <file>. Every call is one JSON line
// in $FAKE_LOG; kv bulk put also logs the entries of its file. FAKE_KV=fail makes kv bulk put fail. deployments status
// answers FAKE_LIVE_VERSION at 100%, and deploy writes a deploy entry with that version, so a deploy's rollback finds
// staging still on the version it ran before and has nothing to roll back. hyperdrive list (T-1093) prints the file
// FAKE_HYPERDRIVE_LIST names (and fails when none is named), and logs which of its variables have a database URL's
// name or hold a postgres:// URL.
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
} else if (has("hyperdrive", "list")) {
  const names = Object.keys(process.env).sort();
  record({
    tool: "hyperdrive-list",
    databaseNames: names.filter((name) => name.includes("DATABASE")),
    urlHolders: names.filter((name) => /postgres(ql)?:\/\//i.test(process.env[name])),
  });
  if (!process.env.FAKE_HYPERDRIVE_LIST) {
    process.stderr.write("fake wrangler: hyperdrive list is not faked here (no FAKE_HYPERDRIVE_LIST)\n");
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(process.env.FAKE_HYPERDRIVE_LIST, "utf8"));
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

// The logins' check's stand-in (ES module): it records its call, never its environment's values, and passes.
const LOGINS_CHECK_STAND_IN = String.raw`import { appendFileSync } from "node:fs";
if (process.env.FAKE_LOG) {
  const entry = { tool: "worker-logins-check", args: process.argv.slice(2), url: process.env.STAGING_DATABASE_URL ? "set" : "unset" };
  appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\n");
}
process.stdout.write("worker-logins-check: the release harness's stand-in: passed\n");
`;

/** A throwaway checkout to run the release scripts in (see the top of this file). */
export function releaseRoot(t, { devVars, loginsCheck } = {}) {
  const dir = tempDir(t, "release");
  const root = path.join(dir, "rosie");
  for (const script of SCRIPTS) copyScript(script, root);
  write(path.join(root, "infra", "scripts", "worker-logins-check.mjs"), loginsCheck ?? LOGINS_CHECK_STAND_IN);
  if (devVars !== undefined) write(path.join(root, ".dev.vars"), devVars);
  for (const file of ["flags.mjs", "staging.json", "production.json"]) {
    write(path.join(root, "infra", "flags", file), readFileSync(path.join(REPO, "infra", "flags", file)));
  }
  copyFileSync(path.join(REPO, "wrangler.jsonc"), path.join(root, "wrangler.jsonc"));
  for (const linked of ["compiler", "db", "bundles", "infra/scripts/migrate.mjs"]) {
    symlinkSync(path.join(REPO, linked), path.join(root, linked));
  }
  const recorder = path.join(dir, "fake", "wrangler.cjs");
  write(recorder, FAKE_WRANGLER);
  // The database client the logins' check imports (a copy, not a link, finds node_modules from the root).
  mkdirSync(path.join(root, "node_modules"), { recursive: true });
  symlinkSync(path.join(REPO, "node_modules", "postgres"), path.join(root, "node_modules", "postgres"));
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

/** Bundle v0 under build number v0's own plus `n` (see the top of this file). */
export function v0WithBuild(t, n) {
  const dir = path.join(tempDir(t, `bundle-${n}`), "bundle");
  cpSync(path.join(REPO, "bundles", "v0", "bundle"), dir, { recursive: true });
  const file = path.join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const { hash } = manifest.bundleId;
  const build = manifest.bundleId.build + n;
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

// Made up, as every value below: no such user, password or database exists, a .invalid host never resolves (RFC 6761),
// and port 1 of this machine refuses a connection at once.
const BAD_USER = "staging_owner_t569";
const BAD_HOST = "db-t569.example.invalid";
const BAD_DATABASE = "t569_staging_db";

/**
 * Staging database URLs a script must fail on (the security reviews of rounds 1 and 2; DL-356, DL-363). Each comes from
 * STAGING_DATABASE_URL (env) or from a line of the checkout's .dev.vars (devVars); `parts` are what no output may hold:
 * the user, the password and each piece of it around its "#", the host and the database name.
 * Three do not parse, and are refused before any client is built:
 *   hash             a password with an unencoded "#": what follows no longer parses as a URL, and Node's URL error
 *                    keeps the whole string, password included, in its input property.
 *   hashAfterDigits  the same after digits: what follows still parses, as a URL whose host is the user and whose port
 *                    is the digits, so a client would connect to a host the URL never named.
 *   comment          a .dev.vars line with a comment after the quoted URL: lib.sh's load_dev_var keeps the quotes and
 *                    the comment in the value.
 * Two parse, and name a database that does not answer, so the client's own error would name its host:
 *   refused          a connection refused (port 1 of this machine).
 *   notFound         a host that is not found (a .invalid name).
 */
export const BAD_DATABASE_URLS = {
  hash: {
    name: "a password with an unencoded #",
    env: `postgres://${BAD_USER}:Zq9vT2#Lk4pX@${BAD_HOST}:5432/${BAD_DATABASE}`,
    parts: [BAD_USER, "Zq9vT2#Lk4pX", "Zq9vT2", "Lk4pX", BAD_HOST, BAD_DATABASE],
  },
  hashAfterDigits: {
    name: "a password with an unencoded # after digits",
    env: `postgres://${BAD_USER}:2718#Wm5yH8@${BAD_HOST}:5432/${BAD_DATABASE}`,
    parts: [BAD_USER, "2718#Wm5yH8", "Wm5yH8", BAD_HOST, BAD_DATABASE],
  },
  comment: {
    name: "a .dev.vars line with a comment after the quoted URL",
    devVars: `STAGING_DATABASE_URL="postgres://${BAD_USER}:Vb7rN3sQ9kL2@${BAD_HOST}:5432/${BAD_DATABASE}" # the staging database (J-06)\n`,
    parts: [BAD_USER, "Vb7rN3sQ9kL2", BAD_HOST, BAD_DATABASE],
  },
  refused: {
    name: "a database that refuses the connection",
    env: `postgres://${BAD_USER}:Pw9sK2mX7@127.0.0.1:1/${BAD_DATABASE}`,
    parts: [BAD_USER, "Pw9sK2mX7", "127.0.0.1", BAD_DATABASE],
  },
  notFound: {
    name: "a database host that is not found",
    env: `postgres://${BAD_USER}:Hn4wQ8zR2@${BAD_HOST}:5432/${BAD_DATABASE}`,
    parts: [BAD_USER, "Hn4wQ8zR2", BAD_HOST, BAD_DATABASE],
  },
};

/**
 * One runner for each BAD_DATABASE_URLS value `names` lists. run(script, args, extra) runs infra/scripts/<script> with
 * that value as the staging database URL: from the environment on `rig`, or from the .dev.vars of a release root of
 * its own; calls() are the fake calls of the root it runs in. Give the test's own database in extra's DATABASE_URL: a
 * script that fell back to it would write where the test looks.
 */
export function badUrlRunners(t, rig, names) {
  return names.map((name) => {
    const bad = BAD_DATABASE_URLS[name];
    const on = bad.devVars === undefined ? rig : releaseRoot(t, { devVars: bad.devVars });
    const env = bad.env === undefined ? {} : { STAGING_DATABASE_URL: bad.env };
    return {
      bad,
      run: (script, args, extra = {}) => on.run(script, args, { ...extra, ...env }),
      calls: () => on.calls(),
    };
  });
}

/** Fails when a run's stdout or stderr holds any of bad.parts (a database URL's user, password or host). */
export function assertNoUrlPart(result, bad, what) {
  const held = bad.parts.filter((part) => result.output.includes(part));
  assert.deepEqual(held, [], `${what}: the output holds a part of the database URL:\n${result.output}`);
}
