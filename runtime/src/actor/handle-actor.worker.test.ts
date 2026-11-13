// The handle actor's inbox, run inside the Workers runtime (T-244). The gateway's own hand-off code builds each sealed
// hand-off from a K-06 fixture (a fake key store; NQ-RT-1), and the actor is the real Durable Object reached through
// the gateway's door. Test method: T-1128's (runtime/src/spikes/do-test-pool/FINDINGS.md): `exports.HandleActor`,
// `reset()` after each test, `evictDurableObject` for a restart. Test values only (rule 9).
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
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
import { BUNDLE_A, fakeBundles } from "../bundle/test-support";
import { fakeKeyStore } from "../gateway/test-support";
import { harness, type Harness } from "../safety/test-support";
import type { SafetyResult } from "../safety/types";
import { beginSeq, logSink, openTrace, seqOf, type BundleId, type Span, type TraceContext } from "../trace";
import { seqProblems, spansOfLogLines, spansOfTrace } from "../trace/hop-check";
import {
  LEASE_MS,
  setBatchHooks,
  setBundleDeps,
  setLeaseHooks,
  setReceiptHooks,
  setSafetyDeps,
  turnIdOf,
  type HandleActor,
  type InboxEntry,
  type LeasedTurn,
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

  it("writes no receive span of its own for a call (K-08: one receive span per inbound event, the gateway's), keeps the trace id and bundle id, tells a known event's first trace, and logs no word, phone number or sealed body", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const actor = door();
    const handoff = await handoffOf(textImessage);
    // The two calls' outcomes are the door's answers: the gateway's one receive span says ok for the first and dropped
    // for the repeat (K-08 trace-skeleton.json and trace-duplicate-webhook.json: one receive span each, at seq 1).
    expect([await actor.accept(handoff), await actor.accept(handoff)]).toEqual(["written", "duplicate"]);

    // No span at all: the two the actor used to log were its own receive spans, and nothing else is wired to write here.
    const lines = log.mock.calls.map((call) => String(call[0]));
    const spans = lines.map((line) => JSON.parse(line) as Json).filter((line) => line.msg === "span");
    expect(spans).toEqual([]);
    // The trace id and bundle id the text arrived under are kept with its entry, and the repeat's dropped span names
    // that trace (K-08 trace-duplicate-webhook.json decided.firstTrace): the actor answers it for the gateway, through
    // the gateway's door.
    expect((await inboxOf(ALEX)).map((entry) => [entry.traceId, entry.bundleId])).toEqual([[TRACE, BUNDLE]]);
    expect(await stubOf(ALEX).firstTraceOf(handoff.event.eventId)).toBe(TRACE);
    expect(await stubOf(ALEX).firstTraceOf("evt-never-seen")).toBeNull();
    expect(await actor.firstTrace?.(handoff)).toBe(TRACE);
    const never = { ...handoff, event: { ...handoff.event, eventId: "evt-never-seen" } };
    expect(await actor.firstTrace?.(never)).toBeNull();
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

describe("a call's spans on the actor's clock (T-1170), with no receive span of the actor's own: K-08 shows one receive span per inbound event, the gateway's (T-1108)", () => {
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

  it("a receipt's: the actor writes no receive span, and each span its hooks write starts after the call began and ends inside it", async () => {
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

      // The receipt's one receive span is the gateway's (K-08 v1 hop receive: "The gateway checks the signature, drops
      // a known event id, writes the sealed event, answers 200"): the actor writes none, so the trace here holds only
      // its hooks' spans, in start order. The call began at T0 and took 300 ms on the actor's clock.
      const trace = traceOf(log);
      expect(trace.map((span) => span.hop)).toEqual(["delivered", "clockArmed"]);
      expect(now).toBe(T0 + 300);
      expect(trace.map((span) => [span.at, span.ms])).toEqual([
        [utc(T0 + 250), 40],
        [utc(T0 + 290), 0],
      ]);
      for (const span of trace) {
        expect(Date.parse(span.at)).toBeGreaterThan(T0);
        expect(Date.parse(span.at) + span.ms).toBeLessThanOrEqual(T0 + 300);
      }
    } finally {
      for (const restore of restores.reverse()) restore();
    }
  });

  it("a text's: the actor writes no receive span, and the safety read the call starts, on that clock, starts as the call began and takes the place after the gateway's spans", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const answer = safetyNo as unknown as SafetyResult;
    // One clock for the actor and its safety read, as the composition root gives them (runtime/src/wiring root.ts install);
    // the read answers No 1500 ms after it is asked.
    const h = harness(keys, { [answer.eventId]: answer }, { delayMs: 1500 });
    const restores = [setSafetyDeps(h.deps), setBatchHooks({ clock: h.clock })];
    try {
      await h.clock.advance(T0);
      // As the gateway hands a text on: its receive and scrub spans took places 1 and 2 on the trace (`seqBefore`).
      const handoff = { ...(await handoffOf(textImessage, { eventId: answer.eventId })), seqBefore: 2 };
      expect(await door().accept(handoff)).toBe("written");
      expect(h.read.requests.map((request) => request.eventId)).toEqual([answer.eventId]);
      // The call stored the text and started its read in one step, with the clock still at T0, where the call began.
      const answered = h.clock.now();
      expect(answered).toBe(T0);
      expect((await inboxOf(ALEX)).map((entry) => [entry.event.eventId, entry.startsTurn])).toEqual([
        [answer.eventId, true],
      ]);
      await h.clock.advance(1500);
      await stubOf(ALEX).safetyIdle();

      // K-08 trace-skeleton.json: the text's one receive span is the gateway's (seq 1), then scrub (seq 2), and the
      // safety read is seq 3. The actor writes no receive span, so its part of the trace starts at the safety read.
      const trace = traceOf(log);
      expect(trace.map((span) => span.hop)).toEqual(["safetyRead"]);
      const [read] = trace;
      if (read === undefined) throw new Error("no safetyRead span");
      expect(read).toMatchObject({ at: utc(T0), ms: 1500, outcome: "ok", event_id: answer.eventId, seq: 3 });
      // No earlier than the call began, and inside it: before the call answered.
      expect(Date.parse(read.at)).toBeGreaterThanOrEqual(T0);
      expect(Date.parse(read.at)).toBeLessThanOrEqual(answered);
    } finally {
      for (const restore of restores.reverse()) restore();
    }
  });
});

