// T-633's proofs (the card's Proves and its lead note, DL-988 item 8), unit side: `npm run test:unit --
// actions/src/tool-api/journey-1/kinds`. The code under test is real: matchKinds (match-kinds.ts) through the Tool API base,
// and S1-02's, S1-03's and S1-74's step writers (writers.ts, answer.ts, reads.ts) through T-1461's walk
// (commit/walk createWritesOf), with T-632's matcher and T-319's openReviewItemCore and decideReviewItemAlone as they are.
// The doubles are the K-05 reads (items 78 and 79 as db/repo answers them), the stop home's reads and T-319's paging
// reader (the frozen seeds' worlds), and T-1461's walk doubles (bundle v1's port, the question read, S1-11's stand-in
// writer for T-634's). Values come from the contracts' fixtures and fixture set v1 (test-support.ts; rule 9):
//   - match-kinds.json gives its response;
//   - commit-s1-02.json's second turn ("All on the list") yields its three picked kinds rows, S1-11 walked (stubbed),
//     S1-04's question with its outbox row and oq-s1-02 closed at its version; the kinds are one unit's state writes in the
//     one K-05 commit request;
//   - "One isn't on the list yet" walks to S1-03 and opens one review item, the business stays offline, and the team's
//     decision (decideReviewItemAlone) writes the draft's state back;
//   - "Not a service we book" walks to S1-74, gives no kind and writes none;
//   - the branch must fit the words; the reads are their own (item 78, item 79), never the call's repo; a port left out,
//     a stopped number and a failed read each fail closed; no error carries the owner's words or the chat id.

import { describe, expect, it } from "vitest";

