// T-1401 (the D-017 path audit's P5): staging binds the send, all or nothing (./send.ts), inside the Workers runtime on
// T-1253's rig (infra/test-rig/files.mjs, key SEND): this file's own database, migrated, with bundle v0 published and
// active and the walking skeleton's turn 1 committed and planned (./send.seed.ts), reached through its own pool pair
// only, HYPERDRIVE_JOB_SEND and HYPERDRIVE_APP_SEND, handed in as the env's HYPERDRIVE_JOB and HYPERDRIVE_APP behind
// doubles that count each read of a connection string (ADR-014 section 4). The env's TEST_PHONE_LINE is the pool's own
// (wrangler.jsonc env.staging: the TestPhoneLine the Worker's main module exports, T-1238's capped line).
//
// Each root here is composed for staging as ../state-reads.worker.test.ts composes one: every other input on its double
// (../test-support.ts skeletonFakes), and the send's four inputs as stagingOptions(env) gives them through its two
// seams: its handle (./part.ts stagingDb), so a test reads T-1254's counts and each call's timing line, and its
// builders, every part but this card's stood in by its nothing-bound answer (DL-776), so a test sees this card's
// binding alone whatever the other parts bind. Its HandleActor namespace is a double that records each actor named and
// told, and its clock stands at the JOIN's commit (2:05pm in New York, inside the barbershop's text hours). Every
// database read a test makes of its own goes through T-1254's handle too.
//
//   - all or nothing: for each env (both bindings there; no HYPERDRIVE_JOB; no TEST_PHONE_LINE; production's) the four
//     inputs are all bound or all null, never outboxCalls without armingCalls; as the root is built the part reads
//     ENVIRONMENT, then HYPERDRIVE_JOB's presence, and only when it is there TEST_PHONE_LINE's, and no connection string;
//   - nothing claimed: with no HYPERDRIVE_JOB, with no TEST_PHONE_LINE and with the two bindings crossed (the guard's
//     refusal), a wake for handle-sam claims nothing (no row, version, part or claim row changes) and nothing reaches the
//     line; a danger line's safety run whose calls hold no claimOutboxV114 is refused before any call;
//   - the danger line: with claimOutboxV114 bound, a safety run claims the recipient's safety row through it, on the
//     rows claim-safety-past-routine-live-claim.json's note lists, and sends it; the JOIN's row is not read;
//   - the send: the dispatcher's wake for handle-sam claims outbox-s1-02-sam-1 once and reads its send state (the chat
//     open, Linq's chat id: send-state-customer.json's shape); its one part reaches the test-phone line under its key,
//     once; the row and the part are sent in PostgreSQL with the line's message id; a second wake claims nothing;
//   - a receipt not marked: with no HYPERDRIVE_JOB, with no TEST_PHONE_LINE and with the bindings crossed, the receipt
//     door rejects a delivered event for the sent part, so the gateway answers 503, and no part is marked;
//   - the receipt: Root.gateway.receipts.accept with a K-06 delivered event for that part answers written; the part and
//     the row are delivered; S1-02's clock row is armed once, due 8pm the day after delivery in America/New_York, its
//     question open; the actor double is told for Sam's actor; the same receipt again, and again in another isolate,
//     answers duplicate with no second arming;
//   - the arming's reads by direct call: questionFacts as read-question-facts-s1-02.json, read-question-facts-a7-03.json
//     (the visit's addressZone and address null) and read-question-facts-unknown.json (the port's NotFoundError);
//     actorNameOf as the gateway's actorNameOf of read-handle-sam.json's handle, and null for read-handle-unknown.json's
//     id, for which no actor is told while the arming still arms;
//   - production: the builder reads no binding (a counting double: 0 reads), and the four ports stay closed;
//   - HYPERDRIVE_APP is read 0 times throughout, opened equals ended after every test, and no span or log line holds the
//     number in any form, the chat id, a part's words or a connection string.
// The tests run in the file's order: what the wake sends, the receipt marks.
// Test values only (rule 9): the contracts' fixtures, the master's sample cast and the fiction range's numbers.
import readHandleSam from "@rosie/contracts/data-access/fixtures/read-handle-sam.json";
import readHandleUnknown from "@rosie/contracts/data-access/fixtures/read-handle-unknown.json";
import readQuestionFactsA703 from "@rosie/contracts/data-access/fixtures/read-question-facts-a7-03.json";
import readQuestionFactsS102 from "@rosie/contracts/data-access/fixtures/read-question-facts-s1-02.json";
import readQuestionFactsUnknown from "@rosie/contracts/data-access/fixtures/read-question-facts-unknown.json";
import sendStateCustomer from "@rosie/contracts/data-access/fixtures/send-state-customer.json";
import deliveredFixture from "@rosie/contracts/inbound-event/fixtures/delivered.json";
import { env as poolEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

import bundleV0Kv from "../../../../bundles/v0/bundle.kv.json";
import { armAtDelivery, ArmingMemory } from "../../clocks/arming";
import { dueOf } from "../../clocks/due";
import { actorNameOf, handleLinqWebhook } from "../../gateway";
import type { ActorHandoff, GatewayDeps } from "../../gateway/types";
import { openTrace, type BundleId, type Span, type TraceContext } from "../../trace";
import { leaks, spansOfLogLines } from "../../trace/hop-check";
import {
  composeRoot,
  NoDatabaseError,
  NotJoinedError,
  testPhoneLineOf,
  workerRoot,
  type HandleActors,
  type PortName,
  type Root,
  type RootClock,
} from "../index";
import { SendClassNotCarriedError, type ArmingCalls } from "../real";
import { skeletonFakes } from "../test-support";
import { dbHandle, DbGuardRefusal } from "./db";
import { NO_RECEIPT_INPUTS } from "./k05-receipt";
import { NO_TURN_CALL_INPUTS } from "./k05-turn";
import { NO_MODEL_READER_INPUTS } from "./models";
import { stagingOptions, type StagingBuilders, type StagingInputs } from "./options";
import { stagingDb, type DbCallLine, type StagingDb, type StagingEnv } from "./part";
import { NO_SEND_INPUTS, stagingSendCalls, type SendInputs } from "./send";
import { A7_03, DANGER_LINE, DANGER_LINE_TEXT, JOIN, JOIN_REPLY_TEXT, SAM_THREAD } from "./send.seed";
import { NO_DIRECTORY_INPUTS } from "./state-reads";
import { NO_ROW_INPUTS } from "./tool-api-rows";

/** This file's key in the rig's list (infra/test-rig/files.mjs). */
const KEY = "SEND";
const JOB = `HYPERDRIVE_JOB_${KEY}`;
const APP = `HYPERDRIVE_APP_${KEY}`;

/** The pool's bindings, by name: the Hyperdrive ones, and staging's test-phone line. */
const pool = poolEnv as unknown as Readonly<Record<string, Hyperdrive | undefined>>;
const POOL_LINE = poolEnv.TEST_PHONE_LINE;

function poolBinding(name: string): Hyperdrive {
  const found = pool[name];
  if (found === undefined) throw new Error(`the pool has no Hyperdrive binding ${name}`);
  return found;
}

const DATABASE = inject("rosieRigDatabases")?.[KEY];

// ---- bundle v0, test owner 1 and the times --------------------------------------------------------------------------

const MANIFEST_KEY = bundleV0Kv.find((part) => part.key.endsWith("/manifest"))?.key ?? "";
const [, V0_HASH = "", V0_BUILD = ""] = MANIFEST_KEY.split("/");
/** Bundle v0's id, read from its manifest's key (K-01 v1: bundle/<hash>/<build>/manifest). */
const V0: BundleId = { hash: V0_HASH, build: Number(V0_BUILD) };

/** tp-01's fictional number, in each form a number could leak in, and Sam's actor as the gateway names it. */
const SAM_NUMBER = "+15555550100";
const NUMBER_FORMS = [SAM_NUMBER, "15555550100", "5555550100", "555-0100"];
const SAM_ACTOR = actorNameOf({ kind: "phone", address: SAM_NUMBER });
/** Linq's chat id for Sam's chat, as S1-01's thread holds it. */
const SAM_CHAT = SAM_THREAD.linq_chat_id;

/** Lee's Barbershop's zone (K-04 seed-business-head.json businesses.time_zone). */
const BARBERSHOP_ZONE = "America/New_York";

/** Trace ids of K-08's form, made up. */
const RECEIPT_TRACE = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";

const UTC_TEXT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]+)?Z$/u;

