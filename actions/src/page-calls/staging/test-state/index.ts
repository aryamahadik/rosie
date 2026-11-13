// The staging-only listing call, server side (T-574; C-074, C-205; K-21 v1 testRoster). The composition root
// (runtime/src/wiring, a later runtime card, as T-1186 was for the test-phone calls) builds the handler over its ports
// with createTestStateHandlers and puts it in GatewayDeps.pages on staging, beside testPhoneSend and testPhoneParts.
export {
  STAGING_ENVIRONMENT,
  createTestStateHandlers,
  testRoster,
  type TestStateCall,
  type TestStateHandlers,
} from "./handlers";
export { TestStateError, type TestStateErrorCode } from "./errors";
export { testRosterProblems, type SignedInPage, type TestRosterRequest } from "./request";
export type {
  NotTester,
  RosterBusiness,
  RosterBusinessEntry,
  RosterCustomer,
  RosterFlow,
  RosterPhone,
  RosterPhoneEntry,
  RosterRole,
  SeededBusiness,
  SeededCustomer,
  SeededOverride,
  SeededPhone,
  SeededState,
  SignInNeeded,
  StagingOnly,
  StagingRoster,
  TestRoster,
  TestStateCaller,
  TestStateDeps,
  TestStateRoster,
  TextHours,
  TextHoursOverrideState,
} from "./types";
