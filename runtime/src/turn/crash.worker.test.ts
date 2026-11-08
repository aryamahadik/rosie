// A crash in the middle of a turn (T-253; C-180; arch 11 line 576), run inside the Workers runtime. The actor is the real
// Durable Object reached through the gateway's door: the real safety read on arrival (its doubles answer the K-02 safety
// fixtures), the real batch window, the real turn lease with its crash path and park, the real bundle pin, and the real
// turn loop (`turnHooks`: guard, frontier, decide, gate and commit, then compose, finalize and the dispatcher's wake). The
// dispatcher woken is the real one (runtime/src/dispatch: claimOutbox in commit order, a lapsed claim taken again with its
// unsent parts under their stored keys, limit 8), over its K-05 store double and the Linq double, which answers a
// repeated key with its first message (K-11) and counts every message.
//
// A crash is either a run that never ends (its decide or its composer never answers, so the lease lapses) or the actor
// cut off (`state.abort` after its storage is synced, as T-1088's resume tests and T-248's restart test do: what the
// instance awaited lived only in memory; its storage and its alarm stay). A run cut off waits on a promise that never
// settles and on no timer, so nothing of it runs after the cut. K-05's doubles keep one plan per row, the first written
// (writePlan's alreadyPlanned), and park a turn once (park-turn.json, then `repeated`). Doubles answer the K-09, K-02,
// K-03 and K-05 fixtures with the running turn's own ids (the lease hashes the turn id from the event ids: CQ-09; the trace
// id is the text's). Test values only: the master's sample cast and the fixtures' ids, test words, phones in the
// fictional 555-01xx range (rule 9).
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import buildFrontierS102 from "../../../contracts/tool-api/fixtures/build-frontier-s1-02.json";
import commitS102 from "../../../contracts/tool-api/fixtures/commit-s1-02.json";
import composeInputS102 from "../../../contracts/tool-api/fixtures/compose-input-s1-02.json";
import batchTurnAfterArrival from "../../../contracts/tool-api/fixtures/j3-safety-arrival-batch-turn.json";
import parkTurn from "../../../contracts/data-access/fixtures/park-turn.json";
import planS102 from "../../../contracts/message-plan/fixtures/plan-s1-02.json";
import decideS102 from "../../../contracts/model/fixtures/decide-s1-02-choose.json";
import safetyEmergencyNow from "../../../contracts/model/fixtures/safety-emergency-now.json";
import {
  LEASE_MS,
  PARK_RETRY_MS,
  setBatchHooks,
  setBundleDeps,
  setLeaseHooks,
  setSafetyDeps,
  turnIdOf,
  type HandleActor,
  type TurnEntry,
} from "../actor";
import { fakeBundles } from "../bundle/test-support";
import { runDispatch, type DispatchDeps, type DispatchReport } from "../dispatch";
import {
  FakeClock as DispatchClock,
  FakeLinq,
  FakeOutboxStore,
  FakeRecipients,
  FakeSendState,
  traceCollector,
  words,
  type SeedRow,
} from "../dispatch/test-support";
import type { PlannedSend } from "../dispatch/types";
import { actorNameOf, durableObjectActor, type ActorNamespace, type HandleActorRpc } from "../gateway";
import { fakeKeyStore } from "../gateway/test-support";
import { setGuardDeps } from "../guard";
import { fakeTargets } from "../guard/test-support";
import { fixtureBundle, harness, type Harness } from "../safety/test-support";
import type { RecordSafetyOutcomeResponse, SafetyResult } from "../safety/types";
import { spanProblems, type Span } from "../trace";
import { parkedRowId, setTurnDeps, turnHooks } from "./index";
import {
  MAYA,
  SAM,
  SAM_S1_02_TARGETS,
  decided,
  fakeDecide,
  fakeFacts,
  fakeReply,
  fakeTurnFace,
  parkTurnFixture,
  planned,
  retarget,
  safetyNoFor,
  storedText,
  targetsAnswer,
  turnDeps,
  unplannedRow,
  until,
  type FakeDecide,
  type FakeFacts,
  type FakeReply,
  type FakeTurnFace,
} from "./test-support";
import type {
  ComposeInput,
  DispatchWake,
  FinalizeMessageAnswer,
  FinalizeMessageRequest,
  FinalParts,
  GateAndCommitAnswer,
  ParkTurnRequest,
  TurnDeps,
  TurnParty,
} from "./types";

type Json = Record<string, unknown>;

const TRACE = "11111111-2222-4333-8444-555555555555";
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

interface Party {
  handle: (typeof SAM)["handle"];
  party: TurnParty;
}

/** The actor's reads over RPC, typed here. */
interface ActorRpc {
  readTurns(): Promise<TurnEntry[]>;
  readWaitingBatches(): Promise<number[]>;
  safetyIdle(): Promise<void>;
  batchIdle(): Promise<void>;
}

function stubOf(who: Party): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(actorNameOf(who.handle)));
}

/** A text arrives through the gateway's door: K-06's text, sealed under the handle's key, as the gateway hands it. */
async function arrive(who: Party, eventId: string, body: string, sentAt: string): Promise<void> {
  const entry = await storedText({ eventId, body, sentAt, traceId: TRACE }, who.handle, keys, BUNDLE_V0, 0);
  const handoff = {
    event: entry.event,
    partKey: null,
    traceId: TRACE,
    bundleId: BUNDLE_V0,
    actorName: actorNameOf(who.handle),
  };
  expect(await door().accept(handoff)).toBe("written");
}

