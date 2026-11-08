// The event log: append and read (K-04 v1 core event_log; K-08 v1.1 gives the kinds and fields; K-05 item 1 appends the
// entries of a commit under the turn id; arch 09 lines 457, 492; arch 10 line 516; T-190).
//
// Every write appends one row: who, what, old and new, when, why, approved by. A row is never edited: the database
// refuses UPDATE and DELETE with SQLSTATE 42501, so this file has no call that updates or deletes. Private old and new
// values go sealed into `sealed_values`, one person per row, under that person's key (db/repo/sealing.ts, K-04 rule 6):
// after `erasePerson` they cannot be opened again, while the plain columns, the proof hashes and the words shown stay.
//
// Nothing here logs. A caller commits the turn's entries inside the commit's own transaction by passing that
// transaction as `db`; row-level security (T-191) then scopes the rows by the business set on it.
import type postgres from "postgres";
import { SealingError, seal, unsealText, type WrappingKeys } from "./sealing";
import type { Sql, Tx } from "./scope";

type Db = Sql | Tx;
type Json = postgres.JSONValue;

export type ActorKind = "person" | "rosie" | "job" | "provider";
export type ActorRole = "owner" | "admin" | "staff" | "own_business" | "customer";

/** The bundle id in force, K-01's {hash, build}; null for a write outside a turn. */
export interface BundleId {
  hash: string;
  build: number;
}

/** What a call gives for every entry it appends: the turn or the job, the trace id and the bundle (K-05 item 1). */
export interface EventContext {
  /** The turn that wrote it. At least one of `turnId` and `jobId` is given (event_log_turn_or_job). */
  turnId?: string | null;
  /** A clock firing, webhook, page or Agent API request, sweep or reconciliation. */
  jobId?: string | null;
  traceId: string;
  bundle?: BundleId | null;
}

/** One entry, as K-05's eventEntry has it (the context above supplies the turn, trace id and bundle). */
export interface EventEntry {
  id: string;
  kind: string;
  /** The IANA zone the event is read in; null or left out: UTC. */
  zone?: string | null;
  businessId?: string | null;
  actorKind: ActorKind;
  actorPersonId?: string | null;
  actorRole?: ActorRole | null;
  tableName?: string | null;
  rowId?: string | null;
  /** Old and new values field by field, private fields left out. */
  oldValues?: Record<string, Json> | null;
  newValues?: Record<string, Json> | null;
  /** Private old and new values already sealed under `forPersonId`'s key. One person per entry. */
  sealed?: { forPersonId: string; bytes: Uint8Array } | null;
  why?: Record<string, Json> | null;
  approvedBy?: Record<string, Json> | null;
  /** Consent proofs: hashes and the words shown; they survive the deleted key. */
  proofs?: Json | null;
  /** When it happened; left out: the database's clock. */
  at?: Date;
}

/** A row as stored, with the sealed bytes still sealed. */
export interface EventLogRow {
  id: string;
  at: Date;
  zone: string | null;
  turnId: string | null;
  jobId: string | null;
  traceId: string;
  bundle: BundleId | null;
  businessId: string | null;
  actorKind: ActorKind;
  actorPersonId: string | null;
  actorRole: string | null;
  kind: string;
  tableName: string | null;
  rowId: string | null;
  oldValues: Record<string, Json> | null;
  newValues: Record<string, Json> | null;
  /** The sealed bytes, or null when the row has none. They stay in the row after the key is erased; they cannot be opened. */
  sealedValues: Uint8Array | null;
  sealedForPersonId: string | null;
  why: Record<string, Json> | null;
  approvedBy: Record<string, Json> | null;
  proofs: Json | null;
}

interface StoredRow {
  id: string;
  at: Date;
  zone: string | null;
  turn_id: string | null;
  job_id: string | null;
  trace_id: string;
  bundle_hash: string | null;
  bundle_build: number | null;
  business_id: string | null;
  actor_kind: ActorKind;
  actor_person_id: string | null;
  actor_role: string | null;
  kind: string;
  table_name: string | null;
  row_id: string | null;
  old_values: Record<string, Json> | null;
  new_values: Record<string, Json> | null;
  sealed_values: Uint8Array | null;
  sealed_for_person_id: string | null;
  why: Record<string, Json> | null;
  approved_by: Record<string, Json> | null;
  proofs: Json | null;
}

const toRow = (row: StoredRow): EventLogRow => ({
  id: row.id,
  at: row.at,
  zone: row.zone,
  turnId: row.turn_id,
  jobId: row.job_id,
  traceId: row.trace_id,
  bundle:
    row.bundle_hash === null || row.bundle_build === null
      ? null
      : { hash: row.bundle_hash, build: row.bundle_build },
  businessId: row.business_id,
  actorKind: row.actor_kind,
  actorPersonId: row.actor_person_id,
  actorRole: row.actor_role,
  kind: row.kind,
  tableName: row.table_name,
  rowId: row.row_id,
  oldValues: row.old_values,
  newValues: row.new_values,
  sealedValues: row.sealed_values,
  sealedForPersonId: row.sealed_for_person_id,
  why: row.why,
  approvedBy: row.approved_by,
  proofs: row.proofs,
});

const json = (db: Db, value: Json | null | undefined): postgres.Parameter | null =>
  value === null || value === undefined ? null : db.json(value);

