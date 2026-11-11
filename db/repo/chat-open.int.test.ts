// T-1212: K-05 v1.7's openChatOnText, a number's text opening its chat at receipt, against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/chat-open`). The schema comes from migrating a fresh test
// schema (db/repo/test-db.ts); the public schema is never touched.
//
// Every call runs as K-05 v1.7 states it (README item 46): through a client whose connections run as rosie_job, the
// runtime side's role (0012: the only one that reads handles and phones), with no business scope. The tables' owner
// (the migrations' role) loads the seeds a fixture's `given` names, K-04's and, as partSeeds, K-22's, each with its own
// `after` chain; reads what the calls wrote; and holds the locks the failure tests need. A fixture's `given.after` chain
// runs first, each step through its real call and compared with its own outcome: commitTurn, writePlan, claimOutboxV12
// and markRowV12 for Dee W.'s waiting notice (as outbox.int.test.ts runs that chain), and this call for its own repeat.
//
// Each answer is checked against data-access v1.7 with Ajv 2020-12, strict, as contracts:check runs it, and each entry
// the call appends, read back in K-04's column names, against K-08 v1's eventLogRow. Numbers are 555-01xx (rule 9).
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ChatOpenedEvent,
  chatOpenedEntryId,
  openChatOnText,
  OpenChatOnTextDatabaseError,
  openChatOnTextIn,
  type OpenChatOnTextOutcome,
  type OpenChatOnTextRequest,
  type TextService,
} from "./chat-open";
import { resolvePrimaryUrl } from "./client";
import { commitTurn, type CommitTurnRequest } from "./commit-turn";
import {
  claimOutboxV12,
  type ClaimOutboxRequest,
  markRowV12,
  type MarkRowV12Request,
  writePlan,
  type WritePlanRequest,
} from "./outbox";
import { startPhone, stopPhone } from "./phones";
import { type Sql, type Tx, withBusiness } from "./scope";
import { utc, utcOrNull } from "./targets";
import { createTestDatabase, type TestDatabase } from "./test-db";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Row = Record<string, unknown>;

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const DB_SCHEMA_DIR = new URL("db-schema/", CONTRACTS);
const CORE_DIR = new URL("core/fixtures/", DB_SCHEMA_DIR);
const RUNTIME_ROLE = "rosie_job";
const PARALLEL = 50;
const SLOW = { timeout: 60_000 };
const HEAVY = { timeout: 180_000 };
/** Sam's number (K-04 seed-person-roles.json, handle-sam), for T-183's stopPhone and startPhone, which take a number. */
const SAM_NUMBER = "+15555550100";
/** A phone number in E.164 form, or an email address, anywhere in a string (K-08 v1 plainString refuses both). */
const NUMBER_OR_ADDRESS = /[+][1-9][0-9]{6,14}|[^@\s"]+@[^@\s"]+[.][^@\s"]+/;
/** The columns item 46 writes on a phone row; every other column stays as it was. */
const CHAT_COLUMNS = ["chat_open", "chat_open_at", "chat_way", "version"];
const SERVICES: readonly TextService[] = ["imessage", "rcs", "sms"];

interface Given {
  k04Seeds: string[];
  after: string[];
  now: string;
  note?: string;
  partSeeds?: string[];
}

interface Exchange {
  call: string;
  given: Given;
  request: Record<string, Json>;
  outcome: Record<string, Json>;
}

interface SeedRow {
  table: string;
  values: Record<string, Json>;
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

/** An event_log row as postgres.js reads it, every column of K-04 v1's table. */
interface StoredEntry {
  id: string;
  at: Date;
  zone: string | null;
  turn_id: string | null;
  job_id: string | null;
  trace_id: string;
  bundle_hash: string | null;
  bundle_build: number | null;
  business_id: string | null;
  actor_kind: string;
  actor_person_id: string | null;
  actor_role: string | null;
  kind: string;
  table_name: string | null;
  row_id: string | null;
  old_values: unknown;
  new_values: unknown;
  sealed_values: Uint8Array | null;
  sealed_for_person_id: string | null;
  why: unknown;
  approved_by: unknown;
  proofs: unknown;
}

/** Every phone row and every entry, as the owner reads them: equal before and after, nothing was written. */
interface Everything {
  phones: Row[];
  log: Row[];
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const exchangeOf = (file: string): Exchange => readJson(new URL(file, ACCESS_DIR)) as Exchange;
const requestOf = (exchange: Exchange): OpenChatOnTextRequest =>
  exchange.request as unknown as OpenChatOnTextRequest;
const nowOf = (exchange: Exchange): { now: Date } => ({ now: new Date(exchange.given.now) });
const INDEX = (readJson(new URL("index.json", ACCESS_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const versionOf = (file: string): string => INDEX.find((entry) => entry.file === file)?.version ?? "v1";
/** K-05 v1.7's fixtures: this call's exchanges, accepted and refused. */
const V17_ENTRIES = INDEX.filter((entry) => entry.version === "v1.7");
const ACCEPTED = V17_ENTRIES.filter((entry) => entry.expect === "accept").map((entry) => entry.file);
const REFUSED = V17_ENTRIES.filter((entry) => entry.expect === "refuse");

const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const without = (row: Row | undefined, keys: readonly string[]): Row =>
  Object.fromEntries(Object.entries(row ?? {}).filter(([key]) => !keys.includes(key)));
const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the contracts' own schemas (Ajv 2020-12, strict, as contracts:check runs them) ---------------------------------

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
const schemaId = (file: string): string => (readJson(new URL(file, CONTRACTS)) as { $id: string }).$id;
const V17_ID = schemaId("data-access/data-access.v1.7.schema.json");
const K08_ID = schemaId("event-trace/event-trace.v1.schema.json");

/** Checks `value` against one $defs entry of a schema, returning Ajv's errors (none when it passes). */
function schemaErrors(id: string, def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${id}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`${id} has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

/** An answer against data-access v1.7: the call's response, or its errors when it is one. */
function answerErrors(outcome: unknown): string[] {
  const isError = isRecord(outcome) && "error" in outcome;
  return schemaErrors(V17_ID, isError ? "openChatOnText.errors" : "openChatOnText.response", outcome);
}

// ---- databases and clients ------------------------------------------------------------------------------------------

let db: TestDatabase;
/** Connections that run as rosie_job, the runtime side, with this file's schema first. */
let job: Sql;
let typedColumns: Map<string, string>;

function runtimeClient(name: string, max: number, isolation?: "repeatable read"): Sql {
  return postgres(resolvePrimaryUrl(), {
    max,
    onnotice: () => undefined,
    connection: {
      application_name: name,
      search_path: `${db.schema}, public`,
      role: RUNTIME_ROLE,
      ...(isolation === undefined ? {} : { default_transaction_isolation: isolation }),
    },
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "chat_open" });
  job = runtimeClient("rosie-t1212-chat-open", 10);
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typedColumns = new Map(typed.map((column) => [column.key, column.type]));
}, 60_000);

afterAll(async () => {
  await job.end({ timeout: 5 });
  await db.drop();
});

/** Empties every table and restarts its identity (truncating the heads cascades to the rest; this file's schema only). */
async function reset(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags restart identity cascade`;
}

async function insertRow(sql: Db, table: string, row: Record<string, Json>): Promise<void> {
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

/** A seed file's rows after those of its `after` chain, each named relative to the file that names it. */
function seedRows(file: URL, seen: Set<string>): SeedRow[] {
  if (seen.has(file.href)) {
    return [];
  }
  seen.add(file.href);
  const seed = readJson(file) as SeedFile;
  return [...seed.after.flatMap((before) => seedRows(new URL(before, file), seen)), ...seed.rows];
}

/** `<part>/<file>`, a seed of another database part (K-05 given.partSeeds), in that part's fixtures folder. */
function partSeedUrl(name: string): URL {
  const slash = name.indexOf("/");
  if (slash < 1) {
    throw new Error(`partSeeds names <part>/<file>, not ${name}`);
  }
  return new URL(`${name.slice(0, slash)}/fixtures/${name.slice(slash + 1)}`, DB_SCHEMA_DIR);
}

/** Inserts the rows of these seed files and their chains, each row once, in one transaction as the owner. */
async function loadSeeds(files: readonly URL[]): Promise<void> {
  const seen = new Set<string>();
  const rows = files.flatMap((file) => seedRows(file, seen));
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
    }
  });
}

/** An exchange's chain: the seeds of every exchange in it, and the exchanges its `after` runs first, in order. */
function chainOf(exchange: Exchange, seen = new Set<string>()): { seeds: URL[]; steps: string[] } {
  const seeds = [
    ...exchange.given.k04Seeds.map((seed) => new URL(seed, CORE_DIR)),
    ...(exchange.given.partSeeds ?? []).map(partSeedUrl),
  ];
  const steps: string[] = [];
  for (const before of exchange.given.after) {
    if (seen.has(before)) {
      continue;
    }
    seen.add(before);
    const inner = chainOf(exchangeOf(before), seen);
    seeds.push(...inner.seeds);
    steps.push(...inner.steps, before);
  }
  return { seeds, steps };
}

/** Runs one chain step's request through its real call, as rosie_job. */
async function runStep(exchange: Exchange): Promise<unknown> {
  const request: unknown = structuredClone(exchange.request);
  const now = new Date(exchange.given.now);
  switch (exchange.call) {
    case "openChatOnText":
      return openChatOnText(job, request as OpenChatOnTextRequest, { now });
    case "commitTurn":
      return commitTurn(job, request as CommitTurnRequest, { now });
    case "writePlan":
      return writePlan(job, request as WritePlanRequest);
    case "claimOutbox":
      return claimOutboxV12(job, request as ClaimOutboxRequest);
    case "markRow":
      return markRowV12(job, request as MarkRowV12Request);
    default:
      throw new Error(`this test runs no ${exchange.call} step`);
  }
}

/**
 * A step's answer as its exchange's version states it: claimOutboxV12 gives each claimed row its port, which v1.2 adds,
 * so a v1.1 claim (claim-dee.json) is compared without it, as outbox.int.test.ts's asVersion does.
 */
function asStated(call: string, answer: unknown, version: string): unknown {
  if (call !== "claimOutbox" || version === "v1.2" || !isRecord(answer) || "error" in answer) {
    return answer;
  }
  if (version !== "v1.1" || !Array.isArray(answer.claimed)) {
    throw new Error(`this test compares no ${version} claim`);
  }
  const claimed = answer.claimed as unknown[];
  return { ...answer, claimed: claimed.map((row) => (isRecord(row) ? without(row, ["port"]) : row)) };
}

/** Loads an exchange's seeds and runs its chain, each step's answer its own fixture's outcome. */
async function givenExchange(exchange: Exchange): Promise<void> {
  const chain = chainOf(exchange);
  await reset();
  await loadSeeds(chain.seeds);
  for (const step of chain.steps) {
    const before = exchangeOf(step);
    expect(asStated(before.call, await runStep(before), versionOf(step)), step).toEqual(before.outcome);
  }
}

async function given(file: string): Promise<Exchange> {
  const exchange = exchangeOf(file);
  await givenExchange(exchange);
  return exchange;
}

// ---- rows a test adds, and what the tables hold ---------------------------------------------------------------------

/** A phone handle with no phone row yet, as the gateway's key call writes one at first sight (no person needed here). */
async function addHandle(handleId: string, address: string): Promise<void> {
  await insertRow(db.sql, "handles", { id: handleId, kind: "phone", address });
}

/** A phone handle with its phone row: closed and not stopped by default, as a booking the business adds writes it. */
async function addPhone(handleId: string, address: string, values: Record<string, Json> = {}): Promise<void> {
  await addHandle(handleId, address);
  await insertRow(db.sql, "phones", { number: address, handle_id: handleId, ...values });
}

async function everything(): Promise<Everything> {
  const phones = await db.sql<Row[]>`select * from phones order by handle_id collate "C"`;
  const log = await db.sql<Row[]>`select * from event_log order by id collate "C"`;
  return { phones: [...phones], log: [...log] };
}

/** The handle's phone row as an answer gives it: chat open, its time and way, stopped, version. */
async function phoneOf(handleId: string): Promise<Row | undefined> {
  const [row] = await db.sql<
    {
      chat_open: boolean;
      chat_open_at: Date | null;
      chat_way: string | null;
      stopped: boolean;
      version: number;
    }[]
  >`
    select chat_open, chat_open_at, chat_way, stopped, version from phones where handle_id = ${handleId}
  `;
  return row === undefined
    ? undefined
    : {
        chatOpen: row.chat_open,
        chatOpenAt: utcOrNull(row.chat_open_at),
        chatWay: row.chat_way,
        stopped: row.stopped,
        version: row.version,
      };
}

/** The entries of one phone row, by id. */
async function entriesOf(handleId: string): Promise<StoredEntry[]> {
  return [
    ...(await db.sql<StoredEntry[]>`
      select * from event_log where table_name = 'phones' and row_id = ${handleId} order by id collate "C"
    `),
  ];
}

/** A stored entry in K-04's column names, as K-08 v1's eventLogRow has it: the time in UTC, sealed bytes in hex. */
function asLogRow(entry: StoredEntry): Row {
  return {
    ...entry,
    at: utc(entry.at),
    sealed_values: entry.sealed_values === null ? null : `\\x${toHex(entry.sealed_values)}`,
  };
}

/** An answer's entry as the call must have appended it, in K-04's column names: no turn, the event id as the job id. */
function expectedLogRow(event: ChatOpenedEvent, request: OpenChatOnTextRequest, at: Date): Row {
  return {
    id: event.id,
    at: utc(at),
    zone: event.zone,
    turn_id: null,
    job_id: request.eventId,
    trace_id: request.traceId,
    bundle_hash: null,
    bundle_build: null,
    business_id: event.businessId,
    actor_kind: event.actorKind,
    actor_person_id: event.actorPersonId,
    actor_role: event.actorRole,
    kind: event.kind,
    table_name: event.tableName,
    row_id: event.rowId,
    old_values: event.oldValues,
    new_values: event.newValues,
    sealed_values: null,
    sealed_for_person_id: null,
    why: event.why,
    approved_by: event.approvedBy,
    proofs: event.proofs,
  };
}

/** An answer that wrote: inserted or opened, with its entry. */
function writing(outcome: OpenChatOnTextOutcome): {
  handleId: string;
  phone: unknown;
  event: ChatOpenedEvent;
} {
  if (!("result" in outcome) || (outcome.result !== "inserted" && outcome.result !== "opened")) {
    throw new Error(`expected inserted or opened, got ${JSON.stringify(outcome)}`);
  }
  return { handleId: outcome.handleId, phone: outcome.phone, event: outcome.event };
}

/**
 * What a writing answer left (item 46, "The transaction", "The entry", "What it never changes"): the handle's row as the
 * answer gives it, its other columns as they were, or at K-04's defaults for an inserted row whose number is its handle's
 * address; every other row as it was; and one entry more, the answer's, which is the request's event and handle (item
 * 46's code check), holds no number, and in K-04's column names is a K-08 v1 eventLogRow.
 */
async function expectWrote(
  before: Everything,
  outcome: OpenChatOnTextOutcome,
  request: OpenChatOnTextRequest,
  at: Date,
): Promise<void> {
  const { handleId, phone, event } = writing(outcome);
  const after = await everything();
  expect(handleId).toBe(request.handleId);
  expect(await phoneOf(handleId)).toEqual(phone);

  const rowBefore = before.phones.find((row) => row.handle_id === handleId);
  const rowAfter = after.phones.find((row) => row.handle_id === handleId);
  const [handle] = await db.sql<{ address: string }[]>`select address from handles where id = ${handleId}`;
  expect(without(rowAfter, CHAT_COLUMNS)).toEqual(
    rowBefore === undefined
      ? {
          number: handle?.address,
          handle_id: handleId,
          stopped: false,
          stop_at: null,
          start_at: null,
          linq_contact_added_at: null,
          poll_voted_at: null,
          optout_line_delivered_at: null,
        }
      : without(rowBefore, CHAT_COLUMNS),
  );
  const others = (rows: Row[]): Row[] => rows.filter((row) => row.handle_id !== handleId);
  expect(others(after.phones)).toEqual(others(before.phones));

  const kept = new Set(before.log.map((row) => row.id));
  expect(after.log.filter((row) => kept.has(row.id))).toEqual(before.log);
  const added = after.log.filter((row) => !kept.has(row.id)) as unknown as StoredEntry[];
  expect(added.map((row) => row.id)).toEqual([chatOpenedEntryId(request.eventId)]);
  const [stored] = added;
  if (stored === undefined) {
    throw new Error("no entry was appended");
  }
  expect(event.id).toBe(`${request.eventId}/chat-opened`);
  expect(event.rowId).toBe(request.handleId);
  expect(event.why).toEqual({ provider_event: { provider: "linq", event_id: request.eventId } });
  expect(asLogRow(stored)).toEqual(expectedLogRow(event, request, at));
  expect(schemaErrors(K08_ID, "eventLogRow", asLogRow(stored))).toEqual([]);
  expect(JSON.stringify(asLogRow(stored))).not.toMatch(NUMBER_OR_ADDRESS);
}

/** A text from a handle: n picks the service in turn, and the receipt time, in seconds after 09:00 on Nov 11. */
function text(handleId: string, label: string, n: number): OpenChatOnTextRequest {
  return {
    eventId: `evt-t1212-${label}-${String(n)}`,
    handleId,
    service: SERVICES[n % SERVICES.length] ?? "imessage",
    receivedAt: `2026-11-11T09:00:${String(n % 60).padStart(2, "0")}Z`,
    traceId: `trace-t1212-${label}-${String(n)}`,
  };
}

/** The pid of the one session of `applicationName` waiting on a lock, polling every 20 ms for at most 20 s. */
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

/** Waits until the session `pid` waits on a lock, polling every 20 ms for at most 20 s. */
async function waitsOnLock(pid: number): Promise<void> {
  for (let tries = 0; tries < 1000; tries += 1) {
    const [row] = await db.sql<{ pid: number }[]>`
      select pid from pg_stat_activity where pid = ${pid} and wait_event_type = 'Lock'
    `;
    if (row !== undefined) {
      return;
    }
    await pause(20);
  }
  throw new Error("waited 20 s, and the session never waited on a lock");
}

/** A promise and the function that settles it, for a transaction that holds its locks until the test lets it go. */
function signal(): { done: Promise<void>; give: () => void } {
  let give = (): void => undefined;
  const done = new Promise<void>((resolve) => {
    give = resolve;
  });
  return { done, give };
}

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("openChatOnText: each K-05 v1.7 fixture's request, after its given, gives its outcome (K-05 item 46)", () => {
  it("the index lists the six accepted and three refused v1.7 exchanges, each as listed against data-access v1.7", () => {
    expect([...ACCEPTED].sort()).toEqual([
      "open-chat-alex-already-open.json",
      "open-chat-apple-id-email.json",
      "open-chat-ben-stopped.json",
      "open-chat-dee-closed-chat.json",
      "open-chat-first-text-sam-repeat.json",
      "open-chat-first-text-sam.json",
    ]);
    for (const file of ACCEPTED) {
      expect(schemaErrors(V17_ID, "openChatOnText.exchange", exchangeOf(file)), file).toEqual([]);
    }
    expect(REFUSED.map((entry) => [entry.file, entry.def])).toEqual([
      ["invalid/refuse-open-chat-stopped-number.json", "openChatOnText.exchange"],
      ["invalid/refuse-open-chat-no-event.json", "openChatOnText.request"],
      ["invalid/refuse-open-chat-with-number.json", "openChatOnText.request"],
    ]);
    for (const entry of REFUSED) {
      const refused = readJson(new URL(entry.file, ACCESS_DIR));
      expect(schemaErrors(V17_ID, entry.def ?? "openChatOnText.exchange", refused), entry.file).not.toEqual(
        [],
      );
    }
  });

  it("the test client runs as rosie_job, with this file's schema first and no business scope", async () => {
    const [row] = await job<{ who: string; scope: string | null }[]>`
      select current_user as who, current_setting('rosie.business_id', true) as scope
    `;
    expect(row?.who).toBe(RUNTIME_ROLE);
    expect(row?.scope ?? "").toBe("");
  });

  for (const file of ACCEPTED) {
    it(
      `${file}: as rosie_job with no business scope, the call answers the fixture's outcome, valid at v1.7`,
      SLOW,
      async () => {
        const exchange = await given(file);
        const request = requestOf(exchange);
        const before = await everything();
        const outcome = await openChatOnText(job, request, nowOf(exchange));
        expect(outcome).toEqual(exchange.outcome);
        expect(answerErrors(outcome)).toEqual([]);
        expect(schemaErrors(V17_ID, "openChatOnText.exchange", { ...exchange, outcome })).toEqual([]);
        expect(JSON.stringify(outcome)).not.toMatch(NUMBER_OR_ADDRESS);
        if ("result" in outcome && (outcome.result === "inserted" || outcome.result === "opened")) {
          await expectWrote(before, outcome, request, nowOf(exchange).now);
        } else {
          expect(await everything()).toEqual(before);
        }
      },
    );
  }

  it(
    "refuse-open-chat-stopped-number.json: its outcome is refused; the call answers its twin's (open-chat-ben-stopped)",
    SLOW,
    async () => {
      const refused = readJson(
        new URL("invalid/refuse-open-chat-stopped-number.json", ACCESS_DIR),
      ) as Exchange;
      const twin = exchangeOf("open-chat-ben-stopped.json");
      expect(schemaErrors(V17_ID, "openChatOnText.exchange", refused)).not.toEqual([]);
      // Put right, it is its twin's: the same request after the same seeds, answered with nothing written.
      expect(refused.request).toEqual(twin.request);
      expect(without({ ...refused.given }, ["note"])).toEqual(without({ ...twin.given }, ["note"]));
      expect(schemaErrors(V17_ID, "openChatOnText.exchange", { ...refused, outcome: twin.outcome })).toEqual(
        [],
      );
      await givenExchange(refused);
      const before = await everything();
      const outcome = await openChatOnText(job, requestOf(refused), nowOf(refused));
      expect(outcome).toEqual(twin.outcome);
      expect(outcome).not.toEqual(refused.outcome);
      expect(await everything()).toEqual(before);
    },
  );

  it(
    "refuse-open-chat-no-event.json: refused by the schema and by the call, before anything is read or written",
    SLOW,
    async () => {
      const refused = readJson(new URL("invalid/refuse-open-chat-no-event.json", ACCESS_DIR)) as Record<
        string,
        Json
      >;
      const twin = exchangeOf("open-chat-first-text-sam.json");
      expect(schemaErrors(V17_ID, "openChatOnText.request", refused)).not.toEqual([]);
      // Put right (its event named), it is its twin's request, which is accepted.
      const mended = { ...refused, eventId: twin.request.eventId ?? null };
      expect(mended).toEqual(twin.request);
      expect(schemaErrors(V17_ID, "openChatOnText.request", mended)).toEqual([]);
      await givenExchange(twin);
      const before = await everything();
      const failure = await openChatOnText(job, refused as unknown as OpenChatOnTextRequest).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as Error).message).toBe("openChatOnText: the request needs eventId");
      expect(await everything()).toEqual(before);
    },
  );

  it(
    "refuse-open-chat-with-number.json: refused by the schema and by the call, the number never read from a request",
    SLOW,
    async () => {
      const refused = readJson(new URL("invalid/refuse-open-chat-with-number.json", ACCESS_DIR)) as Record<
        string,
        Json
      >;
      const twin = exchangeOf("open-chat-first-text-sam.json");
      expect(schemaErrors(V17_ID, "openChatOnText.request", refused)).not.toEqual([]);
      // Put right (the number left out), it is its twin's request, which is accepted.
      const mended = without(refused, ["phoneNumber"]);
      expect(mended).toEqual(twin.request);
      expect(schemaErrors(V17_ID, "openChatOnText.request", mended)).toEqual([]);
      await givenExchange(twin);
      const before = await everything();
      const failure = await openChatOnText(job, refused as unknown as OpenChatOnTextRequest).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as Error).message).toBe(
        "openChatOnText: the request takes only eventId, handleId, service, receivedAt, traceId",
      );
      expect(await everything()).toEqual(before);
    },
  );
});

