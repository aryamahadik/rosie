// T-220: K-05 v1.2's handleTargets, the guard's read of a handle's targets, against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/targets`). The schema comes from migrating a fresh test schema.
//
// Every call runs on the runtime side as K-05 v1.2 states it (README line 153): through a client whose connections run
// as rosie_job (T-191: the guard's role, the only one that reads phones and handles) with no business scope, so the
// grants and row-level security are the ones the guard meets. The tables' owner (the migrations' role) writes the seeds
// and the state a fixture's `given` names.
//
// A fixture's `given.after` names the exchanges that run first (each with its own `given`). handleSealingKey, this
// task's, runs for real. The commit, plan, claim, mark and arm calls (T-195 to T-197) are not built yet, so each of
// those steps writes, directly and as the owner, the rows its exchange states in its request and its outcome: what the
// reads that follow see. K-04's seed holds stand-in bytes for Alex's wrapped key (seed-sealing-key: "not a real key"),
// so the loader writes a real data key wrapped under this file's test wrapping key in its place, the row otherwise as
// seeded. The test wrapping key is random per run: never a real key, never read from the environment.
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { type AddressInfo, createConnection, createServer } from "node:net";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "./client";
import { DataAccessDatabaseError, transientOrScrubbed } from "./clocks";
import { handleSealingKey, type HandleSealingKeyRequest } from "./handle-keys";
import { type Sql, type Tx, withBusiness } from "./scope";
import { sendState } from "./send-state";
import { handleTargets, handleTargetsIn, type HandleTargetsRequest, inRuntimeTransaction } from "./targets";
import { createTestDatabase, type TestDatabase } from "./test-db";

