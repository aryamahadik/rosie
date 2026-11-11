// T-555's join, hop 4 of D-017 (C-048, C-049; build prompt section 10, D-017; 02-contracts section 11, 'Batch and turn
// lease': K-04 turns, K-06 event ids), in the Workers runtime: this hop's e2e line is proven here until T-1149 moves the
// skeleton's local target into workerd (DL-332). The composition root is composed for the test environment as hop 3's
// tests compose it (the HandleActor namespace, the skeleton flag on, the actor's ports installed), now with K-05's
// commitTurn and parkTurn handed in (RootOptions.turnRows: ./test-support.ts fakeTurnRows, answering as commit-first.json
// and park-turn.json). Each text goes in through root.linqWebhook and through every joined hop once, in order: signed by
// the Linq double and verified (hop 1), sealed under K-05's key into its handle's ordered inbox (hop 2), read for danger
// on arrival over the recorded-model double (hop 3), then into its handle's batch window and turn lease (this hop), under
// its own K-06 event id. The Tool API's gate and commit is the joined one since T-559 (./real.ts realGate, fed its reads'
// doubles): the turn's one commit goes to K-05 through the root's turn-row port, which the turn's own park (T-253) writes
// through too.
//
//   - Two texts 2 s apart: one batch and one turn, whose id is T-248's hash of the two event ids (ADR-013; CQ-09), and
//     K-05's commit writes that turn's one row under it, with the first text's trace id and the second's joined.
//   - A third text closes the batch at once, before any alarm or deadline: one turn over the three, and one row.
//   - The same webhook delivered twice in parallel: one inbox entry, one safety read, one batch, one turn id, one lease (one
//     lease span) and one row; the repeat is dropped at receipt.
//   - A turn whose commit K-05 never takes (transient) lapses three times and is parked: K-05's park writes its one row
//     under the same turn id, on try 3, and a later commit of that id answers turnParked.
//
// The Durable Objects' storage is not cleared between this file's tests, so each test's texts go to a handle no other test
// uses. Test values only (rule 9): the master's sample cast, the fictional 555-01xx numbers and made-up words.
import { HAIKU_MODEL } from "@rosie/ai/src/gateway/index";
import commitFirst from "@rosie/contracts/data-access/fixtures/commit-first.json";
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { LEASE_MS, MAX_TRIES, QUIET_MS, turnIdOf, type HandleActor } from "../actor";
import type { InboxEntry } from "../actor/inbox";
import { actorNameOf } from "../gateway";
import type { Span } from "../trace";
import { leaks, spansOfLogLines, spansOfTrace } from "../trace/hop-check";
import { SAM, until } from "../turn/test-support";
import { composeRoot, SKELETON_FLAG, type HandleActors, type Root } from "./index";
import {
  BUNDLE_V0,
  fakeFlags,
  JOIN_TEXT,
  SAM_CHAT,
  SAM_TRADES_TEXT,
  skeletonFakes,
  type LinqInboundEvent,
  type SignedWebhook,
  type SkeletonFakes,
} from "./test-support";

type Json = Record<string, unknown>;
type Namespace = DurableObjectNamespace<HandleActor>;

/** A run through the Workers runtime's own steps: a resource guard above Vitest's 5 s default. */
const TEST_MS = 30_000;
/** How long a step of the actor's lent work may take before a wait gives up. */
const WAIT_MS = 15_000;

/** The fictional numbers this file's texts come from, in each form a number could leak in. */
const CAST_NUMBERS = ["0100", "0101", "0102", "0103"].flatMap((line) => [
  `+1555555${line}`,
  `1555555${line}`,
  `555555${line}`,
]);

/** K-06 text-imessage.json's words: the third text the recorded-model double holds a safety recording for. */
const IMESSAGE_TEXT = String((textFixture as Json).body);

