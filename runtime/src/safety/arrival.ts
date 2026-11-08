// The safety read on arrival (T-246; C-047; steps A3-22, B3-17; arch 02 step S, line 111). For each raw text the handle
// actor stores, it:
//
//   1. starts the 4 s deadline in the same step as the arrival, and sends the words to the safety read port at once, in
//      arrival order, before any batch (a second text arriving during a read is read on its own);
//   2. on a verdict with danger, hands the outcome step's checked line to the send path first: with PostgreSQL up, K-09's
//      `recordSafetyOutcome` writes it as an outbox row of send class safety, which limit 8 lets past any opt-out
//      (NQ-RT-9's default); with it down, the actor sends it straight through Linq from the bundle's copy and writes the
//      record on return (arch 11 line 566);
//   3. on no verdict in 4 s (or a read that failed), a danger-word match from the bundle's list counts as Unsure and gets
//      the safety line (988 and 911 for self-harm words, else 911); otherwise the outage line, never to a stopped number;
//   4. keeps routine work held per the outcome (arch 06 lines 317 to 327) until a hold's rule releases it.
//
// The routine work this holds is the batch's (T-247) and the turn's. This file keeps the hold's state and says so
// (`routineHeld`, `readSafety`); it does not batch. Never logged or put in a span: a word, an evidence quote, a number.

import { openWords, sealWords, type SealedWords } from "../gateway/seal";
import type { SealedHandoff } from "../gateway/types";
import { isLabel, openTrace, type SpanSink } from "../trace";
import type { ModelCall } from "../trace/types";
import {
  checkedLineFor,
  dangerOutcomes,
  matchDangerWords,
  OUTCOME_LABEL,
  strictestHold,
  timeoutLineId,
  timeoutResult,
} from "./rules";
import {
  VERDICT_DEADLINE_MS,
  type CheckedLine,
  type CoreCaller,
  type CoreError,
  type HandleIds,
  type RecordSafetyOutcomeRequest,
  type ReleaseRule,
  type SafetyDeps,
  type SafetyReadAnswer,
  type SafetyResult,
  type SendFixedLineRequest,
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

/** What opening the words gave: nothing to read, or the words and the read in flight. */
type Started =
  | { kind: "nothing" }
  | { kind: "reading"; words: SealedWords; verdict: Promise<SafetyReadAnswer | "failed"> };

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
  // A record the actor could not give the core while PostgreSQL was down, sealed under the handle's key (it holds the
  // read's evidence words), written on return.
  sql.exec(
    "CREATE TABLE IF NOT EXISTS safety_return (event_id TEXT PRIMARY KEY, kind TEXT NOT NULL, box TEXT NOT NULL)",
  );
}

/** The kinds of event whose words are read: a customer's text, a caption, a vote's words, an edit. */
const READ_KINDS: readonly string[] = ["text", "photo", "pollVote", "edit"];

export function isReadable(handoff: SealedHandoff): boolean {
  const { event } = handoff;
  return READ_KINDS.includes(event.kind) && event.sealed !== null && event.fromRosie !== true;
}

export interface SafetyHost {
  storage: DurableObjectStorage;
  spanSink: () => SpanSink;
}

