// The handle actor's inbox, run inside the Workers runtime (T-244). The gateway's own hand-off code builds each sealed
// hand-off from a K-06 fixture (a fake key store; NQ-RT-1), and the actor is the real Durable Object reached through
// the gateway's door. Test method: T-1128's (runtime/src/spikes/do-test-pool/FINDINGS.md): `exports.HandleActor`,
// `reset()` after each test, `evictDurableObject` for a restart. Test values only (rule 9).
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import delivered from "../../../contracts/inbound-event/fixtures/delivered.json";
import duplicateEvent from "../../../contracts/inbound-event/fixtures/duplicate-event.json";
import photo from "../../../contracts/inbound-event/fixtures/photo.json";
import pollFailed from "../../../contracts/inbound-event/fixtures/poll-failed.json";
import reactionFromCustomer from "../../../contracts/inbound-event/fixtures/reaction-from-customer.json";
import reactionFromRosie from "../../../contracts/inbound-event/fixtures/reaction-from-rosie.json";
import sent from "../../../contracts/inbound-event/fixtures/sent.json";
import textImessage from "../../../contracts/inbound-event/fixtures/text-imessage.json";
import safetyNo from "../../../contracts/model/fixtures/safety-no.json";
import {
  durableObjectActor,
  prepareHandoff,
  type ActorNamespace,
  type HandleActorRpc,
  type InboundEvent,
  type SealedHandoff,
} from "../gateway";
import { fakeKeyStore } from "../gateway/test-support";
import { harness } from "../safety/test-support";
import type { SafetyResult } from "../safety/types";
import { logSink, openTrace, type Span, type TraceContext } from "../trace";
import { spansOfLogLines, spansOfTrace } from "../trace/hop-check";
import {
  setBatchHooks,
  setReceiptHooks,
  setSafetyDeps,
  type HandleActor,
  type InboxEntry,
  type ReceiptHandoff,
} from "./index";

type Json = Record<string, unknown>;

const BUNDLE = { hash: "a".repeat(64), build: 1 };
const TRACE = "11111111-2222-4333-8444-555555555555";
const keys = fakeKeyStore();

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

async function handoffOf(fixture: Json, overrides: Json = {}): Promise<SealedHandoff> {
  const prepared = await prepareHandoff(
    {
      event: { ...fixture, ...overrides, traceId: TRACE } as InboundEvent,
      partKey: null,
      traceId: TRACE,
      bundleId: BUNDLE,
    },
    keys,
  );
  if (prepared.door !== "actor") throw new Error("not an actor event");
  return prepared.handoff;
}

function stubOf(name: string): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(name));
}

/** The inbox over RPC: the stub's own type cannot carry the sealed event's open shape, so the call is typed here. */
function inboxOf(name: string): Promise<InboxEntry[]> {
  return (stubOf(name) as unknown as { readInbox(): Promise<InboxEntry[]> }).readInbox();
}

