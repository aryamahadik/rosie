// The safety read on arrival (T-246; C-047; steps A3-22, B3-17; arch 02 step S, line 111). For each raw text the handle
// actor stores, it:
//
//   1. starts the 4 s deadline in the same step as the arrival, and sends the words to the safety read port at once, in
//      arrival order, before any batch (a second text arriving during a read is read on its own);
//   2. on a verdict with danger, hands the outcome step's checked line to the send path first: with PostgreSQL up, K-09's
//      `recordSafetyOutcome` writes it as an outbox row of send class safety, which limit 8 lets past any opt-out
//      (NQ-RT-9's default); with it down, the actor sends it straight through Linq from the bundle's copy and writes the
//      record on return (arch 11 line 566), the record waiting in the actor's write-on-return queue (T-269);
//   3. on no verdict in 4 s (or a read that failed), a danger-word match from the bundle's list counts as Unsure and gets
//      the safety line (988 and 911 for self-harm words, else 911); otherwise the outage line, never to a stopped number;
//   4. keeps routine work held per the outcome (arch 06 lines 317 to 327) until a hold's rule releases it.
//
// The routine work this holds is the batch's (T-247) and the turn's. Holds bind commits, not hand-offs, once every text
// has been read (QUESTIONS.md CQ-65 as DL-119 replaced it): a text not read yet keeps its batch back (`unreadAmong`), and
// an outcome hold rides with the turn to its commit (`openHolds`), so a STOP inside a danger text still reaches its turn.
//
// A read cut off by the actor's eviction (a deploy or a reset mid-read: the 4 s deadline lived only in memory) is resumed
// by the next instance (T-1088, `resumeCutOff`): read again with the time left, or, past 4 s, given the timeout rule at
// once and read again for a late verdict, in arrival order. The actor's stored alarm makes sure that next instance comes.
//
// A text that took the timeout rule with no danger word (the outage line once, and its unread hold) is read again every
// 30 s until a verdict lands (T-1088 round 2, DL-127, `rereadDue`; arch 11 line 564: "The turn retries every 30 s"). Its
// next re-read is stored (`safety_reread`) and the actor keeps an alarm for it, so an eviction that loses the late answer
// awaited in memory cannot leave the text unread and held for good. An answer that is itself timedOut or failed is no
// verdict: the hold stays and the next re-read is set 30 s on. Only a verdict lifts an unread hold (with danger, the
// outcome's own hold takes its place). On return (a read gives a verdict again), every other text whose unread hold is
// open is read again at once, in arrival order: danger among them gets its line as its verdict lands, and the batches they
// kept back go on in order ("On return: danger first, then stops, then the rest in order").
//
// A danger outcome stays open until its line has gone (or none is needed) and its record is kept (T-1088 round 3, DL-132,
// `safety_pending`). It is noted in the step the danger is found, before the hold or any send, and cleared once the core
// has answered, or once the direct line and its record are kept. An eviction in between, or a line that fails, leaves the
// text scheduled as an unread hold's re-read is: a cut-off read whose verdict had found danger takes no timeout rule; the
// text is read again, and its danger verdict goes through the same send path with the same idempotency key, so the line
// goes once and its record is kept. Any other answer is not used (the first verdict stands), though a danger word still
// gets its line by the timeout rule. Only a text whose outcome is complete drops a later answer, and a hold written again
// for the same text is never looser than the open one.
//
// The danger's hold is written in that same step, before the core is called (T-1088 round 4, DL-144; the architect's
// round 3 gap A): from every outcome kept for the text, the strictest rule of them all (arch 06 line 327), in place of an
// unread hold; the core's hold then takes its place, never looser, and an eviction before the core answers leaves the text
// among the holds (a resume or a re-read writes it again if it is missing). Its row says danger from that step too (round
// 5, DL-146), even where the timeout rule's outage line had failed. So a danger text is always read: its batch goes on,
// and its hold binds the commit, where a STOP or a protecting change still commits (holds bind commits, not
// hand-offs: CQ-65, DL-119; T-305's hold rule). On return, only a text that no longer waits makes the others due at once,
// and only those still waiting for a verdict: a text whose danger's line or record is not done keeps its own 30 s re-read
// and makes nothing due (round 3 gap B), so two such texts never trigger each other's reads.
//
// This file keeps the hold's state and says so (`routineHeld`, `readSafety`, `unreadTexts`); it does not batch. Never
// logged or put in a span: a word, an evidence quote, a number.

import { openWords, sealWords, type SealedWords } from "../gateway/seal";
import type { SealedEvent, SealedHandoff } from "../gateway/types";
import { isLabel, openTrace, type BundleId, type SpanSink } from "../trace";
import type { ModelCall } from "../trace/types";
import {
  checkedLineFor,
  dangerOutcomes,
  matchDangerWords,
  OUTCOME_LABEL,
  stricterHold,
  strictestHold,
  timeoutLineId,
  timeoutResult,
} from "./rules";
import {
  REREAD_MS,
  SAFETY_LINE_BUDGET_MS,
  SAFETY_OUTCOMES,
  SAFETY_RETRY_MS,
  VERDICT_DEADLINE_MS,
  type CheckedLine,
  type CoreCaller,
  type CoreError,
  type HandleIds,
  type RecordSafetyOutcomeRequest,
  type RecordSafetyOutcomeResponse,
  type ReleaseRule,
  type SafetyDeps,
  type SafetyOutcome,
  type SafetyReadAnswer,
  type SafetyResult,
  type SendFixedLineRequest,
  type SendFixedLineResponse,
  type SentByActor,
} from "./types";

type EventState = "reading" | "done" | "unwired" | "lineFailed";
type HoldRule = ReleaseRule | "unread";

/** One text's safety state, as the batch and the turn read it. */
export interface SafetyEntry {
  eventId: string;
  state: EventState;
  /** True when the read (or its stand-in on a timeout) found danger: the batch closes at once (arch 02 step S). */
  danger: boolean;
  /** How the checked line went: through the core's outbox row, straight through Linq, or not at all. */
  path: "outbox" | "direct" | "outage" | "none" | null;
  /** The checked line's fixed line id, when one went. */
  lineId: string | null;
  /** Milliseconds from arrival to the line's hand-off, when one went. */
  handedAfterMs: number | null;
}

/** A hold on routine work. */
export interface HoldEntry {
  eventId: string;
  /** The core's hold id, or null while PostgreSQL has not been reached. */
  holdId: string | null;
  /** `unread`: no verdict came, so routine work waits for the read (arch 02 step S: "routine actions stay held"). */
  rule: HoldRule;
  blocksBooking: boolean;
  released: boolean;
}

/**
 * A hold still open, as a turn and its commit see it (CQ-65 as DL-119 replaced it: holds bind commits, not hand-offs).
 * `rule` is the hold's release rule (K-34 `safety_holds.release_rule`), or `unread` while no verdict has come;
 * `outcomes` are what the read (or its timeout stand-in) found in the text that made the hold.
 */
export interface OpenHold {
  eventId: string;
  /** The core's hold id (what K-09 releaseSafetyHold names), or null while PostgreSQL has not recorded it. */
  holdId: string | null;
  rule: HoldRule;
  outcomes: SafetyOutcome[];
  blocksBooking: boolean;
}

/** A stored text as the actor's inbox keeps it, sealed: what a resumed read reads again. */
export interface StoredText {
  event: SealedEvent;
  partKey: string | null;
  traceId: string;
  bundleId: BundleId;
}

/** A read resumed after an eviction: its text and the work the actor lends and settles. */
export interface ResumedRead {
  eventId: string;
  work: Promise<void>;
}

interface EventRow extends Record<string, SqlStorageValue> {
  event_id: string;
  state: string;
  danger: number;
  path: string | null;
  line_id: string | null;
  handed_after_ms: number | null;
}

interface HoldRow extends Record<string, SqlStorageValue> {
  event_id: string;
  hold_id: string | null;
  rule: string;
  blocks_booking: number;
  released: number;
}

interface OpenHoldRow extends HoldRow {
  outcomes: string | null;
}

/**
 * A text that waits for a read (its unread hold open, or its danger outcome not complete), with when it is next read
 * again (null: at once).
 */
interface HeldRow extends Record<string, SqlStorageValue> {
  event_id: string;
  arrived_ms: number;
  due_ms: number | null;
}

