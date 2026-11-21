// T-1399: staging's row reads and plan calls (./tool-api-rows.ts; the D-017 path audit's P4b; the lead's notes DL-414,
// DL-438 to DL-468, DL-476, DL-757 and DL-768), inside the Workers runtime on T-1253's rig (infra/test-rig/files.mjs, key
// TOOL_API_ROWS) and through its pool bindings only (vitest.config.ts): this file's pair, HYPERDRIVE_JOB_TOOL_API_ROWS and
// HYPERDRIVE_APP_TOOL_API_ROWS, the two Worker logins on this file's own database (migrated, bundle v0 active, seeded by
// ./tool-api-rows.seed.ts), and the pool's own pair, which names rosie_rig_none, never made. Each test hands the binding
// (stagingRowCalls), a root composed for staging, or the Worker's own root (workerRoot) an env of its own whose
// HYPERDRIVE_JOB and HYPERDRIVE_APP are pool bindings, or doubles over a pool binding that count the reads of its
// connection string.
//
// One database holds one world: the walking skeleton's (T-1148's rows for Sam, who holds no role and no phone row), with
// K-05's commit-s1-01-sam.json committed through db/repo's commitTurn, and the seed's own commits of the same request
// beside it, each turn pinned to bundle v2 (T-1477), whose registry row the seed writes beside the rig's bundle v0: Sam's
// S1-02 rows are read by the sign-up line as the owner, so finalize opens their first text with signUpOpener, S1-02's own
// words, which bundle v2 carries and bundle v0 does not (K-01 README default 19; T-1511, T-1512; DL-1033). So each K-05
// fixture named below is answered in its shape, and where this world differs from the fixture's given the difference is
// stated at the comparison (`rowReadHere`, the facts): the bundle id, Sam's stored language, his role at the barbershop
// and his phone row.
//
//   - Each input by direct call: readOutboxRow as read-outbox-row-s1-02-no-kinds.json (businessSensitive null), then, once
//     K-23's seed-company-two-kinds.json is whole, as read-outbox-row-s1-02-not-sensitive.json (false), and notFound as
//     read-outbox-row-other-business.json; readFixedLineFacts as fixed-line-facts-s1-02.json and
//     fixed-line-facts-other-business.json; writePlan as write-plan.json and its repeat as write-plan-repeat.json;
//     unplannedRows as unplanned-after-crash.json; cancelClock as cancel-clock.json; the scope's transaction under one
//     business sees that business's rows only, as rosie_worker_app. A transient answer goes back as K-05 gives it (shown
//     on a stand-in for the handle whose client has lost its connection: the one case here with no database).
//   - Through a root composed for staging with the three inputs bound and every other input on its double: the JOIN's
//     turn as hops 9 and 10 run it, the gate on its double first, then K-05's unplannedRows, compose input and finalize on
//     PostgreSQL, the plan and the final parts read back from the row; the turn's rows through root.turn.rows; and the
//     Worker's own root.
//   - Each side's login: every scope on the Tool API's side, every row and plan call on the runtime side, opened equal to
//     ended. Two rows composed and two finalized side by side, each holding its Tool API client while its runtime-side
//     calls run, finish under the cap.
//   - HYPERDRIVE_APP not bound, then HYPERDRIVE_JOB not bound: each input that needs it is null, and its port fails closed
//     with nothing read or written. The two bindings crossed: the guard's refusal. Production: no binding read.
//   - The scope's start through a root (T-1410): once the guard has passed, the scope's client lost under it (ended first:
//     postgres.js's CONNECTION_ENDED) makes compose input and finalize each answer K-09's transient, their handlers never
//     run and nothing read or written; a session refused at its start (3D000, 42501, 55000, as postgres.js rejects the
//     begin with PostgreSQL's refusal naming this file's database) is thrown scrubbed under the call's own K-09 name,
//     never transient and never under withBusiness.
//   - No line written while this file runs holds a word of a plan or of the inbound text, a number, the chat id, or a
//     binding's string, host or database.
// The test's own clients go through T-1254's handle (its quiet socket), so none leaves a rejection behind (T-1403).
// Test values only (rule 9): the master's sample cast, the fixtures' ids and words, and tp-01's fictional number.
import joinComposeInput from "@rosie/ai/recordings/composer-inputs/join-s1-02.json";
import joinRunContext from "@rosie/ai/recordings/contexts/join-s1-01.json";
import cancelClockJson from "@rosie/contracts/data-access/fixtures/cancel-clock.json";
import fixedLineFactsOtherBusiness from "@rosie/contracts/data-access/fixtures/fixed-line-facts-other-business.json";
import fixedLineFactsS102 from "@rosie/contracts/data-access/fixtures/fixed-line-facts-s1-02.json";
import readOutboxRowOtherBusiness from "@rosie/contracts/data-access/fixtures/read-outbox-row-other-business.json";
import readOutboxRowNoKinds from "@rosie/contracts/data-access/fixtures/read-outbox-row-s1-02-no-kinds.json";
import readOutboxRowNotSensitive from "@rosie/contracts/data-access/fixtures/read-outbox-row-s1-02-not-sensitive.json";
import unplannedAfterCrash from "@rosie/contracts/data-access/fixtures/unplanned-after-crash.json";
import writePlanRepeat from "@rosie/contracts/data-access/fixtures/write-plan-repeat.json";
import writePlanJson from "@rosie/contracts/data-access/fixtures/write-plan.json";
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import checkPass from "@rosie/contracts/message-plan/fixtures/check-pass.json";
import planS102 from "@rosie/contracts/message-plan/fixtures/plan-s1-02.json";
import composeInputS102 from "@rosie/contracts/tool-api/fixtures/compose-input-s1-02-v1.6.json";
import finalizePass from "@rosie/contracts/tool-api/fixtures/finalize-pass.json";
import { readActiveBundle } from "@rosie/db/repo/bundles";
import { DataAccessDatabaseError } from "@rosie/db/repo/clocks";
import type { Sql } from "@rosie/db/repo/scope";
import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { env as poolEnv, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { QUIET_MS, turnIdOf, type HandleActor } from "../../actor";
import { actorNameOf } from "../../gateway";
import { fixtureBundle } from "../../safety/test-support";
import { openTrace, type Hop, type Span, type TraceContext } from "../../trace";
import { leaks, spansOfLogLines, spansOfTrace } from "../../trace/hop-check";
import { flush, SAM } from "../../turn/test-support";
import { NotJoinedError } from "../closed";
import type { PortName } from "../ports";
import { NoDatabaseError, type BundleSafetyLines, type ComposeReads } from "../real";
import { composeRoot, workerRoot, type HandleActors, type Root } from "../root";
import { SKELETON_FLAG } from "../skeleton";
import {
  BUNDLE_V0,
  BUNDLE_V2,
  bundleV2FixedLine,
  fakeFlags,
  SAM_CHAT,
  skeletonFakes,
  TEST_OWNER_1,
  TEST_OWNER_1_BUSINESS_NAME,
  testClock,
  watchGate,
  type LinqInboundEvent,
  type SignedWebhook,
  type SkeletonFakes,
  type WatchedFinalizeCall,
} from "../test-support";
import {
  CONNECTIONS_PER_CLIENT,
  DB_SIDES,
  DbClosedError,
  DbGuardRefusal,
  dbHandle,
  guardChecks,
  type DbSide,
} from "./db";
import { stagingDb, type StagingDb, type StagingEnv } from "./part";
import { NO_ROW_INPUTS, ROW_CALLS, stagingRowCalls, type RowInputs } from "./tool-api-rows";
import {
  BARBERSHOP,
  BARBERSHOP_KINDS,
  BUSINESSES,
  HOME_SERVICES,
  SEEDED_BUNDLE,
  TURNS,
  writeBarbershopKinds,
  YOGA_STUDIO,
  type SeededTurn,
} from "./tool-api-rows.seed";

/** This file's key in the rig's list (infra/test-rig/files.mjs). */
const KEY = "TOOL_API_ROWS";
const JOB = `HYPERDRIVE_JOB_${KEY}`;
const APP = `HYPERDRIVE_APP_${KEY}`;
/** The pool's own pair: its database, rosie_rig_none, is never made, so a connect through either fails. */
const POOL_JOB = "HYPERDRIVE_JOB";
const POOL_APP = "HYPERDRIVE_APP";
/** The connections a Worker may hold open at once (./db.ts CONNECTIONS_PER_CLIENT's cap). */
const WORKER_CONNECTIONS = 6;

/** A run through the Workers runtime's own steps and PostgreSQL: a resource guard above the project's default. */
const TEST_MS = 60_000;
/** How long a step of the actor's lent work may take before a wait gives up. */
const WAIT_MS = 30_000;

type Json = Record<string, unknown>;
type Namespace = DurableObjectNamespace<HandleActor>;

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

afterEach(async () => {
  vi.restoreAllMocks();
  // The JOIN's turn runs in a HandleActor: its storage is cleared after each test, as the hops' tests clear it.
  await reset();
});

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A written line as the JSON it is; a line that is none fails the test. */
function parsed(line: string): Json {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) throw new Error("a log line is not a JSON object");
  return value;
}

/** The running test's lines that are JSON objects with this msg. */
const linesNamed = (msg: string): Json[] =>
  lines.flatMap((line) => {
    if (!line.startsWith("{")) return [];
    const value = parsed(line);
    return value.msg === msg ? [value] : [];
  });

// ---- envs and doubles ------------------------------------------------------------------------------------------------

interface TestEnv {
  readonly env: StagingEnv;
  /** Every key read from the env, in order. */
  readonly keys: string[];
}

/** An env of the test's own: staging's vars (unless the fields say otherwise) and the fields, each key read recorded. */
function envOf(fields: Readonly<Record<string, unknown>>): TestEnv {
  const keys: string[] = [];
  const target: Record<string, unknown> = {
    ENVIRONMENT: "staging",
    BASE_PATH: "/test",
    DB_SCHEMA: "",
    GIT_SHA: "test-sha",
    ...fields,
  };
  const proxied = new Proxy(target, {
    get(object, key, receiver): unknown {
      if (typeof key === "string") keys.push(key);
      return Reflect.get(object, key, receiver);
    },
  });
  return { env: proxied as unknown as StagingEnv, keys };
}

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

interface Built extends TestEnv {
  /** The handle the inputs were built over, its timing lines kept in `written`. */
  readonly db: StagingDb;
  readonly written: Json[];
  readonly inputs: RowInputs;
}

/** The handle over an env, each of its timing lines kept. */
function handleOver(env: StagingEnv, written: Json[]): StagingDb {
  return stagingDb(env, {
    write: (line) => {
      everyLine.push(line);
      written.push(parsed(line));
    },
  });
}

/** The binding built over an env of the test's own, on a handle whose timing lines are kept. */
function built(fields: Readonly<Record<string, unknown>>): Built {
  const { env, keys } = envOf(fields);
  const written: Json[] = [];
  const db = handleOver(env, written);
  return { env, keys, db, written, inputs: stagingRowCalls({ env, db }) };
}

