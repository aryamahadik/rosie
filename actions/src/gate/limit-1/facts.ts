// Where limit 1 (C-081, T-299) gets what it reads, each behind a port so the rule (allowed.ts) is plain code:
//   - who decides a matter, a person's live roles at the business and a booking's booker, person served and payer:
//     T-308's identity and access service, over K-04 v1 on the call's transaction (identityOver);
//   - a booking's stage (K-04 v1 bookings.stage, through the same K-04 reads: BookingStages), since the booker goes on
//     making a booking that is still being made (S13-45 row 1: "book a new visit: anyone, at any door");
//   - S13-45's one rule, whether a request is a person's own: ContactsOnFile ("a request counts when it comes from the
//     contact on file, in its own one-to-one thread");
//   - the code an unproven sender gets (K-09 v1 sendProofCode purpose unprovenSender; K-22 v1 proof_codes purpose
//     link_record): ProofCodes, T-322's. It is not built yet, so the shipped limit has none, and a part that needs a code
//     is refused (notBuilt), never passed;
//   - each step's card in the turn's bundle (K-01 v1 step: its section, who it is from and to, a split's branches), which
//     says the step's side (DL-188 ruling 1): StepCards. The gate is not given the turn's bundle yet, so the shipped limit
//     reads none (NO_STEP_CARDS): every step's side cannot be read, and every choice is the business's (fails closed).
//
// Every read takes and gives ids and closed labels: never a person's words, name, number or email (the action layer never
// reads free text: arch 02 line 139), so nothing limit 1 answers can carry one into a log, a span or an error.

import type { BookingStage } from "../../../../db/repo/bookings-head";
import type { Sql, Tx } from "../../../../db/repo/scope";
import {
  NOTHING_ON_FILE,
  NO_ADMIN_POWERS,
  createIdentityAccess,
  type AdminPowers,
  type DecidesAs,
  type IdentityAccess,
  type IdentityReader,
  type ServedFactsReader,
} from "../../domain/identity-access";
import type { GateRequest } from "../framework";

/** Who makes the call (K-09 v1 caller.kind): a turn, a page, an outside AI, the console, a job, a clock, the actor. */
export type CallerKind = GateRequest["caller"]["kind"];

/**
 * The standing a person would decide in, which says which contact on file is theirs (S13-45): T-308's (the person
 * served, a parent or guardian, the owner, an admin), the booker of a booking still being made (row 1), or the person
 * themself for their own record (row 3: "Change where updates go: the customer"). A staff member decides nothing in their
 * role here: on a booking they play no part in, only the business's fee or refund, which the owner or an admin decides
 * (S13-31; DL-183 N2).
 */
export type Standing = DecidesAs | "booker" | "self";

/**
 * Which contact on file proves a sender (S13-45): their own as a customer, whatever they decide as (self: rows 2, 3 and
 * 5, "the contact on file"), or their business role's own (owner, admin, staff: row 8 "from the owner's mobile or email
 * on file", "Admins act only ... from their own phone or email on file"; row 9 "from their own phone or email on file").
 */
export type ProofStanding = "self" | "owner" | "admin" | "staff";

/** Whose contact on file proves a standing: a customer's own (rows 2, 3, 5) or the business role's own (rows 8, 9). */
export type Side = "customer" | "business";

/** The standings the business side holds (S13-45 rows 8 and 9). */
export const BUSINESS_STANDINGS: readonly string[] = ["owner", "admin", "staff"];

export function sideOf(as: Standing | ProofStanding): Side {
  return BUSINESS_STANDINGS.includes(as) ? "business" : "customer";
}

// ---- S13-45's one rule --------------------------------------------------------------------------------------------

/** One question to ContactsOnFile: is this call `personId`'s own, proven as `as`? */
export interface OwnAsk {
  /** The call's business (CallContext.businessId). */
  readonly businessId: string;
  readonly personId: string;
  readonly as: ProofStanding;
  readonly caller: CallerKind;
  /** The handle the turn's texts came from (K-09 v1 turn.handleId); null for a call that is no turn. */
  readonly handleId: string | null;
}

export interface ContactsOnFile {
  /**
   * Whether the request is the person's own by S13-45's one rule: it comes from their contact on file for that standing,
   * in its own one-to-one thread (or a code sent there was typed back in the same conversation, which links it).
   */
  isOwn(ask: OwnAsk): Promise<boolean>;
}

