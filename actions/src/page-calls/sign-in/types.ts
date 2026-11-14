// The sign-in calls' server side (C-193): what each answers and what it reaches. signInStart's (T-1282; ADR-016 card B1;
// K-21 v1 signInStart), then signInCheck's and signOut's (T-1285; card B2; K-21 v1 signInCheck and signOut). The K-21
// answers are mirrored here by hand, as the test-phone calls' are, and the tests hold each to K-21 v1's schema itself.
// The K-05 calls are K-05 v1.13's own shapes (items 58 to 63), read off their exchanges in the generated module as types
// only (ADR-005; DL-350's way), so the binding (T-1289) hands db/repo's calls in as they are typed. Every port is handed
// in by the composition root: nothing here opens a database, reads a key or logs.

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

// ---- signInCheck and signOut (T-1285; ADR-016 card B2; K-05 v1.13 items 60 to 63) ---------------------------------------

/** K-05 v1.13 proveSignIn.request (item 60). */
export type ProveSignInRequest = K05.ProveSignInExchange["request"];
/**
 * K-05 v1.13 proveSignIn's answer: signedIn, secondProofNeeded, alreadySignedIn, wrong, paused or expired, each with what
 * the server alone needs (the attempt's id, the person, the session, the code's id), or attemptNotFound, constraint or
 * transient (nothing counted or written).
 */
export type ProveSignInOutcome = K05.ProveSignInExchange["outcome"];
/** K-05 v1.13 endSession.request (item 61): the session token's sha256 alone. */
export type EndSessionRequest = K05.EndSessionExchange["request"];
/** K-05 v1.13 endSession's answer: signedOut, naming the session and person it ended, or repeated; or transient. */
export type EndSessionOutcome = K05.EndSessionExchange["outcome"];
/** K-05 v1.13 personStanding.request (item 62): the person proveSignIn answered. */
export type PersonStandingRequest = K05.PersonStandingExchange["request"];
/** K-05 v1.13 personStanding's answer: the live roles but customer, team and tester; or transient. */
export type PersonStandingOutcome = K05.PersonStandingExchange["outcome"];
/** K-05 v1.13 signInEntries.request (item 63): the job id, the trace and one or two asks, each a row by its id alone. */
export type SignInEntriesRequest = K05.SignInEntriesExchange["request"];
/** K-05 v1.13 signInEntries' answer: each entry the rows called for, written now or found written; or an error. */
export type SignInEntriesOutcome = K05.SignInEntriesExchange["outcome"];
/** One ask of signInEntries: a code's proof_code.checked, or a session's session.started or session.ended. */
export type SignInEntryAsk = SignInEntriesRequest["entries"][number];

/**
 * K-05 v1.13's check side on the Tool API's client (rosie_app through HYPERDRIVE_APP: ADR-016 section 6; ADR-014):
 * db/repo/sign-in-check.ts proveSignIn and endSession (T-1284), bound by the root (T-1289). K-22 rule 5's session lock
 * binds both there.
 */
export interface SignInCheckStore {
  /** The check, in one transaction by the database's clock: the binding, the look, the attempt, the code, the session. */
  proveSignIn(request: ProveSignInRequest): Promise<ProveSignInOutcome>;
  /** The sign-out: only the token's own person's live session ends. */
  endSession(request: EndSessionRequest): Promise<EndSessionOutcome>;
}

/**
 * K-05 v1.13's calls after a check or a sign-out commits, on the runtime side's client (rosie_job through
 * HYPERDRIVE_JOB: ADR-016 section 6's "after the check commits"): db/repo/sign-in-check.ts personStanding and
 * signInEntries (T-1284), bound by the root (T-1289).
 */
export interface SignInAfterCheckStore {
  /** The answer's standing, read by the person the check's commit set, before the answer. */
  personStanding(request: PersonStandingRequest): Promise<PersonStandingOutcome>;
  /** The check's or the sign-out's entries, after the answer; a repeat writes nothing. */
  signInEntries(request: SignInEntriesRequest): Promise<SignInEntriesOutcome>;
}

/**
 * What became of a check's or a sign-out's entries, run after the answer (K-05 v1.13 item 63): counts and labels only,
 * never an id, a code or a token.
 *   - logged: K-05 answered the entries the rows called for: `written` by this call, `found` already in the log;
 *   - failed: nothing was written: K-05's notFound or transient, or a fault (a thrown error's name, when it is a label).
 */
export type EntriesReport =
  | { readonly result: "logged"; readonly written: number; readonly found: number }
  | { readonly result: "failed"; readonly error: string };

/** One check's or sign-out's entries, to run once the answer has gone; it never rejects. */
export type EntriesAfterAnswer = () => Promise<EntriesReport>;

