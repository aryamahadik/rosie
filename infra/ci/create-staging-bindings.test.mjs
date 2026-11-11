// Tests for infra/scripts/create-staging-bindings.sh (T-566), run in ci.yml by `node --test "infra/ci/*.test.mjs"`.
// Each case runs a copy of the script, lib.sh and cf.sh in a throwaway checkout whose node_modules/.bin/wrangler is a
// fake Cloudflare account: it keeps its KV namespaces and queues in a state file from one run to the next, answers as
// wrangler 4 prints, and records every call in script-harness.mjs's log format. HOME is a temp folder, so nothing reads
// this Mac's Rosfield sign-in, and no case can reach Cloudflare.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  REPO,
  ROSFIELD_ACCOUNT_ID,
  cleanEnv,
  copyScript,
  readLog,
  tempDir,
  write,
} from "./script-harness.mjs";

const WRANGLER_JSONC = readFileSync(path.join(REPO, "wrangler.jsonc"), "utf8");
const OTHER_ACCOUNT = "0123456789abcdef0123456789abcdef";

// What the script makes; wrangler.jsonc's env.staging binds the same names (the last describe below).
const KV_TITLE = "rosie-staging-bundles";
const RETRY_QUEUE = "rosie-retry";
const DEAD_LETTER_QUEUE = "rosie-retry-dlq";

// The fake account (CommonJS), run as wrangler with cf.sh's arguments (--config <file> first):
//  - $FAKE_STATE holds { kv: [{ id, title }], queues: [{ id, name }] }; each call is appended to $FAKE_LOG.
//  - kv namespace list: the JSON array wrangler prints. kv namespace create <title>: a new 32-hex id, titled
//    $FAKE_KV_TITLE_PREFIX<title>, refused when that title is taken (as Cloudflare refuses it).
//  - queues list: wrangler's banner, then its table (none when there are no queues). queues create <name>: refused
//    when the name is taken.
//  - $FAKE_FAIL=<command words>: a command starting with them fails as an API error does. Any other command fails too.
const FAKE_ACCOUNT = String.raw`"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const args = process.argv.slice(2);
const env = {};
for (const key of ["XDG_CONFIG_HOME", "CLOUDFLARE_ACCOUNT_ID"]) {
  if (key in process.env) env[key] = process.env[key];
}
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: "wrangler", args, cwd: process.cwd(), env }) + "\n");
const file = process.env.FAKE_STATE;
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { kv: [], queues: [] };
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const words = args.filter((arg, i) => !arg.startsWith("-") && args[i - 1] !== "--config");
const said = words.join(" ");
const refuse = (why) => {
  process.stderr.write("✘ [ERROR] A request to the Cloudflare API failed.\n  " + why + "\n");
  process.exit(1);
};
const newId = () => crypto.randomBytes(16).toString("hex");
if (process.env.FAKE_FAIL && said.startsWith(process.env.FAKE_FAIL)) refuse("Internal error [code: 10001]");
if (said === "kv namespace list") {
  const list = state.kv.map(({ id, title }) => ({ id, title, supports_url_encoding: true }));
  process.stdout.write(JSON.stringify(list, null, 2) + "\n");
} else if (words.length === 4 && said.startsWith("kv namespace create ")) {
  const title = (process.env.FAKE_KV_TITLE_PREFIX || "") + words[3];
  if (state.kv.some((namespace) => namespace.title === title)) {
    refuse("a namespace with this account ID and title already exists [code: 10014]");
  }
  const id = newId();
  state.kv.push({ id, title });
  save();
  const snippet = JSON.stringify({ kv_namespaces: [{ binding: "BUNDLES", id }] }, null, 2);
  process.stdout.write('🌀 Creating namespace with title "' + title + '"\n✨ Success!\n' + snippet + "\n");
} else if (said === "queues list") {
  process.stdout.write(" ⛅️ wrangler 4.158.0\n───────────────────\n");
  if (state.queues.length > 0) {
    const head = ["id", "name", "created_on", "modified_on", "producers", "consumers"];
    const at = "2026-11-10T07:00:00.000Z";
    const rows = state.queues.map(({ id, name }) => [id, name, at, at, "0", "0"]);
    const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)) + 2);
    const rule = (l, m, r) => l + widths.map((w) => "─".repeat(w)).join(m) + r + "\n";
    const cells = (row) => "│" + row.map((cell, i) => (" " + cell).padEnd(widths[i])).join("│") + "│\n";
    let table = rule("┌", "┬", "┐") + cells(head);
    for (const row of rows) table += rule("├", "┼", "┤") + cells(row);
    process.stdout.write(table + rule("└", "┴", "┘"));
  }
} else if (words.length === 3 && said.startsWith("queues create ")) {
  const name = words[2];
  if (state.queues.some((queue) => queue.name === name)) refuse("A queue with this name already exists. [code: 11009]");
  state.queues.push({ id: newId(), name });
  save();
  process.stdout.write("🌀 Creating queue '" + name + "'\n✅ Created queue '" + name + "'\n");
} else {
  refuse("the fake account has no answer for: " + said);
}
`;

