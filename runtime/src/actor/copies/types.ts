// The actor's own copies (T-269; C-053): the shapes, written by hand from the frozen contracts, because the generated types
// are git-ignored (ADR-005) and the Worker must not depend on them:
//
//   - K-04 v1 (db-schema/core) `phones.stopped`, with its row version: the handle's stopped flag, one for every business;
//   - K-01 v1 (bundle) fixed lines and the outcome steps' checked lines, as the safety read takes them (../../safety);
//   - K-34 v1 (db-schema/safety-incidents) `safety_timers`: a running timer's due time and zone, the job's address sealed
//     under its person's key (`sealedBy: address_for_person_id`), and the emergency contact (their person and handle).
//
// Never logged, put in a span or an error: a number, an address (sealed or not), a contact's name, a text's words. The ids,
// kinds and codes here are labels.
//
// T-270 adds one copy: the pinned bundle's keyword list (K-01 v1 `lists.keywords`) and the stop and start replies' words
// (K-01 v1 fixed lines `stopReply` and `startReply`), copied from each bundle a turn pins, so the actor can read a STOP or
// a START, and reply to it, while PostgreSQL is down.

import type { KeywordList } from "../../guard/keywords";

/**
 * The keyword list and the stop and start replies, as the actor last copied them from a pinned bundle (T-270): what it reads
 * a STOP or a START by, and replies with, while PostgreSQL is down. The words are the sources' fixed words, never a person's.
 */
export interface KeywordCopy {
  /** K-01 v1 `lists.keywords`, as the guard reads it (runtime/src/guard/keywords.ts). */
  readonly list: KeywordList;
  /** `stopReply` and `startReply` (K-01 ids), each with the bundle's words, or null while they wait for Jay (Q-01). */
  readonly replies: ReadonlyMap<string, string | null>;
  /** When they were copied, on the actor's clock. */
  readonly refreshedAt: number;
}

/**
 * The handle's stopped flag as the actor last saw it written (K-04 v1 `phones.stopped`: one flag for every business), or
 * the stricter reading while a refusal holds the stop rank of the write-on-return queue (`held`; DL-167 ruling 2).
 */
export interface StoppedCopy {
  /** True while `held` is set, whatever was copied last. */
  readonly stopped: boolean;
  /** K-04 `phones.version` after the write (K-09 v1 recordStopOrStart's `phoneVersion`); null for the actor's own note. */
  readonly phoneVersion: number | null;
  /** The turn whose commit wrote it, or null when no turn did. */
  readonly turnId: string | null;
  /** When the copy was set, on the actor's clock. */
  readonly setAt: number;
  /** Set only while a refusal holds the stop rank: until every stop or start record queued is written in order. */
  readonly held?: StopHold;
}

/** The refusal holding the stop rank of the write-on-return queue: the refused write's key and code (labels), since when. */
export interface StopHold {
  readonly key: string;
  readonly code: string;
  /** Since the first refusal, on the actor's clock. */
  readonly since: number;
}

/** A stopped flag to copy: what a commit (or, with T-270, the actor itself) wrote. */
export interface StoppedWrite {
  readonly stopped: boolean;
  readonly phoneVersion: number | null;
  readonly turnId: string | null;
}

/** One line as the safety read's bundle gives it now (K-01 v1 `fixedLine`, or an outcome step's checked `say`). */
export interface LineRead {
  /** Where the safety read uses it: `fixed:<K-01 id>`, or `outcome:<outcome label>` for an outcome step's own line. */
  readonly slot: string;
  /** The line, or null when the bundle gives none now (not in it, no words yet, or not readable). */
  readonly line: { readonly id: string; readonly text: string } | null;
}

/** One checked safety line the actor keeps. Its words are the sources' fixed words, never a person's. */
export interface CheckedLineCopy {
  readonly slot: string;
  /** The K-01 line id (K-09 `fixedLineId`). */
  readonly lineId: string;
  readonly text: string;
  /** When these words were copied, on the actor's clock. */
  readonly refreshedAt: number;
}

