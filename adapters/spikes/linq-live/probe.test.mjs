// The outbound Linq probe's test (T-1121 phase 1): node --test adapters/spikes/linq-live/probe.test.mjs
//
// It never runs --live and makes no network call: every run is probe.sh's dry run against a local stand-in on
// 127.0.0.1 (stub.mjs: the test's own, or the probe's), with a made-up key that is new each run and fiction numbers
// (555-01xx) alone. Each run goes through bash with a PATH that holds recorders alone (infra/ci/script-harness.mjs
// spies), so every command probe.sh starts is seen with its arguments and environment. It proves the lead note's claims
// (the card, DL-841, items 2 to 5):
//   - no allow-list, an empty one, or a destination off it is refused before any request;
//   - no key is refused naming only the variable;
//   - each number in any output or sample shows only its last 2 digits;
//   - the key reaches only the Authorization header of a request to the stand-in: never an argument or the environment
//     of a command, a line of output, or a file;
//   - at most one message per step, its words saying plainly that it is a Rosie staging test;
// and the card's fixture check: no recorded sample (samples/, phase 2) holds a key or an unmasked number.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FICTIONAL_PHONE, phoneNumbersIn } from "../../../infra/ci/phone-scan.mjs";
import { cleanEnv, spies, tempDir, whereHeld } from "../../../infra/ci/script-harness.mjs";
import {
  LIVE_DEFAULT_STEPS,
  MessageBudget,
  Misuse,
  ProbeRefusal,
  STEPS,
  WORDS,
  checkValues,
  isFiction,
  maskJson,
  maskText,
  masked,
  parseArgs,
} from "./lib.mjs";
import { startStub } from "./stub.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PROBE = path.join(HERE, "probe.sh");
const SAMPLES = path.join(HERE, "samples");
const CHATS = "/api/partner/v3/chats";

// Fiction numbers alone (+1, area code 555, then 555-0100 to 555-0199).
const DEST = "+15555550101";
const OFF_LIST = "+15555550102";
const LINE = "+15555550199";
const LINE_ELSE = "+15555550198";
const NUMBERS = [DEST, OFF_LIST, LINE, LINE_ELSE];

/** A made-up key, new each time: the canary every check looks for. */
const canary = () => `linq-canary-${randomUUID()}`;

// The vendors' key shapes and a bearer header (adapters/src/shared/redact.ts KEY, copied: this file runs under plain node).
const KEY_SHAPE =
  /\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{6,}|whsec_[A-Za-z0-9]{6,}|re_[A-Za-z0-9_]{12,}|sk-ant-[A-Za-z0-9_-]{6,}|AIza[A-Za-z0-9_-]{20,})|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i;

/** What a sample or an output file must never hold, one line each, naming the file alone. */
function sampleProblems(name, text, key = null) {
  const problems = [];
  if (KEY_SHAPE.test(text)) problems.push(`${name}: a key-shaped value`);
  if (/authorization/i.test(text)) problems.push(`${name}: an authorization header`);
  if (key !== null && text.includes(key)) problems.push(`${name}: the key`);
  if (phoneNumbersIn(text).length > 0) problems.push(`${name}: a number that is not masked`);
  return problems;
}

/** Every file under dir (its path relative to dir and its text); none when dir does not exist. */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((name) => lstatSync(path.join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: readFileSync(path.join(dir, name), "utf8") }));
}

/** A throwaway folder for one test: HOME, TMPDIR, output folders and the recorders in front of dirname and node. */
function setup(t, name) {
  const dir = tempDir(t, `linq-live-${name}`);
  const home = path.join(dir, "home");
  const tmp = path.join(dir, "tmp");
  mkdirSync(home);
  mkdirSync(tmp);
  let outs = 0;
  return {
    dir,
    home,
    tmp,
    spy: spies(dir, ["dirname", "node"]),
    out() {
      outs += 1;
      const out = path.join(dir, `out-${String(outs)}`);
      mkdirSync(out);
      return out;
    },
  };
}

/**
 * Runs bash probe.sh with args, the values in its environment by name (undefined leaves a name out), and a PATH of the
 * recorders alone. Gives {code, stdout, stderr, output, children}.
 */
