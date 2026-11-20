// T-633's proofs (the card's Proves and its lead notes, DL-988 item 8 and DL-994), unit side: `npm run test:unit --
// actions/src/tool-api/journey-1/kinds`. The code under test is real: matchKinds (match-kinds.ts) through the Tool API base,
// S1-02's, S1-03's and S1-74's step writers (writers.ts, answer.ts, reads.ts) through T-1461's walk (commit/walk
// createWritesOf), and the review item's plan (writers.ts newWorkReviewPlan), with T-632's matcher and T-319's
// openReviewItemCore and decideReviewItemAlone as they are. The doubles are the K-05 reads (items 78 and 79 as db/repo
// answers them), the stop home's reads and T-319's paging reader (the frozen seeds' worlds), and T-1461's walk doubles
// (bundle v1's port, the question read, S1-11's stand-in writer for T-634's). Values come from the contracts' fixtures and
// fixture set v1 (test-support.ts; rule 9):
//   - match-kinds.json gives its response;
//   - commit-s1-02.json's second turn ("All on the list") yields its three picked kinds rows, S1-11 walked (stubbed),
//     S1-04's question with its outbox row and oq-s1-02 closed at its version; the kinds are one unit's state writes in the
//     one K-05 commit request;
//   - "One isn't on the list yet" walks to S1-03, whose writer drafts the new work in state drafting with its message and
//     opens no review item; the drafted kind stays offline and setup goes on (S1-11, then S1-04's question);
//   - the review item's plan, which no writer calls: exactly one review item per draft and that draft moved to in_review
//     in the same rows (the plan's line "An unknown kind opens one review item and the business stays offline": DL-994
//     item 10), and the team's decision (decideReviewItemAlone) writes the draft's state back;
//   - "Not a service we book" keeps the words as a not_booked pick with no kind, gives no key, and S1-74 writes its
//     message alone;
//   - the branch must fit the words; a word two kinds fit refuses the whole part (notBuilt); the reads are their own
//     (item 78, item 79), never the call's repo; a port left out, a stopped number and a failed read each fail closed; no
//     error carries the owner's words or the chat id.

import { describe, expect, it } from "vitest";

import { buildCommitRequest } from "../../../commit/build";
import type { UnitWrites } from "../../../commit";
import { contractChecks, eventLogRowsOf } from "../../../commit/test-support";
import { WalkNotBuiltError, createWritesOf, type StepRows, type StepWriter } from "../../../commit/walk";
import {
  NOTHING_OPEN,
  SAM,
  bundleV1Bundles,
  decidedOf,
  questionsOver,
  requestTurnFields,
  s1_11Writer,
  writersOf,
  type WalkTestRepo,
} from "../../../commit/walk/test-support";
import { decideReviewItemAlone, type PagingWrites } from "../../../domain/paging";
import { TEAM_1, applyPagingWrites, readerOn, type PagingWorld } from "../../../domain/paging/test-support";
import type { AloneCommitRequest } from "../../../domain/flags";
import { k24Picks } from "../../../domain/kind-matcher/test-support";
import { createToolApi, createToolApiValidator, notBuiltHandlers, NotBuiltError } from "../../index";
import { recordingScope, traceFor, type RecordingRepo } from "../../test-support";
import {
  DRAFTING,
  IN_REVIEW,
  KindsNotBuiltError,
  KindsReadError,
  KindsRefusedError,
  NO_PATTERN_MET,
  REVIEW_SUMMARY,
  createMatchKinds,
  draftedKindId,
  kindsReadsOf,
  kindsWriters,
  newWorkReviewPlan,
  type KindsFault,
  type KindsStep,
  type KindsWriters,
  type NewWorkReviewPlan,
} from "./index";
import {
  GIFT_CARDS,
  PACK_HIKES,
  earlierPick,
  fakeK05,
  matchKindsCatalog,
  matchKindsExchange,
  planPaging,
  stoppedWorld,
  turnWithWords,
  writerDeps,
  writerWorlds,
  type FakeK05,
  type FakeK05Given,
  type WriterWorlds,
} from "./test-support";

const validator = createToolApiValidator();

/** The 11 pf keys and kinds that commit-s1-02.json states its part gives. */
const STATED_GIVES = [
  "kinds",
  "pf.license",
  "pf.services",
  "pf.questions",
  "pf.safety",
  "pf.first_steps",
  "pf.visit",
  "pf.money",
  "pf.messages",
  "pf.staff",
  "pf.rules",
  "pf.edges",
];

// ---------------------------------------------------------------------------------------------------------------
// matchKinds through the Tool API base

/** match-kinds.json's request through the base, matchKinds answered by createMatchKinds over the K-05 double. */
async function callMatchKinds(k05: FakeK05, request: unknown = matchKindsExchange().request) {
  const scope = recordingScope();
  const handlers = {
    ...notBuiltHandlers(),
    matchKinds: createMatchKinds<RecordingRepo>({ reads: kindsReadsOf(k05.k05) }),
  };
  const api = createToolApi<RecordingRepo>({ validator, scope, handlers });
  const { trace } = traceFor(request);
  const settled = await api.call("matchKinds", structuredClone(request), trace).then(
    (answered) => ({ answered, thrown: undefined as unknown }),
    (thrown: unknown) => ({ answered: undefined as unknown, thrown }),
  );
  return { ...settled, events: scope.events };
}

