// T-157: a lookup lacks the field it reads (K-01 lint rule lookup-without-field; Q-39's default), tested alone:
// runLint([lookupField], ...). The compiled steps are K-01's own fixtures (refuse-lookup-without-field.json,
// bundle-mini-a.json) or T-145's compiler run on the master and on trade files; the flows and paths are the master's and
// the trades' own (rule 9). A case that names another field on one of the master's lookup branches changes only that
// branch's `reads`, and its expected paths are worked out with the path model's own walk (T-136), not written out by
// hand. The rule's walk is also checked against lib.js walkCombo, the master's own order check, on the vendored copy.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compileMasterBranches,
  compileTradeBranches,
  type BranchReads,
  type CompiledBranch,
} from "../branches";
import type { FlowLetter, StepId } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { loadTrade, type LoadedTrade } from "../load/trade";
import { applyTrade, type AppliedStep, type AppliedTrade } from "../overlay/apply";
import { makeCjsLoader } from "../overlay/cjs-load";
import { pathName, stepOf, syncFlow, toCorePath, tradePaths } from "../path";
import { loadPathScripts, type CorePath } from "../path/core";
import {
  LOOKUP_RULE,
  lookupField,
  lookupFieldRule,
  lookupHits,
  lookupWalk,
  walkGiven,
  type CompiledBranches,
  type LookupReach,
  type LookupWalk,
} from "./lookup-field";
import { lintContext, LintError, masterInput, runLint, tradeInput, type LintResult } from "./runner";

const FIXTURES = fileURLToPath(new URL("../../../contracts/bundle/fixtures/", import.meta.url));
const WORK = fileURLToPath(new URL("../../../fixtures/master/engine/work/", import.meta.url));

type Obj = Record<string, unknown>;

/**
 * lib.js, the reference, loaded on its own with its own overlay-core.js: its walkCombo is the order check check-prof.js
 * runs on every trade path. Its tables are made to read the applied flow first (syncWays), as check-prof's apply() leaves
 * them.
 */
interface Reference {
  walkCombo(
    steps: unknown,
    given: string[],
    path: CorePath,
    flow: FlowLetter,
    errs: string[],
    where: string,
  ): { terminal: boolean };
  CORE: { syncWays(flow: unknown): void };
}
const ref = makeCjsLoader()(`${WORK}build/lib.js`) as Reference;

const master = loadMaster();
const trades = new Map<string, LoadedTrade>();
const applieds = new Map<string, AppliedTrade>();

function trade(id: string): LoadedTrade {
  const known = trades.get(id);
  if (known !== undefined) return known;
  const loaded = loadTrade(id);
  trades.set(id, loaded);
  return loaded;
}

/** A trade applied to one master flow (applyTrade), made once. */
function applied(id: string, flow: FlowLetter): AppliedTrade {
  const key = `${id} ${flow}`;
  const known = applieds.get(key);
  if (known !== undefined) return known;
  const made = applyTrade(master[flow], trade(id));
  applieds.set(key, made);
  return made;
}

function fixture(file: string): Obj {
  return JSON.parse(readFileSync(`${FIXTURES}${file}`, "utf8")) as Obj;
}

/** Every compiled split in a K-01 document that has a lookup branch, by id (a fixture's steps, wherever they sit). */
function lookupSplits(document: unknown): Map<StepId, CompiledBranch[]> {
  const out = new Map<StepId, CompiledBranch[]>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const node = value as Obj;
    const branches = node.branches;
    if (
      node.type === "split" &&
      typeof node.id === "string" &&
      Array.isArray(branches) &&
      branches.some((branch) => (branch as Obj).tag === "lookup")
    )
      out.set(node.id, branches as CompiledBranch[]);
    for (const item of Object.values(node)) visit(item);
  };
  visit(document);
  return out;
}

/** One lookup branch made to read another field (null: none): the split, the branch's label, what it reads. */
type Change = readonly [split: StepId, label: string, reads: BranchReads | null];

