// Whose word gives a yes to texts (T-590; C-102; S13-32; RULES 7.1, 2.5; MC C9): the one rule a step asks before it
// records a yes, so no journey writes its own (build prompt 3.5).
//
// S13-32 as the bundle compiles it: "A yes to texts: their own number given for this booking, a team join, or a yes on a
// forwarded link." "Never on someone else's word: not a brother, a parent, a payer, or the person a job is about." "The
// business's word counts only for someone who gave the business their number for this booking." "The payer gives their
// own OK to texts on their link. Rosie texts the payer only after that OK." RULES 2.5: "A walk-in and a job the business
// adds itself (BOOK) are the business's own; Rosie texts those customers only after the business adds their yes to texts."
//
// yesCounts takes how a yes was given and whose word it is, as labels, and answers whether it is a yes to texts:
//   - the person's own word counts, by each of the three ways: their own number given for this booking, a team join (their
//     own ready text from the mobile the owner entered: S2-05 under MC C9), or a yes on a forwarded link (their own link:
//     the payer's own OK, B4-27's adult on their own link);
//   - the business's word counts only for a number given for this booking, and only for someone who gave the business
//     that number for this booking (a walk-in or a job the business adds: RULES 2.5; A3-30). Never for a team join (the
//     owner's tick alone joins nobody: Q-08's default; S2-09 "Never: join someone on another person's word") nor for a
//     link, which is the person's own;
//   - anyone else's word never counts: the booker's for someone else, a brother's or a parent's (family), a payer's, the
//     word of the person a job is about, or an AI that only carries messages (S13-31; A3-03).
// Labels in, labels out: nothing here reads a record or a person's words.

import { StopHomeError } from "./errors";

/** How a yes to texts was given (S13-32's three ways). */
export const YES_WAYS = ["numberForBooking", "teamJoin", "forwardedLink"] as const;
export type YesWay = (typeof YES_WAYS)[number];

/** Whose word it is: the person's own, the business's, or someone else's (S13-32's list, and an AI that carries messages). */
export const WHOSE_WORDS = ["self", "business", "booker", "family", "payer", "jobSubject", "agent"] as const;
export type WhoseWord = (typeof WHOSE_WORDS)[number];

/** One yes to texts as the step that would record it knows it. */
export interface YesGiven {
  readonly way: YesWay;
  readonly whose: WhoseWord;
  /** The person gave the business their own number for this booking: a walk-in or a job the business adds (RULES 2.5). */
  readonly gaveBusinessTheirNumber: boolean;
}

/** Why a yes counts, or why it does not (labels). */
export type YesCountsWhy =
  /** Their own word, by one of the three ways. */
  | "ownWord"
  /** The business's word for someone who gave the business their number for this booking (RULES 2.5). */
  | "businessForThem"
  /** The business's word for someone who did not give the business their number for this booking. */
  | "businessNotForThem"
  /** The business's word for a team join or a link, which only the person's own word gives (Q-08; S2-09). */
  | "businessNotThisWay"
  /** Someone else's word: never (S13-32). */
  | "someoneElse";

export interface YesCounts {
  readonly yes: boolean;
  readonly why: YesCountsWhy;
}

/** Whether a yes given this way, on this word, is a yes to texts (see the top of this file). */
export function yesCounts(given: YesGiven): YesCounts {
  const { way, whose, gaveBusinessTheirNumber }: Record<string, unknown> = { ...given };
  if (!(YES_WAYS as readonly unknown[]).includes(way))
    throw new StopHomeError("the yes's way is not one of S13-32's three");
  if (!(WHOSE_WORDS as readonly unknown[]).includes(whose))
    throw new StopHomeError("the yes's word is not one the stop home knows");
  if (typeof gaveBusinessTheirNumber !== "boolean")
    throw new StopHomeError("gaveBusinessTheirNumber is not true or false");
  if (whose === "self") return { yes: true, why: "ownWord" };
  if (whose !== "business") return { yes: false, why: "someoneElse" };
  if (way !== "numberForBooking") return { yes: false, why: "businessNotThisWay" };
  return gaveBusinessTheirNumber
    ? { yes: true, why: "businessForThem" }
    : { yes: false, why: "businessNotForThem" };
}
