// Doubles for the composition root's tests (T-550, T-552): the fake set the test environment binds (./picks.ts), every
// port not joined yet on the doubles the runtime's own tests already use, answering the walking skeleton's turn as T-260's
// runtime trace test does (runtime/test/trace-e2e.worker.test.ts): Sam's text, S1-02's frontier, decide and commit
// retargeted to the running turn's id, S1-02's compose input and finalize-pass.json retargeted to the row the commit
// wrote, the dispatcher's K-05 store holding that row, and a delivery receipt that arms A7-03's clock. Not imported by the
// Worker.
//
//   linqVerify   joined (T-552): the root binds the Linq adapter's verify (./real.ts). What it is fed comes from here:
//                the Linq double's signer (T-412, @rosie/adapters' double-webhooks) signs each webhook under a
//                webhook secret made up for the run, never Linq's, and the root's verify gets the same secret, with the
//                chat lookup a receipt needs (Sam's chat is Sam's number)
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
// One test clock stands behind every fake that keeps time and behind the root itself. The contract fixtures and the Linq
// double come through npm's workspace links (@rosie/contracts, @rosie/adapters). Test values only: the master's sample
// cast, the frozen fixtures' ids, the fictional 555-01xx numbers (rule 9) and a webhook secret made up for each run.

import { createLinqWebhookDouble, type LinqWebhookDouble } from "@rosie/adapters/linq/double-webhooks";
import type { InboundEvent as LinqEvent, VerifyWebhookRequest } from "@rosie/adapters/linq/webhook";
import finalizePass from "@rosie/contracts/tool-api/fixtures/finalize-pass.json";
import buildFrontierS102 from "@rosie/contracts/tool-api/fixtures/build-frontier-s1-02.json";
import commitS102 from "@rosie/contracts/tool-api/fixtures/commit-s1-02.json";
import composeInputS102 from "@rosie/contracts/tool-api/fixtures/compose-input-s1-02.json";
import decideS102 from "@rosie/contracts/model/fixtures/decide-s1-02-choose.json";
import type { FlagSubject } from "@rosie/db/repo/flags";
import type { ConstraintError, HandleSealingKeyRequest } from "@rosie/db/repo/handle-keys";
import type { TransientError } from "@rosie/db/repo/targets";

import { fakeBundles, type FakeBundles } from "../bundle/test-support";
import { A7_03_QUESTION, wireArming, type WiredArming } from "../clocks/arming-support";
import { FakeLinq, FakeOutboxStore, FakeRecipients, FakeSendState } from "../dispatch/test-support";
import { fakeKeyStore, type FakeKeyStore } from "../gateway/test-support";
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
import type { HandleSealingKeyCall, LinqVerifyInputs } from "./real";
import type { RootClock } from "./root";
import type { ReleaseFlags } from "./skeleton";

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

// ---- K-11: webhooks signed by the Linq double, for the root's real verify ------------------------------------------

/** A K-06 v1 event of Linq's, as the Linq double signs it and the adapter's verify gives it back. */
export type LinqInboundEvent = LinqEvent;

/** A webhook as the Linq double signs it: the three header values, the raw body, and its receipt time and trace. */
export type SignedWebhook = VerifyWebhookRequest;

/** A webhook secret made up for one run, in Linq's form ("whsec_" and 32 random bytes in base64): never Linq's, never kept. */
export function testWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `whsec_${btoa(String.fromCharCode(...bytes))}`;
}

/** An instant as K-06 writes it: UTC, whole seconds, ending in Z. */
function utcSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/[.][0-9]+Z$/, "Z");
}

/**
 * The same webhook with one byte of its signature's MAC changed (K-11 `oneByteChanged`): the first base64 letter after
 * "v1," carries the first byte's high bits, so the MAC no longer matches.
 */
export function withSignatureChanged(webhook: SignedWebhook): SignedWebhook {
  const prefix = "v1,";
  if (!webhook.signature.startsWith(prefix)) throw new Error("the double signs v1,<base64>");
  const changed = webhook.signature.charAt(prefix.length) === "A" ? "B" : "A";
  return {
    ...webhook,
    signature: `${prefix}${changed}${webhook.signature.slice(prefix.length + 1)}`,
  };
}

// ---- K-05 v1.2 handleSealingKey, as a double (T-553; DL-313 ruling 4) ----------------------------------------------

