// T-634 part 1 (DL-961 card E; DL-988; DL-994): S1-11's read-only step writer, the first kind named's plug-in loaded
// from the turn's pinned bundle (the 11 pf keys stored whole, with MC C5's fills). Proved on bundle v1 (bundles/v1,
// T-1460: every trade's compiled overlay) with T-1461's walk doubles (commit/walk/test-support.ts: the bundle v1 port,
// the question read, the stand-in writers) and this folder's two (./test-support.ts: the trade port over bundle v1, and
// a stand-in for T-633's S1-02 writer), never of the writer or the walk:
//   - the plan's first two lines: insurance gets facts video, forms, firststeps, documents; each of the 12 trades with no
//     pf.settings gets arrival "window" and an empty free-cancel time, marked to confirm at S1-21;
//   - the first kind named gets its 11 pf keys from the pinned overlay, byte for byte (each of the 243 trades as the
//     first pick), with one overlay read, and no other pick gets any;
//   - S1-02's answer walks S1-11 with this writer and stops at S1-04's question, with T-633's writer stubbed;
//   - what it refuses (a first kind the bundle lacks, no picks, a pick of another business or not K-24's shape, an
//     overlay not K-01's), each with nothing written, and the same part twice gives the same writes.

import { describe, expect, it } from "vitest";

import { buildCommitRequest } from "../../../commit/build";
import { contractChecks } from "../../../commit/test-support";
import type { StateWrite, UnitWrites } from "../../../commit/types";
import { createWritesOf, type StepWriter } from "../../../commit/walk";
import {
  NOTHING_OPEN,
  SAM,
  bundleV1Bundles,
  bundleV1Id,
  decidedOf,
  questionsOver,
  requestTurnFields,
  s1_02Writer,
  tellingWriter,
  turnTwoOnV1,
  writersOf,
  type WalkTestRepo,
} from "../../../commit/walk/test-support";
import { copy } from "../../../gate/framework/test-support";
import { contractFile } from "../../test-support";
import {
  C5_INSURANCE_FACTS,
  PF_TEXT_KEYS,
  PlugInRefusedError,
  createPlugInWriters,
  loadPlugIn,
  type PlugInFault,
} from "./index";
import {
  overlayV1,
  picksWriter,
  samSeedPicks,
  tradesOverV1,
  tradesV1,
  type StandInPick,
} from "./test-support";

/** MC C5's 12 trades with no pf.settings, as Master Corrections section 3 row C5 lists them. */
const C5_NO_SETTINGS = [
  "art-classes",
  "band",
  "clown",
  "coding-classes",
  "comedian",
  "cooking-classes",
  "dance",
  "dj",
  "inspector",
  "insurance",
  "language-school",
  "party-characters",
];

/** The call's business in commit-s1-02.json (Lee's Barbershop). */
const BARBERSHOP = "biz-lees-barbershop";

/** K-24's seed-new-work-draft.json's drafted pick: Sam's "pack hikes", drafted as new work. */
function draftedPick(): StandInPick {
  const seed = contractFile("db-schema/kinds-of-work/fixtures/seed-new-work-draft.json") as {
    rows: { table: string; values: Record<string, unknown> }[];
  };
  const row = seed.rows.find((each) => each.table === "picked_kinds");
  if (row === undefined) throw new Error("seed-new-work-draft.json drafts a pick");
  return { words: String(row.values.words), outcome: "new_work", kindId: String(row.values.kind_id) };
}

/** Work Rosie never books (MASTER-FLOW-A S1-02: "Gift cards are never set up either"), kept with no kind (S1-74). */
const NOT_BOOKED: StandInPick = { words: "gift cards", outcome: "not_booked", kindId: null };

/** A trade-file pick of `kindId`, at `position` when given (else its place in the answer). */
const listed = (kindId: string, position?: number): StandInPick =>
  position === undefined
    ? { words: kindId, outcome: "listed", kindId }
    : { words: kindId, outcome: "listed", kindId, position };

/** Sam's three picks through the stand-in, each picked_kinds insert's `position` as `change` leaves it. */
function repositioned(change: (values: Record<string, unknown>) => void): StepWriter<WalkTestRepo> {
  const inner = picksWriter();
  return async (call) => {
    const rows = await inner(call);
    const state = rows.state.map((write): StateWrite => {
      if (write.op !== "insert") return write;
      const values = { ...write.values };
      change(values);
      return { ...write, values };
    });
    return { ...rows, state };
  };
}

/** Sam's three picks' kinds (K-24 seed-business-kinds.json): barber, plumber, electrician. */
function samKinds(): string[] {
  return samSeedPicks().map((pick) => String(pick.kindId));
}

