// T-1505: an asked part sends the turn's one open question again, once (K-09 v1.12 defaults 192 to 198; K-05 v1.21 item
// 81). gateAndCommit through the Tool API base (T-290) with a recording scope, the gate's scripted limits and the commit's
// port doubles (test-support.ts), K-05 commitTurn as the in-memory fake, which holds a request that asks again to K-05
// v1.21's schema; the question read is a double over the stored row K-09's commit-s1-02-asked.json rests on
// (commit-s1-01.json's S1-02 question, open at version 2, asked once). The conditions the base's validator cannot carry
// (an unmapped end, a planner verb, a question no ask may name) are checked on askAgainUnit itself, which the commit runs
// as it is. The PostgreSQL proof is actions/src/tool-api/turn-face/pg/sign-up.int.test.ts.
//
// T-1528 (K-09 README default 201 and open gap 179; DL-1133): a passed choose whose split's settler answers "ask" takes
// the same path. End to end, the commit's writesOf is the real walk (walk/writes.ts createWritesOf) on bundle v0's S1-02
// (the asked fixture's pin) with a stand-in settler, never a double of the walk or of the commit: the request is K-05's
// commit-s1-02-sam-asks-again.json, byte for byte as decide's own ask gives it, and a second "ask" (ask count 2) writes
// nothing, as T-1505's second miss. Default 192 (a) and (c) with the walk's note are checked on askAgainUnit itself.

import { describe, expect, it } from "vitest";

import { callContext, copy, gateExchange, scriptedLimits, wordsIn } from "../gate/framework/test-support";
import type { DecidePart, Decided, GatedPart, GateRequest } from "../gate/framework";
import { createToolApi, createToolApiValidator } from "../tool-api";
import { contractFile, recordingHandlers, recordingScope, traceFor } from "../tool-api/test-support";
import { askAgainUnit, type AskedTurn } from "./ask-again";
import { asksAgain, buildCommitRequest, type CommitUnit, type TurnCommitRequest } from "./build";
import { CommitRefusedError, gateAndCommit } from "./index";
import { WalkRefusedError, createWritesOf, type StepSettler } from "./walk";
import { SETTLER_ASKS, noteSettlerAsked } from "./walk/settle";
import { skeletonBundles } from "./walk/test-support";
import {
  contractChecks,
  doublePorts,
  eventLogRowsOf,
  k05Fake,
  noWrites,
  type Doubles,
  type K05Fake,
} from "./test-support";
import type {
  AskAgainDeps,
  AskAgainWrongState,
  CommitDeps,
  CommitTurnContext,
  CommitTurnError,
  CommitTurnResponse,
  CoreResult,
  CoreRun,
  GateAndCommitRequest,
  LiveQuestion,
  SafetyHold,
  UnitWrites,
} from "./types";

const validator = createToolApiValidator();

/** K-09 v1.12's accepted fixture: Sam's "A bit of everything", asked about S1-02's one open question. */
const ASKED = "commit-s1-02-asked.json";
/** K-05 v1.21's accepted fixture: the same turn as K-05 commits it (README item 81). */
const K05_ASKS_AGAIN = "data-access/fixtures/commit-s1-02-sam-asks-again.json";

const QUESTION = "oq-s1-02-sam-1";
const ROW = "outbox-s1-02-sam-asked-1";
const HANDLE = "handle-sam";
const BUSINESS = "biz-lees-barbershop";

function fail(): never {
  throw new Error("fixture missing a value");
}

/** commit-s1-02-asked.json, freshly parsed. */
function askedExchange(): ReturnType<typeof gateExchange> {
  return gateExchange(ASKED);
}

/** Its request, a fresh copy. */
function askedRequest(): GateAndCommitRequest {
  return copy(askedExchange().request);
}

/** The decided pair a request carries. */
function decidedIn(request: GateAndCommitRequest): Decided {
  return request.input.kind === "decided" ? request.input.decided : fail();
}

/** Its committed outcome, as K-09 v1.12 states it. */
function askedOutcome(): Extract<ReturnType<typeof gateExchange>["outcome"], { result: "committed" }> {
  const { outcome } = askedExchange();
  if (!("result" in outcome) || outcome.result !== "committed") return fail();
  return outcome;
}

/** Sam's text's safety outcome (No) as the fixture answers it, run with nothing in the commit's lists. */
function askedCoreResult(): CoreResult {
  return askedOutcome().core[0] ?? fail();
}

function askedCoreRun(result: CoreResult = askedCoreResult()): CoreRun {
  return { result, writes: noWrites({ step: "A3-22", choice: null }) };
}

/**
 * S1-02's question as the commit reads it on the call's transaction (K-05 v1.2 openQuestionRead): commit-s1-01.json's
 * stored row (no options, no read-back, about no booking, Sam's, under Lee's Barbershop), asked once, open at version 2
 * since its first delivery receipt (K-09 v1.12's fixture note).
 */
function storedQuestion(): LiveQuestion {
  const first = contractFile("tool-api/fixtures/commit-s1-01.json") as {
    given: {
      stated: {
        writes: { openQuestions: { id: string; personId: string; options: unknown[]; readback: null }[] };
      };
    };
  };
  const [opened] = first.given.stated.writes.openQuestions;
  if (opened === undefined) return fail();
  return {
    id: QUESTION,
    step: "S1-02",
    businessId: BUSINESS,
    bookingId: null,
    personId: opened.personId,
    options: [...opened.options],
    readback: opened.readback,
    askCount: 1,
    version: 2,
  };
}

/** One call of the question read. */
interface ReadCall {
  readonly handleId: string;
  readonly openQuestionId: string;
}

/** The question read as a double: the stored row while it is live (`row`, null once closed), sent to handle-sam. */
interface FakeRead {
  row: LiveQuestion | null;
  readonly calls: ReadCall[];
  readonly deps: AskAgainDeps;
}