const ALEX = "phone:+15555550101";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("the inbox", () => {
  it("50 events sent at once to one actor are stored once each and read back in arrival order", async () => {
    const actor = door();
    const handoffs = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        handoffOf(textImessage, {
          eventId: `evt-load-${String(index).padStart(2, "0")}`,
          body: `word ${String(index)}`,
        }),
      ),
    );
    const answers = await Promise.all(handoffs.map((handoff) => actor.accept(handoff)));

    expect(answers).toEqual(Array.from({ length: 50 }, () => "written"));
    const entries = await inboxOf(ALEX);
    expect(entries.map((entry) => entry.seq)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    expect(entries.map((entry) => entry.event.eventId).sort()).toEqual(
      handoffs.map((h) => h.event.eventId).sort(),
    );
    expect(new Set(entries.map((entry) => entry.event.eventId)).size).toBe(50);
  });

  it("keeps the order in which the calls arrived", async () => {
    const actor = door();
    const ids = ["evt-order-c", "evt-order-a", "evt-order-b"];
    for (const eventId of ids) await actor.accept(await handoffOf(textImessage, { eventId }));

    const entries = await inboxOf(ALEX);
    expect(entries.map((entry) => entry.event.eventId)).toEqual(ids);
  });

  it("two concurrent retries of one event are written once", async () => {
    const actor = door();
    const handoff = await handoffOf(textImessage);
    const answers = await Promise.all(Array.from({ length: 10 }, () => actor.accept(handoff)));

    expect(answers.filter((answer) => answer === "written")).toHaveLength(1);
    expect(answers.filter((answer) => answer === "duplicate")).toHaveLength(9);
    expect(await inboxOf(ALEX)).toHaveLength(1);
  });

  it("drops duplicate-event.json (the event id of text-imessage.json) and tells the gateway 'duplicate'", async () => {
    const actor = door();
    expect(await actor.accept(await handoffOf(textImessage))).toBe("written");
    expect(await actor.accept(await handoffOf(duplicateEvent))).toBe("duplicate");

    const entries = await inboxOf(ALEX);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.traceId).toBe(TRACE);
  });

  it("stores the event sealed, as handed: no plain words, the box intact, partKey and bundle id kept", async () => {
    const actor = door();
    const handoff = { ...(await handoffOf(photo)), partKey: "part-1" };
    await actor.accept(handoff);

    const [entry] = await inboxOf(handoff.actorName);
    expect(entry?.event).toEqual(handoff.event);
    expect(entry?.event.sealed).not.toBeNull();
    expect(entry?.event.body).toBeUndefined();
    expect(entry?.partKey).toBe("part-1");
    expect(entry?.bundleId).toEqual(BUNDLE);
    expect(JSON.stringify(entry)).not.toContain("price list");
  });

  it("two handles are two actors with separate inboxes", async () => {
    const actor = door();
    await actor.accept(await handoffOf(textImessage));
    await actor.accept(await handoffOf(textImessage, { handle: { kind: "phone", address: "+15555550102" } }));

    expect(await inboxOf(ALEX)).toHaveLength(1);
    expect(await inboxOf("phone:+15555550102")).toHaveLength(1);
  });

  it("survives an actor restart: the inbox is read back from storage in order, and a known id is still dropped", async () => {
    const actor = door();
    const ids = ["evt-r-1", "evt-r-2", "evt-r-3"];
    for (const eventId of ids) await actor.accept(await handoffOf(textImessage, { eventId }));

    await evictDurableObject(stubOf(ALEX));

    const entries = await inboxOf(ALEX);
    expect(entries.map((entry) => entry.event.eventId)).toEqual(ids);
    expect(await actor.accept(await handoffOf(textImessage, { eventId: "evt-r-2" }))).toBe("duplicate");
    expect(await actor.accept(await handoffOf(textImessage, { eventId: "evt-r-4" }))).toBe("written");
    expect((await inboxOf(ALEX)).map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
  });
});

describe("turns", () => {
  it("reaction-from-rosie.json (is_from_me) is kept in order but starts no turn; a customer's reaction does", async () => {
    const actor = door();
    expect(await actor.accept(await handoffOf(reactionFromRosie))).toBe("written");
    expect(await actor.accept(await handoffOf(reactionFromCustomer))).toBe("written");

    const entries = await inboxOf(ALEX);
    expect(entries.map((entry) => [entry.event.eventId, entry.startsTurn])).toEqual([
      [reactionFromRosie.eventId, false],
      [reactionFromCustomer.eventId, true],
    ]);
  });
});