describe("matchKinds: match-kinds.json gives its response", () => {
  it("over match-kinds.json's own three kinds, the base answers its outcome part for part, held to K-09", async () => {
    const exchange = matchKindsExchange();
    const k05 = fakeK05({ kinds: matchKindsCatalog() });
    const { answered, thrown } = await callMatchKinds(k05);
    expect(thrown).toBeUndefined();
    expect(answered).toEqual(exchange.outcome);
    expect(validator.check("matchKinds", "response", answered)).toEqual([]);
  });

  it("over the 243 seeded kinds, the same words and outcomes, each part K-24 seed-business-kinds.json's kind", async () => {
    const exchange = matchKindsExchange();
    const { answered } = await callMatchKinds(fakeK05());
    const picks = k24Picks("seed-business-kinds.json");
    expect(answered).toEqual({
      parts: exchange.outcome.parts.map((part, index) => ({
        words: part.words,
        outcome: part.outcome,
        kinds: [{ kindId: picks[index]?.kindId, name: ["Barber", "Plumber", "Electrician"][index] }],
      })),
    });
  });

  it("reads the catalog once, in a read of its own: the call's scoped repo is never read", async () => {
    const k05 = fakeK05();
    const { events } = await callMatchKinds(k05);
    expect(k05.asked).toEqual([{ read: "readKindCatalog" }]);
    expect(events.map((event) => event.what)).not.toContain("read");
  });

  it("a transient catalog read answers K-09's transient, and a catalog with no trade-file kind indexUnavailable", async () => {
    const transient = fakeK05({ catalog: { error: "transient", sqlstate: "40001" } });
    expect((await callMatchKinds(transient)).answered).toEqual({ error: "transient", sqlstate: "40001" });
    const empty = fakeK05({ kinds: [] });
    expect((await callMatchKinds(empty)).answered).toEqual({ error: "indexUnavailable" });
  });

  it("words that name no work are refused, nothing answered, and the refusal holds no words", async () => {
    const request = { ...matchKindsExchange().request, words: "Hi, 42" };
    const { answered, thrown } = await callMatchKinds(fakeK05(), request);
    expect(answered).toBeUndefined();
    expect(thrown).toBeInstanceOf(KindsRefusedError);
    expect(thrown).toMatchObject({ fault: "noWords" });
    expect((thrown as Error).message).not.toContain("42");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The step writers through the walk (T-1461's doubles, S1-11's writer stubbed)

/** What one of this folder's writers handed the walk for one call: its rows, or what it threw. */
interface Wrote {
  readonly stepId: KindsStep;
  readonly rows: StepRows | null;
  readonly error: Error | null;
}

/** This folder's writers as they are, each call's rows or rejection written down and handed on unchanged. */
function noted(
  real: KindsWriters<WalkTestRepo>,
  wrote: Wrote[],
): Record<KindsStep, StepWriter<WalkTestRepo>> {
  const note =
    (stepId: KindsStep): StepWriter<WalkTestRepo> =>
    (call) =>
      real[stepId](call).then(
        (rows) => {
          wrote.push({ stepId, rows, error: null });
          return rows;
        },
        (thrown: unknown) => {
          const error = thrown instanceof Error ? thrown : new Error("a writer threw no Error");
          wrote.push({ stepId, rows: null, error });
          return Promise.reject(error);
        },
      );
  return { "S1-02": note("S1-02"), "S1-03": note("S1-03"), "S1-74": note("S1-74") };
}

/** The walk's writesOf on bundle v1, the question read over oq-s1-02's row, this folder's writers and S1-11's stand-in. */
function kindsWalk(k05: FakeK05 = fakeK05(), worlds: WriterWorlds = writerWorlds()) {
  const { bundles } = bundleV1Bundles();
  const questions = questionsOver();
  const wrote: Wrote[] = [];
  const bound: Record<string, StepWriter<WalkTestRepo>> = {
    ...noted(kindsWriters<WalkTestRepo>(writerDeps(k05.k05, worlds)), wrote),
    "S1-11": s1_11Writer,
  };
  const writers = writersOf(bound);
  const writesOf = createWritesOf<WalkTestRepo>({
    bundles,
    turnKey: () => SAM,
    questions: questions.questions,
    writers: writers.writers,
  });
  return { writesOf, calls: writers.calls, asked: k05.asked, worlds, wrote };
}

/** The rows one of this folder's writers handed the walk in a run (its one call). */
function rowsOf(wrote: readonly Wrote[], stepId: KindsStep): StepRows {
  const [only, ...more] = wrote.filter((each) => each.stepId === stepId);
  const rows = only?.rows ?? null;
  if (rows === null || more.length > 0) throw new Error(`${stepId}'s writer answered once`);
  return rows;
}

/** Turn 2 choosing `choiceId` with `words` (commit-s1-02.json's own when left out), answered by the walk. */
async function answer(choiceId: string, words?: string, walk = kindsWalk()) {
  const turn = turnWithWords(choiceId, words);
  const writes = await walk.writesOf(turn.part, turn.context, NOTHING_OPEN);
  return { ...turn, ...walk, writes };
}

/** What turn 2 choosing `choiceId` with `words` threw on the walk, or null; with the walk's calls. */
async function refusal(choiceId: string, words?: string, walk = kindsWalk()) {
  const turn = turnWithWords(choiceId, words);
  const error = await walk.writesOf(turn.part, turn.context, NOTHING_OPEN).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  return { ...turn, ...walk, error };
}

/** A state write's table and values (inserts only). */
function inserted(writes: UnitWrites, table: string): Record<string, unknown>[] {
  return writes.state.flatMap((write) =>
    write.op === "insert" && write.table === table ? [write.values] : [],
  );
}

/** The step ids the writers were called for, in order. */
const stepsWritten = (calls: readonly { stepId: string }[]): string[] => calls.map((call) => call.stepId);

/** Expects a refusal of this fault and these ids. */
function expectRefused(error: unknown, fault: KindsFault, ids: readonly string[]): void {
  expect(error).toBeInstanceOf(KindsRefusedError);
  expect(error).toMatchObject({ fault, ids });
}

/** The one K-05 commit request the commit builds from a part's writes (answer.test.ts's build), and its checks. */
function commitOf(context: ReturnType<typeof turnWithWords>["context"], writes: UnitWrites) {
  const { people } = decidedOf(context.request).context.writer;
  const personId = context.request.caller.personId;
  const person = people.find((each) => each.personId === personId);
  return buildCommitRequest({
    turn: context.turn,
    zone: "America/New_York",
    businessId: context.businessId,
    actor: {
      personId,
      roleAt: (businessId) => person?.roles.find((role) => role.businessId === businessId)?.role ?? null,
    },
    units: [{ writes, answer: { openQuestionId: "oq-s1-02", optionId: null, eventId: "evt-sam-0001" } }],
  });
}

describe("commit-s1-02.json's second turn, 'All on the list', with the real S1-02 writer", () => {
  it("yields its three picked kinds rows, walks S1-11, asks S1-04 with its outbox row and closes oq-s1-02 at its version", async () => {
    const { writes, calls, exchange, context } = await answer("c-01");
    const { outcome } = exchange;
    // The picks: commit-s1-02.json's three picked_kinds rows (inserted, so version 1), in the owner's order, named by
    // default 131 (the fixture names its rows by stand-ins: pick-sam-barbershop and the rest).
    expect(writes.state.map((write) => [write.op, write.table])).toEqual(
      outcome.written.written.map((row) => ["insert", row.table]),
    );
    expect(outcome.written.written.map((row) => row.version)).toEqual([1, 1, 1]);
    const picks = k24Picks("seed-business-kinds.json");
    expect(inserted(writes, "picked_kinds")).toEqual(
      picks.map((pick, index) => ({
        id: `pick-s1-02-sam-${String(index + 1)}`,
        owner_person_id: "person-sam",
        position: pick.position,
        words: pick.words,
        outcome: "listed",
        kind_id: pick.kindId,
        company_id: null,
        business_id: null,
        picked_at: context.request.now,
      })),
    );
    // S1-11 walked with its stand-in, then S1-04's question and quick reply, and oq-s1-02 closed at version 2.
    expect(stepsWritten(calls)).toEqual(["S1-02", "S1-11"]);
    expect(writes.asks.map((ask) => ask.question.id)).toEqual(["oq-s1-04-sam-1"]);
    expect(writes.asks).toHaveLength(outcome.openQuestions.opened.length);
    expect(writes.messages.map((row) => [row.id, row.openQuestionId])).toEqual([
      ["outbox-s1-04-sam-1", "oq-s1-04-sam-1"],
    ]);
    expect(writes.messages).toHaveLength(outcome.written.outboxRows.length);
    expect(writes.closes).toEqual([
      { id: "oq-s1-02", expectVersion: 2, status: "answered", answeredOptionId: null },
    ]);
    expect(writes.closes.map((close) => close.id)).toEqual(outcome.openQuestions.closed);
    expect(writes.gives).toEqual(STATED_GIVES);
    expect(writes.gives).toEqual(outcome.parts[0]?.gives);
    expect(writes.stateEvents).toEqual([]);
  });

  it("the kinds are one unit's state writes in the one K-05 commit request, which K-05 and K-08 take", async () => {
    const { writes, context, exchange } = await answer("c-01");
    const request = commitOf(context, writes);
    const checks = contractChecks();
    expect(checks.k05("commitTurn.request", request)).toEqual([]);
    for (const write of writes.state) expect(checks.k05("stateWrite", write)).toEqual([]);
    expect(request.turn.id).toBe("turn-s1-02-sam-kinds");
    expect(request.writes.state).toEqual(writes.state);
    expect(request.writes.state.filter((write) => write.table === "picked_kinds")).toHaveLength(3);
    const rows = eventLogRowsOf(request, exchange.request.now);
    for (const row of rows) expect(checks.k08("eventLogRow", row), String(row.id)).toEqual([]);
  });

  it("reads item 78 once and item 79 once, for the call's own business and the turn's person, never on the call's repo", async () => {
    const { asked, calls, context } = await answer("c-01");
    expect(asked).toEqual([
      { read: "readKindCatalog" },
      { read: "readPickedKinds", request: { businessId: "biz-lees-barbershop", personId: "person-sam" } },
    ]);
    expect(context.businessId).toBe("biz-lees-barbershop");
    // The writers are handed the call's repo by the walk; WalkTestRepo has nothing to read, and nothing reads it.
    for (const call of calls) expect(call.repo).toBe(context.repo);
  });

  it("numbers new picks after item 79's, and never picks a kind the owner has already picked", async () => {
    const k05 = fakeK05({ picks: [earlierPick(2)] });
    const { writes } = await answer("c-01", undefined, kindsWalk(k05));
    expect(inserted(writes, "picked_kinds").map((row) => [row.id, row.position, row.kind_id])).toEqual([
      ["pick-s1-02-sam-1", 3, "plumber"],
      ["pick-s1-02-sam-2", 4, "electrician"],
    ]);
    expect(writes.gives).toEqual(STATED_GIVES);
    const twice = await answer("c-01", "Barbershop, Barbershop");
    expect(inserted(twice.writes, "picked_kinds").map((row) => [row.position, row.kind_id])).toEqual([
      [1, "barber"],
    ]);
  });

  it("the same part twice gives the same writes", async () => {
    const walk = kindsWalk();
    const first = await answer("c-01", undefined, walk);
    const second = await answer("c-01", undefined, walk);
    expect(second.writes).toEqual(first.writes);
  });
});

describe("'One isn't on the list yet' walks to S1-03, which drafts the new work (drafting) and opens no review item", () => {
  const words = `Barbershop, ${PACK_HIKES}`;

  it("S1-02 keeps the barbershop listed and drafts a kind for pack hikes, picked as new work", async () => {
    const { writes, context } = await answer("c-02", words);
    const draftedId = await draftedKindId("pick-s1-02-sam-2");
    expect(draftedId).toMatch(/^new-[0-9a-f]{16}$/u);
    expect(inserted(writes, "kinds")).toEqual([
      {
        id: draftedId,
        name: PACK_HIKES,
        style: null,
        pattern: NO_PATTERN_MET,
        facts: null,
        source: "new_work",
      },
    ]);
    expect(inserted(writes, "picked_kinds")).toEqual([
      {
        id: "pick-s1-02-sam-1",
        owner_person_id: "person-sam",
        position: 1,
        words: "Barbershop",
        outcome: "listed",
        kind_id: "barber",
        company_id: null,
        business_id: null,
        picked_at: context.request.now,
      },
      {
        id: "pick-s1-02-sam-2",
        owner_person_id: "person-sam",
        position: 2,
        words: PACK_HIKES,
        outcome: "new_work",
        kind_id: draftedId,
        company_id: null,
        business_id: null,
        picked_at: context.request.now,
      },
    ]);
    // The drafted kind's row comes before its pick (picked_kinds_kind_fk), and the picks before S1-03's draft.
    expect(writes.state.map((write) => write.table)).toEqual([
      "picked_kinds",
      "kinds",
      "picked_kinds",
      "new_work_drafts",
    ]);
  });

  it("S1-03's writer returns the new_work pick's draft in state drafting, with no business, and its message: no review item, no entry", async () => {
    const { writes, calls, context, wrote } = await answer("c-02", words);
    expect(stepsWritten(calls)).toEqual(["S1-02", "S1-03", "S1-11"]);
    const draft = {
      id: "draft-s1-03-sam-1",
      picked_kind_id: "pick-s1-02-sam-2",
      business_id: null,
      state: "drafting",
      drafted_at: context.request.now,
    };
    expect(DRAFTING).toBe("drafting");
    // What S1-03's own writer handed the walk: the draft's insert and its one message, and nothing else.
    const s1_03 = rowsOf(wrote, "S1-03");
    expect(s1_03.state).toEqual([{ op: "insert", table: "new_work_drafts", values: draft }]);
    expect(s1_03.stateEvents).toEqual([]);
    expect(s1_03.gives).toEqual([]);
    expect(s1_03.asks).toEqual([]);
    expect(s1_03.messages.map((row) => row.id)).toEqual(["outbox-s1-03-sam-1"]);
    // And so the part's writes: one draft, no review item and no entry of one.
    expect(inserted(writes, "new_work_drafts")).toEqual([draft]);
    expect(writes.state.map((write) => write.table)).not.toContain("review_items");
    expect(writes.state.every((write) => write.op === "insert")).toBe(true);
    expect(writes.stateEvents).toEqual([]);
  });

  it("the writers take no paging port: the walk-time writer cannot call the review item's plan", () => {
    const worlds = writerWorlds();
    expect(Object.keys(writerDeps(fakeK05().k05, worlds)).sort()).toEqual(["reads", "stop"]);
  });

  it("the drafted kind stays offline and setup goes on at once: no businesses row, the draft not approved, S1-11 walked and S1-04 asked", async () => {
    const { writes, calls } = await answer("c-02", words);
    expect(writes.state.map((write) => write.table)).not.toContain("businesses");
    expect(inserted(writes, "new_work_drafts").map((row) => row.state)).toEqual(["drafting"]);
    expect(inserted(writes, "kinds").map((row) => row.source)).toEqual(["new_work"]);
    expect(stepsWritten(calls).at(-1)).toBe("S1-11");
    expect(writes.asks.map((ask) => ask.question.id)).toEqual(["oq-s1-04-sam-1"]);
    expect(writes.gives).toEqual(STATED_GIVES);
  });

  it("S1-03 tells the owner once, before S1-04's question, as a quick reply on the turn's service", async () => {
    const { writes, context } = await answer("c-02", words);
    expect(writes.messages).toEqual([
      {
        id: "outbox-s1-03-sam-1",
        recipientHandleId: "handle-sam",
        recipientPersonId: "person-sam",
        businessId: "biz-lees-barbershop",
        bookingId: null,
        channel: requestTurnFields(context.request).service,
        sendClass: "quick_reply",
        openQuestionId: null,
        copyOfRowId: null,
        versionsRead: [],
      },
      expect.objectContaining({ id: "outbox-s1-04-sam-1", openQuestionId: "oq-s1-04-sam-1" }) as unknown,
    ]);
  });

  it("goes into the one K-05 commit request, which K-05 and K-08 take", async () => {
    const { writes, context, exchange } = await answer("c-02", words);
    const request = commitOf(context, writes);
    const checks = contractChecks();
    expect(checks.k05("commitTurn.request", request)).toEqual([]);
    for (const write of writes.state) expect(checks.k05("stateWrite", write)).toEqual([]);
    const rows = eventLogRowsOf(request, exchange.request.now);
    for (const row of rows) expect(checks.k08("eventLogRow", row), String(row.id)).toEqual([]);
    expect(checks.k08("eventLogBatch", { rows })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The review item's plan (the later checklist card's; no writer calls it), on T-319's reader double

/** The draft S1-03's writer wrote for "Barbershop, pack hikes", as the walk named it. */
const DRAFT = "draft-s1-03-sam-1";

/** The plan's rows as one call's writes, for T-319's world double (the commit's part: the rows, in order). */
function planWrites(plan: NewWorkReviewPlan): PagingWrites {
  return {
    why: { step: "S1-03", choice: null },
    versionsRead: [],
    state: plan.state,
    stateEvents: plan.stateEvents,
    asks: [],
    messages: [],
    clocks: [],
    clockCancels: [],
  };
}

/** The paging world with these drafts on file, each at the version given, none with a business. */
function worldWithDrafts(drafts: Readonly<Record<string, number>>): PagingWorld {
  const { paging } = writerWorlds();
  for (const [id, version] of Object.entries(drafts)) {
    paging.rows.set(`new_work_drafts/${id}`, { version, businessId: null });
  }
  return paging;
}

describe("the review item's plan: an unknown kind opens one review item, and the draft moves to in_review in the same rows", () => {
  const words = `Barbershop, ${PACK_HIKES}`;
  const turn = () => turnWithWords("c-02", words).context;

  it("plans exactly one team review item of kind new_work on the draft, due in 1 business day, then the draft's move to in_review at the version handed in", async () => {
    const world = worldWithDrafts({ [DRAFT]: 1 });
    const { paging, reader } = planPaging(world);
    const context = turn();
    const plan = await newWorkReviewPlan(paging, context, [{ id: DRAFT, version: 1 }]);
    const items = plan.state.flatMap((write) =>
      write.op === "insert" && write.table === "review_items" ? [write.values] : [],
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "new_work",
      business_id: null,
      subject_table: "new_work_drafts",
      subject_row_id: DRAFT,
      turn_id: "turn-s1-02-sam-kinds",
      raised_by_person_id: "person-sam",
      summary: REVIEW_SUMMARY,
      opened_at: context.request.now,
      due_at: "2026-10-20T14:05:06Z",
      state: "open",
    });
    expect(String(items[0]?.id)).toMatch(/^review-[0-9a-f]{32}$/u);
    expect(IN_REVIEW).toBe("in_review");
    expect(plan.state).toEqual([
      { op: "insert", table: "review_items", values: items[0] },
      {
        op: "update",
        table: "new_work_drafts",
        key: { id: DRAFT },
        expectVersion: 1,
        set: { state: "in_review" },
      },
    ]);
    expect(
      plan.stateEvents.map((entry) => [entry.kind, entry.tableName, entry.rowId, entry.businessId]),
    ).toEqual([["review_item.opened", "review_items", items[0]?.id, null]]);
    // Its reads are T-319's reader's alone, one after another: is the item on file, then the row under review.
    expect(reader.asked).toEqual(["reviewItem", "row"]);
    const checks = contractChecks();
    for (const write of plan.state) expect(checks.k05("stateWrite", write)).toEqual([]);
  });

  it("two drafts: one item each, each draft moved at its own version, in the order given; a draft named twice is planned once", async () => {
    const other = "draft-s1-03-sam-2";
    const world = worldWithDrafts({ [DRAFT]: 1, [other]: 3 });
    const { paging, reader } = planPaging(world);
    const plan = await newWorkReviewPlan(paging, turn(), [
      { id: DRAFT, version: 1 },
      { id: other, version: 3 },
      { id: DRAFT, version: 1 },
    ]);
    expect(
      plan.state.map((write) =>
        write.op === "insert"
          ? [write.table, write.values.subject_row_id]
          : [write.table, write.key.id, write.expectVersion, write.set.state],
      ),
    ).toEqual([
      ["review_items", DRAFT],
      ["new_work_drafts", DRAFT, 1, "in_review"],
      ["review_items", other],
      ["new_work_drafts", other, 3, "in_review"],
    ]);
    expect(plan.stateEvents).toHaveLength(2);
    expect(reader.asked).toEqual(["reviewItem", "row", "reviewItem", "row"]);
    // The double's commit takes them as K-05's would: each draft is on file at the version compared.
    applyPagingWrites(world, planWrites(plan));
    expect(world.reviewItems.size).toBe(2);
    expect(world.rows.get(`new_work_drafts/${DRAFT}`)).toEqual({ version: 2, businessId: null });
    expect(world.rows.get(`new_work_drafts/${other}`)).toEqual({ version: 4, businessId: null });
  });

  it("the business stays offline: the plan writes no businesses row, and approves nothing", async () => {
    const { paging } = planPaging(worldWithDrafts({ [DRAFT]: 1 }));
    const plan = await newWorkReviewPlan(paging, turn(), [{ id: DRAFT, version: 1 }]);
    expect(plan.state.map((write) => write.table)).toEqual(["review_items", "new_work_drafts"]);
    expect(JSON.stringify(plan.state)).not.toContain("approved");
  });

  it("Rosie's team decides it with decideReviewItemAlone, which writes the draft's state back: the decision resumes setup", async () => {
    const world = worldWithDrafts({ [DRAFT]: 1 });
    const plan = await newWorkReviewPlan(planPaging(world).paging, turn(), [{ id: DRAFT, version: 1 }]);
    applyPagingWrites(world, planWrites(plan));
    const [item] = [...world.reviewItems.values()];
    if (item === undefined) throw new Error("the review item is in the world");
    const committed: AloneCommitRequest[] = [];
    const decided = await decideReviewItemAlone(
      {
        caller: {
          kind: "console",
          turnId: null,
          requestId: "req-console-team-0002",
          businessId: null,
          personId: TEAM_1,
          traceId: "trace-console-0002",
        },
        reviewItemId: item.id,
        expectVersion: 1,
        decision: {
          state: "done",
          outcome: "Pack hikes checked against the official rules for that work: approved (S1-03).",
          writeBack: { table: "new_work_drafts", state: "approved" },
        },
      },
      {},
      null,
      {
        reader: () => readerOn(world),
        commitAlone: {
          commit: (request) => {
            committed.push(request);
            return Promise.resolve({ committed: true, repeated: false });
          },
        },
        now: () => "2026-10-20T13:00:00Z",
      },
    );
    expect(decided).toEqual({
      state: "done",
      decidedAt: "2026-10-20T13:00:00Z",
      // The draft was moved to in_review at version 1 by the plan's rows, so the decision compares version 2.
      written: [
        { table: "review_items", rowId: item.id, version: 2 },
        { table: "new_work_drafts", rowId: DRAFT, version: 3 },
      ],
      repeated: false,
    });
    expect(committed[0]?.writes.state).toContainEqual({
      op: "update",
      table: "new_work_drafts",
      key: { id: DRAFT },
      expectVersion: 2,
      set: { state: "approved" },
    });
  });

  it("once the item is on file, the same turn plans no second item and no second move: openReviewItem answers repeated", async () => {
    const world = worldWithDrafts({ [DRAFT]: 1 });
    const context = turn();
    const first = await newWorkReviewPlan(planPaging(world).paging, context, [{ id: DRAFT, version: 1 }]);
    applyPagingWrites(world, planWrites(first));
    const again = await newWorkReviewPlan(planPaging(world).paging, context, [{ id: DRAFT, version: 1 }]);
    expect(again).toEqual({ state: [], stateEvents: [] });
  });

  it("a draft that is not on file is refused (reviewRefused, notFound), and no row of an earlier draft is handed on", async () => {
    const world = worldWithDrafts({ [DRAFT]: 1 });
    const error = await newWorkReviewPlan(planPaging(world).paging, turn(), [
      { id: DRAFT, version: 1 },
      { id: "draft-s1-03-sam-9", version: 1 },
    ]).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expectRefused(error, "reviewRefused", ["S1-03", "notFound"]);
    expect((error as Error).message).not.toContain("draft-s1-03-sam-9");
    expect(world.reviewItems.size).toBe(0);
  });

  it("with no paging port, or one with no reader, the plan answers notBuilt and reads nothing: never the service's default reader", async () => {
    for (const paging of [undefined, {}]) {
      const error = await newWorkReviewPlan<WalkTestRepo>(paging, turn(), [{ id: DRAFT, version: 1 }]).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(KindsNotBuiltError);
      expect(error).toMatchObject({ seam: "pagingNotWired", ids: ["S1-03"], call: "gateAndCommit" });
    }
  });

  it("no draft plans no row and reads nothing", async () => {
    const { paging, reader } = planPaging(worldWithDrafts({}));
    expect(await newWorkReviewPlan(paging, turn(), [])).toEqual({ state: [], stateEvents: [] });
    expect(reader.asked).toEqual([]);
  });
});

describe("'Not a service we book' walks to S1-74, gives no kind and writes none", () => {
  it("commit-s1-02.json's words: each part kept not_booked with no kind for Rosie's team, S1-74's message, nothing after", async () => {
    const { writes, calls, context } = await answer("c-03");
    expect(stepsWritten(calls)).toEqual(["S1-02", "S1-74"]);
    expect(inserted(writes, "picked_kinds")).toEqual(
      ["Barbershop", "plumbing", "electrical"].map((words, index) => ({
        id: `pick-s1-02-sam-${String(index + 1)}`,
        owner_person_id: "person-sam",
        position: index + 1,
        words,
        outcome: "not_booked",
        kind_id: null,
        company_id: null,
        business_id: null,
        picked_at: context.request.now,
      })),
    );
    expect(writes.state.map((write) => write.table)).toEqual([
      "picked_kinds",
      "picked_kinds",
      "picked_kinds",
    ]);
    expect(writes.gives).toEqual([]);
    expect(writes.messages.map((row) => [row.id, row.openQuestionId, row.sendClass])).toEqual([
      ["outbox-s1-74-sam-1", null, "quick_reply"],
    ]);
    expect(writes.asks).toEqual([]);
    expect(writes.closes.map((close) => close.id)).toEqual(["oq-s1-02"]);
    for (const later of ["S1-11", "S1-04", "s1-11", "s1-04"])
      expect(JSON.stringify(writes)).not.toContain(later);
  });

  it("gift cards: one pick not booked, and no catalog read at all", async () => {
    const { writes, asked } = await answer("c-03", GIFT_CARDS);
    expect(inserted(writes, "picked_kinds").map((row) => [row.words, row.outcome, row.kind_id])).toEqual([
      [GIFT_CARDS, "not_booked", null],
    ]);
    expect(asked.map((read) => read.read)).toEqual(["readPickedKinds"]);
  });

  it("S1-02's writer writes the not_booked pick (no kind, no company, no business) and gives []; S1-74's writer writes its message alone", async () => {
    const { writes, wrote, context } = await answer("c-03", GIFT_CARDS);
    const s1_02 = rowsOf(wrote, "S1-02");
    expect(s1_02.state).toEqual([
      {
        op: "insert",
        table: "picked_kinds",
        values: {
          id: "pick-s1-02-sam-1",
          owner_person_id: "person-sam",
          position: 1,
          words: GIFT_CARDS,
          outcome: "not_booked",
          kind_id: null,
          company_id: null,
          business_id: null,
          picked_at: context.request.now,
        },
      },
    ]);
    expect(s1_02.gives).toEqual([]);
    expect(s1_02.messages).toEqual([]);
    const s1_74 = rowsOf(wrote, "S1-74");
    expect(s1_74.state).toEqual([]);
    expect(s1_74.stateEvents).toEqual([]);
    expect(s1_74.gives).toEqual([]);
    expect(s1_74.asks).toEqual([]);
    expect(s1_74.messages.map((row) => row.id)).toEqual(["outbox-s1-74-sam-1"]);
    // So the part: no kinds row, no kind id and no kinds key given.
    expect(inserted(writes, "kinds")).toEqual([]);
    expect(writes.state.every((write) => write.table === "picked_kinds")).toBe(true);
    expect(inserted(writes, "picked_kinds").every((row) => row.kind_id === null)).toBe(true);
    expect(writes.gives).toEqual([]);
  });
});

describe("the branch must fit the words, else the part is refused with nothing written", () => {
  it.each([
    [
      "'All on the list' with a part no kind fits",
      "c-01",
      `Barbershop, ${PACK_HIKES}`,
      ["S1-02", "new_work"],
    ],
    [
      "'All on the list' with a part Rosie never books",
      "c-01",
      `Barbershop, ${GIFT_CARDS}`,
      ["S1-02", "not_booked"],
    ],
    ["'One isn't on the list yet' with every part listed", "c-02", undefined, ["S1-02", "listed"]],
    [
      "'One isn't on the list yet' with a part Rosie never books",
      "c-02",
      `${PACK_HIKES}, ${GIFT_CARDS}`,
      ["S1-02", "not_booked"],
    ],
  ] as const)("%s: branchNotWords, no later writer called", async (_, choiceId, words, ids) => {
    const { error, calls } = await refusal(choiceId, words);
    expectRefused(error, "branchNotWords", ids);
    expect(stepsWritten(calls)).toEqual(["S1-02"]);
  });

  it("a part two kinds fit needs the owner's 'which?' first, which is not built: notBuilt, the walk answering notBuilt", async () => {
    const { error } = await refusal("c-01", "trainer");
    expect(error).toBeInstanceOf(KindsNotBuiltError);
    expect(error).toBeInstanceOf(NotBuiltError);
    expect(error).toMatchObject({ seam: "which", ids: ["S1-02"], call: "gateAndCommit" });
  });

  it.each([
    ["'All on the list'", "c-01", "Barbershop, trainer"],
    ["'One isn't on the list yet'", "c-02", `Barbershop, trainer, ${PACK_HIKES}`],
  ] as const)(
    "%s: a word two kinds fit beside a listed word refuses the whole part: notBuilt, no row and no key",
    async (_, choiceId, words) => {
      const { error, calls, wrote, asked } = await refusal(choiceId, words);
      expect(error).toBeInstanceOf(KindsNotBuiltError);
      expect(error).toMatchObject({ seam: "which", ids: ["S1-02"], call: "gateAndCommit" });
      // S1-02's writer handed the walk nothing (no row, no key: not even the listed word's pick), no later writer was
      // called, and the owner's picks on file were never read.
      expect(wrote.map((each) => [each.stepId, each.rows])).toEqual([["S1-02", null]]);
      expect(wrote[0]?.error).toBe(error);
      expect(stepsWritten(calls)).toEqual(["S1-02"]);
      expect(asked).toEqual([{ read: "readKindCatalog" }]);
    },
  );

  it("an answer with no words that name work is refused (noWords)", async () => {
    const { error } = await refusal("c-01", "Hi, 42");
    expectRefused(error, "noWords", ["S1-02"]);
  });
});

describe("a failed read or a port left out fails the part closed", () => {
  // Every fault each read can answer (K-05 v1.19: item 78 answers its rows or transient, and a list with no trade-file
  // kind is noCatalog; item 79 answers its rows, transient, or notFound for the person or the business).
  const READ_FAULTS: readonly (readonly [
    string,
    FakeK05Given,
    "readKindCatalog" | "readPickedKinds",
    "transient" | "notFound" | "noCatalog",
    Record<string, unknown> | null,
  ])[] = [
    [
      "item 78 transient",
      { catalog: { error: "transient", sqlstate: "40P01" } },
      "readKindCatalog",
      "transient",
      { error: "transient", sqlstate: "40P01" },
    ],
    ["item 78 with no trade-file kind", { kinds: [] }, "readKindCatalog", "noCatalog", null],
    [
      "item 79 transient",
      { picked: { error: "transient", sqlstate: "40001" } },
      "readPickedKinds",
      "transient",
      { error: "transient", sqlstate: "40001" },
    ],
    [
      "item 79 notFound, the person",
      { picked: { error: "notFound", table: "persons", rowId: "person-sam" } },
      "readPickedKinds",
      "notFound",
      { error: "notFound", table: "persons", rowId: "person-sam" },
    ],
    [
      "item 79 notFound, the business",
      { picked: { error: "notFound", table: "businesses", rowId: "biz-lees-barbershop" } },
      "readPickedKinds",
      "notFound",
      { error: "notFound", table: "businesses", rowId: "biz-lees-barbershop" },
    ],
  ];

  it.each(READ_FAULTS)(
    "%s: S1-02's writer rejects with KindsReadError, and the walk's writesOf rejects with nothing returned",
    async (_, given, read, fault, answered) => {
      const { error, wrote, calls } = await refusal("c-01", undefined, kindsWalk(fakeK05(given)));
      // S1-02's writer itself rejected, handing the walk no row and no key, and no later writer was called.
      expect(wrote.map((each) => [each.stepId, each.rows])).toEqual([["S1-02", null]]);
      expect(stepsWritten(calls)).toEqual(["S1-02"]);
      const [{ error: thrown } = { error: null }] = wrote;
      expect(thrown).toBeInstanceOf(KindsReadError);
      // The read and the fault named; K-05's answer (its SQLSTATE, its table and row) on `.answer` alone.
      expect(thrown).toMatchObject({ name: "KindsReadError", read, fault, answer: answered });
      expect(thrown?.message).toBe(`${read} answered ${fault}: the call fails closed and nothing is picked`);
      expect(thrown?.message).not.toMatch(/40P01|40001|person-sam|biz-lees-barbershop|persons|businesses/u);
      // The walk's writesOf rejects with that same error: nothing is returned, so the commit writes nothing.
      expect(error).toBe(thrown);
    },
  );

  it("a failed item 79 read under 'Not a service we book' fails closed too: no pick, and S1-74's writer is never called", async () => {
    const { error, wrote, calls, asked } = await refusal(
      "c-03",
      GIFT_CARDS,
      kindsWalk(fakeK05({ picked: { error: "transient", sqlstate: "40001" } })),
    );
    expect(error).toBeInstanceOf(KindsReadError);
    expect(error).toMatchObject({ read: "readPickedKinds", fault: "transient" });
    expect(wrote.map((each) => [each.stepId, each.rows])).toEqual([["S1-02", null]]);
    expect(stepsWritten(calls)).toEqual(["S1-02"]);
    expect(asked.map((each) => each.read)).toEqual(["readPickedKinds"]);
  });

  it("S1-03 or S1-74 with no stop reads bound answers notBuilt, nothing returned (staging at rung 1 binds the two K-05 reads alone)", async () => {
    const k05 = fakeK05();
    const { bundles } = bundleV1Bundles();
    const wrote: Wrote[] = [];
    const noStop = createWritesOf<WalkTestRepo>({
      bundles,
      turnKey: () => SAM,
      questions: questionsOver().questions,
      writers: writersOf({
        ...noted(kindsWriters<WalkTestRepo>({ reads: kindsReadsOf(k05.k05) }), wrote),
        "S1-11": s1_11Writer,
      }).writers,
    });
    const run = async (choiceId: string, words?: string) => {
      const turn = turnWithWords(choiceId, words);
      return noStop(turn.part, turn.context, NOTHING_OPEN).then(
        () => null,
        (thrown: unknown) => thrown,
      );
    };
    const drafted = await run("c-02", `Barbershop, ${PACK_HIKES}`);
    expect(drafted).toBeInstanceOf(KindsNotBuiltError);
    expect(drafted).toBeInstanceOf(NotBuiltError);
    expect(drafted).toMatchObject({ seam: "stopNotWired", ids: ["S1-03"], call: "gateAndCommit" });
    const notBooked = await run("c-03");
    expect(notBooked).toBeInstanceOf(NotBuiltError);
    expect(notBooked).toMatchObject({ seam: "stopNotWired", ids: ["S1-74"], call: "gateAndCommit" });
    // Each telling writer handed the walk nothing; "All on the list" needs no stop read and still answers.
    expect(wrote.filter((each) => each.stepId !== "S1-02").map((each) => [each.stepId, each.rows])).toEqual([
      ["S1-03", null],
      ["S1-74", null],
    ]);
    expect(await run("c-01")).toBeNull();
  });

  it("a stopped number gets no message (mayText noTexts); the step's other rows are still written", async () => {
    const worlds = writerWorlds(stoppedWorld("2026-10-19T14:04:00Z"));
    const notBooked = await answer("c-03", GIFT_CARDS, kindsWalk(fakeK05(), worlds));
    expect(notBooked.writes.messages).toEqual([]);
    expect(inserted(notBooked.writes, "picked_kinds")).toHaveLength(1);
    const drafted = await answer(
      "c-02",
      `Barbershop, ${PACK_HIKES}`,
      kindsWalk(fakeK05(), writerWorlds(stoppedWorld("2026-10-19T14:04:00Z"))),
    );
    expect(drafted.writes.messages.map((row) => row.id)).toEqual(["outbox-s1-04-sam-1"]);
    expect(inserted(drafted.writes, "new_work_drafts").map((row) => row.state)).toEqual(["drafting"]);
  });

  it("a writer bound to another step refuses (wrongStep), and S1-03 with no S1-02 answer in the run refuses (notAnswered)", async () => {
    const writers = kindsWriters<WalkTestRepo>(writerDeps(fakeK05().k05));
    const { bundles } = bundleV1Bundles();
    const swapped = createWritesOf<WalkTestRepo>({
      bundles,
      turnKey: () => SAM,
      questions: questionsOver().questions,
      writers: writersOf({ "S1-02": writers["S1-74"], "S1-11": s1_11Writer, "S1-03": writers["S1-03"] })
        .writers,
    });
    const turn = turnWithWords("c-01");
    const wrong = await swapped(turn.part, turn.context, NOTHING_OPEN).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expectRefused(wrong, "wrongStep", ["S1-74", "S1-02"]);
    const alone = createWritesOf<WalkTestRepo>({
      bundles,
      turnKey: () => SAM,
      questions: questionsOver().questions,
      writers: writersOf({
        "S1-02": () => Promise.resolve({ state: [], stateEvents: [], gives: [], asks: [], messages: [] }),
        "S1-03": writers["S1-03"],
        "S1-11": s1_11Writer,
      }).writers,
    });
    const two = turnWithWords("c-02", `Barbershop, ${PACK_HIKES}`);
    const missing = await alone(two.part, two.context, NOTHING_OPEN).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expectRefused(missing, "notAnswered", ["S1-03"]);
  });

  it("with no writers bound the walk still refuses as before: T-1461's notBuilt naming S1-02", async () => {
    const { bundles } = bundleV1Bundles();
    const writesOf = createWritesOf<WalkTestRepo>({
      bundles,
      turnKey: () => SAM,
      questions: questionsOver().questions,
      writers: writersOf({}).writers,
    });
    const turn = turnWithWords("c-01");
    const error = await writesOf(turn.part, turn.context, NOTHING_OPEN).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(WalkNotBuiltError);
  });
});

describe("what the kinds folder throws names faults, steps and codes: never the owner's words or the chat id", () => {
  it("no refusal, notBuilt or read error carries the words, a kind's name or the chat id", async () => {
    const errors = [
      (await refusal("c-01", `Barbershop, ${PACK_HIKES}`)).error,
      (await refusal("c-02")).error,
      (await refusal("c-01", "trainer")).error,
      (await refusal("c-01", undefined, kindsWalk(fakeK05({ kinds: [] })))).error,
    ];
    const chatId = String(requestTurnFields(turnWithWords("c-01").context.request).chatId);
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : "";
      for (const words of [chatId, "Barbershop", PACK_HIKES, "trainer", "Dog trainer", "Barber"]) {
        expect(message).not.toContain(words);
      }
    }
  });
});