/**
 * The one rule over what is on file today (default 5 in allowed.ts):
 *   - as a customer (self): a turn's handle that K-04 v1 links to the person (person_handles, read through T-308's
 *     sender()): the contact on file a booking was given, or one proven by a code typed back (S13-45: "Only a match to
 *     what they type links the record on file for the phone or email they proved");
 *   - a business standing (owner, admin, staff): the role's own mobile or email on file (K-22 v1 accounts and staff),
 *     which has no reader yet (T-321), so it is never proven here: a phone linked to the owner as a customer is not the
 *     owner's mobile on file (K-09 v1 commit-limit-1-unproven-sender.json: "a new mobile that has not been proven for his
 *     owner role");
 *   - a call that is no turn: a page's signed-in session (K-21) and an outside AI's bound token (T-328) are not read yet,
 *     so neither is proven here.
 */
export function contactsOnFileOver(identity: () => IdentityAccess): ContactsOnFile {
  return {
    async isOwn(ask) {
      if (ask.caller !== "turn" || ask.handleId === null) return false;
      if (sideOf(ask.as) === "business") return false;
      const sender = await identity().sender(ask.handleId);
      return sender.people.some((person) => person.personId === ask.personId);
    },
  };
}

// ---- the code an unproven sender gets (T-322) -----------------------------------------------------------------------

/**
 * What limit 1 asks T-322 for: a code to `forPersonId`'s contact on file for `as`, typed back in the chat of
 * `typedBackIn` (S13-45: "Or a code is sent to the contact on file and typed back in the same conversation"), as K-09 v1
 * sendProofCode purpose unprovenSender writes it (K-22 v1 link_record: person_id the person, business_id the business
 * the code's words name, "Your Lee's Barbershop code is 4829"). It never names a booking or who decides, so the code's
 * words cannot confirm that a booking exists: the same ask whether one does or not.
 */
export interface CodeAsk {
  readonly businessId: string;
  readonly forPersonId: string;
  readonly as: ProofStanding;
  readonly typedBackIn: string;
  /** The turn whose choice waits for the code (proveCode then names it: redecideTurnId). */
  readonly turnId: string;
  /** The part of decide that waits. */
  readonly part: number;
}

/** The code and the question in the sender's own chat that takes it typed back, which the turn's commit writes. */
export interface PlannedCode {
  readonly proofCodeId: string;
  readonly openQuestionId: string;
}

export interface ProofCodes {
  /** The ids of the code row and of the question that takes it typed back (K-09 v1 limit1Outcome proofCodeSent). */
  codeFor(ask: CodeAsk): Promise<PlannedCode>;
}

// ---- a booking's stage --------------------------------------------------------------------------------------------

export interface BookingStages {
  /** A booking's stage at this business (K-04 v1 bookings.stage); null when this business has no such booking. */
  stageOf(bookingId: string): Promise<BookingStage | null>;
}

/** The stage through K-04's booking head read, for one business only (another business's booking is never answered). */
export function bookingStagesOver(reader: IdentityReader, businessId: string): BookingStages {
  return {
    async stageOf(bookingId) {
      const head = await reader.bookingHead(bookingId);
      return head !== null && head.id === bookingId && head.businessId === businessId ? head.stage : null;
    },
  };
}

// ---- each step's card in the turn's bundle (K-01 v1; DL-188 ruling 1) ---------------------------------------------

/**
 * Who acts or is told on a step (K-01 v1 lane): owner (the owner or office manager), san (Rosie), staff, cust (the
 * customer), agent (the customer's own AI), pay (Stripe), out (an outside service), other (anyone else).
 */
export type Lane = "owner" | "san" | "staff" | "cust" | "agent" | "pay" | "out" | "other";

const LANES: readonly string[] = ["owner", "san", "staff", "cust", "agent", "pay", "out", "other"];

/** One branch of a split as limit 1 reads it (K-01 v1 branch): its label, word for word, and its own steps. */
export interface StepBranch {
  readonly label: string;
  readonly steps: readonly string[];
}

/** One step as limit 1 reads it from the turn's bundle (K-01 v1 step): its section, who it is from and to, its branches. */
export interface StepCard {
  readonly id: string;
  /** K-01 v1 step.section, 1 to 13; null when the value holds none. */
  readonly section: number | null;
  /** K-01 v1 step.who: who acts, so who it is from; null when the value holds no lane. */
  readonly who: Lane | null;
  /** K-01 v1 step.to: who it is for, when someone is; null for nobody (an automatic step) or no lane. */
  readonly to: Lane | null;
  /** A split's branches (K-01 v1 step.branches); none for a plain step. */
  readonly branches: readonly StepBranch[];
}

