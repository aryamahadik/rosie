// Types of model routing by stakes (T-363; C-121, C-115). K-01 v1's routing policy (contracts/bundle
// bundle.v1.schema.json: `manifest.policy`, `readPair`, `modelRole`) and K-02 v1's stakes (contracts/model
// model.v1.schema.json: `stakes`, `choice.stakes`, `decideResult.stakes` and `decideResult.routing`) are written by hand,
// as the other stages write theirs: the generated types are git-ignored (ADR-005) and the Worker must not depend on
// them. The tests hold every list here to the contracts' own.

import type { BundleId } from "../../../runtime/src/trace";
import type { GatewayBundle, ModelRole } from "../gateway";

export type { BundleId, ModelRole };

/** K-01 v1 `modelRole`: which of the bundle's two models (arch 11 line 564; arch 02 line 119). */
export const MODEL_ROLES = ["haiku", "sonnet"] as const satisfies readonly ModelRole[];

/** K-02 v1 `stakes` (arch 01 line 79: high when the target question, or the first read's pick, can charge, refund, book, move or cancel). */
export const STAKES = ["low", "high"] as const;
export type Stakes = (typeof STAKES)[number];

/** K-01 v1 `readPair`, which K-02 v1's `decideResult.routing` reuses: the model that reads first and the one that checks. */
export interface ReadPair {
  readonly first: ModelRole;
  readonly second: ModelRole;
}

/**
 * K-01 v1 `manifest.policy`, routing by stakes: the read pair for low stakes and for high stakes, and the model of the
 * turn's one re-read (arch 02 line 119; arch 06 lines 285 to 287; arch 10 line 520; Q-26's default is Sonnet first).
 */
export interface RoutingPolicy {
  readonly low: ReadPair;
  readonly high: ReadPair;
  readonly reread: ModelRole;
}

/** What the router reads of a bundle's K-01 v1 manifest: its id, its two model ids and its routing policy. */
export interface RoutingBundle extends GatewayBundle {
  readonly policy: RoutingPolicy;
}

/** What the router reads of one choice of the frontier (K-02 v1 `choice`): its id and its stakes. */
export interface RoutingChoice {
  readonly choiceId: string;
  readonly stakes: Stakes;
}

/** What the router reads of a turn's K-02 v1 `context`: the turn, the bundle it is pinned to and its choices. */
export interface RoutingContext {
  readonly turnId: string;
  readonly bundleId: BundleId;
  readonly choices: readonly RoutingChoice[];
}

/** One of decide's two reads, routed: what decide's one read (T-368) takes, and what it was routed by. */
export interface RoutedRead {
  /** K-08 v1's model-call purpose: decideFirst for the first read, decideCheck for the read that checks it. */
  readonly purpose: "decideFirst" | "decideCheck";
  /** K-02 v1 `read.role`. */
  readonly role: "first" | "check";
  /** The model the AI gateway asks first (the request's `role`); the other one is only its fallback (arch 06 line 293). */
  readonly model: ModelRole;
  /** That model's id in the bundle: claude-haiku-5-5 or claude-sonnet-5-5, never another (arch 11 line 564). */
  readonly modelId: string;
  /** The seed that orders this read's choices (T-367; context/seed.ts). */
  readonly seed: number;
  /** The choice ids in the order this seed lists them, as the context bundle lays them out. */
  readonly choiceOrder: readonly string[];
}

/** The turn's one re-read, when it runs (T-370): the model the policy names for it. */
export interface RoutedReread {
  readonly purpose: "reread";
  readonly role: "reread";
  readonly model: ModelRole;
  readonly modelId: string;
}

/** One turn's route: its stakes, the read pair the bundle's policy gives them, and decide's two reads in order. */
export interface TurnRoute {
  readonly turnId: string;
  readonly bundleId: BundleId;
  /** The turn's stakes as routing reads them, before any read: high when any choice it offers is high. */
  readonly stakes: Stakes;
  /** The ids of the choices that made it high, sorted; empty on low stakes. */
  readonly highChoices: readonly string[];
  /** K-02 v1 `decideResult.routing`: the policy's pair for these stakes. */
  readonly routing: ReadPair;
  /** The first read, then the read that checks it. */
  readonly reads: readonly [RoutedRead, RoutedRead];
  readonly reread: RoutedReread;
}

export interface RouteOptions {
  /**
   * Where a read's seed comes from: a 32-bit unsigned integer per call. Defaults to drawSeed (crypto.getRandomValues);
   * tests pass their own.
   */
  readonly draw?: () => number;
}

/** The router of one bundle: its policy, checked, and the route of each turn pinned to that bundle. */
export interface Router {
  readonly bundleId: BundleId;
  readonly policy: RoutingPolicy;
  /**
   * Routes one turn by its stakes and the bundle's policy, before any model call. Throws RoutingRefusedError, and makes
   * no route, for a turn of another bundle, a turn with no choice, or a choice whose stakes is neither low nor high.
   */
  route(context: RoutingContext, options?: RouteOptions): TurnRoute;
}
