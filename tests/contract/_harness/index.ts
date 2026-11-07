// The shared harness (T-003; C-028). A contract test imports from "./_harness":
//
//   import { describeContractFixtures } from "./_harness";
//   describeContractFixtures("<name>");
//
// tests/README.md and tests/QUARANTINE.md state the rest of the rules.

export {
  CONTRACTS_ROOT,
  REPO_ROOT,
  checkContractFixtures,
  contractDir,
  describeContractFixtures,
  formatErrors,
  type EntryResult,
  type Expectation,
  type FixtureEntry,
  type FixtureOptions,
  type FixtureReport,
} from "./fixtures";
export {
  DoubleLoadError,
  createDoubleLoader,
  type DoubleLoader,
  type DoubleLoaderOptions,
  type DoubleModule,
  type DoubleSpec,
} from "./doubles";
export { DOUBLE_SPECS, doubles, loadDouble } from "./registry";