/** The root's clock, standing at the JOIN's commit: inside the barbershop's text hours, so limit 8 holds nothing. */
const COMMIT_CLOCK: RootClock = {
  now: () => Date.parse(JOIN.committedAt),
  after: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
};

// ---- what the whole file captures: every span and every log line ------------------------------------------------------

/** Every span a test's own trace wrote, and every line written to the console or as a call's timing, across the file. */
const SPANS: Span[] = [];
const LOGGED: string[] = [];
/** The lines of the test that is running. */
let testLog: string[] = [];

/** Every unhandled rejection this isolate reports while this file runs. */
const rejections: unknown[] = [];
addEventListener("unhandledrejection", (event) => {
  rejections.push(event.reason);
});

// ---- the env a root is built over -------------------------------------------------------------------------------------

/** A double over a pool binding that counts the reads of its connection string, and gives the pool binding's. */
interface CountedBinding {
  readonly binding: { readonly connectionString: string };
  readonly reads: { n: number };
}

function counted(binding: Hyperdrive): CountedBinding {
  const reads = { n: 0 };
  return {
    binding: {
      get connectionString(): string {
        reads.n += 1;
        return binding.connectionString;
      },
    },
    reads,
  };
}

interface TestEnv {
  readonly env: StagingEnv;
  /** Every name read from the env, by a get or by an `in`, in order. */
  readonly names: string[];
  /** The counting double handed in as HYPERDRIVE_JOB; null where the env has none. */
  readonly job: CountedBinding | null;
  /** The counting double handed in as HYPERDRIVE_APP, in every env. */
  readonly app: CountedBinding;
}

interface EnvOptions {
  readonly environment?: string;
  /** The pool binding handed in as HYPERDRIVE_JOB (default: this file's own); null for none. */
  readonly job?: string | null;
  /** False: the env binds no TEST_PHONE_LINE (default: the pool's own). */
  readonly line?: boolean;
}

/** Every env a test built and every handle: checked after each test. */
const ENVS: TestEnv[] = [];
const HANDLES: StagingDb[] = [];

/** The Worker's env as wrangler.jsonc's vars give it, with this file's pair behind counting doubles and the pool's line. */
function envOf(options: EnvOptions = {}): TestEnv {
  const names: string[] = [];
  const jobName = options.job === undefined ? JOB : options.job;
  const job = jobName === null ? null : counted(poolBinding(jobName));
  const app = counted(poolBinding(APP));
  const values: Record<string, unknown> = {
    ENVIRONMENT: options.environment ?? "staging",
    BASE_PATH: "/test",
    DB_SCHEMA: "",
    GIT_SHA: "test-sha",
    ...(job === null ? {} : { HYPERDRIVE_JOB: job.binding }),
    HYPERDRIVE_APP: app.binding,
    ...(options.line === false ? {} : { TEST_PHONE_LINE: POOL_LINE }),
  };
  const env = new Proxy(values, {
    get(target, name, receiver): unknown {
      if (typeof name === "string") names.push(name);
      return Reflect.get(target, name, receiver);
    },
    has(target, name): boolean {
      if (typeof name === "string") names.push(name);
      return Reflect.has(target, name);
    },
  });
  const made: TestEnv = { env: env as unknown as StagingEnv, names, job, app };
  ENVS.push(made);
  return made;
}

/** The three envs in which the send cannot go: the four inputs null (no binding), or bound to the wrong login. */
const FAILING_ENVS: readonly {
  readonly name: string;
  readonly options: EnvOptions;
  readonly bound: boolean;
}[] = [
  { name: "HYPERDRIVE_JOB not bound", options: { job: null }, bound: false },
  { name: "TEST_PHONE_LINE not bound", options: { line: false }, bound: false },
  {
    name: "the two bindings crossed (HYPERDRIVE_JOB holding the Tool API's login)",
    options: { job: APP },
    bound: true,
  },
];

/**
 * Every part but this card's, stood in by its nothing-bound answer (each stub's own, as T-1257 made it), so a root built
 * with these shows this card's binding alone, whatever the other parts bind once their cards land (DL-776).
 */
const EVERY_OTHER_PART_UNBOUND: Partial<StagingBuilders> = {
  receipt: () => NO_RECEIPT_INPUTS,
  turn: () => NO_TURN_CALL_INPUTS,
  models: () => NO_MODEL_READER_INPUTS,
  bundleSafety: () => null,
  gate: () => null,
  rows: () => NO_ROW_INPUTS,
  directories: () => NO_DIRECTORY_INPUTS,
  flags: () => null,
  testPhone: () => null,
  copies: () => null,
};

/** The four inputs this card binds, as stagingOptions gave them. */
function sendInputsOf(inputs: StagingInputs): SendInputs {
  return {
    outboxCalls: inputs.outboxCalls,
    sendStateCall: inputs.sendStateCall,
    linqSendCall: inputs.linqSendCall,
    armingCalls: inputs.armingCalls,
  };
}

/** Whether each of the four is bound, in SendInputs' order. */
const boundOf = (inputs: SendInputs): boolean[] =>
  [inputs.outboxCalls, inputs.sendStateCall, inputs.linqSendCall, inputs.armingCalls].map(
    (input) => input !== null,
  );

// ---- the HandleActor namespace double --------------------------------------------------------------------------------

interface ActorsDouble {
  readonly actors: HandleActors<string>;
  /** Each actor named (idFromName), in order. */
  readonly named: string[];
  /** Each actor told of a newly armed row (syncClocks), as [the actor's name, the handle's id], in order. */
  readonly told: (readonly [string, string])[];
}

/** A HandleActor namespace that records each actor named and told, and reaches no Durable Object. */
function actorsDouble(): ActorsDouble {
  const named: string[] = [];
  const told: (readonly [string, string])[] = [];
  return {
    named,
    told,
    actors: {
      idFromName(name) {
        named.push(name);
        return name;
      },
      get: (name) => ({
        accept: () => Promise.reject(new Error("no text reaches an actor here")),
        fireClockRow: () => Promise.reject(new Error("no clock row fires here")),
        syncClocks(handleId) {
          told.push([name, handleId]);
          return Promise.resolve([]);
        },
      }),
    },
  };
}

