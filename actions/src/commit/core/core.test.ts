// T-1140's proofs (the card's "Proves it with"): runCore, with the safety service (T-318) behind it and doubles for that
// service's ports only, on the frozen contracts' fixtures (K-09 v1.5 commit-s1-01.json, the skeleton's turn 1: T-1142,
// DL-322; K-09 v1 commit-s1-02.json; K-02 v1's safety reads; K-34 v1's seeds) and bundle v0, never a database:
//   - commit-s1-01.json gives its core actions' writes, each text's recordSafetyOutcome among them;
//   - a crisis outcome opens its hold, and a routine part after it is held;
//   - an unknown or unbuilt core action answers notBuilt and writes nothing;
//   - the same action twice gives the same writes.
// And the lead's notes on the card: with bundle v0 pinned each danger outcome gets its line (DL-325, DL-341), a run that
// arms clock rows answers notBuilt (DL-341), so does a port not wired, each core action is the turn's own call, and a
// refused core action stops only itself.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type * as K09 from "../../../../contracts/generated/tool-api/tool-api.v1.5";
import {
  NOT_TOLD_YET,
  STOP_WORDS_NOT_WIRED,
  SafetyRefusedError,
  byteaText,
  noSafetyReads,
  recordSafetyOutcomeCore,
  type RecordResponse,
  type SafetyLineChoice,
  type SafetyOutcome,
  type SafetyResult,
} from "../../domain/safety";
import { contractJson } from "../../domain/messages-consent/test-support";
import {
  BARBERSHOP,
  SAFETY_SEEDS,
  TEST_LINES,
  applySafetyWrites,
  safetyWorldOf,
  type SafetyWorld,
} from "../../domain/safety/test-support";
import { callContext, copy, scriptedLimits, type LimitCall } from "../../gate/framework/test-support";
import { NotBuiltError, createToolApi, createToolApiValidator } from "../../tool-api";
import { contractFile, recordingHandlers, recordingScope, traceFor } from "../../tool-api/test-support";
import {
  CommitNotBuiltError,
  CommitRefusedError,
  gateAndCommit,
  type CommitDeps,
  type CommitPorts,
  type Committed,
  type CoreAction,
  type CoreRun,
  type GateAndCommitAnswer,
  type GateAndCommitRequest,
  type OpenHolds,
} from "../index";
import { doublePorts, k05Fake, type K05Fake, type PortCalls } from "../test-support";
import {
  CoreNotBuiltError,
  STRICTEST_LINE,
  coreSafetyLines,
  createRunCore,
  type CoreDeps,
  type CoreSafetyDeps,
} from "./index";
import {
  SAFETY_STEP_OF,
  bundleLines,
  bundleV0,
  coreDoublesOn,
  s1_01Exchange,
  turnContextOf,
  withK05Turn,
} from "./test-support";

const validator = createToolApiValidator();

type RecordAction = Extract<CoreAction, { call: "recordSafetyOutcome" }>;

const NOTHING_OPEN: OpenHolds = { holds: [], unreadEventIds: [] };

/** A K-02 v1 safety read (contracts/model/fixtures), re-keyed to another text when one is named. */
function safetyRead(file: string, eventId?: string): SafetyResult {
  const read = copy(contractJson(`model/fixtures/${file}`) as SafetyResult);
  return eventId === undefined ? read : { ...read, eventId };
}

/** commit-s1-01.json's request, with its turn row as K-05 writes it (DL-340), and its committed outcome. */
function s1_01(): { request: GateAndCommitRequest; outcome: Committed } {
  const exchange = s1_01Exchange();
  const { outcome } = exchange;
  if (!("result" in outcome) || outcome.result !== "committed") throw new Error("commit-s1-01 commits");
  return { request: withK05Turn(exchange.request), outcome };
}

/** The record a request carries for one text. */
function recordOf(request: GateAndCommitRequest, eventId: string): RecordAction {
  const action = request.core.find(
    (each): each is RecordAction =>
      each.call === "recordSafetyOutcome" && each.request.safety.eventId === eventId,
  );
  if (action === undefined) throw new Error(`no safety record for ${eventId}`);
  return action;
}

/** commit-s1-01.json's request with Sam's text read as a K-02 v1 safety read says, re-keyed to his text. */
function s1_01ReadAs(file: string): GateAndCommitRequest {
  const { request } = s1_01();
  recordOf(request, "evt-sam-s1-01").request.safety = safetyRead(file, "evt-sam-s1-01");
  return request;
}

