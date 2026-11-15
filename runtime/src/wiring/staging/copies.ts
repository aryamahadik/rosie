// Staging's sources for the actor's copies (the D-017 path audit's P6c: ops/reviews/D-017-path-audit/order_d017.txt line
// 59; T-1306; the lead's notes DL-427, DL-542, DL-562, DL-761 and DL-768). T-1257 made this file with its final signature,
// and the copy deps' seam in ../root.ts install() (RootOptions.copies: install() sets them with the actor's other ports,
// `setCopyDeps`, whenever they are handed in), so T-1306 binds this file and edits nothing else (critic_collisions B6c).
//
// RootOptions.copies (../../actor/copies/types.ts CopyDeps) over T-1301's two reads (db/repo/copy-reads.ts: K-05 v1.12
// items 56 and 57), each on the runtime side of the root's handle (./part.ts StagingDb.runtime over T-1254's ./db.ts;
// ADR-014 sections 1 and 2): one short-lived client per call from HYPERDRIVE_JOB, the login rosie_worker_job, which
// inherits rosie_job alone, guarded before the read runs and ended after it. The job's Hyperdrive configuration has caching
// disabled (ADR-014 lines 38 and 100), and each read is db/repo's own read-only transaction at repeatable read, begun when
// the call is made, so each answer is the primary's at that call, never a cache's (DL-427; T-1206's security note a). No
// answer is remembered: each reload and each re-read reads the rows as they stand.
//
//   timers  SafetyTimerSource.liveTimers, the copy's reload of the handle's live safety timers (item 56): readLiveTimers'
//           answer as `{ result: "timers", timers }`, each timer mapped field by field from item 56's names to K-34's
//           column names (safetyTimerRowOf), the sealed address as given: never opened, decoded or converted (default
//           110). transient as `{ error: "transient" }`, so the reload keeps the copy as it was and marks it stale.
//   phones  StoppedFlagSource.stoppedFlag, the copy's re-read of the handle's stopped flag after a commit whose answer was
//           lost (item 57; T-1206): readStoppedFlag's answer as `{ result: "phone", stopped, phoneVersion }`. notFound (no
//           phone row) and transient as `{ error }` alone, so the copy reads each as a failed re-read and keeps the
//           stricter reading, a lost commit's mark included (default 111): no phone row is never "not stopped".
// Each request is the copy's handle id (K-04 handles.id) and nothing else. Of each answer only what the port names is
// handed on: never the answer's own handle id, a notFound's table and row id, or a transient's SQLSTATE.
//
// An id that copies.ts's isLabel refuses (T-1248's runtime note): K-05's id is any non-empty string (formats.v1 id),
// while the copy keeps a timer only when each of its ids is a K-08 label (../../actor/copies/copies.ts timerOf). The mapping hands each id on as the read gives it, so a live timer holding such an id makes the whole reload
// fail closed, as copies.ts does today: "failed", the copy kept as it was and marked stale, and every later commit reloads
// again. copies.ts is not changed here; the ids Rosie's code makes are labels.
//
// Unbound: any environment but staging (checked first, so no binding is read there; in production stagingOptions gives
// every input null before any part is built), or staging with no HYPERDRIVE_JOB binding: null, as the Worker's root has
// always left it, so install() sets nothing, each reload and re-read answers unwired, and the copy keeps the stricter
// reading. Only the binding's presence is read here, once, as the root is built (DL-768); its connection string is the
// handle's to read, at each call. HYPERDRIVE_APP is never read: rosie_app holds no grant on phones, and with no business
// scope it sees no timer (db/migrations/0012, 0016; db/repo/copy-reads.ts default 2).
//
// Bound but failing: the handle's own refusals (./db.ts: the guard's DbGuardRefusal; DbClosedError while DB_SCHEMA is set
// or the binding holds no connection string; a connect that fails, as DataAccessDatabaseError) and the reads' own (a
// TypeError for a request of the wrong shape, a BusinessScopeError, a BrokenRecordError, any other database error
// scrubbed) are thrown as they are: each names a call, a side, the binding's name, a check's label, a field or a
// SQLSTATE, and never a value. The copies take a throw as a failed read (DL-562): the reload keeps the copy and marks it
// stale, the re-read keeps the stricter reading, and neither logs it.
//
// Nothing here logs, and nothing is put in a span: a timer holds a sealed address and the ids of a pro and of the
// contact who said yes. The handle writes each call's timing, labels and numbers only (./part.ts dbCallLine), on no trace
// (the ports' requests name none).

