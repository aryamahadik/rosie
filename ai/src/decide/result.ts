// K-02 v1's `decideResult`, as decide hands it to the gate (C-115, C-116; arch 02 line 119; arch 06 lines 285 to 289;
// Q-41): after the first and check reads (T-369, reread false), and after the turn's one Sonnet re-read (T-370, reread
// true). Pure: nothing here calls a model or logs.
//
// After the re-read, a part goes to the gate only when two reads give it alike (the verb, the choice and every field
// value, as agree.ts compares them): the first and check reads (untouched, or confirmed when the gate named a value of
// it failing its words and the re-read gives it alike again), or, on low stakes, the re-read with one of them (settled).
// Every other part ends in one question and nothing changes for it. The re-read never changes a part the first and
// check reads agreed on unless the gate named a value of it failing its words, and never commits on a difference: a part
// only the re-read gives, or one it gives otherwise than both reads, is one question. On high stakes any difference
// between the first and check reads stays one question whatever the re-read says (arch 06 line 287; Q-41: the re-read
// runs before the question). The text's language the first and check reads agreed on stands; when they differed, the
// re-read settles it by giving one of theirs, else it stays unknown (null; CQ-07).

import { partDifferences } from "./agree";
import type {
  Agreement,
  DecidePart,
  DecideResult,
  FailingPart,
  PartAgreement,
  PartSettlement,
  Read,
  ReadPair,
  ResultPart,
  Settlement,
  Stakes,
} from "./types";
import type { BundleId } from "../../../runtime/src/trace";

/** What a K-02 result names of the turn's route: the turn, its bundle, its stakes and its read pair. */
export interface ResultRoute {
  readonly turnId: string;
  readonly bundleId: BundleId;
  readonly stakes: Stakes;
  readonly routing: ReadPair;
}

/** The part a part that differs holds: the last read's part there (K-02 `resultPart`), the first's when only it has one. */
function lastPart(entry: PartAgreement): DecidePart {
  const part = entry.check ?? entry.first;
  // agreeReads gives an entry only where one of the reads has a part.
  if (part === null) throw new Error("a compared part holds a part of one read at least");
  return part;
}

/**
 * K-02 v1's `decideResult` for a turn's first and check reads, before any re-read (reread false, two reads): each part
 * agreed is the first read's part and goes; each part not agreed, or marked for one question, is the last read's part
 * there (K-02: "kept for the trace and the question"), and nothing changes for it. agreed and language are the
 * comparison's.
 */
export function twoReadResult(
  route: ResultRoute,
  first: Read,
  check: Read,
  agreement: Agreement,
): DecideResult {
  const parts = agreement.parts.map((entry): ResultPart =>
    entry.mark === "agreed" && entry.first !== null
      ? Object.freeze({ part: entry.first, outcome: "go" })
      : Object.freeze({ part: lastPart(entry), outcome: "oneQuestion" }),
  );
  return Object.freeze({
    turnId: route.turnId,
    bundleId: route.bundleId,
    stakes: route.stakes,
    routing: route.routing,
    reads: Object.freeze([first, check]),
    agreed: agreement.agreed,
    reread: false,
    language: agreement.language,
    parts: Object.freeze(parts),
  });
}

/** True when a read's part there gives what `part` gives: the same verb, choice and every field value. */
const alike = (one: DecidePart | null, part: DecidePart): boolean =>
  one !== null && partDifferences(one, part).length === 0;

/** What one part comes to at the re-read: its settlement and the part K-02's result holds for it. */
function settle(
  entry: PartAgreement | undefined,
  given: ResultPart | undefined,
  again: DecidePart | null,
  failed: boolean,
): { settlement: Settlement; part: ResultPart } {
  const unclear = (kept: DecidePart): { settlement: Settlement; part: ResultPart } => ({
    settlement: "unclear",
    part: Object.freeze({ part: kept, outcome: "oneQuestion" }),
  });
  if (entry === undefined) {
    // A part only the re-read gives: no two reads give it, so it is one question.
    if (again === null) throw new Error("a part at the re-read is a part of one read at least");
    return unclear(again);
  }
  if (entry.mark === "agreed" && given !== undefined) {
    if (!failed) return { settlement: "untouched", part: given };
    if (again !== null && alike(entry.first, again)) return { settlement: "confirmed", part: given };
    return unclear(again ?? lastPart(entry));
  }
  if (
    entry.mark === "notAgreed" &&
    again !== null &&
    (alike(entry.first, again) || alike(entry.check, again))
  )
    return { settlement: "settled", part: Object.freeze({ part: again, outcome: "go" }) };
  return unclear(again ?? lastPart(entry));
}

/**
 * K-02 v1's `decideResult` after the turn's one re-read (reread true; the reads first, check and reread) from the
 * result decide gave before it (`before`: the two reads' own, reread false), their comparison (`agreement`), the
 * re-read and the parts the gate named failing their words (empty unless it named some). Each part, in the text's
 * order (as many as the read with most parts gives), with what became of it (see the head of this file). agreed stays
 * the first and check reads' own (K-02: whether they agreed).
 */
export function rereadResult(
  before: DecideResult,
  agreement: Agreement,
  reread: Read,
  failing: readonly FailingPart[],
): { readonly result: DecideResult; readonly settlement: readonly PartSettlement[] } {
  const [first, check] = before.reads;
  if (first === undefined || check === undefined || before.reread || before.reads.length !== 2)
    throw new Error("a re-read follows the first and check reads, before any re-read");
  const failed = new Set(failing.map((entry) => entry.part));
  const again = reread.output.parts;
  const count = Math.max(agreement.parts.length, again.length);
  const parts: ResultPart[] = [];
  const settlement: PartSettlement[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = agreement.parts[index];
    const part = again[index] ?? null;
    const settled = settle(entry, before.parts[index], part, failed.has(index));
    parts.push(settled.part);
    settlement.push(
      Object.freeze({
        index,
        mark: entry?.mark ?? null,
        failed: failed.has(index),
        reread: part,
        settlement: settled.settlement,
      }),
    );
  }
  const theirs = [first.output.language, check.output.language];
  const language =
    before.language ?? (theirs.includes(reread.output.language) ? reread.output.language : null);
  return Object.freeze({
    result: Object.freeze({
      turnId: before.turnId,
      bundleId: before.bundleId,
      stakes: before.stakes,
      routing: before.routing,
      reads: Object.freeze([first, check, reread]),
      agreed: before.agreed,
      reread: true,
      language,
      parts: Object.freeze(parts),
    }),
    settlement: Object.freeze(settlement),
  });
}
