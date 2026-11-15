// T-1398: staging's gate reads (./tool-api-gate.ts; the D-017 path audit's P4a; the lead's notes DL-397, DL-757, DL-760,
// DL-761, DL-768 and DL-776), inside the Workers runtime on T-1253's rig (infra/test-rig/files.mjs, key TOOL_API_GATE) and
// through its pool bindings only (vitest.config.ts): this file's pair, HYPERDRIVE_JOB_TOOL_API_GATE and
// HYPERDRIVE_APP_TOOL_API_GATE, the two Worker logins on this file's own database (migrated, bundle v0 published and
// active, seeded by ./tool-api-gate.seed.ts), and the pool's own pair, which names rosie_rig_none, never made. Each test
// hands the binding (stagingGateReads) or a root built as workerRoot builds the Worker's (composeRoot over stagingOptions)
// an env of its own whose HYPERDRIVE_JOB and HYPERDRIVE_APP are doubles over pool bindings that count the reads of their
// connection strings, with the seed's made-up SEALING_WRAP_KEY.
//
// A root here binds this card's part and the two parts its proofs need beside it, each by its own builder (DL-776): T-1395's
// turn calls (./k05-turn.ts: the gate's one commitTurn through the turn-row port, and the bundle reads the gate and the
// check read the turn's bundle through) and T-1397's one BundleSafety adapter (./bundle-safety.ts: the source of
// SafetyDeps.words, bundle v0 pinned through its own check). Every other part is stood in by its nothing-bound answer, and
// the cases that count what is read as the root is built stand those two in too, so they hold in any merge order.
//
//   - Turn 1's gate (K-09 v1.5 commit-s1-01.json's request, under the turn id the lease hashes and bundle v0) commits
//     once: its turns row, S1-01's thread, S1-02's question, its clock row, its outbox row and the No record (its words
//     sealed under Sam's existing key) are in this file's database; the same request again answers the first commit with
//     nothing written. The scope ran as rosie_worker_app under the call's business, and the commit as rosie_worker_job, read
//     on the client commitTurn's call used (the guard's login, on the call's timing line: ADR-014 line 198).
//   - The reads as their K-05 fixtures: read-safety-outcome-of-event-s1-01 (nothing before the commit), business-zone-
//     barbershop, business-owner-phone-first (on the runtime side), read-open-holds-other-business (unread under another
//     business's scope); and a gate whose text's outcome another business holds is held, its one part answered held.
//   - SafetyDeps.words: from the adapter's checked bundle v0, word for word, null for a line it holds no words for; before
//     any check it is no port (notBuilt). A record whose line asks the danger question commits with bundle v0 checked and
//     answers notBuilt with nothing written before any check.
//   - The read-only sealer: seals under an existing key; a person with no key is refused (noSealingKey) and no key is made;
//     with SEALING_WRAP_KEY left out the seal fails with its code alone. Through the gate, either writes nothing.
//   - Connections: two gates side by side, each holding its Tool API client while its seal and commit (and two scopes' owner
//     reads and seals) open runtime-side clients, finish under T-1254's cap; six gates at once, at most three holding a Tool
//     API client, finish with 6 connections at most; opened equals ended after every test.
//   - Failing closed: bindings left out (null input, inside the Tool API base, nothing read); the pool's own HYPERDRIVE_APP
//     (the call's name and SQLSTATE only); a read's error answer thrown (a business this database does not hold); production
//     (no binding read, the gate port closed).
//   - No line written while this file runs holds a text's words, a number, an address, the wrapping key, a sealed value,
//     a chat id or a fixed line's words, and no rejection is left unhandled.
// Test values only (rule 9): the master's sample cast, the fixtures' ids and words, whole fiction-range 555-01xx numbers,
// made-up ids, and the seed's made-up wrapping key.
import { KEYED_SAFETY_IDS } from "@rosie/actions/src/domain/safety/ids";
import { NotBuiltError } from "@rosie/actions/src/tool-api/errors";
import { TurnFaceReadError, TurnFaceRefusedError } from "@rosie/actions/src/tool-api/turn-face/errors";
import businessOwnerPhoneFirst from "@rosie/contracts/data-access/fixtures/business-owner-phone-first.json";
import businessZoneBarbershop from "@rosie/contracts/data-access/fixtures/business-zone-barbershop.json";
import readOpenHoldsOtherBusiness from "@rosie/contracts/data-access/fixtures/read-open-holds-other-business.json";
import readSafetyOutcomeOfEventS101 from "@rosie/contracts/data-access/fixtures/read-safety-outcome-of-event-s1-01.json";
import safetyBusinessOwnLine from "@rosie/contracts/model/fixtures/safety-business-own-line.json";
import commitS101 from "@rosie/contracts/tool-api/fixtures/commit-s1-01.json";
import { readActiveBundle } from "@rosie/db/repo/bundles";
import { DataAccessDatabaseError } from "@rosie/db/repo/clocks";
import type { Sql } from "@rosie/db/repo/scope";
import { SealingError, unsealText } from "@rosie/db/repo/sealing";
import { env as poolEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { turnIdOf } from "../../actor/lease";
import { openTrace, type Span, type TraceContext } from "../../trace";
import { composeRoot, NoDatabaseError, NotJoinedError, workerRoot, type Root } from "../index";
import type { BundleSafetyLines, GateReads } from "../real";
import { BUNDLE_V0, bundleV0FixedLine, SAM_CHAT } from "../test-support";
import { answeringBundleOf } from "./bundle-safety";
import { CONNECTIONS_PER_CLIENT, DB_SIDES, dbHandle } from "./db";
import { NO_RECEIPT_INPUTS } from "./k05-receipt";
import { NO_TURN_CALL_INPUTS } from "./k05-turn";
import { NO_MODEL_READER_INPUTS } from "./models";
import { NO_STAGING_INPUTS, stagingOptions, type StagingBuilders, type StagingInputs } from "./options";
import { stagingDb, type StagingDb, type StagingEnv } from "./part";
import { sealingWrapKeys } from "./secrets";
import { NO_SEND_INPUTS } from "./send";
import { NO_DIRECTORY_INPUTS } from "./state-reads";
import { GATE_CALLS, GATE_CLIENTS_AT_ONCE, stagingGateReads, type GatePart } from "./tool-api-gate";
import {
  ASK_RECORD,
  BARBERSHOP,
  NO_KEY,
  NO_WRAP_KEY,
  OTHER_BUSINESS_RECORD,
  SAM,
  SAM_EMAIL,
  SIDE_BY_SIDE,
  SIX_AT_ONCE,
  TEST_WRAP_KEY,
  WRAP_KEY_NAME,
  writeOwnerRows,
  YOGA_STUDIO,
} from "./tool-api-gate.seed";
import { NO_ROW_INPUTS } from "./tool-api-rows";

/** This file's key in the rig's list (infra/test-rig/files.mjs). */
const KEY = "TOOL_API_GATE";
const JOB = `HYPERDRIVE_JOB_${KEY}`;
const APP = `HYPERDRIVE_APP_${KEY}`;
/** The pool's own pair: its database, rosie_rig_none, is never made, so a connect through either fails. */
const POOL_JOB = "HYPERDRIVE_JOB";
const POOL_APP = "HYPERDRIVE_APP";
/** The connections a Worker may hold open at once (infra/spikes/hyperdrive-host/worker.mjs line 77). */
const WORKER_CONNECTIONS = 6;

/** A run through the Workers runtime's own steps and PostgreSQL: a resource guard above the project's default. */
const TEST_MS = 60_000;

/** Bundle v0 as the rig published it: the one bundle this file's database holds, active. */
const V0 = BUNDLE_V0;

type Json = Record<string, unknown>;

/** The pool's Hyperdrive bindings, by name. */
const pool = poolEnv as unknown as Readonly<Record<string, Hyperdrive | undefined>>;

function poolBinding(name: string): Hyperdrive {
  const found = pool[name];
  if (found === undefined) throw new Error(`the pool has no Hyperdrive binding ${name}`);
  return found;
}

const DATABASE = inject("rosieRigDatabases")?.[KEY];

// ---- what this file's isolate wrote and rejected ---------------------------------------------------------------------

/** Every unhandled rejection this isolate reports while this file runs. */
const rejections: unknown[] = [];
addEventListener("unhandledrejection", (event) => {
  rejections.push(event.reason);
});

/** Every line written on the console and by a handle while this file's tests ran, and the running test's own. */
const everyLine: string[] = [];
let lines: string[] = [];
/** Every span a test's trace wrote. */
const SPANS: Span[] = [];

/** Every handle a test made, and every env a test built: checked after each test. */
const HANDLES: StagingDb[] = [];
const ENVS: TestEnv[] = [];

beforeEach(() => {
  lines = [];
  const keep = (...args: unknown[]): void => {
    const line = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
    lines.push(line);
    everyLine.push(line);
  };
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(keep);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  // T-1254's counter: every client a call opened was ended, its sockets with it.
  for (const db of HANDLES) {
    const counts = db.counts();
    expect(counts.ended).toBe(counts.opened);
    expect(counts.connectionsOpen).toBe(0);
  }
  // No binding named HYPERDRIVE is ever read, and SEALING_WRAP_KEY only by the resolver, at a seal.
  for (const made of ENVS) expect(made.names).not.toContain("HYPERDRIVE");
});

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A written line as the JSON it is; a line that is none fails the test. */
function parsed(line: string): Json {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) throw new Error("a log line is not a JSON object");
  return value;
}

