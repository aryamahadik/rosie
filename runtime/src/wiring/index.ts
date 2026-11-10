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
export {
  PORTS,
  type DataAccess,
  type FinalizePort,
  type LinqSend,
  type PortName,
  type Ports,
  type StateReads,
  type TurnFacePort,
} from "./ports";
export {
  LINQ_WEBHOOK_SECRET,
  MissingSecretError,
  NoDatabaseError,
  NoSafetyReaderError,
  realPorts,
  realSafetyRead,
  realSealing,
  SEALING_WRAP_KEY,
  SealingKeyError,
  type HandleSealingKeyCall,
  type KeyObjectStore,
  type LinqVerifyInputs,
  type RealInputs,
  type SafetyReaders,
  type SafetyReadInputs,
  type SealingInputs,
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
