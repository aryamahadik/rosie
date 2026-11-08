// The gateway's scrub, seal and write to the handle's actor, run inside the Workers runtime (T-243). The Linq port is
// a double that answers with one K-06 fixture's event; the key store is a fake (NQ-RT-1: the real call joins at D-017);
// the actor is a stub behind the interface (its inbox is T-244). Fixtures: contracts/inbound-event/fixtures. Test
// values only: the public test cards and the printed sample Social Security number (rule 9).
import { afterEach, describe, expect, it, vi } from "vitest";

import delivered from "../../../contracts/inbound-event/fixtures/delivered.json";
import duplicateEvent from "../../../contracts/inbound-event/fixtures/duplicate-event.json";
import editAfterCommit from "../../../contracts/inbound-event/fixtures/edit-after-commit.json";
import photo from "../../../contracts/inbound-event/fixtures/photo.json";
import pollFailed from "../../../contracts/inbound-event/fixtures/poll-failed.json";
import pollVoteRemoved from "../../../contracts/inbound-event/fixtures/poll-vote-removed.json";
import pollVote from "../../../contracts/inbound-event/fixtures/poll-vote.json";
import reactionFromCustomer from "../../../contracts/inbound-event/fixtures/reaction-from-customer.json";
import reactionFromRosie from "../../../contracts/inbound-event/fixtures/reaction-from-rosie.json";
import sent from "../../../contracts/inbound-event/fixtures/sent.json";
import testPhonePage from "../../../contracts/inbound-event/fixtures/test-phone-page.json";
import textImessage from "../../../contracts/inbound-event/fixtures/text-imessage.json";
import cardNextToDigits from "../../../contracts/inbound-event/fixtures/text-with-card-next-to-digits.json";
import cardNonAscii from "../../../contracts/inbound-event/fixtures/text-with-card-non-ascii-digits.json";
import cardNumber from "../../../contracts/inbound-event/fixtures/text-with-card-number.json";
import cardWideSpaces from "../../../contracts/inbound-event/fixtures/text-with-card-wide-spaces.json";
import nineBare from "../../../contracts/inbound-event/fixtures/text-with-nine-bare-digits.json";
import ssnWide from "../../../contracts/inbound-event/fixtures/text-with-ssn-wide-form.json";
import ssn from "../../../contracts/inbound-event/fixtures/text-with-ssn.json";
import refuseCardNextToDigits from "../../../contracts/inbound-event/fixtures/invalid/refuse-unscrubbed-card-next-to-digits.json";
import refuseCardNonAscii from "../../../contracts/inbound-event/fixtures/invalid/refuse-unscrubbed-card-non-ascii-digits.json";
import refuseCardWideSpaces from "../../../contracts/inbound-event/fixtures/invalid/refuse-unscrubbed-card-wide-spaces.json";
import refuseCard from "../../../contracts/inbound-event/fixtures/invalid/refuse-unscrubbed-card.json";
import refuseSsnWide from "../../../contracts/inbound-event/fixtures/invalid/refuse-unscrubbed-ssn-wide-form.json";
import refuseSsn from "../../../contracts/inbound-event/fixtures/invalid/refuse-unscrubbed-ssn.json";
import { durableObjectActor, type ActorNamespace, type HandleActorRpc } from "./actor-door";
import { handleLinqWebhook } from "./linq-webhook";
import { actorNameOf, fromBase64, openWords, toBase64, type HandleRef, type SealingKeyStore } from "./seal";
import { fakeKeyStore, present, type FakeKeyStore } from "./test-support";
import type {
  ActorHandoff,
  ActorStub,
  GatewayDeps,
  InboundEvent,
  LinqPort,
  ReceiptSink,
  SealedHandoff,
  VerifyWebhookResult,
} from "./types";

const WHERE = { environment: "staging", version: "test-sha" };
const NOW = Date.parse("2026-10-12T16:20:01Z");

type Json = Record<string, unknown>;

