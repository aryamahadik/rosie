// T-302's proofs (the card's "Proves it with"), on the contracts' own fixtures and the master's own read-backs, with
// doubles standing in for limit 4's ports, for limits 1 to 3, 5 and 6, for the commit's other ports and for K-05 v1's
// commitTurn (a fake with its compare-and-set), never for limit 4 or the commit:
//   - commit-version-changed.json and commit-limit-4-changed.json give their outcomes;
//   - concurrency: two turns committing on one booking version against the K-05 fake: exactly one commits, the other gets
//     today's facts and a fresh yes;
//   - a second conflict on the same open question opens a review item instead of a third try.
// Also: what limit 4 compares and sends with the commit; nothing shown changed commits; the K-09 gate fixtures that reach
// limit 4 come out as they state; what it returns holds no person's words; the shipped limit sits in slot 4 and reads
// only through the call's database.

import { describe, expect, it } from "vitest";

import { gateAndCommit } from "../../commit/commit";
import { noWrites } from "../../commit/test-support";
import type {
  Committed,
  CommitTurnRequest,
  CoreRun,
  GateAndCommitAnswer,
  PartResult,
} from "../../commit/types";
import { stringsIn } from "../../tool-api/test-support";
import {
  LIMIT_ACTIONS,
  LimitNotBuiltError,
  partResultOf,
  runGate,
  type DecideResult,
  type GatePart,
  type GateRequest,
  type GateVerdict,
  type GatedPart,
  type LimitOutcome,
} from "../framework";
import {
  DECIDED_GATE_FIXTURES,
  callContext,
  fixtureScript,
  gateExchange,
  gateRequest,
  modelFixture,
  twoRequests,
  wordsIn,
  type LimitCall,
} from "../framework/test-support";
import { LIMITS } from "../limits";
import type { AskedQuestion, RowRef } from "../limit-3/facts";
import {
  ALEX,
  BARBERSHOP,
  BEARD_TRIM_QUESTION,
  BEARD_TRIM_READ_BACK,
  CALL_OFF_READ_BACK,
  HAIRCUT,
  SAM,
  TEAM_READ_BACK,
  callOffRequest,
  callOffRow,
  decidedIn,
  exchangeRequest,
  offChat,
  partOf,
  rowFor,
  turnOf,
} from "../limit-3/test-support";
import {
  ASKS_BEFORE_PERSON,
  RESERVED_TABLES,
  compareAndSetOf,
  freshYesOutcome,
  limit4,
  saidWhatChangedOutcome,
  toPersonOutcome,
  type VersionsDecision,
} from "./index";
import {
  AVERY_LICENSE,
  CANCEL_QUESTION,
  CANCEL_READ_BACK,
  LIMIT_4_FIXTURE,
  MOVE_READ_BACK,
  RILEY_LICENSE,
  S2_22,
  SEEDED_VERSION,
  barrier,
  bookingRow,
  cancelRequest,
  cancelRow,
  cancelWrites,
  counted,
  depsFor,
  freshTrimRequest,
  freshTrimRow,
  headWrites,
  limitIn,
  moveRequest,
  moveRow,
  plainRow,
  registryWith,
  rowOf,
  teamRow,
  trimRequest,
  trimRow,
  versionChangedExchange,
  versionsFake,
  withoutLimit4,
  type Ran,
  type TodayReads,
  type VersionsFake,
  type World,
} from "./test-support";

/** What a fixture or scenario must hold for a test to read it. */
function missing(): never {
  throw new Error("the fixture lacks what the test reads");
}

/** The parts of a gated verdict; fails the test for a refused one. */
function gatedParts(verdict: GateVerdict): readonly GatedPart[] {
  if (verdict.verdict !== "gated") throw new Error(`refused: ${JSON.stringify(verdict.error)}`);
  return verdict.parts;
}

/** A K-09 exchange's committed outcome; fails the test for any other. */
function statedCommit(file: string): Committed {
  const { outcome } = gateExchange(file);
  if ("error" in outcome || outcome.result !== "committed") throw new Error(`${file} is not committed`);
  return outcome;
}

/** A gateAndCommit answer that committed; fails the test for any other. */
function committed(answer: GateAndCommitAnswer): Committed {
  if ("error" in answer || answer.result !== "committed") {
    throw new Error(`not committed: ${JSON.stringify(answer)}`);
  }
  return answer;
}

