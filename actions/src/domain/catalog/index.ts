// The catalog and pricing service base (T-320; C-096; arch 09 lines 457, 478, 488; RULES 3.7): a business's kinds of
// work, services with their price kinds, ways and price rules, where a price change closes one row and opens the next and
// a booking keeps the price it was made with, and terms snapshots taken once and never changed. Its reads are a port the
// caller hands in by name (reads.ts; DL-888): with none bound every call answers notBuilt. Its cross-row checks (T-1433)
// are made through them before any write. See service.ts, checks.ts, rows.ts, prices.ts, terms.ts and registry.ts.

export {
  checkBusinessMoney,
  checkCompany,
  checkDeposit,
  checkDepositsUnder,
  checkListPriced,
  checkLocation,
  checkSpace,
  checkWorker,
  rulesPricing,
} from "./checks";
export { CatalogRefusedError, isCatalogRefusal, notBuiltFor, type CatalogRefusal } from "./errors";
export {
  canBothApply,
  conditionCount,
  conditionsKey,
  inEffectAt,
  isEmpty,
  isPossibleTie,
  overlaps,
  rangeOf,
  sameConditions,
  type Range,
} from "./prices";
export type { CatalogReads } from "./reads";
export {
  PLUGIN_SWITCHES,
  TRADE_FACTS,
  isPluginSwitch,
  isTradeFact,
  type PluginSwitch,
  type TradeFact,
} from "./registry";
export { PATHS, checkCatalogWrite, checkWayMoney, takesNoMoney } from "./rows";
export {
  createCatalog,
  withCatalog,
  type AddPriceInput,
  type AddServiceInput,
  type AddWayInput,
  type AnswerTieInput,
  type Catalog,
  type CatalogDeps,
  type ChangePriceInput,
  type ClosePriceInput,
  type PlaceKindInput,
  type SpaceLinkInput,
  type UpdateKindInput,
  type UpdateServiceInput,
  type UpdateWayInput,
  type WithdrawPriceInput,
} from "./service";
export { deepFreeze, inForce, snapshotOf, type SnapshotInput } from "./terms";
export {
  NO_CONDITIONS,
  PLACES,
  PRICE_KINDS,
  type Built,
  type BusinessKind,
  type BusinessSetup,
  type CatalogWrites,
  type Flow,
  type FlowDefault,
  type KindFlowRow,
  type KindsRead,
  type LocationKind,
  type LocationRow,
  type Place,
  type PlaceOrThingRow,
  type PriceChange,
  type PriceConditions,
  type PriceKind,
  type PriceRuleRow,
  type PriceRulesRead,
  type PriceTieRow,
  type ResourceRow,
  type ScopedRow,
  type ServiceRow,
  type TermsSnapshot,
  type TermsSources,
  type WayRow,
} from "./types";