describe("50 parallel calls: an insert waits for a parallel insert, the row's lock for a parallel write (item 46)", () => {
  async function race(
    requests: readonly OpenChatOnTextRequest[],
    label: string,
  ): Promise<OpenChatOnTextOutcome[]> {
    const racer = runtimeClient(`rosie-t1212-race-${label}`, 20);
    try {
      return await Promise.all(
        requests.map((request) => openChatOnText(racer, request, { now: new Date(request.receivedAt) })),
      );
    } finally {
      await racer.end({ timeout: 5 });
    }
  }

  const resultsOf = (outcomes: readonly OpenChatOnTextOutcome[]): string[] =>
    outcomes.map((outcome) => ("result" in outcome ? outcome.result : outcome.error));

  it(
    "50 parallel first texts of one new number give one row (version 1) and one entry; the rest answer alreadyOpen",
    HEAVY,
    async () => {
      await reset();
      await addHandle("handle-t1212-race", "+15555550180");
      const requests = Array.from({ length: PARALLEL }, (_, n) => text("handle-t1212-race", "first", n));
      const outcomes = await race(requests, "first");
      for (const outcome of outcomes) {
        expect(answerErrors(outcome)).toEqual([]);
      }
      const results = resultsOf(outcomes);
      expect(results.filter((result) => result === "inserted")).toHaveLength(1);
      expect(results.filter((result) => result === "alreadyOpen")).toHaveLength(PARALLEL - 1);
      const winner = requests[results.indexOf("inserted")];
      if (winner === undefined) {
        throw new Error("no text inserted the row");
      }
      // One row, at version 1, open since the inserting text's receipt by its service (open gap 51).
      const phone = {
        chatOpen: true,
        chatOpenAt: winner.receivedAt,
        chatWay: winner.service,
        stopped: false,
        version: 1,
      };
      expect(await phoneOf("handle-t1212-race")).toEqual(phone);
      for (const outcome of outcomes) {
        expect(outcome).toMatchObject({ handleId: "handle-t1212-race", phone });
      }
      // One entry: the inserting text's, valid against K-08 v1.
      const entries = await entriesOf("handle-t1212-race");
      expect(entries.map((entry) => entry.id)).toEqual([chatOpenedEntryId(winner.eventId)]);
      for (const entry of entries) {
        expect(schemaErrors(K08_ID, "eventLogRow", asLogRow(entry))).toEqual([]);
      }
    },
  );

  it(
    "50 parallel repeats of one text from a new number give one entry; the rest answer repeated",
    HEAVY,
    async () => {
      await reset();
      await addHandle("handle-t1212-repeat", "+15555550181");
      const request = text("handle-t1212-repeat", "repeat", 0);
      const outcomes = await race(
        Array.from({ length: PARALLEL }, () => request),
        "repeat",
      );
      for (const outcome of outcomes) {
        expect(answerErrors(outcome)).toEqual([]);
      }
      const results = resultsOf(outcomes);
      expect(results.filter((result) => result === "inserted")).toHaveLength(1);
      expect(results.filter((result) => result === "repeated")).toHaveLength(PARALLEL - 1);
      const phone = {
        chatOpen: true,
        chatOpenAt: request.receivedAt,
        chatWay: request.service,
        stopped: false,
        version: 1,
      };
      expect(await phoneOf("handle-t1212-repeat")).toEqual(phone);
      for (const outcome of outcomes) {
        expect(outcome).toMatchObject({ phone });
      }
      const entries = await entriesOf("handle-t1212-repeat");
      expect(entries.map((entry) => entry.id)).toEqual([chatOpenedEntryId(request.eventId)]);
    },
  );

  it(
    "50 parallel repeats of one text on a closed chat give one opening and one entry; the rest answer repeated",
    HEAVY,
    async () => {
      await reset();
      await addPhone("handle-t1212-closed", "+15555550182");
      const request = text("handle-t1212-closed", "closed", 1);
      const outcomes = await race(
        Array.from({ length: PARALLEL }, () => request),
        "closed",
      );
      for (const outcome of outcomes) {
        expect(answerErrors(outcome)).toEqual([]);
      }
      const results = resultsOf(outcomes);
      expect(results.filter((result) => result === "opened")).toHaveLength(1);
      expect(results.filter((result) => result === "repeated")).toHaveLength(PARALLEL - 1);
      // The version moved once, from 1 to 2.
      const phone = {
        chatOpen: true,
        chatOpenAt: request.receivedAt,
        chatWay: request.service,
        stopped: false,
        version: 2,
      };
      expect(await phoneOf("handle-t1212-closed")).toEqual(phone);
      for (const outcome of outcomes) {
        expect(outcome).toMatchObject({ phone });
      }
      const entries = await entriesOf("handle-t1212-closed");
      expect(entries.map((entry) => entry.id)).toEqual([chatOpenedEntryId(request.eventId)]);
      for (const entry of entries) {
        expect(schemaErrors(K08_ID, "eventLogRow", asLogRow(entry))).toEqual([]);
      }
    },
  );
});

