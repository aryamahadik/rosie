// The seed of staging's copy sources' test file (T-1306; ./copies.worker.test.ts; key COPIES in
// infra/test-rig/files.mjs): the rows K-05 v1.12's readLiveTimers and readStoppedFlag (items 56 and 57) answer from, for
// the five fixtures the card names (contracts/data-access/fixtures/read-live-timers-*.json and read-stopped-flag-*.json).
// The rig's globalSetup (infra/test-rig/rig.mjs) runs it once, in Node, on this file's database, after the migrations and
// bundle v0, with a client of the connecting login.
//
// One world, written once. Two of the fixtures ask about one phone row, Alex's, in two states one database cannot hold
// together (stopped at version 4, and started again at 5), so four are seeded exactly and one stands on a handle of this
// file's own, in its fixture's shape. What differs from a fixture's `given` is named here; nothing the reads decide by
// differs. The fixtures' own chains are proved on the database side by db/repo's own test (db/repo/copy-reads.int.test.ts;
// T-1301), which runs each fixture's seeds and exchanges as it names them.
//
//   exactly, the fixture's own request and answer:
//     read-live-timers-sam            K-34's seed-safety-timer.json, after the K-04 rows its `after` chain names (K-04's
//                                     seed-person-roles.json, after seed-business-head.json): Sam alone on Alex's move
//                                     survey for the movers, Morgan Lee the contact who said yes, the job's address the
//                                     seed's stand-in bytes, sealed as stored. Its turn row is pinned to bundle v0 as the
//                                     rig publishes it, the one bundle this database holds (K-04's seed-bundle-
//                                     registry.json would be a second active one, which bundles_one_active refuses), and
//                                     nothing else of it is changed.
//     read-live-timers-none           the same rows: Morgan Lee is the pro of no timer.
//     read-stopped-flag-alex-stopped  Alex's phone row as commit-alex-stop.json leaves it: K-04's seed-phone-chat-open.json
//                                     row for him (version 3) with the commit's own `set` (stopped, the STOP's time, the
//                                     chat closed) at the next version, 4. The commit and its chain (claim-in-order.json,
//                                     seed-reservation.json) are not run: the read reads the phone row alone.
//     read-stopped-flag-no-phone      handle-sam, which holds no phone row here, as in K-04's seed-person-roles.json
//                                     (seed-phone-chat-open.json, which would give it one, is not loaded).
//   in the fixture's shape, on this file's own ids:
//     read-stopped-flag-alex-started  STARTED below: a person, a handle at a fictional number and their link, whose phone
//                                     row is Alex's as commit-alex-start.json then leaves it (not stopped, the START's
//                                     time, the chat open again, the STOP's time kept: DL-193) at version 5.
//   and one timer of this file's own: ODD_ID_TIMER below, Riley's, live, whose own id holds a space. K-05 allows that id
//   (formats.v1 id: any non-empty string) and copies.ts's isLabel refuses it, so the test shows the reload fail closed
//   on it (T-1248's runtime note). No other row names Riley's handle as a pro.
//
// Every row is written in one transaction as the runtime side's role, rosie_job, with no business scope, through its own
// grants and policies (db/migrations/0012 and 0016), as the other seeds write. Nothing is updated or deleted. A bytea value
// in K-04's text form ("\x" and hex digit pairs) is written as the bytes it spells (db/repo/bytea.ts), and a jsonb value
// as JSON. Test values only (rule 9): the master's sample cast and K-34's seed as the fixtures hold them, made-up ids,
// fictional 555-01xx numbers and stand-in sealed bytes, sealed under no key.
import commitAlexStart from "../../../../contracts/data-access/fixtures/commit-alex-start.json";
import commitAlexStop from "../../../../contracts/data-access/fixtures/commit-alex-stop.json";
import stoppedFixture from "../../../../contracts/data-access/fixtures/read-stopped-flag-alex-stopped.json";
import seedBusinessHead from "../../../../contracts/db-schema/core/fixtures/seed-business-head.json";
import seedPersonRoles from "../../../../contracts/db-schema/core/fixtures/seed-person-roles.json";
import seedPhoneChatOpen from "../../../../contracts/db-schema/core/fixtures/seed-phone-chat-open.json";
import seedSafetyTimer from "../../../../contracts/db-schema/safety-incidents/fixtures/seed-safety-timer.json";
import { byteaFromText } from "../../../../db/repo/bytea";
import { SCOPE_SETTING, type Sql, type Tx } from "../../../../db/repo/scope";

type Values = Readonly<Record<string, unknown>>;

/** One row as a seed fixture holds it: its table and its values, in K-04's text forms. */
export interface SeedRow {
  readonly table: string;
  readonly values: Values;
}

const rowsOf = (fixture: { readonly rows: readonly unknown[] }): readonly SeedRow[] =>
  fixture.rows as readonly SeedRow[];

