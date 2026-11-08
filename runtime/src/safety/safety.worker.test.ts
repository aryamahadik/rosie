// The safety read on arrival, run inside the Workers runtime (T-246). The actor is the real Durable Object reached through
// the gateway's door; the safety read, the shared core, the Linq send and the clock are doubles that answer as the frozen
// contracts state (src/safety/test-support.ts). Test method: T-1128's (runtime/src/spikes/do-test-pool/FINDINGS.md).
// Test values only (rule 9).
import { reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import textImessage from "../../../contracts/inbound-event/fixtures/text-imessage.json";
import safetyCrisisWords from "../../../contracts/model/fixtures/safety-crisis-words.json";
import safetyEmergencyNow from "../../../contracts/model/fixtures/safety-emergency-now.json";
import safetyNo from "../../../contracts/model/fixtures/safety-no.json";
import safetyThreat from "../../../contracts/model/fixtures/safety-threat.json";
import safetyTimeoutDangerWord from "../../../contracts/model/fixtures/safety-timeout-danger-word.json";
import safetyTimeoutSelfHarm from "../../../contracts/model/fixtures/safety-timeout-self-harm-word.json";
import {
  durableObjectActor,
  prepareHandoff,
  type ActorNamespace,
  type HandleActorRpc,
  type InboundEvent,
  type SealedHandoff,
} from "../gateway";
import { fakeKeyStore } from "../gateway/test-support";
import { decideLimit8 } from "../dispatch/limit8";
import type { ClaimedRow, SendState } from "../dispatch/types";
import { setSafetyDeps, type HandleActor, type HoldEntry, type SafetyEntry } from "../actor";
import { matchDangerWords, normalizeWords, timeoutResult } from "./rules";
import { FIXTURE_DANGER_WORDS, harness, type Harness } from "./test-support";
import type { SafetyResult } from "./types";

type Json = Record<string, unknown>;

const BUNDLE = { hash: "a".repeat(64), build: 1 };
const TRACE = "11111111-2222-4333-8444-555555555555";
const ALEX = "phone:+15555550101";
const keys = fakeKeyStore();

type Namespace = DurableObjectNamespace<HandleActor>;

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

function door(): ReturnType<typeof durableObjectActor> {
  const ns = namespace();
  const adapter: ActorNamespace<DurableObjectId> = {
    idFromName: (name) => ns.idFromName(name),
    get: (id): HandleActorRpc => ns.get(id),
  };
  return durableObjectActor(adapter);
}

/** The actor's safety calls over RPC: the stub's own type cannot carry the sealed event's open shape, so the calls are typed here. */
interface SafetyRpc {
  readSafety(): Promise<SafetyEntry[]>;
  readHolds(): Promise<HoldEntry[]>;
  routineHeld(): Promise<boolean>;
  markHoldReleased(holdId: string): Promise<"released" | "neverReleased" | "noSuchHold">;
  writeSafetyOnReturn(): Promise<number>;
  safetyIdle(): Promise<void>;
}

function actorOf(name = ALEX): SafetyRpc {
  return namespace().get(namespace().idFromName(name));
}

async function arrive(eventId: string, body: string): Promise<SealedHandoff> {
  const overrides: Json = { eventId, body };
  const prepared = await prepareHandoff(
    {
      event: { ...(textImessage as Json), ...overrides, traceId: TRACE } as InboundEvent,
      partKey: null,
      traceId: TRACE,
      bundleId: BUNDLE,
    },
    keys,
  );
  if (prepared.door !== "actor") throw new Error("not an actor event");
  expect(await door().accept(prepared.handoff)).toBe("written");
  return prepared.handoff;
}

/** Runs a test body with the doubles set for the isolate and put back after. */
async function withSafety(
  answers: Record<string, SafetyResult>,
  options: Parameters<typeof harness>[2],
  body: (h: Harness) => Promise<void>,
): Promise<void> {
  const h = harness(keys, answers, options);
  const restore = setSafetyDeps(h.deps);
  try {
    await body(h);
  } finally {
    restore();
  }
}

const asResult = (fixture: unknown): SafetyResult => fixture as SafetyResult;

const EMERGENCY_TEXT = "my lips are swelling after the beard color and I can't breathe well";
const CRISIS_TEXT = "I don't want to be alive anymore";
const THREAT_TEXT = "if Riley messes up my hair again I'll hurt him";
const PLAIN_TEXT = "Can I get a haircut on Thursday afternoon?";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

/** A claimed outbox row as the dispatcher would claim the one the core wrote, for limit 8's own decision. */
function claimed(sendClass: string, fixedLines: string[]): ClaimedRow {
  return {
    outboxRowId: "out-1",
    version: 1,
    commitSeq: 1,
    recipientHandleId: "handle-alex",
    recipientPersonId: "person-alex",
    businessId: "biz-lees-barbershop",
    bookingId: null,
    openQuestionId: null,
    channel: "imessage",
    sendClass,
    versionsRead: [],
    finalParts: { row: "out-1", channel: "imessage", sends: [], fixedLines, threadReplyTo: null },
    parts: [],
    traceId: TRACE,
    claim: {
      claimer: "dispatcher",
      claimedAt: "2026-11-07T22:00:00Z",
      lapsesAt: "2026-11-07T22:01:00Z",
      claimNo: 1,
      firstTryAt: null,
      nextTryNotBefore: null,
    },
    claimedFrom: "checked",
  };
}

function stoppedState(): SendState {
  return {
    stopped: true,
    chatOpen: false,
    audience: "customer",
    visitZone: null,
    businessZone: "America/New_York",
    textHours: { start: "09:00", end: "20:00" },
    textHoursOverride: false,
    currentVersions: [],
    closed: { booking: false, question: false },
  };
}

describe("a verdict with danger", () => {
  it("safety-emergency-now.json: the checked line is handed to the send path within 5 s of arrival, before any batch closes", async () => {
    const answer = asResult(safetyEmergencyNow);
    await withSafety({ [answer.eventId]: answer }, { delayMs: 1500 }, async (h) => {
      await arrive(answer.eventId, EMERGENCY_TEXT);
      expect(h.read.requests.map((request) => request.eventId)).toEqual([answer.eventId]);

      // Nothing is handed on before the read answers, and the batch (3 s quiet at the earliest) has not closed.
      expect(h.core.recorded).toHaveLength(0);
      await h.clock.advance(1500);
      await actorOf().safetyIdle();

      expect(h.core.recorded).toHaveLength(1);
      const call = h.core.recorded[0];
      expect(call?.at).toBeLessThanOrEqual(5000);
      expect(call?.at).toBeLessThan(3000);
      expect(call?.request.safety).toEqual(answer);
      expect(call?.request.sentByActor).toBeNull();
      expect(call?.request.caller.kind).toBe("job");
      expect(call?.request.handleId).toBe("handle-alex");

      const [entry] = await actorOf().readSafety();
      expect(entry).toMatchObject({
        eventId: answer.eventId,
        state: "done",
        danger: true,
        path: "outbox",
        lineId: "safetyEmergency",
        handedAfterMs: 1500,
      });
      expect(h.direct.sent).toEqual([]);
    });
  });

  it("safety-crisis-words.json holds routine work until a clear 'we're safe' releases the hold", async () => {
    const answer = asResult(safetyCrisisWords);
    await withSafety({ [answer.eventId]: answer }, {}, async (h) => {
      await arrive(answer.eventId, CRISIS_TEXT);
      await actorOf().safetyIdle();

      expect(h.core.recorded[0]?.response).toMatchObject({ safetyLine: { fixedLineId: "safetyCrisis" } });
      expect(await actorOf().readHolds()).toEqual([
        {
          eventId: answer.eventId,
          holdId: `hold-${answer.eventId}`,
          rule: "after_safe",
          blocksBooking: false,
          released: false,
        },
      ]);
      expect(await actorOf().routineHeld()).toBe(true);

      // The turn's gate released it through K-09's releaseSafetyHold after a clear "we're safe"; the actor notes it by the
      // core's hold id.
      expect(await actorOf().markHoldReleased(`hold-${answer.eventId}`)).toBe("released");
      expect(await actorOf().routineHeld()).toBe(false);
    });
  });

  it("safety-threat.json holds routine work with no release", async () => {
    const answer = asResult(safetyThreat);
    await withSafety({ [answer.eventId]: answer }, {}, async () => {
      await arrive(answer.eventId, THREAT_TEXT);
      await actorOf().safetyIdle();

      const [hold] = await actorOf().readHolds();
      expect(hold).toMatchObject({ rule: "never", released: false });
      expect(await actorOf().markHoldReleased(`hold-${answer.eventId}`)).toBe("neverReleased");
      expect(await actorOf().routineHeld()).toBe(true);
    });
  });

  it("safety-no.json releases at once: nothing is held and no outcome is handed on early", async () => {
    const answer = asResult(safetyNo);
    await withSafety({ [answer.eventId]: answer }, { delayMs: 100 }, async (h) => {
      await arrive(answer.eventId, PLAIN_TEXT);
      expect(await actorOf().routineHeld()).toBe(true); // unread until the verdict
      await h.clock.advance(100);
      await actorOf().safetyIdle();

      expect(await actorOf().routineHeld()).toBe(false);
      expect(await actorOf().readHolds()).toEqual([]);
      expect(await actorOf().readSafety()).toMatchObject([{ state: "done", danger: false, path: "none" }]);
      expect(h.core.recorded).toEqual([]);
      expect(h.core.fixed).toEqual([]);
      expect(h.direct.sent).toEqual([]);
    });
  });

  it("an at-once hold lifts after the line is handed on, through K-09's releaseSafetyHold", async () => {
    const answer: SafetyResult = {
      ...asResult(safetyNo),
      eventId: "evt-harm-1",
      read: {
        labels: [
          {
            outcome: "Harm to a child or older adult",
            tense: "now",
            evidence: "x",
            atRisk: "a",
            writer: "w",
          },
        ],
      },
      outcomes: ["Harm to a child or older adult"],
    };
    await withSafety({ [answer.eventId]: answer }, {}, async (h) => {
      await arrive(answer.eventId, "my mom's carer leaves her alone without food for days");
      await actorOf().safetyIdle();

      expect(h.core.released).toMatchObject([{ holdId: "hold-evt-harm-1", why: "outcome_message_sent" }]);
      expect(await actorOf().routineHeld()).toBe(false);
    });
  });
});

describe("a read that never answers", () => {
  it("at 4 s a danger-word text gets the safety line (911), counted as Unsure, and routine work stays held", async () => {
    const eventId = safetyTimeoutDangerWord.eventId;
    await withSafety({}, {}, async (h) => {
      await arrive(eventId, "Riley's cut won't stop bleeding, please help");
      await h.clock.advance(3999);
      await actorOf().routineHeld();
      expect(h.core.recorded).toHaveLength(0);

      await h.clock.advance(1);
      await actorOf().safetyIdle();

      expect(h.core.recorded).toHaveLength(1);
      const call = h.core.recorded[0];
      expect(call?.at).toBe(4000);
      expect(call?.request.safety).toEqual(asResult(safetyTimeoutDangerWord));
      expect(call?.response).toMatchObject({ safetyLine: { fixedLineId: "safetyEmergency" } });
      expect(h.core.fixed).toEqual([]);
      expect(await actorOf().readHolds()).toMatchObject([{ rule: "after_safe", released: false }]);
      expect(await actorOf().routineHeld()).toBe(true);
    });
  });

  it("at 4 s a self-harm word gets 988 and 911", async () => {
    const eventId = safetyTimeoutSelfHarm.eventId;
    await withSafety({}, {}, async (h) => {
      await arrive(eventId, "I don’t want to be alive anymore");
      await h.clock.advance(4000);
      await actorOf().safetyIdle();

      expect(h.core.recorded[0]?.request.safety).toEqual(asResult(safetyTimeoutSelfHarm));
      expect(h.core.recorded[0]?.response).toMatchObject({ safetyLine: { fixedLineId: "safetyCrisis" } });
      expect(await actorOf().routineHeld()).toBe(true);
    });
  });

  it("at 4 s any other text gets the outage line, and routine work stays held", async () => {
    await withSafety({}, {}, async (h) => {
      await arrive("evt-quiet-1", PLAIN_TEXT);
      await h.clock.advance(4000);
      await actorOf().safetyIdle();

      expect(h.core.recorded).toEqual([]);
      expect(h.core.fixed).toHaveLength(1);
      expect(h.core.fixed[0]?.request).toMatchObject({
        fixedLineId: "outage",
        recipientHandleId: "handle-alex",
        sendClass: "quick_reply",
        sentByActor: null,
      });
      expect(await actorOf().readHolds()).toMatchObject([{ rule: "unread", released: false }]);
      expect(await actorOf().routineHeld()).toBe(true);
    });
  });

  it("the outage line is not sent to a stopped number", async () => {
    await withSafety({}, {}, async (h) => {
      h.stopped.value = true;
      await arrive("evt-quiet-2", PLAIN_TEXT);
      await h.clock.advance(4000);
      await actorOf().safetyIdle();

      expect(h.core.fixed).toEqual([]);
      expect(h.direct.sent).toEqual([]);
      expect(await actorOf().routineHeld()).toBe(true);
    });
  });

  it("a verdict that arrives late lifts the hold of a text that got the outage line", async () => {
    const late = { ...asResult(safetyNo), eventId: "evt-late-1" };
    await withSafety({ [late.eventId]: late }, { delayMs: 6000 }, async (h) => {
      await arrive(late.eventId, PLAIN_TEXT);
      await h.clock.advance(4000);
      await actorOf().safetyIdle();
      expect(await actorOf().routineHeld()).toBe(true);

      await h.clock.advance(2000);
      await vi.waitFor(async () => {
        expect(await actorOf().routineHeld()).toBe(false);
      });
      expect(h.core.fixed).toHaveLength(1);
    });
  });

  it("an unread hold is never lifted by a release: only the read's late verdict lifts it (T-247 security note a)", async () => {
    await withSafety({}, {}, async (h) => {
      await arrive("evt-unread-1", PLAIN_TEXT);
      await h.clock.advance(4000);
      await actorOf().safetyIdle();
      expect(await actorOf().readHolds()).toEqual([
        { eventId: "evt-unread-1", holdId: null, rule: "unread", blocksBooking: false, released: false },
      ]);

      // It has no hold id to name: neither its event id nor a made-up hold id releases it.
      expect(await actorOf().markHoldReleased("evt-unread-1")).toBe("noSuchHold");
      expect(await actorOf().markHoldReleased("hold-evt-unread-1")).toBe("noSuchHold");
      expect(await actorOf().readHolds()).toMatchObject([{ rule: "unread", released: false }]);
      expect(await actorOf().routineHeld()).toBe(true);
    });
  });

  it("a hold made while PostgreSQL was down is released only once the core has recorded it, by its id (note a)", async () => {
    const answer = asResult(safetyCrisisWords);
    await withSafety({ [answer.eventId]: answer }, {}, async (h) => {
      h.core.down = true;
      await arrive(answer.eventId, CRISIS_TEXT);
      await actorOf().safetyIdle();
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: answer.eventId, rule: "after_safe", holdId: null, released: false },
      ]);
      // No hold id yet: nothing names it, so it stays held.
      expect(await actorOf().markHoldReleased(answer.eventId)).toBe("noSuchHold");
      expect(await actorOf().markHoldReleased(`hold-${answer.eventId}`)).toBe("noSuchHold");
      expect(await actorOf().routineHeld()).toBe(true);

      // Back up: the record is written and the core's hold id lands on the hold; an event id still names nothing.
      h.core.down = false;
      expect(await actorOf().writeSafetyOnReturn()).toBe(1);
      expect(await actorOf().readHolds()).toMatchObject([
        { holdId: `hold-${answer.eventId}`, released: false },
      ]);
      expect(await actorOf().markHoldReleased(answer.eventId)).toBe("noSuchHold");
      expect(await actorOf().routineHeld()).toBe(true);
      expect(await actorOf().markHoldReleased(`hold-${answer.eventId}`)).toBe("released");
      expect(await actorOf().routineHeld()).toBe(false);
    });
  });

  it("a read that fails counts as no verdict at once", async () => {
    await withSafety({}, {}, async (h) => {
      h.deps.read.read = () => Promise.reject(new Error("model down"));
      await arrive("evt-failed-1", PLAIN_TEXT);
      await actorOf().safetyIdle();

      expect(h.clock.now()).toBe(0);
      expect(h.core.fixed).toHaveLength(1);
    });
  });
});

