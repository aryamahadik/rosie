// The staging-only reset of a listed test handle's actor (T-1452; the architect's card A under DL-944; ADR-017 sections 1,
// 5 and 7; D-018, the lane to the user texting Rosie from their own iPhone). On staging a danger whose line has no path
// stays pending by design (DL-127; ADR-015 section 2; CQ-334 answered no, DL-944): its after_safe hold has no core id, so
// nothing releases it (../safety/arrival.ts markHoldReleased), and it joins every later commit, so every later routine
// reply of the handle is held. Only a reset of the actor's stored state clears such a handle (DL-944 question 3). This is
// that reset. The handle actor (./handle-actor.ts) runs it at the start of each alarm and each hand-off; it acts only for
// an actor that a listed entry targets and that the entry has not been applied to yet. Nothing in ../safety changes for it
// (DL-944: no cap, no back-off and no branch there).
//
// Where it runs: only where staging's root has set the hook (`setStagingReset`, from ../wiring/staging/actor-reset.ts
// through ../wiring/root.ts install(), only where environmentOf gives staging), and only where the actor's own ENVIRONMENT
// is exactly "staging", read before anything else: production's and the test environment's actors read nothing and delete
// nothing. The hook names the entries that target an actor by the actor's name and the target that names it: a roster id,
// or a place on the real line's allow-list, never a number. The name is the hand-off's (the gateway's door names the
// Durable Object by it), and at an alarm the one the actor's storage keeps (`safety_meta`, else `outage_meta`); an actor
// that holds no name has nothing of a text to reset.
//
// When it waits, logging the reason at each try (labels only), while any of these holds:
//   leaseLive         a turn holds a lease that has not lapsed (turn_lease.until_ms after now);
//   readOut           a read is out in this instance: the safety read's inFlight, rereading or landing, or a row of its
//                     still reading (a read cut off and not resumed yet). The three are SafetyOnArrival's own memory
//                     (../safety/arrival.ts), private, with no reader, and ../safety is not changed here (DL-944): so they
//                     are read by name, and one that cannot be read as a Set or a Map counts as a read out (fails closed:
//                     the reset waits, and its tests fail, so a rename there cannot pass unseen);
//   textsWaiting      a text waits in the batch window or in the lease (the actor's pendingEventIds);
//   postgresDown      PostgreSQL is known down (an outage_state row);
//   stopWriteWaiting  a stop-rank write waits for the core in the write-on-return queue (not refused): a STOP is never lost.
//
// What it deletes, in one storage transaction: from every table the actor's storage holds, read from sqlite_master (ADR-017
// section 7's scan, which leaves out the names that begin sqlite_ and _cf_), every row ADR-017 section 5's forget deletes,
// and survivor 2 too (each open outcome hold and its labels): the one departure, which the user's yes stands in for. What
// it keeps (KEPT_TABLES, TRIMMED_TABLES): its own applied-entries marker (`staging_reset_applied`, the one new table), the
// stopped flag's copies, the stop-rank writes and the stop rank's held row, the bundle's and the timers' copies, the newest
// lease_turns row with its items emptied (DL-427: its seq is the lease's turn order), the receipt ids, the stored schedule,
// sqlite_sequence (so no seq or batch id is used again) and the platform's own tables. A table no list here names is never
// guessed at: the reset is refused, with nothing deleted (`unknownTable`), so a table added later gets its rule here first,
// as section 7 asks of its scan.
//
// Afterwards the actor drops its safety read's in-memory state and name (./handle-actor.ts builds the safety read again
// over the same host, so the next hand-off writes the name again) and sets its alarm from the stored schedule. The reset
// writes one JSON log line, labels and counts only: never a number, a word of a text, an address or a key. It writes no
// span (K-08 unchanged).

import { isLabel } from "../trace";
import { actorClock } from "./batch";
import { RETURN_RANKS } from "./copies/return-queue";

/** One listed entry that targets an actor, and the target that names it: both labels, never a number or an address. */
export interface ResetMatch {
  /** The entry's id: what the actor's marker keeps once the entry is applied. */
  readonly entry: string;
  /** The target as the log line names it: a roster id (tp-01), or a place on the allow-list (allowList:1). */
  readonly target: string;
}

/** What staging's root hands the reset (../wiring/staging/actor-reset.ts): the list, each target resolved at each call. */
export interface StagingResetHook {
  /** The listed entries that target the actor of this name, each with its target; none when none does. */
  matches(actorName: string): readonly ResetMatch[];
}

let resetHook: StagingResetHook | null = null;