/** The one part a turn answers, stopped by limit 4 with `outcome` after limits 1 to 3 passed. */
function stoppedBy(choiceId: string, outcome: LimitOutcome): PartResult {
  return {
    part: 0,
    choiceId,
    result: "stopped",
    limits: [
      { limit: 1, result: "pass", outcome: null },
      { limit: 2, result: "pass", outcome: null },
      { limit: 3, result: "pass", outcome: null },
      { limit: 4, result: "fail", outcome: outcome.action },
      { limit: 5, result: "notChecked", outcome: null },
      { limit: 6, result: "notChecked", outcome: null },
    ],
    stoppedBy: outcome,
    gives: [],
    dependsOnPart: null,
  };
}

/** Limit 4's decision on the one part of `request`, in `world` as it stands. */
function decisionOf(world: World, request: GateRequest): Promise<VersionsDecision> {
  return limitIn(world).decide(partOf(request), turnOf(request));
}

/** The gate and commit for one turn, inside the barbershop's scope. */
function gateAndCommitOf(request: GateRequest, ran: Ran): Promise<GateAndCommitAnswer> {
  return gateAndCommit(request, callContext(BARBERSHOP), ran.deps);
}

/** The requests K-05 got for one turn. */
function requestsOf(fake: VersionsFake, turnId: string): CommitTurnRequest[] {
  return fake.requests.filter((request) => request.turn.id === turnId);
}

/** The commits that wrote Alex's haircut. */
function haircutCommits(fake: VersionsFake): string[] {
  return fake.commits
    .filter((each) => each.written.some((row) => row.table === "bookings" && row.rowId === HAIRCUT))
    .map((each) => each.turnId);
}

const haircutAt = (version: number): RowRef => ({ table: "bookings", rowId: HAIRCUT, version });
const moved = (from: number, to: number | null) => ({
  table: "bookings",
  rowId: HAIRCUT,
  readVersion: from,
  currentVersion: to,
});

describe("commit-limit-4-changed.json gives its outcome", () => {
  /** S2-22's world: Riley's license as shown, Avery's moved to 2 after the question went out. */
  function teamWorld(
    request: GateRequest,
    now?: string,
  ): { world: World; fake: VersionsFake; reads: TodayReads } {
    const fake = versionsFake(now === undefined ? {} : { now });
    fake.seed([plainRow(RILEY_LICENSE), plainRow({ ...AVERY_LICENSE, version: 2 })]);
    const reads: TodayReads = { versions: [], bookings: [] };
    return { world: { questions: [teamRow(request)], today: counted(fake.today, reads) }, fake, reads };
  }

  it("Sam's '1' to S2-22 after Avery's license moved: limit 4 reloads, the change is still possible, so today's facts and a fresh yes; the part is as the fixture states", async () => {
    const request = exchangeRequest(LIMIT_4_FIXTURE);
    const { world, reads } = teamWorld(request);
    const calls: LimitCall[] = [];
    const call = callContext(BARBERSHOP);
    const script = withoutLimit4(fixtureScript(gateExchange(LIMIT_4_FIXTURE)));
    const parts = gatedParts(await runGate(request, call, registryWith(limitIn(world), script, calls)));
    const stated = statedCommit(LIMIT_4_FIXTURE).parts;
    expect(parts.map((part) => partResultOf(part))).toEqual(stated);
    expect(stated[0]?.stoppedBy).toEqual(freshYesOutcome());
    expect(calls).toEqual([
      { limit: 1, part: 0 },
      { limit: 2, part: 0 },
      { limit: 3, part: 0 },
      { limit: 4, part: 0 },
    ]);
    expect(call.span.limits).toEqual(stated[0]?.limits);
    expect(reads.versions).toEqual([[RILEY_LICENSE, AVERY_LICENSE]]);
    expect(await decisionOf(world, request)).toEqual({
      result: "fail",
      outcome: freshYesOutcome(),
      next: {
        kind: "freshYes",
        openQuestionId: S2_22,
        step: "S2-22",
        bookingId: null,
        askCount: 2,
        changed: [{ table: "documents", rowId: AVERY_LICENSE.rowId, readVersion: 1, currentVersion: 2 }],
        versionsToday: [RILEY_LICENSE, { ...AVERY_LICENSE, version: 2 }],
      },
    });
  });

  it("through the gate and commit against the K-05 fake: the turn commits as the fixture states, its part stopped and nothing of it written", async () => {
    const request = exchangeRequest(LIMIT_4_FIXTURE);
    const stated = statedCommit(LIMIT_4_FIXTURE);
    const { world, fake } = teamWorld(request, stated.committedAt);
    const [safety] = stated.core;
    if (safety === undefined) missing();
    const core: CoreRun = { result: safety, writes: noWrites({ step: "A3-22", choice: null }) };
    const ran = depsFor(world, fake, () => missing(), [core]);
    const answer = committed(await gateAndCommit(request, callContext(BARBERSHOP), ran.deps));
    // The fresh yes's question and outbox row are the commit's outcome writer's (T-305 default 8), not limit 4's.
    expect({ ...answer, written: null, openQuestions: null }).toEqual({
      ...stated,
      written: null,
      openQuestions: null,
    });
    expect(ran.calls.writesOf).toEqual([]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.versionsRead).toEqual([]);
    expect(fake.requests[0]?.writes.state).toEqual([]);
  });
});

