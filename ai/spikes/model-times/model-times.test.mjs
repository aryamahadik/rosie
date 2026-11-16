// The real model times spike's own tests (T-362): its percentile and timing maths, the one way out (wire.mjs), a whole
// dry run against the local stub, a whole live-mode run on a stand-in transport (never the network), the refusals, and
// the staging capture's reader. No key, no network, no live call: CI never runs this file (it is not in a Vitest
// project); run it with `node --test ai/spikes/model-times/model-times.test.mjs`. Every value is fiction.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { formatMarkdown, renderRun } from "./report.mjs";
import { liveCallsLogged, main, parseArgs } from "./run.mjs";
import {
  decideReads,
  modelCallRows,
  parseArgs as stagingArgs,
  renderStaging,
  spansOf,
} from "./staging-spans.mjs";
import { BUDGETS, cells, pageBudgetPath, percentile, replyPath, summary } from "./stats.mjs";
import { DRY_KEY, answerFor, fixtureAnswers } from "./stub.mjs";
import {
  CALL_LIMIT,
  HERE,
  PLAN,
  classifier,
  composerCases,
  loadProduction,
  plannedCalls,
  readTimes,
  schedule,
} from "./units.mjs";
import { API_URL, CAPPED_STATUS, INJECTED_STATUS, createWire } from "./wire.mjs";

const temp = mkdtempSync(join(tmpdir(), "t362-"));
after(() => rmSync(temp, { recursive: true, force: true }));

/** A transport that fails the test if anything is sent. */
const noTransport = () => {
  throw new Error("nothing may be sent");
};

describe("percentiles (nearest rank)", () => {
  test("the p-th percentile is the ceil(p/100 * n)-th smallest, always a measured value", () => {
    const twenty = Array.from({ length: 20 }, (_, k) => 20 - k); // 20 down to 1, unsorted on purpose
    assert.equal(percentile(twenty, 50), 10);
    assert.equal(percentile(twenty, 95), 19);
    assert.equal(percentile(twenty, 100), 20);
    assert.equal(percentile([50, 10, 40, 20, 30], 50), 30);
    assert.equal(percentile([50, 10, 40, 20, 30], 95), 50, "with n = 5 the p95 is the largest");
    assert.equal(percentile([1, 2, 3, 4], 50), 2);
    assert.equal(percentile([7], 95), 7);
    assert.equal(percentile([], 95), null);
    assert.equal(percentile([Number.NaN, "8", null, 3], 50), 3, "only finite numbers count");
  });

  test("a percentage outside (0, 100] is refused", () => {
    assert.throws(() => percentile([1], 0), RangeError);
    assert.throws(() => percentile([1], 101), RangeError);
  });

  test("summary gives n, min, p50, p95 and max, null with no values", () => {
    assert.deepEqual(summary([300, 100, 200]), { n: 3, min: 100, p50: 200, p95: 300, max: 300 });
    assert.deepEqual(summary([]), { n: 0, min: null, p50: null, p95: null, max: null });
  });

  test("cells group rows in the given order, count flags and summarise the warm rows apart", () => {
    const rows = [
      { key: "b", ms: 10, warm: true, slow: false },
      { key: "a", ms: 30, warm: false, slow: true },
      { key: "a", ms: 20, warm: true, slow: false },
      { key: "c", ms: 5, warm: true, slow: false },
    ];
    const got = cells(rows, (row) => row.key, {
      order: ["b", "a"],
      flags: { slow: (row) => row.slow },
      warm: (row) => row.warm,
    });
    assert.deepEqual(
      got.map((cell) => [cell.key, cell.n, cell.p50, cell.p95, cell.slow, cell.warm.n, cell.warm.p95]),
      [
        ["b", 1, 10, 10, 0, 1, 10],
        ["a", 2, 20, 30, 1, 1, 20],
        ["c", 1, 5, 5, 0, 1, 5],
      ],
    );
  });
});