export interface FakeHandleKeys {
  /** K-05's call as the root's real sealing port is fed it, its database bound. */
  readonly call: HandleSealingKeyCall;
  /** Every request, in order. */
  readonly requests: HandleSealingKeyRequest[];
  /** The key object handed out for a handle's address, for a test that opens a box itself; throws when none was made. */
  keyOf(address: string): CryptoKey;
  /** When set, every call answers it with no key, as K-05's constraint or transient answer. */
  failWith: ConstraintError | TransientError | null;
}

/**
 * K-05 v1.2 handleSealingKey as a double answering as the handle-key-*.json fixtures do: at a number's first sight its
 * handle and person take the request's new ids and a key is made (handle-key-first-sight.json); each later call for that
 * number finds them and writes nothing (handle-key-first-sight-repeat.json). The key is a random AES-256-GCM key object,
 * for encrypt and decrypt, that cannot be exported (T-182's form), made for the run; its createdAt is `now`'s.
 */
export function fakeHandleKeys(now: () => number = Date.now): FakeHandleKeys {
  const known = new Map<string, { handleId: string; personId: string; createdAt: string; key: CryptoKey }>();
  const requests: HandleSealingKeyRequest[] = [];
  const keys: FakeHandleKeys = {
    requests,
    failWith: null,
    keyOf(address) {
      const entry = known.get(address);
      if (entry === undefined) throw new Error("no key was made for that handle");
      return entry.key;
    },
    async call(request) {
      requests.push(structuredClone(request));
      if (keys.failWith !== null) return { outcome: keys.failWith, dataKey: null };
      const found = known.get(request.handle.address);
      const entry = found ?? {
        handleId: request.newHandleId,
        personId: request.newPersonId,
        createdAt: utcSeconds(now()),
        key: (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
          "encrypt",
          "decrypt",
        ])) as CryptoKey,
      };
      known.set(request.handle.address, entry);
      const made = found === undefined;
      return {
        outcome: {
          result: "key",
          handleId: entry.handleId,
          personId: entry.personId,
          created: { handle: made, person: made, key: made },
          key: { wrappingKeyName: request.wrappingKeyName, createdAt: entry.createdAt, version: 1 },
        },
        dataKey: entry.key,
      };
    },
  };
  return keys;
}

// ---- T-185's release-flag read, as a fake --------------------------------------------------------------------------

export interface FakeFlags extends ReleaseFlags {
  /** Turns a flag on or off for the global scope. */
  set(name: string, enabled: boolean): void;
  /** Every read, in order: the flag's name and the subject it was read for. */
  readonly reads: { readonly name: string; readonly subject: FlagSubject | undefined }[];
  /** When set, every read throws it, as a database that cannot answer. */
  failWith: Error | null;
}

/**
 * T-185's readFlag as a fake, for the global scope only: a flag set on reads on; one set off, or never set, reads off (no
 * row at all is off).
 */
export function fakeFlags(on: readonly string[] = []): FakeFlags {
  const enabled = new Map<string, boolean>(on.map((name) => [name, true]));
  const reads: { name: string; subject: FlagSubject | undefined }[] = [];
  const flags: FakeFlags = {
    reads,
    failWith: null,
    set(name, value) {
      enabled.set(name, value);
    },
    readFlag(name, subject) {
      reads.push({ name, subject });
      if (flags.failWith !== null) return Promise.reject(flags.failWith);
      return Promise.resolve({ enabled: enabled.get(name) ?? false });
    },
  };
  return flags;
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
  /** The fake set the test environment binds: every port but the joined Linq verify, which the root builds (./real.ts). */
  readonly ports: Omit<Ports, "linqVerify">;
  readonly clock: TestClock;
  /** What the root's real Linq verify is fed (RootOptions.linq): the run's webhook secret and Sam's chat for a receipt. */
  readonly linqInputs: LinqVerifyInputs;
  /** The Linq double's signer (T-412), under the same made-up secret. */
  readonly webhooks: LinqWebhookDouble;
  /**
   * The webhook the Linq double signs for one K-06 event (and the part key a receipt echoes), received now on the test
   * clock (whole seconds), so it is inside the 300 s window of the gateway's receipt time.
   */
  sign(event: LinqInboundEvent, partKey?: string | null): Promise<SignedWebhook>;
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
  const secret = testWebhookSecret();
  const webhooks = createLinqWebhookDouble({ secret });
  const linqInputs: LinqVerifyInputs = {
    webhookSecret: () => secret,
    chatHandle: (chatId) => (chatId === SAM_CHAT ? SAM.handle.address : null),
  };

  const ports: Omit<Ports, "linqVerify"> = {
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
    linqInputs,
    webhooks,
    sign: (event, partKey = null) =>
      webhooks.sign({ event: { ...event, receivedAt: utcSeconds(clock.now()) }, partKey }),
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
