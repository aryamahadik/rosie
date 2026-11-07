// C2 (Master Corrections section 3; D103; RULES 4.1b, 4.8, 2.5): a mobile is required, the confirmation is not texted
// in full, and "calls only" is not offered.
//
// The master's reach card (A4-82, B4-93, S13-19) asks "the number or email"; its confirmation (A6-14, B6-13) goes by
// text; and a caller with only a landline books on the call (S13-33, A4-87, B4-109). What holds: a mobile is required
// when the customer or their own AI books; an email stays optional and gets every message. Who may get texts at all is
// unchanged (their way, RULES 4.8; the yes a booking the business adds needs, RULES 2.5). Where they take texts, the
// confirmation goes in the chat if that mobile's chat is open; it is never sent as an SMS, and in full by email and on
// the page. Nothing else is texted to that mobile until it texts in, and no clock or fee runs on a message they didn't
// get (S13-19). A caller with only a landline is set aside by Jay (Nov 4): until it is taken up, "calls only" is not
// offered (DL-029; architecture section 12, "Phone calls") and a landline gets another number asked for.
//
// What this file changes (the card's steps): the words of A4-82, B4-93 and S13-19 about the number, the landline and
// calls only; the Calls only branch and button of the reach card; the confirmation of A6-14 and B6-13; and A4-87,
// B4-109 and S13-33, switched off so no path reaches them.
//
// The new words are drafts in the meaning of C2; the steps' sources decide the meaning, Jay the final wording (DD).
import type { Correction, EditContext, LineRule } from "./framework";

const MOBILE_ASKED = "Please give your mobile number. An email is optional.";

/** Why a step or branch is switched off, as an `off` op's `why`. */
export const CALLS_ONLY_OFF = "calls only is not offered (DL-029): a mobile is required (MC C2)";

const REACH_CARDS: Readonly<Record<"A" | "B", string>> = { A: "A4-82", B: "B4-93" };
const CONFIRMATIONS: Readonly<Record<"A" | "B", string>> = { A: "A6-14", B: "B6-13" };
const CALL_BOOKINGS: Readonly<Record<"A" | "B", readonly string[]>> = {
  A: ["A4-87", "S13-33"],
  B: ["B4-109", "S13-33"],
};

/** The reach card's own lines: each exact master line and what holds in its place. */
export const REACH_CARD_LINES: readonly LineRule[] = [
  // The question the card puts: "... reach you about this visit, and at what number or email?"
  [/, and at what number or email\?/, `? ${MOBILE_ASKED}`],
  [
    "One card comes before the first message that leaves the chat. It asks how to reach them, at what number or email.",
    "One card comes before the first message that leaves the chat. It asks for their mobile number, and how to reach them. An email is optional and gets every message.",
  ],
  [
    "Default: texts to the mobile they give. On a call: the caller's number.",
    "Default: texts to the mobile they give.",
  ],
  [
    "The line check runs inside this card, on the number given, before a branch is taken.",
    "The line check runs inside this card, on the mobile given, before a branch is taken.",
  ],
  [
    "A landline is offered Calls only, another number or email, so the branch always fits the line.",
    "A mobile is required. A landline is not taken: they give another number, a mobile. Calls only is not offered.",
  ],
  [
    "Means 'Texts': every message by text, and a call only if they ask.",
    "Means 'Texts': every message by text.",
  ],
  [
    "Means 'Texts only': never a call. Means 'Email': every message and link by email.",
    "Means 'Texts only': never a call. Means 'Email': every message and link also by email, and the mobile is still required.",
  ],
  [
    "The number or email given here is the one used, whatever phone they're writing from.",
    "The mobile given here is the one used, whatever phone they're writing from. An email, if given, gets every message too.",
  ],
];

/** The reach card's lines about calls only, which go. */
const CALLS_ONLY_LINES: readonly RegExp[] = [/^Means 'Calls only':/, /^Calls only changes how messages go/];

const TEXTED_FIRST = /^Never text a number before this answer\./;
const NOTHING_ELSE =
  "Nothing else is texted to that mobile until it texts in. No clock or fee runs on a message they didn't get.";