describe("arch 04's budgets and Q-41's reply path", () => {
  test("the page's own sums are Q-41's: about 12.5 s, about 18.5 s with a re-read, more with a rewrite", () => {
    assert.equal(pageBudgetPath({ reread: false, rewrite: false }).totalMs, 12_650);
    assert.equal(pageBudgetPath({ rewrite: false }).totalMs, 18_650);
    assert.equal(pageBudgetPath().totalMs, 21_650);
  });

  test("the measured path adds the model stages to the fixed stages at their budgets", () => {
    const path = replyPath({ decide: 3000, reread: 4000, compose: 2000, rewrite: 2500 });
    assert.equal(path.fixedMs, 3000 + 150 + 200 + 300 + 1000);
    assert.equal(path.modelMs, 11_500);
    assert.equal(path.totalMs, 16_150);
    const noSearch = replyPath(
      { decide: 3000, reread: 4000, compose: 2000, rewrite: 2500 },
      { search: false },
    );
    assert.equal(noSearch.totalMs, 15_950);
  });

  test("a stage not measured leaves the total unknown and is named", () => {
    const path = replyPath({ decide: 3000, reread: null, compose: 2000, rewrite: 2500 });
    assert.equal(path.totalMs, null);
    assert.deepEqual(path.missing, ["reread"]);
  });

  test("each model stage's timeout is twice its upper budget, the safety read's 2 s (arch 04 line 231)", () => {
    for (const stage of ["decide", "reread", "write"]) {
      assert.equal(BUDGETS[stage].timeoutMs, 2 * BUDGETS[stage].upper);
    }
    assert.equal(BUDGETS.safetyRead.timeoutMs, 2000);
  });
});

describe("read times from a unit's spans", () => {
  const row = (purpose, model, at, ms, extra = {}) => ({
    purpose,
    model,
    at: new Date(Date.parse("2026-10-19T14:05:00.000Z") + at).toISOString(),
    ms,
    outcome: "ok",
    tokens: { input: 10, cachedRead: 500, cacheWrite: 0, output: 20 },
    injected: false,
    capped: false,
    ...extra,
  });

  test("a read runs from its first call's start to its last call's end, on the model that ended it", () => {
    const reads = readTimes([
      row("decideFirst", "claude-haiku-5-5", 0, 900),
      row("decideFirst", "claude-haiku-5-5", 905, 700),
      row("decideCheck", "claude-haiku-5-5", 2, 1000),
      row("decideCheck", "claude-haiku-5-5", 1004, 1200, {
        tokens: { input: 10, cachedRead: 0, cacheWrite: 500, output: 20 },
      }),
    ]);
    const first = reads.find((read) => read.purpose === "decideFirst");
    const check = reads.find((read) => read.purpose === "decideCheck");
    assert.equal(first.ms, 1605);
    assert.equal(first.warm, true);
    assert.equal(check.ms, 2202);
    assert.equal(check.cold, true);
    assert.equal(check.warm, false);
  });

  test("a call answered here as a fallback on purpose stays in the read's time but not in its cache state", () => {
    const [read] = readTimes([
      row("safetyRead", "claude-haiku-5-5", 0, 1, { injected: true, outcome: "failed", tokens: {} }),
      row("safetyRead", "claude-sonnet-5-5", 1, 1400),
    ]);
    assert.equal(read.ms, 1401);
    assert.equal(read.model, "claude-sonnet-5-5");
    assert.equal(read.warm, true);
  });

  test("a timed-out call has no usage: its read is not warm", () => {
    const [read] = readTimes([
      row("safetyRead", "claude-haiku-5-5", 0, 2000, { outcome: "timedOut", tokens: {} }),
    ]);
    assert.equal(read.warm, false);
    assert.equal(read.cold, false);
  });
});

