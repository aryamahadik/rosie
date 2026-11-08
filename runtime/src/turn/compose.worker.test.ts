// The turn loop's second half (T-252), run inside the Workers runtime against fixture fakes: after the commit, each
// outbox row composed in parallel (K-09 v1 composeInput, the composer, K-09 v1 finalizeMessage with at most one rewrite),
// an email copy taking its text row's plan through K-05 v1 writePlan with no composer call, a fixed line's row never
// composed, and the dispatcher woken once per committed turn. The composer (T-373), the finalize call (T-313) and
// write-a-plan (T-196) are ports answered from the frozen fixtures (compose-input-s1-02.json, finalize-pass.json,
// finalize-rewrite.json, finalize-passed-on.json, plan-email-copy.json and the K-03 plans and final parts they reuse); the
// code under test (composeCommitted, and the turn loop that runs it after its commit) runs for real. Test values only:
// the master's sample cast and the fixtures' ids; phones in the fictional 555-01xx range (rule 9).
import { afterEach, describe, expect, it } from "vitest";

import buildFrontierS102 from "../../../contracts/tool-api/fixtures/build-frontier-s1-02.json";
import commitS102 from "../../../contracts/tool-api/fixtures/commit-s1-02.json";
import composeInputS102 from "../../../contracts/tool-api/fixtures/compose-input-s1-02.json";
import finalizePass from "../../../contracts/tool-api/fixtures/finalize-pass.json";
import finalizePassedOn from "../../../contracts/tool-api/fixtures/finalize-passed-on.json";
import finalizeRewrite from "../../../contracts/tool-api/fixtures/finalize-rewrite.json";
import safetyOutcomeHold from "../../../contracts/tool-api/fixtures/safety-outcome-hold.json";
import stopRecorded from "../../../contracts/tool-api/fixtures/stop-recorded.json";
import finalTwoSends from "../../../contracts/message-plan/fixtures/final-two-sends.json";
import planConfirmationA614 from "../../../contracts/message-plan/fixtures/plan-confirmation-a6-14.json";
import planEmailCopy from "../../../contracts/message-plan/fixtures/plan-email-copy.json";
import planS102 from "../../../contracts/message-plan/fixtures/plan-s1-02.json";
import decideS102 from "../../../contracts/model/fixtures/decide-s1-02-choose.json";
import { BUNDLE_A, WHOLE_A } from "../bundle/test-support";
import { fakeKeyStore } from "../gateway/test-support";
import { setGuardDeps, setReplyDeps } from "../guard";
import { fakeCore as fakeReplyCore, phone } from "../guard/replies/test-support";
import { fakeTargets } from "../guard/test-support";
import { openTrace, spanProblems, type Span } from "../trace";
import {
  composeCommitted,
  runTurnLoop,
  setTurnDeps,
  turnReplyCore,
  type ComposeReport,
  type TurnOutcome,
} from "./index";
import {
  BEN,
  ONE_COMPOSE,
  ONE_REWRITE,
  SAM,
  SAM_S1_02_TARGETS,
  checkedManifest,
  decided,
  fakeDecide,
  fakeFacts,
  fakeReply,
  fakeTurnFace,
  planned,
  safetyNoFor,
  storedText,
  targetsAnswer,
  testTurn,
  turnDeps,
  unplannedRow,
  until,
  type FakeDecide,
  type FakeReply,
  type FakeTurnFace,
  type TestTurn,
  type TextSpec,
} from "./test-support";
import type {
  ComposeInput,
  CoreResult,
  FinalizeMessageAnswer,
  FinalizeMessageRequest,
  FinalParts,
  GateAndCommitRequest,
  GateCommitted,
  TurnCaller,
  TurnParty,
} from "./types";

const keys = fakeKeyStore();
const restores: (() => void)[] = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

// ---- the second half on a committed answer -----------------------------------------------------------------------

interface Second {
  readonly face: FakeTurnFace;
  readonly reply: FakeReply;
  /** Every call of the turn face, the composer, the rows and the dispatcher, in order. */
  readonly log: string[];
  readonly spans: Span[];
  run(): Promise<ComposeReport>;
}

interface SecondSpec {
  caller: TurnCaller;
  handleId: string;
  /** The rows the commit wrote, in commit order. */
  outboxRows: string[];
  /** The commit's core results (K-09 v1 coreResult), in order. */
  core?: unknown[];
  /** The rows T-267's replies wrote words into in this run. */
  wordsWritten?: string[];
  repeated?: boolean;
}

/** A committed answer for the caller's turn with these rows and core results (K-09 v1 gateAndCommit.committed). */
function committedAnswer(spec: SecondSpec): GateCommitted {
  const turnId = spec.caller.turnId;
  return {
    result: "committed",
    turnId,
    committedAt: "2026-10-23T13:00:02Z",
    repeated: spec.repeated ?? false,
    parts: [],
    planner: null,
    core: (spec.core ?? []) as CoreResult[],
    written: {
      written: [],
      outboxRows: spec.outboxRows.map((id, index) => ({ id, commitSeq: index + 1 })),
      promoted: [],
    },
    effects: [],
    openQuestions: { opened: [], closed: [] },
  };
}

