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
// that commit too. The lease refuses nothing for a hold: T-252's gate commits only protective changes and the safety flow
// while one is open (arch 06 lines 327 and 329), and until it is wired no turn runs at all.
//
// Not here: what runs inside a turn (the guard and frontier, T-251; decide, gate and commit, T-252), joined through the
// `runTurn` and `commit` hooks. Unwired, no turn runs and each closed batch stays stored with the batch window (fails
// closed). The park after a third crash is T-253: a third lapse is left as it is, with no fourth try. Never logged or put
// in a span: a text's words (K-08 README line 75). Nothing here logs (the pin records the turn's `lease` span).

import type { PinnedBundle, PinRequest, TurnPin } from "../bundle";
import type { OpenHold } from "../safety";
import type { BundleId, TraceContext } from "../trace";
import { actorClock, createScheduleTable, scheduleEntry, unscheduleEntry, type ClosedBatch } from "./batch";
import { readInboxEvents, type InboxEntry } from "./inbox";

/** The lease's length: after it the turn reruns from its sealed texts (arch 01 line 61). */
export const LEASE_MS = 60_000;
/** A turn starts at most 3 times; a third crash before the commit parks it (arch 11 line 576; K-04 turns.tries; T-253). */
export const MAX_TRIES = 3;
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
 * - `parked`: the turn was parked;
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
  /** Aborted when this run is no longer the turn's: a restart replaced the turn, or a lapse started a rerun. */
  signal: AbortSignal;
  /** Commits the turn through the lease (K-05 commitTurn); refused once a restart has replaced the turn. */
  commit(request: CommitTurnRequest): Promise<CommitAnswer>;
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
}

/** Joined at D-017; a test sets doubles. Unwired, no turn runs and no turn commits (fails closed). */
export interface LeaseHooks {
  /** The turn's work (T-251, T-252). A throw is a crash: the lease lapses and the turn reruns. */
  runTurn?: (turn: LeasedTurn) => void | Promise<void>;
  /**
   * K-05 v1 commitTurn (C-087, through the Tool API), behind T-252's gate, which reads `at.holds`: the safety holds open at
   * commit time, so it can refuse a routine commit while one is open.
   */
  commit?: (request: CommitTurnRequest, at: CommitContext) => Promise<CommitTurnAnswer>;
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

/** leased: running. committing: a commit was sent (sticky: it may have gone through). The rest are final. */
export type TurnState = "leased" | "committing" | "committed" | "replaced" | "parked";

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
      if (leaseHooks.runTurn === undefined) return;
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
      commit: (request) => this.commit(turnId, request),
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

  /** Tells a run that is no longer the turn's to stop (a restart replaced it). */
  private stop(turnId: string): void {
    this.runs.get(turnId)?.abort();
    this.runs.delete(turnId);
  }

  /**
   * The commit, through the lease: a replaced turn never commits; the first commit call of a turn marks it committing, so
   * no later batch restarts it (the call may go through even when its answer is lost). The commit hook is handed the
   * safety holds open now, read again after the gate, so a hold that opened mid-turn binds this commit (DL-119). Committed
   * (first or repeat), or parked: the lease is released and the waiting batches open the next turn.
   */
  private async commit(turnId: string, request: CommitTurnRequest): Promise<CommitAnswer> {
    if (request.turn.id !== turnId) return { error: "wrongTurn" };
    const port = leaseHooks.commit;
    if (port === undefined) return { error: "unwired" };
    const gate = this.host.storage.transactionSync((): LeaseRefusal | null => {
      const turn = this.turnRow(turnId);
      if (turn === undefined) return { error: "unknownTurn" };
      if (turn.state === "replaced") return { error: "replaced" };
      if (turn.state === "parked") return { error: "parked" };
      if (turn.state === "leased") {
        this.sql.exec("UPDATE lease_turns SET state = 'committing' WHERE turn_id = ?", turnId);
      }
      return null;
    });
    if (gate !== null) return gate;
    const at: CommitContext = { holds: this.host.holds() };
    let answer: CommitTurnAnswer;
    try {
      answer = await port(request, at);
    } catch {
      return { error: "noAnswer" };
    }
    if (isCommitted(answer)) {
      await this.finish(turnId, "committed", answer.committedAt);
    } else if (answer.error === "turnParked") {
      await this.finish(turnId, "parked", null);
    }
    return answer;
  }

  /** The turn is done: the lease is released and the waiting batches open the next turn. A later answer changes nothing. */
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
   * The schedule's lease entry (the actor's alarm): a lease past its 60 s with no commit reruns the turn from its sealed
   * texts under the same turn id, with one more try. A third lapse is left for the park (T-253): no fourth try. Then any
   * batch still waiting is given its turn (a crash may have come between taking a batch and giving it a turn). With no
   * lapsed lease the entry is put in step with what is stored, so an entry due now that a wired `runTurn` left cannot
   * re-arm the alarm at once on every run after `runTurn` becomes unwired (T-248 security note c).
   */
  async onAlarm(): Promise<void> {
    const now = actorClock().now();
    const rerun = this.host.storage.transactionSync((): string | null => {
      const lease = this.leaseRow();
      if (lease === undefined || lease.until_ms > now) {
        this.syncSchedule();
        return null;
      }
      const turn = this.turnRow(lease.turn_id);
      const running = turn !== undefined && (turn.state === "leased" || turn.state === "committing");
      if (!running || leaseHooks.runTurn === undefined || turn.tries >= MAX_TRIES) {
        this.syncSchedule();
        return null;
      }
      this.sql.exec("UPDATE lease_turns SET tries = tries + 1 WHERE turn_id = ?", lease.turn_id);
      this.sql.exec("UPDATE turn_lease SET until_ms = ? WHERE one = 1", now + LEASE_MS);
      this.syncSchedule();
      return lease.turn_id;
    });
    if (rerun !== null) this.start(rerun);
    await this.advance();
  }

  /**
   * Keeps the lease's schedule entry in step with the stored state: due when the lease lapses; due now when batches wait
   * and no lease is held; none when nothing can happen (no turn can run, or a third lapse waits for the park).
   */
  private syncSchedule(): void {
    const now = actorClock().now();
    const wired = leaseHooks.runTurn !== undefined;
    const lease = this.leaseRow();
    if (lease !== undefined) {
      const turn = this.turnRow(lease.turn_id);
      const lapsed = lease.until_ms <= now;
      const stuck = lapsed && (!wired || (turn?.tries ?? MAX_TRIES) >= MAX_TRIES);
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
        "SELECT turn_id, items, state, restart, tries, committed_at FROM lease_turns WHERE turn_id = ?",
        turnId,
      )
      .toArray()[0];
  }

  /** Every turn, in the order they opened. */
  read(): TurnEntry[] {
    const lease = this.leaseRow();
    return this.sql
      .exec<TurnRow>(
        "SELECT turn_id, items, state, restart, tries, committed_at FROM lease_turns ORDER BY seq",
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

/**
 * What the waiting batches do: open a turn (no lease is held), restart the running turn once (it holds the lease, has not
 * restarted and has not begun its commit; a third try that lapsed is left for the park), or wait (null).
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
