// The lease's part of ADR-015 (T-1264, card B), run inside the Workers runtime on a HandleActor's own storage: each run of
// a turn reads its texts' kept safety results through its leased turn (`resultsOf`, section 3), and the lease removes a
// turn's results, closing its texts, inside each storage transaction that ends the turn for good and at no other step
// (section 2). The lease is the real one (./lease.ts TurnLease) over the actor's storage; its host is the test's own, which
// answers each text's result from memory and notes each removal it is asked for (the actor's own host, over its safety
// read's store, is proven through the hop rig: ../wiring/kept-results.worker.test.ts). The turn's work (which records each
// run it is handed), its commit (K-05 v1 commitTurn's committed answer, or the error a test gives) and its park are hooks
// of the test's own, on a clock of the test's own. Test values only (rule 9).
import { reset, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import type { PinnedBundle } from "../bundle";
import type { SealedEvent } from "../gateway/types";
import type { SafetyResult } from "../safety/types";
import type { TraceContext } from "../trace";
import { safetyNoFor } from "../turn/test-support";
import { setBatchHooks } from "./batch";
import type { HandleActor } from "./handle-actor";
import type { InboxEntry } from "./inbox";
import {
  LEASE_MS,
  MAX_TRIES,
  setLeaseHooks,
  TurnLease,
  type CommitTurnAnswer,
  type CommitTurnRequest,
  type LeasedTurn,
  type LeaseHost,
  type ParkAnswer,
  type TurnEntry,
} from "./lease";

type Namespace = DurableObjectNamespace<HandleActor>;

const BUNDLE = { hash: "a".repeat(64), build: 1 };
const COMMITTED_AT = "2026-10-20T15:00:00Z";
const [A, B, C] = ["evt-lease-0001", "evt-lease-0002", "evt-lease-0003"];

/** A HandleActor of its own for each scenario: only its storage is used here (its own lease stays idle). */
function stubOf(name: string): DurableObjectStub<HandleActor> {
  const ns = (exports as unknown as { HandleActor: Namespace }).HandleActor;
  return ns.get(ns.idFromName(`lease-results:${name}`));
}

/** A stored text as the batch window hands it: its event id and place; nothing of it is read here. */
function entryOf(seq: number, eventId: string): InboxEntry {
  return {
    seq,
    event: { eventId } as unknown as SealedEvent,
    partKey: null,
    traceId: `trace-${eventId}`,
    bundleId: BUNDLE,
    startsTurn: true,
  };
}

/** K-05 v1 commitTurn's request for this run of its turn (the lease reads only the turn). */
function requestOf(turn: LeasedTurn): CommitTurnRequest {
  return {
    turn: {
      id: turn.turnId,
      handleId: "handle-alex",
      eventIds: turn.eventIds,
      bundleId: BUNDLE,
      traceId: turn.traceId,
      joinedTraceIds: [],
      tries: turn.tries,
    },
    versionsRead: [],
    writes: null,
  };
}

/** The committed answer, first or repeated (K-05 v1 commitTurn), with nothing the lease reads beside it. */
const committed = (request: CommitTurnRequest): CommitTurnAnswer => ({
  result: "committed",
  turnId: request.turn.id,
  committedAt: COMMITTED_AT,
  repeated: false,
  committed: null,
});

interface Rig {
  readonly lease: TurnLease;
  /** Each run the lease handed the turn's work, in order. */
  readonly runs: LeasedTurn[];
  /** Each removal the host was asked for, in order: the event ids, as asked. */
  readonly closed: string[][];
  /** Each read the host was asked for, in order: the event ids, as asked. */
  readonly asked: string[][];
  /** `failClose`: the host's removal throws (as the storage would). `held`: the host says PostgreSQL is down (T-270). */
  readonly flags: { failClose: boolean; held: boolean };
  /** Settles the lease's lent work (each run's pin and work). */
  settle(): Promise<void>;
  /** Hands the lease a closed batch of these texts. */
  take(batchId: number, eventIds: string[]): Promise<void>;
  /** The lease's clock moves past its lapse, then its alarm runs. */
  lapse(): Promise<void>;
  turns(): TurnEntry[];
}

/** The clock the lease runs on (the batch window's: ./batch.ts actorClock). */
const clock = { at: 1_000_000 };

/**
 * The real lease over this actor's storage, with the test's own host: each run pinned at once, every text's result
 * safety-no.json's under its own id (and, for `foreign`, one naming another text), each removal noted.
 */
function rigOf(state: DurableObjectState, options: { store?: boolean; foreign?: string } = {}): Rig {
  const lent: Promise<void>[] = [];
  const closed: string[][] = [];
  const asked: string[][] = [];
  const flags = { failClose: false, held: false };
  const host: LeaseHost = {
    storage: state.storage,
    arm: () => Promise.resolve(),
    lend(work) {
      lent.push(work);
    },
    pin: () =>
      Promise.resolve({
        bundleId: BUNDLE,
        bundle: {} as unknown as PinnedBundle,
        trace: {} as unknown as TraceContext,
      }),
    holds: () => [],
    unread: () => [],
    parkTrace: () => ({ bundleId: BUNDLE, trace: {} as unknown as TraceContext }),
    held: () => flags.held,
    ...(options.store === false
      ? {}
      : {
          resultsOf(eventIds: readonly string[]): Promise<readonly SafetyResult[]> {
            asked.push([...eventIds]);
            const results = eventIds.map((eventId) => safetyNoFor(eventId));
            const foreign = options.foreign;
            return Promise.resolve(foreign === undefined ? results : [...results, safetyNoFor(foreign)]);
          },
        }),
    closeResults(eventIds) {
      if (flags.failClose) throw new Error("the storage refused the removal");
      closed.push([...eventIds]);
    },
  };
  const lease = new TurnLease(host);
  const settle = async (): Promise<void> => {
    while (lent.length > 0) await Promise.all(lent.splice(0));
  };
  return {
    lease,
    runs: [],
    closed,
    asked,
    flags,
    settle,
    async take(batchId, eventIds) {
      const entries = eventIds.map((eventId, index) => entryOf(batchId * 10 + index, eventId));
      expect(
        await lease.take({ batchId, reason: "quiet", firstAt: 0, lastAt: 0, closedAt: 0, entries }),
      ).toBe("taken");
      await settle();
    },
    async lapse() {
      clock.at += LEASE_MS;
      await lease.onAlarm();
      await settle();
    },
    turns: () => lease.read(),
  };
}

/** The turn's hooks of the test's own: its work records each run; its commit and park answer as the test says. */
function hooks(
  rig: () => Rig,
  answers: { commit?: (request: CommitTurnRequest) => CommitTurnAnswer; park?: ParkAnswer | null } = {},
): () => void {
  const park =
    answers.park === undefined
      ? ({ result: "parked", parkedAt: COMMITTED_AT, repeated: false } as const)
      : answers.park;
  return setLeaseHooks({
    runTurn(turn) {
      rig().runs.push(turn);
    },
    commit: (request) => Promise.resolve((answers.commit ?? committed)(request)),
    ...(park === null ? {} : { park: () => Promise.resolve(park) }),
  });
}

/** Runs a scenario inside its own actor, with the lease's clock and the turn's hooks in place. */
async function scenario(
  name: string,
  answers: Parameters<typeof hooks>[1],
  body: (rig: Rig) => Promise<void>,
  options: Parameters<typeof rigOf>[1] = {},
): Promise<void> {
  let current: Rig | null = null;
  const restores = [
    setBatchHooks({ clock: { now: () => clock.at } }),
    hooks(() => {
      if (current === null) throw new Error("no rig yet");
      return current;
    }, answers),
  ];
  try {
    await runInDurableObject(stubOf(name), async (_actor: HandleActor, state) => {
      current = rigOf(state, options);
      await body(current);
    });
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

const runOf = (rig: Rig, at: number): LeasedTurn => {
  const run = rig.runs[at];
  if (run === undefined) throw new Error(`no run ${String(at)}`);
  return run;
};

afterEach(async () => {
  await reset();
});

describe("a run reads its texts' kept results through its leased turn (ADR-015 section 3)", () => {
  it("only its own texts are asked of the host, each once, and a result naming another text is not answered", async () => {
    await scenario(
      "own",
      {},
      async (rig) => {
        await rig.take(1, [A, B]);
        const run = runOf(rig, 0);

        const results = await run.resultsOf([B, C, A, B]);

        expect(rig.asked).toEqual([[B, A]]);
        expect(results).toEqual([safetyNoFor(B), safetyNoFor(A)]);
        // An id outside the turn alone: nothing asked, nothing answered.
        expect(await run.resultsOf([C])).toEqual([]);
        expect(rig.asked).toEqual([[B, A]]);
      },
      { foreign: C },
    );
  });

  it("with no store wired, the read rejects, and the turn takes that as no results", async () => {
    await scenario(
      "unwired",
      {},
      async (rig) => {
        await rig.take(1, [A]);

        await expect(runOf(rig, 0).resultsOf([A])).rejects.toThrow("no safety results are wired");
      },
      { store: false },
    );
  });
});

describe("the lease removes a turn's kept results inside each transaction that ends it for good (ADR-015 section 2)", () => {
  it("its reply ended: removed once, with the turn's texts, and not before (the commit that keeps the lease for its reply removes nothing)", async () => {
    await scenario("replied", {}, async (rig) => {
      await rig.take(1, [A, B]);
      const run = runOf(rig, 0);
      expect(await run.commit(requestOf(run), { reply: true })).toMatchObject({ result: "committed" });
      expect(rig.closed).toEqual([]);

      await run.replied();
      await run.replied();

      expect(rig.closed).toEqual([[A, B]]);
      expect(rig.turns()).toMatchObject([{ state: "committed", leaseUntil: null }]);
    });
  });

  it("a commit with no reply, and K-05's turnParked: removed once each, with the turn's texts", async () => {
    await scenario("no reply", {}, async (rig) => {
      await rig.take(1, [A]);
      const run = runOf(rig, 0);
      await run.commit(requestOf(run));
      await run.commit(requestOf(run));

      expect(rig.closed).toEqual([[A]]);
      expect(rig.turns()).toMatchObject([{ state: "committed", leaseUntil: null }]);
    });
    await scenario("turnParked", { commit: () => ({ error: "turnParked" }) }, async (rig) => {
      await rig.take(1, [A]);
      const run = runOf(rig, 0);
      expect(await run.commit(requestOf(run))).toEqual({ error: "turnParked" });

      expect(rig.closed).toEqual([[A]]);
      expect(rig.turns()).toMatchObject([{ state: "parked", leaseUntil: null }]);
    });
  });

  it("a park after the third lapse, parked or answered alreadyCommitted: removed once, at the park, never at a lapse's rerun", async () => {
    const parks: [string, ParkAnswer, string][] = [
      ["parked", { result: "parked", parkedAt: COMMITTED_AT, repeated: false }, "parked"],
      ["alreadyCommitted", { error: "alreadyCommitted", committedAt: COMMITTED_AT }, "committed"],
    ];
    for (const [name, park, state] of parks) {
      await scenario(name, { park }, async (rig) => {
        await rig.take(1, [A]);
        for (let tries = 2; tries <= MAX_TRIES; tries += 1) {
          await rig.lapse();
          expect(rig.turns()).toMatchObject([{ state: "leased", tries }]);
          expect(rig.closed).toEqual([]);
        }
        await rig.lapse();

        expect(rig.closed).toEqual([[A]]);
        expect(rig.turns()).toMatchObject([{ state, leaseUntil: null }]);
      });
    }
  });

  it("its reply given up at its third lapse: removed once, then, and not at the lapses that rerun it", async () => {
    await scenario("given up", {}, async (rig) => {
      await rig.take(1, [A]);
      const run = runOf(rig, 0);
      await run.commit(requestOf(run), { reply: true });
      for (let tries = 2; tries <= MAX_TRIES; tries += 1) {
        await rig.lapse();
        expect(rig.turns()).toMatchObject([{ state: "committed", tries }]);
        expect(rig.closed).toEqual([]);
      }
      await rig.lapse();

      expect(rig.closed).toEqual([[A]]);
      expect(rig.turns()).toMatchObject([{ state: "committed", leaseUntil: null }]);
    });
  });
});

describe("no other step of the lease removes them (ADR-015 section 2)", () => {
  it("a restart keeps them: its replaced turn removes nothing, and the restart's end removes every text of the union", async () => {
    await scenario("restart", {}, async (rig) => {
      await rig.take(1, [A]);
      await rig.take(2, [B]);
      expect(rig.turns().map((turn) => [turn.eventIds, turn.state])).toEqual([
        [[A], "replaced"],
        [[A, B], "leased"],
      ]);
      expect(rig.closed).toEqual([]);
      const restart = runOf(rig, 1);

      await restart.commit(requestOf(restart));

      expect(rig.closed).toEqual([[A, B]]);
    });
  });

  it("a lapse while PostgreSQL is down holds the turn and removes nothing; nor does a third lapse with no park wired", async () => {
    await scenario("held", {}, async (rig) => {
      await rig.take(1, [A]);
      rig.flags.held = true;
      await rig.lapse();
      await rig.lapse();
      await rig.lapse();
      expect(rig.turns()).toMatchObject([{ state: "leased", tries: 1 }]);
      expect(rig.closed).toEqual([]);
    });
    await scenario("no park", { park: null }, async (rig) => {
      await rig.take(1, [A]);
      for (let lapses = 1; lapses <= MAX_TRIES + 1; lapses += 1) await rig.lapse();
      expect(rig.turns()).toMatchObject([{ state: "leased", tries: MAX_TRIES }]);
      expect(rig.closed).toEqual([]);
    });
  });
});

describe("the turn's end and the removal are one transaction (ADR-015 section 2: both or neither)", () => {
  it("a removal that throws leaves the turn as it was, its lease held: at a commit's finish, at its reply's end and at its reply given up; the next end removes them", async () => {
    await scenario("finish refused", {}, async (rig) => {
      await rig.take(1, [A]);
      const run = runOf(rig, 0);
      rig.flags.failClose = true;
      await expect(run.commit(requestOf(run))).rejects.toThrow("the storage refused the removal");
      expect(rig.turns()).toMatchObject([{ state: "committing", leaseUntil: expect.any(Number) as unknown }]);
      rig.flags.failClose = false;
      await run.commit(requestOf(run));
      expect(rig.closed).toEqual([[A]]);
      expect(rig.turns()).toMatchObject([{ state: "committed", leaseUntil: null }]);
    });
    await scenario("reply refused", {}, async (rig) => {
      await rig.take(1, [A]);
      const run = runOf(rig, 0);
      await run.commit(requestOf(run), { reply: true });
      rig.flags.failClose = true;
      await expect(run.replied()).rejects.toThrow("the storage refused the removal");
      expect(rig.turns()).toMatchObject([{ state: "committed", leaseUntil: expect.any(Number) as unknown }]);
      rig.flags.failClose = false;
      await run.replied();
      expect(rig.closed).toEqual([[A]]);
      expect(rig.turns()).toMatchObject([{ state: "committed", leaseUntil: null }]);
    });
    await scenario("give up refused", {}, async (rig) => {
      await rig.take(1, [A]);
      const run = runOf(rig, 0);
      await run.commit(requestOf(run), { reply: true });
      await rig.lapse();
      await rig.lapse();
      rig.flags.failClose = true;
      await expect(rig.lapse()).rejects.toThrow("the storage refused the removal");
      expect(rig.turns()).toMatchObject([
        { state: "committed", tries: MAX_TRIES, leaseUntil: expect.any(Number) as unknown },
      ]);
      rig.flags.failClose = false;
      await rig.lapse();
      expect(rig.closed).toEqual([[A]]);
      expect(rig.turns()).toMatchObject([{ state: "committed", leaseUntil: null }]);
    });
  });
});
