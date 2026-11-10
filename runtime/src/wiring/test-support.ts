// Doubles for the composition root's tests (T-550, T-552): the fake set the test environment binds (./picks.ts), every
// port not joined yet on the doubles the runtime's own tests already use, answering the walking skeleton's turn as T-260's
// runtime trace test does (runtime/test/trace-e2e.worker.test.ts): Sam's text, S1-02's commit retargeted to the running
// turn's id, S1-02's compose input and finalize-pass.json retargeted to the row the commit wrote, the dispatcher's K-05
// store holding that row, and a delivery receipt that arms A7-03's clock. The frontier is the joined one (T-557): its K-05
// double answers for test owner 1's seeded rows, so the turn's context is the real frontier's; and decide is the joined
// one (T-558), whose recorded-model double answers that context's reads. Not imported by the Worker.
//
//   linqVerify   joined (T-552): the root binds the Linq adapter's verify (./real.ts). What it is fed comes from here:
//                the Linq double's signer (T-412, @rosie/adapters' double-webhooks) signs each webhook under a
//                webhook secret made up for the run, never Linq's, and the root's verify gets the same secret, with the
//                chat lookup a receipt needs (Sam's chat is Sam's number)
//   sealing      joined (T-553): the root binds K-05 v1.2 handleSealingKey through its real sealing port (./real.ts
//                realSealing). What it is fed comes from here: `fakeHandleKeys`, a K-05 double answering as the
//                handle-key-*.json fixtures, each key a non-exportable AES-256-GCM key object made for the run
//   safetyRead   joined (T-554): the root binds @rosie/ai's safety read through its real port (./real.ts
//                realSafetyRead). What it is fed comes from here: `fakeSafetyModels`, the safety read (T-365) built over
//                a fake Messages API whose answers come from the recorded-model double (T-004) holding the skeleton's
//                texts (SKELETON_SAFETY_RECORDINGS, each seeded from safety-no.json), and able to wait before answering
//   turnRow      joined (T-555): the root binds K-05's commitTurn and parkTurn through its real turn-row port (./real.ts
//                realTurnRow). What it is fed comes from here: `fakeTurnRows`, a K-05 double answering as
//                commit-first.json, commit-repeat-same-turn.json and park-turn.json under each running turn's id, and
//                keeping the one K-04 turns row each turn id is written as; `gateThroughCommit` stands the Tool API's gate
//                and commit in for a hop's test, its one commit through the root's turn-row port, until T-559
//   bundles      joined (T-556): the root binds K-05 v1 item 7's bundle reads through its real bundle port (./real.ts
//                realBundles). What it is fed comes from here: `fakeBundleReads`, a K-05 double holding bundle v0 as
//                bundles/v0 publishes it (bundle.kv.json: every part's key and its exact text, the bytes T-569's publish
//                writes to KV and to PostgreSQL's copy), answering readActiveBundle in active-bundle.json's form with
//                that bundle's id and readBundleValue in bundle-value-on-miss.json's
//   targets      joined (T-556): the root binds K-05 v1.2 handleTargets through its real targets port (./real.ts
//                realTargets). What it is fed comes from here: `fakeHandleTargets`, a K-05 double holding test owner 1's
//                seeded rows (T-1148, db/seeds/skeleton.ts: handle-sam at the fictional 555-0100, person-sam, no role, no
//                phone row), answering for that handle as targets-first-text.json and notFound for any other
//   frontier     joined (T-557): the root binds @rosie/actions' turn face through its real frontier port (./real.ts
//                realFrontier), over the bundle the turn's run pinned. What it is fed comes from here:
//                `fakeFrontierScope`, the frontier's business scope over a K-05 v1.2 readTurnState double holding test
//                owner 1's seeded rows (T-1148: Lee's Barbershop's business head, Sam with no role, open question,
//                booking, phone row or language), answering as T-315's integration test shows the real readTurnState
//                answers on those rows under Lee's Barbershop's scope, and refusing a read that names another business
//                than the call's scope, as T-219's readTurnStateIn does
//   stateReads   safety/test-support fixtureBundle; Sam's party and ids; each named text's safety result;
//                dispatch/test-support FakeRecipients and FakeSendState; clocks/arming-support's question facts and actor
//                directory
//   turnFace     turn/test-support fakeTurnFace (closest entries, gate, compose input from the S1-02 fixtures) and
//                safety/test-support fakeCore
//   decide       joined (T-558): the root binds @rosie/ai's decide and its one Sonnet re-read through its real decide port
//                (./real.ts realDecide), one decider per bundle. What it is fed comes from here: `fakeDecideModels`, the
//                decider (T-369 createDecider) for bundle v0 as bundles/v0 publishes it and for bundle-mini-a, over a fake
//                Messages API whose answers come from the recorded-model double (T-004): ai/recordings' turn 1 recordings
//                as they are (recording 2 is the JOIN run's own; DL-347), decide-reads-disagree.json's three reads on its
//                context, and the reads a test records for its own turn of test owner 1's (`recordTurn`); it keeps each
//                context decide is given (the frontier's answer) and each call it answers
//   composer     turn/test-support fakeComposer (finalize-pass.json's plan)
//   finalize     the same fakeTurnFace (finalize-pass.json)
//   dataAccess   turn/test-support fakeRows (the commit's one row), dispatch/test-support FakeOutboxStore, and
//                clocks/arming-support's K-05 armClock and cancelClock
//   linqSend     dispatch/test-support FakeLinq and safety/test-support fakeDirect
//
// One test clock stands behind every fake that keeps time and behind the root itself. The contract fixtures and the Linq
// double come through npm's workspace links (@rosie/contracts, @rosie/adapters). Test values only: the master's sample
// cast, the frozen fixtures' ids, the fictional 555-01xx numbers (rule 9) and a webhook secret made up for each run.

import type { ReadTurnStateAnswer, ReadTurnStateRequest } from "@rosie/actions/src/frontier/assemble/types";
import { createLinqWebhookDouble, type LinqWebhookDouble } from "@rosie/adapters/linq/double-webhooks";
import type { InboundEvent as LinqEvent, VerifyWebhookRequest } from "@rosie/adapters/linq/webhook";
import joinRunContextJson from "@rosie/ai/recordings/contexts/join-s1-01.json";
import recordingsV11 from "@rosie/ai/recordings/recordings.v1.1.json";
import { createPromptCache, type CacheBundle, type CacheFlow } from "@rosie/ai/src/cache/index";
import { unescapeData } from "@rosie/ai/src/context/tags";
import { createDecider } from "@rosie/ai/src/decide/two-reads";
import type { Decider } from "@rosie/ai/src/decide/types";
import { KEY_VARIABLE, type FetchLike } from "@rosie/ai/src/gateway/index";
import { createRecordedModel } from "@rosie/ai/src/recorded-double/double";
import { NoRecordingError } from "@rosie/ai/src/recorded-double/errors";
import { canonicalJson, requestKey } from "@rosie/ai/src/recorded-double/key";
import type { RecordedModel } from "@rosie/ai/src/recorded-double/types";
import { turnStakes, type RoutingBundle, type RoutingContext } from "@rosie/ai/src/routing/index";
import { createSafetyReader, SAFETY_READ_PROMPT, type SafetyReader } from "@rosie/ai/src/safety/index";
import bundleMiniA from "@rosie/contracts/bundle/fixtures/bundle-mini-a.json";
import manifestFixture from "@rosie/contracts/bundle/fixtures/manifest.json";
import activeBundleJson from "@rosie/contracts/data-access/fixtures/active-bundle.json";
import commitFirstJson from "@rosie/contracts/data-access/fixtures/commit-first.json";
import commitRepeatJson from "@rosie/contracts/data-access/fixtures/commit-repeat-same-turn.json";
import parkTurnJson from "@rosie/contracts/data-access/fixtures/park-turn.json";
import targetsFirstTextJson from "@rosie/contracts/data-access/fixtures/targets-first-text.json";
import seedBusinessHead from "@rosie/contracts/db-schema/core/fixtures/seed-business-head.json";
import seedPersonRoles from "@rosie/contracts/db-schema/core/fixtures/seed-person-roles.json";
import textImessage from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import contextS101 from "@rosie/contracts/model/fixtures/context-s1-01.json";
import decideReadsDisagree from "@rosie/contracts/model/fixtures/decide-reads-disagree.json";
import decideS101Enter from "@rosie/contracts/model/fixtures/decide-s1-01-enter.json";
import safetyNo from "@rosie/contracts/model/fixtures/safety-no.json";
import finalizePass from "@rosie/contracts/tool-api/fixtures/finalize-pass.json";
import commitS102 from "@rosie/contracts/tool-api/fixtures/commit-s1-02.json";
import composeInputS102 from "@rosie/contracts/tool-api/fixtures/compose-input-s1-02.json";
import type { ReadActiveBundleResult, ReadBundleValueResult, StoredText } from "@rosie/db/repo/bundles";
import type { CommitTurnOutcome, CommitTurnRequest } from "@rosie/db/repo/commit-turn";
import type { FlagSubject } from "@rosie/db/repo/flags";
import type { ConstraintError, HandleSealingKeyRequest } from "@rosie/db/repo/handle-keys";
import type { ParkTurnOutcome, ParkTurnRequest as K05ParkTurnRequest } from "@rosie/db/repo/park";
import { BusinessScopeError } from "@rosie/db/repo/scope";
import type {
  HandleTargetsOutcome,
  HandleTargetsRequest as K05HandleTargetsRequest,
  TransientError,
} from "@rosie/db/repo/targets";

