// T-1259: K-05 v1.10's readChatHandle (item 51) against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/repo/threads`, which runs threads.int.test.ts too). The schema comes from migrating a
// fresh test schema (db/repo/test-db.ts), which is dropped when the file ends; the public schema is never touched.
//
// The read runs as K-05 v1.10 names it (item 51; README "The calls v1.10 adds"): through a client whose connections run
// as rosie_job, the runtime side's role, with no business scope, so the grants the read meets are rosie_job's; the role
// is the connection's. The tables' owner (the migrations' role) loads the K-04 seeds a fixture's `given` names and
// writes the rows a test adds: read-chat-handle-sam's one noted row, S1-01's thread (its given.note: a row no K-05
// exchange writes), and the threads the cases below add beside the seeds'. Every answer is checked against its
// data-access v1.10 definition with Ajv 2020-12, strict, as contracts:check runs it. Only the fixtures' cast, their
// example addresses and their 555-01xx numbers appear here.
//
// The rosie_job client records every statement it sends (postgres.js debug: its connection, its text and its
// parameters, kept in memory for the checks and never printed), so the checks read what the read sent, not a copy of
// its SQL: its two tables and their columns, no message's words and no column of sealing_keys, and one read-only
// transaction per read.
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolvePrimaryUrl } from "./client";
import { DataAccessDatabaseError } from "./clocks";
import type { Sql, Tx } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";
import { readChatHandle, type ReadChatHandleRequest, type ReadChatHandleResponse } from "./threads";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Row = Record<string, Json>;

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const JOB_ROLE = "rosie_job";
const APP_ROLE = "rosie_app";
const CALL = "readChatHandle";
const SLOW = { timeout: 60_000 };

const SAM_CHAT = "linq-chat-demo-sam";
const ALEX_CHAT = "linq-chat-demo-alex";
const DEE_CHAT = "linq-chat-demo-dee";
const SAM_NUMBER = "+15555550100";
const ALEX_NUMBER = "+15555550101";
const RILEY_NUMBER = "+15555550102";
const ALEX_EMAIL = "alex@example.com";
const HAIRCUT = "booking-alex-haircut";

interface Given {
  k04Seeds: string[];
  after: string[];
  now: string;
  note?: string;
}

/** One of item 51's exchanges, as its fixture holds it. */
interface Exchange {
  call: string;
  given: Given;
  request: ReadChatHandleRequest;
  outcome: unknown;
}

interface SeedRow {
  table: string;
  values: Row;
}

interface SeedFile {
  after: string[];
  rows: SeedRow[];
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
/** Item 51's accepted exchanges, as the index lists them. */
const READ_FIXTURES = INDEX.filter(
  (entry) => entry.expect === "accept" && entry.def === `${CALL}.exchange`,
).map((entry) => entry.file);
/** Its refused twins, each refused by one of its definitions. */
const REFUSED_FIXTURES = INDEX.filter(
  (entry) => entry.expect === "refuse" && entry.def?.startsWith(`${CALL}.`) === true,
);
const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** What a promise was rejected with, or null when it was not. */
async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

// ---- the contract's own schema, for every answer (Ajv 2020-12, strict, as contracts:check runs it) -----------------

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
const V110_ID = (readJson(new URL("data-access/data-access.v1.10.schema.json", CONTRACTS)) as { $id: string })
  .$id;

/** Checks `value` against one $defs entry of data-access v1.10, returning Ajv's errors (none when it passes). */
function schemaErrors(def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${V110_ID}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`data-access v1.10 has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

/** An answer checked against its own definition: an error against readChatHandle.errors, else .response. */
function answerErrors(outcome: unknown): string[] {
  const isError = typeof outcome === "object" && outcome !== null && "error" in outcome;
  return schemaErrors(`${CALL}.${isError ? "errors" : "response"}`, outcome);
}

// ---- databases and clients ------------------------------------------------------------------------------------------

/** One statement a role client sent: its connection, its text and its parameters (in memory only, never printed). */
interface Sent {
  connection: number;
  text: string;
  parameters: readonly unknown[];
}

let db: TestDatabase;
/** Connections that run as rosie_job, the runtime side's role, with this file's schema first; every statement recorded. */
let job: Sql;
/** Connections that run as rosie_app, the Tool API's role, with this file's schema first. */
let app: Sql;
let typedColumns: Map<string, string>;
/** Every base table of this file's schema, in name order. */
let schemaTables: string[];
/** Every table's columns, by table. */
const schemaColumns = new Map<string, Set<string>>();
/** Every statement the rosie_job client sent, in order. */
const sent: Sent[] = [];

function roleClient(role: string, applicationName: string, max: number, record: boolean): Sql {
  return postgres(resolvePrimaryUrl(), {
    max,
    onnotice: () => undefined,
    ...(record
      ? {
          debug: (connection: number, text: string, parameters: unknown[]) => {
            sent.push({ connection, text, parameters: [...parameters] });
          },
        }
      : {}),
    connection: { application_name: applicationName, search_path: `${db.schema}, public`, role },
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "threads_chat_handle" });
  job = roleClient(JOB_ROLE, "rosie-t1259-job", 5, true);
  app = roleClient(APP_ROLE, "rosie-t1259-app", 2, false);
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typedColumns = new Map(typed.map((column) => [column.key, column.type]));
  const tables = await db.sql<{ name: string }[]>`
    select table_name as name from information_schema.tables
    where table_schema = ${db.schema} and table_type = 'BASE TABLE'
    order by table_name
  `;
  schemaTables = tables.map((table) => table.name);
  const columns = await db.sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name from information_schema.columns where table_schema = ${db.schema}
  `;
  for (const column of columns) {
    const ofTable = schemaColumns.get(column.table_name) ?? new Set<string>();
    schemaColumns.set(column.table_name, ofTable.add(column.column_name));
  }
}, 60_000);

