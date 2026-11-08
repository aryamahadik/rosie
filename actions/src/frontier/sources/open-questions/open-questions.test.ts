// T-291's proofs for the open-questions source (arch 03 line 159: "every one sent to this handle ... Questions about
// other bookings add only their options, labeled by business, date and time"), through buildFrontier on the Tool API
// base: two open questions on two bookings give each option labeled with its business, date and time; an open question
// that cannot be offered is left out and logged, never guessed; each option's stakes come from its walk.
// The asked step is A6-02 ("Texts Sam the request") as K-01 v1's bundle-mini-a.json holds it; the bookings are the
// sample cast's (Alex M.'s haircut, K-04 v1 seed-booking-head.json and seed-reservation.json; Ben T.'s): rule 9.

import { describe, expect, it } from "vitest";

import { isLabel } from "../../../../../runtime/src/trace";
import { traceFor } from "../../../tool-api/test-support";
import { createToolApi } from "../../../tool-api/tool-api";
import { createToolApiValidator } from "../../../tool-api/validator";
import { createFrontierChecker } from "../../assemble/check";
import { frontierHandlers } from "../../assemble/handler";
import {
  BUNDLE_V0,
  MASTER_A6_01,
  MASTER_A6_03,
  MASTER_A6_10,
  bundleIdOf,
  captureLog,
  fakeBundles,
  fakeRepo,
  frontierScope,
  openQuestionRow,
  s102Exchange,
  samSeed,
  sampleBundle,
  stringsIn,
  withSteps,
  type BundleDocument,
  type FakeRepo,
  type TurnSeed,
} from "../../assemble/test-support";
import type { Choice, Context, OpenQuestionRow, Time } from "../../assemble/types";

type Json = Record<string, unknown>;

const validator = createToolApiValidator();
const checker = createFrontierChecker();

const MINI_A = sampleBundle("bundle-mini-a.json");
const MINI_A_ID = bundleIdOf(MINI_A);

const ALEX_VISIT: Time = { utc: "2026-10-24T15:00:00Z", zone: "America/New_York" };
const BEN_VISIT: Time = { utc: "2026-10-24T17:30:00Z", zone: "America/New_York" };

/** A6-02 asked of Sam about one booking request, under bundle-mini-a. */
function a602(
  id: string,
  bookingId: string,
  sentAt: string,
  more: Partial<OpenQuestionRow> = {},
): OpenQuestionRow {
  return openQuestionRow({
    id,
    step: "A6-02",
    bookingId,
    turnId: `turn-${bookingId}-request`,
    sentAt,
    bundleId: MINI_A_ID,
    ...more,
  });
}

const ALEX_Q = a602("oq-a6-02-alex", "booking-alex-haircut", "2026-10-22T15:02:00Z");
const BEN_Q = a602("oq-a6-02-ben", "booking-ben-haircut", "2026-10-22T16:40:00Z", { askCount: 2 });

/** Sam's state with the two requests open, each booking's visit read. */
function twoBookings(rows: OpenQuestionRow[] = [ALEX_Q, BEN_Q]): TurnSeed {
  return {
    ...samSeed(),
    openQuestions: rows,
    visits: { "booking-alex-haircut": ALEX_VISIT, "booking-ben-haircut": BEN_VISIT },
  };
}

/** Sam's text answering both, as the turn the guard listed: build-frontier-s1-02.json's request, pinned to mini-a. */
function request(openQuestionIds: string[], bundleId = MINI_A_ID): Json {
  const exchange = s102Exchange();
  const base = exchange.request;
  return {
    ...base,
    turn: { ...base.turn, bundleId },
    texts: [
      {
        eventId: "evt-sam-0001",
        kind: "text",
        words: "Accept Alex, and Ben's too",
        sentAt: { utc: "2026-10-22T17:00:00Z", zone: "America/New_York" },
        attachments: [],
        poll: null,
        tapback: null,
      },
    ],
    targets: {
      roles: [{ businessId: "biz-lees-barbershop", personId: "person-sam", role: "owner" }],
      openQuestionIds,
      bookingIds: ["booking-alex-haircut", "booking-ben-haircut"],
      noTarget: false,
    },
  };
}

