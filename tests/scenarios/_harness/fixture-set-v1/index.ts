// Fixture set v1 as typed scenario inputs (T-007). Scenario tests import from here:
//   import { loadFixtureSetV1 } from "../_harness/fixture-set-v1";

export { loadFixtureSetV1, verifyFixtureSet, type LoadOptions } from "./loader";
export { FIXTURES_V1_ROOT, FixtureSetError } from "./reader";
export type {
  Coverage,
  CrossCuttingScenario,
  DemoFlow,
  DemoService,
  DemoShop,
  DemoShopRecord,
  FixtureSetV1,
  FlowId,
  KnownGap,
  MoneyComboScenario,
  Scenario,
  ScenarioLine,
  ShopKind,
  StaleNote,
} from "./types";
