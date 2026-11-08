// The local target against the gateway (T-465, "Proves it with": no key is read; the local target signs with the Linq
// double's hook). The gateway is runtime/src/gateway's Linq webhook entry (C-044), routed under BASE_PATH as
// runtime/src/index.ts routes it, with T-413's verifier given the run's made-up secret, and doors that store an event
// once, as the handle actor and the dispatcher do (the actor's Durable Object runs only in the Workers runtime). The
// text is K-06 v1's text-imessage.json, Alex's text from the master's sample cast. Run by `npm run test:e2e -- _driver`.

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLinqWebhookVerifier } from "../../../adapters/src/linq/webhook";
import type { InboundEvent } from "../../../adapters/src/linq/webhook/types";
import {
  DEFAULT_BUNDLE_ID,
  LINQ_WEBHOOK_PATH,
  handleLinqWebhook,
  type ActorHandoff,
  type GatewayDeps,
  type LinqPort,
  type SealedHandoff,
  type StoreAnswer,
  type VerifyWebhookResult,
} from "../../../runtime/src/gateway";
import { fakeKeyStore } from "../../../runtime/src/gateway/test-support";
import { CONTRACTS_ROOT } from "../../contract/_harness";
import {
  checkHops,
  checkRepeat,
  checkRun,
  createLocalTarget,
  makeTestWebhookSecret,
  readReceipt,
  schemaProblems,
  type Collected,
  type LocalTarget,
} from "./index";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** "whsec_" and 32 bytes in base64. */
const TEST_SECRET = /^whsec_[A-Za-z0-9+/]{43}=$/;

function json(...parts: string[]): unknown {
  return JSON.parse(readFileSync(path.join(CONTRACTS_ROOT, ...parts), "utf8"));
}

const textJson = json("inbound-event", "fixtures", "text-imessage.json");
const text = textJson as InboundEvent;
const outboxDelivered = json("outbox-effects", "fixtures", "outbox-delivered.json") as {
  row: Record<string, unknown>;
};
const sendTextRequest = (json("port-linq", "fixtures", "send-text.json") as { request: unknown }).request;

interface Door<T> {
  readonly written: T[];
  accept(handoff: T): Promise<StoreAnswer>;
}

/** A door that stores an event once and calls a known event id a duplicate, as the actor's and the dispatcher's do. */
function storeOnce<T extends { readonly event: { readonly eventId: string } }>(): Door<T> {
  const seen = new Set<string>();
  const written: T[] = [];
  return {
    written,
    accept(handoff) {
      if (seen.has(handoff.event.eventId)) return Promise.resolve("duplicate");
      seen.add(handoff.event.eventId);
      written.push(handoff);
      return Promise.resolve("written");
    },
  };
}

interface Gateway {
  readonly fetch: (request: Request) => Response | Promise<Response>;
  readonly actor: Door<SealedHandoff>;
  readonly receipts: Door<ActorHandoff>;
}

/** The gateway with T-413's verifier holding `secret`, answering at {basePath}/webhooks/linq; 404 elsewhere. */
function gatewayWith(secret: string, basePath = ""): Gateway {
  const verifier = createLinqWebhookVerifier({ secret: () => secret });
  // T-413's answer carries the K-06 event the gateway's port type also names (its own fields typed as strings).
  const linq: LinqPort = {
    verifyWebhook: async (request) => (await verifier.verifyWebhook(request)) as VerifyWebhookResult,
  };
  const actor = storeOnce<SealedHandoff>();
  const receipts = storeOnce<ActorHandoff>();
  const deps: GatewayDeps = {
    linq,
    actor,
    receipts,
    keys: fakeKeyStore(),
    bundleId: () => DEFAULT_BUNDLE_ID,
  };
  return {
    actor,
    receipts,
    fetch(request) {
      if (request.method === "POST" && new URL(request.url).pathname === `${basePath}${LINQ_WEBHOOK_PATH}`) {
        return handleLinqWebhook(request, deps, { environment: "local", version: "e2e" });
      }
      return new Response('{"ok":false,"error":"not_found"}', {
        status: 404,
        headers: { "x-trace-id": crypto.randomUUID() },
      });
    },
  };
}

