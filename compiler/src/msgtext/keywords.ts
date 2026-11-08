// The guard's keyword list (T-134; C-064; K-01 v1 `keywords`, in the manifest's shared lists `lists.keywords`).
//
// Architecture section 02, step 3 (line 115): "Code alone acts on a text that is only START, HELP or one of
// msgtext.js's 16 opt-out words, such as STOP, CANCEL, OPT OUT or PARA. CANCEL or CANCELAR also flags the visit
// (RULES 7.4; S13-28 rule 46)." The bundle carries this one list, and the guard (C-051), the lint (C-065 to C-070) and
// the message checks (C-092) all read it from there, so none of them types a word list of its own.
//
//   start       START (arch 02 line 115; RULES 7.5).
//   help        HELP (arch 02 line 115; S13-32; RULES 7.6).
//   optOut      msgtext.js's 16 opt-out words, read from the script itself (OPTOUT, line 29; script.ts), in its order.
//   flagsVisit  the opt-out words that also flag the visit, CANCEL and CANCELAR (arch 02 line 115). Each must be one of
//               the script's opt-out words, or the list is refused.
import { readOptOut } from "./script";

/** K-01 v1's keywords: the guard's keyword list. */
export interface Keywords {
  start: "START";
  help: "HELP";
  optOut: string[];
  flagsVisit: string[];
}

/** The opt-out words that also flag the visit (arch 02 line 115; RULES 7.4; S13-28 rule 46). */
const FLAGS_VISIT: readonly string[] = ["CANCEL", "CANCELAR"];

/** The guard's keyword list, a fresh object each call. Throws if a word that flags the visit is not an opt-out word. */
export function buildKeywords(): Keywords {
  const { words, file, line } = readOptOut();
  for (const word of FLAGS_VISIT) {
    if (!words.includes(word))
      throw new Error(`${word} flags the visit but is not an opt-out word of ${file} line ${String(line)}`);
  }
  return { start: "START", help: "HELP", optOut: words, flagsVisit: [...FLAGS_VISIT] };
}

/** The keyword list as the compiler emits it, keywords.json: JSON with two-space indents and a closing newline. */
export function keywordsJson(): string {
  return `${JSON.stringify(buildKeywords(), null, 2)}\n`;
}
