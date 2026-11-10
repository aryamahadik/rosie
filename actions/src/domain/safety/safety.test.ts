// T-318's proofs (the card's "Proves it with"), on the frozen contracts' fixtures (K-09 v1 safety-outcome-hold.json and
// commit-s1-02.json; K-02 v1's safety reads; K-34 v1's seed-outcome-crisis, seed-hold-released and seed-threat-pause;
// K-04 v1's seeds), through in-memory reads and fakes of K-05's commit, never a database:
//   - safety-outcome-hold.json gives its holds;
//   - a crisis outcome holds routine work until a "we're safe" with a fresh read-back;
//   - a threat pauses later visits and nothing books (A3-48);
//   - unsafe at home makes the booking private (A3-50);
//   - outcome fields that name people are written sealed (the fake repo asserts the sealed column is used).
// And around them: a repeat writes nothing and answers the first record, a No holds nothing (commit-s1-02.json), each
// release only by its rule, harm reports to Rosie's team that day, and nothing logged, with ids and labels only.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type * as K09 from "../../../../contracts/generated/tool-api/tool-api.v1";
import {
  gateAndCommit,
  heldParts,
  isHeld,
  type CommitPorts,
  type CommitTurnContext,
  type CoreAction,
  type GateAndCommitRequest,
  type OpenHolds,
  type SafetyHold,
} from "../../commit";
import { doublePorts } from "../../commit/test-support";
import {
  callContext,
  copy,
  gateExchange,
  scriptedLimits,
  type LimitCall,
} from "../../gate/framework/test-support";
import { createToolApiValidator, NotBuiltError, type ToolApiValidator } from "../../tool-api";
import type { FlagsReader } from "../flags";
import { flagsReaderOn, fixtureIds, messagesReaderOn, stringsIn } from "../flags/test-support";
import { contractJson } from "../messages-consent/test-support";
import { SafetyRefusedError } from "./errors";
import {
  recordSafetyOutcomeAlone,
  recordSafetyOutcomeCore,
  releaseSafetyHoldAlone,
  releaseSafetyHoldCore,
  type SafetyDeps,
} from "./handlers";
import { KEYED_SAFETY_IDS } from "./ids";
import { PLUGIN_LISTS_NO_STOP_WORDS, type SafetyReader, type StopWords } from "./ports";
import { base64Of, byteaText, wordsOf, type RecordRequest, type RecordResponse } from "./record";
import type { ReleaseRequest } from "./release";
import { isClearSafe, ruleOf, type SafetyResult } from "./rules";
import {
  BARBERSHOP,
  SAFETY_SEEDS,
  TEST_LINES,
  applySafetyWrites,
  fakeSealer,
  fakeTelling,
  fixtureSafetyIds,
  safetyReaderOn,
  safetyWorldOf,
  type FakeSealer,
  type FakeTelling,
  type SafetyWorld,
} from "./test-support";

const validator: ToolApiValidator = createToolApiValidator();

type RecordAction = Extract<CoreAction, { call: "recordSafetyOutcome" }>;
type ReleaseAction = Extract<CoreAction, { call: "releaseSafetyHold" }>;

interface RecordExchange {
  readonly given: { readonly now: string };
  readonly request: RecordRequest;
  readonly outcome: RecordResponse;
}

/** K-09 v1's safety-outcome-hold.json, a fresh copy. */
const holdExchange = (): RecordExchange =>
  copy(contractJson("tool-api/fixtures/safety-outcome-hold.json") as RecordExchange);

/** A K-02 v1 safety read fixture (contracts/model/fixtures), a fresh copy. */
const safetyRead = (file: string): SafetyResult =>
  copy(contractJson(`model/fixtures/${file}`) as SafetyResult);

/** A K-02 read re-keyed to another text, word for word otherwise. */
const readOf = (file: string, eventId: string): SafetyResult => ({ ...safetyRead(file), eventId });

/** A clear "we're safe, it's handled" (A3-24), read as No and over, as K-34's seed-hold-released reads it. */
function weAreSafe(eventId: string): SafetyResult {
  return {
    ...safetyRead("safety-no.json"),
    eventId,
    read: {
      labels: [
        {
          outcome: "No",
          tense: "over",
          evidence: "we're safe, it's handled",
          atRisk: "nobody",
          writer: "the person at the handle",
        },
      ],
    },
  };
}

/** Alex's Nov 14 visit with Riley at the barbershop, as T-317's flag-paused.json covers it (S11-62). */
const NOV14 = {
  bookingId: "booking-alex-riley-nov14",
  startsAt: "2026-11-14T15:00:00Z",
  zone: "America/New_York",
};

/** The pause and call-off ids K-34's seed-threat-pause.json names for the threat turn's rows (T-317's ids double). */
const THREAT_FLAG_IDS = fixtureIds([
  [
    "pause",
    "turn-alex-threat",
    JSON.stringify({ target: "person", person_id: "person-alex" }),
    "pause-alex-threat-person",
  ],
  [
    "pause",
    "turn-alex-threat",
    JSON.stringify({ target: "phone", phone_number: "+15555550101" }),
    "pause-alex-threat-phone",
  ],
]);

/** The ids K-09's fixtures name for the rows of each text's record. */
const FIXTURE_IDS = fixtureSafetyIds({
  "evt-alex-0204": {
    outcome: "safety-outcome-alex-0204",
    hold: "hold-alex-0204",
    line: "out-alex-threat-line",
  },
  "evt-sam-0001": { outcome: "safety-outcome-sam-0001" },
});

interface Doubles {
  readonly world: SafetyWorld;
  readonly sealer: FakeSealer;
  readonly telling: FakeTelling;
  readonly deps: SafetyDeps<unknown>;
}

/** Every port of the safety calls over the world, under the barbershop's scope. */
function doublesOn(world: SafetyWorld, extra: SafetyDeps<unknown> = {}): Doubles {
  const sealer = fakeSealer();
  const telling = fakeTelling({ "evt-alex-0204": "handoff-alex-threat" });
  const deps: SafetyDeps<unknown> = {
    reader: () => safetyReaderOn(world, BARBERSHOP),
    flagsReader: () => flagsReaderOn(world.flags, BARBERSHOP),
    messagesReader: () => messagesReaderOn(world.flags, BARBERSHOP),
    sealer: () => sealer,
    ids: FIXTURE_IDS,
    flagIds: THREAT_FLAG_IDS,
    visits: { visitsOf: () => Promise.resolve([NOV14]) },
    lines: TEST_LINES,
    // The barbershop's plug-in lists no words that stop a booking (K-09 v1.1 j3-safety-arrival-own-line.json).
    stopWords: PLUGIN_LISTS_NO_STOP_WORDS,
    telling,
    ...extra,
  };
  return { world, sealer, telling, deps };
}

/** K-34's reads over the world with the texts' arrival never read: a rule decided without it never asks for it. */
function arrivalUnread(world: SafetyWorld): SafetyReader {
  return {
    ...safetyReaderOn(world, BARBERSHOP),
    arrivedAt: () => Promise.reject(new Error("decided without the texts' arrival")),
  };
}

/** A secure page's caller acting for Sam, under the barbershop. */
function samsPage(requestId: string): K09.Caller {
  return {
    kind: "page",
    turnId: null,
    requestId,
    businessId: BARBERSHOP,
    personId: "person-sam",
    traceId: `trace-${requestId}`,
  };
}

/** The deps without one port, as the Worker runs before that port's task lands (its default then applies). */
function withoutPort(deps: SafetyDeps<unknown>, port: keyof SafetyDeps<unknown>): SafetyDeps<unknown> {
  return Object.fromEntries(Object.entries(deps).filter(([key]) => key !== port));
}