// ---- envs and doubles ------------------------------------------------------------------------------------------------

interface Counted {
  readonly binding: { readonly connectionString: string };
  readonly reads: { n: number };
}

/** A double over a pool binding that counts the reads of its connection string (and gives the pool binding's). */
function counted(binding: Hyperdrive): Counted {
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
  /** The counting doubles handed in as HYPERDRIVE_JOB and HYPERDRIVE_APP; null where the env has none or the pool's own. */
  readonly job: Counted | null;
  readonly app: Counted | null;
}

interface EnvOptions {
  readonly environment?: string;
  /** The pool binding handed in as HYPERDRIVE_JOB (default: this file's own); null for none. */
  readonly job?: string | null;
  /** The pool binding handed in as HYPERDRIVE_APP (default: this file's own); null for none. */
  readonly app?: string | null;
  /** False: SEALING_WRAP_KEY left out of the env. */
  readonly wrapKey?: boolean;
}

/** An env of the test's own: staging's vars, this file's pair behind counting doubles and the made-up wrapping key. */
function envOf(options: EnvOptions = {}): TestEnv {
  const names: string[] = [];
  const jobName = options.job === undefined ? JOB : options.job;
  const appName = options.app === undefined ? APP : options.app;
  const job = jobName === null ? null : counted(poolBinding(jobName));
  const app = appName === null ? null : counted(poolBinding(appName));
  const values: Record<string, unknown> = {
    ENVIRONMENT: options.environment ?? "staging",
    BASE_PATH: "/test",
    DB_SCHEMA: "",
    GIT_SHA: "test-sha",
    ...(options.wrapKey === false ? {} : { [WRAP_KEY_NAME]: TEST_WRAP_KEY }),
    ...(job === null ? {} : { HYPERDRIVE_JOB: job.binding }),
    ...(app === null ? {} : { HYPERDRIVE_APP: app.binding }),
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

/** The handle over an env, each of its timing lines kept in `written`. */
function handleOver(env: StagingEnv, written: Json[]): StagingDb {
  const db = stagingDb(env, {
    write: (line) => {
      everyLine.push(line);
      written.push(parsed(line));
    },
  });
  HANDLES.push(db);
  return db;
}

/**
 * Every part off the gate's path, stood in by its nothing-bound answer (each stub's own, as T-1257 made it; DL-776): a
 * root built with these binds this card's part, T-1395's turn calls and T-1397's adapter, each by its own builder.
 */
const OFF_THE_GATE_PATH: Partial<StagingBuilders> = {
  receipt: () => NO_RECEIPT_INPUTS,
  models: () => NO_MODEL_READER_INPUTS,
  rows: () => NO_ROW_INPUTS,
  directories: () => NO_DIRECTORY_INPUTS,
  send: () => NO_SEND_INPUTS,
  flags: () => null,
  testPhone: () => null,
  copies: () => null,
};

/** Every part but this card's stood in (DL-776): what such a build reads is stagingOptions' and this part's alone. */
const EVERY_OTHER_PART_UNBOUND: Partial<StagingBuilders> = {
  ...OFF_THE_GATE_PATH,
  turn: () => NO_TURN_CALL_INPUTS,
  bundleSafety: () => null,
};

interface Rooted {
  readonly root: Root;
  /** The root's one handle (T-1254's, through ./part.ts): its counts are the root's. */
  readonly db: StagingDb;
  readonly inputs: StagingInputs;
  /** Each call's timing line the handle wrote, in order. */
  readonly written: Json[];
  /** This card's input, as stagingOptions gave it. */
  readonly gate: GateReads;
  /** T-1397's one adapter, as stagingOptions gave it. */
  readonly adapter: BundleSafetyLines;
}

/**
 * A root built as workerRoot builds the Worker's (composeRoot over stagingOptions(env)), over the test's env, on `db`
 * (whose timing lines are kept in `written`), with this card's part, T-1395's and T-1397's bound by their own builders.
 */
function rootOn(testEnv: TestEnv, db: StagingDb, written: Json[]): Rooted {
  const inputs = stagingOptions(testEnv.env, { db, builders: OFF_THE_GATE_PATH });
  const root = composeRoot({ environment: "staging", actors: null, vars: testEnv.env, ...inputs });
  const { gateReads, bundleSafety } = inputs;
  if (gateReads === null || bundleSafety === null) throw new Error("the gate's path is bound on this file's pair");
  return { root, db, inputs, written, gate: gateReads, adapter: bundleSafety };
}

/** rootOn over a handle of the root's own, its timing lines kept. */
function rootOver(testEnv: TestEnv): Rooted {
  const written: Json[] = [];
  return rootOn(testEnv, handleOver(testEnv.env, written), written);
}

/** bundle v0 through T-1397's check, as the pin asks it, over the root's bound bundle port. */
async function checkV0(rooted: Rooted): Promise<void> {
  await rooted.adapter.checkPin({ bundleId: { ...V0 }, bundles: rooted.root.ports.bundles });
  expect(answeringBundleOf(rooted.adapter)).toEqual(V0);
}

/** One timing line as [call, side, binding, login]. */
type CallOn = readonly [unknown, unknown, unknown, unknown];

/** A call on the Tool API's side: a client from HYPERDRIVE_APP, as rosie_worker_app. */
const onApp = (call: string): CallOn => [call, "toolApi", DB_SIDES.toolApi.binding, DB_SIDES.toolApi.login];
/** A call on the runtime side: a client from HYPERDRIVE_JOB, as rosie_worker_job. */
const onJob = (call: string): CallOn => [call, "runtime", DB_SIDES.runtime.binding, DB_SIDES.runtime.login];

/** Each call a handle timed, in order, its every line labels and numbers only. */
function callsOf(written: readonly Json[]): CallOn[] {
  for (const line of written) {
    expect(Object.keys(line).sort()).toEqual([
      "binding",
      "call",
      "connect",
      "environment",
      "guard",
      "level",
      "login",
      "msg",
      "side",
      "trace_id",
      "version",
    ]);
    expect(line).toMatchObject({ level: "info", msg: "dbCall", environment: "staging", version: "test-sha" });
  }
  return written.map((line) => [line.call, line.side, line.binding, line.login]);
}

/** The test's own handle on this file's pair (T-1254's, each client on its quiet socket). */
const own = dbHandle(
  {
    ENVIRONMENT: "staging",
    DB_SCHEMA: "",
    HYPERDRIVE_JOB: poolBinding(JOB),
    HYPERDRIVE_APP: poolBinding(APP),
  },
  { log: () => undefined },
);

/** The made-up wrapping key, as the resolver gives it, for the test's own reads of what was sealed. */
const TEST_KEYS = { resolve: (name: string) => (name === WRAP_KEY_NAME ? TEST_WRAP_KEY : undefined) };

const COUNTED_TABLES = [
  "turns",
  "threads",
  "open_questions",
  "clock_rows",
  "outbox_rows",
  "safety_outcomes",
  "safety_holds",
  "sealing_keys",
  "persons",
  "handles",
  "event_log",
] as const;

type RowCounts = Record<(typeof COUNTED_TABLES)[number], number>;

/** The row count of every table a gate could write, as the runtime side reads it with no scope. */
function rowCounts(): Promise<RowCounts> {
  return own.runtime("rowCounts", async (sql) => {
    const out: Partial<RowCounts> = {};
    for (const table of COUNTED_TABLES) {
      const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
      out[table] = row?.n ?? -1;
    }
    return out as RowCounts;
  });
}

/** The counts after a commit that wrote these rows on top of `before`. */
const plus = (before: RowCounts, more: Partial<RowCounts>): RowCounts => {
  const out = { ...before };
  for (const [table, n] of Object.entries(more)) out[table as keyof RowCounts] += n ?? 0;
  return out;
};

// ---- what an error gives away (as T-1254's test searches it) ---------------------------------------------------------

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

/** The texts an error gives away: its message, its stack but for the frames, its own fields as JSON, and as a string. */
function textsOf(error: unknown): string[] {
  if (!(error instanceof Error)) return [String(error)];
  const stack = (error.stack ?? "")
    .split("\n")
    .filter((line) => !/^\s+at\s/u.test(line))
    .join("\n");
  const fields = Object.fromEntries(
    Object.getOwnPropertyNames(error).map((key): [string, unknown] => [key, Reflect.get(error, key)]),
  );
  return [error.message, stack, JSON.stringify(error), JSON.stringify({ ...fields, stack }), String(error)];
}

/** Whether `text` holds `part` as a whole name (not inside a longer name). */
function holds(text: string, part: string): boolean {
  const escaped = part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "u").test(text);
}

/** The parts of a binding's string no text may hold: the string, its host, user, password and database. */
function placeOf(binding: { readonly connectionString: string }): string[] {
  const url = new URL(binding.connectionString);
  return [
    binding.connectionString,
    url.host,
    url.hostname,
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
    decodeURIComponent(url.pathname.slice(1)),
  ].filter((part) => part !== "");
}

/** Every text holds none of the binding's string, host, user, password or database. */
function expectNothingOf(binding: { readonly connectionString: string }, texts: readonly string[]): void {
  const parts = placeOf(binding);
  expect(parts.length).toBeGreaterThanOrEqual(5);
  for (const text of texts) {
    for (const part of parts) expect(holds(text, part), "a text holds a part of the binding's string").toBe(false);
  }
}

// ---- the gates' requests ---------------------------------------------------------------------------------------------

/** Nothing open at commit time (the lease's CommitContext): no hold and no unread text. */
const NOTHING_OPEN = { holds: [], unread: [] };

/** K-09 v1.5 commit-s1-01.json as this file reads it. */
const S1_01 = commitS101 as unknown as {
  readonly request: Json;
  readonly outcome: Json & { readonly parts: readonly Json[] };
};

/** commit-s1-01.json's own ids, as its request and outcome name them. */
const FIXTURE = {
  turnId: "turn-s1-01-sam",
  traceId: "trace-sam-0000",
  eventId: "evt-sam-s1-01",
  outcomeId: "safety-outcome-sam-s1-01",
} as const;

/** Whose first text a gate commits: a handle, its person, its number, its text and its chat. */
interface FirstTexter {
  readonly handleId: string;
  readonly personId: string;
  readonly number: string;
  readonly eventId: string;
  readonly chatId: string;
}

/** Test owner 1's first text, as commit-s1-01.json names it. */
const TURN_ONE: FirstTexter = {
  handleId: SAM.handleId,
  personId: SAM.personId,
  number: SAM.number,
  eventId: FIXTURE.eventId,
  chatId: SAM_CHAT,
};

/** One gate call: its K-09 request, its turn id and the trace it runs in. */
interface GateCall {
  readonly request: Json;
  readonly turnId: string;
  readonly trace: TraceContext;
}

/** A trace of its own under bundle v0, set to the turn, its spans kept. */
function traced(turnId: string): TraceContext {
  const trace = openTrace({ openedBy: "textWebhook", bundleId: { ...V0 }, sink: (span) => SPANS.push(span) });
  trace.setTurn(turnId);
  return trace;
}

/**
 * commit-s1-01.json's request for `who`'s first text: every id of the fixture's swapped for the texter's wherever the
 * request names it as a whole string, under the turn id the lease hashes from its event ids (CQ-09), on a trace of its
 * own, the turn, its context and decide's result pinned to bundle v0 (as calls.int.test.ts pins them). `record` false:
 * the text's record does not ride in this commit. `businessId`: the caller's business, where it is not the fixture's.
 */
async function firstTextGate(
  who: FirstTexter,
  options: { readonly record?: boolean; readonly businessId?: string } = {},
): Promise<GateCall> {
  const turnId = await turnIdOf([who.eventId]);
  const trace = traced(turnId);
  const pairs: readonly (readonly [string, string])[] = [
    [FIXTURE.turnId, turnId],
    [FIXTURE.traceId, trace.traceId],
    [FIXTURE.eventId, who.eventId],
    [SAM.handleId, who.handleId],
    [SAM.personId, who.personId],
    [SAM_CHAT, who.chatId],
    [SAM.number, who.number],
    ...(options.businessId === undefined ? [] : [[BARBERSHOP, options.businessId] as const]),
  ];
  let text = JSON.stringify(S1_01.request);
  for (const [from, to] of pairs) text = text.replaceAll(JSON.stringify(from), JSON.stringify(to));
  const request = JSON.parse(text) as Json & {
    turn: Json;
    input: { decided: { context: Json; decide: Json } };
    core: unknown[];
  };
  request.turn.bundleId = { ...V0 };
  request.input.decided.context.bundleId = { ...V0 };
  request.input.decided.decide.bundleId = { ...V0 };
  if (options.record === false) request.core = [];
  return { request, turnId, trace };
}

/** The ask record's text again (ASK_RECORD), its record a turn's one core action: a repeat whose line asks. */
async function askGate(): Promise<GateCall> {
  const { eventId } = ASK_RECORD;
  const turnId = await turnIdOf([eventId]);
  const trace = traced(turnId);
  const caller = {
    kind: "turn",
    turnId,
    requestId: turnId,
    businessId: BARBERSHOP,
    personId: SAM.personId,
    traceId: trace.traceId,
  };
  const read = structuredClone(safetyBusinessOwnLine);
  const [label] = read.read.labels;
  if (label === undefined) throw new Error("safety-business-own-line.json holds a label");
  const safety = { ...read, eventId, read: { labels: [{ ...label, tense: ASK_RECORD.tense }] } };
  const request = {
    caller,
    turn: {
      id: turnId,
      handleId: SAM.handleId,
      eventIds: [eventId],
      bundleId: { ...V0 },
      traceId: trace.traceId,
      joinedTraceIds: [],
      tries: 1,
    },
    input: { kind: "coreOnly" },
    core: [
      {
        call: "recordSafetyOutcome",
        request: { caller, safety, handleId: SAM.handleId, bookingId: null, sentByActor: null },
      },
    ],
    now: "2026-10-19T18:31:05Z",
  };
  return { request, turnId, trace };
}

/** One gateAndCommit through the root's turn face, as the turn makes it (a closed port's throw as a rejection). */
async function gateOn(root: Root, call: GateCall): Promise<unknown> {
  return root.turn.toolApi.gateAndCommit(call.request as never, NOTHING_OPEN, call.trace);
}

/** An instant in UTC ending in Z (formats.v1 utc). */
const UTC_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$/u;

/** The fixture's ids, built from the run's turn id instead (K-09 v1.5 default 131), as hop 8's test builds them. */
function asRun<T>(value: T, turnId: string): T {
  return JSON.parse(JSON.stringify(value).replaceAll('-sam-1"', `-${turnId}-1"`)) as T;
}

/** commit-s1-01.json's outcome for a first text committed under `turnId`, its record's id the service's keyed one. */
async function committedFirstText(who: FirstTexter, turnId: string): Promise<Json> {
  const outcomeId = await KEYED_SAFETY_IDS.rowId("outcome", who.eventId);
  const outcome = JSON.parse(
    JSON.stringify(asRun(S1_01.outcome, turnId))
      .replaceAll(JSON.stringify(FIXTURE.turnId), JSON.stringify(turnId))
      .replaceAll(JSON.stringify(FIXTURE.outcomeId), JSON.stringify(outcomeId)),
  ) as Json & { written: { outboxRows: Json[] } };
  return {
    ...outcome,
    committedAt: expect.stringMatching(UTC_INSTANT) as string,
    written: {
      ...outcome.written,
      outboxRows: outcome.written.outboxRows.map((row) => ({ ...row, commitSeq: expect.any(Number) as number })),
    },
  };
}

/** A first text's rows as this file's database holds them, read on the runtime side. */
function firstTextRows(who: FirstTexter, turnId: string): Promise<Json> {
  return own.runtime("firstTextRows", async (sql) => {
    const [turn] = await sql<Json[]>`
      select state, handle_id, event_ids, trace_id, bundle_hash as hash, bundle_build as build from turns
      where id = ${turnId}
    `;
    const [thread] = await sql<Json[]>`
      select handle_id, kind, booking_id, linq_chat_id, reply_address from threads where id = ${`thread-s1-01-${turnId}-1`}
    `;
    const [question] = await sql<Json[]>`
      select status, step, handle_id, person_id, business_id from open_questions where id = ${`oq-s1-02-${turnId}-1`}
    `;
    const [clock] = await sql<Json[]>`
      select kind, state, open_question_id from clock_rows where id = ${`clock-oq-s1-02-${turnId}-1`}
    `;
    const [outbox] = await sql<Json[]>`
      select turn_id, state, channel, send_class, open_question_id, recipient_handle_id, plan from outbox_rows
      where id = ${`outbox-s1-02-${turnId}-1`}
    `;
    const [record] = await sql<Json[]>`
      select id, turn_id, business_id, handle_id, person_id, outcomes, labels from safety_outcomes
      where event_id = ${who.eventId}
    `;
    return { turn, thread, question, clock, outbox, record };
  });
}

/** What firstTextRows reads for a first text committed as commit-s1-01.json states it. */
async function firstTextStored(who: FirstTexter, turnId: string, traceId: string): Promise<Json> {
  return {
    turn: {
      state: "committed",
      handle_id: who.handleId,
      event_ids: [who.eventId],
      trace_id: traceId,
      ...V0,
    },
    thread: { handle_id: who.handleId, kind: "chat", booking_id: null, linq_chat_id: who.chatId, reply_address: null },
    question: {
      status: "waiting",
      step: "S1-02",
      handle_id: who.handleId,
      person_id: who.personId,
      business_id: BARBERSHOP,
    },
    clock: { kind: "question", state: "waiting", open_question_id: `oq-s1-02-${turnId}-1` },
    outbox: {
      turn_id: turnId,
      state: "planned",
      channel: "imessage",
      send_class: "quick_reply",
      open_question_id: `oq-s1-02-${turnId}-1`,
      recipient_handle_id: who.handleId,
      plan: null,
    },
    record: {
      id: await KEYED_SAFETY_IDS.rowId("outcome", who.eventId),
      turn_id: turnId,
      business_id: BARBERSHOP,
      handle_id: who.handleId,
      person_id: who.personId,
      outcomes: ["No"],
      labels: ["No"],
    },
  };
}

/** What one first text's commit writes, on top of the counts before it (its event-log entries apart). */
const FIRST_TEXT_ROWS: Partial<RowCounts> = {
  turns: 1,
  threads: 1,
  open_questions: 1,
  clock_rows: 1,
  outbox_rows: 1,
  safety_outcomes: 1,
};

/**
 * Counts compared, the event log by whether it grew: a commit that writes rows appends their entries, and one that writes
 * its turn row alone appends none (the turn row has no entry of its own).
 */
async function expectCountsAfter(
  before: RowCounts,
  more: Partial<RowCounts>,
  log: "grows" | "same",
): Promise<RowCounts> {
  const after = await rowCounts();
  expect({ ...after, event_log: 0 }).toEqual({ ...plus(before, more), event_log: 0 });
  if (log === "grows") expect(after.event_log).toBeGreaterThan(before.event_log);
  else expect(after.event_log).toBe(before.event_log);
  return after;
}

// ---- side by side ----------------------------------------------------------------------------------------------------

interface HeldOpen {
  readonly db: StagingDb;
  /**
   * From now on each runtime-side call waits until `n` Tool API clients are in use at once (each past its guard, inside
   * its call), then every call runs as it came: so each Tool API client is held while the runtime-side calls run.
   */
  arm(n: number): void;
  /** The most Tool API clients in use at once since the wrapper was made. */
  toolApiPeak(): number;
}

/** A root (rootOn) whose handle's runtime-side calls wait as `arm` says (heldOpen), and that wrapper. */
function rootHeldOpen(testEnv: TestEnv): { readonly rooted: Rooted; readonly held: HeldOpen } {
  const written: Json[] = [];
  const held = heldOpen(handleOver(testEnv.env, written));
  return { rooted: rootOn(testEnv, held.db, written), held };
}

/** A handle whose runtime-side calls wait as `arm` says. Only the order is held: every call is the handle's own. */
function heldOpen(db: StagingDb): HeldOpen {
  let inUse = 0;
  let peak = 0;
  let wanted = 0;
  let release: () => void = () => undefined;
  let open: Promise<void> = Promise.resolve();
  return {
    arm(n) {
      wanted = n;
      open = new Promise((resolve) => {
        release = resolve;
      });
    },
    toolApiPeak: () => peak,
    db: {
      toolApi<T>(call: string, fn: (sql: Sql) => Promise<T>, traceId?: string | null): Promise<T> {
        return db.toolApi(
          call,
          async (sql) => {
            inUse += 1;
            peak = Math.max(peak, inUse);
            if (inUse >= wanted) release();
            try {
              return await fn(sql);
            } finally {
              inUse -= 1;
            }
          },
          traceId,
        );
      },
      async runtime<T>(call: string, fn: (sql: Sql) => Promise<T>, traceId?: string | null): Promise<T> {
        await open;
        return db.runtime(call, fn, traceId);
      },
      counts: () => db.counts(),
    },
  };
}

// ---- the secrets no line may hold -----------------------------------------------------------------------------------

/** Every number of this file's handles, in each form a number could leak in (each whole number as it is, then cut). */
const NUMBER_FORMS = [SAM, ...SIDE_BY_SIDE, ...SIX_AT_ONCE, NO_WRAP_KEY, NO_KEY].flatMap(({ number }) => [
  number,
  number.slice(1),
  number.slice(2),
]);

/** The words a text, a read or a seal holds here, and the fixed lines' words bundle v0 holds. */
const WORDS = [
  ...(S1_01.request.input as { decided: { context: { texts: { words: string }[] } } }).decided.context.texts.map(
    (text) => text.words,
  ),
  ...safetyBusinessOwnLine.read.labels.map((label) => label.evidence),
  "t1398 words to seal",
  ...["safetyAsk", "safetyEmergency", "safetyCrisis", "outage"].map((id) => bundleV0FixedLine(id)),
];

/** The sealed values read back in this file's tests, as base64 and hex: none may reach a line. */
const SEALED: string[] = [];

const hexOf = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const base64Of = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

/** No text holds a word, a number, the address, the wrapping key, a chat id or a sealed value. */
function expectNoSecrets(texts: readonly string[]): void {
  const secrets = [
    ...WORDS,
    ...NUMBER_FORMS,
    SAM_EMAIL.address,
    TEST_WRAP_KEY,
    SAM_CHAT,
    ...[...SIDE_BY_SIDE, ...SIX_AT_ONCE].map((texter) => texter.chatId),
    ...SEALED,
  ];
  for (const text of texts) {
    for (const secret of secrets) expect(text, "a line holds a secret").not.toContain(secret);
  }
}

// ---- this file's database --------------------------------------------------------------------------------------------

describe("this file's database: the walking skeleton's rows, the made-up key's rows and the two records", () => {
  it("the rig made this file's database with bundle v0 active; the seed made Sam's key and each texter's under the made-up SEALING_WRAP_KEY, none for the no-key person, and wrote the two records", async () => {
    expect(DATABASE).toMatch(/^rosie_rig_[0-9a-f]{8}_tool_api_gate$/u);
    const active = await own.runtime("readActiveBundle", (sql) => readActiveBundle(sql));
    expect(active).toMatchObject({ result: "active", bundleId: V0 });

    const stored = await own.runtime("seeded", async (sql) => ({
      keys: await sql<{ person_id: string; wrapping_key_name: string }[]>`
        select person_id, wrapping_key_name from sealing_keys order by person_id collate "C"
      `,
      samRoles: await sql<{ id: string }[]>`select id from person_roles where person_id = ${SAM.personId}`,
      records: await sql<{ event_id: string; business_id: string; outcomes: string[]; tenses: string[] }[]>`
        select event_id, business_id, outcomes, tenses from safety_outcomes order by event_id
      `,
      lineRow: await sql<{ id: string; send_class: string }[]>`
        select id, send_class from outbox_rows where turn_id = ${ASK_RECORD.turnId}
      `,
    }));
    const keyed = [SAM.personId, ...[...SIDE_BY_SIDE, ...SIX_AT_ONCE, NO_WRAP_KEY].map((each) => each.personId)];
    expect(stored.keys).toEqual(
      keyed.sort().map((personId) => ({ person_id: personId, wrapping_key_name: WRAP_KEY_NAME })),
    );
    expect(stored.keys.map((key) => key.person_id)).not.toContain(NO_KEY.personId);
    // T-1148's Sam: no role, so turn 1 is a first text.
    expect(stored.samRoles).toEqual([]);
    expect(stored.records).toEqual([
      { event_id: ASK_RECORD.eventId, business_id: BARBERSHOP, outcomes: [ASK_RECORD.outcome], tenses: ["unknown"] },
      { event_id: OTHER_BUSINESS_RECORD.eventId, business_id: YOGA_STUDIO, outcomes: ["No"], tenses: ["now"] },
    ]);
    expect(stored.lineRow).toEqual([
      { id: await KEYED_SAFETY_IDS.rowId("line", ASK_RECORD.eventId), send_class: "safety" },
    ]);
  });
});

// ---- built ---------------------------------------------------------------------------------------------------------

describe("built on staging: the five pieces, and nothing read but the environment and the two bindings' presence", () => {
  it("with both bindings: reads ENVIRONMENT, then each binding's presence, and no connection string or secret; holds scope, readOpenHolds, the seven safety reads, the sealer and the words, and no reader of its own", () => {
    const testEnv = envOf();
    const written: Json[] = [];
    const db = handleOver(testEnv.env, written);
    const adapter: BundleSafetyLines = {
      fixedLine: () => null,
      outcomeLine: () => null,
      dangerWords: () => [],
      checkPin: () => Promise.resolve(),
    };
    const part: GatePart = { env: testEnv.env, db, keys: sealingWrapKeys(testEnv.env), bundleSafety: adapter };

    const reads = stagingGateReads(part);

    expect(testEnv.names).toEqual(["ENVIRONMENT", "HYPERDRIVE_JOB", "HYPERDRIVE_APP"]);
    expect([testEnv.job?.reads.n, testEnv.app?.reads.n]).toEqual([0, 0]);
    expect(Object.keys(reads ?? {}).sort()).toEqual(["readOpenHolds", "safetyReads", "scope", "sealer", "words"]);
    expect(Object.keys(reads?.safetyReads ?? {}).sort()).toEqual([
      "businessOwner",
      "businessZone",
      "hold",
      "holdOfOutcome",
      "outboxRowWritten",
      "outcome",
      "outcomeOfEvent",
    ]);
    // No adapter: the words are left out, the safety service's own default (notBuilt for a line that asks).
    expect(Object.keys(stagingGateReads({ ...part, bundleSafety: null }) ?? {}).sort()).toEqual([
      "readOpenHolds",
      "safetyReads",
      "scope",
      "sealer",
    ]);
    // No call was made to build it.
    expect(written).toEqual([]);
    expect(db.counts()).toMatchObject({ opened: 0, ended: 0 });
    expect(GATE_CLIENTS_AT_ONCE * 2 * CONNECTIONS_PER_CLIENT).toBe(WORKER_CONNECTIONS);
  });

  it("through stagingOptions with every other part stood in (DL-776): it reads only ENVIRONMENT (stagingOptions' own check, then this part's) and the two presences, and its part is handed the one adapter the bundleSafety builder made, whose lines its words read", () => {
    const testEnv = envOf();
    const words = new Map([["safetyAsk", "t1398 stand-in words"]]);
    const adapter: BundleSafetyLines = {
      fixedLine: (id) => {
        const text = words.get(id);
        return text === undefined ? null : { id, text };
      },
      outcomeLine: () => null,
      dangerWords: () => [],
      checkPin: () => Promise.resolve(),
    };
    const handed: GatePart[] = [];
    const inputs = stagingOptions(testEnv.env, {
      db: handleOver(testEnv.env, []),
      builders: {
        ...EVERY_OTHER_PART_UNBOUND,
        bundleSafety: () => adapter,
        gate: (part) => {
          handed.push(part);
          return stagingGateReads(part);
        },
      },
    });

    expect(testEnv.names).toEqual(["ENVIRONMENT", "ENVIRONMENT", "HYPERDRIVE_JOB", "HYPERDRIVE_APP"]);
    expect([testEnv.job?.reads.n, testEnv.app?.reads.n]).toEqual([0, 0]);
    expect(handed).toHaveLength(1);
    expect(handed[0]?.bundleSafety).toBe(adapter);
    expect(inputs.bundleSafety).toBe(adapter);
    const gate = inputs.gateReads;
    if (gate === null) throw new Error("the gate is bound with both bindings");
    expect(gate.words?.fixedLine("safetyAsk")).toEqual({ id: "safetyAsk", text: "t1398 stand-in words" });
    expect(gate.words?.fixedLine("safetyCrisis")).toBeNull();
    // Nothing else of its input but the five pieces.
    expect(Object.keys(gate).sort()).toEqual(["readOpenHolds", "safetyReads", "scope", "sealer", "words"]);
  });

  it("unbound: with neither binding, or either alone, the input is null, with nothing read but ENVIRONMENT and the presences", () => {
    for (const bindings of [
      { job: null, app: null },
      { job: JOB, app: null },
      { job: null, app: APP },
    ]) {
      const testEnv = envOf(bindings);
      const db = handleOver(testEnv.env, []);
      const reads = stagingGateReads({ env: testEnv.env, db, keys: sealingWrapKeys(testEnv.env), bundleSafety: null });
      expect(reads, JSON.stringify(bindings)).toBeNull();
      expect(testEnv.names).toEqual(["ENVIRONMENT", "HYPERDRIVE_JOB", "HYPERDRIVE_APP"]);
      expect([testEnv.job?.reads.n ?? 0, testEnv.app?.reads.n ?? 0]).toEqual([0, 0]);
    }
  });
});

// ---- the reads before turn 1 -----------------------------------------------------------------------------------------

describe("the reads as their K-05 fixtures, before turn 1 commits", () => {
  it("the scope runs as rosie_worker_app under the call's business; read-safety-outcome-of-event-s1-01 finds nothing for Sam's first text; business-zone-barbershop; readOpenHolds lists the text unread while no record of it is stored", async () => {
    const { gate, written, db } = rootOver(envOf());
    const read = await gate.scope.withBusiness(BARBERSHOP, async (repo) => {
      const tx = repo as Sql;
      const [who] = await tx<{ session_login: string; current_login: string; scope: string | null }[]>`
        select session_user::text as session_login, current_user::text as current_login,
               current_setting('rosie.business_id', true) as scope
      `;
      return {
        who,
        outcome: await gate.safetyReads.outcomeOfEvent(repo, structuredClone(readSafetyOutcomeOfEventS101.request)),
        zone: await gate.safetyReads.businessZone(repo, structuredClone(businessZoneBarbershop.request)),
        open: await gate.readOpenHolds(repo, {
          handleId: SAM.handleId,
          businessId: BARBERSHOP,
          eventIds: [FIXTURE.eventId],
        }),
      };
    });

    const login = DB_SIDES.toolApi.login;
    expect(read.who).toEqual({ session_login: login, current_login: login, scope: BARBERSHOP });
    // The fixtures' answers, but for readAt: the database's own now, where each fixture's is its given clock.
    expect(read.outcome).toEqual({
      ...readSafetyOutcomeOfEventS101.outcome,
      readAt: expect.stringMatching(UTC_INSTANT) as string,
    });
    expect(read.zone).toEqual({ ...businessZoneBarbershop.outcome, readAt: expect.stringMatching(UTC_INSTANT) as string });
    // A text with no record is named to readOpenHolds and listed unread (ADR-015 line 113).
    expect(read.open).toEqual({
      result: "openHolds",
      handleId: SAM.handleId,
      businessId: BARBERSHOP,
      readAt: expect.stringMatching(UTC_INSTANT) as string,
      holds: [],
      unreadEventIds: [FIXTURE.eventId],
    });
    // One client, on the Tool API's side, for the whole call: the In reads ran on its transaction.
    expect(callsOf(written)).toEqual([onApp(GATE_CALLS.scope)]);
    expect(written.map((line) => line.trace_id)).toEqual([null]);
    expect(db.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0, connectionsPeak: 1 });
  });
});

