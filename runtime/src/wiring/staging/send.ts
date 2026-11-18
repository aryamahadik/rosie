// Staging's send, all or nothing (the D-017 path audit's P5: ops/reviews/D-017-path-audit/order_d017.txt line 49; T-1401;
// the lead's notes DL-392, DL-438 to DL-468, DL-476, DL-757, DL-761, DL-768, DL-776 and DL-783). T-1257 made this file
// with its final signature; T-1401 binds it and edits nothing else (./options.ts hands it its part).
//
// Four RootOptions inputs, bound in this one change (DL-468). Every database call runs on the runtime side of the root's
// handle (./part.ts StagingDb.runtime over T-1254's ./db.ts; ADR-014 sections 1 and 2): one short-lived client per call
// from HYPERDRIVE_JOB, the login rosie_worker_job, which inherits rosie_job alone, its guard the first statement, ended
// after the call, also when it throws. No code here sets a role, a search path or a scope, and none is kept on the root
// or cached to save a connect. HYPERDRIVE_APP is never read here.
//
//   outboxCalls    db/repo/outbox.ts's K-05 calls, each as `(request) => call(sql, request)`, never T-196's v1 calls
//                  beside them (DL-317): claimOutboxV114 (K-05 v1.14 item 67; T-1354), renewClaim (v1.1 item 14, v1.2
//                  item 32), markPartV12 (v1.1 item 15, v1.2 item 31, v1.9 item 48) and markRowV12 (v1.1 item 16), with
//                  claimOutboxV12 (v1 item 3, v1.1 item 13, v1.2 item 30) as OutboxCalls names it. With claimOutboxV114
//                  bound, ../real.ts makes every claim through it and never calls claimOutboxV12: a claim without
//                  sendClass is K-05 v1.13 item 64's (DL-761; db/repo default 24), and a danger line's safety run
//                  (sendClass safety, T-1352) is made as the safety-only claim, never refused for a missing call and
//                  never made as a claim of every class (DL-783: T-1355, v1.14's contract test, is merged).
//   sendStateCall  `(request) => sendState(sql, request)` (db/repo/send-state.ts; K-05 v1.2 item 28 with v1.8 item 47):
//                  limit 8's read at send, and the chat the send goes to.
//   armingCalls    armClock and cancelClock (db/repo/clocks.ts; K-05 v1 item 5), each as `(request) => call(sql, request)`;
//                  questionFacts over readQuestionFacts and actorNameOf over readHandle (db/repo/arming-reads.ts; K-05
//                  v1.10 items 49 and 50), mapped as v1.10's binding line says (contracts/data-access/README.md, "What the
//                  new tasks must hold to"): questionFacts field by field to the port's QuestionFacts, the visit's
//                  addressZone and address null (default 91: no address is read, so a flow B visit's zone falls to the
//                  business's), notFound to the port's NotFoundError and transient to its TransientError; actorNameOf
//                  null when K-04 holds no handle with the id, else the gateway's own actorNameOf of the handle
//                  (../../gateway/seal.ts), imported, never written again. readHandle's transient is no answer about the
//                  handle, so it is thrown (the call's name and its SQLSTATE alone), never read as "no such handle": the
//                  directory's callers read a throw as no actor named (../../clocks/actors.ts actorOf), so the arming
//                  still arms and the minute sweep fires a row its actor missed, and an outage line's one reading counts
//                  it as a stop (../root.ts actorReadingPort). The same directory names a recipient's actor for that
//                  reading.
//   linqSendCall   `(request) => lineLinqSend(testPhoneLineOf(env.TEST_PHONE_LINE)).sendPart(request)` (../test-phone):
//                  staging's test-phone line, the one T-1238 capped. The binding is read at each send. Behind
//                  ./linq-line.ts's switch (T-1449; DL-940: STAGING_LINQ_LINE exactly "real", read at each send), a part
//                  to a test phone still goes there, and every other part goes through T-414's sender behind T-416's
//                  guard (J-08's real line); with the switch off every part goes to the line, as before.
//
// All or nothing (DL-468; critic_collisions B7; T-564's security note b; T-1244's handoff note a): the four are bound
// together or not at all. Bound alone, outboxCalls would mark a part delivered while its arming failed, and every
// receipt would be answered 503 for Linq's 30 minutes; with no line, a claim would burn a try on a send that cannot
// leave. So as the root is built this part reads, in this order, ENVIRONMENT, then whether HYPERDRIVE_JOB is there, and
// only when it is, whether TEST_PHONE_LINE is there (DL-768, DL-783). Nothing else: no connection string, no secret, no
// other binding. The handle reads the connection string at each call.
//
//   bound    staging with both HYPERDRIVE_JOB and TEST_PHONE_LINE: the four inputs.
//   unbound  any environment but staging, checked before anything else is read; or staging with either binding missing:
//            all four null, as the Worker's root has always handed, so each port fails closed as it does with nothing
//            bound (../real.ts NoDatabaseError naming the call, NoLinqLineError). Nothing is claimed, so no claim burns
//            a try; no send state is read and nothing is sent; and a delivery receipt's mark is refused, so the receipt
//            door rejects and the gateway answers 503 with no part marked, and Linq sends it again
//            (../../dispatch/dispatcher.ts handleDeliveryReceipt; ../../gateway/linq-webhook.ts). In production
//            ./options.ts builds no part, and the four ports stay closed (../picks.ts).
//   failing  bound, and a call cannot be made or answered (the handle's refusal, a connect that fails, DB_SCHEMA set, a
//            database error): it throws, or K-05 answers transient, and each answer goes to its port as K-05 gives it
//            (../real.ts realOutbox, realSendState and realArming map and check it). A claim that throws claims
//            nothing; a mark that throws answers the receipt 503; an arming's read that throws is counted by the
//            arming as no answer (../../clocks/arming.ts withTries), and an arming that ends failed answers its receipt
//            503 (T-1244).
//
// What a throw holds: the handle's own errors name the call, the side, the binding and a reason, a check's label or a
// SQLSTATE (./db.ts); db/repo's calls answer K-05's transient or throw scrubbed, the call's name and a SQLSTATE or the
// client's code alone, and a TypeError or a BrokenRecordError that names a call, a field or a rule, never a value
// (db/repo/clocks.ts transientOrScrubbed; db/repo/arming-reads.ts). Each of those leaves as it is. Anything else the
// handle passes through as it came (an error of postgres.js, which carries its statement, the values bound to it and its
// address) leaves as db/repo/clocks.ts scrubbed(call, error): the call's name and a SQLSTATE or the client's code.
//
// Nothing is logged here, and nothing is put in a span: the handle writes each call's timing, labels and numbers only
// (./part.ts dbCallLine; these requests carry no trace id, so each line's trace_id is null), and the guard's refusal its
// one line. A claimed row's final parts hold a person's words, a send state the number and Linq's chat id, a handle its
// address: each goes to its port alone, never into a log line, a span or an error.

