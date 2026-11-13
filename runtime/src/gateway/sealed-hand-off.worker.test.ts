// K-06 v1.2's sealed hand-off (T-1297; contracts/inbound-event/README.md "The sealed hand-off (v1.2)", items 1 to 7; CQ-58),
// run inside the Workers runtime. A poll answer goes through the gateway (the Linq port a double answering one K-06
// event, the key store a fake: NQ-RT-1) into the real handle actor, the Durable Object behind the gateway's door, and the
// row its inbox keeps (runtime/src/actor/inbox.ts) is read back from the actor's own storage: no card number or Social
// Security number in any column or in event_json, the option's words only in the box, and they read back tagged. Then
// the earlier form: a box of form 1 and a vote kept with its words plain are stored as they are and still open; and the
// reader fails closed on a form it does not know or members that are not the form's. Test method: T-1128's (`reset()`
// after each test). Test values only: the fixtures' public test card 4242 4242 4242 4242 and the printed sample number
// 123-45-6789 (rule 9).
import { reset, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import cardInOption from "../../../contracts/inbound-event/fixtures/poll-vote-added-option-with-card.json";
import pollVote from "../../../contracts/inbound-event/fixtures/poll-vote.json";
import textImessage from "../../../contracts/inbound-event/fixtures/text-imessage.json";
import ssnInOption from "../../../contracts/inbound-event/fixtures/vote-removed-added-option-with-ssn.json";
import rawCardInOption from "../../../contracts/inbound-event/fixtures/invalid/refuse-unscrubbed-card-in-added-option.json";
import rawSsnInOption from "../../../contracts/inbound-event/fixtures/invalid/refuse-unscrubbed-ssn-in-added-option.json";
import type { HandleActor, InboxEntry } from "../actor";
import { durableObjectActor, type ActorNamespace, type HandleActorRpc } from "./actor-door";
import { handleLinqWebhook } from "./linq-webhook";
import {
  actorNameOf,
  openWords,
  optionWordsOf,
  sealEventWords,
  sealWords,
  toBase64,
  wordsOfEvent,
  type EventBox,
} from "./seal";
import { fakeKeyStore, present, type FakeKeyStore } from "./test-support";
import type { GatewayDeps, InboundEvent, SealedEvent, SealedHandoff } from "./types";

type Json = Record<string, unknown>;

const WHERE = { environment: "staging", version: "test-sha" };
const NOW = Date.parse("2026-10-23T14:20:01Z");
const BUNDLE = { hash: "a".repeat(64), build: 1 };
const ALEX = actorNameOf(textImessage.handle);

type Namespace = DurableObjectNamespace<HandleActor>;

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

/** The gateway's door over the real namespace. */
function door(): ReturnType<typeof durableObjectActor> {
  const ns = namespace();
  const adapter: ActorNamespace<DurableObjectId> = {
    idFromName: (name) => ns.idFromName(name),
    get: (id): HandleActorRpc => ns.get(id),
  };
  return durableObjectActor(adapter);
}

function stubOf(name: string): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(name));
}

/** The inbox over RPC, typed here (the stub's own type cannot carry the sealed event's open shape). */
function inboxOf(name: string): Promise<InboxEntry[]> {
  return (stubOf(name) as unknown as { readInbox(): Promise<InboxEntry[]> }).readInbox();
}

/** Every row of the actor's inbox table as SQLite keeps it, every column. */
function storedRows(name: string): Promise<Record<string, SqlStorageValue>[]> {
  return runInDurableObject(stubOf(name), (_instance, state) =>
    state.storage.sql.exec("SELECT * FROM inbox ORDER BY seq").toArray(),
  );
}

function webhook(): Request {
  return new Request("https://rosie.test/test/webhooks/linq", {
    method: "POST",
    headers: { "webhook-id": "w", "webhook-timestamp": "1", "webhook-signature": "s" },
    body: "{}",
  });
}

