// The gold-set item store (T-470; C-139; K-10 v1): K-10 items written and read by set version, journey and flow under
// evals/gold/, invalid items refused, and a manifest per set with every file's sha256 and what the set holds for each
// section 08 measure, over the set and per journey. evals/gold/README.md says how it is laid out and used.
export {
  MEASURES,
  countItems,
  isDangerCase,
  type CountedMeasure,
  type FlowCounts,
  type MeasureCounts,
  type SetCounts,
} from "./counts";
export { jsonFileText, prettierSettings, sha256Hex } from "./json";
export { GOLD_ROOT, MANIFEST_FILE, REPO_ROOT, isSetVersion, itemPathOf } from "./layout";
export {
  MANIFEST_CONTRACT,
  buildManifest,
  type GoldManifest,
  type JourneyCounts,
  type ManifestFile,
  type SetEntry,
} from "./manifest";
export {
  GoldItemRefused,
  GoldSetError,
  goldSetVersions,
  readGoldItem,
  readGoldItems,
  readGoldManifest,
  writeGoldItems,
  type ReadOptions,
  type SetOptions,
  type WriteResult,
} from "./store";
export {
  CONTRACTS_DIR,
  GOLD_ITEM_DEF,
  K10_SCHEMA_FILE,
  checkGoldItem,
  formatErrors,
  goldItemSchemaCheck,
  goldItemSchemaFiles,
} from "./validate";
