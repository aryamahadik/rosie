// C9 (Master Corrections section 3 and section 8 "SMS"; DECISIONS DL-012; RULES 4.1b; QUESTIONS Q-30): no SMS is sent,
// and Rosie never writes first, by iMessage or SMS.
//
// The master texts people who have not texted Rosie: each staff member gets one invite and a reminder (S2-05, S2-07),
// the owner a helper names gets a text with their link (S1-77), the emergency contact a text asking for their yes
// (S1-78), and a code goes by text to a mobile to prove it (S1-10, S13-45). What holds: the chat link, with a QR code
// beside it wherever a screen shows it, reaches the person through whoever is in front of them; the person's own text
// from it opens the chat, and Rosie answers in that chat. For staff the owner gets each person's link and QR to pass on,
// and that person's sent ready text is their yes to join (the "Says yes" branch); after 48 hours with none, the owner is
// told once and given the link again, in place of the reminder text. A code meant for a mobile that has not texted in:
// Rosie asks them to text from that mobile instead, since that text proves it; for a booking with an email, the code
// may go by email (DD). "Never opened": each new booking's confirmation carries the link again; nothing is texted.
//
// What this file changes (the card's steps): S2-05 and its "Says yes" step S2-06, S2-07, S1-10's phone code, S13-45's
// codes, S1-77's text to the owner, S1-78's text to the contact, the confirmations A6-14 and B6-13, and S13-01 (the
// first text of a thread is Rosie's first reply in a chat the person opened, Q-30). Where the opt-out line renders is
// stops.ts. The C9 paths that stay out of scope (S1-75's and S1-35's texts to the listing's phone, A3-30's and B3-08's
// "1 Yes, send the link") are T-147's markers (C-252 to C-254), not changed here.
//
// The new words are drafts in the meaning of C9; the steps' sources decide the meaning, Jay the final wording (DD).
import type { Correction, EditContext, LineRule } from "./framework";

type Obj = Record<string, unknown>;
type Line = readonly unknown[];

/** The lanes with a number Rosie could text first. */
const NUMBER_LANES: readonly string[] = ["cust", "owner", "staff", "other"];

/** The owner's message that replaces S2-05's invites. */
export const JOIN_LINKS_TEXT =
  "Here's each person's own link to join, with its QR. Pass each one on: their text from it is their yes to join.";

/** What a person's link card line says for each person named. */
export function linkLine(person: string): string {
  return `${person}: own link and QR`;
}

/** S2-05's own lines: each master line (or a trade's spelling of it) and what holds in its place. */
export const S2_05_LINES: readonly LineRule[] = [
  [/^Texts each person one invite$/, "Gives the owner each person's join link"],
  [
    /^Rosie texts one invite to each person .{1,40} said agreed(?:, .{1,40} too)?\. Nothing else is sent until they reply YES\.$/,
    "Rosie texts no invite, since Rosie never writes first. The owner gets each person's own link and QR to pass on. Their text from it is their yes to join.",
  ],
  [
    /^Invites go 9am to 8pm their time\. One reminder after 48 hours\.$/,
    "No invite is texted. The owner passes each link on, with its QR beside it on a screen.",
  ],
  [
    /^The invite never asks for a license number\. Anyone may add one after YES/,
    "The link never asks for a license number. Anyone may add one after joining",
  ],
  [/, then the invite again\.$/, ", then the yes to join is asked again."],
  [
    /^Means 'Says yes': any clear yes to join, in any words\.$/,
    "Means 'Says yes': they send the ready text from their link, or any clear yes to join in that chat.",
  ],
  [
    /^Means 'No reply': no answer 48 hours after the invite\. The one reminder goes then\.$/,
    "Means 'No reply': no text from their link 48 hours after the owner got it. The owner is told once, with the link again.",
  ],
  [
    /^Safe default: not joined, with one reminder, and (.{1,40}) is told\.$/,
    "Safe default: not joined, and $1 is told once, with the link again.",
  ],
];

/** The line S2-06 (the "Says yes" step) gains: the ready text is the person's first text and their yes. */
export const READY_TEXT_JOINS =
  "Their first text is the ready text from their link, with its short code. It opens the chat and is their yes to join.";

