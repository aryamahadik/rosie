// An event's turn (T-1563; ruling T-1543 card A18; K-09 v1.14 defaults 221 to 235), run inside the Workers runtime. The
// actor is the real Durable Object: its event door (../actor/event-door.ts `handEvent`, then `acceptEvent`), the real
// ordered inbox, the real turn lease with its crash path and park, the real bundle pin, and the real turn loop
// (`turnHooks`), wrapped as the root wraps it (../wiring/turn-chats.ts: each run's last text's K-06 service and chat id
// copied onto the gate request's turn). The gate is a stub (K-09 v1.14's event turn is A11's; until it lands the real gate
// checks at v1.5: card item (10)), answering the v1.14 fixtures (commit-event-id-checked.json, its held and repeat forms,
// commit-event-control-not-waiting.json) with the running turn's own ids (the lease hashes the turn id from the event id;
// the trace is the hand-off's, a UUID). After the commit: compose input, the composer, finalize and the dispatcher's wake
// are the turn's doubles (./test-support.ts). Test values only: the fixtures' stand-in ids, test words, a fictional
// 555-01xx number (rule 9).
import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import buildFrontierS102 from "../../../contracts/tool-api/fixtures/build-frontier-s1-02.json";
import commitEventControlNotWaiting from "../../../contracts/tool-api/fixtures/commit-event-control-not-waiting.json";
import commitEventIdCheckedHeld from "../../../contracts/tool-api/fixtures/commit-event-id-checked-held.json";
import commitEventIdChecked from "../../../contracts/tool-api/fixtures/commit-event-id-checked.json";
import composeInputS102 from "../../../contracts/tool-api/fixtures/compose-input-s1-02.json";
import parkTurn from "../../../contracts/data-access/fixtures/park-turn.json";
import readTurnStateAlex from "../../../contracts/data-access/fixtures/read-turn-state-alex.json";
import readTurnStateFirstText from "../../../contracts/data-access/fixtures/read-turn-state-first-text.json";
import planS102 from "../../../contracts/message-plan/fixtures/plan-s1-02.json";
import {
  LEASE_MS,
  eventIdOf,
  handEvent,
  setBatchHooks,
  setBundleDeps,
  setLeaseHooks,
  setSafetyDeps,
  turnIdOf,
  type DoorEvent,
  type EventDoorStub,
  type EventKey,
  type HandleActor,
  type PinEntry,
  type TurnEntry,
} from "../actor";
import { fakeBundles } from "../bundle/test-support";
import { words } from "../dispatch/test-support";
import { actorNameOf, durableObjectActor, type ActorNamespace, type HandleActorRpc } from "../gateway";
import type { HandleRef } from "../gateway/seal";
import { fakeKeyStore } from "../gateway/test-support";
import { setGuardDeps } from "../guard";
import { fakeTargets } from "../guard/test-support";
import { harness } from "../safety/test-support";
import type { SafetyResult } from "../safety/types";
import { chatWayOfTurnState, realStateReads } from "../wiring/real";
import { lastTextSourceOf, TurnChats } from "../wiring/turn-chats";
import { setTurnDeps, turnHooks } from "./index";
import { PASSED_ON_LINE } from "./park";
import {
  fakeDecide,
  fakeFacts,
  fakeReply,
  fakeTurnFace,
  planned,
  retarget,
  safetyNoFor,
  storedText,
  targetsAnswer,
  turnDeps,
  unplannedRow,
  until as untilWithin,
  type FakeDecide,
  type FakeFacts,
  type FakeReply,
  type FakeTurnFace,
} from "./test-support";
import type {
  ComposeInput,
  FinalizeMessageAnswer,
  FinalizeMessageRequest,
  GateAndCommitAnswer,
  ParkTurnLineRequest,
  TurnDeps,
  TurnParty,
} from "./types";

