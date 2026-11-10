// Limit 1, Allowed (C-081, T-299; arch 06 line 299): "A change that only protects: anyone's word (S13-57). A change that
// adds a person, a way in, money or authority: the decider's own yes under S13-45: the person served, or who decides for
// them, for their visit; the owner or a permitted admin for fees, refunds beyond the terms (RULES 3.10), team and
// settings." On failure: "Unproven sender: a code to the contact on file, in words that never confirm a booking exists.
// Wrong person: a question in the decider's own chat." (K-09 v1 limit1Outcome: proofCodeSent, wait; askedDecider, ask.)
//
// For one gated part, in this order:
//   1. What it changes (changeOf): nothing the limit applies to (notChecked); a change that only protects (pass, on
//      anyone's word); S13-45 row 1, open to anyone at its doors (pass); or matters that need the decider's own yes.
//   2. Who decides each matter: T-308's identity and access service (the person served or who decides for them; the
//      owner or an admin the owner lets; the owner alone for closing, export and hand-over), the booker of a booking still
//      being made, or the person themself for their own record.
//   3. Whose word it is (S13-45's one rule first, then its rows): the call's person (K-09 v1 caller.personId, "the
//      sender of the turn's texts"), proven only from their own contact on file for the standing they would act in. An
//      unproven sender in a turn gets a code to that contact on file, typed back in this chat (proofCodeSent); proven, or
//      off the chat, someone T-308 does not name gets a question in each decider's own chat (askedDecider). Nobody to ask:
//      askedDecider with the step's safe default for the commit (S13-31: "When nobody allowed can decide in time, the
//      step's safe default runs and a person is told"), never a question with nobody to put it to.
//
// What an outcome writes (the code, the question, the safe default and who is told) is the commit's (K-09 v1
// limitNOutcome; T-305 default 8): decideAllowed says what, and the limit hands the gate its K-09 outcome. Nothing here
// logs. What it returns names labels, ids and steps, never a person's words, name or number; an unproven sender's code
// and decision name no booking, so they read the same whether or not one exists.
//
// Defaults used (for ops/QUESTIONS.md; round 2 follows the lead's rulings on the card, DL-183):
//   1. Every change that does not only protect needs the decider's own yes, not only one that adds a person, a way in,
//      money or authority: S13-45's rule "Showing, changing or paying waits for the one rule", row 2 "See or change a
//      booking: the person served, by the one rule", S13-57 "or shows something". The exception is row 1 ("Ask, see
//      prices and times, book a new visit: anyone, at any door"): the doors for a new booking, an existing booking (A3-43
//      runs its own code check) and an unclear owner text or HELP, the outage row (S12-11), and a time picked for a new
//      visit about no booking yet at NEW_VISIT_STEPS, the times cards and the pick (agent→cust and cust→agent chat in
//      the step index: A4-14, A4-33, A4-62 and A4-68, A4-15; B4-15, B4-84, B4-85 and B4-89, B4-16). That last one is
//      this round's own default: K-09 v1's frozen commit-limit-5-taken.json passes limit 1 on Alex's A4-14 pick, whose
//      open question holds no booking yet (the K-30 request has no booking head), where DL-183's ruling 1 alone would
//      ask the owner. A meaning-search entry is no door: default 3 below.
//   2. What only protects is the commit's list (T-305 hold.ts PROTECTIVE_ROWS and PROTECTIVE_STEPS, DL-128, DL-133: a
//      STOP, a death report, the A3-48 pause, A3-50's private booking and their twins), so the gate and the commit read
//      one list. A STOP for another number is still the STOP path's to refuse (K-09 notFromThatPhone).
//   3. A part's matters:
//      a. A choice about no booking (an open question's option, or an entry step meaning search adds) is the sender's
//         own record only at a customer-side step that writes the sender's own person or handle rows (DL-183): the list
//         OWN_RECORD_STEPS, taken from the step index (its "who→to via" and gives columns, with the field 02-contracts
//         section 8 names for each key). On it: A4-82 and B4-93 "Asks how to reach Alex" (agent→cust chat; reach_by,
//         K-28's way), A4-23 and B4-25 "The AI sends Alex's name" (agent→san sync, the customer's own AI; customer,
//         K-28's row), A7-98 and B7-88 "Sends updates to a new phone or email" (cust→san msg; the contact-change row's
//         handlers, S13-45 row 3 and D75). Left out: A3-30 and B3-08 (they write a customer's way and row, but as the
//         owner's read-back of a booking the business adds: san→owner, owner→san), A4-80 and B4-92 (who_for: the
//         booking's booker, person served and payer, not the sender's own rows), A4-42 and B4-29 (the secure link
//         Rosie sends: K-30). Every other choice about no booking is a business matter (row 1's apart, default 1): S12
//         and every S step, any step K-01 marks for the business (its who or to is the owner or staff) and any step on
//         neither list, A3-51's meaning-search entries included. Its matter is the business's own: team for S2 steps,
//         settings for any other step (S11-53's settings hold "Block a customer or address", which S12-24 decides), its
//         money as in b, and the owner's alone at an owner-only step. It passes only for the owner, or an admin with the
//         matching live power, from that role's own mobile or email on file (S13-45 row 8); anyone else gets the code
//         or a question to them.
//      b. The business's doors, rows and hubs: settings for the owner door, the owner-command row and the owner and
//         settings hubs; team for the team door and hub; the owner alone at an owner-only step (S11-61 export, S11-73
//         leaving, S11-75, S11-76 and S11-95 closing, S11-100 hand-over). On the business's side a charge or money stake
//         is a fee, a refund stake a refund, and an unknown stake (the frontier builder could not walk it) both, beside
//         the base matter.
//      c. A choice on a booking is its visit (its hubs included: a relayed "Alex wants it" becomes a question in Alex's
//         own chat, B8-23), except: at an owner-only step it is the owner's; put to someone with a live owner, admin or
//         staff role who is not the booking's booker, person served or payer, it is theirs only for what S13-31 gives
//         the business on a booking, a fee (a charge stake) or a refund beyond the terms (a refund stake), and anything
//         else it may do (adding a person, a way in or authority; money taken at booking; a move or a cancel; whatever no
//         stake names) is the booking's visit, for its decider, whatever proves their role (DL-183 N2), with an unknown
//         stake all three; answered by anyone else at an S1, S2 or S11 step, it stays the business's, as in a.
//      d. The contact-change row (D75: "the request counts only from the customer's own chat") is the person's own
//         record. Any other choice (a danger row, a row or hub case with no booking) has no matter: nobody decides (fails
//         closed).
//   4. While a booking is still being made (stage entry), its booker goes on making it (S13-45 row 1; A4-26 "on a link
//      the booker forwards"; A4-55 "paid on the page by the person booking"), beside whoever T-308 names.
//   5. A sender is proven by ContactsOnFile (facts.ts) in the standing they would act in, whether or not they decide:
//      as a customer (served, parent or guardian, booker, or for their own record), by the turn's handle K-04 links to
//      them; in a business role (deciding as owner or admin, holding a role here for a business matter, or answering
//      for the business a question about a booking they play no part in), by the role's own mobile or email on file
//      (K-22 accounts, staff: S13-45 rows 8 and 9), which has no reader yet (T-321), so it is unproven; a page's session
//      (K-21) and an AI's bound token (T-328) are not read yet, so neither proves.
//   6. The one rule comes before the rows: an unproven sender in a turn gets the code whether or not they could decide,
//      so the answer never hints at who decides or whether a booking exists; with no ProofCodes (T-322 not built) the
//      part is refused (notBuilt), never passed. An unproven sender off the chat (a page, an AI) has no chat to type a
//      code in: the deciders are asked in their own chats.
//   7. A sender nobody on the record (caller.personId null) is the wrong person: the deciders are asked in their own
//      chats. With nobody to ask, theirs or anyone's, the step's safe default runs (nothing changes) and no question goes
//      out (DL-183 N4). The frontier offers such a handle no booking of anyone's.
//   8. A choice at another business than the call's has no decider here (T-308 answers for the call's business alone),
//      unless it only protects.
//
// Round 3 (the lead's rulings on the card, DL-188): a step's side is read from its card in the turn's bundle (K-01 v1
// step: who it is from and to), never from step-id lists. Where round 3 differs from the defaults above, this wins:
//   9. A step is the business's (sideOfStep) when its card is to or from the owner (K-01 lane owner: the owner or office
//      manager, an admin) or staff; every S1, S2 and S11 step (as before), every S12 and S13 step; and any step whose card
//      cannot be read (no bundle, no such step, no lane). Any other step is the customer's: K-01's lanes for the customer
//      (cust, agent), anyone else (other), Stripe or an outside service (pay, out), or Rosie alone (san, an automatic
//      step: A4-01 and A4-28, which ruling 2 names as the customer's). A hub asks nobody itself (K-01: san, auto), so a hub
//      case's side is that of the steps its branch leads to (sideOfCase): its own steps and, through each split among
//      them, every branch's own steps; one of them the business's or unread makes the case the business's (A7-02's "The
//      business can't give it" leads to A7-93, whose branches lead to A7-15, a question to the owner). An any-time row's
//      side is its handler's.
//  10. A choice at a business step is the business's whoever answers, on a booking or not (it replaces 3c's S1, S2 and S11
//      list): its fee or refund stake needs the owner or an admin with the money power, anything else the owner or an
//      admin with the matching power (3a, 3b). On a booking this business does not hold it is a visit nobody decides
//      (bookingNotFound, fails closed). A sender who plays a part on the booking (booker, person served or payer) and
//      holds a live business role here is asked which role (S13-31, A 7023: "When two roles fit, ask which"; A3-51 "Both
//      fit? Ask"), never passed: askWhichRole, in K-09 v1's ask outcome (askedDecider), the only question limit 1 has.
//      At a customer step, 3c stands: the booking's visit, or for a business role with no part in it only its fee or
//      refund (DL-183 N2).
//  11. S13-45 row 1 ("see times, book a new visit: anyone") covers, about no booking yet, every customer step of journey 4
//      (K-01 v1 step.section 4: K-01's journey N holds section N's steps), beside NEW_VISIT_STEPS, and the new-booking
//      door's meaning-search entries (NEW_BOOKING_DOORS: A3-51, flow B's B3-40; closest-entries.json's "Asks for a
//      person"). OWN_RECORD_STEPS, which add a way in or a name to the sender's own existing record, are not row 1 and
//      are read first: that is this round's default for "a choice that would add a person, a way in or authority to
//      anything that already exists"; with no booking, nothing else exists to add to.
//  12. With no bundle read (the shipped default, NO_STEP_CARDS) every step but row 1's doors and entries, the any-time
//      rows read without a step and the owner, settings and team hubs counts as unread, so the business's.
//
// T-1183 (DL-364; T-1141's Need 1): K-02 v1.1 adds a sixth door, signUp, the door to S1-01 (its default 9: the turn's
// business as its target, no booking, no field, low stakes). K-01's five doors answer as before.
//  13. The sign-up door is anyone's to enter, on their own word with no proof asked (ADR-013 section 2; K-09 v1.5's
//      commit-s1-01.json: limit 1 passes Sam's first text). Entering it starts a business's sign-up, whose walk (arch 03
//      line 191) writes only rows new in the turn, the handle's own thread (S1-01) and S1-02's question to the sender, so
//      it changes no existing record and decides nothing for an existing business. What follows it stays the business's:
//      S1-02's answer is a choice at an S1 step, so the business's settings (defaults 3a and 9). Only the door as K-02
//      v1.1 shapes it passes: at S1-01, on no booking, with no stake and no field. A sign-up door that names a booking, a
//      stake or a field, or another business than the call's, is not that door, so nobody decides it (fails closed), as
//      with a door the gate does not know, which still answers unknown.

