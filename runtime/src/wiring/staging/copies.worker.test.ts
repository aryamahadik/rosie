// T-1306 (the D-017 path audit's P6c): staging binds the actor's copy sources, RootOptions.copies, over K-05 v1.12's
// readLiveTimers and readStoppedFlag (items 56 and 57) through the job handle (./copies.ts), inside the Workers runtime on
// T-1253's rig (infra/test-rig/files.mjs, key COPIES): this file's own database, migrated, with bundle v0 active and the
// rows ./copies.seed.ts writes (four of the five named fixtures exactly, read-stopped-flag-alex-started on a stand-in in
// its shape, and one live timer whose id copies.ts's isLabel refuses), reached through its own pool pair only,
// HYPERDRIVE_JOB_COPIES and HYPERDRIVE_APP_COPIES, handed in as the env's HYPERDRIVE_JOB and HYPERDRIVE_APP behind doubles
// that count each read of a connection string. Each root here is built as the Worker's is (../root.ts workerRoot:
// composeRoot over stagingOptions(env)), through the two seams stagingOptions names: its handle (./part.ts stagingDb), so
// a test reads T-1254's counts and each call's timing line, and its builders, every part but this card's stood in by its
// nothing-bound answer, so a test sees this card's binding alone whatever the other parts bind (DL-776). The one case
// through workerRoot itself, every part's own builder with it, asserts on this card's own reads and answers alone. The
// reload and the re-read are the actor's own (../../actor/copies/copies.ts ActorCopies refreshTimers and rereadStopped),
// over a HANDLE_ACTOR instance's own storage (as ./options.worker.test.ts reaches one), with the root's install() setting
// the copy deps. Every database call a test makes of its own goes through T-1254's handle too.
//
//   - the mapping on each fixture's own answer, as K-05 v1.12's binding line says (README "Consumers of v1.12"): each
//     timer column by column from item 56's names to K-34's column names, the address as given; the flag as
//     { result: "phone", stopped, phoneVersion }; notFound and transient as { error } alone;
//   - the bound ports by direct call (Root.copies, the object install() sets): each fixture's case on this file's rows,
//     db/repo's own answer first, then the port's; one job-side client per call, its string read at that call; nothing
//     remembered; the request handed on as the handle id alone;
//   - the reload and the re-read through install(): Sam's timer copied after a lost commit, its sealed address exactly as
//     stored; Morgan Lee's copy empty; Alex's lost STOP read stopped at version 4 and the stand-in's lost START read at
//     version 5, each ending the lost commit's mark; read-stopped-flag-no-phone and a transient answer (the read's
//     connection cut under it) each a failed re-read, the stricter reading kept; a transient reload keeps the copy and
//     marks it stale; a live timer whose id isLabel refuses fails the reload closed (T-1248's runtime note);
//   - failing: the guard's refusal (the file's two bindings crossed), a database that is not there (the pool's own
//     HYPERDRIVE_JOB) and DB_SCHEMA set each throw, by a call's name and SQLSTATE or the guard's labels alone, and the
//     copy fails closed;
//   - unbound (no HYPERDRIVE_JOB), production and the test environment: no copy deps, so install() sets none and each
//     reload and re-read answers unwired, as before this card; production's builder reads ENVIRONMENT alone;
//   - HYPERDRIVE_APP is read 0 times throughout, opened equals ended after every test, no row count moves, no unhandled
//     rejection reaches the isolate, and no log line holds a 555-01xx number, a handle id or a sealed address in any form.
// Test values only (rule 9): the contracts' fixtures, the master's sample cast and the fiction range's numbers.
import commitAlexStart from "@rosie/contracts/data-access/fixtures/commit-alex-start.json";
import commitAlexStop from "@rosie/contracts/data-access/fixtures/commit-alex-stop.json";
import fixtureIndex from "@rosie/contracts/data-access/fixtures/index.json";
import timersNone from "@rosie/contracts/data-access/fixtures/read-live-timers-none.json";
import timersSam from "@rosie/contracts/data-access/fixtures/read-live-timers-sam.json";
import flagStarted from "@rosie/contracts/data-access/fixtures/read-stopped-flag-alex-started.json";
import flagStopped from "@rosie/contracts/data-access/fixtures/read-stopped-flag-alex-stopped.json";
import flagNoPhone from "@rosie/contracts/data-access/fixtures/read-stopped-flag-no-phone.json";
import seedSafetyTimer from "@rosie/contracts/db-schema/safety-incidents/fixtures/seed-safety-timer.json";
import { DataAccessDatabaseError } from "@rosie/db/repo/clocks";
import {
  readLiveTimers,
  readStoppedFlag,
  type LiveTimer,
  type ReadLiveTimersOutcome,
  type ReadLiveTimersResponse,
  type ReadStoppedFlagOutcome,
} from "@rosie/db/repo/copy-reads";
import type { Tx } from "@rosie/db/repo/scope";
import { runInDurableObject } from "cloudflare:test";
import { env as poolEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { ActorCopies } from "../../actor/copies";
import type {
  CopyDeps,
  LiveTimersAnswer,
  SafetyTimerCopy,
  SafetyTimerRow,
  SafetyTimerSource,
  StoppedFlagAnswer,
  StoppedFlagSource,
} from "../../actor/copies/types";
import { composeRoot, environmentOf, workerRoot, type Root } from "../index";
import { skeletonFakes } from "../test-support";
import {
  liveTimersAnswerOf,
  READ_LIVE_TIMERS_CALL,
  READ_STOPPED_FLAG_CALL,
  safetyTimerRowOf,
  stagingCopies,
  stoppedFlagAnswerOf,
} from "./copies";
import {
  ALEX_HANDLE,
  ALEX_STOPPED_PHONE,
  FIXTURE_ROWS,
  ODD_ID_ADDRESS_WORDS,
  ODD_ID_TIMER,
  OWN_ROWS,
  STARTED,
  STARTED_PHONE,
} from "./copies.seed";
import { dbHandle, DbClosedError, DbGuardRefusal, type DbHandle } from "./db";
import { NO_RECEIPT_INPUTS } from "./k05-receipt";
import { NO_TURN_CALL_INPUTS } from "./k05-turn";
import { NO_MODEL_READER_INPUTS } from "./models";
import { stagingOptions, type StagingBuilders, type StagingInputs } from "./options";
import { stagingDb, type DbCallLine, type StagingDb, type StagingEnv } from "./part";
import { NO_SEND_INPUTS } from "./send";
import { NO_DIRECTORY_INPUTS } from "./state-reads";
import { NO_ROW_INPUTS } from "./tool-api-rows";

/** This file's key in the rig's list (infra/test-rig/files.mjs). */
const KEY = "COPIES";
const JOB = `HYPERDRIVE_JOB_${KEY}`;
const APP = `HYPERDRIVE_APP_${KEY}`;
/** The pool's own job binding: its database, rosie_rig_none, is never made, so a connect through it fails. */
const POOL_OWN_JOB = "HYPERDRIVE_JOB";

/** The pool's Hyperdrive bindings, by name. */
const pool = poolEnv as unknown as Readonly<Record<string, Hyperdrive | undefined>>;

function poolBinding(name: string): Hyperdrive {
  const found = pool[name];
  if (found === undefined) throw new Error(`the pool has no Hyperdrive binding ${name}`);
  return found;
}

const DATABASE = inject("rosieRigDatabases")?.[KEY];

const UTC_TEXT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]+)?Z$/u;

/**
 * A resource guard above the project's 30 s for the cases that make many database calls (a connect, the guard and the
 * read for each), as the rig's other files run beside other builders' runs: not part of any test's claim.
 */
const DB_CASE_MS = 90_000;

