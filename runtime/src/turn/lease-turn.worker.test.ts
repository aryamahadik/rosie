// The turn loop inside the real actor (T-251), run inside the Workers runtime: each text goes through the gateway's door,
// the real safety read on arrival (its double answers the K-02 safety fixtures), the real batch window, the real turn
// lease (T-248, with the holds and unread texts of T-1088) and the real bundle pin (T-249, bundle v0 active), whose
// `runTurn` and commit hook are the turn loop's own (`turnHooks`). Doubles: the turn's ports (./test-support.ts) answering
// the K-09 and K-02 fixtures with the running turn's own ids (the lease hashes the turn id from the event ids, CQ-09; the
// trace id is the text's), the safety read's doubles (src/safety/test-support.ts), K-05's bundle reads
// (src/bundle/test-support.ts), K-05 v1.2's targets for the guard, and T-267's shared-core double for a STOP. The
// PostgreSQL-down path is unwired, as the composition root installs it today, unless a test wires it with its doubles
// (src/outage/db/test-support.ts, PostgreSQL answering). Spans are read from the log lines (one JSON line each, ADR-009).
// Test method: T-1128's. Test values only (rule 9).
import { heldParts } from "@rosie/actions/src/commit/hold";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import buildFrontierS102 from "../../../contracts/tool-api/fixtures/build-frontier-s1-02.json";
import commitLimit6First from "../../../contracts/tool-api/fixtures/commit-limit-6-reread-first.json";
import commitS102 from "../../../contracts/tool-api/fixtures/commit-s1-02.json";
import stopRecorded from "../../../contracts/tool-api/fixtures/stop-recorded.json";
import decideS102 from "../../../contracts/model/fixtures/decide-s1-02-choose.json";
import safetyEmergencyNow from "../../../contracts/model/fixtures/safety-emergency-now.json";
import {
  LEASE_MS,
  setBatchHooks,
  setBundleDeps,
  setLeaseHooks,
  setSafetyDeps,
  turnIdOf,
  type HandleActor,
  type HoldEntry,
  type TurnEntry,
} from "../actor";
import { BUNDLE_A, fakeBundles } from "../bundle/test-support";
import { actorNameOf, durableObjectActor, type ActorNamespace, type HandleActorRpc } from "../gateway";
import { fakeKeyStore, present } from "../gateway/test-support";
import { setGuardDeps, setReplyDeps } from "../guard";
import { fakeCore as fakeReplyCore, phone, ROSIE_NUMBER } from "../guard/replies/test-support";
import { fakeTargets, type FakeTargets } from "../guard/test-support";
import { setDbOutageDeps, type OutageView } from "../outage/db";
import { dbFakes, idsOf } from "../outage/db/test-support";
import { harness, type Harness } from "../safety/test-support";
import type { SafetyResult } from "../safety/types";
import { spanProblems } from "../trace";
import { setTurnDeps, turnHooks, turnReplyCore } from "./index";
import {
  BEN,
  SAM,
  SAM_S1_02_TARGETS,
  decided,
  fakeDecide,
  fakeFacts,
  fakeTurnFace,
  retarget,
  safetyNoFor,
  storedText,
  targetsAnswer,
  turnDeps,
  until,
  type FakeDecide,
  type FakeFacts,
  type FakeTurnFace,
} from "./test-support";
import type { BuildFrontierRequest, DecideContext, GateAndCommitRequest, TurnParty } from "./types";

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
  readHolds(): Promise<HoldEntry[]>;
  readOutage(): Promise<OutageView>;
  safetyIdle(): Promise<void>;
  batchIdle(): Promise<void>;
}

function stubOf(who: Party): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(actorNameOf(who.handle)));
}

const actorOf = (who: Party): ActorRpc => stubOf(who);

/** A text arrives through the gateway's door: K-06's text, sealed under the handle's key, as the gateway hands it. */
async function arrive(who: Party, eventId: string, body: string, sentAt: string): Promise<void> {
  const entry = await storedText({ eventId, body, sentAt, traceId: TRACE }, who.handle, keys, BUNDLE_A, 0);
  const handoff = {
    event: entry.event,
    partKey: null,
    traceId: TRACE,
    bundleId: { hash: "a".repeat(64), build: 1 },
    actorName: actorNameOf(who.handle),
  };
  expect(await door().accept(handoff)).toBe("written");
}