/** The second half's doubles for one committed turn, and its run over them (composeCommitted, for real). */
function secondHalf(spec: SecondSpec): Second {
  const face = fakeTurnFace();
  const reply = fakeReply(face.log);
  const set = turnDeps(fakeFacts(null, []), face, fakeDecide(face.log), keys, reply);
  const spans: Span[] = [];
  let clock = Date.parse("2026-10-23T13:00:02Z");
  const trace = openTrace({
    openedBy: "textWebhook",
    bundleId: BUNDLE_A,
    sink: (span) => spans.push(span),
    now: () => (clock += 5),
  });
  trace.setTurn(spec.caller.turnId);
  return {
    face,
    reply,
    log: face.log,
    spans,
    run: () =>
      composeCommitted({
        set,
        turnId: spec.caller.turnId,
        handleId: spec.handleId,
        caller: spec.caller,
        trace,
        answer: committedAnswer(spec),
        wordsWritten: spec.wordsWritten ?? [],
      }),
  };
}

const ALL_CHECKS = [
  "fixedLines",
  "values",
  "oneQuestion",
  "neverInMessage",
  "shape",
  "lengthAndReading",
  "format",
];

/**
 * finalizeMessage's send for a request (every check passed, the final parts written with the plan), as the action layer
 * answers it: these final parts, or the plan's own lines put together when none are given (test words only).
 */
function sentAnswer(request: FinalizeMessageRequest, finalParts?: FinalParts): FinalizeMessageAnswer {
  const { plan } = request.plan;
  const words = [...plan.lines.map((line) => line.text), plan.question?.text ?? ""].filter(
    (line) => line !== "",
  );
  const parts: FinalParts = finalParts ?? {
    row: request.outboxRowId,
    channel: request.plan.channel,
    sends: [{ kind: "words", text: words.join("\n"), calendarFile: "none", options: [], link: null }],
    fixedLines: [],
    slotValues: [],
    threadReplyTo: null,
  };
  return {
    outcome: "send",
    checks: [
      {
        row: request.outboxRowId,
        attempt: request.attempt,
        checked: parts,
        checks: ALL_CHECKS.map((check) => ({ check, passed: true, detail: null })),
        outcome: "send",
        questionWithdrawn: false,
        teamPaged: false,
      },
    ],
    finalParts: parts,
    questionWithdrawn: false,
    teamPageId: null,
  };
}

// ---- the fixtures' turns -------------------------------------------------------------------------------------------

/** S1-01: Sam's first text committed turn-s1-01-sam with S1-02's question as one row (compose-input-s1-02.json). */
const S1_01_CALLER = composeInputS102.request.caller as TurnCaller;
const S1_02_ROW = composeInputS102.request.outboxRowId;

/** A7-17: Riley is out on Alex's day; Alex's text row (finalize-rewrite.json, finalize-passed-on.json). */
const A7_17_CALLER = finalizeRewrite.request.caller as TurnCaller;
const A7_17_ROW = finalizeRewrite.request.outboxRowId;

/**
 * A7-17's composer input for Alex's text row: the master line the fallback of finalize-passed-on.json fills, the facts
 * its checks name (pro.name, name.staff, day, visit.time), Alex as a customer on iMessage, a problem tag (arch 07 line
 * 357). No inbound text: the row tells Alex of Riley's news.
 */
const A7_17_INPUT: ComposeInput = {
  row: A7_17_ROW,
  turn: A7_17_CALLER.turnId,
  conversation: [],
  masterText: {
    step: "A7-17",
    text: "Sorry, {{pro.name}} can't be in on {{day}}. {{name.staff}} can come in early to do your visit, same time and price. Please reply by {{ask.by}}.",
  },
  facts: [
    { slot: "pro.name", value: "Riley" },
    { slot: "name.staff", value: "Avery" },
    { slot: "day", value: "Sat Oct 24" },
    { slot: "visit.time", value: "11:00am" },
  ],
  audience: { role: "customer", name: "Alex", way: "texts", handlingLine: null },
  language: "en",
  channel: "imessage",
  situation: "problem",
  allowedFormats: ["text"],
  allowedLinks: [],
  options: [],
  pageTypes: [],
  openQuestions: [],
  inbound: null,
};

/** A6-14: Alex's booking with Riley confirmed: the text to Alex, its email copy, and a note to Riley (staff). */
const A6_14_CALLER: TurnCaller = {
  kind: "turn",
  turnId: "turn-a6-14-alex-booked",
  requestId: "turn-a6-14-alex-booked",
  businessId: "biz-lees-barbershop",
  personId: "person-alex",
  traceId: "trace-alex-0614",
};
const A6_14_TEXT = finalTwoSends.row;
const A6_14_EMAIL = planEmailCopy.row;
const A6_14_RILEY = "outbox-a6-14-riley-text";

/** A6-14's composer input for Alex's confirmation: its master line, the facts final-two-sends.json fills, Alex's way. */
const A6_14_ALEX_INPUT: ComposeInput = {
  row: A6_14_TEXT,
  turn: A6_14_CALLER.turnId,
  conversation: [],
  masterText: {
    step: "A6-14",
    text: "You're booked at {{biz.name}}. Give this code at the chair when you arrive: {{visit.code}}",
  },
  facts: structuredClone(finalTwoSends.slotValues),
  audience: { role: "customer", name: "Alex", way: "texts", handlingLine: null },
  language: "en",
  channel: "imessage",
  situation: "routine",
  allowedFormats: ["text", "calendarFile", "linkCard"],
  allowedLinks: ["link.secure"],
  options: [],
  pageTypes: [],
  openQuestions: [],
  inbound: null,
};

/** The note to Riley about the same booking (test words for its master line), to staff, text only. */
const A6_14_RILEY_INPUT: ComposeInput = {
  ...structuredClone(A6_14_ALEX_INPUT),
  row: A6_14_RILEY,
  masterText: { step: "A6-14", text: "New booking: {{svc.intext}} · {{day}} · {{visit.time}}" },
  audience: { role: "staff", name: "Riley", way: "texts", handlingLine: null },
  allowedFormats: ["text"],
  allowedLinks: [],
};

