// The provider webhook doors (T-275; C-044): Stripe's two endpoints and the two calendar providers' pushes, each verified
// through its port and stored once by its event id in PostgreSQL, each body read under its door's cap first (T-1195,
// ../body.ts). See stripe-webhook.ts and calendar-webhook.ts.

import type { WebhookEnvironment } from "../answer";
import { handleCalendarWebhook, type CalendarSource } from "./calendar-webhook";
import { handleStripeWebhook } from "./stripe-webhook";
import type { ProviderDeps, ProviderDoors, StripeEndpoint } from "./types";

export {
  CALENDAR_BODY_LIMIT_BYTES,
  googlePushOf,
  graphNotificationsOf,
  handleCalendarWebhook,
  type CalendarSource,
} from "./calendar-webhook";
export { scrubPayload } from "./common";
export {
  MAX_SIGNATURE_ENTRIES,
  STRIPE_BODY_LIMIT_BYTES,
  WINDOW_SECONDS,
  handleStripeWebhook,
  outOfMode,
  signatureHeaderProblem,
} from "./stripe-webhook";
export type * from "./types";

/** The paths, under BASE_PATH, that Stripe's two webhook endpoints are pointed at (K-14 README spike rows 13 and 14). */
export const STRIPE_WEBHOOK_PATHS: Readonly<Record<StripeEndpoint, string>> = {
  rosfield: "/webhooks/stripe/rosfield",
  businesses: "/webhooks/stripe/businesses",
};

/** The paths, under BASE_PATH, that each calendar provider's watches push to (K-16 `watch`: the gateway's push address). */
export const CALENDAR_WEBHOOK_PATHS: Readonly<Record<CalendarSource, string>> = {
  google: "/webhooks/calendar/google",
  microsoft: "/webhooks/calendar/microsoft",
};

/** Which provider door a path (after BASE_PATH) is. */
export type ProviderRoute =
  { door: "stripe"; endpoint: StripeEndpoint } | { door: "calendar"; source: CalendarSource };

const ROUTES = new Map<string, ProviderRoute>([
  [STRIPE_WEBHOOK_PATHS.rosfield, { door: "stripe", endpoint: "rosfield" }],
  [STRIPE_WEBHOOK_PATHS.businesses, { door: "stripe", endpoint: "businesses" }],
  [CALENDAR_WEBHOOK_PATHS.google, { door: "calendar", source: "google" }],
  [CALENDAR_WEBHOOK_PATHS.microsoft, { door: "calendar", source: "microsoft" }],
]);

/** The provider door a path under BASE_PATH names, or null when it names none. */
export function providerRouteOf(path: string): ProviderRoute | null {
  return ROUTES.get(path) ?? null;
}

/** Handles one provider webhook POST at its door. */
export function handleProviderWebhook(
  request: Request,
  route: ProviderRoute,
  deps: ProviderDeps,
  where: WebhookEnvironment,
): Promise<Response> {
  return route.door === "stripe"
    ? handleStripeWebhook(request, route.endpoint, deps, where)
    : handleCalendarWebhook(request, route.source, deps, where);
}

/**
 * The doors until the Stripe adapters (C-214, C-215), the calendar adapters (C-216, C-217), K-05 v1.1's
 * recordProviderEvent (T-199) and the business lookup are joined (D-017): each answers by failing, so a request the door
 * can read answers 503 and nothing is stored. A webhook is never stored unverified, and the providers' retries cover the
 * gap.
 */
export function unconfiguredProviders(): ProviderDoors {
  const notYet = (door: string): Promise<never> =>
    Promise.reject(new Error(`the ${door} is not connected yet`));
  return {
    stripe: { verifyWebhook: () => notYet("Stripe adapter") },
    stripeBusinesses: { businessOf: () => notYet("Stripe business lookup") },
    calendar: { verifyNotification: () => notYet("calendar adapter") },
    events: { recordProviderEvent: () => notYet("provider event store") },
  };
}
