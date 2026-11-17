// The catalog and pricing service's read port on PostgreSQL (T-1429): T-320's CatalogReads bound to K-05 v1.18's five
// catalog reads (db/repo/catalog-reads.ts, T-1428) under the call's own business. See reads.ts.

export {
  CatalogReadError,
  catalogReadsOf,
  pgCatalogK05Reads,
  pgCatalogReads,
  type CatalogK05Reads,
  type CatalogReadFault,
} from "./reads";