/** A throwaway checkout: the script, lib.sh, cf.sh, a wrangler.jsonc (the repository's unless given) and the account. */
function checkout(t, { config = WRANGLER_JSONC } = {}) {
  const dir = tempDir(t, "staging-bindings");
  const root = path.join(dir, "rosie");
  const script = copyScript("create-staging-bindings.sh", root);
  copyScript("lib.sh", root);
  copyScript("cf.sh", root);
  write(path.join(root, "wrangler.jsonc"), config);
  const program = path.join(dir, "fake", "account.cjs");
  write(program, FAKE_ACCOUNT);
  write(
    path.join(root, "node_modules", ".bin", "wrangler"),
    `#!/usr/bin/env bash\nexec "${process.execPath}" "${program}" "$@"\n`,
    0o755,
  );
  const home = path.join(dir, "home");
  write(path.join(home, ".keep"), "");
  const stateFile = path.join(dir, "account.json");
  let runs = 0;
  /** Runs the script once; `calls` holds the wrangler calls of this run only. */
  const run = (env = {}) => {
    runs += 1;
    const log = path.join(dir, `calls-${runs}.ndjson`);
    const result = spawnSync("bash", [script], {
      cwd: root,
      encoding: "utf8",
      env: cleanEnv(home, { FAKE_LOG: log, FAKE_STATE: stateFile, ...env }),
    });
    return { ...result, calls: readLog(log) };
  };
  /** The account's resources, after setting them to `value` when one is given. */
  const account = (value) => {
    if (value !== undefined) write(stateFile, JSON.stringify(value));
    return existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { kv: [], queues: [] };
  };
  return { root, home, run, account };
}

/** A call's command words: its arguments without the options and without --config's value. */
const wordsOf = (call) =>
  call.args.filter((arg, i) => !arg.startsWith("-") && call.args[i - 1] !== "--config");

/** The create commands a run made, as their words. */
const createsOf = (result) =>
  result.calls.map((call) => wordsOf(call).join(" ")).filter((said) => said.includes(" create "));

const output = (result) =>
  `status=${String(result.status)}\nstdout=${result.stdout}\nstderr=${result.stderr}`;

