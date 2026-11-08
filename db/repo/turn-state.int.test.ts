// T-219: K-05 v1.2's readTurnState, the frontier's read of a turn's stored state, against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/turn-state`). The schema comes from migrating a fresh test
// schema, which test-db.ts drops when the file ends.
//
// Every call runs as K-05 v1.2 states it (README item 26, default 25): through a client whose connections run as
// rosie_job (T-191's runtime role, the one that reads handles, persons, phones and outbox_parts), under the request's
// business scope, or on the runtime side when the request names no business. The tables' owner (the migrations' role)
// writes the seeds and the state a fixture's `given` names; the owner is not bound by row-level security, so only the
// reads under test meet it.
//
// A fixture's `given` loads K-04's seeds (`k04Seeds`) and other parts' seeds (`partSeeds`, here K-29's), each with its
// own `after` chain, and runs the exchanges its `after` names first, each with its own `given`. handleSealingKey (T-220)
// runs for real. The commit, plan, claim, mark and arm calls of the A7-03 chain (T-196, T-197) are not all on main, so,
// as in targets.int.test.ts, each of those steps writes, directly and as the owner, the rows its exchange states in its
// request and its outcome: what the read that follows sees. K-04's seed holds stand-in bytes for Alex's wrapped key, so
// the loader writes a real data key wrapped under this file's test wrapping key in its place; the wrapping key is random
// per run, never a real key and never read from the environment.
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "./client";
import { appendConsent } from "./consent";
import { handleSealingKey, type HandleSealingKeyRequest } from "./handle-keys";
import { BusinessScopeError, setBusinessScope, type Sql, type Tx, withBusiness } from "./scope";
import { inRuntimeTransaction, liveOpenQuestionsOfHandle } from "./targets";
import { createTestDatabase, type TestDatabase } from "./test-db";
import {
  FACT_HOMES,
  type FactRef,
  readTurnState,
  readTurnStateIn,
  type ReadTurnStateOutcome,
  type ReadTurnStateRequest,
  type ReadTurnStateResponse,
} from "./turn-state";