// ---- the root ---------------------------------------------------------------------------------------------------------

interface Rooted {
  readonly root: Root;
  /** The root's one handle (T-1254's, through ./part.ts): its counts are the root's. */
  readonly db: StagingDb;
  /** The four inputs stagingOptions gave the root. */
  readonly inputs: SendInputs;
  readonly actors: ActorsDouble;
  /** The call of each timing line the handle wrote, in order. */
  readonly calls: () => (string | null)[];
  /** Each timing line the handle wrote, in order. */
  readonly lines: () => DbCallLine[];
}

/**
 * A root composed for staging over the test's env: every other input on its double, the send's four as stagingOptions
 * gives them with every other part unbound (or as `feed` changes them), a HandleActor namespace double and the clock at
 * the JOIN's commit.
 */
function rootOver(testEnv: TestEnv, feed: (inputs: SendInputs) => SendInputs = (inputs) => inputs): Rooted {
  const written: string[] = [];
  const db = stagingDb(testEnv.env, {
    write: (line) => {
      written.push(line);
      LOGGED.push(line);
    },
  });
  HANDLES.push(db);
  const inputs = feed(sendInputsOf(stagingOptions(testEnv.env, { db, builders: EVERY_OTHER_PART_UNBOUND })));
  const fakes = skeletonFakes();
  const actors = actorsDouble();
  const root = composeRoot({
    environment: "staging",
    actors: actors.actors,
    vars: { ENVIRONMENT: "staging", GIT_SHA: "test-sha" },
    clock: COMMIT_CLOCK,
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
    retryQueue: fakes.retryQueue,
    bundleSafety: null,
    handleDirectory: null,
    stoppedFlags: null,
    turnDirectory: null,
    planCalls: null,
    // This card's four, all or nothing.
    ...inputs,
  });
  const lines = (): DbCallLine[] => written.map((line) => JSON.parse(line) as DbCallLine);
  return { root, db, inputs, actors, calls: () => lines().map((line) => line.call), lines };
}

/** A trace of the test's own, as a turn's: its spans are kept. */
function testTrace(spans: Span[] = []): TraceContext {
  return openTrace({
    openedBy: "textWebhook",
    bundleId: V0,
    sink: (span) => {
      spans.push(span);
      SPANS.push(span);
    },
  });
}

/** The dispatcher's wake for Sam's handle, as turn 1's commit makes it. */
function wakeSam(root: Root, spans: Span[] = []): Promise<void> {
  return root.dispatcher.wake(
    { turnId: JOIN.turnId, handleId: JOIN.handleId, outboxRowIds: [JOIN.row] },
    testTrace(spans),
  );
}

/** The danger line's own wake for Sam's handle, as the safety read's sendDanger makes it. */
function wakeSafety(root: Root): Promise<void> {
  const wake = root.safety.wakeSafety;
  if (wake === undefined) throw new Error("the root joined no safety wake");
  return wake({ handleId: JOIN.handleId, outboxRowIds: [DANGER_LINE.row] });
}

// ---- what PostgreSQL holds ---------------------------------------------------------------------------------------------

interface StoredRow {
  readonly id: string;
  readonly state: string;
  readonly version: number;
}
interface StoredPart {
  readonly key: string;
  readonly state: string;
  readonly messageId: string | null;
  readonly attempts: number;
  readonly deliveredAt: string | null;
}
interface StoredClaim {
  readonly row: string;
  readonly claimer: string;
  readonly claimNo: number;
}
interface StoredClock {
  readonly id: string;
  readonly state: string;
  readonly version: number;
  readonly dueAt: string | null;
  readonly dueZone: string | null;
  readonly armedAt: string | null;
}
interface StoredQuestion {
  readonly id: string;
  readonly status: string;
  readonly version: number;
}

/** Every outbox row, part try and claim, and every clock row and open question, as this file's database holds them. */
interface Stored {
  readonly rows: readonly StoredRow[];
  readonly parts: readonly StoredPart[];
  readonly claims: readonly StoredClaim[];
  readonly clocks: readonly StoredClock[];
  readonly questions: readonly StoredQuestion[];
}

const utcOrNull = (at: Date | null): string | null => (at === null ? null : at.toISOString());

/**
 * What this file's database holds, read on the runtime side through a handle of its own (rosie_job with no business
 * scope sees every business's rows).
 */
async function stored(): Promise<Stored> {
  const handle = dbHandle({ ENVIRONMENT: "staging", DB_SCHEMA: "", HYPERDRIVE_JOB: poolBinding(JOB) });
  const read = await handle.runtime("stored", async (sql) => {
    const rows = await sql<StoredRow[]>`select id, state, version from outbox_rows order by commit_seq`;
    const parts = await sql<
      { key: string; state: string; message_id: string | null; attempts: number; delivered_at: Date | null }[]
    >`select idempotency_key as key, state, linq_message_id as message_id, attempts, delivered_at
        from outbox_parts order by idempotency_key`;
    const claims = await sql<{ row: string; claimer: string; claim_no: number }[]>`
      select outbox_row_id as row, claimer, claim_no from outbox_claims order by outbox_row_id`;
    const clocks = await sql<
      {
        id: string;
        state: string;
        version: number;
        due_at: Date | null;
        due_zone: string | null;
        armed_at: Date | null;
      }[]
    >`select id, state, version, due_at, due_zone, armed_at from clock_rows order by id`;
    const questions = await sql<StoredQuestion[]>`select id, status, version from open_questions order by id`;
    return {
      rows: rows.map((row) => ({ id: row.id, state: row.state, version: row.version })),
      parts: parts.map((part) => ({
        key: part.key,
        state: part.state,
        messageId: part.message_id,
        attempts: part.attempts,
        deliveredAt: utcOrNull(part.delivered_at),
      })),
      claims: claims.map((claim) => ({ row: claim.row, claimer: claim.claimer, claimNo: claim.claim_no })),
      clocks: clocks.map((clock) => ({
        id: clock.id,
        state: clock.state,
        version: clock.version,
        dueAt: utcOrNull(clock.due_at),
        dueZone: clock.due_zone,
        armedAt: utcOrNull(clock.armed_at),
      })),
      questions: questions.map((question) => ({
        id: question.id,
        status: question.status,
        version: question.version,
      })),
    };
  });
  expect(handle.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0 });
  return read;
}

const rowOf = (held: Stored, id: string): StoredRow | undefined => held.rows.find((row) => row.id === id);
const partOf = (held: Stored, key: string): StoredPart | undefined =>
  held.parts.find((part) => part.key === key);
const clockOf = (held: Stored, id: string): StoredClock | undefined =>
  held.clocks.find((clock) => clock.id === id);
const questionOf = (held: Stored, id: string): StoredQuestion | undefined =>
  held.questions.find((question) => question.id === id);

// ---- the test-phone line ---------------------------------------------------------------------------------------------

/** The parts the pool's test-phone line holds to Sam's number, in the order they were sent. */
async function lineParts(): Promise<
  { readonly key: string | null; readonly to: string; readonly text: unknown; readonly outcome: unknown }[]
