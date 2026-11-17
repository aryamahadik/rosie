// Tests for infra/scripts/linq-staging-check.sh, `npm run linq:staging:check` and `npm run linq:staging:create` (T-572;
// D-018; DL-940; K-11 v1 default 1; build prompt rule 7: keys are named, never shown), run by
// `node --test "infra/ci/*.test.mjs"`. Nothing here reaches Linq, Cloudflare or the network, and no real key, number or
// secret is read. The script runs in a throwaway checkout: copies of it, lib.sh and the real cf.sh, this repository's
// wrangler.jsonc, a made-up .dev.vars where a case wants one, and two stand-ins:
//  - node, first on PATH: the real node with a module loaded first (--require). For the script's own program it puts a
//    stand-in for Linq's API in place of fetch, in the same process, so no request leaves it: the subscriptions it
//    holds are a file of the test's (the old demo's and staging's), a POST adds one and answers it with a made-up
//    signing secret, and any other address is refused. It records each request (its address, method, headers but the
//    Authorization header, which it keeps as a digest alone, body and redirect mode), and for every node started (the
//    program and cf.sh's own) the names of its environment's variables that hold a watched text, and how many of its
//    arguments do;
//  - wrangler, at node_modules/.bin/wrangler behind the real cf.sh: `secret list` prints a made-up list, `secret put`
//    records its standard input, both repeat it on both streams as a wrangler that showed a secret would, and either can
//    be made to fail.
// HOME and TMPDIR are folders of the test's own, and no run gets this shell's values of the names (script-harness.mjs).
// Every value is made up and built at run time, so no key-shaped text sits in this file, and every number is a whole
// fiction-range one (555-01xx).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

const SCRIPT = "linq-staging-check.sh";
const BASE = "https://rosfield.com/test";
const ROUTE = `${BASE}/webhooks/linq`;
const OURS = "staging's Linq route";

const source = (file) => readFileSync(path.join(REPO, file), "utf8");

/** Linq's API base as T-414 names it (adapters/src/linq/send/wire.ts). */
function wireBase() {
  const match = /^export const LINQ_API_BASE = "([^"]+)";$/m.exec(source("adapters/src/linq/send/wire.ts"));
  assert.ok(match, 'adapters/src/linq/send/wire.ts no longer holds: export const LINQ_API_BASE = "<url>";');
  return match[1];
}
const API = wireBase();

/** The Linq event types T-413's parser maps (adapters/src/linq/webhook/parse.ts USED_EVENT_TYPES), in its order. */
function parserEvents() {
  const block = /^export const USED_EVENT_TYPES = \[\n([\s\S]*?)\n\] as const;$/m.exec(
    source("adapters/src/linq/webhook/parse.ts"),
  );
  assert.ok(
    block,
    "adapters/src/linq/webhook/parse.ts no longer holds: export const USED_EVENT_TYPES = [ ... ] as const;",
  );
  const events = Array.from(block[1].matchAll(/^\s*"([a-z][a-z0-9_.]*)",?$/gm), ([, event]) => event);
  assert.ok(events.length > 0, "USED_EVENT_TYPES lists no event");
  return events;
}
const EVENTS = parserEvents();