describe("receipts", () => {
  function hooks(): { calls: string[]; receipts: ReceiptHandoff[]; restore: () => void } {
    const calls: string[] = [];
    const receipts: ReceiptHandoff[] = [];
    const restore = setReceiptHooks({
      toDispatcher(receipt) {
        calls.push("dispatcher");
        receipts.push(receipt);
      },
      toClockArming() {
        calls.push("clockArming");
      },
    });
    return { calls, receipts, restore };
  }

  /** A receipt as the gateway would hand it if it ever routed one here: scrubbed, no words, nothing sealed. */
  function receiptOf(fixture: Json): SealedHandoff {
    return {
      event: { ...fixture, sealed: null } as unknown as SealedHandoff["event"],
      partKey: "part-r",
      traceId: TRACE,
      bundleId: BUNDLE,
      actorName: ALEX,
    };
  }

  it("delivered.json, sent.json and poll-failed.json go to the receipt hooks, not the inbox", async () => {
    const seen = hooks();
    try {
      const actor = door();
      for (const fixture of [delivered, sent, pollFailed]) {
        expect(await actor.accept(receiptOf(fixture))).toBe("written");
      }

      expect(seen.receipts.map((receipt) => receipt.event.kind)).toEqual(["delivered", "sent", "failed"]);
      expect(seen.receipts[0]?.partKey).toBe("part-r");
      expect(seen.calls).toEqual([
        "dispatcher",
        "clockArming",
        "dispatcher",
        "clockArming",
        "dispatcher",
        "clockArming",
      ]);
      expect(await inboxOf(ALEX)).toEqual([]);
    } finally {
      seen.restore();
    }
  });

  it("a receipt retried is passed on once", async () => {
    const seen = hooks();
    try {
      const actor = door();
      const receipt = receiptOf(delivered);
      expect(await actor.accept(receipt)).toBe("written");
      expect(await actor.accept(receipt)).toBe("duplicate");
      expect(seen.receipts).toHaveLength(1);
    } finally {
      seen.restore();
    }
  });

  it("a hook that fails makes the receipt fail, and the retry is handled again", async () => {
    let fail = true;
    const restore = setReceiptHooks({
      toDispatcher() {
        if (fail) throw new Error("dispatcher down");
      },
      toClockArming: () => undefined,
    });
    try {
      const actor = door();
      const receipt = receiptOf(delivered);
      await expect(actor.accept(receipt)).rejects.toThrow();
      fail = false;
      expect(await actor.accept(receipt)).toBe("written");
    } finally {
      restore();
    }
  });

  it("a receipt that carries sealed words is refused", async () => {
    const actor = door();
    const withWords = {
      ...(await handoffOf(textImessage)),
      event: { ...(await handoffOf(textImessage)).event, kind: "delivered" },
    };
    await expect(actor.accept(withWords)).rejects.toThrow();
    expect(await inboxOf(ALEX)).toEqual([]);
  });
});

describe("refusals and logs", () => {
  it("an event kind outside K-06's, or with no event id, is refused and stores nothing", async () => {
    const actor = door();
    const good = await handoffOf(textImessage);
    await expect(actor.accept({ ...good, event: { ...good.event, kind: "mystery" } })).rejects.toThrow();
    await expect(actor.accept({ ...good, event: { ...good.event, eventId: "" } })).rejects.toThrow();
    expect(await inboxOf(ALEX)).toEqual([]);
  });

  it("logs one span per call with the trace id and bundle id, and no word, phone number or sealed body", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const actor = door();
    const handoff = await handoffOf(textImessage);
    await actor.accept(handoff);
    await actor.accept(handoff);

    const lines = log.mock.calls.map((call) => String(call[0]));
    const spans = lines.map((line) => JSON.parse(line) as Json).filter((line) => line.msg === "span");
    expect(spans.map((span) => span.outcome)).toEqual(["ok", "dropped"]);
    expect(spans[0]?.trace_id).toBe(TRACE);
    expect(spans[0]?.bundle_id).toEqual(BUNDLE);
    const everything = lines.join("\n");
    expect(everything).not.toContain("+15555550101");
    expect(everything).not.toContain("Haircut");
    const sealed = handoff.event.sealed;
    expect(sealed).not.toBeNull();
    expect(everything).not.toContain(sealed?.ct ?? "no-ct");
  });

  it("the instance runs inside the Durable Object with its tables made", async () => {
    const tables = await runInDurableObject(stubOf(ALEX), (_instance: HandleActor, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('inbox', 'seen_receipts') ORDER BY name",
        )
        .toArray()
        .map((row) => row.name),
    );
    expect(tables).toEqual(["inbox", "seen_receipts"]);
  });
});