> {
  if (POOL_LINE === undefined) throw new Error("the pool's staging environment binds TEST_PHONE_LINE");
  const parts = await testPhoneLineOf(POOL_LINE).partsTo(SAM_NUMBER);
  return parts.map((part) => {
    const sent = part.sent as unknown as Record<string, unknown>;
    return {
      key: typeof sent.idempotencyKey === "string" ? sent.idempotencyKey : null,
      to: String(sent.to),
      text: sent.text,
      outcome: part.outcome,
    };
  });
}

// ---- the receipt -------------------------------------------------------------------------------------------------------

/** An instant to the whole second K-06 writes, never before `at`. */
const wholeSecondAfter = (at: string): string =>
  new Date(Math.ceil(Date.parse(at) / 1000) * 1000).toISOString().replace(/[.][0-9]{3}Z$/u, "Z");

/**
 * Linq's delivery receipt for the JOIN's part as the gateway hands it to the receipt door: K-06 delivered.json's form,
 * from Sam's number on his chat, naming the line's message id, with the part's key beside it (K-11 partKey).
 */
function receiptOf(messageId: string, at: string, eventId: string): ActorHandoff {
  return {
    event: {
      ...structuredClone(deliveredFixture),
      eventId,
      handle: { kind: "phone", address: SAM_NUMBER },
      chatId: SAM_CHAT,
      receivedAt: at,
      status: { messageId, at, failure: null },
      traceId: RECEIPT_TRACE,
    },
    partKey: JOIN.partKey,
    traceId: RECEIPT_TRACE,
    bundleId: V0,
  };
}

/**
 * The gateway's own answer to that receipt (../../gateway/linq-webhook.ts handleLinqWebhook over the root's gateway
 * doors), its verify stood in by one that hands the event over: a signed receipt cannot be parsed on staging until CHAT
 * binds linq.chatHandle (CQ-61), and the verify is not this card's.
 */
async function gatewayStatus(root: Root, handoff: ActorHandoff): Promise<number> {
  const verify: GatewayDeps["linq"] = {
    verifyWebhook: () =>
      Promise.resolve({ result: "event", httpStatus: 200, event: handoff.event, partKey: handoff.partKey }),
  };
  const response = await handleLinqWebhook(
    new Request("https://rosie.test/test/webhooks/linq", { method: "POST", body: "{}" }),
    { ...root.gateway, linq: verify },
    { environment: "staging", version: "test-sha" },
  );
  return response.status;
}

// ---- helpers ----------------------------------------------------------------------------------------------------------

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

/** The JSON lines among a test's console lines whose `msg` is this one, in order. */
function jsonLinesOf(lines: readonly string[], msg: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value === "object" && value !== null && (value as { msg?: unknown }).msg === msg) {
      found.push(value as Record<string, unknown>);
    }
  }
  return found;
}

/** Each timing line is the runtime side's: HYPERDRIVE_JOB, the login rosie_worker_job, labels and numbers only. */
function expectJobSide(lines: readonly DbCallLine[]): void {
  for (const line of lines) {
    expect(line).toEqual({
      level: "info",
      msg: "dbCall",
      trace_id: null,
      call: expect.any(String) as string,
      side: "runtime",
      binding: "HYPERDRIVE_JOB",
      login: "rosie_worker_job",
      connect: { at: expect.stringMatching(UTC_TEXT) as string, ms: expect.any(Number) as number },
      guard: { at: expect.stringMatching(UTC_TEXT) as string, ms: expect.any(Number) as number },
      environment: "staging",
      version: "test-sha",
    });
  }
}

/** The local calendar date of an instant in a zone, as YYYY-MM-DD. */
function localDateOf(utc: string, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(utc));
}

/** The local wall clock of an instant in a zone, as HH:MM:SS (24 hours). */
function localTimeOf(utc: string, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(utc));
}

/** The calendar date after a YYYY-MM-DD date. */
function dayAfter(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** The four ports this card's inputs feed, each as its caller asks it. */
function portCalls(
  root: Root,
): { readonly call: string; readonly port: PortName; run(): Promise<unknown> }[] {
  return [
    {
      call: "claimOutbox",
      port: "outbox",
      run: () =>
        root.ports.outbox.claimOutbox({
          claimer: "dispatcher-t1401",
          recipientHandleId: JOIN.handleId,
          now: JOIN.committedAt,
          limit: 10,
        }),
    },
    {
      call: "sendState",
      port: "sendState",
      run: () => root.ports.sendState.sendState.sendStateFor({ outboxRowId: JOIN.row } as never),
    },
    { call: "sendPart", port: "linqSend", run: () => root.ports.linqSend.parts.sendPart({} as never) },
    {
      call: "questionFacts",
      port: "arming",
      run: () => root.ports.arming.facts.questionFacts(JOIN.question),
    },
  ];
}

beforeEach(() => {
  testLog = [];
  const keep = (...args: unknown[]): void => {
    const line = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
    testLog.push(line);
    LOGGED.push(line);
  };
  // A root's own spans (a row's own trace, a receipt's) and the gateway's lines go to the console.
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "warn").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
});

afterEach(() => {
  vi.restoreAllMocks();
  // T-1254's counter: every client a call opened was ended.
  for (const db of HANDLES) {
    const counts = db.counts();
    expect(counts.ended).toBe(counts.opened);
    expect(counts.connectionsOpen).toBe(0);
  }
  // The job side only: HYPERDRIVE_APP is never read for these calls, by its string or by its name, and no binding named
  // HYPERDRIVE is read at all.
  for (const made of ENVS) {
    expect(made.app.reads.n).toBe(0);
    expect(made.names).not.toContain("HYPERDRIVE_APP");
    expect(made.names).not.toContain("HYPERDRIVE");
  }
});

// ---- the rig ----------------------------------------------------------------------------------------------------------

describe("this file's database on the rig", () => {
  it("is this run's own, seeded with turn 1 committed and planned and the danger line checked, nothing claimed or sent; the pool's test-phone line holds no part", async () => {
    expect(DATABASE).toMatch(/^rosie_rig_[0-9a-f]{8}_send$/u);
    expect(POOL_LINE).toBeDefined();
    expect(V0.hash).toMatch(/^[0-9a-f]{64}$/u);

    const held = await stored();

    expect(rowOf(held, JOIN.row)).toEqual({ id: JOIN.row, state: "checked", version: 2 });
    expect(rowOf(held, DANGER_LINE.row)).toEqual({ id: DANGER_LINE.row, state: "checked", version: 2 });
    expect(held.parts).toEqual([]);
    expect(held.claims).toEqual([]);
    expect(clockOf(held, JOIN.clock)).toMatchObject({ state: "waiting", version: 1, dueAt: null });
    expect(questionOf(held, JOIN.question)).toMatchObject({ status: "waiting", version: 1 });
    expect(await lineParts()).toEqual([]);
  });
});

// ---- all or nothing ---------------------------------------------------------------------------------------------------

