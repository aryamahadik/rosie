// The gateway (T-241; C-044): the Linq webhook entry. See linq-webhook.ts.

import { DEFAULT_BUNDLE_ID } from "./linq-webhook";
import type { GatewayDeps } from "./types";

export { DEFAULT_BUNDLE_ID, handleLinqWebhook, type WebhookEnvironment } from "./linq-webhook";
export type {
  ActorHandoff,
  ActorStub,
  GatewayDeps,
  InboundEvent,
  LinqPort,
  VerifyWebhookRequest,
  VerifyWebhookResult,
} from "./types";

/** The path, under BASE_PATH, that Linq's webhook is pointed at. */
export const LINQ_WEBHOOK_PATH = "/webhooks/linq";

/**
 * The gateway's doors until the Linq adapter (T-413) and the actor (T-243) exist: each answers by failing, so the
 * route answers 503 and accepts nothing. A webhook is never accepted unverified, and Linq's retries cover the gap.
 */
export function unconfiguredGateway(): GatewayDeps {
  const notYet = (door: string): Promise<never> =>
    Promise.reject(new Error(`the ${door} is not connected yet`));
  return {
    linq: { verifyWebhook: () => notYet("Linq adapter") },
    actor: { accept: () => notYet("handle actor") },
    bundleId: () => DEFAULT_BUNDLE_ID,
  };
}