import { readHandle, readQuestionFacts } from "@rosie/db/repo/arming-reads";
import { armClock, cancelClock, DataAccessDatabaseError, scrubbed } from "@rosie/db/repo/clocks";
import { claimOutboxV12, claimOutboxV114, markPartV12, markRowV12, renewClaim } from "@rosie/db/repo/outbox";
import type { Sql } from "@rosie/db/repo/scope";
import { sendState } from "@rosie/db/repo/send-state";

import { actorNameOf } from "../../gateway/seal";
import { environmentOf } from "../picks";
import {
  NoLinqLineError,
  type ArmingCalls,
  type LinqSendCall,
  type OutboxCalls,
  type SendStateCall,
} from "../real";
import { lineLinqSend, testPhoneLineOf } from "../test-phone";
import { linqLineSend } from "./linq-line";
import type { StagingDb, StagingPart } from "./part";

/** What T-1401's builder is handed: the env (TEST_PHONE_LINE, HYPERDRIVE_JOB) and the root's handle. */
export type SendPart = StagingPart;

/** The send's four RootOptions inputs: all bound, or all null. */
export interface SendInputs {
  readonly outboxCalls: OutboxCalls | null;
  readonly sendStateCall: SendStateCall | null;
  readonly linqSendCall: LinqSendCall | null;
  readonly armingCalls: ArmingCalls | null;
}

/** None of the four bound: each fails closed as its port does with nothing bound. */
export const NO_SEND_INPUTS: SendInputs = Object.freeze({
  outboxCalls: null,
  sendStateCall: null,
  linqSendCall: null,
  armingCalls: null,
});

/** Each call's name on the handle, K-05's own: on its timing line, and on every error that leaves it. */
export const SEND_CALLS = Object.freeze({
  claimOutbox: "claimOutbox",
  renewClaim: "renewClaim",
  markPart: "markPart",
  markRow: "markRow",
  sendState: "sendState",
  armClock: "armClock",
  cancelClock: "cancelClock",
  readQuestionFacts: "readQuestionFacts",
  readHandle: "readHandle",
} as const);

/** A binding is present when the env holds a value for it; a connection string is never read here. */
const present = (binding: unknown): boolean => binding !== undefined && binding !== null;