import bundleV0Kv from "../../../bundles/v0/bundle.kv.json";
import type { CommitTurnRef } from "../actor";
import { turnIdOf } from "../actor/lease";
import { BUNDLE_B } from "../bundle/test-support";
import { A7_03_QUESTION, wireArming, type WiredArming } from "../clocks/arming-support";
import { FakeLinq, FakeOutboxStore, FakeRecipients, FakeSendState } from "../dispatch/test-support";
import { fakeCore, fakeDirect, fixtureBundle, type FakeCore, type FakeDirect } from "../safety/test-support";
import type { HandleIds, SafetyResult } from "../safety/types";
import type { BundleId } from "../trace";
import {
  a7_17Context,
  composerOf,
  fakeComposer,
  fakeRows,
  fakeTurnFace,
  planned,
  rowsOf,
  safetyNoFor,
  SAM,
  turnFaceOf,
  unplannedRow,
  type FakeTurnFace,
} from "../turn/test-support";
import type { DecideContext, GateAndCommitAnswer, GateAndCommitRequest, GateCommitted } from "../turn/types";
import type { Ports } from "./ports";
import type {
  BundleReadCalls,
  CommitTurnCall,
  Deciders,
  FrontierScope,
  HandleSealingKeyCall,
  HandleTargetsCall,
  LinqVerifyInputs,
  SafetyReaders,
  TurnRowCalls,
} from "./real";
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

/** A number's handle, person and key as the K-05 double made them at its first sight. */
interface SightedHandle {
  handleId: string;
  personId: string;
  createdAt: string;
  key: CryptoKey;
}

/**
 * K-05 v1.2 handleSealingKey as a double answering as the handle-key-*.json fixtures do: at a number's first sight its
 * handle and person take the request's new ids and a key is made (handle-key-first-sight.json); each later call for that
 * number finds them and writes nothing (handle-key-first-sight-repeat.json). The key is a random AES-256-GCM key object,
 * for encrypt and decrypt, that cannot be exported (T-182's form), made for the run; its createdAt is `now`'s. A number's
 * first sight is kept from its first call on, so a call made while it is still being made waits for it and finds it, as
 * K-05's one transaction per call does (two webhooks of a new number at once give one handle and one key).
 */
export function fakeHandleKeys(now: () => number = Date.now): FakeHandleKeys {
  const known = new Map<string, SightedHandle>();
  const sighted = new Map<string, Promise<SightedHandle>>();
  const requests: HandleSealingKeyRequest[] = [];
  const firstSight = async (request: HandleSealingKeyRequest): Promise<SightedHandle> => ({
    handleId: request.newHandleId,
    personId: request.newPersonId,
    createdAt: utcSeconds(now()),
    key: (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ])) as CryptoKey,
  });
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
      const address = request.handle.address;
      const found = sighted.get(address);
      const pending = found ?? firstSight(request);
      if (found === undefined) sighted.set(address, pending);
      const entry = await pending;
      known.set(address, entry);
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

// ---- @rosie/ai's safety read over the recorded-model double (T-554) ------------------------------------------------

/** Sam's JOIN, his first text (D-017's human test; S1-01), as the e2e skeleton sends it. */
export const JOIN_TEXT = "JOIN";
/** A bare HELP, one of bundle v0's keywords (K-01 lists.keywords.help): the guard's code path (T-556's proof). */
export const HELP_TEXT = "HELP";
/** Sam's words in the runtime's skeleton trace test (./root.worker.test.ts). */
export const SAM_TRADES_TEXT = "Barbershop, plumbing, electrical";

/**
 * The skeleton's safety recordings, in T-004's form (ai/recordings): each text the wiring's tests send to the safety read,
 * seeded from K-02 v1's safety-no.json, so each reads No. Synthetic words only: Sam's JOIN, a bare HELP and his trades,
 * and K-06 text-imessage.json's body (rule 9). Every raw text is read on arrival, a keyword text too (arch 02 step S):
 * the guard's code path for a keyword comes after that read.
 */
export const SKELETON_SAFETY_RECORDINGS = {
  version: "v1",
  contract: "model.v1",
  recordings: [
    {
      id: "skeleton-join",
      kind: "safetyRead",
      request: { text: JOIN_TEXT },
      seed: { fixture: "safety-no.json" },
    },
    {
      id: "skeleton-help",
      kind: "safetyRead",
      request: { text: HELP_TEXT },
      seed: { fixture: "safety-no.json" },
    },
    {
      id: "skeleton-sam-trades",
      kind: "safetyRead",
      request: { text: SAM_TRADES_TEXT },
      seed: { fixture: "safety-no.json" },
    },
    {
      id: "skeleton-text-imessage",
      kind: "safetyRead",
      request: { text: textImessage.body },
      seed: { fixture: "safety-no.json" },
    },
  ],
} as const;

/** The K-02 v1 fixtures the skeleton's recordings are seeded from, by file. */
const SEEDS: Readonly<Record<string, { readonly read: unknown }>> = { "safety-no.json": safetyNo };

/**
 * The recorded-model double (T-004's `createRecordedModel`) holding the skeleton's recordings, each keyed by its request
 * as T-004's loader keys it and answering its seed's read. Built without the loader, which reads files and compiles
 * K-02's schema with Ajv, neither of which the Workers runtime allows; ./safety-read.test.ts holds every answer to the
 * loader's own, under Node.
 */
export function skeletonSafetyDouble(): RecordedModel {
  const held = new Map<string, { output: unknown }>();
  for (const recording of SKELETON_SAFETY_RECORDINGS.recordings) {
    const seed = SEEDS[recording.seed.fixture];
    if (seed === undefined) throw new Error(`no K-02 fixture ${recording.seed.fixture} to seed from`);
    held.set(requestKey("safetyRead", recording.request), { output: structuredClone(seed.read) });
  }
  return createRecordedModel(held);
}

/** K-01 v1's sample manifest: its two models (claude-haiku-5-5, claude-sonnet-5-5) and its prompts. */
const MANIFEST = manifestFixture as unknown as {
  readonly models: { readonly haiku: string; readonly sonnet: string };
  readonly prompts: CacheBundle["manifest"]["prompts"];
};

/** The words of a safety read's <text> element (ai/src/safety/prompt.ts safetyReadTurn), escaped as data. */
const TEXT_ELEMENT = /<text source="(?:text|page|agent)">([\s\S]*)<\/text>$/u;

/** The token counts each recorded answer reports. */
const USAGE = {
  input_tokens: 40,
  output_tokens: 60,
  cache_read_input_tokens: 1800,
  cache_creation_input_tokens: 0,
};

/** Resolves after `ms` real milliseconds, or rejects at once when the call is aborted (each try is cut off at 2 s). */
function waitOrAbort(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    });
  });
}