function traceOf(collected: Collected): NonNullable<Collected["trace"]> {
  expect(collected.traceProblems).toEqual([]);
  if (collected.trace === null) throw new Error(`no trace ${collected.traceId}`);
  return collected.trace;
}

let target: LocalTarget | undefined;
afterEach(() => {
  target?.close();
  target = undefined;
});

describe("the local target", () => {
  it("sends K-06's text-imessage.json as a K-06 v1 event", () => {
    expect(schemaProblems("inbound-event/inbound-event.v1.schema.json", undefined, textJson)).toEqual([]);
  });

  it("signs a text with the Linq double's hook and posts it; the gateway's verifier takes it, and its trace is read back", async () => {
    // A made-up secret built at run time, as the double's own tests build theirs: never Linq's.
    const secret = ["whsec", btoa("rosie-e2e-driver-test-bytes-0001")].join("_");
    const gateway = gatewayWith(secret);
    target = createLocalTarget({ gateway: gateway.fetch, webhookSecret: secret });
    const sent = await target.sendEvent(text);
    expect(sent).toEqual({
      target: "local",
      eventId: "evt-alex-0001",
      traceId: expect.stringMatching(UUID) as string,
      gatewayStatus: 200,
    });
    expect(gateway.actor.written.map((handoff) => handoff.event.eventId)).toEqual(["evt-alex-0001"]);

    const trace = traceOf(await target.collect(sent.traceId));
    expect(trace.trace_id).toBe(sent.traceId);
    expect(checkHops(trace, ["receive"]).problems).toEqual([]);
    expect(readReceipt(trace)).toMatchObject({
      eventId: "evt-alex-0001",
      outcome: "ok",
      signatureValid: true,
      knownEventId: false,
      droppedAtReceipt: false,
    });
  });

  it("sends the same event again: the gateway drops it at receipt as a known event id, and stores it once", async () => {
    const secret = makeTestWebhookSecret();
    const gateway = gatewayWith(secret);
    target = createLocalTarget({ gateway: gateway.fetch, webhookSecret: secret });
    const first = await target.sendEvent(text);
    const again = await target.sendEvent(text);
    expect([first.gatewayStatus, again.gatewayStatus]).toEqual([200, 200]);
    expect(again.traceId).not.toBe(first.traceId);

    const firstTrace = traceOf(await target.collect(first.traceId));
    const repeatTrace = traceOf(await target.collect(again.traceId));
    expect(checkRepeat(firstTrace, repeatTrace)).toEqual([]);
    expect(readReceipt(repeatTrace)).toMatchObject({
      repeatedWebhook: true,
      droppedAtReceipt: true,
      hopsAfter: [],
    });
    expect(gateway.actor.written).toHaveLength(1);
  });

  it("posts under the Worker's BASE_PATH", async () => {
    const secret = makeTestWebhookSecret();
    const gateway = gatewayWith(secret, "/test");
    target = createLocalTarget({ gateway: gateway.fetch, webhookSecret: secret, basePath: "/test/" });
    expect((await target.sendEvent(text)).gatewayStatus).toBe(200);
    expect(gateway.actor.written).toHaveLength(1);
  });

  it("collects the parts the Linq double sent and the outbox rows written under the trace", async () => {
    const secret = makeTestWebhookSecret();
    target = createLocalTarget({
      gateway: gatewayWith(secret).fetch,
      webhookSecret: secret,
      outbox: (traceId) => [{ ...outboxDelivered, row: { ...outboxDelivered.row, traceId } }],
    });
    const sent = await target.sendEvent(text);
    // What the dispatcher does with the Linq double the target gives it.
    target.linq.sendPart(sendTextRequest);
    const collected = await target.collect(sent.traceId);
    expect(collected.parts.map((part) => [part.sent.idempotencyKey, part.outcome?.result])).toEqual([
      ["out-a7-03-alex/1/1", "accepted"],
    ]);
    expect(collected.outbox?.problems).toEqual([]);
    expect(collected.outbox?.rows.map((life) => life.row.traceId)).toEqual([sent.traceId]);
    const report = checkRun(collected, ["receive"]);
    expect(report.problems).toEqual([]);
    expect([report.outboxRows, report.parts.sends]).toEqual([1, 1]);
  });

  it("reads again until its condition holds, for the hops that log later", async () => {
    const secret = makeTestWebhookSecret();
    target = createLocalTarget({ gateway: gatewayWith(secret).fetch, webhookSecret: secret });
    const sent = await target.sendEvent(text);
    const linq = target.linq;
    setTimeout(() => linq.sendPart(sendTextRequest), 50);
    const collected = await target.collect(sent.traceId, {
      until: (reading) => reading.parts.length > 0,
      timeoutMs: 5_000,
      pollMs: 10,
    });
    expect(collected.parts).toHaveLength(1);
  });

  it("puts console.log back when closed", () => {
    const before = Object.getOwnPropertyDescriptor(console, "log");
    const local = createLocalTarget({ gateway: gatewayWith(makeTestWebhookSecret()).fetch });
    expect(Object.getOwnPropertyDescriptor(console, "log")).not.toEqual(before);
    local.close();
    expect(Object.getOwnPropertyDescriptor(console, "log")).toEqual(before);
  });
});

