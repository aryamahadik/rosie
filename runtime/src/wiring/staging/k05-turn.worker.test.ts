// T-1395 (the D-017 path audit's P2b): staging binds the turn's K-05 calls through the job handle (./k05-turn.ts), inside
// the Workers runtime on T-1253's rig (infra/test-rig/files.mjs, key K05_TURN): this file's own database, migrated, with
// bundle v0 published and active and test owner 1 seeded (./k05-turn.seed.ts: db/seeds/skeleton.ts), reached through its
// own pool pair only, HYPERDRIVE_JOB_K05_TURN and HYPERDRIVE_APP_K05_TURN, handed in as the env's HYPERDRIVE_JOB and
// HYPERDRIVE_APP behind doubles that count each read of a connection string (ADR-014 section 4). Each root here is built as
// the Worker's is (../root.ts workerRoot: composeRoot over stagingOptions(env)), through the two seams stagingOptions
// names: its handle (./part.ts stagingDb), so a test reads T-1254's counts and each call's timing line, and its builders,
// every part but this card's stood in by its nothing-bound answer, so a test sees this card's binding alone whatever the
// other parts bind later. Two cases go through workerRoot itself, every part's own builder with it. Every database call
// a test makes of its own (the row counts) goes through the handle too.
//
//   - bundles: readActiveBundle answers bundle v0 as active-bundle.json shapes it, and readBundleValue its manifest's
//     stored text with its size and sha256, as bundle-value-on-miss.json; the pin's own reader (../../bundle/values.ts)
//     reads the manifest from PostgreSQL while the pool's BUNDLES misses it, from BUNDLES once the test has copied it
//     there (no readBundleValue call), and every value from PostgreSQL with no BUNDLES at all; the gateway's bundle id is
//     bundle v0's, never the stand-in, and the PostgreSQL-down path's probe answers true;
//   - targets: handle-sam's are targets-first-text.json's (Sam alone: no role, open question, booking or phone row); an
//     unknown handle is notFound;
//   - frontier: build-frontier-s1-01.json's request under bundle v0 answers its outcome's context, the one sign-up door to
//     S1-01, its span ok with each bundle part from PostgreSQL, the scope's client open while each bundle read opens its
//     own (two connections at most); the scope's readTurnState answers K-05's shape under Lee's Barbershop, and a request
//     naming another business is refused;
//   - turn rows: commit-s1-01-sam.json's request on test owner 1's rows commits once and repeats with nothing written;
//     park-turn.json's request on his ids parks once and repeats; a park of the committed turn is alreadyCommitted;
//   - failing (the pool's own HYPERDRIVE_JOB, on rosie_rig_none; the two bindings crossed; DB_SCHEMA set): each of the
//     six calls fails as its port's contract says, by the call's name and SQLSTATE or the guard's labels alone, with
//     nothing of the binding's string in what is thrown, the reader gives no manifest, the gateway's trace takes the
//     stand-in and the probe reads down; unbound (no HYPERDRIVE_JOB): NoDatabaseError for each; production: the four
//     ports closed, no binding read. No row count moves;
//   - HYPERDRIVE_APP is read 0 times throughout, opened equals ended after every test, and no span or log line holds a
//     555-01xx number or the text's words.
// The writes come last: until then test owner 1's rows are as the seed left them (a first text).
// Test values only (rule 9): the contracts' fixtures, the master's sample cast and the fiction range's numbers.
import type { ReadTurnStateRequest } from "@rosie/actions/src/frontier/assemble/types";
import joinRunContext from "@rosie/ai/recordings/contexts/join-s1-01.json";
import activeBundleJson from "@rosie/contracts/data-access/fixtures/active-bundle.json";
import bundleValueOnMiss from "@rosie/contracts/data-access/fixtures/bundle-value-on-miss.json";
import commitS101Sam from "@rosie/contracts/data-access/fixtures/commit-s1-01-sam.json";
import parkTurnJson from "@rosie/contracts/data-access/fixtures/park-turn.json";
import readTurnStateFirstText from "@rosie/contracts/data-access/fixtures/read-turn-state-first-text.json";
import targetsFirstText from "@rosie/contracts/data-access/fixtures/targets-first-text.json";
import buildFrontierS101 from "@rosie/contracts/tool-api/fixtures/build-frontier-s1-01.json";
import { DataAccessDatabaseError } from "@rosie/db/repo/clocks";
import type { CommitTurnRequest } from "@rosie/db/repo/commit-turn";
import { BusinessScopeError } from "@rosie/db/repo/scope";
import { env as poolEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

import bundleV0Kv from "../../../../bundles/v0/bundle.kv.json";
import { turnIdOf } from "../../actor/lease";
import { bundleKvOf } from "../../bundle/kv";
import { BundleError } from "../../bundle/types";
import { asListed, BundleReader, flowOf, keyOf, measure, readManifest } from "../../bundle/values";
import { DEFAULT_BUNDLE_ID, readBundleId } from "../../gateway/answer";
import { openTrace, type BundleId, type Span } from "../../trace";
import { leaks } from "../../trace/hop-check";
import type { BuildFrontierAnswer, BuildFrontierRequest, ParkTurnRequest } from "../../turn/types";
import {
  composeRoot,
  environmentOf,
  NoDatabaseError,
  NotJoinedError,
  workerRoot,
  type PortName,
  type Root,
} from "../index";
import { dbHandle, DbClosedError, DbGuardRefusal } from "./db";
import { NO_RECEIPT_INPUTS } from "./k05-receipt";
import { NO_TURN_CALL_INPUTS, stagingTurnCalls } from "./k05-turn";
import { NO_MODEL_READER_INPUTS } from "./models";
import { stagingOptions, type StagingBuilders, type StagingInputs } from "./options";
import { stagingDb, type DbCallLine, type StagingDb, type StagingEnv } from "./part";
import { NO_SEND_INPUTS } from "./send";
import { NO_DIRECTORY_INPUTS } from "./state-reads";
import { NO_ROW_INPUTS } from "./tool-api-rows";

/** This file's key in the rig's list (infra/test-rig/files.mjs). */
const KEY = "K05_TURN";
const JOB = `HYPERDRIVE_JOB_${KEY}`;
const APP = `HYPERDRIVE_APP_${KEY}`;
/** The pool's own job binding: its database, rosie_rig_none, is never made, so a connect through it fails. */
const POOL_OWN_JOB = "HYPERDRIVE_JOB";

/** The pool's bindings, by name: the Hyperdrive ones, and the bundle KV namespace. */
const pool = poolEnv as unknown as Readonly<Record<string, Hyperdrive | undefined>>;
const POOL_BUNDLES = poolEnv.BUNDLES;

function poolBinding(name: string): Hyperdrive {
  const found = pool[name];
  if (found === undefined) throw new Error(`the pool has no Hyperdrive binding ${name}`);
  return found;
}

const DATABASE = inject("rosieRigDatabases")?.[KEY];

// ---- bundle v0, as bundles/v0 publishes it and the rig published it in this file's database ---------------------------

function partOfV0(suffix: string): { readonly key: string; readonly value: string } {
  const found = bundleV0Kv.find((part) => part.key.endsWith(suffix));
  if (found === undefined) throw new Error(`bundles/v0 holds no value ending in ${suffix}`);
  return found;
}

const MANIFEST = partOfV0("/manifest");
const FLOW_A = partOfV0("/flow/A");
const [, V0_HASH = "", V0_BUILD = ""] = MANIFEST.key.split("/");
/** Bundle v0's id, read from its manifest's key (K-01 v1: bundle/<hash>/<build>/manifest). */
const V0: BundleId = { hash: V0_HASH, build: Number(V0_BUILD) };

// ---- test owner 1 (db/seeds/skeleton.ts), by the fixtures' ids --------------------------------------------------------

const SAM = { handleId: "handle-sam", personId: "person-sam", businessId: "biz-lees-barbershop" } as const;
/** tp-01's fictional number, in each form a number could leak in, and the words of turn 1's text. */
const SAM_NUMBER = "+15555550100";
const NUMBER_FORMS = [SAM_NUMBER, "15555550100", "5555550100", "555-0100"];
const ANY_FICTION_NUMBER = /55555501[0-9]{2}|555-01[0-9]{2}/u;

const TURN_ONE = buildFrontierS101 as unknown as {
  readonly request: BuildFrontierRequest;
  readonly outcome: { readonly context: Record<string, unknown> } & Record<string, unknown>;
};
const TEXT_WORDS = (TURN_ONE.request as unknown as { texts: { words: string }[] }).texts.map(
  (text) => text.words,
);

/** Trace ids of K-08's form, made up: each write's timing line goes on the trace its turn names. */
const COMMIT_TRACE = "4f1c2b7a-9d3e-4c5f-8a6b-1e2d3c4b5a69";
const PARK_TRACE = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";

const UTC_TEXT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]+)?Z$/u;