/** Compiled branches (T-145's) with some branches reading another field; every other branch as compiled. */
function rereads(base: CompiledBranches, changes: readonly Change[]): CompiledBranches {
  const out: Record<StepId, readonly CompiledBranch[]> = { ...base };
  for (const [split, label, reads] of changes) {
    const list = out[split];
    if (list === undefined) throw new Error(`no split ${split}`);
    if (!list.some((branch) => branch.label === label)) throw new Error(`${split} has no branch '${label}'`);
    out[split] = list.map((branch) => {
      if (branch.label !== label) return branch;
      const copy: CompiledBranch = { ...branch };
      if (reads === null) delete copy.reads;
      else copy.reads = reads;
      return copy;
    });
  }
  return out;
}

function lint(made: AppliedTrade, branches?: CompiledBranches): LintResult {
  const rule = branches === undefined ? lookupField : lookupFieldRule(() => branches);
  return runLint([rule], tradeInput(made, trade(made.trade)));
}

function walk(made: AppliedTrade, branches?: CompiledBranches): LookupWalk {
  return lookupWalk(lintContext(tradeInput(made, trade(made.trade))), branches);
}

/** The rule's walk of a trade's flow with its own compiled branches, made once. */
const walks = new WeakMap<AppliedTrade, LookupWalk>();
function ownWalk(made: AppliedTrade): LookupWalk {
  const known = walks.get(made);
  if (known !== undefined) return known;
  const made1 = walk(made);
  walks.set(made, made1);
  return made1;
}

function lookupOf(lookups: readonly LookupReach[], split: StepId, label: string): LookupReach {
  const found = lookups.find((lookup) => lookup.step === split && lookup.label === label);
  if (found === undefined) throw new Error(`no lookup ${split} '${label}'`);
  return found;
}

/** For each of a trade's paths, the branches the path model's walk lights, as `split [label]` (made once per applied flow). */
const lighting = new WeakMap<AppliedTrade, { name: string; lit: Set<string> }[]>();

/**
 * The names of the trade's paths (tradePaths) on which the path model's own walk lights `split` and its branch `label`:
 * overlay-core.js walkSets, the walk walkPath reads a path with (a branch's `sets` followed; off steps and branches left
 * out). It is not the rule's walk, so it checks it.
 */
function litOn(made: AppliedTrade, split: StepId, label: string): string[] {
  let known = lighting.get(made);
  if (known === undefined) {
    const { core } = loadPathScripts();
    known = tradePaths(made, trade(made.trade)).map((path) => {
      syncFlow(made.flow);
      const lit = new Set<string>();
      core.walkSets(
        made.flow.steps,
        toCorePath(path),
        (step, _reading, _trail, branch) => {
          if (branch !== undefined)
            lit.add(`${(step as { id: string }).id} [${(branch as { label: string }).label}]`);
        },
        { off: true },
      );
      return { name: pathName(path), lit };
    });
    lighting.set(made, known);
  }
  return known.filter((path) => path.lit.has(`${split} [${label}]`)).map((path) => path.name);
}

/** The steps a trade runs, as check-prof.js live() hands them to lib.js walkCombo: off steps and off branches left out. */
function liveSteps(steps: readonly AppliedStep[]): AppliedStep[] {
  return steps
    .filter((step) => step.off === undefined)
    .map((step) =>
      step.branches === undefined
        ? step
        : {
            ...step,
            branches: step.branches
              .filter((branch) => branch.off === undefined)
              .map((branch) => ({ ...branch, steps: liveSteps(branch.steps) })),
          },
    );
}

function shape(hit: {
  rule: string;
  level: string;
  step: string;
  field: string;
  text: string;
  fix: string;
}): Obj {
  return { rule: hit.rule, level: hit.level, step: hit.step, field: hit.field, text: hit.text, fix: hit.fix };
}

const NO_FIELD_FIX =
  "name the field code reads to settle it (reads: a needs key an earlier step gives, a record value or a path value)";

