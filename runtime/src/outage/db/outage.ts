// PostgreSQL down (T-270; C-175; S12-11, S12-12; arch 11 'PostgreSQL down', architecture.txt line 566: "Turns queue in
// order in each handle's actor, which keeps the stopped flag. A text waiting 20 s gets the outage line once (DD). ... Safety
// and STOP lines go from the actor and are written on return; a running safety timer fires from the actor's copy of its due
// time, address and emergency contact. On return: danger, stops, then the rest.").
//
// What the handle actor does, from its own storage and its copies (T-269, ../../actor/copies), while PostgreSQL does not
// answer. PostgreSQL is asked (`DbOutageDeps.probe`) only when something waits on it: a text that has waited 20 s with no
// commit, a STOP or a START, a safety timer due, and every 30 s while it is known down (T-271's RETRY_MS cadence).
//
//   1. Turns queue in order. While PostgreSQL is known down, no closed batch goes to the lease (`handOff` keeps it with the
//      batch window, in order), and the lease holds a leased turn as it is: a lapse is no crash, so no try is counted and
//      nothing is parked (../../actor/lease.ts `held`).
//   2. A text waiting 20 s gets the outage line once (K-01 fixed line `outage`, from the actor's copy of the checked lines),
//      straight through Linq under the safety read's own idempotency key for that text (`safety:<event id>:outage`), so a
//      text the safety read's timeout rule gave the line already gets no second one, and Linq keeps one if both ask. Never
//      to a stopped number: not while the actor's copy says stopped, nor while a STOP or START of the handle is not taken,
//      nor while a text of it cannot be read (it may be a stop word: fails closed). Its record waits for the return in the
//      write-on-return queue (rank rest) as T-271's request for the text (`outageLineRequest`: request id
//      `safety:<event id>`, so K-09 writes one row per text whichever path asks), with `sentByActor`, under the safety
//      read's own queue key (`sendFixedLine:<event id>`), whose replay writes it (runtime/src/safety `replayOnReturn`).
//   3. A STOP or a START (the pinned bundle's keyword list, as the actor copied it) still in the batch window is taken by
//      the actor at once: the stopped flag copied first (a STOP: stopped; a START: not), its reply straight through Linq
//      (K-01 `stopReply` or `startReply` as the bundle writes it, or Q-01's drafted words while Jay's wait; a stop reply
//      past the opt-out, as limit 8 sends one), and its record queued for the return (rank stop): K-09 recordStopOrStart,
//      caller actorOnReturn, with `sentByActor` (start-recorded.json). It never joins a turn afterwards, so its record and
//      reply land once. A STOP or START that went to the lease before the outage was known stays its turn's, and so does
//      every later one (and while one is not taken, the copy's reading is the stricter one), so no newer word is ever
//      written ahead of an older one (DL-167; DL-193).
//   4. A running safety timer whose due time passes while PostgreSQL is down fires from the actor's copy, once per timer row
//      version (`TimerFirePort`, with the copy as it is: the address still sealed); one due while PostgreSQL answers is
//      left to the core's clock row. The danger line itself is the safety read's (runtime/src/safety, T-246): with the core
//      not answering it goes straight through Linq within its 5 s, and its record waits in the danger rank.
//   5. On return (PostgreSQL answers again): the write-on-return queue is replayed first, danger, then stops, then the rest,
//      each once (../../actor/copies/return-queue.ts); only once no danger or stop write waits for the core does the lease
//      resume and the batch window hand the queued batches on, in order. So the danger and stop records of every queued
//      turn land before any queued turn's commit. Before any commit, too, the queue goes first (`beforeCommit`; QUESTIONS.md
//      CQ-104 (f)).
//
// Q-45's default: nothing here backs up Cloudflare itself being down. Not here: "booking is paused" for AIs and the booking
// page (K-09 shared core, C-110; the platform-status actor, T-607 and T-608). Unwired (no `setDbOutageDeps`), nothing here
// runs and every batch goes on as before. Never logged or put in a span: a text's words, a number, an address, a key.

import { scheduleEntry, unscheduleEntry, type ClosedBatch } from "../../actor/batch";
import type { ActorCopies } from "../../actor/copies/copies";
import type {
  Enqueued,
  QueuedEntry,
  QueuedWrite,
  ReplayReport,
  ReplayStep,
  ReturnRank,
  ReturnWrite,
} from "../../actor/copies/return-queue";
import type { KeywordCopy, SafetyTimerCopy } from "../../actor/copies/types";
import type { InboxEntry } from "../../actor/inbox";
import {
  actorNameOf,
  openWords,
  sealWords,
  type HandleRef,
  type SealedWords,
  type SealingKey,
} from "../../gateway/seal";
import type { SealedEvent } from "../../gateway/types";
import { keyOf, keywordOf } from "../../guard/keywords";
import { START_REPLY, STOP_REPLY, wordsFor } from "../../guard/replies/words";
import { isReadableEvent, type SafetyEntry } from "../../safety/arrival";
import type { HandleIds, SentByActor } from "../../safety/types";
import { isLabel } from "../../trace";
import { OUTAGE_LINE_ID, outageLineRequest, RETRY_MS } from "../ai/outage";
import type {
  DbOutageDeps,
  KeywordState,
  LineState,
  OutageView,
  StopOrStartOnReturn,
  TextKind,
} from "./types";