describe("all or nothing (DL-468): the four inputs are bound together or not at all", () => {
  it("both bindings there: all four bound; as it is built the part reads ENVIRONMENT, then HYPERDRIVE_JOB's presence, then TEST_PHONE_LINE's, and no connection string", () => {
    const testEnv = envOf();
    const db = stagingDb(testEnv.env, { write: (line) => LOGGED.push(line) });
    HANDLES.push(db);

    const inputs = stagingSendCalls({ env: testEnv.env, db });

    expect(boundOf(inputs)).toEqual([true, true, true, true]);
    expect(Object.keys(inputs).sort()).toEqual(Object.keys(NO_SEND_INPUTS).sort());
    // The routine claim's call and v1.14's beside it (DL-761, DL-783), with the three other outbox calls.
    expect(Object.keys(inputs.outboxCalls ?? {}).sort()).toEqual(
      ["claimOutboxV114", "claimOutboxV12", "markPartV12", "markRowV12", "renewClaim"].sort(),
    );
    expect(Object.keys(inputs.armingCalls ?? {}).sort()).toEqual(
      ["actorNameOf", "armClock", "cancelClock", "questionFacts"].sort(),
    );
    expect(testEnv.names).toEqual(["ENVIRONMENT", "HYPERDRIVE_JOB", "TEST_PHONE_LINE"]);
    expect(testEnv.job?.reads.n).toBe(0);
    expect(db.counts()).toMatchObject({ opened: 0, ended: 0 });

    // Through stagingOptions, every other part unbound: the same four, and nothing else bound or read.
    const through = envOf();
    const options = stagingOptions(through.env, { db, builders: EVERY_OTHER_PART_UNBOUND });
    expect(boundOf(sendInputsOf(options))).toEqual([true, true, true, true]);
    expect(
      Object.entries(options)
        .filter(([, input]) => input !== null)
        .map(([name]) => name)
        .sort(),
    ).toEqual(["armingCalls", "linqSendCall", "outboxCalls", "sendStateCall"]);
    expect(new Set(through.names)).toEqual(new Set(["ENVIRONMENT", "HYPERDRIVE_JOB", "TEST_PHONE_LINE"]));
    expect(through.job?.reads.n).toBe(0);
  });

  it("HYPERDRIVE_JOB not bound: all four null, and TEST_PHONE_LINE is not read; TEST_PHONE_LINE not bound: all four null; never outboxCalls without armingCalls", () => {
    const noJob = envOf({ job: null });
    const noLine = envOf({ line: false });
    const db = stagingDb(noJob.env, { write: (line) => LOGGED.push(line) });
    HANDLES.push(db);

    expect(stagingSendCalls({ env: noJob.env, db })).toBe(NO_SEND_INPUTS);
    expect(noJob.names).toEqual(["ENVIRONMENT", "HYPERDRIVE_JOB"]);

    expect(stagingSendCalls({ env: noLine.env, db })).toBe(NO_SEND_INPUTS);
    expect(noLine.names).toEqual(["ENVIRONMENT", "HYPERDRIVE_JOB", "TEST_PHONE_LINE"]);
    expect(noLine.job?.reads.n).toBe(0);

    expect(boundOf(NO_SEND_INPUTS)).toEqual([false, false, false, false]);
    for (const { name, options, bound } of FAILING_ENVS) {
      const inputs = sendInputsOf(
        stagingOptions(envOf(options).env, { db, builders: EVERY_OTHER_PART_UNBOUND }),
      );
      expect(boundOf(inputs), name).toEqual([bound, bound, bound, bound]);
    }
    expect(db.counts()).toMatchObject({ opened: 0, ended: 0 });
  });
});

// ---- nothing claimed ---------------------------------------------------------------------------------------------------

describe("the send cannot go: a wake claims nothing, so no claim burns a try", () => {
  for (const { name, options, bound } of FAILING_ENVS) {
    it(`${name}: the wake for handle-sam fails before any row is claimed; no row, version, part or claim row changes, and nothing reaches the line`, async () => {
      const before = await stored();
      const testEnv = envOf(options);
      const { root, db, calls } = rootOver(testEnv);

      const error = await rejectionOf(wakeSam(root));

      if (bound) {
        // The guard's refusal: the claim's code never ran, as rosie_app or at all.
        expect(error).toBeInstanceOf(DbGuardRefusal);
        expect(error).toMatchObject({ side: "runtime", binding: "HYPERDRIVE_JOB" });
        expect((error as DbGuardRefusal).checks).toContain("session_user");
        expect(jsonLinesOf(testLog, "dbGuardRefused")).toHaveLength(1);
        expect(db.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0 });
      } else {
        // Nothing bound: the outbox port refuses the claim before anything is opened.
        expect(error).toEqual(new NoDatabaseError("claimOutbox"));
        expect(db.counts()).toMatchObject({ opened: 0, ended: 0 });
        expect(testEnv.job?.reads.n ?? 0).toBe(0);
        // Each of the four ports fails closed as with nothing bound.
        for (const { call, run } of portCalls(root)) {
          const refused = await rejectionOf(run());
          expect((refused as Error).name, call).toMatch(/^(NoDatabaseError|NoLinqLineError)$/u);
        }
      }
      // The guard never passed, or nothing was called: no timing line.
      expect(calls()).toEqual([]);
      expect(await stored()).toEqual(before);
      expect(await lineParts()).toEqual([]);
    });
  }

  it("a danger line's safety run whose bound calls hold no claimOutboxV114 is refused before any call: nothing is claimed, never a claim of every class in its place", async () => {
    const before = await stored();
    const { root, db, calls } = rootOver(envOf(), (inputs) => {
      if (inputs.outboxCalls === null) throw new Error("staging bound no outbox calls");
      const { claimOutboxV12, renewClaim, markPartV12, markRowV12 } = inputs.outboxCalls;
      return { ...inputs, outboxCalls: { claimOutboxV12, renewClaim, markPartV12, markRowV12 } };
    });

    const error = await rejectionOf(wakeSafety(root));

    expect(error).toBeInstanceOf(SendClassNotCarriedError);
    expect(calls()).toEqual([]);
    expect(db.counts()).toMatchObject({ opened: 0, ended: 0 });
    expect(await stored()).toEqual(before);
    expect(await lineParts()).toEqual([]);
  });
});

// ---- the danger line: K-05 v1.14's safety claim -----------------------------------------------------------------------

