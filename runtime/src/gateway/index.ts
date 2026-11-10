// The gateway (C-044): the Linq webhook entry (T-241, linq-webhook.ts) and the Stripe and calendar webhook doors (T-275,
// providers/), with the answer rules they share (answer.ts).

import { DEFAULT_BUNDLE_ID } from "./answer";
import { unconfiguredProviders, type ProviderDeps } from "./providers";
import type { GatewayDeps } from "./types";

export { DEFAULT_BUNDLE_ID, type WebhookEnvironment } from "./answer";
export { handleLinqWebhook } from "./linq-webhook";
export { durableObjectActor, type ActorNamespace, type HandleActorRpc } from "./actor-door";
export {
  ACTOR_KINDS,
  HandoffError,
  RECEIPT_KINDS,
  prepareHandoff,
  type Prepared,
  type ScrubDone,
} from "./hand-off";
export {
  CALENDAR_WEBHOOK_PATHS,
  STRIPE_WEBHOOK_PATHS,
  handleProviderWebhook,
  providerRouteOf,
  unconfiguredProviders,
  type CalendarPort,
  type CalendarSource,
  type ProviderDeps,
  type ProviderDoors,
  type ProviderEvent,
  type ProviderEventStore,
  type ProviderRoute,
  type StripeBusinessLookup,
  type StripePort,
} from "./providers";
export {
  actorNameOf,
  openWords,
  sealWords,
  type HandleRef,
  type SealedBox,
  type SealedWords,
  type SealingKeyStore,
} from "./seal";
export type {
  ActorHandoff,
  ActorStub,
  GatewayDeps,
  InboundEvent,
  LinqPort,
  ReceiptSink,
  SealedEvent,
  SealedHandoff,
  StoreAnswer,
  VerifyWebhookRequest,
  VerifyWebhookResult,
} from "./types";

/** The path, under BASE_PATH, that Linq's webhook is pointed at. */
export const LINQ_WEBHOOK_PATH = "/webhooks/linq";

/**
 * The gateway's doors until the Linq adapter (T-413) and the actor (T-243) exist: each answers by failing, so the
 * route answers 503 and accepts nothing. A webhook is never accepted unverified, and Linq's retries cover the gap.
 * The provider doors are unconfigured the same way (T-275).
 */
export function unconfiguredGateway(): GatewayDeps {
  const notYet = (door: string): Promise<never> =>
    Promise.reject(new Error(`the ${door} is not connected yet`));
  return {
    linq: { verifyWebhook: () => notYet("Linq adapter") },
    actor: { accept: () => notYet("handle actor") },
    receipts: { accept: () => notYet("dispatcher") },
    keys: { getOrCreateKey: () => notYet("sealing key store") },
    bundleId: () => DEFAULT_BUNDLE_ID,
    providers: unconfiguredProviders(),
  };
}

/** The provider doors' dependencies from the gateway's: its doors (unconfigured when left out), bundle id and clock. */
export function providerDepsOf(deps: GatewayDeps): ProviderDeps {
  return {
    ...(deps.providers ?? unconfiguredProviders()),
    bundleId: deps.bundleId,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  };
}
