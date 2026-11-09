// Where the opt-out line goes in the emitted bundle (T-1116; QUESTIONS Q-30's default; Master Corrections C9; SPEC-master
// 5j; K-01 v1 elements.stop; DL-211, DL-226).
//
// The bundle holds each flow's words once (the master graph) and each trade's ops (its overlay), not words per path: a run
// applies the trade's ops to the master graph (apply(), Q-35) and walks one path. corrections/stops.ts walkStops()
// settles the line on one walked path, per person (DL-211): `true` on Rosie's first reply in a chat the person opened
// where it is that on every walk of the path, "first" where that depends on the walk, and no marker on any other message.
// So each message of the bundle carries what walkStops() gives it on every path of every trade the bundle holds:
//
//   true      the line (true) on every path that shows the message;
//   "first"   the line (true or "first") on some of those paths, or on some walks only: K-01's "first", which shows the
//             line only where the message is the first text its person gets on the walk;
//   none      the line on no path, or no path shows the message: a marker the master or a trade wrote there goes.
//
// The walk is the run's: each trade's ops applied (applyTrade) to the corrected master flow before its sample values are
// slotted (the names in `as` read as the chats are keyed; slotting changes words, not which message goes to whom or where
// it sits), then every path tradePaths() gives the trade: each money path it lists, each booking value, the record's
// fixtures. To find where the bundle holds a message the walk shows, each message of the master flow and of the trade's
// ops is traced first: a number in its elements (TRACE) names its holder, list and index. The master graph's messages are
// held by their step; a trade's by its op, a words op by its place in the flow's ops and a step an after, before or
// branch op adds by that step's id (an own step). apply(), resolveVary() and settleStops() copy a message's elements
// whole, so the number rides the walk; a walked message without one stops the build. The traced copies never reach the
// bundle: the words written are the stages' own, each message's marker set by placeMarks().
//
// The walks are the emitter's cost (about a second per trade and flow on the build Mac). A trade's walks depend only on
// the corrected master flow and the trade, so they are kept by those two as JSON (WALKS): a process that emits the same
// bundle twice, as the determinism tests do, walks each trade once, and the bytes are the same either way.
import { createHash } from "node:crypto";
import type { FlowGraph, FlowLetter, Step } from "../graph/types.ts";
import { walkStops } from "../corrections/stops";
import type { LoadedTrade, TradeId } from "../load/trade";
import { applyTrade, type AppliedStep, type AppliedTrade } from "../overlay/apply";
import { tradePaths } from "../path";

type Obj = Record<string, unknown>;

/** A message's marker in the bundle: the line, the line only where it is the person's first text on the walk, or none. */
export type StopMark = true | "first" | null;

/** The element that traces a message to where the bundle holds it, on the walk only (it never reaches the bundle). */
export const TRACE = "__stopTrace";

/** Where a message sits in its holder: its own `say`, or a variant's `say` or `addSay`. */
export type MessageList = "say" | "vary.say" | "vary.addSay";

/** The holder of a master graph step's messages. */
export function masterHolder(step: string): string {
  return `master ${step}`;
}

/** The holder of the messages of a trade's words op: its place in the flow's ops, from 0. */
export function wordsOpHolder(trade: TradeId, op: number): string {
  return `${trade} op ${String(op)}`;
}

/** The holder of the messages of a step a trade's after, before or branch op adds. */
export function ownStepHolder(trade: TradeId, step: string): string {
  return `${trade} own ${step}`;
}

/** The key of one message: its holder, its list (with the variant's key) and its index. */
export function messageKey(holder: string, list: MessageList, vary: string | null, index: number): string {
  return `${holder} ${list}${vary === null ? "" : ` ${vary}`} [${String(index)}]`;
}

function listKey(holder: string, list: MessageList, vary: string | null): string {
  return `${holder} ${list}${vary === null ? "" : ` ${vary}`}`;
}

/** What the walks of one flow give each message of the bundle. */
export interface StopMarks {
  flow: FlowLetter;
  /** The marker of each message the walks show with the line, by messageKey(); any other message gets none. */
  marks: ReadonlyMap<string, true | "first">;
  /** How many messages each list the walks traced holds, by list: placeMarks() refuses a list of another length. */
  lengths: ReadonlyMap<string, number>;
  /** How many paths were walked, by trade. */
  paths: Readonly<Record<TradeId, number>>;
}

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Numbers each message as it traces it, from `base` on: keyOf(n) is where message `n` is held. A trade's tracer starts
 * where the master flow's ends (`under`), so one walk reads both.
 */
class Tracer {
  readonly keys: string[] = [];
  readonly lengths = new Map<string, number>();
  // A plain field, not a constructor parameter property: the CLI runs this file in Node's strip-only TypeScript.
  private readonly under: Tracer | null;

  constructor(under: Tracer | null = null) {
    this.under = under;
  }

  private get base(): number {
    return this.under === null ? 0 : this.under.keys.length;
  }

