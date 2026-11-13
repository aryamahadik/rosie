// What the router throws. Both are faults in a bundle or in the calling code, found before any model call: loud, and no
// route is made. A message names fields, roles and choice ids, never a person's words.

/** The bundle's routing policy is not K-01 v1's: a field missing or extra, or a model that is not haiku or sonnet. */
export class RoutingPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingPolicyError";
  }
}

/** A turn the router cannot route: another bundle's, one with no choice, a choice with no stakes, a seed that is not one. */
export class RoutingRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingRefusedError";
  }
}