describe("commit-version-changed.json gives its outcome", () => {
  it("the K-05 fake answers the fixture as it states: Alex's haircut read at 6, now 7, refuses the commit with the row that changed", async () => {
    const { request, outcome } = versionChangedExchange();
    const fake = versionsFake();
    fake.seed([bookingRow(HAIRCUT, 7)]);
    expect(await fake.commitTurn(request, callContext(BARBERSHOP))).toEqual(outcome);
    expect(fake.commits).toEqual([]);
    expect(rowOf(fake, "bookings", HAIRCUT)).toEqual(bookingRow(HAIRCUT, 7));
  });

  /**
   * Alex's cancel from A7-05's read-back of his haircut at 6: the gate passes, then another chat's commit lands before
   * his (raising the haircut to 7, giving it `stage` when named), so K-05 refuses the commit.
   */
  async function cancelRacedBy(stage?: "cancelled") {
    const request = cancelRequest();
    const fake = versionsFake();
    fake.seed([bookingRow(HAIRCUT, 6)]);
    fake.beforeCommit = () => {
      fake.beforeCommit = null;
      fake.commitElsewhere("bookings", HAIRCUT, stage);
    };
    const world: World = { questions: [cancelRow()], today: fake.today };
    const ran = depsFor(world, fake, (part) => cancelWrites(part.choice, cancelRow()));
    const answer = committed(await gateAndCommitOf(request, ran));
    return { request, fake, world, ran, answer };
  }

  it("Alex's cancel: K-05 refuses the fixture's request as it states; the gate reloads once, the change is still possible: today's facts and a fresh yes, never an error", async () => {
    const { request: sent, outcome } = versionChangedExchange();
    const { request, fake, world, ran, answer } = await cancelRacedBy();
    expect(fake.requests[0]).toEqual(sent);
    expect(fake.answers[0]).toEqual(outcome);
    // Reloaded once: the second run stops the part, so nothing of it is compared or written, and K-05 commits the turn.
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]?.versionsRead).toEqual([]);
    expect(fake.requests[1]?.writes.state).toEqual([]);
    expect(ran.calls.writesOf).toEqual([0]);
    expect(answer.parts).toEqual([stoppedBy("A7-05/2", freshYesOutcome())]);
    expect(rowOf(fake, "bookings", HAIRCUT)).toEqual(bookingRow(HAIRCUT, 7));
    expect(await decisionOf(world, request)).toEqual({
      result: "fail",
      outcome: freshYesOutcome(),
      next: {
        kind: "freshYes",
        openQuestionId: CANCEL_QUESTION,
        step: "A7-05",
        bookingId: HAIRCUT,
        askCount: 2,
        changed: [moved(6, 7)],
        versionsToday: [haircutAt(7)],
      },
    });
  });

  it("the other chat cancelled it: no longer possible, so limit 4 says what changed and offers the current choices", async () => {
    const { request, fake, world, answer } = await cancelRacedBy("cancelled");
    expect(fake.answers[0]).toEqual(versionChangedExchange().outcome);
    expect(answer.parts).toEqual([stoppedBy("A7-05/2", saidWhatChangedOutcome())]);
    expect(await decisionOf(world, request)).toEqual({
      result: "fail",
      outcome: saidWhatChangedOutcome(),
      next: {
        kind: "saidWhatChanged",
        openQuestionId: CANCEL_QUESTION,
        step: "A7-05",
        bookingId: HAIRCUT,
        why: "bookingClosed",
        changed: [moved(6, 7)],
      },
    });
  });

  it("a conflict on a row the read-back never showed: on the reload nothing shown changed, so the part commits", async () => {
    const request = cancelRequest();
    const fake = versionsFake();
    const riley: RowRef = { table: "persons", rowId: "person-riley", version: 1 };
    fake.seed([bookingRow(HAIRCUT, 6), plainRow(riley)]);
    fake.beforeCommit = () => {
      fake.beforeCommit = null;
      fake.commitElsewhere("persons", riley.rowId);
    };
    const world: World = { questions: [cancelRow()], today: fake.today };
    // The walk also reads Riley's person row (who serves the visit), at its version when the walk runs.
    const ran = depsFor(world, fake, (part) => {
      const now = rowOf(fake, "persons", riley.rowId) ?? missing();
      const writes = cancelWrites(part.choice, cancelRow());
      return { ...writes, versionsRead: [...writes.versionsRead, { ...riley, version: now.version }] };
    });
    const answer = committed(await gateAndCommitOf(request, ran));
    expect(fake.answers[0]).toEqual({
      error: "versionChanged",
      changed: [{ table: "persons", rowId: riley.rowId, readVersion: 1, currentVersion: 2 }],
    });
    expect(fake.requests[1]?.versionsRead).toEqual([haircutAt(6), { ...riley, version: 2 }]);
    expect(answer.parts[0]?.result).toBe("committed");
    expect(answer.parts[0]?.limits[3]).toEqual({ limit: 4, result: "pass", outcome: null });
    expect(ran.calls.writesOf).toEqual([0, 0]);
    expect(rowOf(fake, "bookings", HAIRCUT)).toEqual(bookingRow(HAIRCUT, 7, "cancelled"));
  });
});