// ---- the five named fixtures, and their cases on this file's rows -----------------------------------------------------

/** A readLiveTimers exchange as its fixture file holds it. */
interface TimersFixture {
  readonly request: { readonly handleId: string };
  readonly outcome: ReadLiveTimersResponse;
}

/** A readStoppedFlag exchange as its fixture file holds it. */
interface FlagFixture {
  readonly request: { readonly handleId: string };
  readonly outcome: ReadStoppedFlagOutcome;
}

const SAM_TIMERS = timersSam as unknown as TimersFixture;
const NO_TIMERS = timersNone as unknown as TimersFixture;
const ALEX_STOPPED = flagStopped as unknown as FlagFixture;
const ALEX_STARTED = flagStarted as unknown as FlagFixture;
const NO_PHONE = flagNoPhone as unknown as FlagFixture;

/** The five fixtures the card names, by file. */
const NAMED = {
  "read-live-timers-sam.json": SAM_TIMERS,
  "read-live-timers-none.json": NO_TIMERS,
  "read-stopped-flag-alex-stopped.json": ALEX_STOPPED,
  "read-stopped-flag-alex-started.json": ALEX_STARTED,
  "read-stopped-flag-no-phone.json": NO_PHONE,
} as const;

/** Sam, the pro of K-34's seed timer; Morgan Lee, its contact, the pro of none. */
const SAM_HANDLE = SAM_TIMERS.request.handleId;
const MORGAN_HANDLE = NO_TIMERS.request.handleId;

/** Sam's one live timer as read-live-timers-sam.json answers it. */
const SAM_TIMER = ((): LiveTimer => {
  const [timer] = SAM_TIMERS.outcome.timers;
  if (timer === undefined || SAM_TIMERS.outcome.timers.length !== 1) {
    throw new Error("read-live-timers-sam.json answers no one timer");
  }
  return timer;
})();

/** K-34's seed timer row (seed-safety-timer.json), by its own column names. */
const K34_SEED_TIMER = ((): Readonly<Record<string, unknown>> => {
  const rows = seedSafetyTimer.rows as unknown as readonly {
    readonly table: string;
    readonly values: Readonly<Record<string, unknown>>;
  }[];
  const found = rows.find((row) => row.table === "safety_timers");
  if (found === undefined) throw new Error("K-34's seed-safety-timer.json holds no safety_timers row");
  return found.values;
})();

/**
 * Item 56's thirteen fields, each with the K-34 column the copy reads it by (README "v1.12", item 56; K-34 v1
 * safety_timers), written out here pair by pair.
 */
const K34_COLUMNS: readonly (readonly [keyof LiveTimer, string])[] = [
  ["id", "id"],
  ["businessId", "business_id"],
  ["bookingId", "booking_id"],
  ["workerHandleId", "worker_handle_id"],
  ["emergencyContactPersonId", "emergency_contact_person_id"],
  ["emergencyContactHandleId", "emergency_contact_handle_id"],
  ["dueAt", "due_at"],
  ["dueZone", "due_zone"],
  ["address", "address"],
  ["addressForPersonId", "address_for_person_id"],
  ["clockRowId", "clock_row_id"],
  ["state", "state"],
  ["version", "version"],
];

/** K-34's seed timer row with the thirteen columns the copy keeps, and no other: what Sam's reload answers. */
const SAM_ROW = Object.fromEntries(
  K34_COLUMNS.map(([, column]) => [column, K34_SEED_TIMER[column]]),
) as unknown as SafetyTimerRow;

/** The lost commits of Alex's STOP and START (T-1206: a park answered alreadyCommitted), by their turn ids. */
const STOP_TURN = commitAlexStop.request.turn.id;
const START_TURN = commitAlexStart.request.turn.id;

/** One timers case on this file's rows: what db/repo's read answers, and what the port answers. */
interface TimersCase {
  readonly name: string;
  readonly handleId: string;
  readonly answer: ReadLiveTimersOutcome;
  readonly port: LiveTimersAnswer;
}

/** The two readLiveTimers fixtures, each on its own rows. */
const TIMER_CASES: readonly TimersCase[] = [
  {
    name: "read-live-timers-sam.json",
    handleId: SAM_HANDLE,
    answer: SAM_TIMERS.outcome,
    port: { result: "timers", timers: [SAM_ROW] },
  },
  {
    name: "read-live-timers-none.json",
    handleId: MORGAN_HANDLE,
    answer: NO_TIMERS.outcome,
    port: { result: "timers", timers: [] },
  },
];

/** One stopped-flag case on this file's rows: the handle asked, db/repo's answer, the port's, and a stand-in's or not. */
interface FlagCase {
  readonly name: string;
  readonly handleId: string;
  readonly answer: ReadStoppedFlagOutcome;
  readonly port: StoppedFlagAnswer;
  readonly standIn: boolean;
}

/**
 * The three readStoppedFlag fixtures. read-stopped-flag-alex-started.json stands on STARTED's rows: its answer differs
 * from the fixture's in the handle id alone, and the port's, which names no handle, not at all.
 */
const FLAG_CASES: readonly FlagCase[] = [
  {
    name: "read-stopped-flag-alex-stopped.json",
    handleId: ALEX_STOPPED.request.handleId,
    answer: ALEX_STOPPED.outcome,
    port: { result: "phone", stopped: true, phoneVersion: 4 },
    standIn: false,
  },
  {
    name: "read-stopped-flag-alex-started.json",
    handleId: STARTED.handleId,
    answer: { ...ALEX_STARTED.outcome, handleId: STARTED.handleId } as ReadStoppedFlagOutcome,
    port: { result: "phone", stopped: false, phoneVersion: 5 },
    standIn: true,
  },
  {
    name: "read-stopped-flag-no-phone.json",
    handleId: NO_PHONE.request.handleId,
    answer: NO_PHONE.outcome,
    port: { error: "notFound" },
    standIn: false,
  },
];

// ---- what no log line may hold ----------------------------------------------------------------------------------------

/** Every row the seed wrote, as it wrote them. */
const SEEDED = [...FIXTURE_ROWS, ...OWN_ROWS];
const HANDLE_ROWS = SEEDED.filter((row) => row.table === "handles").map((row) => row.values);

/** Every number this file's handles hold (whole fiction-range numbers, as the seeds write them). */
const NUMBERS = HANDLE_ROWS.filter((row) => row.kind === "phone").map((row) => String(row.address));
/** Every one of them in each form a number could leak in. */
const NUMBER_FORMS = NUMBERS.flatMap((address) => [
  address,
  address.slice(1),
  address.slice(2),
  `${address.slice(5, 8)}-${address.slice(8)}`,
]);
/** Every email address and every handle id this file's handles hold. */
const EMAILS = HANDLE_ROWS.filter((row) => row.kind === "email").map((row) => String(row.address));
const HANDLE_IDS = HANDLE_ROWS.map((row) => String(row.id));

/** What a sealed value's hex text spells, were it ever opened as text. */
const wordsOf = (hexText: string): string =>
  new TextDecoder().decode(
    Uint8Array.from((hexText.slice(2).match(/../gu) ?? []).map((pair) => Number.parseInt(pair, 16))),
  );

/** Each sealed address of this file's timers, as stored, as its bare hex digits and as the words its bytes spell. */
const SEALED_FORMS = [SAM_TIMER.address, ODD_ID_TIMER.address].flatMap((address) => [
  address,
  address.slice(2),
  wordsOf(address),
]);

// ---- what the whole file captures -------------------------------------------------------------------------------------

/** Every line written to the console or as a call's timing, across the file; and the lines of the test that is running. */
const LOGGED: string[] = [];
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
  readonly schema?: string;
}

