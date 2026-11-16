// T-1163's proofs (the card's "Proves it with", with the lead's note from the CQ-335 ruling, DL-864, which binds
// it): runCore sends recordStopOrStart and setRecordFlag to T-317's core functions (domain/flags: stopOrStartCore
// and recordFlagCore) through the flags port the wiring binds by name, here a fake over T-317's in-memory reads
// (doubles for the services' ports only, never for runCore or a service under test), on the frozen contracts'
// fixtures (K-09 v1 stop-recorded.json, start-recorded.json and flag-paused.json; K-04 v1's and K-29 v1's seeds),
// never a database:
//   - each fixture of the two calls gives its core result and writes: stop-recorded.json's turn as it is, and
//     start-recorded.json's START and flag-paused.json's pause, each made alone in its fixture, as the core action
//     of a turn of their own (runCore runs a turn's own actions only: core.ts default 3);
//   - a STOP is recorded in the same commit as the turn: one K-05 request under the turn's id, answered as
//     stop-recorded.json's outcome;
//   - the same action twice gives the same writes;
//   - with no flags port bound each answers notBuilt (portNotWired) and nothing is read or written, and a wiring
//     that leaves one of its four ports out never falls back to the service's default reader on the call's
//     transaction;
//   - flag-paused.json's call-off clock rides in the run's writes (T-1156's withClocks), and the turn's commit
//     writes it;
//   - a STOP's result passes K-09 v1.5's response check without businessesTold (optional since v1.1);
//   - each is the turn's own call (default 3), its caller naming no business or the call's (default 6).
// Every other unbuilt core call still answers notBuilt, and every earlier runCore test is core.test.ts's.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type * as K09 from "../../../../contracts/generated/tool-api/tool-api.v1.5";
import {
  recordFlagCore,
  stopOrStartCore,
  type RecordFlagRequest,
  type RecordFlagResponse,
  type StopOrStartRequest,
  type StopOrStartResponse,
} from "../../domain/flags";
import {
  YOGA_STUDIO,
  fixtureIds,
  k09Fixture,
  phoneRow,
  withHandleAddress,
  withPhones,
} from "../../domain/flags/test-support";
import {
  BARBERSHOP,
  applySafetyWrites,
  fixtureSafetyIds,
  safetyWorldOf,
  type SafetyWorld,
} from "../../domain/safety/test-support";
import { callContext, copy, gateExchange, scriptedLimits } from "../../gate/framework/test-support";
import { NotBuiltError, createToolApi, createToolApiValidator } from "../../tool-api";
import { recordingHandlers, recordingScope, traceFor } from "../../tool-api/test-support";
import {
  CommitNotBuiltError,
  CommitRefusedError,
  gateAndCommit,
  type CommitPorts,
  type CommitTurnResponse,
  type Committed,
  type CoreAction,
  type CoreRun,
  type GateAndCommitAnswer,
  type GateAndCommitRequest,
  type OpenHolds,
} from "../index";
import { contractChecks, doublePorts, eventLogRowsOf, k05Fake, type K05Fake } from "../test-support";
import {
  CoreNotBuiltError,
  CoreRefusedError,
  createRunCore,
  type CoreDeps,
  type CoreFlagsDeps,
} from "./index";
import { coreDoublesOn, flagsPortOn, turnContextOf } from "./test-support";

const validator = createToolApiValidator();

const NOTHING_OPEN: OpenHolds = { holds: [], unreadEventIds: [] };

/** Ben's mobile as K-09 v1's stop-recorded.json and start-recorded.json name it, in the 555-01xx range (rule 9). */
const BEN = "+15555550131";

/** The turns this file carries start-recorded.json's START and flag-paused.json's pause in. */
const START_TURN = "turn-ben-start";
const PAUSE_TURN = "turn-sam-pause";

/** Alex's Nov 14 visit with Riley at the barbershop, which flag-paused.json's pause covers (S11-62). */
const NOV14 = {
  bookingId: "booking-alex-riley-nov14",
  startsAt: "2026-11-14T15:00:00Z",
  zone: "America/New_York",
};

/** The booked visits a pause covers, as the database engineer's read would give them: Alex's Nov 14 visit. */
const NOV14_VISITS = { visitsOf: () => Promise.resolve([NOV14]) };

/**
 * flag-paused.json's call-off clock row (callOffClockRowIds), as T-317 arms it for the Nov 14 visit: a step clock the
 * minute sweep owns, due at 7pm the day before, New York time (Nov 13, 19:00 EST is Nov 14 00:00Z).
 */
const CALL_OFF = {
  id: "clock-call-off-alex-nov14",
  kind: "step",
  openQuestionId: null,
  reservationId: null,
  handleId: null,
  businessId: BARBERSHOP,
  bookingId: NOV14.bookingId,
  fires: { step: "S11-62", branch: "callOff", pause_id: "pause-alex-lees", no_fee: true },
  due: { dueAt: "2026-11-14T00:00:00Z", dueZone: NOV14.zone },
};