/** The hand-off's own trace id (the page call's, or the decision's), a UUID as every trace id is. */
const TRACE = "11111111-2222-4333-8444-555555555555";
/** A text's trace (the webhook's), for the text queued behind the event. */
const TEXT_TRACE = "22222222-3333-4444-8555-666666666666";
const keys = fakeKeyStore();

/** The demo owner of the v1.14 fixtures, on a fictional number. */
const DEMO = {
  handle: { kind: "phone", address: "+15555550188" } as HandleRef,
  party: {
    handleId: "handle-demo-owner",
    businessId: "biz-demo-owner",
    personId: "person-demo-owner",
    zone: "America/New_York",
  } satisfies TurnParty,
};

/** The upload's ref in commit-event-id-checked.json: the id of the key's own source, never in a span, log or park. */
const REF = commitEventIdChecked.request.input.ref;
/** The review item's ref in commit-event-control-not-waiting.json. */
const CONTROL_REF = commitEventControlNotWaiting.request.input.ref;
/** K-01's bundle v0, the one the fixtures' turns arrive under (park-turn.json). */
const BUNDLE_V0 = parkTurn.request.turn.bundleId;
/** The rows commit-event-id-checked.json's commit writes. */
const ROWS = commitEventIdChecked.outcome.written.outboxRows;

type Namespace = DurableObjectNamespace<HandleActor>;

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

interface ActorRpc extends EventDoorStub {
  readTurns(): Promise<TurnEntry[]>;
  readWaitingBatches(): Promise<number[]>;
  readPins(): Promise<PinEntry[]>;
  readInbox(): Promise<{ event: DoorEvent; traceId: string }[]>;
  safetyIdle(): Promise<void>;
  batchIdle(): Promise<void>;
}

function stubOf(handle: HandleRef): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(actorNameOf(handle)));
}

function door(): ReturnType<typeof durableObjectActor> {
  const ns = namespace();
  const adapter: ActorNamespace<DurableObjectId> = {
    idFromName: (name) => ns.idFromName(name),
    get: (id): HandleActorRpc => ns.get(id),
  };
  return durableObjectActor(adapter);
}

/** Waits until `ready` holds, polling, for up to 10 s (a machine busy with other builds is slower). */
const until = (ready: () => boolean, what: string): Promise<void> => untilWithin(ready, what, 10_000);

interface Rig {
  readonly face: FakeTurnFace;
  readonly ai: FakeDecide;
  readonly facts: FakeFacts;
  readonly reply: FakeReply;
  /** Each log line written while the test ran (spans and the dropped event's line), as written. */
  readonly lines: string[];
  readonly actor: ActorRpc;
  /** Hands an event to the demo owner's actor through the door, as A12's page call or E10's decision would. */
  hand(key: EventKey, step: string, ref: string): Promise<string>;
  /** The actor's clock moves, then its alarm runs, as the platform would at the stored time. */
  tick(ms: number): Promise<void>;
  /** Settles the safety work, the batch work and the turns' work (never while a gate call is held). */
  settle(): Promise<void>;
}