describe("the one way out (wire.mjs)", () => {
  const body = (model) => JSON.stringify({ model, messages: [{ role: "user", content: "fiction" }] });
  const init = (model) => ({
    method: "POST",
    headers: { "x-api-key": DRY_KEY, "anthropic-version": "2026-10-21" },
    body: body(model),
  });
  const answer = () =>
    new Response(JSON.stringify({ stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 2 } }), {
      status: 200,
    });

  test("a dry run's transport is 127.0.0.1 alone; a live run's, Anthropic's endpoint alone", () => {
    const base = { transport: noTransport, limit: 40 };
    assert.throws(() => createWire({ ...base, mode: "dry", transportUrl: API_URL }), /127\.0\.0\.1/u);
    assert.throws(() => createWire({ ...base, mode: "dry", transportUrl: "http://10.0.0.5:80/v1/messages" }));
    assert.throws(() =>
      createWire({ ...base, mode: "live", transportUrl: "http://127.0.0.1:9/v1/messages" }),
    );
    assert.doesNotThrow(() => createWire({ ...base, mode: "live", transportUrl: API_URL }));
  });

  test("a call to any other endpoint is refused before anything is sent", async () => {
    const wire = createWire({
      mode: "dry",
      transport: noTransport,
      transportUrl: "http://127.0.0.1:9/v1/messages",
      limit: 40,
    });
    await assert.rejects(wire.fetch("https://example.invalid/v1/messages", init("claude-haiku-5-5")));
    assert.equal(wire.sent(), 0);
  });

  test("a model the unit injects is answered here as overloaded: not sent, not counted", async () => {
    const wire = createWire({
      mode: "dry",
      transport: noTransport,
      transportUrl: "http://127.0.0.1:9/v1/messages",
      limit: 40,
    });
    wire.setUnit({ unit: "u-1", kind: "safety-sonnet", inject: ["claude-haiku-5-5"] });
    const response = await wire.fetch(API_URL, init("claude-haiku-5-5"));
    assert.equal(response.status, INJECTED_STATUS);
    assert.equal(wire.sent(), 0);
    assert.equal(wire.records()[0].local, "injected");
  });

  test("past the cap a call is answered here and never sent, counting the calls earlier runs made", async () => {
    let sent = 0;
    const wire = createWire({
      mode: "live",
      transport: () => {
        sent += 1;
        return Promise.resolve(answer());
      },
      transportUrl: API_URL,
      limit: 3,
      already: 1,
    });
    assert.equal((await wire.fetch(API_URL, init("claude-haiku-5-5"))).status, 200);
    assert.equal((await wire.fetch(API_URL, init("claude-haiku-5-5"))).status, 200);
    assert.equal((await wire.fetch(API_URL, init("claude-haiku-5-5"))).status, CAPPED_STATUS);
    assert.equal(sent, 2);
    assert.equal(wire.left(), 0);
    assert.deepEqual(
      wire.records().map((record) => [record.n ?? null, record.status, record.local ?? null]),
      [
        [2, 200, null],
        [3, 200, null],
        [null, CAPPED_STATUS, "capped"],
      ],
    );
  });

  test("each call is timed to its last byte, and a record holds labels and counts, never a header", async () => {
    const wire = createWire({
      mode: "dry",
      transport: () => new Promise((resolve) => setTimeout(() => resolve(answer()), 60)),
      transportUrl: "http://127.0.0.1:9/v1/messages",
      limit: 40,
      classify: () => "safety",
    });
    wire.setUnit({ unit: "u-2", kind: "safety-haiku" });
    await wire.fetch(API_URL, init("claude-haiku-5-5"));
    const [record] = wire.records();
    assert.ok(record.wireMs >= 55, `timed ${String(record.wireMs)} ms for a 60 ms answer`);
    assert.equal(record.call, "safety");
    assert.equal(record.stop, "end_turn");
    assert.deepEqual(record.tokens, { input: 4, cachedRead: null, cacheWrite: null, output: 2 });
    assert.ok(!JSON.stringify(record).includes(DRY_KEY));
    assert.ok(!JSON.stringify(record).includes("fiction"));
  });

  test("the caller's abort signal is not passed on: a call the stage gave up on still gets its time", async () => {
    let seenSignal;
    const wire = createWire({
      mode: "dry",
      transport: (_url, options) => {
        seenSignal = options.signal;
        return new Promise((resolve) => setTimeout(() => resolve(answer()), 80));
      },
      transportUrl: "http://127.0.0.1:9/v1/messages",
      limit: 40,
    });
    const controller = new AbortController();
    const pending = wire.fetch(API_URL, { ...init("claude-haiku-5-5"), signal: controller.signal });
    controller.abort();
    assert.notEqual(seenSignal, controller.signal);
    assert.equal(seenSignal.aborted, false);
    assert.equal((await pending).status, 200);
    await wire.settle(1000);
    assert.ok(wire.records()[0].wireMs >= 75);
  });
});

