// The test-phone page's server calls, staging only (T-565; C-074, C-205; K-21 v1 testPhoneSend and testPhoneParts).
// The composition root (runtime/src/wiring, T-1186) builds the handlers over its ports with createTestPhoneHandlers and
// puts them in GatewayDeps.pages; staging's Linq send path goes through createPartsRecorder in front of the Linq double
// whose record testPhoneParts reads.
export {
  STAGING_ENVIRONMENT,
  TEST_PHONE_WEBHOOK_URL,
  createTestPhoneHandlers,
  testPhoneParts,
  testPhoneSend,
  type TestPhoneCall,
  type TestPhoneHandlers,
} from "./handlers";
export { TestPhoneError, type TestPhoneErrorCode } from "./errors";
export { defaultSendIds, sha256Hex } from "./ids";
export {
  PartsRecorder,
  createPartsRecorder,
  type PartsRecorderOptions,
  type RecordedLinqDouble,
} from "./parts";
export {
  testPhonePartsProblems,
  testPhoneSendProblems,
  type SignedInPage,
  type TestPhonePartsRequest,
  type TestPhoneSendRequest,
} from "./request";
export type {
  ChatLink,
  LinqWebhookEntry,
  NotTestPhone,
  NotTester,
  PartsRecord,
  PhoneState,
  PhoneStates,
  RecordedEmail,
  RecordedPart,
  RosterPhone,
  SendIdInput,
  SendIdMaker,
  SendIds,
  SignInNeeded,
  StagingOnly,
  TestPhoneDeps,
  TestPhoneParts,
  TestPhoneRoster,
  TestPhoneSent,
  TestPhoneState,
  TesterAccess,
  TesterStanding,
} from "./types";