export interface FakeSafetyModels {
  /** What the root's real safety read is fed (RootOptions.safetyReaders): @rosie/ai's safety read for each bundle id. */
  readonly readers: SafetyReaders;
  /** Every model call the safety read made, in order: the model asked and the words it was given. */
  readonly calls: { readonly model: string; readonly text: string }[];
  /** How long each answer waits, in real milliseconds, before the double gives it: past 2 s, every try is cut off. */
  delayMs: number;
}

/**
 * @rosie/ai's safety read (T-365 `createSafetyReader`) for each bundle id, over K-01's sample manifest's models and this
 * build's safety read prompt, calling a fake Messages API and never a model (J-02): each call's answer is the double's
 * recording for its words, after `delayMs`; a text the double holds no recording for fails the call. The key is made up
 * for each run, never Anthropic's.
 */
export function fakeSafetyModels(recorded: Pick<RecordedModel, "safetyRead">): FakeSafetyModels {
  const calls: { model: string; text: string }[] = [];
  const env = { [KEY_VARIABLE]: `made-up-${crypto.randomUUID()}` };
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as {
      model?: string;
      messages?: { content?: string }[];
    };
    const text = unescapeData(TEXT_ELEMENT.exec(body.messages?.[0]?.content ?? "")?.[1] ?? "");
    calls.push({ model: body.model ?? "", text });
    if (models.delayMs > 0) await waitOrAbort(models.delayMs, init.signal);
    const output = await recorded.safetyRead({ text });
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(output) }],
        usage: USAGE,
      }),
      { status: 200 },
    );
  };
  const built = new Map<string, SafetyReader>();
  const models: FakeSafetyModels = {
    calls,
    delayMs: 0,
    readers(bundleId) {
      const key = `${bundleId.hash}/${String(bundleId.build)}`;
      const known = built.get(key);
      if (known !== undefined) return known;
      const reader = createSafetyReader({
        bundle: { bundleId, models: MANIFEST.models },
        prompts: createPromptCache({
          manifest: {
            bundleId,
            prompts: { ...MANIFEST.prompts, safetyRead: SAFETY_READ_PROMPT },
            partial: true,
          },
          flows: {},
        }),
        env,
        fetch,
      });
      built.set(key, reader);
      return reader;
    },
  };
  return models;
}

// ---- K-05 commitTurn and parkTurn, as a double: a turn's one row (T-555) ------------------------------------------

/** One K-04 turns row as the double writes it: once per turn id, as committed or parked (NQ-RT-3's default). */
export interface TurnsRow {
  readonly id: string;
  readonly handleId: string;
  readonly eventIds: readonly string[];
  readonly state: "committed" | "parked";
  readonly bundleId: { readonly hash: string; readonly build: number };
  readonly traceId: string;
  readonly joinedTraceIds: readonly string[];
  readonly tries: number;
  /** When it was committed (commit-first.json's committedAt) or parked (the park's parkedAt). */
  readonly at: string;
}

export interface FakeTurnRows {
  /** What the root's turn-row port is fed (RootOptions.turnRows): K-05's two calls, over the double's turns rows. */
  readonly calls: TurnRowCalls;
  /** K-04 turns, by turn id: the one row each turn id was written as. */
  readonly turns: Map<string, TurnsRow>;
  /** Every commitTurn request, in order. */
  readonly commits: CommitTurnRequest[];
  /** Every parkTurn request, in order. */
  readonly parks: K05ParkTurnRequest[];
  /** When set, every commitTurn answers it and writes nothing, as K-05 answering transient (the same request may come again). */
  failCommitsWith: { readonly error: "transient" } | null;
}

const COMMIT_FIRST_TURN = commitFirstJson.request.turn.id;
const PARK_TURN_ID = parkTurnJson.request.turn.id;

const commitAnswer = (value: unknown): Promise<CommitTurnOutcome> =>
  Promise.resolve(structuredClone(value) as CommitTurnOutcome);
const parkAnswer = (value: unknown): Promise<ParkTurnOutcome> =>
  Promise.resolve(structuredClone(value) as ParkTurnOutcome);

/** The turns row K-05 writes for a commit's or a park's turn (both name it as K-05 v1 `turn`). */
function turnsRowOf(turn: CommitTurnRequest["turn"], state: TurnsRow["state"], at: string): TurnsRow {
  return {
    id: turn.id,
    handleId: turn.handleId,
    eventIds: [...turn.eventIds],
    state,
    bundleId: { hash: turn.bundleId.hash, build: turn.bundleId.build },
    traceId: turn.traceId,
    joinedTraceIds: [...turn.joinedTraceIds],
    tries: turn.tries,
    at,
  };
}

/**
 * K-05 commitTurn and parkTurn as a double answering as commit-first.json, commit-repeat-same-turn.json and park-turn.json
 * do, for whichever turn asks (K-05 README items 1 and 12): the first call for a turn id writes that id's one turns row,
 * committed or parked, and answers its fixture's outcome under that turn id; a later commit of a committed id answers the
 * repeat's (nothing written, repeated); a later park of a parked id its first park again, repeated; a commit of a parked id
 * turnParked; a park of a committed id alreadyCommitted. A parked row's time is the request's parkedAt.
 */
export function fakeTurnRows(): FakeTurnRows {
  const turns = new Map<string, TurnsRow>();
  const commits: CommitTurnRequest[] = [];
  const parks: K05ParkTurnRequest[] = [];
  const firstParks = new Map<string, Record<string, unknown>>();
  const double: FakeTurnRows = {
    turns,
    commits,
    parks,
    failCommitsWith: null,
    calls: {
      commitTurn(request) {
        commits.push(structuredClone(request));
        if (double.failCommitsWith !== null) return commitAnswer({ ...double.failCommitsWith });
        const turnId = request.turn.id;
        const known = turns.get(turnId);
        if (known?.state === "parked")
          return commitAnswer({ error: "turnParked", turnId, parkedAt: known.at });
        if (known !== undefined) {
          return commitAnswer(swap(commitRepeatJson.outcome, [[COMMIT_FIRST_TURN, turnId]]));
        }
        turns.set(turnId, turnsRowOf(request.turn, "committed", commitFirstJson.outcome.committedAt));
        return commitAnswer(swap(commitFirstJson.outcome, [[COMMIT_FIRST_TURN, turnId]]));
      },
      parkTurn(request) {
        parks.push(structuredClone(request));
        const turnId = request.turn.id;
        const known = turns.get(turnId);
        if (known?.state === "committed") {
          return parkAnswer({ error: "alreadyCommitted", turnId, committedAt: known.at });
        }
        const first = firstParks.get(turnId);
        if (first !== undefined) return parkAnswer({ ...first, repeated: true });
        const parked: Record<string, unknown> = {
          ...swap(parkTurnJson.outcome, [[PARK_TURN_ID, turnId]]),
          parkedAt: request.parkedAt,
          outboxRows: request.outboxRows.map((row, index) => ({ id: row.id, commitSeq: index + 1 })),
          repeated: false,
        };
        turns.set(turnId, turnsRowOf(request.turn, "parked", request.parkedAt));
        firstParks.set(turnId, parked);
        return parkAnswer(parked);
      },
    },
  };
  return double;
}

/**
 * K-05 v1.1 commitTurn's request for the running turn: commit-first.json's body (its versions read and its writes) under
 * the turn the K-09 gate was handed, as K-05 names it (K-05 v1 turn: the lease's turn id, its batch's event ids, the pinned
 * bundle, the trace ids and the try).
 */
export function commitFirstFor(turn: CommitTurnRef): CommitTurnRequest {
  const body = structuredClone(commitFirstJson.request) as unknown as CommitTurnRequest;
  const k05Turn = {
    id: turn.id,
    handleId: turn.handleId,
    eventIds: [...turn.eventIds],
    bundleId: { hash: turn.bundleId.hash, build: turn.bundleId.build },
    traceId: turn.traceId,
    joinedTraceIds: [...turn.joinedTraceIds],
    tries: turn.tries,
  };
  return { ...body, turn: k05Turn as unknown as CommitTurnRequest["turn"] };
}

