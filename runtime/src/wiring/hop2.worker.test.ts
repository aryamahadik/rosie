// T-553's join, hop 2 of D-017 (C-044, C-046; build prompt section 10, D-017; 02-contracts section 11, 'Sealed event'),
// in the Workers runtime. The composition root is composed for the test environment as T-552's tests compose it, with the
// HandleActor namespace (exports.HandleActor in the pool, standing in for env.HANDLE_ACTOR until T-566 binds it on
// staging) and the skeleton flag on, and each webhook goes in through root.linqWebhook. K-06's text-imessage.json, signed
// by the Linq double, is verified, scrubbed, sealed under the handle's key and handed to that handle's Durable Object: one
// entry in its ordered inbox, the words only sealed (unreadable without the key), one receive span, the gateway's (T-1108);
// duplicate-event.json adds no entry and is answered 200. The key is the one the root's real sealing port gets from K-05
// v1.2 handleSealingKey, here the K-05 double answering as the handle-key-*.json fixtures (DL-313 ruling 4, DL-324): a
// key object that cannot be exported. With no K-05 call handed in, as on staging until T-567 binds its database, the
// verified text is answered 503 and nothing reaches the inbox. The actor's own ports are not installed: hop 2 ends at the
// inbox (the safety read is T-554's). Then the Worker's wiring (DL-313 ruling 2): its actor ports are wired on its first
// request where HANDLE_ACTOR is bound, and nothing is wired where it is not. Test values only (rule 9).
import duplicateFixture from "@rosie/contracts/inbound-event/fixtures/duplicate-event.json";
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { HandleActor } from "../actor";
import type { InboxEntry } from "../actor/inbox";
import { actorNameOf, DEFAULT_BUNDLE_ID, openWords, type SealedHandoff } from "../gateway";
import worker from "../index";
import type { Span } from "../trace";
import { spansOfLogLines, spansOfTrace } from "../trace/hop-check";
import {
  composeRoot,
  SEALING_WRAP_KEY,
  SKELETON_FLAG,
  unwireWorker,
  wiredRoot,
  WiringError,
  workerRoot,
  type HandleActors,
} from "./index";
import {
  fakeFlags,
  skeletonFakes,
  type LinqInboundEvent,
  type SignedWebhook,
  type SkeletonFakes,
} from "./test-support";

type Namespace = DurableObjectNamespace<HandleActor>;

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

/** The HandleActor namespace as the root takes it. */
function handleActors(): HandleActors<DurableObjectId> {
  const ns = namespace();
  return { idFromName: (name) => ns.idFromName(name), get: (id) => ns.get(id) };
}

/** The handle's ordered inbox, read inside its Durable Object (HandleActor.readInbox). */
function inboxOf(actorName: string): Promise<InboxEntry[]> {
  const stub = namespace().get(namespace().idFromName(actorName));
  return runInDurableObject(stub, (actor: HandleActor) => actor.readInbox());
}

const TEXT = structuredClone(textFixture) as unknown as LinqInboundEvent;
const REPEAT = structuredClone(duplicateFixture) as unknown as LinqInboundEvent;
const ACTOR = actorNameOf(TEXT.handle);
const BODY = TEXT.body ?? "";

/** The handle actor's own receive span, which it writes when the gateway's hand-off reaches it. */
const actorSpan = (span: Span): boolean => span.hop === "receive" && span.got?.door === "handleActor";

/** The webhook as Linq posts it to {BASE_PATH}/webhooks/linq: the three headers and the raw body. */
function webhookRequest(webhook: SignedWebhook): Request {
  return new Request(`https://rosie.test${env.BASE_PATH}/webhooks/linq`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": webhook.webhookId,
      "webhook-timestamp": webhook.timestamp,
      "webhook-signature": webhook.signature,
    },
    body: webhook.raw,
  });
}

interface Rig {
  readonly fakes: SkeletonFakes;
  /** Signs one K-06 event with the Linq double and posts it through root.linqWebhook. */
  post(event: LinqInboundEvent): Promise<Response>;
  spans(): Span[];
}