/**
 * A read sent once the timeout rule had taken its text, or while its danger outcome was not complete: what it answered (a
 * verdict or the read's own no-verdict answer, a failure, or no words) and the words it read (null when none were opened).
 */
interface LateAnswer {
  answer: SafetyReadAnswer | "failed" | "nothing";
  words: SealedWords | null;
}

/** What opening the words gave: nothing to read, or the words and the read in flight. */
type Started =
  | { kind: "nothing" }
  | { kind: "reading"; words: SealedWords; verdict: Promise<SafetyReadAnswer | "failed"> };

/** The answer a started read gives once the timeout rule has taken its text (or while its danger is open), with its words. */
function lateOf(started: Started | "unreadable"): Promise<LateAnswer> {
  if (started === "unreadable") return Promise.resolve<LateAnswer>({ answer: "failed", words: null });
  if (started.kind === "nothing") return Promise.resolve<LateAnswer>({ answer: "nothing", words: null });
  const { words, verdict } = started;
  return verdict.then((answer): LateAnswer => ({ answer, words }));
}

/**
 * The model calls of a timeout stand-in: the actor never saw the read's usage, so each try is a timed-out call of the
 * 2 s budget with no tokens or cost (the read's own span, T-365's, holds the real figures).
 */
function timeoutCalls(): ModelCall[] {
  const call = (model: string, role: "haiku" | "sonnet"): ModelCall => ({
    model,
    role,
    purpose: "safetyRead",
    input_tokens: 0,
    cached_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    cost_micro_usd: 0,
    ms: 2000,
    outcome: "timedOut",
  });
  return [call("claude-haiku-5-5", "haiku"), call("claude-sonnet-5-5", "sonnet")];
}

let deps: SafetyDeps | null = null;

/** Sets what the safety read needs for this Worker isolate; returns the function that puts the earlier ones back. */
export function setSafetyDeps(next: SafetyDeps | null): () => void {
  const before = deps;
  deps = next;
  return () => {
    deps = before;
  };
}

const isError = (answer: object): answer is CoreError => "error" in answer;

