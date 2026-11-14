// T-1326 (T-270's handoff; T-1313's condition g; DL-615, DL-699, DL-719): the root joins the PostgreSQL-down path, in the
// Workers runtime. `install()` calls setDbOutageDeps with DbOutageDeps' six fields, each a port as the root holds it
// (Root.outage): the probe, K-05 v1 readActiveBundle through the bundle port; the sealing key store; the direct line; the
// safety read's directory; and the down path's own two ports (T-1363: stopOrStart and timerFire, kept apart from D-017's
// twenty-one: Root.downPathBindings). Each closed or failing port reads as down or fails closed (RULES 7.2).
//
// Through root.install(), with PostgreSQL forced down: the root's K-05 doubles behind the probe, the pin and the commit
// (the bundle reads and the turn-row calls) unreachable, the safety read's shared core down, and the stopOrStart port
// refusing, while the gateway's key call and chat open answer (a text the gateway cannot seal is never stored, so the
// down path follows the texts it holds: T-1324's handoff a). The keyword copy is the actor's own: the list of the bundle
// a text arrived under (bundle v0's stand-in while PostgreSQL is down), copied on arrival from the pool's BUNDLES binding
// (T-1324), where a test publishes its manifest.
//
//   - a plain text read as another text gets the safety read's timeout line once, straight through Linq, and the down
//     path's 20 s sends no second (T-1313's condition g); a STOP gets none, but its reply and the stopped flag from the
//     copy (T-270); a text not yet read (no keyword list: unknown) gets none; a danger text's safety line goes within 5 s;
//     and on return each actor's write-on-return queue writes each record once: the line's, the STOP's, the danger's;
//   - a text with a verdict gets the down path's own line once at 20 s (T-270);
//   - RULES 7.2 (DL-719; the security reviewer's note a on T-1363): with stopOrStart closed, as staging and production
//     bind it, a STOP the actor takes while PostgreSQL is down gets its reply and its local copy, but its record can never
//     be written: the replay answers notBack, so the handle stays known down with its lease held, and PostgreSQL's phone
//     row never gets the STOP. The number is no less protected than on today's unjoined path (every outage line withheld,
//     every outage row dropped): the actor's one reading says stopped for it, and no outage line goes to it.
//
// The Durable Objects' storage and the pool's KV are reset after each test. Test values only (rule 9): the fictional
// 555-01xx numbers, made-up words and the frozen fixtures' ids and words.
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import {
  QUIET_MS,
  type BatchEntry,
  type CopiesView,
  type HandleActor,
  type SafetyEntry,
  type TurnEntry,
} from "../actor";
import { BUNDLE_A, keyIn, textAt } from "../bundle/test-support";
import { actorNameOf } from "../gateway";
import { OUTAGE_WAIT_MS, PROBE_MS, type DbOutage, type OutageView } from "../outage/db";
import { dbFakes, idsOf } from "../outage/db/test-support";
import { fixtureBundle } from "../safety/test-support";
import { SAFETY_LINE_BUDGET_MS } from "../safety/types";
import type { Span } from "../trace";
import { leaks, spansOfLogLines } from "../trace/hop-check";
import { SAM, until } from "../turn/test-support";
import { closedPorts, NotJoinedError } from "./closed";
import { DOWN_PATH_PORTS, PORTS } from "./ports";
import { NoDatabaseError, NoStateReadError, type BundleReadCalls, type TurnRowCalls } from "./real";
import { composeRoot, workerRoot, type HandleActors, type Root } from "./root";
import { SKELETON_FLAG } from "./skeleton";
import {
  fakeFlags,
  JOIN_TEXT,
  SAM_TRADES_TEXT,
  skeletonFakes,
  type LinqInboundEvent,
  type SignedWebhook,
  type SkeletonFakes,
} from "./test-support";

type Json = Record<string, unknown>;
type Namespace = DurableObjectNamespace<HandleActor>;
/** One send straight through Linq, as the direct line's fake keeps it. */
type DirectSend = SkeletonFakes["direct"]["sent"][number];

interface Handle {
  readonly kind: string;
  readonly address: string;
}

/** A run through the Workers runtime's own steps, with real 2 s tries: a resource guard, not part of any claim. */
const TEST_MS = 60_000;
/** How long a wait for the actor's own work may take on a machine busy with other builds. */
const WAIT_MS = 20_000;
/** How long the safety double waits before it answers: past each 2 s try and the actor's 4 s deadline. */
const DELAY_MS = 4500;
/** The safety read's deadline: no verdict in 4 s gives the timeout rule (T-246). */
const DEADLINE_MS = 4000;

