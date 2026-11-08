// A lookup lacks the field it reads (T-157; C-068; K-01 v1 lint rule `lookup-without-field`; arch 12 line 592; arch 03
// line 161; QUESTIONS Q-39's default; SPEC-master 4 'needs', 5, 5d, 5e).
//
// The compiler tags each branch a message, a lookup or a clock (T-145, compiler/src/branches): code settles a lookup by
// reading one field, the branch's `reads` (K-01 branch.reads: a needs key an earlier step gives, a record value, or a
// value of the path model). The rule finds the lookups code could not settle:
//
//   - a lookup branch that names no field (no `reads`): an error wherever it is, in the master's flows too. It is what
//     K-01's schema sees on a compiled step (contracts/bundle/fixtures/invalid/refuse-lookup-without-field.json: A5-04's
//     'A card saved');
//   - for a trade, a lookup whose field is given on none of the paths that reach it (the card; Q-39's default): an
//     error. The rule walks each of the trade's paths (ctx.paths(): each money path it lists, each booking value it
//     uses, the record's fixtures riding them, every one with the trade's own switches and facts), and a path reaches
//     the branch when the walk comes to its split and the branch's `when` fits;
//   - a lookup whose field is given on some of the paths that reach it but not on all of them: a warning. Q-39 words
//     its default "has no source on some path", K-01's `reads` repeats it and SPEC-master 4 lets a step need only what
//     an earlier step gave on every path to it; the card fails only the lookup given on none (see the open question in
//     the T-157 report).
//   A lookup no path of the trade reaches is not judged for the trade. The master's own flows have no trade paths (the
//   runner lints them as one whole flow), so there only the first case is read.
//
// Where a field is given (its source), by `reads.from`, on one way the walk comes to the split:
//   needs   a step lit earlier on the walk gives the key (`gives`): the split's own `gives` do not count (a step needs
//           what an earlier step gave, SPEC-master 4), and after an earlier split only what every lit branch that
//           rejoins gave (lib.js walkCombo);
//   record  a record write, that is a key an earlier step gives (T-145 writes each `gives` key as a recordWrite effect),
//           or a value the compiled record holds on every path: a record fact a record gate reads (overlay-core.js REC,
//           "a record gate when the booking holds the value", arch 03 line 161) or one of its 16 named slots (each ends
//           in a row with no `when`, so a row fits every path: record/compile.ts);
//   path    a field of the path model, which every path carries: price, before or after, a booking group
//           (overlay-core.js BOOKING, with the record's EVENT_GROUPS), a switch or a fact (overlay-core.js SWITCHES and
//           FACTS, with the flow's own).
// A path whose walk comes to the split more than one way (a branch's `sets` read both ways) gives the field only when
// every one of those ways does, as lib.js joins the keys given at a rejoin.
//
// The walk is the master's own order check, lib.js walkCombo (walkComboSets, lines 809-845; check-prof.js walks every
// trade path with it on the trade's live steps): the live steps (an `off` op's step or branch left out), a step whose
// `when` does not fit skipped with what it gives, a split's lit branches walked each with the keys given so far, a branch
// with `sets` read with that value (overlay-core.js withSets) on its own steps and after it rejoins, and at a rejoin the
// ways that read alike (pathSig) joined, keeping the keys every one of them gave. A walk whose lit branches all end stops
// there. Lighting is the vendored overlay-core.js lit(), the same the path model and the bundle's gates read. The rule
// walks the main path only up to the last step that holds a lookup's split: nothing after it changes which paths reach a
// lookup or what is given before one.
import {
  compileBranches,
  compileTradeBranches,
  type BranchReads,
  type BranchStepSource,
  type CompiledBranch,
} from "../branches";
import type { FlowLetter, Sets, StepId } from "../graph/types.ts";
import type { AppliedBranch, AppliedStep, AppliedTrade } from "../overlay/apply";
import { pathName, syncFlow, toCorePath, type TradePath } from "../path";
import { loadPathScripts, type CorePath } from "../path/core";
import { isRecord, LintError, type LintContext, type LintHit, type LintRule } from "./runner";

/** The rule's id: K-01 lintRule `lookup-without-field` (arch 12 line 592: "when a lookup lacks the field it reads"). */
export const LOOKUP_RULE = "lookup-without-field";

/** The compiled branches the rule reads, by split id, each split's branches in order (T-145 compileBranches). */
export type CompiledBranches = Readonly<Record<StepId, readonly CompiledBranch[]>>;

/** One lookup branch of the flow, with the trade's paths that reach it. */
export interface LookupReach {
  /** The split's id. */
  readonly step: StepId;
  /** The branch's label, word for word. */
  readonly label: string;
  /** The branch's place among the split's live branches, from 0. */
  readonly index: number;
  /** The field it reads, or null when it names none. */
  readonly reads: BranchReads | null;
  /** The names of the trade's paths that reach the branch (lib.js pathName), in the order of ctx.paths(). */
  readonly reached: readonly string[];
  /** Of those, the paths on which the field has no source on a way the walk comes to the split (all of them with no reads). */
  readonly unsourced: readonly string[];
}