async function probe(ctx, args, values = {}) {
  ctx.spy.clear();
  const env = cleanEnv(ctx.home, {
    PATH: ctx.spy.bin,
    TMPDIR: ctx.tmp,
    NODE_TEST_CONTEXT: undefined,
    NODE_OPTIONS: undefined,
    LINQ_API_TOKEN: values.key,
    ROSIE_NUMBER: values.line,
    LINQ_FROM: values.lineElse,
    STAGING_LINQ_ALLOWLIST: values.allowList,
    LINQ_PROBE_TO: values.to,
  });
  const child = spawn("/bin/bash", [PROBE, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code, stdout, stderr, output: stdout + stderr, children: ctx.spy.children() };
}

/** No line of output holds the key or a number, and no command probe.sh started holds either in its arguments or environment. */
function assertClean(result, key, why) {
  assert.ok(!result.output.includes(key), `${why}: the output holds the key`);
  assert.deepEqual(phoneNumbersIn(result.output), [], `${why}: the output holds a number`);
  assert.deepEqual(
    whereHeld(result.children, [key, ...NUMBERS], (c) => c.name),
    [],
    `${why}: a command holds one`,
  );
  for (const child of result.children)
    assert.ok(["dirname", "node"].includes(child.name), `${why}: ${child.name}`);
}

/** The refusal's problem lines (each after "  - "). */
const problemsIn = (stderr) =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith("linq-live:   - "))
    .map((line) => line.slice("linq-live:   - ".length));

test("no allow-list, an empty one, or a destination off it is refused before any request", async (t) => {
  const ctx = setup(t, "list");
  const stub = await startStub();
  t.after(() => stub.close());
  const key = canary();
  const notSet = "STAGING_LINQ_ALLOWLIST is not set, or is empty";
  const cases = [
    { why: "no allow-list", values: { key, line: LINE }, says: notSet },
    { why: "an empty allow-list", values: { key, line: LINE, allowList: "" }, says: notSet },
    { why: "a blank allow-list", values: { key, line: LINE, allowList: "  " }, says: notSet },
    {
      why: "a destination off the list",
      values: { key, line: LINE, allowList: DEST, to: OFF_LIST },
      says: "LINQ_PROBE_TO (***02) is not on STAGING_LINQ_ALLOWLIST: the probe sends to no number off that list",
    },
    {
      why: "an entry that is not E.164 (a space after the comma)",
      values: { key, line: LINE, allowList: `${DEST}, ${OFF_LIST}` },
      says: "STAGING_LINQ_ALLOWLIST: entry 2 of 2 is not an E.164 number",
    },
    {
      why: "two numbers on the list and no destination named",
      values: { key, line: LINE, allowList: `${DEST},${OFF_LIST}` },
      says: "STAGING_LINQ_ALLOWLIST holds 2 numbers and LINQ_PROBE_TO names none",
    },
  ];
  for (const { why, values, says } of cases) {
    const out = ctx.out();
    const result = await probe(ctx, ["--dry-run", "--stub-url", stub.url, "--out", out], values);
    assert.equal(result.code, 1, `${why}: ${result.stderr}`);
    assert.ok(result.stderr.includes("refused before any request (nothing was sent)"), why);
    const problems = problemsIn(result.stderr);
    assert.equal(problems.length, 1, `${why}: ${problems.join(" | ")}`);
    assert.ok(problems[0].startsWith(says), `${why}: ${problems[0]}`);
    assert.equal(stub.requests.length, 0, `${why}: a request reached the stand-in`);
    assert.deepEqual(readdirSync(out), [], `${why}: a file was written`);
    assertClean(result, key, why);
  }
  // The probe's own stand-in takes no request either: a refused run starts none (no --stub-url, no --out).
  const own = await probe(ctx, ["--dry-run"], { key, line: LINE });
  assert.equal(own.code, 1);
  assert.deepEqual(readdirSync(ctx.tmp), [], "a refused run made an output folder");
  assertClean(own, key, "the probe's own stand-in");
});