const RILEY_PLAN = {
  formats: ["text"],
  lines: [{ role: "first", text: "New booking: {{svc.intext}} · {{day}} · {{visit.time}}" }],
  question: null,
  pageType: null,
  threadReplyTo: null,
};

const inputs = new Map<string, ComposeInput>([
  [A6_14_TEXT, A6_14_ALEX_INPUT],
  [A6_14_RILEY, A6_14_RILEY_INPUT],
]);

/** The failed checks finalize-rewrite.json names, with their details: what the one rewrite is told. */
const REWRITE_TOLD = finalizeRewrite.outcome.checks[0]?.checks
  .filter((check) => !check.passed)
  .map((check) => ({ check: check.check, detail: check.detail }));

describe("each row composed after the commit: compose input, the composer, finalize", () => {
  it("a row's compose input, the composer's plan and finalize: the requests are compose-input-s1-02.json's and finalize-pass.json's, and finalize writes the final parts with the plan", async () => {
    const s = secondHalf({ caller: S1_01_CALLER, handleId: "handle-sam", outboxRows: [S1_02_ROW] });
    s.reply.rows.unplanned = () => ({ result: "rows", rows: [unplannedRow(S1_02_ROW, 1, "handle-sam")] });
    s.face.composeInput = () => structuredClone(composeInputS102.outcome) as never;
    s.reply.composer.compose = () => planned(planS102);
    s.face.finalize = () => structuredClone(finalizePass.outcome) as never;

    const report = await s.run();

    expect(s.face.composeInputCalls).toEqual([composeInputS102.request]);
    expect(s.reply.composer.composeCalls).toEqual([composeInputS102.outcome.input]);
    expect(s.face.finalizeCalls).toEqual([finalizePass.request]);
    expect(s.reply.composer.rewriteCalls).toEqual([]);
    // finalizeMessage wrote the final parts with the plan (K-09 v1): the turn writes no plan of its own for the row.
    expect(s.reply.rows.writes).toEqual([]);
    expect(report.rows).toEqual([
      {
        outboxRowId: S1_02_ROW,
        result: "send",
        copyOf: null,
        composerCalls: 1,
        rewrite: false,
        finalizeCalls: 1,
        finalParts: finalizePass.outcome.finalParts,
        questionWithdrawn: false,
        teamPageId: null,
        errorCode: null,
      },
    ]);
    expect(s.log).toEqual([
      "unplannedRows",
      `composeInput:${S1_02_ROW}`,
      `compose:${S1_02_ROW}`,
      `compose:${S1_02_ROW}:answered`,
      `finalize:composed:${S1_02_ROW}`,
      "wake",
    ]);
  });

  it("two outbox rows are composed in parallel: both composer calls start before either ends", async () => {
    const s = secondHalf({
      caller: A6_14_CALLER,
      handleId: "handle-alex",
      outboxRows: [A6_14_TEXT, A6_14_RILEY],
    });
    s.reply.rows.unplanned = () => ({
      result: "rows",
      rows: [unplannedRow(A6_14_TEXT, 1, "handle-alex"), unplannedRow(A6_14_RILEY, 2, "handle-riley")],
    });
    s.face.composeInput = (request) => {
      const input = inputs.get(request.outboxRowId);
      return input === undefined ? { error: "notFound" } : { result: "compose", input };
    };
    const started: string[] = [];
    s.reply.composer.compose = async (input) => {
      started.push(input.row);
      // Each composer call waits for the other to start; one that waits alone (one row at a time) gives up after 1 s and
      // answers anyway, so the order below shows it.
      await until(() => started.length === 2, "both composer calls to start", 1000).catch(() => undefined);
      return planned(input.row === A6_14_TEXT ? planConfirmationA614 : RILEY_PLAN);
    };
    s.face.finalize = (request) => sentAnswer(request);

    const report = await s.run();

    const composerLog = s.log.filter((line) => line.startsWith("compose:"));
    expect(composerLog.slice(0, 2).sort()).toEqual([`compose:${A6_14_TEXT}`, `compose:${A6_14_RILEY}`]);
    expect(composerLog.slice(2).sort()).toEqual([
      `compose:${A6_14_TEXT}:answered`,
      `compose:${A6_14_RILEY}:answered`,
    ]);
    expect(report.rows.map((row) => [row.outboxRowId, row.result, row.composerCalls])).toEqual([
      [A6_14_TEXT, "send", 1],
      [A6_14_RILEY, "send", 1],
    ]);
    expect(s.face.finalizeCalls.map((request) => request.outboxRowId).sort()).toEqual([
      A6_14_TEXT,
      A6_14_RILEY,
    ]);
    expect(s.reply.dispatcher.wakes).toHaveLength(1);
  });
});