describe("concurrency: two turns committing on one booking version, against the K-05 fake", () => {
  type Order = "Alex first" | "Sam first" | "at once";
  const ORDERS: readonly Order[] = ["Alex first", "Sam first", "at once"];

  interface Turn {
    readonly request: GateRequest;
    readonly row: AskedQuestion;
    readonly set: Readonly<Record<string, unknown>>;
  }

  /** Alex's beard trim (A7-31) and `sam`'s turn, both from read-backs of the haircut at 7, run in `order`. */
  async function race(order: Order, sam: Turn) {
    const alex: Turn = { request: trimRequest(), row: trimRow(), set: { stage: "booked" } };
    const fake = versionsFake();
    fake.seed([bookingRow(HAIRCUT, SEEDED_VERSION)]);
    const world: World = { questions: [alex.row, sam.row], today: fake.today };
    const deps = (turn: Turn): Ran =>
      depsFor(world, fake, (part) => headWrites(part.choice, turn.row, turn.set));
    const run = (turn: Turn) => gateAndCommitOf(turn.request, deps(turn)).then(committed);
    if (order === "at once") {
      // Both pass the gate and build their writes before either reaches K-05; then they commit one after the other.
      const both = barrier(2);
      const firstTry = new Set<string>();
      fake.beforeCommit = (request) => {
        if (firstTry.has(request.turn.id)) return;
        firstTry.add(request.turn.id);
        return both();
      };
      const [alexAnswer, samAnswer] = await Promise.all([run(alex), run(sam)]);
      return { fake, world, alex, sam, alexAnswer, samAnswer };
    }
    if (order === "Alex first") {
      const alexAnswer = await run(alex);
      return { fake, world, alex, sam, alexAnswer, samAnswer: await run(sam) };
    }
    const samAnswer = await run(sam);
    return { fake, world, alex, sam, alexAnswer: await run(alex), samAnswer };
  }

  const samMoves = (): Turn => ({ request: moveRequest(), row: moveRow(), set: { stage: "booked" } });

  it.each(ORDERS)(
    "%s: Alex's trim and Sam's move on the haircut at 7: exactly one commits, the other gets today's facts and a fresh yes",
    async (order) => {
      const raced = await race(order, samMoves());
      const { fake, world } = raced;
      const turns = [
        { turn: raced.alex, answer: raced.alexAnswer, choiceId: "A7-31/1" },
        { turn: raced.sam, answer: raced.samAnswer, choiceId: "A7-23/1" },
      ];
      const winners = turns.filter((each) => each.answer.parts[0]?.result === "committed");
      const losers = turns.filter((each) => each.answer.parts[0]?.result !== "committed");
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const [winner] = winners;
      const [loser] = losers;
      if (winner === undefined || loser === undefined) missing();
      if (order !== "at once") expect(winner.turn).toBe(order === "Alex first" ? raced.alex : raced.sam);
      expect(haircutCommits(fake)).toEqual([winner.answer.turnId]);
      expect(rowOf(fake, "bookings", HAIRCUT)).toEqual(bookingRow(HAIRCUT, SEEDED_VERSION + 1));
      expect(loser.answer.parts).toEqual([stoppedBy(loser.choiceId, freshYesOutcome())]);
      // At once, the loser's commit is refused and gated again; one after the other, its gate already sees the change.
      expect(requestsOf(fake, loser.answer.turnId)).toHaveLength(order === "at once" ? 2 : 1);
      expect(requestsOf(fake, winner.answer.turnId)).toHaveLength(1);
      const loserRow = loser.turn.row;
      expect(await decisionOf(world, loser.turn.request)).toEqual({
        result: "fail",
        outcome: freshYesOutcome(),
        next: {
          kind: "freshYes",
          openQuestionId: loserRow.openQuestionId,
          step: loserRow.step,
          bookingId: HAIRCUT,
          askCount: 2,
          changed: [moved(SEEDED_VERSION, SEEDED_VERSION + 1)],
          versionsToday: [haircutAt(SEEDED_VERSION + 1)],
        },
      });
    },
  );

  it("each passed part sends the versions its read-back showed, so K-05 compares and sets them", async () => {
    const { fake, alex, alexAnswer } = await race("Alex first", samMoves());
    const [first] = requestsOf(fake, alexAnswer.turnId);
    expect(first?.versionsRead).toEqual(compareAndSetOf(alex.row));
    expect(first?.versionsRead).toEqual([haircutAt(SEEDED_VERSION)]);
  });

  it("Sam's call-off lands between Alex's gate and his commit: the trim is no longer possible, and limit 4 says what changed", async () => {
    const alex = { request: trimRequest(), row: trimRow() };
    const sam = { request: callOffRequest(SAM, "owner", "1"), row: callOffRow(SAM) };
    const fake = versionsFake();
    fake.seed([bookingRow(HAIRCUT, SEEDED_VERSION)]);
    const world: World = { questions: [alex.row, sam.row], today: fake.today };
    const samRan = depsFor(world, fake, (part) => headWrites(part.choice, sam.row, { stage: "cancelled" }));
    const alexRan = depsFor(world, fake, (part) => headWrites(part.choice, alex.row, { stage: "booked" }));
    const alexTurn = decidedIn(alex.request).context.turnId;
    let samAnswer: Committed | null = null;
    fake.beforeCommit = async (request) => {
      if (request.turn.id !== alexTurn || samAnswer !== null) return;
      samAnswer = committed(await gateAndCommitOf(sam.request, samRan));
    };
    const alexAnswer = committed(await gateAndCommitOf(alex.request, alexRan));
    expect(samAnswer).not.toBeNull();
    expect(haircutCommits(fake)).toEqual([decidedIn(sam.request).context.turnId]);
    expect(rowOf(fake, "bookings", HAIRCUT)).toEqual(bookingRow(HAIRCUT, SEEDED_VERSION + 1, "cancelled"));
    expect(alexAnswer.parts).toEqual([stoppedBy("A7-31/1", saidWhatChangedOutcome())]);
    expect(requestsOf(fake, alexTurn)).toHaveLength(2);
    expect(await decisionOf(world, alex.request)).toEqual({
      result: "fail",
      outcome: saidWhatChangedOutcome(),
      next: {
        kind: "saidWhatChanged",
        openQuestionId: BEARD_TRIM_QUESTION,
        step: "A7-31",
        bookingId: HAIRCUT,
        why: "bookingClosed",
        changed: [moved(SEEDED_VERSION, SEEDED_VERSION + 1)],
      },
    });
  });
});

