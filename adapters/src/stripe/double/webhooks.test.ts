// T-422: the Stripe double's signed webhooks against K-14 v1's fixtures and schema. No network, no key: the signing
// secrets are fictional ones built here, never Stripe's.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyHmacSha256 } from "../../shared/hmac";
import { createStripeDouble } from "./double";
import type { Account, SignedWebhook, WebhookEvent } from "./types";
import {
  createStripeWebhookDouble,
  STALE_BY_SECONDS,
  StripeDoubleWebhookError,
  type StripeWebhookDouble,
} from "./webhooks";

const CONTRACTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "contracts",
);
const FIXTURES = path.join(CONTRACTS, "port-stripe", "fixtures");
const SCHEMA_ID = "https://rosie.invalid/contracts/port-stripe/port-stripe.v1.schema.json";

// Fictional secrets, one per endpoint (rule 7: never Stripe's, never in a fixture).
const SECRETS = {
  rosfield: "whsec_TestOnlyRosfieldEndpointSecret0001",
  businesses: "whsec_TestOnlyBusinessesEndpointSecret0002",
};

type Json = Record<string, unknown>;
interface Fixture {
  call: string;
  given: { now: string; note: string };
  request: Json;
  outcome: Json;
}

const readFixture = (file: string): Fixture =>
  JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8")) as Fixture;
const INDEX = (
  JSON.parse(readFileSync(path.join(FIXTURES, "index.json"), "utf8")) as {
    fixtures: { file: string; def: string; expect: string }[];
  }
).fixtures;

let ajv: Ajv2020;
beforeAll(() => {
  ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  const folders = readdirSync(CONTRACTS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !["scripts", "generated", "node_modules"].includes(entry.name))
    .map((entry) => entry.name);
  for (const folder of folders) {
    for (const file of readdirSync(path.join(CONTRACTS, folder))) {
      if (!file.endsWith(".schema.json")) continue;
      ajv.addSchema(JSON.parse(readFileSync(path.join(CONTRACTS, folder, file), "utf8")) as object);
    }
  }
});

function check(def: string): ValidateFunction {
  const found = ajv.getSchema(`${SCHEMA_ID}#/$defs/${def}`);
  if (found === undefined) throw new Error(`the schema has no ${def}`);
  return found;
}

/** What the gateway's check does with a signed webhook: the signature over "<t>.<raw>" and the 300 s window. */
async function gatewayCheck(
  webhook: SignedWebhook,
  secrets = SECRETS,
): Promise<"ok" | "badHeader" | "staleTimestamp" | "badSignature"> {
  const parts = /^t=([0-9]+),v1=([0-9a-f]+)$/.exec(webhook.signatureHeader);
  if (parts === null) return "badHeader";
  const [, t, v1] = parts;
  if (t === undefined || v1 === undefined) return "badHeader";
  if (Math.abs(Date.parse(webhook.receivedAt) / 1000 - Number(t)) > 300) return "staleTimestamp";
  const good = await verifyHmacSha256(secrets[webhook.endpoint], `${t}.${webhook.raw}`, v1);
  return good ? "ok" : "badSignature";
}

const rawOf = (webhook: { raw: string }): Json => JSON.parse(webhook.raw) as Json;

function double(): StripeWebhookDouble {
  return createStripeWebhookDouble({ secrets: SECRETS });
}

/** The parts of a body that the port event cannot hold, which the adapter drops anyway (README 'Webhook events'). */
function dropWhatThePortDrops(body: Json): Json {
  const copy = structuredClone(body);
  const object = (copy.data as { object: Json }).object;
  if (object.object === "payment_intent") {
    delete object.customer;
    delete object.setup_future_usage;
  }
  return copy;
}

