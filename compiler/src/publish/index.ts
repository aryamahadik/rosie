// Bundle publishing (T-152; C-072; K-01 v1 storage; K-05 v1 item 7): `compiler publish <bundle dir>` writes the KV bulk
// file keyed by bundle id and PostgreSQL's copy through K-05's registry calls, and never switches the active bundle id
// (the deploy script's step 3: BP 5.4; C-020).
export {
  PublishError,
  checkKvFile,
  defaultKvFile,
  kvBulkEntries,
  kvBulkText,
  publishBundle,
  readBack,
  readPublishable,
  type BundlePart,
  type KvBulkEntry,
  type PartKind,
  type PublishOutcome,
  type PublishableBundle,
} from "./publish";