test("no key is refused naming only the variable, and a key that cannot be one is never shown", async (t) => {
  const ctx = setup(t, "key");
  const stub = await startStub();
  t.after(() => stub.close());
  const args = () => ["--dry-run", "--stub-url", stub.url, "--out", ctx.out()];

  const none = await probe(ctx, args(), { line: LINE, allowList: DEST });
  assert.equal(none.code, 1, none.stderr);
  assert.deepEqual(problemsIn(none.stderr), [
    "LINQ_API_TOKEN is not set: Linq's API key, read by name, is needed for every request",
  ]);

  const key = canary();
  const spaced = await probe(ctx, args(), { key: `${key} x`, line: LINE, allowList: DEST });
  assert.equal(spaced.code, 1, spaced.stderr);
  assert.deepEqual(problemsIn(spaced.stderr), [
    "LINQ_API_TOKEN is not a usable key (fewer than 8 characters, or a space or control character in it); no part of it is shown",
  ]);
  assert.ok(!spaced.output.includes(key.slice("linq-canary-".length)), "a part of the key was shown");
  assertClean(spaced, key, "a key with a space");

  const noLine = await probe(ctx, args(), { key, allowList: DEST });
  assert.equal(noLine.code, 1, noLine.stderr);
  assert.deepEqual(problemsIn(noLine.stderr), [
    "neither ROSIE_NUMBER nor LINQ_FROM is set: Rosie's sending line opens the probe's chat",
  ]);
  assert.equal(stub.requests.length, 0, "a request reached the stand-in");
});

test("a dry run takes fiction numbers alone, and never shows another", async (t) => {
  const ctx = setup(t, "fiction");
  const stub = await startStub();
  t.after(() => stub.close());
  const key = canary();
  // 800 is toll-free, where 555-01xx is no fiction (infra/ci/phone-scan.mjs). Made at run time, so no file holds it.
  const tollFree = ["+1", "800", "555", "0101"].join("");
  assert.ok(!FICTIONAL_PHONE.test(tollFree) && !isFiction(tollFree));
  for (const values of [
    { key, line: LINE, allowList: tollFree },
    { key, line: tollFree, allowList: DEST },
    { key, line: LINE, allowList: `${DEST},${tollFree}`, to: DEST },
  ]) {
    const result = await probe(ctx, ["--dry-run", "--stub-url", stub.url, "--out", ctx.out()], values);
    assert.equal(result.code, 1, result.stderr);
    assert.match(problemsIn(result.stderr).join("\n"), /a dry run takes fiction numbers alone/);
    assert.ok(!result.output.includes(tollFree.slice(1)), "the number was shown");
    assertClean(result, key, "a number that is no fiction");
  }
  assert.equal(stub.requests.length, 0);
});

test("misuse is refused before anything is read or sent, and no argument is echoed", async (t) => {
  const ctx = setup(t, "misuse");
  const stub = await startStub();
  t.after(() => stub.close());
  const key = canary();
  const odd = `odd-${randomUUID()}`;
  const values = { key, line: LINE, allowList: DEST };
  for (const args of [
    [],
    [odd],
    ["--dry-run", "--step", odd],
    ["--dry-run", odd],
    ["--dry-run", "--out"],
    ["--dry-run", "--stub-url", "http://example.com:80"],
    ["--dry-run", "--stub-url", "http://127.0.0.2:8080"],
    ["--dry-run", "--stub-url", `${stub.url}/elsewhere`],
  ]) {
    const result = await probe(ctx, args, values);
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, /misuse/);
    assert.ok(!result.output.includes(odd), "an argument was echoed");
    assertClean(result, key, args.join(" "));
  }
  // A non-empty --out folder: refused before any request.
  const out = ctx.out();
  writeFileSync(path.join(out, "earlier.json"), "{}\n");
  const full = await probe(ctx, ["--dry-run", "--stub-url", stub.url, "--out", out], values);
  assert.equal(full.code, 2, full.stderr);
  assert.match(full.stderr, /the --out folder is not empty/);
  assert.equal(stub.requests.length, 0);
});

