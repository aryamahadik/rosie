// A vote's STOP or START keeps the same words on the turn path and on the PostgreSQL-down path (T-1338): K-09 v1
// recordStopOrStart `words`, "The person's own words, kept as the consent row's exact words (K-29 v1
// consents.exact_words)", are the option's words the person chose (K-02: a vote's words are its option's; DL-540). Run
// inside the Workers runtime (Vitest project "workers"). One vote, scrubbed and sealed once by the gateway's own hand-off
// (K-06 v1.2: the option's words in its form 2 box, none in the clear), goes down both paths:
//   - the turn path: the turn loop (../../turn, T-251) opens it from its box and runs the real guard (T-250) and fixed
//     replies (T-267); the keyword turn's one commit goes to the gate, answered over T-267's shared-core double
//     (./test-support.ts), as turn.worker.test.ts runs a vote's STOP;
//   - the PostgreSQL-down path (../../outage/db, T-270; imported read-only): the vote goes through the gateway's door into
//     the real handle actor while PostgreSQL does not answer; the actor takes it by its copy of the keyword list, and its
//     record is written on return (outage/db's doubles, as outage.worker.test.ts runs a vote's STOP).
// Test values only: the master's sample cast (Sam), the frozen fixtures' ids, phones in the fictional 555-01xx range
// (rule 9).
import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import pollVote from "../../../../contracts/inbound-event/fixtures/poll-vote.json";
import stopRecorded from "../../../../contracts/tool-api/fixtures/stop-recorded.json";
import {
  setBatchHooks,
  setBundleDeps,
  setCopyDeps,
  setLeaseHooks,
  setSafetyDeps,
  type CommitTurnRequest,
  type HandleActor,
  type InboxEntry,
  type LeasedTurn,
} from "../../actor";
import { BUNDLE_A, WHOLE_A } from "../../bundle/test-support";
import {
  actorNameOf,
  durableObjectActor,
  prepareHandoff,
  type ActorNamespace,
  type HandleActorRpc,
} from "../../gateway";
import { fakeKeyStore } from "../../gateway/test-support";
import { PROBE_MS, setDbOutageDeps, type OutageView } from "../../outage/db";
import { dbFakes, idsOf, type DbFakes } from "../../outage/db/test-support";
import { runTurnLoop, setTurnDeps, turnReplyCore, type GateAndCommitRequest } from "../../turn";
import {
  SAM,
  checkedManifest,
  fakeDecide,
  fakeFacts,
  fakeTurnFace,
  safetyNoFor,
  storedText,
  targetsAnswer,
  testTurn,
  turnDeps,
  until,
} from "../../turn/test-support";
import { setGuardDeps } from "../targets";
import { fakeTargets } from "../test-support";
import { setReplyDeps } from "./replies";
import { ROSIE_NUMBER, fakeCore, phone, type FakeCore } from "./test-support";
import type { RecordStopOrStartRequest } from "./types";

const TRACE = "11111111-2222-4333-8444-555555555555";
const BUNDLE = { hash: "a".repeat(64), build: 1 };
const SAM_ACTOR = actorNameOf(SAM.handle);
/** The test's start: Tuesday Oct 27, 2026, 10:00am in New York. */
const START = Date.parse("2026-10-27T14:00:00Z");
const PRIME = "evt-sam-0500";
const VOTE = "evt-sam-0501";

const keys = fakeKeyStore();
const restores: (() => void)[] = [];

afterEach(async () => {
  while (restores.length > 0) restores.pop()?.();
  await reset();
});

// ---- the PostgreSQL-down path: Sam's handle actor, as outage.worker.test.ts runs it --------------------------------

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

/** The actor's calls over RPC, typed here. */
interface Rpc {
  readOutage(): Promise<OutageView>;
  outageIdle(): Promise<void>;
  safetyIdle(): Promise<void>;
  batchIdle(): Promise<void>;
}

/** The commit a turn of Sam's sends through its lease: the turn, with Sam's K-04 handle id (K-05 v1 turn). */
function samCommit(turn: LeasedTurn): CommitTurnRequest {
  return {
    turn: {
      id: turn.turnId,
      handleId: SAM.party.handleId,
      eventIds: turn.eventIds,
      bundleId: { hash: turn.bundleId.hash, build: turn.bundleId.build },
      traceId: turn.traceId,
      joinedTraceIds: turn.joinedTraceIds,
      tries: turn.tries,
    },
    versionsRead: [],
    writes: null,
  };
}

