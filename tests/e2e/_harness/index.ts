// The end-to-end harness (T-003; C-028). End-to-end tests (project `e2e`) load their test doubles by port name
// with the same loader the contract tests use.

export {
  DoubleLoadError,
  DOUBLE_SPECS,
  createDoubleLoader,
  doubles,
  loadDouble,
  type DoubleLoader,
  type DoubleModule,
  type DoubleSpec,
} from "../../contract/_harness";