describe("create-staging-bindings.sh", () => {
  it("makes the KV namespace and both queues on an empty account, once each, and prints their ids", (t) => {
    const { root, home, run, account } = checkout(t);
    const result = run();
    assert.equal(result.status, 0, output(result));
    assert.deepEqual(createsOf(result), [
      `kv namespace create ${KV_TITLE}`,
      `queues create ${DEAD_LETTER_QUEUE}`,
      `queues create ${RETRY_QUEUE}`,
    ]);
    const { kv, queues } = account();
    assert.deepEqual(
      kv.map((namespace) => namespace.title),
      [KV_TITLE],
    );
    assert.deepEqual(
      queues.map((queue) => queue.name),
      [DEAD_LETTER_QUEUE, RETRY_QUEUE],
    );
    for (const { id } of [...kv, ...queues]) assert.ok(result.stdout.includes(`id ${id}`), output(result));
    assert.match(result.stdout, /staging bindings ready on the Rosfield account/);
    // Every call goes through cf.sh: this checkout's wrangler.jsonc, the Rosfield sign-in and the pinned account.
    for (const call of result.calls) {
      assert.deepEqual(call.args.slice(0, 2), ["--config", path.join(root, "wrangler.jsonc")]);
      assert.equal(call.env.XDG_CONFIG_HOME, path.join(home, ".config", "rosfield"));
      assert.equal(call.env.CLOUDFLARE_ACCOUNT_ID, ROSFIELD_ACCOUNT_ID);
      assert.ok(!call.args.some((arg) => /^(--env|-e)(=|$)/.test(arg)), `no --env: ${call.args.join(" ")}`);
      assert.ok(!wordsOf(call).includes("delete"), `nothing deleted: ${call.args.join(" ")}`);
    }
    // wrangler never writes wrangler.jsonc from here.
    const kvCreate = result.calls.find((call) => wordsOf(call).join(" ").startsWith("kv namespace create"));
    assert.ok(kvCreate?.args.includes("--update-config=false"), output(result));
  });

  it("makes nothing on a second run and prints the existing ids (idempotent)", (t) => {
    const { run, account } = checkout(t);
    const first = run();
    assert.equal(first.status, 0, output(first));
    const made = account();
    const second = run();
    assert.equal(second.status, 0, output(second));
    assert.deepEqual(createsOf(second), []);
    assert.deepEqual(account(), made);
    for (const { id } of [...made.kv, ...made.queues]) {
      assert.ok(second.stdout.includes(`id ${id}`), output(second));
    }
    assert.equal(second.stdout.match(/already exists: not created again/g)?.length, 3, output(second));
    assert.match(second.stdout, /staging bindings ready on the Rosfield account/);
  });

  it("makes only what is missing, matching names exactly, and leaves the account's other resources alone", (t) => {
    const { run, account } = checkout(t);
    const before = {
      kv: [
        { id: "a".repeat(32), title: KV_TITLE },
        { id: "b".repeat(32), title: `${KV_TITLE}-old` },
      ],
      queues: [
        { id: "c".repeat(32), name: DEAD_LETTER_QUEUE },
        { id: "d".repeat(32), name: `${RETRY_QUEUE}-other` },
      ],
    };
    account(before);
    const result = run();
    assert.equal(result.status, 0, output(result));
    assert.deepEqual(createsOf(result), [`queues create ${RETRY_QUEUE}`]);
    const after = account();
    assert.deepEqual(after.kv, before.kv);
    assert.deepEqual(after.queues.slice(0, 2), before.queues);
    assert.ok(
      result.stdout.includes(`BUNDLES: KV namespace ${KV_TITLE}, id ${"a".repeat(32)}`),
      output(result),
    );
    assert.ok(
      result.stdout.includes(`dead-letter queue ${DEAD_LETTER_QUEUE}, id ${"c".repeat(32)}`),
      output(result),
    );
  });

  it("refuses another account id before wrangler starts (cf.sh's guard), so nothing is made", (t) => {
    const { run, account } = checkout(t);
    const result = run({ CLOUDFLARE_ACCOUNT_ID: OTHER_ACCOUNT });
    assert.equal(result.status, 1, output(result));
    assert.match(result.stderr, /refused: CLOUDFLARE_ACCOUNT_ID is not the Rosfield account/);
    assert.match(result.stderr, /could not list the KV namespaces/);
    assert.deepEqual(result.calls, [], "wrangler must not start");
    assert.deepEqual(account(), { kv: [], queues: [] });
    assert.doesNotMatch(result.stdout, /ready/);
  });

  it("refuses a wrangler.jsonc pinned to another account (cf.sh's guard), so nothing is made", (t) => {
    const pinned = `"account_id": "${ROSFIELD_ACCOUNT_ID}"`;
    assert.ok(WRANGLER_JSONC.includes(pinned), "wrangler.jsonc pins the Rosfield account");
    const { run, account } = checkout(t, {
      config: WRANGLER_JSONC.replace(pinned, `"account_id": "${OTHER_ACCOUNT}"`),
    });
    const result = run();
    assert.equal(result.status, 1, output(result));
    assert.match(result.stderr, /account_id must be the Rosfield account/);
    assert.deepEqual(result.calls, [], "wrangler must not start");
    assert.deepEqual(account(), { kv: [], queues: [] });
  });

  it("stops at a list it cannot read, before making anything", (t) => {
    const { run, account } = checkout(t);
    const result = run({ FAKE_FAIL: "kv namespace list" });
    assert.equal(result.status, 1, output(result));
    assert.match(result.stderr, /could not list the KV namespaces/);
    assert.deepEqual(createsOf(result), []);
    assert.deepEqual(account(), { kv: [], queues: [] });
  });

  it("stops at a create Cloudflare refuses, and a later run makes the rest", (t) => {
    const { run, account } = checkout(t);
    const refused = run({ FAKE_FAIL: "queues create" });
    assert.equal(refused.status, 1, output(refused));
    assert.match(refused.stderr, new RegExp(`could not create the queue ${DEAD_LETTER_QUEUE}`));
    assert.doesNotMatch(refused.stdout, /ready/);
    assert.deepEqual(createsOf(refused), [
      `kv namespace create ${KV_TITLE}`,
      `queues create ${DEAD_LETTER_QUEUE}`,
    ]);
    const again = run();
    assert.equal(again.status, 0, output(again));
    assert.deepEqual(createsOf(again), [
      `queues create ${DEAD_LETTER_QUEUE}`,
      `queues create ${RETRY_QUEUE}`,
    ]);
    assert.equal(account().kv.length, 1);
  });

  it("stops when wrangler titles the namespace otherwise, showing what wrangler made", (t) => {
    const { run } = checkout(t);
    const result = run({ FAKE_KV_TITLE_PREFIX: "rosie-" });
    assert.equal(result.status, 1, output(result));
    assert.match(result.stderr, new RegExp(`none is titled ${KV_TITLE}`));
    assert.ok(result.stderr.includes(`Creating namespace with title "rosie-${KV_TITLE}"`), output(result));
    assert.deepEqual(createsOf(result), [`kv namespace create ${KV_TITLE}`], "no queue is made after it");
  });
});

