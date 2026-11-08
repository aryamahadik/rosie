// Limit 1, Allowed (C-081, T-299; arch 06 line 299): "A change that only protects: anyone's word (S13-57). A change that
// adds a person, a way in, money or authority: the decider's own yes under S13-45: the person served, or who decides for
// them, for their visit; the owner or a permitted admin for fees, refunds beyond the terms (RULES 3.10), team and
// settings." On failure: "Unproven sender: a code to the contact on file, in words that never confirm a booking exists.
// Wrong person: a question in the decider's own chat." (K-09 v1 limit1Outcome: proofCodeSent, wait; askedDecider, ask.)
//
// For one gated part, in this order:
//   1. What it changes (changeOf): nothing the limit applies to (notChecked); a change that only protects (pass, on
//      anyone's word); S13-45 row 1, open to anyone at any door (pass); or matters that need the decider's own yes.
//   2. Who decides each matter: T-308's identity and access service (the person served or who decides for them; the
//      owner or an admin the owner lets; the owner alone for closing, export and hand-over), the booker of a booking still
//      being made, the person themself for their own record, or the one a business question was asked of in their role.
//   3. Whose word it is (S13-45's one rule first, then its rows): the call's person (K-09 v1 caller.personId, "the
//      sender of the turn's texts"), proven only from their own contact on file for the standing they would act in. An
//      unproven sender in a turn gets a code to that contact on file, typed back in this chat (proofCodeSent); proven, or
//      off the chat, someone T-308 does not name gets a question in each decider's own chat (askedDecider). Nobody to ask:
//      askedDecider with the step's safe default for the commit (S13-31: "When nobody allowed can decide in time, the
//      step's safe default runs and a person is told").
//
// What an outcome writes (the code, the question, the safe default and who is told) is the commit's (K-09 v1
// limitNOutcome; T-305 default 8): decideAllowed says what, and the limit hands the gate its K-09 outcome. Nothing here
// logs. What it returns names labels, ids and steps, never a person's words, name or number; an unproven sender's code
// and decision name no booking, so they read the same whether or not one exists.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. Every change that does not only protect needs the decider's own yes, not only one that adds a person, a way in,
//      money or authority: S13-45's rule "Showing, changing or paying waits for the one rule", row 2 "See or change a
//      booking: the person served, by the one rule", S13-57 "or shows something". The exception is row 1: the doors for a
//      new booking, an existing booking (A3-43 runs its own code check) and an unclear owner text or HELP, the outage row
//      (S12-11) and an entry step meaning search adds about no booking or business step.
//   2. What only protects is the commit's list (T-305 hold.ts PROTECTIVE_ROWS and PROTECTIVE_STEPS, DL-128, DL-133: a
//      STOP, a death report, the A3-48 pause, A3-50's private booking and their twins), so the gate and the commit read
//      one list. A STOP for another number is still the STOP path's to refuse (K-09 notFromThatPhone).
//   3. A part's matters: the business's own for S1 steps, the owner and settings hubs, the owner door and the
//      owner-command row (settings), S2 steps, the team hub and door (team), S11 steps (settings), and owner-only steps
//      (S11-61 export, S11-73 leaving, S11-75, S11-76 and S11-95 closing, S11-100 hand-over); on the business's side, a
//      charge or money stake is a fee, a refund stake a refund, an unknown stake (the frontier builder could not walk
//      it) both, beside the base matter. Any other choice on a booking is its visit (its hubs included: a relayed "Alex
//      wants it" becomes a question in Alex's own chat, B8-23), except an option answered by someone with a live owner,
//      admin or staff role who is not that booking's booker, person served or payer: the question was put to the
//      business, so its money is a fee or refund and the rest is theirs to answer in their role (S13-31: "Staff decide
//      only what their role and the owner's rights give"; S13-45 rows 8, 9). An option about no booking, and the
//      contact-change row (D75: "the request counts only from the customer's own chat"), are the person's own record.
//      Any other choice (a danger row, a row with no booking) has no matter: nobody decides (fails closed).
//   4. While a booking is still being made (stage entry), its booker goes on making it (S13-45 row 1; A4-26 "on a link
//      the booker forwards"; A4-55 "paid on the page by the person booking"), beside whoever T-308 names.
//   5. A sender is proven by ContactsOnFile (facts.ts) in the standing they would act in, whether or not they decide:
//      as a customer (served, parent or guardian, booker, or for their own record), by the turn's handle K-04 links to
//      them; in a business role (deciding as owner or admin, or holding a role here for a business matter), by the
//      role's own mobile or email on file (K-22 accounts, staff: S13-45 rows 8 and 9), which has no reader yet (T-321),
//      so it is unproven; a page's session (K-21) and an AI's bound token (T-328) are not read yet, so neither proves.
//   6. The one rule comes before the rows: an unproven sender in a turn gets the code whether or not they could decide,
//      so the answer never hints at who decides or whether a booking exists; with no ProofCodes (T-322 not built) the
//      part is refused (notBuilt), never passed. An unproven sender off the chat (a page, an AI) has no chat to type a
//      code in: the deciders are asked in their own chats.
//   7. A sender nobody on the record (caller.personId null) is the wrong person: the deciders are asked in their own
//      chats. The frontier offers such a handle no booking of anyone's.
//   8. A choice at another business than the call's has no decider here (T-308 answers for the call's business alone),
//      unless it only protects.