describe("lookup-without-field: a lookup branch that names no field", () => {
  it("fails: refuse-lookup-without-field.json, A5-04 whose 'A card saved' names no field, on the barber trade and the master", () => {
    const refused = fixture("invalid/refuse-lookup-without-field.json");
    expect(refused.id).toBe("A5-04");
    expect(refused.lint).toEqual([]);
    const branches = refused.branches as CompiledBranch[];
    expect(
      branches.filter((branch) => branch.tag === "lookup" && branch.reads === undefined).map((b) => b.label),
    ).toEqual(["A card saved"]);

    const hit = {
      rule: LOOKUP_RULE,
      level: "error",
      step: "A5-04",
      field: "branch 'A card saved'",
      text: "A card saved",
      fix: NO_FIELD_FIX,
    };
    const barber = applied("barber", "A");
    const result = lint(barber, { ...compileTradeBranches(barber), "A5-04": branches });
    expect(result.hits.map(shape)).toEqual([hit]);
    expect(result.hits[0]?.trade).toBe("barber");
    expect(result.errors).toEqual([
      `A:A5-04 lookup-without-field lookup without field: branch 'A card saved': ${NO_FIELD_FIX}`,
    ]);
    expect(result.rules).toEqual([{ rule: LOOKUP_RULE, errors: 1, warnings: 0, allowed: 0 }]);

    // the master's flow A, linted as one whole flow (no trade paths): the same one hit
    const onMaster = runLint(
      [lookupFieldRule(() => ({ ...compileMasterBranches(master).A, "A5-04": branches }))],
      masterInput(master.A),
    );
    expect(onMaster.hits.map(shape)).toEqual([hit]);
    expect(onMaster.hits[0]?.trade).toBeNull();
  });

  it("fails one branch alone: each of A5-04's four lookups with its field taken away (the master's flow A)", () => {
    const compiled = compileMasterBranches(master).A;
    for (const label of ["Nothing taken", "A card saved", "A deposit", "The full price"]) {
      const branches = rereads(compiled, [["A5-04", label, null]]);
      const result = runLint([lookupFieldRule(() => branches)], masterInput(master.A));
      expect(result.hits.map((hit) => [hit.step, hit.field, hit.level])).toEqual([
        ["A5-04", `branch '${label}'`, "error"],
      ]);
    }
  });
});

describe("lookup-without-field: bundle-mini-a.json's lookup branches pass", () => {
  it("passes: A5-04's four branches, each reading the before choice from the path, on every path of the barber trade", () => {
    const splits = lookupSplits(fixture("bundle-mini-a.json"));
    expect([...splits.keys()]).toEqual(["A5-04"]);
    const branches = splits.get("A5-04") ?? [];
    expect(branches.map((branch) => [branch.label, branch.tag, branch.reads])).toEqual([
      ["Nothing taken", "lookup", { from: "path", key: "before" }],
      ["A card saved", "lookup", { from: "path", key: "before" }],
      ["A deposit", "lookup", { from: "path", key: "before" }],
      ["The full price", "lookup", { from: "path", key: "before" }],
    ]);

    const barber = applied("barber", "A");
    const given = { ...compileTradeBranches(barber), ...Object.fromEntries(splits) };
    const result = lint(barber, given);
    expect(result.hits).toEqual([]);
    expect(result.rules).toEqual([{ rule: LOOKUP_RULE, errors: 0, warnings: 0, allowed: 0 }]);

    // each branch is reached exactly on the paths whose walk lights it (the path model's walk), and has its field on each
    const { lookups } = walk(barber, given);
    for (const branch of branches) {
      const lookup = lookupOf(lookups, "A5-04", branch.label);
      expect(lookup.reached).toEqual(litOn(barber, "A5-04", branch.label));
      expect(lookup.unsourced).toEqual([]);
    }
    // the barber lists no full-price path, so 'The full price' is reached by none; the other three by some
    expect(lookupOf(lookups, "A5-04", "The full price").reached).toEqual([]);
    for (const label of ["Nothing taken", "A card saved", "A deposit"])
      expect(lookupOf(lookups, "A5-04", label).reached.length).toBeGreaterThan(0);
  });
});