describe("finalize with at most one rewrite, then the fallback, then the passed-on line (K-09 v1)", () => {
  /** A7-17's row: the composed plan fails Values (finalize-rewrite.json); the one rewrite, then finalize again. */
  function a7_17(second: (request: FinalizeMessageRequest) => FinalizeMessageAnswer): Second {
    const s = secondHalf({ caller: A7_17_CALLER, handleId: "handle-alex", outboxRows: [A7_17_ROW] });
    s.reply.rows.unplanned = () => ({ result: "rows", rows: [unplannedRow(A7_17_ROW, 1, "handle-alex")] });
    s.face.composeInput = () => ({ result: "compose", input: A7_17_INPUT });
    s.reply.composer.compose = () => planned(finalizeRewrite.request.plan.plan);
    s.reply.composer.rewrite = () => planned(finalizePassedOn.request.plan.plan, ONE_REWRITE);
    s.face.finalize = (request) =>
      request.attempt === "composed" ? (structuredClone(finalizeRewrite.outcome) as never) : second(request);
    return s;
  }

  it("finalize-rewrite.json gives exactly one rewrite call, told only each failed check and its detail; finalize then takes the rewrite (finalize-passed-on.json's request)", async () => {
    const s = a7_17(() => structuredClone(finalizePassedOn.outcome) as never);

    const report = await s.run();

    expect(s.reply.composer.composeCalls).toEqual([A7_17_INPUT]);
    expect(s.reply.composer.rewriteCalls).toEqual([
      { input: A7_17_INPUT, plan: finalizeRewrite.request.plan.plan, failed: REWRITE_TOLD },
    ]);
    expect(REWRITE_TOLD).toEqual([{ check: "values", detail: expect.any(String) as string }]);
    // Never the checked final parts, whose slot values the composer never got (K-09 finalizeMessage.response.checks).
    expect(JSON.stringify(s.reply.composer.rewriteCalls)).not.toContain("slotValues");
    expect(s.face.finalizeCalls).toEqual([finalizeRewrite.request, finalizePassedOn.request]);
    expect(report.rows[0]).toMatchObject({ composerCalls: 2, rewrite: true, finalizeCalls: 2 });
    expect(s.log).toEqual([
      "unplannedRows",
      `composeInput:${A7_17_ROW}`,
      `compose:${A7_17_ROW}`,
      `compose:${A7_17_ROW}:answered`,
      `finalize:composed:${A7_17_ROW}`,
      `rewrite:${A7_17_ROW}`,
      `rewrite:${A7_17_ROW}:answered`,
      `finalize:rewrite:${A7_17_ROW}`,
      "wake",
    ]);
  });

  it("never a second rewrite: a rewrite finalize answers 'rewrite' again (not K-09's) and the row is left with no plan", async () => {
    const s = a7_17(() => structuredClone(finalizeRewrite.outcome) as never);

    const report = await s.run();

    expect(s.reply.composer.rewriteCalls).toHaveLength(1);
    expect(s.face.finalizeCalls.map((request) => request.attempt)).toEqual(["composed", "rewrite"]);
    expect(report.rows).toEqual([
      expect.objectContaining({
        outboxRowId: A7_17_ROW,
        result: "left",
        errorCode: "badAnswer",
        finalParts: null,
      }),
    ]);
    expect(s.reply.dispatcher.wakes).toHaveLength(1);
  });

  it("finalize-passed-on.json stores the passed-on line and no clock: the row holds the passed-on line, its question withdrawn and the team paged, and nothing more is called for it", async () => {
    const s = a7_17(() => structuredClone(finalizePassedOn.outcome) as never);

    const report = await s.run();

    expect(report.rows).toEqual([
      {
        outboxRowId: A7_17_ROW,
        result: "passedOn",
        copyOf: null,
        composerCalls: 2,
        rewrite: true,
        finalizeCalls: 2,
        finalParts: finalizePassedOn.outcome.finalParts,
        questionWithdrawn: true,
        teamPageId: "page-alex-a7-17-passed-on",
        errorCode: null,
      },
    ]);
    expect(report.rows[0]?.finalParts?.fixedLines).toEqual(["passedOn"]);
    // The fallback ran inside the one finalize call (default 11): no third finalize, no fallback of the turn's own, and
    // the turn writes nothing over what finalize stored (no writePlan); no clock arms for a withdrawn question.
    expect(s.face.finalizeCalls).toHaveLength(2);
    expect(s.reply.rows.writes).toEqual([]);
    expect(s.log.filter((line) => line.includes("clock"))).toEqual([]);
    const rewrite = s.spans.find((span) => span.hop === "rewriteOrFallback");
    expect(rewrite?.decided).toMatchObject({
      outcome: "passedOn",
      fallback: true,
      fallbackFailed: ["values"],
      fixedLines: ["passedOn"],
      questionWithdrawn: true,
      teamPaged: true,
    });
  });

  it("records compose, fillAndChecks and rewriteOrFallback spans with labels, counts and ids only: never a plan's words, a check's detail or a slot's value", async () => {
    const s = a7_17(() => structuredClone(finalizePassedOn.outcome) as never);

    await s.run();

    expect(s.spans.map((span) => span.hop)).toEqual(["compose", "fillAndChecks", "rewriteOrFallback"]);
    for (const span of s.spans) {
      expect(spanProblems(span)).toEqual([]);
      expect(span.bundle_id).toEqual(BUNDLE_A);
      expect(span.turn_id).toBe(A7_17_CALLER.turnId);
      expect(span.business_id).toBe("biz-lees-barbershop");
    }
    const [compose, checks, rewrite] = s.spans;
    expect(compose).toMatchObject({ outcome: "ok", model_calls: ONE_COMPOSE });
    expect(compose?.got).toEqual({
      row: A7_17_ROW,
      channel: "imessage",
      situation: "problem",
      allowedFormats: ["text"],
      facts: 4,
      options: 0,
      inbound: false,
    });
    expect(compose?.decided).toEqual({ formats: ["text"], lines: 1, question: false, optionIds: 0 });
    expect(checks).toMatchObject({ outcome: "refused", rows: [] });
    expect(checks?.decided).toMatchObject({ outcome: "rewrite", failed: ["values"], fallback: false });
    expect(rewrite).toMatchObject({
      outcome: "ok",
      model_calls: ONE_REWRITE,
      rows: [{ table: "outbox_rows", id: A7_17_ROW }],
    });
    expect(rewrite?.got).toEqual({
      row: A7_17_ROW,
      attempt: "rewrite",
      told: ["values"],
      planned: true,
      calls: 1,
    });
    const logged = JSON.stringify(s.spans);
    for (const words of [
      "Riley can't be in",
      "10:30am",
      "11:00am",
      "Sat Oct 24",
      "Avery",
      "passed this on",
      "code-supplied",
      "{{",
    ]) {
      expect(logged).not.toContain(words);
    }
  });
});

