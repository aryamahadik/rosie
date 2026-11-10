// The composition root (T-550): see root.ts. The fakes the test environment binds are ./test-support.ts, which the Worker
// never imports.

export { bindPorts, WiringError, type Binding, type BoundPorts, type ImplementationSets } from "./bind";
export { closedPorts, NotJoinedError } from "./closed";
export {
  ENVIRONMENTS,
  environmentOf,
  PICKS,
  type Environment,
  type ImplementationName,
  type PortPick,
} from "./picks";
export { PinnedRuns } from "./pinned-runs";
export {
  PORTS,
  type DataAccess,
  type FinalizePort,
  type FrontierPort,
  type LinqSend,
  type PortName,
  type Ports,
  type StateReads,
  type TurnFacePort,
  type TurnRowPort,
} from "./ports";
export {
  DeciderBundleError,
  LINQ_WEBHOOK_SECRET,
  MissingSecretError,
  NoDatabaseError,
  NoDeciderError,
  NoSafetyReaderError,
  realBundles,
  realDecide,
  realFrontier,
  realPorts,
  realSafetyRead,
  realSealing,
  realTargets,
  realTurnRow,
  SEALING_WRAP_KEY,
  SealingKeyError,
  TurnIdError,
  type BundleReadCalls,
  type CommitTurnCall,
  type DecideInputs,
  type Deciders,
  type FrontierInputs,
  type FrontierScope,
  type HandleSealingKeyCall,
  type HandleTargetsCall,
  type KeyObjectStore,
  type LinqVerifyInputs,
  type ParkTurnCall,
  type ReadActiveBundleCall,
  type ReadBundleValueCall,
  type RealInputs,
  type SafetyReaders,
  type SafetyReadInputs,
  type SealingInputs,
  type TurnRowCalls,
} from "./real";
export {
  composeRoot,
  unwireWorker,
  WORKER_CLOCK,
  wiredRoot,
  wireWorker,
  workerRoot,
  type HandleActors,
  type Root,
  type RootClock,
  type RootOptions,
  type WorkerSecrets,
} from "./root";
export { ROW_MEMORY, RowTraces } from "./row-traces";
export { SKELETON_FLAG, skeletonLinqRoute, type ReleaseFlags, type SkeletonRouteDeps } from "./skeleton";
export {
  NoTestPhoneLineError,
  TEST_PHONE_LINE_NAME,
  lineLinqSend,
  testPhoneLineOf,
  testPhonePages,
  type TestPhoneInputs,
  type TestPhoneLine,
  type TestPhoneLineNamespace,
  type TestPhoneLinePort,
  type TestPhonePageDeps,
} from "./test-phone";