/** Sets the reset's hook for this Worker isolate (staging's root alone); returns the function that puts the earlier one back. */
export function setStagingReset(next: StagingResetHook | null): () => void {
  const before = resetHook;
  resetHook = next;
  return () => {
    resetHook = before;
  };
}

/** The reset's own marker: one row per entry applied to this actor, with when, on the actor's clock. */
export const RESET_MARKER = "staging_reset_applied";

/**
 * The tables kept whole (ADR-017 section 5's survivors 1, 3, 4, 6 and 7, and the marker): the stopped flag's copy and what
 * keeps it reading stopped; the bundle's words; the live safety timers' copies; the receipt ids (their 24 hours are not
 * kept yet: no tombstone table is built, ADR-017's card R1); and the stored schedule, whose entries their owners clear
 * once nothing is left.
 */
export const KEPT_TABLES: readonly string[] = [
  "copy_stopped",
  "copy_note",
  "copy_lost_commits",
  "copy_lines",
  "copy_keywords",
  "copy_timers",
  "copy_meta",
  "outage_timers",
  "seen_receipts",
  "batch_schedule",
  RESET_MARKER,
];

/**
 * The tables kept in part: the newest lease_turns row, its items emptied (survivor 5; DL-427); each stop-rank write and
 * the stop rank's held row (survivor 1: the "don't text me" record stays). Every other row of them goes.
 */
export const TRIMMED_TABLES: readonly string[] = ["lease_turns", "return_queue", "return_held"];

/**
 * The tables emptied: every other table the actor's storage holds today, each named, so that a table added later is never
 * emptied unread. Among them each hold, open or not, with its labels (`safety_holds`, `safety_outcomes`,
 * `safety_core_holds`): forget keeps an open outcome hold, and the reset does not (the one departure).
 */
export const EMPTIED_TABLES: readonly string[] = [
  // The inbox, and the trace's counts.
  "inbox",
  "trace_seq",
  // The safety read: its rows, its name and its holds with their labels.
  "safety_events",
  "safety_meta",
  "safety_holds",
  "safety_outcomes",
  "safety_reread",
  "safety_pending",
  "safety_results",
  "safety_closed",
  "safety_noted_lines",
  "safety_line_done",
  "safety_core_holds",
  // The batch window.
  "batch_items",
  "batches",
  "batch_reads",
  "batch_spans",
  "batch_span_texts",
  // The lease (a lapsed lease; a live one waits) and the pin.
  "lease_batches",
  "turn_lease",
  "lease_held",
  "lease_commit_handles",
  "turn_bundles",
  // The write-on-return queue's done keys.
  "return_done",
  // The PostgreSQL-down path's texts, ids and name (its state means known down: the reset waits).
  "outage_state",
  "outage_texts",
  "outage_ids",
  "outage_meta",
  // The clocks' handle id: the arming names the handle again.
  "clock_handle",
];

/** Why the reset waits, as its log line names it. */
export type ResetWait = "leaseLive" | "readOut" | "textsWaiting" | "postgresDown" | "stopWriteWaiting";

/** What one try came to: nothing to do (not staging, no hook, no target, every entry applied), or the line it wrote. */
export type ResetOutcome = "none" | "deferred" | "applied" | "refused" | "failed";

/** What the reset removed, as counts: the texts, the holds (and of them the open outcome holds), every row, the tables. */
export interface ResetCounts {
  readonly texts: number;
  readonly holds: number;
  readonly openHolds: number;
  readonly rows: number;
  readonly tables: number;
}

/** The reset's one log line (labels and counts only). */
export interface ResetLine {
  readonly level: "info" | "warn";
  readonly msg: "actorReset";
  readonly outcome: Exclude<ResetOutcome, "none">;
  readonly entries: readonly string[];
  readonly targets: readonly string[];
  readonly why?: readonly string[];
  readonly removed?: ResetCounts;
  readonly environment: "staging";
  readonly version: string;
}

/** What the actor hands the reset at each alarm and hand-off. */
export interface ResetHost {
  readonly storage: DurableObjectStorage;
  /** The actor's env: ENVIRONMENT, read first, and GIT_SHA for the log line. */
  readonly env: { readonly ENVIRONMENT?: unknown; readonly GIT_SHA?: unknown };
  /** The actor's name as the hand-off names it; null at an alarm (the name the storage keeps is read then). */
  readonly handedName: string | null;
  /** The actor's safety read on arrival (../safety SafetyOnArrival), whose reads out in this instance are looked at. */
  readonly safety: object;
  /** The texts the batch window has not handed on and those the lease has that no commit has taken, by event id. */
  pending(): readonly string[];
  /** Where the line goes. Default: console.log (Workers Logs). */
  readonly log?: (line: string) => void;
}

