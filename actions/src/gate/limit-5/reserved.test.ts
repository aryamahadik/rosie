// T-303's proofs (the card's "Proves it with"), on the contracts' own fixtures, with doubles standing in for limit 5's
// ports, for limits 1 to 4 and 6, for the commit's other ports and for K-05 v1's data-access calls, never for limit 5 or
// the commit:
//   - commit-limit-5-taken.json gives its outcome: Alex's pick after its saved time was let go stops at limit 5 with the
//     next open times, never an error;
//   - commit-reservation-lost.json gives its outcome: K-05 v1 refuses the commit of a saved time let go (reservationLost),
//     and the gate and commit turn that refusal into limit 5's outcome;
//   - the hard invariant (no time booked twice): two turns booking one held slot against the K-05 fake: only the holder's
//     commit passes;
//   - the outcome's pick window is 10 minutes for a page and 2 text hours for a text.
// Also: every other K-09 gate fixture comes out as it states with the real limit 5 in its slot; limit 5 checks only what
// books a time, each saved time held for this part; what it returns holds no person's words or numbers; the shipped limit
// sits in slot 5, reads only through the call's database, and fails closed while the ports it reads are not built.

import { describe, expect, it } from "vitest";

import { gateAndCommit } from "../../commit";
import { doublePorts } from "../../commit/test-support";
import type { CommitDeps, CommitPorts, Committed, GateAndCommitAnswer } from "../../commit/types";
import { NotBuiltError } from "../../tool-api/errors";
import { stringsIn } from "../../tool-api/test-support";
import {
  partResultOf,
  runGate,
  type GatePart,
  type GateRequest,
  type GatedPart,
  type GateVerdict,
} from "../framework";
import {
  DECIDED_GATE_FIXTURES,
  callContext,
  copy,
  fixtureScript,
  gateExchange,
  scriptedLimits,
  wordsIn,
  type LimitCall,
} from "../framework/test-support";
import { SAM, offChat } from "../limit-3/test-support";
import { LIMITS } from "../limits";
import {
  Limit5NotBuiltError,
  addTextHours,
  asReservationLost,
  createLimit5,
  limit5,
  nextOpenTimesOutcome,
  nothingBookedOutcome,
  pickWindowOf,
  type LostTime,
  type OpenTime,
  type ReservedDecision,
  type SavedTime,
} from "./index";
import {
  ALEX,
  BARBERSHOP,
  TOMAS,
  ZONE,
  asked,
  barrier,
  bookingDeps,
  bookingWrites,
  commitExchange,
  decidedIn,
  exchangeRequest,
  finderOf,
  limitIn,
  partOf,
  readerOf,
  registryWith,
  releaseExchange,
  reservationsFake,
  seededReservations,
  timesPickRequest,
  tomasWaiting,
  turnOf,
  walkOf,
  withoutLimit5,
  type BookingRun,
  type ReservationsFake,
  type World,
} from "./test-support";

// ---------------------------------------------------------------------------------------------------------------
// Helpers

/** The parts of a gated verdict; fails the test for a refused one. */
function gatedParts(verdict: GateVerdict): readonly GatedPart[] {
  if (verdict.verdict !== "gated") throw new Error(`refused: ${JSON.stringify(verdict.error)}`);
  return verdict.parts;
}

/** A K-09 exchange's committed outcome; fails the test for any other. */
function committedOf(file: string) {
  const { outcome } = gateExchange(file);
  if ("error" in outcome || outcome.result !== "committed") throw new Error(`${file} is not committed`);
  return outcome;
}

/** A gateAndCommit answer that committed; fails the test for any other. */
function committed(answer: GateAndCommitAnswer): Committed {
  if ("error" in answer || answer.result !== "committed")
    throw new Error(`not committed: ${JSON.stringify(answer)}`);
  return answer;
}

/** A failed decision; fails the test for any other. */
function failed(decision: ReservedDecision): Extract<ReservedDecision, { result: "fail" }> {
  if (decision.result !== "fail") throw new Error(`not a failure: ${decision.result}`);
  return decision;
}

/** Limits 1 to 6 for one part, as the part's result logs them when limit 5 fails. */
const STOPPED_AT_5 = [
  { limit: 1, result: "pass", outcome: null },
  { limit: 2, result: "pass", outcome: null },
  { limit: 3, result: "pass", outcome: null },
  { limit: 4, result: "pass", outcome: null },
  { limit: 5, result: "fail", outcome: "nextOpenTimes" },
  { limit: 6, result: "notChecked", outcome: null },
];

/** The request with its first choice's stakes set to these reasons (K-02 v1 stakesReason). */
function withStakes(request: GateRequest, reasons: readonly string[]): GateRequest {
  const changed = copy(request);
  const [choice] = decidedIn(changed).context.choices;
  choice.stakes = reasons.length > 0 ? "high" : "low";
  choice.stakesFrom = reasons.map((why) => ({ why, step: null, ref: null })) as typeof choice.stakesFrom;
  return changed;
}

const overlaps = (a: SavedTime["during"], b: SavedTime["during"]): boolean =>
  Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);

/** The fake's booked rows on a resource that overlap a time: never more than one. */
function bookedOn(fake: ReservationsFake, resourceId: string, during: SavedTime["during"]): string[] {
  return [...fake.rows.values()]
    .filter((row) => row.state === "booked" && row.resourceId === resourceId && overlaps(row.during, during))
    .map((row) => row.id);
}

