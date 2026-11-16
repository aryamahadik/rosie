// Staging's wiring over its database (T-1154's parts; ops/reviews/D-017-path-audit/order_d017.txt lines 29 to 49): the
// Worker's database handle and its guard in every call (./db.ts, T-1254), which the later parts' calls run on;
// stagingOptions(env), the RootOptions inputs staging gives (./options.ts, T-1257), which the Worker's root spreads into
// its options; each later part's own file with its final signature (./flags.ts to ./copies.ts), what each is handed
// (./part.ts) and the SEALING_WRAP_KEY-only resolver (./secrets.ts); the email rows' port (./email.ts, T-1288); and the
// sign-in calls' inputs with the hashing port over PROOF_CODE_HASH_KEY (./sign-in.ts, T-1289).
//
// This index holds ./db.ts's values, so it loads only in the Workers runtime (cloudflare:sockets): ../root.ts and
// ../index.ts import ./options.ts and the files they need by name, never this index, since their graph loads under Node
// too (./part.ts says why).

export {
  CONNECT_TIMEOUT_SECONDS,
  CONNECTIONS_PER_CLIENT,
  DB_SIDES,
  DbClosedError,
  DbGuardRefusal,
  dbHandle,
  END_TIMEOUT_SECONDS,
  failedChecks,
  guardChecks,
  guardSelect,
  QuietSocket,
  quietTally,
  type DbBindingName,
  type DbCallTiming,
  type DbClosedReason,
  type DbEnv,
  type DbHandle,
  type DbHandleCounts,
  type DbHandleOptions,
  type DbRefusalLine,
  type DbSide,
  type DbStepTime,
  type OpenRawSocket,
  type QuietSocketTarget,
  type QuietTally,
  type RawSocket,
} from "./db";
export { stagingBundleSafety, type BundleSafetyPart } from "./bundle-safety";
export { stagingCopies, type CopiesPart } from "./copies";
export {
  emailMissingLine,
  stagingEmail,
  stagingEmailRouter,
  type EmailMissingLine,
  type EmailMissingName,
  type EmailPart,
  type EmailSeams,
} from "./email";
export { stagingFlags, type FlagsPart } from "./flags";
export { NO_RECEIPT_INPUTS, stagingReceiptCalls, type ReceiptInputs, type ReceiptPart } from "./k05-receipt";
export { NO_TURN_CALL_INPUTS, stagingTurnCalls, type TurnCallInputs, type TurnCallsPart } from "./k05-turn";
export { NO_MODEL_READER_INPUTS, stagingModels, type ModelReaderInputs, type ModelsPart } from "./models";
export {
  NO_STAGING_INPUTS,
  STAGING_BUILDERS,
  stagingOptions,
  stagingRosieNumber,
  type StagingBuilders,
  type StagingInputName,
  type StagingInputs,
  type StagingSeams,
} from "./options";
export {
  dbCallLine,
  stagingDb,
  type DbCallLine,
  type StagingDb,
  type StagingDbOptions,
  type StagingEnv,
  type StagingPart,
} from "./part";
export { sealingWrapKeys, WrappingKeyNameError, type WrappingKeyEnv } from "./secrets";
export { NO_SEND_INPUTS, stagingSendCalls, type SendInputs, type SendPart } from "./send";
export {
  PROOF_CODE_HASH_KEY,
  proofCodeHashOf,
  SIGN_IN_CALLS,
  signInKeyLine,
  stagingSignIn,
  type SignInKeyLine,
  type SignInKeyWhy,
  type SignInPart,
  type SignInSeams,
} from "./sign-in";
export {
  NO_DIRECTORY_INPUTS,
  stagingDirectories,
  type DirectoryInputs,
  type DirectoryPart,
} from "./state-reads";
export { stagingTestPhone, type TestPhonePart } from "./test-phone";
export { stagingGateReads, type GatePart } from "./tool-api-gate";
export { NO_ROW_INPUTS, stagingRowCalls, type RowCallsPart, type RowInputs } from "./tool-api-rows";
