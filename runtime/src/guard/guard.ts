// The guard (T-250; C-051; arch 02 step 3, architecture.txt line 115): the first part of a turn's work, run on the bundle
// pinned for the turn (T-249). Hard invariant: a stop word never reaches the decide path.
//
//   1. Each text of the turn is read against the pinned bundle's keyword list (keywords.ts), by code alone: no model, and
//      nothing read from the database. A text that is only START, HELP or one of the 16 opt-out words is a keyword text; a
//      bare CANCEL or CANCELAR is a stop that also flags the visit (RULES 7.4).
//   2. The keyword texts go, in arrival order, to the fixed-reply path (`keywords`): their fixed replies and the STOP and
//      START records are T-267's (./replies), a later text's one reply and a work phone's "which texts?" T-268's. None of
//      them is ever in `onward`.
//   3. Only when some text is not a keyword does the guard read the handle's targets (targets.ts, K-05 v1.2), and hands
//      those texts on with K-09's `guardTargets` (`onward`), or none for the doors (`noTarget`). A turn of keyword texts
//      alone reads nothing, so a STOP never waits on the database.
//
// Fails closed: a bundle with no keyword list the guard can read stops the run (`GuardError` `noKeywords`: nothing is
// split, nothing reaches decide, and the lease lapses into a rerun); a targets read that fails gives `onward.read` "failed"
// (no targets, so the frontier cannot run and nothing reaches decide on this run), while the keyword texts still go to
// their path. The turn's `guard` span (K-08) holds counts and labels only: never a text's words, never the word itself.

import type { PinnedBundle } from "../bundle";
import type { SpanFacts, TraceContext } from "../trace";
import { keywordOf, keywordsOf, type KeywordList } from "./keywords";
import { readTargets, type TargetsRead } from "./targets";
import type { GuardErrorCode, GuardResult, GuardText, KeywordText } from "./types";

/** What the guard is given for one run of a turn (from the lease's `LeasedTurn` and the texts the turn opened). */
export interface GuardTurn<T extends GuardText> {
  /** The turn's handle (K-04 handles.id), whose targets are read. */
  handleId: string;
  /** The turn's texts, opened, in arrival order. */
  texts: readonly T[];
  /** The bundle pinned for the turn (`LeasedTurn.bundle`): the keyword list is its manifest's. */
  bundle: Pick<PinnedBundle, "manifest">;
  /** The turn's trace under the pinned bundle id (`LeasedTurn.trace`): the guard's span goes on it. */
  trace: TraceContext;
}

/**
 * Splits a turn's texts into keyword texts, for the fixed-reply path, and the rest, handed on with the handle's targets.
 * Throws `GuardError` `noKeywords` when the pinned bundle has no keyword list the guard can read.
 */
export async function guardTurn<T extends GuardText>(turn: GuardTurn<T>): Promise<GuardResult<T>> {
  const span = turn.trace.start("guard");
  const got: SpanFacts = { texts: turn.texts.length };
  let list: KeywordList;
  try {
    list = keywordsOf(turn.bundle.manifest);
  } catch (error) {
    const errorCode: GuardErrorCode = "noKeywords";
    record(() => span.finish({ outcome: "failed", errorCode, got, decided: { keyword: null } }));
    throw error;
  }

  const keywords: KeywordText<T>[] = [];
  const onwardTexts: T[] = [];
  for (const text of turn.texts) {
    const keyword = keywordOf(text, list);
    if (keyword === null) onwardTexts.push(text);
    else keywords.push({ text, keyword });
  }
  const decided: SpanFacts = {
    keyword: keywords.length === 0 ? null : keywords.map((found) => found.keyword.kind),
    flagsVisit: keywords.some((found) => found.keyword.flagsVisit),
    toDecide: onwardTexts.length,
  };

  if (onwardTexts.length === 0) {
    record(() => span.finish({ outcome: "ok", got, decided }));
    return { keywords, onward: null };
  }

  const read: TargetsRead = await readTargets(turn.handleId);
  if (read.result === "failed") {
    const errorCode = read.errorCode;
    record(() => span.finish({ outcome: "failed", errorCode, got, decided }));
    return { keywords, onward: { read: "failed", texts: onwardTexts, errorCode } };
  }
  const { targets, counts } = read;
  const targetCount = targets.openQuestionIds.length + targets.bookingIds.length;
  record(() =>
    span.finish({
      outcome: "ok",
      got: { ...got, ...counts },
      decided: { ...decided, targets: targetCount, doors: targets.noTarget },
    }),
  );
  return { keywords, onward: { read: "targets", texts: onwardTexts, targets } };
}

/** Records the span; a span the trace refuses is not kept, and the guard's answer stands. */
function record(finish: () => unknown): void {
  try {
    finish();
  } catch {
    // No span for this run of the guard.
  }
}