describe("no key is read by the local target", () => {
  it("makes a new webhook secret for each run from random bytes, in the form the double takes", () => {
    const local = createLocalTarget({ gateway: gatewayWith(makeTestWebhookSecret()).fetch });
    const other = createLocalTarget({ gateway: gatewayWith(makeTestWebhookSecret()).fetch });
    other.close();
    local.close();
    expect(local.webhookSecret).toMatch(TEST_SECRET);
    expect(other.webhookSecret).toMatch(TEST_SECRET);
    expect(local.webhookSecret).not.toBe(other.webhookSecret);
    expect(makeTestWebhookSecret()).not.toBe(makeTestWebhookSecret());
  });

  it("signs only with the run's own secret: a gateway that holds another refuses it, and stores nothing", async () => {
    const gateway = gatewayWith(makeTestWebhookSecret());
    target = createLocalTarget({ gateway: gateway.fetch });
    const sent = await target.sendEvent(text);
    expect(sent.gatewayStatus).toBe(401);
    expect(gateway.actor.written).toEqual([]);
    const trace = traceOf(await target.collect(sent.traceId));
    expect(readReceipt(trace)).toMatchObject({ outcome: "refused", signatureValid: false, hopsAfter: [] });
    expect(trace.spans[0].error_code).toBe("badSignature");
  });

  it("reads no key-named environment variable while it sends, repeats and collects", async () => {
    const reads: string[] = [];
    const environment = process.env;
    process.env = new Proxy(environment, {
      get(store, name, receiver): unknown {
        if (typeof name === "string") reads.push(name);
        return Reflect.get(store, name, receiver);
      },
    });
    try {
      const secret = makeTestWebhookSecret();
      target = createLocalTarget({ gateway: gatewayWith(secret).fetch, webhookSecret: secret });
      const sent = await target.sendEvent(text);
      await target.sendEvent(text);
      target.linq.sendPart(sendTextRequest);
      checkRun(await target.collect(sent.traceId), ["receive"]);
    } finally {
      process.env = environment;
    }
    expect(reads.filter((name) => /SECRET|KEY|TOKEN|PASS|WHSEC|CREDENTIAL|AUTH|LINQ/i.test(name))).toEqual(
      [],
    );
  });
});