/**
 * The Tool API's gate and commit as a hop's test stands it in until T-559 joins @rosie/actions' (a FakeTurnFace `gate`): no
 * limit is read, and the turn's one commit is K-05 commitTurn through `commit` (in a hop's test, the root's turn-row port),
 * with commit-first.json's body under the running turn (`commitFirstFor`). K-05's committed answer, first or repeated, comes
 * back as K-09's: commit-s1-02.json's outcome under the running turn's id, with K-05's turn id, commit time and repeat flag,
 * so the turn goes on to its reply as the skeleton's does; K-05's refusal (transient, turnParked) comes back as K-09's error,
 * with nothing written.
 */
export function gateThroughCommit(
  commit: CommitTurnCall,
): (request: GateAndCommitRequest) => Promise<GateAndCommitAnswer> {
  return async (request) => {
    const answer = await commit(commitFirstFor(request.turn));
    if (!("result" in answer)) return answer as unknown as GateAndCommitAnswer;
    const committed = swap(commitS102.outcome, [[S1_02_TURN, request.turn.id]]) as unknown as GateCommitted;
    return {
      ...committed,
      turnId: answer.turnId,
      committedAt: answer.committedAt,
      repeated: answer.repeated,
    };
  };
}

// ---- K-05 v1 item 7's bundle reads, as a double: bundle v0 as bundles/v0 publishes it (T-556) ----------------------

/**
 * Bundle v0's parts by K-01 key, each its text byte for byte: bundles/v0/bundle.kv.json, the bulk file T-163's publish
 * writes beside PostgreSQL's copy, from the same files (T-569 publishes them on staging).
 */
const BUNDLE_V0_PARTS: ReadonlyMap<string, string> = new Map(
  bundleV0Kv.map((part) => [part.key, part.value] as const),
);

/** The id bundle v0's published manifest names, under its own manifest key (its content hash, build 1). */
function bundleIdOfParts(parts: ReadonlyMap<string, string>): BundleId {
  for (const [key, text] of parts) {
    if (!key.endsWith("/manifest")) continue;
    const named = (JSON.parse(text) as { bundleId?: { hash?: unknown; build?: unknown } }).bundleId;
    const hash = named?.hash;
    const build = named?.build;
    if (
      typeof hash === "string" &&
      typeof build === "number" &&
      key === bundleKeyOf({ hash, build }, "manifest")
    ) {
      return { hash, build };
    }
  }
  throw new Error("bundles/v0 holds no manifest under its own bundle id");
}

/** A K-01 v1 key, spelled out here for the double: bundle/<hash>/<build>/<part>. */
function bundleKeyOf(bundleId: BundleId, part: string): string {
  return `bundle/${bundleId.hash}/${String(bundleId.build)}/${part}`;
}

/** Bundle v0's id, as bundles/v0 publishes it: the bundle the test environment's bundle port holds active. */
export const BUNDLE_V0: BundleId = bundleIdOfParts(BUNDLE_V0_PARTS);

/** A K-01 value's kind, from its key's part: the manifest, a flow graph or a trade overlay. */
function kindOfKey(key: string): StoredText["kind"] {
  const part = key.split("/").slice(3).join("/");
  if (part === "manifest") return "manifest";
  return part.startsWith("trade/") ? "trade" : "flow";
}

/** One value as PostgreSQL's copy stores it (K-05 v1 storedText): its size in UTF-8 bytes and its sha256, by WebCrypto. */
async function storedTextOf(key: string, text: string): Promise<StoredText> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { key, kind: kindOfKey(key), bytes: data.byteLength, sha256, text };
}

export interface FakeBundleReads {
  /** What the root's real bundle port is fed (RootOptions.bundleReads): K-05's two reads over bundle v0's copy. */
  readonly calls: BundleReadCalls;
  /** Every call, in order, with the key it asked for (null for readActiveBundle). */
  readonly reads: { readonly call: "readActiveBundle" | "readBundleValue"; readonly key: string | null }[];
}

/**
 * K-05 v1 item 7's readActiveBundle and readBundleValue as a double over PostgreSQL's copy of bundle v0, as bundles/v0
 * publishes it, with bundle v0 active: readActiveBundle answers in active-bundle.json's form with bundle v0's id and
 * manifest key (its activatedAt the fixture's); readBundleValue answers in bundle-value-on-miss.json's form, each value's
 * text byte for byte with its size and sha256 as the publish stores them, and notFound for a key the copy does not hold.
 */
export function fakeBundleReads(): FakeBundleReads {
  const reads: { call: "readActiveBundle" | "readBundleValue"; key: string | null }[] = [];
  return {
    reads,
    calls: {
      readActiveBundle() {
        reads.push({ call: "readActiveBundle", key: null });
        const answer: ReadActiveBundleResult = {
          result: "active",
          bundleId: { ...BUNDLE_V0 },
          manifestKey: bundleKeyOf(BUNDLE_V0, "manifest"),
          activatedAt: activeBundleJson.outcome.activatedAt,
        };
        return Promise.resolve(answer);
      },
      async readBundleValue(request): Promise<ReadBundleValueResult> {
        reads.push({ call: "readBundleValue", key: request.key });
        const text = BUNDLE_V0_PARTS.get(request.key);
        if (text === undefined) return { error: "notFound", table: "bundle_values", rowId: request.key };
        return { result: "value", value: await storedTextOf(request.key, text) };
      },
    },
  };
}

// ---- K-05 v1.2 handleTargets, as a double: test owner 1's seeded rows (T-556) ------------------------------------

/** A handle and its one linked person as a seed writes them (K-04 handles, persons, person_handles). */
export interface SeededHandle {
  readonly handle: { readonly kind: string; readonly address: string };
  readonly handleId: string;
  readonly personId: string;
}

/**
 * Test owner 1 as T-1148's seed writes K-04 for D-017 (db/seeds/skeleton.ts TEST_OWNER_1 and SKELETON_ROWS; K-21
 * test-roster.json's tp-01): handle-sam at the fictional 555-0100, linked to person-sam, under Lee's Barbershop's business
 * head, with no role, no open question, no booking, no phone row and no sealing key, so his JOIN is a first text.
 */
export const TEST_OWNER_1 = {
  handle: { kind: SAM.handle.kind, address: SAM.handle.address },
  handleId: SAM.party.handleId,
  personId: SAM.party.personId,
  businessId: SAM.party.businessId,
} as const;

/** targets-first-text.json's own handle and person, which the double answers under the seeded handle's ids. */
const FIRST_TEXT_HANDLE = targetsFirstTextJson.request.handleId;
const FIRST_TEXT_PERSON = firstTextPerson();

function firstTextPerson(): string {
  const personId = targetsFirstTextJson.outcome.persons[0]?.personId;
  if (personId === undefined) throw new Error("targets-first-text.json names no person");
  return personId;
}

export interface FakeHandleTargets {
  /** What the root's real targets port is fed (RootOptions.handleTargets): K-05 v1.2 handleTargets over the seeded rows. */
  readonly call: HandleTargetsCall;
  /** Every request, in order. */
  readonly requests: K05HandleTargetsRequest[];
}

/**
 * K-05 v1.2 handleTargets as a double over a seed's rows, by default test owner 1's (T-1148): for a seeded handle, whose one
 * person has no role, no open question, no booking and no phone row, it answers as targets-first-text.json does, under
 * that handle's and person's ids (T-1148's integration test shows that the seeded rows give exactly that answer from the
 * real handleTargets on local PostgreSQL); for any other handle, K-05's notFound.
 */
export function fakeHandleTargets(seeded: readonly SeededHandle[] = [TEST_OWNER_1]): FakeHandleTargets {
  const byHandle = new Map(seeded.map((entry) => [entry.handleId, entry] as const));
  const requests: K05HandleTargetsRequest[] = [];
  return {
    requests,
    call(request) {
      requests.push(structuredClone(request));
      const found = byHandle.get(request.handleId);
      if (found === undefined) {
        return Promise.resolve({ error: "notFound", table: "handles", rowId: request.handleId });
      }
      const answer = swap(targetsFirstTextJson.outcome, [
        [FIRST_TEXT_HANDLE, found.handleId],
        [FIRST_TEXT_PERSON, found.personId],
      ]);
      return Promise.resolve(answer as unknown as HandleTargetsOutcome);
    },
  };
}