/** "A text waiting 20 s gets the outage line once (DD)" (arch 11 line 566). */
export const OUTAGE_WAIT_MS = 20_000;
/** While PostgreSQL is known down it is asked again every 30 s: arch 11 line 564's cadence (T-271's RETRY_MS). */
export const PROBE_MS = RETRY_MS;
/**
 * A send through Linq that failed (a reply, the outage line), or a record not queued yet, is tried again 5 s on. No source
 * gives it; 5 s is the safety line's budget (arch 04's latency table).
 */
export const SEND_RETRY_MS = 5_000;
/** A safety timer's alerts that could not go are tried again 5 s on ("Safety timers never wait": RULES 5.7). */
export const TIMER_RETRY_MS = 5_000;
/** The down path's kind in the actor's stored schedule (../../actor/batch.ts). */
export const SCHEDULE_DB_OUTAGE = "dbOutage";
/** The K-09 call a STOP or a START taken by the actor is written on return as. */
export const STOP_OR_START_CALL = "recordStopOrStart";

let deps: DbOutageDeps | null = null;

/** Sets what the PostgreSQL-down path reaches for this Worker isolate; returns the function that puts the earlier one back. */
export function setDbOutageDeps(next: DbOutageDeps | null): () => void {
  const before = deps;
  deps = next;
  return () => {
    deps = before;
  };
}

/** What the handle actor gives the down path (handle-actor.ts). */
export interface DbOutageHost {
  readonly storage: DurableObjectStorage;
  /** The actor's clock (the stored schedule's). */
  now(): number;
  /** The actor's own copies (T-269): the stopped flag, the checked lines, the keyword list, the live safety timers. */
  readonly copies: Pick<
    ActorCopies,
    "readStopped" | "noteStopped" | "readLines" | "readKeywords" | "readTimers"
  >;
  /** The actor's write-on-return queue. */
  readonly returns: {
    enqueue(write: ReturnWrite): Enqueued;
    read(): QueuedEntry[];
    size(): number;
  };
  /** Replays the write-on-return queue through the actor's senders: danger, then stops, then the rest, each once. */
  replay(): Promise<ReplayReport>;
  /** The stored texts with these event ids, sealed, in arrival order (the actor's inbox). */
  texts(eventIds: readonly string[]): InboxEntry[];
  /** The texts no commit has taken yet: still with the batch window, and with the lease (in arrival order). */
  pending(): { readonly window: readonly string[]; readonly lease: readonly string[] };
  /** A text's safety state (the safety read's): whether its timeout rule gave it the outage line. */
  safetyEntry(eventId: string): SafetyEntry | undefined;
  /** PostgreSQL is back: lends the lease's resume and the batch window's hand-off of the queued batches, in order. */
  resume(): void;
  /** Lends the batch window's hand-off of the batches kept back. */
  release(): void;
  /** Sets the actor's one alarm to the earliest entry of the stored schedule. */
  arm(): Promise<void>;
  /** Keeps work alive past the call that started it (the actor's waitUntil). */
  lend(work: Promise<void>): void;
}

interface TextRow extends Record<string, SqlStorageValue> {
  event_id: string;
  seq: number;
  due_ms: number;
  kind: string | null;
  keyword: string | null;
  sent: string | null;
  kept: number;
  line: string | null;
}

interface StateRow extends Record<string, SqlStorageValue> {
  since_ms: number;
  probe_ms: number;
}

interface TimerRow extends Record<string, SqlStorageValue> {
  timer_id: string;
  version: number;
  fired: string | null;
  retry_ms: number | null;
}

interface IdsRow extends Record<string, SqlStorageValue> {
  handle_id: string;
  business_id: string | null;
  person_id: string | null;
}

export function createOutageTables(sql: SqlStorage): void {
  // Since when PostgreSQL is known down, and when it is asked again: one row at most, none while it is not known down.
  sql.exec(
    `CREATE TABLE IF NOT EXISTS outage_state (
       one INTEGER PRIMARY KEY CHECK (one = 1),
       since_ms INTEGER NOT NULL,
       probe_ms INTEGER NOT NULL
     )`,
  );
  // Each text the path follows until a commit takes it: labels, times and Linq's ids only, never its words or number.
  sql.exec(
    `CREATE TABLE IF NOT EXISTS outage_texts (
       event_id TEXT PRIMARY KEY,
       seq INTEGER NOT NULL,
       due_ms INTEGER NOT NULL,
       kind TEXT,
       keyword TEXT,
       sent TEXT,
       kept INTEGER NOT NULL DEFAULT 0,
       line TEXT
     )`,
  );
  // Each safety timer row version that fell due while the path watched it: fired from the copy, or left to the core.
  sql.exec(
    `CREATE TABLE IF NOT EXISTS outage_timers (
       timer_id TEXT NOT NULL,
       version INTEGER NOT NULL,
       fired TEXT,
       retry_ms INTEGER,
       PRIMARY KEY (timer_id, version)
     )`,
  );
  // The handle's K-04 ids, as the directory last gave them: the outage line's record names them while PostgreSQL is down.
  sql.exec(
    `CREATE TABLE IF NOT EXISTS outage_ids (
       one INTEGER PRIMARY KEY CHECK (one = 1),
       handle_id TEXT NOT NULL,
       business_id TEXT,
       person_id TEXT
     )`,
  );
  sql.exec("CREATE TABLE IF NOT EXISTS outage_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isKeyword = (kind: string | null): kind is "stop" | "start" => kind === "stop" || kind === "start";

/** A text the hand-off waits for: not read yet, or a STOP or START the actor has not decided on, or is taking now. */
const undecided = (row: TextRow): boolean =>
  row.kind === null || (isKeyword(row.kind) && (row.keyword === null || row.keyword === "handling"));

function sentOf(text: string | null): SentByActor | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return null;
    const { at, fixedLineId, linqMessageId } = value;
    if (typeof at !== "string" || typeof fixedLineId !== "string" || typeof linqMessageId !== "string")
      return null;
    return { at, fixedLineId, linqMessageId };
  } catch {
    return null;
  }
}