async function callFrontier(
  body: Json,
  seed: TurnSeed,
  documents: BundleDocument[] = [MINI_A],
): Promise<{ context: Context; repo: FakeRepo; log: ReturnType<typeof captureLog> }> {
  const repo = fakeRepo(seed);
  const log = captureLog();
  const api = createToolApi({
    validator,
    scope: frontierScope(repo),
    handlers: frontierHandlers<FakeRepo>({ bundles: fakeBundles(...documents), log: log.sink, checker }),
  });
  const { trace } = traceFor(body);
  const answer = await api.call("buildFrontier", structuredClone(body), trace);
  if (!("context" in answer)) throw new Error(`no context: ${JSON.stringify(answer)}`);
  expect(checker.check("context", answer.context)).toEqual([]);
  return { context: answer.context, repo, log };
}

const A602_OPTIONS = [
  { label: "1 Accept", definition: "Sam accepts." },
  { label: "2 Another time", definition: "Sam offers another time, read back first." },
  { label: "3 Decline", definition: "Sam declined." },
];

/** The option A6-02's card defines, for one question and its target. */
function optionOf(index: number, question: string, target: Json, at: number): Json {
  const option = A602_OPTIONS[index];
  if (option === undefined) throw new Error("no such option");
  return {
    choiceId: `c-0${String(at)}`,
    kind: "option",
    question,
    branch: option.label,
    anytimeRow: null,
    door: null,
    hub: null,
    label: option.label,
    definition: option.definition,
    step: "A6-02",
    target,
    fields: [],
    stakes: "low",
    stakesFrom: [],
  };
}

describe("two open questions on two bookings: each option labeled with its business, date and time", () => {
  it("Sam's two A6-02 requests give six options, three per booking, each naming its booking's visit", async () => {
    const { context, repo } = await callFrontier(request([ALEX_Q.id, BEN_Q.id]), twoBookings());
    const alex = {
      businessId: "biz-lees-barbershop",
      businessName: "Lee's Barbershop",
      bookingId: "booking-alex-haircut",
      visitAt: ALEX_VISIT,
    };
    const ben = { ...alex, bookingId: "booking-ben-haircut", visitAt: BEN_VISIT };
    expect(context.choices).toEqual([
      optionOf(0, ALEX_Q.id, alex, 1),
      optionOf(1, ALEX_Q.id, alex, 2),
      optionOf(2, ALEX_Q.id, alex, 3),
      optionOf(0, BEN_Q.id, ben, 4),
      optionOf(1, BEN_Q.id, ben, 5),
      optionOf(2, BEN_Q.id, ben, 6),
    ]);
    // The same three labels twice: only the target (business, date and time) tells the two bookings' options apart.
    const told = new Set(
      context.choices.map((choice) => `${choice.label}|${choice.target.visitAt?.utc ?? ""}`),
    );
    expect(told.size).toBe(6);

    expect(context.openQuestions).toEqual([
      {
        openQuestionId: ALEX_Q.id,
        step: "A6-02",
        target: alex,
        sentAt: { utc: "2026-10-22T15:02:00Z", zone: "America/New_York" },
        pollId: null,
        askCount: 1,
      },
      {
        openQuestionId: BEN_Q.id,
        step: "A6-02",
        target: ben,
        sentAt: { utc: "2026-10-22T16:40:00Z", zone: "America/New_York" },
        pollId: null,
        askCount: 2,
      },
    ]);
    // One full card for the step both questions ask.
    expect(context.cards.map((card) => card.step)).toEqual(["A6-02"]);
    expect(context.cards[0]?.card.question).toBe("Sam replies?");
    // The visit times were read for exactly the two bookings, in the same transaction, under the call's business.
    expect(repo.calls.map((call) => [call.call, call.scope])).toEqual([
      ["readTurnState", "biz-lees-barbershop"],
      ["readVisitTimes", "biz-lees-barbershop"],
    ]);
    expect(repo.calls[1]?.request).toEqual({ bookingIds: ["booking-alex-haircut", "booking-ben-haircut"] });
  });

  it("only message branches enter: A6-02's clock branch, 'No answer in time', is never a choice (arch 03 line 161)", async () => {
    const { context } = await callFrontier(request([ALEX_Q.id, BEN_Q.id]), twoBookings());
    const step = (MINI_A.flows.A as { steps: Record<string, { branches: { label: string; tag: string }[] }> })
      .steps["A6-02"];
    expect(step?.branches.map((branch) => branch.tag)).toEqual(["message", "message", "message", "clock"]);
    expect(context.choices.some((choice) => choice.label === "No answer in time")).toBe(false);
  });

  it("a booking whose visit time is not read is not offered (no guess at its date): the other still is, and it is logged", async () => {
    const seed = twoBookings();
    seed.visits = { "booking-alex-haircut": ALEX_VISIT };
    const { context, log } = await callFrontier(request([ALEX_Q.id, BEN_Q.id]), seed);
    expect(context.choices.map((choice) => choice.target.bookingId)).toEqual([
      "booking-alex-haircut",
      "booking-alex-haircut",
      "booking-alex-haircut",
    ]);
    expect(context.openQuestions.map((question) => question.openQuestionId)).toEqual([ALEX_Q.id]);
    expect(log.lines.filter((line) => line.msg === "frontier_question_unlabelled")).toEqual([
      {
        level: "warn",
        msg: "frontier_question_unlabelled",
        trace_id: "trace-sam-0001",
        turn_id: "turn-s1-02-sam-kinds",
        open_question_id: BEN_Q.id,
        step: "A6-02",
        booking_id: "booking-ben-haircut",
      },
    ]);
  });
});

