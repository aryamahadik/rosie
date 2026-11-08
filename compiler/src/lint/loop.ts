// The lint rule `loop`: a walk can loop (T-158; C-069; K-01 v1 lintRule `loop` and step `walk`; arch 12 line 592, "the
// lint fails a step ... when a walk can loop"; arch 03 line 191, "Code's walk after a choice stops at the first step that
// asks someone, waits on a clock or event, or ends the journey. The compiler rejects loops."; QUESTIONS Q-39's default,
// "a cycle through relative t references or flow-switch ends"; SPEC-master 5g, a relative time must "never loop").
//
// A flow's lists only run forward (a step, its branches' steps, then the next step), so two kinds of reference alone can
// bring a walk back to a step it has passed:
//
//   - A relative `t` (SPEC-master 5g, read by overlay-core.js parseRelT): the step's time is set from another step's.
//     `right after A6-26` or `30 minutes before A8-03` names that step; `right after`, `30 minutes later` or `the next
//     morning` takes the timed step before it on the path, on each path ("A6-14 after A6-26 on the Sam's-OK path, after
//     A6-12 on the others"). The paths are read as overlay-core.js stepTimes reads them with every branch lit: a step
//     with a `t` times the steps after it, even one whose own time cannot be worked out (refuse-loop.json's A6-26); a
//     step whose `when` lights it on some paths only may be passed by; an ending branch takes its paths with it; and a
//     time named from a step further on (a jump ahead) is dropped again when its branch rejoins. The step's own `t` and
//     each variant's count, as lib.js timeProblems reads them.
//   - A flow-switch end (SPEC-master 4: `"flow": "B"` on an ending branch "means it continues in the other flow"), read
//     as T-145's compiler reads it (branches/branch.ts rejoins: a branch with a flow does not rejoin, and neither does
//     an ending one). Code's walk goes on in the other flow there. No source names the step it goes on at; this rule
//     takes the split's twin in that flow, the step with the same id (a shared step), where the same question stands
//     (a default, named in T-158's handoff). A switch to the other flow is followed when the rule is given that flow
//     (loopRule(other)); a switch that names the flow it is in comes back to its own split.
//
// The two are looked for apart. A time points back to the step it is set from; code's walk points on to what runs next.
// A graph holding both would close a false cycle at every relative time (A6-14's time from A5-04, A5-04's walk on to
// A6-14), so time cycles are found among the time references alone, and switch cycles in code's walk alone.
//
// A cycle is reported only where code's walk would not stop on it at a step that asks, waits or ends (arch 03 line 191).
// Splits are read as T-291's frontier reads them (actions/src/frontier/assemble/bundle.ts splitOf), from T-145's tags
// (branches/branch.ts tagOf), so the lint and the frontier agree on what stops a walk: a split with a message or a clock
// branch asks or waits, and stops it; a split whose every branch is a lookup is settled by code and does not; a split
// the walk cannot read (no live branch, or a message branch on a `sync` split) is not taken for a stop, the safer reading
// (its loop is reported). A step that is no split stops nothing. An ending branch that stays in the flow ends the walk,
// as the end of the main path does; code's walk goes down every branch of a split it settles, since code picks one by a
// value the lint does not know.
//
// Each step on such a cycle fails, with its walk: the steps from it round the cycle and back to it, the shortest way
// (K-01 v1 step `walk`: "a step that comes back makes the walk a loop"; refuse-loop.json: A6-14, A6-26, A6-14). A step
// whose time or walk only leads into a cycle is not on it and is not reported, as lib.js flowTimeProblems reports a time
// loop at its own steps (line 717: "a loop further on, reported at its own steps"). A step `off` (an `off` op) and a
// branch `off` are not walked.
import { rejoins, tagOf, type BranchSource, type BranchTag } from "../branches";
import type { FlowLetter, StepId } from "../graph/types.ts";
import { BUILD_DIR, loadOverlayCore } from "../overlay/core";
import {
  LintError,
  isRecord,
  type LintBranch,
  type LintContext,
  type LintHit,
  type LintInput,
  type LintRule,
  type LintStep,
} from "./runner";

/** A flow as this rule walks it: its letter and its steps in page order, branch steps nested (LintInput's two fields). */
export type LoopFlow = Pick<LintInput, "flow" | "steps">;

/** What a split is to code's walk (T-291's frontier, splitOf): it asks or waits, code settles it, or it cannot be read. */
export type SplitKind = "asks" | "code" | "unknown";

