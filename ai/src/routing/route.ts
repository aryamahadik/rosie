// Model routing by stakes (T-363; C-121, C-115; arch 06 lines 285 to 287; arch 10 line 520; arch 01 line 79; Q-26).
//
// Before decide's first read, the router reads the turn's stakes from its K-02 v1 choices and the bundle's K-01 v1
// policy, and says which model makes each of the two reads and with which seed:
//
//   stakes      the turn is high when any choice it offers is high: the first read may pick any of them, and arch 01
//               line 79 makes a turn high when the first read's pick can charge, refund, book, move or cancel. A turn
//               whose choices are all low is low. A choice's stakes is the frontier builder's (C-075; K-02 README).
//   models      the policy's pair for those stakes, as the bundle's manifest writes it. Q-26's default, which every
//               sample bundle carries: low, Haiku twice; high, Sonnet first with Haiku checking. A manifest saying
//               Haiku first on high stakes is routed so: the switch is data (J-21), and nothing here names an order.
//               The re-read's model is the policy's too (T-370 runs it).
//   shuffles    each read has its own seed, which orders its choices (T-367: a draw without replacement over the
//               choices sorted by id). The check read's seed always lists them in another order than the first's
//               whenever there are two choices or more, so two reads on one model are two shuffles (arch 06 line 285:
//               "Haiku twice, choices shuffled"). A drawn seed whose order is the first's (one chance in 2 with two
//               choices, one in 120 with five) is stepped on, seed + 1 and wrapping at 2^32, until it is not.
//
// A route names only haiku or sonnet, and only the bundle's two ids for them: the bundle's id and models are checked as
// the AI gateway checks them (T-361: claude-haiku-5-5 and claude-sonnet-5-5, never swapped, never another), and the
// policy as K-01 v1 writes it (policy.ts). The calls themselves go through decide's one read (T-368), which asks the
// gateway for the routed model first; the gateway's own retry and fallback (one retry, then the other model once) are
// unchanged. Comparing the two reads is T-369's.
//
// The router makes no call, reads no key and writes no span; a route holds ids, roles, seeds and stakes, never words.

import { ALLOWED_MODELS, GatewayConfigError, createGateway } from "../gateway";
import { drawSeed, isSeed, shuffled } from "../context/seed";
import { RoutingRefusedError } from "./errors";
import { readPolicy } from "./policy";
import {
  STAKES,
  type BundleId,
  type ModelRole,
  type RouteOptions,
  type RoutedRead,
  type RoutedReread,
  type Router,
  type RoutingBundle,
  type RoutingContext,
  type Stakes,
  type TurnRoute,
} from "./types";

/** How many seeds after a drawn one the check read may step through to list the choices in another order. */
export const MAX_SEED_STEPS = 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStakes = (value: unknown): value is Stakes =>
  typeof value === "string" && (STAKES as readonly string[]).includes(value);

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The turn's choices, checked (K-02 `choice`: at least one, each with its id and its stakes): their ids, each once and
 * sorted, which is the order every seed starts from (T-367's builder sorts the same), and the high ones' ids, sorted.
 */
function readChoices(context: RoutingContext): { ids: string[]; high: string[] } {
  const choices: unknown = context.choices;
  if (!Array.isArray(choices) || choices.length === 0)
    throw new RoutingRefusedError("the turn offers no choice: K-02's frontier holds at least one");
  const ids = new Set<string>();
  const high = new Set<string>();
  for (const [k, choice] of (choices as readonly unknown[]).entries()) {
    if (!isRecord(choice) || typeof choice.choiceId !== "string" || choice.choiceId === "")
      throw new RoutingRefusedError(`choices[${String(k)}] has no choice id`);
    if (!isStakes(choice.stakes))
      throw new RoutingRefusedError(`choice ${choice.choiceId} has no stakes of K-02's: low or high`);
    ids.add(choice.choiceId);
    if (choice.stakes === "high") high.add(choice.choiceId);
  }
  return { ids: [...ids].sort(compareText), high: [...high].sort(compareText) };
}

/**
 * The turn's stakes, before any read: high when any choice it offers is high (arch 01 line 79), with those choices'
 * ids, sorted. Throws RoutingRefusedError for a turn with no choice, or a choice with no id or with stakes K-02 does
 * not have.
 */
export function turnStakes(context: RoutingContext): { stakes: Stakes; highChoices: string[] } {
  const { high } = readChoices(context);
  return { stakes: high.length > 0 ? "high" : "low", highChoices: high };
}

/**
 * The choice ids in the order a seed lists them: the context bundle's rule (T-367; context/seed.ts), a draw without
 * replacement over the ids sorted, so one seed and one set of choices always give one order.
 */
export function choiceOrder(choiceIds: readonly string[], seed: number): string[] {
  if (!isSeed(seed)) throw new RoutingRefusedError("a seed is a whole number from 0 to 2^32 - 1");
  return shuffled([...new Set(choiceIds)].sort(compareText), seed);
}

/** A seed from the source, checked. */
function seedFrom(draw: () => number): number {
  const seed = draw();
  if (!isSeed(seed)) throw new RoutingRefusedError("the seed source gave a value that is not a seed");
  return seed;
}

const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, k) => id === b[k]);