// ---- the words and the danger question ---------------------------------------------------------------------------

describe("SafetyDeps.words from T-1397's adapter, read at each call, only from a bundle its check passed", () => {
  it("before any check the words are no port: the ask record's repeat (a line that asks the danger question) answers notBuilt and writes nothing; once bundle v0 passes the check its words are v0's, word for word, and the same gate commits, its record a repeat naming the first line", async () => {
    const before = await rowCounts();
    const rooted = rootOver(envOf());
    const { root, adapter } = rooted;
    const words = rooted.gate.words;
    if (words === undefined) throw new Error("the gate's part is handed the adapter");

    // No check passed in this root's adapter: no bundle's words are known.
    expect(answeringBundleOf(adapter)).toBeNull();
    expect(() => words.fixedLine("safetyAsk")).toThrow(NotBuiltError);
    const lineId = await KEYED_SAFETY_IDS.rowId("line", ASK_RECORD.eventId);
    expect(await gateOn(root, await askGate())).toEqual({ error: "notBuilt", call: "gateAndCommit" });
    expect(await rowCounts()).toEqual(before);

    await checkV0(rooted);
    for (const id of ["safetyAsk", "safetyEmergency", "safetyCrisis", "outage"]) {
      expect(words.fixedLine(id), id).toEqual({ id, text: bundleV0FixedLine(id) });
    }
    expect(words.fixedLine("t1398-no-such-line")).toBeNull();

    const call = await askGate();
    const answer = await gateOn(root, call);
    expect(answer).toMatchObject({
      result: "committed",
      turnId: call.turnId,
      repeated: false,
      parts: [],
      core: [
        {
          call: "recordSafetyOutcome",
          error: null,
          response: {
            outcomeId: await KEYED_SAFETY_IDS.rowId("outcome", ASK_RECORD.eventId),
            outcomes: [ASK_RECORD.outcome],
            hold: null,
            safetyLine: { fixedLineId: "safetyEmergency", outboxRowId: lineId },
            told: [],
            nothingBooks: false,
            repeated: true,
          },
        },
      ],
      written: { written: [], outboxRows: [], promoted: [] },
    });
    // The record was a repeat: only the turn row is new, no record, hold, line row or entry.
    await expectCountsAfter(before, { turns: 1 }, "same");
  });
});