/** The Linq fixtures the parse can produce, each with its own name. */
const LINQ_FIXTURES: [string, Json][] = [
  ["text-imessage", textImessage],
  ["photo", photo],
  ["reaction-from-customer", reactionFromCustomer],
  ["reaction-from-rosie", reactionFromRosie],
  ["poll-vote", pollVote],
  ["poll-vote-removed", pollVoteRemoved],
  ["edit-after-commit", editAfterCommit],
  ["delivered", delivered],
  ["sent", sent],
  ["poll-failed", pollFailed],
  ["duplicate-event", duplicateEvent],
  ["text-with-card-number", cardNumber],
  ["text-with-card-next-to-digits", cardNextToDigits],
  ["text-with-card-wide-spaces", cardWideSpaces],
  ["text-with-card-non-ascii-digits", cardNonAscii],
  ["text-with-ssn", ssn],
  ["text-with-ssn-wide-form", ssnWide],
  ["text-with-nine-bare-digits", nineBare],
  ["test-phone-page", testPhonePage],
];

/** Each raw (refused) fixture with the accepted fixture that is the same event, tagged. */
const RAW_AND_TAGGED: [string, Json, Json][] = [
  ["refuse-unscrubbed-card", refuseCard, cardNumber],
  ["refuse-unscrubbed-card-next-to-digits", refuseCardNextToDigits, cardNextToDigits],
  ["refuse-unscrubbed-card-wide-spaces", refuseCardWideSpaces, cardWideSpaces],
  ["refuse-unscrubbed-card-non-ascii-digits", refuseCardNonAscii, cardNonAscii],
  ["refuse-unscrubbed-ssn", refuseSsn, ssn],
  ["refuse-unscrubbed-ssn-wide-form", refuseSsnWide, ssnWide],
];

const ACTOR_KINDS = ["text", "photo", "reaction", "pollVote", "voteRemoved", "edit"];

function captureLogLines(): () => string {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => JSON.stringify(log.mock.calls);
}

function webhook(): Request {
  return new Request("https://rosie.test/test/webhooks/linq", {
    method: "POST",
    headers: { "webhook-id": "w", "webhook-timestamp": "1", "webhook-signature": "s" },
    body: "{}",
  });
}

function verifying(result: (traceId: string) => VerifyWebhookResult): LinqPort {
  return { verifyWebhook: (request) => Promise.resolve(result(request.traceId)) };
}

function eventResult(event: Json, partKey: string | null = null): LinqPort {
  return verifying((traceId) => ({
    result: "event",
    httpStatus: 200,
    event: { ...event, traceId } as InboundEvent,
    partKey,
  }));
}

interface Doors {
  actor: ActorStub & { calls: SealedHandoff[]; written: SealedHandoff[] };
  receipts: ReceiptSink & { written: ActorHandoff[] };
  keys: FakeKeyStore;
}

function doors(): Doors {
  const written: SealedHandoff[] = [];
  const calls: SealedHandoff[] = [];
  const receiptsWritten: ActorHandoff[] = [];
  return {
    actor: {
      calls,
      written,
      accept(handoff) {
        calls.push(handoff);
        written.push(handoff);
        return Promise.resolve("written");
      },
    },
    receipts: {
      written: receiptsWritten,
      accept(handoff) {
        receiptsWritten.push(handoff);
        return Promise.resolve("written");
      },
    },
    keys: fakeKeyStore(),
  };
}

function depsOf(linq: LinqPort, d: Doors, overrides: Partial<GatewayDeps> = {}): GatewayDeps {
  return {
    linq,
    actor: d.actor,
    receipts: d.receipts,
    keys: d.keys,
    bundleId: () => ({ hash: "a".repeat(64), build: 1 }),
    now: () => NOW,
    ...overrides,
  };
}

