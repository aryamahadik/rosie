// Tests for infra/scripts/make-staging-secrets.sh, `npm run secrets:staging:make` (T-1236; T-1276, ADR-016 card G;
// C-022; CQ-210; build prompt rule 7: keys are named, never shown), run by `node --test "infra/ci/*.test.mjs"`. The
// script runs in a throwaway checkout: copies of it, lib.sh and the real cf.sh, this repository's wrangler.jsonc, a
// made-up .dev.vars, and two stand-ins that never reach Cloudflare:
//  - wrangler, at node_modules/.bin/wrangler, with made-up state (a file of the names "staging" holds): `secret list`
//    prints those names as wrangler does, `secret put` records what cf.sh hands it and adds the name;
//  - node, first on PATH: the real node with a recorder loaded first, so cf.sh's own node program and the script's two
//    (the generator and the reader of the list) run as they are, and each call is recorded.
// So cf.sh's checks run as they are, a value is seen exactly where wrangler would get it, and every command the script
// starts says whether its environment or its arguments hold a value. HOME and TMPDIR are folders of the test's own,
// and no run gets this shell's values of the names (script-harness.mjs). Every value is made up or made by the script
// under test in the run, so no key-shaped text sits in this file: none is a key of anything.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  REPO,
  ROSFIELD_ACCOUNT_ID,
  SCRIPTS,
  cleanEnv,
  copyScript,
  readLog,
  tempDir,
  write,
} from "./script-harness.mjs";

const SCRIPT = "make-staging-secrets.sh";
// The names the script makes, in its order, and what stands before the base64 in each one's form. PROOF_CODE_HASH_KEY
// joined with ADR-016's sign-in by code (T-1276): 32 random bytes as base64, as SEALING_WRAP_KEY.
const NAMES = ["SEALING_WRAP_KEY", "LINQ_WEBHOOK_SECRET", "PROOF_CODE_HASH_KEY"];
const PREFIX = { SEALING_WRAP_KEY: "", LINQ_WEBHOOK_SECRET: "whsec_", PROOF_CODE_HASH_KEY: "" };
// The vendor's key staging reads too: put by secrets:staging from .dev.vars, never made.
const MODEL_KEY = "ANTHROPIC_API_KEY";
// The names staging holds since T-1236's live run (DL-518): the model key and the two made then, which are never
// replaced (DL-495).
const HELD_NOW = [MODEL_KEY, "SEALING_WRAP_KEY", "LINQ_WEBHOOK_SECRET"];
// The names secrets:staging puts from .dev.vars for sign-in by code (ADR-016 section 5): Resend's send-only key and the
// testers' inbox list. Neither is ever made here.
const GIVEN_NAMES = ["RESEND_API_KEY", "STAGING_TEST_INBOXES"];

// Made-up values a checkout's .dev.vars may hold under the names, in the forms the code reads them in.
const DEV_VALUES = {
  SEALING_WRAP_KEY: Buffer.alloc(32, 0x5a).toString("base64"),
  LINQ_WEBHOOK_SECRET: `whsec_${Buffer.from("t1236 made-up webhook signing bytes 0001").toString("base64")}`,
  PROOF_CODE_HASH_KEY: Buffer.alloc(32, 0x6c).toString("base64"),
};
// Other made-up values under the same names, as the caller's shell might hold them: never put, never counted.
const SHELL_VALUES = {
  SEALING_WRAP_KEY: Buffer.alloc(32, 0x33).toString("base64"),
  LINQ_WEBHOOK_SECRET: `whsec_${Buffer.from("t1236 another made-up signing secret 0002").toString("base64")}`,
  PROOF_CODE_HASH_KEY: Buffer.alloc(32, 0x44).toString("base64"),
};
// Lines of other names in the same .dev.vars: the script reads none of them. The inbox list's addresses are made up, on
// domains kept for examples (rule 9).
const MODEL_VALUE = `t1236-made-up-model-key-${"0f3c9a71".repeat(3)}`;
const OTHER_VALUE = "t1236-made-up-email-key-55aa90c3";
const INBOX_VALUE = "t1276-tester-one@example.com,t1276-tester-two@example.net";
const GIVEN_VALUES = [
  ...Object.values(DEV_VALUES),
  ...Object.values(SHELL_VALUES),
  MODEL_VALUE,
  OTHER_VALUE,
  INBOX_VALUE,
];
// 32 made-up bytes whose base64 holds every sign base64 has: forty "+", then "//8=". The stand-in for node gives it in
// place of random bytes where a test needs to know the value before the run.
const KNOWN_BYTES = Buffer.concat([
  Buffer.alloc(30, Buffer.from([0xfb, 0xef, 0xbe])),
  Buffer.from([0xff, 0xff]),
]).toString("base64");

/** A value without its prefix: the base64 alone. */
const bare = (value) => value.replace(/^whsec_/, "");

/**
 * A .dev.vars in the build Mac's forms, with a quoted line, an exported line and a plain line for the names given a
 * value, beside the vendor's keys and the inbox list that secrets:staging puts.
 */
const devVars = (values = {}) =>
  [
    "# made-up values for T-1236's and T-1276's tests",
    `RESEND_API_KEY=${OTHER_VALUE}`,
    `${MODEL_KEY}=${MODEL_VALUE}`,
    `STAGING_TEST_INBOXES=${INBOX_VALUE}`,
    ...("SEALING_WRAP_KEY" in values ? [`SEALING_WRAP_KEY="${values.SEALING_WRAP_KEY}"`] : []),
    ...("LINQ_WEBHOOK_SECRET" in values
      ? [`  export LINQ_WEBHOOK_SECRET='${values.LINQ_WEBHOOK_SECRET}'`]
      : []),
    ...("PROOF_CODE_HASH_KEY" in values ? [`PROOF_CODE_HASH_KEY=${values.PROOF_CODE_HASH_KEY}`] : []),
    "",
  ].join("\n");

// What both stand-ins start with (CommonJS). `watched`: the texts no environment variable and no argument of a command
// may hold: the ones $FAKE_WATCH lists (the made-up values above, and what a test has the generator give) and every
// value a put has been given so far in this checkout, with and without its prefix.
const WATCH = String.raw`"use strict";
const fs = require("node:fs");
const bare = (text) => text.replace(/^whsec_/, "");
const watched = JSON.parse(fs.readFileSync(process.env.FAKE_WATCH, "utf8"));
if (fs.existsSync(process.env.FAKE_LOG)) {
  for (const line of fs.readFileSync(process.env.FAKE_LOG, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line);
    if (entry.tool === "wrangler" && entry.stdin !== "") watched.push(entry.stdin, bare(entry.stdin));
  }
}
const envNames = Object.keys(process.env);
const held = (args) => ({
  envNames,
  envHoldingValue: envNames.filter((key) => watched.some((text) => process.env[key].includes(text))),
  argsHoldingValue: args.filter((arg) => watched.some((text) => arg.includes(text))).length,
});
`;

// The stand-in for wrangler. argv: wrangler's arguments, as cf.sh hands them on. It records one JSON line in $FAKE_LOG:
// its arguments, its standard input (read for a put alone), its folder, the names (never the values) of its
// environment's variables, the names of those that hold a watched text or what came on standard input, how many
// arguments do, and three settings cf.sh and the script make.
//  - secret list: prints the names in $FAKE_STATE as wrangler's JSON list (--format json), or FAKE_LIST_STDOUT as it
//    is; FAKE_LIST_STDERR goes to standard error and FAKE_LIST_EXIT is its exit code.
//  - secret put: repeats its standard input on both streams, as a wrangler that showed a secret would, fails for the
//    name FAKE_FAIL_AT gives, and otherwise adds the name to $FAKE_STATE (names only).
const FAKE_WRANGLER = `${WATCH}${String.raw`
const args = process.argv.slice(2);
let stdin = "";
if (args.includes("put")) {
  try {
    stdin = fs.readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
  if (stdin !== "") watched.push(stdin, bare(stdin));
}
const env = {};
for (const key of ["XDG_CONFIG_HOME", "CLOUDFLARE_ACCOUNT_ID", "WRANGLER_LOG_SANITIZE"]) {
  if (key in process.env) env[key] = process.env[key];
}
const entry = { tool: "wrangler", args, stdin, cwd: process.cwd(), ...held(args), env };
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\n");
const names = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, "utf8"));
if (args.includes("list")) {
  if ("FAKE_LIST_STDERR" in process.env) process.stderr.write(process.env.FAKE_LIST_STDERR);
  if ("FAKE_LIST_STDOUT" in process.env) process.stdout.write(process.env.FAKE_LIST_STDOUT);
  else {
    const list = names.map((name) => ({ name, type: "secret_text" }));
    process.stdout.write(JSON.stringify(list, null, "  ") + "\n");
  }
  process.exit(Number(process.env.FAKE_LIST_EXIT || 0));
}
const name = args[args.indexOf("put") + 1];
process.stdout.write("fake wrangler: was given " + stdin + "\n");
process.stderr.write("fake wrangler: was given " + stdin + ", key bytes " + bare(stdin) + "\n");
if (process.env.FAKE_FAIL_AT === name) {
  process.stderr.write("fake wrangler: secret put " + name + " failed\n");
  process.exit(1);
}
if (!names.includes(name)) names.push(name);
fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(names));
process.stdout.write("Success! Uploaded secret " + name + "\n");
`}`;

