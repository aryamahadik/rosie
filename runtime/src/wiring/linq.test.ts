// T-552's join, hop 1 of D-017 (C-044; build prompt section 10, D-017; 02-contracts section 11, 'Webhook in, signature
// checked'), under Node (Vitest project "unit"): the composition root binds the gateway's verify port to @rosie/adapters'
// Linq verify (T-413), fed by the Linq double's signer (T-412), and builds the Linq webhook route behind the skeleton flag
// (T-185's release-flag read). Every webhook here is the double's, signed under a webhook secret made up for the run;
// double-signed-webhook.json (K-11 v1) is the one the card names. The doors after the gateway are doubles, since the
// handle's actor is hop 2 (T-553): a HandleActors namespace whose actors store an event once and record every time one is
// reached, the K-05 double behind the root's real sealing port (T-553: the key K-05 v1.2 handleSealingKey hands over), and
// the fake outbox store behind the receipt door. Test values only (rule 9).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLinqWebhookDouble } from "@rosie/adapters/linq/double-webhooks";
import doubleSigned from "@rosie/contracts/port-linq/fixtures/double-signed-webhook.json";
import { afterEach, describe, expect, it, vi } from "vitest";

import { actorNameOf, openWords, type SealedHandoff, type StoreAnswer } from "../gateway";
import type { Span } from "../trace";
import { spansOfLogLines } from "../trace/hop-check";
import {
  composeRoot,
  LINQ_WEBHOOK_SECRET,
  SKELETON_FLAG,
  workerRoot,
  type HandleActors,
  type LinqVerifyInputs,
} from "./index";
import {
  fakeFlags,
  skeletonFakes,
  testClock,
  testWebhookSecret,
  withSignatureChanged,
  type FakeFlags,
  type LinqInboundEvent,
  type SignedWebhook,
  type SkeletonFakes,
} from "./test-support";

const VARS = { ENVIRONMENT: "staging", GIT_SHA: "test-sha" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** double-signed-webhook.json's K-06 event: Maya's test phone asks about Saturday's class (K-06 test-phone-page.json). */
const EVENT = doubleSigned.request.event as LinqInboundEvent;
const MAYA_ACTOR = actorNameOf(EVENT.handle);
/** The fixture's own moment: the double signs its event as received then, and the gateway receives it then. */
const FIXTURE_NOW = Date.parse(doubleSigned.given.now);

type Line = Record<string, unknown>;

// ---- the doors after the gateway -------------------------------------------------------------------------------------

interface RecordingActors extends HandleActors<string> {
  /** Every actor name the namespace was asked for: each one an actor opened. */
  readonly opened: string[];
  /** Every hand-off an actor was given, in order. */
  readonly accepted: SealedHandoff[];
}

/** A HandleActors namespace whose actors store an event once (a known event id is a duplicate), as T-244's do. */
function recordingActors(): RecordingActors {
  const opened: string[] = [];
  const accepted: SealedHandoff[] = [];
  const seen = new Set<string>();
  return {
    opened,
    accepted,
    idFromName(name) {
      opened.push(name);
      return name;
    },
    get() {
      return {
        accept(handoff): Promise<StoreAnswer> {
          accepted.push(handoff);
          if (seen.has(handoff.event.eventId)) return Promise.resolve("duplicate");
          seen.add(handoff.event.eventId);
          return Promise.resolve("written");
        },
        fireClockRow: () => Promise.reject(new Error("no clock row fires on hop 1")),
        syncClocks: () => Promise.reject(new Error("no clock row arms on hop 1")),
      };
    },
  };
}

// ---- the rig: the root for the test environment, at the fixture's moment ---------------------------------------------

interface Rig {
  readonly fakes: SkeletonFakes;
  readonly actors: RecordingActors;
  readonly flags: FakeFlags;
  readonly route: (request: Request) => Promise<Response>;
  /** The log lines written so far, parsed. */
  lines(): Line[];
  spans(): Span[];
}

interface RigOptions {
  /** The flag store the root is handed: default one with the skeleton flag on; null hands it none. */
  readonly flags?: FakeFlags | null;
  /** What the root's verify is fed: default the run's made-up secret; "no secret" leaves it out. */
  readonly linq?: LinqVerifyInputs | "no secret";
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** The root composed for "test" at double-signed-webhook.json's moment, its Linq route, and what it reached. */
async function rig(options: RigOptions = {}): Promise<Rig> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const clock = testClock();
  await clock.advance(FIXTURE_NOW - clock.now());
  const fakes = skeletonFakes(clock);
  const actors = recordingActors();
  const flags = options.flags === undefined ? fakeFlags([SKELETON_FLAG]) : options.flags;
  const linq = options.linq ?? fakes.linqInputs;
  const root = composeRoot({
    environment: "test",
    sets: { fake: fakes.ports },
    actors,
    vars: VARS,
    clock,
    flags,
    handleKey: fakes.handleKeys.call,
    // The receipt door's store (T-562): a receipt that got past the verify would be marked here.
    outboxCalls: fakes.dispatch.outbox,
    sendStateCall: fakes.dispatch.sendState,
    ...(linq === "no secret" ? {} : { linq }),
  });
  const lines = (): Line[] => spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Line);
  return {
    fakes,
    actors,
    flags: flags ?? fakeFlags(),
    route: (request) => root.linqWebhook(request),
    lines,
    spans: () => spansOfLogLines(spy.mock.calls.map((call: unknown[]) => call[0])),
  };
}

