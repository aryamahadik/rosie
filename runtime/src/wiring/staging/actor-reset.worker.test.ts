// T-1452: staging's reset list and its hook (./actor-reset.ts), the hook's way in through stagingOptions (./options.ts) and
// the root's install() (../root.ts), and the reset end to end on the hop rig (DL-944 card A), inside the Workers runtime.
//
//   - The list: its first entry is tp-01 and the real line's allow-list; every id a label, every roster id the roster's,
//     no number written in it.
//   - The hook: null anywhere but staging, with nothing read but ENVIRONMENT; on staging nothing read as it is made, and
//     STAGING_LINQ_ALLOWLIST read at each call, as T-416's guard reads it: tp-01's actor named by its roster id, each
//     allow-list number's by its place, never the number; a list that cannot be read, or none, names no number.
//   - stagingOptions hands the hook in where the seal is bound; production and a staging with no seal hand in none.
//   - install() sets it only where the root is staging's; production's and the test environment's roots never do.
//   - A stuck tp-01 (a pending danger with no path, its after_safe hold with no id and its 30 s re-read, its turn ended, as
//     since Nov 15) clears at its next alarm with staging's own list, and its next JOIN commits through the hop rig (the
//     test environment's root, every joined port on its double, as hop 12's tests compose it) with no hold and no unread
//     text handed to the gate: the reply is not held, and S1-02's one part goes to the Linq double.
// No model call and no network. Test values only (rule 9): the master's sample cast, K-06's and K-02's fixtures, whole
// fiction-range numbers (555-01xx) and made-up ids.
import joinRunContext from "@rosie/ai/recordings/contexts/join-s1-01.json";
import commitFirst from "@rosie/contracts/data-access/fixtures/commit-first.json";
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import safetyEmergencyNow from "@rosie/contracts/model/fixtures/safety-emergency-now.json";
import { ROSTER, rosterPhone } from "@rosie/db/seeds/lib/roster";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import {
  QUIET_MS,
  setBatchHooks,
  setBundleDeps,
  setLeaseHooks,
  setSafetyDeps,
  turnIdOf,
  type CommitTurnAnswer,
  type CommitTurnRequest,
  type HandleActor,
  type HoldEntry,
  type LeasedTurn,
  type SafetyEntry,
  type TurnEntry,
} from "../../actor";
import { runStagingReset, setStagingReset, type StagingResetHook } from "../../actor/staging-reset";
import { fakeBundles } from "../../bundle/test-support";
import {
  actorNameOf,
  durableObjectActor,
  prepareHandoff,
  type ActorNamespace,
  type HandleActorRpc,
  type InboundEvent,
} from "../../gateway";
import { fakeKeyStore } from "../../gateway/test-support";
import { harness } from "../../safety/test-support";
import type { SafetyResult } from "../../safety/types";
import { isLabel } from "../../trace";
import { flush } from "../../turn/test-support";
import { composeRoot, SKELETON_FLAG, type HandleActors, type Root } from "../index";
import type { HandleSealingKeyCall } from "../real";
import {
  fakeFlags,
  SAM_CHAT,
  skeletonFakes,
  TEST_OWNER_1,
  watchGate,
  type LinqInboundEvent,
  type SignedWebhook,
  type SkeletonFakes,
} from "../test-support";
import { ACTOR_RESET_LIST, stagingActorReset, type ActorResetEnv } from "./actor-reset";
import { NO_RECEIPT_INPUTS } from "./k05-receipt";
import { NO_STAGING_INPUTS, stagingOptions } from "./options";
import type { StagingEnv } from "./part";

type Json = Record<string, unknown>;
type Namespace = DurableObjectNamespace<HandleActor>;

/** A run through the Workers runtime's own steps: a resource guard above Vitest's 5 s default. */
const TEST_MS = 30_000;
/** How long a step of the actor's lent work may take before a wait gives up. */
const WAIT_MS = 15_000;