test("the key reaches only the Authorization header; every number in the output and the files shows its last 2 digits alone; one message a step, plainly a Rosie staging test", async (t) => {
  const ctx = setup(t, "run");
  const stub = await startStub();
  t.after(() => stub.close());
  const key = canary();
  const values = { key, line: LINE, allowList: DEST };
  const outA = ctx.out();
  const first = await probe(
    ctx,
    [
      "--dry-run",
      "--stub-url",
      stub.url,
      "--out",
      outA,
      "--step",
      "send",
      "--step",
      "contact",
      "--step",
      "capability",
    ],
    values,
  );
  assert.equal(first.code, 0, first.stderr);
  // Between the runs the phone "texts STOP" (on the stand-in): the stopped steps run on their own, as in a live run.
  stub.simulateStop(DEST);
  const outB = ctx.out();
  const second = await probe(
    ctx,
    ["--dry-run", "--stub-url", stub.url, "--out", outB, "--step", "stopped", "--step", "stopped-override"],
    values,
  );
  assert.equal(second.code, 0, second.stderr);

  // The requests, in the steps' order (capability, contact, send), then the stopped steps.
  assert.deepEqual(
    stub.requests.map((r) => r.url),
    [
      "/api/partner/v3/capability/check_imessage",
      "/api/partner/v3/capability/check_rcs",
      "/api/partner/v3/contacts",
      CHATS,
      CHATS,
      CHATS,
    ],
  );
  // The key: in the Authorization header of each request, exactly, and nowhere else in it.
  for (const request of stub.requests) {
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    const others = Object.entries(request.headers).filter(([name]) => name !== "authorization");
    assert.ok(!JSON.stringify([request.method, request.url, others, request.body]).includes(key));
  }
  // ... never an argument or the environment of a command (probe.sh starts dirname and node alone), nor a line of
  // output; the numbers neither.
  for (const result of [first, second]) {
    assert.equal(result.children.filter((c) => c.name === "node").length, 1);
    assertClean(result, key, "a full dry run");
  }
  // ... nor a file: everything under the test's folder (the output folders, TMPDIR, HOME and the recorders' copies of
  // each command's arguments and environment).
  const files = filesUnder(ctx.dir);
  assert.ok(files.length > 0);
  assert.deepEqual(
    files.filter((file) => file.text.includes(key)).map((file) => file.name),
    [],
  );

  // The requests carried the numbers whole (the masking is for what the probe prints and writes).
  const bodies = stub.requests.map((r) => JSON.parse(r.body));
  assert.deepEqual(bodies.slice(0, 2), [{ address: DEST }, { address: DEST }]);
  assert.deepEqual(bodies[2], { phone_number: DEST });
  for (const body of bodies.slice(3)) {
    assert.equal(body.from, LINE);
    assert.deepEqual(body.to, [DEST]);
  }

  // One message a step, its words plainly a Rosie staging test; override_optout only on its own step.
  const sends = bodies.slice(3);
  assert.deepEqual(
    sends.map((body) => /^t1121-(stopped-override|stopped|send)-/.exec(body.message.idempotency_key)?.[1]),
    ["send", "stopped", "stopped-override"],
  );
  assert.equal(new Set(sends.map((body) => body.message.idempotency_key)).size, 3);
  for (const body of sends) {
    assert.equal(body.message.parts.length, 1);
    assert.equal(body.message.parts[0].type, "text");
    assert.match(body.message.parts[0].value, /^Rosie staging test \(T-1121\): .*No reply needed\.$/);
  }
  assert.deepEqual(
    sends.map((body) => body.message.parts[0].value),
    [WORDS.send, WORDS.stopped, WORDS["stopped-override"]],
  );
  assert.deepEqual(
    sends.map((body) => body.override_optout),
    [false, false, true],
  );

  // What the probe printed and wrote: no number but masked, each one by its last 2 digits.
  assert.match(
    first.stdout,
    /destination \*\*\*01 \(on STAGING_LINQ_ALLOWLIST, 1 number\(s\)\); sending line \*\*\*99 \(ROSIE_NUMBER\)/,
  );
  const written = [...filesUnder(outA), ...filesUnder(outB)];
  assert.deepEqual(
    written.map((file) => file.name),
    [
      "01-capability-check_imessage.json",
      "02-capability-check_rcs.json",
      "03-contact-contact_add.json",
      "04-send-send.json",
      "run.json",
      "01-stopped-send.json",
      "02-stopped-override-send.json",
      "run.json",
    ],
  );
  for (const file of written) assert.deepEqual(sampleProblems(file.name, file.text, key), []);
  const sample = (dir, name) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
  const imessage = sample(outA, "01-capability-check_imessage.json");
  assert.deepEqual(imessage.request.body, { address: "***01" });
  assert.equal(imessage.response.body.address, "***01");
  assert.deepEqual(imessage.port, {
    call: "capabilityCheck",
    check: "imessage",
    result: "checked",
    available: true,
    reason: null,
    service: "imessage",
  });
  assert.equal(sample(outA, "03-contact-contact_add.json").response.body.contact.phone_number, "***01");
  const send = sample(outA, "04-send-send.json");
  assert.equal(send.request.body.from, "***99");
  assert.deepEqual(send.request.body.to, ["***01"]);
  assert.deepEqual(send.response.body.to, ["***01"]);
  assert.equal(send.response.status, 201);
  assert.deepEqual(send.port, { call: "sendPart", result: "accepted", service: "imessage" });
  // After STOP: 403 with code 2024, read as K-11's optedOut, with override_optout or without (README spike row 15).
  for (const name of ["01-stopped-send.json", "02-stopped-override-send.json"]) {
    const stopped = sample(outB, name);
    assert.equal(stopped.response.status, 403);
    assert.equal(stopped.response.body.error.code, 2024);
    assert.deepEqual(stopped.port, {
      call: "sendPart",
      result: "failed",
      kind: "optedOut",
      httpStatus: 403,
      code: "2024",
    });
  }
  const summary = sample(outB, "run.json");
  assert.equal(summary.destination, "***01");
  assert.deepEqual(summary.sendingLine, { variable: "ROSIE_NUMBER", number: "***99" });
  assert.deepEqual(summary.steps, ["stopped", "stopped-override"]);
});

