// The gate port's commit binding (T-1470, card F2; ./real.ts gateBindingOf, which realGate builds for each business-scoped
// call), under Node (Vitest project "unit"). No Workers rig walks a second turn (both hold bundle v0), so the two things
// this card adds to the gate port are proven here, on the binding realGate itself hands the turn face:
//
//   a. the trade-overlay port (FrontierBundleReads.trade, reached as the binding's own `bundles`), over a pinned-bundle
//      double: under the run's pinned id a trade the pinned bundle holds answers that bundle's overlay, one its manifest
//      does not list (BundleError notInBundle) is null, and any other failure is thrown; another bundle's id, and a call
//      with no pinned run, throw before the pinned bundle or the bundle port is asked; two reads asked together reach
//      the pinned bundle one after the other;
//   b. the binding's two new fields: with GateReads.questions and GateReads.kinds bound it carries the reads' own
//      question read and T-1468's sign-up writers, whose S1-02 writer and then S1-11 writer, run for one part by the
//      commit's own writesOf (turnCommitDeps over the binding, as realGate hands it to the face), ask the catalog and
//      item 79 once each, in that order, and the pinned bundle's barber overlay once, and give the first pick's 11
//      picked_kind_texts inserts; with both left out it carries neither field;
//   c. S1-02's settler (T-1503; DL-1018 card 5; K-09 README default 191): with GateReads.kinds bound the binding carries
//      T-1502's signUpSteps, its settlers beside its writers, so a part naming c-02 ("One isn't on the list yet") for
//      commit-s1-02.json's all-listed words ("Barbershop, plumbing, electrical") runs S1-02's settler, then S1-02's
//      writer and S1-11's writer, through the commit's own writesOf, and gives "All on the list"'s rows, the catalog read
//      once for the call; the same part with the settler taken out is refused (branchNotWords), as before; with the kinds
//      reads left out the binding carries neither `writers` nor `settlers`;
//   d. the stop home's reads (T-1516; DL-1033 ruling 8; CQ-360): with GateReads.stop bound beside the kinds reads, the
//      binding hands them into the sign-up writers' deps, so an answer the settler settles as "One isn't on the list yet"
//      ("Barbershop, pack hikes" on the 243 seeded kinds) writes S1-02's picks, S1-03's draft and S1-03's message row, and
//      one it settles as "Not a service we book" ("Gift cards") writes S1-02's not_booked pick and S1-74's message row,
//      each read through homes/stop's readStop for the turn's own person and handle, on the runtime side's reads, one
//      read open at a time; with the stop reads left out both answers stay notBuilt (stopNotWired), as before; the stop
//      reads bound with no kinds reads bind no writer and are never read;
//   e. the walk's chat read (T-1519; DL-1048, DL-1051): with GateReads.readChatHandle bound (K-05 v1.10 item 51) the
//      binding carries it as it is, so turn 1 (commit-s1-01.json's JOIN on bundle v0) whose chat Sam's own chat thread
//      already holds writes no thread row and no thread.created entry, still gives thread and asks S1-02's question, the
//      read asked once for the turn's chat id; a chat no thread holds, and one another handle's thread holds, insert the
//      thread as with no read bound; an error answer fails the walk closed (TurnFaceReadError); with the read left out
//      (fakeGateReads as it is, no reads at all) the binding carries no such field and S1-01 inserts, as before;
//   f. the one-kind path (T-1494, H2a; DL-1033, DL-1096, DL-1111; K-09 README default 199): with GateReads.companies bound
//      beside the kinds reads and the stop reads (staging's shape), the binding carries S1-04's buttons settler alone and
//      S1-08's writer, so a one-kind S1-02 answer ("Plumbing") on bundle v2, through the commit's own writesOf, runs
//      S1-02's settler, S1-02's writer inside the companies wrapper (item 79, item 72 and the catalog by id read once
//      each), S1-11's writer, S1-04's buttons settler and S1-08's writer (the stop home read for the turn's own owner),
//      every read of the binding one after another, and ends at S1-09's question with no S1-04 question; "Barbershop,
//      plumbing, electrical" still asks S1-04 as without the path; with the one-kind reads left out there is no buttons
//      settler and no S1-04 writer, and "Plumbing" asks S1-04 as T-1516's binding does; with them bound and no stop reads,
//      "Plumbing" is refused at S1-08 with nothing returned; with no kinds reads they bind nothing and are never read;
//   g. S1-04's writer (T-1485, H2b; DL-1033, DL-1122; K-09 README defaults 181 to 185, 189, 190 and 199): staging's shape
//      now also carries S1-04's own writer (T-1481's, with SignUpWriterDeps.s1_04Writer and the party rule's flag off),
//      and no other S1-04 writer or settler; building the binding reads nothing; the "Plumbing" walk of f runs through
//      that whole binding in the same order, never asking S1-04's writer, and ends at S1-09's question with no S1-04
//      question. An answer to an S1-04 that was asked (commit-s1-04-some-share.json's turn on bundle v2, Sam's three
//      picks on file): "They all share one company" (c-02) runs S1-04's writer, then S1-08's writer, never the buttons
//      settler, closes the question at its version, places the three picks in the turn's company, then S1-08's row and
//      S1-09's question, one read open at a time; Sam's own answer, which needs a second company, is refused
//      (CompaniesRefusedError secondCompany) with nothing returned, the flag being off; with the one-kind reads left out
//      there is no S1-04 writer (an answer to S1-04 is notBuilt, gives, before any read) while S1-08's writer stays bound
//      beside the stop reads; with the stop reads left out there is no S1-08 writer (the answer is refused at S1-08,
//      notBuilt, before any read).
//
// Under test, as they are: ./real.ts's binding and its bundles; @rosie/actions' turnCommitDeps, T-1461's walk on bundle
// v1's flow A with T-1502's settler port, T-633's writers and T-1502's S1-02 settler with T-632's matcher, T-634's
// writer, and T-590's readStop and mayText inside T-633's writers; and T-1519's walkChatsOf and S1-01's thread write;
// for f, T-1491's buttons-settler walk on bundle v2's flow A, T-1492's one-kind wrapper and settler through
// companiesReadsOf, and T-1482's S1-08 writer; for g, the same and T-1481's S1-04 writer through the walk's answered step.
// Doubles, for ports only: the pinned bundle (bundle v1's own flow A and trade overlays, read from bundles/v1; for turn
// 1, K-01's bundle-v0-skeleton.json's flow A), the bundle port (../bundle/test-support), the question read and K-05
// items 78 and 79 (@rosie/actions' own doubles, as T-1468's unit test binds them), the stop home's reads (@rosie/actions'
// own double over the frozen seeds, on the runtime side, as T-633's unit test binds them), K-05 item 51 (an answer as
// readChatHandle gives it), and ./test-support's fakeGateReads as it is; for f, bundle v2 as a run pinned it (its own
// manifest, flow A and trade overlays, read from bundles/v2) and items 79 and 72 and the catalog by id (@rosie/actions'
// fakeCompaniesK05, as T-1493's unit test binds them); for g, Sam's three picks on file and S1-04's question row in
// those same doubles, as T-1484's unit test gives them. Test values only (rule 9): the contracts' fixtures, bundles v1
// and v2, the master's sample cast and a whole fiction-range 555-01xx number.
import { BARBERSHOP } from "@rosie/actions/src/domain/safety/test-support";
import {
  NOTHING_OPEN,
  bundleV1Id,
  commitS1_02,
  contextOf,
  decidedOf,
  flowA,
  flowAV1,
  passedPartOf,
  questionsOver,
  requestTurnFields,
  s1_02QuestionRow,
  tradeOverlayV1,
  turnOne,
  turnTwoOnV1,
} from "@rosie/actions/src/commit/walk/test-support";
import { WalkNotBuiltError, type ButtonsSettler, type WalkQuestions } from "@rosie/actions/src/commit/walk";
import type { StopHomeReads } from "@rosie/actions/src/homes/stop/reads";
import { readsOn, seedWorld } from "@rosie/actions/src/homes/stop/test-support";
import { CompaniesRefusedError } from "@rosie/actions/src/tool-api/journey-1/companies/errors";
import { companiesReadsOf } from "@rosie/actions/src/tool-api/journey-1/companies/reads";
import {
  COMMIT_S1_04_SOME_SHARE,
  SAM_COMPANY,
  catalogDefaults,
  fakeCompaniesK05,
  pickOnFile,
  s1_04Exchange,
  type AnswerField,
  type CompaniesGiven,
} from "@rosie/actions/src/tool-api/journey-1/companies/test-support";
import { KindsNotBuiltError, KindsRefusedError } from "@rosie/actions/src/tool-api/journey-1/kinds/errors";
import { kindsReadsOf } from "@rosie/actions/src/tool-api/journey-1/kinds/reads";
import {
  GIFT_CARDS,
  PACK_HIKES,
  fakeK05,
  turnWithWords,
} from "@rosie/actions/src/tool-api/journey-1/kinds/test-support";
import { PF_TEXT_KEYS } from "@rosie/actions/src/tool-api/journey-1/plug-ins/plug-in";
import {
  bundleV2Id,
  overlayV2,
  publishedBundleV2,
} from "@rosie/actions/src/tool-api/turn-face/calls-test-support";
import {
  NOTHING_OPEN_AT,
  turnCommitDeps,
  type ChatHandleAnswer,
  type ChatHandleRequest,
  type ErrorAnswer,
} from "@rosie/actions/src/tool-api/turn-face/commit";
import { TurnFaceReadError } from "@rosie/actions/src/tool-api/turn-face/errors";
import type { PickedKindRead } from "@rosie/db/repo/kinds-reads";
import type { OpenQuestionRead } from "@rosie/db/repo/targets";
import { describe, expect, it } from "vitest";

