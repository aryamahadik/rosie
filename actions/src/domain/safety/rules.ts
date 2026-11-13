// The safety service's pure rules (T-318; C-104; arch 06 lines 315 to 329; A3-22 to A3-26, A3-48 to A3-50; S13-10): what
// each outcome holds and how the hold is released, the strictest of several, which outcome's line goes first, who is told,
// and what a clear "we're safe" is. No storage, no clock, no outside call: the records and plans (record.ts, release.ts)
// read through their ports and apply these.

import type { RequestOf, ResponseOf } from "../../tool-api";

/** K-02 v1 `safetyResult`, as K-09 v1 recordSafetyOutcome carries it. */
export type SafetyResult = RequestOf<"recordSafetyOutcome">["safety"];
/** K-02 v1 `safetyOutcome`: the 8 outcomes of A3-22 and B3-17, word for word, and Unsure. */
export type SafetyOutcome = SafetyResult["outcomes"][number];
/** K-02 v1 `tense`. */
export type Tense = NonNullable<SafetyResult["read"]>["labels"][number]["tense"];
/** K-34 v1 `safety_holds.release_rule`. */
export type ReleaseRule = NonNullable<ResponseOf<"recordSafetyOutcome">["hold"]>["releaseRule"];
/** K-34 v1 `safety_holds.released_why`. */
export type ReleasedWhy = RequestOf<"releaseSafetyHold">["why"];

/** Every outcome, in K-02 v1's order (K-34 v1 `safety_outcomes_outcomes_known`). */
export const SAFETY_OUTCOMES: readonly SafetyOutcome[] = [
  "No",
  "Safety steps, then go on",
  "An emergency",
  "Crisis words",
  "A threat to staff or others",
  "Harm to a child or older adult",
  "Unsafe at home",
  "Needs the business's own line",
  "Unsure",
];

/**
 * What each outcome holds (arch 06 lines 317 to 325): at once after the outcome's message (No holds nothing unless the
 * plug-in's stop words matched: A3-26), once the booking is made private (A3-50), after a clear "we're safe" with a fresh
 * read-back (A3-24, A3-25), or never (A3-48).
 */
export const HOLD_OF: Readonly<Record<SafetyOutcome, ReleaseRule | null>> = {
  No: null,
  "Safety steps, then go on": "at_once",
  "Harm to a child or older adult": "at_once",
  "Needs the business's own line": "at_once",
  "Unsafe at home": "when_private",
  "An emergency": "after_safe",
  "Crisis words": "after_safe",
  Unsure: "after_safe",
  "A threat to staff or others": "never",
};

/** The release rules from the loosest to the strictest (arch 06 line 327: "Several at once: The strictest holds"). */
export const STRICTNESS: readonly ReleaseRule[] = ["at_once", "when_private", "after_safe", "never"];

/** The reason that fits each release rule (K-34 v1 `safety_holds_why_fits_rule`); a never hold has none. */
export const WHY_OF_RULE: Readonly<Record<ReleaseRule, ReleasedWhy | null>> = {
  at_once: "outcome_message_sent",
  when_private: "booking_private",
  after_safe: "safe_readback",
  never: null,
};

/** The stricter of two release rules. */
export function stricter(a: ReleaseRule, b: ReleaseRule): ReleaseRule {
  return STRICTNESS.indexOf(a) >= STRICTNESS.indexOf(b) ? a : b;
}

/** The strictest of several release rules, or null for none. */
export function strictestOf(rules: readonly (ReleaseRule | null)[]): ReleaseRule | null {
  let strictest: ReleaseRule | null = null;
  for (const rule of rules) {
    if (rule === null) continue;
    strictest = strictest === null ? rule : stricter(strictest, rule);
  }
  return strictest;
}

/** The danger outcomes: every outcome but No. */
export function dangerOf(outcomes: readonly SafetyOutcome[]): SafetyOutcome[] {
  return outcomes.filter((outcome) => outcome !== "No");
}

/**
 * The rule a result's hold takes: the strictest of its outcomes (a read that timed out with a danger word is Unsure:
 * after_safe). A read that timed out with no danger word (no outcome: the outage line goes) still holds routine (arch 02
 * line 111: "routine actions stay held"; K-09 v1.1: "routine is held either way"), at once: released once the outage line
 * is handed on, while the handle actor's own unread hold keeps routine held until its re-read (CQ-65's DL-127 addendum),
 * so the record never holds the handle for good when no danger was ever read (record.ts default 2). No with the
 * plug-in's stop words matched still holds booking, released at once (A3-26). Null: it holds nothing.
 */
export function ruleOf(
  result: { readonly outcomes: readonly SafetyOutcome[]; readonly timedOut: boolean },
  blocksBooking: boolean,
): ReleaseRule | null {
  const rule = strictestOf(result.outcomes.map((outcome) => HOLD_OF[outcome]));
  if (rule !== null) return rule;
  return result.timedOut || blocksBooking ? "at_once" : null;
}

/**
 * The order in which an outcome's line is chosen when several hold (as the handle actor's direct path chooses it,
 * runtime/src/safety/rules.ts): 988 and 911 first, then the others, strictest first.
 */
export const LINE_ORDER: readonly SafetyOutcome[] = [
  "Crisis words",
  "An emergency",
  "A threat to staff or others",
  "Harm to a child or older adult",
  "Unsafe at home",
  "Needs the business's own line",
  "Safety steps, then go on",
  "Unsure",
];