/**
 * Every env a test built, the envs of the roots that bind this card's part alone, and every handle: checked after each
 * test (HYPERDRIVE_APP's string never read; by this card's part, not by its name either; opened equals ended).
 */
const ENVS: TestEnv[] = [];
const COPIES_ONLY_ENVS: TestEnv[] = [];
const HANDLES: Pick<DbHandle, "counts">[] = [];

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
  send: () => NO_SEND_INPUTS,
  flags: () => null,
  testPhone: () => null,
};

/** The Worker's env as wrangler.jsonc's vars give it, with this file's pair behind counting doubles. */
function envOf(options: EnvOptions = {}): TestEnv {
  const names: string[] = [];
  const jobName = options.job === undefined ? JOB : options.job;
  const job = jobName === null ? null : counted(poolBinding(jobName));
  const app = counted(poolBinding(APP));
  const values: Record<string, unknown> = {
    ENVIRONMENT: options.environment ?? "staging",
    BASE_PATH: "/test",
    DB_SCHEMA: options.schema ?? "",
    GIT_SHA: "test-sha",
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

/** A handle of the test's own on this file's job binding (T-1254's, its quiet socket), for a read or a cut of its own. */
function ownHandle(): DbHandle {
  const handle = dbHandle({ ENVIRONMENT: "staging", DB_SCHEMA: "", HYPERDRIVE_JOB: poolBinding(JOB) });
  HANDLES.push(handle);
  return handle;
}

interface Staged {
  /** The root's one handle (T-1254's, through ./part.ts): its counts are the root's. */
  readonly db: StagingDb;
  /** What stagingOptions gave: this card's input, every other part's null. */
  readonly inputs: StagingInputs;
  /** Each call's timing line the handle wrote, in order. */
  readonly lines: () => DbCallLine[];
}

/** The root's handle over the test's env, and staging's inputs with this card's part the only one bound. */
function stagedOver(testEnv: TestEnv): Staged {
  const written: string[] = [];
  const db = stagingDb(testEnv.env, {
    write: (line) => {
      written.push(line);
      LOGGED.push(line);
    },
  });
  HANDLES.push(db);
  COPIES_ONLY_ENVS.push(testEnv);
  const inputs = stagingOptions(testEnv.env, { db, builders: EVERY_OTHER_PART_UNBOUND });
  return { db, inputs, lines: () => written.map((line) => JSON.parse(line) as DbCallLine) };
}

interface Rooted extends Staged {
  readonly root: Root;
}

/**
 * A root built as workerRoot builds the Worker's (composeRoot over stagingOptions(env)), over the test's env, with its
 * handle kept for the test to read, and this card's part (./copies.ts stagingCopies, as STAGING_BUILDERS holds it) the
 * only one bound.
 */
function rootOver(testEnv: TestEnv): Rooted {
  const staged = stagedOver(testEnv);
  const root = composeRoot({
    environment: environmentOf(testEnv.env),
    actors: null,
    vars: testEnv.env,
    ...staged.inputs,
  });
  return { ...staged, root };
}

/** The two sources a root holds for the copies: install() sets them (`setCopyDeps`). */
function sourcesOf(root: Root): { readonly timers: SafetyTimerSource; readonly phones: StoppedFlagSource } {
  const copies: CopyDeps | null = root.copies;
  if (copies === null) throw new Error("the root holds no copy deps");
  const { timers, phones } = copies;
  if (phones === undefined) throw new Error("the root's copy deps hold no stopped-flag source");
  return { timers, phones };
}

// ---- the actor's copies, over a Durable Object's own storage ------------------------------------------------------------

/** A HANDLE_ACTOR instance of the test's own (env.staging binds the namespace, and the pool runs env.staging). */
function actorStub(name: string) {
  const namespace = poolEnv.HANDLE_ACTOR;
  if (namespace === undefined) throw new Error("env.staging binds no HANDLE_ACTOR");
  return namespace.get(namespace.idFromName(`t1306-${name}-${crypto.randomUUID()}`));
}

type ActorStub = ReturnType<typeof actorStub>;

/**
 * Runs `use` on the actor's copies over the instance's own storage (../../actor/copies/copies.ts ActorCopies, as the
 * handle actor keeps them), inside the Durable Object: its reload and re-read reach whatever copy deps are set now.
 */
function inCopies<T>(stub: ActorStub, use: (copies: ActorCopies) => Promise<T>): Promise<T> {
  return runInDurableObject(stub, (_actor, state) =>
    use(new ActorCopies({ storage: state.storage, now: () => Date.now() })),
  );
}

/** Runs `body` with the root's ports, the copy deps among them, installed for the isolate; puts the earlier ones back. */
async function installed<T>(root: Root, body: () => Promise<T>): Promise<T> {
  const restore = root.install();
  try {
    return await body();
  } finally {
    restore();
  }
}

/** What Sam's timer is as the copy keeps it: read-live-timers-sam.json's timer, the address exactly as stored. */
const SAM_COPY: Omit<SafetyTimerCopy, "refreshedAt"> = {
  timerId: SAM_TIMER.id,
  state: SAM_TIMER.state,
  version: SAM_TIMER.version,
  dueAt: SAM_TIMER.dueAt,
  dueZone: SAM_TIMER.dueZone,
  address: SAM_TIMER.address,
  addressFor: SAM_TIMER.addressForPersonId,
  contact: { personId: SAM_TIMER.emergencyContactPersonId, handleId: SAM_TIMER.emergencyContactHandleId },
  workerHandleId: SAM_TIMER.workerHandleId,
  clockRowId: SAM_TIMER.clockRowId,
  businessId: SAM_TIMER.businessId,
  bookingId: SAM_TIMER.bookingId,
};

// ---- helpers ----------------------------------------------------------------------------------------------------------

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

/** What a promise settled with: kept, so a call started before a wait never rejects with nothing to catch it. */
type Settled<T> = { readonly answered: T } | { readonly failed: unknown };

function settled<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (answered) => ({ answered }),
    (failed: unknown) => ({ failed }),
  );
}

function answeredOf<T>(outcome: Settled<T>): T {
  if (!("answered" in outcome)) throw new Error("the call threw");
  return outcome.answered;
}

/** K-05 v1.12's own answers on this file's rows, read on the runtime side through a handle of the test's own. */
function k05Timers(handleId: string): Promise<ReadLiveTimersOutcome> {
  return ownHandle().runtime(READ_LIVE_TIMERS_CALL, (sql) => readLiveTimers(sql, { handleId }));
}

function k05Flag(handleId: string): Promise<ReadStoppedFlagOutcome> {
  return ownHandle().runtime(READ_STOPPED_FLAG_CALL, (sql) => readStoppedFlag(sql, { handleId }));
}

/** The row count of each table the reads read or the seed wrote. */
interface RowCounts {
  readonly businesses: number;
  readonly persons: number;
  readonly handles: number;
  readonly person_handles: number;
  readonly person_roles: number;
  readonly phones: number;
  readonly bookings: number;
  readonly turns: number;
  readonly clock_rows: number;
  readonly safety_timers: number;
}

/**
 * Those row counts in this file's database, read on the runtime side through a handle of the test's own (rosie_job with
 * no business scope sees every business's rows).
 */
async function rowCounts(): Promise<RowCounts> {
  const rows = await ownHandle().runtime(
    "rowCounts",
    (sql) => sql<RowCounts[]>`
      select (select count(*) from businesses)::int as businesses,
             (select count(*) from persons)::int as persons,
             (select count(*) from handles)::int as handles,
             (select count(*) from person_handles)::int as person_handles,
             (select count(*) from person_roles)::int as person_roles,
             (select count(*) from phones)::int as phones,
             (select count(*) from bookings)::int as bookings,
             (select count(*) from turns)::int as turns,
             (select count(*) from clock_rows)::int as clock_rows,
             (select count(*) from safety_timers)::int as safety_timers`,
  );
  const [row] = rows;
  if (row === undefined) throw new Error("the row counts were not read");
  return { ...row };
}