import { BundleError, type Manifest, type PinnedBundle, type TradeOverlay } from "../bundle";
import { BUNDLE_A, fakeBundles, keyIn, type FakeBundles } from "../bundle/test-support";
import type { BundleId } from "../trace";
import { flush } from "../turn/test-support";
import { gateBindingOf, type GateInputs, type GateReads } from "./real";
import { fakeGateReads, fakeTurnRows } from "./test-support";

/** Bundle v1's id, as its manifest names it: the bundle the run pinned in every case here. */
const BUNDLE_V1: BundleId = bundleV1Id();

/** Bundle v1's own overlay of a trade, as PinnedBundle.trade hands one over: parsed. */
const overlayV1 = (trade: string): TradeOverlay => tradeOverlayV1(trade) as TradeOverlay;

interface PinnedV1 {
  readonly bundle: PinnedBundle;
  /** Every trade the pinned bundle was asked for, in order, as each read started. */
  readonly asked: string[];
}

/**
 * Bundle v1 as a run pinned it: flow A's graph and, for each trade, what `trade` answers (default: bundle v1's own
 * overlay of barber, plumber and electrician, and BundleError notInBundle for any other, as the pin answers a trade its
 * manifest does not list). Its manifest lists nothing: neither the walk nor a writer reads it here.
 */
function pinnedV1(trade?: (tradeId: string) => Promise<TradeOverlay>): PinnedV1 {
  const asked: string[] = [];
  const held = new Set(["barber", "plumber", "electrician"]);
  const manifest: Manifest = {
    contract: "bundle.v1",
    bundleId: BUNDLE_V1,
    storage: { manifestKey: keyIn(BUNDLE_V1, "manifest"), values: [] },
  };
  const bundle: PinnedBundle = {
    bundleId: BUNDLE_V1,
    manifest,
    flow: (flow) =>
      flow === "A" ? Promise.resolve(flowAV1()) : Promise.reject(new BundleError("notInBundle")),
    trade(tradeId) {
      asked.push(tradeId);
      if (trade !== undefined) return trade(tradeId);
      return held.has(tradeId)
        ? Promise.resolve(overlayV1(tradeId))
        : Promise.reject(new BundleError("notInBundle"));
    },
    reads: () => [],
  };
  return { bundle, asked };
}

/** What the gate port is fed, over `reads`: its commit is never sent here, and the bundle port is `bound`'s. */
function inputsOf(reads: GateReads | null, bound: FakeBundles): GateInputs {
  return {
    reads,
    commitTurn: () => Promise.reject(new Error("no commit is sent in this test")),
    bundles: () => bound.deps,
    pinnedOf: () => null,
  };
}

/** The binding realGate builds for one call whose run pinned `pinned`, over `reads`. */
function bindingOver(reads: GateReads | null, pinned: PinnedBundle | null) {
  const bound = fakeBundles();
  return { binding: gateBindingOf(inputsOf(reads, bound), pinned, bound.deps), bound };
}

/** What a promise rejected with, or undefined when it resolved. */
const thrownBy = (asked: Promise<unknown>): Promise<unknown> =>
  asked.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

/** A promise settled from outside. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("the gate's trade-overlay port: the run's pinned bundle's alone (T-1470)", () => {
  it("under the pinned id, a trade the pinned bundle holds answers that bundle's overlay, as PinnedBundle.trade reads it", async () => {
    const pinned = pinnedV1();
    const { binding, bound } = bindingOver(null, pinned.bundle);

    const overlay = await binding.bundles.trade({ ...BUNDLE_V1 }, "barber");

    expect(overlay).toEqual(overlayV1("barber"));
    expect((overlay as { trade: { id: string } }).trade.id).toBe("barber");
    expect(pinned.asked).toEqual(["barber"]);
    // Nothing went past the pinned bundle to KV or to PostgreSQL's copy.
    expect(bound.kvReads).toEqual([]);
    expect(bound.calls).toEqual([]);
  });

  it("a trade the pinned bundle's manifest does not list (BundleError notInBundle) is null", async () => {
    const pinned = pinnedV1();
    const { binding } = bindingOver(null, pinned.bundle);

    await expect(binding.bundles.trade(BUNDLE_V1, "pack-hikes")).resolves.toBeNull();
    expect(pinned.asked).toEqual(["pack-hikes"]);
  });

  it.each([
    ["a value no copy holds as the bundle's own", new BundleError("unreadable")],
    ["a read K-05 gave no answer to", new BundleError("noAnswer")],
    ["a value in neither copy", new BundleError("notFound")],
    ["any other error", new Error("a failure of the read")],
  ])("any other failure of the read is thrown as it is: %s", async (_name, failure) => {
    const pinned = pinnedV1(() => Promise.reject(failure));
    const { binding } = bindingOver(null, pinned.bundle);

    expect(await thrownBy(binding.bundles.trade(BUNDLE_V1, "barber"))).toBe(failure);
    expect(pinned.asked).toEqual(["barber"]);
  });

  it("another bundle's id throws before anything is read: the pinned bundle and the bundle port are never asked", async () => {
    const pinned = pinnedV1();
    const { binding, bound } = bindingOver(null, pinned.bundle);
    const others: BundleId[] = [
      BUNDLE_A,
      { hash: BUNDLE_V1.hash, build: BUNDLE_V1.build + 1 },
      { hash: "0".repeat(64), build: BUNDLE_V1.build },
    ];

    for (const other of others) {
      const thrown = await thrownBy(binding.bundles.trade(other, "barber"));
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).toMatchObject({ name: "TradeNotPinnedError", reason: "otherBundle" });
      // The error names the reason alone: no bundle id and no trade.
      const { message } = thrown as Error;
      expect(message).not.toContain(other.hash);
      expect(message).not.toContain(BUNDLE_V1.hash);
      expect(message).not.toContain("barber");
    }
    expect(pinned.asked).toEqual([]);
    expect(bound.kvReads).toEqual([]);
    expect(bound.calls).toEqual([]);
  });

  it("with no pinned run it throws before anything is read, whatever bundle is named", async () => {
    const { binding, bound } = bindingOver(null, null);

    for (const named of [BUNDLE_V1, BUNDLE_A]) {
      const thrown = await thrownBy(binding.bundles.trade(named, "barber"));
      expect(thrown).toMatchObject({ name: "TradeNotPinnedError", reason: "noPinnedRun" });
      expect((thrown as Error).message).not.toContain(named.hash);
    }
    expect(bound.kvReads).toEqual([]);
    expect(bound.calls).toEqual([]);
  });

  it("two reads asked together reach the pinned bundle one after the other: the second starts only once the first has settled", async () => {
    const first = deferred<TradeOverlay>();
    const second = deferred<TradeOverlay>();
    const waiting = new Map([
      ["barber", first],
      ["plumber", second],
    ]);
    const pinned = pinnedV1((tradeId) => {
      const held = waiting.get(tradeId);
      return held === undefined ? Promise.reject(new BundleError("notInBundle")) : held.promise;
    });
    const { binding } = bindingOver(null, pinned.bundle);

    const barber = binding.bundles.trade(BUNDLE_V1, "barber");
    const plumber = binding.bundles.trade(BUNDLE_V1, "plumber");
    await flush();
    // The first read is open; the second has not reached the pinned bundle.
    expect(pinned.asked).toEqual(["barber"]);

    first.resolve(overlayV1("barber"));
    await expect(barber).resolves.toEqual(overlayV1("barber"));
    await flush();
    expect(pinned.asked).toEqual(["barber", "plumber"]);

    second.resolve(overlayV1("plumber"));
    await expect(plumber).resolves.toEqual(overlayV1("plumber"));
    expect(pinned.asked).toEqual(["barber", "plumber"]);
  });

  it("a read that fails does not hold the next one back: it starts once the failed one has settled, and each answers its own", async () => {
    const first = deferred<TradeOverlay>();
    const failure = new BundleError("unreadable");
    const pinned = pinnedV1((tradeId) =>
      tradeId === "barber" ? first.promise : Promise.resolve(overlayV1(tradeId)),
    );
    const { binding } = bindingOver(null, pinned.bundle);

    const barber = thrownBy(binding.bundles.trade(BUNDLE_V1, "barber"));
    const plumber = binding.bundles.trade(BUNDLE_V1, "plumber");
    await flush();
    expect(pinned.asked).toEqual(["barber"]);

    first.reject(failure);
    expect(await barber).toBe(failure);
    await expect(plumber).resolves.toEqual(overlayV1("plumber"));
    expect(pinned.asked).toEqual(["barber", "plumber"]);
  });
});

describe("the gate's commit binding: the walk's question read and the sign-up writers, only where the reads bind them (T-1470)", () => {
  /** fakeGateReads as it is (./test-support.ts): it binds neither new field. */
  const baseReads = (): GateReads => fakeGateReads(fakeTurnRows()).reads;

  it("with both bound it carries the reads' own question read, and its S1-02 writer then its S1-11 writer ask the catalog, item 79 and the pinned bundle's barber overlay once each and give the first pick's 11 text blocks", async () => {
    const k05 = fakeK05();
    const questions = questionsOver([{ ...s1_02QuestionRow(), version: 5 }]);
    const reads: GateReads = {
      ...baseReads(),
      questions: questions.questions,
      kinds: { reads: kindsReadsOf(k05.k05) },
    };
    const pinned = pinnedV1();
    const { binding, bound } = bindingOver(reads, pinned.bundle);

    // The reads' own question read, handed on as it is, and T-1468's lookup by step id.
    expect(binding.questions).toBe(reads.questions);
    const { writers } = binding;
    if (writers === undefined) throw new Error("the binding carries the sign-up writers");
    for (const stepId of ["S1-02", "S1-03", "S1-74", "S1-11"]) {
      expect(typeof writers(stepId), stepId).toBe("function");
    }
    for (const stepId of ["S1-01", "S1-04", "S1-08", ""]) expect(writers(stepId), stepId).toBeNull();
    // Building the binding read nothing.
    expect(k05.asked).toEqual([]);
    expect(pinned.asked).toEqual([]);
    expect(questions.reads).toEqual([]);

    // commit-s1-02.json's part ("Barbershop, plumbing, electrical", choosing "All on the list") on bundle v1, through
    // the commit's own writesOf over this binding: the walk calls S1-02's writer, then S1-11's, for the one part.
    const turn = turnTwoOnV1();
    expect(turn.context.turn.bundleId).toEqual(BUNDLE_V1);
    const { ports } = turnCommitDeps(binding)(NOTHING_OPEN_AT);
    const writes = await ports.writesOf(turn.part, turn.context, NOTHING_OPEN);

    // The catalog, then item 79, once each, for the call's own business and the turn's person.
    expect(k05.asked).toEqual([
      { read: "readKindCatalog" },
      { read: "readPickedKinds", request: { businessId: BARBERSHOP, personId: "person-sam" } },
    ]);
    // The trade once: the first kind named, under the pinned id, from the pinned bundle and nowhere else.
    expect(pinned.asked).toEqual(["barber"]);
    expect(bound.kvReads).toEqual([]);
    expect(bound.calls).toEqual([]);
    // The question read once, on the call's own repo, for the turn's handle; its row's version closes the question.
    expect(questions.reads).toEqual([
      { repo: turn.context.repo, handleId: "handle-sam", openQuestionId: "oq-s1-02" },
    ]);
    expect(writes.closes).toEqual([
      { id: "oq-s1-02", expectVersion: 5, status: "answered", answeredOptionId: null },
    ]);

    // Three picks in the owner's order, then exactly 11 picked_kind_texts inserts, all the first pick's, each block
    // bundle v1's own barber overlay's.
    const inserts = writes.state.flatMap((write) => (write.op === "insert" ? [write] : []));
    expect(inserts.map((write) => write.table)).toEqual([
      "picked_kinds",
      "picked_kinds",
      "picked_kinds",
      ...PF_TEXT_KEYS.map(() => "picked_kind_texts"),
    ]);
    const picks = inserts.filter((write) => write.table === "picked_kinds").map((write) => write.values);
    expect(picks.map((pick) => [pick.position, pick.outcome, pick.kind_id])).toEqual([
      [1, "listed", "barber"],
      [2, "listed", "plumber"],
      [3, "listed", "electrician"],
    ]);
    const texts = inserts.filter((write) => write.table === "picked_kind_texts").map((write) => write.values);
    expect(texts).toHaveLength(11);
    const blocks = overlayV1("barber").pluginText as Record<string, string>;
    expect(texts).toEqual(
      PF_TEXT_KEYS.map((key) => ({
        picked_kind_id: picks[0]?.id,
        pf_key: key,
        business_id: null,
        block: blocks[key],
      })),
    );
    expect(typeof picks[0]?.id).toBe("string");
  });

  it("with both left out it carries neither field: fakeGateReads as it is, and no reads at all", () => {
    const pinned = pinnedV1();
    for (const reads of [baseReads(), null]) {
      const { binding } = bindingOver(reads, pinned.bundle);
      expect(Object.hasOwn(binding, "questions")).toBe(false);
      expect(Object.hasOwn(binding, "writers")).toBe(false);
      expect(binding.questions).toBeUndefined();
      expect(binding.writers).toBeUndefined();
    }
    expect(pinned.asked).toEqual([]);
  });

  it("each is bound only when its own read is: the question read alone carries no writers, the kinds reads alone no question read", () => {
    const k05 = fakeK05();
    const questions: WalkQuestions = questionsOver().questions;

    const asking = bindingOver({ ...baseReads(), questions }, pinnedV1().bundle).binding;
    expect(asking.questions).toBe(questions);
    expect(Object.hasOwn(asking, "writers")).toBe(false);

    const writing = bindingOver({ ...baseReads(), kinds: { reads: kindsReadsOf(k05.k05) } }, null).binding;
    expect(Object.hasOwn(writing, "questions")).toBe(false);
    expect(typeof writing.writers).toBe("function");
    expect(k05.asked).toEqual([]);
  });

  it("each call's writers read their overlay through that call's own bundles: two bindings over one set of reads never share a pinned bundle", async () => {
    const k05 = fakeK05();
    const reads: GateReads = {
      ...baseReads(),
      questions: questionsOver().questions,
      kinds: { reads: kindsReadsOf(k05.k05) },
    };
    const one = pinnedV1();
    const other = pinnedV1();
    const first = bindingOver(reads, one.bundle).binding;
    const second = bindingOver(reads, other.bundle).binding;
    expect(first.bundles).not.toBe(second.bundles);
    expect(first.writers).not.toBe(second.writers);

    const turn = turnTwoOnV1();
    await turnCommitDeps(first)(NOTHING_OPEN_AT).ports.writesOf(turn.part, turn.context, NOTHING_OPEN);
    expect(one.asked).toEqual(["barber"]);
    expect(other.asked).toEqual([]);
  });
});