describe("signing, as the gateway checks it", () => {
  const event: WebhookEvent = {
    eventId: "stripe-evt-double-0001",
    kind: "paymentSucceeded",
    stripeType: "payment_intent.succeeded",
    account: { kind: "business", accountId: "stripe-acct-demo-lees-barbershop" },
    testMode: true,
    occurredAt: "2026-11-06T16:20:00Z",
    effectId: "eff-alex-color-correction-pay-link",
    payload: {
      paymentId: "stripe-payment-demo-0007",
      chargeId: "stripe-charge-demo-0007",
      amount: { cents: 2500, currency: "USD" },
      paymentMethodId: "stripe-card-demo-alex-2",
    },
  };

  it("signs t=<seconds>,v1=<hex> over <t>.<raw>, inside the window, under the endpoint's own secret", async () => {
    const webhook = await double().sign(event);
    expect(webhook.signatureHeader).toMatch(/^t=1793982001,v1=[0-9a-f]{64}$/);
    expect(webhook.endpoint).toBe("businesses");
    expect(webhook.receivedAt).toBe("2026-11-06T16:20:01Z");
    expect(await gatewayCheck(webhook)).toBe("ok");
    // The other endpoint's secret does not check it.
    expect(await gatewayCheck({ ...webhook, endpoint: "rosfield" })).toBe("badSignature");
    expect(await gatewayCheck({ ...webhook, raw: `${webhook.raw} ` })).toBe("badSignature");
  });

  it("holds no secret in what it gives", async () => {
    const webhook = await double().sign(event);
    const text = JSON.stringify(webhook);
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/whsec_|sk_(live|test)_/);
  });

  it("changes one byte of the signature on request: no v1 matches", async () => {
    const good = await double().sign(event);
    const changed = await double().sign(event, { oneByteChanged: true });
    expect(changed.raw).toBe(good.raw);
    expect(changed.signatureHeader).not.toBe(good.signatureHeader);
    expect(changed.signatureHeader).toMatch(/^t=1793982001,v1=[0-9a-f]{64}$/);
    expect(await gatewayCheck(changed)).toBe("badSignature");
  });

  it("signs outside the 300 s window on request, with a signature that is right for that moment", async () => {
    const stale = await double().sign(event, { stale: true });
    expect(await gatewayCheck(stale)).toBe("staleTimestamp");
    expect(stale.signatureHeader).toContain(`t=${String(1793982001 - STALE_BY_SECONDS)}`);
    const justInside = await double().sign(event, { stale: 300 });
    expect(await gatewayCheck(justInside)).toBe("ok");
    const t = /t=([0-9]+)/.exec(stale.signatureHeader)?.[1] ?? "";
    const v1 = /v1=([0-9a-f]+)/.exec(stale.signatureHeader)?.[1] ?? "";
    expect(await verifyHmacSha256(SECRETS.businesses, `${t}.${stale.raw}`, v1)).toBe(true);
  });

  it("counts a trace id per webhook, or takes the one asked for", async () => {
    const signer = double();
    expect((await signer.sign(event)).traceId).toBe("trace-stripe-double-0001");
    expect((await signer.sign(event)).traceId).toBe("trace-stripe-double-0002");
    expect((await signer.sign(event, { traceId: "trace-mine" })).traceId).toBe("trace-mine");
  });

  it("refuses to sign what it cannot: a bad secret, a bad time, an event with no payload, an event on the wrong endpoint", async () => {
    expect(() =>
      createStripeWebhookDouble({ secrets: { rosfield: "short", businesses: SECRETS.businesses } }),
    ).toThrow(StripeDoubleWebhookError);
    await expect(double().sign({ ...event, occurredAt: "yesterday" })).rejects.toMatchObject({
      code: "badTime",
    });
    await expect(double().sign({ ...event, kind: "nope" as WebhookEvent["kind"] })).rejects.toMatchObject({
      code: "unknownKind",
    });
    await expect(
      double().signUnused({
        endpoint: "rosfield",
        eventId: "stripe-evt-x",
        stripeType: "customer.created",
        account: { kind: "business", accountId: "stripe-acct-demo-a" },
        occurredAt: event.occurredAt,
      }),
    ).rejects.toMatchObject({ code: "wrongEndpoint" });
  });
});