describe("the actor's receive span: K-08's `at` is when the call started and `ms` how long it took, on the actor's clock (T-1170)", () => {
  /** An instant before any run of this file: a span stamped on the Workers clock instead would start after every span here. */
  const T0 = Date.parse("2026-10-19T14:01:50.100Z");
  const utc = (ms: number): string => new Date(ms).toISOString();

  /** The spans logged on the test's trace, in the order K-08 judges them: by when each started, then as written. */
  function traceOf(log: MockInstance): Span[] {
    return spansOfTrace(spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0])), TRACE);
  }

  /** delivered.json as the gateway would hand it if it ever routed one here: scrubbed, no words, nothing sealed. */
  function deliveredReceipt(): SealedHandoff {
    return {
      event: { ...delivered, sealed: null },
      partKey: "part-r",
      traceId: TRACE,
      bundleId: BUNDLE,
      actorName: ALEX,
    };
  }

  it("a receipt's: `at` is the clock as the call began and `ms` the call's length, and each span its hooks write starts after it and ends inside it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // The actor's clock, moved only by the hooks: the dispatcher's takes 250 ms, then marks the part delivered in 40 ms; the
    // clock arming's arms at once, then takes 10 ms. Each hook writes its span on the receipt's trace, on the same clock.
    let now = T0;
    const traceFor = (receipt: ReceiptHandoff): TraceContext =>
      openTrace({
        openedBy: "textWebhook",
        bundleId: receipt.bundleId,
        incomingTraceId: receipt.traceId,
        sink: logSink({ environment: "test", version: "test" }),
        now: () => now,
      });
    const restores = [
      setBatchHooks({ clock: { now: () => now } }),
      setReceiptHooks({
        toDispatcher(receipt) {
          now += 250;
          const span = traceFor(receipt).start("delivered");
          now += 40;
          span.finish({ outcome: "ok", provider: "linq", eventId: receipt.event.eventId });
        },
        toClockArming(receipt) {
          traceFor(receipt).record({ hop: "clockArmed", ms: 0, outcome: "ok" });
          now += 10;
        },
      }),
    ];
    try {
      expect(await door().accept(deliveredReceipt())).toBe("written");

      // Judged in start order, the actor's span comes first, though it was written last, as the call answered.
      const trace = traceOf(log);
      expect(trace.map((span) => span.hop)).toEqual(["receive", "delivered", "clockArmed"]);
      const [receive, ...inside] = trace;
      if (receive === undefined) throw new Error("no receive span");
      expect(receive).toMatchObject({
        at: utc(T0),
        ms: 300,
        outcome: "ok",
        got: { door: "handleActor", route: "receipt", kind: "delivered" },
      });
      expect(inside.map((span) => [span.at, span.ms])).toEqual([
        [utc(T0 + 250), 40],
        [utc(T0 + 290), 0],
      ]);
      const start = Date.parse(receive.at);
      for (const span of inside) {
        expect(Date.parse(span.at)).toBeGreaterThan(start);
        expect(Date.parse(span.at) + span.ms).toBeLessThanOrEqual(start + receive.ms);
      }
    } finally {
      for (const restore of restores.reverse()) restore();
    }
  });

  it("a text's: `at` is the clock as the call began, and the safety read the call starts, on that clock, starts no earlier and inside it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const answer = safetyNo as unknown as SafetyResult;
    // One clock for the actor and its safety read, as the composition root gives them (runtime/src/wiring root.ts install);
    // the read answers No 1500 ms after it is asked.
    const h = harness(keys, { [answer.eventId]: answer }, { delayMs: 1500 });
    const restores = [setSafetyDeps(h.deps), setBatchHooks({ clock: h.clock })];
    try {
      await h.clock.advance(T0);
      expect(await door().accept(await handoffOf(textImessage, { eventId: answer.eventId }))).toBe("written");
      expect(h.read.requests.map((request) => request.eventId)).toEqual([answer.eventId]);
      await h.clock.advance(1500);
      await stubOf(ALEX).safetyIdle();

      const trace = traceOf(log);
      expect(trace.map((span) => span.hop)).toEqual(["receive", "safetyRead"]);
      const [receive, read] = trace;
      if (receive === undefined || read === undefined) throw new Error("no receive or safetyRead span");
      expect(receive).toMatchObject({
        at: utc(T0),
        outcome: "ok",
        got: { door: "handleActor", route: "inbox", kind: "text" },
        decided: { stored: true, startsTurn: true },
      });
      expect(read).toMatchObject({ at: utc(T0), ms: 1500, outcome: "ok", event_id: answer.eventId });
      expect(Date.parse(read.at)).toBeGreaterThanOrEqual(Date.parse(receive.at));
      expect(Date.parse(read.at)).toBeLessThanOrEqual(Date.parse(receive.at) + receive.ms);
    } finally {
      for (const restore of restores.reverse()) restore();
    }
  });
});