describe("a second conflict on one question opens a review item, never a third try", () => {
  it("Alex's trim conflicts twice: a fresh yes the first time, then a person; K-05 is asked at most twice a turn", async () => {
    const fake = versionsFake();
    fake.seed([bookingRow(HAIRCUT, SEEDED_VERSION)]);
    const world: World = { questions: [trimRow()], today: fake.today };
    /** Another chat's change lands between the turn's gate and its commit, once. */
    const raceOnce = (): void => {
      fake.beforeCommit = () => {
        fake.beforeCommit = null;
        fake.commitElsewhere("bookings", HAIRCUT);
      };
    };

    // The first conflict: today's facts and a fresh yes.
    raceOnce();
    const first = committed(
      await gateAndCommitOf(
        trimRequest(),
        depsFor(world, fake, (part) => headWrites(part.choice, trimRow(), { stage: "booked" })),
      ),
    );
    expect(first.parts).toEqual([stoppedBy("A7-31/1", freshYesOutcome())]);
    const fresh = await decisionOf(world, trimRequest());
    if (fresh.result !== "fail" || fresh.next.kind !== "freshYes")
      throw new Error("the first conflict asks again");
    // The commit's outcome writer asks the same question again from today's versions (T-305 default 8).
    const again = freshTrimRow();
    expect({ askCount: again.askCount, versionsRead: again.versionsRead }).toEqual({
      askCount: fresh.next.askCount,
      versionsRead: fresh.next.versionsToday,
    });
    world.questions.splice(0, world.questions.length, again);

    // The second conflict on the same question: a person, with a review item.
    raceOnce();
    const second = committed(
      await gateAndCommitOf(
        freshTrimRequest(),
        depsFor(world, fake, (part) => headWrites(part.choice, again, { stage: "booked" })),
      ),
    );
    expect(second.parts).toEqual([stoppedBy("A7-31/1", toPersonOutcome())]);
    expect(fake.answers.filter((answer) => "error" in answer)).toEqual([
      { error: "versionChanged", changed: [moved(SEEDED_VERSION, SEEDED_VERSION + 1)] },
      { error: "versionChanged", changed: [moved(SEEDED_VERSION + 1, SEEDED_VERSION + 2)] },
    ]);
    expect(requestsOf(fake, first.turnId)).toHaveLength(2);
    expect(requestsOf(fake, second.turnId)).toHaveLength(2);
    expect(haircutCommits(fake)).toEqual([]);
    expect(await decisionOf(world, freshTrimRequest())).toEqual({
      result: "fail",
      outcome: toPersonOutcome(),
      next: {
        kind: "toPerson",
        openQuestionId: BEARD_TRIM_QUESTION,
        step: "A7-31",
        bookingId: HAIRCUT,
        changed: [moved(SEEDED_VERSION + 1, SEEDED_VERSION + 2)],
        review: {
          subject: { table: "open_questions", rowId: BEARD_TRIM_QUESTION },
          businessId: BARBERSHOP,
          bookingId: HAIRCUT,
          step: "A7-31",
        },
      },
    });
  });

  it("a person whenever the question was asked again, by its row's count or the context's, even when no longer possible", async () => {
    const fake = versionsFake();
    fake.seed([bookingRow(HAIRCUT, SEEDED_VERSION + 1, "cancelled")]);
    const byRow: World = { questions: [trimRow({ askCount: ASKS_BEFORE_PERSON })], today: fake.today };
    const byContext: World = { questions: [trimRow()], today: fake.today };
    const askedTwice = trimRequest();
    const question = decidedIn(askedTwice).context.openQuestions[0] ?? missing();
    question.askCount = ASKS_BEFORE_PERSON;
    for (const [world, request] of [
      [byRow, trimRequest()],
      [byContext, askedTwice],
    ] as const) {
      const decision = await decisionOf(world, request);
      expect(decision.result === "fail" ? decision.next.kind : decision.result).toBe("toPerson");
    }
  });
});

