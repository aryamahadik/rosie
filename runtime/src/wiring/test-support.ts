// Doubles for the composition root's tests (T-550, T-552): the fake set the test environment binds (./picks.ts), every
// port not joined yet on the doubles the runtime's own tests already use, answering the walking skeleton's turn as T-260's
// runtime trace test does (runtime/test/trace-e2e.worker.test.ts): Sam's text, the dispatcher's K-05 store holding the
// skeleton's row (with finalize-pass.json's sends), and a delivery receipt that arms A7-03's clock. The frontier is the
// joined one (T-557): its K-05 double answers for test owner 1's seeded rows, so the turn's context is the real
// frontier's; decide is the joined one (T-558), whose recorded-model double answers that context's reads; the gate is the
// joined one (T-559), whose K-05 doubles write the turn's rows; compose input, the composer (T-560) and finalize (T-561)
// are the joined ones, whose doubles read and write those rows. Not imported by the Worker.
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
//                realTurnRow). What it is fed comes from here: `fakeTurnRows`, a K-05 double over an in-memory K-04,
//                answering as commit-first.json, commit-repeat-same-turn.json, commit-opens-question.json and
//                park-turn.json do for each running turn, and keeping the one K-04 turns row each turn id is written as,
//                every other row its commit wrote and the event log it appended
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
//   turnFace     turn/test-support fakeTurnFace (closest entries) and safety/test-support fakeCore
//   composeInput joined (T-560): the root binds @rosie/actions' turn face's composeInput through its real compose-input
//                port (./real.ts realComposeInput), its inbound text the words the gate port's face holds for the turn.
//                What its reads are fed comes from here: `fakeComposeReads`, the Tool API's business scope and a K-05
//                v1.6 readOutboxRow double over the rows the K-05 commitTurn double wrote and test owner 1's seeded rows
//                (T-1148 with T-1197's barber kind of work: businessSensitive false)
//   gate         joined (T-559): the root binds @rosie/actions' turn face's gateAndCommit through its real gate port
//                (./real.ts realGate), its one commit through the root's turn-row port (`fakeTurnRows`). What its reads
//                are fed comes from here: `fakeGateReads`, the Tool API's business scope and K-05 v1.3 and v1.4's reads
//                over test owner 1's seeded rows and what the K-05 commitTurn double wrote, and a read-only sealer over
//                the keys K-05's handleSealingKey double made
//   decide       joined (T-558): the root binds @rosie/ai's decide and its one Sonnet re-read through its real decide port
//                (./real.ts realDecide), one decider per bundle. What it is fed comes from here: `fakeDecideModels`, the
//                decider (T-369 createDecider) for bundle v0 as bundles/v0 publishes it and for bundle-mini-a, over a fake
//                Messages API whose answers come from the recorded-model double (T-004): ai/recordings' turn 1 recordings
//                as they are (recording 2 is the JOIN run's own; DL-347), decide-reads-disagree.json's three reads on its
//                context, and the reads a test records for its own turn of test owner 1's (`recordTurn`); it keeps each
//                context decide is given (the frontier's answer) and each call it answers
//   composer     joined (T-560): the root binds @rosie/ai's composer and its one rewrite through its real composer port
//                (./real.ts realComposer), one per bundle. What it is fed comes from here: `fakeComposerModels`, the
//                composer (T-373 createComposer) for bundle v0 as bundles/v0 publishes it (its composer prompt), over a
//                fake Messages API whose answers come from the recorded-model double: ai/recordings' composer.v1.1.json
//                as it is (recording 4 is the JOIN run's S1-02 row; DL-347) and the plans a test records for its own
//                turn of test owner 1's (`recordTurn`)
//   finalize     joined (T-561): the root binds @rosie/actions' turn face's finalizeMessage through its real finalize port
//                (./real.ts realFinalize), over the bundle the turn's run pinned. What its reads and writes are fed comes
//                from here: `fakeFinalizeData`, the Tool API's business scope and K-05 doubles over the rows the K-05
//                commitTurn double wrote and test owner 1's seeded rows: readOutboxRow (as compose input's, with the plan
//                the row holds once written), readFixedLineFacts (no phone row in the seed), writePlan (T-196's, keeping
//                each row's plan and final parts) and cancelClock. The turn's finalize calls are kept on the fake face as
//                the stand-in kept them, by `watchGate` when it is handed the face
//   dataAccess   turn/test-support fakeRows (the commit's one row), dispatch/test-support FakeOutboxStore, and
//                clocks/arming-support's K-05 armClock and cancelClock
//   linqSend     dispatch/test-support FakeLinq and safety/test-support fakeDirect
//
// One test clock stands behind every fake that keeps time and behind the root itself. The contract fixtures and the Linq
// double come through npm's workspace links (@rosie/contracts, @rosie/adapters). Test values only: the master's sample
// cast, the frozen fixtures' ids, the fictional 555-01xx numbers (rule 9) and a webhook secret made up for each run.

import type { FlagsReader } from "@rosie/actions/src/domain/flags/reads";
import type { MessagesReader } from "@rosie/actions/src/domain/messages-consent/reads";
import type { StoredHold, StoredOutcome } from "@rosie/actions/src/domain/safety/ports";
import type {
  CancelClockAnswer,
  CancelClockRequest,
  WritePlanAnswer,
  WritePlanRequest,
} from "@rosie/actions/src/finalize/rewrite/types";
import type { ReadTurnStateAnswer, ReadTurnStateRequest } from "@rosie/actions/src/frontier/assemble/types";
import { TurnFaceRefusedError } from "@rosie/actions/src/tool-api/turn-face/errors";
import type { FixedLineFactsRead, OutboxRowRead } from "@rosie/actions/src/tool-api/turn-face/rows";
import { createLinqWebhookDouble, type LinqWebhookDouble } from "@rosie/adapters/linq/double-webhooks";
import type { InboundEvent as LinqEvent, VerifyWebhookRequest } from "@rosie/adapters/linq/webhook";
import joinComposeInputJson from "@rosie/ai/recordings/composer-inputs/join-s1-02.json";
import composerRecordingsV11 from "@rosie/ai/recordings/composer.v1.1.json";
import joinRunContextJson from "@rosie/ai/recordings/contexts/join-s1-01.json";
import recordingsV11 from "@rosie/ai/recordings/recordings.v1.1.json";
import { createPromptCache, type CacheBundle, type CacheFlow } from "@rosie/ai/src/cache/index";
import { createComposer } from "@rosie/ai/src/composer/compose";
import { composeInputText, type ComposeInput as AiComposeInput } from "@rosie/ai/src/composer/prompt";
import type { Composer } from "@rosie/ai/src/composer/types";
import { unescapeData } from "@rosie/ai/src/context/tags";
import { createDecider } from "@rosie/ai/src/decide/two-reads";
import type { Decider } from "@rosie/ai/src/decide/types";
import { KEY_VARIABLE, type FetchLike } from "@rosie/ai/src/gateway/index";
import { COMPOSER_KIND } from "@rosie/ai/src/recorded-double/composer-types";
import { createRecordedComposer, createRecordedModel } from "@rosie/ai/src/recorded-double/double";
import { NoRecordingError } from "@rosie/ai/src/recorded-double/errors";
import { canonicalJson, requestKey } from "@rosie/ai/src/recorded-double/key";
import type { RecordedModel } from "@rosie/ai/src/recorded-double/types";
import { turnStakes, type RoutingBundle, type RoutingContext } from "@rosie/ai/src/routing/index";
import { createSafetyReader, SAFETY_READ_PROMPT, type SafetyReader } from "@rosie/ai/src/safety/index";
import bundleMiniA from "@rosie/contracts/bundle/fixtures/bundle-mini-a.json";
import manifestFixture from "@rosie/contracts/bundle/fixtures/manifest.json";
import activeBundleJson from "@rosie/contracts/data-access/fixtures/active-bundle.json";
import commitFirstJson from "@rosie/contracts/data-access/fixtures/commit-first.json";
import parkTurnJson from "@rosie/contracts/data-access/fixtures/park-turn.json";
import targetsFirstTextJson from "@rosie/contracts/data-access/fixtures/targets-first-text.json";
import seedBusinessHead from "@rosie/contracts/db-schema/core/fixtures/seed-business-head.json";
import seedPersonRoles from "@rosie/contracts/db-schema/core/fixtures/seed-person-roles.json";
import textImessage from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import contextS101 from "@rosie/contracts/model/fixtures/context-s1-01.json";
import decideReadsDisagree from "@rosie/contracts/model/fixtures/decide-reads-disagree.json";
import decideS101Enter from "@rosie/contracts/model/fixtures/decide-s1-01-enter.json";
import safetyNo from "@rosie/contracts/model/fixtures/safety-no.json";
import inputS102V11 from "@rosie/contracts/message-plan/fixtures/input-s1-02-v1.1.json";
import planS102 from "@rosie/contracts/message-plan/fixtures/plan-s1-02.json";
import finalizePass from "@rosie/contracts/tool-api/fixtures/finalize-pass.json";
import commitS102 from "@rosie/contracts/tool-api/fixtures/commit-s1-02.json";
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
import type { CommitContext, CommitTurnRef } from "../actor";
import { turnIdOf } from "../actor/lease";
import { BUNDLE_B } from "../bundle/test-support";
import { A7_03_QUESTION, wireArming, type WiredArming } from "../clocks/arming-support";
import { FakeLinq, FakeOutboxStore, FakeRecipients, FakeSendState } from "../dispatch/test-support";
import { fakeCore, fakeDirect, fixtureBundle, type FakeCore, type FakeDirect } from "../safety/test-support";
import type { HandleIds, SafetyResult } from "../safety/types";
import type { BundleId, TraceContext } from "../trace";
import { setTurnDeps } from "../turn/turn";
import {
  a7_17Context,
  fakeRows,
  fakeTurnFace,
  rowsOf,
  safetyNoFor,
  SAM,
  turnFaceOf,
  unplannedRow,
  type FakeTurnFace,
} from "../turn/test-support";
import type {
  DecideContext,
  FinalizeMessageAnswer,
  FinalizeMessageRequest,
  GateAndCommitAnswer,
  GateAndCommitRequest,
  GateCommitted,
} from "../turn/types";
import type { Ports } from "./ports";
import type {
  BundleReadCalls,
  CommitTurnCall,
  ComposeReads,
  Composers,
  Deciders,
  FinalizeData,
  FrontierScope,
  GateReads,
  HandleSealingKeyCall,
  HandleTargetsCall,
  LinqVerifyInputs,
  SafetyReaders,
  TurnRowCalls,
} from "./real";
import type { Root, RootClock } from "./root";
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