describe("the safety line and a stopped number", () => {
  it("the safety line goes to a phone whose stopped flag is set (past any opt-out); a routine reply does not", () => {
    // The row the core writes for the safety line is send class safety; limit 8 (T-259) lets it past a stop.
    expect(
      decideLimit8({
        row: claimed("safety", ["safetyEmergency"]),
        state: stoppedState(),
        now: "2026-11-07T22:00:00Z",
        honourOverride: false,
        partOut: false,
      }),
    ).toEqual({
      action: "send",
      reason: "safety",
      overrideOptout: true,
    });
    expect(
      decideLimit8({
        row: claimed("routine", []),
        state: stoppedState(),
        now: "2026-11-07T22:00:00Z",
        honourOverride: false,
        partOut: false,
      }),
    ).toEqual({
      action: "mark",
      outcome: "droppedStopped",
      heldUntil: null,
    });
    expect(
      decideLimit8({
        row: claimed("quick_reply", ["outage"]),
        state: stoppedState(),
        now: "2026-11-07T22:00:00Z",
        honourOverride: false,
        partOut: false,
      }),
    ).toMatchObject({
      action: "mark",
      outcome: "droppedStopped",
    });
  });

  it("with PostgreSQL down, the actor sends the safety line straight through Linq to a stopped phone, past any opt-out, and writes the record on return", async () => {
    const answer = asResult(safetyEmergencyNow);
    await withSafety({ [answer.eventId]: answer }, {}, async (h) => {
      h.core.down = true;
      h.stopped.value = true;
      await arrive(answer.eventId, EMERGENCY_TEXT);
      await actorOf().safetyIdle();

      expect(h.direct.sent).toHaveLength(1);
      expect(h.direct.sent[0]).toMatchObject({
        fixedLineId: "safetyEmergency",
        overrideOptout: true,
        idempotencyKey: `safety:${answer.eventId}:safetyEmergency`,
      });
      expect(h.direct.sent[0]?.text).toContain("911");
      expect(await actorOf().readSafety()).toMatchObject([
        { path: "direct", lineId: "safetyEmergency", state: "done" },
      ]);
      expect(await actorOf().readHolds()).toMatchObject([
        { rule: "after_safe", holdId: null, released: false },
      ]);

      // Still down: nothing is written. Back up: the record goes with what the actor sent, and no second send.
      expect(await actorOf().writeSafetyOnReturn()).toBe(0);
      h.core.down = false;
      expect(await actorOf().writeSafetyOnReturn()).toBe(1);
      expect(h.core.recorded).toHaveLength(1);
      const request = h.core.recorded[0]?.request;
      expect(request?.caller.kind).toBe("actorOnReturn");
      expect(request?.sentByActor).toEqual({
        at: "1970-01-01T00:00:00.000Z",
        fixedLineId: "safetyEmergency",
        linqMessageId: "linq-1",
      });
      expect(h.direct.sent).toHaveLength(1);
      expect(await actorOf().writeSafetyOnReturn()).toBe(0);
      expect(await actorOf().readHolds()).toMatchObject([{ holdId: `hold-${answer.eventId}` }]);
    });
  });

  it("with PostgreSQL down, a crisis-words text gets the 988 and 911 line from the bundle's copy", async () => {
    const answer = asResult(safetyCrisisWords);
    await withSafety({ [answer.eventId]: answer }, {}, async (h) => {
      h.core.down = true;
      await arrive(answer.eventId, CRISIS_TEXT);
      await actorOf().safetyIdle();

      expect(h.direct.sent[0]?.fixedLineId).toBe("safetyCrisis");
      expect(h.direct.sent[0]?.text).toContain("988");
      expect(h.direct.sent[0]?.text).toContain("911");
    });
  });

  it("with PostgreSQL down, the outage line goes straight through Linq (not past an opt-out) and a failed send keeps the text held", async () => {
    await withSafety({}, {}, async (h) => {
      h.core.down = true;
      await arrive("evt-down-1", PLAIN_TEXT);
      await h.clock.advance(4000);
      await actorOf().safetyIdle();
      expect(h.direct.sent).toMatchObject([{ fixedLineId: "outage", overrideOptout: false }]);
      expect(await actorOf().routineHeld()).toBe(true);
    });
  });

  it("a safety line that cannot be sent leaves the text unresolved and routine work held", async () => {
    const answer = asResult(safetyEmergencyNow);
    await withSafety({ [answer.eventId]: answer }, {}, async (h) => {
      h.core.down = true;
      h.direct.fail = true;
      await arrive(answer.eventId, EMERGENCY_TEXT);
      await actorOf().safetyIdle();

      expect(await actorOf().readSafety()).toMatchObject([
        { state: "lineFailed", danger: true, path: "none" },
      ]);
      expect(await actorOf().routineHeld()).toBe(true);
    });
  });
});

