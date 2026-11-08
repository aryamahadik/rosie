// T-317's proofs (the card's "Proves it with"), on the frozen contracts' fixtures (K-09 v1 stop-recorded.json,
// start-recorded.json, flag-paused.json; K-29 v1 seed-consent-stop-row.json; K-04 v1's seeds), through in-memory reads
// and a fake of K-05's commit, never a database:
//   - stop-recorded.json and start-recorded.json give their rows;
//   - STOP stops every business for that phone (MC C1);
//   - the hard invariant: with stopped set, the commit holds no outbox row but stop replies, safety lines and a new
//     booking's texts after its fresh yes;
//   - a replayed STOP written on return keeps its original time and is written once (keyed by the actor's event id);
//   - paused blocks a booking part (flag-paused.json);
//   - deceased blocks a new charge.
// And around them: who may clear each flag (arch 03 line 177), a work phone's "which texts?" (RULES 7.7), the binding of
// each word to the number it came from (K-09 README default 29), and nothing logged, with ids and labels only.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type * as K09 from "../../../../contracts/generated/tool-api/tool-api.v1";
import {
  checkUnits,
  questionClock,
  type CommitTurnContext,
  type CommitUnit,
  type Committed,
  type CoreAction,
  type GateAndCommitRequest,
  type OutboxRowNew,
  type UnitWrites,
} from "../../commit";
import { runGate, type GateRequest } from "../../gate/framework";
import {
  callContext,
  copy,
  decidedOf,
  gateExchange,
  gateRequest,
  scriptedLimits,
  type LimitCall,
} from "../../gate/framework/test-support";
import { flagsFirst, type GateFlagReads } from "../../gate/flags";
import {
  createToolApi,
  createToolApiValidator,
  notBuiltHandlers,
  type ToolApiValidator,
} from "../../tool-api";
import { recordingScope, traceFor, type RecordingRepo } from "../../tool-api/test-support";
import { createMessagesConsent, textsStanding, type MessageRequest } from "../messages-consent";
import { FlagRefusedError } from "./errors";
import { KEYED_IDS } from "./ids";
import {
  recordFlagCore,
  recordStopOrStartAlone,
  recordStopOrStartHandler,
  runtimeStopCall,
  setRecordFlagAlone,
  setRecordFlagHandler,
  stopOrStartCore,
  type FlagsDeps,
} from "./handlers";
import { unitWritesOf } from "./writes";
import { callOffDueAt, type RecordFlagRequest } from "./record-flag";
import { EVERY_BUSINESS, type StopOrStartRequest } from "./stop-start";
import { assertStopKept, keepStop, rowsAfterFreshYes, type CommitStop } from "./stopped";
import { ALEX_CARD, cardsOf } from "../messages-consent/test-support";
import {
  BARBERSHOP,
  YOGA_STUDIO,
  applied,
  contractJson,
  eventSourcesOf,
  fakeAloneCommit,
  fixtureIds,
  flagsReaderOn,
  flagsSeedRecord,
  k05Problems,
  k09Fixture,
  messagesReaderOn,
  phoneRow,
  questionsAsked,
  stringsIn,
  withHandleAddress,
  withMore,
  withPhones,
  withQuestions,
  worldOf,
  type FakeAloneCommit,
  type FlagsRecord,
  type World,
} from "./test-support";

const validator: ToolApiValidator = createToolApiValidator();

/** Ben's mobile as K-09 v1's fixtures name it (stop-recorded.json, start-recorded.json), in the 555-01xx range. */
const BEN_K09 = "+15555550131";
const ALEX = "+15555550101";
/** Sam's and Avery's mobiles as K-04 v1's seed-person-roles.json names them (the barbershop's owner and staff). */
const SAM = "+15555550100";
const AVERY = "+15555550103";

interface Exchange<Request, Outcome> {
  readonly given: { readonly now: string };
  readonly request: Request;
  readonly outcome: Outcome;
}

type GateExchange = Exchange<GateAndCommitRequest, Committed>;
type StartExchange = Exchange<StopOrStartRequest, K09.RecordStopOrStartResponse>;
type PausedExchange = Exchange<RecordFlagRequest, K09.SetRecordFlagResponse>;
type StopAction = Extract<CoreAction, { call: "recordStopOrStart" }>;

/** K-09 v1's fixtures this card reads, each a fresh copy. */
const stopRecorded = (): GateExchange => copy(k09Fixture("stop-recorded.json") as GateExchange);
const startRecorded = (): StartExchange => copy(k09Fixture("start-recorded.json") as StartExchange);
const flagPaused = (): PausedExchange => copy(k09Fixture("flag-paused.json") as PausedExchange);

/** The ids K-09's fixtures name for the rows its calls write. */
const FIXTURE_IDS = fixtureIds([
  ["consent", "turn-ben-stop", "person-ben", "consent-ben-stop"],
  ["stopReply", "turn-ben-stop", null, "out-ben-stop-reply"],
  ["consent", "evt-ben-0011", "person-ben", "consent-ben-start"],
  [
    "pause",
    "req-portal-sam-0140",
    JSON.stringify({ target: "person", person_id: "person-alex" }),
    "pause-alex-lees",
  ],
  ["callOff", "req-portal-sam-0140", "pause-alex-lees/booking-alex-riley-nov14", "clock-call-off-alex-nov14"],
]);

/**
 * Ben in K-09's world before stop-recorded.json: his mobile is the fixtures' number, it has texted Rosie's number (chat
 * open), it is not stopped, and its row is at version 3 (the STOP answers phoneVersion 4).
 */
function benWorld(): World {
  const record = withHandleAddress(flagsSeedRecord(), "handle-ben", BEN_K09);
  return worldOf(
    withPhones(record, [
      phoneRow("handle-ben", BEN_K09, {
        chatOpen: true,
        chatOpenAt: new Date("2026-10-05T17:00:00Z"),
        chatWay: "imessage",
        version: 3,
      }),
    ]),
  );
}

/** The deps of every flags call over the world, on the runtime side unless a scope is given. */
function depsOn(
  world: World,
  extra: FlagsDeps<unknown> = {},
  scope: string | null = null,
): FlagsDeps<unknown> {
  return {
    reader: () => flagsReaderOn(world, scope),
    messagesReader: () => messagesReaderOn(world, scope),
    ids: FIXTURE_IDS,
    ...extra,
  };
}

/** The turn's commit context of a gateAndCommit request, as the commit hands it to runCore. */
function turnContext(request: GateAndCommitRequest, businessId = BARBERSHOP): CommitTurnContext {
  if (request.turn === null) throw new Error("the request carries no turn");
  return { request, turn: request.turn, repo: { name: "flags-test-repo" }, businessId };
}

function stopActionOf(request: GateAndCommitRequest): StopAction {
  const action = request.core.find((each): each is StopAction => each.call === "recordStopOrStart");
  if (action === undefined) throw new Error("no STOP in the turn");
  return action;
}

/** A gateAndCommit request carrying one STOP or START core action for a phone, in its own turn. */
function stopTurn(input: {
  turnId: string;
  handleId: string;
  eventId: string;
  number: string;
  /** The sender of the turn's texts; null for a clock turn, which has none. */
  personId: string | null;
  kind?: StopOrStartRequest["kind"];
  words?: string;
  now: string;
  businessId?: string | null;
  workPhoneBusinessIds?: string[] | null;
  alsoCancelVisit?: boolean;
}): GateAndCommitRequest {
  const exchange = stopRecorded();
  const request = exchange.request;
  const caller = {
    kind: "turn" as const,
    turnId: input.turnId,
    requestId: input.turnId,
    businessId: input.businessId ?? null,
    personId: input.personId,
    traceId: `trace-${input.turnId}`,
  };
  request.caller = caller;
  const base = request.turn;
  if (base === null) throw new Error("stop-recorded.json carries its turn");
  request.turn = {
    ...base,
    id: input.turnId,
    handleId: input.handleId,
    eventIds: [input.eventId],
    traceId: caller.traceId,
  };
  request.now = input.now;
  request.core = [
    {
      call: "recordStopOrStart",
      request: {
        caller,
        kind: input.kind ?? "stop",
        phoneNumber: input.number,
        inboundEventId: input.kind === "workPhoneNoAnswer" ? null : input.eventId,
        words: input.words ?? "STOP",
        alsoCancelVisit: input.alsoCancelVisit ?? false,
        workPhoneBusinessIds: input.workPhoneBusinessIds ?? null,
        sentByActor: null,
      },
    },
  ];
  return request;
}

/** A unit of the commit carrying these writes (the commit's own check runs on it). */
function unitOf(writes: UnitWrites): CommitUnit {
  return { writes, answer: null };
}

/** A part's unit: its message rows and state writes, on the step it is for. */
function partUnit(messages: readonly OutboxRowNew[], state: UnitWrites["state"] = []): CommitUnit {
  return unitOf({
    why: { step: "A7-03", choice: null },
    versionsRead: [],
    state,
    stateEvents: [],
    asks: [],
    closes: [],
    clockCancels: [],
    messages,
    reservations: { confirm: [], release: [] },
    effects: { write: [], letGo: [] },
    gives: [],
  });
}

/** A message to a person, quick reply by default. */
function message(id: string, to: MessageRequest["to"], fields: Partial<MessageRequest> = {}): MessageRequest {
  return {
    id,
    to,
    bookingId: null,
    openQuestionId: null,
    sendClass: "quick_reply",
    versionsRead: [],
    ...fields,
  };
}

