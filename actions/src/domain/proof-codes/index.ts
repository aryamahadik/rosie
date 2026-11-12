// The proof-code service (T-322; C-095; RULES 6.1, 6.2; S13-45; S11-52; MC C9): K-09 v1's sendProofCode and proveCode,
// made alone, with the code's draw, its keyed hash through the root's port, its words, a 10-minute life and a 15-minute
// pause after 5 wrong tries; and a session's 32-byte token for the sign-in calls (ADR-016 card A; DL-526). A Tool API
// handler set takes sendProofCodeHandler(deps) and proveCodeHandler(deps); the sign-in calls (ADR-016 cards B1, B2) build
// their code's send with buildCodeSend and check a typed code's hash with codeHashOf.

export { answerOfCheck, proveCode, ProofCodeStoreError, type CheckAnswer, type CheckDeps } from "./check";
export {
  CODE_DIGITS,
  CODE_SPACE,
  CodeDrawError,
  DRAW_LIMIT,
  MAX_DRAWS,
  SESSION_TOKEN_BYTES,
  WEB_CRYPTO_FILL,
  drawCode,
  newSessionToken,
  sha256Hex,
  type RandomFill,
  type SessionToken,
} from "./draw";
export { proveCodeHandler, sendProofCodeHandler, type ProofCodeDeps } from "./handlers";
export {
  HASH_FORM,
  MIN_KEY_BYTES,
  PROOF_CODE_HASH_PREFIX,
  ProofCodeHashError,
  codeAsHashed,
  codeHashOf,
  hmacSha256Hash,
  isKeyName,
  type KeyedHash,
} from "./hashing";
export {
  KEYED_CODE_IDS,
  notBuiltStore,
  type CheckAsk,
  type CheckOutcome,
  type CheckResult,
  type CodeEmail,
  type CodeEmailRow,
  type CodeLimits,
  type CodeRow,
  type CodeSend,
  type LimitsAsk,
  type ProofCodeIds,
  type ProofCodeStore,
  type SendCommitAnswer,
  type SentCode,
  type TransientRefusal,
} from "./ports";
export {
  CODES_PER_CONTACT_PER_DAY,
  CODE_LIFE_MINUTES,
  DAY_HOURS,
  PAUSE_MINUTES,
  STORED_PURPOSE,
  WRONG_TRIES_TO_PAUSE,
  channelOf,
  expiresAtOf,
  pauseEndOf,
  standingAt,
  triesLeftAfter,
  type CodeChannel,
  type CodeState,
  type Purpose,
  type Route,
  type Standing,
  type StoredPurpose,
} from "./rules";
export {
  buildCodeSend,
  sendProofCode,
  type BuiltSend,
  type CodeSendInput,
  type CodeSendTools,
  type OnFileRoute,
  type SendAnswer,
  type SendDeps,
} from "./send";
export {
  codeFinalParts,
  codeRowPlan,
  wordsFor,
  type CodeFinalParts,
  type CodeRowPlan,
  type CodeWords,
  type CodeWordsSend,
} from "./words";