/** The ids K-09's fixtures name for each call's rows, keyed by the turn that carries it; any other row is keyed. */
const FIXTURE_IDS = fixtureIds([
  ["consent", "turn-ben-stop", "person-ben", "consent-ben-stop"],
  ["stopReply", "turn-ben-stop", null, "out-ben-stop-reply"],
  ["consent", START_TURN, "person-ben", "consent-ben-start"],
  ["stopReply", START_TURN, null, "out-ben-start-reply"],
  ["pause", PAUSE_TURN, JSON.stringify({ target: "person", person_id: "person-alex" }), "pause-alex-lees"],
  ["callOff", PAUSE_TURN, `pause-alex-lees/${NOV14.bookingId}`, CALL_OFF.id],
]);

/** The id stop-recorded.json names for Ben's text's safety outcome; every other row takes the Worker's keyed id. */
const BEN_SAFETY_IDS = fixtureSafetyIds({ "evt-ben-0007": { outcome: "safety-outcome-ben-0007" } });

type StopAction = Extract<CoreAction, { call: "recordStopOrStart" }>;
type PauseAction = Extract<CoreAction, { call: "setRecordFlag" }>;
type FlagsAction = StopAction | PauseAction;

interface Exchange<Request, Outcome> {
  readonly given: { readonly now: string };
  readonly request: Request;
  readonly outcome: Outcome;
}

/** stop-recorded.json (K-09 v1): Ben's core-only turn (his text's record, then his STOP) and its committed outcome. */
function stopRecorded(): { request: GateAndCommitRequest; outcome: Committed } {
  const { request, outcome } = gateExchange("stop-recorded.json");
  if (!("result" in outcome) || outcome.result !== "committed") throw new Error("stop-recorded.json commits");
  return { request, outcome };
}

/** start-recorded.json (K-09 v1): Ben's START, written on return by the handle actor, made alone. */
const startRecorded = (): Exchange<StopOrStartRequest, StopOrStartResponse> =>
  copy(k09Fixture("start-recorded.json") as Exchange<StopOrStartRequest, StopOrStartResponse>);

/** flag-paused.json (K-09 v1): Sam's pause of Alex on the owner portal, made alone. */
const flagPaused = (): Exchange<RecordFlagRequest, RecordFlagResponse> =>
  copy(k09Fixture("flag-paused.json") as Exchange<RecordFlagRequest, RecordFlagResponse>);

/** A turn's caller, as each of its core actions carries it. */
function turnCaller(
  turnId: string,
  businessId: string | null,
  personId: string | null,
  traceId: string,
): K09.Caller {
  return { kind: "turn", turnId, requestId: turnId, businessId, personId, traceId };
}

/** A core-only turn on a handle, over one text, carrying one core action (stop-recorded.json's turn, re-keyed). */
function coreOnlyTurn(input: {
  readonly caller: K09.Caller;
  readonly handleId: string;
  readonly eventId: string;
  readonly action: CoreAction;
  readonly now: string;
}): GateAndCommitRequest {
  const { request } = stopRecorded();
  if (request.turn === null || input.caller.turnId === null) throw new Error("a turn's call");
  return {
    caller: input.caller,
    turn: {
      ...request.turn,
      id: input.caller.turnId,
      handleId: input.handleId,
      eventIds: [input.eventId],
      traceId: input.caller.traceId,
    },
    input: { kind: "coreOnly" },
    core: [input.action],
    now: input.now,
  };
}

/**
 * Ben's START as the core action of his own turn after stop-recorded.json: start-recorded.json's text (his phone,
 * his word, his text's event and trace), with his turn's caller naming no business as his STOP's does, at the time
 * it came. The turn's commit writes its reply, so it carries no actor's send.
 */
function startTurn(): GateAndCommitRequest {
  const { request } = startRecorded();
  const eventId = request.inboundEventId;
  if (eventId === null || request.sentByActor === null) throw new Error("start-recorded.json's text");
  const caller = turnCaller(START_TURN, null, request.caller.personId, request.caller.traceId);
  return coreOnlyTurn({
    caller,
    handleId: "handle-ben",
    eventId,
    action: { call: "recordStopOrStart", request: { ...request, caller, sentByActor: null } },
    now: request.sentByActor.at,
  });
}

/**
 * Sam's pause of Alex as the core action of Sam's own turn at the barbershop: flag-paused.json's flag, action,
 * target and business, with his turn's caller, at the fixture's time.
 */
function pauseTurn(): GateAndCommitRequest {
  const { request, given } = flagPaused();
  const caller = turnCaller(
    PAUSE_TURN,
    request.caller.businessId,
    request.caller.personId,
    `trace-${PAUSE_TURN}`,
  );
  return coreOnlyTurn({
    caller,
    handleId: "handle-sam",
    eventId: "evt-sam-pause",
    action: { call: "setRecordFlag", request: { ...request, caller } },
    now: given.now,
  });
}