/** The K-06 event the actor will rebuild: the sealed words put back where they came from. */
async function unsealed(handoff: SealedHandoff, keys: FakeKeyStore): Promise<Json> {
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

describe("every K-06 fixture the Linq parse can produce", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(LINQ_FIXTURES)(
    "%s reaches its door as the same K-06 event, in K-06's routing",
    async (_name, fixture) => {
      captureLogLines();
      const d = doors();
      const kind = fixture.kind as string;

      const response = await handleLinqWebhook(
        webhook(),
        depsOf(eventResult(fixture, "part-key-1"), d),
        WHERE,
      );

      expect(response.status).toBe(200);
      const traceId = response.headers.get("x-trace-id");
      const expected = { ...fixture, traceId };
      if (ACTOR_KINDS.includes(kind)) {
        expect(d.receipts.written).toHaveLength(0);
        expect(d.actor.written).toHaveLength(1);
        const handoff = present(d.actor.written[0], "the hand-off");
        expect(handoff.partKey).toBe("part-key-1");
        expect(handoff.traceId).toBe(traceId);
        expect(handoff.event).not.toHaveProperty("body");
        expect(handoff.event).not.toHaveProperty("partKey");
        expect(await unsealed(handoff, d.keys)).toEqual(expected);
      } else {
        expect(d.actor.calls).toHaveLength(0);
        expect(d.keys.asked).toHaveLength(0);
        expect(d.receipts.written).toHaveLength(1);
        expect(d.receipts.written[0]?.partKey).toBe("part-key-1");
        expect(d.receipts.written[0]?.event).toEqual(expected);
      }
    },
  );

  it.each(RAW_AND_TAGGED)(
    "%s is stored scrubbed: the tagged fixture's words, its counts, and no number in what is stored",
    async (_name, raw, tagged) => {
      captureLogLines();
      const d = doors();

      const response = await handleLinqWebhook(webhook(), depsOf(eventResult(raw), d), WHERE);

      expect(response.status).toBe(200);
      const handoff = present(d.actor.written[0], "the hand-off");
      const event = await unsealed(handoff, d.keys);
      expect(event.body).toBe(tagged.body);
      expect(event.scrubbed).toEqual(tagged.scrubbed);
      expect(JSON.stringify(handoff)).not.toContain(raw.body as string);
    },
  );
});

describe("the sealed body", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is a box that is not readable without the key, and holds no plain word, card number or subject", async () => {
    captureLogLines();
    const d = doors();
    const email = {
      ...(cardNumber as Json),
      provider: "email",
      handle: { kind: "email", address: "a@example.com" },
    };
    const withSubject = {
      ...email,
      service: "email",
      email: {
        replyAddress: "booking-x@reply.example.com",
        subject: "Re: Your haircut",
        senderCheck: "passed",
      },
    };

    await handleLinqWebhook(webhook(), depsOf(eventResult(refuseCard), d), WHERE);
    await handleLinqWebhook(webhook(), depsOf(eventResult(withSubject), d), WHERE);

    const stored = JSON.stringify(d.actor.written);
    // The whole test card number, spaced as the text holds it, and run together: the stored hand-offs hold random trace
    // ids and sealed boxes in hex and base64, which can hold "4242" by chance (DL-116, as below).
    const card = "4242 4242 4242 4242";
    expect(refuseCard.body).toContain(card);
    expect(stored).not.toContain(card);
    expect(stored).not.toContain(card.replaceAll(" ", ""));
    expect(stored).not.toContain("My card is");
    expect(stored).not.toContain("Re: Your haircut");
    const first = present(d.actor.written[0], "the first hand-off");
    const box = present(first.event.sealed, "the sealed box");
    expect(box).toMatchObject({ v: 1, alg: "A256GCM" });
    expect(fromBase64(box.iv)).toHaveLength(12);
    // The cipher text is the words and a 16-byte tag, so it cannot be shorter than the JSON of the words.
    expect(fromBase64(box.ct).length).toBeGreaterThan(cardNumber.body.length);

    const key = d.keys.keyOf(first.event.handle);
    const wrongKey = crypto.getRandomValues(new Uint8Array(32));
    await expect(openWords(box, wrongKey, first.actorName, first.event.eventId)).rejects.toThrow();
    await expect(openWords(box, key, "phone:+15555550199", first.event.eventId)).rejects.toThrow();
    await expect(openWords(box, key, first.actorName, "evt-other")).rejects.toThrow();
    await expect(openWords(box, key, first.actorName, first.event.eventId)).resolves.toMatchObject({
      body: cardNumber.body,
    });

    const second = present(d.actor.written[1], "the second hand-off");
    expect(second.event.email).toEqual({
      replyAddress: "booking-x@reply.example.com",
      senderCheck: "passed",
    });
    const opened = await unsealed(second, d.keys);
    expect((opened.email as Json).subject).toBe("Re: Your haircut");
  });

  it("uses a new IV for each seal", async () => {
    captureLogLines();
    const d = doors();
    await handleLinqWebhook(webhook(), depsOf(eventResult(textImessage), d), WHERE);
    await handleLinqWebhook(webhook(), depsOf(eventResult(textImessage), d), WHERE);
    const [a, b] = d.actor.written.map((handoff) => present(handoff.event.sealed, "the sealed box"));
    expect(a?.iv).not.toBe(b?.iv);
    expect(a?.ct).not.toBe(b?.ct);
  });

  it("holds no key, plain body or phone number in a log line or an answer", async () => {
    const logLines = captureLogLines();
    const d = doors();

    const response = await handleLinqWebhook(webhook(), depsOf(eventResult(refuseCard), d), WHERE);
    const failing = await handleLinqWebhook(
      webhook(),
      depsOf(eventResult(refuseCard), d, {
        keys: { getOrCreateKey: () => Promise.reject(new Error("4242 4242 4242 4242 my key")) },
      }),
      WHERE,
    );

    const key = d.keys.keyOf(refuseCard.handle);
    const text = logLines() + (await response.text()) + (await failing.text());
    // The whole test card number, spaced as the text and the key store's error hold it, and run together: the log holds
    // random trace ids, whose hex digits can hold "4242" by chance (about one run in two thousand; DL-116).
    const card = "4242 4242 4242 4242";
    expect(refuseCard.body).toContain(card);
    expect(text).not.toContain(card);
    expect(text).not.toContain(card.replaceAll(" ", ""));
    expect(text).not.toContain(refuseCard.handle.address);
    expect(text).not.toContain(toBase64(key));
    expect(text).not.toContain(JSON.stringify([...key]));
  });
});

