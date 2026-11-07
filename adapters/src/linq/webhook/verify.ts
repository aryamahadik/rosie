// The Linq adapter's verifyWebhook (T-413; C-207; K-11 v1). The gateway (runtime/src/gateway, C-044) reads the three
// header values and calls this: it checks Linq's signature (the shared helper's whsec_ key, v1,<base64> entries, constant
// time, 300 s window) and parses the body into one K-06 event with the part key beside it, or says ignored for a signed
// type Rosie does not use, or rejected. It answers no HTTP status itself and writes nothing.
//
// The secret is read through `secret()` at call time (the environment's LINQ_WEBHOOK_SECRET in the Worker) and is never
// kept, returned or logged. Nothing here logs a body or a phone number.

import { verifyLinqWebhookSignature } from "../../shared/hmac";
import { parseLinqWebhook, type ParseLookups } from "./parse";
import type { VerifyWebhookRequest, VerifyWebhookResult } from "./types";

export interface LinqWebhookVerifierOptions extends ParseLookups {
  /** The webhook secret, "whsec_" and base64. Read at each call, so a rotated secret takes effect at once. */
  readonly secret: () => string | Promise<string>;
  /** Epoch milliseconds, used only when the request's `receivedAt` is not a time. Default Date.now. */
  readonly now?: () => number;
}

export interface LinqWebhookPort {
  verifyWebhook(request: VerifyWebhookRequest): Promise<VerifyWebhookResult>;
}

export function createLinqWebhookVerifier(options: LinqWebhookVerifierOptions): LinqWebhookPort {
  return {
    async verifyWebhook(request) {
      // The window runs from the gateway's own receipt time (K-11: "within 300 s of receipt").
      const received = Date.parse(request.receivedAt);
      const nowMs = Number.isNaN(received) ? (options.now ?? Date.now)() : received;
      const checked = await verifyLinqWebhookSignature({
        secret: await options.secret(),
        id: request.webhookId,
        timestamp: request.timestamp,
        raw: request.raw,
        signature: request.signature,
        nowMs,
      });
      if (!checked.valid) return { result: "rejected", httpStatus: 401, reason: checked.reason };

      let body: unknown;
      try {
        body = JSON.parse(request.raw) as unknown;
      } catch {
        // Signed by Linq but not JSON: nothing Rosie can read, so it is acknowledged and dropped.
        return { result: "ignored", httpStatus: 200, eventType: "unknown" };
      }
      const parsed = await parseLinqWebhook(
        { body, receivedAt: request.receivedAt, traceId: request.traceId },
        {
          ...(options.chatHandle ? { chatHandle: options.chatHandle } : {}),
          ...(options.optionWords ? { optionWords: options.optionWords } : {}),
        },
      );
      if (parsed.result === "ignored")
        return { result: "ignored", httpStatus: 200, eventType: parsed.eventType ?? "unknown" };
      return { result: "event", httpStatus: 200, event: parsed.event, partKey: parsed.partKey };
    },
  };
}