import { holdClassOf } from "../../commit/hold";
import type {
  BusinessMatter,
  IdentityAccess,
  Matter,
  NoDecider,
  OwnerOnlyMatter,
  Role,
} from "../../domain/identity-access";
import type { Choice, GatePart, GateTurn, LimitOutcomes } from "../framework";
import type {
  BookingStages,
  CodeAsk,
  ContactsOnFile,
  PlannedCode,
  ProofCodes,
  ProofStanding,
  Side,
  Standing,
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

/**
 * A matter limit 1 asks who decides: T-308's (a visit, a business matter, an owner-only matter), the person's own record
 * (own), or the role a business question was put to them in (theirRole).
 */
export type LimitMatter = Matter | { readonly kind: "own" } | { readonly kind: "theirRole" };

export type Change =
  /** Nothing the limit applies to (K-08 v1 limitResult notChecked). */
  | { readonly kind: "nothing" }
  /** Only protects: on anyone's word (S13-57; S13-45's rule; arch 06 line 329). */
  | { readonly kind: "protects" }
  /** S13-45 row 1: "Ask, see prices and times, book a new visit: anyone, at any door." */
  | { readonly kind: "anyone" }
  /** Needs the decider's own yes for every one of these matters. */
  | { readonly kind: "decided"; readonly matters: readonly LimitMatter[] }
  /** Nothing says who decides it: nobody does (fails closed). */
  | { readonly kind: "unknown" };

const NOTHING: Change = { kind: "nothing" };
const PROTECTS: Change = { kind: "protects" };
const ANYONE: Change = { kind: "anyone" };
const UNKNOWN: Change = { kind: "unknown" };
const decided = (...matters: LimitMatter[]): Change => ({ kind: "decided", matters });

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

/** The roles that answer for the business (K-04 v1 person_roles). */
export const BUSINESS_ROLES: readonly Role[] = ["owner", "admin", "staff"];

/** The business's own matter a step stands for (default 3): team for S2 (journey 2), settings for S1 and S11. */
function businessStep(step: string): "team" | "settings" | null {
  if (step.startsWith("S2-")) return "team";
  if (step.startsWith("S1-") || step.startsWith("S11-")) return "settings";
  return null;
}

/** The money matters a choice's stakes name on the business's side (K-02 v1 stakesReason; default 3). */
function moneyMatters(choice: Choice): BusinessMatter[] {
  const why = new Set(choice.stakesFrom.map((reason) => reason.why));
  if (why.has("unknown")) return ["fee", "refund"];
  const money: BusinessMatter[] = [];
  if (why.has("charge") || why.has("money")) money.push("fee");
  if (why.has("refund")) money.push("refund");
  return money;
}

/** A business choice's matters: owner-only steps, else its money, else its base (team or settings). */
function businessChange(choice: Choice, base: "team" | "settings"): Change {
  const ownerOnly = OWNER_ONLY_STEPS[choice.step];
  if (ownerOnly !== undefined) return decided({ kind: ownerOnly });
  const money = moneyMatters(choice);
  if (money.length === 0) return decided({ kind: base });
  const matters: LimitMatter[] = money.map((kind) => ({ kind }));
  // An unknown stake may reach anything: its money and its base both.
  if (choice.stakesFrom.some((reason) => reason.why === "unknown")) matters.push({ kind: base });
  return decided(...matters);
}

/** A business question about a booking, put to someone in their role (default 3): its money, else their role. */
function askedOfBusiness(choice: Choice): Change {
  const money = moneyMatters(choice);
  return money.length === 0 ? decided({ kind: "theirRole" }) : decided(...money.map((kind) => ({ kind })));
}

/** A choice on a booking (its visit), or with none, what `none` says. */
function onBooking(choice: Choice, none: Change): Change {
  const bookingId = choice.target.bookingId;
  return bookingId === null ? none : decided({ kind: "visit", bookingId });
}

/** What reads a choice needs beyond itself, made only when asked. */
export interface ChangeReads {
  readonly identity: () => IdentityAccess;
}

/** Whether the sender answers an option about a booking for the business: a business role, and no part in it. */
async function putToBusiness(choice: Choice, turn: GateTurn, reads: ChangeReads): Promise<boolean> {
  const sender = turn.request.caller.personId;
  const bookingId = choice.target.bookingId;
  if (sender === null || bookingId === null) return false;
  const identity = reads.identity();
  const roles = await identity.rolesOf(sender);
  if (!roles.some((role) => BUSINESS_ROLES.includes(role))) return false;
  // A booking this business does not hold is no business question here: it stays a visit nobody decides (fails closed).
  const parties = await identity.parties(bookingId);
  if (parties === null) return false;
  return parties.booker !== sender && parties.served !== sender && parties.payer !== sender;
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
        default:
          return onBooking(choice, UNKNOWN);
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
        case "done":
          return onBooking(choice, UNKNOWN);
        default:
          return UNKNOWN;
      }
    case "searchEntry": {
      const base = businessStep(choice.step);
      return base === null ? onBooking(choice, ANYONE) : businessChange(choice, base);
    }
    case "option": {
      const base = businessStep(choice.step);
      if (base !== null) return businessChange(choice, base);
      if (await putToBusiness(choice, turn, reads)) return askedOfBusiness(choice);
      return onBooking(choice, decided({ kind: "own" }));
    }
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
    case "theirRole": {
      const role = sender === null ? undefined : await businessRoleOf(identity, sender);
      if (sender === null || role === undefined) return nobody("nobodyAllowed");
      return these([{ personId: sender, as: asProof(role) }]);
    }
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
 * owner or admin, or holding a role at the business for a business matter), else their own as a customer. It turns on
 * the standing they would act in, never on whether a booking exists or whether they decide it (the one case apart: the
 * owner acts as owner on a booking a death was reported on, T-308 default 4).
 */