/** Alex M. of the sample cast (the fictional 555-0101), and two more fictional handles no other test of this file uses. */
const ALEX = { kind: "phone", address: "+15555550101" };
const PLAIN = { kind: "phone", address: "+15555550102" };
const LAPSED = { kind: "phone", address: "+15555550103" };

const SAM_ACTOR = actorNameOf(SAM.handle);
const ALEX_ACTOR = actorNameOf(ALEX);
const PLAIN_ACTOR = actorNameOf(PLAIN);
const LAPSED_ACTOR = actorNameOf(LAPSED);

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

/** The HandleActor namespace as the root takes it (exports.HandleActor in the pool until T-566 binds env's). */
function handleActors(): HandleActors<DurableObjectId> {
  const ns = namespace();
  return { idFromName: (name) => ns.idFromName(name), get: (id) => ns.get(id) };
}

function stubOf(actorName: string): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(actorName));
}

/** The handle's ordered inbox, read inside its Durable Object. */
function inboxOf(actorName: string): Promise<InboxEntry[]> {
  return runInDurableObject(stubOf(actorName), (actor: HandleActor) => actor.readInbox());
}

/** Waits until the actor has read every text and handed on, and run, what its batch window and lease can. */
async function settle(actorName: string): Promise<void> {
  await stubOf(actorName).safetyIdle();
  await stubOf(actorName).batchIdle();
}