  /** Where message `n` is held, or undefined when nothing was traced as `n`. */
  keyOf(n: number): string | undefined {
    if (this.under !== null && n < this.base) return this.under.keyOf(n);
    return this.keys[n - this.base];
  }

  /** Puts a trace number in the elements of each message of `list` (in place: the list is a copy the walk reads). */
  list(list: unknown, holder: string, kind: MessageList, vary: string | null): void {
    if (!Array.isArray(list)) return;
    this.lengths.set(listKey(holder, kind, vary), list.length);
    list.forEach((raw: unknown, index) => {
      if (!Array.isArray(raw)) return;
      const message = raw as unknown[];
      const n = this.base + this.keys.push(messageKey(holder, kind, vary, index)) - 1;
      const elements = message[3];
      if (isObj(elements)) elements[TRACE] = n;
      else if (message.length === 3) message.push({ [TRACE]: n });
      else
        throw new Error(`${messageKey(holder, kind, vary, index)}: a message is [from, to, text, elements?]`);
    });
  }

  /** Traces a step's own messages and its variants', in place. */
  step(step: Obj, holder: string): void {
    this.list(step.say, holder, "say", null);
    const vary = step.vary;
    if (!isObj(vary)) return;
    for (const [key, patch] of Object.entries(vary)) {
      if (!isObj(patch)) continue;
      this.list(patch.say, holder, "vary.say", key);
      this.list(patch.addSay, holder, "vary.addSay", key);
    }
  }

  /** Traces every step under `steps` (branch steps too), each held as `holder(id)` says. */
  steps(steps: unknown, holder: (id: string) => string): void {
    if (!Array.isArray(steps)) return;
    for (const raw of steps as unknown[]) {
      if (!isObj(raw)) continue;
      this.step(raw, holder(String(raw.id)));
      for (const branch of (Array.isArray(raw.branches) ? raw.branches : []) as unknown[])
        if (isObj(branch)) this.steps(branch.steps, holder);
    }
  }
}

/** A copy of the trade with each message its ops write in `flow` traced (words ops by place, own steps by id). */
function tracedTrade(trade: LoadedTrade, flow: FlowLetter, tracer: Tracer): LoadedTrade {
  const copy = structuredClone(trade);
  copy.flows[flow].ops.forEach((op, n) => {
    const raw = op as unknown as Obj;
    if (op.op === "words") tracer.step(raw, wordsOpHolder(trade.id, n));
    else if (op.op === "after" || op.op === "before")
      tracer.steps(raw.steps, (id) => ownStepHolder(trade.id, id));
    else if (op.op === "branch" && isObj(raw.branch))
      tracer.steps(raw.branch.steps, (id) => ownStepHolder(trade.id, id));
  });
  return copy;
}

/** What the walks showed of one message: the line on some walk, and `true` on every walk that showed it. */
interface Seen {
  line: boolean;
  always: boolean;
}

/** One trade's walks of one flow: what they showed of each message, by messageKey(); its ops' lists; its paths. */
interface TradeWalks {
  seen: ReadonlyMap<string, Seen>;
  lengths: ReadonlyMap<string, number>;
  paths: number;
}

/** Every path of one trade walked with walkStops() over its traced ops applied to the traced master flow `graph`. */
function walkTrade(graph: FlowGraph, master: Tracer, trade: LoadedTrade): TradeWalks {
  const flow = graph.flow;
  const tracer = new Tracer(master);
  const applied = applyTrade(graph, tracedTrade(trade, flow, tracer));
  const walked = tradePaths(applied, trade);
  const seen = new Map<string, Seen>();
  for (const path of walked) {
    for (const entry of walkStops(applied, path).steps) {
      (entry.words.say ?? []).forEach((raw, index) => {
        const fourth = (raw as readonly unknown[])[3];
        const elements = isObj(fourth) ? fourth : undefined;
        const n = elements?.[TRACE];
        const key = typeof n === "number" ? tracer.keyOf(n) : undefined;
        if (key === undefined)
          throw new Error(
            `${trade.id} flow ${flow} ${entry.id} say[${String(index)}]: the walk shows a message with no place in the bundle`,
          );
        const stop = elements?.stop;
        const was = seen.get(key) ?? { line: false, always: true };
        seen.set(key, {
          line: was.line || stop === true || stop === "first",
          always: was.always && stop === true,
        });
      });
    }
  }
  return { seen, lengths: tracer.lengths, paths: walked.length };
}

/**
 * Each trade's walks, by what they read: the corrected master flow and the trade, as JSON (a walk reads nothing else).
 * The same flow and trade walk alike, so a process that emits a bundle twice walks each trade once.
 */
const WALKS = new Map<string, TradeWalks>();

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Walks every path of each trade with walkStops() over the trade's ops applied to `corrected` (the master flow after
 * Master Corrections, before its sample values are slotted: emit/flow.ts correctedFlow) and gives each message of the
 * bundle its marker (see the top of this file). `master` is the loaded flow `corrected` was made from: apply() reads its
 * header, which is `corrected`'s, as the corrections change only steps.
 */