function stopActionOf(request: GateAndCommitRequest): StopAction {
  const action = request.core.find((each): each is StopAction => each.call === "recordStopOrStart");
  if (action === undefined) throw new Error("the turn carries a STOP or START");
  return action;
}

function pauseActionOf(request: GateAndCommitRequest): PauseAction {
  const action = request.core.find((each): each is PauseAction => each.call === "setRecordFlag");
  if (action === undefined) throw new Error("the turn carries a record flag");
  return action;
}

function flagsActionOf(request: GateAndCommitRequest): FlagsAction {
  const action = request.core.find(
    (each): each is FlagsAction => each.call === "recordStopOrStart" || each.call === "setRecordFlag",
  );
  if (action === undefined) throw new Error("the turn carries a flags call");
  return action;
}

/**
 * The world before stop-recorded.json (T-317's): K-04's and K-29's seeds, Ben's mobile the fixtures' number, its
 * chat open (he has texted Rosie's number), not stopped, at version 3 (his STOP answers phoneVersion 4).
 */
function benWorld(): SafetyWorld {
  const world = safetyWorldOf();
  world.flags.record = withPhones(withHandleAddress(world.flags.record, "handle-ben", BEN), [
    phoneRow("handle-ben", BEN, {
      chatOpen: true,
      chatOpenAt: new Date("2026-10-05T17:00:00Z"),
      chatWay: "imessage",
      version: 3,
    }),
  ]);
  return world;
}

/** The flags port as the wiring binds it, over the world, with the ids K-09's fixtures name; `extra` adds more. */
function portOn(world: SafetyWorld, extra: Partial<CoreFlagsDeps<unknown>> = {}): CoreFlagsDeps<unknown> {
  return flagsPortOn(world.flags, { ids: FIXTURE_IDS, ...extra });
}

/** runCore's ports over the world: the safety service's doubles (core.test.ts's) and the flags port, or none. */
function depsOn(world: SafetyWorld, flags: CoreFlagsDeps<unknown> | null = portOn(world)): CoreDeps<unknown> {
  const { deps } = coreDoublesOn(world, { ids: BEN_SAFETY_IDS });
  return flags === null ? deps : { ...deps, flags };
}

/** What K-05 answered for stop-recorded.json's commit, as its outcome states it. */
function k05AnswerOf(outcome: Committed): CommitTurnResponse {
  return {
    result: "committed",
    turnId: outcome.turnId,
    committedAt: outcome.committedAt,
    repeated: false,
    committed: copy(outcome.written),
  };
}

/** gateAndCommit through runCore as built and limits 1 to 6 as passing doubles, on a K-05 fake each call shares. */
function commitOn(
  k05: K05Fake,
  request: GateAndCommitRequest,
  deps: CoreDeps<unknown>,
  call = callContext(BARBERSHOP),
): Promise<GateAndCommitAnswer> {
  const { ports } = doublePorts({ k05 });
  return gateAndCommit(copy(request), call, {
    limits: scriptedLimits(),
    ports: { ...ports, runCore: createRunCore(deps) },
  });
}

/** The Tool API base answering gateAndCommit through the commit, runCore as built, and the core actions it ran. */
function baseWith(deps: CoreDeps<unknown>, k05: K05Fake) {
  const runCore = createRunCore(deps);
  const ran: string[] = [];
  const ports: CommitPorts = {
    ...doublePorts({ k05 }).ports,
    runCore(action, turn, open) {
      ran.push(action.call);
      return runCore(action, turn, open);
    },
  };
  const scope = recordingScope();
  const handlers = recordingHandlers("gateAndCommit", (given, context) =>
    gateAndCommit(given as GateAndCommitRequest, context, { limits: scriptedLimits(), ports }),
  );
  return { api: createToolApi({ validator, scope, handlers }), scope, ran };
}

/** stop-recorded.json's turn run through runCore, its writes applied as K-05 would: Ben's phone is stopped. */
async function stopCommitted(world: SafetyWorld): Promise<void> {
  const { request } = stopRecorded();
  const runCore = createRunCore(depsOn(world));
  for (const action of request.core) {
    const run = await runCore(action, turnContextOf(request), copy(NOTHING_OPEN));
    applySafetyWrites(world, run.writes.state, run.writes.messages);
  }
}

/** A port that must never be read: it throws when a service asks for it. */
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
  // Nothing runCore or the flags calls do writes a log line (K-08 v1: never a person's words, a number or an address).
  expect(warn).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------

