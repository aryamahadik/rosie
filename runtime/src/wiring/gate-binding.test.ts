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
//      picked_kind_texts inserts; with both left out it carries neither field.
//
// Under test, as they are: ./real.ts's binding and its bundles; @rosie/actions' turnCommitDeps, T-1461's walk on bundle
// v1's flow A, T-633's writers with T-632's matcher and T-634's writer. Doubles, for ports only: the pinned bundle (bundle
// v1's own flow A and trade overlays, read from bundles/v1), the bundle port (../bundle/test-support), the question read
// and K-05 items 78 and 79 (@rosie/actions' own doubles, as T-1468's unit test binds them), and ./test-support's
// fakeGateReads as it is. Test values only (rule 9): the contracts' fixtures, bundle v1 and the master's sample cast.
import { BARBERSHOP } from "@rosie/actions/src/domain/safety/test-support";
import {
  NOTHING_OPEN,
  bundleV1Id,
  flowAV1,
  questionsOver,
  s1_02QuestionRow,
  tradeOverlayV1,
  turnTwoOnV1,
} from "@rosie/actions/src/commit/walk/test-support";
import type { WalkQuestions } from "@rosie/actions/src/commit/walk";
import { kindsReadsOf } from "@rosie/actions/src/tool-api/journey-1/kinds/reads";
import { fakeK05 } from "@rosie/actions/src/tool-api/journey-1/kinds/test-support";
import { PF_TEXT_KEYS } from "@rosie/actions/src/tool-api/journey-1/plug-ins/plug-in";
import { NOTHING_OPEN_AT, turnCommitDeps } from "@rosie/actions/src/tool-api/turn-face/commit";
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