const BUNDLE = { hash: "a".repeat(64), build: 1 };
const TRACE = "14521452-3333-4333-8444-555555555555";
/** The list's first entry, as it ships. */
const FIRST_ENTRY = "t1452-nov18";
/** tp-01's actor: test owner 1's handle at the roster's own number (the skeleton seed's), as the gateway names it. */
const OWNER_ACTOR = actorNameOf(TEST_OWNER_1.handle);
const TP01_NUMBER = "+15555550100";
const EMERGENCY_TEXT = "my lips are swelling after the beard color and I can't breathe well";

const keys = fakeKeyStore();

/** The JOIN run's own context (K-02 README "v1.1", recording 2; T-1145 round 2, DL-347). */
const JOIN_CONTEXT = joinRunContext as unknown as {
  readonly texts: readonly {
    readonly eventId: string;
    readonly words: string;
    readonly sentAt: { utc: string };
  }[];
};
const [JOIN_TEXT_OF_RECORDING] = JOIN_CONTEXT.texts;

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

function handleActors(): HandleActors<DurableObjectId> {
  const ns = namespace();
  return { idFromName: (name) => ns.idFromName(name), get: (id) => ns.get(id) };
}

function stubOf(actorName: string): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(actorName));
}

/** The actor's calls over RPC, typed here (the stub's own type cannot carry the sealed event's open shape). */
interface ActorRpc {
  readSafety(): Promise<SafetyEntry[]>;
  readHolds(): Promise<HoldEntry[]>;
  readTurns(): Promise<TurnEntry[]>;
  routineHeld(): Promise<boolean>;
  safetyIdle(): Promise<void>;
  batchIdle(): Promise<void>;
}

function actorOf(actorName: string): ActorRpc {
  return stubOf(actorName);
}

async function settle(actorName: string): Promise<void> {
  await actorOf(actorName).safetyIdle();
  await actorOf(actorName).batchIdle();
}

/** An env whose reads are counted, by name. */
function counting(values: Record<string, unknown>, reads: string[]): ActorResetEnv {
  return new Proxy(values, {
    get(target, key, receiver) {
      if (typeof key === "string") reads.push(key);
      return Reflect.get(target, key, receiver) as unknown;
    },
  }) as unknown as ActorResetEnv;
}

/** A storage that fails at any touch: what reads it shows a read. */
function untouchable(): DurableObjectStorage {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("the storage was read");
      },
    },
  ) as unknown as DurableObjectStorage;
}

/** The reset's log lines, as written. */
function resetLines(log: MockInstance): Json[] {
  return log.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line) => line.includes('"msg":"actorReset"'))
    .map((line) => JSON.parse(line) as Json);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("the list (DL-944 card A)", () => {
  it("its first entry is tp-01 and the real line's allow-list; every id is a label and unique, every roster id is the roster's, and no number is written in it", () => {
    expect(ACTOR_RESET_LIST[0]).toEqual({ id: FIRST_ENTRY, targets: [{ roster: "tp-01" }, "allowList"] });
    for (const entry of ACTOR_RESET_LIST) {
      expect(isLabel(entry.id), entry.id).toBe(true);
      for (const target of entry.targets) {
        if (target !== "allowList") expect(rosterPhone(target.roster), target.roster).not.toBeNull();
      }
    }
    expect(new Set(ACTOR_RESET_LIST.map((entry) => entry.id)).size).toBe(ACTOR_RESET_LIST.length);
    const written = JSON.stringify(ACTOR_RESET_LIST);
    expect(written).not.toMatch(/[0-9]{7}/u);
    for (const phone of ROSTER) expect(written).not.toContain(phone.fakeNumber.slice(2));
  });
});

