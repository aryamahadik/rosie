// T-136: the path model. Proofs of the card:
//   - aba A10-01 on list|none|bill with aba's own switches gives the pf:sensitive words (the step.js --prof trap);
//   - cpa with the header-only fact `documents` is accepted, because the path object is built directly;
//   - a trade never gets a money path it does not list (cpa on list|card|counter is refused);
//   - 46 distinct (flow, money path) pairs are in use across the 243 trades;
//   - the words of 5 trades x 3 paths (both flows) equal what the vendored functions give.
//
// The reference side is a second, separate copy of lib.js and overlay-core.js (its own loader), run the way the
// master's tools run them: CORE.apply() on the master's JSON files, the trade's paths from lib.js pathsFor() with the
// trade's switches and facts fixed, and the words from CORE.walkSets / resolveVary / firstTexts / applyStops.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { listTradeIds, loadTrade, loadTrades } from "../load/trade";
import { applyTrade, type AppliedTrade } from "../overlay/apply";
import { makeCjsLoader } from "../overlay/cjs-load";
import {
  FixtureError,
  InvalidBookingError,
  UnlistedMoneyPathError,
  applyStops,
  distinctMoneyPaths,
  firstTexts,
  lit,
  makeTradePath,
  pathName,
  resolveVary,
  stepOf,
  toCorePath,
  tradeFacts,
  tradePaths,
  tradeSwitches,
  walkPath,
  type TradePath,
} from "./index";

const WORK = fileURLToPath(new URL("../../../fixtures/master/engine/work/", import.meta.url));
vi.setConfig({ testTimeout: 120_000 });

const master = loadMaster();

type Obj = Record<string, unknown>;

interface RefCorePath extends Obj {
  price: string;
  before: string;
  after: string;
  fix?: string;
}

interface RefStep extends Obj {
  id: string;
  off?: string;
  branches?: { label: string; when?: unknown; off?: string; steps: RefStep[] }[];
}

/** The vendored functions on their own copy, the way the master's tools call them. */
interface Reference {
  CORE: {
    apply(m: unknown, o: unknown, f: FlowLetter): { flow: RefFlow; errors: string[] };
    switchesOf(o: unknown, f: FlowLetter): Record<string, boolean>;
    factsOf(o: unknown): string[] | null;
    bookingOf(o: unknown, f: FlowLetter, flow: RefFlow): Record<string, string[]>;
    resolveVary(step: RefStep, path: RefCorePath): { step: RefStep; keys: string[] };
    firstTexts(steps: RefStep[], path: RefCorePath, opts: { names: unknown }): Record<string, unknown>;
    applyStops(step: RefStep, rec: unknown): RefStep;
    walkSets(
      steps: RefStep[],
      path: RefCorePath,
      fn: (step: RefStep, reading: RefCorePath, trail: string[], branch?: unknown) => void,
      opts: { off: boolean },
    ): unknown;
    setsScopes(steps: RefStep[]): unknown[];
    lit(when: unknown, path: RefCorePath): boolean;
    syncWays(flow: RefFlow): void;
  };
  pathsFor(
    cs: RefCorePath[],
    steps: RefStep[],
    allowed: Record<string, string[]>,
    fixed: boolean,
    opts: { mix: boolean; fl: FlowLetter },
  ): RefCorePath[];
  pathName(path: RefCorePath): string;
  parsePath(text: string, fl: FlowLetter): Obj;
}

interface RefFlow extends Obj {
  steps: RefStep[];
  names: unknown;
}

const ref = makeCjsLoader()(`${WORK}build/lib.js`) as Reference;

function dropAuthoring(steps: unknown): void {
  if (!Array.isArray(steps)) return;
  for (const step of steps as Obj[]) {
    delete step.src;
    delete step.prop;
    if (Array.isArray(step.branches)) {
      for (const branch of step.branches as Obj[]) dropAuthoring(branch.steps);
    }
  }
}

function readJson(file: string): Obj {
  return JSON.parse(readFileSync(file, "utf8")) as Obj;
}