test("a dry run with no --stub-url runs every step against the probe's own stand-in on 127.0.0.1", async (t) => {
  const ctx = setup(t, "own");
  const key = canary();
  const result = await probe(ctx, ["--dry-run"], { key, line: LINE, allowList: DEST });
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    /dry-run run .* against a local stand-in on 127\.0\.0\.1: steps capability, contact, send, stopped, stopped-override;/,
  );
  assertClean(result, key, "the probe's own stand-in");
  // Its output folder is new, in TMPDIR.
  const [folder, ...more] = readdirSync(ctx.tmp);
  assert.deepEqual(more, []);
  assert.match(folder, /^linq-live-dry-run-/);
  const written = filesUnder(path.join(ctx.tmp, folder));
  assert.deepEqual(
    written.map((file) => file.name),
    [
      "01-capability-check_imessage.json",
      "02-capability-check_rcs.json",
      "03-contact-contact_add.json",
      "04-send-send.json",
      "05-stopped-send.json",
      "06-stopped-override-send.json",
      "run.json",
    ],
  );
  for (const file of written) assert.deepEqual(sampleProblems(file.name, file.text, key), []);
  const summary = JSON.parse(written.at(-1).text);
  assert.deepEqual(
    summary.calls.map((call) => [call.step, call.status, call.port.result, call.port.kind ?? null]),
    [
      ["capability", 200, "checked", null],
      ["capability", 200, "checked", null],
      ["contact", 201, "added", null],
      ["send", 201, "accepted", null],
      ["stopped", 403, "failed", "optedOut"],
      ["stopped-override", 403, "failed", "optedOut"],
    ],
  );
  // One message a step: three sends, one in each message step.
  assert.deepEqual(
    summary.calls.filter((call) => call.call === "send").map((call) => call.step),
    ["send", "stopped", "stopped-override"],
  );
});