/** The reset refused for a reason of its own (a label): nothing was deleted. */
class ResetRefusal extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ResetRefusal";
    this.code = code;
  }
}

/** The safety read's memory of the reads out in this instance (../safety/arrival.ts SafetyOnArrival), by name. */
const SAFETY_READS_OUT = ["inFlight", "rereading", "landing"] as const;

/** The stop rank's place in the write-on-return queue (./copies/return-queue.ts return_queue.rank). */
const STOP_RANK = RETURN_RANKS.indexOf("stop");

/** A table name the reset reads or writes: K-08's table-name form, so no name it reads from sqlite_master is quoted unread. */
const TABLE_NAME = /^[a-z][a-z0-9_]*$/u;

const writeLine = (line: string): void => {
  console.log(line);
};

/**
 * Runs the reset for this actor once its checks allow (see the top of this file), in one synchronous step: no await, so
 * nothing else of the actor can run between the checks and the transaction. Never throws: a throw deletes nothing (the
 * transaction keeps all or nothing) and is written as `failed`.
 */
export function runStagingReset(host: ResetHost): ResetOutcome {
  // ENVIRONMENT first, before anything else is read.
  if (host.env.ENVIRONMENT !== "staging") return "none";
  const hook = resetHook;
  if (hook === null) return "none";
  const name = actorNameOf(host.storage, host.handedName);
  if (name === null) return "none";
  let matches: ResetMatch[];
  try {
    matches = hook.matches(name).filter((match) => isLabel(match.entry) && isLabel(match.target));
  } catch {
    return "none";
  }
  if (matches.length === 0) return "none";
  const write = host.log ?? writeLine;
  try {
    const { sql } = host.storage;
    const applied = appliedEntries(sql);
    const due = matches.filter((match) => !applied.has(match.entry));
    if (due.length === 0) return "none";
    const now = actorClock().now();
    const why = waitsOf(host, sql, now);
    if (why.length > 0) {
      write(lineOf("deferred", due, host.env, { why }));
      return "deferred";
    }
    const entries = [...new Set(due.map((match) => match.entry))];
    const removed = host.storage.transactionSync(() => clear(sql, entries, now));
    write(lineOf("applied", due, host.env, { removed }));
    return "applied";
  } catch (error) {
    const outcome = error instanceof ResetRefusal ? "refused" : "failed";
    const code = error instanceof ResetRefusal ? error.code : "threw";
    write(lineOf(outcome, matches, host.env, { why: [code] }));
    return outcome;
  }
}

/**
 * The actor's name: the hand-off's (nothing is read then), else the one the safety read keeps, else the PostgreSQL-down
 * path's; null when none can be read.
 */
function actorNameOf(storage: DurableObjectStorage, handed: string | null): string | null {
  if (handed !== null && handed !== "") return handed;
  for (const table of ["safety_meta", "outage_meta"]) {
    try {
      const row = storage.sql
        .exec<{ v: SqlStorageValue }>(`SELECT v FROM ${table} WHERE k = 'actorName'`)
        .toArray()[0];
      if (typeof row?.v === "string" && row.v !== "") return row.v;
    } catch {
      // Not there, or not read: the next.
    }
  }
  return null;
}

/** The entries already applied to this actor (none while it has no marker). */
function appliedEntries(sql: SqlStorage): Set<string> {
  const marked = sql
    .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", RESET_MARKER)
    .toArray();
  if (marked.length === 0) return new Set();
  return new Set(
    sql
      .exec<{ entry_id: string }>(`SELECT entry_id FROM ${RESET_MARKER}`)
      .toArray()
      .map((row) => row.entry_id),
  );
}

/** Each reason the reset waits now, in the order the top of this file gives them; none when it may run. */
function waitsOf(host: ResetHost, sql: SqlStorage, now: number): ResetWait[] {
  const why: ResetWait[] = [];
  const lease = sql.exec<{ until_ms: number }>("SELECT until_ms FROM turn_lease WHERE one = 1").toArray()[0];
  if (lease !== undefined && lease.until_ms > now) why.push("leaseLive");
  if (readsOut(host.safety) || someRow(sql, "SELECT 1 FROM safety_events WHERE state = 'reading' LIMIT 1")) {
    why.push("readOut");
  }
  if (host.pending().length > 0) why.push("textsWaiting");
  if (someRow(sql, "SELECT 1 FROM outage_state LIMIT 1")) why.push("postgresDown");
  if (someRow(sql, "SELECT 1 FROM return_queue WHERE rank = ? AND refused IS NULL LIMIT 1", STOP_RANK)) {
    why.push("stopWriteWaiting");
  }
  return why;
}

