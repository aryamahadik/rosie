// A flow's steps as K-01 v1 writes them (T-149; K-01 `step`, `message`, `wordsPatch`), from a flow in the master
// file's shape: the master's own flow after Master Corrections and slotting (flow.ts), or a trade's applied flow
// (trade.ts).
//
// Each part comes from the stage that makes it; this file only puts them in K-01's fields:
//   say, vary say/addSay    K-01 messages with their plain-text forms: msgtext's bundleMessage() (T-134)
//   card                    the decision's card: compileTradeCards() (T-144)
//   fallbackText            the step's master line: compileFallbackTexts() (T-144)
//   branches                a split's compiled branches: compileTradeBranches() (T-145)
//   pageTypes, layerLines   pageTypesOf() and layerIdsOf() (T-145)
//   lint                    the rules K-01 v1's own checks find on the step's fields: lintMarksOf() (validate.ts)
// and the walk's order, read from the flow's lists:
//   section                 from the id (S1-01 is section 1; a trade's own A7-x01 is section 7), as the loader derives it
//   next                    the next step on the step's own list (the main path, or its branch) that an `off` (a trade's,
//                           or a correction's) has not switched off; null at the end of the list. The same reading
//                           compileTradeBranches() gives each branch's rejoinAt.
// A field the master leaves out is left out. The master's names that K-01 spells otherwise are mapped: `line` is
// `lines`, `layerAdd` is `layerLines` (the ids). Nothing else is renamed; fields K-01 does not hold (`sec`, `phase`,
// apply()'s `own`, `changed`, `off` and `timed`) are left out. Three values K-01 v1 writes otherwise:
//   type     kept only as `split`: twelve flow B steps say `step`, a plain step (K-01: "Left out on a plain step");
//   timing   `false` (lib.js line 594: keep this step's time slots on the set-time words) is a step with no stamp, and
//            K-01's `timing` holds only the stamp, so it is left out, as an unstamped step's is (the master's readers
//            take both alike: overlay-core.js lines 777 and 1433 read `s.timing ?`);
//   form     a screen row a trade writes as its label alone (towing.json flow B, B5-05's ["Card"]) is that label with
//            an empty value, since K-01's row is a pair.
import type { FlowLetter, Message } from "../graph/types.ts";
import { compileFallbackTexts, compileTradeCards, type StepCard } from "../cards";
import { compileTradeBranches, layerIdsOf, pageTypesOf, type CompiledBranch } from "../branches";
import { bundleMessage, type BundleMessage } from "../msgtext";
import type { AppliedStep, AppliedTrade } from "../overlay/apply";
import { lintMarksOf } from "./validate";

type Obj = Record<string, unknown>;

/** A compiled step: K-01 v1 `step`, as a plain object in K-01's field order. */
export type BundleStep = Obj & { id: string; lint: string[] };

/** The steps of one flow compiled, by id in page order, and the switched-off ones. */
export interface CompiledSteps {
  flow: FlowLetter;
  steps: Map<string, BundleStep>;
  /** Steps an `off` switched off (a trade's op, or a correction): in `steps`, but on no list's walk. */
  off: Set<string>;
}

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The section of a step id: S1-01 is 1, B12-04 is 12, a trade's own A7-x01 is 7. */
export function sectionOf(id: string): number {
  const match = /^[SAB](\d{1,2})-/.exec(id);
  if (match?.[1] === undefined) throw new Error(`${id} is not a step id`);
  return Number(match[1]);
}

/**
 * One message as K-01 writes it (bundleMessage, T-134). A trade may write a message with no words, `[from, to,
 * elements]` (appraiser.json): its words are "" here, as K-01's `text` is required.
 */
export function toBundleMessage(message: unknown, where: string): BundleMessage {
  if (!Array.isArray(message) || message.length < 3)
    throw new Error(`${where}: a message is [from, to, text, elements?]`);
  const parts = message as unknown[];
  const tuple: unknown[] =
    typeof parts[2] === "string" ? parts.slice(0, 4) : [parts[0], parts[1], "", parts[2]];
  if (tuple[3] === undefined) tuple.length = 3;
  return bundleMessage(tuple as Message);
}

/** A list of messages as K-01 writes them. */
export function toBundleMessages(list: readonly unknown[], where: string): BundleMessage[] {
  return list.map((message, k) => toBundleMessage(message, `${where}[${String(k)}]`));
}

/**
 * A screen's rows as K-01 writes them: label and value pairs (K-01 `pair`, two strings). A row a trade writes as its
 * label alone (towing.json, flow B's B5-05: ["Card"]; the trade loader's FormRow) is that label with an empty value.
 */
export function toScreenRows(form: unknown, where: string): [string, string][] {
  if (!Array.isArray(form)) throw new Error(`${where}: a form is a list of rows`);
  return form.map((row: unknown, k): [string, string] => {
    const cells: unknown[] = Array.isArray(row) ? row : [];
    if (
      cells.length < 1 ||
      cells.length > 2 ||
      !cells.every((cell): cell is string => typeof cell === "string")
    )
      throw new Error(`${where}[${String(k)}]: a form row is [label, value] or [label]`);
    const [label = "", value = ""] = cells;
    return [label, value];
  });
}