function fakeRead(row: LiveQuestion | null = storedQuestion(), turnKey = "sam-asked"): FakeRead {
  const read: FakeRead = {
    row,
    calls: [],
    deps: {
      questions: {
        liveQuestion(_repo, handleId, openQuestionId) {
          read.calls.push({ handleId, openQuestionId });
          const found = handleId === HANDLE && read.row?.id === openQuestionId ? read.row : null;
          return Promise.resolve(found === null ? null : copy(found));
        },
      },
      turnKey: () => turnKey,
    },
  };
  return read;
}

/** The commit's deps for the asked turn: scripted limits (none runs), the doubles, and the question read. */
function askedDeps(
  read: FakeRead | null,
  doubles: Doubles = {},
): ReturnType<typeof doublePorts> & CommitDeps {
  const ported = doublePorts({ core: [askedCoreRun(), askedCoreRun(), askedCoreRun()], ...doubles });
  return {
    ...ported,
    limits: scriptedLimits(),
    ...(read === null ? {} : { askAgain: read.deps }),
  };
}

/** The K-05 fake as the asked turn's chain leaves it: the first send took commitSeq 1, at the fixture's moment. */
function askedK05(answers?: NonNullable<Parameters<typeof k05Fake>[0]>["answers"]): K05Fake {
  return k05Fake({ now: askedExchange().given.now, nextCommitSeq: 2, ...(answers ? { answers } : {}) });
}

/** One gateAndCommit call through the Tool API base, its handler the commit with `deps`. */
async function callCommit(request: unknown, deps: CommitDeps): Promise<{ answer: unknown; rows: unknown }> {
  const scope = recordingScope();
  const handlers = recordingHandlers("gateAndCommit", (given, context) =>
    gateAndCommit(given as GateRequest, context, deps),
  );
  const api = createToolApi({ validator, scope, handlers });
  const { trace, spans } = traceFor(request);
  const answer = await api.call("gateAndCommit", request, trace);
  return { answer, rows: spans[0]?.rows };
}

/** K-05 v1.21's request for the turn, the raise at K-09's chain's version 2 (K-05's own chain reads it at 1). */
function k05AsksAgainRequest(): TurnCommitRequest {
  const { request } = contractFile(K05_ASKS_AGAIN) as { request: TurnCommitRequest };
  if (!asksAgain(request)) return fail();
  request.writes.openQuestions.askAgain[0].expectVersion = 2;
  return request;
}