/** S2-07's own lines (the person is named: Avery in the master, a trade's own name elsewhere). */
export const S2_07_LINES: readonly LineRule[] = [
  [/^Reminds once, then tells (.{1,40})$/, "Tells $1 once, with the link again"],
  [
    /^(.{1,40}) doesn't answer the invite, so Rosie sends one reminder\. 48 hours later, Rosie stops texting \1 and tells (.{1,40})\.$/,
    "$1 sends no text from their link. After 48 hours, Rosie tells $2 once and gives the link again. Nothing is texted to $1.",
  ],
  [
    /^(.{1,40}) can't be booked until \1 replies YES\.$/,
    "$1 can't be booked until $1 texts from their link.",
  ],
  ["One reminder only, never a chase.", "No reminder is texted, and never a chase."],
  [
    /^(.{1,40}) hasn't answered the invite, so I won't text \1 again\.$/,
    "$1 hasn't texted from their link yet. Here it is again, with its QR, to pass on.",
  ],
  [
    /^Not offered to customers until (.{1,40}) replies YES$/,
    "Not offered to customers until $1 texts from the link",
  ],
];

/** S1-10: Rosie asks for the text from the mobile in place of a code texted to it. */
export const ASK_FROM_MOBILE = "Please text me from that mobile. Your text proves the phone is yours.";
const FROM_MOBILE = "Texting you from that mobile now";
const S1_10_LINES: readonly LineRule[] = [
  [
    / and texts the secure ID check to it\. The 4-digit code texted with it, typed on the page, proves the phone; opening it never does\./,
    ", and asks them to text Rosie from it. That text proves the phone; opening a link never does.",
  ],
];

/** S13-45's new lines: a code is never texted to a mobile that has not texted in. */
export const CODE_FROM_MOBILE =
  "A code is never texted to a mobile that has not texted Rosie. They text Rosie from it instead: that text proves it.";
export const CODE_BY_EMAIL = "For a booking with an email, that code may go by email instead.";
export const NEW_PHONE_FROM_MOBILE =
  "A new phone that has not texted Rosie gets no code: they text Rosie from it, and that text proves it.";

/** S1-77's lines: the helper passes the owner's link on; Rosie never texts the owner first. */
const S1_77_LINES: readonly LineRule[] = [
  [
    /^The helper fills in the owner's name and mobile on one card, and says the owner agreed to a text from Rosie\.$/,
    "The helper fills in the owner's name and mobile on one card, and gets the owner's own link and QR to pass on.",
  ],
  [
    /^Never: count the helper's yes as the owner's, or text the owner without saying it's Rosie\.$/,
    "Never: count the helper's yes as the owner's, or text the owner before the owner texts Rosie.",
  ],
  [
    "Did the owner agree to a text from Rosie?",
    "What's the owner's name and mobile? You'll get their own link and QR to pass on.",
  ],
];
export const OWNER_OPENS_CHAT =
  "Rosie never texts the owner first. The owner's own text from that link opens their chat.";
const OWNER_LINK_TEXT =
  "Here's the owner's own link and QR. Pass it on: their text from it opens their chat with Rosie.";
const OWNER_READY_TEXT = "[ready text] Hey, I'm the owner. Code 4829";

/** S1-78's lines: the owner passes the contact's link on; the contact's own text is their yes. */
const S1_78_LINES: readonly LineRule[] = [
  [
    "Rosie texts the contact once for their own yes. Until that yes, no contact is on file.",
    "Rosie never texts the contact first. The owner passes on the contact's own link and QR. Until their yes, no contact is on file.",
  ],
  [
    "Never: text the contact before the owner says they agreed.",
    "Never: text the contact before the contact texts Rosie from that link.",
  ],
];
const CONTACT_LINK_TEXT =
  "Here's your contact's own link and QR to pass on. Their text from it opens their chat with Rosie.";
const CONTACT_READY_TEXT = "[ready text] Hi Rosie, I'm the emergency contact. Code 4829";