describe("the gate's commit binding hands in S1-02's settler beside the sign-up writers, only where the kinds reads are bound, so the owner's words settle S1-02's branch (T-1503)", () => {
  /** fakeGateReads as it is (./test-support.ts): it binds neither the question read nor the kinds reads. */
  const baseReads = (): GateReads => fakeGateReads(fakeTurnRows()).reads;

  /**
   * The binding realGate builds for one call with the question read and the kinds reads bound, as case b binds them:
   * S1-02's question open at version 5, the 243 seeded kinds as the catalog, no pick yet, the run's pinned bundle v1.
   */
  function signUpBound() {
    const k05 = fakeK05();
    const questions = questionsOver([{ ...s1_02QuestionRow(), version: 5 }]);
    const reads: GateReads = {
      ...baseReads(),
      questions: questions.questions,
      kinds: { reads: kindsReadsOf(k05.k05) },
    };
    const pinned = pinnedV1();
    return { k05, questions, pinned, ...bindingOver(reads, pinned.bundle) };
  }

  it("c-02 named for 'Barbershop, plumbing, electrical': S1-02's settler, then S1-02's writer and S1-11's writer, through the commit's own writesOf, give 'All on the list''s rows, the catalog read once for the call", async () => {
    const { k05, questions, pinned, binding, bound } = signUpBound();

    // T-1502's signUpSteps, built for this call: S1-02's settler alone, beside the writers step for step.
    const { settlers, writers } = binding;
    if (settlers === undefined || writers === undefined) {
      throw new Error("the binding carries the sign-up writers and S1-02's settler");
    }
    expect(typeof settlers("S1-02")).toBe("function");
    for (const stepId of ["S1-01", "S1-03", "S1-04", "S1-11", "S1-74", ""]) {
      expect(settlers(stepId), stepId).toBeNull();
    }
    for (const stepId of ["S1-02", "S1-03", "S1-74", "S1-11"]) {
      expect(typeof writers(stepId), stepId).toBe("function");
    }
    for (const stepId of ["S1-01", "S1-04", "S1-08", ""]) expect(writers(stepId), stepId).toBeNull();
    // Building the binding read nothing.
    expect(k05.asked).toEqual([]);
    expect(pinned.asked).toEqual([]);
    expect(questions.reads).toEqual([]);

    // The binding's own settler and writers, each call written down as it reaches them and handed on unchanged.
    const order: string[] = [];
    const watched: typeof binding = {
      ...binding,
      settlers: (stepId) => {
        const settler = settlers(stepId);
        if (settler === null) return null;
        return (call) => {
          order.push(`settler ${call.step.id}`);
          return settler(call);
        };
      },
      writers: (stepId) => {
        const writer = writers(stepId);
        if (writer === null) return null;
        return (call) => {
          order.push(`writer ${call.step.id}`);
          return writer(call);
        };
      },
    };

    // commit-s1-02.json's part on bundle v1, naming c-02 ("One isn't on the list yet") for words whose every part is on
    // the list, through the commit's own writesOf over the binding.
    const turn = turnTwoOnV1("c-02");
    expect(turn.choice).toMatchObject({
      choiceId: "c-02",
      step: "S1-02",
      branch: "One isn't on the list yet",
      label: "One isn't on the list yet",
    });
    expect(decidedOf(turn.context.request).context.texts.map((text) => text.words)).toEqual([
      "Barbershop, plumbing, electrical",
    ]);
    const { ports } = turnCommitDeps(watched)(NOTHING_OPEN_AT);
    const writes = await ports.writesOf(turn.part, turn.context, NOTHING_OPEN);

    // S1-02's settler once, before any writer; then S1-02's writer and S1-11's, for the one part.
    expect(order).toEqual(["settler S1-02", "writer S1-02", "writer S1-11"]);
    // The unit's why names the step and the branch the words settled, never the option named.
    expect(writes.why).toEqual({ step: "S1-02", choice: "All on the list" });
    // The catalog once for the call (the settler's reading is S1-02's writer's), then item 79 once.
    expect(k05.asked).toEqual([
      { read: "readKindCatalog" },
      { read: "readPickedKinds", request: { businessId: BARBERSHOP, personId: "person-sam" } },
    ]);
    // The trade once: the first kind named, under the pinned id, from the pinned bundle and nowhere else.
    expect(pinned.asked).toEqual(["barber"]);
    expect(bound.kvReads).toEqual([]);
    expect(bound.calls).toEqual([]);
    // The question read once, on the call's own repo; its row's version closes the question.
    expect(questions.reads).toEqual([
      { repo: turn.context.repo, handleId: "handle-sam", openQuestionId: "oq-s1-02" },
    ]);
    expect(writes.closes).toEqual([
      { id: "oq-s1-02", expectVersion: 5, status: "answered", answeredOptionId: null },
    ]);

    // "All on the list"'s rows: three listed picks in the owner's order, then the first pick's 11 text blocks, each bundle
    // v1's own barber overlay's; and what commit-s1-02.json states S1-02 and S1-11 give.
    const inserts = writes.state.flatMap((write) => (write.op === "insert" ? [write] : []));
    expect(inserts.map((write) => write.table)).toEqual([
      "picked_kinds",
      "picked_kinds",
      "picked_kinds",
      ...PF_TEXT_KEYS.map(() => "picked_kind_texts"),
    ]);
    const picks = inserts.filter((write) => write.table === "picked_kinds").map((write) => write.values);
    expect(picks.map((pick) => [pick.position, pick.outcome, pick.kind_id])).toEqual([
      [1, "listed", "barber"],
      [2, "listed", "plumber"],
      [3, "listed", "electrician"],
    ]);
    const blocks = overlayV1("barber").pluginText as Record<string, string>;
    expect(
      inserts.filter((write) => write.table === "picked_kind_texts").map((write) => write.values),
    ).toEqual(
      PF_TEXT_KEYS.map((key) => ({
        picked_kind_id: picks[0]?.id,
        pf_key: key,
        business_id: null,
        block: blocks[key],
      })),
    );
    expect(writes.gives).toEqual(turn.exchange.given.stated.gives);
  });

  it("the rows are those of c-01 named on the binding as T-1470 built it, with no settler; there the same c-02 part is refused (branchNotWords), as before", async () => {
    const settled = signUpBound();
    const turn = turnTwoOnV1("c-02");
    const writes = await turnCommitDeps(settled.binding)(NOTHING_OPEN_AT).ports.writesOf(
      turn.part,
      turn.context,
      NOTHING_OPEN,
    );

    // The same binding with its settlers taken out: the writers alone, as the gate port bound them before T-1503.
    const before = signUpBound();
    const { settlers, ...unsettled } = before.binding;
    expect(typeof settlers).toBe("function");
    const today = turnCommitDeps(unsettled)(NOTHING_OPEN_AT).ports;
    const named = turnTwoOnV1("c-01");
    expect(await today.writesOf(named.part, named.context, NOTHING_OPEN)).toEqual(writes);

    const refused = turnTwoOnV1("c-02");
    const thrown = await thrownBy(today.writesOf(refused.part, refused.context, NOTHING_OPEN));
    expect(thrown).toBeInstanceOf(KindsRefusedError);
    expect(thrown).toMatchObject({ name: "KindsRefusedError", fault: "branchNotWords" });
  });

  it("with the kinds reads left out it carries neither `writers` nor `settlers`: fakeGateReads as it is, the question read alone, and no reads at all", () => {
    const pinned = pinnedV1();
    const questions: WalkQuestions = questionsOver().questions;
    for (const reads of [baseReads(), { ...baseReads(), questions }, null]) {
      const { binding } = bindingOver(reads, pinned.bundle);
      expect(Object.hasOwn(binding, "writers")).toBe(false);
      expect(Object.hasOwn(binding, "settlers")).toBe(false);
      expect(binding.writers).toBeUndefined();
      expect(binding.settlers).toBeUndefined();
    }
    expect(pinned.asked).toEqual([]);
  });
});

