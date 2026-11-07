// The scenario harness (T-003; C-028). Scenario tests (project `scenario`) load their test doubles by port name
// with the same loader the contract tests use; the scenario inputs themselves come from fixture set v1 (T-007).

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