// ---- turn 1's gate ------------------------------------------------------------------------------------------------

/** Turn 1's call and its sealed record's bytes, kept for the tests after it. */
let turnOne: GateCall | null = null;

describe("turn 1's gate: K-09 v1.5 commit-s1-01.json's request commits once, through PostgreSQL", () => {
  it(
    "commits its turns row and the rows commit-s1-01.json names (the thread, S1-02's question, its clock row, the outbox row, the No record sealed under Sam's own key); the scope ran as rosie_worker_app and the commit as rosie_worker_job; the same turn id again answers the first commit with nothing written",
    { timeout: TEST_MS },
    async () => {
      const before = await rowCounts();
      const rooted = rootOver(envOf());
      await checkV0(rooted);
      const checked = rooted.written.length;
      const call = await firstTextGate(TURN_ONE);
      turnOne = call;

      const first = await gateOn(rooted.root, call);

      expect(first).toEqual(await committedFirstText(TURN_ONE, call.turnId));
      await expectCountsAfter(before, FIRST_TEXT_ROWS, "grows");
      expect(await firstTextRows(TURN_ONE, call.turnId)).toEqual(
        await firstTextStored(TURN_ONE, call.turnId, call.trace.traceId),
      );

      // The record's words, sealed under Sam's existing key, open under it again with the made-up wrapping key.
      const sealed = await own.runtime("sealedWords", async (sql) => {
        const [row] = await sql<{ sealed_words: Uint8Array | null }[]>`
          select sealed_words from safety_outcomes where event_id = ${TURN_ONE.eventId}
        `;
        if (row?.sealed_words == null) throw new Error("the record's words are sealed");
        const bytes = new Uint8Array(row.sealed_words);
        return { bytes, words: await unsealText(sql, TEST_KEYS, SAM.personId, bytes) };
      });
      SEALED.push(base64Of(sealed.bytes), hexOf(sealed.bytes));
      expect(JSON.parse(sealed.words)).toEqual({
        labels: [{ evidence: "", atRisk: "nobody", writer: "the person at the handle" }],
        dangerWords: [],
      });

      // Each call of the gate: the scope's client first, as rosie_worker_app, held for the whole call; every other on the
      // runtime side, as rosie_worker_job: the bundle reads, the seal and the commit, whose line is on the turn's trace.
      const gateLines = rooted.written.slice(checked);
      const calls = callsOf(gateLines);
      expect(calls[0]).toEqual(onApp(GATE_CALLS.scope));
      expect(calls.at(-1)).toEqual(onJob("commitTurn"));
      expect(calls.filter(([, side]) => side === "toolApi")).toEqual([onApp(GATE_CALLS.scope)]);
      expect(calls.filter(([, side]) => side === "runtime")).toEqual(
        calls.filter(([, side]) => side === "runtime").map(([name]) => onJob(String(name))),
      );
      expect(calls.map(([name]) => name)).toContain(GATE_CALLS.seal);
      expect(gateLines.at(-1)?.trace_id).toBe(call.trace.traceId);
      // ADR-014 line 198: the commit's current_user is the login its client's guard read, rosie_worker_job.
      expect(gateLines.at(-1)?.login).toBe("rosie_worker_job");
      const counts = rooted.db.counts();
      expect(counts).toMatchObject({ opened: rooted.written.length, ended: rooted.written.length, connectionsOpen: 0 });
      expect(counts.connectionsPeak).toBe(2 * CONNECTIONS_PER_CLIENT);

      // The same turn id again: K-05 answers the first commit, repeated, and nothing is written.
      const written = await rowCounts();
      const again = await gateOn(rooted.root, { ...call, request: structuredClone(call.request) });
      expect(again).toMatchObject({ result: "committed", turnId: call.turnId, repeated: true });
      expect((again as { written: { written: unknown[] } }).written.written).toEqual([]);
      expect(await rowCounts()).toEqual(written);
    },
  );
});