// ---- the stop home's reads (T-1516) -----------------------------------------------------------------------------------

/** One read the stop home's reads were asked for: the member, and the ids it was handed. */
interface StopAsked {
  readonly read: keyof StopHomeReads;
  readonly ids: readonly string[];
}

interface RecordedStop {
  readonly stop: StopHomeReads;
  /** Every read, in order, as it started. */
  readonly asked: StopAsked[];
  /** The most reads open at once: a read is open from its call until its answer has settled. */
  peak(): number;
}

/**
 * The stop home's reads as @rosie/actions' own double answers them on the runtime side (homes/stop test-support readsOn,
 * scope null: T-307's and T-317's doubles over the frozen seeds, where Sam's mobile texts), each read written down as it
 * starts and counted while it is open. The double is a port's: readStop and mayText, which read it, are the code's own.
 */
function recordedStop(): RecordedStop {
  const reads = readsOn(seedWorld(), null);
  const asked: StopAsked[] = [];
  let open = 0;
  let peak = 0;
  const counted = async <T>(read: keyof StopHomeReads, ids: readonly string[], answer: () => Promise<T>) => {
    asked.push({ read, ids: [...ids] });
    open += 1;
    peak = Math.max(peak, open);
    try {
      return await answer();
    } finally {
      open -= 1;
    }
  };
  return {
    asked,
    peak: () => peak,
    stop: {
      handle: (handleId) => counted("handle", [handleId], () => reads.handle(handleId)),
      handleIdsOfPerson: (personId) =>
        counted("handleIdsOfPerson", [personId], () => reads.handleIdsOfPerson(personId)),
      phoneOfHandle: (handleId) => counted("phoneOfHandle", [handleId], () => reads.phoneOfHandle(handleId)),
      consentsOfPersons: (personIds) =>
        counted("consentsOfPersons", personIds, () => reads.consentsOfPersons(personIds)),
      personIdsOfHandle: (handleId) =>
        counted("personIdsOfHandle", [handleId], () => reads.personIdsOfHandle(handleId)),
    },
  };
}

/** readStop's reads for the turn's own person and handle (Sam's, on his mobile), in its order. */
const SAM_STOP_READS: readonly StopAsked[] = [
  { read: "handle", ids: ["handle-sam"] },
  { read: "handleIdsOfPerson", ids: ["person-sam"] },
  { read: "phoneOfHandle", ids: ["handle-sam"] },
  { read: "personIdsOfHandle", ids: ["handle-sam"] },
  { read: "consentsOfPersons", ids: ["person-sam"] },
];

