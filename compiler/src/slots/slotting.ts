// Sample-value slotting (T-142; C-062; Master Corrections C6; arch 12 line 592).
//
// "Every sample name, date, time, price and place in message lines becomes a slot, except Rosie's own fee terms" (arch 12).
// slotText() turns the sample values in a text into slots from K-03 v1's vocabulary:
//
//   a business name (Lee's Barbershop, or a trade's own)  -> {{biz.name}}
//   the owner (Sam, Sam Lee)                              -> {{owner.name}}
//   a pro (Riley, Iris)                                   -> {{pro.name}}
//   the main customer (Alex, Alex M., A.M.)               -> {{alex.staff}}
//   another person of the cast (Pat, Ben, Dee)            -> {{name.staff}}
//   a street, address or town                             -> {{visit.place}}
//   a phone number                                        -> {{biz.phone}}
//   a check-in code                                       -> {{visit.code}}
//   a day (Sat Oct 24, Nov 2)                             -> {{day}}
//   a clock time (11:00am)                                -> {{visit.time}}
//   an arrival (arriving 8-10am, starts at 9:00am)        -> {{arrive}}; a bare window (8-10am) -> {{window}}
//   a deadline (by 9:00am Sat, Thu 11:20am)               -> {{ask.by}}
//   a date and time range (Thu Oct 29, 2-5pm)             -> {{change.when}}
//   an amount in the amount table                         -> {{price}} {{fee}} {{deposit}} {{rest}} {{paid}}
//   any other amount                                      -> {{change.price}}
//
// A sample never stays in a line as example words (`{{biz.name}}`, not `{{biz.name:Lee's Barbershop}}`): C6 says
// they are illustrations, never live values. What stays literal: a slot the line already holds (record slots such as
// `{{pay.cancel}}`, amount slots such as `{{price:$90}}`, `{{svc.intext:Haircut}}`: never slotted again, T-137), and
// Rosie's own fee terms: `$2` a booking, the `$49` cap and the `1%` on a plan billed monthly (C6; S1-25, S1-29, A9-21).
//
// The words of a line are never written here: only the sample values in them are found and replaced (rule 3).
import type { LayerLine } from "../graph/types.ts";
import type { AppliedFlow, AppliedStep, AppliedTrade } from "../overlay/apply";
import type { AmountField, SampleTable } from "./samples";
import { BRACES, writeSlot } from "./vocabulary";

/** Rosie's own fee terms: they stay literal wherever a line states them (C6; S1-25, S1-29, A9-21). */
export const FEE_TERMS: readonly string[] = ["$2", "$49", "1%"];

const FEE_TERM_PATTERNS: Record<string, RegExp> = {
  $2: /\$2(?![\d.]?\d|,\d)/g,
  $49: /\$49(?![\d.]?\d|,\d)/g,
  "1%": /(?<![\d.])1%/g,
};

/** How often each fee term stands in a text outside its slots (`$20` and `$2,400` are not `$2`; `11%` is not `1%`). */
export function countFeeTerms(text: string): Record<string, number> {
  const outside = text.replace(BRACES, "\u0000");
  const out: Record<string, number> = {};
  for (const term of FEE_TERMS) out[term] = [...outside.matchAll(FEE_TERM_PATTERNS[term] ?? /$^/g)].length;
  return out;
}

const WD = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const MON =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const TIME = "\\d{1,2}(?::\\d\\d)?\\s?(?:am|pm|AM|PM)\\b";
const RANGE = "\\d{1,2}(?::\\d\\d)?\\s?(?:am|pm)?\\s?[–-]\\s?\\d{1,2}(?::\\d\\d)?\\s?(?:am|pm)\\b";
const MONTH_DAY = `${MON} \\d{1,2}(?:, 20\\d\\d)?\\b`;
const DATE = `(?:${WD},? )?${MONTH_DAY}`;

/** The sample phone numbers: the reserved fiction range 555-010-xxxx. A hotline or an emergency number is a real one and stays. */
const PHONE = /(?:\(555\) |\b555-)010-\d{4}/g;
const ADDRESS = /\b\d{1,5} (?:[A-Z][a-z]+ ){1,2}(?:St|Ave|Ln|Rd|Blvd|Dr|Way|Ct|Street|Avenue|Lane|Road)\b/g;
const CHANGE_WHEN = new RegExp(`\\b${DATE},\\s?${RANGE}`, "g");
const ARRIVE = new RegExp(`\\barriving ${RANGE}|\\bstarts at ${TIME}`, "g");
const WINDOW_WORDS = /\bbetween \d{1,2} and \d{1,2}\s?(?:am|pm)\b/g;
const WINDOW = new RegExp(`\\b${RANGE}`, "g");
const DEADLINE_AFTER = new RegExp(
  `\\b(by|before|until) (${TIME}(?: ${DATE}| (?:${WD}|today|tomorrow))?|${DATE}(?:,? ${TIME})?|${WD}(?:,? ${TIME})?)`,
  "g",
);
const DEADLINE = new RegExp(`\\b${WD} ${TIME}|\\b${TIME} (?:${WD}|today|tomorrow)\\b`, "g");
const DAY = new RegExp(`\\b${DATE}|\\b${MON} 20\\d\\d\\b`, "g");
const CLOCK = new RegExp(`\\b${TIME}`, "g");
const AMOUNT = /\$\d+(?:,\d{3})*(?:\.\d{2})?/g;
const FOUR_DIGITS = /(?<![\d$])\d{4}(?!\d)/g;