describe("a STOP and a START around the call (item 46, 'The stop and the text'; default 76)", () => {
  /** Sam's first text, run: his row inserted at version 1, its chat open by iMessage since 18:05:01Z. */
  async function samFirstText(): Promise<OpenChatOnTextRequest> {
    const first = await given("open-chat-first-text-sam.json");
    expect(await openChatOnText(job, requestOf(first), nowOf(first))).toEqual(first.outcome);
    return requestOf(first);
  }

  const samLater: OpenChatOnTextRequest = {
    eventId: "evt-t1212-sam-later",
    handleId: "handle-sam",
    service: "imessage",
    receivedAt: "2026-10-19T18:10:01Z",
    traceId: "trace-t1212-sam-later",
  };

  it(
    "stopPhone after the call closes the chat, and a later text answers stopped, every column and the version unchanged",
    SLOW,
    async () => {
      const first = await samFirstText();
      const stop = await stopPhone(job, SAM_NUMBER, 1, new Date("2026-10-19T18:06:00Z"));
      expect(stop).toMatchObject({ ok: true, row: { stopped: true, chatOpen: false, version: 2 } });
      const stoppedRow = {
        chatOpen: false,
        chatOpenAt: "2026-10-19T18:05:01Z",
        chatWay: "imessage",
        stopped: true,
        version: 2,
      };
      const before = await everything();
      const later = await openChatOnText(job, samLater, { now: new Date(samLater.receivedAt) });
      expect(later).toEqual({ result: "stopped", handleId: "handle-sam", phone: stoppedRow, event: null });
      expect(answerErrors(later)).toEqual([]);
      expect(await everything()).toEqual(before);
      // The first text again, as Linq may send it for 30 minutes: repeated, the chat the STOP closed left closed.
      const again = await openChatOnText(job, first, { now: new Date("2026-10-19T18:11:00Z") });
      expect(again).toEqual({ result: "repeated", handleId: "handle-sam", phone: stoppedRow, event: null });
      expect(answerErrors(again)).toEqual([]);
      expect(await everything()).toEqual(before);
    },
  );

  it("startPhone, then the old text again, answers repeated with nothing written", SLOW, async () => {
    const first = await samFirstText();
    expect(await stopPhone(job, SAM_NUMBER, 1, new Date("2026-10-19T18:06:00Z"))).toMatchObject({ ok: true });
    const start = await startPhone(job, SAM_NUMBER, 2, new Date("2026-10-19T18:20:00Z"));
    expect(start).toMatchObject({ ok: true, row: { stopped: false, chatOpen: true, version: 3 } });
    const before = await everything();
    const again = await openChatOnText(job, first, { now: new Date("2026-10-19T18:21:00Z") });
    expect(again).toEqual({
      result: "repeated",
      handleId: "handle-sam",
      phone: {
        chatOpen: true,
        chatOpenAt: "2026-10-19T18:05:01Z",
        chatWay: "imessage",
        stopped: false,
        version: 3,
      },
      event: null,
    });
    expect(answerErrors(again)).toEqual([]);
    expect(await everything()).toEqual(before);
    // A new text after the START finds the chat open: alreadyOpen, nothing written.
    const later = await openChatOnText(job, samLater, { now: new Date(samLater.receivedAt) });
    expect(later).toMatchObject({ result: "alreadyOpen", phone: { version: 3 } });
    expect(await everything()).toEqual(before);
  });

  it(
    "a STOP committing while the call waits for the row is waited for and seen: stopped, nothing written",
    SLOW,
    async () => {
      const APP = "rosie-t1212-stop-wait";
      await reset();
      await addPhone("handle-t1212-wait", "+15555550183");
      const request = text("handle-t1212-wait", "wait", 0);
      const locked = signal();
      const letGo = signal();
      // The STOP's transaction: it locks the closed row and stops it, then holds until the call waits for it.
      const stopping = db.sql.begin(async (tx) => {
        await tx`select version from phones where handle_id = 'handle-t1212-wait' for update`;
        await tx`
          update phones set stopped = true, chat_open = false, stop_at = '2026-11-11T08:59:00Z', version = version + 1
          where handle_id = 'handle-t1212-wait'
        `;
        locked.give();
        await letGo.done;
      });
      const caller = runtimeClient(APP, 1);
      try {
        await locked.done;
        const pending = openChatOnText(caller, request, { now: new Date(request.receivedAt) });
        await lockWaiter(APP);
        letGo.give();
        await stopping;
        const before = await everything();
        const outcome = await pending;
        expect(outcome).toEqual({
          result: "stopped",
          handleId: "handle-t1212-wait",
          phone: { chatOpen: false, chatOpenAt: null, chatWay: null, stopped: true, version: 2 },
          event: null,
        });
        expect(answerErrors(outcome)).toEqual([]);
        expect(await everything()).toEqual(before);
        expect(await entriesOf("handle-t1212-wait")).toEqual([]);
      } finally {
        letGo.give();
        await stopping.catch(() => undefined);
        await caller.end({ timeout: 5 });
      }
    },
  );
});