// The stand-in for node: the real node, with this module loaded first (--require), so the program it was asked to run
// runs as it is, in the same process, with the same arguments and streams. Before that it records one JSON line in
// $FAKE_LOG: whether the call is the script's generator, the names of its environment's variables, the ones that hold a
// watched text, and how many of its arguments do (its options, the program after -e among them). With FAKE_RANDOM_FILE
// set, the generator's call prints that file instead and exits with FAKE_RANDOM_EXIT: a value known before the run,
// or a generator gone wrong.
const FAKE_NODE = `${WATCH}${String.raw`
const args = [...process.execArgv, ...process.argv.slice(1)];
const generates = process.execArgv.some((arg) => arg.includes("randomBytes"));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: "node", generates, ...held(args) }) + "\n");
if (generates && "FAKE_RANDOM_FILE" in process.env) {
  process.stdout.write(fs.readFileSync(process.env.FAKE_RANDOM_FILE, "utf8"));
  process.exit(Number(process.env.FAKE_RANDOM_EXIT || 0));
}
`}`;

/**
 * A throwaway checkout (see the top of this file). devVars: the text of its .dev.vars (left out: it has none); mode:
 * that file's mode; files: other files of the checkout; staging: the names staging holds at the start; random: what
 * the generator gives in place of random bytes (left out: the real generator runs), which no command's environment or
 * arguments may hold either.
 */
function checkout(t, { devVars: text, mode, files = {}, staging = [MODEL_KEY], random } = {}) {
  const dir = tempDir(t, "make-secrets");
  const root = path.join(dir, "rosie");
  const script = copyScript(SCRIPT, root);
  copyScript("lib.sh", root);
  copyScript("cf.sh", root);
  copyFileSync(path.join(REPO, "wrangler.jsonc"), path.join(root, "wrangler.jsonc"));
  const devVarsFile = path.join(root, ".dev.vars");
  if (text !== undefined) write(devVarsFile, text, mode);
  for (const [name, content] of Object.entries(files)) write(path.join(root, name), content);
  const stub = (file, ...words) => {
    const command = [process.execPath, ...words].map((word) => `"${word}"`).join(" ");
    write(file, `#!/usr/bin/env bash\nexec ${command} "$@"\n`, 0o755);
  };
  const wrangler = path.join(dir, "fake", "wrangler.cjs");
  write(wrangler, FAKE_WRANGLER);
  stub(path.join(root, "node_modules", ".bin", "wrangler"), wrangler);
  const node = path.join(dir, "fake", "node.cjs");
  write(node, FAKE_NODE);
  const bin = path.join(dir, "bin");
  stub(path.join(bin, "node"), "--require", node);
  const home = path.join(dir, "home");
  write(path.join(home, ".keep"), "");
  const tmp = path.join(dir, "tmp");
  mkdirSync(tmp);
  const log = path.join(dir, "calls.ndjson");
  const state = path.join(dir, "staging-names.json");
  write(state, JSON.stringify(staging));
  const watchFile = path.join(dir, "watched.json");
  const watched = [...GIVEN_VALUES, ...(random === undefined ? [] : [random])];
  write(watchFile, JSON.stringify(watched.filter((value) => value !== "")));
  const randomFile = path.join(dir, "random.txt");
  if (random !== undefined) write(randomFile, random);
  /** Runs the script; `bash` holds options for bash itself (-x). This shell's values of the names never reach it. */
  const run = (args = [], extra = {}, { bash = [] } = {}) => {
    const unset = Object.fromEntries([...NAMES, MODEL_KEY, ...GIVEN_NAMES].map((name) => [name, undefined]));
    const result = spawnSync("bash", [...bash, script, ...args], {
      cwd: root,
      encoding: "utf8",
      env: cleanEnv(home, {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        FAKE_LOG: log,
        FAKE_STATE: state,
        FAKE_WATCH: watchFile,
        ...(random === undefined ? {} : { FAKE_RANDOM_FILE: randomFile }),
        TMPDIR: tmp,
        ...unset,
        ...extra,
      }),
    });
    return { ...result, output: `${result.stdout}${result.stderr}` };
  };
  const calls = () => readLog(log).filter((entry) => entry.tool === "wrangler");
  return {
    dir,
    root,
    home,
    log,
    devVarsFile,
    watchFile,
    randomFile,
    run,
    /** Every command recorded, in order: wrangler's and node's. */
    started: () => readLog(log),
    /** wrangler's calls, in order, and the puts among them. */
    calls,
    puts: () => calls().filter((call) => call.args.includes("put")),
    /** How many times the script's generator ran. */
    generated: () => readLog(log).filter((entry) => entry.tool === "node" && entry.generates).length,
    /** The names staging holds now. */
    held: () => JSON.parse(readFileSync(state, "utf8")),
  };
}

const config = (rig) => ["--config", path.join(rig.root, "wrangler.jsonc")];
/** The wrangler arguments of the list and of one put, as cf.sh hands them on. */
const listArgs = (rig) => [...config(rig), "secret", "list", "--env", "staging", "--format", "json"];
const putArgs = (rig, name) => [...config(rig), "secret", "put", name, "--env", "staging"];

const source = (file) => readFileSync(path.join(REPO, file), "utf8");

/** The wrapping key's length in bytes, as db/repo/sealing.ts importWrappingKey checks it. */
function wrappingKeyBytes() {
  const match = /^const KEY_BYTES = (\d+);$/m.exec(source("db/repo/sealing.ts"));
  assert.ok(match, "db/repo/sealing.ts no longer holds: const KEY_BYTES = <n>;");
  return Number(match[1]);
}

/** The base64 adapters/src/shared/hmac.ts importLinqKey takes after "whsec_": that file's own pattern. */
function linqKeyBase64() {
  const match = /^const BASE64 = \/(.+)\/;$/m.exec(source("adapters/src/shared/hmac.ts"));
  assert.ok(match, "adapters/src/shared/hmac.ts no longer holds: const BASE64 = /<pattern>/;");
  return new RegExp(match[1]);
}

/**
 * Fails unless a value is in its name's form: the prefix, then 32 bytes as base64 and nothing else. The wrapping key
 * is read as db/repo/sealing.ts reads it (atob of the trimmed text, KEY_BYTES long); the webhook secret's base64 is
 * what adapters/src/shared/hmac.ts takes. The proof-code hash key is 32 bytes as base64 with no prefix, as ADR-016
 * card G makes it; the hashing port that reads it is still to be built (T-1289). A failure names the fault and
 * lengths, never the value.
 */
function assertForm(name, value) {
  const prefix = PREFIX[name];
  assert.ok(value.startsWith(prefix), `${name}: does not start with "${prefix}"`);
  const text = value.slice(prefix.length);
  assert.ok(
    /^[A-Za-z0-9+/]{43}=$/.test(text),
    `${name}: not 43 signs of base64 and one = (${String(text.length)} characters)`,
  );
  const bytes = Buffer.from(text, "base64");
  assert.equal(bytes.length, 32, `${name}: bytes`);
  assert.equal(bytes.toString("base64"), text, `${name}: base64 as written from its own bytes`);
  if (name === "SEALING_WRAP_KEY") {
    assert.equal(atob(value.trim()).length, wrappingKeyBytes(), `${name}: the length sealing.ts takes`);
  }
  if (name === "LINQ_WEBHOOK_SECRET") {
    assert.ok(linqKeyBase64().test(text), `${name}: not the base64 hmac.ts takes after whsec_`);
  }
}

/** Fails when a run's standard output or standard error holds any of the values, with or without a prefix. */
function assertNoValueShown(result, values, what) {
  for (const stream of ["stdout", "stderr"]) {
    const held = [...GIVEN_VALUES, ...values].filter(
      (value) => result[stream].includes(value) || result[stream].includes(bare(value)),
    );
    assert.equal(held.length, 0, `${what}: ${stream} holds a value`);
  }
}

/**
 * Fails when any command the script started (wrangler, for the list and each put; node, for the generator, the list's
 * reader and cf.sh's config check) holds a value in its environment or its arguments, or has a variable of a secret's
 * name or under any of `names` in its environment.
 */
function assertNothingHandedOn(rig, what, names = []) {
  const started = rig.started();
  assert.ok(started.length > 0, `${what}: no command was recorded`);
  for (const [index, entry] of started.entries()) {
    const which = `${what}, command ${String(index + 1)} (${entry.tool})`;
    assert.deepEqual(entry.envHoldingValue, [], `${which}: a variable of its environment holds a value`);
    assert.equal(entry.argsHoldingValue, 0, `${which}: an argument holds a value`);
    assert.deepEqual(
      [...NAMES, ...names].filter((name) => entry.envNames.includes(name)),
      [],
      `${which}: its environment has a variable of a secret's name or of the script's own`,
    );
  }
}

