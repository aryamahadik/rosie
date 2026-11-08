// L4, a line restating a home (T-153; lib.js lintSteps lines 1954-1961; homeLines lines 1799-1810, lintNorm, lintToks
// and jaccard lines 1783-1798).
//
// A home step (record.homes: money S13-55, contact S13-19 ... the $2 at A9-21) holds a rule once. A step in sections
// 3 to 12 (the homes aside) whose `more` line, variant `more` or `addMore` line, or rule box says a home's line again is
// an error: delete it, or keep only the step's own part. "Says again" is read on words, not letters: both lines are
// evened out (the sample cast, businesses, places, services, amounts, days, dates, times and step ids made alike; the
// small words dropped), and a line of 8 words or more that shares at least 0.8 of its words with a home's line of 8 or
// more (Jaccard) restates it; the closest home line is named. A bare pointer line is L3's; of a mixed one, only the words
// it keeps are compared.
import { moreLines, pointerLine, pointerPatterns, type PointerLine } from "./l3";
import type { LintContext, LintHit, LintRule, LintStep } from "./runner";

/** One home line of 8 words or more: the home, its step, where on it, and its words. */
interface HomeLine {
  home: string;
  id: string;
  where: string;
  toks: ReadonlySet<string>;
}

const NONE: PointerLine = { kind: "none" };

// The evening-out of ripple parity's normalizer (lib.js lines 1783-1795), as written there.
const N_CAST =
  /\b(?:alex(?: m\.)?|a\.m\.|riley|avery|jordan|casey|kim|ben|dee|morgan|sam|pat|omar|owen|rose|lin|nora|hugo|dana)\b/g;
const N_BIZ =
  /\b(?:lee's barbershop|lee home services|the shop|the business|the barbershop|the salon|the plumber|the barber|the pro|staff)\b/g;
const N_PLACE =
  /\b(?:at the chair|at the counter|at the door|at the shop|at the home|at home|in the chair|the chair|the counter|the door|the home|the house|the shop's phone|the pro's phone)\b/g;
const N_SVC =
  /\b(?:haircut|skin fade|beard trim|kids cut|signature cut(?: and hot towel shave)?|groom's package|color(?: and cut| correction| touch-up)?|kitchen drain clearing|drain clearing|water heater(?: replacement| flush)?|leak repair|valves?|drain trap|cut)\b/g;

/** The small words left out of a line's words (lib.js LINT_STOP). */
const SMALL = new Set(
  "a an the and or of to in on at for by is are be it its it's this that with as if no not from then any each one their they them his her you your our we".split(
    " ",
  ),
);

/** A line evened out (lib.js lintNorm). */
function lintNorm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(N_CAST, "P")
    .replace(N_BIZ, "BIZ")
    .replace(N_PLACE, "PLACE")
    .replace(N_SVC, "SVC")
    .replace(/\$\d[\d,.]*/g, "$N")
    .replace(/\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/g, "DAY")
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}\b/g, "DATE")
    .replace(/\b\d{1,2}(?::\d\d)?\s?(?:am|pm)\b(?:\s?(?:–|-|to)\s?\d{1,2}(?::\d\d)?\s?(?:am|pm))?/g, "TIME")
    .replace(/\b[ab]\d{1,2}-\d{2,3}\b/g, "STEP")
    .replace(/[^a-z0-9$' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A line's words: evened out, two letters or more, the small words left out (lib.js lintToks). */
function lintToks(text: string): Set<string> {
  const words = lintNorm(text).split(" ");
  return new Set(words.filter((word) => word.length > 1 && !SMALL.has(word)));
}

/** The share of words two lines have in common (lib.js jaccard). */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let both = 0;
  for (const word of a) if (b.has(word)) both += 1;
  return both / (a.size + b.size - both);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** The home steps' lines of 8 words or more: does, each more line, the rule (lib.js homeLines). */
function homeLines(homes: Readonly<Partial<Record<string, LintStep>>>): HomeLine[] {
  const out: HomeLine[] = [];
  for (const [home, step] of Object.entries(homes)) {
    if (step === undefined) continue;
    // (only text: the loaders let nothing else into a step's does, more and rule)
    const add = (where: string, text: unknown): void => {
      if (typeof text !== "string") return;
      const toks = lintToks(text);
      if (toks.size >= 8) out.push({ home, id: step.id, where, toks });
    };
    if (step.does) add("does", step.does);
    list(step.more).forEach((line, k) => {
      add(`line ${String(k + 1)}`, line);
    });
    if (step.rule) add("rule", step.rule);
  }
  return out;
}

/** L4: a line that says a home's line again. */
export const l4: LintRule = {
  id: "L4",
  name: "restated rule",
  source: "lib.js lintSteps lines 1954-1961, homeLines lines 1799-1810",
  run(ctx: LintContext): LintHit[] {
    const lines = homeLines(ctx.homes);
    if (lines.length === 0) return [];
    const pointers = pointerPatterns(ctx.record);
    const hits: LintHit[] = [];
    for (const step of ctx.pageOrder) {
      const place = ctx.place(step);
      if (place.section < 3 || place.section > 12 || place.home) continue;
      const own = moreLines(step);
      if (typeof step.rule === "string") own.push(["rule", step.rule]);
      for (const [field, text] of own) {
        if (typeof text !== "string") continue;
        const pointer = field === "rule" ? NONE : pointerLine(text, pointers);
        if (pointer.kind === "bare") continue;
        const toks = lintToks(pointer.kind === "mixed" ? pointer.keep : text);
        if (toks.size < 8) continue;
        let best: { j: number; line: HomeLine } | null = null;
        for (const line of lines) {
          const j = jaccard(toks, line.toks);
          if (j >= 0.8 && (best === null || j > best.j)) best = { j, line };
        }
        if (best === null) continue;
        hits.push({
          rule: "L4",
          level: "error",
          step: step.id,
          field,
          text,
          fix: `restates ${best.line.id} ${best.line.where} (${best.line.home}): delete it, or keep only this step's own part`,
        });
      }
    }
    return hits;
  },
};