type Db = Sql | Tx;
type Step = (sql: Db, exchange: Exchange) => Promise<void>;

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const RUNTIME_ROLE = "rosie_job";
const WRAP_NAME = "SEALING_WRAP_KEY";
const SLOW = { timeout: 60_000 };

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

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

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const exchangeOf = (file: string): Exchange => readJson(new URL(file, ACCESS_DIR)) as Exchange;
const INDEX = (readJson(new URL("index.json", ACCESS_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const TARGETS_FIXTURES = INDEX.filter((entry) => entry.def === "handleTargets.exchange").map(
  (entry) => entry.file,
);

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

// ---- databases and clients ------------------------------------------------------------------------------------------

let db: TestDatabase;
/** Connections that run as rosie_job, the runtime side, with this file's schema first. */
let runtime: Sql;
let typedColumns: Map<string, string>;
const wrappingKey = new Uint8Array(randomBytes(32));
const keys = {
  resolve: (name: string): Uint8Array | undefined => (name === WRAP_NAME ? wrappingKey : undefined),
};

beforeAll(async () => {
  db = await createTestDatabase({ name: "targets" });
  runtime = postgres(resolvePrimaryUrl(), {
    max: 10,
    onnotice: () => undefined,
    connection: {
      application_name: "rosie-t220-targets",
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

function seedRows(file: string, seen: Set<string>): SeedFile["rows"] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const seed = readJson(new URL(file, CORE_DIR)) as SeedFile;
  return [...seed.after.flatMap((before) => seedRows(before, seen)), ...seed.rows];
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

/** The chain steps of calls not built yet, by call: each writes what its exchange states. */
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
  const seen = new Set<string>();
  const rows = chain.seeds.flatMap((seed) => seedRows(seed, seen));
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
    }
  });
  for (const step of chain.steps) {
    const before = exchangeOf(step);
    if (before.call === "handleSealingKey") {
      const result = await handleSealingKey(
        runtime,
        keys,
        before.request as unknown as HandleSealingKeyRequest,
        {
          now: new Date(before.given.now),
        },
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

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("the runtime side these calls run on (K-05 v1.2 README line 153; T-191)", () => {
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

describe("handleTargets: each K-05 v1.2 fixture gives its response (K-05 item 27)", () => {
  it("the index lists the guard's four exchanges, each valid against data-access v1.2", () => {
    expect([...TARGETS_FIXTURES].sort()).toEqual([
      "targets-alex.json",
      "targets-first-text.json",
      "targets-poll-failed-plain.json",
      "targets-sam-owner.json",
    ]);
    for (const file of TARGETS_FIXTURES) {
      expect(schemaErrors("handleTargets.exchange", exchangeOf(file)), file).toEqual([]);
    }
  });

  for (const file of TARGETS_FIXTURES) {
    it(
      `${file}: as rosie_job with no business scope, the call answers the fixture's outcome`,
      SLOW,
      async () => {
        const exchange = await given(file);
        const outcome = await handleTargets(runtime, exchange.request as unknown as HandleTargetsRequest, {
          now: new Date(exchange.given.now),
        });
        expect(outcome).toEqual(exchange.outcome);
        expect(schemaErrors("handleTargets.response", outcome)).toEqual([]);
      },
    );
  }
});

describe("handleTargets: what the fixtures leave out", () => {
  it("a handle that does not exist answers notFound", async () => {
    await reset();
    const outcome = await handleTargets(runtime, { handleId: "handle-nobody" });
    expect(outcome).toEqual({ error: "notFound", table: "handles", rowId: "handle-nobody" });
    expect(schemaErrors("handleTargets.errors", outcome)).toEqual([]);
  });

  it("with no clock given, readAt is the database's now, in UTC", async () => {
    await given("targets-sam-owner.json");
    const before = Date.now();
    const outcome = await handleTargets(runtime, { handleId: "handle-sam" });
    expect(outcome).toMatchObject({ result: "targets", handleId: "handle-sam" });
    const readAt = "readAt" in outcome ? Date.parse(outcome.readAt) : NaN;
    expect(Math.abs(readAt - before)).toBeLessThan(60_000);
    expect(schemaErrors("handleTargets.response", outcome)).toEqual([]);
  });

  it("under a business scope the call refuses to run: the scope would hide the other businesses' targets", async () => {
    await given("targets-alex.json");
    await expect(
      withBusiness(runtime, "biz-lees-barbershop", (tx) => handleTargetsIn(tx, { handleId: "handle-alex" })),
    ).rejects.toThrow("handleTargets runs on the runtime side, with no business scope");
  });

  it("a request with anything but handleId is refused before any read", async () => {
    await expect(
      handleTargets(runtime, {
        handleId: "handle-alex",
        businessId: "biz-yoga-studio",
      } as HandleTargetsRequest),
    ).rejects.toThrow("handleTargets: the request takes only handleId");
    await expect(handleTargets(runtime, { handleId: "" })).rejects.toThrow("handleId is a non-empty id");
  });

  it(
    "a handle two people write from: both people with their live roles, the bookings either booked or is served by",
    SLOW,
    async () => {
      await given("targets-alex.json");
      await db.sql.begin(async (tx) => {
        await tx`insert into handles (id, kind, address) values ('handle-shared', 'phone', '+15555550160')`;
        await tx`insert into person_handles (person_id, handle_id)
                 values ('person-riley', 'handle-shared'), ('person-alex', 'handle-shared')`;
        // An ended role is not live; Riley is staff at the barbershop (seeded).
        await tx`insert into person_roles (id, person_id, business_id, role, ended_at)
                 values ('role-riley-yoga-ended', 'person-riley', 'biz-yoga-studio', 'staff', '2026-10-01T00:00:00Z')`;
        // Riley served (booked by Sam), and Riley only paying: the first is Riley's booking, the second is not.
        await tx`insert into bookings (id, business_id, flow, stage, booker_person_id, served_person_id,
                                       payer_person_id)
                 values ('booking-riley-served', 'biz-movers', 'B', 'done', 'person-sam', 'person-riley', null),
                        ('booking-riley-pays', 'biz-movers', 'B', 'entry', 'person-sam', 'person-sam', 'person-riley')`;
      });
      const outcome = await handleTargets(runtime, { handleId: "handle-shared" }, { now: new Date(0) });
      expect(outcome).toMatchObject({
        result: "targets",
        handleId: "handle-shared",
        openQuestions: [],
        phone: null,
      });
      if (!("persons" in outcome)) {
        throw new Error("expected targets");
      }
      expect(outcome.persons).toEqual([
        {
          personId: "person-alex",
          roles: [
            { roleId: "role-alex-barber", businessId: "biz-lees-barbershop", role: "customer", version: 1 },
            { roleId: "role-alex-yoga", businessId: "biz-yoga-studio", role: "customer", version: 1 },
          ],
        },
        {
          personId: "person-riley",
          roles: [
            { roleId: "role-riley-barber", businessId: "biz-lees-barbershop", role: "staff", version: 1 },
          ],
        },
      ]);
      expect(outcome.bookings.map((booking) => [booking.id, booking.stage])).toEqual([
        ["booking-alex-haircut", "booked"],
        ["booking-alex-workshop", "booked"],
        ["booking-riley-served", "done"],
      ]);
      // A question is listed by the handle it was sent to, not by its people: none was sent to this handle.
      expect(outcome.openQuestions).toEqual([]);
      expect(schemaErrors("handleTargets.response", outcome)).toEqual([]);
    },
  );

  it(
    "a question's send time counts only parts that went to its own handle: the email copy's parts never move it",
    SLOW,
    async () => {
      const exchange = await given("targets-alex.json");
      // The email copy to Alex's other handle goes later; its part is sent, and a later poll part there too.
      await db.sql.begin(async (tx) => {
        await tx`update outbox_rows set state = 'sent', version = version + 1 where id = 'out-a7-03-alex-email'`;
        await tx`insert into outbox_parts (outbox_row_id, part_no, try_no, idempotency_key, kind, linq_message_id,
                                           state, sent_at)
                 values ('out-a7-03-alex-email', 1, 1, 'out-a7-03-alex-email/1/1', 'poll', 'resend-msg-demo-0001',
                         'sent', '2026-10-23T14:09:00Z')`;
      });
      const outcome = await handleTargets(
        runtime,
        { handleId: "handle-alex" },
        { now: new Date(exchange.given.now) },
      );
      expect(outcome).toEqual(exchange.outcome);
    },
  );

  it(
    "a question asked again gives its newest send and poll; a pending part and a failed one are never a send",
    SLOW,
    async () => {
      await given("targets-alex.json");
      await db.sql.begin(async (tx) => {
        await tx`update open_questions set ask_count = 2, version = version + 1 where id = 'oq-a7-03-alex'`;
        await tx`insert into outbox_rows (id, turn_id, recipient_handle_id, recipient_person_id, business_id,
                                          booking_id, channel, send_class, versions_read, open_question_id, state,
                                          bundle_hash, bundle_build, trace_id)
                 select 'out-a7-03-alex-again', turn_id, recipient_handle_id, recipient_person_id, business_id,
                        booking_id, channel, send_class, versions_read, open_question_id, 'sending', bundle_hash,
                        bundle_build, trace_id
                 from outbox_rows where id = 'out-a7-03-alex'`;
        await tx`insert into outbox_parts (outbox_row_id, part_no, try_no, idempotency_key, kind, linq_message_id,
                                           state, sent_at, delivered_at, failed_at)
                 values ('out-a7-03-alex-again', 1, 1, 'out-a7-03-alex-again/1/1', 'words', 'linq-msg-demo-0011',
                         'delivered', '2026-10-24T09:00:00Z', '2026-10-24T09:00:02Z', null),
                        ('out-a7-03-alex-again', 2, 1, 'out-a7-03-alex-again/2/1', 'poll', 'linq-msg-demo-0012',
                         'sent', '2026-10-24T09:00:05Z', null, null),
                        ('out-a7-03-alex-again', 2, 2, 'out-a7-03-alex-again/2/2', 'poll', null, 'pending', null,
                         null, null),
                        ('out-a7-03-alex-again', 1, 2, 'out-a7-03-alex-again/1/2', 'words', 'linq-msg-demo-0013',
                         'failed', '2026-10-24T09:30:00Z', null, '2026-10-24T09:30:01Z')`;
      });
      const outcome = await handleTargets(runtime, { handleId: "handle-alex" }, { now: new Date(0) });
      if (!("openQuestions" in outcome)) {
        throw new Error("expected targets");
      }
      expect(
        outcome.openQuestions.map((question) => [question.sentAt, question.pollId, question.askCount]),
      ).toEqual([["2026-10-24T09:00:05Z", "linq-msg-demo-0012", 2]]);
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

describe("handleTargets: a statement's own refusal and postgres.js's statement errors leave scrubbed (T-1322)", () => {
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
    { call: "handleTargets", run: (sql) => handleTargets(sql, { handleId: "handle-t1322" }) },
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

// ---- T-1334: inRuntimeTransaction's start and its rollback rule (T-1314's handoff, Gives 3; DL-649) ------------------
//
// inRuntimeTransaction, under every runtime-side call (handleTargets, sendState and handleSealingKey here, the three that
// do not guard themselves: T-1330's finding a), reserves its connection through bundles.ts's reserveConnection, so a
// reserve() that never connects leaves as the code 08001 alone, which each call answers transient, never as postgres.js
// raises it. It writes no rollback to a connection fn found gone, and never releases it (DL-649): a statement's failure
// that isLostConnection reads as lost (T-1314's rule), that is a session's failure, or that transientOrThrow answers 08001.
//
// A reserve() that never connects is raised for real through postgres.js's own socket option on the client reserve()
// opens its connection on, while the pre-probe answers on this file's runtime client: the Workers build's failure, with no
// code and no statement (cf/polyfills.js; connection.js queryError), the made-up connection string in its message; and
// Node's ECONNREFUSED on a closed port. A connection fn finds gone is cut for real, as frontier.int.test.ts cuts one
// (T-1330): a client of this file's schema as the runtime client is made (rosie_job, the schema first) whose socket is
// cut just before fn's first statement goes, which is then never written. The socket is destroyed with an error built in
// the shape Node, OpenSSL or postgres.js gives it, which postgres.js rejects the statement with, the statement put on it,
// or with none (postgres.js's own CONNECTION_CLOSED, naming the server's host and port). Each raw error holds what it
// names, so the checks mean something; each outcome holds none of it; nothing is sent after the cut, no rollback and no
// commit; nothing is thrown outside a promise; a statement sent on the same client at once, before the socket's close
// event, is answered on a new connection, so the dead connection was never released to the pool; and the call then
// answers on the same client. An error fn makes itself, on no statement, found no connection gone, whatever its code: it
// is rolled back and released, as on main (frontier.int.test.ts's own error that carries a connection's detail).
//
// Rule 9: the probe's user, password, database, host, address and port are made up here (a .invalid name, RFC 5737's
// documentation address), and the number is a 555-01xx one. A check names what leaked, never its value.

describe("T-1334: inRuntimeTransaction reserves through reserveConnection and writes no rollback to a connection fn found gone", () => {
  const PROBE_USER = "t1334_probe_user";
  const PROBE_PASSWORD = "t1334-probe-password";
  const PROBE_DATABASE = "t1334_probe_db";
  const HOST = "db-t1334.example.invalid";
  const ADDRESS = "203.0.113.34";
  const PORT = 65134;
  const NEVER_OPENED = { error: "transient", sqlstate: "08001" };
  const LOST = { error: "transient", sqlstate: "08006" };
  /** The transaction's clearing of the business scope: fn's first statement is the one built right after it. */
  const CLEAR_SCOPE = "select set_config($1, '', true)";
  /** How long a call may take before it counts as never settled (a statement written to no socket never settles). */
  const SETTLES_WITHIN = 10_000;

  type Secrets = Readonly<Record<string, RegExp>>;
  type Outcome = { answer: unknown } | { thrown: unknown };
  /** What a call gives: K-05's answer, or an error thrown scrubbed to the call's name and this code alone. */
  type Expected = { answer: unknown } | { code: string };

  const probeUrl = (host: string, port: number): string =>
    `postgres://${PROBE_USER}:${PROBE_PASSWORD}@${host}:${String(port)}/${PROBE_DATABASE}`;

  /** The secrets by name: a text wherever it appears, a number (a port) as a whole number. */
  function secretsOf(values: Readonly<Record<string, string | number>>): Secrets {
    const secrets: Record<string, RegExp> = {};
    for (const [name, value] of Object.entries(values)) {
      secrets[name] =
        typeof value === "number"
          ? new RegExp(`(^|[^0-9])${String(value)}([^0-9]|$)`)
          : new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
    return secrets;
  }

  /** The made-up connection the built errors name. */
  const SHAPE_SECRETS = secretsOf({
    host: HOST,
    address: ADDRESS,
    port: PORT,
    user: PROBE_USER,
    password: PROBE_PASSWORD,
    database: PROBE_DATABASE,
  });

  /**
   * What an outcome must never hold: the made-up connection, and the local server's host and port, which postgres.js's
   * own CONNECTION_CLOSED names. The local login, password and database are `rosie`, this repository's own folder, which
   * every stack's file paths name, so they are not listed: postgres.js's connection errors never carry them.
   */
  function cutSecrets(): Secrets {
    const url = new URL(resolvePrimaryUrl());
    const port = url.port === "" ? 5432 : Number(url.port);
    return { ...SHAPE_SECRETS, ...secretsOf({ "server host": url.hostname, "server port": port }) };
  }

  /** Every text `value` holds, deeply: its own property names and values, enumerable or not (an error's stack too). */
  function textsOf(value: unknown, seen = new Set<object>()): string[] {
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
  }

  /** The names of the secrets `value` holds anywhere, never their values. */
  function leaksOf(value: unknown, secrets: Secrets): string[] {
    const texts = textsOf(value);
    return Object.entries(secrets)
      .filter(([, secret]) => texts.some((text) => secret.test(text)))
      .map(([name]) => name);
  }

  async function outcomeOf(run: () => Promise<unknown>): Promise<Outcome> {
    try {
      return { answer: await run() };
    } catch (error) {
      return { thrown: error };
    }
  }

  function syncOutcomeOf(run: () => unknown): Outcome {
    try {
      return { answer: run() };
    } catch (error) {
      return { thrown: error };
    }
  }

  /**
   * What `run` gives, or "never settled" after SETTLES_WITHIN, and every error thrown outside any promise meanwhile:
   * postgres.js writes a statement from a timer, so a write to a connection with no socket throws there.
   */
  async function watched(
    run: () => Promise<unknown>,
  ): Promise<{ outcome: Outcome | "never settled"; uncaught: unknown[] }> {
    const uncaught: unknown[] = [];
    const note = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", note);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        outcomeOf(run),
        new Promise<"never settled">((resolve) => {
          timer = setTimeout(() => {
            resolve("never settled");
          }, SETTLES_WITHIN);
        }),
      ]);
      // A write postgres.js put on a timer has run by the next turn of the event loop.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      return { outcome, uncaught };
    } finally {
      clearTimeout(timer);
      process.off("uncaughtException", note);
    }
  }

  /** `outcome` is `expected`: the answer, or an error with the call's name and the code alone, nothing of the original. */
  function expectOutcome(outcome: Outcome | "never settled", expected: Expected, call: string): void {
    if ("answer" in expected) {
      expect(outcome, call).toEqual({ answer: expected.answer });
      return;
    }
    if (outcome === "never settled" || !("thrown" in outcome)) {
      throw new Error(`${call} did not throw`);
    }
    const { thrown } = outcome;
    expect(thrown, call).toBeInstanceOf(Error);
    expect(Object.getOwnPropertyNames(thrown).sort(), call).toEqual(["call", "code", "message", "stack"]);
    expect(thrown, call).toMatchObject({
      call,
      code: expected.code,
      message: `${call}: the database call failed (code ${expected.code})`,
    });
  }

  // The three runtime-side calls that do not guard themselves (T-1330's finding a), each on ids no fixture holds.
  const KEY_REQUEST: HandleSealingKeyRequest = {
    handle: { kind: "phone", address: "+15555550134" },
    newHandleId: "handle-t1334-key",
    newPersonId: "person-t1334-key",
    wrappingKeyName: WRAP_NAME,
  };
  const CALLS: { call: string; run: (sql: Sql) => Promise<unknown>; answers: Record<string, unknown> }[] = [
    {
      call: "handleTargets",
      run: (sql) => handleTargets(sql, { handleId: "handle-t1334-none" }),
      answers: { error: "notFound", table: "handles", rowId: "handle-t1334-none" },
    },
    {
      call: "sendState",
      run: (sql) => sendState(sql, { outboxRowId: "out-t1334-none" }),
      answers: { error: "notFound", table: "outbox_rows", rowId: "out-t1334-none" },
    },
    {
      call: "handleSealingKey",
      run: async (sql) => (await handleSealingKey(sql, keys, KEY_REQUEST)).outcome,
      answers: { result: "key", handleId: "handle-t1334-key", personId: "person-t1334-key" },
    },
  ];

  // ---- a reserve() that never connects (T-1314's handoff, Gives 3) ----------------------------------------------------

  /** The Workers build's socket error (cf/polyfills.js passes the socket's own failure up): no code. */
  const workersSocketError = (): Error => new Error(`Network connection lost: ${probeUrl(HOST, PORT)}`);

  /**
   * A client on the made-up connection whose socket fails with `raw` before it opens, as the Workers build's socket would
   * fail it (postgres.js's own socket option): postgres.js passes `raw` up as it does a socket's error.
   */
  function failingSocketClient(raw: Error): Sql {
    const options = { max: 1, onnotice: () => undefined, socket: () => Promise.reject(raw) };
    return postgres(probeUrl(HOST, PORT), options);
  }

  /**
   * `statements` with `reserving`'s reserve(): the pre-probe answers on `statements`, and only reserve() opens a
   * connection, as when the probe's connection was taken meanwhile and the one reserve() opens never connects.
   */
  function reserveFrom(statements: Sql, reserving: Sql): Sql {
    return new Proxy(statements, {
      get: (target, key, receiver): unknown =>
        key === "reserve" ? () => reserving.reserve() : (Reflect.get(target, key, receiver) as unknown),
    });
  }

  /** A local port nothing listens on: one the system just handed out and took back. */
  async function closedPort(): Promise<number> {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    server.close();
    await once(server, "close");
    return port;
  }

  it("a reserve() that never connects, as the Workers build passes it up (no code, no statement): each call answers 08001, holding none of it", async () => {
    for (const { call, run } of CALLS) {
      const raw = workersSocketError();
      const reserving = failingSocketClient(raw);
      let outcome: Outcome;
      try {
        outcome = await outcomeOf(() => run(reserveFrom(runtime, reserving)));
      } finally {
        await reserving.end({ timeout: 0 });
      }
      expect(outcome, call).toEqual({ answer: NEVER_OPENED });
      expect(leaksOf(outcome, SHAPE_SECRETS), call).toEqual([]);
      // postgres.js passed the socket's error up as it is: no code, no statement, the made-up connection in its message.
      expect((raw as { code?: unknown }).code, call).toBeUndefined();
      expect(Object.hasOwn(raw, "query") || Object.hasOwn(raw, "parameters"), call).toBe(false);
      expect(leaksOf(raw, SHAPE_SECRETS), call).toEqual(
        expect.arrayContaining(["host", "port", "user", "password", "database"]),
      );
      // The call's own answer to a failure (clocks.ts transientOrScrubbed) would throw it as it is: only
      // reserveConnection makes it a connection that never opened.
      const direct = syncOutcomeOf(() => transientOrScrubbed(call, raw));
      expect("thrown" in direct && direct.thrown === raw, call).toBe(true);
    }
  });

  it("a reserve() that never connects, for real on a closed port (Node's ECONNREFUSED, on no statement): each call answers 08001", async () => {
    const port = await closedPort();
    const secrets = secretsOf({ port, user: PROBE_USER, password: PROBE_PASSWORD, database: PROBE_DATABASE });
    for (const { call, run } of CALLS) {
      const reserving = postgres(probeUrl("127.0.0.1", port), { max: 1, onnotice: () => undefined });
      let outcome: Outcome;
      try {
        outcome = await outcomeOf(() => run(reserveFrom(runtime, reserving)));
      } finally {
        await reserving.end({ timeout: 0 });
      }
      expect(outcome, call).toEqual({ answer: NEVER_OPENED });
      expect(leaksOf(outcome, secrets), call).toEqual([]);
    }
  });

  it("inRuntimeTransaction itself throws a reserve() that never connects as the code 08001 alone, and fn never runs", async () => {
    const raw = workersSocketError();
    const reserving = failingSocketClient(raw);
    let ran = false;
    let outcome: Outcome;
    try {
      outcome = await outcomeOf(() =>
        inRuntimeTransaction(reserveFrom(runtime, reserving), { readOnly: false }, () => {
          ran = true;
          return Promise.resolve("ran");
        }),
      );
    } finally {
      await reserving.end({ timeout: 0 });
    }
    expect(ran).toBe(false);
    if (!("thrown" in outcome)) {
      throw new Error("inRuntimeTransaction answered");
    }
    const { thrown } = outcome;
    expect(thrown === raw).toBe(false);
    expect(Object.getOwnPropertyNames(thrown).sort()).toEqual(["code", "message", "stack"]);
    expect(thrown).toMatchObject({
      code: "08001",
      message: "the database connection never opened (SQLSTATE 08001)",
    });
    expect(leaksOf(thrown, SHAPE_SECRETS)).toEqual([]);
  });

  // ---- a connection fn found gone (DL-649) -------------------------------------------------------------------------

  /** Where a client's socket is cut: before the statement `at` picks (the last built), with `raw`, or none (it closes). */
  interface Cut {
    at: (sent: readonly string[]) => boolean;
    raw: Error | null;
  }

  /**
   * A client of this file's schema as the runtime client is made (rosie_job, the schema first), one connection, through a
   * socket to the same server that is cut once, as `cut` says (postgres.js's own socket option, as T-1330's
   * frontier.int.test.ts cuts one). `sent` holds each statement's text as postgres.js built it (its debug hook), in
   * order, never a value: a statement written to a connection with no socket is built, so it is listed too.
   */
  function cutClient(cut: Cut | null): { sql: Sql; sent: string[] } {
    const url = new URL(resolvePrimaryUrl());
    const sent: string[] = [];
    let cutting = false;
    let cutDone = false;
    const options = {
      max: 1,
      onnotice: () => undefined,
      connection: {
        application_name: "rosie-t1334-targets-cut",
        search_path: `${db.schema}, public`,
        role: RUNTIME_ROLE,
      },
      debug: (_connection: number, text: string) => {
        sent.push(text.trim());
        if (cut !== null && !cutDone && cut.at(sent)) {
          cutting = true;
          cutDone = true;
        }
      },
      socket: () => {
        const socket = createConnection(url.port === "" ? 5432 : Number(url.port), url.hostname);
        const write = socket.write.bind(socket);
        socket.write = ((...args: Parameters<typeof write>) => {
          if (!cutting) return write(...args);
          cutting = false;
          socket.destroy(cut?.raw ?? undefined);
          return true;
        }) as typeof socket.write;
        return socket;
      },
    };
    return { sql: postgres(resolvePrimaryUrl(), options), sent };
  }

  /** fn's first statement: the one built right after the transaction cleared the business scope. */
  const fnsFirst = (sent: readonly string[]): boolean => sent.at(-2) === CLEAR_SCOPE;

  // The errors, in the shapes Node, OpenSSL and postgres.js give them, each naming the made-up connection.

  /** postgres.js's own connection error (errors.js connection): "write <code> <host>:<port>". */
  const connectionError = (code: string): Error =>
    Object.assign(new Error(`write ${code} ${HOST}:${String(PORT)}`), {
      code,
      errno: code,
      address: HOST,
      port: PORT,
    });
  /** Node's error for a connection the other end reset under a read: syscall read, and no address on it. */
  const resetError = (): Error =>
    Object.assign(new Error("read ECONNRESET"), { errno: -54, code: "ECONNRESET", syscall: "read" });
  /** A socket's failure with no code (the Workers build's), naming the made-up connection string. */
  const codelessError = (): Error => new Error(`the socket closed: ${probeUrl(HOST, PORT)}`);
  /** Node's error on a connected socket's read or write: the syscall, the address and the port. */
  const socketError = (syscall: string, code: string, errno: number): Error =>
    Object.assign(new Error(`${syscall} ${code} ${ADDRESS}:${String(PORT)}`), {
      errno,
      code,
      syscall,
      address: ADDRESS,
      port: PORT,
    });
  /** OpenSSL's error for a record it could not decrypt, as Node's TLS socket gives it, the made-up host and port in it. */
  const tlsRecordError = (): Error =>
    Object.assign(
      new Error(`error:0A000119:SSL routines::decryption failed or bad record mac (${HOST}:${String(PORT)})`),
      {
        library: "SSL routines",
        reason: "decryption failed or bad record mac",
        code: "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC",
      },
    );
  /** A socket's error that no list names, known only by a connection's marks (syscall, errno), the made-up host on it. */
  const ioError = (): Error =>
    Object.assign(new Error(`read EIO ${HOST}`), { errno: -5, code: "EIO", syscall: "read", hostname: HOST });

  const CUTS: { name: string; raw: () => Error | null; holds: readonly string[]; expected: Expected }[] = [
    // isLostConnection's own, as T-1314 left it (T-1330's four ways): the rule before this card already wrote no rollback.
    {
      name: "the socket closes: postgres.js's own CONNECTION_CLOSED, the server's host and port in it",
      raw: () => null,
      holds: ["server host", "server port"],
      expected: { answer: LOST },
    },
    {
      name: "postgres.js's CONNECTION_CLOSED, the made-up host and port on it",
      raw: () => connectionError("CONNECTION_CLOSED"),
      holds: ["host", "port"],
      expected: { answer: LOST },
    },
    { name: "Node's ECONNRESET under a read", raw: resetError, holds: [], expected: { answer: LOST } },
    {
      name: "a socket's failure with no code (the Workers build's), the made-up connection string in it",
      raw: codelessError,
      holds: ["host", "port", "user", "password", "database"],
      expected: { answer: LOST },
    },
    // DL-649's: a statement's failure that transientOrThrow answers 08001, or that is a session's failure.
    {
      name: "Node's EHOSTUNREACH under a read, the made-up address and port on it (answered 08001)",
      raw: () => socketError("read", "EHOSTUNREACH", -65),
      holds: ["address", "port"],
      expected: { answer: NEVER_OPENED },
    },
    {
      name: "Node's EPERM on a write, the made-up address and port on it (a session's failure)",
      raw: () => socketError("write", "EPERM", -1),
      holds: ["address", "port"],
      expected: { code: "EPERM" },
    },
    {
      name: "OpenSSL's bad record MAC under a read, the made-up host and port in it (a TLS error)",
      raw: tlsRecordError,
      holds: ["host", "port"],
      expected: { code: "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC" },
    },
    {
      name: "Node's EIO under a read, known by a connection's marks alone, the made-up host on it",
      raw: ioError,
      holds: ["host"],
      expected: { code: "EIO" },
    },
  ];

  it.each(CUTS)(
    "fn's first statement cut ($name): no rollback, nothing thrown outside a promise, the error that leaves scrubbed; the same client then answers",
    async ({ raw, holds, expected }) => {
      const secrets = cutSecrets();
      // The raw error holds what it names, and postgres.js put the statement it rejected on it.
      const probe = cutClient({ at: (sent) => sent.at(-1) === "select 1 as t1334_cut", raw: raw() });
      let rejected: Outcome;
      try {
        rejected = await outcomeOf(() => probe.sql`select 1 as t1334_cut`);
      } finally {
        await probe.sql.end({ timeout: 0 });
      }
      if (!("thrown" in rejected)) {
        throw new Error("the cut statement answered");
      }
      expect(leaksOf(rejected.thrown, secrets)).toEqual(expect.arrayContaining([...holds]));
      expect(Object.hasOwn(rejected.thrown as object, "query")).toBe(true);

      for (const { call, run, answers } of CALLS) {
        const client = cutClient({ at: fnsFirst, raw: raw() });
        try {
          const watchedRun = await watched(async () => {
            const called = await outcomeOf(() => run(client.sql));
            const builtBefore = client.sent.length;
            // At once, before the socket's close event comes (Node emits a destroyed socket's error first): a statement
            // that a dead connection released to the pool would take and never answer (postgres.js 3.4.9 queues its
            // write on that connection, and the close then drops it). Not released, it waits for the pool to reconnect.
            const followed = await outcomeOf(async () => [
              ...(await client.sql<{ n: number }[]>`select 2 as n`),
            ]);
            return { called, builtBefore, followed };
          });
          expect(watchedRun.outcome, call).not.toBe("never settled");
          expect(watchedRun.uncaught, call).toEqual([]);
          const { called, builtBefore, followed } = (
            watchedRun.outcome as { answer: { called: Outcome; builtBefore: number; followed: Outcome } }
          ).answer;
          // The cut statement, fn's first, is the last one built: no rollback and no commit after it.
          expect(builtBefore, call).toBe(client.sent.lastIndexOf(CLEAR_SCOPE) + 2);
          expect(leaksOf(called, secrets), call).toEqual([]);
          expectOutcome(called, expected, call);
          // The dead connection was never released: the next statement waited for a new one, which answered it.
          expect(followed, call).toEqual({ answer: [{ n: 2 }] });
          // And the call itself answers on the same client.
          const again = await watched(() => run(client.sql));
          expect(again.uncaught, call).toEqual([]);
          expect(again.outcome, call).toMatchObject({ answer: answers });
        } finally {
          await client.sql.end({ timeout: 0 });
        }
      }
    },
    SLOW.timeout,
  );

  it("an error fn makes itself, on no statement, found no connection gone, whatever its code: rolled back and released", async () => {
    const own = socketError("connect", "EACCES", -13);
    expect(leaksOf(own, SHAPE_SECRETS)).toEqual(expect.arrayContaining(["address", "port"]));
    const client = cutClient(null);
    try {
      const { outcome, uncaught } = await watched(() =>
        inRuntimeTransaction(client.sql, { readOnly: true }, async (tx) => {
          await tx`select 1 as t1334_read`;
          throw own;
        }),
      );
      expect(uncaught).toEqual([]);
      // fn's error leaves as it is (its caller answers it: clocks.ts transientOrScrubbed), after the rollback.
      expect(outcome !== "never settled" && "thrown" in outcome && outcome.thrown === own).toBe(true);
      expect(client.sent.at(-1)).toBe("rollback");
      // Released: the client's one connection answers the next statement.
      const next = await watched(async () => [...(await client.sql<{ n: number }[]>`select 2 as n`)]);
      expect(next.outcome).toEqual({ answer: [{ n: 2 }] });
    } finally {
      await client.sql.end({ timeout: 0 });
    }
  });
});