/** What the rule read: the trade's paths it walked and every lookup branch of the flow. */
export interface LookupWalk {
  /** The trade's paths walked, by name, in the order of ctx.paths(); none for the master. */
  readonly paths: readonly string[];
  /** Every lookup branch, its split in the order of the compiled branches (page order), then branch order. */
  readonly lookups: readonly LookupReach[];
}

/** One way the walk comes to a step: the keys given so far and the path as the step reads it. */
export interface GivenWay {
  readonly given: ReadonlySet<string>;
  readonly path: CorePath;
}

/** The vendored tables and functions the walk and the sources read (overlay-core.js). */
interface LookupCore {
  lit(when: unknown, path: CorePath | null): boolean;
  pathSig(path: CorePath): string;
  withSets(path: CorePath, sets: Sets, from?: string): CorePath;
  setsKey(step: unknown, branch: unknown): string;
  MONEY: readonly string[];
  BOOKING: Readonly<Record<string, unknown>>;
  EVENT_GROUPS: unknown;
  SWITCHES: Readonly<Record<string, unknown>>;
  FACTS: Readonly<Record<string, unknown>>;
  REC: readonly string[];
}

const CORE_FUNCTIONS = ["lit", "pathSig", "withSets", "setsKey"] as const;
const CORE_TABLES = ["MONEY", "BOOKING", "EVENT_GROUPS", "SWITCHES", "FACTS", "REC"] as const;

function core(): LookupCore {
  const loaded = loadPathScripts().core as unknown as Record<string, unknown>;
  for (const name of CORE_FUNCTIONS)
    if (typeof loaded[name] !== "function") throw new Error(`overlay-core.js does not export ${name}()`);
  for (const name of CORE_TABLES)
    if (typeof loaded[name] !== "object" || loaded[name] === null)
      throw new Error(`overlay-core.js does not export ${name}`);
  return loaded as unknown as LookupCore;
}

/** A split's branches as the trade runs them: the ones no `off` op switched off (check-prof.js live()). */
function liveBranches(step: AppliedStep): AppliedBranch[] {
  return (step.branches ?? []).filter((branch) => branch.off === undefined);
}

/** At a rejoin, the ways that read alike are one, with the keys given on every one of them (lib.js walkComboSets). */
function joinWays(ways: readonly GivenWay[], tables: LookupCore): GivenWay[] {
  const bySig = new Map<string, { given: ReadonlySet<string>; path: CorePath }>();
  for (const way of ways) {
    const sig = tables.pathSig(way.path);
    const known = bySig.get(sig);
    if (known === undefined) bySig.set(sig, { given: way.given, path: way.path });
    else known.given = new Set([...known.given].filter((key) => way.given.has(key)));
  }
  return [...bySig.values()];
}

function walkList(
  list: readonly AppliedStep[],
  start: readonly GivenWay[],
  flow: FlowLetter,
  tables: LookupCore,
  visit: (step: AppliedStep, way: GivenWay) => void,
): { ways: GivenWay[]; terminal: boolean } {
  let ways = [...start];
  for (const step of list) {
    if (step.off !== undefined) continue;
    const only = "only" in step ? step.only : undefined;
    if (typeof only === "string" && only !== "" && only !== flow) continue;
    const next: GivenWay[] = [];
    for (const way of ways) {
      if (step.when !== undefined && !tables.lit(step.when, way.path)) {
        next.push(way);
        continue;
      }
      visit(step, way);
      let given = way.given;
      const gives = step.gives ?? [];
      if (gives.length > 0) {
        const more = new Set(given);
        for (const key of gives) more.add(key);
        given = more;
      }
      if (step.type !== "split") {
        next.push({ given, path: way.path });
        continue;
      }
      const lit = liveBranches(step).filter((branch) => tables.lit(branch.when, way.path));
      const merged: GivenWay[] = [];
      for (const branch of lit) {
        const into =
          branch.sets === undefined
            ? way.path
            : tables.withSets(way.path, branch.sets, tables.setsKey(step, branch));
        const walked = walkList(branch.steps, [{ given, path: into }], flow, tables, visit);
        if ((branch.end ?? "merge") !== "end" && !walked.terminal) merged.push(...walked.ways);
      }
      next.push(...joinWays(merged, tables));
    }
    ways = joinWays(next, tables);
    if (ways.length === 0) return { ways: [], terminal: true };
  }
  return { ways, terminal: false };
}

