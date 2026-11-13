// The actor's own copies (T-269; C-053; arch 02 layer table "Conversation runtime", line 135: "Safety and STOP lines even
// when the database is down"; arch 10 "Durability", line 522; arch 11 "PostgreSQL down", line 566; BP rule 3). Each handle
// actor keeps, in its own storage, what it needs to send safety and STOP lines while PostgreSQL is down, refreshed on every
// write it is told of:
//
//   - the handle's stopped flag (K-04 v1 `phones.stopped`, one flag for every business): copied from each commit that
//     comes back committed with a recordStopOrStart result (first or repeated), in the lease's commit before the run that
//     sent it is answered (`readCommit`; ../lease.ts `committed`), so after a STOP it is set before that turn's stop reply
//     can go, and a START clears it the same way. The phone row's version orders the writes: an answer older than the copy
//     changes nothing (a repeat answers its first commit, whose version may be behind a later START). While a refusal
//     holds the stop rank of the write-on-return queue, the copy reads stopped, the stricter reading, whatever was copied
//     last, until every stop or start record queued (any START among them) is written in order (DL-167 ruling 2). A commit
//     that went through with its answer lost (a park answered alreadyCommitted: ../lease.ts `commitLost`, T-1206) may have
//     written the flag unseen, so the copy reads stopped from then on (`noteLostCommit`), each lost commit with its own
//     mark. Only three things end a mark (DL-427): a fresh read of the handle's phone row (`rereadStopped`, sent after the
//     mark was set), the actor's own version-less STOP or START note, and a committed answer from the lost turn itself
//     or from a turn the lease opened after it (the lease's turn order, never versions alone: the copy never holds the
//     lost commit's version). A late answer from an earlier turn ends none, whatever its version. The actor's own STOP
//     note (taken while PostgreSQL was down, with no version: its record waits in the write-on-return queue) is replaced
//     by a versioned write only from a turn the lease opened after the note, or from the replay's answer for the note's
//     own text (the note keeps that text's event id), never by an earlier turn's answer, whatever its version, nor by the
//     replay's answer for any other queued text, whatever its kind or version, nor by a row read (T-1208; DL-427's turn
//     order; DL-431);
//   - the checked safety lines (K-01 v1): every line the safety read can send (911, 988 and 911, the danger question, the
//     outage line, and each outcome step's own line), copied from the safety read's bundle each time a text is written
//     (`refreshLines`). A line the bundle gives no words for now keeps the words copied before: a bundle that cannot be
//     read never takes a safety line from the actor;
//   - each live safety timer of the handle (K-34 v1 `safety_timers`, running or missed): its due time and zone, the job's
//     address exactly as K-34 seals it (under its person's key: never opened here), and the emergency contact who said
//     yes (their person and handle). A commit that may have written a timer row reloads them all (`refreshTimers`): its
//     rows name the row, a core action's result may have written it, it is a repeat (whose first answer, maybe lost, named
//     the rows: by K-09's flag or the lease's, T-1204), or its answer cannot be read (`readCommit`, T-1198, DL-413); a
//     reload that fails keeps the copy as it was and marks it stale, and every later commit reloads until one succeeds. A
//     commit whose answer was lost (T-1206) marks the copy stale at once (`markTimersStale`), then reloads it. A reload
//     ends only the stale marks noted before it was sent (T-1208): one noted while it was on its way stays, since the
//     commit it marks may have written a row that read began before.
//
// A mark that cannot be stored (a lost commit's, or the timers' stale mark) is kept in this instance's memory instead
// (DL-427 ruling 4), so a storage that fails never leaves the flag or the timers unmarked while the instance lives; an
// eviction loses what only memory held.
//
// T-270 adds the keyword list and the stop and start replies (`refreshKeywords`): K-01 v1 `lists.keywords` and the
// `stopReply` and `startReply` fixed lines, copied from the manifest of each bundle a turn pins, so the actor reads a STOP or
// a START by the bundle's own words, and replies with the bundle's words (or Q-01's drafted ones while Jay's wait), while
// PostgreSQL is down. A list the guard could not read is never copied: the copy keeps the list it had. Before a handle's
// first pin, while no list is held, the actor copies the list of the bundle a text arrived under the same way, from that
// bundle's manifest as its BUNDLES binding holds it (T-1324, ../handle-actor.ts).
//
// The queue of writes to replay when PostgreSQL returns is ./return-queue.ts. Sending from the copies while PostgreSQL is
// down, and firing a timer from its copy, are runtime/src/outage/db's (T-270). Never logged, put in a span or an error: a
// number, an address, a contact's name, a line's or a text's words.

import { keywordsOf } from "../../guard/keywords";
import { fixedLinesOf, START_REPLY, STOP_REPLY } from "../../guard/replies/words";
import { isLabel } from "../../trace";
import { createReturnTables, readHeld } from "./return-queue";
import type {
  CheckedLineCopy,
  CommitCopies,
  CopyDeps,
  KeywordCopy,
  LineRead,
  LostCommitHold,
  SafetyTimerCopy,
  StoppedCopy,
  StoppedRefresh,
  StoppedWrite,
  TimerRefresh,
} from "./types";

let deps: CopyDeps | null = null;

