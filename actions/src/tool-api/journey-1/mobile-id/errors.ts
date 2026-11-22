// What journey 1's mobile-id folder throws (T-1533; K-09 README defaults 210 and 211). Each message names a read, a step,
// a fault or a seam: never a number, a code, a link, the owner's words, an id, a K-05 answer or the turn's chat id (BP
// rule 7; K-21 "Never in a span or a log"; K-08 v1 README line 75). A throw inside a step writer fails the call closed
// with nothing written (the walk: actions/src/commit/walk/writes.ts; the Tool API base rolls the call's transaction back).

import type { NotFoundError, TransientError } from "../../../../../db/repo/targets";
import type { UnknownFactError } from "../../../../../db/repo/turn-state";
import type { CallName } from "../../calls";
import { NotBuiltError } from "../../errors";

/** The K-05 reads this folder makes: item 79 (the turn's company) and item 26 (the turn's handle, the caller's account). */
export type MobileIdReadName = "readPickedKinds" | "readTurnState";

/**
 * Why a K-05 read failed the call closed:
 *   - transient: K-05's transient answer (a serialization failure, a deadlock or a lost connection);
 *   - notFound: the read found no row of the request's handle or business (a missing accounts row of the caller's own
 *     person is no fault: it is read as "none on file");
 *   - unknownFact: readTurnState knows no home for a fact asked;
 *   - notWellFormed: an answer that does not have the shape the read promises (another handle's, business's or person's
 *     answer, a fact asked once and answered twice or never, a version that is not a whole number of 1 or more, a mobile
 *     or a time that is not text).
 */
export type MobileIdReadFault = "transient" | "notFound" | "unknownFact" | "notWellFormed";

/**
 * A K-05 read failed the call closed, never read as none. `answer` is K-05's error answer as the read gave it, or null
 * when the answer came back but cannot be read (notWellFormed). The message names the read and the fault alone.
 */
export class MobileIdReadError extends Error {
  override name = "MobileIdReadError";
  readonly read: MobileIdReadName;
  readonly fault: MobileIdReadFault;
  readonly answer: TransientError | NotFoundError | UnknownFactError | null;

  constructor(
    read: MobileIdReadName,
    fault: MobileIdReadFault,
    answer: TransientError | NotFoundError | UnknownFactError | null,
  ) {
    super(`${read} answered ${fault}: the call fails closed and nothing is written`);
    this.read = read;
    this.fault = fault;
    this.answer = answer;
  }
}

/**
 * Why S1-10's writer refused (refused, never guessed; README default 210):
 *   - wrongStep: the writer was called for another step than S1-10 (the binding's fault);
 *   - claimUnknown: no S1-09 reading is held for this walk and part (a walk in which S1-09's settler did not run), or
 *     the one held answered "ask", so the claim is not known (open gap 200);
 *   - noPerson: the turn names no person (K-09 caller.personId null), or the turn's handle is not that person's own
 *     (K-04 person_handles, which K-22 v1.1's page_links_sent_to_fk also requires);
 *   - noCompany: the caller's person owns no company the turn runs under, whose business is the call's business (as
 *     default 204 holds S1-09's writer);
 *   - noNumberInChat: the turn's chat does not carry the number: an email turn, or a chat on an email handle (D1; line
 *     185; open gap 199);
 *   - noPhoneRow: the turn's phone handle has no K-04 phones row on file, which accounts.mobile refers to (open gap 201);
 *   - mobileOnFile: the caller's accounts row holds another mobile: a number change needs a signed-in session and a new
 *     ID check (line 181; S11-52).
 */
export type MobileIdFault =
  "wrongStep" | "claimUnknown" | "noPerson" | "noCompany" | "noNumberInChat" | "noPhoneRow" | "mobileOnFile";

/** S1-10's writer refused: the whole call is refused and nothing is written. */
export class MobileIdRefusedError extends Error {
  override name = "MobileIdRefusedError";
  readonly fault: MobileIdFault;
  /** The steps at fault, as labels (step ids), or empty. */
  readonly ids: readonly string[];

  constructor(fault: MobileIdFault, ids: readonly string[] = []) {
    super(
      ids.length === 0
        ? `S1-10's writer refused the part (${fault}); nothing was written`
        : `S1-10's writer refused the part (${fault}: ${ids.join(", ")}); nothing was written`,
    );
    this.fault = fault;
    this.ids = [...ids];
  }
}

/**
 * What S1-10's writer cannot write with a port left out, each answered notBuilt with nothing written:
 *   - stopNotWired: the owner's ID text with no stop home reads bound (default 189: mayText rules the text before it is
 *     written);
 *   - linkNotWired: the owner's ID text with no secure link port bound, or one whose host or base path is not a link's
 *     (default 211: the link host, the base path, the stage the code waits in for the face's hold, and the clock).
 */
export type MobileIdSeam = "stopNotWired" | "linkNotWired";

/** Something S1-10's writer would have to write has no port bound: the base answers notBuilt and rolls back. */
export class MobileIdNotBuiltError extends NotBuiltError {
  override name = "MobileIdNotBuiltError";
  readonly seam: MobileIdSeam;
  /** The steps it is about, as labels, or empty. */
  readonly ids: readonly string[];

  constructor(call: CallName, seam: MobileIdSeam, ids: readonly string[] = []) {
    super(call);
    this.message =
      ids.length === 0
        ? `${call}: S1-10's writer does not write ${seam} yet; nothing was written`
        : `${call}: S1-10's writer does not write ${seam} yet (${ids.join(", ")}); nothing was written`;
    this.seam = seam;
    this.ids = [...ids];
  }
}
