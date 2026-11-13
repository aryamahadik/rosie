// T-1280: K-05 v1.13's startSignIn and sendSignInCode (items 58 and 59), a sign-in's send side (ADR-016 card R1), against
// local PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/sign-in-send`). The schema comes from migrating
// a fresh test schema (db/repo/test-db.ts), which is dropped when the file ends; the public schema is never touched.
//
// The calls run as ADR-016 section 6 rules: through a client whose connections run as rosie_job, the runtime side's
// role, so the grants and row-level security are the ones the calls meet; the role is the connection's. The tables'
// owner (the migrations' role) loads the seeds a fixture's `given` names (K-04's, and K-22's by `partSeeds`), writes the
// rows a fixture's note lists and a case adds, holds a lock where a case races two calls, and reads every table back.
// Every answer is checked against its data-access v1.13 definition, and every entry a send writes against K-08 v1.2's
// eventLogRow, with Ajv 2020-12, strict, as contracts:check runs it.
//
// The database's clock (K-05 default 112: "A fixture's given.now is that clock"). The calls take no time, so a fixture
// is replayed on the database's own clock: every time its seeds and its note's rows hold is moved by one whole number of
// seconds, from its given.now to the database's now() (to the second); an `after` step runs for real, and the attempt a
// start step writes is moved to that step's own given.now on that clock. A time the rows give (a pause's end, a window's
// oldest, a repeat's expiry) is then the fixture's moved by as much, exactly; a time the call itself made (a new
// attempt's or code's end) is the one the row it wrote holds. The cases beyond the fixtures write their rows at whole
// seconds before the database's now().
//
// The rosie_job client records every statement it sends and every column name the database returns to it (postgres.js
// debug and transform.row, kept in memory for the checks and never printed), so the checks read what the calls sent and
// got back, not a copy of their SQL.
//
// Names are the master's sample cast as K-04's and K-22's seeds hold them (rule 9). The attempts, codes and rows a case
// adds carry example ids (t1280) with 128 random bits, example.com addresses and numbers in the fiction range; every
// hash is a stand-in, the sha256 of a label, never of a real code, token or contact.
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolvePrimaryUrl } from "./client";
import { DataAccessDatabaseError } from "./clocks";
import type { Sql, Tx } from "./scope";
import {
  CODES_PER_DAY,
  HANDLE_LOCK_PREFIX,
  sendSignInCode,
  type SendSignInCodeOutcome,
  type SendSignInCodeRequest,
  SIGN_IN_STARTS_PER_DAY,
  SIGN_IN_STARTS_PER_HOUR,
  startSignIn,
  type StartSignInOutcome,
  type StartSignInRequest,
} from "./sign-in-send";
import { utc } from "./targets";
import { createTestDatabase, type TestDatabase } from "./test-db";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Row = Record<string, Json>;
type Call = "startSignIn" | "sendSignInCode";
type Outcome = StartSignInOutcome | SendSignInCodeOutcome;
type Contact = { kind: "email"; address: string } | { kind: "mobile"; number: string } | { kind: "link" };

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const SCHEMA_DIR = new URL("db-schema/", CONTRACTS);
const CORE_DIR = new URL("core/fixtures/", SCHEMA_DIR);
const JOB_ROLE = "rosie_job";
const APP_ROLE = "rosie_app";
/** The rosie_job client's application name, by which a case finds its sessions waiting on a lock. */
const JOB_APP = "rosie-t1280-job";
const SLOW = { timeout: 60_000 };
const HEAVY = { timeout: 240_000 };