type Db = Sql | Tx;
type Step = (sql: Db, exchange: Exchange) => Promise<void>;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const DB_SCHEMA_DIR = new URL("db-schema/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const RUNTIME_ROLE = "rosie_job";
const WRAP_NAME = "SEALING_WRAP_KEY";
const SLOW = { timeout: 60_000 };

const BARBERSHOP = "biz-lees-barbershop";
const YOGA = "biz-yoga-studio";
const BUNDLE_HASH = "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037";
const ALEX_FIXTURE = "read-turn-state-alex.json";

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

interface TableListColumn {
  name: string;
  type: string;
  sealedBy?: string;
}

interface TableListTable {
  name: string;
  columns: TableListColumn[];
  primaryKey: string[];
  rowLevelSecurity: { scope: "business"; column: string } | { scope: "none"; why: string };
  versioned: boolean;
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const exchangeOf = (file: string): Exchange => readJson(new URL(file, ACCESS_DIR)) as Exchange;
const INDEX = (readJson(new URL("index.json", ACCESS_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const TURN_STATE_FIXTURES = INDEX.filter((entry) => entry.def === "readTurnState.exchange").map(
  (entry) => entry.file,
);
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

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
const V12_ID = (readJson(new URL("data-access/data-access.v1.2.schema.json", CONTRACTS)) as { $id: string })
  .$id;

/** Checks `value` against one $defs entry of data-access v1.2, returning Ajv's errors (none when it passes). */
function schemaErrors(def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${V12_ID}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`data-access v1.2 has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

/** The outcome checked against the call's response, or its errors when it is one. */
function outcomeErrors(outcome: unknown): string[] {
  const isError = typeof outcome === "object" && outcome !== null && "error" in outcome;
  return schemaErrors(isError ? "readTurnState.errors" : "readTurnState.response", outcome);
}

function asTurnState(outcome: ReadTurnStateOutcome): ReadTurnStateResponse {
  if (!("result" in outcome)) {
    throw new Error(`expected a turn state, got ${outcome.error}`);
  }
  return outcome;
}

// ---- databases and clients ------------------------------------------------------------------------------------------

let db: TestDatabase;
/** Connections that run as rosie_job, with this file's schema first. */
let runtime: Sql;
let typedColumns: Map<string, string>;
const wrappingKey = new Uint8Array(randomBytes(32));
const keys = {
  resolve: (name: string): Uint8Array | undefined => (name === WRAP_NAME ? wrappingKey : undefined),
};

beforeAll(async () => {
  db = await createTestDatabase({ name: "turn_state" });
  runtime = postgres(resolvePrimaryUrl(), {
    max: 10,
    onnotice: () => undefined,
    connection: {
      application_name: "rosie-t219-turn-state",
      search_path: `${db.schema}, public`,
      role: RUNTIME_ROLE,
    },
  });
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typedColumns = new Map(typed.map((column) => [column.key, column.type]));
}, 60_000);

afterAll(async () => {
  await runtime.end({ timeout: 5 });
  await db.drop();
});

/** Empties every table (truncating the heads cascades to the rest; this file's schema only). */
async function reset(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags cascade`;
}

/** A real data key for a person, wrapped under the test wrapping key in sealing.ts's v1 form. */
async function realWrappedKey(personId: string): Promise<Uint8Array> {
  const wrapper = await crypto.subtle.importKey("raw", wrappingKey, { name: "AES-GCM" }, false, ["wrapKey"]);
  const dataKey = (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ])) as CryptoKey;
  const iv = new Uint8Array(randomBytes(12));
  const body = new Uint8Array(
    await crypto.subtle.wrapKey("raw", dataKey, wrapper, {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(`rosie:wrap:v1:${personId}`),
    }),
  );
  return Uint8Array.from([0x01, ...iv, ...body]);
}

async function insertRow(sql: Db, table: string, row: Record<string, Json>): Promise<void> {
  const values: Record<string, never> = {};
  for (const [column, value] of Object.entries(row)) {
    const type = typedColumns.get(`${table}.${column}`);
    let converted: unknown = value;
    if (type === "jsonb" && value !== null) {
      converted = sql.json(value);
    } else if (type === "bytea" && typeof value === "string") {
      const person = row.person_id;
      converted =
        table === "sealing_keys" && column === "wrapped_key" && typeof person === "string"
          ? await realWrappedKey(person)
          : fromHex(value.replace(/^\\x/, ""));
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

/** `<part>/<file>`, a seed of another database part (K-05 v1.2 given.partSeeds), in that part's fixtures folder. */
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

/** A fixture's chain: the seeds of every exchange in it, and the exchanges its `after` runs first, in order. */
function chainOf(file: string, seen = new Set<string>()): { seeds: URL[]; steps: string[] } {
  const exchange = exchangeOf(file);
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
    const inner = chainOf(before, seen);
    seeds.push(...inner.seeds);
    steps.push(...inner.steps, before);
  }
  return { seeds, steps };
}

// ---- the steps a chain runs first (as targets.int.test.ts writes them) ----------------------------------------------

interface CommitRequest {
  turn: {
    id: string;
    handleId: string;
    eventIds: string[];
    bundleId: { hash: string; build: number };
    traceId: string;
    joinedTraceIds: string[];
    tries: number;
  };
  writes: {
    state: (
      | { op: "insert"; table: string; values: Record<string, Json> }
      | {
          op: "update";
          table: string;
          key: Record<string, string>;
          expectVersion: number;
          set: Record<string, Json>;
        }
    )[];
    openQuestions: { open: Record<string, Json>[]; close: unknown[] };
    clockRows: { make: Record<string, Json>[]; cancel: unknown[] };
    outboxRows: Record<string, Json>[];
    reservations: { confirm: unknown[]; release: unknown[] };
  };
}

interface ClaimedRow {
  outboxRowId: string;
  version: number;
  finalParts: { sends: { kind: string }[] };
  parts: { partNo: number; tryNo: number; idempotencyKey: string; attempts: number }[];
}

async function expectOne(rows: Promise<readonly unknown[]>, what: string): Promise<void> {
  expect((await rows).length, what).toBe(1);
}

/** commitTurn's writes as its exchange states them (the turn, state writes, open questions, clock rows, outbox rows). */
async function commitStep(sql: Db, exchange: Exchange): Promise<void> {
  const { turn, writes } = exchange.request as unknown as CommitRequest;
  const { committedAt } = exchange.outcome as { committedAt: string };
  const unsupported = [
    writes.openQuestions.close,
    writes.clockRows.cancel,
    writes.reservations.confirm,
    writes.reservations.release,
  ];
  if (unsupported.some((list) => list.length > 0)) {
    throw new Error("this test's commit step writes no closes, cancels or reservation moves");
  }
  await insertRow(sql, "turns", {
    id: turn.id,
    handle_id: turn.handleId,
    event_ids: turn.eventIds,
    state: "committed",
    bundle_hash: turn.bundleId.hash,
    bundle_build: turn.bundleId.build,
    trace_id: turn.traceId,
    joined_trace_ids: turn.joinedTraceIds,
    tries: turn.tries,
    committed_at: committedAt,
  });
  for (const write of writes.state) {
    if (write.op === "insert") {
      await insertRow(sql, write.table, write.values);
    } else {
      throw new Error("this test's commit step writes no state updates");
    }
  }
  for (const question of writes.openQuestions.open) {
    await insertRow(sql, "open_questions", {
      id: question.id ?? null,
      turn_id: turn.id,
      handle_id: question.handleId ?? null,
      person_id: question.personId ?? null,
      business_id: question.businessId ?? null,
      booking_id: question.bookingId ?? null,
      step: question.step ?? null,
      options: question.options ?? null,
      readback: question.readback ?? null,
      versions_read: question.versionsRead ?? null,
      bundle_hash: turn.bundleId.hash,
      bundle_build: turn.bundleId.build,
      clock: question.clock ?? null,
    });
  }
  for (const clock of writes.clockRows.make) {
    await insertRow(sql, "clock_rows", {
      id: clock.id ?? null,
      kind: clock.kind ?? null,
      open_question_id: clock.openQuestionId ?? null,
      reservation_id: clock.reservationId ?? null,
      handle_id: clock.handleId ?? null,
      business_id: clock.businessId ?? null,
      booking_id: clock.bookingId ?? null,
      fires: clock.fires ?? null,
      created_by_turn_id: turn.id,
    });
  }
  for (const row of writes.outboxRows) {
    await insertRow(sql, "outbox_rows", {
      id: row.id ?? null,
      turn_id: turn.id,
      recipient_handle_id: row.recipientHandleId ?? null,
      recipient_person_id: row.recipientPersonId ?? null,
      business_id: row.businessId ?? null,
      booking_id: row.bookingId ?? null,
      channel: row.channel ?? null,
      send_class: row.sendClass ?? null,
      versions_read: row.versionsRead ?? null,
      open_question_id: row.openQuestionId ?? null,
      copy_of_row_id: row.copyOfRowId ?? null,
      bundle_hash: turn.bundleId.hash,
      bundle_build: turn.bundleId.build,
      trace_id: turn.traceId,
    });
  }
}

/** writePlan: the plan and final parts, the row checked, its version raised (K-05 item 2; K-07). */
async function writePlanStep(sql: Db, exchange: Exchange): Promise<void> {
  const request = exchange.request as {
    outboxRowId: string;
    expectVersion: number;
    plan: Json;
    finalParts: Json;
  };
  const { version } = exchange.outcome as { version: number };
  await expectOne(
    sql`
      update outbox_rows set plan = ${sql.json(request.plan)},
        final_parts = ${sql.json(request.finalParts)}, state = 'checked', version = ${version}
      where id = ${request.outboxRowId} and version = ${request.expectVersion}
      returning id
    `,
    "writePlan",
  );
}

/** claimOutbox: each claimed row sending at its new version, its parts pending under their keys. */
async function claimStep(sql: Db, exchange: Exchange): Promise<void> {
  for (const claimed of exchange.outcome.claimed as unknown as ClaimedRow[]) {
    await expectOne(
      sql`
        update outbox_rows set state = 'sending', version = ${claimed.version}
        where id = ${claimed.outboxRowId} returning id
      `,
      "claim",
    );
    for (const part of claimed.parts) {
      await insertRow(sql, "outbox_parts", {
        outbox_row_id: claimed.outboxRowId,
        part_no: part.partNo,
        try_no: part.tryNo,
        idempotency_key: part.idempotencyKey,
        attempts: part.attempts,
        kind: claimed.finalParts.sends[part.partNo - 1]?.kind ?? "words",
        state: "pending",
      });
    }
  }
}

/** markPart: the part the outcome names moves as the request says; the row takes the outcome's state and version. */
async function markPartStep(sql: Db, exchange: Exchange): Promise<void> {
  const request = exchange.request as {
    outcome: "sent" | "delivered" | "failed";
    providerMessageId?: string | null;
    providerOptionIds?: string[];
    errorCode?: string;
    at: string;
  };
  const outcome = exchange.outcome as {
    outboxRowId: string;
    partNo: number;
    tryNo: number;
    nextKey: string | null;
    row: { state: string; version: number };
  };
  const key = `${outcome.outboxRowId}/${String(outcome.partNo)}/${String(outcome.tryNo)}`;
  const messageId = request.providerMessageId ?? null;
  if (request.outcome === "sent") {
    await expectOne(
      sql`
        update outbox_parts set state = 'sent', sent_at = ${request.at}, linq_message_id = ${messageId},
          linq_option_ids = ${request.providerOptionIds === undefined ? null : sql.json(request.providerOptionIds)},
          version = version + 1
        where idempotency_key = ${key} returning part_no
      `,
      "mark sent",
    );
  } else if (request.outcome === "delivered") {
    await expectOne(
      sql`
        update outbox_parts set state = 'delivered', delivered_at = ${request.at},
          linq_message_id = coalesce(linq_message_id, ${messageId}), version = version + 1
        where idempotency_key = ${key} returning part_no
      `,
      "mark delivered",
    );
  } else {
    await expectOne(
      sql`
        update outbox_parts set state = 'failed', failed_at = ${request.at}, error_code = ${request.errorCode ?? null},
          linq_message_id = coalesce(linq_message_id, ${messageId}), version = version + 1
        where idempotency_key = ${key} returning part_no
      `,
      "mark failed",
    );
    if (outcome.nextKey !== null) {
      // The next try is a plain retry under a new key (K-07 "Parts": a refused poll goes again as words).
      await insertRow(sql, "outbox_parts", {
        outbox_row_id: outcome.outboxRowId,
        part_no: outcome.partNo,
        try_no: outcome.tryNo + 1,
        idempotency_key: outcome.nextKey,
        attempts: 1,
        kind: "words",
        state: "pending",
      });
    }
  }
  await expectOne(
    sql`
      update outbox_rows set state = ${outcome.row.state}, version = ${outcome.row.version}
      where id = ${outcome.outboxRowId} returning id
    `,
    "mark row",
  );
}

/** armClock: the question's clock row armed, the question moved from waiting to open (K-05 v1 default 8). */
async function armClockStep(sql: Db, exchange: Exchange): Promise<void> {
  const request = exchange.request as { openQuestionId: string };
  const { clock } = exchange.outcome as {
    clock: { clockRowId: string; version: number; armedAt: string; dueAt: string; dueZone: string };
  };
  await expectOne(
    sql`
      update clock_rows set state = 'armed', due_at = ${clock.dueAt}, due_zone = ${clock.dueZone},
        armed_at = ${clock.armedAt}, version = ${clock.version}
      where id = ${clock.clockRowId} returning id
    `,
    "arm clock",
  );
  await expectOne(
    sql`
      update open_questions set status = 'open', version = version + 1
      where id = ${request.openQuestionId} and status = 'waiting' returning id
    `,
    "open question",
  );
}

/** The chain steps of calls this test does not run for real, by call: each writes what its exchange states. */
const STEPS: Readonly<Record<string, Step>> = {
  commitTurn: commitStep,
  writePlan: writePlanStep,
  claimOutbox: claimStep,
  markPart: markPartStep,
  armClock: armClockStep,
};

/** Loads a fixture's seeds and runs its chain, so the database holds what its `given` says. */
async function given(file: string): Promise<Exchange> {
  const exchange = exchangeOf(file);
  const chain = chainOf(file);
  await reset();
  await loadSeeds(chain.seeds);
  for (const step of chain.steps) {
    const before = exchangeOf(step);
    if (before.call === "handleSealingKey") {
      const result = await handleSealingKey(
        runtime,
        keys,
        before.request as unknown as HandleSealingKeyRequest,
        { now: new Date(before.given.now) },
      );
      expect(result.outcome, step).toEqual(before.outcome);
      continue;
    }
    const run = STEPS[before.call];
    if (run === undefined) {
      throw new Error(`${step}: this test runs no ${before.call} step`);
    }
    await db.sql.begin((tx) => run(tx, before));
  }
  return exchange;
}

const requestOf = (exchange: Exchange): ReadTurnStateRequest =>
  exchange.request as unknown as ReadTurnStateRequest;
const nowOf = (exchange: Exchange): { now: Date } => ({ now: new Date(exchange.given.now) });

// ---- rows of other businesses and of none, beside read-turn-state-alex's state ---------------------------------------

/** The yoga studio's rows for Alex beside the barbershop's: a live question to his handle that went, two pauses, a yes. */
async function addYogaRows(): Promise<void> {
  await db.sql.begin(async (tx) => {
    await tx`
      insert into open_questions (id, turn_id, handle_id, person_id, business_id, booking_id, step, options,
                                  versions_read, bundle_hash, bundle_build, status)
      values ('oq-yoga-alex', 'turn-alex-move-1', 'handle-alex', 'person-alex', ${YOGA}, 'booking-alex-workshop',
              'A7-03', '[{"id": "A7-03/1", "label": "Sun 9:00am"}]'::jsonb, '[]'::jsonb, ${BUNDLE_HASH}, 1, 'open')
    `;
    await tx`
      insert into outbox_rows (id, turn_id, recipient_handle_id, recipient_person_id, business_id, booking_id, channel,
                               versions_read, open_question_id, state, bundle_hash, bundle_build, trace_id)
      values ('out-yoga-alex', 'turn-alex-move-1', 'handle-alex', 'person-alex', ${YOGA}, 'booking-alex-workshop',
              'imessage', '[]'::jsonb, 'oq-yoga-alex', 'delivered', ${BUNDLE_HASH}, 1, 'trace-yoga-0001')
    `;
    await tx`
      insert into outbox_parts (outbox_row_id, part_no, try_no, idempotency_key, kind, linq_message_id, state,
                                sent_at, delivered_at)
      values ('out-yoga-alex', 1, 1, 'out-yoga-alex/1/1', 'poll', 'linq-msg-demo-0090', 'delivered',
              '2026-10-23T15:00:00Z', '2026-10-23T15:00:01Z')
    `;
    await tx`
      insert into pauses (id, business_id, target, person_id, phone_number, set_at)
      values ('pause-yoga-alex', ${YOGA}, 'person', 'person-alex', null, '2026-10-22T10:00:00Z'),
             ('pause-yoga-alex-phone', ${YOGA}, 'phone', null, '+15555550101', '2026-10-22T10:05:00Z')
    `;
    await appendConsent(tx, {
      id: "consent-alex-yoga-texts",
      personId: "person-alex",
      businessId: YOGA,
      kind: "texts",
      handleId: "handle-alex",
      bookingId: "booking-alex-workshop",
      exactWords: "Texts about my workshop are fine",
      at: new Date("2026-10-01T10:00:00Z"),
      channel: "text",
    });
  });
}

/** Rows with no business for Alex: a START (covers every business) and a question asked before there was one. */
async function addNoBusinessRows(): Promise<void> {
  await db.sql.begin(async (tx) => {
    await appendConsent(tx, {
      id: "consent-alex-start",
      personId: "person-alex",
      businessId: null,
      kind: "texts",
      handleId: "handle-alex",
      exactWords: "START",
      at: new Date("2026-10-02T10:00:00Z"),
      channel: "text",
    });
    await tx`
      insert into open_questions (id, turn_id, handle_id, person_id, business_id, booking_id, step, options,
                                  versions_read, bundle_hash, bundle_build, status)
      values ('oq-nobiz-alex', 'turn-alex-move-1', 'handle-alex', 'person-alex', null, null, 'S1-01',
              '[{"id": "S1-01/1", "label": "Yes"}]'::jsonb, '[]'::jsonb, ${BUNDLE_HASH}, 1, 'waiting')
    `;
    await tx`
      insert into outbox_rows (id, turn_id, recipient_handle_id, recipient_person_id, business_id, channel,
                               versions_read, open_question_id, state, bundle_hash, bundle_build, trace_id)
      values ('out-nobiz-alex', 'turn-alex-move-1', 'handle-alex', 'person-alex', null, 'imessage', '[]'::jsonb,
              'oq-nobiz-alex', 'sent', ${BUNDLE_HASH}, 1, 'trace-nobiz-0001')
    `;
    await tx`
      insert into outbox_parts (outbox_row_id, part_no, try_no, idempotency_key, kind, linq_message_id, state, sent_at)
      values ('out-nobiz-alex', 1, 1, 'out-nobiz-alex/1/1', 'words', 'linq-msg-demo-0091', 'sent',
              '2026-11-01T12:00:00Z')
    `;
  });
}

const ALEX_PHONE = {
  number: "+15555550101",
  stopped: false,
  stopAt: null,
  chatOpen: true,
  chatWay: "imessage",
  linqContactAddedAt: "2026-10-12T16:20:00Z",
  pollVotedAt: "2026-10-23T14:06:10Z",
  optoutLineDeliveredAt: "2026-10-12T16:20:00Z",
  version: 3,
};

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("the side the read runs on (K-05 v1.2 item 26; T-191)", () => {
  it("the test client runs as rosie_job, with this file's schema first and no business scope", async () => {
    const [row] = await runtime<{ who: string; path: string; scope: string | null }[]>`
      select current_user as who, current_setting('search_path') as path,
             current_setting('rosie.business_id', true) as scope
    `;
    expect(row?.who).toBe(RUNTIME_ROLE);
    expect(row?.path).toBe(`${db.schema}, public`);
    expect(row?.scope ?? "").toBe("");
  });
});

describe("readTurnState: each K-05 v1.2 fixture gives its response (K-05 item 26)", () => {
  it("the index lists the frontier's six exchanges, each valid against data-access v1.2", SLOW, () => {
    expect([...TURN_STATE_FIXTURES].sort()).toEqual([
      "read-turn-state-alex.json",
      "read-turn-state-ben-stopped.json",
      "read-turn-state-delivered-after-4006.json",
      "read-turn-state-first-text.json",
      "read-turn-state-other-business.json",
      "read-turn-state-unknown-fact.json",
    ]);
    for (const file of TURN_STATE_FIXTURES) {
      expect(schemaErrors("readTurnState.exchange", exchangeOf(file)), file).toEqual([]);
    }
  });

  for (const file of TURN_STATE_FIXTURES) {
    it(
      `${file}: as rosie_job, on the request's side, the call answers the fixture's outcome`,
      SLOW,
      async () => {
        const exchange = await given(file);
        const outcome = await readTurnState(runtime, requestOf(exchange), nowOf(exchange));
        expect(outcome).toEqual(exchange.outcome);
        expect(outcomeErrors(outcome)).toEqual([]);
      },
    );
  }
});

describe("row-level security: a read under one business never returns another business's rows", () => {
  it(
    "under the barbershop, the yoga studio's role, question, pauses and yes for the same handle stay out",
    SLOW,
    async () => {
      const exchange = await given(ALEX_FIXTURE);
      await addYogaRows();
      await addNoBusinessRows();
      // The same answer as with none of those rows: nothing of the yoga studio's, nothing with no business.
      const outcome = await readTurnState(runtime, requestOf(exchange), nowOf(exchange));
      expect(outcome).toEqual(exchange.outcome);
    },
  );

  it(
    "under the yoga studio, only the yoga studio's rows: none of the barbershop's question, role or facts",
    SLOW,
    async () => {
      const exchange = await given(ALEX_FIXTURE);
      await addYogaRows();
      await addNoBusinessRows();
      const outcome = await readTurnState(
        runtime,
        {
          handleId: "handle-alex",
          businessId: YOGA,
          bookingIds: ["booking-alex-workshop"],
          facts: [{ key: "biz.name", table: "businesses", rowId: YOGA, column: "name" }],
        },
        nowOf(exchange),
      );
      expect(outcome).toEqual({
        result: "turnState",
        handleId: "handle-alex",
        handle: { kind: "phone", address: "+15555550101" },
        businessId: YOGA,
        readAt: exchange.given.now,
        persons: [{ personId: "person-alex", language: "en", version: 1 }],
        roles: [{ roleId: "role-alex-yoga", personId: "person-alex", role: "customer", version: 1 }],
        phone: ALEX_PHONE,
        openQuestions: [
          {
            id: "oq-yoga-alex",
            businessId: YOGA,
            bookingId: "booking-alex-workshop",
            personId: "person-alex",
            turnId: "turn-alex-move-1",
            step: "A7-03",
            status: "open",
            options: [{ id: "A7-03/1", label: "Sun 9:00am" }],
            readback: null,
            versionsRead: [],
            clock: null,
            sentAt: "2026-10-23T15:00:00Z",
            pollId: "linq-msg-demo-0090",
            askCount: 1,
            bundleId: { hash: BUNDLE_HASH, build: 1 },
            version: 1,
          },
        ],
        bookings: [
          {
            id: "booking-alex-workshop",
            businessId: YOGA,
            flow: "A",
            stage: "booked",
            bookerPersonId: "person-alex",
            servedPersonId: "person-alex",
            payerPersonId: "person-alex",
            private: false,
            deceased: false,
            version: 2,
          },
        ],
        pauses: [
          {
            id: "pause-yoga-alex",
            target: "person",
            personId: "person-alex",
            phoneNumber: null,
            setByTurnId: null,
            setAt: "2026-10-22T10:00:00Z",
            version: 1,
          },
          {
            id: "pause-yoga-alex-phone",
            target: "phone",
            personId: null,
            phoneNumber: "+15555550101",
            setByTurnId: null,
            setAt: "2026-10-22T10:05:00Z",
            version: 1,
          },
        ],
        consents: [
          {
            id: "consent-alex-yoga-texts",
            personId: "person-alex",
            businessId: YOGA,
            kind: "texts",
            revoked: false,
            handleId: "handle-alex",
            bookingId: "booking-alex-workshop",
            wordsSha256: sha256("Texts about my workshop are fine"),
            at: "2026-10-01T10:00:00Z",
            channel: "text",
            chatLinkId: null,
            turnId: null,
          },
        ],
        facts: [
          {
            key: "biz.name",
            table: "businesses",
            rowId: YOGA,
            column: "name",
            value: "Yoga studio",
            version: 2,
          },
        ],
      });
      expect(outcomeErrors(outcome)).toEqual([]);
    },
  );

  it(
    "another business's booking, business row, question or pause named under the barbershop is notFound",
    SLOW,
    async () => {
      const exchange = await given(ALEX_FIXTURE);
      await addYogaRows();
      const base: ReadTurnStateRequest = {
        handleId: "handle-alex",
        businessId: BARBERSHOP,
        bookingIds: [],
        facts: [],
      };
      const cases: [Partial<ReadTurnStateRequest>, { table: string; rowId: string }][] = [
        [
          { bookingIds: ["booking-alex-haircut", "booking-alex-workshop"] },
          { table: "bookings", rowId: "booking-alex-workshop" },
        ],
        [
          { facts: [{ key: "biz.name", table: "businesses", rowId: YOGA, column: "name" }] },
          { table: "businesses", rowId: YOGA },
        ],
        [
          { facts: [{ key: "q.step", table: "open_questions", rowId: "oq-yoga-alex", column: "step" }] },
          { table: "open_questions", rowId: "oq-yoga-alex" },
        ],
        [
          { facts: [{ key: "p.set", table: "pauses", rowId: "pause-yoga-alex", column: "set_at" }] },
          { table: "pauses", rowId: "pause-yoga-alex" },
        ],
        [
          { facts: [{ key: "b.stage", table: "bookings", rowId: "booking-alex-workshop", column: "stage" }] },
          { table: "bookings", rowId: "booking-alex-workshop" },
        ],
      ];
      for (const [change, missing] of cases) {
        const outcome = await readTurnState(runtime, { ...base, ...change }, nowOf(exchange));
        expect(outcome, missing.rowId).toEqual({ error: "notFound", ...missing });
        expect(outcomeErrors(outcome)).toEqual([]);
      }
    },
  );

  it(
    "the scope itself, not only the call's filters: under a business, rosie_job sees that business's rows only, and liveOpenQuestionsOfHandle (limit 3's reader) with them",
    SLOW,
    async () => {
      const exchange = await given(ALEX_FIXTURE);
      await addYogaRows();
      await addNoBusinessRows();
      const alex = asTurnState(exchange.outcome as unknown as ReadTurnStateOutcome);
      const scoped = await withBusiness(runtime, BARBERSHOP, async (tx) => ({
        questions: await liveOpenQuestionsOfHandle(tx, "handle-alex"),
        rows: await tx<{ home: string; id: string }[]>`
          select 'open_questions' as home, id from open_questions
          union all select 'outbox_rows', id from outbox_rows
          union all select 'person_roles', id from person_roles where person_id = 'person-alex'
          union all select 'bookings', id from bookings where booker_person_id = 'person-alex'
          union all select 'pauses', id from pauses
          union all select 'consents', id from consents where person_id = 'person-alex'
        `,
      }));
      expect(scoped.questions).toEqual(alex.openQuestions);
      expect(scoped.rows.map((row) => `${row.home}:${row.id}`).sort()).toEqual([
        "bookings:booking-alex-haircut",
        "open_questions:oq-a7-03-alex",
        "outbox_rows:out-a7-03-alex",
        "outbox_rows:out-a7-03-alex-email",
        "pauses:pause-ben-phone",
        "person_roles:role-alex-barber",
      ]);
      // On the runtime side, with no scope, the same reader sees every business's questions and those with none.
      const unscoped = await inRuntimeTransaction(runtime, { readOnly: true }, (tx) =>
        liveOpenQuestionsOfHandle(tx, "handle-alex"),
      );
      expect(unscoped.map((question) => question.id)).toEqual([
        "oq-a7-03-alex",
        "oq-nobiz-alex",
        "oq-yoga-alex",
      ]);
    },
  );

  it(
    "the call's own filters, not only the scope: run by the tables' owner, whom row-level security does not bind, the answer still holds the barbershop's rows only",
    SLOW,
    async () => {
      const exchange = await given(ALEX_FIXTURE);
      await addYogaRows();
      await addNoBusinessRows();
      const outcome = await db.sql.begin(async (tx) => {
        await setBusinessScope(tx, BARBERSHOP);
        return readTurnStateIn(tx, requestOf(exchange), nowOf(exchange));
      });
      expect(outcome).toEqual(exchange.outcome);
    },
  );
});

describe("primary, no cache: what committed just before is what the next read sees", () => {
  it(
    "a pause and a booking change are not seen while their transaction is open, and seen by the next read after the commit",
    SLOW,
    async () => {
      const exchange = await given(ALEX_FIXTURE);
      const request = requestOf(exchange);
      await db.sql.begin(async (tx) => {
        await tx`
        insert into pauses (id, business_id, target, person_id, set_at)
        values ('pause-alex-barber', ${BARBERSHOP}, 'person', 'person-alex', '2026-10-23T14:06:00Z')
      `;
        await tx`update bookings set stage = 'checked_in', version = 8 where id = 'booking-alex-haircut'`;
        const during = await readTurnState(runtime, request, nowOf(exchange));
        expect(during).toEqual(exchange.outcome);
      });
      const after = asTurnState(await readTurnState(runtime, request, nowOf(exchange)));
      expect(after.pauses.map((pause) => pause.id)).toEqual(["pause-alex-barber"]);
      expect(after.bookings.map((booking) => [booking.stage, booking.version])).toEqual([["checked_in", 8]]);
      expect(outcomeErrors(after)).toEqual([]);
    },
  );

  it(
    "ten commits in a row, each read straight after: every read has that commit's versions and rows",
    SLOW,
    async () => {
      const exchange = await given(ALEX_FIXTURE);
      const request: ReadTurnStateRequest = {
        ...requestOf(exchange),
        facts: [{ key: "pro.name", table: "persons", rowId: "person-riley", column: "name" }],
      };
      for (let round = 1; round <= 10; round += 1) {
        await db.sql.begin(async (tx) => {
          await tx`update bookings set version = version + 1 where id = 'booking-alex-haircut'`;
          await tx`update persons set name = ${`Riley ${String(round)}`}, version = version + 1 where id = 'person-riley'`;
          await appendConsent(tx, {
            id: `consent-alex-barber-${String(round).padStart(2, "0")}`,
            personId: "person-alex",
            businessId: BARBERSHOP,
            kind: "texts",
            revoked: round % 2 === 0,
            handleId: "handle-alex",
            exactWords:
              round % 2 === 0 ? "No more texts from the barbershop" : "Texts from the barbershop are fine",
            at: new Date(Date.UTC(2026, 9, 23, 14, 7, round)),
            channel: "text",
          });
        });
        const state = asTurnState(await readTurnState(runtime, request, nowOf(exchange)));
        expect(state.bookings[0]?.version, `round ${String(round)}`).toBe(7 + round);
        expect(state.facts, `round ${String(round)}`).toEqual([
          {
            key: "pro.name",
            table: "persons",
            rowId: "person-riley",
            column: "name",
            value: `Riley ${String(round)}`,
            version: 1 + round,
          },
        ]);
        expect(state.consents.length, `round ${String(round)}`).toBe(round);
        expect(state.consents.at(-1)?.revoked, `round ${String(round)}`).toBe(round % 2 === 0);
      }
    },
  );
});

describe("no business yet: the runtime side returns no row that has a business (K-05 v1.2 item 26; T-219's note)", () => {
  it(
    "roles, bookings and pauses are none; questions and consent rows only those with no business",
    SLOW,
    async () => {
      const exchange = await given(ALEX_FIXTURE);
      await addYogaRows();
      await addNoBusinessRows();
      await appendConsent(db.sql, {
        id: "consent-alex-barber-texts",
        personId: "person-alex",
        businessId: BARBERSHOP,
        kind: "texts",
        handleId: "handle-alex",
        exactWords: "Texts from the barbershop are fine",
        at: new Date("2026-10-03T10:00:00Z"),
        channel: "text",
      });
      await db.sql`
      insert into pauses (id, business_id, target, person_id, set_at)
      values ('pause-alex-barber', ${BARBERSHOP}, 'person', 'person-alex', '2026-10-23T14:06:00Z')
    `;
      const outcome = await readTurnState(
        runtime,
        {
          handleId: "handle-alex",
          businessId: null,
          bookingIds: [],
          facts: [
            { key: "pro.name", table: "persons", rowId: "person-riley", column: "name" },
            { key: "q.step", table: "open_questions", rowId: "oq-nobiz-alex", column: "step" },
          ],
        },
        nowOf(exchange),
      );
      expect(outcome).toEqual({
        result: "turnState",
        handleId: "handle-alex",
        handle: { kind: "phone", address: "+15555550101" },
        businessId: null,
        readAt: exchange.given.now,
        persons: [{ personId: "person-alex", language: "en", version: 1 }],
        roles: [],
        phone: ALEX_PHONE,
        openQuestions: [
          {
            id: "oq-nobiz-alex",
            businessId: null,
            bookingId: null,
            personId: "person-alex",
            turnId: "turn-alex-move-1",
            step: "S1-01",
            status: "waiting",
            options: [{ id: "S1-01/1", label: "Yes" }],
            readback: null,
            versionsRead: [],
            clock: null,
            sentAt: "2026-11-01T12:00:00Z",
            pollId: null,
            askCount: 1,
            bundleId: { hash: BUNDLE_HASH, build: 1 },
            version: 1,
          },
        ],
        bookings: [],
        pauses: [],
        consents: [
          {
            id: "consent-alex-start",
            personId: "person-alex",
            businessId: null,
            kind: "texts",
            revoked: false,
            handleId: "handle-alex",
            bookingId: null,
            wordsSha256: sha256("START"),
            at: "2026-10-02T10:00:00Z",
            channel: "text",
            chatLinkId: null,
            turnId: null,
          },
        ],
        facts: [
          {
            key: "pro.name",
            table: "persons",
            rowId: "person-riley",
            column: "name",
            value: "Riley",
            version: 1,
          },
          {
            key: "q.step",
            table: "open_questions",
            rowId: "oq-nobiz-alex",
            column: "step",
            value: "S1-01",
            version: 1,
          },
        ],
      });
      expect(outcomeErrors(outcome)).toEqual([]);
    },
  );

  it("a booking, or a fact on a row that has a business, is notFound with no business", SLOW, async () => {
    const exchange = await given(ALEX_FIXTURE);
    const base: ReadTurnStateRequest = {
      handleId: "handle-alex",
      businessId: null,
      bookingIds: [],
      facts: [],
    };
    const cases: [Partial<ReadTurnStateRequest>, { table: string; rowId: string }][] = [
      [{ bookingIds: ["booking-alex-haircut"] }, { table: "bookings", rowId: "booking-alex-haircut" }],
      [
        { facts: [{ key: "biz.name", table: "businesses", rowId: BARBERSHOP, column: "name" }] },
        { table: "businesses", rowId: BARBERSHOP },
      ],
      [
        { facts: [{ key: "q.step", table: "open_questions", rowId: "oq-a7-03-alex", column: "step" }] },
        { table: "open_questions", rowId: "oq-a7-03-alex" },
      ],
    ];
    for (const [change, missing] of cases) {
      const outcome = await readTurnState(runtime, { ...base, ...change }, nowOf(exchange));
      expect(outcome, missing.rowId).toEqual({ error: "notFound", ...missing });
    }
  });
});

describe("facts: only a home the frozen table list gives, never a key, a secret or a sealed value (default 30)", () => {
  it("FACT_HOMES is K-04 v1 core's versioned one-key tables, sealing_keys out, every column and type, the sealed two out", () => {
    const core = readJson(new URL("core/core.v1.tables.json", DB_SCHEMA_DIR)) as { tables: TableListTable[] };
    const homes = core.tables.filter(
      (table) => table.versioned && table.primaryKey.length === 1 && table.name !== "sealing_keys",
    );
    const sealed = homes.flatMap((table) =>
      table.columns
        .filter((column) => column.sealedBy !== undefined)
        .map((column) => `${table.name}.${column.name}`),
    );
    // K-04 rule 6 seals pauses.address; threads.ts stores messages.words sealed though the list types it as text.
    expect(sealed).toEqual(["pauses.address"]);
    const leftOut = new Set([...sealed, "messages.words"]);
    const expected = Object.fromEntries(
      homes.map((table) => [
        table.name,
        {
          key: table.primaryKey[0],
          scopedBy: table.rowLevelSecurity.scope === "business" ? table.rowLevelSecurity.column : null,
          columns: Object.fromEntries(
            table.columns
              .filter((column) => !leftOut.has(`${table.name}.${column.name}`))
              .map((column) => [column.name, column.type]),
          ),
        },
      ]),
    );
    expect(FACT_HOMES).toEqual(expected);
  });

  it(
    "the refused fixtures that name a sealing key or a session token's hash answer unknownFact, with nothing read",
    SLOW,
    async () => {
      await reset();
      for (const [file, key, table, column] of [
        ["refuse-read-turn-state-sealing-key-fact.json", "person.key", "sealing_keys", "wrapped_key"],
        ["refuse-read-turn-state-session-token-fact.json", "session.token", "sessions", "token_sha256"],
      ] as const) {
        const request = readJson(new URL(`invalid/${file}`, ACCESS_DIR)) as ReadTurnStateRequest;
        expect(schemaErrors("readTurnState.request", request), file).not.toEqual([]);
        // The database is empty, so any read would have answered notFound for the handle.
        const outcome = await readTurnState(runtime, request);
        expect(outcome, file).toEqual({ error: "unknownFact", key, table, column });
        expect(outcomeErrors(outcome)).toEqual([]);
      }
    },
  );

  it(
    "every name outside FACT_HOMES answers unknownFact, the first in the request's order",
    SLOW,
    async () => {
      const exchange = await given(ALEX_FIXTURE);
      const unknown: [string, string][] = [
        ["sealing_keys", "person_id"],
        ["sealing_keys", "created_at"],
        ["harm_reports", "id"],
        ["team_pages", "id"],
        ["team_page_recipients", "id"],
        ["parked_turns", "id"],
        ["dead_letters", "id"],
        ["gap_cases", "id"],
        ["review_items", "id"],
        ["live_turn_labels", "id"],
        ["proof_codes", "code_hash"],
        ["sessions", "device_sha256"],
        ["businesses", "website"],
        ["handles", "address"],
        ["person_handles", "person_id"],
        ["event_log", "sealed_values"],
        ["outbox_parts", "state"],
        ["bundles", "manifest_key"],
        ["pauses", "address"],
        ["messages", "words"],
        ["chat_links", "short_code"],
        ["consents", "exact_words"],
        ["effects", "state"],
        ["business_setup", "website"],
      ];
      for (const [table, column] of unknown) {
        const outcome = await readTurnState(
          runtime,
          {
            ...requestOf(exchange),
            facts: [
              { key: "biz.name", table: "businesses", rowId: BARBERSHOP, column: "name" },
              { key: "the.fact", table, rowId: "any-row", column },
              { key: "biz.status", table: "businesses", rowId: BARBERSHOP, column: "nonesuch" },
            ],
          },
          nowOf(exchange),
        );
        expect(outcome, `${table}.${column}`).toEqual({
          error: "unknownFact",
          key: "the.fact",
          table,
          column,
        });
        expect(outcomeErrors(outcome)).toEqual([]);
      }
    },
  );

  it(
    "a value reads as K-04's seed fixtures write it: text, numbers, booleans, jsonb, text[], times, timestamptz, tstzrange",
    SLOW,
    async () => {
      await reset();
      await loadSeeds(
        ["seed-reservation.json", "seed-outbox-row.json", "seed-phone-chat-open.json"].map(
          (seed) => new URL(seed, CORE_DIR),
        ),
      );
      const seeded = (file: string, table: string, key: string, id: string): Record<string, Json> => {
        const row = (readJson(new URL(file, CORE_DIR)) as SeedFile).rows.find(
          (candidate) => candidate.table === table && candidate.values[key] === id,
        );
        if (row === undefined) {
          throw new Error(`${file} has no ${table} row ${id}`);
        }
        return row.values;
      };
      const homes: [string, string, string, string][] = [
        ["seed-business-head.json", "businesses", "id", BARBERSHOP],
        ["seed-reservation.json", "reservations", "id", "rsv-alex-saved-avery"],
        ["seed-reservation.json", "reservations", "id", "rsv-alex-haircut"],
        ["seed-turn.json", "turns", "id", "turn-alex-move-1"],
        ["seed-open-question.json", "open_questions", "id", "oq-a7-03-alex"],
        ["seed-outbox-row.json", "outbox_rows", "id", "out-a7-03-alex"],
        ["seed-phone-chat-open.json", "phones", "number", "+15555550101"],
      ];
      for (const [file, table, key, id] of homes) {
        const values = seeded(file, table, key, id);
        const columns = Object.keys(values).filter(
          (column) => FACT_HOMES[table]?.columns[column] !== undefined,
        );
        const facts: FactRef[] = columns.map((column) => ({
          key: `${table}.${column}`,
          table,
          rowId: id,
          column,
        }));
        const state = asTurnState(
          await readTurnState(runtime, {
            handleId: "handle-alex",
            businessId: BARBERSHOP,
            bookingIds: [],
            facts,
          }),
        );
        expect(
          Object.fromEntries(state.facts.map((fact) => [fact.column, fact.value])),
          `${table} ${id}`,
        ).toEqual(Object.fromEntries(columns.map((column) => [column, values[column]])));
        expect(new Set(state.facts.map((fact) => fact.version)), `${table} ${id}`).toEqual(
          new Set([values.version]),
        );
        expect(outcomeErrors(state)).toEqual([]);
      }
      // A column the seed leaves out reads as its stored value: the bigint commit order as a JSON number.
      const order = asTurnState(
        await readTurnState(runtime, {
          handleId: "handle-alex",
          businessId: BARBERSHOP,
          bookingIds: [],
          facts: [{ key: "seq", table: "outbox_rows", rowId: "out-a7-03-alex", column: "commit_seq" }],
        }),
      );
      expect(Number.isSafeInteger(order.facts[0]?.value)).toBe(true);
    },
  );
});

describe("readTurnState: what the fixtures leave out", () => {
  it("a handle that does not exist, and a business that does not exist, are notFound", SLOW, async () => {
    const exchange = await given(ALEX_FIXTURE);
    expect(
      await readTurnState(runtime, { ...requestOf(exchange), handleId: "handle-nobody" }, nowOf(exchange)),
    ).toEqual({ error: "notFound", table: "handles", rowId: "handle-nobody" });
    const noBusiness = await readTurnState(
      runtime,
      { ...requestOf(exchange), businessId: "biz-nobody" },
      nowOf(exchange),
    );
    expect(noBusiness).toEqual({ error: "notFound", table: "businesses", rowId: "biz-nobody" });
    expect(outcomeErrors(noBusiness)).toEqual([]);
  });

  it("with no clock given, readAt is the database's now, in UTC", SLOW, async () => {
    const exchange = await given(ALEX_FIXTURE);
    const before = Date.now();
    const state = asTurnState(await readTurnState(runtime, requestOf(exchange)));
    expect(Math.abs(Date.parse(state.readAt) - before)).toBeLessThan(60_000);
    expect(outcomeErrors(state)).toEqual([]);
  });

  it(
    "readTurnStateIn runs only on the request's side: its business's scope, or with no business none",
    SLOW,
    async () => {
      const exchange = await given(ALEX_FIXTURE);
      const request = requestOf(exchange);
      expect(
        await withBusiness(runtime, BARBERSHOP, (tx) => readTurnStateIn(tx, request, nowOf(exchange))),
      ).toEqual(exchange.outcome);
      await expect(withBusiness(runtime, YOGA, (tx) => readTurnStateIn(tx, request))).rejects.toThrow(
        BusinessScopeError,
      );
      await expect(
        inRuntimeTransaction(runtime, { readOnly: true }, (tx) => readTurnStateIn(tx, request)),
      ).rejects.toThrow(BusinessScopeError);
      await expect(
        withBusiness(runtime, BARBERSHOP, (tx) => readTurnStateIn(tx, { ...request, businessId: null })),
      ).rejects.toThrow("readTurnState with no business runs on the runtime side");
    },
  );

  it("a request of the wrong shape is refused before any read, naming the field, never a value", async () => {
    const valid: ReadTurnStateRequest = {
      handleId: "handle-alex",
      businessId: BARBERSHOP,
      bookingIds: [],
      facts: [],
    };
    const withoutRow = readJson(
      new URL("invalid/refuse-read-turn-state-fact-without-row.json", ACCESS_DIR),
    ) as ReadTurnStateRequest;
    const refused: [unknown, string][] = [
      [withoutRow, "each fact is exactly {key, table, rowId, column}"],
      [{ ...valid, extra: true }, "the request takes only handleId, businessId, bookingIds, facts"],
      [{ handleId: "handle-alex", bookingIds: [], facts: [] }, "the request needs businessId"],
      [{ ...valid, handleId: "" }, "handleId is a non-empty id"],
      [{ ...valid, businessId: "  " }, "a business scope needs a non-empty business id"],
      [{ ...valid, bookingIds: "booking-alex-haircut" }, "bookingIds is a list"],
      [{ ...valid, bookingIds: ["booking-alex-haircut", "booking-alex-haircut"] }, "names each booking once"],
      [
        { ...valid, facts: [{ key: "", table: "businesses", rowId: BARBERSHOP, column: "name" }] },
        "key is a non-empty",
      ],
      [
        { ...valid, facts: [{ key: "k", table: "Businesses", rowId: BARBERSHOP, column: "name" }] },
        "a fact's table is a plain lower-case name",
      ],
      [
        { ...valid, facts: [{ key: "k", table: "businesses", rowId: BARBERSHOP, column: "name; drop" }] },
        "a fact's column is a plain lower-case name",
      ],
      [
        { ...valid, facts: [{ key: "k", table: "businesses", rowId: BARBERSHOP, column: "name", extra: 1 }] },
        "each fact is exactly {key, table, rowId, column}",
      ],
    ];
    for (const [request, message] of refused) {
      await expect(readTurnState(runtime, request as ReadTurnStateRequest), message).rejects.toThrow(message);
    }
    expect(schemaErrors("readTurnState.request", withoutRow)).not.toEqual([]);
  });
});