/** The root for "test" with the HandleActor namespace and the skeleton flag on; its actor ports are not installed. */
function rig(log: MockInstance): Rig {
  const fakes = skeletonFakes();
  const root = composeRoot({
    environment: "test",
    sets: { fake: fakes.ports },
    actors: handleActors(),
    vars: env,
    clock: fakes.clock,
    linq: fakes.linqInputs,
    handleKey: fakes.handleKeys.call,
    // The chat-open port (T-1213) over its K-05 double: the text opens its number's chat before the actor is reached.
    chatOpenCall: fakes.dispatch.openChat,
    flags: fakeFlags([SKELETON_FLAG]),
  });
  return {
    fakes,
    post: async (event) => root.linqWebhook(webhookRequest(await fakes.sign(event))),
    spans: () => spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0])),
  };
}

/** The log lines written so far, parsed. */
function linesOf(log: MockInstance): Record<string, unknown>[] {
  return log.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

function traceIdOf(response: Response): string {
  const traceId = response.headers.get("x-trace-id");
  if (traceId === null) throw new Error("the gateway answered with no trace id");
  return traceId;
}

afterEach(async () => {
  vi.restoreAllMocks();
  unwireWorker();
  await reset();
});

describe("hop 2 joined: a verified text reaches the HandleActor through its namespace, sealed under the handle's key", () => {
  it("text-imessage.json: 200, one entry in the handle's ordered inbox, its words sealed and unreadable without the key, one receive span, the gateway's, saying it was sealed to its actor", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const run = rig(log);

    const response = await run.post(TEXT);

    expect(response.status).toBe(200);
    const traceId = traceIdOf(response);
    const inbox = await inboxOf(ACTOR);
    expect(inbox).toHaveLength(1);
    const [entry] = inbox;
    if (entry === undefined) throw new Error("no inbox entry");
    expect(entry).toMatchObject({ partKey: null, traceId, startsTurn: true });
    expect(entry.event).toMatchObject({ eventId: TEXT.eventId, kind: "text", handle: TEXT.handle });
    expect(entry.event).not.toHaveProperty("body");
    expect(JSON.stringify(entry)).not.toContain(BODY);
    const sealed = entry.event.sealed;
    if (sealed === null) throw new Error("the words were not sealed");
    // K-05 was asked once, for this handle, with new ids and the wrapping key by its name; its key is a key object.
    expect(run.fakes.handleKeys.requests).toEqual([
      {
        handle: TEXT.handle,
        newHandleId: expect.stringMatching(/^handle-/) as unknown,
        newPersonId: expect.stringMatching(/^person-/) as unknown,
        wrappingKeyName: SEALING_WRAP_KEY,
      },
    ]);
    const key = run.fakes.handleKeys.keyOf(TEXT.handle.address);
    expect({ type: key.type, extractable: key.extractable }).toEqual({ type: "secret", extractable: false });
    await expect(
      openWords(sealed, crypto.getRandomValues(new Uint8Array(32)), ACTOR, TEXT.eventId),
    ).rejects.toThrow();
    expect((await openWords(sealed, key, ACTOR, TEXT.eventId)).body).toBe(BODY);

    // K-08 trace-skeleton.json: one receive span per text, the gateway's, at seq 1, which says the text was sealed and
    // written to its actor (decided.sealedToActor), then scrub at seq 2. The actor writes no span of its own for the
    // hand-off (T-1108): the hand-off is the receive span's, which starts before the scrub and ends after it.
    const trace = spansOfTrace(run.spans(), traceId);
    const gateway = trace.filter((span) => !actorSpan(span));
    const actor = trace.filter(actorSpan);
    expect(gateway.map((span) => [span.seq, span.hop, span.outcome])).toEqual([
      [1, "receive", "ok"],
      [2, "scrub", "ok"],
    ]);
    expect(actor).toHaveLength(0);
    const [receive, scrub] = gateway;
    if (receive === undefined || scrub === undefined) throw new Error("no receive or scrub span");
    expect(receive.decided).toMatchObject({ signatureValid: true, knownEventId: false, sealedToActor: true });
    expect(Date.parse(scrub.at)).toBeGreaterThanOrEqual(Date.parse(receive.at));
    expect(Date.parse(receive.at) + receive.ms).toBeGreaterThanOrEqual(Date.parse(scrub.at) + scrub.ms);
    expect(JSON.stringify(run.spans())).not.toContain(BODY);
  });

  it("duplicate-event.json after it: answered 200, no second inbox entry, the gateway's span dropped as a known event id", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const run = rig(log);
    expect(REPEAT.eventId).toBe(TEXT.eventId);

    const first = await run.post(TEXT);
    const again = await run.post(REPEAT);

    expect([first.status, again.status]).toEqual([200, 200]);
    const inbox = await inboxOf(ACTOR);
    expect(inbox.map((entry) => [entry.event.eventId, entry.traceId])).toEqual([
      [TEXT.eventId, traceIdOf(first)],
    ]);
    const repeat = spansOfTrace(run.spans(), traceIdOf(again)).filter((span) => !actorSpan(span));
    expect(repeat.map((span) => [span.hop, span.outcome])).toEqual([["receive", "dropped"]]);
    expect(repeat[0]?.decided).toMatchObject({ signatureValid: true, knownEventId: true, answered: 200 });
  });

  it("with no K-05 call handed in (staging's root until T-567 binds its database): the verified text is answered 503 and nothing reaches the inbox", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fakes = skeletonFakes();
    const root = composeRoot({
      environment: "staging",
      actors: handleActors(),
      vars: env,
      clock: fakes.clock,
      linq: fakes.linqInputs,
      flags: fakeFlags([SKELETON_FLAG]),
    });

    const response = await root.linqWebhook(webhookRequest(await fakes.sign(TEXT)));

    expect(response.status).toBe(503);
    expect(await inboxOf(ACTOR)).toEqual([]);
    expect(linesOf(log)).toContainEqual(
      expect.objectContaining({ msg: "gateway_failed", error: "NoDatabaseError" }),
    );
    expect(JSON.stringify(linesOf(log))).not.toContain(BODY);
  });
});

