// T-220: K-05 v1.2's sendState, limit 8's read of a recipient's send state, against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/send-state`). The schema comes from migrating a fresh test
// schema.
//
// Every call runs on the runtime side as K-05 v1.2 states it (README line 153): through a client whose connections run
// as rosie_job (T-191: the dispatcher's role) with no business scope, so the grants and row-level security are the
// ones limit 8 meets. The tables' owner (the migrations' role) writes the seeds and the state a fixture's `given` names.
//
// A fixture's `given.after` names the exchanges that run first (each with its own `given`). reserve (T-187) runs for
// real. The commit, plan and claim calls (T-195, T-196) are not built yet, so each of those steps writes, directly and
// as the owner, the rows its exchange states in its request and its outcome: what the reads that follow see. A STOP is
// committed the way the guard's path will (T-183's setPhoneStopped and T-192's appendConsent in one transaction).
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "./client";
import { appendConsent } from "./consent";
import { setPhoneStopped } from "./phones";
import { reserve, type ReserveRequest } from "./reservations";
import { type Sql, type Tx, withBusiness } from "./scope";
import {
  sendState,
  sendStateIn,
  type SendStateOutcome,
  type SendStateRequest,
  type SendStateResponse,
  VERSIONED_HOMES,
} from "./send-state";
import { createTestDatabase, type TestDatabase } from "./test-db";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Step = (sql: Db, exchange: Exchange) => Promise<void>;

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const RUNTIME_ROLE = "rosie_job";
const HASH = "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037";
const ALEX_MOBILE = "+15555550101";
const ALEX_ROW = "out-alex-booked-riley";
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
const SEND_STATE_FIXTURES = INDEX.filter((entry) => entry.def === "sendState.exchange").map(
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

beforeAll(async () => {
  db = await createTestDatabase({ name: "send_state" });
  runtime = postgres(resolvePrimaryUrl(), {
    max: 10,
    onnotice: () => undefined,
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

/** The chain steps of calls not built yet, by call: each writes what its exchange states. */
const STEPS: Readonly<Record<string, Step>> = {
  commitTurn: commitStep,
  writePlan: writePlanStep,
  claimOutbox: claimStep,
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

/** The answer, which must be a send state. */
function stateOf(outcome: SendStateOutcome): SendStateResponse {
  if (!("result" in outcome)) {
    throw new Error(`expected a send state, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

/** Adds an outbox row of Alex's booking turn, sending, with the values given over these. */
async function addOutboxRow(values: Record<string, Json>): Promise<void> {
  await insertRow(db.sql, "outbox_rows", {
    turn_id: "turn-alex-book-1",
    recipient_handle_id: "handle-alex",
    recipient_person_id: "person-alex",
    business_id: "biz-lees-barbershop",
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

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("sendState: each K-05 v1.2 fixture gives its response (K-05 item 28)", () => {
  it("the index lists limit 8's five exchanges, each valid against data-access v1.2", () => {
    expect([...SEND_STATE_FIXTURES].sort()).toEqual([
      "send-state-booking-cancelled.json",
      "send-state-customer.json",
      "send-state-no-chat.json",
      "send-state-owner.json",
      "send-state-stopped.json",
    ]);
    for (const file of SEND_STATE_FIXTURES) {
      expect(schemaErrors("sendState.exchange", exchangeOf(file)), file).toEqual([]);
    }
  });

  it("the test client runs as rosie_job, with this file's schema first and no business scope", async () => {
    const [row] = await runtime<{ who: string; scope: string | null }[]>`
      select current_user as who, current_setting('rosie.business_id', true) as scope
    `;
    expect(row?.who).toBe(RUNTIME_ROLE);
    expect(row?.scope ?? "").toBe("");
  });

  for (const file of SEND_STATE_FIXTURES) {
    it(
      `${file}: as rosie_job with no business scope, the call answers the fixture's outcome`,
      SLOW,
      async () => {
        const exchange = await given(file);
        const outcome = await sendState(runtime, exchange.request as unknown as SendStateRequest, {
          now: new Date(exchange.given.now),
        });
        expect(outcome).toEqual(exchange.outcome);
        expect(schemaErrors("sendState.response", outcome)).toEqual([]);
      },
    );
  }
});

describe("right after a STOP commits, send state says stopped (the primary, no cache)", () => {
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
      expect(after.textsConsent).toEqual({
        consentId: "consent-alex-stop-t220",
        businessId: null,
        revoked: true,
        at: "2026-11-07T15:06:36Z",
      });
      expect(after.rowState).toBe("sending");
      expect(schemaErrors("sendState.response", after)).toEqual([]);
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
        expect(state.textsConsent, `round ${String(round)}`).toMatchObject({
          consentId: `consent-alex-round-${String(round)}`,
          businessId: null,
          revoked: stopped,
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
      withBusiness(runtime, "biz-lees-barbershop", (tx) => sendStateIn(tx, { outboxRowId: ALEX_ROW })),
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
          business_id: "biz-lees-barbershop",
          target: "phone",
          phone_number: ALEX_MOBILE,
          set_by_turn_id: "turn-sam-pauses",
        });
        await pause({
          id: "pause-a-alex-person",
          business_id: "biz-lees-barbershop",
          target: "person",
          person_id: "person-alex",
        });
        // Left out: a cleared pause, another business's pause, another person's, and an address pause.
        await pause({
          id: "pause-c-cleared",
          business_id: "biz-lees-barbershop",
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
          business_id: "biz-lees-barbershop",
          target: "person",
          person_id: "person-riley",
        });
        await pause({
          id: "pause-f-address",
          business_id: "biz-lees-barbershop",
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
      expect(schemaErrors("sendState.response", state)).toEqual([]);
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
        business_id: "biz-lees-barbershop",
        role: "owner",
      });
      expect(stateOf(await sendState(runtime, { outboxRowId: ALEX_ROW })).audience).toBe("owner");
      for (const state of [riley, none]) {
        expect(schemaErrors("sendState.response", state)).toEqual([]);
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
          { table: "businesses", rowId: "biz-lees-barbershop", version: 3 },
        ],
      });
      await db.sql`update businesses set display_name = 'Lee''s', version = version + 1 where id = 'biz-lees-barbershop'`;
      const state = stateOf(await sendState(runtime, { outboxRowId: "out-t220-versions" }));
      expect(state.currentVersions).toEqual([
        { table: "phones", rowId: ALEX_MOBILE, version: 3 },
        { table: "bookings", rowId: "booking-alex-riley-nov14", version: 1 },
        { table: "businesses", rowId: "biz-lees-barbershop", version: 4 },
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
          business_id: "biz-lees-barbershop",
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
        businessId: "biz-lees-barbershop",
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
          businessId: "biz-lees-barbershop",
          revoked: false,
          at: "2026-11-01T10:00:00Z",
        },
      });
      expect(schemaErrors("sendState.response", state)).toEqual([]);
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
