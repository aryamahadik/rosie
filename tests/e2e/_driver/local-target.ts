// The local target (T-465; C-148): sends a text into the gateway as Linq would, signed by the Linq double's own hook
// (K-11 v1 doubleWebhook, C-211's createLinqWebhookDouble), then collects the trace by the trace id the gateway answers
// with, the parts the Linq double sent with its faked receipts and failures (fakeFailure, fakeDelivered: what says a
// sent part failed, as eventFromDoubleEvent carries them to the gateway), and the outbox rows written under that trace.
//
// No key is read. The webhook secret is made here, at run time, from random bytes ("whsec_" and base64, the form the
// double and the adapter take); the caller gives the same made-up secret to the gateway's verifier. Nothing reads an
// environment variable or a file for it, and nothing logs it, a body, a phone number or a part's words.
//
// The gateway is whatever answers a Request as the Worker would (its fetch, bound to its env): the driver holds no
// gateway of its own (C-044 is the runtime lane's).

import { createLinqWebhookDouble } from "../../../adapters/src/linq/double-webhooks";
import type { LinqDouble } from "../../../adapters/src/linq/double";
import type { InboundEvent } from "../../../adapters/src/linq/webhook/types";
import { LINQ_WEBHOOK_PATH } from "../../../runtime/src/gateway";
import { checkOutboxRows, type OutboxReader } from "./outbox";
import { RecordingLinqDouble, partsOf } from "./parts";
import { settle, type CollectOptions, type Collected, type SentText } from "./run";
import { captureConsoleLog, spansOfLogLines, traceOf, type LogCapture, type SpanReader } from "./trace";

/** A made-up webhook secret for one run: "whsec_" and 32 random bytes in base64. Never Linq's, never stored. */
export function makeTestWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `whsec_${btoa(String.fromCharCode(...bytes))}`;
}

/** The origin a local request is addressed to; the gateway reads only the path. */
const LOCAL_ORIGIN = "http://rosie.local";

export interface LocalTargetOptions {
  /** Answers a Request as the Worker would: its fetch, bound to its env. */
  readonly gateway: (request: Request) => Response | Promise<Response>;
  /** The Worker's BASE_PATH: "" by default ("/test" is staging's, d000-factory-spec section 6). */
  readonly basePath?: string;
  /** The made-up secret the double signs with. Default: a new one (makeTestWebhookSecret). */
  readonly webhookSecret?: string;
  /** The Linq double the dispatcher sends to. Default: a new RecordingLinqDouble, which keeps each part's outcome. */
  readonly linq?: LinqDouble;
  /** Where span log lines are read. Default: console.log lines captured from now until close(). */
  readonly spans?: SpanReader;
  /** Reads the outbox rows written under a trace id (K-07 v1 records); without one, `outbox` is null. */
  readonly outbox?: OutboxReader;
  /** Epoch milliseconds: a webhook's arrival time. Default Date.now. */
  readonly now?: () => number;
}

export interface SendOptions {
  /** For a sent or delivered receipt: the part key it echoes (K-11 v1 partKey). Default null. */
  readonly partKey?: string | null;
  /** Keep the event's own receivedAt. Default false: the webhook arrives now, inside the 300 s window. */
  readonly keepReceivedAt?: boolean;
}

export interface LocalTarget {
  readonly name: "local";
  /** The made-up secret the double signs with: give it to the gateway's verifier. */
  readonly webhookSecret: string;
  /** The Linq double whose parts are collected: give it to the dispatcher. */
  readonly linq: LinqDouble;
  /** Signs one K-06 event as Linq's webhook through the double and posts it to the gateway. */
  sendEvent(event: InboundEvent, options?: SendOptions): Promise<SentText>;
  /** The trace by its id, the Linq double's parts and the outbox rows under the trace. */
  collect(traceId: string, options?: CollectOptions): Promise<Collected>;
  /** Stops the console capture, when this target started one. */
  close(): void;
}

function utcSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/[.][0-9]+Z$/, "Z");
}

async function traceIdOf(response: Response): Promise<string> {
  const header = response.headers.get("x-trace-id");
  if (header !== null && header !== "") return header;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    body = null;
  }
  const traceId = (body as { trace_id?: unknown } | null)?.trace_id;
  if (typeof traceId === "string" && traceId !== "") return traceId;
  throw new Error(`the gateway answered ${String(response.status)} with no trace id (x-trace-id)`);
}

export function createLocalTarget(options: LocalTargetOptions): LocalTarget {
  const webhookSecret = options.webhookSecret ?? makeTestWebhookSecret();
  const webhooks = createLinqWebhookDouble({ secret: webhookSecret });
  const linq = options.linq ?? new RecordingLinqDouble();
  const now = options.now ?? Date.now;
  const basePath = (options.basePath ?? "").replace(/\/+$/, "");
  const capture: LogCapture | null = options.spans === undefined ? captureConsoleLog() : null;
  const spans: SpanReader = options.spans ?? capture?.reader ?? (() => []);

  const read = async (traceId: string): Promise<Collected> => {
    const { trace, problems } = traceOf(traceId, spansOfLogLines(await spans(traceId)));
    const outbox =
      options.outbox === undefined ? null : await checkOutboxRows(await options.outbox(traceId), traceId);
    return {
      target: "local",
      traceId,
      trace,
      traceProblems: problems,
      parts: partsOf(linq),
      linqEvents: linq.events(),
      outbox,
    };
  };

  return {
    name: "local",
    webhookSecret,
    linq,
    async sendEvent(event, sendOptions = {}) {
      const arriving =
        sendOptions.keepReceivedAt === true ? event : { ...event, receivedAt: utcSeconds(now()) };
      const signed = await webhooks.sign({ event: arriving, partKey: sendOptions.partKey ?? null });
      const response = await options.gateway(
        new Request(`${LOCAL_ORIGIN}${basePath}${LINQ_WEBHOOK_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "webhook-id": signed.webhookId,
            "webhook-timestamp": signed.timestamp,
            "webhook-signature": signed.signature,
          },
          body: signed.raw,
        }),
      );
      return {
        target: "local",
        eventId: event.eventId,
        traceId: await traceIdOf(response),
        gatewayStatus: response.status,
      };
    },
    collect(traceId, collectOptions) {
      return settle(() => read(traceId), collectOptions);
    },
    close() {
      capture?.stop();
    },
  };
}
