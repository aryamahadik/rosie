// signInStart's server side (T-1282; ADR-016 card B1; C-193; K-21 v1 signInStart): what it answers and what it reaches.
// The K-21 answers are mirrored here by hand, as the test-phone calls' are, and the tests hold each to K-21 v1's schema
// itself. The two K-05 calls are K-05 v1.13's own shapes (startSignIn and sendSignInCode, items 58 and 59), read off
// their exchanges in the generated module as types only (ADR-005; DL-350's way), so the binding (T-1289) hands db/repo's
// calls in as they are typed. Every port is handed in by the composition root: nothing here opens a database, reads a
// key or logs.

import type * as K05 from "../../../../contracts/generated/data-access/data-access.v1.13";
import type { PageRequest } from "../../../../runtime/src/gateway";
import type { KeyedHash, ProofCodeIds, RandomFill } from "../../domain/proof-codes";

/** K-05 v1.13 startSignIn.request (item 58). */
export type StartSignInRequest = K05.StartSignInExchange["request"];
/** K-05 v1.13 startSignIn's answer: started or paused, or constraint or transient (nothing written). */
export type StartSignInOutcome = K05.StartSignInExchange["outcome"];
/** K-05 v1.13 sendSignInCode.request (item 59). */
export type SendSignInCodeRequest = K05.SendSignInCodeExchange["request"];
/** K-05 v1.13 sendSignInCode's answer: sent, repeated or notSent, or notFound, constraint or transient. */
export type SendSignInCodeOutcome = K05.SendSignInCodeExchange["outcome"];

/**
 * K-05 v1.13's sign-in send side, each call on the runtime side's client (rosie_job through HYPERDRIVE_JOB: ADR-016
 * section 6; ADR-014): db/repo/sign-in-send.ts startSignIn and sendSignInCode (T-1280), bound by the root (T-1289).
 */
export interface SignInSendStore {
  /** Before the answer: rules 0 to 5 under the contact's lock, in one transaction, by the database's clock. */
  startSignIn(request: StartSignInRequest): Promise<StartSignInOutcome>;
  /** After the answer: the code row, its email row (checked, with its plan and final parts) and three entries. */
  sendSignInCode(request: SendSignInCodeRequest): Promise<SendSignInCodeOutcome>;
}

/**
 * What became of the code's send, run after the answer (ADR-016 section 1): labels and row ids only, never the code, the
 * contact, a hash or an attempt's id, for the binding's dispatch of the row (ADR-016 section 2; T-1289).
 *   - sent: the code row and its email row were written now; repeated: the attempt already named a code, nothing was
 *     written (the first send's row is named);
 *   - notSent: K-05 wrote and sent nothing, and says why;
 *   - failed: nothing was written: K-05's notFound, constraint or transient, or a fault (a thrown error's name, when it
 *     is a label).
 */
export type SendReport =
  | { readonly result: "sent" | "repeated"; readonly outboxRowId: string; readonly proofCodeId: string }
  | { readonly result: "notSent"; readonly why: K05.SendSignInCodeNotSent["why"] }
  | { readonly result: "failed"; readonly error: string };

/** The send of one start's code, to run once the answer has gone; it never rejects. */
export type AfterAnswer = () => Promise<SendReport>;

/**
 * Runs `work` after the page entry has sent the answer (ADR-016 section 2: in the request's waitUntil, after the answer
 * has gone), never before the answer and never awaited by it. The page is the call's own, so the binding can reach the
 * request's waitUntil from it. A throw here loses the code and nothing else: the answer is already made.
 */
export type Later = (work: AfterAnswer, page: PageRequest) => void;

/** What signInStart reaches. */
export interface SignInStartDeps {
  /** K-05 v1.13's send side (db/repo, the runtime side's client). */
  readonly store: SignInSendStore;
  /**
   * The root's hashing port: HMAC-SHA-256 under PROOF_CODE_HASH_KEY, read by name in the root (ADR-016 section 4, "The
   * key"; T-322's hmacSha256Hash). Null: none bound, so every start answers 503 and nothing is written.
   */
  readonly hash: KeyedHash | null;
  /** The random source of the ids and the code: Web Crypto's generator. Default WEB_CRYPTO_FILL (DL-546 note d). */
  readonly random?: RandomFill;
  /** The ids of the code's rows, from the attempt's server id (CQ-09). Default T-322's KEYED_CODE_IDS. */
  readonly codeIds?: ProofCodeIds;
}

/** What the page-entry handler reaches: signInStart's ports and the one that runs the send after the answer. */
export interface SignInHandlerDeps extends SignInStartDeps {
  readonly later: Later;
}

// ---- K-21 v1's answers (page-api.v1.schema.json) -------------------------------------------------------------------
// The handler hands the page entry a plain copy of one of these, its PageOutcome (runtime/src/gateway/pages/types.ts).

/** `signInStart.response`, way email: the same whether or not an account matches; the code never comes back. */
export interface SignInStarted {
  readonly result: "started";
  readonly attemptId: string;
  readonly way: "email";
  readonly expiresAt: string;
  readonly readyText: null;
  readonly textLink: null;
}

/** `signInStart.errors` SignInPausedError: counted per contact typed, so it answers alike with or without an account. */
export interface SignInPaused {
  readonly error: "paused";
  readonly until: string;
}

/** `signInStart.errors` transientError (K-05 v1): nothing was written; the same request may be sent again. */
export interface SignInTransient {
  readonly error: "transient";
  readonly sqlstate: string;
}

/** signInStart's answer and the send to run after it (null when nothing is to be sent). */
export interface StartResult {
  readonly outcome: SignInStarted | SignInPaused | SignInTransient;
  readonly afterAnswer: AfterAnswer | null;
}