/** A value that must be there: a fixture or a row this seed is written against. */
function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the copies seed: ${what} is missing`);
  return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---- the K-04 and K-34 rows, as their seeds hold them -----------------------------------------------------------------

/** K-34's seed timer's rows (seed-safety-timer.json), after the K-04 rows its `after` chain names, in that order. */
export const FIXTURE_ROWS: readonly SeedRow[] = [
  ...rowsOf(seedBusinessHead),
  ...rowsOf(seedPersonRoles),
  ...rowsOf(seedSafetyTimer),
];

// ---- Alex's phone row, stopped, and the stand-in's, started ----------------------------------------------------------

/** Alex's K-04 handle id, as read-stopped-flag-alex-stopped.json asks about it. */
export const ALEX_HANDLE = stoppedFixture.request.handleId;

/** A commit's update of one phone row: the row it names by number, its `set`, and the version it read. */
interface PhoneUpdate {
  readonly number: string;
  readonly set: Values;
  readonly expectVersion: number;
}

/** The one update of a phones row among a commit fixture's state writes. */
function phoneUpdateOf(commit: {
  readonly request: { readonly writes: { readonly state: unknown } };
}): PhoneUpdate {
  const writes = commit.request.writes.state;
  const updates = (Array.isArray(writes) ? (writes as unknown[]) : []).filter(
    (write): write is Record<string, unknown> =>
      isRecord(write) && write.op === "update" && write.table === "phones",
  );
  const [update] = updates;
  const key = update?.key;
  if (
    updates.length !== 1 ||
    update === undefined ||
    !isRecord(key) ||
    typeof key.number !== "string" ||
    !isRecord(update.set) ||
    typeof update.expectVersion !== "number"
  ) {
    throw new Error("the copies seed: a commit fixture does not update one phone row");
  }
  return { number: key.number, set: update.set, expectVersion: update.expectVersion };
}

/** A phone row after a commit's update of it: the commit's `set` on the row it read, at the next version. */
function afterUpdate(row: Values, update: PhoneUpdate): Values {
  if (row.number !== update.number || row.version !== update.expectVersion) {
    throw new Error("the copies seed: a commit fixture updates another phone row, or another version");
  }
  return { ...row, ...update.set, version: update.expectVersion + 1 };
}

/** Alex's phone row before his STOP, as K-04's seed-phone-chat-open.json holds it (version 3). */
const ALEX_PHONE_BEFORE = need(
  rowsOf(seedPhoneChatOpen).find((row) => row.table === "phones" && row.values.handle_id === ALEX_HANDLE),
  "K-04's phone row for Alex",
).values;

/** Alex's phone row as commit-alex-stop.json leaves it: stopped, its chat closed, at version 4. */
export const ALEX_STOPPED_PHONE: Values = afterUpdate(ALEX_PHONE_BEFORE, phoneUpdateOf(commitAlexStop));

/** The same row as commit-alex-start.json then leaves it: not stopped, its chat open, the STOP's time kept, version 5. */
const ALEX_STARTED_PHONE: Values = afterUpdate(ALEX_STOPPED_PHONE, phoneUpdateOf(commitAlexStart));

/** A handle of this file's own that stands in a fixture's shape: the fixture, its person, its handle and its number. */
export interface StandIn {
  /** The K-05 v1.12 fixture whose shape its rows have. */
  readonly fixture: string;
  readonly personId: string;
  readonly handleId: string;
  /** Its phone's number: a fictional 555-01xx one, a whole literal. */
  readonly number: string;
}

/** Alex's phone row once his START has committed (read-stopped-flag-alex-started.json), on this file's own ids. */
export const STARTED: StandIn = {
  fixture: "read-stopped-flag-alex-started.json",
  personId: "person-t1306-started",
  handleId: "handle-t1306-started",
  number: "+15555550181",
};

/** The stand-in's phone row: Alex's as commit-alex-start.json leaves it, under the stand-in's number and handle. */
export const STARTED_PHONE: Values = {
  ...ALEX_STARTED_PHONE,
  number: STARTED.number,
  handle_id: STARTED.handleId,
};

// ---- a live timer with an id copies.ts's isLabel refuses -------------------------------------------------------------

/** Stand-in sealed bytes, sealed under no key: never a real address, and never opened. */
const STAND_IN_WORDS = "t1306 stand-in bytes for a job's address, sealed under no key";

/** Bytes in K-04's text form: "\x" and two lower-case hex digits a byte. */
const hexText = (text: string): string =>
  `\\x${Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

/**
 * Riley's live timer at Lee's Barbershop whose own id holds a space: an id K-05 allows (formats.v1 id) and copies.ts's
 * isLabel refuses, so the copy's reload of Riley's handle fails closed on it. Morgan Lee is the contact who said yes (at
 * K-34's seed's time), and the address is sealed for Alex, as K-34's seed timer's is.
 */
export const ODD_ID_TIMER = Object.freeze({
  id: "timer t1306 riley",
  clockRowId: "clock-t1306-riley",
  handleId: "handle-riley",
  personId: "person-riley",
  businessId: "biz-lees-barbershop",
  contactPersonId: "person-morgan-lee",
  contactHandleId: "handle-morgan-lee",
  contactYesAt: "2026-10-20T14:00:00Z",
  startedAt: "2026-10-27T14:30:00Z",
  dueAt: "2026-10-27T16:30:00Z",
  dueZone: "America/New_York",
  address: hexText(STAND_IN_WORDS),
  addressForPersonId: "person-alex",
});

/** What the odd-id timer's stand-in bytes spell: never in an answer's opened form, a span, a log line or an error. */
export const ODD_ID_ADDRESS_WORDS = STAND_IN_WORDS;

/** The rows of this file's own: the stand-in's, Alex's phone row, and Riley's odd-id timer with its clock row. */
export const OWN_ROWS: readonly SeedRow[] = [
  { table: "phones", values: ALEX_STOPPED_PHONE },
  { table: "persons", values: { id: STARTED.personId, name: null, language: null } },
  { table: "handles", values: { id: STARTED.handleId, kind: "phone", address: STARTED.number } },
  { table: "person_handles", values: { person_id: STARTED.personId, handle_id: STARTED.handleId } },
  { table: "phones", values: STARTED_PHONE },
  {
    table: "clock_rows",
    values: {
      id: ODD_ID_TIMER.clockRowId,
      kind: "step",
      handle_id: ODD_ID_TIMER.handleId,
      business_id: ODD_ID_TIMER.businessId,
      booking_id: null,
      due_at: ODD_ID_TIMER.dueAt,
      due_zone: ODD_ID_TIMER.dueZone,
      state: "armed",
      armed_at: ODD_ID_TIMER.startedAt,
      fires: { step: "B8-86", safetyTimer: ODD_ID_TIMER.id },
    },
  },
  {
    table: "safety_timers",
    values: {
      id: ODD_ID_TIMER.id,
      business_id: ODD_ID_TIMER.businessId,
      booking_id: null,
      worker_person_id: ODD_ID_TIMER.personId,
      worker_handle_id: ODD_ID_TIMER.handleId,
      emergency_contact_person_id: ODD_ID_TIMER.contactPersonId,
      emergency_contact_handle_id: ODD_ID_TIMER.contactHandleId,
      contact_yes_at: ODD_ID_TIMER.contactYesAt,
      started_at: ODD_ID_TIMER.startedAt,
      due_at: ODD_ID_TIMER.dueAt,
      due_zone: ODD_ID_TIMER.dueZone,
      address: ODD_ID_TIMER.address,
      address_for_person_id: ODD_ID_TIMER.addressForPersonId,
      clock_row_id: ODD_ID_TIMER.clockRowId,
      state: "running",
      missed_at: null,
      safe_at: null,
    },
  },
];

// ---- writing them ---------------------------------------------------------------------------------------------------

/** The columns this seed's rows hold that are not plain text input: bytea in K-04's text form, and jsonb. */
const BYTEA_COLUMNS: ReadonlySet<string> = new Set(["safety_timers.address"]);
const JSONB_COLUMNS: ReadonlySet<string> = new Set(["clock_rows.fires"]);

/** A bundle id as the registry keys it. */
interface BundleId {
  readonly hash: string;
  readonly build: number;
}

/** One row, as written: each bytea value as the bytes its text spells, each jsonb value as JSON. */
async function insertRow(tx: Tx, row: SeedRow): Promise<void> {
  const values: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row.values)) {
    const name = `${row.table}.${column}`;
    if (BYTEA_COLUMNS.has(name)) {
      values[column] = need(byteaFromText(value) ?? undefined, `${name} in K-04's text form`);
    } else if (JSONB_COLUMNS.has(name) && value !== null) {
      values[column] = tx.json(value as Parameters<Tx["json"]>[0]);
    } else {
      values[column] = value;
    }
  }
  await tx`insert into ${tx(row.table)} ${tx(values as Record<string, never>)}`;
}

/** K-34's seed turn pinned to `bundle`: its bundle id changed, nothing else. */
function pinnedTo(row: SeedRow, bundle: BundleId): SeedRow {
  if (row.table !== "turns") return row;
  return {
    table: row.table,
    values: { ...row.values, bundle_hash: bundle.hash, bundle_build: bundle.build },
  };
}

/** Seeds this file's database (see the top of this file). */
export async function seed(sql: Sql): Promise<void> {
  // Bundle v0 as the rig published it: the one bundle here, active, which K-34's seed turn is pinned to.
  const bundles = await sql<BundleId[]>`select hash, build from bundles where active`;
  const [bundle] = bundles;
  if (bundle === undefined || bundles.length !== 1) {
    throw new Error("the copies seed: this database holds no one active bundle");
  }
  await sql.begin(async (tx) => {
    await tx.unsafe("set local role rosie_job");
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    for (const row of FIXTURE_ROWS) await insertRow(tx, pinnedTo(row, bundle));
    for (const row of OWN_ROWS) await insertRow(tx, row);
  });
}
