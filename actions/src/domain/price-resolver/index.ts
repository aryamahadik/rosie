// The price resolver (C-132, T-639; arch 05 line 253; S13-25 rule 19; K-25 v1 "How a price is found"): the price rule
// with the most conditions set (place, worker, time) wins; a possible tie is caught when the owner saves the second rule
// and the read-back asks which wins; until answered, the lower price applies. See resolve.ts (the steps, over rows) and
// service.ts (one call's resolver over the catalog's read 4).

export {
  PriceResolverError,
  checkVisit,
  conditionsHold,
  localStart,
  resolvePrice,
  tieQuestions,
  tiesAtSave,
  type DecidedBy,
  type PriceAnswer,
  type PriceResolverRefusal,
  type RuleShown,
  type TieQuestion,
  type Visit,
} from "./resolve";
export { createPriceResolver, type PriceResolver, type PriceResolverDeps } from "./service";