/** The script's own EVENTS list, read from its text. */
function scriptEvents() {
  const block = /^EVENTS=\(\n([\s\S]*?)\n\)$/m.exec(readFileSync(path.join(SCRIPTS, SCRIPT), "utf8"));
  assert.ok(block, `${SCRIPT} no longer holds: EVENTS=( ... )`);
  return block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

// Made-up values: a key for Linq and another one (the caller's shell against .dev.vars), Rosie's line and a roster
// phone (fiction range), the signing secret the stand-in gives (whsec_ and base64, the form adapters/src/shared/hmac.ts
// takes), a secret in another form, and a token in the old demo's address.
const KEY = `t572-made-up-linq-key-${"5c1e9a07".repeat(3)}`;
const OTHER_KEY = `t572-another-made-up-key-${"e2b74d1f".repeat(3)}`;
const NUMBER = "+15555550199";
const ROSTER_NUMBER = "+15555550150";
const SECRET = `whsec_${Buffer.from("t572 made-up Linq signing secret bytes 01").toString("base64")}`;
const ODD_SECRET = `t572-made-up-secret-in-another-form-${"b9d0c2e4".repeat(2)}`;
const DEMO_TOKEN = "t572-made-up-demo-path-token-a7c3";
/** Every text no output, no command's environment or arguments, and no file but the stand-ins' own may hold. */
const WATCHED = [KEY, OTHER_KEY, NUMBER, SECRET, SECRET.slice("whsec_".length), ODD_SECRET];
const VALUES = { LINQ_API_TOKEN: KEY, ROSIE_NUMBER: NUMBER };

/** Staging's subscription, as Linq would list it, with any field changed. */
const ours = (extra = {}) => ({
  id: "sub_t572_ours",
  target_url: ROUTE,
  subscribed_events: [...EVENTS],
  phone_numbers: [NUMBER],
  is_active: true,
  ...extra,
});
/** The old demo's subscription: another host, a token in its path and query, no number filter. */
const demo = (extra = {}) => ({
  id: "sub_t572_demo",
  target_url: `https://demo.example.com/hooks/${DEMO_TOKEN}?k=${DEMO_TOKEN}`,
  subscribed_events: ["message.received", "message.sent"],
  phone_numbers: [],
  is_active: true,
  ...extra,
});

// The stand-in node's module (CommonJS), loaded before the program it was asked to run, in the same process.
const FAKE_NODE = String.raw`"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const log = process.env.FAKE_LOG;
const watched = JSON.parse(fs.readFileSync(process.env.FAKE_WATCH, "utf8"));
const holds = (text) => watched.some((value) => text.includes(value));
const envNames = Object.keys(process.env);
const args = [...process.execArgv, ...process.argv.slice(1)];
const program = process.execArgv.some((arg) => arg.includes("webhook-subscriptions"));
fs.appendFileSync(
  log,
  JSON.stringify({
    tool: "node",
    program,
    envNames,
    envHoldingValue: envNames.filter((name) => holds(process.env[name])),
    argsHoldingValue: args.filter(holds).length,
  }) + "\n",
);
if (program) {
  const answer = (status, body) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = async (url, init = {}) => {
    const headers = {};
    for (const [name, value] of Object.entries(init.headers || {})) headers[name.toLowerCase()] = String(value);
    const auth = headers.authorization === undefined ? null : crypto.createHash("sha256").update(headers.authorization).digest("hex");
    delete headers.authorization;
    const method = init.method || "GET";
    const entry = { tool: "fetch", url: String(url), method, headers, auth, body: init.body === undefined ? null : init.body, redirect: init.redirect || null, timed: init.signal !== undefined };
    fs.appendFileSync(log, JSON.stringify(entry) + "\n");
    const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, "utf8"));
    if (String(url) !== state.api + "/webhook-subscriptions") throw new TypeError("the stand-in for Linq refuses that address");
    if (method === "GET") {
      if (state.list === undefined) return answer(200, { subscriptions: state.subscriptions });
      if (state.list.throws) throw new TypeError("no answer");
      return answer(state.list.status, state.list.body);
    }
    if (method === "POST") {
      if (state.create !== undefined) return answer(state.create.status, state.create.body);
      const asked = JSON.parse(init.body);
      const made = { id: state.newId, target_url: asked.target_url, subscribed_events: asked.subscribed_events, phone_numbers: asked.phone_numbers, is_active: true };
      state.subscriptions.push(made);
      fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(state));
      return answer(201, { ...made, signing_secret: state.secret });
    }
    throw new TypeError("the stand-in for Linq takes no " + method);
  };
}
`;

// The stand-in wrangler (CommonJS). argv: wrangler's arguments, as cf.sh hands them on. It records one JSON line: its
// arguments, its standard input (read for a put alone), the names of its environment's variables, the ones that hold a
// watched text, how many arguments do, and three settings cf.sh and the script make. `secret list` prints a made-up list
// (FAKE_LIST_FAIL: fails); `secret put` repeats its standard input on both streams (FAKE_PUT_FAIL: then fails).
const FAKE_WRANGLER = String.raw`"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
if (args.includes("put")) {
  try {
    stdin = fs.readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
}
const watched = JSON.parse(fs.readFileSync(process.env.FAKE_WATCH, "utf8"));
const holds = (text) => watched.some((value) => text.includes(value));
const envNames = Object.keys(process.env);
const env = {};
for (const key of ["XDG_CONFIG_HOME", "CLOUDFLARE_ACCOUNT_ID", "WRANGLER_LOG_SANITIZE"]) {
  if (key in process.env) env[key] = process.env[key];
}
const entry = {
  tool: "wrangler",
  args,
  stdin,
  envNames,
  envHoldingValue: envNames.filter((name) => holds(process.env[name])),
  argsHoldingValue: args.filter(holds).length,
  env,
};
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\n");
if (args.includes("list")) {
  if (process.env.FAKE_LIST_FAIL) {
    process.stderr.write("fake wrangler: not signed in\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify([{ name: "ANTHROPIC_API_KEY", type: "secret_text" }]) + "\n");
  process.exit(0);
}
process.stdout.write("fake wrangler: was given " + stdin + "\n");
process.stderr.write("fake wrangler: was given " + stdin + ", key bytes " + stdin.replace(/^whsec_/, "") + "\n");
if (process.env.FAKE_PUT_FAIL) {
  process.stderr.write("fake wrangler: secret put failed\n");
  process.exit(1);
}
process.stdout.write("Success! Uploaded secret LINQ_WEBHOOK_SECRET\n");
`;

/**
 * A throwaway checkout (see the top of this file). devVars: the text of its .dev.vars (left out: it has none); mode: that
 * file's mode; files: other files of the checkout; subscriptions: what the stand-in for Linq lists; list and create:
 * {status, body} the stand-in answers instead ({throws: true}: no answer); secret: the signing secret a create gives.
 */
function checkout(t, options = {}) {
  const { devVars: text, mode, files = {}, subscriptions = [], list, create, secret = SECRET } = options;
  const dir = tempDir(t, "linq-check");
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
  const preload = path.join(dir, "fake", "node.cjs");
  write(preload, FAKE_NODE);
  const bin = path.join(dir, "bin");
  stub(path.join(bin, "node"), "--require", preload);
  const home = path.join(dir, "home");
  write(path.join(home, ".keep"), "");
  const tmp = path.join(dir, "tmp");
  mkdirSync(tmp);
  const log = path.join(dir, "calls.ndjson");
  // The stand-in for Linq's state: it holds the signing secret it gives, as Linq does.
  const state = path.join(dir, "linq-state.json");
  write(state, JSON.stringify({ api: API, subscriptions, list, create, secret, newId: "sub_t572_new" }));
  // The watched texts, in a folder of their own.
  const watch = path.join(tempDir(t, "linq-check-watch"), "watched.json");
  write(watch, JSON.stringify(WATCHED));
  /** Runs the script; `bash` holds options for bash itself (-x). This shell's values of the names never reach it. */
  const run = (args = [], extra = {}, { bash = [] } = {}) => {
    const result = spawnSync("bash", [...bash, script, ...args], {
      cwd: root,
      encoding: "utf8",
      env: cleanEnv(home, {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        FAKE_LOG: log,
        FAKE_STATE: state,
        FAKE_WATCH: watch,
        TMPDIR: tmp,
        LINQ_API_TOKEN: undefined,
        ROSIE_NUMBER: undefined,
        LINQ_WEBHOOK_SECRET: undefined,
        ...extra,
      }),
    });
    return { ...result, output: `${result.stdout}${result.stderr}` };
  };
  const calls = () => readLog(log);
  return {
    dir,
    root,
    log,
    state,
    devVarsFile,
    run,
    calls,
    fetches: () => calls().filter((call) => call.tool === "fetch"),
    wranglers: () => calls().filter((call) => call.tool === "wrangler"),
    programs: () => calls().filter((call) => call.tool === "node" && call.program),
    /** The subscriptions the stand-in for Linq holds now. */
    held: () => JSON.parse(readFileSync(state, "utf8")).subscriptions,
  };
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const config = (rig) => ["--config", path.join(rig.root, "wrangler.jsonc")];
const listArgs = (rig) => [...config(rig), "secret", "list", "--env", "staging", "--format", "json"];
const putArgs = (rig) => [...config(rig), "secret", "put", "LINQ_WEBHOOK_SECRET", "--env", "staging"];

/** The line the script gives a subscription. */
function line({ id, target, active = "yes", rosie = "yes", events = EVENTS }) {
  return `  ${id}: ${target}, active ${active}, Rosie's number ${rosie}, events ${events.length > 0 ? events.join(" ") : "none"}\n`;
}
const OURS_LINE = line({ id: "sub_t572_ours", target: OURS });
const DEMO_LINE = line({
  id: "sub_t572_demo",
  target: "another target, host demo.example.com",
  rosie: "yes (no number filter: every number)",
  events: ["message.received", "message.sent"],
});
const HEAD = `${OURS}: ${ROUTE}\n`;
const listed = (count) =>
  `Linq lists ${String(count)} webhook subscription${count === 1 ? "" : "s"}${count === 0 ? "" : ":"}\n`;
const PASS_OURS = `PASS: exactly one active subscription, sub_t572_ours, sends every event on the list (${String(EVENTS.length)}) for Rosie's number to ${OURS}\n`;
const NONE = `FAIL: no active subscription targets ${OURS}: npm run linq:staging:create makes one\n`;

/** Fails when a run's standard output or standard error holds a watched text, or the demo's token. */
function assertNoValueShown(result, what) {
  for (const stream of ["stdout", "stderr"]) {
    const held = [...WATCHED, DEMO_TOKEN].filter((value) => result[stream].includes(value));
    assert.equal(held.length, 0, `${what}: ${stream} holds a value (${String(held.length)})`);
  }
}

/**
 * Fails unless every request went to the subscriptions address with the key in its Authorization header alone, followed
 * no redirect and had a time limit.
 */
function assertKeyInHeaderAlone(rig, what, key = KEY) {
  for (const [index, call] of rig.fetches().entries()) {
    const which = `${what}, request ${String(index + 1)}`;
    assert.equal(call.url, `${API}/webhook-subscriptions`, which);
    assert.equal(call.auth, sha256(`Bearer ${key}`), `${which}: the Authorization header`);
    assert.equal(
      JSON.stringify(call).includes(key),
      false,
      `${which}: the key outside the Authorization header`,
    );
    assert.equal(call.redirect, "error", `${which}: a redirect would be followed`);
    assert.equal(call.timed, true, `${which}: no time limit`);
  }
}

/** Fails when any command the script started holds a watched text in its environment or arguments, or a value's name. */
function assertNothingHandedOn(rig, what) {
  const started = rig.calls().filter((call) => call.tool === "node" || call.tool === "wrangler");
  assert.ok(started.length > 0, `${what}: no command was recorded`);
  for (const [index, call] of started.entries()) {
    const which = `${what}, command ${String(index + 1)} (${call.tool})`;
    assert.deepEqual(call.envHoldingValue, [], `${which}: a variable of its environment holds a value`);
    assert.equal(call.argsHoldingValue, 0, `${which}: an argument holds a value`);
    assert.deepEqual(
      ["LINQ_API_TOKEN", "ROSIE_NUMBER", "LINQ_WEBHOOK_SECRET"].filter((name) =>
        call.envNames.includes(name),
      ),
      [],
      `${which}: its environment has a variable of a value's name`,
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

describe("linq-staging-check.sh (npm run linq:staging:check) lists Linq's webhook subscriptions and changes nothing", () => {
  it("PASS: exactly one active subscription sends every event on the list for Rosie's number to staging's Linq route; another target shows its host alone", (t) => {
    const rig = checkout(t, { subscriptions: [ours(), demo()] });
    const result = rig.run([BASE], VALUES);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.stdout, `${HEAD}${listed(2)}${OURS_LINE}${DEMO_LINE}${PASS_OURS}`);
    assert.equal(result.stderr, "");
    // One GET, with the key in its Authorization header alone; no POST, no wrangler at all.
    assert.deepEqual(
      rig.fetches().map((call) => [call.method, call.body]),
      [["GET", null]],
    );
    assertKeyInHeaderAlone(rig, "the check");
    assert.deepEqual(rig.wranglers(), []);
    assert.equal(rig.programs().length, 1);
    assertNothingHandedOn(rig, "the check");
    assertNoValueShown(result, "the check");
    assert.deepEqual(rig.held(), [ours(), demo()], "the check changed a subscription");
  });

  it("a trailing / on the base is dropped, and the base may be staging's workers.dev address", (t) => {
    for (const [given, route] of [
      [`${BASE}/`, ROUTE],
      [
        "https://rosie-staging.t572-made-up.workers.dev/test",
        "https://rosie-staging.t572-made-up.workers.dev/test/webhooks/linq",
      ],
    ]) {
      const rig = checkout(t, { subscriptions: [ours({ target_url: route })] });
      const result = rig.run([given], VALUES);
      assert.equal(result.status, 0, `${given}: ${result.output}`);
      assert.equal(result.stdout, `${OURS}: ${route}\n${listed(1)}${OURS_LINE}${PASS_OURS}`, given);
    }
  });

  it("PASS with more events than the list, or with no number filter at all (every number)", (t) => {
    for (const [what, sub, rosie, events] of [
      [
        "an extra event",
        ours({ subscribed_events: [...EVENTS, "chat.created"] }),
        "yes",
        [...EVENTS, "chat.created"],
      ],
      ["an empty filter", ours({ phone_numbers: [] }), "yes (no number filter: every number)", EVENTS],
      ["a null filter", ours({ phone_numbers: null }), "yes (no number filter: every number)", EVENTS],
    ]) {
      const rig = checkout(t, { subscriptions: [sub] });
      const result = rig.run([BASE], VALUES);
      assert.equal(result.status, 0, `${what}: ${result.output}`);
      assert.equal(
        result.stdout,
        `${HEAD}${listed(1)}${line({ id: "sub_t572_ours", target: OURS, rosie, events })}${PASS_OURS}`,
        what,
      );
    }
  });

  it("FAIL (exit 1) for each fault, with why, and nothing changed", (t) => {
    const lacking = EVENTS.filter((event) => event !== "message.edited" && event !== "poll.failed");
    // [title, the subscriptions, their lines, the verdict]
    const cases = [
      ["no subscription at all", [], "", NONE],
      ["the old demo's alone", [demo()], DEMO_LINE, NONE],
      [
        "staging's route, not active",
        [ours({ is_active: false }), demo()],
        `${line({ id: "sub_t572_ours", target: OURS, active: "no" })}${DEMO_LINE}`,
        NONE,
      ],
      [
        "staging's route with a / after it",
        [ours({ target_url: `${ROUTE}/` })],
        line({ id: "sub_t572_ours", target: "another target, host rosfield.com" }),
        NONE,
      ],
      [
        "two events missing",
        [ours({ subscribed_events: lacking })],
        line({ id: "sub_t572_ours", target: OURS, events: lacking }),
        `FAIL: sub_t572_ours, the active subscription for ${OURS}: its events lack message.edited, poll.failed\n`,
      ],
      [
        "a filter without Rosie's number",
        [ours({ phone_numbers: [ROSTER_NUMBER] })],
        line({ id: "sub_t572_ours", target: OURS, rosie: "no" }),
        `FAIL: sub_t572_ours, the active subscription for ${OURS}: its number filter leaves out Rosie's number\n`,
      ],
      [
        "both",
        [ours({ subscribed_events: lacking, phone_numbers: [ROSTER_NUMBER] })],
        line({ id: "sub_t572_ours", target: OURS, rosie: "no", events: lacking }),
        `FAIL: sub_t572_ours, the active subscription for ${OURS}: its events lack message.edited, poll.failed; its number filter leaves out Rosie's number\n`,
      ],
      [
        "two active ones",
        [ours(), ours({ id: "sub_t572_twin" })],
        `${OURS_LINE}${line({ id: "sub_t572_twin", target: OURS })}`,
        `FAIL: 2 active subscriptions target ${OURS} (sub_t572_ours, sub_t572_twin): Linq would send staging each event more than once, so one must go\n`,
      ],
    ];
    for (const [what, subscriptions, lines, verdict] of cases) {
      const rig = checkout(t, { subscriptions });
      const result = rig.run([BASE], VALUES);
      assert.equal(result.status, 1, `${what}: ${result.output}`);
      assert.equal(result.stdout, `${HEAD}${listed(subscriptions.length)}${lines}${verdict}`, what);
      assert.equal(result.stderr, "", what);
      assert.deepEqual(
        rig.fetches().map((call) => call.method),
        ["GET"],
        what,
      );
      assert.deepEqual(rig.held(), subscriptions, `${what}: a subscription changed`);
      assertNoValueShown(result, what);
    }
  });

  it("shows only an id, a host or an event name in a plain form", (t) => {
    const odd = {
      id: `sub ${DEMO_TOKEN}\n`,
      target_url: `ftp://${DEMO_TOKEN}.example.com/`,
      subscribed_events: [`message.received\u001b[2J${DEMO_TOKEN}`, 7],
      phone_numbers: "every",
      is_active: "yes",
    };
    const rig = checkout(t, { subscriptions: [odd] });
    const result = rig.run([BASE], VALUES);
    assert.equal(result.status, 1, result.output);
    assert.equal(
      result.stdout,
      `${HEAD}${listed(1)}  (an id in another form): a target that is no https address, active unknown, Rosie's number unknown (a filter in another form), events (an event in another form) (an event in another form)\n${NONE}`,
    );
    assertNoValueShown(result, "odd fields");
  });

  it("an answer that is not Linq's list, or no answer: nothing is created or changed (exit 1), and no message of Linq's is shown", (t) => {
    // [title, the stand-in's answer, standard error]
    const cases = [
      [
        "HTTP 401 with Linq's code (its message repeats the key)",
        { status: 401, body: { error: { code: 2001, message: `not a key: ${KEY}` } } },
        "linq-staging-check.sh: the list of webhook subscriptions: Linq answered HTTP 401, Linq code 2001; nothing was created or changed\n",
      ],
      [
        "HTTP 500 with no body",
        { status: 500, body: "" },
        "linq-staging-check.sh: the list of webhook subscriptions: Linq answered HTTP 500; nothing was created or changed\n",
      ],
      [
        "no answer",
        { throws: true },
        "linq-staging-check.sh: the list of webhook subscriptions: no answer from Linq (nothing is retried); nothing was created or changed\n",
      ],
      [
        "words, not JSON",
        { status: 200, body: "fine" },
        "linq-staging-check.sh: refused: Linq answered the list with no subscriptions list ({ subscriptions: [...] }, as its documents give it); nothing was created or changed\n",
      ],
      [
        "a bare list",
        { status: 200, body: [ours()] },
        "linq-staging-check.sh: refused: Linq answered the list with no subscriptions list ({ subscriptions: [...] }, as its documents give it); nothing was created or changed\n",
      ],
    ];
    for (const [what, answer, stderr] of cases) {
      for (const args of [[BASE], ["--create", BASE]]) {
        const which = `${what}, ${args.join(" ")}`;
        const rig = checkout(t, { list: answer });
        const result = rig.run(args, VALUES);
        assert.equal(result.status, 1, `${which}: ${result.output}`);
        assert.equal(result.stdout, HEAD, which);
        assert.equal(result.stderr, stderr, which);
        assert.deepEqual(
          rig.fetches().map((call) => call.method),
          ["GET"],
          which,
        );
        assert.deepEqual(
          rig.wranglers().filter((call) => call.args.includes("put")),
          [],
          which,
        );
        assertNoValueShown(result, which);
      }
    }
  });
});

describe("linq-staging-check.sh --create (npm run linq:staging:create) makes staging's subscription and puts its signing secret", () => {
  it("creates one subscription to staging's Linq route for Rosie's number with exactly the parser's events, and its signing secret reaches wrangler on standard input alone", (t) => {
    const old = ours({ id: "sub_t572_old", is_active: false });
    const rig = checkout(t, { subscriptions: [demo(), old] });
    const result = rig.run(["--create", BASE], VALUES);
    assert.equal(result.status, 0, result.output);
    assert.equal(
      result.stdout,
      `${HEAD}${listed(2)}${DEMO_LINE}${line({ id: "sub_t572_old", target: OURS, active: "no" })}` +
        `created sub_t572_new: ${OURS}, the ${String(EVENTS.length)} events on the list, Rosie's number alone\n` +
        "LINQ_WEBHOOK_SECRET set\n" +
        `PASS: sub_t572_new sends the ${String(EVENTS.length)} events on the list for Rosie's number to ${OURS}, and staging holds its signing secret as LINQ_WEBHOOK_SECRET\n`,
    );
    assert.equal(result.stderr, "");
    // The list, then one create with exactly this body.
    const fetches = rig.fetches();
    assert.deepEqual(
      fetches.map((call) => call.method),
      ["GET", "POST"],
    );
    assert.deepEqual(JSON.parse(fetches[1].body), {
      target_url: ROUTE,
      subscribed_events: EVENTS,
      phone_numbers: [NUMBER],
    });
    assert.equal(fetches[1].headers["content-type"], "application/json");
    assertKeyInHeaderAlone(rig, "the create");
    // wrangler: the check that it reaches staging, before anything is asked of Linq, then the put.
    const wranglers = rig.wranglers();
    assert.deepEqual(
      wranglers.map((call) => call.args),
      [listArgs(rig), putArgs(rig)],
    );
    assert.equal(wranglers[0].stdin, "");
    assert.equal(wranglers[1].stdin, SECRET, "the put's standard input is the secret, byte for byte");
    assert.deepEqual(wranglers[1].env, {
      XDG_CONFIG_HOME: path.join(rig.dir, "home", ".config", "rosfield"),
      CLOUDFLARE_ACCOUNT_ID: ROSFIELD_ACCOUNT_ID,
      WRANGLER_LOG_SANITIZE: "true",
    });
    assertNothingHandedOn(rig, "the create");
    assertNoValueShown(result, "the create");
    // No other subscription is changed: the demo's and the old one stay as they were.
    assert.deepEqual(rig.held(), [
      demo(),
      old,
      {
        id: "sub_t572_new",
        target_url: ROUTE,
        subscribed_events: EVENTS,
        phone_numbers: [NUMBER],
        is_active: true,
      },
    ]);
    // No file holds the secret but the stand-in for Linq's state (Linq holds it) and the stand-in wrangler's record of
    // its standard input.
    assert.deepEqual(filesHolding(rig.dir, [SECRET, SECRET.slice(6)], [rig.state, rig.log]), []);
    // The key and the number: in no file of the run but the stand-in for Linq's record of the create's body (the number,
    // which Linq is given).
    assert.deepEqual(filesHolding(rig.dir, [KEY], []), []);
    assert.deepEqual(filesHolding(rig.dir, [NUMBER], [rig.state, rig.log]), []);
  });

  it("takes the new subscription where the answer holds it in a field of its own", (t) => {
    const made = { id: "sub_t572_new", target_url: ROUTE, is_active: true, signing_secret: SECRET };
    const rig = checkout(t, { create: { status: 201, body: { subscription: made } } });
    const result = rig.run(["--create", BASE], VALUES);
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /^PASS: sub_t572_new sends the /m);
    assert.equal(rig.wranglers()[1].stdin, SECRET);
    assertNoValueShown(result, "a nested answer");
  });

  it("refuses when an active subscription already targets staging's Linq route: nothing is created or put", (t) => {
    for (const subscriptions of [[ours(), demo()], [ours({ phone_numbers: [ROSTER_NUMBER] })]]) {
      const rig = checkout(t, { subscriptions });
      const result = rig.run(["--create", BASE], VALUES);
      assert.equal(result.status, 1, result.output);
      assert.equal(
        result.stderr,
        `linq-staging-check.sh: refused: sub_t572_ours already sends to ${OURS} and is active, so --create makes no second one (npm run linq:staging:check says whether it is right); nothing was created\n`,
      );
      assert.deepEqual(
        rig.fetches().map((call) => call.method),
        ["GET"],
      );
      assert.deepEqual(
        rig.wranglers().map((call) => call.args),
        [listArgs(rig)],
      );
      assert.deepEqual(rig.held(), subscriptions);
      assertNoValueShown(result, "a duplicate");
    }
  });

  it("a put that fails: the run says so plainly, shows wrangler's words with the secret taken out, and prints the call that deletes the new subscription by id", (t) => {
    const rig = checkout(t, { subscriptions: [demo()] });
    const result = rig.run(["--create", BASE], { ...VALUES, FAKE_PUT_FAIL: "1" });
    assert.equal(result.status, 1, result.output);
    assert.equal(
      result.stdout,
      `${HEAD}${listed(1)}${DEMO_LINE}created sub_t572_new: ${OURS}, the ${String(EVENTS.length)} events on the list, Rosie's number alone\n`,
    );
    assert.match(result.stderr, /^fake wrangler: was given \[value not shown\]$/m);
    assert.match(
      result.stderr,
      /^fake wrangler: was given \[value not shown\], key bytes \[value not shown\]$/m,
    );
    assert.match(result.stderr, /^fake wrangler: secret put failed$/m);
    assert.ok(
      result.stderr.endsWith(
        `linq-staging-check.sh: FAILED: wrangler secret put LINQ_WEBHOOK_SECRET --env staging failed (exit 1, for the reason above): staging does not hold the signing secret of sub_t572_new, and Linq gives it only once. Delete sub_t572_new, then, once the cause is fixed, run --create again. The call that deletes it: DELETE ${API}/webhook-subscriptions/sub_t572_new with the header Authorization: Bearer and Linq's key (LINQ_API_TOKEN, never shown)\n`,
      ),
      result.stderr.replaceAll(SECRET, "<secret>"),
    );
    assertNoValueShown(result, "a failed put");
    assertNothingHandedOn(rig, "a failed put");
  });

  it("a wrangler that cannot reach staging stops the run before anything is asked of Linq", (t) => {
    const rig = checkout(t, { subscriptions: [demo()] });
    const result = rig.run(["--create", BASE], { ...VALUES, FAKE_LIST_FAIL: "1" });
    assert.equal(result.status, 1, result.output);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^fake wrangler: not signed in$/m);
    assert.match(
      result.stderr,
      /^linq-staging-check\.sh: refused: wrangler secret list --env staging failed \(exit 1, for the reason above\), so staging could not take Linq's signing secret, which Linq gives only once; nothing was asked of Linq or created\. Once the cause is fixed, run it again\.$/m,
    );
    assert.deepEqual(rig.fetches(), []);
    assert.deepEqual(rig.programs(), []);
    assert.deepEqual(rig.held(), [demo()]);
  });

  it("a create Linq does not answer with a subscription and its secret: nothing is put, and a made subscription is named with its delete call", (t) => {
    const remove = `DELETE ${API}/webhook-subscriptions/sub_t572_new with the header Authorization: Bearer and Linq's key (LINQ_API_TOKEN, never shown)`;
    // [title, the stand-in's answer, standard error]
    const cases = [
      [
        "HTTP 500",
        { status: 500, body: { error: { code: 5000 } } },
        "linq-staging-check.sh: the create: Linq answered HTTP 500, Linq code 5000: whether a subscription was made is not known (npm run linq:staging:check lists them), and nothing was put on staging\n",
      ],
      [
        "HTTP 201 with no signing_secret",
        { status: 201, body: { id: "sub_t572_new", target_url: ROUTE, is_active: true } },
        `linq-staging-check.sh: FAILED: Linq made sub_t572_new for ${OURS}, but its answer held no signing_secret staging can hold (no part of it is shown), and Linq gives it only once, so staging could not check its webhooks. Delete sub_t572_new, then run --create again: ${remove}\n`,
      ],
      [
        "HTTP 201 with a secret holding a space",
        {
          status: 201,
          body: { id: "sub_t572_new", signing_secret: `${SECRET.slice(0, 10)} ${SECRET.slice(10)}` },
        },
        `linq-staging-check.sh: FAILED: Linq made sub_t572_new for ${OURS}, but its answer held no signing_secret staging can hold (no part of it is shown), and Linq gives it only once, so staging could not check its webhooks. Delete sub_t572_new, then run --create again: ${remove}\n`,
      ],
      [
        "HTTP 201 with no id",
        { status: 201, body: { signing_secret: 7 } },
        `linq-staging-check.sh: FAILED: Linq made (an id in another form) for ${OURS}, but its answer held no signing_secret staging can hold (no part of it is shown), and Linq gives it only once, so staging could not check its webhooks. Delete (an id in another form), then run --create again: npm run linq:staging:check lists the subscriptions; delete the new one by its id with Linq's key\n`,
      ],
    ];
    for (const [what, create, stderr] of cases) {
      const rig = checkout(t, { subscriptions: [demo()], create });
      const result = rig.run(["--create", BASE], VALUES);
      assert.equal(result.status, 1, `${what}: ${result.output}`);
      assert.equal(result.stdout, `${HEAD}${listed(1)}${DEMO_LINE}`, what);
      assert.equal(result.stderr, stderr, what);
      assert.deepEqual(
        rig.wranglers().map((call) => call.args),
        [listArgs(rig)],
        `${what}: a put`,
      );
      assertNoValueShown(result, what);
      assert.equal(result.output.includes(SECRET.slice(10)), false, `${what}: a part of the secret`);
    }
  });

  it("a secret in another form than whsec_ and base64 is still put, so it is not lost, but the run does not pass", (t) => {
    const rig = checkout(t, {
      subscriptions: [demo()],
      create: { status: 201, body: { id: "sub_t572_new", signing_secret: ODD_SECRET } },
    });
    const result = rig.run(["--create", BASE], VALUES);
    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, /^LINQ_WEBHOOK_SECRET set$/m);
    assert.doesNotMatch(result.stdout, /^PASS/m);
    assert.match(
      result.stderr,
      /^linq-staging-check\.sh: NOT PASS: staging holds the signing secret of sub_t572_new as LINQ_WEBHOOK_SECRET, but it is not whsec_ and base64 \(no part of it is shown\), the one form the gateway verify takes/m,
    );
    assert.equal(rig.wranglers()[1].stdin, ODD_SECRET);
    assertNoValueShown(result, "a secret in another form");
  });

  it("the secret the stand-in gives is in the form the gateway verify takes (adapters/src/shared/hmac.ts)", () => {
    const match = /^const BASE64 = \/(.+)\/;$/m.exec(source("adapters/src/shared/hmac.ts"));
    assert.ok(match, "adapters/src/shared/hmac.ts no longer holds: const BASE64 = /<pattern>/;");
    assert.ok(SECRET.startsWith("whsec_"));
    assert.match(SECRET.slice("whsec_".length), new RegExp(match[1]));
    assert.equal(ODD_SECRET.startsWith("whsec_"), false, "the secret in another form starts with whsec_");
  });
});

describe("linq-staging-check.sh reads its values by name and refuses before anything is asked of Linq", () => {
  it("reads the key and Rosie's number from .dev.vars by name when the environment has none; a value in the environment comes first", (t) => {
    const text = `# made-up values for T-572's tests\nOTHER_NAME=t572-other\nLINQ_API_TOKEN=${KEY}\n  export ROSIE_NUMBER='${NUMBER}'\n`;
    const fromFile = checkout(t, { devVars: text, subscriptions: [ours()] });
    const result = fromFile.run([BASE]);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.stdout, `${HEAD}${listed(1)}${OURS_LINE}${PASS_OURS}`);
    assertKeyInHeaderAlone(fromFile, ".dev.vars");
    assertNothingHandedOn(fromFile, ".dev.vars");
    const fromShell = checkout(t, { devVars: text, subscriptions: [ours()] });
    const second = fromShell.run([BASE], { LINQ_API_TOKEN: OTHER_KEY });
    assert.equal(second.status, 0, second.output);
    assertKeyInHeaderAlone(fromShell, "the environment's key", OTHER_KEY);
    assertNoValueShown(second, "the environment's key");
  });

  it("refuses a missing or faulty key or number, a base that is not https with a plain path, a .dev.vars it cannot read, and CLOUDFLARE_ENV other than staging with --create: nothing is asked of Linq and wrangler never starts", (t) => {
    // [title, arguments, environment, .dev.vars, the reason]
    const cases = [
      ["no key anywhere", [BASE], { ROSIE_NUMBER: NUMBER }, undefined, /LINQ_API_TOKEN is not set/],
      [
        "an empty key line",
        [BASE],
        { ROSIE_NUMBER: NUMBER },
        "LINQ_API_TOKEN=\n",
        /LINQ_API_TOKEN is not set/,
      ],
      [
        "a key with a space",
        [BASE],
        { ROSIE_NUMBER: NUMBER },
        `LINQ_API_TOKEN=${KEY.slice(0, 9)} ${KEY.slice(9)}\n`,
        /LINQ_API_TOKEN holds a space, a quote, a # or a control sign/,
      ],
      [
        "a key with a comment after it",
        [BASE],
        { ROSIE_NUMBER: NUMBER },
        `LINQ_API_TOKEN=${KEY} # Linq\n`,
        /LINQ_API_TOKEN holds a space, a quote, a # or a control sign/,
      ],
      [
        "a quote left open",
        [BASE],
        { ROSIE_NUMBER: NUMBER },
        `LINQ_API_TOKEN="${KEY}\n`,
        /LINQ_API_TOKEN holds a space, a quote, a # or a control sign/,
      ],
      ["no number anywhere", [BASE], { LINQ_API_TOKEN: KEY }, undefined, /ROSIE_NUMBER is not set/],
      [
        "a number with no +",
        [BASE],
        { ...VALUES, ROSIE_NUMBER: NUMBER.slice(1) },
        undefined,
        /ROSIE_NUMBER is not in E\.164 form/,
      ],
      [
        "a number with spaces",
        [BASE],
        { ...VALUES, ROSIE_NUMBER: "+1 555 555 0199" },
        undefined,
        /ROSIE_NUMBER is not in E\.164 form/,
      ],
      [
        "an http base",
        ["http://rosfield.com/test"],
        VALUES,
        undefined,
        /<base-url> must be an https address/,
      ],
      ["a base with a query", [`${BASE}?k=v`], VALUES, undefined, /<base-url> must be an https address/],
      ["a base with a fragment", [`${BASE}#x`], VALUES, undefined, /<base-url> must be an https address/],
      [
        "a base with a sign-in",
        [`https://${DEMO_TOKEN}@rosfield.com/test`],
        VALUES,
        undefined,
        /<base-url> must be an https address/,
      ],
      [
        "a base with no scheme",
        ["rosfield.com/test"],
        VALUES,
        undefined,
        /<base-url> must be an https address/,
      ],
      ["a base with no host", ["https://"], VALUES, undefined, /<base-url> must be an https address/],
      [
        "CLOUDFLARE_ENV=production with --create",
        ["--create", BASE],
        { ...VALUES, CLOUDFLARE_ENV: "production" },
        undefined,
        /CLOUDFLARE_ENV names an environment other than staging/,
      ],
    ];
    for (const [what, args, extra, text, reason] of cases) {
      const rig = checkout(t, { devVars: text, subscriptions: [ours()] });
      const result = rig.run(args, extra);
      assert.equal(result.status, 1, `${what}: ${result.output}`);
      assert.match(
        result.stderr,
        /^linq-staging-check\.sh: refused: [^\n]*nothing was asked of Linq\n$/,
        what,
      );
      assert.match(result.stderr, reason, what);
      assert.equal(result.stdout, "", what);
      assert.deepEqual(rig.fetches(), [], `${what}: a request`);
      assert.deepEqual(rig.wranglers(), [], `${what}: wrangler started`);
      assert.deepEqual(rig.programs(), [], `${what}: the program started`);
      assertNoValueShown(result, what);
      assert.equal(result.output.includes("+1 555"), false, `${what}: the number`);
    }
    const unreadable = checkout(t, { devVars: `LINQ_API_TOKEN=${KEY}\n`, mode: 0o000 });
    const result = unreadable.run([BASE]);
    assert.equal(result.status, 1, result.output);
    assert.equal(
      result.stderr,
      "linq-staging-check.sh: refused: this checkout's .dev.vars cannot be read; nothing was asked of Linq\n",
    );
    assert.deepEqual(unreadable.calls(), []);
  });

  it("an argument it does not take (exit 2), never echoed, before anything is read", (t) => {
    const rig = checkout(t, { devVars: `LINQ_API_TOKEN=${KEY}\n`, mode: 0o000 });
    for (const [args, why] of [
      [[], "no <base-url>"],
      [[""], "no <base-url>"],
      [["--create"], "no <base-url>"],
      [["--bogus", BASE], "an option it does not take (arguments are never echoed)"],
      [["--env", "staging", BASE], "an option it does not take (arguments are never echoed)"],
      [["--delete", "sub_t572_demo", BASE], "an option it does not take (arguments are never echoed)"],
      [[`--key=${KEY}`, BASE], "an option it does not take (arguments are never echoed)"],
      [["--create", "--create", BASE], "--create is given twice"],
      [[BASE, KEY], "more than one <base-url> (arguments are never echoed)"],
    ]) {
      const what = JSON.stringify(args).replace(KEY, "<a pasted key>");
      const result = rig.run(args, VALUES);
      assert.equal(result.status, 2, `${what}: ${result.output}`);
      assert.equal(
        result.stderr,
        `linq-staging-check.sh: ${why}\nusage: linq-staging-check.sh [--create] <base-url>   (staging's base URL with its base path, as check:staging takes it: https://rosfield.com/test)\n`,
        what,
      );
      assert.equal(result.stdout, "", what);
      assert.deepEqual(rig.calls(), [], what);
    }
  });
});