// ---- K-05 commitTurn and parkTurn, as a double: a turn's one row and what its commit writes (T-555, T-559) ---------

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

/** One row a commit wrote besides its turns row (K-04), as the double keeps it. */
export interface WrittenRow {
  readonly table: string;
  readonly id: string;
  /**
   * Its values as K-05's request wrote them, field for field: a state insert's values (an update's `set` merged over
   * them), an open question, a clock row with the state K-05 gives it (waiting until its first delivery receipt arms it,
   * or armed when the write names when it is due), an outbox row with its commit order.
   */
  readonly values: Readonly<Record<string, unknown>>;
  /** Its version after the commit: an insert 1, an update its read version plus one. */
  readonly version: number;
  /** The turn whose commit wrote it. */
  readonly turnId: string;
}

/** One event-log row as K-05 appends it (K-08 v1.1 eventLogRow, column for column): the entry, with the turn's ids. */
export type EventLogRow = Readonly<Record<string, unknown>>;

/** K-05 v1's turn, a closed object of seven fields (K-05 v1 `turn`): what the double takes, and nothing more. */
const K05_TURN_FIELDS = ["id", "handleId", "eventIds", "bundleId", "traceId", "joinedTraceIds", "tries"];

/** A request K-05 does not take; the message names a field, never a value. */
export class K05RefusedError extends Error {
  constructor(what: string) {
    super(`K-05 v1.1 refuses the commitTurn request: ${what}`);
    this.name = "K05RefusedError";
  }
}

export interface FakeTurnRows {
  /** What the root's turn-row port is fed (RootOptions.turnRows): K-05's two calls, over the double's turns rows. */
  readonly calls: TurnRowCalls;
  /** K-04 turns, by turn id: the one row each turn id was written as. */
  readonly turns: Map<string, TurnsRow>;
  /** Every other row the commits wrote (K-04 and its domain parts), by table, then by id. */
  readonly rows: Map<string, Map<string, WrittenRow>>;
  /** The event log the commits appended, in order. */
  readonly eventLog: EventLogRow[];
  /** Every commitTurn request, in order. */
  readonly commits: CommitTurnRequest[];
  /** Every parkTurn request, in order. */
  readonly parks: K05ParkTurnRequest[];
  /** When set, every commitTurn answers it and writes nothing, as K-05 answering transient (the same request may come again). */
  failCommitsWith: { readonly error: "transient" } | null;
}

const PARK_TURN_ID = parkTurnJson.request.turn.id;
/** The database's now() at each first commit: commit-first.json's committedAt. */
const COMMITTED_AT = commitFirstJson.outcome.committedAt;

const commitAnswer = (value: unknown): Promise<CommitTurnOutcome> =>
  Promise.resolve(structuredClone(value) as CommitTurnOutcome);
const parkAnswer = (value: unknown): Promise<ParkTurnOutcome> =>
  Promise.resolve(structuredClone(value) as ParkTurnOutcome);

type K05Writes = CommitTurnRequest["writes"];
type K05Committed = Extract<CommitTurnOutcome, { result: "committed" }>;

/** The one id of a state update's key (K-04: a row is named by its primary key alone). */
function keyIdOf(key: Readonly<Record<string, unknown>>): string {
  const values = Object.values(key);
  const [id] = values;
  if (values.length !== 1 || typeof id !== "string") throw new K05RefusedError("a state update's key");
  return id;
}

/**
 * K-05 v1 eventEntry as K-05 appends it to K-04's event_log (K-08 v1.1 eventLogRow, column for column): "the turn's id,
 * trace id and bundle ... come from the call, not the entry" (K-05 v1 eventEntry), at the commit's time.
 */
function eventLogRowOf(
  entry: K05Writes["events"][number],
  turn: CommitTurnRequest["turn"],
  at: string,
): EventLogRow {
  return {
    id: entry.id,
    at,
    zone: entry.zone,
    turn_id: turn.id,
    job_id: null,
    trace_id: turn.traceId,
    bundle_hash: turn.bundleId.hash,
    bundle_build: turn.bundleId.build,
    business_id: entry.businessId,
    actor_kind: entry.actorKind,
    actor_person_id: entry.actorPersonId,
    actor_role: entry.actorRole,
    kind: entry.kind,
    table_name: entry.tableName,
    row_id: entry.rowId,
    old_values: entry.oldValues,
    new_values: entry.newValues,
    sealed_values: entry.sealed?.base64 ?? null,
    sealed_for_person_id: entry.sealed?.forPersonId ?? null,
    why: entry.why,
    approved_by: entry.approvedBy,
    proofs: entry.proofs,
  };
}

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
 * K-05 commitTurn and parkTurn as a double over an in-memory K-04 (K-05 README items 1 and 12), answering as
 * commit-first.json, commit-repeat-same-turn.json, commit-opens-question.json and park-turn.json do, for whichever turn
 * asks. A commit's turn is K-05 v1's closed turn: a field beyond its seven is refused (K05RefusedError, nothing written).
 * The first commit of a turn id writes that id's one turns row, committed, and every row its request writes, all or
 * nothing: each state insert or update, each open question opened (waiting) or closed, each clock row made (waiting until
 * its first delivery receipt arms it, unless it names when it is due) or cancelled, each outbox row in commit order, each
 * reservation confirmed or released, each effect, and one event-log row per entry with the turn's id, trace id and
 * bundle; it answers K-05's commitResult: the versioned rows in the order written (an insert at version 1, an update at
 * its read version plus one; a confirmed reservation also cancels its saved-time clock row) and the outbox rows with their
 * commit order, at commit-first.json's committedAt (so commit-first.json's own request gets its own outcome). A later
 * commit of a committed id writes nothing and answers the first commit, repeated, with no rows written (the repeat's body
 * is not read: commit-repeat-same-turn.json). A later park of a parked id answers its first park again, repeated; a commit
 * of a parked id turnParked; a park of a committed id alreadyCommitted. A parked row's time is the request's parkedAt.
 * Each call runs whole before the next: two commits of one turn id at once give one commit.
 */