afterAll(async () => {
  await job.end({ timeout: 5 });
  await app.end({ timeout: 5 });
  await db.drop();
});

/** Empties every table and restarts its identity (truncating the heads cascades to the rest; this file's schema only). */
async function reset(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags restart identity cascade`;
}

async function insertRow(sql: Db, table: string, row: Row): Promise<void> {
  const values: Record<string, never> = {};
  for (const [column, value] of Object.entries(row)) {
    const type = typedColumns.get(`${table}.${column}`);
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

/** A K-04 seed file's rows after those of its `after` chain, each file once. */
function seedRows(file: string, seen: Set<string>): SeedRow[] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const seed = readJson(new URL(file, CORE_DIR)) as SeedFile;
  return [...seed.after.flatMap((before) => seedRows(before, seen)), ...seed.rows];
}

/** A thread of kind chat, at version 1. */
const chatThread = (id: string, handleId: string, linqChatId: string): Row => ({
  id,
  handle_id: handleId,
  kind: "chat",
  booking_id: null,
  linq_chat_id: linqChatId,
  reply_address: null,
  version: 1,
});

/** A thread of kind email, the haircut's, at version 1, holding a chat id (threads_chat_or_email leaves it free). */
const emailThread = (id: string, handleId: string, linqChatId: string, replyAddress: string): Row => ({
  id,
  handle_id: handleId,
  kind: "email",
  booking_id: HAIRCUT,
  linq_chat_id: linqChatId,
  reply_address: replyAddress,
  version: 1,
});

/** read-chat-handle-sam's one noted row (its given.note): S1-01's thread, which turn 1's commit writes. */
const S1_01_THREAD = chatThread("thread-s1-01-sam-1", "handle-sam", SAM_CHAT);

/** The rows a fixture's note says its database side writes before the read. */
const NOTED_ROWS: Readonly<Record<string, readonly SeedRow[]>> = {
  "read-chat-handle-sam.json": [{ table: "threads", values: S1_01_THREAD }],
};

/**
 * Loads a fixture's K-04 seeds and, unless `noted` is false, the rows its note writes. Item 51's fixtures run no
 * exchange first (their `after` is empty).
 */
async function given(file: string, noted = true): Promise<Exchange> {
  const exchange = exchangeOf(file);
  if (exchange.given.after.length > 0) {
    throw new Error(`${file}: this test runs no exchange before item 51's`);
  }
  await reset();
  const seen = new Set<string>();
  const rows = exchange.given.k04Seeds.flatMap((seed) => seedRows(seed, seen));
  if (noted) {
    rows.push(...(NOTED_ROWS[file] ?? []));
  }
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
    }
  });
  return exchange;
}

/** Every base table's row count and content, as the owner reads it: equal before and after means nothing was written. */
async function fingerprint(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of schemaTables) {
    const [row] = await db.sql<{ n: number; digest: string }[]>`
      select count(*)::int as n, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest
      from ${db.sql(table)} t
    `;
    out[table] = `${String(row?.n)} rows, ${row?.digest ?? ""}`;
  }
  return out;
}

// ---- the threads the cases add beside read-chat-handle-alex's seeds and S1-01's thread ------------------------------

const RILEY_CHAT = "linq-chat-t1259-riley";
const EMAIL_THREAD_OF_PHONE = "linq-chat-t1259-email-of-phone";
const EMAIL_THREAD_OF_EMAIL = "linq-chat-t1259-email-of-email";
const APPLE_ID_CHAT = "linq-chat-t1259-apple-id";

/** A chat thread of Alex's email handle: an Apple ID email that texts by iMessage (open-chat-apple-id-email). */
const APPLE_ID_THREAD = chatThread("thread-t1259-apple-id-chat", "handle-alex-email", APPLE_ID_CHAT);

const ADDED_THREADS: readonly Row[] = [
  // Riley's chat, a phone: the answer is the thread's own handle, whichever it is.
  chatThread("thread-t1259-riley-chat", "handle-riley", RILEY_CHAT),
  // A thread of kind email that holds a chat id, of Alex's phone handle: read as a chat, it would give his number.
  emailThread(
    "thread-t1259-email-of-phone",
    "handle-alex",
    EMAIL_THREAD_OF_PHONE,
    "booking-alex-haircut-t1259a@reply.example.com",
  ),
  // A thread of kind email that holds a chat id, of Alex's email handle.
  emailThread(
    "thread-t1259-email-of-email",
    "handle-alex-email",
    EMAIL_THREAD_OF_EMAIL,
    "booking-alex-haircut-t1259b@reply.example.com",
  ),
  APPLE_ID_THREAD,
];

/** read-chat-handle-alex's seeds, then S1-01's thread and the threads above. */
async function givenChatRows(): Promise<void> {
  await given("read-chat-handle-alex.json");
  await db.sql.begin(async (tx) => {
    for (const row of [S1_01_THREAD, ...ADDED_THREADS]) {
      await insertRow(tx, "threads", row);
    }
  });
}

/** One chat id a read is asked about, what it shows, the handle its second statement reads, and its answer. */
interface ChatCase {
  chatId: string;
  shows: string;
  /** The handle id the read's second statement binds, or null when it reads no handle. */
  handleRead: string | null;
  answer: ReadChatHandleResponse;
}

const NONE: ReadChatHandleResponse = { handleId: null, handle: null };
const phoneOf = (handleId: string, address: string): ReadChatHandleResponse => ({
  handleId,
  handle: { kind: "phone", address },
});