async function withRig(
  answers: Record<string, SafetyResult>,
  body: (rig: Rig) => Promise<void>,
): Promise<void> {
  const h = harness(keys, answers);
  const face = fakeTurnFace();
  const ai = fakeDecide(face.log);
  const reply = fakeReply(face.log);
  const facts = fakeFacts({ ...DEMO.party }, [commitEventIdChecked.request.now]);
  for (const [eventId, result] of Object.entries(answers)) facts.safety.set(eventId, result);
  const targets = fakeTargets();
  targets.answers.set(
    DEMO.party.handleId,
    targetsAnswer(DEMO.party.handleId, { roles: [], openQuestionIds: [], bookingIds: [] }),
  );
  // The root's copy of each run's last text's service and chat id onto the gate request's turn (turn-chats.ts).
  const chats = new TurnChats();
  const base = turnDeps(facts, face, ai, keys, reply);
  const set: TurnDeps = {
    ...base,
    toolApi: {
      ...base.toolApi,
      gateAndCommit: (request, at, trace) =>
        base.toolApi.gateAndCommit(chats.onTurn(request, trace), at, trace),
    },
  };
  // After the commit: each row's input, a plan, and finalize writing the final parts once (K-05 writePlan's rule).
  const plans = new Set<string>();
  face.composeInput = (request) => ({
    result: "compose",
    input: {
      ...(structuredClone(composeInputS102.outcome.input) as ComposeInput),
      row: request.outboxRowId,
      turn: request.caller.turnId,
    },
  });
  reply.composer.compose = () => planned(planS102);
  face.finalize = (request) => finalizeOnce(plans, request);
  reply.rows.unplanned = () => ({
    result: "rows",
    rows: ROWS.filter((row) => !plans.has(row.id)).map((row) =>
      unplannedRow(row.id, row.commitSeq, DEMO.party.handleId),
    ),
  });

  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  });
  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
  const restores = [
    setSafetyDeps({ ...h.deps, clock: { now: () => h.clock.now(), after: () => never() } }),
    setBatchHooks({ clock: h.clock }),
    setLeaseHooks(chats.around(turnHooks)),
    setBundleDeps(fakeBundles().deps),
    setTurnDeps(set),
    setGuardDeps({ targets: targets.port }),
  ];
  const rig: Rig = {
    face,
    ai,
    facts,
    reply,
    lines,
    get actor(): ActorRpc {
      return stubOf(DEMO.handle);
    },
    async hand(key, step, ref) {
      const handoff = {
        eventId: await eventIdOf(key, ref),
        key,
        step,
        ref,
        traceId: TRACE,
        handle: DEMO.handle,
        bundleId: BUNDLE_V0,
      };
      return handEvent(rig.actor, handoff, keys);
    },
    async tick(ms) {
      await h.clock.advance(ms);
      await runDurableObjectAlarm(stubOf(DEMO.handle));
    },
    async settle() {
      await rig.actor.safetyIdle();
      await rig.actor.batchIdle();
    },
  };
  try {
    await body(rig);
  } finally {
    restores.reverse().forEach((restore) => {
      restore();
    });
  }
}

/** finalizeMessage as the action layer answers it: the final parts written with the plan once per row. */
function finalizeOnce(plans: Set<string>, request: FinalizeMessageRequest): FinalizeMessageAnswer {
  const parts = {
    row: request.outboxRowId,
    channel: request.plan.channel,
    sends: [words("Test words: a row of the upload's turn.")],
    fixedLines: [],
    slotValues: [],
    threadReplyTo: null,
  };
  if (plans.has(request.outboxRowId)) return { error: "alreadyPlanned", finalParts: parts };
  plans.add(request.outboxRowId);
  return {
    outcome: "send",
    checks: [
      {
        row: request.outboxRowId,
        attempt: request.attempt,
        checked: parts,
        checks: [{ check: "fixedLines", passed: true, detail: null }],
        outcome: "send",
        questionWithdrawn: false,
        teamPaged: false,
      },
    ],
    finalParts: parts,
    questionWithdrawn: false,
    teamPageId: null,
  };
}

/** A fixture's answer with the running turn's own id and trace in place of the fixture's. */
function answerOf(
  fixture: { request: { turn: { id: string; traceId: string } }; outcome: unknown },
  turnId: string,
): GateAndCommitAnswer {
  return retarget(fixture.outcome, {
    turnId: [fixture.request.turn.id, turnId],
    traceId: [fixture.request.turn.traceId, TRACE],
  }) as GateAndCommitAnswer;
}