/**
 * True while the safety read has a read out in this instance: a text's work running (`inFlight`), a read sent after the
 * timeout rule took its text or a re-read (`rereading`), or a late answer being applied (`landing`). Each is read by name
 * (the top of this file says why); one that is not a Set or a Map, or cannot be read, counts as a read out.
 */
function readsOut(safety: object): boolean {
  for (const name of SAFETY_READS_OUT) {
    let held: unknown;
    try {
      held = Reflect.get(safety, name);
    } catch {
      return true;
    }
    if (!(held instanceof Set) && !(held instanceof Map)) return true;
    if (held.size > 0) return true;
  }
  return false;
}

/** True when the query finds a row. */
function someRow(sql: SqlStorage, query: string, ...bindings: SqlStorageValue[]): boolean {
  return sql.exec(query, ...bindings).toArray().length > 0;
}

function countOf(sql: SqlStorage, table: string, where = "", ...bindings: SqlStorageValue[]): number {
  return sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} ${where}`, ...bindings).one().n;
}

/**
 * The transaction: every table the storage holds (sqlite_master, the sqlite_ and _cf_ names left out) kept, trimmed or
 * emptied as the lists above say, and the entries marked applied. A table no list names refuses the whole reset.
 */
function clear(sql: SqlStorage, entries: readonly string[], now: number): ResetCounts {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${RESET_MARKER} (entry_id TEXT PRIMARY KEY, applied_ms INTEGER NOT NULL)`,
  );
  const tables = sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .toArray()
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_") && !name.startsWith("_cf_"));
  for (const table of tables) {
    const named =
      KEPT_TABLES.includes(table) || TRIMMED_TABLES.includes(table) || EMPTIED_TABLES.includes(table);
    if (!named || !TABLE_NAME.test(table)) throw new ResetRefusal("unknownTable");
  }
  const texts = tables.includes("inbox") ? countOf(sql, "inbox") : 0;
  const holds = tables.includes("safety_holds") ? countOf(sql, "safety_holds") : 0;
  const openHolds = tables.includes("safety_holds")
    ? countOf(sql, "safety_holds", "WHERE released = 0 AND rule <> 'unread'")
    : 0;
  let rows = 0;
  let touched = 0;
  for (const table of tables) {
    if (KEPT_TABLES.includes(table)) continue;
    const removed = TRIMMED_TABLES.includes(table) ? trim(sql, table) : empty(sql, table);
    rows += removed;
    if (removed > 0) touched += 1;
  }
  for (const entry of entries) {
    sql.exec(`INSERT OR IGNORE INTO ${RESET_MARKER} (entry_id, applied_ms) VALUES (?, ?)`, entry, now);
  }
  return { texts, holds, openHolds, rows, tables: touched };
}

/** Empties a table; answers how many rows went. */
function empty(sql: SqlStorage, table: string): number {
  const removed = countOf(sql, table);
  if (removed > 0) sql.exec(`DELETE FROM ${table}`);
  return removed;
}

/** Trims a table kept in part (TRIMMED_TABLES); answers how many rows went. */
function trim(sql: SqlStorage, table: string): number {
  if (table === "lease_turns") {
    const before = countOf(sql, table);
    sql.exec("DELETE FROM lease_turns WHERE seq < (SELECT MAX(seq) FROM lease_turns)");
    sql.exec("UPDATE lease_turns SET items = '[]'");
    return before - countOf(sql, table);
  }
  // return_queue and return_held: the stop rank's rows stay; the danger and rest ranks' go.
  const removed = countOf(sql, table, "WHERE rank <> ?", STOP_RANK);
  if (removed > 0) sql.exec(`DELETE FROM ${table} WHERE rank <> ?`, STOP_RANK);
  return removed;
}

/** The reset's one log line for these matches. */
function lineOf(
  outcome: ResetLine["outcome"],
  matches: readonly ResetMatch[],
  env: ResetHost["env"],
  more: { why?: readonly string[]; removed?: ResetCounts },
): string {
  const line: ResetLine = {
    level: outcome === "applied" || outcome === "deferred" ? "info" : "warn",
    msg: "actorReset",
    outcome,
    entries: [...new Set(matches.map((match) => match.entry))],
    targets: [...new Set(matches.map((match) => match.target))],
    ...more,
    environment: "staging",
    version: isLabel(env.GIT_SHA) ? env.GIT_SHA : "unknown",
  };
  return JSON.stringify(line);
}