/** Every chat id asked about once givenChatRows has run; the fixtures' three among them, as their own rows answer. */
const CASES: readonly ChatCase[] = [
  {
    chatId: SAM_CHAT,
    shows: "S1-01's chat, Sam's phone",
    handleRead: "handle-sam",
    answer: phoneOf("handle-sam", SAM_NUMBER),
  },
  {
    chatId: ALEX_CHAT,
    shows: "Alex's chat, his phone",
    handleRead: "handle-alex",
    answer: phoneOf("handle-alex", ALEX_NUMBER),
  },
  {
    chatId: RILEY_CHAT,
    shows: "Riley's chat, a phone",
    handleRead: "handle-riley",
    answer: phoneOf("handle-riley", RILEY_NUMBER),
  },
  { chatId: DEE_CHAT, shows: "a chat no thread holds", handleRead: null, answer: NONE },
  {
    chatId: EMAIL_THREAD_OF_PHONE,
    shows: "a thread of kind email of a phone handle",
    handleRead: null,
    answer: NONE,
  },
  {
    chatId: EMAIL_THREAD_OF_EMAIL,
    shows: "a thread of kind email of an email handle",
    handleRead: null,
    answer: NONE,
  },
  {
    chatId: APPLE_ID_CHAT,
    shows: "a chat thread of an email handle",
    handleRead: "handle-alex-email",
    answer: NONE,
  },
  { chatId: "LINQ-CHAT-DEMO-ALEX", shows: "Alex's chat id in capitals", handleRead: null, answer: NONE },
  { chatId: `${ALEX_CHAT} `, shows: "a space after Alex's chat id", handleRead: null, answer: NONE },
  { chatId: ` ${ALEX_CHAT}`, shows: "a space before Alex's chat id", handleRead: null, answer: NONE },
];

function caseOf(chatId: string): ChatCase {
  const found = CASES.find((chatCase) => chatCase.chatId === chatId);
  if (found === undefined) {
    throw new Error("a chat id no case lists");
  }
  return found;
}

/** Runs `read` with every console method watched; answers the outcome or the error, and how often anything was logged. */
async function unlogged(read: () => Promise<unknown>): Promise<{ outcome: unknown; logged: number }> {
  const spies = [
    vi.spyOn(console, "log").mockImplementation(() => undefined),
    vi.spyOn(console, "info").mockImplementation(() => undefined),
    vi.spyOn(console, "warn").mockImplementation(() => undefined),
    vi.spyOn(console, "error").mockImplementation(() => undefined),
    vi.spyOn(console, "debug").mockImplementation(() => undefined),
    vi.spyOn(console, "trace").mockImplementation(() => undefined),
  ];
  try {
    let outcome: unknown;
    try {
      outcome = await read();
    } catch (error) {
      outcome = error;
    }
    return { outcome, logged: spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0) };
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
}

/** One read run: its chat id, what it sent, its answer, and how often anything was logged. */
interface Run {
  chatId: string;
  statements: Sent[];
  outcome: unknown;
  logged: number;
}

/** Runs one read on the rosie_job client, keeping the statements it sent. */
async function watched(chatId: string): Promise<Run> {
  sent.length = 0;
  const { outcome, logged } = await unlogged(() => readChatHandle(job, { linqChatId: chatId }));
  return { chatId, statements: [...sent], outcome, logged };
}

/** Every read over each fixture's own rows, then over givenChatRows's, each with what it sent. */
async function everyRun(): Promise<Run[]> {
  const runs: Run[] = [];
  for (const file of READ_FIXTURES) {
    const exchange = await given(file);
    runs.push(await watched(exchange.request.linqChatId));
  }
  await givenChatRows();
  for (const chatCase of CASES) {
    runs.push(await watched(chatCase.chatId));
  }
  return runs;
}

// ---- the statements the read sends --------------------------------------------------------------------------------

/** The read's first statement: the thread by its chat id, its kind and its handle alone (item 51). */
const THREAD_STATEMENT = "select kind, handle_id from threads where linq_chat_id = $1";
/** Its second, for a thread of kind chat alone: the handle by its key, its kind and its address alone (item 51). */
const HANDLE_STATEMENT = "select kind, address from handles where id = $1";
/** The read's two tables, and no others. */
const OWN_TABLES: ReadonlySet<string> = new Set(["handles", "threads"]);
/** The read's columns of its two tables, and no others. */
const OWN_COLUMNS: ReadonlySet<string> = new Set(["address", "handle_id", "id", "kind", "linq_chat_id"]);

/**
 * Never named by a statement of the read (the card's security review; README v1.10 "What the new tasks must hold to"):
 * a visit's address and its zone (K-30's booking_addresses), a message's words (messages.words and every other table's
 * words, sealed words or plan), sealing_keys, and the thread's booking, reply address and version. The columns of
 * sealing_keys no table of the read has are added below; the table itself is never named, so no column of it can be.
 */
const NEVER_NAMED_BASE = [
  "booking_addresses",
  "zone",
  "messages",
  "words",
  "sealed_words",
  "sealed_values",
  "sealed_details",
  "plan",
  "final_parts",
  "sealing_keys",
  "booking_id",
  "reply_address",
  "version",
];

/** Functions that turn a whole row into a value. */
const WHOLE_ROW_FUNCTIONS = new Set([
  "to_json",
  "to_jsonb",
  "row_to_json",
  "json_agg",
  "jsonb_agg",
  "json_object_agg",
  "jsonb_object_agg",
  "array_agg",
  "jsonb_populate_record",
  "hstore",
  "row",
]);

/** Words that may follow a table in FROM or JOIN without being its alias. */
const NOT_AN_ALIAS = new Set([
  "where",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "natural",
  "on",
  "using",
  "order",
  "group",
  "having",
  "limit",
  "offset",
  "fetch",
  "for",
  "union",
  "except",
  "intersect",
  "window",
  "returning",
  "tablesample",
]);