/** The reference's applied flow for one trade and flow, from the files as they are (Master Corrections R2 aside). */
function refApply(id: string, flow: FlowLetter): { overlay: Obj; flow: RefFlow } {
  const raw = readJson(`${WORK}master/master-${flow}.json`);
  dropAuthoring(raw.steps);
  const overlay = readJson(`${WORK}prof/${id}.json`);
  const ops = ((overlay[flow] as Obj).ops as Obj[] | undefined) ?? [];
  for (const op of ops) {
    dropAuthoring(op.steps);
    if (op.branch) dropAuthoring([{ branches: [op.branch] }]);
  }
  const result = ref.CORE.apply(raw, overlay, flow);
  expect(result.errors).toEqual([]);
  return { overlay, flow: result.flow };
}

function live(steps: RefStep[]): RefStep[] {
  return steps
    .filter((step) => step.off === undefined)
    .map((step) =>
      step.branches === undefined
        ? step
        : {
            ...step,
            branches: step.branches
              .filter((branch) => branch.off === undefined)
              .map((branch) => ({ ...branch, steps: live(branch.steps) })),
          },
    );
}

/** The reference's paths for a trade and flow: lib.js pathsFor with the trade's own switches and facts fixed. */
function refPaths(id: string, flow: FlowLetter): RefPaths {
  const key = `${id} ${flow}`;
  const hit = refCache.get(key);
  if (hit !== undefined) return hit;
  const made = refPathsOf(id, flow);
  refCache.set(key, made);
  return made;
}

interface RefPaths {
  paths: RefCorePath[];
  applied: { overlay: Obj; flow: RefFlow };
}
const refCache = new Map<string, RefPaths>();

function refPathsOf(id: string, flow: FlowLetter): RefPaths {
  const applied = refApply(id, flow);
  const { overlay } = applied;
  const combos = ((overlay.money as Obj)[flow] as { combos: string[] }).combos;
  const pf = ref.CORE.switchesOf(overlay, flow);
  const facts = ref.CORE.factsOf(overlay);
  const allowed = ref.CORE.bookingOf(overlay, flow, applied.flow);
  const cs = combos.map((k) => {
    const [price = "", before = "", after = ""] = k.split("|");
    return { price, before, after, pf, facts };
  });
  ref.CORE.syncWays(applied.flow);
  const paths = ref.pathsFor(cs, live(applied.flow.steps), allowed, true, { mix: false, fl: flow });
  return { paths, applied };
}

/** Every [id, words] a path shows, from the vendored walk. */
function refWords(flow: RefFlow, path: RefCorePath): [string, RefStep][] {
  ref.CORE.syncWays(flow);
  const stops = ref.CORE.firstTexts(flow.steps, path, { names: flow.names });
  const out: [string, RefStep][] = [];
  ref.CORE.walkSets(
    flow.steps,
    path,
    (step, reading, _trail, branch) => {
      if (branch !== undefined) return;
      out.push([step.id, ref.CORE.applyStops(ref.CORE.resolveVary(step, reading).step, stops[step.id])]);
    },
    { off: true },
  );
  return out;
}

// One apply takes about half a second: each trade and flow is applied once for the tests that only read it.
const appliedCache = new Map<string, AppliedTrade>();
function applied(id: string, flow: FlowLetter): AppliedTrade {
  const key = `${id} ${flow}`;
  let hit = appliedCache.get(key);
  if (hit === undefined) {
    hit = applyTrade(master[flow], loadTrade(id));
    appliedCache.set(key, hit);
  }
  return hit;
}