test("ROSIE_NUMBER is the sending line; LINQ_FROM serves only when ROSIE_NUMBER is not set", async (t) => {
  const ctx = setup(t, "line");
  const stub = await startStub();
  t.after(() => stub.close());
  const key = canary();
  const both = await probe(ctx, ["--dry-run", "--stub-url", stub.url, "--out", ctx.out(), "--step", "send"], {
    key,
    line: LINE,
    lineElse: LINE_ELSE,
    allowList: DEST,
  });
  assert.equal(both.code, 0, both.stderr);
  assert.match(both.stdout, /sending line \*\*\*99 \(ROSIE_NUMBER\)/);
  const fallback = await probe(
    ctx,
    ["--dry-run", "--stub-url", stub.url, "--out", ctx.out(), "--step", "send"],
    {
      key,
      lineElse: LINE_ELSE,
      allowList: DEST,
    },
  );
  assert.equal(fallback.code, 0, fallback.stderr);
  assert.match(fallback.stdout, /sending line \*\*\*98 \(LINQ_FROM\)/);
  assert.deepEqual(
    stub.requests.map((r) => JSON.parse(r.body).from),
    [LINE, LINE_ELSE],
  );
  // A destination named on a longer list, and the line itself refused as a destination.
  const named = await probe(
    ctx,
    ["--dry-run", "--stub-url", stub.url, "--out", ctx.out(), "--step", "capability"],
    {
      key,
      line: LINE,
      allowList: `${OFF_LIST},${DEST}`,
      to: DEST,
    },
  );
  assert.equal(named.code, 0, named.stderr);
  assert.deepEqual(JSON.parse(stub.requests.at(-1).body), { address: DEST });
  const itself = await probe(ctx, ["--dry-run", "--stub-url", stub.url, "--out", ctx.out()], {
    key,
    line: LINE,
    allowList: LINE,
  });
  assert.equal(itself.code, 1);
  assert.match(
    problemsIn(itself.stderr).join("\n"),
    /the destination is Rosie's own sending line \(ROSIE_NUMBER\)/,
  );
  for (const result of [both, fallback, named, itself]) assertClean(result, key, "the sending line");
  assert.equal(stub.requests.length, 4);
});

test("a step sends one message at most: a second is refused before it goes", () => {
  const budget = new MessageBudget();
  budget.take("send");
  budget.take("stopped");
  assert.throws(() => budget.take("send"), ProbeRefusal);
  assert.throws(() => budget.take("stopped"), ProbeRefusal);
  budget.take("stopped-override");
});

test("the command line: the steps a mode takes by default, and what a live run refuses (parsed alone, never run)", () => {
  assert.deepEqual(parseArgs(["--dry-run"]).steps, [...STEPS]);
  assert.deepEqual(parseArgs(["--live"]).steps, [...LIVE_DEFAULT_STEPS]);
  assert.deepEqual(parseArgs(["--live"]).steps, ["capability", "send"]);
  assert.deepEqual(parseArgs(["--dry-run", "--step", "stopped", "--step", "send"]).steps, [
    "send",
    "stopped",
  ]);
  assert.deepEqual(parseArgs(["--live", "--step", "stopped-override", "--step", "stopped"]).steps, [
    "stopped",
    "stopped-override",
  ]);
  assert.throws(() => parseArgs(["--live", "--step", "stopped", "--step", "send"]), Misuse);
  assert.throws(() => parseArgs(["--live", "--stub-url", "http://127.0.0.1:8080"]), Misuse);
  assert.throws(() => parseArgs(["--dry-run", "--live"]), Misuse);
  assert.equal(
    parseArgs(["--dry-run", "--stub-url", "http://127.0.0.1:8080/"]).stubUrl,
    "http://127.0.0.1:8080",
  );
});

test("the values: a list entry by its place alone, a destination off the list by its last 2 digits", () => {
  const key = canary();
  const check = (raw, mode = "dry-run") =>
    checkValues({ key, rosieNumber: LINE, linqFrom: "", allowList: DEST, to: "", ...raw }, mode);
  assert.deepEqual(check({}).values, {
    key,
    line: LINE,
    lineName: "ROSIE_NUMBER",
    allowList: [DEST],
    destination: DEST,
  });
  assert.deepEqual(check({ allowList: `${DEST},${DEST}` }).values.allowList, [DEST]);
  const off = check({ to: OFF_LIST });
  assert.equal(off.values, null);
  assert.deepEqual(off.problems, [
    "LINQ_PROBE_TO (***02) is not on STAGING_LINQ_ALLOWLIST: the probe sends to no number off that list",
  ]);
  const short = check({ key: "short" });
  assert.equal(short.values, null);
  assert.ok(!short.problems.join("\n").includes("short"));
  for (const { problems } of [off, short, check({ allowList: "not-a-number" })]) {
    assert.ok(!problems.join("\n").includes(key));
    assert.deepEqual(phoneNumbersIn(problems.join("\n")), []);
  }
});