export function placeStops(
  master: FlowGraph,
  corrected: AppliedTrade,
  trades: readonly LoadedTrade[],
): StopMarks {
  const flow = master.flow;
  if (corrected.flow.id !== flow)
    throw new Error(`the corrected flow is flow ${corrected.flow.id}, not flow ${flow}`);
  const tracer = new Tracer();
  const steps = structuredClone(corrected.flow.steps);
  tracer.steps(steps, masterHolder);
  const graph: FlowGraph = { ...master, path: steps as unknown as Step[] };
  const content = sha256(JSON.stringify(corrected.flow));

  const seen = new Map<string, Seen>();
  const lengths = new Map(tracer.lengths);
  const paths: Record<TradeId, number> = {};
  for (const trade of trades) {
    const id = `${flow} ${content} ${sha256(JSON.stringify(trade))}`;
    const walks = WALKS.get(id) ?? walkTrade(graph, tracer, trade);
    WALKS.set(id, walks);
    paths[trade.id] = walks.paths;
    for (const [list, length] of walks.lengths) lengths.set(list, length);
    for (const [key, what] of walks.seen) {
      const was = seen.get(key);
      seen.set(
        key,
        was === undefined ? what : { line: was.line || what.line, always: was.always && what.always },
      );
    }
  }

  const marks = new Map<string, true | "first">();
  for (const [key, what] of seen) if (what.line) marks.set(key, what.always ? true : "first");
  return { flow, marks, lengths, paths };
}

/** The marker the walks give a message: true, "first", or null for none. */
export function markOf(
  stops: StopMarks,
  holder: string,
  list: MessageList,
  vary: string | null,
  index: number,
): StopMark {
  return stops.marks.get(messageKey(holder, list, vary, index)) ?? null;
}

/**
 * The message with its marker set to `mark` (null: none), as a copy when it changes. A trade's message with no words,
 * [from, to, elements], keeps its elements third, where steps.ts messageTuple() reads them.
 */
export function withStop(raw: unknown, mark: StopMark): unknown {
  if (!Array.isArray(raw)) return raw;
  const message = raw as unknown[];
  const at = typeof message[2] === "string" ? 3 : 2;
  const elements = isObj(message[at]) ? message[at] : undefined;
  const has = elements !== undefined && "stop" in elements;
  if (mark === null ? !has : has && elements.stop === mark) return raw;
  const next: Obj = { ...elements };
  if (mark === null) delete next.stop;
  else next.stop = mark;
  const copy = [...message];
  if (at === 3 && Object.keys(next).length === 0) copy.length = 3;
  else copy[at] = next;
  return copy;
}

/**
 * The list with each message's marker set as the walks give it. Throws when the walks never traced the list, or traced
 * it with another length: its messages' markers would then be lost, or name other messages.
 */
export function placeMarks(
  stops: StopMarks,
  list: readonly unknown[],
  holder: string,
  kind: MessageList,
  vary: string | null,
): unknown[] {
  const traced = stops.lengths.get(listKey(holder, kind, vary));
  if (traced !== list.length)
    throw new Error(
      `flow ${stops.flow} ${listKey(holder, kind, vary)}: ${String(list.length)} messages, but the walks traced ${traced === undefined ? "none" : String(traced)}`,
    );
  return list.map((raw, index) => withStop(raw, markOf(stops, holder, kind, vary, index)));
}

/** The step (not its branch steps) with every message of its `say` and its variants' marked as the walks give them. */
export function markStep<S extends AppliedStep | Obj>(stops: StopMarks, step: S, holder: string): S {
  const raw = step as Obj;
  const out: Obj = { ...raw };
  if (Array.isArray(raw.say)) out.say = placeMarks(stops, raw.say as unknown[], holder, "say", null);
  if (isObj(raw.vary)) {
    const vary: Obj = {};
    for (const [key, patch] of Object.entries(raw.vary)) {
      if (!isObj(patch)) {
        vary[key] = patch;
        continue;
      }
      const copy: Obj = { ...patch };
      if (Array.isArray(patch.say))
        copy.say = placeMarks(stops, patch.say as unknown[], holder, "vary.say", key);
      if (Array.isArray(patch.addSay))
        copy.addSay = placeMarks(stops, patch.addSay as unknown[], holder, "vary.addSay", key);
      vary[key] = copy;
    }
    out.vary = vary;
  }
  return out as S;
}

/** The steps (branch steps too) with each step's messages marked, the step held as `holder(id)` says, or as it is. */
export function markSteps(
  stops: StopMarks,
  steps: readonly AppliedStep[],
  holder: (step: AppliedStep) => string | null,
): AppliedStep[] {
  return steps.map((step) => {
    const at = holder(step);
    const out = at === null ? { ...step } : markStep(stops, step, at);
    if (step.branches !== undefined)
      out.branches = step.branches.map((branch) => ({
        ...branch,
        steps: markSteps(stops, branch.steps, holder),
      }));
    return out;
  });
}