export function fakeTurnRows(): FakeTurnRows {
  const turns = new Map<string, TurnsRow>();
  const rows = new Map<string, Map<string, WrittenRow>>();
  const eventLog: EventLogRow[] = [];
  const commits: CommitTurnRequest[] = [];
  const parks: K05ParkTurnRequest[] = [];
  const firstCommits = new Map<string, K05Committed>();
  const firstParks = new Map<string, Record<string, unknown>>();
  let nextCommitSeq = 1;

  const tableOf = (table: string): Map<string, WrittenRow> => {
    const known = rows.get(table);
    if (known !== undefined) return known;
    const made = new Map<string, WrittenRow>();
    rows.set(table, made);
    return made;
  };

  /** Writes a first commit's rows, all of them, and answers K-05's commitResult. */
  const commitWrites = (request: CommitTurnRequest): K05Committed => {
    const { writes, turn } = request;
    const staged: WrittenRow[] = [];
    const written: { table: string; rowId: string; version: number }[] = [];
    const before = (table: string, id: string): Readonly<Record<string, unknown>> => {
      const stagedRow = [...staged].reverse().find((row) => row.table === table && row.id === id);
      return stagedRow?.values ?? rows.get(table)?.get(id)?.values ?? {};
    };
    const put = (
      table: string,
      id: string,
      values: Readonly<Record<string, unknown>>,
      version: number,
    ): void => {
      staged.push({ table, id, values: structuredClone(values), version, turnId: turn.id });
      written.push({ table, rowId: id, version });
    };
    for (const write of writes.state) {
      if (write.op === "insert") {
        const id = write.values.id;
        if (typeof id !== "string") throw new K05RefusedError(`a ${write.table} insert names no id`);
        put(write.table, id, write.values, 1);
      } else {
        const id = keyIdOf(write.key);
        put(write.table, id, { ...before(write.table, id), ...write.set }, write.expectVersion + 1);
      }
    }
    for (const question of writes.openQuestions.open) {
      put("open_questions", question.id, { ...question, status: "waiting" }, 1);
    }
    for (const close of writes.openQuestions.close) {
      put(
        "open_questions",
        close.id,
        { ...before("open_questions", close.id), ...close },
        close.expectVersion + 1,
      );
    }
    for (const clock of writes.clockRows.make) {
      const id = clock.id;
      if (typeof id !== "string") throw new K05RefusedError("a clock row names no id");
      const due = clock.due ?? null;
      put(
        "clock_rows",
        id,
        { ...clock, state: due === null ? "waiting" : "armed", createdByTurnId: turn.id },
        1,
      );
    }
    for (const cancel of writes.clockRows.cancel) {
      put(
        "clock_rows",
        cancel.id,
        { ...before("clock_rows", cancel.id), state: "cancelled" },
        cancel.expectVersion + 1,
      );
    }
    for (const confirm of writes.reservations.confirm) {
      put("reservations", confirm.id, { ...confirm, state: "booked" }, confirm.expectVersion + 1);
      written.push({ table: "clock_rows", rowId: `${confirm.id}/saved-time`, version: 2 });
    }
    for (const release of writes.reservations.release) {
      put("reservations", release.id, { ...release }, release.expectVersion + 1);
    }
    for (const effect of writes.effects?.write ?? []) {
      const id = effect.effectId;
      if (typeof id !== "string") throw new K05RefusedError("an effect names no id");
      put("effects", id, { ...effect, state: "pending" }, 1);
    }
    for (const letGo of writes.effects?.letGo ?? []) {
      put(
        "effects",
        letGo.effectId,
        { ...before("effects", letGo.effectId), state: "cancelled" },
        letGo.expectVersion + 1,
      );
    }
    const outboxRows = writes.outboxRows.map((row) => {
      const commitSeq = nextCommitSeq++;
      staged.push({
        table: "outbox_rows",
        id: row.id,
        values: { ...structuredClone(row), commitSeq },
        version: 1,
        turnId: turn.id,
      });
      return { id: row.id, commitSeq };
    });
    // All or nothing: every row lands once the whole request has been read.
    for (const row of staged) tableOf(row.table).set(row.id, row);
    for (const entry of writes.events) eventLog.push(eventLogRowOf(entry, turn, COMMITTED_AT));
    return {
      result: "committed",
      turnId: turn.id,
      committedAt: COMMITTED_AT,
      repeated: false,
      committed: { written, outboxRows, promoted: [] },
    };
  };

  const double: FakeTurnRows = {
    turns,
    rows,
    eventLog,
    commits,
    parks,
    failCommitsWith: null,
    calls: {
      commitTurn(request) {
        commits.push(structuredClone(request));
        if (double.failCommitsWith !== null) return commitAnswer({ ...double.failCommitsWith });
        const extra = Object.keys(request.turn).filter((field) => !K05_TURN_FIELDS.includes(field));
        if (extra.length > 0) {
          return Promise.reject(
            new K05RefusedError(`its turn holds ${extra.join(", ")}, beyond K-05 v1's turn`),
          );
        }
        const turnId = request.turn.id;
        const known = turns.get(turnId);
        if (known?.state === "parked")
          return commitAnswer({ error: "turnParked", turnId, parkedAt: known.at });
        const first = firstCommits.get(turnId);
        if (first !== undefined) {
          return commitAnswer({
            ...first,
            repeated: true,
            committed: { written: [], outboxRows: first.committed.outboxRows, promoted: [] },
          });
        }
        let answer: K05Committed;
        try {
          answer = commitWrites(request);
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new K05RefusedError("its writes"));
        }
        turns.set(turnId, turnsRowOf(request.turn, "committed", COMMITTED_AT));
        firstCommits.set(turnId, answer);
        return commitAnswer(answer);
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
 * The Tool API's gate and commit as the hops' tests stood it in before T-559 joined @rosie/actions' (a FakeTurnFace
 * `gate`; since then the gate port is real under test, and this stand-in answers only where a test calls it itself, such
 * as ./turn-row.test.ts's check of the turn-row port): no
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

/** One gateAndCommit the turn handed the root: the request as the turn made it, its CommitContext and the run's trace. */
export interface WatchedGateCall {
  readonly request: GateAndCommitRequest;
  readonly at: CommitContext;
  readonly trace: TraceContext;
  /** What the root's gate port answered (or threw), once it has. */
  answer: unknown;
}

/** One finalizeMessage the turn handed the root: the request as the turn made it, and what the finalize port answered. */
export interface WatchedFinalizeCall {
  readonly request: FinalizeMessageRequest;
  /** What the root's finalize port answered (or threw), once it has. */
  answer: unknown;
}

/** The turn's calls a watch keeps besides its gate calls: its finalize calls, with their answers. */
export interface WatchedTurn {
  readonly calls: WatchedGateCall[];
  readonly finalizeCalls: WatchedFinalizeCall[];
  restore(): void;
}

/**
 * Watches the turn's gateAndCommit and finalizeMessage on a root whose actor ports are installed (call it after
 * `root.install()`): each call the turn makes is kept, as the turn made it, then goes on to the root's own call unchanged
 * (gateAndCommit puts the run's text source on the request's turn and sends it to the gate port; finalizeMessage goes to
 * the finalize port), its answer kept beside it. Since T-561 joined finalize, no stand-in face answers it, so a fake face
 * handed in (`face`) also gets each finalize request and its log line, as the stand-in face kept them. A test's observer
 * only: nothing it holds changes what the gate or finalize is sent or answers. Returns the calls and what puts the root's
 * own turn deps back.
 */
export function watchGate(
  root: Root,
  face: Pick<FakeTurnFace, "finalizeCalls" | "log"> | null = null,
): WatchedTurn {
  const calls: WatchedGateCall[] = [];
  const finalizeCalls: WatchedFinalizeCall[] = [];
  const restore = setTurnDeps({
    ...root.turn,
    toolApi: {
      ...root.turn.toolApi,
      async gateAndCommit(request, at, trace) {
        const call: WatchedGateCall = { request: structuredClone(request), at, trace, answer: undefined };
        calls.push(call);
        try {
          call.answer = await root.turn.toolApi.gateAndCommit(request, at, trace);
        } catch (error) {
          call.answer = error;
          throw error;
        }
        return call.answer as GateAndCommitAnswer;
      },
      async finalizeMessage(request, trace) {
        const call: WatchedFinalizeCall = { request: structuredClone(request), answer: undefined };
        finalizeCalls.push(call);
        face?.finalizeCalls.push(structuredClone(request));
        face?.log.push(`finalize:${request.attempt}:${request.outboxRowId}`);
        try {
          call.answer = await root.turn.toolApi.finalizeMessage(request, trace);
        } catch (error) {
          call.answer = error;
          throw error;
        }
        return call.answer as FinalizeMessageAnswer;
      },
    },
  });
  return { calls, finalizeCalls, restore };
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

/** One part of bundle v0 as bundles/v0 publishes it, parsed: its manifest, or a flow graph (flow/A). */
function bundleV0Part(part: string): Record<string, unknown> {
  const text = BUNDLE_V0_PARTS.get(bundleKeyOf(BUNDLE_V0, part));
  if (text === undefined) throw new Error(`bundles/v0 publishes no ${part}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Bundle v0's fixed line `id` in `lang` (K-01 v1 lists.fixedLines), word for word as bundles/v0 publishes its manifest (its
 * <business> left as written): the words finalize adds to a row of a turn pinned to bundle v0 (T-314, T-1146).
 */
export function bundleV0FixedLine(id: string, lang = "en"): string {
  const lists = bundleV0Part("manifest").lists as
    | {
        readonly fixedLines?: {
          readonly lines?: readonly { id: string; lang: string; text: string | null }[];
        };
      }
    | undefined;
  const text = lists?.fixedLines?.lines?.find((line) => line.id === id && line.lang === lang)?.text;
  if (typeof text !== "string") throw new Error(`bundles/v0 holds no ${lang} fixed line ${id}`);
  return text;
}

/** A step's fallback text in bundle v0's flow A (K-01 v1 step.fallbackText), as bundles/v0 publishes it. */
export function bundleV0FallbackText(stepId: string): string {
  const steps = bundleV0Part("flow/A").steps as
    Readonly<Record<string, { fallbackText?: unknown }>> | undefined;
  const text = steps?.[stepId]?.fallbackText;
  if (typeof text !== "string") throw new Error(`bundles/v0's flow A holds no fallback text for ${stepId}`);
  return text;
}

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

/**
 * Lee's Barbershop's name as test owner 1's seed stores it (K-04 businesses.name): with its sensitive switch off, the name
 * limit 7 lets a reader see (biz.name), so the one a fixed line's <business> is filled with (T-314 claimedBusiness).
 */
export const TEST_OWNER_1_BUSINESS_NAME = String(
  SEEDED.businesses.get(TEST_OWNER_1.businessId)?.values.name ?? "",
);

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

// ---- the gate's reads, as doubles: test owner 1's seeded rows and what the commits wrote (T-559) -------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The repo of one gate call's transaction in the doubles: no database, only the business it is scoped to. */
export interface GateCallRepo {
  readonly scopedTo: string;
}

/** One read the gate made through the doubles: its K-05 name and the business its request named. */
export interface GateRead {
  readonly read: string;
  readonly businessId: string | null;
}

export interface FakeGateReads {
  /** What the root's real gate port is fed (RootOptions.gateReads): the scope and the reads over the doubles. */
  readonly reads: GateReads;
  /** Each gate call's business scope, in order (the Tool API's own: rosie_app on PostgreSQL). */
  readonly scopes: string[];
  /** Every read, in order. */
  readonly seen: GateRead[];
  /** Each seal, by the person whose key sealed it (the words are never kept). */
  readonly sealedFor: string[];
}

/** A K-34 safety_outcomes row as K-05 v1.4's reads answer it (StoredOutcome), from the row a commit wrote. */
function storedOutcomeOf(row: WrittenRow): StoredOutcome {
  const values = row.values;
  return {
    id: row.id,
    eventId: values.event_id,
    source: values.source,
    handleId: values.handle_id ?? null,
    personId: values.person_id ?? null,
    businessId: values.business_id ?? null,
    bookingId: values.booking_id ?? null,
    turnId: values.turn_id ?? null,
    readAt: values.read_at,
    timedOut: values.timed_out,
    labels: values.labels,
    tenses: values.tenses,
    dangerWordKinds: values.danger_word_kinds,
    outcomes: values.outcomes,
    liftedToUnsure: values.lifted_to_unsure,
  } as StoredOutcome;
}

/** A K-34 safety_holds row as K-05 v1.4's reads answer it (StoredHold), from the row a commit wrote. */
function storedHoldOf(row: WrittenRow): StoredHold {
  const values = row.values;
  return {
    id: row.id,
    safetyOutcomeId: values.safety_outcome_id,
    businessId: values.business_id ?? null,
    handleId: values.handle_id,
    personId: values.person_id ?? null,
    bookingId: values.booking_id ?? null,
    turnId: values.turn_id ?? null,
    releaseRule: values.release_rule,
    blocksBooking: values.blocks_booking,
    heldAt: values.held_at,
    releasedAt: values.released_at ?? null,
    releasedWhy: values.released_why ?? null,
    releasedByTurnId: values.released_by_turn_id ?? null,
    releasedByOutcomeId: values.released_by_outcome_id ?? null,
    version: row.version,
  } as StoredHold;
}

/** A reader whose every read is refused, naming the read: test owner 1's seeded rows answer none of them on turn 1. */
function refusingReader<T extends object>(reader: string, reads: readonly (keyof T & string)[]): T {
  return Object.fromEntries(
    reads.map((read) => [
      read,
      () =>
        Promise.reject(new Error(`the skeleton's ${reader} double holds no ${read} read: turn 1 makes none`)),
    ]),
  ) as T;
}

const FLAGS_READS: readonly (keyof FlagsReader)[] = [
  "handleOfAddress",
  "handle",
  "phone",
  "personIdsOfHandle",
  "handleIdsOfPerson",
  "personExists",
  "liveRoles",
  "consentWritten",
  "consentsOfPersons",
  "bookingHead",
  "bookingsOfPerson",
  "pause",
  "openPausesOfPerson",
  "openPausesOfPhone",
  "openQuestionsOfHandle",
];

const MESSAGES_READS: readonly (keyof MessagesReader)[] = [
  "person",
  "handleIdsOfPerson",
  "handle",
  "phoneOfHandle",
  "chatThreadOf",
  "consentsOfPersons",
];

/**
 * The gate's reads (./real.ts GateReads) as doubles over test owner 1's seeded rows (T-1148: Lee's Barbershop's business
 * head, Sam with no role, no hold and no outcome) and the rows the K-05 commitTurn double wrote (`written`), as the real
 * reads answer on PostgreSQL:
 *   scope           one call's transaction, its repo scoped to the call's business (rosie_app's row-level security);
 *   readOpenHolds   K-05 v1.3: the handle's holds still open at the business, and the asked texts with no outcome there;
 *   safety reads    K-05 v1.4: the outcomes and holds the commits wrote, whether an outbox row is written, the seeded
 *                   business's zone, and its owner (none: Sam holds no role yet, ADR-013 default 130);
 *   sealer          read-only: the words sealed (AES-256-GCM, a fresh IV, bound to the person's id) under the seeded
 *                   person's key, as the gateway's first sight of their number made it (one non-exportable key per seeded
 *                   person, made for the run), and refused (noSealingKey) for a person the seed does not hold: a key is
 *                   never made here;
 *   flags, messages T-317's and T-307's reads, each refused, naming the read: a No record reads none of them.
 * Each read on the call's transaction refuses a request that names another business than the call's scope, before
 * anything is read (BusinessScopeError, as db/repo/scope.ts does).
 */
export function fakeGateReads(
  written: Pick<FakeTurnRows, "rows">,
  seeded: readonly SeededHandle[] = [TEST_OWNER_1],
): FakeGateReads {
  const scopes: string[] = [];
  const seen: GateRead[] = [];
  const sealedFor: string[] = [];
  const rowsOf = (table: string): WrittenRow[] => [...(written.rows.get(table)?.values() ?? [])];
  /** Notes the read, and refuses it when its business is not the call's scope. */
  const inScope = (repo: unknown, read: string, businessId: string | null): void => {
    seen.push({ read, businessId });
    if (!isRecord(repo) || repo.scopedTo !== businessId) {
      throw new BusinessScopeError("a read names another business than the call's scope");
    }
  };
  const outcomeWhere = (businessId: string, match: (row: WrittenRow) => boolean): StoredOutcome | null => {
    const row = rowsOf("safety_outcomes").find(
      (each) => match(each) && each.values.business_id === businessId,
    );
    return row === undefined ? null : storedOutcomeOf(row);
  };
  const holdWhere = (businessId: string, match: (row: WrittenRow) => boolean): StoredHold | null => {
    const row = rowsOf("safety_holds").find((each) => match(each) && each.values.business_id === businessId);
    return row === undefined ? null : storedHoldOf(row);
  };
  const zoneOf = (businessId: string): string | null => {
    const zone = SEEDED.businesses.get(businessId)?.values.time_zone;
    return typeof zone === "string" ? zone : null;
  };
  // Each seeded person's key, as the gateway's first sight of their number made it (K-05 v1.2 item 29).
  const personKeys = new Map<string, Promise<CryptoKey>>();
  const keyOfPerson = (personId: string): Promise<CryptoKey> => {
    if (!seeded.some((entry) => entry.personId === personId)) {
      return Promise.reject(new TurnFaceRefusedError("noSealingKey"));
    }
    const known = personKeys.get(personId);
    if (known !== undefined) return known;
    const made = crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]) as Promise<CryptoKey>;
    personKeys.set(personId, made);
    return made;
  };

  const reads: GateReads = {
    scope: {
      withBusiness: (businessId, work) => {
        scopes.push(businessId);
        const repo: GateCallRepo = { scopedTo: businessId };
        return work(repo);
      },
    },
    readOpenHolds: (repo, request) => {
      try {
        inScope(repo, "readOpenHolds", request.businessId);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error("readOpenHolds"));
      }
      const businessId = request.businessId;
      const holds = rowsOf("safety_holds")
        .filter(
          (row) =>
            row.values.handle_id === request.handleId &&
            row.values.business_id === businessId &&
            (row.values.released_at ?? null) === null,
        )
        .map((row) => {
          const hold = storedHoldOf(row);
          return { holdId: hold.id, releaseRule: hold.releaseRule, blocksBooking: hold.blocksBooking };
        });
      const unreadEventIds = request.eventIds.filter(
        (eventId) =>
          businessId === null || outcomeWhere(businessId, (row) => row.values.event_id === eventId) === null,
      );
      return Promise.resolve({ result: "openHolds", holds, unreadEventIds });
    },
    safetyReads: {
      outcomeOfEvent: (repo, { eventId, businessId }) => {
        inScope(repo, "readSafetyOutcomeOfEvent", businessId);
        return Promise.resolve({
          safetyOutcome: outcomeWhere(businessId, (row) => row.values.event_id === eventId),
        });
      },
      outcome: (repo, { outcomeId, businessId }) => {
        inScope(repo, "readSafetyOutcome", businessId);
        return Promise.resolve({ safetyOutcome: outcomeWhere(businessId, (row) => row.id === outcomeId) });
      },
      hold: (repo, { holdId, businessId }) => {
        inScope(repo, "readSafetyHold", businessId);
        return Promise.resolve({ hold: holdWhere(businessId, (row) => row.id === holdId) });
      },
      holdOfOutcome: (repo, { outcomeId, businessId }) => {
        inScope(repo, "readSafetyHoldOfOutcome", businessId);
        return Promise.resolve({
          hold: holdWhere(businessId, (row) => row.values.safety_outcome_id === outcomeId),
        });
      },
      outboxRowWritten: (repo, { outboxRowId, businessId }) => {
        inScope(repo, "readOutboxRowWritten", businessId);
        return Promise.resolve({ written: written.rows.get("outbox_rows")?.has(outboxRowId) ?? false });
      },
      businessZone: (repo, { businessId }) => {
        inScope(repo, "readBusinessZone", businessId);
        const timeZone = zoneOf(businessId);
        return Promise.resolve(
          timeZone === null ? { error: "notFound", table: "businesses", rowId: businessId } : { timeZone },
        );
      },
      // The runtime side's read, in a transaction of its own under the business (no call's repo).
      businessOwner: ({ businessId }) => {
        seen.push({ read: "readBusinessOwner", businessId });
        if (!SEEDED.businesses.has(businessId)) {
          return Promise.resolve({ error: "notFound", table: "businesses", rowId: businessId });
        }
        return Promise.resolve({ owner: null });
      },
    },
    sealer: {
      async seal(plaintext, forPersonId) {
        const key = await keyOfPerson(forPersonId);
        sealedFor.push(forPersonId);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const sealed = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(forPersonId) },
          key,
          new TextEncoder().encode(plaintext),
        );
        const bytes = new Uint8Array(iv.byteLength + sealed.byteLength);
        bytes.set(iv, 0);
        bytes.set(new Uint8Array(sealed), iv.byteLength);
        return bytes;
      },
    },
    flagsReader: () => refusingReader<FlagsReader>("flags", FLAGS_READS),
    messagesReader: () => refusingReader<MessagesReader>("messages", MESSAGES_READS),
  };
  return { reads, scopes, seen, sealedFor };
}