describe("a trade's money paths", () => {
  it("a trade never gets a money path it does not list: cpa on list|card|counter is refused", () => {
    const trade = loadTrade("cpa");
    const a = applied("cpa", "A");
    expect(trade.flows.A.money.combos).not.toContain("list|card|counter");
    const run = () => makeTradePath(a, trade, { money: "list|card|counter" });
    expect(run).toThrow(UnlistedMoneyPathError);
    expect(run).toThrow(
      /cpa flow A: list\|card\|counter is not one of its money paths \(it lists list\|card\|card/,
    );
    // flow B lists others still
    const b = applied("cpa", "B");
    expect(() => makeTradePath(b, trade, { money: "list|card|card" })).toThrow(UnlistedMoneyPathError);
    // the vendored parsePath accepts the unlisted path: this is the step.js trap the model closes
    expect(ref.parsePath("list|card|counter", "A")).not.toHaveProperty("problems");
  });

  it("every listed money path is made, and tradePaths holds no other base money path", () => {
    for (const id of ["cpa", "aba", "barber"]) {
      const trade = loadTrade(id);
      for (const flow of ["A", "B"] as const) {
        const ap = applied(id, flow);
        const listed = trade.flows[flow].money.combos;
        for (const money of listed) {
          const made = makeTradePath(ap, trade, { money });
          expect(`${made.price}|${made.before}|${made.after}`).toBe(money);
          expect(made.flow).toBe(flow);
        }
        const paths = tradePaths(ap, trade);
        const money = paths.filter((p) => p.kind === "money").map((p) => `${p.price}|${p.before}|${p.after}`);
        expect(money).toEqual(listed);
        const bookingOnly = paths.filter((p) => p.kind !== "fixture");
        for (const p of bookingOnly) expect(listed).toContain(`${p.price}|${p.before}|${p.after}`);
        for (const p of paths) {
          expect(p.fixture !== undefined).toBe(p.kind === "fixture");
        }
      }
    }
  });

  it("46 distinct (flow, money path) pairs are in use across the 243 trades", () => {
    const trades = loadTrades();
    expect(Object.keys(trades)).toHaveLength(243);
    expect(listTradeIds()).toHaveLength(243);
    const pairs = distinctMoneyPaths(Object.values(trades));
    expect(pairs).toHaveLength(46);
    expect(pairs.filter((p) => p.startsWith("A "))).toHaveLength(23);
    expect(pairs.filter((p) => p.startsWith("B "))).toHaveLength(23);
  });

  it("refuses a booking value that is not a value of its group", () => {
    const trade = loadTrade("barber");
    const a = applied("barber", "A");
    expect(() =>
      makeTradePath(a, trade, { money: "list|card|counter", booking: { reach: "setstart" } }),
    ).toThrow(InvalidBookingError);
    expect(() => makeTradePath(a, trade, { money: "list|card|counter", booking: { nope: "x" } })).toThrow(
      InvalidBookingError,
    );
  });

  it("refuses a fixture the record does not have, and one that does not ride the money path", () => {
    const trade = loadTrade("barber");
    const a = applied("barber", "A");
    expect(() => makeTradePath(a, trade, { money: "list|card|counter", fixture: "no-such" })).toThrow(
      FixtureError,
    );
    // credit-plus needs the packs or plans fact, which barber does not list
    expect(trade.facts).not.toContain("packs");
    expect(() => makeTradePath(a, trade, { money: "list|card|counter", fixture: "credit-plus" })).toThrow(
      FixtureError,
    );
  });
});

describe("the trade's own switches and full facts (the two step.js traps)", () => {
  it("aba: A10-01 on list|none|bill with aba's own switches gives the pf:sensitive words", () => {
    const trade = loadTrade("aba");
    const ap = applied("aba", "A");
    expect(tradeSwitches(trade, "A")).toEqual({ sensitive: true, welfare: true });
    const path = makeTradePath(ap, trade, { money: "list|none|bill" });
    expect(path.switches).toEqual({ sensitive: true, welfare: true });

    const step = stepOf(ap.flow, "A10-01");
    if (step === undefined) throw new Error("A10-01 is not in flow A");
    const shown = resolveVary(ap, step, path);
    expect(shown.keys).toEqual(["pf:sensitive"]);
    expect(shown.key).toBe("pf:sensitive");
    expect(shown.tie).toBeNull();

    // the trap: a path without the trade's switches (what step.js --prof --path gives) reads the base words
    const bare = resolveVary(ap, step, { ...path, switches: {} });
    expect(bare.keys).toEqual([]);
    expect(bare.step).not.toStrictEqual(shown.step);

    // and the walk shows the same words at that step
    const walk = walkPath(ap, path, { sets: false });
    const at = walk.steps.filter((s) => s.id === "A10-01");
    expect(at).toHaveLength(1);
    expect(at[0]?.keys).toEqual(["pf:sensitive"]);
    expect(at[0]?.words).toStrictEqual(shown.step);
  });

  it("cpa: the header-only fact documents is accepted; the vendored parsePath refuses it", () => {
    const trade = loadTrade("cpa");
    const ap = applied("cpa", "A");
    expect(trade.facts).toContain("documents");
    expect(tradeFacts(trade)).toEqual(trade.facts);
    // parsePath's fact check is what step.js --path runs; it does not know the header-only facts
    expect(ref.parsePath("list|card|card facts=documents", "A")).toEqual({
      problems: ["facts=documents: no plug-in fact 'documents'"],
    });

    const path = makeTradePath(ap, trade, { money: "list|card|card" });
    expect(path.facts).toEqual(trade.facts);
    expect(path.facts).toContain("documents");
    expect(pathName(path)).toBe("list|card|card with its plug-in facts");

    // a gate on the fact reads it: lit with cpa's facts, dark without
    const gated = [...gatedByFact(ap, "documents")];
    expect(gated.length).toBeGreaterThan(0);
    for (const when of gated) {
      expect(lit(ap, when, path)).toBe(true);
      expect(lit(ap, when, { ...path, facts: [] })).toBe(false);
    }
    // and the walk runs on it
    expect(walkPath(ap, path).steps.length).toBeGreaterThan(100);
  });

  it("insurance lists no facts: its path carries null, so every fact-gated branch shows", () => {
    const trade = loadTrade("insurance");
    expect(trade.facts).toBeNull();
    const path = makeTradePath(applied("insurance", "A"), trade, { money: trade.flows.A.money.main });
    expect(path.facts).toBeNull();
  });
});

/** The `when`s of the applied flow that gate on a fact (pf or factOn). */
function* gatedByFact(ap: AppliedTrade, fact: string): Generator<{ pf: string[] }> {
  const seen = new Set<string>();
  const walk = (steps: typeof ap.flow.steps): Generator<{ pf: string[] }> =>
    (function* inner(list: typeof ap.flow.steps): Generator<{ pf: string[] }> {
      for (const step of list) {
        for (const when of [step.when, ...(step.branches ?? []).map((b) => b.when)]) {
          const facts = when?.pf;
          if (facts?.includes(fact)) {
            const key = JSON.stringify(when);
            if (!seen.has(key) && Object.keys(when ?? {}).every((k) => k === "pf")) {
              seen.add(key);
              yield { pf: facts };
            }
          }
        }
        for (const branch of step.branches ?? []) yield* inner(branch.steps);
      }
    })(steps);
  yield* walk(ap.flow.steps);
}

describe("the paths of a trade", () => {
  it("are the vendored pathsFor's, with the record's 11 fixtures (private-call put back)", () => {
    const ids = ["aba", "cpa", "barber", "dentist", "towing"];
    for (const id of ids) {
      const trade = loadTrade(id);
      for (const flow of ["A", "B"] as const) {
        const ap = applied(id, flow);
        const mine = tradePaths(ap, trade);
        const { paths: want } = refPaths(id, flow);
        const wantNames = want.map((p) => ref.pathName(p));
        // every path of the vendored walk is there, in its order
        expect(mine.filter((p) => p.fixture !== "private-call").map((p) => pathName(p))).toEqual(wantNames);
        // nothing else is there but private-call, which pathsFor leaves out (privacy private is sets-only)
        const extra = mine.filter((p) => p.fixture === "private-call");
        expect(extra.length).toBeGreaterThan(0);
        for (const p of extra) {
          expect(p.booking).toMatchObject({ reach: "callsonly", privacy: "private" });
          expect(p.kind).toBe("fixture");
        }
        // every path carries the trade's own switches and facts
        for (const p of mine) {
          expect(p.switches).toEqual(tradeSwitches(trade, flow));
          expect(p.facts).toEqual(tradeFacts(trade));
        }
      }
    }
  });

  it("all 11 fixtures ride a trade that sells plans", () => {
    const trade = loadTrade("aba");
    expect(trade.facts).toContain("plans");
    const ap = applied("aba", "A");
    const ids = new Set(tradePaths(ap, trade).flatMap((p) => (p.fixture === undefined ? [] : [p.fixture])));
    expect([...ids].sort()).toEqual(
      [
        "added-later",
        "credit-plus",
        "payer-other",
        "private-call",
        "shop-nothing",
        "stopped",
        "switched",
        "switched-call",
        "two-calls",
        "two-card",
        "two-full",
      ].sort(),
    );
  });

  it("a fixture path carries its services and the money path it rode, and reads back exactly", () => {
    const trade = loadTrade("aba");
    const ap = applied("aba", "A");
    const two = makeTradePath(ap, trade, { money: "list|card|card", fixture: "two-card" });
    expect(two.fixture).toBe("two-card");
    expect(two.services).toEqual(["a-add"]);
    expect(two.kind).toBe("fixture");
    expect(toCorePath(two)).toMatchObject({ fix: "two-card", base: "list|card|card" });
    // the same path as tradePaths made it
    const found = tradePaths(ap, trade).find(
      (p) => p.fixture === "two-card" && p.engine?.base === "list|card|card",
    );
    expect(found).toStrictEqual(two);
  });

  it("flow B paths of a set-start trade start at its own first booking value, built directly or listed", () => {
    const trade = loadTrade("aba");
    const ap = applied("aba", "B");
    const direct = makeTradePath(ap, trade, { money: "list|none|bill" });
    const listed = tradePaths(ap, trade).find((p) => p.kind === "money");
    expect(direct).toStrictEqual(listed);
    expect(direct.booking).toEqual({ times: "setstart" });
  });
});

describe("words per path equal the vendored functions' output", () => {
  const trades = ["aba", "cpa", "barber", "dentist", "towing"];

  it("lit and resolveVary agree with the vendored lit and resolveVary on a hand-built path", () => {
    const ap = applied("aba", "A");
    const trade = loadTrade("aba");
    const { applied: want } = refPaths("aba", "A");
    const path: TradePath = {
      flow: "A",
      price: "list",
      before: "card",
      after: "card",
      switches: { sensitive: true, welfare: true },
      facts: ["planbill", "forms", "plans", "children", "firststeps", "classes", "groups", "monthlybill"],
      kind: "money",
    };
    expect(path.facts).toEqual(trade.facts);
    const refPath: RefCorePath = {
      price: "list",
      before: "card",
      after: "card",
      pf: { sensitive: true, welfare: true },
      facts: path.facts,
    };
    ref.CORE.syncWays(want.flow);
    let checked = 0;
    const each = (steps: RefStep[]): void => {
      for (const refStep of steps) {
        const mine = stepOf(ap.flow, refStep.id);
        if (mine === undefined) throw new Error(`${refStep.id} missing`);
        const wantVaried = ref.CORE.resolveVary(refStep, refPath);
        const gotVaried = resolveVary(ap, mine, path);
        expect(gotVaried.step, refStep.id).toStrictEqual(wantVaried.step);
        expect(gotVaried.keys, refStep.id).toEqual(wantVaried.keys);
        for (const branch of refStep.branches ?? []) {
          const gotBranch = mine.branches?.find((b) => b.label === branch.label);
          expect(lit(ap, gotBranch?.when, path), `${refStep.id} ${branch.label}`).toBe(
            ref.CORE.lit(branch.when, refPath),
          );
        }
        checked += 1;
        for (const branch of refStep.branches ?? []) each(branch.steps);
      }
    };
    each(want.flow.steps);
    expect(checked).toBeGreaterThan(400);
  });

  it(`${String(trades.length)} trades x 3 paths x 2 flows: walkPath words equal the vendored walk`, () => {
    let walks = 0;
    for (const id of trades) {
      const trade = loadTrade(id);
      for (const flow of ["A", "B"] as const) {
        const ap = applied(id, flow);
        const mine = tradePaths(ap, trade);
        const { paths: vendored, applied: want } = refPaths(id, flow);
        const names = vendored.map((p) => ref.pathName(p));
        // three paths: the first money path, a booking value laid on it, and a fixture
        const picks = [
          mine.find((p) => p.kind === "money"),
          mine.find((p) => p.kind === "booking"),
          mine.find((p) => p.fixture === "two-full"),
        ];
        expect(
          picks.every((p) => p !== undefined),
          `${id} ${flow}`,
        ).toBe(true);
        for (const pick of picks) {
          if (pick === undefined) continue;
          const at = names.indexOf(pathName(pick));
          expect(at, `${id} ${flow} ${pathName(pick)}`).toBeGreaterThanOrEqual(0);
          const vendoredPath = vendored[at];
          if (vendoredPath === undefined) throw new Error("no vendored path");
          const wantWords = refWords(want.flow, vendoredPath);
          const walk = walkPath(ap, pick);
          const gotWords = walk.steps.map((s): [string, unknown] => [s.id, s.words]);
          expect(
            gotWords.map((x) => x[0]),
            `${id} ${flow} ${pathName(pick)} steps`,
          ).toEqual(wantWords.map((x) => x[0]));
          expect(gotWords, `${id} ${flow} ${pathName(pick)} words`).toStrictEqual(wantWords);
          walks += 1;
        }
      }
    }
    expect(walks).toBe(trades.length * 3 * 2);
  }, 120_000);

  it("a walk reads each step once with { sets: false } and every lit step is a lit step of its parent", () => {
    const trade = loadTrade("barber");
    const ap = applied("barber", "A");
    const path = makeTradePath(ap, trade, { money: "list|card|counter" });
    const plain = walkPath(ap, path, { sets: false });
    const ids = plain.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const full = walkPath(ap, path);
    expect(full.steps.length).toBeGreaterThanOrEqual(plain.steps.length);
    // every step of the plain walk is in the sets walk
    const inFull = new Set(full.steps.map((s) => s.id));
    for (const id of ids) expect(inFull.has(id)).toBe(true);
    // a split lights its branches by lit(): the lit ones are the branches whose steps follow
    for (const s of plain.steps) {
      for (const b of s.branches) {
        const gotStep = s.step.branches?.find((x) => x.label === b.label);
        expect(b.lit).toBe(gotStep?.off === undefined && lit(ap, gotStep?.when, path));
      }
    }
    // an applied step that an `off` op switched off is never in a walk
    expect(plain.steps.every((s) => s.step.off === undefined)).toBe(true);
  });

  it("applyStops settles the opt-out line: kept where a text is always the first, dropped where it never is", () => {
    const base = {
      id: "A9-01",
      line: ["1"],
      who: "san",
      via: "msg",
      title: "t",
      does: "d",
      say: [["san", "cust", "x", { stop: "first" }]],
    } as unknown as Parameters<typeof applyStops>[0];
    const stopOf = (rec: Parameters<typeof applyStops>[1]) => {
      const say = applyStops(base, rec).say?.[0];
      return say?.[3]?.stop;
    };
    expect(stopOf({ 0: { first: true, later: false, to: "cust", stop: "first" } })).toBe(true);
    expect(stopOf({ 0: { first: true, later: true, to: "cust", stop: "first" } })).toBe("first");
    expect(stopOf({ 0: { first: false, later: true, to: "cust", stop: "first" } })).toBeUndefined();
    expect(applyStops(base, undefined)).toStrictEqual(base);
  });

  it("firstTexts of the model equals the vendored firstTexts on the same path", () => {
    const trade = loadTrade("barber");
    const ap = applied("barber", "A");
    const path = makeTradePath(ap, trade, { money: "list|card|counter" });
    const { paths, applied: want } = refPaths("barber", "A");
    const refPath = paths.find((p) => ref.pathName(p) === pathName(path));
    if (refPath === undefined) throw new Error("no vendored path");
    ref.CORE.syncWays(want.flow);
    const wantTexts = ref.CORE.firstTexts(want.flow.steps, refPath, {
      names: want.flow.names,
    });
    expect(Object.keys(wantTexts).length).toBeGreaterThan(0);
    expect(firstTexts(ap, path)).toStrictEqual(wantTexts);
  });

  it("two trades applied in turn do not read each other's record: the tables are re-read on every call", () => {
    const trade = loadTrade("aba");
    const a = applied("aba", "A");
    const path = makeTradePath(a, trade, { money: "list|none|bill" });
    const before = walkPath(a, path, { sets: false }).steps.map((s) => s.words);
    applyTrade(master.A, loadTrade("cpa"));
    applyTrade(master.A, loadTrade("barber"));
    const after = walkPath(a, path, { sets: false }).steps.map((s) => s.words);
    expect(after).toStrictEqual(before);
  });
});