/** Made-up words holding the fixture bundle's danger words "cut won't stop bleeding"; the double holds no read for them. */
const DANGER_WORDS = "Test words: my cut won't stop bleeding";
/** The outage line's words as the fixture bundle writes them (K-01 fixed line `outage`), which both paths send. */
const OUTAGE_TEXT = fixtureBundle().fixedLine("outage")?.text ?? "";

/** One fictional number per handle (555-0170 to 555-0178), so no test's actor holds another's texts. */
const handleOf = (line: number): Handle => ({ kind: "phone", address: `+155555501${String(line)}` });

/** Each number in every form one could leak in. */
const formsOf = (handles: readonly Handle[]): string[] =>
  handles.flatMap((handle) => [handle.address, handle.address.slice(1), handle.address.slice(2)]);

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

/** The HandleActor namespace as the root takes it (exports.HandleActor in the pool). */
function handleActors(): HandleActors<DurableObjectId> {
  const ns = namespace();
  return { idFromName: (name) => ns.idFromName(name), get: (id) => ns.get(id) };
}

function stubOf(handle: Handle): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(actorNameOf(handle)));
}

/** The actor's calls over RPC, typed here. */
interface ActorRpc {
  readSafety(): Promise<SafetyEntry[]>;
  readOutage(): Promise<OutageView>;
  readCopies(): Promise<CopiesView>;
  readBatches(): Promise<BatchEntry[]>;
  readTurns(): Promise<TurnEntry[]>;
  mayHaveStoppedNow(): Promise<boolean>;
  safetyIdle(): Promise<void>;
  outageIdle(): Promise<void>;
  batchIdle(): Promise<void>;
}

const actorOf = (handle: Handle): ActorRpc => stubOf(handle);

/** The down path's `stopPending` now, inside the actor: true while the path is unwired, whatever the actor holds. */
const stopPendingOf = (handle: Handle): Promise<boolean> =>
  runInDurableObject(stubOf(handle), (instance) =>
    (instance as unknown as { outage: DbOutage }).outage.stopPending(),
  );

/** A text of K-06's text-imessage.json form from this handle, with this event id and these words. */
function textOf(eventId: string, handle: Handle, body: string): LinqInboundEvent {
  return {
    ...(structuredClone(textFixture) as Json),
    eventId,
    handle: { ...handle },
    body,
    chatId: `linq-chat-t1326-${handle.address.slice(-2)}`,
    messageId: `linq-msg-t1326-in-${eventId}`,
  } as unknown as LinqInboundEvent;
}

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

/** Bundle v0's stand-in (K-01 bundle-v0-skeleton, bundle A) published in the pool's BUNDLES binding, as the deploy writes it. */
async function publishBundleA(): Promise<void> {
  const bundles = env.BUNDLES;
  if (bundles === undefined) throw new Error("the pool's staging environment binds BUNDLES (T-566)");
  const key = keyIn(BUNDLE_A, "manifest");
  await bundles.put(key, textAt(key));
}

/** A call to PostgreSQL while it is unreachable: no answer. */
const unreachable = (): Promise<never> => Promise.reject(new Error("PostgreSQL is unreachable"));

interface Rig {
  readonly fakes: SkeletonFakes;
  readonly root: Root;
  /**
   * PostgreSQL forced down (true) or answering again (false): the K-05 doubles the root's bundle and turn-row ports are
   * handed (the probe's readActiveBundle, the pin's reads, the commit and the park), the safety read's shared core, and
   * the stopOrStart port's fake, all at once.
   */
  postgres(down: boolean): void;
  /** Signs one K-06 event with the Linq double and posts it through root.linqWebhook. */
  post(event: LinqInboundEvent): Promise<void>;
  /** The clock moves on, then each handle's actor alarm runs, as the platform would at the stored time. */
  tick(ms: number, ...handles: Handle[]): Promise<void>;
  /** Each direct send through Linq from this handle's actor, in order. */
  sendsTo(handle: Handle): DirectSend[];
  spans(): Span[];
  restore(): void;
}

/**
 * The root for "test" with the HandleActor namespace and the skeleton flag on, every port the hops join fed its double
 * as ./hop3.worker.test.ts feeds them, the bundle reads and the turn-row calls behind the PostgreSQL switch, and the
 * actor's ports installed, the PostgreSQL-down path among them. With `stopOrStart` "closed", that port is the closed one
 * staging and production bind (./closed.ts), in place of the fake set's.
 */