/** One step on a cycle. */
export interface Loop {
  /** time: a cycle of relative times; walk: a cycle of code's walk through a flow-switch end. */
  readonly kind: "time" | "walk";
  readonly step: StepId;
  /** The step's field that starts its walk round the cycle: `t`, `vary 'before:full' t`, or `walk`. */
  readonly field: string;
  /** The steps from this one round the cycle and back to it, the shortest way (K-01 v1 step `walk`). */
  readonly walk: StepId[];
}

const FIX = {
  time: "time it from a step outside this loop, or give it a fixed time",
  walk: "make a step on it ask, wait or end, or switch to a step outside it",
} as const;

/** What overlay-core.js parseRelT gives for a relative time: the step it names, or null for the time before it. */
interface RelativeTime {
  anchor: string | null;
}

interface TimeCore {
  parseRelT(t: unknown): RelativeTime | null;
}

let timeCore: TimeCore | null = null;
const parsed = new Map<string, RelativeTime | null>();

/** overlay-core.js parseRelT, from the one copy of the script the compiler loads (overlay/core.ts; NQ-PB-2 WRAP). */
function parseRelT(text: string): RelativeTime | null {
  if (timeCore === null) {
    const loaded = loadOverlayCore() as unknown as Partial<TimeCore>;
    if (typeof loaded.parseRelT !== "function")
      throw new Error(`${BUILD_DIR}overlay-core.js does not export parseRelT()`);
    timeCore = loaded as TimeCore;
  }
  if (!parsed.has(text)) parsed.set(text, timeCore.parseRelT(text));
  return parsed.get(text) ?? null;
}

/** Switched off by an `off` op: not walked (overlay-core.js stepTimes passes over `s.off` and `b.off`). */
function isOff(item: LintStep | LintBranch): boolean {
  return "off" in item && item.off !== undefined && item.off !== null && item.off !== false;
}

/** A step this flow's walk reads: it has an id, is not switched off, and is not a shared step of the other flow. */
function inFlow(step: LintStep, flow: FlowLetter): boolean {
  return step.id !== "" && !isOff(step) && !(Boolean(step.only) && step.only !== flow);
}

function liveBranches(step: LintStep): LintBranch[] {
  return (step.branches ?? []).filter((branch) => !isOff(branch));
}

/** A branch's tag (T-145, tagOf): clock for a silence or time that ran out, lookup for a money gate, else message. */
function tagOfBranch(branch: LintBranch): BranchTag {
  const source: BranchSource = { label: branch.label, steps: [] };
  // Every field of a gate is optional, so a plain object is one: tagOf reads only its price, before and after.
  if (isRecord(branch.when)) source.when = branch.when;
  return tagOf(source);
}

/**
 * What a split is to code's walk, read as T-291's frontier reads one (bundle.ts splitOf) from T-145's tags: asks, when
 * a live branch is a message or a clock (the split asks someone or waits on a clock row); code, when every live branch
 * is a lookup; unknown, when no branch is live or a message branch sits on a `sync` split (system to system: nobody to
 * ask). Null for a step that is no split.
 */
export function splitKind(step: LintStep): SplitKind | null {
  if (step.type !== "split" && (step.branches ?? []).length === 0) return null;
  const tags = liveBranches(step).map(tagOfBranch);
  if (tags.length === 0) return "unknown";
  const message = tags.includes("message");
  if (message && "via" in step && step.via === "sync") return "unknown";
  return message || tags.includes("clock") ? "asks" : "code";
}

/** How a branch ends, as the master writes it: `merge` or `end`, and the flow an ending branch goes on in. */
function endOf(branch: LintBranch): { end?: "merge" | "end"; flow?: FlowLetter } {
  const out: { end?: "merge" | "end"; flow?: FlowLetter } = {};
  if ("end" in branch && (branch.end === "merge" || branch.end === "end")) out.end = branch.end;
  if ("flow" in branch && (branch.flow === "A" || branch.flow === "B")) out.flow = branch.flow;
  return out;
}

/** The step's times as lib.js timeProblems reads them: its own `t`, then each variant's, each with its field. */
function timeTexts(step: LintStep): [field: string, text: string][] {
  const out: [string, string][] = [];
  if ("t" in step && typeof step.t === "string" && step.t !== "") out.push(["t", step.t]);
  if (isRecord(step.vary)) {
    for (const [key, patch] of Object.entries(step.vary)) {
      if (isRecord(patch) && typeof patch.t === "string" && patch.t !== "")
        out.push([`vary '${key}' t`, patch.t]);
    }
  }
  return out;
}