/**
 * One K-05 call on a runtime-side client of its own (HYPERDRIVE_JOB, rosie_worker_job), guarded first and ended after.
 * The handle's and db/repo's own errors leave as they are; anything else leaves scrubbed (the header's "What a throw
 * holds").
 */
async function onJob<T>(db: StagingDb, call: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  try {
    return await db.runtime(call, fn);
  } catch (error) {
    throw scrubbed(call, error);
  }
}

/** K-05's outbox calls: v1.14's claim beside the v1.2 calls, so every claim goes through it (../real.ts claimThrough). */
function outboxCallsOn(db: StagingDb): OutboxCalls {
  return {
    claimOutboxV12: (request) => onJob(db, SEND_CALLS.claimOutbox, (sql) => claimOutboxV12(sql, request)),
    claimOutboxV114: (request) => onJob(db, SEND_CALLS.claimOutbox, (sql) => claimOutboxV114(sql, request)),
    renewClaim: (request) => onJob(db, SEND_CALLS.renewClaim, (sql) => renewClaim(sql, request)),
    markPartV12: (request) => onJob(db, SEND_CALLS.markPart, (sql) => markPartV12(sql, request)),
    markRowV12: (request) => onJob(db, SEND_CALLS.markRow, (sql) => markRowV12(sql, request)),
  };
}

/** The clock arming's two K-05 calls and its two reads, mapped as K-05 v1.10's binding line says. */
function armingCallsOn(db: StagingDb): ArmingCalls {
  return {
    armClock: (request) => onJob(db, SEND_CALLS.armClock, (sql) => armClock(sql, request)),
    cancelClock: (request) => onJob(db, SEND_CALLS.cancelClock, (sql) => cancelClock(sql, request)),
    async questionFacts(openQuestionId) {
      const answer = await onJob(db, SEND_CALLS.readQuestionFacts, (sql) =>
        readQuestionFacts(sql, { openQuestionId }),
      );
      if ("error" in answer) {
        return answer.error === "notFound"
          ? { error: "notFound", table: answer.table, rowId: answer.rowId }
          : { error: "transient", sqlstate: answer.sqlstate };
      }
      const { visit, neverDelivered } = answer;
      return {
        openQuestionId: answer.openQuestionId,
        clockLine: answer.clockLine,
        businessZone: answer.businessZone,
        // No address and no address's zone is read (K-05 default 91): a flow B visit's zone falls to the business's.
        visit:
          visit === null
            ? null
            : { startsAt: visit.startsAt, flow: visit.flow, addressZone: null, address: null },
        neverDelivered:
          neverDelivered === null
            ? null
            : { clockRowId: neverDelivered.clockRowId, version: neverDelivered.version },
      };
    },
    async actorNameOf(handleId) {
      const answer = await onJob(db, SEND_CALLS.readHandle, (sql) => readHandle(sql, { handleId }));
      if ("error" in answer) {
        // Not read: no answer about the handle, never "no such handle". The call's name and the SQLSTATE alone.
        throw new DataAccessDatabaseError(SEND_CALLS.readHandle, answer.sqlstate, null, null);
      }
      const { handle } = answer;
      return handle === null ? null : actorNameOf({ kind: handle.kind, address: handle.address });
    },
  };
}

/**
 * RootOptions.outboxCalls, sendStateCall, linqSendCall and armingCalls for staging, all bound or all null: K-05's outbox,
 * send-state and clock calls and the arming's reads, each on one guarded job-side client of the root's handle, and
 * staging's test-phone line. All null anywhere but staging (no binding read), and on staging while HYPERDRIVE_JOB or
 * TEST_PHONE_LINE is missing.
 */
export const stagingSendCalls: (part: SendPart) => SendInputs = ({ env, db }) => {
  if (environmentOf(env) !== "staging") return NO_SEND_INPUTS;
  // Each binding's presence, once, as the root is built, the database's first: with none, the line is not asked for.
  if (!present(env.HYPERDRIVE_JOB)) return NO_SEND_INPUTS;
  if (!present(env.TEST_PHONE_LINE)) return NO_SEND_INPUTS;
  return {
    outboxCalls: outboxCallsOn(db),
    sendStateCall: (request) => onJob(db, SEND_CALLS.sendState, (sql) => sendState(sql, request)),
    // By recipient behind the real line's switch (./linq-line.ts, T-1449): off, every part to the test-phone line.
    linqSendCall: linqLineSend(env, (request) => {
      // The line's binding, read at each send; one that is gone fails closed as with no line bound.
      const line = env.TEST_PHONE_LINE;
      if (line === undefined) return Promise.reject(new NoLinqLineError());
      return lineLinqSend(testPhoneLineOf(line)).sendPart(request);
    }),
    armingCalls: armingCallsOn(db),
  };
};
