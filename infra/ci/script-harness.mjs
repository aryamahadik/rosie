// Helpers for the tests of the infra/scripts shell scripts (cf.test.mjs, deploy-preview.test.mjs,
// post-deploy-check.test.mjs, lib.test.mjs). Not a test file itself.
//
// Every test runs the scripts in a throwaway folder in the system temp folder, with fake wrangler, npm, curl
// and sleep commands that only record how they were called (one JSON line each in $FAKE_LOG). HOME points at
// an empty temp folder and the Cloudflare, wrangler, GitHub and database variables of this shell are dropped,
// so no test can reach Cloudflare, npm's registry or a database, or read this Mac's Rosfield sign-in or
// .dev.vars. So is ROSIE_NUMBER, Rosie's own number (DL-581): a deploy test that gives none of its own never
// takes this shell's, so no real number reaches a stand-in's call log.
//
// spies() (T-1343) puts a recorder in front of each command a script starts by name, for a run whose PATH holds them
// alone, so none starts unseen; each keeps a copy of its environment and its arguments, and a test checks both
// (whereHeld, namedIn), as the recorders T-1310 wrote do in deploy-preview.test.mjs and seed-staging.test.mjs.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
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
  "ROSIE_NUMBER",
]);

/**
 * The environment of a script under test: this shell's, without the variables that could reach Cloudflare, a
 * database or this Mac's sign-in, or hold Rosie's own number, with HOME at home, git isolated from the user's
 * configuration, and extra on top (an extra value of undefined removes the variable).
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

// The spies (T-1343; T-1310's recorders, which its security review's note a asked to check arguments too). A recorder is
// a /bin/sh script that keeps env's output in <spy>/<name>.<pid>.env, and the count of its arguments then each argument,
// every one ended by a NUL byte, in <spy>/<name>.<pid>.args, then becomes its command with the same arguments.

const shellQuoted = (text) => `'${text.replaceAll("'", `'\\''`)}'`;

/** The real program of that name: the first on this shell's PATH. */
export function program(command) {
  const file = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((folder) => path.join(folder, command))
    .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (file === undefined) throw new Error(`${command} is not on PATH`);
  return file;
}

/**
 * Recorders under dir (see above): spy-bin/<command> in front of the real program of that name for each of `commands`,
 * and spy-bin/<name> in front of its command line for each entry of `programs` ({name: [file, ...arguments]}).
 * bin: the folder that is a spied run's whole PATH. put(file, name, command): one more recorder at any path, such as a
 * checkout's node_modules/.bin/wrangler. clear(): empties the spy folder, before a run. children(): what the recorders
 * kept, one {name, args, env} for each command started (env: env's output, one variable a line).
 */
export function spies(dir, commands, programs = {}) {
  const spy = path.join(dir, "spy");
  const bin = path.join(dir, "spy-bin");
  mkdirSync(spy, { recursive: true });
  const put = (file, name, command) => {
    const record = `${shellQuoted(path.join(spy, name))}.$$`;
    const text = [
      "#!/bin/sh",
      `/usr/bin/env >>${record}.env`,
      `printf '%s\\0' "$#" \${1+"$@"} >>${record}.args`,
      `exec ${command.map(shellQuoted).join(" ")} \${1+"$@"}`,
      "",
    ].join("\n");
    write(file, text, 0o755);
  };
  for (const command of commands) put(path.join(bin, command), command, [program(command)]);
  for (const [name, command] of Object.entries(programs)) put(path.join(bin, name), name, command);
  return {
    bin,
    put,
    clear() {
      rmSync(spy, { recursive: true, force: true });
      mkdirSync(spy);
    },
    children() {
      return readdirSync(spy)
        .filter((file) => file.endsWith(".env"))
        .map((file) => {
          const record = file.slice(0, -".env".length);
          const [count, ...rest] = readFileSync(path.join(spy, `${record}.args`), "utf8").split("\0");
          return {
            name: record.slice(0, record.lastIndexOf(".")),
            args: rest.slice(0, Number(count)),
            env: readFileSync(path.join(spy, file), "utf8"),
          };
        });
    },
  };
}

/** The names of a recorded environment's variables whose value holds one of the texts, sorted. */
export function envHolders(env, texts) {
  const names = new Set();
  let name = "(no variable)";
  for (const line of env.split("\n")) {
    name = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1] ?? name;
    if (texts.some((text) => line.includes(text))) names.add(name);
  }
  return [...names].sort();
}

/**
 * Where a run's children hold one of the texts, as "<kind>: env <names>" (the variables whose value holds one),
 * "<kind>: args <n>" (how many arguments hold one) or both, one line for each child that holds any, sorted; kindOf names
 * a child for the test. A child that holds none is left out, so an empty list means no child holds any.
 */
export function whereHeld(children, texts, kindOf) {
  const lines = [];
  for (const child of children) {
    const names = envHolders(child.env, texts);
    const args = child.args.filter((arg) => texts.some((text) => arg.includes(text))).length;
    const where = [
      ...(names.length > 0 ? [`env ${names.join(" ")}`] : []),
      ...(args > 0 ? [`args ${String(args)}`] : []),
    ];
    if (where.length > 0) lines.push(`${kindOf(child)}: ${where.join(", ")}`);
  }
  return lines.sort();
}

/** The children whose environment has a variable of one of the names, whatever it holds, as "<kind>: <names>", sorted. */
export function namedIn(children, names, kindOf) {
  return children
    .map((child) => {
      const lines = child.env.split("\n");
      const present = names.filter((name) => lines.some((line) => line.startsWith(`${name}=`)));
      return present.length > 0 ? `${kindOf(child)}: ${present.join(" ")}` : "";
    })
    .filter((line) => line !== "")
    .sort();
}