describe("a whole run", () => {
  let production;
  before(async () => {
    production = await loadProduction();
  });

  test("the plan is 35 calls in rounds, 5 under the card's cap of 40", () => {
    assert.equal(plannedCalls(), 35);
    assert.equal(CALL_LIMIT, 40);
    const units = schedule();
    assert.equal(
      units.length,
      PLAN.reduce((sum, [, count]) => sum + count, 0),
    );
    assert.deepEqual(
      units.slice(0, 8).map((unit) => unit.kind),
      PLAN.map(([kind]) => kind),
      "the first round takes one unit of each kind",
    );
  });

  test("a dry run walks every unit through the production readers, and its times hold the stub's delays", async () => {
    const out = join(temp, "dry");
    const lines = [];
    const delays = { safety: 20, step1: 40, step2: 30, compose: 25, rewrite: 35 };
    const code = await main({
      argv: ["--dry-run", "--out", out],
      write: (line) => lines.push(line),
      delays,
      env: {},
    });
    assert.equal(code, 0, lines.join("\n"));
    const results = JSON.parse(readFileSync(join(out, "dry-run.json"), "utf8"));
    assert.equal(results.mode, "dry");
    assert.equal(results.units.length, schedule().length);
    assert.equal(results.callsMade, 35);
    assert.equal(
      results.answeredHere.injected,
      3 + 2 * 2,
      "three safety reads' Haiku tries, two composes' two",
    );
    assert.ok(results.units.every((unit) => ["verdict", "decided", "ok"].includes(unit.status)));
    for (const unit of results.units) {
      for (const read of unit.reads) {
        assert.ok(read.ms <= unit.wallMs + 1, `${unit.unit}: a read inside its unit`);
        if (read.stage === "decide" || read.stage === "re-read")
          assert.ok(read.ms >= delays.step1 + delays.step2 - 2, `${unit.unit}: step 1 then step 2`);
      }
      if (unit.kind === "decide-pair") {
        assert.equal(unit.reads.length, 2, "two reads side by side");
        assert.ok(unit.wallMs >= Math.max(...unit.reads.map((read) => read.ms)) - 1);
      }
    }
    const sonnetSafety = results.calls.filter((row) => row.kind === "safety-sonnet" && !row.injected);
    assert.ok(sonnetSafety.every((row) => row.model === "claude-sonnet-5-5" && row.ms >= delays.safety - 2));
    const composeSonnet = results.calls.filter((row) => row.kind === "compose-sonnet" && !row.injected);
    assert.ok(composeSonnet.every((row) => row.model === "claude-sonnet-5-5" && row.attempt === 3));
    const text = readFileSync(join(out, "dry-run.json"), "utf8") + lines.join("\n");
    assert.ok(!text.includes(DRY_KEY), "no key in the results or the output");
    for (const word of ["Barbershop", "barbershop", "Avery", "kinds of work"])
      assert.ok(!text.includes(word), `no message word (${word}) in the results or the output`);
    assert.match(lines.join("\n"), /Decide stage: two Haiku reads side by side/u);
    assert.equal(lines.at(-1), "dry run: passed");
  });

  test("a live-mode run goes to Anthropic's endpoint alone, writes its results file and prints its tables, once", async () => {
    const key = "TEST-KEY-NOT-REAL-FOR-THE-SPIKE-TEST";
    const classify = classifier(production);
    const answers = fixtureAnswers(production, composerCases(production));
    const seen = new Set();
    let calls = 0;
    const transport = async (url, options) => {
      assert.equal(url, API_URL);
      assert.equal(options.headers["x-api-key"], key);
      calls += 1;
      const found = answerFor(options.body, classify, answers);
      assert.notEqual(found, null);
      const cold = !seen.has(found.kind);
      seen.add(found.kind);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(
        JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(found.output) }],
          usage: {
            input_tokens: 30,
            output_tokens: 40,
            cache_read_input_tokens: cold ? 0 : 900,
            cache_creation_input_tokens: cold ? 900 : 0,
          },
        }),
        { status: 200 },
      );
    };
    const runsDir = join(temp, "runs");
    const stdin = [`${key}\n`];
    const lines = [];
    const code = await main({
      argv: ["--live"],
      stdin,
      write: (line) => lines.push(line),
      env: {},
      transport,
      runsDir,
    });
    assert.equal(code, 0, lines.join("\n"));
    assert.equal(calls, 35);
    assert.equal(liveCallsLogged(runsDir), 35);
    const [file] = readdirSync(runsDir);
    const written = readFileSync(join(runsDir, file), "utf8");
    assert.ok(
      !written.includes(key) && !lines.join("\n").includes(key),
      "the key is never written or printed",
    );
    const results = JSON.parse(written);
    assert.equal(results.mode, "live");
    const wentOut = results.wire.filter((record) => record.local === undefined);
    assert.equal(wentOut.length, 35);
    assert.ok(wentOut.every((record) => record.status === 200 && record.wireMs >= 4));
    assert.deepEqual(
      results.wire.filter((record) => record.local !== undefined).map((record) => record.local),
      Array.from({ length: 7 }, () => "injected"),
      "the Haiku calls of the fallbacks on purpose, answered here, are listed apart",
    );
    const coldCalls = results.calls.filter((row) => row.tokens.cacheWrite > 0).length;
    assert.equal(coldCalls, seen.size, "the stand-in wrote the cache on each kind's first call alone");
    const printed = lines.join("\n");
    assert.match(printed, /\*\*Each stage as a turn runs it\*\*/u);
    assert.match(printed, /\*\*Q-41\*\*/u);
    assert.match(printed, /\*\*DL-836\*\*/u);
    const prettier = await import("prettier");
    const options = (await prettier.resolveConfig(join(HERE, "FINDINGS.md"))) ?? {};
    const block = await formatMarkdown(renderRun(results));
    assert.ok(await prettier.check(block, { ...options, parser: "markdown" }), "the tables print formatted");
    assert.ok(printed.includes(block.trimEnd()), "the printed tables are the results file's");
    assert.ok(
      await prettier.check(written, { ...options, parser: "json" }),
      "the results file is written formatted",
    );

    const again = [];
    const refused = await main({
      argv: ["--live"],
      stdin: [`${key}\n`],
      write: (line) => again.push(line),
      env: {},
      transport: noTransport,
      runsDir,
    });
    assert.equal(refused, 2, "a second full run would pass the cap of 40");
    assert.match(again.join("\n"), /logged 35 calls/u);
  });
});