/** One flow's steps as the walks read them: page order and ids. */
interface FlowIndex {
  readonly flow: FlowLetter;
  readonly steps: readonly LintStep[];
  readonly order: Map<LintStep, number>;
  readonly byId: Map<string, LintStep>;
}

function indexOf(flow: LoopFlow): FlowIndex {
  const order = new Map<LintStep, number>();
  const byId = new Map<string, LintStep>();
  const visit = (list: readonly LintStep[]): void => {
    for (const step of list) {
      if (!inFlow(step, flow.flow)) continue;
      order.set(step, order.size);
      if (!byId.has(step.id)) byId.set(step.id, step);
      for (const branch of liveBranches(step)) visit(branch.steps ?? []);
    }
  };
  visit(flow.steps);
  return { flow: flow.flow, steps: flow.steps, order, byId };
}

/** A directed graph over steps: each edge with the field of its source step that makes it. */
class Graph {
  readonly edges = new Map<LintStep, Map<LintStep, string>>();

  add(from: LintStep, to: LintStep, field: string): void {
    const out = this.edges.get(from) ?? new Map<LintStep, string>();
    if (!out.has(to)) out.set(to, field);
    this.edges.set(from, out);
  }

  next(from: LintStep): LintStep[] {
    return [...(this.edges.get(from)?.keys() ?? [])];
  }
}

/** A path's last timed step, and the state before a jump ahead in its branch (overlay-core.js stepTimes `before`). */
interface Timed {
  readonly step: LintStep | null;
  readonly before: Timed | null;
}

function timedKey(state: Timed): string {
  const id = (step: LintStep | null): string => step?.id ?? "";
  return `${id(state.step)}|${state.before === null ? "~" : id(state.before.step)}`;
}