describe("the trace's one count of places, across the actor's writers and across a restart (T-1108; K-08 v1 README: a trace is read by ordering by seq)", () => {
  const NO = safetyNo as unknown as SafetyResult;
  /** The bundle id another text arrived under: the gateway's active id at that text's receipt. */
  const OTHER: BundleId = { hash: "b".repeat(64), build: 1 };
  // Trace ids as the gateway makes them (a UUID's hex digits, letters among them: a span names a trace as a label).
  const TURN_TRACE = "2a2a2a2a-2222-4333-8444-55555555555a";
  const JOINED_TRACE = "2b2b2b2b-2222-4333-8444-55555555555b";

  /** Every span logged so far, as written. */
  function logged(log: MockInstance): Span[] {
    return spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0]));
  }

  /** One trace's spans as K-08 reads them: in order by seq, which must be one run with no place taken twice. */
  function bySeq(log: MockInstance, traceId: string): Span[] {
    const spans = logged(log).filter((span) => span.trace_id === traceId);
    expect(seqProblems(spans).filter((problem) => problem.includes("taken twice"))).toEqual([]);
    return spans.sort((a, b) => a.seq - b.seq);
  }

  /** A text as the gateway hands it on: under its own trace and bundle id, the gateway's receive and scrub at places 1 and 2. */
  async function arrive(eventId: string, traceId: string, bundleId: BundleId): Promise<void> {
    const prepared = await prepareHandoff(
      { event: { ...textImessage, eventId, traceId }, partKey: null, traceId, bundleId },
      keys,
    );
    if (prepared.door !== "actor") throw new Error("not an actor event");
    expect(await door().accept({ ...prepared.handoff, seqBefore: 2 })).toBe("written");
  }

  /** The fake clock moves, then the alarm runs, as the platform would at the stored time; then the lent work ends. */
  async function tick(clock: { advance(ms: number): Promise<void> }, ms: number): Promise<void> {
    await clock.advance(ms);
    await runDurableObjectAlarm(stubOf(ALEX));
    await stubOf(ALEX).safetyIdle();
    await stubOf(ALEX).batchIdle();
  }

  /**
   * The harness's safety deps with a 4 s deadline that holds no timer: a fake-clock timer still waiting keeps
   * `evictDurableObject` from finishing (every read here answers at once, so the deadline never matters).
   */
  function untimed(h: Harness): Harness["deps"] {
    return {
      ...h.deps,
      clock: { now: () => h.clock.now(), after: () => new Promise<void>(() => undefined) },
    };
  }

  it("a text's safety read takes the place after the gateway's; a second text handed in under the same trace id goes on from there; and a new instance goes on from the count the actor kept, with the isolate's own lost", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const h = harness(keys, { "evt-seq-1": NO, "evt-seq-2": NO, "evt-seq-3": NO });
    const restores = [setSafetyDeps(untimed(h)), setBatchHooks({ clock: h.clock })];
    try {
      const actor = door();
      const first = { ...(await handoffOf(textImessage, { eventId: "evt-seq-1" })), seqBefore: 2 };
      expect(await actor.accept(first)).toBe("written");
      await stubOf(ALEX).safetyIdle();
      // A hand-off built by hand names no places and the same trace id: the count goes on, never back to 1.
      expect(await actor.accept(await handoffOf(textImessage, { eventId: "evt-seq-2" }))).toBe("written");
      await stubOf(ALEX).safetyIdle();
      expect(bySeq(log, TRACE).map((span) => [span.seq, span.hop, span.event_id])).toEqual([
        [3, "safetyRead", "evt-seq-1"],
        [4, "safetyRead", "evt-seq-2"],
      ]);
      // Rosie's own reaction is kept in the inbox, under its own trace, and starts no turn: no hop is to come on it.
      const reaction = await prepareHandoff(
        {
          event: { ...reactionFromRosie, traceId: JOINED_TRACE },
          partKey: null,
          traceId: JOINED_TRACE,
          bundleId: BUNDLE,
        },
        keys,
      );
      if (reaction.door !== "actor") throw new Error("not an actor event");
      expect(reaction.handoff.actorName).toBe(ALEX);
      expect(await actor.accept({ ...reaction.handoff, seqBefore: 2 })).toBe("written");
      expect([seqOf(TRACE), seqOf(JOINED_TRACE)]).toEqual([4, 2]);

      // The isolate's own counts are gone (a new isolate holds none) and the actor starts again: the next span on the
      // texts' trace takes the place after the last one the actor kept in its storage, not place 1. The reaction's
      // trace, with no hop to come, is not brought back into the isolate's memory.
      beginSeq(TRACE, 0);
      beginSeq(JOINED_TRACE, 0);
      await evictDurableObject(stubOf(ALEX));
      expect(await actor.accept(await handoffOf(textImessage, { eventId: "evt-seq-3" }))).toBe("written");
      await stubOf(ALEX).safetyIdle();
      expect(bySeq(log, TRACE).map((span) => [span.seq, span.hop, span.event_id])).toEqual([
        [3, "safetyRead", "evt-seq-1"],
        [4, "safetyRead", "evt-seq-2"],
        [5, "safetyRead", "evt-seq-3"],
      ]);
      expect([seqOf(TRACE), seqOf(JOINED_TRACE)]).toEqual([5, 0]);
    } finally {
      for (const restore of restores.reverse()) restore();
    }
  });

  it("the batch hop's spans (trace-batch-three-texts.json): their places taken before the pin's lease span, the turn's under the pinned bundle id and a joined text's under the id it arrived under, once per turn id", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const h = harness(keys, { "evt-b-1": NO, "evt-b-2": NO });
    const turns: LeasedTurn[] = [];
    const restores = [
      setSafetyDeps(untimed(h)),
      setBatchHooks({ clock: h.clock }),
      setBundleDeps(fakeBundles().deps),
      // The turn's work only notes each run it is handed: nothing commits, so the lease lapses into a rerun.
      setLeaseHooks({
        runTurn: (turn) => {
          turns.push(turn);
        },
      }),
    ];
    try {
      await arrive("evt-b-1", TURN_TRACE, BUNDLE);
      await arrive("evt-b-2", JOINED_TRACE, OTHER);
      await stubOf(ALEX).safetyIdle();
      // The actor starts again while the batch is still open, the isolate's own counts lost: each text has a hop to come,
      // so its trace's count comes back from the actor's storage as the new instance starts.
      beginSeq(TURN_TRACE, 0);
      beginSeq(JOINED_TRACE, 0);
      await evictDurableObject(stubOf(ALEX));
      // Three seconds quiet: the batch of two closes, and the lease opens their turn, whose run pins bundle A.
      await tick(h.clock, 3000);
      expect(turns.map((turn) => [turn.tries, turn.bundleId])).toEqual([[1, BUNDLE_A]]);
      const turnId = await turnIdOf(["evt-b-1", "evt-b-2"]);

      // The turn's trace: the batch span is the first to carry the turn, under the bundle pinned for it (arch 10 line
      // 548: the bundle id on every turn), and the pin's lease span comes after it by seq.
      const turnTrace = bySeq(log, TURN_TRACE);
      expect(
        turnTrace.map((span) => [span.seq, span.hop, span.outcome, span.turn_id, span.bundle_id]),
      ).toEqual([
        [3, "safetyRead", "ok", null, BUNDLE],
        [4, "batch", "ok", turnId, BUNDLE_A],
        [5, "lease", "ok", turnId, BUNDLE_A],
      ]);
      expect(turnTrace[1]?.got).toEqual({ texts: 2, eventIds: ["evt-b-1", "evt-b-2"] });
      expect(turnTrace[1]?.decided).toEqual({
        closedBy: "threeSecondsQuiet",
        turn: turnId,
        joinedTraces: [JOINED_TRACE],
      });
      // The joined text's trace ends at its batch span, under the bundle id that text arrived under: its trace's own.
      const joined = bySeq(log, JOINED_TRACE);
      expect(joined.map((span) => [span.seq, span.hop, span.outcome, span.turn_id, span.bundle_id])).toEqual([
        [3, "safetyRead", "ok", null, OTHER],
        [4, "batch", "joinedTurn", turnId, OTHER],
      ]);
      expect(joined[1]).toMatchObject({
        event_id: "evt-b-2",
        decided: { turn: turnId, turnTrace: TURN_TRACE },
      });
      // Each batch span starts no earlier than its text's safety read ended, and ends no later than the lease starts.
      const lease = turnTrace[2];
      if (lease === undefined) throw new Error("no lease span");
      for (const [read, batch] of [
        [turnTrace[0], turnTrace[1]],
        [joined[0], joined[1]],
      ]) {
        if (read === undefined || batch === undefined) throw new Error("no span");
        expect(Date.parse(batch.at)).toBeGreaterThanOrEqual(Date.parse(read.at) + read.ms);
        expect(Date.parse(batch.at) + batch.ms).toBeLessThanOrEqual(Date.parse(lease.at));
      }
      // The spans were written once the pin had answered, after the lease span's own line; their places say the order.
      const written = logged(log).filter((span) => span.trace_id === TURN_TRACE);
      expect(written.map((span) => span.hop)).toEqual(["safetyRead", "lease", "batch"]);

      // The lease lapses with no commit and the turn runs again under the same id: its pin's lease span again, and no
      // batch span again, on either trace.
      await tick(h.clock, LEASE_MS);
      expect(turns.map((turn) => turn.tries)).toEqual([1, 2]);
      expect(bySeq(log, TURN_TRACE).map((span) => [span.seq, span.hop])).toEqual([
        [3, "safetyRead"],
        [4, "batch"],
        [5, "lease"],
        [6, "lease"],
      ]);
      expect(bySeq(log, JOINED_TRACE).map((span) => span.hop)).toEqual(["safetyRead", "batch"]);
    } finally {
      for (const restore of restores.reverse()) restore();
    }
  });

  it("a run whose bundle cannot be pinned still shows its batch span before the failed lease span, under the bundle id its text arrived under", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const h = harness(keys, { "evt-b-3": NO });
    const turns: LeasedTurn[] = [];
    const restores = [
      setSafetyDeps(h.deps),
      setBatchHooks({ clock: h.clock }),
      // No bundle port is set: the pin fails as unwired, and the run's work never starts.
      setBundleDeps(null),
      setLeaseHooks({
        runTurn: (turn) => {
          turns.push(turn);
        },
      }),
    ];
    try {
      await arrive("evt-b-3", TURN_TRACE, BUNDLE);
      await stubOf(ALEX).safetyIdle();
      await tick(h.clock, 3000);
      expect(turns).toEqual([]);
      const turnId = await turnIdOf(["evt-b-3"]);
      expect(
        bySeq(log, TURN_TRACE).map((span) => [
          span.seq,
          span.hop,
          span.outcome,
          span.turn_id,
          span.bundle_id,
          span.error_code,
        ]),
      ).toEqual([
        [3, "safetyRead", "ok", null, BUNDLE, null],
        [4, "batch", "ok", turnId, BUNDLE, null],
        [5, "lease", "failed", turnId, BUNDLE, "unwired"],
      ]);
    } finally {
      for (const restore of restores.reverse()) restore();
    }
  });

  it("a restart: the new turn's batch span on the first text's trace starts at the close that restarted it, so by seq no span starts before the replaced turn's, and the text that restarted it joins", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const h = harness(keys, { "evt-r-1": NO, "evt-r-2": NO });
    const turns: LeasedTurn[] = [];
    const restores = [
      setSafetyDeps(h.deps),
      setBatchHooks({ clock: h.clock }),
      setBundleDeps(fakeBundles().deps),
      // The turn's work never commits, so a batch that closes while it runs restarts it with its text.
      setLeaseHooks({
        runTurn: (turn) => {
          turns.push(turn);
        },
      }),
    ];
    try {
      await arrive("evt-r-1", TURN_TRACE, BUNDLE);
      await stubOf(ALEX).safetyIdle();
      await tick(h.clock, 3000);
      const replaced = await turnIdOf(["evt-r-1"]);
      expect(turns.map((turn) => turn.turnId)).toEqual([replaced]);

      // A second text while that turn runs; three seconds on, its batch closes and restarts the turn with both texts.
      await arrive("evt-r-2", JOINED_TRACE, BUNDLE);
      await stubOf(ALEX).safetyIdle();
      await tick(h.clock, 3000);
      const turnId = await turnIdOf(["evt-r-1", "evt-r-2"]);
      expect(turns.map((turn) => [turn.turnId, turn.restart])).toEqual([
        [replaced, false],
        [turnId, true],
      ]);

      const first = bySeq(log, TURN_TRACE);
      expect(first.map((span) => [span.seq, span.hop, span.turn_id])).toEqual([
        [3, "safetyRead", null],
        [4, "batch", replaced],
        [5, "lease", replaced],
        [6, "batch", turnId],
        [7, "lease", turnId],
      ]);
      // By seq, no span starts before the one before it (K-08 v1 README: `at` never goes back).
      first.forEach((span, place) => {
        const before = first[place - 1];
        if (before !== undefined) expect(Date.parse(span.at)).toBeGreaterThanOrEqual(Date.parse(before.at));
      });
      expect(first[3]).toMatchObject({
        outcome: "ok",
        ms: 0,
        got: { texts: 2, eventIds: ["evt-r-1", "evt-r-2"] },
        decided: { closedBy: "threeSecondsQuiet", turn: turnId, joinedTraces: [JOINED_TRACE] },
      });
      expect(first[3]?.at).toBe(first[4]?.at);
      // The text that restarted it waited from its own read to that close, and its trace ends at its batch span.
      const joined = bySeq(log, JOINED_TRACE);
      expect(joined.map((span) => [span.seq, span.hop, span.outcome, span.turn_id])).toEqual([
        [3, "safetyRead", "ok", null],
        [4, "batch", "joinedTurn", turnId],
      ]);
      expect(joined[1]).toMatchObject({ ms: 3000, decided: { turn: turnId, turnTrace: TURN_TRACE } });
    } finally {
      for (const restore of restores.reverse()) restore();
    }
  });
});