// ---------------------------------------------------------------------------------------------------------------
// K-09 commit-limit-5-taken.json: Alex picks 2:00pm with Riley from A4-14's times card after its saved time was let go

const LIMIT_5_FIXTURE = "commit-limit-5-taken.json";
const FIXTURE_TURN = "turn-alex-a4-14-2pm";

/** Alex's 2:00pm with Riley on Sat Oct 24, saved for his mobile from the times card, let go by its clock at 15:18. */
const TWO_PM: SavedTime = {
  id: "rsv-alex-a4-14-2pm",
  businessId: BARBERSHOP,
  resourceId: "res-riley",
  during: { start: "2026-10-24T18:00:00Z", end: "2026-10-24T18:30:00Z" },
  state: "released",
  heldUntil: "2026-10-22T15:18:00Z",
  forPhoneNumber: "+15555550142",
  forAgentToken: null,
  bookingId: null,
  releasedWhy: "expired",
  version: 2,
};

/** The same saved time still held for Alex until 15:30, after the gate's now (15:20:04). */
const TWO_PM_HELD: SavedTime = {
  ...TWO_PM,
  state: "held",
  heldUntil: "2026-10-22T15:30:00Z",
  releasedWhy: null,
  version: 1,
};

/** Riley's next open times, as C-131 might give them: Tue Oct 27 11:00am (A6-11) and Sat Oct 24 3:30pm (A4-14's other). */
const TUESDAY_11: OpenTime = {
  resourceId: "res-riley",
  during: { start: "2026-10-27T15:00:00Z", end: "2026-10-27T15:30:00Z" },
};
const SATURDAY_330: OpenTime = {
  resourceId: "res-riley",
  during: { start: "2026-10-24T19:30:00Z", end: "2026-10-24T20:00:00Z" },
};
const RILEY_NEXT: readonly OpenTime[] = [TUESDAY_11, SATURDAY_330];

function fixtureWorld(rows: readonly SavedTime[] = [TWO_PM], walk: readonly string[] = [TWO_PM.id]): World {
  return { walk: { [FIXTURE_TURN]: walk }, rows, times: RILEY_NEXT };
}

const TEXT_WINDOW_1120 = {
  via: "text",
  textHours: 2,
  zone: ZONE,
  opens: "09:00",
  closes: "20:00",
  pickBy: "2026-10-22T17:20:04Z",
  cutByVisit: false,
} as const;

function lostTime(row: SavedTime, why: LostTime["why"]): LostTime {
  return {
    id: row.id,
    why,
    state: row.state,
    heldUntil: row.heldUntil,
    releasedWhy: row.releasedWhy,
    reserved: { businessId: row.businessId, resourceId: row.resourceId, during: row.during },
  };
}