/** The answer of a record's core run, held to K-09 v1's response. */
function responseOf(run: CoreRun): RecordResponse {
  const { result } = run;
  if (result.call !== "recordSafetyOutcome" || result.response === null) {
    throw new Error(`not recorded: ${JSON.stringify(result.error)}`);
  }
  expect(validator.check("recordSafetyOutcome", "response", result.response)).toEqual([]);
  return result.response;
}

/** The turn's caller, as each of its core actions carries it. */
function turnCaller(turnId: string, personId: string): K09.Caller {
  return {
    kind: "turn",
    turnId,
    requestId: turnId,
    businessId: BARBERSHOP,
    personId,
    traceId: `trace-${turnId}`,
  };
}

/**
 * A turn of core actions only on Alex's handle at the barbershop (his texts' reads are K-02 v1's fixtures), bundle v0
 * pinned, each text with its record, every record about `bookingId`, then any `more` core actions.
 */
function alexTurn(
  reads: readonly SafetyResult[],
  options: { readonly bookingId?: string | null; readonly more?: readonly CoreAction[] } = {},
): GateAndCommitRequest {
  const turnId = "turn-alex-core";
  const caller = turnCaller(turnId, "person-alex");
  const [first, ...rest] = reads.map((read) => read.eventId);
  if (first === undefined) throw new Error("a turn joins at least one text");
  const records = reads.map((safety): CoreAction => ({
    call: "recordSafetyOutcome",
    request: {
      caller,
      safety,
      handleId: "handle-alex",
      bookingId: options.bookingId ?? null,
      sentByActor: null,
    },
  }));
  return {
    caller,
    turn: {
      id: turnId,
      handleId: "handle-alex",
      eventIds: [first, ...rest],
      bundleId: { ...bundleV0().bundleId },
      traceId: caller.traceId,
      joinedTraceIds: [],
      tries: 1,
    },
    input: { kind: "coreOnly" },
    core: [...records, ...(options.more ?? [])],
    now: "2026-10-26T21:40:02Z",
  };
}

/** The commit's ports with runCore as built; every other port the commit's own doubles (T-305). */
interface Committing {
  readonly ports: CommitPorts;
  readonly calls: PortCalls;
  readonly k05: K05Fake;
  /** The core actions runCore was asked to run, by call name, in order. */
  readonly ran: string[];
  /** What is open, as each runCore call was handed it, in order. */
  readonly seen: OpenHolds[];
}

function commitWith(deps: CoreDeps<unknown>): Committing {
  const k05 = k05Fake();
  const doubles = doublePorts({ k05 });
  const runCore = createRunCore(deps);
  const ran: string[] = [];
  const seen: OpenHolds[] = [];
  return {
    ports: {
      ...doubles.ports,
      runCore(action, turn, open) {
        ran.push(action.call);
        seen.push(copy(open));
        return runCore(action, turn, open);
      },
    },
    calls: doubles.calls,
    k05,
    ran,
    seen,
  };
}

/** One gateAndCommit through the commit (T-305), runCore as built and limits 1 to 6 as passing doubles. */
async function committed(
  request: GateAndCommitRequest,
  deps: CoreDeps<unknown>,
): Promise<Committing & { answer: Committed; limitCalls: LimitCall[] }> {
  const committing = commitWith(deps);
  const limitCalls: LimitCall[] = [];
  const answer: GateAndCommitAnswer = await gateAndCommit(request, callContext(BARBERSHOP), {
    limits: scriptedLimits({}, limitCalls),
    ports: committing.ports,
  });
  if ("error" in answer || answer.result !== "committed") {
    throw new Error(`not committed: ${JSON.stringify(answer)}`);
  }
  return { ...committing, answer, limitCalls };
}

/** The safety ports without one, as a wiring that leaves it to the service's default would hand them. */
function withoutPort(deps: CoreDeps<unknown>, port: keyof CoreSafetyDeps<unknown>): CoreDeps<unknown> {
  const safety = Object.fromEntries(Object.entries(deps.safety).filter(([key]) => key !== port));
  return { safety } as unknown as CoreDeps<unknown>;
}

/** A port that must never be read: it throws when the service asks for it. */
function unread(): never {
  throw new Error("nothing is read for a core action that does not run");
}

let warn: MockInstance;
let log: MockInstance;
let error: MockInstance;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  // Nothing runCore does writes a log line (K-08 v1: never a person's words, a number or an address).
  expect(warn).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------