// ---------------------------------------------------------------------------------------------------------------
// The walk with S1-11's writer

interface Given {
  /** S1-02's stand-in (T-633's writer stubbed). Default: Sam's three picks, K-24's seed kinds, not placed yet. */
  readonly s1_02?: StepWriter<WalkTestRepo>;
  /** Whether S1-02's writer is bound through `kinds`. Default true. */
  readonly kept?: boolean;
  /** Overlays the trade port hands in place of bundle v1's own, by trade id. */
  readonly overlays?: Readonly<Record<string, unknown>>;
  /** Writers bound in place of the defaults, by step id. */
  readonly writers?: Readonly<Record<string, StepWriter<WalkTestRepo>>>;
}

/** The walk on bundle v1 with S1-11's writer, S1-02's stand-in through `kinds`, and S1-03's and S1-74's stand-ins. */
function plugInWalk(given: Given = {}) {
  const trades = tradesOverV1(given.overlays);
  const plugIns = createPlugInWriters<WalkTestRepo>({ bundles: trades.bundles });
  const s1_02 = given.s1_02 ?? picksWriter();
  const writers = writersOf({
    "S1-02": given.kept === false ? s1_02 : plugIns.kinds(s1_02),
    "S1-11": plugIns.plugIns,
    "S1-03": tellingWriter,
    "S1-74": tellingWriter,
    ...given.writers,
  });
  const { bundles } = bundleV1Bundles();
  const questions = questionsOver();
  const writesOf = createWritesOf<WalkTestRepo>({
    bundles,
    turnKey: () => SAM,
    questions: questions.questions,
    writers: writers.writers,
  });
  return { writesOf, plugIns, calls: writers.calls, tradeReads: trades.reads };
}

/** Turn 2's part choosing `choiceId` (commit-s1-02.json's request on bundle v1), answered by the walk `walk`. */
async function answer(choiceId = "c-01", walk = plugInWalk()) {
  const turn = turnTwoOnV1(choiceId);
  const writes = await walk.writesOf(turn.part, turn.context, NOTHING_OPEN);
  return { ...turn, ...walk, writes };
}

/** What turn 2's part choosing `choiceId` threw on the walk `walk`, or null. */
async function refusal(choiceId = "c-01", walk = plugInWalk()) {
  const turn = turnTwoOnV1(choiceId);
  const error = await walk.writesOf(turn.part, turn.context, NOTHING_OPEN).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  return { ...turn, ...walk, error };
}

/** The values of an insert. */
function valuesOf(write: StateWrite): Record<string, unknown> {
  if (write.op !== "insert") throw new Error("an insert");
  return write.values;
}

/** The state writes into `table`, in order. */
function rowsOf(writes: UnitWrites, table: string): StateWrite[] {
  return writes.state.filter((write) => write.op === "insert" && write.table === table);
}

/** The picked_kind_texts inserts the pick `pickId` of the kind `kindId` gets: its overlay's 11 blocks, in key order. */
function expectedTexts(pickId: string, kindId: string, businessId: string | null = null): StateWrite[] {
  const blocks = overlayV1(kindId).pluginText as Record<string, string>;
  return PF_TEXT_KEYS.map((key) => ({
    op: "insert",
    table: "picked_kind_texts",
    values: { picked_kind_id: pickId, pf_key: key, business_id: businessId, block: blocks[key] },
  }));
}

/** Expects S1-11's writer's refusal with this fault and these ids. */
function expectRefused(error: unknown, fault: PlugInFault, ids: readonly string[] = ["S1-11"]): void {
  expect(error).toBeInstanceOf(PlugInRefusedError);
  expect(error).toMatchObject({ fault, ids });
}

