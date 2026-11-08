// Bundle ids and the manifest's input hashes (T-150; C-072; CQ-09; K-01 v1 manifest.bundleId and manifest.inputs):
// a bundle's id is the content hash of its compiled values plus a build number, and its manifest lists every input K-01
// names with its sha256 (compiler/src/bundle-id). `compiler build --build <n>` writes such a bundle.
export {
  BundleIdError,
  bundleIdProblems,
  contentHash,
  contentHashOfFiles,
  isBuildNumber,
  keyPrefix,
  parseBuildNumber,
  sha256Hex,
  storedDigestsOfFiles,
  storedDigestsOfManifest,
  type StoredDigest,
} from "./content-hash";
export {
  FIXTURE_SET_MANIFEST,
  INPUT_KINDS,
  InputHashError,
  LINES_PATH,
  MASTER_CORRECTIONS,
  MASTER_DIR,
  MASTER_FLOW_PATHS,
  REFERENCE_CODE_PATHS,
  REPO_ROOT,
  SHA256SUMS,
  bundleInputs,
  readSha256Sums,
  tradePath,
  type ApprovedOverlay,
  type InputOptions,
} from "./inputs";
export {
  PROVISIONAL_BUNDLE_ID,
  buildNumberedBundle,
  numberBundle,
  withBundleId,
  type NumberedBuildOptions,
  type NumberedBundle,
} from "./numbered";