/** The fields of a `vary` entry, in K-01 `wordsPatch` order. */
const PATCH_FIELDS: readonly string[] = [
  "does",
  "more",
  "say",
  "rule",
  "t",
  "form",
  "table",
  "swap",
  "addMore",
  "addSay",
];

/** A `vary` (key to words) as K-01 writes it: its keys in the master's order (the order the layers apply in). */
export function toBundleVary(vary: unknown, where: string): Obj {
  if (!isObj(vary)) throw new Error(`${where}: vary is not an object`);
  const out: Obj = {};
  for (const [key, patch] of Object.entries(vary)) {
    if (!isObj(patch)) throw new Error(`${where}.${key}: a variant is not an object`);
    const copy: Obj = {};
    for (const field of PATCH_FIELDS) {
      if (!(field in patch)) continue;
      const value = patch[field];
      if ((field === "say" || field === "addSay") && Array.isArray(value))
        copy[field] = toBundleMessages(value, `${where}.${key}.${field}`);
      else if (field === "form") copy.form = toScreenRows(value, `${where}.${key}.form`);
      else copy[field] = structuredClone(value);
    }
    for (const field of Object.keys(patch))
      if (!PATCH_FIELDS.includes(field))
        throw new Error(`${where}.${key}: "${field}" is not a variant field`);
    out[key] = copy;
  }
  return out;
}

/** Fields copied as written, in K-01 order, between `does` and `type` (say and vary are converted, layerAdd mapped). */
const COPIED: readonly string[] = [
  "more",
  "say",
  "rule",
  "form",
  "table",
  "needs",
  "gives",
  "tells",
  "reads",
  "when",
  "vary",
  "slot",
  "text",
  "visit",
  "took",
  "ev",
  "rec",
  "wr",
  "timing",
  "amounts",
];

/** What compileSteps() reads for each step besides the step: the stages' outputs for the flow. */
interface Parts {
  cards: Record<string, StepCard>;
  branches: Record<string, CompiledBranch[]>;
  fallbacks: Record<string, string>;
}

function compileStep(step: AppliedStep, next: string | null, parts: Parts, where: string): BundleStep {
  const id = step.id;
  const out: Obj = { id, section: sectionOf(id), lines: structuredClone(step.line) };
  if (step.kind !== undefined) out.kind = step.kind;
  out.who = step.who;
  if (step.to !== undefined) out.to = step.to;
  if (step.as !== undefined) out.as = step.as;
  out.via = step.via;
  if (step.t !== undefined) out.t = step.t;
  out.title = step.title;
  out.does = step.does;
  const raw = step as unknown as Obj;
  for (const field of COPIED) {
    if (raw[field] === undefined) continue;
    if (field === "timing" && raw.timing === false) continue; // no stamp (see the top of this file)
    if (field === "say") out.say = toBundleMessages(raw.say as unknown[], `${where}.say`);
    else if (field === "vary") out.vary = toBundleVary(raw.vary, `${where}.vary`);
    else if (field === "form") out.form = toScreenRows(raw.form, `${where}.form`);
    else out[field] = structuredClone(raw[field]);
  }
  const layers = layerIdsOf(step);
  if (layers.length > 0) out.layerLines = layers;
  if (step.type === "split") {
    out.type = "split";
    if (step.q !== undefined) out.q = step.q;
    const branches = parts.branches[id];
    if (branches !== undefined) out.branches = structuredClone(branches);
  } else if (step.q !== undefined) out.q = step.q;
  const card = parts.cards[id];
  if (card !== undefined) out.card = structuredClone(card);
  const fallback = parts.fallbacks[id];
  if (fallback !== undefined) out.fallbackText = fallback;
  out.pageTypes = pageTypesOf(step);
  out.next = next;
  const compiled = out as BundleStep;
  compiled.lint = lintMarksOf(compiled);
  return compiled;
}

/**
 * Compiles the steps of one flow (the master's, or a trade's applied flow) into K-01 v1 steps, every step of the
 * flow (branch steps included) or only those `only` names. `applied.flow.steps` is the main path with the branches'
 * steps nested, as master-A.json writes it.
 */
export function compileSteps(applied: AppliedTrade, only?: ReadonlySet<string>): CompiledSteps {
  const parts: Parts = {
    cards: compileTradeCards(applied),
    branches: compileTradeBranches(applied),
    fallbacks: compileFallbackTexts(applied.flow.steps),
  };
  const flow = applied.flow.id;
  const steps = new Map<string, BundleStep>();
  const off = new Set<string>();

  const visit = (list: readonly AppliedStep[], where: string): void => {
    list.forEach((step, k) => {
      if (steps.has(step.id)) throw new Error(`${where}: step ${step.id} is in the flow twice`);
      if (step.off !== undefined) off.add(step.id);
      const next = list.slice(k + 1).find((later) => later.off === undefined)?.id ?? null;
      const at = `${where} ${step.id}`;
      if (only === undefined || only.has(step.id)) steps.set(step.id, compileStep(step, next, parts, at));
      (step.branches ?? []).forEach((branch) => {
        visit(branch.steps, `${at} branch '${branch.label}'`);
      });
    });
  };
  visit(applied.flow.steps, `${applied.trade} flow ${flow}`);
  if (only !== undefined) {
    for (const id of only)
      if (!steps.has(id)) throw new Error(`${applied.trade} flow ${flow}: no step ${id} to compile`);
  }
  return { flow, steps, off };
}
