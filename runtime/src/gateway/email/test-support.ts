// Doubles for the email door's tests (T-265). Not imported by the Worker. The email port is the email double itself
// (T-418; adapters/src/email/double), so each webhook's Svix signature is really made and checked, under the test
// environment's own made-up webhook secret, never Resend's (rule 7; K-12 README "Signatures in fixtures"):
//
//   - a delivery event is a K-12 fixture's own webhook (its id, timestamp and raw body), signed at test time as its
//     given.signing says (the double's signRaw), which the double's verify reads into the fixture's K-06 event;
//   - a reply is the double's faked email.received for a K-06 event (doubleWebhook), which it keeps for readReply, so the
//     door's two steps, verify then read, run as they do against Resend (K-12 README "Inbound replies");
//   - the door to the handle's actor and the receipt door are stubs that store each event id once, as T-244's actor and
//     the dispatcher's receipt handler do, and the key store is the gateway's fake (../test-support.ts).
// Test values only: K-06's and K-12's fixtures (Lee's Barbershop and the sample cast on example.com) and public test
// card numbers (rule 9).

import { vi } from "vitest";

import {
  createEmailDouble,
  type DoubleWebhookOptions,
  type EmailDouble,
  type EmailEvent,
  type VerifyWebhookRequest,
} from "../../../../adapters/src/email/double";
import { spansOfLogLines } from "../../trace/hop-check";
import type { Span } from "../../trace";
import { openWords } from "../seal";
import { fakeKeyStore, type FakeKeyStore } from "../test-support";
import type { ActorHandoff, ActorStub, ReceiptSink, SealedHandoff, StoreAnswer } from "../types";
import { RESEND_WEBHOOK_PATH } from ".";
import type {
  EmailDeps,
  EmailPort,
  EmailReadRequest,
  EmailReadResult,
  EmailVerifyRequest,
  EmailVerifyResult,
} from "./types";

type Json = Record<string, unknown>;

/** The test environment's own webhook secret, made up here in Svix's form ("whsec_" and base64). Not a key of any service. */
export const EMAIL_TEST_WEBHOOK_SECRET = `whsec_${btoa("rosie-email-door-test-key-0001")}`;

/** Another made-up secret: a webhook signed under it is not one this environment's port accepts. */
export const OTHER_TEST_WEBHOOK_SECRET = `whsec_${btoa("rosie-email-door-test-key-0002")}`;

/** The path, under staging's BASE_PATH (/test), of the Resend webhook. */
export const RESEND_TEST_PATH = `/test${RESEND_WEBHOOK_PATH}`;

/** A K-12 verifyWebhook exchange (contracts/port-email/fixtures). */
export interface VerifyExchange {
  given: { now: string; signing?: string };
  request: { webhookId: string; timestamp: string; raw: string; receivedAt: string; traceId: string };
  outcome: unknown;
}

/** The four things of a webhook Resend sends: its three Svix headers and its body. */
export type SentWebhook = Pick<VerifyWebhookRequest, "webhookId" | "timestamp" | "signature" | "raw">;

/** An email double that signs and verifies under `secret` (the test environment's by default). */
export function emailDouble(secret: string = EMAIL_TEST_WEBHOOK_SECRET): EmailDouble {
  return createEmailDouble({ webhookSecret: () => secret });
}

/** A K-12 fixture's own webhook, signed now under the double's secret as its given.signing says. */
export function signedFixture(double: EmailDouble, exchange: VerifyExchange): Promise<VerifyWebhookRequest> {
  const { webhookId, timestamp, raw, receivedAt, traceId } = exchange.request;
  return double.signRaw(
    { webhookId, timestamp, raw, receivedAt, traceId },
    { oneByteChanged: exchange.given.signing === "oneByteChanged" },
  );
}

/**
 * The double's signed email.received for a reply's K-06 event, which it keeps for readReply under `receivedEmailId`
 * (its own next id when left out).
 */
export async function signedReply(
  double: EmailDouble,
  event: Json,
  options: DoubleWebhookOptions = {},
): Promise<VerifyWebhookRequest> {
  const signed = await double.doubleWebhook(
    { event: event as unknown as EmailEvent, rfcMessageId: null },
    options,
  );
  return signed.webhook;
}

/** A Resend webhook as Svix sends it: a POST of the raw body with its three svix- headers (one left out when null). */
export function resendRequest(
  webhook: { [Field in keyof SentWebhook]: SentWebhook[Field] | null },
  path: string = RESEND_TEST_PATH,
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (webhook.webhookId !== null) headers["svix-id"] = webhook.webhookId;
  if (webhook.timestamp !== null) headers["svix-timestamp"] = webhook.timestamp;
  if (webhook.signature !== null) headers["svix-signature"] = webhook.signature;
  return new Request(`https://rosie.test${path}`, { method: "POST", headers, body: webhook.raw ?? "" });
}