/**
 * A text's kept safety result is gone from the actor's own storage (ADR-015 section 2: a storage that refused both of the
 * read's writes keeps no row), after its read on arrival kept it: the row is deleted, nothing else.
 */
async function dropKeptResult(who: Party, eventId: string): Promise<void> {
  const kept = await runInDurableObject(stubOf(who), (_actor: HandleActor, state) => {
    const { sql } = state.storage;
    const rows = sql.exec("SELECT 1 FROM safety_results WHERE event_id = ? AND box IS NOT NULL", eventId);
    const had = rows.toArray().length;
    sql.exec("DELETE FROM safety_results WHERE event_id = ?", eventId);
    return had;
  });
  expect(kept).toBe(1);
}

/**
 * The read on arrival cannot keep a text's result: every seal of it fails (the seal names the actor and
 * `result:<event id>`, ADR-015 section 1), so its result stays owed (section 2): its leased turn reads none for it, and
 * every commit is handed it among the texts not read. Every other seal goes through.
 */
function owedResult(who: Party, eventId: string): void {
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  const name = `${actorNameOf(who.handle)}|result:${eventId}`;
  vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (algorithm, key, data) => {
    const named = typeof algorithm === "object" ? algorithm.additionalData : undefined;
    if (named !== undefined && new TextDecoder().decode(named) === name) throw new Error("the seal failed");
    return encrypt(algorithm, key, data);
  });
}

interface Run {
  h: Harness;
  face: FakeTurnFace;
  ai: FakeDecide;
  /**
   * The turn's own facts: who the handle is and the times its requests name. Each run reads its texts' safety results
   * through its leased turn, from what the read on arrival (answering from `h`) kept in the actor (ADR-015; T-1264).
   */
  facts: FakeFacts;
  /** K-05 v1.2 handleTargets for the guard. */
  targets: FakeTargets;
  /** The fake clock moves, then the alarm runs, as the platform would at the stored time. */
  tick(ms: number): Promise<void>;
  /** Settles the safety work, the batch work and the turns' work. */
  settle(): Promise<void>;
  actor: ActorRpc;
}

async function withTurnLoop(
  who: Party,
  answers: Record<string, SafetyResult>,
  times: string[],
  body: (run: Run) => Promise<void>,
): Promise<void> {
  const h = harness(keys, answers);
  const face = fakeTurnFace();
  const ai = fakeDecide(face.log);
  const facts = fakeFacts(who.party, times);
  const targets = fakeTargets();
  targets.answers.set(who.party.handleId, targetsAnswer(who.party.handleId, SAM_S1_02_TARGETS));
  const restores = [
    setSafetyDeps(h.deps),
    setBatchHooks({ clock: h.clock }),
    setLeaseHooks(turnHooks),
    setBundleDeps(fakeBundles().deps),
    setTurnDeps(turnDeps(facts, face, ai, keys)),
    setGuardDeps({ targets: targets.port }),
  ];
  const run: Run = {
    h,
    face,
    ai,
    facts,
    targets,
    actor: actorOf(who),
    async tick(ms) {
      await h.clock.advance(ms);
      await runDurableObjectAlarm(stubOf(who));
    },
    async settle() {
      await actorOf(who).safetyIdle();
      await actorOf(who).batchIdle();
    },
  };
  try {
    await body(run);
  } finally {
    restores.reverse().forEach((restore) => {
      restore();
    });
  }
}

/** A fixture with the running turn's own turn id in place of the fixture's. */
const forTurn = <T>(value: T, from: string, to: string): T =>
  retarget(value, { turnId: [from, to], traceId: [TRACE, TRACE] });

const S1_02 = "turn-s1-02-sam-kinds";