describe("the hook (stagingActorReset)", () => {
  it("anywhere but staging: null, with nothing read but ENVIRONMENT", () => {
    for (const environment of ["production", "test", "Staging", " staging", ""]) {
      const reads: string[] = [];
      const hook = stagingActorReset(
        counting({ ENVIRONMENT: environment, STAGING_LINQ_ALLOWLIST: "+15555550103" }, reads),
      );
      expect(hook, environment).toBeNull();
      expect(reads, environment).toEqual(["ENVIRONMENT"]);
    }
  });

  it("on staging: nothing read but ENVIRONMENT as it is made; tp-01's actor named by its roster id and each allow-list number's by its place, the list read at each call; any other actor named by none", () => {
    const reads: string[] = [];
    const values: Record<string, unknown> = {
      ENVIRONMENT: "staging",
      STAGING_LINQ_ALLOWLIST: "+15555550103,+15555550104",
    };
    const hook = stagingActorReset(counting(values, reads));
    expect(reads).toEqual(["ENVIRONMENT"]);
    if (hook === null) throw new Error("staging gives a hook");

    expect(hook.matches(OWNER_ACTOR)).toEqual([{ entry: FIRST_ENTRY, target: "tp-01" }]);
    expect(hook.matches("phone:+15555550104")).toEqual([{ entry: FIRST_ENTRY, target: "allowList:2" }]);
    expect(hook.matches("phone:+15555550103")).toEqual([{ entry: FIRST_ENTRY, target: "allowList:1" }]);
    expect(hook.matches("phone:+15555550105")).toEqual([]);
    expect(hook.matches("email:sam@example.com")).toEqual([]);
    expect(reads.filter((read) => read === "STAGING_LINQ_ALLOWLIST")).toHaveLength(5);

    // Read at each call: a number taken off the list is no longer named; one put on it is.
    values.STAGING_LINQ_ALLOWLIST = "+15555550105";
    expect(hook.matches("phone:+15555550104")).toEqual([]);
    expect(hook.matches("phone:+15555550105")).toEqual([{ entry: FIRST_ENTRY, target: "allowList:1" }]);
    // tp-01's number on the list too: both targets name its actor.
    values.STAGING_LINQ_ALLOWLIST = TP01_NUMBER;
    expect(hook.matches(OWNER_ACTOR)).toEqual([
      { entry: FIRST_ENTRY, target: "tp-01" },
      { entry: FIRST_ENTRY, target: "allowList:1" },
    ]);
  });

  it("a list that cannot be read (an entry that is not E.164), or none at all, names no number; tp-01 is still named", () => {
    const values: Record<string, unknown> = { ENVIRONMENT: "staging" };
    const hook = stagingActorReset(counting(values, []));
    if (hook === null) throw new Error("staging gives a hook");
    for (const list of [
      "+15555550103, +15555550104",
      "+15555550103,,+15555550104",
      "+15555550103;+15555550104",
      "15555550103",
      "",
      "  ",
      undefined,
      42,
    ]) {
      values.STAGING_LINQ_ALLOWLIST = list;
      expect(hook.matches("phone:+15555550103"), String(list)).toEqual([]);
      expect(hook.matches(OWNER_ACTOR), String(list)).toEqual([{ entry: FIRST_ENTRY, target: "tp-01" }]);
    }
  });
});

describe("stagingOptions hands the hook in where the seal is bound (DL-768)", () => {
  const STAGING_VARS = {
    ENVIRONMENT: "staging",
    BASE_PATH: "/test",
    DB_SCHEMA: "",
    GIT_SHA: "test-sha",
  } as unknown as StagingEnv;
  /** A key call that is never called here: its presence alone stands for the seal bound. */
  const keyCall = (() => Promise.reject(new Error("not called here"))) as unknown as HandleSealingKeyCall;

  it("staging with the receipt part's key call: the list's hook (tp-01's actor named); production, and staging with no seal: none", () => {
    const sealed = stagingOptions(STAGING_VARS, {
      builders: { receipt: () => ({ ...NO_RECEIPT_INPUTS, handleKey: keyCall }) },
    });
    expect(sealed.actorReset?.matches(OWNER_ACTOR)).toEqual([{ entry: FIRST_ENTRY, target: "tp-01" }]);

    expect(stagingOptions({ ...STAGING_VARS, ENVIRONMENT: "production" }).actorReset).toBeNull();
    expect(
      stagingOptions(STAGING_VARS, { builders: { receipt: () => NO_RECEIPT_INPUTS } }).actorReset,
    ).toBeNull();
    expect(stagingOptions(STAGING_VARS).actorReset).toBeNull();
    expect(NO_STAGING_INPUTS.actorReset).toBeNull();
  });
});