/**
 * Runs `work` after the page entry has sent the answer, never before it and never awaited by it, as B1's Later does
 * (ADR-016 section 6: the entries come "after the check commits" and the answer). A throw here loses the entries and
 * nothing else. One function of type `(work: () => Promise<unknown>, page: PageRequest) => void` serves as both.
 */
export type EntriesLater = (work: EntriesAfterAnswer, page: PageRequest) => void;

/** What signOut reaches. */
export interface SignOutDeps {
  /** K-05 v1.13's check side (db/repo, the Tool API's client): endSession. */
  readonly check: Pick<SignInCheckStore, "endSession">;
  /** K-05 v1.13's calls after the sign-out (db/repo, the runtime side's client): signInEntries. */
  readonly afterCheck: Pick<SignInAfterCheckStore, "signInEntries">;
  readonly later: EntriesLater;
}

/** What signInCheck reaches; signOut's ports are among them, so the one set serves both handlers. */
export interface SignInCheckDeps {
  /** K-05 v1.13's check side (db/repo, the Tool API's client): proveSignIn and endSession. */
  readonly check: SignInCheckStore;
  /** K-05 v1.13's calls after the check (db/repo, the runtime side's client): personStanding and signInEntries. */
  readonly afterCheck: SignInAfterCheckStore;
  /**
   * The root's hashing port: HMAC-SHA-256 under PROOF_CODE_HASH_KEY, read by name in the root, for the typed code's keyed
   * hash (T-322's codeHashOf, the code's own prefix). Null: none bound, so every check answers 503 and nothing is counted.
   */
  readonly hash: KeyedHash | null;
  /** The random source of the session's token and id: Web Crypto's generator. Default WEB_CRYPTO_FILL (card A). */
  readonly random?: RandomFill;
  readonly later: EntriesLater;
}

// ---- K-21 v1's signInCheck and signOut answers (page-api.v1.schema.json) -------------------------------------------------

/** `signInCheck.response` SignedInRole. */
export interface SignedInRole {
  readonly role: "owner" | "admin" | "staff" | "ownBusiness";
  readonly businessId: string;
}

/** `signInCheck.response` SignedInPerson: the person's own id and standing, never a contact, a name or a hash. */
export interface SignedInPerson {
  readonly personId: string;
  readonly roles: readonly SignedInRole[];
  readonly team: boolean;
  readonly tester: boolean;
}

/** `signInCheck.response` SignedIn: the session token leaves the server here, once. */
export interface SignInSignedIn {
  readonly result: "signedIn";
  readonly sessionToken: string;
  readonly sessionExpiresAt: string;
  readonly person: SignedInPerson;
}

/** `signInCheck.response` SignInWrong: the same with or without an account. */
export interface SignInWrong {
  readonly result: "wrong";
  readonly triesLeft: number;
}

/** `signInCheck.response` SignInPaused: the same with or without an account. */
export interface SignInCheckPaused {
  readonly result: "paused";
  readonly until: string;
}

/** `signInCheck.response` SignInExpired. */
export interface SignInExpired {
  readonly result: "expired";
}

/** `signInCheck.response` SignInAlreadySignedIn: never a token. */
export interface SignInAlreadySignedIn {
  readonly result: "alreadySignedIn";
}

/** `signInCheck.response` SignInSecondProofNeeded, with K-21's ways (DL-610 note 1). */
export interface SignInSecondProofNeeded {
  readonly result: "secondProofNeeded";
  readonly ways: readonly ("emailCode" | "idReCheck")[];
}

/** `signInCheck.errors` AttemptNotFoundError: one answer for an unknown id, another device or a null. */
export interface SignInAttemptNotFound {
  readonly error: "attemptNotFound";
}

/** signInCheck's K-21 outcome. */
export type SignInCheckOutcome =
  | SignInSignedIn
  | SignInWrong
  | SignInCheckPaused
  | SignInExpired
  | SignInAlreadySignedIn
  | SignInSecondProofNeeded
  | SignInAttemptNotFound
  | SignInTransient;

/** signInCheck's answer and its entries to run after it (null when there is nothing to log). */
export interface CheckResult {
  readonly outcome: SignInCheckOutcome;
  readonly afterAnswer: EntriesAfterAnswer | null;
}

/** `signOut.response` SignedOut: repeated for an ended, expired or unknown session. */
export interface SignedOut {
  readonly result: "signedOut";
  readonly repeated: boolean;
}

/** signOut's answer and its entry to run after it (null when nothing ended). */
export interface SignOutResult {
  readonly outcome: SignedOut | SignInTransient;
  readonly afterAnswer: EntriesAfterAnswer | null;
}
