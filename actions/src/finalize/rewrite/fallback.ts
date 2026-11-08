// The step's fallback text through limit 7 and the fill (arch 02 line 123: "Fails again: the step's fallback text, Jay's
// reviewed one or else its master line with slots filled, through the same checks (DD)"; DL-158 ruling b).
//
// The fallback is the master's words, so limit 7 never cuts a sentence of it: a cut could send "Sorry, Riley can't be in
// on Sat Oct 24. Please reply by 7pm.", an ask with nothing offered. A slot the reader may never see (limit 7's cut) stays
// as written, so its value is never filled, and so does a slot with no value: either leaves '{{' in the text, the Values
// check fails on it (arch 07 line 409) and the passed-on line goes (arch 02 line 123), as K-03's check-passed-on.json shows.
// A secure-page-only slot reads "Read it on the secure page", as limit 7 writes it (T-311), and every other slot is
// filled (T-310). The composer's plan and its one rewrite keep limit 7's cut (T-311's claimPlan).
//
// Each slot is judged with T-311's claimSlot; each one it cuts is held back as a private-use character while T-311's
// claimText claims and fills the rest (its second guard included: an unclaimed slot refuses the text whole), then put
// back as written. A text with a broken piece is refused whole first, as claimText refuses it, and so is one whose marks
// do not all come back (fail closed). Nothing here names a value: the problems name slots.

import { claimSlot, claimText, type ClaimContext } from "../claim-check";
import { isSlotName, type SlotProblem, type SlotSource, type SlotValue } from "../slots";
import { pieces, type SlotRef } from "../slots/syntax";

/** The fallback text after limit 7 and the fill. */
export interface ClaimedFallback {
  /** Every slot filled and nothing held back or refused. */
  readonly ok: boolean;
  /** The text, each slot held back or with no value as written ('{{' left in it). */
  readonly text: string;
  /** Each slot filled and the code-supplied value it took, in order of first use (K-03 `slotValues`). */
  readonly slotValues: readonly SlotValue[];
  /** What failed, in the words the rewrite is told: each names a slot, never a value. */
  readonly problems: readonly SlotProblem[];
}

/** The private-use characters (U+E000 to U+F8FF): one marks each slot held back while the rest is claimed and filled. */
const FIRST_MARK = 0xe000;
const LAST_MARK = 0xf8ff;
const MARK_CLASS = `[${String.fromCodePoint(FIRST_MARK)}-${String.fromCodePoint(LAST_MARK)}]`;
/** Whether a text holds a private-use character (not global: test() keeps no place). */
const ANY_MARK = new RegExp(MARK_CLASS, "u");
/** Each private-use character, for String#replace only. */
const EVERY_MARK = new RegExp(MARK_CLASS, "gu");

/** A slot held back and why limit 7 cut it (a closed reason, never a value). */
interface Held {
  readonly ref: SlotRef;
  readonly why: string;
}

/** What a slot held back tells: the Values check's own words for the '{{' it leaves (K-03 check-passed-on.json). */
function heldBack({ ref, why }: Held): SlotProblem {
  return {
    kind: "unfilled",
    slot: ref.name,
    detail: `The slot {{${ref.name}}} has no value, so '{{' is left in the text.`,
    why: `limit 7 cut it (${why})`,
  };
}

/** A '{{' that opens no slot or a '}}' that closes none: refused whole, as T-311's claimText refuses it (DL-131). */
const BROKEN: SlotProblem = {
  kind: "unknown",
  slot: "",
  detail: "A '{{' opens no slot or a '}}' closes none, so nothing in the text is filled.",
  why: null,
};

/** A text the marks cannot pass through safely: refused whole, nothing filled (fail closed). */
const MARKED: SlotProblem = {
  kind: "unknown",
  slot: "",
  detail: "The text holds a character code keeps for itself, so nothing in it is filled.",
  why: null,
};

/** The text refused whole: as written, nothing filled. */
const refusedWhole = (text: string, problem: SlotProblem): ClaimedFallback => ({
  ok: false,
  text,
  slotValues: [],
  problems: [problem],
});

/**
 * Limit 7 on the step's fallback text, then the fill, never cutting a sentence: each slot this reader may never see
 * stays as written, every other slot is claimed and filled as claimText does.
 */
export function claimFallback(text: string, source: SlotSource, context: ClaimContext): ClaimedFallback {
  if (ANY_MARK.test(text)) return refusedWhole(text, MARKED);
  const written = pieces(text);
  if (
    written.some((piece) => piece.kind === "broken" || (piece.kind === "words" && piece.text.includes("}}")))
  )
    return refusedWhole(text, BROKEN);

  const held: Held[] = [];
  const marked: string[] = [];
  for (const piece of written) {
    if (piece.kind !== "slot") {
      marked.push(piece.text);
      continue;
    }
    const { ref } = piece;
    const claim = isSlotName(ref.name) ? claimSlot(ref.name, source, context) : null;
    if (claim?.verdict !== "cut") {
      marked.push(ref.raw);
      continue;
    }
    if (FIRST_MARK + held.length > LAST_MARK) return refusedWhole(text, MARKED);
    marked.push(String.fromCodePoint(FIRST_MARK + held.length));
    held.push({ ref, why: claim.why });
  }

  const claimed = claimText(marked.join(""), source, context);
  const seen = held.map(() => 0);
  let marks = 0;
  const back = claimed.text.replace(EVERY_MARK, (mark) => {
    marks += 1;
    const index = (mark.codePointAt(0) ?? FIRST_MARK) - FIRST_MARK;
    const slot = held[index];
    if (slot === undefined) return mark;
    seen[index] = (seen[index] ?? 0) + 1;
    return slot.ref.raw;
  });
  // Each mark back exactly once and no other, or a mark joined the text's syntax: refused whole (fail closed).
  if (marks !== held.length || seen.some((count) => count !== 1)) return refusedWhole(text, MARKED);

  const problems: SlotProblem[] = claimed.ok ? [] : [...claimed.problems];
  for (const slot of held) {
    if (!problems.some((known) => known.kind === "unfilled" && known.slot === slot.ref.name))
      problems.push(heldBack(slot));
  }
  return { ok: claimed.ok && held.length === 0, text: back, slotValues: claimed.slotValues, problems };
}
