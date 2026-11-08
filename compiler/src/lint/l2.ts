// L2, record phrases outside a slot (T-153; lib.js lintSteps lines 1929-1943; recordPhrases lines 1764-1782, lintWords
// lines 1811-1822).
//
// The record's words belong in its slots: a step that writes out "Nothing taken, no card saved" instead of {{pay.took}}
// says the record's words where the record cannot change them for the booking. A record phrase is
//   - a row of a record slot with 4 words or more of its own (its slots stand for any 1 to 3 words, or a slot), or
//   - one of the record's lint phrases (record.lint.phrases: money, contact, proof, stop), owned by that home.
// Read on every step of sections 3 to 12 but the homes: its notes (does, more, rule), the messages Rosie, the owner and
// staff send (their text and their elements' words: card lines, buttons ...), its form, and each variant's the same way
// (a variant keyed on a record value is L1's, not read here). One hit a field, for the first phrase it holds; a bare
// pointer line is L3's, and of a mixed one only the words it keeps are read. A hit is an error in the zone from section
// 5 on (after the money step), a warning before.
//
// The record's rows are written with the flow's sample names; the flow files have them filled in already (lib.js
// recordFor), and any cast slot left is filled by the vendored castText, never a copy.
import { loadPathScripts } from "../path/core";
import type { CompiledRecord } from "../record";
import { recordKeyParts } from "./l1";
import { pointerLine, pointerPatterns, type PointerLine } from "./l3";
import { isRecord, unq, type LintContext, type LintHit, type LintRule, type LintStep } from "./runner";

/** One record phrase: its pattern, the slot it is a row of (null for a lint phrase), the home it belongs to, and which. */
interface Phrase {
  re: RegExp;
  slot: string | null;
  home: string;
  how: string;
}

/** The vendored cast filler (lib.js castText): cast slots and {{ab:A words|B words}} for a flow. */
interface CastText {
  castText(
    text: string,
    names: Readonly<Record<string, string>>,
    flow: string,
    problems: string[],
    where: string,
  ): string;
}

/** A slot or 1 to 3 words: what a slot in a row's words may stand for (lib.js SLOT_ANY). */
const SLOT_ANY = "(?:\\{\\{[^{}]*\\}\\}|\\S+(?: \\S+){0,2})";

/** Element keys whose values are not words (lib.js CAST_SKIP). */
const NOT_WORDS: ReadonlySet<string> = new Set(["link", "code", "photoLink"]);

/** The senders whose messages L2 reads: Rosie, the owner, staff (lib.js L2_SENDERS). */
const SENDERS: readonly unknown[] = ["san", "owner", "staff"];

/** A `more` field, a step's or a variant's: only these can be pointer lines. */
const MORE_FIELD = /^(vary '[^']*' )?more \d+$/;