export function createSafetyTables(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS safety_events (
       event_id TEXT PRIMARY KEY,
       arrived_ms INTEGER NOT NULL,
       state TEXT NOT NULL,
       danger INTEGER NOT NULL DEFAULT 0,
       path TEXT,
       line_id TEXT,
       handed_after_ms INTEGER
     )`,
  );
  sql.exec("CREATE TABLE IF NOT EXISTS safety_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  sql.exec(
    `CREATE TABLE IF NOT EXISTS safety_holds (
       event_id TEXT PRIMARY KEY,
       hold_id TEXT,
       rule TEXT NOT NULL,
       blocks_booking INTEGER NOT NULL,
       released INTEGER NOT NULL DEFAULT 0
     )`,
  );
  // A record the actor could not give the core while PostgreSQL was down waits in the actor's write-on-return queue
  // (T-269, `SafetyHost.returns`), sealed under the handle's key (it holds the read's evidence words).
  // What the read (or its timeout stand-in) found in each text, as K-02 outcome labels (a JSON list): a turn is handed
  // each open hold with the outcomes that made it (DL-119). Labels only, never the read's evidence words.
  sql.exec("CREATE TABLE IF NOT EXISTS safety_outcomes (event_id TEXT PRIMARY KEY, outcomes TEXT NOT NULL)");
  // When each text whose unread hold is open (or whose danger outcome is not complete) is next read again, on the safety
  // clock (DL-127; arch 11 line 564: every 30 s until a verdict lands). Stored, so an eviction cannot lose it.
  sql.exec("CREATE TABLE IF NOT EXISTS safety_reread (event_id TEXT PRIMARY KEY, due_ms INTEGER NOT NULL)");
  // Each text whose danger outcome is not complete: its line has not gone (or is not known to have gone), or its record
  // is not kept (T-1088 round 3, DL-132). Event ids only.
  sql.exec("CREATE TABLE IF NOT EXISTS safety_pending (event_id TEXT PRIMARY KEY)");
}

/** The kinds of event whose words are read: a customer's text, a caption, a vote's words, an edit. */
const READ_KINDS: readonly string[] = ["text", "photo", "pollVote", "edit"];

/** True when the safety read reads this stored event's words. */
export function isReadableEvent(event: SealedEvent): boolean {
  return READ_KINDS.includes(event.kind) && event.sealed !== null && event.fromRosie !== true;
}

export function isReadable(handoff: SealedHandoff): boolean {
  return isReadableEvent(handoff.event);
}

export interface SafetyHost {
  storage: DurableObjectStorage;
  spanSink: () => SpanSink;
  /**
   * Called once a read's answer after the timeout rule took its text (the late answer, or a re-read's), or while its
   * danger outcome was not complete, has been dealt with: a verdict may have found danger (the open batch closes at once,
   * as on time) or lifted the unread hold (the batches it kept back go on); an answer that changed nothing moved the
   * text's next re-read (the actor's alarm follows it).
   */
  afterLate?: (eventId: string) => void;
  /** The stored texts with these event ids, sealed, in arrival order (the actor's inbox): a resumed read reads them again. */
  storedTexts(eventIds: readonly string[]): StoredText[];
  /**
   * The actor's queue of writes to replay when PostgreSQL returns (T-269, ../actor/copies): a record the core could not
   * take waits there, sealed, and `replayOnReturn` sends it when the queue replays it.
   */
  returns: ReturnWrites;
  /**
   * The actor's own copy of the handle's stopped flag (T-269): true once it says stopped. The outage line never goes to a
   * number it, or the stopped flag the deps read, says is stopped (arch 11 line 564).
   */
  stopped?: () => boolean;
}

/** The actor's write-on-return queue, as the safety read queues its records in it (T-269; ../actor/copies). */
export interface ReturnWrites {
  enqueue(write: { key: string; call: string; rank: "danger" | "stop" | "rest"; box: string }): unknown;
}

/** One queued write as the queue hands it back to be sent: its key, its call and its sealed request. */
export interface ReturnedWrite {
  readonly key: string;
  readonly call: string;
  readonly box: string;
}

/** What sending one queued write gave the queue: taken, the core not answering yet, or refused with the core's code. */
export type ReturnStep = "written" | "notBack" | { readonly refused: string };

/** The K-09 calls whose records the safety read queues while PostgreSQL is down, and sends when the queue replays them. */
export const SAFETY_RETURN_CALLS: readonly string[] = ["recordSafetyOutcome", "sendFixedLine"];

/** The fixed lines the safety read can send (K-01 v1): 911, 988 and 911, the danger question, the outage line. */
const SAFETY_FIXED_LINES = ["safetyEmergency", "safetyCrisis", "safetyAsk", "outage"] as const;

/** The outcomes whose step has its own checked line (No sends nothing; Unsure takes the fixed lines). */
const OUTCOMES_WITH_LINES = SAFETY_OUTCOMES.filter((outcome) => outcome !== "No" && outcome !== "Unsure");

/** A text whose read is resumed after an eviction, with the time its arrival was noted (on the safety clock). */
interface CutOffRow extends Record<string, SqlStorageValue> {
  event_id: string;
  arrived_ms: number;
}

export class SafetyOnArrival {
  private launch: Promise<unknown> = Promise.resolve();
  private readonly pending = new Set<Promise<void>>();
  /**
   * The texts whose safety work runs in this instance now. A row still 'reading' that is not here was cut off: the
   * instance that read it is gone (an eviction, a deploy, a reset), and with it the 4 s deadline it kept in memory.
   */
  private readonly inFlight = new Set<string>();
  /**
   * The texts with a read in flight in this instance after the timeout rule took them (the late read sent on arrival or
   * on a resume, or a re-read), each with how many. On return, only the held texts not here are read again at once.
   */
  private readonly rereading = new Map<string, number>();
  /** The texts whose late verdict is being applied in this instance now: a second answer for one of them changes nothing. */
  private readonly landing = new Set<string>();

  /** The handle's actor name, from the first hand-off; kept in storage for a restart. */
  private actorName = "";

  constructor(private readonly host: SafetyHost) {
    createSafetyTables(host.storage.sql);
    const meta = host.storage.sql
      .exec<{ v: string }>("SELECT v FROM safety_meta WHERE k = 'actorName'")
      .toArray();
    this.actorName = meta[0]?.v ?? "";
  }

  /**
   * Called by the actor in the step that stores the text. The first part runs without an await: the arrival is noted, the
   * 4 s deadline starts and the read is queued behind the earlier texts' reads. The returned promise ends when the
   * text's safety work has: the actor lends it to `waitUntil`.
   */
  arrive(handoff: SealedHandoff): Promise<void> {
    const { sql } = this.host.storage;
    const eventId = handoff.event.eventId;
    if (this.actorName !== handoff.actorName) {
      this.actorName = handoff.actorName;
      sql.exec("INSERT OR REPLACE INTO safety_meta (k, v) VALUES ('actorName', ?)", handoff.actorName);
    }
    const set = deps;
    if (set === null) {
      sql.exec(
        "INSERT OR IGNORE INTO safety_events (event_id, arrived_ms, state) VALUES (?, ?, 'unwired')",
        eventId,
        Date.now(),
      );
      return Promise.resolve();
    }
    const arrivedAt = set.clock.now();
    sql.exec(
      "INSERT OR IGNORE INTO safety_events (event_id, arrived_ms, state) VALUES (?, ?, 'reading')",
      eventId,
      arrivedAt,
    );
    const deadline = set.clock.after(VERDICT_DEADLINE_MS);
    const started = this.queueRead(set, handoff);
    return this.track(eventId, this.settle(set, handoff, arrivedAt, deadline, started));
  }

  /** Notes a text's safety work as running in this instance until it ends; a failure is swallowed (the row says what is left). */
  private track(eventId: string, settling: Promise<void>): Promise<void> {
    this.inFlight.add(eventId);
    const work = settling
      .catch(() => undefined)
      .finally(() => {
        this.inFlight.delete(eventId);
      });
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
    return work;
  }

  /**
   * Resumes each read an eviction cut off (T-1088): every text still 'reading' whose work is not running in this instance,
   * in arrival order. Before its 4 s deadline it is read again with the time left; past it, the timeout rule applies at
   * once (a danger word's line, else the outage line and the unread hold, whose re-reads then follow every 30 s) and the
   * read is sent again so that its late verdict can lift the unread hold, as on arrival (routine work is never held for
   * ever). The deadline still counts from the text's arrival, so a danger text gets its line no later than the timeout rule
   * allows. A text whose words cannot be opened again (the key store throws, at once or later) has no verdict to wait for:
   * the timeout rule applies at once, as for a read that fails on arrival. A resumed read whose work fails is left
   * unresolved (`lineFailed`), so routine work stays held and no alarm keeps trying it. A text whose read had found danger
   * before the cut, with its line or record not done, takes no timeout rule (a verdict came): it is read again at once and
   * its danger verdict applied (round 3). Nothing is resumed while nothing is wired.
   */
  resumeCutOff(): ResumedRead[] {
    const set = deps;
    if (set === null) return [];
    const { sql } = this.host.storage;
    const rows = sql
      .exec<CutOffRow>(
        "SELECT event_id, arrived_ms FROM safety_events WHERE state = 'reading' ORDER BY rowid",
      )
      .toArray()
      .filter((row) => !this.inFlight.has(row.event_id));
    if (rows.length === 0) return [];
    const texts = new Map(
      this.host.storedTexts(rows.map((row) => row.event_id)).map((text) => [text.event.eventId, text]),
    );
    const resumed: ResumedRead[] = [];
    for (const row of rows) {
      const eventId = row.event_id;
      const text = texts.get(eventId);
      if (this.dangerPending(eventId)) {
        // Its read found danger before the cut, and the line or its record was not done (T-1088 round 3). No timeout
        // rule: a verdict came. It is no longer being read: it is read again now, and a danger verdict goes through the
        // same send path with the same idempotency key (`applyLate`), so the line goes once and its record is kept. Until
        // then it stays scheduled, as an unread hold's re-read is, among the holds (round 4: its hold from its kept
        // outcomes, written again here if the cut came before it was).
        this.finish(eventId, "lineFailed", true, "none", null, null);
        this.holdFromKept(eventId);
        this.nextReread(set, eventId);
        if (text !== undefined) this.reread(set, text, row.arrived_ms);
        continue;
      }
      if (text === undefined) {
        // No stored words to read again: the text stays unresolved, so routine work stays held (fails closed).
        this.giveUp(eventId);
        continue;
      }
      const handoff: SealedHandoff = { ...text, actorName: this.actorName };
      let deadline: Promise<void>;
      try {
        const left = row.arrived_ms + VERDICT_DEADLINE_MS - set.clock.now();
        deadline = left > 0 ? set.clock.after(left) : Promise.resolve();
      } catch {
        // The clock cannot say how much time is left: the deadline counts as passed, so the line is never later.
        deadline = Promise.resolve();
      }
      const started = this.queueRead(set, handoff);
      const settling = this.settle(set, handoff, row.arrived_ms, deadline, started).finally(() => {
        this.giveUp(eventId);
      });
      resumed.push({ eventId, work: this.track(eventId, settling) });
    }
    return resumed;
  }

  /**
   * Starts the re-read of every text that waits for a read (its unread hold open, or its danger outcome not complete)
   * and whose next re-read is due (DL-127; arch 11 line 564), in arrival order, and sets each one's next re-read 30 s on
   * before its read is sent: a read that never answers is looked at again then, and nothing comes due again at once. A
   * text whose work still runs here, or whose read is out already, gets no second read (round 2 security note a: a read
   * port that hangs adds no pending read every 30 s). The hold stays open until a verdict lands (`applyLate`). Nothing is
   * read while nothing is wired.
   */
  rereadDue(): void {
    const set = deps;
    if (set === null) return;
    const waiting = this.waiting();
    if (waiting.length === 0) return;
    const now = set.clock.now();
    const due = waiting.filter((row) => row.due_ms === null || row.due_ms <= now);
    if (due.length === 0) return;
    for (const row of due) this.setReread(row.event_id, now + REREAD_MS);
    const ready = due.filter((row) => !this.busy(row.event_id));
    if (ready.length === 0) return;
    const texts = new Map(
      this.host.storedTexts(ready.map((row) => row.event_id)).map((text) => [text.event.eventId, text]),
    );
    for (const row of ready) {
      // No stored words to read again: the text stays held, and its re-read comes back in 30 s.
      const text = texts.get(row.event_id);
      if (text !== undefined) this.reread(set, text, row.arrived_ms);
    }
  }

  /** Sends a text's read again, behind the earlier texts' reads, and deals with its answer when it comes (`applyLate`). */
  private reread(set: SafetyDeps, text: StoredText, arrivedAt: number): void {
    const handoff: SealedHandoff = { ...text, actorName: this.actorName };
    this.awaitLate(set, handoff, arrivedAt, this.queueRead(set, handoff).then(lateOf));
  }

  /** True while this text's work runs here, or a read of it sent after the timeout rule (or a re-read) is out. */
  private busy(eventId: string): boolean {
    return this.inFlight.has(eventId) || this.rereading.has(eventId);
  }

  /** Sets when a text is next read again (its unread hold is open, or its danger outcome is not complete). */
  private setReread(eventId: string, dueMs: number): void {
    this.host.storage.sql.exec(
      "INSERT OR REPLACE INTO safety_reread (event_id, due_ms) VALUES (?, ?)",
      eventId,
      dueMs,
    );
  }

  /** Sets a text's next re-read 30 s on; a clock that throws makes it due at once (the actor's guard then moves it 30 s). */
  private nextReread(set: SafetyDeps, eventId: string): void {
    let due = 0;
    try {
      due = set.clock.now() + REREAD_MS;
    } catch {
      // Due at once: the actor's alarm looks at it now, and its guard moves the safety entry 30 s on.
    }
    this.setReread(eventId, due);
  }

  /**
   * The texts that wait for a read, in arrival order, each with when it is next read again: an unread hold open (no
   * verdict yet), or a danger outcome not complete once its first try ended or was cut off (a text still being read is
   * `resumeCutOff`'s and the 4 s deadline's).
   */
  private waiting(): HeldRow[] {
    return this.host.storage.sql
      .exec<HeldRow>(
        `SELECT e.event_id, e.arrived_ms, r.due_ms
         FROM safety_events e
         LEFT JOIN safety_reread r ON r.event_id = e.event_id
         WHERE EXISTS (SELECT 1 FROM safety_holds h
                       WHERE h.event_id = e.event_id AND h.rule = 'unread' AND h.released = 0)
            OR (e.state <> 'reading' AND EXISTS (SELECT 1 FROM safety_pending p WHERE p.event_id = e.event_id))
         ORDER BY e.rowid`,
      )
      .toArray();
  }

  /** Marks a text whose safety work could not end as unresolved: it is no longer read, and routine work for it waits. */
  private giveUp(eventId: string): void {
    this.host.storage.sql.exec(
      "UPDATE safety_events SET state = 'lineFailed' WHERE event_id = ? AND state = 'reading'",
      eventId,
    );
  }

  /**
   * Milliseconds, on the safety clock, until the actor's alarm must look at the safety work again (zero or less: now), or
   * null when nothing needs it: no text is being read and none waits for a read, or nothing is wired to read. The actor
   * keeps its alarm there, so an instance always comes back to work an eviction cut off:
   *   - a text still being read: at its 4 s deadline; past it, at once when its work was cut off; while its work still
   *     runs here (its line being handed on), in 1 s until the line's 5 s budget is spent, then every 30 s (T-1088 security
   *     note a: never a 1 s alarm for as long as a hang lasts);
   *   - a text whose unread hold is open, or whose danger outcome is not complete: at its next re-read, every 30 s until a
   *     verdict lands and its line and record are done (DL-127, round 3).
   */
  nextWakeIn(): number | null {
    const set = deps;
    if (set === null) return null;
    const reading = this.host.storage.sql
      .exec<CutOffRow>("SELECT event_id, arrived_ms FROM safety_events WHERE state = 'reading'")
      .toArray();
    const held = this.waiting();
    if (reading.length === 0 && held.length === 0) return null;
    const now = set.clock.now();
    const dues: number[] = [];
    for (const row of reading) {
      const deadline = row.arrived_ms + VERDICT_DEADLINE_MS;
      if (deadline > now) dues.push(deadline);
      else if (!this.inFlight.has(row.event_id)) dues.push(now);
      else dues.push(now + (now < row.arrived_ms + SAFETY_LINE_BUDGET_MS ? SAFETY_RETRY_MS : REREAD_MS));
    }
    for (const row of held) dues.push(row.due_ms ?? now);
    return Math.min(...dues) - now;
  }

  /** Resolves when every text that has arrived so far has been dealt with (tests; a shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /**
   * True when one of these texts has not been read yet, so the batch that holds it waits (CQ-65 as DL-119 replaced it):
   * its read is running or was never wired; no verdict came (its unread hold is open: only a verdict lifts it, T-247 note
   * a); or the outage path failed with no verdict. A text the read found danger in has been read, whether or not its line
   * has gone and its record is kept (round 4, DL-144): its hold, written from its kept outcomes before the core is called,
   * does not keep the batch back, it binds the turn's commit, so a STOP in that batch or a later one still commits. Its row
   * says danger from that same step (round 5, `markDanger`), so a late danger after a failed outage line is read too. A
   * danger text whose hold could not be written is among the texts not read at commit time (`unreadTexts`). A text with no
   * safety row at all is the actor's to find (note d).
   */
  unreadAmong(eventIds: readonly string[]): boolean {
    if (eventIds.length === 0) return false;
    return (
      this.host.storage.sql
        .exec(
          `SELECT 1 FROM safety_events e
           WHERE e.event_id IN (SELECT value FROM json_each(?))
             AND (e.state IN ('reading', 'unwired')
                  OR (e.state = 'lineFailed' AND e.danger = 0)
                  OR EXISTS (SELECT 1 FROM safety_holds h
                             WHERE h.event_id = e.event_id AND h.rule = 'unread' AND h.released = 0))
           LIMIT 1`,
          JSON.stringify(eventIds),
        )
        .toArray().length > 0
    );
  }

  /**
   * The holds not released, in the order they were made, each with the outcomes of the text that made it: what a turn
   * carries from its start and what its commit is handed again at commit time (DL-119).
   */
  openHolds(): OpenHold[] {
    return this.host.storage.sql
      .exec<OpenHoldRow>(
        `SELECT h.event_id, h.hold_id, h.rule, h.blocks_booking, h.released, o.outcomes
         FROM safety_holds h LEFT JOIN safety_outcomes o ON o.event_id = h.event_id
         WHERE h.released = 0 ORDER BY h.rowid`,
      )
      .toArray()
      .map((row) => ({
        eventId: row.event_id,
        holdId: row.hold_id,
        rule: row.rule as HoldRule,
        outcomes: row.outcomes === null ? [] : (JSON.parse(row.outcomes) as SafetyOutcome[]),
        blocksBooking: row.blocks_booking === 1,
      }));
  }

  /**
   * The texts not read yet, by event id in arrival order, beside the open holds (QUESTIONS.md CQ-65's addendum, DL-127):
   * still being read, never wired, given up with no hold open, or with a danger outcome not complete and no hold open (its
   * hold could not be written: fails closed). A commit is handed them (CommitContext.unread), and T-252's gate counts each
   * as an open hold. A text under an open hold (unread or an outcome's) is among `openHolds` instead; a text with no safety
   * row at all is the actor's to find.
   */
  unreadTexts(): string[] {
    return this.host.storage.sql
      .exec<{ event_id: string }>(
        `SELECT e.event_id FROM safety_events e
         WHERE e.state IN ('reading', 'unwired')
            OR (((e.state = 'lineFailed' AND e.danger = 0)
                 OR EXISTS (SELECT 1 FROM safety_pending p WHERE p.event_id = e.event_id))
                AND NOT EXISTS (SELECT 1 FROM safety_holds h WHERE h.event_id = e.event_id AND h.released = 0))
         ORDER BY e.rowid`,
      )
      .toArray()
      .map((row) => row.event_id);
  }

  /** True while routine work must wait: a text is unread, a danger outcome is not complete, or a hold is not released. */
  routineHeld(): boolean {
    const { sql } = this.host.storage;
    const unread = sql
      .exec("SELECT 1 FROM safety_events WHERE state IN ('reading','unwired','lineFailed') LIMIT 1")
      .toArray();
    if (unread.length > 0) return true;
    if (sql.exec("SELECT 1 FROM safety_pending LIMIT 1").toArray().length > 0) return true;
    return sql.exec("SELECT 1 FROM safety_holds WHERE released = 0 LIMIT 1").toArray().length > 0;
  }

  readSafety(): SafetyEntry[] {
    return this.host.storage.sql
      .exec<EventRow>(
        "SELECT event_id, state, danger, path, line_id, handed_after_ms FROM safety_events ORDER BY rowid",
      )
      .toArray()
      .map((row) => ({
        eventId: row.event_id,
        state: row.state as EventState,
        danger: row.danger === 1,
        path: row.path as SafetyEntry["path"],
        lineId: row.line_id,
        handedAfterMs: row.handed_after_ms,
      }));
  }

  readHolds(): HoldEntry[] {
    return this.host.storage.sql
      .exec<HoldRow>(
        "SELECT event_id, hold_id, rule, blocks_booking, released FROM safety_holds ORDER BY rowid",
      )
      .toArray()
      .map((row) => ({
        eventId: row.event_id,
        holdId: row.hold_id,
        rule: row.rule as HoldRule,
        blocksBooking: row.blocks_booking === 1,
        released: row.released === 1,
      }));
  }

  /**
   * Notes that the shared core released a hold (the turn's gate, or the console, calls `releaseSafetyHold`: after a
   * clear "we're safe" with a fresh read-back, once the booking is private, or at once after the line). The actor keeps
   * only its mirror of it, found by the core's hold id: only a hold the core recorded, named by its id, is released
   * (T-246 and T-247 security note a). An unread hold (no read said it is safe: only the read's late verdict lifts it) and
   * a hold the core has not recorded yet (no hold id while PostgreSQL was down) have no id to name, so they stay held. A
   * threat's hold is never released (A3-48).
   */
  markHoldReleased(holdId: string): "released" | "neverReleased" | "noSuchHold" {
    const hold = this.readHolds().find(
      (entry) => entry.holdId !== null && entry.holdId === holdId && entry.rule !== "unread",
    );
    if (hold === undefined) return "noSuchHold";
    if (hold.rule === "never") return "neverReleased";
    this.host.storage.sql.exec(
      "UPDATE safety_holds SET released = 1 WHERE event_id = ? AND hold_id = ?",
      hold.eventId,
      holdId,
    );
    return "released";
  }

  /** The event ids among these that have no safety row: their read never started. */
  withoutSafetyRow(eventIds: readonly string[]): string[] {
    if (eventIds.length === 0) return [];
    const known = new Set(
      this.host.storage.sql
        .exec<{ event_id: string }>(
          "SELECT event_id FROM safety_events WHERE event_id IN (SELECT value FROM json_each(?))",
          JSON.stringify(eventIds),
        )
        .toArray()
        .map((row) => row.event_id),
    );
    return eventIds.filter((eventId) => !known.has(eventId));
  }

  /**
   * Sends one of the safety read's queued records when the actor's write-on-return queue replays it (T-269; arch 11 line
   * 566): what the actor sent straight through Linq while PostgreSQL was down is written with `sentByActor`, caller kind
   * actorOnReturn, and never as a new send. A record's hold id lands on its hold. The core not answering (a throw, or
   * `transient`), or the handle's key not to be had, is `notBack`: the record waits, and nothing queued after it goes
   * first. Any other error is the core's refusal, and a box that does not open is refused as `unopened`.
   */
  async replayOnReturn(write: ReturnedWrite): Promise<ReturnStep> {
    const set = deps;
    if (set === null) return "notBack";
    const prefix = `${write.call}:`;
    if (!SAFETY_RETURN_CALLS.includes(write.call) || !write.key.startsWith(prefix)) {
      return { refused: "notSafetyRecord" };
    }
    const eventId = write.key.slice(prefix.length);
    let sealingKey: Uint8Array;
    try {
      sealingKey = await set.keys.getOrCreateKey(this.handleOf());
    } catch {
      return "notBack";
    }
    let request: RecordSafetyOutcomeRequest | SendFixedLineRequest;
    try {
      const opened = await openWords(
        JSON.parse(write.box) as Parameters<typeof openWords>[0],
        sealingKey,
        this.actorName,
        `return:${write.key}`,
      );
      request = JSON.parse(opened.body ?? "null") as RecordSafetyOutcomeRequest | SendFixedLineRequest;
    } catch {
      return { refused: "unopened" };
    }
    const onReturn = { ...request, caller: { ...request.caller, kind: "actorOnReturn" as const } };
    let answer: RecordSafetyOutcomeResponse | SendFixedLineResponse | CoreError;
    try {
      answer =
        write.call === "recordSafetyOutcome"
          ? await set.core.recordSafetyOutcome(onReturn as RecordSafetyOutcomeRequest)
          : await set.core.sendFixedLine(onReturn as SendFixedLineRequest);
    } catch {
      return "notBack";
    }
    if (isError(answer)) return answer.error === "transient" ? "notBack" : { refused: answer.error };
    if ("hold" in answer && answer.hold !== null) {
      this.host.storage.sql.exec(
        "UPDATE safety_holds SET hold_id = ? WHERE event_id = ? AND hold_id IS NULL",
        answer.hold.holdId,
        eventId,
      );
    }
    return "written";
  }

  /**
   * The checked lines the safety read can send, as its bundle gives them now (T-269: the actor copies them on every write):
   * the fixed lines by K-01 id and each outcome step's own line. Null while nothing is wired to read; a line the bundle
   * cannot give now is null.
   */
  checkedLines(): { slot: string; line: CheckedLine | null }[] | null {
    const set = deps;
    if (set === null) return null;
    const read = (get: () => CheckedLine | null): CheckedLine | null => {
      try {
        return get();
      } catch {
        return null;
      }
    };
    return [
      ...SAFETY_FIXED_LINES.map((id) => ({
        slot: `fixed:${id}`,
        line: read(() => set.bundle.fixedLine(id)),
      })),
      ...OUTCOMES_WITH_LINES.map((outcome) => ({
        slot: `outcome:${OUTCOME_LABEL[outcome]}`,
        line: read(() => set.bundle.outcomeLine(outcome)),
      })),
    ];
  }

  // ---- the read -------------------------------------------------------------------------------------------------

  private handleOf(): { kind: string; address: string } {
    const at = this.actorName.indexOf(":");
    return { kind: this.actorName.slice(0, at), address: this.actorName.slice(at + 1) };
  }

  /**
   * Opens the box and starts the read, behind the earlier texts' starts, so the port is called in arrival order. Never
   * throws: a key store that throws, at once or later, makes the words unreadable (no verdict can come, so the timeout
   * rule applies at once; T-1088 security note d).
   */
  private queueRead(set: SafetyDeps, handoff: SealedHandoff): Promise<Started | "unreadable"> {
    const { event } = handoff;
    const sealed = event.sealed;
    const opened: Promise<SealedWords | "unreadable"> =
      sealed === null
        ? Promise.resolve({ body: null, subject: null })
        : Promise.resolve()
            .then(() => set.keys.getOrCreateKey(event.handle))
            .then(
              (key) => openWords(sealed, key, this.actorName, event.eventId),
              () => "unreadable" as const,
            );
    const started = this.launch.then(async (): Promise<Started | "unreadable"> => {
      const words = await opened.catch(() => "unreadable" as const);
      if (words === "unreadable") return "unreadable";
      if ((words.body ?? "").trim() === "" && (words.subject ?? "").trim() === "") return { kind: "nothing" };
      const verdict = Promise.resolve()
        .then(() =>
          set.read.read({
            eventId: event.eventId,
            source: "text",
            traceId: handoff.traceId,
            bundleId: handoff.bundleId,
            words,
          }),
        )
        .catch(() => "failed" as const);
      return { kind: "reading", words, verdict };
    });
    this.launch = started.catch(() => undefined);
    return started;
  }

  private async settle(
    set: SafetyDeps,
    handoff: SealedHandoff,
    arrivedAt: number,
    deadline: Promise<void>,
    started: Promise<Started | "unreadable">,
  ): Promise<void> {
    const eventId = handoff.event.eventId;
    const verdictOf = started.then<SafetyReadAnswer | "failed" | "nothing">((s) =>
      s === "unreadable" ? "failed" : s.kind === "nothing" ? "nothing" : s.verdict,
    );
    const first: SafetyReadAnswer | "failed" | "nothing" | "deadline" = await Promise.race([
      verdictOf,
      deadline.then(() => "deadline" as const),
    ]);

    if (first === "nothing") {
      this.finish(eventId, "done", false, "none", null, null);
      return;
    }
    // The read's own timeout marker (`timedOut`: no model gave a verdict) is no verdict, even when it beats the actor's
    // deadline: it takes the deadline's rule below, never the place of a verdict with no outcome (DL-112; T-365 note a).
    const gaveUp = first !== "failed" && first !== "deadline" && first.result.timedOut;
    if (first !== "failed" && first !== "deadline" && !gaveUp) {
      await this.applyResult(set, handoff, arrivedAt, first.result, first.modelCalls, "verdict");
      this.onReturn(set, eventId);
      return;
    }

    // No verdict: the 4 s deadline passed, the read failed, or the read gave up. A danger word from the bundle's list
    // counts as Unsure (988 and 911 for self-harm words, else 911); with none, the outage line goes.
    const opened = await started.catch(() => "unreadable" as const);
    const words = opened === "unreadable" || opened.kind === "nothing" ? null : opened.words;
    const matches =
      words === null ? [] : matchDangerWords([words.body, words.subject], set.bundle.dangerWords());
    const stand = timeoutResult(eventId, matches);
    if (first !== "failed" && first !== "deadline") {
      // The read is over: its own model calls go in the span, and no late verdict can follow.
      await this.applyResult(set, handoff, arrivedAt, stand, first.modelCalls, "readTimedOut");
      return;
    }
    await this.applyResult(set, handoff, arrivedAt, stand, timeoutCalls(), first);

    // A verdict that arrives late changes a timeout that found no danger word: it is applied then, and the unread hold lifts.
    // It is not waited for: a read that never answers must not keep the text's work open, and the stored re-read (every
    // 30 s) stands in for it if the answer never comes or is lost with this instance (DL-127). The actor is told once the
    // answer is dealt with, so danger closes the open batch at once and a lifted hold lets the waiting batches go on (note e).
    if (
      first === "deadline" &&
      matches.length === 0 &&
      opened !== "unreadable" &&
      opened.kind === "reading"
    ) {
      this.awaitLate(set, handoff, arrivedAt, lateOf(opened));
    }
  }

  /**
   * Waits, in this instance's memory, for a read sent once the timeout rule had taken its text (the late read, or a
   * re-read), deals with its answer (`applyLate`) and tells the actor. The text counts as being read again here meanwhile.
   */
  private awaitLate(
    set: SafetyDeps,
    handoff: SealedHandoff,
    arrivedAt: number,
    answer: Promise<LateAnswer>,
  ): void {
    const eventId = handoff.event.eventId;
    this.rereading.set(eventId, (this.rereading.get(eventId) ?? 0) + 1);
    void answer
      .then((late) => this.applyLate(set, handoff, arrivedAt, late))
      .then(() => {
        this.host.afterLate?.(eventId);
      })
      .catch(() => undefined)
      .finally(() => {
        const left = (this.rereading.get(eventId) ?? 1) - 1;
        if (left > 0) this.rereading.set(eventId, left);
        else this.rereading.delete(eventId);
      });
  }

  /**
   * A read's answer after the timeout rule took its text (DL-127), or while its danger outcome is not complete (round 3).
   * It is dropped only once the text's outcome is complete: its unread hold lifted (or turned into the outcome's hold) and
   * no danger outcome left with its line or record not done. Without an open danger: an answer that is itself timedOut or
   * failed is no verdict, so the hold stays open and the next re-read is set 30 s on (arch 11 line 564), never lifted
   * without a verdict; a verdict is applied as on time (danger gets its line at once, past any opt-out), then the unread
   * hold lifts (a danger verdict's own hold has taken its place, unless the core made none), the text counts as read and
   * its re-reads stop; words that open to nothing hold nothing, as on arrival. With an open danger (its first verdict found
   * danger): only a danger verdict is applied, through the same send path with the same idempotency key, so the line goes
   * once and the record is kept; any other answer is not used (the first verdict stands), except that a danger word still
   * gets its line by the timeout rule, as on arrival. The unread hold lifts only once the outcome is complete, so a danger
   * text is always in the holds or unread (round 2 security note b).
   */
  private async applyLate(
    set: SafetyDeps,
    handoff: SealedHandoff,
    arrivedAt: number,
    late: LateAnswer,
  ): Promise<void> {
    const eventId = handoff.event.eventId;
    if (this.landing.has(eventId)) return;
    const pending = this.dangerPending(eventId);
    if (!pending && !this.unreadHoldOpen(eventId)) return;
    // An open danger is among the holds whatever this answer says (round 4): its hold from its kept outcomes, written
    // again here if the cut came before it was.
    if (pending) this.holdFromKept(eventId);
    const { sql } = this.host.storage;
    const { answer } = late;
    const verdict = answer !== "failed" && answer !== "nothing" && !answer.result.timedOut ? answer : null;
    let use: { result: SafetyResult; calls: ModelCall[] } | "nothing" | null = null;
    if (!pending) {
      if (verdict !== null) use = { result: verdict.result, calls: verdict.modelCalls };
      else if (answer === "nothing") use = "nothing";
    } else if (verdict !== null && dangerOutcomes(verdict.result.outcomes).length > 0) {
      use = { result: verdict.result, calls: verdict.modelCalls };
    } else {
      const words = late.words;
      const matches =
        words === null ? [] : matchDangerWords([words.body, words.subject], set.bundle.dangerWords());
      if (matches.length > 0) {
        use = {
          result: timeoutResult(eventId, matches),
          calls: answer === "failed" || answer === "nothing" ? timeoutCalls() : answer.modelCalls,
        };
      }
    }
    if (use === null) {
      // Nothing to apply: the text stays held, nothing is sent, and it is read again 30 s on. It still waits, so it makes
      // no other text due (round 4, the architect's round 3 gap B): each waiting text keeps its own 30 s re-read.
      this.nextReread(set, eventId);
      const noLine = answer === "failed" || answer === "nothing";
      const shown = noLine ? timeoutResult(eventId, []) : answer.result;
      const calls = noLine ? timeoutCalls() : answer.modelCalls;
      this.recordSpan(set, handoff, arrivedAt, shown, calls, "reread", "none", null, answer === "failed");
      return;
    }
    this.landing.add(eventId);
    try {
      if (use !== "nothing") {
        await this.applyResult(set, handoff, arrivedAt, use.result, use.calls, "late");
      }
      // The danger's line or record is not done: the text stays held and scheduled (its next re-read is set).
      if (this.dangerPending(eventId)) return;
      sql.exec("UPDATE safety_holds SET released = 1 WHERE event_id = ? AND rule = 'unread'", eventId);
      sql.exec(
        "UPDATE safety_events SET state = 'done' WHERE event_id = ? AND state = 'lineFailed' AND danger = 0",
        eventId,
      );
      sql.exec("DELETE FROM safety_reread WHERE event_id = ?", eventId);
      if (verdict !== null) this.onReturn(set, eventId);
    } finally {
      this.landing.delete(eventId);
    }
  }

  /** True while this text's unread hold is open: no verdict has landed for it yet. */
  private unreadHoldOpen(eventId: string): boolean {
    return (
      this.host.storage.sql
        .exec("SELECT 1 FROM safety_holds WHERE event_id = ? AND rule = 'unread' AND released = 0", eventId)
        .toArray().length > 0
    );
  }

  /** True while this text's danger outcome is not complete: its line has not gone, or its record is not kept. */
  private dangerPending(eventId: string): boolean {
    return (
      this.host.storage.sql.exec("SELECT 1 FROM safety_pending WHERE event_id = ?", eventId).toArray()
        .length > 0
    );
  }

  /**
   * Notes, before the hold or any send, that this text's danger outcome is not complete, so an eviction from here on
   * leaves it scheduled. A storage that fails here must not keep the line from going.
   */
  private markDangerPending(eventId: string): void {
    try {
      this.host.storage.sql.exec("INSERT OR IGNORE INTO safety_pending (event_id) VALUES (?)", eventId);
    } catch {
      // Not noted: the line still goes, and the rows written after it say what is left.
    }
  }

  /**
   * Notes on the text's row, in the step its hold is written, that its read found danger (T-1088 round 5, DL-146; the
   * architect's round 4 gap): from here on the text counts as read, so its batch goes on and its hold binds the commit
   * (CQ-65 as DL-119). On the late path the row may say lineFailed already (the timeout rule's outage line failed), and an
   * eviction during the line's send leaves it so, as `finish` comes only after the send. A storage that fails here must
   * not keep the line from going: `finish` notes it once the send ends.
   */
  private markDanger(eventId: string): void {
    try {
      this.host.storage.sql.exec("UPDATE safety_events SET danger = 1 WHERE event_id = ?", eventId);
    } catch {
      // Not noted: `finish` notes it after the send; a row left lineFailed until then keeps its batch back (fails closed).
    }
  }

  /**
   * The danger outcome is complete (the core answered, or the direct line went or none is needed, and its record is kept):
   * its re-reads stop, unless the unread hold still waits for a verdict.
   */
  private clearDangerPending(eventId: string): void {
    const { sql } = this.host.storage;
    sql.exec("DELETE FROM safety_pending WHERE event_id = ?", eventId);
    sql.exec(
      `DELETE FROM safety_reread WHERE event_id = ?
         AND NOT EXISTS (SELECT 1 FROM safety_holds WHERE event_id = ? AND rule = 'unread' AND released = 0)`,
      eventId,
      eventId,
    );
  }

  /**
   * Writes a danger's hold from these outcomes (every outcome kept for the text: the strictest rule of them all, arch 06
   * line 327, so a re-applied danger never takes only its latest read's rule), in place of the text's unread hold, before
   * the core is called (T-1088 round 4, DL-144; the architect's round 3 gap A and note a). It stands until the core's hold
   * takes its place (`sendDanger`), never looser than the open one. A storage that fails here must not keep the line from
   * going: the text then stays among the texts not read at commit time, and a resume or re-read writes the hold again.
   */
  private holdFromOutcomes(
    eventId: string,
    outcomes: readonly SafetyOutcome[],
    blocksBooking: boolean,
  ): void {
    const rule = strictestHold(outcomes);
    if (rule === null) return;
    try {
      this.writeHold(eventId, null, rule, blocksBooking);
    } catch {
      // Not written: `unreadTexts` names the text to the commit until a resume or re-read writes it (`holdFromKept`).
    }
  }

  /**
   * An open danger whose hold is missing (the cut came before it was written) gets it from the outcomes kept for it, on
   * resume or re-read; one with its hold open keeps it as it is (never looser).
   */
  private holdFromKept(eventId: string): void {
    try {
      const open = this.host.storage.sql
        .exec("SELECT 1 FROM safety_holds WHERE event_id = ? AND released = 0 AND rule <> 'unread'", eventId)
        .toArray();
      if (open.length === 0) this.holdFromOutcomes(eventId, this.outcomesOf(eventId), false);
    } catch {
      // The storage failed: the text stays among the texts not read at commit time, and the next re-read tries again.
    }
  }

  /** The outcome labels kept for this text (none yet: empty). */
  private outcomesOf(eventId: string): SafetyOutcome[] {
    const row = this.host.storage.sql
      .exec<{ outcomes: string }>("SELECT outcomes FROM safety_outcomes WHERE event_id = ?", eventId)
      .toArray()[0];
    return row === undefined ? [] : (JSON.parse(row.outcomes) as SafetyOutcome[]);
  }

  /**
   * A read gave a verdict: the model is back (arch 11 line 564: "On return: danger first, then stops, then the rest in
   * order"). Every other text that waits for a verdict (its unread hold open), and whose read is not out here, is due for
   * its re-read now, so the actor's alarm reads them at once, in arrival order: danger among them gets its line as its
   * verdict lands, and the batches they kept back go on in order. Round 4 (the architect's round 3 gap B): only a text
   * that no longer waits does this (as in round 2), and a text whose danger's line or record is not done is never made due
   * here (its verdict came; what it waits for is its line, not the model). So two such texts never make each other due on
   * every answer, and each keeps its own 30 s re-read (arch 11 line 564).
   */
  private onReturn(set: SafetyDeps, readNow: string): void {
    const waiting = this.waiting();
    if (waiting.length === 0) return;
    if (waiting.some((row) => row.event_id === readNow)) return;
    const now = set.clock.now();
    for (const row of waiting) {
      if (row.event_id === readNow || this.busy(row.event_id) || this.dangerPending(row.event_id)) continue;
      if (row.due_ms !== null && row.due_ms > now) this.setReread(row.event_id, now);
    }
  }

  private async applyResult(
    set: SafetyDeps,
    handoff: SealedHandoff,
    arrivedAt: number,
    result: SafetyResult,
    modelCalls: ModelCall[],
    via: "verdict" | "deadline" | "failed" | "readTimedOut" | "late",
  ): Promise<void> {
    const { sql } = this.host.storage;
    const eventId = handoff.event.eventId;
    const dangers = dangerOutcomes(result.outcomes);
    let path: SafetyEntry["path"] = "none";
    let lineId: string | null = null;
    let handedAfter: number | null = null;
    let state: EventState = "done";
    let failure = false;

    // The outcome labels the hold (if any) is handed on with; a late verdict's replace its stand-in's. A danger applied
    // again (its first try was cut off, or its line failed) keeps every label its reads found, as its hold keeps the
    // strictest rule.
    const again = dangers.length > 0 && this.dangerPending(eventId);
    const outcomes = again
      ? [...new Set([...this.outcomesOf(eventId), ...result.outcomes])]
      : result.outcomes;
    sql.exec(
      "INSERT OR REPLACE INTO safety_outcomes (event_id, outcomes) VALUES (?, ?)",
      eventId,
      JSON.stringify(outcomes),
    );
    try {
      if (dangers.length > 0) {
        // Noted before any send: until the line has gone and its record is kept, an eviction cannot lose it. Its hold is
        // written in the same step, before the core is called (round 4), from every outcome kept for it: the text is among
        // the holds from here on, whatever cuts the work off, so its batch goes on and its hold binds the commit.
        this.markDangerPending(eventId);
        this.holdFromOutcomes(
          eventId,
          outcomes,
          result.dangerWords.some((match) => match.list === "plugin"),
        );
        this.markDanger(eventId);
        const sent = await this.sendDanger(set, handoff, arrivedAt, result);
        path = sent.path;
        lineId = sent.lineId;
        handedAfter = sent.handedAfterMs;
        if (sent.failed) {
          state = "lineFailed";
          failure = true;
        }
      } else if (result.timedOut) {
        // Routine work stays held: no read said it is safe. The hold is made before the outage line is tried, so a send
        // that throws still leaves the text unread, never read (T-1088: an unread text keeps its batch back), and its
        // first re-read is set with it, 30 s on: the text is read again until a verdict lands (DL-127). A late verdict
        // lifts the hold (`applyLate`).
        sql.exec(
          "INSERT OR IGNORE INTO safety_holds (event_id, hold_id, rule, blocks_booking, released) VALUES (?, NULL, 'unread', 0, 0)",
          eventId,
        );
        this.setReread(eventId, set.clock.now() + REREAD_MS);
        const sent = await this.sendOutage(set, handoff, arrivedAt);
        path = sent.path;
        lineId = sent.lineId;
        handedAfter = sent.handedAfterMs;
      }
    } catch {
      failure = true;
      state = "lineFailed";
    }

    // A danger whose line or record is not done stays scheduled: it is read again 30 s on and its line tried again, with
    // the same idempotency key.
    if (dangers.length > 0 && this.dangerPending(eventId)) this.nextReread(set, eventId);
    if (via !== "late" || dangers.length > 0) {
      this.finish(eventId, state, dangers.length > 0, path, lineId, handedAfter);
    }
    this.recordSpan(set, handoff, arrivedAt, result, modelCalls, via, path, lineId, failure);
  }

  private finish(
    eventId: string,
    state: EventState,
    danger: boolean,
    path: SafetyEntry["path"],
    lineId: string | null,
    handedAfterMs: number | null,
  ): void {
    this.host.storage.sql.exec(
      "UPDATE safety_events SET state = ?, danger = ?, path = ?, line_id = ?, handed_after_ms = ? WHERE event_id = ?",
      state,
      danger ? 1 : 0,
      path,
      lineId,
      handedAfterMs,
      eventId,
    );
  }

  private callerOf(
    handoff: SealedHandoff,
    ids: HandleIds | null,
    kind: CoreCaller["kind"] = "job",
  ): CoreCaller {
    return {
      kind,
      turnId: null,
      requestId: `safety:${handoff.event.eventId}`,
      businessId: ids?.businessId ?? null,
      personId: ids?.personId ?? null,
      traceId: handoff.traceId,
    };
  }

  private async idsOf(set: SafetyDeps): Promise<HandleIds | null> {
    try {
      return await set.directory.idsOf(this.actorName);
    } catch {
      return null;
    }
  }

  /**
   * Queues a record for the core that is not answering (T-269's write-on-return queue), sealed under the handle's key: a
   * danger's record ranks with danger, the outage line's with the rest (arch 11 line 566: "On return: danger, stops, then
   * the rest"). One key per call and text, so a text's danger record and its outage line's record both wait (QUESTIONS.md
   * CQ-79 b); the same record queued again keeps its place with the newer box.
   */
  private async keep(
    set: SafetyDeps,
    eventId: string,
    kind: "record" | "fixed",
    request: object,
  ): Promise<void> {
    const call = kind === "record" ? "recordSafetyOutcome" : "sendFixedLine";
    const key = `${call}:${eventId}`;
    const sealingKey = await set.keys.getOrCreateKey(this.handleOf());
    const box = await sealWords(
      { body: JSON.stringify(request), subject: null },
      sealingKey,
      this.actorName,
      `return:${key}`,
    );
    this.host.returns.enqueue({
      key,
      call,
      rank: kind === "record" ? "danger" : "rest",
      box: JSON.stringify(box),
    });
  }

  /**
   * Writes a danger outcome's hold in place of the text's unread hold. Written again for the same text (the core's hold
   * after the one written before its call, or its danger applied again after a cut or a failed line), it is never looser
   * than the open one: the stricter rule stays (a threat's is never released, A3-48), as do a hold id the core gave and a
   * booking block. Returns the rule kept.
   */
  private writeHold(
    eventId: string,
    holdId: string | null,
    rule: ReleaseRule,
    blocksBooking: boolean,
  ): ReleaseRule {
    const { sql } = this.host.storage;
    const open = sql
      .exec<HoldRow>(
        "SELECT event_id, hold_id, rule, blocks_booking, released FROM safety_holds WHERE event_id = ? AND released = 0 AND rule <> 'unread'",
        eventId,
      )
      .toArray()[0];
    const kept = open === undefined ? rule : stricterHold(open.rule as ReleaseRule, rule);
    sql.exec(
      "INSERT OR REPLACE INTO safety_holds (event_id, hold_id, rule, blocks_booking, released) VALUES (?, ?, ?, ?, 0)",
      eventId,
      holdId ?? open?.hold_id ?? null,
      kept,
      blocksBooking || open?.blocks_booking === 1 ? 1 : 0,
    );
    return kept;
  }

  /**
   * The checked line for danger: the core's outbox row when it answers, else straight through Linq. The outcome is
   * complete (`clearDangerPending`) once the core has answered (it holds the record and the line's outbox row), or once
   * the direct line has gone (or none is needed) and its record is kept; a line that fails leaves it open. The hold
   * written before the call (`holdFromOutcomes`) stands until the core's hold takes its place, with the core's id and never
   * looser; a core answer with no hold leaves it as it is (K-09 gives no hold only for No: fails closed).
   */
  private async sendDanger(
    set: SafetyDeps,
    handoff: SealedHandoff,
    arrivedAt: number,
    result: SafetyResult,
  ): Promise<{
    path: "outbox" | "direct" | "none";
    lineId: string | null;
    handedAfterMs: number | null;
    failed: boolean;
  }> {
    const eventId = handoff.event.eventId;
    const ids = await this.idsOf(set);
    const request: RecordSafetyOutcomeRequest = {
      caller: this.callerOf(handoff, ids),
      safety: result,
      handleId: ids?.handleId ?? null,
      bookingId: ids?.bookingId ?? null,
      sentByActor: null,
    };
    // A core that throws at once is not answering either (round 2 security note b): the hold is still written and the
    // line still goes, straight through Linq.
    const answer = await Promise.resolve()
      .then(() => set.core.recordSafetyOutcome(request))
      .catch((): CoreError => ({ error: "transient" }));
    if (!isError(answer)) {
      const handedAfterMs = set.clock.now() - arrivedAt;
      const hold = answer.hold;
      const kept =
        hold === null ? null : this.writeHold(eventId, hold.holdId, hold.releaseRule, hold.blocksBooking);
      this.clearDangerPending(eventId);
      if (hold !== null && kept === "at_once") await this.releaseAtOnce(set, handoff, hold.holdId, eventId);
      return {
        path: answer.safetyLine === null ? "none" : "outbox",
        lineId: answer.safetyLine?.fixedLineId ?? null,
        handedAfterMs,
        failed: false,
      };
    }

    // The core is not answering: the line goes straight through Linq from the bundle's copy, and the record waits.
    const rule = strictestHold(result.outcomes);
    if (rule !== null) {
      this.writeHold(
        eventId,
        null,
        rule,
        result.dangerWords.some((match) => match.list === "plugin"),
      );
    }
    const line = checkedLineFor(result, set.bundle);
    if (line === null) {
      await this.keep(set, eventId, "record", request);
      this.clearDangerPending(eventId);
      return { path: "none", lineId: null, handedAfterMs: null, failed: false };
    }
    const sent = await this.sendDirect(set, eventId, line, true);
    const handedAfterMs = set.clock.now() - arrivedAt;
    // Not sent: the outcome stays open, so the text is read again and its line tried again with the same key.
    if (sent === null) return { path: "none", lineId: line.id, handedAfterMs: null, failed: true };
    await this.keep(set, eventId, "record", { ...request, sentByActor: sent });
    this.clearDangerPending(eventId);
    return { path: "direct", lineId: line.id, handedAfterMs, failed: false };
  }

  /** The outage line to a text no verdict came for: never to a stopped number. */
  private async sendOutage(
    set: SafetyDeps,
    handoff: SealedHandoff,
    arrivedAt: number,
  ): Promise<{
    path: "outbox" | "direct" | "outage" | "none";
    lineId: string | null;
    handedAfterMs: number | null;
  }> {
    const eventId = handoff.event.eventId;
    const line = set.bundle.fixedLine("outage");
    if (line === null) return { path: "none", lineId: null, handedAfterMs: null };
    if (this.copySaysStopped() || (await set.isStopped(this.actorName))) {
      return { path: "none", lineId: line.id, handedAfterMs: null };
    }
    const ids = await this.idsOf(set);
    if (ids !== null) {
      const request: SendFixedLineRequest = {
        caller: this.callerOf(handoff, ids),
        fixedLineId: line.id,
        recipientHandleId: ids.handleId,
        sendClass: "quick_reply",
        sentByActor: null,
      };
      const answer = await set.core.sendFixedLine(request).catch((): CoreError => ({ error: "transient" }));
      if (!isError(answer)) {
        return { path: "outbox", lineId: line.id, handedAfterMs: set.clock.now() - arrivedAt };
      }
      if (answer.error === "phoneStopped") return { path: "none", lineId: line.id, handedAfterMs: null };
      const sent = await this.sendDirect(set, eventId, line, false);
      if (sent === null) return { path: "none", lineId: line.id, handedAfterMs: null };
      await this.keep(set, eventId, "fixed", { ...request, sentByActor: sent });
      return { path: "outage", lineId: line.id, handedAfterMs: set.clock.now() - arrivedAt };
    }
    const sent = await this.sendDirect(set, eventId, line, false);
    return sent === null
      ? { path: "none", lineId: line.id, handedAfterMs: null }
      : { path: "outage", lineId: line.id, handedAfterMs: set.clock.now() - arrivedAt };
  }

  /** True when the actor's own copy of the stopped flag says stopped (T-269); a copy that cannot be read says nothing. */
  private copySaysStopped(): boolean {
    try {
      return this.host.stopped?.() === true;
    } catch {
      return false;
    }
  }

  private async sendDirect(
    set: SafetyDeps,
    eventId: string,
    line: CheckedLine,
    overrideOptout: boolean,
  ): Promise<SentByActor | null> {
    try {
      const { linqMessageId } = await set.direct.send({
        actorName: this.actorName,
        fixedLineId: line.id,
        text: line.text,
        overrideOptout,
        idempotencyKey: `safety:${eventId}:${line.id}`,
      });
      return { at: new Date(set.clock.now()).toISOString(), fixedLineId: line.id, linqMessageId };
    } catch {
      return null;
    }
  }

  /** "At once, after the outcome's message": the hold lifts once the line is handed on (arch 06 line 319). */
  private async releaseAtOnce(
    set: SafetyDeps,
    handoff: SealedHandoff,
    holdId: string,
    eventId: string,
  ): Promise<void> {
    const ids = await this.idsOf(set);
    const answer = await set.core
      .releaseSafetyHold({
        caller: this.callerOf(handoff, ids),
        holdId,
        expectVersion: 1,
        why: "outcome_message_sent",
        releasedByOutcomeId: null,
      })
      .catch((): CoreError => ({ error: "transient" }));
    if (!isError(answer)) {
      this.host.storage.sql.exec("UPDATE safety_holds SET released = 1 WHERE event_id = ?", eventId);
    }
  }

  private recordSpan(
    set: SafetyDeps,
    handoff: SealedHandoff,
    arrivedAt: number,
    result: SafetyResult,
    modelCalls: ModelCall[],
    via: string,
    path: SafetyEntry["path"],
    lineId: string | null,
    failed: boolean,
  ): void {
    try {
      const context = openTrace({
        openedBy: "textWebhook",
        bundleId: handoff.bundleId,
        incomingTraceId: handoff.traceId,
        sink: this.host.spanSink(),
      });
      const eventId = handoff.event.eventId;
      const labels = result.outcomes.map((outcome) => OUTCOME_LABEL[outcome]);
      context.record({
        hop: "safetyRead",
        ms: Math.max(0, set.clock.now() - arrivedAt),
        at: new Date(arrivedAt).toISOString(),
        outcome: failed ? "failed" : result.timedOut ? "timedOut" : "ok",
        modelCalls,
        ...(isLabel(eventId) ? { eventId } : {}),
        got: { via, outcomes: labels, dangerWords: result.dangerWords.length },
        decided: {
          danger: dangerOutcomes(result.outcomes).length > 0,
          path: path ?? "none",
          line: lineId ?? null,
          // A re-read with no verdict sends nothing: no line stands in for it (the timeout rule's went once, before).
          lineFor: result.timedOut && via !== "reread" ? timeoutLineId(result.dangerWords) : null,
        },
      });
    } catch {
      // No span for this text; what was decided stands.
    }
  }
}