describe("an email copy takes its text row's plan (plan-email-copy.json)", () => {
  function a6_14(): Second {
    const s = secondHalf({
      caller: A6_14_CALLER,
      handleId: "handle-alex",
      outboxRows: [A6_14_TEXT, A6_14_EMAIL],
    });
    s.reply.rows.unplanned = () => ({
      result: "rows",
      rows: [
        unplannedRow(A6_14_TEXT, 1, "handle-alex"),
        unplannedRow(A6_14_EMAIL, 2, "handle-alex-email", "email", A6_14_TEXT),
      ],
    });
    s.face.composeInput = (request) =>
      request.outboxRowId === A6_14_EMAIL
        ? { result: "emailCopy", textRowId: A6_14_TEXT }
        : { result: "compose", input: A6_14_ALEX_INPUT };
    s.reply.composer.compose = () => planned(planConfirmationA614);
    s.face.finalize = (request) => sentAnswer(request, structuredClone(finalTwoSends) as FinalParts);
    return s;
  }

  it("an email copy row makes no composer call and no finalize call, and stores its text row's plan (plan-email-copy.json) with its text row's final parts", async () => {
    const s = a6_14();

    const report = await s.run();

    expect(s.reply.composer.composeCalls.map((input) => input.row)).toEqual([A6_14_TEXT]);
    expect(s.face.finalizeCalls.map((request) => request.outboxRowId)).toEqual([A6_14_TEXT]);
    expect(s.reply.rows.writes).toEqual([
      {
        outboxRowId: A6_14_EMAIL,
        expectVersion: 1,
        plan: planEmailCopy,
        finalParts: { ...finalTwoSends, row: A6_14_EMAIL, channel: "email" },
      },
    ]);
    expect(report.rows.map((row) => [row.outboxRowId, row.result, row.copyOf, row.composerCalls])).toEqual([
      [A6_14_TEXT, "send", null, 1],
      [A6_14_EMAIL, "copied", A6_14_TEXT, 0],
    ]);
    // The copy waits for its text row's final parts, then writes; the dispatcher is woken once, after both.
    expect(s.log.indexOf(`writePlan:${A6_14_EMAIL}`)).toBeGreaterThan(
      s.log.indexOf(`finalize:composed:${A6_14_TEXT}`),
    );
    expect(s.log.at(-1)).toBe("wake");
    expect(s.reply.dispatcher.wakes).toEqual([
      { turnId: A6_14_CALLER.turnId, handleId: "handle-alex", outboxRowIds: [A6_14_TEXT, A6_14_EMAIL] },
    ]);
    const copy = s.spans.find((span) => span.got?.copyOf === A6_14_TEXT);
    expect(copy).toMatchObject({ hop: "fillAndChecks", outcome: "ok", decided: { result: "copied" } });
    expect(spanProblems(copy)).toEqual([]);
    expect(JSON.stringify(s.spans)).not.toContain("Lee's Barbershop");
  });

  it("a copy whose text row is left gets nothing: no composer call, no plan written, the row stays to be composed later", async () => {
    const s = a6_14();
    s.reply.composer.compose = () => ({ error: "modelsDown" });

    const report = await s.run();

    expect(s.reply.composer.composeCalls.map((input) => input.row)).toEqual([A6_14_TEXT]);
    expect(s.reply.rows.writes).toEqual([]);
    expect(report.rows.map((row) => [row.outboxRowId, row.result, row.errorCode])).toEqual([
      [A6_14_TEXT, "left", "modelsDown"],
      [A6_14_EMAIL, "left", "noTextPlan"],
    ]);
  });

  it("a row the Tool API and the row's own copyOfRowId disagree on is left: never composed, never copied", async () => {
    const s = a6_14();
    // K-05 says the email row copies the text row; compose input offers a composer input for it instead.
    s.face.composeInput = (request) => ({
      result: "compose",
      input: { ...A6_14_ALEX_INPUT, row: request.outboxRowId },
    });

    const report = await s.run();

    expect(s.reply.composer.composeCalls.map((input) => input.row)).toEqual([A6_14_TEXT]);
    expect(s.reply.rows.writes).toEqual([]);
    expect(report.rows.find((row) => row.outboxRowId === A6_14_EMAIL)).toMatchObject({
      result: "left",
      errorCode: "copyMismatch",
    });
  });
});