function rig(log: MockInstance, options: { stopOrStart?: "fake" | "closed" } = {}): Rig {
  const fakes = skeletonFakes();
  const pg = { down: false };
  const bundleReads: BundleReadCalls = {
    readActiveBundle: () => (pg.down ? unreachable() : fakes.bundleReads.calls.readActiveBundle()),
    readBundleValue: (request) =>
      pg.down ? unreachable() : fakes.bundleReads.calls.readBundleValue(request),
  };
  const turnRows: TurnRowCalls = {
    commitTurn: (request) => (pg.down ? unreachable() : fakes.turnRows.calls.commitTurn(request)),
    parkTurn: (request) => (pg.down ? unreachable() : fakes.turnRows.calls.parkTurn(request)),
  };
  const fakeSet =
    options.stopOrStart === "closed"
      ? { ...fakes.ports, stopOrStart: closedPorts().stopOrStart }
      : fakes.ports;
  const root = composeRoot({
    environment: "test",
    sets: { fake: fakeSet },
    actors: handleActors(),
    vars: env,
    clock: fakes.clock,
    linq: fakes.linqInputs,
    handleKey: fakes.handleKeys.call,
    chatOpenCall: fakes.dispatch.openChat,
    safetyReaders: fakes.models.readers,
    turnRows,
    bundleReads,
    handleTargets: fakes.handleTargets.call,
    frontierScope: fakes.frontier.scope,
    deciders: fakes.decide.deciders,
    gateReads: fakes.gate.reads,
    flags: fakeFlags([SKELETON_FLAG]),
  });
  const restore = root.install();
  return {
    fakes,
    root,
    postgres(down) {
      pg.down = down;
      fakes.core.down = down;
      fakes.stopOrStart.down = down;
    },
    async post(event) {
      const response = await root.linqWebhook(webhookRequest(await fakes.sign(event)));
      if (response.status !== 200) throw new Error(`the gateway answered ${String(response.status)}`);
    },
    async tick(ms, ...handles) {
      await fakes.clock.advance(ms);
      for (const handle of handles) {
        await runDurableObjectAlarm(stubOf(handle));
        await actorOf(handle).outageIdle();
      }
    },
    sendsTo: (handle) => fakes.direct.sent.filter((sent) => sent.actorName === actorNameOf(handle)),
    spans: () => spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0])),
    restore,
  };
}

/** The one safety entry of a handle's text. */
async function safetyOf(handle: Handle, eventId: string): Promise<SafetyEntry | undefined> {
  return (await actorOf(handle).readSafety()).find((entry) => entry.eventId === eventId);
}