const SAM = "person-sam";
const RILEY = "person-riley";
const SAM_EMAIL = "sam@example.com";
const SAM_EMAIL_HANDLE = "handle-sam-email";
const SAM_MOBILE = "+15555550100";
const KEY_NAME = "PROOF_CODE_HASH_KEY";
/** K-04's seed-bundle-registry.json, the active bundle. */
const BUNDLE = { hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037", build: 1 };
/** Sam's laptop, the device his sessions in K-22's seed-session.json were started from. */
const LAPTOP = "e28c360bbd60fac9cabe9778c941ca8e14aaca204d780bfd44982220825ea15c";
/** K-22's own stand-in contact hash for Sam's email (seed-sign-in-attempt.json). */
const SAM_CONTACT_HASH = "c1a2b3c4d5e6f708192a3b4c5d6e7f80c1a2b3c4d5e6f708192a3b4c5d6e7f80";
/** The columns no statement may return (K-05 v1.13, "What the new tasks must hold to"). */
const HASH_COLUMNS = [
  "token_sha256",
  "device_sha256",
  "code_hash",
  "contact_hash",
  "request_sha256",
  "last_check_sha256",
];
/** The tables a call writes or reads back, compared whole before and after: equal means nothing was written. */
const SNAPSHOT_TABLES = [
  "sign_in_attempts",
  "proof_codes",
  "outbox_rows",
  "outbox_parts",
  "event_log",
  "sessions",
  "accounts",
];

interface Given {
  k04Seeds: string[];
  partSeeds?: string[];
  after: string[];
  now: string;
  note?: string;
}

interface Exchange {
  call: Call;
  given: Given;
  request: Row;
  outcome: Row;
}

interface TableRow {
  table: string;
  values: Row;
}

interface SeedFile {
  after: string[];
  rows: TableRow[];
}

interface IndexEntry {
  file: string;
  version: string;
  def?: string;
  expect: string;
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const exchangeOf = (file: string): Exchange => readJson(new URL(file, ACCESS_DIR)) as Exchange;
const INDEX = (readJson(new URL("index.json", ACCESS_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const isOurs = (def: string | undefined): boolean => /^(startSignIn|sendSignInCode)\./.test(def ?? "");
/** Items 58 and 59's accepted exchanges, as the index lists them. */
const ACCEPTED = INDEX.filter(
  (entry) =>
    entry.expect === "accept" &&
    (entry.def === "startSignIn.exchange" || entry.def === "sendSignInCode.exchange"),
).map((entry) => entry.file);
/** Their refused twins. */
const REFUSED = INDEX.filter((entry) => entry.expect === "refuse" && isOurs(entry.def));
const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** A stand-in hash in K-22's form: the sha256 of a label, never of a code, a token or a contact. */
const hex = (label: string): string => createHash("sha256").update(`t1280:${label}`).digest("hex");
/** An example id with 128 random bits, as the page call draws them (DL-546; K-21 default 18). */
const newId = (prefix: string): string => `${prefix}-${randomBytes(16).toString("hex")}`;
/** A contact's stand-in keyed hash. */
const contactHashOf = (contact: Contact): string => hex(`contact:${JSON.stringify(contact)}`);
/** A UTC time `seconds` after `from`, in the contract's form. */
const plus = (from: Date, seconds: number): string => utc(new Date(from.getTime() + seconds * 1000));

/** What a promise was rejected with, or null when it was not. */
async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

/** A value of a fixture or a row as text: a broken test when it is not. */
function textOf(value: Json | undefined, what: string): string {
  if (typeof value !== "string") {
    throw new Error(`${what} is not text`);
  }
  return value;
}

// ---- the contract's own schemas, for every answer and entry (Ajv 2020-12, strict, as contracts:check runs it) ---------

function schemaFiles(dir: URL): URL[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".schema.json") && !file.endsWith(".meta.schema.json"))
    .filter((file) => !file.startsWith("generated/") && !file.startsWith("scripts/"))
    .filter((file) => !file.includes("node_modules"))
    .map((file) => new URL(file, dir));
}

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
for (const file of schemaFiles(CONTRACTS)) {
  ajv.addSchema(readJson(file) as object);
}
const idOf = (path: string): string => (readJson(new URL(path, CONTRACTS)) as { $id: string }).$id;
const V113_ID = idOf("data-access/data-access.v1.13.schema.json");
const EVENTS_V12_ID = idOf("event-trace/event-trace.v1.2.schema.json");

/** Checks `value` against one $defs entry of a schema, returning Ajv's errors (none when it passes). */
function errorsOf(schemaId: string, def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${schemaId}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`${schemaId} has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

/** An answer checked against its own v1.13 definition: an error against <call>.errors, else <call>.response. */
function answerErrors(call: Call, outcome: unknown): string[] {
  const isError = typeof outcome === "object" && outcome !== null && "error" in outcome;
  return errorsOf(V113_ID, isError ? `${call}.errors` : `${call}.response`, outcome);
}

// ---- databases and clients ------------------------------------------------------------------------------------------

/** One statement the rosie_job client sent: its connection, its text and its parameters (in memory, never printed). */
interface Sent {
  connection: number;
  text: string;
  parameters: readonly unknown[];
}

let db: TestDatabase;
/** Connections that run as rosie_job, the runtime side's role, with this file's schema first; everything recorded. */
let job: Sql;
/** Connections that run as rosie_app, the Tool API's role, with this file's schema first. */
let app: Sql;
/** rosie_job connections whose session's default level is repeatable read (DL-610's "keep it"). */
let jobRepeatable: Sql;
/** table.column to data type, for the jsonb, bytea and timestamptz columns. */
const columnTypes = new Map<string, string>();
/** Every statement the rosie_job client sent, in order. */
const sent: Sent[] = [];
/** Every column name the database returned to the rosie_job client, row by row. */
const returned: string[] = [];

function roleClient(
  role: string,
  applicationName: string,
  max: number,
  options: { record?: boolean; isolation?: "repeatable read" },
): Sql {
  const record = options.record === true;
  return postgres(resolvePrimaryUrl(), {
    max,
    onnotice: () => undefined,
    ...(record
      ? {
          debug: (connection: number, text: string, parameters: unknown[]) => {
            sent.push({ connection, text, parameters: [...parameters] });
          },
          transform: {
            row: (row: Record<string, unknown>) => {
              returned.push(...Object.keys(row));
              return row;
            },
          },
        }
      : {}),
    connection: {
      application_name: applicationName,
      search_path: `${db.schema}, public`,
      role,
      ...(options.isolation === undefined ? {} : { default_transaction_isolation: options.isolation }),
    },
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "sign_in_send" });
  job = roleClient(JOB_ROLE, JOB_APP, 6, { record: true });
  app = roleClient(APP_ROLE, "rosie-t1280-app", 2, {});
  jobRepeatable = roleClient(JOB_ROLE, "rosie-t1280-job-repeatable", 2, { isolation: "repeatable read" });
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea', 'timestamp with time zone')
  `;
  for (const column of typed) {
    columnTypes.set(column.key, column.type);
  }
}, 60_000);

afterAll(async () => {
  await job.end({ timeout: 5 });
  await app.end({ timeout: 5 });
  await jobRepeatable.end({ timeout: 5 });
  await db.drop();
});

/** Empties every table the seeds and the calls write (truncating the heads cascades to the rest; this schema only). */
async function reset(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags restart identity cascade`;
}

async function insertRow(sql: Db, table: string, row: Row): Promise<void> {
  const values: Record<string, never> = {};
  for (const [column, value] of Object.entries(row)) {
    const type = columnTypes.get(`${table}.${column}`);
    let converted: unknown = value;
    if (type === "jsonb" && value !== null) {
      converted = sql.json(value);
    } else if (type === "bytea" && typeof value === "string") {
      converted = fromHex(value.replace(/^\\x/, ""));
    }
    values[column] = converted as never;
  }
  await sql`insert into ${sql(table)} ${sql(values)}`;
}

/** Rows as the owner, in one transaction. */
async function writeRows(rows: readonly TableRow[]): Promise<void> {
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
    }
  });
}

/** The database's now(), to the second: the clock the cases and the replayed fixtures write their rows on. */
async function secondNow(): Promise<Date> {
  const [row] = await db.sql<{ now: Date }[]>`select date_trunc('second', now()) as now`;
  if (row === undefined) {
    throw new Error("now() answered no row");
  }
  return row.now;
}

/** A UTC time of a fixture, moved by `delta` milliseconds. */
const shiftText = (text: string, delta: number): string => utc(new Date(Date.parse(text) + delta));

/** A row with every timestamptz value moved by `delta` milliseconds. */
function shifted(row: TableRow, delta: number): TableRow {
  const values: Row = {};
  for (const [column, value] of Object.entries(row.values)) {
    const isTime = columnTypes.get(`${row.table}.${column}`) === "timestamp with time zone";
    values[column] = isTime && typeof value === "string" ? shiftText(value, delta) : value;
  }
  return { table: row.table, values };
}

// ---- seeds, chains and the rows a note lists ---------------------------------------------------------------------------

/** A K-04 seed by its name. */
function coreSeed(name: string): URL {
  return new URL(name, CORE_DIR);
}

/** `<part>/<file>`, a seed of another database part (README "Fixtures", given.partSeeds), in that part's fixtures. */
function partSeed(name: string): URL {
  const slash = name.indexOf("/");
  if (slash < 1) {
    throw new Error(`partSeeds names <part>/<file>, not ${name}`);
  }
  return new URL(`${name.slice(0, slash)}/fixtures/${name.slice(slash + 1)}`, SCHEMA_DIR);
}

/** The seeds every case beyond the fixtures loads: the active bundle and K-22's sign-in chain (Sam's account). */
const SIGN_IN_SEEDS = [
  coreSeed("seed-bundle-registry.json"),
  partSeed("people-access/seed-sign-in-attempt.json"),
];

/** A seed's rows after those of the seeds its `after` names, each read from the seed's own folder; each seed once. */
function seedRows(seed: URL, seen: Set<string>): TableRow[] {
  if (seen.has(seed.href)) {
    return [];
  }
  seen.add(seed.href);
  const file = readJson(seed) as SeedFile;
  return [...file.after.flatMap((before) => seedRows(new URL(before, seed), seen)), ...file.rows];
}

/** A fixture's chain: the seeds of every exchange in it, and the exchanges its `after` runs first, in order. */
function chainOf(file: string, seen = new Set<string>()): { seeds: URL[]; steps: string[] } {
  const { given } = exchangeOf(file);
  const seeds = [...given.k04Seeds.map(coreSeed), ...(given.partSeeds ?? []).map(partSeed)];
  const steps: string[] = [];
  for (const before of given.after) {
    if (seen.has(before)) {
      continue;
    }
    seen.add(before);
    const inner = chainOf(before, seen);
    seeds.push(...inner.seeds);
    steps.push(...inner.steps, before);
  }
  return { seeds, steps };
}

/** Empties the tables and loads the seeds with their own chains, every time moved by `delta`, as the owner. */
async function loadSeeds(seeds: readonly URL[], delta: number): Promise<void> {
  await reset();
  const seen = new Set<string>();
  await writeRows(seeds.flatMap((seed) => seedRows(seed, seen)).map((row) => shifted(row, delta)));
}

/** An attempt row as K-22 v1.2 holds it, its 10 minutes from `startedAt`, with no try, check, code or session. */
function attemptRow(values: { id: string; startedAt: string } & Row): TableRow {
  const { startedAt, ...rest } = values;
  return {
    table: "sign_in_attempts",
    values: {
      attempt_id: `attempt-of-${values.id}`,
      request_sha256: hex(`request:${values.id}`),
      device_sha256: LAPTOP,
      contact_hash: SAM_CONTACT_HASH,
      hash_key_name: KEY_NAME,
      way: "email",
      person_id: null,
      owner_or_admin: false,
      proof_code_id: null,
      started_at: startedAt,
      expires_at: utc(new Date(Date.parse(startedAt) + 10 * 60_000)),
      wrong_tries: 0,
      last_wrong_at: null,
      paused_until: null,
      last_check_sha256: null,
      last_outcome: null,
      session_id: null,
      version: 1,
      ...rest,
    },
  };
}

/** A code sent to Sam's email handle at `sentAt` (a stand-in hash), unused and untried. */
function codeRow(id: string, sentAt: string, values: Row = {}): TableRow {
  return {
    table: "proof_codes",
    values: {
      id,
      purpose: "sign_in",
      person_id: SAM,
      business_id: null,
      sent_to_handle_id: SAM_EMAIL_HANDLE,
      channel: "email",
      code_hash: hex(`code:${id}`),
      hash_key_name: KEY_NAME,
      sent_at: sentAt,
      expires_at: utc(new Date(Date.parse(sentAt) + 10 * 60_000)),
      wrong_tries: 0,
      used_at: null,
      version: 1,
      ...values,
    },
  };
}

/** The four attempts start-sign-in-day-cap's note lists, beside its step's attempt of 13:00:00Z. */
const DAY_CAP_ROWS: readonly TableRow[] = [
  ["1330", "2", "2026-11-02T13:30:00Z"],
  ["1400", "3", "2026-11-02T14:00:00Z"],
  ["1430", "4", "2026-11-02T14:30:00Z"],
  ["1445", "5", "2026-11-02T14:45:00Z"],
].map(([at, n, startedAt]) =>
  attemptRow({
    id: `sign-in-sam-nov02-${String(at)}`,
    startedAt: String(startedAt),
    attempt_id: `attempt-sam-signin-nov02-${String(n)}`,
    person_id: SAM,
    owner_or_admin: true,
  }),
);

/** The 100 attempts start-sign-in-hour-bound's note lists: each its own contact, every 30 s from 12:06:00Z. */
const HOUR_ROWS: readonly TableRow[] = Array.from({ length: 100 }, (_, k) =>
  attemptRow({
    id: `sign-in-t1280-hour-${String(k)}`,
    startedAt: utc(new Date(Date.parse("2026-11-02T12:06:00Z") + k * 30_000)),
    device_sha256: hex(`hour-device-${String(k)}`),
    contact_hash: hex(`hour-contact-${String(k)}`),
  }),
);

/** The rows three fixtures' notes list (their database side writes them itself). */
const NOTE_ROWS: Readonly<Record<string, readonly TableRow[]>> = {
  "start-sign-in-two-accounts.json": [
    {
      table: "accounts",
      values: {
        person_id: RILEY,
        mobile: null,
        mobile_proven_at: null,
        email: SAM_EMAIL,
        email_proven_at: "2026-10-30T10:00:00Z",
        version: 1,
      },
    },
  ],
  "start-sign-in-day-cap.json": DAY_CAP_ROWS,
  "start-sign-in-hour-bound.json": HOUR_ROWS,
};

/** One call through its db/repo function, the request handed on as given. */
function callOf(call: Call, request: Row, sql: Sql = job): Promise<Outcome> {
  return call === "startSignIn"
    ? startSignIn(sql, request as unknown as StartSignInRequest)
    : sendSignInCode(sql, request as unknown as SendSignInCodeRequest);
}

/** Moves an attempt a start step wrote to its step's own given.now on the database's clock (its 10 minutes with it). */
async function moveAttempt(id: string, startedAt: string): Promise<void> {
  const moved = await db.sql`
    update sign_in_attempts
    set started_at = ${startedAt}, expires_at = ${startedAt}::timestamptz + interval '10 minutes', version = version + 1
    where id = ${id}
    returning id
  `;
  expect(moved.length, `the step's attempt ${id}`).toBe(1);
}

/** Runs a chain's step for real, checks it answers its own fixture's outcome but for a time it made, and moves it. */
async function runStep(file: string, delta: number): Promise<void> {
  const step = exchangeOf(file);
  const outcome = (await callOf(step.call, step.request)) as unknown as Row;
  expect({ ...outcome, expiresAt: null }, file).toEqual({ ...step.outcome, expiresAt: null });
  if (step.call === "startSignIn" && outcome.result === "started" && outcome.repeated === false) {
    await moveAttempt(textOf(outcome.id, `${file}'s attempt id`), shiftText(step.given.now, delta));
  }
}

/** Loads a fixture's seeds on the database's clock, runs its chain and writes its note's rows; answers the move. */
async function given(file: string): Promise<{ exchange: Exchange; delta: number }> {
  const exchange = exchangeOf(file);
  const delta = (await secondNow()).getTime() - Date.parse(exchange.given.now);
  const chain = chainOf(file);
  await loadSeeds(chain.seeds, delta);
  for (const step of chain.steps) {
    await runStep(step, delta);
  }
  await writeRows((NOTE_ROWS[file] ?? []).map((row) => shifted(row, delta)));
  return { exchange, delta };
}

/** Every table a call touches, whole, as the owner reads it: equal before and after means nothing was written. */
async function snapshot(): Promise<Record<string, Json[]>> {
  const tables: Record<string, Json[]> = {};
  for (const table of SNAPSHOT_TABLES) {
    const rows = await db.sql<{ row: Json }[]>`
      select to_jsonb(t) as row from ${db.sql(table)} t order by to_jsonb(t)::text
    `;
    tables[table] = rows.map((row) => row.row);
  }
  return tables;
}

/** An attempt's or a code's end as stored, in the answers' form. */
async function endOf(table: "sign_in_attempts" | "proof_codes", id: string): Promise<string> {
  const [row] = await db.sql<{ expires_at: Date }[]>`
    select expires_at from ${db.sql(table)} where id = ${id}
  `;
  if (row === undefined) {
    throw new Error(`no ${table} row ${id}`);
  }
  return utc(row.expires_at);
}

/** Whether an answer writes nothing: a pause, a repeat, nothing sent, or an error. */
function writesNothing(outcome: Row): boolean {
  return (
    "error" in outcome ||
    outcome.result === "paused" ||
    outcome.result === "notSent" ||
    outcome.repeated === true
  );
}

// ---- the requests a case makes ----------------------------------------------------------------------------------------

/** A start the page call would send for `contact`, its ids drawn from 128 random bits. */
function startRequest(contact: Contact): StartSignInRequest {
  return {
    id: newId("sign-in-t1280"),
    attemptId: newId("attempt-t1280"),
    requestSha256: hex(newId("request")),
    deviceSha256: LAPTOP,
    contact,
    contactHash: contactHashOf(contact),
    hashKeyName: KEY_NAME,
    way: "email",
  };
}

/** The code line T-322's words.ts writes. */
const lineOf = (code: string): string =>
  `Code ${code}: type it on the sign-in page. It works for 10 minutes.`;

/** A send the page call would make for an attempt: new ids, a code's stand-in hash, the code's line in the words. */
function sendRequest(attemptId: string, code: string, overrides: Row = {}): SendSignInCodeRequest {
  const rowId = newId("out-t1280-code");
  return {
    signInAttemptId: attemptId,
    traceId: newId("trace-t1280"),
    bundle: BUNDLE,
    code: { id: newId("code-t1280"), codeHash: hex(`code:${code}`), hashKeyName: KEY_NAME },
    emailRowId: rowId,
    plan: {
      row: rowId,
      channel: "email",
      copyOf: null,
      plan: { formats: ["text"], lines: [], question: null, pageType: null, threadReplyTo: null },
    },
    finalParts: {
      row: rowId,
      channel: "email",
      sends: [{ kind: "words", text: lineOf(code), calendarFile: "none", options: [], link: null }],
      fixedLines: [],
      slotValues: [],
      threadReplyTo: null,
    },
    ...overrides,
  } as unknown as SendSignInCodeRequest;
}

const SAM_BY_EMAIL: Contact = { kind: "email", address: SAM_EMAIL };
const SAM_BY_MOBILE: Contact = { kind: "mobile", number: SAM_MOBILE };

/** A start that must answer started; its answer. */
async function started(request: StartSignInRequest): Promise<{ id: string; personId: string | null }> {
  const outcome = await startSignIn(job, request);
  expect(answerErrors("startSignIn", outcome)).toEqual([]);
  if (!("result" in outcome) || outcome.result !== "started") {
    throw new Error(`the start answered ${JSON.stringify(outcome)}`);
  }
  return { id: outcome.id, personId: outcome.personId };
}

/** Sam's handle at `n` codes in the last 24 hours, every one sent within the last hour. */
async function samAtCodes(n: number, now: Date): Promise<void> {
  await writeRows(
    Array.from({ length: n }, (_, k) =>
      codeRow(`code-t1280-earlier-${String(k)}`, plus(now, -3600 + k * 60)),
    ),
  );
}

/** The count of codes sent to Sam's email handle in the last 24 hours, every person and purpose (proof_code_limits'). */
async function codesToSam(): Promise<number> {
  const [row] = await db.sql<{ n: number }[]>`
    select count(*)::integer as n from proof_codes
    where sent_to_handle_id = ${SAM_EMAIL_HANDLE} and sent_at > now() - interval '24 hours'
  `;
  return row?.n ?? 0;
}

// ---- races: a lock held by the owner while calls wait on it ------------------------------------------------------------

/** Waits until `count` of the rosie_job client's sessions wait on an advisory lock. */
async function waitForLockWaiters(count: number): Promise<void> {
  const giveUpAt = Date.now() + 20_000;
  for (;;) {
    const [row] = await db.sql<{ waiting: number }[]>`
      select count(*)::integer as waiting from pg_stat_activity
      where datname = current_database() and application_name = ${JOB_APP}
        and wait_event_type = 'Lock' and wait_event = 'advisory'
    `;
    if ((row?.waiting ?? 0) >= count) {
      return;
    }
    if (Date.now() > giveUpAt) {
      throw new Error(`no ${String(count)} rosie_job sessions waited on an advisory lock within 20 s`);
    }
    await sleep(25);
  }
}

/**
 * Holds what `hold` takes in an owner's transaction, starts `run`, waits until `waiters` of its sessions wait on an
 * advisory lock, then commits, letting them go; answers what `run` answers.
 */
async function whileHeld<T>(
  hold: (tx: Tx) => Promise<unknown>,
  waiters: number,
  run: () => Promise<T>,
): Promise<T> {
  const running: { calls?: Promise<T> } = {};
  await db.sql.begin(async (tx) => {
    await hold(tx);
    const calls = run();
    running.calls = calls;
    void calls.catch(() => undefined);
    await waitForLockWaiters(waiters);
  });
  if (running.calls === undefined) {
    throw new Error("the calls never started");
  }
  return running.calls;
}

/** K-22 rule 9's lock on a contact's hash, as the owner takes it. */
const contactLock = (hash: string) => (tx: Tx) =>
  tx`select pg_advisory_xact_lock(hashtext('sign_in_attempts:' || ${hash}))`;
/** DL-610's lock on an email handle, as the owner takes it. */
const handleLock = (handleId: string) => (tx: Tx) =>
  tx`select pg_advisory_xact_lock(hashtextextended(${HANDLE_LOCK_PREFIX + handleId}, 0))`;

/** The outcomes' results, sorted, for a race whose order is the database's. */
const resultsOf = (outcomes: readonly Outcome[]): string[] =>
  outcomes
    .map((outcome) =>
      "result" in outcome ? `${outcome.result}${"why" in outcome ? `:${outcome.why}` : ""}` : outcome.error,
    )
    .sort();

// ---- the fixtures ------------------------------------------------------------------------------------------------------

describe("K-05 v1.13's fixtures for items 58 and 59, replayed on the database's clock", () => {
  it("lists nine start exchanges, four send exchanges and three refused twins", () => {
    expect(ACCEPTED.filter((file) => exchangeOf(file).call === "startSignIn")).toHaveLength(9);
    expect(ACCEPTED.filter((file) => exchangeOf(file).call === "sendSignInCode")).toHaveLength(4);
    expect(REFUSED.map((entry) => entry.file).sort()).toEqual([
      "invalid/refuse-send-sign-in-code-plain-code.json",
      "invalid/refuse-start-sign-in-past-cap-wrote.json",
      "invalid/refuse-start-sign-in-text-way.json",
    ]);
  });

  for (const file of ACCEPTED) {
    it(
      `${file}: as rosie_job, answers the fixture's outcome on the database's clock, valid against v1.13`,
      SLOW,
      async () => {
        const { exchange, delta } = await given(file);
        const before = await snapshot();
        const outcome = (await callOf(exchange.call, exchange.request)) as unknown as Row;
        expect(answerErrors(exchange.call, outcome)).toEqual([]);
        const expected = exchange.outcome;
        if (expected.result === "paused") {
          // A pause's end comes from the rows, so it is the fixture's moved to this clock, exactly.
          expect(outcome).toEqual({ ...expected, until: shiftText(textOf(expected.until, "until"), delta) });
        } else if (exchange.call === "startSignIn" && expected.result === "started") {
          const end = await endOf("sign_in_attempts", textOf(expected.id, "id"));
          expect(outcome).toEqual({ ...expected, expiresAt: end });
          if (expected.repeated === true) {
            expect(end).toBe(shiftText(textOf(expected.expiresAt, "expiresAt"), delta));
          }
        } else if (exchange.call === "sendSignInCode" && expected.result === "sent") {
          expect(outcome).toEqual({
            ...expected,
            expiresAt: await endOf("proof_codes", textOf(expected.proofCodeId, "proofCodeId")),
          });
        } else {
          expect(outcome).toEqual(expected);
        }
        if (writesNothing(outcome)) {
          expect(await snapshot()).toEqual(before);
        }
      },
    );
  }

  it(
    "refuses the v1.13 refused twins: a start by way text and a send with the code itself throw before any statement",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      const before = await snapshot();
      for (const entry of REFUSED.filter((refused) => refused.def?.endsWith(".exchange"))) {
        const twin = readJson(new URL(entry.file, ACCESS_DIR)) as Exchange;
        expect(errorsOf(V113_ID, String(entry.def), twin), entry.file).not.toEqual([]);
        sent.length = 0;
        const error = await thrownBy(callOf(twin.call, twin.request));
        expect(error, entry.file).toBeInstanceOf(TypeError);
        expect(sent, `${entry.file}: no statement`).toEqual([]);
        const message = (error as Error).message;
        expect(message).toMatch(twin.call === "startSignIn" ? /way is email/ : /code\.codeHash is a sha256/);
        expect(message).not.toContain("482913");
      }
      const pastCap = readJson(new URL("invalid/refuse-start-sign-in-past-cap-wrote.json", ACCESS_DIR));
      expect(errorsOf(V113_ID, "startSignIn.response", pastCap)).not.toEqual([]);
      expect(await snapshot()).toEqual(before);
    },
  );
});

// ---- the card's cases (ADR-016 section 7, card R1, Proves it with) ------------------------------------------------------

describe("ADR-016 card R1's cases", () => {
  it(
    "a repeat writes nothing: the same start answers its first attempt, and a second send its first code",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      const first = startRequest(SAM_BY_EMAIL);
      const start = await startSignIn(job, first);
      expect(start).toMatchObject({ result: "started", repeated: false, personId: SAM });
      const send = await sendSignInCode(job, sendRequest(first.id, "482913"));
      expect(send).toMatchObject({ result: "sent", repeated: false });

      const before = await snapshot();
      const again = await startSignIn(job, {
        ...startRequest(SAM_BY_EMAIL),
        requestSha256: first.requestSha256,
      });
      expect(answerErrors("startSignIn", again)).toEqual([]);
      expect(again).toEqual({
        result: "started",
        id: first.id,
        attemptId: first.attemptId,
        expiresAt: await endOf("sign_in_attempts", first.id),
        repeated: true,
        personId: null,
      });
      const resend = await sendSignInCode(job, sendRequest(first.id, "730254"));
      expect(answerErrors("sendSignInCode", resend)).toEqual([]);
      if (!("result" in send) || send.result !== "sent") {
        throw new Error("the first send did not answer sent");
      }
      expect(resend).toEqual({
        result: "sent",
        proofCodeId: send.proofCodeId,
        outboxRowId: send.outboxRowId,
        expiresAt: send.expiresAt,
        repeated: true,
      });
      expect(await snapshot()).toEqual(before);
    },
  );

  it(
    "the sixth start in 24 hours answers paused until the earliest of five plus 24 hours, exactly, writing nothing",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      const now = await secondNow();
      const contact: Contact = { kind: "email", address: "someone-t1280@example.com" };
      const hash = contactHashOf(contact);
      const startedAt = [-23 * 3600, -20 * 3600, -10 * 3600, -7200, -3600].map((seconds) =>
        plus(now, seconds),
      );
      await writeRows(
        startedAt.map((at, k) =>
          attemptRow({ id: `sign-in-t1280-day-${String(k)}`, startedAt: at, contact_hash: hash }),
        ),
      );
      const before = await snapshot();
      sent.length = 0;
      const outcome = await startSignIn(job, startRequest(contact));
      expect(answerErrors("startSignIn", outcome)).toEqual([]);
      expect(outcome).toEqual({ result: "paused", until: plus(now, -23 * 3600 + 24 * 3600), by: "dayCap" });
      expect(sent.filter((statement) => /accounts|person_roles/.test(statement.text))).toEqual([]);
      expect(await snapshot()).toEqual(before);
    },
  );

  it(
    "a sixth start after five the call itself made answers until the first one's start plus 24 hours, rounded up to the millisecond",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      const contact: Contact = { kind: "email", address: "five-t1280@example.com" };
      for (let k = 0; k < SIGN_IN_STARTS_PER_DAY; k += 1) {
        await started(startRequest(contact));
      }
      const before = await snapshot();
      const outcome = await startSignIn(job, startRequest(contact));
      expect(answerErrors("startSignIn", outcome)).toEqual([]);
      if (!("result" in outcome) || outcome.result !== "paused") {
        throw new Error(`the sixth start answered ${JSON.stringify(outcome)}`);
      }
      expect(outcome.by).toBe("dayCap");
      const [exact] = await db.sql<{ micros: string }[]>`
      select (extract(epoch from min(started_at) + interval '24 hours') * 1000000)::bigint::text as micros
      from sign_in_attempts where contact_hash = ${contactHashOf(contact)}
    `;
      const answered = BigInt(Date.parse(outcome.until)) * 1000n;
      const u = BigInt(exact?.micros ?? "0");
      expect(answered >= u, "never before the cap ends").toBe(true);
      expect(answered - u < 1000n, "within the millisecond after it").toBe(true);
      expect(await snapshot()).toEqual(before);
    },
  );

  it(
    "a start during a pause answers paused until the pause's end, exactly, with or without an account, writing nothing",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      const now = await secondNow();
      const someone: Contact = { kind: "email", address: "someone-paused-t1280@example.com" };
      const paused = (id: string, contactHash: string, personId: string | null): TableRow =>
        attemptRow({
          id,
          startedAt: plus(now, -300),
          contact_hash: contactHash,
          person_id: personId,
          wrong_tries: 5,
          last_wrong_at: plus(now, -60),
          paused_until: plus(now, 14 * 60),
          last_check_sha256: hex(`check:${id}`),
          last_outcome: "paused",
          version: 6,
        });
      await writeRows([
        paused("sign-in-t1280-paused-sam", contactHashOf(SAM_BY_EMAIL), SAM),
        paused("sign-in-t1280-paused-someone", contactHashOf(someone), null),
      ]);
      const before = await snapshot();
      sent.length = 0;
      const withAccount = await startSignIn(job, startRequest(SAM_BY_EMAIL));
      const withNone = await startSignIn(job, startRequest(someone));
      const expected = { result: "paused", until: plus(now, 14 * 60), by: "contactPause" };
      expect(withAccount).toEqual(expected);
      expect(withNone).toEqual(expected);
      expect(answerErrors("startSignIn", withAccount)).toEqual([]);
      // Rules 0 to 3 read no account: a paused start never reaches the account's statement.
      expect(sent.filter((statement) => /accounts|person_roles/.test(statement.text))).toEqual([]);
      expect(await snapshot()).toEqual(before);
    },
  );

  it(
    "the 101st start in an hour answers paused until the oldest of 100 is an hour old, writing nothing",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      const now = await secondNow();
      await writeRows(
        Array.from({ length: SIGN_IN_STARTS_PER_HOUR }, (_, k) =>
          attemptRow({
            id: `sign-in-t1280-burst-${String(k)}`,
            startedAt: plus(now, -59 * 60 + k * 30),
            contact_hash: hex(`burst-contact-${String(k)}`),
          }),
        ),
      );
      const before = await snapshot();
      sent.length = 0;
      const outcome = await startSignIn(job, startRequest(SAM_BY_EMAIL));
      expect(answerErrors("startSignIn", outcome)).toEqual([]);
      expect(outcome).toEqual({ result: "paused", until: plus(now, 60), by: "hourBound" });
      // Rule 0 is read before any lock and any account.
      expect(sent.filter((statement) => /pg_advisory|accounts|person_roles/.test(statement.text))).toEqual(
        [],
      );
      expect(await snapshot()).toEqual(before);
    },
  );

  it(
    "two parallel starts at the cap give one attempt: the second waits for the first's lock and counts its attempt",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      const now = await secondNow();
      const contact: Contact = { kind: "email", address: "racing-t1280@example.com" };
      const hash = contactHashOf(contact);
      await writeRows(
        [-5 * 3600, -4 * 3600, -3 * 3600, -2 * 3600].map((seconds, k) =>
          attemptRow({
            id: `sign-in-t1280-race-${String(k)}`,
            startedAt: plus(now, seconds),
            contact_hash: hash,
          }),
        ),
      );
      const outcomes = await whileHeld(contactLock(hash), 2, () =>
        Promise.all([startSignIn(job, startRequest(contact)), startSignIn(job, startRequest(contact))]),
      );
      for (const outcome of outcomes) {
        expect(answerErrors("startSignIn", outcome)).toEqual([]);
      }
      expect(resultsOf(outcomes)).toEqual(["paused", "started"]);
      expect(outcomes.find((outcome) => "result" in outcome && outcome.result === "paused")).toEqual({
        result: "paused",
        until: plus(now, -5 * 3600 + 24 * 3600),
        by: "dayCap",
      });
      const [count] = await db.sql<{ n: number }[]>`
      select count(*)::integer as n from sign_in_attempts where contact_hash = ${hash}
    `;
      expect(count?.n).toBe(SIGN_IN_STARTS_PER_DAY);
    },
  );

  it(
    "two accounts on one email name no person, and a send for that attempt writes and sends nothing",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      await writeRows([
        {
          table: "accounts",
          values: {
            person_id: RILEY,
            mobile: null,
            email: SAM_EMAIL,
            email_proven_at: "2026-10-30T10:00:00Z",
          },
        },
      ]);
      const request = startRequest(SAM_BY_EMAIL);
      expect(await started(request)).toEqual({ id: request.id, personId: null });
      const [attempt] = await db.sql<{ person_id: string | null; owner_or_admin: boolean }[]>`
      select person_id, owner_or_admin from sign_in_attempts where id = ${request.id}
    `;
      expect(attempt).toEqual({ person_id: null, owner_or_admin: false });
      const before = await snapshot();
      expect(await sendSignInCode(job, sendRequest(request.id, "615048"))).toEqual({
        result: "notSent",
        why: "noPerson",
      });
      expect(await snapshot()).toEqual(before);
    },
  );

  it(
    "a send writes one code row, one email row (checked, job id, quick_reply, code, not_after the code's end) and three entries, none with the final parts",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      const start = startRequest(SAM_BY_EMAIL);
      expect(await started(start)).toEqual({ id: start.id, personId: SAM });
      const request = sendRequest(start.id, "482913");
      const outcome = await sendSignInCode(job, request);
      expect(answerErrors("sendSignInCode", outcome)).toEqual([]);
      const codeId = request.code.id;
      const rowId = request.emailRowId;
      expect(outcome).toEqual({
        result: "sent",
        proofCodeId: codeId,
        outboxRowId: rowId,
        commitSeq: 1,
        version: 2,
        expiresAt: await endOf("proof_codes", codeId),
        entryIds: [`log-${rowId}-created`, `log-${rowId}-planned`, `log-${codeId}-sent`],
        repeated: false,
      });

      // One code row: sign_in, Sam, no business, his proven email's handle, email, the keyed hash, 10 minutes.
      const codes = await db.sql<Row[]>`
      select id, purpose, person_id, business_id, sent_to_handle_id, channel, code_hash = ${request.code.codeHash} as hash_kept,
             hash_key_name, expires_at = sent_at + interval '10 minutes' as ten_minutes, sent_at <= now() as sent_now,
             wrong_tries, last_wrong_at, paused_until, used_at, version
      from proof_codes where sent_at > now() - interval '1 hour'
    `;
      expect(codes).toEqual([
        {
          id: codeId,
          purpose: "sign_in",
          person_id: SAM,
          business_id: null,
          sent_to_handle_id: SAM_EMAIL_HANDLE,
          channel: "email",
          hash_kept: true,
          hash_key_name: KEY_NAME,
          ten_minutes: true,
          sent_now: true,
          wrong_tries: 0,
          last_wrong_at: null,
          paused_until: null,
          used_at: null,
          version: 1,
        },
      ]);

      // One email row with no turn, written checked with its plan and final parts.
      const rows = await db.sql<Row[]>`
      select o.id, o.turn_id, o.job_id, o.recipient_handle_id, o.recipient_person_id, o.business_id, o.booking_id,
             o.channel, o.send_class, o.versions_read, o.open_question_id, o.plan, o.final_parts, o.copy_of_row_id,
             o.state, o.held_until, o.bundle_hash, o.bundle_build, o.trace_id, o.version, o.email_purpose,
             o.not_after = c.expires_at as not_after_is_code_end
      from outbox_rows o join proof_codes c on c.id = ${codeId}
      where o.job_id = ${start.id}
    `;
      expect(rows).toEqual([
        {
          id: rowId,
          turn_id: null,
          job_id: start.id,
          recipient_handle_id: SAM_EMAIL_HANDLE,
          recipient_person_id: SAM,
          business_id: null,
          booking_id: null,
          channel: "email",
          send_class: "quick_reply",
          versions_read: [],
          open_question_id: null,
          plan: request.plan as unknown as Json,
          final_parts: request.finalParts as unknown as Json,
          copy_of_row_id: null,
          state: "checked",
          held_until: null,
          bundle_hash: BUNDLE.hash,
          bundle_build: BUNDLE.build,
          trace_id: request.traceId,
          version: 2,
          email_purpose: "code",
          not_after_is_code_end: true,
        },
      ]);
      const parts = await db.sql`select 1 from outbox_parts where outbox_row_id = ${rowId}`;
      expect(parts.length, "no part before the dispatcher's claim").toBe(0);
      const [attempt] = await db.sql<Row[]>`
      select proof_code_id, version from sign_in_attempts where id = ${start.id}
    `;
      expect(attempt).toEqual({ proof_code_id: codeId, version: 2 });

      // The three entries of ADR-016 section 1, under the attempt's id as their job id.
      const entries = await db.sql<Row[]>`
      select e.*, date_trunc('milliseconds', c.sent_at) as sent_ms
      from event_log e join proof_codes c on c.id = ${codeId}
      where e.job_id = ${start.id}
      order by e.id = ${`log-${codeId}-sent`}, e.id
    `;
      const common = {
        zone: null,
        turn_id: null,
        job_id: start.id,
        trace_id: request.traceId,
        bundle_hash: null,
        bundle_build: null,
        business_id: null,
        actor_kind: "rosie",
        actor_person_id: null,
        actor_role: null,
        sealed_values: null,
        sealed_for_person_id: null,
        why: { step: "S11-52" },
        approved_by: null,
        proofs: null,
      };
      // Each entry's at is the code's sent_at, the transaction's now(), as a time in the answers' millisecond form.
      const stripped = entries.map(({ at, sent_ms: sentMs, ...entry }) => {
        expect(at).toEqual(sentMs);
        return entry;
      });
      const sentAt = await db.sql<{ sent_at: Date; expires_at: Date }[]>`
      select sent_at, expires_at from proof_codes where id = ${codeId}
    `;
      expect(stripped).toEqual([
        {
          ...common,
          id: `log-${rowId}-created`,
          kind: "outbox_row.created",
          table_name: "outbox_rows",
          row_id: rowId,
          old_values: null,
          new_values: { state: "planned", channel: "email", send_class: "quick_reply" },
        },
        {
          ...common,
          id: `log-${rowId}-planned`,
          kind: "outbox_row.planned",
          table_name: "outbox_rows",
          row_id: rowId,
          old_values: { state: "planned" },
          new_values: { state: "checked" },
        },
        {
          ...common,
          id: `log-${codeId}-sent`,
          kind: "proof_code.sent",
          table_name: "proof_codes",
          row_id: codeId,
          old_values: null,
          new_values: {
            person_id: SAM,
            purpose: "sign_in",
            sent_to_handle_id: SAM_EMAIL_HANDLE,
            channel: "email",
            sent_at: utc(sentAt[0]?.sent_at ?? new Date(0)),
            expires_at: utc(sentAt[0]?.expires_at ?? new Date(0)),
          },
        },
      ]);
      // Each a K-08 v1.2 eventLogRow (null columns left out, as the format allows), holding nothing of the code.
      for (const entry of entries) {
        const id = textOf(entry.id, "an entry's id");
        const document: Row = {};
        for (const [column, value] of Object.entries(entry)) {
          if (value !== null && column !== "sent_ms") {
            document[column] = value;
          }
        }
        document.at = utc(entry.at as unknown as Date);
        expect(errorsOf(EVENTS_V12_ID, "eventLogRow", document), id).toEqual([]);
        const text = JSON.stringify(entry);
        for (const secret of [
          lineOf("482913"),
          "482913",
          request.code.codeHash,
          SAM_EMAIL,
          contactHashOf(SAM_BY_EMAIL),
        ]) {
          expect(text, `${id} holds nothing of the code, its hash or the address`).not.toContain(secret);
        }
        expect(text).not.toContain(JSON.stringify(request.plan));
      }
    },
  );

  it(
    "a contact with no account starts as one with an account does, and its send writes no code, row or entry",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      const withAccount = await startSignIn(job, startRequest(SAM_BY_EMAIL));
      const request = startRequest({ kind: "email", address: "nobody-t1280@example.com" });
      const withNone = await startSignIn(job, request);
      expect(answerErrors("startSignIn", withNone)).toEqual([]);
      expect(Object.keys(withNone).sort()).toEqual(Object.keys(withAccount).sort());
      expect(withNone).toMatchObject({ result: "started", repeated: false, personId: null });
      const before = await snapshot();
      expect(await sendSignInCode(job, sendRequest(request.id, "615048"))).toEqual({
        result: "notSent",
        why: "noPerson",
      });
      expect(await snapshot()).toEqual(before);
    },
  );
});

