// Doubles for the composition root's tests (T-550): the fake set the test environment binds (./picks.ts), every port on
// the doubles the runtime's own tests already use, answering the walking skeleton's turn as T-260's runtime trace test
// does (runtime/test/trace-e2e.worker.test.ts): Sam's text, S1-02's frontier, decide and commit retargeted to the running
// turn's id, S1-02's compose input and finalize-pass.json retargeted to the row the commit wrote, the dispatcher's K-05
// store holding that row, and a delivery receipt that arms A7-03's clock. Not imported by the Worker.
//
//   linqVerify   a K-11 verify fake in the gateway tests' manner (T-241's K-11 double: it checks no HMAC, which is the
//                adapter's): a webhook it signed, unchanged, verifies back to its K-06 event and part key
//   sealing      gateway/test-support fakeKeyStore
//   safetyRead   safety/test-support fakeRead, answering safety-no.json for each text the test names (`known`)
//   stateReads   bundle/test-support fakeBundles; safety/test-support fixtureBundle; guard/test-support fakeTargets with
//                Sam's S1-02 targets; Sam's party and ids; each named text's safety result; dispatch/test-support
//                FakeRecipients and FakeSendState; clocks/arming-support's question facts and actor directory
//   turnFace     turn/test-support fakeTurnFace (frontier, gate, compose input from the S1-02 fixtures) and
//                safety/test-support fakeCore
//   decide       turn/test-support fakeDecide (decide-s1-02-choose.json)
//   composer     turn/test-support fakeComposer (finalize-pass.json's plan)
//   finalize     the same fakeTurnFace (finalize-pass.json)
//   dataAccess   turn/test-support fakeRows (the commit's one row), dispatch/test-support FakeOutboxStore, and
//                clocks/arming-support's K-05 armClock and cancelClock
//   linqSend     dispatch/test-support FakeLinq and safety/test-support fakeDirect
//
// One test clock stands behind every fake that keeps time and behind the root itself. The contract fixtures come through
// npm's workspace link (@rosie/contracts). Test values only: the master's sample cast, the frozen fixtures' ids and the
// fictional 555-01xx numbers (rule 9).

import finalizePass from "@rosie/contracts/tool-api/fixtures/finalize-pass.json";
import buildFrontierS102 from "@rosie/contracts/tool-api/fixtures/build-frontier-s1-02.json";
import commitS102 from "@rosie/contracts/tool-api/fixtures/commit-s1-02.json";
import composeInputS102 from "@rosie/contracts/tool-api/fixtures/compose-input-s1-02.json";
import decideS102 from "@rosie/contracts/model/fixtures/decide-s1-02-choose.json";

import { fakeBundles, type FakeBundles } from "../bundle/test-support";
import { A7_03_QUESTION, wireArming, type WiredArming } from "../clocks/arming-support";
import { FakeLinq, FakeOutboxStore, FakeRecipients, FakeSendState } from "../dispatch/test-support";
import { fakeKeyStore, type FakeKeyStore } from "../gateway/test-support";
import type { InboundEvent, LinqPort, VerifyWebhookRequest } from "../gateway/types";
import { fakeTargets, type FakeTargets } from "../guard/test-support";
import { fakeCore, fakeDirect, fakeRead, fixtureBundle } from "../safety/test-support";
import type { HandleIds, SafetyResult } from "../safety/types";
import {
  composerOf,
  decided,
  decideOf,
  fakeComposer,
  fakeDecide,
  fakeRows,
  fakeTurnFace,
  planned,
  rowsOf,
  safetyNoFor,
  SAM,
  SAM_S1_02_TARGETS,
  targetsAnswer,
  turnFaceOf,
  unplannedRow,
  type FakeTurnFace,
} from "../turn/test-support";
import type { Ports } from "./ports";
import type { RootClock } from "./root";

// ---- one clock for every fake ------------------------------------------------------------------------------------

/** The Workers clock plus what the test moves it on; `after` waits on it, polled, as the fixtures' clocks are. */
export interface TestClock extends RootClock {
  utc(): string;
  advance(ms: number): Promise<void>;
}