describe("the Worker's wiring (DL-313 ruling 2): its actor ports are wired on its first request, only where HANDLE_ACTOR is bound", () => {
  /** The Worker's env as the pool gives it (wrangler.jsonc's staging, no HANDLE_ACTOR), with or without the binding. */
  function workerEnv(bound: boolean): Cloudflare.Env {
    const vars = { ENVIRONMENT: env.ENVIRONMENT, BASE_PATH: env.BASE_PATH, DB_SCHEMA: env.DB_SCHEMA };
    if (!bound) return vars;
    return {
      ...vars,
      HANDLE_ACTOR: (exports as unknown as { HandleActor: DurableObjectNamespace }).HandleActor,
    };
  }

  const health = (): Request => new Request(`https://rosie.test${env.BASE_PATH}/health`);

  /** A hand-off with no event id: the handle's actor refuses it itself, before anything is written. */
  const noEventId: SealedHandoff = {
    event: {
      eventId: "",
      provider: "linq",
      kind: "text",
      service: "imessage",
      traceId: "4f1c2b7a-9d3e-4c5f-8a6b-1e2d3c4b5a69",
      handle: TEXT.handle,
      sealed: null,
    },
    partKey: null,
    traceId: "4f1c2b7a-9d3e-4c5f-8a6b-1e2d3c4b5a69",
    bundleId: DEFAULT_BUNDLE_ID,
    actorName: ACTOR,
  };

  it("with HANDLE_ACTOR bound: the first request wires them once (none at module load), and the gateway's door reaches the actor", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const bound = workerEnv(true);
    expect(wiredRoot()).toBeNull();
    const root = workerRoot(bound);
    const install = vi.spyOn(root, "install");

    const first = await worker.fetch(health(), bound, createExecutionContext());
    const second = await worker.fetch(health(), bound, createExecutionContext());

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(install).toHaveBeenCalledTimes(1);
    expect(wiredRoot()).toBe(root);
    await expect(root.gateway.actor.accept(noEventId)).rejects.toThrow("noEventId");
  });

  it("with no HANDLE_ACTOR (the pool's env, and staging's until T-566): nothing is wired, and the gateway's door to the actor stays closed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const unbound = workerEnv(false);
    const root = workerRoot(unbound);
    const install = vi.spyOn(root, "install");

    const response = await worker.fetch(health(), unbound, createExecutionContext());

    expect(response.status).toBe(200);
    expect(install).not.toHaveBeenCalled();
    expect(wiredRoot()).toBeNull();
    await expect(root.gateway.actor.accept(noEventId)).rejects.toThrow(
      new WiringError("no HandleActor namespace is bound here"),
    );
  });
});