/** The gateway with the real actor behind its door, its Linq port verifying every webhook as `event`. */
function gatewayFor(event: Json, keys: FakeKeyStore): GatewayDeps {
  return {
    linq: {
      verifyWebhook: (request) =>
        Promise.resolve({
          result: "event",
          httpStatus: 200,
          event: { ...event, traceId: request.traceId } as InboundEvent,
          partKey: null,
        }),
    },
    actor: door(),
    receipts: { accept: () => Promise.reject(new Error("no receipt here")) },
    keys,
    bundleId: () => BUNDLE,
    now: () => NOW,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("a poll answer is stored with its option's words scrubbed, and only in the box", () => {
  it.each<[string, Json, Json, string[]]>([
    [
      "a vote for an option holding a card number",
      rawCardInOption,
      cardInOption,
      ["4242 4242 4242 4242", "4242424242424242"],
    ],
    [
      "a vote taken back for an option holding a Social Security number",
      rawSsnInOption,
      ssnInOption,
      ["123-45-6789", "123456789"],
    ],
  ])(
    "%s: no number in any column, in event_json or in a log line; the option reads back from the box as its tagged twin's",
    async (_name, raw, tagged, numbers) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const keys = fakeKeyStore();
      const typed = (raw.poll as { optionWords: string }).optionWords;
      expect(numbers.some((number) => typed.includes(number))).toBe(true);

      const response = await handleLinqWebhook(webhook(), gatewayFor(raw, keys), WHERE);

      expect(response.status).toBe(200);
      const rows = await storedRows(ALEX);
      expect(rows).toHaveLength(1);
      const row = present(rows[0], "the inbox row");
      const stored = JSON.stringify(rows) + JSON.stringify(log.mock.calls);
      for (const number of numbers) expect(stored).not.toContain(number);
      expect(stored).not.toContain(typed);

      // event_json: the sealed event as the gateway handed it, its option by id only, no body, the words in a form 2 box.
      const json = row.event_json;
      if (typeof json !== "string") throw new Error("event_json is not text");
      const kept = JSON.parse(json) as SealedEvent;
      const [entry] = await inboxOf(ALEX);
      expect(kept).toEqual(present(entry, "the inbox entry").event);
      expect(row.kind).toBe(raw.kind);
      expect(kept).not.toHaveProperty("body");
      const twinPoll = tagged.poll as { pollId: string; optionId: string; optionWords: string };
      expect(kept.poll).toEqual({ pollId: twinPoll.pollId, optionId: twinPoll.optionId });
      expect(kept.scrubbed).toEqual(tagged.scrubbed);
      const box = present(kept.sealed, "the vote's box");
      expect(box).toMatchObject({ v: 2, alg: "A256GCM" });

      const words = await openWords(box, keys.keyOf(textImessage.handle), ALEX, String(raw.eventId));
      expect(words).toEqual({ body: null, subject: null, optionWords: twinPoll.optionWords });
      expect(optionWordsOf(kept, words)).toBe(twinPoll.optionWords);
    },
  );

  it("Rosie's own option (poll-vote.json) is sealed the same way and reads back word for word", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const keys = fakeKeyStore();

    expect((await handleLinqWebhook(webhook(), gatewayFor(pollVote, keys), WHERE)).status).toBe(200);

    const [entry] = await inboxOf(ALEX);
    const kept = present(entry, "the inbox entry").event;
    expect(kept.poll).toEqual({ pollId: pollVote.poll.pollId, optionId: pollVote.poll.optionId });
    const words = await openWords(
      present(kept.sealed, "the vote's box"),
      keys.keyOf(pollVote.handle),
      ALEX,
      pollVote.eventId,
    );
    expect(wordsOfEvent(kept, words)).toEqual({ body: null, subject: null, optionWords: "Sat 2:00pm" });
  });
});

describe("a box of the earlier form still opens, as it was kept", () => {
  it("a text with a form 1 box and a vote with its words plain and no box, as T-243's gateway handed them, are stored as they are and read as they are", async () => {
    const keys = fakeKeyStore();
    const key = await keys.getOrCreateKey(textImessage.handle);
    const strip = (event: Json): Json =>
      Object.fromEntries(Object.entries(event).filter(([field]) => field !== "body"));
    const oldText = {
      ...strip(textImessage),
      sealed: await sealWords({ body: textImessage.body, subject: null }, key, ALEX, textImessage.eventId),
    } as SealedEvent;
    const oldVote = { ...strip(pollVote), sealed: null } as SealedEvent;
    const handoffOf = (event: SealedEvent): SealedHandoff => ({
      event,
      partKey: null,
      traceId: event.traceId,
      bundleId: BUNDLE,
      actorName: ALEX,
    });

    expect(await door().accept(handoffOf(oldText))).toBe("written");
    expect(await door().accept(handoffOf(oldVote))).toBe("written");

    // Nothing rewrites a kept event (v1.2 default 4): the inbox gives back each one exactly as it was handed.
    const [text, vote] = await inboxOf(ALEX);
    expect(text?.event).toEqual(oldText);
    expect(vote?.event).toEqual(oldVote);
    const box = present(text?.event.sealed, "the form 1 box");
    expect(box.v).toBe(1);

    const opened = await openWords(box, key, ALEX, textImessage.eventId);

    expect(opened).toEqual({ body: textImessage.body, subject: null });
    expect(wordsOfEvent(oldText, opened)).toEqual({ body: textImessage.body, subject: null });
    expect(wordsOfEvent(oldVote, null)).toEqual({ body: null, subject: null, optionWords: "Sat 2:00pm" });
  });
});