/** The phone row PostgreSQL holds for a number (K-04 phones, as the K-05 double the chat open wrote keeps it). */
function phoneRowOf(fakes: SkeletonFakes, handle: Handle): { readonly stopped: boolean } | undefined {
  return [...fakes.dispatch.phones.values()].find((phone) => phone.number === handle.address);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

// ---- the join -------------------------------------------------------------------------------------------------------

describe("the root joins the PostgreSQL-down path with its six ports, as it holds them (T-1326)", () => {
  it("in a test root: install() sets DbOutageDeps from the root's own ports (the probe over the bundle port, the sealing key store, the direct line, the safety read's directory, stopOrStart and timerFire), and its restore takes them away; the down path's two ports are on Root apart from D-017's twenty-one", async () => {
    const fakes = skeletonFakes();
    const root = composeRoot({
      environment: "test",
      sets: { fake: fakes.ports },
      actors: handleActors(),
      vars: env,
      clock: fakes.clock,
      handleKey: fakes.handleKeys.call,
      bundleReads: fakes.bundleReads.calls,
    });

    expect(root.outage.keys).toBe(root.ports.sealing);
    expect(root.outage.direct).toBe(root.ports.linqDirect);
    expect(root.outage.direct).toBe(fakes.direct);
    expect(root.outage.directory).toBe(root.ports.stateReads.safety.directory);
    expect(root.outage.core).toBe(root.ports.stopOrStart);
    expect(root.outage.core).toBe(fakes.stopOrStart);
    expect(root.outage.timers).toBe(root.ports.timerFire);
    expect(root.outage.timers).toBe(fakes.timerFire);
    expect(root.downPathBindings).toEqual(DOWN_PATH_PORTS.map((port) => ({ port, implementation: "fake" })));
    expect(root.bindings.map((binding) => binding.port)).toEqual([...PORTS]);

    // The probe is K-05 readActiveBundle through the bundle port: its active answer is true.
    expect(fakes.bundleReads.reads).toEqual([]);
    await expect(root.outage.probe()).resolves.toBe(true);
    expect(fakes.bundleReads.reads).toEqual([{ call: "readActiveBundle", key: null }]);

    // Joined by install() alone: the path reads nothing while unwired (stopPending true for any actor), and wired, an
    // actor with no text reads no stop; the restore puts the unwired path back.
    const handle = handleOf(70);
    expect(await stopPendingOf(handle)).toBe(true);
    const restore = root.install();
    try {
      expect(await stopPendingOf(handle)).toBe(false);
    } finally {
      restore();
    }
    expect(await stopPendingOf(handle)).toBe(true);
  });

  it("the probe reads PostgreSQL as answering only when K-05 answers from it: the active bundle or noActiveBundle is true, transient or an answer not K-05's is false, and a throw (no database bound, PostgreSQL unreachable) is the path's down", async () => {
    const fakes = skeletonFakes();
    const probeWith = (bundleReads: BundleReadCalls | null): Promise<boolean> =>
      composeRoot({
        environment: "test",
        sets: { fake: fakes.ports },
        actors: null,
        vars: env,
        bundleReads,
      }).outage.probe();
    const answering = (answer: unknown): BundleReadCalls => ({
      readActiveBundle: () => Promise.resolve(answer as never),
      readBundleValue: () => Promise.reject(new Error("not used")),
    });

    await expect(probeWith(fakes.bundleReads.calls)).resolves.toBe(true);
    await expect(probeWith(answering({ error: "noActiveBundle" }))).resolves.toBe(true);
    await expect(probeWith(answering({ error: "transient", sqlstate: "08006" }))).resolves.toBe(false);
    await expect(probeWith(answering({ result: "not K-05's" }))).resolves.toBe(false);
    await expect(probeWith(answering(null))).resolves.toBe(false);
    await expect(probeWith({ readActiveBundle: unreachable, readBundleValue: unreachable })).rejects.toThrow(
      "PostgreSQL is unreachable",
    );
    await expect(probeWith(null)).rejects.toThrow(new NoDatabaseError("readActiveBundle"));
  });

  it.each(["staging", "production"] as const)(
    "on %s, each of the six reads as down or fails closed: the probe and the key reads throw (no database bound, or closed), the direct line, the directory, stopOrStart and timerFire refuse, naming a port or a read and no value",
    async (environment) => {
      const root = workerRoot({ ENVIRONMENT: environment, BASE_PATH: "", DB_SCHEMA: "" });
      const handle = handleOf(71);
      const staging = environment === "staging";

      expect(root.downPathBindings).toEqual(
        DOWN_PATH_PORTS.map((port) => ({ port, implementation: "closed" })),
      );
      expect(root.bindings.map((binding) => binding.port)).toEqual([...PORTS]);
      await expect(root.outage.probe()).rejects.toThrow(
        staging ? new NoDatabaseError("readActiveBundle") : new NotJoinedError("bundles"),
      );
      await expect(root.outage.keys.getOrCreateKey(handle)).rejects.toThrow(
        staging ? new NoDatabaseError("handleSealingKey") : new NotJoinedError("sealing"),
      );
      await expect(
        root.outage.direct.send({
          actorName: actorNameOf(handle),
          fixedLineId: "outage",
          text: OUTAGE_TEXT,
          overrideOptout: false,
          idempotencyKey: "safety:evt-t1326-7101:outage",
        }),
      ).rejects.toThrow(new NotJoinedError("linqDirect"));
      await expect(root.outage.directory.idsOf(actorNameOf(handle))).rejects.toThrow(
        staging ? new NoStateReadError("idsOf") : new NotJoinedError("stateReads"),
      );
      await expect(root.outage.core.recordStopOrStart({} as never)).rejects.toThrow(
        new NotJoinedError("stopOrStart"),
      );
      await expect(root.outage.timers.fireFromCopy({} as never)).rejects.toThrow(
        new NotJoinedError("timerFire"),
      );
    },
  );
});

// ---- through root.install(), with PostgreSQL forced down ------------------------------------------------------------

describe("through root.install(), with PostgreSQL forced down (T-1313's condition g; T-270's behaviours)", () => {
  it(
    "a plain text read as another text gets the timeout line once, straight through Linq, and the down path's 20 s sends no second; a STOP gets none, but its reply and the stopped flag from the copy; a danger text's safety line goes within 5 s; and on return each record is written once",
    { timeout: TEST_MS },
    async () => {
      const run = rig(vi.spyOn(console, "log").mockImplementation(() => undefined));
      const other = handleOf(72);
      const stopper = handleOf(73);
      const danger = handleOf(74);
      try {
        const [otherText, stopText, dangerText] = ["evt-t1326-7201", "evt-t1326-7301", "evt-t1326-7401"];
        await publishBundleA();
        // The test root holds K-09's recordStopOrStart for the record on return (the down path's own double, as
        // kept-results.worker.test.ts hands it), behind the stopOrStart port's fake.
        const db = dbFakes(
          run.root.ports.sealing,
          {},
          { start: run.fakes.clock.now(), ids: idsOf(SAM.party) },
        );
        run.fakes.stopOrStart.core = db.outageDeps.core;
        run.postgres(true);
        run.fakes.models.delayMs = DELAY_MS;

        await run.post(textOf(otherText, other, JOIN_TEXT));
        await run.post(textOf(stopText, stopper, "STOP"));
        // Each read by the list of the bundle it arrived under, copied on arrival (bundle A: the stand-in the gateway
        // names while PostgreSQL is down), before its 4 s deadline.
        await actorOf(other).outageIdle();
        await actorOf(stopper).outageIdle();
        expect((await actorOf(other).readOutage()).texts).toEqual([
          expect.objectContaining({ eventId: otherText, kind: "other", line: null }),
        ]);
        expect(await actorOf(other).mayHaveStoppedNow()).toBe(false);
        // The STOP: taken by the actor at once (PostgreSQL asked, not answering), the flag copied first, its reply
        // straight through Linq past the opt-out, its record queued in the stop rank (T-270).
        expect((await actorOf(stopper).readOutage()).texts).toEqual([
          expect.objectContaining({ eventId: stopText, kind: "stop", keyword: "handled" }),
        ]);
        const stopperCopies = await actorOf(stopper).readCopies();
        expect(stopperCopies.stopped).toMatchObject({ stopped: true, phoneVersion: null });
        expect(stopperCopies.returns).toEqual([
          expect.objectContaining({
            key: `recordStopOrStart:${stopText}`,
            call: "recordStopOrStart",
            rank: "stop",
            refused: null,
          }),
        ]);
        expect(run.sendsTo(stopper)).toEqual([
          expect.objectContaining({
            fixedLineId: "stopReply",
            overrideOptout: true,
            idempotencyKey: `keyword:${stopText}:stopReply`,
          }),
        ]);

        // The danger text arrives last, and the 4 s deadline passes at once on the root's clock.
        await run.post(textOf(dangerText, danger, DANGER_WORDS));
        await run.fakes.clock.advance(DEADLINE_MS);
        for (const handle of [other, stopper, danger]) await actorOf(handle).safetyIdle();

        // The plain text: the timeout rule's outage line, once, straight through Linq (the core is down), not past an
        // opt-out, under the safety read's own key; its record queued for the return.
        expect(await safetyOf(other, otherText)).toMatchObject({
          state: "done",
          danger: false,
          path: "outage",
          lineId: "outage",
        });
        expect(run.sendsTo(other)).toEqual([
          expect.objectContaining({
            fixedLineId: "outage",
            text: OUTAGE_TEXT,
            overrideOptout: false,
            idempotencyKey: `safety:${otherText}:outage`,
          }),
        ]);
        expect((await actorOf(other).readCopies()).returns).toEqual([
          expect.objectContaining({ key: `sendFixedLine:${otherText}`, call: "sendFixedLine", rank: "rest" }),
        ]);
        // The STOP: no outage line by any path, its reply alone.
        expect(await safetyOf(stopper, stopText)).toMatchObject({ path: "none", lineId: "outage" });
        expect(run.sendsTo(stopper).map((sent) => sent.fixedLineId)).toEqual(["stopReply"]);
        expect(await actorOf(stopper).mayHaveStoppedNow()).toBe(true);
        // The danger text: its safety line straight through Linq, past any opt-out, within its 5 s of the text's arrival
        // at the actor (the read's own measure); its record queued in the danger rank.
        const dangerEntry = await safetyOf(danger, dangerText);
        expect(dangerEntry).toMatchObject({ danger: true, path: "direct", lineId: "safetyEmergency" });
        expect(dangerEntry?.handedAfterMs ?? Infinity).toBeLessThanOrEqual(SAFETY_LINE_BUDGET_MS);
        expect(run.sendsTo(danger)).toEqual([
          expect.objectContaining({
            fixedLineId: "safetyEmergency",
            overrideOptout: true,
            idempotencyKey: `safety:${dangerText}:safetyEmergency`,
          }),
        ]);
        expect((await actorOf(danger).readCopies()).returns).toEqual([
          expect.objectContaining({ call: "recordSafetyOutcome", rank: "danger" }),
        ]);
        // Nothing reached the core while PostgreSQL is down.
        expect(run.fakes.core.fixed).toEqual([]);
        expect(run.fakes.core.recorded).toEqual([]);

        // 20 s on: the down path asks PostgreSQL (still down) and sees the timeout rule's line: no second line.
        await run.tick(OUTAGE_WAIT_MS, other, stopper);
        expect((await actorOf(other).readOutage()).down).not.toBeNull();
        expect((await actorOf(other).readOutage()).texts).toEqual([
          expect.objectContaining({ eventId: otherText, kind: "other", line: "went" }),
        ]);
        expect(run.sendsTo(other)).toHaveLength(1);
        expect(run.sendsTo(stopper)).toHaveLength(1);

        // PostgreSQL answers again: each actor's queue is replayed once, and each record is written once (T-270).
        run.postgres(false);
        await run.tick(PROBE_MS, other, stopper, danger);
        await until(
          () =>
            db.stops.length === 1 &&
            run.fakes.core.fixed.length === 1 &&
            run.fakes.core.recorded.length === 1,
          "the three records on return",
          WAIT_MS,
        );
        expect(
          db.stops.map((request) => [request.kind, request.inboundEventId, request.sentByActor.fixedLineId]),
        ).toEqual([["stop", stopText, "stopReply"]]);
        expect(
          run.fakes.core.fixed.map((entry) => [
            entry.request.caller.requestId,
            entry.request.fixedLineId,
            entry.request.sentByActor?.fixedLineId,
          ]),
        ).toEqual([[`safety:${otherText}`, "outage", "outage"]]);
        expect(
          run.fakes.core.recorded.map((entry) => [
            entry.request.safety.eventId,
            entry.request.sentByActor?.fixedLineId,
          ]),
        ).toEqual([[dangerText, "safetyEmergency"]]);
        // The STOP's copy takes the phone row's version the core answered; nothing is left queued, and no handle is down.
        expect((await actorOf(stopper).readCopies()).stopped).toMatchObject({
          stopped: true,
          phoneVersion: 4,
        });
        for (const handle of [other, stopper, danger]) {
          expect((await actorOf(handle).readCopies()).returns).toEqual([]);
          expect((await actorOf(handle).readOutage()).down).toBeNull();
        }
        // No line went twice, and no span names a number or the words.
        expect(run.sendsTo(other)).toHaveLength(1);
        expect(run.sendsTo(stopper)).toHaveLength(1);
        expect(run.sendsTo(danger)).toHaveLength(1);
        expect(leaks(run.spans(), [...formsOf([other, stopper, danger]), DANGER_WORDS])).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "a text not yet read (no keyword list copied, so it reads unknown and may hold a stop word) gets no outage line, the timeout rule's or the down path's at 20 s; a danger text's safety line still goes",
    { timeout: TEST_MS },
    async () => {
      const run = rig(vi.spyOn(console, "log").mockImplementation(() => undefined));
      const unread = handleOf(75);
      const danger = handleOf(76);
      try {
        const [unreadText, dangerText] = ["evt-t1326-7501", "evt-t1326-7601"];
        // No manifest in BUNDLES: no keyword list is copied on arrival (T-1324's failed read).
        run.postgres(true);
        run.fakes.models.delayMs = DELAY_MS;
        await run.post(textOf(unreadText, unread, JOIN_TEXT));
        await actorOf(unread).outageIdle();
        expect((await actorOf(unread).readOutage()).texts).toEqual([
          expect.objectContaining({ eventId: unreadText, kind: "unknown" }),
        ]);
        expect(await actorOf(unread).mayHaveStoppedNow()).toBe(true);

        await run.post(textOf(dangerText, danger, DANGER_WORDS));
        await run.fakes.clock.advance(DEADLINE_MS);
        await actorOf(unread).safetyIdle();
        await actorOf(danger).safetyIdle();
        expect(await safetyOf(unread, unreadText)).toMatchObject({ path: "none", lineId: "outage" });
        expect(run.sendsTo(unread)).toEqual([]);
        const dangerEntry = await safetyOf(danger, dangerText);
        expect(dangerEntry).toMatchObject({ danger: true, path: "direct", lineId: "safetyEmergency" });
        expect(dangerEntry?.handedAfterMs ?? Infinity).toBeLessThanOrEqual(SAFETY_LINE_BUDGET_MS);
        expect(run.sendsTo(danger)).toEqual([
          expect.objectContaining({
            fixedLineId: "safetyEmergency",
            overrideOptout: true,
            idempotencyKey: `safety:${dangerText}:safetyEmergency`,
          }),
        ]);

        // 20 s on: PostgreSQL asked, still down; the text still may hold a stop word, so the down path withholds it too.
        await run.tick(OUTAGE_WAIT_MS, unread);
        expect((await actorOf(unread).readOutage()).down).not.toBeNull();
        expect((await actorOf(unread).readOutage()).texts).toEqual([
          expect.objectContaining({ eventId: unreadText, kind: "unknown", line: "stopped" }),
        ]);
        expect(run.sendsTo(unread)).toEqual([]);
        expect(run.fakes.core.fixed).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "a text that got its verdict gets the down path's own outage line once at 20 s, straight through Linq under the safety read's key for it, never again while PostgreSQL stays down, and its record is written once on return (T-270)",
    { timeout: TEST_MS },
    async () => {
      const run = rig(vi.spyOn(console, "log").mockImplementation(() => undefined));
      const handle = handleOf(77);
      try {
        const text = "evt-t1326-7701";
        await publishBundleA();
        run.postgres(true);
        const arrivedAt = run.fakes.clock.now();
        await run.post(textOf(text, handle, SAM_TRADES_TEXT));
        await actorOf(handle).safetyIdle();
        await actorOf(handle).outageIdle();
        // Its verdict (No) came in time: no timeout line; read as another text by bundle A's list.
        expect(await safetyOf(handle, text)).toMatchObject({ state: "done", path: "none", lineId: null });
        expect((await actorOf(handle).readOutage()).texts).toEqual([
          expect.objectContaining({ eventId: text, kind: "other", line: null }),
        ]);

        await run.tick(OUTAGE_WAIT_MS, handle);
        const sends = run.sendsTo(handle);
        expect(sends).toEqual([
          expect.objectContaining({
            fixedLineId: "outage",
            text: OUTAGE_TEXT,
            overrideOptout: false,
            idempotencyKey: `safety:${text}:outage`,
          }),
        ]);
        expect(sends[0]?.at ?? 0).toBeGreaterThanOrEqual(arrivedAt + OUTAGE_WAIT_MS);
        expect((await actorOf(handle).readOutage()).texts).toEqual([
          expect.objectContaining({ eventId: text, line: "sent" }),
        ]);
        expect((await actorOf(handle).readCopies()).returns).toEqual([
          expect.objectContaining({ key: `sendFixedLine:${text}`, call: "sendFixedLine", rank: "rest" }),
        ]);

        // Once: no second line, however long PostgreSQL stays down.
        await run.tick(PROBE_MS, handle);
        await run.tick(PROBE_MS, handle);
        expect(run.sendsTo(handle)).toHaveLength(1);

        // On return, its record is written once, with the line the actor sent.
        run.postgres(false);
        await run.tick(PROBE_MS, handle);
        await until(() => run.fakes.core.fixed.length === 1, "the line's record on return", WAIT_MS);
        expect(
          run.fakes.core.fixed.map((entry) => [
            entry.request.caller.requestId,
            entry.request.fixedLineId,
            entry.request.sentByActor?.linqMessageId,
          ]),
        ).toEqual([[`safety:${text}`, "outage", "linq-1"]]);
        expect((await actorOf(handle).readOutage()).down).toBeNull();
        expect(run.sendsTo(handle)).toHaveLength(1);
      } finally {
        run.restore();
      }
    },
  );
});

// ---- RULES 7.2, with stopOrStart closed (DL-719) --------------------------------------------------------------------

describe("RULES 7.2 with stopOrStart closed, as staging and production bind it (DL-719; the security reviewer's note a on T-1363)", () => {
  it(
    "a STOP the actor takes while PostgreSQL is down gets its reply and its local copy; on return its record is refused by the closed port (notBack), so the handle stays known down with its lease held and PostgreSQL's phone row never gets the STOP; the number stays as protected as on the unjoined path: the actor's one reading says stopped, and no outage line goes to it",
    { timeout: TEST_MS },
    async () => {
      const run = rig(
        vi.spyOn(console, "log").mockImplementation(() => undefined),
        {
          stopOrStart: "closed",
        },
      );
      const handle = handleOf(78);
      try {
        const [stopText, laterText] = ["evt-t1326-7801", "evt-t1326-7802"];
        expect(run.root.ports.stopOrStart).not.toBe(run.fakes.stopOrStart);
        await publishBundleA();
        run.postgres(true);
        run.fakes.models.delayMs = DELAY_MS;
        await run.post(textOf(stopText, handle, "STOP"));
        await actorOf(handle).outageIdle();

        // Taken at once: the flag copied, the reply straight through Linq past the opt-out, the record queued (rank stop).
        expect((await actorOf(handle).readOutage()).texts).toEqual([
          expect.objectContaining({ eventId: stopText, kind: "stop", keyword: "handled" }),
        ]);
        expect((await actorOf(handle).readCopies()).stopped).toMatchObject({
          stopped: true,
          phoneVersion: null,
        });
        expect(run.sendsTo(handle)).toEqual([
          expect.objectContaining({
            fixedLineId: "stopReply",
            overrideOptout: true,
            idempotencyKey: `keyword:${stopText}:stopReply`,
          }),
        ]);

        // PostgreSQL answers again: the probe says so, the replay sends the STOP's record to the closed port, which
        // refuses it before anything is read or written (no answer: notBack). The record stays queued, and the handle
        // stays known down, its next ask 30 s on.
        run.postgres(false);
        const probesBefore = run.fakes.bundleReads.reads.length;
        await run.tick(PROBE_MS, handle);
        await run.tick(PROBE_MS, handle);
        expect(run.fakes.bundleReads.reads.length).toBeGreaterThan(probesBefore);
        const outage = await actorOf(handle).readOutage();
        expect(outage.down).not.toBeNull();
        expect((await actorOf(handle).readCopies()).returns).toEqual([
          expect.objectContaining({ key: `recordStopOrStart:${stopText}`, rank: "stop", refused: null }),
        ]);
        expect(run.fakes.stopOrStart.requests).toEqual([]);
        // PostgreSQL's phone row, which limit 8 reads for other senders' rows, never gets the STOP.
        expect(phoneRowOf(run.fakes, handle)).toMatchObject({ stopped: false });

        // The lease is held: a later text's batch stays with the batch window and no turn opens for the handle.
        await run.post(textOf(laterText, handle, JOIN_TEXT));
        await actorOf(handle).outageIdle();
        await run.tick(QUIET_MS, handle);
        await actorOf(handle).batchIdle();
        expect(await actorOf(handle).readTurns()).toEqual([]);
        expect(
          (await actorOf(handle).readBatches()).filter(
            (batch) => batch.handed && batch.eventIds.includes(laterText),
          ),
        ).toEqual([]);

        // No outage line goes to the number by either path: the timeout rule's at 4 s (the copy says stopped), nor the
        // down path's at 20 s. The actor's one reading, which the dispatcher asks right before an outage row goes, says
        // stopped, so every outage row to it is dropped, as on the unjoined path.
        await run.fakes.clock.advance(DEADLINE_MS);
        await actorOf(handle).safetyIdle();
        expect(await safetyOf(handle, laterText)).toMatchObject({ path: "none", lineId: "outage" });
        await run.tick(OUTAGE_WAIT_MS, handle);
        expect((await actorOf(handle).readOutage()).texts).toContainEqual(
          expect.objectContaining({ eventId: laterText, kind: "other", line: "stopped" }),
        );
        expect(await actorOf(handle).mayHaveStoppedNow()).toBe(true);
        expect(run.sendsTo(handle).map((sent) => sent.fixedLineId)).toEqual(["stopReply"]);
        expect(run.fakes.core.fixed).toEqual([]);
        expect(phoneRowOf(run.fakes, handle)).toMatchObject({ stopped: false });
        expect((await actorOf(handle).readOutage()).down).not.toBeNull();
      } finally {
        run.restore();
      }
    },
  );
});
