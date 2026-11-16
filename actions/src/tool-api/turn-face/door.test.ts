// T-1413's unit proofs (the card's "Proves it with", with lead note 3's conditions, DL-877, which bind the restart): the
// keyword door, the guard's keyword turn that names no business, committed on the runtime side, on K-09 v1's own fixtures
// (stop-recorded.json; start-recorded.json's START as the core action of Ben's own turn, as T-1163's proofs carry it) and
// doubles for the door's ports only (the runtime side's transaction, K-05's reads and commit over T-317's and T-318's
// in-memory world, the same-bytes sealer): the door, the commit, the gate, runCore and the flags and safety services are
// never stood in for. No database (the integration proof is pg/door.int.test.ts):
//   - stop-recorded.json and start-recorded.json through the door give their outcomes, every read on the door's one
//     transaction (C1, C2), the record and the STOP naming no business;
//   - each other no-business shape is answered noBusinessScope or invalidRequest with no transaction opened and nothing
//     read (C3); the base still answers stop-recorded.json noBusinessScope;
//   - a sendFixedLine action (HELP's reply) passes the door and, with T-1414's service merged, commits one quick_reply row
//     naming no business, its answer valid against K-09 v1's sendFixedLine response; after a STOP it answers phoneStopped
//     and writes nothing (lead note 4's pin, moved: DL-881, DL-883; DL-845, no weaker);
//   - a danger outcome answers notBuilt, with nothing written (owner and zone need a business);
//   - a STOP and a START through the door put no run of the number's digits, no address and no consent words into any
//     log line, span, thrown message or answer (C4, with a console spy as commit/core/core-flags.test.ts does);
//   - in a business-scoped turn recordStopOrStart and setRecordFlag stay notBuilt portNotWired, as on main (C5).
// Values come only from the contracts' fixtures and the master's sample cast, in the 555-01xx range (rule 9).

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type * as K09 from "../../../../contracts/generated/tool-api/tool-api.v1.5";
import type { Span } from "../../../../runtime/src/trace";
import type { CommitTurnAnswer, CommitTurnResponse, Committed, GateAndCommitRequest } from "../../commit";
import type { CoreFlagsDeps } from "../../commit/core";
import { sameSealer, type SameSealer } from "../../commit/core/test-support";
import { contractChecks, k05Fake, type K05Fake } from "../../commit/test-support";
import { fixedLineKey, fixedLineRowId } from "../../domain/fixed-lines";
import { helpAction } from "../../domain/fixed-lines/test-support";
import { NO_EVENT_SOURCES, type RecordFlagRequest } from "../../domain/flags";
import {
  fixtureIds,
  flagsReaderOn,
  k09Fixture,
  messagesReaderOn,
  phoneRow,
  withHandleAddress,
  withPhones,
} from "../../domain/flags/test-support";
import { NOT_TOLD_YET, PLUGIN_LISTS_NO_STOP_WORDS } from "../../domain/safety";
import {
  BARBERSHOP,
  applySafetyWrites,
  fixtureSafetyIds,
  safetyWorldOf,
  type SafetyWorld,
} from "../../domain/safety/test-support";
import { copy } from "../../gate/framework/test-support";
import { NotBuiltError } from "../errors";
import { contractFile, stringsIn, traceFor } from "../test-support";
import { createToolApiValidator } from "../validator";
import {
  bundleV0,
  callDoubles,
  commitContextOf,
  commitS101,
  openHoldsOn,
  type OpenHoldsRead,
} from "./calls-test-support";
import {
  NOTHING_OPEN_AT,
  keywordCommitDeps,
  noBusinessSafetyLines,
  noBusinessSafetyReaderOf,
  pinnedSafetyLines,
  type KeywordCommitBinding,
  type NoBusinessSafetyReads,
} from "./commit";
import {
  KEYWORD_CORE_CALLS,
  createKeywordDoor,
  isKeywordTurn,
  type DoorRuntime,
  type KeywordDoor,
  type KeywordDoorAnswer,
} from "./door";
import {
  BEN,
  START_TURN,
  k05AnswerOf,
  leaksIn,
  startRecorded,
  startTurn,
  stopRecorded,
} from "./door-test-support";
import { TurnFaceReadError } from "./errors";
import { TURN_RECORDS_GATE, createTurnFace } from "./turn-face";

type Json = Record<string, unknown>;

const validator = createToolApiValidator();

/** The ids K-09's fixtures name for each call's rows, keyed by the turn that carries it; any other row is keyed. */
const FIXTURE_IDS = fixtureIds([
  ["consent", "turn-ben-stop", "person-ben", "consent-ben-stop"],
  ["stopReply", "turn-ben-stop", null, "out-ben-stop-reply"],
  ["consent", START_TURN, "person-ben", "consent-ben-start"],
  ["stopReply", START_TURN, null, "out-ben-start-reply"],
]);

/** The ids stop-recorded.json names for Ben's text's record, and the one this file names for his START text's. */
const BEN_SAFETY_IDS = fixtureSafetyIds({
  "evt-ben-0007": { outcome: "safety-outcome-ben-0007" },
  "evt-ben-0011": { outcome: "safety-outcome-ben-0011" },
});

// ---------------------------------------------------------------------------------------------------------------
// The world and K-05's answers

/** What K-05 answers for Ben's START turn, named as stop-recorded.json names Ben's phone row (by its handle id). */
function startK05Answer(): CommitTurnResponse {
  const { request } = startRecorded();
  return {
    result: "committed",
    turnId: START_TURN,
    committedAt: request.sentByActor?.at ?? "2026-10-22T14:05:11Z",
    repeated: false,
    committed: {
      written: [{ table: "phones", rowId: "handle-ben", version: 5 }],
      outboxRows: [{ id: "out-ben-start-reply", commitSeq: 2 }],
      promoted: [],
    },
  };
}