/** The owner's text arrives through the gateway's door: K-06's text, sealed under the handle's key, on its own trace. */
async function arriveText(eventId: string, body: string, sentAt: string): Promise<void> {
  const text = await storedText(
    { eventId, body, sentAt, traceId: TEXT_TRACE },
    DEMO.handle,
    keys,
    BUNDLE_V0,
    0,
  );
  const handoff = {
    event: text.event,
    partKey: null,
    traceId: TEXT_TRACE,
    bundleId: BUNDLE_V0,
    actorName: actorNameOf(DEMO.handle),
  };
  expect(await door().accept(handoff)).toBe("written");
}

/** The lines written that hold any of these values. */
const leaks = (lines: readonly string[], values: readonly string[]): string[] =>
  lines.filter((line) => values.some((value) => line.includes(value)));

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

/** Each test drives a real actor through its lease: room for a machine busy with other builds. */
const SLOW_MS = 20_000;

describe("the event turn's service read (real.ts realStateReads; K-05 v1.2 readTurnState phone.chatWay)", () => {
  const otherReads = { bundleSafety: null, handleDirectory: null, stoppedFlags: null, turnDirectory: null };

  it("reads the handle's phone chatWay alone, on the runtime side with no business, booking or fact", async () => {
    const asked: unknown[] = [];
    const reads = realStateReads({
      ...otherReads,
      turnChatWay: (request) => {
        asked.push(structuredClone(request));
        return Promise.resolve(structuredClone(readTurnStateAlex.outcome) as never);
      },
    });
    expect(await reads.turn.directory.chatWayOf?.({ handleId: "handle-alex" })).toBe("imessage");
    expect(asked).toEqual([{ handleId: "handle-alex", businessId: null, bookingIds: [], facts: [] }]);
  });

  it("answers null with no read bound, no phone row, or an error answer, so the event's turn runs nothing", async () => {
    expect(
      await realStateReads(otherReads).turn.directory.chatWayOf?.({ handleId: "handle-alex" }),
    ).toBeNull();
    expect(
      await realStateReads({ ...otherReads, turnChatWay: null }).turn.directory.chatWayOf?.({
        handleId: "handle-alex",
      }),
    ).toBeNull();
    expect(chatWayOfTurnState(readTurnStateFirstText.outcome)).toBeNull();
    expect(chatWayOfTurnState({ error: "notFound", table: "handles", rowId: "handle-alex" })).toBeNull();
    expect(chatWayOfTurnState({ phone: { chatWay: "" } })).toBeNull();
    expect(chatWayOfTurnState(readTurnStateAlex.outcome)).toBe("imessage");
  });
});