/** The files under dir, other than `except`, that hold any of the values. */
function filesHolding(dir, values, except) {
  const held = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) held.push(...filesHolding(file, values, except));
    else if (entry.isFile() && !except.includes(file)) {
      const text = readFileSync(file, "utf8");
      if (values.some((value) => text.includes(value))) held.push(file);
    }
  }
  return held;
}

const made = (names) => names.map((name) => `${name} made and set\n`).join("");
const ALL_MADE = made(NAMES);
const ALREADY = (name) => `${name} already set\n`;
const LEFT = (name) => `${name} has a value in .dev.vars: use secrets:staging\n`;
const leftNote = (left, of) =>
  `make-staging-secrets.sh: a value in .dev.vars for ${String(left)} of the ${String(of)} names, each printed with use secrets:staging: nothing was made for such a name, and staging does not hold it yet. npm run secrets:staging puts the value .dev.vars has.\n`;

/** Fails unless a run made and put every name, each in its form, on standard input alone. Returns the values. */
function assertAllMade(rig, result, what) {
  assert.equal(result.status, 0, `${what}: ${result.output}`);
  assert.equal(result.stdout, ALL_MADE, what);
  const calls = rig.calls();
  assert.deepEqual(
    calls.map((call) => call.args),
    [listArgs(rig), ...NAMES.map((name) => putArgs(rig, name))],
    what,
  );
  const values = rig.puts().map((call) => call.stdin);
  for (const [index, name] of NAMES.entries()) assertForm(name, values[index]);
  assertNoValueShown(result, values, what);
  return values;
}

describe("make-staging-secrets.sh (npm run secrets:staging:make) makes a missing name's value and puts it through cf.sh", () => {
  it("a name staging does not hold gets a value of its form on standard input only, and the output is only the names with made and set", (t) => {
    // As the lead's live run found staging (T-568): the model key is set, the names of its own are not.
    const rig = checkout(t, { devVars: devVars() });
    const result = rig.run();
    const values = assertAllMade(rig, result, "a first run");
    assert.equal(result.stderr, "");
    const calls = rig.calls();
    assert.equal(calls[0].stdin, "", "the list is given nothing on standard input");
    for (const call of calls) {
      assert.equal(call.cwd, rig.root);
      // cf.sh ran: the Rosfield sign-in and account. The script's own setting keeps request bodies out of wrangler's log.
      assert.deepEqual(call.env, {
        XDG_CONFIG_HOME: path.join(rig.home, ".config", "rosfield"),
        CLOUDFLARE_ACCOUNT_ID: ROSFIELD_ACCOUNT_ID,
        WRANGLER_LOG_SANITIZE: "true",
      });
    }
    assert.equal(new Set(values.map(bare)).size, NAMES.length, "two names share their bytes");
    // One value was made per name, and nothing but a put's standard input ever held one.
    assert.equal(rig.generated(), NAMES.length);
    assertNothingHandedOn(rig, "a first run");
    // No file holds a value but the stand-in's own record of its standard input.
    assert.deepEqual(filesHolding(rig.dir, values.map(bare), [rig.log]), []);
    assert.deepEqual(rig.held(), [MODEL_KEY, ...NAMES]);
  });

  it("each run makes values of its own: two runs on two checkouts share none", (t) => {
    const seen = [];
    for (let run = 1; run <= 2; run += 1) {
      const rig = checkout(t);
      const values = assertAllMade(rig, rig.run(), `run ${String(run)}`);
      seen.push(...values.map(bare));
    }
    assert.equal(seen.length, 2 * NAMES.length);
    assert.equal(new Set(seen).size, 2 * NAMES.length, "a value was made twice");
  });

  it("--env staging, in either spelling, is the default; a checkout with no .dev.vars and a staging with no secret at all work the same", (t) => {
    for (const args of [["--env", "staging"], ["--env=staging"]]) {
      const rig = checkout(t, { staging: [] });
      const result = rig.run(args);
      assertAllMade(rig, result, JSON.stringify(args));
      assert.equal(result.stderr, "");
      // The model key is missing on this staging too, and is still never made: it is a vendor's.
      assert.deepEqual(rig.held(), NAMES);
      assert.equal(rig.generated(), NAMES.length);
    }
  });

  it("a name given as an argument is the only one made; given twice or out of order, each is made once, in the list's order", (t) => {
    for (const name of NAMES) {
      const rig = checkout(t, { devVars: devVars() });
      const result = rig.run([name]);
      assert.equal(result.status, 0, `${name}: ${result.output}`);
      assert.equal(result.stdout, made([name]), name);
      assert.equal(result.stderr, "", name);
      assert.deepEqual(
        rig.calls().map((call) => call.args),
        [listArgs(rig), putArgs(rig, name)],
        name,
      );
      assertForm(name, rig.puts()[0].stdin);
      assert.equal(rig.generated(), 1, name);
      assertNothingHandedOn(rig, name);
    }
    // Two of the names, the later one first: made in the list's order.
    const two = checkout(t, { devVars: devVars() });
    const some = two.run(["PROOF_CODE_HASH_KEY", "SEALING_WRAP_KEY"]);
    assert.equal(some.status, 0, some.output);
    assert.equal(some.stdout, made(["SEALING_WRAP_KEY", "PROOF_CODE_HASH_KEY"]));
    assert.equal(some.stderr, "");
    assert.deepEqual(
      two.calls().map((call) => call.args),
      [listArgs(two), putArgs(two, "SEALING_WRAP_KEY"), putArgs(two, "PROOF_CODE_HASH_KEY")],
    );
    assert.equal(two.generated(), 2);
    assertNothingHandedOn(two, "two of the names");
    const rig = checkout(t, { devVars: devVars() });
    const result = rig.run([
      "LINQ_WEBHOOK_SECRET",
      "PROOF_CODE_HASH_KEY",
      "--env",
      "staging",
      "SEALING_WRAP_KEY",
      "LINQ_WEBHOOK_SECRET",
    ]);
    assertAllMade(rig, result, "every name, one of them twice");
    assert.equal(rig.generated(), NAMES.length);
  });

  it("a variable of a name in the caller's shell is not a value: the name is made, and that text goes nowhere", (t) => {
    const rig = checkout(t, { devVars: devVars() });
    const result = rig.run([], { ...SHELL_VALUES, WRANGLER_LOG_SANITIZE: "false" });
    const values = assertAllMade(rig, result, "the caller's variables");
    assert.equal(result.stderr, "");
    for (const [index, name] of NAMES.entries()) {
      assert.notEqual(values[index], SHELL_VALUES[name], `${name}: the caller's text was put`);
    }
    for (const call of rig.calls()) assert.equal(call.env.WRANGLER_LOG_SANITIZE, "true");
    assertNothingHandedOn(rig, "the caller's variables");
  });

  it("a line of .dev.vars with no value is no value: the name is made", (t) => {
    const value = DEV_VALUES.SEALING_WRAP_KEY;
    for (const line of [
      "SEALING_WRAP_KEY=",
      'SEALING_WRAP_KEY=""',
      "SEALING_WRAP_KEY=''",
      "SEALING_WRAP_KEY=   ",
      `# SEALING_WRAP_KEY=${value}`,
      `SEALING_WRAP_KEY_OLD=${value}`,
    ]) {
      const what = line.replace(value, "<value>");
      const rig = checkout(t, { devVars: `${devVars()}${line}\n` });
      const result = rig.run(["SEALING_WRAP_KEY"]);
      assert.equal(result.status, 0, `${what}: ${result.output}`);
      assert.equal(result.stdout, made(["SEALING_WRAP_KEY"]), what);
      assert.equal(result.stderr, "", what);
      const puts = rig.puts();
      assert.deepEqual(
        puts.map((call) => call.args),
        [putArgs(rig, "SEALING_WRAP_KEY")],
        what,
      );
      assertForm("SEALING_WRAP_KEY", puts[0].stdin);
      assert.notEqual(puts[0].stdin, value, `${what}: the commented-out text was put`);
    }
  });
});