/** What no answer may hold: anything of the thread, its booking, its people or the handle's address but its number. */
const NEVER_ANSWERED = [
  "thread-",
  "linq-chat",
  "booking-",
  "reply.example.com",
  "person-",
  "biz-",
  "Sam Lee",
  "Alex M.",
  "handle-alex-email",
  ALEX_EMAIL,
];

/** A statement's tokens: comments, string literals and collations dropped, quoted names unquoted, lower case. */
function tokensOf(statement: string): string[] {
  return (
    statement
      .replace(/--[^\n]*/g, " ")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/'(?:[^']|'')*'/g, " ")
      .replace(/collate\s+"[^"]*"/gi, " ")
      .replaceAll('"', "")
      .toLowerCase()
      .match(/[a-z_][a-z0-9_$]*|\$\d+|\d+|[^\s\w]/g) ?? []
  );
}

const isTable = (token: string): boolean => schemaColumns.has(token);
const isName = (token: string | undefined): token is string =>
  token !== undefined && /^[a-z_][a-z0-9_$]*$/.test(token);

/** Every table of this file's schema a statement names, wherever it names it. */
function tablesOf(statement: string): string[] {
  return tokensOf(statement).filter(isTable);
}

/** A table a statement reads after FROM or JOIN, its alias (null with none), and the tokens that declare them. */
interface Declaration {
  table: string;
  alias: string | null;
  places: number[];
}

/** The tables a statement reads, each where FROM or JOIN declares it. */
function declarationsOf(tokens: readonly string[]): Declaration[] {
  const declarations: Declaration[] = [];
  tokens.forEach((token, index) => {
    const table = tokens[index + 1];
    // `is [not] distinct from x` compares; a function or a subquery after FROM or JOIN is no table.
    if ((token !== "from" && token !== "join") || tokens[index - 1] === "distinct") {
      return;
    }
    if (!isName(table) || tokens[index + 2] === "(") {
      return;
    }
    const aliasAt = tokens[index + 2] === "as" ? index + 3 : index + 2;
    const alias = tokens[aliasAt];
    if (isName(alias) && !NOT_AN_ALIAS.has(alias)) {
      declarations.push({ table, alias, places: [index + 1, aliasAt] });
    } else {
      declarations.push({ table, alias: null, places: [index + 1] });
    }
  });
  return declarations;
}

/** Every column of the read's two tables, whether the read may name it or not. */
function ownTablesColumns(): Set<string> {
  return new Set([...OWN_TABLES].flatMap((table) => [...(schemaColumns.get(table) ?? [])]));
}

/** Never named by the read's statements: the base list and every column of sealing_keys no table of the read has. */
function neverNamed(): Set<string> {
  const own = ownTablesColumns();
  const keyColumns = [...(schemaColumns.get("sealing_keys") ?? [])].filter((column) => !own.has(column));
  return new Set([...NEVER_NAMED_BASE, ...keyColumns]);
}

/**
 * What is wrong with one statement of the read: a name never named, `*`, a whole row (a function that takes one, or a
 * table or alias not followed by one of its columns), a table beyond its two, or a column of its tables beyond its list.
 */
function problemsOf(statement: string): string[] {
  const never = neverNamed();
  const ownColumns = ownTablesColumns();
  const tokens = tokensOf(statement);
  const declarations = declarationsOf(tokens);
  const declared = new Set<string>();
  const places = new Set<number>();
  for (const declaration of declarations) {
    declared.add(declaration.table).add(declaration.alias ?? declaration.table);
    for (const place of declaration.places) {
      places.add(place);
    }
  }
  const problems: string[] = [];
  tokens.forEach((token, index) => {
    const next = tokens[index + 1];
    if (never.has(token)) {
      problems.push(`never named: ${token}`);
    }
    if (token === "*") {
      problems.push("*");
    }
    if (WHOLE_ROW_FUNCTIONS.has(token) && next === "(") {
      problems.push(`a whole row: ${token}()`);
    }
    if ((declared.has(token) || isTable(token)) && !places.has(index) && next !== ".") {
      problems.push(`a whole row: ${token}`);
    }
    if (isTable(token) && !OWN_TABLES.has(token)) {
      problems.push(`a table beyond its own: ${token}`);
    }
    if (ownColumns.has(token) && !OWN_COLUMNS.has(token)) {
      problems.push(`a column beyond its own: ${token}`);
    }
  });
  return problems;
}

const normalized = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The statements of a run that name a table. */
const readingOf = (run: Run): Sent[] =>
  run.statements.filter((statement) => tablesOf(statement.text).length > 0);

/** The table statements a case's read sends: the thread's, then, for a chat thread, its handle's. */
const expectedStatements = (chatCase: ChatCase): string[] =>
  chatCase.handleRead === null ? [THREAD_STATEMENT] : [THREAD_STATEMENT, HANDLE_STATEMENT];

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("the role the read runs as (K-05 v1.10 item 51; T-191)", () => {
  it("the two clients run as rosie_job and rosie_app, with this file's schema first and no business scope", async () => {
    for (const [client, role] of [
      [job, JOB_ROLE],
      [app, APP_ROLE],
    ] as const) {
      const [row] = await client<{ who: string; path: string; scope: string | null }[]>`
        select current_user as who, current_setting('search_path') as path,
               current_setting('rosie.business_id', true) as scope
      `;
      expect(row?.who).toBe(role);
      expect(row?.path).toBe(`${db.schema}, public`);
      expect(row?.scope ?? "").toBe("");
    }
  });

  it(
    "a Tool API client's readChatHandle is refused by PostgreSQL's own privilege check (no grant on threads: 0012), naming no value",
    SLOW,
    async () => {
      await given("read-chat-handle-alex.json");
      const error = await thrownBy(readChatHandle(app, { linqChatId: ALEX_CHAT }));
      expect(error).toBeInstanceOf(DataAccessDatabaseError);
      expect((error as DataAccessDatabaseError).code).toBe("42501");
      const text = (error as Error).message;
      expect(text).toContain(`${CALL}: the database refused the call (SQLSTATE 42501`);
      for (const value of [ALEX_CHAT, ALEX_NUMBER, "handle-alex", "thread-alex-chat"]) {
        expect(text.includes(value), value).toBe(false);
      }
    },
  );
});