describe("a fixed line's row is never composed (T-267's replies write its words by code)", () => {
  it("rows the commit names for a fixed line (a STOP's reply, a business told, HELP's reply, a safety line) are skipped even with no words yet; only the others are composed", async () => {
    const stop = structuredClone(stopRecorded.outcome.core[1]) as unknown as {
      response: { businessesTold?: unknown[] };
    };
    // K-09 v1.1: the STOP also tells each business with an open booking for that phone (README default 50).
    stop.response.businessesTold = [
      {
        businessId: "biz-lees-barbershop",
        fixedLineId: "textsOffReachTheirWay",
        outboxRowId: "out-ben-stop-told-lees",
      },
    ];
    const help = {
      call: "sendFixedLine",
      response: { outboxRowId: "out-ben-help", repeated: false },
      error: null,
    };
    const safety = { call: "recordSafetyOutcome", response: safetyOutcomeHold.outcome, error: null };
    const fixed = ["out-ben-stop-reply", "out-ben-stop-told-lees", "out-ben-help", "out-alex-threat-line"];
    const caller = stopRecorded.request.caller as TurnCaller;
    const s = secondHalf({
      caller,
      handleId: "handle-ben",
      outboxRows: [...fixed, "out-ben-routine"],
      core: [stopRecorded.outcome.core[0], stop, help, safety],
    });
    s.reply.rows.unplanned = () => ({
      result: "rows",
      rows: [...fixed, "out-ben-routine"].map((id, index) => unplannedRow(id, index + 1, "handle-ben")),
    });
    s.face.composeInput = (request) => ({
      result: "compose",
      input: { ...A6_14_ALEX_INPUT, row: request.outboxRowId, turn: caller.turnId },
    });
    s.reply.composer.compose = () => planned(RILEY_PLAN);
    s.face.finalize = (request) => sentAnswer(request);

    const report = await s.run();

    expect(s.face.composeInputCalls.map((request) => request.outboxRowId)).toEqual(["out-ben-routine"]);
    expect(s.reply.composer.composeCalls.map((input) => input.row)).toEqual(["out-ben-routine"]);
    expect(report.fixedLineRows).toEqual(fixed);
    expect(report.rows.map((row) => row.outboxRowId)).toEqual(["out-ben-routine"]);
    expect(s.reply.dispatcher.wakes[0]?.outboxRowIds).toEqual([...fixed, "out-ben-routine"]);
  });

  it("a row the replies wrote words into in this run is never composed, though no core result names it", async () => {
    const s = secondHalf({
      caller: S1_01_CALLER,
      handleId: "handle-sam",
      outboxRows: ["out-sam-help-words"],
      wordsWritten: ["out-sam-help-words"],
    });
    s.reply.rows.unplanned = () => ({
      result: "rows",
      rows: [unplannedRow("out-sam-help-words", 1, "handle-sam")],
    });

    const report = await s.run();

    expect(s.face.composeInputCalls).toEqual([]);
    expect(report).toMatchObject({ rows: [], fixedLineRows: ["out-sam-help-words"], woken: true });
  });
});

describe("what a row ends with when a call fails (fails closed)", () => {
  it("a compose input answered transient and a finalize answer lost on its way are each sent once more, as the same request", async () => {
    const s = secondHalf({ caller: S1_01_CALLER, handleId: "handle-sam", outboxRows: [S1_02_ROW] });
    s.reply.rows.unplanned = () => ({ result: "rows", rows: [unplannedRow(S1_02_ROW, 1, "handle-sam")] });
    let asked = 0;
    s.face.composeInput = () =>
      (asked += 1) === 1
        ? { error: "transient", sqlstate: "40001" }
        : (structuredClone(composeInputS102.outcome) as never);
    s.reply.composer.compose = () => planned(planS102);
    let finalized = 0;
    s.face.finalize = () => {
      if ((finalized += 1) === 1) throw new Error("the answer was lost");
      return structuredClone(finalizePass.outcome) as never;
    };

    const report = await s.run();

    expect(s.face.composeInputCalls).toEqual([composeInputS102.request, composeInputS102.request]);
    expect(s.face.finalizeCalls).toEqual([finalizePass.request, finalizePass.request]);
    expect(s.reply.composer.composeCalls).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ result: "send", finalizeCalls: 2, errorCode: null });
  });

  it("a row that holds a plan already (alreadyPlanned) is not composed again; a closed row is not composed", async () => {
    const s = secondHalf({
      caller: A6_14_CALLER,
      handleId: "handle-alex",
      outboxRows: [A6_14_TEXT, A6_14_RILEY],
    });
    s.reply.rows.unplanned = () => ({
      result: "rows",
      rows: [unplannedRow(A6_14_TEXT, 1, "handle-alex"), unplannedRow(A6_14_RILEY, 2, "handle-riley")],
    });
    s.face.composeInput = (request) =>
      request.outboxRowId === A6_14_TEXT
        ? { error: "alreadyPlanned", outboxRowId: A6_14_TEXT }
        : { error: "rowClosed", outboxRowId: A6_14_RILEY, state: "withdrawn" };

    const report = await s.run();

    expect(s.reply.composer.composeCalls).toEqual([]);
    expect(s.face.finalizeCalls).toEqual([]);
    expect(report.rows.map((row) => [row.result, row.errorCode])).toEqual([
      ["planned", "alreadyPlanned"],
      ["closed", "rowClosed"],
    ]);
    expect(report.woken).toBe(true);
  });

  it("the turn's rows cannot be read (transient twice): nothing is composed, and the dispatcher is still woken once", async () => {
    const s = secondHalf({ caller: S1_01_CALLER, handleId: "handle-sam", outboxRows: [S1_02_ROW] });
    s.reply.rows.unplanned = () => ({ error: "transient", sqlstate: "40001" });

    const report = await s.run();

    expect(s.reply.rows.unplannedReads).toHaveLength(2);
    expect(s.face.composeInputCalls).toEqual([]);
    expect(report).toMatchObject({ rows: [], rowsError: "transient", woken: true });
    expect(s.reply.dispatcher.wakes).toHaveLength(1);
  });

  it("a composer that gives no plan, and an input for another row, leave the row with no plan and no finalize call", async () => {
    const s = secondHalf({
      caller: A6_14_CALLER,
      handleId: "handle-alex",
      outboxRows: [A6_14_TEXT, A6_14_RILEY],
    });
    s.reply.rows.unplanned = () => ({
      result: "rows",
      rows: [unplannedRow(A6_14_TEXT, 1, "handle-alex"), unplannedRow(A6_14_RILEY, 2, "handle-riley")],
    });
    // Compose input answers Alex's input for both rows: the one it gives for Riley's row names another row.
    s.face.composeInput = () => ({ result: "compose", input: A6_14_ALEX_INPUT });
    s.reply.composer.compose = () => {
      throw new Error("the composer is not reached");
    };

    const report = await s.run();

    expect(s.reply.composer.composeCalls.map((input) => input.row)).toEqual([A6_14_TEXT]);
    expect(s.face.finalizeCalls).toEqual([]);
    expect(report.rows.map((row) => [row.outboxRowId, row.result, row.errorCode])).toEqual([
      [A6_14_TEXT, "left", "noAnswer"],
      [A6_14_RILEY, "left", "badAnswer"],
    ]);
  });
});