describe("the root's install() sets the hook only where the root is staging's", () => {
  it("a staging root sets it and puts the earlier one back; a production root and a test root, staging's vars and all, never do", () => {
    const asked: string[] = [];
    const hook: StagingResetHook = {
      matches(actorName) {
        asked.push(actorName);
        return [];
      },
    };
    // One try at a staging actor's alarm: the hook, where one is set, is asked about the actor (it names no entry).
    const tryReset = (): string =>
      runStagingReset({
        storage: untouchable(),
        env: { ENVIRONMENT: "staging" },
        handedName: OWNER_ACTOR,
        safety: {},
        pending: () => [],
      });
    const linq = { webhookSecret: (): string | undefined => undefined };
    const production = composeRoot({
      environment: "production",
      actors: null,
      vars: { ENVIRONMENT: "production", GIT_SHA: "test-sha" },
      linq,
      actorReset: hook,
    });
    const test = composeRoot({
      environment: "test",
      sets: { fake: skeletonFakes().ports },
      actors: null,
      vars: { ENVIRONMENT: "staging", GIT_SHA: "test-sha" },
      actorReset: hook,
    });
    const staging = composeRoot({
      environment: "staging",
      actors: null,
      vars: { ENVIRONMENT: "staging", GIT_SHA: "test-sha" },
      linq,
      actorReset: hook,
    });

    for (const root of [production, test]) {
      const restore = root.install();
      try {
        expect(tryReset(), root.environment).toBe("none");
      } finally {
        restore();
      }
    }
    expect(asked).toEqual([]);

    const restore = staging.install();
    try {
      expect(tryReset()).toBe("none");
      expect(asked).toEqual([OWNER_ACTOR]);
    } finally {
      restore();
    }
    expect(tryReset()).toBe("none");
    expect(asked).toEqual([OWNER_ACTOR]);
  });
});

// ---- the hop rig ---------------------------------------------------------------------------------------------------

/** The webhook as Linq posts it to {BASE_PATH}/webhooks/linq: the three headers and the raw body. */
function webhookRequest(webhook: SignedWebhook): Request {
  return new Request(`https://rosie.test${env.BASE_PATH}/webhooks/linq`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": webhook.webhookId,
      "webhook-timestamp": webhook.timestamp,
      "webhook-signature": webhook.signature,
    },
    body: webhook.raw,
  });
}

/** The root for "test", every joined port fed its double, as hop 12's tests compose it. */
function testRoot(fakes: SkeletonFakes, actors: HandleActors<DurableObjectId>): Root {
  return composeRoot({
    environment: "test",
    sets: { fake: fakes.ports },
    actors,
    vars: env,
    clock: fakes.clock,
    linq: fakes.linqInputs,
    handleKey: fakes.handleKeys.call,
    chatOpenCall: fakes.dispatch.openChat,
    safetyReaders: fakes.models.readers,
    turnRows: fakes.turnRows.calls,
    bundleReads: fakes.bundleReads.calls,
    handleTargets: fakes.handleTargets.call,
    frontierScope: fakes.frontier.scope,
    deciders: fakes.decide.deciders,
    gateReads: fakes.gate.reads,
    composeReads: fakes.compose.reads,
    composers: fakes.composer.composers,
    finalizeData: fakes.finalize.data,
    outboxCalls: fakes.dispatch.outbox,
    sendStateCall: fakes.dispatch.sendState,
    linqSendCall: fakes.linq.call,
    retryQueue: fakes.retryQueue,
    armingCalls: fakes.arming.calls,
    flags: fakeFlags([SKELETON_FLAG]),
  });
}

/** The JOIN as recording 2 names it: K-06 text-imessage.json's form from test owner 1, on Sam's chat (imessage). */
function joinAsRecorded(): LinqInboundEvent {
  if (JOIN_TEXT_OF_RECORDING === undefined) throw new Error("recording 2's context holds its text");
  return {
    ...(structuredClone(textFixture) as Json),
    eventId: JOIN_TEXT_OF_RECORDING.eventId,
    handle: { ...TEST_OWNER_1.handle },
    body: JOIN_TEXT_OF_RECORDING.words,
    sentAt: JOIN_TEXT_OF_RECORDING.sentAt.utc,
    chatId: SAM_CHAT,
    messageId: `linq-msg-demo-in-${JOIN_TEXT_OF_RECORDING.eventId}`,
  } as unknown as LinqInboundEvent;
}