export class DbOutage {
  /** The path's work in this instance, one check at a time: the next waits for the one before it. */
  private work: Promise<void> = Promise.resolve();
  /** True while a check is queued and has not begun: a second call adds none. */
  private queued = false;
  /** A batch was kept back for a text not read yet or a STOP or START not decided: it is handed on after the next check. */
  private keptBack = false;

  constructor(private readonly host: DbOutageHost) {
    createOutageTables(host.storage.sql);
  }

  private get sql(): SqlStorage {
    return this.host.storage.sql;
  }

  // ---- the actor's calls ------------------------------------------------------------------------------------------

  /**
   * A text was stored (the kinds the safety read reads): it is followed until a commit takes it, read for a STOP or a START
   * at once, and looked at again 20 s on. Nothing while unwired.
   */
  arrive(event: SealedEvent, seq: number): void {
    if (deps === null || !isReadableEvent(event)) return;
    try {
      this.sql.exec(
        "INSERT OR REPLACE INTO outage_meta (k, v) VALUES ('actorName', ?)",
        actorNameOf(event.handle),
      );
      this.sql.exec(
        "INSERT OR IGNORE INTO outage_texts (event_id, seq, due_ms) VALUES (?, ?, ?)",
        event.eventId,
        seq,
        this.host.now() + OUTAGE_WAIT_MS,
      );
    } catch {
      return;
    }
    this.kick();
  }

  /** The actor's alarm: when the path's entry is due, it is moved on and a check runs (it sets the entry again). */
  wake(): void {
    try {
      const entry = this.sql
        .exec<{ due_ms: number }>("SELECT due_ms FROM batch_schedule WHERE kind = ?", SCHEDULE_DB_OUTAGE)
        .toArray()[0];
      if (entry === undefined || entry.due_ms > this.host.now()) return;
      if (deps === null) {
        unscheduleEntry(this.sql, SCHEDULE_DB_OUTAGE);
        return;
      }
      // Moved on first, so the alarm armed before the check ends does not come straight back for it.
      scheduleEntry(this.sql, SCHEDULE_DB_OUTAGE, this.host.now() + PROBE_MS);
    } catch {
      return;
    }
    this.kick();
  }

  /**
   * True while a STOP of the handle that no commit has taken waits with the batch window or the lease, not taken by the
   * actor (left to its turn, or not decided yet): the number asked to stop, so the safety read's own outage line (its
   * timeout rule) never goes to it either. A storage that cannot say answers true (fails closed). False while unwired.
   */
  stopPending(): boolean {
    if (deps === null) return false;
    try {
      const pending = this.host.pending();
      const waiting = new Set([...pending.window, ...pending.lease]);
      return this.rows().some(
        (row) => waiting.has(row.event_id) && row.kind === "stop" && row.keyword !== "handled",
      );
    } catch {
      return true;
    }
  }