import { holdClassOf } from "../../commit/hold";
import {
  partsOf,
  type BusinessMatter,
  type IdentityAccess,
  type Matter,
  type NoDecider,
  type OwnerOnlyMatter,
  type Role,
} from "../../domain/identity-access";
import type { Choice, GatePart, GateTurn, LimitOutcomes } from "../framework";
import type {
  BookingStages,
  CodeAsk,
  ContactsOnFile,
  Lane,
  PlannedCode,
  ProofCodes,
  ProofStanding,
  Side,
  Standing,
  StepCard,
  StepCards,
} from "./facts";

/** Limit 1's outcomes when it fails (K-09 v1 limit1Outcome). */
export type Limit1Outcome = LimitOutcomes[1];

/** Unproven sender: the code and the question that takes it typed back; the choice waits (K-09 v1: wait). */
export function proofCodeSentOutcome(code: PlannedCode): Limit1Outcome {
  return {
    limit: 1,
    outcome: "wait",
    action: "proofCodeSent",
    proofCodeId: code.proofCodeId,
    openQuestionId: code.openQuestionId,
  };
}

/** Wrong person: a question in the decider's own chat (K-09 v1: ask). */
export function askedDeciderOutcome(): Limit1Outcome {
  return { limit: 1, outcome: "ask", action: "askedDecider" };
}