async function proofStandingOf(
  mine: LimitDecider | undefined,
  matters: readonly LimitMatter[],
  sender: string,
  ports: AllowedPorts,
): Promise<ProofStanding> {
  if (mine !== undefined) {
    return mine.as === "owner" || mine.as === "admin" || mine.as === "staff" ? mine.as : "self";
  }
  if (sideOfMatters(matters) === "customer") return "self";
  const role = await businessRoleOf(ports.identity(), sender);
  return role === undefined ? "self" : asProof(role);
}

// ---- the decision ---------------------------------------------------------------------------------------------------

/** Why a part passes: it only protects, it is open to anyone (row 1), or the decider's own word. */
export type PassWhy = "protects" | "anyone" | "decider";

/** Why a part fails: an unproven sender, the wrong person, or nobody who may decide it. */
export type FailWhy = "unproven" | "notDecider" | "nobodyDecides";

/** What the commit runs for a failed part (T-305 default 8). */
export type AllowedNext =
  /** The code to the contact on file, and the question in this chat that takes it typed back: ids only. */
  | { readonly kind: "proofCode"; readonly proofCodeId: string; readonly openQuestionId: string }
  /** A question in each decider's own chat, about these matters. */
  | {
      readonly kind: "askDecider";
      readonly deciders: readonly string[];
      readonly matters: readonly LimitMatter[];
    }
  /** Nobody to ask: the step's safe default runs and a person is told (S13-31). */
  | { readonly kind: "nobodyDecides"; readonly why: NobodyWhy; readonly step: string };

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
  if (sender === null) return askDeciders("notDecider", named, change.matters);

  // The one rule first (default 6): is this the sender's own word? Nothing about who decides, or whether a booking
  // exists, reaches the answer before it.
  const mine = deciders.ok ? deciders.deciders.find((decider) => decider.personId === sender) : undefined;
  const as = await proofStandingOf(mine, change.matters, sender, ports);
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
    if (caller.kind !== "turn" || handleId === null || turnId === undefined) {
      return askDeciders("unproven", named, change.matters);
    }
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
  if (mine === undefined) return askDeciders("notDecider", named, change.matters);
  return pass("decider");
}
