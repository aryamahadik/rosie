// K-09 v1.11's table of the plain steps asked with buttons (T-1478; README default 180, from the S1-04 design ruling's
// card 1, DL-999): by step, each option in the order the step's message sends its buttons, with the button's words, its
// definition and the answer fields it carries. `BUTTONS_OPTIONS` in contracts/tool-api/tool-api.rules.mjs holds the same
// values, and buttons.test.ts holds this table to it word for word, so the two never drift. The bundle holds no branch,
// Means line or card for such a step (master-A.json gives S1-04 no branches), so decide reads its options by these
// definitions (arch 03 line 181).
//
// The definitions are words decide reads, never words a person is sent. "Each is its own"'s is the master's Means line
// (MASTER-FLOW-A line 95); the other two are the contract's declared words, a default until Jay answers (K-09 open gap
// 148). A K-01 minor version that lets a plain step carry its options retires this table (K-09 open gap 158).

import type { AnswerField } from "../../assemble/types";

/** One option of a buttons step: its button's words, word for word, its definition and its answer fields. */
export interface ButtonsOption {
  readonly label: string;
  readonly definition: string;
  readonly fields: readonly AnswerField[];
}

/** The table (K-09 README default 180), by step. A step it does not list is never offered (default 179: fail closed). */
export const BUTTONS_OPTIONS: Readonly<Record<string, readonly ButtonsOption[]>> = Object.freeze({
  "S1-04": Object.freeze([
    Object.freeze({
      label: "Some share one",
      definition:
        "some of the kinds of work share one company, with one tax number, and each other kind is its own.",
      fields: Object.freeze([
        Object.freeze({ name: "shared_kinds", type: "text" }),
        Object.freeze({ name: "company_name", type: "text" }),
      ]),
    }),
    Object.freeze({
      label: "All share one",
      definition: "every kind of work shares one company, with one tax number.",
      fields: Object.freeze([Object.freeze({ name: "company_name", type: "text" })]),
    }),
    Object.freeze({
      label: "Each is its own",
      definition: "no two kinds of work share a tax number.",
      fields: Object.freeze([]),
    }),
  ]),
});

/** The step's table entry, or null when the table lists no such step (never a property of Object's own prototype). */
export function buttonsOptionsOf(step: string): readonly ButtonsOption[] | null {
  return Object.hasOwn(BUTTONS_OPTIONS, step) ? (BUTTONS_OPTIONS[step] ?? null) : null;
}