/** K-01's bundle v0, the active bundle the pin takes (active-bundle.json), and the bundle park-turn.json names. */
const BUNDLE_V0 = parkTurn.request.turn.bundleId;

/** A promise that never settles, waiting on no timer: a run that hangs, or a call in the air when the actor is cut off. */
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** The chat each recipient's rows go to (the dispatcher's recipient directory; NQ-RT-2). */
const CHATS = {
  "handle-sam": { to: SAM.handle.address, chatId: "chat-sam", service: "imessage" as const },
  "handle-maya": { to: MAYA.handle.address, chatId: "chat-maya", service: "imessage" as const },
};

// ---- the rig ---------------------------------------------------------------------------------------------------------

interface Rig {
  readonly h: Harness;
  readonly face: FakeTurnFace;
  readonly ai: FakeDecide;
  readonly facts: FakeFacts;
  readonly reply: FakeReply;
  /** K-05's plans, as the store keeps them: one per row, the first written (writePlan's alreadyPlanned). */
  readonly plans: Map<string, FinalParts>;
  /** Each plan write the store was asked for, in order, and what it did. */
  readonly planWrites: { row: string; result: "written" | "alreadyPlanned" }[];
  /** The dispatcher's K-05 store: a row with no plan yet is stale (it stops its recipient's walk, as K-05's claim does). */
  readonly outbox: FakeOutboxStore;
  readonly linq: FakeLinq;
  /** The dispatcher's clock (its claims lapse 60 s on it); it moves with the actor's. */
  readonly clock: DispatchClock;
  /** Each wake the turn gave the dispatcher, in order. */
  readonly wakes: DispatchWake[];
  /** The actor, through a stub taken now. */
  readonly actor: ActorRpc;
  /** Both clocks move, then the actor's alarm runs, as the platform would at the stored time. */
  tick(ms: number): Promise<void>;
  /** Settles the safety work, the batch work and the turns' work (never while a run hangs). */
  settle(): Promise<void>;
  /** Cuts the actor off: its memory goes, its storage and its alarm stay; a new instance follows. */
  crash(): Promise<void>;
  /** The minute sweep: a dispatcher run over every recipient's sendable rows. */
  sweep(): Promise<DispatchReport>;
  /** K-05 writes a row's plan and final parts once (writePlan; finalizeMessage writes through it). */
  writePlan(row: string, parts: FinalParts): "written" | "alreadyPlanned";
}

interface RigSpec {
  answers: Record<string, SafetyResult>;
  times: string[];
  /** The rows the dispatcher's store holds, each with no plan yet (stale): the turn's, the arrival record's, the park's. */
  outbox: SeedRow[];
  /** The rows the turn's commit writes: K-05 unplannedRows lists those that hold no plan yet. */
  turnRows: SeedRow[];
}