describe("the gate's commit binding hands the stop home's reads into the sign-up writers' deps, only where the reads bind them, so an answer settled as 'One isn't on the list yet' or 'Not a service we book' is written with its message (T-1516)", () => {
  /** fakeGateReads as it is (./test-support.ts): it binds neither the kinds reads nor the stop reads. */
  const baseReads = (): GateReads => fakeGateReads(fakeTurnRows()).reads;

  /**
   * The binding realGate builds for one call with the question read and the kinds reads bound (S1-02's question open at
   * version 5, the 243 seeded kinds, no pick yet, the run's pinned bundle v1), and the stop reads where `stopBound`.
   */
  function boundWith(stopBound: boolean) {
    const k05 = fakeK05();
    const questions = questionsOver([{ ...s1_02QuestionRow(), version: 5 }]);
    const stop = recordedStop();
    const reads: GateReads = {
      ...baseReads(),
      questions: questions.questions,
      kinds: { reads: kindsReadsOf(k05.k05) },
      ...(stopBound ? { stop: { reads: stop.stop } } : {}),
    };
    const pinned = pinnedV1();
    return { k05, questions, stop, pinned, ...bindingOver(reads, pinned.bundle) };
  }

  type Bound = ReturnType<typeof boundWith>["binding"];

  /** The binding's own settler and writers, each call written down in `order` as it reaches them, handed on unchanged. */
  function watchedOf(binding: Bound, order: string[]): Bound {
    const { settlers, writers } = binding;
    if (settlers === undefined || writers === undefined) {
      throw new Error("the binding carries the sign-up writers and S1-02's settler");
    }
    return {
      ...binding,
      settlers: (stepId) => {
        const settler = settlers(stepId);
        if (settler === null) return null;
        return (call) => {
          order.push(`settler ${call.step.id}`);
          return settler(call);
        };
      },
      writers: (stepId) => {
        const writer = writers(stepId);
        if (writer === null) return null;
        return (call) => {
          order.push(`writer ${call.step.id}`);
          return writer(call);
        };
      },
    };
  }

  /** A part naming c-01 (decide-2's one option) for `words`, through the commit's own writesOf over the binding. */
  async function answered(binding: Bound, words: string, order: string[] = []) {
    const turn = turnWithWords("c-01", words);
    expect(decidedOf(turn.context.request).context.texts.map((text) => text.words)).toEqual([words]);
    const { ports } = turnCommitDeps(watchedOf(binding, order))(NOTHING_OPEN_AT);
    return { turn, writes: await ports.writesOf(turn.part, turn.context, NOTHING_OPEN) };
  }

  /** What a part naming c-01 for `words` threw through the commit's own writesOf over the binding. */
  async function refusedWith(binding: Bound, words: string, order: string[]) {
    const turn = turnWithWords("c-01", words);
    const { ports } = turnCommitDeps(watchedOf(binding, order))(NOTHING_OPEN_AT);
    return thrownBy(ports.writesOf(turn.part, turn.context, NOTHING_OPEN));
  }

  /**
   * S1-03's or S1-74's message row (T-633 default 12): one quick reply to the turn's handle and person, no question,
   * naming its writer's step and line 0, its one row (T-1479; commit/walk/writes.ts default 16; K-05 v1.22 item 82).
   */
  const messageOf = (turn: ReturnType<typeof turnWithWords>, stepId: string) => ({
    id: `outbox-${stepId.toLowerCase()}-${turn.context.turn.id}-1`,
    recipientHandleId: "handle-sam",
    recipientPersonId: "person-sam",
    businessId: BARBERSHOP,
    bookingId: null,
    channel: requestTurnFields(turn.context.request).service,
    sendClass: "quick_reply",
    openQuestionId: null,
    copyOfRowId: null,
    versionsRead: [],
    step: stepId,
    lineNo: 0,
  });

  it("bound: 'Barbershop, pack hikes' is settled 'One isn't on the list yet' and writes S1-02's picks, S1-03's draft and S1-03's message row (not stopNotWired), the owner read through readStop for the turn's own person and handle, one read open at a time", async () => {
    const { k05, questions, stop, pinned, binding, bound } = boundWith(true);
    // Building the binding read nothing.
    expect(stop.asked).toEqual([]);
    expect(k05.asked).toEqual([]);

    const order: string[] = [];
    const { turn, writes } = await answered(binding, `Barbershop, ${PACK_HIKES}`, order);

    // The settler first; then S1-02's writer, S1-03's (which reads the stop home) and S1-11's, for the one part.
    expect(order).toEqual(["settler S1-02", "writer S1-02", "writer S1-03", "writer S1-11"]);
    expect(writes.why).toEqual({ step: "S1-02", choice: "One isn't on the list yet" });
    // The catalog once for the call, item 79 once, the stop home's five reads once each for Sam's own person and handle
    // (readStop's order), one open at a time, and the barber overlay once from the pinned bundle.
    expect(k05.asked).toEqual([
      { read: "readKindCatalog" },
      { read: "readPickedKinds", request: { businessId: BARBERSHOP, personId: "person-sam" } },
    ]);
    expect(stop.asked).toEqual(SAM_STOP_READS);
    expect(stop.peak()).toBe(1);
    expect(pinned.asked).toEqual(["barber"]);
    expect(bound.kvReads).toEqual([]);
    expect(bound.calls).toEqual([]);
    expect(questions.reads).toEqual([
      { repo: turn.context.repo, handleId: "handle-sam", openQuestionId: "oq-s1-02" },
    ]);

    // S1-02's rows (the barbershop listed; pack hikes drafted as a new_work kind, its row before its pick), S1-03's draft
    // in state drafting with no business, then S1-11's 11 text blocks of the first pick.
    const inserts = writes.state.flatMap((write) => (write.op === "insert" ? [write] : []));
    expect(inserts).toHaveLength(writes.state.length);
    expect(inserts.map((write) => write.table)).toEqual([
      "picked_kinds",
      "kinds",
      "picked_kinds",
      "new_work_drafts",
      ...PF_TEXT_KEYS.map(() => "picked_kind_texts"),
    ]);
    const picks = inserts.filter((write) => write.table === "picked_kinds").map((write) => write.values);
    expect(picks.map((pick) => [pick.position, pick.words, pick.outcome])).toEqual([
      [1, "Barbershop", "listed"],
      [2, PACK_HIKES, "new_work"],
    ]);
    const drafted = inserts.find((write) => write.table === "kinds")?.values;
    expect(drafted).toMatchObject({ name: PACK_HIKES, source: "new_work" });
    expect(picks[1]?.kind_id).toBe(drafted?.id);
    expect(inserts.find((write) => write.table === "new_work_drafts")?.values).toMatchObject({
      picked_kind_id: picks[1]?.id,
      business_id: null,
      state: "drafting",
    });
    // S1-03's message row first, then S1-04's question's own row, as the walk goes on to S1-04.
    expect(writes.messages[0]).toEqual(messageOf(turn, "S1-03"));
    expect(writes.messages.slice(1).map((row) => row.openQuestionId)).toEqual(
      writes.asks.map((ask) => ask.question.id),
    );
    expect(writes.asks.map((ask) => ask.question.step)).toEqual(["S1-04"]);
  });

  it("bound: 'Gift cards' is settled 'Not a service we book' and writes S1-02's not_booked pick and S1-74's message row (not stopNotWired), and nothing after", async () => {
    const { k05, stop, pinned, binding } = boundWith(true);

    const order: string[] = [];
    const { turn, writes } = await answered(binding, GIFT_CARDS, order);

    expect(order).toEqual(["settler S1-02", "writer S1-02", "writer S1-74"]);
    expect(writes.why).toEqual({ step: "S1-02", choice: "Not a service we book" });
    expect(k05.asked).toEqual([
      { read: "readKindCatalog" },
      { read: "readPickedKinds", request: { businessId: BARBERSHOP, personId: "person-sam" } },
    ]);
    expect(stop.asked).toEqual(SAM_STOP_READS);
    expect(stop.peak()).toBe(1);
    // No kind to set up: no trade overlay is read.
    expect(pinned.asked).toEqual([]);

    expect(writes.state.map((write) => [write.op, write.table])).toEqual([["insert", "picked_kinds"]]);
    const [pick] = writes.state.flatMap((write) => (write.op === "insert" ? [write.values] : []));
    expect(pick).toMatchObject({
      words: GIFT_CARDS,
      outcome: "not_booked",
      kind_id: null,
      business_id: null,
    });
    expect(writes.gives).toEqual([]);
    expect(writes.messages).toEqual([messageOf(turn, "S1-74")]);
    expect(writes.asks).toEqual([]);
  });

  it("left out: the same two answers stay notBuilt (stopNotWired, at S1-03 and at S1-74), as before, and no stop read is made", async () => {
    for (const [words, stepId, writers] of [
      [`Barbershop, ${PACK_HIKES}`, "S1-03", ["writer S1-02", "writer S1-03"]],
      [GIFT_CARDS, "S1-74", ["writer S1-02", "writer S1-74"]],
    ] as const) {
      const { stop, binding } = boundWith(false);
      const order: string[] = [];

      const thrown = await refusedWith(binding, words, order);

      expect(thrown, stepId).toBeInstanceOf(KindsNotBuiltError);
      expect(thrown, stepId).toMatchObject({
        name: "KindsNotBuiltError",
        call: "gateAndCommit",
        seam: "stopNotWired",
        ids: [stepId],
      });
      expect(order, stepId).toEqual(["settler S1-02", ...writers]);
      expect(stop.asked, stepId).toEqual([]);
    }
  });

  it("the stop reads bound with no kinds reads bind no writer and no settler, and are never read", () => {
    const stop = recordedStop();
    const { binding } = bindingOver({ ...baseReads(), stop: { reads: stop.stop } }, pinnedV1().bundle);
    expect(Object.hasOwn(binding, "writers")).toBe(false);
    expect(Object.hasOwn(binding, "settlers")).toBe(false);
    expect(stop.asked).toEqual([]);
  });
});

// ---- the walk's chat read (T-1519) ------------------------------------------------------------------------------------

/** The handle and chat commit-s1-01.json's turn carries (K-09 v1.5 default 135). */
const SAM_HANDLE = "handle-sam";
const SAM_CHAT_ID = "linq-chat-demo-sam";

/** Turn 1 (commit-s1-01.json's JOIN) as the commit hands it to writesOf, pinned to K-01's bundle v0 skeleton. */
type TurnOne = ReturnType<typeof turnOne>;

/** Bundle v0 as a run pinned it, for turn 1: its id as commit-s1-01.json's turn names it, and flow A's skeleton graph. */
function pinnedV0(turn: TurnOne): PinnedBundle {
  const { hash, build } = turn.context.turn.bundleId;
  const bundleId: BundleId = { hash, build };
  return {
    bundleId,
    manifest: {
      contract: "bundle.v1",
      bundleId,
      storage: { manifestKey: keyIn(bundleId, "manifest"), values: [] },
    },
    flow: (flow) =>
      flow === "A" ? Promise.resolve(flowA()) : Promise.reject(new BundleError("notInBundle")),
    trade: () => Promise.reject(new BundleError("notInBundle")),
    reads: () => [],
  };
}

/**
 * K-05 v1.10 item 51 as readChatHandle answers it on the runtime side: the phone handle `holder` (its id, its number
 * beside it) whose chat thread holds the chat id `held`, both fields null for any other chat id, or for every chat id
 * when `holder` is null; each chat id it is asked for written down in `asked`.
 */
function chatRead(
  holder: string | null,
  asked: string[],
  held = SAM_CHAT_ID,
): (request: ChatHandleRequest) => Promise<ChatHandleAnswer | ErrorAnswer> {
  return (request) => {
    asked.push(request.linqChatId);
    return Promise.resolve(
      holder === null || request.linqChatId !== held
        ? { handleId: null, handle: null }
        : { handleId: holder, handle: { kind: "phone" as const, address: "+15555550100" } },
    );
  };
}