// ---- what the whole file captures: every span and every log line ------------------------------------------------------

/** Every span a test's trace wrote, and every line written to the console or as a call's timing, across the file. */
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
  /** The counting double handed in as HYPERDRIVE_JOB; null where the env has none, or has the pool's binding itself. */
  readonly job: CountedBinding | null;
  /** The counting double handed in as HYPERDRIVE_APP, in every env. */
  readonly app: CountedBinding;
}

interface EnvOptions {
  readonly environment?: string;
  /** The pool binding handed in as HYPERDRIVE_JOB (default: this file's own); null for none. */
  readonly job?: string | null;
  /** True: HYPERDRIVE_JOB is the pool's binding itself, as the Workers runtime hands one, behind no double. */
  readonly rawJob?: boolean;
  readonly schema?: string;
}

/**
 * Every env a test built, the envs of the roots that bind this card's part alone, and every handle: checked after each
 * test (HYPERDRIVE_APP's string never read; by this card's part, not by its name either; opened equals ended).
 */
const ENVS: TestEnv[] = [];
const TURN_ONLY_ENVS: TestEnv[] = [];
const HANDLES: StagingDb[] = [];

/**
 * Every part but this card's, stood in by its nothing-bound answer (each stub's own, as T-1257 made it), so a root built
 * with these shows this card's binding alone, whatever the other parts bind once their cards land.
 */
const EVERY_OTHER_PART_UNBOUND: Partial<StagingBuilders> = {
  receipt: () => NO_RECEIPT_INPUTS,
  models: () => NO_MODEL_READER_INPUTS,
  bundleSafety: () => null,
  gate: () => null,
  rows: () => NO_ROW_INPUTS,
  directories: () => NO_DIRECTORY_INPUTS,
  send: () => NO_SEND_INPUTS,
  flags: () => null,
  testPhone: () => null,
  copies: () => null,
};