describe("texts that arrive during a read", () => {
  it("a second text is read on its own, in arrival order, and its line does not wait for the first read", async () => {
    const first = { ...asResult(safetyNo), eventId: "evt-seq-1" };
    const second = { ...asResult(safetyEmergencyNow), eventId: "evt-seq-2" };
    await withSafety({ [second.eventId]: second }, {}, async (h) => {
      await arrive(first.eventId, "Is Thursday free?");
      await arrive(second.eventId, EMERGENCY_TEXT);
      await vi.waitFor(() => {
        expect(h.core.recorded).toHaveLength(1);
      });

      expect(h.read.requests.map((request) => request.eventId)).toEqual([first.eventId, second.eventId]);
      expect(h.read.requests.map((request) => request.words.body)).toEqual([
        "Is Thursday free?",
        EMERGENCY_TEXT,
      ]);
      // The first read never answers, yet the second text's line was handed on at once.
      expect(h.core.recorded.map((call) => call.request.safety.eventId)).toEqual([second.eventId]);
      expect(h.core.recorded[0]?.at).toBe(0);
      expect(await actorOf().routineHeld()).toBe(true);

      await h.clock.advance(4000);
      await actorOf().safetyIdle();
      expect(h.core.fixed).toHaveLength(1);
    });
  });

  it("ten texts at once are each sent to the read, once, in arrival order", async () => {
    await withSafety({}, {}, async (h) => {
      const ids = Array.from({ length: 10 }, (_, index) => `evt-ten-${String(index)}`);
      for (const eventId of ids) await arrive(eventId, `word ${eventId}`);
      await vi.waitFor(() => {
        expect(h.read.requests).toHaveLength(10);
      });
      expect(h.read.requests.map((request) => request.eventId)).toEqual(ids);
    });
  });

  it("a text with no words (a photo with no caption) is not sent to the read", async () => {
    await withSafety({}, {}, async (h) => {
      await arrive("evt-empty-1", "   ");
      await actorOf().safetyIdle();
      expect(h.read.requests).toEqual([]);
      expect(await actorOf().routineHeld()).toBe(false);
    });
  });
});