/**
 * The world before stop-recorded.json (T-317's, as T-1163's proofs build it): K-04's and K-29's seeds, Ben's mobile the
 * fixtures' number, its chat open (he has texted Rosie's number), not stopped, at version 3.
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

// ---------------------------------------------------------------------------------------------------------------
// The door's ports as doubles

/** The repo the runtime side's double hands the commit: one per transaction, open until it ends. */
interface DoorRepo {
  readonly name: "the door's transaction";
  readonly id: number;
  open: boolean;
}

/** One read a port made: which port, which read, on which transaction's repo, whether it was open, the business named. */
interface DoorRead {
  readonly port: "flags" | "messages" | "safety";
  readonly read: string;
  readonly repo: number;
  readonly open: boolean;
  readonly businessId?: string | null;
}

/** The runtime side's transaction as a double: it writes down each begin, commit and rollback, and hands a fresh repo. */
function recordingRuntime(events: string[], repos: DoorRepo[]): DoorRuntime<DoorRepo> {
  return {
    async withRuntime(work, call) {
      const repo: DoorRepo = { name: "the door's transaction", id: repos.length + 1, open: true };
      repos.push(repo);
      events.push(`begin ${call.call}`);
      try {
        const result = await work(repo);
        events.push("commit");
        return result;
      } catch (error) {
        events.push("rollback");
        throw error;
      } finally {
        repo.open = false;
      }
    },
  };
}

/** A reader whose every read is noted (by its name) as it is made, and then made as the reader makes it. */
function watched<T extends object>(reader: T, note: (read: string) => void): T {
  const entries = Object.entries(reader).map(([name, value]: [string, unknown]) => {
    if (typeof value !== "function") return [name, value];
    const read = (...args: unknown[]): unknown => {
      note(name);
      return (value as (...given: unknown[]) => unknown)(...args);
    };
    return [name, read];
  });
  return Object.fromEntries(entries) as T;
}

/**
 * The flags port as the door binds it (DL-872 item 4), over T-317's and T-307's in-memory reads on the runtime side (no
 * business scope), each read noted with the repo the commit handed it: the ids K-09's fixtures name, no event sources.
 */
function doorFlagsOn(world: SafetyWorld, reads: DoorRead[]): CoreFlagsDeps<DoorRepo> {
  return {
    reader: (repo) =>
      watched(flagsReaderOn(world.flags, null), (read) =>
        reads.push({ port: "flags", read, repo: repo.id, open: repo.open }),
      ),
    messagesReader: (repo) =>
      watched(messagesReaderOn(world.flags, null), (read) =>
        reads.push({ port: "messages", read, repo: repo.id, open: repo.open }),
      ),
    ids: FIXTURE_IDS,
    events: NO_EVENT_SOURCES,
  };
}

/** K-05 v1.4's five record reads in their no-business forms over the world: the rows with no business, each noted. */
function noBusinessReadsOn(world: SafetyWorld, reads: DoorRead[]): NoBusinessSafetyReads<DoorRepo> {
  const note = (read: string, repo: DoorRepo, businessId: null): void => {
    reads.push({ port: "safety", read, repo: repo.id, open: repo.open, businessId });
  };
  const none = (row: { businessId: string | null }): boolean => row.businessId === null;
  return {
    outcomeOfEvent: (repo, { eventId, businessId }) => {
      note("readSafetyOutcomeOfEvent", repo, businessId);
      const found = world.safety.outcomes.find((row) => row.eventId === eventId && none(row)) ?? null;
      return Promise.resolve({ safetyOutcome: found });
    },
    outcome: (repo, { outcomeId, businessId }) => {
      note("readSafetyOutcome", repo, businessId);
      const found = world.safety.outcomes.find((row) => row.id === outcomeId && none(row)) ?? null;
      return Promise.resolve({ safetyOutcome: found });
    },
    hold: (repo, { holdId, businessId }) => {
      note("readSafetyHold", repo, businessId);
      return Promise.resolve({
        hold: world.safety.holds.find((row) => row.id === holdId && none(row)) ?? null,
      });
    },
    holdOfOutcome: (repo, { outcomeId, businessId }) => {
      note("readSafetyHoldOfOutcome", repo, businessId);
      const found = world.safety.holds.find((row) => row.safetyOutcomeId === outcomeId && none(row)) ?? null;
      return Promise.resolve({ hold: found });
    },
    outboxRowWritten: (repo, { outboxRowId, businessId }) => {
      note("readOutboxRowWritten", repo, businessId);
      return Promise.resolve({ written: world.safety.outboxRowIds.includes(outboxRowId) });
    },
  };
}

/** The door over the doubles, and what each saw. */
interface DoorDoubles {
  readonly door: KeywordDoor;
  readonly k05: K05Fake;
  /** The runtime side's begins, commits and rollbacks, in order. */
  readonly events: string[];
  /** The repo of each transaction the runtime side opened. */
  readonly repos: DoorRepo[];
  /** Every read of the flags port and the record reads, in order. */
  readonly reads: DoorRead[];
  readonly openHoldsReads: OpenHoldsRead[];
  readonly sealer: SameSealer;
}

/**
 * The door over the world and a K-05 fake: the runtime side's recording double, the commit as keywordCommitDeps binds
 * it (bundle v0, which the fixtures' turns pin; the barbershop's plug-in, which lists no stop words; nobody told yet), the
 * no-business record reads and readOpenHolds over the world, the same-bytes sealer, and the flags port over the world.
 */