/** The K-29 seed row of Ben's STOP, as its values are written (seed-consent-stop-row.json). */
function seedStopValues(): Record<string, unknown> {
  const seed = contractJson("db-schema/conversations-consent/fixtures/seed-consent-stop-row.json") as {
    rows: { table: string; values: Record<string, unknown> }[];
  };
  const row = seed.rows.find((each) => each.table === "consents");
  if (row === undefined) throw new Error("no seed STOP row");
  return row.values;
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
  // Nothing the flags calls do writes a log line (K-08: never the raw number or words).
  expect(warn).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------

describe("stop-recorded.json and start-recorded.json give their rows (K-09 v1; K-29 v1)", () => {
  const stopExchange = (): GateExchange => stopRecorded();

  it("Ben's STOP in his core-only turn answers stop-recorded.json's result and writes its rows", async () => {
    const exchange = stopExchange();
    const expected = exchange.outcome.core.find((each) => each.call === "recordStopOrStart");
    const world = benWorld();
    const run = await stopOrStartCore(
      stopActionOf(exchange.request),
      turnContext(exchange.request),
      depsOn(world),
    );

    expect(run.result).toEqual(expected);
    expect(validator.check("recordStopOrStart", "response", run.result.response)).toEqual([]);

    // The consent row is K-29's seed STOP row, for every business, at the turn's time and under its turn.
    const [consent, phone] = run.writes.state;
    expect(consent).toEqual({
      op: "insert",
      table: "consents",
      values: {
        ...seedStopValues(),
        booking_id: null,
        chat_link_id: null,
        at: exchange.request.now,
        turn_id: "turn-ben-stop",
      },
    });
    // The phone's one row: stopped, chat closed, compared and set on version 3 (K-04 phones; RULES 4.1b).
    expect(phone).toEqual({
      op: "update",
      table: "phones",
      key: { number: BEN_K09 },
      expectVersion: 3,
      set: { stopped: true, chat_open: false, stop_at: exchange.request.now },
    });
    // The one reply: a quick_reply row back to the mobile it came from, naming no business (README default 6).
    expect(run.writes.messages).toEqual([
      {
        id: "out-ben-stop-reply",
        recipientHandleId: "handle-ben",
        recipientPersonId: "person-ben",
        businessId: null,
        bookingId: null,
        channel: "imessage",
        sendClass: "quick_reply",
        openQuestionId: null,
        copyOfRowId: null,
        versionsRead: [],
      },
    ]);
    expect(run.replyRowId).toBe("out-ben-stop-reply");

    // Each write in K-05's shapes, and the turn's commit takes the unit as it is.
    for (const write of run.writes.state) expect(k05Problems("stateWrite", write)).toEqual([]);
    for (const row of run.writes.messages) expect(k05Problems("outboxRowNew", row)).toEqual([]);
    for (const entry of run.writes.stateEvents) expect(k05Problems("eventEntry", entry)).toEqual([]);
    expect(() => {
      checkUnits([unitOf(run.writes)]);
    }).not.toThrow();
    expect(run.writes.stateEvents.map((entry) => [entry.kind, entry.tableName, entry.rowId])).toEqual([
      ["consent.withdrawn", "consents", "consent-ben-stop"],
      ["phone.stopped", "phones", "handle-ben"],
    ]);

    // What K-05 writes for it is the fixture's: the phone at version 4, the reply row.
    world.record = applied(world.record, run.writes.state);
    expect(world.record.phones.find((each) => each.handleId === "handle-ben")).toMatchObject({
      stopped: true,
      chatOpen: false,
      version: exchange.outcome.written.written[0]?.version,
    });
    expect(exchange.outcome.written.outboxRows.map((row) => row.id)).toEqual(
      run.writes.messages.map((row) => row.id),
    );
  });

  it("Ben's START written on return answers start-recorded.json, at the time it came, with no row sent again", async () => {
    const world = benWorld();
    const exchange = stopExchange();
    const stop = await stopOrStartCore(
      stopActionOf(exchange.request),
      turnContext(exchange.request),
      depsOn(world),
    );
    world.record = applied(world.record, stop.writes.state);

    const start = startRecorded();
    const commit = fakeAloneCommit(world);
    const answer = await recordStopOrStartAlone(
      start.request,
      null,
      depsOn(world, {
        events: eventSourcesOf({ "evt-ben-0011": "handle-ben" }),
        commitAlone: commit,
        now: () => start.given.now,
      }),
    );
    expect(answer).toEqual(start.outcome);

    // Written once, keyed by its text's event, on the runtime side, with no outbox row: the actor sent the reply.
    expect(commit.keys).toEqual(["evt-ben-0011"]);
    const [request] = commit.requests;
    expect(request?.businessId).toBeNull();
    expect(request?.writes.outboxRows).toEqual([]);
    expect(request?.writes.events.map((entry) => entry.kind)).toEqual(["consent.given", "phone.started"]);
    // It keeps the time the START came (sentByActor.at), not the time it was written (arch 11 line 566).
    const sentAt = start.request.sentByActor?.at;
    expect(sentAt).toBe("2026-10-22T14:05:11Z");
    expect(world.record.consents.find((row) => row.id === "consent-ben-start")).toMatchObject({
      personId: "person-ben",
      businessId: null,
      kind: "texts",
      revoked: false,
      handleId: "handle-ben",
      at: new Date("2026-10-22T14:05:11Z"),
      channel: "text",
      turnId: null,
    });
    expect(world.record.phones.find((each) => each.handleId === "handle-ben")).toMatchObject({
      stopped: false,
      chatOpen: true,
      startAt: new Date("2026-10-22T14:05:11Z"),
      version: 5,
    });
  });

  it("on the runtime side the START is held to K-09 v1's schema, before any read and after its answer", async () => {
    const world = benWorld();
    const exchange = stopExchange();
    const stop = await stopOrStartCore(
      stopActionOf(exchange.request),
      turnContext(exchange.request),
      depsOn(world),
    );
    world.record = applied(world.record, stop.writes.state);
    const start = startRecorded();
    let transactions = 0;
    const call = runtimeStopCall({
      validator,
      runtime: {
        withRuntime: (work) => {
          transactions += 1;
          return work(null);
        },
      },
      deps: depsOn(world, {
        events: eventSourcesOf({ "evt-ben-0011": "handle-ben" }),
        commitAlone: fakeAloneCommit(world),
        now: () => start.given.now,
      }),
    });
    expect(await call(start.request)).toEqual(start.outcome);
    expect(transactions).toBe(1);

    // A START from a page is refused by the schema before anything is read (RULES 7.5; MC C1).
    const fromPage = copy(start.request) as unknown as { caller: { kind: string } };
    fromPage.caller.kind = "page";
    const refused = await call(fromPage);
    expect(refused).toMatchObject({ error: "invalidRequest", call: "recordStopOrStart" });
    expect(transactions).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("STOP stops every business for that phone (MC C1; RULES 7.2, 7.5)", () => {
  /** Alex texts STOP in his own turn, made under the barbershop's thread: he is a customer there and at the yoga studio. */
  async function alexStops(
    world: World,
    businessId: string | null,
  ): Promise<Awaited<ReturnType<typeof stopOrStartCore>>> {
    const request = stopTurn({
      turnId: "turn-alex-stop",
      handleId: "handle-alex",
      eventId: "evt-alex-stop",
      number: ALEX,
      personId: "person-alex",
      now: "2026-10-24T09:00:00Z",
      businessId,
    });
    const run = await stopOrStartCore(stopActionOf(request), turnContext(request), depsOn(world));
    world.record = applied(world.record, run.writes.state);
    return run;
  }

  it("one STOP row for every business and the one phone row stopped: no business's routine text is built", async () => {
    const world = worldOf(flagsSeedRecord());
    const run = await alexStops(world, null);
    expect(run.result.response).toMatchObject({ stopped: true, chatOpen: false, repeated: false });
    const [consent] = run.writes.state;
    expect(consent).toMatchObject({
      op: "insert",
      table: "consents",
      values: { business_id: null, revoked: true },
    });

    // On the runtime side the STOP is the newest texts row at both businesses (K-29 README: the newest decides).
    const rows = await messagesReaderOn(world, null).consentsOfPersons(["person-alex"]);
    for (const business of [BARBERSHOP, YOGA_STUDIO]) {
      expect(textsStanding(rows, "person-alex", business, "handle-alex")).toMatchObject({ revoked: true });
    }
    // Under each business's own scope, the phone's flag tells it: no routine text, only a safety line.
    for (const business of [BARBERSHOP, YOGA_STUDIO]) {
      const service = createMessagesConsent({
        businessId: business,
        reader: messagesReaderOn(world, business),
      });
      const routine = await service.outboxRows(
        message(
          `out-${business}-routine`,
          { personId: "person-alex", via: "handle-alex" },
          { sendClass: "routine" },
        ),
      );
      expect(routine.rows.filter((row) => row.recipientHandleId === "handle-alex")).toEqual([]);
      expect(routine.notBuilt).toEqual([{ medium: "text", handleId: "handle-alex", why: "stopped" }]);
      const safety = await service.outboxRows(
        message(
          `out-${business}-safety`,
          { personId: "person-alex", via: "handle-alex" },
          { sendClass: "safety" },
        ),
      );
      expect(safety.rows.map((row) => row.recipientHandleId)).toEqual(["handle-alex"]);
    }
  });

  it("a STOP made in a turn under one business still covers every business", async () => {
    const world = worldOf(flagsSeedRecord());
    const run = await alexStops(world, BARBERSHOP);
    expect(run.writes.state[0]).toMatchObject({ values: { business_id: null, revoked: true } });
    // Its reply row is the barbershop scope's own (a row's business under a business scope), never another's.
    expect(run.writes.messages.map((row) => row.businessId)).toEqual([BARBERSHOP]);
    const rows = await messagesReaderOn(world, null).consentsOfPersons(["person-alex"]);
    expect(textsStanding(rows, "person-alex", YOGA_STUDIO, "handle-alex")).toMatchObject({ revoked: true });
    expect(world.record.phones.find((each) => each.handleId === "handle-alex")?.stopped).toBe(true);
  });

  it("a stop for another number changes nothing (notFromThatPhone; RULES 7.2), nor a START from a page", async () => {
    const world = worldOf(flagsSeedRecord());
    const request = stopTurn({
      turnId: "turn-alex-stop-other",
      handleId: "handle-alex",
      eventId: "evt-alex-other",
      number: "+15555550102",
      personId: "person-alex",
      now: "2026-10-24T09:00:00Z",
    });
    const run = await stopOrStartCore(stopActionOf(request), turnContext(request), depsOn(world));
    expect(run.result).toEqual({
      call: "recordStopOrStart",
      response: null,
      error: { error: "notFromThatPhone", phoneNumber: "+15555550102" },
    });
    expect(run.writes.state).toEqual([]);
    expect(run.writes.messages).toEqual([]);

    const pageStart = {
      ...stopActionOf(request).request,
      caller: { ...stopActionOf(request).request.caller, kind: "page" as const, turnId: null },
      kind: "start" as const,
      phoneNumber: ALEX,
    };
    expect(await recordStopOrStartAlone(pageStart, null, depsOn(world))).toEqual({
      error: "notFromThatPhone",
      phoneNumber: ALEX,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("the hard invariant: with stopped set, the commit holds no row but stop replies, safety lines and a new booking's texts after its fresh yes", () => {
  /** Ben's phone as K-04 seed-phone-stopped.json has it: stopped since 2026-10-20 13:00Z, once texted Rosie's number. */
  const BEN_TURN: CommitStop = { turn: { id: "turn-ben-later", handleId: "handle-ben" }, replies: new Set() };

  it("for every send class, with or without a booking, only a safety line reaches Ben's stopped mobile", async () => {
    const world = worldOf(flagsSeedRecord());
    expect(world.record.phones.find((each) => each.handleId === "handle-ben")).toMatchObject({
      stopped: true,
      chatOpen: false,
    });
    const service = createMessagesConsent({
      businessId: BARBERSHOP,
      reader: messagesReaderOn(world, BARBERSHOP),
    });
    const units: CommitUnit[] = [];
    for (const sendClass of ["routine", "quick_reply", "visit_now", "safety"] as const) {
      for (const bookingId of [null, "booking-ben-haircut"]) {
        for (const stopReply of [false, true]) {
          const id = `out-ben-${sendClass}-${bookingId ?? "none"}-${String(stopReply)}`;
          const built = await service.outboxRows(
            message(id, { personId: "person-ben", via: "handle-ben" }, { sendClass, bookingId, stopReply }),
          );
          units.push(partUnit(built.rows));
        }
      }
    }
    // A row built some other way, as if the stopped flag were not read: a routine text and a forged stop reply.
    const forged = (id: string, sendClass: OutboxRowNew["sendClass"]): OutboxRowNew => ({
      id,
      recipientHandleId: "handle-ben",
      recipientPersonId: "person-ben",
      businessId: BARBERSHOP,
      bookingId: "booking-ben-haircut",
      channel: "imessage",
      sendClass,
      openQuestionId: null,
      copyOfRowId: null,
      versionsRead: [],
    });
    units.push(
      partUnit([forged("out-ben-forged-routine", "routine"), forged("out-ben-forged-reply", "quick_reply")]),
    );

    const kept = await keepStop(units, BEN_TURN, messagesReaderOn(world, BARBERSHOP));
    const toBen = kept.units
      .flatMap((unit) => unit.writes.messages)
      .filter((row) => row.recipientHandleId === "handle-ben");
    expect(toBen.length).toBeGreaterThan(0);
    expect(toBen.every((row) => row.sendClass === "safety")).toBe(true);
    // T-307's own stop replies (a quick reply with stopReply) were built, but they are not this commit's STOP's reply.
    expect(kept.dropped.map((each) => each.rowId)).toEqual(
      expect.arrayContaining(["out-ben-forged-routine", "out-ben-forged-reply"]),
    );
    expect(kept.dropped.every((each) => each.handleId === "handle-ben")).toBe(true);
    await expect(assertStopKept(units, BEN_TURN, messagesReaderOn(world, BARBERSHOP))).rejects.toMatchObject({
      fault: "textAfterStop",
    });
    await expect(
      assertStopKept(kept.units, BEN_TURN, messagesReaderOn(world, BARBERSHOP)),
    ).resolves.toBeUndefined();
  });

  it("a STOP in the same turn binds every row beside it: only its own reply and a safety line stay; the email copy goes alone", async () => {
    const world = worldOf(flagsSeedRecord());
    // Built before the STOP is in: Alex's chat is open, so T-307 builds his routine text and, by his reach card (texts,
    // with his email on file), its email copy.
    const service = createMessagesConsent({
      businessId: BARBERSHOP,
      reader: messagesReaderOn(world, BARBERSHOP),
      reachCards: cardsOf([ALEX_CARD]),
    });
    const routine = await service.outboxRows(
      message("out-alex-routine", { personId: "person-alex", via: "handle-alex" }, { sendClass: "routine" }),
    );
    expect(routine.rows.map((row) => [row.id, row.copyOfRowId])).toEqual([
      ["out-alex-routine", null],
      ["out-alex-routine-email", "out-alex-routine"],
    ]);
    const withCopy = routine.rows;
    const safety = await service.outboxRows(
      message("out-alex-safety", { personId: "person-alex", via: "handle-alex" }, { sendClass: "safety" }),
    );
    const request = stopTurn({
      turnId: "turn-alex-stop",
      handleId: "handle-alex",
      eventId: "evt-alex-stop",
      number: ALEX,
      personId: "person-alex",
      now: "2026-10-24T09:00:00Z",
      businessId: BARBERSHOP,
    });
    const stop = await stopOrStartCore(stopActionOf(request), turnContext(request), depsOn(world));
    const units = [unitOf(stop.writes), partUnit(withCopy), partUnit(safety.rows)];
    const commit: CommitStop = {
      turn: { id: "turn-alex-stop", handleId: "handle-alex" },
      replies: new Set(stop.replyRowId === null ? [] : [stop.replyRowId]),
    };
    const reads = messagesReaderOn(world, BARBERSHOP);
    await expect(assertStopKept(units, commit, reads)).rejects.toThrow(FlagRefusedError);

    const kept = await keepStop(units, commit, reads);
    expect(kept.dropped).toEqual([{ rowId: "out-alex-routine", handleId: "handle-alex" }]);
    const rows = kept.units.flatMap((unit) => unit.writes.messages);
    expect(rows.map((row) => [row.id, row.recipientHandleId, row.copyOfRowId])).toEqual([
      [stop.replyRowId, "handle-alex", null],
      ["out-alex-routine-email", "handle-alex-email", null],
      ["out-alex-safety", "handle-alex", null],
      ["out-alex-safety-email", "handle-alex-email", "out-alex-safety"],
    ]);
    expect(() => {
      checkUnits(kept.units);
    }).not.toThrow();
    await expect(assertStopKept(kept.units, commit, reads)).resolves.toBeUndefined();
  });

  it("a new booking's texts go after its fresh yes from that phone in this turn, and no other booking's", async () => {
    const world = worldOf(
      withMore(flagsSeedRecord(), {
        bookings: [
          {
            id: "booking-ben-new",
            businessId: BARBERSHOP,
            flow: "A",
            stage: "entry",
            bookerPersonId: "person-ben",
            servedPersonId: "person-ben",
            payerPersonId: null,
            private: false,
            deceased: false,
            version: 1,
          },
        ],
      }),
    );
    const reads = messagesReaderOn(world, BARBERSHOP);
    const service = createMessagesConsent({ businessId: BARBERSHOP, reader: reads });
    const turn = { id: "turn-ben-new-yes", handleId: "handle-ben" };
    // Ben's own fresh yes to texts for the new booking, sent by text from his stopped mobile (RULES 7.5; S13-32).
    const yes = await service.yes({
      id: "consent-ben-new-yes",
      personId: "person-ben",
      kind: "texts",
      readBack: { words: "Texts about this booking go to this number. Reply YES.", turnId: turn.id },
      at: "2026-10-24T10:00:00Z",
      channel: "text",
      handleId: "handle-ben",
      bookingId: "booking-ben-new",
      fromHandleId: "handle-ben",
    });
    const confirm = message(
      "out-ben-new-confirm",
      { personId: "person-ben", via: "handle-ben" },
      { sendClass: "routine", bookingId: "booking-ben-new" },
    );
    // T-307 reports it stopped; the fresh yes lets this booking's text row through.
    expect((await service.outboxRows(confirm)).notBuilt).toEqual([
      { medium: "text", handleId: "handle-ben", why: "stopped" },
    ]);
    const built = await rowsAfterFreshYes(service, reads, confirm, yes, turn);
    expect(built.notBuilt).toEqual([]);
    expect(built.rows.map((row) => [row.id, row.recipientHandleId, row.bookingId, row.channel])).toEqual([
      ["out-ben-new-confirm", "handle-ben", "booking-ben-new", "imessage"],
    ]);
    // A message about another booking is left as T-307 builds it: the yes turns on only its own booking's texts.
    const old = message(
      "out-ben-old",
      { personId: "person-ben", via: "handle-ben" },
      { bookingId: "booking-ben-haircut" },
    );
    expect(await rowsAfterFreshYes(service, reads, old, yes, turn)).toEqual(await service.outboxRows(old));

    const [confirmRow] = built.rows;
    if (confirmRow === undefined) throw new Error("no confirmation row");
    const forgedOther: OutboxRowNew = {
      ...confirmRow,
      id: "out-ben-other",
      bookingId: "booking-ben-haircut",
    };
    const yesWrite = { op: "insert" as const, table: "consents", values: { ...yes.values } };
    const units = [partUnit([confirmRow, forgedOther], [yesWrite])];
    const kept = await keepStop(units, { turn, replies: new Set() }, reads);
    expect(kept.dropped).toEqual([{ rowId: "out-ben-other", handleId: "handle-ben" }]);
    expect(kept.units.flatMap((unit) => unit.writes.messages).map((row) => row.id)).toEqual([
      "out-ben-new-confirm",
    ]);

    // The same yes in another turn (its sender not known as that phone), or older than the stop, lets nothing through.
    const elsewhere = await keepStop(
      units,
      { turn: { id: "turn-other", handleId: "handle-ben" }, replies: new Set() },
      reads,
    );
    expect(elsewhere.dropped.map((each) => each.rowId)).toEqual(["out-ben-new-confirm", "out-ben-other"]);
    const olderYes = { ...yesWrite, values: { ...yesWrite.values, at: "2026-10-20T12:00:00Z" } };
    const older = await keepStop([partUnit([confirmRow], [olderYes])], { turn, replies: new Set() }, reads);
    expect(older.dropped.map((each) => each.rowId)).toEqual(["out-ben-new-confirm"]);
    // A page's yes for a stopped number is refused by T-307 itself (only START or a fresh yes from that number).
    await expect(
      service.yes({
        id: "consent-ben-page",
        personId: "person-ben",
        kind: "texts",
        readBack: { words: "Yes to texts", turnId: null },
        at: "2026-10-24T10:00:00Z",
        channel: "page",
        handleId: "handle-ben",
        bookingId: "booking-ben-new",
      }),
    ).rejects.toMatchObject({ fault: "stoppedNumber" });
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("a replayed STOP written on return keeps its original time and is written once (arch 11 line 566)", () => {
  /** Ben's STOP while PostgreSQL was down: his actor sent the stop reply at 19:30:02Z and writes the record on return. */
  function replayedStop(requestId = "evt-ben-0007"): StopOrStartRequest {
    return {
      caller: {
        kind: "actorOnReturn",
        turnId: null,
        requestId,
        businessId: null,
        personId: "person-ben",
        traceId: "trace-ben-0007",
      },
      kind: "stop",
      phoneNumber: BEN_K09,
      inboundEventId: "evt-ben-0007",
      words: "STOP",
      alsoCancelVisit: false,
      workPhoneBusinessIds: null,
      sentByActor: {
        at: "2026-10-21T19:30:02Z",
        fixedLineId: "stopReply",
        linqMessageId: "linq-msg-ben-stop-1",
      },
    };
  }
  const RETURN = "2026-10-21T19:52:40Z";

  it("its rows carry the time the STOP came, not the time they were written, and the actor's reply is not sent again", async () => {
    for (const ids of [FIXTURE_IDS, KEYED_IDS]) {
      const world = benWorld();
      const commit = fakeAloneCommit(world);
      const deps = depsOn(world, {
        ids,
        events: eventSourcesOf({ "evt-ben-0007": "handle-ben" }),
        commitAlone: commit,
        now: () => RETURN,
      });
      const answer = await recordStopOrStartAlone(replayedStop(), null, deps);
      expect(answer).toMatchObject({
        stopped: true,
        chatOpen: false,
        phoneVersion: 4,
        reply: { fixedLineId: "stopReply", outboxRowId: null },
        repeated: false,
      });
      expect(commit.keys).toEqual(["evt-ben-0007"]);
      expect(commit.requests[0]?.writes.outboxRows).toEqual([]);
      const stops = world.record.consents.filter((row) => row.handleId === "handle-ben" && row.revoked);
      expect(stops.map((row) => row.at.toISOString())).toEqual(["2026-10-21T19:30:02.000Z"]);
      expect(world.record.phones.find((each) => each.handleId === "handle-ben")?.stopAt?.toISOString()).toBe(
        "2026-10-21T19:30:02.000Z",
      );

      // The same text written again, under the same or another request id: written once, answered repeated.
      for (const requestId of ["evt-ben-0007", "req-actor-retry-2"]) {
        const again = await recordStopOrStartAlone(replayedStop(requestId), null, deps);
        expect(again).toMatchObject({ stopped: true, phoneVersion: 4, repeated: true });
      }
      expect(commit.keys).toEqual(["evt-ben-0007"]);
      expect(
        world.record.consents.filter((row) => row.handleId === "handle-ben" && row.revoked),
      ).toHaveLength(1);
      expect(world.record.phones.find((each) => each.handleId === "handle-ben")?.version).toBe(4);
    }
  });

  it("two replays racing to the commit write it once: K-05's key is the event id", async () => {
    const world = benWorld();
    const commit = fakeAloneCommit(world);
    const deps = depsOn(world, {
      events: eventSourcesOf({ "evt-ben-0007": "handle-ben" }),
      commitAlone: commit,
      now: () => RETURN,
    });
    const [first, second] = await Promise.all([
      recordStopOrStartAlone(replayedStop(), null, deps),
      recordStopOrStartAlone(replayedStop("req-actor-retry-3"), null, deps),
    ]);
    expect([first, second].map((each) => (each as K09.RecordStopOrStartResponse).repeated).sort()).toEqual([
      false,
      true,
    ]);
    expect(commit.keys).toEqual(["evt-ben-0007"]);
    expect(world.record.consents.filter((row) => row.handleId === "handle-ben" && row.revoked)).toHaveLength(
      1,
    );
  });

  it("a replay never lifts a later STOP: an older START keeps its row, and the flag stays as the newest word set it", async () => {
    const world = benWorld();
    const commit = fakeAloneCommit(world);
    const deps = depsOn(world, {
      events: eventSourcesOf({ "evt-ben-0007": "handle-ben", "evt-ben-0005": "handle-ben" }),
      commitAlone: commit,
      now: () => RETURN,
    });
    await recordStopOrStartAlone(replayedStop(), null, deps);
    // A START sent before that STOP, written after it: the newest word decides whatever order the writes arrive in
    // (DL-193), with no help from T-269's queue order.
    const olderStart: StopOrStartRequest = {
      ...replayedStop("evt-ben-0005"),
      kind: "start",
      inboundEventId: "evt-ben-0005",
      words: "START",
      sentByActor: {
        at: "2026-10-21T19:10:00Z",
        fixedLineId: "startReply",
        linqMessageId: "linq-msg-ben-start-0",
      },
    };
    const answer = await recordStopOrStartAlone(olderStart, null, deps);
    // Every START moves start_at (DL-193), so its row is written (version 5); the newer STOP keeps the phone stopped.
    expect(answer).toMatchObject({ stopped: true, chatOpen: false, phoneVersion: 5, repeated: false });
    expect(world.record.phones.find((each) => each.handleId === "handle-ben")).toMatchObject({
      stopped: true,
      chatOpen: false,
      stopAt: new Date("2026-10-21T19:30:02Z"),
      startAt: new Date("2026-10-21T19:10:00Z"),
      version: 5,
    });
    const rows = await messagesReaderOn(world, null).consentsOfPersons(["person-ben"]);
    expect(textsStanding(rows, "person-ben", BARBERSHOP, "handle-ben")).toMatchObject({ revoked: true });
  });

  it("a write on return whose text did not come from that phone changes nothing", async () => {
    const world = benWorld();
    const commit = fakeAloneCommit(world);
    for (const events of [eventSourcesOf({ "evt-ben-0007": "handle-alex" }), eventSourcesOf({})]) {
      const answer = await recordStopOrStartAlone(
        replayedStop(),
        null,
        depsOn(world, { events, commitAlone: commit }),
      );
      expect(answer).toEqual({ error: "notFromThatPhone", phoneNumber: BEN_K09 });
    }
    expect(commit.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

/** When Ben's actor writes its outage record on return (arch 11 line 566). */
const RETURN_AT = "2026-10-22T14:30:00Z";

/** A word Ben's actor writes on return: its text's event, and when the actor sent its reply (null: it sent none). */
function benOnReturn(kind: "stop" | "start", eventId: string, sentAt: string | null): StopOrStartRequest {
  return {
    caller: {
      kind: "actorOnReturn",
      turnId: null,
      requestId: eventId,
      businessId: null,
      personId: "person-ben",
      traceId: `trace-${eventId}`,
    },
    kind,
    phoneNumber: BEN_K09,
    inboundEventId: eventId,
    words: kind === "stop" ? "STOP" : "START",
    alsoCancelVisit: false,
    workPhoneBusinessIds: null,
    sentByActor:
      sentAt === null
        ? null
        : {
            at: sentAt,
            fixedLineId: kind === "stop" ? "stopReply" : "startReply",
            linqMessageId: `linq-msg-${eventId}`,
          },
  };
}

interface OnReturn {
  readonly world: World;
  readonly commit: FakeAloneCommit;
  readonly deps: FlagsDeps<unknown>;
}

/** Ben's world, stopped at T0 by stop-recorded.json's STOP in his turn (2026-10-21T19:30:02Z) or not, and his actor. */
async function benOnReturnWorld(stoppedAtT0: boolean): Promise<OnReturn> {
  const world = benWorld();
  if (stoppedAtT0) {
    const exchange = stopRecorded();
    const stop = await stopOrStartCore(
      stopActionOf(exchange.request),
      turnContext(exchange.request),
      depsOn(world),
    );
    world.record = applied(world.record, stop.writes.state);
  }
  const commit = fakeAloneCommit(world);
  const events = eventSourcesOf(
    Object.fromEntries(
      ["evt-ben-0011", "evt-ben-0012", "evt-ben-0013", "evt-ben-0014"].map((id) => [id, "handle-ben"]),
    ),
  );
  return { world, commit, deps: depsOn(world, { events, commitAlone: commit, now: () => RETURN_AT }) };
}

const benPhone = (world: World): FlagsRecord["phones"][number] | undefined =>
  world.record.phones.find((each) => each.handleId === "handle-ben");

/** The row that decides Ben's texts at a business, on the runtime side: K-29's newest (K-29 README). */
async function benStanding(world: World, businessId: string): Promise<ReturnType<typeof textsStanding>> {
  const rows = await messagesReaderOn(world, null).consentsOfPersons(["person-ben"]);
  return textsStanding(rows, "person-ben", businessId, "handle-ben");
}

const responseOf = (answer: unknown): K09.RecordStopOrStartResponse =>
  answer as K09.RecordStopOrStartResponse;

describe("a START written on return with no known time never beats a STOP (DL-193; the security reviewer's GAP 1)", () => {
  it("stopped at T0; START at 14:05 with no actor send, then STOP at 14:10, both written at 14:30 in order: stopped, K-29's newest the STOP", async () => {
    // The STOP's time: the actor's send at 14:10, or with none the call's now, 14:30 (fail closed: default 1).
    for (const stopSentAt of ["2026-10-22T14:10:00Z", null]) {
      const { world, commit, deps } = await benOnReturnWorld(true);
      // start-recorded.json's START (Ben's own evt-ben-0011, at 14:05), for which the actor sent no reply.
      const start: StopOrStartRequest = { ...startRecorded().request, sentByActor: null };
      const startAnswer = await recordStopOrStartAlone(start, null, deps);
      // It cannot be ordered against any STOP from that phone: it lifts nothing and writes nothing (default 8).
      expect(startAnswer).toEqual({
        consentRowIds: [],
        stopped: true,
        chatOpen: false,
        phoneVersion: 4,
        reply: null,
        askedWhichTexts: null,
        flaggedBookingIds: [],
        repeated: false,
      });
      expect(validator.check("recordStopOrStart", "response", startAnswer)).toEqual([]);
      expect(commit.requests).toEqual([]);

      const stopAnswer = await recordStopOrStartAlone(
        benOnReturn("stop", "evt-ben-0012", stopSentAt),
        null,
        deps,
      );
      const stopAt = new Date(stopSentAt ?? RETURN_AT);
      // The phone was already stopped; the STOP still moves stop_at to its own time (DL-193), so version 5.
      expect(stopAnswer).toMatchObject({ stopped: true, chatOpen: false, phoneVersion: 5, repeated: false });
      expect(benPhone(world)).toMatchObject({
        stopped: true,
        chatOpen: false,
        stopAt,
        startAt: null,
        version: 5,
      });
      expect(commit.keys).toEqual(["evt-ben-0012"]);
      // K-29's newest row is that STOP at both businesses, and no START row was written.
      const [stopRowId] = responseOf(stopAnswer).consentRowIds;
      for (const business of [BARBERSHOP, YOGA_STUDIO]) {
        expect(await benStanding(world, business)).toMatchObject({
          id: stopRowId,
          revoked: true,
          at: stopAt,
        });
      }
      expect(world.record.consents.filter((row) => row.businessId === null && !row.revoked)).toEqual([]);
    }
  });

  it("on a phone not stopped it moves nothing either, so the STOP at 14:10 written after it still stops the phone", async () => {
    const { world, deps } = await benOnReturnWorld(false);
    const start: StopOrStartRequest = { ...startRecorded().request, sentByActor: null };
    expect(await recordStopOrStartAlone(start, null, deps)).toMatchObject({
      consentRowIds: [],
      stopped: false,
      chatOpen: true,
      phoneVersion: 3,
      reply: null,
    });
    expect(benPhone(world)).toMatchObject({ startAt: null, version: 3 });
    const stop = await recordStopOrStartAlone(
      benOnReturn("stop", "evt-ben-0012", "2026-10-22T14:10:00Z"),
      null,
      deps,
    );
    expect(stop).toMatchObject({ stopped: true, chatOpen: false, phoneVersion: 4 });
    expect(await benStanding(world, BARBERSHOP)).toMatchObject({
      revoked: true,
      at: new Date("2026-10-22T14:10:00Z"),
    });
  });

  it("a START with a known time after the last STOP still lifts it; one at the STOP's own time does not (a tie fails closed)", async () => {
    const { world, deps } = await benOnReturnWorld(true);
    await recordStopOrStartAlone({ ...startRecorded().request, sentByActor: null }, null, deps);
    await recordStopOrStartAlone(benOnReturn("stop", "evt-ben-0012", "2026-10-22T14:10:00Z"), null, deps);
    const tie = await recordStopOrStartAlone(
      benOnReturn("start", "evt-ben-0013", "2026-10-22T14:10:00Z"),
      null,
      deps,
    );
    expect(tie).toMatchObject({ stopped: true, chatOpen: false });
    const later = await recordStopOrStartAlone(
      benOnReturn("start", "evt-ben-0014", "2026-10-22T14:20:00Z"),
      null,
      deps,
    );
    expect(later).toMatchObject({
      stopped: false,
      chatOpen: true,
      reply: { fixedLineId: "startReply", outboxRowId: null },
      repeated: false,
    });
    expect(benPhone(world)).toMatchObject({
      stopped: false,
      chatOpen: true,
      stopAt: new Date("2026-10-22T14:10:00Z"),
      startAt: new Date("2026-10-22T14:20:00Z"),
    });
    const [startRowId] = responseOf(later).consentRowIds;
    expect(await benStanding(world, BARBERSHOP)).toMatchObject({ id: startRowId, revoked: false });
  });
});

/** Every order of the items (the writes on return may arrive in any of them). */
function orders<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    orders([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}

describe("the newest word decides whatever order the writes arrive in (DL-193; the security reviewer's note a)", () => {
  it("a newer STOP on a phone already stopped moves stop_at, so an older START written after it never lifts it", async () => {
    const { world, deps } = await benOnReturnWorld(true);
    // In an outage: start-recorded.json's START at 14:05:11 (its reply sent), then a STOP at 14:10; the STOP written first.
    const stop = await recordStopOrStartAlone(
      benOnReturn("stop", "evt-ben-0012", "2026-10-22T14:10:00Z"),
      null,
      deps,
    );
    expect(stop).toMatchObject({ stopped: true, phoneVersion: 5 });
    expect(benPhone(world)).toMatchObject({ stopAt: new Date("2026-10-22T14:10:00Z"), version: 5 });
    const start = await recordStopOrStartAlone(startRecorded().request, null, deps);
    expect(start).toMatchObject({ stopped: true, chatOpen: false, phoneVersion: 6, repeated: false });
    expect(benPhone(world)).toMatchObject({
      stopped: true,
      chatOpen: false,
      stopAt: new Date("2026-10-22T14:10:00Z"),
      startAt: new Date("2026-10-22T14:05:11Z"),
      version: 6,
    });
    expect(await benStanding(world, BARBERSHOP)).toMatchObject({
      revoked: true,
      at: new Date("2026-10-22T14:10:00Z"),
    });
  });

  it("every START moves start_at, so an older STOP written after a newer START never stops the phone", async () => {
    const { world, deps } = await benOnReturnWorld(true);
    // start-recorded.json lifts the stop (14:05:11); in an outage, a STOP at 14:10 then a START at 14:20, START written first.
    await recordStopOrStartAlone(startRecorded().request, null, deps);
    const start = await recordStopOrStartAlone(
      benOnReturn("start", "evt-ben-0013", "2026-10-22T14:20:00Z"),
      null,
      deps,
    );
    expect(start).toMatchObject({ stopped: false, chatOpen: true, phoneVersion: 6 });
    const stop = await recordStopOrStartAlone(
      benOnReturn("stop", "evt-ben-0012", "2026-10-22T14:10:00Z"),
      null,
      deps,
    );
    expect(stop).toMatchObject({ stopped: false, chatOpen: true, phoneVersion: 7 });
    expect(benPhone(world)).toMatchObject({
      stopped: false,
      chatOpen: true,
      stopAt: new Date("2026-10-22T14:10:00Z"),
      startAt: new Date("2026-10-22T14:20:00Z"),
      version: 7,
    });
    expect(await benStanding(world, BARBERSHOP)).toMatchObject({
      revoked: false,
      at: new Date("2026-10-22T14:20:00Z"),
    });
  });

  it("written in every order, the flag is the newest word's, and stop_at and start_at end at the newest of each kind", async () => {
    type Word = readonly ["stop" | "start", string, string];
    const sets: readonly (readonly Word[])[] = [
      [
        ["start", "evt-ben-0011", "2026-10-22T14:05:11Z"],
        ["stop", "evt-ben-0012", "2026-10-22T14:10:00Z"],
        ["start", "evt-ben-0013", "2026-10-22T14:20:00Z"],
      ],
      [
        ["start", "evt-ben-0011", "2026-10-22T14:05:11Z"],
        ["start", "evt-ben-0013", "2026-10-22T14:20:00Z"],
        ["stop", "evt-ben-0012", "2026-10-22T14:25:00Z"],
      ],
    ];
    for (const words of sets) {
      const newestAt = (kind: "stop" | "start" | null): Date => {
        const times = words
          .filter(([each]) => kind === null || each === kind)
          .map(([, , at]) => Date.parse(at));
        return new Date(Math.max(...times));
      };
      const newestKind = words.find(([, , at]) => Date.parse(at) === newestAt(null).getTime())?.[0];
      expect(orders(words)).toHaveLength(6);
      for (const order of orders(words)) {
        const { world, deps } = await benOnReturnWorld(true);
        for (const [kind, eventId, at] of order) {
          await recordStopOrStartAlone(benOnReturn(kind, eventId, at), null, deps);
        }
        const stopped = newestKind === "stop";
        expect(benPhone(world)).toMatchObject({
          stopped,
          chatOpen: !stopped,
          stopAt: newestAt("stop"),
          startAt: newestAt("start"),
        });
        expect(await benStanding(world, BARBERSHOP)).toMatchObject({ revoked: stopped, at: newestAt(null) });
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("a work phone's STOP asks which texts, and its answer is a consent row (RULES 7.7; S13-32; S2-08)", () => {
  /** Avery is staff at the barbershop and, here, a customer at the yoga studio. */
  function averyWorld(): World {
    return worldOf(
      withMore(flagsSeedRecord(), {
        roles: [
          {
            id: "role-avery-yoga",
            personId: "person-avery",
            businessId: YOGA_STUDIO,
            role: "customer",
            endedAt: null,
            version: 1,
          },
        ],
      }),
    );
  }
  const averyTurn = (kind: StopOrStartRequest["kind"], ids: string[] | null = null): GateAndCommitRequest =>
    stopTurn({
      turnId: `turn-avery-${kind}`,
      handleId: "handle-avery",
      eventId: `evt-avery-${kind}`,
      number: "+15555550103",
      personId: "person-avery",
      kind,
      words: kind === "workPhoneAnswer" ? "Just the yoga texts" : "STOP",
      now: "2026-10-24T09:00:00Z",
      workPhoneBusinessIds: ids,
    });

  /** Her STOP in her turn, with the "which texts?" question its commit opens put in the world: its id and clock row. */
  async function averyAsks(world: World): Promise<{ questionId: string; clockRowId: string }> {
    const request = averyTurn("stop");
    const run = await stopOrStartCore(stopActionOf(request), turnContext(request), depsOn(world));
    const [ask] = run.writes.asks;
    if (ask === undefined) throw new Error("her STOP asks which texts");
    world.record = withQuestions(
      applied(world.record, run.writes.state),
      questionsAsked(run.writes.asks, "turn-avery-stop"),
    );
    // The clock row as the commit makes it for the question (commit/build.ts questionClock).
    const clockRowId = questionClock(ask.question, ask.safeDefault).id;
    expect(run.result.response?.askedWhichTexts?.clockRowId).toBe(clockRowId);
    return { questionId: ask.question.id, clockRowId };
  }

  /** No answer as a clock turn on her handle: its one event id is the clock row (K-05 v1 default 9; README default 24). */
  function clockTurn(
    clockRowId: string,
    eventIds: [string, ...string[]] = [clockRowId],
  ): GateAndCommitRequest {
    const request = stopTurn({
      turnId: `turn-clock-${clockRowId}`,
      handleId: "handle-avery",
      eventId: clockRowId,
      number: AVERY,
      personId: null,
      kind: "workPhoneNoAnswer",
      now: "2026-10-24T10:00:00Z",
    });
    if (request.turn === null) throw new Error("a clock turn");
    request.turn = { ...request.turn, eventIds };
    return request;
  }

  it("STOP: her customer texts stop at once, the work texts wait for her answer, and the question goes back to her", async () => {
    const world = averyWorld();
    const request = averyTurn("stop");
    const run = await stopOrStartCore(stopActionOf(request), turnContext(request), depsOn(world));
    const response = run.result.response;
    expect(response).toMatchObject({ stopped: false, chatOpen: true, reply: null, repeated: false });
    expect(response?.askedWhichTexts).toEqual({
      openQuestionId: run.writes.asks[0]?.question.id,
      clockRowId: `clock-${run.writes.asks[0]?.question.id ?? ""}`,
    });
    expect(
      run.writes.asks.map((ask) => [
        ask.question.step,
        ask.question.handleId,
        ask.question.clock,
        ask.safeDefault,
      ]),
    ).toEqual([["S13-32", "handle-avery", "1 h", "everyText"]]);
    expect(
      run.writes.state.map((write) =>
        write.op === "insert" ? [write.values.business_id, write.values.revoked] : null,
      ),
    ).toEqual([[YOGA_STUDIO, true]]);
    expect(
      run.writes.messages.map((row) => [row.recipientHandleId, row.openQuestionId, row.sendClass]),
    ).toEqual([["handle-avery", run.writes.asks[0]?.question.id, "quick_reply"]]);
    expect(() => {
      checkUnits([unitOf(run.writes)]);
    }).not.toThrow();
    world.record = applied(world.record, run.writes.state);

    // The yoga studio's routine text to her is taken out of a later commit; the barbershop's work text stays.
    const rowTo = (id: string, businessId: string): OutboxRowNew => ({
      id,
      recipientHandleId: "handle-avery",
      recipientPersonId: "person-avery",
      businessId,
      bookingId: null,
      channel: "imessage",
      sendClass: "routine",
      openQuestionId: null,
      copyOfRowId: null,
      versionsRead: [],
    });
    const kept = await keepStop(
      [partUnit([rowTo("out-yoga-avery", YOGA_STUDIO), rowTo("out-barber-avery", BARBERSHOP)])],
      { turn: null, replies: new Set() },
      messagesReaderOn(world, null),
    );
    expect(kept.dropped).toEqual([{ rowId: "out-yoga-avery", handleId: "handle-avery" }]);
  });

  it("her answer naming none means every text: the STOP for every business and the flag; no answer does the same", async () => {
    for (const kind of ["workPhoneAnswer", "workPhoneNoAnswer"] as const) {
      const world = averyWorld();
      // No answer comes as the clock turn of the question her STOP asked (default 10); her answer, in her text's turn.
      const request =
        kind === "workPhoneNoAnswer" ? clockTurn((await averyAsks(world)).clockRowId) : averyTurn(kind);
      const run = await stopOrStartCore(stopActionOf(request), turnContext(request), depsOn(world));
      expect(run.result.response).toMatchObject({ stopped: true, chatOpen: false, askedWhichTexts: null });
      expect(run.result.response?.reply === null).toBe(kind === "workPhoneNoAnswer");
      expect(run.writes.state[0]).toMatchObject({ values: { business_id: null, revoked: true } });
    }
  });

  it("an answer naming the yoga studio withdraws texts there only; a phone with no work role is notAWorkPhone", async () => {
    const world = averyWorld();
    const request = averyTurn("workPhoneAnswer", [YOGA_STUDIO]);
    const run = await stopOrStartCore(stopActionOf(request), turnContext(request), depsOn(world));
    expect(run.result.response).toMatchObject({ stopped: false, reply: null, askedWhichTexts: null });
    expect(run.writes.state).toHaveLength(1);
    expect(run.writes.state[0]).toMatchObject({
      op: "insert",
      table: "consents",
      values: {
        business_id: YOGA_STUDIO,
        revoked: true,
        exact_words: "Just the yoga texts",
        handle_id: "handle-avery",
      },
    });

    const alex = stopTurn({
      turnId: "turn-alex-answer",
      handleId: "handle-alex",
      eventId: "evt-alex-answer",
      number: ALEX,
      personId: "person-alex",
      kind: "workPhoneAnswer",
      now: "2026-10-24T09:00:00Z",
    });
    const refused = await stopOrStartCore(
      stopActionOf(alex),
      turnContext(alex),
      depsOn(worldOf(flagsSeedRecord())),
    );
    expect(refused.result.error).toEqual({ error: "notAWorkPhone", phoneNumber: ALEX });
  });

  it("no answer counts only from the clock row her own STOP armed, never from another clock turn (DL-193; note c)", async () => {
    const world = averyWorld();
    const refused = async (request: GateAndCommitRequest, on: World = world): Promise<void> => {
      const run = await stopOrStartCore(stopActionOf(request), turnContext(request), depsOn(on));
      expect(run.result.error).toEqual({ error: "notFromThatPhone", phoneNumber: AVERY });
      expect(run.writes.state).toEqual([]);
      expect(run.writes.messages).toEqual([]);
    };
    // Before her STOP asks, no clock row counts.
    await refused(clockTurn("clock-oq-which-texts-unasked"));
    const { clockRowId } = await averyAsks(world);
    // Another clock row on her handle, her own text's turn, and a turn with another event beside the clock row.
    await refused(clockTurn("clock-call-off-avery-nov20"));
    await refused(averyTurn("workPhoneNoAnswer"));
    await refused(clockTurn(clockRowId, [clockRowId, "evt-avery-text"]));
    // A question at the stop home on her handle that no STOP of hers asked: its clock row counts for nothing.
    world.record = withQuestions(world.record, [
      {
        id: "oq-avery-stop-home-other",
        turnId: "turn-avery-other",
        handleId: "handle-avery",
        businessId: null,
        step: "S13-32",
        status: "waiting",
      },
    ]);
    await refused(clockTurn("clock-oq-avery-stop-home-other"));
    expect(world.record.phones.find((each) => each.handleId === "handle-avery")?.stopped).toBe(false);
    // Once her question is answered, its clock row counts for nothing either.
    const answered = worldOf({
      ...world.record,
      questions: world.record.questions.map((question) => ({ ...question, status: "answered" as const })),
    });
    await refused(clockTurn(clockRowId), answered);

    // Her own question's clock row: every text stops.
    const request = clockTurn(clockRowId);
    const run = await stopOrStartCore(stopActionOf(request), turnContext(request), depsOn(world));
    expect(run.result.response).toMatchObject({
      stopped: true,
      chatOpen: false,
      reply: null,
      askedWhichTexts: null,
      repeated: false,
    });
    expect(run.writes.state[0]).toMatchObject({ values: { business_id: null, revoked: true } });
  });

  it("a firing with no turn names its clock row by its request id: hers counts, keyed by it; Sam's does not", async () => {
    const world = averyWorld();
    const { clockRowId } = await averyAsks(world);
    // Sam, the barbershop's owner, stops too: his question's clock row is armed for his phone, never hers.
    const samStop = stopTurn({
      turnId: "turn-sam-stop",
      handleId: "handle-sam",
      eventId: "evt-sam-stop",
      number: SAM,
      personId: "person-sam",
      now: "2026-10-24T09:05:00Z",
    });
    const samRun = await stopOrStartCore(stopActionOf(samStop), turnContext(samStop), depsOn(world));
    const [samAsk] = samRun.writes.asks;
    if (samAsk === undefined) throw new Error("Sam's STOP asks which texts");
    world.record = withQuestions(world.record, questionsAsked(samRun.writes.asks, "turn-sam-stop"));
    const samClock = questionClock(samAsk.question, samAsk.safeDefault).id;

    const firing = (requestId: string): StopOrStartRequest => ({
      caller: {
        kind: "clockFiring",
        turnId: null,
        requestId,
        businessId: null,
        personId: null,
        traceId: `trace-${requestId}`,
      },
      kind: "workPhoneNoAnswer",
      phoneNumber: AVERY,
      inboundEventId: null,
      words: "STOP",
      alsoCancelVisit: false,
      workPhoneBusinessIds: null,
      sentByActor: null,
    });
    const commit = fakeAloneCommit(world);
    const deps = depsOn(world, { commitAlone: commit, now: () => "2026-10-24T10:00:00Z" });
    for (const other of [samClock, "clock-nobody-armed"]) {
      expect(await recordStopOrStartAlone(firing(other), null, deps)).toEqual({
        error: "notFromThatPhone",
        phoneNumber: AVERY,
      });
    }
    expect(commit.requests).toEqual([]);
    const answer = await recordStopOrStartAlone(firing(clockRowId), null, deps);
    expect(answer).toMatchObject({ stopped: true, chatOpen: false, reply: null, repeated: false });
    expect(validator.check("recordStopOrStart", "response", answer)).toEqual([]);
    // Keyed by its clock row (K-09 v1: "the clock row for workPhoneNoAnswer is the key"): fired again, written once.
    expect(commit.keys).toEqual([clockRowId]);
    expect(await recordStopOrStartAlone(firing(clockRowId), null, deps)).toMatchObject({
      stopped: true,
      repeated: true,
    });
    expect(commit.keys).toEqual([clockRowId]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

/** Alex's bare "2" to A7-17 on his Nov 14 visit (K-09 commit-limit-2-owner-rule.json): a booking part. */
function alexBookingPart(): GateRequest {
  return gateRequest(decidedOf(gateExchange("commit-limit-2-owner-rule.json")));
}

/** The gate's flag reads over the world, under the barbershop's scope. */
function gateReadsOn(world: World): GateFlagReads {
  const reader = flagsReaderOn(world, BARBERSHOP);
  return {
    openPausesOfPerson: (personId) => reader.openPausesOfPerson(personId),
    openPausesOfPhone: (number) => reader.openPausesOfPhone(number),
    bookingFlags: async (bookingId) => {
      const head = await reader.bookingHead(bookingId);
      return head === null
        ? null
        : {
            id: head.id,
            businessId: head.businessId,
            bookerPersonId: head.bookerPersonId,
            servedPersonId: head.servedPersonId,
            deceased: head.deceased,
          };
    },
  };
}

/** Alex's Nov 14 visit with Riley (K-09 safety-outcome-hold.json), as K-04's head would hold it. */
function withNov14(record: FlagsRecord): FlagsRecord {
  return withMore(record, {
    bookings: [
      {
        id: "booking-alex-riley-nov14",
        businessId: BARBERSHOP,
        flow: "A",
        stage: "booked",
        bookerPersonId: "person-alex",
        servedPersonId: "person-alex",
        payerPersonId: "person-alex",
        private: false,
        deceased: false,
        version: 4,
      },
    ],
  });
}

describe("paused blocks a booking part (flag-paused.json; A3-48; S11-62)", () => {
  const paused = (): Exchange<RecordFlagRequest, K09.SetRecordFlagResponse> => flagPaused();
  const NOV14 = {
    bookingId: "booking-alex-riley-nov14",
    startsAt: "2026-11-14T15:00:00Z",
    zone: "America/New_York",
  };

  it("Sam's pause on the owner portal answers flag-paused.json, arming the Nov 14 visit's call-off clock", async () => {
    const exchange = paused();
    const world = worldOf(withNov14(flagsSeedRecord()));
    const commit = fakeAloneCommit(world);
    const answer = await setRecordFlagAlone(
      exchange.request,
      null,
      depsOn(
        world,
        {
          commitAlone: commit,
          now: () => exchange.given.now,
          visits: { visitsOf: () => Promise.resolve([NOV14]) },
        },
        BARBERSHOP,
      ),
    );
    expect(answer).toEqual(exchange.outcome);
    expect(validator.check("setRecordFlag", "response", answer)).toEqual([]);

    const [request] = commit.requests;
    expect(request?.key).toBe("req-portal-sam-0140");
    expect(request?.businessId).toBe(BARBERSHOP);
    expect(request?.writes.state).toEqual([
      {
        op: "insert",
        table: "pauses",
        values: {
          id: "pause-alex-lees",
          business_id: BARBERSHOP,
          target: "person",
          person_id: "person-alex",
          set_by_turn_id: null,
          set_at: exchange.given.now,
        },
      },
    ]);
    // Called off at 7pm the day before the visit, New York time (Nov 13, 19:00 EST is Nov 14 00:00Z).
    expect(request?.writes.clockRows.make).toEqual([
      {
        id: "clock-call-off-alex-nov14",
        kind: "step",
        openQuestionId: null,
        reservationId: null,
        handleId: null,
        businessId: BARBERSHOP,
        bookingId: "booking-alex-riley-nov14",
        fires: { step: "S11-62", branch: "callOff", pause_id: "pause-alex-lees", no_fee: true },
        due: { dueAt: "2026-11-14T00:00:00Z", dueZone: "America/New_York" },
      },
    ]);
    for (const write of request?.writes.state ?? []) expect(k05Problems("stateWrite", write)).toEqual([]);
    for (const clock of request?.writes.clockRows.make ?? [])
      expect(k05Problems("clockNew", clock)).toEqual([]);
    for (const entry of request?.writes.events ?? []) expect(k05Problems("eventEntry", entry)).toEqual([]);

    // Paused again: already as asked, nothing written.
    const again = await setRecordFlagAlone(
      { ...exchange.request, caller: { ...exchange.request.caller, requestId: "req-portal-sam-0141" } },
      null,
      depsOn(world, { commitAlone: commit, now: () => exchange.given.now }, BARBERSHOP),
    );
    expect(again).toEqual({ rowId: "pause-alex-lees", version: 1, callOffClockRowIds: [], repeated: true });
    expect(commit.keys).toEqual(["req-portal-sam-0140"]);
  });

  it("the gate then stops Alex's booking part before any limit runs; his other work, a STOP and Sam's own part go on", async () => {
    const exchange = paused();
    const world = worldOf(withNov14(flagsSeedRecord()));
    const deps = depsOn(
      world,
      { commitAlone: fakeAloneCommit(world), now: () => exchange.given.now },
      BARBERSHOP,
    );
    await setRecordFlagAlone(exchange.request, null, deps);

    const calls: LimitCall[] = [];
    const limits = flagsFirst(scriptedLimits({}, calls), { reads: () => gateReadsOn(world) });
    const verdict = await runGate(alexBookingPart(), callContext(BARBERSHOP), limits);
    expect(verdict).toMatchObject({
      verdict: "gated",
      parts: [
        { part: 0, result: "stopped", stoppedBy: { limit: 1, outcome: "ask", action: "askedDecider" } },
      ],
    });
    expect(calls).toEqual([]);

    // Once Sam clears it (the owner clears a pause: arch 03 line 177), the same part takes limits 1 to 6.
    const clear = await setRecordFlagAlone(
      {
        ...exchange.request,
        action: "clear",
        target: { pauseId: "pause-alex-lees" },
        expectVersion: 1,
        caller: { ...exchange.request.caller, requestId: "req-portal-sam-0142" },
      },
      null,
      deps,
    );
    expect(clear).toEqual({ rowId: "pause-alex-lees", version: 2, callOffClockRowIds: [], repeated: false });
    const after = await runGate(alexBookingPart(), callContext(BARBERSHOP), limits);
    expect(after).toMatchObject({ verdict: "gated", parts: [{ part: 0, result: "passed" }] });
    expect(calls.map((each) => each.limit)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("only the owner clears a pause; Alex himself cannot (notAllowed: notDecider), and a stale clear is versionChanged", async () => {
    const exchange = paused();
    const world = worldOf(withNov14(flagsSeedRecord()));
    const deps = depsOn(
      world,
      { commitAlone: fakeAloneCommit(world), now: () => exchange.given.now },
      BARBERSHOP,
    );
    await setRecordFlagAlone(exchange.request, null, deps);
    const byAlex = await setRecordFlagAlone(
      {
        ...exchange.request,
        action: "clear",
        target: { pauseId: "pause-alex-lees" },
        expectVersion: 1,
        caller: { ...exchange.request.caller, personId: "person-alex", requestId: "req-alex-1" },
      },
      null,
      deps,
    );
    expect(byAlex).toEqual({ error: "notAllowed", why: "notDecider" });
    const stale = await setRecordFlagAlone(
      {
        ...exchange.request,
        action: "clear",
        target: { personId: "person-alex" },
        expectVersion: 3,
        caller: { ...exchange.request.caller, requestId: "req-portal-sam-0143" },
      },
      null,
      deps,
    );
    expect(stale).toEqual({
      error: "versionChanged",
      changed: [{ table: "pauses", rowId: "pause-alex-lees", readVersion: 3, currentVersion: 1 }],
    });
    expect(world.record.pauses.find((pause) => pause.id === "pause-alex-lees")?.clearedAt).toBeNull();
  });

  it("the call-off clock is due 7pm the day before, else 2 hours before a same-day visit, else at once (S11-62)", () => {
    expect(callOffDueAt(NOV14, "2026-10-23T15:00:00Z")).toBe("2026-11-14T00:00:00Z");
    expect(callOffDueAt(NOV14, "2026-11-14T01:00:00Z")).toBe("2026-11-14T13:00:00Z");
    expect(callOffDueAt(NOV14, "2026-11-14T14:10:05Z")).toBe("2026-11-14T14:10:05Z");
    // Across the clocks' change (Nov 1, 2am): a visit on Nov 1 is called off at 7pm EDT on Oct 31, which is 23:00Z.
    expect(callOffDueAt({ ...NOV14, startsAt: "2026-11-01T18:00:00Z" }, "2026-10-23T15:00:00Z")).toBe(
      "2026-10-31T23:00:00Z",
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("deceased blocks a new charge (A7-81; arch 03 line 175)", () => {
  /** Alex's bare "2" with its choice now charging (K-02 v1 stakesFrom charge), on his Nov 14 visit. */
  function chargePart(): GateRequest {
    const decided = copy(decidedOf(gateExchange("commit-limit-2-owner-rule.json")));
    for (const choice of decided.context.choices) {
      choice.stakes = "high";
      choice.stakesFrom = [{ why: "charge", step: "A7-17", ref: "fee" }];
    }
    return gateRequest(decided);
  }

  it("a death reported on anyone's word marks the booking; a charge on it then waits for the owner, other work goes on", async () => {
    const world = worldOf(withNov14(flagsSeedRecord()));
    const commit = fakeAloneCommit(world);
    const report: RecordFlagRequest = {
      caller: {
        kind: "page",
        turnId: null,
        requestId: "req-page-maya-0001",
        businessId: BARBERSHOP,
        personId: "person-maya",
        traceId: "trace-page-maya-0001",
      },
      flag: "deceased",
      action: "set",
      target: { bookingId: "booking-alex-riley-nov14" },
      expectVersion: 4,
    };
    const answer = await setRecordFlagAlone(
      report,
      null,
      depsOn(world, { commitAlone: commit, now: () => "2026-10-25T12:00:00Z" }, BARBERSHOP),
    );
    expect(answer).toEqual({
      rowId: "booking-alex-riley-nov14",
      version: 5,
      callOffClockRowIds: [],
      repeated: false,
    });
    expect(commit.requests[0]?.writes.state).toEqual([
      {
        op: "update",
        table: "bookings",
        key: { id: "booking-alex-riley-nov14" },
        expectVersion: 4,
        set: { deceased: true },
      },
    ]);
    expect(commit.requests[0]?.writes.events.map((entry) => entry.kind)).toEqual(["booking.flagged"]);

    const calls: LimitCall[] = [];
    const limits = flagsFirst(scriptedLimits({}, calls), { reads: () => gateReadsOn(world) });
    expect(await runGate(chargePart(), callContext(BARBERSHOP), limits)).toMatchObject({
      verdict: "gated",
      parts: [{ result: "stopped", stoppedBy: { limit: 1, action: "askedDecider" } }],
    });
    expect(calls).toEqual([]);
    // The same booking's work that charges nothing goes on to the limits; so does a charge on another booking.
    expect(await runGate(alexBookingPart(), callContext(BARBERSHOP), limits)).toMatchObject({
      parts: [{ result: "passed" }],
    });
    const otherBooking = chargePart();
    if (otherBooking.input.kind !== "decided") throw new Error("decided");
    for (const choice of otherBooking.input.decided.context.choices)
      choice.target.bookingId = "booking-alex-haircut";
    expect(await runGate(otherBooking, callContext(BARBERSHOP), limits)).toMatchObject({
      parts: [{ result: "passed" }],
    });
  });

  it("only the owner clears deceased, and only the person served clears private (arch 03 line 177)", async () => {
    const world = worldOf(withNov14(flagsSeedRecord()));
    const deps = depsOn(
      world,
      { commitAlone: fakeAloneCommit(world), now: () => "2026-10-25T12:00:00Z" },
      BARBERSHOP,
    );
    const asCaller = (personId: string, requestId: string): RecordFlagRequest["caller"] => ({
      kind: "page",
      turnId: null,
      requestId,
      businessId: BARBERSHOP,
      personId,
      traceId: `trace-${requestId}`,
    });
    const flagOf = (
      flag: "deceased" | "private",
      action: "set" | "clear",
      personId: string,
      n: number,
      expectVersion: number | null,
    ): RecordFlagRequest => ({
      caller: asCaller(personId, `req-${flag}-${action}-${String(n)}`),
      flag,
      action,
      target: { bookingId: "booking-alex-riley-nov14" },
      expectVersion,
    });
    expect(
      await setRecordFlagAlone(flagOf("deceased", "set", "person-maya", 1, null), null, deps),
    ).toMatchObject({ version: 5 });
    expect(await setRecordFlagAlone(flagOf("deceased", "clear", "person-alex", 2, 5), null, deps)).toEqual({
      error: "notAllowed",
      why: "notDecider",
    });
    expect(
      await setRecordFlagAlone(flagOf("deceased", "clear", "person-sam", 3, 5), null, deps),
    ).toMatchObject({ version: 6, repeated: false });

    expect(
      await setRecordFlagAlone(flagOf("private", "set", "person-riley", 4, null), null, deps),
    ).toMatchObject({ version: 7 });
    expect(await setRecordFlagAlone(flagOf("private", "clear", "person-sam", 5, 7), null, deps)).toEqual({
      error: "notAllowed",
      why: "notDecider",
    });
    expect(await setRecordFlagAlone(flagOf("private", "clear", "person-alex", 6, 6), null, deps)).toEqual({
      error: "versionChanged",
      changed: [{ table: "bookings", rowId: "booking-alex-riley-nov14", readVersion: 6, currentVersion: 7 }],
    });
    expect(
      await setRecordFlagAlone(flagOf("private", "clear", "person-alex", 7, 7), null, deps),
    ).toMatchObject({ version: 8, repeated: false });
    expect(world.record.bookings.find((head) => head.id === "booking-alex-riley-nov14")).toMatchObject({
      private: false,
      deceased: false,
      version: 8,
    });
    // A flag already as asked answers repeated; a flag on the wrong kind of target is refused before anything is read.
    expect(
      await setRecordFlagAlone(flagOf("private", "clear", "person-alex", 8, 8), null, deps),
    ).toMatchObject({ repeated: true });
    await expect(
      setRecordFlagAlone(
        { ...flagOf("private", "set", "person-sam", 9, null), target: { personId: "person-alex" } },
        null,
        deps,
      ),
    ).rejects.toMatchObject({ fault: "targetNotOfFlag" });
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("ids and labels only: no number, address or words leaves the flags calls (K-08 v1)", () => {
  it("answers, event-log entries and the commit's requests carry no number, address or person's words", async () => {
    const world = benWorld();
    const exchange = stopRecorded();
    const run = await stopOrStartCore(
      stopActionOf(exchange.request),
      turnContext(exchange.request),
      depsOn(world),
    );
    const pausedFixture = flagPaused();
    const phonePause: RecordFlagRequest = { ...pausedFixture.request, target: { phoneNumber: ALEX } };
    const commit = fakeAloneCommit(world);
    await setRecordFlagAlone(
      phonePause,
      null,
      depsOn(world, { commitAlone: commit, now: () => "2026-10-23T15:00:00Z" }, BARBERSHOP),
    );
    const strings = stringsIn([
      run.result,
      run.writes.stateEvents,
      commit.requests.map((request) => request.writes.events),
    ]);
    for (const secret of [BEN_K09, ALEX, "STOP", ...world.record.privateValues])
      expect(strings).not.toContain(secret);
    // The pause row itself holds the number (K-04 pauses.phone_number); its entry does not.
    expect(commit.requests[0]?.writes.state[0]).toMatchObject({
      values: { target: "phone", phone_number: ALEX },
    });
  });

  it("refusals name a fault, never a value; a turn's STOP never runs alone", async () => {
    const world = benWorld();
    const exchange = stopRecorded();
    const action = stopActionOf(exchange.request);
    await expect(recordStopOrStartAlone(action.request, null, depsOn(world))).rejects.toMatchObject({
      fault: "turnRidesInCommit",
      message: "flags refused: turnRidesInCommit",
    });
    expect(EVERY_BUSINESS).toBe("every-business");
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("the Tool API calls: through the base under a business scope, and a flag set in a turn's commit", () => {
  it("setRecordFlag through the Tool API base answers flag-paused.json, request and answer held to K-09 v1", async () => {
    const exchange = flagPaused();
    const world = worldOf(withNov14(flagsSeedRecord()));
    const commit = fakeAloneCommit(world);
    const scope = recordingScope();
    const api = createToolApi<RecordingRepo>({
      validator,
      scope,
      handlers: {
        ...notBuiltHandlers(),
        setRecordFlag: setRecordFlagHandler<RecordingRepo>(
          depsOn(world, { commitAlone: commit, now: () => exchange.given.now }, BARBERSHOP),
        ),
      },
    });
    const { trace, spans } = traceFor(exchange.request);
    expect(await api.call("setRecordFlag", exchange.request, trace)).toEqual({
      rowId: "pause-alex-lees",
      version: 1,
      callOffClockRowIds: [],
      repeated: false,
    });
    expect(scope.events.map((event) => event.what)).toEqual(["begin", "scope", "commit"]);
    expect(spans.map((span) => [span.hop, span.outcome])).toEqual([["pageRequest", "ok"]]);
    expect(commit.keys).toEqual(["req-portal-sam-0140"]);

    // A refusal is one of its K-09 errors, and the base rolls the transaction back.
    const byAlex = {
      ...exchange.request,
      action: "clear" as const,
      target: { pauseId: "pause-alex-lees" },
      expectVersion: 1,
      caller: { ...exchange.request.caller, personId: "person-alex", requestId: "req-alex-2" },
    };
    expect(await api.call("setRecordFlag", byAlex, traceFor(byAlex).trace)).toEqual({
      error: "notAllowed",
      why: "notDecider",
    });
    expect(scope.events.at(-1)?.what).toBe("rollback");
  });

  it("a STOP names no business, so the base refuses it (noBusinessScope): it runs on the runtime side instead", async () => {
    const world = benWorld();
    const start = startRecorded();
    const api = createToolApi<RecordingRepo>({
      validator,
      scope: recordingScope(),
      handlers: { ...notBuiltHandlers(), recordStopOrStart: recordStopOrStartHandler(depsOn(world)) },
    });
    expect(await api.call("recordStopOrStart", start.request, traceFor(start.request).trace)).toEqual({
      error: "noBusinessScope",
      call: "recordStopOrStart",
    });
  });

  it("a threat's pause rides in the turn's commit as a core action; its call-off clocks come back beside the unit", async () => {
    const world = worldOf(withNov14(flagsSeedRecord()));
    const turnRequest = stopRecorded().request;
    const caller = {
      kind: "turn" as const,
      turnId: "turn-alex-threat",
      requestId: "turn-alex-threat",
      businessId: BARBERSHOP,
      personId: "person-alex",
      traceId: "trace-alex-0204",
    };
    const base = turnRequest.turn;
    if (base === null) throw new Error("stop-recorded.json carries its turn");
    turnRequest.caller = caller;
    turnRequest.turn = {
      ...base,
      id: "turn-alex-threat",
      handleId: "handle-alex",
      eventIds: ["evt-alex-0204"],
    };
    turnRequest.now = "2026-10-23T14:42:02Z";
    const action = {
      call: "setRecordFlag" as const,
      request: {
        caller,
        flag: "paused" as const,
        action: "set" as const,
        target: { personId: "person-alex" },
        expectVersion: null,
      },
    };
    turnRequest.core = [action];
    const visits = {
      visitsOf: () =>
        Promise.resolve([
          {
            bookingId: "booking-alex-riley-nov14",
            startsAt: "2026-11-14T15:00:00Z",
            zone: "America/New_York",
          },
        ]),
    };
    const { run, clocks } = await recordFlagCore(
      action,
      turnContext(turnRequest),
      depsOn(world, { visits }, BARBERSHOP),
    );
    expect(run.result.call).toBe("setRecordFlag");
    expect(run.result.error).toBeNull();
    expect(run.result.response).toMatchObject({ version: 1, repeated: false });
    expect(run.writes.state).toEqual([
      {
        op: "insert",
        table: "pauses",
        values: expect.objectContaining({
          business_id: BARBERSHOP,
          target: "person",
          person_id: "person-alex",
          set_by_turn_id: "turn-alex-threat",
          set_at: "2026-10-23T14:42:02Z",
        }) as unknown,
      },
    ]);
    expect(clocks.map((clock) => clock.bookingId)).toEqual(["booking-alex-riley-nov14"]);
    expect(() => {
      checkUnits([unitOf(run.writes)]);
    }).not.toThrow();
    // The turn's UnitWrites has no list for a core action's own clocks: a plan holding them is refused, never cut.
    expect(() => unitWritesOf({ ...run.writes, clocks })).toThrow(TypeError);
  });
});
