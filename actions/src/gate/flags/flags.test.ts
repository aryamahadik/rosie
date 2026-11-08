// The gate's check of the record flags (T-317; C-078; arch 03 line 175), before limits 1 to 6 (T-298): a paused
// person's booking work and a deceased booking's new charge wait for the owner, stopped before any limit runs; every
// other part, a change that only protects and the owner's own part go on to the limits as they are. On K-09 v1's and
// K-02 v1's fixtures (the master's sample cast), with doubles for the reads and for limits 1 to 6, never for the check.

import { describe, expect, it } from "vitest";

import { LIMITS } from "../limits";
import { limit2 } from "../limit-2";
import { limit3 } from "../limit-3";
import { limit4 } from "../limit-4";
import { limit5 } from "../limit-5";
import { limit6 } from "../limit-6";
import {
  LimitNotBuiltError,
  runGate,
  type Decided,
  type GatePart,
  type GateRequest,
  type GateTurn,
} from "../framework";
import {
  callContext,
  copy,
  decidedOf,
  gateExchange,
  gateRequest,
  scriptedLimits,
  twoRequests,
  type LimitCall,
} from "../framework/test-support";
import {
  ASKED_DECIDER,
  decideFlags,
  flagsFirst,
  type BookingFlags,
  type GateFlagReads,
  type PauseRef,
} from "./index";

const BARBERSHOP = "biz-lees-barbershop";
const NOV14 = "booking-alex-riley-nov14";

/** Alex's bare "2" to A7-17 on his Nov 14 visit (K-09 commit-limit-2-owner-rule.json): a part on a booking. */
function alexOnNov14(): Decided {
  return copy(decidedOf(gateExchange("commit-limit-2-owner-rule.json")));
}

interface Reads extends GateFlagReads {
  /** Every read made, as `<read>:<id>` (a number is written as `phone`, never itself). */
  readonly calls: string[];
}

/** The flags' reads over given pauses and booking heads, writing down every read. */
function readsOf(
  input: {
    persons?: Readonly<Record<string, readonly PauseRef[]>>;
    phones?: Readonly<Record<string, readonly PauseRef[]>>;
    heads?: readonly BookingFlags[];
  } = {},
): Reads {
  const calls: string[] = [];
  return {
    calls,
    openPausesOfPerson(personId) {
      calls.push(`person:${personId}`);
      return Promise.resolve(input.persons?.[personId] ?? []);
    },
    openPausesOfPhone(number) {
      calls.push("phone");
      return Promise.resolve(input.phones?.[number] ?? []);
    },
    bookingFlags(bookingId) {
      calls.push(`booking:${bookingId}`);
      return Promise.resolve(input.heads?.find((head) => head.id === bookingId) ?? null);
    },
  };
}

/** Alex's Nov 14 visit as K-04's head would hold it. */
const nov14 = (fields: Partial<BookingFlags> = {}): BookingFlags => ({
  id: NOV14,
  businessId: BARBERSHOP,
  bookerPersonId: "person-alex",
  servedPersonId: "person-alex",
  deceased: false,
  ...fields,
});

/** The gate turn and the first part of a decided pair, as the gate hands them to a limit. */
function partAndTurn(decided: Decided, index = 0): { part: GatePart; turn: GateTurn } {
  const request = gateRequest(decided);
  const entry = decided.decide.parts[index];
  if (entry === undefined) throw new Error("no such part");
  const { part } = entry;
  if (
    part.verb !== "choose" &&
    part.verb !== "enter" &&
    part.verb !== "pass_on" &&
    part.verb !== "hand_off"
  ) {
    throw new Error("not a gated part");
  }
  const choice =
    part.verb === "choose" || part.verb === "enter"
      ? (decided.context.choices.find((each) => each.choiceId === part.choice) ?? null)
      : null;
  return {
    part: { index, part, choice },
    turn: {
      request,
      context: decided.context,
      decide: decided.decide,
      repo: { name: "gate-test-repo" },
      businessId: request.caller.businessId ?? BARBERSHOP,
    },
  };
}

const PAUSE_HERE: PauseRef = { id: "pause-alex-lees", businessId: BARBERSHOP };

