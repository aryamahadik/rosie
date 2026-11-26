// What the Tool API base answers for a final fault (T-1551; T-1529's ruling, its card 5: ops/reviews/refusal-reply/
// rule-refusal.json; K-09 v1.13: contracts/tool-api/README.md defaults 216 to 220; DL-1195).
//
// gateAndCommit's handler fails a turn it cannot write closed by throwing inside the call's transaction, so the base
// rolls the transaction back and nothing is written. Six of those throws are the fault lists T-1529's ruling 1 sorts,
// each an error class carrying its list's own fault label (README v1.13 default 217):
//   - walk: WalkRefusedError (actions/src/commit/walk/errors.ts WalkFault);
//   - commit: CommitRefusedError (actions/src/commit/errors.ts CommitFault);
//   - companies: CompaniesRefusedError (journey-1/companies/errors.ts CompaniesFault);
//   - kinds: KindsRefusedError (journey-1/kinds/errors.ts KindsFault);
//   - kindsRead: KindsReadError (journey-1/kinds/errors.ts KindsReadFault; its reads readKindCatalog, readPickedKinds);
//   - companiesRead: CompaniesReadError (journey-1/companies/errors.ts CompaniesReadFault; its reads readPickedKinds,
//     readBusinessKinds, readTurnState).
// A final fault is one another try cannot change: the same request, on the same rows, bundle and binding, refuses the
// same way. turnRefusalOf gives the base K-09 v1.13's answer for it, turnRefused {from, fault, ids}, labels alone (each a
// K-08 v1 safeId: the three labels K-05 v1.23's parkReason takes field for field), so the runtime parks the turn at once
// (default 218) instead of three tries and silence. A transient fault (the walk's questionNotLive, the commit's
// wrongState and stillChanged, a read's transient, and kinds' reviewRefused when its ids carry openReviewItem's
// transient) gets none, so the base throws it as before and the runtime resends and reruns it; so does every throw that
// is none of the six lists (another list's error, K-05's transient, a handler's answer outside the contract, any unknown
// throw): README v1.13 default 217 and open gap 204. Every notBuilt is final already, answered by the base as before
// (default 219), so it is no list here.
//
// Each list's classes are a table keyed by the list's own fault type (FAULT_CLASSES), so typecheck refuses a fault added
// to a list with no class, and refusal.test.ts reads each list's union from its own file and holds the table to the
// ruling's classes fault by fault, so such a fault fails that test too until a later K-09 minor version classifies it
// (README v1.13 default 217's last lines).
//
// Defaults used (for ops/QUESTIONS.md):
//   1. Only gateAndCommit answers turnRefused (README v1.13 default 216, "Only gateAndCommit answers turnRefused"; the
//      base: tool-api.ts). The card's "every Tool API call that can meet a final fault" is read with it: v1.13 restates
//      no other call's errors, so matchKinds' KindsRefusedError and KindsReadError, and any lane's call, keep the throw.
//   2. A fault none of the tables holds, or a fault or a read that is no label, is none of the ruling's: thrown as an
//      unknown throw is, never answered (typecheck makes the first impossible for code that names a list's fault type).
//   3. kinds' reviewRefused carries openReviewItem's own code among its ids (kinds/writers.ts newWorkReviewPlan); its class
//      is read off those ids as the error carries them, before any id is left out of the answer.

import type { CommitFault } from "../commit/errors";
import { CommitRefusedError } from "../commit/errors";
import type { WalkFault } from "../commit/walk/errors";
import { WalkRefusedError } from "../commit/walk/errors";
import { isLabel } from "../../../runtime/src/trace";
import type { RefusalFrom, TurnRefusal } from "./errors";
import {
  CompaniesReadError,
  CompaniesRefusedError,
  type CompaniesFault,
  type CompaniesReadFault,
} from "./journey-1/companies/errors";
import {
  KindsReadError,
  KindsRefusedError,
  type KindsFault,
  type KindsReadFault,
} from "./journey-1/kinds/errors";

