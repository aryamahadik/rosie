// The actor's write-on-return queue (T-269; C-053; arch 11 line 566: "Safety and STOP lines go from the actor and are
// written on return ... On return: danger, stops, then the rest"; line 564: "On return: danger first, then stops, then the
// rest in order").
//
// While PostgreSQL is down, what the actor sends by itself (a safety line or the outage line through Linq, and with T-270 a
// stop or start reply) is written to the shared core later. Each such write waits here, in the actor's own storage, sealed
// by whoever queued it (it holds a person's words or number), and is replayed when PostgreSQL is back:
//
//   - in order: danger first, then stops, then the rest, each in the order it was queued;
//   - once: a write the core took leaves the queue at once and its key is kept, so the same write queued again is never
//     replayed again; replays never overlap in one instance (each waits for the one before it), so two replays at once
//     replay each write once;
//   - a write the core does not take because it is still not answering (no answer, a throw, or `transient`) stops the
//     replay there: nothing queued after it goes before it, and the next replay starts from it again;
//   - a write the core refuses (any other error: its answer, not the outage) is kept with the refusal's code, a label, and
//     tried again first on the next replay. In the danger and stop ranks it holds its rank (DL-167 rulings 1 and 4):
//     nothing queued after it in that rank is sent until the core takes it, and then those writes follow in their queued
//     order, so each rank's writes reach the core in the order they were queued, a refused write is never retried after a
//     later write of its rank was taken, and a replay can never lift a stop. The other ranks go on. A refusal that never
//     passes keeps holding its rank. In the rest, the writes after a refused one go on (round 1's rule, kept).
//
// A rank a refusal held stays marked (`return_held`: the last refused write's key and code) until every write of that
// rank has been written, in order. While the stop rank is marked, the actor's copy of the stopped flag reads stopped, the
// stricter reading, so it stays stopped until every stop or start record queued (any START among them) is written in
// order (./copies.ts `readStopped`; DL-167 ruling 2).
//
// A write queued again under a key still waiting takes the new box in its old place. The queue never opens a box: whoever
// queued a write opens and sends it at replay (`send`). Never logged or put in a span: a box, a word, a number. Not here:
// when PostgreSQL is down and when it is back (T-270).

import { isLabel } from "../../trace";

/** The order on return (arch 11 lines 564, 566): danger, then stops, then the rest. */
export const RETURN_RANKS = ["danger", "stop", "rest"] as const;
export type ReturnRank = (typeof RETURN_RANKS)[number];

/**
 * The ranks whose writes reach the core in the order they were queued, through a refusal too (DL-167 rulings 1 and 4): a
 * refused write holds its rank. In the rest, the writes after a refused one go on.
 */
export const ORDERED_RANKS: readonly ReturnRank[] = ["danger", "stop"];

/** A rank a refusal holds (DL-167): the last refused write's key and code (labels), and since when, on the actor's clock. */
export interface HeldRank {
  readonly rank: ReturnRank;
  readonly key: string;
  readonly code: string;
  readonly since: number;
}

/** A write to queue: its key (one write, one key), the K-09 call it replays as, its rank, and its sealed request. */
export interface ReturnWrite {
  readonly key: string;
  readonly call: string;
  readonly rank: ReturnRank;
  /** The request, sealed by whoever queued it. Never opened, logged or answered by the queue. */
  readonly box: string;
}

/** A write as the replay hands it back to be sent. */
export interface QueuedWrite extends ReturnWrite {
  readonly seq: number;
  /** How many times it was sent before. */
  readonly tries: number;
}

/** A queued write as a reader sees it: labels and counts, never its box. */
export interface QueuedEntry {
  readonly seq: number;
  readonly key: string;
  readonly call: string;
  readonly rank: ReturnRank;
  readonly tries: number;
  /** The core's last refusal (a label), or null. */
  readonly refused: string | null;
}

/** What sending one write gave: the core took it; the core is not answering yet; or the core refused it (its code). */
export type ReplayStep = "written" | "notBack" | { readonly refused: string };