/**
 * One K-34 v1 `safety_timers` row as the reload reads it, by the table list's own column names. Only the columns the copy
 * keeps are typed; the others ride along unread.
 */
export interface SafetyTimerRow {
  readonly id: string;
  readonly business_id: string;
  readonly booking_id: string | null;
  readonly worker_handle_id: string;
  readonly emergency_contact_person_id: string;
  readonly emergency_contact_handle_id: string;
  /** The check-out time, a UTC instant (K-34 `due_at`). */
  readonly due_at: string;
  /** The IANA zone it was given in (K-34 `due_zone`). */
  readonly due_zone: string;
  /** The job's address as K-34 keeps it: sealed under the key of `address_for_person_id`. Never opened here. */
  readonly address: string;
  readonly address_for_person_id: string;
  readonly clock_row_id: string;
  /** running, missed or safe (K-34 `safety_timers_state_known`). */
  readonly state: string;
  readonly version: number;
  readonly [column: string]: unknown;
}

/** A live safety timer as the actor keeps it (arch 11 line 566: "the actor's copy of its due time, address and emergency contact"). */
export interface SafetyTimerCopy {
  readonly timerId: string;
  /** running, or missed (a missed check stays open until SAFE: K-34). */
  readonly state: "running" | "missed";
  /** K-34 `version`: the copy is the row at this version. */
  readonly version: number;
  readonly dueAt: string;
  readonly dueZone: string;
  /** The address, sealed as K-34 seals it (under `addressFor`'s key), never opened or put in plain here. */
  readonly address: string;
  /** The person whose key seals the address (K-34 `address_for_person_id`). */
  readonly addressFor: string;
  /** The emergency contact who said yes: their person and their handle (K-34 `emergency_contact_*`). */
  readonly contact: { readonly personId: string; readonly handleId: string };
  /** The pro's handle: this actor's (K-34 `worker_handle_id`). */
  readonly workerHandleId: string;
  /** The core clock row that fires the miss while PostgreSQL is up (K-34 `clock_row_id`). */
  readonly clockRowId: string;
  readonly businessId: string;
  readonly bookingId: string | null;
  /** When the row was copied, on the actor's clock. */
  readonly refreshedAt: number;
}

/** The reload's answer: the handle's live timers (state running or missed), or a K-05 error such as `transient`. */
export type LiveTimersAnswer =
  { readonly result: "timers"; readonly timers: readonly SafetyTimerRow[] } | { readonly error: string };

/**
 * The reload of a handle's live safety timers (K-34 v1 `safety_timers` where `worker_handle_id` is the handle and the state
 * is running or missed; K-34's `safety_timers_worker_live_idx`: "the actor reloads its copies"). No frozen data-access call
 * reads them yet: the adapter joins at D-017, and a fake answers in tests.
 */
export interface SafetyTimerSource {
  liveTimers(request: { handleId: string }): Promise<LiveTimersAnswer>;
}

/** What the copies reach outside the actor, set once per Worker isolate (`setCopyDeps`); joins at D-017. */
export interface CopyDeps {
  readonly timers: SafetyTimerSource;
}

/** How a reload of the timers ended: copied; not wired; or failed (no answer, an error, a row that is not K-34's). */
export type TimerRefresh = "refreshed" | "unwired" | "failed";

/** What a committed answer gives the copies: the stopped flag a STOP or START wrote, and whether a safety timer was written. */
export interface CommitCopies {
  readonly stopped: { readonly stopped: boolean; readonly phoneVersion: number } | null;
  /**
   * True when the commit may have written a K-34 safety_timers row: its rows name one, a core result may have written one
   * (a core action K-09 does not list, which went through: its rows are not in K-09's `written`, T-1198), it is K-09's
   * repeat (its first answer, maybe lost, named the rows: T-1203), or the answer cannot be read (fails safe, DL-413). The
   * actor then reloads the timers.
   */
  readonly timersWritten: boolean;
}