describe("the gate's commit binding hands in the walk's chat read, only where the reads bind it, so a returning number's JOIN reuses its own chat thread (T-1519)", () => {
  /** fakeGateReads as it is (./test-support.ts): it binds no chat read. */
  const baseReads = (): GateReads => fakeGateReads(fakeTurnRows()).reads;

  /** Turn 1's writes through the commit's own writesOf over the binding realGate builds for it, over `reads`. */
  async function turnOneOver(reads: GateReads | null) {
    const turn = turnOne();
    const { binding, bound } = bindingOver(reads, pinnedV0(turn));
    const { ports } = turnCommitDeps(binding)(NOTHING_OPEN_AT);
    return { turn, binding, bound, writes: await ports.writesOf(turn.part, turn.context, NOTHING_OPEN) };
  }

  it("bound, Sam's own chat thread holding the turn's chat: the binding carries the reads' own read, and turn 1 writes no thread row and no thread.created entry, gives thread and asks S1-02's question, the read asked once for the turn's chat id alone", async () => {
    const asked: string[] = [];
    const reads: GateReads = { ...baseReads(), readChatHandle: chatRead(SAM_HANDLE, asked) };
    const { turn, binding, bound, writes } = await turnOneOver(reads);
    const today = await turnOneOver(baseReads());

    // The reads' own read, handed on as it is.
    expect(binding.readChatHandle).toBe(reads.readChatHandle);
    expect(requestTurnFields(turn.context.request).chatId).toBe(SAM_CHAT_ID);
    expect(turn.context.turn.handleId).toBe(SAM_HANDLE);
    // Asked once, for the turn's own chat id.
    expect(asked).toEqual([SAM_CHAT_ID]);
    // Today's writes but the thread: no row and no entry; S1-02's question and its quick reply as before.
    expect(today.writes.state.map((write) => [write.op, write.table])).toEqual([["insert", "threads"]]);
    expect(today.writes.stateEvents.map((entry) => entry.kind)).toEqual(["thread.created"]);
    expect(writes).toEqual({ ...today.writes, state: [], stateEvents: [] });
    expect(writes.gives).toEqual(["thread"]);
    expect(writes.gives).toEqual(turn.exchange.given.stated.gives);
    expect(writes.asks.map((ask) => ask.question.step)).toEqual(["S1-02"]);
    expect(writes.messages.map((row) => row.openQuestionId)).toEqual(
      writes.asks.map((ask) => ask.question.id),
    );
    // The chat id is in no write: its one home is the thread row, which already holds it. Nothing went past the pinned
    // bundle to KV or to PostgreSQL's copy.
    expect(JSON.stringify(writes)).not.toContain(SAM_CHAT_ID);
    expect(bound.kvReads).toEqual([]);
    expect(bound.calls).toEqual([]);
  });

  it("bound, no chat thread holding the turn's chat, or another handle's: S1-01 inserts the thread exactly as with no read bound, the read asked once each", async () => {
    const today = await turnOneOver(baseReads());
    for (const holder of [null, "handle-alex"]) {
      const asked: string[] = [];
      const { writes } = await turnOneOver({ ...baseReads(), readChatHandle: chatRead(holder, asked) });
      expect(writes, String(holder)).toEqual(today.writes);
      expect(asked, String(holder)).toEqual([SAM_CHAT_ID]);
    }
    const [thread] = today.writes.state;
    expect(thread?.op === "insert" ? thread.values : null).toMatchObject({
      handle_id: SAM_HANDLE,
      kind: "chat",
      linq_chat_id: SAM_CHAT_ID,
    });
  });

  it("bound, the read answering an error: the walk fails closed with TurnFaceReadError naming the read and its code alone, never read as none", async () => {
    const asked: string[] = [];
    const failing = (request: ChatHandleRequest): Promise<ChatHandleAnswer | ErrorAnswer> => {
      asked.push(request.linqChatId);
      return Promise.resolve({ error: "transient" });
    };
    const thrown = await thrownBy(turnOneOver({ ...baseReads(), readChatHandle: failing }));

    expect(thrown).toBeInstanceOf(TurnFaceReadError);
    expect(thrown).toMatchObject({ read: "readChatHandle", code: "transient" });
    expect(String(thrown)).not.toContain(SAM_CHAT_ID);
    expect(asked).toEqual([SAM_CHAT_ID]);
  });

  it("left out: fakeGateReads as it is, and no reads at all, carry no chat read, and turn 1 inserts S1-01's thread with its entry, as before", async () => {
    for (const reads of [baseReads(), null]) {
      const { binding, writes } = await turnOneOver(reads);
      expect(Object.hasOwn(binding, "readChatHandle")).toBe(false);
      expect(binding.readChatHandle).toBeUndefined();
      expect(writes.state.map((write) => write.table)).toEqual(["threads"]);
      expect(writes.stateEvents.map((entry) => entry.kind)).toEqual(["thread.created"]);
      expect(writes.gives).toEqual(["thread"]);
    }
  });

  it("bound beside the question read, the kinds reads and the stop reads (staging's shape): each is handed on, and building the binding reads none of them", () => {
    const asked: string[] = [];
    const k05 = fakeK05();
    const stop = recordedStop();
    const questions = questionsOver();
    const reads: GateReads = {
      ...baseReads(),
      questions: questions.questions,
      kinds: { reads: kindsReadsOf(k05.k05) },
      stop: { reads: stop.stop },
      readChatHandle: chatRead(SAM_HANDLE, asked),
    };
    const { binding } = bindingOver(reads, pinnedV1().bundle);

    expect(binding.readChatHandle).toBe(reads.readChatHandle);
    expect(binding.questions).toBe(reads.questions);
    expect(typeof binding.writers).toBe("function");
    expect(typeof binding.settlers).toBe("function");
    expect(asked).toEqual([]);
    expect(k05.asked).toEqual([]);
    expect(stop.asked).toEqual([]);
    expect(questions.reads).toEqual([]);
  });
});

// ---- the one-kind path (T-1494) -----------------------------------------------------------------------------------------

/** Bundle v2's id, as its manifest names it: the bundle the run pinned in the one-kind cases (T-1477; DL-1111). */
const BUNDLE_V2: BundleId = bundleV2Id();

/**
 * Bundle v2 as a run pinned it: its own manifest and flow A (bundle v1's six steps plus S1-08 and S1-09), and for each
 * trade bundles/v2's own overlay of barber, plumber and electrician, BundleError notInBundle for any other, each trade
 * asked for written down.
 */
function pinnedV2(): PinnedV1 {
  const asked: string[] = [];
  const held = new Set(["barber", "plumber", "electrician"]);
  const published = publishedBundleV2();
  const flowAV2 = published.flows.A as Readonly<Record<string, unknown>>;
  const bundle: PinnedBundle = {
    bundleId: BUNDLE_V2,
    manifest: published.manifest as unknown as Manifest,
    flow: (flow) =>
      flow === "A" ? Promise.resolve(flowAV2) : Promise.reject(new BundleError("notInBundle")),
    trade(tradeId) {
      asked.push(tradeId);
      return held.has(tradeId)
        ? Promise.resolve(overlayV2(tradeId) as unknown as TradeOverlay)
        : Promise.reject(new BundleError("notInBundle"));
    },
    reads: () => [],
  };
  return { bundle, asked };
}

/** How many of the binding's reads are open at once, across every port they are counted on (each its own connection). */
interface OpenReads {
  open: number;
  peak: number;
}

type ReadPort = (...args: never[]) => Promise<unknown>;

/** `ports` with each of its functions counted in `reads` from its call until its answer settles, handed on unchanged. */
function countedPorts<T extends object>(ports: T, reads: OpenReads): T {
  const entries = Object.entries(ports).map(([name, port]: [string, unknown]): [string, unknown] => {
    if (typeof port !== "function") return [name, port];
    const read = port as ReadPort;
    return [
      name,
      async (...args: never[]) => {
        reads.open += 1;
        reads.peak = Math.max(reads.peak, reads.open);
        try {
          return await read(...args);
        } finally {
          reads.open -= 1;
        }
      },
    ];
  });
  return Object.fromEntries(entries) as T;
}