// Strip // and /* */ comments outside strings, then trailing commas, then parse (as wrangler-config.test.mjs does).
function parseJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

describe("wrangler.jsonc's env.staging binds what create-staging-bindings.sh makes (T-566)", () => {
  const config = parseJsonc(WRANGLER_JSONC);
  const staging = config.env.staging;

  it("binds RETRY_QUEUE to the retry queue, with 5 tries and then the dead-letter queue the script makes", () => {
    assert.deepEqual(staging.queues, {
      producers: [{ queue: RETRY_QUEUE, binding: "RETRY_QUEUE" }],
      consumers: [{ queue: RETRY_QUEUE, max_retries: 5, dead_letter_queue: DEAD_LETTER_QUEUE }],
    });
  });

  it("binds BUNDLES to a real namespace id, not a placeholder", () => {
    assert.equal(staging.kv_namespaces.length, 1);
    const [kv] = staging.kv_namespaces;
    assert.deepEqual(Object.keys(kv).sort(), ["binding", "id"]);
    assert.equal(kv.binding, "BUNDLES");
    assert.match(kv.id, /^[0-9a-f]{32}$/);
    assert.doesNotMatch(
      kv.id,
      /^0{31}[0-9a-f]$/,
      "a placeholder id, as the top level's and production's are",
    );
  });

  it("repeats the top level's HandleActor binding, its migration and the one-minute cron, and adds staging's test-phone line with its migration, all of which the deploy makes", () => {
    // Staging alone adds the test-phone page's TestPhoneLine (T-1186, DL-379, DL-388) after HandleActor.
    const line = { name: "TEST_PHONE_LINE", class_name: "TestPhoneLine" };
    const lineMigration = { tag: "v2-test-phone-line", new_sqlite_classes: ["TestPhoneLine"] };
    assert.deepEqual(staging.durable_objects, { bindings: [...config.durable_objects.bindings, line] });
    assert.deepEqual(staging.durable_objects.bindings, [
      { name: "HANDLE_ACTOR", class_name: "HandleActor" },
      line,
    ]);
    assert.deepEqual(staging.migrations, [...config.migrations, lineMigration]);
    assert.deepEqual(staging.migrations, [
      { tag: "v1-handle-actor", new_sqlite_classes: ["HandleActor"] },
      lineMigration,
    ]);
    assert.deepEqual(staging.triggers, { crons: ["* * * * *"] });
  });
});