interface Rig {
  readonly f: DbFakes;
  readonly actor: Rpc;
  /** The fake clock moves, then the alarm runs, as the platform would at the stored time; the lent work settles. */
  tick(ms: number): Promise<void>;
  settle(): Promise<void>;
}

/**
 * Sam's handle in the real actor, the down path wired: the safety read answers No for each text, and while PostgreSQL
 * answers, a first text's turn pins bundle A (the actor copies its keyword list) and commits once through the lease.
 */
async function primedRig(): Promise<Rig> {
  const f = dbFakes(
    keys,
    { [PRIME]: safetyNoFor(PRIME), [VOTE]: safetyNoFor(VOTE) },
    { start: START, ids: idsOf(SAM.party) },
  );
  restores.push(
    setSafetyDeps(f.safetyDeps),
    setBatchHooks({ clock: f.clock }),
    setLeaseHooks({
      runTurn: async (turn) => {
        await turn.commit(samCommit(turn));
      },
      commit: (request, at) => f.commit(request, at),
    }),
    setBundleDeps(f.bundleDeps),
    setCopyDeps({ timers: f.api.source }),
    setDbOutageDeps(f.outageDeps),
  );
  const stub = (): DurableObjectStub<HandleActor> => namespace().get(namespace().idFromName(SAM_ACTOR));
  const actor = stub() as unknown as Rpc;
  const rig: Rig = {
    f,
    actor,
    async tick(ms) {
      await f.clock.advance(ms);
      await runDurableObjectAlarm(stub());
      await rig.settle();
    },
    async settle() {
      for (let round = 0; round < 3; round += 1) {
        await actor.safetyIdle();
        await actor.outageIdle();
        await actor.batchIdle();
      }
    },
  };
  const first = await storedText(
    {
      eventId: PRIME,
      body: "Test words: can I get a cut this week?",
      sentAt: new Date(START).toISOString(),
      traceId: TRACE,
    },
    SAM.handle,
    keys,
    BUNDLE,
    0,
  );
  const handoff = {
    event: first.event,
    partKey: null,
    traceId: TRACE,
    bundleId: BUNDLE,
    actorName: SAM_ACTOR,
  };
  expect(await door().accept(handoff)).toBe("written");
  await rig.settle();
  await rig.tick(3000);
  await until(() => f.log.includes(`commit:${PRIME}`), "the first turn's commit", 10_000);
  await rig.settle();
  f.log.length = 0;
  return rig;
}

// ---- the turn path: the turn loop over the stored vote, as turn.worker.test.ts runs it ----------------------------

/**
 * K-09 gateAndCommit over T-267's shared-core double: each text's safety record answered as stop-recorded.json answers
 * it, then the keyword texts' actions committed by the double (turn.worker.test.ts's gate for a STOP).
 */
function gateOver(core: FakeCore): (request: GateAndCommitRequest) => Promise<never> {
  return async (request) => {
    const records = request.core.filter((action) => action.call === "recordSafetyOutcome");
    const actions = request.core.slice(records.length);
    const answer = await core.core.commitCore({ caller: request.caller as never, actions: actions as never });
    if ("error" in answer) return answer as never;
    return {
      result: "committed",
      turnId: request.turn.id,
      committedAt: request.now,
      repeated: answer.repeated,
      parts: [],
      planner: null,
      core: [...records.map(() => stopRecorded.outcome.core[0]), ...answer.core],
      written: {
        written: [],
        outboxRows: [...core.outbox.values()].map((row) => ({ id: row.id, commitSeq: row.commitSeq })),
        promoted: [],
      },
      effects: [],
      openQuestions: { opened: [], closed: [] },
    } as never;
  };
}

