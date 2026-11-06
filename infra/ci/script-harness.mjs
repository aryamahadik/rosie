// Helpers for the tests of the infra/scripts shell scripts (cf.test.mjs, deploy-preview.test.mjs,
// post-deploy-check.test.mjs, lib.test.mjs). Not a test file itself.
//
// Every test runs the scripts in a throwaway folder in the system temp folder, with fake wrangler, npm, curl
// and sleep commands that only record how they were called (one JSON line each in $FAKE_LOG). HOME points at
// an empty temp folder and the Cloudflare, wrangler, GitHub and database variables of this shell are dropped,
// so no test can reach Cloudflare, npm's registry or a database, or read this Mac's Rosfield sign-in or
// .dev.vars.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../../", import.meta.url));
export const SCRIPTS = path.join(REPO, "infra", "scripts");
export const ROSFIELD_ACCOUNT_ID = "ecb06e7bc9129fa81104d331e9652362";

/** A new empty folder in the system temp folder (its real path), removed after the test. */
export function tempDir(t, name) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `rosie-${name}-`)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function write(file, content, mode) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode !== undefined) chmodSync(file, mode);
}

/** Copies infra/scripts/<name> of this repository to <root>/infra/scripts/<name>. */
export function copyScript(name, root) {
  const target = path.join(root, "infra", "scripts", name);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(SCRIPTS, name), target);
  chmodSync(target, 0o755);
  return target;
}

// The fake commands' one program (CommonJS, whatever package.json is near). argv: <tool> <arguments...>.
//  - Every tool appends {tool, args, cwd, env} to $FAKE_LOG (env: only the variables the tests look at).
//  - A wrangler tool given WRANGLER_OUTPUT_FILE_PATH and "upload" writes a version-upload entry with a preview
//    URL, as wrangler does.
//  - curl: FAKE_CURL_MODE=fail fails to connect (exit 7); ok answers a healthy /health: HTTP 200, ok: true, and
//    the x-trace-id sent (else a new one) in the header and the body. FAKE_CURL_FAILS=<n> fails the first n
//    requests, then answers ok.
const RECORDER = String.raw`"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const [tool, ...args] = process.argv.slice(2);
const log = process.env.FAKE_LOG;
const env = {};
for (const key of ["XDG_CONFIG_HOME", "CLOUDFLARE_ACCOUNT_ID", "WRANGLER_OUTPUT_FILE_PATH", "CF_BUILD_DIR"]) {
  if (key in process.env) env[key] = process.env[key];
}
fs.appendFileSync(log, JSON.stringify({ tool, args, cwd: process.cwd(), env }) + "\n");
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
if (tool.includes("wrangler") && process.env.WRANGLER_OUTPUT_FILE_PATH && args.includes("upload")) {
  const alias = valueOf("--preview-alias") || "none";
  const entry = { type: "version-upload", preview_alias_url: "https://" + alias + "-rosie-staging.example.workers.dev" };
  fs.appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify(entry) + "\n");
}
if (tool === "curl") {
  const counter = log + ".curl-count";
  const count = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
  fs.writeFileSync(counter, String(count));
  const failsFirst = Number(process.env.FAKE_CURL_FAILS || 0);
  if (process.env.FAKE_CURL_MODE === "fail" || count <= failsFirst) {
    process.stderr.write("curl: (7) Failed to connect to the fake host\n");
    process.exit(7);
  }
  const header = valueOf("--header");
  const traceId = header ? header.replace(/^x-trace-id:\s*/i, "") : crypto.randomUUID();
  const body = { ok: true, trace_id: traceId, environment: "staging", version: process.env.FAKE_VERSION || "abc123" };
  fs.writeFileSync(valueOf("--output"), JSON.stringify(body));
  fs.writeFileSync(valueOf("--dump-header"), "HTTP/1.1 200 OK\r\nx-trace-id: " + traceId + "\r\n\r\n");
  process.stdout.write("200");
}
`;

/** Writes the recorder into <dir>/fake/ and returns fake(file, tool): an executable at file that records as tool. */
export function fakeTools(dir) {
  const recorder = path.join(dir, "fake", "record.cjs");
  write(recorder, RECORDER);
  return (file, tool) => {
    write(file, `#!/usr/bin/env bash\nexec "${process.execPath}" "${recorder}" "${tool}" "$@"\n`, 0o755);
  };
}

/** The calls recorded in a $FAKE_LOG file (none when it does not exist). */
export function readLog(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

const DROPPED = /^(CLOUDFLARE_|CF_|WRANGLER_|WORKERS_|GIT_|GITHUB_|CHECK_|PREVIEW_|FAKE_)/;
const DROPPED_NAMES = new Set([
  "CI",
  "XDG_CONFIG_HOME",
  "STAGING_DATABASE_URL",
  "DATABASE_URL",
  "STAGING_BASE_URL",
]);

/**
 * The environment of a script under test: this shell's, without the variables that could reach Cloudflare, a
 * database or this Mac's sign-in, with HOME at home, git isolated from the user's configuration, and extra on
 * top (an extra value of undefined removes the variable).
 */
export function cleanEnv(home, extra = {}) {
  const kept = Object.entries(process.env).filter(([key]) => !DROPPED.test(key) && !DROPPED_NAMES.has(key));
  const env = {
    ...Object.fromEntries(kept),
    HOME: home,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Script Test",
    GIT_AUTHOR_EMAIL: "script-test@example.invalid",
    GIT_COMMITTER_NAME: "Script Test",
    GIT_COMMITTER_EMAIL: "script-test@example.invalid",
    ...extra,
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}