// ---- K-05 v1.2 readTurnState under the frontier's scope, as a double: test owner 1's seeded rows (T-557) -----------

type SeededValue = string | number | null;

/** One seeded row as T-1148's seed writes it (db/seeds/skeleton.ts SKELETON_ROWS): its columns and its version. */
interface SeededRow {
  readonly values: Readonly<Record<string, SeededValue>>;
  readonly version: number;
}

/** The one row of a K-04 seed fixture with this table and id. */
function seedRowOf(
  fixture: { readonly rows: readonly { readonly table: string; readonly values: Record<string, unknown> }[] },
  table: string,
  id: string,
): Record<string, unknown> {
  const row = fixture.rows.find((each) => each.table === table && each.values.id === id);
  if (row === undefined) throw new Error(`the seed fixture holds no ${table} row ${id}`);
  return row.values;
}

/**
 * The rows T-1148's seed writes for test owner 1 (db/seeds/skeleton.ts SKELETON_ROWS), by table and id: Lee's
 * Barbershop's business head as K-04 seed-business-head.json gives it, value for value, version included; and Sam as K-04
 * seed-person-roles.json names him, with no language stored yet (K-02 v1.1 default 11), written once (version 1).
 */
const SEEDED: Readonly<Record<"businesses" | "persons", ReadonlyMap<string, SeededRow>>> = {
  businesses: new Map([
    [
      TEST_OWNER_1.businessId,
      (() => {
        const { version, ...values } = seedRowOf(seedBusinessHead, "businesses", TEST_OWNER_1.businessId);
        return { values: values as Record<string, SeededValue>, version: Number(version) };
      })(),
    ],
  ]),
  persons: new Map([
    [
      TEST_OWNER_1.personId,
      {
        values: {
          id: TEST_OWNER_1.personId,
          name: String(seedRowOf(seedPersonRoles, "persons", TEST_OWNER_1.personId).name),
          language: null,
        },
        version: 1,
      },
    ],
  ]),
};

/** One read the frontier made through the scope: the business the call's transaction was scoped to, and the read. */
export interface FrontierScopeRead {
  readonly scope: string;
  readonly call: "readTurnState" | "readVisitTimes";
  readonly request: unknown;
}

export interface FakeFrontierScope {
  /** What the root's real frontier port is fed (RootOptions.frontierScope): the scope over the K-05 double. */
  readonly scope: FrontierScope;
  /** Every read, in order, under the scope each call ran in. */
  readonly reads: FrontierScopeRead[];
}

/**
 * K-05 v1.2 readTurnState for test owner 1 (T-1148's rows), read under `businessId`: his handle and its one person, no
 * role, open question, booking, pause or consent and no phone row, and each fact from its home row with that row's
 * version (T-315's integration test shows the real readTurnState gives exactly this on the seeded rows); notFound for
 * another handle, a booking or a row the seed does not hold, unknownFact for a column it does not hold.
 */
function seededTurnState(request: ReadTurnStateRequest, readAt: string): ReadTurnStateAnswer {
  if (request.handleId !== TEST_OWNER_1.handleId) {
    return { error: "notFound", table: "handles", rowId: request.handleId };
  }
  const [booking] = request.bookingIds;
  if (booking !== undefined) return { error: "notFound", table: "bookings", rowId: booking };
  const facts: {
    key: string;
    table: string;
    rowId: string;
    column: string;
    value: SeededValue;
    version: number;
  }[] = [];
  for (const fact of request.facts) {
    const table = fact.table as string;
    const rows = table === "businesses" || table === "persons" ? SEEDED[table] : undefined;
    const row = rows?.get(fact.rowId);
    if (row === undefined) return { error: "notFound", table, rowId: fact.rowId };
    const value = row.values[fact.column];
    if (value === undefined) return { error: "unknownFact", key: fact.key, table, column: fact.column };
    facts.push({ key: fact.key, table, rowId: fact.rowId, column: fact.column, value, version: row.version });
  }
  const answer = {
    result: "turnState",
    handleId: TEST_OWNER_1.handleId,
    handle: { kind: TEST_OWNER_1.handle.kind, address: TEST_OWNER_1.handle.address },
    businessId: request.businessId,
    readAt,
    persons: [{ personId: TEST_OWNER_1.personId, language: null, version: 1 }],
    roles: [],
    phone: null,
    openQuestions: [],
    bookings: [],
    pauses: [],
    consents: [],
    facts,
  };
  return answer as unknown as ReadTurnStateAnswer;
}

/**
 * The frontier's business scope (./real.ts FrontierScope) over a K-05 v1.2 readTurnState double holding test owner 1's
 * seeded rows (T-1148), as pgFrontierScope runs the real one: each call's reads happen inside `withBusiness` for the
 * call's business, and a read that names another business than the scope is refused before anything is read
 * (BusinessScopeError, as T-219's readTurnStateIn refuses it). A booking's visit time is never read (K-05 v1.2 open gap
 * 25: pgFrontierRepo answers none). `readAt` is the test clock's now.
 */
export function fakeFrontierScope(now: () => string = () => new Date().toISOString()): FakeFrontierScope {
  const reads: FrontierScopeRead[] = [];
  return {
    reads,
    scope: {
      withBusiness: (businessId, work) =>
        work({
          readTurnState(request) {
            reads.push({ scope: businessId, call: "readTurnState", request: structuredClone(request) });
            if (request.businessId !== businessId) {
              return Promise.reject(
                new BusinessScopeError("a read names another business than the call's scope"),
              );
            }
            return Promise.resolve(seededTurnState(request, now()));
          },
          readVisitTimes(request) {
            reads.push({ scope: businessId, call: "readVisitTimes", request: structuredClone(request) });
            return Promise.resolve({
              result: "visits",
              visits: request.bookingIds.map((bookingId) => ({ bookingId, visitAt: null })),
            });
          },
        }),
    },
  };
}

// ---- @rosie/ai's decide over the recorded-model double (T-558) -----------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Which read of a turn a recorded decide read is (K-02 v1 `read.role`). */
export type DecideRole = "first" | "check" | "reread";

/** One decide read the double holds: its recording's id, the request it is keyed on (context and role), its answer. */
export interface DecideRecording {
  readonly id: string;
  readonly context: unknown;
  readonly role: DecideRole;
  /** K-02 v1 `decideRead`: the text's language and one verb per part. */
  readonly output: unknown;
}

/** A recording as ai/recordings writes it (T-004's file form): its request, and a seed fixture or the answer itself. */
interface RecordingSpec {
  readonly id: string;
  readonly kind: string;
  readonly request: { readonly context?: unknown; readonly role?: unknown };
  readonly seed?: { readonly fixture: string };
  readonly output?: unknown;
}

/** The K-02 fixtures a recording here may name, by file (the double's own loader reads them from disk; workerd cannot). */
const MODEL_FIXTURES: Readonly<Record<string, unknown>> = {
  "context-s1-01.json": contextS101,
  "decide-s1-01-enter.json": decideS101Enter,
  "decide-reads-disagree.json": decideReadsDisagree,
};

/** ai/recordings' own files a recording's context may name, by path (recording 2's: the JOIN run's context). */
const RECORDING_FILES: Readonly<Record<string, unknown>> = {
  "contexts/join-s1-01.json": joinRunContextJson,
};

function namedIn(files: Readonly<Record<string, unknown>>, file: string): unknown {
  const value = files[file];
  if (value === undefined) throw new Error(`the decide double is given no ${file}`);
  return structuredClone(value);
}

/** A request's context as T-004's loader resolves it: a K-02 fixture, a file of ai/recordings, or written inline. */
function resolvedContext(context: unknown): unknown {
  if (isRecord(context) && Object.keys(context).length === 1) {
    if (typeof context.fixture === "string") return namedIn(MODEL_FIXTURES, context.fixture);
    if (typeof context.file === "string") return namedIn(RECORDING_FILES, context.file);
  }
  return structuredClone(context);
}