describe("what limit 4 compares", () => {
  it("nothing shown changed: pass, with the rows to compare and set as shown, read once each", async () => {
    const fake = versionsFake();
    fake.seed([bookingRow(HAIRCUT, SEEDED_VERSION)]);
    const reads: TodayReads = { versions: [], bookings: [] };
    const doubled = trimRow({ versionsRead: [haircutAt(SEEDED_VERSION), haircutAt(SEEDED_VERSION)] });
    const world: World = { questions: [doubled], today: counted(fake.today, reads) };
    expect(await decisionOf(world, trimRequest())).toEqual({
      result: "pass",
      compareAndSet: [haircutAt(SEEDED_VERSION)],
    });
    expect(reads).toEqual({ versions: [[haircutAt(SEEDED_VERSION)]], bookings: [] });
  });

  const others = DECIDED_GATE_FIXTURES.filter((file) => file !== LIMIT_4_FIXTURE);

  it.each(others)(
    "%s: with the real limit 4 in its slot, every part comes out as the fixture states",
    async (file) => {
      const exchange = gateExchange(file);
      const request = exchangeRequest(file);
      const rows = decidedIn(request).context.openQuestions.map((question) =>
        rowFor(request, question.openQuestionId, { readback: null }),
      );
      const world: World = { questions: rows, today: versionsFake().today };
      const verdict = await runGate(
        request,
        callContext(request.caller.businessId ?? BARBERSHOP),
        registryWith(limitIn(world), withoutLimit4(fixtureScript(exchange))),
      );
      const { outcome } = exchange;
      if ("error" in outcome) {
        expect(verdict).toEqual({ verdict: "refused", error: outcome });
        return;
      }
      const stated = statedCommit(file).parts;
      expect(
        gatedParts(verdict).map((part, index) => partResultOf(part, stated[index]?.gives ?? [])),
      ).toEqual(stated);
    },
  );

  it("reservations and class seats are limit 5's: a saved time that moved is never compared here, nor sent", async () => {
    expect(RESERVED_TABLES).toEqual(["reservations", "class_seats"]);
    const hold: RowRef = { table: "reservations", rowId: "rsv-alex-saved-avery", version: 1 };
    const fake = versionsFake();
    fake.seed([bookingRow(HAIRCUT, SEEDED_VERSION), plainRow({ ...hold, version: 2 })]);
    const reads: TodayReads = { versions: [], bookings: [] };
    const row = trimRow({ versionsRead: [haircutAt(SEEDED_VERSION), hold] });
    const world: World = { questions: [row], today: counted(fake.today, reads) };
    expect(await decisionOf(world, trimRequest())).toEqual({
      result: "pass",
      compareAndSet: [haircutAt(SEEDED_VERSION)],
    });
    expect(reads.versions).toEqual([[haircutAt(SEEDED_VERSION)]]);
    expect(compareAndSetOf(row)).toEqual([haircutAt(SEEDED_VERSION)]);
  });

  it("a row the read-back showed is gone: no longer possible", async () => {
    const request = exchangeRequest(LIMIT_4_FIXTURE);
    const fake = versionsFake();
    fake.seed([plainRow(RILEY_LICENSE)]);
    const world: World = { questions: [teamRow(request)], today: fake.today };
    expect(await decisionOf(world, request)).toEqual({
      result: "fail",
      outcome: saidWhatChangedOutcome(),
      next: {
        kind: "saidWhatChanged",
        openQuestionId: S2_22,
        step: "S2-22",
        bookingId: null,
        why: "rowGone",
        changed: [{ table: "documents", rowId: AVERY_LICENSE.rowId, readVersion: 1, currentVersion: null }],
      },
    });
  });

  it("the part's booking can no longer be read: no longer possible", async () => {
    const fake = versionsFake();
    fake.seed([plainRow(haircutAt(SEEDED_VERSION + 1))]);
    const world: World = { questions: [trimRow()], today: fake.today };
    const decision = await decisionOf(world, trimRequest());
    expect(
      decision.result === "fail" && decision.next.kind === "saidWhatChanged" ? decision.next.why : null,
    ).toBe("rowGone");
  });

  it("the question is no longer live on the turn's handle: no longer possible, and nothing else is read", async () => {
    const reads: TodayReads = { versions: [], bookings: [] };
    const elsewhere = cancelRow();
    const worlds: World[] = [
      { questions: [], today: counted(versionsFake().today, reads) },
      { questions: [{ ...elsewhere, handleId: SAM.handleId }], today: counted(versionsFake().today, reads) },
    ];
    for (const world of worlds) {
      expect(await decisionOf(world, cancelRequest())).toEqual({
        result: "fail",
        outcome: saidWhatChangedOutcome(),
        next: {
          kind: "saidWhatChanged",
          openQuestionId: CANCEL_QUESTION,
          step: "A7-05",
          bookingId: HAIRCUT,
          why: "questionClosed",
          changed: [],
        },
      });
    }
    expect(reads).toEqual({ versions: [], bookings: [] });
  });

  it("a part shown no read-back is not checked, and nothing is read: pass_on, hand_off and the owner hub's cases", async () => {
    const reads: TodayReads = { versions: [], bookings: [] };
    const world: World = { questions: [], today: counted(versionsFake().today, reads) };
    const turn = turnOf(trimRequest());
    for (const file of ["decide-pass-on.json", "decide-hand-off.json"]) {
      const said = (modelFixture(file) as DecideResult).parts[0].part;
      if (said.verb !== "pass_on" && said.verb !== "hand_off")
        throw new Error(`${file} has no pass_on or hand_off`);
      const part: GatePart = { index: 0, part: said, choice: null };
      expect(await limitIn(world).decide(part, turn)).toEqual({ result: "notChecked" });
    }
    const hubs = gateRequest(twoRequests());
    const verdict = await runGate(hubs, callContext(), registryWith(limitIn(world)));
    for (const part of gatedParts(verdict)) {
      expect(part.limits[3]).toEqual({ limit: 4, result: "notChecked", outcome: null });
    }
    expect(reads).toEqual({ versions: [], bookings: [] });
  });

  it("a call with no turn (a secure page, an own AI) is not built yet: the gate refuses the whole call", async () => {
    const fake = versionsFake();
    fake.seed([bookingRow(HAIRCUT, SEEDED_VERSION)]);
    const world: World = { questions: [trimRow()], today: fake.today };
    for (const kind of ["page", "agent"] as const) {
      const request = offChat(trimRequest(), kind, ALEX.personId);
      expect(await decisionOf(world, request)).toEqual({ result: "notBuilt" });
      await expect(runGate(request, callContext(BARBERSHOP), registryWith(limitIn(world)))).rejects.toThrow(
        LimitNotBuiltError,
      );
    }
  });
});

