// T-1502's proofs for S1-02's settler (K-09 README default 191 as T-1499's round 2 corrects it; DL-1018 card 4, DL-1021),
// unit side: `npm run test:unit -- actions/src/tool-api/journey-1/kinds`. The code under test is real: S1-02's settler and
// the kinds writers built together by kindsSteps (settle.ts, writers.ts, answer.ts, reads.ts), T-632's matcher over the
// 243 seeded kinds, and T-1461's walk with its settler port (commit/walk). The doubles are ports only: the K-05 reads
// (items 78 and 79 as db/repo answers them), the stop home's reads (the frozen seeds' world), and T-1461's walk doubles
// (bundle v1's port, the question read, S1-11's stand-in writer). Values come from the contracts' fixtures and fixture
// set v1 (test-support.ts; rule 9); "dog yoga" is the ruling's own example (DL-1018: "c-01 named, 'Barbershop, dog yoga'
// drafts one kind") and "We do haircuts, beard trims and shaves" K-02 README default 16's.

import { describe, expect, it } from "vitest";

import type { PassedPart, UnitWrites } from "../../../commit";
import {
  createWritesOf,
  flowGraphOf,
  type StepSettler,
  type StepWriter,
  type WalkDeps,
} from "../../../commit/walk";
import {
  NOTHING_OPEN,
  SAM,
  bundleV1Bundles,
  flowAV1,
  questionsOver,
  s1_11Writer,
  writersOf,
  type WalkTestRepo,
} from "../../../commit/walk/test-support";
import type { KindMatch } from "../../../domain/kind-matcher";
import { NotBuiltError } from "../../errors";
import {
  ALL_ON_THE_LIST,
  KindsNotBuiltError,
  KindsReadError,
  KindsRefusedError,
  NOT_A_SERVICE,
  ONE_NOT_LISTED,
  SETTLED_STEP,
  kindsReadsOf,
  kindsSteps,
  kindsWriters,
  matcherOf,
  settleS1_02,
  settledKinds,
  type KindsFault,
} from "./index";
import { GIFT_CARDS, PACK_HIKES, fakeK05, turnWithWords, writerDeps, type FakeK05 } from "./test-support";

/** commit-s1-02.json's words: every part listed. */
const WORDS = "Barbershop, plumbing, electrical";
/** The ruling's example (DL-1018, T-1502's proof), meant as one listed kind and one no catalog kind fits. */
const DOG_YOGA = "Barbershop, dog yoga";
/** One listed kind and one no catalog kind fits: K-24 seed-new-work-draft.json's "pack hikes". */
const NEW_WORK = `Barbershop, ${PACK_HIKES}`;
/** Every part work Rosie never books (RULES 1.4: gift cards; delivery only). */
const ALL_NOT_BOOKED = `${GIFT_CARDS}, delivery only`;
/** Work Rosie books beside work it never books (open gap 169). */
const MIX = `Barbershop, ${GIFT_CARDS}`;
/** K-02 README default 16's text with words before its list: one span, the part's whole quote. */
const HAIRCUTS = "We do haircuts, beard trims and shaves";

/** What the settled walk is given. */
interface Given {
  readonly k05?: FakeK05;
  /** Bind no settler: today's walk with the same writers. */
  readonly noSettler?: boolean;
  /** Bind this settler in place of S1-02's own (with kindsSteps' writers). */
  readonly settler?: StepSettler<WalkTestRepo>;
}

/**
 * The walk's writesOf on bundle v1 with kindsSteps' S1-02 settler and writers (S1-11 stubbed), the question read over
 * oq-s1-02's row, and the stop home's reads; each settler answer or refusal written down.
 */