describe("every webhook fixture the double can make", () => {
  const verifies = INDEX.filter(
    (entry) => entry.def === "verifyWebhook.exchange" && entry.expect === "accept",
  );

  for (const entry of verifies) {
    const fx = readFixture(entry.file);
    if (fx.outcome.result === "event") {
      it(`signs ${entry.file}'s event into the fixture's own body`, async () => {
        const event = fx.outcome.event as WebhookEvent;
        const signed = await double().sign(event, { receivedAt: fx.request.receivedAt as string });
        expect(signed.endpoint).toBe(fx.request.endpoint);
        expect(rawOf(signed)).toEqual(dropWhatThePortDrops(rawOf(fx.request as { raw: string })));
        expect(/t=([0-9]+)/.exec(signed.signatureHeader)?.[1]).toBe(
          /t=([0-9]+)/.exec(fx.request.signatureHeader as string)?.[1],
        );
        expect(await gatewayCheck(signed)).toBe("ok");
      });
    } else if (fx.outcome.result === "ignored") {
      it(`signs an event of a type Rosie does not use, as ${entry.file} has it`, async () => {
        const body = rawOf(fx.request as { raw: string });
        const signed = await double().signUnused(
          {
            endpoint: fx.request.endpoint as "businesses",
            eventId: body.id as string,
            stripeType: fx.outcome.stripeType as string,
            account: { kind: "business", accountId: body.account as string },
            occurredAt: new Date((body.created as number) * 1000).toISOString().replace(/[.][0-9]+Z$/, "Z"),
          },
          { receivedAt: fx.request.receivedAt as string },
        );
        const got = rawOf(signed);
        for (const field of ["id", "object", "api_version", "account", "created", "livemode", "type"])
          expect(got[field], field).toEqual(body[field]);
        expect(await gatewayCheck(signed)).toBe("ok");
      });
    } else {
      it(`makes ${entry.file}'s rejection: ${String(fx.outcome.reason)}`, async () => {
        // verify-bad-signature.json: webhook-event.json's event with one byte of its signature changed.
        const event = (readFixture("webhook-event.json").outcome as { event: WebhookEvent }).event;
        const signed = await double().sign(event, {
          receivedAt: fx.request.receivedAt as string,
          oneByteChanged: true,
        });
        expect(await gatewayCheck(signed)).toBe(fx.outcome.reason);
        expect(rawOf(signed)).toEqual(dropWhatThePortDrops(rawOf(fx.request as { raw: string })));
      });
    }
  }

  it("signs double-signed-webhook.json: the same body, the same time, and a signature that checks", async () => {
    const fx = readFixture("double-signed-webhook.json");
    const signed = await double().sign((fx.request as { event: WebhookEvent }).event);
    const wanted = (fx.outcome as { webhook: Json }).webhook;
    expect(signed.endpoint).toBe(wanted.endpoint);
    expect(signed.receivedAt).toBe(wanted.receivedAt);
    expect(signed.traceId).toBe(wanted.traceId);
    expect(rawOf(signed)).toEqual(dropWhatThePortDrops(rawOf(wanted as { raw: string })));
    expect(/t=([0-9]+)/.exec(signed.signatureHeader)?.[1]).toBe(
      /t=([0-9]+)/.exec(wanted.signatureHeader as string)?.[1],
    );
    expect(await gatewayCheck(signed)).toBe("ok");
    const exchange = { ...fx, outcome: { result: "signed", webhook: signed } };
    const exchangeCheck = check("doubleWebhook.exchange");
    expect(exchangeCheck(exchange), JSON.stringify(exchangeCheck.errors)).toBe(true);
  });

  it("covers every webhook fixture of the index", () => {
    expect(verifies.map((entry) => entry.file).sort()).toEqual(
      [
        "verify-bad-signature.json",
        "verify-ignored.json",
        "webhook-bill-card-saved.json",
        "webhook-card-details.json",
        "webhook-card-replaced.json",
        "webhook-card-saved.json",
        "webhook-dispute-opened.json",
        "webhook-event.json",
        "webhook-payout-failed.json",
      ].sort(),
    );
  });
});