/** The Worker's env as wrangler.jsonc's vars give it, with this file's pair behind counting doubles. */
function envOf(options: EnvOptions = {}): TestEnv {
  const names: string[] = [];
  const jobName = options.job === undefined ? JOB : options.job;
  const raw = options.rawJob === true && jobName !== null ? poolBinding(jobName) : null;
  const job = jobName === null || raw !== null ? null : counted(poolBinding(jobName));
  const app = counted(poolBinding(APP));
  const values: Record<string, unknown> = {
    ENVIRONMENT: options.environment ?? "staging",
    BASE_PATH: "/test",
    DB_SCHEMA: options.schema ?? "",
    GIT_SHA: "test-sha",
    ...(raw === null ? {} : { HYPERDRIVE_JOB: raw }),
    ...(job === null ? {} : { HYPERDRIVE_JOB: job.binding }),
    HYPERDRIVE_APP: app.binding,
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

interface Rooted {
  readonly root: Root;
  /** The root's one handle (T-1254's, through ./part.ts): its counts are the root's. */
  readonly db: StagingDb;
  /** What stagingOptions gave the root: each part's input. */
  readonly inputs: StagingInputs;
  /** Each call's timing line the handle wrote, in order. */
  readonly lines: () => DbCallLine[];
}

/**
 * A root built as workerRoot builds the Worker's (composeRoot over stagingOptions(env)), over the test's env, with its
 * handle kept for the test to read, and this card's part (./k05-turn.ts stagingTurnCalls, as STAGING_BUILDERS holds it)
 * the only one bound.
 */
function rootOver(testEnv: TestEnv): Rooted {
  const written: string[] = [];
  const db = stagingDb(testEnv.env, {
    write: (line) => {
      written.push(line);
      LOGGED.push(line);
    },
  });
  HANDLES.push(db);
  TURN_ONLY_ENVS.push(testEnv);
  const inputs = stagingOptions(testEnv.env, { db, builders: EVERY_OTHER_PART_UNBOUND });
  const root = composeRoot({
    environment: environmentOf(testEnv.env),
    actors: null,
    vars: testEnv.env,
    ...inputs,
  });
  return { root, db, inputs, lines: () => written.map((line) => JSON.parse(line) as DbCallLine) };
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

/** The dbCall lines among a test's console lines, as the Worker's own root writes them (console.log). */
function dbCallLinesOf(lines: readonly string[]): DbCallLine[] {
  return jsonLinesOf(lines, "dbCall") as unknown as DbCallLine[];
}

// ---- the requests -----------------------------------------------------------------------------------------------------

/** build-frontier-s1-01.json's request (turn 1, Sam's first text) on a trace of its own, under bundle v0. */
function turnOneOn(traceId: string): BuildFrontierRequest {
  const request = structuredClone(TURN_ONE.request);
  return {
    ...request,
    caller: { ...request.caller, traceId },
    turn: { ...request.turn, traceId, bundleId: { ...V0 } },
  };
}

/** One buildFrontier call through the root's turn face, on a trace of its own whose spans are kept. */
function buildFrontierOn(root: Root, spans: Span[] = []): Promise<BuildFrontierAnswer> {
  const trace = openTrace({
    openedBy: "textWebhook",
    bundleId: V0,
    sink: (span) => {
      spans.push(span);
      SPANS.push(span);
    },
  });
  const request = turnOneOn(trace.traceId);
  trace.setTurn(request.turn.id);
  return root.turn.toolApi.buildFrontier(request, trace);
}

/**
 * commit-s1-01-sam.json's request under the turn id the lease hashes from its event ids (CQ-09) and bundle v0's id, the
 * bundle this file's database holds.
 */
async function commitRequest(): Promise<CommitTurnRequest> {
  const request = structuredClone(commitS101Sam.request) as unknown as CommitTurnRequest;
  return {
    ...request,
    turn: {
      ...request.turn,
      id: await turnIdOf(request.turn.eventIds),
      bundleId: { ...V0 },
      traceId: COMMIT_TRACE,
    },
  };
}

/**
 * park-turn.json's request on test owner 1's ids (the fixture parks Maya's turn; this database holds Sam), under the turn
 * id the lease hashes from its event ids and bundle v0's id; `turn` names another turn to park.
 */
async function parkRequest(turn?: {
  readonly id: string;
  readonly eventIds: readonly string[];
}): Promise<ParkTurnRequest> {
  const fixture = structuredClone(parkTurnJson.request);
  const eventIds = turn === undefined ? fixture.turn.eventIds : [...turn.eventIds];
  const id = turn === undefined ? await turnIdOf(eventIds) : turn.id;
  const request = {
    ...fixture,
    turn: {
      ...fixture.turn,
      id,
      handleId: SAM.handleId,
      eventIds,
      bundleId: { ...V0 },
      traceId: PARK_TRACE,
    },
    outboxRows: fixture.outboxRows.map((row) => ({
      ...row,
      recipientHandleId: SAM.handleId,
      recipientPersonId: SAM.personId,
      businessId: SAM.businessId,
    })),
    events: fixture.events.map((entry) => ({ ...entry, businessId: SAM.businessId, rowId: id })),
  };
  return request as unknown as ParkTurnRequest;
}

/** The six K-05 calls this card binds, each as its port's caller makes it, with the port it goes through. */
interface PortCall {
  readonly call: string;
  readonly port: PortName;
  readonly run: () => Promise<unknown>;
}

async function sixCalls(root: Root, spans: Span[] = []): Promise<PortCall[]> {
  const commit = await commitRequest();
  const park = await parkRequest();
  return [
    {
      call: "readActiveBundle",
      port: "bundles",
      run: () => root.ports.bundles.registry.readActiveBundle({}),
    },
    {
      call: "readBundleValue",
      port: "bundles",
      run: () => root.ports.bundles.registry.readBundleValue({ key: MANIFEST.key }),
    },
    {
      call: "handleTargets",
      port: "targets",
      run: () => root.ports.targets.handleTargets({ handleId: SAM.handleId }),
    },
    { call: "readTurnState", port: "frontier", run: () => buildFrontierOn(root, spans) },
    { call: "commitTurn", port: "turnRow", run: () => root.ports.turnRow.commitTurn(commit) },
    { call: "parkTurn", port: "turnRow", run: () => root.ports.turnRow.parkTurn(park) },
  ];
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

/** The row count of each table a turn's commit or park writes. */
interface RowCounts {
  readonly turns: number;
  readonly outbox_rows: number;
  readonly open_questions: number;
  readonly clock_rows: number;
  readonly event_log: number;
}

/**
 * The row count of each table a turn's commit or park writes, in this file's database, read on the runtime side through
 * a handle of its own (rosie_job with no business scope sees every business's rows).
 */
async function rowCounts(): Promise<RowCounts> {
  const handle = dbHandle({ ENVIRONMENT: "staging", DB_SCHEMA: "", HYPERDRIVE_JOB: poolBinding(JOB) });
  const rows = await handle.runtime(
    "rowCounts",
    (sql) => sql<RowCounts[]>`
      select (select count(*) from turns)::int as turns,
             (select count(*) from outbox_rows)::int as outbox_rows,
             (select count(*) from open_questions)::int as open_questions,
             (select count(*) from clock_rows)::int as clock_rows,
             (select count(*) from event_log)::int as event_log`,
  );
  const [row] = rows;
  if (row === undefined) throw new Error("the row counts were not read");
  expect(handle.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0 });
  return {
    turns: row.turns,
    outbox_rows: row.outbox_rows,
    open_questions: row.open_questions,
    clock_rows: row.clock_rows,
    event_log: row.event_log,
  };
}

/** Whether `text` holds `part` as a whole name (not inside a longer name, such as rosie inside rosie_job). */
function holds(text: string, part: string): boolean {
  const escaped = part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "u").test(text);
}

/**
 * The texts an error gives away: its message, its stack but for the frames (code locations), its own fields as JSON, each
 * own property's value, and the error as a string.
 */
function textsOf(error: unknown): string[] {
  if (!(error instanceof Error)) return [String(error)];
  const stack = (error.stack ?? "")
    .split("\n")
    .filter((line) => !/^\s+at\s/u.test(line))
    .join("\n");
  const fields = error as unknown as Record<string, unknown>;
  const own = Object.getOwnPropertyNames(error)
    .filter((name) => name !== "stack")
    .map((name) => {
      // A property that holds no JSON value (undefined, a function) gives no text.
      const text = JSON.stringify(fields[name]) as string | undefined;
      return text ?? "";
    });
  return [error.message, stack, JSON.stringify(error), String(error), ...own];
}

/** No text holds the binding's string, host, user, password or database, nor a number of the fiction range. */
function expectNothingOf(binding: { readonly connectionString: string }, texts: readonly string[]): void {
  const url = new URL(binding.connectionString);
  const parts = [
    binding.connectionString,
    url.host,
    url.hostname,
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
    decodeURIComponent(url.pathname.slice(1)),
  ].filter((part) => part !== "");
  expect(parts.length).toBeGreaterThanOrEqual(5);
  for (const text of texts) {
    for (const part of parts) {
      expect(holds(text, part), "a text holds a part of the binding's string").toBe(false);
    }
    expect(ANY_FICTION_NUMBER.test(text), "a text holds a number").toBe(false);
  }
}

/** Each timing line is the runtime side's: HYPERDRIVE_JOB, the login rosie_worker_job, labels and numbers only. */
function expectJobSide(lines: readonly DbCallLine[]): void {
  for (const line of lines) {
    expect(line).toEqual({
      level: "info",
      msg: "dbCall",
      trace_id: line.trace_id,
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

const callsOf = (lines: readonly DbCallLine[]): (string | null)[] => lines.map((line) => line.call);

beforeEach(() => {
  testLog = [];
  const keep = (...args: unknown[]): void => {
    const line = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
    testLog.push(line);
    LOGGED.push(line);
  };
  // The frontier logs each slot not built yet on console.warn (labels only); a root's own spans go to console.log.
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "warn").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
});

afterEach(() => {
  vi.restoreAllMocks();
  // T-1254's counter: every client a call opened was ended, a frontier call's own bundle reads included.
  for (const db of HANDLES) {
    const counts = db.counts();
    expect(counts.ended).toBe(counts.opened);
    expect(counts.connectionsOpen).toBe(0);
  }
  // The job side only: HYPERDRIVE_APP's connection string is never read for these calls, and this card's part never
  // reads HYPERDRIVE_APP by its name either; no binding named HYPERDRIVE is read at all.
  for (const made of ENVS) {
    expect(made.app.reads.n).toBe(0);
    expect(made.names).not.toContain("HYPERDRIVE");
  }
  for (const made of TURN_ONLY_ENVS) expect(made.names).not.toContain("HYPERDRIVE_APP");
});

// ---- the rig ----------------------------------------------------------------------------------------------------------

describe("this file's database on the rig", () => {
  it("is this run's own, with the pool's BUNDLES bound and bundle v0's id read from bundles/v0", () => {
    expect(DATABASE).toMatch(/^rosie_rig_[0-9a-f]{8}_k05_turn$/u);
    expect(POOL_BUNDLES).toBeDefined();
    expect(V0.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(V0.build).toBeGreaterThanOrEqual(1);
    expect(MANIFEST.key).toBe(keyOf(V0, "manifest"));
    expect(FLOW_A.key).toBe(keyOf(V0, "flow/A"));
    // Not the gateway's stand-in (K-01's skeleton id): an answer of bundle v0's id is one the database gave.
    expect(V0).not.toEqual(DEFAULT_BUNDLE_ID);
  });
});

// ---- bundleReads ------------------------------------------------------------------------------------------------------

describe("bundleReads: K-05 v1 item 7 through the job handle", () => {
  it("readActiveBundle answers bundle v0, shaped as active-bundle.json, and readBundleValue its manifest's stored text with its size and sha256, shaped as bundle-value-on-miss.json", async () => {
    const testEnv = envOf();
    const { root, db, lines } = rootOver(testEnv);
    // Nothing was read to build the root but the environment and the binding's presence: no connection string.
    expect(testEnv.job?.reads.n).toBe(0);
    expect(db.counts()).toMatchObject({ opened: 0, ended: 0 });

    const active = await root.ports.bundles.registry.readActiveBundle({});

    expect(active).toEqual({
      result: "active",
      bundleId: V0,
      manifestKey: MANIFEST.key,
      activatedAt: expect.stringMatching(UTC_TEXT) as string,
    });
    expect(Object.keys(active).sort()).toEqual(Object.keys(activeBundleJson.outcome).sort());

    const value = await root.ports.bundles.registry.readBundleValue({ key: MANIFEST.key });

    const measured = await measure(MANIFEST.value);
    expect(value).toEqual({
      result: "value",
      value: {
        key: MANIFEST.key,
        kind: "manifest",
        bytes: measured.bytes,
        sha256: measured.sha256,
        text: MANIFEST.value,
      },
    });
    expect(Object.keys(value).sort()).toEqual(Object.keys(bundleValueOnMiss.outcome).sort());
    expect(Object.keys("value" in value ? value.value : {}).sort()).toEqual(
      Object.keys(bundleValueOnMiss.outcome.value).sort(),
    );
    // A key PostgreSQL's copy does not hold is K-05's notFound, unchanged.
    const missing = keyOf(V0, "flow/B-t1395-none");
    expect(await root.ports.bundles.registry.readBundleValue({ key: missing })).toEqual({
      error: "notFound",
      table: "bundle_values",
      rowId: missing,
    });

    // One short-lived client per call, its connection string read at that call, each on the job side.
    expect(callsOf(lines())).toEqual(["readActiveBundle", "readBundleValue", "readBundleValue"]);
    expectJobSide(lines());
    expect(testEnv.job?.reads.n).toBe(3);
    expect(db.counts()).toMatchObject({ opened: 3, ended: 3, connectionsOpen: 0, connectionsPeak: 1 });
  });

  it("the pin's own reader reads bundle v0's manifest from PostgreSQL while BUNDLES misses it, from BUNDLES once copied there (no readBundleValue call), and every value from PostgreSQL with no BUNDLES at all", async () => {
    const bundles = POOL_BUNDLES;
    if (bundles === undefined) throw new Error("the pool's staging environment binds BUNDLES");
    const { root, lines } = rootOver(envOf());
    const registry = root.ports.bundles.registry;
    const kv = bundleKvOf(bundles);
    expect(await bundles.get(MANIFEST.key)).toBeNull();
    try {
      // BUNDLES misses it: PostgreSQL's copy, checked by its size and sha256 and against the id.
      const onMiss = new BundleReader(registry, kv);
      const manifest = await readManifest(onMiss, V0);
      expect(manifest.bundleId).toEqual(V0);
      expect(manifest).toEqual(JSON.parse(MANIFEST.value));
      expect(onMiss.reads()).toEqual([{ key: MANIFEST.key, kind: "manifest", from: "postgres" }]);
      expect(callsOf(lines())).toEqual(["readBundleValue"]);

      // The test copies it to the pool's BUNDLES (the rig fills no KV): read from KV, and PostgreSQL is not asked.
      await bundles.put(MANIFEST.key, MANIFEST.value);
      const fromKv = new BundleReader(registry, kv);
      expect(await readManifest(fromKv, V0)).toEqual(manifest);
      expect(fromKv.reads()).toEqual([{ key: MANIFEST.key, kind: "manifest", from: "kv" }]);
      expect(callsOf(lines())).toEqual(["readBundleValue"]);

      // No BUNDLES at all (kv null): every value from PostgreSQL's copy. Bundle v0 holds two, its manifest and the one
      // flow graph the manifest lists.
      expect(bundleKvOf(undefined)).toBeNull();
      expect(bundleV0Kv.map((part) => part.key).sort()).toEqual([FLOW_A.key, MANIFEST.key].sort());
      const noKv = new BundleReader(registry, bundleKvOf(undefined));
      const again = await readManifest(noKv, V0);
      expect(again.storage.values.map((entry) => entry.key)).toEqual([FLOW_A.key]);
      const listed = again.storage.values.find((entry) => entry.key === FLOW_A.key && entry.kind === "flow");
      if (listed === undefined) throw new Error("bundle v0's manifest lists no flow A");
      const graph = await noKv.read(FLOW_A.key, "flow", (read) =>
        Promise.resolve(asListed(read, listed) ? flowOf(read.text, "A") : null),
      );
      expect(graph).toEqual(JSON.parse(FLOW_A.value));
      expect(noKv.reads()).toEqual([
        { key: MANIFEST.key, kind: "manifest", from: "postgres" },
        { key: FLOW_A.key, kind: "flow", from: "postgres" },
      ]);
      expect(callsOf(lines())).toEqual(["readBundleValue", "readBundleValue", "readBundleValue"]);
    } finally {
      await bundles.delete(MANIFEST.key);
    }
  });

  it("the gateway's active bundle id is bundle v0's, not the stand-in, and the PostgreSQL-down path's probe answers true, both through the same port (HYPERDRIVE_JOB the pool's binding itself, behind no double)", async () => {
    const { root, lines } = rootOver(envOf({ rawJob: true }));

    expect(await root.gateway.bundleId()).toEqual(V0);
    expect(await readBundleId({ bundleId: () => root.gateway.bundleId() })).toEqual(V0);
    expect(await root.outage.probe()).toBe(true);

    expect(callsOf(lines())).toEqual(["readActiveBundle", "readActiveBundle", "readActiveBundle"]);
    expectJobSide(lines());
  });

  it("the Worker's own root (workerRoot over the env) hands the bundle and targets ports these calls, each call's timing one line on the Worker's log: labels and numbers only", async () => {
    const testEnv = envOf();

    const root = workerRoot(testEnv.env);

    expect(root.environment).toBe("staging");
    expect(await root.ports.bundles.registry.readActiveBundle({})).toMatchObject({
      result: "active",
      bundleId: V0,
    });
    expect(await root.ports.targets.handleTargets({ handleId: SAM.handleId })).toMatchObject({
      result: "targets",
      handleId: SAM.handleId,
    });
    expect(await root.gateway.bundleId()).toEqual(V0);
    const lines = dbCallLinesOf(testLog);
    expect(callsOf(lines)).toEqual(["readActiveBundle", "handleTargets", "readActiveBundle"]);
    expectJobSide(lines);
    expect(lines.map((line) => line.trace_id)).toEqual([null, null, null]);
    expect(testEnv.job?.reads.n).toBe(3);
  });
});

// ---- handleTargets ----------------------------------------------------------------------------------------------------

describe("handleTargets: K-05 v1.2 item 27 through the job handle", () => {
  it("handle-sam's targets are shaped as targets-first-text.json (Sam alone: no role, no open question, no booking, phone null), and an unknown handle id answers notFound", async () => {
    const { root, db, lines } = rootOver(envOf());

    const targets = await root.ports.targets.handleTargets({ handleId: SAM.handleId });

    expect(targets).toEqual({
      result: "targets",
      handleId: SAM.handleId,
      readAt: expect.stringMatching(UTC_TEXT) as string,
      persons: [{ personId: SAM.personId, roles: [] }],
      openQuestions: [],
      bookings: [],
      phone: null,
    });
    expect(Object.keys(targets).sort()).toEqual(Object.keys(targetsFirstText.outcome).sort());

    expect(await root.ports.targets.handleTargets({ handleId: "handle-t1395-nobody" })).toEqual({
      error: "notFound",
      table: "handles",
      rowId: "handle-t1395-nobody",
    });

    expect(callsOf(lines())).toEqual(["handleTargets", "handleTargets"]);
    expectJobSide(lines());
    expect(db.counts()).toMatchObject({ opened: 2, ended: 2, connectionsOpen: 0, connectionsPeak: 1 });
  });
});

// ---- frontierScope ----------------------------------------------------------------------------------------------------

describe("frontierScope: K-05 v1.2 item 26's readTurnState under the call's business, through the job handle", () => {
  it("buildFrontier with build-frontier-s1-01.json's request under bundle v0 answers its outcome's context, the one sign-up door to S1-01, its span ok with each bundle part from postgres; the scope's client stays open while each bundle read opens its own", async () => {
    const { root, db, lines } = rootOver(envOf());
    const spans: Span[] = [];

    const answer = await buildFrontierOn(root, spans);

    // The fixture's outcome, word for word, under the bundle the call named: bundle v0 as this database holds it, so the
    // bundle id and the rules prefix's hash are bundle v0's own (the fixture's are K-01's skeleton's), the hash as the
    // JOIN run's recorded context holds it for bundle v0 (ai/recordings/contexts/join-s1-01.json).
    expect(joinRunContext.bundleId).toEqual(V0);
    expect(answer).toEqual({
      ...TURN_ONE.outcome,
      context: { ...TURN_ONE.outcome.context, bundleId: V0, alwaysOn: joinRunContext.alwaysOn },
    });
    expect((answer as { context?: { choices?: unknown } }).context?.choices).toEqual([
      expect.objectContaining({
        choiceId: "c-01",
        kind: "door",
        door: "signUp",
        step: "S1-01",
        target: {
          businessId: SAM.businessId,
          businessName: "Lee's Barbershop",
          bookingId: null,
          visitAt: null,
        },
      }),
    ]);
    expect(spans).toMatchObject([
      {
        hop: "frontier",
        outcome: "ok",
        error_code: null,
        bundle_id: V0,
        business_id: SAM.businessId,
        got: {
          toolCall: "buildFrontier",
          callerKind: "turn",
          bundleParts: ["manifest", "flow/A"],
          bundleFrom: ["postgres", "postgres"],
        },
        decided: { answered: "response" },
      },
    ]);
    // The scope's one client first, then the frontier's own bundle reads, each on a client of its own while the scope's
    // stays open: two connections at most, and every one ended.
    expect(callsOf(lines())).toEqual(["readTurnState", "readBundleValue", "readBundleValue"]);
    expectJobSide(lines());
    expect(db.counts()).toMatchObject({ opened: 3, ended: 3, connectionsOpen: 0, connectionsPeak: 2 });
  });

  it("the scope's readTurnState for handle-sam under biz-lees-barbershop answers K-05's shape (read-turn-state-first-text.json's fields), and a request naming another business than the scope's is refused", async () => {
    const { inputs, db, lines } = rootOver(envOf());
    const scope = inputs.frontierScope;
    if (scope === null) throw new Error("staging bound no frontier scope");
    const request: ReadTurnStateRequest = {
      handleId: SAM.handleId,
      businessId: SAM.businessId,
      bookingIds: [],
      facts: [],
    };

    const state = await scope.withBusiness(SAM.businessId, (repo) => repo.readTurnState(request));

    expect(state).toEqual({
      result: "turnState",
      handleId: SAM.handleId,
      handle: { kind: "phone", address: SAM_NUMBER },
      businessId: SAM.businessId,
      readAt: expect.stringMatching(UTC_TEXT) as string,
      persons: [{ personId: SAM.personId, language: null, version: 1 }],
      roles: [],
      phone: null,
      openQuestions: [],
      bookings: [],
      pauses: [],
      consents: [],
      facts: [],
    });
    expect(Object.keys(state).sort()).toEqual(Object.keys(readTurnStateFirstText.outcome).sort());

    // Another business than the scope's: T-219's readTurnStateIn refuses before its first read (pg/frontier.ts step 3).
    const other = { ...request, businessId: "biz-t1395-another" };
    const refused = await rejectionOf(
      scope.withBusiness(SAM.businessId, (repo) => repo.readTurnState(other)),
    );
    expect(refused).toBeInstanceOf(BusinessScopeError);
    // And a scope that is no business id is refused before anything is read (pgFrontierScope's own check).
    await expect(scope.withBusiness("", (repo) => repo.readTurnState(request))).rejects.toThrow(TypeError);

    expect(callsOf(lines())).toEqual(["readTurnState", "readTurnState", "readTurnState"]);
    expectJobSide(lines());
    expect(db.counts()).toMatchObject({ opened: 3, ended: 3, connectionsOpen: 0, connectionsPeak: 1 });
  });
});

// ---- bound but failing, unbound, production ---------------------------------------------------------------------------

describe("bound but failing: each call answers as its port's contract says, and nothing is written", () => {
  it("the env's HYPERDRIVE_JOB the pool's own (on rosie_rig_none): each of the six calls fails by its name and SQLSTATE alone, the reader gives no manifest, the gateway's trace takes bundle v0's stand-in and the probe reads down; no host, user, password or number in what is thrown; no row count moves", async () => {
    const before = await rowCounts();
    const testEnv = envOf({ job: POOL_OWN_JOB });
    const { root, db, lines } = rootOver(testEnv);
    const spans: Span[] = [];
    const thrown: unknown[] = [];

    for (const { call, run } of await sixCalls(root, spans)) {
      const error = await rejectionOf(run());
      expect(error, call).toBeInstanceOf(DataAccessDatabaseError);
      expect(error, call).toMatchObject({ call, code: "3D000", table: null, constraint: null });
      expect((error as Error).message, call).toBe(`${call}: the database refused the call (SQLSTATE 3D000)`);
      thrown.push(error);
    }
    // The frontier failed closed inside the Tool API base, its span failed, before anything was read.
    expect(spans).toMatchObject([
      {
        hop: "frontier",
        outcome: "failed",
        error_code: "DataAccessDatabaseError",
        business_id: SAM.businessId,
        got: { toolCall: "buildFrontier", callerKind: "turn", bundleParts: [], bundleFrom: [] },
        decided: { answered: "thrown" },
      },
    ]);
    // No pin: the pin's own reader gives no manifest, with BUNDLES or without, so no turn's work starts.
    const noManifest = await rejectionOf(
      readManifest(new BundleReader(root.ports.bundles.registry, null), V0),
    );
    expect(noManifest).toBeInstanceOf(BundleError);
    expect(noManifest).toMatchObject({ code: "noAnswer" });
    // The gateway's trace takes bundle v0's stand-in (answer.ts), and the probe's throw reads as down.
    const noBundleId = await rejectionOf(Promise.resolve(root.gateway.bundleId()));
    expect(noBundleId).toBeInstanceOf(DataAccessDatabaseError);
    expect(await readBundleId({ bundleId: () => root.gateway.bundleId() })).toEqual(DEFAULT_BUNDLE_ID);
    const down = await rejectionOf(root.outage.probe());
    expect(down).toBeInstanceOf(DataAccessDatabaseError);
    thrown.push(noBundleId, down);

    // Nothing of the binding's string, and no number, in any thrown error's message, fields or own properties.
    expect(thrown).toHaveLength(8);
    for (const error of thrown) expectNothingOf(poolBinding(POOL_OWN_JOB), textsOf(error));
    // The guard never passed: no timing line, and nothing on the console; every client opened was ended.
    expect(lines()).toEqual([]);
    expect(dbCallLinesOf(testLog)).toEqual([]);
    expect(db.counts()).toMatchObject({ opened: 10, ended: 10, connectionsOpen: 0 });
    expect(testEnv.job?.reads.n).toBe(10);
    expect(await rowCounts()).toEqual(before);
  });

  it("the two bindings crossed (HYPERDRIVE_JOB holding the Tool API's login): the guard refuses each of the six calls before its code runs, so none ever runs as rosie_app, and no row count moves", async () => {
    const before = await rowCounts();
    const testEnv = envOf({ job: APP });
    const { root, db, lines } = rootOver(testEnv);
    const spans: Span[] = [];

    for (const { call, run } of await sixCalls(root, spans)) {
      const error = await rejectionOf(run());
      expect(error, call).toBeInstanceOf(DbGuardRefusal);
      expect(error, call).toMatchObject({ side: "runtime", binding: "HYPERDRIVE_JOB" });
      expect((error as DbGuardRefusal).checks, call).toContain("session_user");
      expectNothingOf(poolBinding(APP), textsOf(error));
    }

    expect(spans).toMatchObject([{ hop: "frontier", outcome: "failed", error_code: "DbGuardRefusal" }]);
    // Each refusal's one log line: the side, the binding's name and the failed checks' labels (T-1254), no timing line.
    const refusals = jsonLinesOf(testLog, "dbGuardRefused");
    expect(refusals).toHaveLength(6);
    for (const line of refusals) {
      expect(line).toMatchObject({ level: "error", side: "runtime", binding: "HYPERDRIVE_JOB" });
      expect(Object.keys(line).sort()).toEqual(["binding", "checks", "level", "msg", "side"]);
    }
    expect(lines()).toEqual([]);
    expect(dbCallLinesOf(testLog)).toEqual([]);
    expect(db.counts()).toMatchObject({ opened: 6, ended: 6, connectionsOpen: 0 });
    expect(await rowCounts()).toEqual(before);
  });

  it("DB_SCHEMA set: no client is opened through the binding (its string read 0 times), each of the six calls fails closed, and no row count moves", async () => {
    const before = await rowCounts();
    const testEnv = envOf({ schema: "preview_t1395" });
    const { root, db, lines } = rootOver(testEnv);

    for (const { call, run } of await sixCalls(root)) {
      const error = await rejectionOf(run());
      expect(error, call).toBeInstanceOf(DbClosedError);
      expect(error, call).toMatchObject({
        call,
        side: "runtime",
        binding: "HYPERDRIVE_JOB",
        reason: "dbSchemaSet",
      });
    }

    expect(testEnv.job?.reads.n).toBe(0);
    expect(lines()).toEqual([]);
    expect(db.counts()).toMatchObject({ opened: 0, ended: 0, connectionsOpen: 0 });
    expect(await rowCounts()).toEqual(before);
  });
});

describe("unbound: each input is null, so each port fails closed as it always has", () => {
  it("HYPERDRIVE_JOB unbound and HYPERDRIVE_APP bound: NoDatabaseError naming each call, HYPERDRIVE_APP read 0 times, no client opened, no row count moves", async () => {
    const before = await rowCounts();
    const testEnv = envOf({ job: null });
    const { root, db, inputs, lines } = rootOver(testEnv);
    const spans: Span[] = [];

    expect(stagingTurnCalls({ env: testEnv.env, db })).toBe(NO_TURN_CALL_INPUTS);
    expect([inputs.bundleReads, inputs.handleTargets, inputs.frontierScope, inputs.turnRows]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    for (const { call, run } of await sixCalls(root, spans)) {
      await expect(run(), call).rejects.toThrow(new NoDatabaseError(call));
    }
    expect(spans).toMatchObject([{ hop: "frontier", outcome: "failed", error_code: "NoDatabaseError" }]);
    await expect(Promise.resolve(root.gateway.bundleId())).rejects.toThrow(
      new NoDatabaseError("readActiveBundle"),
    );
    await expect(root.outage.probe()).rejects.toThrow(new NoDatabaseError("readActiveBundle"));

    // Only the job binding's presence was asked for; HYPERDRIVE_APP by no name (checked after each test, and here).
    expect(new Set(testEnv.names.filter((name) => name.startsWith("HYPERDRIVE")))).toEqual(
      new Set(["HYPERDRIVE_JOB"]),
    );
    expect(testEnv.names).not.toContain("HYPERDRIVE_APP");
    expect(testEnv.app.reads.n).toBe(0);
    expect(lines()).toEqual([]);
    expect(db.counts()).toMatchObject({ opened: 0, ended: 0 });
    expect(await rowCounts()).toEqual(before);
  });

  it("production's environment with both bindings: the builder gives nothing and reads no binding, the four ports are closed (NotJoinedError) through the Worker's own root, and no row count moves", async () => {
    const before = await rowCounts();
    const testEnv = envOf({ environment: "production" });

    // The builder alone, were it ever handed production's env: every input null, ENVIRONMENT read and nothing else.
    const alone = stagingDb(testEnv.env, { write: (line) => LOGGED.push(line) });
    HANDLES.push(alone);
    expect(stagingTurnCalls({ env: testEnv.env, db: alone })).toBe(NO_TURN_CALL_INPUTS);
    expect(testEnv.names).toEqual(["ENVIRONMENT"]);

    const root = workerRoot(testEnv.env);

    expect(root.environment).toBe("production");
    for (const { call, port, run } of await sixCalls(root)) {
      await expect(run(), call).rejects.toThrow(new NotJoinedError(port));
    }
    expect(testEnv.names.filter((name) => name.startsWith("HYPERDRIVE"))).toEqual([]);
    expect([testEnv.job?.reads.n, testEnv.app.reads.n]).toEqual([0, 0]);
    expect(dbCallLinesOf(testLog)).toEqual([]);
    expect(alone.counts()).toMatchObject({ opened: 0, ended: 0 });
    expect(await rowCounts()).toEqual(before);
  });
});

// ---- turnRows: the writes, last ---------------------------------------------------------------------------------------

describe("turnRows: K-05 v1.1 commitTurn and K-05 v1 parkTurn through the job handle", () => {
  it("commit-s1-01-sam.json's request on test owner 1's rows, under the turn id the lease hashes from its event ids and bundle v0's id, answers committed, and its repeat answers repeated with nothing written", async () => {
    const before = await rowCounts();
    const { root, db, lines } = rootOver(envOf());
    const request = await commitRequest();
    const { committed } = commitS101Sam.outcome;

    const first = await root.ports.turnRow.commitTurn(request);

    expect(first).toEqual({
      result: "committed",
      turnId: request.turn.id,
      committedAt: expect.stringMatching(UTC_TEXT) as string,
      repeated: false,
      committed: {
        written: committed.written,
        outboxRows: committed.outboxRows.map((row) => ({
          id: row.id,
          commitSeq: expect.any(Number) as number,
        })),
        promoted: [],
      },
    });
    expect(Object.keys(first).sort()).toEqual(Object.keys(commitS101Sam.outcome).sort());
    const after = await rowCounts();
    expect(after).toEqual({
      turns: before.turns + 1,
      outbox_rows: before.outbox_rows + 1,
      open_questions: before.open_questions + 1,
      clock_rows: before.clock_rows + 1,
      event_log: before.event_log + 1,
    });

    const repeat = await root.ports.turnRow.commitTurn(request);

    expect(repeat).toMatchObject({
      result: "committed",
      turnId: request.turn.id,
      repeated: true,
      committed: { written: [], promoted: [] },
    });
    if (!("result" in first) || !("result" in repeat)) throw new Error("a commit was refused");
    expect(repeat.committedAt).toBe(first.committedAt);
    expect(repeat.committed.outboxRows).toEqual(first.committed.outboxRows);
    expect(await rowCounts()).toEqual(after);

    // The turn id check stays in front of K-05: an id that is not its event ids' hash never reaches the database.
    await expect(
      root.ports.turnRow.commitTurn({ ...request, turn: { ...request.turn, id: "turn-s1-01-sam" } }),
    ).rejects.toMatchObject({ name: "TurnIdError" });
    expect(await rowCounts()).toEqual(after);

    // Each commit's timing on the trace its turn names.
    expect(lines().map((line) => [line.call, line.trace_id])).toEqual([
      ["commitTurn", COMMIT_TRACE],
      ["commitTurn", COMMIT_TRACE],
    ]);
    expectJobSide(lines());
    expect(db.counts()).toMatchObject({ opened: 2, ended: 2, connectionsOpen: 0, connectionsPeak: 1 });
  });

  it("park-turn.json's request on test owner 1's ids, under its own hashed id, answers parked and its repeat repeated; a park of the committed turn answers alreadyCommitted", async () => {
    const before = await rowCounts();
    const { root, db, lines } = rootOver(envOf());
    const request = await parkRequest();

    const first = await root.ports.turnRow.parkTurn(request);

    expect(first).toEqual({
      result: "parked",
      turnId: request.turn.id,
      parkedAt: parkTurnJson.outcome.parkedAt,
      outboxRows: parkTurnJson.outcome.outboxRows.map((row) => ({
        id: row.id,
        commitSeq: expect.any(Number) as number,
      })),
      repeated: false,
    });
    expect(Object.keys(first).sort()).toEqual(Object.keys(parkTurnJson.outcome).sort());
    const after = await rowCounts();
    expect(after).toEqual({
      ...before,
      turns: before.turns + 1,
      outbox_rows: before.outbox_rows + 1,
      event_log: before.event_log + 1,
    });

    const repeat = await root.ports.turnRow.parkTurn(request);

    expect(repeat).toEqual({ ...first, repeated: true });
    expect(await rowCounts()).toEqual(after);

    // The turn the test above committed is never parked.
    const committed = await commitRequest();
    const never = await root.ports.turnRow.parkTurn(
      await parkRequest({ id: committed.turn.id, eventIds: committed.turn.eventIds }),
    );
    expect(never).toEqual({
      error: "alreadyCommitted",
      turnId: committed.turn.id,
      committedAt: expect.stringMatching(UTC_TEXT) as string,
    });
    expect(await rowCounts()).toEqual(after);

    expect(lines().map((line) => [line.call, line.trace_id])).toEqual([
      ["parkTurn", PARK_TRACE],
      ["parkTurn", PARK_TRACE],
      ["parkTurn", PARK_TRACE],
    ]);
    expectJobSide(lines());
    expect(db.counts()).toMatchObject({ opened: 3, ended: 3, connectionsOpen: 0, connectionsPeak: 1 });
  });
});

// ---- nothing leaks ----------------------------------------------------------------------------------------------------

describe("the span and log capture of every test above", () => {
  it("holds no 555-01xx number, address or word of the text: labels, ids and numbers only; and no unhandled rejection reached this isolate", async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    // The capture is not empty: the frontier's spans (ok and failed) and every call's timing line are in it.
    expect(SPANS.filter((span) => span.hop === "frontier").length).toBeGreaterThanOrEqual(3);
    expect(dbCallLinesOf(LOGGED).length).toBeGreaterThanOrEqual(20);

    expect(leaks(SPANS, [...NUMBER_FORMS, ...TEXT_WORDS])).toEqual([]);
    const lowered = LOGGED.map((line) => line.toLowerCase());
    for (const secret of [...NUMBER_FORMS, ...TEXT_WORDS, SAM.personId]) {
      expect(
        lowered.filter((line) => line.includes(secret.toLowerCase())),
        "a log line holds a number, the text's words or a person's id",
      ).toEqual([]);
    }
    expect(lowered.filter((line) => ANY_FICTION_NUMBER.test(line) || /\+[0-9]{7,15}/u.test(line))).toEqual(
      [],
    );
    expect(rejections.map((reason) => String(reason))).toEqual([]);
  });
});
