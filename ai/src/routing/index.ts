// Model routing by stakes (T-363; C-121, C-115): route.ts for the router (the turn's stakes, the bundle's pair for them,
// each read's model and seed), policy.ts for K-01 v1's routing policy, checked. Running and comparing the two reads is
// T-369's; the re-read T-370's.

export { MAX_SEED_STEPS, choiceOrder, createRouter, turnStakes } from "./route";
export { isModelRole, policyProblems, readPolicy } from "./policy";
export { RoutingPolicyError, RoutingRefusedError } from "./errors";
export {
  MODEL_ROLES,
  STAKES,
  type BundleId,
  type ModelRole,
  type ReadPair,
  type RouteOptions,
  type RoutedRead,
  type RoutedReread,
  type Router,
  type RoutingBundle,
  type RoutingChoice,
  type RoutingContext,
  type RoutingPolicy,
  type Stakes,
  type TurnRoute,
} from "./types";
