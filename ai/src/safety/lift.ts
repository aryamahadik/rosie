// Code's danger-word rules after the safety read (T-366, C-113; arch 06 'Every raw text', line 283; arch 02 step S,
// line 111; K-02 v1 `safetyResult`: `dangerWords`, `outcomes`, `liftedToUnsure`).
//
// The model reads each text for danger by meaning (T-365, read.ts). Code then finds the danger words of the caller's
// list in the text and an email's subject, and applies one of two rules to the answer:
//
//   - A verdict. A trade's own danger word (list plugin: a plug-in's danger words, K-01 v1 pf.safety; fixture set v1's
//     safety_stop) lifts No to Unsure only when its tense is now, could restart or unknown, so "the gas leak was fixed
//     in March" stays No (arch 06 line 283). A word takes its tense from the labels that quote it in their evidence: a
//     word that labels quote, every one of them over or joke, is not danger (arch 06 line 329: "Over and joke are not
//     danger"). A word quoted by a label whose tense is now, could restart or unknown is danger, and so is a word no
//     label quotes: the read said nothing that places it out of danger, and unknown reads as danger (arch 06 line 329;
//     A3-22: "Safe default: unsure is read as danger"). The safety read prompt asks the model for exactly that: "when
//     words only sound like danger and are over or a joke, copy those words" (prompt.ts, fields). The lift replaces only
//     a read whose outcomes are No: it never lowers a verdict, and a read with any danger outcome keeps it as it is.
//     A general check's word (list general) is reported, but lifts nothing: the model reads the general check itself
//     (A3-22: "checked ... by meaning"), and the rule names the plug-in's words (arch 06 line 283; T-366's card).
//   - No verdict in 4 s. Any danger word, general or plug-in, counts as Unsure, and the timeout marker carries the
//     matches; with none, it is the plain marker, with no outcome, and the outage line goes (arch 02 line 111). Which
//     safety line goes is the actor's (T-246): 988 and 911 when a match is kind selfHarm, else 911.
//
// Either way the matches are K-02's `dangerWords`: every list entry found, each once, in the list's order. The rule that
// finds them is the handle actor's own (runtime/src/safety/rules.ts `matchDangerWords`, T-246): lower case, straight
// quotes, one space between words, and no letter or digit touching either end ("fire" is not in "fired"). So the read's
// marker and the actor's own stand-in for a timeout find the same words in the same text, and a label quotes a word by
// the same rule.
//
// The list is the caller's: the danger words the bundle holds for the text's business, the entries the actor's
// `BundleSafety.dangerWords()` gives (T-246). K-01 v1 holds a trade's danger words only as pf.safety's descriptions,
// and the general check's words not at all: a list of words to match is T-1087's (K-01 v1.1) and CQ-24's. A match holds
// the person's own words: it goes into the answer only, never into a span or a log.

import { matchDangerWords } from "../../../runtime/src/safety/rules";
import {
  NOT_DANGER_TENSES,
  type DangerWordEntry,
  type DangerWordMatch,
  type SafetyOutcome,
  type SafetyRead,
  type SafetyReadInput,
  type SafetyResult,
} from "./types";

/** The fields of a K-02 result that code's danger-word rules set. */
export type DangerWordFields = Pick<SafetyResult, "dangerWords" | "outcomes" | "liftedToUnsure">;

/** The list's danger words found in a text and an email's subject: each entry once, in the list's order. */
export function findDangerWords(
  input: Pick<SafetyReadInput, "text" | "subject">,
  list: readonly DangerWordEntry[],
): DangerWordMatch[] {
  return matchDangerWords([input.text, input.subject ?? null], list);
}

/** True when a label's evidence holds the match's words, by the same rule that found them in the text. */
export function quotes(evidence: string, match: DangerWordMatch): boolean {
  return matchDangerWords([evidence], [match]).length > 0;
}

/**
 * True when the read places a danger word out of danger: labels quote it in their evidence, and every one of them is
 * over or joke. A word no label quotes is not placed: the read gave it no tense.
 */
export function outOfDanger(read: SafetyRead, match: DangerWordMatch): boolean {
  const quoting = read.labels.filter((label) => quotes(label.evidence, match));
  return quoting.length > 0 && quoting.every((label) => NOT_DANGER_TENSES.includes(label.tense));
}

/** True when a read's held outcomes are No alone: the only outcomes the lift may replace. */
const onlyNo = (held: readonly SafetyOutcome[]): boolean => held.length === 1 && held[0] === "No";

/**
 * Code's rules on a verdict: `held` is what holds for the read before them (read.ts `heldOutcomes`). A trade's danger
 * word that the read does not place out of danger lifts No to Unsure; anything but No stays as it is.
 */
export function afterVerdict(
  held: readonly SafetyOutcome[],
  read: SafetyRead,
  matches: readonly DangerWordMatch[],
): DangerWordFields {
  const lifted =
    onlyNo(held) && matches.some((match) => match.list === "plugin" && !outOfDanger(read, match));
  return {
    dangerWords: [...matches],
    outcomes: lifted ? ["Unsure"] : [...held],
    liftedToUnsure: lifted,
  };
}

/** No verdict in 4 s: the timeout marker. A danger word counts as Unsure; with none the marker is plain, with no outcome. */
export function timeoutMarker(matches: readonly DangerWordMatch[]): DangerWordFields {
  const lifted = matches.length > 0;
  return {
    dangerWords: [...matches],
    outcomes: lifted ? ["Unsure"] : [],
    liftedToUnsure: lifted,
  };
}