interface OnPair extends Built {
  readonly job: Counted;
  readonly app: Counted;
  readonly compose: ComposeReads;
  readonly finalize: NonNullable<RowInputs["finalizeData"]>;
  readonly plan: NonNullable<RowInputs["planCalls"]>;
}

/** The binding on this file's pair, each binding a counting double, every input bound. */
function onPair(): OnPair {
  const job = counted(poolBinding(JOB));
  const app = counted(poolBinding(APP));
  const made = built({ HYPERDRIVE_JOB: job.binding, HYPERDRIVE_APP: app.binding });
  const { composeReads, finalizeData, planCalls } = made.inputs;
  if (composeReads === null || finalizeData === null || planCalls === null) {
    throw new Error("an input is null on this file's pair");
  }
  return { ...made, job, app, compose: composeReads, finalize: finalizeData, plan: planCalls };
}

/** One timing line as [call, side, binding, login]. */
type CallOn = readonly [unknown, unknown, unknown, unknown];

/** A call on the Tool API's side: a client from HYPERDRIVE_APP, as rosie_worker_app. */
const onApp = (call: string): CallOn => [call, "toolApi", DB_SIDES.toolApi.binding, DB_SIDES.toolApi.login];
/** A call on the runtime side: a client from HYPERDRIVE_JOB, as rosie_worker_job. */
const onJob = (call: string): CallOn => [call, "runtime", DB_SIDES.runtime.binding, DB_SIDES.runtime.login];