// ---- what a part changes ------------------------------------------------------------------------------------------

/** A matter limit 1 asks who decides: T-308's (a visit, a business matter, an owner-only matter) or the person's own record. */
export type LimitMatter = Matter | { readonly kind: "own" };

export type Change =
  /** Nothing the limit applies to (K-08 v1 limitResult notChecked). */
  | { readonly kind: "nothing" }
  /** Only protects: on anyone's word (S13-57; S13-45's rule; arch 06 line 329). */
  | { readonly kind: "protects" }
  /**
   * S13-45 row 1: "Ask, see prices and times, book a new visit: anyone, at any door." And the sign-up door, which changes
   * no existing record (default 13).
   */
  | { readonly kind: "anyone" }
  /**
   * Needs the decider's own yes for every one of these matters. inRole: a question about a booking put to the sender in
   * the business role they hold there (default 3c), so their role's contact on file proves them (default 5). twoRoles:
   * the business's choice on a booking the sender plays a part on while holding a business role here, so they are asked
   * which role, never passed (default 10).
   */
  | {
      readonly kind: "decided";
      readonly matters: readonly LimitMatter[];
      readonly inRole: boolean;
      readonly twoRoles: boolean;
    }
  /** Nothing says who decides it: nobody does (fails closed). */
  | { readonly kind: "unknown" };

/** A change that needs the decider's own yes. */
type DecidedChange = Extract<Change, { kind: "decided" }>;

const NOTHING: Change = { kind: "nothing" };
const PROTECTS: Change = { kind: "protects" };
const ANYONE: Change = { kind: "anyone" };
const UNKNOWN: Change = { kind: "unknown" };
const decided = (...matters: LimitMatter[]): DecidedChange => ({
  kind: "decided",
  matters,
  inRole: false,
  twoRoles: false,
});