// ---- after turn 1: the other business, and the owner ---------------------------------------------------------------

describe("after turn 1: another business's scope, a text whose outcome another business holds, and the owner", () => {
  it("read-open-holds-other-business: under the yoga studio's scope Sam's first text, whose record is the barbershop's, counts as unread and no hold is listed; under the barbershop's it is read", async () => {
    const { gate } = rootOver(envOf());
    const ask = (businessId: string) =>
      gate.scope.withBusiness(businessId, (repo) =>
        gate.readOpenHolds(repo, { handleId: SAM.handleId, businessId, eventIds: [FIXTURE.eventId] }),
      );

    // The fixture's answer on this world: Sam's handle and his first text in place of Alex's (evt-alex-0204's record is
    // the barbershop's there, as Sam's is here).
    expect(readOpenHoldsOtherBusiness.request.businessId).toBe(YOGA_STUDIO);
    expect(await ask(YOGA_STUDIO)).toEqual({
      ...readOpenHoldsOtherBusiness.outcome,
      handleId: SAM.handleId,
      readAt: expect.stringMatching(UTC_INSTANT) as string,
      unreadEventIds: [FIXTURE.eventId],
    });
    expect(await ask(BARBERSHOP)).toMatchObject({ holds: [], unreadEventIds: [] });
  });

  it("so every routine part is held: a gate whose text's outcome the yoga studio holds, its record not riding in the commit, answers its one part held (no limit checked) and writes its turn row alone", async () => {
    const before = await rowCounts();
    const { root } = rootOver(envOf());
    const call = await firstTextGate({ ...TURN_ONE, eventId: OTHER_BUSINESS_RECORD.eventId }, { record: false });

    const answer = await gateOn(root, call);

    expect(answer).toMatchObject({
      result: "committed",
      turnId: call.turnId,
      repeated: false,
      parts: [{ part: 0, choiceId: "c-01", result: "held" }],
      core: [],
      written: { written: [], outboxRows: [], promoted: [] },
    });
    const [part] = (answer as { parts: { limits: { result: string }[] }[] }).parts;
    expect(part?.limits.map((limit) => limit.result)).toEqual(Array.from({ length: 6 }, () => "notChecked"));
    await expectCountsAfter(before, { turns: 1 }, "same");
  });

  it("business-owner-phone-first: with Sam the barbershop's owner and his proven email handle, the owner is read on the runtime side as rosie_worker_job, his phone handle first", async () => {
    await own.runtime("writeOwnerRows", writeOwnerRows);
    const { gate, written, db } = rootOver(envOf());

    const owner = await gate.safetyReads.businessOwner(structuredClone(businessOwnerPhoneFirst.request));

    expect(owner).toEqual({
      ...businessOwnerPhoneFirst.outcome,
      readAt: expect.stringMatching(UTC_INSTANT) as string,
    });
    expect(callsOf(written)).toEqual([onJob(GATE_CALLS.businessOwner)]);
    expect(db.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0 });
  });
});

