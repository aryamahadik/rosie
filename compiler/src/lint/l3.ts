// L3, pointer lines (T-153; lib.js lintSteps lines 1944-1953; pointerLine, lines 1823-1844).
//
// A step no longer carries a line that only points to a home ("Clocks: S13-35."): the build lists what a step follows
// (its `reads`). The record's lint list `pointers` holds the patterns of such lines. A `more` line of a step in sections
// 3 to 12 (a variant's `more` and `addMore` too; the home steps aside) is read sentence by sentence:
//
//   - every sentence a pointer: the line is "bare", an error: delete it;
//   - pointers beside the step's own words ("... judgment rules 16 to 24. Safe default here: X."): "mixed", a warning:
//     keep the own words ("Safe default: X.") and drop the pointer words, never the whole line;
//   - a pointer pattern inside a sentence of the step's own: "partial", a warning: drop only the pointer words.
//
// A sentence is a pointer only when a pattern matches it and nothing of its own is left once the match, its label
// ("Clocks:"), step ids and "(judgment rules ...)" are taken out; a sentence with a Safe default, a Never, a Silence, a
// Means or a Clock is never one (DESIGN-REVIEW-10 M1). L2 and L4 read the same lines through pointerLine(): a bare line
// is L3's alone, and of a mixed line they read only the words it keeps.
import type { CompiledRecord } from "../record";
import { isRecord, type LintContext, type LintHit, type LintRule, type LintStep } from "./runner";

/** What a line is to the pointer patterns. */
export type PointerLine =
  { kind: "none" } | { kind: "partial" } | { kind: "bare" } | { kind: "mixed"; keep: string };

const NONE: PointerLine = { kind: "none" };

/** Words that make a sentence the step's own rule (lib.js OWN_RULE). */
const OWN_RULE = /\b(?:safe default|never|silence|means|clock)\b/i;

/** The record's pointer patterns (record.lint.pointers), case aside; a pattern that does not read is left out. */
export function pointerPatterns(record: CompiledRecord): RegExp[] {
  const list = record.lint.pointers;
  const out: RegExp[] = [];
  for (const source of Array.isArray(list) ? (list as unknown[]) : []) {
    if (typeof source !== "string") continue;
    try {
      out.push(new RegExp(source, "i"));
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

/** Is this sentence a pointer and nothing else? (lib.js pointerSentence) */
function pointerSentence(sentence: string, pointers: readonly RegExp[]): boolean {
  if (OWN_RULE.test(sentence)) return false;
  let hit = false;
  let rest = sentence;
  for (const pattern of pointers) {
    if (!pattern.test(sentence)) continue;
    hit = true;
    rest = rest.replace(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`), " ");
  }
  if (!hit) return false;
  rest = rest
    .replace(/\([^()]*\)/g, " ")
    .replace(/\b[SAB]\d+-\d{2,3}\b/g, " ")
    .replace(/\bjudgment rules? \d+(?:(?:,| to| and) \d+)*/gi, " ")
    .replace(/^[^:]{0,80}:/, " ");
  return !/[A-Za-z0-9]/.test(rest);
}

/** What a line is to the pointer patterns: bare, mixed (with the words to keep), partial or none (lib.js pointerLine). */
export function pointerLine(text: unknown, pointers: readonly RegExp[]): PointerLine {
  if (typeof text !== "string" || pointers.length === 0) return NONE;
  const sentences = lineSentences(text);
  const pointer = sentences.map((sentence) => pointerSentence(sentence, pointers));
  if (!pointer.some(Boolean))
    return pointers.some((pattern) => pattern.test(text)) ? { kind: "partial" } : NONE;
  if (pointer.every(Boolean)) return { kind: "bare" };
  return {
    kind: "mixed",
    keep: sentences
      .filter((_, k) => !pointer[k])
      .join(" ")
      .replace(/\bSafe default here:/g, "Safe default:")
      .trim(),
  };
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/**
 * The lines L3 and L4 read on a step: its `more` lines (`more 1` ...), then each variant's `more` and `addMore` lines
 * (`vary 'pf:sensitive' more 1` ...), as lintSteps lists them (line 1946).
 */
export function moreLines(step: LintStep): [field: string, text: unknown][] {
  const lines: [string, unknown][] = list(step.more).map((text, k) => [`more ${String(k + 1)}`, text]);
  const vary = isRecord(step.vary) ? step.vary : {};
  for (const [key, patch] of Object.entries(vary)) {
    const words = isRecord(patch) ? patch : {};
    list(words.more)
      .concat(list(words.addMore))
      .forEach((text, k) => lines.push([`vary '${key}' more ${String(k + 1)}`, text]));
  }
  return lines;
}

/** L3: a more line that only points to a home. */
export const l3: LintRule = {
  id: "L3",
  name: "pointer line",
  source: "lib.js lintSteps lines 1944-1953, pointerLine lines 1823-1844; record.lint.pointers",
  run(ctx: LintContext): LintHit[] {
    const pointers = pointerPatterns(ctx.record);
    const hits: LintHit[] = [];
    for (const step of ctx.pageOrder) {
      const place = ctx.place(step);
      if (place.section < 3 || place.section > 12 || place.home) continue;
      for (const [field, text] of moreLines(step)) {
        const line = pointerLine(text, pointers);
        if (line.kind === "none" || typeof text !== "string") continue;
        const at = { rule: "L3", step: step.id, field, text };
        if (line.kind === "bare")
          hits.push({
            ...at,
            level: "error",
            fix: "delete it: the build lists what a step follows (reads)",
          });
        else if (line.kind === "mixed")
          hits.push({
            ...at,
            level: "warning",
            fix: `keep it as '${line.keep}' and drop the pointer words (never delete the line: it holds this step's own words)`,
          });
        else
          hits.push({
            ...at,
            level: "warning",
            fix: "keep this step's own words and drop only the pointer words in it",
          });
      }
    }
    return hits;
  },
};