describe("lookup-without-field: the walk covers each trade's paths", () => {
  it("walks every path the trade has: each listed money path, each booking value, each record fixture, with its own facts", () => {
    const barber = applied("barber", "A");
    const paths = tradePaths(barber, trade("barber"));
    const { paths: walked, lookups } = ownWalk(barber);
    expect(walked).toEqual(paths.map((path) => pathName(path)));
    expect(new Set(paths.map((path) => path.kind))).toEqual(new Set(["money", "booking", "fixture"]));
    expect(
      paths
        .filter((path) => path.kind === "money")
        .map((path) => `${path.price}|${path.before}|${path.after}`),
    ).toEqual(trade("barber").flows.A.money.combos);
    expect(paths.every((path) => JSON.stringify(path.facts) === JSON.stringify(trade("barber").facts))).toBe(
      true,
    );
    expect(paths.some((path) => path.fixture === "two-card")).toBe(true);

    // every lookup T-145 compiles on these main-path splits is reached on exactly the paths whose walk lights it
    for (const split of ["A4-05", "A5-04", "A9-15", "A9-01"]) {
      const own = lookups.filter((lookup) => lookup.step === split);
      expect(own.length).toBeGreaterThan(0);
      for (const lookup of own) expect(lookup.reached).toEqual(litOn(barber, split, lookup.label));
    }
  });

  it("reads each trade's fact settings: A9-15's 'Paid in stages' (fact stages) is reached for the planner, not for the barber", () => {
    const stages = (made: AppliedTrade): LookupReach =>
      lookupOf(ownWalk(made).lookups, "A9-15", "Paid in stages");
    expect(trade("planner").facts).toContain("stages");
    const planner = applied("planner", "A");
    expect(stages(planner).reached.length).toBeGreaterThan(0);
    expect(stages(planner).reached).toEqual(litOn(planner, "A9-15", "Paid in stages"));
    expect(stages(planner).unsourced).toEqual([]);

    expect(trade("barber").facts).not.toContain("stages");
    expect(stages(applied("barber", "A")).reached).toEqual([]);

    // a trade that lists no facts sees every fact-gated branch (insurance.json): its paths are read the same way
    expect(trade("insurance").facts).toBeNull();
    const insurance = applied("insurance", "A");
    expect(stages(insurance).reached).toEqual(litOn(insurance, "A9-15", "Paid in stages"));
  });

  it("is lib.js walkCombo's walk: the keys given before each step match the master's order check, path by path", () => {
    for (const [id, flow] of [
      ["barber", "A"],
      ["barber", "B"],
    ] as const) {
      // A9-01 (B9-01) made to need what only a deposit path gives, so the reference has something to find
      const made = structuredClone(applied(id, flow));
      const split = flow === "A" ? "A9-01" : "B9-01";
      const step = stepOf(made.flow, split);
      if (step === undefined) throw new Error(`no ${split}`);
      step.needs = [...(step.needs ?? []), "deposit_paid", "money_before"];
      let found = 0;
      for (const path of tradePaths(made, trade(id))) {
        const mine: string[] = [];
        const result = walkGiven(made, path, (lit, way) => {
          for (const key of lit.needs ?? []) if (!way.given.has(key)) mine.push(`${lit.id} needs '${key}'`);
        });
        const errs: string[] = [];
        ref.CORE.syncWays(made.flow);
        const reference = ref.walkCombo(
          liveSteps(made.flow.steps),
          [],
          toCorePath(path),
          flow,
          errs,
          `${flow}:`,
        );
        const theirs = errs
          .filter((err) => / needs '[^']+', which /.test(err))
          .map((err) => err.slice(`${flow}:`.length).replace(/, which .*$/, ""));
        expect(mine.sort(), `${id} ${flow} ${pathName(path)}`).toEqual(theirs.sort());
        expect(result.reachesEnd).toBe(!reference.terminal);
        found += mine.length;
      }
      expect(found, `${id} ${flow}`).toBeGreaterThan(0);
    }
  });
});