/** What the seed wrote (./copies.seed.ts), and nothing since: no test of this file writes a row. */
const SEEDED_ROWS: RowCounts = {
  // K-04's three business heads.
  businesses: 3,
  // K-04's six, Morgan Lee and the stand-in.
  persons: 8,
  // K-04's seven (Alex's email among them), Morgan Lee's and the stand-in's.
  handles: 9,
  person_handles: 9,
  // K-04's nine, and Alex's customer role at the movers.
  person_roles: 10,
  // Morgan Lee's, Alex's (stopped at version 4) and the stand-in's (started, version 5).
  phones: 3,
  bookings: 1,
  turns: 1,
  // Sam's timer's and Riley's.
  clock_rows: 2,
  safety_timers: 2,
};

/**
 * A backend of this database, of this login, that waits on a lock: the read under way. Asked until there is one, each
 * time on a fresh reading (inside a transaction PostgreSQL keeps the first one it gave until the transaction ends).
 */
async function waitingBackend(tx: Tx): Promise<number> {
  for (let asked = 0; asked < 800; asked += 1) {
    await tx`select pg_stat_clear_snapshot()`;
    const waiting = await tx<{ pid: number }[]>`
      select pid from pg_stat_activity
      where datname = current_database() and usename = current_user and pid <> pg_backend_pid()
        and wait_event_type = 'Lock'`;
    const [only] = waiting;
    if (waiting.length === 1 && only !== undefined) return only.pid;
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error("no read ever waited on the lock");
}

/**
 * Starts `read` (one reload or re-read) and cuts its connection under it: a job-side client of the test's own locks the
 * read's one table (rosie_job may: it holds UPDATE on phones and on safety_timers, db/migrations/0012 and 0016), so the
 * read waits at its select; the one backend of this database that then waits on a lock is the read's, and it is ended
 * (pg_terminate_backend, which a login may send its own sessions; never a backend of another database). The read's
 * statement in flight fails with its connection lost, which K-05 answers transient. Resolves with what `read` settled
 * with, after the lock is gone.
 */
async function cutUnder<T>(table: "phones" | "safety_timers", read: () => Promise<T>): Promise<Settled<T>> {
  const started = await ownHandle().runtime("cutTheRead", (sql) =>
    sql.begin(async (tx) => {
      await tx`lock table ${tx(table)} in access exclusive mode`;
      const reading = settled(read());
      const pid = await waitingBackend(tx);
      const ended = await tx<{ ended: boolean }[]>`select pg_terminate_backend(${pid}) as ended`;
      if (ended[0]?.ended !== true) throw new Error("the read's backend was not ended");
      // Handed out in an object, so the transaction ends without waiting for the read.
      return { reading };
    }),
  );
  return started.reading;
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

/** Whether a text holds a number of this file's handles in any form, or any + and 7 to 15 digits. */
const holdsANumber = (text: string): boolean =>
  NUMBER_FORMS.some((form) => text.includes(form)) || /\+[0-9]{7,15}/u.test(text);

/** No text holds the binding's string, host, user, password or database, a number, a handle id or a sealed address. */
function expectNothingOf(binding: { readonly connectionString: string }, error: unknown): void {
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
  for (const text of textsOf(error)) {
    for (const part of parts) {
      expect(holds(text, part), "a text holds a part of the binding's string").toBe(false);
    }
    expect(holdsANumber(text), "a text holds a number").toBe(false);
    for (const id of HANDLE_IDS) expect(holds(text, id), "a text holds a handle id").toBe(false);
    for (const form of SEALED_FORMS) expect(text.includes(form), "a text holds a sealed address").toBe(false);
  }
}

/** Each timing line is one of this card's reads on the runtime side: HYPERDRIVE_JOB, the login rosie_worker_job, no trace. */
function expectReads(lines: readonly DbCallLine[], calls: readonly string[]): void {
  expect(lines.map((line) => line.call)).toEqual(calls);
  for (const line of lines) {
    expect(line).toEqual({
      level: "info",
      msg: "dbCall",
      trace_id: null,
      call: expect.stringMatching(/^(readLiveTimers|readStoppedFlag)$/u) as string,
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

beforeEach(() => {
  testLog = [];
  const keep = (...args: unknown[]): void => {
    const line = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
    testLog.push(line);
    LOGGED.push(line);
  };
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
  // The job side only: HYPERDRIVE_APP's connection string is never read for these reads, and this card's part never
  // reads HYPERDRIVE_APP by its name either; no binding named HYPERDRIVE is read at all.
  for (const made of ENVS) {
    expect(made.app.reads.n).toBe(0);
    expect(made.names).not.toContain("HYPERDRIVE");
  }
  for (const made of COPIES_ONLY_ENVS) expect(made.names).not.toContain("HYPERDRIVE_APP");
});

// ---- the rig ----------------------------------------------------------------------------------------------------------

describe("this file's database on the rig", () => {
  it("is this run's own, and the five cases are K-05 v1.12's accepted readLiveTimers and readStoppedFlag fixtures, four on their own rows and one on a stand-in's", () => {
    expect(DATABASE).toMatch(/^rosie_rig_[0-9a-f]{8}_copies$/u);
    const accepted = (
      fixtureIndex as unknown as { fixtures: { file: string; def?: string; expect: string }[] }
    ).fixtures
      .filter(
        (entry) =>
          entry.expect === "accept" &&
          (entry.def === "readLiveTimers.exchange" || entry.def === "readStoppedFlag.exchange"),
      )
      .map((entry) => entry.file);
    expect(accepted).toHaveLength(5);
    expect(Object.keys(NAMED).sort()).toEqual([...accepted].sort());
    expect([...TIMER_CASES, ...FLAG_CASES].map((each) => each.name).sort()).toEqual([...accepted].sort());
    expect(FLAG_CASES.filter((each) => each.standIn).map((each) => each.name)).toEqual([STARTED.fixture]);
    // The stand-in's fixture asks about Alex's handle, as the stopped one does: the one phone row it differs in.
    expect(ALEX_STARTED.request.handleId).toBe(ALEX_HANDLE);
    expect(ALEX_STOPPED.request.handleId).toBe(ALEX_HANDLE);
    expect(ALEX_STARTED.outcome).toMatchObject({ handleId: ALEX_HANDLE, stopped: false, phoneVersion: 5 });
    // The seed's two phone rows for the two flags: Alex's at version 4, the stand-in's at 5, under its own number.
    expect(ALEX_STOPPED_PHONE).toMatchObject({
      handle_id: ALEX_HANDLE,
      stopped: true,
      chat_open: false,
      version: 4,
    });
    expect(STARTED_PHONE).toMatchObject({
      handle_id: STARTED.handleId,
      number: STARTED.number,
      stopped: false,
      chat_open: true,
      version: 5,
    });
    // Every number a whole one of the fiction range, each handle's own.
    expect(new Set(NUMBERS).size).toBe(NUMBERS.length);
    expect(NUMBERS).toContain(STARTED.number);
    for (const number of NUMBERS) expect(number).toMatch(/^\+1[0-9]{10}$/u);
  });

  it("holds the rows the seed's header lists, and nothing a test wrote", async () => {
    expect(await rowCounts()).toEqual(SEEDED_ROWS);
  });
});

// ---- the mapping ------------------------------------------------------------------------------------------------------

describe("the mapping: K-05 v1.12's binding line on each fixture's own answer", () => {
  it("each timer column by column, from item 56's names to K-34's column names, each value as given: read-live-timers-sam's one timer is K-34's seed row, its sealed address exactly as stored", () => {
    const row = safetyTimerRowOf(SAM_TIMER);

    expect(K34_COLUMNS).toHaveLength(13);
    for (const [name, column] of K34_COLUMNS) {
      expect(row[column], `${name} as ${column}`).toBe(SAM_TIMER[name]);
      // The read answers the very value K-34's seed stores in that column.
      expect(row[column], column).toBe(K34_SEED_TIMER[column]);
    }
    // The thirteen columns, and nothing else.
    expect(Object.keys(row).sort()).toEqual(K34_COLUMNS.map(([, column]) => column).sort());
    expect(row).toStrictEqual(SAM_ROW);
    // The address is K-34's sealed bytes in PostgreSQL's hex text form, never opened or decoded.
    expect(row.address).toMatch(/^\\x(?:[0-9a-f]{2})+$/u);
    expect(row.address).toBe(SAM_TIMER.address);
    expect(row.address).not.toBe(wordsOf(SAM_TIMER.address));
  });

  it("the reload's answers: read-live-timers-sam as { result: 'timers', timers: [its row] }, read-live-timers-none as an empty list, an answer, and transient as { error } alone", () => {
    for (const { name, answer, port } of TIMER_CASES) {
      expect(liveTimersAnswerOf(answer), name).toStrictEqual(port);
    }
    expect(liveTimersAnswerOf({ error: "transient", sqlstate: "40001" })).toStrictEqual({
      error: "transient",
    });
  });

  it("the re-read's answers: the stopped and started flags as { result: 'phone', stopped, phoneVersion }; read-stopped-flag-no-phone and transient as { error } alone, never not stopped", () => {
    for (const fixture of [ALEX_STOPPED, ALEX_STARTED, NO_PHONE]) {
      const found = FLAG_CASES.find((each) => NAMED[each.name as keyof typeof NAMED] === fixture);
      if (found === undefined) throw new Error("a flag fixture has no case");
      expect(stoppedFlagAnswerOf(fixture.outcome), found.name).toStrictEqual(found.port);
    }
    expect(NO_PHONE.outcome).toEqual({
      error: "notFound",
      table: "phones",
      rowId: NO_PHONE.request.handleId,
    });
    expect(stoppedFlagAnswerOf({ error: "transient", sqlstate: "57P01" })).toStrictEqual({
      error: "transient",
    });
  });

  it("hands on what the port names alone, whatever else an answer holds: no other column of a timer, no handle id, table, row id or SQLSTATE", () => {
    const wider = {
      handleId: SAM_HANDLE,
      timers: [{ ...SAM_TIMER, workerPersonId: "person-sam", contactYesAt: "2026-10-20T14:00:00Z" }],
      businessId: "biz-movers",
    } as unknown as ReadLiveTimersOutcome;
    expect(liveTimersAnswerOf(wider)).toStrictEqual({ result: "timers", timers: [SAM_ROW] });

    const flag = { handleId: ALEX_HANDLE, stopped: true, phoneVersion: 4, number: NUMBERS[1] };
    expect(stoppedFlagAnswerOf(flag as unknown as ReadStoppedFlagOutcome)).toStrictEqual({
      result: "phone",
      stopped: true,
      phoneVersion: 4,
    });
    expect(stoppedFlagAnswerOf(NO_PHONE.outcome)).toStrictEqual({ error: "notFound" });
  });
});

// ---- the bound ports by direct call -----------------------------------------------------------------------------------

describe("the copy deps of a root composed for staging (Root.copies, which install() sets): K-05 v1.12 items 56 and 57 through the job handle", () => {
  it.each(TIMER_CASES)(
    "$name: K-05 answers the fixture's answer on this file's rows, and the reload's source the binding line's mapping of it",
    async ({ name, handleId, answer, port }) => {
      const testEnv = envOf();
      const { root, db, inputs, lines } = rootOver(testEnv);
      // Nothing was read to build the root but the environment and the binding's presence: no connection string.
      expect(testEnv.job?.reads.n).toBe(0);
      expect(db.counts()).toMatchObject({ opened: 0, ended: 0 });
      expect(root.copies).not.toBeNull();
      expect(root.copies).toBe(inputs.copies);

      // The rows stand in the fixture's case: db/repo's own read answers the fixture's own answer.
      expect(await k05Timers(handleId), name).toEqual(answer);

      const found = await sourcesOf(root).timers.liveTimers({ handleId });

      expect(found, name).toStrictEqual(port);
      // One short-lived client for the call, its connection string read at that call, on the job side.
      expectReads(lines(), [READ_LIVE_TIMERS_CALL]);
      expect(testEnv.job?.reads.n).toBe(1);
      expect(db.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0, connectionsPeak: 1 });
    },
    DB_CASE_MS,
  );

  it.each(FLAG_CASES)(
    "$name: K-05 answers the fixture's answer on this file's rows (under the stand-in's handle where it is one), and the re-read's source the binding line's mapping of it",
    async ({ name, handleId, answer, port, standIn }) => {
      const testEnv = envOf();
      const { root, db, lines } = rootOver(testEnv);
      expect(testEnv.job?.reads.n).toBe(0);

      expect(await k05Flag(handleId), name).toEqual(answer);
      if (!standIn) expect(answer).toBe(NAMED[name as keyof typeof NAMED].outcome);

      const found = await sourcesOf(root).phones.stoppedFlag({ handleId });

      expect(found, name).toStrictEqual(port);
      expectReads(lines(), [READ_STOPPED_FLAG_CALL]);
      expect(testEnv.job?.reads.n).toBe(1);
      expect(db.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0, connectionsPeak: 1 });
    },
    DB_CASE_MS,
  );

  it(
    "each call reads the rows again on a client of its own: nothing is remembered for a root",
    async () => {
      const testEnv = envOf();
      const { root, db, lines } = rootOver(testEnv);
      const { timers, phones } = sourcesOf(root);

      const first = await phones.stoppedFlag({ handleId: ALEX_HANDLE });
      const second = await phones.stoppedFlag({ handleId: ALEX_HANDLE });
      const reloaded = await timers.liveTimers({ handleId: SAM_HANDLE });
      const again = await timers.liveTimers({ handleId: SAM_HANDLE });

      expect(first).toStrictEqual({ result: "phone", stopped: true, phoneVersion: 4 });
      expect(second).toStrictEqual(first);
      expect(second).not.toBe(first);
      expect(again).toStrictEqual(reloaded);
      expect(again).not.toBe(reloaded);
      expectReads(lines(), [
        READ_STOPPED_FLAG_CALL,
        READ_STOPPED_FLAG_CALL,
        READ_LIVE_TIMERS_CALL,
        READ_LIVE_TIMERS_CALL,
      ]);
      expect(testEnv.job?.reads.n).toBe(4);
      expect(db.counts()).toMatchObject({ opened: 4, ended: 4, connectionsOpen: 0, connectionsPeak: 1 });
    },
    DB_CASE_MS,
  );

  it(
    "hands each read the handle id alone: a request carrying a business beside it is still Sam's timers, though db/repo refuses that request as it stands; and a handle id that reads as a number is refused before any statement, naming no number",
    async () => {
      const { root, db } = rootOver(envOf());
      const { timers, phones } = sourcesOf(root);
      const wider = { handleId: SAM_HANDLE, businessId: SAM_TIMER.businessId } as unknown as {
        handleId: string;
      };

      expect(await timers.liveTimers(wider)).toStrictEqual({ result: "timers", timers: [SAM_ROW] });
      // db/repo's own read refuses that request (refuse-live-timers-business-scope): the port never sends it.
      const refused = await rejectionOf(
        ownHandle().runtime(READ_LIVE_TIMERS_CALL, (sql) => readLiveTimers(sql, wider as never)),
      );
      expect(refused).toBeInstanceOf(TypeError);

      const asNumber = await rejectionOf(phones.stoppedFlag({ handleId: NUMBERS[0] ?? "" }));
      expect(asNumber).toBeInstanceOf(TypeError);
      expect((asNumber as Error).message).toBe(
        "readStoppedFlag: handleId is a K-04 handle id (a K-08 safe id), never a number or an address",
      );
      expectNothingOf(poolBinding(JOB), asNumber);
      expect(db.counts()).toMatchObject({ opened: 2, ended: 2, connectionsOpen: 0 });
    },
    DB_CASE_MS,
  );

  it(
    "the Worker's own root (workerRoot over the env, every part's own builder) holds this card's copy deps: its reload and re-read answer from this file's rows, each read one dbCall line on the Worker's log",
    async () => {
      const testEnv = envOf();

      const root = workerRoot(testEnv.env);

      expect(root.environment).toBe("staging");
      const { timers, phones } = sourcesOf(root);
      expect(await timers.liveTimers({ handleId: SAM_HANDLE })).toStrictEqual({
        result: "timers",
        timers: [SAM_ROW],
      });
      expect(await phones.stoppedFlag({ handleId: ALEX_HANDLE })).toStrictEqual({
        result: "phone",
        stopped: true,
        phoneVersion: 4,
      });
      // This card's own reads alone: its two calls, each one dbCall line (labels and numbers only) on console.log.
      const lines = (jsonLinesOf(testLog, "dbCall") as unknown as DbCallLine[]).filter(
        (line) => line.call === READ_LIVE_TIMERS_CALL || line.call === READ_STOPPED_FLAG_CALL,
      );
      expectReads(lines, [READ_LIVE_TIMERS_CALL, READ_STOPPED_FLAG_CALL]);
    },
    DB_CASE_MS,
  );
});

// ---- the reload and the re-read through install() ---------------------------------------------------------------------

describe("the actor's reload and re-read through the root's install(), over a Durable Object's own storage", () => {
  it(
    "read-live-timers-sam: after a commit whose answer was lost, the reload copies Sam's running timer, its sealed address exactly as stored, and ends the stale mark",
    async () => {
      const { root, lines } = rootOver(envOf());

      const seen = await installed(root, () =>
        inCopies(actorStub("sam-timers"), async (copies) => {
          copies.markTimersStale();
          const stale = copies.timersStale();
          const result = await copies.refreshTimers(SAM_HANDLE);
          return { stale, result, timers: copies.readTimers(), staleAfter: copies.timersStale() };
        }),
      );

      expect(seen.stale).toBe(true);
      expect(seen.result).toBe("refreshed");
      expect(seen.timers).toEqual([{ ...SAM_COPY, refreshedAt: expect.any(Number) as number }]);
      expect(seen.timers[0]?.address).toBe(K34_SEED_TIMER.address);
      expect(seen.staleAfter).toBe(false);
      expectReads(lines(), [READ_LIVE_TIMERS_CALL]);
    },
    DB_CASE_MS,
  );

  it(
    "read-live-timers-none: Morgan Lee's own actor reloads none of the timers she is the contact of: an empty list, an answer, so the copy holds none and its stale mark ends",
    async () => {
      const { root, lines } = rootOver(envOf());

      const seen = await installed(root, () =>
        inCopies(actorStub("morgan-timers"), async (copies) => {
          copies.markTimersStale();
          const result = await copies.refreshTimers(MORGAN_HANDLE);
          return { result, timers: copies.readTimers(), stale: copies.timersStale() };
        }),
      );

      expect(seen).toEqual({ result: "refreshed", timers: [], stale: false });
      expectReads(lines(), [READ_LIVE_TIMERS_CALL]);
    },
    DB_CASE_MS,
  );

  it(
    "read-stopped-flag-alex-stopped: after a park answered alreadyCommitted for his STOP's turn, the re-read reads the phone row stopped at version 4; the copy takes it, and the lost commit's mark ends",
    async () => {
      const { root, lines } = rootOver(envOf());

      const seen = await installed(root, () =>
        inCopies(actorStub("alex-stopped"), async (copies) => {
          copies.noteLostCommit(STOP_TURN, 1);
          const before = copies.readStopped();
          const result = await copies.rereadStopped(ALEX_HANDLE);
          return { before, result, after: copies.readStopped(), unread: copies.stoppedUnread() };
        }),
      );

      // While the lost commit's mark held, the stricter reading: stopped.
      expect(seen.before).toMatchObject({ stopped: true, phoneVersion: null, lost: { turnId: STOP_TURN } });
      expect(seen.result).toBe("copied");
      expect(seen.after).toEqual({
        stopped: true,
        phoneVersion: 4,
        turnId: null,
        setAt: expect.any(Number) as number,
      });
      expect(seen.unread).toBe(false);
      expectReads(lines(), [READ_STOPPED_FLAG_CALL]);
    },
    DB_CASE_MS,
  );

  it(
    "read-stopped-flag-alex-started (on its stand-in): a copy holding his STOP at version 4 re-reads after his START's lost commit and takes the newer version, not stopped: texts are on again in the copy as in the row",
    async () => {
      const { root, lines } = rootOver(envOf());

      const seen = await installed(root, () =>
        inCopies(actorStub("alex-started"), async (copies) => {
          // His STOP's commit answered, as the lease copies it (T-269), then his START's commit lost (T-1206).
          copies.noteStopped({ stopped: true, phoneVersion: 4, turnId: STOP_TURN, opened: 1 });
          copies.noteLostCommit(START_TURN, 2);
          const before = copies.readStopped();
          const result = await copies.rereadStopped(STARTED.handleId);
          return { before, result, after: copies.readStopped(), unread: copies.stoppedUnread() };
        }),
      );

      expect(seen.before).toMatchObject({ stopped: true, phoneVersion: 4, lost: { turnId: START_TURN } });
      expect(seen.result).toBe("copied");
      expect(seen.after).toEqual({
        stopped: false,
        phoneVersion: 5,
        turnId: null,
        setAt: expect.any(Number) as number,
      });
      expect(seen.unread).toBe(false);
      expectReads(lines(), [READ_STOPPED_FLAG_CALL]);
    },
    DB_CASE_MS,
  );

  it(
    "read-stopped-flag-no-phone: no phone row is a failed re-read, never not stopped: the copy keeps the stricter reading, the lost commit's mark included",
    async () => {
      const { root, lines } = rootOver(envOf());

      const seen = await installed(root, () =>
        inCopies(actorStub("sam-no-phone"), async (copies) => {
          copies.noteLostCommit("turn-t1306-sam-lost", 1);
          const result = await copies.rereadStopped(NO_PHONE.request.handleId);
          return { result, after: copies.readStopped(), unread: copies.stoppedUnread() };
        }),
      );

      expect(seen.result).toBe("failed");
      expect(seen.after).toMatchObject({ stopped: true, lost: { turnId: "turn-t1306-sam-lost" } });
      expect(seen.unread).toBe(true);
      // The read was made, and answered notFound: a failed re-read, not an unwired one.
      expectReads(lines(), [READ_STOPPED_FLAG_CALL]);
    },
    DB_CASE_MS,
  );

  it(
    "a transient answer (the re-read's connection cut under it): the source answers { error: 'transient' } and the re-read fails, keeping the stricter reading; the next re-read reads the row and ends the mark",
    async () => {
      const before = await rowCounts();
      const { root, db, lines } = rootOver(envOf());
      const { phones } = sourcesOf(root);
      const stub = actorStub("alex-transient");

      const direct = answeredOf(
        await cutUnder("phones", () => phones.stoppedFlag({ handleId: ALEX_HANDLE })),
      );
      expect(direct).toStrictEqual({ error: "transient" });

      const seen = await installed(root, async () => {
        expect(await inCopies(stub, (copies) => Promise.resolve(copies.noteLostCommit(STOP_TURN, 1)))).toBe(
          true,
        );
        const cut = answeredOf(
          await cutUnder("phones", () =>
            inCopies(stub, async (copies) => ({
              result: await copies.rereadStopped(ALEX_HANDLE),
              after: copies.readStopped(),
            })),
          ),
        );
        const next = await inCopies(stub, async (copies) => ({
          result: await copies.rereadStopped(ALEX_HANDLE),
          after: copies.readStopped(),
        }));
        return { cut, next };
      });

      expect(seen.cut.result).toBe("failed");
      expect(seen.cut.after).toMatchObject({ stopped: true, lost: { turnId: STOP_TURN } });
      expect(seen.next.result).toBe("copied");
      expect(seen.next.after).toEqual({
        stopped: true,
        phoneVersion: 4,
        turnId: null,
        setAt: expect.any(Number) as number,
      });
      // Each read's guard had passed (its timing line is written) before its connection was cut; every client was ended.
      expectReads(lines(), [READ_STOPPED_FLAG_CALL, READ_STOPPED_FLAG_CALL, READ_STOPPED_FLAG_CALL]);
      expect(db.counts()).toMatchObject({ opened: 3, ended: 3, connectionsOpen: 0 });
      expect(await rowCounts()).toEqual(before);
    },
    DB_CASE_MS,
  );

  it(
    "a transient reload (its connection cut under it): the source answers { error: 'transient' }, and the reload keeps the copy as it was and marks it stale; the next reload copies again",
    async () => {
      const { root, db, lines } = rootOver(envOf());
      const { timers } = sourcesOf(root);
      const stub = actorStub("sam-transient");

      const direct = answeredOf(
        await cutUnder("safety_timers", () => timers.liveTimers({ handleId: SAM_HANDLE })),
      );
      expect(direct).toStrictEqual({ error: "transient" });

      const seen = await installed(root, async () => {
        const first = await inCopies(stub, (copies) => copies.refreshTimers(SAM_HANDLE));
        const cut = answeredOf(
          await cutUnder("safety_timers", () =>
            inCopies(stub, async (copies) => ({
              result: await copies.refreshTimers(SAM_HANDLE),
              timers: copies.readTimers(),
              stale: copies.timersStale(),
            })),
          ),
        );
        const next = await inCopies(stub, async (copies) => ({
          result: await copies.refreshTimers(SAM_HANDLE),
          stale: copies.timersStale(),
        }));
        return { first, cut, next };
      });

      expect(seen.first).toBe("refreshed");
      expect(seen.cut.result).toBe("failed");
      expect(seen.cut.timers).toEqual([{ ...SAM_COPY, refreshedAt: expect.any(Number) as number }]);
      expect(seen.cut.stale).toBe(true);
      expect(seen.next).toEqual({ result: "refreshed", stale: false });
      expectReads(lines(), [
        READ_LIVE_TIMERS_CALL,
        READ_LIVE_TIMERS_CALL,
        READ_LIVE_TIMERS_CALL,
        READ_LIVE_TIMERS_CALL,
      ]);
      expect(db.counts()).toMatchObject({ opened: 4, ended: 4, connectionsOpen: 0 });
    },
    DB_CASE_MS,
  );

  it(
    "a live timer whose id copies.ts's isLabel refuses (Riley's, its id holding a space): the source hands it on as the read gives it, and the reload fails closed, the copy kept as it was and marked stale (T-1248's runtime note)",
    async () => {
      const { root, lines } = rootOver(envOf());

      const answer = await sourcesOf(root).timers.liveTimers({ handleId: ODD_ID_TIMER.handleId });
      expect(answer).toMatchObject({
        result: "timers",
        timers: [
          {
            id: ODD_ID_TIMER.id,
            worker_handle_id: ODD_ID_TIMER.handleId,
            clock_row_id: ODD_ID_TIMER.clockRowId,
            address: ODD_ID_TIMER.address,
            state: "running",
          },
        ],
      });

      const seen = await installed(root, () =>
        inCopies(actorStub("riley-odd-id"), async (copies) => {
          const result = await copies.refreshTimers(ODD_ID_TIMER.handleId);
          return { result, timers: copies.readTimers(), stale: copies.timersStale() };
        }),
      );

      expect(seen).toEqual({ result: "failed", timers: [], stale: true });
      expectReads(lines(), [READ_LIVE_TIMERS_CALL, READ_LIVE_TIMERS_CALL]);
    },
    DB_CASE_MS,
  );
});

// ---- bound but failing ------------------------------------------------------------------------------------------------

describe("bound but failing: every failure is thrown, and the copy fails closed", () => {
  it(
    "the file's two bindings crossed (HYPERDRIVE_JOB holding the Tool API's login): the guard refuses each read before it runs, so none runs as rosie_app; the reload and the re-read fail, the copy kept and the stricter reading kept",
    async () => {
      const testEnv = envOf({ job: APP });
      const { root, db, lines } = rootOver(testEnv);
      const { timers, phones } = sourcesOf(root);

      for (const refused of [
        await rejectionOf(timers.liveTimers({ handleId: SAM_HANDLE })),
        await rejectionOf(phones.stoppedFlag({ handleId: ALEX_HANDLE })),
      ]) {
        expect(refused).toBeInstanceOf(DbGuardRefusal);
        expect(refused).toMatchObject({ side: "runtime", binding: "HYPERDRIVE_JOB" });
        expect((refused as DbGuardRefusal).checks).toContain("session_user");
        expectNothingOf(poolBinding(APP), refused);
      }

      const seen = await installed(root, () =>
        inCopies(actorStub("crossed"), async (copies) => {
          copies.noteLostCommit(STOP_TURN, 1);
          return {
            reload: await copies.refreshTimers(SAM_HANDLE),
            reread: await copies.rereadStopped(ALEX_HANDLE),
            timers: copies.readTimers(),
            stale: copies.timersStale(),
            stopped: copies.readStopped(),
          };
        }),
      );

      expect(seen).toMatchObject({
        reload: "failed",
        reread: "failed",
        timers: [],
        stale: true,
        stopped: { stopped: true, lost: { turnId: STOP_TURN } },
      });
      // Each refusal's one log line: the side, the binding's name and the failed checks' labels (T-1254); no timing line.
      const refusals = jsonLinesOf(testLog, "dbGuardRefused");
      expect(refusals).toHaveLength(4);
      for (const line of refusals) {
        expect(line).toMatchObject({ level: "error", side: "runtime", binding: "HYPERDRIVE_JOB" });
        expect(Object.keys(line).sort()).toEqual(["binding", "checks", "level", "msg", "side"]);
      }
      expect(lines()).toEqual([]);
      expect(db.counts()).toMatchObject({ opened: 4, ended: 4, connectionsOpen: 0 });
    },
    DB_CASE_MS,
  );

  it(
    "a database that is not there (the pool's own HYPERDRIVE_JOB, on rosie_rig_none) and DB_SCHEMA set: each is thrown by the call's name and its SQLSTATE or reason alone, and the copy fails closed",
    async () => {
      const notThere = rootOver(envOf({ job: POOL_OWN_JOB }));
      const schemaSet = envOf({ schema: "preview_t1306" });
      const withSchema = rootOver(schemaSet);

      const noDatabase = await rejectionOf(
        sourcesOf(notThere.root).phones.stoppedFlag({ handleId: ALEX_HANDLE }),
      );
      expect(noDatabase).toBeInstanceOf(DataAccessDatabaseError);
      expect(noDatabase).toMatchObject({
        call: "readStoppedFlag",
        code: "3D000",
        table: null,
        constraint: null,
      });
      expect((noDatabase as Error).message).toBe(
        "readStoppedFlag: the database refused the call (SQLSTATE 3D000)",
      );
      expectNothingOf(poolBinding(POOL_OWN_JOB), noDatabase);

      const closed = await rejectionOf(
        sourcesOf(withSchema.root).timers.liveTimers({ handleId: SAM_HANDLE }),
      );
      expect(closed).toBeInstanceOf(DbClosedError);
      expect(closed).toMatchObject({
        call: "readLiveTimers",
        side: "runtime",
        binding: "HYPERDRIVE_JOB",
        reason: "dbSchemaSet",
      });
      // No client is opened through the binding while DB_SCHEMA is set: its string is read 0 times.
      expect(schemaSet.job?.reads.n).toBe(0);

      for (const [name, { root }] of [
        ["not-there", notThere],
        ["schema-set", withSchema],
      ] as const) {
        const seen = await installed(root, () =>
          inCopies(actorStub(name), async (copies) => {
            copies.noteLostCommit(STOP_TURN, 1);
            return {
              reload: await copies.refreshTimers(SAM_HANDLE),
              reread: await copies.rereadStopped(ALEX_HANDLE),
              stale: copies.timersStale(),
              stopped: copies.readStopped(),
            };
          }),
        );
        expect(seen, name).toMatchObject({
          reload: "failed",
          reread: "failed",
          stale: true,
          stopped: { stopped: true, lost: { turnId: STOP_TURN } },
        });
      }
      expect(notThere.lines()).toEqual([]);
      expect(withSchema.lines()).toEqual([]);
      expect(notThere.db.counts()).toMatchObject({ opened: 3, ended: 3, connectionsOpen: 0 });
      expect(withSchema.db.counts()).toMatchObject({ opened: 0, ended: 0 });
    },
    DB_CASE_MS,
  );
});

// ---- unbound, production and the test environment ---------------------------------------------------------------------

describe("no copy deps where nothing is bound: install() sets none, and each reload and re-read answers unwired, as before this card", () => {
  /** The reload and the re-read on a fresh actor's copies, with a lost commit's mark noted first. */
  function unwiredReads(name: string) {
    return inCopies(actorStub(name), async (copies) => {
      copies.noteLostCommit(STOP_TURN, 1);
      return {
        reload: await copies.refreshTimers(SAM_HANDLE),
        reread: await copies.rereadStopped(ALEX_HANDLE),
        stopped: copies.readStopped(),
      };
    });
  }

  const UNWIRED = {
    reload: "unwired",
    reread: "unwired",
    stopped: { stopped: true, lost: { turnId: STOP_TURN } },
  };

  it("HYPERDRIVE_JOB not bound and HYPERDRIVE_APP bound: the builder gives null, reading ENVIRONMENT and HYPERDRIVE_JOB's presence alone; the root holds no copy deps", async () => {
    const testEnv = envOf({ job: null });
    const { root, db, inputs, lines } = rootOver(testEnv);

    expect(stagingCopies({ env: testEnv.env, db })).toBeNull();
    expect(inputs.copies).toBeNull();
    expect(root.copies).toBeNull();
    expect(await installed(root, () => unwiredReads("unbound"))).toMatchObject(UNWIRED);

    // Only the job binding's presence was asked for; HYPERDRIVE_APP by no name (checked after each test, and here).
    expect(new Set(testEnv.names.filter((name) => name.startsWith("HYPERDRIVE")))).toEqual(
      new Set(["HYPERDRIVE_JOB"]),
    );
    expect(testEnv.app.reads.n).toBe(0);
    expect(lines()).toEqual([]);
    expect(jsonLinesOf(testLog, "dbCall")).toEqual([]);
    expect(db.counts()).toMatchObject({ opened: 0, ended: 0 });
  });

  it("production's environment, with both bindings: the builder gives null and reads ENVIRONMENT alone, and the Worker's own root holds no copy deps", async () => {
    const before = await rowCounts();
    const testEnv = envOf({ environment: "production" });

    // The builder alone, were it ever handed production's env: null, ENVIRONMENT read and nothing else.
    const alone = stagingDb(testEnv.env, { write: (line) => LOGGED.push(line) });
    HANDLES.push(alone);
    expect(stagingCopies({ env: testEnv.env, db: alone })).toBeNull();
    expect(testEnv.names).toEqual(["ENVIRONMENT"]);

    const root = workerRoot(testEnv.env);

    expect(root.environment).toBe("production");
    expect(root.copies).toBeNull();
    expect(await installed(root, () => unwiredReads("production"))).toMatchObject(UNWIRED);
    expect(testEnv.names.filter((name) => name.startsWith("HYPERDRIVE"))).toEqual([]);
    expect([testEnv.job?.reads.n, testEnv.app.reads.n]).toEqual([0, 0]);
    expect(jsonLinesOf(testLog, "dbCall")).toEqual([]);
    expect(alone.counts()).toMatchObject({ opened: 0, ended: 0 });
    expect(await rowCounts()).toEqual(before);
  });

  it("the test environment: a root composed with no copies holds none and install() sets none", async () => {
    const root = composeRoot({
      environment: "test",
      sets: { fake: skeletonFakes().ports },
      actors: null,
      vars: { ENVIRONMENT: "staging", GIT_SHA: "test-sha" },
    });

    expect(root.copies).toBeNull();
    expect(await installed(root, () => unwiredReads("test-environment"))).toMatchObject(UNWIRED);
  });
});

// ---- nothing leaks, nothing written -----------------------------------------------------------------------------------

describe("the log capture of every test above", () => {
  it("holds no 555-01xx number in any form, no email address, no handle id and no sealed address, opened or not; no row count moved; and no unhandled rejection reached this isolate", async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    // The capture is not empty: every read's timing line and every refusal's line are in it.
    const copyLines = (jsonLinesOf(LOGGED, "dbCall") as unknown as DbCallLine[]).filter(
      (line) => line.call === READ_LIVE_TIMERS_CALL || line.call === READ_STOPPED_FLAG_CALL,
    );
    expect(copyLines.length).toBeGreaterThanOrEqual(20);
    expect(jsonLinesOf(LOGGED, "dbGuardRefused").length).toBeGreaterThanOrEqual(4);

    expect(NUMBER_FORMS).toHaveLength(32);
    const lowered = LOGGED.map((line) => line.toLowerCase());
    for (const form of NUMBER_FORMS) {
      expect(
        lowered.filter((line) => line.includes(form.toLowerCase())),
        "a log line holds a number",
      ).toEqual([]);
    }
    expect(lowered.filter((line) => /\+[0-9]{7,15}/u.test(line) || line.includes("phone:+"))).toEqual([]);
    for (const email of EMAILS) expect(lowered.filter((line) => line.includes(email))).toEqual([]);
    for (const id of HANDLE_IDS) {
      expect(
        LOGGED.filter((line) => holds(line, id)),
        "a log line holds a handle id",
      ).toEqual([]);
    }
    for (const form of [...SEALED_FORMS, ODD_ID_ADDRESS_WORDS]) {
      expect(
        lowered.filter((line) => line.includes(form.toLowerCase())),
        "a log line holds a sealed address",
      ).toEqual([]);
    }
    expect(await rowCounts()).toEqual(SEEDED_ROWS);
    expect(rejections.map((reason) => String(reason))).toEqual([]);
  });
});