/**
 * The steps whose matter is the owner's alone (S13-45 row 8: "Admins never close the business, export, hand it over, or
 * remove the account owner"), each with its title in the master (MASTER-FLOW-A section 11).
 */
export const OWNER_ONLY_STEPS: Readonly<Partial<Record<string, OwnerOnlyMatter>>> = {
  /** "Exports the customer list": "Only the account owner exports. Admins never do." */
  "S11-61": "export",
  /** "Leaving Rosie": "Only the account owner closes or hands over a business (S13-45)." */
  "S11-73": "close",
  /** Closing one business: S11-75 "Tells each one; returns anything paid", S11-76, S11-95. */
  "S11-75": "close",
  "S11-76": "close",
  "S11-95": "close",
  /** "Sam hands a business over" ("Removing an owner is a hand-over (S11-100)", S13-31). */
  "S11-100": "handOver",
};

/**
 * The customer-side steps that write the sender's own person or handle rows: there, and only there, a choice about no
 * booking is the sender's own record (default 3a; DL-183). Taken from the step index ("who→to via", gives) with the field
 * 02-contracts section 8 names for each key; every other step's choice about no booking is a business matter.
 */
export const OWN_RECORD_STEPS: readonly string[] = [
  /** "Asks how to reach Alex" (agent→cust chat): gives reach_by, K-28's customer's way. */
  "A4-82",
  /** "The AI sends Alex's name" (agent→san sync, the customer's own AI: MC R1): gives customer, K-28's customer row. */
  "A4-23",
  /** "Sends updates to a new phone or email" (cust→san msg): the contact-change row's handler (S13-45 row 3; D75). */
  "A7-98",
  /** Flow B's twins of the three: "Asks how to reach Alex", "The AI sends Alex's name", "Sends updates to a new phone". */
  "B4-93",
  "B4-25",
  "B7-88",
];

/**
 * The times cards and the pick, where a time is picked for a new visit before it has a booking (default 1, S13-45 row 1:
 * "see prices and times, book a new visit: anyone"): a choice about no booking there passes on anyone's word, as K-09 v1's
 * commit-limit-5-taken.json states for A4-14. From the step index, each "agent→cust chat" (gives times) or "cust→agent
 * chat" (the pick).
 */
export const NEW_VISIT_STEPS: readonly string[] = [
  /** "The times card", "Shows sessions with seats left", "Shows spaces that fit", "Offers a start and an end for a stay". */
  "A4-14",
  "A4-33",
  "A4-62",
  "A4-68",
  /** "Alex picks a time". */
  "A4-15",
  /** Flow B: "The times card", "Times read as a set start", "Offers a start and an end", "Times are seats in a session". */
  "B4-15",
  "B4-84",
  "B4-85",
  "B4-89",
  /** "Alex picks a time". */
  "B4-16",
];

/** The roles that answer for the business (K-04 v1 person_roles). */
export const BUSINESS_ROLES: readonly Role[] = ["owner", "admin", "staff"];

/**
 * The new-booking door in each flow, whose meaning-search entries are row 1 (default 11; arch 03 line 165: "a new booking
 * or a question about the business, A3-51 (B3-40)"; K-09 closest-entries.json adds A3-51's "Asks for a person").
 */
export const NEW_BOOKING_DOORS: readonly string[] = ["A3-51", "B3-40"];

/** The sign-up door's step: S1-01, the first step of section 1 in both flows (K-02 v1.1 default 9). */
const SIGN_UP_STEP = "S1-01";

/**
 * Whether a sign-up door is the one K-02 v1.1 default 9 shapes (default 13): at S1-01, on no booking, with no stake and no
 * field. Its business is the call's, as changeOf checks first for every choice.
 */
function shapedAsSignUp(choice: Choice): boolean {
  return (
    choice.step === SIGN_UP_STEP &&
    choice.target.bookingId === null &&
    choice.stakesFrom.length === 0 &&
    choice.fields.length === 0
  );
}

/** The business's own matter at a step (default 3a): team for S2 (journey 2), settings for any other step. */
function businessBase(step: string): "team" | "settings" {
  return step.startsWith("S2-") ? "team" : "settings";
}

// ---- a step's side (DL-188 ruling 1; default 9) ----------------------------------------------------------------------

/** Which side a step is on: the business's, or the customer's. */
export type StepSide = "business" | "customer";

/** The lanes that are the business (K-01 v1 lane): owner (the owner or office manager, an admin) and staff. */
const BUSINESS_LANES: readonly (Lane | null)[] = ["owner", "staff"];

/** Every step of S1 and S2 (setup and the team) and S11 (running the business), as before, and of S12 and S13. */
function businessSection(step: string): boolean {
  return /^S(?:1|2|11|12|13)-/u.test(step);
}

/**
 * A step's side from its card (default 9): the business's at a business section, for a card that cannot be read, or
 * for a step to or from the owner or staff; else the customer's.
 */
export function sideOfStep(step: string, card: StepCard | null): StepSide {
  if (businessSection(step) || card === null) return "business";
  if (card.who === null) return "business";
  return BUSINESS_LANES.includes(card.who) || BUSINESS_LANES.includes(card.to) ? "business" : "customer";
}