/** One replay: writes the core took, writes it refused, and writes still queued after it. */
export interface ReplayReport {
  readonly written: number;
  readonly refused: number;
  readonly left: number;
}

/** queued: a new write; requeued: a write still waiting took the new box; done: that write was replayed already. */
export type Enqueued = "queued" | "requeued" | "done";

interface QueueRow extends Record<string, SqlStorageValue> {
  seq: number;
  key: string;
  call: string;
  rank: number;
  box: string;
  tries: number;
  refused: string | null;
}

interface HeldRow extends Record<string, SqlStorageValue> {
  rank: number;
  key: string;
  code: string;
  since_ms: number;
}

const rankOf = (value: number): ReturnRank => RETURN_RANKS[value] ?? "rest";

export function createReturnTables(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS return_queue (
       seq INTEGER PRIMARY KEY AUTOINCREMENT,
       key TEXT NOT NULL UNIQUE,
       call TEXT NOT NULL,
       rank INTEGER NOT NULL,
       box TEXT NOT NULL,
       queued_ms INTEGER NOT NULL,
       tries INTEGER NOT NULL DEFAULT 0,
       refused TEXT
     )`,
  );
  // The key of every write the core took: the same write queued again is never replayed again.
  sql.exec("CREATE TABLE IF NOT EXISTS return_done (key TEXT PRIMARY KEY, done_ms INTEGER NOT NULL)");
  // Each ordered rank a refusal held, until every write of that rank has been written, in order (DL-167).
  sql.exec(
    `CREATE TABLE IF NOT EXISTS return_held (
       rank INTEGER PRIMARY KEY,
       key TEXT NOT NULL,
       code TEXT NOT NULL,
       since_ms INTEGER NOT NULL
     )`,
  );
}

/** The ranks a refusal holds now, in replay order, as labels (the actor's copy of the stopped flag reads the stop rank's). */
export function readHeld(sql: SqlStorage): HeldRank[] {
  return sql
    .exec<HeldRow>("SELECT rank, key, code, since_ms FROM return_held ORDER BY rank")
    .toArray()
    .map((row) => ({ rank: rankOf(row.rank), key: row.key, code: row.code, since: row.since_ms }));
}

export interface ReturnQueueHost {
  storage: DurableObjectStorage;
  /** The actor's clock. */
  now(): number;
}

export class ReturnQueue {
  /** The replay running in this instance, if any: the next one waits for it. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: ReturnQueueHost) {
    createReturnTables(host.storage.sql);
  }

  private get sql(): SqlStorage {
    return this.host.storage.sql;
  }

  /** Queues a write, in one storage step. A rank or call that is not known is refused (a throw, nothing queued). */
  enqueue(write: ReturnWrite): Enqueued {
    const rank = RETURN_RANKS.indexOf(write.rank);
    if (rank < 0) throw new Error("unknownRank");
    if (!isLabel(write.call)) throw new Error("unknownCall");
    if (write.key === "" || write.box === "") throw new Error("emptyWrite");
    return this.host.storage.transactionSync((): Enqueued => {
      if (this.sql.exec("SELECT 1 FROM return_done WHERE key = ?", write.key).toArray().length > 0) {
        return "done";
      }
      const waiting = this.sql.exec("SELECT 1 FROM return_queue WHERE key = ?", write.key).toArray();
      if (waiting.length > 0) {
        this.sql.exec("UPDATE return_queue SET box = ?, refused = NULL WHERE key = ?", write.box, write.key);
        return "requeued";
      }
      this.sql.exec(
        "INSERT INTO return_queue (key, call, rank, box, queued_ms) VALUES (?, ?, ?, ?, ?)",
        write.key,
        write.call,
        rank,
        write.box,
        this.host.now(),
      );
      return "queued";
    });
  }

  /**
   * Replays the queue in its order (danger, stops, the rest; each in the order queued) through `send`, after any replay
   * already running here. A send that throws counts as the core not answering. A refused danger or stop write holds its
   * rank: nothing after it in that rank is sent in this replay.
   */
  replay(send: (write: QueuedWrite) => Promise<ReplayStep>): Promise<ReplayReport> {
    const run = this.chain.then(() => this.pass(send));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The queued writes in replay order, as labels. */
  read(): QueuedEntry[] {
    return this.rows().map((row) => ({
      seq: row.seq,
      key: row.key,
      call: row.call,
      rank: rankOf(row.rank),
      tries: row.tries,
      refused: row.refused,
    }));
  }

  /** The ranks a refusal holds now, as labels: each until every write of that rank has been written, in order. */
  held(): HeldRank[] {
    return readHeld(this.sql);
  }

  /** How many writes are queued. */
  size(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM return_queue").one().n;
  }

  private rows(): QueueRow[] {
    return this.sql
      .exec<QueueRow>("SELECT seq, key, call, rank, box, tries, refused FROM return_queue ORDER BY rank, seq")
      .toArray();
  }

  private async pass(send: (write: QueuedWrite) => Promise<ReplayStep>): Promise<ReplayReport> {
    let written = 0;
    let refused = 0;
    // The ordered ranks a refusal held in this replay: nothing more of them goes now (DL-167 rulings 1 and 4).
    const holding = new Set<number>();
    for (const row of this.rows()) {
      if (holding.has(row.rank)) continue;
      const write: QueuedWrite = {
        seq: row.seq,
        key: row.key,
        call: row.call,
        rank: rankOf(row.rank),
        box: row.box,
        tries: row.tries,
      };
      let step: ReplayStep;
      try {
        step = await send(write);
      } catch {
        step = "notBack";
      }
      if (step === "written") {
        this.done(row);
        written += 1;
        continue;
      }
      if (step === "notBack") {
        // Still down: nothing queued after this write goes before it.
        this.tried(row.seq, null);
        break;
      }
      const code = isLabel(step.refused) ? step.refused : "badAnswer";
      refused += 1;
      if (ORDERED_RANKS.includes(rankOf(row.rank))) {
        // It holds its rank: what was queued after it in this rank waits for it.
        this.hold(row, code);
        holding.add(row.rank);
      } else {
        this.tried(row.seq, code);
      }
    }
    return { written, refused, left: this.size() };
  }

  /**
   * The core took the write: it leaves the queue and its key is kept. A write queued again with a new box while it was being
   * sent stays, to be sent again with that box. A rank a refusal held is let go once none of its writes is left, so every
   * one of them was written, in order.
   */
  private done(row: QueueRow): void {
    this.host.storage.transactionSync(() => {
      const now = this.sql
        .exec<{ box: string }>("SELECT box FROM return_queue WHERE seq = ?", row.seq)
        .toArray()[0];
      if (now !== undefined && now.box !== row.box) {
        this.sql.exec("UPDATE return_queue SET tries = tries + 1 WHERE seq = ?", row.seq);
        return;
      }
      this.sql.exec("DELETE FROM return_queue WHERE seq = ?", row.seq);
      this.sql.exec(
        "INSERT OR IGNORE INTO return_done (key, done_ms) VALUES (?, ?)",
        row.key,
        this.host.now(),
      );
      if (
        this.sql.exec("SELECT 1 FROM return_queue WHERE rank = ? LIMIT 1", row.rank).toArray().length === 0
      ) {
        this.sql.exec("DELETE FROM return_held WHERE rank = ?", row.rank);
      }
    });
  }

  /**
   * A refusal in an ordered rank: the write is kept with its code, and its rank is marked held (since the first refusal)
   * until every write of the rank has been written.
   */
  private hold(row: QueueRow, code: string): void {
    this.host.storage.transactionSync(() => {
      this.tried(row.seq, code);
      this.sql.exec(
        `INSERT INTO return_held (rank, key, code, since_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT (rank) DO UPDATE SET key = excluded.key, code = excluded.code`,
        row.rank,
        row.key,
        code,
        this.host.now(),
      );
    });
  }

  private tried(seq: number, refusedCode: string | null): void {
    this.sql.exec("UPDATE return_queue SET tries = tries + 1, refused = ? WHERE seq = ?", refusedCode, seq);
  }
}