function dedupe(states: readonly Timed[]): Timed[] {
  const seen = new Set<string>();
  return states.filter((state) => {
    const key = timedKey(state);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The relative-time references of one flow: each step with a relative time to the step it is set from, on every path
 * (overlay-core.js stepTimes with every branch lit, step by step and path by path).
 */
function timeGraph(index: FlowIndex): Graph {
  const graph = new Graph();
  const walk = (list: readonly LintStep[], arriving: readonly Timed[]): Timed[] => {
    let states = [...arriving];
    for (const step of list) {
      if (!inFlow(step, index.flow)) continue;
      const before = states;
      const times = timeTexts(step).map(([field, text]) => {
        const rel = parseRelT(text);
        const anchor = rel === null ? null : rel.anchor;
        const named = anchor === null ? undefined : index.byId.get(anchor);
        return { field, rel, named };
      });
      for (const { field, rel, named } of times) {
        if (rel === null) continue;
        if (rel.anchor !== null) {
          if (named !== undefined) graph.add(step, named, field);
        } else {
          for (const state of before) if (state.step !== null) graph.add(step, state.step, field);
        }
      }
      let out: Timed[] = [];
      if (times.length === 0) out = [...before];
      else {
        const own = times.some(({ field }) => field === "t");
        for (const state of before) {
          for (const { named } of times) {
            // A time named from a step further on is a jump ahead, dropped again where its branch rejoins.
            const ahead = named !== undefined && (index.order.get(named) ?? 0) > (index.order.get(step) ?? 0);
            out.push({ step, before: ahead && state.before === null ? state : state.before });
          }
          // Timed by a variant only: on the other paths it is passed by untimed.
          if (!own) out.push(state);
        }
      }
      if (splitKind(step) !== null) {
        const merged: Timed[] = [];
        for (const branch of liveBranches(step)) {
          const left = walk(branch.steps ?? [], dedupe(out));
          if (rejoins(endOf(branch))) for (const state of left) merged.push(state.before ?? state);
        }
        out = merged;
      }
      // Lit on some paths only: the others pass it by.
      if (step.when !== undefined) out.push(...before);
      states = dedupe(out);
    }
    return states;
  };
  walk(index.steps, [{ step: null, before: null }]);
  return graph;
}

/** One relative-time reference: the step, the field whose time says it, and a step its time is set from. */
export interface TimeReference {
  readonly step: StepId;
  readonly field: string;
  readonly from: StepId;
}

/**
 * Every relative-time reference of a flow, in page order: the step it names, or each step that is the timed step before
 * it on some path. The edges the rule looks for time cycles in.
 */
export function timeReferences(flow: LoopFlow): TimeReference[] {
  const index = indexOf(flow);
  const graph = timeGraph(index);
  const out: TimeReference[] = [];
  for (const step of index.order.keys()) {
    for (const [to, field] of graph.edges.get(step) ?? []) out.push({ step: step.id, field, from: to.id });
  }
  return out;
}

/** Where one branch sits: its split, the list that holds the split, the split's place in it, and the branch above. */
interface Holder {
  readonly split: LintStep;
  readonly branch: LintBranch;
  readonly list: readonly LintStep[];
  readonly at: number;
  readonly up: Holder | null;
}

/**
 * Code's walk over one flow (arch 03 line 191), into `graph`: a step goes on to the next step of its list; a split that
 * asks or waits goes nowhere; any other split goes down each live branch, to its first step, or, with none, where the
 * branch goes; at the end of a branch's steps the walk rejoins after its split, ends, or goes on in the other flow at
 * `twin`; at the end of the main path it ends. A step whose `when` may leave it unlit may be passed by.
 */
function addWalk(
  graph: Graph,
  index: FlowIndex,
  twin: (flow: FlowLetter, split: LintStep) => LintStep | null,
): void {
  const live = (list: readonly LintStep[]): LintStep[] => list.filter((step) => inFlow(step, index.flow));

  const arrive = (list: readonly LintStep[], at: number, up: Holder | null): LintStep[] => {
    const step = list[at];
    if (step === undefined) return up === null ? [] : past(up.split, up.branch, up.list, up.at, up.up);
    return step.when === undefined ? [step] : [step, ...arrive(list, at + 1, up)];
  };

  const past = (
    split: LintStep,
    branch: LintBranch,
    list: readonly LintStep[],
    at: number,
    up: Holder | null,
  ): LintStep[] => {
    const end = endOf(branch);
    if (rejoins(end)) return arrive(list, at + 1, up);
    if (end.flow === undefined) return [];
    const there = twin(end.flow, split);
    return there === null ? [] : [there];
  };

  const visit = (list: readonly LintStep[], up: Holder | null): void => {
    const steps = live(list);
    steps.forEach((step, at) => {
      const kind = splitKind(step);
      if (kind === null) {
        for (const to of arrive(steps, at + 1, up)) graph.add(step, to, "walk");
      } else if (kind !== "asks") {
        for (const branch of liveBranches(step)) {
          const own = live(branch.steps ?? []);
          const holder: Holder = { split: step, branch, list: steps, at, up };
          const targets = own.length > 0 ? arrive(own, 0, holder) : past(step, branch, steps, at, up);
          for (const to of targets) graph.add(step, to, "walk");
        }
      }
      for (const branch of liveBranches(step))
        visit(branch.steps ?? [], { split: step, branch, list: steps, at, up });
    });
  };
  visit(index.steps, null);
}

/** The steps of `graph` that lie on a cycle, none of whose steps `stops`, each with its shortest way round (Tarjan). */
function cycles(
  graph: Graph,
  nodes: readonly LintStep[],
  stops: (step: LintStep) => boolean,
): Map<LintStep, LintStep[]> {
  const next = (step: LintStep): LintStep[] =>
    stops(step) ? [] : graph.next(step).filter((to) => !stops(to));
  const low = new Map<LintStep, number>();
  const seen = new Map<LintStep, number>();
  const stack: LintStep[] = [];
  const onStack = new Set<LintStep>();
  const groups: LintStep[][] = [];

  const connect = (root: LintStep): void => {
    // Iterative Tarjan: each frame is a step and the successors left to look at.
    const frames: { step: LintStep; rest: LintStep[] }[] = [];
    const open = (step: LintStep): void => {
      seen.set(step, seen.size);
      low.set(step, seen.get(step) ?? 0);
      stack.push(step);
      onStack.add(step);
      frames.push({ step, rest: next(step) });
    };
    open(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame === undefined) break;
      const to = frame.rest.shift();
      if (to !== undefined) {
        if (!seen.has(to)) open(to);
        else if (onStack.has(to)) low.set(frame.step, Math.min(low.get(frame.step) ?? 0, seen.get(to) ?? 0));
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined)
        low.set(parent.step, Math.min(low.get(parent.step) ?? 0, low.get(frame.step) ?? 0));
      if (low.get(frame.step) === seen.get(frame.step)) {
        const group: LintStep[] = [];
        for (;;) {
          const top = stack.pop();
          if (top === undefined) break;
          onStack.delete(top);
          group.push(top);
          if (top === frame.step) break;
        }
        groups.push(group);
      }
    }
  };
  for (const step of nodes) if (!seen.has(step)) connect(step);

  const out = new Map<LintStep, LintStep[]>();
  for (const group of groups) {
    const members = new Set(group);
    const only = group[0];
    if (group.length === 1 && (only === undefined || !next(only).includes(only))) continue;
    for (const start of group) {
      const way = shortestRound(start, (step) => next(step).filter((to) => members.has(to)));
      if (way !== null) out.set(start, way);
    }
  }
  return out;
}

/** The shortest way from `start` back to it (breadth first), as the steps in order with `start` at both ends. */
function shortestRound(start: LintStep, next: (step: LintStep) => LintStep[]): LintStep[] | null {
  const from = new Map<LintStep, LintStep>();
  const queue: LintStep[] = [start];
  // The queue grows as it is read: a for-of over an array reads what is pushed while it runs.
  for (const step of queue) {
    for (const to of next(step)) {
      if (to === start) {
        const back: LintStep[] = [];
        for (let at: LintStep | undefined = step; at !== undefined && at !== start; at = from.get(at))
          back.push(at);
        return [start, ...back.reverse(), start];
      }
      if (!from.has(to)) {
        from.set(to, step);
        queue.push(to);
      }
    }
  }
  return null;
}

/**
 * The steps of `flow` that lie on a cycle code's walk would go round without stopping at a step that asks, waits or
 * ends: a cycle of relative times, or one of code's walk through a flow-switch end. `other`, the other flow, lets a
 * switch into it be followed; without it, only a switch that names the flow it is in can come back. In page order,
 * each step's time cycle before its walk cycle.
 */
export function findLoops(flow: LoopFlow, other: LoopFlow | null = null): Loop[] {
  if (other !== null && other.flow === flow.flow)
    throw new LintError(`the other flow given to the loop rule is flow ${other.flow}, the flow it lints`);
  const own = indexOf(flow);
  const asks = (step: LintStep): boolean => splitKind(step) === "asks";
  const nodes = [...own.order.keys()];

  const timeRefs = timeGraph(own);
  const times = cycles(timeRefs, nodes, asks);

  const walk = new Graph();
  const there = other === null ? null : indexOf(other);
  const twin = (letter: FlowLetter, split: LintStep): LintStep | null => {
    const index = letter === own.flow ? own : there !== null && letter === there.flow ? there : null;
    return index?.byId.get(split.id) ?? null;
  };
  addWalk(walk, own, twin);
  if (there !== null) addWalk(walk, there, twin);
  const walks = cycles(walk, [...nodes, ...(there === null ? [] : there.order.keys())], asks);

  const out: Loop[] = [];
  for (const step of nodes) {
    const time = times.get(step);
    if (time !== undefined) {
      const second = time[1];
      const field = second === undefined ? "t" : (timeRefs.edges.get(step)?.get(second) ?? "t");
      out.push({ kind: "time", step: step.id, field, walk: time.map((at) => at.id) });
    }
    const round = walks.get(step);
    if (round !== undefined)
      out.push({ kind: "walk", step: step.id, field: "walk", walk: round.map((at) => at.id) });
  }
  return out;
}

/**
 * The rule `loop` (K-01 v1 lintRule), given the other flow or not: an error on each step of a cycle that code's walk
 * would go round without stopping (see the top of this file). Its words are the walk: `A6-14 > A6-26 > A6-14`.
 */
export function loopRule(other: LoopFlow | null = null): LintRule {
  return {
    id: "loop",
    name: "walk can loop",
    source:
      "arch 12 line 592; arch 03 line 191; QUESTIONS Q-39 default; SPEC-master 5g; lib.js flowTimeProblems lines 707-719",
    run(ctx: LintContext): LintHit[] {
      return findLoops(ctx, other).map((found) => ({
        rule: "loop",
        level: "error",
        step: found.step,
        field: found.field,
        text: found.walk.join(" > "),
        fix: FIX[found.kind],
      }));
    },
  };
}

/** The rule on one flow alone: its time cycles, and a flow switch that names the flow it is in. */
export const loop: LintRule = loopRule();