/** Each call a handle timed, in order: the call, its side, its binding and the login the guard read. */
function callsOf(written: readonly Json[]): CallOn[] {
  for (const line of written) {
    // These seams carry no trace id: each line is on no trace, and holds labels and numbers only.
    expect(line).toMatchObject({ level: "info", msg: "dbCall", trace_id: null, environment: "staging" });
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

const VERSIONED = [
  "businesses",
  "persons",
  "turns",
  "open_questions",
  "clock_rows",
  "outbox_rows",
  "companies",
  "company_kinds",
] as const;
const WRITTEN_ONCE = ["handles", "event_log", "openers_sent", "outbox_parts"] as const;

/**
 * Every table a call here could write, as the runtime side reads it with no scope: its row count, and a versioned one's
 * sum of versions. Equal before and after means nothing was written.
 */
function snapshot(): Promise<Record<string, string>> {
  return own.runtime("snapshot", async (sql) => {
    const out: Record<string, string> = {};
    for (const table of VERSIONED) {
      const [row] = await sql<{ n: number; v: number }[]>`
        select count(*)::int as n, coalesce(sum(version), 0)::int as v from ${sql(table)}
      `;
      out[table] = `${String(row?.n)} rows, versions ${String(row?.v)}`;
    }
    for (const table of WRITTEN_ONCE) {
      const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
      out[table] = `${String(row?.n)} rows`;
    }
    return out;
  });
}

interface StoredRow {
  readonly turn_id: string;
  readonly state: string;
  readonly version: number;
  readonly plan: unknown;
  readonly final_parts: unknown;
}

/** One outbox row as PostgreSQL holds it, read on the runtime side; null when there is none. */
function storedRow(id: string): Promise<StoredRow | null> {
  return own.runtime("storedRow", async (sql) => {
    const [row] = await sql<StoredRow[]>`
      select turn_id, state, version, plan, final_parts from outbox_rows where id = ${id}
    `;
    return row ?? null;
  });
}

/** The kinds of work a business holds, as the runtime side reads them. */
function kindsOf(businessId: string): Promise<string[]> {
  return own.runtime("kindsOf", async (sql) => {
    const rows = await sql<{ kind_id: string }[]>`
      select kind_id from company_kinds where business_id = ${businessId} order by kind_id
    `;
    return rows.map((row) => row.kind_id);
  });
}

/** K-23's fixture made whole: the barbershop's own company and its barber kind, written once (./tool-api-rows.seed.ts). */
const withBarbershopKinds = (): Promise<void> => own.runtime("writeBarbershopKinds", writeBarbershopKinds);

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

/** The parts of a binding's string no text may hold: the string, its host and its database. */
function placeOf(binding: { readonly connectionString: string }): string[] {
  const url = new URL(binding.connectionString);
  return [binding.connectionString, url.host, decodeURIComponent(url.pathname.slice(1))];
}

/** Every text holds none of the binding's string, host, user, password or database. */
function expectNothingOf(binding: { readonly connectionString: string }, texts: readonly string[]): void {
  const url = new URL(binding.connectionString);
  const parts = [
    ...placeOf(binding),
    url.hostname,
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
  ].filter((part) => part !== "");
  expect(parts.length).toBeGreaterThanOrEqual(5);
  for (const text of texts) {
    for (const part of parts) {
      expect(holds(text, part), "a text holds a part of the binding's string").toBe(false);
    }
  }
}

// ---- the fixtures, as this file's calls take them --------------------------------------------------------------------

/** K-03's plan-s1-02.json: recording 4's answer, the plan finalize-pass.json hands finalize. */
const PLAN_S1_02 = planS102 as unknown as {
  readonly lines: readonly { readonly text: string }[];
  readonly question: { readonly text: string };
};

/** K-03 check-pass.json's checks: the seven message checks, in K-03's order, each passed. */
const ALL_PASSED = checkPass.checks;

/**
 * Bundle v2's sign-up opener, S1-02's own first words (K-01 README default 19): Sam holds no role, so his S1-02 rows are
 * read by the sign-up line as the owner, and their first text opens with it, naming no business.
 */
const OPENER = bundleV2FixedLine("signUpOpener");
/** Q-30's lines as bundle v2 writes them: the STOP, HELP and rates line, then the privacy link. */
const OPT_OUT_LINE = bundleV2FixedLine("optOutLine");
const PRIVACY_LINK = bundleV2FixedLine("privacyLink");
/** The fixed lines of Rosie's first sign-up text to the owner, in the order finalize adds them (default 19). */
const FIRST_TEXT_LINES = ["signUpOpener", "optOutLine", "privacyLink"];

/** The words plan-s1-02.json plans, a line each. */
const PLANNED_WORDS = [...PLAN_S1_02.lines.map((line) => line.text), PLAN_S1_02.question.text].join("\n");

/**
 * The final parts of Rosie's first text to Sam on `row`: signUpOpener before the plan's words, then Q-30's lines, the
 * privacy link alone on the last line (T-1148's Sam holds no phone row, so the STOP, HELP and rates line was never
 * delivered and rides too).
 */
function firstTextParts(row: string): Json {
  return {
    row,
    channel: "imessage",
    sends: [
      {
        kind: "words",
        text: [`${OPENER} ${PLANNED_WORDS}`, OPT_OUT_LINE, PRIVACY_LINK].join("\n"),
        calendarFile: "none",
        options: [],
        link: null,
      },
    ],
    fixedLines: FIRST_TEXT_LINES,
    slotValues: [],
    threadReplyTo: null,
  };
}

/**
 * The final parts of a later text to Sam about the barbershop on `row`, once the JOIN's writePlan wrote the opener mark
 * (K-05 v1.21 defaults 200 to 204; T-1513): the plan's words with no opener before them and no privacy link after, and
 * the one line still owed, the STOP, HELP and rates line, which no delivery receipt has marked (Sam holds no phone row).
 */
function laterTextParts(row: string): Json {
  return {
    row,
    channel: "imessage",
    sends: [
      {
        kind: "words",
        text: [PLANNED_WORDS, OPT_OUT_LINE].join("\n"),
        calendarFile: "none",
        options: [],
        link: null,
      },
    ],
    fixedLines: ["optOutLine"],
    slotValues: [],
    threadReplyTo: null,
  };
}

/** K-04's opener mark for Sam at the barbershop, as the runtime side reads it: the row it names, or null for none. */
function openerMarkRow(): Promise<string | null> {
  return own.runtime("openerMarkRow", async (sql) => {
    const rows = await sql<{ outbox_row_id: string }[]>`
      select outbox_row_id from openers_sent
      where handle_id = ${TEST_OWNER_1.handleId} and business_id = ${BARBERSHOP}
    `;
    if (rows.length > 1) throw new Error("openers_sent holds more than one mark for a handle and business");
    return rows[0]?.outbox_row_id ?? null;
  });
}

/** finalize-pass.json's plan, on `row`. */
const planOn = (row: string): Json => ({ ...finalizePass.request.plan, row });

/** write-plan.json's request (its plan and final parts), on `row`. */
function writePlanOn(row: string): Json {
  const { request } = writePlanJson;
  return {
    outboxRowId: row,
    expectVersion: request.expectVersion,
    plan: { ...request.plan, row },
    finalParts: { ...request.finalParts, row },
  };
}

/** An unplanned row as unplanned-after-crash.json lists one: at its first version, to Sam's handle, on iMessage. */
function unplanned(row: string): Json {
  const [listed] = unplannedAfterCrash.outcome.rows;
  if (listed === undefined) throw new Error("unplanned-after-crash.json lists a row");
  return { ...listed, outboxRowId: row, commitSeq: expect.any(Number) as number };
}

/** An instant in UTC ending in Z (formats.v1 utc): the database's own now, where a fixture's is its given clock. */
const UTC_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$/u;

/**
 * A K-05 row-read fixture's outcome as this database answers it. The same row, question, clock row, texts, business head
 * and line; what differs is this world's, never the read's: the turn is pinned to bundle v2 as the seed registers it
 * (the fixture's registry row is K-04's stand-in), and Sam is T-1148's (no language stored, no role at the barbershop, no
 * phone row), where the fixture's given loads K-04's seed-person-roles.json and seed-phone-chat-open.json.
 */
function rowReadHere(outcome: { readonly row: object; readonly recipient: object }): Json {
  return {
    ...outcome,
    readAt: expect.stringMatching(UTC_INSTANT) as string,
    row: { ...outcome.row, bundleId: BUNDLE_V2 },
    recipient: { ...outcome.recipient, storedLanguage: null, roles: [], phone: null },
  };
}

// ---- a root composed for staging ----------------------------------------------------------------------------------

/** Sam's ids as K-04 names them (the safety read's calls). */
const SAM_IDS = {
  handleId: SAM.party.handleId,
  businessId: SAM.party.businessId,
  personId: SAM.party.personId,
  bookingId: null,
};

/** The bundle's safety lines over K-01's fixture bundle, with a pin check that lets every bundle through. */
function bundleLines(): BundleSafetyLines {
  const bundle = fixtureBundle();
  return {
    fixedLine: (id) => bundle.fixedLine(id),
    outcomeLine: (outcome) => bundle.outcomeLine(outcome),
    dangerWords: () => bundle.dangerWords(),
    checkPin: () => Promise.resolve(),
  };
}

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

/** The HandleActor namespace as the root takes it (exports.HandleActor in the pool). */
function handleActors(): HandleActors<DurableObjectId> {
  const ns = namespace();
  return { idFromName: (name) => ns.idFromName(name), get: (id) => ns.get(id) };
}

/**
 * The root for staging with the three inputs this card binds handed in, and every other input on its double (as
 * ../state-reads.worker.test.ts composes it): the state reads' four on doubles of their own, the skeleton flag on.
 */
function stagingRoot(
  fakes: SkeletonFakes,
  inputs: RowInputs,
  actors: HandleActors<DurableObjectId> | null = null,
): Root {
  return composeRoot({
    environment: "staging",
    actors,
    vars: { ENVIRONMENT: "staging", GIT_SHA: "test-sha" },
    clock: fakes.clock,
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
    composers: fakes.composer.composers,
    outboxCalls: fakes.dispatch.outbox,
    sendStateCall: fakes.dispatch.sendState,
    linqSendCall: fakes.linq.call,
    retryQueue: fakes.retryQueue,
    armingCalls: fakes.arming.calls,
    bundleSafety: bundleLines(),
    handleDirectory: { idsOf: () => Promise.resolve(SAM_IDS) },
    stoppedFlags: () => Promise.resolve(false),
    turnDirectory: { partyOf: () => Promise.resolve(SAM.party) },
    flags: fakeFlags([SKELETON_FLAG]),
    composeReads: inputs.composeReads,
    finalizeData: inputs.finalizeData,
    planCalls: inputs.planCalls,
  });
}

/** A call's own trace under bundle v2, the seeded turns' bundle, set to its turn, with the spans it wrote. */
function traceFor(turnId: string): { trace: TraceContext; spans: Span[] } {
  const spans: Span[] = [];
  const trace = openTrace({
    openedBy: "textWebhook",
    bundleId: BUNDLE_V2,
    sink: (span) => spans.push(span),
  });
  trace.setTurn(turnId);
  return { trace, spans };
}

/** The turn's caller, as K-09's two fixtures name it, under the trace the call runs in. */
const callerOf = (turn: SeededTurn, trace: TraceContext, businessId: string = BARBERSHOP): Json => ({
  ...composeInputS102.request.caller,
  turnId: turn.turnId,
  requestId: turn.turnId,
  businessId,
  traceId: trace.traceId,
});

/** K-09 composeInput for a seeded turn's row, through the root's compose-input port, on a trace of its own. */
function composeRow(root: Root, turn: SeededTurn): Promise<unknown> {
  const { trace } = traceFor(turn.turnId);
  const request = { caller: callerOf(turn, trace), outboxRowId: turn.row };
  return root.ports.composeInput.composeInput(request as never, trace);
}

/** K-09 finalizeMessage of finalize-pass.json's plan for a seeded turn's row, through the root's finalize port. */
function finalizeRow(root: Root, turn: SeededTurn): Promise<unknown> {
  const { trace } = traceFor(turn.turnId);
  const request = {
    ...finalizePass.request,
    caller: callerOf(turn, trace),
    outboxRowId: turn.row,
    plan: planOn(turn.row),
  };
  return root.ports.finalize.finalizeMessage(request as never, trace);
}

/** K-09 v1.6's compose-input-s1-02-v1.6.json's input, for a seeded turn's row: its row and turn, and the inbound text. */
const composedFor = (turn: SeededTurn, inbound: unknown): Json => ({
  result: "compose",
  input: { ...composeInputS102.outcome.input, row: turn.row, turn: turn.turnId, inbound },
});

// ---- this file's database --------------------------------------------------------------------------------------------

describe("this file's database: the walking skeleton's rows, K-05's commit-s1-01-sam and the seed's own turns", () => {
  it("the rig made this file's database with bundle v0 active, and its seed wrote the business heads, bundle v2's registry row (not active) and committed each turn under bundle v2, the JOIN's under the id the lease hashes", async () => {
    expect(DATABASE).toMatch(/^rosie_rig_[0-9a-f]{8}_tool_api_rows$/u);
    // The JOIN's turn id is the lease's hash of its event id, its row K-09 v1.5 default 131's, as recording 4 names both.
    expect(TURNS.join.turnId).toBe(await turnIdOf([TURNS.join.eventId]));
    expect(TURNS.join.eventId).toBe(joinRunContext.texts[0]?.eventId);
    expect(TURNS.join.row).toBe(joinComposeInput.row);
    expect(TURNS.s101.row).toBe(readOutboxRowNoKinds.request.outboxRowId);
    expect(BARBERSHOP).toBe(TEST_OWNER_1.businessId);
    // The seed pins its turns to bundle v2 as bundles/v2 publishes it: the bundle the test's bundle double holds too.
    expect(SEEDED_BUNDLE).toEqual(BUNDLE_V2);

    const active = await own.runtime("readActiveBundle", (sql) => readActiveBundle(sql));
    expect(active).toMatchObject({ result: "active", bundleId: BUNDLE_V0 });
    const stored = await own.runtime("seeded", async (sql) => ({
      businesses: (await sql<{ id: string }[]>`select id from businesses order by id`).map((row) => row.id),
      bundles: await sql<{ hash: string; build: number; active: boolean }[]>`
        select hash, build, active from bundles order by active desc, hash
      `,
      turns: await sql<{ id: string; state: string; hash: string; build: number }[]>`
        select id, state, bundle_hash as hash, bundle_build as build from turns order by id
      `,
      rows: (await sql<{ id: string }[]>`select id from outbox_rows where plan is null order by id`).map(
        (row) => row.id,
      ),
    }));
    expect(stored.businesses).toEqual(BUSINESSES);
    expect(stored.businesses).toEqual(expect.arrayContaining([BARBERSHOP, YOGA_STUDIO, HOME_SERVICES]));
    expect(stored.bundles).toEqual([
      { ...BUNDLE_V0, active: true },
      { ...BUNDLE_V2, active: false },
    ]);
    expect(stored.turns).toEqual(
      Object.values(TURNS)
        .map((turn) => ({ id: turn.turnId, state: "committed", ...BUNDLE_V2 }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
    expect(stored.rows).toEqual(expect.arrayContaining(Object.values(TURNS).map((turn) => turn.row)));
  });
});

// ---- built ---------------------------------------------------------------------------------------------------------

describe("built on staging with both bindings: the three inputs, and nothing read but the environment and the bindings' presence", () => {
  it("reads ENVIRONMENT, then each binding's presence, once each, and no connection string; each input holds its calls and nothing else", () => {
    const { inputs, keys, job, app, written, db } = onPair();

    expect(keys).toEqual(["ENVIRONMENT", "HYPERDRIVE_JOB", "HYPERDRIVE_APP"]);
    expect([job.reads.n, app.reads.n]).toEqual([0, 0]);
    expect(Object.keys(inputs).sort()).toEqual(["composeReads", "finalizeData", "planCalls"]);
    expect(Object.keys(inputs.composeReads ?? {}).sort()).toEqual(["readOutboxRow", "scope"]);
    expect(Object.keys(inputs.finalizeData ?? {}).sort()).toEqual([
      "cancelClock",
      "readFixedLineFacts",
      "readOutboxRow",
      "scope",
      "writePlan",
    ]);
    expect(Object.keys(inputs.planCalls ?? {}).sort()).toEqual(["unplannedRows", "writePlan"]);
    // No call was made to build them.
    expect(written).toEqual([]);
    expect(db.counts()).toMatchObject({ opened: 0, ended: 0 });
  });
});

// ---- each input by direct call -------------------------------------------------------------------------------------

describe("each input by direct call, its answers shaped as the K-05 fixtures", () => {
  it("readOutboxRow: read-outbox-row-s1-02-no-kinds.json while the barbershop holds no kind of work (businessSensitive null), then read-outbox-row-s1-02-not-sensitive.json once K-23's fixture is whole (false); read-outbox-row-other-business.json's notFound; each read one runtime-side client", async () => {
    const { compose, finalize, written, db, job, app } = onPair();
    // Another business holds kinds of work, one with a switch on; the barbershop holds none yet.
    expect(await kindsOf(HOME_SERVICES)).toEqual(["electrician", "plumber"]);
    expect(
      await kindsOf(BARBERSHOP),
      "this test reads the barbershop before its kinds are written: run the file whole",
    ).toEqual([]);

    const noKinds = await compose.readOutboxRow(structuredClone(readOutboxRowNoKinds.request));
    expect(noKinds).toEqual(rowReadHere(readOutboxRowNoKinds.outcome));
    expect(noKinds).toMatchObject({ businessSensitive: null });

    // K-23's seed-company-two-kinds.json made whole: the barbershop's own company and its barber kind, no switch on.
    expect(BARBERSHOP_KINDS.map((row) => row.table)).toEqual(["companies", "company_kinds"]);
    await withBarbershopKinds();
    expect(await kindsOf(BARBERSHOP)).toEqual(["barber"]);

    // The same read through each input that holds it: compose input's and finalize's.
    for (const read of [compose.readOutboxRow, finalize.readOutboxRow]) {
      const notSensitive = await read(structuredClone(readOutboxRowNotSensitive.request));
      expect(notSensitive).toEqual(rowReadHere(readOutboxRowNotSensitive.outcome));
      expect(notSensitive).toMatchObject({ businessSensitive: false });
    }

    // Under the yoga studio's scope: the fixture's own request, and Sam's row, the barbershop's, which the scope hides.
    expect(await compose.readOutboxRow(structuredClone(readOutboxRowOtherBusiness.request))).toEqual(
      readOutboxRowOtherBusiness.outcome,
    );
    expect(await compose.readOutboxRow({ outboxRowId: TURNS.s101.row, businessId: YOGA_STUDIO })).toEqual({
      ...readOutboxRowOtherBusiness.outcome,
      rowId: TURNS.s101.row,
    });
    expect(readOutboxRowOtherBusiness.request.businessId).toBe(YOGA_STUDIO);

    // Each read reached PostgreSQL on a runtime-side client of its own, as rosie_worker_job; none on the Tool API's side.
    expect(callsOf(written)).toEqual(Array.from({ length: 5 }, () => onJob(ROW_CALLS.readOutboxRow)));
    expect(db.counts()).toMatchObject({ opened: 5, ended: 5, connectionsOpen: 0, connectionsPeak: 1 });
    expect([job.reads.n, app.reads.n]).toEqual([5, 0]);
  });

  it("readFixedLineFacts: fixed-line-facts-s1-02.json (Rosie's first text to Sam about the barbershop) and fixed-line-facts-other-business.json's notFound", async () => {
    const { finalize, written, db, job, app } = onPair();

    // The fixture's facts, but for the STOP, HELP and rates line: T-1148's Sam holds no phone row, so it was never
    // delivered, where the fixture's given loads K-04's seed-phone-chat-open.json.
    expect(await finalize.readFixedLineFacts(structuredClone(fixedLineFactsS102.request))).toEqual({
      ...fixedLineFactsS102.outcome,
      readAt: expect.stringMatching(UTC_INSTANT) as string,
      optOutLineDeliveredAt: null,
    });
    expect(fixedLineFactsS102.outcome).toMatchObject({ textedAboutBusiness: false, openerRowId: null });
    expect(await finalize.readFixedLineFacts(structuredClone(fixedLineFactsOtherBusiness.request))).toEqual(
      fixedLineFactsOtherBusiness.outcome,
    );
    expect(
      await finalize.readFixedLineFacts({ outboxRowId: TURNS.s101.row, businessId: YOGA_STUDIO }),
    ).toEqual({
      ...fixedLineFactsOtherBusiness.outcome,
      rowId: TURNS.s101.row,
    });

    expect(callsOf(written)).toEqual(Array.from({ length: 3 }, () => onJob(ROW_CALLS.readFixedLineFacts)));
    expect(db.counts()).toMatchObject({ opened: 3, ended: 3, connectionsOpen: 0 });
    expect([job.reads.n, app.reads.n]).toEqual([3, 0]);
  });

  it("writePlan as write-plan.json, its repeat as write-plan-repeat.json (alreadyPlanned, through either input), and unplannedRows as unplanned-after-crash.json: only the row with no plan is listed", async () => {
    const { finalize, plan, written, db, job, app } = onPair();
    const turn = TURNS.plan;
    if (turn.second === null) throw new Error("the plan turn holds two rows");
    const request = writePlanOn(turn.row);

    expect(await plan.unplannedRows({ turnId: turn.turnId })).toEqual({
      result: "rows",
      rows: [unplanned(turn.row), unplanned(turn.second)],
    });
    // The plan and the final parts go into the row together.
    expect(await finalize.writePlan(request as never)).toEqual({
      ...writePlanJson.outcome,
      outboxRowId: turn.row,
    });
    expect(await storedRow(turn.row)).toEqual({
      turn_id: turn.turnId,
      state: "checked",
      version: writePlanJson.outcome.version,
      plan: request.plan,
      final_parts: request.finalParts,
    });
    // The same request again, a retry after a lost reply: the row keeps its plan, whichever input sends it.
    const written1 = await snapshot();
    expect(await plan.writePlan(request as never)).toEqual({
      ...writePlanRepeat.outcome,
      outboxRowId: turn.row,
    });
    expect(await finalize.writePlan(request as never)).toEqual({
      ...writePlanRepeat.outcome,
      outboxRowId: turn.row,
    });
    expect(await snapshot()).toEqual(written1);
    // After a crash past the commit, only the row with no plan is composed again.
    expect(await plan.unplannedRows({ turnId: turn.turnId })).toEqual({
      ...unplannedAfterCrash.outcome,
      rows: [unplanned(turn.second)],
    });
    expect(await plan.unplannedRows({ turnId: "turn-t1399-none" })).toEqual({ result: "rows", rows: [] });

    expect(callsOf(written)).toEqual([
      onJob(ROW_CALLS.unplannedRows),
      onJob(ROW_CALLS.writePlan),
      onJob(ROW_CALLS.writePlan),
      onJob(ROW_CALLS.writePlan),
      onJob(ROW_CALLS.unplannedRows),
      onJob(ROW_CALLS.unplannedRows),
    ]);
    expect(db.counts()).toMatchObject({ opened: 6, ended: 6, connectionsOpen: 0 });
    expect([job.reads.n, app.reads.n]).toEqual([6, 0]);
  });

  it("cancelClock as cancel-clock.json: the question's clock row cancelled at its next version and its question withdrawn, on the runtime side", async () => {
    const { finalize, written, db } = onPair();
    const turn = TURNS.cancel;
    const request = {
      ...cancelClockJson.request,
      clockRowId: turn.clock,
      withdrawQuestion: { ...cancelClockJson.request.withdrawQuestion, openQuestionId: turn.question },
    };

    expect(await finalize.cancelClock(request as never)).toEqual({
      ...cancelClockJson.outcome,
      clockRowId: turn.clock,
    });

    const stored = await own.runtime("cancelled", async (sql) => {
      const [clock] = await sql<{ state: string; version: number }[]>`
        select state, version from clock_rows where id = ${turn.clock}
      `;
      const [question] = await sql<{ status: string; version: number }[]>`
        select status, version from open_questions where id = ${turn.question}
      `;
      return { clock, question };
    });
    expect(stored).toEqual({
      clock: { state: "cancelled", version: cancelClockJson.outcome.version },
      question: { status: "withdrawn", version: 2 },
    });
    expect(callsOf(written)).toEqual([onJob(ROW_CALLS.cancelClock)]);
    expect(db.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0 });
  });

  it("the scope: one transaction on the Tool API's side, as rosie_worker_app, that sees its own business's rows only; a call naming no business is refused before its work runs; rosie_worker_app with no scope sees no row", async () => {
    await withBarbershopKinds();
    const { compose, finalize, written, db, job, app } = onPair();
    /** What a transaction of the scope sees: who it runs as, its scope, and the rows of four business-scoped tables. */
    const seenIn = async (repo: unknown) => {
      const tx = repo as Sql;
      const [who] = await tx<{ session_login: string; current_login: string; scope: string | null }[]>`
        select session_user::text as session_login, current_user::text as current_login,
               current_setting('rosie.business_id', true) as scope
      `;
      const businesses = await tx<{ id: string }[]>`select id from businesses order by id`;
      const kinds = await tx<{ kind_id: string }[]>`select kind_id from company_kinds order by kind_id`;
      const [rows] = await tx<{ n: number }[]>`select count(*)::int as n from outbox_rows`;
      const [questions] = await tx<{ n: number }[]>`select count(*)::int as n from open_questions`;
      return {
        who,
        businesses: businesses.map((row) => row.id),
        kinds: kinds.map((row) => row.kind_id),
        outboxRows: rows?.n,
        openQuestions: questions?.n,
      };
    };
    const login = DB_SIDES.toolApi.login;
    const seeded = { rows: Object.values(TURNS).length + 2, questions: Object.values(TURNS).length };

    // Under Lee's Barbershop: its own head, its own kind of work and its own rows.
    expect(await compose.scope.withBusiness(BARBERSHOP, seenIn)).toEqual({
      who: { session_login: login, current_login: login, scope: BARBERSHOP },
      businesses: [BARBERSHOP],
      kinds: ["barber"],
      outboxRows: seeded.rows,
      openQuestions: seeded.questions,
    });
    // Under Lee Home Services, through finalize's scope: its own head and kinds, and none of the barbershop's rows.
    expect(await finalize.scope.withBusiness(HOME_SERVICES, seenIn)).toEqual({
      who: { session_login: login, current_login: login, scope: HOME_SERVICES },
      businesses: [HOME_SERVICES],
      kinds: ["electrician", "plumber"],
      outboxRows: 0,
      openQuestions: 0,
    });
    // Under a business this database does not hold: nothing.
    expect(await compose.scope.withBusiness("biz-t1399-none", seenIn)).toMatchObject({
      businesses: [],
      kinds: [],
      outboxRows: 0,
      openQuestions: 0,
    });
    // What the work throws leaves as it is, and its transaction's client is ended.
    const failure = new Error("t1399: the work failed");
    expect(await rejectionOf(compose.scope.withBusiness(BARBERSHOP, () => Promise.reject(failure)))).toBe(
      failure,
    );
    // No business named: refused before the work runs, with no transaction opened.
    const work = vi.fn(seenIn);
    expect(await rejectionOf(finalize.scope.withBusiness("", work))).toBeInstanceOf(TypeError);
    expect(work).not.toHaveBeenCalled();

    expect(callsOf(written)).toEqual([
      onApp(ROW_CALLS.composeScope),
      onApp(ROW_CALLS.finalizeScope),
      onApp(ROW_CALLS.composeScope),
      onApp(ROW_CALLS.composeScope),
      onApp(ROW_CALLS.finalizeScope),
    ]);
    expect(db.counts()).toMatchObject({ opened: 5, ended: 5, connectionsOpen: 0, connectionsPeak: 1 });
    expect([job.reads.n, app.reads.n]).toEqual([0, 5]);

    // The login's own rights (rosie_app's only): with no scope it sees no business's row.
    const unscoped = await own.toolApi("unscoped", async (sql) => {
      const [businesses] = await sql<{ n: number }[]>`select count(*)::int as n from businesses`;
      const [rows] = await sql<{ n: number }[]>`select count(*)::int as n from outbox_rows`;
      return [businesses?.n, rows?.n];
    });
    expect(unscoped).toEqual([0, 0]);
  });

  it("a transient answer goes back as K-05 gives it: on a client whose connection is lost, each of the five calls answers transient through the binding, unchanged, the turn's rows get it as it is, and the scope's start throws db/repo's scrubbed error", async () => {
    // A stand-in for the handle and its client only (the binding is the code under test): every statement and every
    // transaction fails as postgres.js fails one on a connection that closed, its address on the error.
    const lost = (): Promise<never> =>
      Promise.reject(
        Object.assign(new Error("write CONNECTION_CLOSED db.t1399.invalid:5432"), {
          code: "CONNECTION_CLOSED",
          errno: "CONNECTION_CLOSED",
          address: "db.t1399.invalid",
          port: 5432,
        }),
      );
    const client = Object.assign(lost, { begin: lost }) as unknown as Sql;
    const reached: string[] = [];
    const db: StagingDb = {
      runtime: (call, fn) => {
        reached.push(`runtime:${call}`);
        return fn(client);
      },
      toolApi: (call, fn) => {
        reached.push(`toolApi:${call}`);
        return fn(client);
      },
      counts: () => ({
        opened: 0,
        ended: 0,
        connectionsOpen: 0,
        connectionsPeak: 0,
        quietReads: 0,
        quietWrites: 0,
      }),
    };
    const inputs = stagingRowCalls({ env: envOf({ HYPERDRIVE_JOB: {}, HYPERDRIVE_APP: {} }).env, db });
    const { composeReads, finalizeData, planCalls } = inputs;
    if (composeReads === null || finalizeData === null || planCalls === null) {
      throw new Error("an input is null with both bindings present");
    }
    const row = { outboxRowId: TURNS.s101.row, businessId: BARBERSHOP };
    const plan = writePlanOn(TURNS.s101.row);
    const cancel = { ...cancelClockJson.request, clockRowId: TURNS.s101.clock, withdrawQuestion: null };
    /** K-05's transient answer for a lost connection: nothing was written, the same request may be sent again. */
    const transient = { error: "transient", sqlstate: "08006" };

    expect(await composeReads.readOutboxRow(row)).toEqual(transient);
    expect(await finalizeData.readOutboxRow(row)).toEqual(transient);
    expect(await finalizeData.readFixedLineFacts(row)).toEqual(transient);
    expect(await finalizeData.writePlan(plan as never)).toEqual(transient);
    expect(await finalizeData.cancelClock(cancel)).toEqual(transient);
    expect(await planCalls.unplannedRows({ turnId: TURNS.s101.turnId })).toEqual(transient);
    expect(await planCalls.writePlan(plan as never)).toEqual(transient);
    // Through a root, the turn's rows get K-05's answer as it is, and check it themselves.
    const root = stagingRoot(skeletonFakes(), inputs);
    expect(await root.turn.rows.unplannedRows({ turnId: TURNS.s101.turnId })).toEqual(transient);
    expect(await root.turn.rows.writePlan(plan as never)).toEqual(transient);

    // The scope's start has no answer of its own to give: it throws db/repo's scrubbed error, the call's name and
    // the SQLSTATE alone, and the work never runs.
    const work = vi.fn(() => Promise.resolve("ran"));
    for (const scope of [composeReads.scope, finalizeData.scope]) {
      const thrown = await rejectionOf(scope.withBusiness(BARBERSHOP, work));
      expect(thrown).toBeInstanceOf(DataAccessDatabaseError);
      expect(thrown).toMatchObject({ call: "withBusiness", code: "08006", table: null, constraint: null });
      for (const text of textsOf(thrown)) expect(text).not.toContain("t1399.invalid");
    }
    expect(work).not.toHaveBeenCalled();

    // Each call went to its own side of the handle, under its own name.
    expect(reached).toEqual([
      `runtime:${ROW_CALLS.readOutboxRow}`,
      `runtime:${ROW_CALLS.readOutboxRow}`,
      `runtime:${ROW_CALLS.readFixedLineFacts}`,
      `runtime:${ROW_CALLS.writePlan}`,
      `runtime:${ROW_CALLS.cancelClock}`,
      `runtime:${ROW_CALLS.unplannedRows}`,
      `runtime:${ROW_CALLS.writePlan}`,
      `runtime:${ROW_CALLS.unplannedRows}`,
      `runtime:${ROW_CALLS.writePlan}`,
      `toolApi:${ROW_CALLS.composeScope}`,
      `toolApi:${ROW_CALLS.finalizeScope}`,
    ]);
  });
});

// ---- through a root composed for staging -----------------------------------------------------------------------------

const OWNER_ACTOR = actorNameOf(TEST_OWNER_1.handle);

/** The JOIN's one text, as ai/recordings' recording 2 names it. */
const [JOIN_TEXT] = joinRunContext.texts;

function stubOf(actorName: string): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(actorName));
}

/** Waits until the actor has read every text and handed on, and run, what its batch window and lease can. */
async function settle(actorName: string): Promise<void> {
  await stubOf(actorName).safetyIdle();
  await stubOf(actorName).batchIdle();
}

/** Waits until a committed turn's reply has ended and its lease is released (T-253). */
async function untilReplied(actorName: string, turnId: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const turn = (await stubOf(actorName).readTurns()).find((entry) => entry.turnId === turnId);
    if (turn?.state === "committed" && turn.leaseUntil === null) return;
    if (Date.now() - started > WAIT_MS) {
      throw new Error(`gave up waiting for the turn's reply to end (state ${turn?.state ?? "none"})`);
    }
    await flush(5);
  }
}

/** The JOIN as recording 2 names it: K-06 text-imessage.json's form from test owner 1, on Sam's chat (imessage). */
function joinAsRecorded(): LinqInboundEvent {
  if (JOIN_TEXT === undefined) throw new Error("recording 2's context holds its text");
  return {
    ...(structuredClone(textFixture) as Json),
    eventId: JOIN_TEXT.eventId,
    handle: { ...TEST_OWNER_1.handle },
    body: JOIN_TEXT.words,
    sentAt: JOIN_TEXT.sentAt.utc,
    chatId: SAM_CHAT,
    messageId: `linq-msg-demo-in-${JOIN_TEXT.eventId}`,
  } as unknown as LinqInboundEvent;
}

/** The webhook as Linq posts it to {BASE_PATH}/webhooks/linq: the three headers and the raw body. */
function webhookRequest(webhook: SignedWebhook): Request {
  return new Request("https://rosie.test/test/webhooks/linq", {
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

/** The one span of a hop in a trace. */
function onlySpan(spans: readonly Span[], hop: Hop): Span {
  const found = spans.filter((span) => span.hop === hop);
  expect(found.map((span) => span.hop)).toEqual([hop]);
  const [span] = found;
  if (span === undefined) throw new Error(`no ${hop} span`);
  return span;
}

/** A finalize answer the turn got, as K-09's response, or the test fails naming what came instead. */
function responseOf(call: WatchedFinalizeCall | undefined): Json {
  const answer = call?.answer;
  if (!isRecord(answer) || !("outcome" in answer)) {
    throw new Error(`finalize answered no response: ${JSON.stringify(answer ?? null)}`);
  }
  return answer;
}

/** The numbers and words no span or line may hold: tp-01's number in each form, the chat id, and each text's words. */
const SECRETS = [
  SAM_CHAT,
  "+15555550100",
  "15555550100",
  "5555550100",
  "JOIN",
  ...PLAN_S1_02.lines.map((line) => line.text),
  PLAN_S1_02.question.text,
  composeInputS102.outcome.input.masterText.text,
  ...composeInputS102.outcome.input.facts.map((fact) => fact.value),
  OPENER,
  OPT_OUT_LINE,
  PRIVACY_LINK,
  ...writePlanJson.request.plan.plan.lines.map((line) => line.text),
  ...writePlanJson.request.finalParts.sends.map((send) => send.text),
];

/** No text holds a word of a plan or of the inbound text, a number or the chat id, or a pool binding's place. */
function expectNoSecrets(texts: readonly string[]): void {
  const places = [JOB, APP, POOL_JOB, POOL_APP].flatMap((name) => placeOf(poolBinding(name)));
  for (const text of texts) {
    for (const secret of SECRETS) {
      expect(text, "a line holds a word, a number or the chat id").not.toContain(secret);
    }
    for (const place of places) expect(holds(text, place), "a line holds a binding's place").toBe(false);
  }
}

describe("through a root composed for staging: the three inputs on PostgreSQL, every other input on its double", () => {
  it(
    "the JOIN's turn under bundle v2, as hops 9 and 10 run it: the gate on its double first, then unplannedRows, compose input (compose-input-s1-02-v1.6.json's input for the JOIN's row) and finalize (finalize-pass.json's plan) on PostgreSQL; the plan and the final parts read back from the row, signUpOpener first and no business named; each scope on the Tool API's side and each row call on the runtime side, opened equal to ended",
    { timeout: TEST_MS },
    async () => {
      await withBarbershopKinds();
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const made = onPair();
      // Bundle v2 active on the double, so the JOIN's run pins the bundle the seed committed its row under (T-1512).
      const fakes = skeletonFakes(testClock(), { bundle: BUNDLE_V2 });
      const root = stagingRoot(fakes, made.inputs, handleActors());
      const turn = TURNS.join;
      expect(await storedRow(turn.row)).toMatchObject({ state: "planned", version: 1, plan: null });
      // No row here has carried an opener yet (write-plan.json's final parts hold no fixed line): no mark.
      expect(await openerMarkRow()).toBeNull();
      const restoreRoot = root.install();
      const watched = watchGate(root, fakes.face);
      try {
        const join = joinAsRecorded();
        const response = await root.linqWebhook(webhookRequest(await fakes.sign(join)));
        expect(response.status).toBe(200);
        const traceId = response.headers.get("x-trace-id");
        if (traceId === null) throw new Error("the gateway answered with no trace id");
        await settle(OWNER_ACTOR);
        await fakes.clock.advance(QUIET_MS);
        await runDurableObjectAlarm(stubOf(OWNER_ACTOR));
        const spans = (): Span[] => spansOfTrace(spansOfLogLines(lines), traceId);
        try {
          await untilReplied(OWNER_ACTOR, turn.turnId);
        } catch (error) {
          const seen = spans().map((span) => `${span.hop}:${span.outcome}:${span.error_code ?? ""}`);
          throw new Error(
            `${error instanceof Error ? error.message : "no reply"}; the trace shows ${seen.join(", ")}; misses ${fakes.composer.misses.join("; ")}`,
            { cause: error },
          );
        }
        await settle(OWNER_ACTOR);
        const trace = spans();

        // The gate ran on its double, under Lee's Barbershop, and its one commit went to the K-05 double under the id
        // the lease hashed: the row this turn composes is the one the seed committed under that id in PostgreSQL.
        expect(fakes.gate.scopes).toEqual([BARBERSHOP]);
        expect(fakes.turnRows.commits).toHaveLength(1);
        expect([...(fakes.turnRows.rows.get("outbox_rows")?.keys() ?? [])]).toEqual([turn.row]);
        // The doubles of compose input's and finalize's reads were never handed to this root.
        expect([fakes.compose.scopes, fakes.finalize.scopes, fakes.finalize.writes]).toEqual([[], [], []]);

        // Compose input from PostgreSQL: K-09 v1.6's compose-input-s1-02-v1.6.json's input for the JOIN's row, its
        // inbound text the words the gate port's face held (recording 4's input, which the composer double is keyed on).
        expect(fakes.composer.misses).toEqual([]);
        expect(fakes.composer.inputs).toEqual([joinComposeInput]);
        expect({ result: "compose", input: fakes.composer.inputs[0] }).toEqual(
          composedFor(turn, { text: JOIN_TEXT?.words, sentAt: JOIN_TEXT?.sentAt }),
        );
        expect(onlySpan(trace, "compose")).toMatchObject({
          outcome: "ok",
          turn_id: turn.turnId,
          bundle_id: BUNDLE_V2,
          business_id: BARBERSHOP,
          got: { row: turn.row, channel: "imessage", situation: "routine", facts: 4, inbound: true },
        });

        // Finalize: finalize-pass.json's plan in, on the JOIN's row at its first version; send, every message check
        // passed, and the first text's final parts.
        const [call, ...again] = watched.finalizeCalls;
        expect(again).toEqual([]);
        expect(call?.request).toMatchObject({
          caller: { kind: "turn", turnId: turn.turnId, businessId: BARBERSHOP, traceId },
          outboxRowId: turn.row,
          expectVersion: finalizePass.request.expectVersion,
          attempt: "composed",
        });
        expect(call?.request.plan).toEqual(planOn(turn.row));
        const answer = responseOf(call);
        expect(answer).toMatchObject({ outcome: "send", questionWithdrawn: false, teamPageId: null });
        expect(answer.checks).toMatchObject([{ row: turn.row, attempt: "composed", outcome: "send" }]);
        expect((answer.checks as { checks: unknown }[])[0]?.checks).toEqual(ALL_PASSED);
        expect(answer.finalParts).toEqual(firstTextParts(turn.row));
        expect(onlySpan(trace, "fillAndChecks")).toMatchObject({
          outcome: "ok",
          turn_id: turn.turnId,
          got: { row: turn.row, attempt: "composed", calls: 1 },
          decided: { outcome: "send", failed: [], fixedLines: FIRST_TEXT_LINES, sends: 1 },
          rows: [{ table: "outbox_rows", id: turn.row }],
        });

        // Read back from the row in PostgreSQL: the plan and the final parts, written together, the row checked at its
        // next version; signUpOpener first (S1-02's own words), the privacy link alone on the last line, and the
        // business's name nowhere: Sam has named no business yet (default 19).
        const stored = await storedRow(turn.row);
        expect(stored).toEqual({
          turn_id: turn.turnId,
          state: "checked",
          version: 2,
          plan: planOn(turn.row),
          final_parts: firstTextParts(turn.row),
        });
        const text = String(
          (stored?.final_parts as { sends: { text: string }[] } | undefined)?.sends[0]?.text,
        );
        const words = text.split("\n");
        expect(words[0]?.startsWith(`${OPENER} `)).toBe(true);
        expect(words.slice(-2)).toEqual([OPT_OUT_LINE, PRIVACY_LINK]);
        expect(text).not.toContain(TEST_OWNER_1_BUSINESS_NAME);
        // writePlan wrote K-04's opener mark with the plan (K-05 v1.21 default 200; T-1513): Rosie's first text to Sam
        // about the barbershop is this row.
        expect(await openerMarkRow()).toBe(turn.row);

        // Each side's login: the turn's rows listed and each row call on the runtime side, each scope on the Tool
        // API's, every client ended; a call held its Tool API client while its runtime-side call ran (2 at once).
        expect(callsOf(made.written)).toEqual([
          onJob(ROW_CALLS.unplannedRows),
          onApp(ROW_CALLS.composeScope),
          onJob(ROW_CALLS.readOutboxRow),
          onApp(ROW_CALLS.finalizeScope),
          onJob(ROW_CALLS.readOutboxRow),
          onJob(ROW_CALLS.readFixedLineFacts),
          onJob(ROW_CALLS.writePlan),
        ]);
        expect(made.db.counts()).toMatchObject({
          opened: 7,
          ended: 7,
          connectionsOpen: 0,
          connectionsPeak: 2 * CONNECTIONS_PER_CLIENT,
        });
        expect([made.job.reads.n, made.app.reads.n]).toEqual([5, 2]);

        // No span, and no line the turn wrote (its spans, finalize's note, each call's timing), holds a word of the
        // plan or of the inbound text, a number, the chat id or a binding's place; no model was called.
        expect(leaks(spansOfLogLines(lines), SECRETS)).toEqual([]);
        const kinds = new Set(lines.flatMap((line) => (line.startsWith("{") ? [parsed(line).msg] : [])));
        expect([...kinds]).toEqual(expect.arrayContaining(["span", "finalize_attempt"]));
        expectNoSecrets([...lines, ...made.written.map((line) => JSON.stringify(line))]);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        watched.restore();
        restoreRoot();
        vi.unstubAllGlobals();
      }
    },
  );

  it("the turn's rows list and write through root.turn.rows: each call reaches PostgreSQL on the runtime side, and the plan is read back from the row", async () => {
    const made = onPair();
    const fakes = skeletonFakes();
    const root = stagingRoot(fakes, made.inputs);
    const turn = TURNS.rows;
    if (turn.second === null) throw new Error("the rows turn holds two rows");
    const request = writePlanOn(turn.second);

    expect(await root.turn.rows.unplannedRows({ turnId: turn.turnId })).toEqual({
      result: "rows",
      rows: [unplanned(turn.row), unplanned(turn.second)],
    });
    expect(await root.turn.rows.writePlan(request as never)).toEqual({
      ...writePlanJson.outcome,
      outboxRowId: turn.second,
    });
    expect(await root.turn.rows.writePlan(request as never)).toEqual({
      ...writePlanRepeat.outcome,
      outboxRowId: turn.second,
    });
    expect(await root.turn.rows.unplannedRows({ turnId: turn.turnId })).toEqual({
      result: "rows",
      rows: [unplanned(turn.row)],
    });

    expect(await storedRow(turn.second)).toEqual({
      turn_id: turn.turnId,
      state: "checked",
      version: 2,
      plan: request.plan,
      final_parts: request.finalParts,
    });
    expect(callsOf(made.written)).toEqual([
      onJob(ROW_CALLS.unplannedRows),
      onJob(ROW_CALLS.writePlan),
      onJob(ROW_CALLS.writePlan),
      onJob(ROW_CALLS.unplannedRows),
    ]);
    expect(made.db.counts()).toMatchObject({ opened: 4, ended: 4, connectionsOpen: 0 });
    expect([made.job.reads.n, made.app.reads.n]).toEqual([4, 0]);
  });

  it("the Worker's own root (workerRoot) hands its ports the same inputs: on this file's pair the turn's rows are listed from PostgreSQL, the timing line on console.log", async () => {
    const job = counted(poolBinding(JOB));
    const app = counted(poolBinding(APP));
    const { env } = envOf({ HYPERDRIVE_JOB: job.binding, HYPERDRIVE_APP: app.binding });

    const root = workerRoot(env);
    expect([job.reads.n, app.reads.n]).toEqual([0, 0]);
    const listed = await root.turn.rows.unplannedRows({ turnId: TURNS.s101.turnId });

    expect(listed).toEqual({ result: "rows", rows: [unplanned(TURNS.s101.row)] });
    expect(callsOf(linesNamed("dbCall"))).toEqual([onJob(ROW_CALLS.unplannedRows)]);
    expect([job.reads.n, app.reads.n]).toEqual([1, 0]);
  });
});

// ---- side by side ----------------------------------------------------------------------------------------------------

/**
 * A handle whose runtime-side calls wait until `n` Tool API clients have passed their guard, so each of `n` calls side by
 * side holds its Tool API client while its runtime-side calls run. Only the order is held: every call is the handle's own.
 */
function sideBySide(db: StagingDb): { db: StagingDb; arm(n: number): void } {
  let waiting = 0;
  let release: () => void = () => undefined;
  let all: Promise<void> = Promise.resolve();
  return {
    arm(n) {
      waiting = n;
      all = new Promise((resolve) => {
        release = resolve;
      });
    },
    db: {
      toolApi<T>(call: string, fn: (sql: Sql) => Promise<T>, traceId?: string | null): Promise<T> {
        return db.toolApi(
          call,
          (sql) => {
            waiting -= 1;
            if (waiting === 0) release();
            return fn(sql);
          },
          traceId,
        );
      },
      async runtime<T>(call: string, fn: (sql: Sql) => Promise<T>, traceId?: string | null): Promise<T> {
        await all;
        return db.runtime(call, fn, traceId);
      },
      counts: () => db.counts(),
    },
  };
}

describe("two rows composed and two finalized side by side (critic_collisions N2, critic_size N6)", () => {
  it(
    "each holds its Tool API client while its runtime-side calls run: 4 connections at once, under the 6 a Worker may hold, and every call finishes, opened equal to ended",
    { timeout: TEST_MS },
    async () => {
      await withBarbershopKinds();
      const job = counted(poolBinding(JOB));
      const app = counted(poolBinding(APP));
      const { env } = envOf({ HYPERDRIVE_JOB: job.binding, HYPERDRIVE_APP: app.binding });
      const written: Json[] = [];
      const real = handleOver(env, written);
      const held = sideBySide(real);
      const root = stagingRoot(skeletonFakes(), stagingRowCalls({ env, db: held.db }));
      const turns = [TURNS.sideA, TURNS.sideB];
      // The JOIN's test above finalized Rosie's first text to Sam about the barbershop, and its writePlan wrote the
      // opener mark naming the JOIN's row, which stands checked (T-1513). Both rows here are later texts to the same
      // handle and business, so each reads "texted before" whichever is finalized first.
      expect(await openerMarkRow()).toBe(TURNS.join.row);
      expect(await storedRow(TURNS.join.row)).toMatchObject({ state: "checked" });

      // Two compose inputs at once: each runtime-side read starts only once both Tool API clients are open.
      held.arm(turns.length);
      const composed = await Promise.all(turns.map((turn) => composeRow(root, turn)));
      // No words were handed in for these turns (no gate ran), so each input holds no inbound text.
      expect(composed).toEqual(turns.map((turn) => composedFor(turn, null)));
      expect(real.counts()).toMatchObject({ opened: 4, ended: 4, connectionsOpen: 0, connectionsPeak: 4 });

      // Two finalizes at once, each making three runtime-side calls under its Tool API transaction. Neither text is
      // Rosie's first to Sam about the barbershop (the JOIN's mark): each carries the plan's words with no opener and
      // no privacy link, and the STOP, HELP and rates line alone, which no delivery receipt has marked (K-05 v1.21
      // defaults 200 to 204).
      held.arm(turns.length);
      const finalized = await Promise.all(turns.map((turn) => finalizeRow(root, turn)));
      expect(finalized).toMatchObject(turns.map(() => ({ outcome: "send", questionWithdrawn: false })));
      expect((finalized as { finalParts: unknown }[]).map((answer) => answer.finalParts)).toEqual(
        turns.map((turn) => laterTextParts(turn.row)),
      );
      for (const turn of turns) {
        const stored = await storedRow(turn.row);
        expect(stored).toEqual({
          turn_id: turn.turnId,
          state: "checked",
          version: 2,
          plan: planOn(turn.row),
          final_parts: laterTextParts(turn.row),
        });
        // The words as stored: the plan's own, then the STOP, HELP and rates line last; no opener, no privacy link.
        const text = String(
          (stored?.final_parts as { sends: { text: string }[] } | undefined)?.sends[0]?.text,
        );
        expect(text.split("\n")).toEqual([...PLANNED_WORDS.split("\n"), OPT_OUT_LINE]);
        expect([OPENER, PRIVACY_LINK].filter((line) => text.includes(line))).toEqual([]);
      }
      // The mark is written once: neither later row moved it.
      expect(await openerMarkRow()).toBe(TURNS.join.row);

      // All of it under the cap: 2 connections a call, 4 for two at once, never more.
      const counts = real.counts();
      expect(counts).toMatchObject({ opened: 12, ended: 12, connectionsOpen: 0, connectionsPeak: 4 });
      expect(counts.connectionsPeak).toBe(turns.length * 2 * CONNECTIONS_PER_CLIENT);
      expect(counts.connectionsPeak).toBeLessThanOrEqual(WORKER_CONNECTIONS);
      const calls = callsOf(written);
      expect(calls.filter(([, side]) => side === "toolApi").sort()).toEqual(
        [
          onApp(ROW_CALLS.composeScope),
          onApp(ROW_CALLS.composeScope),
          onApp(ROW_CALLS.finalizeScope),
          onApp(ROW_CALLS.finalizeScope),
        ].sort(),
      );
      expect(
        calls
          .filter(([, side]) => side === "runtime")
          .map(([call]) => call)
          .sort(),
      ).toEqual(
        [
          ...Array.from({ length: 4 }, () => ROW_CALLS.readOutboxRow),
          ROW_CALLS.readFixedLineFacts,
          ROW_CALLS.readFixedLineFacts,
          ROW_CALLS.writePlan,
          ROW_CALLS.writePlan,
        ].sort(),
      );
      expect(calls.filter(([, side]) => side === "runtime")).toEqual(
        calls.filter(([, side]) => side === "runtime").map(([call]) => onJob(String(call))),
      );
      expect([job.reads.n, app.reads.n]).toEqual([8, 4]);
    },
  );
});

// ---- unbound ---------------------------------------------------------------------------------------------------------

/** A row id no commit wrote: a plan for it is answered notFound, so a writePlan that reaches K-05 writes nothing. */
const NO_SUCH_ROW = "outbox-t1399-none";

/**
 * Each call of the three ports through a root, as the turn makes them, and how it ended. Where a call can reach K-05 it
 * writes nothing: compose input and unplannedRows only read, finalize is asked only where it cannot run, and the plan is
 * for a row no commit wrote.
 */
async function portOutcomes(root: Root): Promise<Record<string, string>> {
  const outcome = async (call: () => Promise<unknown>): Promise<string> => {
    try {
      const answer = await call();
      return `answered ${isRecord(answer) ? String(answer.result ?? answer.error) : "something"}`;
    } catch (error) {
      return error instanceof Error ? `threw ${error.name}: ${error.message}` : "threw a non-error";
    }
  };
  return {
    composeInput: await outcome(() => composeRow(root, TURNS.s101)),
    finalizeMessage: await outcome(() => finalizeRow(root, TURNS.s101)),
    unplannedRows: await outcome(() => root.turn.rows.unplannedRows({ turnId: TURNS.s101.turnId })),
    writePlan: await outcome(() => root.turn.rows.writePlan(writePlanOn(NO_SUCH_ROW) as never)),
  };
}

const closed = (call: string): string => `threw NoDatabaseError: ${new NoDatabaseError(call).message}`;

describe("unbound: an input whose binding is missing is null, and its port fails closed with nothing read or written", () => {
  it("HYPERDRIVE_APP not bound: composeReads and finalizeData are null, so compose input and finalize fail closed inside the Tool API base; the plan calls, which need HYPERDRIVE_JOB alone, stay bound; nothing is written", async () => {
    const before = await snapshot();
    for (const unbound of [{}, { HYPERDRIVE_APP: undefined }, { HYPERDRIVE_APP: null }]) {
      const job = counted(poolBinding(JOB));
      const made = built({ ...unbound, HYPERDRIVE_JOB: job.binding });

      expect(made.keys).toEqual(["ENVIRONMENT", "HYPERDRIVE_JOB", "HYPERDRIVE_APP"]);
      expect(made.inputs.composeReads).toBeNull();
      expect(made.inputs.finalizeData).toBeNull();
      expect(Object.keys(made.inputs.planCalls ?? {}).sort()).toEqual(["unplannedRows", "writePlan"]);
      expect(job.reads.n).toBe(0);

      expect(await portOutcomes(stagingRoot(skeletonFakes(), made.inputs))).toEqual({
        composeInput: closed("composeInput"),
        finalizeMessage: closed("finalizeMessage"),
        unplannedRows: "answered rows",
        writePlan: "answered notFound",
      });
      // Neither refused call reached a binding: the two clients opened are the plan calls', on the runtime side.
      expect(callsOf(made.written)).toEqual([onJob(ROW_CALLS.unplannedRows), onJob(ROW_CALLS.writePlan)]);
      expect(made.db.counts()).toMatchObject({ opened: 2, ended: 2, connectionsOpen: 0 });
      expect(job.reads.n).toBe(2);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("HYPERDRIVE_JOB not bound, with HYPERDRIVE_APP bound or not: every input is null, so compose input and finalize fail closed inside the Tool API base and unplannedRows and writePlan with NoDatabaseError; no binding's string is read and the row counts and versions are unchanged", async () => {
    const before = await snapshot();
    const cases: Readonly<Record<string, unknown>>[] = [
      {},
      { HYPERDRIVE_JOB: undefined },
      { HYPERDRIVE_JOB: null },
    ];
    for (const unbound of cases) {
      for (const withApp of [true, false]) {
        const app = counted(poolBinding(APP));
        const fields = withApp ? { ...unbound, HYPERDRIVE_APP: app.binding } : unbound;
        const made = built(fields);

        expect(made.inputs).toEqual(NO_ROW_INPUTS);
        expect(
          made.keys.filter((key) => !["ENVIRONMENT", "HYPERDRIVE_JOB", "HYPERDRIVE_APP"].includes(key)),
        ).toEqual([]);
        const expected = {
          composeInput: closed("composeInput"),
          finalizeMessage: closed("finalizeMessage"),
          unplannedRows: closed("unplannedRows"),
          writePlan: closed("writePlan"),
        };
        expect(await portOutcomes(stagingRoot(skeletonFakes(), made.inputs))).toEqual(expected);
        // The Worker's own root, over the same env: the same refusals, and still no binding's string read.
        expect(await portOutcomes(workerRoot(envOf(fields).env))).toEqual(expected);
        expect(made.written).toEqual([]);
        expect(made.db.counts()).toMatchObject({ opened: 0, ended: 0 });
        expect(app.reads.n).toBe(0);
      }
    }
    expect(await snapshot()).toEqual(before);
  });
});

// ---- a throw ---------------------------------------------------------------------------------------------------------

describe("a throw through the handle: the call fails closed with nothing read or written, named by labels only", () => {
  it("the file's two bindings crossed: the guard refuses every call before its code runs; the error and its one log line name the side, the binding and each failed check's label, and nothing else", async () => {
    const before = await snapshot();
    const made = built({ HYPERDRIVE_JOB: poolBinding(APP), HYPERDRIVE_APP: poolBinding(JOB) });
    const { composeReads, finalizeData, planCalls } = made.inputs;
    if (composeReads === null || finalizeData === null || planCalls === null) {
      throw new Error("an input is null with both bindings present");
    }
    const work = vi.fn(() => Promise.resolve("ran"));
    const row = { outboxRowId: TURNS.s101.row, businessId: BARBERSHOP };
    const cancel = { ...cancelClockJson.request, clockRowId: TURNS.s101.clock, withdrawQuestion: null };
    const calls: readonly (readonly [DbSide, () => Promise<unknown>])[] = [
      ["toolApi", () => composeReads.scope.withBusiness(BARBERSHOP, work)],
      ["toolApi", () => finalizeData.scope.withBusiness(BARBERSHOP, work)],
      ["runtime", () => composeReads.readOutboxRow(row)],
      ["runtime", () => finalizeData.readOutboxRow(row)],
      ["runtime", () => finalizeData.readFixedLineFacts(row)],
      ["runtime", () => finalizeData.writePlan(writePlanOn(TURNS.s101.row) as never)],
      ["runtime", () => finalizeData.cancelClock(cancel)],
      ["runtime", () => planCalls.unplannedRows({ turnId: TURNS.s101.turnId })],
      ["runtime", () => planCalls.writePlan(writePlanOn(TURNS.s101.row) as never)],
    ];
    /** Each side's client came from the other side's login: every check of who it is fails, the last two hold. */
    const failed = (side: DbSide): string[] => guardChecks(side).slice(0, 5);

    for (const [side, call] of calls) {
      const thrown = await rejectionOf(call());

      expect(thrown).toBeInstanceOf(DbGuardRefusal);
      const refusal = new DbGuardRefusal(side, failed(side));
      expect(thrown).toMatchObject({ side, binding: DB_SIDES[side].binding, checks: failed(side) });
      expect((thrown as Error).message).toBe(refusal.message);
      expect(Object.keys(thrown as Error).sort()).toEqual(["binding", "checks", "name", "side"]);
      for (const binding of [poolBinding(JOB), poolBinding(APP)]) expectNothingOf(binding, textsOf(thrown));
    }
    expect(work).not.toHaveBeenCalled();

    // One refusal line a call, on console.error: the side, the binding's name and the failed checks' labels.
    expect(linesNamed("dbGuardRefused")).toEqual(
      calls.map(([side]) => ({
        level: "error",
        msg: "dbGuardRefused",
        side,
        binding: DB_SIDES[side].binding,
        checks: failed(side),
      })),
    );
    // No guard passed: no timing line, every client opened was ended, and nothing was written.
    expect(made.written).toEqual([]);
    expect(made.db.counts()).toMatchObject({ opened: calls.length, ended: calls.length, connectionsOpen: 0 });
    expect(await snapshot()).toEqual(before);

    // Through a root: compose input, finalize and the turn's rows each fail with the refusal, nothing written.
    const outcomes = await portOutcomes(stagingRoot(skeletonFakes(), made.inputs));
    const refused = (side: DbSide): string =>
      `threw DbGuardRefusal: ${new DbGuardRefusal(side, failed(side)).message}`;
    expect(outcomes).toEqual({
      composeInput: refused("toolApi"),
      finalizeMessage: refused("toolApi"),
      unplannedRows: refused("runtime"),
      writePlan: refused("runtime"),
    });
    expect(await snapshot()).toEqual(before);
  });

  it("a database error (the pool's own pair, whose database does not exist) and DB_SCHEMA set: each call throws the call's name with its SQLSTATE, or the handle's refusal naming the binding, and no host, user, password or database", async () => {
    const before = await snapshot();
    const none = built({ HYPERDRIVE_JOB: poolBinding(POOL_JOB), HYPERDRIVE_APP: poolBinding(POOL_APP) });
    const schema = built({
      DB_SCHEMA: "preview_t1399",
      HYPERDRIVE_JOB: poolBinding(JOB),
      HYPERDRIVE_APP: poolBinding(APP),
    });
    const work = vi.fn(() => Promise.resolve("ran"));
    const row = { outboxRowId: TURNS.s101.row, businessId: BARBERSHOP };

    const callsOn = (inputs: RowInputs): readonly (readonly [DbSide, string, () => Promise<unknown>])[] => {
      const { composeReads, finalizeData, planCalls } = inputs;
      if (composeReads === null || finalizeData === null || planCalls === null) {
        throw new Error("an input is null with both bindings present");
      }
      return [
        ["toolApi", ROW_CALLS.composeScope, () => composeReads.scope.withBusiness(BARBERSHOP, work)],
        ["toolApi", ROW_CALLS.finalizeScope, () => finalizeData.scope.withBusiness(BARBERSHOP, work)],
        ["runtime", ROW_CALLS.readOutboxRow, () => composeReads.readOutboxRow(row)],
        ["runtime", ROW_CALLS.readFixedLineFacts, () => finalizeData.readFixedLineFacts(row)],
        ["runtime", ROW_CALLS.unplannedRows, () => planCalls.unplannedRows({ turnId: TURNS.s101.turnId })],
        ["runtime", ROW_CALLS.writePlan, () => planCalls.writePlan(writePlanOn(TURNS.s101.row) as never)],
      ];
    };

    for (const [, name, call] of callsOn(none.inputs)) {
      const thrown = await rejectionOf(call());

      expect(thrown).toBeInstanceOf(DataAccessDatabaseError);
      expect(thrown).toMatchObject({ call: name, code: "3D000", table: null, constraint: null });
      expect((thrown as Error).message).toBe(`${name}: the database refused the call (SQLSTATE 3D000)`);
      expect(Object.keys(thrown as Error).sort()).toEqual(["call", "code", "constraint", "name", "table"]);
      for (const binding of [poolBinding(POOL_JOB), poolBinding(POOL_APP)]) {
        expectNothingOf(binding, textsOf(thrown));
      }
    }
    for (const [side, name, call] of callsOn(schema.inputs)) {
      expect(await rejectionOf(call())).toEqual(new DbClosedError(name, side, "dbSchemaSet"));
    }

    expect(work).not.toHaveBeenCalled();
    // No guard passed: no timing line. The pool's own pair opened a client a call and ended each; DB_SCHEMA opened none.
    expect([none.written, schema.written]).toEqual([[], []]);
    expect(none.db.counts()).toMatchObject({ opened: 6, ended: 6, connectionsOpen: 0 });
    expect(schema.db.counts()).toMatchObject({ opened: 0, ended: 0 });
    expect(await snapshot()).toEqual(before);
  });
});

// ---- the scope's start (T-1410) --------------------------------------------------------------------------------------

/** K-05's transient for a connection lost at the start: nothing was written, and the same request may be sent again. */
const LOST = { error: "transient", sqlstate: "08006" } as const;

/**
 * A handle whose Tool API calls lose their client once the guard has passed: each client, guarded and timed as every
 * call's is, is ended before the call's own code gets it, so the scope's begin is refused by postgres.js as a connection
 * that is gone (its CONNECTION_ENDED, the binding's host and port on it). Every call is the handle's own.
 */
function lostAfterGuard(db: StagingDb): StagingDb {
  return {
    toolApi<T>(call: string, fn: (sql: Sql) => Promise<T>, traceId?: string | null): Promise<T> {
      return db.toolApi(
        call,
        async (sql) => {
          await sql.end({ timeout: 5 });
          return fn(sql);
        },
        traceId,
      );
    },
    runtime: (call, fn, traceId) => db.runtime(call, fn, traceId),
    counts: () => db.counts(),
  };
}

/**
 * A handle whose Tool API calls, once the guard has passed on the handle's own client, hand the call's code a client whose
 * every transaction's start is refused with `refusal()`, as postgres.js rejects a begin whose session PostgreSQL refused.
 */
function refusedAfterGuard(db: StagingDb, refusal: () => Error): StagingDb {
  const refusing = { begin: () => Promise.reject(refusal()) } as unknown as Sql;
  return {
    toolApi<T>(call: string, fn: (sql: Sql) => Promise<T>, traceId?: string | null): Promise<T> {
      return db.toolApi(call, () => fn(refusing), traceId);
    },
    runtime: (call, fn, traceId) => db.runtime(call, fn, traceId),
    counts: () => db.counts(),
  };
}

/** A binding's database, as its connection string names it. */
const databaseOf = (binding: { readonly connectionString: string }): string =>
  decodeURIComponent(new URL(binding.connectionString).pathname.slice(1));

/**
 * PostgreSQL's refusals of a session at its start that name the database (postinit.c), as postgres.js rejects the begin
 * with one: its PostgresError, FATAL, the SQLSTATE and the server's words.
 */
const DATABASE_REFUSALS: readonly { code: string; words: (database: string) => string }[] = [
  { code: "3D000", words: (database) => `database "${database}" does not exist` },
  { code: "42501", words: (database) => `permission denied for database "${database}"` },
  { code: "55000", words: (database) => `database "${database}" is not currently accepting connections` },
];

/** One of those refusals, as postgres.js's PostgresError carries it: its name, its severity, its SQLSTATE and its words. */
function sessionRefusal(code: string, text: string): Error {
  return Object.assign(new Error(text), {
    name: "PostgresError",
    severity_local: "FATAL",
    severity: "FATAL",
    code,
  });
}

/** Compose input and finalize through a root, each with the K-09 name its scope's transaction is opened for. */
const START_CALLS: readonly (readonly [string, (root: Root) => Promise<unknown>])[] = [
  ["composeInput", (root) => composeRow(root, TURNS.s101)],
  ["finalizeMessage", (root) => finalizeRow(root, TURNS.s101)],
];

describe("the scope's start through a root: each transaction is opened for the K-09 call the Tool API base names (T-1410)", () => {
  it("lost once the guard has passed (the scope's client ended under it): compose input and finalize each answer K-09's transient 08006, their handlers never run: no runtime-side call, nothing read or written, each client ended, nothing of a binding in an answer or a line", async () => {
    const before = await snapshot();
    const job = counted(poolBinding(JOB));
    const app = counted(poolBinding(APP));
    const { env } = envOf({ HYPERDRIVE_JOB: job.binding, HYPERDRIVE_APP: app.binding });
    const written: Json[] = [];
    const real = handleOver(env, written);
    const root = stagingRoot(skeletonFakes(), stagingRowCalls({ env, db: lostAfterGuard(real) }));

    const answers: unknown[] = [];
    for (const [call, make] of START_CALLS) {
      const answer = await make(root);
      expect(answer, call).toEqual(LOST);
      answers.push(answer);
    }

    // One client a call, each guarded and timed under the call's own K-09 name on the Tool API's side; nothing followed.
    expect(callsOf(written)).toEqual([onApp(ROW_CALLS.composeScope), onApp(ROW_CALLS.finalizeScope)]);
    expect(ROW_CALLS.composeScope).toBe("composeInput");
    expect(ROW_CALLS.finalizeScope).toBe("finalizeMessage");
    expect(real.counts()).toMatchObject({ opened: 2, ended: 2, connectionsOpen: 0 });
    expect([job.reads.n, app.reads.n]).toEqual([0, 2]);
    expect(await snapshot()).toEqual(before);
    expectNoSecrets([JSON.stringify(answers), ...lines, ...written.map((line) => JSON.stringify(line))]);
  });

  it("refused at its start once the guard has passed (3D000, 42501 and 55000, this file's database in the server's words): compose input and finalize each throw it scrubbed under their own K-09 name, the name and the SQLSTATE alone, never transient and never under withBusiness; nothing read or written", async () => {
    const before = await snapshot();
    const database = databaseOf(poolBinding(APP));
    expect(database).not.toBe("");
    for (const { code, words } of DATABASE_REFUSALS) {
      const { env } = envOf({ HYPERDRIVE_JOB: poolBinding(JOB), HYPERDRIVE_APP: poolBinding(APP) });
      const written: Json[] = [];
      const real = handleOver(env, written);
      const refusal = (): Error => sessionRefusal(code, words(database));
      expect(holds(refusal().message, database), code).toBe(true);
      const root = stagingRoot(
        skeletonFakes(),
        stagingRowCalls({ env, db: refusedAfterGuard(real, refusal) }),
      );

      for (const [call, make] of START_CALLS) {
        const thrown = await rejectionOf(make(root));

        expect(thrown, call).toBeInstanceOf(DataAccessDatabaseError);
        expect(thrown, call).toMatchObject({ call, code, table: null, constraint: null });
        expect((thrown as Error).message, call).toBe(
          `${call}: the database refused the call (SQLSTATE ${code})`,
        );
        expect(Object.keys(thrown as Error).sort(), call).toEqual([
          "call",
          "code",
          "constraint",
          "name",
          "table",
        ]);
        for (const binding of [poolBinding(JOB), poolBinding(APP)]) expectNothingOf(binding, textsOf(thrown));
      }
      expect(callsOf(written), code).toEqual([onApp(ROW_CALLS.composeScope), onApp(ROW_CALLS.finalizeScope)]);
      expect(real.counts(), code).toMatchObject({ opened: 2, ended: 2, connectionsOpen: 0 });
    }
    expect(await snapshot()).toEqual(before);
  });
});

// ---- production ------------------------------------------------------------------------------------------------------

describe("in production's environment the file reads no binding", () => {
  it("with both bindings present: every input is null, only ENVIRONMENT is read, each counting double is read 0 times, and the Worker's production root keeps the three ports closed", async () => {
    const job = counted(poolBinding(JOB));
    const app = counted(poolBinding(APP));
    const fields = {
      ENVIRONMENT: "production",
      BASE_PATH: "",
      HYPERDRIVE_JOB: job.binding,
      HYPERDRIVE_APP: app.binding,
    };

    for (const environment of ["production", "", "Staging", "preview"]) {
      const made = built({ ...fields, ENVIRONMENT: environment });
      expect(made.inputs, environment).toBe(NO_ROW_INPUTS);
      expect(made.keys, environment).toEqual(["ENVIRONMENT"]);
    }
    const { env, keys } = envOf(fields);
    const outcomes = await portOutcomes(workerRoot(env));

    const notJoined = (port: PortName): string => `threw NotJoinedError: ${new NotJoinedError(port).message}`;
    expect(outcomes).toEqual({
      composeInput: notJoined("composeInput"),
      finalizeMessage: notJoined("finalize"),
      unplannedRows: notJoined("dataAccess"),
      writePlan: notJoined("dataAccess"),
    });
    expect(keys.filter((key) => key.startsWith("HYPERDRIVE"))).toEqual([]);
    expect([job.reads.n, app.reads.n]).toEqual([0, 0]);
    expect(linesNamed("dbCall")).toEqual([]);
  });
});

// ---- the capture -----------------------------------------------------------------------------------------------------

describe("the span and log capture", () => {
  it("no line written while this file ran holds a word of a plan or of the inbound text, a number, the chat id, or a binding's string, host or database, and no rejection was left unhandled", async () => {
    // Its own round, so the capture is never empty: a row read and a plan call on this file's pair, a refusal with the
    // bindings crossed, and a database error on the pool's own pair.
    const { compose, plan } = onPair();
    await compose.readOutboxRow({ outboxRowId: TURNS.s101.row, businessId: BARBERSHOP });
    await plan.writePlan(writePlanOn(NO_SUCH_ROW) as never);
    const crossed = built({ HYPERDRIVE_JOB: poolBinding(APP), HYPERDRIVE_APP: poolBinding(JOB) });
    await rejectionOf(
      Promise.resolve(crossed.inputs.planCalls?.unplannedRows({ turnId: TURNS.s101.turnId })),
    );
    const none = built({ HYPERDRIVE_JOB: poolBinding(POOL_JOB), HYPERDRIVE_APP: poolBinding(POOL_APP) });
    await rejectionOf(Promise.resolve(none.inputs.planCalls?.unplannedRows({ turnId: TURNS.s101.turnId })));

    const kinds = new Set(
      everyLine.flatMap((line) => (line.startsWith("{") ? [String(parsed(line).msg)] : [])),
    );
    expect([...kinds]).toEqual(expect.arrayContaining(["dbCall", "dbGuardRefused"]));
    expectNoSecrets(everyLine);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(rejections.map((reason) => String(reason))).toEqual([]);
  });
});