describe("make-staging-secrets.sh leaves a name alone", () => {
  it("a name secret list already shows is left as it is: nothing is made or put for it", (t) => {
    for (const set of [
      ["SEALING_WRAP_KEY"],
      ["LINQ_WEBHOOK_SECRET"],
      ["PROOF_CODE_HASH_KEY"],
      ["SEALING_WRAP_KEY", "LINQ_WEBHOOK_SECRET"],
      NAMES,
    ]) {
      const what = `staging holds ${set.join(" and ")}`;
      const missing = NAMES.filter((name) => !set.includes(name));
      const rig = checkout(t, { devVars: devVars(), staging: [MODEL_KEY, ...set] });
      const result = rig.run();
      assert.equal(result.status, 0, `${what}: ${result.output}`);
      assert.equal(
        result.stdout,
        NAMES.map((name) => (set.includes(name) ? ALREADY(name) : made([name]))).join(""),
        what,
      );
      assert.equal(result.stderr, "", what);
      assert.deepEqual(
        rig.calls().map((call) => call.args),
        [listArgs(rig), ...missing.map((name) => putArgs(rig, name))],
        what,
      );
      assert.equal(rig.generated(), missing.length, `${what}: values made`);
      assertNothingHandedOn(rig, what);
    }
  });

  it("staging as T-1236's live run left it (DL-518): SEALING_WRAP_KEY and LINQ_WEBHOOK_SECRET are left as they are, and PROOF_CODE_HASH_KEY alone is made and put", (t) => {
    const newOneMade = made(["PROOF_CODE_HASH_KEY"]);
    const heldTwo = `${ALREADY("SEALING_WRAP_KEY")}${ALREADY("LINQ_WEBHOOK_SECRET")}`;
    // [title, the values .dev.vars has, the caller's own variables]
    for (const [what, values, caller] of [
      // The build Mac's .dev.vars as ADR-016's live run finds it: the vendors' keys and the inbox list, and no line for
      // a name made here.
      ["the build Mac's .dev.vars", {}, {}],
      // An old local copy of the two held names in .dev.vars, and another tool's values of every name in the caller's
      // shell: neither ever replaces what staging holds, and neither is put.
      [
        "values of the held names in .dev.vars and of every name in the caller's shell",
        {
          SEALING_WRAP_KEY: DEV_VALUES.SEALING_WRAP_KEY,
          LINQ_WEBHOOK_SECRET: DEV_VALUES.LINQ_WEBHOOK_SECRET,
        },
        SHELL_VALUES,
      ],
    ]) {
      const rig = checkout(t, { devVars: devVars(values), staging: HELD_NOW });
      const result = rig.run([], caller);
      assert.equal(result.status, 0, `${what}: ${result.output}`);
      assert.equal(result.stdout, `${heldTwo}${newOneMade}`, what);
      assert.equal(result.stderr, "", what);
      // One list and one put, of the new name alone: no put of a held name, so neither is replaced.
      assert.deepEqual(
        rig.calls().map((call) => call.args),
        [listArgs(rig), putArgs(rig, "PROOF_CODE_HASH_KEY")],
        what,
      );
      assert.equal(rig.generated(), 1, `${what}: values made`);
      const [value] = rig.puts().map((call) => call.stdin);
      assertForm("PROOF_CODE_HASH_KEY", value);
      assert.equal(
        GIVEN_VALUES.includes(value),
        false,
        `${what}: a value of .dev.vars or the caller's was put`,
      );
      assertNoValueShown(result, [value], what);
      assertNothingHandedOn(rig, what);
      assert.deepEqual(rig.held(), [...HELD_NOW, "PROOF_CODE_HASH_KEY"], what);
      // A second run, as DL-495's check of secret list before any re-run expects: all three already set, nothing made.
      const again = rig.run([], caller);
      assert.equal(again.status, 0, `${what}, again: ${again.output}`);
      assert.equal(again.stdout, NAMES.map(ALREADY).join(""), `${what}, again`);
      assert.equal(again.stderr, "", `${what}, again`);
      assert.deepEqual(
        rig.calls().map((call) => call.args),
        [listArgs(rig), putArgs(rig, "PROOF_CODE_HASH_KEY"), listArgs(rig)],
        `${what}, again`,
      );
      assert.equal(rig.generated(), 1, `${what}, again: a value was made`);
      assertNoValueShown(again, [value], `${what}, again`);
      assertNothingHandedOn(rig, `${what}, both runs`);
    }
    // A value for the new name in .dev.vars leaves it to secrets:staging; the two held names are still left alone.
    const rig = checkout(t, {
      devVars: devVars({ PROOF_CODE_HASH_KEY: DEV_VALUES.PROOF_CODE_HASH_KEY }),
      staging: HELD_NOW,
    });
    const result = rig.run();
    assert.equal(result.status, 3, result.output);
    assert.equal(result.stdout, `${heldTwo}${LEFT("PROOF_CODE_HASH_KEY")}`);
    assert.equal(result.stderr, leftNote(1, NAMES.length));
    assert.deepEqual(
      rig.calls().map((call) => call.args),
      [listArgs(rig)],
    );
    assert.equal(rig.generated(), 0);
    assertNoValueShown(result, [], "a value of the new name in .dev.vars");
    assertNothingHandedOn(rig, "a value of the new name in .dev.vars");
    assert.deepEqual(rig.held(), HELD_NOW);
  });

  it("a second run finds what the first one set: every name is already set, and no value is made again", (t) => {
    const rig = checkout(t, { devVars: devVars() });
    const values = assertAllMade(rig, rig.run(), "the first run");
    const again = rig.run();
    assert.equal(again.status, 0, again.output);
    assert.equal(again.stdout, NAMES.map(ALREADY).join(""));
    assert.equal(again.stderr, "");
    // The second run listed, and did nothing else: the puts and the values are the first run's.
    assert.deepEqual(
      rig.calls().map((call) => call.args),
      [listArgs(rig), ...NAMES.map((name) => putArgs(rig, name)), listArgs(rig)],
    );
    assert.equal(rig.generated(), NAMES.length);
    assertNoValueShown(again, values, "the second run");
    assertNothingHandedOn(rig, "both runs");
  });

  it("a name with a value in .dev.vars is left to secrets:staging: nothing is made for it, and that value goes nowhere (exit 3)", (t) => {
    // [the names .dev.vars has a value for, the names given as arguments]
    for (const [inFile, args] of [
      [["SEALING_WRAP_KEY"], []],
      [["LINQ_WEBHOOK_SECRET"], []],
      [["PROOF_CODE_HASH_KEY"], []],
      [NAMES, []],
      [NAMES, ["LINQ_WEBHOOK_SECRET"]],
      [
        ["SEALING_WRAP_KEY", "PROOF_CODE_HASH_KEY"],
        ["PROOF_CODE_HASH_KEY", "LINQ_WEBHOOK_SECRET"],
      ],
    ]) {
      const what = `.dev.vars has ${inFile.join(" and ")}; arguments ${JSON.stringify(args)}`;
      // The names of the run, in the list's order whatever the arguments' order.
      const wanted = args.length === 0 ? NAMES : NAMES.filter((name) => args.includes(name));
      const toMake = wanted.filter((name) => !inFile.includes(name));
      const values = Object.fromEntries(inFile.map((name) => [name, DEV_VALUES[name]]));
      const rig = checkout(t, { devVars: devVars(values) });
      // A variable of the name in the caller's shell changes nothing: only the file counts.
      const result = rig.run(args, SHELL_VALUES);
      assert.equal(result.status, 3, `${what}: ${result.output}`);
      assert.equal(
        result.stdout,
        wanted.map((name) => (inFile.includes(name) ? LEFT(name) : made([name]))).join(""),
        what,
      );
      assert.equal(result.stderr, leftNote(wanted.length - toMake.length, wanted.length), what);
      assert.deepEqual(
        rig.calls().map((call) => call.args),
        [listArgs(rig), ...toMake.map((name) => putArgs(rig, name))],
        what,
      );
      assert.equal(rig.generated(), toMake.length, `${what}: values made`);
      const puts = rig.puts().map((call) => call.stdin);
      for (const [index, name] of toMake.entries()) assertForm(name, puts[index]);
      assert.deepEqual(
        puts.filter((value) => GIVEN_VALUES.includes(value)),
        [],
        `${what}: a value of .dev.vars or of the caller's shell was put`,
      );
      assertNoValueShown(result, puts, what);
      assertNothingHandedOn(rig, what);
      assert.deepEqual(rig.held(), [MODEL_KEY, ...toMake], `${what}: staging holds only what was made`);
    }
  });

  it("a name staging holds is already set, whatever .dev.vars has for it", (t) => {
    const rig = checkout(t, { devVars: devVars(DEV_VALUES), staging: [MODEL_KEY, "SEALING_WRAP_KEY"] });
    const result = rig.run();
    assert.equal(result.status, 3, result.output);
    assert.equal(
      result.stdout,
      `${ALREADY("SEALING_WRAP_KEY")}${LEFT("LINQ_WEBHOOK_SECRET")}${LEFT("PROOF_CODE_HASH_KEY")}`,
    );
    assert.equal(result.stderr, leftNote(2, NAMES.length));
    assert.deepEqual(
      rig.calls().map((call) => call.args),
      [listArgs(rig)],
    );
    assert.equal(rig.generated(), 0);
    assertNoValueShown(result, [], "held and in .dev.vars");
    assertNothingHandedOn(rig, "held and in .dev.vars");
  });
});

