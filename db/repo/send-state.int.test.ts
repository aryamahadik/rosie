// T-220: K-05 v1.2's sendState, limit 8's read of a recipient's send state, against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/send-state`). The schema comes from migrating a fresh test
// schema. T-1216: K-05 v1.8's item 47, the texts row's fromContact and bookingId (who gave the yes, and for which
// booking), and every v1.8 sendState fixture.
//
// Every call runs on the runtime side as K-05 v1.2 states it (README line 153): through a client whose connections run
// as rosie_job (T-191: the dispatcher's role) with no business scope, so the grants and row-level security are the
// ones limit 8 meets. That client records every statement it sends (postgres.js `debug`: the text, never the values), so
// a test reads what the call sent. The tables' owner (the migrations' role) writes the seeds and the state a fixture's
// `given` names.
//
// A fixture's `given.after` names the exchanges that run first (each with its own `given`). reserve (T-187) runs for
// real. Each commit, plan and claim step writes, directly and as the owner, the rows its exchange states in its request
// and its outcome: what the reads that follow see (db/repo/commit-turn.int.test.ts runs every commit exchange through
// the real commitTurn). A STOP is committed the way the guard's path will (T-183's setPhoneStopped and T-192's
// appendConsent in one transaction).
//
// Every answer is checked against data-access v1.8's sendState.v1dot8Response (the answer a v1.8 call gives: fromContact
// and bookingId always stated), with Ajv 2020-12, strict, as contracts:check runs it; each exchange against v1.8 and the
// version its index entry lists.
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "./client";
import { DataAccessDatabaseError } from "./clocks";
import { appendConsent, type NewConsent } from "./consent";
import { setPhoneStopped } from "./phones";
import { reserve, type ReserveRequest } from "./reservations";
import { type Sql, type Tx, withBusiness } from "./scope";
import {
  currentVersionsOf,
  sendState,
  sendStateIn,
  type SendStateRequest,
  type SendStateV1Dot8Outcome,
  type SendStateV1Dot8Response,
  type TextsConsentV1Dot8,
  VERSIONED_HOMES,
} from "./send-state";
import { rowBound, SETUP_FACT_HOMES, UNSCOPED_ROWS } from "./setup/fact-homes";
import { rowNameSql } from "./setup/row-names";
import { readTurnState } from "./setup/turn-state";
import { createTestDatabase, type TestDatabase } from "./test-db";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Step = (sql: Db, exchange: Exchange) => Promise<void>;

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
/** K-29 v1's seeds (the conversations and consent part): each names its K-04 seeds by a path from its own folder. */
const CONSENT_DIR = new URL("db-schema/conversations-consent/fixtures/", CONTRACTS);
const RUNTIME_ROLE = "rosie_job";
const HASH = "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037";
const ALEX_MOBILE = "+15555550101";
const ALEX_ROW = "out-alex-booked-riley";
const BARBERSHOP = "biz-lees-barbershop";
const NOV14 = "booking-alex-riley-nov14";
const SLOW = { timeout: 60_000 };

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

interface SeedFile {
  after: string[];
  rows: { table: string; values: Record<string, Json> }[];
}

interface IndexEntry {
  file: string;
  version: string;
  def?: string;
  expect: string;
}