function walkFlow(
  applied: AppliedTrade,
  path: TradePath,
  list: readonly AppliedStep[],
  visit: (step: AppliedStep, way: GivenWay) => void,
): boolean {
  if (path.flow !== applied.flow.id)
    throw new LintError(`a flow ${path.flow} path was given to ${applied.trade}'s flow ${applied.flow.id}`);
  syncFlow(applied.flow);
  const walked = walkList(
    list,
    [{ given: new Set(), path: toCorePath(path) }],
    applied.flow.id,
    core(),
    visit,
  );
  return !walked.terminal;
}

/**
 * Walks one path of a trade over its applied flow as lib.js walkCombo does (see the top of this file), calling
 * `visit(step, way)` for each step the walk lights, once for each way it comes there, with the keys given before the
 * step (its own `gives` not yet among them). Returns whether the walk reaches the end of the flow.
 */
export function walkGiven(
  applied: AppliedTrade,
  path: TradePath,
  visit: (step: AppliedStep, way: GivenWay) => void,
): { reachesEnd: boolean } {
  return { reachesEnd: walkFlow(applied, path, applied.flow.steps, visit) };
}

/** Does the step, or a step under its branches at any depth, have one of these ids? */
function holds(step: AppliedStep, ids: ReadonlySet<StepId>): boolean {
  if (ids.has(step.id)) return true;
  return (step.branches ?? []).some((branch) => branch.steps.some((inner) => holds(inner, ids)));
}

/**
 * The flow's main path up to the last step that holds one of these splits: what the walk lights and gives there depends
 * only on the steps before it, so the steps after it are not walked.
 */
function upTo(steps: readonly AppliedStep[], ids: ReadonlySet<StepId>): readonly AppliedStep[] {
  let last = -1;
  steps.forEach((step, k) => {
    if (holds(step, ids)) last = k;
  });
  return steps.slice(0, last + 1);
}

/** The fields every path of a trade's flow has: the path model's, and the record's own values. */
interface Sources {
  readonly path: ReadonlySet<string>;
  readonly record: ReadonlySet<string>;
}

function sourcesOf(ctx: LintContext, applied: AppliedTrade): Sources {
  const tables = core();
  const groups = isRecord(tables.EVENT_GROUPS) ? Object.keys(tables.EVENT_GROUPS) : [];
  return {
    path: new Set([
      ...tables.MONEY,
      ...Object.keys(tables.BOOKING),
      ...groups,
      ...Object.keys(tables.SWITCHES),
      ...Object.keys(applied.flow.switches),
      ...Object.keys(tables.FACTS),
      ...Object.keys(applied.flow.facts),
    ]),
    record: new Set([...tables.REC, ...Object.keys(ctx.record.slots)]),
  };
}

/** Is the field of a lookup given on one way the walk comes to its split? */
function sourced(reads: BranchReads | null, given: ReadonlySet<string>, sources: Sources): boolean {
  if (reads === null) return false;
  switch (reads.from) {
    case "needs":
      return given.has(reads.key);
    case "record":
      return given.has(reads.key) || sources.record.has(reads.key);
    case "path":
      return sources.path.has(reads.key);
    default:
      return false;
  }
}

/**
 * The compiled branches of the flow linted: a trade's from its applied flow, the master's from the flow's main path
 * (T-145's compileTradeBranches and compileBranches, as the compiler builds the bundle).
 */
export function compiledBranchesOf(ctx: LintContext): CompiledBranches {
  if (ctx.overlay !== null) return compileTradeBranches(ctx.overlay.applied);
  // masterInput() hands the rules FlowGraph.path, the very list compileMasterBranches() compiles.
  return compileBranches(ctx.steps as unknown as readonly BranchStepSource[]);
}

interface Reach {
  readonly step: StepId;
  readonly label: string;
  readonly index: number;
  readonly reads: BranchReads | null;
  readonly reached: string[];
  readonly unsourced: string[];
}

/**
 * Every lookup branch of the flow with the trade's paths that reach it and those on which its field has no source
 * (see the top of this file). `branches` are the flow's compiled branches (compiledBranchesOf by default); a split's
 * compiled branches must be its live branches, label for label.
 */