function doorOn(world: SafetyWorld, k05: K05Fake): DoorDoubles {
  const events: string[] = [];
  const repos: DoorRepo[] = [];
  const reads: DoorRead[] = [];
  const openHoldsReads: OpenHoldsRead[] = [];
  const sealer = sameSealer();
  const binding: KeywordCommitBinding<DoorRepo> = {
    bundles: bundleV0(),
    commitTurn: k05.commitTurn,
    readOpenHolds: openHoldsOn(world, openHoldsReads),
    safetyReads: noBusinessReadsOn(world, reads),
    sealer,
    stopWords: PLUGIN_LISTS_NO_STOP_WORDS,
    telling: NOT_TOLD_YET,
    safetyExtra: { ids: BEN_SAFETY_IDS },
  };
  const door = createKeywordDoor<DoorRepo>({
    validator,
    runtime: recordingRuntime(events, repos),
    commit: keywordCommitDeps(binding, doorFlagsOn(world, reads)),
  });
  return { door, k05, events, repos, reads, openHoldsReads, sealer };
}

/** One call through the door, on the request's own trace (or `traceId`), with the spans it left. */
async function through(
  doubles: DoorDoubles,
  request: unknown,
  traceId?: string,
): Promise<{ answer: KeywordDoorAnswer; spans: Span[] }> {
  const { trace, spans } = traceFor(request, traceId);
  const answer = await doubles.door.gateAndCommit(copy(request), NOTHING_OPEN_AT, trace);
  return { answer, spans };
}

/** The turn face over the calls given (its business-scoped gateAndCommit through the Tool API base); no frontier call. */
function faceOver(calls: ReturnType<typeof callDoubles>["calls"]): ReturnType<typeof createTurnFace> {
  return createTurnFace<never>({
    scope: { withBusiness: () => Promise.reject(new Error("the frontier is not called here")) },
    bundles: bundleV0(),
    validator,
    calls,
  });
}

/** The one span a call left; fails the test when there is not exactly one. */
function onlySpan(spans: readonly Span[]): Span {
  expect(spans).toHaveLength(1);
  const [span] = spans;
  if (span === undefined) throw new Error("no span");
  return span;
}

/** The committed answer, held to K-09 v1.5's response. */
function committedOf(answer: KeywordDoorAnswer): Committed {
  expect(validator.check("gateAndCommit", "response", answer)).toEqual([]);
  if (!("result" in answer) || answer.result !== "committed") throw new Error(JSON.stringify(answer));
  return answer;
}

/** Ben's STOP through the door, its writes then applied to the world as K-05 would write them. */
async function stopCommitted(world: SafetyWorld): Promise<void> {
  const { request, outcome } = stopRecorded();
  const doubles = doorOn(world, k05Fake({ answers: [k05AnswerOf(outcome)] }));
  committedOf((await through(doubles, request)).answer);
  const [sent] = doubles.k05.requests;
  if (sent === undefined) throw new Error("the STOP was committed");
  applySafetyWrites(world, sent.writes.state, sent.writes.outboxRows);
}

// ---------------------------------------------------------------------------------------------------------------