// ---- the read-only sealer -------------------------------------------------------------------------------------------

describe("the read-only sealer: an existing key only, the wrapping key by name at each seal, every error scrubbed", () => {
  it("seals under Sam's existing key (the bytes open with it again) and makes no key; refuses a person with no key (noSealingKey) and makes none; each seal on a runtime-side client of its own", async () => {
    const before = await rowCounts();
    const { gate, written } = rootOver(envOf());

    const sealed = await gate.sealer.seal("t1398 words to seal", SAM.personId);
    SEALED.push(base64Of(sealed), hexOf(sealed));
    expect(await own.runtime("unseal", (sql) => unsealText(sql, TEST_KEYS, SAM.personId, sealed))).toBe(
      "t1398 words to seal",
    );

    const refused = await rejectionOf(gate.sealer.seal("t1398 words to seal", NO_KEY.personId));
    expect(refused).toBeInstanceOf(TurnFaceRefusedError);
    expect(refused).toMatchObject({ fault: "noSealingKey" });
    for (const text of textsOf(refused)) expect(text).not.toContain(NO_KEY.personId);

    expect(await rowCounts()).toEqual(before);
    expect(callsOf(written)).toEqual([onJob(GATE_CALLS.seal), onJob(GATE_CALLS.seal)]);
  });

  it("through the gate, a first text whose writer holds no key fails closed (noSealingKey) and writes nothing", async () => {
    const before = await rowCounts();
    const { root } = rootOver(envOf());
    const thrown = await rejectionOf(gateOn(root, await firstTextGate(NO_KEY)));
    expect(thrown).toBeInstanceOf(TurnFaceRefusedError);
    expect(thrown).toMatchObject({ fault: "noSealingKey" });
    expect(await rowCounts()).toEqual(before);
  });

  it("with SEALING_WRAP_KEY left out of the env: the seal fails with its code alone (wrapping_key_missing, the fixed words) and, through the gate, the commit writes nothing", async () => {
    const before = await rowCounts();
    const testEnv = envOf({ wrapKey: false });
    const { root, gate, written } = rootOver(testEnv);

    const direct = await rejectionOf(gate.sealer.seal("t1398 words to seal", NO_WRAP_KEY.personId));
    const viaGate = await rejectionOf(gateOn(root, await firstTextGate(NO_WRAP_KEY)));

    for (const thrown of [direct, viaGate]) {
      expect(thrown).toBeInstanceOf(SealingError);
      expect(thrown).toMatchObject({ name: "SealingError", code: "wrapping_key_missing" });
      expect((thrown as Error).message).toBe(new SealingError("wrapping_key_missing").message);
      expect(Object.keys(thrown as Error).sort()).toEqual(["code", "name"]);
      for (const text of textsOf(thrown)) expect(text).not.toContain(NO_WRAP_KEY.personId);
    }
    // The secret was asked for by its name alone, at the seal; the seal's call is named on its timing line.
    expect(testEnv.names.filter((name) => name === WRAP_KEY_NAME).length).toBeGreaterThanOrEqual(2);
    expect(callsOf(written).filter(([name]) => name === GATE_CALLS.seal)).toEqual([
      onJob(GATE_CALLS.seal),
      onJob(GATE_CALLS.seal),
    ]);
    expect(await rowCounts()).toEqual(before);
  });
});