describe("linq-staging-check.sh never traces and hands no value on", () => {
  it("under bash -x, and with xtrace handed down in SHELLOPTS, no command after the switch-off is traced", (t) => {
    for (const [what, extra, options] of [
      ["bash -x", {}, { bash: ["-x"] }],
      ["SHELLOPTS=xtrace", { SHELLOPTS: "xtrace" }, {}],
    ]) {
      const rig = checkout(t, { subscriptions: [demo()] });
      const result = rig.run(["--create", BASE], { ...VALUES, ...extra }, options);
      assert.equal(result.status, 0, `${what}: ${result.output.replaceAll(SECRET, "<secret>")}`);
      assert.match(result.stderr, /set \+x/, `${what}: the run was traced until the script switched it off`);
      assert.doesNotMatch(result.stderr, /pipefail|printf|load_dev_var|secret list/, what);
      assertNoValueShown(result, what);
      assertNothingHandedOn(rig, what);
    }
  });

  it("a caller's environment that holds every name the script works with, exported, with allexport or keyword handed down", (t) => {
    const names = [
      "mode",
      "base",
      "route",
      "key",
      "number",
      "status",
      "listed",
      "name",
      "file",
      "line",
      "value",
      "BASH_REMATCH",
      "USAGE",
      "DEV_VARS",
      "E164",
      "NOT_IN_A_KEY",
      "BASE_FORM",
      "LINQ_API_BASE",
      "EVENTS",
      "PROGRAM",
    ];
    const caller = Object.fromEntries(names.map((name) => [name, `t572 made-up caller text, ${name}`]));
    for (const [what, extra, options] of [
      ["the names exported", caller, {}],
      ["allexport", { SHELLOPTS: "allexport" }, {}],
      ["bash -a -k", {}, { bash: ["-a", "-k"] }],
    ]) {
      const rig = checkout(t, { subscriptions: [demo()] });
      const result = rig.run(["--create", BASE], { ...VALUES, ...extra }, options);
      assert.equal(
        result.status,
        0,
        `${what}: exit ${String(result.status)} (the output is not repeated here)`,
      );
      assert.match(result.stdout, /^PASS: sub_t572_new sends /m, what);
      assert.equal(result.stderr, "", `${what}: standard error is not empty`);
      assertNothingHandedOn(rig, what);
      // The script drops each of its names before it sets one, so no command it starts gets a variable of them.
      for (const call of rig.calls().filter((entry) => entry.tool === "node" || entry.tool === "wrangler")) {
        assert.deepEqual(
          names.filter((name) => call.envNames.includes(name)),
          [],
          `${what}: a command got a variable of the script's own`,
        );
      }
    }
  });

  it("switches tracing, allexport and keyword off first, and drops every variable it works with before anything is sourced or started", () => {
    const text = readFileSync(path.join(SCRIPTS, SCRIPT), "utf8");
    // The bash lines alone: the node program's text, between PROGRAM=' and the line that closes it, is node's.
    const bashText = text.replace(/^PROGRAM='\n[\s\S]*?\n'$/m, "PROGRAM=''");
    assert.notEqual(bashText, text, `${SCRIPT} no longer holds: PROGRAM=' ... '`);
    const lines = bashText.split("\n").filter((entry) => !/^\s*#/.test(entry) && entry.trim() !== "");
    assert.deepEqual(
      lines.slice(0, 4),
      ["set +x", "set +a", "set +k", "set -euo pipefail"],
      "the first commands",
    );
    const unsets = [];
    let at = 4;
    for (; /^unset -v [A-Za-z_][A-Za-z0-9_ ]*$/.test(lines[at]); at += 1) {
      unsets.push(...lines[at].slice("unset -v ".length).split(" "));
    }
    // Every variable the script assigns or declares local, lib.sh's load_dev_var's own, lib.sh's ROOT and CF, and
    // BASH_REMATCH.
    const loader = /^load_dev_var\(\) \{\n([\s\S]*?)\n\}$/m.exec(
      readFileSync(path.join(SCRIPTS, "lib.sh"), "utf8"),
    );
    assert.ok(loader, "lib.sh no longer holds: load_dev_var() { ... }");
    const assigned = new Set(["ROOT", "CF", "BASH_REMATCH"]);
    for (const [, name] of `${lines.join("\n")}\n${loader[1]}`.matchAll(
      /(?:^|;|&&|\|\|)[ \t]*([A-Za-z_][A-Za-z0-9_]*)\+?=/gm,
    )) {
      assigned.add(name);
    }
    for (const [, words] of loader[1].matchAll(/^[ \t]*local[ \t]+(.+)$/gm)) {
      for (const word of words.split(/[ \t]+/)) assigned.add(word.replace(/=.*$/, ""));
    }
    assert.deepEqual([...unsets].sort(), [...assigned].sort(), "the names on the unset lines");
    assert.equal(new Set(unsets).size, unsets.length, "a name is on the unset lines twice");
    assert.deepEqual(
      lines.slice(at, at + 4),
      [
        'key="${LINQ_API_TOKEN:-}"',
        'number="${ROSIE_NUMBER:-}"',
        "unset -v LINQ_API_TOKEN ROSIE_NUMBER",
        'source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"',
      ],
      "what follows the unset lines",
    );
    // No here-document or here-string (bash 3.2 writes those to a temporary file), and no export.
    assert.doesNotMatch(bashText, /<</, "a here-document or here-string");
    assert.equal(/^[ \t]*(export|declare -x)\b/m.test(bashText), false, "an export");
  });
});

describe("linq-staging-check.sh's list, base and npm scripts", () => {
  it("EVENTS is exactly the Linq event types T-413's parser maps (adapters/src/linq/webhook/parse.ts USED_EVENT_TYPES)", () => {
    assert.deepEqual(scriptEvents(), EVENTS);
    // Every type the parser's switch names is on its list too, so the list is what it maps.
    const parse = source("adapters/src/linq/webhook/parse.ts");
    const cases = Array.from(parse.matchAll(/^\s*case "([a-z][a-z0-9_.]*)":$/gm), ([, event]) => event);
    assert.ok(cases.length > 0, "parse.ts's switch names no event");
    assert.deepEqual(
      cases.filter((event) => !EVENTS.includes(event)),
      [],
      "a type the parser maps that is not on USED_EVENT_TYPES",
    );
  });

  it("its Linq base is T-414's (adapters/src/linq/send/wire.ts LINQ_API_BASE)", () => {
    const match = /^LINQ_API_BASE="([^"]+)"$/m.exec(readFileSync(path.join(SCRIPTS, SCRIPT), "utf8"));
    assert.ok(match, `${SCRIPT} no longer holds: LINQ_API_BASE="<url>"`);
    assert.equal(match[1], API);
  });

  it("staging's Linq route is the gateway's LINQ_WEBHOOK_PATH under the base", () => {
    const match = /^export const LINQ_WEBHOOK_PATH = "([^"]+)";$/m.exec(
      source("runtime/src/gateway/index.ts"),
    );
    assert.ok(
      match,
      'runtime/src/gateway/index.ts no longer holds: export const LINQ_WEBHOOK_PATH = "<path>";',
    );
    assert.equal(ROUTE, `${BASE}${match[1]}`);
    assert.match(
      readFileSync(path.join(SCRIPTS, SCRIPT), "utf8"),
      new RegExp(`^route="\\$base${match[1].replaceAll("/", "\\/")}"$`, "m"),
    );
  });

  it("npm run linq:staging:check and npm run linq:staging:create run the script", () => {
    const scripts = JSON.parse(source("package.json")).scripts;
    assert.equal(scripts["linq:staging:check"], `bash infra/scripts/${SCRIPT}`);
    assert.equal(scripts["linq:staging:create"], `bash infra/scripts/${SCRIPT} --create`);
  });
});