describe("what limit 4 returns holds no person's words", () => {
  it("decisions and verdicts name labels, steps, tables, ids and versions: no text, read-back, name or phone number", async () => {
    const fake = versionsFake();
    fake.seed([bookingRow(HAIRCUT, SEEDED_VERSION + 1)]);
    const licenses = versionsFake();
    licenses.seed([plainRow(RILEY_LICENSE), plainRow({ ...AVERY_LICENSE, version: 2 })]);
    const team = exchangeRequest(LIMIT_4_FIXTURE);
    const cases: [World, GateRequest][] = [
      [{ questions: [trimRow()], today: fake.today }, trimRequest()],
      [{ questions: [trimRow({ askCount: ASKS_BEFORE_PERSON })], today: fake.today }, trimRequest()],
      [{ questions: [moveRow()], today: fake.today }, moveRequest()],
      [{ questions: [teamRow(team)], today: licenses.today }, team],
      [{ questions: [], today: fake.today }, cancelRequest()],
    ];
    const forbidden = [
      BEARD_TRIM_READ_BACK,
      MOVE_READ_BACK,
      CANCEL_READ_BACK,
      CALL_OFF_READ_BACK,
      TEAM_READ_BACK,
    ];
    for (const [world, request] of cases) {
      const decided = decidedIn(request);
      const people = decided.context.writer.people.map((person) => person.name);
      const words = [...wordsIn(decided), ...people, decided.context.writer.handle, ...forbidden];
      const decision = await decisionOf(world, request);
      const verdict = await limitIn(world).check(partOf(request), turnOf(request));
      const strings = [...stringsIn(decision), ...stringsIn(verdict)];
      for (const word of words) expect(strings).not.toContain(word);
      expect(decision.result).not.toBe("pass");
    }
  });
});

describe("the shipped limit 4", () => {
  it("is slot 4 of the gate's registry, in place of the fail-closed stub", () => {
    expect(LIMITS[3]).toBe(limit4);
    expect(limit4.limit).toBe(4);
  });

  it("reads only through the call's database: with any other repo it throws, so the gate fails the call", async () => {
    const request = trimRequest();
    await expect(limit4.check(partOf(request), turnOf(request))).rejects.toThrow(
      "limit 4 reads through the call's database transaction",
    );
  });

  it("answers only K-09 v1's limit 4 outcomes, each with the kind its action has (the gate's checkOutcome)", () => {
    const kinds: Readonly<Record<string, string>> = LIMIT_ACTIONS[4];
    for (const outcome of [freshYesOutcome(), saidWhatChangedOutcome(), toPersonOutcome()]) {
      expect(outcome.limit).toBe(4);
      expect(kinds[outcome.action]).toBe(outcome.outcome);
    }
    expect(Object.keys(kinds).sort()).toEqual(["freshYes", "saidWhatChanged", "toPerson"]);
  });
});
