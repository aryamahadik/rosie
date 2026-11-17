// Limit 2's owner rules on PostgreSQL (T-1429): OwnerRules.rulesOf bound to K-05 v1.18's readTermsSources
// (db/repo/catalog-reads.ts, T-1428). See owner-rules.ts.

export {
  OwnerRulesReadError,
  ownerRulesOf,
  pgOwnerRules,
  type OwnerRulesReadFault,
  type TermsSourcesRead,
} from "./owner-rules";