export interface StepCards {
  /** The step as the turn's bundle holds it, or null when it cannot be read: no bundle read, or no such step in it. */
  step(stepId: string): Promise<StepCard | null>;
}

/**
 * No bundle read: every step's side cannot be read, so every choice is the business's (DL-188 ruling 1). The shipped
 * limit's default until the gate is given the turn's bundle (the frontier reads it through FrontierBundles).
 */
export const NO_STEP_CARDS: StepCards = { step: () => Promise.resolve(null) };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function laneOf(value: unknown): Lane | null {
  return typeof value === "string" && LANES.includes(value) ? (value as Lane) : null;
}

function branchesOf(value: unknown): StepBranch[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): StepBranch[] =>
    isRecord(item) && typeof item.label === "string" && Array.isArray(item.steps)
      ? [{ label: item.label, steps: item.steps.filter((step): step is string => typeof step === "string") }]
      : [],
  );
}

function stepCardOf(id: string, value: unknown): StepCard | null {
  if (!isRecord(value) || value.id !== id) return null;
  const { section } = value;
  return {
    id,
    section:
      typeof section === "number" && Number.isInteger(section) && section >= 1 && section <= 13
        ? section
        : null,
    who: laneOf(value.who),
    to: laneOf(value.to),
    branches: branchesOf(value.branches),
  };
}

/**
 * The step cards of the turn's bundle, from its K-01 v1 flow graphs (each a parsed `flowGraph` value), narrowed field by
 * field: a value that is not K-01's graph of flow A or B gives no step, and a step value that does not carry its own id
 * gives none, never a wrong one. An A or B step is read from its own flow's graph only; a shared step from the first
 * graph that holds it, in the order given.
 */
export function stepCardsOf(graphs: readonly unknown[]): StepCards {
  const views = graphs.flatMap((graph): { flow: string; steps: Record<string, unknown> }[] =>
    isRecord(graph) &&
    graph.contract === "bundle.v1" &&
    (graph.flow === "A" || graph.flow === "B") &&
    isRecord(graph.steps)
      ? [{ flow: graph.flow, steps: graph.steps }]
      : [],
  );
  return {
    step(stepId) {
      const own = stepId.startsWith("A") ? "A" : stepId.startsWith("B") ? "B" : null;
      for (const view of views) {
        if (own !== null && view.flow !== own) continue;
        if (!Object.hasOwn(view.steps, stepId)) continue;
        const card = stepCardOf(stepId, view.steps[stepId]);
        if (card !== null) return Promise.resolve(card);
      }
      return Promise.resolve(null);
    },
  };
}

// ---- the defaults over the call's database transaction ----------------------------------------------------------

/** The call holds no database transaction, so limit 1's default reads cannot run on it. */
export class NoCallDatabaseError extends TypeError {
  override name = "NoCallDatabaseError";

  constructor() {
    super("limit 1 reads through the call's database transaction");
  }
}

/**
 * The call's repo as the data-access calls take it: the Tool API's scoped transaction (a postgres.js transaction, which
 * is a tagged-template function). Anything else is not a database: NoCallDatabaseError, which the limit answers as
 * notBuilt, so the part is refused and nothing passes.
 */
export function databaseOf(repo: unknown): Sql | Tx {
  if (typeof repo !== "function") throw new NoCallDatabaseError();
  return repo as Sql | Tx;
}

export interface IdentityDefaults {
  /** Admins' powers (K-22 v1 team_powers, T-321). Default NO_ADMIN_POWERS: no admin decides a business matter. */
  readonly adminPowers?: AdminPowers;
  /**
   * The person served's age band and parents or guardians (K-28; CQ-71). Default NOTHING_ON_FILE, chosen here: until that
   * reader lands, the person served decides as an adult (T-308 default 1).
   */
  readonly servedFacts?: ServedFactsReader;
}

/** T-308's service for the call's business, over K-04's reads on the call's transaction. */
export function identityOver(
  reader: IdentityReader,
  businessId: string,
  defaults: IdentityDefaults = {},
): IdentityAccess {
  return createIdentityAccess({
    businessId,
    reader,
    adminPowers: defaults.adminPowers ?? NO_ADMIN_POWERS,
    servedFacts: defaults.servedFacts ?? NOTHING_ON_FILE,
  });
}