/** The bundle commit-s1-02.json's turn pins. */
const BUNDLE = { hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037", build: 1 };

/** A turn of core actions only, on one handle, for these texts, as the commit hands it to runCore. */
function turnOf(input: {
  turnId: string;
  handleId: string;
  eventIds: string[];
  personId: string | null;
  now: string;
  core: (caller: K09.Caller) => CoreAction[];
}): CommitTurnContext {
  const caller: K09.Caller = {
    kind: "turn",
    turnId: input.turnId,
    requestId: input.turnId,
    businessId: BARBERSHOP,
    personId: input.personId,
    traceId: `trace-${input.turnId}`,
  };
  const [first, ...rest] = input.eventIds;
  if (first === undefined) throw new Error("a turn joins at least one text");
  const turn = {
    id: input.turnId,
    handleId: input.handleId,
    eventIds: [first, ...rest] as [string, ...string[]],
    bundleId: BUNDLE,
    traceId: caller.traceId,
    joinedTraceIds: [],
    tries: 1,
  };
  const request: GateAndCommitRequest = {
    caller,
    turn,
    input: { kind: "coreOnly" },
    core: input.core(caller),
    now: input.now,
  };
  return { request, turn, repo: { name: "safety-test-repo" }, businessId: BARBERSHOP };
}

/** A recordSafetyOutcome core action for one text. */
function recordAction(
  caller: K09.Caller,
  safety: SafetyResult,
  handleId: string | null,
  bookingId: string | null,
): RecordAction {
  return { call: "recordSafetyOutcome", request: { caller, safety, handleId, bookingId, sentByActor: null } };
}

/** A releaseSafetyHold core action. */
function releaseAction(caller: K09.Caller, fields: Omit<ReleaseRequest, "caller">): ReleaseAction {
  return { call: "releaseSafetyHold", request: { caller, ...fields } };
}

const NOTHING_OPEN: OpenHolds = { holds: [], unreadEventIds: [] };

/** The record action a turn carries first. */
function firstRecord(turn: CommitTurnContext): RecordAction {
  const action = turn.request.core[0];
  if (action?.call !== "recordSafetyOutcome") throw new Error("the turn carries no safety record first");
  return action;
}

/** The release action a turn carries. */
function releaseIn(turn: CommitTurnContext): ReleaseAction {
  const action = turn.request.core.find((each): each is ReleaseAction => each.call === "releaseSafetyHold");
  if (action === undefined) throw new Error("the turn carries no release");
  return action;
}

/** The answer of a record's core run, held to K-09 v1's response. */
function responseOf(result: { response: RecordResponse | null; error: unknown }): RecordResponse {
  if (result.response === null) throw new Error(`refused: ${JSON.stringify(result.error)}`);
  expect(validator.check("recordSafetyOutcome", "response", result.response)).toEqual([]);
  return result.response;
}

/** The open holds of a handle in the world, as the commit's openHolds port reads them (K-34 safety_holds, unreleased). */
function openHoldsOf(world: SafetyWorld, handleId: string): SafetyHold[] {
  return world.safety.holds
    .filter((hold) => hold.handleId === handleId && hold.releasedAt === null)
    .map((hold) => ({ holdId: hold.id, releaseRule: hold.releaseRule, blocksBooking: hold.blocksBooking }));
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
  // Nothing the safety calls do writes a log line (K-08 v1: never a person's words, a number or an address).
  expect(warn).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------

describe("safety-outcome-hold.json gives its holds (K-09 v1; K-34 v1)", () => {
  /** Alex's threat to Riley in the turn its text joins, as the fixture states it. */
  function threatTurn(exchange: RecordExchange): CommitTurnContext {
    return turnOf({
      turnId: "turn-alex-threat",
      handleId: "handle-alex",
      eventIds: ["evt-alex-0204"],
      personId: "person-alex",
      now: exchange.given.now,
      core: () => [{ call: "recordSafetyOutcome", request: exchange.request }],
    });
  }

  it("answers the fixture's outcome: a hold never released, the checked line as a safety row, the owner told", async () => {
    const exchange = holdExchange();
    const { deps } = doublesOn(safetyWorldOf());
    const turn = threatTurn(exchange);
    const { run } = await recordSafetyOutcomeCore(firstRecord(turn), turn, NOTHING_OPEN, deps);
    expect(responseOf(run.result)).toEqual(exchange.outcome);
    expect(run.result.error).toBeNull();
  });

  it("writes the outcome row and its hold as K-34's seed-threat-pause holds them, under the turn", async () => {
    const exchange = holdExchange();
    const { deps } = doublesOn(safetyWorldOf());
    const turn = threatTurn(exchange);
    const { run } = await recordSafetyOutcomeCore(firstRecord(turn), turn, NOTHING_OPEN, deps);
    const seed = contractJson(SAFETY_SEEDS.threat) as {
      rows: { table: string; values: Record<string, unknown> }[];
    };
    const seedHold = seed.rows.find((row) => row.table === "safety_holds")?.values ?? {};
    const outcome = run.writes.state.find((write) => write.table === "safety_outcomes");
    const hold = run.writes.state.find((write) => write.table === "safety_holds");
    if (outcome?.op !== "insert" || hold?.op !== "insert") throw new Error("the record inserts both rows");
    expect(outcome.values).toMatchObject({
      id: "safety-outcome-alex-0204",
      event_id: "evt-alex-0204",
      source: "text",
      handle_id: "handle-alex",
      person_id: "person-alex",
      business_id: BARBERSHOP,
      booking_id: "booking-alex-riley-nov14",
      turn_id: "turn-alex-threat",
      timed_out: false,
      labels: ["A threat to staff or others"],
      tenses: ["now"],
      outcomes: ["A threat to staff or others"],
      lifted_to_unsure: false,
    });
    expect(hold.values).toMatchObject({
      id: "hold-alex-0204",
      safety_outcome_id: "safety-outcome-alex-0204",
      handle_id: "handle-alex",
      person_id: "person-alex",
      turn_id: "turn-alex-threat",
      release_rule: seedHold.release_rule,
      blocks_booking: seedHold.blocks_booking,
      held_at: exchange.given.now,
    });
    expect(hold.values).not.toHaveProperty("released_at");
    expect(run.writes.stateEvents.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["safety_outcome.recorded", "safety_hold.set"]),
    );
  });

  it("the hold binds what follows it in the turn: every routine part is held, a protective change is not", async () => {
    const exchange = holdExchange();
    const { deps } = doublesOn(safetyWorldOf());
    const turn = threatTurn(exchange);
    const { run } = await recordSafetyOutcomeCore(firstRecord(turn), turn, NOTHING_OPEN, deps);
    const hold = responseOf(run.result).hold;
    if (hold === null) throw new Error("a threat holds");
    expect(isHeld("routine", [hold])).toBe(true);
    expect(isHeld("safetyFlow", [hold])).toBe(true);
    expect(isHeld("protective", [hold])).toBe(false);
  });

  it("a repeat of the same text (the batch turn after it) writes nothing and answers the first record", async () => {
    const exchange = holdExchange();
    const doubles = doublesOn(safetyWorldOf());
    const turn = threatTurn(exchange);
    const first = await recordSafetyOutcomeCore(firstRecord(turn), turn, NOTHING_OPEN, doubles.deps);
    applySafetyWrites(doubles.world, first.run.writes.state, first.run.writes.messages);
    const again = await recordSafetyOutcomeCore(firstRecord(turn), turn, NOTHING_OPEN, doubles.deps);
    expect(responseOf(again.run.result)).toEqual({ ...exchange.outcome, repeated: true });
    expect(again.run.writes.state).toEqual([]);
    expect(again.run.writes.stateEvents).toEqual([]);
    expect(again.run.writes.messages).toEqual([]);
    expect(again.clocks).toEqual([]);
  });

  it("the actor's stricter hold of the same id binds a repeat (STATE note 21)", async () => {
    const world = safetyWorldOf([SAFETY_SEEDS.crisis]);
    const { deps } = doublesOn(world);
    const turn = turnOf({
      turnId: "turn-alex-0203",
      handleId: "handle-alex",
      eventIds: ["evt-alex-0203"],
      personId: "person-alex",
      now: "2026-10-25T23:20:00Z",
      core: (caller) => [
        recordAction(caller, safetyRead("safety-crisis-words.json"), "handle-alex", "booking-alex-haircut"),
      ],
    });
    const actors: OpenHolds = {
      holds: [{ holdId: "hold-alex-0203", releaseRule: "never", blocksBooking: false }],
      unreadEventIds: [],
    };
    const { run } = await recordSafetyOutcomeCore(firstRecord(turn), turn, actors, deps);
    expect(responseOf(run.result)).toMatchObject({
      outcomeId: "safety-alex-0203",
      hold: { holdId: "hold-alex-0203", releaseRule: "never" },
      repeated: true,
    });
    expect(run.writes.state).toEqual([]);
  });

  it("a No (commit-s1-02.json's core action) writes its outcome row and holds nothing", async () => {
    const exchange = gateExchange("commit-s1-02.json");
    if (!("result" in exchange.outcome) || exchange.outcome.result !== "committed")
      throw new Error("it commits");
    const expected = exchange.outcome.core[0];
    const { deps, sealer } = doublesOn(safetyWorldOf());
    const request = exchange.request;
    if (request.turn === null) throw new Error("the fixture carries its turn");
    const turn: CommitTurnContext = { request, turn: request.turn, repo: {}, businessId: BARBERSHOP };
    const action = request.core[0];
    if (action?.call !== "recordSafetyOutcome") throw new Error("its core action is the safety record");
    const { run, clocks } = await recordSafetyOutcomeCore(action, turn, NOTHING_OPEN, deps);
    expect(run.result).toEqual(expected);
    expect(run.writes.state.map((write) => write.table)).toEqual(["safety_outcomes"]);
    expect(run.writes.messages).toEqual([]);
    expect(clocks).toEqual([]);
    expect(sealer.calls.map((call) => call.forPersonId)).toEqual(["person-sam"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("a crisis outcome holds routine work until a 'we're safe' with a fresh read-back (A3-24, A3-25)", () => {
  /** commit-s1-02.json's turn, with Sam's text read as crisis words (K-02 safety-crisis-words.json's read). */
  function crisisS1_02(): GateAndCommitRequest {
    const request = gateExchange("commit-s1-02.json").request;
    const action = request.core[0];
    if (action?.call !== "recordSafetyOutcome") throw new Error("its core action is the safety record");
    action.request.safety = readOf("safety-crisis-words.json", "evt-sam-0001");
    return request;
  }

  /** The commit's ports with runCore dispatching to the safety service, every other port a double. */
  function commitPorts(deps: SafetyDeps<unknown>, holds: SafetyHold[] = []) {
    const doubles = doublePorts({ holds });
    const ports: CommitPorts = {
      ...doubles.ports,
      async runCore(action, turn, open) {
        if (action.call === "recordSafetyOutcome") {
          return (await recordSafetyOutcomeCore(action, turn, open, deps)).run;
        }
        if (action.call === "releaseSafetyHold") {
          return (await releaseSafetyHoldCore(action, turn, open, deps)).run;
        }
        throw new Error("only the safety calls here");
      },
    };
    return { ports, calls: doubles.calls, k05: doubles.k05 };
  }

  /**
   * When the actor took Sam's texts (K-06 receivedAt): the crisis text a second after he sent it (commit-s1-02.json's
   * sentAt 14:05:00), and a later "we're safe, it's handled" just before its turn.
   */
  const CRISIS_ARRIVED = "2026-10-19T14:05:01Z";
  const SAFE_ARRIVED = "2026-10-19T14:19:58Z";

  /** A turn of core actions committed through gateAndCommit with the handle's open holds; its writes applied to the world. */
  async function committedTurn(world: SafetyWorld, deps: SafetyDeps<unknown>, turn: CommitTurnContext) {
    const { ports, k05 } = commitPorts(deps, openHoldsOf(world, turn.turn.handleId));
    const answer = await gateAndCommit(turn.request, callContext(BARBERSHOP), {
      limits: scriptedLimits(),
      ports,
    });
    if ("error" in answer || answer.result !== "committed") throw new Error("the turn commits");
    const sent = k05.requests[0];
    if (sent === undefined) throw new Error("one commit was sent");
    applySafetyWrites(world, sent.writes.state, sent.writes.outboxRows);
    return { answer, sent };
  }

  /** Sam's crisis turn, committed through gateAndCommit; its writes applied to the world. */
  async function committedCrisis(doubles: Doubles) {
    doubles.world.arrivals = { ...doubles.world.arrivals, "evt-sam-0001": CRISIS_ARRIVED };
    const request = crisisS1_02();
    const { ports, calls, k05 } = commitPorts(doubles.deps);
    const limitCalls: LimitCall[] = [];
    const answer = await gateAndCommit(request, callContext(BARBERSHOP), {
      limits: scriptedLimits({}, limitCalls),
      ports,
    });
    if ("error" in answer || answer.result !== "committed") throw new Error("the crisis turn commits");
    const sent = k05.requests[0];
    if (sent === undefined) throw new Error("one commit was sent");
    applySafetyWrites(doubles.world, sent.writes.state, sent.writes.outboxRows);
    return { request, answer, calls, limitCalls, sent };
  }

  it("the crisis turn commits its outcome, its after-safe hold and the 988 line, and holds Sam's routine part", async () => {
    const doubles = doublesOn(safetyWorldOf());
    const { answer, calls, limitCalls, sent } = await committedCrisis(doubles);
    const core = answer.core[0];
    if (core?.call !== "recordSafetyOutcome" || core.response === null) throw new Error("recorded");
    expect(core.response).toMatchObject({
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
    // Routine work waits: S1-02's part is held, no limit ran for it and nothing of it was written.
    expect(answer.parts.map((part) => part.result)).toEqual(["held"]);
    expect(limitCalls).toEqual([]);
    expect(calls.writesOf).toEqual([]);
    expect(sent.writes.state.map((write) => write.table)).toEqual([
      "safety_outcomes",
      "safety_holds",
      "hand_offs",
      "team_pages",
    ]);
    expect(sent.writes.outboxRows).toEqual([
      expect.objectContaining({ recipientHandleId: "handle-sam", sendClass: "safety", bookingId: null }),
    ]);
  });

  it("no other reason releases it: not the message, not a private booking, not an unclear or another chat's read", async () => {
    const doubles = doublesOn(safetyWorldOf());
    const { request } = await committedCrisis(doubles);
    const [hold] = doubles.world.safety.holds;
    if (hold === undefined) throw new Error("the crisis holds");
    const release = (
      fields: Omit<ReleaseRequest, "caller">,
      safety: SafetyResult | null,
      handleId = "handle-sam",
    ) => {
      const turn = turnOf({
        turnId: "turn-sam-later",
        handleId,
        eventIds: ["evt-sam-0002"],
        personId: "person-sam",
        now: "2026-10-19T14:20:00Z",
        core: (caller) => [
          ...(safety === null ? [] : [recordAction(caller, safety, handleId, null)]),
          releaseAction(caller, fields),
        ],
      });
      return releaseSafetyHoldCore(releaseIn(turn), turn, NOTHING_OPEN, doubles.deps);
    };
    const fields = { holdId: hold.id, expectVersion: 1, releasedByOutcomeId: null };
    const errorOf = async (pending: ReturnType<typeof release>) => (await pending).run.result.error;
    expect(await errorOf(release({ ...fields, why: "outcome_message_sent" }, null))).toEqual({
      error: "wrongRule",
      releaseRule: "after_safe",
    });
    expect(await errorOf(release({ ...fields, why: "booking_private" }, null))).toEqual({
      error: "wrongRule",
      releaseRule: "after_safe",
    });
    // A read that may still be danger (K-02 safety-unknown-tense.json: unknown reads as danger).
    const unsure = readOf("safety-unknown-tense.json", "evt-sam-0002");
    const unsureId = await KEYED_SAFETY_IDS.rowId("outcome", "evt-sam-0002");
    expect(
      await errorOf(release({ ...fields, why: "safe_readback", releasedByOutcomeId: unsureId }, unsure)),
    ).toEqual({ error: "stillDanger", outcomeId: unsureId });
    // A "we're safe" from another handle's chat (K-09 default 31).
    expect(
      await errorOf(
        release(
          { ...fields, why: "safe_readback", releasedByOutcomeId: unsureId },
          weAreSafe("evt-sam-0002"),
          "handle-riley",
        ),
      ),
    ).toEqual({ error: "notAllowed", why: "notDecider" });
    // A stale read of the hold (limit 4).
    const safeId = await KEYED_SAFETY_IDS.rowId("outcome", "evt-sam-0002");
    expect(
      await errorOf(
        release(
          { ...fields, expectVersion: 2, why: "safe_readback", releasedByOutcomeId: safeId },
          weAreSafe("evt-sam-0002"),
        ),
      ),
    ).toEqual({
      error: "versionChanged",
      changed: [{ table: "safety_holds", rowId: hold.id, readVersion: 2, currentVersion: 1 }],
    });
    // Still held after every refusal: Sam's routine part is held as before.
    expect(
      heldParts(request, { holds: openHoldsOf(doubles.world, "handle-sam"), unreadEventIds: [] }),
    ).toEqual(new Set([0]));
  });

  it("a clear 'we're safe' later in the held chat releases it; the held turn is decided again with a fresh read-back", async () => {
    const doubles = doublesOn(safetyWorldOf());
    const { request, answer } = await committedCrisis(doubles);
    // The "we're safe" text came a quarter hour after the crisis text.
    doubles.world.arrivals = { ...doubles.world.arrivals, "evt-sam-0002": SAFE_ARRIVED };
    const core = answer.core[0];
    const crisisHold = core?.call === "recordSafetyOutcome" ? (core.response?.hold ?? null) : null;
    if (crisisHold === null) throw new Error("the crisis holds");
    const holdId = crisisHold.holdId;
    const safeId = await KEYED_SAFETY_IDS.rowId("outcome", "evt-sam-0002");
    const later = turnOf({
      turnId: "turn-sam-safe",
      handleId: "handle-sam",
      eventIds: ["evt-sam-0002"],
      personId: "person-sam",
      now: "2026-10-19T14:20:00Z",
      core: (caller) => [
        recordAction(caller, weAreSafe("evt-sam-0002"), "handle-sam", null),
        releaseAction(caller, {
          holdId,
          expectVersion: 1,
          why: "safe_readback",
          releasedByOutcomeId: safeId,
        }),
      ],
    });
    const { ports, k05 } = commitPorts(doubles.deps, openHoldsOf(doubles.world, "handle-sam"));
    const released = await gateAndCommit(later.request, callContext(BARBERSHOP), {
      limits: scriptedLimits(),
      ports,
    });
    if ("error" in released || released.result !== "committed") throw new Error("the release commits");
    const releaseResult = released.core[1];
    expect(releaseResult).toEqual({
      call: "releaseSafetyHold",
      response: {
        holdId,
        releasedAt: "2026-10-19T14:20:00Z",
        redecideTurnId: "turn-s1-02-sam-kinds",
        repeated: false,
      },
      error: null,
    });
    expect(validator.check("releaseSafetyHold", "response", releaseResult?.response)).toEqual([]);
    // The release writes only the hold's release; nothing it held is committed by it (no booking, no message).
    const sent = k05.requests[0];
    if (sent === undefined) throw new Error("one commit was sent");
    const holdWrites = sent.writes.state.filter((write) => write.table === "safety_holds");
    expect(holdWrites).toEqual([
      {
        op: "update",
        table: "safety_holds",
        key: { id: holdId },
        expectVersion: 1,
        set: {
          released_at: "2026-10-19T14:20:00Z",
          released_why: "safe_readback",
          released_by_turn_id: "turn-sam-safe",
          released_by_outcome_id: safeId,
        },
      },
    ]);
    expect(sent.writes.outboxRows).toEqual([]);
    expect(sent.writes.state.map((write) => write.table)).toEqual(["safety_outcomes", "safety_holds"]);
    applySafetyWrites(doubles.world, sent.writes.state, sent.writes.outboxRows);
    // Nothing open any more: the held turn's routine part is decided again, gated afresh (limit 3's read-back).
    expect(openHoldsOf(doubles.world, "handle-sam")).toEqual([]);
    expect(heldParts(request, { holds: [], unreadEventIds: [] })).toEqual(new Set());
    // Released once: a repeat answers the first release and writes nothing.
    const again = await releaseSafetyHoldCore(releaseIn(later), later, NOTHING_OPEN, doubles.deps);
    expect(again.run.result.response).toEqual({
      holdId,
      releasedAt: "2026-10-19T14:20:00Z",
      redecideTurnId: "turn-s1-02-sam-kinds",
      repeated: true,
    });
    expect(again.run.writes.state).toEqual([]);
  });

  it("K-34's seeds: Alex's open crisis hold releases only on a later clear read, as seed-hold-released.json records one", async () => {
    const world = safetyWorldOf([SAFETY_SEEDS.crisis, SAFETY_SEEDS.released]);
    const { deps } = doublesOn(world);
    const seedReleased = world.safety.holds.find((hold) => hold.id === "hold-alex-0202");
    expect(seedReleased).toMatchObject({
      releasedWhy: "safe_readback",
      releasedByOutcomeId: "safety-alex-0220",
    });
    const safeOutcome = world.safety.outcomes.find((outcome) => outcome.id === "safety-alex-0220");
    if (safeOutcome === undefined) throw new Error("the seed's we're-safe read");
    expect(isClearSafe(safeOutcome)).toBe(true);

    const releaseBy = (outcomeId: string, now: string) =>
      releaseSafetyHoldAlone(
        {
          caller: {
            kind: "page",
            turnId: null,
            requestId: `req-${outcomeId}`,
            businessId: BARBERSHOP,
            personId: "person-alex",
            traceId: "trace-alex-release",
          },
          holdId: "hold-alex-0203",
          expectVersion: 1,
          why: "safe_readback",
          releasedByOutcomeId: outcomeId,
        },
        {},
        BARBERSHOP,
        { ...deps, now: () => now },
      );
    // seed-hold-released's "we're safe" came on Oct 24, before the crisis text of Oct 25: not a release of it.
    expect(await releaseBy("safety-alex-0220", "2026-10-26T10:00:00Z")).toEqual({
      error: "stillDanger",
      outcomeId: "safety-alex-0220",
    });
    // The hold's own crisis read never releases it.
    expect(await releaseBy("safety-alex-0203", "2026-10-26T10:00:00Z")).toEqual({
      error: "stillDanger",
      outcomeId: "safety-alex-0203",
    });
    // A released hold answers its first release (seed-hold-released.json), written once and never un-released.
    expect(
      await releaseSafetyHoldAlone(
        {
          caller: {
            kind: "page",
            turnId: null,
            requestId: "req-again",
            businessId: BARBERSHOP,
            personId: "person-alex",
            traceId: "trace-alex-again",
          },
          holdId: "hold-alex-0202",
          expectVersion: 2,
          why: "safe_readback",
          releasedByOutcomeId: "safety-alex-0220",
        },
        {},
        BARBERSHOP,
        deps,
      ),
    ).toEqual({
      holdId: "hold-alex-0202",
      releasedAt: "2026-10-24T16:30:03Z",
      redecideTurnId: "turn-alex-0202",
      repeated: true,
    });
  });

  it("'all good, we're safe' sent just before crisis words, in the same batch, never releases the crisis hold", async () => {
    const world = safetyWorldOf();
    const doubles = doublesOn(world);
    // Decided by the batch alone: the texts' arrival is never read for it.
    const batchOnly: SafetyDeps<unknown> = { ...doubles.deps, reader: () => arrivalUnread(world) };
    // Sam's batch: "all good, we're safe", then crisis words, where the actor closed it (K-09 README default 5).
    const batch = turnOf({
      turnId: "turn-sam-batch",
      handleId: "handle-sam",
      eventIds: ["evt-sam-0003", "evt-sam-0004"],
      personId: "person-sam",
      now: "2026-10-20T09:00:06Z",
      core: (caller) => [
        recordAction(caller, weAreSafe("evt-sam-0003"), "handle-sam", null),
        recordAction(caller, readOf("safety-crisis-words.json", "evt-sam-0004"), "handle-sam", null),
      ],
    });
    await committedTurn(world, batchOnly, batch);
    const [hold] = world.safety.holds;
    if (hold === undefined) throw new Error("the crisis holds");
    const safeId = await KEYED_SAFETY_IDS.rowId("outcome", "evt-sam-0003");
    const safe = world.safety.outcomes.find((outcome) => outcome.id === safeId);
    if (safe === undefined) throw new Error("the batch records its 'we're safe'");
    // A clear "we're safe", stored with the hold's own time: read_at and held_at cannot say which text came first.
    expect(isClearSafe(safe)).toBe(true);
    expect([safe.turnId, safe.readAt]).toEqual([hold.turnId, hold.heldAt]);

    const fields = {
      holdId: hold.id,
      expectVersion: 1,
      why: "safe_readback" as const,
      releasedByOutcomeId: safeId,
    };
    const stillDanger = { error: "stillDanger", outcomeId: safeId };
    // Named by a later turn's release ...
    const later = turnOf({
      turnId: "turn-sam-later",
      handleId: "handle-sam",
      eventIds: ["evt-sam-0005"],
      personId: "person-sam",
      now: "2026-10-20T09:30:00Z",
      core: (caller) => [releaseAction(caller, fields)],
    });
    const inTurn = await releaseSafetyHoldCore(releaseIn(later), later, NOTHING_OPEN, batchOnly);
    expect(inTurn.run.result).toEqual({ call: "releaseSafetyHold", response: null, error: stillDanger });
    expect(inTurn.run.writes.state).toEqual([]);
    // ... or by a page, made alone: the same.
    expect(
      await releaseSafetyHoldAlone(
        { caller: samsPage("req-sam-batch"), ...fields },
        {},
        BARBERSHOP,
        batchOnly,
      ),
    ).toEqual(stillDanger);
    // Still held: routine work waits.
    expect(openHoldsOf(world, "handle-sam")).toEqual([
      { holdId: hold.id, releaseRule: "after_safe", blocksBooking: false },
    ]);
  });

  it("a hold written on arrival: its batch's own earlier 'we're safe' never releases it, a later text's does", async () => {
    const world = safetyWorldOf();
    const doubles = doublesOn(world);
    const batchOnly: SafetyDeps<unknown> = { ...doubles.deps, reader: () => arrivalUnread(world) };
    const crisis = readOf("safety-crisis-words.json", "evt-sam-0004");
    // The crisis text's arrival record: a turn of its one text, where its hold is written (K-09 v1.1 default 36).
    const arrival = turnOf({
      turnId: "turn-arrival-sam-0004",
      handleId: "handle-sam",
      eventIds: ["evt-sam-0004"],
      personId: "person-sam",
      now: "2026-10-20T09:00:03Z",
      core: (caller) => [recordAction(caller, crisis, "handle-sam", null)],
    });
    await committedTurn(world, batchOnly, arrival);
    const [hold] = world.safety.holds;
    if (hold?.turnId !== "turn-arrival-sam-0004") throw new Error("held on arrival");

    // The batch turn after it: "all good, we're safe" first, then the crisis text, where the batch closed. Its own "we're
    // safe", recorded there and named by the id its record writes, is no release.
    const safeId = await KEYED_SAFETY_IDS.rowId("outcome", "evt-sam-0003");
    const fields = {
      holdId: hold.id,
      expectVersion: 1,
      why: "safe_readback" as const,
      releasedByOutcomeId: safeId,
    };
    const batch = turnOf({
      turnId: "turn-sam-batch",
      handleId: "handle-sam",
      eventIds: ["evt-sam-0003", "evt-sam-0004"],
      personId: "person-sam",
      now: "2026-10-20T09:00:08Z",
      core: (caller) => [
        recordAction(caller, weAreSafe("evt-sam-0003"), "handle-sam", null),
        recordAction(caller, crisis, "handle-sam", null),
        releaseAction(caller, fields),
      ],
    });
    const inBatch = await committedTurn(world, batchOnly, batch);
    expect(inBatch.answer.core[2]).toEqual({
      call: "releaseSafetyHold",
      response: null,
      error: { error: "stillDanger", outcomeId: safeId },
    });
    expect(inBatch.sent.writes.state.map((write) => write.table)).toEqual(["safety_outcomes"]);
    expect(openHoldsOf(world, "handle-sam").map((open) => open.holdId)).toEqual([hold.id]);

    // A clear "we're safe, it's handled" that came after the crisis text, in a later turn, releases it.
    world.arrivals = {
      "evt-sam-0003": "2026-10-20T08:59:58Z",
      "evt-sam-0004": "2026-10-20T09:00:01Z",
      "evt-sam-0006": "2026-10-20T09:40:00Z",
    };
    const laterId = await KEYED_SAFETY_IDS.rowId("outcome", "evt-sam-0006");
    const later = turnOf({
      turnId: "turn-sam-safe-later",
      handleId: "handle-sam",
      eventIds: ["evt-sam-0006"],
      personId: "person-sam",
      now: "2026-10-20T09:40:02Z",
      core: (caller) => [
        recordAction(caller, weAreSafe("evt-sam-0006"), "handle-sam", null),
        releaseAction(caller, { ...fields, releasedByOutcomeId: laterId }),
      ],
    });
    const released = await committedTurn(world, doubles.deps, later);
    expect(released.answer.core[1]).toMatchObject({
      call: "releaseSafetyHold",
      response: { holdId: hold.id, releasedAt: "2026-10-20T09:40:02Z", repeated: false },
      error: null,
    });
    expect(released.sent.writes.state).toContainEqual({
      op: "update",
      table: "safety_holds",
      key: { id: hold.id },
      expectVersion: 1,
      set: {
        released_at: "2026-10-20T09:40:02Z",
        released_why: "safe_readback",
        released_by_turn_id: "turn-sam-safe-later",
        released_by_outcome_id: laterId,
      },
    });
    expect(openHoldsOf(world, "handle-sam")).toEqual([]);
  });

  it("a later turn's clear 'we're safe' releases only once its text is known to have come after the danger text", async () => {
    const doubles = doublesOn(safetyWorldOf());
    await committedCrisis(doubles);
    const [hold] = doubles.world.safety.holds;
    if (hold === undefined) throw new Error("the crisis holds");
    const safeId = await KEYED_SAFETY_IDS.rowId("outcome", "evt-sam-0002");
    const later = turnOf({
      turnId: "turn-sam-safe",
      handleId: "handle-sam",
      eventIds: ["evt-sam-0002"],
      personId: "person-sam",
      now: "2026-10-19T14:20:00Z",
      core: (caller) => [
        recordAction(caller, weAreSafe("evt-sam-0002"), "handle-sam", null),
        releaseAction(caller, {
          holdId: hold.id,
          expectVersion: 1,
          why: "safe_readback",
          releasedByOutcomeId: safeId,
        }),
      ],
    });
    const released = async (arrivals: Record<string, string>) => {
      doubles.world.arrivals = arrivals;
      return (await releaseSafetyHoldCore(releaseIn(later), later, NOTHING_OPEN, doubles.deps)).run.result;
    };
    const stillDanger = {
      call: "releaseSafetyHold",
      response: null,
      error: { error: "stillDanger", outcomeId: safeId },
    };
    // Its arrival unknown, or the crisis text's: not known to be later, so the hold stays (fail closed).
    expect(await released({ "evt-sam-0001": CRISIS_ARRIVED })).toEqual(stillDanger);
    expect(await released({ "evt-sam-0002": SAFE_ARRIVED })).toEqual(stillDanger);
    // The same moment as the crisis text, or before it (a text the actor took first): not later.
    expect(await released({ "evt-sam-0001": CRISIS_ARRIVED, "evt-sam-0002": CRISIS_ARRIVED })).toEqual(
      stillDanger,
    );
    expect(
      await released({ "evt-sam-0001": CRISIS_ARRIVED, "evt-sam-0002": "2026-10-19T14:04:59Z" }),
    ).toEqual(stillDanger);
    // Both known, and the "we're safe" later: released.
    expect(await released({ "evt-sam-0001": CRISIS_ARRIVED, "evt-sam-0002": SAFE_ARRIVED })).toEqual({
      call: "releaseSafetyHold",
      response: {
        holdId: hold.id,
        releasedAt: "2026-10-19T14:20:00Z",
        redecideTurnId: "turn-s1-02-sam-kinds",
        repeated: false,
      },
      error: null,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("a threat pauses later visits and nothing books (A3-48)", () => {
  function alexThreat(now = "2026-10-26T21:40:02Z"): CommitTurnContext {
    return turnOf({
      turnId: "turn-alex-threat",
      handleId: "handle-alex",
      eventIds: ["evt-alex-0204"],
      personId: "person-alex",
      now,
      core: (caller) => [
        recordAction(caller, safetyRead("safety-threat.json"), "handle-alex", "booking-alex-riley-nov14"),
      ],
    });
  }

  it("pauses Alex and his phone at the barbershop, as K-34's seed-threat-pause.json holds them", async () => {
    const doubles = doublesOn(safetyWorldOf());
    const turn = alexThreat();
    const { run } = await recordSafetyOutcomeCore(firstRecord(turn), turn, NOTHING_OPEN, doubles.deps);
    const seed = contractJson(SAFETY_SEEDS.threat) as {
      rows: { table: string; values: Record<string, unknown> }[];
    };
    const seedPauses = seed.rows.filter((row) => row.table === "pauses").map((row) => row.values);
    const pauses = run.writes.state.filter((write) => write.table === "pauses");
    // The seed's two pauses, set by this turn at its now (each a new row: its version takes K-04's default 1).
    const expected = seedPauses.map((values) => ({
      op: "insert",
      table: "pauses",
      values: {
        ...Object.fromEntries(Object.entries(values).filter(([column]) => column !== "version")),
        set_by_turn_id: "turn-alex-threat",
        set_at: "2026-10-26T21:40:02Z",
      },
    }));
    expect(pauses).toEqual(expected);
    applySafetyWrites(doubles.world, run.writes.state, run.writes.messages);
    const reader = flagsReaderOn(doubles.world.flags, BARBERSHOP);
    expect((await reader.openPausesOfPerson("person-alex")).map((pause) => pause.id)).toEqual([
      "pause-alex-threat-person",
    ]);
    expect((await reader.openPausesOfPhone("+15555550101")).map((pause) => pause.id)).toEqual([
      "pause-alex-threat-phone",
    ]);
  });

  it("each pause arms the call-off clock of Alex's later visit: 7pm the day before, unless the owner decides (S11-62)", async () => {
    const doubles = doublesOn(safetyWorldOf());
    const turn = alexThreat();
    const { clocks } = await recordSafetyOutcomeCore(firstRecord(turn), turn, NOTHING_OPEN, doubles.deps);
    expect(clocks.length).toBe(2);
    for (const clock of clocks) {
      expect(clock).toMatchObject({
        kind: "step",
        bookingId: "booking-alex-riley-nov14",
        fires: { step: "S11-62", branch: "callOff", no_fee: true },
        due: { dueAt: "2026-11-14T00:00:00Z", dueZone: "America/New_York" },
      });
    }
  });

  it("nothing books: the never hold keeps every routine part back, no reason releases it, and the answer says so", async () => {
    const doubles = doublesOn(safetyWorldOf());
    const turn = alexThreat();
    const { run } = await recordSafetyOutcomeCore(firstRecord(turn), turn, NOTHING_OPEN, doubles.deps);
    const answer = responseOf(run.result);
    expect(answer.nothingBooks).toBe(true);
    expect(answer.hold).toMatchObject({ releaseRule: "never" });
    // No booking row is written by the record: the outcome, its hold, the protective pauses and the owner's hand-off.
    expect(run.writes.state.map((write) => write.table)).toEqual([
      "safety_outcomes",
      "safety_holds",
      "pauses",
      "pauses",
      "hand_offs",
    ]);
    applySafetyWrites(doubles.world, run.writes.state, run.writes.messages);
    const open = openHoldsOf(doubles.world, "handle-alex");
    expect(isHeld("routine", open)).toBe(true);
    for (const why of ["outcome_message_sent", "booking_private", "safe_readback"] as const) {
      const released = await releaseSafetyHoldAlone(
        {
          caller: {
            kind: "console",
            turnId: null,
            requestId: `req-${why}`,
            businessId: BARBERSHOP,
            personId: "person-sam",
            traceId: "trace-console",
          },
          holdId: answer.hold?.holdId ?? "",
          expectVersion: 1,
          why,
          releasedByOutcomeId: null,
        },
        {},
        BARBERSHOP,
        doubles.deps,
      );
      expect(released).toEqual({ error: "neverReleased", holdId: answer.hold?.holdId });
    }
    // K-34's own seed of the threat: the same answer for its never hold.
    const seeded = doublesOn(safetyWorldOf([SAFETY_SEEDS.threat]));
    expect(
      await releaseSafetyHoldAlone(
        {
          caller: {
            kind: "console",
            turnId: null,
            requestId: "req-seed",
            businessId: BARBERSHOP,
            personId: "person-sam",
            traceId: "trace-console",
          },
          holdId: "hold-alex-0204",
          expectVersion: 1,
          why: "safe_readback",
          releasedByOutcomeId: "safety-alex-0204",
        },
        {},
        BARBERSHOP,
        seeded.deps,
      ),
    ).toEqual({ error: "neverReleased", holdId: "hold-alex-0204" });
  });

  it("a protective pause the turn already carries is left to it: one turn never writes it twice", async () => {
    const doubles = doublesOn(safetyWorldOf());
    const turn = turnOf({
      turnId: "turn-alex-threat",
      handleId: "handle-alex",
      eventIds: ["evt-alex-0204"],
      personId: "person-alex",
      now: "2026-10-26T21:40:02Z",
      core: (caller) => [
        recordAction(caller, safetyRead("safety-threat.json"), "handle-alex", null),
        {
          call: "setRecordFlag",
          request: {
            caller,
            flag: "paused",
            action: "set",
            target: { personId: "person-alex" },
            expectVersion: null,
          },
        },
      ],
    });
    const { run } = await recordSafetyOutcomeCore(firstRecord(turn), turn, NOTHING_OPEN, doubles.deps);
    const targets = run.writes.state
      .filter((write) => write.table === "pauses")
      .map((write) => (write.op === "insert" ? write.values.target : null));
    expect(targets).toEqual(["phone"]);
  });

  it("a pause T-317 refuses shows in the outcome: the record answers it and writes nothing, never a threat without it", async () => {
    const doubles = doublesOn(safetyWorldOf());
    const turn = alexThreat();
    const reader = flagsReaderOn(doubles.world.flags, BARBERSHOP);
    const recordWith = (flagsReader: FlagsReader) =>
      recordSafetyOutcomeCore(firstRecord(turn), turn, NOTHING_OPEN, {
        ...doubles.deps,
        flagsReader: () => flagsReader,
      });
    // No phone row behind Alex's handle: T-317 refuses the phone's pause, named by the handle's id, never the number.
    const noPhone = await recordWith({ ...reader, phone: () => Promise.resolve(null) });
    expect(noPhone.run.result).toEqual({
      call: "recordSafetyOutcome",
      response: null,
      error: { error: "notFound", table: "phones", rowId: "handle-alex" },
    });
    expect(validator.check("recordSafetyOutcome", "errors", noPhone.run.result.error)).toEqual([]);
    // Nothing is written for it: no outcome row, no hold, no pause, no line, no call-off clock.
    expect(noPhone.run.writes.state).toEqual([]);
    expect(noPhone.run.writes.stateEvents).toEqual([]);
    expect(noPhone.run.writes.messages).toEqual([]);
    expect(noPhone.clocks).toEqual([]);
    // No such person: the person's pause is refused the same way, by the person's id.
    const noPerson = await recordWith({ ...reader, personExists: () => Promise.resolve(false) });
    expect(noPerson.run.result.error).toEqual({ error: "notFound", table: "persons", rowId: "person-alex" });
    expect(noPerson.run.writes.state).toEqual([]);
    // No such handle: no phone can be paused, and that is refused too, never passed over.
    const noHandle = await recordWith({ ...reader, handle: () => Promise.resolve(null) });
    expect(noHandle.run.result.error).toEqual({ error: "notFound", table: "handles", rowId: "handle-alex" });
    expect(noHandle.run.writes.state).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("unsafe at home makes the booking private (A3-50)", () => {
  function unsafeAtHome(bookingId: string | null): CommitTurnContext {
    return turnOf({
      turnId: "turn-alex-0206",
      handleId: "handle-alex",
      eventIds: ["evt-alex-0206"],
      personId: "person-alex",
      now: "2026-10-27T18:00:02Z",
      core: (caller) => [
        recordAction(caller, safetyRead("safety-unsafe-at-home.json"), "handle-alex", bookingId),
      ],
    });
  }

  it("the booking becomes private on their word, and its hold is released once it is, in the same commit", async () => {
    const doubles = doublesOn(safetyWorldOf());
    const before = await flagsReaderOn(doubles.world.flags, BARBERSHOP).bookingHead("booking-alex-haircut");
    expect(before?.private).toBe(false);
    const turn = unsafeAtHome("booking-alex-haircut");
    const { run } = await recordSafetyOutcomeCore(firstRecord(turn), turn, NOTHING_OPEN, doubles.deps);
    const answer = responseOf(run.result);
    expect(answer).toMatchObject({
      outcomes: ["Unsafe at home"],
      hold: { releaseRule: "when_private", blocksBooking: false },
      safetyLine: { fixedLineId: "safetyUnsafeAtHomeLine" },
      told: [],
      repeated: false,
    });
    expect(run.writes.state).toContainEqual({
      op: "update",
      table: "bookings",
      key: { id: "booking-alex-haircut" },
      expectVersion: before?.version,
      set: { private: true },
    });
    const hold = run.writes.state.find((write) => write.table === "safety_holds");
    expect(hold?.op === "insert" ? hold.values : null).toMatchObject({
      release_rule: "when_private",
      booking_id: "booking-alex-haircut",
      released_at: "2026-10-27T18:00:02Z",
      released_why: "booking_private",
      released_by_turn_id: "turn-alex-0206",
      released_by_outcome_id: null,
    });
    applySafetyWrites(doubles.world, run.writes.state, run.writes.messages);
    const after = await flagsReaderOn(doubles.world.flags, BARBERSHOP).bookingHead("booking-alex-haircut");
    expect(after?.private).toBe(true);
    expect(openHoldsOf(doubles.world, "handle-alex")).toEqual([]);
  });

  it("a when-private hold is released only once its booking is private (booking_private)", async () => {
    const world = safetyWorldOf();
    const doubles = doublesOn(world);
    const turn = unsafeAtHome("booking-alex-haircut");
    // The booking's private flag set elsewhere is refused here, so its hold stays held (T-317 answers notFound).
    const held = await recordSafetyOutcomeCore(firstRecord(turn), turn, NOTHING_OPEN, {
      ...doubles.deps,
      flagsReader: () => ({
        ...flagsReaderOn(world.flags, BARBERSHOP),
        bookingHead: () => Promise.resolve(null),
      }),
    });
    applySafetyWrites(world, held.run.writes.state, held.run.writes.messages);
    const [hold] = openHoldsOf(world, "handle-alex");
    if (hold === undefined) throw new Error("held until private");
    const release = () =>
      releaseSafetyHoldAlone(
        {
          caller: {
            kind: "page",
            turnId: null,
            requestId: "req-private",
            businessId: BARBERSHOP,
            personId: "person-alex",
            traceId: "trace-alex-page",
          },
          holdId: hold.holdId,
          expectVersion: 1,
          why: "booking_private",
          releasedByOutcomeId: null,
        },
        {},
        BARBERSHOP,
        {
          ...doubles.deps,
          commitAlone: { commit: () => Promise.resolve({ committed: true, repeated: false }) },
        },
      );
    await expect(release()).rejects.toThrow(new SafetyRefusedError("bookingNotPrivate", [hold.holdId]));
    world.flags.record = {
      ...world.flags.record,
      bookings: world.flags.record.bookings.map((head) =>
        head.id === "booking-alex-haircut" ? { ...head, private: true, version: head.version + 1 } : head,
      ),
    };
    expect(await release()).toMatchObject({
      holdId: hold.holdId,
      redecideTurnId: "turn-alex-0206",
      repeated: false,
    });
  });

  it("with no booking yet nothing is made private, and the hold waits after_safe, the next stricter rule", async () => {
    const doubles = doublesOn(safetyWorldOf());
    const turn = unsafeAtHome(null);
    const { run } = await recordSafetyOutcomeCore(firstRecord(turn), turn, NOTHING_OPEN, doubles.deps);
    expect(responseOf(run.result).hold).toMatchObject({ releaseRule: "after_safe" });
    expect(run.writes.state.map((write) => write.table)).toEqual(["safety_outcomes", "safety_holds"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("outcome fields that name people are written sealed (the fake repo asserts the sealed column is used)", () => {
  it("the threat's evidence, who is at risk and who wrote it go only into sealed_words, under Alex's key", async () => {
    const exchange = holdExchange();
    const doubles = doublesOn(safetyWorldOf());
    const turn = turnOf({
      turnId: "turn-alex-threat",
      handleId: "handle-alex",
      eventIds: ["evt-alex-0204"],
      personId: "person-alex",
      now: exchange.given.now,
      core: () => [{ call: "recordSafetyOutcome", request: exchange.request }],
    });
    const { run } = await recordSafetyOutcomeCore(firstRecord(turn), turn, NOTHING_OPEN, doubles.deps);
    // The sealer was given the read's words, for the person at the handle, once.
    const [sealed, ...more] = doubles.sealer.calls;
    expect(more).toEqual([]);
    expect(sealed?.forPersonId).toBe("person-alex");
    expect(sealed?.plaintext).toBe(wordsOf(exchange.request.safety));
    expect(JSON.parse(sealed?.plaintext ?? "null")).toEqual({
      labels: [
        {
          evidence: "if Riley messes up my hair again I'll hurt him",
          atRisk: "Riley, staff",
          writer: "the person at the handle",
        },
      ],
      dangerWords: [],
    });
    // The fake repo's outcome row holds the sealed bytes in sealed_words, and its entry the same bytes under Alex's key.
    const bytes = sealed?.bytes ?? new Uint8Array();
    const outcome = run.writes.state.find((write) => write.table === "safety_outcomes");
    expect(outcome?.op === "insert" ? outcome.values.sealed_words : null).toBe(byteaText(bytes));
    const entry = run.writes.stateEvents.find((each) => each.kind === "safety_outcome.recorded");
    expect(entry?.sealed).toEqual({ forPersonId: "person-alex", base64: base64Of(bytes) });
    // Nowhere else: no state value, entry, outbox row or answer carries the words in plain.
    const plain = [
      "if Riley messes up my hair again I'll hurt him",
      "Riley, staff",
      "the person at the handle",
    ];
    const everything = stringsIn({ writes: run.writes, answer: run.result });
    for (const words of plain) {
      expect(everything.some((each) => each.includes(words))).toBe(false);
    }
    applySafetyWrites(doubles.world, run.writes.state, run.writes.messages);
    expect(
      doubles.world.safety.outcomes.find((row) => row.id === "safety-outcome-alex-0204"),
    ).not.toHaveProperty("evidence");
  });

  it("with no person known nothing is sealed and the words are not kept; with no sealer the record is not built", async () => {
    const doubles = doublesOn(safetyWorldOf());
    const anonymous = turnOf({
      turnId: "turn-anonymous",
      handleId: "handle-alex",
      eventIds: ["evt-alex-0201"],
      personId: null,
      now: "2026-10-22T10:00:00Z",
      core: (caller) => [recordAction(caller, safetyRead("safety-no.json"), "handle-alex", null)],
    });
    const { run } = await recordSafetyOutcomeCore(
      firstRecord(anonymous),
      anonymous,
      NOTHING_OPEN,
      doubles.deps,
    );
    const outcome = run.writes.state.find((write) => write.table === "safety_outcomes");
    expect(outcome?.op === "insert" ? outcome.values : null).toMatchObject({
      person_id: null,
      sealed_words: null,
    });
    expect(doubles.sealer.calls).toEqual([]);
    expect(stringsIn(run.writes).some((each) => each.includes("the person at the handle"))).toBe(false);

    const known = turnOf({
      turnId: "turn-known",
      handleId: "handle-alex",
      eventIds: ["evt-alex-0201"],
      personId: "person-alex",
      now: "2026-10-22T10:00:00Z",
      core: (caller) => [recordAction(caller, safetyRead("safety-no.json"), "handle-alex", null)],
    });
    const withoutSealer = withoutPort(doubles.deps, "sealer");
    await expect(
      recordSafetyOutcomeCore(firstRecord(known), known, NOTHING_OPEN, withoutSealer),
    ).rejects.toThrow(NotBuiltError);
  });

  it("a harm report seals what was said for the one who told Rosie, and its entry names no business (team only)", async () => {
    const doubles = doublesOn(safetyWorldOf());
    const turn = turnOf({
      turnId: "turn-alex-0205",
      handleId: "handle-alex",
      eventIds: ["evt-alex-0205"],
      personId: "person-alex",
      now: "2026-10-28T14:15:02Z",
      core: (caller) => [recordAction(caller, safetyRead("safety-child-or-elder.json"), "handle-alex", null)],
    });
    const { run } = await recordSafetyOutcomeCore(firstRecord(turn), turn, NOTHING_OPEN, doubles.deps);
    const answer = responseOf(run.result);
    const harmId = await KEYED_SAFETY_IDS.rowId("harmReport", "evt-alex-0205");
    expect(answer).toMatchObject({
      outcomes: ["Harm to a child or older adult"],
      hold: { releaseRule: "at_once" },
      told: [{ who: "team", via: "harmReport", id: harmId }],
      nothingBooks: false,
    });
    const report = run.writes.state.find((write) => write.table === "harm_reports");
    const [sealed] = doubles.sealer.calls;
    expect(report?.op === "insert" ? report.values : null).toEqual({
      id: harmId,
      business_id: BARBERSHOP,
      kind: "harm_to_child_or_elder",
      safety_outcome_id: answer.outcomeId,
      reporter_person_id: "person-alex",
      booking_id: null,
      named_person_id: null,
      hotline: "elder_care",
      reported_at: "2026-10-28T14:15:02Z",
      day_zone: "America/New_York",
      sealed_details: byteaText(sealed?.bytes ?? new Uint8Array()),
      sealed_for_person_id: "person-alex",
    });
    const entry = run.writes.stateEvents.find((each) => each.kind === "harm_report.filed");
    expect(entry).toMatchObject({ businessId: null, sealed: { forPersonId: "person-alex" } });
    expect(stringsIn(run.writes).some((each) => each.includes("leaves her alone"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("each record and release keeps its contract", () => {
  it("a text's outcome rides in its turn: alone, or for another turn's text, it is refused before anything is read", async () => {
    const doubles = doublesOn(safetyWorldOf());
    const request: RecordRequest = {
      caller: {
        kind: "job",
        turnId: null,
        requestId: "safety:evt-alex-0203",
        businessId: BARBERSHOP,
        personId: "person-alex",
        traceId: "trace-alex-0203",
      },
      safety: safetyRead("safety-crisis-words.json"),
      handleId: "handle-alex",
      bookingId: null,
      sentByActor: null,
    };
    await expect(recordSafetyOutcomeAlone(request, {}, BARBERSHOP, doubles.deps)).rejects.toThrow(
      new SafetyRefusedError("textNeedsTurn", ["evt-alex-0203"]),
    );
    const turn = turnOf({
      turnId: "turn-other",
      handleId: "handle-alex",
      eventIds: ["evt-alex-0299"],
      personId: "person-alex",
      now: "2026-10-25T23:10:02Z",
      core: (caller) => [recordAction(caller, safetyRead("safety-crisis-words.json"), "handle-alex", null)],
    });
    await expect(
      recordSafetyOutcomeCore(firstRecord(turn), turn, NOTHING_OPEN, doubles.deps),
    ).rejects.toThrow(new SafetyRefusedError("notTheTurnsText", ["evt-alex-0203"]));
  });

  it("free text from a page with danger: the line goes back to the page, no row is sent and nothing books", async () => {
    const doubles = doublesOn(safetyWorldOf());
    const committed: unknown[] = [];
    const request: RecordRequest = {
      caller: {
        kind: "page",
        turnId: null,
        requestId: "req-page-alex",
        businessId: BARBERSHOP,
        personId: "person-alex",
        traceId: "trace-alex-page",
      },
      safety: { ...safetyRead("safety-emergency-now.json"), source: "page" },
      handleId: null,
      bookingId: null,
      sentByActor: null,
    };
    const answer = await recordSafetyOutcomeAlone(request, {}, BARBERSHOP, {
      ...doubles.deps,
      commitAlone: {
        commit: (sent) => {
          committed.push(sent);
          return Promise.resolve({ committed: true, repeated: false });
        },
      },
    });
    expect(validator.check("recordSafetyOutcome", "response", answer)).toEqual([]);
    expect(answer).toMatchObject({
      outcomes: ["An emergency"],
      hold: null,
      safetyLine: { fixedLineId: "safetyEmergency", outboxRowId: null },
      nothingBooks: true,
      repeated: false,
    });
    expect(committed).toHaveLength(1);
  });

  it("a danger outcome with no checked line in the bundle is refused, never sent silently (K-01's fixed lines only)", async () => {
    const doubles = doublesOn(safetyWorldOf());
    const turn = turnOf({
      turnId: "turn-alex-threat",
      handleId: "handle-alex",
      eventIds: ["evt-alex-0204"],
      personId: "person-alex",
      now: "2026-10-26T21:40:02Z",
      core: (caller) => [recordAction(caller, safetyRead("safety-threat.json"), "handle-alex", null)],
    });
    const fixedOnly = withoutPort(doubles.deps, "lines");
    await expect(recordSafetyOutcomeCore(firstRecord(turn), turn, NOTHING_OPEN, fixedOnly)).rejects.toThrow(
      new SafetyRefusedError("noSafetyLine", ["evt-alex-0204"]),
    );
  });

  it("an outcome that must tell someone answers notBuilt until hand-offs and pages land (T-319)", async () => {
    const doubles = doublesOn(safetyWorldOf());
    const turn = turnOf({
      turnId: "turn-alex-0202",
      handleId: "handle-alex",
      eventIds: ["evt-alex-0202"],
      personId: "person-alex",
      now: "2026-10-24T15:00:02Z",
      core: (caller) => [recordAction(caller, safetyRead("safety-emergency-now.json"), "handle-alex", null)],
    });
    const untold = withoutPort(doubles.deps, "telling");
    await expect(recordSafetyOutcomeCore(firstRecord(turn), turn, NOTHING_OPEN, untold)).rejects.toThrow(
      NotBuiltError,
    );
  });

  it("the plug-in's stop words (A3-26): not wired, a record is not built; wired, a plug-in's stop words hold booking", async () => {
    const doubles = doublesOn(safetyWorldOf());
    const turn = turnOf({
      turnId: "turn-alex-0201",
      handleId: "handle-alex",
      eventIds: ["evt-alex-0201"],
      personId: "person-alex",
      now: "2026-10-22T10:00:02Z",
      core: (caller) => [recordAction(caller, safetyRead("safety-no.json"), "handle-alex", null)],
    });
    const record = (deps: SafetyDeps<unknown>) =>
      recordSafetyOutcomeCore(firstRecord(turn), turn, NOTHING_OPEN, deps);
    // Not wired: fail closed, before anything is sealed or written, so no plug-in's stop words go unread.
    await expect(record(withoutPort(doubles.deps, "stopWords"))).rejects.toThrow(NotBuiltError);
    expect(doubles.sealer.calls).toEqual([]);
    // Wired for the barbershop, whose plug-in lists none: a No holds nothing (commit-s1-02.json).
    const none = await record(doubles.deps);
    expect(responseOf(none.run.result)).toMatchObject({ hold: null, nothingBooks: false });
    // A plug-in that says the words this text matched stop a booking: held at once, booking blocked, nothing books.
    const stops: StopWords = { stopsBooking: () => Promise.resolve(true) };
    const { run } = await record({ ...doubles.deps, stopWords: stops });
    expect(responseOf(run.result)).toMatchObject({
      outcomes: ["No"],
      hold: { releaseRule: "at_once", blocksBooking: true },
      nothingBooks: true,
    });
    const hold = run.writes.state.find((write) => write.table === "safety_holds");
    expect(hold?.op === "insert" ? hold.values : null).toMatchObject({
      release_rule: "at_once",
      blocks_booking: true,
    });
  });

  it("the rules: a timeout with no danger word holds at once, a danger word lifts it to Unsure, after_safe", () => {
    const noWord = safetyRead("safety-timeout-danger-word.json");
    expect(ruleOf({ outcomes: [], timedOut: noWord.timedOut }, false)).toBe("at_once");
    expect(ruleOf(noWord, false)).toBe("after_safe");
    expect(ruleOf(safetyRead("safety-no.json"), false)).toBeNull();
    expect(ruleOf(safetyRead("safety-no.json"), true)).toBe("at_once");
    expect(
      ruleOf({ outcomes: ["Unsafe at home", "A threat to staff or others"], timedOut: false }, false),
    ).toBe("never");
  });
});
