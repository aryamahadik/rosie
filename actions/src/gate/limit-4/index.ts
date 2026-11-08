// Limit 4, Versions (C-084, T-302; arch 06 line 305): compare-and-set on every row the read-back showed; reload once;
// changed but possible: today's facts and a fresh yes; impossible: say what changed; a second conflict on one question: a
// person. It replaces T-298's fail-closed stub in this slot of the gate's registry (../limits.ts). The rule is
// versions.ts; what it reads is facts.ts.
//
// `limit4` reads through the call's database transaction (the Tool API's scoped repo): the open questions as limit 3
// reads them, and today's versions and booking heads. createLimit4 takes other ports, as the tests do.
//
// What the commit reads from it (T-305's commit and the walk that builds a passed part's writes):
//   - decide(part, turn).compareAndSet on a pass: the rows the commit compares and sets for the part, at the versions
//     shown (compareAndSetOf), which the walk puts in the part's writes (the commit's UnitWrites.versionsRead);
//   - decide(part, turn).next on a failure: the fresh yes, what changed, or the review item, which the commit's outcome
//     writer writes.

import type { GatePart, GateTurn, Limit, LimitVerdict } from "../framework";
import { questionReaderOf, type QuestionReader } from "../limit-3/facts";
import { databaseOf, todayReaderOf, type TodayReader } from "./facts";
import { decideVersions, type VersionsDecision, type VersionsPorts } from "./versions";

export interface Limit4Deps {
  /** The open questions' read on the call's repo. Default: limit 3's reader on the call's transaction. */
  readonly questions?: (repo: unknown) => QuestionReader;
  /** Today's versions and booking heads on the call's repo. Default: the data-access calls on its transaction. */
  readonly today?: (repo: unknown) => TodayReader;
}

/** Limit 4 in the gate's registry, with the full decision the commit reads. */
export interface VersionsLimit extends Limit<4> {
  /** The part's decision: pass with the rows to compare and set, notChecked, notBuilt, or the failure and what next. */
  decide(part: GatePart, turn: GateTurn): Promise<VersionsDecision>;
}

/** The limit's K-09 verdict for the gate from its decision. */
export function verdictOf(decision: VersionsDecision): LimitVerdict<4> {
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

/** Made once, when first asked for. */
function once<T>(make: () => T): () => T {
  let made: { readonly value: T } | null = null;
  return () => {
    made ??= { value: make() };
    return made.value;
  };
}

export function createLimit4(deps: Limit4Deps = {}): VersionsLimit {
  const questionsOf = deps.questions ?? ((repo: unknown) => questionReaderOf(databaseOf(repo)));
  const todayOf = deps.today ?? ((repo: unknown) => todayReaderOf(databaseOf(repo)));
  const decide = (part: GatePart, turn: GateTurn): Promise<VersionsDecision> => {
    const ports: VersionsPorts = {
      questions: once(() => questionsOf(turn.repo)),
      today: once(() => todayOf(turn.repo)),
    };
    return decideVersions(part, turn, ports);
  };
  return {
    limit: 4,
    decide,
    async check(part, turn) {
      return verdictOf(await decide(part, turn));
    },
  };
}

/** Limit 4 as the gate runs it (../limits.ts). */
export const limit4: VersionsLimit = createLimit4();

export {
  ASKS_BEFORE_PERSON,
  CLOSED_STAGES,
  RESERVED_TABLES,
  changedRows,
  compareAndSetOf,
  decideVersions,
  freshYesOutcome,
  saidWhatChangedOutcome,
  toPersonOutcome,
  type ChangedRow,
  type FreshYes,
  type Limit4Outcome,
  type NotPossibleWhy,
  type ReviewItem,
  type SaidWhatChanged,
  type ToPerson,
  type VersionsDecision,
  type VersionsPorts,
} from "./versions";
export { databaseOf, todayReaderOf, type BookingNow, type BookingStage, type TodayReader } from "./facts";