function settledWalk(given: Given = {}) {
  const k05 = given.k05 ?? fakeK05();
  const { bundles } = bundleV1Bundles();
  const questions = questionsOver();
  const steps = kindsSteps<WalkTestRepo>(writerDeps(k05.k05));
  const writers = writersOf({ ...steps.writers, "S1-11": s1_11Writer });
  const settled: unknown[] = [];
  const own = given.settler ?? steps.settlers[SETTLED_STEP];
  const settler: StepSettler<WalkTestRepo> = (call) =>
    own(call).then(
      (label) => {
        settled.push(label);
        return label;
      },
      (thrown: unknown) => {
        settled.push(thrown);
        return Promise.reject(thrown instanceof Error ? thrown : new Error("a settler threw no Error"));
      },
    );
  const deps: WalkDeps<WalkTestRepo> = {
    bundles,
    turnKey: () => SAM,
    questions: questions.questions,
    writers: writers.writers,
    ...(given.noSettler === true
      ? {}
      : { settlers: (stepId: string) => (stepId === SETTLED_STEP ? settler : null) }),
  };
  return {
    writesOf: createWritesOf<WalkTestRepo>(deps),
    calls: writers.calls,
    asked: k05.asked,
    questionReads: questions.reads,
    settled,
  };
}

type Walk = ReturnType<typeof settledWalk>;

/** Turn 2 naming `choiceId` with `words`, answered by the walk. */
async function answer(walk: Walk, choiceId: string, words?: string) {
  const turn = turnWithWords(choiceId, words);
  const writes = await walk.writesOf(turn.part, turn.context, NOTHING_OPEN);
  return { ...turn, writes };
}

/** What turn 2 naming `choiceId` with `words` threw on the walk, or null. */
async function refusal(walk: Walk, choiceId: string, words?: string): Promise<unknown> {
  const turn = turnWithWords(choiceId, words);
  return walk.writesOf(turn.part, turn.context, NOTHING_OPEN).then(
    () => null,
    (thrown: unknown) => thrown,
  );
}

/** A state write's values, inserts into `table` only. */
function inserted(writes: UnitWrites, table: string): Record<string, unknown>[] {
  return writes.state.flatMap((write) =>
    write.op === "insert" && write.table === table ? [write.values] : [],
  );
}

const stepsWritten = (walk: Walk): string[] => walk.calls.map((call) => call.stepId);

function expectRefused(error: unknown, fault: KindsFault, ids: readonly string[]): void {
  expect(error).toBeInstanceOf(KindsRefusedError);
  expect(error).toMatchObject({ fault, ids });
}

/** The walk rejected before any writer or the question read: nothing returned, so the commit writes nothing. */
function expectNothingWritten(walk: Walk): void {
  expect(walk.calls).toEqual([]);
  expect(walk.questionReads).toEqual([]);
}

// ---------------------------------------------------------------------------------------------------------------

