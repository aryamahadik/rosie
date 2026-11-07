// Lighting and words per path (T-136): lit(), resolveVary() and applyStops() of the master, typed, and the walk that
// puts them together for one path.
//
//   lit(applied, when, path)           is a branch (or a step) with this `when` lit on the path? overlay-core.js lit().
//   resolveVary(applied, step, path)   the words the step shows on the path: the money choice key, then the layer keys
//                                      (a switch, a booking value), amount, record and time slots, layer lines.
//   applyStops(step, rec)              the opt-out element ("stop": "first") settled for the walked path.
//   walkPath(applied, path)            every step the path lights, in page order, with the words each shows and which
//                                      of its branches are lit.
//
// All four call the vendored functions (NQ-PB-2: wrap). The vendored tables are module state, so each call that reads
// them first makes them read `applied` (syncFlow): the money ways, D75 mark and booking record of that trade's flow.
import type { Gate } from "../graph/types.ts";
import type { AppliedStep, AppliedTrade } from "../overlay/apply";
import { loadPathScripts, type CoreFirstTexts, type CoreTextRecord } from "./core";
import { fromCorePath, syncFlow, toCorePath, type TradePath } from "./model";

/** What resolveVary() hands back: the step with the path's words, and the keys that chose them. */
export interface Varied {
  /** The step as it reads on this path: `does`, `more`, `say`, `form`, `table`, `rule`, `t` (and layer lines) picked and filled. */
  step: AppliedStep;
  /** The last key applied, or null when the step shows its base words. */
  key: string | null;
  /** Every key applied, in order: the money key first, then the layer keys, least specific first. */
  keys: string[];
  /** The money (choice) key applied, or null. */
  choice: string | null;
  /** Two keys that fit equally well and set the same field (the master's lint calls this an error), or null. */
  tie: string[] | null;
}

/** One text a number gets (overlay-core.js firstTexts): `first` on some walk, `later` on some walk. */
export type TextRecord = CoreTextRecord;

/** For each step id, for each message of its `say`, whether it is the first text a number gets on the walked path. */
export type FirstTexts = CoreFirstTexts;

/** Is a branch or step with this `when` lit on the path? No `when`: lit. */
export function lit(applied: AppliedTrade, when: Gate | undefined, path: TradePath): boolean {
  syncFlow(applied.flow);
  return loadPathScripts().core.lit(when, toCorePath(path));
}

/** The words a step shows on a path (before the opt-out line is settled: that is applyStops). */
export function resolveVary(applied: AppliedTrade, step: AppliedStep, path: TradePath): Varied {
  syncFlow(applied.flow);
  const varied = loadPathScripts().core.resolveVary(step, toCorePath(path));
  return { step: varied.step, key: varied.key, keys: varied.keys, choice: varied.choice, tie: varied.tie };
}

/**
 * The step's words with each conditional opt-out element ("stop": "first") settled for a walked path: kept as the line
 * where it is the first text that number gets on every walk to it, left "first" where that depends on the walk, taken
 * out where it never is. `rec` is `firstTexts(applied, path)[step.id]`; with none, the step as written.
 */
export function applyStops(step: AppliedStep, rec: Record<number, TextRecord> | undefined): AppliedStep {
  return loadPathScripts().core.applyStops(step, rec);
}

/** Which message of which step is the first text its number gets on the path (the walk of overlay-core.js firstTexts). */
export function firstTexts(applied: AppliedTrade, path: TradePath): FirstTexts {
  syncFlow(applied.flow);
  return loadPathScripts().core.firstTexts(applied.flow.steps, toCorePath(path), {
    names: applied.flow.names,
  });
}

/** One branch of a lit split, on the path as that step reads it. */
export interface BranchLight {
  label: string;
  /** Lit on the path: the branch's `when` fits and no `off` op switched it off. */
  lit: boolean;
  /** An `off` op switched the branch off (the reason is on the applied branch). */
  off: boolean;
}

/** One step the path lights. */
export interface LitStep {
  id: string;
  /** The labels of the branches the step sits in, outermost first. */
  trail: string[];
  /**
   * The path as this step reads it: the walked path, or the path after a lit branch's `sets` that has rejoined (a step
   * after such a split is reached with both readings, and appears once for each).
   */
  reading: TradePath;
  /** The step as the applied flow has it. */
  step: AppliedStep;
  /** The words the step shows on this reading, the opt-out line settled. */
  words: AppliedStep;
  /** The keys that chose the words (resolveVary). */
  keys: string[];
  choice: string | null;
  tie: string[] | null;
  /** For a split: each branch and whether it is lit. Empty for a step that is not a split. */
  branches: BranchLight[];
}

/** Everything one path lights in its flow, in page order. */
export interface PathWalk {
  path: TradePath;
  steps: LitStep[];
}

/**
 * Walks one path over the applied flow as the master's tools do (lib.js litSteps): a step is skipped where it is off or
 * its `when` does not fit; each lit branch's steps follow it; once a branch with `sets` is lit, its steps and the steps
 * after it rejoins read the path with that value. The words of each lit step are picked with resolveVary and its
 * opt-out line settled with applyStops over firstTexts of the walked path.
 *
 * `{ sets: false }` reads every step with the walked path alone, one entry per step, as step.js --path prints a step
 * (it ignores `sets`); the default follows `sets`, so a step after such a split can appear once per reading.
 */
export function walkPath(applied: AppliedTrade, path: TradePath, options: { sets?: boolean } = {}): PathWalk {
  const { core } = loadPathScripts();
  syncFlow(applied.flow);
  const walked = toCorePath(path);
  const stops = core.firstTexts(applied.flow.steps, walked, { names: applied.flow.names });
  const steps: LitStep[] = [];

  const visit = (step: AppliedStep, reading: typeof walked, trail: string[]): void => {
    const varied = core.resolveVary(step, reading);
    const branches: BranchLight[] = (step.branches ?? []).map((branch) => ({
      label: branch.label,
      lit: branch.off === undefined && core.lit(branch.when, reading),
      off: branch.off !== undefined,
    }));
    steps.push({
      id: step.id,
      trail,
      reading: fromCorePath(reading, path.flow, path.kind),
      step,
      words: core.applyStops(varied.step, stops[step.id]),
      keys: varied.keys,
      choice: varied.choice,
      tie: varied.tie,
      branches,
    });
  };

  if (options.sets !== false && core.setsScopes(applied.flow.steps).length > 0) {
    core.walkSets(
      applied.flow.steps,
      walked,
      (step, reading, trail, branch) => {
        if (branch === undefined) visit(step as AppliedStep, reading, trail);
      },
      { off: true },
    );
  } else {
    const go = (list: AppliedStep[], trail: string[]): void => {
      for (const step of list) {
        if (step.off !== undefined || (step.when !== undefined && !core.lit(step.when, walked))) continue;
        visit(step, walked, trail);
        for (const branch of step.branches ?? []) {
          if (branch.off === undefined && core.lit(branch.when, walked))
            go(branch.steps, [...trail, branch.label]);
        }
      }
    };
    go(applied.flow.steps, []);
  }
  return { path, steps };
}