export class SafetyOnArrival {
  private launch: Promise<unknown> = Promise.resolve();
  private readonly pending = new Set<Promise<void>>();

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
    const work = this.settle(set, handoff, arrivedAt, deadline, started).catch(() => undefined);
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
    return work;
  }

  /** Resolves when every text that has arrived so far has been dealt with (tests; a shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /** True while routine work must wait: a text is unread, or a hold is not released. */
  routineHeld(): boolean {
    const { sql } = this.host.storage;
    const unread = sql
      .exec("SELECT 1 FROM safety_events WHERE state IN ('reading','unwired','lineFailed') LIMIT 1")
      .toArray();
    if (unread.length > 0) return true;
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
   * only its mirror of it. A threat's hold is never released (A3-48).
   */
  markHoldReleased(eventId: string): "released" | "neverReleased" | "noSuchHold" {
    const hold = this.readHolds().find((entry) => entry.eventId === eventId);
    if (hold === undefined) return "noSuchHold";
    if (hold.rule === "never") return "neverReleased";
    this.host.storage.sql.exec("UPDATE safety_holds SET released = 1 WHERE event_id = ?", eventId);
    return "released";
  }

  /**
   * Writes to the core what the actor sent straight through Linq while it was down (arch 11 line 566): each record is
   * sent again with `sentByActor`, and never as a new send. Returns how many were written; a record the core still
   * refuses stays for the next call.
   */
  async writeOnReturn(): Promise<number> {
    const set = deps;
    if (set === null) return 0;
    const rows = this.host.storage.sql
      .exec<{ event_id: string; kind: string; box: string }>(
        "SELECT event_id, kind, box FROM safety_return ORDER BY rowid",
      )
      .toArray();
    let written = 0;
    for (const row of rows) {
      let request: RecordSafetyOutcomeRequest | SendFixedLineRequest;
      try {
        const key = await set.keys.getOrCreateKey(this.handleOf());
        const opened = await openWords(
          JSON.parse(row.box) as Parameters<typeof openWords>[0],
          key,
          this.actorName,
          `return:${row.event_id}`,
        );
        request = JSON.parse(opened.body ?? "null") as RecordSafetyOutcomeRequest | SendFixedLineRequest;
      } catch {
        continue;
      }
      const onReturn = { ...request, caller: { ...request.caller, kind: "actorOnReturn" as const } };
      try {
        const answer =
          row.kind === "record"
            ? await set.core.recordSafetyOutcome(onReturn as RecordSafetyOutcomeRequest)
            : await set.core.sendFixedLine(onReturn as SendFixedLineRequest);
        if (isError(answer)) continue;
        this.host.storage.sql.exec("DELETE FROM safety_return WHERE event_id = ?", row.event_id);
        if (row.kind === "record" && "hold" in answer && answer.hold !== null) {
          this.host.storage.sql.exec(
            "UPDATE safety_holds SET hold_id = ? WHERE event_id = ? AND hold_id IS NULL",
            answer.hold.holdId,
            row.event_id,
          );
        }
        written += 1;
      } catch {
        continue;
      }
    }
    return written;
  }

  // ---- the read -------------------------------------------------------------------------------------------------

  private handleOf(): { kind: string; address: string } {
    const at = this.actorName.indexOf(":");
    return { kind: this.actorName.slice(0, at), address: this.actorName.slice(at + 1) };
  }

  /** Opens the box and starts the read, behind the earlier texts' starts, so the port is called in arrival order. */
  private queueRead(set: SafetyDeps, handoff: SealedHandoff): Promise<Started | "unreadable"> {
    const { event } = handoff;
    const sealed = event.sealed;
    const opened: Promise<SealedWords | "unreadable"> =
      sealed === null
        ? Promise.resolve({ body: null, subject: null })
        : set.keys.getOrCreateKey(event.handle).then(
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
    if (first !== "failed" && first !== "deadline") {
      await this.applyResult(set, handoff, arrivedAt, first.result, first.modelCalls, "verdict");
      return;
    }

    // No verdict: the 4 s deadline passed, or the read failed. A danger word from the bundle's list counts as Unsure.
    const opened = await started.catch(() => "unreadable" as const);
    const words = opened === "unreadable" || opened.kind === "nothing" ? null : opened.words;
    const matches =
      words === null ? [] : matchDangerWords([words.body, words.subject], set.bundle.dangerWords());
    const stand = timeoutResult(eventId, matches);
    await this.applyResult(set, handoff, arrivedAt, stand, timeoutCalls(), first);

    // A verdict that arrives late changes a timeout that found no danger word: it is applied then, and the unread hold lifts.
    // It is not waited for: a read that never answers must not keep the text's work open.
    if (
      first === "deadline" &&
      matches.length === 0 &&
      opened !== "unreadable" &&
      opened.kind === "reading"
    ) {
      void opened.verdict
        .then(async (late) => {
          if (late !== "failed" && !late.result.timedOut) {
            await this.applyResult(set, handoff, arrivedAt, late.result, late.modelCalls, "late");
          }
        })
        .catch(() => undefined);
    }
  }

  private async applyResult(
    set: SafetyDeps,
    handoff: SealedHandoff,
    arrivedAt: number,
    result: SafetyResult,
    modelCalls: ModelCall[],
    via: "verdict" | "deadline" | "failed" | "late",
  ): Promise<void> {
    const { sql } = this.host.storage;
    const eventId = handoff.event.eventId;
    const dangers = dangerOutcomes(result.outcomes);
    let path: SafetyEntry["path"] = "none";
    let lineId: string | null = null;
    let handedAfter: number | null = null;
    let state: EventState = "done";
    let failure = false;

    try {
      if (dangers.length > 0) {
        const sent = await this.sendDanger(set, handoff, arrivedAt, result);
        path = sent.path;
        lineId = sent.lineId;
        handedAfter = sent.handedAfterMs;
        if (sent.failed) {
          state = "lineFailed";
          failure = true;
        }
      } else if (result.timedOut) {
        const sent = await this.sendOutage(set, handoff, arrivedAt);
        path = sent.path;
        lineId = sent.lineId;
        handedAfter = sent.handedAfterMs;
        // Routine work stays held: no read said it is safe.
        sql.exec(
          "INSERT OR IGNORE INTO safety_holds (event_id, hold_id, rule, blocks_booking, released) VALUES (?, NULL, 'unread', 0, 0)",
          eventId,
        );
      } else if (via === "late") {
        sql.exec("UPDATE safety_holds SET released = 1 WHERE event_id = ? AND rule = 'unread'", eventId);
      }
    } catch {
      failure = true;
      state = "lineFailed";
    }

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

  private async keep(
    set: SafetyDeps,
    eventId: string,
    kind: "record" | "fixed",
    request: object,
  ): Promise<void> {
    const key = await set.keys.getOrCreateKey(this.handleOf());
    const box = await sealWords(
      { body: JSON.stringify(request), subject: null },
      key,
      this.actorName,
      `return:${eventId}`,
    );
    this.host.storage.sql.exec(
      "INSERT OR REPLACE INTO safety_return (event_id, kind, box) VALUES (?, ?, ?)",
      eventId,
      kind,
      JSON.stringify(box),
    );
  }

  /** The checked line for danger: the core's outbox row when it answers, else straight through Linq. */
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
    const answer = await set.core
      .recordSafetyOutcome(request)
      .catch((): CoreError => ({ error: "transient" }));
    if (!isError(answer)) {
      const handedAfterMs = set.clock.now() - arrivedAt;
      const hold = answer.hold;
      if (hold !== null) {
        this.host.storage.sql.exec(
          "INSERT OR REPLACE INTO safety_holds (event_id, hold_id, rule, blocks_booking, released) VALUES (?, ?, ?, ?, 0)",
          eventId,
          hold.holdId,
          hold.releaseRule,
          hold.blocksBooking ? 1 : 0,
        );
        if (hold.releaseRule === "at_once") await this.releaseAtOnce(set, handoff, hold.holdId, eventId);
      }
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
      this.host.storage.sql.exec(
        "INSERT OR REPLACE INTO safety_holds (event_id, hold_id, rule, blocks_booking, released) VALUES (?, NULL, ?, ?, 0)",
        eventId,
        rule,
        result.dangerWords.some((match) => match.list === "plugin") ? 1 : 0,
      );
    }
    const line = checkedLineFor(result, set.bundle);
    if (line === null) {
      await this.keep(set, eventId, "record", request);
      return { path: "none", lineId: null, handedAfterMs: null, failed: false };
    }
    const sent = await this.sendDirect(set, eventId, line, true);
    const handedAfterMs = set.clock.now() - arrivedAt;
    if (sent === null) return { path: "none", lineId: line.id, handedAfterMs: null, failed: true };
    await this.keep(set, eventId, "record", { ...request, sentByActor: sent });
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
    if (await set.isStopped(this.actorName)) return { path: "none", lineId: line.id, handedAfterMs: null };
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
          lineFor: result.timedOut ? timeoutLineId(result.dangerWords) : null,
        },
      });
    } catch {
      // No span for this text; what was decided stands.
    }
  }
}