// ---- @rosie/ai's decide over the recorded-model double (T-558) -----------------------------------------------------

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

// ---- K-05 v1.6 readOutboxRow under compose input's scope, as a double: what the commit wrote (T-560) --------------

/**
 * Lee's Barbershop's sensitive switch as T-1197's skeleton seed stores its kinds of work (K-23 company_kinds: one, barber,
 * with no plug-in switch on): K-05 v1.6 item 45's businessSensitive, false.
 */
const SEEDED_SENSITIVE: ReadonlyMap<string, boolean> = new Map([[TEST_OWNER_1.businessId, false]]);

/** One readOutboxRow compose input made through the double: the row it asked for, under the business it named. */
export interface ComposeRowRead {
  readonly outboxRowId: string;
  readonly businessId: string;
}

export interface FakeComposeReads {
  /** What the root's real compose-input port is fed (RootOptions.composeReads): the scope and readOutboxRow over the doubles. */
  readonly reads: ComposeReads;
  /** Each compose input call's business scope, in order (the Tool API's own: rosie_app on PostgreSQL). */
  readonly scopes: string[];
  /** Every readOutboxRow, in order (each the runtime side's own transaction under the named business). */
  readonly rowReads: ComposeRowRead[];
}

/** A clock row's due time as the commit wrote it (K-05 v1 clockNew.due), or none for a clock written waiting. */
function dueOf(values: Readonly<Record<string, unknown>>): { dueAt: string | null; dueZone: string | null } {
  const due = values.due;
  if (!isRecord(due) || typeof due.dueAt !== "string" || typeof due.dueZone !== "string") {
    return { dueAt: null, dueZone: null };
  }
  return { dueAt: due.dueAt, dueZone: due.dueZone };
}