// ---- the turn as the lease runs it: commit, then compose, then one wake ------------------------------------------------

interface Party {
  handle: (typeof SAM)["handle"];
  party: TurnParty;
}

interface Setup {
  t: TestTurn;
  face: FakeTurnFace;
  ai: FakeDecide;
  reply: FakeReply;
}

/** One run's doubles, as the first half's tests set them (turn.worker.test.ts), with the second half's sharing one log. */
async function setUp(spec: {
  who: Party;
  turnId: string;
  traceId: string;
  texts: Omit<TextSpec, "traceId">[];
  times: string[];
  targets?: Parameters<typeof targetsAnswer>[1];
}): Promise<Setup> {
  const entries = await Promise.all(
    spec.texts.map((text, index) =>
      storedText({ ...text, traceId: spec.traceId }, spec.who.handle, keys, BUNDLE_A, index + 1),
    ),
  );
  const t = testTurn({
    turnId: spec.turnId,
    traceId: spec.traceId,
    bundleId: BUNDLE_A,
    manifest: await checkedManifest(WHOLE_A, BUNDLE_A),
    entries,
  });
  const face = fakeTurnFace();
  const ai = fakeDecide(face.log);
  const reply = fakeReply(face.log);
  const facts = fakeFacts(spec.who.party, spec.times);
  for (const text of spec.texts) facts.safety.set(text.eventId, safetyNoFor(text.eventId));
  restores.push(setTurnDeps(turnDeps(facts, face, ai, keys, reply)));
  const targets = fakeTargets();
  targets.answers.set(
    spec.who.party.handleId,
    targetsAnswer(
      spec.who.party.handleId,
      spec.targets ?? { roles: [], openQuestionIds: [], bookingIds: [] },
    ),
  );
  restores.push(setGuardDeps({ targets: targets.port }));
  return { t, face, ai, reply };
}

function committed(outcome: TurnOutcome): Extract<TurnOutcome, { result: "committed" }> {
  if (outcome.result !== "committed") throw new Error(`the turn did not commit: ${outcome.why}`);
  return outcome;
}

const S1_02_TEXT = {
  eventId: "evt-sam-0001",
  body: "Barbershop, plumbing, electrical",
  sentAt: "2026-10-19T14:05:00Z",
};
const S1_04_ROW = commitS102.outcome.written.outboxRows[0]?.id ?? "out-s1-04-sam";

/** S1-04's composer input for Sam's row after S1-02 (test words for its master line), as compose input would give it. */
const S1_04_INPUT: ComposeInput = {
  ...structuredClone(composeInputS102.outcome.input),
  row: S1_04_ROW,
  turn: commitS102.request.turn.id,
  masterText: { step: "S1-04", text: "What company names do you work under?" },
  inbound: { text: S1_02_TEXT.body, sentAt: { utc: S1_02_TEXT.sentAt, zone: "America/New_York" } },
};