describe("claimOutboxV114 bound: a danger line's safety run", () => {
  it("claims the recipient's safety row through K-05 v1.14's claim, on the rows claim-safety-past-routine-live-claim.json's note lists, and sends it; the JOIN's routine row is not read, claimed or sent", async () => {
    const before = await stored();
    const { root, db, calls, lines } = rootOver(envOf());

    await wakeSafety(root);

    const after = await stored();
    // The safety row alone: claimed once by this root's dispatcher, its one part sent under its key.
    expect(after.claims).toEqual([
      { row: DANGER_LINE.row, claimer: expect.stringMatching(/^dispatcher-/u) as string, claimNo: 1 },
    ]);
    expect(rowOf(after, DANGER_LINE.row)).toMatchObject({ state: "sent" });
    const part = partOf(after, DANGER_LINE.partKey);
    expect(part).toMatchObject({ state: "sent", attempts: 1, deliveredAt: null });
    expect(after.parts).toHaveLength(1);
    // The JOIN's row, of another class, as the seed left it: a safety claim reads no row of another class (item 67).
    expect(rowOf(after, JOIN.row)).toEqual(rowOf(before, JOIN.row));
    expect(after.clocks).toEqual(before.clocks);
    expect(after.questions).toEqual(before.questions);
    // The line holds the danger line once, with the message id the part holds.
    const sent = await lineParts();
    expect(sent.map((one) => one.key)).toEqual([DANGER_LINE.partKey]);
    expect(sent[0]).toMatchObject({
      to: SAM_NUMBER,
      text: DANGER_LINE_TEXT,
      outcome: { result: "accepted", providerMessageId: part?.messageId },
    });
    expect(part?.messageId).toEqual(expect.any(String));
    // One claim, limit 8's read, the renewal, the stopped flag's second read, the sent mark: each on the job side.
    expect(calls()).toEqual(["claimOutbox", "sendState", "renewClaim", "sendState", "markPart"]);
    expectJobSide(lines());
    expect(db.counts()).toMatchObject({ opened: 5, ended: 5, connectionsOpen: 0, connectionsPeak: 1 });
  });
});

// ---- the send -----------------------------------------------------------------------------------------------------------

describe("the send: the dispatcher's wake for handle-sam", () => {
  it("claims outbox-s1-02-sam-1 once, reads its send state, and its one part reaches the test-phone line under its key, once; the row and the part are sent in PostgreSQL with the line's message id; a second wake claims nothing", async () => {
    const before = await stored();
    const testEnv = envOf();
    const { root, db, inputs, calls, lines } = rootOver(testEnv);
    const spans: Span[] = [];
    // Nothing was read to build the root but the environment and the two bindings' presence: no connection string.
    expect(testEnv.job?.reads.n).toBe(0);

    await wakeSam(root, spans);

    // One claim (K-05 v1.13's, through claimOutboxV114: DL-761), limit 8's read, the renewal, the stopped flag's second
    // read and the sent mark, each on a job-side client of its own.
    expect(calls()).toEqual(["claimOutbox", "sendState", "renewClaim", "sendState", "markPart"]);
    expectJobSide(lines());
    expect(testEnv.job?.reads.n).toBe(5);
    expect(db.counts()).toMatchObject({ opened: 5, ended: 5, connectionsOpen: 0, connectionsPeak: 1 });

    // The line holds the JOIN's part once, to Sam's number, with the reply's words.
    const ofJoin = (await lineParts()).filter((one) => one.key === JOIN.partKey);
    expect(ofJoin).toHaveLength(1);
    expect(ofJoin[0]).toMatchObject({
      to: SAM_NUMBER,
      text: JOIN_REPLY_TEXT,
      outcome: { result: "accepted", chatId: SAM_CHAT },
    });
    const messageId = (ofJoin[0]?.outcome as { providerMessageId?: unknown }).providerMessageId;
    expect(messageId).toEqual(expect.any(String));

    // PostgreSQL: the row sent, claimed once by this root's dispatcher, its one part sent with the line's message id.
    const after = await stored();
    expect(rowOf(after, JOIN.row)).toMatchObject({ state: "sent" });
    expect(partOf(after, JOIN.partKey)).toEqual({
      key: JOIN.partKey,
      state: "sent",
      messageId,
      attempts: 1,
      deliveredAt: null,
    });
    expect(after.claims.find((claim) => claim.row === JOIN.row)).toEqual({
      row: JOIN.row,
      claimer: expect.stringMatching(/^dispatcher-/u) as string,
      claimNo: 1,
    });
    // No receipt yet: the question's clock row and the question wait, as the commit wrote them.
    expect(after.clocks).toEqual(before.clocks);
    expect(after.questions).toEqual(before.questions);
    // The turn's trace, in the order its spans were written: the part's acceptance as it came, then the row's dispatch
    // once its run ended; labels and counts only.
    expect(spans.map((span) => [span.hop, span.outcome])).toEqual([
      ["providerAccepted", "ok"],
      ["dispatch", "ok"],
    ]);
    expect(spans.find((span) => span.hop === "dispatch")).toMatchObject({
      limits: [{ limit: 8, result: "pass" }],
      got: { parts: 1, partsSent: 1 },
      decided: { result: "sent", claimNo: 1 },
      rows: [{ table: "outbox_rows", id: JOIN.row }],
    });

    // The send state limit 8 read: K-05's answer in send-state-customer.json's shape, the chat open with Linq's chat id.
    const sendState = inputs.sendStateCall;
    if (sendState === null) throw new Error("staging bound no send state");
    const state = await sendState({ outboxRowId: JOIN.row });
    expect(Object.keys(state).sort()).toEqual(Object.keys(sendStateCustomer.outcome).sort());
    expect(state).toMatchObject({
      result: "sendState",
      outboxRowId: JOIN.row,
      rowState: "sent",
      recipient: { handleId: JOIN.handleId, kind: "phone", address: SAM_NUMBER, personId: JOIN.personId },
      phone: { number: SAM_NUMBER, stopped: false, chatOpen: true, chatWay: "imessage" },
      chat: { threadId: SAM_THREAD.id, linqChatId: SAM_CHAT, version: SAM_THREAD.version },
      businessZone: BARBERSHOP_ZONE,
      textHours: { start: "08:00", end: "20:00" },
    });

    // A second wake: one claim, which takes nothing, so nothing is read, sent or marked.
    await wakeSam(root);

    expect(calls()).toEqual([
      "claimOutbox",
      "sendState",
      "renewClaim",
      "sendState",
      "markPart",
      "sendState",
      "claimOutbox",
    ]);
    expect(await stored()).toEqual(after);
    expect((await lineParts()).map((one) => one.key)).toEqual([DANGER_LINE.partKey, JOIN.partKey]);
  });
});

// ---- a receipt not marked -----------------------------------------------------------------------------------------------

describe("a delivery receipt where the send cannot go: the receipt door rejects, so the gateway answers 503, and no part is marked", () => {
  for (const { name, options, bound } of FAILING_ENVS) {
    it(`${name}: Root.gateway.receipts.accept rejects for the sent part, the gateway's answer is 503, and the part stays sent, its clock unarmed`, async () => {
      const before = await stored();
      const part = partOf(before, JOIN.partKey);
      if (part?.messageId == null) throw new Error("the JOIN's part was not sent");
      expect(part.state).toBe("sent");
      const { root, db, actors, calls } = rootOver(envOf(options));
      const receipt = receiptOf(
        part.messageId,
        wholeSecondAfter(new Date().toISOString()),
        "evt-t1401-not-marked",
      );

      const error = await rejectionOf(root.gateway.receipts.accept(receipt));

      if (bound) {
        expect(error).toBeInstanceOf(DbGuardRefusal);
        expect(error).toMatchObject({ side: "runtime", binding: "HYPERDRIVE_JOB" });
      } else {
        expect(error).toEqual(new NoDatabaseError("markPart"));
      }
      // The gateway's own entry over the same doors: 503, so Linq sends the receipt again.
      expect(await gatewayStatus(root, receipt)).toBe(503);

      expect(calls()).toEqual([]);
      expect(db.counts()).toMatchObject(bound ? { opened: 2, ended: 2 } : { opened: 0, ended: 0 });
      expect(actors.named).toEqual([]);
      expect(actors.told).toEqual([]);
      // No part marked, nothing armed: the part sent, the row sent, the clock row and its question waiting.
      const after = await stored();
      expect(after).toEqual(before);
      expect(partOf(after, JOIN.partKey)).toMatchObject({ state: "sent", deliveredAt: null });
      expect(clockOf(after, JOIN.clock)).toMatchObject({ state: "waiting", version: 1 });
    });
  }
});