/** How T-1529's ruling 1 classes a fault: final (answered turnRefused) or transient (thrown, retried as today). */
export type FaultClass = "final" | "transient";

/**
 * A fault's class in its list's table: final or transient, or (kinds' reviewRefused alone) transient when its ids carry
 * openReviewItem's own `transient` code and final otherwise (README v1.13 default 217, list 4).
 */
export type FaultRule = FaultClass | "transientWhenIdsCarryTransient";

/** The six lists `from` names, in README v1.13 default 217's order. */
export const REFUSAL_FROMS = [
  "walk",
  "commit",
  "companies",
  "kinds",
  "kindsRead",
  "companiesRead",
] as const satisfies readonly RefusalFrom[];

/** The walk's faults (WalkRefusedError): questionNotLive alone is transient; the other sixteen are final. */
export const WALK_FAULT_CLASSES: Readonly<Record<WalkFault, FaultClass>> = {
  flowNotInBundle: "final",
  stepNotInBundle: "final",
  branchNotInBundle: "final",
  pathNotInBundle: "final",
  stepNotWellFormed: "final",
  loop: "final",
  walkTooLong: "final",
  notDecided: "final",
  businessNotInScope: "final",
  noServiceOrChatId: "final",
  noTurnKey: "final",
  questionNotLive: "transient",
  givesNotStep: "final",
  settledNotInBundle: "final",
  settledNotRows: "final",
  rowNotStep: "final",
  eventKeyAtWalk: "final",
};

/** The commit's faults (CommitRefusedError): wrongState and stillChanged are transient; the other twelve are final. */
export const COMMIT_FAULT_CLASSES: Readonly<Record<CommitFault, FaultClass>> = {
  callerNotTurn: "final",
  turnIdMismatch: "final",
  traceIdMismatch: "final",
  stateTable: "final",
  outboxRowWithPlan: "final",
  effectWithoutKey: "final",
  effectKeyTwice: "final",
  effectNotWellFormed: "final",
  idTwice: "final",
  askAgainNotAlone: "final",
  noTurnKey: "final",
  partNotGated: "final",
  wrongState: "transient",
  stillChanged: "transient",
};

/** Journey 1's companies' faults (CompaniesRefusedError): all nineteen final, secondCompany among them. */
export const COMPANIES_FAULT_CLASSES: Readonly<Record<CompaniesFault, FaultClass>> = {
  wrongStep: "final",
  noPerson: "final",
  pickNotWellFormed: "final",
  notOwnPick: "final",
  noKeptPick: "final",
  noTurnCompany: "final",
  twoPicksOneKind: "final",
  placedElsewhere: "final",
  notPlaced: "final",
  placementDisagrees: "final",
  draftElsewhere: "final",
  unknownBranch: "final",
  noSharedKinds: "final",
  secondSharedGroup: "final",
  sharedWordNoPick: "final",
  sharedWordTwoPicks: "final",
  sharedGroupTooSmall: "final",
  alreadyPlaced: "final",
  secondCompany: "final",
};

/** Journey 1's kinds' faults (KindsRefusedError): all final, but reviewRefused carrying openReviewItem's transient. */
export const KINDS_FAULT_CLASSES: Readonly<Record<KindsFault, FaultRule>> = {
  wrongStep: "final",
  noBranch: "final",
  noWords: "final",
  noPerson: "final",
  branchNotWords: "final",
  notBookedBesideKept: "final",
  notAnswered: "final",
  reviewRefused: "transientWhenIdsCarryTransient",
  reviewWrites: "final",
};

/** The kinds' reads' faults (KindsReadError): K-05's transient is transient; notFound and noCatalog are final. */
export const KINDS_READ_FAULT_CLASSES: Readonly<Record<KindsReadFault, FaultClass>> = {
  transient: "transient",
  notFound: "final",
  noCatalog: "final",
};

