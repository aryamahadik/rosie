// The scan of slotted message lines (T-142): which sample values are left outside a slot, and which slots a line names.
//
// The scan does not call slotText(): it looks for what a sample value looks like with patterns of its own (a month and a
// day, a clock time with am or pm, a `$` amount, a phone number, a street address, a check-in code) and for the sample
// names of the trade's table, in the stretches of a line that are outside every `{{...}}`. Rosie's own fee terms ($2, $49,
// 1%) are not residue.
import type { LayerLine } from "../graph/types.ts";
import type { AppliedFlow, AppliedStep } from "../overlay/apply";
import type { PathWalk } from "../path";
import { FEE_TERMS, eachStep, leaves } from "./slotting";
import type { SampleTable } from "./samples";
import { BRACES, checkSlotNames } from "./vocabulary";

export type LeftoverKind = "name" | "date" | "time" | "amount" | "phone" | "address" | "code";

/** One sample value left outside a slot. */
export interface Leftover {
  kind: LeftoverKind;
  match: string;
}

/** One message string of a flow, with where it is. */
export interface Line {
  /** `A4-12 say`, `A4-12 vary pf:sensitive addSay`, `record pay.cancel row 2`. */
  at: string;
  text: string;
}

const DATE =
  /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?) (?:\d{1,2}|20\d\d)\b/g;
const TIME = /\b\d{1,2}(?::\d\d)?\s?[ap]\.?m\b/gi;
const AMOUNT = /\$\d+(?:,\d{3})*(?:\.\d{2})?/g;
const PHONE = /\(?555\)?[ -]010-\d{4}/g;
const ADDRESS =
  /\b\d{1,5} [A-Z][a-z]+(?: [A-Z][a-z]+)? (?:St|Ave|Ln|Rd|Blvd|Dr|Way|Ct|Street|Avenue|Lane|Road)\b/g;

/** The sample values in a text, outside its slots. */
export function leftovers(text: string, table: SampleTable): Leftover[] {
  const outside = text.replace(BRACES, "\u0000");
  const found: Leftover[] = [];
  const take = (kind: LeftoverKind, pattern: RegExp): void => {
    for (const m of outside.matchAll(pattern)) found.push({ kind, match: m[0] });
  };
  take("name", new RegExp(table.nameRe.source, "gu"));
  take("date", DATE);
  take("time", TIME);
  for (const m of outside.matchAll(AMOUNT))
    if (!FEE_TERMS.includes(m[0])) found.push({ kind: "amount", match: m[0] });
  take("phone", PHONE);
  take("address", ADDRESS);
  for (const code of table.codes)
    for (const m of outside.matchAll(new RegExp(`(?<![\\d$])${code}(?!\\d)`, "g")))
      found.push({ kind: "code", match: m[0] });
  return found;
}

function stepLines(step: AppliedStep, out: Line[]): void {
  const take = (holder: unknown, key: string, label: string): void => {
    if (typeof holder !== "object" || holder === null) return;
    const list = (holder as Record<string, unknown>)[key];
    if (!Array.isArray(list)) return;
    (list as unknown[]).forEach((message, k) => {
      if (!Array.isArray(message)) return;
      for (const text of leaves((message as unknown[]).slice(2)))
        out.push({ at: `${step.id} ${label}${String(k)}`, text });
    });
  };
  take(step, "say", "say");
  for (const [key, patch] of Object.entries(step.vary ?? {})) {
    take(patch, "say", `vary ${key} say`);
    take(patch, "addSay", `vary ${key} addSay`);
    const swap = (patch as { swap?: unknown } | null)?.swap;
    if (Array.isArray(swap))
      for (const text of leaves(swap)) out.push({ at: `${step.id} vary ${key} swap`, text });
  }
}

function layerLineTexts(layer: LayerLine, at: string, out: Line[]): void {
  out.push({ at, text: layer.line });
  for (const [reach, text] of Object.entries(layer.way ?? {})) out.push({ at: `${at} way ${reach}`, text });
}

/**
 * Every message string of a flow: each step's `say`, each variant's `say`, `addSay` and swap words, the layer lines
 * code adds to messages (the flow's and each step's copy), branch steps too.
 */
export function flowLines(flow: AppliedFlow): Line[] {
  const out: Line[] = [];
  eachStep(flow.steps, (step) => {
    stepLines(step, out);
    for (const layer of step.layerAdd ?? []) layerLineTexts(layer, `${step.id} layerAdd ${layer.id}`, out);
  });
  for (const layer of flow.layerLines) layerLineTexts(layer, `layerLines ${layer.id}`, out);
  return out;
}

/** The record's rows of every slot (what `{{pay.cancel}}` and the others say once filled). */
export function recordLines(flow: AppliedFlow): Line[] {
  const out: Line[] = [];
  for (const [name, slot] of Object.entries(flow.record.slots))
    slot.rows.forEach((row, k) => out.push({ at: `record ${name} row ${String(k + 1)}`, text: row.text }));
  return out;
}

const indexes = new WeakMap<AppliedFlow, Map<string, AppliedStep>>();

/** The steps of a flow by id, the first one in page order for an id used twice (as stepOf finds it). */
function stepIndex(flow: AppliedFlow): Map<string, AppliedStep> {
  const known = indexes.get(flow);
  if (known !== undefined) return known;
  const index = new Map<string, AppliedStep>();
  eachStep(flow.steps, (step) => {
    if (!index.has(step.id)) index.set(step.id, step);
  });
  indexes.set(flow, index);
  return index;
}

/**
 * The message strings one path shows, read from the SLOTTED flow: for each step the path lights (the walk, made on the
 * unslotted flow), the step's own `say` and, of each variant the walk picked (`keys`), its `say` and `addSay`. A variant
 * that replaces `say` leaves the base lines out of what the path shows; the base lines are still read here, so the
 * set is a little wider than the path's, never narrower. Record rows are `recordLines`.
 */
export function pathLines(slotted: AppliedFlow, walk: PathWalk): Line[] {
  const out: Line[] = [];
  const seen = new Set<string>();
  const index = stepIndex(slotted);
  for (const lit of walk.steps) {
    const step = index.get(lit.id);
    if (step === undefined) continue;
    const slice: AppliedStep = { ...step };
    if (step.vary !== undefined) {
      const picked: Record<string, unknown> = {};
      for (const key of lit.keys) if (key in step.vary) picked[key] = step.vary[key];
      slice.vary = picked;
    }
    const lines: Line[] = [];
    stepLines(slice, lines);
    for (const line of lines) {
      const id = `${line.at}\u0000${line.text}`;
      if (!seen.has(id)) {
        seen.add(id);
        out.push(line);
      }
    }
  }
  return out;
}

/** Throws UnknownSlotError, HoldSlotError or MalformedSlotError for the first line that names a slot outside K-03 v1. */
export function checkLines(lines: readonly Line[], names?: readonly string[]): void {
  for (const line of lines) checkSlotNames(line.text, line.at, names);
}

/** The slot names written in lines, each with how many times. */
export function slotCounts(lines: readonly Line[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of lines)
    for (const m of line.text.matchAll(BRACES)) {
      const name = /^\{\{\s*([a-z][a-z0-9.]*)/.exec(m[0])?.[1] ?? "";
      out.set(name, (out.get(name) ?? 0) + 1);
    }
  return out;
}