/** Keys of a message's elements whose strings are not words (links, flags). */
const SKIP_KEYS: ReadonlySet<string> = new Set([
  "link",
  "photoLink",
  "lang",
  "stop",
  "pick",
  "numbers",
  "plain",
  "letters",
]);

const PLACEHOLDER_BASE = 0xe100;
const PLACEHOLDER = new RegExp("[\\ue100-\\uf8ff]", "g");

/** The field an amount stands for in its neighbouring words (the two words each side), or null. */
function amountHint(before: string, after: string): AmountField | null {
  const near = `${before} ${after}`.toLowerCase();
  if (near.includes("deposit")) return "deposit";
  if (/\b(?:rest|remaining|balance|left)\b/.test(near)) return "rest";
  if (/\b(?:fee|no-show|no show|late[- ]cancel|missed|service[- ]call)\b/.test(near)) return "fee";
  if (/\b(?:paid|charged|took|taken|received)\b/.test(near)) return "paid";
  return null;
}

const FIELD_ORDER: readonly AmountField[] = ["price", "fee", "deposit", "rest", "paid"];

/** The slot of an amount: the table's field for it (a hint between two fields), else `change.price` (a price no table holds). */
function amountSlot(token: string, hint: AmountField | null, table: SampleTable): string {
  const fields = table.amounts.get(token);
  if (fields === undefined || fields.size === 0) return "change.price";
  if (hint !== null && fields.has(hint)) return hint;
  return FIELD_ORDER.find((field) => fields.has(field)) ?? "change.price";
}

function words(text: string, last: boolean): string {
  const list = text.split(/\s+/).filter((w) => w !== "");
  return (last ? list.slice(-2) : list.slice(0, 2)).join(" ");
}

/** Slots the sample values in a stretch of text that holds no slot. */
function slotGap(gap: string, table: SampleTable): string {
  const held: string[] = [];
  const hold = (slot: string): string => {
    held.push(writeSlot(slot));
    return String.fromCharCode(PLACEHOLDER_BASE + held.length - 1);
  };
  let text = gap;
  text = text.replace(PHONE, () => hold("biz.phone"));
  if (table.codes.size > 0)
    text = text.replace(FOUR_DIGITS, (m) => (table.codes.has(m) ? hold("visit.code") : m));
  const town =
    table.towns.length === 0
      ? ""
      : `(?:, (?:${table.towns.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b)?`;
  text = text.replace(new RegExp(`${ADDRESS.source}${town}`, "g"), () => hold("visit.place"));
  text = text.replace(CHANGE_WHEN, () => hold("change.when"));
  text = text.replace(ARRIVE, () => hold("arrive"));
  text = text.replace(WINDOW_WORDS, () => `between ${hold("window")}`);
  text = text.replace(WINDOW, (m) => (/^\d{1,2}(?::\d\d)?\s?(?:am|pm)/.test(m) ? m : hold("window")));
  text = text.replace(DEADLINE_AFTER, (_m, prefix: string) => `${prefix} ${hold("ask.by")}`);
  text = text.replace(DEADLINE, () => hold("ask.by"));
  text = text.replace(DAY, () => hold("day"));
  text = text.replace(CLOCK, () => hold("visit.time"));
  text = text.replace(AMOUNT, (token, offset: number) => {
    if (FEE_TERMS.includes(token)) return token;
    const hint = amountHint(
      words(text.slice(0, offset), true),
      words(text.slice(offset + token.length), false),
    );
    return hold(amountSlot(token, hint, table));
  });
  // Names last: a pro called Jun must not take the month of `Jun 5`.
  text = text.replace(table.nameRe, (m) => hold(table.slotOf.get(m) ?? "name.staff"));
  return text.replace(PLACEHOLDER, (c) => held[c.charCodeAt(0) - PLACEHOLDER_BASE] ?? "");
}

/**
 * The text with its sample values turned into slots. A `{{...}}` already in the text is left exactly as it is, and so are
 * Rosie's fee terms ($2, $49, 1%).
 */
export function slotText(text: string, table: SampleTable): string {
  if (!/[A-Z0-9$]/.test(text)) return text;
  let out = "";
  let at = 0;
  for (const m of text.matchAll(BRACES)) {
    out += slotGap(text.slice(at, m.index), table) + m[0];
    at = m.index + m[0].length;
  }
  return out + slotGap(text.slice(at), table);
}