describe("make-staging-secrets.sh refuses", () => {
  /** Fails unless a refused run started nothing at all: no wrangler (no list, no put) and no node (no value made). */
  function assertNothingStarted(rig, what) {
    assert.deepEqual(rig.started(), [], `${what}: wrangler or node was started`);
    assert.deepEqual(rig.held(), [MODEL_KEY], `${what}: staging changed`);
  }

  // [title, arguments, extra environment, the reason]
  const NOT_STAGING = [
    ["--env production", ["--env", "production"], {}, /--env production is never run from here/],
    ["--env=production", ["--env=production"], {}, /--env production is never run from here/],
    ["--env preview", ["--env", "preview"], {}, /--env names an environment other than staging/],
    ["--env=preview", ["--env=preview"], {}, /--env names an environment other than staging/],
    ["--env local", ["--env", "local"], {}, /--env names an environment other than staging/],
    [
      '--env "" (the top level, production)',
      ["--env", ""],
      {},
      /--env names an environment other than staging/,
    ],
    ["--env= (the top level, production)", ["--env="], {}, /--env names an environment other than staging/],
    ["--env without a value", ["--env"], {}, /--env names an environment other than staging/],
    [
      "--env with a name where its value goes",
      ["--env", "SEALING_WRAP_KEY"],
      {},
      /--env names an environment other than staging/,
    ],
    ["--env staging twice", ["--env", "staging", "--env", "staging"], {}, /--env is given more than once/],
    [
      "a second --env, production",
      ["--env", "staging", "--env", "production"],
      {},
      /--env production is never/,
    ],
    ["a second --env, staging", ["--env=preview", "--env=staging"], {}, /--env is given more than once/],
    [
      "--env production after a name",
      ["SEALING_WRAP_KEY", "--env", "production"],
      {},
      /--env production is never/,
    ],
    [
      "CLOUDFLARE_ENV=production",
      [],
      { CLOUDFLARE_ENV: "production" },
      /CLOUDFLARE_ENV names an environment/,
    ],
    [
      "CLOUDFLARE_ENV=production with --env staging",
      ["--env", "staging"],
      { CLOUDFLARE_ENV: "production" },
      /CLOUDFLARE_ENV names an environment/,
    ],
  ];

  it("any environment but staging, and a second --env, before anything is read, listed or made", (t) => {
    // The same refusal on a .dev.vars that can be read and on one that cannot be read at all: a script that read it
    // first would stop on the second with another message (a test below shows that it does, once it reads).
    const readable = checkout(t, { devVars: devVars() });
    const unreadable = checkout(t, { devVars: devVars(), mode: 0o000 });
    for (const [title, args, extra, reason] of NOT_STAGING) {
      for (const [kind, rig] of [
        ["a .dev.vars that can be read", readable],
        ["a .dev.vars that cannot be read", unreadable],
      ]) {
        const what = `${title}, ${kind}`;
        const result = rig.run(args, extra);
        assert.equal(result.status, 1, `${what}: ${result.output}`);
        assert.match(
          result.stderr,
          /^make-staging-secrets\.sh: refused: [^\n]*; nothing was read, listed or made\n$/,
          what,
        );
        assert.match(result.stderr, reason, what);
        assert.equal(result.stdout, "", what);
        assertNothingStarted(rig, what);
      }
    }
  });

  it("a name that is not on its list, before anything is read, listed or made: a vendor's key is never made", (t) => {
    const readable = checkout(t, { devVars: devVars() });
    const unreadable = checkout(t, { devVars: devVars(), mode: 0o000 });
    const modelKey = /^export const KEY_VARIABLE = "([A-Z][A-Z0-9_]*)";$/m.exec(
      source("ai/src/gateway/gateway.ts"),
    );
    assert.ok(modelKey, 'ai/src/gateway/gateway.ts no longer holds: export const KEY_VARIABLE = "<NAME>";');
    assert.equal(modelKey[1], MODEL_KEY);
    const pasted = SHELL_VALUES.LINQ_WEBHOOK_SECRET;
    // [arguments, the argument that is off the list]
    const cases = [
      [[MODEL_KEY], MODEL_KEY],
      [["RESEND_API_KEY"], "RESEND_API_KEY"],
      [["STAGING_TEST_INBOXES"], "STAGING_TEST_INBOXES"],
      [["PROOF_CODE_HASH_KEY", "RESEND_API_KEY"], "RESEND_API_KEY"],
      [["STRIPE_WEBHOOK_SECRET"], "STRIPE_WEBHOOK_SECRET"],
      [["SEALING_WRAP_KEY", MODEL_KEY], MODEL_KEY],
      [[MODEL_KEY, "LINQ_WEBHOOK_SECRET"], MODEL_KEY],
      [["--env", "staging", "SEALING_WRAP_KEY", "OTHER_NAME"], "OTHER_NAME"],
      [["sealing_wrap_key"], "sealing_wrap_key"],
      [["proof_code_hash_key"], "proof_code_hash_key"],
      [["SEALING_WRAP_KEY_OLD"], "SEALING_WRAP_KEY_OLD"],
      [["SEALING_WRAP_KEY LINQ_WEBHOOK_SECRET"], null],
      [["SEALING_WRAP_KEY=on"], "KEY=on"],
      [["*"], null],
      [[""], null],
      [["staging"], null],
      [["production"], "production"],
      [[pasted], pasted],
      [[INBOX_VALUE], INBOX_VALUE],
    ];
    for (const [args, offList] of cases) {
      for (const [kind, rig] of [
        ["a .dev.vars that can be read", readable],
        ["a .dev.vars that cannot be read", unreadable],
      ]) {
        const shown = JSON.stringify(args)
          .replace(pasted, "<a pasted value>")
          .replace(INBOX_VALUE, "<a list>");
        const what = `${shown}, ${kind}`;
        const result = rig.run(args);
        assert.equal(result.status, 1, `${what}: ${result.output}`);
        assert.equal(
          result.stderr,
          "make-staging-secrets.sh: refused: an argument is not a name this script makes (it makes SEALING_WRAP_KEY LINQ_WEBHOOK_SECRET PROOF_CODE_HASH_KEY; arguments are never echoed): a vendor's key, or any other name, is never made here; nothing was read, listed or made\n",
          what,
        );
        assert.equal(result.stdout, "", what);
        if (offList !== null) assert.equal(result.output.includes(offList), false, `${what}: echoed`);
        assertNothingStarted(rig, what);
      }
    }
  });

  it("an option it does not take (exit 2), never echoed, before anything is read", (t) => {
    const rig = checkout(t, { devVars: devVars(), mode: 0o000 });
    const pasted = SHELL_VALUES.LINQ_WEBHOOK_SECRET;
    for (const args of [
      ["--bogus"],
      ["-e", "production"],
      ["--force"],
      ["--rotate", "SEALING_WRAP_KEY"],
      ["SEALING_WRAP_KEY", "--overwrite"],
      ["--name", "rosie"],
      ["--"],
      ["-"],
      [`--key=${pasted}`],
    ]) {
      const what = JSON.stringify(args).replace(pasted, "<a pasted value>");
      const result = rig.run(args);
      assert.equal(result.status, 2, `${what}: ${result.output}`);
      assert.equal(
        result.stderr,
        "make-staging-secrets.sh: an option it does not take (arguments are never echoed)\n" +
          "usage: make-staging-secrets.sh [--env staging] [NAME ...]   (names: SEALING_WRAP_KEY LINQ_WEBHOOK_SECRET PROOF_CODE_HASH_KEY)\n",
        what,
      );
      assert.equal(result.stdout, "", what);
      assertNothingStarted(rig, what);
    }
  });

  it("a .dev.vars that cannot be read, once it comes to reading it: nothing is listed or made", (t) => {
    const rig = checkout(t, { devVars: devVars(), mode: 0o000 });
    for (const args of [[], ["--env", "staging"], ["SEALING_WRAP_KEY"]]) {
      const result = rig.run(args);
      assert.equal(result.status, 1, result.output);
      assert.equal(
        result.stderr,
        "make-staging-secrets.sh: refused: this checkout's .dev.vars cannot be read, so whether it has a value for a name is not known; nothing was listed or made\n",
      );
      assert.equal(result.stdout, "");
      assertNothingStarted(rig, JSON.stringify(args));
    }
  });

  it("a secret list that fails, or prints anything but its list of names: nothing is made or put, never on a guess that a name is missing", (t) => {
    const FAILED =
      /^make-staging-secrets\.sh: wrangler secret list --env staging failed \(exit 1, for the reason above\): which names staging holds is not known, so nothing was made or put\. Once the cause is fixed, run it again\.$/m;
    const NOT_A_LIST =
      /^make-staging-secrets\.sh: refused: what wrangler secret list --env staging printed is not its JSON list of names: which names staging holds is not known, so nothing was made or put\n$/;
    // [title, the stand-in's settings, the reason]
    const cases = [
      [
        "wrangler fails",
        { FAKE_LIST_EXIT: "1", FAKE_LIST_STDOUT: "", FAKE_LIST_STDERR: "fake wrangler: not signed in\n" },
        FAILED,
      ],
      ["wrangler fails after printing a list", { FAKE_LIST_EXIT: "1" }, FAILED],
      [
        "wrangler fails after printing an empty list",
        { FAKE_LIST_EXIT: "1", FAKE_LIST_STDOUT: "[]\n" },
        FAILED,
      ],
      ["nothing printed", { FAKE_LIST_STDOUT: "" }, NOT_A_LIST],
      ["a line end alone", { FAKE_LIST_STDOUT: "\n" }, NOT_A_LIST],
      ["words, not JSON", { FAKE_LIST_STDOUT: "no secrets found\n" }, NOT_A_LIST],
      ["the pretty format", { FAKE_LIST_STDOUT: `Secret Name: ${MODEL_KEY}\n\n` }, NOT_A_LIST],
      ["an object", { FAKE_LIST_STDOUT: `{"name":"${MODEL_KEY}","type":"secret_text"}\n` }, NOT_A_LIST],
      ["an empty object", { FAKE_LIST_STDOUT: "{}\n" }, NOT_A_LIST],
      ["null", { FAKE_LIST_STDOUT: "null\n" }, NOT_A_LIST],
      ["a number", { FAKE_LIST_STDOUT: "0\n" }, NOT_A_LIST],
      ["names without objects", { FAKE_LIST_STDOUT: `["${MODEL_KEY}"]\n` }, NOT_A_LIST],
      ["an item without a name", { FAKE_LIST_STDOUT: '[{"type":"secret_text"}]\n' }, NOT_A_LIST],
      ["a name that is not text", { FAKE_LIST_STDOUT: '[{"name":7}]\n' }, NOT_A_LIST],
      ["an empty name", { FAKE_LIST_STDOUT: '[{"name":""}]\n' }, NOT_A_LIST],
      ["a name with a line end", { FAKE_LIST_STDOUT: '[{"name":"A\\nB"}]\n' }, NOT_A_LIST],
      ["a null item", { FAKE_LIST_STDOUT: "[null]\n" }, NOT_A_LIST],
      ["a list in a list", { FAKE_LIST_STDOUT: `[[{"name":"${MODEL_KEY}"}]]\n` }, NOT_A_LIST],
      ["a list cut short", { FAKE_LIST_STDOUT: `[\n  {\n    "name": "${MODEL_KEY}",\n` }, NOT_A_LIST],
      ["words before the list", { FAKE_LIST_STDOUT: "a warning\n[]\n" }, NOT_A_LIST],
      ["words after the list", { FAKE_LIST_STDOUT: "[]\ndone\n" }, NOT_A_LIST],
      ["two lists", { FAKE_LIST_STDOUT: "[]\n[]\n" }, NOT_A_LIST],
    ];
    for (const [title, settings, reason] of cases) {
      const rig = checkout(t, { devVars: devVars() });
      const result = rig.run([], settings);
      assert.equal(result.status, 1, `${title}: ${result.output}`);
      assert.match(result.stderr, reason, title);
      if ("FAKE_LIST_STDERR" in settings) {
        assert.ok(
          result.stderr.startsWith(settings.FAKE_LIST_STDERR),
          `${title}: wrangler's reason is shown`,
        );
      }
      assert.equal(result.stdout, "", title);
      assert.deepEqual(
        rig.calls().map((call) => call.args),
        [listArgs(rig)],
        `${title}: wrangler must not be given a put`,
      );
      assert.equal(rig.generated(), 0, `${title}: a value was made`);
      assert.deepEqual(rig.held(), [MODEL_KEY], title);
    }
  });

  it("a list that names a secret twice, or has other fields and other names, is still its list: a held name is left alone", (t) => {
    const list = [
      { name: "SEALING_WRAP_KEY", type: "secret_text", extra: { nested: [1, 2] } },
      { name: MODEL_KEY, type: "secret_text" },
      { name: "SEALING_WRAP_KEY", type: "secret_text" },
      { name: "sealing_wrap_key" },
      { name: "LINQ_WEBHOOK_SECRET_OLD" },
      { name: " LINQ_WEBHOOK_SECRET" },
      { name: "a name with spaces" },
      { name: "PROOF_CODE_HASH_KEY_2" },
      { name: "proof_code_hash_key" },
    ];
    // One line, as a wrangler that did not indent would print it, with what wrangler says beside it on standard error.
    const settings = {
      FAKE_LIST_STDOUT: JSON.stringify(list),
      FAKE_LIST_STDERR: "fake wrangler: a warning\n",
    };
    const rig = checkout(t, { devVars: devVars() });
    const result = rig.run([], settings);
    assert.equal(result.status, 0, result.output);
    assert.equal(
      result.stdout,
      `${ALREADY("SEALING_WRAP_KEY")}${made(["LINQ_WEBHOOK_SECRET", "PROOF_CODE_HASH_KEY"])}`,
    );
    // The list's own words on standard error reach the terminal as they are: a list holds no value.
    assert.equal(result.stderr, "fake wrangler: a warning\n");
    assert.deepEqual(
      rig.calls().map((call) => call.args),
      [listArgs(rig), putArgs(rig, "LINQ_WEBHOOK_SECRET"), putArgs(rig, "PROOF_CODE_HASH_KEY")],
    );
    assert.equal(rig.generated(), 2);
  });

  it("a refusal of cf.sh itself arrives at the list, and neither wrangler nor the generator starts", (t) => {
    // cf.sh refuses a checkout with a .env file (wrangler would load it past cf.sh's checks).
    const rig = checkout(t, { devVars: devVars(), files: { ".env": "# names only\n" } });
    const result = rig.run();
    assert.equal(result.status, 1, result.output);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^cf\.sh: refused: \S+\/\.env exists: /m);
    assert.match(
      result.stderr,
      /^make-staging-secrets\.sh: wrangler secret list --env staging failed \(exit 1, /m,
    );
    assert.deepEqual(rig.calls(), []);
    assert.equal(rig.generated(), 0);
  });

  it("a generator that gives anything but 32 bytes as base64: nothing is put, and what it gave is not shown", (t) => {
    const swap = (text, at, sign) => `${text.slice(0, at)}${sign}${text.slice(at + 1)}`;
    // [title, what the generator prints, its exit code]
    const cases = [
      ["nothing", "", 0],
      ["nothing, and it fails", "", 1],
      ["16 bytes", Buffer.alloc(16, 0x5a).toString("base64"), 0],
      ["31 bytes (44 signs, two =)", Buffer.alloc(31, 0x5a).toString("base64"), 0],
      ["33 bytes (44 signs, no =)", Buffer.alloc(33, 0x5a).toString("base64"), 0],
      ["64 bytes", Buffer.alloc(64, 0x5a).toString("base64"), 0],
      ["32 bytes twice", `${KNOWN_BYTES}${KNOWN_BYTES}`, 0],
      ["32 bytes in the URL-safe alphabet", KNOWN_BYTES.replaceAll("+", "-").replaceAll("/", "_"), 0],
      ["32 bytes as hex", "5a".repeat(32), 0],
      ["44 signs of hex", "5a".repeat(22), 0],
      ["a space inside", swap(KNOWN_BYTES, 10, " "), 0],
      ["a line end inside", swap(KNOWN_BYTES, 22, "\n"), 0],
      ["a quote inside", swap(KNOWN_BYTES, 5, '"'), 0],
      ["a star inside", swap(KNOWN_BYTES, 5, "*"), 0],
      ["a letter that is not a base64 sign", swap(KNOWN_BYTES, 5, "é"), 0],
      ["= in the middle", swap(KNOWN_BYTES, 20, "="), 0],
      ["the prefix already in front", `whsec_${KNOWN_BYTES}`, 0],
      ["32 bytes in the right form from a generator that failed", KNOWN_BYTES, 1],
    ];
    for (const [title, random, exit] of cases) {
      const rig = checkout(t, { devVars: devVars(), random });
      const result = rig.run([], { FAKE_RANDOM_EXIT: String(exit) });
      assert.equal(result.status, 1, `${title}: ${result.output}`);
      assert.equal(result.stdout, "", title);
      assert.equal(
        result.stderr,
        "make-staging-secrets.sh: refused: node did not give 32 random bytes as base64 (what it gave is not shown): SEALING_WRAP_KEY was not made or put, and no name after it was tried; the names printed as made and set stay set\n",
        title,
      );
      assert.deepEqual(
        rig.calls().map((call) => call.args),
        [listArgs(rig)],
        `${title}: wrangler must not be given a put`,
      );
      assert.equal(rig.generated(), 1, `${title}: the generator runs once, for the first name`);
      assert.deepEqual(rig.held(), [MODEL_KEY], title);
      assertNothingHandedOn(rig, title);
    }
  });
});