// ---- side by side -------------------------------------------------------------------------------------------------

describe("gates side by side (the audit's two rows composed side by side; critic_collisions N2, critic_size N6; DL-760, DL-761)", () => {
  it(
    "two gates at once, two seeded handles' first texts, each holding its Tool API client while its seal and commit open runtime-side clients, and two scopes at once each holding its client while the owner's read and a seal open theirs: every call finishes under the cap, 4 connections at once, opened equal to ended",
    { timeout: TEST_MS },
    async () => {
      const before = await rowCounts();
      const { rooted, held: wrapper } = rootHeldOpen(envOf());
      await checkV0(rooted);

      wrapper.arm(SIDE_BY_SIDE.length);
      const calls = await Promise.all(SIDE_BY_SIDE.map((texter) => firstTextGate(texter)));
      const answers = await Promise.all(calls.map((call) => gateOn(rooted.root, call)));
      for (const [at, texter] of SIDE_BY_SIDE.entries()) {
        const call = calls[at];
        if (call === undefined) throw new Error("a call for each texter");
        expect(answers[at], texter.handleId).toEqual(await committedFirstText(texter, call.turnId));
        expect(await firstTextRows(texter, call.turnId)).toEqual(
          await firstTextStored(texter, call.turnId, call.trace.traceId),
        );
      }
      expect(wrapper.toolApiPeak()).toBe(2);
      expect(rooted.db.counts()).toMatchObject({ connectionsOpen: 0, connectionsPeak: 4 });

      // Two scopes at once, each reading the owner and sealing on the runtime side while its own transaction is held.
      wrapper.arm(2);
      const both = await Promise.all(
        [SAM.personId, SIDE_BY_SIDE[0]?.personId ?? ""].map((personId) =>
          rooted.gate.scope.withBusiness(BARBERSHOP, async () => {
            const owner = await rooted.gate.safetyReads.businessOwner({ businessId: BARBERSHOP });
            const sealed = await rooted.gate.sealer.seal("t1398 words to seal", personId);
            SEALED.push(base64Of(sealed), hexOf(sealed));
            return owner;
          }),
        ),
      );
      expect(both).toMatchObject([
        { result: "businessOwner", owner: businessOwnerPhoneFirst.outcome.owner },
        { result: "businessOwner", owner: businessOwnerPhoneFirst.outcome.owner },
      ]);

      const counts = rooted.db.counts();
      expect(counts).toMatchObject({ opened: rooted.written.length, ended: rooted.written.length, connectionsOpen: 0 });
      expect(counts.connectionsPeak).toBe(2 * 2 * CONNECTIONS_PER_CLIENT);
      expect(counts.connectionsPeak).toBeLessThanOrEqual(WORKER_CONNECTIONS);
      await expectCountsAfter(
        before,
        {
          turns: 2,
          threads: 2,
          open_questions: 2,
          clock_rows: 2,
          outbox_rows: 2,
          safety_outcomes: 2,
        },
        "grows",
      );
    },
  );

  it(
    "six gates at once, six seeded handles' first texts: at most 3 hold a Tool API client at once and the others wait; all six commit, the connections at once stay at 6 or fewer, and opened equals ended",
    { timeout: TEST_MS },
    async () => {
      const before = await rowCounts();
      const { rooted, held: wrapper } = rootHeldOpen(envOf());
      await checkV0(rooted);
      const calls = await Promise.all(SIX_AT_ONCE.map((texter) => firstTextGate(texter)));

      // Every runtime-side call waits until as many Tool API clients are in use as the binding lets at once: each of
      // those holds its client while its seal and commit run, the worst the binding allows.
      wrapper.arm(Math.min(SIX_AT_ONCE.length, GATE_CLIENTS_AT_ONCE));
      const answers = await Promise.all(calls.map((call) => gateOn(rooted.root, call)));

      for (const [at, texter] of SIX_AT_ONCE.entries()) {
        const call = calls[at];
        if (call === undefined) throw new Error("a call for each texter");
        expect(answers[at], texter.handleId).toEqual(await committedFirstText(texter, call.turnId));
      }
      expect(wrapper.toolApiPeak()).toBe(GATE_CLIENTS_AT_ONCE);
      const counts = rooted.db.counts();
      expect(counts).toMatchObject({ opened: rooted.written.length, ended: rooted.written.length, connectionsOpen: 0 });
      expect(counts.connectionsPeak).toBeLessThanOrEqual(WORKER_CONNECTIONS);
      const sides = callsOf(rooted.written);
      expect(sides.filter(([name]) => name === GATE_CALLS.scope)).toHaveLength(SIX_AT_ONCE.length);
      expect(sides.filter(([name]) => name === "commitTurn")).toHaveLength(SIX_AT_ONCE.length);
      await expectCountsAfter(
        before,
        Object.fromEntries(
          Object.entries(FIRST_TEXT_ROWS).map(([table, n]) => [table, (n ?? 0) * SIX_AT_ONCE.length]),
        ) as Partial<RowCounts>,
        "grows",
      );
    },
  );
});

