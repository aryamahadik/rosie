// Spike T-1124: checks of run.sh itself. Run: node --test infra/spikes/hyperdrive-host/run.test.mjs
// Nothing here reaches Cloudflare or a database, and no real key is read. run.sh runs in a throwaway checkout (a
// temporary folder) beside copies of the real infra/scripts/lib.sh and cf.sh, with a stand-in for wrangler behind
// them (standin-wrangler.mjs) and a variables file of made-up values. PATH there holds only recorders: every
// command run.sh, lib.sh and cf.sh start (bash, node, date, sed, tr, ...) first writes down the environment and the
// arguments it was given, then becomes the real command, so no child process starts without being written down.
// Not part of npm test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { test } from "node:test";

const HERE = import.meta.dirname;
const SCRIPTS = join(HERE, "..", "..", "scripts");

// Made-up values, put together here: no real role, password, host, key or address.
const USER = "made_up_role_t1124";
const PASSWORD = "made-up-password-t1124";
const HOST = "ep-made-up-000000.made-up-region.example.test";
const DATABASE_URL = `postgres://${USER}:${PASSWORD}@${HOST}/made_up_db?sslmode=require`;
const OTHER_KEY = "made-up-other-key-t1124";
const AUTHOR = "made-up-author-t1124@example.test";
const SECRETS = [DATABASE_URL, PASSWORD, USER, HOST, OTHER_KEY];
const ID = "0123456789abcdef0123456789abcdef";
const VERSION_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const VERSION_B = "11111111-2222-4333-8444-555555555555";
// The file lib.sh's load_dev_var reads, at the root of a checkout.
const VARIABLES_FILE = [".dev", "vars"].join(".");

// The names the card's ruling lists (DL-482): run.sh's url, created and listing, cf.sh's arg, lib.sh's value and
// line. A caller's shell that holds a variable of such a name hands it on marked for export.
const CALLER = {
  url: "the caller's url",
  created: "the caller's created",
  listing: "the caller's listing",
  arg: "the caller's arg",
  value: "the caller's value",
  line: "the caller's line",
};

// Every command run.sh, lib.sh and cf.sh start by name. PATH holds nothing else, so one that is missing here fails.
const COMMANDS = [
  "bash",
  "basename",
  "cat",
  "curl",
  "date",
  "dirname",
  "mktemp",
  "node",
  "rm",
  "sed",
  "sleep",
  "tail",
  "tr",
];