/** A6-14 and B6-13: a chat never opened gets the link again on each new booking's email and page. */
export const NEVER_OPENED =
  "Chat never opened: each new booking's email and page carry the chat link and its QR again. Nothing is texted.";
const CONFIRMATIONS: Readonly<Record<"A" | "B", string>> = { A: "A6-14", B: "B6-13" };
/** C2's line about where the confirmation goes, which the C9 line follows. */
const CONFIRMATION_WHERE = /^Where they take texts, the confirmation goes in the chat/;

/** S13-01's new lines (Q-30): the first text of a thread is Rosie's first reply in a chat the person opened. */
export const FIRST_REPLY_LINES: readonly string[] = [
  "Rosie never writes first: the first text of a thread is Rosie's first reply in a chat the person opened.",
  "That reply carries the opener, the opt-out line and the privacy link.",
];

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function elementsOf(message: Line): Obj | undefined {
  const elements = message[3];
  return isObj(elements) ? elements : undefined;
}

function sayOf(ctx: EditContext, id: string): readonly Line[] {
  const say = ctx.step(id)?.say;
  return Array.isArray(say) ? say : [];
}

function moreOf(ctx: EditContext, id: string): readonly string[] {
  const more = ctx.step(id)?.more;
  return Array.isArray(more) ? more : [];
}

/** Rosie's text to a number that the master marked as possibly that number's first text: Rosie writing first. */
function writesFirst(message: Line): boolean {
  return (
    message[0] === "san" && NUMBER_LANES.includes(String(message[1])) && elementsOf(message)?.stop === "first"
  );
}

/** Adds `text` to the step's `more` after the first line `after` matches (at the end when none does), unless it is there. */
function addMore(ctx: EditContext, id: string, after: RegExp | null, text: string): void {
  const step = ctx.step(id);
  if (step === undefined) return;
  if (!Array.isArray(step.more)) {
    ctx.set(id, ["more"], [text]);
    return;
  }
  const more = moreOf(ctx, id);
  if (more.includes(text)) return;
  const k = after === null ? -1 : more.findIndex((line) => after.test(line));
  ctx.insert(id, ["more"], k >= 0 ? k + 1 : more.length, text);
}

/** Takes `lane` off the step's `tells` and makes sure `keep` is on it. */
function retell(ctx: EditContext, id: string, lane: string, keep: string): void {
  const tells = ctx.step(id)?.tells;
  if (!Array.isArray(tells)) return;
  const next = tells.filter((who) => who !== lane);
  if (!next.includes(keep as (typeof tells)[number])) next.push(keep as (typeof tells)[number]);
  if (next.length !== tells.length || next.some((who, k) => who !== tells[k])) ctx.set(id, ["tells"], next);
}

/** The owner's message with each invited person's link and QR, in place of the invites. */
function joinLinks(invites: readonly Line[]): Line {
  const people = invites.map((message) => {
    const as = elementsOf(message)?.as;
    return typeof as === "string" && as !== "" ? as : String(message[1]);
  });
  return [
    "san",
    "owner",
    JOIN_LINKS_TEXT,
    {
      card: {
        title: "Join links for your team",
        lines: people.map(linkLine),
        button: "Open the Team page",
        link: "rosfield.com/s/team",
      },
    },
  ];
}

/** A say list with Rosie's first-writing texts replaced by the owner's link message, or null when it has none. */
function withoutInvites(say: readonly Line[]): Line[] | null {
  const invites = say.filter(writesFirst);
  if (invites.length === 0) return null;
  return [joinLinks(invites), ...say.filter((message) => !writesFirst(message))];
}

function teamInvite(ctx: EditContext): void {
  const id = "S2-05";
  const step = ctx.step(id);
  if (step === undefined) return;
  const say = withoutInvites(sayOf(ctx, id));
  if (say !== null) ctx.set(id, ["say"], say);
  for (const [key, patch] of Object.entries(step.vary ?? {})) {
    if (!isObj(patch)) continue;
    for (const list of ["say", "addSay"]) {
      const words = patch[list];
      if (!Array.isArray(words)) continue;
      const next = withoutInvites(words as Line[]);
      if (next !== null) ctx.set(id, ["vary", key, list], next);
    }
  }
  ctx.rewriteLines(id, S2_05_LINES, ["title", "does", "more"]);
  if (ctx.step(id)?.to === "staff") ctx.set(id, ["to"], "owner");
  retell(ctx, id, "staff", "owner");
  if (ctx.step("S2-06") !== undefined) addMore(ctx, "S2-06", null, READY_TEXT_JOINS);
}