describe("a later text never moves what the opening text set (defaults 72 and 74)", () => {
  it(
    "an sms text on an open imessage chat answers alreadyOpen and keeps chat_way, writing nothing",
    SLOW,
    async () => {
      const exchange = await given("open-chat-alex-already-open.json");
      const request: OpenChatOnTextRequest = {
        ...requestOf(exchange),
        eventId: "evt-t1212-alex-sms",
        service: "sms",
        traceId: "trace-t1212-alex-sms",
      };
      const before = await everything();
      const outcome = await openChatOnText(job, request, nowOf(exchange));
      expect(outcome).toEqual({
        result: "alreadyOpen",
        handleId: "handle-alex",
        phone: {
          chatOpen: true,
          chatOpenAt: "2026-10-12T16:20:00Z",
          chatWay: "imessage",
          stopped: false,
          version: 3,
        },
        event: null,
      });
      expect(answerErrors(outcome)).toEqual([]);
      expect(await everything()).toEqual(before);
    },
  );

  it(
    "a closed row that already holds chat_open_at keeps it, and its entry names only the columns that change",
    SLOW,
    async () => {
      await reset();
      // Closed and not stopped, its first time and an sms way kept (default 74: in practice no writer leaves one).
      await addPhone("handle-t1212-kept", "+15555550184", {
        chat_open_at: "2026-10-01T09:00:00Z",
        chat_way: "sms",
      });
      const request = text("handle-t1212-kept", "kept", 0);
      const before = await everything();
      const outcome = await openChatOnText(job, request, { now: new Date(request.receivedAt) });
      expect(outcome).toMatchObject({
        result: "opened",
        phone: {
          chatOpen: true,
          chatOpenAt: "2026-10-01T09:00:00Z",
          chatWay: "imessage",
          stopped: false,
          version: 2,
        },
        event: {
          oldValues: { chat_open: false, chat_way: "sms" },
          newValues: { chat_open: true, chat_way: "imessage" },
        },
      });
      expect(writing(outcome).event.oldValues).toEqual({ chat_open: false, chat_way: "sms" });
      expect(writing(outcome).event.newValues).toEqual({ chat_open: true, chat_way: "imessage" });
      expect(answerErrors(outcome)).toEqual([]);
      await expectWrote(before, outcome, request, new Date(request.receivedAt));

      // The same, its way already the text's: the entry names chat_open alone.
      await addPhone("handle-t1212-kept-way", "+15555550185", {
        chat_open_at: "2026-10-01T09:00:00Z",
        chat_way: "imessage",
      });
      const same = text("handle-t1212-kept-way", "kept-way", 3);
      const sameBefore = await everything();
      const opened = await openChatOnText(job, same, { now: new Date(same.receivedAt) });
      expect(writing(opened).event.oldValues).toEqual({ chat_open: false });
      expect(writing(opened).event.newValues).toEqual({ chat_open: true });
      expect(writing(opened).phone).toEqual({
        chatOpen: true,
        chatOpenAt: "2026-10-01T09:00:00Z",
        chatWay: "imessage",
        stopped: false,
        version: 2,
      });
      expect(answerErrors(opened)).toEqual([]);
      await expectWrote(sameBefore, opened, same, new Date(same.receivedAt));
    },
  );
});