describe("each v1.10 fixture of item 51 gives its outcome (K-05 v1.10 item 51)", () => {
  it("the index lists the read's three exchanges, each valid against data-access v1.10, and its refused twin, refused", () => {
    expect([...READ_FIXTURES].sort()).toEqual([
      "read-chat-handle-alex.json",
      "read-chat-handle-sam.json",
      "read-chat-handle-unknown.json",
    ]);
    for (const file of READ_FIXTURES) {
      const exchange = exchangeOf(file);
      expect(exchange.call, file).toBe(CALL);
      expect(schemaErrors(`${CALL}.exchange`, exchange), file).toEqual([]);
    }
    expect(REFUSED_FIXTURES.map((entry) => `${entry.file} by ${entry.def ?? ""}`)).toEqual([
      "invalid/refuse-chat-handle-email.json by readChatHandle.response",
    ]);
    for (const entry of REFUSED_FIXTURES) {
      const value = readJson(new URL(entry.file, ACCESS_DIR));
      expect(schemaErrors(entry.def ?? "", value), entry.file).not.toEqual([]);
    }
  });

  for (const file of READ_FIXTURES) {
    it(
      `${file}: as rosie_job, the read answers the fixture's outcome, valid against readChatHandle.response`,
      SLOW,
      async () => {
        const exchange = await given(file);
        const outcome = await readChatHandle(job, exchange.request);
        expect(outcome).toEqual(exchange.outcome);
        expect(answerErrors(outcome)).toEqual([]);
      },
    );
  }

  it(
    "read-chat-handle-sam: before S1-01's thread is written no thread holds the chat, so the same request answers both fields null (open gap 48)",
    SLOW,
    async () => {
      const exchange = await given("read-chat-handle-sam.json", false);
      const [found] = await db.sql<{ n: number }[]>`
        select count(*)::int as n from threads where linq_chat_id = ${SAM_CHAT}
      `;
      expect(found?.n).toBe(0);
      const outcome = await readChatHandle(job, exchange.request);
      expect(outcome).toEqual(NONE);
      expect(answerErrors(outcome)).toEqual([]);
    },
  );

  it(
    "refuse-chat-handle-email: Alex's chat answers his phone handle, read-chat-handle-alex's outcome, never his email handle; a chat thread of that email handle answers both fields null",
    SLOW,
    async () => {
      const twin = await given("read-chat-handle-alex.json");
      const refused = readJson(new URL("invalid/refuse-chat-handle-email.json", ACCESS_DIR));
      expect(refused).toEqual({
        handleId: "handle-alex-email",
        handle: { kind: "email", address: ALEX_EMAIL },
      });
      const outcome = await readChatHandle(job, twin.request);
      expect(outcome).toEqual(twin.outcome);
      expect(outcome).not.toEqual(refused);
      await insertRow(db.sql, "threads", APPLE_ID_THREAD);
      const apple = await readChatHandle(job, { linqChatId: APPLE_ID_CHAT });
      expect(apple).toEqual(NONE);
      expect(answerErrors(apple)).toEqual([]);
    },
  );
});