describe("what the actor keeps and logs", () => {
  it("with nothing wired, a text is stored and stays unread and held", async () => {
    await arrive("evt-unwired-1", PLAIN_TEXT);
    expect(await actorOf().readSafety()).toMatchObject([{ state: "unwired" }]);
    expect(await actorOf().routineHeld()).toBe(true);
  });

  it("logs one safetyRead span per text with ids, outcomes and times, and no word, number, line or sealed body", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const answer = asResult(safetyEmergencyNow);
    await withSafety({ [answer.eventId]: answer }, {}, async (h) => {
      const handoff = await arrive(answer.eventId, EMERGENCY_TEXT);
      await actorOf().safetyIdle();
      expect(h.core.recorded).toHaveLength(1);

      const lines = log.mock.calls.map((call) => String(call[0]));
      const spans = lines.map((line) => JSON.parse(line) as Json).filter((line) => line.hop === "safetyRead");
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({
        trace_id: TRACE,
        bundle_id: BUNDLE,
        outcome: "ok",
        event_id: answer.eventId,
      });
      const everything = lines.join("\n");
      expect(everything).not.toContain("lips are swelling");
      expect(everything).not.toContain("breathe");
      expect(everything).not.toContain("+15555550101");
      expect(everything).not.toContain("911");
      expect(everything).not.toContain(handoff.event.sealed?.ct ?? "no-ct");
    });
  });

  it("a timeout span says timedOut and which line stood in, never the matched words", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await withSafety({}, {}, async (h) => {
      await arrive(safetyTimeoutSelfHarm.eventId, CRISIS_TEXT);
      await h.clock.advance(4000);
      await actorOf().safetyIdle();

      const lines = log.mock.calls.map((call) => String(call[0]));
      const spans = lines.map((line) => JSON.parse(line) as Json).filter((line) => line.hop === "safetyRead");
      expect(spans).toMatchObject([
        { outcome: "timedOut", decided: { danger: true, lineFor: "safetyCrisis" } },
      ]);
      expect(lines.join("\n")).not.toContain("want to be alive");
    });
  });
});

describe("the rules", () => {
  it("matches the bundle's danger words whole, ignoring case, spacing and curly quotes; 'fired' is not 'fire'", () => {
    const list = FIXTURE_DANGER_WORDS;
    expect(matchDangerWords(["There is a FIRE in the back"], list).map((match) => match.words)).toEqual([
      "fire",
    ]);
    expect(matchDangerWords(["I got fired today"], list)).toEqual([]);
    expect(matchDangerWords(["I don’t   want to be alive"], list)).toMatchObject([
      { kind: "selfHarm", list: "general" },
    ]);
    expect(matchDangerWords([null, "hello"], list)).toEqual([]);
    expect(normalizeWords("  It’s  A Test ")).toBe("it's a test");
  });

  it("builds the timeout result K-02's fixtures show", () => {
    const matches = matchDangerWords(["Riley's cut won't stop bleeding"], FIXTURE_DANGER_WORDS);
    expect(timeoutResult("evt-alex-0210", matches)).toEqual(safetyTimeoutDangerWord);
    expect(timeoutResult("evt-x", []).outcomes).toEqual([]);
  });
});