interface ContractTable {
  name: string;
  primaryKey?: string[];
  versioned: boolean;
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const exchangeOf = (file: string): Exchange => readJson(new URL(file, ACCESS_DIR)) as Exchange;
const INDEX = (readJson(new URL("index.json", ACCESS_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const SEND_STATE_ENTRIES = INDEX.filter((entry) => entry.def === "sendState.exchange");
const SEND_STATE_FIXTURES = SEND_STATE_ENTRIES.map((entry) => entry.file);

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
/** The $id of data-access at one version (`data-access.<version>.schema.json`, the version an index entry lists). */
function schemaIdOf(version: string): string {
  return (readJson(new URL(`data-access/data-access.${version}.schema.json`, CONTRACTS)) as { $id: string })
    .$id;
}
const V18_ID = schemaIdOf("v1.8");

/** Checks `value` against one $defs entry of data-access v1.8, or of the schema given, returning Ajv's errors. */
function schemaErrors(def: string, value: unknown, schemaId = V18_ID): string[] {
  const validate = ajv.getSchema(`${schemaId}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`${schemaId} has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

// ---- databases and clients ------------------------------------------------------------------------------------------

let db: TestDatabase;
/** Connections that run as rosie_job, the runtime side, with this file's schema first. */
let runtime: Sql;
let typedColumns: Map<string, string>;
/** Every statement the runtime client sent, in order (postgres.js debug: the text, never the values). */
const sent: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase({ name: "send_state" });
  runtime = postgres(resolvePrimaryUrl(), {
    max: 10,
    onnotice: () => undefined,
    debug: (_connection: number, query: string) => {
      sent.push(query);
    },
    connection: {
      application_name: "rosie-t220-send-state",
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

/** A seed's rows after those of the seeds its `after` names, each path read from the seed's own folder; each seed once. */
function seedRows(seed: URL, seen: Set<string>): SeedFile["rows"] {
  if (seen.has(seed.href)) {
    return [];
  }
  seen.add(seed.href);
  const file = readJson(seed) as SeedFile;
  return [...file.after.flatMap((before) => seedRows(new URL(before, seed), seen)), ...file.rows];
}

/** A fixture's chain: the K-04 seeds of every exchange in it, and the exchanges its `after` runs first, in order. */
function chainOf(file: string, seen = new Set<string>()): { seeds: string[]; steps: string[] } {
  const exchange = exchangeOf(file);
  if (exchange.given.partSeeds !== undefined && exchange.given.partSeeds.length > 0) {
    throw new Error(`${file}: partSeeds are not loaded by this test`);
  }
  const seeds = [...exchange.given.k04Seeds];
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

// ---- the steps a chain runs first -----------------------------------------------------------------------------------

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
    openQuestions: { open: unknown[]; close: unknown[] };
    clockRows: { make: unknown[]; cancel: unknown[] };
    outboxRows: Record<string, Json>[];
    reservations: {
      confirm: { id: string; expectVersion: number; bookingId: string }[];
      release: { id: string; expectVersion: number; why: string }[];
    };
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

/** commitTurn's writes as its exchange states them: the turn, the state writes, the outbox rows, the reservations. */
async function commitStep(sql: Db, exchange: Exchange): Promise<void> {
  const { turn, writes } = exchange.request as unknown as CommitRequest;
  const { committedAt } = exchange.outcome as { committedAt: string };
  const unsupported = [
    writes.openQuestions.open,
    writes.openQuestions.close,
    writes.clockRows.make,
    writes.clockRows.cancel,
  ];
  if (unsupported.some((list) => list.length > 0)) {
    throw new Error("this test's commit step writes no open questions or clock rows");
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
      continue;
    }
    const [key] = Object.entries(write.key);
    if (key === undefined) {
      throw new Error("an update names its row's key");
    }
    const set: Record<string, never> = { version: (write.expectVersion + 1) as never };
    for (const [column, value] of Object.entries(write.set)) {
      set[column] = value as never;
    }
    await expectOne(
      sql`
        update ${sql(write.table)} set ${sql(set)}
        where ${sql(key[0])} = ${key[1]} and version = ${write.expectVersion}
        returning version
      `,
      `update ${write.table}`,
    );
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
  for (const confirm of writes.reservations.confirm) {
    await expectOne(
      sql`
        update reservations set state = 'booked', booking_id = ${confirm.bookingId},
          version = ${confirm.expectVersion + 1}
        where id = ${confirm.id} and version = ${confirm.expectVersion} returning id
      `,
      "confirm",
    );
  }
  for (const release of writes.reservations.release) {
    await expectOne(
      sql`
        update reservations set state = 'released', released_at = ${committedAt}, released_why = ${release.why},
          version = ${release.expectVersion + 1}
        where id = ${release.id} and version = ${release.expectVersion} returning id
      `,
      "release",
    );
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

/** The chain steps of calls this file writes as their exchanges state, by call. */
const STEPS: Readonly<Record<string, Step>> = {
  commitTurn: commitStep,
  writePlan: writePlanStep,
  claimOutbox: claimStep,
};

/**
 * Loads a fixture's seeds and runs its chain, so the database holds what its `given` says. `partSeeds` are seeds of
 * another part (K-29's), loaded after the fixture's own K-04 seeds, each seed once.
 */
async function given(file: string, partSeeds: readonly URL[] = []): Promise<Exchange> {
  const exchange = exchangeOf(file);
  const chain = chainOf(file);
  await reset();
  const seen = new Set<string>();
  const seeds = [...chain.seeds.map((seed) => new URL(seed, CORE_DIR)), ...partSeeds];
  const rows = seeds.flatMap((seed) => seedRows(seed, seen));
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
    }
  });
  for (const step of chain.steps) {
    const before = exchangeOf(step);
    if (before.call === "reserve") {
      expect(await reserve(db.sql, before.request as unknown as ReserveRequest), step).toEqual(
        before.outcome,
      );
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

/** The answer, which must be a send state, valid against v1.8's sendState.v1dot8Response (README item 47). */
function stateOf(outcome: SendStateV1Dot8Outcome): SendStateV1Dot8Response {
  if (!("result" in outcome)) {
    throw new Error(`expected a send state, got ${JSON.stringify(outcome)}`);
  }
  expect(schemaErrors("sendState.v1dot8Response", outcome)).toEqual([]);
  return outcome;
}

/** Adds an outbox row of Alex's booking turn, sending, with the values given over these. */
async function addOutboxRow(values: Record<string, Json>): Promise<void> {
  await insertRow(db.sql, "outbox_rows", {
    turn_id: "turn-alex-book-1",
    recipient_handle_id: "handle-alex",
    recipient_person_id: "person-alex",
    business_id: BARBERSHOP,
    channel: "imessage",
    send_class: "routine",
    versions_read: [],
    state: "sending",
    bundle_hash: HASH,
    bundle_build: 1,
    trace_id: "trace-t220-0001",
    ...values,
  });
}

/** STOP (true) or START (false) on Alex's mobile, as the guard's path commits it: the flag and the consent row. */
async function stopOrStart(sql: Db, stopped: boolean, at: string, id: string): Promise<void> {
  const changed = await setPhoneStopped(sql, ALEX_MOBILE, stopped, { at: new Date(at) });
  expect(changed?.changed).toBe(true);
  await appendConsent(sql, {
    id,
    personId: "person-alex",
    businessId: null,
    kind: "texts",
    revoked: stopped,
    handleId: "handle-alex",
    exactWords: stopped ? "STOP" : "START",
    at: new Date(at),
    channel: "text",
  });
}

/** A committed turn of a handle, as a commit writes one (K-04 turns), for a consent row to name as its writer. */
async function addTurn(id: string, handleId: string, at: string): Promise<void> {
  await insertRow(db.sql, "turns", {
    id,
    handle_id: handleId,
    event_ids: [`evt-${id}`],
    state: "committed",
    bundle_hash: HASH,
    bundle_build: 1,
    trace_id: `trace-${id}`,
    committed_at: at,
  });
}

/**
 * Appends a texts consent row (K-29 v1 consents), by default Alex's yes for his mobile at the barbershop, given by text
 * with no turn, booking or link, with the values given over these.
 */
async function addTextsRow(id: string, at: string, values: Partial<NewConsent> = {}): Promise<void> {
  await appendConsent(db.sql, {
    id,
    personId: "person-alex",
    businessId: BARBERSHOP,
    kind: "texts",
    handleId: "handle-alex",
    exactWords: "Yes, text me about my booking",
    channel: "text",
    ...values,
    at: new Date(at),
  });
}

/** The texts row the read gives for an outbox row now (its whole answer checked by stateOf). */
async function textsRowOf(outboxRowId: string): Promise<TextsConsentV1Dot8 | null> {
  return stateOf(await sendState(runtime, { outboxRowId })).textsConsent;
}

/**
 * The two fields a v1.8 call adds to the texts row of each sendState exchange listed before v1.8 (T-1216's card):
 * send-state-stopped holds Alex's STOP for every business, which withdraws and names no booking (fromContact false,
 * bookingId null); the other four hold no texts row, so their answer is their outcome as it stands.
 */
const ADDED_IN_V18: Readonly<Record<string, { fromContact: boolean; bookingId: string | null } | null>> = {
  "send-state-booking-cancelled.json": null,
  "send-state-customer.json": null,
  "send-state-no-chat.json": null,
  "send-state-owner.json": null,
  "send-state-stopped.json": { fromContact: false, bookingId: null },
};

/** The answer a v1.8 call gives for an exchange: its outcome, with item 47's two fields added to one listed earlier. */
function v1dot8AnswerOf(entry: IndexEntry, exchange: Exchange): Record<string, Json> {
  if (entry.version === "v1.8") {
    return exchange.outcome;
  }
  const added = ADDED_IN_V18[entry.file];
  if (added === undefined) {
    throw new Error(`${entry.file}: no v1.8 fields are pinned for this exchange`);
  }
  const consent = exchange.outcome.textsConsent;
  if (added === null) {
    expect(consent, `${entry.file} holds no texts row`).toBeNull();
    return exchange.outcome;
  }
  if (typeof consent !== "object" || consent === null || Array.isArray(consent)) {
    throw new Error(`${entry.file}: its outcome holds no texts row`);
  }
  return { ...exchange.outcome, textsConsent: { ...consent, ...added } };
}

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("sendState: each K-05 sendState fixture gives its response (v1.2 item 28; v1.8 item 47)", () => {
  it("the index lists limit 8's nine exchanges, each valid against data-access v1.8 and the version it is listed under", () => {
    expect([...SEND_STATE_FIXTURES].sort()).toEqual([
      "send-state-booking-cancelled.json",
      "send-state-business-yes.json",
      "send-state-customer.json",
      "send-state-no-chat.json",
      "send-state-own-start.json",
      "send-state-own-yes-one-booking.json",
      "send-state-owner.json",
      "send-state-stop-row.json",
      "send-state-stopped.json",
    ]);
    for (const { file, version } of SEND_STATE_ENTRIES) {
      for (const schemaId of [V18_ID, schemaIdOf(version)]) {
        expect(
          schemaErrors("sendState.exchange", exchangeOf(file), schemaId),
          `${file} at ${schemaId}`,
        ).toEqual([]);
      }
    }
  });

  it("the test client runs as rosie_job, with this file's schema first and no business scope", async () => {
    const [row] = await runtime<{ who: string; scope: string | null }[]>`
      select current_user as who, current_setting('rosie.business_id', true) as scope
    `;
    expect(row?.who).toBe(RUNTIME_ROLE);
    expect(row?.scope ?? "").toBe("");
  });

  for (const entry of SEND_STATE_ENTRIES) {
    it(
      `${entry.file}: as rosie_job with no business scope, the call answers the fixture's outcome (${entry.version}), valid at sendState.v1dot8Response`,
      SLOW,
      async () => {
        const exchange = await given(entry.file);
        const outcome = await sendState(runtime, exchange.request as unknown as SendStateRequest, {
          now: new Date(exchange.given.now),
        });
        expect(outcome).toEqual(v1dot8AnswerOf(entry, exchange));
        expect(schemaErrors("sendState.v1dot8Response", outcome)).toEqual([]);
      },
    );
  }
});

describe("right after a STOP commits, send state says stopped (the primary, no cache)", () => {
  it(
    "while the STOP's transaction is open the read sees the phone as it was; once it commits, the next read says stopped",
    SLOW,
    async () => {
      await given("send-state-customer.json");
      const before = stateOf(await sendState(runtime, { outboxRowId: ALEX_ROW }));
      expect([before.phone?.stopped, before.phone?.chatOpen, before.textsConsent]).toEqual([
        false,
        true,
        null,
      ]);

      const stop = await runtime.reserve();
      try {
        await stop`begin`;
        await stopOrStart(stop, true, "2026-11-07T15:06:36Z", "consent-alex-stop-t220");
        // Not committed yet: the dispatcher's read never sees a write that may still roll back.
        const during = stateOf(await sendState(runtime, { outboxRowId: ALEX_ROW }));
        expect([during.phone?.stopped, during.textsConsent]).toEqual([false, null]);
        await stop`commit`;
      } finally {
        stop.release();
      }

      const after = stateOf(await sendState(runtime, { outboxRowId: ALEX_ROW }));
      expect(after.phone).toMatchObject({
        stopped: true,
        stopAt: "2026-11-07T15:06:36Z",
        chatOpen: false,
        version: 4,
      });
      // The STOP withdraws: no yes, so never the person's own (default 82), and it names no booking.
      expect(after.textsConsent).toEqual({
        consentId: "consent-alex-stop-t220",
        businessId: null,
        revoked: true,
        at: "2026-11-07T15:06:36Z",
        fromContact: false,
        bookingId: null,
      });
      expect(after.rowState).toBe("sending");
      expect(schemaErrors("sendState.v1dot8Response", after)).toEqual([]);
    },
  );

  it(
    "ten STOPs and STARTs in a row: each read right after each commit follows it, through one pool",
    SLOW,
    async () => {
      await given("send-state-customer.json");
      for (let round = 1; round <= 10; round += 1) {
        const stopped = round % 2 === 1;
        const at = new Date(Date.parse("2026-11-07T15:07:00Z") + round * 1000).toISOString();
        await runtime.begin((tx) => stopOrStart(tx, stopped, at, `consent-alex-round-${String(round)}`));
        const state = stateOf(await sendState(runtime, { outboxRowId: ALEX_ROW }));
        expect(
          [state.phone?.stopped, state.phone?.chatOpen, state.phone?.version],
          `round ${String(round)}`,
        ).toEqual([stopped, !stopped, 3 + round]);
        // A START with no turn, written on return, is the number's own word (item 47); a STOP is no yes. Neither names
        // a booking.
        expect(state.textsConsent, `round ${String(round)}`).toMatchObject({
          consentId: `consent-alex-round-${String(round)}`,
          businessId: null,
          revoked: stopped,
          fromContact: !stopped,
          bookingId: null,
        });
      }
    },
  );
});

describe("sendState: what the fixtures leave out", () => {
  it("a row that does not exist answers notFound", async () => {
    await reset();
    const outcome = await sendState(runtime, { outboxRowId: "out-nobody" });
    expect(outcome).toEqual({ error: "notFound", table: "outbox_rows", rowId: "out-nobody" });
    expect(schemaErrors("sendState.errors", outcome)).toEqual([]);
  });

  it("refuse-send-state-caller-versions.json: the schema refuses it, and so does the call, before any read", async () => {
    const refused = readJson(new URL("invalid/refuse-send-state-caller-versions.json", ACCESS_DIR)) as Record<
      string,
      Json
    >;
    expect(schemaErrors("sendState.request", refused)).not.toEqual([]);
    await expect(sendState(runtime, refused as unknown as SendStateRequest)).rejects.toThrow(
      "sendState: the request takes only outboxRowId",
    );
    // Without its one fault (the versions it carries), the request is accepted.
    expect(schemaErrors("sendState.request", { outboxRowId: refused.outboxRowId })).toEqual([]);
  });

  it("under a business scope the call refuses to run: a scope hides the STOP row, which has no business", async () => {
    await given("send-state-stopped.json");
    await expect(
      withBusiness(runtime, BARBERSHOP, (tx) => sendStateIn(tx, { outboxRowId: ALEX_ROW })),
    ).rejects.toThrow("sendState runs on the runtime side, with no business scope");
  });

  it(
    "the record flags: the booking's private and deceased with the person served, the open pauses on the recipient at the row's business",
    SLOW,
    async () => {
      const exchange = await given("send-state-customer.json");
      await db.sql.begin(async (tx) => {
        await tx`update bookings set private = true, deceased = true, served_person_id = 'person-riley',
                   version = version + 1
                 where id = 'booking-alex-riley-nov14'`;
        await insertRow(tx, "turns", {
          id: "turn-sam-pauses",
          handle_id: "handle-sam",
          event_ids: ["evt-sam-0040"],
          state: "committed",
          bundle_hash: HASH,
          bundle_build: 1,
          trace_id: "trace-sam-0040",
          committed_at: "2026-11-07T15:00:00Z",
        });
        const pause = (values: Record<string, Json>): Promise<void> =>
          insertRow(tx, "pauses", { set_at: "2026-11-07T15:00:00Z", ...values });
        await pause({
          id: "pause-b-alex-phone",
          business_id: BARBERSHOP,
          target: "phone",
          phone_number: ALEX_MOBILE,
          set_by_turn_id: "turn-sam-pauses",
        });
        await pause({
          id: "pause-a-alex-person",
          business_id: BARBERSHOP,
          target: "person",
          person_id: "person-alex",
        });
        // Left out: a cleared pause, another business's pause, another person's, and an address pause.
        await pause({
          id: "pause-c-cleared",
          business_id: BARBERSHOP,
          target: "person",
          person_id: "person-alex",
          cleared_at: "2026-11-07T15:01:00Z",
          cleared_by_person_id: "person-sam",
        });
        await pause({
          id: "pause-d-yoga",
          business_id: "biz-yoga-studio",
          target: "person",
          person_id: "person-alex",
        });
        await pause({
          id: "pause-e-riley",
          business_id: BARBERSHOP,
          target: "person",
          person_id: "person-riley",
        });
        await pause({
          id: "pause-f-address",
          business_id: BARBERSHOP,
          target: "address",
          address: "\\x6b30342d7465737400",
          sealed_for_person_id: "person-alex",
        });
      });
      const state = stateOf(
        await sendState(runtime, { outboxRowId: ALEX_ROW }, { now: new Date(exchange.given.now) }),
      );
      expect(state.booking).toEqual({
        id: "booking-alex-riley-nov14",
        stage: "booked",
        servedPersonId: "person-riley",
        private: true,
        deceased: true,
        version: 2,
      });
      expect(state.currentVersions).toEqual([
        { table: "bookings", rowId: "booking-alex-riley-nov14", version: 2 },
      ]);
      expect(state.pauses).toEqual([
        {
          id: "pause-a-alex-person",
          target: "person",
          personId: "person-alex",
          phoneNumber: null,
          setByTurnId: null,
          setAt: "2026-11-07T15:00:00Z",
          version: 1,
        },
        {
          id: "pause-b-alex-phone",
          target: "phone",
          personId: null,
          phoneNumber: ALEX_MOBILE,
          setByTurnId: "turn-sam-pauses",
          setAt: "2026-11-07T15:00:00Z",
          version: 1,
        },
      ]);
      expect(schemaErrors("sendState.v1dot8Response", state)).toEqual([]);
    },
  );

  it(
    "the audience: team for staff, owner for an owner; a row with no business is a customer's, with no zone, hours or pauses",
    SLOW,
    async () => {
      await given("send-state-customer.json");
      await addOutboxRow({
        id: "out-t220-riley",
        recipient_handle_id: "handle-riley",
        recipient_person_id: "person-riley",
      });
      await addOutboxRow({ id: "out-t220-no-business", business_id: null });
      await insertRow(db.sql, "pauses", {
        id: "pause-alex-any",
        business_id: "biz-yoga-studio",
        target: "person",
        person_id: "person-alex",
        set_at: "2026-11-07T15:00:00Z",
      });
      const riley = stateOf(await sendState(runtime, { outboxRowId: "out-t220-riley" }));
      expect([riley.audience, riley.zone, riley.textHoursOverride, riley.chat]).toEqual([
        "team",
        "America/New_York",
        false,
        null,
      ]);
      expect(riley.phone?.number).toBe("+15555550102");
      const none = stateOf(await sendState(runtime, { outboxRowId: "out-t220-no-business" }));
      expect(none).toMatchObject({
        audience: "customer",
        zone: null,
        visitZone: null,
        businessZone: null,
        textHours: null,
        pauses: [],
        booking: null,
        openQuestion: null,
        closed: { booking: false, question: false },
        // Alex's own override flag holds for any row to his number (seed-flag).
        textHoursOverride: true,
      });
      // A person who is both owner and customer at one business takes the owner's earlier hours.
      await insertRow(db.sql, "person_roles", {
        id: "role-alex-barber-owner",
        person_id: "person-alex",
        business_id: BARBERSHOP,
        role: "owner",
      });
      expect(stateOf(await sendState(runtime, { outboxRowId: ALEX_ROW })).audience).toBe("owner");
      for (const state of [riley, none]) {
        expect(schemaErrors("sendState.v1dot8Response", state)).toEqual([]);
      }
    },
  );

  it(
    "versions now: in versions_read's order, a moved row at its new version, a row gone left out; an unknown home throws",
    SLOW,
    async () => {
      await given("send-state-customer.json");
      await addOutboxRow({
        id: "out-t220-versions",
        versions_read: [
          { table: "phones", rowId: ALEX_MOBILE, version: 3 },
          { table: "persons", rowId: "person-gone", version: 1 },
          { table: "bookings", rowId: "booking-alex-riley-nov14", version: 1 },
          { table: "businesses", rowId: BARBERSHOP, version: 3 },
        ],
      });
      await db.sql`update businesses set display_name = 'Lee''s', version = version + 1 where id = 'biz-lees-barbershop'`;
      const state = stateOf(await sendState(runtime, { outboxRowId: "out-t220-versions" }));
      expect(state.currentVersions).toEqual([
        { table: "phones", rowId: ALEX_MOBILE, version: 3 },
        { table: "bookings", rowId: "booking-alex-riley-nov14", version: 1 },
        { table: "businesses", rowId: BARBERSHOP, version: 4 },
      ]);
      await addOutboxRow({
        id: "out-t220-unknown-home",
        versions_read: [{ table: "visits", rowId: "visit-1", version: 1 }],
      });
      await expect(sendState(runtime, { outboxRowId: "out-t220-unknown-home" })).rejects.toThrow(
        "versions_read names visits, which is not a versioned home sendState reads",
      );
      await addOutboxRow({
        id: "out-t220-key-row",
        versions_read: [{ table: "sealing_keys", rowId: "person-alex", version: 1 }],
      });
      await expect(sendState(runtime, { outboxRowId: "out-t220-key-row" })).rejects.toThrow("sealing_keys");
    },
  );

  it(
    "a question answered since the row was made is closed; the row's question is read with its status",
    SLOW,
    async () => {
      await given("send-state-customer.json");
      await db.sql.begin(async (tx) => {
        await insertRow(tx, "open_questions", {
          id: "oq-t220-alex",
          turn_id: "turn-alex-book-1",
          handle_id: "handle-alex",
          person_id: "person-alex",
          business_id: BARBERSHOP,
          booking_id: "booking-alex-riley-nov14",
          step: "A7-03",
          options: [{ id: "A7-03/1", label: "Sat 12:00pm" }],
          versions_read: [],
          bundle_hash: HASH,
          bundle_build: 1,
          status: "answered",
          answered_option_id: "A7-03/1",
          closed_at: "2026-11-07T15:06:00Z",
        });
      });
      await addOutboxRow({ id: "out-t220-question", open_question_id: "oq-t220-alex", booking_id: null });
      const state = stateOf(await sendState(runtime, { outboxRowId: "out-t220-question" }));
      expect([state.openQuestion, state.closed, state.booking]).toEqual([
        { id: "oq-t220-alex", status: "answered", version: 1 },
        { booking: false, question: true },
        null,
      ]);
    },
  );

  it(
    "an email recipient: no phone, no override; its texts consent row is still read (the stop record)",
    SLOW,
    async () => {
      await given("send-state-customer.json");
      await addOutboxRow({
        id: "out-t220-email",
        recipient_handle_id: "handle-alex-email",
        channel: "email",
      });
      await appendConsent(db.sql, {
        id: "consent-alex-email-yes",
        personId: "person-alex",
        businessId: BARBERSHOP,
        kind: "texts",
        handleId: "handle-alex-email",
        exactWords: "Send my updates to my email",
        at: new Date("2026-11-01T10:00:00Z"),
        channel: "page",
      });
      const state = stateOf(await sendState(runtime, { outboxRowId: "out-t220-email" }));
      expect(state).toMatchObject({
        recipient: {
          handleId: "handle-alex-email",
          kind: "email",
          address: "alex@example.com",
          personId: "person-alex",
        },
        phone: null,
        chat: null,
        textHoursOverride: false,
        textsConsent: {
          consentId: "consent-alex-email-yes",
          businessId: BARBERSHOP,
          revoked: false,
          at: "2026-11-01T10:00:00Z",
          fromContact: false,
          bookingId: null,
        },
      });
      expect(schemaErrors("sendState.v1dot8Response", state)).toEqual([]);
    },
  );

  it("VERSIONED_HOMES is every versioned one-key table of K-04 v1 core and K-29 v1 but sealing_keys", () => {
    const lists = [
      "db-schema/core/core.v1.tables.json",
      "db-schema/conversations-consent/conversations-consent.v1.tables.json",
    ];
    const homes: Record<string, string> = {};
    for (const list of lists) {
      for (const table of (readJson(new URL(list, CONTRACTS)) as { tables: ContractTable[] }).tables) {
        const [key, ...more] = table.primaryKey ?? [];
        if (table.versioned && key !== undefined && more.length === 0 && table.name !== "sealing_keys") {
          homes[table.name] = key;
        }
      }
    }
    expect({ ...VERSIONED_HOMES }).toEqual(homes);
  });
});

describe("K-05 v1.8 item 47: who gave the texts yes (fromContact), and for which booking (bookingId)", () => {
  it(
    "a yes by text in a turn of another handle reads false, another person's number or Alex's own email; in a turn of his mobile it reads true",
    SLOW,
    async () => {
      await given("send-state-customer.json");
      await addTurn("turn-t1216-riley", "handle-riley", "2026-11-07T16:00:00Z");
      await addTurn("turn-t1216-alex-email", "handle-alex-email", "2026-11-07T16:00:00Z");
      await addTurn("turn-t1216-alex", "handle-alex", "2026-11-07T16:00:00Z");
      // Each row is newer than the one before, so each is in turn the covering row for Alex's confirmation.
      const rows = [
        ["consent-t1216-riley-turn", "turn-t1216-riley", "2026-11-07T16:00:01Z", false],
        ["consent-t1216-email-turn", "turn-t1216-alex-email", "2026-11-07T16:00:02Z", false],
        ["consent-t1216-own-turn", "turn-t1216-alex", "2026-11-07T16:00:03Z", true],
      ] as const;
      for (const [id, turnId, at, fromContact] of rows) {
        await addTextsRow(id, at, { turnId, bookingId: NOV14 });
        expect(await textsRowOf(ALEX_ROW), id).toEqual({
          consentId: id,
          businessId: BARBERSHOP,
          revoked: false,
          at,
          fromContact,
          bookingId: NOV14,
        });
      }
    },
  );

  it(
    "a yes given on a page, by an outside AI or by email reads false, even in a turn of his own mobile; by text it reads true",
    SLOW,
    async () => {
      await given("send-state-customer.json");
      await addTurn("turn-t1216-alex", "handle-alex", "2026-11-07T16:00:00Z");
      const channels = [
        ["page", "2026-11-07T16:00:01Z", false],
        ["ai", "2026-11-07T16:00:02Z", false],
        ["email", "2026-11-07T16:00:03Z", false],
        ["text", "2026-11-07T16:00:04Z", true],
      ] as const;
      for (const [channel, at, fromContact] of channels) {
        const id = `consent-t1216-${channel}`;
        await addTextsRow(id, at, { channel, turnId: "turn-t1216-alex" });
        expect(await textsRowOf(ALEX_ROW), channel).toEqual({
          consentId: id,
          businessId: BARBERSHOP,
          revoked: false,
          at,
          fromContact,
          bookingId: null,
        });
      }
      // A page's yes as a page records it, with no turn behind it, reads false too.
      await addTextsRow("consent-t1216-page-no-turn", "2026-11-07T16:00:05Z", { channel: "page" });
      expect(await textsRowOf(ALEX_ROW)).toMatchObject({
        consentId: "consent-t1216-page-no-turn",
        fromContact: false,
      });
    },
  );

  it(
    "an email contact's yes reads false (default 80), though given by text in its own handle's turn; the same row on his mobile reads true",
    SLOW,
    async () => {
      await given("send-state-customer.json");
      await addOutboxRow({
        id: "out-t1216-email",
        recipient_handle_id: "handle-alex-email",
        channel: "email",
      });
      await addTurn("turn-t1216-alex-email", "handle-alex-email", "2026-11-07T16:00:00Z");
      await addTurn("turn-t1216-alex", "handle-alex", "2026-11-07T16:00:00Z");
      await addTextsRow("consent-t1216-email-own-turn", "2026-11-07T16:00:01Z", {
        handleId: "handle-alex-email",
        turnId: "turn-t1216-alex-email",
      });
      await addTextsRow("consent-t1216-mobile-own-turn", "2026-11-07T16:00:02Z", {
        turnId: "turn-t1216-alex",
      });
      const yes = { businessId: BARBERSHOP, revoked: false, bookingId: null };
      expect(await textsRowOf("out-t1216-email")).toEqual({
        ...yes,
        consentId: "consent-t1216-email-own-turn",
        at: "2026-11-07T16:00:01Z",
        fromContact: false,
      });
      expect(await textsRowOf(ALEX_ROW)).toEqual({
        ...yes,
        consentId: "consent-t1216-mobile-own-turn",
        at: "2026-11-07T16:00:02Z",
        fromContact: true,
      });
      // A row shaped as a START (no business, no turn) on the email handle reads false as well: START never comes by
      // email, and only a phone carries the stopped flag.
      await addTextsRow("consent-t1216-email-start", "2026-11-07T16:00:03Z", {
        handleId: "handle-alex-email",
        businessId: null,
        exactWords: "START",
      });
      expect(await textsRowOf("out-t1216-email")).toMatchObject({
        consentId: "consent-t1216-email-start",
        fromContact: false,
        bookingId: null,
      });
    },
  );

  it(
    "a START with no turn, written on return, reads true with no booking; the stopped flag stays the phone's as stored (default 84)",
    SLOW,
    async () => {
      await given("send-state-customer.json");
      await db.sql.begin((tx) => stopOrStart(tx, true, "2026-11-07T16:00:00Z", "consent-t1216-stop"));
      // His START, recorded on return by his actor with no turn, while the phone's flag is left as it stands: the read
      // gives the row as the person's own word and the flag as the phone holds it, never one from the other.
      await addTextsRow("consent-t1216-start", "2026-11-07T16:00:01Z", {
        businessId: null,
        exactWords: "START",
      });
      const state = stateOf(await sendState(runtime, { outboxRowId: ALEX_ROW }));
      expect(state.textsConsent).toEqual({
        consentId: "consent-t1216-start",
        businessId: null,
        revoked: false,
        at: "2026-11-07T16:00:01Z",
        fromContact: true,
        bookingId: null,
      });
      expect(state.phone).toMatchObject({ stopped: true, stopAt: "2026-11-07T16:00:00Z", chatOpen: false });
      expect(schemaErrors("sendState.v1dot8Response", state)).toEqual([]);
    },
  );

  it(
    "a yes no turn wrote that is not a START reads false (default 79): Ben T.'s ready-text yes as K-29's seed-chat-link writes it, its booking as stored; in a turn of his own number it reads true",
    SLOW,
    async () => {
      await given("send-state-customer.json", [new URL("seed-chat-link.json", CONSENT_DIR)]);
      await addOutboxRow({
        id: "out-t1216-ben",
        recipient_handle_id: "handle-ben",
        recipient_person_id: "person-ben",
        booking_id: "booking-ben-haircut",
      });
      const state = stateOf(await sendState(runtime, { outboxRowId: "out-t1216-ben" }));
      expect(state.textsConsent).toEqual({
        consentId: "consent-ben-texts-yes",
        businessId: BARBERSHOP,
        revoked: false,
        at: "2026-10-05T17:00:00Z",
        fromContact: false,
        bookingId: "booking-ben-haircut",
      });
      // Ben's number is stopped in K-04's seed: the flag is the phone's, as stored, whatever the consent row says.
      expect(state.phone?.stopped).toBe(true);
      expect(schemaErrors("sendState.v1dot8Response", state)).toEqual([]);
      // The same yes, the same link and booking, with a turn of Ben's own number behind it, is his own.
      await addTurn("turn-t1216-ben", "handle-ben", "2026-11-07T16:00:00Z");
      await addTextsRow("consent-t1216-ben-own-turn", "2026-11-07T16:00:01Z", {
        personId: "person-ben",
        handleId: "handle-ben",
        bookingId: "booking-ben-haircut",
        chatLinkId: "chatlink-ben-haircut",
        exactWords: "Hey, send me further updates about my booking. Ref 4K7Q",
        turnId: "turn-t1216-ben",
      });
      expect(await textsRowOf("out-t1216-ben")).toMatchObject({
        consentId: "consent-t1216-ben-own-turn",
        fromContact: true,
        bookingId: "booking-ben-haircut",
      });
    },
  );

  it(
    "a STOP reads false and names no booking (default 82), in a turn of his own mobile or with no turn",
    SLOW,
    async () => {
      await given("send-state-customer.json");
      await addTurn("turn-t1216-alex", "handle-alex", "2026-11-07T16:00:00Z");
      const stops = [
        ["consent-t1216-stop-own-turn", "2026-11-07T16:00:01Z", { turnId: "turn-t1216-alex" }],
        ["consent-t1216-stop-no-turn", "2026-11-07T16:00:02Z", {}],
      ] as const;
      for (const [id, at, values] of stops) {
        await addTextsRow(id, at, { ...values, businessId: null, revoked: true, exactWords: "STOP" });
        expect(await textsRowOf(ALEX_ROW), id).toEqual({
          consentId: id,
          businessId: null,
          revoked: true,
          at,
          fromContact: false,
          bookingId: null,
        });
      }
    },
  );

  it(
    "no statement sendState sends names a consent row's words or a whole row: the covering row is read by its columns, then by its id",
    SLOW,
    async () => {
      await given("send-state-customer.json");
      await addTurn("turn-t1216-alex", "handle-alex", "2026-11-07T16:00:00Z");
      await addTextsRow("consent-t1216-own-turn", "2026-11-07T16:00:01Z", {
        turnId: "turn-t1216-alex",
        bookingId: NOV14,
      });
      sent.length = 0;
      expect(await textsRowOf(ALEX_ROW)).toMatchObject({ fromContact: true, bookingId: NOV14 });
      const consentReads = sent.filter((query) => /\bconsents\b/.test(query));
      expect(consentReads).toHaveLength(2);
      expect(sent.filter((query) => /\bturns\b/.test(query))).toHaveLength(1);
      for (const query of sent) {
        expect(query).not.toMatch(/exact_words/);
      }
      for (const query of consentReads) {
        expect(query).not.toMatch(/\*|to_jsonb|row_to_json/);
      }
    },
  );
});

// ---- T-1322: a statement's own refusal and postgres.js's statement errors leave scrubbed ------------------------------
//
// Five errors are made for real on local PostgreSQL by postgres.js as installed, four of them holding a made-up number
// (rule 9: a 555-01xx number): PostgreSQL's refusal of a statement (22P02, the number in its message) and of a row (a
// CHECK's 23514, the number in its detail, with its table's and constraint's names); postgres.js's UNDEFINED_VALUE (the
// number among the statement's args) and the TypeError its bytea serializer throws (the number in its message); and a
// serialization failure PostgreSQL raises (40001). postgres.js puts the statement on each, its values in args. Each
// reaches the call as postgres.js rejects the call's first statement with it, on a client whose socket fails with it
// (as connect-failures.int.test.ts delivers a socket's error). The first four leave scrubbed: the call's name and the
// code alone, PostgreSQL's as DataAccessDatabaseError (a rule's table and constraint names kept), with the number in no
// message, stack or other own property. 40001 still answers transient with its SQLSTATE.

describe("sendState: a statement's own refusal and postgres.js's statement errors leave scrubbed (T-1322)", () => {
  type Kind = "refusal" | "rule" | "undefinedValue" | "serialization" | "serialize";
  /** Thrown as DataAccessDatabaseError (its message's SQLSTATE and names: `shown`), as a client's code, or answered. */
  type Expected =
    | { database: { code: string; table: string | null; constraint: string | null; shown: string } }
    | { client: string }
    | { answer: unknown };
  const NUMBER = "+15555550147";
  const KINDS: { kind: Kind; name: string; expected: Expected }[] = [
    {
      kind: "refusal",
      name: "PostgreSQL's 22P02, the number in its message, leaves as DataAccessDatabaseError",
      expected: { database: { code: "22P02", table: null, constraint: null, shown: "22P02" } },
    },
    {
      kind: "rule",
      name: "a CHECK's 23514, the number in its detail, leaves as DataAccessDatabaseError, its names kept",
      expected: {
        database: {
          code: "23514",
          table: "t1322_numbers",
          constraint: "t1322_numbers_short",
          shown: "23514, table t1322_numbers, constraint t1322_numbers_short",
        },
      },
    },
    {
      kind: "undefinedValue",
      name: "postgres.js's UNDEFINED_VALUE, the number in its args, leaves with its code alone",
      expected: { client: "UNDEFINED_VALUE" },
    },
    {
      kind: "serialize",
      name: "the TypeError of postgres.js's bytea serializer, the number in its message, leaves with its code alone",
      expected: { client: "ERR_INVALID_ARG_TYPE" },
    },
    {
      kind: "serialization",
      name: "PostgreSQL's 40001 still answers transient with its SQLSTATE",
      expected: { answer: { error: "transient", sqlstate: "40001" } },
    },
  ];
  const CALLS: { call: string; run: (sql: Sql) => Promise<unknown> }[] = [
    { call: "sendState", run: (sql) => sendState(sql, { outboxRowId: "row-t1322" }) },
  ];
  const CASES = CALLS.flatMap(({ call, run }) =>
    KINDS.map(({ kind, name, expected }) => ({ call, run, kind, expected, name: `${call}: ${name}` })),
  );
  let made: Record<Kind, Error>;

  /** Every text `value` holds, deeply: its own property names and values, enumerable or not, its stack among them. */
  const textsOf = (value: unknown, seen = new Set<object>()): string[] => {
    if (typeof value === "string") {
      return [value];
    }
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
      return [String(value)];
    }
    if (typeof value !== "object" || value === null || seen.has(value)) {
      return [];
    }
    seen.add(value);
    return Object.getOwnPropertyNames(value).flatMap((key) => [
      key,
      ...textsOf((value as Record<string, unknown>)[key], seen),
    ]);
  };
  const holdsNumber = (value: unknown): boolean =>
    textsOf(value).some((text) => text.includes(NUMBER.slice(1)));

  /** The error `statement` is refused with. */
  const refusalOf = async (statement: Promise<unknown>): Promise<Error> => {
    try {
      await statement;
    } catch (error) {
      if (error instanceof Error) {
        return error;
      }
    }
    throw new Error("the statement was not refused with an error");
  };

  /** What `run` gives on a client whose socket fails with `raw`: postgres.js rejects its first statement with it. */
  const outcomeOn = async (
    raw: Error,
    run: (sql: Sql) => Promise<unknown>,
  ): Promise<{ answer: unknown } | { thrown: unknown }> => {
    const options = { max: 1, onnotice: () => undefined, socket: () => Promise.reject(raw) };
    const sql = postgres("postgres://t1322@db-t1322.example.invalid:65123/t1322", options);
    try {
      return { answer: await run(sql) };
    } catch (error) {
      return { thrown: error };
    } finally {
      await sql.end({ timeout: 0 });
    }
  };

  beforeAll(async () => {
    const sql = postgres(resolvePrimaryUrl(), { max: 1, onnotice: () => undefined });
    try {
      await sql`create temp table t1322_numbers (number text constraint t1322_numbers_short check (length(number) < 5))`;
      made = {
        refusal: await refusalOf(sql`select ${NUMBER}::uuid as id`),
        rule: await refusalOf(sql`insert into t1322_numbers (number) values (${NUMBER})`),
        undefinedValue: await refusalOf(
          sql`select ${NUMBER}::text as number, ${undefined as never}::text as gone`,
        ),
        serialization: await refusalOf(
          sql.unsafe(
            "do $$ begin raise exception using errcode = '40001', message = 'could not serialize'; end $$",
          ),
        ),
        serialize: await refusalOf(sql`select ${sql.typed(Number(NUMBER.slice(1)), 17)} as bytes`),
      };
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it.each(CASES)("$name", async ({ call, run, kind, expected }) => {
    const raw = made[kind];
    const outcome = await outcomeOn(raw, run);
    if ("answer" in expected) {
      expect(outcome).toEqual({ answer: expected.answer });
      return;
    }
    // The error holds the number, so the check means something; postgres.js put the statement on it.
    expect(holdsNumber(raw)).toBe(true);
    expect(Object.hasOwn(raw, "args")).toBe(true);
    if (!("thrown" in outcome)) {
      throw new Error(`${call} answered`);
    }
    // Booleans first, so a failing run prints neither error's text.
    const { thrown } = outcome;
    expect(thrown === raw).toBe(false);
    expect(holdsNumber(thrown)).toBe(false);
    if ("database" in expected) {
      const { code, table, constraint, shown } = expected.database;
      expect(thrown).toBeInstanceOf(DataAccessDatabaseError);
      expect(Object.getOwnPropertyNames(thrown).sort()).toEqual([
        "call",
        "code",
        "constraint",
        "message",
        "name",
        "stack",
        "table",
      ]);
      expect(thrown).toMatchObject({
        call,
        code,
        table,
        constraint,
        message: `${call}: the database refused the call (SQLSTATE ${shown})`,
      });
      return;
    }
    expect(Object.getOwnPropertyNames(thrown).sort()).toEqual(["call", "code", "message", "stack"]);
    expect(thrown).toMatchObject({
      call,
      code: expected.client,
      message: `${call}: the database call failed (code ${expected.client})`,
    });
  });
});

// ---- T-1436: the setup rows an outbox row's versions_read names, each read within the row's bound --------------------
//
// sendState re-reads every setup row an outbox row's versions_read names, as it re-reads a core row (T-1436; DL-927,
// DL-935): a one-column key by its column, a two-column key by K-05 v1.18 item 77's name, built and compared whole by
// the SQL beside the outbox row's business; a row of a table scoped none only under T-667 round 2's rules (DL-925 items
// 8a and 8b), with the outbox row's business and its turn's handle's people (send-state.ts default 1). A row outside its
// bound is left out, as a row gone.
//
// The rows come only from fixture set v1's demo shops (rule 9), loaded once for this block: K-04's turn seed (the
// bundle, the demo businesses, the cast and their handles) and, with their after chains, the setup seeds T-667's tests
// read: K-22's codes and sessions (Sam's, and Jordan's paused code) and the staging testers' (another person's account,
// code and session), K-27's links, shares and busy blocks, K-25's price list (K-23's demo shop and K-24's sample kinds
// behind it), K-24's picked kinds and the pet boarding shop's new-work draft. Made here from seed rows under new ids, as
// T-667's setup tests make them: Lee Home Services' plumbing kind placed before its business (no business), Riley's
// barbershop share as an ended share with Lee Home Services, and Sam's owner-email code as the barbershop's listing
// control code (no person); and committed turns of handle-sam, handle-riley and the first staging tester's email handle,
// whose outbox rows name the rows. Every number is a seed's own 555-01xx number: this block writes none.

describe("sendState: the setup rows an outbox row's versions_read names (T-1436)", () => {
  const DB_SCHEMA_DIR = new URL("db-schema/", CONTRACTS);
  const seedOf = (path: string): URL => new URL(path, DB_SCHEMA_DIR);
  const SEEDS: readonly URL[] = [
    seedOf("core/fixtures/seed-turn.json"),
    seedOf("people-access/fixtures/seed-session.json"),
    seedOf("people-access/fixtures/seed-staging-tester.json"),
    seedOf("availability/fixtures/seed-busy-block.json"),
    seedOf("services-prices/fixtures/seed-services-price-list.json"),
    seedOf("kinds-of-work/fixtures/seed-business-kinds.json"),
    seedOf("kinds-of-work/fixtures/seed-new-work-draft.json"),
  ];
  const HOME_SERVICES = "biz-lee-home-services";
  const YOGA = "biz-yoga-studio";
  const MOVERS = "biz-movers";
  const PET_BOARDING = "biz-pet-boarding";
  /** Lee Home Services' plumbing kind as S1-04 places it before its business: a seed row under a new id, no business. */
  const EARLY_KIND = "company-sam-before-business/plumber";
  /** The barbershop's listing control code, made from Sam's owner-email code: a code with no person (S1-75). */
  const CONTROL_CODE = "code-barbershop-listing-control";
  const SWEEP = { timeout: 300_000 };

  /** Whom an outbox row goes to. */
  interface Recipient {
    readonly handleId: string;
    readonly personId: string;
    readonly channel: "imessage" | "email";
  }
  /** A committed turn of a handle, whose outbox rows go to that handle unless a case says otherwise. */
  interface Turn extends Recipient {
    readonly id: string;
  }
  /** A versions_read entry (K-04 outbox_rows.versions_read). */
  interface Named {
    readonly table: string;
    readonly rowId: string;
    readonly version: number;
  }

  const SAM: Turn = {
    id: "turn-t1436-sam",
    handleId: "handle-sam",
    personId: "person-sam",
    channel: "imessage",
  };
  const RILEY: Turn = {
    id: "turn-t1436-riley",
    handleId: "handle-riley",
    personId: "person-riley",
    channel: "imessage",
  };
  const TESTER: Turn = {
    id: "turn-t1436-tester",
    handleId: "handle-tester-one-email",
    personId: "person-tester-one",
    channel: "email",
  };
  const TO_ALEX: Recipient = { handleId: "handle-alex", personId: "person-alex", channel: "imessage" };

  /** One seed's own row of `table` whose values hold each of `match`'s. */
  function seedRowOf(seed: URL, table: string, match: Record<string, Json>): Record<string, Json> {
    const rows = (readJson(seed) as SeedFile).rows.filter(
      (row) =>
        row.table === table && Object.entries(match).every(([column, value]) => row.values[column] === value),
    );
    const [row, ...more] = rows;
    if (row === undefined || more.length > 0) {
      throw new Error(`${seed.pathname} has no one ${table} row that matches`);
    }
    return row.values;
  }

  beforeAll(async () => {
    await reset();
    // The shared catalog hangs from no business, person or handle, so reset() leaves it: emptied with what hangs from it.
    await db.sql`truncate kinds cascade`;
    const seen = new Set<string>();
    const rows = SEEDS.flatMap((seed) => seedRows(seed, seen));
    await db.sql.begin(async (tx) => {
      for (const row of rows) {
        await insertRow(tx, row.table, row.values);
      }
      const twoKinds = seedOf("business-setup/fixtures/seed-company-two-kinds.json");
      await insertRow(tx, "companies", {
        ...seedRowOf(twoKinds, "companies", { id: "company-lee-home-services" }),
        id: "company-sam-before-business",
        business_id: null,
        version: 1,
      });
      await insertRow(tx, "company_kinds", {
        ...seedRowOf(twoKinds, "company_kinds", {
          company_id: "company-lee-home-services",
          kind_id: "plumber",
        }),
        company_id: "company-sam-before-business",
        business_id: null,
        version: 1,
      });
      await insertRow(tx, "calendar_link_shares", {
        ...seedRowOf(seedOf("availability/fixtures/seed-calendar-link.json"), "calendar_link_shares", {
          id: "share-riley-barbershop",
        }),
        id: "share-riley-home-services-ended",
        business_id: HOME_SERVICES,
        ended_at: "2026-11-05T15:00:00Z",
        version: 2,
      });
      await insertRow(tx, "proof_codes", {
        ...seedRowOf(seedOf("people-access/fixtures/seed-proof-code.json"), "proof_codes", {
          id: "code-sam-owner-email",
        }),
        id: CONTROL_CODE,
        purpose: "listing_control",
        person_id: null,
      });
    });
    for (const turn of [SAM, RILEY, TESTER]) {
      await addTurn(turn.id, turn.handleId, "2026-11-07T16:00:00Z");
    }
  }, 180_000);

  let rowsMade = 0;
  /**
   * An outbox row of `turn` at `businessId`, naming `refs` in its versions_read, to the turn's own handle unless `to` says
   * otherwise; with no turn, a job's row (K-04 v1.1: a job id in place of the turn), to Sam unless `to` says otherwise.
   */
  async function outboxRowNaming(
    businessId: string | null,
    turn: Turn | null,
    refs: readonly Named[],
    to: Recipient = turn ?? SAM,
  ): Promise<string> {
    rowsMade += 1;
    const id = `out-t1436-${String(rowsMade)}`;
    await insertRow(db.sql, "outbox_rows", {
      id,
      turn_id: turn === null ? null : turn.id,
      job_id: turn === null ? `job-t1436-${String(rowsMade)}` : null,
      recipient_handle_id: to.handleId,
      recipient_person_id: to.personId,
      business_id: businessId,
      channel: to.channel,
      send_class: "routine",
      versions_read: refs.map((ref) => ({ table: ref.table, rowId: ref.rowId, version: ref.version })),
      state: "sending",
      bundle_hash: HASH,
      bundle_build: 1,
      trace_id: `trace-${id}`,
    });
    return id;
  }

  /** The rows sendState answers now for an outbox row, its whole answer checked against v1.8 (stateOf). */
  async function versionsNow(outboxRowId: string): Promise<Named[]> {
    return stateOf(await sendState(runtime, { outboxRowId })).currentVersions;
  }

  /** A setup row's version as the tables' owner reads it by its name alone (no bound), or null when there is no such row. */
  async function versionOfRow(table: string, rowId: string): Promise<number | null> {
    const home = SETUP_FACT_HOMES[table];
    if (home === undefined) {
      throw new Error(`no setup home ${table}`);
    }
    const [row] = await db.sql<{ version: number }[]>`
      select version from ${db.sql(table)} where ${rowNameSql(db.sql, home.key)} = ${rowId}
    `;
    return row === undefined ? null : row.version;
  }

  /** The row's version now, which must exist: a row that finds none then finds none by its bound, never by its absence. */
  async function existingVersionOf(table: string, rowId: string): Promise<number> {
    const version = await versionOfRow(table, rowId);
    if (version === null) {
      throw new Error(`the test names a ${table} row that is not there: ${rowId}`);
    }
    return version;
  }

  /**
   * readTurnState's answer (setup/turn-state.ts) for one setup row's version, read as `handleId` under `businessId`: the
   * row's version, or null for notFound. Both calls bind a row by one function, setup/fact-homes.ts rowBound (round 2).
   */
  async function turnStateVersion(
    handleId: string,
    businessId: string | null,
    row: Named,
  ): Promise<number | null> {
    const outcome = await readTurnState(runtime, {
      handleId,
      businessId,
      bookingIds: [],
      facts: [{ key: "version", table: row.table, rowId: row.rowId, column: "version" }],
    });
    if (!("result" in outcome)) {
      expect(outcome, `${row.table} ${row.rowId}`).toEqual({
        error: "notFound",
        table: row.table,
        rowId: row.rowId,
      });
      return null;
    }
    const [fact, ...more] = outcome.facts;
    expect(more).toEqual([]);
    return fact === undefined ? null : fact.version;
  }

  const keyOf = (ref: { table: string; rowId: string }): string => `${ref.table}\u0000${ref.rowId}`;

  it(
    "answers a one-column and a two-column setup row at their versions now, in versions_read's order beside a core row, and each moved version shows",
    SLOW,
    async () => {
      const named: Named[] = [
        // One column: the business's own setup row, by its business id.
        { table: "business_setup", rowId: BARBERSHOP, version: 4 },
        // Item 77's names: business id/flow, then (below) company id/kind id and pick id/pf key.
        { table: "flow_defaults", rowId: `${BARBERSHOP}/A`, version: 1 },
        { table: "persons", rowId: "person-sam", version: 1 },
        { table: "services", rowId: "svc-lees-haircut", version: 1 },
        { table: "company_kinds", rowId: "company-lees-barbershop/barber", version: 1 },
        { table: "picked_kind_texts", rowId: "pick-sam-barbershop/pf.license", version: 1 },
        // The shared catalog, one column and two (kind id/flow).
        { table: "kinds", rowId: "barber", version: 1 },
        { table: "kind_flows", rowId: "barber/A", version: 1 },
        // A person's row: Sam's live session, read for his own turn.
        { table: "sessions", rowId: "session-sam-oct26", version: 2 },
      ];
      const id = await outboxRowNaming(BARBERSHOP, SAM, named);
      sent.length = 0;
      expect(await versionsNow(id)).toEqual(named);

      // The SQL builds a two-column row's name from the row's own columns and compares it whole with the rowId, beside the
      // outbox row's business; a one-column key is compared by its column beside it too; the catalog names no business;
      // a person's row is bound to the people of the outbox row's turn's handle.
      const readOf = (table: string): string => {
        const query = sent.find((text) => text.includes(`from "${table}"`));
        if (query === undefined) {
          throw new Error(`sendState sent no read of ${table}`);
        }
        return query;
      };
      expect(readOf("company_kinds")).toMatch(
        /where \("company_id"::text \|\| '\/' \|\| "kind_id"::text\) = \$1\s+and "business_id" = \$2/,
      );
      expect(readOf("flow_defaults")).toMatch(
        /where \("business_id"::text \|\| '\/' \|\| "flow"::text\) = \$1\s+and "business_id" = \$2/,
      );
      expect(readOf("services")).toMatch(/where "id" = \$1\s+and "business_id" = \$2/);
      expect(readOf("kind_flows")).toMatch(/where \("kind_id"::text \|\| '\/' \|\| "flow"::text\) = \$1\s*$/);
      expect(readOf("sessions")).toMatch(
        /where "id" = \$1\s+and person_id in \(\s*select ph\.person_id from turns t join person_handles ph on ph\.handle_id = t\.handle_id where t\.id = \$2\s*\)/,
      );

      // Each row moves on, as a commit moves it: the read answers each at its new version.
      await db.sql.begin(async (tx) => {
        await tx`update business_setup set version = version + 1 where business_id = ${BARBERSHOP}`;
        await tx`update flow_defaults set version = version + 1 where business_id = ${BARBERSHOP} and flow = 'A'`;
        await tx`update persons set version = version + 1 where id = 'person-sam'`;
        await tx`update services set version = version + 1 where id = 'svc-lees-haircut'`;
        await tx`
          update company_kinds set version = version + 1
          where company_id = 'company-lees-barbershop' and kind_id = 'barber'
        `;
        await tx`
          update picked_kind_texts set version = version + 1
          where picked_kind_id = 'pick-sam-barbershop' and pf_key = 'pf.license'
        `;
        await tx`update kinds set version = version + 1 where id = 'barber'`;
        await tx`update kind_flows set version = version + 1 where kind_id = 'barber' and flow = 'A'`;
        await tx`update sessions set version = version + 1 where id = 'session-sam-oct26'`;
      });
      expect(await versionsNow(id)).toEqual(named.map((ref) => ({ ...ref, version: ref.version + 1 })));
    },
  );

  it(
    "finds none of another business's rows by their names, compared whole, and a row with no business only for an outbox row with none; the catalog answers any",
    SLOW,
    async () => {
      const CATALOG = "the catalog";
      const rows: readonly { table: string; rowId: string; of: string | null }[] = [
        { table: "business_setup", rowId: BARBERSHOP, of: BARBERSHOP },
        { table: "flow_defaults", rowId: `${BARBERSHOP}/B`, of: BARBERSHOP },
        { table: "services", rowId: "svc-lees-skin-fade", of: BARBERSHOP },
        { table: "picked_kind_texts", rowId: "pick-sam-barbershop/pf.money", of: BARBERSHOP },
        { table: "company_kinds", rowId: "company-lee-home-services/plumber", of: HOME_SERVICES },
        // Item 77's name with an integer key column: draft id/block.
        { table: "new_work_draft_blocks", rowId: "draft-pack-hikes/3", of: PET_BOARDING },
        { table: "company_kinds", rowId: EARLY_KIND, of: null },
        { table: "kinds", rowId: "plumber", of: CATALOG },
        { table: "kind_flows", rowId: "plumber/B", of: CATALOG },
      ];
      const refs: Named[] = rows.map((row) => ({ table: row.table, rowId: row.rowId, version: 1 }));
      for (const businessId of [BARBERSHOP, HOME_SERVICES, PET_BOARDING, YOGA, null]) {
        const expected: Named[] = [];
        for (const row of rows) {
          const version = await existingVersionOf(row.table, row.rowId);
          if (row.of === businessId || row.of === CATALOG) {
            expected.push({ table: row.table, rowId: row.rowId, version });
          }
        }
        const id = await outboxRowNaming(businessId, SAM, refs);
        expect(await versionsNow(id), `an outbox row of ${businessId ?? "no business"}`).toEqual(expected);
      }

      // A name is compared whole: the kind alone, the company alone, a trailing slash or another case finds none, under
      // the row's own business too; the whole name finds it.
      const plumbing = await existingVersionOf("company_kinds", "company-lee-home-services/plumber");
      const names = [
        "company-lee-home-services/plumber",
        "plumber",
        "company-lee-home-services",
        "company-lee-home-services/plumber/",
        "company-lee-home-services/Plumber",
        "/company-lee-home-services/plumber",
      ];
      const id = await outboxRowNaming(
        HOME_SERVICES,
        SAM,
        names.map((rowId) => ({ table: "company_kinds", rowId, version: 1 })),
      );
      expect(await versionsNow(id)).toEqual([
        { table: "company_kinds", rowId: "company-lee-home-services/plumber", version: plumbing },
      ]);
    },
  );

  it(
    "finds none of a person's rows outside T-667 round 2's rules, and answers those inside them, as readTurnState does for the turn's handle",
    SLOW,
    async () => {
      interface Case {
        readonly table: string;
        readonly rowId: string;
        readonly answers: boolean;
        readonly why: string;
      }
      const yes = (table: string, rowId: string, why: string): Case => ({ table, rowId, answers: true, why });
      const no = (table: string, rowId: string, why: string): Case => ({ table, rowId, answers: false, why });
      const groups: readonly {
        businessId: string | null;
        turn: Turn | null;
        to?: Recipient;
        cases: readonly Case[];
      }[] = [
        {
          businessId: BARBERSHOP,
          turn: SAM,
          cases: [
            yes("accounts", "person-sam", "the turn's person's account"),
            no("accounts", "person-tester-one", "another person's account"),
            yes("sessions", "session-sam-oct26", "the turn's person's live session"),
            yes("sessions", "session-sam-oct20", "the turn's person's ended session"),
            no("sessions", "session-tester-one", "another person's session"),
            yes("proof_codes", "code-sam-owner-email", "the person's code of the outbox row's business"),
            yes("proof_codes", "code-sam-sign-in-oct26", "the person's code with no business"),
            no("proof_codes", "code-jordan-sign-in-paused", "another person's code"),
            no("proof_codes", "code-tester-one-sign-in", "another person's code with no business"),
            no("proof_codes", CONTROL_CODE, "the business's own control code, which has no person"),
            yes(
              "calendar_links",
              "callink-riley-google",
              "another person's link shared live with the business",
            ),
            yes("calendar_links", "callink-sam-microsoft", "the person's own link, shared live too"),
            yes("busy_blocks", "busy-riley-sat-nov-7", "a block of a link shared live with the business"),
            yes(
              "busy_blocks",
              "busy-sam-thu-nov-12",
              "the person's block, its link shared live with the business",
            ),
            no("busy_blocks", "busy-sam-movers-photo-sat-nov-14", "another business's photo block"),
          ],
        },
        {
          businessId: HOME_SERVICES,
          turn: SAM,
          cases: [
            no("proof_codes", "code-sam-owner-email", "the person's code of another business"),
            no("calendar_links", "callink-riley-google", "a link whose share with the business has ended"),
            no(
              "busy_blocks",
              "busy-riley-sat-nov-7",
              "a block of a link whose share with the business has ended",
            ),
            yes("busy_blocks", "busy-sam-thu-nov-12", "a block of a link shared live with the business"),
          ],
        },
        {
          businessId: MOVERS,
          turn: SAM,
          cases: [
            yes("busy_blocks", "busy-sam-movers-photo-sat-nov-14", "the business's own photo block"),
            no(
              "busy_blocks",
              "busy-sam-thu-nov-12",
              "the person's own block, its link not shared with the business",
            ),
            yes(
              "calendar_links",
              "callink-sam-microsoft",
              "the person's own link, not shared with the business",
            ),
            no(
              "calendar_links",
              "callink-riley-google",
              "another person's link the business has no share of",
            ),
          ],
        },
        {
          businessId: YOGA,
          turn: RILEY,
          cases: [
            yes(
              "calendar_links",
              "callink-riley-google",
              "the turn's person's own link, which the business has no share of",
            ),
            no(
              "calendar_links",
              "callink-sam-microsoft",
              "another person's link the business has no share of",
            ),
            no("calendar_links", "callink-avery-google", "another person's link, shared only elsewhere"),
            no("accounts", "person-sam", "another person's account"),
            no("sessions", "session-sam-oct26", "another person's session"),
          ],
        },
        {
          businessId: null,
          turn: SAM,
          cases: [
            yes("accounts", "person-sam", "the person's account, with no business"),
            yes("sessions", "session-sam-oct26", "the person's session, with no business"),
            yes("proof_codes", "code-sam-sign-in-oct26", "the person's code with no business, with none"),
            no("proof_codes", "code-sam-owner-email", "the person's code of a business, with no business"),
            no("proof_codes", CONTROL_CODE, "a control code, with no business"),
            yes("calendar_links", "callink-sam-microsoft", "the person's own link, with no business"),
            no(
              "calendar_links",
              "callink-riley-google",
              "another person's link, though shared, with no business",
            ),
            no("busy_blocks", "busy-sam-thu-nov-12", "the person's own block, with no business"),
            no("busy_blocks", "busy-sam-movers-photo-sat-nov-14", "a photo block, with no business"),
          ],
        },
        {
          businessId: null,
          turn: TESTER,
          cases: [
            yes("accounts", "person-tester-one", "the tester's own account"),
            yes("sessions", "session-tester-one", "the tester's own session"),
            yes("proof_codes", "code-tester-one-sign-in", "the tester's own code"),
            no("accounts", "person-sam", "another person's account"),
            no("proof_codes", "code-sam-sign-in-oct26", "another person's code"),
          ],
        },
        // Default 1: the people of the turn's handle, never the recipient's.
        {
          businessId: BARBERSHOP,
          turn: RILEY,
          to: SAM,
          cases: [
            no("sessions", "session-sam-oct26", "the recipient's session, in another person's turn"),
            no("accounts", "person-sam", "the recipient's account, in another person's turn"),
            yes("calendar_links", "callink-riley-google", "the turn's person's own link"),
          ],
        },
        {
          businessId: BARBERSHOP,
          turn: SAM,
          to: TO_ALEX,
          cases: [
            yes("sessions", "session-sam-oct26", "the turn's person's session, sent to another handle"),
            yes("accounts", "person-sam", "the turn's person's account, sent to another handle"),
          ],
        },
        // A job's row has no turn, so no person's row answers for it; a business's own rows still do.
        {
          businessId: MOVERS,
          turn: null,
          cases: [
            no("accounts", "person-sam", "a person's account, for a row with no turn"),
            no("sessions", "session-sam-oct26", "a person's session, for a row with no turn"),
            no("proof_codes", "code-sam-sign-in-oct26", "a person's code, for a row with no turn"),
            no("calendar_links", "callink-sam-microsoft", "a person's link the business has no share of"),
            yes("busy_blocks", "busy-sam-movers-photo-sat-nov-14", "the business's own photo block"),
          ],
        },
      ];
      for (const { businessId, turn, to, cases } of groups) {
        // Each case's row is there, so one that finds none finds none by its rule, never by its absence.
        const now: { each: Case; ref: Named }[] = [];
        for (const each of cases) {
          const version = await existingVersionOf(each.table, each.rowId);
          now.push({ each, ref: { table: each.table, rowId: each.rowId, version } });
        }
        const id = await outboxRowNaming(
          businessId,
          turn,
          now.map(({ ref }) => ref),
          to ?? turn ?? SAM,
        );
        const where = `${turn?.id ?? "a job's row"} at ${businessId ?? "no business"}`;
        expect(await versionsNow(id), where).toEqual(
          now.filter(({ each }) => each.answers).map(({ ref }) => ref),
        );
        if (turn === null) {
          continue;
        }
        // readTurnState answers the turn's handle under the outbox row's business exactly so (one rowBound for both).
        for (const { each, ref } of now) {
          const read = await turnStateVersion(turn.handleId, businessId, ref);
          expect(read, `${where}: ${each.why}`).toBe(each.answers ? ref.version : null);
        }
      }
    },
  );

  it(
    "holds each rule to readTurnState's: every row answers sendState as readTurnState answers the turn's handle under the outbox row's business",
    SWEEP,
    async () => {
      const rows: Named[] = [
        ...["person-sam", "person-tester-one"].map((rowId) => ({ table: "accounts", rowId, version: 1 })),
        ...["session-sam-oct26", "session-sam-oct20", "session-tester-one"].map((rowId) => ({
          table: "sessions",
          rowId,
          version: 1,
        })),
        ...[
          "code-sam-owner-email",
          "code-sam-sign-in-oct26",
          "code-jordan-sign-in-paused",
          "code-tester-one-sign-in",
          CONTROL_CODE,
        ].map((rowId) => ({ table: "proof_codes", rowId, version: 1 })),
        ...["callink-sam-microsoft", "callink-riley-google", "callink-avery-google"].map((rowId) => ({
          table: "calendar_links",
          rowId,
          version: 1,
        })),
        ...["busy-sam-movers-photo-sat-nov-14", "busy-riley-sat-nov-7", "busy-sam-thu-nov-12"].map(
          (rowId) => ({
            table: "busy_blocks",
            rowId,
            version: 1,
          }),
        ),
        { table: "kinds", rowId: "barber", version: 1 },
        { table: "kind_flows", rowId: "barber/A", version: 1 },
        { table: "services", rowId: "svc-lees-haircut", version: 1 },
        { table: "flow_defaults", rowId: `${BARBERSHOP}/A`, version: 1 },
        { table: "company_kinds", rowId: "company-lee-home-services/plumber", version: 1 },
        { table: "company_kinds", rowId: EARLY_KIND, version: 1 },
        { table: "calendar_link_shares", rowId: "share-riley-barbershop", version: 1 },
      ];
      for (const row of rows) {
        await existingVersionOf(row.table, row.rowId);
      }
      // Each table's verdicts across the sweep: true where a row answered, false where one found none.
      const verdicts = new Map<string, Set<boolean>>();
      for (const businessId of [BARBERSHOP, HOME_SERVICES, YOGA, MOVERS, null]) {
        for (const turn of [SAM, RILEY, TESTER]) {
          const answered = new Map(
            (await versionsNow(await outboxRowNaming(businessId, turn, rows))).map((ref) => [
              keyOf(ref),
              ref.version,
            ]),
          );
          for (const row of rows) {
            const read = await turnStateVersion(turn.handleId, businessId, row);
            expect(
              answered.get(keyOf(row)) ?? null,
              `${row.table} ${row.rowId}, ${turn.id} at ${businessId ?? "none"}`,
            ).toBe(read);
            verdicts.set(row.table, (verdicts.get(row.table) ?? new Set<boolean>()).add(read !== null));
          }
        }
      }
      // Every table a person's rule binds both answered and found none somewhere, so no rule was held to an empty case.
      const bound = Object.entries(UNSCOPED_ROWS).filter(([, rule]) => rule !== "catalog");
      expect(bound.map(([table]) => table).sort()).toEqual(
        ["accounts", "busy_blocks", "calendar_links", "proof_codes", "sessions"].sort(),
      );
      for (const [table] of bound) {
        expect([...(verdicts.get(table) ?? [])].sort(), table).toEqual([false, true]);
      }
    },
  );

  it(
    "reads every setup home by its name within the bound, each a table with a version and the key its name is built from; without a bound a setup home still throws",
    SLOW,
    async () => {
      const homes = Object.entries(SETUP_FACT_HOMES);
      const catalog = await db.sql<{ name: string; key: string[]; version: string | null }[]>`
        select c.relname::text as name,
               array(select a.attname::text
                     from pg_index i
                     cross join lateral unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
                     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                     where i.indrelid = c.oid and i.indisprimary
                     order by k.ord) as key,
               (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
                where a.attrelid = c.oid and a.attname = 'version' and not a.attisdropped) as version
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = ${db.schema} and c.relkind in ('r', 'p')
          and c.relname::text = any(${homes.map(([table]) => table)}::text[])
      `;
      expect(
        Object.fromEntries(catalog.map((row) => [row.name, { key: row.key, version: row.version }])),
      ).toEqual(
        Object.fromEntries(homes.map(([table, home]) => [table, { key: [...home.key], version: "integer" }])),
      );

      // One outbox row names a row of every setup home that is not there: each home is read by its name within the
      // bound, under a business and with none, and none answers (a table scoped none with no rule would have thrown).
      const missing: Named[] = homes.map(([table, home]) => ({
        table,
        rowId: home.key.map(() => "t1436-none").join("/"),
        version: 1,
      }));
      for (const businessId of [BARBERSHOP, null]) {
        expect(
          await versionsNow(await outboxRowNaming(businessId, SAM, missing)),
          businessId ?? "no business",
        ).toEqual([]);
      }

      // Without a bound (limit 4's reload), the core homes alone are read, as before T-1436, and a setup home throws.
      expect(
        await currentVersionsOf(runtime, [{ table: "persons", rowId: "person-alex", version: 1 }]),
      ).toEqual([{ table: "persons", rowId: "person-alex", version: 1 }]);
      await expect(
        currentVersionsOf(runtime, [{ table: "services", rowId: "svc-lees-haircut", version: 1 }]),
      ).rejects.toThrow("versions_read names services, a setup home read only within an outbox row's bound");

      // A table that is no home still throws: setup tables never a fact (the Tool API never reads them, or they carry no
      // version) and the sealing keys.
      for (const table of ["sign_in_attempts", "staging_testers", "item_services", "sealing_keys"]) {
        const id = await outboxRowNaming(BARBERSHOP, SAM, [{ table, rowId: "t1436-none", version: 1 }]);
        await expect(sendState(runtime, { outboxRowId: id }), table).rejects.toThrow(
          `versions_read names ${table}, which is not a versioned home sendState reads`,
        );
      }
    },
  );

  // Round 2 (DL-938, DL-941): sendState, readTurnState and fireClock bind a setup row by one function, rowBound, each
  // with its own business and people; a table that is no setup home has no bound, so it is refused, never read unbound.
  it("refuses in rowBound, the one bound every reader calls, a table that is no setup home, with nothing sent", () => {
    const nobody = runtime`(select ph.person_id from person_handles ph where false)`;
    sent.length = 0;
    for (const table of [
      "persons",
      "outbox_rows",
      "sign_in_attempts",
      "staging_testers",
      "item_services",
      "sealing_keys",
      "no_such_table",
      "__proto__",
      "toString",
    ]) {
      for (const businessId of [BARBERSHOP, null]) {
        expect(() => rowBound(runtime, table, businessId, nobody), table).toThrow(
          `rowBound: ${table} is not a setup home`,
        );
      }
    }
    expect(sent).toEqual([]);
  });
});