describe("lookup-without-field: a field given on none of the paths that reach the lookup", () => {
  it("needs: A9-01's 'Paid at the chair' reading visit_fee, which only the price-at-the-visit path gives: fails for the barber", () => {
    const barber = applied("barber", "A");
    const branches = rereads(compileTradeBranches(barber), [
      ["A9-01", "Paid at the chair", { from: "needs", key: "visit_fee" }],
    ]);
    const result = lint(barber, branches);
    const reached = litOn(barber, "A9-01", "Paid at the chair");
    expect(reached.length).toBeGreaterThan(3);
    expect(result.hits.map(shape)).toEqual([
      {
        rule: LOOKUP_RULE,
        level: "error",
        step: "A9-01",
        field: "branch 'Paid at the chair' reads needs visit_fee",
        text: "needs visit_fee",
        fix: `given on none of the ${String(reached.length)} paths that reach it (${reached.slice(0, 3).join("; ")}; and ${String(reached.length - 3)} more): give visit_fee on a step before A9-01 on those paths, or read a field the booking has there`,
      },
    ]);
    expect(result.errors).toHaveLength(1);
  });

  it("needs, record and path: A5-04 reading card_saved (A5-07 and A5-13 give it, after the split) or price_known as a path field fails", () => {
    const barber = applied("barber", "A");
    const branches = rereads(compileTradeBranches(barber), [
      ["A5-04", "Nothing taken", { from: "path", key: "price_known" }],
      ["A5-04", "A card saved", { from: "needs", key: "card_saved" }],
      ["A5-04", "A deposit", { from: "record", key: "card_saved" }],
    ]);
    const result = lint(barber, branches);
    expect(result.hits.map((hit) => [hit.step, hit.level, hit.field])).toEqual([
      ["A5-04", "error", "branch 'Nothing taken' reads path price_known"],
      ["A5-04", "error", "branch 'A card saved' reads needs card_saved"],
      ["A5-04", "error", "branch 'A deposit' reads record card_saved"],
    ]);
    expect(result.hits[0]?.fix).toMatch(
      /: read a field of the path model \(price, before, after, a booking group, a switch or a fact\): 'price_known' is none of them$/,
    );
    expect(result.hits[1]?.fix).toMatch(
      /: give card_saved on a step before A5-04 on those paths, or read a field the booking has there$/,
    );
  });
});

describe("lookup-without-field: a field given on some of the paths that reach the lookup", () => {
  it("warns: A9-01's 'Paid at the chair' reading deposit_paid, given only where A5-04 took a deposit", () => {
    const barber = applied("barber", "A");
    const deposit = new Set(litOn(barber, "A5-04", "A deposit"));
    for (const from of ["needs", "record"] as const) {
      const branches = rereads(compileTradeBranches(barber), [
        ["A9-01", "Paid at the chair", { from, key: "deposit_paid" }],
      ]);
      const { lookups } = walk(barber, branches);
      const lookup = lookupOf(lookups, "A9-01", "Paid at the chair");
      // the paths without it are those on which A5-04 did not take a deposit (the path model's lighting)
      expect(lookup.reached).toEqual(litOn(barber, "A9-01", "Paid at the chair"));
      expect(lookup.unsourced).toEqual(lookup.reached.filter((name) => !deposit.has(name)));
      expect(lookup.unsourced.length).toBeGreaterThan(3);
      expect(lookup.unsourced.length).toBeLessThan(lookup.reached.length);
      const warning = {
        rule: LOOKUP_RULE,
        level: "warning",
        step: "A9-01",
        field: `branch 'Paid at the chair' reads ${from} deposit_paid`,
        text: `${from} deposit_paid`,
        fix: `not given on ${String(lookup.unsourced.length)} of the ${String(lookup.reached.length)} paths that reach it (${lookup.unsourced.slice(0, 3).join("; ")}; and ${String(lookup.unsourced.length - 3)} more): give deposit_paid on a step before A9-01 on every path that reaches it, or read a field the booking has there`,
      };
      expect(lookups.flatMap(lookupHits).map(shape)).toEqual([warning]);
      if (from === "needs") {
        const result = lint(barber, branches);
        expect(result.hits.map(shape)).toEqual([warning]);
        expect(result.errors).toEqual([]);
        expect(result.warnings).toHaveLength(1);
        expect(result.rules).toEqual([{ rule: LOOKUP_RULE, errors: 0, warnings: 1, allowed: 0 }]);
      }
    }
  });
});