/** Waits until a committed turn's reply has ended and its lease is released (T-253). */
async function untilReplied(actorName: string, turnId: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const turn = (await actorOf(actorName).readTurns()).find((entry) => entry.turnId === turnId);
    if (turn?.state === "committed" && turn.leaseUntil === null) return;
    if (Date.now() - started > WAIT_MS) {
      throw new Error(`gave up waiting for the turn's reply to end (state ${turn?.state ?? "none"})`);
    }
    await flush(5);
  }
}

/** The JOIN's turn, run through the rig to its reply: posted, its batch closed, its turn run; its turn id. */
async function runJoin(root: Root, fakes: SkeletonFakes): Promise<string> {
  const join = joinAsRecorded();
  fakes.known(join.eventId);
  const response = await root.linqWebhook(webhookRequest(await fakes.sign(join)));
  expect(response.status).toBe(200);
  await settle(OWNER_ACTOR);
  await fakes.clock.advance(QUIET_MS);
  await runDurableObjectAlarm(stubOf(OWNER_ACTOR));
  const turnId = await turnIdOf([join.eventId]);
  await untilReplied(OWNER_ACTOR, turnId);
  await settle(OWNER_ACTOR);
  return turnId;
}

/** This run of the turn's commit request (commit-first.json, named for the turn). */
function requestOf(turn: LeasedTurn): CommitTurnRequest {
  const base = commitFirst.request as unknown as CommitTurnRequest;
  return {
    ...base,
    turn: {
      ...base.turn,
      id: turn.turnId,
      eventIds: turn.eventIds,
      traceId: turn.traceId,
      joinedTraceIds: turn.joinedTraceIds,
      tries: turn.tries,
    },
  };
}

/**
 * tp-01 held as since Nov 15, before the deploy: a text from its number that the read finds an emergency in, with the
 * core down and the direct line failing (no path, as on staging, where turnFace and linqDirect are closed), so its line
 * fails, its after_safe hold has no core id and its re-read is 30 s on; its turn commits and ends. Its doubles are put
 * back after.
 */