/** What loadPlugIn threw, or null. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The plan's first two lines: MC C5's fills

describe("MC C5's fills, as S1-11 loads each kind's plug-in from bundle v1", () => {
  it("insurance gets facts video, forms, firststeps and documents: cpa.json's list, in cpa.json's order", () => {
    const insurance = loadPlugIn(overlayV1("insurance"), "insurance");
    expect(insurance.facts).toEqual(["forms", "firststeps", "documents", "video"]);
    expect([...(insurance.facts ?? [])].sort()).toEqual(["documents", "firststeps", "forms", "video"]);
    // MC C5: "the list cpa.json has" (CQ-129 (a)'s default for the order).
    expect(insurance.facts).toEqual(loadPlugIn(overlayV1("cpa"), "cpa").facts);
    expect(insurance.facts).toEqual(C5_INSURANCE_FACTS);
  });

  it("an overlay built without C5's fill (insurance's facts null, as insurance.json writes them) still loads them", () => {
    const raw = overlayV1("insurance");
    raw.facts = null;
    expect(loadPlugIn(raw, "insurance").facts).toEqual(["forms", "firststeps", "documents", "video"]);
    // Only insurance is filled: another trade with no facts list loads none (every fact-gated branch shows).
    const barber = overlayV1("barber");
    barber.facts = null;
    expect(loadPlugIn(barber, "barber").facts).toBeNull();
  });

  it.each(C5_NO_SETTINGS)(
    "%s, with no pf.settings, gets arrival window and an empty free-cancel time in both flows, marked to confirm at S1-21",
    (trade) => {
      const { settings } = loadPlugIn(overlayV1(trade), trade);
      const start = { arrive: "window", windowHours: null, cutoff: null, confirmAt: "S1-21" };
      expect(settings).toEqual({ A: start, B: start });
    },
  );

  it("a flow with no settings takes C5's start values; a trade's own settings are kept, each marked to confirm at S1-21", () => {
    const barber = overlayV1("barber");
    const flows = barber.flows as Record<string, Record<string, unknown>>;
    Reflect.deleteProperty(flows.A ?? {}, "settings");
    expect(loadPlugIn(barber, "barber").settings).toEqual({
      A: { arrive: "window", windowHours: null, cutoff: null, confirmAt: "S1-21" },
      B: { arrive: "setstart", windowHours: null, cutoff: "24 hours before", confirmAt: "S1-21" },
    });
    // dog-walker.json's flow B: a 2-hour window (K-01 tradeSettings { window: 2 }) and a per-flow free-cancel time.
    expect(loadPlugIn(overlayV1("dog-walker"), "dog-walker").settings).toEqual({
      A: { arrive: "setstart", windowHours: null, cutoff: "24 hours before", confirmAt: "S1-21" },
      B: { arrive: "window", windowHours: 2, cutoff: "8pm the day before", confirmAt: "S1-21" },
    });
  });

  it("the loaded blocks are the overlay's own and the overlay given is not changed", () => {
    const overlay = overlayV1("insurance");
    const given = copy(overlay);
    const { blocks, kindId } = loadPlugIn(overlay, "insurance");
    expect(kindId).toBe("insurance");
    expect(blocks.map((each) => each.key)).toEqual([...PF_TEXT_KEYS]);
    const text = overlay.pluginText as Record<string, string>;
    for (const { key, block } of blocks) expect(block).toBe(text[key]);
    expect(overlay).toEqual(given);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The first kind named gets its 11 pf keys from the pinned overlay

describe("the first kind named gets its 11 pf keys from the pinned overlay, stored whole", () => {
  it("Sam's three picks (barber, plumber, electrician) give 11 picked_kind_texts rows, all the barbershop pick's, with one trade read", async () => {
    const { writes, tradeReads, context } = await answer("c-01");
    const picks = rowsOf(writes, "picked_kinds").map(valuesOf);
    expect(picks.map((pick) => pick.kind_id)).toEqual(["barber", "plumber", "electrician"]);
    expect(picks.map((pick) => pick.position)).toEqual([1, 2, 3]);
    // The barbershop's now; plumbing's and electrical's when Sam gets to them (MASTER-FLOW-A.md:73).
    expect(rowsOf(writes, "picked_kind_texts")).toEqual(expectedTexts(String(picks[0]?.id), "barber"));
    expect(rowsOf(writes, "picked_kind_texts")).toHaveLength(11);
    // Exactly one overlay read, under the turn's pinned bundle id.
    expect(tradeReads).toEqual([{ bundleId: bundleV1Id(), tradeId: "barber" }]);
    expect(tradeReads[0]?.bundleId).toEqual(context.turn.bundleId);
    expect(writes.gives).toEqual(["kinds", ...PF_TEXT_KEYS]);
    // In the walk's order: S1-02's picks first, so the pick is inserted before the blocks that name it.
    expect(writes.state.map((write) => write.table)).toEqual([
      ...Array<string>(3).fill("picked_kinds"),
      ...Array<string>(11).fill("picked_kind_texts"),
    ]);
  });

  it("each of bundle v1's 243 trades, loaded, gives its 11 blocks from its own overlay, byte for byte, each JSON text", () => {
    const trades = tradesV1();
    expect(trades).toHaveLength(243);
    for (const trade of trades) {
      const overlay = overlayV1(trade);
      const text = overlay.pluginText as Record<string, string>;
      const { blocks, kindId } = loadPlugIn(overlay, trade);
      expect(kindId).toBe(trade);
      expect(blocks.map((each) => each.key)).toEqual([...PF_TEXT_KEYS]);
      for (const { key, block } of blocks) {
        expect(block, trade).toBe(text[key]);
        expect(() => JSON.parse(block) as unknown).not.toThrow();
      }
    }
  });

  it("each of bundle v1's 243 trades, named first, gets its own 11 blocks through the writer with one trade read, and the kind named after it none", async () => {
    const trades = tradesV1();
    expect(trades).toHaveLength(243);
    const next = (index: number): string => String(trades[(index + 1) % trades.length]);
    for (const [index, trade] of trades.entries()) {
      const s1_02 = picksWriter([listed(trade), listed(next(index))]);
      const { writes, tradeReads } = await answer("c-01", plugInWalk({ s1_02 }));
      expect(rowsOf(writes, "picked_kind_texts"), trade).toEqual(expectedTexts("pick-s1-02-sam-1", trade));
      expect(
        tradeReads.map((read) => read.tradeId),
        trade,
      ).toEqual([trade]);
    }
  }, 60_000);

  it("a later pick of the same kind gets no blocks: the first kind named alone is loaded, with one read", async () => {
    const twice = picksWriter([listed("barber"), listed("plumber"), listed("barber")]);
    const { writes, tradeReads } = await answer("c-01", plugInWalk({ s1_02: twice }));
    expect(tradeReads).toEqual([{ bundleId: bundleV1Id(), tradeId: "barber" }]);
    expect(rowsOf(writes, "picked_kind_texts")).toEqual(expectedTexts("pick-s1-02-sam-1", "barber"));
  });

  it("picks at positions 4 and 5 load position 4's kind alone, with one trade read", async () => {
    const later = picksWriter([listed("plumber", 4), listed("electrician", 5)]);
    const { writes, tradeReads } = await answer("c-01", plugInWalk({ s1_02: later }));
    expect(rowsOf(writes, "picked_kinds").map((row) => valuesOf(row).position)).toEqual([4, 5]);
    expect(rowsOf(writes, "picked_kind_texts")).toEqual(expectedTexts("pick-s1-02-sam-1", "plumber"));
    expect(tradeReads).toEqual([{ bundleId: bundleV1Id(), tradeId: "plumber" }]);
    expect(writes.gives).toEqual(["kinds", ...PF_TEXT_KEYS]);
  });

  it("the lowest position is the first kind named, whatever order S1-02's rows come in; of two at one position, the row given first", async () => {
    const reversed = picksWriter([listed("electrician", 5), listed("plumber", 4)]);
    const first = await answer("c-01", plugInWalk({ s1_02: reversed }));
    expect(rowsOf(first.writes, "picked_kind_texts")).toEqual(expectedTexts("pick-s1-02-sam-2", "plumber"));
    expect(first.tradeReads.map((read) => read.tradeId)).toEqual(["plumber"]);
    const tied = picksWriter([listed("electrician", 2), listed("plumber", 2)]);
    const second = await answer("c-01", plugInWalk({ s1_02: tied }));
    expect(rowsOf(second.writes, "picked_kind_texts")).toEqual(
      expectedTexts("pick-s1-02-sam-1", "electrician"),
    );
    expect(second.tradeReads.map((read) => read.tradeId)).toEqual(["electrician"]);
  });

  it("a first pick placed in the call's business gives blocks of that business, as K-24's composite key holds them", async () => {
    const placed = picksWriter(samSeedPicks(), BARBERSHOP);
    const { writes } = await answer("c-01", plugInWalk({ s1_02: placed }));
    const texts = rowsOf(writes, "picked_kind_texts").map(valuesOf);
    expect(texts).toHaveLength(11);
    expect(new Set(texts.map((text) => text.business_id))).toEqual(new Set([BARBERSHOP]));
    expect(rowsOf(writes, "picked_kind_texts")).toEqual(
      expectedTexts("pick-s1-02-sam-1", String(samKinds()[0]), BARBERSHOP),
    );
  });

  it("a listed first kind is loaded, and a pick drafted as new work and one not booked after it get no blocks", async () => {
    const mixed = picksWriter([listed("barber"), draftedPick(), NOT_BOOKED]);
    const { writes, tradeReads } = await answer("c-01", plugInWalk({ s1_02: mixed }));
    expect(rowsOf(writes, "picked_kind_texts")).toEqual(expectedTexts("pick-s1-02-sam-1", "barber"));
    expect(tradeReads.map((read) => read.tradeId)).toEqual(["barber"]);
    expect(writes.gives).toEqual(["kinds", ...PF_TEXT_KEYS]);
  });

  it("a first kind that is new work loads nothing, even with a listed kind named after it: no read, state [] and gives []", async () => {
    const draftedFirst = picksWriter([draftedPick(), listed("barber")]);
    const { writes, calls, tradeReads } = await answer("c-01", plugInWalk({ s1_02: draftedFirst }));
    expect(calls.map((call) => call.stepId)).toEqual(["S1-02", "S1-11"]);
    expect(rowsOf(writes, "picked_kind_texts")).toEqual([]);
    expect(tradeReads).toEqual([]);
    expect(writes.gives).toEqual(["kinds"]);
    expect(writes.asks.map((ask) => ask.question.step)).toEqual(["S1-04"]);
  });

  it("a pick not booked is never the first kind named: the lowest-position kept pick after it is loaded", async () => {
    const notBookedFirst = picksWriter([NOT_BOOKED, listed("plumber"), listed("barber")]);
    const { writes, tradeReads } = await answer("c-01", plugInWalk({ s1_02: notBookedFirst }));
    expect(rowsOf(writes, "picked_kind_texts")).toEqual(expectedTexts("pick-s1-02-sam-2", "plumber"));
    expect(tradeReads.map((read) => read.tradeId)).toEqual(["plumber"]);
  });

  it.each([
    ["only a pick not booked", [NOT_BOOKED]],
    ["a pick drafted as new work, then one not booked", [draftedPick(), NOT_BOOKED]],
    ["no pick at all", []],
  ] as const)("with %s, S1-11 writes nothing and gives no pf key", async (_, picks) => {
    const { writes, calls, tradeReads } = await answer("c-01", plugInWalk({ s1_02: picksWriter(picks) }));
    expect(calls.map((call) => call.stepId)).toEqual(["S1-02", "S1-11"]);
    expect(rowsOf(writes, "picked_kind_texts")).toEqual([]);
    expect(tradeReads).toEqual([]);
    expect(writes.gives).toEqual(["kinds"]);
    expect(writes.asks.map((ask) => ask.question.step)).toEqual(["S1-04"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// S1-02's answer walks S1-11 with this writer and stops at S1-04's question (T-633's writer stubbed)

describe("S1-02's answer walks S1-11 with this writer and stops at S1-04's question, T-633's writer stubbed", () => {
  it("'All on the list': S1-02's picks, S1-11's blocks, S1-04's question and quick reply, oq-s1-02 closed at its version", async () => {
    const { writes, calls, context, exchange } = await answer("c-01");
    expect(calls.map((call) => call.stepId)).toEqual(["S1-02", "S1-11"]);
    expect(calls.every((call) => call.repo === context.repo)).toBe(true);
    expect(writes.why).toEqual({ step: "S1-02", choice: "All on the list" });
    // The keys: S1-02's kinds and S1-11's eleven pf keys, as commit-s1-02.json states them and its outcome answers.
    expect(writes.gives).toEqual(exchange.given.stated.gives);
    expect(writes.gives).toEqual(exchange.outcome.parts[0]?.gives);
    // S1-04's question to Sam at Lee's Barbershop and the quick reply asking it, then nothing after it.
    expect(writes.asks.map((ask) => [ask.question.id, ask.question.step])).toEqual([
      ["oq-s1-04-sam-1", "S1-04"],
    ]);
    expect(writes.messages.map((row) => [row.id, row.openQuestionId])).toEqual([
      ["outbox-s1-04-sam-1", "oq-s1-04-sam-1"],
    ]);
    expect(writes.closes).toEqual([
      { id: "oq-s1-02", expectVersion: 2, status: "answered", answeredOptionId: null },
    ]);
    expect(writes.versionsRead).toEqual([{ table: "open_questions", rowId: "oq-s1-02", version: 2 }]);
    // No event-log entry for picks or their blocks (CQ-56), no reservation, no effect, no clock cancel.
    expect(writes.stateEvents).toEqual([]);
    expect(writes.clockCancels).toEqual([]);
    expect(writes.reservations).toEqual({ confirm: [], release: [] });
    expect(writes.effects).toEqual({ write: [], letGo: [] });
    for (const named of ["S1-08", "s1-08"]) expect(JSON.stringify(writes)).not.toContain(named);
  });

  it("'One isn't on the list yet' walks S1-03, then S1-11 loads the first kind named, a listed one, then S1-04's question", async () => {
    const mixed = picksWriter([listed("barber"), draftedPick()]);
    const { writes, calls } = await answer("c-02", plugInWalk({ s1_02: mixed }));
    expect(calls.map((call) => call.stepId)).toEqual(["S1-02", "S1-03", "S1-11"]);
    expect(rowsOf(writes, "picked_kind_texts")).toEqual(expectedTexts("pick-s1-02-sam-1", "barber"));
    expect(writes.messages.map((row) => row.id)).toEqual(["outbox-s1-03-sam-1", "outbox-s1-04-sam-1"]);
  });

  it("'Not a service we book' never reaches S1-11: no overlay is read and no block written", async () => {
    const { writes, calls, tradeReads } = await answer(
      "c-03",
      plugInWalk({ s1_02: picksWriter([NOT_BOOKED]) }),
    );
    expect(calls.map((call) => call.stepId)).toEqual(["S1-02", "S1-74"]);
    expect(tradeReads).toEqual([]);
    expect(rowsOf(writes, "picked_kind_texts")).toEqual([]);
  });

  it("every row is K-05's own shape, and the part goes into the commit's one K-05 request", async () => {
    const { writes, context } = await answer("c-01");
    const checks = contractChecks();
    for (const write of writes.state) expect(checks.k05("stateWrite", write)).toEqual([]);
    const { people } = decidedOf(context.request).context.writer;
    const personId = context.request.caller.personId;
    const person = people.find((each) => each.personId === personId);
    const request = buildCommitRequest({
      turn: context.turn,
      zone: "America/New_York",
      businessId: context.businessId,
      actor: {
        personId,
        roleAt: (businessId) => person?.roles.find((role) => role.businessId === businessId)?.role ?? null,
      },
      units: [{ writes, answer: { openQuestionId: "oq-s1-02", optionId: null, eventId: "evt-sam-0001" } }],
    });
    expect(checks.k05("commitTurn.request", request)).toEqual([]);
    expect(request.writes.state.filter((write) => write.table === "picked_kind_texts")).toHaveLength(11);
    expect(request.writes.openQuestions.open.map((question) => question.id)).toEqual(["oq-s1-04-sam-1"]);
  });

  it("S1-02's rows go back unchanged through `kinds`, and the same part twice gives the same writes", async () => {
    const walk = plugInWalk();
    const { part, context } = turnTwoOnV1("c-01");
    const given = copy({ part, request: context.request, turn: context.turn });
    const first = await walk.writesOf(part, context, NOTHING_OPEN);
    const second = await walk.writesOf(part, context, NOTHING_OPEN);
    expect(second).toEqual(first);
    expect(copy({ part, request: context.request, turn: context.turn })).toEqual(given);
    expect(walk.calls.map((call) => call.stepId)).toEqual(["S1-02", "S1-11", "S1-02", "S1-11"]);
    // One overlay read a walk: the first kind named's, read again by the repeat (nothing is kept between walks' reads).
    expect(walk.tradeReads.map((read) => read.tradeId)).toEqual(["barber", "barber"]);
    // The picks are the stand-in's own rows, as it gives them unwrapped.
    const unwrapped = await answer(
      "c-01",
      plugInWalk({ kept: false, writers: { "S1-11": writesNothing() } }),
    );
    expect(rowsOf(first, "picked_kinds")).toEqual(rowsOf(unwrapped.writes, "picked_kinds"));
  });
});

/** A stand-in for S1-11 that writes nothing and gives nothing, to read S1-02's rows alone. */
function writesNothing(): StepWriter<WalkTestRepo> {
  return () => Promise.resolve({ state: [], stateEvents: [], gives: [], asks: [], messages: [] });
}

