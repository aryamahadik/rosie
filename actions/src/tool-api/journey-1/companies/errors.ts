// What journey 1's companies folder throws (T-1492). Each message names a read, a step, a fault or a code: never the
// owner's words, an id, a number, a K-05 answer or the turn's chat id (K-08 v1 README line 75; DL-935: never log a read's
// answer raw). A throw inside a step writer or a buttons settler fails the call closed with nothing written (the walk:
// actions/src/commit/walk/writes.ts and buttons.ts; the Tool API base rolls the call's transaction back).

import type { NotFoundError, TransientError } from "../../../../../db/repo/targets";
import type { UnknownFactError } from "../../../../../db/repo/turn-state";

/** The K-05 reads this folder makes: item 79, item 72 and K-24's catalog by id through item 26's setup facts. */
export type CompaniesReadName = "readPickedKinds" | "readBusinessKinds" | "readTurnState";

/**
 * Why a K-05 read failed the call closed:
 *   - transient: K-05's transient answer (a serialization failure, a deadlock or a lost connection);
 *   - notFound: the read found no row of the request's person, business, handle or catalog row (a listed kind with no
 *     kinds row or no kind_flows row in a flow), so nothing is placed;
 *   - unknownFact: readTurnState knows no home for a catalog fact asked (a binding that reads another table);
 *   - notWellFormed: an answer that does not have the shape the read promises (a catalog value that is not a list of
 *     plug-in names, an answer for another business, a fact asked once and answered twice).
 */
export type CompaniesReadFault = "transient" | "notFound" | "unknownFact" | "notWellFormed";

/**
 * A K-05 read failed the call closed, never read as none. `answer` is K-05's error answer as the read gave it, or null
 * when the answer came back but cannot be read (notWellFormed). The message names the read and the fault alone.
 */
export class CompaniesReadError extends Error {
  override name = "CompaniesReadError";
  readonly read: CompaniesReadName;
  readonly fault: CompaniesReadFault;
  readonly answer: TransientError | NotFoundError | UnknownFactError | null;

  constructor(
    read: CompaniesReadName,
    fault: CompaniesReadFault,
    answer: TransientError | NotFoundError | UnknownFactError | null,
  ) {
    super(`${read} answered ${fault}: the call fails closed and nothing is placed`);
    this.read = read;
    this.fault = fault;
    this.answer = answer;
  }
}

/**
 * Why the one-kind wrapper or S1-04's one-kind settler refused (refused, never guessed; K-09 README default 199 item (4)):
 *   - wrongStep: the wrapper wrapped a writer called for another step than S1-02, or the settler was asked at another
 *     step than S1-04 (the binding's fault);
 *   - noPerson: the turn names no person to own the picks (K-09 caller.personId null);
 *   - pickNotWellFormed: a picked_kinds insert in the walk's rows is not K-24 v1's shape (no id, an unknown outcome, a
 *     listed or new_work pick with no kind);
 *   - notOwnPick: a picked_kinds insert in the walk's rows names another person than the turn's as its owner;
 *   - noKeptPick: the settler counted no kept pick (default 199 item (4) "None": neither kept S1-02 branch leaves one, as
 *     default 184 refuses an owner with no kept pick);
 *   - noTurnCompany: the caller's person owns no company whose business is the call's business (default 184), so the one
 *     kind has no company to take;
 *   - twoPicksOneKind: the one kind counted has two kept picks, which would land in one company (K-23 company_kinds' key
 *     and K-24 picked_kinds_one_per_company_kind; default 184);
 *   - placedElsewhere: the one kept pick on file is placed already, in another company than the one the turn runs under;
 *   - notPlaced: the settler found no placement the wrapper remembered for this walk and part (S1-02's writer bound
 *     without the wrapper, or S1-04 reached by a walk that did not walk S1-02);
 *   - placementDisagrees: the settler's recount and the wrapper's placement disagree (another count, another pick, or the
 *     rows built no longer hold the placed insert and its company kind as the wrapper left them).
 */
export type CompaniesFault =
  | "wrongStep"
  | "noPerson"
  | "pickNotWellFormed"
  | "notOwnPick"
  | "noKeptPick"
  | "noTurnCompany"
  | "twoPicksOneKind"
  | "placedElsewhere"
  | "notPlaced"
  | "placementDisagrees";

/** The one-kind wrapper or settler refused: the whole call is refused and nothing is written. */
export class CompaniesRefusedError extends Error {
  override name = "CompaniesRefusedError";
  readonly fault: CompaniesFault;
  /** The steps at fault, as labels (step ids), or empty. */
  readonly ids: readonly string[];

  constructor(fault: CompaniesFault, ids: readonly string[] = []) {
    super(
      ids.length === 0
        ? `the companies refused the part (${fault}); nothing was written`
        : `the companies refused the part (${fault}: ${ids.join(", ")}); nothing was written`,
    );
    this.fault = fault;
    this.ids = [...ids];
  }
}
