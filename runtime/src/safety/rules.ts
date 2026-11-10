// The safety read's pure rules (T-246): which danger words a text holds, the result a timeout stands for, which checked
// line goes (with a partial bundle too, T-1143), and what each outcome holds. No storage, no clock, no outside call. The
// danger words and the lines are the bundle's (K-01 shared lists), passed in; this file holds no words of its own.

import type {
  BundleSafety,
  CheckedLine,
  DangerWordEntry,
  DangerWordMatch,
  ReleaseRule,
  SafetyOutcome,
  SafetyResult,
} from "./types";

/** Lower case, straight quotes, one space between words: the form a danger word and a text are compared in. */
export function normalizeWords(text: string): string {
  return text.toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/** True when `needle` is in `haystack` with no letter or digit touching either end ("fire" is not in "fired"). */
function containsWords(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = at + 1;
  }
}

/** The bundle's danger words found in a text's words (and an email's subject), each entry once, in the list's order. */
export function matchDangerWords(
  texts: readonly (string | null)[],
  list: readonly DangerWordEntry[],
): DangerWordMatch[] {
  const haystacks = texts.filter((text): text is string => text !== null).map(normalizeWords);
  const found: DangerWordMatch[] = [];
  for (const entry of list) {
    const needle = normalizeWords(entry.words);
    if (haystacks.some((haystack) => containsWords(haystack, needle))) {
      found.push({ words: entry.words, list: entry.list, kind: entry.kind });
    }
  }
  return found;
}

/**
 * What no verdict in 4 s stands for (arch 02 line 111): a danger-word match counts as Unsure; with none the outcomes are
 * empty and the outage line goes. K-02 `safetyResult` with `timedOut` true and no read.
 */
export function timeoutResult(eventId: string, matches: readonly DangerWordMatch[]): SafetyResult {
  const lifted = matches.length > 0;
  return {
    eventId,
    source: "text",
    tries: [
      { model: "haiku", result: "timeout" },
      { model: "sonnet", result: "timeout" },
    ],
    read: null,
    timedOut: true,
    dangerWords: [...matches],
    outcomes: lifted ? ["Unsure"] : [],
    liftedToUnsure: lifted,
  };
}

/** The outcomes that are danger: everything but No. */
export const dangerOutcomes = (outcomes: readonly SafetyOutcome[]): SafetyOutcome[] =>
  outcomes.filter((outcome) => outcome !== "No");

