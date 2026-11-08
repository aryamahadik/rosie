// Limit 3, Exact yes (C-083, T-301; arch 06 line 303): the decider's own yes, bound to the read-back's exact text and
// versions. It replaces T-298's fail-closed stub in this slot of the gate's registry (../limits.ts). The rule is
// exact-yes.ts; what it reads is facts.ts.
//
// `limit3` reads through the call's database transaction (the Tool API's scoped repo), T-308's identity and access
// service with its defaults, and no page or AI binding yet (so a secure page's yes and an own AI's confirm are refused
// until K-21's capture and T-328's bind land). createLimit3 takes other ports, as the tests do.

import type { GatePart, GateTurn, Limit, LimitVerdict } from "../framework";
import { decideExactYes, type ExactYesDecision, type ExactYesPorts } from "./exact-yes";
import {
  NOTHING_BOUND,
  databaseOf,
  identityOver,
  questionReaderOf,
  type IdentityDefaults,
  type QuestionReader,
  type YesBindings,
} from "./facts";
import type { IdentityAccess } from "../../domain/identity-access";

export interface Limit3Deps {
  /** The open questions' read on the call's repo. Default: the data-access call on the call's transaction. */
  readonly questions?: (repo: unknown) => QuestionReader;
  /** Who decides at the call's business. Default: T-308's service on the call's transaction (identity defaults). */
  readonly identity?: (repo: unknown, businessId: string) => IdentityAccess;
  /** Admins' powers and the served person's facts for the default identity service. */
  readonly identityDefaults?: IdentityDefaults;
  /** What a page's yes or an own AI's confirm is bound to. Default: NOTHING_BOUND, so both are refused. */
  readonly bindings?: YesBindings;
}

/** Limit 3 in the gate's registry, with the full decision the commit's outcome writer reads. */
export interface ExactYesLimit extends Limit<3> {
  /** The part's decision: pass, notChecked, or the failure with the fresh read-back or the safe default and notice. */
  decide(part: GatePart, turn: GateTurn): Promise<ExactYesDecision>;
}

/** The limit's K-09 verdict for the gate from its decision. */
export function verdictOf(decision: ExactYesDecision): LimitVerdict<3> {
  switch (decision.result) {
    case "pass":
      return { result: "pass" };
    case "notChecked":
      return { result: "notChecked" };
    case "fail":
      return { result: "fail", outcome: { ...decision.outcome } };
  }
}

/** Made once, when first asked for. */
function once<T>(make: () => T): () => T {
  let made: { readonly value: T } | null = null;
  return () => {
    made ??= { value: make() };
    return made.value;
  };
}

export function createLimit3(deps: Limit3Deps = {}): ExactYesLimit {
  const questionsOf = deps.questions ?? ((repo: unknown) => questionReaderOf(databaseOf(repo)));
  const identityOf =
    deps.identity ??
    ((repo: unknown, businessId: string) => identityOver(repo, businessId, deps.identityDefaults));
  const bindings = deps.bindings ?? NOTHING_BOUND;
  const decide = (part: GatePart, turn: GateTurn): Promise<ExactYesDecision> => {
    const ports: ExactYesPorts = {
      questions: once(() => questionsOf(turn.repo)),
      identity: once(() => identityOf(turn.repo, turn.businessId)),
      bindings,
    };
    return decideExactYes(part, turn, ports);
  };
  return {
    limit: 3,
    decide,
    async check(part, turn) {
      return verdictOf(await decide(part, turn));
    },
  };
}

/** Limit 3 as the gate runs it (../limits.ts). */
export const limit3: ExactYesLimit = createLimit3();

export {
  ASKS_BEFORE_SAFE_DEFAULT,
  BUSINESS_ROLES,
  MONEY_REASONS,
  decideExactYes,
  freshReadBackOutcome,
  isExactAnswer,
  movesMoney,
  optionIndex,
  plainWords,
  safeDefaultOutcome,
  sameVersions,
  sha256Hex,
  type ExactYesDecision,
  type ExactYesPorts,
  type FreshReadBack,
  type Limit3Outcome,
  type NotExactWhy,
  type OwnerNotice,
  type SafeDefault,
} from "./exact-yes";
export {
  NOTHING_BOUND,
  askedQuestionOf,
  databaseOf,
  identityOver,
  questionReaderOf,
  type AskedQuestion,
  type BoundYes,
  type IdentityDefaults,
  type QuestionReader,
  type RowRef,
  type SentOption,
  type YesBindings,
} from "./facts";
