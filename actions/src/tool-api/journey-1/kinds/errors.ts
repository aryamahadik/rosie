// What journey 1's kinds folder throws (T-633). Each message names a call, a read, a step, a fault or a code: never the
// owner's words, an id, a number, a K-05 answer or the turn's chat id (K-08 v1 README line 75; DL-935: never log a read's
// answer raw). A throw inside gateAndCommit's or matchKinds' handler rolls the call's transaction back (the Tool API
// base), so nothing is written (fail closed).

import type { NotFoundError, TransientError } from "../../../../../db/repo/targets";
import type { CallName } from "../../calls";
import { NotBuiltError } from "../../errors";

/** The two K-05 v1.19 reads this folder makes (items 78 and 79). */
export type KindsReadName = "readKindCatalog" | "readPickedKinds";

/**
 * Why a K-05 read failed the call closed:
 *   - transient: K-05's transient answer (a serialization failure, a deadlock or a lost connection);
 *   - notFound: item 79 found no row of the request's person or business (nothing read beyond it);
 *   - noCatalog: item 78 answered no trade-file kind the matcher can offer (the catalog seed has not run: K-05 v1.19
 *     default 170; T-632's KindCatalogError), so nothing is picked and S1-02 is asked again later.
 */
export type KindsReadFault = "transient" | "notFound" | "noCatalog";

/**
 * A K-05 read failed the call closed, never read as none. `answer` is K-05's error answer as the read gave it (transient
 * with its SQLSTATE, notFound with its table and row), kept so matchKinds can answer K-09's own transient; null for
 * noCatalog. The message names the read and the fault alone.
 */
export class KindsReadError extends Error {
  override name = "KindsReadError";
  readonly read: KindsReadName;
  readonly fault: KindsReadFault;
  readonly answer: TransientError | NotFoundError | null;

  constructor(read: KindsReadName, fault: KindsReadFault, answer: TransientError | NotFoundError | null) {
    super(`${read} answered ${fault}: the call fails closed and nothing is picked`);
    this.read = read;
    this.fault = fault;
    this.answer = answer;
  }
}

/**
 * Why a kinds writer or matchKinds refused (refused, never guessed):
 *   - wrongStep: a writer was called for another step than its own (the binding's fault);
 *   - noBranch: S1-02's answer chose no branch of S1-02 (an option of its question is a branch: K-02 v1 choice.branch);
 *   - noWords: the answer carries none of the owner's words that name a kind of work (no part is left once function
 *     words and numbers are dropped: T-632's words.ts), so nothing can be picked;
 *   - noPerson: the turn names no person to own the picks or receive the message (K-09 caller.personId null);
 *   - branchNotWords: the branch decide picked does not fit what the kind matcher reads in the words ("All on the list"
 *     with a part no listed kind fits, "One isn't on the list yet" with no part new or with a part Rosie never books);
 *   - notAnswered: S1-03's writer found no S1-02 answer of this part in the walk's run, or one that drafted nothing;
 *   - reviewRefused: the review item's plan (writers.ts newWorkReviewPlan) got one of openReviewItem's errors (its
 *     subject not found, say);
 *   - reviewWrites: openReviewItem's writes held a row the plan does not hand on (a clock row or a message).
 */
export type KindsFault =
  | "wrongStep"
  | "noBranch"
  | "noWords"
  | "noPerson"
  | "branchNotWords"
  | "notAnswered"
  | "reviewRefused"
  | "reviewWrites";

/** A kinds writer or matchKinds refused: the whole call is refused and nothing is written. */
export class KindsRefusedError extends Error {
  override name = "KindsRefusedError";
  readonly fault: KindsFault;
  /** The steps, outcomes or codes at fault, as labels (step ids, matcher outcomes, an error code), or empty. */
  readonly ids: readonly string[];

  constructor(fault: KindsFault, ids: readonly string[] = []) {
    super(
      ids.length === 0
        ? `the kinds of work refused the part (${fault}); nothing was written`
        : `the kinds of work refused the part (${fault}: ${ids.join(", ")}); nothing was written`,
    );
    this.fault = fault;
    this.ids = [...ids];
  }
}

/**
 * What the kinds writers do not write yet, each answered notBuilt with nothing written:
 *   - which: a part two kinds fit, which needs the owner's "which?" first (arch 05 line 237), a question not built here;
 *   - pagingNotWired: the review item's plan (writers.ts newWorkReviewPlan, the later checklist card's) with no paging
 *     port handed in, or one with no reader (T-319's PagingReader is the runtime's, T-1444), so the service never falls
 *     back to its default reader; S1-03's walk-time writer opens no review item and never answers it;
 *   - stopNotWired: a message to the owner with no stop home reads bound (DL-878's handoff 1: the owner is read with
 *     readStop and mayText rules the text before it is written).
 */
export type KindsSeam = "which" | "pagingNotWired" | "stopNotWired";

/** Something the kinds of work would have to write is not built yet: the base answers notBuilt and rolls back. */
export class KindsNotBuiltError extends NotBuiltError {
  override name = "KindsNotBuiltError";
  readonly seam: KindsSeam;
  /** The steps it is about, as labels, or empty. */
  readonly ids: readonly string[];

  constructor(call: CallName, seam: KindsSeam, ids: readonly string[] = []) {
    super(call);
    this.message =
      ids.length === 0
        ? `${call}: the kinds of work do not write ${seam} yet; nothing was written`
        : `${call}: the kinds of work do not write ${seam} yet (${ids.join(", ")}); nothing was written`;
    this.seam = seam;
    this.ids = [...ids];
  }
}