/** The most steps a hub case's walk reads before its side counts as unread (as the frontier's stakes walk: 64). */
const MAX_CASE_STEPS = 64;

/**
 * A hub case's side (default 9): the hub's own, then that of every step its branch leads to, its own steps and, through
 * each split among them, every branch's own steps, until one is the business's or cannot be read (the business's), or
 * none is left (the customer's). A case its hub's card does not list, or a walk longer than MAX_CASE_STEPS, is the
 * business's.
 */
async function sideOfCase(choice: Choice, steps: StepCards): Promise<StepSide> {
  const hub = await steps.step(choice.step);
  if (hub === null || sideOfStep(choice.step, hub) === "business") return "business";
  const branch = hub.branches.find((each) => each.label === choice.branch);
  if (branch === undefined) return "business";
  const queue = [...branch.steps];
  const seen = new Set<string>();
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > MAX_CASE_STEPS) return "business";
    const card = await steps.step(id);
    if (card === null || sideOfStep(id, card) === "business") return "business";
    for (const each of card.branches) queue.push(...each.steps);
  }
  return "customer";
}

/** Journey 4, booking a new visit: K-01 v1 step.section 4 (K-01 README: journey N holds section N's steps). */
const NEW_VISIT_SECTION = 4;

/** A customer step of booking a new visit (default 11): on NEW_VISIT_STEPS or in journey 4, by its card. */
function newVisitStep(step: string, card: StepCard): boolean {
  return NEW_VISIT_STEPS.includes(step) || card.section === NEW_VISIT_SECTION;
}

/** The money matters a choice's stakes name on the business's side (K-02 v1 stakesReason; default 3b). */
function moneyMatters(choice: Choice): BusinessMatter[] {
  const why = new Set(choice.stakesFrom.map((reason) => reason.why));
  if (why.has("unknown")) return ["fee", "refund"];
  const money: BusinessMatter[] = [];
  if (why.has("charge") || why.has("money")) money.push("fee");
  if (why.has("refund")) money.push("refund");
  return money;
}

/** A business choice's matters: owner-only steps, else its money, else its base (team or settings). */
function businessChange(choice: Choice, base: "team" | "settings"): DecidedChange {
  const ownerOnly = OWNER_ONLY_STEPS[choice.step];
  if (ownerOnly !== undefined) return decided({ kind: ownerOnly });
  const money = moneyMatters(choice);
  if (money.length === 0) return decided({ kind: base });
  const matters: LimitMatter[] = money.map((kind) => ({ kind }));
  // An unknown stake may reach anything: its money and its base both.
  if (choice.stakesFrom.some((reason) => reason.why === "unknown")) matters.push({ kind: base });
  return decided(...matters);
}

/**
 * A question about a booking put to a business role who plays no part in it (default 3c; DL-183 N2): theirs only for
 * what S13-31 gives the business on a booking, a fee (a charge stake) or a refund beyond the terms (a refund stake).
 * Anything else it may do (adding a person, a way in or authority; money taken at booking; a move or a cancel; whatever no
 * stake names) is the booking's visit, for its decider; an unknown stake may be all three. Another option's stake
 * (question) says nothing about this one's own.
 */
function forTheBusiness(choice: Choice, bookingId: string): DecidedChange {
  const why = new Set(choice.stakesFrom.map((reason) => reason.why).filter((each) => each !== "question"));
  const matters: LimitMatter[] = [];
  if (why.has("charge") || why.has("unknown")) matters.push({ kind: "fee" });
  if (why.has("refund") || why.has("unknown")) matters.push({ kind: "refund" });
  const feeOrRefundOnly = why.size > 0 && [...why].every((each) => each === "charge" || each === "refund");
  if (!feeOrRefundOnly) matters.push({ kind: "visit", bookingId });
  return { kind: "decided", matters, inRole: true, twoRoles: false };
}

/** What reads a choice needs beyond itself, made only when asked. */
export interface ChangeReads {
  readonly identity: () => IdentityAccess;
  /** The turn's bundle's step cards (K-01 v1), which say each step's side (default 9). */
  readonly steps: () => StepCards;
}

/**
 * A choice on a booking at a step of this side (defaults 3c and 10): the owner's at an owner-only step; a visit nobody
 * decides on a booking this business does not hold (fails closed); at a business step the business's whoever answers,
 * with twoRoles for a sender who plays a part on the booking and holds a business role here; at a customer step, for a
 * business role with no part in it only its fee or refund (DL-183 N2), else the booking's visit.
 */