const flush = (ms = 12): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export function testClock(): TestClock {
  let moved = 0;
  const now = (): number => Date.now() + moved;
  return {
    now,
    utc: () => new Date(now()).toISOString(),
    async after(ms) {
      const at = now() + ms;
      while (now() < at) await flush(1);
    },
    async advance(ms) {
      moved += ms;
      await flush();
    },
  };
}

// ---- K-11 verifyWebhook, as a fake ---------------------------------------------------------------------------------

/** A webhook as it reaches the gateway: the three header values and the raw body. */
export interface FakeWebhook {
  readonly webhookId: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly raw: string;
}

export interface FakeLinqVerify extends LinqPort {
  /** The webhook for one K-06 event and the part key a receipt echoes: the fake verifies it back to both. */
  sign(event: InboundEvent, partKey?: string | null): FakeWebhook;
  /** Every verify request, in order. */
  readonly requests: VerifyWebhookRequest[];
}

/**
 * K-11 verifyWebhook as a fake: a webhook it signed, with its id, timestamp, body and signature unchanged, verifies to its
 * K-06 event under the gateway's trace id, with its part key; anything else is rejected as badSignature. The signature is
 * a made-up token, never a secret.
 */
export function fakeLinqVerify(clock: RootClock): FakeLinqVerify {
  const signed = new Map<string, { webhook: FakeWebhook; event: InboundEvent; partKey: string | null }>();
  const requests: VerifyWebhookRequest[] = [];
  return {
    requests,
    sign(event, partKey = null) {
      const webhook: FakeWebhook = {
        webhookId: `msg_fake_${String(signed.size + 1)}`,
        timestamp: String(Math.floor(clock.now() / 1000)),
        signature: `v1,fake-${crypto.randomUUID()}`,
        raw: JSON.stringify(event),
      };
      signed.set(webhook.webhookId, { webhook, event: structuredClone(event), partKey });
      return webhook;
    },
    verifyWebhook(request) {
      requests.push(request);
      const known = signed.get(request.webhookId);
      if (
        known?.webhook.timestamp !== request.timestamp ||
        known.webhook.raw !== request.raw ||
        known.webhook.signature !== request.signature
      ) {
        return Promise.resolve({ result: "rejected", httpStatus: 401, reason: "badSignature" });
      }
      return Promise.resolve({
        result: "event",
        httpStatus: 200,
        event: { ...structuredClone(known.event), traceId: request.traceId },
        partKey: known.partKey,
      });
    },
  };
}

// ---- the walking skeleton's turn -----------------------------------------------------------------------------------

/** The row commit-s1-02.json writes (S1-04's question to Sam): the one the turn composes and the dispatcher sends. */
export const SKELETON_ROW = commitS102.outcome.written.outboxRows[0]?.id ?? "out-s1-04-sam";
/** Sam's chat with Rosie's line, as his texts and receipts name it. */
export const SAM_CHAT = "linq-chat-demo-sam";

const FIXTURE_ROW = composeInputS102.request.outboxRowId;
const FIXTURE_TURN = composeInputS102.request.caller.turnId;
const S1_02_TURN = commitS102.request.turn.id;

/** Sam's ids as K-04 names them, for the safety read's calls. */
const SAM_IDS: HandleIds = {
  handleId: SAM.party.handleId,
  businessId: SAM.party.businessId,
  personId: SAM.party.personId,
  bookingId: null,
};

/** Every pair [from, to] swapped wherever the value names it as a whole string (a fixture's ids to the running turn's). */
function swap<T>(value: T, pairs: readonly (readonly [string, string])[]): T {
  let text = JSON.stringify(value);
  for (const [from, to] of pairs) text = text.replaceAll(JSON.stringify(from), JSON.stringify(to));
  return JSON.parse(text) as T;
}

export interface SkeletonFakes {
  /** The fake set the test environment binds. */
  readonly ports: Ports;
  readonly clock: TestClock;
  readonly verify: FakeLinqVerify;
  readonly keys: FakeKeyStore;
  readonly face: FakeTurnFace;
  readonly targets: FakeTargets;
  readonly bundles: FakeBundles;
  readonly store: FakeOutboxStore;
  readonly linq: FakeLinq;
  readonly arming: WiredArming;
  /**
   * Sets a text's safety result before it is sent: safety-no.json under its event id, what the read on arrival answers and
   * what the turn's commit records (K-09 README default 5).
   */
  known(eventId: string): void;
}