function isProgram(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The real program of that name: this node, or the first one on this run's PATH. */
function program(command) {
  if (command === "node") {
    return process.execPath;
  }
  const file = (process.env.PATH ?? "")
    .split(delimiter)
    .map((folder) => join(folder, command))
    .find(isProgram);
  assert.ok(file, `${command} is not on PATH`);
  return file;
}

const quoted = (text) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * A recorder: a script that writes down the environment and the arguments it was started with, then becomes
 * `command` with the same arguments (and the same process id).
 */
function recorder(spy, name, command) {
  const record = `${quoted(join(spy, name))}.$$`;
  return [
    "#!/bin/sh",
    `/usr/bin/env >>${record}.env`,
    `printf '%s\\n' \${1+"$@"} >>${record}.argv`,
    `exec ${command.map(quoted).join(" ")} \${1+"$@"}`,
    "",
  ].join("\n");
}

/** What each recorded child process was given: its name, its arguments (one per line) and its environment. */
function childrenIn(spy) {
  return readdirSync(spy)
    .filter((file) => file.endsWith(".env"))
    .map((file) => {
      const record = file.slice(0, -".env".length);
      return {
        name: record.split(".")[0],
        argv: readFileSync(join(spy, `${record}.argv`), "utf8"),
        env: readFileSync(join(spy, file), "utf8"),
      };
    });
}

/**
 * A throwaway checkout: run.sh and what it needs from this folder, the real lib.sh and cf.sh, a wrangler.jsonc that
 * cf.sh accepts, the made-up variables file, the stand-in for wrangler and the recorders. `plan` is the stand-in's
 * (standin-wrangler.mjs); `exists` puts the Hyperdrive configuration there before the run.
 */
function checkout(t, plan, { exists = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "t1124-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const at = (...parts) => join(root, ...parts);
  const spike = at("infra", "spikes", "hyperdrive-host");
  for (const folder of [spike, at("infra", "scripts"), at("node_modules", ".bin")]) {
    mkdirSync(folder, { recursive: true });
  }
  for (const folder of ["bin", "spy", "state", "home", "tmp"]) {
    mkdirSync(at(folder));
  }
  for (const file of ["run.sh", "helpers.mjs", "redact.mjs", "probe.mjs"]) {
    cpSync(join(HERE, file), join(spike, file));
  }
  for (const file of ["lib.sh", "cf.sh"]) {
    cpSync(join(SCRIPTS, file), at("infra", "scripts", file));
  }
  // cf.sh refuses a config that does not name its account and staging's Worker.
  const account = /ROSFIELD_ACCOUNT_ID="([0-9a-f]{32})"/.exec(readFileSync(join(SCRIPTS, "cf.sh"), "utf8"));
  assert.ok(account, "cf.sh no longer pins an account id");
  writeFileSync(
    at("wrangler.jsonc"),
    JSON.stringify({ name: "rosie", account_id: account[1], env: { staging: { name: "rosie-staging" } } }),
  );
  writeFileSync(at(VARIABLES_FILE), `OTHER_MADE_UP_KEY=${OTHER_KEY}\nSTAGING_DATABASE_URL=${DATABASE_URL}\n`);
  writeFileSync(
    at("state", "plan.json"),
    JSON.stringify({ id: ID, author: AUTHOR, create: "ok", versions: [], ...plan }),
  );
  if (exists) {
    writeFileSync(
      at("state", "created.json"),
      JSON.stringify({ name: "rosie-staging-hyperdrive", user: USER, host: HOST, database: "made_up_db" }),
    );
  }
  const write = (file, text) => {
    writeFileSync(file, text);
    chmodSync(file, 0o755);
  };
  for (const command of COMMANDS) {
    write(at("bin", command), recorder(at("spy"), command, [program(command)]));
  }
  write(
    at("node_modules", ".bin", "wrangler"),
    recorder(at("spy"), "wrangler", [process.execPath, join(HERE, "standin-wrangler.mjs"), at("state")]),
  );
  /** Runs one step of the checkout's run.sh with exactly this environment, plus `env`. */
  return (step, env = {}) => {
    const result = spawnSync(program("bash"), [join(spike, "run.sh"), step], {
      cwd: root,
      env: { PATH: at("bin"), HOME: at("home"), TMPDIR: at("tmp"), ...env },
      encoding: "utf8",
      timeout: 120_000,
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      said: `${result.stdout}\n${result.stderr}`,
      children: childrenIn(at("spy")),
    };
  };
}

/** The names of the variables of one recorded environment whose value holds one of the secrets. */
function holders(env, secrets) {
  const names = new Set();
  let name = "(no variable)";
  for (const line of env.split("\n")) {
    name = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1] ?? name;
    if (secrets.some((secret) => line.includes(secret))) {
      names.add(name);
    }
  }
  return [...names].sort();
}

const wordsOf = (child) => child.argv.split("\n");
const label = (child) =>
  [
    child.name,
    ...wordsOf(child)
      .slice(0, 4)
      .map((word) => basename(word)),
  ]
    .join(" ")
    .trim();
const isHostKind = (child) => child.name === "node" && wordsOf(child).includes("host-kind");
const isRedactor = (child) => child.name === "node" && wordsOf(child)[0].endsWith("redact.mjs");

/**
 * Each child process with a secret in its environment, and the variables that hold it. Two are meant to have one
 * and are left out under that one name: helpers.mjs host-kind (PROBE_URL) and redact.mjs (PROBE_REDACT).
 */
function environmentLeaks(children, secrets) {
  const found = new Set();
  for (const child of children) {
    const meant = isHostKind(child) ? "PROBE_URL" : isRedactor(child) ? "PROBE_REDACT" : null;
    const names = holders(child.env, secrets).filter((name) => name !== meant);
    if (names.length > 0) {
      found.add(`${label(child)}: ${names.join(", ")}`);
    }
  }
  return [...found].sort();
}

/**
 * Each child process with a secret among its arguments. Only the create call is meant to have one, as the one
 * argument --connection-string=<value>: bash running cf.sh, then wrangler.
 */
function argumentLeaks(children, secrets) {
  const found = new Set();
  for (const child of children) {
    const words = wordsOf(child);
    const isCreate =
      (child.name === "bash" || child.name === "wrangler") &&
      words.includes("hyperdrive") &&
      words.includes("create");
    const rest = words.filter((word) => !(isCreate && word === `--connection-string=${DATABASE_URL}`));
    if (secrets.some((secret) => rest.some((word) => word.includes(secret)))) {
      found.add(label(child));
    }
  }
  return [...found].sort();
}

const wranglerCalls = (children) =>
  children
    .filter((child) => child.name === "wrangler")
    .map((child) => wordsOf(child).slice(2, 4).join(" "))
    .sort();

function assertNeverShown(result, secrets = SECRETS) {
  secrets.forEach((secret, index) => {
    assert.equal(result.said.includes(secret), false, `run.sh showed made-up secret number ${index + 1}`);
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return String(port);
}

test("create: no child process has the database URL in its environment, whatever names the caller holds", (t) => {
  const run = checkout(t, {});
  const result = run("create", CALLER);
  assert.equal(result.status, 0, result.said);
  assert.match(
    result.stdout,
    new RegExp(`create: rosie-staging-hyperdrive created: id ${ID}, caching disabled`),
  );
  assertNeverShown(result);
  // The run is a real one: the commands of run.sh, lib.sh and cf.sh were all written down ...
  for (const name of ["bash", "date", "dirname", "node", "sed", "tr", "wrangler"]) {
    assert.ok(
      result.children.some((child) => child.name === name),
      `no ${name} was recorded`,
    );
  }
  assert.deepEqual(wranglerCalls(result.children), [
    "hyperdrive create",
    "hyperdrive list",
    "hyperdrive list",
  ]);
  // ... and no child has the URL, a part of it or another line of the variables file in its environment under any
  // name, or as an argument, but for the two ways it is meant to travel.
  assert.deepEqual(environmentLeaks(result.children, SECRETS), []);
  assert.deepEqual(argumentLeaks(result.children, SECRETS), []);
  // Those two ways: by name to the host check, and as one argument to wrangler.
  const hostKind = result.children.filter(isHostKind);
  assert.equal(hostKind.length, 1);
  assert.deepEqual(holders(hostKind[0].env, [DATABASE_URL]), ["PROBE_URL"]);
  const create = result.children.filter(
    (child) => child.name === "wrangler" && wordsOf(child).includes("create"),
  );
  assert.equal(wordsOf(create[0]).filter((word) => word === `--connection-string=${DATABASE_URL}`).length, 1);
});

test("create: a failed create shows wrangler's output without the URL, and still no child has it", (t) => {
  const run = checkout(t, { create: "fail" });
  const result = run("create", CALLER);
  assert.equal(result.status, 1, result.said);
  assert.match(result.stderr, /could not reach \[redacted\]/);
  assert.match(result.stderr, /wrangler could not create rosie-staging-hyperdrive \(exit 1;/);
  assertNeverShown(result);
  assert.ok(
    result.children.some((child) => child.name === "basename"),
    "no basename was recorded",
  );
  assert.deepEqual(environmentLeaks(result.children, SECRETS), []);
  assert.deepEqual(argumentLeaks(result.children, SECRETS), []);
  // The redactor is the one child that is meant to have it, by name.
  const redactor = result.children.filter(isRedactor);
  assert.equal(redactor.length, 1);
  assert.deepEqual(holders(redactor[0].env, [DATABASE_URL]), ["PROBE_REDACT"]);
});

test("create: the same holds when the caller's environment turns allexport on", (t) => {
  const run = checkout(t, {});
  const result = run("create", { SHELLOPTS: "allexport" });
  assert.equal(result.status, 0, result.said);
  assertNeverShown(result);
  assert.deepEqual(environmentLeaks(result.children, SECRETS), []);
  assert.deepEqual(argumentLeaks(result.children, SECRETS), []);
});

test("probe: stops before the probe starts when the serving version cannot be read", async (t) => {
  const run = checkout(t, { versions: [""] }, { exists: true });
  const result = run("probe", { PROBE_PORT: await freePort() });
  assert.equal(result.status, 1, result.said);
  assert.match(result.stderr, /could not be read before the probe/);
  // Nothing was started: no dev session, and no request to one.
  assert.deepEqual(wranglerCalls(result.children), ["deployments status", "hyperdrive list"]);
  assert.equal(
    result.children.some((child) => child.name === "curl"),
    false,
  );
  assert.doesNotMatch(result.said, /serves version unknown|still serves version|the probe passed/);
});

test("probe: fails when the serving version cannot be read after the probe", async (t) => {
  const run = checkout(t, { versions: [VERSION_A, ""] }, { exists: true });
  const result = run("probe", { PROBE_PORT: await freePort() });
  assert.equal(result.status, 1, result.said);
  assert.match(result.stdout, new RegExp(`staging: serves version ${VERSION_A} before the probe`));
  // The probe itself ran and passed; the step fails all the same.
  assert.match(result.stdout, /"ok": true/);
  assert.match(result.said, /could not be read after the probe/);
  assert.doesNotMatch(result.said, /still serves version|the probe passed/);
});

test("probe: fails when another version serves staging after the probe", async (t) => {
  const run = checkout(t, { versions: [VERSION_A, VERSION_B] }, { exists: true });
  const result = run("probe", { PROBE_PORT: await freePort() });
  assert.equal(result.status, 1, result.said);
  assert.match(
    result.stdout,
    new RegExp(`CHANGED during the probe: ${VERSION_A} before, ${VERSION_B} after`),
  );
  assert.doesNotMatch(result.said, /still serves version|the probe passed/);
});

test("probe: passes when the same version serves before and after, and no child has the run's token", async (t) => {
  const run = checkout(t, { versions: [VERSION_A, VERSION_A] }, { exists: true });
  const result = run("probe", {
    ...CALLER,
    text: "the caller's text",
    token: "the caller's token",
    PROBE_PORT: await freePort(),
  });
  assert.equal(result.status, 0, result.said);
  assert.match(result.stdout, new RegExp(`staging: serves version ${VERSION_A} before the probe`));
  assert.match(
    result.stdout,
    new RegExp(`staging: still serves version ${VERSION_A}, the same as before the probe`),
  );
  assert.match(result.stdout, /remote: done, the probe passed and its schema is dropped/);
  assert.deepEqual(wranglerCalls(result.children), [
    "deployments status",
    "deployments status",
    "dev --env",
    "hyperdrive list",
  ]);
  // The run's token (an argument of the dev session and of each request, by design), the list's host and user, and
  // the address in wrangler's status output: in no child's environment.
  const dev = result.children.find((child) => child.name === "wrangler" && wordsOf(child)[2] === "dev");
  const token = /^PROBE_TOKEN:([0-9a-f]{48})$/m.exec(dev.argv)?.[1];
  assert.ok(token, "the dev session was given no token");
  assert.deepEqual(environmentLeaks(result.children, [token, USER, HOST, AUTHOR]), []);
});