/** The outcome whose step's checked line goes (LINE_ORDER), or null for No and a read that timed out with no danger word. */
export function lineOutcomeOf(outcomes: readonly SafetyOutcome[]): SafetyOutcome | null {
  return LINE_ORDER.find((outcome) => outcomes.includes(outcome)) ?? null;
}

/**
 * Whether an outcome's step always sends its line: every danger outcome but "Safety steps, then go on", whose plug-in may
 * have no steps ("A barbershop has none, so nothing is sent here": A3-23).
 */
export function mustSendLine(outcome: SafetyOutcome): boolean {
  return outcome !== "No" && outcome !== "Safety steps, then go on";
}

/**
 * Who is told through a hand-off or a page (arch 06 line 329; S13-29 rule 57): crisis words, the owner and Rosie's team at
 * once; an emergency or a threat, the owner, then after 5 minutes whoever they named and Rosie's team (the hand-off's own
 * clock). Harm to a child or older adult is told to Rosie's team that day by its harm report (A3-49), here, not by a
 * hand-off. Every other outcome tells nobody (K-09 v1.1's own-line and timeout fixtures: `told` empty).
 */
export const TELLS: readonly SafetyOutcome[] = [
  "Crisis words",
  "An emergency",
  "A threat to staff or others",
];

/** The outcomes that tell someone through a hand-off or a page, in K-02's order. */
export function tellsOf(outcomes: readonly SafetyOutcome[]): SafetyOutcome[] {
  return SAFETY_OUTCOMES.filter((outcome) => TELLS.includes(outcome) && outcomes.includes(outcome));
}

/** Whether nothing books while the hold stands (K-09 v1 `nothingBooks`): any hold but an at-once one with no stop words. */
export function nothingBooksUnder(
  hold: { releaseRule: ReleaseRule; blocksBooking: boolean } | null,
): boolean {
  if (hold === null) return false;
  return hold.releaseRule !== "at_once" || hold.blocksBooking;
}

/** The tenses that may still be danger (arch 06 line 329: unknown reads as danger; S13-10: a threat that could start again). */
const OPEN_TENSES: readonly Tense[] = ["could restart", "unknown"];

/**
 * A clear "we're safe" (A3-24: "we're safe, it's handled"; A3-25: "I'm safe right now"; arch 06 line 323): the text's own
 * read gave a verdict, every label reads No, nothing was lifted to Unsure, what holds after code's rules is No alone, and
 * no label's tense is one that may still be danger (S13-10: "A fire, gas or a threat that could start again still gets
 * the message"). Anything else still holds danger.
 */
export function isClearSafe(read: {
  readonly timedOut: boolean;
  readonly labels: readonly SafetyOutcome[];
  readonly tenses: readonly Tense[];
  readonly outcomes: readonly SafetyOutcome[];
  readonly liftedToUnsure: boolean;
}): boolean {
  if (read.timedOut || read.liftedToUnsure) return false;
  if (read.labels.length === 0 || read.labels.some((label) => label !== "No")) return false;
  if (read.tenses.some((tense) => OPEN_TENSES.includes(tense))) return false;
  return read.outcomes.length > 0 && read.outcomes.every((outcome) => outcome === "No");
}

/** The read's labels and their tenses, in order (K-34 v1 `labels`, `tenses`). */
export function labelsOf(result: SafetyResult): { labels: SafetyOutcome[]; tenses: Tense[] } {
  const labels = result.read?.labels ?? [];
  return { labels: labels.map((label) => label.outcome), tenses: labels.map((label) => label.tense) };
}

// ---- the danger question (T-1176; CQ-172) ---------------------------------------------------------------------------

/** K-01 v1's danger question, by its fixed line id: "Is anyone in danger right now?" as the pinned bundle writes it. */
export const SAFETY_ASK_LINE = "safetyAsk";

/** One label as the danger question reads it: its outcome and its tense (K-02 v1 safetyLabel; K-34 v1 labels, tenses). */
export interface LabelTense {
  readonly outcome: SafetyOutcome;
  readonly tense: Tense;
}

/**
 * A stored record's own labels, each with its tense, in the read's order (K-34 v1 `labels` and `tenses`, one tense per
 * label: safety_outcomes_one_tense_per_label). A label with no tense beside it, which K-34 refuses, reads as unknown:
 * unknown reads as danger (arch 06 line 329).
 */
export function storedLabels(stored: {
  readonly labels: readonly SafetyOutcome[];
  readonly tenses: readonly Tense[];
}): LabelTense[] {
  return stored.labels.map((outcome, at) => ({ outcome, tense: stored.tenses[at] ?? "unknown" }));
}

/**
 * Whether a record's own labels add the danger question to its line (arch 06 line 329: "unknown reads as danger and adds
 * 'Is anyone in danger right now?'"; S13-24 rule 10; A3-22), as the handle actor's direct path asks it
 * (runtime/src/safety/rules.ts checkedLineFor, lines 170 to 172; T-1143; CQ-172): a label whose tense is unknown and whose
 * outcome is not No. Never for No, nor for a label of a known tense (over, now, could restart, joke), nor for a read with
 * no label: a timeout has none (CQ-163 b), and a read not given is no label.
 */
export function asksIfInDanger(labels: readonly LabelTense[]): boolean {
  return labels.some((label) => label.tense === "unknown" && label.outcome !== "No");
}