describe("an event's turn", { timeout: SLOW_MS }, () => {
  it("one event handed to the owner's actor runs one turn: one gate call with input event, one commit, every row composed and finalized, the dispatcher woken once", async () => {
    await withRig({}, async (rig) => {
      rig.face.gate = (request) => answerOf(commitEventIdChecked, request.turn.id);
      expect(await rig.hand("id_checked", "S1-10", REF)).toBe("written");
      await rig.settle();

      const eventId = await eventIdOf("id_checked", REF);
      const turnId = await turnIdOf([eventId]);
      const pinned = (await rig.actor.readPins()).find((pin) => pin.turnId === turnId)?.bundleId;
      expect(pinned).toBeDefined();
      // Shaped as commit-event-id-checked.json's request: the caller from the TurnParty, one event id, no joined trace, no
      // core action, neither service nor chat id on the turn, and the input's service and zone (the handle's and the
      // directory's). Equality also shows the root's copy put no K-06 pair on it.
      const fixture = commitEventIdChecked.request;
      expect(rig.face.gateCalls).toHaveLength(1);
      expect(rig.face.gateCalls[0]?.request).toEqual({
        caller: { ...fixture.caller, turnId, requestId: turnId, traceId: TRACE },
        turn: { ...fixture.turn, id: turnId, eventIds: [eventId], traceId: TRACE, bundleId: pinned },
        input: { ...fixture.input, eventId },
        core: [],
        now: fixture.now,
      });
      // The event's own id is never among the unread ids (default 233).
      expect(rig.face.gateCalls[0]?.at).toEqual({ holds: [], unread: [] });
      expect(rig.facts.chatWayReads).toEqual([DEMO.party.handleId]);
      // No texts: no frontier, decide or safety result.
      expect(rig.face.frontierCalls).toEqual([]);
      expect(rig.ai.decideCalls).toEqual([]);
      expect(rig.facts.asked).toEqual([]);
      // Step 7 for every row the commit wrote, then the dispatcher woken once with them.
      const rowIds = ROWS.map((row) => row.id);
      expect(rig.face.composeInputCalls.map((call) => call.outboxRowId).sort()).toEqual([...rowIds].sort());
      expect(rig.face.composeInputCalls.every((call) => call.caller.turnId === turnId)).toBe(true);
      expect(rig.reply.composer.composeCalls).toHaveLength(2);
      expect(rig.face.finalizeCalls.map((call) => call.outboxRowId).sort()).toEqual([...rowIds].sort());
      expect(rig.reply.dispatcher.wakes).toEqual([
        { turnId, handleId: DEMO.party.handleId, outboxRowIds: rowIds },
      ]);
      expect(rig.reply.rows.parks).toEqual([]);
      // One turn, committed, its lease given up once the reply ended.
      expect(await rig.actor.readTurns()).toEqual([
        {
          turnId,
          eventIds: [eventId],
          state: "committed",
          restart: false,
          tries: 1,
          leaseUntil: null,
          committedAt: commitEventIdChecked.outcome.committedAt,
        },
      ]);
      // The event's entry carries no K-06 service and chat id, so the root's copy finds no text source on its run.
      const inbox = await rig.actor.readInbox();
      expect(inbox.map((entry) => "service" in entry.event || "chatId" in entry.event)).toEqual([false]);
      expect(lastTextSourceOf({ eventIds: [eventId], entries: inbox as never })).toBeNull();
    });
  });

  it("no ref, number or sealed value goes into a span or a log; the gate span names the key and the step as labels", async () => {
    await withRig({}, async (rig) => {
      rig.face.gate = (request) => answerOf(commitEventIdChecked, request.turn.id);
      await rig.hand("id_checked", "S1-10", REF);
      await rig.settle();
      const spans = rig.lines.filter((line) => line.includes('"msg":"span"'));
      expect(spans.length).toBeGreaterThan(0);
      expect(
        spans.some((line) => line.includes('"key":"id_checked"') && line.includes('"step":"S1-10"')),
      ).toBe(true);
      const inbox = await rig.actor.readInbox();
      const sealed = inbox[0]?.event.sealed;
      expect(leaks(rig.lines, [REF, DEMO.handle.address, sealed?.ct ?? "-", sealed?.iv ?? "-"])).toEqual([]);
    });
  });

  it("a repeat of a known event id runs nothing", async () => {
    await withRig({}, async (rig) => {
      rig.face.gate = (request) => answerOf(commitEventIdChecked, request.turn.id);
      expect(await rig.hand("id_checked", "S1-10", REF)).toBe("written");
      await rig.settle();
      expect(await rig.hand("id_checked", "S1-10", REF)).toBe("duplicate");
      await rig.settle();
      expect(rig.face.gateCalls).toHaveLength(1);
      expect(await rig.actor.readTurns()).toHaveLength(1);
      expect(await rig.actor.readInbox()).toHaveLength(1);
    });
  });

  it("a text batch arriving meanwhile waits behind the event's turn and runs after it", async () => {
    const TEXT = "evt-demo-owner-0001";
    await withRig({ [TEXT]: safetyNoFor(TEXT) }, async (rig) => {
      rig.face.gate = (request) => answerOf(commitEventIdChecked, request.turn.id);
      rig.face.gateHold.closed = true;
      await rig.hand("id_checked", "S1-10", REF);
      await until(() => rig.face.gateCalls.length === 1, "the event's gate call");

      await arriveText(TEXT, "Done, uploaded it", "2026-10-19T14:31:06Z");
      await rig.actor.safetyIdle();
      await rig.tick(3000);
      // The batch is the lease's, and waits: it never restarts the event's turn.
      expect(await rig.actor.readWaitingBatches()).toEqual([1]);
      const eventTurn = await turnIdOf([await eventIdOf("id_checked", REF)]);
      expect((await rig.actor.readTurns()).map((turn) => turn.turnId)).toEqual([eventTurn]);

      rig.face.gateHold.closed = false;
      await rig.settle();
      const turns = await rig.actor.readTurns();
      expect(turns.map((turn) => turn.turnId)).toEqual([eventTurn, await turnIdOf([TEXT])]);
      expect(turns[0]?.state).toBe("committed");
      expect(turns[1]?.eventIds).toEqual([TEXT]);
      // The text's turn began only once the event's had committed and replied.
      const log = rig.face.log;
      expect(log.indexOf("frontier")).toBeGreaterThan(log.lastIndexOf("wake"));
      expect(rig.face.gateCalls).toHaveLength(1);
    });
  });

  it("an event waits behind a running turn of texts, and a text batch behind the event never restarts that turn", async () => {
    const FIRST = "evt-demo-owner-0001";
    const SECOND = "evt-demo-owner-0002";
    await withRig({ [FIRST]: safetyNoFor(FIRST), [SECOND]: safetyNoFor(SECOND) }, async (rig) => {
      // The first text's turn gets its context, then waits at decide for good.
      rig.face.frontier = (request) =>
        retarget(buildFrontierS102.outcome, {
          turnId: [buildFrontierS102.request.turn.id, request.turn.id],
          traceId: [buildFrontierS102.request.turn.traceId, TEXT_TRACE],
        });
      rig.ai.decide = () => new Promise(() => undefined);
      await arriveText(FIRST, "Done, uploaded it", "2026-10-19T14:31:00Z");
      await rig.actor.safetyIdle();
      await rig.tick(3000);
      await until(() => rig.ai.decideCalls.length === 1, "the first text's decide");
      const textTurn = await turnIdOf([FIRST]);

      // The event waits behind it.
      expect(await rig.hand("id_checked", "S1-10", REF)).toBe("written");
      expect((await rig.actor.readTurns()).map((turn) => turn.turnId)).toEqual([textTurn]);
      // A text after the event: its batch waits too, and the running turn is not restarted with it.
      await arriveText(SECOND, "and the back of it", "2026-10-19T14:31:08Z");
      await rig.actor.safetyIdle();
      await rig.tick(3000);
      expect(await rig.actor.readWaitingBatches()).toEqual([2]);
      expect(await rig.actor.readTurns()).toMatchObject([
        { turnId: textTurn, eventIds: [FIRST], state: "leased", restart: false, tries: 1 },
      ]);
      expect(rig.face.gateCalls).toEqual([]);
    });
  });

  it("an event not waiting (eventNotWaiting) commits nothing and sends nothing: dropped, never resent or parked", async () => {
    await withRig({}, async (rig) => {
      rig.face.gate = () => structuredClone(commitEventControlNotWaiting.outcome);
      expect(await rig.hand("control_proven", "S1-32", CONTROL_REF)).toBe("written");
      await rig.settle();
      const eventId = await eventIdOf("control_proven", CONTROL_REF);
      expect(rig.face.gateCalls).toHaveLength(1);
      expect(rig.face.gateCalls[0]?.request.input).toEqual({
        ...commitEventControlNotWaiting.request.input,
        eventId,
      });
      expect(await rig.actor.readTurns()).toMatchObject([
        { turnId: await turnIdOf([eventId]), state: "dropped", leaseUntil: null },
      ]);
      expect(rig.face.composeInputCalls).toEqual([]);
      expect(rig.reply.rows.parks).toEqual([]);
      expect(rig.reply.dispatcher.wakes).toEqual([]);
      const dropped = rig.lines.filter((line) => line.includes('"msg":"eventTurnDropped"'));
      expect(dropped).toHaveLength(1);
      expect(JSON.parse(dropped[0] ?? "{}")).toMatchObject({
        why: "eventNotWaiting",
        key: "control_proven",
        step: "S1-32",
      });
      expect(leaks(rig.lines, [CONTROL_REF, DEMO.handle.address])).toEqual([]);
      // The lapse never runs it again, and the same event handed again is dropped at the door.
      await rig.tick(LEASE_MS);
      await rig.settle();
      expect(await rig.hand("control_proven", "S1-32", CONTROL_REF)).toBe("duplicate");
      await rig.settle();
      expect(rig.face.gateCalls).toHaveLength(1);
    });
  });

  it("a held answer (commit-event-id-checked-held.json) is a commit like any other: nothing parked, nothing to send", async () => {
    await withRig({}, async (rig) => {
      rig.face.gate = (request) => answerOf(commitEventIdCheckedHeld, request.turn.id);
      await rig.hand("id_checked", "S1-10", commitEventIdCheckedHeld.request.input.ref);
      await rig.settle();
      const turnId = await turnIdOf([
        await eventIdOf("id_checked", commitEventIdCheckedHeld.request.input.ref),
      ]);
      expect(rig.face.gateCalls).toHaveLength(1);
      expect(await rig.actor.readTurns()).toMatchObject([{ turnId, state: "committed", leaseUntil: null }]);
      expect(rig.reply.rows.parks).toEqual([]);
      expect(rig.face.composeInputCalls).toEqual([]);
      expect(rig.reply.dispatcher.wakes).toEqual([
        { turnId, handleId: DEMO.party.handleId, outboxRowIds: [] },
      ]);
    });
  });

  it("a turnRefused before the commit parks the event's turn at once, with the passedOn line to the owner and no ref", async () => {
    await withRig({}, async (rig) => {
      const refusal = { error: "turnRefused", from: "walk", fault: "noServiceOrChatId", ids: [] };
      rig.face.gate = () => structuredClone(refusal);
      await rig.hand("id_checked", "S1-10", REF);
      await rig.settle();
      const eventId = await eventIdOf("id_checked", REF);
      const turnId = await turnIdOf([eventId]);
      expect(rig.face.gateCalls).toHaveLength(1);
      expect(rig.reply.rows.parks).toHaveLength(1);
      const park = rig.reply.rows.parks[0] as ParkTurnLineRequest;
      expect(park.reason).toEqual({ from: "walk", fault: "noServiceOrChatId", ids: [] });
      expect(park.turn).toMatchObject({
        id: turnId,
        handleId: DEMO.party.handleId,
        eventIds: [eventId],
        tries: 1,
      });
      expect(park.outboxRows[0].recipientHandleId).toBe(DEMO.party.handleId);
      expect(park.outboxRows[0].finalParts.fixedLines).toEqual(["passedOn"]);
      expect(JSON.stringify(park.outboxRows[0].finalParts.sends)).toContain(JSON.stringify(PASSED_ON_LINE));
      expect(JSON.stringify(park)).not.toContain(REF);
      expect(JSON.stringify(park)).not.toContain("id_checked");
      expect(await rig.actor.readTurns()).toMatchObject([{ turnId, state: "parked", leaseUntil: null }]);
      expect(rig.face.composeInputCalls).toEqual([]);
    });
  });

  it("a third lapse parks the event's turn with the passedOn line to its own handle, with nothing of the ref in the park", async () => {
    await withRig({}, async (rig) => {
      rig.face.gate = () => ({ error: "transient" });
      await rig.hand("id_checked", "S1-10", REF);
      await rig.settle();
      const eventId = await eventIdOf("id_checked", REF);
      const turnId = await turnIdOf([eventId]);
      // One resend per run, then each lapse reruns it, and the third parks it.
      expect(rig.face.gateCalls).toHaveLength(2);
      for (let lapse = 1; lapse <= 3; lapse += 1) {
        await rig.tick(LEASE_MS);
        await rig.settle();
      }
      expect(rig.face.gateCalls.map((call) => call.request.turn.tries)).toEqual([1, 1, 2, 2, 3, 3]);
      expect(rig.reply.rows.parks).toHaveLength(1);
      const park = rig.reply.rows.parks[0] as ParkTurnLineRequest;
      expect("reason" in park).toBe(false);
      expect(park.turn).toMatchObject({
        id: turnId,
        handleId: DEMO.party.handleId,
        eventIds: [eventId],
        tries: 3,
      });
      expect(park.outboxRows).toHaveLength(1);
      expect(park.outboxRows[0].recipientHandleId).toBe(DEMO.party.handleId);
      expect(park.outboxRows[0].finalParts.fixedLines).toEqual(["passedOn"]);
      expect(JSON.stringify(park)).not.toContain(REF);
      expect(JSON.stringify(park)).not.toContain("id_checked");
      expect(await rig.actor.readTurns()).toMatchObject([{ turnId, state: "parked", leaseUntil: null }]);
      expect(rig.reply.dispatcher.wakes.map((wake) => wake.handleId)).toEqual([DEMO.party.handleId]);
    });
  });

  it("a rerun carries the first run's service and zone, read once", async () => {
    await withRig({}, async (rig) => {
      rig.face.gate = (request, index) =>
        index < 2 ? { error: "transient" } : answerOf(commitEventIdChecked, request.turn.id);
      await rig.hand("id_checked", "S1-10", REF);
      await rig.settle();
      expect(rig.face.gateCalls).toHaveLength(2);
      // The handle's way and the directory's zone change before the rerun: the rerun keeps the first run's.
      rig.facts.chatWay = "sms";
      rig.facts.party = { ...DEMO.party, zone: "America/Chicago" };
      await rig.tick(LEASE_MS);
      await rig.settle();
      expect(rig.face.gateCalls).toHaveLength(3);
      expect(rig.face.gateCalls[2]?.request.turn.tries).toBe(2);
      expect(rig.face.gateCalls[2]?.request.input).toMatchObject({
        service: "imessage",
        zone: "America/New_York",
      });
      expect(rig.facts.chatWayReads).toEqual([DEMO.party.handleId]);
      expect((await rig.actor.readTurns())[0]?.state).toBe("committed");
    });
  });

  it("a handle with no Linq service runs no turn: nothing written or sent, the event dropped and logged by label", async () => {
    await withRig({}, async (rig) => {
      rig.face.gate = (request) => answerOf(commitEventIdChecked, request.turn.id);
      rig.facts.chatWay = null;
      await rig.hand("id_checked", "S1-10", REF);
      await rig.settle();
      // A stored way that is no Linq service is none either.
      rig.facts.chatWay = "email";
      await rig.hand("id_checked", "S1-10", "upload-demo-owner-2");
      await rig.settle();
      expect(rig.face.gateCalls).toEqual([]);
      expect((await rig.actor.readTurns()).map((turn) => turn.state)).toEqual(["dropped", "dropped"]);
      expect(rig.reply.rows.parks).toEqual([]);
      expect(rig.reply.dispatcher.wakes).toEqual([]);
      const dropped = rig.lines
        .filter((line) => line.includes('"msg":"eventTurnDropped"'))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(dropped.map((line) => line.why)).toEqual(["noService", "noService"]);
      expect(leaks(rig.lines, [REF, "upload-demo-owner-2", DEMO.handle.address])).toEqual([]);
    });
  });
});