import { buildCommitRequest } from "../../../commit/build";
import type { UnitWrites } from "../../../commit";
import { contractChecks, eventLogRowsOf } from "../../../commit/test-support";
import { WalkNotBuiltError, createWritesOf, type StepWriter } from "../../../commit/walk";
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
import { TEAM_1, applyPagingWrites, readerOn } from "../../../domain/paging/test-support";
import type { AloneCommitRequest } from "../../../domain/flags";
import { k24Picks } from "../../../domain/kind-matcher/test-support";
import { createToolApi, createToolApiValidator, notBuiltHandlers, NotBuiltError } from "../../index";
import { recordingScope, traceFor, type RecordingRepo } from "../../test-support";
import {
  KindsNotBuiltError,
  KindsReadError,
  KindsRefusedError,
  NO_PATTERN_MET,
  REVIEW_SUMMARY,
  createMatchKinds,
  draftedKindId,
  kindsReadsOf,
  kindsWriters,
  type KindsFault,
  type KindsWriters,
} from "./index";
import {
  GIFT_CARDS,
  PACK_HIKES,
  earlierPick,
  fakeK05,
  matchKindsCatalog,
  matchKindsExchange,
  stoppedWorld,
  turnWithWords,
  writerDeps,
  writerWorlds,
  type FakeK05,
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
    ...notBuiltHandlers<RecordingRepo>(),
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

/** The walk's writesOf on bundle v1, the question read over oq-s1-02's row, this folder's writers and S1-11's stand-in. */
function kindsWalk(k05: FakeK05 = fakeK05(), worlds: WriterWorlds = writerWorlds()) {
  const { bundles } = bundleV1Bundles();
  const questions = questionsOver();
  const bound: Record<string, StepWriter<WalkTestRepo>> = {
    ...kindsWriters(writerDeps(k05.k05, worlds)),
    "S1-11": s1_11Writer,
  };
  const writers = writersOf(bound);
  const writesOf = createWritesOf<WalkTestRepo>({
    bundles,
    turnKey: () => SAM,
    questions: questions.questions,
    writers: writers.writers,
  });
  return { writesOf, calls: writers.calls, asked: k05.asked, worlds };
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

describe("'One isn't on the list yet' walks to S1-03 and opens one review item; the business stays offline", () => {
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
      "review_items",
    ]);
  });

  it("S1-03 drafts it in review and opens exactly one team review item of kind new_work on the draft, due in 1 business day", async () => {
    const { writes, calls, context } = await answer("c-02", words);
    expect(stepsWritten(calls)).toEqual(["S1-02", "S1-03", "S1-11"]);
    expect(inserted(writes, "new_work_drafts")).toEqual([
      {
        id: "draft-s1-03-sam-1",
        picked_kind_id: "pick-s1-02-sam-2",
        business_id: null,
        state: "in_review",
        drafted_at: context.request.now,
      },
    ]);
    const items = inserted(writes, "review_items");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "new_work",
      business_id: null,
      subject_table: "new_work_drafts",
      subject_row_id: "draft-s1-03-sam-1",
      turn_id: "turn-s1-02-sam-kinds",
      raised_by_person_id: "person-sam",
      summary: REVIEW_SUMMARY,
      opened_at: context.request.now,
      due_at: "2026-10-20T14:05:06Z",
      state: "open",
    });
    expect(String(items[0]?.id)).toMatch(/^review-[0-9a-f]{32}$/u);
    expect(
      writes.stateEvents.map((entry) => [entry.kind, entry.tableName, entry.rowId, entry.businessId]),
    ).toEqual([["review_item.opened", "review_items", items[0]?.id, null]]);
  });

  it("the business stays offline: no businesses row is written, and the draft is not approved", async () => {
    const { writes } = await answer("c-02", words);
    expect(writes.state.map((write) => write.table)).not.toContain("businesses");
    expect(inserted(writes, "new_work_drafts").map((row) => row.state)).toEqual(["in_review"]);
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

  it("goes into the one K-05 commit request, which K-05 and K-08 take, the review item's entry naming no business", async () => {
    const { writes, context, exchange } = await answer("c-02", words);
    const request = commitOf(context, writes);
    const checks = contractChecks();
    expect(checks.k05("commitTurn.request", request)).toEqual([]);
    const rows = eventLogRowsOf(request, exchange.request.now);
    for (const row of rows) expect(checks.k08("eventLogRow", row), String(row.id)).toEqual([]);
    expect(checks.k08("eventLogBatch", { rows })).toEqual([]);
  });

  it("Rosie's team decides it with decideReviewItemAlone, which writes the draft's state back: the decision resumes setup", async () => {
    const worlds = writerWorlds();
    const { writes } = await answer("c-02", words, kindsWalk(fakeK05(), worlds));
    const opened: PagingWrites = {
      why: writes.why,
      versionsRead: [],
      state: writes.state.filter((write) => write.table === "review_items"),
      stateEvents: [],
      asks: [],
      messages: [],
      clocks: [],
      clockCancels: [],
    };
    applyPagingWrites(worlds.paging, opened);
    worlds.paging.rows.set("new_work_drafts/draft-s1-03-sam-1", { version: 1, businessId: null });
    const [item] = [...worlds.paging.reviewItems.values()];
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
        reader: () => readerOn(worlds.paging),
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
      written: [
        { table: "review_items", rowId: item.id, version: 2 },
        { table: "new_work_drafts", rowId: "draft-s1-03-sam-1", version: 2 },
      ],
      repeated: false,
    });
    expect(committed[0]?.writes.state).toContainEqual({
      op: "update",
      table: "new_work_drafts",
      key: { id: "draft-s1-03-sam-1" },
      expectVersion: 1,
      set: { state: "approved" },
    });
  });

  it("once the item is on file, the same turn opens no second item: openReviewItem answers repeated, writing none", async () => {
    const worlds = writerWorlds();
    const walk = kindsWalk(fakeK05(), worlds);
    const first = await answer("c-02", words, walk);
    applyPagingWrites(worlds.paging, {
      why: first.writes.why,
      versionsRead: [],
      state: first.writes.state.filter((write) => write.table === "review_items"),
      stateEvents: [],
      asks: [],
      messages: [],
      clocks: [],
      clockCancels: [],
    });
    const again = await answer("c-02", words, walk);
    expect(inserted(again.writes, "review_items")).toEqual([]);
    expect(again.writes.stateEvents).toEqual([]);
    expect(inserted(again.writes, "new_work_drafts")).toEqual(inserted(first.writes, "new_work_drafts"));
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

  it("S1-74's writer itself writes no kind: its message alone", async () => {
    const walk = kindsWalk();
    const { writes } = await answer("c-03", GIFT_CARDS, walk);
    const s1_74 = writes.messages.filter((row) => row.id.startsWith("outbox-s1-74-"));
    expect(s1_74).toHaveLength(1);
    expect(writes.state.every((write) => write.table === "picked_kinds")).toBe(true);
    expect(inserted(writes, "picked_kinds").every((row) => row.kind_id === null)).toBe(true);
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

  it("an answer with no words that name work is refused (noWords)", async () => {
    const { error } = await refusal("c-01", "Hi, 42");
    expectRefused(error, "noWords", ["S1-02"]);
  });
});

describe("a failed read or a port left out fails the part closed", () => {
  it("item 78 transient, item 78 with no trade-file kind, and item 79 notFound each throw KindsReadError, nothing returned", async () => {
    const transient = await refusal(
      "c-01",
      undefined,
      kindsWalk(fakeK05({ catalog: { error: "transient", sqlstate: "40P01" } })),
    );
    expect(transient.error).toBeInstanceOf(KindsReadError);
    expect(transient.error).toMatchObject({
      read: "readKindCatalog",
      fault: "transient",
      answer: { error: "transient", sqlstate: "40P01" },
    });
    const empty = await refusal("c-01", undefined, kindsWalk(fakeK05({ kinds: [] })));
    expect(empty.error).toMatchObject({
      name: "KindsReadError",
      read: "readKindCatalog",
      fault: "noCatalog",
    });
    const gone = await refusal(
      "c-01",
      undefined,
      kindsWalk(fakeK05({ picked: { error: "notFound", table: "persons", rowId: "person-sam" } })),
    );
    expect(gone.error).toMatchObject({ name: "KindsReadError", read: "readPickedKinds", fault: "notFound" });
    // Never K-05's answer raw in the message (DL-935).
    for (const error of [transient.error, empty.error, gone.error]) {
      expect((error as Error).message).not.toMatch(/40P01|person-sam/u);
    }
  });

  it("S1-03 with no paging reader bound, and S1-03 or S1-74 with no stop reads bound, answer notBuilt", async () => {
    const k05 = fakeK05();
    const deps = writerDeps(k05.k05);
    const without = (writers: KindsWriters<WalkTestRepo>) => {
      const { bundles } = bundleV1Bundles();
      return createWritesOf<WalkTestRepo>({
        bundles,
        turnKey: () => SAM,
        questions: questionsOver().questions,
        writers: writersOf({ ...writers, "S1-11": s1_11Writer }).writers,
      });
    };
    const noPaging = without(kindsWriters({ reads: deps.reads, ...(deps.stop ? { stop: deps.stop } : {}) }));
    const noStop = without(
      kindsWriters({ reads: deps.reads, ...(deps.paging ? { paging: deps.paging } : {}) }),
    );
    const run = async (writesOf: typeof noPaging, choiceId: string, words?: string) => {
      const turn = turnWithWords(choiceId, words);
      return writesOf(turn.part, turn.context, NOTHING_OPEN).then(
        () => null,
        (thrown: unknown) => thrown,
      );
    };
    expect(await run(noPaging, "c-02", `Barbershop, ${PACK_HIKES}`)).toMatchObject({
      seam: "pagingNotWired",
      ids: ["S1-03"],
    });
    expect(await run(noStop, "c-02", `Barbershop, ${PACK_HIKES}`)).toMatchObject({
      seam: "stopNotWired",
      ids: ["S1-03"],
    });
    expect(await run(noStop, "c-03")).toMatchObject({ seam: "stopNotWired", ids: ["S1-74"] });
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
    expect(inserted(drafted.writes, "review_items")).toHaveLength(1);
  });

  it("a writer bound to another step refuses (wrongStep), and S1-03 with no S1-02 answer in the run refuses (notAnswered)", async () => {
    const writers = kindsWriters(writerDeps(fakeK05().k05));
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