describe("commit-limit-5-taken.json gives its outcome", () => {
  it("Alex's '2pm works' after its saved time was let go stops at limit 5 with the next open times; the part is as the fixture states", async () => {
    const exchange = gateExchange(LIMIT_5_FIXTURE);
    const request = exchangeRequest(LIMIT_5_FIXTURE);
    const calls: LimitCall[] = [];
    const call = callContext(BARBERSHOP);
    const script = withoutLimit5(fixtureScript(exchange));
    const parts = gatedParts(
      await runGate(request, call, registryWith(limitIn(fixtureWorld()), script, calls)),
    );
    const stated = committedOf(LIMIT_5_FIXTURE).parts;
    expect(parts.map((part) => partResultOf(part))).toEqual(stated);
    expect(stated[0]?.stoppedBy).toEqual(nextOpenTimesOutcome());
    expect(calls).toEqual([1, 2, 3, 4, 5].map((limit) => ({ limit, part: 0 })));
    expect(call.span.limits).toEqual(stated[0]?.limits);
  });

  it("its decision: the saved time let go, Riley's next open times soonest first, and 2 of Alex's text hours to pick", async () => {
    const request = exchangeRequest(LIMIT_5_FIXTURE);
    const seen = asked();
    expect(await limitIn(fixtureWorld(), seen).decide(partOf(request), turnOf(request))).toEqual({
      result: "fail",
      why: "released",
      lost: [lostTime(TWO_PM, "released")],
      outcome: nextOpenTimesOutcome(),
      next: { kind: "nextOpenTimes", times: [SATURDAY_330, TUESDAY_11], window: TEXT_WINDOW_1120 },
    });
    expect(seen.walk).toEqual([{ turnId: FIXTURE_TURN, part: 0 }]);
    expect(seen.read).toEqual([TWO_PM.id]);
    expect(seen.queries).toEqual([{ part: 0, lost: [lostTime(TWO_PM, "released")] }]);
  });

  it.each(DECIDED_GATE_FIXTURES)(
    "%s: with the real limit 5 in its slot, every part comes out as the fixture states",
    async (file) => {
      const exchange = gateExchange(file);
      const world: World = file === LIMIT_5_FIXTURE ? fixtureWorld() : { walk: {}, rows: [], times: [] };
      const verdict = await runGate(
        exchangeRequest(file),
        callContext(BARBERSHOP),
        registryWith(limitIn(world), withoutLimit5(fixtureScript(exchange))),
      );
      const { outcome } = exchange;
      if ("error" in outcome) {
        expect(verdict).toEqual({ verdict: "refused", error: outcome });
        return;
      }
      if (outcome.result !== "committed") throw new Error("a committed fixture expected");
      const answered = gatedParts(verdict).map((part, index) =>
        partResultOf(part, outcome.parts[index]?.gives ?? []),
      );
      expect(answered).toEqual(outcome.parts);
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// K-05 commit-reservation-lost.json: Alex's yes to his saved time with Avery comes after its clock let it go

const LOST_FIXTURE = "commit-reservation-lost.json";
const RELEASE_FIXTURE = "release-expired-promotes.json";
const AVERY_SAVED = "rsv-alex-saved-avery";
const AGENT_PROMOTED = "rsv-agent-waiting-avery";
/** K-04 seed-reservation.json's Avery, Sat Nov 14, 10:00 to 10:30am. */
const AVERY_10AM = { start: "2026-11-14T15:00:00Z", end: "2026-11-14T15:30:00Z" };
/** Avery's next open times that Saturday, as C-131 might give them (examples). */
const AVERY_NEXT: readonly OpenTime[] = [
  { resourceId: "res-avery", during: { start: "2026-11-14T15:30:00Z", end: "2026-11-14T16:00:00Z" } },
  { resourceId: "res-avery", during: { start: "2026-11-14T16:30:00Z", end: "2026-11-14T17:00:00Z" } },
];
const BUSINESS_READ = { table: "businesses", rowId: BARBERSHOP, version: 3 };

/** Alex picks Avery's 10:00am on his own phone: the K-05 fixture's turn, trace and event, at `now`. */
function alexPicksAvery(given: {
  turnId?: string;
  traceId?: string;
  eventId?: string;
  sentAt: string;
  now?: string;
}) {
  return timesPickRequest({
    who: ALEX,
    turnId: given.turnId ?? "turn-alex-book-2",
    traceId: given.traceId ?? "trace-alex-0014",
    eventId: given.eventId ?? "evt-alex-0014",
    words: "10am works",
    sentAt: given.sentAt,
    ...(given.now === undefined ? {} : { now: given.now }),
    question: "oq-a4-14-alex-avery",
    questionSentAt: "2026-11-07T15:00:30Z",
    labels: ["Sat Nov 14, 10:00am", "Sat Nov 14, 11:30am"],
    definition: "That time with Avery.",
  });
}

/** K-04's seeds in the fake, with the business row the fixture's commit reads at version 3. */
function seededFake(now: string): ReservationsFake {
  const fake = reservationsFake({ now, versions: [BUSINESS_READ] });
  fake.seed(seededReservations());
  return fake;
}

/** The saved-time clock lets Alex's time go at 15:10 (the fixture's `after`), exactly as K-05 states it. */
function clockLetsGo(fake: ReservationsFake): void {
  const release = releaseExchange(RELEASE_FIXTURE);
  fake.now = release.request.at;
  expect(fake.release(release.request)).toEqual(release.outcome);
}

describe("commit-reservation-lost.json gives its outcome", () => {
  it("the K-05 fake gives both exchanges as K-05 v1 states them: the clock's release at 15:10, then the commit refused at 15:10:30", async () => {
    const fake = seededFake("2026-11-07T15:00:00Z");
    clockLetsGo(fake);
    fake.now = "2026-11-07T15:10:30Z";
    const exchange = commitExchange(LOST_FIXTURE);
    expect(await fake.commitTurn(exchange.request, callContext(BARBERSHOP))).toEqual(exchange.outcome);
    expect(fake.commits).toEqual([]);
  });

  it("in that world limit 5 refuses Alex's pick before any write, naming the same lost saved time, with the next open times", async () => {
    const fake = seededFake("2026-11-07T15:00:00Z");
    clockLetsGo(fake);
    fake.now = "2026-11-07T15:10:30Z";
    const request = alexPicksAvery({ sentAt: "2026-11-07T15:10:28Z", now: "2026-11-07T15:10:30Z" });
    const limit = limitIn({
      walk: { "turn-alex-book-2": [AVERY_SAVED] },
      rows: fake.reader,
      times: AVERY_NEXT,
    });
    const decision = failed(await limit.decide(partOf(request), turnOf(request)));
    const refused = commitExchange(LOST_FIXTURE).outcome;
    if (!("error" in refused) || refused.error !== "reservationLost") throw new Error("the fixture refuses");
    expect(asReservationLost(decision.lost)).toEqual(refused.reservations);
    expect(decision.why).toBe("released");
    expect(decision.outcome).toEqual(nextOpenTimesOutcome());
    expect(decision.next).toEqual({
      kind: "nextOpenTimes",
      times: AVERY_NEXT,
      window: {
        via: "text",
        textHours: 2,
        zone: ZONE,
        opens: "09:00",
        closes: "20:00",
        pickBy: "2026-11-07T17:10:30Z",
        cutByVisit: false,
      },
    });
  });

  it("through gateAndCommit: the clock lets the time go between the gate and the commit; K-05 refuses the fixture's commit; the turn is gated again and limit 5's outcome comes back, never an error", async () => {
    const fake = seededFake("2026-11-07T15:09:58Z");
    const request = alexPicksAvery({ sentAt: "2026-11-07T15:09:57Z", now: "2026-11-07T15:09:58Z" });
    const exchange = commitExchange(LOST_FIXTURE);
    const { writes } = exchange.request;
    const [choice] = decidedIn(request).context.choices;
    const base = doublePorts({
      writes: {
        0: bookingWrites(choice, writes.reservations.confirm, writes.state, exchange.request.versionsRead),
      },
      k05: fake,
    });
    let raced = 0;
    const ports: CommitPorts = {
      ...base.ports,
      writesOf(part, turn, open) {
        // The part has passed the gate; its saved time's clock fires before the commit lands (15:10:00).
        raced += 1;
        clockLetsGo(fake);
        fake.now = "2026-11-07T15:10:30Z";
        return base.ports.writesOf(part, turn, open);
      },
    };
    const limitCalls: LimitCall[] = [];
    const limit = limitIn({
      walk: { "turn-alex-book-2": [AVERY_SAVED] },
      rows: fake.reader,
      times: AVERY_NEXT,
    });
    const deps: CommitDeps = { limits: registryWith(limit, {}, limitCalls), ports };

    const answer = committed(await gateAndCommit(request, callContext(BARBERSHOP), deps));

    // The first commit was the fixture's request, with the commit's own entry for the booking; K-05 refused it as stated.
    const [first, second] = fake.requests;
    if (first === undefined || second === undefined) throw new Error("two commits expected");
    expect({ ...first, writes: { ...first.writes, events: [] } }).toEqual(exchange.request);
    expect(first.writes.events.map((entry) => entry.kind)).toEqual(["reservation.booked"]);
    // Gated again: limit 5 read the time let go, so the second commit books nothing.
    expect(raced).toBe(1);
    expect(base.calls.writesOf).toEqual([0]);
    expect(limitCalls.filter((each) => each.limit === 5)).toHaveLength(2);
    expect(second.writes.reservations).toEqual({ confirm: [], release: [] });
    expect(answer).toMatchObject({ turnId: "turn-alex-book-2", repeated: false });
    expect(answer.parts).toEqual([
      {
        part: 0,
        choiceId: "c-01",
        result: "stopped",
        limits: STOPPED_AT_5,
        stoppedBy: nextOpenTimesOutcome(),
        gives: [],
        dependsOnPart: null,
      },
    ]);
    // Nothing booked: Alex's time stays let go, and the agent next in line holds it.
    expect(fake.rows.get(AVERY_SAVED)?.state).toBe("released");
    expect(fake.rows.get(AGENT_PROMOTED)?.state).toBe("held");
    expect(bookedOn(fake, "res-avery", AVERY_10AM)).toEqual([]);
    expect(fake.commits).toEqual([{ turnId: "turn-alex-book-2", written: [] }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Hard invariant: no time booked twice. Alex holds Avery's 10:00am (K-04 seed); Tomás waits next in line (K-05
// reserve-next-in-line.json). Both say yes at 15:07.

const TOMAS_LINE = "rsv-tomas-avery-nov14";

/** K-04's seeds with Tomás next in line, at 15:07. */
function averyWorld(): ReservationsFake {
  const fake = reservationsFake({ now: "2026-11-07T15:07:00Z" });
  fake.seed([...seededReservations(), tomasWaiting()]);
  return fake;
}

function alexRun(
  turnId: string,
  eventId: string,
  bookingId: string,
  beforeWrites?: () => Promise<void>,
): BookingRun {
  return {
    request: alexPicksAvery({
      turnId,
      traceId: `trace-${turnId}`,
      eventId,
      sentAt: "2026-11-07T15:06:59Z",
      now: "2026-11-07T15:07:00Z",
    }),
    bookingId,
    savedTimes: [AVERY_SAVED],
    ...(beforeWrites === undefined ? {} : { beforeWrites }),
  };
}

function tomasRun(savedTimes: readonly string[]): BookingRun {
  return {
    request: timesPickRequest({
      who: TOMAS,
      turnId: "turn-tomas-avery-yes",
      traceId: "trace-tomas-avery-yes",
      eventId: "evt-tomas-0001",
      words: "10am please",
      sentAt: "2026-11-07T15:06:59Z",
      now: "2026-11-07T15:07:00Z",
      question: "oq-a4-14-tomas-avery",
      questionSentAt: "2026-11-07T15:05:30Z",
      labels: ["Sat Nov 14, 10:00am", "Sat Nov 14, 11:30am"],
      definition: "That time with Avery.",
    }),
    bookingId: "booking-tomas-avery-nov14",
    savedTimes,
  };
}

type Order = "Alex first" | "Tomás first" | "at once";

/** Both turns through the gate and commit against one fake, in `order`; their answers and what each limit 5 searched. */
async function bothBook(fake: ReservationsFake, runs: { alex: BookingRun; tomas: BookingRun }, order: Order) {
  const alex = bookingDeps(fake, runs.alex, AVERY_NEXT);
  const tomas = bookingDeps(fake, runs.tomas, AVERY_NEXT);
  const go = (run: BookingRun, deps: CommitDeps) => gateAndCommit(run.request, callContext(BARBERSHOP), deps);
  let answers: [GateAndCommitAnswer, GateAndCommitAnswer];
  if (order === "at once") {
    answers = await Promise.all([go(runs.alex, alex.deps), go(runs.tomas, tomas.deps)]);
  } else if (order === "Alex first") {
    const first = await go(runs.alex, alex.deps);
    answers = [first, await go(runs.tomas, tomas.deps)];
  } else {
    const first = await go(runs.tomas, tomas.deps);
    answers = [await go(runs.alex, alex.deps), first];
  }
  return {
    alex: committed(answers[0]),
    tomas: committed(answers[1]),
    searched: { alex: alex.seen, tomas: tomas.seen },
  };
}

describe("hard invariant: no time booked twice", () => {
  const orders: readonly Order[] = ["Alex first", "Tomás first", "at once"];

  it.each(orders)(
    "two turns booking Avery's held 10:00am (%s): only the holder's commit books it; Tomás, next in line, gets the next open times",
    async (order) => {
      const fake = averyWorld();
      const result = await bothBook(
        fake,
        {
          alex: alexRun("turn-alex-avery-yes", "evt-alex-0101", "booking-alex-avery-nov14"),
          tomas: tomasRun([TOMAS_LINE]),
        },
        order,
      );
      expect(result.alex.parts.map((part) => part.result)).toEqual(["committed"]);
      expect(result.tomas.parts).toEqual([
        {
          part: 0,
          choiceId: "c-01",
          result: "stopped",
          limits: STOPPED_AT_5,
          stoppedBy: nextOpenTimesOutcome(),
          gives: [],
          dependsOnPart: null,
        },
      ]);
      expect(
        result.searched.tomas.queries.map((query) => query.lost.map((time) => [time.id, time.why])),
      ).toEqual([[[TOMAS_LINE, "waiting"]]]);
      expect(fake.rows.get(AVERY_SAVED)).toMatchObject({
        state: "booked",
        bookingId: "booking-alex-avery-nov14",
      });
      expect(fake.rows.get(TOMAS_LINE)?.state).toBe("waiting");
      expect(bookedOn(fake, "res-avery", AVERY_10AM)).toEqual([AVERY_SAVED]);
      expect(
        fake.commits.flatMap((each) => each.written.filter((row) => row.table === "reservations")),
      ).toEqual([{ table: "reservations", rowId: AVERY_SAVED, version: 2 }]);
    },
  );

  it.each(orders)(
    "a part of Tomás's that names Alex's held time itself (%s) is refused: it is held for Alex's mobile, not his",
    async (order) => {
      const fake = averyWorld();
      const result = await bothBook(
        fake,
        {
          alex: alexRun("turn-alex-avery-yes", "evt-alex-0101", "booking-alex-avery-nov14"),
          tomas: tomasRun([AVERY_SAVED]),
        },
        order,
      );
      expect(result.alex.parts.map((part) => part.result)).toEqual(["committed"]);
      expect(result.tomas.parts.map((part) => [part.result, part.stoppedBy])).toEqual([
        ["stopped", nextOpenTimesOutcome()],
      ]);
      const whys = result.searched.tomas.queries.flatMap((query) => query.lost.map((time) => time.why));
      // Before Alex's commit the time is held for Alex (notTheirs); after it, booked. At once, either: never Tomás's.
      const expected =
        order === "Alex first"
          ? ["booked"]
          : order === "Tomás first"
            ? ["notTheirs"]
            : ["notTheirs", "booked"];
      expect(whys).toHaveLength(1);
      expect(expected).toContain(whys[0]);
      expect(fake.rows.get(AVERY_SAVED)).toMatchObject({
        state: "booked",
        bookingId: "booking-alex-avery-nov14",
      });
      expect(bookedOn(fake, "res-avery", AVERY_10AM)).toEqual([AVERY_SAVED]);
    },
  );

  it("even the holder's own two turns at once, both past the gate, book it once: K-05 refuses the second commit, which is gated again and stopped by limit 5", async () => {
    const fake = averyWorld();
    const bothPassed = barrier(2);
    const runs = [
      alexRun("turn-alex-avery-a", "evt-alex-0102", "booking-alex-avery-a", bothPassed),
      alexRun("turn-alex-avery-b", "evt-alex-0103", "booking-alex-avery-b", bothPassed),
    ];
    const built = runs.map((run) => ({ run, ...bookingDeps(fake, run, AVERY_NEXT) }));
    const answers = await Promise.all(
      built.map((each) => gateAndCommit(each.run.request, callContext(BARBERSHOP), each.deps)),
    );
    const deps = built;
    const parts = answers.map((answer) => committed(answer).parts[0]);
    expect(parts.map((part) => part?.result).sort()).toEqual(["committed", "stopped"]);
    const stopped = parts.find((part) => part?.result === "stopped");
    expect(stopped?.stoppedBy).toEqual(nextOpenTimesOutcome());
    // Both passed the gate once; the one refused at K-05 was gated again and found the time booked.
    expect(deps.map((each) => each.calls.writesOf)).toEqual([[0], [0]]);
    const refusedWhys = deps.flatMap((each) =>
      each.seen.queries.map((query) => query.lost.map((time) => time.why)),
    );
    expect(refusedWhys).toEqual([["booked"]]);
    expect(bookedOn(fake, "res-avery", AVERY_10AM)).toEqual([AVERY_SAVED]);
    expect(fake.requests).toHaveLength(3);
    expect(
      fake.commits.flatMap((each) => each.written.filter((row) => row.table === "reservations")),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The pick window

describe("the outcome's pick window: 10 minutes for a page, 2 text hours for a text", () => {
  const PAGE_WINDOW_1120 = {
    via: "page",
    minutes: 10,
    pickBy: "2026-10-22T15:30:04Z",
    cutByVisit: false,
  } as const;

  async function windowOf(request: GateRequest, world: World = fixtureWorld()) {
    const decision = failed(await limitIn(world).decide(partOf(request), turnOf(request)));
    if (decision.next.kind !== "nextOpenTimes") throw new Error("next open times expected");
    return decision.next.window;
  }

  it("by text (the turn's own chat): 2 of Alex's text hours from 11:20:04am, so 1:20:04pm", async () => {
    expect(await windowOf(exchangeRequest(LIMIT_5_FIXTURE))).toEqual(TEXT_WINDOW_1120);
  });

  it("on the page: 10 minutes", async () => {
    const page = offChat(exchangeRequest(LIMIT_5_FIXTURE), "page", "person-alex");
    expect(await windowOf(page)).toEqual(PAGE_WINDOW_1120);
  });

  it("an outside AI is not on the page: 2 of their text hours", async () => {
    const agent = offChat(exchangeRequest(LIMIT_5_FIXTURE), "agent", "person-alex");
    expect(await windowOf(agent)).toEqual(TEXT_WINDOW_1120);
  });

  it("the owner's text hours open at 8am: Sam picking at 7:00am has until 10:00am", async () => {
    const request = timesPickRequest({
      who: SAM,
      role: "owner",
      turnId: "turn-sam-a4-14-early",
      traceId: "trace-sam-a4-14-early",
      eventId: "evt-sam-0701",
      words: "2pm works",
      sentAt: "2026-10-22T11:00:00Z",
      question: "oq-a4-14-sam",
      questionSentAt: "2026-10-22T10:50:00Z",
      labels: ["Sat Oct 24, 2:00pm", "Sat Oct 24, 3:30pm"],
      definition: "That time with Riley.",
    });
    const samsTime: SavedTime = { ...TWO_PM, id: "rsv-sam-2pm", forPhoneNumber: SAM.address };
    const window = await windowOf(request, {
      walk: { "turn-sam-a4-14-early": [samsTime.id] },
      rows: [samsTime],
      times: RILEY_NEXT,
    });
    expect(window).toEqual({ ...TEXT_WINDOW_1120, opens: "08:00", pickBy: "2026-10-22T14:00:00Z" });
  });

  it("counts only text hours: 7:30pm gives 30 minutes that day and 1h30 from 9am the next", () => {
    expect(
      pickWindowOf({
        via: "text",
        now: "2026-10-22T23:30:00Z",
        soonest: "2026-10-24T19:30:00Z",
        zone: ZONE,
        team: false,
      }),
    ).toEqual({ ...TEXT_WINDOW_1120, pickBy: "2026-10-23T14:30:00Z" });
  });

  it("before text hours open, the window starts at 9am", () => {
    expect(
      pickWindowOf({
        via: "text",
        now: "2026-10-22T10:00:00Z",
        soonest: "2026-10-24T19:30:00Z",
        zone: ZONE,
        team: false,
      }),
    ).toEqual({ ...TEXT_WINDOW_1120, pickBy: "2026-10-22T15:00:00Z" });
  });

  it("across the daylight-saving change (Sun Nov 1): 1 hour Saturday to 8pm EDT, then 9am EST Sunday, so 10am EST", () => {
    expect(
      pickWindowOf({
        via: "text",
        now: "2026-10-31T23:00:00Z",
        soonest: "2026-11-03T16:00:00Z",
        zone: ZONE,
        team: false,
      }),
    ).toEqual({ ...TEXT_WINDOW_1120, pickBy: "2026-11-01T15:00:00Z" });
  });

  it("it ends before the visit: never past the start of the soonest time offered", () => {
    expect(
      pickWindowOf({
        via: "text",
        now: "2026-10-24T17:00:00Z",
        soonest: "2026-10-24T18:00:00Z",
        zone: ZONE,
        team: false,
      }),
    ).toEqual({ ...TEXT_WINDOW_1120, pickBy: "2026-10-24T18:00:00Z", cutByVisit: true });
    expect(
      pickWindowOf({
        via: "page",
        now: "2026-10-24T17:55:00Z",
        soonest: "2026-10-24T18:00:00Z",
        zone: ZONE,
        team: false,
      }),
    ).toEqual({ via: "page", minutes: 10, pickBy: "2026-10-24T18:00:00Z", cutByVisit: true });
  });

  it("2 text hours that end exactly at 8pm end there, and hours that are not times are refused", () => {
    const sixPm = Date.parse("2026-10-22T22:00:00Z");
    expect(new Date(addTextHours(sixPm, 2 * 3_600_000, ZONE, "09:00", "20:00")).toISOString()).toBe(
      "2026-10-23T00:00:00.000Z",
    );
    expect(() => addTextHours(sixPm, 3_600_000, ZONE, "9am", "20:00")).toThrow(
      "text hours must be HH:MM times",
    );
    expect(() => addTextHours(sixPm, 3_600_000, ZONE, "20:00", "09:00")).toThrow(
      "text hours must open before they close",
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// What limit 5 checks

describe("limit 5 checks only what books a time, each saved time still held for this part", () => {
  const request = (): GateRequest => exchangeRequest(LIMIT_5_FIXTURE);

  async function decision(world: World, given: GateRequest = request()): Promise<ReservedDecision> {
    return limitIn(world).decide(partOf(given), turnOf(given));
  }

  async function whyOf(row: SavedTime, given: GateRequest = request()): Promise<string> {
    return failed(await decision(fixtureWorld([row], [row.id]), given)).why;
  }

  it("a saved time still held for Alex's mobile, its end after now: passes, and the part goes through the gate", async () => {
    const seen = asked();
    expect(
      await limitIn(fixtureWorld([TWO_PM_HELD]), seen).decide(partOf(request()), turnOf(request())),
    ).toEqual({
      result: "pass",
    });
    expect(seen.queries).toEqual([]);
    const parts = gatedParts(
      await runGate(request(), callContext(BARBERSHOP), registryWith(limitIn(fixtureWorld([TWO_PM_HELD])))),
    );
    expect(parts.map((part) => [part.result, part.limits[4]])).toEqual([
      ["passed", { limit: 5, result: "pass", outcome: null }],
    ]);
  });

  it.each([
    ["released (let go)", { ...TWO_PM }, "released"],
    ["booked already", { ...TWO_PM, state: "booked", releasedWhy: null, bookingId: null }, "booked"],
    [
      "next in line, never held",
      { ...TWO_PM, state: "waiting", heldUntil: null, releasedWhy: null },
      "waiting",
    ],
    [
      "held past its end (15:20:00), its clock not yet fired",
      { ...TWO_PM_HELD, heldUntil: "2026-10-22T15:20:00Z" },
      "pastEnd",
    ],
    ["held to exactly now (15:20:04)", { ...TWO_PM_HELD, heldUntil: "2026-10-22T15:20:04Z" }, "pastEnd"],
    ["held with no end", { ...TWO_PM_HELD, heldUntil: null }, "pastEnd"],
    ["at another business", { ...TWO_PM_HELD, businessId: "biz-yoga-studio" }, "otherBusiness"],
    ["held for another mobile", { ...TWO_PM_HELD, forPhoneNumber: TOMAS.address }, "notTheirs"],
    [
      "held for an agent token",
      { ...TWO_PM_HELD, forPhoneNumber: null, forAgentToken: "agent-token-demo-2" },
      "notTheirs",
    ],
    [
      "held for a booking the part is not on",
      { ...TWO_PM_HELD, bookingId: "booking-alex-haircut" },
      "notTheirs",
    ],
  ] as const)("a saved time %s fails", async (_name, row, why) => {
    expect(await whyOf(row)).toBe(why);
  });

  it("a saved time the call's scope hides, or that is gone, fails as notFound and is not one K-05 would list", async () => {
    const gone = failed(await decision(fixtureWorld([], ["rsv-gone"])));
    expect(gone.why).toBe("notFound");
    expect(gone.lost).toEqual([
      { id: "rsv-gone", why: "notFound", state: null, heldUntil: null, releasedWhy: null, reserved: null },
    ]);
    expect(asReservationLost(gone.lost)).toEqual([]);
  });

  it("a page's call books only a time saved for its booking: a time held for the mobile is not the page's", async () => {
    const page = offChat(request(), "page", "person-alex");
    expect(await whyOf(TWO_PM_HELD, page)).toBe("notTheirs");
    const onBooking = copy(page);
    const [choice] = decidedIn(onBooking).context.choices;
    choice.target.bookingId = "booking-alex-haircut";
    const forBooking: SavedTime = { ...TWO_PM_HELD, bookingId: "booking-alex-haircut" };
    expect(await decision(fixtureWorld([forBooking]), onBooking)).toEqual({ result: "pass" });
  });

  it("every saved time the part books must hold it: the lost ones are listed in order, the first reason given", async () => {
    const released: SavedTime = { ...TWO_PM, id: "rsv-b" };
    const waiting: SavedTime = {
      ...TWO_PM,
      id: "rsv-c",
      state: "waiting",
      heldUntil: null,
      releasedWhy: null,
    };
    const seen = asked();
    const world = fixtureWorld([TWO_PM_HELD, released, waiting], [TWO_PM_HELD.id, "rsv-b", "rsv-c", "rsv-b"]);
    const decided = failed(await limitIn(world, seen).decide(partOf(request()), turnOf(request())));
    expect(decided.why).toBe("released");
    expect(decided.lost).toEqual([lostTime(released, "released"), lostTime(waiting, "waiting")]);
    expect(seen.read).toEqual([TWO_PM_HELD.id, "rsv-b", "rsv-c"]);
    expect(seen.readers).toBe(1);
  });

  it("a choice that books a time (stakes booked) with no saved time fails: no reservation row holds it", async () => {
    const booking = withStakes(request(), ["booked"]);
    const seen = asked();
    const decided = failed(
      await limitIn(fixtureWorld([], []), seen).decide(partOf(booking), turnOf(booking)),
    );
    expect(decided).toMatchObject({ why: "noSavedTime", lost: [], outcome: nextOpenTimesOutcome() });
    expect(seen.queries).toEqual([{ part: 0, lost: [] }]);
    expect(seen.readers).toBe(0);
  });

  it("a part that books no time is notChecked, and nothing is read", async () => {
    const seen = asked();
    expect(await limitIn(fixtureWorld([], []), seen).decide(partOf(request()), turnOf(request()))).toEqual({
      result: "notChecked",
    });
    expect(seen.readers).toBe(0);
    expect(seen.queries).toEqual([]);
  });

  it("pass_on and hand_off book nothing: notChecked, without asking the walk", async () => {
    const seen = asked();
    const limit = limitIn(fixtureWorld(), seen);
    const turn = turnOf(request());
    const passOn: GatePart = {
      index: 0,
      part: { verb: "pass_on", quote: "2pm works", words: "2pm works" },
      choice: null,
    };
    const handOff: GatePart = {
      index: 0,
      part: { verb: "hand_off", quote: "2pm works", reason: "asks for a person", about: "other" },
      choice: null,
    };
    expect(await limit.decide(passOn, turn)).toEqual({ result: "notChecked" });
    expect(await limit.decide(handOff, turn)).toEqual({ result: "notChecked" });
    expect(seen.walk).toEqual([]);
  });

  it("with no open time to offer, nothing is booked (refuse)", async () => {
    const decided = failed(await decision({ ...fixtureWorld(), times: [] }));
    expect(decided).toMatchObject({
      why: "released",
      outcome: nothingBookedOutcome(),
      next: { kind: "nothingBooked" },
    });
  });

  it("the next open times are offered soonest first, each once, never one that has begun", async () => {
    const begun: OpenTime = {
      resourceId: "res-riley",
      during: { start: "2026-10-22T15:00:00Z", end: "2026-10-22T15:30:00Z" },
    };
    const empty: OpenTime = {
      resourceId: "res-riley",
      during: { start: "2026-10-26T15:00:00Z", end: "2026-10-26T15:00:00Z" },
    };
    const world: World = { ...fixtureWorld(), times: [TUESDAY_11, begun, SATURDAY_330, empty, SATURDAY_330] };
    const decided = failed(await decision(world));
    expect(decided.next).toMatchObject({ kind: "nextOpenTimes", times: [SATURDAY_330, TUESDAY_11] });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// No words, and the shipped limit

describe("what limit 5 returns holds no person's words or numbers", () => {
  it("its decision and the gate span hold ids, states, times and labels only", async () => {
    const request = exchangeRequest(LIMIT_5_FIXTURE);
    const otherMobile: SavedTime = { ...TWO_PM_HELD, id: "rsv-other-mobile", forPhoneNumber: TOMAS.address };
    const token: SavedTime = {
      ...TWO_PM_HELD,
      id: "rsv-token",
      forPhoneNumber: null,
      forAgentToken: "agent-token-demo-2",
    };
    const world = fixtureWorld([TWO_PM, otherMobile, token], [TWO_PM.id, otherMobile.id, token.id]);
    const decision = failed(await limitIn(world).decide(partOf(request), turnOf(request)));
    expect(decision.lost.map((time) => time.why)).toEqual(["released", "notTheirs", "notTheirs"]);
    const strings = stringsIn(decision);
    for (const words of wordsIn(decidedIn(request))) expect(strings).not.toContain(words);
    for (const secret of ["+15555550142", TOMAS.address, "agent-token-demo-2"]) {
      expect(strings.some((each) => each.includes(secret))).toBe(false);
    }
    const call = callContext(BARBERSHOP);
    await runGate(request, call, registryWith(limitIn(world)));
    expect(call.span.limits).toEqual(STOPPED_AT_5);
  });
});

describe("the shipped limit 5", () => {
  it("sits in slot 5 of the gate's registry", () => {
    expect(LIMITS[4]).toBe(limit5);
  });

  it.each(["booked", "moveRow", "unknown"])(
    "fails the call closed for a part whose choice may book a time (stakes %s) until the walk names its saved times",
    async (reason) => {
      const request = withStakes(exchangeRequest(LIMIT_5_FIXTURE), [reason]);
      const error: unknown = await limit5
        .check(partOf(request), turnOf(request))
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(Limit5NotBuiltError);
      expect(error).toBeInstanceOf(NotBuiltError);
      expect(error).toMatchObject({ call: "gateAndCommit", port: "bookedTimes" });
      expect((error as Error).message).toBe("gateAndCommit: limit 5's bookedTimes read is not built yet");
      const [one, two, three, four, , six] = scriptedLimits();
      await expect(
        runGate(request, callContext(BARBERSHOP), [one, two, three, four, limit5, six]),
      ).rejects.toBeInstanceOf(Limit5NotBuiltError);
    },
  );

  it("lets a part that books no time through as notChecked, reading nothing", async () => {
    const request = exchangeRequest(LIMIT_5_FIXTURE);
    expect(await limit5.check(partOf(request), turnOf(request))).toEqual({ result: "notChecked" });
  });

  it("reads saved times only through the call's database transaction", async () => {
    const request = exchangeRequest(LIMIT_5_FIXTURE);
    const limit = createLimit5({ bookedTimes: walkOf({ [FIXTURE_TURN]: [TWO_PM.id] }) });
    await expect(limit.decide(partOf(request), turnOf(request))).rejects.toThrow(
      "limit 5 reads through the call's database transaction",
    );
  });

  it("asks for the next open times only through C-131's port: not built, a failing part fails the call closed", async () => {
    const request = exchangeRequest(LIMIT_5_FIXTURE);
    const limit = createLimit5({
      bookedTimes: walkOf({ [FIXTURE_TURN]: [TWO_PM.id] }),
      reservations: () => readerOf([TWO_PM]),
    });
    await expect(limit.decide(partOf(request), turnOf(request))).rejects.toMatchObject({
      name: "Limit5NotBuiltError",
      port: "openTimes",
    });
    // A part whose saved time holds needs no open times.
    const holding = createLimit5({
      bookedTimes: walkOf({ [FIXTURE_TURN]: [TWO_PM.id] }),
      reservations: () => readerOf([TWO_PM_HELD]),
      openTimes: finderOf([]),
    });
    expect(await holding.check(partOf(request), turnOf(request))).toEqual({ result: "pass" });
  });
});