function teamReminder(ctx: EditContext): void {
  const id = "S2-07";
  if (ctx.step(id) === undefined) return;
  const say = sayOf(ctx, id);
  for (let k = say.length - 1; k >= 0; k -= 1) {
    const message = say[k];
    if (message === undefined) continue;
    if (message[0] === "san" && message[1] !== "owner" && NUMBER_LANES.includes(String(message[1])))
      ctx.remove(id, ["say", k]);
  }
  ctx.rewriteLines(id, S2_07_LINES, ["title", "does", "more", "say"]);
  sayOf(ctx, id).forEach((message, k) => {
    const card = elementsOf(message)?.card;
    if (!isObj(card) || typeof card.title !== "string" || !Array.isArray(card.lines)) return;
    const named = /^(.{1,40}) · not joined$/.exec(card.title);
    const person = named?.[1];
    if (person === undefined) return;
    const line = linkLine(person);
    if (!(card.lines as unknown[]).includes(line)) ctx.insert(id, ["say", k, 3, "card", "lines"], 0, line);
  });
  retell(ctx, id, "staff", "owner");
}

/** Removes every card line of the step's messages that `pattern` matches (last first, so the indexes stay true). */
function dropCardLines(ctx: EditContext, id: string, pattern: RegExp): void {
  sayOf(ctx, id).forEach((message, k) => {
    const card = elementsOf(message)?.card;
    if (!isObj(card) || !Array.isArray(card.lines)) return;
    const lines = card.lines as unknown[];
    for (let j = lines.length - 1; j >= 0; j -= 1) {
      const line = lines[j];
      if (typeof line === "string" && pattern.test(line)) ctx.remove(id, ["say", k, 3, "card", "lines", j]);
    }
  });
}

/** A code texted to prove a phone: the card line "Code 4829: type it on the page to prove this phone". */
const CODE_PROVES_PHONE = /\bcode\b.*\bprove (?:this|the) phone\b/i;

function ownerMobile(ctx: EditContext): void {
  const id = "S1-10";
  if (ctx.step(id) === undefined) return;
  ctx.rewriteLines(id, S1_10_LINES, ["does", "more"]);
  dropCardLines(ctx, id, CODE_PROVES_PHONE);
  const say = sayOf(ctx, id);
  if (say.some((message) => message[2] === ASK_FROM_MOBILE)) return;
  const k = say.findIndex(
    (message) => message[0] === "san" && message[1] === "owner" && isObj(elementsOf(message)?.card),
  );
  if (k < 0) return;
  ctx.insert(id, ["say"], k, ["san", "owner", ASK_FROM_MOBILE]);
  ctx.insert(id, ["say"], k + 1, ["owner", "san", FROM_MOBILE]);
}

