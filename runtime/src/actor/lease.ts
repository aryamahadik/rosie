// The turn lease of the handle actor (T-248; C-049; arch 01 terms "Turn" and "Turn lease", lines 59 and 61; arch 02
// step 2, line 113; arch 11 line 576). The batch window (T-247, batch.ts) hands each closed batch here, and the lease turns
// batches into turns, one turn at a time:
//
//   - A turn's id is a hash of its texts' event ids (CQ-09; K-04 v1 turns.id): the same texts always give the same id,
//     and a different set a different one (`turnIdOf`).
//   - The handle holds one lease at a time, for 60 s, in the actor's own storage (QUESTIONS.md NQ-RT-3's default: a
//     Durable Object is single-writer; K-04's turns row is written once, by the commit, as committed or parked, never
//     "leased"). The lease is a table of one row, written inside one storage transaction that checks what it read, so two
//     attempts at once give exactly one lease.
//   - A batch that closes before the running turn commits restarts that turn once, with its texts: a new turn id from the
//     union of the ids. A batch that closes after that restart, or once the turn has begun its commit, waits; when the turn
//     commits, every waiting batch opens the next turn together.
//   - A lease that lapses (60 s and no commit) reruns the turn from its sealed texts under the same turn id, so a commit
//     that went through before the crash comes back as the first result (K-05 v1 commitTurn: a repeat writes nothing).
//
// A crash in the middle of a turn (T-253; C-180; arch 11 line 576):
//
//   - Before the commit, the lapse above reruns the turn. The safety read is not the turn's (it ran on each text's
//     arrival, and its own record keeps a line from going twice after an eviction: T-1088), so a rerun sends no safety
//     line again.
//   - After the commit: a run that will reply commits with `reply`, and its committed turn keeps the lease, renewed for
//     60 s, until the run says its reply ended (`replied`: every row the commit wrote holds a plan or is closed, and the
//     dispatcher was woken). A crash before then lets the lease lapse, and the turn reruns under the same id: its commit
//     answers repeated, and only the rows with no plan are composed (the dispatcher sends unsent parts under their stored
//     keys). Later batches wait for the reply, then open the next turn.
//   - A turn starts at most 3 times. A third lapse with no commit parks it (`park`, K-05 v1 parkTurn through the turn's
//     K-05 face): the turn row parked, its one "nothing changed" row and its event-log entries; the lease is released and
//     the waiting batches open the next turn. A park that cannot be done now is tried again 30 s later; no run commits
//     once the park has begun. K-05 answering alreadyCommitted (the third run's commit went through) finishes the turn as
//     committed, once the host is told of that commit, whose answer the lease never had (`commitLost`, T-1206): the
//     actor's copies then read its stopped flag and its safety timers again, failing safe. A committed turn whose reply
//     has not ended by its third lapse is given up: the lease is released.
//
// The batch window hands a batch at least once (a crash between the hand-off and its mark hands it again): a batch id the
// lease has seen counts as handed and never starts a second turn (T-247 security note b).
//
// Each run of a turn first pins the turn's bundle (T-249, ../bundle/pin.ts, through the host's `pin`): the id stored for
// the turn id, so a rerun keeps it, or else the active id read now; the turn's work is handed the pinned id, the bundle and
// the turn's trace under that id. A run whose bundle cannot be pinned never starts its work: like a crash, nothing is
// written and the lease lapses into a rerun. The lease's own rules above do not depend on the pin.
//
// Safety holds bind commits, not hand-offs (QUESTIONS.md CQ-65 as DL-119 replaced it; T-1088): a batch reaches its turn
// once its texts have been read, even while a hold is open. Each run of a turn is handed the holds open at its start, read
// after the pin (`LeasedTurn.holds`: the first run, a restart, a lapsed turn's rerun and the next turn after a commit each
// read them again), and the commit hook is handed the holds open at commit time, so a hold that opened mid-turn binds
// that commit too, with the texts not read yet then (CQ-65's addendum, DL-127: T-252's gate counts each as an open hold).
// The lease refuses nothing for a hold: T-252's gate commits only protective changes and the safety flow while one is
// open (arch 06 lines 327 and 329), and until it is wired no turn runs at all.
//
// Each commit that comes back committed, first or repeated, is handed to the host before the run is answered (T-269,
// `committed`): the actor copies the stopped flag a STOP or START wrote, so the copy is set before that turn's reply can go.
// A commit that went through with its answer lost, which only a park's alreadyCommitted tells of, is handed to the host
// before the next turn opens (`commitLost`, T-1206), with the K-04 handle id the turn's last commit named (kept as sent).
// Both go with the order the lease opened the turn in (lease_turns.seq; DL-427): a committed answer can arrive late, after
// a later turn's commit lost its answer, and only an answer from that lost turn or a turn opened after it may end what
// the host keeps for it.
//
// PostgreSQL down (T-270; arch 11 line 566: "Turns queue in order in each handle's actor"): while the host says so
// (`held`), a lapse is no crash. The lease holds the turn as it is: it reruns nothing, counts no try and parks nothing, the
// lease is renewed for LEASE_MS and the turn noted held, and no batch opens or restarts a turn. On return the host calls
// `resume`: a held turn runs again with the tries it had (or goes on parking, or its reply is given up, as its lapse would
// have it), then the waiting batches open the next turn. Before a commit is sent the host replays its write-on-return queue
// (`beforeCommit`; QUESTIONS.md CQ-104 (f)'s default): while that queue still holds a danger or stop write the core is not
// answering for, the commit is not sent (`transient`, nothing written), so no live turn's word lands before an older stop.
//
// Not here: what runs inside a turn (the guard and frontier, T-251; decide, gate and commit, T-252), joined through the
// `runTurn` and `commit` hooks, and the park's request (T-253, ../turn/park.ts), joined through `park`. Unwired, no turn
// runs and each closed batch stays stored with the batch window (fails closed); with no park wired, a third lapse is left
// as it is, with no fourth try. Never logged or put in a span: a text's words (K-08 README line 75). Nothing here logs
// (the pin records the turn's `lease` span; the park, its own).

import type { PinnedBundle, PinRequest, TurnPin } from "../bundle";
import type { OpenHold } from "../safety";
import type { BundleId, TraceContext } from "../trace";
import { actorClock, createScheduleTable, scheduleEntry, unscheduleEntry, type ClosedBatch } from "./batch";
import { readInboxEvents, type InboxEntry } from "./inbox";