describe("refusals before anything is read or sent", () => {
  test("a command line it does not take is misuse, and no argument is echoed", async () => {
    assert.equal(parseArgs(["--live", "--out", "x"]), null);
    assert.deepEqual(parseArgs(["--dry-run", "--out", "x"]), { mode: "dry", out: "x" });
    const lines = [];
    assert.equal(await main({ argv: ["--fast-and-loose"], write: (line) => lines.push(line), env: {} }), 2);
    assert.ok(!lines.join("\n").includes("fast-and-loose"));
  });

  test("with CI set, neither mode runs", async () => {
    for (const argv of [["--dry-run"], ["--live"]]) {
      const lines = [];
      const code = await main({
        argv,
        stdin: ["SOME-KEY-VALUE-0000\n"],
        write: (line) => lines.push(line),
        env: { CI: "true" },
        transport: noTransport,
      });
      assert.equal(code, 2);
      assert.match(lines.join("\n"), /CI is set/u);
    }
  });

  test("a live run with no key is refused", async () => {
    const lines = [];
    const code = await main({
      argv: ["--live"],
      stdin: ["\n"],
      write: (line) => lines.push(line),
      env: {},
      transport: noTransport,
    });
    assert.equal(code, 2);
    assert.match(lines.join("\n"), /no ANTHROPIC_API_KEY/u);
  });

  test("a live run is refused when earlier runs logged too many calls, or a results file cannot be read", async () => {
    const runsDir = join(temp, "full");
    mkdirSync(runsDir, { recursive: true });
    const wire = Array.from({ length: 6 }, (_, k) => ({ n: k + 1, status: 200, wireMs: 900 }));
    writeFileSync(join(runsDir, "live-earlier.json"), JSON.stringify({ wire }));
    assert.equal(liveCallsLogged(runsDir), 6);
    const lines = [];
    const args = {
      argv: ["--live"],
      write: (line) => lines.push(line),
      env: {},
      transport: noTransport,
      runsDir,
    };
    assert.equal(await main({ ...args, stdin: ["SOME-KEY-VALUE-0000\n"] }), 2);
    assert.match(lines.join("\n"), /logged 6 calls; this run plans 35/u);
    writeFileSync(join(runsDir, "live-broken.json"), "{ not json");
    assert.equal(await main({ ...args, stdin: ["SOME-KEY-VALUE-0000\n"] }), 2);
    assert.match(lines.at(-1), /cannot be read/u);
  });
});