function roleOf(value: unknown): DecideRole {
  if (value === "first" || value === "check" || value === "reread") return value;
  throw new Error(`a decide recording's role is first, check or reread, not ${JSON.stringify(value)}`);
}

/**
 * A K-02 decide fixture's read in one role, as T-004's loader seeds a decide recording: only when the fixture is the
 * context's own turn and bundle.
 */
function seededRead(fixture: string, context: unknown, role: DecideRole): unknown {
  const result = namedIn(MODEL_FIXTURES, fixture) as {
    readonly turnId?: unknown;
    readonly bundleId?: unknown;
    readonly reads?: readonly { readonly role: string; readonly output: unknown }[];
  };
  const turn = isRecord(context) ? context : {};
  if (result.turnId !== turn.turnId || canonicalJson(result.bundleId) !== canonicalJson(turn.bundleId)) {
    throw new Error(`${fixture} is another turn's or bundle's than its recording's context`);
  }
  const read = result.reads?.find((each) => each.role === role);
  if (read === undefined) throw new Error(`${fixture} holds no ${role} read`);
  return read.output;
}

/**
 * The double's decide recordings on K-02 v1.1 (ai/recordings/recordings.v1.1.json; T-1145, DL-347), keyed as its loader
 * keys them, never copied: recording 1, both Haiku reads on context-s1-01.json (seeded from decide-s1-01-enter.json), and
 * recording 2, both reads on the JOIN run's own context (contexts/join-s1-01.json: its turn id T-248's hash of
 * evt-sam-0000, bundle v0 as bundles/v0 publishes it, the text JOIN at 14:01:49Z), each entering c-01 with the quote JOIN.
 */
function shippedDecideRecordings(): DecideRecording[] {
  const file = recordingsV11 as unknown as { readonly recordings: readonly RecordingSpec[] };
  return file.recordings
    .filter((spec) => spec.kind === "decideRead")
    .map((spec) => {
      const role = roleOf(spec.request.role);
      const context = resolvedContext(spec.request.context);
      const output =
        spec.seed === undefined ? structuredClone(spec.output) : seededRead(spec.seed.fixture, context, role);
      return { id: spec.id, context, role, output };
    });
}

/**
 * The context decide-reads-disagree.json's reads were made from, as the turn's own tests write it (../turn/test-support
 * a7_17Context): A7-17 ("Alex replies?") on K-01's bundle-mini-a, its options word for word, the fixture's turn id.
 */
export function disagreeContext(): Record<string, unknown> {
  const flows = (bundleMiniA as unknown as CacheBundle).flows;
  const flow = flows.A;
  if (flow === undefined) throw new Error("bundle-mini-a holds flow A");
  return a7_17Context(BUNDLE_B, flow.routing.alwaysOn.prefixSha256);
}

/**
 * decide-reads-disagree.json's three reads on its context (`disagreeContext`), seeded from the fixture by role: Sonnet's
 * first read and Haiku's check read, which differ on the high-stakes part, and the one Sonnet re-read, which asks.
 */
function disagreeRecordings(): DecideRecording[] {
  const context = disagreeContext();
  return (["first", "check", "reread"] as const).map((role) => ({
    id: `decide-reads-disagree-${role}`,
    context,
    role,
    output: seededRead("decide-reads-disagree.json", context, role),
  }));
}

/**
 * decide-s1-01-enter.json's read in one role (both Haiku reads enter c-01, the sign-up door, with no field) with `quote`
 * as each part's quote: recording 2's answer for another turn of test owner 1's on bundle v0.
 */
function enterRead(role: "first" | "check", quote: string): unknown {
  const read = seededRead("decide-s1-01-enter.json", contextS101, role) as {
    readonly language: string;
    readonly parts: readonly Record<string, unknown>[];
  };
  return { ...read, parts: read.parts.map((part) => ({ ...part, quote })) };
}

/** A decide bundle: the routing a decider is built on (K-01 v1 manifest) and the parts its prompt layout reads. */
interface DecideBundle {
  readonly routing: RoutingBundle;
  readonly cache: CacheBundle;
}

function decideBundleOf(manifest: unknown, flows: CacheBundle["flows"]): DecideBundle {
  const read = manifest as CacheBundle["manifest"] & Pick<RoutingBundle, "models" | "policy">;
  return {
    routing: { bundleId: read.bundleId, models: read.models, policy: read.policy },
    cache: { manifest: read, flows },
  };
}

/**
 * The bundles the double builds a decider for: bundle v0 as bundles/v0 publishes it (its manifest, with its models,
 * routing policy and decide prompt, and its flow A graph: the bundle every skeleton turn pins), and K-01's bundle-mini-a
 * (decide-reads-disagree.json's).
 */
function decideBundles(): ReadonlyMap<string, DecideBundle> {
  const manifest = BUNDLE_V0_PARTS.get(bundleKeyOf(BUNDLE_V0, "manifest"));
  const flowA = BUNDLE_V0_PARTS.get(bundleKeyOf(BUNDLE_V0, "flow/A"));
  if (manifest === undefined || flowA === undefined)
    throw new Error("bundles/v0 holds its manifest and flow A");
  const miniA = bundleMiniA as unknown as CacheBundle;
  return new Map([
    [bundleTextOf(BUNDLE_V0), decideBundleOf(JSON.parse(manifest), { A: JSON.parse(flowA) as CacheFlow })],
    [bundleTextOf(BUNDLE_B), decideBundleOf(miniA.manifest, miniA.flows)],
  ]);
}

/** A bundle id as the double names it: `<hash>/<build>`. */
const bundleTextOf = (bundleId: BundleId): string => `${bundleId.hash}/${String(bundleId.build)}`;

/** The step a decide request asks for, from its user message's last tag (T-368's two-step wire form, CQ-25). */
const STEP_TAG = /<step n="([12])"(?: part="([0-9]+)")?><\/step>$/u;

type DecideStep = { readonly n: 1 } | { readonly n: 2; readonly part: number };

function stepOf(body: Record<string, unknown>): DecideStep | null {
  const messages = body.messages;
  const first: unknown = Array.isArray(messages) ? (messages as unknown[])[0] : undefined;
  const content = isRecord(first) ? first.content : undefined;
  const match = typeof content === "string" ? STEP_TAG.exec(content) : null;
  if (match === null) return null;
  return match[1] === "1" ? { n: 1 } : { n: 2, part: Number(match[2]) };
}

/**
 * One step's answer from a K-02 read, as the model splits it (two-step wire form): step 1 the language and each part's
 * quote and verb; step 2 of part k (from 1) that part's fields, its verb and quote left out; none for a no_op part.
 */
function stepAnswer(read: unknown, step: DecideStep): unknown {
  const parts: unknown[] = isRecord(read) && Array.isArray(read.parts) ? (read.parts as unknown[]) : [];
  if (step.n === 1) {
    return {
      language: isRecord(read) ? read.language : null,
      parts: parts.map((part) => (isRecord(part) ? { quote: part.quote, verb: part.verb } : part)),
    };
  }
  const part = parts[step.part - 1];
  if (!isRecord(part) || part.verb === "no_op") return undefined;
  return Object.fromEntries(Object.entries(part).filter(([key]) => key !== "verb" && key !== "quote"));
}

/** The paths at which two JSON values differ (at most 8), for a miss's message: field names and places, never values. */
function differingPaths(a: unknown, b: unknown, path = "", into: string[] = []): string[] {
  if (into.length >= 8) return into;
  const here = path === "" ? "(the whole request)" : path;
  if (isRecord(a) && isRecord(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
      differingPaths(a[key], b[key], path === "" ? key : `${path}.${key}`, into);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) into.push(`${here} (length)`);
    else
      (a as unknown[]).forEach((item, k) =>
        differingPaths(item, (b as unknown[])[k], `${path}[${String(k)}]`, into),
      );
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    into.push(here);
  }
  return into;
}

/** One Messages API call the double answered for a decide read: the model asked, the read and step it was, by whom. */
export interface DecideModelCall {
  readonly model: string;
  /** The reads it was answered from: one role, or both reads of a low-stakes turn, which ask alike on one model. */
  readonly roles: readonly DecideRole[];
  readonly step: 1 | 2;
  /** The recordings that answered it, by id. */
  readonly recordings: readonly string[];
}