  /** True while PostgreSQL is known down: the lease holds its turn, and closed batches stay with the batch window. */
  isDown(): boolean {
    if (deps === null) return false;
    try {
      return this.stateRow() !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * The batch window's hand-off of a closed batch: null keeps it back (PostgreSQL is known down, or one of its texts is not
   * read yet, or is a STOP or a START not decided on); otherwise the batch without the STOP and START texts the actor took
   * (their records wait in the queue; they never join a turn).
   */
  handOff(batch: ClosedBatch): ClosedBatch | null {
    if (deps === null) return batch;
    try {
      if (this.stateRow() !== undefined) return null;
      const rows = this.rowsOf(batch.entries.map((entry) => entry.event.eventId));
      if (rows.some(undecided)) {
        this.keptBack = true;
        this.kick();
        return null;
      }
      const taken = new Set(rows.filter((row) => row.keyword === "handled").map((row) => row.event_id));
      if (taken.size === 0) return batch;
      return { ...batch, entries: batch.entries.filter((entry) => !taken.has(entry.event.eventId)) };
    } catch {
      return batch;
    }
  }

  /**
   * Before a commit is sent (QUESTIONS.md CQ-104 (f)): the write-on-return queue is replayed first; false while a danger or
   * stop write still waits for the core, and the commit is then not sent.
   */
  async beforeCommit(): Promise<boolean> {
    if (this.host.returns.size() === 0) return true;
    await this.host.replay();
    return !this.ranksWaiting();
  }

  /**
   * Sends one queued STOP or START record when the queue replays it (K-09 recordStopOrStart, caller actorOnReturn): taken,
   * the actor's copy of the stopped flag takes the phone row's version; the core not answering (a throw, `transient`, or the
   * handle's key not to be had) is `notBack`; any other error is the core's refusal (its code, a label). A box that does not
   * open is refused as `unopened`.
   */
  async replayStopOrStart(write: QueuedWrite): Promise<ReplayStep> {
    const set = deps;
    if (set === null) return "notBack";
    const prefix = `${STOP_OR_START_CALL}:`;
    if (write.call !== STOP_OR_START_CALL || !write.key.startsWith(prefix))
      return { refused: "notStopOrStart" };
    const entry = this.host.texts([write.key.slice(prefix.length)])[0];
    if (entry === undefined) return { refused: "unopened" };
    const handle = entry.event.handle;
    let sealingKey: SealingKey;
    try {
      sealingKey = await set.keys.getOrCreateKey(handle);
    } catch {
      return "notBack";
    }
    let request: StopOrStartOnReturn;
    try {
      const opened = await openWords(
        JSON.parse(write.box) as Parameters<typeof openWords>[0],
        sealingKey,
        actorNameOf(handle),
        `return:${write.key}`,
      );
      request = JSON.parse(opened.body ?? "null") as StopOrStartOnReturn;
    } catch {
      return { refused: "unopened" };
    }
    let answer: unknown;
    try {
      answer = await set.core.recordStopOrStart(request);
    } catch {
      return "notBack";
    }
    if (isRecord(answer) && typeof answer.error === "string") {
      return answer.error === "transient" ? "notBack" : { refused: answer.error };
    }
    const version = isRecord(answer) ? answer.phoneVersion : undefined;
    if (!isRecord(answer) || typeof answer.stopped !== "boolean" || !Number.isInteger(version)) {
      return { refused: "badAnswer" };
    }
    this.host.copies.noteStopped({ stopped: answer.stopped, phoneVersion: version as number, turnId: null });
    return "written";
  }

  /** The copy's safety timers changed (a reload after a commit): the alarm follows the earliest one due. */
  timersChanged(): void {
    this.host.lend(this.sync());
  }

  /** The path's state, as labels and times only (tests, the team console). */
  read(): OutageView {
    const state = this.stateRow();
    return {
      down: state === undefined ? null : { since: state.since_ms, nextProbe: state.probe_ms },
      texts: this.rows().map((row) => ({
        eventId: row.event_id,
        kind: row.kind as TextKind | null,
        keyword: row.keyword as KeywordState | null,
        line: row.line as LineState | null,
        dueAt: row.due_ms,
      })),
      timers: this.sql
        .exec<TimerRow>(
          "SELECT timer_id, version, fired, retry_ms FROM outage_timers ORDER BY timer_id, version",
        )
        .toArray()
        .map((row) => ({
          timerId: row.timer_id,
          version: row.version,
          fired: row.fired === "copy" || row.fired === "core" ? row.fired : null,
        })),
    };
  }

  /** Resolves when the path's work started so far is done (tests). */
  async idle(): Promise<void> {
    for (;;) {
      const at = this.work;
      await at;
      if (at === this.work) return;
    }
  }

  // ---- one check --------------------------------------------------------------------------------------------------

  /** Queues a check behind the one running, unless one is queued already; the check sets the alarm when it ends. */
  private kick(): void {
    if (this.queued) return;
    this.queued = true;
    const run = this.work.then(async () => {
      this.queued = false;
      try {
        await this.check();
      } catch {
        // The stored rows say what is left: the alarm comes back for it.
      }
      await this.sync();
    });
    this.work = run.catch(() => undefined);
    this.host.lend(this.work);
  }

  /**
   * Reads each new text, then, when something waits on PostgreSQL (a text waiting 20 s, a STOP or START, a timer due, a
   * write queued for the core, or the known outage), asks whether it answers, unless it is known down until its next ask.
   * Down: the timers due fire from the copy, the STOPs and STARTs are taken, the waiting texts get the outage line. Up: the
   * write-on-return queue replays, the lease resumes and the batches kept back go on.
   */
  private async check(): Promise<void> {
    const set = deps;
    if (set === null) return;
    await this.classify(set);
    const now = this.host.now();
    this.prune();
    const state = this.stateRow();
    const timers = this.dueTimers(now);
    const texts = this.dueTexts(now);
    const deciding = this.rows().filter((row) => isKeyword(row.kind) && row.keyword === null);
    const waiting = this.host.returns.read().some((entry) => entry.refused === null);
    const needed =
      state !== undefined ||
      timers.length > 0 ||
      texts.length > 0 ||
      deciding.length > 0 ||
      waiting ||
      this.keepsDue(now);
    if (!needed) {
      this.releaseKept();
      return;
    }
    const knownDown = state !== undefined && state.probe_ms > now;
    const down = knownDown || !(await this.answering(set));
    if (down) {
      this.sql.exec(
        "INSERT OR REPLACE INTO outage_state (one, since_ms, probe_ms) VALUES (1, ?, ?)",
        state?.since_ms ?? now,
        knownDown ? state.probe_ms : now + PROBE_MS,
      );
      // Safety first: a timer due fires from its copy before anything else goes.
      await this.fireTimers(set, timers, now);
      await this.takeKeywords(set, true);
      await this.sendLines(set);
      await this.keepLines(set);
      return;
    }
    for (const timer of timers) this.decideTimer(timer, "core", null);
    // PostgreSQL answers: a STOP or START not taken goes to its turn, as any text does.
    for (const row of deciding) this.setKeyword(row.event_id, "left");
    await this.takeKeywords(set, false);
    for (const row of texts) this.setDue(row.event_id, now + PROBE_MS);
    await this.keepLines(set);
    if (state !== undefined || waiting) await this.returnNow(now);
    this.releaseKept();
  }

  /**
   * PostgreSQL answers again: the queue is replayed (danger, stops, then the rest). While a danger or stop write still
   * waits for the core, it is known down still and asked again in 30 s; otherwise the lease resumes and the queued batches
   * go on, in order.
   */
  private async returnNow(now: number): Promise<void> {
    try {
      await this.host.replay();
    } catch {
      // Counted below: what waits is still queued.
    }
    if (this.ranksWaiting()) {
      this.sql.exec(
        "INSERT OR REPLACE INTO outage_state (one, since_ms, probe_ms) VALUES (1, COALESCE((SELECT since_ms FROM outage_state WHERE one = 1), ?), ?)",
        now,
        now + PROBE_MS,
      );
      return;
    }
    const wasDown = this.stateRow() !== undefined;
    this.sql.exec("DELETE FROM outage_state WHERE one = 1");
    if (wasDown) {
      this.keptBack = false;
      this.host.resume();
    }
  }

  /** True while a danger or stop write waits for the core (not refused: the core has not answered for it yet). */
  private ranksWaiting(): boolean {
    return this.host.returns
      .read()
      .some((entry) => (entry.rank === "danger" || entry.rank === "stop") && entry.refused === null);
  }

  private releaseKept(): void {
    if (!this.keptBack) return;
    this.keptBack = false;
    this.host.release();
  }

  private async answering(set: DbOutageDeps): Promise<boolean> {
    try {
      return await set.probe();
    } catch {
      return false;
    }
  }

  // ---- reading a text ---------------------------------------------------------------------------------------------

  /**
   * Reads each new text against the actor's copy of the keyword list: a STOP, a START, any other text, or `unknown` when
   * there is no copy or its words cannot be opened (it may be a stop word: the stricter reading holds while it waits).
   */
  private async classify(set: DbOutageDeps): Promise<void> {
    const ids = this.sql
      .exec<{ event_id: string }>("SELECT event_id FROM outage_texts WHERE kind IS NULL ORDER BY seq")
      .toArray()
      .map((row) => row.event_id);
    if (ids.length === 0) return;
    const copy = this.keywordCopy();
    const entries = new Map(this.host.texts(ids).map((entry) => [entry.event.eventId, entry]));
    for (const eventId of ids) {
      const entry = entries.get(eventId);
      let kind: TextKind = "unknown";
      if (entry !== undefined && copy !== null) {
        try {
          const words = await this.open(set, entry);
          const keyword = keywordOf({ eventId, kind: entry.event.kind, words }, copy.list);
          kind = keyword?.kind === "stop" ? "stop" : keyword?.kind === "start" ? "start" : "other";
        } catch {
          kind = "unknown";
        }
      }
      this.sql.exec("UPDATE outage_texts SET kind = ? WHERE event_id = ? AND kind IS NULL", kind, eventId);
    }
  }

  /** A stored text's words, opened with the handle's key (never logged); null for a text with none. */
  private async open(set: DbOutageDeps, entry: InboxEntry): Promise<SealedWords | null> {
    const sealed = entry.event.sealed;
    if (sealed === null) return null;
    const key = await set.keys.getOrCreateKey(entry.event.handle);
    return openWords(sealed, key, actorNameOf(entry.event.handle), entry.event.eventId);
  }

  private keywordCopy(): KeywordCopy | null {
    try {
      return this.host.copies.readKeywords();
    } catch {
      return null;
    }
  }

  // ---- STOP and START ---------------------------------------------------------------------------------------------

  /**
   * Takes each STOP and START still in the batch window, in arrival order (`take`: only while PostgreSQL is down), and
   * finishes each one taken before (its reply, then its record). So that the actor never writes a newer word ahead of an
   * older one: a STOP or START with the lease, after one left to its turn, after a text that cannot be read, or from a
   * handle with no number is left to its turn; and one after a STOP or START taken but not finished (its reply or record
   * tried again later) waits for it, undecided, so the records reach the queue in arrival order.
   */
  private async takeKeywords(set: DbOutageDeps, take: boolean): Promise<void> {
    const pending = this.host.pending();
    const window = new Set(pending.window);
    const withLease = new Set(pending.lease);
    let leftBefore = false;
    let unfinishedBefore = false;
    for (const row of this.rows()) {
      if (row.kind === null || row.kind === "unknown") {
        leftBefore = true;
        continue;
      }
      if (!isKeyword(row.kind) || row.keyword === "handled") continue;
      if (row.keyword === "left") {
        leftBefore = true;
        continue;
      }
      if (row.keyword === null) {
        if (!take || unfinishedBefore) continue;
        const entry = this.host.texts([row.event_id])[0];
        if (
          leftBefore ||
          entry?.event.handle.kind !== "phone" ||
          !window.has(row.event_id) ||
          withLease.has(row.event_id)
        ) {
          this.setKeyword(row.event_id, "left");
          leftBefore = true;
          continue;
        }
        // Taken: the stopped flag first, so nothing goes to a number that asked to stop from here on.
        this.host.copies.noteStopped({ stopped: row.kind === "stop", phoneVersion: null, turnId: null });
        this.sql.exec(
          "UPDATE outage_texts SET keyword = 'handling', due_ms = ? WHERE event_id = ?",
          this.host.now(),
          row.event_id,
        );
      } else if (unfinishedBefore || row.due_ms > this.host.now()) {
        // Taken before, its reply or record not done yet and tried again later: nothing after it goes ahead of it.
        unfinishedBefore = true;
        continue;
      }
      if (!(await this.reply(set, row.event_id, row.kind))) unfinishedBefore = true;
    }
  }

  /**
   * A STOP's or START's reply straight through Linq (once: its Linq id is kept), then its record queued for the return
   * (rank stop). Either failing is tried again 5 s on; true once both are done (`handled`).
   */
  private async reply(set: DbOutageDeps, eventId: string, kind: "stop" | "start"): Promise<boolean> {
    const now = this.host.now();
    const row = this.rowsOf([eventId])[0];
    const entry = this.host.texts([eventId])[0];
    const copy = this.keywordCopy();
    const words =
      copy === null ? null : wordsFor(kind === "stop" ? STOP_REPLY : START_REPLY, copy.replies, "");
    if (row === undefined || entry === undefined || copy === null || words === null) {
      this.setDue(eventId, now + SEND_RETRY_MS);
      return false;
    }
    const handle = entry.event.handle;
    let sent = sentOf(row.sent);
    if (sent === null) {
      try {
        const answer = await set.direct.send({
          actorName: actorNameOf(handle),
          fixedLineId: words.lineId,
          text: words.text,
          // The stop reply goes past the opt-out, as limit 8 lets it (arch 10 line 524); the start reply needs none.
          overrideOptout: kind === "stop",
          idempotencyKey: `keyword:${eventId}:${words.lineId}`,
        });
        sent = {
          at: new Date(this.host.now()).toISOString(),
          fixedLineId: words.lineId,
          linqMessageId: answer.linqMessageId,
        };
      } catch {
        this.setDue(eventId, now + SEND_RETRY_MS);
        return false;
      }
      this.sql.exec("UPDATE outage_texts SET sent = ? WHERE event_id = ?", JSON.stringify(sent), eventId);
    }
    try {
      const typed = await this.typed(set, entry, copy, kind);
      const ids = await this.idsNow(set, actorNameOf(handle));
      const request: StopOrStartOnReturn = {
        caller: {
          kind: "actorOnReturn",
          turnId: null,
          requestId: eventId,
          businessId: null,
          personId: ids?.personId ?? null,
          traceId: entry.traceId,
        },
        kind,
        phoneNumber: handle.address,
        inboundEventId: eventId,
        words: typed.words,
        alsoCancelVisit: typed.flagsVisit,
        workPhoneBusinessIds: null,
        sentByActor: sent,
      };
      await this.keep(set, handle, `${STOP_OR_START_CALL}:${eventId}`, STOP_OR_START_CALL, "stop", request);
    } catch {
      this.setDue(eventId, now + SEND_RETRY_MS);
      return false;
    }
    this.sql.exec("UPDATE outage_texts SET keyword = 'handled', kept = 1 WHERE event_id = ?", eventId);
    return true;
  }

  /** The person's own words as the guard reads them (T-267's form), and whether the word flags the visit. Never logged. */
  private async typed(
    set: DbOutageDeps,
    entry: InboxEntry,
    copy: KeywordCopy,
    kind: "stop" | "start",
  ): Promise<{ words: string; flagsVisit: boolean }> {
    const words = await this.open(set, entry);
    const keyword = keywordOf({ eventId: entry.event.eventId, kind: entry.event.kind, words }, copy.list);
    const body = words?.body ?? "";
    const read = keyOf(body) === "" ? (words?.subject ?? "") : body;
    const fallback = keyword?.word ?? kind.toUpperCase();
    return { words: keyOf(read) === "" ? fallback : read, flagsVisit: keyword?.flagsVisit === true };
  }

  // ---- the outage line --------------------------------------------------------------------------------------------

  /**
   * The outage line, once, to each text waiting 20 s, never to a stopped number; a text the safety read's timeout rule
   * gave it already gets none. A send that fails is tried again 5 s on.
   */
  private async sendLines(set: DbOutageDeps): Promise<void> {
    const now = this.host.now();
    const due = this.dueTexts(now);
    if (due.length === 0) return;
    if (this.stoppedNow()) {
      for (const row of due) this.setLine(row.event_id, "stopped");
      return;
    }
    const line = this.outageLine();
    const entries = new Map(this.host.texts(due.map((row) => row.event_id)).map((e) => [e.event.eventId, e]));
    for (const row of due) {
      if (this.lineWent(row.event_id)) {
        this.setLine(row.event_id, "went");
        continue;
      }
      const entry = entries.get(row.event_id);
      if (line === null || entry === undefined) {
        // No line copied yet (the next written text copies it), or the text is not stored: looked at again later.
        this.setDue(row.event_id, now + SEND_RETRY_MS);
        continue;
      }
      let sent: SentByActor;
      try {
        const answer = await set.direct.send({
          actorName: actorNameOf(entry.event.handle),
          fixedLineId: line.lineId,
          text: line.text,
          overrideOptout: false,
          // The safety read's own key for this text's line: Linq sends one, whichever path asks.
          idempotencyKey: `safety:${row.event_id}:${line.lineId}`,
        });
        sent = {
          at: new Date(this.host.now()).toISOString(),
          fixedLineId: line.lineId,
          linqMessageId: answer.linqMessageId,
        };
      } catch {
        this.setDue(row.event_id, now + SEND_RETRY_MS);
        continue;
      }
      this.sql.exec(
        "UPDATE outage_texts SET line = 'sent', sent = ?, due_ms = ? WHERE event_id = ?",
        JSON.stringify(sent),
        now,
        row.event_id,
      );
    }
  }

  /**
   * Queues each outage line's record for the return (rank rest): T-271's request for the text with `sentByActor`, under the
   * safety read's own key for it, so its replay writes one row per text. Without the handle's K-04 ids (the directory not
   * answering and none copied yet), or with the key store failing, it is tried again 5 s on.
   */
  private async keepLines(set: DbOutageDeps): Promise<void> {
    const now = this.host.now();
    const rows = this.rows().filter((row) => row.line === "sent" && row.kept === 0 && row.due_ms <= now);
    if (rows.length === 0) return;
    const entries = new Map(
      this.host.texts(rows.map((row) => row.event_id)).map((e) => [e.event.eventId, e]),
    );
    for (const row of rows) {
      const entry = entries.get(row.event_id);
      const sent = sentOf(row.sent);
      if (entry === undefined || sent === null) {
        this.sql.exec("UPDATE outage_texts SET kept = 1 WHERE event_id = ?", row.event_id);
        continue;
      }
      const actorName = actorNameOf(entry.event.handle);
      try {
        const ids = await this.idsNow(set, actorName);
        if (ids === null) throw new Error("noIds");
        const waiting = {
          actorName,
          handleId: ids.handleId,
          businessId: ids.businessId,
          personId: ids.personId,
          texts: [],
          stopAsked: false,
        };
        const text = { eventId: row.event_id, traceId: entry.traceId, lined: false };
        const request = { ...outageLineRequest(waiting, text), sentByActor: sent };
        await this.keep(
          set,
          entry.event.handle,
          `sendFixedLine:${row.event_id}`,
          "sendFixedLine",
          "rest",
          request,
        );
      } catch {
        this.setDue(row.event_id, now + SEND_RETRY_MS);
        continue;
      }
      this.sql.exec("UPDATE outage_texts SET kept = 1 WHERE event_id = ?", row.event_id);
    }
  }

  /**
   * Never to a stopped number: true while the actor's copy says stopped (or cannot be read), and while any text no commit
   * has taken is a STOP or START the actor has not finished, or a text it cannot read (it may be a stop word).
   */
  private stoppedNow(): boolean {
    try {
      if (this.host.copies.readStopped()?.stopped === true) return true;
    } catch {
      return true;
    }
    return this.rows().some(
      (row) =>
        row.kind === null || row.kind === "unknown" || (isKeyword(row.kind) && row.keyword !== "handled"),
    );
  }

  /** The outage line as the actor copied it (K-01 fixed line `outage`), or null when none was copied. */
  private outageLine(): { lineId: string; text: string } | null {
    try {
      const copied = this.host.copies.readLines().find((line) => line.slot === `fixed:${OUTAGE_LINE_ID}`);
      return copied === undefined ? null : { lineId: copied.lineId, text: copied.text };
    } catch {
      return null;
    }
  }

  /** True when the safety read's timeout rule gave this text the outage line (its outbox row, or straight through Linq). */
  private lineWent(eventId: string): boolean {
    const entry = this.host.safetyEntry(eventId);
    return entry?.lineId === OUTAGE_LINE_ID && (entry.path === "outbox" || entry.path === "outage");
  }

  // ---- the safety timers ------------------------------------------------------------------------------------------

  /** The copy's running timers whose due time has passed and that were neither fired nor left to the core. */
  private dueTimers(now: number): SafetyTimerCopy[] {
    const seen = new Map(this.timerRows().map((row) => [`${row.timer_id}:${String(row.version)}`, row]));
    return this.copiedTimers().filter((timer) => {
      const due = Date.parse(timer.dueAt);
      if (timer.state !== "running" || !Number.isFinite(due) || due > now) return false;
      const row = seen.get(`${timer.timerId}:${String(timer.version)}`);
      return row === undefined || (row.fired === null && (row.retry_ms ?? 0) <= now);
    });
  }

  /** Fires each timer due from its copy, once per row version; one that cannot go is tried again 5 s on. */
  private async fireTimers(
    set: DbOutageDeps,
    timers: readonly SafetyTimerCopy[],
    now: number,
  ): Promise<void> {
    const actorName = this.actorName();
    for (const timer of timers) {
      if (actorName === null) {
        this.decideTimer(timer, null, now + TIMER_RETRY_MS);
        continue;
      }
      try {
        await set.timers.fireFromCopy({
          actorName,
          requestId: `timer:${timer.timerId}:${String(timer.version)}`,
          timer,
        });
      } catch {
        this.decideTimer(timer, null, this.host.now() + TIMER_RETRY_MS);
        continue;
      }
      this.decideTimer(timer, "copy", null);
    }
  }

  private decideTimer(timer: SafetyTimerCopy, fired: "copy" | "core" | null, retryMs: number | null): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO outage_timers (timer_id, version, fired, retry_ms) VALUES (?, ?, ?, ?)",
      timer.timerId,
      timer.version,
      fired,
      retryMs,
    );
  }

  private copiedTimers(): SafetyTimerCopy[] {
    try {
      return this.host.copies.readTimers();
    } catch {
      return [];
    }
  }

  private timerRows(): TimerRow[] {
    return this.sql.exec<TimerRow>("SELECT timer_id, version, fired, retry_ms FROM outage_timers").toArray();
  }

  // ---- what the return queue keeps --------------------------------------------------------------------------------

  /**
   * Queues a write for the return, sealed under the handle's key as the safety read seals its own (`return:<key>`), so the
   * same write queued twice keeps one place. The queue never opens it.
   */
  private async keep(
    set: DbOutageDeps,
    handle: HandleRef,
    key: string,
    call: string,
    rank: ReturnRank,
    request: object,
  ): Promise<void> {
    const sealingKey = await set.keys.getOrCreateKey(handle);
    const box = await sealWords(
      { body: JSON.stringify(request), subject: null },
      sealingKey,
      actorNameOf(handle),
      `return:${key}`,
    );
    this.host.returns.enqueue({ key, call, rank, box: JSON.stringify(box) });
  }

  /** The handle's K-04 ids: the directory's answer (copied), or the copy while it does not answer; null when neither. */
  private async idsNow(set: DbOutageDeps, actorName: string): Promise<HandleIds | null> {
    try {
      const ids = await set.directory.idsOf(actorName);
      if (ids !== null && isLabel(ids.handleId)) {
        this.sql.exec(
          "INSERT OR REPLACE INTO outage_ids (one, handle_id, business_id, person_id) VALUES (1, ?, ?, ?)",
          ids.handleId,
          ids.businessId,
          ids.personId,
        );
        return ids;
      }
    } catch {
      // PostgreSQL may be down: the copy answers.
    }
    const row = this.sql
      .exec<IdsRow>("SELECT handle_id, business_id, person_id FROM outage_ids WHERE one = 1")
      .toArray()[0];
    if (row === undefined) return null;
    return { handleId: row.handle_id, businessId: row.business_id, personId: row.person_id, bookingId: null };
  }

  // ---- the stored rows and the schedule ---------------------------------------------------------------------------

  private stateRow(): StateRow | undefined {
    return this.sql.exec<StateRow>("SELECT since_ms, probe_ms FROM outage_state WHERE one = 1").toArray()[0];
  }

  /** Every text followed, in arrival order. */
  private rows(): TextRow[] {
    return this.sql
      .exec<TextRow>(
        "SELECT event_id, seq, due_ms, kind, keyword, sent, kept, line FROM outage_texts ORDER BY seq",
      )
      .toArray();
  }

  private rowsOf(eventIds: readonly string[]): TextRow[] {
    if (eventIds.length === 0) return [];
    return this.sql
      .exec<TextRow>(
        `SELECT event_id, seq, due_ms, kind, keyword, sent, kept, line FROM outage_texts
         WHERE event_id IN (SELECT value FROM json_each(?)) ORDER BY seq`,
        JSON.stringify(eventIds),
      )
      .toArray();
  }

  /** The texts waiting 20 s or more for the outage line: any text but a STOP or START, read, with no line yet. */
  private dueTexts(now: number): TextRow[] {
    return this.rows().filter(
      (row) => row.kind !== null && !isKeyword(row.kind) && row.line === null && row.due_ms <= now,
    );
  }

  private keepsDue(now: number): boolean {
    return this.rows().some((row) => row.line === "sent" && row.kept === 0 && row.due_ms <= now);
  }

  /**
   * Drops the texts a commit has taken (no longer with the batch window or the lease), and the timers no longer copied.
   * A STOP or START being taken stays: the hand-off keeps its batch back until it is done.
   */
  private prune(): void {
    const pending = this.host.pending();
    const keep = new Set([...pending.window, ...pending.lease]);
    for (const row of this.rows()) {
      if (!keep.has(row.event_id) && row.keyword !== "handling") {
        this.sql.exec("DELETE FROM outage_texts WHERE event_id = ?", row.event_id);
      }
    }
    const copied = new Set(this.copiedTimers().map((timer) => `${timer.timerId}:${String(timer.version)}`));
    for (const row of this.timerRows()) {
      if (!copied.has(`${row.timer_id}:${String(row.version)}`)) {
        this.sql.exec(
          "DELETE FROM outage_timers WHERE timer_id = ? AND version = ?",
          row.timer_id,
          row.version,
        );
      }
    }
  }

  private setDue(eventId: string, dueMs: number): void {
    this.sql.exec("UPDATE outage_texts SET due_ms = ? WHERE event_id = ?", dueMs, eventId);
  }

  private setLine(eventId: string, line: LineState): void {
    this.sql.exec("UPDATE outage_texts SET line = ? WHERE event_id = ?", line, eventId);
  }

  private setKeyword(eventId: string, keyword: KeywordState): void {
    this.sql.exec("UPDATE outage_texts SET keyword = ? WHERE event_id = ?", keyword, eventId);
  }

  private actorName(): string | null {
    return (
      this.sql.exec<{ v: string }>("SELECT v FROM outage_meta WHERE k = 'actorName'").toArray()[0]?.v ?? null
    );
  }

  /**
   * When the path must look again: the next ask while known down, a text's 20 s (or its retry), a STOP or START being
   * taken, a record not queued yet, a timer's due time (or its retry). None when nothing waits.
   */
  private nextDue(): number | null {
    const dues: number[] = [];
    const state = this.stateRow();
    if (state !== undefined) dues.push(state.probe_ms);
    for (const row of this.rows()) {
      if (row.kind === null) dues.push(this.host.now());
      else if (isKeyword(row.kind)) {
        if (row.keyword === null || row.keyword === "handling") dues.push(row.due_ms);
      } else if (row.line === null || (row.line === "sent" && row.kept === 0)) dues.push(row.due_ms);
    }
    const seen = new Map(this.timerRows().map((row) => [`${row.timer_id}:${String(row.version)}`, row]));
    for (const timer of this.copiedTimers()) {
      const due = Date.parse(timer.dueAt);
      if (timer.state !== "running" || !Number.isFinite(due)) continue;
      const row = seen.get(`${timer.timerId}:${String(timer.version)}`);
      if (row === undefined) dues.push(due);
      else if (row.fired === null) dues.push(Math.max(due, row.retry_ms ?? 0));
    }
    return dues.length === 0 ? null : Math.min(...dues);
  }

  /** Keeps the path's entry of the stored schedule at its next due time, and sets the alarm. */
  private async sync(): Promise<void> {
    try {
      const next = deps === null ? null : this.nextDue();
      if (next === null) unscheduleEntry(this.sql, SCHEDULE_DB_OUTAGE);
      else scheduleEntry(this.sql, SCHEDULE_DB_OUTAGE, next);
      await this.host.arm();
    } catch {
      // The schedule stays as it was: the alarm comes back for it.
    }
  }
}