export interface EmailPortDouble extends EmailPort {
  /** Every request the door handed the verify call, in order. */
  readonly verified: EmailVerifyRequest[];
  /** Every request the door handed the read of a reply, in order. */
  readonly reads: EmailReadRequest[];
}

/**
 * The gateway's email port over the email double: each call goes to the double as the door made it, and is kept. `change`
 * rewrites a read's answer before the door gets it (a port off the contract, for the door's own checks).
 */
export function emailPortOf(
  double: EmailDouble,
  change: (answer: Json) => unknown = (answer) => answer,
): EmailPortDouble {
  const verified: EmailVerifyRequest[] = [];
  const reads: EmailReadRequest[] = [];
  return {
    verified,
    reads,
    async verifyWebhook(request) {
      verified.push(structuredClone(request));
      return (await double.verifyWebhook(request)) as unknown as EmailVerifyResult;
    },
    async readReply(request) {
      reads.push(structuredClone(request));
      return change(await double.readReply(request)) as EmailReadResult;
    },
  };
}

export interface ActorDouble extends ActorStub {
  /** Every hand-off the door made, in order. */
  readonly calls: SealedHandoff[];
  /** The hand-offs written: each event id once. */
  readonly written: SealedHandoff[];
  /** The next calls' answers, each used once, instead of a write: an Error is a failed write. */
  readonly failNext: (Error | StoreAnswer)[];
}

/** The actor's door: writes an event once and calls a known event id a duplicate, as T-244's actor does. */
export function actorDouble(): ActorDouble {
  const seen = new Set<string>();
  const calls: SealedHandoff[] = [];
  const written: SealedHandoff[] = [];
  const failNext: (Error | StoreAnswer)[] = [];
  return {
    calls,
    written,
    failNext,
    accept(handoff) {
      calls.push(handoff);
      const failure = failNext.shift();
      if (failure instanceof Error) return Promise.reject(failure);
      if (failure !== undefined) return Promise.resolve(failure);
      if (seen.has(handoff.event.eventId)) return Promise.resolve("duplicate");
      seen.add(handoff.event.eventId);
      written.push(handoff);
      return Promise.resolve("written");
    },
  };
}

export interface ReceiptsDouble extends ReceiptSink {
  readonly calls: ActorHandoff[];
  readonly written: ActorHandoff[];
  readonly failNext: Error[];
}

/** The receipt door: stores each receipt once by its event id, as the dispatcher's receipt handler does. */
export function receiptsDouble(): ReceiptsDouble {
  const seen = new Set<string>();
  const calls: ActorHandoff[] = [];
  const written: ActorHandoff[] = [];
  const failNext: Error[] = [];
  return {
    calls,
    written,
    failNext,
    accept(handoff) {
      calls.push(handoff);
      const failure = failNext.shift();
      if (failure !== undefined) return Promise.reject(failure);
      if (seen.has(handoff.event.eventId)) return Promise.resolve("duplicate");
      seen.add(handoff.event.eventId);
      written.push(handoff);
      return Promise.resolve("written");
    },
  };
}

export interface World {
  double: EmailDouble;
  port: EmailPortDouble;
  actor: ActorDouble;
  receipts: ReceiptsDouble;
  keys: FakeKeyStore;
  deps: EmailDeps;
}

/** The door's dependencies over the email double and the stubs, the clock at `now`. */
export function worldAt(now: string, double: EmailDouble = emailDouble()): World {
  const port = emailPortOf(double);
  const actor = actorDouble();
  const receipts = receiptsDouble();
  const keys = fakeKeyStore();
  const deps: EmailDeps = {
    email: port,
    actor,
    receipts,
    keys,
    bundleId: () => ({ hash: "a".repeat(64), build: 1 }),
    now: () => Date.parse(now),
  };
  return { double, port, actor, receipts, keys, deps };
}

/** The K-06 event the actor will rebuild from a hand-off: the sealed words put back where they came from. */
export async function unsealed(handoff: SealedHandoff, keys: FakeKeyStore): Promise<Json> {
  const { sealed, ...rest } = handoff.event;
  const event: Json = { ...rest };
  if (sealed === null) {
    event.body = null;
    return event;
  }
  const words = await openWords(
    sealed,
    keys.keyOf(handoff.event.handle),
    handoff.actorName,
    handoff.event.eventId,
  );
  event.body = words.body;
  if (typeof event.email === "object" && event.email !== null) {
    event.email = { ...(event.email as Json), subject: words.subject };
  }
  return event;
}

export interface Log {
  /** The spans written so far, in the order they were written. */
  spans(): Span[];
  /** Every log line written so far, as one string. */
  text(): string;
}

/** Captures every console.log line: the spans among them, and all of them as text. */
export function captureLog(): Log {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return {
    spans: () => spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0])),
    text: () => JSON.stringify(log.mock.calls),
  };
}