describe("the handle's actor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A namespace that gives each name its own id and records which id each hand-off reached. */
  function namespace(): ActorNamespace<string> & { reached: [string, SealedHandoff][] } {
    const reached: [string, SealedHandoff][] = [];
    return {
      reached,
      idFromName: (name) => `id(${name})`,
      get: (id): HandleActorRpc => ({
        accept(handoff) {
          reached.push([id, handoff]);
          return Promise.resolve("written");
        },
      }),
    };
  }

  it("two webhooks for one handle reach the same actor id, and two handles reach different ones", async () => {
    captureLogLines();
    const d = doors();
    const ns = namespace();
    const deps = (event: Json): GatewayDeps =>
      depsOf(eventResult(event), d, { actor: durableObjectActor(ns) });
    const other = {
      ...textImessage,
      eventId: "evt-sam-0001",
      handle: { kind: "phone", address: "+15555550102" },
    };

    await handleLinqWebhook(webhook(), deps(textImessage), WHERE);
    await handleLinqWebhook(webhook(), deps({ ...textImessage, eventId: "evt-alex-0002" }), WHERE);
    await handleLinqWebhook(webhook(), deps(other), WHERE);

    const ids = ns.reached.map(([id]) => id);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(ids[0]).toBe(`id(${actorNameOf(textImessage.handle)})`);
  });

  it("a phone and an email address that read alike are two actors", () => {
    expect(actorNameOf({ kind: "phone", address: "x" })).not.toBe(
      actorNameOf({ kind: "email", address: "x" }),
    );
  });

  it("an answer other than written or duplicate from the actor is a failed write: 503", async () => {
    captureLogLines();
    const d = doors();
    const ns = namespace();
    ns.get = () => ({ accept: () => Promise.resolve("queued" as unknown as "written") });

    const response = await handleLinqWebhook(
      webhook(),
      depsOf(eventResult(textImessage), d, { actor: durableObjectActor(ns) }),
      WHERE,
    );

    expect(response.status).toBe(503);
  });

  it("a known event id (the actor answers duplicate) is 200, nothing more", async () => {
    captureLogLines();
    const d = doors();
    const actor: ActorStub = { accept: () => Promise.resolve("duplicate") };

    const response = await handleLinqWebhook(
      webhook(),
      depsOf(eventResult(textImessage), d, { actor }),
      WHERE,
    );

    expect(response.status).toBe(200);
  });
});