import {
  readLiveTimers,
  readStoppedFlag,
  type LiveTimer,
  type ReadLiveTimersOutcome,
  type ReadLiveTimersRequest,
  type ReadStoppedFlagOutcome,
  type ReadStoppedFlagRequest,
} from "@rosie/db/repo/copy-reads";

import type { CopyDeps, LiveTimersAnswer, SafetyTimerRow, StoppedFlagAnswer } from "../../actor/copies/types";
import { environmentOf } from "../picks";
import type { StagingPart } from "./part";

/** What T-1306's builder is handed: the env and the root's handle. */
export type CopiesPart = StagingPart;

/** The reload's name on the handle: on its timing line, and on every error that leaves it. */
export const READ_LIVE_TIMERS_CALL = "readLiveTimers";

/** The re-read's name on the handle: on its timing line, and on every error that leaves it. */
export const READ_STOPPED_FLAG_CALL = "readStoppedFlag";

/**
 * One live timer of K-05 v1.12 item 56 as the copy reads it (../../actor/copies/types.ts SafetyTimerRow), field by field
 * from item 56's names to K-34's column names, each value as the read gives it: the thirteen columns, and nothing else.
 */
export function safetyTimerRowOf(timer: LiveTimer): SafetyTimerRow {
  return {
    id: timer.id,
    business_id: timer.businessId,
    booking_id: timer.bookingId,
    worker_handle_id: timer.workerHandleId,
    emergency_contact_person_id: timer.emergencyContactPersonId,
    emergency_contact_handle_id: timer.emergencyContactHandleId,
    due_at: timer.dueAt,
    due_zone: timer.dueZone,
    // The job's address, sealed under address_for_person_id's key, as K-34 stores it in its hex text form: never opened.
    address: timer.address,
    address_for_person_id: timer.addressForPersonId,
    clock_row_id: timer.clockRowId,
    state: timer.state,
    version: timer.version,
  };
}

/**
 * readLiveTimers' answer as the reload takes it (K-05 v1.12's binding line, README "Consumers of v1.12"): the handle's
 * live timers as `{ result: "timers", timers }`, each by safetyTimerRowOf; transient as `{ error }` alone.
 */
export function liveTimersAnswerOf(outcome: ReadLiveTimersOutcome): LiveTimersAnswer {
  if ("error" in outcome) return { error: outcome.error };
  return { result: "timers", timers: outcome.timers.map(safetyTimerRowOf) };
}

/**
 * readStoppedFlag's answer as the re-read takes it (K-05 v1.12's binding line): the phone row's flag and version as
 * `{ result: "phone", stopped, phoneVersion }`; notFound and transient as `{ error }` alone, each a failed re-read.
 */
export function stoppedFlagAnswerOf(outcome: ReadStoppedFlagOutcome): StoppedFlagAnswer {
  if ("error" in outcome) return { error: outcome.error };
  return { result: "phone", stopped: outcome.stopped, phoneVersion: outcome.phoneVersion };
}

/** A binding is present when the env holds an object under its name; its connection string is the handle's to read. */
const isBound = (binding: unknown): boolean => typeof binding === "object" && binding !== null;

/**
 * RootOptions.copies for staging: the reload over readLiveTimers and the re-read over readStoppedFlag, each on one
 * job-side client per call through the root's handle, from the primary and never a cache. Null anywhere but staging (no
 * binding read) and on staging with no HYPERDRIVE_JOB binding, so install() sets no copy deps.
 */
export const stagingCopies: (part: CopiesPart) => CopyDeps | null = ({ env, db }) => {
  if (environmentOf(env) !== "staging" || !isBound(env.HYPERDRIVE_JOB)) return null;
  return {
    timers: {
      async liveTimers({ handleId }) {
        const request: ReadLiveTimersRequest = { handleId };
        return liveTimersAnswerOf(
          await db.runtime(READ_LIVE_TIMERS_CALL, (sql) => readLiveTimers(sql, request)),
        );
      },
    },
    phones: {
      async stoppedFlag({ handleId }) {
        const request: ReadStoppedFlagRequest = { handleId };
        return stoppedFlagAnswerOf(
          await db.runtime(READ_STOPPED_FLAG_CALL, (sql) => readStoppedFlag(sql, request)),
        );
      },
    },
  };
};