function proofCodes(ctx: EditContext): void {
  const id = "S13-45";
  if (ctx.step(id) === undefined) return;
  addMore(
    ctx,
    id,
    /^Or a code is sent to the contact on file and typed back in the same conversation\./,
    CODE_FROM_MOBILE,
  );
  addMore(ctx, id, new RegExp(`^${escape(CODE_FROM_MOBILE)}$`), CODE_BY_EMAIL);
  addMore(ctx, id, /^No special "not safe" mode/, NEW_PHONE_FROM_MOBILE);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Inserts the person's ready text (and, before it, the owner's or helper's link message) before Rosie's first text to them. */
function readyTextFirst(
  ctx: EditContext,
  id: string,
  to: string,
  link: Line,
  ready: (as: string | undefined) => Line,
): void {
  const say = sayOf(ctx, id);
  if (say.some((message) => message[2] === link[2])) return;
  const k = say.findIndex(
    (message) =>
      writesFirst(message) && message[1] === to && (to !== "owner" || elementsOf(message)?.as === undefined),
  );
  const message = say[k];
  if (message === undefined) return;
  const as = elementsOf(message)?.as;
  ctx.insert(id, ["say"], k, link);
  ctx.insert(id, ["say"], k + 1, ready(typeof as === "string" ? as : undefined));
}

function helperOwner(ctx: EditContext): void {
  const id = "S1-77";
  if (ctx.step(id) === undefined) return;
  ctx.rewriteLines(id, S1_77_LINES, ["more", "say"]);
  addMore(ctx, id, /^The helper fills in the owner's name and mobile/, OWNER_OPENS_CHAT);
  // The helper's question no longer asks whether the owner agreed to a text: its buttons go.
  sayOf(ctx, id).forEach((message, k) => {
    if (message[2] === S1_77_LINES[2]?.[1] && elementsOf(message)?.buttons !== undefined)
      ctx.remove(id, ["say", k, 3, "buttons"]);
  });
  const helper = sayOf(ctx, id).find(
    (message) => message[0] === "san" && elementsOf(message)?.as !== undefined,
  );
  const helperAs = elementsOf(helper ?? [])?.as;
  const link: Line =
    typeof helperAs === "string"
      ? ["san", "owner", OWNER_LINK_TEXT, { as: helperAs }]
      : ["san", "owner", OWNER_LINK_TEXT];
  readyTextFirst(ctx, id, "owner", link, () => ["owner", "san", OWNER_READY_TEXT]);
  dropCardLines(ctx, id, CODE_PROVES_PHONE);
}

function emergencyContact(ctx: EditContext): void {
  const id = "S1-78";
  if (ctx.step(id) === undefined) return;
  ctx.rewriteLines(id, S1_78_LINES, ["more"]);
  readyTextFirst(ctx, id, "other", ["san", "owner", CONTACT_LINK_TEXT], (as) =>
    as === undefined ? ["other", "san", CONTACT_READY_TEXT] : ["other", "san", CONTACT_READY_TEXT, { as }],
  );
  const tells = ctx.step(id)?.tells;
  if (Array.isArray(tells) && sayOf(ctx, id).some((message) => message[2] === CONTACT_LINK_TEXT))
    retell(ctx, id, "", "owner");
}

function confirmation(ctx: EditContext): void {
  const id = CONFIRMATIONS[ctx.flow];
  if (ctx.step(id) === undefined) return;
  addMore(ctx, id, CONFIRMATION_WHERE, NEVER_OPENED);
}

function opener(ctx: EditContext): void {
  const id = "S13-01";
  if (ctx.step(id) === undefined) return;
  const more = moreOf(ctx, id);
  FIRST_REPLY_LINES.forEach((line, k) => {
    if (!more.includes(line)) ctx.insert(id, ["more"], Math.min(k, moreOf(ctx, id).length), line);
  });
}

/** The steps C9 changes, in each flow. */
export const C9_STEPS: Readonly<Record<"A" | "B", readonly string[]>> = {
  A: ["S2-05", "S2-06", "S2-07", "S1-10", "S13-45", "S1-77", "S1-78", "A6-14", "S13-01"],
  B: ["S2-05", "S2-06", "S2-07", "S1-10", "S13-45", "S1-77", "S1-78", "B6-13", "S13-01"],
};

/** C9: no SMS; Rosie never writes first; the chat link and QR reach the person through whoever is in front of them. */
export const c9: Correction = {
  id: "C9",
  title: "No SMS; Rosie never writes first: links and QR codes open the chat",
  source:
    "Master Corrections C9; section 8 (SMS); DECISIONS DL-012; RULES 4.1b, 4.3, 1.11; QUESTIONS Q-30 default; SPEC-master 5j",
  apply(ctx) {
    teamInvite(ctx);
    teamReminder(ctx);
    ownerMobile(ctx);
    proofCodes(ctx);
    helperOwner(ctx);
    emergencyContact(ctx);
    confirmation(ctx);
    opener(ctx);
  },
};