describe("the gate's commit binding hands in the one-kind path where the reads bind it, so an owner with one kept kind of work is never asked S1-04 and gets S1-08's row and S1-09's question (T-1494)", () => {
  /** fakeGateReads as it is (./test-support.ts): it binds none of the sign-up reads. */
  const baseReads = (): GateReads => fakeGateReads(fakeTurnRows()).reads;

  /** Which of staging's sign-up reads a case binds beside the question read: each is bound unless set false. */
  interface Given {
    readonly kinds?: boolean;
    readonly stop?: boolean;
    readonly companies?: boolean;
    /** (T-1485) What the one-kind reads answer (default: Sam's company and its barber kind, no pick yet). */
    readonly world?: CompaniesGiven;
    /** (T-1485) The live questions the question read answers for Sam's handle (default: S1-02's). */
    readonly questions?: readonly OpenQuestionRead[];
  }

  /**
   * The binding realGate builds for one call over staging's shape of reads (the question read with S1-02's question open,
   * the kinds reads over the 243 seeded kinds, the stop home's reads where Sam's mobile texts, and the one-kind reads
   * with Sam's company of Lee's Barbershop and its barber kind on file, no pick yet, unless `world` and `questions` say
   * otherwise), each read counted while open, the run's pinned bundle v2.
   */
  function oneKindBound(given: Given = {}) {
    const reads: OpenReads = { open: 0, peak: 0 };
    const k05 = fakeK05();
    const companies = fakeCompaniesK05(given.world);
    const stop = recordedStop();
    const questions = given.questions === undefined ? questionsOver() : questionsOver(given.questions);
    const gateReads: GateReads = {
      ...baseReads(),
      questions: questions.questions,
      ...(given.kinds === false ? {} : { kinds: { reads: kindsReadsOf(countedPorts(k05.k05, reads)) } }),
      ...(given.stop === false ? {} : { stop: { reads: countedPorts(stop.stop, reads) } }),
      ...(given.companies === false
        ? {}
        : { companies: companiesReadsOf(countedPorts(companies.k05, reads)) }),
    };
    const pinned = pinnedV2();
    return {
      reads,
      k05,
      companies,
      stop,
      questions,
      pinned,
      gateReads,
      ...bindingOver(gateReads, pinned.bundle),
    };
  }

  type Bound = ReturnType<typeof oneKindBound>["binding"];

  /** The binding's own settlers, writers and buttons settlers, each call written down in `order`, handed on unchanged. */
  function watchedOf(binding: Bound, order: string[]): Bound {
    const { settlers, writers, buttonsSettlers } = binding;
    if (settlers === undefined || writers === undefined) {
      throw new Error("the binding carries the sign-up writers and S1-02's settler");
    }
    return {
      ...binding,
      settlers: (stepId) => {
        const settler = settlers(stepId);
        if (settler === null) return null;
        return (call) => {
          order.push(`settler ${call.step.id}`);
          return settler(call);
        };
      },
      writers: (stepId) => {
        const writer = writers(stepId);
        if (writer === null) return null;
        return (call) => {
          order.push(`writer ${call.step.id}`);
          return writer(call);
        };
      },
      ...(buttonsSettlers === undefined
        ? {}
        : {
            buttonsSettlers: (stepId: string) => {
              const settler = buttonsSettlers(stepId);
              if (settler === null) return null;
              return (call: Parameters<ButtonsSettler>[0]) => {
                order.push(`buttons ${call.step.id}`);
                return settler(call);
              };
            },
          }),
    };
  }

  /** A part naming c-01 ("All on the list") for `words`, pinned to bundle v2, through the commit's own writesOf. */
  async function walkedOnV2(binding: Bound, words: string, order: string[] = []) {
    const turn = turnWithWords("c-01", words);
    expect(decidedOf(turn.context.request).context.texts.map((text) => text.words)).toEqual([words]);
    const context = { ...turn.context, turn: { ...turn.context.turn, bundleId: { ...BUNDLE_V2 } } };
    const { ports } = turnCommitDeps(watchedOf(binding, order))(NOTHING_OPEN_AT);
    return { turn, context, writes: await ports.writesOf(turn.part, context, NOTHING_OPEN) };
  }

  it("bound (staging's shape): the binding carries S1-04's buttons settler alone, S1-04's own writer (T-1485) and S1-08's writer beside T-1516's writers and S1-02's settler; building it reads nothing", () => {
    const { reads, k05, companies, stop, pinned, binding } = oneKindBound();
    const { buttonsSettlers, writers, settlers } = binding;
    if (buttonsSettlers === undefined || writers === undefined || settlers === undefined) {
      throw new Error("the binding carries the one-kind path");
    }
    expect(typeof buttonsSettlers("S1-04")).toBe("function");
    for (const stepId of ["S1-02", "S1-08", "S1-09", "s1-04", "", "__proto__"]) {
      expect(buttonsSettlers(stepId), stepId).toBeNull();
    }
    // T-1485 (H2b): S1-04's own writer is bound beside the buttons settler (it was null under H2a).
    for (const stepId of ["S1-02", "S1-03", "S1-74", "S1-11", "S1-04", "S1-08"]) {
      expect(typeof writers(stepId), stepId).toBe("function");
    }
    for (const stepId of ["S1-01", "S1-09", "s1-04", "", "__proto__"]) {
      expect(writers(stepId), stepId).toBeNull();
    }
    expect(typeof settlers("S1-02")).toBe("function");
    expect(settlers("S1-04")).toBeNull();
    // Building the binding read nothing.
    expect(reads.peak).toBe(0);
    expect(k05.asked).toEqual([]);
    expect(companies.asked).toEqual([]);
    expect(stop.asked).toEqual([]);
    expect(pinned.asked).toEqual([]);
  });

  it("bound: 'Plumbing' on bundle v2 runs S1-02's settler, S1-02's writer inside the companies wrapper, S1-11's writer, S1-04's buttons settler and S1-08's writer, every read one after another, and ends at S1-09's question with no S1-04 question", async () => {
    const { reads, k05, companies, stop, pinned, binding, bound } = oneKindBound();
    // T-1485 (H2b): the whole H1b binding, S1-04's own writer bound too (the architect's note b on T-1484).
    expect(typeof binding.writers?.("S1-04")).toBe("function");
    const order: string[] = [];

    const { turn, writes } = await walkedOnV2(binding, "Plumbing", order);

    // S1-02's settler and writer (the wrapper inside T-634's), S1-11's blocks, S1-04 settled, not asked, then S1-08:
    // S1-04's writer is never asked on this walk.
    expect(order).toEqual(["settler S1-02", "writer S1-02", "writer S1-11", "buttons S1-04", "writer S1-08"]);
    // The catalog and item 79 for S1-02's writer; item 79, item 72 and the catalog by id for the one-kind pieces, each
    // once for the walk, for the call's business and the turn's person; the stop home for S1-08's writer alone (no S1-03
    // or S1-74 message is walked); never two reads open at once.
    expect(k05.asked).toEqual([
      { read: "readKindCatalog" },
      { read: "readPickedKinds", request: { businessId: BARBERSHOP, personId: "person-sam" } },
    ]);
    expect(companies.asked.map((asked) => [asked.read, asked.request.businessId])).toEqual([
      ["readPickedKinds", BARBERSHOP],
      ["readBusinessKinds", BARBERSHOP],
      ["readTurnState", BARBERSHOP],
    ]);
    expect(stop.asked).toEqual(SAM_STOP_READS);
    expect(reads.peak).toBe(1);
    expect(reads.open).toBe(0);
    // The trade once, plumber's, from the pinned bundle v2 and nowhere else.
    expect(pinned.asked).toEqual(["plumber"]);
    expect(bound.kvReads).toEqual([]);
    expect(bound.calls).toEqual([]);

    // The one pick placed on its own insert under Sam's company and the call's business, its company kind first (the
    // barber one is on file, plumber's is not), then S1-11's 11 blocks of plumber under that business.
    expect(writes.closes.map((close) => [close.id, close.status])).toEqual([["oq-s1-02", "answered"]]);
    expect(writes.state.map((write) => `${write.op} ${write.table}`)).toEqual([
      "insert company_kinds",
      "insert picked_kinds",
      ...PF_TEXT_KEYS.map(() => "insert picked_kind_texts"),
    ]);
    const plumber = catalogDefaults("plumber");
    const [kind, pick, ...texts] = writes.state;
    expect(kind).toEqual({
      op: "insert",
      table: "company_kinds",
      values: {
        company_id: SAM_COMPANY,
        kind_id: "plumber",
        business_id: BARBERSHOP,
        trade_name: null,
        pf_facts: plumber.facts,
        pf_switches_a: plumber.switchesA,
        pf_switches_b: plumber.switchesB,
      },
    });
    const pickId = `pick-s1-02-${turn.context.turn.id}-1`;
    expect(pick).toMatchObject({
      op: "insert",
      table: "picked_kinds",
      values: {
        id: pickId,
        kind_id: "plumber",
        outcome: "listed",
        company_id: SAM_COMPANY,
        business_id: BARBERSHOP,
      },
    });
    const blocks = overlayV2("plumber").pluginText as Record<string, string>;
    expect(texts.map((text) => (text.op === "insert" ? text.values : null))).toEqual(
      PF_TEXT_KEYS.map((key) => ({
        picked_kind_id: pickId,
        pf_key: key,
        business_id: BARBERSHOP,
        block: blocks[key],
      })),
    );

    // No S1-04 question: S1-08's row (no question, step S1-08, line 0), then S1-09's question and its row.
    const key = turn.context.turn.id;
    expect(writes.asks.map((ask) => [ask.question.id, ask.question.step])).toEqual([
      [`oq-s1-09-${key}-1`, "S1-09"],
    ]);
    expect(
      writes.messages.map((row) => [row.id, row.step, row.lineNo, row.openQuestionId, row.sendClass]),
    ).toEqual([
      [`outbox-s1-08-${key}-1`, "S1-08", 0, null, "quick_reply"],
      [`outbox-s1-09-${key}-1`, "S1-09", 0, `oq-s1-09-${key}-1`, "quick_reply"],
    ]);
    expect(writes.gives).toEqual([...commitS1_02().given.stated.gives, "companies"]);
  });

  it("bound: 'Barbershop, plumbing, electrical' still asks S1-04, its writes those of the binding with the one-kind reads left out", async () => {
    const order: string[] = [];
    const bound = await walkedOnV2(oneKindBound().binding, "Barbershop, plumbing, electrical", order);
    const today = await walkedOnV2(
      oneKindBound({ companies: false }).binding,
      "Barbershop, plumbing, electrical",
    );

    expect(order).toEqual(["settler S1-02", "writer S1-02", "writer S1-11", "buttons S1-04"]);
    expect(bound.writes.asks.map((ask) => ask.question.step)).toEqual(["S1-04"]);
    expect(bound.writes).toEqual(today.writes);
  });

  it("left out: no buttons settler and no S1-04 writer, as T-1516's binding (S1-08's writer bound beside the stop reads since T-1485, which no walk reaches), 'Plumbing' asks S1-04 as today, and no one-kind read is made", async () => {
    const { companies, binding } = oneKindBound({ companies: false });
    expect(Object.hasOwn(binding, "buttonsSettlers")).toBe(false);
    expect(binding.writers?.("S1-04")).toBeNull();
    // T-1485: S1-08's writer is bound wherever the stop reads are (K-09 README default 189; commit.ts default 6).
    expect(typeof binding.writers?.("S1-08")).toBe("function");

    const order: string[] = [];
    const { writes } = await walkedOnV2(binding, "Plumbing", order);

    expect(order).toEqual(["settler S1-02", "writer S1-02", "writer S1-11"]);
    expect(writes.asks.map((ask) => ask.question.step)).toEqual(["S1-04"]);
    expect(writes.messages.map((row) => row.step)).toEqual(["S1-04"]);
    expect(writes.state.map((write) => write.table)).not.toContain("company_kinds");
    expect(companies.asked).toEqual([]);
  });

  it("bound with no stop reads: S1-04's buttons settler and no S1-08 writer, so 'Plumbing' is refused at S1-08 (notBuilt) with nothing returned", async () => {
    const { binding, stop } = oneKindBound({ stop: false });
    expect(typeof binding.buttonsSettlers?.("S1-04")).toBe("function");
    expect(binding.writers?.("S1-08")).toBeNull();

    const order: string[] = [];
    const thrown = await thrownBy(walkedOnV2(binding, "Plumbing", order));

    expect(thrown).toBeInstanceOf(WalkNotBuiltError);
    expect(order).toEqual(["settler S1-02", "writer S1-02", "writer S1-11", "buttons S1-04"]);
    expect(stop.asked).toEqual([]);
  });

  it("bound with no kinds reads: no writer, no settler and no buttons settler, and the one-kind reads are never read", () => {
    const { binding, companies } = oneKindBound({ kinds: false });
    for (const field of ["writers", "settlers", "buttonsSettlers"]) {
      expect(Object.hasOwn(binding, field), field).toBe(false);
    }
    expect(companies.asked).toEqual([]);
  });

  // ---- T-1485 (H2b): S1-04's writer for an answer to an S1-04 that was asked ---------------------------------------------

  describe("staging's shape hands S1-04's writer its deps, the party rule's flag off, so an owner's answer to an S1-04 that was asked is written and walked on to S1-08's row and S1-09's question (T-1485)", () => {
    const ALL_SHARE_ONE = "c-02";
    const SOME_SHARE_ONE = "c-01";

    /** A pick's 11 plug-in text blocks as item 79 answers them: in the pf keys' order, each at version 1, no business. */
    const textsOf = (pickId: string): PickedKindRead["texts"] =>
      // K-05 v1.19 types `texts` as a list of at most 11; the pf keys are exactly 11.
      PF_TEXT_KEYS.map((key) => ({
        rowId: `${pickId}/${key}`,
        pfKey: key,
        businessId: null,
        version: 1,
      })) as PickedKindRead["texts"];

    /** Sam's three picks after commit-s1-02.json, none placed, the barbershop first with its 11 blocks. */
    const samPicks = (): PickedKindRead[] => [
      pickOnFile({
        id: "pick-sam-barbershop",
        words: "Barbershop",
        kindId: "barber",
        texts: textsOf("pick-sam-barbershop"),
      }),
      pickOnFile({ id: "pick-sam-plumbing", position: 2, words: "plumbing" }),
      pickOnFile({ id: "pick-sam-electrical", position: 3, words: "electrical", kindId: "electrician" }),
    ];

    /**
     * S1-04's question to Sam as the walk reads its row on the answering turn: commit-s1-04-some-share.json's
     * oq-s1-04-sam, asked as the walk asks a plain step's buttons (no options, no read-back), open at version 1.
     */
    function samS1_04Row(): OpenQuestionRead {
      const { request } = s1_04Exchange(COMMIT_S1_04_SOME_SHARE);
      const [asked] = decidedOf(request).context.openQuestions;
      if (asked === undefined)
        throw new Error("commit-s1-04-some-share.json's context names S1-04's question");
      return {
        id: asked.openQuestionId,
        businessId: asked.target.businessId,
        bookingId: asked.target.bookingId,
        personId: request.caller.personId,
        turnId: "turn-s1-02-sam-kinds",
        step: asked.step,
        status: "open",
        options: [],
        readback: null,
        versionsRead: [],
        clock: null,
        sentAt: asked.sentAt.utc,
        pollId: asked.pollId,
        askCount: asked.askCount,
        bundleId: BUNDLE_V2,
        version: 1,
      };
    }

    /** Staging's shape over Sam's three picks on file and his S1-04 question open, each read counted while open. */
    const answering = (given: Given = {}) =>
      oneKindBound({ ...given, world: { picks: samPicks() }, questions: [samS1_04Row()] });

    /**
     * Sam's answer to S1-04 (commit-s1-04-some-share.json's turn, pinned to bundle v2, its one part choosing `choiceId`
     * with `fields`) through the commit's own writesOf over the binding, each settler and writer it reaches in `order`.
     */
    function answeredOnV2(
      binding: Bound,
      choiceId: string,
      fields: readonly AnswerField[],
      order: string[] = [],
    ) {
      const { request } = s1_04Exchange(COMMIT_S1_04_SOME_SHARE, choiceId, fields);
      requestTurnFields(request).bundleId = { ...BUNDLE_V2 };
      const decided = decidedOf(request);
      decided.context.bundleId = { ...BUNDLE_V2 };
      decided.decide.bundleId = { ...BUNDLE_V2 };
      const { ports } = turnCommitDeps(watchedOf(binding, order))(NOTHING_OPEN_AT);
      return ports.writesOf(passedPartOf(request), contextOf(request), NOTHING_OPEN);
    }

    const shared = (words: string): AnswerField => ({ name: "shared_kinds", value: words, words });
    const named = (words: string): AnswerField => ({ name: "company_name", value: words, words });
    /** Sam's own answer (commit-s1-04-some-share.json): plumbing and electrical share Lee Home Services. */
    const SAMS_ANSWER = [shared("Plumbing and electrical"), named("Lee Home Services")];

    it("'They all share one company' (All share one): S1-04's writer, then S1-08's writer, never the buttons settler; the question closed at its version, Sam's three picks placed in his company under his business with the plumber and electrician company kinds first (barber kept), the barbershop's 11 blocks given the business, then S1-08's row and S1-09's question; every read one after another", async () => {
      const { reads, k05, companies, stop, questions, binding } = answering();
      const order: string[] = [];

      const writes = await answeredOnV2(binding, ALL_SHARE_ONE, [], order);

      expect(order).toEqual(["writer S1-04", "writer S1-08"]);
      expect(questions.reads.map((read) => [read.handleId, read.openQuestionId])).toEqual([
        ["handle-sam", "oq-s1-04-sam"],
      ]);
      expect(writes.closes).toEqual([
        { id: "oq-s1-04-sam", expectVersion: 1, status: "answered", answeredOptionId: null },
      ]);
      expect(writes.state.map((write) => `${write.op} ${write.table}`)).toEqual([
        "insert company_kinds",
        "insert company_kinds",
        "update picked_kinds",
        "update picked_kinds",
        "update picked_kinds",
        ...PF_TEXT_KEYS.map(() => "update picked_kind_texts"),
      ]);
      const [plumber, electrician, ...rest] = writes.state;
      for (const [write, kindId] of [
        [plumber, "plumber"],
        [electrician, "electrician"],
      ] as const) {
        const defaults = catalogDefaults(kindId);
        expect(write, kindId).toEqual({
          op: "insert",
          table: "company_kinds",
          values: {
            company_id: SAM_COMPANY,
            kind_id: kindId,
            business_id: BARBERSHOP,
            trade_name: null,
            pf_facts: defaults.facts,
            pf_switches_a: defaults.switchesA,
            pf_switches_b: defaults.switchesB,
          },
        });
      }
      expect(rest.slice(0, 3)).toEqual(
        ["pick-sam-barbershop", "pick-sam-plumbing", "pick-sam-electrical"].map((id) => ({
          op: "update",
          table: "picked_kinds",
          key: { id },
          expectVersion: 1,
          set: { company_id: SAM_COMPANY, business_id: BARBERSHOP },
        })),
      );
      expect(rest.slice(3)).toEqual(
        PF_TEXT_KEYS.map((key) => ({
          op: "update",
          table: "picked_kind_texts",
          key: { picked_kind_id: "pick-sam-barbershop", pf_key: key },
          expectVersion: 1,
          set: { business_id: BARBERSHOP },
        })),
      );
      // No S1-04 question again: S1-08's row (no question), then S1-09's question and its row, their ids built from the
      // answering turn's id (K-09 v1.5 default 131).
      const key = String(requestTurnFields(s1_04Exchange(COMMIT_S1_04_SOME_SHARE).request).id);
      expect(writes.asks.map((ask) => [ask.question.id, ask.question.step])).toEqual([
        [`oq-s1-09-${key}-1`, "S1-09"],
      ]);
      expect(
        writes.messages.map((row) => [row.id, row.step, row.lineNo, row.openQuestionId, row.sendClass]),
      ).toEqual([
        [`outbox-s1-08-${key}-1`, "S1-08", 0, null, "quick_reply"],
        [`outbox-s1-09-${key}-1`, "S1-09", 0, `oq-s1-09-${key}-1`, "quick_reply"],
      ]);
      expect(writes.gives).toEqual(["companies"]);
      // S1-04's writer read item 79 once, item 72 once and the catalog once for each kind it adds; the stop home for
      // S1-08's writer alone; no kinds read; never two reads open at once.
      expect(companies.asked.map((asked) => [asked.read, asked.request.businessId])).toEqual([
        ["readPickedKinds", BARBERSHOP],
        ["readBusinessKinds", BARBERSHOP],
        ["readTurnState", BARBERSHOP],
        ["readTurnState", BARBERSHOP],
      ]);
      expect(stop.asked).toEqual(SAM_STOP_READS);
      expect(k05.asked).toEqual([]);
      expect(reads.peak).toBe(1);
      expect(reads.open).toBe(0);
    });

    it("Sam's own answer needs a second company: with the party rule's flag off, as staging hands it, it is refused (CompaniesRefusedError secondCompany, naming S1-04 alone) with nothing returned, before item 72 or S1-08 is reached", async () => {
      const { companies, stop, binding } = answering();
      const order: string[] = [];

      const thrown = await thrownBy(answeredOnV2(binding, SOME_SHARE_ONE, SAMS_ANSWER, order));

      expect(thrown).toBeInstanceOf(CompaniesRefusedError);
      expect(thrown).toMatchObject({ name: "CompaniesRefusedError", fault: "secondCompany", ids: ["S1-04"] });
      // The message names the fault and the step alone: none of the owner's words.
      expect((thrown as Error).message).toBe(new CompaniesRefusedError("secondCompany", ["S1-04"]).message);
      for (const words of ["Lee Home Services", "Plumbing and electrical"]) {
        expect((thrown as Error).message).not.toContain(words);
      }
      expect(order).toEqual(["writer S1-04"]);
      expect(companies.asked.map((asked) => asked.read)).not.toContain("readBusinessKinds");
      expect(stop.asked).toEqual([]);
    });

    it("the one-kind reads left out: no S1-04 writer, so 'They all share one company' is notBuilt (gives) before any read; S1-08's writer stays bound beside the stop reads", async () => {
      const { companies, questions, binding } = answering({ companies: false });
      expect(binding.writers?.("S1-04")).toBeNull();
      expect(typeof binding.writers?.("S1-08")).toBe("function");
      const order: string[] = [];

      const thrown = await thrownBy(answeredOnV2(binding, ALL_SHARE_ONE, [], order));

      expect(thrown).toBeInstanceOf(WalkNotBuiltError);
      expect(thrown).toMatchObject({ seam: "gives", ids: ["S1-04", "companies"] });
      expect(order).toEqual([]);
      expect(questions.reads).toEqual([]);
      expect(companies.asked).toEqual([]);
    });

    it("the stop reads left out: S1-04's writer and no S1-08 writer, so 'They all share one company' is refused at S1-08 (notBuilt) before any read", async () => {
      const { companies, stop, questions, binding } = answering({ stop: false });
      expect(typeof binding.writers?.("S1-04")).toBe("function");
      expect(binding.writers?.("S1-08")).toBeNull();
      const order: string[] = [];

      const thrown = await thrownBy(answeredOnV2(binding, ALL_SHARE_ONE, [], order));

      expect(thrown).toBeInstanceOf(WalkNotBuiltError);
      expect(thrown).toMatchObject({ ids: ["S1-08"] });
      expect(order).toEqual([]);
      expect(questions.reads).toEqual([]);
      expect(companies.asked).toEqual([]);
      expect(stop.asked).toEqual([]);
    });
  });
});