describe("staging's spans (staging-spans.mjs)", () => {
  const TRACE = "0f0f0f0f-0000-4000-8000-000000000001";
  const span = (seq, purpose, model, at, ms, extra = {}) => ({
    level: "info",
    msg: "span",
    trace_id: TRACE,
    span_id: `${TRACE}:${String(seq).padStart(2, "0")}`,
    seq,
    hop: "portCall",
    at,
    ms,
    provider: "anthropic",
    call: "messages",
    attempt: 1,
    model_calls: [
      {
        model,
        purpose,
        ms,
        outcome: extra.outcome ?? "ok",
        cached_tokens: extra.cacheWrite ? 0 : 3000,
        cache_write_tokens: extra.cacheWrite ?? 0,
      },
    ],
    error_code: null,
    version: extra.version ?? "c244c38ec02183c52f3094edbf47d15c59612ce2",
    ...(extra.provider && { provider: extra.provider }),
  });
  const event = (spans) =>
    JSON.stringify(
      { outcome: "ok", logs: spans.map((one) => ({ message: [JSON.stringify(one)] })) },
      null,
      2,
    );

  test("each model call of the version once, decide's two steps joined into one read, labels and times alone", () => {
    const capture = [
      event([
        span(1, "safetyRead", "claude-haiku-5-5", "2026-11-15T18:00:00.000Z", 2000, { outcome: "timedOut" }),
        span(2, "safetyRead", "claude-haiku-5-5", "2026-11-15T18:00:30.000Z", 950),
        span(3, "decideFirst", "claude-haiku-5-5", "2026-11-15T18:01:00.000Z", 1500, { cacheWrite: 800 }),
      ]),
      event([
        span(3, "decideFirst", "claude-haiku-5-5", "2026-11-15T18:01:00.000Z", 1500, { cacheWrite: 800 }),
        span(4, "decideFirst", "claude-haiku-5-5", "2026-11-15T18:01:01.505Z", 1200),
        span(5, "safetyRead", "claude-haiku-5-5", "2026-11-15T18:02:00.000Z", 700, { version: "19f574a0" }),
        span(6, "safetyRead", "claude-haiku-5-5", "2026-11-15T18:03:00.000Z", 10, { provider: "linq" }),
      ]),
    ].join("\n");
    const rows = modelCallRows(spansOf(capture));
    assert.equal(rows.length, 4, "the repeated span once; the other version and provider left out");
    const reads = decideReads(rows);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].ms, 2705);
    assert.equal(reads[0].warm, false, "its step 1 wrote the cache");
    const text = renderStaging(rows);
    assert.match(
      text,
      /\| safetyRead · haiku-5-5 \| 2 \| 950 ms \| 2,000 ms \| 2,000 ms \| 1 \| 950 ms \| 950 ms \| 0 \| 1 \| 0 \|/u,
    );
    assert.match(text, /\| decideFirst · haiku-5-5 \| 1 \| 2,705 ms /u);
    assert.ok(!text.includes(TRACE), "no trace id is printed");
  });

  test("its command line", () => {
    assert.deepEqual(stagingArgs(["capture.txt"]), {
      capture: "capture.txt",
      version: "c244c38",
      since: null,
    });
    assert.deepEqual(stagingArgs(["capture.txt", "--version", "19f574a"]), {
      capture: "capture.txt",
      version: "19f574a",
      since: null,
    });
    assert.equal(stagingArgs(["--since", "x"]), null);
    assert.equal(stagingArgs(["capture.txt", "--version", "not hex"]), null);
  });
});

describe("the folder and the tables", () => {
  test("no file in the folder holds a phone number but a 555-01xx fiction one", () => {
    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(HERE);
    const phone = /(?<![\d.])(?:\+?1[ .-]?)?\(?(\d{3})\)?[ .-]?(\d{3})[ .-]?(\d{4})(?![\d.])/gu;
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(phone)) {
        const fiction = match[2] === "555" && match[3].startsWith("01");
        assert.ok(fiction, `${file.slice(HERE.length + 1)} holds a number that is not fiction`);
      }
    }
  });

  test("renderRun names every stage row and both of Q-41's questions for any results", () => {
    const results = {
      mode: "dry",
      startedAt: "2026-10-19T14:05:00.000Z",
      endedAt: "2026-10-19T14:06:00.000Z",
      callsMade: 0,
      callsBefore: 0,
      limit: 40,
      answeredHere: { injected: 0, capped: 0 },
      bundle: { hash: "a".repeat(64), build: 2, promptVersions: { safetyRead: "safety-read-1" } },
      units: [],
      calls: [],
      wire: [],
    };
    const text = renderRun(results);
    assert.match(text, /Decide stage: two Haiku reads side by side/u);
    assert.match(text, /not measured/u);
  });
});