// ---------------------------------------------------------------------------------------------------------------
// What S1-11's writer refuses, with nothing written

describe("what S1-11's writer refuses: the call fails closed with nothing written", () => {
  it("a first kind the pinned bundle holds no overlay for (match-kinds.json's illustrative ids) is refused, after its one read", async () => {
    // commit/walk/test-support.ts's stand-in gives match-kinds.json's kind ids (barbershop, plumbing, electrical: "The
    // kind ids illustrate K-24's id form"), which bundle v1 holds no overlay for.
    const { error, tradeReads } = await refusal("c-01", plugInWalk({ s1_02: s1_02Writer }));
    expectRefused(error, "kindNotInBundle", ["S1-11", "barbershop"]);
    expect(tradeReads.map((read) => read.tradeId)).toEqual(["barbershop"]);
  });

  it("the first kind named, when the pinned bundle answers none for it, refuses the whole part, whatever the other kinds hold", async () => {
    const { error, tradeReads } = await refusal("c-01", plugInWalk({ overlays: { barber: null } }));
    expectRefused(error, "kindNotInBundle", ["S1-11", "barber"]);
    expect(tradeReads.map((read) => read.tradeId)).toEqual(["barber"]);
  });

  it("a later kind with no overlay, or one not K-01's, no longer refuses the part: it is never read", async () => {
    const overlays = { plumber: null, electrician: { contract: "bundle.v2" } };
    const { writes, tradeReads } = await answer("c-01", plugInWalk({ overlays }));
    expect(rowsOf(writes, "picked_kind_texts")).toEqual(expectedTexts("pick-s1-02-sam-1", "barber"));
    expect(tradeReads.map((read) => read.tradeId)).toEqual(["barber"]);
    // A later pick whose kind bundle v1 never held (match-kinds.json's illustrative id) is not read either.
    const unknownLater = picksWriter([listed("barber"), listed("plumbing")]);
    const second = await answer("c-01", plugInWalk({ s1_02: unknownLater }));
    expect(second.tradeReads.map((read) => read.tradeId)).toEqual(["barber"]);
    expect(rowsOf(second.writes, "picked_kind_texts")).toHaveLength(11);
  });

  it("S1-11 walked with no picks kept from S1-02's writer (bound without `kinds`) is refused (noPicks)", async () => {
    const { error, tradeReads } = await refusal("c-01", plugInWalk({ kept: false }));
    expectRefused(error, "noPicks");
    expect(tradeReads).toEqual([]);
  });

  it("picks kept for one walk are not another's: they go with the turn context that walked them", async () => {
    const walk = plugInWalk();
    const { part, context } = turnTwoOnV1("c-01");
    await walk.writesOf(part, context, NOTHING_OPEN);
    expect(walk.tradeReads).toHaveLength(1);
    // The same S1-11 writer in another turn's walk, whose S1-02 never ran through `kinds`, finds no picks.
    const other = turnTwoOnV1("c-01");
    const lone = createWritesOf<WalkTestRepo>({
      bundles: bundleV1Bundles().bundles,
      turnKey: () => SAM,
      questions: questionsOver().questions,
      writers: writersOf({ "S1-02": picksWriter(), "S1-11": walk.plugIns.plugIns }).writers,
    });
    const error = await lone(other.part, other.context, NOTHING_OPEN).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expectRefused(error, "noPicks");
    expect(walk.tradeReads).toHaveLength(1);
  });

  it("a pick of another business than the call's is refused (pickOtherBusiness)", async () => {
    const elsewhere = picksWriter(samSeedPicks(), "biz-lee-home-services");
    const { error, tradeReads } = await refusal("c-01", plugInWalk({ s1_02: elsewhere }));
    expectRefused(error, "pickOtherBusiness");
    expect(tradeReads).toEqual([]);
  });

  it.each([
    ["a listed pick with no kind", { words: "Barbershop", outcome: "listed", kindId: null }],
    [
      "a listed pick naming a drafted kind",
      { words: "pack hikes", outcome: "listed", kindId: "new-pack-hikes" },
    ],
    ["a new-work pick naming a trade file", { words: "Barbershop", outcome: "new_work", kindId: "barber" }],
    [
      "a pick not booked that names a kind",
      { words: "gift cards", outcome: "not_booked", kindId: "florist" },
    ],
    ["a kind id outside K-24's form", { words: "Barbershop", outcome: "listed", kindId: "Barber Shop" }],
  ] as const)("%s is not K-24's shape: refused (pickNotWellFormed)", async (_, pick) => {
    const { error, tradeReads } = await refusal("c-01", plugInWalk({ s1_02: picksWriter([pick]) }));
    expectRefused(error, "pickNotWellFormed");
    expect(tradeReads).toEqual([]);
  });

  it.each([
    ["no position", undefined],
    ["position 0", 0],
    ["a position that is no whole number", 1.5],
    ["a position given as text", "1"],
    ["a position that is no number", Number.NaN],
  ] as const)(
    "a pick with %s is not K-24's shape, even a later one: refused (pickNotWellFormed)",
    async (_, position) => {
      // Sam's third pick alone is changed: the first kind named is well formed, and the part is still refused.
      const s1_02 = repositioned((values) => {
        if (values.position !== 3) return;
        if (position === undefined) Reflect.deleteProperty(values, "position");
        else values.position = position;
      });
      const { error, tradeReads } = await refusal("c-01", plugInWalk({ s1_02 }));
      expectRefused(error, "pickNotWellFormed");
      expect(tradeReads).toEqual([]);
    },
  );

  it("a malformed pick refuses S1-11 alone: S1-02's rows still pass through `kinds` when S1-11 is not walked", async () => {
    const bad = picksWriter([{ words: "gift cards", outcome: "not_booked", kindId: "florist" }]);
    const { writes, calls } = await answer("c-03", plugInWalk({ s1_02: bad }));
    expect(calls.map((call) => call.stepId)).toEqual(["S1-02", "S1-74"]);
    expect(rowsOf(writes, "picked_kinds")).toHaveLength(1);
  });

  it("bound to a step other than S1-11, it refuses (notS1_11)", async () => {
    const walk = plugInWalk();
    const misbound = plugInWalk({ writers: { "S1-03": walk.plugIns.plugIns } });
    const { error } = await refusal("c-02", misbound);
    expectRefused(error, "notS1_11", ["S1-03"]);
  });

  it.each(overlayFaults())(
    "an overlay with %s is refused whole (overlayNotWellFormed), naming no block's words",
    async (_, change) => {
      const overlay = overlayV1("barber");
      change(overlay);
      expectRefused(
        thrownBy(() => loadPlugIn(overlay, "barber")),
        "overlayNotWellFormed",
        ["S1-11", "barber"],
      );
      const { error } = await refusal("c-01", plugInWalk({ overlays: { barber: overlay } }));
      expectRefused(error, "overlayNotWellFormed", ["S1-11", "barber"]);
    },
  );

  it("no refusal's message holds a block's words, a pick's words or id, a business or the chat id", async () => {
    const overlay = overlayV1("barber");
    blocksIn(overlay)["pf.money"] = "{oops";
    const errors = [
      (await refusal("c-01", plugInWalk({ overlays: { barber: overlay } }))).error,
      (await refusal("c-01", plugInWalk({ s1_02: s1_02Writer }))).error,
      (await refusal("c-01", plugInWalk({ kept: false }))).error,
      (await refusal("c-01", plugInWalk({ s1_02: picksWriter(samSeedPicks(), "biz-lee-home-services") })))
        .error,
      (await refusal("c-01", plugInWalk({ s1_02: picksWriter([{ ...NOT_BOOKED, kindId: "florist" }]) })))
        .error,
    ];
    const blocks = overlayV1("barber").pluginText as Record<string, string>;
    for (const error of errors) {
      expect(error).toBeInstanceOf(PlugInRefusedError);
      const message = error instanceof Error ? error.message : "";
      for (const words of [
        "{oops",
        String(blocks["pf.license"]).slice(0, 40),
        "Barbershop",
        "gift cards",
        "pick-s1-02-sam",
        "biz-lee",
        "person-sam",
        String(requestTurnFields(turnTwoOnV1().context.request).chatId),
      ]) {
        expect(message).not.toContain(words);
      }
    }
  });
});