describe("readChatHandle: a chat names a number only through a chat thread of a phone handle (item 51; defaults 94 and 95)", () => {
  it(
    "each chat id answers as listed, valid against readChatHandle.response: the chat thread's own phone handle, its id and its number, else both fields null",
    SLOW,
    async () => {
      await givenChatRows();
      for (const chatCase of CASES) {
        const outcome = await readChatHandle(job, { linqChatId: chatCase.chatId });
        expect(outcome, chatCase.shows).toEqual(chatCase.answer);
        expect(answerErrors(outcome), chatCase.shows).toEqual([]);
      }
    },
  );

  it(
    "a thread of kind email that holds a chat id answers both fields null, of a phone handle and of an email handle, and its handle is never read (default 1)",
    SLOW,
    async () => {
      await givenChatRows();
      const [phone] = await db.sql<{ kind: string }[]>`
        select h.kind from threads t join handles h on h.id = t.handle_id where t.linq_chat_id = ${EMAIL_THREAD_OF_PHONE}
      `;
      expect(phone?.kind).toBe("phone");
      for (const chatId of [EMAIL_THREAD_OF_PHONE, EMAIL_THREAD_OF_EMAIL]) {
        const run = await watched(chatId);
        expect(run.outcome, chatId).toEqual(NONE);
        expect(answerErrors(run.outcome), chatId).toEqual([]);
        expect(
          readingOf(run).map((statement) => normalized(statement.text)),
          chatId,
        ).toEqual([THREAD_STATEMENT]);
      }
    },
  );

  it(
    "a chat thread of an email handle answers both fields null: the handle is read by its id, and its address is never answered",
    SLOW,
    async () => {
      await givenChatRows();
      const run = await watched(APPLE_ID_CHAT);
      expect(run.outcome).toEqual(NONE);
      expect(answerErrors(run.outcome)).toEqual([]);
      const reading = readingOf(run);
      expect(reading.map((statement) => normalized(statement.text))).toEqual([
        THREAD_STATEMENT,
        HANDLE_STATEMENT,
      ]);
      expect(reading[1]?.parameters).toEqual(["handle-alex-email"]);
      expect(JSON.stringify(run.outcome).includes(ALEX_EMAIL)).toBe(false);
    },
  );

  it(
    "the chat id is compared as a whole, byte by byte, never parsed: in capitals, or with a space before or after it, it names no thread",
    SLOW,
    async () => {
      await givenChatRows();
      for (const chatId of ["LINQ-CHAT-DEMO-ALEX", `${ALEX_CHAT} `, ` ${ALEX_CHAT}`]) {
        const outcome = await readChatHandle(job, { linqChatId: chatId });
        expect(outcome, caseOf(chatId).shows).toEqual(NONE);
      }
      expect(await readChatHandle(job, { linqChatId: ALEX_CHAT })).toEqual(caseOf(ALEX_CHAT).answer);
    },
  );

  it(
    "a chat thread whose handle row the read cannot see answers both fields null, never a guessed handle (default 2)",
    SLOW,
    async () => {
      await givenChatRows();
      // threads_handle_fk keeps the row, so a policy of this file's schema hides Alex's handle from rosie_job alone,
      // and is dropped after.
      const schema = `"${db.schema}"`;
      try {
        await db.sql.unsafe(`alter table ${schema}.handles enable row level security`);
        await db.sql.unsafe(
          `create policy t_hide_alex on ${schema}.handles for select to ${JOB_ROLE} using (id <> 'handle-alex')`,
        );
        const run = await watched(ALEX_CHAT);
        expect(run.outcome).toEqual(NONE);
        expect(answerErrors(run.outcome)).toEqual([]);
        expect(readingOf(run).map((statement) => normalized(statement.text))).toEqual([
          THREAD_STATEMENT,
          HANDLE_STATEMENT,
        ]);
        expect(await readChatHandle(job, { linqChatId: SAM_CHAT })).toEqual(caseOf(SAM_CHAT).answer);
      } finally {
        await db.sql.unsafe(`drop policy if exists t_hide_alex on ${schema}.handles`);
        await db.sql.unsafe(`alter table ${schema}.handles disable row level security`);
      }
      expect(await readChatHandle(job, { linqChatId: ALEX_CHAT })).toEqual(caseOf(ALEX_CHAT).answer);
    },
  );

  it(
    "a request of the wrong shape is refused before any statement, naming the field, never a value",
    SLOW,
    async () => {
      await given("read-chat-handle-alex.json");
      const notAnId = "readChatHandle: linqChatId is a non-empty id";
      const onlyTheChat = "readChatHandle: the request takes only linqChatId";
      const notAnObject = "readChatHandle: the request is an object";
      const refused: [unknown, string][] = [
        [{}, "readChatHandle: the request needs linqChatId"],
        [{ linqChatId: "" }, notAnId],
        [{ linqChatId: 7 }, notAnId],
        [{ linqChatId: `${ALEX_CHAT}\u0000` }, notAnId],
        [{ linqChatId: ALEX_CHAT, handleId: "handle-alex" }, onlyTheChat],
        [{ linqChatId: ALEX_CHAT, number: ALEX_NUMBER }, onlyTheChat],
        [null, notAnObject],
        [[ALEX_CHAT], notAnObject],
      ];
      for (const [request, message] of refused) {
        sent.length = 0;
        const error = await thrownBy(readChatHandle(job, request as ReadChatHandleRequest));
        expect(error, message).toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe(message);
        for (const value of [ALEX_CHAT, ALEX_NUMBER, "handle-alex"]) {
          expect((error as Error).message.includes(value), value).toBe(false);
        }
        expect(sent).toEqual([]);
      }
    },
  );
});

