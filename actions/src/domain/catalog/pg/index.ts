// The catalog and pricing service's read port on PostgreSQL (T-1429, widened by T-1433): T-320's CatalogReads bound to
// K-05 v1.18's five catalog reads (db/repo/catalog-reads.ts, T-1428) and its reads of a row by id to K-05 v1.2
// readTurnState's facts (db/repo/setup/turn-state.ts, T-667), under the call's own business. See reads.ts.

export {
  CatalogReadError,
  catalogReadsOf,
  pgCatalogK05Reads,
  pgCatalogReads,
  type CatalogK05Reads,
  type CatalogReadFault,
  type CatalogReadName,
  type CatalogTurn,
} from "./reads";
