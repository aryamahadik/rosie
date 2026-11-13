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
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "./client";
import { DataAccessDatabaseError } from "./clocks";
import { handleSealingKey, type HandleSealingKeyRequest } from "./handle-keys";
import { type Sql, type Tx, withBusiness } from "./scope";
import { handleTargets, handleTargetsIn, type HandleTargetsRequest } from "./targets";
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