/** The silent answer: the part asked, the safety outcome, nothing written of the turn's own. */
function silentOutcome(): ReturnType<typeof askedOutcome> {
  return {
    ...askedOutcome(),
    written: { written: [], outboxRows: [], promoted: [] },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The accepted case, and its rerun

describe("K-09 v1.12: an asked part sends the turn's one open question again, once, with its ask count raised (T-1505)", () => {
  it("commit-s1-02-asked.json: one K-05 v1.21 request with one quick_reply row and the raise, no close, no clock row; the answer is the fixture's outcome", async () => {
    const read = fakeRead();
    const deps = askedDeps(read, { k05: askedK05() });
    const called = await callCommit(askedRequest(), deps);

    // The answer is K-09 v1.12's outcome, held to K-09 by the base: the part asked, its row named, the question's row at
    // its version after the raise, nothing opened or closed.
    expect(called.answer).toEqual(askedOutcome());

    // One request, K-05 v1.21's with the raise: exactly K-05's own commit-s1-02-sam-asks-again.json, but for the version
    // the raise names, the one this chain read (2: its first delivery receipt opened the question).
    expect(deps.k05.requests).toHaveLength(1);
    const [request] = deps.k05.requests;
    if (request === undefined) return fail();
    expect(contractChecks().k05v121("commitTurn.request", request)).toEqual([]);
    expect(request).toEqual(k05AsksAgainRequest());
    const { writes } = request;
    expect(writes.openQuestions.open).toEqual([]);
    expect(writes.openQuestions.close).toEqual([]);
    expect(writes.clockRows).toEqual({ make: [], cancel: [] });
    expect(writes.outboxRows.map((row) => [row.id, row.sendClass, row.channel, row.openQuestionId])).toEqual([
      [ROW, "quick_reply", "imessage", QUESTION],
    ]);
    // K-05 v1.21's whole exchange, with what the fake wrote as its answer, is one its askAgainExchange takes.
    const k05Given = (contractFile(K05_ASKS_AGAIN) as { given: unknown }).given;
    const answered = askedK05Answer();
    expect(deps.k05.commits).toEqual([
      { turnId: "turn-s1-02-sam-asked", written: answered.committed.written },
    ]);
    expect(
      contractChecks().k05v121("commitTurn.askAgainExchange", {
        call: "commitTurn",
        given: k05Given,
        request,
        outcome: answered,
      }),
    ).toEqual([]);
    // Each entry as K-08 v1.1's event log takes it: the raise's open_question.asked_again, then the row's.
    const rows = eventLogRowsOf(request, "2026-10-19T18:07:04Z");
    expect(rows.map((row) => row.kind)).toEqual(["open_question.asked_again", "outbox_row.created"]);
    for (const row of rows) expect(contractChecks().k08("eventLogRow", row), String(row.id)).toEqual([]);

    // The question read once, on the turn's handle, for the one open question.
    expect(read.calls).toEqual([{ handleId: HANDLE, openQuestionId: QUESTION }]);
    // No word of the text or of decide's unclear in the request.
    const decided = decidedIn(askedRequest());
    for (const words of [...wordsIn(decided), "It names no kind of work"]) {
      expect(JSON.stringify(request)).not.toContain(words);
    }
    // The span keeps the rows written: the question and the row, tables and ids only.
    expect(called.rows).toEqual([
      { table: "open_questions", id: QUESTION },
      { table: "outbox_rows", id: ROW },
    ]);
  });

  it("a rerun reads the question at ask_count 2 and builds neither row nor raise; K-05 answers the first commit, so nothing is written twice", async () => {
    const read = fakeRead();
    const k05 = askedK05();
    const deps = askedDeps(read, { k05 });
    await callCommit(askedRequest(), deps);
    // What the first commit left: the question raised, one version on.
    read.row = { ...storedQuestion(), askCount: 2, version: 3 };

    const again = await callCommit(askedRequest(), deps);
    expect(again.answer).toEqual({
      ...askedOutcome(),
      repeated: true,
      written: { written: [], outboxRows: [{ id: ROW, commitSeq: 2 }], promoted: [] },
    });
    const second = k05.requests[1] ?? fail();
    expect(asksAgain(second as TurnCommitRequest)).toBe(false);
    expect(second.writes.outboxRows).toEqual([]);
    expect(contractChecks().k05("commitTurn.request", second)).toEqual([]);
    expect(k05.commits).toHaveLength(1);
    // The repeat's span names no row (the base leaves `rows` out of a span that wrote none: tool-api.ts).
    expect(again.rows).toBeUndefined();
  });

  it("a rerun that still reads ask_count 1 sends the same request, the same row id and raise, and K-05 answers the first commit", async () => {
    const read = fakeRead();
    const k05 = askedK05();
    const deps = askedDeps(read, { k05 });
    await callCommit(askedRequest(), deps);
    const again = await callCommit(askedRequest(), deps);
    expect(again.answer).toMatchObject({ result: "committed", repeated: true });
    expect(k05.requests[1]).toEqual(k05.requests[0]);
    expect(k05.commits).toHaveLength(1);
  });
});

/** K-05's answer to the accepted request, as the fake gives it: the question at version 3, the row at commitSeq 2. */
function askedK05Answer(): CommitTurnResponse {
  return {
    result: "committed",
    turnId: "turn-s1-02-sam-asked",
    committedAt: askedExchange().given.now,
    repeated: false,
    committed: {
      written: [{ table: "open_questions", rowId: QUESTION, version: 3 }],
      outboxRows: [{ id: ROW, commitSeq: 2 }],
      promoted: [],
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// What stays silent (default 198), end to end

/** Calls the commit and expects the silent answer: no row, no raise, a K-05 v1.17 request. */
async function expectSilent(
  request: GateAndCommitRequest,
  deps: ReturnType<typeof askedDeps>,
  outcome: unknown = silentOutcome(),
): Promise<void> {
  const called = await callCommit(request, deps);
  expect(called.answer).toEqual(outcome);
  const [sent] = deps.k05.requests;
  if (sent === undefined) return fail();
  expect(asksAgain(sent as TurnCommitRequest)).toBe(false);
  expect(sent.writes.outboxRows).toEqual([]);
  expect(sent.writes.events).toEqual([]);
  expect(contractChecks().k05("commitTurn.request", sent)).toEqual([]);
}

describe("what stays silent, as before v1.12 (default 198)", () => {
  it("asked twice (ask_count 2 before this turn): no row and no raise", async () => {
    const read = fakeRead({ ...storedQuestion(), askCount: 2, version: 3 });
    await expectSilent(askedRequest(), askedDeps(read, { k05: askedK05() }));
    expect(read.calls).toHaveLength(1);
  });

  it("asked three times or more: no row and no raise", async () => {
    const read = fakeRead({ ...storedQuestion(), askCount: 3, version: 4 });
    await expectSilent(askedRequest(), askedDeps(read, { k05: askedK05() }));
  });

  it("a read-back question, a question stored with options, a booking question, another person's, another business's: no row", async () => {
    const options = [{ id: "opt-1", label: "Yes" }];
    for (const [name, row] of [
      ["readback", { ...storedQuestion(), readback: "Sam takes the bookings." }],
      ["options", { ...storedQuestion(), options }],
      ["booking", { ...storedQuestion(), bookingId: "booking-alex-haircut" }],
      ["person", { ...storedQuestion(), personId: "person-alex" }],
      ["no person", { ...storedQuestion(), personId: null }],
      ["business", { ...storedQuestion(), businessId: "biz-yoga-studio" }],
      ["no business", { ...storedQuestion(), businessId: null }],
    ] as const) {
      const read = fakeRead(row);
      const deps = askedDeps(read, { k05: askedK05() });
      await expectSilent(askedRequest(), deps).catch((error: unknown) => {
        throw new Error(`${name}: ${String(error)}`);
      });
      expect(read.calls, name).toHaveLength(1);
    }
  });

  it("the question no longer live (the read answers none): no row", async () => {
    const read = fakeRead(null);
    await expectSilent(askedRequest(), askedDeps(read, { k05: askedK05() }));
    expect(read.calls).toHaveLength(1);
  });

  it("an open safety hold on the handle: no row, and the question is never read", async () => {
    const hold: SafetyHold = { holdId: "hold-sam-threat", releaseRule: "never", blocksBooking: true };
    const read = fakeRead();
    await expectSilent(askedRequest(), askedDeps(read, { k05: askedK05(), holds: [hold] }));
    expect(read.calls).toEqual([]);
  });

  it("an unread text of the turn: no row, and the question is never read", async () => {
    const read = fakeRead();
    await expectSilent(askedRequest(), askedDeps(read, { k05: askedK05(), unread: ["evt-sam-0003"] }));
    expect(read.calls).toEqual([]);
  });

  it("a hold the turn's own safety outcome opens: no row, and the question is never read", async () => {
    const result = copy(askedCoreResult());
    if (result.call !== "recordSafetyOutcome" || result.response === null) return fail();
    result.response.hold = { holdId: "hold-sam-0002", releaseRule: "after_safe", blocksBooking: true };
    const read = fakeRead();
    const deps = askedDeps(read, { k05: askedK05(), core: [askedCoreRun(result)] });
    const called = await callCommit(askedRequest(), deps);
    expect(called.answer).toMatchObject({ result: "committed", written: { outboxRows: [] } });
    expect(asksAgain((deps.k05.requests[0] ?? fail()) as TurnCommitRequest)).toBe(false);
    expect(read.calls).toEqual([]);
  });

  it("no service on the turn: no row, and the question is never read", async () => {
    const request = askedRequest();
    const turn = request.turn as unknown as Record<string, unknown>;
    delete turn.service;
    delete turn.chatId;
    expect(validator.check("gateAndCommit", "request", request)).toEqual([]);
    const read = fakeRead();
    await expectSilent(request, askedDeps(read, { k05: askedK05() }));
    expect(read.calls).toEqual([]);
  });

  it("two open questions in the context: no row, and neither is read", async () => {
    const request = askedRequest();
    const { context } = decidedIn(request);
    const [only] = context.openQuestions;
    if (only === undefined) return fail();
    context.openQuestions.push({ ...copy(only), openQuestionId: "oq-s1-02-sam-2" });
    const read = fakeRead();
    await expectSilent(request, askedDeps(read, { k05: askedK05() }));
    expect(read.calls).toEqual([]);
  });

  it("no question read bound (the binding hands none in): no row, as before v1.12", async () => {
    await expectSilent(askedRequest(), askedDeps(null, { k05: askedK05() }));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// K-05's refusals of the raise

describe("K-05's answers to a request that asks again", () => {
  it("wrongState for the raised question refuses the turn as wrongState, naming the question; nothing is written", async () => {
    const wrong: AskAgainWrongState = {
      error: "wrongState",
      table: "open_questions",
      rowId: QUESTION,
      state: "answered",
    };
    const deps = askedDeps(fakeRead(), { k05: askedK05([wrong]) });
    const error = await gateAndCommit(askedRequest(), callContext(BUSINESS), deps).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(CommitRefusedError);
    expect(error).toMatchObject({ fault: "wrongState", ids: [QUESTION] });
    expect(deps.k05.commits).toEqual([]);
  });

  it("versionChanged on the question reloads once: the second run reads it closed and sends nothing", async () => {
    const changed: CommitTurnError = {
      error: "versionChanged",
      changed: [{ table: "open_questions", rowId: QUESTION, readVersion: 2, currentVersion: 3 }],
    };
    const read = fakeRead();
    const deps = askedDeps(read, { k05: askedK05([changed, null]) });
    const watched: CommitDeps = {
      ...deps,
      ports: {
        ...deps.ports,
        commitTurn: async (request, call) => {
          const answer = await deps.ports.commitTurn(request, call);
          // Another turn answered the question between this turn's read and its commit.
          read.row = null;
          return answer;
        },
      },
    };
    const answer = await gateAndCommit(askedRequest(), callContext(BUSINESS), watched);
    expect(answer).toMatchObject({ result: "committed", repeated: false, written: { outboxRows: [] } });
    expect(read.calls).toHaveLength(2);
    expect(deps.k05.requests.map((request) => asksAgain(request as TurnCommitRequest))).toEqual([
      true,
      false,
    ]);
    expect(deps.k05.commits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Each condition of default 192 on askAgainUnit itself

/** The gate's answer for the fixture's one part: asked, no limit run. */
function askedGated(): GatedPart[] {
  return askedOutcome().parts.map((part) => ({
    part: part.part,
    choiceId: part.choiceId,
    result: part.result as GatedPart["result"],
    limits: part.limits,
    stoppedBy: part.stoppedBy,
    refusedBy: null,
    dependsOnPart: part.dependsOnPart,
  }));
}

/** The commit's context for a request, inside Lee's Barbershop's scope. */
function contextOf(request: GateAndCommitRequest): CommitTurnContext {
  const { turn } = request;
  if (turn === null) return fail();
  const { id, handleId, eventIds, bundleId, traceId, joinedTraceIds, tries } = turn;
  return {
    request,
    turn: { id, handleId, eventIds, bundleId, traceId, joinedTraceIds, tries },
    repo: { name: "ask-again-test-repo" },
    businessId: BUSINESS,
  };
}

/** What the commit hands askAgainUnit for the fixture's turn, with `change` applied. */
function askedTurn(change: Partial<AskedTurn> = {}, request = askedRequest()): AskedTurn {
  return {
    context: contextOf(request),
    gated: askedGated(),
    held: new Set(),
    core: [askedCoreRun()],
    open: { holds: [], unreadEventIds: [] },
    ...change,
  };
}

/** The fixture's request with its one agreed part (and each read's) changed. */
function withPart(part: DecidePart, outcome: "go" | "oneQuestion" = "go"): GateAndCommitRequest {
  const request = askedRequest();
  const decided = decidedIn(request);
  decided.decide.parts = [{ part, outcome }];
  for (const each of decided.decide.reads) each.output.parts = [copy(part)];
  return request;
}

describe("askAgainUnit: each condition of default 192", () => {
  it("all hold: one unit, no part answer, its row as default 192 states it and the raise at the version read", async () => {
    const read = fakeRead();
    const unit = await askAgainUnit(read.deps, askedTurn());
    if (unit === null) return fail();
    expect(unit.answer).toBeNull();
    const expected: UnitWrites = {
      ...noWrites({ step: "S1-02", choice: null }),
      messages: [
        {
          id: ROW,
          recipientHandleId: HANDLE,
          recipientPersonId: "person-sam",
          businessId: BUSINESS,
          bookingId: null,
          channel: "imessage",
          sendClass: "quick_reply",
          openQuestionId: QUESTION,
          copyOfRowId: null,
          versionsRead: [],
        },
      ],
      askAgain: {
        raise: { id: QUESTION, expectVersion: 2 },
        step: "S1-02",
        businessId: BUSINESS,
        askCount: 1,
      },
    };
    expect(unit.writes).toEqual(expected);
    // No ask, so no clock row is made for it, and no versions read (open gap 177).
    expect(unit.writes.asks).toEqual([]);
    expect(unit.writes.clocks).toBeUndefined();
  });

  it("the row id is default 131's: the question's step in lower case, the turn key, n 1; the turn's own id by default", async () => {
    const own = fakeRead();
    const deps: AskAgainDeps = { questions: own.deps.questions };
    const unit = await askAgainUnit(deps, askedTurn());
    expect(unit?.writes.messages.map((row) => row.id)).toEqual(["outbox-s1-02-turn-s1-02-sam-asked-1"]);
    await expect(askAgainUnit({ ...deps, turnKey: () => "" }, askedTurn())).rejects.toMatchObject({
      fault: "noTurnKey",
    });
  });

  it("no deps: nothing, nothing read", async () => {
    expect(await askAgainUnit(undefined, askedTurn())).toBeNull();
  });

  it("(a) a part that passed, waits, is stopped, depends on a stopped part or is held beside the asked part: nothing, nothing read", async () => {
    const [asked] = askedGated();
    if (asked === undefined) return fail();
    const second = (result: GatedPart["result"]): GatedPart => ({ ...asked, part: 1, result });
    for (const change of [
      { gated: [asked, second("passed")] },
      { gated: [asked, second("stopped")] },
      { gated: [asked, second("dependsOnStopped")] },
      { gated: [asked, second("noAction")], held: new Set([1]) },
      { gated: [asked], held: new Set([0]) },
      { gated: [second("noAction")] },
      { gated: [] },
    ]) {
      const read = fakeRead();
      expect(await askAgainUnit(read.deps, askedTurn(change)), JSON.stringify(change.gated)).toBeNull();
      expect(read.calls).toEqual([]);
    }
  });

  it("(a) an asked part beside a part that took no action: one unit", async () => {
    const [asked] = askedGated();
    if (asked === undefined) return fail();
    const read = fakeRead();
    const unit = await askAgainUnit(
      read.deps,
      askedTurn({ gated: [asked, { ...asked, part: 1, result: "noAction" }] }),
    );
    expect(unit?.writes.messages).toHaveLength(1);
  });

  it("(b) an unmapped end, or a planner verb: nothing, nothing read", async () => {
    const ended = askedRequest();
    (decidedIn(ended).decide as unknown as Record<string, unknown>).end = "oneQuestion";
    const planned = askedRequest();
    (planned.input as unknown as Record<string, unknown>).planner = { output: {}, parts: [0] };
    for (const request of [ended, planned]) {
      const read = fakeRead();
      expect(await askAgainUnit(read.deps, askedTurn({}, request))).toBeNull();
      expect(read.calls).toEqual([]);
    }
  });

  it("(c) no open question, or an ask naming another question: nothing, nothing read", async () => {
    const none = askedRequest();
    decidedIn(none).context.openQuestions = [];
    const other = withPart({
      verb: "ask",
      quote: "A bit of everything",
      questions: ["oq-s1-04-sam"],
      unclear: "Which kinds?",
    });
    for (const request of [none, other]) {
      const read = fakeRead();
      expect(await askAgainUnit(read.deps, askedTurn({}, request))).toBeNull();
      expect(read.calls).toEqual([]);
    }
  });

  it("(c) an ask naming no question is about the one open question: one unit", async () => {
    const request = withPart({
      verb: "ask",
      quote: "A bit of everything",
      questions: [],
      unclear: "Which kinds?",
    });
    const unit = await askAgainUnit(fakeRead().deps, askedTurn({}, request));
    expect(unit?.writes.messages).toHaveLength(1);
  });

  it("(c) a choose ended in one question on an option of the one open question: one unit; on another choice, or an enter ended in one question: nothing", async () => {
    const choose = (choice: string): DecidePart =>
      ({ verb: "choose", quote: "A bit of everything", choice, fields: [] }) as unknown as DecidePart;
    const option = await askAgainUnit(
      fakeRead().deps,
      askedTurn({}, withPart(choose("c-01"), "oneQuestion")),
    );
    expect(option?.writes.messages).toHaveLength(1);
    for (const request of [
      withPart(choose("c-04"), "oneQuestion"),
      withPart(
        { verb: "enter", quote: "A bit of everything", choice: "c-01", fields: [] } as unknown as DecidePart,
        "oneQuestion",
      ),
    ]) {
      const read = fakeRead();
      expect(await askAgainUnit(read.deps, askedTurn({}, request))).toBeNull();
      expect(read.calls).toEqual([]);
    }
  });

  it("(f) an open hold, an unread text, or a core action other than a text's safety outcome: nothing, nothing read", async () => {
    const stop = { ...askedCoreResult(), call: "recordStopOrStart" } as unknown as CoreResult;
    const hold: SafetyHold = { holdId: "hold-sam-0002", releaseRule: "after_safe", blocksBooking: true };
    for (const change of [
      { open: { holds: [hold], unreadEventIds: [] } },
      { open: { holds: [], unreadEventIds: ["evt-sam-0003"] } },
      { core: [askedCoreRun(), askedCoreRun(stop)] },
    ]) {
      const read = fakeRead();
      expect(await askAgainUnit(read.deps, askedTurn(change))).toBeNull();
      expect(read.calls).toEqual([]);
    }
    // No core action at all (a turn of texts whose safety outcomes ride elsewhere): nothing holds it back.
    expect(await askAgainUnit(fakeRead().deps, askedTurn({ core: [] }))).not.toBeNull();
  });

  it("(f) a text's safety outcome that was refused opens no hold and silences nothing: the row and the raise (defaults 192 (f) and 195)", async () => {
    const refused = {
      ...askedCoreResult(),
      response: null,
      error: { error: "notBuilt" },
    } as unknown as CoreResult;
    const read = fakeRead();
    const unit = await askAgainUnit(read.deps, askedTurn({ core: [askedCoreRun(refused)] }));
    if (unit === null) return fail();
    expect(unit.answer).toBeNull();
    expect(unit.writes.messages.map((row) => [row.id, row.sendClass, row.openQuestionId])).toEqual([
      [ROW, "quick_reply", QUESTION],
    ]);
    expect(unit.writes.askAgain).toEqual({
      raise: { id: QUESTION, expectVersion: 2 },
      step: "S1-02",
      businessId: BUSINESS,
      askCount: 1,
    });
    expect(read.calls).toEqual([{ handleId: HANDLE, openQuestionId: QUESTION }]);
    // Beside a recorded one, and under an open hold it is still held back as any turn is.
    const beside = await askAgainUnit(
      fakeRead().deps,
      askedTurn({ core: [askedCoreRun(), askedCoreRun(refused)] }),
    );
    expect(beside?.writes.messages.map((row) => row.id)).toEqual([ROW]);
    const hold: SafetyHold = { holdId: "hold-sam-0002", releaseRule: "after_safe", blocksBooking: true };
    const held = fakeRead();
    const under = askedTurn({
      core: [askedCoreRun(refused)],
      open: { holds: [hold], unreadEventIds: [] },
    });
    expect(await askAgainUnit(held.deps, under)).toBeNull();
    expect(held.calls).toEqual([]);
  });

  it("(g) the turn's service is the row's channel; none, or one K-06 does not name: nothing, nothing read", async () => {
    const sms = askedRequest();
    (sms.turn as unknown as Record<string, unknown>).service = "sms";
    const unit = await askAgainUnit(fakeRead().deps, askedTurn({}, sms));
    expect(unit?.writes.messages.map((row) => row.channel)).toEqual(["sms"]);
    const odd = askedRequest();
    (odd.turn as unknown as Record<string, unknown>).service = "fax";
    const noChat = askedRequest();
    (noChat.turn as unknown as Record<string, unknown>).chatId = null;
    const read = fakeRead();
    expect(await askAgainUnit(read.deps, askedTurn({}, odd))).toBeNull();
    expect(read.calls).toEqual([]);
    // A chat id is no condition (never textSourceOf, which throws without one).
    expect(await askAgainUnit(fakeRead().deps, askedTurn({}, noChat))).not.toBeNull();
  });

  it("(d) and (e) on the read: another id answered, or a question asked of a person the caller is not: nothing", async () => {
    const wrongId = fakeRead();
    wrongId.deps.questions.liveQuestion = () => Promise.resolve({ ...storedQuestion(), id: "oq-other" });
    expect(await askAgainUnit(wrongId.deps, askedTurn())).toBeNull();
    // A caller with no person is not the person S1-02 was asked of (person-sam).
    const nobody = askedRequest();
    (nobody.caller as unknown as Record<string, unknown>).personId = null;
    expect(await askAgainUnit(fakeRead().deps, askedTurn({}, nobody))).toBeNull();
  });

  it("(d) the question's person_id is the caller's personId, compared as they are: a caller with none whose question was stored with none gets the row and the raise", async () => {
    const nobody = askedRequest();
    (nobody.caller as unknown as Record<string, unknown>).personId = null;
    const read = fakeRead({ ...storedQuestion(), personId: null });
    const unit = await askAgainUnit(read.deps, askedTurn({}, nobody));
    if (unit === null) return fail();
    expect(unit.writes.messages).toEqual([
      {
        id: ROW,
        recipientHandleId: HANDLE,
        recipientPersonId: null,
        businessId: BUSINESS,
        bookingId: null,
        channel: "imessage",
        sendClass: "quick_reply",
        openQuestionId: QUESTION,
        copyOfRowId: null,
        versionsRead: [],
      },
    ]);
    expect(unit.writes.askAgain).toEqual({
      raise: { id: QUESTION, expectVersion: 2 },
      step: "S1-02",
      businessId: BUSINESS,
      askCount: 1,
    });
    expect(read.calls).toEqual([{ handleId: HANDLE, openQuestionId: QUESTION }]);
  });

  it("a read that fails is thrown as it is, so the call fails closed", async () => {
    const read = fakeRead();
    const failed = new Error("read failed");
    read.deps.questions.liveQuestion = () => Promise.reject(failed);
    await expect(askAgainUnit(read.deps, askedTurn())).rejects.toBe(failed);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// build.ts: one raise a request, never beside a close

describe("build.ts: the raise in K-05 v1.21's openQuestions.askAgain (default 10)", () => {
  const turnRow = (): CommitTurnContext["turn"] => contextOf(askedRequest()).turn;
  const actor = { personId: "person-sam", roleAt: () => null };

  it("a request with no raise has no askAgain key, as before", () => {
    const request = buildCommitRequest({
      turn: turnRow(),
      zone: "America/New_York",
      businessId: BUSINESS,
      actor,
      units: [{ writes: noWrites({ step: "S1-02", choice: null }), answer: null }],
    });
    expect(asksAgain(request)).toBe(false);
    expect(Object.keys(request.writes.openQuestions)).toEqual(["open", "close"]);
  });

  it("a second raise, or a raise beside a close, is refused (askAgainNotAlone) before anything is sent", async () => {
    const unit = (await askAgainUnit(fakeRead().deps, askedTurn())) ?? fail();
    const other: CommitUnit = {
      writes: {
        ...unit.writes,
        messages: [],
        askAgain: { ...(unit.writes.askAgain ?? fail()), raise: { id: "oq-s1-04-sam", expectVersion: 1 } },
      },
      answer: null,
    };
    const closing: CommitUnit = {
      writes: {
        ...noWrites({ step: "S1-04", choice: null }),
        closes: [{ id: "oq-s1-04-sam", expectVersion: 1, status: "withdrawn", answeredOptionId: null }],
      },
      answer: null,
    };
    for (const units of [
      [unit, other],
      [closing, unit],
    ]) {
      let thrown: unknown = null;
      try {
        buildCommitRequest({ turn: turnRow(), zone: null, businessId: BUSINESS, actor, units });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CommitRefusedError);
      expect(thrown).toMatchObject({ fault: "askAgainNotAlone" });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T-1528: a split settler's "ask" takes the re-send

/**
 * A choose of the asked fixture's choice `choiceId` (an option of its one question, unless `question` says otherwise)
 * with no field: a bare tap, or a claim with no details.
 */
function settledChoose(choiceId = "c-01", question: string | null = QUESTION): DecidePart {
  return {
    verb: "choose",
    quote: "A bit of everything",
    question,
    choice: choiceId,
    fields: [],
  } as unknown as DecidePart;
}

/** The asked fixture's request, its one part a choose of `choiceId` that both reads agree on (outcome go). */
function settledRequest(choiceId = "c-01", question: string | null = QUESTION): GateAndCommitRequest {
  return withPart(settledChoose(choiceId, question));
}

/**
 * The commit's deps for the asked fixture's turn with the real walk as writesOf (bundle v0, the asked fixture's pin, with
 * the question read and default 131's turn key) and S1-02's stand-in settler answering `answer` (or rejecting with it).
 */
function settledDeps(
  read: FakeRead,
  answer: unknown,
  k05: K05Fake = askedK05(),
): { deps: ReturnType<typeof askedDeps>; asks: string[] } {
  const ported = askedDeps(read, { k05 });
  const asks: string[] = [];
  const settler: StepSettler = (call) => {
    asks.push(call.step.id);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as string);
  };
  const writesOf = createWritesOf({
    bundles: skeletonBundles().bundles,
    turnKey: () => "sam-asked",
    questions: read.deps.questions,
    settlers: (stepId) => (stepId === "S1-02" ? settler : null),
  });
  return { deps: { ...ported, ports: { ...ported.ports, writesOf } }, asks };
}

/** What gateAndCommit threw for `request` on `deps`, or null when it answered. */
async function thrownBy(request: GateAndCommitRequest, deps: CommitDeps): Promise<unknown> {
  return gateAndCommit(request, callContext(BUSINESS), deps).then(
    () => null,
    (thrown: unknown) => thrown,
  );
}

describe("T-1528: a passed choose whose split settler answers 'ask' sends the question again once, end to end", () => {
  it("S1-02's settler answers 'ask': the walk writes nothing, and the commit sends K-05's commit-s1-02-sam-asks-again.json, byte for byte as decide's own ask does", async () => {
    const read = fakeRead();
    const { deps, asks } = settledDeps(read, SETTLER_ASKS);
    const called = await callCommit(settledRequest(), deps);

    // One K-05 v1.21 request, the re-sent row and the raise alone: no close, no question opened, no clock row.
    expect(deps.k05.requests).toHaveLength(1);
    const [request] = deps.k05.requests;
    if (request === undefined) return fail();
    expect(contractChecks().k05v121("commitTurn.request", request)).toEqual([]);
    expect(request).toEqual(k05AsksAgainRequest());
    expect(eventLogRowsOf(request, "2026-10-19T18:07:04Z").map((row) => row.kind)).toEqual([
      "open_question.asked_again",
      "outbox_row.created",
    ]);
    // The settler asked once; the question read once, by the re-send: the walk read none.
    expect(asks).toEqual(["S1-02"]);
    expect(read.calls).toEqual([{ handleId: HANDLE, openQuestionId: QUESTION }]);

    // K-09 v1.12's written and openQuestions; the part answered as a passed part is (ask-again.ts default 3).
    const outcome = askedOutcome();
    expect(called.answer).toMatchObject({
      result: "committed",
      repeated: false,
      written: outcome.written,
      effects: [],
      openQuestions: { opened: [], closed: [] },
    });
    expect((called.answer as typeof outcome).parts).toMatchObject([
      { part: 0, choiceId: "c-01", result: "committed", stoppedBy: null, gives: [] },
    ]);
    expect(called.rows).toEqual([
      { table: "open_questions", id: QUESTION },
      { table: "outbox_rows", id: ROW },
    ]);
    // No word of the text in the request.
    for (const words of wordsIn(decidedIn(settledRequest()))) {
      expect(JSON.stringify(request)).not.toContain(words);
    }
  });

  it.each(["c-01", "c-02", "c-03"])(
    "%s named, settled 'ask': the same request, whichever of the question's options decide named",
    async (choiceId) => {
      const read = fakeRead();
      const { deps } = settledDeps(read, SETTLER_ASKS);
      await callCommit(settledRequest(choiceId), deps);
      expect(deps.k05.requests).toEqual([k05AsksAgainRequest()]);
    },
  );

  it("a second 'ask' for the same question (read at ask count 2): no row and no raise, nothing closed, as T-1505's second miss", async () => {
    const read = fakeRead({ ...storedQuestion(), askCount: 2, version: 3 });
    const { deps, asks } = settledDeps(read, SETTLER_ASKS);
    const called = await callCommit(settledRequest(), deps);
    expect(called.answer).toMatchObject({
      result: "committed",
      written: { written: [], outboxRows: [], promoted: [] },
      openQuestions: { opened: [], closed: [] },
    });
    const [sent] = deps.k05.requests;
    if (sent === undefined) return fail();
    expect(asksAgain(sent as TurnCommitRequest)).toBe(false);
    expect(sent.writes.outboxRows).toEqual([]);
    expect(sent.writes.openQuestions).toEqual({ open: [], close: [] });
    expect(sent.writes.events).toEqual([]);
    expect(contractChecks().k05("commitTurn.request", sent)).toEqual([]);
    expect(asks).toEqual(["S1-02"]);
    expect(read.calls).toHaveLength(1);
  });

  it("a rerun after the first 'ask' reads ask count 2 and builds no row or raise; K-05 answers the first commit, so nothing is written twice", async () => {
    const read = fakeRead();
    const k05 = askedK05();
    const { deps } = settledDeps(read, SETTLER_ASKS, k05);
    await callCommit(settledRequest(), deps);
    read.row = { ...storedQuestion(), askCount: 2, version: 3 };
    const again = await callCommit(settledRequest(), deps);
    expect(again.answer).toMatchObject({
      result: "committed",
      repeated: true,
      written: { written: [], outboxRows: [{ id: ROW, commitSeq: 2 }], promoted: [] },
    });
    expect(asksAgain((k05.requests[1] ?? fail()) as TurnCommitRequest)).toBe(false);
    expect(k05.commits).toHaveLength(1);
  });

  it("with no question read handed to the commit (CommitDeps.askAgain left out): the walk's 'ask' writes nothing and the turn stays silent", async () => {
    const read = fakeRead();
    const { deps } = settledDeps(read, SETTLER_ASKS);
    const withoutAskAgain: CommitDeps = { limits: deps.limits, ports: deps.ports };
    const answer = await gateAndCommit(settledRequest(), callContext(BUSINESS), withoutAskAgain);
    expect(answer).toMatchObject({ result: "committed", written: { outboxRows: [] } });
    const [sent] = deps.k05.requests;
    expect(asksAgain((sent ?? fail()) as TurnCommitRequest)).toBe(false);
    expect(sent?.writes.events).toEqual([]);
    expect(read.calls).toEqual([]);
  });

  it("a label still walks as before (on bundle v0, 'All on the list' rejoins at S1-11, which v0 does not hold), an unknown label is still refused settledNotInBundle, and a throw still fails closed; nothing is sent", async () => {
    const labelled = settledDeps(fakeRead(), "All on the list");
    const walkedOn = await thrownBy(settledRequest(), labelled.deps);
    expect(walkedOn).toBeInstanceOf(WalkRefusedError);
    expect(walkedOn).toMatchObject({ fault: "stepNotInBundle", ids: ["S1-11"] });
    expect(labelled.deps.k05.requests).toEqual([]);

    for (const answered of ["Ask", "Maybe on the list", ""]) {
      const read = fakeRead();
      const unknown = settledDeps(read, answered);
      const refused = await thrownBy(settledRequest(), unknown.deps);
      expect(refused, answered).toBeInstanceOf(WalkRefusedError);
      expect(refused, answered).toMatchObject({ fault: "settledNotInBundle", ids: ["S1-02"] });
      expect(unknown.deps.k05.requests).toEqual([]);
      expect(read.calls).toEqual([]);
    }

    const failed = new Error("the settler's read failed");
    const throwing = settledDeps(fakeRead(), failed);
    expect(await thrownBy(settledRequest(), throwing.deps)).toBe(failed);
    expect(throwing.deps.k05.requests).toEqual([]);
  });
});

/** The gate's answer for the fixture's one part as a passed choose of c-01, its limits as the fixture lists them. */
function passedGated(): GatedPart[] {
  return askedGated().map((part) => ({ ...part, choiceId: "c-01", result: "passed" as const }));
}

/** askedTurn on settledRequest(choiceId), the part passed, with the walk's note on its turn object for each of `noted`. */
function settledTurn(
  change: Partial<AskedTurn> = {},
  noted: readonly number[] = [0],
  request: GateAndCommitRequest = settledRequest(),
): AskedTurn {
  const turn = askedTurn({ gated: passedGated(), ...change }, request);
  for (const index of noted) noteSettlerAsked(turn.context, index);
  return turn;
}

describe("askAgainUnit: default 192 (a) and (c) with the walk's note of a settler's 'ask' (T-1528)", () => {
  it("all hold, the noted part passed: the same unit as for a part decide ended in one question", async () => {
    const read = fakeRead();
    const unit = await askAgainUnit(read.deps, settledTurn());
    expect(unit).not.toBeNull();
    expect(unit).toEqual(await askAgainUnit(fakeRead().deps, askedTurn()));
    expect(read.calls).toEqual([{ handleId: HANDLE, openQuestionId: QUESTION }]);
  });

  it("(a) a passed part with no note is not asked: nothing, nothing read", async () => {
    const read = fakeRead();
    expect(await askAgainUnit(read.deps, settledTurn({}, []))).toBeNull();
    expect(read.calls).toEqual([]);
  });

  it("(a) the noted part beside a part that passed with no note, was stopped or depends on one, or either held: nothing, nothing read", async () => {
    const [passed] = passedGated();
    if (passed === undefined) return fail();
    const second = (result: GatedPart["result"]): GatedPart => ({ ...passed, part: 1, result });
    for (const change of [
      { gated: [passed, second("passed")] },
      { gated: [passed, second("stopped")] },
      { gated: [passed, second("dependsOnStopped")] },
      { gated: [passed, second("noAction")], held: new Set([1]) },
      { gated: [passed], held: new Set([0]) },
    ]) {
      const read = fakeRead();
      expect(await askAgainUnit(read.deps, settledTurn(change)), JSON.stringify(change.gated)).toBeNull();
      expect(read.calls).toEqual([]);
    }
  });

  it("(a) and (c) the noted part beside a part decide asked about the same question, or one that took no action: one unit", async () => {
    const request = askedRequest();
    const decided = decidedIn(request);
    const [asked] = decided.decide.parts;
    decided.decide.parts = [{ part: settledChoose(), outcome: "go" }, copy(asked)];
    for (const each of decided.decide.reads) each.output.parts = [settledChoose(), copy(asked.part)];
    const [passed] = passedGated();
    const [askedPart] = askedGated();
    if (passed === undefined || askedPart === undefined) return fail();
    for (const second of [
      { ...askedPart, part: 1 },
      { ...askedPart, part: 1, result: "noAction" as const },
    ]) {
      const unit = await askAgainUnit(
        fakeRead().deps,
        settledTurn({ gated: [passed, second] }, [0], request),
      );
      expect(
        unit?.writes.messages.map((row) => row.id),
        second.result,
      ).toEqual([ROW]);
    }
  });

  it("(c) a noted choose of a door, not an option of the question, or a noted enter: nothing, nothing read", async () => {
    const enter = withPart({
      verb: "enter",
      quote: "A bit of everything",
      choice: "c-01",
      fields: [],
    } as unknown as DecidePart);
    for (const request of [settledRequest("c-04", null), enter]) {
      const read = fakeRead();
      expect(await askAgainUnit(read.deps, settledTurn({}, [0], request))).toBeNull();
      expect(read.calls).toEqual([]);
    }
  });

  it("(e) the question asked twice already: nothing, the question read once; (f) a hold: nothing, nothing read", async () => {
    const twice = fakeRead({ ...storedQuestion(), askCount: 2, version: 3 });
    expect(await askAgainUnit(twice.deps, settledTurn())).toBeNull();
    expect(twice.calls).toHaveLength(1);
    const hold: SafetyHold = { holdId: "hold-sam-0002", releaseRule: "after_safe", blocksBooking: true };
    const held = fakeRead();
    expect(
      await askAgainUnit(held.deps, settledTurn({ open: { holds: [hold], unreadEventIds: [] } })),
    ).toBeNull();
    expect(held.calls).toEqual([]);
  });

  it("a note on another turn object, even an equal one, is never read: nothing", async () => {
    const turn = settledTurn({}, []);
    const other = settledTurn({}, [0]);
    expect(other.context).toEqual(turn.context);
    const read = fakeRead();
    expect(await askAgainUnit(read.deps, turn)).toBeNull();
    expect(read.calls).toEqual([]);
  });
});