/** The companies' reads' faults (CompaniesReadError): K-05's transient is transient; the other three are final. */
export const COMPANIES_READ_FAULT_CLASSES: Readonly<Record<CompaniesReadFault, FaultClass>> = {
  transient: "transient",
  notFound: "final",
  unknownFact: "final",
  notWellFormed: "final",
};

/** Every list's table, by the `from` that names it. */
export const FAULT_CLASSES: Readonly<Record<RefusalFrom, Readonly<Record<string, FaultRule>>>> = {
  walk: WALK_FAULT_CLASSES,
  commit: COMMIT_FAULT_CLASSES,
  companies: COMPANIES_FAULT_CLASSES,
  kinds: KINDS_FAULT_CLASSES,
  kindsRead: KINDS_READ_FAULT_CLASSES,
  companiesRead: COMPANIES_READ_FAULT_CLASSES,
};

/** openReviewItem's own transient code, as kinds' reviewRefused carries it among its ids (kinds/writers.ts). */
const REVIEW_TRANSIENT = "transient";

/** A fault of the six lists as its error carries it: the list, the fault, and the ids it names, unfiltered. */
interface ListedFault {
  readonly from: RefusalFrom;
  readonly fault: string;
  readonly ids: readonly string[];
}

/** The list a thrown error is of, with its fault and ids (a read's ids: the read's own name); null for any other throw. */
function listedFaultOf(error: unknown): ListedFault | null {
  if (error instanceof WalkRefusedError) return { from: "walk", fault: error.fault, ids: error.ids };
  if (error instanceof CommitRefusedError) return { from: "commit", fault: error.fault, ids: error.ids };
  if (error instanceof CompaniesRefusedError)
    return { from: "companies", fault: error.fault, ids: error.ids };
  if (error instanceof KindsRefusedError) return { from: "kinds", fault: error.fault, ids: error.ids };
  if (error instanceof KindsReadError) return { from: "kindsRead", fault: error.fault, ids: [error.read] };
  if (error instanceof CompaniesReadError) {
    return { from: "companiesRead", fault: error.fault, ids: [error.read] };
  }
  return null;
}

/**
 * The class of `fault` in the list `from` names, given the ids its error carries: null when the list's table holds no
 * such fault (default 2).
 */
export function faultClassOf(from: RefusalFrom, fault: string, ids: readonly string[]): FaultClass | null {
  const table = FAULT_CLASSES[from];
  const rule = Object.hasOwn(table, fault) ? table[fault] : undefined;
  if (rule === undefined) return null;
  if (rule !== "transientWhenIdsCarryTransient") return rule;
  return ids.includes(REVIEW_TRANSIENT) ? "transient" : "final";
}

/** The ids as turnRefused carries them: in their order, each once (the first kept), and only those that are labels. */
export function refusalIdsOf(ids: readonly unknown[]): string[] {
  const kept: string[] = [];
  for (const id of ids) {
    if (isLabel(id) && !kept.includes(id)) kept.push(id);
  }
  return kept;
}

/**
 * K-09 v1.13's turnRefused for a thrown error that is a final fault of the six lists (README v1.13 defaults 216 and
 * 217): `from` the list, `fault` its label, `ids` its labels each once. Null for a transient fault and for any throw that
 * is none of the six lists, which the base throws as before. Nothing of the error but those labels reaches the answer:
 * no message, no read's K-05 answer, no value.
 */
export function turnRefusalOf(error: unknown): TurnRefusal | null {
  const listed = listedFaultOf(error);
  if (listed === null || !isLabel(listed.fault)) return null;
  if (faultClassOf(listed.from, listed.fault, listed.ids) !== "final") return null;
  return { error: "turnRefused", from: listed.from, fault: listed.fault, ids: refusalIdsOf(listed.ids) };
}