const HOLD_OF: Record<SafetyOutcome, ReleaseRule | null> = {
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

const STRICTNESS: readonly ReleaseRule[] = ["at_once", "when_private", "after_safe", "never"];

/** The strictest release rule of the outcomes (arch 06 lines 317 to 327: several at once, the strictest holds); null holds nothing. */
export function strictestHold(outcomes: readonly SafetyOutcome[]): ReleaseRule | null {
  let strictest: ReleaseRule | null = null;
  for (const outcome of outcomes) {
    const rule = HOLD_OF[outcome];
    if (rule === null) continue;
    if (strictest === null || STRICTNESS.indexOf(rule) > STRICTNESS.indexOf(strictest)) strictest = rule;
  }
  return strictest;
}

/** The stricter of two release rules: a hold written again for the same text is never looser than the open one. */
export function stricterHold(a: ReleaseRule, b: ReleaseRule): ReleaseRule {
  return STRICTNESS.indexOf(a) >= STRICTNESS.indexOf(b) ? a : b;
}

/** The order in which an outcome's line is chosen when several hold: 988 and 911 first, then the others (strictest first). */
const LINE_ORDER = [
  "Crisis words",
  "An emergency",
  "A threat to staff or others",
  "Harm to a child or older adult",
  "Unsafe at home",
  "Needs the business's own line",
  "Safety steps, then go on",
  "Unsure",
] as const satisfies readonly SafetyOutcome[];

/** The K-01 fixed line a danger-word match gets on a timeout: 988 and 911 for self-harm words, else 911 (arch 02 line 111). */
export function timeoutLineId(matches: readonly DangerWordMatch[]): "safetyCrisis" | "safetyEmergency" {
  return matches.some((match) => match.kind === "selfHarm") ? "safetyCrisis" : "safetyEmergency";
}

/** The strictest safety line, 911 (A3-24; arch 02 line 111): the last stand-in for any danger outcome's line (fails closed). */
const STRICTEST_LINE = "safetyEmergency";

/** The outcome whose writer gets no safety line from the actor (S13-10; S13-24 rule 11; A3-48). */
const THREAT = "A threat to staff or others" satisfies SafetyOutcome;

/**
 * The K-01 fixed line the sources give each danger outcome, for when the pinned bundle holds no checked line of the
 * outcome's own step (T-1143, DL-325): a partial bundle such as bundle v0, which holds only S1-01 and S1-02. Crisis words get
 * 988 and 911 (A3-25), an emergency 911 (A3-24). No other outcome has a K-01 v1 fixed line: A3-49's hotline and A3-50's
 * family violence line come from Rosie's safety list, A3-26's line from the business and A3-23's safety steps from the
 * plug-in. A3-49, A3-50 and A3-26 each give 911 where anyone is in danger, so all four get 911, the strictest (fails
 * closed). Unsure takes the danger words' line (`timeoutLineId`), and a threat's writer gets none.
 */
const FIXED_LINE_OF: Readonly<
  Record<Exclude<SafetyOutcome, "No" | "Unsure" | typeof THREAT>, "safetyCrisis" | "safetyEmergency">
> = {
  "Crisis words": "safetyCrisis",
  "An emergency": "safetyEmergency",
  "Harm to a child or older adult": STRICTEST_LINE,
  "Unsafe at home": STRICTEST_LINE,
  "Needs the business's own line": STRICTEST_LINE,
  "Safety steps, then go on": STRICTEST_LINE,
};

/**
 * The checked line for a result the read gave, to the person who wrote the text (the direct path's choice; the core makes
 * its own when PostgreSQL is up). The outcome first in LINE_ORDER chooses it: its step's checked line in the pinned bundle
 * first; with none (a partial bundle), the fixed line the sources give that outcome (`FIXED_LINE_OF`; Unsure takes the
 * danger words' line); with that missing too, 911 (fails closed). Each such stand-in keeps its K-01 id, so the span's line
 * names it with no words. A label whose tense is unknown adds the danger question (S13-24 rule 10). Null, nothing to send:
 * No; a threat chosen first, since its writer gets no safety line (S13-10; S13-24 rule 11; A3-48) and the core tells the
 * owner (DL-330), while crisis words or an emergency in the same text come first in LINE_ORDER and get theirs; or a bundle
 * with no words for the line at all (this file holds none of its own).
 */
export function checkedLineFor(result: SafetyResult, bundle: BundleSafety): CheckedLine | null {
  const outcomes = dangerOutcomes(result.outcomes);
  const first = LINE_ORDER.find((outcome) => outcomes.includes(outcome));
  if (first === undefined || first === THREAT) return null;
  const line =
    first === "Unsure"
      ? (bundle.fixedLine(timeoutLineId(result.dangerWords)) ?? bundle.fixedLine(STRICTEST_LINE))
      : (bundle.outcomeLine(first) ??
        bundle.fixedLine(FIXED_LINE_OF[first]) ??
        bundle.fixedLine(STRICTEST_LINE));
  if (line === null) return null;
  const asks =
    result.read?.labels.some((label) => label.tense === "unknown" && label.outcome !== "No") ?? false;
  const ask = asks ? bundle.fixedLine("safetyAsk") : null;
  return ask === null ? line : { id: line.id, text: `${line.text} ${ask.text}` };
}

/** A short label for a span or a log: the outcome without its words. */
export const OUTCOME_LABEL: Record<SafetyOutcome, string> = {
  No: "no",
  "Safety steps, then go on": "safetySteps",
  "An emergency": "emergency",
  "Crisis words": "crisis",
  "A threat to staff or others": "threat",
  "Harm to a child or older adult": "harmToChildOrElder",
  "Unsafe at home": "unsafeAtHome",
  "Needs the business's own line": "ownLine",
  Unsure: "unsure",
};