describe("the call's refusals (K-05 v1.7 openChatOnText.errors; item 46 step 1)", () => {
  it("a handle id no handle has answers notFound (table handles), writing nothing", SLOW, async () => {
    await given("open-chat-first-text-sam.json");
    const before = await everything();
    const request = text("handle-t1212-none", "none", 0);
    const outcome = await openChatOnText(job, request, { now: new Date(request.receivedAt) });
    expect(outcome).toEqual({ error: "notFound", table: "handles", rowId: "handle-t1212-none" });
    expect(answerErrors(outcome)).toEqual([]);
    expect(await everything()).toEqual(before);
  });

  it(
    "a request that is not item 46's throws a TypeError naming the field, before anything is read",
    SLOW,
    async () => {
      const exchange = await given("open-chat-first-text-sam.json");
      const request = requestOf(exchange);
      const before = await everything();
      const refused: [unknown, string][] = [
        [null, "openChatOnText: the request is an object"],
        [[request], "openChatOnText: the request is an object"],
        [{ ...request, eventId: SAM_NUMBER }, "openChatOnText: eventId is a K-08 safe id"],
        [{ ...request, eventId: "5555550100" }, "openChatOnText: eventId is a K-08 safe id"],
        [{ ...request, eventId: "(555) 555-0100" }, "openChatOnText: eventId is a K-08 safe id"],
        [{ ...request, eventId: "" }, "openChatOnText: eventId is a K-08 safe id"],
        [{ ...request, eventId: "Sam's first text" }, "openChatOnText: eventId is a K-08 safe id"],
        [{ ...request, handleId: SAM_NUMBER }, "openChatOnText: handleId is a K-08 safe id"],
        [{ ...request, handleId: "sam@example.com" }, "openChatOnText: handleId is a K-08 safe id"],
        [{ ...request, service: "email" }, "openChatOnText: service is imessage, rcs or sms"],
        [{ ...request, receivedAt: "2026-10-19 18:05:01" }, "openChatOnText: receivedAt is a UTC time"],
        [{ ...request, receivedAt: "2026-10-19T14:05:01-04:00" }, "openChatOnText: receivedAt is a UTC time"],
        [{ ...request, traceId: "" }, "traceId is a non-empty id"],
      ];
      for (const [value, message] of refused) {
        const failure = await openChatOnText(job, value as OpenChatOnTextRequest).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure, message).toBeInstanceOf(TypeError);
        expect((failure as Error).message, message).toContain(message);
        expect((failure as Error).message, message).not.toMatch(NUMBER_OR_ADDRESS);
      }
      expect(await everything()).toEqual(before);
    },
  );

  it("under a business scope the call refuses to run, before it reads or writes anything", SLOW, async () => {
    const exchange = await given("open-chat-first-text-sam.json");
    const before = await everything();
    await expect(
      withBusiness(job, "biz-lees-barbershop", (tx) => openChatOnTextIn(tx, requestOf(exchange))),
    ).rejects.toThrow("openChatOnText runs on the runtime side, with no business scope");
    expect(await everything()).toEqual(before);
  });
});

