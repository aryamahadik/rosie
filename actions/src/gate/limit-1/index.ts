// Limit 1, Allowed (C-081, T-299; arch 06 line 299): a change that only protects passes on anyone's word; any other
// change needs the decider's own yes (S13-45), and fails with a code to the contact on file for an unproven sender or a
// question in the decider's own chat for the wrong person. It replaces T-298's fail-closed stub in this slot of the gate's
// registry (../limits.ts). The rule is allowed.ts; what it reads is facts.ts.
//
// `limit1` reads through the call's database transaction (the Tool API's scoped repo): T-308's identity and access
// service with its defaults, the booking's stage, and S13-45's one rule over K-04's links. A call that holds no database
// transaction cannot be read, so a part that needs a read is refused (notBuilt); a protect-only part needs none. It has no
// proof codes yet (T-322), so a part whose sender must be proven by a code is refused (notBuilt) until they land. It is
// not given the turn's bundle yet (K-01 v1), so it reads no step's card: every step's side cannot be read, and every
// choice is the business's (DL-188 ruling 1; fails closed) until the gate hands it the bundle's steps (`steps`).
// createLimit1 takes other ports, as the tests do.

import { identityReaderOf, type IdentityAccess } from "../../domain/identity-access";
import type { GatePart, GateTurn, Limit, LimitVerdict } from "../framework";
import { decideAllowed, type AllowedDecision, type AllowedPorts } from "./allowed";
import {
  NO_STEP_CARDS,
  NoCallDatabaseError,
  bookingStagesOver,
  contactsOnFileOver,
  databaseOf,
  identityOver,
  type BookingStages,
  type ContactsOnFile,
  type IdentityDefaults,
  type ProofCodes,
  type StepCards,
} from "./facts";

/** The bundle a turn runs on (K-02 v1 context.bundleId: the content hash and the build). */
export type TurnBundleId = GateTurn["context"]["bundleId"];

export interface Limit1Deps {
  /**
   * The turn's bundle's step cards (K-01 v1), read under the context's bundle id, the context's flow first. Default: none
   * (NO_STEP_CARDS), so every step's side cannot be read and every choice is the business's (DL-188 ruling 1).
   */
  readonly steps?: (bundleId: TurnBundleId, flow: GateTurn["context"]["flow"]) => StepCards;
  /** Who decides at the call's business. Default: T-308's service on the call's transaction (identity defaults). */
  readonly identity?: (repo: unknown, businessId: string) => IdentityAccess;
  /** Admins' powers and the served person's facts for the default identity service. */
  readonly identityDefaults?: IdentityDefaults;
  /** A booking's stage at the call's business. Default: K-04's booking head on the call's transaction. */
  readonly stages?: (repo: unknown, businessId: string) => BookingStages;
  /** S13-45's one rule. Default: K-04's links for a customer; nothing yet for a business role, a page or an AI. */
  readonly contacts?: (identity: IdentityAccess) => ContactsOnFile;
  /** T-322's proof codes. Default: none, so a part that needs a code is refused (notBuilt). */
  readonly proofCodes?: ProofCodes;
}

/** Limit 1 in the gate's registry, with the full decision the commit's outcome writer reads. */
export interface AllowedLimit extends Limit<1> {
  /** The part's decision: pass, notChecked, notBuilt, or the failure with the code, the question or the safe default. */
  decide(part: GatePart, turn: GateTurn): Promise<AllowedDecision>;
}

/** The limit's K-09 verdict for the gate from its decision. */
export function verdictOf(decision: AllowedDecision): LimitVerdict<1> {
  switch (decision.result) {
    case "pass":
      return { result: "pass" };
    case "notChecked":
      return { result: "notChecked" };
    case "notBuilt":
      return { result: "notBuilt" };
    case "fail":
      return { result: "fail", outcome: { ...decision.outcome } };
  }
}

/** The part could not be checked: the call holds no database transaction for limit 1's reads. */
const NO_DATABASE: AllowedDecision = { result: "notBuilt", port: "database" };

/** Made once, when first asked for. */
function once<T>(make: () => T): () => T {
  let made: { readonly value: T } | null = null;
  return () => {
    made ??= { value: make() };
    return made.value;
  };
}

export function createLimit1(deps: Limit1Deps = {}): AllowedLimit {
  const identityOf =
    deps.identity ??
    ((repo: unknown, businessId: string) =>
      identityOver(identityReaderOf(databaseOf(repo)), businessId, deps.identityDefaults));
  const stagesOf =
    deps.stages ??
    ((repo: unknown, businessId: string) =>
      bookingStagesOver(identityReaderOf(databaseOf(repo)), businessId));
  const contactsOf = deps.contacts ?? ((identity: IdentityAccess) => contactsOnFileOver(() => identity));
  const stepsOf = deps.steps ?? (() => NO_STEP_CARDS);
  const decide = async (part: GatePart, turn: GateTurn): Promise<AllowedDecision> => {
    const identity = once(() => identityOf(turn.repo, turn.businessId));
    const ports: AllowedPorts = {
      identity,
      steps: once(() => stepsOf(turn.context.bundleId, turn.context.flow)),
      stages: once(() => stagesOf(turn.repo, turn.businessId)),
      contacts: once(() => contactsOf(identity())),
      proofCodes: deps.proofCodes ?? null,
    };
    try {
      return await decideAllowed(part, turn, ports);
    } catch (error) {
      // A call that holds no database transaction cannot be read here: the part is refused (notBuilt), never passed,
      // and the gate refuses the whole call (LimitNotBuiltError). Any other throw fails the call as it is.
      if (error instanceof NoCallDatabaseError) return NO_DATABASE;
      throw error;
    }
  };
  return {
    limit: 1,
    decide,
    async check(part, turn) {
      return verdictOf(await decide(part, turn));
    },
  };
}

/** Limit 1 as the gate runs it (../limits.ts). */
export const limit1: AllowedLimit = createLimit1();

export {
  BUSINESS_ROLES,
  NEW_BOOKING_DOORS,
  NEW_VISIT_STEPS,
  OWNER_ONLY_STEPS,
  OWN_RECORD_STEPS,
  askedDeciderOutcome,
  changeOf,
  decideAllowed,
  proofCodeSentOutcome,
  sideOfStep,
  type AllowedDecision,
  type AllowedNext,
  type AllowedPorts,
  type Change,
  type ChangeReads,
  type FailWhy,
  type Limit1Outcome,
  type LimitDecider,
  type LimitMatter,
  type NobodyWhy,
  type PassWhy,
  type StepSide,
} from "./allowed";
export {
  BUSINESS_STANDINGS,
  NO_STEP_CARDS,
  NoCallDatabaseError,
  bookingStagesOver,
  contactsOnFileOver,
  databaseOf,
  identityOver,
  sideOf,
  stepCardsOf,
  type BookingStages,
  type CallerKind,
  type CodeAsk,
  type ContactsOnFile,
  type IdentityDefaults,
  type Lane,
  type OwnAsk,
  type PlannedCode,
  type ProofCodes,
  type ProofStanding,
  type Side,
  type Standing,
  type StepBranch,
  type StepCard,
  type StepCards,
} from "./facts";
