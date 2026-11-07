// C1 (Master Corrections section 3; D102; RULES 4.1, 7.2, 7.5, 7.6): one Rosie number for every business, and STOP stops
// Rosie's texts to that phone for every business until START turns them back on.
//
// The master says "Each business texts from its own Rosie number." and its stop replies say "Texts from <business> are
// off." What holds: the number is Rosie's, one for every business (owner sign-up and support use it too). A stop
// reply says Rosie's texts to this number are off for every business, never one business's. A fresh yes on a new
// booking, sent from that number, turns on that booking's texts only; a booking made any other way sends that phone no
// text (ACCEPTED.md line 22). Each business with an open booking for that phone hears only "Texts to this customer are
// off. Reach them their way." (RULES 7.5). HELP gets Rosie's name and number (RULES 7.6). A call says Rosie's number
// (S13-32).
//
// What this file changes (the card's steps): S13-32's lines that name a business's own number; the stop replies of
// A7-11, B7-15, A7-98, B7-88 and S2-08, wherever a trade's words left them. What it leaves, because Master Corrections
// leaves the decision to Jay (DD): the owner's Call button (S11-40), the door-check line (B8-02) and put-through calls
// (S12-12); the business's own listed phone (A10-13, S1-75, S1-35, B3-03) stays the business's.
//
// The stop replies' exact words are Jay's (Q-01): the lines below are DRAFT MEANING ONLY, in C1's every-business sense,
// and go to Jay on the M3b tier 3 card before any release. Nothing here is final wording.
import type { Correction, EditContext, LineRule } from "./framework";

/** DRAFT (Q-01 default, not final words): what a stop reply says in place of "Texts from <business> are off". */
export const STOP_OFF_DRAFT = "Rosie's texts to this number are off for every business";

/** DRAFT (Q-01 default, not final words): what a stop step's description says in place of "Texts from this business stop at once". */
export const STOP_AT_ONCE_DRAFT = "Rosie's texts to this number stop at once, for every business";

/**
 * The master's wording of a stop, with any business name or word for the business (a trade's overlay renames the
 * business, and a few trades say "the studio"): "Texts from this business stop at once", "Texts from Lee's Barbershop
 * are off", "Texts from Lee Home Services to this number are off".
 */
const STOP_ONE_BUSINESS = /Texts from [^.\n]{1,80}? (?:to this number )?(are off|stop at once)/gi;

/** The steps whose stop reply the correction rewrites, in each flow. */
export const STOP_REPLY_STEPS: Readonly<Record<"A" | "B", readonly string[]>> = {
  A: ["A7-11", "A7-98", "S2-08"],
  B: ["B7-15", "B7-88", "S2-08"],
};

/** S13-32's own lines (the rule is the same text in both flows): each exact master line and what holds in its place. */
export const S13_32_LINES: readonly LineRule[] = [
  [
    "Every call says who's calling, that it's automated and recorded, and the business's number.",
    "Every call says who's calling, that it's automated and recorded, and Rosie's number.",
  ],
  [
    "A machine, or someone else who answers, hears only the business's name and number. Never the service, never a code.",
    "A machine, or someone else who answers, hears only the business's name and Rosie's number. Never the service, never a code.",
  ],
  [
    "It stops the texts sent from the number it answers, at once. Each business texts from its own Rosie number.",
    "It stops Rosie's texts to that phone for every business, at once, until START turns them back on. Every business texts from the one Rosie number.",
  ],
  [
    "That business hears only: 'Texts to this customer are off. Reach them their way.' Never where it came from.",
    "Each business with an open booking for that phone hears only: 'Texts to this customer are off. Reach them their way.' Never where it came from.",
  ],
  [
    "Only START, or a fresh yes on a new booking sent from that number, turns that booking's texts back on.",
    "Only START turns Rosie's texts to that phone back on, for every business. A fresh yes on a new booking, sent from that number, turns on that booking's texts only. A booking made any other way sends that phone no text.",
  ],
  [
    "HELP gets the business's name and number, and how to stop.",
    "HELP gets Rosie's name and number, and how to stop.",
  ],
  // These two name a reviewer ("the lawyer"; a trade says "the compliance reviewer" or "the investigator").
  [
    /^(For the [^:\n]{1,40}: the once-only opt-out line), also when each business texts from its own number\.$/,
    "$1, with one Rosie number for every business.",
  ],
  [
    /^If all businesses text from ONE shared number, a STOP stops them all\. That's the strict default until the [^.\n]{1,40} says otherwise\.$/,
    "Every business texts from ONE Rosie number, so a STOP stops them all.",
  ],
];

/**
 * The reply some trades word for themselves (advisor, allergist, dentist's flow B, towing ...): "You won't get more
 * texts from Rosie for Lee Wealth." (the business's name follows "for", up to the full stop).
 */
const WONT_GET_FOR_ONE_BUSINESS = /You won't get more texts from Rosie for [^.\n]{1,80}\./g;

/** A stop that names one business, said for every business (the draft meaning). */
export function everyBusiness(text: string): string {
  return text
    .replace(WONT_GET_FOR_ONE_BUSINESS, `${STOP_OFF_DRAFT}.`)
    .replace(STOP_ONE_BUSINESS, (_whole, what: string) =>
      what.toLowerCase() === "are off" ? STOP_OFF_DRAFT : STOP_AT_ONCE_DRAFT,
    );
}

function stopReplies(ctx: EditContext): void {
  for (const id of STOP_REPLY_STEPS[ctx.flow]) {
    ctx.need(id);
    ctx.rewriteText(id, everyBusiness);
  }
}

function ruleLines(ctx: EditContext): void {
  ctx.need("S13-32");
  ctx.rewriteLines("S13-32", S13_32_LINES, ["more"]);
}

/** C1: one Rosie number; STOP stops Rosie's texts to that phone for every business. */
export const c1: Correction = {
  id: "C1",
  title: "One Rosie number for every business; STOP stops every business",
  source:
    "Master Corrections C1; D102 (DECISIONS.md lines 1200-1207); RULES 4.1, 7.2, 7.5, 7.6; Q-01 default",
  apply(ctx) {
    ruleLines(ctx);
    stopReplies(ctx);
  },
};