async function onBookingAt(
  side: StepSide,
  choice: Choice,
  bookingId: string,
  turn: GateTurn,
  reads: ChangeReads,
): Promise<Change> {
  const ownerOnly = OWNER_ONLY_STEPS[choice.step];
  if (ownerOnly !== undefined) return decided({ kind: ownerOnly });
  const identity = reads.identity();
  const parties = await identity.parties(bookingId);
  if (parties === null) return decided({ kind: "visit", bookingId });
  const sender = turn.request.caller.personId;
  const plays = sender !== null && partsOf(parties, sender).length > 0;
  const holdsRole =
    sender !== null && (await identity.rolesOf(sender)).some((role) => BUSINESS_ROLES.includes(role));
  if (side === "business") {
    return { ...businessChange(choice, businessBase(choice.step)), twoRoles: plays && holdsRole };
  }
  return holdsRole && !plays ? forTheBusiness(choice, bookingId) : decided({ kind: "visit", bookingId });
}

/**
 * An open question's option or a meaning-search entry (defaults 1, 3, 9 to 11): about no booking, row 1 for the
 * new-booking door's entries; then, by the step's card, the business's matter at a business step, the sender's own record
 * at an own-record step, row 1 at a customer step of booking a new visit, and the business's matter anywhere else (3a);
 * on a booking, as onBookingAt says for the step's side.
 */
async function atStep(choice: Choice, turn: GateTurn, reads: ChangeReads): Promise<Change> {
  const bookingId = choice.target.bookingId;
  if (bookingId === null && choice.kind === "searchEntry" && NEW_BOOKING_DOORS.includes(choice.step)) {
    return ANYONE;
  }
  const card = await reads.steps().step(choice.step);
  const side = sideOfStep(choice.step, card);
  if (bookingId !== null) return onBookingAt(side, choice, bookingId, turn, reads);
  if (side === "customer" && card !== null) {
    if (OWN_RECORD_STEPS.includes(choice.step)) return decided({ kind: "own" });
    if (newVisitStep(choice.step, card)) return ANYONE;
  }
  return businessChange(choice, businessBase(choice.step));
}

/** What one gated part changes (defaults 1 to 3). */
export async function changeOf(part: GatePart, turn: GateTurn, reads: ChangeReads): Promise<Change> {
  const { part: said, choice } = part;
  if (said.verb === "pass_on" || said.verb === "hand_off") return NOTHING;
  if (choice === null) throw new TypeError("limit 1 got a choose or enter part without its offered choice");
  if (holdClassOf(said, choice) === "protective") return PROTECTS;
  if (choice.target.businessId !== turn.businessId) return UNKNOWN;
  switch (choice.kind) {
    case "whichBooking":
      return NOTHING;
    case "door":
      switch (choice.door) {
        case "ownerCommand":
          return businessChange(choice, "settings");
        case "teamChange":
          return businessChange(choice, "team");
        case "newBooking":
        case "existingBooking":
        case "unclearOwnerOrHelp":
          return ANYONE;
        case "signUp":
          // Starting a business's sign-up changes no existing record: anyone's, as the door K-02 shapes (default 13).
          return shapedAsSignUp(choice) ? ANYONE : UNKNOWN;
        default:
          return UNKNOWN;
      }
    case "anytime":
      switch (choice.anytimeRow) {
        case "owner-command":
          return businessChange(choice, "settings");
        case "contact-change":
          return decided({ kind: "own" });
        case "platform-or-ai-failure":
          return ANYONE;
        case "danger-or-crisis":
        case "child-elder-or-unsafe-at-home":
        case null:
          return UNKNOWN;
        default: {
          // Any other row on a booking, by its handler's side (default 9).
          const bookingId = choice.target.bookingId;
          if (bookingId === null) return UNKNOWN;
          const handler = await reads.steps().step(choice.step);
          return onBookingAt(sideOfStep(choice.step, handler), choice, bookingId, turn, reads);
        }
      }
    case "hub":
      switch (choice.hub) {
        case "owner":
        case "settings":
          return businessChange(choice, "settings");
        case "team":
          return businessChange(choice, "team");
        case "entry":
        case "booked":
        case "checkedIn":
        case "done": {
          // A booking stage's hub case, by the side of the steps its branch leads to (default 9).
          const bookingId = choice.target.bookingId;
          if (bookingId === null) return UNKNOWN;
          return onBookingAt(await sideOfCase(choice, reads.steps()), choice, bookingId, turn, reads);
        }
        default:
          return UNKNOWN;
      }
    case "searchEntry":
    case "option":
      return atStep(choice, turn, reads);
    default:
      return UNKNOWN;
  }
}

// ---- who decides ----------------------------------------------------------------------------------------------------

/** Someone who may decide, and the standing that says which contact on file is theirs. */
export interface LimitDecider {
  readonly personId: string;
  readonly as: Standing;
}

/** Why nobody can be asked: T-308's reason, no matter at all, or no sender for their own record. */
export type NobodyWhy = NoDecider | "unknownChange" | "noSender";

type Deciders =
  | { readonly ok: true; readonly deciders: readonly LimitDecider[] }
  | { readonly ok: false; readonly why: NobodyWhy };

const nobody = (why: NobodyWhy): Deciders => ({ ok: false, why });
const these = (deciders: readonly LimitDecider[]): Deciders => ({ ok: true, deciders });