export function lookupWalk(
  ctx: LintContext,
  branches: CompiledBranches = compiledBranchesOf(ctx),
): LookupWalk {
  const lookups: Reach[] = [];
  const byBranch = new Map<StepId, Map<number, Reach>>();
  for (const [step, list] of Object.entries(branches)) {
    list.forEach((branch, index) => {
      if (branch.tag !== "lookup") return;
      const reach: Reach = {
        step,
        label: branch.label,
        index,
        reads: branch.reads ?? null,
        reached: [],
        unsourced: [],
      };
      lookups.push(reach);
      const own = byBranch.get(step) ?? new Map<number, Reach>();
      own.set(index, reach);
      byBranch.set(step, own);
    });
  }
  const { overlay } = ctx;
  if (overlay === null) return { paths: [], lookups };

  const paths = ctx.paths();
  const names = paths.map((path) => pathName(path));
  if (lookups.length === 0) return { paths: names, lookups };

  const tables = core();
  const sources = sourcesOf(ctx, overlay.applied);
  const checked = new Set<StepId>();
  const list = upTo(overlay.applied.flow.steps, new Set(byBranch.keys()));
  paths.forEach((path, k) => {
    const name = names[k] ?? pathName(path);
    // a lookup reached on this path, and whether every way it is reached gives its field
    const seen = new Map<Reach, boolean>();
    walkFlow(overlay.applied, path, list, (step, way) => {
      if (step.type !== "split") return;
      const own = byBranch.get(step.id);
      if (own === undefined) return;
      const live = liveBranches(step);
      if (!checked.has(step.id)) {
        const compiled = branches[step.id] ?? [];
        const same =
          compiled.length === live.length && compiled.every((branch, j) => branch.label === live[j]?.label);
        if (!same)
          throw new LintError(
            `${step.id}: the compiled branches (${compiled.map((branch) => branch.label).join(" / ")}) are not the split's live branches (${live.map((branch) => branch.label).join(" / ")})`,
          );
        checked.add(step.id);
      }
      live.forEach((branch, index) => {
        const reach = own.get(index);
        if (reach === undefined || !tables.lit(branch.when, way.path)) return;
        const ok = sourced(reach.reads, way.given, sources);
        seen.set(reach, (seen.get(reach) ?? true) && ok);
      });
    });
    for (const [reach, ok] of seen) {
      reach.reached.push(name);
      if (!ok) reach.unsourced.push(name);
    }
  });
  return { paths: names, lookups };
}

/** Up to three path names, then how many more. */
function someNames(names: readonly string[]): string {
  const shown = names.slice(0, 3).join("; ");
  return names.length > 3 ? `${shown}; and ${String(names.length - 3)} more` : shown;
}

function readsText(reads: BranchReads): string {
  return `${reads.from} ${reads.key}`;
}

/** What to do about a lookup whose field has no source on some path, in plain words. */
function giveFix(lookup: LookupReach, reads: BranchReads, every: boolean): string {
  if (reads.from === "path")
    return `read a field of the path model (price, before, after, a booking group, a switch or a fact): '${reads.key}' is none of them`;
  const where = every ? "every path that reaches it" : "those paths";
  return `give ${reads.key} on a step before ${lookup.step} on ${where}, or read a field the booking has there`;
}

/** The rule's hits for one lookup branch (none when it names its field and that field has a source). */
export function lookupHits(lookup: LookupReach): LintHit[] {
  const at = `branch '${lookup.label}'`;
  if (lookup.reads === null)
    return [
      {
        rule: LOOKUP_RULE,
        level: "error",
        step: lookup.step,
        field: at,
        text: lookup.label,
        fix: "name the field code reads to settle it (reads: a needs key an earlier step gives, a record value or a path value)",
      },
    ];
  const reached = lookup.reached.length;
  const missing = lookup.unsourced.length;
  if (reached === 0 || missing === 0) return [];
  const text = readsText(lookup.reads);
  if (missing === reached)
    return [
      {
        rule: LOOKUP_RULE,
        level: "error",
        step: lookup.step,
        field: `${at} reads ${text}`,
        text,
        fix: `given on none of the ${String(reached)} paths that reach it (${someNames(lookup.unsourced)}): ${giveFix(lookup, lookup.reads, false)}`,
      },
    ];
  return [
    {
      rule: LOOKUP_RULE,
      level: "warning",
      step: lookup.step,
      field: `${at} reads ${text}`,
      text,
      fix: `not given on ${String(missing)} of the ${String(reached)} paths that reach it (${someNames(lookup.unsourced)}): ${giveFix(lookup, lookup.reads, true)}`,
    },
  ];
}

/**
 * The rule, reading the flow's compiled branches with `branchesOf` (compiledBranchesOf by default: T-145's compiler on
 * the flow linted). A compiled step from elsewhere, such as a K-01 fixture, is read by handing its branches in.
 */
export function lookupFieldRule(
  branchesOf: (ctx: LintContext) => CompiledBranches = compiledBranchesOf,
): LintRule {
  return {
    id: LOOKUP_RULE,
    name: "lookup without field",
    source:
      "arch 12 line 592 ('when a lookup lacks the field it reads'); arch 03 line 161; Q-39's default; K-01 v1 branch.reads; SPEC-master 4 'needs', 5d, 5e; lib.js walkCombo lines 809-884",
    run(ctx: LintContext): LintHit[] {
      return lookupWalk(ctx, branchesOf(ctx)).lookups.flatMap(lookupHits);
    },
  };
}

/** The rule on the flow's own compiled branches. */
export const lookupField: LintRule = lookupFieldRule();