const NONE: PointerLine = { kind: "none" };

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The words of a text, as the master's word scores count them (lib.js clean and words, lines 480-482). */
function wordCount(text: string): number {
  return text
    .replace(/santiago\.app\/\S+/g, "link")
    .replace(/\b\d{1,2}(:\d\d)?\s?(am|pm)\b/gi, "time")
    .replace(/[–—]/g, " to ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => /[a-z0-9]/i.test(word)).length;
}

/** The home a slot belongs to by its prefix: pay.* and two.* money, reach.* contact (lib.js slotHomeKey). */
function slotHomeKey(name: string): string {
  const head = name.split(".")[0] ?? "";
  if (head === "pay" || head === "two") return "money";
  return head === "reach" ? "contact" : head;
}

/** The record's phrases for one flow, in the record's order: each slot's rows, then the lint phrases (lib.js recordPhrases). */
export function recordPhrases(
  record: CompiledRecord,
  flow: string,
  names: Readonly<Record<string, string>>,
): Phrase[] {
  const cast = loadPathScripts().lib as unknown as CastText;
  const homes = record.homes as Readonly<Record<string, string | undefined>>;
  const out: Phrase[] = [];
  for (const [name, slot] of Object.entries(record.slots)) {
    const own = homes[slotHomeKey(name)];
    const home = slot.home !== "" ? slot.home : own !== undefined && own !== "" ? own : "";
    slot.rows.forEach((row, k) => {
      const text = unq(cast.castText(row.text, names, flow, [], ""))
        .trim()
        .replace(/\s+/g, " ");
      const bits = text.split(/(\{\{[^{}]*\}\})/);
      if (wordCount(bits.filter((_, j) => j % 2 === 0).join(" ")) < 4) return;
      const source = bits
        .map((bit, j) => (j % 2 === 1 ? SLOT_ANY : escape(bit).replace(/ /g, "\\s+")))
        .join("");
      try {
        out.push({
          re: new RegExp(`(?:^|[^A-Za-z0-9])${source}(?![A-Za-z0-9])`, "i"),
          slot: name,
          home,
          how: `row ${String(k + 1)} of {{${name}}}`,
        });
      } catch {
        // A row that does not make a pattern: the record's own check reports it (lib.js recordLintProblems).
      }
    });
  }
  for (const [key, patterns] of Object.entries(record.lint.phrases)) {
    const own = homes[key];
    for (const source of Array.isArray(patterns) ? (patterns as unknown[]) : []) {
      if (typeof source !== "string") continue;
      try {
        out.push({
          re: new RegExp(source, "im"),
          slot: null,
          home: own !== undefined && own !== "" ? own : key,
          how: `the ${key} phrase /${source}/`,
        });
      } catch {
        // As above: reported by the record's own check.
      }
    }
  }
  return out;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** The fields L2 reads on a step or on a variant (a variant adds lines and messages with addMore and addSay). */
interface Words {
  readonly does?: unknown;
  readonly more?: unknown;
  readonly addMore?: unknown;
  readonly rule?: unknown;
  readonly say?: unknown;
  readonly addSay?: unknown;
  readonly form?: unknown;
}

/**
 * The words L2 reads on a step or a variant (lib.js lintWords): `does`, each `more` and `addMore` line, `rule`, each
 * message from Rosie, the owner or staff (its text, and its elements' words as `message N card`), and the form.
 */
function lintWords(words: Words, pre: string): [field: string, text: string][] {
  const out: [string, string][] = [];
  const deep = (field: string, value: unknown): void => {
    if (typeof value === "string") out.push([field, value]);
    else if (Array.isArray(value)) for (const item of value as unknown[]) deep(field, item);
    else if (isRecord(value))
      for (const [key, item] of Object.entries(value)) if (!NOT_WORDS.has(key)) deep(field, item);
  };
  if (typeof words.does === "string") out.push([`${pre}does`, words.does]);
  list(words.more)
    .concat(list(words.addMore))
    .forEach((line, k) => {
      if (typeof line === "string") out.push([`${pre}more ${String(k + 1)}`, line]);
    });
  if (typeof words.rule === "string") out.push([`${pre}rule`, words.rule]);
  list(words.say)
    .concat(list(words.addSay))
    .forEach((message, k) => {
      if (!Array.isArray(message) || !SENDERS.includes(message[0])) return;
      const [, , text, elements] = message as unknown[];
      if (typeof text === "string") out.push([`${pre}message ${String(k + 1)}`, text]);
      if (elements) deep(`${pre}message ${String(k + 1)} card`, elements);
    });
  if (words.form) deep(`${pre}form`, words.form);
  return out;
}

/** A step's own words and those of each variant not keyed on a record value. */
function stepWords(step: LintStep): [field: string, text: string][] {
  const words = lintWords(step, "");
  const vary = isRecord(step.vary) ? step.vary : {};
  for (const [key, patch] of Object.entries(vary)) {
    if (recordKeyParts(key).length > 0) continue;
    words.push(...lintWords(isRecord(patch) ? patch : {}, `vary '${key}' `));
  }
  return words;
}

/** L2: the record's words written out where a slot belongs. */
export const l2: LintRule = {
  id: "L2",
  name: "record phrase",
  source: "lib.js lintSteps lines 1929-1943, recordPhrases lines 1764-1782, lintWords lines 1811-1822",
  run(ctx: LintContext): LintHit[] {
    const phrases = recordPhrases(ctx.record, ctx.flow, ctx.names);
    const pointers = pointerPatterns(ctx.record);
    const hits: LintHit[] = [];
    for (const step of ctx.pageOrder) {
      const place = ctx.place(step);
      if (place.home || place.section < 3 || place.section > 12) continue;
      const level = place.zone && place.section >= 5 ? "error" : "warning";
      const seen = new Set<string>();
      for (const [field, text] of stepWords(step)) {
        if (seen.has(field)) continue;
        const line = MORE_FIELD.test(field) ? pointerLine(text, pointers) : NONE;
        if (line.kind === "bare") continue;
        const read = unq(line.kind === "mixed" ? line.keep : text);
        const phrase = phrases.find((candidate) => candidate.re.test(read));
        if (phrase === undefined) continue;
        seen.add(field);
        hits.push({
          rule: "L2",
          level,
          step: step.id,
          field,
          text,
          fix: `this is ${phrase.home !== "" ? phrase.home : "the record"}'s rule (${phrase.how}): ${phrase.slot === null ? "use a record slot" : `use {{${phrase.slot}}}`} / delete the line`,
        });
      }
    }
    return hits;
  },
};