/**
 * Appends one entry and returns the row as stored. A repeated id is refused by the primary key (23505), a missing turn,
 * business or person by a foreign key (23503), an entry with neither turn nor job by event_log_turn_or_job (23514).
 * Pass the commit's transaction as `db` so the entry commits with the turn.
 */
export async function appendEvent(db: Db, context: EventContext, entry: EventEntry): Promise<EventLogRow> {
  const bundle = context.bundle ?? null;
  const [row] = await db<StoredRow[]>`
    insert into event_log (
      id, at, zone, turn_id, job_id, trace_id, bundle_hash, bundle_build, business_id, actor_kind, actor_person_id,
      actor_role, kind, table_name, row_id, old_values, new_values, sealed_values, sealed_for_person_id, why,
      approved_by, proofs
    ) values (
      ${entry.id}, ${entry.at ?? new Date()}, ${entry.zone ?? null}, ${context.turnId ?? null},
      ${context.jobId ?? null}, ${context.traceId}, ${bundle?.hash ?? null}, ${bundle?.build ?? null},
      ${entry.businessId ?? null}, ${entry.actorKind}, ${entry.actorPersonId ?? null}, ${entry.actorRole ?? null},
      ${entry.kind}, ${entry.tableName ?? null}, ${entry.rowId ?? null}, ${json(db, entry.oldValues)},
      ${json(db, entry.newValues)}, ${entry.sealed?.bytes ?? null}, ${entry.sealed?.forPersonId ?? null},
      ${json(db, entry.why)}, ${json(db, entry.approvedBy)}, ${json(db, entry.proofs)}
    )
    returning *
  `;
  if (row === undefined) {
    throw new Error("the event log returned no row for an insert");
  }
  return toRow(row);
}

/** Appends several entries in order under one context, as a commit does. */
export async function appendEvents(
  db: Db,
  context: EventContext,
  entries: readonly EventEntry[],
): Promise<EventLogRow[]> {
  const rows: EventLogRow[] = [];
  for (const entry of entries) {
    rows.push(await appendEvent(db, context, entry));
  }
  return rows;
}

/**
 * Seals a person's private old and new values under their key (sealing.ts) and appends the entry with them. The plain
 * `oldValues` and `newValues` of the entry must leave those private fields out. Throws SealingError "erased" for an
 * erased person: nothing new can be sealed for them.
 */
export async function appendSealedEvent(
  db: Db,
  keys: WrappingKeys,
  context: EventContext,
  entry: Omit<EventEntry, "sealed">,
  forPersonId: string,
  privateValues: { old?: Record<string, Json> | null; new?: Record<string, Json> | null },
): Promise<EventLogRow> {
  const bytes = await seal(
    db,
    keys,
    forPersonId,
    JSON.stringify({ old: privateValues.old ?? null, new: privateValues.new ?? null }),
  );
  return appendEvent(db, context, { ...entry, sealed: { forPersonId, bytes } });
}

/** A row's private values opened: null for either side that held none. */
export interface OpenedValues {
  old: Record<string, Json> | null;
  new: Record<string, Json> | null;
}

/**
 * Opens a row's sealed values. Returns null when the row has none, or when the person was erased (their key is gone, so
 * the values cannot be read again by anyone); the proof, the words shown and every plain column stay readable.
 * Other sealing errors (a wrapping key missing, bytes altered) are thrown.
 */
export async function openSealedValues(
  db: Db,
  keys: WrappingKeys,
  row: Pick<EventLogRow, "sealedValues" | "sealedForPersonId">,
): Promise<OpenedValues | null> {
  if (row.sealedValues === null || row.sealedForPersonId === null) {
    return null;
  }
  try {
    const text = await unsealText(db, keys, row.sealedForPersonId, new Uint8Array(row.sealedValues));
    const parsed = JSON.parse(text) as { old: Record<string, Json> | null; new: Record<string, Json> | null };
    return { old: parsed.old, new: parsed.new };
  } catch (error) {
    if (error instanceof SealingError && error.code === "erased") {
      return null;
    }
    throw error;
  }
}

/** One entry by its id, or null. */
export async function getEvent(db: Db, id: string): Promise<EventLogRow | null> {
  const [row] = await db<StoredRow[]>`select * from event_log where id = ${id}`;
  return row === undefined ? null : toRow(row);
}

/** Everything one turn wrote, oldest first (event_log_turn_idx). */
export async function listEventsForTurn(db: Db, turnId: string): Promise<EventLogRow[]> {
  const rows = await db<StoredRow[]>`select * from event_log where turn_id = ${turnId} order by at, id`;
  return rows.map(toRow);
}

/** One row's history, oldest first (event_log_row_idx). */
export async function listEventsForRow(db: Db, tableName: string, rowId: string): Promise<EventLogRow[]> {
  const rows = await db<StoredRow[]>`
    select * from event_log where table_name = ${tableName} and row_id = ${rowId} order by at, id
  `;
  return rows.map(toRow);
}

/** A business's history, newest first, at most `limit` rows (default 100, at most 1000), before `before` when given. */
export async function listEventsForBusiness(
  db: Db,
  businessId: string,
  options: { limit?: number; before?: Date } = {},
): Promise<EventLogRow[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 1000);
  const before = options.before ?? null;
  const rows = await db<StoredRow[]>`
    select * from event_log
    where business_id = ${businessId} and (${before}::timestamptz is null or at < ${before}::timestamptz)
    order by at desc, id desc
    limit ${limit}
  `;
  return rows.map(toRow);
}