/** The S1-02 fixtures, answering for whichever turn asks: the frontier, decide and the gate. */
function answerS102(run: Run): void {
  run.face.frontier = (request: BuildFrontierRequest) =>
    forTurn(buildFrontierS102.outcome, S1_02, request.turn.id);
  run.ai.decide = (context: DecideContext) => decided(forTurn(decideS102, S1_02, context.turnId));
  run.face.gate = (request: GateAndCommitRequest) =>
    forTurn(commitS102.outcome, S1_02, request.turn.id) as never;
}

const LINE_FIELDS = new Set(["level", "msg", "environment", "version"]);

/** The spans logged so far: each log line whose msg is "span", as K-08's span (ADR-009's line fields left out). */
function spansOf(log: MockInstance): Json[] {
  return log.mock.calls
    .map((call) => JSON.parse(String(call[0])) as Json)
    .filter((line) => line.msg === "span")
    .map((line) => Object.fromEntries(Object.entries(line).filter(([key]) => !LINE_FIELDS.has(key))));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("the turn loop as the lease's turn", () => {
  it("inside the lease, Sam's answer to S1-02 commits commit-s1-02.json's request under the turn's own id, with the lease's CommitContext", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await withTurnLoop(
      SAM,
      { "evt-sam-0001": safetyNoFor("evt-sam-0001") },
      [buildFrontierS102.request.now, commitS102.request.now],
      async (run) => {
        answerS102(run);
        await arrive(SAM, "evt-sam-0001", "Barbershop, plumbing, electrical", "2026-10-19T14:05:00Z");
        await run.tick(3000);
        await run.settle();

        const turnId = await turnIdOf(["evt-sam-0001"]);
        const ids = {
          turnId: [S1_02, turnId] as [string, string],
          traceId: ["trace-sam-0001", TRACE] as [string, string],
        };
        expect(run.face.frontierCalls).toEqual([retarget(buildFrontierS102.request, ids)]);
        expect(run.face.gateCalls.map((call) => call.request)).toEqual([retarget(commitS102.request, ids)]);
        // The lease's own CommitContext, read at commit time: no hold open, no text unread.
        expect(run.face.gateCalls[0]?.at).toEqual({ holds: [], unread: [] });
        expect(await run.actor.readTurns()).toEqual([
          {
            turnId,
            eventIds: ["evt-sam-0001"],
            state: "committed",
            restart: false,
            tries: 1,
            leaseUntil: null,
            committedAt: commitS102.outcome.committedAt,
          },
        ]);

        // Every span of the turn carries its turn id and the pinned bundle id, passes K-08, and no line holds the words.
        // Read as K-08 reads a trace, in order by seq (README "Traces"): the first to carry the turn's id is the batch
        // span, before the lease's (trace-skeleton.json: batch at seq 4, lease at seq 5; T-1108).
        const spans = spansOf(log)
          .filter((span) => span.turn_id === turnId)
          .sort((a, b) => Number(a.seq) - Number(b.seq));
        expect(spans.map((span) => span.hop)).toEqual([
          "batch",
          "lease",
          "guard",
          "frontier",
          "decideReads",
          "gate",
          "commit",
        ]);
        for (const span of spans) {
          expect(spanProblems(span)).toEqual([]);
          expect(span.bundle_id).toEqual(BUNDLE_A);
          expect(span.trace_id).toBe(TRACE);
        }
        const lines = log.mock.calls.map((call) => String(call[0])).join("\n");
        for (const words of ["Barbershop, plumbing, electrical", "+15555550100", "Sam Lee"]) {
          expect(lines).not.toContain(words);
        }
      },
    );
  });

  it("one turn at a time: a second batch for the handle waits until this turn commits, then opens the next turn", async () => {
    await withTurnLoop(
      SAM,
      { "evt-sam-0001": safetyNoFor("evt-sam-0001"), "evt-sam-0002": safetyNoFor("evt-sam-0002") },
      [buildFrontierS102.request.now, commitS102.request.now],
      async (run) => {
        answerS102(run);
        run.face.gateHold.closed = true;
        await arrive(SAM, "evt-sam-0001", "Barbershop, plumbing, electrical", "2026-10-19T14:05:00Z");
        await run.tick(3000);
        await until(() => run.face.gateCalls.length === 1, "the first turn's commit");
        const first = await turnIdOf(["evt-sam-0001"]);
        expect(await run.actor.readTurns()).toMatchObject([{ turnId: first, state: "committing" }]);

        // A second batch closes while the first turn's commit is out: it waits, and no second turn runs.
        await arrive(SAM, "evt-sam-0002", "and lawn care", "2026-10-19T14:05:03Z");
        await run.tick(3000);
        expect(await run.actor.readWaitingBatches()).toHaveLength(1);
        expect(await run.actor.readTurns()).toMatchObject([{ turnId: first, state: "committing" }]);
        expect(run.face.frontierCalls).toHaveLength(1);
        expect(run.face.log).toEqual(["frontier", "decide", "gate"]);

        // The commit answers: the lease is released, and the waiting batch opens the next turn, which commits in turn.
        run.face.gateHold.closed = false;
        await until(() => run.face.gateCalls.length === 2, "the second turn's commit");
        await run.settle();
        const second = await turnIdOf(["evt-sam-0002"]);
        expect(run.face.log).toEqual([
          "frontier",
          "decide",
          "gate",
          "gate:answered",
          "frontier",
          "decide",
          "gate",
          "gate:answered",
        ]);
        expect(run.face.frontierCalls[1]?.turn.eventIds).toEqual(["evt-sam-0002"]);
        expect(await run.actor.readTurns()).toMatchObject([
          { turnId: first, state: "committed" },
          { turnId: second, eventIds: ["evt-sam-0002"], state: "committed", restart: false },
        ]);
        expect(await run.actor.readWaitingBatches()).toEqual([]);
      },
    );
  });

  it("a text before the commit restarts the turn once through the lease: the replaced run never reaches the gate, and the restart commits both texts once", async () => {
    await withTurnLoop(
      SAM,
      { "evt-sam-0001": safetyNoFor("evt-sam-0001"), "evt-sam-0002": safetyNoFor("evt-sam-0002") },
      [buildFrontierS102.request.now, commitS102.request.now],
      async (run) => {
        answerS102(run);
        run.ai.decideHold.closed = true;
        await arrive(SAM, "evt-sam-0001", "Barbershop, plumbing, electrical", "2026-10-19T14:05:00Z");
        await run.tick(3000);
        await until(() => run.ai.decideCalls.length === 1, "the first run's decide");

        await arrive(SAM, "evt-sam-0002", "and lawn care", "2026-10-19T14:05:03Z");
        await run.tick(3000);
        await until(() => run.ai.decideCalls.length === 2, "the restart's decide");
        run.ai.decideHold.closed = false;
        await until(() => run.face.gateCalls.length === 1, "the restart's commit");
        await run.settle();

        const first = await turnIdOf(["evt-sam-0001"]);
        const restart = await turnIdOf(["evt-sam-0001", "evt-sam-0002"]);
        expect(run.face.gateCalls.map((call) => call.request.turn.id)).toEqual([restart]);
        expect(run.face.gateCalls[0]?.request.turn.eventIds).toEqual(["evt-sam-0001", "evt-sam-0002"]);
        expect(run.face.frontierCalls.map((request) => request.turn.id)).toEqual([first, restart]);
        expect(await run.actor.readTurns()).toMatchObject([
          { turnId: first, state: "replaced" },
          { turnId: restart, state: "committed", restart: true },
        ]);
      },
    );
  });

  it("the lease's CommitContext reaches the gate unchanged: a danger text's open hold binds the commit of its own turn", async () => {
    const emergency = { ...(safetyEmergencyNow as unknown as SafetyResult), eventId: "evt-sam-0001" };
    await withTurnLoop(SAM, { "evt-sam-0001": emergency }, [commitS102.request.now], async (run) => {
      answerS102(run);
      await arrive(SAM, "evt-sam-0001", "Barbershop, plumbing, electrical", "2026-10-19T14:05:00Z");
      await run.settle();
      await run.tick(3000);
      await run.settle();

      expect(run.face.gateCalls).toHaveLength(1);
      const holds = await run.actor.readHolds();
      expect(holds).toMatchObject([
        { eventId: "evt-sam-0001", holdId: "hold-evt-sam-0001", rule: "after_safe" },
      ]);
      expect(run.face.gateCalls[0]?.at).toEqual({
        holds: [
          {
            eventId: "evt-sam-0001",
            holdId: "hold-evt-sam-0001",
            rule: "after_safe",
            outcomes: emergency.outcomes,
            blocksBooking: holds[0]?.blocksBooking,
          },
        ],
        unread: [],
      });
      // The text's own safety record rides in the commit too, as the read gave it.
      expect(run.face.gateCalls[0]?.request.core).toMatchObject([
        { call: "recordSafetyOutcome", request: { safety: emergency, handleId: "handle-sam" } },
      ]);
    });
  });

  it("a bare STOP commits through the lease as its own core-only turn, stop-recorded.json's request under the turn's own id", async () => {
    await withTurnLoop(
      BEN,
      { "evt-ben-0007": safetyNoFor("evt-ben-0007") },
      [stopRecorded.request.now],
      async (run) => {
        const turnId = await turnIdOf(["evt-ben-0007"]);
        const core = fakeReplyCore(stopRecorded.request.now, [
          phone("+15555550131", "handle-ben", "person-ben", 3),
        ]);
        core.ids.set(turnId, { consent: "consent-ben-stop", reply: "out-ben-stop-reply" });
        run.face.gate = async (request) => {
          const answer = await core.core.commitCore({
            caller: request.caller as never,
            actions: request.core.slice(1) as never,
          });
          if ("error" in answer) return answer;
          return {
            ...forTurn(stopRecorded.outcome, "turn-ben-stop", turnId),
            core: [stopRecorded.outcome.core[0], ...answer.core],
          } as never;
        };
        const restoreReplies = setReplyDeps({
          core: turnReplyCore,
          rows: core.rows,
          rosieNumber: ROSIE_NUMBER,
        });
        try {
          await arrive(BEN, "evt-ben-0007", "STOP", "2026-10-21T19:30:00Z");
          await run.tick(3000);
          await run.settle();
        } finally {
          restoreReplies();
        }

        const ids = {
          turnId: ["turn-ben-stop", turnId] as [string, string],
          traceId: ["trace-ben-0007", TRACE] as [string, string],
        };
        expect(run.face.gateCalls.map((call) => call.request)).toEqual([retarget(stopRecorded.request, ids)]);
        expect(run.face.frontierCalls).toEqual([]);
        expect(run.ai.decideCalls).toEqual([]);
        expect(core.outbox.get("out-ben-stop-reply")?.finalParts?.fixedLines).toEqual(["stopReply"]);
        expect(await run.actor.readTurns()).toMatchObject([{ turnId, state: "committed" }]);
      },
    );
  });
});