describe("an open question that cannot be offered is left out and logged, never guessed", () => {
  it("not sent yet (no part gone), its step not in its bundle, its bundle in no store: each logged by its ids", async () => {
    const rows = [
      ALEX_Q,
      a602("oq-a6-02-ben", "booking-ben-haircut", "2026-10-22T16:40:00Z", { sentAt: null }),
      openQuestionRow({ id: "oq-a7-03-sam", step: "A7-03", bundleId: MINI_A_ID }),
      openQuestionRow({ id: "oq-s1-02-old", step: "S1-02", bundleId: { hash: "f".repeat(64), build: 9 } }),
    ];
    const ids = rows.map((row) => row.id);
    const { context, log } = await callFrontier(request(ids), twoBookings(rows));
    expect(context.openQuestions.map((question) => question.openQuestionId)).toEqual([ALEX_Q.id]);
    expect(context.choices).toHaveLength(3);
    expect(log.lines.map((line) => [line.msg, line.open_question_id ?? null])).toEqual([
      ["frontier_question_not_sent", "oq-a6-02-ben"],
      ["frontier_step_missing", "oq-a7-03-sam"],
      ["frontier_bundle_missing", "oq-s1-02-old"],
      ["frontier_source_missing", null],
      ["frontier_source_missing", null],
      ["frontier_source_missing", null],
    ]);
    for (const line of log.lines) expect(stringsIn(line).every((value) => isLabel(value))).toBe(true);
  });

  it("an open question the guard listed at another business is not in this business's read: logged unread", async () => {
    const elsewhere = openQuestionRow({
      id: "oq-s1-02-home",
      step: "S1-02",
      businessId: "biz-lee-home-services",
    });
    const seed = twoBookings([ALEX_Q, elsewhere]);
    const { context, log } = await callFrontier(request([ALEX_Q.id, elsewhere.id]), seed);
    expect(context.openQuestions.map((question) => question.openQuestionId)).toEqual([ALEX_Q.id]);
    expect(log.lines[0]).toMatchObject({
      msg: "frontier_question_unread",
      open_question_id: "oq-s1-02-home",
    });
  });

  it("a question asked under an older bundle takes its step from that bundle, not the turn's pinned one", async () => {
    const older = openQuestionRow({ id: "oq-s1-02", step: "S1-02", bundleId: BUNDLE_V0 });
    const { context } = await callFrontier(request([ALEX_Q.id, older.id]), twoBookings([ALEX_Q, older]), [
      MINI_A,
      sampleBundle("bundle-v0-skeleton.json"),
    ]);
    // bundle-mini-a holds no S1-02; bundle v0, which the question was asked under, does.
    expect(
      context.choices.filter((choice) => choice.question === "oq-s1-02").map((choice) => choice.label),
    ).toEqual(["All on the list", "One isn't on the list yet", "Not a service we book"]);
    expect(context.cards.map((card) => card.step)).toEqual(["A6-02", "S1-02"]);
  });
});

/** bundle-mini-a with one more effect on A6-02's '1 Accept'. */
function withAcceptEffect(effect: Json, partial = true): BundleDocument {
  const document = structuredClone(MINI_A);
  document.manifest.partial = partial;
  const flow = document.flows.A as {
    steps: Record<string, { branches: { label: string; effects: Json[] }[] }>;
  };
  const accept = flow.steps["A6-02"]?.branches.find((branch) => branch.label === "1 Accept");
  if (accept === undefined) throw new Error("no '1 Accept'");
  accept.effects.push(effect);
  return document;
}