// ---- the receipt --------------------------------------------------------------------------------------------------------

describe("the receipt: Root.gateway.receipts.accept with a K-06 delivered event for the sent part", () => {
  it("answers written: the part and the row are delivered, S1-02's clock row is armed once, due 8pm the day after delivery in America/New_York, its question open, and Sam's actor is told; the same receipt again, and again in another isolate, answers duplicate with no second arming", async () => {
    const before = await stored();
    const part = partOf(before, JOIN.partKey);
    const accepted = (await lineParts()).find((one) => one.key === JOIN.partKey);
    if (part?.messageId == null || accepted === undefined) throw new Error("the JOIN's part was not sent");
    const acceptedAt = (accepted.outcome as { acceptedAt?: unknown }).acceptedAt;
    if (typeof acceptedAt !== "string") throw new Error("the line kept no acceptance time");
    // Delivered a moment after the line accepted it, to the whole second K-06 writes.
    const deliveredAt = wholeSecondAfter(acceptedAt);
    const receipt = receiptOf(part.messageId, deliveredAt, "evt-t1401-delivered-1");
    const { root, db, actors, calls, lines } = rootOver(envOf());

    expect(await root.gateway.receipts.accept(receipt)).toBe("written");

    // The delivered mark, the question's facts, the arming, then the handle's read for its actor's name.
    expect(calls()).toEqual(["markPart", "readQuestionFacts", "armClock", "readHandle"]);
    expectJobSide(lines());
    const after = await stored();
    expect(partOf(after, JOIN.partKey)).toEqual({
      key: JOIN.partKey,
      state: "delivered",
      messageId: part.messageId,
      attempts: 1,
      deliveredAt: new Date(deliveredAt).toISOString(),
    });
    expect(rowOf(after, JOIN.row)).toMatchObject({ state: "delivered" });
    // T-255's due rule for a question with no Clock line and no visit: 8pm the day after delivery, in the shop's zone.
    const due = dueOf({ deliveredAt, clockLine: null, visitStartsAt: null, zone: BARBERSHOP_ZONE });
    expect(due.branch).toBe("noVisit");
    expect(localTimeOf(due.dueAt, BARBERSHOP_ZONE)).toBe("20:00:00");
    expect(localDateOf(due.dueAt, BARBERSHOP_ZONE)).toBe(dayAfter(localDateOf(deliveredAt, BARBERSHOP_ZONE)));
    const armed: StoredClock = {
      id: JOIN.clock,
      state: "armed",
      version: 2,
      dueAt: new Date(due.dueAt).toISOString(),
      dueZone: BARBERSHOP_ZONE,
      armedAt: new Date(deliveredAt).toISOString(),
    };
    expect(clockOf(after, JOIN.clock)).toEqual(armed);
    expect(questionOf(after, JOIN.question)).toMatchObject({ status: "open", version: 2 });
    // Sam's actor, named as the gateway names it, told once of the handle's newly armed row.
    expect(actors.named).toEqual([SAM_ACTOR]);
    expect(actors.told).toEqual([[SAM_ACTOR, JOIN.handleId]]);
    // The receipt's own trace (this isolate did not send the row): delivered, then clockArmed; labels only.
    const receiptSpans = spansOfLogLines(testLog).filter((span) => span.trace_id === RECEIPT_TRACE);
    expect(receiptSpans.map((span) => [span.hop, span.outcome])).toEqual([
      ["delivered", "ok"],
      ["clockArmed", "ok"],
    ]);
    expect(receiptSpans[1]).toMatchObject({
      decided: {
        result: "armed",
        branch: "noVisit",
        zoneFrom: "business",
        neverDelivered: "none",
        synced: true,
      },
      rows: [{ table: "clock_rows", id: JOIN.clock }],
    });

    // The same receipt again: a duplicate. K-05 answers the mark repeated; the arming, handed the repeat of the row's
    // first delivery, remembers the part and asks K-05 nothing.
    expect(await root.gateway.receipts.accept(receipt)).toBe("duplicate");

    expect(calls()).toEqual(["markPart", "readQuestionFacts", "armClock", "readHandle", "markPart"]);
    expect(await stored()).toEqual(after);
    expect(actors.told).toHaveLength(1);

    // And in another isolate, which remembers no part: K-05's armClock answers the repeat with its first arming.
    const other = rootOver(envOf());
    expect(await other.root.gateway.receipts.accept(receipt)).toBe("duplicate");

    expect(other.calls()).toEqual(["markPart", "readQuestionFacts", "armClock"]);
    expect(await stored()).toEqual(after);
    expect(other.actors.told).toEqual([]);
    expect(db.counts()).toMatchObject({ opened: 5, ended: 5, connectionsOpen: 0, connectionsPeak: 1 });
    // The gateway's own entry over the same doors answers the repeat 200.
    expect(await gatewayStatus(other.root, receipt)).toBe(200);
    expect(await stored()).toEqual(after);
  });
});

// ---- the arming's reads -------------------------------------------------------------------------------------------------