/** The webhook as Linq posts it to {BASE_PATH}/webhooks/linq: the three headers and the raw body. */
function post(webhook: SignedWebhook): Request {
  return new Request("https://rosie.test/test/webhooks/linq", {
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

/** double-signed-webhook.json's webhook, signed by the rig's Linq double (its first, so its envelope is the fixture's). */
function doubleSignedWebhook(fakes: SkeletonFakes): Promise<SignedWebhook> {
  return fakes.webhooks.sign({ event: EVENT, partKey: doubleSigned.request.partKey });
}

/** Nothing past the gateway was reached: no actor opened, no key asked, no receipt marked. */
function expectNothingWritten(run: Rig): void {
  expect(run.actors.opened).toEqual([]);
  expect(run.actors.accepted).toEqual([]);
  expect(run.fakes.handleKeys.requests).toEqual([]);
  expect(run.fakes.dispatch.partMarks).toEqual([]);
}

// ---- the tests -------------------------------------------------------------------------------------------------------

describe("hop 1 joined: the Linq double's signed webhook verified at the gateway through the K-11 port", () => {
  it("double-signed-webhook.json: 200 within 1 s, one gateway span, its event handed to Maya's actor once, sealed", async () => {
    const run = await rig();
    const webhook = await doubleSignedWebhook(run.fakes);
    // The double gives the fixture's webhook: its id, timestamp and Linq-form body (the signature is made now).
    expect({ webhookId: webhook.webhookId, timestamp: webhook.timestamp, raw: webhook.raw }).toEqual({
      webhookId: doubleSigned.outcome.webhook.webhookId,
      timestamp: doubleSigned.outcome.webhook.timestamp,
      raw: doubleSigned.outcome.webhook.raw,
    });

    const started = performance.now();
    const response = await run.route(post(webhook));
    const elapsed = performance.now() - started;

    expect(response.status).toBe(200);
    expect(elapsed).toBeLessThan(1000);
    const traceId = response.headers.get("x-trace-id");
    expect(traceId).toMatch(UUID);
    expect(await response.json()).toEqual({ ok: true, trace_id: traceId });
    expect(run.flags.reads).toEqual([{ name: SKELETON_FLAG, subject: undefined }]);

    // Two gateway spans, in that order: the receive hop (verified, a new event id, answered 200), then the scrub hop.
    const spans = run.spans();
    expect(spans.map((span) => span.hop)).toEqual(["receive", "scrub"]);
    expect(spans[0]).toMatchObject({
      trace_id: traceId,
      hop: "receive",
      outcome: "ok",
      provider: "linq",
      event_id: EVENT.eventId,
      got: { kind: "text", service: "imessage" },
      decided: { signatureValid: true, knownEventId: false, answered: 200 },
    });
    expect(spans[1]).toMatchObject({ trace_id: traceId, hop: "scrub", outcome: "ok" });

    // The adapter's parse gave the fixture's event back, which the gateway sealed and handed to Maya's actor once.
    expect(run.actors.opened).toEqual([MAYA_ACTOR]);
    expect(run.actors.accepted).toHaveLength(1);
    const handoff = run.actors.accepted[0];
    if (handoff === undefined) throw new Error("no hand-off");
    expect(handoff).toMatchObject({ actorName: MAYA_ACTOR, partKey: null, traceId });
    const kept = Object.fromEntries(
      Object.entries(EVENT).filter(([field]) => !["body", "receivedAt", "traceId"].includes(field)),
    );
    expect(handoff.event).toMatchObject({ ...kept, traceId });
    expect(handoff.event).not.toHaveProperty("body");
    expect(Math.abs(Date.parse(String(handoff.event.receivedAt)) - FIXTURE_NOW)).toBeLessThan(1000);
    const sealed = handoff.event.sealed;
    if (sealed === null) throw new Error("the words were not sealed");
    const key = run.fakes.handleKeys.keyOf(EVENT.handle.address);
    const words = await openWords(sealed, key, MAYA_ACTOR, EVENT.eventId);
    expect(words.body).toBe(EVENT.body);
  });

  it("a bad signature (one byte changed): 401, a refused gateway span, and nothing written", async () => {
    const run = await rig();
    const webhook = withSignatureChanged(await doubleSignedWebhook(run.fakes));

    const response = await run.route(post(webhook));

    expect(response.status).toBe(401);
    const traceId = response.headers.get("x-trace-id");
    expect(await response.json()).toEqual({ ok: false, error: "unauthorized", trace_id: traceId });
    const spans = run.spans();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      trace_id: traceId,
      hop: "receive",
      outcome: "refused",
      error_code: "badSignature",
      decided: { signatureValid: false, answered: 401 },
    });
    expect(spans[0]).not.toHaveProperty("event_id");
    expectNothingWritten(run);
  });

  it("a webhook signed under another secret, or outside the 300 s window: 401, and nothing written", async () => {
    const run = await rig();
    const stranger = createLinqWebhookDouble({ secret: testWebhookSecret() });
    const stale = await run.fakes.webhooks.sign({ event: EVENT, partKey: null }, { stale: true });

    const other = await run.route(post(await stranger.sign({ event: EVENT, partKey: null })));
    const late = await run.route(post(stale));

    expect([other.status, late.status]).toEqual([401, 401]);
    expect(run.spans().map((span) => span.error_code)).toEqual(["badSignature", "staleTimestamp"]);
    expectNothingWritten(run);
  });

  it("the same webhook twice: 200 both times, written once, the second span dropped", async () => {
    const run = await rig();
    const webhook = await doubleSignedWebhook(run.fakes);

    const first = await run.route(post(webhook));
    const again = await run.route(post(webhook));

    expect([first.status, again.status]).toEqual([200, 200]);
    expect(run.actors.accepted.map((handoff) => handoff.event.eventId)).toEqual([
      EVENT.eventId,
      EVENT.eventId,
    ]);
    expect(run.spans().map((span) => span.outcome)).toEqual(["ok", "ok", "dropped"]);
  });

  it("with no webhook secret set: 503 so Linq sends it again, nothing verified or written, the secret named only", async () => {
    const run = await rig({ linq: "no secret" });
    const webhook = await doubleSignedWebhook(run.fakes);

    const response = await run.route(post(webhook));

    expect(response.status).toBe(503);
    expect(run.spans()).toHaveLength(1);
    expect(run.spans()[0]).toMatchObject({ outcome: "failed", error_code: "verifyUnavailable" });
    expect(run.lines()).toContainEqual(
      expect.objectContaining({ msg: "gateway_failed", stage: "verify", error: "MissingSecretError" }),
    );
    expectNothingWritten(run);
  });

  it("writes no secret, signature, body or phone number to any log line", async () => {
    const secret = testWebhookSecret();
    const run = await rig({
      linq: { webhookSecret: () => secret },
    });
    const webhooks = createLinqWebhookDouble({ secret });
    const webhook = await webhooks.sign({ event: EVENT, partKey: null });

    expect((await run.route(post(webhook))).status).toBe(200);
    expect((await run.route(post(withSignatureChanged(webhook)))).status).toBe(401);

    const text = JSON.stringify(run.lines());
    for (const value of [
      secret,
      secret.slice("whsec_".length),
      webhook.signature,
      EVENT.body ?? "",
      "5555550104",
    ]) {
      expect(text).not.toContain(value);
    }
  });
});

/** The ways the skeleton flag reads off, each with the flag store the root is handed. */
const OFF: readonly (readonly [string, () => FakeFlags | null])[] = [
  ["the skeleton flag never set (no row reads off)", () => fakeFlags()],
  [
    "the skeleton flag set off",
    () => {
      const flags = fakeFlags([SKELETON_FLAG]);
      flags.set(SKELETON_FLAG, false);
      return flags;
    },
  ],
  ["no flags bound (the Worker's, until staging has its database)", () => null],
];

describe("the Linq webhook route behind the skeleton flag", () => {
  it.each(OFF)(
    "%s: 404, the body unread, nothing verified, no trace and no actor opened",
    async (_name, flagsOf) => {
      const run = await rig({ flags: flagsOf() });
      const request = post(await doubleSignedWebhook(run.fakes));

      const response = await run.route(request);

      expect(response.status).toBe(404);
      const traceId = response.headers.get("x-trace-id");
      expect(traceId).toMatch(UUID);
      expect(await response.json()).toEqual({ ok: false, error: "not_found", trace_id: traceId });
      expect(request.bodyUsed).toBe(false);
      expect(run.spans()).toEqual([]);
      expect(run.lines()).toEqual([
        {
          level: "info",
          msg: "not_found",
          trace_id: traceId,
          flag: SKELETON_FLAG,
          environment: VARS.ENVIRONMENT,
          version: VARS.GIT_SHA,
        },
      ]);
      expectNothingWritten(run);
    },
  );

  it("is read at each webhook: turning the flag off (D-017's rollback) makes the next webhook 404", async () => {
    const run = await rig();

    const before = await run.route(post(await doubleSignedWebhook(run.fakes)));
    run.flags.set(SKELETON_FLAG, false);
    const after = await run.route(post(await run.fakes.sign({ ...EVENT, eventId: "evt-double-0104-0002" })));

    expect([before.status, after.status]).toEqual([200, 404]);
    expect(run.flags.reads.map((read) => read.name)).toEqual([SKELETON_FLAG, SKELETON_FLAG]);
    expect(run.actors.opened).toEqual([MAYA_ACTOR]);
  });

  it("a flag store that cannot answer: 503 so Linq sends it again, with nothing read or reached", async () => {
    const flags = fakeFlags([SKELETON_FLAG]);
    flags.failWith = new Error("the database is down");
    const run = await rig({ flags });
    const request = post(await doubleSignedWebhook(run.fakes));

    const response = await run.route(request);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: "unavailable" });
    expect(request.bodyUsed).toBe(false);
    expect(run.spans()).toEqual([]);
    expect(run.lines()).toEqual([
      expect.objectContaining({ msg: "gateway_failed", stage: "skeletonFlag", error: "Error" }),
    ]);
    expectNothingWritten(run);
  });
});