describe("the dispatcher is woken once per committed turn", () => {
  async function s1_02(): Promise<Setup> {
    const setup = await setUp({
      who: SAM,
      turnId: "turn-s1-02-sam-kinds",
      traceId: "trace-sam-0001",
      texts: [S1_02_TEXT],
      times: [buildFrontierS102.request.now, commitS102.request.now],
      targets: SAM_S1_02_TARGETS,
    });
    const { face, ai, reply } = setup;
    face.frontier = () => structuredClone(buildFrontierS102.outcome);
    ai.decide = () => decided(decideS102);
    face.gate = () => structuredClone(commitS102.outcome) as never;
    reply.rows.unplanned = () => ({ result: "rows", rows: [unplannedRow(S1_04_ROW, 1, "handle-sam")] });
    face.composeInput = () => ({ result: "compose", input: S1_04_INPUT });
    reply.composer.compose = () =>
      planned({
        formats: ["text"],
        lines: [],
        question: { text: "What company names do you work under?", optionIds: [] },
        pageType: null,
        threadReplyTo: null,
      });
    face.finalize = (request) => sentAnswer(request);
    return setup;
  }

  it("after the commit the turn's rows are composed under the commit's caller, then the dispatcher is woken once", async () => {
    const { t, face, reply } = await s1_02();

    const outcome = committed(await runTurnLoop(t.turn));

    expect(face.log).toEqual([
      "frontier",
      "decide",
      "gate",
      "gate:answered",
      "unplannedRows",
      `composeInput:${S1_04_ROW}`,
      `compose:${S1_04_ROW}`,
      `compose:${S1_04_ROW}:answered`,
      `finalize:composed:${S1_04_ROW}`,
      "wake",
    ]);
    expect(reply.dispatcher.wakes).toEqual([
      { turnId: "turn-s1-02-sam-kinds", handleId: "handle-sam", outboxRowIds: [S1_04_ROW] },
    ]);
    expect(face.composeInputCalls).toEqual([{ caller: commitS102.request.caller, outboxRowId: S1_04_ROW }]);
    expect(face.finalizeCalls[0]).toMatchObject({
      caller: commitS102.request.caller,
      outboxRowId: S1_04_ROW,
      expectVersion: 1,
      attempt: "composed",
      plan: { row: S1_04_ROW, channel: "imessage", copyOf: null },
    });
    expect(outcome.composed).toMatchObject({
      rows: [{ outboxRowId: S1_04_ROW, result: "send" }],
      woken: true,
    });
    expect(t.spans.map((span) => span.hop)).toEqual([
      "guard",
      "frontier",
      "decideReads",
      "gate",
      "commit",
      "compose",
      "fillAndChecks",
    ]);
    for (const span of t.spans) expect(spanProblems(span)).toEqual([]);
  });

  it("an answer lost on its way and sent again is still one committed turn: one compose, one wake", async () => {
    const { t, face, reply } = await s1_02();
    face.loseGate.add(0);

    const outcome = committed(await runTurnLoop(t.turn));

    expect(outcome.gateCalls).toBe(2);
    expect(reply.composer.composeCalls).toHaveLength(1);
    expect(reply.dispatcher.wakes).toHaveLength(1);
  });

  it("a run that does not commit composes nothing and wakes no one", async () => {
    const { t, face, reply } = await s1_02();
    face.frontier = () => ({ error: "transient", sqlstate: "40001" });

    const outcome = await runTurnLoop(t.turn);

    expect(outcome).toMatchObject({ result: "notCommitted", why: "transient" });
    expect(reply.rows.unplannedReads).toEqual([]);
    expect(face.composeInputCalls).toEqual([]);
    expect(reply.dispatcher.wakes).toEqual([]);
  });

  it("a run that is no longer the turn's when it commits (a lapse's rerun has the turn) composes nothing and wakes no one", async () => {
    const { t, face, reply } = await s1_02();
    face.gate = () => {
      t.abort();
      return structuredClone(commitS102.outcome) as never;
    };

    const outcome = committed(await runTurnLoop(t.turn));

    expect(outcome.composed).toBeNull();
    expect(reply.rows.unplannedReads).toEqual([]);
    expect(reply.dispatcher.wakes).toEqual([]);
  });

  it("a keyword turn's HELP reply with no words (no number to give) is a fixed line's row: never composed, and the dispatcher is woken once", async () => {
    const setup = await setUp({
      who: BEN,
      turnId: "turn-ben-help",
      traceId: "trace-ben-0009",
      texts: [{ eventId: "evt-ben-0009", body: "HELP", sentAt: "2026-10-21T19:40:00Z" }],
      times: ["2026-10-21T19:40:02Z"],
    });
    const { t, face, reply } = setup;
    const core = fakeReplyCore("2026-10-21T19:40:02Z", [
      phone("+15555550131", "handle-ben", "person-ben", 3),
    ]);
    face.gate = async (request: GateAndCommitRequest) => {
      const records = request.core.filter((action) => action.call === "recordSafetyOutcome");
      const answer = await core.core.commitCore({
        caller: request.caller as never,
        actions: request.core.slice(records.length) as never,
      });
      if ("error" in answer) return answer;
      return {
        result: "committed",
        turnId: request.turn.id,
        committedAt: request.now,
        repeated: answer.repeated,
        parts: [],
        planner: null,
        core: [...records.map(() => stopRecorded.outcome.core[0]), ...answer.core],
        written: {
          written: [],
          outboxRows: [...core.outbox.values()].map((row) => ({ id: row.id, commitSeq: row.commitSeq })),
          promoted: [],
        },
        effects: [],
        openQuestions: { opened: [], closed: [] },
      } as never;
    };
    reply.rows.unplanned = (turnId) => ({
      result: "rows",
      rows: [...core.outbox.values()]
        .filter((row) => row.turnId === turnId && row.plan === null)
        .map((row) => unplannedRow(row.id, row.commitSeq, row.recipientHandleId, row.channel)),
    });
    // Rosie's number left blank: HELP's reply has no number to give, so its words are not written (T-267).
    restores.push(setReplyDeps({ core: turnReplyCore, rows: core.rows, rosieNumber: "" }));

    const outcome = committed(await runTurnLoop(t.turn));

    const [helpRow] = [...core.outbox.keys()];
    expect(outcome.replies?.replies.map((entry) => [entry.outcome, entry.line, entry.errorCode])).toEqual([
      ["noWords", "helpReply", "noWords"],
    ]);
    expect(core.outbox.get(helpRow ?? "")?.plan).toBeNull();
    expect(face.composeInputCalls).toEqual([]);
    expect(reply.composer.composeCalls).toEqual([]);
    expect(outcome.composed).toMatchObject({ rows: [], fixedLineRows: [helpRow], woken: true });
    expect(reply.dispatcher.wakes).toEqual([
      { turnId: "turn-ben-help", handleId: "handle-ben", outboxRowIds: [helpRow] },
    ]);
  });
});
