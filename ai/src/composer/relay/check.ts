// The reader's checks on a composed plan (T-375, C-118): what each reader must and must not read, held before the plan
// leaves the AI layer, as every other check on it is (../check.ts planAgainstInput runs these last, on a whole plan that
// keeps to its formats and its facts). In this order, each failure a typed refusal that names a check and a place, never
// words (K-08 README line 75):
//
//   relayQuote     a relayed sender is quoted through {{relay.quote}}, once, never typed (./quote.ts; arch 07 line 359;
//                  S13-37; CQ-109);
//   sensitiveWork  a gentle row (grief, safety or sensitive work) names no sample service or name, and gives a service
//                  slot no words of its own after "|" (./sensitive.ts; S13-22; RULES 4.6);
//   tone           a gentle row has no "!" (./tone.ts; arch 07 line 357);
//   language       an English or Spanish row is answered in its own language (./language.ts; arch 06 line 341).
//
// What the model reads is held too: private words only as "a private detail" (./private.ts, through the prompt's
// render), and the tag and the language as code gave them.

import type { ComposeInput, MessagePlan } from "../prompt";
import type { ComposeProblem } from "../types";
import { languageProblems } from "./language";
import { quoteProblems } from "./quote";
import { sensitiveProblems } from "./sensitive";
import { toneProblems } from "./tone";

/** Every way a whole plan does not give its reader what the row's quote, tag and language call for; empty when none. */
export function readerProblems(plan: MessagePlan, input: ComposeInput): ComposeProblem[] {
  return [
    ...quoteProblems(plan, input),
    ...sensitiveProblems(plan, input),
    ...toneProblems(plan, input),
    ...languageProblems(plan, input),
  ];
}