function isCode(value: string): boolean {
  return /^\d{3,8}$/.test(value.trim());
}

/** Slots every string of a message's elements (card, buttons, list rows, times, forms ...): not links or flags. */
function slotDeep(value: unknown, table: SampleTable, key: string | null): unknown {
  if (typeof value === "string") {
    if (key === "code" && isCode(value)) return writeSlot("visit.code");
    return slotText(value, table);
  }
  if (Array.isArray(value)) return (value as unknown[]).map((item) => slotDeep(item, table, key));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SKIP_KEYS.has(k) ? v : slotDeep(v, table, k);
    return out;
  }
  return value;
}

/** One message `[from, to, text, elements?]` or `[from, to, elements]`, its words and elements slotted. */
export function slotMessage<M extends readonly unknown[]>(message: M, table: SampleTable): M {
  return message.map((part, k) => (k < 2 ? part : slotDeep(part, table, null))) as unknown as M;
}

/** Every string leaf of a value (links and flags left out), for the walks that read what a message says. */
export function leaves(value: unknown, out: string[] = [], key: string | null = null): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value as unknown[]) leaves(item, out, key);
  else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) if (!SKIP_KEYS.has(k)) leaves(v, out, k);
  }
  return out;
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The message lists of a step: `say`, and `say` and `addSay` of each variant. */
function messageLists(step: AppliedStep): { holder: Obj; key: string }[] {
  const out: { holder: Obj; key: string }[] = [];
  if (Array.isArray(step.say)) out.push({ holder: step, key: "say" });
  if (isObj(step.vary)) {
    for (const patch of Object.values(step.vary)) {
      if (!isObj(patch)) continue;
      for (const key of ["say", "addSay"]) if (Array.isArray(patch[key])) out.push({ holder: patch, key });
    }
  }
  return out;
}

/** Calls `fn` on each step and, below it, each step of each branch. */
export function eachStep(steps: readonly AppliedStep[], fn: (step: AppliedStep) => void): void {
  for (const step of steps) {
    fn(step);
    for (const branch of step.branches ?? []) eachStep(branch.steps, fn);
  }
}

/** Collects the check-in codes the elements of the flow carry, so a code written in a line is slotted too. */
function collectCodes(flow: AppliedFlow, table: SampleTable): void {
  eachStep(flow.steps, (step) => {
    for (const { holder, key } of messageLists(step)) {
      const list = holder[key] as unknown[];
      for (const message of list) {
        if (!Array.isArray(message)) continue;
        for (const part of (message as unknown[]).slice(2)) {
          if (isObj(part) && typeof part.code === "string" && isCode(part.code))
            table.codes.add(part.code.trim());
        }
      }
    }
  });
}

/** An applied flow with the sample values in its message lines slotted: `say` and `addSay` of every step and variant, swaps, and the record's rows. */
export function slotFlow(flow: AppliedFlow, table: SampleTable): AppliedFlow {
  const out = structuredClone(flow);
  collectCodes(out, table);
  eachStep(out.steps, (step) => {
    for (const { holder, key } of messageLists(step)) {
      holder[key] = (holder[key] as unknown[]).map((message) =>
        Array.isArray(message) ? slotMessage(message as unknown[], table) : message,
      );
    }
    if (isObj(step.vary)) {
      for (const patch of Object.values(step.vary)) {
        if (!isObj(patch) || !Array.isArray(patch.swap)) continue;
        patch.swap = (patch.swap as unknown[]).map((pair) =>
          Array.isArray(pair) ? (pair as unknown[]).map((side) => slotDeep(side, table, null)) : pair,
        );
      }
    }
    for (const layer of step.layerAdd ?? []) slotLayerLine(layer, table);
  });
  for (const layer of out.layerLines) slotLayerLine(layer, table);
  for (const slot of Object.values(out.record.slots)) {
    for (const row of slot.rows) row.text = slotText(row.text, table);
  }
  return out;
}

/** A layer line (the master's `private`, `textsonly` ... lines code adds to Rosie's messages): its words and its `way` words. */
function slotLayerLine(layer: LayerLine, table: SampleTable): void {
  layer.line = slotText(layer.line, table);
  if (layer.way !== undefined) {
    for (const [reach, words] of Object.entries(layer.way)) layer.way[reach] = slotText(words, table);
  }
}

/** The result of slotting an applied trade: the flow with its sample values slotted, and the table that did it. */
export interface SlottedTrade {
  applied: AppliedTrade;
  table: SampleTable;
}

/** Slots one applied trade (applyTrade's result) with its sample table. Nothing the caller passes in is changed. */
export function slotApplied(applied: AppliedTrade, table: SampleTable): SlottedTrade {
  return { applied: { ...applied, flow: slotFlow(applied.flow, table) }, table };
}