export interface FakeDecideModels {
  /**
   * What the root's real decide port is fed (RootOptions.deciders): @rosie/ai's decider (T-369 createDecider, with T-370's
   * re-read) for each bundle the double holds, calling a fake Messages API answered by the recorded-model double.
   */
  readonly deciders: Deciders;
  /** Each context decide was given (the frontier's answer), in order. */
  readonly decideCalls: DecideContext[];
  /** Each re-read the decider was asked, in order (the turn's, and the AI layer's own for an unmapped turn). */
  readonly rereadCalls: unknown[];
  /** Every Messages API call the double answered, in order. */
  readonly calls: DecideModelCall[];
  /** Every request the double holds no recording for, with what differs from the nearest recording's request. */
  readonly misses: string[];
  /** Every bundle a decider was asked for (`<hash>/<build>`), in order: the port's one decider per bundle. */
  readonly asked: string[];
  /** While true, every call answers 529 (overloaded) before any recording is read: the models are down. */
  down: boolean;
  /** Keeps a text the Linq double signed this run: its words and send time, for `recordTurn`. */
  saw(event: LinqInboundEvent): void;
  /**
   * Records the two reads of a turn over these texts (in arrival order), as recording 2 holds the JOIN run's: its context
   * is the JOIN run's (test owner 1's stored state on bundle v0) with the turn's own id (T-248's hash of the event ids)
   * and texts (as the Linq double signed them: their words and send times), and both Haiku reads enter c-01 with the
   * first text's words as the quote (decide-s1-01-enter.json's). It may be called before the texts are sent: the
   * recording is made at the first decide request after they are all signed.
   */
  recordTurn(eventIds: readonly string[]): void;
  /** Holds one more recording: a test's own read of a context (a refused one included, which the loader would refuse). */
  hold(recording: DecideRecording): void;
}

/**
 * @rosie/ai's decide for each bundle (T-369's two reads and T-370's one Sonnet re-read: the real router, decide's one
 * read, the context bundle and the AI gateway), over K-01's manifests and flows (bundle v0 as bundles/v0 publishes it;
 * bundle-mini-a), calling a fake Messages API whose every answer comes from the recorded-model double (T-004's
 * createRecordedModel), keyed as its loader keys a decide recording: the run's own context and the read's role. It holds
 * ai/recordings' turn 1 recordings as they are (recording 2 is the JOIN run's, keyed on the ids the runtime produces;
 * DL-347), decide-reads-disagree.json's three reads on its context, and what a test records. Each decide read is told
 * apart by its role: on the re-read, the re-read's; else by the model the route asks for it (the bundle's policy for the
 * turn's stakes), and a request both reads ask alike (Haiku twice, one choice) is answered only when both reads' answers
 * are the same. A request with no recording is a miss: kept, with what differs, and answered 404, so the read fails
 * loudly, never with a made-up answer. The decider is watched only to know which context and read each request is for
 * (the double answers one decide or re-read at a time). The key is made up for each run, never Anthropic's.
 */
export function fakeDecideModels(log: string[] = []): FakeDecideModels {
  const held = new Map<string, { output: unknown }>();
  const ids = new Map<string, string>();
  const recordings: DecideRecording[] = [];
  const recorded = createRecordedModel(held);
  const env = { [KEY_VARIABLE]: `made-up-${crypto.randomUUID()}` };
  const signed = new Map<string, { words: string; sentAt: string }>();
  // The turns a test recorded whose reads are not held yet (`recordTurn`): each one's event ids, in arrival order.
  const turns: string[][] = [];
  let reading: { readonly phase: "decide" | "reread"; readonly context: unknown } | null = null;
  let bundles: ReadonlyMap<string, DecideBundle> | null = null;

  const hold = (recording: DecideRecording): void => {
    const key = requestKey("decideRead", { context: recording.context, role: recording.role });
    const known = ids.get(key);
    if (known !== undefined) {
      if (canonicalJson(held.get(key)?.output) !== canonicalJson(recording.output))
        throw new Error(`${recording.id} is keyed on ${known}'s request with another answer`);
      return;
    }
    held.set(key, { output: structuredClone(recording.output) });
    ids.set(key, recording.id);
    recordings.push(recording);
  };
  for (const recording of [...shippedDecideRecordings(), ...disagreeRecordings()]) hold(recording);

  const answered = (output: unknown): Response =>
    new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(output) }],
        usage: USAGE,
      }),
      { status: 200 },
    );
  const failed = (status: number, type: string): Response =>
    new Response(JSON.stringify({ type: "error", error: { type } }), { status });
  const miss = (why: string): Response => {
    models.misses.push(why);
    return failed(404, "not_found_error");
  };

  /** What differs between a request and the nearest recording of the same role, for a miss's message. */
  const nearest = (context: unknown, role: DecideRole): string => {
    let best: { id: string; paths: string[] } | null = null;
    for (const recording of recordings.filter((each) => each.role === role)) {
      const paths = differingPaths(context, recording.context);
      if (best === null || paths.length < best.paths.length) best = { id: recording.id, paths };
    }
    return best === null ? "no recording of that role" : `${best.id} differs at ${best.paths.join(", ")}`;
  };

  /** The reads of a decide a request on `model` may be: the route's (the bundle's policy for the turn's stakes). */
  const readsOn = (routing: RoutingBundle, context: unknown, model: string): DecideRole[] => {
    const { stakes } = turnStakes(context as RoutingContext);
    const pair = routing.policy[stakes];
    const id = (role: "haiku" | "sonnet"): string =>
      role === "haiku" ? routing.models.haiku : routing.models.sonnet;
    return [
      ...(id(pair.first) === model ? ["first" as const] : []),
      ...(id(pair.second) === model ? ["check" as const] : []),
    ];
  };

  const fetchFor =
    (routing: RoutingBundle): FetchLike =>
    async (_url, init) => {
      const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as Record<string, unknown>;
      const model = typeof body.model === "string" ? body.model : "";
      if (models.down) return failed(529, "overloaded_error");
      const now = reading;
      if (now === null) return miss("a decide request outside a decide or a re-read");
      const step = stepOf(body);
      if (step === null) return miss("a decide request with no step tag");
      const roles: DecideRole[] = now.phase === "reread" ? ["reread"] : readsOn(routing, now.context, model);
      if (roles.length === 0)
        return miss(`a decide request on ${model}, which the turn's route asks for no read`);
      await recordTurns();
      const answers: { id: string; output: unknown }[] = [];
      for (const role of roles) {
        const request = { context: now.context, role };
        let read: unknown;
        try {
          read = await recorded.decide(request as Parameters<RecordedModel["decide"]>[0]);
        } catch (error) {
          if (error instanceof NoRecordingError)
            return miss(`no ${role} read is recorded for the request: ${nearest(now.context, role)}`);
          throw error;
        }
        answers.push({
          id: ids.get(requestKey("decideRead", request)) ?? "",
          output: stepAnswer(read, step),
        });
      }
      const [first] = answers;
      if (first?.output === undefined) return miss(`step ${String(step.n)} of a part its read does not have`);
      if (new Set(answers.map((answer) => canonicalJson(answer.output ?? null))).size !== 1)
        return miss("both reads ask alike, but their recordings answer otherwise");
      models.calls.push({
        model,
        roles,
        step: step.n,
        recordings: answers.map((answer) => answer.id),
      });
      return answered(first.output);
    };

  /** Runs one decide or re-read of the decider, the double told which context and read its requests are for. */
  const during = async <T>(
    phase: "decide" | "reread",
    context: unknown,
    run: () => Promise<T>,
  ): Promise<T> => {
    if (reading !== null) throw new Error("the decide double answers one decide or re-read at a time");
    // The context as JSON carries it: what the double keys a request on.
    reading = { phase, context: JSON.parse(JSON.stringify(context)) as unknown };
    try {
      return await run();
    } finally {
      reading = null;
    }
  };

  const watched = (decider: Decider): Decider =>
    Object.freeze({
      bundleId: decider.bundleId,
      decide(context, options) {
        models.decideCalls.push(structuredClone(context) as unknown as DecideContext);
        log.push("decide");
        return during("decide", context, () => decider.decide(context, options));
      },
      reread(request, options) {
        models.rereadCalls.push(structuredClone(request));
        log.push("reread");
        return during("reread", request.context, () => decider.reread(request, options));
      },
    } satisfies Decider);

  const models: FakeDecideModels = {
    decideCalls: [],
    rereadCalls: [],
    calls: [],
    misses: [],
    asked: [],
    down: false,
    deciders(bundleId) {
      const key = bundleTextOf(bundleId);
      models.asked.push(key);
      bundles ??= decideBundles();
      const bundle = bundles.get(key);
      if (bundle === undefined) throw new Error(`the decide double holds no bundle ${key}`);
      const decider = createDecider({
        bundle: bundle.routing,
        prompts: createPromptCache(bundle.cache),
        env,
        fetch: fetchFor(bundle.routing),
      });
      return watched(decider);
    },
    saw(event) {
      if (event.kind === "text" && typeof event.body === "string" && typeof event.sentAt === "string") {
        signed.set(event.eventId, { words: event.body, sentAt: event.sentAt });
      }
    },
    recordTurn(eventIds) {
      if (eventIds.length === 0) throw new Error("a turn has at least one text");
      turns.push([...eventIds]);
    },
    hold,
  };

  /**
   * Each turn a test recorded, its texts all signed by now, held as its two reads (`recordTurn`): one at a time, so a
   * request sent beside another (the two reads go side by side) waits for the recording the other one is making.
   */
  let recording: Promise<void> = Promise.resolve();
  const recordTurns = (): Promise<void> => {
    recording = recording.catch(() => undefined).then(holdRecordedTurns);
    return recording;
  };
  const holdRecordedTurns = async (): Promise<void> => {
    const base = structuredClone(joinRunContextJson);
    const zone = base.texts[0]?.sentAt.zone;
    if (zone === undefined) throw new Error("the JOIN run's context holds its text");
    for (const eventIds of turns.splice(0)) {
      const texts = eventIds.flatMap((eventId) => {
        const text = signed.get(eventId);
        if (text === undefined) return [];
        const sentAt = { utc: text.sentAt, zone };
        return [
          { eventId, kind: "text", words: text.words, sentAt, attachments: [], poll: null, tapback: null },
        ];
      });
      const [first] = texts;
      if (first === undefined || texts.length < eventIds.length) {
        turns.push(eventIds);
        continue;
      }
      const context = { ...base, turnId: await turnIdOf(eventIds), texts };
      for (const role of ["first", "check"] as const) {
        hold({ id: `turn-${context.turnId}-${role}`, context, role, output: enterRead(role, first.words) });
      }
    }
  };
  return models;
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