/** What the rule reads, made only when it needs them. */
export interface AllowedPorts extends ChangeReads {
  readonly stages: () => BookingStages;
  readonly contacts: () => ContactsOnFile;
  /** T-322's codes; null until built, so a part that needs a code is refused (notBuilt). */
  readonly proofCodes: ProofCodes | null;
}

/** The first live business role a person holds here, in K-04's order, or undefined. */
async function businessRoleOf(identity: IdentityAccess, personId: string): Promise<Role | undefined> {
  return (await identity.rolesOf(personId)).find((role) => BUSINESS_ROLES.includes(role));
}

/** A business role as the standing it acts in, and the contact on file it is proven by. */
const asProof = (role: Role): ProofStanding => (role === "owner" || role === "admin" ? role : "staff");

/** Who decides one matter (defaults 3 and 4). */
async function decidersOf(
  matter: LimitMatter,
  sender: string | null,
  ports: AllowedPorts,
): Promise<Deciders> {
  const identity = ports.identity();
  switch (matter.kind) {
    case "own":
      return sender === null ? nobody("noSender") : these([{ personId: sender, as: "self" }]);
    case "visit": {
      const who = await identity.whoDecides(matter);
      const deciders: LimitDecider[] = who.ok ? [...who.deciders] : [];
      if ((await ports.stages().stageOf(matter.bookingId)) === "entry") {
        const parties = await identity.parties(matter.bookingId);
        if (parties !== null && !deciders.some((decider) => decider.personId === parties.booker)) {
          deciders.push({ personId: parties.booker, as: "booker" });
        }
      }
      if (deciders.length > 0) return these(deciders);
      return nobody(who.ok ? "nobodyAllowed" : who.why);
    }
    default: {
      const who = await identity.whoDecides(matter);
      return who.ok ? these(who.deciders) : nobody(who.why);
    }
  }
}

/** Who decides every one of the matters: those each one names (the first matter's standing). */
async function decidersOfAll(
  matters: readonly LimitMatter[],
  sender: string | null,
  ports: AllowedPorts,
): Promise<Deciders> {
  const lists: (readonly LimitDecider[])[] = [];
  for (const matter of matters) {
    const each = await decidersOf(matter, sender, ports);
    if (!each.ok) return each;
    lists.push(each.deciders);
  }
  const [first, ...rest] = lists;
  if (first === undefined) return nobody("nobodyAllowed");
  const common = first.filter((decider) =>
    rest.every((list) => list.some((other) => other.personId === decider.personId)),
  );
  return common.length > 0 ? these(common) : nobody("nobodyAllowed");
}

/** Whose contact on file the matters ask for: the business role's for a business matter, else a customer's. */
function sideOfMatters(matters: readonly LimitMatter[]): Side {
  return matters.some((matter) => matter.kind !== "visit" && matter.kind !== "own") ? "business" : "customer";
}

/**
 * Which contact on file proves the sender (default 5): their business role's own when they would act in it (deciding as
 * owner or admin, holding a role at the business for a business matter, or answering for the business a question about a
 * booking they play no part in), else their own as a customer. It turns on the standing they would act in, never on
 * whether they decide it (the one case apart: the owner acts as owner on a booking a death was reported on, T-308
 * default 4).
 */
async function proofStandingOf(
  mine: LimitDecider | undefined,
  change: { readonly matters: readonly LimitMatter[]; readonly inRole: boolean },
  sender: string,
  ports: AllowedPorts,
): Promise<ProofStanding> {
  if (mine !== undefined) return mine.as === "owner" || mine.as === "admin" ? mine.as : "self";
  if (!change.inRole && sideOfMatters(change.matters) === "customer") return "self";
  const role = await businessRoleOf(ports.identity(), sender);
  return role === undefined ? "self" : asProof(role);
}

// ---- the decision ---------------------------------------------------------------------------------------------------

/** Why a part passes: it only protects, it is open to anyone (row 1, or the sign-up door), or the decider's own word. */
export type PassWhy = "protects" | "anyone" | "decider";

/** Why a part fails: an unproven sender, the wrong person, nobody who may decide it, or two roles that fit (default 10). */
export type FailWhy = "unproven" | "notDecider" | "nobodyDecides" | "twoRoles";

/** What the commit runs for a failed part (T-305 default 8). */
export type AllowedNext =
  /** The code to the contact on file, and the question in this chat that takes it typed back: ids only. */
  | { readonly kind: "proofCode"; readonly proofCodeId: string; readonly openQuestionId: string }
  /** A question in each decider's own chat, about these matters: at least one decider, never none (default 7). */
  | {
      readonly kind: "askDecider";
      readonly deciders: readonly string[];
      readonly matters: readonly LimitMatter[];
    }
  /** Nobody to ask: the step's safe default runs and a person is told (S13-31). */
  | { readonly kind: "nobodyDecides"; readonly why: NobodyWhy; readonly step: string }
  /**
   * Two roles fit (a part on the booking, a business role here): a question in the sender's own chat, which role this is
   * in (S13-31: "When two roles fit, ask which"; default 10). Nothing changes until it is answered.
   */
  | { readonly kind: "askWhichRole"; readonly personId: string; readonly matters: readonly LimitMatter[] };

