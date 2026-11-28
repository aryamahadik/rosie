// The actor's event door (T-1563; ruling T-1543 card A18; K-09 v1.14 defaults 221 and 222), run inside the Workers runtime
// against the real Durable Object. `handEvent` checks, seals and hands an event; the actor's `acceptEvent` checks it again
// and stores it sealed in its ordered inbox, a known event id dropped. No turn runs here (no lease hooks are set): the turn
// itself is runtime/src/turn/event-turn.worker.test.ts's. Test values only: the K-09 v1.14 fixtures' stand-in ids, a
// fictional 555-01xx number (rule 9).
import { reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import commitEventIdChecked from "../../../contracts/tool-api/fixtures/commit-event-id-checked.json";
import { actorNameOf, openWords, type HandleRef } from "../gateway/seal";
import { fakeKeyStore } from "../gateway/test-support";
import {
  EVENT_ID_PREFIX,
  EVENT_KIND,
  EventDoorRefusal,
  eventIdOf,
  handEvent,
  isEventIdForm,
  openEventBody,
  turnIdOf,
  type DoorEvent,
  type EventDoorStub,
  type EventHandoff,
  type HandleActor,
  type SealedEventHandoff,
} from "./index";

const TRACE = "11111111-2222-4333-8444-555555555555";
const BUNDLE = { hash: "a".repeat(64), build: 1 };
const OWNER: HandleRef = { kind: "phone", address: "+15555550188" };
const REF = commitEventIdChecked.request.input.ref;
const keys = fakeKeyStore();

type Namespace = DurableObjectNamespace<HandleActor>;

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

interface ActorReads extends EventDoorStub {
  readInbox(): Promise<{ seq: number; event: DoorEvent; traceId: string; bundleId: unknown }[]>;
  readTurns(): Promise<unknown[]>;
  firstTraceOf(eventId: string): Promise<string | null>;
}

function actorOf(handle: HandleRef): ActorReads {
  return namespace().get(namespace().idFromName(actorNameOf(handle)));
}

async function uploadEvent(overrides: Partial<EventHandoff> = {}): Promise<EventHandoff> {
  return {
    eventId: await eventIdOf("id_checked", REF),
    key: "id_checked",
    step: "S1-10",
    ref: REF,
    traceId: TRACE,
    handle: OWNER,
    bundleId: BUNDLE,
    ...overrides,
  };
}

afterEach(async () => {
  await reset();
});

describe("the event id (K-09 v1.14 default 222)", () => {
  it("is the namespace, then a hash of the key and the ref: one source one id, and the ref never in it", async () => {
    const id = await eventIdOf("id_checked", REF);
    expect(id.startsWith(EVENT_ID_PREFIX)).toBe(true);
    expect(id).toMatch(/^rosie-event:v1:[0-9a-f]{64}$/u);
    expect(id).not.toContain(REF);
    expect(isEventIdForm(id)).toBe(true);
    // The same source gives the same id; another ref or another key another.
    expect(await eventIdOf("id_checked", REF)).toBe(id);
    expect(await eventIdOf("id_checked", "upload-demo-owner-2")).not.toBe(id);
    expect(await eventIdOf("control_proven", REF)).not.toBe(id);
    // No provider's event id takes the form (a Linq message id, the fixtures' text id), so neither the inbox nor turnIdOf
    // can meet one equal to it.
    expect(isEventIdForm(commitEventIdChecked.request.input.eventId)).toBe(false);
    expect(isEventIdForm("msg_01J9ZQ5S7W1Z7Y")).toBe(false);
    expect(await turnIdOf([id])).not.toBe(await turnIdOf(["msg_01J9ZQ5S7W1Z7Y"]));
  });
});

describe("the door", () => {
  it("stores the event sealed in the ordered inbox: the id, kind, handle and trace in the clear, no K-06 service or chat id", async () => {
    const handoff = await uploadEvent();
    const actor = actorOf(OWNER);
    expect(await handEvent(actor, handoff, keys)).toBe("written");
    const inbox = await actor.readInbox();
    expect(inbox).toHaveLength(1);
    const entry = inbox[0];
    expect(entry?.traceId).toBe(TRACE);
    expect(entry?.bundleId).toEqual(BUNDLE);
    const event = entry?.event;
    if (event === undefined) throw new Error("no entry");
    expect(Object.keys(event).sort()).toEqual(["eventId", "handle", "kind", "sealed", "traceId"]);
    expect(event).toMatchObject({
      eventId: handoff.eventId,
      kind: EVENT_KIND,
      handle: OWNER,
      traceId: TRACE,
    });
    expect("service" in event || "chatId" in event).toBe(false);
    // The key, the step and the ref are sealed: none of them is in the stored entry's clear text.
    const stored = JSON.stringify(entry);
    expect(stored).not.toContain(REF);
    expect(stored).not.toContain("id_checked");
    expect(stored).not.toContain("S1-10");
    // The box opens with the handle's key to the event's body, and as nothing else.
    const key = await keys.getOrCreateKey(OWNER);
    expect(await openEventBody(event, key)).toEqual({ key: "id_checked", step: "S1-10", ref: REF });
    const words = await openWords(event.sealed, key, actorNameOf(OWNER), event.eventId);
    expect(words.subject).toBeNull();
    await expect(openWords(event.sealed, key, actorNameOf(OWNER), "rosie-event:v1:other")).rejects.toThrow();
    expect(await actor.firstTraceOf(handoff.eventId)).toBe(TRACE);
  });

  it("answers a known event id duplicate with nothing stored, whatever else differs", async () => {
    const actor = actorOf(OWNER);
    expect(await handEvent(actor, await uploadEvent(), keys)).toBe("written");
    const again = await uploadEvent({ traceId: "22222222-3333-4444-8555-666666666666" });
    expect(await handEvent(actor, again, keys)).toBe("duplicate");
    const inbox = await actor.readInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.traceId).toBe(TRACE);
  });

  it("refuses a key outside the event table or a step that is not its key's, with nothing sealed or stored", async () => {
    const actor = actorOf(OWNER);
    const refusals: [Partial<EventHandoff>, string][] = [
      // The fixtures' refused requests: a key not in the table, and id_checked at a step that is not S1-10.
      [{ key: "mobile" as EventHandoff["key"] }, "notInEventTable"],
      [{ step: "S1-75" }, "notInEventTable"],
      [{ key: "control_proven" }, "notInEventTable"],
      [{ step: "S1-32" }, "notInEventTable"],
      // An event id not made from this key and ref, a trace that is no UUID, a handle that is no phone, a bundle not K-01's.
      [{ eventId: "evt-linq-0001" }, "badEventId"],
      [{ eventId: await eventIdOf("id_checked", "upload-other") }, "badEventId"],
      [{ ref: "" }, "badRef"],
      [{ traceId: "trace-page-demo-0010" }, "badTrace"],
      [{ handle: { kind: "email", address: "owner@example.com" } }, "notAPhone"],
      [{ bundleId: { hash: "nope", build: 1 } }, "badBundle"],
    ];
    for (const [overrides, code] of refusals) {
      const refused = await handEvent(actor, await uploadEvent(overrides), keys).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(EventDoorRefusal);
      expect((refused as EventDoorRefusal).code).toBe(code);
      // The message is the label alone: never the ref or the number.
      expect((refused as EventDoorRefusal).message).toBe(code);
    }
    expect(await actor.readInbox()).toEqual([]);
    expect(await actor.readTurns()).toEqual([]);
  });

  it("the actor refuses a sealed hand-off that is not an event's, with nothing stored", async () => {
    const actor = actorOf(OWNER);
    const good = await uploadEvent();
    // A sealed hand-off as handEvent would make it, to damage field by field.
    const seen: { handoff: SealedEventHandoff | null } = { handoff: null };
    await handEvent(
      {
        acceptEvent(handoff) {
          seen.handoff = handoff;
          return Promise.resolve("written");
        },
      },
      good,
      keys,
    );
    const base = seen.handoff;
    if (base === null) throw new Error("nothing sealed");
    const damaged: [unknown, string][] = [
      [{ ...base, event: { ...base.event, kind: "text" } }, "notAnEvent"],
      [{ ...base, event: { ...base.event, eventId: "evt-linq-0001" } }, "badEventId"],
      [{ ...base, event: { ...base.event, sealed: { v: 1, alg: "A256GCM", iv: "", ct: "" } } }, "notSealed"],
      [{ ...base, event: { ...base.event, service: "imessage", chatId: "chat-1" } }, "notAnEvent"],
      [{ ...base, event: { ...base.event, firsts: base.event.sealed } }, "notAnEvent"],
      [{ ...base, event: { ...base.event, traceId: "trace-1" } }, "badTrace"],
      [{ ...base, bundleId: { hash: "nope", build: 1 } }, "badBundle"],
    ];
    for (const [handoff, code] of damaged) {
      // Awaited inside an async function, as the gateway's door awaits the actor, so the RPC call's refusal is caught here.
      const refused = await (async (): Promise<unknown> => {
        try {
          await actor.acceptEvent(handoff as SealedEventHandoff);
          return null;
        } catch (error) {
          return error;
        }
      })();
      expect(refused).toBeInstanceOf(Error);
      expect((refused as Error).message).toContain(code);
    }
    expect(await actor.readInbox()).toEqual([]);
    // The undamaged one is taken.
    expect(await actor.acceptEvent(base)).toBe("written");
    expect(await actor.readInbox()).toHaveLength(1);
  });
});