describe("failures leave nothing and answer 503", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each<[string, SealingKeyStore, string]>([
    ["a key store that throws", { getOrCreateKey: () => Promise.reject(new Error("down")) }, "sealFailed"],
    ["a key of the wrong length", { getOrCreateKey: () => Promise.resolve(new Uint8Array(5)) }, "sealFailed"],
  ])("%s: no write, nothing stored", async (_name, keys, code) => {
    const logLines = captureLogLines();
    const d = doors();

    const response = await handleLinqWebhook(
      webhook(),
      depsOf(eventResult(textImessage), d, { keys }),
      WHERE,
    );

    expect(response.status).toBe(503);
    expect(d.actor.calls).toHaveLength(0);
    expect(d.receipts.written).toHaveLength(0);
    expect(logLines()).toContain(code);
  });

  it("a failing actor write: 503, and the retry (the same event) is stored whole", async () => {
    captureLogLines();
    const d = doors();
    let failNext = true;
    const stored: SealedHandoff[] = [];
    const actor: ActorStub = {
      accept(handoff) {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("storage failed"));
        }
        stored.push(handoff);
        return Promise.resolve("written");
      },
    };
    const deps = depsOf(eventResult(textImessage), d, { actor });

    const first = await handleLinqWebhook(webhook(), deps, WHERE);
    expect(first.status).toBe(503);
    expect(stored).toHaveLength(0);

    const second = await handleLinqWebhook(webhook(), deps, WHERE);
    expect(second.status).toBe(200);
    expect(stored).toHaveLength(1);
    expect(await unsealed(present(stored[0], "the stored hand-off"), d.keys)).toMatchObject({
      body: textImessage.body,
    });
  });

  it("a failing receipts door: 503", async () => {
    captureLogLines();
    const d = doors();
    const receipts: ReceiptSink = { accept: () => Promise.reject(new Error("dispatcher down")) };

    const response = await handleLinqWebhook(
      webhook(),
      depsOf(eventResult(delivered), d, { receipts }),
      WHERE,
    );

    expect(response.status).toBe(503);
  });

  it("a verify result this build does not know is 503 and never handed on, never 200", async () => {
    captureLogLines();
    const d = doors();
    const linq = verifying(
      () => ({ result: "queued", httpStatus: 200, event: textImessage }) as unknown as VerifyWebhookResult,
    );

    const response = await handleLinqWebhook(webhook(), depsOf(linq, d), WHERE);

    expect(response.status).toBe(503);
    expect(d.actor.calls).toHaveLength(0);
    expect(d.receipts.written).toHaveLength(0);
    expect(d.keys.asked).toHaveLength(0);
  });

  it.each([
    ["a kind K-06 does not list", { ...textImessage, kind: "typing" }],
    ["no handle", { ...textImessage, handle: null }],
    ["an empty address", { ...textImessage, handle: { kind: "phone", address: "" } }],
    ["a body that is not words", { ...textImessage, body: 7 }],
  ])("%s: 503, nothing handed on", async (_name, event) => {
    captureLogLines();
    const d = doors();

    const response = await handleLinqWebhook(webhook(), depsOf(eventResult(event), d), WHERE);

    expect(response.status).toBe(503);
    expect(d.actor.calls).toHaveLength(0);
    expect(d.receipts.written).toHaveLength(0);
  });

  it("a bad signature asks for no key and writes nothing", async () => {
    captureLogLines();
    const d = doors();
    const linq = verifying(() => ({ result: "rejected", httpStatus: 401, reason: "badSignature" }));

    const response = await handleLinqWebhook(webhook(), depsOf(linq, d), WHERE);

    expect(response.status).toBe(401);
    expect(d.keys.asked).toHaveLength(0);
    expect(d.actor.calls).toHaveLength(0);
    expect(d.receipts.written).toHaveLength(0);
  });
});

describe("what the key store is asked", () => {
  it("is the event's handle, once per event with words", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const d = doors();

    await handleLinqWebhook(webhook(), depsOf(eventResult(reactionFromCustomer), d), WHERE);
    await handleLinqWebhook(webhook(), depsOf(eventResult(textImessage), d), WHERE);

    const asked: HandleRef[] = d.keys.asked;
    expect(asked).toEqual([textImessage.handle]);
    vi.restoreAllMocks();
  });
});
