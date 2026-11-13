// The core's safety line (T-1140; DL-325, DL-330, DL-341; CQ-163's defaults): which checked line a recordSafetyOutcome
// core action sends, by the rule T-1143 gives the handle actor's direct path (runtime/src/safety/rules.ts checkedLineFor),
// so a danger text gets the same line whichever path records it. It reads the pinned bundle's checked lines (the safety
// service's SafetyLines port: K-01 v1's fixed lines and the outcome steps' lines), and falls back when the bundle lacks
// the outcome's step, as a partial bundle does (bundle v0 holds only S1-01 and S1-02, so no A3 safety step):
//
//   - every danger outcome gets a line: its step's checked line in the pinned bundle; with none, the K-01 fixed line the
//     sources give it (crisis words: safetyCrisis, 988 and 911, A3-25; an emergency: safetyEmergency, 911, A3-24; Unsure:
//     the danger words' line, safetyCrisis for a self-harm word, else 911, arch 02 line 111); and otherwise
//     safetyEmergency, 911, the strictest (harm to a child or older adult, unsafe at home, the business's own line and
//     safety steps: A3-49, A3-50 and A3-26 each give 911 where anyone is in danger; CQ-163 (c): 911 for safety steps,
//     fail closed);
//   - a threat's writer gets none (S13-10; S13-24 rule 11; A3-48: "Someone who threatens others gets no safety
//     message"): its line goes to the owner, who is told at once (A3-48: san to owner): A3-48's own line when the bundle
//     holds it, else safetyEmergency (default 1 below). With crisis words or an emergency in the same text, those come
//     first in the safety service's LINE_ORDER and their line goes to the writer (CQ-163 (a), as built until Jay rules);
//   - only No sends nothing.
// The service asks for the line of the outcome LINE_ORDER puts first (domain/safety/record.ts pickLine) and, for a harm
// report, for harm's hotline, which only the step's own line gives: a fallback names no hotline, since none is ever made
// up (A3-49), so with a partial bundle harm is recorded with its hold and 911 and files no harm report, never refused
// (record.ts default 10; CQ-164 (c), T-1162). The outage line is the bundle's own.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. A threat whose step's line the pinned bundle lacks tells the owner with safetyEmergency (911): no K-01 v1 fixed line
//      holds A3-48's words, and an owner told nothing at once would break A3-48 ("Sam is told at once, at any hour") and
//      A3-22's never-silent rule. A bundle line for a threat addressed to the writer is never sent to the writer: the
//      owner gets safetyEmergency instead.
//   2. A fallback line goes to the writer with no hotline (SafetyLineChoice.hotline null), back on the handle the text
//      came from, past any opt-out as every safety line does (arch 02 line 111).

import type { SafetyLineChoice, SafetyLines, SafetyOutcome } from "../../domain/safety";

/** The strictest safety line, 911 (A3-24; arch 02 line 111): the last stand-in for any danger outcome's line. */
export const STRICTEST_LINE = "safetyEmergency";

/** The outcome whose writer gets no safety line (S13-10; S13-24 rule 11; A3-48). */
const THREAT = "A threat to staff or others" satisfies SafetyOutcome;

/** The K-01 v1 fixed line the sources give each danger outcome but Unsure and a threat (T-1143's FIXED_LINE_OF). */
export const FIXED_LINE_OF: Readonly<
  Record<Exclude<SafetyOutcome, "No" | "Unsure" | typeof THREAT>, "safetyCrisis" | "safetyEmergency">
> = {
  "Crisis words": "safetyCrisis",
  "An emergency": "safetyEmergency",
  "Harm to a child or older adult": STRICTEST_LINE,
  "Unsafe at home": STRICTEST_LINE,
  "Needs the business's own line": STRICTEST_LINE,
  "Safety steps, then go on": STRICTEST_LINE,
};

/** A K-01 fixed line to the writer, with no hotline (default 2). */
const toWriter = (fixedLineId: string): SafetyLineChoice => ({ fixedLineId, to: "writer", hotline: null });

/** The danger words' line for an Unsure read: 988 and 911 for a self-harm word, else 911 (arch 02 line 111). */
const unsureLineOf = (wordKinds: readonly ("selfHarm" | "other")[]): string =>
  wordKinds.includes("selfHarm") ? "safetyCrisis" : STRICTEST_LINE;

/**
 * The core's checked lines over the pinned bundle's: the bundle's line for an outcome first, then the fallbacks above, so
 * the safety service never meets a danger outcome with no line; a threat's line only ever goes to the owner.
 */
export function coreSafetyLines(bundle: SafetyLines): SafetyLines {
  return {
    lineOf(outcome, wordKinds) {
      if (outcome === "No") return null;
      const own = bundle.lineOf(outcome, wordKinds);
      if (outcome === THREAT) {
        return own !== null && own.to === "owner"
          ? own
          : { fixedLineId: STRICTEST_LINE, to: "owner", hotline: null };
      }
      if (own !== null) return own;
      return toWriter(outcome === "Unsure" ? unsureLineOf(wordKinds) : FIXED_LINE_OF[outcome]);
    },
    outageLine: () => bundle.outageLine(),
  };
}
