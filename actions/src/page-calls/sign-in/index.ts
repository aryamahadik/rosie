// The sign-in page calls' server side (C-193; ADR-016 cards B1 and B2). B1 (T-1282): signInStart, the same answer with
// or without an account, given before the code's send. B2 (T-1285): signInCheck, every answer to a code that is not right
// the same with or without an account, the session's token in the first signedIn alone; and signOut. The composition
// root (runtime/src/wiring, T-1289) builds signInStart's handler with createSignInHandlers over K-05 v1.13's send side
// (db/repo, the runtime side's client), the hashing port over PROOF_CODE_HASH_KEY and a `later` that runs the send once
// the answer has gone; and signInCheck's and signOut's with createSignInCheckHandlers over K-05 v1.13's check side (the
// Tool API's client: proveSignIn, endSession), its calls after the check (the runtime side's client: personStanding,
// signInEntries), the same hashing port and a `later` for the entries. It puts all three in GatewayDeps.pages.
export {
  SECOND_PROOF_WAYS,
  SESSION_ID_PREFIX,
  SIGN_IN_CHECK_CALL,
  createSignInCheckHandlers,
  signInCheck,
  signInCheckHandler,
  type SignInCheckHandlers,
} from "./check";
export { SignInError, type SignInErrorCode } from "./errors";
export {
  ATTEMPT_ID_PREFIX,
  ATTEMPT_SERVER_ID_PREFIX,
  CONTACT_HASH_PREFIX,
  ID_RANDOM_BYTES,
  contactHashOf,
  deviceSha256Of,
  drawStartIds,
  requestSha256Of,
  type StartIds,
} from "./hashes";
export {
  contactOf,
  emailOf,
  mobileOf,
  signInCheckProblems,
  signInStartProblems,
  signOutProblems,
  type PageEnvelope,
  type ReadContact,
  type SignInAccount,
  type SignInCheckRequest,
  type SignInStartRequest,
  type SignOutRequest,
  type SignedInPageEnvelope,
} from "./request";
export { SIGN_OUT_CALL, signOut, signOutHandler } from "./sign-out";
export {
  SIGN_IN_START_CALL,
  createSignInHandlers,
  signInStart,
  signInStartHandler,
  type SignInHandlers,
} from "./start";
export type {
  AfterAnswer,
  CheckResult,
  EndSessionOutcome,
  EndSessionRequest,
  EntriesAfterAnswer,
  EntriesLater,
  EntriesReport,
  Later,
  PersonStandingOutcome,
  PersonStandingRequest,
  ProveSignInOutcome,
  ProveSignInRequest,
  SendReport,
  SendSignInCodeOutcome,
  SendSignInCodeRequest,
  SignInAfterCheckStore,
  SignInAlreadySignedIn,
  SignInAttemptNotFound,
  SignInCheckDeps,
  SignInCheckOutcome,
  SignInCheckPaused,
  SignInCheckStore,
  SignInEntriesOutcome,
  SignInEntriesRequest,
  SignInEntryAsk,
  SignInExpired,
  SignInHandlerDeps,
  SignInPaused,
  SignInSecondProofNeeded,
  SignInSendStore,
  SignInSignedIn,
  SignInStartDeps,
  SignInStarted,
  SignInTransient,
  SignInWrong,
  SignOutDeps,
  SignOutResult,
  SignedInPerson,
  SignedInRole,
  SignedOut,
  StartResult,
  StartSignInOutcome,
  StartSignInRequest,
} from "./types";
