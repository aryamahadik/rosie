// L8, banned old-rule phrases (T-154; lib.js lintSteps lines 1925-1926; bannedList, bannedFix and stepLines, lines
// 1854-1890; TOOL-SPEC change 23 a; DESIGN-REVIEW-10 W1).
//
// The redesign changed some rules, and the record keeps the old rules' words as patterns (record.lint.banned.phrases:
// a pattern, or { "re": pattern, "now": the rule that replaced it }), read in any case. L8 reads every line of every
// step in the flow: its title, does, rule, question and `as`; each more line; each message, from any sender, with its
// element's words (card lines, buttons ...); its form, table, plug-in slot and swaps; each variant's the same way; each
// branch's label and endText. A line holding an old rule's words is an error, one hit a line and pattern. The fix:
//   - when the old words are only part of the line (another sentence holds none of the patterns, or the line carries
//     the step's own rule: a Means, Never, Silence, Safe default or Clock), remove only those words and keep the rest,
//     with the rule now when the record names it;
//   - when every sentence is old words: "the rule now: ...; write that, or delete the line" (with no `now`, write
//     today's rule from its home).
import type { CompiledRecord } from "../record";
import { isRecord, unq, type LintContext, type LintHit, type LintRule, type LintStep } from "./runner";

/** One old rule's pattern: the pattern, its source text, and the rule that replaced it (null when the record names none). */
export interface Banned {
  readonly re: RegExp;
  readonly src: string;
  readonly now: string | null;
}

/** Words that make a line hold the step's own rule (lib.js OWN_RULE). */
const OWN_RULE = /\b(?:safe default|never|silence|means|clock)\b/i;

/** Element keys whose values are not words (lib.js CAST_SKIP). */
const NOT_WORDS: ReadonlySet<string> = new Set(["link", "code", "photoLink"]);

/** The record's old-rule patterns, in its order; a pattern that does not read is left out (lib.js bannedList). */
export function bannedList(record: CompiledRecord): Banned[] {
  const banned = record.lint.banned;
  const phrases = isRecord(banned) && Array.isArray(banned.phrases) ? (banned.phrases as unknown[]) : [];
  const out: Banned[] = [];
  for (const entry of phrases) {
    const src =
      typeof entry === "string" ? entry : isRecord(entry) && typeof entry.re === "string" ? entry.re : "";
    const now = isRecord(entry) && typeof entry.now === "string" && entry.now !== "" ? entry.now : null;
    if (src === "") continue;
    try {
      out.push({ re: new RegExp(src, "i"), src, now });
    } catch {
      // A pattern that does not read: the record's own check reports it (lib.js recordLintProblems).
    }
  }
  return out;
}

/** A line cut into sentences: at . ! or ? before a capital, a quote or a bracket (lib.js lineSentences). */
function lineSentences(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z"'(])/)
    .filter((sentence) => sentence.trim() !== "");
}

/** What to do about the old words `words` that `banned` found in `text` (lib.js bannedFix). */
export function bannedFix(text: string, words: string, banned: Banned, all: readonly Banned[]): string {
  const clean = lineSentences(unq(text)).some((sentence) => !all.some((other) => other.re.test(sentence)));
  const head = `an old rule's words, '${words}' (/${banned.src}/): `;
  if (clean || OWN_RULE.test(text))
    return `${head}remove only these words: '${words}'; keep the rest of the line (its other words are this step's own)${banned.now === null ? "" : `; the rule now: ${banned.now}`}`;
  return (
    head +
    (banned.now === null
      ? "the redesign changed this rule (record.json lint.banned, TOOL-SPEC 23): write today's rule from its home, or delete the line"
      : `the rule now: ${banned.now}; write that, or delete the line`)
  );
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** The fields L8 reads on a step, a variant or a part's per-flow words (a variant adds lines with addMore and addSay). */
interface Lines {
  readonly title?: unknown;
  readonly does?: unknown;
  readonly rule?: unknown;
  readonly q?: unknown;
  readonly as?: unknown;
  readonly more?: unknown;
  readonly addMore?: unknown;
  readonly say?: unknown;
  readonly addSay?: unknown;
  readonly form?: unknown;
  readonly table?: unknown;
  readonly slot?: unknown;
  readonly swap?: unknown;
}

/** Every line of a step, with where it is: `does`, `more 2`, `message 1 card`, `vary 'pf:sensitive' more 1` ... (lib.js stepLines). */
export function stepLines(step: LintStep): [field: string, text: string][] {
  const out: [string, string][] = [];
  const deep = (field: string, value: unknown): void => {
    if (typeof value === "string") out.push([field, value]);
    else if (Array.isArray(value)) for (const item of value as unknown[]) deep(field, item);
    else if (isRecord(value))
      for (const [key, item] of Object.entries(value)) if (!NOT_WORDS.has(key)) deep(field, item);
  };
  const words = (o: Lines, pre: string): void => {
    const own: [string, unknown][] = [
      ["title", o.title],
      ["does", o.does],
      ["rule", o.rule],
      ["q", o.q],
      ["as", o.as],
    ];
    for (const [key, text] of own) if (typeof text === "string") out.push([pre + key, text]);
    list(o.more)
      .concat(list(o.addMore))
      .forEach((line, k) => {
        if (typeof line === "string") out.push([`${pre}more ${String(k + 1)}`, line]);
      });
    list(o.say)
      .concat(list(o.addSay))
      .forEach((message, k) => {
        if (!Array.isArray(message)) return;
        const [, , text, elements] = message as unknown[];
        if (typeof text === "string") out.push([`${pre}message ${String(k + 1)}`, text]);
        if (elements) deep(`${pre}message ${String(k + 1)} card`, elements);
      });
    const blocks: [string, unknown][] = [
      ["form", o.form],
      ["table", o.table],
      ["slot", o.slot],
      ["swap", o.swap],
    ];
    for (const [key, value] of blocks) if (value) deep(pre + key, value);
  };
  words(step, "");
  const vary = isRecord(step.vary) ? step.vary : {};
  for (const [key, patch] of Object.entries(vary)) if (isRecord(patch)) words(patch, `vary '${key}' `);
  // (a shared part's per-flow words: the join resolves them, so a joined flow has none)
  const inFlow = "inFlow" in step ? step.inFlow : undefined;
  if (isRecord(inFlow))
    for (const [flow, patch] of Object.entries(inFlow)) if (isRecord(patch)) words(patch, `inFlow.${flow} `);
  (step.branches ?? []).forEach((branch, k) => {
    out.push([`branch ${String(k + 1)} label`, branch.label]);
    if (typeof branch.endText === "string") out.push([`branch ${String(k + 1)} endText`, branch.endText]);
  });
  return out;
}

/** L8: a line that holds an old rule's words. */
export const l8: LintRule = {
  id: "L8",
  name: "banned old line",
  source:
    "lib.js lintSteps lines 1925-1926, bannedList, bannedFix and stepLines lines 1854-1890; record.lint.banned",
  run(ctx: LintContext): LintHit[] {
    const banned = bannedList(ctx.record);
    if (banned.length === 0) return [];
    const hits: LintHit[] = [];
    for (const step of ctx.pageOrder) {
      for (const [field, text] of stepLines(step)) {
        for (const entry of banned) {
          const found = entry.re.exec(unq(text));
          if (found === null) continue;
          hits.push({
            rule: "L8",
            level: "error",
            step: step.id,
            field,
            text,
            fix: bannedFix(text, found[0], entry, banned),
          });
        }
      }
    }
    return hits;
  },
};