test("masking: a number however it is written shows its last 2 digits alone; the key, an address and a name never show", () => {
  const key = canary();
  const secret = { key, numbers: [DEST, LINE] };
  for (const written of [
    "+15555550101",
    "15555550101",
    "5555550101",
    "+1 555 555 0101",
    "+1 (555) 555-0101",
    "(555) 555-0101",
    "555-555-0101",
    "555.555.0101",
    "1-555-555-0101",
  ]) {
    const text = maskText(`to ${written}, then`, secret);
    assert.match(text, /\*\*\*01/, written);
    assert.deepEqual(phoneNumbersIn(text), [], written);
  }
  // A number the probe was not given is masked too.
  assert.equal(maskText("from +15555550142", secret), "from ***42");
  assert.equal(maskText(`Bearer ${key}`, secret), "Bearer [key]");
  assert.equal(maskText("handle sam@example.com", secret), "handle [email]");
  // Times, keys and counts stay as they are.
  for (const kept of [
    "2026-11-15T18:45:01Z",
    "t1121-send-2026-11-15T18-45-01Z-3f2a1b9c",
    "retry after 65 s",
  ]) {
    assert.equal(maskText(kept, secret), kept);
  }
  assert.equal(masked("+15555550199"), "***99");
  assert.deepEqual(
    maskJson(
      {
        address: DEST,
        display_name: "Sam Lee",
        handles: [{ handle: LINE }],
        [DEST]: 15555550101,
        size: 4096,
      },
      secret,
    ),
    {
      address: "***01",
      display_name: "[name]",
      handles: [{ handle: "***99" }],
      "***01": "***01",
      size: 4096,
    },
  );
});

test("the probe's Node files start no other program and read no environment variable; probe.sh drops the names first", () => {
  for (const name of ["lib.mjs", "probe.mjs", "stub.mjs", "wire.mjs"]) {
    const text = readFileSync(path.join(HERE, name), "utf8");
    assert.doesNotMatch(text, /child_process|worker_threads|node:cluster|process\.env/, name);
  }
  const script = readFileSync(PROBE, "utf8");
  const dropped = script.indexOf(
    "unset -v LINQ_API_TOKEN ROSIE_NUMBER LINQ_FROM STAGING_LINQ_ALLOWLIST LINQ_PROBE_TO",
  );
  assert.ok(
    dropped > 0 && dropped < script.indexOf('"$(dirname'),
    "the names leave the environment before any command",
  );
  assert.doesNotMatch(
    script.replace(/^\s*#.*$/gm, ""),
    /<<|\bexport\b/,
    "a here-document, a here-string or an export",
  );
});

test("no recorded sample holds a key or an unmasked number, and no file of the spike holds a number outside the fiction range", () => {
  // samples/: the live run's recorded responses, committed in phase 2 (none yet in phase 1).
  for (const file of filesUnder(SAMPLES)) assert.deepEqual(sampleProblems(file.name, file.text), []);
  // Every file of the spike (T-1316, as web/spikes/chat-link does), FINDINGS.md and samples/ included: fiction numbers
  // alone.
  const files = filesUnder(HERE);
  for (const name of ["lib.mjs", "probe.mjs", "probe.sh", "probe.test.mjs", "stub.mjs", "wire.mjs"]) {
    assert.ok(
      files.some((file) => file.name === name),
      name,
    );
  }
  const outside = files.filter((file) =>
    phoneNumbersIn(file.text).some((number) => !FICTIONAL_PHONE.test(number)),
  );
  assert.deepEqual(
    outside.map((file) => file.name),
    [],
  );
});