/** Every port on its fake, answering the walking skeleton's turn for Sam (S1-02), on one test clock. */
export function skeletonFakes(clock: TestClock = testClock()): SkeletonFakes {
  const keys = fakeKeyStore();
  // Read when each call is made: the read on arrival answers, and the turn's commit records, what `known` set by then.
  const answers: Record<string, SafetyResult> = {};

  const face = fakeTurnFace();
  const ai = fakeDecide(face.log);
  const composer = fakeComposer(face.log);
  const rows = fakeRows(face.log);
  face.frontier = (request) => swap(buildFrontierS102.outcome, [[S1_02_TURN, request.turn.id]]);
  ai.decide = (context) => decided(swap(decideS102, [[S1_02_TURN, context.turnId]]));
  face.gate = (request) => swap(commitS102.outcome, [[S1_02_TURN, request.turn.id]]) as never;
  face.composeInput = (request) =>
    swap(composeInputS102.outcome, [
      [FIXTURE_ROW, request.outboxRowId],
      [FIXTURE_TURN, request.caller.turnId],
    ]) as never;
  face.finalize = (request) => swap(finalizePass.outcome, [[FIXTURE_ROW, request.outboxRowId]]) as never;
  composer.compose = () => planned(finalizePass.request.plan.plan);
  rows.unplanned = () => ({ result: "rows", rows: [unplannedRow(SKELETON_ROW, 1, SAM.party.handleId)] });
  const turnFace = turnFaceOf(face);

  const targets = fakeTargets();
  targets.answers.set(SAM.party.handleId, targetsAnswer(SAM.party.handleId, SAM_S1_02_TARGETS));
  const bundles = fakeBundles();
  const store = new FakeOutboxStore([
    {
      id: SKELETON_ROW,
      recipient: SAM.party.handleId,
      commitSeq: 1,
      sends: finalizePass.outcome.finalParts.sends.map((send) => ({
        ...send,
        kind: "words" as const,
        calendarFile: "none" as const,
      })),
      openQuestionId: A7_03_QUESTION,
      sendClass: "quick_reply",
    },
  ]);
  const linq = new FakeLinq(() => clock.utc());
  const arming = wireArming();
  const verify = fakeLinqVerify(clock);

  const ports: Ports = {
    linqVerify: verify,
    sealing: keys,
    safetyRead: fakeRead(clock, answers),
    stateReads: {
      bundles: bundles.deps,
      safety: {
        directory: { idsOf: () => Promise.resolve(SAM_IDS) },
        bundle: fixtureBundle(),
        isStopped: () => false,
      },
      targets: targets.port,
      turn: {
        directory: { partyOf: () => Promise.resolve(SAM.party) },
        safety: {
          resultsOf: (eventIds) =>
            Promise.resolve(
              eventIds.flatMap((eventId) => {
                const result = answers[eventId];
                return result === undefined ? [] : [structuredClone(result)];
              }),
            ),
        },
      },
      dispatch: {
        recipients: new FakeRecipients({
          [SAM.party.handleId]: { to: SAM.handle.address, chatId: SAM_CHAT, service: "imessage" },
        }),
        sendState: new FakeSendState(),
      },
      arming: { facts: arming.facts.reader, directory: arming.actors.directory },
    },
    turnFace: {
      buildFrontier: (request, trace) => turnFace.buildFrontier(request, trace),
      closestEntries: (request, trace) => turnFace.closestEntries(request, trace),
      gateAndCommit: (request, at, trace) => turnFace.gateAndCommit(request, at, trace),
      composeInput: (request, trace) => turnFace.composeInput(request, trace),
      safetyCore: fakeCore(clock),
    },
    decide: decideOf(ai),
    composer: composerOf(composer),
    finalize: { finalizeMessage: (request, trace) => turnFace.finalizeMessage(request, trace) },
    dataAccess: { rows: rowsOf(rows), outbox: store, clocks: arming.data.data },
    linqSend: { parts: linq, direct: fakeDirect(clock) },
  };

  return {
    ports,
    clock,
    verify,
    keys,
    face,
    targets,
    bundles,
    store,
    linq,
    arming,
    known(eventId) {
      answers[eventId] = safetyNoFor(eventId);
    },
  };
}