describe("one read-only transaction per read, and nothing written (item 51: 'writes nothing')", () => {
  it(
    "each read sends its statements on one connection inside one 'begin isolation level repeatable read read only', ending in commit; inside it, after the scope is cleared, the thread by its chat id, then, for a chat thread alone, its handle by its id",
    SLOW,
    async () => {
      for (const run of await everyRun()) {
        const chatCase = caseOf(run.chatId);
        const label = chatCase.shows;
        const begins = run.statements.filter((statement) => statement.text.startsWith("begin"));
        expect(
          begins.map((statement) => statement.text),
          label,
        ).toEqual(["begin isolation level repeatable read read only"]);
        const begin = run.statements.findIndex((statement) => statement.text.startsWith("begin"));
        const connection = run.statements[begin]?.connection;
        const inside = run.statements.slice(begin + 1);
        const end = inside.findIndex(
          (statement) => statement.text === "commit" || statement.text === "rollback",
        );
        expect(end, label).toBeGreaterThan(0);
        expect(inside[end]?.text, label).toBe("commit");
        // targets.ts inRuntimeTransaction clears the business scope first; then the read sends its item's reads alone
        // (no check of the role it runs as: the role is the connection's).
        expect(
          inside.slice(0, end).map((statement) => normalized(statement.text)),
          label,
        ).toEqual(["select set_config($1, '', true)", ...expectedStatements(chatCase)]);
        for (const statement of inside.slice(0, end + 1)) {
          expect(statement.connection, label).toBe(connection);
        }
        for (const [at, statement] of run.statements.entries()) {
          if (tablesOf(statement.text).length > 0) {
            expect(at, label).toBeGreaterThan(begin);
            expect(at, label).toBeLessThan(begin + 1 + end);
          }
        }
      }
    },
  );

  it(
    "a write inside the read's own transaction is refused (25006, thrown scrubbed) and leaves nothing, at the thread's read and at the handle's; the same write goes through in a transaction that allows it",
    SLOW,
    async () => {
      await given("read-chat-handle-alex.json");
      // A probe that writes whenever a row of the table is read as rosie_job: a policy's function.
      const schema = `"${db.schema}"`;
      const probe = `${schema}.t_write_probe`;
      const probeOf = `${schema}.t_write_probe_of`;
      const probeRows = async (): Promise<number> => {
        const [row] = await db.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${probe}`);
        return row?.n ?? -1;
      };
      await db.sql.unsafe(`create table ${probe} (n integer not null)`);
      await db.sql.unsafe(`grant select, insert on ${probe} to ${JOB_ROLE}`);
      await db.sql.unsafe(
        `create function ${probeOf}() returns boolean language plpgsql volatile as $probe$ ` +
          `begin insert into ${probe} (n) values (1); return true; end $probe$`,
      );
      const reads: [string, string][] = [
        ["threads", `select kind from threads where linq_chat_id = '${ALEX_CHAT}'`],
        ["handles", "select kind from handles where id = 'handle-alex'"],
      ];
      try {
        for (const [table, read] of reads) {
          try {
            await db.sql.unsafe(`alter table ${schema}.${table} enable row level security`);
            await db.sql.unsafe(
              `create policy t_write_probe on ${schema}.${table} for select to ${JOB_ROLE} using (${probeOf}())`,
            );
            // In a transaction that may write, the probe writes when the table is read.
            await job.begin(async (tx) => {
              await tx.unsafe(read);
            });
            expect(await probeRows(), table).toBeGreaterThan(0);
            await db.sql.unsafe(`truncate ${probe}`);
            const before = await fingerprint();
            // In the read's own transaction the same write is refused, so the read answers nothing and writes nothing.
            const run = await watched(ALEX_CHAT);
            expect(run.outcome, table).toBeInstanceOf(DataAccessDatabaseError);
            expect((run.outcome as DataAccessDatabaseError).code, table).toBe("25006");
            expect((run.outcome as Error).message, table).toContain(
              `${CALL}: the database refused the call (SQLSTATE 25006`,
            );
            expect(run.logged, table).toBe(0);
            expect(
              readingOf(run).map((statement) => normalized(statement.text)),
              table,
            ).toEqual(table === "threads" ? [THREAD_STATEMENT] : [THREAD_STATEMENT, HANDLE_STATEMENT]);
            expect(
              run.statements.map((statement) => statement.text),
              table,
            ).toContain("rollback");
            expect(await probeRows(), table).toBe(0);
            expect(await fingerprint(), table).toEqual(before);
          } finally {
            await db.sql.unsafe(`drop policy if exists t_write_probe on ${schema}.${table}`);
            await db.sql.unsafe(`alter table ${schema}.${table} disable row level security`);
          }
        }
      } finally {
        await db.sql.unsafe(`drop function if exists ${probeOf}()`);
        await db.sql.unsafe(`drop table if exists ${probe}`);
      }
      expect(await readChatHandle(job, { linqChatId: ALEX_CHAT })).toEqual(caseOf(ALEX_CHAT).answer);
    },
  );

  it(
    "nothing is written: every table's row count and content are the same before and after every read, the refused and the thrown among them",
    SLOW,
    async () => {
      await givenChatRows();
      const before = await fingerprint();
      for (const chatCase of CASES) {
        await thrownBy(readChatHandle(job, { linqChatId: chatCase.chatId }));
      }
      await thrownBy(readChatHandle(job, {} as ReadChatHandleRequest));
      await thrownBy(readChatHandle(app, { linqChatId: ALEX_CHAT }));
      expect(await fingerprint()).toEqual(before);
      // Alex's two threads, S1-01's and the four added.
      expect(before.threads).toMatch(/^7 rows, /);
    },
  );
});

describe("no statement names a message's words or any column of sealing_keys (item 51; the card's security review)", () => {
  it("the check refuses a whole row, a stray table or column, a visit's address, words, a key and the thread's booking, reply address or version (shown on statements made to fail)", () => {
    const caught: { statement: string; problems: string[] }[] = [
      {
        statement: "select a.address, a.zone from booking_addresses a where a.booking_id = $1",
        problems: [
          "never named: booking_addresses",
          "never named: zone",
          "a table beyond its own: booking_addresses",
        ],
      },
      {
        statement: "select m.words from messages m where m.thread_id = $1",
        problems: ["never named: words", "never named: messages", "a table beyond its own: messages"],
      },
      {
        statement: 'select k.wrapped_key, k.wrapping_key_name from "sealing_keys" k where k.person_id = $1',
        problems: [
          "never named: wrapped_key",
          "never named: wrapping_key_name",
          "never named: sealing_keys",
          "never named: person_id",
          "a table beyond its own: sealing_keys",
        ],
      },
      {
        statement: "select booking_id, reply_address, version from threads where linq_chat_id = $1",
        problems: [
          "never named: booking_id",
          "never named: reply_address",
          "never named: version",
          "a column beyond its own: booking_id",
          "a column beyond its own: reply_address",
          "a column beyond its own: version",
        ],
      },
      {
        statement: "select * from threads where linq_chat_id = $1",
        problems: ["*"],
      },
      {
        statement: "select to_jsonb(t) from threads t where t.linq_chat_id = $1",
        problems: ["a whole row: to_jsonb()", "a whole row: t"],
      },
      {
        statement:
          "select h.kind, h.address, p.number from handles h join phones p on p.handle_id = h.id where h.id = $1",
        problems: ["a table beyond its own: phones"],
      },
      {
        statement:
          "select t.handle_id, m.words from threads t join messages m on m.thread_id = t.id where t.linq_chat_id = $1",
        problems: ["never named: words", "never named: messages", "a table beyond its own: messages"],
      },
    ];
    for (const { statement, problems } of caught) {
      const found = problemsOf(statement);
      for (const problem of problems) {
        expect(found, statement).toContain(problem);
      }
    }
    // A thread's id, or the handle read with the thread in one statement, is not the read's own statement.
    for (const statement of [
      "select id, kind, handle_id from threads where linq_chat_id = $1",
      "select t.kind, h.kind, h.address from threads t join handles h on h.id = t.handle_id where t.linq_chat_id = $1",
    ]) {
      expect(problemsOf(statement), statement).toEqual([]);
      expect([THREAD_STATEMENT, HANDLE_STATEMENT]).not.toContain(normalized(statement));
    }
    // The read's own two statements pass.
    for (const statement of [THREAD_STATEMENT, HANDLE_STATEMENT]) {
      expect(problemsOf(statement), statement).toEqual([]);
    }
  });

  it(
    "every statement the read sends, over every case, names only threads' kind, handle_id and linq_chat_id and handles' id, kind and address, and none never named; each binds the chat id or the thread's handle; nothing is logged; no answer holds the chat id or anything but a phone handle's id and number",
    SLOW,
    async () => {
      const runs = await everyRun();
      expect(runs).toHaveLength(READ_FIXTURES.length + CASES.length);
      for (const run of runs) {
        const chatCase = caseOf(run.chatId);
        const label = chatCase.shows;
        expect(run.logged, label).toBe(0);
        for (const statement of run.statements) {
          expect(problemsOf(statement.text), `${label}: ${statement.text}`).toEqual([]);
        }
        const reading = readingOf(run);
        expect(
          reading.map((statement) => normalized(statement.text)),
          label,
        ).toEqual(expectedStatements(chatCase));
        expect(reading[0]?.parameters, label).toEqual([run.chatId]);
        if (chatCase.handleRead !== null) {
          expect(reading[1]?.parameters, label).toEqual([chatCase.handleRead]);
        }
        expect(run.outcome, label).toEqual(chatCase.answer);
        expect(answerErrors(run.outcome), label).toEqual([]);
        const text = JSON.stringify(run.outcome);
        for (const value of [run.chatId, ...NEVER_ANSWERED]) {
          expect(text.includes(value), `${label}: ${value}`).toBe(false);
        }
      }
      // Over every case the read named both its tables and all of its columns, and no other.
      const statements = runs.flatMap((run) => run.statements.map((statement) => statement.text));
      expect([...new Set(statements.flatMap(tablesOf))].sort()).toEqual([...OWN_TABLES].sort());
      const ownColumns = ownTablesColumns();
      const columns = statements.flatMap((statement) =>
        tokensOf(statement).filter((token) => ownColumns.has(token)),
      );
      expect([...new Set(columns)].sort()).toEqual([...OWN_COLUMNS].sort());
    },
  );
});

describe("a lost connection answers transient, with no number, chat id or connection string (K-05 transientError)", () => {
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** The backend of `applicationName` once it waits on a lock, polling every 20 ms for at most 20 s. */
  async function lockWaiter(applicationName: string): Promise<number> {
    for (let tries = 0; tries < 1000; tries += 1) {
      const [row] = await db.sql<{ pid: number }[]>`
        select pid from pg_stat_activity where application_name = ${applicationName} and wait_event_type = 'Lock'
      `;
      if (row !== undefined) {
        return row.pid;
      }
      await pause(20);
    }
    throw new Error(`waited 20 s, and ${applicationName} never waited on a lock`);
  }

  /**
   * Runs `read` on a one-connection rosie_job client of its own while the owner holds `table` locked, and terminates the
   * read's backend (pg_terminate_backend) once it waits on that lock: the read's answer.
   */
  async function answerWhenCut(table: string, read: (sql: Sql) => Promise<unknown>): Promise<unknown> {
    const application = `rosie-t1259-cut-${table}`;
    const victim = roleClient(JOB_ROLE, application, 1, false);
    try {
      return await db.sql.begin(async (tx) => {
        await tx`lock table ${tx(table)} in access exclusive mode`;
        const pending = read(victim);
        const pid = await lockWaiter(application);
        await db.sql`select pg_terminate_backend(${pid})`;
        return pending;
      });
    } finally {
      // Its one connection is dead and never released (targets.ts inRuntimeTransaction): close it at once.
      await victim.end({ timeout: 0 });
    }
  }

  it(
    "the read, its backend terminated while it waits at the thread's read and then at the handle's, answers transient with its SQLSTATE alone, writes nothing, and the same request then answers",
    SLOW,
    async () => {
      const exchange = await given("read-chat-handle-alex.json");
      const url = new URL(resolvePrimaryUrl());
      const neverInAnswer = [
        ALEX_CHAT,
        ALEX_NUMBER,
        "handle-alex",
        "thread-alex-chat",
        resolvePrimaryUrl(),
        url.host,
        url.username,
        url.password,
      ].filter((value) => value !== "");
      const before = await fingerprint();
      for (const table of ["threads", "handles"]) {
        const outcome = await answerWhenCut(table, (sql) => readChatHandle(sql, exchange.request));
        expect(outcome, table).toMatchObject({ error: "transient" });
        expect(Object.keys(outcome as object).sort(), table).toEqual(["error", "sqlstate"]);
        expect((outcome as { sqlstate: string }).sqlstate, table).toMatch(/^(08[0-9A-Z]{3}|57P0[123])$/);
        expect(answerErrors(outcome), table).toEqual([]);
        const text = JSON.stringify(outcome);
        for (const value of neverInAnswer) {
          expect(text.includes(value), table).toBe(false);
        }
        expect(await readChatHandle(job, exchange.request), table).toEqual(exchange.outcome);
      }
      expect(await fingerprint()).toEqual(before);
    },
  );
});