/** S13-19's own lines. */
export const S13_19_LINES: readonly LineRule[] = [
  [
    "The card asks the number or email, and the way: texts, calls only, texts only, or email.",
    "The card asks for a mobile (an email is optional), and the way: texts, texts only, or email.",
  ],
  // "shop-added" is a trade's word for its business: "clinic-added", "studio-added" ...
  [
    /^A landline is offered calls only, another number, or email\. It's asked once, never twice, (.{1,40}-added bookings too\.)$/,
    "A mobile is required. A landline is not taken: they give another number, a mobile. It's asked once, never twice, $1",
  ],
  [
    "A text that fails later moves them to calls only, told their way. Texts only: relay or video relay instead, never a voice call.",
    "A text that fails later: they're told their way, by email or on the booking page. Calls are not offered. Texts only: relay or video relay instead, never a voice call.",
  ],
];
const S13_19_CALLS_ONLY: readonly RegExp[] = [
  /^Calls only: never a text\./,
  /^Calls only never changes the money\./,
];
const REPLY_CLOCK = /^A reply clock starts only once they were reached their way\./;

/** The confirmation's call line (the read-back on a call), which becomes the line about where the confirmation goes. */
const CONFIRMATION_ON_CALL = "On a call, the read-back on the call was the confirmation";
const CONFIRMATION_WHERE =
  "Where they take texts, the confirmation goes in the chat if that mobile's chat is open. It is never sent as an SMS. In full by email and on the page.";

function moreOf(ctx: EditContext, id: string): readonly string[] {
  const more = ctx.need(id).more;
  return Array.isArray(more) ? more : [];
}

/** Removes every `more` line that matches one of the patterns (last first, so the indexes stay true). */
function removeLines(ctx: EditContext, id: string, patterns: readonly RegExp[]): void {
  const more = moreOf(ctx, id);
  for (let k = more.length - 1; k >= 0; k -= 1) {
    const line = more[k];
    if (line !== undefined && patterns.some((pattern) => pattern.test(line))) ctx.remove(id, ["more", k]);
  }
}

/** Adds `text` after the first `more` line that matches `after`, unless the step already says it. */
function insertAfter(ctx: EditContext, id: string, after: RegExp, text: string): void {
  const more = moreOf(ctx, id);
  const k = more.findIndex((line) => after.test(line));
  if (k >= 0 && !more.includes(text)) ctx.insert(id, ["more"], k + 1, text);
}

function reachCard(ctx: EditContext): void {
  const id = REACH_CARDS[ctx.flow];
  ctx.need(id);
  ctx.rewriteLines(id, REACH_CARD_LINES);
  removeLines(ctx, id, CALLS_ONLY_LINES);
  insertAfter(ctx, id, TEXTED_FIRST, NOTHING_ELSE);
  // The button goes, then the branch it chose: nothing offers "Calls only" and no path lights it.
  const card = ctx.need(id).say;
  (Array.isArray(card) ? card : []).forEach((message, m) => {
    const buttons = (message as unknown[])[3];
    const list =
      typeof buttons === "object" && buttons !== null
        ? (buttons as { buttons?: unknown }).buttons
        : undefined;
    if (!Array.isArray(list)) return;
    const k = list.indexOf("Calls only");
    if (k >= 0) ctx.remove(id, ["say", m, 3, "buttons", k]);
  });
  // A trade's own `off` of the branch stays as the trade wrote it.
  const branch = (ctx.need(id).branches ?? []).find((candidate) => candidate.label === "Calls only");
  if (branch?.off === undefined) ctx.switchOffBranch(id, "Calls only", CALLS_ONLY_OFF);
}

function reachRule(ctx: EditContext): void {
  const id = "S13-19";
  ctx.need(id);
  ctx.rewriteLines(id, S13_19_LINES);
  removeLines(ctx, id, S13_19_CALLS_ONLY);
  insertAfter(ctx, id, REPLY_CLOCK, NOTHING_ELSE);
}

function confirmation(ctx: EditContext): void {
  const id = CONFIRMATIONS[ctx.flow];
  const k = moreOf(ctx, id).findIndex((line) => line.startsWith(CONFIRMATION_ON_CALL));
  if (k >= 0) ctx.set(id, ["more", k], CONFIRMATION_WHERE);
}

function callBookings(ctx: EditContext): void {
  for (const id of CALL_BOOKINGS[ctx.flow]) {
    // A trade's own `off` of the step (and its reason) stays as the trade wrote it.
    if (ctx.need(id).off === undefined) ctx.switchOff(id, CALLS_ONLY_OFF);
  }
}

/** C2: a mobile is required; the confirmation is not texted in full; "calls only" is not offered. */
export const c2: Correction = {
  id: "C2",
  title: "A mobile is required; no confirmation by SMS; calls only is not offered",
  source: "Master Corrections C2; D103 (DECISIONS.md lines 1208-1221); RULES 4.1b, 4.8; DL-029; S13-19",
  apply(ctx) {
    reachCard(ctx);
    reachRule(ctx);
    confirmation(ctx);
    callBookings(ctx);
  },
};