describe("a STOP through the lease never waits for a missing result or the decided part (ADR-015 card C; DL-508)", () => {
  const SAM_PHONE = "+15555550100";

  /**
   * The S1-02 answers under the running turn's id, with T-267's shared-core double over Sam's phone behind the gate (each
   * commit's keyword actions, after the records), and the replies committing through the turn.
   */
  function gateOverSamCore(run: Run): { core: ReturnType<typeof fakeReplyCore>; restore: () => void } {
    answerS102(run);
    const core = fakeReplyCore(commitS102.request.now, [phone(SAM_PHONE, "handle-sam", "person-sam", 3)]);
    run.face.gate = async (request: GateAndCommitRequest) => {
      const records = request.core.filter((action) => action.call === "recordSafetyOutcome");
      const answer = await core.core.commitCore({
        caller: request.caller as never,
        actions: request.core.slice(records.length) as never,
      });
      if ("error" in answer) return answer;
      const outcome = forTurn(commitS102.outcome, S1_02, request.turn.id);
      return {
        ...outcome,
        parts: request.input.kind === "decided" ? outcome.parts : [],
        core: [...records.map(() => outcome.core[0]), ...answer.core],
      } as never;
    };
    const restore = setReplyDeps({ core: turnReplyCore, rows: core.rows, rosieNumber: ROSIE_NUMBER });
    return { core, restore };
  }

  /** A request's core actions, in order: each text's record by its event id, a STOP's record by its kind and event. */
  const coreOf = (request: GateAndCommitRequest | undefined): string[][] =>
    (request?.core ?? []).map((action) => {
      const body = action.request as { safety?: { eventId: string }; kind?: string; inboundEventId?: string };
      return action.call === "recordSafetyOutcome"
        ? [action.call, body.safety?.eventId ?? ""]
        : [action.call, body.kind ?? "", body.inboundEventId ?? ""];
    });

  /**
   * The texts arrive, their batch goes to the lease, the turn makes its `gateCalls` gate calls (one unless given) and
   * commits, and its lease's 60 s lapse then passes.
   */
  async function arriveAndRun(run: Run, texts: [string, string, string][], gateCalls = 1): Promise<void> {
    for (const [eventId, body, sentAt] of texts) await arrive(SAM, eventId, body, sentAt);
    await run.settle();
    await run.tick(3000);
    await run.settle();
    await until(() => run.face.gateCalls.length >= gateCalls, "the turn's commit");
    await run.settle();
    await run.tick(61_000);
    await run.settle();
  }

  it("a decided text, a text whose result the turn cannot read and a STOP, one batch, commit on the turn's first run with the decided input: no rerun at the lapse, no park", async () => {
    const ids = ["evt-sam-0001", "evt-sam-0002", "evt-sam-0003"];
    await withTurnLoop(
      SAM,
      Object.fromEntries(ids.map((eventId) => [eventId, safetyNoFor(eventId)])),
      [buildFrontierS102.request.now, commitS102.request.now],
      async (run) => {
        const { core, restore } = gateOverSamCore(run);
        try {
          // The read on arrival read every text and kept each result, but the second's kept row is gone before the turn
          // runs (the batch is still open: the third text closes it), so its leased turn reads no result for it (ADR-015
          // section 3).
          await arrive(SAM, "evt-sam-0001", "Barbershop, plumbing, electrical", "2026-10-19T14:05:00Z");
          await arrive(SAM, "evt-sam-0002", "and lawn care", "2026-10-19T14:05:01Z");
          await run.settle();
          await dropKeptResult(SAM, "evt-sam-0002");
          await arriveAndRun(run, [["evt-sam-0003", "STOP", "2026-10-19T14:05:02Z"]]);
        } finally {
          restore();
        }

        const turnId = await turnIdOf(ids);
        expect(run.face.gateCalls).toHaveLength(1);
        const request = run.face.gateCalls[0]?.request;
        expect(request?.turn.id).toBe(turnId);
        expect(request?.input).toEqual(forTurn(commitS102.request.input, S1_02, turnId));
        expect(coreOf(request)).toEqual([
          ["recordSafetyOutcome", "evt-sam-0001"],
          ["recordSafetyOutcome", "evt-sam-0003"],
          ["recordStopOrStart", "stop", "evt-sam-0003"],
        ]);
        expect(core.phones.get(SAM_PHONE)?.stopped).toBe(true);
        expect(await run.actor.readTurns()).toEqual([
          {
            turnId,
            eventIds: ids,
            state: "committed",
            restart: false,
            tries: 1,
            leaseUntil: null,
            committedAt: commitS102.outcome.committedAt,
          },
        ]);
      },
    );
  });

  it("every result present: a decided text and a STOP whose targets read fails commit the STOP core-only on the turn's first run: no rerun at the lapse, no park", async () => {
    const ids = ["evt-sam-0001", "evt-sam-0003"];
    await withTurnLoop(
      SAM,
      Object.fromEntries(ids.map((eventId) => [eventId, safetyNoFor(eventId)])),
      [commitS102.request.now],
      async (run) => {
        run.targets.answers.set(SAM.party.handleId, { error: "transient", sqlstate: "40001" });
        const { core, restore } = gateOverSamCore(run);
        try {
          await arriveAndRun(run, [
            ["evt-sam-0001", "Barbershop, plumbing, electrical", "2026-10-19T14:05:00Z"],
            ["evt-sam-0003", "STOP", "2026-10-19T14:05:02Z"],
          ]);
        } finally {
          restore();
        }

        const turnId = await turnIdOf(ids);
        expect(run.face.frontierCalls).toEqual([]);
        expect(run.ai.decideCalls).toEqual([]);
        expect(run.face.gateCalls).toHaveLength(1);
        const request = run.face.gateCalls[0]?.request;
        expect(request?.input).toEqual({ kind: "coreOnly" });
        expect(coreOf(request)).toEqual([
          ["recordSafetyOutcome", "evt-sam-0001"],
          ["recordSafetyOutcome", "evt-sam-0003"],
          ["recordStopOrStart", "stop", "evt-sam-0003"],
        ]);
        expect(core.phones.get(SAM_PHONE)?.stopped).toBe(true);
        expect(await run.actor.readTurns()).toEqual([
          {
            turnId,
            eventIds: ids,
            state: "committed",
            restart: false,
            tries: 1,
            leaseUntil: null,
            committedAt: commitS102.outcome.committedAt,
          },
        ]);
      },
    );
  });

  it("every result present: a decided text and a STOP whose decided request the gate refuses on its tries commit the STOP core-only on the turn's first run: no rerun at the lapse, no park (DL-521)", async () => {
    const ids = ["evt-sam-0001", "evt-sam-0003"];
    await withTurnLoop(
      SAM,
      Object.fromEntries(ids.map((eventId) => [eventId, safetyNoFor(eventId)])),
      [buildFrontierS102.request.now, commitS102.request.now],
      async (run) => {
        const { core, restore } = gateOverSamCore(run);
        // Limit 6 refuses the decided request before the re-read (commit-limit-6-reread-first.json's refusal), and the
        // one re-read cannot run (the decide double's re-read answers the models down), so there is no second try.
        const commit = run.face.gate;
        run.face.gate = (request, index) => {
          if (request.input.kind === "decided") return structuredClone(commitLimit6First.outcome);
          return commit === null ? { error: "unwired" } : commit(request, index);
        };
        try {
          await arriveAndRun(
            run,
            [
              ["evt-sam-0001", "Barbershop, plumbing, electrical", "2026-10-19T14:05:00Z"],
              ["evt-sam-0003", "STOP", "2026-10-19T14:05:02Z"],
            ],
            2,
          );
        } finally {
          restore();
        }

        const turnId = await turnIdOf(ids);
        expect(run.ai.decideCalls).toHaveLength(1);
        expect(run.ai.rereadCalls).toHaveLength(1);
        expect(run.face.gateCalls.map((call) => call.request.input.kind)).toEqual(["decided", "coreOnly"]);
        const request = run.face.gateCalls[1]?.request;
        expect(request?.turn.id).toBe(turnId);
        expect(coreOf(request)).toEqual([
          ["recordSafetyOutcome", "evt-sam-0001"],
          ["recordSafetyOutcome", "evt-sam-0003"],
          ["recordStopOrStart", "stop", "evt-sam-0003"],
        ]);
        expect(core.phones.get(SAM_PHONE)?.stopped).toBe(true);
        expect(await run.actor.readTurns()).toEqual([
          {
            turnId,
            eventIds: ids,
            state: "committed",
            restart: false,
            tries: 1,
            leaseUntil: null,
            committedAt: commitS102.outcome.committedAt,
          },
        ]);
      },
    );
  });

  // ADR-018 section 1 (CQ-230; T-1311): a turn whose runs cannot commit (a result owed, no keyword text: each run ends
  // noSafetyResult) holds its lease to its third lapse. A STOP batch behind it, once it has used its one restart,
  // restarts it a second time, so the STOP commits on that turn's first run, never after those lapses.
  describe("behind a turn that has restarted, which its runs cannot commit (ADR-018 section 1; CQ-230)", () => {
    it.each([
      ["not wired, as the root installs it today", false],
      ["wired, with a keyword copy that reads STOP", true],
    ] as const)(
      "with the down path %s: a turn whose text's result is owed, with no keyword text, restarted by a second batch, then a STOP batch: the STOP's recordStopOrStart commits on the second restart's first run, its CommitContext.unread naming the owed text and every routine part held, before the fake clock reaches 60 s",
      async (_how, wired) => {
        const ids = ["evt-sam-0001", "evt-sam-0002", "evt-sam-0003"];
        await withTurnLoop(
          SAM,
          Object.fromEntries(ids.map((eventId) => [eventId, safetyNoFor(eventId)])),
          [buildFrontierS102.request.now, commitS102.request.now],
          async (run) => {
            const db = wired ? dbFakes(keys, {}, { start: run.h.clock.now(), ids: idsOf(SAM.party) }) : null;
            const restoreDown = db === null ? (): void => undefined : setDbOutageDeps(db.outageDeps);
            const { core, restore } = gateOverSamCore(run);
            owedResult(SAM, "evt-sam-0001");
            try {
              // The first text is read (No), but its result cannot be kept: it is owed. Its turn opens at 3 s, and its run
              // ends with no commit (noSafetyResult).
              await arrive(SAM, "evt-sam-0001", "Barbershop, plumbing, electrical", "2026-10-19T14:05:00Z");
              await run.settle();
              await run.tick(3000);
              await run.settle();
              // A second batch restarts it at 6 s; the restart's run ends with no commit too.
              await arrive(SAM, "evt-sam-0002", "and lawn care", "2026-10-19T14:05:03Z");
              await run.settle();
              await run.tick(3000);
              await run.settle();
              expect(run.face.gateCalls).toEqual([]);
              expect(await run.actor.readTurns()).toMatchObject([
                { eventIds: ["evt-sam-0001"], state: "replaced" },
                { eventIds: ["evt-sam-0001", "evt-sam-0002"], state: "leased", restart: true },
              ]);

              // The STOP's batch closes at 9 s.
              await arrive(SAM, "evt-sam-0003", "STOP", "2026-10-19T14:05:06Z");
              await run.settle();
              if (wired) {
                expect(
                  (await run.actor.readOutage()).texts.find((text) => text.eventId === "evt-sam-0003")?.kind,
                ).toBe("stop");
              }
              await run.tick(3000);
              await until(() => run.face.gateCalls.length === 1, "the STOP's commit");
              await run.settle();
            } finally {
              restore();
              restoreDown();
            }

            const turnId = await turnIdOf(ids);
            // At once: the restarted turn's lease never lapsed.
            expect(run.h.clock.now()).toBe(9000);
            expect(run.h.clock.now()).toBeLessThan(LEASE_MS);
            expect(run.face.gateCalls).toHaveLength(1);
            const call = present(run.face.gateCalls[0], "the STOP's commit");
            expect(call.request.turn).toMatchObject({ id: turnId, eventIds: ids, tries: 1 });
            // The owed text is left out of the records and named among the texts not read.
            expect(call.at).toEqual({ holds: [], unread: ["evt-sam-0001"] });
            expect(coreOf(call.request)).toEqual([
              ["recordSafetyOutcome", "evt-sam-0002"],
              ["recordSafetyOutcome", "evt-sam-0003"],
              ["recordStopOrStart", "stop", "evt-sam-0003"],
            ]);
            // So the gate's own hold rule (T-305) holds every part of the decided request but a protective one.
            const { input } = call.request;
            expect(input.kind).toBe("decided");
            const parts = input.kind === "decided" ? input.decided.decide.parts : [];
            expect(parts.length).toBeGreaterThan(0);
            expect([
              ...heldParts(call.request as unknown as Parameters<typeof heldParts>[0], {
                holds: [],
                unreadEventIds: call.at.unread,
              }),
            ]).toEqual(parts.map((_part, index) => index));
            expect(core.phones.get(SAM_PHONE)?.stopped).toBe(true);
            expect(await run.actor.readTurns()).toMatchObject([
              { eventIds: ["evt-sam-0001"], state: "replaced", restart: false },
              { eventIds: ["evt-sam-0001", "evt-sam-0002"], state: "replaced", restart: true },
              { turnId, eventIds: ids, state: "committed", restart: true, tries: 1 },
            ]);
          },
        );
      },
    );
  });
});