/** Sets what the copies reach outside the actor for this Worker isolate; returns the function that puts the earlier one back. */
export function setCopyDeps(next: CopyDeps | null): () => void {
  const before = deps;
  deps = next;
  return () => {
    deps = before;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

// ---- what a commit says ---------------------------------------------------------------------------------------------

/** K-34's table of safety timers, as K-05 v1 names a written row's table. */
const TIMERS_TABLE = "safety_timers";

/** A written row (K-05 v1 rowRef) that names K-34's table, or names no table, so it cannot be told not to (fails safe). */
function mayNameTimers(row: unknown): boolean {
  return !isRecord(row) || typeof row.table !== "string" || row.table === TIMERS_TABLE;
}

/** K-09's refusal of a core action: each of its errors is a JSON object with its own "error" code (K-09 v1 `*.errors`). */
function isRefusal(error: unknown): boolean {
  return isRecord(error) && typeof error.error === "string";
}

/**
 * K-09's core actions (v1 `coreAction`, which v1.1 to v1.6 take by reference): none writes a K-34 safety_timers row (K-09
 * names that table in none of their writes, T-1194's security review). A core action is known by its call alone.
 */
const CORE_CALLS_WITHOUT_TIMERS: ReadonlySet<string> = new Set([
  "recordSafetyOutcome",
  "releaseSafetyHold",
  "recordStopOrStart",
  "setRecordFlag",
  "handOff",
  "answerHandOff",
  "pageTeam",
  "acknowledgePage",
  "openReviewItem",
  "enterDoor",
  "sendFixedLine",
  "sendProofCode",
  "proveCode",
  "issueChatLink",
  "saveSetupStep",
]);

/**
 * True when a core result may have written a K-34 safety_timers row (T-1198). K-09's `written` leaves a core action's rows
 * out, its response naming them in its own words (actions/src/commit default 9; K-09 v1.5 default 134), so a core action
 * that writes a timer is known by its result alone: one that went through (error null, a response) for a call that is not
 * one of K-09's core actions above, which write none. A result that is not K-09's coreResult cannot say what it wrote, so
 * it may have (fails safe, DL-413): not a record, no string call, no error field, an error that is not K-09's refusal, or
 * no response though it went through. Only a refused core action (nothing written: K-09) or one of the core actions above
 * that went through reads no.
 */
function coreMayWriteTimers(result: unknown): boolean {
  if (!isRecord(result) || typeof result.call !== "string") return true;
  if (isRefusal(result.error)) return false;
  if (result.error !== null || !isRecord(result.response)) return true;
  return !CORE_CALLS_WITHOUT_TIMERS.has(result.call);
}

/**
 * Whether a commit may have written a K-34 safety_timers row, so the actor reloads the timers' copy (T-1198, DL-413). It
 * reads no only where the answer says so in its contract's shape; what it cannot read reloads, since one more read costs
 * less than a copy behind a timer while PostgreSQL is down (arch 11 lines 566 and 568):
 *
 *   - K-09's answer (`written` a record: K-05's commitResult, without the rows a core action wrote, T-1194). A repeat
 *     (`repeated` true) answers its first commit with no rows (K-05 v1 commitResult), and that first answer may have been
 *     lost with the rows it named, so a repeat reloads (T-1203); so does an answer whose `repeated` is not a boolean, or
 *     whose core results or rows are not lists. A first answer (`repeated` false) reloads when a row may name the table,
 *     or a core result may have written one (`coreMayWriteTimers`).
 *   - K-05's own commitResult (`written` a list, every row the commit wrote): when a row may name the table, or a core
 *     result, if any, may have written one. Its repeat is not flagged inside it: `readCommit` reads the lease's `repeated`
 *     for it (T-1204).
 *   - `written` in neither shape: when a core result, if any, may have written one.
 */
function timersMayBeWritten(committed: Record<string, unknown>, core: readonly unknown[] | null): boolean {
  const written = committed.written;
  if (isRecord(written)) {
    if (committed.repeated !== false || core === null || !Array.isArray(written.written)) return true;
    return (written.written as unknown[]).some(mayNameTimers) || core.some(coreMayWriteTimers);
  }
  const rows = Array.isArray(written) ? (written as unknown[]) : [];
  return rows.some(mayNameTimers) || (core ?? []).some(coreMayWriteTimers);
}

/**
 * What a committed answer gives the copies (the lease's `committed`: K-09 v1 gateAndCommit.committed through the turn's
 * commit hook, or K-05 v1 commitTurn's commitResult). The stopped flag is the last recordStopOrStart result the core took,
 * in the actions' order, with its phone row's version (a repeat's too: it answers its first commit). Whether a safety
 * timer may have been written is `timersMayBeWritten`'s, never `written` alone: since T-1194, K-09's `written` lists only
 * the walk's and the parts' rows. An answer that is not a record gives no stopped flag.
 *
 * `lease` is the lease's own answer around it (../lease.ts CommitTurnCommitted, T-1204): its `repeated` is K-05 v1
 * commitTurn.response's, which K-05's commitResult does not carry inside it. A repeat reloads the timers whatever the
 * answer's shape (T-1203's rule: its first answer, maybe lost, named the rows), and so does a flag that is not false (it may
 * be a repeat: fails safe, DL-413). On K-09's path the lease's flag is K-09's own (../../turn/turn.ts
 * commitThroughToolApi), so it reads as before. Left out (a caller with the answer alone), the answer alone decides.
 */
export function readCommit(committed: unknown, lease?: { readonly repeated: unknown }): CommitCopies {
  const repeat = lease === undefined ? false : lease.repeated !== false;
  if (!isRecord(committed)) return { stopped: null, timersWritten: repeat };
  const core = Array.isArray(committed.core) ? (committed.core as unknown[]) : null;
  let stopped: CommitCopies["stopped"] = null;
  for (const result of core ?? []) {
    if (!isRecord(result) || result.call !== "recordStopOrStart" || result.error !== null) continue;
    const response = result.response;
    if (!isRecord(response) || typeof response.stopped !== "boolean" || !isCount(response.phoneVersion))
      continue;
    stopped = { stopped: response.stopped, phoneVersion: response.phoneVersion };
  }
  return { stopped, timersWritten: repeat || timersMayBeWritten(committed, core) };
}

// ---- the stored copies ----------------------------------------------------------------------------------------------

interface StoppedRow extends Record<string, SqlStorageValue> {
  stopped: number;
  phone_version: number | null;
  turn_id: string | null;
  set_ms: number;
}

interface LineRow extends Record<string, SqlStorageValue> {
  slot: string;
  line_id: string;
  text: string;
  refreshed_ms: number;
}

interface TimerRow extends Record<string, SqlStorageValue> {
  timer_id: string;
  state: string;
  version: number;
  due_at: string;
  due_zone: string;
  address: string;
  address_for: string;
  contact_person_id: string;
  contact_handle_id: string;
  worker_handle_id: string;
  clock_row_id: string;
  business_id: string;
  booking_id: string | null;
  refreshed_ms: number;
}

export function createCopyTables(sql: SqlStorage): void {
  // The handle's stopped flag: one row at most.
  sql.exec(
    `CREATE TABLE IF NOT EXISTS copy_stopped (
       one INTEGER PRIMARY KEY CHECK (one = 1),
       stopped INTEGER NOT NULL,
       phone_version INTEGER,
       turn_id TEXT,
       set_ms INTEGER NOT NULL
     )`,
  );
  // The commits whose answers were lost, whose stopped flag the copy has not read (T-1206): one row each, in the order
  // noted, with the order the lease opened its turn in (../lease.ts lease_turns.seq; null when not known). None when none.
  sql.exec(
    `CREATE TABLE IF NOT EXISTS copy_lost_commits (
       noted INTEGER PRIMARY KEY AUTOINCREMENT,
       turn_id TEXT NOT NULL UNIQUE,
       turn_opened INTEGER,
       since_ms INTEGER NOT NULL
     )`,
  );
  // The checked safety lines, one per place the safety read uses one: the sources' fixed words, never a person's.
  sql.exec(
    `CREATE TABLE IF NOT EXISTS copy_lines (
       slot TEXT PRIMARY KEY,
       line_id TEXT NOT NULL,
       text TEXT NOT NULL,
       refreshed_ms INTEGER NOT NULL
     )`,
  );
  // The handle's live safety timers (K-34 v1 safety_timers): the address as K-34 seals it, never in plain.
  sql.exec(
    `CREATE TABLE IF NOT EXISTS copy_timers (
       timer_id TEXT PRIMARY KEY,
       state TEXT NOT NULL,
       version INTEGER NOT NULL,
       due_at TEXT NOT NULL,
       due_ms INTEGER NOT NULL,
       due_zone TEXT NOT NULL,
       address TEXT NOT NULL,
       address_for TEXT NOT NULL,
       contact_person_id TEXT NOT NULL,
       contact_handle_id TEXT NOT NULL,
       worker_handle_id TEXT NOT NULL,
       clock_row_id TEXT NOT NULL,
       business_id TEXT NOT NULL,
       booking_id TEXT,
       refreshed_ms INTEGER NOT NULL
     )`,
  );
  // Since when the timers' copy is behind a write it was told of (its reload failed): absent when it is not.
  sql.exec("CREATE TABLE IF NOT EXISTS copy_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
  // The text the actor's own note was taken for (T-1208, DL-431): one row at most, its event id; none while the copy holds
  // a versioned write, or a note that named no text. A table of its own, so a copy made before it gains it as it starts.
  sql.exec(
    `CREATE TABLE IF NOT EXISTS copy_note (
       one INTEGER PRIMARY KEY CHECK (one = 1),
       event_id TEXT NOT NULL
     )`,
  );
  // The pinned bundle's keyword list and the stop and start replies (T-270): one row at most, the sources' words only.
  sql.exec(
    `CREATE TABLE IF NOT EXISTS copy_keywords (
       one INTEGER PRIMARY KEY CHECK (one = 1),
       keywords TEXT NOT NULL,
       replies TEXT NOT NULL,
       refreshed_ms INTEGER NOT NULL
     )`,
  );
}

interface KeywordRow extends Record<string, SqlStorageValue> {
  keywords: string;
  replies: string;
  refreshed_ms: number;
}

/** The replies the copy keeps beside the keyword list: the stop and start replies (K-01 ids). */
const KEYWORD_REPLIES = [STOP_REPLY, START_REPLY] as const;

/** K-34's form of a zone name (`safety_timers_due_zone_form`). */
const ZONE_FORM = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/u;
/** A UTC instant as the contracts write one (CQ-09): RFC 3339, ending in Z. */
const UTC_FORM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u;

type TimerValues = Omit<SafetyTimerCopy, "refreshedAt"> & { dueMs: number };

/**
 * One K-34 row as the copy keeps it; null when it is not a live timer of this handle (another handle's, or safe), or
 * "bad" when it is not K-34's row (an id that is not a label, a due time that is not an instant, no sealed address).
 */
function timerOf(value: unknown, handleId: string): TimerValues | null | "bad" {
  if (!isRecord(value)) return "bad";
  const ids = [
    value.id,
    value.business_id,
    value.worker_handle_id,
    value.emergency_contact_person_id,
    value.emergency_contact_handle_id,
    value.address_for_person_id,
    value.clock_row_id,
  ];
  if (!ids.every(isLabel)) return "bad";
  const bookingId = value.booking_id;
  if (bookingId !== null && !isLabel(bookingId)) return "bad";
  const { state, version, due_at: dueAt, due_zone: dueZone, address } = value;
  if (state !== "running" && state !== "missed" && state !== "safe") return "bad";
  if (!isCount(version)) return "bad";
  if (typeof dueAt !== "string" || !UTC_FORM.test(dueAt) || !Number.isFinite(Date.parse(dueAt))) return "bad";
  if (typeof dueZone !== "string" || !ZONE_FORM.test(dueZone)) return "bad";
  if (typeof address !== "string" || address === "") return "bad";
  if (value.worker_handle_id !== handleId || state === "safe") return null;
  return {
    timerId: value.id as string,
    state,
    version,
    dueAt,
    dueMs: Date.parse(dueAt),
    dueZone,
    address,
    addressFor: value.address_for_person_id as string,
    contact: {
      personId: value.emergency_contact_person_id as string,
      handleId: value.emergency_contact_handle_id as string,
    },
    workerHandleId: handleId,
    clockRowId: value.clock_row_id as string,
    businessId: value.business_id as string,
    bookingId,
  };
}

/** The live timers of a reload's answer; null when the answer is not the reload's or holds a row that is not K-34's. */
function timersOf(answer: unknown, handleId: string): TimerValues[] | null {
  if (!isRecord(answer) || answer.result !== "timers" || !Array.isArray(answer.timers)) return null;
  const timers: TimerValues[] = [];
  for (const value of answer.timers as unknown[]) {
    const timer = timerOf(value, handleId);
    if (timer === "bad") return null;
    if (timer !== null) timers.push(timer);
  }
  return timers;
}

export interface CopiesHost {
  storage: DurableObjectStorage;
  /** The actor's clock (the stored schedule's). */
  now(): number;
  /**
   * The order of the last turn the lease has opened (../lease.ts lease_turns.seq; 0 when none): the actor's own note of
   * the stopped flag keeps it, so only a turn opened after the note may replace it (T-1208). Left out, or a throw, or an
   * answer that is not a count: not known, and no turn's answer replaces the actor's own STOP note (fails closed).
   */
  turnsOpened?(): number;
}

const STALE = "timersStaleSince";
/** The order of the last turn the lease had opened when the actor's own note was taken (T-1208): absent when not known. */
const NOTE_TURNS = "noteTurnsOpened";

/** A turn order as the lease keeps it: 0 (no turn opened yet) or more. */
const isOrder = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** The text a write names (`StoppedWrite.eventId`: an event id), or null when it names none. */
const textOf = (write: StoppedWrite): string | null =>
  typeof write.eventId === "string" && write.eventId !== "" ? write.eventId : null;

/** The stopped flag of a re-read's answer (K-04 phones.stopped and version); null when the answer is not K-04's row. */
function stoppedFlagOf(answer: unknown): { stopped: boolean; phoneVersion: number } | null {
  if (!isRecord(answer) || answer.result !== "phone") return null;
  const { stopped, phoneVersion } = answer;
  if (typeof stopped !== "boolean" || !isCount(phoneVersion)) return null;
  return { stopped, phoneVersion };
}

/** A commit whose answer was lost, whose stopped flag the copy has not read (T-1206), as the copy keeps its mark. */
interface LostMark {
  readonly turnId: string;
  /** The order the lease opened its turn in (../lease.ts lease_turns.seq), or null when not known. */
  readonly opened: number | null;
  /** Since the park told of it, on the actor's clock. */
  readonly since: number;
}

/**
 * Which lost commits' marks a stopped flag taken ends (DL-427 ruling 1); no other write ends one:
 *   - `all`: the actor's own version-less STOP or START note, the person's latest word;
 *   - `openedBy`: a committed answer of the turn the lease opened in this place: the marks of the lost turns opened no
 *     later (the lost turn itself, or an earlier one). That turn's commit came after every such lost commit went through,
 *     since a turn opens only once the turn before it has finished;
 *   - `noted`: a fresh read of the phone row, by the turn ids marked when it was sent: each of those commits went through
 *     before its mark, so before the read;
 *   - `none`: any other write (the write-on-return replay's answer, a write with no turn order).
 */
type LostEnds =
  | { readonly kind: "all" }
  | { readonly kind: "openedBy"; readonly opened: number }
  | { readonly kind: "noted"; readonly turnIds: readonly string[] }
  | { readonly kind: "none" };

function endsMark(ends: LostEnds, mark: LostMark): boolean {
  switch (ends.kind) {
    case "all":
      return true;
    case "openedBy":
      return mark.opened !== null && mark.opened <= ends.opened;
    case "noted":
      return ends.turnIds.includes(mark.turnId);
    default:
      return false;
  }
}

export class ActorCopies {
  /** The reload of the timers running in this instance, if any: the next one waits for it, so the last write wins. */
  private timerWork: Promise<unknown> = Promise.resolve();
  /** The re-read of the stopped flag running in this instance, if any: the next one waits for it. */
  private stoppedWork: Promise<unknown> = Promise.resolve();
  /** Lost commits whose mark the storage could not keep (DL-427 ruling 4): held in this instance's memory instead. */
  private unstoredLost: LostMark[] = [];
  /**
   * How many times the timers' copy was marked behind in this instance (T-1208): a reload ends only the marks noted
   * before it was sent. A reload lives in one instance, so a count kept in memory places each mark against it.
   */
  private staleNoted = 0;
  /**
   * The latest timers' stale mark (by `staleNoted`) the storage could not keep, held in memory instead (DL-427 ruling 4),
   * or null when none.
   */
  private staleUnstored: number | null = null;

  constructor(private readonly host: CopiesHost) {
    createCopyTables(host.storage.sql);
    // The stop rank's hold is the write-on-return queue's own (./return-queue.ts): its tables are made here too, so the
    // stopped flag can be read whichever is made first.
    createReturnTables(host.storage.sql);
  }

  private get sql(): SqlStorage {
    return this.host.storage.sql;
  }

  // ---- the stopped flag -------------------------------------------------------------------------------------------

  /**
   * The handle's stopped flag as last copied, or null when no write of it has been seen. While a refusal holds the stop
   * rank of the write-on-return queue (DL-167 ruling 2), it reads stopped, the stricter reading, whatever was copied last,
   * with `held` naming the refusal: until every stop or start record queued (any START among them) is written in order.
   * While a commit whose answer was lost may have written the flag (T-1206), it reads stopped the same way, with `lost`
   * naming the lost commit noted last: until rule 1 of DL-427 ends every lost commit's mark (`noteStopped`).
   */
  readStopped(): StoppedCopy | null {
    const copied = this.copiedStopped();
    const held = readHeld(this.sql).find((entry) => entry.rank === "stop");
    const lost = this.lostMarks().at(-1) ?? null;
    if (held === undefined && lost === null) return copied;
    return {
      stopped: true,
      phoneVersion: copied?.phoneVersion ?? null,
      turnId: copied?.turnId ?? null,
      setAt: copied?.setAt ?? held?.since ?? lost?.since ?? this.host.now(),
      ...(held === undefined ? {} : { held: { key: held.key, code: held.code, since: held.since } }),
      ...(lost === null ? {} : { lost: { turnId: lost.turnId, since: lost.since } satisfies LostCommitHold }),
    };
  }

  /**
   * True while a commit whose answer was lost may have written the stopped flag, not read yet (T-1206); a storage that
   * cannot say answers true (one more re-read). Never throws.
   */
  stoppedUnread(): boolean {
    try {
      return this.lostMarks().length > 0;
    } catch {
      return true;
    }
  }

  /**
   * The lost commits whose stopped flag the copy has not read (T-1206), in the order noted: the stored marks, and those
   * only memory holds (DL-427 ruling 4) placed by when they were noted.
   */
  private lostMarks(): LostMark[] {
    const stored = this.sql
      .exec<{ turn_id: string; turn_opened: number | null; since_ms: number }>(
        "SELECT turn_id, turn_opened, since_ms FROM copy_lost_commits ORDER BY noted",
      )
      .toArray()
      .map((row): LostMark => ({ turnId: row.turn_id, opened: row.turn_opened, since: row.since_ms }));
    if (this.unstoredLost.length === 0) return stored;
    // A stable sort: of two noted at once, the stored one first.
    return [...stored, ...this.unstoredLost].sort((a, b) => a.since - b.since);
  }

  /** The stopped flag as last copied from a write, without the queue's hold. */
  private copiedStopped(): StoppedCopy | null {
    const row = this.sql
      .exec<StoppedRow>("SELECT stopped, phone_version, turn_id, set_ms FROM copy_stopped WHERE one = 1")
      .toArray()[0];
    if (row === undefined) return null;
    return {
      stopped: row.stopped === 1,
      phoneVersion: row.phone_version,
      turnId: row.turn_id,
      setAt: row.set_ms,
    };
  }

  /**
   * Copies a stopped flag that was written; true when the copy took it. The actor's own note (no version) is always taken,
   * with the order of the last turn the lease had opened then (`CopiesHost.turnsOpened`) and the text it was taken for
   * (`eventId`). A write with the phone row's version is taken unless the copy holds a later version, or holds the actor's
   * own STOP note: that is replaced only by a commit's answer from a turn the lease opened after the note (by `opened`,
   * never by versions alone: DL-427), or by the write-on-return replay's answer for the note's own text (a write with no
   * turn, by `eventId`: DL-431), never by an earlier turn's late answer, whatever its version, nor by the replay's answer
   * for any other queued text, whatever its kind or version, nor by a turn's answer the lease gave no order (T-1208). A
   * write taken while the stop rank is held is kept, and read once the hold is let go. A write ends the lost commits' marks
   * (T-1206) that DL-427's rule 1 lets it end, and no other: the actor's own note ends every mark; a commit's answer, with
   * the order the lease opened its turn in (`opened`), ends the marks of the lost turns opened no later than its own (the
   * lost turn's own answer come late, or a later turn's), taken or not, never one of a turn opened after it, whatever its
   * version; any other write (the write-on-return replay's answer, or one with no turn order) ends none.
   */
  noteStopped(write: StoppedWrite): boolean {
    const ends: LostEnds =
      write.phoneVersion === null
        ? { kind: "all" }
        : isCount(write.opened)
          ? { kind: "openedBy", opened: write.opened }
          : { kind: "none" };
    return this.takeStopped(write, ends);
  }

  /**
   * Copies a stopped flag by the phone row's version (`noteStopped`), and ends the lost marks `ends` names. A write the copy
   * keeps its own over (`keepsCopy`: older than the copy, or not one that may replace the actor's own note) is not taken;
   * a commit's answer still ends its marks then (the core's own word on that commit, so the copy holds a write newer
   * still), while a row read not taken ends none (it may be a stale row).
   */
  private takeStopped(write: StoppedWrite, ends: LostEnds): boolean {
    const done = this.host.storage.transactionSync((): { taken: boolean; ended: LostEnds } => {
      const kept = this.keepsCopy(write, ends, this.copiedStopped());
      const ended: LostEnds = kept && ends.kind !== "openedBy" ? { kind: "none" } : ends;
      if (!kept) {
        this.sql.exec(
          "INSERT OR REPLACE INTO copy_stopped (one, stopped, phone_version, turn_id, set_ms) VALUES (1, ?, ?, ?, ?)",
          write.stopped ? 1 : 0,
          write.phoneVersion,
          write.turnId,
          this.host.now(),
        );
        // The actor's own note keeps the order of the last turn the lease had opened as it was taken (T-1208): none for a
        // versioned write, and none when the lease's order cannot be read (then no turn's answer replaces a STOP note).
        this.sql.exec("DELETE FROM copy_meta WHERE k = ?", NOTE_TURNS);
        const opened = write.phoneVersion === null ? this.turnsOpenedNow() : null;
        if (opened !== null) {
          this.sql.exec("INSERT INTO copy_meta (k, v) VALUES (?, ?)", NOTE_TURNS, opened);
        }
        // And the text it was taken for (DL-431), so only the replay's answer for that text replaces a STOP note: none for
        // a versioned write.
        this.sql.exec("DELETE FROM copy_note WHERE one = 1");
        const text = write.phoneVersion === null ? textOf(write) : null;
        if (text !== null) this.sql.exec("INSERT INTO copy_note (one, event_id) VALUES (1, ?)", text);
      }
      if (ended.kind === "all") this.sql.exec("DELETE FROM copy_lost_commits");
      else if (ended.kind === "openedBy") {
        // A mark with no turn order is never ended this way (NULL <= n is not true).
        this.sql.exec("DELETE FROM copy_lost_commits WHERE turn_opened <= ?", ended.opened);
      } else if (ended.kind === "noted") {
        for (const turnId of ended.turnIds)
          this.sql.exec("DELETE FROM copy_lost_commits WHERE turn_id = ?", turnId);
      }
      return { taken: !kept, ended };
    });
    if (this.unstoredLost.length > 0) {
      this.unstoredLost = this.unstoredLost.filter((mark) => !endsMark(done.ended, mark));
    }
    return done.taken;
  }

  /**
   * True when the copy keeps what it holds over this write. The actor's own note (no version) is never refused: it is the
   * person's latest word. Over a versioned copy, a write older than it is refused (a repeat answers its first commit,
   * whose version may be behind a later START). Over the actor's own note, whose record may still wait in the
   * write-on-return queue, so no row read can be known to hold it:
   *   - a row read is refused, whatever its version (`rereadStopped`, T-1206);
   *   - over a STOP note (T-1208): a commit's answer is taken only from a turn the lease opened after the note was taken
   *     (the lease's turn order, never versions alone: DL-427), since that turn's commit was sent after the queue was
   *     replayed (../lease.ts `beforeCommit`), the note's record first. An earlier turn's late answer is refused whatever
   *     its version, and so is every answer while the note's order is not known. The write-on-return replay's answer (no
   *     turn) is taken only when it is for the note's own text (DL-431: the same event id, or neither naming a text): the
   *     answer for any other queued text is refused, whatever its kind or version, since the note's own record may still
   *     wait behind it (a core that does not answer for it stops the replay there). A note that names no text is
   *     replaced by no answer for a text (fails closed). A turn's answer the lease gave no order is refused;
   *   - over a START note, a versioned write is taken: a STOP it may bring reads stricter, never looser.
   */
  private keepsCopy(write: StoppedWrite, ends: LostEnds, copied: StoppedCopy | null): boolean {
    if (write.phoneVersion === null || copied === null) return false;
    if (copied.phoneVersion !== null) return write.phoneVersion < copied.phoneVersion;
    if (ends.kind === "noted") return true;
    if (!copied.stopped) return false;
    if (ends.kind === "openedBy") {
      const after = this.noteTurnsOpened();
      return after === null || ends.opened <= after;
    }
    return write.turnId !== null || textOf(write) !== this.noteText();
  }

  /** The order of the last turn the lease had opened when the actor's own note was taken (T-1208), or null when not known. */
  private noteTurnsOpened(): number | null {
    const row = this.sql.exec<{ v: number }>("SELECT v FROM copy_meta WHERE k = ?", NOTE_TURNS).toArray()[0];
    return row !== undefined && isOrder(row.v) ? row.v : null;
  }

  /** The text the actor's own note was taken for (its event id, DL-431), or null when it named none. */
  private noteText(): string | null {
    return (
      this.sql.exec<{ event_id: string }>("SELECT event_id FROM copy_note WHERE one = 1").toArray()[0]
        ?.event_id ?? null
    );
  }

  /** The order of the last turn the lease has opened now (`CopiesHost.turnsOpened`), or null when it cannot say. */
  private turnsOpenedNow(): number | null {
    try {
      const opened = this.host.turnsOpened?.();
      return isOrder(opened) ? opened : null;
    } catch {
      return null;
    }
  }

  /**
   * Notes a commit that went through with its answer lost (T-1206: a park answered alreadyCommitted), with the order the
   * lease opened its turn in: it may have written the stopped flag unseen, so the copy reads stopped, the stricter
   * reading, until DL-427's rule 1 ends its mark (`noteStopped`, `rereadStopped`). Each lost commit keeps its own mark; a
   * turn noted again keeps its first. True when the mark is stored. A storage that fails keeps the mark in this instance's
   * memory instead (DL-427 ruling 4: lost on an eviction). Never throws.
   */
  noteLostCommit(turnId: string, opened: number | null = null): boolean {
    const mark: { turnId: string; opened: number | null; since: number } = {
      turnId,
      opened: isCount(opened) ? opened : null,
      since: 0,
    };
    try {
      mark.since = this.host.now();
      this.sql.exec(
        "INSERT OR IGNORE INTO copy_lost_commits (turn_id, turn_opened, since_ms) VALUES (?, ?, ?)",
        mark.turnId,
        mark.opened,
        mark.since,
      );
      return true;
    } catch {
      if (!this.unstoredLost.some((kept) => kept.turnId === turnId)) this.unstoredLost.push(mark);
      return false;
    }
  }

  /**
   * Reads the handle's stopped flag again (K-04 phones.stopped and its version; K-04 handles.id names the handle) after
   * any re-read already running here, and copies it by the row's version. A read is fresh only for the lost commits noted
   * before it was sent (each went through before its mark): a read taken ends their marks, never one noted while it was
   * on its way. A re-read that cannot be done (not wired, no answer, an error, an answer that is not K-04's row) keeps
   * the copy as it was, the stricter reading included. A row read never replaces the actor's own note (a STOP or START it
   * took while PostgreSQL was down, with no version), whose record may not be written yet: "older". Never throws.
   */
  rereadStopped(handleId: string): Promise<StoppedRefresh> {
    const run = this.stoppedWork.then(() => this.readStoppedAgain(handleId));
    this.stoppedWork = run.catch(() => undefined);
    return run.catch((): StoppedRefresh => "failed");
  }

  private async readStoppedAgain(handleId: string): Promise<StoppedRefresh> {
    const source = deps?.phones;
    if (source === undefined || !isLabel(handleId)) return "unwired";
    // The lost commits this read is fresh for: those marked as it is sent.
    const noted = this.lostMarks().map((mark) => mark.turnId);
    let answer: unknown;
    try {
      answer = await source.stoppedFlag({ handleId });
    } catch {
      return "failed";
    }
    const read = stoppedFlagOf(answer);
    if (read === null) return "failed";
    // The actor's own note is newer than any row read (its record may still wait in the write-on-return queue).
    if (this.copiedStopped()?.phoneVersion === null) return "older";
    return this.takeStopped({ ...read, turnId: null }, { kind: "noted", turnIds: noted })
      ? "copied"
      : "older";
  }

  // ---- the checked safety lines -------------------------------------------------------------------------------------

  /** The checked safety lines as last copied, by slot. */
  readLines(): CheckedLineCopy[] {
    return this.sql
      .exec<LineRow>("SELECT slot, line_id, text, refreshed_ms FROM copy_lines ORDER BY slot")
      .toArray()
      .map((row) => ({ slot: row.slot, lineId: row.line_id, text: row.text, refreshedAt: row.refreshed_ms }));
  }

  /**
   * Copies the lines the safety read's bundle gives now; returns how many changed. A slot whose line the bundle gives no
   * words for now keeps what was copied before. Null (nothing wired to read) changes nothing.
   */
  refreshLines(lines: readonly LineRead[] | null): number {
    if (lines === null) return 0;
    const held = new Map(this.readLines().map((line) => [line.slot, line]));
    const changed = lines.filter((read) => {
      const line = read.line;
      if (line === null || !isLabel(read.slot) || !isLabel(line.id) || line.text.trim() === "") return false;
      const before = held.get(read.slot);
      return before?.lineId !== line.id || before.text !== line.text;
    });
    if (changed.length === 0) return 0;
    const at = this.host.now();
    this.host.storage.transactionSync(() => {
      for (const read of changed) {
        if (read.line === null) continue;
        this.sql.exec(
          "INSERT OR REPLACE INTO copy_lines (slot, line_id, text, refreshed_ms) VALUES (?, ?, ?, ?)",
          read.slot,
          read.line.id,
          read.line.text,
          at,
        );
      }
    });
    return changed.length;
  }

  // ---- the keyword list and the stop and start replies (T-270) ------------------------------------------------------

  /**
   * Copies a pinned bundle's keyword list and its stop and start replies (K-01 v1 `lists.keywords`, and the fixed lines
   * `stopReply` and `startReply`, null while their words wait for Jay); true when the copy changed. A manifest whose list
   * the guard cannot read changes nothing: the copy keeps the list it had (`keywordsOf` refuses it, fails closed).
   */
  refreshKeywords(manifest: Readonly<Record<string, unknown>>): boolean {
    try {
      keywordsOf(manifest);
    } catch {
      return false;
    }
    const lists = manifest.lists as Record<string, unknown>;
    const lines = fixedLinesOf(manifest);
    const keywords = JSON.stringify(lists.keywords);
    const replies = JSON.stringify(
      Object.fromEntries(KEYWORD_REPLIES.map((id) => [id, lines.get(id) ?? null])),
    );
    const held = this.sql
      .exec<KeywordRow>("SELECT keywords, replies, refreshed_ms FROM copy_keywords WHERE one = 1")
      .toArray()[0];
    if (held?.keywords === keywords && held.replies === replies) return false;
    this.sql.exec(
      "INSERT OR REPLACE INTO copy_keywords (one, keywords, replies, refreshed_ms) VALUES (1, ?, ?, ?)",
      keywords,
      replies,
      this.host.now(),
    );
    return true;
  }

  /** The keyword list and the stop and start replies as last copied, or null when none was copied (or it cannot be read). */
  readKeywords(): KeywordCopy | null {
    const row = this.sql
      .exec<KeywordRow>("SELECT keywords, replies, refreshed_ms FROM copy_keywords WHERE one = 1")
      .toArray()[0];
    if (row === undefined) return null;
    try {
      const list = keywordsOf({ lists: { keywords: JSON.parse(row.keywords) as unknown } });
      const parsed = JSON.parse(row.replies) as Record<string, unknown>;
      const replies = new Map<string, string | null>();
      for (const id of KEYWORD_REPLIES) {
        const text = parsed[id];
        replies.set(id, typeof text === "string" ? text : null);
      }
      return { list, replies, refreshedAt: row.refreshed_ms };
    } catch {
      return null;
    }
  }

  // ---- the safety timers --------------------------------------------------------------------------------------------

  /** The handle's live safety timers as last copied, earliest due first. */
  readTimers(): SafetyTimerCopy[] {
    return this.sql
      .exec<TimerRow>(
        `SELECT timer_id, state, version, due_at, due_zone, address, address_for, contact_person_id, contact_handle_id,
                worker_handle_id, clock_row_id, business_id, booking_id, refreshed_ms
         FROM copy_timers ORDER BY due_ms, timer_id`,
      )
      .toArray()
      .map((row) => ({
        timerId: row.timer_id,
        state: row.state === "missed" ? "missed" : "running",
        version: row.version,
        dueAt: row.due_at,
        dueZone: row.due_zone,
        address: row.address,
        addressFor: row.address_for,
        contact: { personId: row.contact_person_id, handleId: row.contact_handle_id },
        workerHandleId: row.worker_handle_id,
        clockRowId: row.clock_row_id,
        businessId: row.business_id,
        bookingId: row.booking_id,
        refreshedAt: row.refreshed_ms,
      }));
  }

  /**
   * True while the timers' copy is behind a write it was told of (its last reload failed), its mark stored or only in
   * memory (DL-427 ruling 4); a storage that cannot say answers true (one more reload).
   */
  timersStale(): boolean {
    if (this.staleUnstored !== null) return true;
    try {
      return this.sql.exec("SELECT 1 FROM copy_meta WHERE k = ?", STALE).toArray().length > 0;
    } catch {
      return true;
    }
  }

  /**
   * Marks the timers' copy behind a write it cannot read (T-1206: a commit whose answer was lost), so every later commit
   * reloads it until a reload sent after the mark succeeds (T-1208). Never throws.
   */
  markTimersStale(): void {
    this.markStale();
  }

  /**
   * Reloads the handle's live timers (K-04 handles.id) after any reload already running here, and replaces the copy with
   * them. A reload ends only the stale marks noted before it was sent (T-1208): a mark noted while it was on its way (a
   * commit whose answer was lost, which may have written a row this read began before) stays, so a later commit reloads
   * again. A reload that cannot be done (not wired, no answer, an error, a row that is not K-34's, a copy the storage
   * cannot write) keeps the copy as it was and marks it stale. Never throws.
   */
  refreshTimers(handleId: string): Promise<TimerRefresh> {
    const run = this.timerWork.then(() => this.reloadTimers(handleId));
    this.timerWork = run.catch(() => undefined);
    return run.catch((): TimerRefresh => "failed");
  }

  private async reloadTimers(handleId: string): Promise<TimerRefresh> {
    const set = deps;
    if (set === null || !isLabel(handleId)) {
      this.markStale();
      return "unwired";
    }
    // The stale marks noted before this reload is sent: the only ones it may end.
    const noted = this.staleNoted;
    let answer: unknown;
    try {
      answer = await set.timers.liveTimers({ handleId });
    } catch {
      this.markStale();
      return "failed";
    }
    const timers = timersOf(answer, handleId);
    if (timers === null) {
      this.markStale();
      return "failed";
    }
    try {
      this.replaceTimers(timers, noted);
    } catch {
      // The copy could not be written: it stays as it was, and is marked behind.
      this.markStale();
      return "failed";
    }
    if (this.staleUnstored !== null && this.staleUnstored <= noted) this.staleUnstored = null;
    return "refreshed";
  }

  /**
   * Replaces the timers' copy with these, in one storage transaction, and lets go of its stale mark when no mark was noted
   * after the reload was sent (`noted`, the count of marks then).
   */
  private replaceTimers(timers: readonly TimerValues[], noted: number): void {
    const at = this.host.now();
    this.host.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM copy_timers");
      for (const timer of timers) {
        this.sql.exec(
          `INSERT INTO copy_timers (timer_id, state, version, due_at, due_ms, due_zone, address, address_for,
                                    contact_person_id, contact_handle_id, worker_handle_id, clock_row_id, business_id,
                                    booking_id, refreshed_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          timer.timerId,
          timer.state,
          timer.version,
          timer.dueAt,
          timer.dueMs,
          timer.dueZone,
          timer.address,
          timer.addressFor,
          timer.contact.personId,
          timer.contact.handleId,
          timer.workerHandleId,
          timer.clockRowId,
          timer.businessId,
          timer.bookingId,
          at,
        );
      }
      // A mark noted while this reload was on its way stays (T-1208): its commit may have written a row the read missed.
      if (this.staleNoted === noted) this.sql.exec("DELETE FROM copy_meta WHERE k = ?", STALE);
    });
  }

  /**
   * Marks the timers' copy behind a write, counted (`staleNoted`) so a reload sent before it never ends it. A storage that
   * fails keeps the mark in this instance's memory instead (DL-427 ruling 4), so every later commit still reloads until a
   * reload sent after it succeeds. Never throws.
   */
  private markStale(): void {
    this.staleNoted += 1;
    try {
      this.sql.exec("INSERT OR IGNORE INTO copy_meta (k, v) VALUES (?, ?)", STALE, this.host.now());
    } catch {
      this.staleUnstored = this.staleNoted;
    }
  }
}