describe("a failure answers transient and leaves nothing: a lost connection, 40001, 40P01 (K-05 transientError)", () => {
  it(
    "a lost connection: the call's backend killed at its entry, its row already inserted, answers transient",
    SLOW,
    async () => {
      const APP = "rosie-t1212-crash";
      await reset();
      await addHandle("handle-t1212-crash", "+15555550186");
      const request = text("handle-t1212-crash", "crash", 0);
      const before = await everything();
      const crashing = runtimeClient(APP, 1);
      try {
        const outcome = await db.sql.begin(async (tx) => {
          // The call's entry waits behind this lock, after its phone row's insert.
          await tx`lock table event_log in exclusive mode`;
          const pending = openChatOnText(crashing, request);
          const pid = await lockWaiter(APP);
          const [wrote] = await db.sql<{ wrote: boolean }[]>`
            select exists (select 1 from pg_locks where pid = ${pid} and locktype = 'transactionid') as wrote
          `;
          expect(wrote?.wrote, "the call had written its row when it was killed").toBe(true);
          await db.sql`select pg_terminate_backend(${pid})`;
          return pending;
        });
        expect(outcome).toMatchObject({ error: "transient" });
        expect(answerErrors(outcome)).toEqual([]);
      } finally {
        // Its one connection is dead and never released (targets.ts inRuntimeTransaction): close it at once.
        await crashing.end({ timeout: 0 });
      }
      expect(await everything()).toEqual(before);
    },
  );

  it(
    "40001: a row a parallel write changed after the call's snapshot answers transient (a client at repeatable read)",
    SLOW,
    async () => {
      const APP = "rosie-t1212-serial";
      await reset();
      await addPhone("handle-t1212-serial", "+15555550187");
      const request = text("handle-t1212-serial", "serial", 0);
      const locked = signal();
      const letGo = signal();
      // A parallel writer holds the row, and changes it once the call waits for it.
      const writer = db.sql.begin(async (tx) => {
        await tx`select version from phones where handle_id = 'handle-t1212-serial' for update`;
        locked.give();
        await letGo.done;
        await tx`
          update phones set linq_contact_added_at = '2026-11-11T08:59:00Z', version = version + 1
          where handle_id = 'handle-t1212-serial'
        `;
      });
      const repeatableRead = runtimeClient(APP, 1, "repeatable read");
      try {
        await locked.done;
        const pending = openChatOnText(repeatableRead, request);
        await lockWaiter(APP);
        letGo.give();
        await writer;
        const before = await everything();
        const outcome = await pending;
        expect(outcome).toEqual({ error: "transient", sqlstate: "40001" });
        expect(answerErrors(outcome)).toEqual([]);
        expect(await everything()).toEqual(before);
        expect(await entriesOf("handle-t1212-serial")).toEqual([]);
      } finally {
        letGo.give();
        await writer.catch(() => undefined);
        await repeatableRead.end({ timeout: 5 });
      }
    },
  );

  it("40P01: a deadlock the call closes answers transient, and nothing is written", SLOW, async () => {
    const APP = "rosie-t1212-deadlock";
    await reset();
    await addPhone("handle-t1212-deadlock", "+15555550188");
    const request = text("handle-t1212-deadlock", "deadlock", 0);
    const before = await everything();
    const [setting] = await db.sql<{ deadlock_timeout: string }[]>`show deadlock_timeout`;
    const unit = /^([0-9]+)(ms|s)$/.exec(setting?.deadlock_timeout ?? "");
    const deadlockMs = unit === null ? 1000 : Number(unit[1]) * (unit[2] === "s" ? 1000 : 1);

    // Y holds phones in share mode, so the call's insert waits, the call holding its read of handles.
    const yLocked = signal();
    const yLetGo = signal();
    const y = db.sql.begin(async (tx) => {
      await tx`lock table phones in share mode`;
      yLocked.give();
      await yLetGo.done;
    });
    // X takes event_log in share mode, where the call's entry will wait, then waits for handles behind the call.
    const xStarted = signal();
    let xPid = 0;
    const deadlocking = runtimeClient(APP, 1);
    let x: Promise<void> | undefined;
    try {
      await yLocked.done;
      const pending = openChatOnText(deadlocking, request);
      await lockWaiter(APP);
      x = db.sql.begin(async (tx) => {
        const [me] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        xPid = me?.pid ?? 0;
        await tx`lock table event_log in share mode`;
        xStarted.give();
        await tx`lock table handles in access exclusive mode`;
      });
      await xStarted.done;
      await waitsOnLock(xPid);
      // X's one deadlock check runs after deadlock_timeout and finds no cycle: the call waits for Y, which waits for
      // nothing. Once Y lets go, the call goes on to its entry and waits for X: the call, the later waiter, finds it.
      // Three times the timeout: room for a slow timer on an emulated PostgreSQL under load.
      await pause(deadlockMs * 3);
      yLetGo.give();
      await y;
      const outcome = await pending;
      expect(outcome).toEqual({ error: "transient", sqlstate: "40P01" });
      expect(answerErrors(outcome)).toEqual([]);
      await x;
    } finally {
      yLetGo.give();
      await y.catch(() => undefined);
      await x?.catch(() => undefined);
      await deadlocking.end({ timeout: 5 });
    }
    expect(await everything()).toEqual(before);
  });
});

