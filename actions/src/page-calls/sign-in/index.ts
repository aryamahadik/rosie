// The sign-in page calls' server side (C-193; ADR-016 cards B1 and B2). B1 (T-1282): signInStart, the same answer with
// or without an account, given before the code's send. The composition root (runtime/src/wiring, T-1289) builds the
// handler with createSignInHandlers over K-05 v1.13's send side (db/repo, the runtime side's client), the hashing port
// over PROOF_CODE_HASH_KEY and a `later` that runs the send once the answer has gone, and puts it in GatewayDeps.pages.
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
  signInStartProblems,
  type PageEnvelope,
  type ReadContact,
  type SignInAccount,
  type SignInStartRequest,
} from "./request";
export {
  SIGN_IN_START_CALL,
  createSignInHandlers,
  signInStart,
  signInStartHandler,
  type SignInHandlers,
} from "./start";
export type {
  AfterAnswer,
  Later,
  SendReport,
  SendSignInCodeOutcome,
  SendSignInCodeRequest,
  SignInHandlerDeps,
  SignInPaused,
  SignInSendStore,
  SignInStartDeps,
  SignInStarted,
  SignInTransient,
  StartResult,
  StartSignInOutcome,
  StartSignInRequest,
} from "./types";
