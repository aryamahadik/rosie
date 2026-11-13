// The gateway (C-044): the Linq webhook entry (T-241, linq-webhook.ts), the Stripe and calendar webhook doors (T-275,
// providers/), the Resend webhook door for email's delivery events and inbound replies (T-265, email/) and the page entry
// for the web app's page and console calls (T-266, pages/), with the answer rules they share (answer.ts) and the capped
// body read the Linq entry and the page entry read through (T-1180, body.ts).

import { DEFAULT_BUNDLE_ID } from "./answer";
import { unconfiguredEmail, type EmailDeps } from "./email";
import { unconfiguredPages, type PageDeps } from "./pages";
import { unconfiguredProviders, type ProviderDeps } from "./providers";
import type { GatewayDeps } from "./types";

export { DEFAULT_BUNDLE_ID, type WebhookEnvironment } from "./answer";
export {
  LINQ_BODY_LIMIT_BYTES,
  PAGE_BODY_LIMIT_BYTES,
  bodyLimitOf,
  readCappedText,
  type BodyRead,
} from "./body";
export { handleLinqWebhook } from "./linq-webhook";
export { durableObjectActor, type ActorNamespace, type HandleActorRpc } from "./actor-door";
export {
  CHAT_KINDS,
  CHAT_REQUEST_REFUSED,
  ChatOpenError,
  chatRequestOf,
  isRefusedRequest,
  NO_HANDLE_ID,
  openChatAtReceipt,
  opensChat,
  TEXT_SERVICES,
  type ChatAtReceipt,
} from "./chat-open";
export {
  EMAIL_BODY_LIMIT_BYTES,
  RESEND_WEBHOOK_PATH,
  handleResendWebhook,
  unconfiguredEmail,
  type EmailDeps,
  type EmailPort,
  type EmailReadRequest,
  type EmailReadResult,
  type EmailRejectReason,
  type EmailVerifyRequest,
  type EmailVerifyResult,
} from "./email";
export {
  ACTOR_KINDS,
  HandoffError,
  RECEIPT_KINDS,
  prepareHandoff,
  type Prepared,
  type ScrubDone,
} from "./hand-off";
export {
  PAGE_API_PATH,
  PAGE_CALLS,
  PAGE_ERRORS,
  PageNotConnectedError,
  STAGING_ONLY_CALLS,
  STAGING_ONLY_OUTCOME,
  UNKNOWN_PAGE_ERROR,
  handlePageCall,
  isPageCall,
  isPageError,
  isStagingOnly,
  pagePathOf,
  pageRouteOf,
  unconfiguredPages,
  type PageCallName,
  type PageDeps,
  type PageErrorName,
  type PageHandler,
  type PageHandlers,
  type PageOutcome,
  type PageRequest,
} from "./pages";
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
  optionWordsOf,
  sealEventWords,
  sealWords,
  wordsOfEvent,
  type EventBox,
  type EventWords,
  type HandleKey,
  type HandleRef,
  type SealedBox,
  type SealedBoxV2,
  type SealedWords,
  type SealingKeyStore,
  type StoredWords,
} from "./seal";
export type {
  ActorHandoff,
  ActorStub,
  ChatOpenAnswer,
  ChatOpenPort,
  ChatOpenRequest,
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
 * The provider doors (T-275), the page handlers (T-266) and the email port (T-265) are unconfigured the same way.
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
    pages: unconfiguredPages(),
    email: unconfiguredEmail(),
  };
}

/**
 * The email webhook door's dependencies from the gateway's (T-265): its email port (closed when left out, so the route
 * answers 503 until the composition root binds it), the same door to the handle's actor, receipt door and key store the
 * Linq entry writes through, its bundle id, clock and body cap (EMAIL_BODY_LIMIT_BYTES when left out).
 */
export function emailDepsOf(deps: GatewayDeps): EmailDeps {
  return {
    email: deps.email ?? unconfiguredEmail(),
    actor: deps.actor,
    receipts: deps.receipts,
    keys: deps.keys,
    bundleId: deps.bundleId,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.emailBodyLimitBytes === undefined ? {} : { emailBodyLimitBytes: deps.emailBodyLimitBytes }),
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

/**
 * The page entry's dependencies from the gateway's: its handlers (not connected when left out), bundle id, clock and body
 * cap (PAGE_BODY_LIMIT_BYTES when left out).
 */
export function pageDepsOf(deps: GatewayDeps): PageDeps {
  return {
    handlers: deps.pages ?? unconfiguredPages(),
    bundleId: deps.bundleId,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.pageBodyLimitBytes === undefined ? {} : { bodyLimitBytes: deps.pageBodyLimitBytes }),
  };
}
