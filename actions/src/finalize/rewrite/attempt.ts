// One attempt's checks and what happens next (K-03 v1 `checkResult`: "The result of the claim check's message checks on
// one attempt"; arch 02 line 123; arch 07 line 417).
//
// The seven message checks run on the attempt's final parts (T-312), each once, in K-03's order. What limit 7 and the
// fill found (T-310, T-311) and what code could not build (parts.ts) join the check they break, so the check result says
// everything that failed, in the words the rewrite is told:
//   - Values: a slot with no value or outside the vocabulary, a text limit 7 refused whole (a broken piece, a slot it did
//     not leave for this reader: DL-131), a question limit 7 cut (T-311's handoff: "tell the rewrite"), a message with
//     no words. Each names slots, never a value, and blocks, so a refused text is never sent (T-311's security note a);
//   - Fixed lines: an option id that is not the step's; Format: a format the parts cannot hold.
//
// The ladder (arch 07 line 417): a miss on Fixed lines, Values, One question or Never in a message blocks: the composed
// plan gets one rewrite, the rewrite falls back to the step's fallback text, and the fallback is passed on. A miss only on
// Shape, Length and reading or Format gets one rewrite, then sends and is logged; a message past four fact lines is only
// logged, even before the rewrite.

import {
  BLOCKING_CHECKS,
  CHECKS,
  CHECK_NAMES,
  MAX_OPTIONS,
  MAX_OPTION_CHARACTERS,
  checkOutcome,
  type CheckContext,
  type CheckName,
} from "../checks";
import type { SlotProblem } from "../slots";
import type { PartFaults } from "./parts";
import type { Attempt, AttemptOutcome, CheckOutcome, FinalParts } from "./types";

/** One attempt's seven checks and how they stand. */
export interface AttemptCheck {
  /** Each check once, in K-03's order (K-03 v1 `checkOutcome`). */
  readonly checks: CheckOutcome[];
  readonly passed: boolean;
  /** A blocking check missed: fixed lines, values, one question or never in a message (arch 07 line 417). */
  readonly blocked: boolean;
  /** The only miss is a message past four fact lines (Shape's line count): it is only logged (arch 07 line 417). */
  readonly onlyLogged: boolean;
  /** The checks that missed, in order: labels only, for the log. */
  readonly missed: CheckName[];
}

/** What a text that failed limit 7 or the fill with no problem named tells the rewrite: it still fails (fail closed). */
export const NOT_FILLED = "A slot in the text could not be filled, so nothing in it is filled.";

/**
 * What a text that failed limit 7 or the fill tells the rewrite: each problem's detail, which names the slot, never its
 * value (T-310, T-311), each once; never nothing, so the attempt always fails Values.
 */
export function problemFaults(problems: readonly SlotProblem[]): string[] {
  const details = [...new Set(problems.map((problem) => problem.detail))];
  return details.length > 0 ? details : [NOT_FILLED];
}

/** Whether Shape's only fault is the line count: no poll past 5 options and no option past 24 characters. */
function onlyLineCount(parts: FinalParts): boolean {
  return parts.sends.every(
    (send) =>
      send.options.length <= MAX_OPTIONS &&
      send.options.every((option) => option.label.length <= MAX_OPTION_CHARACTERS),
  );
}

/**
 * Runs the seven message checks on one attempt's final parts, each with the faults code found before it (limit 7, the
 * fill, the parts) joined to its own, each fault once.
 */
export function checkAttempt(parts: FinalParts, context: CheckContext, found: PartFaults): AttemptCheck {
  const checks = CHECK_NAMES.map((name): CheckOutcome => {
    const faults = [...new Set([...CHECKS[name](parts, context), ...(found[name] ?? [])])];
    const outcome = checkOutcome(name, faults);
    return { check: outcome.check, passed: outcome.passed, detail: outcome.detail };
  });
  const missed = checks.filter((check) => !check.passed).map((check) => check.check);
  return {
    checks,
    passed: missed.length === 0,
    blocked: missed.some((check) => BLOCKING_CHECKS.has(check)),
    onlyLogged: missed.length === 1 && missed[0] === "shape" && onlyLineCount(parts),
    missed,
  };
}

/**
 * What happens after one attempt (K-03 v1 `checkResult.outcome`; arch 02 line 123; arch 07 line 417): send when every
 * check passed; on a blocking miss, the composed plan's one rewrite, then the step's fallback text (when the step has
 * one), then the passed-on line; on a miss only of Shape, Length and reading or Format, the composed plan's one rewrite,
 * then it sends and is logged, and a message past four fact lines is only logged at once. Never a second rewrite.
 */
export function outcomeOf(attempt: Attempt, check: AttemptCheck, hasFallback: boolean): AttemptOutcome {
  if (check.passed) return "send";
  if (check.blocked) {
    if (attempt === "composed") return "rewrite";
    if (attempt === "rewrite" && hasFallback) return "fallback";
    return "passedOn";
  }
  return attempt === "composed" && !check.onlyLogged ? "rewrite" : "sendAndLog";
}