describe("stop-recorded.json: Ben's STOP rides in his turn's one commit (K-09 v1; RULES 7.2; MC C1)", () => {
  it("runCore answers each core action of his turn as the fixture does: his text's record, then his STOP", async () => {
    const { request, outcome } = stopRecorded();
    const runCore = createRunCore(depsOn(benWorld()));
    const turn = turnContextOf(request);
    expect(request.core.map((action) => action.call)).toEqual(["recordSafetyOutcome", "recordStopOrStart"]);
    const runs: CoreRun[] = [];
    for (const action of request.core) runs.push(await runCore(action, turn, copy(NOTHING_OPEN)));
    expect(runs.map((run) => run.result)).toEqual(outcome.core);
  });

  it("the STOP's run is T-317's own, handed over as it is: K-29's STOP row for every business, the phone stopped, one reply", async () => {
    const { request } = stopRecorded();
    const world = benWorld();
    const flags = portOn(world);
    const action = stopActionOf(request);
    const turn = turnContextOf(request);
    const run = await createRunCore(depsOn(world, flags))(action, turn, copy(NOTHING_OPEN));
    // What stopOrStartCore gives on the same port, but for its reply row's id beside the run: its result names that row.
    const direct = await stopOrStartCore(action, turn, flags);
    expect(run).toEqual({ result: direct.result, writes: direct.writes });
    expect(direct.replyRowId).toBe("out-ben-stop-reply");
    expect(run.result.call === "recordStopOrStart" ? run.result.response?.reply : null).toEqual({
      fixedLineId: "stopReply",
      outboxRowId: direct.replyRowId,
    });
    // One texts row with no business, revoked, under the turn at its time (MC C1); the phone's one row stopped with its
    // chat closed, compared and set on version 3 (RULES 4.1b); the one reply, back to the mobile it came from.
    expect(run.writes.state).toMatchObject([
      {
        op: "insert",
        table: "consents",
        values: {
          id: "consent-ben-stop",
          person_id: "person-ben",
          business_id: null,
          kind: "texts",
          revoked: true,
          turn_id: "turn-ben-stop",
          at: request.now,
        },
      },
      {
        op: "update",
        table: "phones",
        key: { number: BEN },
        expectVersion: 3,
        set: { stopped: true, chat_open: false, stop_at: request.now },
      },
    ]);
    expect(run.writes.state).toHaveLength(2);
    expect(
      run.writes.messages.map((row) => [row.id, row.recipientHandleId, row.businessId, row.sendClass]),
    ).toEqual([["out-ben-stop-reply", "handle-ben", null, "quick_reply"]]);
    // A STOP arms no clock row of its own.
    expect(run.writes).not.toHaveProperty("clocks");
  });

  it("the STOP's result passes K-09 v1.5's response check without businessesTold (optional since v1.1)", async () => {
    const { request } = stopRecorded();
    const run = await createRunCore(depsOn(benWorld()))(
      stopActionOf(request),
      turnContextOf(request),
      copy(NOTHING_OPEN),
    );
    if (run.result.call !== "recordStopOrStart" || run.result.response === null) throw new Error("recorded");
    expect(run.result.error).toBeNull();
    expect(validator.check("recordStopOrStart", "response", run.result.response)).toEqual([]);
    expect(run.result.response).not.toHaveProperty("businessesTold");
  });

  it("the turn's one commit carries the STOP beside the record: one K-05 request under the turn's id, answered as the fixture's outcome", async () => {
    const { request, outcome } = stopRecorded();
    const k05 = k05Fake({ answers: [k05AnswerOf(outcome)] });
    const call = callContext(BARBERSHOP);
    const answer = await commitOn(k05, request, depsOn(benWorld()), call);
    expect(answer).toEqual(outcome);
    // One request, under the turn's own row, K-05 v1.1 taking it (the fake checks every request it is sent).
    expect(k05.requests).toHaveLength(1);
    const [sent] = k05.requests;
    if (sent === undefined) throw new Error("one commit was sent");
    expect(sent.turn).toEqual(request.turn);
    expect(contractChecks().k05("commitTurn.request", sent)).toEqual([]);
    // The record's row, the STOP's consent row and phone row, and its reply, each with its event-log entry.
    expect(sent.writes.state.map((write) => write.table)).toEqual(["safety_outcomes", "consents", "phones"]);
    expect(sent.writes.outboxRows.map((row) => row.id)).toEqual(["out-ben-stop-reply"]);
    expect(sent.writes.events.map((entry) => [entry.kind, entry.rowId])).toEqual([
      ["safety_outcome.recorded", "safety-outcome-ben-0007"],
      ["consent.withdrawn", "consent-ben-stop"],
      ["phone.stopped", "handle-ben"],
      ["outbox_row.created", "out-ben-stop-reply"],
    ]);
    // The STOP's entries as they land in K-04's event_log, held to K-08 v1.1. (The record's own entry carries its sealed
    // words as K-05's base64, which the database writes as bytea: eventLogRowsOf does not convert it.)
    const rows = eventLogRowsOf(sent, outcome.committedAt).filter(
      (row) => row.table_name !== "safety_outcomes",
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(contractChecks().k08("eventLogRow", row), String(row.id)).toEqual([]);
    // The call's span keeps the rows K-05 wrote: tables and ids, never the number.
    expect(call.span.rows).toEqual([
      { table: "phones", id: "handle-ben" },
      { table: "outbox_rows", id: "out-ben-stop-reply" },
    ]);
  });

  it("a STOP refused by its rule (a number not the turn's phone) answers its error and writes nothing; the turn commits", async () => {
    const { request } = stopRecorded();
    const other = "+15555550102";
    stopActionOf(request).request.phoneNumber = other;
    const k05 = k05Fake();
    const answer = await commitOn(k05, request, depsOn(benWorld()));
    if ("error" in answer || answer.result !== "committed") throw new Error("the turn commits");
    const [, refused] = answer.core;
    expect(refused).toEqual({
      call: "recordStopOrStart",
      response: null,
      error: { error: "notFromThatPhone", phoneNumber: other },
    });
    expect(validator.check("recordStopOrStart", "errors", refused?.error)).toEqual([]);
    // Only the record's row is written: the refused STOP wrote nothing, and stopped nothing but itself.
    const [sent] = k05.requests;
    expect(sent?.writes.state.map((write) => write.table)).toEqual(["safety_outcomes"]);
    expect(sent?.writes.outboxRows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("start-recorded.json: Ben's START, carried in his own turn after his STOP (RULES 7.5; MC C1)", () => {
  it("the fixture's own request, a write on return made alone, never rides in a turn's commit: runCore refuses it first", async () => {
    const world = benWorld();
    const request = startTurn();
    const alone: CoreAction = { call: "recordStopOrStart", request: startRecorded().request };
    const deps = depsOn(world, portOn(world, { reader: unread, messagesReader: unread }));
    await expect(
      createRunCore(deps)(alone, turnContextOf(request), copy(NOTHING_OPEN)),
    ).rejects.toMatchObject({ name: "CommitRefusedError", fault: "callerNotTurn" });
  });

  it("in his turn it answers start-recorded.json, but for the reply, which his turn's commit writes rather than the actor", async () => {
    const world = benWorld();
    await stopCommitted(world);
    const start = startRecorded();
    const request = startTurn();
    // His turn is a gateAndCommit request K-09 v1.5 takes, as stop-recorded.json's is.
    expect(validator.check("gateAndCommit", "request", request)).toEqual([]);
    const run = await createRunCore(depsOn(world))(
      stopActionOf(request),
      turnContextOf(request),
      copy(NOTHING_OPEN),
    );
    expect(run.result).toEqual({
      call: "recordStopOrStart",
      response: {
        ...start.outcome,
        reply: { fixedLineId: "startReply", outboxRowId: "out-ben-start-reply" },
      },
      error: null,
    });
    expect(validator.check("recordStopOrStart", "response", run.result.response)).toEqual([]);
    // A texts row for every business at the time his START came, under his turn; the phone started with its chat open,
    // compared and set on version 4 (after his STOP); the start reply back to the mobile it came from.
    const at = start.request.sentByActor?.at;
    expect(at).toBe("2026-10-22T14:05:11Z");
    expect(run.writes.state).toMatchObject([
      {
        op: "insert",
        table: "consents",
        values: {
          id: "consent-ben-start",
          person_id: "person-ben",
          business_id: null,
          kind: "texts",
          revoked: false,
          channel: "text",
          turn_id: START_TURN,
          at,
        },
      },
      {
        op: "update",
        table: "phones",
        key: { number: BEN },
        expectVersion: 4,
        set: { stopped: false, chat_open: true, start_at: at },
      },
    ]);
    expect(run.writes.state).toHaveLength(2);
    expect(
      run.writes.messages.map((row) => [row.id, row.recipientHandleId, row.businessId, row.sendClass]),
    ).toEqual([["out-ben-start-reply", "handle-ben", null, "quick_reply"]]);
    // Written as K-05 writes it, the phone answers the fixture's: started, its chat open, at version 5.
    applySafetyWrites(world, run.writes.state, run.writes.messages);
    expect(world.flags.record.phones.find((phone) => phone.handleId === "handle-ben")).toMatchObject({
      stopped: false,
      chatOpen: true,
      startAt: new Date("2026-10-22T14:05:11Z"),
      version: start.outcome.phoneVersion,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("flag-paused.json: Sam's pause of Alex, carried in his own turn (A3-48; S11-62; arch 03 line 177)", () => {
  it("the fixture's own request, the owner portal's made alone, never rides in a turn's commit: runCore refuses it first", async () => {
    const world = benWorld();
    const request = pauseTurn();
    const alone: CoreAction = { call: "setRecordFlag", request: flagPaused().request };
    const deps = depsOn(world, portOn(world, { reader: unread, visits: { visitsOf: unread } }));
    await expect(
      createRunCore(deps)(alone, turnContextOf(request), copy(NOTHING_OPEN)),
    ).rejects.toMatchObject({ name: "CommitRefusedError", fault: "callerNotTurn" });
  });

  it("in Sam's turn it answers flag-paused.json, its call-off clock in the run's writes as the service armed it (withClocks)", async () => {
    const paused = flagPaused();
    const request = pauseTurn();
    // Sam's turn is a gateAndCommit request K-09 v1.5 takes.
    expect(validator.check("gateAndCommit", "request", request)).toEqual([]);
    const world = benWorld();
    const flags = portOn(world, { visits: NOV14_VISITS });
    const action = pauseActionOf(request);
    const turn = turnContextOf(request);
    // The service plans the pause with its call-off clock row beside its writes (S11-62), which UnitWrites lists apart.
    const planned = await recordFlagCore(action, turn, flags);
    expect(planned.clocks).toEqual([CALL_OFF]);
    expect(planned.run.writes).not.toHaveProperty("clocks");
    // runCore hands it over in the run's writes as given, and changes nothing more of the run.
    const run = await createRunCore(depsOn(world, flags))(action, turn, copy(NOTHING_OPEN));
    expect(run).toEqual({
      result: planned.run.result,
      writes: { ...planned.run.writes, clocks: planned.clocks },
    });
    expect(run.result).toEqual({ call: "setRecordFlag", response: paused.outcome, error: null });
    expect(validator.check("setRecordFlag", "response", run.result.response)).toEqual([]);
    expect(run.writes.state).toEqual([
      {
        op: "insert",
        table: "pauses",
        values: {
          id: "pause-alex-lees",
          business_id: BARBERSHOP,
          target: "person",
          person_id: "person-alex",
          set_by_turn_id: PAUSE_TURN,
          set_at: paused.given.now,
        },
      },
    ]);
    expect(run.writes.stateEvents.map((entry) => [entry.kind, entry.rowId, entry.actorPersonId])).toEqual([
      ["pause.set", "pause-alex-lees", "person-sam"],
    ]);
  });

  it("the turn's one commit writes the pause with its call-off clock row and one entry each, under the turn's id; K-05 v1.1 and K-08 v1.1 take them", async () => {
    const request = pauseTurn();
    const world = benWorld();
    const k05 = k05Fake();
    const call = callContext(BARBERSHOP);
    const answer = await commitOn(k05, request, depsOn(world, portOn(world, { visits: NOV14_VISITS })), call);
    if ("error" in answer || answer.result !== "committed") throw new Error("the turn commits");
    expect(answer.core).toEqual([{ call: "setRecordFlag", response: flagPaused().outcome, error: null }]);
    expect(k05.requests).toHaveLength(1);
    const [sent] = k05.requests;
    if (sent === undefined) throw new Error("one commit was sent");
    expect(sent.turn.id).toBe(PAUSE_TURN);
    expect(contractChecks().k05("commitTurn.request", sent)).toEqual([]);
    expect(sent.writes.state.map((write) => write.table)).toEqual(["pauses"]);
    // The call-off clock row as the service armed it, the turn's only clock row (it asks nothing), with its one entry.
    expect(sent.writes.clockRows).toEqual({ make: [CALL_OFF], cancel: [] });
    expect(sent.writes.events.map((entry) => [entry.kind, entry.rowId])).toEqual([
      ["pause.set", "pause-alex-lees"],
      ["clock_row.created", CALL_OFF.id],
    ]);
    const rows = eventLogRowsOf(sent, "2026-10-23T15:00:01Z");
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(contractChecks().k08("eventLogRow", row), String(row.id)).toEqual([]);
    // K-05 wrote both in that one commit; the answer's `written` lists none of a core action's rows (commit.ts default
    // 9), and the call's span keeps them.
    expect(k05.commits).toEqual([
      {
        turnId: PAUSE_TURN,
        written: [
          { table: "pauses", rowId: "pause-alex-lees", version: 1 },
          { table: "clock_rows", rowId: CALL_OFF.id, version: 1 },
        ],
      },
    ]);
    expect(answer.written.written).toEqual([]);
    expect(call.span.rows).toEqual([
      { table: "pauses", id: "pause-alex-lees" },
      { table: "clock_rows", id: CALL_OFF.id },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("the same action twice gives the same writes (a repeated turn runs runCore again before K-05 answers)", () => {
  it("Ben's STOP and Sam's pause, each twice with nothing committed between: the same result and writes, the clock rows among them", async () => {
    for (const [request, extra] of [
      [stopRecorded().request, {}],
      [pauseTurn(), { visits: NOV14_VISITS }],
    ] as const) {
      const world = benWorld();
      const runCore = createRunCore(depsOn(world, portOn(world, extra)));
      const action = flagsActionOf(request);
      const first = await runCore(action, turnContextOf(request), copy(NOTHING_OPEN));
      const again = await runCore(action, turnContextOf(request), copy(NOTHING_OPEN));
      expect(again, action.call).toEqual(first);
      expect(first.result.error, action.call).toBeNull();
      expect(first.writes.state.length, action.call).toBeGreaterThan(0);
    }
  });

  it("once the first is committed, the same action answers it as repeated and writes nothing, no clock row either", async () => {
    // Ben's STOP: the same consent row, phone and reply named, nothing written again.
    const { request } = stopRecorded();
    const world = benWorld();
    const runCore = createRunCore(depsOn(world));
    const stop = stopActionOf(request);
    const first = await runCore(stop, turnContextOf(request), copy(NOTHING_OPEN));
    applySafetyWrites(world, first.writes.state, first.writes.messages);
    const again = await runCore(stop, turnContextOf(request), copy(NOTHING_OPEN));
    expect(again.result).toEqual({
      ...first.result,
      response: { ...first.result.response, repeated: true },
    });
    expect(again.writes.state).toEqual([]);
    expect(again.writes.stateEvents).toEqual([]);
    expect(again.writes.messages).toEqual([]);
    // Sam's pause: the same pause named, no call-off clock armed again.
    const pause = pauseTurn();
    const flags = portOn(world, { visits: NOV14_VISITS });
    const pauseCore = createRunCore(depsOn(world, flags));
    const set = await pauseCore(pauseActionOf(pause), turnContextOf(pause), copy(NOTHING_OPEN));
    expect(set.writes.clocks).toEqual([CALL_OFF]);
    applySafetyWrites(world, set.writes.state);
    const setAgain = await pauseCore(pauseActionOf(pause), turnContextOf(pause), copy(NOTHING_OPEN));
    expect(setAgain.result).toEqual({
      call: "setRecordFlag",
      response: { rowId: "pause-alex-lees", version: 1, callOffClockRowIds: [], repeated: true },
      error: null,
    });
    expect(setAgain.writes.state).toEqual([]);
    expect(setAgain.writes).not.toHaveProperty("clocks");
  });

  it("Ben's turn run again on one K-05: the same request, committed once, the rerun answered repeated", async () => {
    const { request } = stopRecorded();
    const k05 = k05Fake();
    const deps = depsOn(benWorld());
    const first = await commitOn(k05, request, deps);
    const again = await commitOn(k05, request, deps);
    expect(first).toMatchObject({ result: "committed", repeated: false });
    expect(again).toMatchObject({ result: "committed", repeated: true, written: { written: [] } });
    expect(k05.requests).toHaveLength(2);
    expect(k05.requests[1]).toEqual(k05.requests[0]);
    expect(k05.commits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("with no flags port bound, each answers notBuilt (portNotWired) and nothing is read or written (DL-864 note 1)", () => {
  it("runCore: Ben's STOP, his START and Sam's pause each answer notBuilt by name, before anything is read", async () => {
    const { deps } = coreDoublesOn(benWorld(), {
      reader: unread,
      sealer: unread,
      flagsReader: unread,
      messagesReader: unread,
    });
    expect(deps).not.toHaveProperty("flags");
    const runCore = createRunCore(deps);
    for (const request of [stopRecorded().request, startTurn(), pauseTurn()]) {
      const action = flagsActionOf(request);
      const refused = await runCore(action, turnContextOf(request), copy(NOTHING_OPEN)).catch(
        (thrown: unknown) => thrown,
      );
      expect(refused, action.call).toBeInstanceOf(CoreNotBuiltError);
      expect(refused, action.call).toMatchObject({
        core: action.call,
        gap: "portNotWired",
        seam: "runCore",
        call: "gateAndCommit",
      });
      // The commit's own notBuilt: the Tool API base answers gateAndCommit notBuilt and rolls the call back.
      expect(refused, action.call).toBeInstanceOf(CommitNotBuiltError);
      expect(refused, action.call).toBeInstanceOf(NotBuiltError);
    }
  });

  it("through the Tool API base, Ben's STOP turn answers notBuilt: nothing goes to K-05, and the call rolls back", async () => {
    // stop-recorded.json with the turn's caller naming the barbershop (the turn face's), its core actions' naming none.
    const { request } = stopRecorded();
    request.caller = { ...request.caller, businessId: BARBERSHOP };
    const k05 = k05Fake();
    const { api, scope, ran } = baseWith(depsOn(benWorld(), null), k05);
    const answer = await api.call("gateAndCommit", request, traceFor(request).trace);
    expect(answer).toEqual({ error: "notBuilt", call: "gateAndCommit" });
    expect(ran).toEqual(["recordSafetyOutcome", "recordStopOrStart"]);
    expect(k05.requests).toEqual([]);
    expect(scope.events.at(-1)).toEqual({ what: "rollback" });
  });

  it("a wiring that leaves one of its four ports out is not bound either: never the service's default reader on the call's transaction", async () => {
    const world = benWorld();
    // The call's transaction, as the service's default reader would take it (a postgres.js transaction is a function).
    const reads: unknown[] = [];
    const transaction = (...args: unknown[]): never => {
      reads.push(args);
      throw new Error("the call's transaction is never read");
    };
    for (const request of [stopRecorded().request, pauseTurn()]) {
      const action = flagsActionOf(request);
      const turn = { ...turnContextOf(request), repo: transaction };
      for (const left of ["reader", "messagesReader", "ids", "events"] as const) {
        const flags = Object.fromEntries(Object.entries(portOn(world)).filter(([key]) => key !== left));
        const deps = { ...depsOn(world, null), flags } as unknown as CoreDeps<unknown>;
        const refused = await createRunCore(deps)(action, turn, copy(NOTHING_OPEN)).catch(
          (thrown: unknown) => thrown,
        );
        expect(refused, `${action.call} without ${left}`).toBeInstanceOf(CoreNotBuiltError);
        expect(refused, `${action.call} without ${left}`).toMatchObject({
          core: action.call,
          gap: "portNotWired",
        });
      }
      // Bound whole, the same call reads through the wiring's port alone.
      const run = await createRunCore(depsOn(world))(action, turn, copy(NOTHING_OPEN));
      expect(run.result.error, action.call).toBeNull();
    }
    expect(reads).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("each flags call rides as the turn's own call (default 3), naming no business or the call's (default 6)", () => {
  it("a caller that is not the turn's, or names another turn or trace, is refused before anything is read", async () => {
    const world = benWorld();
    const runCore = createRunCore(
      depsOn(world, portOn(world, { reader: unread, messagesReader: unread, visits: { visitsOf: unread } })),
    );
    const cases: [Partial<K09.Caller>, string][] = [
      [{ kind: "agent" }, "callerNotTurn"],
      [{ turnId: "turn-another" }, "turnIdMismatch"],
      [{ traceId: "trace-another" }, "traceIdMismatch"],
    ];
    for (const request of [stopRecorded().request, pauseTurn()]) {
      for (const [change, fault] of cases) {
        const action = copy(flagsActionOf(request));
        action.request.caller = { ...action.request.caller, ...change };
        const refused = await runCore(action, turnContextOf(request), copy(NOTHING_OPEN)).catch(
          (thrown: unknown) => thrown,
        );
        expect(refused, `${action.call} ${fault}`).toBeInstanceOf(CommitRefusedError);
        expect(refused, `${action.call} ${fault}`).toMatchObject({ fault });
      }
    }
  });

  it("a caller naming another business than the call's is refused before anything is read (otherBusiness), naming no value", async () => {
    const world = benWorld();
    const runCore = createRunCore(
      depsOn(world, portOn(world, { reader: unread, messagesReader: unread, visits: { visitsOf: unread } })),
    );
    for (const request of [stopRecorded().request, pauseTurn()]) {
      const action = copy(flagsActionOf(request));
      action.request.caller = { ...action.request.caller, businessId: YOGA_STUDIO };
      const refused = await runCore(action, turnContextOf(request), copy(NOTHING_OPEN)).catch(
        (thrown: unknown) => thrown,
      );
      expect(refused, action.call).toBeInstanceOf(CoreRefusedError);
      expect(refused, action.call).toMatchObject({ core: action.call, fault: "otherBusiness" });
      const { message } = refused as Error;
      expect(message).not.toContain(YOGA_STUDIO);
      expect(message).not.toContain("5555550131");
    }
  });

  it("a STOP whose caller names no business rides in a turn whose caller names the barbershop (the guard's replies): through the base it commits", async () => {
    // stop-recorded.json with the turn's caller naming the barbershop (the turn face's), its core actions' naming none
    // (runtime/src/guard/replies/replies.ts's caller; DL-864 note 3).
    const { request, outcome } = stopRecorded();
    request.caller = { ...request.caller, businessId: BARBERSHOP };
    expect(request.core.map((action) => action.request.caller.businessId)).toEqual([null, null]);
    const k05 = k05Fake({ answers: [k05AnswerOf(outcome)] });
    const { api, scope, ran } = baseWith(depsOn(benWorld()), k05);
    // The base holds the answer to K-09 v1.5's gateAndCommit response, the STOP's core result within it.
    const answer = await api.call("gateAndCommit", request, traceFor(request).trace);
    expect(answer).toEqual(outcome);
    expect(ran).toEqual(["recordSafetyOutcome", "recordStopOrStart"]);
    expect(k05.requests).toHaveLength(1);
    expect(scope.events.at(-1)).toEqual({ what: "commit" });
  });
});