function stakesOf(choices: readonly Choice[]): [string, string, Choice["stakesFrom"]][] {
  return choices.map((choice) => [choice.choiceId, choice.stakes, choice.stakesFrom]);
}

describe("each option's stakes, from its walk (K-02 README, 'Stakes')", () => {
  it("bundle-mini-a holds none of the steps A6-02's options walk to: not reachable in a partial bundle, every option low", async () => {
    // bundle-mini-a is partial: it holds neither A6-03, A6-04 nor A6-05 (the steps the options list) nor A6-01, whose
    // branch lists A6-02, so no walk reaches further here. The master's '1 Accept' does: see the next test.
    const { context } = await callFrontier(request([ALEX_Q.id]), twoBookings([ALEX_Q]));
    expect(context.choices.every((choice) => choice.stakes === "low" && choice.stakesFrom.length === 0)).toBe(
      true,
    );
  });

  it("with the master's A6-01, A6-03 and A6-10 around A6-02, '1 Accept' walks on to A6-10, which books: every option high", async () => {
    // '1 Accept' lists A6-03, the end of its list; A6-02 ends A6-01's 'Sam's OK first', which rejoins at A6-10: a split
    // code settles (the booking write's outcome), which gives booked. The walk counts it rather than stopping there.
    const document = withSteps(MINI_A, [MASTER_A6_01, MASTER_A6_03, MASTER_A6_10]);
    const { context } = await callFrontier(request([ALEX_Q.id]), twoBookings([ALEX_Q]), [document]);
    expect(stakesOf(context.choices)).toEqual([
      ["c-01", "high", [{ why: "booked", step: "A6-10", ref: "booked" }]],
      ["c-02", "high", [{ why: "question", step: null, ref: "c-01" }]],
      ["c-03", "high", [{ why: "question", step: null, ref: "c-01" }]],
    ]);
  });

  it("a charge on '1 Accept' makes it high, and so every option of that question (why: question, its id)", async () => {
    const document = withAcceptEffect({ kind: "charge", ref: "deposit", to: ["pay"] });
    const { context } = await callFrontier(request([ALEX_Q.id, BEN_Q.id]), twoBookings(), [document]);
    expect(stakesOf(context.choices)).toEqual([
      ["c-01", "high", [{ why: "charge", step: "A6-02", ref: "deposit" }]],
      ["c-02", "high", [{ why: "question", step: null, ref: "c-01" }]],
      ["c-03", "high", [{ why: "question", step: null, ref: "c-01" }]],
      ["c-04", "high", [{ why: "charge", step: "A6-02", ref: "deposit" }]],
      ["c-05", "high", [{ why: "question", step: null, ref: "c-04" }]],
      ["c-06", "high", [{ why: "question", step: null, ref: "c-04" }]],
    ]);
  });

  it("a record write of booked is high (why: booked); a message is not", async () => {
    const document = withAcceptEffect({ kind: "recordWrite", ref: "booked" });
    const { context } = await callFrontier(request([ALEX_Q.id]), twoBookings([ALEX_Q]), [document]);
    expect(stakesOf(context.choices)[0]).toEqual([
      "c-01",
      "high",
      [{ why: "booked", step: "A6-02", ref: "booked" }],
    ]);
  });

  it("in a full bundle a step the walk cannot find means the builder cannot walk it: unknown, the safer route", async () => {
    // '1 Accept' walks to A6-03, which bundle-mini-a does not hold: not reachable in a partial bundle (low), but a fault
    // in a full one (high, unknown); the other two options then follow it as the same question's.
    const full = withAcceptEffect({ kind: "message", ref: "A6-03", to: ["cust"] }, false);
    const { context } = await callFrontier(request([ALEX_Q.id]), twoBookings([ALEX_Q]), [full]);
    expect(stakesOf(context.choices)).toEqual([
      ["c-01", "high", [{ why: "unknown", step: null, ref: null }]],
      ["c-02", "high", [{ why: "unknown", step: null, ref: null }]],
      ["c-03", "high", [{ why: "unknown", step: null, ref: null }]],
    ]);
  });
});