/** A box sealed as README item 3 says, around any JSON text: the reader's checks are what refuse it, never the seal. */
async function boxAround(
  text: string,
  key: Uint8Array,
  eventId: string,
): Promise<{ alg: "A256GCM"; iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(`${ALEX}|${eventId}`),
      tagLength: 128,
    },
    await crypto.subtle.importKey("raw", Uint8Array.from(key), "AES-GCM", false, ["encrypt"]),
    new TextEncoder().encode(text),
  );
  return { alg: "A256GCM", iv: toBase64(iv), ct: toBase64(new Uint8Array(cipher)) };
}

describe("the reader takes the words by the box's form and fails closed (items 6 and 7)", () => {
  const eventId = pollVote.eventId;

  it("a box sealed as item 3 says, with its form's members, opens; the same seal with any other members, or under another form's number, is refused", async () => {
    const keys = fakeKeyStore();
    await keys.getOrCreateKey(pollVote.handle);
    const key = keys.keyOf(pollVote.handle);
    const open = (box: unknown): Promise<unknown> =>
      openWords(box as EventBox, key, ALEX, eventId).then((words) => words as unknown);

    const two = await boxAround('{"body":null,"subject":null,"optionWords":"Sat 2:00pm"}', key, eventId);
    const one = await boxAround('{"body":"Can I come at 3?","subject":null}', key, eventId);
    await expect(open({ v: 2, ...two })).resolves.toEqual({
      body: null,
      subject: null,
      optionWords: "Sat 2:00pm",
    });
    await expect(open({ v: 1, ...one })).resolves.toEqual({ body: "Can I come at 3?", subject: null });

    const refused: [string, unknown][] = [
      ["form 2's members under form 1", { v: 1, ...two }],
      ["form 1's members under form 2", { v: 2, ...one }],
      ["a form this build does not know", { v: 3, ...two }],
      ["no form", { ...two }],
      ["another algorithm", { v: 2, ...two, alg: "A128GCM" }],
      ["a member missing", { v: 2, ...(await boxAround('{"body":null,"subject":null}', key, eventId)) }],
      [
        "one member more",
        {
          v: 2,
          ...(await boxAround(
            '{"body":null,"subject":null,"optionWords":"Sat 2:00pm","extra":"words"}',
            key,
            eventId,
          )),
        },
      ],
      [
        "a member of another type",
        {
          v: 2,
          ...(await boxAround('{"body":null,"subject":null,"optionWords":7}', key, eventId)),
        },
      ],
      ["not an object", { v: 2, ...(await boxAround('["body","subject","optionWords"]', key, eventId)) }],
    ];
    for (const [name, box] of refused) await expect(open(box), name).rejects.toThrow();
  });

  it("a form 2 box opens only under its own key, handle and event id, like form 1's", async () => {
    const keys = fakeKeyStore();
    const key = await keys.getOrCreateKey(pollVote.handle);
    const box = await sealEventWords(
      { body: null, subject: null, optionWords: "Sat 2:00pm" },
      key,
      ALEX,
      eventId,
    );

    await expect(openWords(box, crypto.getRandomValues(new Uint8Array(32)), ALEX, eventId)).rejects.toThrow();
    await expect(openWords(box, key, "phone:+15555550199", eventId)).rejects.toThrow();
    await expect(openWords(box, key, ALEX, "evt-other")).rejects.toThrow();
    await expect(openWords(box, key, ALEX, eventId)).resolves.toEqual({
      body: null,
      subject: null,
      optionWords: "Sat 2:00pm",
    });
  });

  it("a form 1 box holds no option words: sealing some in it is refused, so none is dropped", async () => {
    const keys = fakeKeyStore();
    const key = await keys.getOrCreateKey(pollVote.handle);

    await expect(
      sealWords({ body: null, subject: null, optionWords: "Sat 2:00pm" }, key, ALEX, eventId),
    ).rejects.toThrow();
  });
});
