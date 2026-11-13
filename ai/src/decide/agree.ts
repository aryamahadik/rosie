// Decide's two reads, compared part by part (T-369, C-115; arch 02 line 119; arch 06 lines 285 to 287; K-02 v1 README
// "Verbs and what code checks"; CQ-07's default).
//
// "Two reads must agree on every choice and every field value" (arch 02 line 119). Each read gives one part per part of
// the text, in the text's order, so the reads' parts are paired by place: the k-th part of the first read with the k-th
// of the check read. A pair agrees when both give the same verb and, as their verb takes them, the same question and
// choice, the same fields in the same order with equal values, the same questions to ask (in any order) and a hand-off
// about the same people. That is what K-02's contract test reads as agreed (tests/contract/model.v1.test.ts,
// `readsAgree`). What is not compared is the person's words or the model's own, which two reads never write alike: a
// part's quote, a field's source words, what an ask finds unclear, why none fits, a hand-off's reason, and the words
// passed on or redacted. The gate re-checks every quote and every source word against the texts (C-080), and limit 6
// re-parses each value from its words, whichever read's part goes.
//
// The choices are shuffled per read (T-363's seeds, T-367's layout). A part names a choice by its id, never by its place
// in the list, so two reads that differ only in the order they saw the choices in agree.
//
// A part one read has and the other has not (the reads cut the text into a different number of parts) is not agreed.
// The text's language is a value both reads must agree on (CQ-07's default): two languages leave the turn not agreed and
// its language unknown (null), whatever its parts.
//
// What a part that differs comes to depends on the turn's stakes (arch 06 lines 285 to 287): on low stakes it is not
// agreed, and the turn's one Sonnet re-read settles it (T-370); on high stakes any difference marks it for one question,
// and nothing changes for it, the re-read running first (Q-41). Either way it never reaches the gate before the re-read.
//
// Nothing here calls a model or logs. A difference is a label naming what differs, never the words or values.

import { canonical } from "../cache/bundle";
import { STAKES } from "../routing";
import { decideReadProblems } from "./check";
import { DecideRequestError } from "./errors";
import {
  DIFFERENCES,
  type Agreement,
  type DecidePart,
  type DecideRead,
  type Difference,
  type Field,
  type PartAgreement,
  type PartMark,
  type Stakes,
} from "./types";

/** The same names in the same order, each with an equal value (key order aside, as JSON compares). */
function fieldDifferences(first: readonly Field[], check: readonly Field[], found: Set<Difference>): void {
  if (first.length !== check.length) found.add("fields");
  const shared = Math.min(first.length, check.length);
  for (let k = 0; k < shared; k += 1) {
    const a = first[k];
    const b = check[k];
    if (a === undefined || b === undefined) continue;
    if (a.name !== b.name) found.add("fields");
    else if (canonical(a.value) !== canonical(b.value)) found.add("value");
  }
}

const sortedText = (list: readonly string[]): string[] =>
  [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, k) => item === b[k]);

/**
 * What the first and check reads' parts at one place differ on, in DIFFERENCES' order; empty when they agree. A part
 * one read lacks (null) is `missing`; parts with different verbs differ on the verb alone, as nothing else compares.
 */
export function partDifferences(first: DecidePart | null, check: DecidePart | null): Difference[] {
  if (first === null || check === null) return ["missing"];
  if (first.verb !== check.verb) return ["verb"];
  const found = new Set<Difference>();
  if (first.verb === "choose" && check.verb === "choose") {
    if (first.question !== check.question) found.add("question");
    if (first.choice !== check.choice) found.add("choice");
    fieldDifferences(first.fields, check.fields, found);
  } else if (first.verb === "enter" && check.verb === "enter") {
    if (first.choice !== check.choice) found.add("choice");
    fieldDifferences(first.fields, check.fields, found);
  } else if (first.verb === "ask" && check.verb === "ask") {
    if (!sameList(sortedText(first.questions), sortedText(check.questions))) found.add("questions");
  } else if (first.verb === "hand_off" && check.verb === "hand_off") {
    if (first.about !== check.about) found.add("about");
  }
  return DIFFERENCES.filter((difference) => found.has(difference));
}

/** What a part the reads differ on comes to: one question on high stakes, else not agreed until the re-read. */
const markOf = (differences: readonly Difference[], stakes: Stakes): PartMark =>
  differences.length === 0 ? "agreed" : stakes === "high" ? "oneQuestion" : "notAgreed";

/**
 * The first and check reads of one turn, compared part by part on the turn's stakes (see the head of this file). Throws
 * DecideRequestError, a fault in the calling code, for a read that is not a K-02 v1 `decideRead` (at least one part,
 * each one of the eight verbs with its own fields) or stakes K-02 does not have: what a read cannot be is never agreed.
 */
export function agreeReads(first: DecideRead, check: DecideRead, stakes: Stakes): Agreement {
  if (!(STAKES as readonly unknown[]).includes(stakes))
    throw new DecideRequestError("two reads are compared on low or high stakes (K-02 stakes)");
  for (const [role, read] of [
    ["first", first],
    ["check", check],
  ] as const) {
    const problems = decideReadProblems(read);
    if (problems.length > 0)
      throw new DecideRequestError(`the ${role} read is not a K-02 read: ${problems.join("; ")}`);
  }
  const count = Math.max(first.parts.length, check.parts.length);
  const parts: PartAgreement[] = [];
  for (let index = 0; index < count; index += 1) {
    const a = first.parts[index] ?? null;
    const b = check.parts[index] ?? null;
    const differences = Object.freeze(partDifferences(a, b));
    parts.push(Object.freeze({ index, first: a, check: b, mark: markOf(differences, stakes), differences }));
  }
  const language = first.language === check.language ? first.language : null;
  return Object.freeze({
    stakes,
    agreed: language !== null && parts.every((part) => part.mark === "agreed"),
    language,
    parts: Object.freeze(parts),
  });
}