describe("lookup-without-field: a field given on every path that reaches the lookup", () => {
  it("passes: needs money_before (every branch of A5-04 gives it), record writes, facts and slots, path fields", () => {
    const barber = applied("barber", "A");
    const batches: Change[][] = [
      [
        ["A9-01", "Paid at the chair", { from: "needs", key: "money_before" }],
        ["A5-04", "Nothing taken", { from: "record", key: "credit" }],
        ["A5-04", "A card saved", { from: "path", key: "timing" }],
        ["A5-04", "A deposit", { from: "path", key: "rents" }],
        ["A4-05", "From the price list", { from: "record", key: "pay.took" }],
      ],
      [
        ["A9-01", "Paid at the chair", { from: "record", key: "money_before" }],
        ["A5-04", "Nothing taken", { from: "path", key: "standin" }],
        ["A5-04", "A card saved", { from: "path", key: "stages" }],
      ],
    ];
    for (const batch of batches) {
      const branches = rereads(compileTradeBranches(barber), batch);
      expect(lint(barber, branches).hits, JSON.stringify(batch)).toEqual([]);
      const { lookups } = walk(barber, branches);
      for (const [split, label, reads] of batch) {
        const lookup = lookupOf(lookups, split, label);
        expect(lookup.reads).toEqual(reads);
        expect(lookup.reached.length, `${split} ${label}`).toBeGreaterThan(0);
        expect(lookup.unsourced).toEqual([]);
      }
    }
  });

  it("passes: every lookup T-145 compiles, on the master's flows and on trades' flows (each reads a money choice from the path)", () => {
    for (const flow of ["A", "B"] as const) {
      expect(runLint([lookupField], masterInput(master[flow])).hits).toEqual([]);
      expect(lookupWalk(lintContext(masterInput(master[flow]))).paths).toEqual([]);
    }
    for (const [id, flow] of [
      ["barber", "A"],
      ["barber", "B"],
      ["planner", "A"],
      ["aba", "A"],
      ["insurance", "B"],
    ] as const) {
      const made = applied(id, flow);
      expect(lint(made).hits, `${id} ${flow}`).toEqual([]);
      const own = Object.values(compileTradeBranches(made))
        .flat()
        .filter((branch) => branch.tag === "lookup");
      expect(own.length).toBeGreaterThan(0);
      expect(own.every((branch) => branch.reads?.from === "path")).toBe(true);
    }
  });
});

describe("lookup-without-field: compiled branches must be the split's own", () => {
  it("throws LintError when a split's compiled branches are not its live branches, label for label", () => {
    const barber = applied("barber", "A");
    const swapped = [...(compileTradeBranches(barber)["A5-04"] ?? [])].reverse();
    const branches = { ...compileTradeBranches(barber), "A5-04": swapped };
    expect(() => walk(barber, branches)).toThrow(LintError);
    expect(() => walk(barber, branches)).toThrow(
      /A5-04: the compiled branches \(The full price \/ A deposit \/ A card saved \/ Nothing taken\) are not the split's live branches/,
    );
  });
});