/**
 * The two reads' seeds: the first as drawn; the check's drawn, then stepped until it is another seed and, with two
 * choices or more, lists them in another order than the first's.
 */
function seedsFor(ids: readonly string[], draw: () => number): [number, number] {
  const first = seedFrom(draw);
  const firstOrder = shuffled(ids, first);
  let check = seedFrom(draw);
  for (let step = 0; step <= MAX_SEED_STEPS; step += 1) {
    if (check !== first && (ids.length < 2 || !sameOrder(shuffled(ids, check), firstOrder)))
      return [first, check];
    check = (check + 1) >>> 0;
  }
  throw new RoutingRefusedError(
    `no seed within ${String(MAX_SEED_STEPS)} steps of the one drawn lists the choices in another order`,
  );
}

/**
 * Builds the router of one bundle from its K-01 v1 manifest. Refuses, before any route, a bundle the AI gateway refuses
 * (GatewayConfigError: a bundle id that is not K-01's, a model id outside the two, swapped ids) and a policy that is not
 * K-01 v1's (RoutingPolicyError).
 */
export function createRouter(bundle: RoutingBundle): Router {
  const bundleId: BundleId = Object.freeze({ hash: bundle.bundleId.hash, build: bundle.bundleId.build });
  const models = Object.freeze({ haiku: bundle.models.haiku, sonnet: bundle.models.sonnet });
  // The gateway's own checks of the bundle's id and models: a route can only name what the gateway can call.
  createGateway({ bundle: { bundleId, models }, env: {} });
  const policy = readPolicy(bundle.policy);

  const modelIdOf = (model: ModelRole): string => {
    const id = model === "haiku" ? models.haiku : models.sonnet;
    if (!(ALLOWED_MODELS as readonly string[]).includes(id))
      throw new GatewayConfigError(`model ${id} is not one the gateway may call`);
    return id;
  };
  const reread: RoutedReread = Object.freeze({
    purpose: "reread",
    role: "reread",
    model: policy.reread,
    modelId: modelIdOf(policy.reread),
  });

  return Object.freeze({
    bundleId,
    policy,
    route(context: RoutingContext, options: RouteOptions = {}): TurnRoute {
      const pinned: unknown = context.bundleId;
      if (!isRecord(pinned) || pinned.hash !== bundleId.hash || pinned.build !== bundleId.build)
        throw new RoutingRefusedError(
          "the turn is pinned to another bundle than the router's: a turn is routed by its own",
        );
      const turnId: unknown = context.turnId;
      if (typeof turnId !== "string" || turnId === "")
        throw new RoutingRefusedError("the turn has no turn id");

      const { ids, high } = readChoices(context);
      const stakes: Stakes = high.length > 0 ? "high" : "low";
      const pair = policy[stakes];
      const [firstSeed, checkSeed] = seedsFor(ids, options.draw ?? drawSeed);

      const read = (
        purpose: RoutedRead["purpose"],
        role: RoutedRead["role"],
        model: ModelRole,
        seed: number,
      ): RoutedRead =>
        Object.freeze({
          purpose,
          role,
          model,
          modelId: modelIdOf(model),
          seed,
          choiceOrder: Object.freeze(shuffled(ids, seed)),
        });

      return Object.freeze({
        turnId,
        bundleId,
        stakes,
        highChoices: Object.freeze(high),
        routing: Object.freeze({ first: pair.first, second: pair.second }),
        reads: Object.freeze([
          read("decideFirst", "first", pair.first, firstSeed),
          read("decideCheck", "check", pair.second, checkSeed),
        ] as const),
        reread,
      });
    },
  });
}