describe("default 191's table, checked from its first row down (settledKinds)", () => {
  const part = (outcome: KindMatch["outcome"]): KindMatch => ({ words: outcome, outcome, kinds: [] });

  it.each([
    ["every part listed", ["listed", "listed"], ALL_ON_THE_LIST],
    ["new work beside listed", ["listed", "new_work"], ONE_NOT_LISTED],
    ["new work alone", ["new_work"], ONE_NOT_LISTED],
    ["every part not booked", ["not_booked", "not_booked"], NOT_A_SERVICE],
  ] as const)("%s: %s", (_, outcomes, branch) => {
    expect(settledKinds(outcomes.map(part), "S1-02")).toBe(branch);
  });

  it("no part is noWords; any which is notBuilt before a mix is refused; not booked beside kept work is notBookedBesideKept", () => {
    expectRefused(
      (() => {
        try {
          return settledKinds([], "S1-02");
        } catch (error) {
          return error;
        }
      })(),
      "noWords",
      ["S1-02"],
    );
    for (const outcomes of [["which"], ["listed", "which"], ["not_booked", "which", "listed"]] as const) {
      expect(() => settledKinds(outcomes.map(part), "S1-02")).toThrow(KindsNotBuiltError);
    }
    for (const outcomes of [
      ["listed", "not_booked"],
      ["not_booked", "new_work"],
      ["listed", "new_work", "not_booked"],
    ] as const) {
      expect(() => settledKinds(outcomes.map(part), "S1-02")).toThrow(
        expect.objectContaining({ fault: "notBookedBesideKept", ids: ["S1-02"] }) as Error,
      );
    }
  });

  it("S1-02's settler answers for S1-02 alone (wrongStep), and refuses words that name nothing before any read (noWords)", async () => {
    const k05 = fakeK05();
    const steps = kindsSteps<WalkTestRepo>(writerDeps(k05.k05));
    const turn = turnWithWords("c-01");
    const graph = flowGraphOf(flowAV1(), "A");
    const s1_03 = graph.step("S1-03");
    if (s1_03 === null) throw new Error("bundle v1 holds S1-03");
    const call = {
      repo: turn.context.repo,
      businessId: turn.context.businessId,
      part: turn.part,
      choice: turn.choice,
      turn: turn.context,
    };
    const wrong = await steps.settlers["S1-02"]({ ...call, step: s1_03 }).catch((thrown: unknown) => thrown);
    expectRefused(wrong, "wrongStep", ["S1-02", "S1-03"]);
    const s1_02 = graph.step("S1-02");
    if (s1_02 === null) throw new Error("bundle v1 holds S1-02");
    const said = turn.part.part;
    if (said.verb !== "choose") throw new Error("commit-s1-02.json's part chooses");
    const bare: PassedPart = { ...turn.part, part: { ...said, quote: " ", fields: [] } };
    const noWords = await settleS1_02(() => Promise.reject(new Error("no read")), {
      ...call,
      step: s1_02,
      part: bare,
    }).catch((thrown: unknown) => thrown);
    expectRefused(noWords, "noWords", ["S1-02"]);
    expect(k05.asked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("S1-02's settler in the walk: the words, not the option named, decide the branch", () => {
  it("c-01 named, the ruling's 'Barbershop, dog yoga': the matcher reads 'dog yoga' as `which` on the 243 kinds, so it is notBuilt with nothing written", async () => {
    const { matcher } = await matcherOf(kindsReadsOf(fakeK05().k05));
    expect(
      matcher
        .match(DOG_YOGA)
        .map((part) => [part.words, part.outcome, part.kinds.map((kind) => kind.kindId)]),
    ).toEqual([
      ["Barbershop", "listed", ["barber"]],
      ["dog yoga", "which", ["yoga", "dog-trainer"]],
    ]);
    const walk = settledWalk();
    const error = await refusal(walk, "c-01", DOG_YOGA);
    expect(error).toBeInstanceOf(KindsNotBuiltError);
    expect(error).toMatchObject({ seam: "which", ids: ["S1-02"] });
    expectNothingWritten(walk);
  });

  it("c-01 named, 'Barbershop, pack hikes' settles 'One isn't on the list yet' and drafts one kind", async () => {
    const walk = settledWalk();
    const { writes } = await answer(walk, "c-01", NEW_WORK);
    expect(walk.settled).toEqual([ONE_NOT_LISTED]);
    expect(writes.why).toEqual({ step: "S1-02", choice: ONE_NOT_LISTED });
    expect(stepsWritten(walk)).toEqual(["S1-02", "S1-03", "S1-11"]);
    // One listed pick, one drafted kind with its new-work pick, and S1-03's draft of it.
    expect(inserted(writes, "picked_kinds").map((row) => [row.words, row.outcome])).toEqual([
      ["Barbershop", "listed"],
      [PACK_HIKES, "new_work"],
    ]);
    const drafted = inserted(writes, "kinds");
    expect(drafted).toHaveLength(1);
    expect(drafted[0]).toMatchObject({ name: PACK_HIKES, source: "new_work" });
    expect(inserted(writes, "new_work_drafts")).toHaveLength(1);
    // S1-03's message, then S1-04's question; S1-02's question closed.
    expect(writes.messages.map((row) => row.id)).toEqual(["outbox-s1-03-sam-1", "outbox-s1-04-sam-1"]);
    expect(writes.closes.map((close) => close.id)).toEqual(["oq-s1-02"]);
    // The writers were handed the part as named: its choice id stays c-01.
    expect(walk.calls.every((call) => call.choiceId === "c-01")).toBe(true);
  });

  it("c-02 named, every part listed gives commit-s1-02.json's rows: today's c-01 writes, to the row", async () => {
    const today = await answer(settledWalk({ noSettler: true }), "c-01");
    const walk = settledWalk();
    const { writes, exchange } = await answer(walk, "c-02");
    expect(walk.settled).toEqual([ALL_ON_THE_LIST]);
    expect(writes).toEqual(today.writes);
    expect(writes.why).toEqual({ step: "S1-02", choice: ALL_ON_THE_LIST });
    expect(inserted(writes, "picked_kinds").map((row) => [row.words, row.outcome, row.kind_id])).toEqual([
      ["Barbershop", "listed", "barber"],
      ["plumbing", "listed", "plumber"],
      ["electrical", "listed", "electrician"],
    ]);
    expect(writes.closes.map((close) => close.id)).toEqual(exchange.outcome.openQuestions.closed);
    expect(writes.asks.map((ask) => ask.question.id)).toEqual(["oq-s1-04-sam-1"]);
    expect(writes.gives).toEqual(exchange.given.stated.gives);
    expect(stepsWritten(walk)).toEqual(["S1-02", "S1-11"]);
  });

  it("c-03 named, every part listed settles 'All on the list' too: the same rows whichever option a read named", async () => {
    const named = await Promise.all(
      ["c-01", "c-02", "c-03"].map(async (choiceId) => (await answer(settledWalk(), choiceId)).writes),
    );
    expect(named[1]).toEqual(named[0]);
    expect(named[2]).toEqual(named[0]);
  });

  it("c-01 named, every part not booked settles 'Not a service we book': not_booked picks, no kind, S1-74's message", async () => {
    const walk = settledWalk();
    const { writes } = await answer(walk, "c-01", ALL_NOT_BOOKED);
    expect(walk.settled).toEqual([NOT_A_SERVICE]);
    expect(writes.why).toEqual({ step: "S1-02", choice: NOT_A_SERVICE });
    expect(stepsWritten(walk)).toEqual(["S1-02", "S1-74"]);
    expect(inserted(writes, "picked_kinds").map((row) => [row.words, row.outcome, row.kind_id])).toEqual([
      [GIFT_CARDS, "not_booked", null],
      ["delivery only", "not_booked", null],
    ]);
    expect(inserted(writes, "kinds")).toEqual([]);
    expect(writes.gives).toEqual([]);
    expect(writes.messages.map((row) => row.id)).toEqual(["outbox-s1-74-sam-1"]);
    // Today's c-03 walk of the same words writes the same rows (it reads no catalog; the settler reads it once).
    const today = await answer(settledWalk({ noSettler: true }), "c-03", ALL_NOT_BOOKED);
    expect(writes).toEqual(today.writes);
  });

  it("the catalog is read once for the walk: the settler and S1-02's writer share it, and item 79 is read once", async () => {
    const k05 = fakeK05();
    const walk = settledWalk({ k05 });
    await answer(walk, "c-02");
    expect(k05.asked).toEqual([
      { read: "readKindCatalog" },
      { read: "readPickedKinds", request: { businessId: "biz-lees-barbershop", personId: "person-sam" } },
    ]);
    // A new walk (a new turn context: a repeat, a re-gate) reads afresh.
    await answer(walk, "c-02");
    expect(k05.asked.map((each) => each.read)).toEqual([
      "readKindCatalog",
      "readPickedKinds",
      "readKindCatalog",
      "readPickedKinds",
    ]);
  });

  it("S1-02's writer keeps its fit check as a second lock: a settler whose branch the words do not fit is refused (branchNotWords)", async () => {
    const walk = settledWalk({ settler: () => Promise.resolve(ALL_ON_THE_LIST) });
    const error = await refusal(walk, "c-02", NEW_WORK);
    expectRefused(error, "branchNotWords", ["S1-02", "new_work"]);
    expect(stepsWritten(walk)).toEqual(["S1-02"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("what the settler refuses is refused whichever option was named, with nothing written", () => {
  it.each(["c-01", "c-02", "c-03"])(
    "not booked beside kept work is refused with nothing written (%s named): notBookedBesideKept",
    async (choiceId) => {
      const walk = settledWalk();
      const error = await refusal(walk, choiceId, MIX);
      expectRefused(error, "notBookedBesideKept", ["S1-02"]);
      expectNothingWritten(walk);
      for (const words of ["Barbershop", "Gift", "gift"])
        expect((error as Error).message).not.toContain(words);
    },
  );

  it("where today's c-03 kept the mix as not-booked picks, the settled walk no longer saves it", async () => {
    const today = await answer(settledWalk({ noSettler: true }), "c-03", MIX);
    expect(inserted(today.writes, "picked_kinds").map((row) => row.outcome)).toEqual([
      "not_booked",
      "not_booked",
    ]);
    expectRefused(await refusal(settledWalk(), "c-03", MIX), "notBookedBesideKept", ["S1-02"]);
  });

  it.each([
    ["c-01", "trainer"],
    ["c-03", "trainer"],
    ["c-01", "Barbershop, trainer"],
    ["c-02", `Barbershop, trainer, ${PACK_HIKES}`],
  ] as const)(
    "a `which` part is not built with nothing written (%s named, '%s')",
    async (choiceId, words) => {
      const walk = settledWalk();
      const error = await refusal(walk, choiceId, words);
      expect(error).toBeInstanceOf(KindsNotBuiltError);
      expect(error).toBeInstanceOf(NotBuiltError);
      expect(error).toMatchObject({ seam: "which", ids: ["S1-02"], call: "gateAndCommit" });
      expectNothingWritten(walk);
    },
  );

  it("a settler that refuses leaves the question open with nothing written: words that name no work (noWords)", async () => {
    const walk = settledWalk();
    expectRefused(await refusal(walk, "c-01", "Hi, 42"), "noWords", ["S1-02"]);
    expectNothingWritten(walk);
  });

  it.each([
    ["item 78 transient", fakeK05({ catalog: { error: "transient", sqlstate: "40P01" } }), "transient"],
    ["item 78 with no trade-file kind", fakeK05({ kinds: [] }), "noCatalog"],
  ] as const)(
    "a settler whose read fails leaves the question open with nothing written (%s)",
    async (_, k05, fault) => {
      const walk = settledWalk({ k05 });
      const error = await refusal(walk, "c-01");
      expect(error).toBeInstanceOf(KindsReadError);
      expect(error).toMatchObject({ read: "readKindCatalog", fault });
      expectNothingWritten(walk);
      expect(k05.asked).toEqual([{ read: "readKindCatalog" }]);
    },
  );

  it("an empty catalog fails closed (noCatalog) even when every part is not booked, where today's c-03 read none", async () => {
    const today = await answer(
      settledWalk({ noSettler: true, k05: fakeK05({ kinds: [] }) }),
      "c-03",
      GIFT_CARDS,
    );
    expect(inserted(today.writes, "picked_kinds")).toHaveLength(1);
    const walk = settledWalk({ k05: fakeK05({ kinds: [] }) });
    const error = await refusal(walk, "c-03", GIFT_CARDS);
    expect(error).toBeInstanceOf(KindsReadError);
    expect(error).toMatchObject({ read: "readKindCatalog", fault: "noCatalog" });
    expectNothingWritten(walk);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("no settler bound: today's walk, and branchNotWords as today", () => {
  it.each([
    ["c-02 named with every part listed", "c-02", undefined, ["S1-02", "listed"]],
    ["c-01 named with a new part", "c-01", NEW_WORK, ["S1-02", "new_work"]],
    ["c-01 named with a mix", "c-01", MIX, ["S1-02", "not_booked"]],
  ] as const)("%s is refused branchNotWords, as before", async (_, choiceId, words, ids) => {
    for (const walk of [settledWalk({ noSettler: true }), noSettlerOver(kindsWriters)]) {
      expectRefused(await refusal(walk, choiceId, words), "branchNotWords", ids);
      expect(stepsWritten(walk)).toEqual(["S1-02"]);
    }
  });

  it("c-01 named with every part listed commits commit-s1-02.json's rows, as before", async () => {
    const walk = settledWalk({ noSettler: true });
    const { writes } = await answer(walk, "c-01");
    expect(writes.why).toEqual({ step: "S1-02", choice: ALL_ON_THE_LIST });
    expect(inserted(writes, "picked_kinds")).toHaveLength(3);
    expect(walk.settled).toEqual([]);
  });
});

/** Today's binding: the kinds writers alone (kindsWriters, a catalog read of their own), no settler. */
function noSettlerOver(writersFor: typeof kindsWriters): Walk {
  const k05 = fakeK05();
  const { bundles } = bundleV1Bundles();
  const questions = questionsOver();
  const bound: Record<string, StepWriter<WalkTestRepo>> = {
    ...writersFor<WalkTestRepo>(writerDeps(k05.k05)),
    "S1-11": s1_11Writer,
  };
  const writers = writersOf(bound);
  return {
    writesOf: createWritesOf<WalkTestRepo>({
      bundles,
      turnKey: () => SAM,
      questions: questions.questions,
      writers: writers.writers,
    }),
    calls: writers.calls,
    asked: k05.asked,
    questionReads: questions.reads,
    settled: [],
  };
}

// ---------------------------------------------------------------------------------------------------------------

describe("open gap 172: words before the list stay in the first part (K-02 README default 16)", () => {
  it("'We do haircuts, beard trims and shaves': the one span splits at its comma alone, and the matcher reads each part", async () => {
    const { matcher } = await matcherOf(kindsReadsOf(fakeK05().k05));
    const parts = matcher.match(HAIRCUTS);
    // The split is at commas, semicolons and line breaks alone: "We do" stays in the first part, "and" splits nothing.
    expect(parts.map((part) => part.words)).toEqual(["We do haircuts", "beard trims and shaves"]);
    // What the matcher reads of each (reported for the architect: open gap 172): "We do haircuts" is `which` (two kinds
    // fit "haircut"), and "beard trims and shaves" is new work (no kind reaches the floor).
    expect(parts.map((part) => [part.outcome, part.kinds.map((kind) => kind.kindId)])).toEqual([
      ["which", ["hair", "hair-restoration"]],
      ["new_work", []],
    ]);
    // "We do haircuts" reads as "haircuts" would alone: "we" and "do" are function words the matcher drops.
    const alone = matcher.match("haircuts");
    expect(alone.map((part) => [part.outcome, part.kinds])).toEqual(
      parts.slice(0, 1).map((part) => [part.outcome, part.kinds]),
    );
  });

  it("settled through the walk with c-01 named, the whole text as the field's words: notBuilt (which), nothing written", async () => {
    const walk = settledWalk();
    const error = await refusal(walk, "c-01", HAIRCUTS);
    expect(error).toBeInstanceOf(KindsNotBuiltError);
    expect(error).toMatchObject({ seam: "which", ids: ["S1-02"] });
    expect(walk.settled).toEqual([error]);
    expectNothingWritten(walk);
  });
});