/** The turn loop's one run over this stored vote: its recordStopOrStart, as committed, and the consent rows it wrote. */
async function throughTheTurn(
  entry: InboxEntry,
): Promise<{ record: RecordStopOrStartRequest | undefined; exactWords: string[] }> {
  const now = stopRecorded.request.now;
  const t = testTurn({
    turnId: "turn-sam-vote",
    traceId: TRACE,
    bundleId: BUNDLE_A,
    manifest: await checkedManifest(WHOLE_A, BUNDLE_A),
    entries: [entry],
  });
  const face = fakeTurnFace();
  const facts = fakeFacts(SAM.party, [now]);
  facts.safety.set(entry.event.eventId, safetyNoFor(entry.event.eventId));
  restores.push(setTurnDeps(turnDeps(facts, face, fakeDecide(face.log), keys)));
  const targets = fakeTargets();
  const { handleId, personId } = SAM.party;
  targets.answers.set(handleId, targetsAnswer(handleId, { roles: [], openQuestionIds: [], bookingIds: [] }));
  restores.push(setGuardDeps({ targets: targets.port }));
  const core = fakeCore(now, [phone(SAM.handle.address, handleId, personId)]);
  face.gate = gateOver(core);
  restores.push(setReplyDeps({ core: turnReplyCore, rows: core.rows, rosieNumber: ROSIE_NUMBER }));

  const outcome = await runTurnLoop(t.turn);

  // Its own core-only turn: never the frontier, and one commit.
  expect(outcome).toMatchObject({ result: "committed" });
  expect(face.frontierCalls).toEqual([]);
  expect(face.gateCalls).toHaveLength(1);
  const records = (face.gateCalls[0]?.request.core ?? []).filter(
    (action) => action.call === "recordStopOrStart",
  );
  expect(records).toHaveLength(1);
  return {
    record: records[0]?.request as RecordStopOrStartRequest | undefined,
    exactWords: core.consents.map((consent) => consent.exactWords),
  };
}

/** What both paths' recordStopOrStart must agree on: the number, the event, the kind, the words and the visit's flag. */
const factsOf = (
  record:
    | Pick<RecordStopOrStartRequest, "kind" | "phoneNumber" | "inboundEventId" | "words" | "alsoCancelVisit">
    | undefined,
) => ({
  kind: record?.kind,
  phoneNumber: record?.phoneNumber,
  inboundEventId: record?.inboundEventId,
  words: record?.words,
  alsoCancelVisit: record?.alsoCancelVisit,
});

describe("one vote, the same words on the turn path and the PostgreSQL-down path (T-1338; K-29)", () => {
  it.each([
    ["stop", "Stop", false],
    ["stop", "stop!", false],
    ["stop", "¡Cancelar!", true],
    ["start", "Start.", false],
  ] as const)(
    "a vote for an option that reads %s (%j): the turn's commit and the record on return keep the option's words",
    async (kind, optionWords, flagsVisit) => {
      const rig = await primedRig();
      // Sam's vote, through the gateway's own hand-off: K-06 v1.2 seals the option's words in its form 2 box.
      const prepared = await prepareHandoff(
        {
          event: {
            ...pollVote,
            eventId: VOTE,
            handle: SAM.handle,
            sentAt: new Date(rig.f.clock.now()).toISOString(),
            traceId: TRACE,
            poll: { ...pollVote.poll, optionWords },
          },
          partKey: null,
          traceId: TRACE,
          bundleId: BUNDLE,
        },
        keys,
      );
      if (prepared.door !== "actor") throw new Error("not an actor event");
      const vote = prepared.handoff.event;
      expect(vote.poll).toEqual({ pollId: pollVote.poll.pollId, optionId: pollVote.poll.optionId });
      expect(vote.sealed?.v).toBe(2);

      // The turn path: the stored vote, as the actor's inbox keeps it, in a turn of its own.
      const turn = await throughTheTurn({
        seq: 1,
        event: vote,
        partKey: null,
        traceId: TRACE,
        bundleId: BUNDLE_A,
        startsTurn: true,
      });

      // The down path: the same vote while PostgreSQL is down, taken by the actor; its record is written on return.
      rig.f.down = true;
      expect(await door().accept(prepared.handoff)).toBe("written");
      await rig.settle();
      expect((await rig.actor.readOutage()).texts).toEqual([
        expect.objectContaining({ eventId: VOTE, kind, keyword: "handled" }),
      ]);
      rig.f.down = false;
      await rig.tick(PROBE_MS);
      expect(rig.f.stops).toHaveLength(1);
      const down = rig.f.stops[0];

      // The same record from both paths, its words the option's as the person chose it, never the list's word; the
      // turn's consent row keeps them as its exact words.
      expect(factsOf(turn.record)).toEqual(factsOf(down));
      expect(factsOf(down)).toEqual({
        kind,
        phoneNumber: SAM.handle.address,
        inboundEventId: VOTE,
        words: optionWords,
        alsoCancelVisit: flagsVisit,
      });
      expect(turn.exactWords).toEqual([optionWords]);
    },
  );
});
