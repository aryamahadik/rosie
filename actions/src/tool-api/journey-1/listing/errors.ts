// What journey 1's listing folder throws (T-635a; K-09 README defaults 201 to 206). Each message names a read, a step, a
// fault, a seam or a label: never the business's name, a town, an address, a phone, the owner's words, an id, a K-05 or
// K-15 answer or the turn's chat id (K-15 README "No name, address, phone or words in a span or log"; K-08 v1 README line
// 75; DL-935). A throw inside a settler or a step writer fails the call closed with nothing written (the walk:
// actions/src/commit/walk/settle.ts and writes.ts; the Tool API base rolls the call's transaction back).

import type { NotFoundError, TransientError } from "../../../../../db/repo/targets";
import type { UnknownFactError } from "../../../../../db/repo/turn-state";
import type { CallName } from "../../calls";
import { NotBuiltError } from "../../errors";

/** The K-05 reads this folder makes: item 79 (the turn's company) and item 26 (the business head, the setup row). */
export type ListingReadName = "readPickedKinds" | "readTurnState";

/**
 * Why a K-05 read failed the call closed:
 *   - transient: K-05's transient answer (a serialization failure, a deadlock or a lost connection);
 *   - notFound: the read found no row of the request's handle, person or business (a missing business_setup row is no
 *     fault: it is read as "none on file");
 *   - unknownFact: readTurnState knows no home for a fact asked (a binding that reads another table);
 *   - notWellFormed: an answer that does not have the shape the read promises (an answer for another business or
 *     person, a fact asked once and answered twice or never, a version that is not a whole number of 1 or more).
 */
export type ListingReadFault = "transient" | "notFound" | "unknownFact" | "notWellFormed";

/**
 * A K-05 read failed the call closed, never read as none. `answer` is K-05's error answer as the read gave it, or null
 * when the answer came back but cannot be read (notWellFormed). The message names the read and the fault alone.
 */
export class ListingReadError extends Error {
  override name = "ListingReadError";
  readonly read: ListingReadName;
  readonly fault: ListingReadFault;
  readonly answer: TransientError | NotFoundError | UnknownFactError | null;

  constructor(
    read: ListingReadName,
    fault: ListingReadFault,
    answer: TransientError | NotFoundError | UnknownFactError | null,
  ) {
    super(`${read} answered ${fault}: the call fails closed and nothing is written`);
    this.read = read;
    this.fault = fault;
    this.answer = answer;
  }
}

/**
 * Why S1-09's settler, S1-09's writer or S1-76's writer refused (refused, never guessed):
 *   - wrongStep: a settler or writer was called for another step than its own (the binding's fault);
 *   - listingNeedsDetails: S1-09's reading answered "ask" (no details, or a name with no town: default 201 (i) and
 *     (ii)), which T-1502's settler port cannot carry until T-1528 lets the walk take a split settler's "ask" (default
 *     201, "ask" until T-1528; open gap 179), so the call fails closed with nothing written and the question stays open;
 *   - placesUnavailable: a Places search failed on a try (K-15 unavailable, rateLimited or badRequest, or the port
 *     threw: default 201 (iii); K-09 v1 lookupListing.errors), so nothing is known about the listing and nothing is
 *     written; never "No match, or already listed", which would claim a check that did not run;
 *   - notSettled: a writer found no S1-09 reading held for this walk and part, or one that answered "ask" (a binding
 *     that hands the writers without the settler: defaults 201, 204 and 205);
 *   - branchNotSettled: the branch the walk hands a writer is not the one S1-09's reading settled (S1-09's writer), or
 *     is not "No match, or already listed" (S1-76's writer): a second lock, which fires only on a fault;
 *   - noPerson: the turn names no person (K-09 caller.personId null);
 *   - noCompany: the caller's person owns no company the turn runs under, whose business is the call's business
 *     (default 204, "Whose rows"; default 182);
 *   - reviewRefused: openReviewItem answered one of its errors for S1-76's review item (its subject not found, say);
 *   - reviewWrites: openReviewItem's writes held a row S1-76's writer does not hand on (a question, a close, a clock row
 *     or a message).
 */
export type ListingFault =
  | "wrongStep"
  | "listingNeedsDetails"
  | "placesUnavailable"
  | "notSettled"
  | "branchNotSettled"
  | "noPerson"
  | "noCompany"
  | "reviewRefused"
  | "reviewWrites";

/** A listing settler or writer refused: the whole call is refused and nothing is written. */
export class ListingRefusedError extends Error {
  override name = "ListingRefusedError";
  readonly fault: ListingFault;
  /** The steps, labels or codes at fault (step ids, a reason label, an error code), or empty. */
  readonly ids: readonly string[];

  constructor(fault: ListingFault, ids: readonly string[] = []) {
    super(
      ids.length === 0
        ? `the listing refused the part (${fault}); nothing was written`
        : `the listing refused the part (${fault}: ${ids.join(", ")}); nothing was written`,
    );
    this.fault = fault;
    this.ids = [...ids];
  }
}

/**
 * What the listing writers cannot write with a port left out, each answered notBuilt with nothing written:
 *   - stopNotWired: a message to the owner (S1-09's read-back, S1-76's message) with no stop home reads bound (default
 *     189: the owner is read with readStop and mayText rules the text before it is written);
 *   - pagingNotWired: S1-76's review item with no paging port, or one with no reader (T-319's PagingReader is the
 *     runtime's), so the service never falls back to its default reader.
 */
export type ListingSeam = "stopNotWired" | "pagingNotWired";

/** Something a listing writer would have to write has no port bound: the base answers notBuilt and rolls back. */
export class ListingNotBuiltError extends NotBuiltError {
  override name = "ListingNotBuiltError";
  readonly seam: ListingSeam;
  /** The steps it is about, as labels, or empty. */
  readonly ids: readonly string[];

  constructor(call: CallName, seam: ListingSeam, ids: readonly string[] = []) {
    super(call);
    this.message =
      ids.length === 0
        ? `${call}: the listing does not write ${seam} yet; nothing was written`
        : `${call}: the listing does not write ${seam} yet (${ids.join(", ")}); nothing was written`;
    this.seam = seam;
    this.ids = [...ids];
  }
}