/** A text of K-06's text-imessage.json form from this handle, with this event id and these words. */
function textOf(eventId: string, handle: { kind: string; address: string }, body: string): LinqInboundEvent {
  return {
    ...(structuredClone(textFixture) as Json),
    eventId,
    handle: { ...handle },
    body,
    chatId: handle.address === SAM.handle.address ? SAM_CHAT : "linq-chat-demo-alex",
    messageId: `linq-msg-demo-in-${eventId}`,
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

function traceIdOf(response: Response): string {
  const traceId = response.headers.get("x-trace-id");
  if (traceId === null) throw new Error("the gateway answered with no trace id");
  return traceId;
}

/** The handle actor's own receive span, beside the gateway's (T-1108). */
const actorReceive = (span: Span): boolean => span.hop === "receive" && span.got?.door === "handleActor";

interface Rig {
  readonly fakes: SkeletonFakes;
  readonly root: Root;
  /** Signs one K-06 event with the Linq double, posts it through root.linqWebhook, and answers its trace id. */
  post(event: LinqInboundEvent): Promise<string>;
  spans(): Span[];
  restore(): void;
}

/**
 * The root for "test" with the HandleActor namespace, the skeleton flag on and K-05's turn-row calls (the double), its
 * actor ports installed. The bundle and targets ports (joined by T-556) are fed their K-05 doubles: the turn pins bundle
 * v0 as bundles/v0 publishes it; and so is the frontier's scope (joined by T-557), so each turn's frontier answers; decide
 * (joined by T-558) is fed @rosie/ai's deciders over the recorded-model double, each test recording its turn's reads; and
 * the gate (joined by T-559) is fed its reads' doubles, its one commit through the root's turn-row port, so the turn goes
 * on to its commit.
 */
function rig(log: MockInstance): Rig {
  const fakes = skeletonFakes();
  const root = composeRoot({
    environment: "test",
    sets: { fake: fakes.ports },
    actors: handleActors(),
    vars: env,
    clock: fakes.clock,
    linq: fakes.linqInputs,
    handleKey: fakes.handleKeys.call,
    safetyReaders: fakes.models.readers,
    turnRows: fakes.turnRows.calls,
    bundleReads: fakes.bundleReads.calls,
    handleTargets: fakes.handleTargets.call,
    frontierScope: fakes.frontier.scope,
    deciders: fakes.decide.deciders,
    gateReads: fakes.gate.reads,
    composeReads: fakes.compose.reads,
    composers: fakes.composer.composers,
    flags: fakeFlags([SKELETON_FLAG]),
  });
  const restore = root.install();
  return {
    fakes,
    root,
    async post(event) {
      const response = await root.linqWebhook(webhookRequest(await fakes.sign(event)));
      if (response.status !== 200) throw new Error(`the gateway answered ${String(response.status)}`);
      return traceIdOf(response);
    },
    spans: () => spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0])),
    restore,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("hop 4 joined: the batch window and the turn lease run on the texts' K-06 event ids, and one batch is one turn row", () => {
  it(
    "two texts 2 s apart: one batch and one turn, whose id is T-248's hash of their event ids, and K-05's commit writes that turn's one row",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        const first = "evt-sam-0401";
        const second = "evt-sam-0402";
        run.fakes.known(first);
        run.fakes.known(second);
        run.fakes.decide.recordTurn([first, second]);
        const firstTrace = await run.post(textOf(first, SAM.handle, JOIN_TEXT));
        await run.fakes.clock.advance(2000);
        const secondTrace = await run.post(textOf(second, SAM.handle, SAM_TRADES_TEXT));
        await settle(SAM_ACTOR);

        // Each text read on arrival (one Haiku call each), both in the one open batch, and no turn yet.
        expect(run.fakes.models.calls.map((call) => call.text)).toEqual([JOIN_TEXT, SAM_TRADES_TEXT]);
        expect(await stubOf(SAM_ACTOR).readBatches()).toEqual([
          { batchId: 0, reason: null, handed: false, eventIds: [first, second] },
        ]);
        expect(await stubOf(SAM_ACTOR).readTurns()).toEqual([]);

        // Quiet for 3 s after the second text: the window closes the batch, and the lease opens one turn over both.
        await run.fakes.clock.advance(QUIET_MS);
        await runDurableObjectAlarm(stubOf(SAM_ACTOR));
        await until(() => run.fakes.turnRows.turns.size > 0, "the turn's row", WAIT_MS);
        await settle(SAM_ACTOR);

        const turnId = await turnIdOf([first, second]);
        const batches = await stubOf(SAM_ACTOR).readBatches();
        expect(batches).toMatchObject([{ batchId: 1, handed: true, eventIds: [first, second] }]);
        // Closed by the window's clock, never by a count: 3 s quiet (or 6 s after the first, on a slow machine).
        expect(["quiet", "max"]).toContain(batches[0]?.reason);
        expect(
          (await stubOf(SAM_ACTOR).readTurns()).map((turn) => [turn.turnId, turn.eventIds, turn.tries]),
        ).toEqual([[turnId, [first, second], 1]]);

        // K-05's commit wrote that turn's one row: the lease's turn id, the batch's event ids, the first text's trace id
        // with the second's joined, and the bundle the turn pinned.
        expect(run.fakes.turnRows.commits.map((request) => [request.turn.id, request.turn.eventIds])).toEqual(
          [[turnId, [first, second]]],
        );
        expect([...run.fakes.turnRows.turns.values()]).toEqual([
          {
            id: turnId,
            handleId: SAM.party.handleId,
            eventIds: [first, second],
            state: "committed",
            bundleId: BUNDLE_V0,
            traceId: firstTrace,
            joinedTraceIds: [secondTrace],
            tries: 1,
            at: commitFirst.outcome.committedAt,
          },
        ]);
        // The turn's lease span is on the first text's trace, under the same turn id.
        expect(
          run
            .spans()
            .filter((span) => span.hop === "lease")
            .map((span) => [span.trace_id, span.turn_id]),
        ).toEqual([[firstTrace, turnId]]);
        expect(leaks(run.spans(), CAST_NUMBERS)).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "a third text closes the batch at once, before any alarm or deadline: one turn over the three, and one row",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        const ids = ["evt-alex-0401", "evt-alex-0402", "evt-alex-0403"];
        const words = [JOIN_TEXT, SAM_TRADES_TEXT, IMESSAGE_TEXT];
        for (const id of ids) run.fakes.known(id);
        run.fakes.decide.recordTurn(ids);
        const traces: string[] = [];
        for (const [index, id] of ids.entries()) {
          if (index > 0) await run.fakes.clock.advance(1000);
          traces.push(await run.post(textOf(id, ALEX, words[index] ?? JOIN_TEXT)));
          if (index === 1) {
            expect(await stubOf(ALEX_ACTOR).readBatches()).toEqual([
              { batchId: 0, reason: null, handed: false, eventIds: ids.slice(0, 2) },
            ]);
          }
        }

        // The third text's own write closed the batch: no alarm has run, and the clock is 2 s past the first text.
        expect(await stubOf(ALEX_ACTOR).readBatches()).toMatchObject([
          { batchId: 1, reason: "third", eventIds: ids },
        ]);
        await settle(ALEX_ACTOR);
        await until(() => run.fakes.turnRows.turns.size > 0, "the turn's row", WAIT_MS);
        await settle(ALEX_ACTOR);

        const turnId = await turnIdOf(ids);
        expect(await stubOf(ALEX_ACTOR).readBatches()).toEqual([
          { batchId: 1, reason: "third", handed: true, eventIds: ids },
        ]);
        expect((await stubOf(ALEX_ACTOR).readTurns()).map((turn) => [turn.turnId, turn.eventIds])).toEqual([
          [turnId, ids],
        ]);
        expect(
          [...run.fakes.turnRows.turns.values()].map((row) => [
            row.id,
            row.eventIds,
            row.state,
            row.traceId,
            row.joinedTraceIds,
          ]),
        ).toEqual([[turnId, ids, "committed", traces[0], traces.slice(1)]]);
        expect(run.fakes.turnRows.commits.map((request) => request.turn.id)).toEqual([turnId]);
        expect(leaks(run.spans(), CAST_NUMBERS)).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "the same webhook delivered twice in parallel: one inbox entry, one safety read, one batch, one turn id and one lease, and one row",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        const eventId = "evt-plain-0401";
        run.fakes.known(eventId);
        run.fakes.decide.recordTurn([eventId]);
        const webhook = await run.fakes.sign(textOf(eventId, PLAIN, JOIN_TEXT));
        const answers = await Promise.all([
          run.root.linqWebhook(webhookRequest(webhook)),
          run.root.linqWebhook(webhookRequest(webhook)),
        ]);
        expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
        const traces = answers.map(traceIdOf);
        await settle(PLAIN_ACTOR);

        // One entry in the inbox, under one of the two traces; the other was dropped at receipt, with nothing after it.
        const inbox = await inboxOf(PLAIN_ACTOR);
        expect(inbox.map((entry) => entry.event.eventId)).toEqual([eventId]);
        const kept = inbox[0]?.traceId ?? "";
        expect(traces).toContain(kept);
        const repeat = traces.find((traceId) => traceId !== kept) ?? "";
        expect(
          spansOfTrace(run.spans(), repeat)
            .filter((span) => !actorReceive(span))
            .map((span) => [span.hop, span.outcome]),
        ).toEqual([["receive", "dropped"]]);
        // One read on arrival, for the one entry.
        expect(run.fakes.models.calls).toEqual([{ model: HAIKU_MODEL, text: JOIN_TEXT }]);

        await run.fakes.clock.advance(QUIET_MS);
        await runDurableObjectAlarm(stubOf(PLAIN_ACTOR));
        await until(() => run.fakes.turnRows.turns.size > 0, "the turn's row", WAIT_MS);
        await settle(PLAIN_ACTOR);

        const turnId = await turnIdOf([eventId]);
        expect(await stubOf(PLAIN_ACTOR).readBatches()).toEqual([
          { batchId: 1, reason: "quiet", handed: true, eventIds: [eventId] },
        ]);
        expect((await stubOf(PLAIN_ACTOR).readTurns()).map((turn) => [turn.turnId, turn.eventIds])).toEqual([
          [turnId, [eventId]],
        ]);
        // One lease: one lease span, on the kept text's trace, for that turn id; one commit and one row.
        expect(
          run
            .spans()
            .filter((span) => span.hop === "lease")
            .map((span) => [span.trace_id, span.turn_id]),
        ).toEqual([[kept, turnId]]);
        expect(run.fakes.turnRows.commits.map((request) => request.turn.id)).toEqual([turnId]);
        expect([...run.fakes.turnRows.turns.keys()]).toEqual([turnId]);
        expect(leaks(run.spans(), CAST_NUMBERS)).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "a turn whose commit K-05 never takes lapses three times and is parked: K-05's park writes its one row under the same turn id, on try 3, and a later commit of that id answers turnParked",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        const eventId = "evt-lapsed-0401";
        run.fakes.known(eventId);
        // Each of its three runs decides it again (a new run of the turn): the same two recorded reads each time.
        run.fakes.decide.recordTurn([eventId]);
        run.fakes.turnRows.failCommitsWith = { error: "transient" };
        const traceId = await run.post(textOf(eventId, LAPSED, JOIN_TEXT));
        await settle(LAPSED_ACTOR);
        await run.fakes.clock.advance(QUIET_MS);
        await runDurableObjectAlarm(stubOf(LAPSED_ACTOR));
        const turnId = await turnIdOf([eventId]);

        // Each run sends its commit, and the same request once more on K-05's transient answer; nothing is written. The
        // lease's lapse after 60 s reruns the turn under the same turn id, one try on.
        for (let tries = 1; tries <= MAX_TRIES; tries += 1) {
          await until(
            () => run.fakes.turnRows.commits.length === 2 * tries,
            `try ${String(tries)}'s commits`,
            WAIT_MS,
          );
          await settle(LAPSED_ACTOR);
          await run.fakes.clock.advance(LEASE_MS);
          await runDurableObjectAlarm(stubOf(LAPSED_ACTOR));
        }
        // The third lapse with no commit parks the turn through K-05's park: its one row, under the same turn id.
        await until(
          () => run.fakes.turnRows.turns.get(turnId)?.state === "parked",
          "the parked row",
          WAIT_MS,
        );
        await settle(LAPSED_ACTOR);

        expect(run.fakes.turnRows.commits.map((request) => [request.turn.id, request.turn.tries])).toEqual([
          [turnId, 1],
          [turnId, 1],
          [turnId, 2],
          [turnId, 2],
          [turnId, 3],
          [turnId, 3],
        ]);
        expect(
          run.fakes.turnRows.parks.map((request) => [
            request.turn.id,
            request.turn.tries,
            request.outboxRows.map((row) => row.id),
          ]),
        ).toEqual([[turnId, MAX_TRIES, [`out-${turnId}-parked`]]]);
        expect([...run.fakes.turnRows.turns.values()]).toMatchObject([
          { id: turnId, eventIds: [eventId], state: "parked", traceId, tries: MAX_TRIES },
        ]);
        expect(
          (await stubOf(LAPSED_ACTOR).readTurns()).map((turn) => [turn.turnId, turn.state, turn.tries]),
        ).toEqual([[turnId, "parked", MAX_TRIES]]);

        // One row for the turn id: a later commit of it answers turnParked and writes nothing.
        run.fakes.turnRows.failCommitsWith = null;
        const parkedAt = run.fakes.turnRows.turns.get(turnId)?.at;
        const last = run.fakes.turnRows.commits.at(-1);
        if (last === undefined) throw new Error("no commit was sent");
        expect(await run.root.ports.turnRow.commitTurn(last)).toEqual({
          error: "turnParked",
          turnId,
          parkedAt,
        });
        expect([...run.fakes.turnRows.turns.keys()]).toEqual([turnId]);
        expect(leaks(run.spans(), CAST_NUMBERS)).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );
});