describe("make-staging-secrets.sh when a put fails", () => {
  it("stops there: the names before it stay set, the ones after it are not tried, and the value is taken out of wrangler's words", (t) => {
    // The value is known here, and holds every sign base64 has (+, / and =), so the test can look for it.
    const rig = checkout(t, { devVars: devVars(), random: KNOWN_BYTES });
    const result = rig.run([], { FAKE_FAIL_AT: "LINQ_WEBHOOK_SECRET" });
    assert.equal(result.status, 1, result.output);
    assert.equal(result.stdout, made(["SEALING_WRAP_KEY"]));
    // Both streams of wrangler, with the value taken out with and without its prefix, then the script's own line.
    assert.match(result.stderr, /^fake wrangler: was given \[value not shown\]$/m);
    assert.match(
      result.stderr,
      /^fake wrangler: was given \[value not shown\], key bytes \[value not shown\]$/m,
    );
    assert.match(result.stderr, /^fake wrangler: secret put LINQ_WEBHOOK_SECRET failed$/m);
    assert.match(
      result.stderr,
      /^make-staging-secrets\.sh: wrangler secret put LINQ_WEBHOOK_SECRET --env staging failed \(exit 1, for the reason above\): LINQ_WEBHOOK_SECRET was not put, and no name after it was tried; the names printed as made and set stay set\. The value made for it is dropped\. Once the cause is fixed, run it again\.$/m,
    );
    assert.deepEqual(
      rig.puts().map((call) => call.stdin),
      [KNOWN_BYTES, `whsec_${KNOWN_BYTES}`],
    );
    assertNoValueShown(result, [KNOWN_BYTES], "a failed put");
    assert.deepEqual(rig.held(), [MODEL_KEY, "SEALING_WRAP_KEY"]);
    assertNothingHandedOn(rig, "a failed put");
  });

  it("a put that fails at the last name, PROOF_CODE_HASH_KEY: the two before it stay set, and its value is taken out of wrangler's words", (t) => {
    const rig = checkout(t, { devVars: devVars(), random: KNOWN_BYTES });
    const result = rig.run([], { FAKE_FAIL_AT: "PROOF_CODE_HASH_KEY" });
    assert.equal(result.status, 1, result.output);
    assert.equal(result.stdout, made(["SEALING_WRAP_KEY", "LINQ_WEBHOOK_SECRET"]));
    assert.match(result.stderr, /^fake wrangler: was given \[value not shown\]$/m);
    assert.match(
      result.stderr,
      /^fake wrangler: was given \[value not shown\], key bytes \[value not shown\]$/m,
    );
    assert.match(result.stderr, /^fake wrangler: secret put PROOF_CODE_HASH_KEY failed$/m);
    assert.match(
      result.stderr,
      /^make-staging-secrets\.sh: wrangler secret put PROOF_CODE_HASH_KEY --env staging failed \(exit 1, for the reason above\): PROOF_CODE_HASH_KEY was not put, and no name after it was tried; the names printed as made and set stay set\. The value made for it is dropped\. Once the cause is fixed, run it again\.$/m,
    );
    assert.deepEqual(
      rig.puts().map((call) => call.stdin),
      [KNOWN_BYTES, `whsec_${KNOWN_BYTES}`, KNOWN_BYTES],
    );
    assertNoValueShown(result, [KNOWN_BYTES], "a failed last put");
    assert.deepEqual(rig.held(), [MODEL_KEY, "SEALING_WRAP_KEY", "LINQ_WEBHOOK_SECRET"]);
    assertNothingHandedOn(rig, "a failed last put");
  });

  it("a first put that fails leaves nothing set; the next run makes that name a value of its own, never the dropped one", (t) => {
    const rig = checkout(t, { devVars: devVars() });
    const failed = rig.run([], { FAKE_FAIL_AT: "SEALING_WRAP_KEY" });
    assert.equal(failed.status, 1, failed.output);
    assert.equal(failed.stdout, "");
    assert.match(
      failed.stderr,
      /^make-staging-secrets\.sh: wrangler secret put SEALING_WRAP_KEY --env staging failed \(exit 1, /m,
    );
    const dropped = rig.puts().map((call) => call.stdin);
    assert.equal(dropped.length, 1, "the name after the failed one was tried");
    assertForm("SEALING_WRAP_KEY", dropped[0]);
    assertNoValueShown(failed, dropped, "the failed run");
    assert.deepEqual(rig.held(), [MODEL_KEY]);

    const again = rig.run();
    assert.equal(again.status, 0, again.output);
    assert.equal(again.stdout, ALL_MADE);
    assert.equal(again.stderr, "");
    const values = rig.puts().map((call) => call.stdin);
    assert.equal(values.length, 1 + NAMES.length);
    for (const [index, name] of NAMES.entries()) assertForm(name, values[1 + index]);
    assert.equal(new Set(values.map(bare)).size, 1 + NAMES.length, "the dropped value was made again");
    assertNoValueShown(again, values, "the next run");
    assertNothingHandedOn(rig, "both runs");
    assert.deepEqual(filesHolding(rig.dir, values.map(bare), [rig.log]), []);
  });
});

describe("make-staging-secrets.sh never traces and writes no file", () => {
  it("under bash -x, and with xtrace handed down in SHELLOPTS, no command after the switch-off is traced", (t) => {
    for (const [what, extra, options] of [
      ["bash -x", {}, { bash: ["-x"] }],
      ["SHELLOPTS=xtrace", { SHELLOPTS: "xtrace" }, {}],
    ]) {
      const rig = checkout(t, { devVars: devVars() });
      const result = rig.run([], extra, options);
      const values = assertAllMade(rig, result, what);
      assert.match(result.stderr, /set \+x/, `${what}: the run was traced until the script switched it off`);
      assert.doesNotMatch(result.stderr, /pipefail|unset|printf|secret|value|node|whsec/, what);
      assertNoValueShown(result, values, what);
      assertNothingHandedOn(rig, what);
    }
  });

  it("the script switches tracing, allexport and keyword off first, and has no here-document, here-string, file redirection or export of a value", () => {
    const lines = readFileSync(path.join(SCRIPTS, SCRIPT), "utf8").split("\n");
    const code = lines.filter((line) => !/^\s*#/.test(line) && line.trim() !== "");
    assert.deepEqual(
      code.slice(0, 4),
      ["set +x", "set +a", "set +k", "set -euo pipefail"],
      "the first commands",
    );
    const text = code.join("\n");
    assert.doesNotMatch(text, /\bset\s+-[A-Za-z]*[xak]|xtrace|allexport|keyword/, "none is ever switched on");
    // bash 3.2 writes a here-document or here-string to a temporary file: no < at all.
    assert.doesNotMatch(text, /</, "no here-document, here-string or input redirection");
    assert.doesNotMatch(text.replaceAll("2>&1", "").replaceAll(">&2", ""), />/, "no redirection into a file");
    assert.doesNotMatch(text, /\b(mktemp|tee|eval)\b/);
    assert.deepEqual(text.match(/^[ \t]*(export|declare -x)\b.*$/gm), ["export WRANGLER_LOG_SANITIZE=true"]);
  });
});

describe("make-staging-secrets.sh hands no variable of its own on to what it starts", () => {
  // The names the script, and lib.sh's load_dev_var that reads .dev.vars for it, keep variables of their own under.
  // value and said hold a value made here and wrangler's words about a put, line a line of .dev.vars; the others hold
  // names, counts, a path, the arguments and the script's fixed texts (the ones in capitals).
  const OWN_NAMES = [
    "BASE64_SIGNS",
    "DEV_VARS",
    "LISTED_NAMES",
    "MADE",
    "NEWLINE",
    "RANDOM_BYTES",
    "USAGE",
    "each",
    "env_count",
    "env_name",
    "file",
    "found",
    "given",
    "held",
    "index",
    "left",
    "line",
    "listed",
    "name",
    "plan",
    "prefix",
    "said",
    "status",
    "value",
    "wanted",
  ];

  const code = (file) =>
    readFileSync(path.join(SCRIPTS, file), "utf8")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line) && line.trim() !== "");

  /**
   * The same names, read from the two files: every name, in small letters or capitals, that the script or
   * load_dev_var assigns, adds to, loops over or declares local.
   */
  function ownNames() {
    const loader = /^load_dev_var\(\) \{\n([\s\S]*?)\n\}$/m.exec(code("lib.sh").join("\n"));
    assert.ok(loader, "lib.sh no longer holds: load_dev_var() { ... }");
    const text = `${code(SCRIPT).join("\n")}\n${loader[1]}`;
    const names = new Set();
    // name=... or name+=..., first on its line or after ;, &&, || or a case pattern's ).
    for (const [, name] of text.matchAll(/(?:^|;|&&|\|\||\))[ \t]*([A-Za-z_][A-Za-z0-9_]*)\+?=/gm)) {
      names.add(name);
    }
    // for name in ...
    for (const [, name] of text.matchAll(/\bfor[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+in\b/g)) names.add(name);
    // local name="..." other: each word of the declaration, up to its =.
    for (const [, words] of text.matchAll(/^[ \t]*local[ \t]+(.+)$/gm)) {
      for (const word of words.split(/[ \t]+/)) names.add(word.replace(/=.*$/, ""));
    }
    return [...names].sort();
  }

  /** Fails unless a run made every name, and no command it started has a value or a variable under `names`. */
  function assertRunHandsNothingOn(rig, result, names, what) {
    assertAllMade(rig, result, what);
    assert.equal(result.stderr, "", what);
    assertNothingHandedOn(rig, what, names);
  }

  it("every variable the script works with is dropped before anything is sourced, read or started", () => {
    assert.deepEqual(
      ownNames(),
      OWN_NAMES,
      "make-staging-secrets.sh or lib.sh's load_dev_var works with another variable: add its name to the script's unset lines and to OWN_NAMES",
    );
    const lines = code(SCRIPT);
    // After the four set lines: the unset lines, then lib.sh. Nothing is assigned, read or started before them.
    const unsets = [];
    let at = 4;
    for (; /^unset -v [A-Za-z_][A-Za-z0-9_ ]*$/.test(lines[at]); at += 1) {
      unsets.push(...lines[at].slice("unset -v ".length).split(" "));
    }
    assert.deepEqual(
      [...unsets].sort(),
      [...OWN_NAMES, "BASH_REMATCH"].sort(),
      "the names on the unset lines",
    );
    assert.equal(new Set(unsets).size, unsets.length, "a name is on the unset lines twice");
    assert.equal(lines[at], 'source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"', "what follows the unset lines");
  });

  it("a caller's environment that already holds value, said, line and every other name the script works with", (t) => {
    // BASH_REMATCH too: bash leaves there what load_dev_var's match took from a line of .dev.vars.
    const names = [...OWN_NAMES, "BASH_REMATCH"];
    // bash marks every variable it inherits for export, so each of these would go on to cf.sh, node and wrangler with
    // whatever the script next kept in it.
    const caller = Object.fromEntries(names.map((name) => [name, `t1236 made-up caller text, ${name}`]));
    // .dev.vars has a value for no name, with lines for each that load_dev_var matches and reads.
    const text = `${devVars()}SEALING_WRAP_KEY=\nLINQ_WEBHOOK_SECRET=''\nPROOF_CODE_HASH_KEY=""\n`;
    const rig = checkout(t, { devVars: text });
    assertRunHandsNothingOn(rig, rig.run([], caller), names, "the caller's variables");
  });

  it("allexport from the caller (bash -a, or handed down in SHELLOPTS), which marks every variable as it is set", (t) => {
    for (const [what, extra, options] of [
      ["bash -a", {}, { bash: ["-a"] }],
      ["SHELLOPTS=allexport", { SHELLOPTS: "allexport" }, {}],
      ["bash --posix -a", {}, { bash: ["--posix", "-a"] }],
    ]) {
      const rig = checkout(t, { devVars: devVars() });
      assertRunHandsNothingOn(rig, rig.run([], extra, options), OWN_NAMES, what);
    }
  });

  it("keyword from the caller (bash -k, or handed down in SHELLOPTS), which puts an assignment anywhere on a command line in that command's environment", (t) => {
    for (const [what, extra, options] of [
      ["bash -k", {}, { bash: ["-k"] }],
      ["SHELLOPTS=keyword", { SHELLOPTS: "keyword" }, {}],
      ["SHELLOPTS=allexport:keyword", { SHELLOPTS: "allexport:keyword" }, {}],
    ]) {
      const rig = checkout(t, { devVars: devVars() });
      const result = rig.run([], extra, options);
      // Under keyword an `export NAME=value` line runs as a bare export, which prints every exported variable of the
      // shell. The script switches keyword off first, so none does; a script that did not would print this run's
      // environment. So these three name the fault and its size, and never repeat the run's output.
      const size = (text) => `${String(text.length)} characters, not repeated here`;
      assert.ok(
        result.status === 0,
        `${what}: exit ${String(result.status)} (the output is not repeated here)`,
      );
      assert.ok(
        result.stdout === ALL_MADE,
        `${what}: standard output is not the made and set lines (${size(result.stdout)})`,
      );
      assert.ok(result.stderr === "", `${what}: standard error is not empty (${size(result.stderr)})`);
      assertRunHandsNothingOn(rig, result, OWN_NAMES, what);
    }
  });

  it("a value known before the run is in no command's environment or arguments, the commands started during its own put included", (t) => {
    // With random values a command can only be asked about the values put before it started. Here the stand-in for
    // node gives a known value, so every command is asked about it: cf.sh's own node, which starts while the put's
    // value is on its way to wrangler, among them.
    for (const [what, extra, options] of [
      ["a plain caller", {}, {}],
      ["bash -a", {}, { bash: ["-a"] }],
      [
        "the caller's value, said and line",
        {
          value: "t1236 made-up caller text",
          said: "t1236 made-up caller text",
          line: "t1236 made-up caller text",
        },
        {},
      ],
    ]) {
      const rig = checkout(t, { devVars: devVars(), random: KNOWN_BYTES });
      const result = rig.run([], extra, options);
      assertRunHandsNothingOn(rig, result, OWN_NAMES, what);
      assert.deepEqual(
        rig.puts().map((call) => call.stdin),
        [KNOWN_BYTES, `whsec_${KNOWN_BYTES}`, KNOWN_BYTES],
        what,
      );
      // The list, and each put with cf.sh's node before it; the generator once per name and the list's reader.
      const started = rig.started().map((entry) => entry.tool);
      const wranglers = 1 + NAMES.length;
      assert.equal(started.filter((tool) => tool === "wrangler").length, wranglers, what);
      assert.ok(
        started.filter((tool) => tool === "node").length >= wranglers + NAMES.length + 1,
        `${what}: node calls recorded`,
      );
      assert.deepEqual(
        filesHolding(rig.dir, [KNOWN_BYTES], [rig.log, rig.watchFile, rig.randomFile]),
        [],
        what,
      );
    }
  });
});