async function withRig(who: Party, spec: RigSpec, body: (rig: Rig) => Promise<void>): Promise<void> {
  const h = harness(keys, spec.answers);
  const face = fakeTurnFace();
  const ai = fakeDecide(face.log);
  const reply = fakeReply(face.log);
  const facts = fakeFacts(who.party, spec.times);
  for (const [eventId, result] of Object.entries(spec.answers)) facts.safety.set(eventId, result);
  const targets = fakeTargets();
  targets.answers.set(who.party.handleId, targetsAnswer(who.party.handleId, SAM_S1_02_TARGETS));

  const outbox = new FakeOutboxStore(spec.outbox);
  for (const row of spec.outbox) outbox.row(row.id).state = "stale";
  const clock = new DispatchClock();
  const linq = new FakeLinq(clock.now);
  const spans: Span[] = [];
  const dispatchDeps = (claimer: string): DispatchDeps => ({
    store: outbox,
    linq,
    recipients: new FakeRecipients(CHATS),
    sendState: new FakeSendState(),
    environment: "test",
    traceFor: traceCollector(spans),
    now: clock.now,
    claimer,
  });
  const plans = new Map<string, FinalParts>();
  const planWrites: Rig["planWrites"] = [];
  const wakes: DispatchWake[] = [];
  const set: TurnDeps = {
    ...turnDeps(facts, face, ai, keys, reply),
    dispatcher: {
      async wake(request) {
        wakes.push(structuredClone(request));
        await runDispatch(dispatchDeps("actor"), { recipientHandleId: request.handleId });
      },
    },
  };
  reply.rows.unplanned = () => ({
    result: "rows",
    rows: spec.turnRows
      .filter((row) => !plans.has(row.id))
      .map((row) => unplannedRow(row.id, row.commitSeq, row.recipient)),
  });

  // The safety read never runs a deadline timer here (every read answers at once), so a cut leaves no timer behind.
  const restores = [
    setSafetyDeps({ ...h.deps, clock: { now: () => h.clock.now(), after: () => never() } }),
    setBatchHooks({ clock: h.clock }),
    setLeaseHooks(turnHooks),
    setBundleDeps(fakeBundles().deps),
    setTurnDeps(set),
    setGuardDeps({ targets: targets.port }),
  ];
  const rig: Rig = {
    h,
    face,
    ai,
    facts,
    reply,
    plans,
    planWrites,
    outbox,
    linq,
    clock,
    wakes,
    // A stub taken before a cut is broken by it: each read takes a fresh one.
    get actor(): ActorRpc {
      return stubOf(who);
    },
    async tick(ms) {
      clock.advance(ms);
      await h.clock.advance(ms);
      await runDurableObjectAlarm(stubOf(who));
    },
    async settle() {
      await rig.actor.safetyIdle();
      await rig.actor.batchIdle();
    },
    async crash() {
      const cut = await runInDurableObject(stubOf(who), async (_, state) => {
        await state.storage.sync();
        state.abort("crash in the middle of a turn");
      }).then(
        () => "still running",
        () => "cut off",
      );
      expect(cut).toBe("cut off");
    },
    sweep: () => runDispatch(dispatchDeps("sweep")),
    writePlan(row, parts) {
      if (plans.has(row)) {
        planWrites.push({ row, result: "alreadyPlanned" });
        return "alreadyPlanned";
      }
      plans.set(row, structuredClone(parts));
      planWrites.push({ row, result: "written" });
      outbox.recompose(row, parts.sends as PlannedSend[], []);
      return "written";
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

// ---- the fixtures' answers -----------------------------------------------------------------------------------------

const S1_02 = "turn-s1-02-sam-kinds";

/** A fixture with the running turn's own turn id in place of the fixture's. */
const forTurn = <T>(value: T, from: string, to: string): T =>
  retarget(value, { turnId: [from, to], traceId: [TRACE, TRACE] });

/** The S1-02 frontier and decide, answering for whichever turn asks (decide's own answer is the test's to give). */
function answerFrontier(rig: Rig): void {
  rig.face.frontier = (request) => forTurn(buildFrontierS102.outcome, S1_02, request.turn.id);
}

const decideFor = (turnId: string) => decided(forTurn(decideS102, S1_02, turnId));

/** S1-04's question to Sam (commit-s1-02.json's row) and a second row of the same commit to Sam (a test id). */
const ROW_ASK = commitS102.outcome.written.outboxRows[0]?.id ?? "out-s1-04-sam";
const ROW_NOTE = "out-s1-04-sam-note";
const SAM_ROWS: SeedRow[] = [
  { id: ROW_ASK, recipient: "handle-sam", commitSeq: 1, sends: [] },
  { id: ROW_NOTE, recipient: "handle-sam", commitSeq: 2, sends: [] },
];

/**
 * commit-s1-02.json's committed answer for the running turn, writing both of Sam's rows; a repeat returns the first commit
 * with `repeated` and nothing written (K-05 v1 commitTurn; K-09 gateAndCommit).
 */
function committedS102(turnId: string, repeated: boolean): GateAndCommitAnswer {
  const answer = forTurn(commitS102.outcome, S1_02, turnId) as unknown as Json;
  const written = answer.written as Json;
  return {
    ...answer,
    repeated,
    written: {
      ...written,
      written: repeated ? [] : written.written,
      outboxRows: SAM_ROWS.map((row) => ({ id: row.id, commitSeq: row.commitSeq })),
    },
  } as never;
}

/** K-03's composer input for a row of the running turn (compose-input-s1-02.json's, on that row and turn). */
function composeInputFor(row: string, turnId: string): ComposeInput {
  return { ...structuredClone(composeInputS102.outcome.input), row, turn: turnId };
}

const ALL_CHECKS = [
  "fixedLines",
  "values",
  "oneQuestion",
  "neverInMessage",
  "shape",
  "lengthAndReading",
  "format",
];

/**
 * finalizeMessage as the action layer answers it (K-09 v1): the final parts written with the plan through K-05 writePlan,
 * once per row; a row that holds a plan already answers alreadyPlanned with the stored final parts.
 */
function finalizeInto(
  rig: Rig,
  request: FinalizeMessageRequest,
  sends: PlannedSend[],
): FinalizeMessageAnswer {
  const parts: FinalParts = {
    row: request.outboxRowId,
    channel: request.plan.channel,
    sends,
    fixedLines: [],
    slotValues: [],
    threadReplyTo: null,
  };
  if (rig.writePlan(request.outboxRowId, parts) === "alreadyPlanned") {
    return { error: "alreadyPlanned", finalParts: structuredClone(rig.plans.get(request.outboxRowId)) };
  }
  return {
    outcome: "send",
    checks: [
      {
        row: request.outboxRowId,
        attempt: request.attempt,
        checked: parts,
        checks: ALL_CHECKS.map((check) => ({ check, passed: true, detail: null })),
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

/** The words each row goes as (test words): S1-04's ask in two parts, the note in one. */
const ASK_SENDS = [
  words("Test words: the first part of S1-04's ask."),
  words("Test words: its second part."),
];
const NOTE_SENDS = [words("Test words: the note to Sam.")];

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

// ---- before the commit -------------------------------------------------------------------------------------------

describe("a crash before the commit", () => {
  it("a crash after the safety line and before the commit reruns the turn under the same id, and the safety line is sent once in total", async () => {
    const emergency = { ...(safetyEmergencyNow as unknown as SafetyResult), eventId: "evt-sam-0001" };
    const LINE_ROW = "out-evt-sam-0001";
    const lineText = fixtureBundle().fixedLine("safetyEmergency")?.text ?? "";
    await withRig(
      SAM,
      {
        answers: { "evt-sam-0001": emergency },
        times: [batchTurnAfterArrival.request.now],
        outbox: [{ id: LINE_ROW, recipient: "handle-sam", commitSeq: 1, sends: [], sendClass: "safety" }],
        turnRows: [],
      },
      async (rig) => {
        // The arrival record (the shared core's recordSafetyOutcome, from the actor) writes the safety line as an outbox row
        // of send class safety: the dispatcher's row, with the bundle's checked line.
        const record = rig.h.core.recordSafetyOutcome.bind(rig.h.core);
        rig.h.core.recordSafetyOutcome = async (request) => {
          const answer = await record(request);
          const row = (answer as RecordSafetyOutcomeResponse).safetyLine?.outboxRowId ?? null;
          if (row !== null) rig.outbox.recompose(row, [words(lineText)], []);
          return answer;
        };
        answerFrontier(rig);
        // The first run hangs in decide, before any commit; the rerun decides.
        rig.ai.decide = (context) => (rig.ai.decideCalls.length === 1 ? never() : decideFor(context.turnId));
        // The batch's turn commits as j3-safety-arrival-batch-turn.json shows: its recordSafetyOutcome for the text answers
        // repeated with the arrival record (the event id is the key), and it writes no outbox row of its own.
        rig.face.gate = (request, index) => {
          const fixture = forTurn(batchTurnAfterArrival.outcome, "turn-alex-0202", request.turn.id);
          const arrival = rig.h.core.recorded[0]?.response;
          return {
            ...fixture,
            repeated: index > 0,
            core: [{ call: "recordSafetyOutcome", response: { ...arrival, repeated: true }, error: null }],
          } as never;
        };

        await arrive(SAM, "evt-sam-0001", "Barbershop, plumbing, electrical", "2026-10-19T14:05:00Z");
        await rig.actor.safetyIdle();
        // Danger closed the batch at once; its turn runs and waits on decide.
        await until(() => rig.ai.decideCalls.length === 1, "the first run's decide");
        const turnId = await turnIdOf(["evt-sam-0001"]);
        expect(rig.h.core.recorded).toHaveLength(1);
        expect(rig.h.core.recorded[0]?.response).toMatchObject({
          safetyLine: { fixedLineId: "safetyEmergency", outboxRowId: LINE_ROW },
        });

        // The safety line goes (the minute sweep claims the safety row and sends it).
        const swept = await rig.sweep();
        expect(swept.rows).toEqual([
          { outboxRowId: LINE_ROW, recipientHandleId: "handle-sam", outcome: "sent", partsSent: 1 },
        ]);

        // The crash: the actor is cut off while the turn waits on decide, after the line and before the commit.
        expect(rig.face.gateCalls).toEqual([]);
        await rig.crash();
        await rig.tick(LEASE_MS);
        await rig.settle();

        // The lease lapsed on a new instance and the turn reran from its sealed texts, under the same turn id.
        expect(rig.ai.decideCalls.map((context) => context.turnId)).toEqual([turnId, turnId]);
        expect(rig.face.gateCalls.map((call) => [call.request.turn.id, call.request.turn.tries])).toEqual([
          [turnId, 2],
        ]);
        // The commit carries the text's safety record, as the read gave it; the core answers it repeated.
        expect(rig.face.gateCalls[0]?.request.core).toMatchObject([
          { call: "recordSafetyOutcome", request: { safety: emergency, handleId: "handle-sam" } },
        ]);
        expect(await rig.actor.readTurns()).toEqual([
          {
            turnId,
            eventIds: ["evt-sam-0001"],
            state: "committed",
            restart: false,
            tries: 2,
            leaseUntil: null,
            committedAt: batchTurnAfterArrival.outcome.committedAt,
          },
        ]);

        // The safety line was sent once in total: one read, one arrival record, nothing straight through Linq, and one
        // message under its one key, though the rerun committed and woke the dispatcher.
        expect(rig.h.read.requests.map((request) => request.eventId)).toEqual(["evt-sam-0001"]);
        expect(rig.h.core.recorded).toHaveLength(1);
        expect(rig.h.direct.sent).toEqual([]);
        expect(rig.wakes).toEqual([{ turnId, handleId: "handle-sam", outboxRowIds: [] }]);
        expect(rig.linq.requests.map((request) => request.idempotencyKey)).toEqual([`${LINE_ROW}/1/1`]);
        expect(rig.linq.requests[0]).toMatchObject({ text: lineText });
        expect([...rig.linq.accepted.keys()]).toEqual([`${LINE_ROW}/1/1`]);
      },
    );
  });
});

// ---- after the commit --------------------------------------------------------------------------------------------

describe("a crash after the commit", () => {
  it("composes only the rows with no plan, and the dispatcher sends the unsent part under its stored key: no message twice", async () => {
    await withRig(
      SAM,
      {
        answers: { "evt-sam-0001": safetyNoFor("evt-sam-0001") },
        times: [commitS102.request.now],
        outbox: SAM_ROWS,
        turnRows: SAM_ROWS,
      },
      async (rig) => {
        answerFrontier(rig);
        rig.ai.decide = (context) => decideFor(context.turnId);
        rig.face.gate = (request, index) => committedS102(request.turn.id, index > 0);
        rig.face.composeInput = (request) => ({
          result: "compose",
          input: composeInputFor(request.outboxRowId, request.caller.turnId),
        });
        // The first run's composer call for the note never answers: the run is in the middle of its reply.
        rig.reply.composer.compose = (input) =>
          input.row === ROW_NOTE &&
          rig.reply.composer.composeCalls.filter((call) => call.row === ROW_NOTE).length === 1
            ? never()
            : planned(planS102);
        rig.face.finalize = (request) =>
          finalizeInto(rig, request, request.outboxRowId === ROW_ASK ? ASK_SENDS : NOTE_SENDS);

        await arrive(SAM, "evt-sam-0001", "Barbershop, plumbing, electrical", "2026-10-19T14:05:00Z");
        await rig.tick(3000);
        await until(() => rig.plans.has(ROW_ASK), "the ask's plan");
        await until(
          () => rig.reply.composer.composeCalls.some((call) => call.row === ROW_NOTE),
          "the note's composer call",
        );
        const turnId = await turnIdOf(["evt-sam-0001"]);
        // Committed, and holding its lease for the reply: a later text would wait.
        expect(await rig.actor.readTurns()).toMatchObject([{ turnId, state: "committed", tries: 1 }]);
        expect((await rig.actor.readTurns())[0]?.leaseUntil).not.toBeNull();

        // The minute sweep claims the ask (the note has no plan, so it waits) and sends its first part; the run is cut off
        // before the second part reaches Linq.
        let cut = false;
        rig.linq.beforeAnswer = (request) => {
          if (request.idempotencyKey === `${ROW_ASK}/2/1` && !cut) {
            cut = true;
            return Promise.reject(new Error("the dispatcher's run was cut off"));
          }
          return Promise.resolve();
        };
        await expect(rig.sweep()).rejects.toThrow("cut off");
        expect([...rig.linq.accepted.keys()]).toEqual([`${ROW_ASK}/1/1`]);

        // The crash: the actor is cut off in the middle of the reply. The lease lapses 60 s after the commit.
        await rig.crash();
        await rig.tick(LEASE_MS);
        await rig.settle();

        // The rerun's commit answered repeated, and only the row with no plan was composed.
        expect(rig.face.gateCalls.map((call) => [call.request.turn.id, call.request.turn.tries])).toEqual([
          [turnId, 1],
          [turnId, 2],
        ]);
        expect(rig.reply.rows.unplannedReads).toEqual([turnId, turnId]);
        const composed = rig.reply.composer.composeCalls.map((input) => input.row);
        expect(composed.slice(0, 2).sort()).toEqual([ROW_NOTE, ROW_ASK].sort());
        expect(composed.slice(2)).toEqual([ROW_NOTE]);
        expect(rig.face.composeInputCalls.slice(2).map((request) => request.outboxRowId)).toEqual([ROW_NOTE]);
        expect(rig.face.finalizeCalls.map((request) => request.outboxRowId)).toEqual([ROW_ASK, ROW_NOTE]);
        expect(rig.planWrites).toEqual([
          { row: ROW_ASK, result: "written" },
          { row: ROW_NOTE, result: "written" },
        ]);

        // The dispatcher, woken once by the rerun, took the ask again (its claim had lapsed) and sent its unsent part under
        // the stored key, then the note: every part went once, and no part got a new key.
        expect(rig.wakes).toEqual([{ turnId, handleId: "handle-sam", outboxRowIds: [ROW_ASK, ROW_NOTE] }]);
        expect(rig.linq.requests.map((request) => request.idempotencyKey)).toEqual([
          `${ROW_ASK}/1/1`,
          `${ROW_ASK}/2/1`,
          `${ROW_ASK}/2/1`,
          `${ROW_NOTE}/1/1`,
        ]);
        expect([...rig.linq.accepted.keys()]).toEqual([
          `${ROW_ASK}/1/1`,
          `${ROW_ASK}/2/1`,
          `${ROW_NOTE}/1/1`,
        ]);
        expect(rig.outbox.row(ROW_ASK)).toMatchObject({ state: "sent", claim: { claimNo: 2 } });
        expect(rig.outbox.row(ROW_NOTE)).toMatchObject({ state: "sent" });
        expect(rig.outbox.row(ROW_ASK).parts.map((part) => [part.key, part.state])).toEqual([
          [`${ROW_ASK}/1/1`, "sent"],
          [`${ROW_ASK}/2/1`, "sent"],
        ]);

        // The reply ended: the lease is released.
        expect(await rig.actor.readTurns()).toEqual([
          {
            turnId,
            eventIds: ["evt-sam-0001"],
            state: "committed",
            restart: false,
            tries: 2,
            leaseUntil: null,
            committedAt: commitS102.outcome.committedAt,
          },
        ]);
      },
    );
  });

  it("concurrency: a crash during two parallel compose calls never gives one row two plans, though a plan in the air lands after the rerun read the rows", async () => {
    const FIRST_RUN_ASK = [words("Test words: the first run's ask.")];
    const RERUN_ASK = [words("Test words: the rerun's ask.")];
    await withRig(
      SAM,
      {
        answers: { "evt-sam-0001": safetyNoFor("evt-sam-0001") },
        times: [commitS102.request.now],
        outbox: SAM_ROWS,
        turnRows: SAM_ROWS,
      },
      async (rig) => {
        answerFrontier(rig);
        rig.ai.decide = (context) => decideFor(context.turnId);
        rig.face.gate = (request, index) => committedS102(request.turn.id, index > 0);
        rig.face.composeInput = (request) => ({
          result: "compose",
          input: composeInputFor(request.outboxRowId, request.caller.turnId),
        });
        // The first run composes both rows at once: the ask's call waits for the note's to start, then answers; the note's
        // never answers. The rerun's calls answer.
        const firstRun = (row: string): boolean =>
          rig.reply.composer.composeCalls.filter((call) => call.row === row).length === 1;
        rig.reply.composer.compose = async (input) => {
          if (!firstRun(input.row)) return planned(planS102);
          if (input.row === ROW_NOTE) return never();
          await until(() => firstRun(ROW_NOTE), "both composer calls to start");
          return planned(planS102);
        };
        // The first run's finalize of the ask is in the air when the actor is cut off: its write lands in K-05 only later.
        let landAsk: (() => void) | null = null;
        rig.face.finalize = (request) => {
          if (request.outboxRowId === ROW_NOTE) return finalizeInto(rig, request, NOTE_SENDS);
          const first = rig.face.finalizeCalls.filter((call) => call.outboxRowId === ROW_ASK).length === 1;
          if (!first) return finalizeInto(rig, request, RERUN_ASK);
          landAsk = () => {
            finalizeInto(rig, request, FIRST_RUN_ASK);
          };
          return never();
        };
        // The rerun reads the rows with no plan before the first run's write lands; it lands right after that read.
        const unplanned = rig.reply.rows.unplanned;
        rig.reply.rows.unplanned = (turnId) => {
          const rows = unplanned(turnId);
          if (rig.reply.rows.unplannedReads.length === 2) landAsk?.();
          return rows;
        };

        await arrive(SAM, "evt-sam-0001", "Barbershop, plumbing, electrical", "2026-10-19T14:05:00Z");
        await rig.tick(3000);
        await until(() => landAsk !== null, "the first run's finalize of the ask");
        const turnId = await turnIdOf(["evt-sam-0001"]);
        // Both composer calls started before either ended.
        const composerLog = rig.face.log.filter((line) => line.startsWith("compose:"));
        expect(composerLog.slice(0, 2).sort()).toEqual([`compose:${ROW_ASK}`, `compose:${ROW_NOTE}`]);
        expect(composerLog.slice(2)).toEqual([`compose:${ROW_ASK}:answered`]);
        expect(rig.plans.size).toBe(0);

        await rig.crash();
        await rig.tick(LEASE_MS);
        await rig.settle();

        // The rerun found both rows with no plan and composed both; the first run's plan landed in between, so the rerun's
        // finalize of the ask met alreadyPlanned and the stored plan stayed the first run's: one plan per row.
        expect(rig.face.finalizeCalls.map((request) => request.outboxRowId).sort()).toEqual(
          [ROW_ASK, ROW_ASK, ROW_NOTE].sort(),
        );
        expect(rig.planWrites.filter((write) => write.row === ROW_ASK)).toEqual([
          { row: ROW_ASK, result: "written" },
          { row: ROW_ASK, result: "alreadyPlanned" },
        ]);
        expect(rig.planWrites.filter((write) => write.row === ROW_NOTE)).toEqual([
          { row: ROW_NOTE, result: "written" },
        ]);
        expect(rig.plans.get(ROW_ASK)?.sends).toEqual(FIRST_RUN_ASK);
        // Each row went once, with the plan the store kept.
        expect(rig.linq.requests.map((request) => [request.idempotencyKey, request.text])).toEqual([
          [`${ROW_ASK}/1/1`, FIRST_RUN_ASK[0]?.text],
          [`${ROW_NOTE}/1/1`, NOTE_SENDS[0]?.text],
        ]);
        expect(await rig.actor.readTurns()).toMatchObject([
          { turnId, state: "committed", tries: 2, leaseUntil: null },
        ]);
      },
    );
  });

  it("a reply that never ends keeps the lease to its third lapse, then is given up: the inbox is freed and the next text opens a turn", async () => {
    await withRig(
      SAM,
      {
        answers: { "evt-sam-0001": safetyNoFor("evt-sam-0001"), "evt-sam-0002": safetyNoFor("evt-sam-0002") },
        times: [commitS102.request.now],
        outbox: SAM_ROWS,
        turnRows: SAM_ROWS,
      },
      async (rig) => {
        answerFrontier(rig);
        const first = await turnIdOf(["evt-sam-0001"]);
        rig.ai.decide = (context) => (context.turnId === first ? decideFor(context.turnId) : never());
        rig.face.gate = (request, index) => committedS102(request.turn.id, index > 0);
        rig.face.composeInput = (request) => ({
          result: "compose",
          input: composeInputFor(request.outboxRowId, request.caller.turnId),
        });
        // The note's composer is down on every run: the row is left with no plan, so the reply never ends.
        rig.reply.composer.compose = (input) =>
          input.row === ROW_NOTE ? { error: "modelsDown" } : planned(planS102);
        rig.face.finalize = (request) => finalizeInto(rig, request, ASK_SENDS);

        await arrive(SAM, "evt-sam-0001", "Barbershop, plumbing, electrical", "2026-10-19T14:05:00Z");
        await rig.tick(3000);
        await rig.settle();
        expect(await rig.actor.readTurns()).toMatchObject([{ turnId: first, state: "committed", tries: 1 }]);
        // A text meanwhile waits for the reply.
        await arrive(SAM, "evt-sam-0002", "and lawn care", "2026-10-19T14:05:05Z");
        await rig.tick(3000);
        await rig.settle();
        expect(await rig.actor.readWaitingBatches()).toEqual([2]);

        // Two lapses rerun it (its commit repeated each time), and only the note is composed again.
        await rig.tick(LEASE_MS);
        await rig.settle();
        await rig.tick(LEASE_MS);
        await rig.settle();
        expect(rig.face.gateCalls.map((call) => call.request.turn.tries)).toEqual([1, 2, 3]);
        expect(rig.reply.composer.composeCalls.map((input) => input.row).slice(2)).toEqual([
          ROW_NOTE,
          ROW_NOTE,
        ]);
        expect(rig.planWrites).toEqual([{ row: ROW_ASK, result: "written" }]);
        expect(await rig.actor.readWaitingBatches()).toEqual([2]);

        // The third lapse gives the reply up: no fourth try, the lease is released and the waiting text opens a turn.
        await rig.tick(LEASE_MS);
        await until(() => rig.ai.decideCalls.length === 4, "the next turn's decide");
        const next = await turnIdOf(["evt-sam-0002"]);
        expect(rig.face.gateCalls).toHaveLength(3);
        expect(await rig.actor.readTurns()).toMatchObject([
          { turnId: first, state: "committed", tries: 3, leaseUntil: null },
          { turnId: next, eventIds: ["evt-sam-0002"], state: "leased", tries: 1, restart: false },
        ]);
        expect(await rig.actor.readWaitingBatches()).toEqual([]);
      },
    );
  });
});

// ---- the park ------------------------------------------------------------------------------------------------------

/** park-turn.json's turn: Maya's text, at the fixture's time. */
const MAYA_TEXT = {
  eventId: parkTurn.request.turn.eventIds[0] ?? "evt-maya-0004",
  sentAt: "2026-11-07T15:16:00Z",
};
const MAYA_WORDS = "Test words: can I move to the 6pm class?";
/** Stand-in words for the "nothing changed" row: K-05 writes that row, and the runtime never words it. */
const NOTHING_CHANGED = "Test words: the nothing-changed line K-05's row holds.";

/** park-turn.json's request for the running turn: its turn id, the text's trace id, and the ids fixed by its turn id. */
function parkRequestFor(turnId: string): ParkTurnRequest {
  const fixture = structuredClone(parkTurn.request) as unknown as ParkTurnRequest;
  return {
    ...fixture,
    turn: { ...fixture.turn, id: turnId, traceId: TRACE },
    outboxRows: fixture.outboxRows.map((row) => ({ ...row, id: parkedRowId(turnId) })),
    events: fixture.events.map((entry) => ({ ...entry, id: `log-${turnId}-parked`, rowId: turnId })),
  };
}

describe("three crashes before the commit", () => {
  it("park the turn (park-turn.json): a park K-05 cannot take now is tried again, the next text starts a new turn, and the person gets exactly one 'nothing changed' line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const turnId = await turnIdOf([MAYA_TEXT.eventId]);
    const rowId = parkedRowId(turnId);
    await withRig(
      MAYA,
      {
        answers: {
          [MAYA_TEXT.eventId]: safetyNoFor(MAYA_TEXT.eventId),
          "evt-maya-0005": safetyNoFor("evt-maya-0005"),
        },
        times: [parkTurn.request.parkedAt],
        outbox: [{ id: rowId, recipient: "handle-maya", commitSeq: 1, sends: [], sendClass: "quick_reply" }],
        turnRows: [],
      },
      async (rig) => {
        answerFrontier(rig);
        // Every run of every turn hangs in decide: no commit ever comes.
        rig.ai.decide = () => never();
        // K-05 parkTurn (park-turn.json): the first try meets two transient answers; on the next, the park goes through
        // but its answer is lost on the way, and the same request sent again answers repeated. K-05 writes the one row.
        const k05 = parkTurnFixture();
        rig.reply.rows.park = (request) => {
          const sends = rig.reply.rows.parks.length;
          if (sends <= 2) return { error: "transient", sqlstate: "40001" };
          const answer = k05(request);
          if ("result" in answer && !answer.repeated) {
            rig.outbox.recompose(rowId, [words(NOTHING_CHANGED)], []);
          }
          if (sends === 3) throw new Error("the answer was lost");
          return answer;
        };

        await arrive(MAYA, MAYA_TEXT.eventId, MAYA_WORDS, MAYA_TEXT.sentAt);
        await rig.tick(3000);
        await until(() => rig.ai.decideCalls.length === 1, "try 1's decide");
        // Crash 1: the run hangs, and the lease lapses into try 2.
        await rig.tick(LEASE_MS);
        await until(() => rig.ai.decideCalls.length === 2, "try 2's decide");
        // Crash 2: the actor is cut off; on the new instance the lease lapses into try 3.
        await rig.crash();
        await rig.tick(LEASE_MS);
        await until(() => rig.ai.decideCalls.length === 3, "try 3's decide");
        expect(await rig.actor.readTurns()).toMatchObject([{ turnId, state: "leased", tries: 3 }]);

        // Crash 3: the third lapse with no commit parks the turn. K-05 answers transient twice: the park waits.
        await rig.tick(LEASE_MS);
        expect(rig.reply.rows.parks).toHaveLength(2);
        expect(await rig.actor.readTurns()).toMatchObject([{ turnId, state: "parking", tries: 3 }]);
        expect(rig.linq.requests).toEqual([]);

        // A text meanwhile waits for the park; no fourth try runs.
        await arrive(
          MAYA,
          "evt-maya-0005",
          "Test words: and can my friend come too?",
          "2026-11-07T15:19:20Z",
        );
        await rig.tick(3000);
        expect(await rig.actor.readWaitingBatches()).toEqual([2]);
        expect(rig.ai.decideCalls).toHaveLength(3);

        // 30 s after the first try, the park is tried again: parked (its answer lost, then repeated).
        await rig.tick(PARK_RETRY_MS - 3000);
        expect(rig.reply.rows.parks).toEqual([1, 2, 3, 4].map(() => parkRequestFor(turnId)));
        expect(rig.face.gateCalls).toEqual([]);

        // The inbox is freed: the waiting text starts a new turn of its own.
        await until(() => rig.ai.decideCalls.length === 4, "the next turn's decide");
        const next = await turnIdOf(["evt-maya-0005"]);
        expect(await rig.actor.readTurns()).toMatchObject([
          { turnId, eventIds: [MAYA_TEXT.eventId], state: "parked", tries: 3, leaseUntil: null },
          { turnId: next, eventIds: ["evt-maya-0005"], state: "leased", restart: false, tries: 1 },
        ]);
        expect(rig.face.frontierCalls[3]?.turn).toMatchObject({
          id: next,
          eventIds: ["evt-maya-0005"],
          tries: 1,
        });

        // The person got exactly one "nothing changed" line: the dispatcher, woken once for the park's row, sent it once.
        expect(rig.wakes).toEqual([{ turnId, handleId: "handle-maya", outboxRowIds: [rowId] }]);
        expect(rig.linq.requests.map((request) => [request.idempotencyKey, request.text])).toEqual([
          [`${rowId}/1/1`, NOTHING_CHANGED],
        ]);
        expect(rig.outbox.row(rowId)).toMatchObject({ state: "sent" });

        // Nothing parks again, and no second line goes.
        await rig.tick(PARK_RETRY_MS);
        expect(rig.reply.rows.parks).toHaveLength(4);
        expect(rig.linq.requests).toHaveLength(1);

        // The park's span holds labels and ids only; no log line holds the texts' words or the number.
        const spans = log.mock.calls
          .map((call) => JSON.parse(String(call[0])) as Json)
          .filter((line) => line.msg === "span" && line.turn_id === turnId && line.hop === "lease");
        const parkSpans = spans.filter((span) => (span.decided as Json | undefined)?.parked !== undefined);
        expect(
          parkSpans.map((span) => [span.outcome, (span.decided as Json).parked, span.error_code]),
        ).toEqual([
          ["failed", false, "transient"],
          ["ok", true, null],
        ]);
        for (const span of parkSpans) {
          const fields = Object.fromEntries(
            Object.entries(span).filter(([key]) => !["level", "msg", "environment", "version"].includes(key)),
          );
          expect(spanProblems(fields)).toEqual([]);
        }
        expect(parkSpans[1]?.rows).toEqual([
          { table: "turns", id: turnId },
          { table: "outbox_rows", id: rowId },
        ]);
        const lines = log.mock.calls.map((call) => String(call[0])).join("\n");
        for (const secret of [MAYA_WORDS, MAYA.handle.address]) expect(lines).not.toContain(secret);
      },
    );
  });

  it("a park K-05 answers alreadyCommitted (the third run's commit went through) finishes the turn as committed and frees the inbox", async () => {
    const turnId = await turnIdOf([MAYA_TEXT.eventId]);
    await withRig(
      MAYA,
      {
        answers: {
          [MAYA_TEXT.eventId]: safetyNoFor(MAYA_TEXT.eventId),
          "evt-maya-0005": safetyNoFor("evt-maya-0005"),
        },
        times: [parkTurn.request.parkedAt],
        outbox: [],
        turnRows: [],
      },
      async (rig) => {
        answerFrontier(rig);
        rig.ai.decide = () => never();
        rig.reply.rows.park = (request) => ({
          error: "alreadyCommitted",
          turnId: request.turn.id,
          committedAt: "2026-11-07T15:19:58Z",
        });

        await arrive(MAYA, MAYA_TEXT.eventId, MAYA_WORDS, MAYA_TEXT.sentAt);
        await rig.tick(3000);
        await rig.tick(LEASE_MS);
        await rig.tick(LEASE_MS);
        await until(() => rig.ai.decideCalls.length === 3, "try 3's decide");
        await arrive(
          MAYA,
          "evt-maya-0005",
          "Test words: and can my friend come too?",
          "2026-11-07T15:18:20Z",
        );
        await rig.tick(LEASE_MS);

        expect(rig.reply.rows.parks).toHaveLength(1);
        await until(() => rig.ai.decideCalls.length === 4, "the next turn's decide");
        expect(await rig.actor.readTurns()).toMatchObject([
          { turnId, state: "committed", tries: 3, leaseUntil: null, committedAt: "2026-11-07T15:19:58Z" },
          { eventIds: ["evt-maya-0005"], state: "leased", tries: 1 },
        ]);
        // Never parked, so no "nothing changed" line and no wake.
        expect(rig.wakes).toEqual([]);
        expect(rig.linq.requests).toEqual([]);
      },
    );
  });
});