// ---- failing closed -----------------------------------------------------------------------------------------------

describe("failing closed: every gate fails inside the Tool API base, nothing written, labels only", () => {
  it("bindings left out (neither, or either alone): the input is null, so the gate fails closed inside the base (NoDatabaseError naming gateAndCommit) before anything is read or written; no binding's string is read and no call is timed", async () => {
    const before = await rowCounts();
    for (const bindings of [
      { job: null, app: null },
      { job: JOB, app: null },
      { job: null, app: APP },
    ]) {
      const testEnv = envOf(bindings);
      const written: Json[] = [];
      const db = handleOver(testEnv.env, written);
      const inputs = stagingOptions(testEnv.env, { db, builders: OFF_THE_GATE_PATH });
      expect(inputs.gateReads, JSON.stringify(bindings)).toBeNull();
      const root = composeRoot({ environment: "staging", actors: null, vars: testEnv.env, ...inputs });

      const thrown = await rejectionOf(gateOn(root, await firstTextGate(NO_WRAP_KEY)));

      expect(thrown).toEqual(new NoDatabaseError("gateAndCommit"));
      expect((thrown as Error).message).toBe("no database is bound here for gateAndCommit");
      expect([testEnv.job?.reads.n ?? 0, testEnv.app?.reads.n ?? 0]).toEqual([0, 0]);
      expect(written).toEqual([]);
      expect(db.counts()).toMatchObject({ opened: 0, ended: 0 });
      // Nothing is logged: no binding is read, so none is named, and the error names the call alone.
      expect(lines).toEqual([]);
    }
    expect(await rowCounts()).toEqual(before);
  });

  it("the pool's own HYPERDRIVE_APP (its database, rosie_rig_none, never made): the gate's scope fails with the call's name and SQLSTATE only, nothing of the binding's string in what is thrown, nothing read or written", async () => {
    const before = await rowCounts();
    const { root, written, db } = rootOver(envOf({ app: POOL_APP }));

    const thrown = await rejectionOf(gateOn(root, await firstTextGate(NO_WRAP_KEY)));

    expect(thrown).toBeInstanceOf(DataAccessDatabaseError);
    expect(thrown).toMatchObject({ call: GATE_CALLS.scope, code: "3D000", table: null, constraint: null });
    expect((thrown as Error).message).toBe(`${GATE_CALLS.scope}: the database refused the call (SQLSTATE 3D000)`);
    expect(Object.keys(thrown as Error).sort()).toEqual(["call", "code", "constraint", "name", "table"]);
    for (const name of [POOL_APP, POOL_JOB, APP, JOB]) expectNothingOf(poolBinding(name), textsOf(thrown));
    // The guard never passed: no call was timed; the one client opened was ended.
    expect(written).toEqual([]);
    expect(db.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0 });
    expect(await rowCounts()).toEqual(before);
  });

  it("a read's error answer is thrown, never read as none (K-05 v1.4 default 61): a gate under a business this database does not hold fails at readOpenHolds' notFound, and writes nothing", async () => {
    const before = await rowCounts();
    const { root } = rootOver(envOf());
    const thrown = await rejectionOf(
      gateOn(root, await firstTextGate(NO_WRAP_KEY, { businessId: "biz-t1398-none" })),
    );
    expect(thrown).toBeInstanceOf(TurnFaceReadError);
    expect(thrown).toMatchObject({ read: "readOpenHolds", code: "notFound" });
    expect(await rowCounts()).toEqual(before);
  });
});

// ---- production ---------------------------------------------------------------------------------------------------

describe("in production's environment the part builds nothing and reads no binding", () => {
  it("stagingOptions builds none (ENVIRONMENT read alone, this part's builder never called), the builder alone answers null reading ENVIRONMENT alone, and the Worker's production root keeps the gate closed", async () => {
    for (const environment of ["production", "", "Staging", "preview"]) {
      const testEnv = envOf({ environment });
      const called: GatePart[] = [];
      const inputs = stagingOptions(testEnv.env, {
        db: handleOver(testEnv.env, []),
        builders: {
          gate: (part) => {
            called.push(part);
            return stagingGateReads(part);
          },
        },
      });
      expect(inputs, environment).toBe(NO_STAGING_INPUTS);
      expect(testEnv.names, environment).toEqual(["ENVIRONMENT"]);
      expect(called, environment).toEqual([]);

      const alone = envOf({ environment });
      const db = handleOver(alone.env, []);
      expect(stagingGateReads({ env: alone.env, db, keys: sealingWrapKeys(alone.env), bundleSafety: null })).toBeNull();
      expect(alone.names, environment).toEqual(["ENVIRONMENT"]);
    }

    const testEnv = envOf({ environment: "production" });
    const root = workerRoot(testEnv.env);
    expect(root.environment).toBe("production");
    const thrown = await rejectionOf(gateOn(root, await firstTextGate(NO_WRAP_KEY)));
    expect(thrown).toEqual(new NotJoinedError("gate"));
    expect(testEnv.names.filter((name) => name.startsWith("HYPERDRIVE"))).toEqual([]);
    expect([testEnv.job?.reads.n, testEnv.app?.reads.n]).toEqual([0, 0]);
  });
});

// ---- the capture --------------------------------------------------------------------------------------------------

describe("the span and log capture", () => {
  it("no line written while this file ran holds a text's words, a number, an address, the wrapping key, a sealed value, a chat id or a fixed line's words, and no rejection was left unhandled", async () => {
    // The capture is not empty: every call's timing line is in it.
    expect(turnOne).not.toBeNull();
    const kinds = new Set(everyLine.flatMap((line) => (line.startsWith("{") ? [String(parsed(line).msg)] : [])));
    expect([...kinds]).toEqual(expect.arrayContaining(["dbCall"]));
    expect(SEALED.length).toBeGreaterThanOrEqual(2);
    expectNoSecrets([...everyLine, ...SPANS.map((span) => JSON.stringify(span))]);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(rejections.map((reason) => String(reason))).toEqual([]);
  });
});