/**
 * K-05 v1.6 readOutboxRow (T-1138, T-1197; README items 35 and 45) as a double over the rows the K-05 commitTurn double
 * wrote (`written`: each turn, its outbox rows, open questions and clock rows, and the safety record's outcomes) and test
 * owner 1's seeded rows (T-1148 with T-1197's barber kind of work: Lee's Barbershop's head, Sam Lee with no role, no
 * language stored and no phone row), answering as db/repo/turn-face-reads.ts's readOutboxRow answers on those rows: the
 * row under the request's business (notFound for a row the business does not hold; fixedLineRow for a safety row), at
 * its turn's bundle, its line the question it asks (line 0), its recipient as stored, its turn's texts each with its
 * safety outcome under the business, the business head, the question with its clock row, the business's sensitive switch
 * (false: the barber kind, no switch on), and no other question gone to the handle (no part of a turn's reply has gone
 * before it is composed). A row about a booking, or one to a recipient the seed does not hold, is refused (thrown): the
 * double holds no booking and no other person. Each call's scope is the Tool API's own, its repo scoped to the call's
 * business. `log` gets "composeInput:<row>" for each read, as the stand-in turn face logged its compose input.
 */
export function fakeComposeReads(
  written: Pick<FakeTurnRows, "rows" | "turns">,
  now: () => number = Date.now,
  log: string[] = [],
): FakeComposeReads {
  const scopes: string[] = [];
  const rowReads: ComposeRowRead[] = [];
  const reads: ComposeReads = {
    scope: scopeRecordedIn(scopes),
    readOutboxRow(request) {
      rowReads.push({ outboxRowId: request.outboxRowId, businessId: request.businessId });
      log.push(`composeInput:${request.outboxRowId}`);
      return outboxRowOf(written, request, now);
    },
  };
  return { reads, scopes, rowReads };
}

/** The Tool API's own business scope as a double: each call's business kept in `scopes`, its repo scoped to it. */
function scopeRecordedIn(scopes: string[]): ComposeReads["scope"] {
  return {
    withBusiness: (businessId, work) => {
      scopes.push(businessId);
      const repo: GateCallRepo = { scopedTo: businessId };
      return work(repo);
    },
  };
}

/** A K-05 error answer as the row binding takes it (notFound, fixedLineRow). */
type RowError = Extract<Awaited<ReturnType<ComposeReads["readOutboxRow"]>>, { readonly error: string }>;

/**
 * K-05 v1.6 readOutboxRow as fakeComposeReads describes it: the row the K-05 commitTurn double wrote, read under the
 * request's business over test owner 1's seeded rows, as a row that holds no plan yet (K-07 planned, version as written).
 */