describe("the double's own events, signed", () => {
  const SHOP: Account = { kind: "business", accountId: "stripe-acct-demo-lees-barbershop" };

  it("signs every event its work sent, on the endpoint its account names, each a webhookEvent the schema allows", async () => {
    const world = createStripeDouble({ now: () => "2026-11-07T15:20:00Z" });
    world.seedCard({
      paymentMethodId: "pm_card_createDispute",
      account: SHOP,
      customerId: "stripe-customer-demo-alex",
    });
    const charge = (effectId: string, card: string, present = false): unknown =>
      world.charge({
        effect: { effectId, idempotencyKey: effectId },
        amount: { cents: 3500, currency: "USD" },
        port: {
          account: SHOP,
          purpose: "deposit",
          customerId: "stripe-customer-demo-alex",
          paymentMethodId: card,
          customerPresent: present,
          description: "Haircut",
        },
      });
    charge("eff-disputed", "pm_card_createDispute");
    world.networkReplaceCard("pm_card_createDispute", { brand: "visa", last4: "5556" });
    world.setAccountState("stripe-acct-demo-lees-barbershop", { canPayOut: false });
    world.failPayout("stripe-acct-demo-lees-barbershop", { cents: 4000, currency: "USD" });
    const link = world.payLink({
      effect: { effectId: "eff-link", idempotencyKey: "eff-link" },
      amount: { cents: 2500, currency: "USD" },
      port: {
        account: SHOP,
        purpose: "deposit",
        customerId: null,
        saveCardForLater: false,
        description: "Deposit",
      },
    });
    if (link.result !== "created") throw new Error("no link");
    world.closePayLink({ account: SHOP, paymentId: link.paymentId });
    world.disconnectAccount("stripe-acct-demo-lees-barbershop");

    const events = world.events();
    const kinds = new Set(events.map((event) => event.kind));
    for (const kind of [
      "paymentSucceeded",
      "disputeOpened",
      "cardReplaced",
      "accountUpdated",
      "payoutFailed",
      "paymentCanceled",
      "accountDisconnected",
    ])
      expect(kinds.has(kind as WebhookEvent["kind"]), kind).toBe(true);

    const signer = double();
    const eventCheck = check("webhookEvent");
    for (const event of events) {
      expect(eventCheck(event), `${event.kind}: ${JSON.stringify(eventCheck.errors)}`).toBe(true);
      const signed = await signer.sign(event);
      expect(signed.endpoint).toBe("businesses");
      expect(await gatewayCheck(signed)).toBe("ok");
      const body = rawOf(signed);
      expect(body).toMatchObject({
        id: event.eventId,
        type: event.stripeType,
        account: "stripe-acct-demo-lees-barbershop",
        livemode: false,
        object: "event",
      });
      const exchange = {
        call: "doubleWebhook",
        given: { now: event.occurredAt, note: "double" },
        request: { endpoint: "businesses", event },
        outcome: { result: "signed", webhook: signed },
      };
      const exchangeCheck = check("doubleWebhook.exchange");
      expect(exchangeCheck(exchange), `${event.kind}: ${JSON.stringify(exchangeCheck.errors)}`).toBe(true);
      // No card detail but brand and last four enters a body.
      expect(signed.raw).not.toMatch(/[0-9]([ -]?[0-9]){12,}/);
      expect(signed.raw).not.toMatch(/"(number|cvc|exp_month|exp_year)"/);
    }
  });

  it("signs an event on Rosfield's own account for the rosfield endpoint, with no account in the body", async () => {
    const world = createStripeDouble({ now: () => "2026-10-19T18:18:00Z" });
    const save = world.saveCard({
      effect: { effectId: "eff-sam-bill-card", idempotencyKey: "eff-sam-bill-card" },
      port: { account: { kind: "rosfield" }, customerId: null },
    });
    if (save.result !== "ready") throw new Error("no card save");
    const [saved] = world.completeSetup(save.setupId);
    if (saved === undefined) throw new Error("no event");
    const signed = await double().sign(saved);
    expect(signed.endpoint).toBe("rosfield");
    expect(rawOf(signed)).not.toHaveProperty("account");
    expect(rawOf(signed)).toMatchObject({
      type: "setup_intent.succeeded",
      data: {
        object: {
          metadata: { rosie_effect_id: "eff-sam-bill-card" },
          payment_method: "stripe-card-double-0001",
        },
      },
    });
    expect(await gatewayCheck(signed)).toBe("ok");
  });
});