describe("make-staging-secrets.sh's names are staging's own, and the ones the runtime reads", () => {
  /** The value of `export const <constant> = "<NAME>";` in a source file. */
  const nameIn = (file, constant) => {
    const match = new RegExp(`^export const ${constant} = "([A-Z][A-Z0-9_]*)";$`, "m").exec(source(file));
    assert.ok(match, `${file} no longer holds: export const ${constant} = "<NAME>";`);
    return match[1];
  };

  /**
   * The key name K-22's proof-code rows keep in hash_key_name (contracts/db-schema/people-access, frozen): the key
   * ADR-016 section 4 makes a code's and a contact's hash under. The hashing port that reads it is T-1289's.
   */
  const proofCodeHashKeyName = () => {
    const file = "contracts/db-schema/people-access/fixtures/seed-proof-code.json";
    const names = new Set(JSON.parse(source(file)).rows.map((row) => row.values.hash_key_name));
    assert.equal(names.size, 1, `${file} names ${String(names.size)} hash keys, not one`);
    return [...names][0];
  };

  it("the wrapping key the seal call reads, the Linq webhook secret and the proof-code hash key K-22's rows name, each on secrets:staging's list too; the vendors' keys and the inbox list are not made", (t) => {
    // The script's names, from a run on a staging that holds nothing: each is made, in its order.
    const rig = checkout(t, { staging: [] });
    const result = rig.run();
    assert.equal(result.status, 0, result.output);
    const names = Array.from(result.stdout.matchAll(/^(\S+) made and set$/gm), ([, name]) => name);
    assert.deepEqual(names, NAMES);
    assert.deepEqual(
      [...names].sort(),
      [
        ...new Set([
          // T-182 and T-553: the environment key that wraps each person's sealing key.
          nameIn("db/repo/sealing.ts", "DEFAULT_WRAPPING_KEY_NAME"),
          nameIn("runtime/src/wiring/real.ts", "SEALING_WRAP_KEY"),
          // T-552 and T-412: the secret the Linq verify reads, which the test-phone page's Linq double signs with.
          nameIn("runtime/src/wiring/real.ts", "LINQ_WEBHOOK_SECRET"),
          // ADR-016 section 4 (T-1276): the key a sign-in code's and a typed contact's hash are made under.
          proofCodeHashKeyName(),
        ]),
      ].sort(),
    );
    // "use secrets:staging" holds for each: put-staging-secrets.sh puts the name when .dev.vars has a value for it.
    const block = /^SECRETS=\(\n([\s\S]*?)\n\)$/m.exec(
      readFileSync(path.join(SCRIPTS, "put-staging-secrets.sh"), "utf8"),
    );
    assert.ok(block, "put-staging-secrets.sh no longer holds: SECRETS=( ... )");
    const put = block[1]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    assert.deepEqual(
      names.filter((name) => !put.includes(name)),
      [],
      "a name made here that put-staging-secrets.sh does not put",
    );
    // T-361: the AI gateway's key is the vendor's. It is on that list, and never on this one.
    const modelKey = nameIn("ai/src/gateway/gateway.ts", "KEY_VARIABLE");
    assert.ok(put.includes(modelKey), `put-staging-secrets.sh puts ${put.join(", ")}`);
    assert.equal(names.includes(modelKey), false, "the model key is made here");
    // ADR-016 section 5 (T-1276): Resend's send-only key is the vendor's and the inbox list is the testers' own. Each is
    // on that list, and never on this one.
    for (const name of GIVEN_NAMES) {
      assert.ok(put.includes(name), `${name}: put-staging-secrets.sh puts ${put.join(", ")}`);
      assert.equal(names.includes(name), false, `${name} is made here`);
    }
  });

  it("npm run secrets:staging:make runs the script", () => {
    const scripts = JSON.parse(source("package.json")).scripts;
    assert.equal(scripts["secrets:staging:make"], `bash infra/scripts/${SCRIPT}`);
  });
});