export type AllowedDecision =
  | { readonly result: "pass"; readonly why: PassWhy }
  | { readonly result: "notChecked" }
  /**
   * The part cannot be checked here, so it is refused, never passed: a code is needed and T-322's codes are not built
   * (proofCodes), or the call holds no database transaction for the default reads (database).
   */
  | { readonly result: "notBuilt"; readonly port: "proofCodes" | "database" }
  | {
      readonly result: "fail";
      readonly why: FailWhy;
      readonly outcome: Limit1Outcome;
      readonly next: AllowedNext;
    };

const pass = (why: PassWhy): AllowedDecision => ({ result: "pass", why });
const NOT_CHECKED: AllowedDecision = { result: "notChecked" };
const NOT_BUILT: AllowedDecision = { result: "notBuilt", port: "proofCodes" };

function askDeciders(
  why: FailWhy,
  deciders: readonly string[],
  matters: readonly LimitMatter[],
): AllowedDecision {
  return {
    result: "fail",
    why,
    outcome: askedDeciderOutcome(),
    next: { kind: "askDecider", deciders: [...new Set(deciders)], matters: [...matters] },
  };
}

function nobodyDecides(why: NobodyWhy, step: string): AllowedDecision {
  return {
    result: "fail",
    why: "nobodyDecides",
    outcome: askedDeciderOutcome(),
    next: { kind: "nobodyDecides", why, step },
  };
}

/** T-322's answer must name a code and a question (non-empty ids); anything else fails the call (fail closed). */
function plannedCode(code: unknown): PlannedCode {
  const ok = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
  if (typeof code !== "object" || code === null)
    throw new TypeError("limit 1's proof codes answered no code");
  const { proofCodeId, openQuestionId } = code as Record<string, unknown>;
  if (!ok(proofCodeId) || !ok(openQuestionId)) {
    throw new TypeError("limit 1's proof codes answered a code without its ids");
  }
  return { proofCodeId, openQuestionId };
}

/** Limit 1 on one agreed part: pass, notChecked, notBuilt, or the failure with what the commit runs next. */
export async function decideAllowed(
  part: GatePart,
  turn: GateTurn,
  ports: AllowedPorts,
): Promise<AllowedDecision> {
  const change = await changeOf(part, turn, ports);
  if (change.kind === "nothing") return NOT_CHECKED;
  if (change.kind === "protects" || change.kind === "anyone") return pass(change.kind);
  const step = part.choice?.step ?? "";
  if (change.kind === "unknown") return nobodyDecides("unknownChange", step);

  const { caller } = turn.request;
  const sender = caller.personId;
  const deciders = await decidersOfAll(change.matters, sender, ports);
  const named = deciders.ok ? deciders.deciders.map((decider) => decider.personId) : [];
  // A question goes to someone, or not at all: with nobody to ask, the step's safe default (default 7; DL-183 N4).
  const askOrDefault = (why: FailWhy): AllowedDecision =>
    named.length > 0
      ? askDeciders(why, named, change.matters)
      : nobodyDecides(deciders.ok ? "nobodyAllowed" : deciders.why, step);
  if (sender === null) return askOrDefault("notDecider");

  // The one rule first (default 6): is this the sender's own word? Nothing about who decides, or whether a booking
  // exists, reaches the answer before it.
  const mine = deciders.ok ? deciders.deciders.find((decider) => decider.personId === sender) : undefined;
  const as = await proofStandingOf(mine, change, sender, ports);
  const handleId = turn.request.turn?.handleId ?? null;
  const own = await ports.contacts().isOwn({
    businessId: turn.businessId,
    personId: sender,
    as,
    caller: caller.kind,
    handleId,
  });
  if (!own) {
    const turnId = turn.request.turn?.id;
    if (caller.kind !== "turn" || handleId === null || turnId === undefined) return askOrDefault("unproven");
    if (ports.proofCodes === null) return NOT_BUILT;
    const ask: CodeAsk = {
      businessId: turn.businessId,
      forPersonId: sender,
      as,
      typedBackIn: handleId,
      turnId,
      part: part.index,
    };
    const code = plannedCode(await ports.proofCodes.codeFor(ask));
    return {
      result: "fail",
      why: "unproven",
      outcome: proofCodeSentOutcome(code),
      next: { kind: "proofCode", proofCodeId: code.proofCodeId, openQuestionId: code.openQuestionId },
    };
  }

  // Then the rows: their own word, but are they someone who decides it?
  if (!deciders.ok) return nobodyDecides(deciders.why, step);
  if (mine === undefined) return askOrDefault("notDecider");
  // A decider who also plays a part on the booking, on the business's choice: asked which role, never passed (default 10).
  if (change.twoRoles) {
    return {
      result: "fail",
      why: "twoRoles",
      outcome: askedDeciderOutcome(),
      next: { kind: "askWhichRole", personId: sender, matters: [...change.matters] },
    };
  }
  return pass("decider");
}
