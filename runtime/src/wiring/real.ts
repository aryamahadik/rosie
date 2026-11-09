// The real implementation set (T-552 onwards; build prompt section 10, D-017 'Joins: one hop at a time, in the turn
// order'): what ./picks.ts calls "real", built by the root from what its environment holds. Each join adds its port here,
// in D-017's turn order (./ports.ts):
//
//   linqVerify   T-552: @rosie/adapters' Linq verify and parse (T-413, C-207; K-11 v1 verifyWebhook), fed by the Linq
//                double's signer (T-412): the webhook secret is read at each call from what the root is handed, the
//                Linq double's made-up test secret in a test and LINQ_WEBHOOK_SECRET by name in the Worker (K-11 README
//                default 1; set on staging by name, T-568; until J-08 it must be the secret the test-phone page's Linq
//                double signs with, which K-11 says is the test environment's, never Linq's). Where no secret is set the
//                call fails, so the gateway answers 503, verifies nothing and hands nothing on.
//
// Worker code: no double, no fixture, no key, no network call. The secret is never kept, returned or logged: an error
// names the secret by its name only.

import {
  createLinqWebhookVerifier,
  type ParseLookups,
  type VerifyWebhookResult as AdapterVerifyResult,
} from "@rosie/adapters/linq/webhook";

import type { InboundEvent, LinqPort, VerifyWebhookResult } from "../gateway/types";
import type { Ports } from "./ports";

/** The name the Worker reads the Linq webhook secret by (K-11 README default 1). */
export const LINQ_WEBHOOK_SECRET = "LINQ_WEBHOOK_SECRET";

/** A secret that is not set where it is read. The message names the secret, never a value. */
export class MissingSecretError extends Error {
  constructor(name: string) {
    super(`${name} is not set here`);
    this.name = "MissingSecretError";
  }
}

/**
 * What the real Linq verify is fed: the webhook secret, read at each call ("whsec_" and base64; undefined or "" where none
 * is set), and the adapter's lookups (T-413 ParseLookups): the person a receipt's chat belongs to, and a poll option's
 * words. Left out, a receipt cannot be parsed (the adapter fails it, so the gateway answers 503 and Linq retries) and a
 * vote's words stay "".
 */
export interface LinqVerifyInputs extends ParseLookups {
  readonly webhookSecret: () => string | undefined | Promise<string | undefined>;
}

/** Where the real set reads its inputs: the Linq verify's (left out: no secret is set) and the root's clock. */
export interface RealInputs {
  readonly linq?: LinqVerifyInputs | undefined;
  /** Epoch milliseconds: the adapter's clock for a request whose receipt time is not a time (the gateway always gives one). */
  readonly now: () => number;
}

/** The real implementation of each port joined so far. */
export function realPorts(inputs: RealInputs): Partial<Ports> {
  return { linqVerify: linqVerify(inputs) };
}

/**
 * K-11 v1 verifyWebhook through the Linq adapter (T-413): the signature over id.timestamp.raw under the secret, within
 * 300 s of the gateway's receipt time, then the body parsed into one K-06 v1 event with the part key beside it, or ignored,
 * or rejected (badTimestamp, staleTimestamp, badSignature), which the gateway answers 401.
 */
function linqVerify(inputs: RealInputs): LinqPort {
  const linq = inputs.linq;
  const verifier = createLinqWebhookVerifier({
    ...(linq?.chatHandle === undefined ? {} : { chatHandle: linq.chatHandle }),
    ...(linq?.optionWords === undefined ? {} : { optionWords: linq.optionWords }),
    now: inputs.now,
    secret: async () => {
      const secret = linq === undefined ? undefined : await linq.webhookSecret();
      if (secret === undefined || secret === "") throw new MissingSecretError(LINQ_WEBHOOK_SECRET);
      return secret;
    },
  });
  return {
    async verifyWebhook(request) {
      return gatewayResultOf(await verifier.verifyWebhook(request));
    },
  };
}

/** The adapter's answer as the gateway's port type writes it: the same result, status, event, part key, type and reason. */
function gatewayResultOf(answer: AdapterVerifyResult): VerifyWebhookResult {
  switch (answer.result) {
    case "event":
      // The same K-06 v1 event, field for field. The two hand-written types differ only where K-06 is wider than the
      // gateway's: K-06 lets a receipt's service be null where Linq names none (the adapter's parse), while the gateway's
      // InboundEvent says text and reads the service only as a span label, which leaves a null out (labelFacts).
      return {
        result: "event",
        httpStatus: 200,
        event: answer.event as unknown as InboundEvent,
        partKey: answer.partKey,
      };
    case "ignored":
      return { result: "ignored", httpStatus: 200, eventType: answer.eventType };
    case "rejected":
      return { result: "rejected", httpStatus: 401, reason: answer.reason };
  }
}