describe("what the call never does (item 46, 'What it never changes'; defaults 1 and 2 of chat-open.ts)", () => {
  it(
    "a repeat whose row is now closed but not stopped throws rather than answer a row no v1.7 answer holds",
    SLOW,
    async () => {
      const first = await given("open-chat-first-text-sam.json");
      expect(await openChatOnText(job, requestOf(first), nowOf(first))).toEqual(first.outcome);
      // No frozen writer leaves this (only STOP closes a chat, and STOP stops it): written here as the owner.
      await db.sql`update phones set chat_open = false, version = version + 1 where handle_id = 'handle-sam'`;
      const before = await everything();
      await expect(openChatOnText(job, requestOf(first), nowOf(first))).rejects.toThrow(
        "openChatOnText: this text's entry exists, and its row is closed and not stopped",
      );
      expect(await everything()).toEqual(before);
    },
  );

  it(
    "a database error that is not transient is thrown with its SQLSTATE and names alone, and nothing is written",
    SLOW,
    async () => {
      await reset();
      await addHandle("handle-t1212-taken", "+15555550189");
      // A caller's fault: the event's entry is already another row's, so the call's entry is refused, its last write.
      await insertRow(db.sql, "event_log", {
        id: "evt-t1212-taken/chat-opened",
        job_id: "evt-t1212-taken",
        trace_id: "trace-t1212-taken",
        actor_kind: "provider",
        kind: "phone.chat_opened",
        table_name: "phones",
        row_id: "handle-t1212-other",
      });
      const before = await everything();
      const request = { ...text("handle-t1212-taken", "taken", 0), eventId: "evt-t1212-taken" };
      const failure = await openChatOnText(job, request).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(OpenChatOnTextDatabaseError);
      expect(failure).toMatchObject({ code: "23505", table: "event_log", constraint: "event_log_pkey" });
      expect(Object.keys(failure as object).sort()).toEqual(["code", "constraint", "name", "table"]);
      expect((failure as Error).message).not.toMatch(NUMBER_OR_ADDRESS);
      expect(await everything()).toEqual(before);
    },
  );
});