describe("the Worker's root", () => {
  it("binds the Linq verify on staging, reading LINQ_WEBHOOK_SECRET by name at each call", async () => {
    const secret = testWebhookSecret();
    const env = { ENVIRONMENT: "staging", BASE_PATH: "/test", DB_SCHEMA: "", [LINQ_WEBHOOK_SECRET]: secret };
    const root = workerRoot(env);
    const now = new Date();
    const receivedAt = now.toISOString().replace(/[.][0-9]+Z$/, "Z");
    const webhook = await createLinqWebhookDouble({ secret }).sign({
      event: { ...EVENT, receivedAt },
      partKey: null,
    });

    const answer = await root.ports.linqVerify.verifyWebhook({
      ...webhook,
      receivedAt: now.toISOString(),
      traceId: "4f1c2b7a-9d3e-4c5f-8a6b-1e2d3c4b5a69",
    });

    expect(answer).toMatchObject({ result: "event", partKey: null, event: { eventId: EVENT.eventId } });
    expect(root.bindings.find((binding) => binding.port === "linqVerify")?.implementation).toBe("real");
  });

  it("binds no release flags yet: its Linq route answers 404, reaching nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = workerRoot({ ENVIRONMENT: "staging", BASE_PATH: "/test", DB_SCHEMA: "" });
    const request = new Request("https://rosie.test/test/webhooks/linq", { method: "POST", body: "{}" });

    const response = await root.linqWebhook(request);

    expect(response.status).toBe(404);
    expect(request.bodyUsed).toBe(false);
  });

  it("never imports the Linq double: only test files and test-support name it", () => {
    const folder = path.dirname(fileURLToPath(import.meta.url));
    const workerFiles = readdirSync(folder).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "test-support.ts",
    );

    expect(workerFiles.length).toBeGreaterThan(5);
    for (const file of workerFiles) {
      expect(readFileSync(path.join(folder, file), "utf8"), file).not.toMatch(/linq\/double/);
    }
  });
});