/** The lease's length: after it the turn reruns from its sealed texts (arch 01 line 61). */
export const LEASE_MS = 60_000;
/** A turn starts at most 3 times; a third crash before the commit parks it (arch 11 line 576; K-04 turns.tries; T-253). */
export const MAX_TRIES = 3;
/**
 * When a park that could not be done (K-05 not answering or not wired, the handle not known) is tried again (T-253). No
 * source gives it; 30 s is the cadence of the turn's retries in an outage (arch 11 line 564) and of the safety re-read.
 */
export const PARK_RETRY_MS = 30_000;
/** The lease's kind in the actor's stored schedule. */
export const SCHEDULE_LEASE = "turnLease";

// ---- the turn id ------------------------------------------------------------------------------------------------

/**
 * A turn's id (CQ-09; arch 01 line 59; K-04 v1 turns.id): SHA-256, in lowercase hex, over the texts' event ids, sorted,
 * each written as a JSON string, joined by line breaks. A JSON string holds a line break (and a quote) only escaped, so the
 * joined form splits back into the same ids, and two different sets never give the hash the same input. The order the
 * texts came in, and an id given twice, do not change it. The form never changes: a turn rerun after a deploy keeps its id.
 */
export async function turnIdOf(eventIds: readonly string[]): Promise<string> {
  if (eventIds.length === 0) throw new Error("noTexts");
  const lines = [...new Set(eventIds)].sort().map((eventId) => JSON.stringify(eventId));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lines.join("\n")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---- the commit (K-05 v1 commitTurn), as the lease passes it through ---------------------------------------------

/** K-05 v1 `turn` as commitTurn takes it. Hand-written: the generated types are git-ignored (ADR-005). */
export interface CommitTurnRef {
  id: string;
  handleId: string;
  eventIds: string[];
  bundleId: { hash: string; build: number };
  traceId: string;
  joinedTraceIds: string[];
  tries: number;
}

/** K-05 v1 `commitTurn.request`: the turn, and the gate's versions read and writes (T-252). */
export interface CommitTurnRequest {
  turn: CommitTurnRef;
  versionsRead: unknown[];
  writes: unknown;
}

/** K-05 v1 `commitTurn.response`: committed; a repeat of a committed turn id returns the first commit with `repeated`. */
export interface CommitTurnCommitted {
  result: "committed";
  turnId: string;
  committedAt: string;
  repeated: boolean;
  committed: unknown;
}

/** K-05 v1 `commitTurn.errors`: versionChanged, reservationLost, turnParked, constraint or transient; nothing written. */
export interface CommitTurnError {
  error: string;
  readonly [field: string]: unknown;
}

export type CommitTurnAnswer = CommitTurnCommitted | CommitTurnError;

/**
 * The lease's own answers, given instead of the commit call's:
 * - `replaced`: a restart replaced this turn, so it never commits (its texts are in the restart's turn);
 * - `parked`: the turn was parked, or the lease has begun to park it after its third lapse (T-253);
 * - `wrongTurn`: the request names another turn id;
 * - `unknownTurn`: the lease holds no such turn;
 * - `unwired`: no commit call is set yet (D-017); nothing was sent;
 * - `noAnswer`: the commit call failed with no answer, so the turn may have committed: send the same request again (one
 *   turn id commits once).
 */
export interface LeaseRefusal {
  error: "replaced" | "parked" | "wrongTurn" | "unknownTurn" | "unwired" | "noAnswer";
}

export type CommitAnswer = CommitTurnAnswer | LeaseRefusal;

function isCommitted(answer: CommitTurnAnswer): answer is CommitTurnCommitted {
  return (answer as { result?: unknown }).result === "committed";
}

// ---- the seam ---------------------------------------------------------------------------------------------------

/** What a turn's work is handed: the turn, its sealed texts, and the bundle pinned for it. */
export interface LeasedTurn {
  turnId: string;
  /** The texts' event ids, in arrival order (K-05 turn.eventIds). */
  eventIds: string[];
  /** The texts as the inbox keeps them, sealed, in arrival order: what the turn reads. */
  entries: InboxEntry[];
  /** The first text's trace id, and the other texts' (CQ-06; K-05 turn.traceId and joinedTraceIds). */
  traceId: string;
  joinedTraceIds: string[];
  /** How many times this turn has started: 1, then 2 and 3 after a lapse (K-05 turn.tries). */
  tries: number;
  /** True when this turn is the one restart: a later batch waits for the next turn. */
  restart: boolean;
  /** When the lease lapses, on the actor's clock. */
  leaseUntil: number;
  /**
   * Aborted when this run is no longer the turn's: a restart replaced the turn, a lapse started a rerun, the lease began to
   * park it, or its reply was given up.
   */
  signal: AbortSignal;
  /**
   * Commits the turn through the lease (K-05 commitTurn); refused once a restart has replaced the turn or the lease has
   * begun to park it. With `reply` (T-253), a committed answer keeps the turn's lease for the run's reply, renewed for
   * LEASE_MS, until `replied`; later batches wait, and a lapse before then reruns the turn, whose commit answers repeated.
   */
  commit(request: CommitTurnRequest, options?: CommitOptions): Promise<CommitAnswer>;
  /**
   * The run's reply has ended (T-253): every row its commit wrote holds a plan or is closed, and the dispatcher was woken.
   * The lease is released and the waiting batches open the next turn. From a run no longer the turn's it changes nothing.
   */
  replied(): Promise<void>;
  /**
   * The bundle id pinned at the turn's start (T-249): the same for every run of this turn id, whatever the active id is by
   * then. The commit names it (K-05 turn.bundleId; arch 10 line 548: the bundle id on every turn).
   */
  bundleId: BundleId;
  /** The pinned bundle: its manifest, and its step graph read under the pinned id (KV, or PostgreSQL on a miss). */
  bundle: PinnedBundle;
  /** The turn's trace (the first text's trace id, CQ-06) under the pinned bundle id: every span of the turn goes on it (K-08). */
  trace: TraceContext;
  /**
   * The handle's safety holds open at this run's start (read after the pin), in the order they were made (CQ-65 as DL-119
   * replaced it): the turn runs with them open. While one is open, T-252's gate commits only protective changes (a STOP,
   * stricter contact, a death report; the A3-48 pause) and the safety flow (a clear "we're safe" with a fresh read-back),
   * never routine actions; a threat's never-released hold commits only protective changes. The commit is handed them again.
   */
  holds: OpenHold[];
}

/** What the commit hook is handed beside the request, read at commit time (after the lease's own gate). */
export interface CommitContext {
  /** The safety holds open now: a hold that opened mid-turn binds this commit too (DL-119). */
  holds: OpenHold[];
  /**
   * The handle's texts not read yet now, by event id in arrival order (QUESTIONS.md CQ-65's addendum, DL-127): a text still
   * being read, never wired, given up with no hold open, or with no safety row. Arch 02 step S holds routine actions until
   * a text's outcome, so T-252's gate counts each as an open hold (protective changes only). A text under an open unread
   * hold (no verdict in 4 s) is among `holds`, with rule `unread`.
   */
  unread: string[];
}

/** How a run commits through the lease. */
export interface CommitOptions {
  /** The run replies after the commit and calls `replied` when its reply has ended (T-253). */
  reply?: boolean;
}

/**
 * What the park is handed (T-253): the turn after its third lapse with no commit, its sealed texts in arrival order, and
 * its trace. Its texts' words are never logged or put in a span.
 */
export interface ParkingTurn {
  turnId: string;
  /** The texts' event ids, in arrival order (K-05 turn.eventIds). */
  eventIds: string[];
  entries: InboxEntry[];
  /** The first text's trace id, and the other texts' (CQ-06). */
  traceId: string;
  joinedTraceIds: string[];
  /** How many times the turn started: MAX_TRIES (K-05 parkTurn's turn.tries is 3). */
  tries: number;
  /** The bundle pinned for the turn (T-249), or, when no run was ever pinned, the one its first text arrived under. */
  bundleId: BundleId;
  /** The turn's trace under that bundle id: the park's span goes on it, and the dispatcher's wake carries it. */
  trace: TraceContext;
}

/** K-05 v1 parkTurn answered parked (first or repeated): the turn row is parked and its one row written. */
export interface ParkParked {
  result: "parked";
  parkedAt: string;
  repeated: boolean;
}

/** K-05 v1 parkTurn answered alreadyCommitted: the third run's commit went through, so the turn is never parked. */
export interface ParkAlreadyCommitted {
  error: "alreadyCommitted";
  committedAt: string;
}

/** The park could not be done now (K-05 transient or not answering, not wired, the handle not known): tried again. */
export interface ParkNotDone {
  error: string;
}

export type ParkAnswer = ParkParked | ParkAlreadyCommitted | ParkNotDone;

/**
 * A turn whose commit went through but whose answer never reached the lease (T-1206): K-05 v1 parkTurn answered
 * alreadyCommitted, so no committed answer was handed to the host for it, and what that commit wrote (a STOP or a START,
 * a safety timer row) is not known here.
 */
export interface LostCommit {
  turnId: string;
  /** The order the lease opened the turn in (lease_turns.seq; DL-427): a later committed answer is weighed against it. */
  opened: number;
  /** The K-04 handle id the turn's last commit named (K-05 turn.handleId, as sent), or null when the lease sent none. */
  handleId: string | null;
  /** K-05's committedAt, from the park's answer. */
  committedAt: string;
}

function isParked(answer: ParkAnswer): answer is ParkParked {
  return (answer as { result?: unknown }).result === "parked";
}

function isAlreadyCommitted(answer: ParkAnswer): answer is ParkAlreadyCommitted {
  const fields = answer as { error?: unknown; committedAt?: unknown };
  return fields.error === "alreadyCommitted" && typeof fields.committedAt === "string";
}

/** Joined at D-017; a test sets doubles. Unwired, no turn runs and no turn commits (fails closed). */
export interface LeaseHooks {
  /** The turn's work (T-251, T-252). A throw is a crash: the lease lapses and the turn reruns. */
  runTurn?: (turn: LeasedTurn) => void | Promise<void>;
  /**
   * K-05 v1 commitTurn (C-087, through the Tool API), behind T-252's gate, which reads `at.holds` and `at.unread`: the
   * safety holds open and the texts not read yet at commit time, so it can refuse a routine commit while either is there.
   */
  commit?: (request: CommitTurnRequest, at: CommitContext) => Promise<CommitTurnAnswer>;
  /**
   * K-05 v1 parkTurn after a third crash before the commit (T-253; arch 11 line 576), through the turn's K-05 face: the
   * turn row parked, its one "nothing changed" row and its event-log entries, then the dispatcher woken for that row. A
   * throw is an answer not had: the park is tried again. Unwired, a third lapse is left as it is (T-248: no fourth try,
   * nothing polls, and later batches wait).
   */
  park?: (turn: ParkingTurn) => Promise<ParkAnswer>;
}

let leaseHooks: LeaseHooks = {};

/** Sets the lease's hooks for this Worker isolate; returns the function that puts the earlier ones back. */
export function setLeaseHooks(next: LeaseHooks): () => void {
  const before = leaseHooks;
  leaseHooks = next;
  return () => {
    leaseHooks = before;
  };
}

// ---- the stored state -------------------------------------------------------------------------------------------

/**
 * leased: running. committing: a commit was sent (sticky: it may have gone through). committed: final, though while it
 * still holds the lease its run's reply has not ended (T-253). parking: its third lapse came with no commit, and the park
 * is under way (T-253). replaced and parked are final.
 */
export type TurnState = "leased" | "committing" | "committed" | "replaced" | "parking" | "parked";

/** One turn as a reader sees it. */
export interface TurnEntry {
  turnId: string;
  eventIds: string[];
  state: TurnState;
  restart: boolean;
  tries: number;
  /** When its lease lapses, while it holds the lease; else null. */
  leaseUntil: number | null;
  /** K-05's committedAt, once committed. */
  committedAt: string | null;
}

interface Item {
  seq: number;
  eventId: string;
}

interface TurnRow extends Record<string, SqlStorageValue> {
  /** The order the turn opened in (AUTOINCREMENT: never reused, never reordered). */
  seq: number;
  turn_id: string;
  items: string;
  state: string;
  restart: number;
  tries: number;
  committed_at: string | null;
}

interface LeaseRow extends Record<string, SqlStorageValue> {
  turn_id: string;
  until_ms: number;
}

interface WaitingRow extends Record<string, SqlStorageValue> {
  batch_id: number;
  items: string;
}

export function createLeaseTables(sql: SqlStorage): void {
  // Every batch the lease has seen, once: the turn that took it, or null while it waits for the next turn.
  sql.exec(
    `CREATE TABLE IF NOT EXISTS lease_batches (
       batch_id INTEGER PRIMARY KEY,
       items TEXT NOT NULL,
       turn_id TEXT,
       seen_ms INTEGER NOT NULL
     )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS lease_turns (
       seq INTEGER PRIMARY KEY AUTOINCREMENT,
       turn_id TEXT NOT NULL UNIQUE,
       items TEXT NOT NULL,
       state TEXT NOT NULL,
       restart INTEGER NOT NULL,
       tries INTEGER NOT NULL,
       opened_ms INTEGER NOT NULL,
       committed_at TEXT
     )`,
  );
  // The handle's one lease: the table holds one row at most.
  sql.exec(
    `CREATE TABLE IF NOT EXISTS turn_lease (
       one INTEGER PRIMARY KEY CHECK (one = 1),
       turn_id TEXT NOT NULL,
       until_ms INTEGER NOT NULL
     )`,
  );
  // A turn whose lease lapsed while PostgreSQL was down (T-270): held as it was, until `resume`.
  sql.exec("CREATE TABLE IF NOT EXISTS lease_held (turn_id TEXT PRIMARY KEY)");
  // The K-04 handle id each turn's last commit named, as sent (T-1206): a label, told to the host with a lost commit.
  sql.exec(
    "CREATE TABLE IF NOT EXISTS lease_commit_handles (turn_id TEXT PRIMARY KEY, handle_id TEXT NOT NULL)",
  );
  createScheduleTable(sql);
}

/** What `advance` decided from, compared again inside its transaction. */
interface Snapshot {
  lease: {
    turnId: string;
    untilMs: number;
    state: string;
    restart: number;
    tries: number;
    items: Item[];
  } | null;
  waiting: { batchId: number; items: Item[] }[];
}

export interface LeaseHost {
  storage: DurableObjectStorage;
  /** Sets the actor's one alarm to the earliest entry of the stored schedule. */
  arm(): Promise<void>;
  /** Keeps a turn's work alive past the call that started it (the actor's waitUntil). */
  lend(work: Promise<void>): void;
  /**
   * Pins the turn's bundle for one run (T-249): null when it cannot (the run's work then never starts), or when `signal`
   * says the run is no longer the turn's.
   */
  pin(request: PinRequest, signal: AbortSignal): Promise<TurnPin | null>;
  /** The handle's safety holds open now, in the order they were made (the actor's safety read keeps them). */
  holds(): OpenHold[];
  /** The handle's texts not read yet now, by event id in arrival order (CommitContext.unread). */
  unread(): string[];
  /**
   * The turn's trace for its park (T-253): under the bundle pinned for the turn id (T-249), or `arrivedUnder` when no run
   * was ever pinned; null when neither is known. It records nothing.
   */
  parkTrace(request: ParkTraceRequest): { bundleId: BundleId; trace: TraceContext } | null;
  /**
   * Told of each commit that came back committed, first or repeated, before the run that sent it is answered (T-269): the
   * actor refreshes its own copies from it, so the stopped flag a STOP or START wrote is set before any reply that commit
   * wrote can go. `opened` is the order the lease opened the turn in (lease_turns.seq): an answer can come late, after
   * turns opened later have committed or lost their answers (DL-427), so the host weighs it by its turn's place. Optional;
   * a throw changes nothing for the commit.
   */
  committed?(turn: CommitTurnRef, answer: CommitTurnCommitted, opened: number): void;
  /**
   * Told of a commit that went through with its answer lost (T-1206): a park answered alreadyCommitted, so `committed` was
   * never called for it. Called before the turn finishes, so before the next turn opens: the actor's copies cannot read
   * what that commit wrote, so they read its stopped flag and its safety timers again, failing safe. Optional; a throw
   * changes nothing for the turn.
   */
  commitLost?(lost: LostCommit): void;
  /**
   * True while PostgreSQL is down (T-270): a lapse is no crash, so the lease holds the turn as it is (no rerun, no try, no
   * park), and no batch opens or restarts a turn, until `resume`. Optional: left out (or a throw), never held.
   */
  held?(): boolean;
  /**
   * Replays the host's write-on-return queue before a commit is sent (T-270; QUESTIONS.md CQ-104 (f)): false while it still
   * holds a danger or stop write the core is not answering for, and the commit is then not sent (`transient`). Optional:
   * left out, every commit is sent; a throw sends nothing (fails closed).
   */
  beforeCommit?(): Promise<boolean>;
}

/** What the park's trace is opened from (T-253). */
export interface ParkTraceRequest {
  turnId: string;
  /** The first text's trace id, and the other texts' (CQ-06). */
  traceId: string;
  joinedTraceIds: readonly string[];
  /** The bundle id the turn's first text arrived under, the fallback when no run was ever pinned. */
  arrivedUnder: BundleId | null;
}

const bySeq = (items: Item[]): Item[] => [...items].sort((a, b) => a.seq - b.seq);

export class TurnLease {
  /** The run in flight for each turn, in this instance's memory, so a replaced or lapsed run can be told to stop. */
  private readonly runs = new Map<string, AbortController>();

  constructor(private readonly host: LeaseHost) {
    createLeaseTables(host.storage.sql);
  }

  private get sql(): SqlStorage {
    return this.host.storage.sql;
  }

  // ---- taking a batch ---------------------------------------------------------------------------------------------

  /**
   * Takes a closed batch: "taken" once the lease has it (now, or before: a batch id seen once is never taken twice), or
   * "unwired" when no turn can run, so the batch stays with the batch window. A taken batch opens a turn, restarts the
   * running one, or waits for the next turn.
   */
  async take(batch: ClosedBatch): Promise<"taken" | "unwired"> {
    const seen = this.sql.exec("SELECT 1 FROM lease_batches WHERE batch_id = ?", batch.batchId).toArray();
    if (seen.length === 0) {
      if (leaseHooks.runTurn === undefined) return "unwired";
      if (batch.entries.length === 0) return "taken";
      const items: Item[] = batch.entries.map((entry) => ({ seq: entry.seq, eventId: entry.event.eventId }));
      // One statement: two attempts with one batch at once record it once.
      this.sql.exec(
        "INSERT OR IGNORE INTO lease_batches (batch_id, items, turn_id, seen_ms) VALUES (?, ?, NULL, ?)",
        batch.batchId,
        JSON.stringify(items),
        actorClock().now(),
      );
    }
    await this.advance();
    return "taken";
  }

  /**
   * Gives the waiting batches a turn: with no lease held, they open the next turn; with a running turn that has not
   * restarted and has not begun its commit, they restart it once with its texts and theirs; otherwise they wait. The turn
   * id is hashed outside the transaction (WebCrypto is asynchronous), so the transaction decides again from what is stored
   * now and writes only when it decides the same; otherwise it starts over.
   */
  private async advance(): Promise<void> {
    for (;;) {
      // While PostgreSQL is down (T-270) the waiting batches wait: no turn opens or restarts until `resume`.
      if (leaseHooks.runTurn === undefined || this.isHeld()) return;
      const plan = planOf(this.snapshot(), actorClock().now());
      if (plan === null) return;
      const turnId = await turnIdOf(plan.items.map((item) => item.eventId));
      const opened = this.host.storage.transactionSync(() => {
        const at = actorClock().now();
        if (JSON.stringify(planOf(this.snapshot(), at)) !== JSON.stringify(plan)) return false;
        if (plan.replaces !== null) {
          this.sql.exec("UPDATE lease_turns SET state = 'replaced' WHERE turn_id = ?", plan.replaces);
          this.sql.exec("UPDATE lease_batches SET turn_id = ? WHERE turn_id = ?", turnId, plan.replaces);
        }
        this.sql.exec(
          "INSERT INTO lease_turns (turn_id, items, state, restart, tries, opened_ms) VALUES (?, ?, 'leased', ?, 1, ?)",
          turnId,
          JSON.stringify(plan.items),
          plan.replaces === null ? 0 : 1,
          at,
        );
        this.sql.exec("UPDATE lease_batches SET turn_id = ? WHERE turn_id IS NULL", turnId);
        if (plan.replaces === null) {
          // The table's one row: a second lease cannot be written beside a held one (the insert would fail).
          this.sql.exec(
            "INSERT INTO turn_lease (one, turn_id, until_ms) VALUES (1, ?, ?)",
            turnId,
            at + LEASE_MS,
          );
        } else {
          this.sql.exec(
            "UPDATE turn_lease SET turn_id = ?, until_ms = ? WHERE one = 1 AND turn_id = ?",
            turnId,
            at + LEASE_MS,
            plan.replaces,
          );
        }
        this.syncSchedule();
        return true;
      });
      if (!opened) continue;
      if (plan.replaces !== null) this.stop(plan.replaces);
      this.start(turnId);
      await this.host.arm();
      return;
    }
  }

  private snapshot(): Snapshot {
    const lease = this.leaseRow();
    const turn = lease === undefined ? undefined : this.turnRow(lease.turn_id);
    const waiting = this.sql
      .exec<WaitingRow>("SELECT batch_id, items FROM lease_batches WHERE turn_id IS NULL ORDER BY batch_id")
      .toArray()
      .map((row) => ({ batchId: row.batch_id, items: JSON.parse(row.items) as Item[] }));
    return {
      lease:
        lease === undefined || turn === undefined
          ? null
          : {
              turnId: lease.turn_id,
              untilMs: lease.until_ms,
              state: turn.state,
              restart: turn.restart,
              tries: turn.tries,
              items: JSON.parse(turn.items) as Item[],
            },
      waiting,
    };
  }

  // ---- running and committing ---------------------------------------------------------------------------------------

  /**
   * Starts a run of the turn that holds the lease, from its sealed texts. The run first pins the turn's bundle (T-249), then
   * hands the turn's work the turn with the pin; a run that is no longer the turn's by then never starts its work.
   */
  private start(turnId: string): void {
    const runTurn = leaseHooks.runTurn;
    const lease = this.leaseRow();
    const turn = this.turnRow(turnId);
    if (runTurn === undefined || lease?.turn_id !== turnId || turn === undefined) return;
    const eventIds = (JSON.parse(turn.items) as Item[]).map((item) => item.eventId);
    const entries = readInboxEvents(this.sql, eventIds);
    const traceId = entries[0]?.traceId ?? "";
    const joinedTraceIds = [...new Set(entries.slice(1).map((entry) => entry.traceId))].filter(
      (id) => id !== traceId,
    );
    this.runs.get(turnId)?.abort();
    const controller = new AbortController();
    this.runs.set(turnId, controller);
    const signal = controller.signal;
    const run: Omit<LeasedTurn, keyof TurnPin | "holds"> = {
      turnId,
      eventIds,
      entries,
      traceId,
      joinedTraceIds,
      tries: turn.tries,
      restart: turn.restart === 1,
      leaseUntil: lease.until_ms,
      signal,
      commit: (request, options) => this.commit(turnId, request, options?.reply === true),
      replied: () => this.replied(turnId, controller),
    };
    const pinRequest: PinRequest = {
      turnId,
      traceId,
      joinedTraceIds,
      texts: entries.length,
      tries: run.tries,
      restart: run.restart,
      leaseMs: LEASE_MS,
      arrivedUnder: entries[0]?.bundleId ?? null,
    };
    // A run that throws has crashed: nothing is written, and the lease lapses into a rerun. A run whose bundle cannot be
    // pinned is the same, with its work never started.
    this.host.lend(
      Promise.resolve()
        .then(() => this.host.pin(pinRequest, signal))
        .then((pinned) => {
          if (pinned === null || signal.aborted) return;
          // The holds are read at the run's start, once its bundle is pinned: a restart, a rerun and the next turn after a
          // commit carry the holds open then, a hold opened while the pin was read included.
          return runTurn({ ...run, ...pinned, holds: this.host.holds() });
        })
        .then(
          () => undefined,
          () => undefined,
        ),
    );
  }

  /** Tells a run that is no longer the turn's to stop (a restart replaced it, a park began, or its reply was given up). */
  private stop(turnId: string): void {
    this.runs.get(turnId)?.abort();
    this.runs.delete(turnId);
  }

  /**
   * The commit, through the lease: a replaced turn never commits, nor one the lease has begun to park; the first commit
   * call of a turn marks it committing, so no later batch restarts it (the call may go through even when its answer is
   * lost). The commit hook is handed the safety holds open now and the texts not read yet, read again after the gate, so a
   * hold that opened mid-turn binds this commit (DL-119, DL-127). Committed (first or repeat): with `reply` the turn keeps
   * the lease for its reply (T-253), otherwise the lease is released and the waiting batches open the next turn; parked:
   * the lease is released.
   */
  private async commit(turnId: string, request: CommitTurnRequest, reply: boolean): Promise<CommitAnswer> {
    if (request.turn.id !== turnId) return { error: "wrongTurn" };
    const port = leaseHooks.commit;
    if (port === undefined) return { error: "unwired" };
    // The write-on-return queue goes first (T-270; CQ-104 (f)): a danger or stop write the core is not answering for yet
    // keeps this commit back, with nothing sent and the turn's state as it was.
    if (!(await this.readyToCommit())) return { error: "transient" };
    const gate = this.host.storage.transactionSync((): LeaseRefusal | { opened: number } => {
      const turn = this.turnRow(turnId);
      if (turn === undefined) return { error: "unknownTurn" };
      if (turn.state === "replaced") return { error: "replaced" };
      if (turn.state === "parked" || turn.state === "parking") return { error: "parked" };
      if (turn.state === "leased") {
        this.sql.exec("UPDATE lease_turns SET state = 'committing' WHERE turn_id = ?", turnId);
      }
      // The handle id this commit names, kept as sent: if its answer is lost and a park finds it committed, the host is
      // told of it with this id (T-1206).
      const handleId: unknown = request.turn.handleId;
      if (typeof handleId === "string") {
        this.sql.exec(
          "INSERT OR REPLACE INTO lease_commit_handles (turn_id, handle_id) VALUES (?, ?)",
          turnId,
          handleId,
        );
      }
      return { opened: turn.seq };
    });
    if ("error" in gate) return gate;
    const at: CommitContext = { holds: this.host.holds(), unread: this.host.unread() };
    let answer: CommitTurnAnswer;
    try {
      answer = await port(request, at);
    } catch {
      return { error: "noAnswer" };
    }
    if (isCommitted(answer)) {
      this.tellCommitted(request.turn, answer, gate.opened);
      if (reply) await this.holdForReply(turnId, answer.committedAt);
      else await this.finish(turnId, "committed", answer.committedAt);
    } else if (answer.error === "turnParked") {
      await this.finish(turnId, "parked", null);
    }
    return answer;
  }

  /**
   * Tells the host of a committed answer before the run is answered (T-269: the actor's copies), with the order the turn
   * opened in, whenever the answer arrives (DL-427). A copy that cannot be refreshed never fails the commit: the next
   * write refreshes it.
   */
  private tellCommitted(turn: CommitTurnRef, answer: CommitTurnCommitted, opened: number): void {
    try {
      this.host.committed?.(turn, answer, opened);
    } catch {
      // The commit stands; the copies are refreshed on the next write.
    }
  }

  /**
   * The turn has committed and its run replies (T-253): it keeps the lease for the reply, renewed for LEASE_MS, so a crash
   * before the reply ends lets the lease lapse into a rerun (its commit answers repeated; only the rows with no plan are
   * composed). Later batches wait, as for a turn that has begun its commit. A turn already committed keeps what it has: a
   * rerun's repeat changes nothing, nor does a late answer once its lease went.
   */
  private async holdForReply(turnId: string, committedAt: string): Promise<void> {
    this.host.storage.transactionSync(() => {
      const turn = this.turnRow(turnId);
      const state = turn?.state;
      if (state === undefined || state === "committed" || state === "parked" || state === "replaced") return;
      this.sql.exec(
        "UPDATE lease_turns SET state = 'committed', committed_at = ? WHERE turn_id = ?",
        committedAt,
        turnId,
      );
      this.sql.exec(
        "UPDATE turn_lease SET until_ms = ? WHERE one = 1 AND turn_id = ?",
        actorClock().now() + LEASE_MS,
        turnId,
      );
      this.syncSchedule();
    });
    await this.host.arm();
  }

  /**
   * The run's reply has ended (T-253): its committed turn gives the lease up and the waiting batches open the next turn.
   * Only the run that has the turn now is heard: a run a lapse replaced leaves it to its rerun.
   */
  private async replied(turnId: string, run: AbortController): Promise<void> {
    if (this.runs.get(turnId) !== run) return;
    const released = this.host.storage.transactionSync((): boolean => {
      const turn = this.turnRow(turnId);
      if (turn?.state !== "committed" || this.leaseRow()?.turn_id !== turnId) return false;
      this.sql.exec("DELETE FROM turn_lease WHERE turn_id = ?", turnId);
      this.syncSchedule();
      return true;
    });
    if (!released) return;
    this.runs.delete(turnId);
    await this.advance();
    await this.host.arm();
  }

  /**
   * The turn is done: the lease is released and the waiting batches open the next turn. A later answer changes nothing,
   * and a turn already committed keeps its lease until its reply ends (T-253).
   */
  private async finish(
    turnId: string,
    state: "committed" | "parked",
    committedAt: string | null,
  ): Promise<void> {
    this.host.storage.transactionSync(() => {
      const turn = this.turnRow(turnId);
      if (turn === undefined || turn.state === "committed" || turn.state === "parked") return;
      this.sql.exec(
        "UPDATE lease_turns SET state = ?, committed_at = ? WHERE turn_id = ?",
        state,
        committedAt,
        turnId,
      );
      this.sql.exec("DELETE FROM turn_lease WHERE turn_id = ?", turnId);
      this.syncSchedule();
    });
    this.runs.delete(turnId);
    await this.advance();
    await this.host.arm();
  }

  // ---- the lapse ------------------------------------------------------------------------------------------------------

  /**
   * The schedule's lease entry (the actor's alarm): a lease past its 60 s with no commit, or with a reply that has not
   * ended (T-253), reruns the turn from its sealed texts under the same turn id, with one more try. A third lapse with no
   * commit parks the turn (T-253; with no park wired it is left as it is: no fourth try); a third lapse of a reply gives
   * the reply up. Then any batch still waiting is given its turn (a crash may have come between taking a batch and giving
   * it a turn). With no lapsed lease the entry is put in step with what is stored, so an entry due now that a wired
   * `runTurn` left cannot re-arm the alarm at once on every run after `runTurn` becomes unwired (T-248 security note c).
   */
  async onAlarm(): Promise<void> {
    const now = actorClock().now();
    const held = this.isHeld();
    const due = this.host.storage.transactionSync((): { act: Lapse; turnId: string } | null => {
      const lease = this.leaseRow();
      if (lease === undefined || lease.until_ms > now) {
        this.syncSchedule();
        return null;
      }
      const act = this.lapseFor(lease.turn_id);
      if (act === null) return null;
      if (held) {
        // PostgreSQL is down (T-270): no crash. The turn is held as it is, its lease renewed, until `resume`.
        this.sql.exec("INSERT OR IGNORE INTO lease_held (turn_id) VALUES (?)", lease.turn_id);
        this.sql.exec("UPDATE turn_lease SET until_ms = ? WHERE one = 1", now + LEASE_MS);
        this.syncSchedule();
        return null;
      }
      return this.lapse(lease.turn_id, act, now, true);
    });
    await this.act(due);
    await this.advance();
  }

  /**
   * PostgreSQL is back (T-270): a turn held while it was down runs again now with the tries it had (the outage was no
   * crash), or goes on parking, or has its reply given up, as its lapse would have it; then the waiting batches open the
   * next turn. A turn whose lease did not lapse meanwhile is left to its lapse.
   */
  async resume(): Promise<void> {
    const now = actorClock().now();
    const due = this.host.storage.transactionSync((): { act: Lapse; turnId: string } | null => {
      const held = this.sql
        .exec<{ turn_id: string }>("SELECT turn_id FROM lease_held")
        .toArray()
        .map((row) => row.turn_id);
      this.sql.exec("DELETE FROM lease_held");
      const lease = this.leaseRow();
      if (lease === undefined || !held.includes(lease.turn_id)) {
        this.syncSchedule();
        return null;
      }
      const act = this.lapseFor(lease.turn_id);
      return act === null ? null : this.lapse(lease.turn_id, act, now, false);
    });
    await this.act(due);
    await this.advance();
    await this.host.arm();
  }

  /**
   * What a lapse does to the turn holding the lease, inside the caller's transaction; null, with the schedule put in step,
   * when nothing can be done (no such turn, no turn can run, or a third lapse with no park wired: no fourth try).
   */
  private lapseFor(turnId: string): Lapse | null {
    const turn = this.turnRow(turnId);
    const act = turn === undefined ? null : lapseOf(turn);
    if (
      act === null ||
      leaseHooks.runTurn === undefined ||
      (act === "park" && leaseHooks.park === undefined)
    ) {
      this.syncSchedule();
      return null;
    }
    return act;
  }

  /**
   * Applies a lapse inside the caller's transaction: a rerun (one more try when `countTry`), a park (marked first, so no
   * run commits from now on and no batch restarts it; tried again PARK_RETRY_MS on if it fails) or a reply given up.
   */
  private lapse(turnId: string, act: Lapse, now: number, countTry: boolean): { act: Lapse; turnId: string } {
    if (act === "park") {
      this.sql.exec("UPDATE lease_turns SET state = 'parking' WHERE turn_id = ?", turnId);
      this.sql.exec("UPDATE turn_lease SET until_ms = ? WHERE one = 1", now + PARK_RETRY_MS);
    } else if (act === "giveUp") {
      this.sql.exec("DELETE FROM turn_lease WHERE one = 1");
    } else {
      if (countTry) this.sql.exec("UPDATE lease_turns SET tries = tries + 1 WHERE turn_id = ?", turnId);
      this.sql.exec("UPDATE turn_lease SET until_ms = ? WHERE one = 1", now + LEASE_MS);
    }
    this.syncSchedule();
    return { act, turnId };
  }

  /** Runs what a lapse decided, once its transaction is over. */
  private async act(due: { act: Lapse; turnId: string } | null): Promise<void> {
    if (due?.act === "rerun") this.start(due.turnId);
    else if (due?.act === "park") await this.park(due.turnId);
    else if (due?.act === "giveUp") this.stop(due.turnId);
  }

  /** True while the host says PostgreSQL is down (T-270); a host that cannot say holds nothing. */
  private isHeld(): boolean {
    try {
      return this.host.held?.() === true;
    } catch {
      return false;
    }
  }

  /** The host's write-on-return queue, replayed before a commit (T-270; CQ-104 (f)): false keeps the commit back. */
  private async readyToCommit(): Promise<boolean> {
    try {
      return (await this.host.beforeCommit?.()) ?? true;
    } catch {
      return false;
    }
  }

  /**
   * Parks the turn after its third lapse with no commit (T-253): the last run is told to stop, and the park hook gets the
   * turn, its sealed texts and its trace. Parked (first or repeated): the lease is released and the waiting batches open
   * the next turn. alreadyCommitted: the host is told of the commit whose answer was lost (`commitLost`, T-1206), then the
   * turn finishes as committed. Anything else, a throw included: the turn stays parking and the park is tried again when
   * the lease entry falls due, PARK_RETRY_MS after this try began.
   */
  private async park(turnId: string): Promise<void> {
    const park = leaseHooks.park;
    const turn = this.turnRow(turnId);
    if (park === undefined || turn?.state !== "parking") return;
    this.stop(turnId);
    const eventIds = (JSON.parse(turn.items) as Item[]).map((item) => item.eventId);
    const entries = readInboxEvents(this.sql, eventIds);
    const traceId = entries[0]?.traceId ?? "";
    const joinedTraceIds = [...new Set(entries.slice(1).map((entry) => entry.traceId))].filter(
      (id) => id !== traceId,
    );
    const traced = this.host.parkTrace({
      turnId,
      traceId,
      joinedTraceIds,
      arrivedUnder: entries[0]?.bundleId ?? null,
    });
    let answer: ParkAnswer = { error: "noBundle" };
    if (traced !== null) {
      try {
        answer = await park({
          turnId,
          eventIds,
          entries,
          traceId,
          joinedTraceIds,
          tries: turn.tries,
          bundleId: traced.bundleId,
          trace: traced.trace,
        });
      } catch {
        answer = { error: "noAnswer" };
      }
    }
    if (isParked(answer)) await this.finish(turnId, "parked", null);
    else if (isAlreadyCommitted(answer)) {
      this.tellCommitLost(turnId, turn.seq, answer.committedAt);
      await this.finish(turnId, "committed", answer.committedAt);
    } else await this.host.arm();
  }

  /**
   * Tells the host of a commit that went through with its answer lost (T-1206), with the order its turn opened in and the
   * handle id the turn's last commit named; a stored id that cannot be read is told as none (the host then fails safe
   * without it). A host that cannot be told changes nothing for the turn.
   */
  private tellCommitLost(turnId: string, opened: number, committedAt: string): void {
    const handleId = this.commitHandleOf(turnId);
    try {
      this.host.commitLost?.({ turnId, opened, handleId, committedAt });
    } catch {
      // The turn stands committed; the copies fail safe on their own reads.
    }
  }

  /** The K-04 handle id the turn's last commit named, as sent (T-1206); null when none was kept or it cannot be read. */
  private commitHandleOf(turnId: string): string | null {
    try {
      return (
        this.sql
          .exec<{ handle_id: string }>("SELECT handle_id FROM lease_commit_handles WHERE turn_id = ?", turnId)
          .toArray()[0]?.handle_id ?? null
      );
    } catch {
      return null;
    }
  }

  /**
   * Keeps the lease's schedule entry in step with the stored state: due when the lease lapses (a park under way: when it
   * is tried again); due now when batches wait and no lease is held; none when nothing can happen (no turn can run, or a
   * third lapse with no commit while no park is wired).
   */
  private syncSchedule(): void {
    const now = actorClock().now();
    const wired = leaseHooks.runTurn !== undefined;
    const lease = this.leaseRow();
    if (lease !== undefined) {
      const turn = this.turnRow(lease.turn_id);
      const lapsed = lease.until_ms <= now;
      const act = turn === undefined ? null : lapseOf(turn);
      const nothingToDo = act === null || (act === "park" && leaseHooks.park === undefined);
      const stuck = lapsed && (!wired || nothingToDo);
      if (stuck) unscheduleEntry(this.sql, SCHEDULE_LEASE);
      else scheduleEntry(this.sql, SCHEDULE_LEASE, lease.until_ms);
      return;
    }
    const waiting = this.sql.exec("SELECT 1 FROM lease_batches WHERE turn_id IS NULL LIMIT 1").toArray();
    if (wired && waiting.length > 0) scheduleEntry(this.sql, SCHEDULE_LEASE, now);
    else unscheduleEntry(this.sql, SCHEDULE_LEASE);
  }

  // ---- reading ----------------------------------------------------------------------------------------------------

  private leaseRow(): LeaseRow | undefined {
    return this.sql.exec<LeaseRow>("SELECT turn_id, until_ms FROM turn_lease WHERE one = 1").toArray()[0];
  }

  private turnRow(turnId: string): TurnRow | undefined {
    return this.sql
      .exec<TurnRow>(
        "SELECT seq, turn_id, items, state, restart, tries, committed_at FROM lease_turns WHERE turn_id = ?",
        turnId,
      )
      .toArray()[0];
  }

  /** Every turn, in the order they opened. */
  read(): TurnEntry[] {
    const lease = this.leaseRow();
    return this.sql
      .exec<TurnRow>(
        "SELECT seq, turn_id, items, state, restart, tries, committed_at FROM lease_turns ORDER BY seq",
      )
      .toArray()
      .map((row) => ({
        turnId: row.turn_id,
        eventIds: (JSON.parse(row.items) as Item[]).map((item) => item.eventId),
        state: row.state as TurnState,
        restart: row.restart === 1,
        tries: row.tries,
        leaseUntil: lease?.turn_id === row.turn_id ? lease.until_ms : null,
        committedAt: row.committed_at,
      }));
  }

  /**
   * The event ids, in arrival order, of the texts the lease has that no commit has taken yet (T-270): those of a turn
   * leased, committing or being parked, and of the batches waiting for the next turn.
   */
  pendingEventIds(): string[] {
    const items: Item[] = [];
    const turns = this.sql
      .exec<{ items: string }>(
        "SELECT items FROM lease_turns WHERE state IN ('leased', 'committing', 'parking') ORDER BY seq",
      )
      .toArray();
    const waiting = this.sql
      .exec<{ items: string }>("SELECT items FROM lease_batches WHERE turn_id IS NULL ORDER BY batch_id")
      .toArray();
    for (const row of [...turns, ...waiting]) items.push(...(JSON.parse(row.items) as Item[]));
    return [...new Set(bySeq(items).map((item) => item.eventId))];
  }

  /** The batch ids that wait for the next turn, in order. */
  waiting(): number[] {
    return this.sql
      .exec<{ batch_id: number }>(
        "SELECT batch_id FROM lease_batches WHERE turn_id IS NULL ORDER BY batch_id",
      )
      .toArray()
      .map((row) => row.batch_id);
  }
}

/** What a lapse does to the turn that holds the lease (T-253). */
type Lapse = "rerun" | "park" | "giveUp";

/**
 * A lapse reruns a turn that has started fewer than MAX_TRIES times, before its commit or while its reply has not ended;
 * after the last try it parks a turn with no commit (and goes on parking one already parking) and gives a reply up. A
 * replaced or parked turn holds no lease (null: nothing to do).
 */
function lapseOf(turn: TurnRow): Lapse | null {
  switch (turn.state) {
    case "leased":
    case "committing":
      return turn.tries >= MAX_TRIES ? "park" : "rerun";
    case "parking":
      return "park";
    case "committed":
      return turn.tries >= MAX_TRIES ? "giveUp" : "rerun";
    default:
      return null;
  }
}

/**
 * What the waiting batches do: open a turn (no lease is held), restart the running turn once (it holds the lease, has not
 * restarted and has not begun its commit; a third try that lapsed is left for the park), or wait (null): a turn that has
 * begun its commit, is replying (T-253) or is being parked keeps them waiting.
 */
function planOf(state: Snapshot, now: number): { items: Item[]; replaces: string | null } | null {
  if (state.waiting.length === 0) return null;
  const waitingItems = state.waiting.flatMap((batch) => batch.items);
  const live = state.lease;
  if (live === null) return { items: bySeq(waitingItems), replaces: null };
  const stuck = live.tries >= MAX_TRIES && live.untilMs <= now;
  if (live.state !== "leased" || live.restart === 1 || stuck) return null;
  return { items: bySeq([...live.items, ...waitingItems]), replaces: live.turnId };
}
