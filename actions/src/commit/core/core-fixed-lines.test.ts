// T-1414's proofs (the card's "Proves it with", with the lead's notes, DL-864, DL-871 and DL-872, which bind it):
// runCore sends sendFixedLine to the fixed-lines service (domain/fixed-lines: sendFixedLineCore) through the flags port
// the wiring binds, here T-1163's fake over T-317's in-memory reads (doubles for the services' ports only, never for
// runCore or a service under test), on the frozen contracts' fixtures (K-09 v1 stop-recorded.json; K-04 v1's and K-29
// v1's seeds), never a database:
//   - HELP to a phone that is not stopped gives one quick_reply row, fixedLineId helpReply, no business, the answer
//     {outboxRowId, repeated false} valid against K-09 v1 sendFixedLine.response;
//   - a stopped phone answers phoneStopped and writes nothing;
//   - the same turn twice gives the same writes, and the same turn again answers repeated;
//   - HELP, HELP and STOP in one turn commit once, with one HELP row and the one stop record (DL-871);
//   - with no flags port it answers notBuilt (portNotWired; core.test.ts's T-1140 test holds it among the flags calls);
//   - each HELP is the turn's own call to the turn's own handle, naming no business or the call's, and a line other
//     than HELP's answers notBuilt (noService).
// Every earlier runCore test is core.test.ts's and core-flags.test.ts's.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type * as K09 from "../../../../contracts/generated/tool-api/tool-api.v1.5";
import {
  YOGA_STUDIO,
  fixtureIds,
  phoneRow,
  stringsIn,
  withHandleAddress,
  withPhones,
} from "../../domain/flags/test-support";
import {
  FixedLineRefusedError,
  HELP_REPLY,
  fixedLineKey,
  fixedLineRowId,
  sendFixedLineCore,
  type FixedLineAction,
} from "../../domain/fixed-lines";
import { helpAction, keywordCaller, keywordTurn } from "../../domain/fixed-lines/test-support";
import {
  BARBERSHOP,
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
  type Committed,
  type CoreAction,
  type CoreResult,
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

/** Ben's mobile as K-09 v1's stop-recorded.json names it, in the 555-01xx range (rule 9). */
const BEN = "+15555550131";

/** The turn Alex's HELP rides in. */
const ALEX_TURN = "turn-alex-help";

/** The ids stop-recorded.json names for Ben's STOP's rows, keyed by its turn; any other row is keyed. */
const FIXTURE_IDS = fixtureIds([
  ["consent", "turn-ben-stop", "person-ben", "consent-ben-stop"],
  ["stopReply", "turn-ben-stop", null, "out-ben-stop-reply"],
]);

/** The id stop-recorded.json names for Ben's text's safety outcome; every other row takes the Worker's keyed id. */
const BEN_SAFETY_IDS = fixtureSafetyIds({ "evt-ben-0007": { outcome: "safety-outcome-ben-0007" } });

type StopAction = Extract<CoreAction, { call: "recordStopOrStart" }>;
type FixedLineResult = Extract<CoreResult, { call: "sendFixedLine" }>;

/** stop-recorded.json (K-09 v1): Ben's core-only turn (his text's record, then his STOP) and its committed outcome. */
function stopRecorded(): { request: GateAndCommitRequest; outcome: Committed } {
  const { request, outcome } = gateExchange("stop-recorded.json");
  if (!("result" in outcome) || outcome.result !== "committed") throw new Error("stop-recorded.json commits");
  return { request, outcome };
}

function stopActionOf(request: GateAndCommitRequest): StopAction {
  const action = request.core.find((each): each is StopAction => each.call === "recordStopOrStart");
  if (action === undefined) throw new Error("the turn carries a STOP");
  return action;
}

/** The request's sendFixedLine actions, in its order, as the request holds them. */
function helpsOf(request: GateAndCommitRequest): FixedLineAction[] {
  return request.core.filter((each): each is FixedLineAction => each.call === "sendFixedLine");
}

function onlyHelp(request: GateAndCommitRequest): FixedLineAction {
  const [help, ...more] = helpsOf(request);
  if (help === undefined || more.length > 0) throw new Error("one HELP");
  return help;
}

/** The first HELP request of a turn whose HELPs share one key. */
function firstHelpOf(request: GateAndCommitRequest): FixedLineAction["request"] {
  const [first] = helpsOf(request);
  if (first === undefined) throw new Error("a HELP");
  return first.request;
}

/**
 * Ben's turn as stop-recorded.json carries it, with two HELP texts' actions beside his STOP (one per text, as the
 * replies build them: T-1416 left HELP one sendFixedLine per text), each from his turn's caller to his handle: the STOP
 * first, as the turn orders a keyword turn's actions (runtime/src/turn/turn.ts coreOf: "the stop and start records
 * first"), or in the texts' own order, the HELPs first.
 */
function helpHelpStop(order: "stopFirst" | "helpsFirst"): GateAndCommitRequest {
  const { request } = stopRecorded();
  const stop = stopActionOf(request);
  const [record] = request.core;
  if (record === undefined) throw new Error("the turn carries its text's record");
  const helps = [
    helpAction(stop.request.caller, "handle-ben"),
    helpAction(stop.request.caller, "handle-ben"),
  ];
  request.core = order === "stopFirst" ? [record, stop, ...helps] : [record, ...helps, stop];
  return request;
}

/** Ben's turn as stop-recorded.json carries it, with a HELP text's action in his STOP's place. */
function benHelpTurn(): GateAndCommitRequest {
  const { request } = stopRecorded();
  const stop = stopActionOf(request);
  const [record] = request.core;
  if (record === undefined) throw new Error("the turn carries its text's record");
  request.core = [record, helpAction(stop.request.caller, "handle-ben")];
  return request;
}

/** Alex's keyword turn of one HELP text, its caller the replies' (no business). */
function alexHelpTurn(): GateAndCommitRequest {
  const caller = keywordCaller(ALEX_TURN, "person-alex");
  return keywordTurn({
    caller,
    handleId: "handle-alex",
    eventIds: ["evt-alex-help"],
    core: [helpAction(caller, "handle-alex")],
  });
}

/**
 * The world before stop-recorded.json (T-317's): K-04's and K-29's seeds, Ben's mobile the fixtures' number, its chat
 * open (he has texted Rosie's number), not stopped, at version 3 (his STOP answers phoneVersion 4).
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

/** A committed answer, or the test fails naming what came back. */
function committedOf(answer: GateAndCommitAnswer): Committed {
  if ("error" in answer || answer.result !== "committed") {
    throw new Error(`not committed: ${JSON.stringify(answer)}`);
  }
  return answer;
}

/** A HELP's core result, its response held to K-09 v1's sendFixedLine.response. */
function helpResultOf(result: CoreResult | undefined): FixedLineResult {
  if (result?.call !== "sendFixedLine") throw new Error("a HELP's result");
  if (result.response !== null) {
    expect(validator.check("sendFixedLine", "response", result.response)).toEqual([]);
  }
  return result;
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
  // Nothing runCore or the fixed-lines service does writes a log line (K-08 v1: never a person's words or a number).
  expect(warn).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------

describe("HELP's reply rides in the keyword turn's one commit (K-09 v1 sendFixedLine; RULES 7.6; DL-864)", () => {
  it("Alex's HELP gives one quick_reply row to his phone, no business, and answers {outboxRowId, repeated false}, valid against K-09 v1", async () => {
    const world = safetyWorldOf();
    const request = alexHelpTurn();
    const action = onlyHelp(request);
    expect(action.request).toMatchObject({
      fixedLineId: HELP_REPLY,
      sendClass: "quick_reply",
      sentByActor: null,
    });
    expect(HELP_REPLY).toBe("helpReply");
    const run = await createRunCore(depsOn(world))(action, turnContextOf(request), copy(NOTHING_OPEN));
    const rowId = await fixedLineRowId(fixedLineKey(ALEX_TURN, action.request));
    expect(run.result).toEqual({
      call: "sendFixedLine",
      response: { outboxRowId: rowId, repeated: false },
      error: null,
    });
    expect(validator.check("sendFixedLine", "response", helpResultOf(run.result).response)).toEqual([]);
    expect(run.writes.messages).toEqual([
      {
        id: rowId,
        recipientHandleId: "handle-alex",
        recipientPersonId: "person-alex",
        businessId: null,
        bookingId: null,
        channel: "imessage",
        sendClass: "quick_reply",
        openQuestionId: null,
        copyOfRowId: null,
        versionsRead: [],
      },
    ]);
    expect(run.writes.state).toEqual([]);
    expect(run.writes.why).toEqual({ step: "S13-32", choice: null });
    // A fixed line arms no clock row of its own.
    expect(run.writes).not.toHaveProperty("clocks");
  });

  it("the HELP's run is the fixed-lines service's own on the flags port's T-307 reads, handed over as it is", async () => {
    const world = safetyWorldOf();
    const request = alexHelpTurn();
    const action = onlyHelp(request);
    const flags = portOn(world, { reader: unread });
    const turn = turnContextOf(request);
    const run = await createRunCore(depsOn(world, flags))(action, turn, copy(NOTHING_OPEN));
    const direct = await sendFixedLineCore(action, turn, flags);
    expect(run).toEqual(direct);
    expect(run.writes.messages).toHaveLength(1);
  });

  it("a stopped phone answers phoneStopped, valid against K-09 v1, and writes nothing (RULES 7.2; MC C1)", async () => {
    // K-04's seed: Ben's phone is stopped (seed-phone-stopped.json).
    const world = safetyWorldOf();
    const request = benHelpTurn();
    const run = await createRunCore(depsOn(world))(
      onlyHelp(request),
      turnContextOf(request),
      copy(NOTHING_OPEN),
    );
    expect(run.result).toEqual({
      call: "sendFixedLine",
      response: null,
      error: { error: "phoneStopped", recipientHandleId: "handle-ben" },
    });
    expect(validator.check("sendFixedLine", "errors", helpResultOf(run.result).error)).toEqual([]);
    expect(run.writes.messages).toEqual([]);
    expect(run.writes.state).toEqual([]);
    expect(run.writes.stateEvents).toEqual([]);
  });

  it("the HELP's turn commits its row in one K-05 request under the turn's id, its entry held to K-08 v1.1; a stopped phone's commits none", async () => {
    const k05 = k05Fake();
    const call = callContext(BARBERSHOP);
    const answer = committedOf(await commitOn(k05, benHelpTurn(), depsOn(benWorld()), call));
    const [record, help] = answer.core;
    expect(record?.call).toBe("recordSafetyOutcome");
    const rowId = helpResultOf(help).response?.outboxRowId;
    expect(rowId).toMatch(/^out-fixed-line-/u);
    expect(k05.requests).toHaveLength(1);
    const [sent] = k05.requests;
    if (sent === undefined) throw new Error("one commit was sent");
    expect(sent.turn.id).toBe("turn-ben-stop");
    expect(contractChecks().k05("commitTurn.request", sent)).toEqual([]);
    expect(
      sent.writes.outboxRows.map((row) => [row.id, row.recipientHandleId, row.businessId, row.sendClass]),
    ).toEqual([[rowId, "handle-ben", null, "quick_reply"]]);
    expect(sent.writes.events.map((entry) => [entry.kind, entry.rowId])).toEqual([
      ["safety_outcome.recorded", "safety-outcome-ben-0007"],
      ["outbox_row.created", rowId],
    ]);
    const rows = eventLogRowsOf(sent, answer.committedAt).filter((row) => row.table_name === "outbox_rows");
    expect(rows).toHaveLength(1);
    for (const row of rows) expect(contractChecks().k08("eventLogRow", row), String(row.id)).toEqual([]);
    // K-05's answer lists the row among its outbox rows, and the call's span keeps it: a table and an id, no number.
    expect(answer.written.outboxRows.map((row) => row.id)).toEqual([rowId]);
    expect(call.span.rows).toContainEqual({ table: "outbox_rows", id: rowId });
    // With Ben's phone stopped (K-04's seed), the same turn commits the record alone.
    const stoppedK05 = k05Fake();
    const stopped = committedOf(await commitOn(stoppedK05, benHelpTurn(), depsOn(safetyWorldOf())));
    expect(helpResultOf(stopped.core[1]).error).toEqual({
      error: "phoneStopped",
      recipientHandleId: "handle-ben",
    });
    expect(stoppedK05.requests[0]?.writes.outboxRows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("once per text: the turn is the key (K-09 v1: a repeat answers repeated; DL-871)", () => {
  it("the same turn twice gives the same writes (a repeated turn runs runCore again before K-05 answers)", async () => {
    const world = benWorld();
    const runCore = createRunCore(depsOn(world));
    for (const request of [alexHelpTurn(), benHelpTurn()]) {
      const action = onlyHelp(request);
      const first = await runCore(action, turnContextOf(request), copy(NOTHING_OPEN));
      const again = await runCore(action, turnContextOf(request), copy(NOTHING_OPEN));
      expect(again).toEqual(first);
      expect(first.result.error).toBeNull();
      expect(first.writes.messages).toHaveLength(1);
    }
  });

  it("HELP then the same turn again answers repeated: the same request, committed once, the rerun naming the same row", async () => {
    const k05 = k05Fake();
    const deps = depsOn(benWorld());
    const first = committedOf(await commitOn(k05, benHelpTurn(), deps));
    const again = committedOf(await commitOn(k05, benHelpTurn(), deps));
    expect(first.repeated).toBe(false);
    expect(again).toMatchObject({ repeated: true, written: { written: [] } });
    // The rerun's HELP builds the same row under the same id; K-05, unique on the turn id, writes nothing again and
    // answers the first commit's outbox rows (fixed-lines.ts default 7; commit.ts default 7).
    expect(k05.requests).toHaveLength(2);
    expect(k05.requests[1]).toEqual(k05.requests[0]);
    expect(k05.commits).toHaveLength(1);
    expect(again.core).toEqual(first.core);
    const rowId = helpResultOf(first.core[1]).response?.outboxRowId;
    expect(again.written.outboxRows.map((row) => row.id)).toEqual([rowId]);
  });

  it("HELP, HELP and STOP in one turn commit once, with one HELP row and the one stop record, whichever comes first", async () => {
    const { outcome } = stopRecorded();
    const [recordResult, stopResult] = outcome.core;
    for (const order of ["stopFirst", "helpsFirst"] as const) {
      const request = helpHelpStop(order);
      const k05 = k05Fake();
      const answer = committedOf(await commitOn(k05, request, depsOn(benWorld())));
      const helps = answer.core.filter((result) => result.call === "sendFixedLine").map(helpResultOf);
      const rowId = await fixedLineRowId(fixedLineKey("turn-ben-stop", firstHelpOf(request)));
      // The first HELP writes the row; the second answers it as repeated, writing nothing (lead note 2, item 4).
      expect(
        helps.map((help) => [help.response, help.error]),
        order,
      ).toEqual([
        [{ outboxRowId: rowId, repeated: false }, null],
        [{ outboxRowId: rowId, repeated: true }, null],
      ]);
      // The record and the STOP answer as stop-recorded.json does: the one stop record, its reply among the rows.
      expect(
        answer.core.filter((result) => result.call !== "sendFixedLine"),
        order,
      ).toEqual([recordResult, stopResult]);
      // One K-05 request, every row id once (never idTwice), committed once.
      expect(k05.requests, order).toHaveLength(1);
      expect(k05.commits, order).toHaveLength(1);
      const [sent] = k05.requests;
      if (sent === undefined) throw new Error("one commit was sent");
      expect(contractChecks().k05("commitTurn.request", sent), order).toEqual([]);
      expect(
        sent.writes.state.map((write) => write.table),
        order,
      ).toEqual(["safety_outcomes", "consents", "phones"]);
      const outboxRows = sent.writes.outboxRows.map((row) => row.id);
      expect(outboxRows, order).toEqual(
        order === "stopFirst" ? ["out-ben-stop-reply", rowId] : [rowId, "out-ben-stop-reply"],
      );
      expect(new Set(outboxRows).size, order).toBe(outboxRows.length);
      expect(
        sent.writes.events.filter((entry) => entry.kind === "outbox_row.created").map((entry) => entry.rowId),
        order,
      ).toEqual(outboxRows);
      expect(
        sent.writes.events.filter((entry) => entry.kind === "consent.withdrawn"),
        order,
      ).toHaveLength(1);
      const rows = eventLogRowsOf(sent, answer.committedAt).filter(
        (row) => row.table_name !== "safety_outcomes",
      );
      for (const row of rows) expect(contractChecks().k08("eventLogRow", row), String(row.id)).toEqual([]);
    }
  });

  it("through the Tool API base, Ben's turn of HELP, HELP and STOP commits, its answer held to K-09 v1.5", async () => {
    // The turn's caller names the barbershop (the turn face's), its core actions' naming none (the replies' caller).
    const request = helpHelpStop("stopFirst");
    request.caller = { ...request.caller, businessId: BARBERSHOP };
    expect(request.core.map((action) => action.request.caller.businessId)).toEqual([null, null, null, null]);
    expect(validator.check("gateAndCommit", "request", request)).toEqual([]);
    const k05 = k05Fake();
    const { api, scope, ran } = baseWith(depsOn(benWorld()), k05);
    const answer = await api.call("gateAndCommit", request, traceFor(request).trace);
    const committed = committedOf(answer as GateAndCommitAnswer);
    expect(ran).toEqual(["recordSafetyOutcome", "recordStopOrStart", "sendFixedLine", "sendFixedLine"]);
    expect(committed.core.map((result) => result.call)).toEqual(ran);
    expect(k05.requests).toHaveLength(1);
    expect(scope.events.at(-1)).toEqual({ what: "commit" });
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("with no flags port bound, HELP answers notBuilt (portNotWired) and nothing is read or written (DL-864; DL-872)", () => {
  it("runCore: Alex's HELP answers notBuilt by name, before anything is read", async () => {
    const { deps } = coreDoublesOn(safetyWorldOf(), {
      reader: unread,
      sealer: unread,
      flagsReader: unread,
      messagesReader: unread,
    });
    expect(deps).not.toHaveProperty("flags");
    const request = alexHelpTurn();
    const refused = await createRunCore(deps)(
      onlyHelp(request),
      turnContextOf(request),
      copy(NOTHING_OPEN),
    ).catch((thrown: unknown) => thrown);
    expect(refused).toBeInstanceOf(CoreNotBuiltError);
    expect(refused).toMatchObject({
      core: "sendFixedLine",
      gap: "portNotWired",
      seam: "runCore",
      call: "gateAndCommit",
    });
    expect(refused).toBeInstanceOf(CommitNotBuiltError);
    expect(refused).toBeInstanceOf(NotBuiltError);
  });

  it("through the Tool API base, Ben's HELP turn answers notBuilt: nothing goes to K-05, and the call rolls back", async () => {
    const request = benHelpTurn();
    request.caller = { ...request.caller, businessId: BARBERSHOP };
    const k05 = k05Fake();
    const { api, scope, ran } = baseWith(depsOn(benWorld(), null), k05);
    const answer = await api.call("gateAndCommit", request, traceFor(request).trace);
    expect(answer).toEqual({ error: "notBuilt", call: "gateAndCommit" });
    expect(ran).toEqual(["recordSafetyOutcome", "sendFixedLine"]);
    expect(k05.requests).toEqual([]);
    expect(scope.events.at(-1)).toEqual({ what: "rollback" });
  });

  it("a wiring that leaves one of its four ports out is not bound either: never a default reader on the call's transaction", async () => {
    const world = safetyWorldOf();
    // The call's transaction, as a default reader would take it (a postgres.js transaction is a function).
    const reads: unknown[] = [];
    const transaction = (...args: unknown[]): never => {
      reads.push(args);
      throw new Error("the call's transaction is never read");
    };
    const request = alexHelpTurn();
    const turn = { ...turnContextOf(request), repo: transaction };
    for (const left of ["reader", "messagesReader", "ids", "events"] as const) {
      const flags = Object.fromEntries(Object.entries(portOn(world)).filter(([key]) => key !== left));
      const deps = { ...depsOn(world, null), flags } as unknown as CoreDeps<unknown>;
      const refused = await createRunCore(deps)(onlyHelp(request), turn, copy(NOTHING_OPEN)).catch(
        (thrown: unknown) => thrown,
      );
      expect(refused, `without ${left}`).toBeInstanceOf(CoreNotBuiltError);
      expect(refused, `without ${left}`).toMatchObject({ core: "sendFixedLine", gap: "portNotWired" });
    }
    // Bound whole, the same call reads through the wiring's port alone.
    const run = await createRunCore(depsOn(world))(onlyHelp(request), turn, copy(NOTHING_OPEN));
    expect(run.result.error).toBeNull();
    expect(reads).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("each HELP is the turn's own call to the turn's own handle; only HELP's line rides in a turn (defaults 3, 6 and 8)", () => {
  it("a caller that is not the turn's, or names another turn or trace, is refused before anything is read", async () => {
    const world = safetyWorldOf();
    const runCore = createRunCore(depsOn(world, portOn(world, { reader: unread, messagesReader: unread })));
    const request = alexHelpTurn();
    const cases: [Partial<K09.Caller>, string][] = [
      [{ kind: "agent" }, "callerNotTurn"],
      [{ turnId: "turn-another" }, "turnIdMismatch"],
      [{ traceId: "trace-another" }, "traceIdMismatch"],
    ];
    for (const [change, fault] of cases) {
      const action = copy(onlyHelp(request));
      action.request.caller = { ...action.request.caller, ...change };
      const refused = await runCore(action, turnContextOf(request), copy(NOTHING_OPEN)).catch(
        (thrown: unknown) => thrown,
      );
      expect(refused, fault).toBeInstanceOf(CommitRefusedError);
      expect(refused, fault).toMatchObject({ fault });
    }
  });

  it("a caller naming another business than the call's is refused before anything is read (otherBusiness); the call's own passes", async () => {
    const world = safetyWorldOf();
    const request = alexHelpTurn();
    const refusing = createRunCore(depsOn(world, portOn(world, { reader: unread, messagesReader: unread })));
    const other = copy(onlyHelp(request));
    other.request.caller = { ...other.request.caller, businessId: YOGA_STUDIO };
    const refused = await refusing(other, turnContextOf(request), copy(NOTHING_OPEN)).catch(
      (thrown: unknown) => thrown,
    );
    expect(refused).toBeInstanceOf(CoreRefusedError);
    expect(refused).toMatchObject({ core: "sendFixedLine", fault: "otherBusiness" });
    expect((refused as Error).message).not.toContain(YOGA_STUDIO);
    const own = copy(onlyHelp(request));
    own.request.caller = { ...own.request.caller, businessId: BARBERSHOP };
    const run = await createRunCore(depsOn(world))(own, turnContextOf(request), copy(NOTHING_OPEN));
    expect(run.result.error).toBeNull();
    expect(run.writes.messages.map((row) => row.businessId)).toEqual([null]);
  });

  it("a line other than HELP's, HELP in another send class, or a request carrying the actor's send, answers notBuilt (noService), reading nothing", async () => {
    const world = safetyWorldOf();
    const runCore = createRunCore(depsOn(world, portOn(world, { reader: unread, messagesReader: unread })));
    const request = alexHelpTurn();
    const outage = copy(onlyHelp(request));
    outage.request.fixedLineId = "outage";
    const sent = copy(onlyHelp(request));
    sent.request.sentByActor = {
      at: "2026-10-21T19:30:05Z",
      fixedLineId: HELP_REPLY,
      linqMessageId: "linq-msg-help",
    };
    // In class safety, HELP's row would pass a STOP of the same commit (limit 8 sends every safety row to a stopped phone).
    const safety = copy(onlyHelp(request));
    safety.request.sendClass = "safety";
    for (const [label, action] of [
      ["outage", outage],
      ["sentByActor", sent],
      ["safety", safety],
    ] as const) {
      const refused = await runCore(action, turnContextOf(request), copy(NOTHING_OPEN)).catch(
        (thrown: unknown) => thrown,
      );
      expect(refused, label).toBeInstanceOf(CoreNotBuiltError);
      expect(refused, label).toMatchObject({ core: "sendFixedLine", gap: "noService" });
    }
  });

  it("a HELP to a handle that is not the turn's fails the turn before anything is read: nothing goes to K-05", async () => {
    const world = safetyWorldOf();
    const request = alexHelpTurn();
    const action = onlyHelp(request);
    action.request.recipientHandleId = "handle-sam";
    const refused = await createRunCore(
      depsOn(world, portOn(world, { reader: unread, messagesReader: unread })),
    )(action, turnContextOf(request), copy(NOTHING_OPEN)).catch((thrown: unknown) => thrown);
    expect(refused).toBeInstanceOf(FixedLineRefusedError);
    expect(refused).toMatchObject({ fault: "notTheTurnsHandle" });
    const k05 = k05Fake();
    await expect(commitOn(k05, request, depsOn(world))).rejects.toMatchObject({ fault: "notTheTurnsHandle" });
    expect(k05.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("no HELP answer, row or entry carries a number, an address or anyone's words (K-08 v1)", () => {
  it("Ben's turn of HELP, HELP and STOP: the HELPs' results, their row and its entry hold ids, flags and labels only", async () => {
    const world = benWorld();
    const privateValues = new Set(world.flags.record.privateValues);
    expect(privateValues).toContain("+15555550101");
    const k05 = k05Fake();
    const answer = committedOf(await commitOn(k05, helpHelpStop("stopFirst"), depsOn(world)));
    const helps = answer.core.filter((result) => result.call === "sendFixedLine").map(helpResultOf);
    const rowIds = new Set(helps.map((help) => help.response?.outboxRowId));
    const [sent] = k05.requests;
    if (sent === undefined) throw new Error("one commit was sent");
    const rows = sent.writes.outboxRows.filter((row) => rowIds.has(row.id));
    const entries = sent.writes.events.filter((entry) => rowIds.has(entry.rowId));
    expect(rows).toHaveLength(1);
    expect(entries).toHaveLength(1);
    const strings = stringsIn([helps, rows, entries]);
    expect(strings.filter((value) => privateValues.has(value))).toEqual([]);
    expect(strings.filter((value) => value.includes("5555550"))).toEqual([]);
    expect(strings).not.toContain(BEN);
  });
});