describe("the registry checks the flags first, then limits 1 to 6 as they are", () => {
  it("slot 1 asks the flags before limit 1; slots 2 to 6 are the limits themselves", () => {
    expect(LIMITS.map((limit) => limit.limit)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(typeof LIMITS[0].flags).toBe("function");
    expect([LIMITS[1], LIMITS[2], LIMITS[3], LIMITS[4], LIMITS[5]]).toEqual([
      limit2,
      limit3,
      limit4,
      limit5,
      limit6,
    ]);
    expect(LIMITS[2]).toBe(limit3);
  });

  it("the outcome a flag gives is K-09 v1's limit 1 askedDecider (ask), the one the gate holds limit 1 to", () => {
    expect(ASKED_DECIDER).toEqual({ limit: 1, outcome: "ask", action: "askedDecider" });
  });
});

describe("paused: a paused person's booking work waits for the owner (A3-48; flag-paused.json)", () => {
  it("Alex's part on his Nov 14 visit is held by his open pause at the barbershop", async () => {
    const { part, turn } = partAndTurn(alexOnNov14());
    const reads = readsOf({ persons: { "person-alex": [PAUSE_HERE] }, heads: [nov14()] });
    expect(await decideFlags(part, turn, () => reads)).toEqual({
      result: "held",
      flag: "paused",
      rowIds: ["pause-alex-lees"],
    });
  });

  it("a pause on his phone holds it too, and so does one on the booking's person served", async () => {
    const { part, turn } = partAndTurn(alexOnNov14());
    // The writing handle is the mobile the fixture's text came from (K-02 v1 writer.handle).
    const mobile = turn.context.writer.handle;
    expect(mobile).toMatch(/^\+1555555/u);
    const byPhone = readsOf({ phones: { [mobile]: [PAUSE_HERE] }, heads: [nov14()] });
    expect(await decideFlags(part, turn, () => byPhone)).toMatchObject({ result: "held", flag: "paused" });
    expect(byPhone.calls).toContain("phone");
    // Someone else books for Alex: the pause on the person served holds the visit (A3-48: "visits with that person").
    const served = readsOf({
      persons: { "person-riley": [{ id: "pause-riley-lees", businessId: BARBERSHOP }] },
      heads: [nov14({ servedPersonId: "person-riley" })],
    });
    expect(await decideFlags(part, turn, () => served)).toEqual({
      result: "held",
      flag: "paused",
      rowIds: ["pause-riley-lees"],
    });
  });

  it("a pause at another business, or none, lets the part go on to the limits", async () => {
    const { part, turn } = partAndTurn(alexOnNov14());
    const elsewhere = readsOf({
      persons: { "person-alex": [{ id: "pause-alex-movers", businessId: "biz-movers" }] },
      heads: [nov14()],
    });
    expect(await decideFlags(part, turn, () => elsewhere)).toEqual({ result: "pass" });
    expect(await decideFlags(part, turn, () => readsOf({ heads: [nov14()] }))).toEqual({ result: "pass" });
  });

  it("a request for a new booking through the door waits too (A3-48: new requests wait for Sam)", async () => {
    const decided = alexOnNov14();
    for (const choice of decided.context.choices) {
      choice.kind = "door";
      choice.door = "newBooking";
      choice.question = null;
      choice.branch = null;
      choice.target.bookingId = null;
    }
    const { part, turn } = partAndTurn(decided);
    const reads = readsOf({ persons: { "person-alex": [PAUSE_HERE] } });
    expect(await decideFlags(part, turn, () => reads)).toMatchObject({ result: "held", flag: "paused" });
    expect(reads.calls).not.toContain(`booking:${NOV14}`);
  });

  it("work on no booking, a change that only protects and the owner's own part read nothing and go on", async () => {
    // Sam's two owner-hub cases (K-02 context-two-requests.json): about no booking.
    const sam = partAndTurn(twoRequests());
    const none = readsOf({ persons: { "person-sam": [PAUSE_HERE] } });
    expect(await decideFlags(sam.part, sam.turn, () => none)).toEqual({ result: "pass" });
    // A STOP said in other words (any-time row stop) commits at once, past every flag (commit/hold.ts PROTECTIVE_ROWS).
    const stopWords = alexOnNov14();
    for (const choice of stopWords.context.choices) {
      choice.kind = "anytime";
      choice.anytimeRow = "stop";
    }
    const stop = partAndTurn(stopWords);
    expect(await decideFlags(stop.part, stop.turn, () => none)).toEqual({ result: "pass" });
    // The owner acting on the paused customer's visit is the owner's decision (arch 03 line 177).
    const owner = alexOnNov14();
    owner.context.writer.people[0].roles.push({ role: "owner", businessId: BARBERSHOP });
    const ownerPart = partAndTurn(owner);
    expect(await decideFlags(ownerPart.part, ownerPart.turn, () => none)).toEqual({ result: "pass" });
    expect(none.calls).toEqual([]);
  });
});

describe("deceased: nothing new is charged on the booking (A7-81)", () => {
  /** Alex's part with its choice now charging or taking money (K-02 v1 stakesFrom). */
  function charging(why: "charge" | "money" | "refund"): Decided {
    const decided = alexOnNov14();
    for (const choice of decided.context.choices) {
      choice.stakes = "high";
      choice.stakesFrom = [{ why, step: "A7-17", ref: "fee" }];
    }
    return decided;
  }

  it("a charge or money taken on a deceased booking is held; the same booking's other work is not", async () => {
    const reads = readsOf({ heads: [nov14({ deceased: true })] });
    for (const why of ["charge", "money"] as const) {
      const { part, turn } = partAndTurn(charging(why));
      expect(await decideFlags(part, turn, () => reads)).toEqual({
        result: "held",
        flag: "deceased",
        rowIds: [NOV14],
      });
    }
    const refund = partAndTurn(charging("refund"));
    expect(await decideFlags(refund.part, refund.turn, () => reads)).toEqual({ result: "pass" });
    const plain = partAndTurn(alexOnNov14());
    expect(await decideFlags(plain.part, plain.turn, () => reads)).toEqual({ result: "pass" });
  });

  it("a booking that is not deceased, or another business's head, holds no charge", async () => {
    const { part, turn } = partAndTurn(charging("charge"));
    expect(await decideFlags(part, turn, () => readsOf({ heads: [nov14()] }))).toEqual({ result: "pass" });
    const other = readsOf({ heads: [nov14({ deceased: true, businessId: "biz-movers" })] });
    expect(await decideFlags(part, turn, () => other)).toEqual({ result: "pass" });
  });
});

describe("in the gate: a part a flag holds is stopped before any limit runs, and only it", () => {
  it("Alex's paused booking part stops with askedDecider; no limit runs for it; the span logs limit 1's outcome", async () => {
    const calls: LimitCall[] = [];
    const reads = readsOf({ persons: { "person-alex": [PAUSE_HERE] }, heads: [nov14()] });
    const call = callContext(BARBERSHOP);
    const verdict = await runGate(
      gateRequest(alexOnNov14()),
      call,
      flagsFirst(scriptedLimits({}, calls), { reads: () => reads }),
    );
    expect(verdict).toEqual({
      verdict: "gated",
      parts: [
        {
          part: 0,
          choiceId: "c-02",
          result: "stopped",
          limits: [
            { limit: 1, result: "fail", outcome: "askedDecider" },
            { limit: 2, result: "notChecked", outcome: null },
            { limit: 3, result: "notChecked", outcome: null },
            { limit: 4, result: "notChecked", outcome: null },
            { limit: 5, result: "notChecked", outcome: null },
            { limit: 6, result: "notChecked", outcome: null },
          ],
          stoppedBy: ASKED_DECIDER,
          refusedBy: null,
          dependsOnPart: null,
        },
      ],
    });
    expect(calls).toEqual([]);
    expect(call.span.limits[0]).toEqual({ limit: 1, result: "fail", outcome: "askedDecider" });
  });

  it("with no flag holding it, the same part takes limits 1 to 6 in order, as without the check", async () => {
    const calls: LimitCall[] = [];
    const reads = readsOf({ heads: [nov14()] });
    const verdict = await runGate(
      gateRequest(alexOnNov14()),
      callContext(BARBERSHOP),
      flagsFirst(scriptedLimits({}, calls), { reads: () => reads }),
    );
    expect(verdict).toMatchObject({ verdict: "gated", parts: [{ result: "passed" }] });
    expect(calls).toEqual([1, 2, 3, 4, 5, 6].map((limit) => ({ limit, part: 0 })));
    // A limit's own failure still stops the part as it did (limit 1's double here).
    const failing = await runGate(
      gateRequest(alexOnNov14()),
      callContext(BARBERSHOP),
      flagsFirst(scriptedLimits({ 0: { 1: { result: "fail", outcome: ASKED_DECIDER } } }), {
        reads: () => reads,
      }),
    );
    expect(failing).toMatchObject({ parts: [{ result: "stopped", stoppedBy: ASKED_DECIDER }] });
  });

  it("the shipped registry reads only through the call's database: a booking part with any other repo fails the call", async () => {
    const request: GateRequest = gateRequest(alexOnNov14());
    await expect(runGate(request, callContext(BARBERSHOP), LIMITS)).rejects.toThrow(TypeError);
    // Work on no booking reads nothing, so it reaches limit 1, the fail-closed stub until T-299 lands: notBuilt.
    await expect(runGate(gateRequest(twoRequests()), callContext(), LIMITS)).rejects.toBeInstanceOf(
      LimitNotBuiltError,
    );
  });
});
