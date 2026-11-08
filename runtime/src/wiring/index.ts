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
  composeRoot,
  WORKER_CLOCK,
  workerRoot,
  type HandleActors,
  type Root,
  type RootClock,
  type RootOptions,
} from "./root";
export { ROW_MEMORY, RowTraces } from "./row-traces";