describe("stop-recorded.json and start-recorded.json through the keyword door give their outcomes (T-1413)", () => {
  it("Ben's STOP commits as stop-recorded.json states it, in one runtime-side transaction, every read on it (C1, C2)", async () => {
    const { request, outcome } = stopRecorded();
    const doubles = doorOn(benWorld(), k05Fake({ answers: [k05AnswerOf(outcome)] }));
    const { answer, spans } = await through(doubles, request);
    expect(committedOf(answer)).toEqual(outcome);

    // One transaction of the runtime side, opened for gateAndCommit and committed; every read of the flags port and of
    // the record ran on its one repo while it was open, and the flags port's readers were handed that repo alone.
    expect(doubles.events).toEqual(["begin gateAndCommit", "commit"]);
    expect(doubles.repos).toHaveLength(1);
    expect(new Set(doubles.reads.map((read) => read.port))).toEqual(new Set(["flags", "messages", "safety"]));
    for (const read of doubles.reads) expect(read, read.read).toMatchObject({ repo: 1, open: true });
    // The record reads in their no-business forms; what is open read with no business, on the same repo.
    const safety = doubles.reads.filter((read) => read.port === "safety");
    expect(safety.map((read) => read.read)).toContain("readSafetyOutcomeOfEvent");
    for (const read of safety) expect(read.businessId).toBeNull();
    expect(doubles.openHoldsReads).toEqual([
      { request: { handleId: "handle-ben", businessId: null, eventIds: [] }, repo: doubles.repos[0] },
    ]);
    // Ben's words are sealed under his own key (the sealer's own read-only transaction: DL-877 lead note 7).
    expect(doubles.sealer.calls.map((call) => call.forPersonId)).toEqual(["person-ben"]);

    // One K-05 request under Ben's turn: his text's record, the STOP's K-29 texts row and phone row, and the stop reply,
    // none of them naming a business, and every entry with none.
    expect(doubles.k05.requests).toHaveLength(1);
    const [sent] = doubles.k05.requests;
    if (sent === undefined) throw new Error("one commit was sent");
    expect(sent.turn).toEqual(request.turn);
    expect(contractChecks().k05("commitTurn.request", sent)).toEqual([]);
    expect(sent.writes.state.map((write) => write.table)).toEqual(["safety_outcomes", "consents", "phones"]);
    expect(sent.writes.state).toMatchObject([
      {
        op: "insert",
        table: "safety_outcomes",
        values: { id: "safety-outcome-ben-0007", business_id: null },
      },
      {
        op: "insert",
        table: "consents",
        values: {
          id: "consent-ben-stop",
          business_id: null,
          kind: "texts",
          revoked: true,
          turn_id: "turn-ben-stop",
        },
      },
      {
        op: "update",
        table: "phones",
        key: { number: BEN },
        expectVersion: 3,
        set: { stopped: true, chat_open: false },
      },
    ]);
    expect(
      sent.writes.outboxRows.map((row) => [row.id, row.recipientHandleId, row.businessId, row.sendClass]),
    ).toEqual([["out-ben-stop-reply", "handle-ben", null, "quick_reply"]]);
    expect(sent.writes.events.map((entry) => [entry.kind, entry.businessId])).toEqual([
      ["safety_outcome.recorded", null],
      ["consent.withdrawn", null],
      ["phone.stopped", null],
      ["outbox_row.created", null],
    ]);

    // The gate hop's one span, with no business label: labels and the rows K-05 named, never the number (Gives e).
    const span = onlySpan(spans);
    expect(span).toMatchObject({
      hop: "gate",
      trace_id: "trace-ben-0007",
      turn_id: "turn-ben-stop",
      outcome: "ok",
      got: { toolCall: "gateAndCommit", callerKind: "turn" },
      decided: { answered: "response" },
      error_code: null,
      rows: [
        { table: "phones", id: "handle-ben" },
        { table: "outbox_rows", id: "out-ben-stop-reply" },
      ],
    });
    expect(span).not.toHaveProperty("business_id");
    expect(span.limits).toEqual(
      [1, 2, 3, 4, 5, 6].map((limit) => ({ limit, result: "notChecked", outcome: null })),
    );
    expect(validator.checkSpan(span)).toEqual([]);
  });

  it("Ben's START in his own turn after his STOP answers start-recorded.json, but for the reply, which his turn writes", async () => {
    const world = benWorld();
    await stopCommitted(world);
    const start = startRecorded();
    const request = startTurn();
    expect(validator.check("gateAndCommit", "request", request)).toEqual([]);
    expect(isKeywordTurn(request)).toBe(true);
    const doubles = doorOn(world, k05Fake({ answers: [startK05Answer()] }));
    const { answer } = await through(doubles, request);
    const result = committedOf(answer);
    expect(result).toMatchObject({ result: "committed", turnId: START_TURN, repeated: false, parts: [] });
    const [record, started] = result.core;
    expect(record).toMatchObject({
      call: "recordSafetyOutcome",
      response: { outcomeId: "safety-outcome-ben-0011", outcomes: ["No"], hold: null, repeated: false },
      error: null,
    });
    expect(started).toEqual({
      call: "recordStopOrStart",
      response: {
        ...start.outcome,
        reply: { fixedLineId: "startReply", outboxRowId: "out-ben-start-reply" },
      },
      error: null,
    });

    // A texts row for every business, revoked false, under his turn at the time his START came; the phone started with
    // its chat open, compared and set on version 4 (after his STOP); the start reply back to the mobile it came from.
    const [sent] = doubles.k05.requests;
    if (sent === undefined) throw new Error("one commit was sent");
    expect(contractChecks().k05("commitTurn.request", sent)).toEqual([]);
    expect(sent.writes.state).toMatchObject([
      { table: "safety_outcomes", values: { id: "safety-outcome-ben-0011", business_id: null } },
      {
        table: "consents",
        values: { id: "consent-ben-start", business_id: null, revoked: false, turn_id: START_TURN },
      },
      { table: "phones", key: { number: BEN }, expectVersion: 4, set: { stopped: false, chat_open: true } },
    ]);
    expect(sent.writes.outboxRows.map((row) => [row.id, row.businessId])).toEqual([
      ["out-ben-start-reply", null],
    ]);
    for (const read of doubles.reads) expect(read, read.read).toMatchObject({ repo: 1, open: true });

    // Written as K-05 writes it, the phone answers start-recorded.json's: started, its chat open, at version 5.
    applySafetyWrites(world, sent.writes.state, sent.writes.outboxRows);
    expect(world.flags.record.phones.find((phone) => phone.handleId === "handle-ben")).toMatchObject({
      stopped: false,
      chatOpen: true,
      version: start.outcome.phoneVersion,
    });
  });

  it("a repeat of Ben's STOP answers repeated and writes nothing new: the record and the STOP find their rows", async () => {
    const world = benWorld();
    await stopCommitted(world);
    const { request, outcome } = stopRecorded();
    const first = k05AnswerOf(outcome);
    const repeat: CommitTurnAnswer = {
      ...first,
      repeated: true,
      committed: { written: [], outboxRows: first.committed.outboxRows, promoted: [] },
    };
    const doubles = doorOn(world, k05Fake({ answers: [repeat] }));
    const result = committedOf((await through(doubles, request)).answer);
    expect(result).toMatchObject({ repeated: true, written: { written: [] } });
    expect(result.core).toMatchObject([
      { call: "recordSafetyOutcome", response: { repeated: true }, error: null },
      { call: "recordStopOrStart", response: { repeated: true }, error: null },
    ]);
    // The rerun builds nothing to write: K-05 is sent no row (its repeat writes nothing in any case).
    const [sent] = doubles.k05.requests;
    expect(sent?.writes.state).toEqual([]);
    expect(sent?.writes.outboxRows).toEqual([]);
  });

  it("a caller that records the gate hop itself gets no span from the door, and the same answer (TURN_RECORDS_GATE)", async () => {
    const { request, outcome } = stopRecorded();
    const doubles = doorOn(benWorld(), k05Fake({ answers: [k05AnswerOf(outcome)] }));
    const { trace, spans } = traceFor(request);
    const answer = await doubles.door.gateAndCommit(copy(request), NOTHING_OPEN_AT, trace, TURN_RECORDS_GATE);
    expect(answer).toEqual(outcome);
    expect(spans).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

/** stop-recorded.json as `change` gives it back: each a no-business shape the door does not take, as plain JSON. */
function stopWith(change: (request: GateAndCommitRequest) => Json): Json {
  return change(stopRecorded().request);
}

/** stop-recorded.json's request with its caller's fields changed, every core action's caller with it. */
function underCaller(request: GateAndCommitRequest, fields: Json): Json {
  const caller = { ...request.caller, ...fields };
  return {
    ...request,
    caller,
    core: request.core.map((action) => ({ ...action, request: { ...action.request, caller } })),
  };
}

/** stop-recorded.json's request with its STOP's caller's fields changed (the second core action), the rest as it is. */
function stopCallerChanged(request: GateAndCommitRequest, fields: Json): Json {
  return {
    ...request,
    core: request.core.map((action, at) =>
      at === 1
        ? { ...action, request: { ...action.request, caller: { ...action.request.caller, ...fields } } }
        : action,
    ),
  };
}

/** Each other no-business shape (Gives b; C3), and what the door answers: K-09 takes each but the last three. */
const SHAPES: readonly [string, () => Json, "noBusinessScope" | "invalidRequest"][] = [
  [
    "a parts input: decided texts (commit-s1-01.json's), the turn's caller naming no business",
    () => stopWith((request) => ({ ...request, input: commitS101().request.input })),
    "noBusinessScope",
  ],
  [
    "a planner: decided texts with the planner's verbs (K-02 planner-answer.json, part 0)",
    () =>
      stopWith((request) => ({
        ...request,
        input: {
          ...commitS101().request.input,
          planner: { output: contractFile("model/fixtures/planner-answer.json"), parts: [0] },
        },
      })),
    "noBusinessScope",
  ],
  [
    "another core action: a releaseSafetyHold under the same caller",
    () =>
      stopWith((request) => ({
        ...request,
        core: [
          ...request.core,
          {
            call: "releaseSafetyHold",
            request: {
              caller: request.caller,
              holdId: "hold-ben-0007",
              expectVersion: 1,
              why: "outcome_message_sent",
              releasedByOutcomeId: null,
            },
          },
        ],
      })),
    "noBusinessScope",
  ],
  [
    "another core action: flag-paused.json's setRecordFlag under the same caller",
    () =>
      stopWith((request) => {
        const paused = k09Fixture("flag-paused.json") as { request: RecordFlagRequest };
        const pause = { call: "setRecordFlag", request: { ...paused.request, caller: request.caller } };
        return { ...request, core: [...request.core, pause] };
      }),
    "noBusinessScope",
  ],
  [
    "a caller not of kind turn: a job naming no business, each core action under it",
    () =>
      stopWith((request) => underCaller(request, { kind: "job", turnId: null, requestId: "job-ben-stop" })),
    "noBusinessScope",
  ],
  [
    "a core action whose caller names a business: the STOP's caller naming the barbershop",
    () => stopWith((request) => stopCallerChanged(request, { businessId: BARBERSHOP })),
    "noBusinessScope",
  ],
  [
    "a core action under another caller: the STOP's caller acting for another person",
    () => stopWith((request) => stopCallerChanged(request, { personId: "person-avery" })),
    "noBusinessScope",
  ],
  [
    "a caller that names a business (the base's call, never the door's)",
    () => stopWith((request) => ({ ...request, caller: { ...request.caller, businessId: BARBERSHOP } })),
    "noBusinessScope",
  ],
  [
    "a request K-09 refuses: an input K-09 does not hold",
    () => stopWith((request) => ({ ...request, input: { kind: "coreOnly", parts: [] } })),
    "invalidRequest",
  ],
  [
    "a request K-09 refuses: no now",
    () => stopWith((request) => Object.fromEntries(Object.entries(request).filter(([key]) => key !== "now"))),
    "invalidRequest",
  ],
  [
    "a request K-09 refuses: a turn's core-only call with no turn row",
    () => stopWith((request) => ({ ...request, turn: null })),
    "invalidRequest",
  ],
];

describe("every other no-business shape is answered before a transaction opens, with nothing read (Gives b; C3)", () => {
  for (const [what, build, expected] of SHAPES) {
    it(`${what}: ${expected}, no transaction, no read, nothing sent`, async () => {
      const request = build();
      expect(validator.check("gateAndCommit", "request", request).length === 0, what).toBe(
        expected === "noBusinessScope",
      );
      const doubles = doorOn(benWorld(), k05Fake());
      const { answer, spans } = await through(doubles, request, "trace-ben-0007");
      expect(answer).toMatchObject({ error: expected, call: "gateAndCommit" });
      if (expected === "invalidRequest") expect(answer).toHaveProperty("problems");
      expect(doubles.events).toEqual([]);
      expect(doubles.repos).toEqual([]);
      expect(doubles.reads).toEqual([]);
      expect(doubles.openHoldsReads).toEqual([]);
      expect(doubles.sealer.calls).toEqual([]);
      expect(doubles.k05.requests).toEqual([]);
      const span = onlySpan(spans);
      expect(span).toMatchObject({ outcome: "refused", error_code: expected });
      expect(span).not.toHaveProperty("business_id");
      expect(validator.checkSpan(span)).toEqual([]);
    });
  }

  it("a trace that is not the caller's: invalidRequest, no transaction", async () => {
    const doubles = doorOn(benWorld(), k05Fake());
    const { answer } = await through(doubles, stopRecorded().request, "trace-another");
    expect(answer).toEqual({
      error: "invalidRequest",
      call: "gateAndCommit",
      problems: ["/caller/traceId is not the trace the call runs in"],
    });
    expect(doubles.events).toEqual([]);
  });

  it("the door's shapes are its three core calls under one caller naming no business; an empty core is one", () => {
    expect(KEYWORD_CORE_CALLS).toEqual(["recordSafetyOutcome", "recordStopOrStart", "sendFixedLine"]);
    expect(isKeywordTurn(stopRecorded().request)).toBe(true);
    expect(isKeywordTurn({ ...stopRecorded().request, core: [] })).toBe(true);
    // A turn's call with no turn row is never the door's, for a caller that asks before K-09's check refuses it.
    expect(isKeywordTurn({ ...stopRecorded().request, turn: null })).toBe(false);
  });

  it("the base still answers stop-recorded.json noBusinessScope, unchanged (tool-api.test.ts), while the door commits it", async () => {
    const { request, outcome } = stopRecorded();
    const base = callDoubles();
    const viaBase = await faceOver(base.calls).gateAndCommit(
      copy(request),
      NOTHING_OPEN_AT,
      traceFor(request).trace,
    );
    expect(viaBase).toEqual({ error: "noBusinessScope", call: "gateAndCommit" });
    expect(base.k05.requests).toEqual([]);
    const doubles = doorOn(benWorld(), k05Fake({ answers: [k05AnswerOf(outcome)] }));
    expect((await through(doubles, request)).answer).toEqual(outcome);
  });
});

// ---------------------------------------------------------------------------------------------------------------

/** Ben's HELP text after his STOP: a turn of its own, its one text and its trace. */
const AFTER_STOP = { turnId: "turn-ben-help", eventId: "evt-ben-help", traceId: "trace-ben-help" } as const;

/**
 * Ben's HELP text as a keyword turn, as the replies build it (T-1414: one sendFixedLine of helpReply, quick_reply, to the
 * turn's own handle, under the turn's caller, which names no business): stop-recorded.json's turn with the HELP in his
 * STOP's place, his text's record first; re-keyed to `own`'s turn, text and trace when given (a text of its own).
 */
function benHelpTurn(own?: typeof AFTER_STOP): GateAndCommitRequest {
  const { request } = stopRecorded();
  const [record] = request.core;
  if (request.turn === null || record?.call !== "recordSafetyOutcome") {
    throw new Error("stop-recorded.json carries Ben's turn and his text's record first");
  }
  const caller: K09.Caller =
    own === undefined
      ? request.caller
      : { ...request.caller, turnId: own.turnId, requestId: own.turnId, traceId: own.traceId };
  const eventId = own?.eventId ?? record.request.safety.eventId;
  const safety = { ...record.request.safety, eventId };
  return {
    ...request,
    caller,
    turn: {
      ...request.turn,
      id: own?.turnId ?? request.turn.id,
      eventIds: [eventId],
      traceId: caller.traceId,
    },
    core: [
      { call: "recordSafetyOutcome", request: { ...record.request, caller, safety } },
      helpAction(caller, "handle-ben"),
    ],
  };
}

describe("HELP's reply through the door, with T-1414's sendFixedLine merged (lead note 4's pin, moved: DL-881, DL-883)", () => {
  it("a sendFixedLine action (HELP's reply) passes the door and commits one quick_reply row to Ben's mobile, naming no business, its answer valid against K-09 v1", async () => {
    const request = benHelpTurn();
    expect(validator.check("gateAndCommit", "request", request)).toEqual([]);
    expect(isKeywordTurn(request)).toBe(true);
    const help = request.core[1];
    if (help?.call !== "sendFixedLine") throw new Error("the turn carries Ben's HELP");
    const rowId = await fixedLineRowId(fixedLineKey("turn-ben-stop", help.request));
    const doubles = doorOn(benWorld(), k05Fake());
    const { answer, spans } = await through(doubles, request);
    const result = committedOf(answer);
    const [record, helped] = result.core;
    expect(record).toMatchObject({
      call: "recordSafetyOutcome",
      response: { outcomes: ["No"], repeated: false },
      error: null,
    });
    expect(helped).toEqual({
      call: "sendFixedLine",
      response: { outboxRowId: rowId, repeated: false },
      error: null,
    });
    expect(validator.check("sendFixedLine", "response", helped?.response)).toEqual([]);

    // One transaction of the runtime side, committed; the HELP's reads (T-307's, through the flags port) and every other
    // read on its one repo while it was open (C1, C2).
    expect(doubles.events).toEqual(["begin gateAndCommit", "commit"]);
    expect(doubles.reads.some((read) => read.port === "messages")).toBe(true);
    for (const read of doubles.reads) expect(read, read.read).toMatchObject({ repo: 1, open: true });

    // One K-05 request under Ben's turn: his text's record and the HELP's one row back to his mobile, each naming no
    // business, and no phone or consent write.
    expect(doubles.k05.requests).toHaveLength(1);
    const [sent] = doubles.k05.requests;
    if (sent === undefined) throw new Error("one commit was sent");
    expect(contractChecks().k05("commitTurn.request", sent)).toEqual([]);
    expect(sent.writes.state.map((write) => write.table)).toEqual(["safety_outcomes"]);
    expect(
      sent.writes.outboxRows.map((row) => [row.id, row.recipientHandleId, row.businessId, row.sendClass]),
    ).toEqual([[rowId, "handle-ben", null, "quick_reply"]]);
    expect(sent.writes.events.map((entry) => [entry.kind, entry.businessId])).toEqual([
      ["safety_outcome.recorded", null],
      ["outbox_row.created", null],
    ]);
    expect(result.written.outboxRows.map((row) => row.id)).toEqual([rowId]);

    // The gate hop's one span, with no business label.
    const span = onlySpan(spans);
    expect(span).toMatchObject({
      hop: "gate",
      outcome: "ok",
      decided: { answered: "response" },
      error_code: null,
    });
    expect(span).not.toHaveProperty("business_id");
    expect(validator.checkSpan(span)).toEqual([]);
  });

  it("after Ben's STOP his HELP answers phoneStopped, valid against K-09 v1, and the HELP writes nothing: no row, no entry", async () => {
    const world = benWorld();
    await stopCommitted(world);
    const request = benHelpTurn(AFTER_STOP);
    expect(validator.check("gateAndCommit", "request", request)).toEqual([]);
    expect(isKeywordTurn(request)).toBe(true);
    const doubles = doorOn(world, k05Fake());
    const result = committedOf((await through(doubles, request)).answer);
    const [record, helped] = result.core;
    expect(record).toMatchObject({ call: "recordSafetyOutcome", error: null });
    expect(helped).toEqual({
      call: "sendFixedLine",
      response: null,
      error: { error: "phoneStopped", recipientHandleId: "handle-ben" },
    });
    expect(validator.check("sendFixedLine", "errors", helped?.error)).toEqual([]);
    expect(doubles.events).toEqual(["begin gateAndCommit", "commit"]);

    // The turn commits his HELP text's record alone: no outbox row and no entry for one, no phone or consent write.
    expect(doubles.k05.requests).toHaveLength(1);
    const [sent] = doubles.k05.requests;
    if (sent === undefined) throw new Error("one commit was sent");
    expect(contractChecks().k05("commitTurn.request", sent)).toEqual([]);
    expect(sent.writes.outboxRows).toEqual([]);
    expect(sent.writes.state.map((write) => write.table)).toEqual(["safety_outcomes"]);
    expect(sent.writes.events.map((entry) => entry.kind)).toEqual(["safety_outcome.recorded"]);
    expect(result.written.outboxRows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("what the door passes but the commit does not build yet answers notBuilt, with nothing written", () => {
  it("a danger outcome in a keyword turn answers notBuilt: with no business no line is built and no owner told (DL-864 note 2)", async () => {
    // Ben's text read as an emergency, its one label and its outcomes so (stop-recorded.json's record otherwise).
    const request = stopWith((stop) => {
      const [record, ...rest] = stop.core;
      if (record?.call !== "recordSafetyOutcome") throw new Error("stop-recorded.json carries Ben's record");
      const { safety } = record.request;
      const labels = (safety.read?.labels ?? []).map((label) => ({ ...label, outcome: "An emergency" }));
      const read = { ...safety.read, labels };
      const danger = { ...safety, read, outcomes: ["An emergency"] };
      return { ...stop, core: [{ ...record, request: { ...record.request, safety: danger } }, ...rest] };
    });
    expect(validator.check("gateAndCommit", "request", request)).toEqual([]);
    const doubles = doorOn(benWorld(), k05Fake());
    expect((await through(doubles, request)).answer).toEqual({ error: "notBuilt", call: "gateAndCommit" });
    expect(doubles.events).toEqual(["begin gateAndCommit", "rollback"]);
    expect(doubles.k05.requests).toEqual([]);
  });

  it("the no-business reader: the five record reads name no business on the door's repo; owner and zone answer notBuilt, reading nothing", async () => {
    const reads: DoorRead[] = [];
    const repo: DoorRepo = { name: "the door's transaction", id: 7, open: true };
    const reader = noBusinessSafetyReaderOf(noBusinessReadsOn(benWorld(), reads), repo);
    expect(await reader.outcomeOfEvent("evt-ben-0007")).toBeNull();
    expect(await reader.outcome("safety-outcome-ben-0007")).toBeNull();
    expect(await reader.hold("hold-ben-0007")).toBeNull();
    expect(await reader.holdOfOutcome("safety-outcome-ben-0007")).toBeNull();
    expect(await reader.outboxRowWritten("out-ben-stop-reply")).toBe(false);
    expect(reads.map((read) => [read.read, read.repo, read.businessId])).toEqual([
      ["readSafetyOutcomeOfEvent", 7, null],
      ["readSafetyOutcome", 7, null],
      ["readSafetyHold", 7, null],
      ["readSafetyHoldOfOutcome", 7, null],
      ["readOutboxRowWritten", 7, null],
    ]);
    await expect(reader.ownerOf(BARBERSHOP)).rejects.toBeInstanceOf(NotBuiltError);
    await expect(reader.businessZone(BARBERSHOP)).rejects.toBeInstanceOf(NotBuiltError);
    expect(await reader.arrivedAt("evt-ben-0007")).toBeNull();
    expect(reads).toHaveLength(5);
    // An error answer is thrown, never read as none (K-05 v1.4 default 61).
    const refusing = noBusinessSafetyReaderOf<DoorRepo>(
      {
        outcomeOfEvent: () => Promise.resolve({ error: "transient" }),
        outcome: () => Promise.resolve({ error: "transient" }),
        hold: () => Promise.resolve({ error: "transient" }),
        holdOfOutcome: () => Promise.resolve({ error: "transient" }),
        outboxRowWritten: () => Promise.resolve({ error: "transient" }),
      },
      repo,
    );
    await expect(refusing.outcomeOfEvent("evt-ben-0007")).rejects.toBeInstanceOf(TurnFaceReadError);
    await expect(refusing.outboxRowWritten("out-ben-stop-reply")).rejects.toMatchObject({
      code: "transient",
    });
  });

  it("the door's lines: No sends nothing, every other outcome answers notBuilt, the outage line is the bundle's", async () => {
    const { turn } = stopRecorded().request;
    if (turn === null) throw new Error("stop-recorded.json carries its turn");
    const lines = noBusinessSafetyLines(await pinnedSafetyLines(bundleV0(), turn.bundleId));
    expect(lines.lineOf("No", [])).toBeNull();
    for (const outcome of [
      "An emergency",
      "Crisis words",
      "Unsure",
      "A threat to staff or others",
    ] as const) {
      expect(() => lines.lineOf(outcome, []), outcome).toThrow(NotBuiltError);
    }
    expect(lines.outageLine()).toBe("outage");
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("the runtime side's start and faults", () => {
  it("a start the database could not make answers K-09's transient, the commit never run; any other failure is thrown", async () => {
    const { request } = stopRecorded();
    const k05 = k05Fake();
    const never = (): never => {
      throw new Error("the commit never runs");
    };
    const lost: DoorRuntime<DoorRepo> = {
      withRuntime: (_work, call) =>
        call.transient === undefined
          ? Promise.reject(new Error("gateAndCommit's errors take transient"))
          : Promise.resolve(call.transient({ error: "transient", sqlstate: "08006" })),
    };
    const door = createKeywordDoor<DoorRepo>({ validator, runtime: lost, commit: never });
    const { trace, spans } = traceFor(request);
    expect(await door.gateAndCommit(copy(request), NOTHING_OPEN_AT, trace)).toEqual({
      error: "transient",
      sqlstate: "08006",
    });
    expect(onlySpan(spans)).toMatchObject({ outcome: "failed", error_code: "transient" });
    expect(k05.requests).toEqual([]);

    const failing: DoorRuntime<DoorRepo> = {
      withRuntime: () =>
        Promise.reject(Object.assign(new Error("gateAndCommit: refused"), { name: "BusinessScopeError" })),
    };
    const refused = createKeywordDoor<DoorRepo>({ validator, runtime: failing, commit: never });
    const second = traceFor(request);
    await expect(refused.gateAndCommit(copy(request), NOTHING_OPEN_AT, second.trace)).rejects.toMatchObject({
      name: "BusinessScopeError",
    });
    expect(onlySpan(second.spans)).toMatchObject({ outcome: "failed", error_code: "BusinessScopeError" });
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("a STOP and a START through the door: no number, address or consent words leave it (DL-877 C4)", () => {
  let consoles: MockInstance[] = [];

  beforeEach(() => {
    consoles = (["log", "warn", "error", "info", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no log line, span or answer of Ben's STOP and START holds his number, its digits or his words", async () => {
    const world = benWorld();
    const { request: stop, outcome } = stopRecorded();
    const stopDoubles = doorOn(world, k05Fake({ answers: [k05AnswerOf(outcome)] }));
    const stopped = await through(stopDoubles, stop);
    committedOf(stopped.answer);
    const [sent] = stopDoubles.k05.requests;
    if (sent === undefined) throw new Error("the STOP was committed");
    applySafetyWrites(world, sent.writes.state, sent.writes.outboxRows);
    const startDoubles = doorOn(world, k05Fake({ answers: [startK05Answer()] }));
    const started = await through(startDoubles, startTurn());
    committedOf(started.answer);

    // The check is not vacuous: what K-05 is sent holds his number and his word, as K-04 and K-29 store them.
    expect(leaksIn(JSON.stringify(sent))).not.toEqual([]);
    // Nothing logged at all; every span and every answer holds none of it.
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
    const spans = [...stopped.spans, ...started.spans];
    expect(spans).toHaveLength(2);
    for (const text of [...stringsIn(spans), ...stringsIn([stopped.answer, started.answer])]) {
      expect(leaksIn(text), text).toEqual([]);
    }
  });

  it("a STOP whose phone row changed twice throws stillChanged with no row the trace would refuse: never the number", async () => {
    const { request } = stopRecorded();
    const changed: CommitTurnAnswer = {
      error: "versionChanged",
      changed: [{ table: "phones", rowId: BEN, readVersion: 3, currentVersion: 4 }],
    };
    const doubles = doorOn(benWorld(), k05Fake({ answers: [changed, changed] }));
    const { trace, spans } = traceFor(request);
    const thrown = await doubles.door.gateAndCommit(copy(request), NOTHING_OPEN_AT, trace).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toMatchObject({ name: "CommitRefusedError", fault: "stillChanged", ids: [] });
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain("stillChanged");
    expect(leaksIn(message)).toEqual([]);
    expect(doubles.events).toEqual(["begin gateAndCommit", "rollback"]);
    const span = onlySpan(spans);
    expect(span).toMatchObject({ outcome: "failed", error_code: "CommitRefusedError" });
    expect(leaksIn(JSON.stringify(span))).toEqual([]);
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("in a business-scoped turn recordStopOrStart and setRecordFlag stay notBuilt portNotWired, as on main (DL-877 C5)", () => {
  /** stop-recorded.json with the turn's caller naming the barbershop (the turn face's), its core actions' naming none. */
  function stopInBusinessTurn(): GateAndCommitRequest {
    const { request } = stopRecorded();
    return { ...request, caller: { ...request.caller, businessId: BARBERSHOP } };
  }

  /** flag-paused.json's pause as the core action of Sam's own turn at the barbershop (T-1163's pauseTurn). */
  function pauseInBusinessTurn(): GateAndCommitRequest {
    const paused = k09Fixture("flag-paused.json") as { request: RecordFlagRequest; given: { now: string } };
    const { request } = stopRecorded();
    if (request.turn === null) throw new Error("stop-recorded.json carries its turn");
    const caller: K09.Caller = {
      kind: "turn",
      turnId: "turn-sam-pause",
      requestId: "turn-sam-pause",
      businessId: paused.request.caller.businessId,
      personId: paused.request.caller.personId,
      traceId: "trace-turn-sam-pause",
    };
    return {
      caller,
      turn: {
        ...request.turn,
        id: "turn-sam-pause",
        handleId: "handle-sam",
        eventIds: ["evt-sam-pause"],
        traceId: caller.traceId,
      },
      input: { kind: "coreOnly" },
      core: [{ call: "setRecordFlag", request: { ...paused.request, caller } }],
      now: paused.given.now,
    };
  }

  it("through the turn face's business-scoped gateAndCommit each answers notBuilt, nothing sent to K-05", async () => {
    for (const request of [stopInBusinessTurn(), pauseInBusinessTurn()]) {
      expect(validator.check("gateAndCommit", "request", request)).toEqual([]);
      const doubles = callDoubles();
      const answer = await faceOver(doubles.calls).gateAndCommit(
        copy(request),
        NOTHING_OPEN_AT,
        traceFor(request).trace,
      );
      expect(answer).toEqual({ error: "notBuilt", call: "gateAndCommit" });
      expect(doubles.k05.requests).toEqual([]);
    }
  });

  it("the business-scoped runCore binds no flags port: each core action is CoreNotBuiltError portNotWired, before any read", async () => {
    for (const request of [stopInBusinessTurn(), pauseInBusinessTurn()]) {
      const doubles = callDoubles();
      const { ports } = doubles.calls.commit(NOTHING_OPEN_AT);
      const action = request.core.find(
        (each) => each.call === "recordStopOrStart" || each.call === "setRecordFlag",
      );
      if (action === undefined) throw new Error("the turn carries a flags call");
      const refused = await ports
        .runCore(action, commitContextOf(request), { holds: [], unreadEventIds: [] })
        .catch((thrown: unknown) => thrown);
      expect(refused, action.call).toMatchObject({
        name: "CoreNotBuiltError",
        core: action.call,
        gap: "portNotWired",
      });
    }
  });
});