// ---- the lead notes (DL-546, DL-610) -----------------------------------------------------------------------------------

describe("the lead notes: one send per contact, one person's two lock keys, read committed (DL-546, DL-610)", () => {
  it(
    "one start from the email and one from the mobile, for one person at 4 codes: only one send passes",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      await samAtCodes(CODES_PER_DAY - 1, await secondNow());
      const byEmail = startRequest(SAM_BY_EMAIL);
      const byMobile = startRequest(SAM_BY_MOBILE);
      expect(await started(byEmail)).toEqual({ id: byEmail.id, personId: SAM });
      expect(await started(byMobile)).toEqual({ id: byMobile.id, personId: SAM });
      // Two contacts, two contact locks: only the handle's lock keeps the two sends apart.
      const outcomes = await whileHeld(handleLock(SAM_EMAIL_HANDLE), 2, () =>
        Promise.all([
          sendSignInCode(job, sendRequest(byEmail.id, "111111")),
          sendSignInCode(job, sendRequest(byMobile.id, "222222")),
        ]),
      );
      for (const outcome of outcomes) {
        expect(answerErrors("sendSignInCode", outcome)).toEqual([]);
      }
      expect(resultsOf(outcomes)).toEqual(["notSent:dayCap", "sent"]);
      expect(await codesToSam()).toBe(CODES_PER_DAY);
      const rows =
        await db.sql`select 1 from outbox_rows where job_id in ${db.sql([byEmail.id, byMobile.id])}`;
      expect(rows.length).toBe(1);
    },
  );

  it(
    "two parallel sends of one contact at its cap give one code: rule 9's lock on the contact",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      await samAtCodes(CODES_PER_DAY - 1, await secondNow());
      const first = startRequest(SAM_BY_EMAIL);
      const second = startRequest(SAM_BY_EMAIL);
      await started(first);
      await started(second);
      const outcomes = await whileHeld(contactLock(contactHashOf(SAM_BY_EMAIL)), 2, () =>
        Promise.all([
          sendSignInCode(job, sendRequest(first.id, "333333")),
          sendSignInCode(job, sendRequest(second.id, "444444")),
        ]),
      );
      expect(resultsOf(outcomes)).toEqual(["notSent:dayCap", "sent"]);
      expect(await codesToSam()).toBe(CODES_PER_DAY);
    },
  );

  it(
    "read committed: a count read after the handle's lock sees the code its holder committed while it waited",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      const now = await secondNow();
      await samAtCodes(CODES_PER_DAY - 1, now);
      const start = startRequest(SAM_BY_EMAIL);
      await started(start);
      const before = await snapshot();
      // The other send holds the handle's lock and writes the fifth code; this send's earlier statements are read before
      // it commits, and the count after the wait must see it.
      const outcome = await whileHeld(
        async (tx) => {
          await handleLock(SAM_EMAIL_HANDLE)(tx);
          await insertRow(tx, "proof_codes", codeRow("code-t1280-other-send", plus(now, 0)).values);
        },
        1,
        () => sendSignInCode(job, sendRequest(start.id, "555555")),
      );
      expect(outcome).toEqual({ result: "notSent", why: "dayCap" });
      expect(await codesToSam()).toBe(CODES_PER_DAY);
      const after = await snapshot();
      expect({ ...after, proof_codes: null }).toEqual({ ...before, proof_codes: null });
    },
  );

  it(
    "the level is kept: on a session whose default is repeatable read both calls throw and write nothing",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      const start = startRequest(SAM_BY_EMAIL);
      await started(start);
      const before = await snapshot();
      for (const call of [
        () => startSignIn(jobRepeatable, startRequest(SAM_BY_EMAIL)),
        () => sendSignInCode(jobRepeatable, sendRequest(start.id, "666666")),
      ]) {
        const error = await thrownBy(call());
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/runs at read committed only/);
      }
      expect(await snapshot()).toEqual(before);
      const [level] = await job<
        { level: string }[]
      >`select current_setting('transaction_isolation') as level`;
      expect(level?.level).toBe("read committed");
    },
  );

  it(
    "every time is the database's: the one time either call binds is its entries' at, the code's own sent_at as stored",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      sent.length = 0;
      const start = startRequest(SAM_BY_EMAIL);
      await started(start);
      const request = sendRequest(start.id, "482913");
      await sendSignInCode(job, request);
      const [code] = await db.sql<{ sent_ms: Date }[]>`
      select date_trunc('milliseconds', sent_at) as sent_ms from proof_codes where id = ${request.code.id}
    `;
      const times = sent.flatMap((statement) =>
        statement.parameters.filter((parameter): parameter is Date => parameter instanceof Date),
      );
      expect(sent.length).toBeGreaterThan(10);
      expect(times, "three entries, each at the code's sent_at").toEqual([
        code?.sent_ms,
        code?.sent_ms,
        code?.sent_ms,
      ]);
      for (const statement of sent.filter((s) =>
        /^\s*(insert into (sign_in_attempts|proof_codes|outbox_rows)|with win)/.test(s.text),
      )) {
        expect(
          statement.parameters.some((parameter) => parameter instanceof Date),
          statement.text,
        ).toBe(false);
      }
    },
  );

  it(
    "a start's id is a K-08 safe id and never the page's attempt id; refused before any statement",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      const request = startRequest(SAM_BY_EMAIL);
      for (const [overrides, rule] of [
        [{ attemptId: request.id }, /never the page's attempt id/],
        [{ id: "5555550100" }, /id is a K-08 safe id/],
        [{ id: "sign in t1280" }, /id is a K-08 safe id/],
      ] as const) {
        sent.length = 0;
        const error = await thrownBy(startSignIn(job, { ...request, ...overrides }));
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toMatch(rule);
        expect(sent).toEqual([]);
      }
    },
  );
});

