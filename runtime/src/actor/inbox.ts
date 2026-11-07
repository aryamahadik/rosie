// The handle actor's ordered inbox (T-244; C-046, C-184), kept in the Durable Object's own SQLite storage so it
// survives a restart. Every function here is synchronous: one call is one uninterrupted step of the actor, so the
// seen-event-id check and the write cannot be split by another request (T-241 security note a). `transactionSync`
// makes the pair all-or-nothing as well.
//
// What is stored is the sealed event exactly as the gateway handed it (K-06 with its words in `sealed`). The actor
// never opens the box here: a turn opens it later.

import type { BundleId } from "../trace";
import type { SealedEvent, SealedHandoff, StoreAnswer } from "../gateway/types";

/** One stored event, in arrival order (`seq` rises by one per stored event and is never reused). */
export interface InboxEntry {
  seq: number;
  event: SealedEvent;
  partKey: string | null;
  traceId: string;
  bundleId: BundleId;
  /** False for Rosie's own reaction (K-06 `fromRosie`; arch 07 line 391): it is kept in order but starts no turn. */
  startsTurn: boolean;
}

interface InboxRow extends Record<string, SqlStorageValue> {
  seq: number;
  event_json: string;
  part_key: string | null;
  trace_id: string;
  bundle_hash: string;
  bundle_build: number;
  starts_turn: number;
}

/** Makes the tables when they are not there yet. Safe to run at every start of the actor. */
export function createInboxTables(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS inbox (
       seq INTEGER PRIMARY KEY AUTOINCREMENT,
       event_id TEXT NOT NULL UNIQUE,
       kind TEXT NOT NULL,
       starts_turn INTEGER NOT NULL,
       part_key TEXT,
       trace_id TEXT NOT NULL,
       bundle_hash TEXT NOT NULL,
       bundle_build INTEGER NOT NULL,
       event_json TEXT NOT NULL
     )`,
  );
  sql.exec("CREATE TABLE IF NOT EXISTS seen_receipts (event_id TEXT PRIMARY KEY)");
}

/** True when the event starts a turn: everything that reaches the inbox does, except Rosie's own reaction. */
export function startsTurn(event: SealedEvent): boolean {
  return !(event.kind === "reaction" && event.fromRosie === true);
}

/**
 * Stores one sealed event unless its event id is already known, in one step. Answers "written" or "duplicate"; a
 * duplicate changes nothing, whatever else differs between the two (a retry's trace id, for one).
 */
export function writeToInbox(storage: DurableObjectStorage, handoff: SealedHandoff): StoreAnswer {
  const { event } = handoff;
  return storage.transactionSync(() => {
    const known = storage.sql.exec("SELECT 1 FROM inbox WHERE event_id = ?", event.eventId).toArray();
    if (known.length > 0) return "duplicate";
    storage.sql.exec(
      `INSERT INTO inbox (event_id, kind, starts_turn, part_key, trace_id, bundle_hash, bundle_build, event_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      event.eventId,
      event.kind,
      startsTurn(event) ? 1 : 0,
      handoff.partKey,
      handoff.traceId,
      handoff.bundleId.hash,
      handoff.bundleId.build,
      JSON.stringify(event),
    );
    return "written";
  });
}

/** Notes a receipt's event id as seen, in one step: "written" the first time, "duplicate" after. */
export function markReceiptSeen(storage: DurableObjectStorage, eventId: string): StoreAnswer {
  return storage.transactionSync(() => {
    const known = storage.sql.exec("SELECT 1 FROM seen_receipts WHERE event_id = ?", eventId).toArray();
    if (known.length > 0) return "duplicate";
    storage.sql.exec("INSERT INTO seen_receipts (event_id) VALUES (?)", eventId);
    return "written";
  });
}

/** Forgets a receipt's event id, so a retry after a failed hook is handled again. */
export function unmarkReceipt(storage: DurableObjectStorage, eventId: string): void {
  storage.sql.exec("DELETE FROM seen_receipts WHERE event_id = ?", eventId);
}

/** The inbox in arrival order. */
export function readInbox(sql: SqlStorage): InboxEntry[] {
  return sql
    .exec<InboxRow>(
      `SELECT seq, event_json, part_key, trace_id, bundle_hash, bundle_build, starts_turn
       FROM inbox ORDER BY seq`,
    )
    .toArray()
    .map((row) => ({
      seq: row.seq,
      event: JSON.parse(row.event_json) as SealedEvent,
      partKey: row.part_key,
      traceId: row.trace_id,
      bundleId: { hash: row.bundle_hash, build: row.bundle_build },
      startsTurn: row.starts_turn === 1,
    }));
}