/** The ports joined so far (./picks.ts): the root builds them itself (./real.ts), fed by the doubles here. */
type JoinedPort =
  "linqVerify" | "sealing" | "safetyRead" | "turnRow" | "bundles" | "targets" | "frontier" | "decide";

export interface SkeletonFakes {
  /**
   * The fake set the test environment binds: every port but the joined ones, the Linq verify, the sealing, the safety
   * read, the turn-row calls, the bundle reads, the targets read, the frontier and decide, which the root builds
   * (./real.ts).
   */
  readonly ports: Omit<Ports, JoinedPort>;
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
  /**
   * K-05 v1.2 handleSealingKey as a double, for the root's real sealing port (RootOptions.handleKey: `handleKeys.call`):
   * every request it was asked, and the key object it handed out for each number.
   */
  readonly handleKeys: FakeHandleKeys;
  /**
   * @rosie/ai's safety read over the recorded-model double, for the root's real safety read (RootOptions.safetyReaders:
   * `models.readers`): every model call it made, and how long each answer waits.
   */
  readonly models: FakeSafetyModels;
  /**
   * K-05's commitTurn and parkTurn as a double, for the root's real turn-row port (RootOptions.turnRows: `turnRows.calls`):
   * every request, and the one turns row each turn id was written as.
   */
  readonly turnRows: FakeTurnRows;
  /**
   * K-05 v1 item 7's bundle reads as a double over bundle v0 as bundles/v0 publishes it, for the root's real bundle port
   * (RootOptions.bundleReads: `bundleReads.calls`): every read, in order.
   */
  readonly bundleReads: FakeBundleReads;
  /**
   * K-05 v1.2 handleTargets as a double over test owner 1's seeded rows, for the root's real targets port
   * (RootOptions.handleTargets: `handleTargets.call`): every request, in order.
   */
  readonly handleTargets: FakeHandleTargets;
  /**
   * The frontier's business scope over a K-05 v1.2 readTurnState double holding test owner 1's seeded rows, for the root's
   * real frontier port (RootOptions.frontierScope: `frontier.scope`): every read, under the scope its call ran in.
   */
  readonly frontier: FakeFrontierScope;
  /**
   * @rosie/ai's decide over the recorded-model double, for the root's real decide port (RootOptions.deciders:
   * `decide.deciders`): each context decide was given (the frontier's answer), each re-read, each model call it answered.
   */
  readonly decide: FakeDecideModels;
  /** The shared core the safety read calls (K-09 recordSafetyOutcome, sendFixedLine): what each text's line did. */
  readonly core: FakeCore;
  /** The direct send through Linq the safety read uses only while the core is down. */
  readonly direct: FakeDirect;
  readonly face: FakeTurnFace;
  readonly store: FakeOutboxStore;
  readonly linq: FakeLinq;
  readonly arming: WiredArming;
  /**
   * Sets a text's safety result before it is sent: safety-no.json under its event id, what the turn's commit records
   * (K-09 README default 5). The read on arrival is the joined one (T-554): `models`, over the recorded-model double.
   */
  known(eventId: string): void;
}

/** Every port on its fake, answering the walking skeleton's turn for Sam (S1-02), on one test clock. */
export function skeletonFakes(clock: TestClock = testClock()): SkeletonFakes {
  const handleKeys = fakeHandleKeys(() => clock.now());
  const models = fakeSafetyModels(skeletonSafetyDouble());
  const turnRows = fakeTurnRows();
  const bundleReads = fakeBundleReads();
  const handleTargets = fakeHandleTargets();
  const frontier = fakeFrontierScope(() => clock.utc());
  const core = fakeCore(clock);
  const direct = fakeDirect(clock);
  // Read when each call is made: the turn's commit records what `known` set by then.
  const answers: Record<string, SafetyResult> = {};

  const face = fakeTurnFace();
  const decide = fakeDecideModels(face.log);
  const composer = fakeComposer(face.log);
  const rows = fakeRows(face.log);
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

  const ports: Omit<Ports, JoinedPort> = {
    stateReads: {
      safety: {
        directory: { idsOf: () => Promise.resolve(SAM_IDS) },
        bundle: fixtureBundle(),
        isStopped: () => false,
      },
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
      closestEntries: (request, trace) => turnFace.closestEntries(request, trace),
      gateAndCommit: (request, at, trace) => turnFace.gateAndCommit(request, at, trace),
      composeInput: (request, trace) => turnFace.composeInput(request, trace),
      safetyCore: core,
    },
    composer: composerOf(composer),
    finalize: { finalizeMessage: (request, trace) => turnFace.finalizeMessage(request, trace) },
    dataAccess: { rows: rowsOf(rows), outbox: store, clocks: arming.data.data },
    linqSend: { parts: linq, direct },
  };

  return {
    ports,
    clock,
    linqInputs,
    webhooks,
    sign: (event, partKey = null) => {
      // The text's words and send time, for a turn over it that a test records with decide's double.
      decide.saw(event);
      return webhooks.sign({ event: { ...event, receivedAt: utcSeconds(clock.now()) }, partKey });
    },
    handleKeys,
    models,
    turnRows,
    bundleReads,
    handleTargets,
    frontier,
    decide,
    core,
    direct,
    face,
    store,
    linq,
    arming,
    known(eventId) {
      answers[eventId] = safetyNoFor(eventId);
    },
  };
}