// ---- the other answers, the role, and what never leaves -----------------------------------------------------------------

describe("the other answers, the role, and what never leaves", () => {
  it(
    "a link start reads no account and names no person (K-05 item 58 rule 4; K-22 default 15)",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      sent.length = 0;
      const request = startRequest({ kind: "link" });
      const outcome = await startSignIn(job, request);
      expect(answerErrors("startSignIn", outcome)).toEqual([]);
      expect(outcome).toMatchObject({ result: "started", id: request.id, repeated: false, personId: null });
      expect(sent.filter((statement) => /accounts|person_roles/.test(statement.text))).toEqual([]);
    },
  );

  it("answers notFound, attemptExpired, noProvenEmail and codePaused, writing nothing", SLOW, async () => {
    await loadSeeds(SIGN_IN_SEEDS, 0);
    const now = await secondNow();
    await writeRows([
      attemptRow({
        id: "sign-in-t1280-expired",
        startedAt: plus(now, -1200),
        person_id: SAM,
        owner_or_admin: true,
      }),
      attemptRow({ id: "sign-in-t1280-riley", startedAt: plus(now, -60), person_id: RILEY }),
    ]);
    const before = await snapshot();
    expect(await sendSignInCode(job, sendRequest("sign-in-t1280-unknown", "123456"))).toEqual({
      error: "notFound",
      table: "sign_in_attempts",
      rowId: "sign-in-t1280-unknown",
    });
    expect(await sendSignInCode(job, sendRequest("sign-in-t1280-expired", "123456"))).toEqual({
      result: "notSent",
      why: "attemptExpired",
    });
    expect(await sendSignInCode(job, sendRequest("sign-in-t1280-riley", "123456"))).toEqual({
      result: "notSent",
      why: "noProvenEmail",
    });
    expect(await snapshot()).toEqual(before);

    await writeRows([
      codeRow("code-t1280-paused", plus(now, -300), {
        wrong_tries: 5,
        last_wrong_at: plus(now, -60),
        paused_until: plus(now, 14 * 60),
        version: 6,
      }),
    ]);
    const start = startRequest(SAM_BY_EMAIL);
    await started(start);
    const paused = await snapshot();
    const outcome = await sendSignInCode(job, sendRequest(start.id, "123456"));
    expect(answerErrors("sendSignInCode", outcome)).toEqual([]);
    expect(outcome).toEqual({ result: "notSent", why: "codePaused" });
    expect(await snapshot()).toEqual(paused);
  });

  it(
    "answers constraint for an id or a key already taken, or a bundle not in the registry, writing nothing",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      const start = startRequest(SAM_BY_EMAIL);
      await started(start);
      const before = await snapshot();
      expect(await startSignIn(job, { ...startRequest(SAM_BY_EMAIL), attemptId: start.attemptId })).toEqual({
        error: "constraint",
        sqlstate: "23505",
        constraint: "sign_in_attempts_attempt_key",
      });
      const taken = sendRequest(start.id, "123456");
      expect(
        await sendSignInCode(job, { ...taken, code: { ...taken.code, id: "code-sam-sign-in-oct26-email" } }),
      ).toEqual({ error: "constraint", sqlstate: "23505", constraint: "proof_codes_pkey" });
      expect(
        await sendSignInCode(job, {
          ...sendRequest(start.id, "123456"),
          bundle: { hash: hex("no-bundle"), build: 1 },
        }),
      ).toEqual({ error: "constraint", sqlstate: "23503", constraint: "outbox_rows_bundle_fk" });
      expect(await snapshot()).toEqual(before);
    },
  );

  it(
    "the Tool API's role is refused by privilege (no grant on sign_in_attempts), scrubbed of every value",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      const request = startRequest(SAM_BY_EMAIL);
      const before = await snapshot();
      for (const call of [
        () => startSignIn(app, request),
        () => sendSignInCode(app, sendRequest(request.id, "482913")),
      ]) {
        const error = await thrownBy(call());
        expect(error).toBeInstanceOf(DataAccessDatabaseError);
        expect((error as DataAccessDatabaseError).code).toBe("42501");
        const text = JSON.stringify({ message: (error as Error).message, ...(error as object) });
        for (const secret of [request.contactHash, request.requestSha256, SAM_EMAIL, "482913"]) {
          expect(text).not.toContain(secret);
        }
      }
      expect(await snapshot()).toEqual(before);
    },
  );

  it(
    "sends item 58's and 59's statements in their order, in one transaction: rules 0 to 3 read no account, and a start sends the same statements with or without one",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      const texts = (): string[] => sent.map((statement) => statement.text.replace(/\s+/g, " ").trim());
      const order = (statements: string[], markers: readonly RegExp[]): number[] =>
        markers.map((marker) => statements.findIndex((text) => marker.test(text)));

      sent.length = 0;
      const withAccount = startRequest(SAM_BY_EMAIL);
      await started(withAccount);
      const startTexts = texts();
      const connections = new Set(sent.filter((s) => s.text.trim() !== "select 1").map((s) => s.connection));
      expect(connections.size, "one transaction, one connection").toBe(1);
      expect(startTexts.filter((text) => /^(begin|commit)$/.test(text))).toEqual(["begin", "commit"]);
      const startMarkers = [
        /transaction_isolation/,
        /interval '1 hour'/,
        /pg_advisory_xact_lock\(hashtext\('sign_in_attempts:' \|\|/,
        /request_sha256 =/,
        /paused_until > now\(\)/,
        /interval '24 hours'/,
        /from accounts/,
        /^insert into sign_in_attempts/,
      ];
      const startAt = order(startTexts, startMarkers);
      expect(startAt.every((index) => index >= 0)).toBe(true);
      expect([...startAt].sort((a, b) => a - b)).toEqual(startAt);
      const accountAt = startAt[6] ?? -1;
      expect(startTexts.slice(0, accountAt).some((text) => /accounts|person_roles/.test(text))).toBe(false);

      sent.length = 0;
      await started(startRequest({ kind: "email", address: "nobody-order-t1280@example.com" }));
      expect(texts(), "the same statements with no account").toEqual(startTexts);

      sent.length = 0;
      await sendSignInCode(job, sendRequest(withAccount.id, "482913"));
      const sendTexts = texts();
      const sendAt = order(sendTexts, [
        /transaction_isolation/,
        /pg_advisory_xact_lock\(hashtext\('sign_in_attempts:' \|\| a\.contact_hash\)\)/,
        /for update/,
        /from accounts a join handles h/,
        /hashtextextended/,
        /proof_code_limits/,
        /^insert into proof_codes/,
        /^insert into outbox_rows/,
        /^update outbox_rows/,
        /^update sign_in_attempts/,
        /^insert into event_log/,
      ]);
      expect(sendAt.every((index) => index >= 0)).toBe(true);
      expect([...sendAt].sort((a, b) => a - b)).toEqual(sendAt);
    },
  );

  it(
    "never gets a hash back, and no statement, answer, error or log line holds a hash, the contact or the code's words",
    SLOW,
    async () => {
      await loadSeeds(SIGN_IN_SEEDS, 0);
      const logged = [
        vi.spyOn(console, "log").mockImplementation(() => undefined),
        vi.spyOn(console, "info").mockImplementation(() => undefined),
        vi.spyOn(console, "warn").mockImplementation(() => undefined),
        vi.spyOn(console, "error").mockImplementation(() => undefined),
        vi.spyOn(console, "debug").mockImplementation(() => undefined),
      ];
      try {
        sent.length = 0;
        returned.length = 0;
        const start = startRequest(SAM_BY_EMAIL);
        const request = sendRequest(start.id, "482913");
        const answers = [
          await startSignIn(job, start),
          await sendSignInCode(job, request),
          await startSignIn(job, start),
          await sendSignInCode(job, sendRequest(start.id, "730254")),
        ];
        const secrets = [
          start.requestSha256,
          start.deviceSha256,
          start.contactHash,
          SAM_EMAIL,
          request.code.codeHash,
          lineOf("482913"),
          "482913",
        ];
        expect(returned.filter((column) => HASH_COLUMNS.includes(column))).toEqual([]);
        for (const statement of sent) {
          for (const secret of secrets) {
            expect(statement.text).not.toContain(secret);
          }
        }
        for (const secret of secrets) {
          expect(JSON.stringify(answers)).not.toContain(secret);
        }
        const refused = [
          await thrownBy(startSignIn(job, { ...start, contactHash: SAM_EMAIL })),
          await thrownBy(
            startSignIn(job, { ...start, contact: { kind: "email", address: "Sam@Example.com" } }),
          ),
          await thrownBy(sendSignInCode(job, { ...request, code: { ...request.code, codeHash: "482913" } })),
        ];
        for (const error of refused) {
          expect(error).toBeInstanceOf(TypeError);
          for (const secret of [...secrets, "Sam@Example.com"]) {
            expect((error as Error).message).not.toContain(secret);
          }
        }
        expect(logged.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBe(0);
      } finally {
        for (const spy of logged) {
          spy.mockRestore();
        }
      }
    },
  );
});

describe("the role the calls run as", () => {
  it(
    "the clients run as rosie_job, rosie_app and rosie_job at repeatable read, with this file's schema first",
    HEAVY,
    async () => {
      for (const [client, name] of [
        [job, JOB_ROLE],
        [app, APP_ROLE],
        [jobRepeatable, JOB_ROLE],
      ] as const) {
        const [row] = await client<{ who: string; path: string }[]>`
        select current_user as who, current_setting('search_path') as path
      `;
        expect(row?.who).toBe(name);
        expect(row?.path).toBe(`${db.schema}, public`);
      }
    },
  );
});