function outboxRowOf(
  written: Pick<FakeTurnRows, "rows" | "turns">,
  request: { readonly outboxRowId: string; readonly businessId: string },
  now: () => number,
): Promise<OutboxRowRead | RowError> {
  const rowsOf = (table: string): WrittenRow[] => [...(written.rows.get(table)?.values() ?? [])];
  const refused = (what: string): Promise<never> =>
    Promise.reject(new Error(`the skeleton's readOutboxRow double holds no ${what}`));

  /** The question the row asks, with its clock row (a waiting or armed one first), under the row's business. */
  const questionOf = (questionId: string, businessId: string): Record<string, unknown> | null => {
    const question = written.rows.get("open_questions")?.get(questionId);
    if (question?.values.businessId !== businessId) return null;
    const clocks = rowsOf("clock_rows")
      .filter(
        (row) =>
          row.values.openQuestionId === questionId &&
          row.values.kind === "question" &&
          row.values.businessId === businessId,
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const clock = clocks.find((row) => ["waiting", "armed"].includes(String(row.values.state))) ?? clocks[0];
    const values = question.values;
    return {
      id: question.id,
      step: values.step,
      status: values.status,
      options: values.options,
      readback: values.readback ?? null,
      clock: values.clock ?? null,
      // K-04 open_questions.ask_count: 1 when the commit opens the question.
      askCount: 1,
      version: question.version,
      clockRow:
        clock === undefined
          ? null
          : { id: clock.id, state: clock.values.state, ...dueOf(clock.values), version: clock.version },
    };
  };

  const row = written.rows.get("outbox_rows")?.get(request.outboxRowId);
  if (row?.values.businessId !== request.businessId) {
    return Promise.resolve({ error: "notFound", table: "outbox_rows", rowId: request.outboxRowId });
  }
  const values = row.values;
  if (values.sendClass === "safety") {
    return Promise.resolve({ error: "fixedLineRow", outboxRowId: row.id, sendClass: "safety" });
  }
  const turn = written.turns.get(row.turnId);
  if (turn === undefined) return refused("turn for the row");
  if (values.bookingId !== null) return refused("booking");
  if (values.recipientHandleId !== TEST_OWNER_1.handleId) return refused("other recipient");
  const person = SEEDED.persons.get(String(values.recipientPersonId));
  const business = SEEDED.businesses.get(request.businessId);
  if (person === undefined || business === undefined) return refused("other person or business");
  const questionId = values.openQuestionId;
  const question = typeof questionId === "string" ? questionOf(questionId, request.businessId) : null;
  if (typeof questionId === "string" && question === null) return refused("question for the row");
  const outcomeOf = (eventId: string): WrittenRow | undefined =>
    rowsOf("safety_outcomes").find(
      (outcome) => outcome.values.event_id === eventId && outcome.values.business_id === request.businessId,
    );
  const answer = {
    result: "outboxRow",
    outboxRowId: row.id,
    businessId: request.businessId,
    readAt: utcSeconds(now()),
    row: {
      turnId: row.turnId,
      bundleId: { hash: turn.bundleId.hash, build: turn.bundleId.build },
      state: "planned",
      version: row.version,
      channel: values.channel,
      sendClass: values.sendClass,
      bookingId: null,
      openQuestionId: questionId ?? null,
      copyOfRowId: values.copyOfRowId ?? null,
      hasPlan: false,
      finalParts: null,
    },
    // The step that asks, line 0; a row that asks no question has none.
    line: question === null ? null : { step: question.step, index: 0, from: "openQuestion" },
    recipient: {
      handleId: TEST_OWNER_1.handleId,
      kind: TEST_OWNER_1.handle.kind,
      personId: TEST_OWNER_1.personId,
      name: person.values.name,
      storedLanguage: person.values.language ?? null,
      roles: [],
      phone: null,
    },
    answers: {
      handleId: turn.handleId,
      texts: turn.eventIds.map((eventId) => {
        const outcome = outcomeOf(eventId);
        return {
          eventId,
          outcomes: outcome?.values.outcomes ?? null,
          tenses: outcome?.values.tenses ?? null,
        };
      }),
    },
    slotSource: {
      business: {
        id: request.businessId,
        name: business.values.name,
        displayName: business.values.display_name,
        timeZone: business.values.time_zone,
        version: business.version,
      },
      booking: null,
      question,
    },
    businessSensitive: SEEDED_SENSITIVE.get(request.businessId) ?? null,
    openQuestions: [],
  };
  return Promise.resolve(answer as unknown as OutboxRowRead);
}

// ---- K-05's row calls under finalize's scope, as doubles: the row the commit wrote, and its plan (T-561) ----------

/** The plan and the final parts one row holds, as writePlan wrote them, with the row's version after the write. */
export interface StoredPlan {
  readonly plan: WritePlanRequest["plan"];
  readonly finalParts: WritePlanRequest["finalParts"];
  readonly version: number;
}

export interface FakeFinalizeData {
  /**
   * What the root's real finalize port is fed (RootOptions.finalizeData): the Tool API's business scope and K-05's four
   * row calls over the doubles.
   */
  readonly data: FinalizeData;
  /** Each finalize call's business scope, in order (the Tool API's own: rosie_app on PostgreSQL). */
  readonly scopes: string[];
  /** Every readOutboxRow, in order (each the runtime side's own transaction under the named business). */
  readonly rowReads: ComposeRowRead[];
  /** Every readFixedLineFacts, in order (each the runtime side's own transaction under the named business). */
  readonly factReads: ComposeRowRead[];
  /** Every writePlan request, in order, as finalize sent it (T-196's call: the plan and the final parts together). */
  readonly writes: WritePlanRequest[];
  /** Every cancelClock request, in order (the passed-on path's withdrawal). */
  readonly cancels: CancelClockRequest[];
  /** The plan each row holds, by row id: what a writePlan wrote. */
  readonly plans: ReadonlyMap<string, StoredPlan>;
}

/** K-01's opener (S13-01): a row whose final parts carry it is Rosie's first text to its handle about its business. */
const OPENER = "opener";

/**
 * Finalize's K-05 calls (T-561; @rosie/actions' turn-face/pg/calls.ts pgRowData on PostgreSQL) as doubles over the rows the
 * K-05 commitTurn double wrote (`written`) and test owner 1's seeded rows, each answering as db/repo answers on those rows:
 *
 *   readOutboxRow       as fakeComposeReads' (T-1138, T-1197), the row holding no plan; once writePlan wrote one, the row
 *                       as K-07's checked moves it (state checked, its version raised, hasPlan, its final parts);
 *   readFixedLineFacts  K-05 v1.3 item 36 (T-1138), as fixed-line-facts-s1-02.json: Rosie has texted the handle about the
 *                       row's business only when another of its rows there holds final parts that carry the opener (K-04
 *                       openers_sent's mark, as the double keeps it); the STOP, HELP and rates line was never delivered,
 *                       since test owner 1's seed holds no phone row;
 *   writePlan           K-05 v1 item 2 (T-196, db/repo/outbox.ts; write-plan.json, write-plan-repeat.json): the plan and
 *                       the final parts written together, the row checked and its version raised; alreadyPlanned when the
 *                       row holds a plan (checked before the version), versionChanged, notFound; a plan or final parts
 *                       of another row or channel refused (thrown), nothing written;
 *   cancelClock         K-05 v1 item 5 (cancel-clock.json): the question's clock row cancelled at its next version, as
 *                       K-05 answers it (the double keeps only that version; the question's withdrawal is not kept).
 *
 * The doubles keep what they write beside `written`, never in it, so the commit's rows stay as the commit wrote them.
 * Each call's scope is the Tool API's own, its repo scoped to the call's business.
 */
export function fakeFinalizeData(
  written: Pick<FakeTurnRows, "rows" | "turns">,
  now: () => number = Date.now,
): FakeFinalizeData {
  const scopes: string[] = [];
  const rowReads: ComposeRowRead[] = [];
  const factReads: ComposeRowRead[] = [];
  const writes: WritePlanRequest[] = [];
  const cancels: CancelClockRequest[] = [];
  const plans = new Map<string, StoredPlan>();
  const cancelled = new Map<string, number>();
  const outboxRow = (id: string): WrittenRow | undefined => written.rows.get("outbox_rows")?.get(id);
  const refusedWrite = (what: string): Promise<never> =>
    Promise.reject(new Error(`K-05 v1 refuses the writePlan request: ${what}`));

  const data: FinalizeData = {
    scope: scopeRecordedIn(scopes),
    async readOutboxRow(request) {
      rowReads.push({ outboxRowId: request.outboxRowId, businessId: request.businessId });
      const read = await outboxRowOf(written, request, now);
      const stored = plans.get(request.outboxRowId);
      if ("error" in read || stored === undefined) return read;
      // The row as K-07 moves it at the write: checked, its version raised, holding the plan and its final parts.
      return {
        ...read,
        row: {
          ...read.row,
          state: "checked",
          version: stored.version,
          hasPlan: true,
          finalParts: stored.finalParts,
        },
      };
    },
    readFixedLineFacts(request) {
      factReads.push({ outboxRowId: request.outboxRowId, businessId: request.businessId });
      const row = outboxRow(request.outboxRowId);
      if (row?.values.businessId !== request.businessId) {
        return Promise.resolve({ error: "notFound", table: "outbox_rows", rowId: request.outboxRowId });
      }
      const handleId = row.values.recipientHandleId;
      if (handleId !== TEST_OWNER_1.handleId) {
        return Promise.reject(new Error("the skeleton's readFixedLineFacts double holds no other recipient"));
      }
      const carriesOpener = (id: string): boolean =>
        plans.get(id)?.finalParts.fixedLines.includes(OPENER) ?? false;
      const opened = [...plans.keys()].find((id) => {
        const other = outboxRow(id);
        return (
          id !== row.id &&
          other?.values.recipientHandleId === handleId &&
          other.values.businessId === request.businessId &&
          carriesOpener(id)
        );
      });
      const facts: FixedLineFactsRead & Record<string, unknown> = {
        result: "fixedLineFacts",
        outboxRowId: row.id,
        businessId: request.businessId,
        recipientHandleId: handleId,
        readAt: utcSeconds(now()),
        textedAboutBusiness: opened !== undefined,
        openerRowId: opened ?? (carriesOpener(row.id) ? row.id : null),
        // Test owner 1's seed holds no phone row (T-1148): the line was never delivered to the number.
        optOutLineDeliveredAt: null,
      };
      return Promise.resolve(facts);
    },
    writePlan(request): Promise<WritePlanAnswer> {
      writes.push(structuredClone(request));
      const id = request.outboxRowId;
      const row = outboxRow(id);
      if (row === undefined) return Promise.resolve({ error: "notFound", table: "outbox_rows", rowId: id });
      const stored = plans.get(id);
      // A row that holds a plan keeps it, checked before its version: a repeat writes nothing.
      if (stored !== undefined) {
        return Promise.resolve({ error: "alreadyPlanned", outboxRowId: id, version: stored.version });
      }
      if (row.version !== request.expectVersion) {
        return Promise.resolve({
          error: "versionChanged",
          changed: [
            {
              table: "outbox_rows",
              rowId: id,
              readVersion: request.expectVersion,
              currentVersion: row.version,
            },
          ],
        });
      }
      const { plan, finalParts } = request;
      if (plan.row !== id || finalParts.row !== id)
        return refusedWrite("a plan or final parts of another row");
      const channel = row.values.channel;
      if (plan.channel !== channel || finalParts.channel !== channel) return refusedWrite("another channel");
      if (plan.copyOf !== (row.values.copyOfRowId ?? null)) return refusedWrite("another copyOf");
      const version = row.version + 1;
      plans.set(id, { plan: structuredClone(plan), finalParts: structuredClone(finalParts), version });
      return Promise.resolve({ result: "written", outboxRowId: id, version });
    },
    cancelClock(request): Promise<CancelClockAnswer> {
      cancels.push(structuredClone(request));
      const clock = written.rows.get("clock_rows")?.get(request.clockRowId);
      if (clock === undefined) {
        return Promise.resolve({ error: "notFound", table: "clock_rows", rowId: request.clockRowId });
      }
      const version = cancelled.get(clock.id) ?? clock.version;
      if (version !== request.expectVersion) {
        return Promise.resolve({
          error: "versionChanged",
          changed: [
            {
              table: "clock_rows",
              rowId: clock.id,
              readVersion: request.expectVersion,
              currentVersion: version,
            },
          ],
        });
      }
      cancelled.set(clock.id, version + 1);
      return Promise.resolve({
        result: "cancelled",
        clockRowId: clock.id,
        version: version + 1,
        cancelledAt: request.at,
        repeated: false,
      });
    },
  };
  return { data, scopes, rowReads, factReads, writes, cancels, plans };
}

// ---- @rosie/ai's composer over the recorded-model double (T-560) ----------------------------------------------------

/** One composer recording the double holds: its id, the K-03 v1.1 input it is keyed on, and the plan it answers. */
export interface ComposerRecording {
  readonly id: string;
  readonly input: unknown;
  readonly plan: unknown;
}

/** A composer recording as ai/recordings writes it (T-1175's composer.v1.1.json): its request, and a seed or the plan. */
interface ComposerRecordingSpec {
  readonly id: string;
  readonly kind: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly seed?: { readonly fixture: string };
  readonly output?: unknown;
}

/** The K-03 fixtures a composer recording here may name, by file (the double's own loader reads them from disk). */
const PLAN_FIXTURES: Readonly<Record<string, unknown>> = {
  "input-s1-02-v1.1.json": inputS102V11,
  "plan-s1-02.json": planS102,
};

/** ai/recordings' composer inputs a recording may name, by path (recording 4's: the JOIN run's S1-02 row). */
const COMPOSER_INPUT_FILES: Readonly<Record<string, unknown>> = {
  "composer-inputs/join-s1-02.json": joinComposeInputJson,
};

function composerFile(files: Readonly<Record<string, unknown>>, file: string): unknown {
  const value = files[file];
  if (value === undefined) throw new Error(`the composer double is given no ${file}`);
  return structuredClone(value);
}

/**
 * The double's composer recordings on K-03 v1.1 (ai/recordings/composer.v1.1.json; T-1175, DL-355), keyed as its loader
 * keys them (the sha256 of the input's canonical JSON), never copied: composer-s1-02-v1.1 on input-s1-02-v1.1.json, and
 * recording 4, composer-join-s1-02, on the JOIN run's own S1-02 row (composer-inputs/join-s1-02.json: its turn id T-248's
 * hash of evt-sam-0000, its row that turn's, replying to the text JOIN at its time), each seeded from plan-s1-02.json.
 */
function shippedComposerRecordings(): ComposerRecording[] {
  const file = composerRecordingsV11 as unknown as { readonly recordings: readonly ComposerRecordingSpec[] };
  return file.recordings.map((spec) => {
    const { request } = spec;
    const named = Object.keys(request).length === 1;
    const input =
      named && typeof request.fixture === "string"
        ? composerFile(PLAN_FIXTURES, request.fixture)
        : named && typeof request.file === "string"
          ? composerFile(COMPOSER_INPUT_FILES, request.file)
          : structuredClone(request);
    const plan =
      spec.seed === undefined ? structuredClone(spec.output) : composerFile(PLAN_FIXTURES, spec.seed.fixture);
    return { id: spec.id, input, plan };
  });
}

/** One Messages API call the composer double answered: the model asked, and the recording it was answered from. */
export interface ComposerModelCall {
  readonly model: string;
  readonly recording: string;
}

export interface FakeComposerModels {
  /**
   * What the root's real composer port is fed (RootOptions.composers): @rosie/ai's composer (T-373 createComposer, with
   * T-374's rewrite) for each bundle the double holds, calling a fake Messages API answered by the recorded-model double.
   */
  readonly composers: Composers;
  /** Each input a composer was given, in order: what its call is keyed on. */
  readonly inputs: unknown[];
  /** Each rewrite a composer was asked, in order. */
  readonly rewrites: unknown[];
  /** Every Messages API call the double answered, in order. */
  readonly calls: ComposerModelCall[];
  /** Every request the double holds no recording for, with what differs from the nearest recording's input. */
  readonly misses: string[];
  /** Every bundle a composer was asked for (`<hash>/<build>`), in order: the port's one composer per bundle. */
  readonly asked: string[];
  /** While true, every call answers 529 (overloaded) before any recording is read: the models are down. */
  down: boolean;
  /** Keeps a text the Linq double signed this run: its words and send time, for `recordTurn`. */
  saw(event: LinqInboundEvent): void;
  /**
   * Records the plan for the S1-02 row of a turn over these texts (in arrival order), as recording 4 holds the JOIN run's:
   * its input is recording 4's with the turn's own id (T-248's hash of the event ids), that turn's row (K-09 v1.5 default
   * 131) and, as its inbound, the words and send time of the turn's last text as the Linq double signed it; its answer
   * plan-s1-02.json's. It may be called before the texts are sent: the recording is made at the first composer request
   * after they are all signed.
   */
  recordTurn(eventIds: readonly string[]): void;
  /** Holds one more recording: a test's own input and the plan it answers. */
  hold(recording: ComposerRecording): void;
}

/** A composer request's per-turn part: the row's tagged input (compose) or the rewrite's (T-364's layout), as sent. */
function turnTextOf(body: Record<string, unknown>): string {
  const messages = body.messages;
  const first: unknown = Array.isArray(messages) ? (messages as unknown[])[0] : undefined;
  return isRecord(first) && typeof first.content === "string" ? first.content : "";
}

/**
 * @rosie/ai's composer for each bundle (T-373's call, T-374's one rewrite and T-375's reader checks: the real composer,
 * its prompt layout and the AI gateway), over K-01's manifests (bundle v0 as bundles/v0 publishes it, with its composer
 * prompt), calling a fake Messages API whose every answer comes from the recorded-model double (T-004's
 * createRecordedComposer), keyed as its loader keys a composer recording: the input's canonical JSON. It holds
 * ai/recordings' composer.v1.1.json recordings as they are (recording 4 is the JOIN run's S1-02 row, keyed on the ids the
 * runtime produces; DL-347) and what a test records. A call is answered only when its user message is exactly the tagged
 * input (ai/src/composer/prompt composeInputText) of an input a composer was given and is composing now, so the wire
 * request is that input's; a request with no recording is a miss: kept, with what differs, and answered 404, so the call
 * fails loudly, never with a made-up plan. The double holds no rewrite recordings (T-374's handoff 3; T-1071), so a
 * rewrite's call is a miss. `log` gets "compose:<row>" and "rewrite:<row>" as the stand-in composer logged them. The key
 * is made up for each run, never Anthropic's.
 */
export function fakeComposerModels(log: string[] = []): FakeComposerModels {
  const held = new Map<string, { output: unknown }>();
  const ids = new Map<string, string>();
  const recordings: ComposerRecording[] = [];
  const recorded = createRecordedComposer(held);
  const env = { [KEY_VARIABLE]: `made-up-${crypto.randomUUID()}` };
  const signed = new Map<string, { words: string; sentAt: string }>();
  // The turns a test recorded whose plans are not held yet (`recordTurn`): each one's event ids, in arrival order.
  const turns: string[][] = [];
  // The inputs being composed now, by the tagged text their call sends.
  const composing = new Map<string, AiComposeInput>();
  let bundles: ReadonlyMap<string, DecideBundle> | null = null;

  const hold = (recording: ComposerRecording): void => {
    const key = requestKey(COMPOSER_KIND, recording.input);
    const known = ids.get(key);
    if (known !== undefined) {
      if (canonicalJson(held.get(key)?.output) !== canonicalJson(recording.plan))
        throw new Error(`${recording.id} is keyed on ${known}'s input with another plan`);
      return;
    }
    held.set(key, { output: structuredClone(recording.plan) });
    ids.set(key, recording.id);
    recordings.push(recording);
  };
  for (const recording of shippedComposerRecordings()) hold(recording);

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

  /** What differs between an input and the nearest recording's, for a miss's message: field names and places only. */
  const nearest = (input: unknown): string => {
    let best: { id: string; paths: string[] } | null = null;
    for (const recording of recordings) {
      const paths = differingPaths(input, recording.input);
      if (best === null || paths.length < best.paths.length) best = { id: recording.id, paths };
    }
    return best === null ? "no recording" : `${best.id} differs at ${best.paths.join(", ")}`;
  };

  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as Record<string, unknown>;
    const model = typeof body.model === "string" ? body.model : "";
    if (models.down) return failed(529, "overloaded_error");
    const input = composing.get(turnTextOf(body));
    if (input === undefined) {
      return miss(
        "a composer request whose message is no input being composed (a rewrite: the double holds no rewrite recordings, T-1071)",
      );
    }
    await recordTurns();
    let plan: unknown;
    try {
      plan = await recorded.composer(input as unknown as Parameters<typeof recorded.composer>[0]);
    } catch (error) {
      if (error instanceof NoRecordingError)
        return miss(`no plan is recorded for the input: ${nearest(input)}`);
      throw error;
    }
    models.calls.push({ model, recording: ids.get(requestKey(COMPOSER_KIND, input)) ?? "" });
    return answered(plan);
  };

  /** The composer, its calls watched only to know which input each request is for; nothing it is sent changes. */
  const watched = (composer: Composer): Composer =>
    Object.freeze({
      async compose(input, options) {
        models.inputs.push(structuredClone(input));
        log.push(`compose:${String((input as { row?: unknown }).row)}`);
        let text: string | null = null;
        try {
          text = composeInputText(input);
        } catch {
          // An input the composer cannot lay out: it refuses it before any call, so no request is answered for it.
        }
        if (text !== null) composing.set(text, input);
        try {
          return await composer.compose(input, options);
        } finally {
          if (text !== null) composing.delete(text);
        }
      },
      rewrite(request, options) {
        models.rewrites.push(structuredClone(request));
        log.push(`rewrite:${String((request.input as { row?: unknown }).row)}`);
        return composer.rewrite(request, options);
      },
    } satisfies Composer);

  const models: FakeComposerModels = {
    inputs: [],
    rewrites: [],
    calls: [],
    misses: [],
    asked: [],
    down: false,
    composers(bundleId) {
      const key = bundleTextOf(bundleId);
      models.asked.push(key);
      bundles ??= decideBundles();
      const bundle = bundles.get(key);
      if (bundle === undefined) throw new Error(`the composer double holds no bundle ${key}`);
      const composer = createComposer({
        bundle: { bundleId: bundle.routing.bundleId, models: bundle.routing.models },
        prompts: createPromptCache(bundle.cache),
        env,
        fetch,
      });
      return watched(composer);
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

  /** Each turn a test recorded, its texts all signed by now, held as its S1-02 row's plan (`recordTurn`), one at a time. */
  let recording: Promise<void> = Promise.resolve();
  const recordTurns = (): Promise<void> => {
    recording = recording.catch(() => undefined).then(holdRecordedTurns);
    return recording;
  };
  const holdRecordedTurns = async (): Promise<void> => {
    const base = structuredClone(joinComposeInputJson);
    const zone = base.inbound.sentAt.zone;
    for (const eventIds of turns.splice(0)) {
      const texts = eventIds.flatMap((eventId) => {
        const text = signed.get(eventId);
        return text === undefined ? [] : [text];
      });
      const last = texts.at(-1);
      if (last === undefined || texts.length < eventIds.length) {
        turns.push(eventIds);
        continue;
      }
      const turnId = await turnIdOf(eventIds);
      const input = {
        ...base,
        row: `outbox-s1-02-${turnId}-1`,
        turn: turnId,
        inbound: { text: last.words, sentAt: { utc: last.sentAt, zone } },
      };
      hold({ id: `turn-${turnId}-compose`, input, plan: structuredClone(planS102) });
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
  | "linqVerify"
  | "sealing"
  | "safetyRead"
  | "turnRow"
  | "bundles"
  | "targets"
  | "frontier"
  | "decide"
  | "gate"
  | "composeInput"
  | "composer"
  | "finalize";

export interface SkeletonFakes {
  /**
   * The fake set the test environment binds: every port but the joined ones, the Linq verify, the sealing, the safety
   * read, the turn-row calls, the bundle reads, the targets read, the frontier, decide, the gate, compose input, the
   * composer and finalize, which the root builds (./real.ts).
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
   * A turn its `recordTurn` records is recorded for the composer too (`composer.recordTurn`), so it goes on to its reply.
   */
  readonly decide: FakeDecideModels;
  /**
   * The gate's reads as doubles over test owner 1's seeded rows and what the K-05 commitTurn double wrote, for the root's
   * real gate port (RootOptions.gateReads: `gate.reads`): each call's scope and every read it made. Its one commit goes
   * through the turn-row port, to `turnRows`, which keeps every row it wrote.
   */
  readonly gate: FakeGateReads;
  /**
   * Compose input's reads as doubles over what the K-05 commitTurn double wrote and test owner 1's seeded rows, for the
   * root's real compose-input port (RootOptions.composeReads: `compose.reads`): each call's scope and every row read.
   */
  readonly compose: FakeComposeReads;
  /**
   * @rosie/ai's composer over the recorded-model double, for the root's real composer port (RootOptions.composers:
   * `composer.composers`): each input it was given, each rewrite, each model call it answered and each miss.
   */
  readonly composer: FakeComposerModels;
  /**
   * Finalize's reads and writes as doubles over what the K-05 commitTurn double wrote and test owner 1's seeded rows, for
   * the root's real finalize port (RootOptions.finalizeData: `finalize.data`): each call's scope, every read, every
   * writePlan and the plan each row holds.
   */
  readonly finalize: FakeFinalizeData;
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
  const gate = fakeGateReads(turnRows);
  const core = fakeCore(clock);
  const direct = fakeDirect(clock);
  // Read when each call is made: the turn's commit records what `known` set by then.
  const answers: Record<string, SafetyResult> = {};

  const face = fakeTurnFace();
  const decide = fakeDecideModels(face.log);
  // Compose input and the composer are joined (T-560): their doubles log to the face's log as the stand-ins did.
  const compose = fakeComposeReads(turnRows, () => clock.now(), face.log);
  const composer = fakeComposerModels(face.log);
  // Finalize is joined (T-561): its K-05 doubles read the rows the commit wrote and keep the plan each row is given.
  const finalize = fakeFinalizeData(turnRows, () => clock.now());
  // A turn a test records for decide goes the JOIN run's way to its reply: its two reads as recording 2 holds the JOIN
  // run's, so it commits S1-01 and S1-02's row, and that row's plan as recording 4 holds the JOIN run's.
  const recordReads = decide.recordTurn.bind(decide);
  decide.recordTurn = (eventIds) => {
    recordReads(eventIds);
    composer.recordTurn(eventIds);
  };
  const rows = fakeRows(face.log);
  // The turn's rows with no plan yet (K-05 unplannedRows): the outbox rows the K-05 double's commit wrote for that turn
  // (the joined gate's, T-559), each as committed, in commit order.
  rows.unplanned = (turnId) => ({
    result: "rows",
    rows: [...(turnRows.rows.get("outbox_rows")?.values() ?? [])]
      .filter((row) => row.turnId === turnId)
      .map((row) =>
        unplannedRow(
          row.id,
          Number(row.values.commitSeq),
          String(row.values.recipientHandleId),
          row.values.channel as Parameters<typeof unplannedRow>[3],
        ),
      ),
  });
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
      safetyCore: core,
    },
    dataAccess: { rows: rowsOf(rows), outbox: store, clocks: arming.data.data },
    linqSend: { parts: linq, direct },
  };

  return {
    ports,
    clock,
    linqInputs,
    webhooks,
    sign: (event, partKey = null) => {
      // The text's words and send time, for a turn over it that a test records with decide's and the composer's doubles.
      decide.saw(event);
      composer.saw(event);
      return webhooks.sign({ event: { ...event, receivedAt: utcSeconds(clock.now()) }, partKey });
    },
    handleKeys,
    models,
    turnRows,
    bundleReads,
    handleTargets,
    frontier,
    decide,
    gate,
    compose,
    composer,
    finalize,
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