describe("the arming's reads by direct call: K-05 v1.10 items 49 and 50 through the job handle", () => {
  /** The arming calls staging bound over this file's database, with the root's handle and its timing lines. */
  function bound(): { calls: ArmingCalls; rooted: Rooted } {
    const rooted = rootOver(envOf());
    if (rooted.inputs.armingCalls === null) throw new Error("staging bound no arming calls");
    return { calls: rooted.inputs.armingCalls, rooted };
  }

  it("questionFacts answers read-question-facts-s1-02.json's outcome, read-question-facts-a7-03.json's with the visit's addressZone and address null, and read-question-facts-unknown.json's as the port's NotFoundError", async () => {
    const { calls, rooted } = bound();

    expect(readQuestionFactsS102.request.openQuestionId).toBe(JOIN.question);
    expect(await calls.questionFacts(JOIN.question)).toEqual(readQuestionFactsS102.outcome);

    expect(readQuestionFactsA703.request.openQuestionId).toBe(A7_03.question);
    const withVisit = await calls.questionFacts(A7_03.question);
    expect(withVisit).toEqual({
      ...readQuestionFactsA703.outcome,
      visit: { ...readQuestionFactsA703.outcome.visit, addressZone: null, address: null },
    });
    expect(Object.keys((withVisit as { visit: object }).visit).sort()).toEqual([
      "address",
      "addressZone",
      "flow",
      "startsAt",
    ]);

    const unknown = await calls.questionFacts(readQuestionFactsUnknown.request.openQuestionId);
    expect(unknown).toEqual(readQuestionFactsUnknown.outcome);
    expect(unknown).toEqual({
      error: "notFound",
      table: "open_questions",
      rowId: readQuestionFactsUnknown.request.openQuestionId,
    });
    // Through the root's arming port, the same answer.
    expect(await rooted.root.ports.arming.facts.questionFacts(JOIN.question)).toEqual(
      readQuestionFactsS102.outcome,
    );

    expect(rooted.calls()).toEqual([
      "readQuestionFacts",
      "readQuestionFacts",
      "readQuestionFacts",
      "readQuestionFacts",
    ]);
    expectJobSide(rooted.lines());
  });

  it("actorNameOf answers the gateway's actorNameOf of read-handle-sam.json's handle, and null for read-handle-unknown.json's id; for that id no actor is told, and the arming still arms", async () => {
    const { calls, rooted } = bound();
    const unknownHandle = readHandleUnknown.request.handleId;

    expect(await calls.actorNameOf(readHandleSam.request.handleId)).toBe(
      actorNameOf(readHandleSam.outcome.handle),
    );
    expect(actorNameOf(readHandleSam.outcome.handle)).toBe(SAM_ACTOR);
    expect(readHandleUnknown.outcome.handle).toBeNull();
    expect(await calls.actorNameOf(unknownHandle)).toBeNull();
    expect(await rooted.root.ports.arming.directory.actorNameOf(unknownHandle)).toBeNull();

    // T-255's arming over the bound calls for A7-03's first delivery, its armed answer naming the unknown handle (a clock
    // row's handle is always a handle row: clock_rows_handle_fk; the fixture's note: "only a broken record or a mistaken
    // caller meets this"): the directory names no actor, none is told, and the clock is armed all the same.
    const before = await stored();
    const actors = actorsDouble();
    const deliveredAt = readQuestionFactsA703.given.now;
    const report = await armAtDelivery(
      {
        outboxRowId: "out-a7-03-alex",
        partNo: 1,
        tryNo: 1,
        firstDelivery: true,
        openQuestionId: A7_03.question,
        deliveredAt,
      },
      {
        data: {
          async armClock(request) {
            const answer = await calls.armClock(request);
            return "result" in answer
              ? { ...answer, clock: { ...answer.clock, handleId: unknownHandle } }
              : answer;
          },
          cancelClock: (request) => calls.cancelClock(request),
        },
        facts: { questionFacts: (openQuestionId) => calls.questionFacts(openQuestionId) },
        geo: null,
        directory: { actorNameOf: (handleId) => calls.actorNameOf(handleId) },
        actors: actors.actors,
        log: { environment: "staging", version: "test-sha" },
        memory: new ArmingMemory(),
      },
    );

    expect(report).toMatchObject({
      outcome: "armed",
      openQuestionId: A7_03.question,
      clockRowId: `clock-${A7_03.question}`,
      branch: "clockLine",
      zoneFrom: "business",
      neverDelivered: "none",
      synced: false,
      errorCode: "noActor",
    });
    expect(actors.named).toEqual([]);
    expect(actors.told).toEqual([]);
    // Armed in PostgreSQL at the Clock line's 24 h from the delivery, before the visit's start (the fixture's note).
    const after = await stored();
    expect(clockOf(after, `clock-${A7_03.question}`)).toEqual({
      id: `clock-${A7_03.question}`,
      state: "armed",
      version: 2,
      dueAt: "2026-10-24T14:05:04.000Z",
      dueZone: BARBERSHOP_ZONE,
      armedAt: new Date(deliveredAt).toISOString(),
    });
    expect(questionOf(after, A7_03.question)).toMatchObject({ status: "open" });
    expect(after.rows).toEqual(before.rows);
    expect(clockOf(after, JOIN.clock)).toEqual(clockOf(before, JOIN.clock));
    expect(rooted.calls()).toEqual([
      "readHandle",
      "readHandle",
      "readHandle",
      "readQuestionFacts",
      "armClock",
      "readHandle",
    ]);
    expectJobSide(rooted.lines());
  });
});

// ---- production -----------------------------------------------------------------------------------------------------------

describe("production's environment", () => {
  it("the builder gives nothing and reads no binding (a counting double: 0 reads), and through the Worker's own root the four ports are closed", async () => {
    const before = await stored();
    const testEnv = envOf({ environment: "production" });
    const alone = stagingDb(testEnv.env, { write: (line) => LOGGED.push(line) });
    HANDLES.push(alone);

    // The builder alone, were it ever handed production's env: every input null, ENVIRONMENT read and nothing else.
    expect(stagingSendCalls({ env: testEnv.env, db: alone })).toBe(NO_SEND_INPUTS);
    expect(testEnv.names).toEqual(["ENVIRONMENT"]);

    const root = workerRoot(testEnv.env);

    expect(root.environment).toBe("production");
    for (const { call, port, run } of portCalls(root)) {
      await expect(run(), call).rejects.toThrow(new NotJoinedError(port));
    }
    expect(
      testEnv.names.filter((name) => name.startsWith("HYPERDRIVE") || name === "TEST_PHONE_LINE"),
    ).toEqual([]);
    expect([testEnv.job?.reads.n, testEnv.app.reads.n]).toEqual([0, 0]);
    expect(alone.counts()).toMatchObject({ opened: 0, ended: 0 });
    expect(await stored()).toEqual(before);
  });
});

// ---- nothing leaks ------------------------------------------------------------------------------------------------------

describe("the span and log capture of every test above", () => {
  it("holds no number in any form, chat id, part's words or connection string: labels, ids and numbers only; and no unhandled rejection reached this isolate", async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    const spans = [...SPANS, ...spansOfLogLines(LOGGED)];
    // The capture is not empty: the dispatch, delivered and clockArmed spans and every call's timing line are in it.
    expect(spans.filter((span) => span.hop === "dispatch").length).toBeGreaterThanOrEqual(2);
    expect(spans.filter((span) => span.hop === "delivered").length).toBeGreaterThanOrEqual(3);
    expect(spans.filter((span) => span.hop === "clockArmed").length).toBeGreaterThanOrEqual(3);
    expect(jsonLinesOf(LOGGED, "dbCall").length).toBeGreaterThanOrEqual(20);
    expect(jsonLinesOf(LOGGED, "dbGuardRefused").length).toBeGreaterThanOrEqual(3);

    const secrets = [...NUMBER_FORMS, SAM_ACTOR, SAM_CHAT, JOIN_REPLY_TEXT, DANGER_LINE_TEXT];
    expect(leaks(spans, secrets)).toEqual([]);
    const lowered = LOGGED.map((line) => line.toLowerCase());
    const words = [JOIN_REPLY_TEXT, DANGER_LINE_TEXT].flatMap((text) => text.split("\n"));
    const strings = [poolBinding(JOB), poolBinding(APP)].flatMap((binding) => [
      binding.connectionString,
      new URL(binding.connectionString).host,
    ]);
    for (const secret of [...NUMBER_FORMS, SAM_CHAT, JOIN.personId, ...words, ...strings, "postgres://"]) {
      expect(
        lowered.filter((line) => line.includes(secret.toLowerCase())),
        "a log line holds a number, a chat id, a person's id, a part's words or a part of a connection string",
      ).toEqual([]);
    }
    expect(lowered.filter((line) => /\+[0-9]{7,15}/u.test(line))).toEqual([]);
    expect(rejections.map((reason) => String(reason))).toEqual([]);
  });
});