describe("commit-s1-01.json: the skeleton's turn 1 gives its core actions' writes (K-09 v1.5; T-1142; DL-322)", () => {
  it("each text of the turn carries its recordSafetyOutcome, and runCore answers each as the fixture's outcome does", async () => {
    const { request, outcome } = s1_01();
    const { deps } = coreDoublesOn(safetyWorldOf());
    const runCore = createRunCore(deps);
    const turn = turnContextOf(request);
    // Every text, No included (K-09 README default 5): one record per event id of the turn, on the turn's handle.
    expect(request.core.map((action) => action.call)).toEqual(["recordSafetyOutcome"]);
    for (const eventId of turn.turn.eventIds) {
      expect(recordOf(request, eventId).request.handleId).toBe(turn.turn.handleId);
    }
    const runs: CoreRun[] = [];
    for (const action of request.core) runs.push(await runCore(action, turn, copy(NOTHING_OPEN)));
    expect(runs.map((run) => run.result)).toEqual(outcome.core);
    for (const run of runs) responseOf(run);
  });

  it("writes Sam's text's outcome row under the turn, its words sealed under his key, and no hold, line or clock", async () => {
    const { request } = s1_01();
    const { deps, sealer } = coreDoublesOn(safetyWorldOf());
    const run = await createRunCore(deps)(
      recordOf(request, "evt-sam-s1-01"),
      turnContextOf(request),
      copy(NOTHING_OPEN),
    );
    const [seal] = sealer.calls;
    if (seal === undefined) throw new Error("the read's words are sealed");
    expect(sealer.calls.map((call) => call.forPersonId)).toEqual(["person-sam"]);
    expect(run.writes.state).toHaveLength(1);
    const [write] = run.writes.state;
    if (write?.op !== "insert") throw new Error("the record inserts its outcome row");
    expect(write.table).toBe("safety_outcomes");
    expect(write.values).toMatchObject({
      id: "safety-outcome-sam-s1-01",
      event_id: "evt-sam-s1-01",
      source: "text",
      handle_id: "handle-sam",
      person_id: "person-sam",
      business_id: BARBERSHOP,
      booking_id: null,
      turn_id: "turn-s1-01-sam",
      read_at: request.now,
      timed_out: false,
      labels: ["No"],
      tenses: ["now"],
      outcomes: ["No"],
      lifted_to_unsure: false,
      sealed_words: byteaText(seal.bytes),
    });
    expect(
      run.writes.stateEvents.map((entry) => [entry.kind, entry.rowId, entry.sealed?.forPersonId]),
    ).toEqual([["safety_outcome.recorded", "safety-outcome-sam-s1-01", "person-sam"]]);
    expect(run.writes.why).toEqual({ step: "A3-22", choice: null });
    expect(run.writes.messages).toEqual([]);
    expect(run.writes.asks).toEqual([]);
    expect(run.writes.gives).toEqual([]);
    // Sam's own words go nowhere but the sealed value.
    const texts = request.input.kind === "decided" ? request.input.decided.context.texts : [];
    expect(texts).toHaveLength(1);
    for (const text of texts) expect(JSON.stringify(run.writes)).not.toContain(text.words);
  });

  it("the turn's one commit carries the record: S1-01's part commits beside it, in one K-05 request K-05 v1.1 takes", async () => {
    const { request, outcome } = s1_01();
    const { deps } = coreDoublesOn(safetyWorldOf());
    const { answer, calls, k05, ran } = await committed(request, deps);
    expect(ran).toEqual(["recordSafetyOutcome"]);
    expect(answer.core).toEqual(outcome.core);
    expect(answer.parts.map((part) => part.result)).toEqual(["committed"]);
    expect(calls.writesOf).toEqual([0]);
    expect(k05.requests).toHaveLength(1);
    const [sent] = k05.requests;
    expect(sent?.turn.id).toBe("turn-s1-01-sam");
    expect(sent?.writes.state.map((write) => write.table)).toEqual(["safety_outcomes"]);
    expect(sent?.writes.events.map((entry) => entry.kind)).toContain("safety_outcome.recorded");
    expect(answer.written.written.map((row) => [row.table, row.rowId])).toEqual([
      ["safety_outcomes", "safety-outcome-sam-s1-01"],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("a crisis outcome opens its hold, and what follows it in the turn is held (arch 06 lines 319 to 327)", () => {
  it("Sam's text read as crisis words: its after-safe hold and 988 line are committed, and S1-01's routine part is held", async () => {
    const request = s1_01ReadAs("safety-crisis-words.json");
    const { deps } = coreDoublesOn(safetyWorldOf());
    const { answer, calls, k05, limitCalls } = await committed(request, deps);
    const [core] = answer.core;
    if (core?.call !== "recordSafetyOutcome" || core.response === null) throw new Error("recorded");
    expect(core.response).toMatchObject({
      outcomeId: "safety-outcome-sam-s1-01",
      outcomes: ["Crisis words"],
      hold: { releaseRule: "after_safe", blocksBooking: false },
      safetyLine: { fixedLineId: "safetyCrisis" },
      told: [
        { who: "owner", via: "handOff" },
        { who: "team", via: "teamPage" },
      ],
      nothingBooks: true,
      repeated: false,
    });
    // The routine part after it waits: held before the gate, no limit ran for it, and nothing of it was written.
    expect(answer.parts.map((part) => part.result)).toEqual(["held"]);
    expect(limitCalls).toEqual([]);
    expect(calls.writesOf).toEqual([]);
    const [sent] = k05.requests;
    if (sent === undefined) throw new Error("one commit was sent");
    expect(sent.writes.state.map((write) => write.table)).toEqual([
      "safety_outcomes",
      "safety_holds",
      "hand_offs",
      "team_pages",
    ]);
    expect(sent.writes.outboxRows).toEqual([
      expect.objectContaining({ recipientHandleId: "handle-sam", sendClass: "safety", openQuestionId: null }),
    ]);
    expect(core.response.safetyLine?.outboxRowId).toBe(sent.writes.outboxRows[0]?.id);
  });

  it("a core action after it is handed its hold, and a later text's record still records: it only protects", async () => {
    const request = alexTurn([safetyRead("safety-crisis-words.json"), safetyRead("safety-no.json")]);
    const { deps } = coreDoublesOn(safetyWorldOf());
    const { answer, seen } = await committed(request, deps);
    const [crisis, no] = answer.core;
    const held = crisis?.call === "recordSafetyOutcome" ? (crisis.response?.hold ?? null) : null;
    if (held === null) throw new Error("the crisis holds");
    expect(seen.map((open) => open.holds.map((hold) => hold.holdId))).toEqual([[], [held.holdId]]);
    expect(no).toMatchObject({
      call: "recordSafetyOutcome",
      response: { outcomes: ["No"], hold: null, safetyLine: null, repeated: false },
      error: null,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("an unknown or unbuilt core action answers notBuilt and writes nothing", () => {
  /** K-09 v1's core actions, by call name, as its coreAction lists them. */
  function k09CoreCalls(): string[] {
    const schema = contractFile("tool-api/tool-api.v1.schema.json") as {
      $defs: { coreAction: { oneOf: { properties: { call: { const: string } } }[] } };
    };
    return schema.$defs.coreAction.oneOf.map((each) => each.properties.call.const);
  }

  it("every K-09 v1 core action but the two safety calls answers notBuilt by its name, before anything is read", async () => {
    const { request } = s1_01();
    const turn = turnContextOf(request);
    const { deps } = coreDoublesOn(safetyWorldOf(), { reader: unread, sealer: unread, flagsReader: unread });
    const runCore = createRunCore(deps);
    const calls = k09CoreCalls();
    expect(calls).toHaveLength(15);
    const unbuilt = calls.filter((call) => call !== "recordSafetyOutcome" && call !== "releaseSafetyHold");
    expect(unbuilt).toHaveLength(13);
    for (const call of unbuilt) {
      const action = { call, request: { caller: copy(request.caller) } } as unknown as CoreAction;
      const refused = await runCore(action, turn, copy(NOTHING_OPEN)).catch((thrown: unknown) => thrown);
      expect(refused, call).toBeInstanceOf(CoreNotBuiltError);
      expect(refused, call).toMatchObject({
        core: call,
        gap: "noService",
        seam: "runCore",
        call: "gateAndCommit",
      });
      // The commit's own notBuilt: the Tool API base answers gateAndCommit notBuilt and rolls the call back.
      expect(refused, call).toBeInstanceOf(CommitNotBuiltError);
      expect(refused, call).toBeInstanceOf(NotBuiltError);
    }
  });

  it("a name K-09 v1 does not hold answers notBuilt too, and is never echoed (it is the caller's own text)", async () => {
    const { request } = s1_01();
    const { deps } = coreDoublesOn(safetyWorldOf());
    const name = "dropEveryHold +15555550100";
    const action = { call: name, request: { caller: copy(request.caller) } } as unknown as CoreAction;
    const refused = await createRunCore(deps)(action, turnContextOf(request), copy(NOTHING_OPEN)).catch(
      (thrown: unknown) => thrown,
    );
    expect(refused).toBeInstanceOf(CoreNotBuiltError);
    expect(refused).toMatchObject({ core: null, gap: "noService" });
    const { message } = refused as Error;
    expect(message).not.toContain("dropEveryHold");
    expect(message).not.toContain("5555550100");
  });

  it("through the Tool API base, a turn carrying one answers notBuilt: nothing goes to K-05, and the call rolls back", async () => {
    // commit-s1-02.json (K-09 v1, which the base's validator holds) with a pause set in the turn, after Sam's record.
    const request = copy(
      (contractFile("tool-api/fixtures/commit-s1-02.json") as { request: GateAndCommitRequest }).request,
    );
    request.core.push({
      call: "setRecordFlag",
      request: {
        caller: copy(request.caller),
        flag: "paused",
        action: "set",
        target: { personId: "person-sam" },
        expectVersion: null,
      },
    });
    const { deps } = coreDoublesOn(safetyWorldOf());
    const { ports, calls, k05, ran } = commitWith(deps);
    const commitDeps: CommitDeps = { limits: scriptedLimits(), ports };
    const scope = recordingScope();
    const handlers = recordingHandlers("gateAndCommit", (given, context) =>
      gateAndCommit(given as GateAndCommitRequest, context, commitDeps),
    );
    const api = createToolApi({ validator, scope, handlers });
    const answer = await api.call("gateAndCommit", request, traceFor(request).trace);
    expect(answer).toEqual({ error: "notBuilt", call: "gateAndCommit" });
    expect(ran).toEqual(["recordSafetyOutcome", "setRecordFlag"]);
    expect(k05.requests).toEqual([]);
    expect(calls.writesOf).toEqual([]);
    expect(scope.events.at(-1)).toEqual({ what: "rollback" });
  });

  it("a safety call whose port is not wired answers notBuilt, naming it: K-34's reads, the stop words, who is told", async () => {
    const { request } = s1_01();
    const crisis = s1_01ReadAs("safety-crisis-words.json");
    const cases: [string, GateAndCommitRequest, Partial<CoreSafetyDeps<unknown>>, string][] = [
      [
        "K-34's reads",
        request,
        { reader: () => noSafetyReads("recordSafetyOutcome") },
        "recordSafetyOutcome",
      ],
      ["the plug-in's stop words", request, { stopWords: STOP_WORDS_NOT_WIRED }, "recordSafetyOutcome"],
      ["who is told (T-319)", crisis, { telling: NOT_TOLD_YET }, "handOff"],
    ];
    for (const [port, given, extra, notBuiltCall] of cases) {
      const { deps } = coreDoublesOn(safetyWorldOf(), extra);
      const refused = await createRunCore(deps)(
        recordOf(given, "evt-sam-s1-01"),
        turnContextOf(given),
        copy(NOTHING_OPEN),
      ).catch((thrown: unknown) => thrown);
      expect(refused, port).toBeInstanceOf(CoreNotBuiltError);
      expect(refused, port).toMatchObject({ core: "recordSafetyOutcome", gap: "portNotWired" });
      const { cause } = refused as Error;
      expect(cause, port).toBeInstanceOf(NotBuiltError);
      expect((cause as NotBuiltError).call, port).toBe(notBuiltCall);
    }
    // A wiring with no sealer at all: the words are never written in plain, so the record is not built either.
    const { deps } = coreDoublesOn(safetyWorldOf());
    const unsealed = createRunCore(withoutPort(deps, "sealer"));
    await expect(
      unsealed(recordOf(request, "evt-sam-s1-01"), turnContextOf(request), copy(NOTHING_OPEN)),
    ).rejects.toMatchObject({ core: "recordSafetyOutcome", gap: "portNotWired" });
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("a run that arms clock rows answers notBuilt until T-1156: no clock is ever dropped (DL-341)", () => {
  /** Alex's Nov 14 visit with Riley at the barbershop, as T-317's flag-paused.json covers it (S11-62). */
  const NOV14 = {
    bookingId: "booking-alex-riley-nov14",
    startsAt: "2026-11-14T15:00:00Z",
    zone: "America/New_York",
  };

  it("a threat with a later visit: its pauses arm call-off clocks, so the record answers notBuilt and writes nothing", async () => {
    const request = alexTurn([safetyRead("safety-threat.json")], { bookingId: NOV14.bookingId });
    const { deps } = coreDoublesOn(safetyWorldOf(), { visits: { visitsOf: () => Promise.resolve([NOV14]) } });
    const turn = turnContextOf(request);
    const action = recordOf(request, "evt-alex-0204");
    // The service plans the record with both call-off clocks (S11-62), which UnitWrites has no list for yet.
    const planned = await recordSafetyOutcomeCore(action, turn, copy(NOTHING_OPEN), {
      ...deps.safety,
      lines: coreSafetyLines(deps.safety.lines),
    });
    expect(planned.clocks).toHaveLength(2);
    expect(planned.run.writes.state.map((write) => write.table)).toContain("pauses");
    // So runCore answers notBuilt for it rather than write the pauses without their clocks.
    await expect(createRunCore(deps)(action, turn, copy(NOTHING_OPEN))).rejects.toMatchObject({
      name: "CoreNotBuiltError",
      core: "recordSafetyOutcome",
      gap: "clockRows",
      call: "gateAndCommit",
    });
    // And the turn writes nothing at all.
    const { ports, k05, ran } = commitWith(deps);
    await expect(
      gateAndCommit(request, callContext(BARBERSHOP), { limits: scriptedLimits(), ports }),
    ).rejects.toBeInstanceOf(CoreNotBuiltError);
    expect(ran).toEqual(["recordSafetyOutcome"]);
    expect(k05.requests).toEqual([]);
  });

  it("the same threat with no later visit arms no clock: it records its never hold, the pauses and the owner's line", async () => {
    const request = alexTurn([safetyRead("safety-threat.json")]);
    const { deps } = coreDoublesOn(safetyWorldOf());
    const run = await createRunCore(deps)(
      recordOf(request, "evt-alex-0204"),
      turnContextOf(request),
      copy(NOTHING_OPEN),
    );
    expect(responseOf(run)).toMatchObject({
      outcomes: ["A threat to staff or others"],
      hold: { releaseRule: "never" },
      safetyLine: { fixedLineId: STRICTEST_LINE },
      told: [{ who: "owner", via: "handOff" }],
      nothingBooks: true,
    });
    expect(run.writes.state.map((write) => write.table)).toEqual([
      "safety_outcomes",
      "safety_holds",
      "pauses",
      "pauses",
      "hand_offs",
    ]);
    // A threat's writer gets no line: it goes to the owner, Sam, on his own handle (A3-48: san to owner).
    expect(
      run.writes.messages.map((row) => [row.recipientPersonId, row.recipientHandleId, row.sendClass]),
    ).toEqual([["person-sam", "handle-sam", "safety"]]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("the core's safety line with bundle v0 pinned (T-1143's rule; DL-325, DL-341; CQ-163's defaults)", () => {
  it("bundle v0 holds no safety step, and K-01's 911, 988 and outage lines with their words", () => {
    const bundle = bundleV0();
    expect(bundle.partial).toBe(true);
    expect([...bundle.stepsA]).toEqual(["S1-01", "S1-02"]);
    for (const step of Object.values(SAFETY_STEP_OF)) expect(bundle.stepsA.has(step), step).toBe(false);
    for (const line of ["safetyEmergency", "safetyCrisis", "safetyAsk", "outage"]) {
      expect(bundle.fixedLines.has(line), line).toBe(true);
    }
  });

  it("every danger outcome gets a line, a threat's only to the owner, and No none", () => {
    const lines = coreSafetyLines(bundleLines(bundleV0()));
    const writer = (fixedLineId: string): SafetyLineChoice => ({ fixedLineId, to: "writer", hotline: null });
    const expected: [SafetyOutcome, ("selfHarm" | "other")[], SafetyLineChoice | null][] = [
      ["No", [], null],
      ["Crisis words", ["selfHarm"], writer("safetyCrisis")],
      ["An emergency", ["other"], writer("safetyEmergency")],
      ["A threat to staff or others", [], { fixedLineId: "safetyEmergency", to: "owner", hotline: null }],
      ["Harm to a child or older adult", [], writer("safetyEmergency")],
      ["Unsafe at home", [], writer("safetyEmergency")],
      ["Needs the business's own line", [], writer("safetyEmergency")],
      ["Safety steps, then go on", [], writer("safetyEmergency")],
      ["Unsure", ["other"], writer("safetyEmergency")],
      ["Unsure", ["selfHarm"], writer("safetyCrisis")],
      ["Unsure", [], writer("safetyEmergency")],
    ];
    for (const [outcome, kinds, line] of expected) {
      expect(lines.lineOf(outcome, kinds), `${outcome} ${kinds.join(",")}`).toEqual(line);
    }
    expect(lines.outageLine()).toBe("outage");
  });

  /** One of Alex's texts, recorded alone in its turn through runCore with bundle v0 pinned. */
  async function recordAlone(read: SafetyResult, world: SafetyWorld = safetyWorldOf()): Promise<CoreRun> {
    const request = alexTurn([read]);
    const { deps } = coreDoublesOn(world);
    return createRunCore(deps)(recordOf(request, read.eventId), turnContextOf(request), copy(NOTHING_OPEN));
  }

  /** K-02 v1's No read re-keyed and read as safety steps (K-02 v1 has no fixture of its own for it). */
  function safetySteps(): SafetyResult {
    const no = safetyRead("safety-no.json", "evt-alex-0212");
    const [label] = no.read?.labels ?? [];
    if (label === undefined) throw new Error("the No read holds a label");
    return {
      ...no,
      read: { labels: [{ ...label, outcome: "Safety steps, then go on" }] },
      outcomes: ["Safety steps, then go on"],
    };
  }

  it("recorded, each danger text's line goes as an outbox row of send class safety, to its writer, a threat's to the owner", async () => {
    const cases: [string, SafetyResult, string, string][] = [
      ["crisis words", safetyRead("safety-crisis-words.json"), "safetyCrisis", "handle-alex"],
      ["an emergency", safetyRead("safety-emergency-now.json"), "safetyEmergency", "handle-alex"],
      ["a threat", safetyRead("safety-threat.json"), "safetyEmergency", "handle-sam"],
      ["unsafe at home", safetyRead("safety-unsafe-at-home.json"), "safetyEmergency", "handle-alex"],
      [
        "the business's own line",
        safetyRead("safety-business-own-line.json"),
        "safetyEmergency",
        "handle-alex",
      ],
      ["safety steps", safetySteps(), "safetyEmergency", "handle-alex"],
      [
        "unsure on a danger word",
        safetyRead("safety-timeout-danger-word.json"),
        "safetyEmergency",
        "handle-alex",
      ],
      [
        "unsure on a self-harm word",
        safetyRead("safety-timeout-self-harm-word.json"),
        "safetyCrisis",
        "handle-alex",
      ],
    ];
    for (const [what, read, lineId, handleId] of cases) {
      const run = await recordAlone(read);
      const answer = responseOf(run);
      expect(answer.safetyLine?.fixedLineId, what).toBe(lineId);
      expect(answer.hold, what).not.toBeNull();
      expect(
        run.writes.messages.map((row) => [row.id, row.recipientHandleId, row.sendClass]),
        what,
      ).toEqual([[answer.safetyLine?.outboxRowId, handleId, "safety"]]);
    }
    // No sends nothing.
    const no = await recordAlone(safetyRead("safety-no.json"));
    expect(responseOf(no)).toMatchObject({ hold: null, safetyLine: null });
    expect(no.writes.messages).toEqual([]);
  });

  it("harm to a child or older adult: 911 is its line, but no hotline is ever made up, so its record is refused", async () => {
    const lines = coreSafetyLines(bundleLines(bundleV0()));
    expect(lines.lineOf("Harm to a child or older adult", [])?.hotline).toBeNull();
    const refused = await recordAlone(safetyRead("safety-child-or-elder.json")).catch(
      (thrown: unknown) => thrown,
    );
    expect(refused).toBeInstanceOf(SafetyRefusedError);
    expect(refused).toMatchObject({ fault: "noHotline", rowIds: ["evt-alex-0205"] });
  });

  it("a full bundle's step line still wins, and a threat's never goes to its writer", () => {
    const full = coreSafetyLines(TEST_LINES);
    expect(full.lineOf("A threat to staff or others", [])).toEqual({
      fixedLineId: "threatSafetyLine",
      to: "owner",
      hotline: null,
    });
    expect(full.lineOf("Harm to a child or older adult", [])).toEqual({
      fixedLineId: "safetyHotlineLine",
      to: "writer",
      hotline: "elder_care",
    });
    expect(full.lineOf("Unsafe at home", [])?.fixedLineId).toBe("safetyUnsafeAtHomeLine");
    expect(full.lineOf("Needs the business's own line", [])?.fixedLineId).toBe("safetyOwnLine");
    // A3-23 with no steps for a barbershop still gets 911 (CQ-163 (c), fail closed).
    expect(full.lineOf("Safety steps, then go on", [])?.fixedLineId).toBe(STRICTEST_LINE);
    // A bundle that names a threat's line for its writer: the writer still gets none, the owner gets 911.
    const wrongWay = coreSafetyLines({
      lineOf: () => ({ fixedLineId: "threatSafetyLine", to: "writer", hotline: null }),
      outageLine: () => null,
    });
    expect(wrongWay.lineOf("A threat to staff or others", [])).toEqual({
      fixedLineId: STRICTEST_LINE,
      to: "owner",
      hotline: null,
    });
    expect(wrongWay.outageLine()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("the same action twice gives the same writes (a repeated turn runs runCore again before K-05 answers)", () => {
  it("Sam's record of No, and of crisis words, twice with nothing committed between: the same result and writes", async () => {
    for (const request of [s1_01().request, s1_01ReadAs("safety-crisis-words.json")]) {
      const { deps, sealer } = coreDoublesOn(safetyWorldOf());
      const runCore = createRunCore(deps);
      const action = recordOf(request, "evt-sam-s1-01");
      const first = await runCore(action, turnContextOf(request), copy(NOTHING_OPEN));
      const again = await runCore(action, turnContextOf(request), copy(NOTHING_OPEN));
      expect(again).toEqual(first);
      expect(first.writes.state.length).toBeGreaterThan(0);
      // Both runs sealed the same words under Sam's key into the same bytes, with the sealer that gives them (DL-330).
      expect(sealer.calls).toHaveLength(2);
      const [one, two] = sealer.calls;
      expect(two?.bytes).toEqual(one?.bytes);
    }
  });

  it("once the first is committed, the same action answers the first record as repeated and writes nothing", async () => {
    const request = s1_01ReadAs("safety-crisis-words.json");
    const world = safetyWorldOf();
    const { deps } = coreDoublesOn(world);
    const runCore = createRunCore(deps);
    const action = recordOf(request, "evt-sam-s1-01");
    const first = await runCore(action, turnContextOf(request), copy(NOTHING_OPEN));
    applySafetyWrites(world, first.writes.state, first.writes.messages);
    const again = await runCore(action, turnContextOf(request), copy(NOTHING_OPEN));
    expect(responseOf(again)).toEqual({ ...responseOf(first), repeated: true });
    expect(again.writes.state).toEqual([]);
    expect(again.writes.stateEvents).toEqual([]);
    expect(again.writes.messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("each core action rides as the turn's own call, and a refused one stops only itself", () => {
  it("a core action whose caller is not the turn's, or names another turn or trace, is refused before it runs", async () => {
    const { request } = s1_01();
    const { deps } = coreDoublesOn(safetyWorldOf(), { reader: unread, sealer: unread });
    const runCore = createRunCore(deps);
    const cases: [Partial<K09.Caller>, string][] = [
      [{ kind: "agent" }, "callerNotTurn"],
      [{ turnId: "turn-another" }, "turnIdMismatch"],
      [{ traceId: "trace-another" }, "traceIdMismatch"],
    ];
    for (const [change, fault] of cases) {
      const action = copy(recordOf(request, "evt-sam-s1-01"));
      action.request.caller = { ...action.request.caller, ...change };
      const refused = await runCore(action, turnContextOf(request), copy(NOTHING_OPEN)).catch(
        (thrown: unknown) => thrown,
      );
      expect(refused, fault).toBeInstanceOf(CommitRefusedError);
      expect(refused, fault).toMatchObject({ fault });
    }
  });

  it("a release refused by its rule (a threat's hold: never) answers its error and writes nothing; the turn commits", async () => {
    const { deps } = coreDoublesOn(safetyWorldOf([SAFETY_SEEDS.threat]));
    const release: CoreAction = {
      call: "releaseSafetyHold",
      request: {
        caller: turnCaller("turn-alex-core", "person-alex"),
        holdId: "hold-alex-0204",
        expectVersion: 1,
        why: "safe_readback",
        releasedByOutcomeId: "safety-alex-0204",
      },
    };
    const request = alexTurn([safetyRead("safety-no.json")], { more: [release] });
    const { answer, k05, ran } = await committed(request, deps);
    expect(ran).toEqual(["recordSafetyOutcome", "releaseSafetyHold"]);
    const [, released] = answer.core;
    expect(released).toEqual({
      call: "releaseSafetyHold",
      response: null,
      error: { error: "neverReleased", holdId: "hold-alex-0204" },
    });
    expect(validator.check("releaseSafetyHold", "errors", released?.error)).toEqual([]);
    // Only the No record's row is written: the refused release wrote nothing, and stopped nothing but itself.
    const [sent] = k05.requests;
    expect(sent?.writes.state.map((write) => write.table)).toEqual(["safety_outcomes"]);
  });
});