/** One change that makes bundle v1's barber overlay not K-01 v1's tradeOverlay of barber. */
type OverlayChange = (overlay: Record<string, unknown>) => void;

/** Each fault an overlay can have, with the change that gives a copy of barber's overlay that fault alone. */
function overlayFaults(): (readonly [string, OverlayChange])[] {
  return [
    [
      "another contract",
      (overlay) => {
        overlay.contract = "bundle.v2";
      },
    ],
    [
      "another trade's overlay",
      (overlay) => {
        overlay.trade = { id: "plumber" };
      },
    ],
    [
      "a block missing",
      (overlay) => {
        Reflect.deleteProperty(blocksIn(overlay), "pf.rules");
      },
    ],
    [
      "a typed key among the blocks",
      (overlay) => {
        blocksIn(overlay)["pf.facts"] = "[]";
      },
    ],
    [
      "a block that is not JSON text",
      (overlay) => {
        blocksIn(overlay)["pf.money"] = "{oops";
      },
    ],
    [
      "a block that is not text",
      (overlay) => {
        blocksIn(overlay)["pf.edges"] = { a: 1 };
      },
    ],
    [
      "facts left out",
      (overlay) => {
        Reflect.deleteProperty(overlay, "facts");
      },
    ],
    [
      "a fact not a name",
      (overlay) => {
        overlay.facts = ["Video"];
      },
    ],
    [
      "a blank free-cancel time",
      (overlay) => {
        settingsIn(overlay, "A").cutoff = " ";
      },
    ],
    [
      "a window of no hours",
      (overlay) => {
        settingsIn(overlay, "B").arrive = { window: 0 };
      },
    ],
    [
      "an arrival setting of its own",
      (overlay) => {
        settingsIn(overlay, "A").arrive = "drop-in";
      },
    ],
    [
      "a setting of its own",
      (overlay) => {
        settingsIn(overlay, "A").deposit = "none";
      },
    ],
    [
      "a flow left out",
      (overlay) => {
        Reflect.deleteProperty(flowsIn(overlay), "B");
      },
    ],
  ];
}

/** An overlay's blocks, to change in a test's copy. */
function blocksIn(overlay: Record<string, unknown>): Record<string, unknown> {
  return overlay.pluginText as Record<string, unknown>;
}

/** An overlay's flows, to change in a test's copy. */
function flowsIn(overlay: Record<string, unknown>): Record<string, unknown> {
  return overlay.flows as Record<string, unknown>;
}

/** One flow's settings of an overlay, to change in a test's copy. */
function settingsIn(overlay: Record<string, unknown>, flow: "A" | "B"): Record<string, unknown> {
  return (flowsIn(overlay)[flow] as Record<string, unknown>).settings as Record<string, unknown>;
}
