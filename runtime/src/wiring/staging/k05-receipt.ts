// Staging's two K-05 calls at receipt (the D-017 path audit's P2a: ops/reviews/D-017-path-audit/order_d017.txt line 31;
// T-1394; the lead's notes DL-438 to DL-468, DL-476, DL-757 and DL-768). T-1257 made this file with its final signature;
// T-1394 binds it and edits nothing else (./options.ts hands it its part).
//
// RootOptions.handleKey and RootOptions.chatOpenCall, each over db/repo's own call, unchanged, on the job side of ADR-014
// only: both are the runtime side's calls, run as rosie_job with no business scope (K-05 README "Scope"), so each runs on
// the runtime side of the root's handle (part.db.runtime: one short-lived client from HYPERDRIVE_JOB, the login
// rosie_worker_job, guarded and ended by T-1254's handle). Two clients for each text, each with its guard: nothing is
// kept on the root or cached to save a connect (ADR-014 section 2). HYPERDRIVE_APP is never read here.
//
//   handleKey     `(request) => handleSealingKey(sql, keys, request)` (db/repo/handle-keys.ts; K-05 v1.2 item 29) with the
//                 resolver this part is handed (./secrets.ts): SEALING_WRAP_KEY alone, read from the env at each call, for
//                 a new key's name and for the name a held key row stores; a row that stores another name is refused
//                 before anything is read. K-05's answer and its data key, a key object that cannot be exported, go back
//                 as K-05 hands them to ../real.ts realSealing. No key, wrapped or not, and no secret's value is kept past
//                 the call, put in an answer or logged.
//   chatOpenCall  `(request) => openChatOnText(sql, request)` (db/repo/chat-open.ts; K-05 v1.7 item 46), never
//                 openChatOnTextIn, which is for a caller that already holds a transaction (DL-438 to DL-468). K-05's
//                 answer goes back as it is (../real.ts realChatOpen reads its result or its error's name).
//
//   bound    staging with a HYPERDRIVE_JOB binding: both calls, each on a client of its own at each call.
//   unbound  any environment but staging, checked before anything else is read, or staging with no HYPERDRIVE_JOB: each
//            is null, as the Worker's root has always handed, so every seal and every chat open fails closed (../real.ts
//            NoDatabaseError naming the call) and the gateway answers 503 with nothing stored. As it is built this part
//            reads ENVIRONMENT and the presence of HYPERDRIVE_JOB, nothing else (DL-768): no connection string and no
//            secret. Production's ports are closed by ../picks.ts besides.
//   failing  bound, and a call cannot be made or answered (the handle's refusal, a connect that fails, DB_SCHEMA set, a
//            wrapping key missing, malformed or under another name, a database error): it throws, or K-05 answers
//            transient or constraint, and the gateway's own rules stand unchanged (../../gateway/linq-webhook.ts): 503
//            with nothing stored (sealFailed, chatOpenTransient or chatOpenFailed), so Linq sends the text again and K-05
//            takes it as a repeat. The chat open's notFound or notAPhone stores the text (../../gateway/chat-open.ts).
//
// What a throw holds: the handle's own errors name the call, the side, the binding and a reason, a check's label or a
// SQLSTATE (./db.ts); db/repo's two calls scrub their own (T-1268, T-1322, T-1339: the call's name and a SQLSTATE or the
// client's code; SealingError's fixed words; a TypeError naming a field); the resolver's refusal names SEALING_WRAP_KEY
// and nothing else (./secrets.ts). Each of those leaves as it is. Anything else the handle passes through as it came (an
// error of postgres.js, which carries its statement, the values bound to it and its address) leaves as
// db/repo/clocks.ts scrubbed(call, error): the call's name and a SQLSTATE or the client's code, nothing else.
//
// Nothing is logged here: the gateway's one log line holds its stage and the error's name (../../gateway/answer.ts
// logFailure), and the handle writes each call's timing, labels and numbers only (./part.ts dbCallLine), the chat open's
// on the text's trace (its request names it) and the key call's on none (K-05 v1.2's request holds no trace). No number,
// address, key, wrapping-key value, token, hash, host, user, password or word is in a span, a log line or an error.

import { openChatOnText } from "@rosie/db/repo/chat-open";
import { scrubbed } from "@rosie/db/repo/clocks";
import { handleSealingKey } from "@rosie/db/repo/handle-keys";
import type { WrappingKeys } from "@rosie/db/repo/sealing";

import { environmentOf } from "../picks";
import type { HandleSealingKeyCall, OpenChatOnTextCall } from "../real";
import type { StagingPart } from "./part";

/** What T-1394's builder is handed: the env, the root's handle and the SEALING_WRAP_KEY-only resolver (./secrets.ts). */
export interface ReceiptPart extends StagingPart {
  readonly keys: WrappingKeys;
}

/** The receipt's two RootOptions inputs, each null where it is not bound. */
export interface ReceiptInputs {
  readonly handleKey: HandleSealingKeyCall | null;
  readonly chatOpenCall: OpenChatOnTextCall | null;
}

/** Neither call bound: each fails closed as its port does with nothing bound. */
export const NO_RECEIPT_INPUTS: ReceiptInputs = Object.freeze({ handleKey: null, chatOpenCall: null });

/** The key call's name on the handle: on its timing line, and on every error that leaves it. */
export const HANDLE_SEALING_KEY_CALL = "handleSealingKey";

/** The chat open's name on the handle: on its timing line, and on every error that leaves it. */
export const OPEN_CHAT_ON_TEXT_CALL = "openChatOnText";

/**
 * RootOptions.handleKey and chatOpenCall for staging: db/repo's handleSealingKey (with the resolver handed in) and
 * openChatOnText, each on one job-side client per call. Both null anywhere but staging (no binding read) and where no
 * HYPERDRIVE_JOB is bound, so each port fails closed as with nothing bound.
 */
export const stagingReceiptCalls: (part: ReceiptPart) => ReceiptInputs = ({ env, db, keys }) => {
  if (environmentOf(env) !== "staging") return NO_RECEIPT_INPUTS;
  // The binding's presence, once, as the root is built; its connection string is the handle's to read, at each call.
  const binding: unknown = env.HYPERDRIVE_JOB;
  if (binding === undefined || binding === null) return NO_RECEIPT_INPUTS;
  return {
    async handleKey(request) {
      try {
        return await db.runtime(HANDLE_SEALING_KEY_CALL, (sql) => handleSealingKey(sql, keys, request));
      } catch (error) {
        throw scrubbed(HANDLE_SEALING_KEY_CALL, error);
      }
    },
    async chatOpenCall(request) {
      try {
        // The text's trace, as K-05's request names it: the call's timing is written on it (./part.ts).
        return await db.runtime(
          OPEN_CHAT_ON_TEXT_CALL,
          (sql) => openChatOnText(sql, request),
          request.traceId,
        );
      } catch (error) {
        throw scrubbed(OPEN_CHAT_ON_TEXT_CALL, error);
      }
    },
  };
};