async function holdTp01(fakes: SkeletonFakes): Promise<void> {
  const eventId = "evt-sam-t1452-held";
  const h = harness(keys, { [eventId]: { ...(safetyEmergencyNow as unknown as SafetyResult), eventId } });
  h.core.down = true;
  h.direct.fail = true;
  const first = commitFirst.outcome as unknown as CommitTurnAnswer;
  const restores = [
    setSafetyDeps({
      ...h.deps,
      clock: { now: () => fakes.clock.now(), after: () => new Promise<void>(() => undefined) },
    }),
    setBatchHooks({ clock: fakes.clock }),
    setBundleDeps(fakeBundles().deps),
    setLeaseHooks({
      runTurn: async (turn) => {
        await turn.commit(requestOf(turn));
      },
      commit: (request) => Promise.resolve({ ...first, turnId: request.turn.id }),
    }),
  ];
  try {
    const overrides: Json = { eventId, body: EMERGENCY_TEXT, handle: { ...TEST_OWNER_1.handle } };
    const prepared = await prepareHandoff(
      {
        event: { ...(textFixture as Json), ...overrides, traceId: TRACE } as InboundEvent,
        partKey: null,
        traceId: TRACE,
        bundleId: BUNDLE,
      },
      keys,
    );
    if (prepared.door !== "actor") throw new Error("not an actor event");
    const ns = namespace();
    const adapter: ActorNamespace<DurableObjectId> = {
      idFromName: (name) => ns.idFromName(name),
      get: (id): HandleActorRpc => ns.get(id),
    };
    expect(await durableObjectActor(adapter).accept(prepared.handoff)).toBe("written");
    await settle(OWNER_ACTOR);
    expect(await actorOf(OWNER_ACTOR).readSafety()).toEqual([
      expect.objectContaining({ eventId, state: "lineFailed", danger: true, path: "none" }),
    ]);
    expect(await actorOf(OWNER_ACTOR).readHolds()).toEqual([
      { eventId, holdId: null, rule: "after_safe", blocksBooking: true, released: false },
    ]);
    expect((await actorOf(OWNER_ACTOR).readTurns()).map((turn) => turn.state)).toEqual(["committed"]);
    // Its re-read, 30 s on (the test clock runs on the Workers clock, so it is due within the next 30 s).
    const schedule = await scheduleOf(OWNER_ACTOR);
    expect(schedule.map((entry) => entry.kind)).toEqual(["safetyRead"]);
    expect(schedule[0]?.due_ms).toBeGreaterThan(fakes.clock.now());
    expect(schedule[0]?.due_ms).toBeLessThanOrEqual(fakes.clock.now() + 30_000);
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

function scheduleOf(actorName: string): Promise<{ kind: string; due_ms: number }[]> {
  return runInDurableObject(stubOf(actorName), (_, state) =>
    state.storage.sql
      .exec<{ kind: string; due_ms: number }>("SELECT kind, due_ms FROM batch_schedule ORDER BY due_ms, kind")
      .toArray(),
  );
}

describe("a stuck tp-01 clears, and its next JOIN commits through the hop rig with the reply not held", () => {
  it(
    "the list as it ships clears tp-01 at its next alarm (no re-read due, no alarm set, no hold, no text unread); then the JOIN's commit is handed no hold and no unread text, commits, and its S1-02 part goes to the Linq double",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const fakes = skeletonFakes();
      await holdTp01(fakes);

      // The deploy: the rig's root is the test environment's, which never sets the hook, so staging's own hook (the list
      // as it ships, no allow-list number) is set here, as staging's root sets it.
      const root = testRoot(fakes, handleActors());
      const restores = [root.install(), setStagingReset(stagingActorReset({ ENVIRONMENT: "staging" }))];
      try {
        await fakes.clock.advance(30_000);
        expect(await runDurableObjectAlarm(stubOf(OWNER_ACTOR))).toBe(true);
        await settle(OWNER_ACTOR);

        expect(await actorOf(OWNER_ACTOR).readSafety()).toEqual([]);
        expect(await actorOf(OWNER_ACTOR).readHolds()).toEqual([]);
        expect(await actorOf(OWNER_ACTOR).routineHeld()).toBe(false);
        expect(await scheduleOf(OWNER_ACTOR)).toEqual([]);
        expect(
          await runInDurableObject(stubOf(OWNER_ACTOR), (_, state) => state.storage.getAlarm()),
        ).toBeNull();
        expect(resetLines(log)).toEqual([
          expect.objectContaining({
            outcome: "applied",
            entries: [FIRST_ENTRY],
            targets: ["tp-01"],
            removed: expect.objectContaining({ texts: 1, holds: 1, openHolds: 1 }) as unknown,
          }),
        ]);
        expect(JSON.stringify(resetLines(log))).not.toContain(TP01_NUMBER.slice(2));

        // Its next JOIN, through the rig: the gate is handed no hold and no unread text, and the reply goes.
        const watched = watchGate(root);
        restores.push(() => {
          watched.restore();
        });
        const turnId = await runJoin(root, fakes);

        expect(watched.calls).toHaveLength(1);
        expect(watched.calls[0]?.at).toEqual({ holds: [], unread: [] });
        expect(watched.calls[0]?.answer).toMatchObject({ result: "committed" });
        expect(fakes.linq.requests.map((request) => request.idempotencyKey)).toEqual([
          expect.stringContaining(`outbox-s1-02-${turnId}-1`),
        ]);
        // The entry applied once: the JOIN's hand-off and alarms reset nothing again.
        expect(resetLines(log).map((line) => line.outcome)).toEqual(["applied"]);
      } finally {
        for (const restore of restores.reverse()) restore();
      }
    },
  );
});
