// Staging's sign-in calls (ADR-016 card D, sections 2, 4, 5 and 6; T-1289; C-193; the lead's notes DL-526, DL-546,
// DL-753, DL-768, DL-776 and DL-813): RootOptions.signIn, the inputs the root binds K-21 v1's signInStart, signInCheck
// and signOut over (../sign-in.ts signInPages), as ./options.ts builds them beside the email part, whose port it is
// handed.
//
// K-05 v1.13's sign-in calls, each on the side ADR-016 section 6 names (ADR-014: one short-lived client per call through
// the root's handle, guarded before the call runs and ended after it; no transaction spans both sides):
//   the runtime side   HYPERDRIVE_JOB, the login rosie_worker_job, which inherits rosie_job:
//                        startSignIn and sendSignInCode (db/repo/sign-in-send.ts, T-1280; items 58 and 59);
//                        personStanding and signInEntries (db/repo/sign-in-check.ts, T-1284; items 62 and 63);
//                        sendState (db/repo/send-state.ts; item 28), read by the code row's id for its recipient's
//                        handle alone, the one ADR-016 section 2's dispatch after the code's commit runs for
//   the Tool API side  HYPERDRIVE_APP, the login rosie_worker_app, which inherits rosie_app:
//                        proveSignIn and endSession (db/repo/sign-in-check.ts, T-1284; items 60 and 61)
// Each answer goes to its handler as K-05 gives it. A call that cannot be made or answered throws: the handle's own
// refusals and db/repo's own errors as they are, anything else scrubbed to the call's name and a SQLSTATE or the client's
// code (db/repo/clocks.ts scrubbed, as ./send.ts leaves its calls); the page entry answers 503 with the error's name
// alone. sendSignInCode's and signInEntries' timing lines go on the page call's trace, which their requests carry; the
// recipient read's on the trace it is handed; the others' on none (./part.ts dbCallLine).
//
// The hashing port (ADR-016 section 4, "The key"; DL-546): T-322's hmacSha256Hash over PROOF_CODE_HASH_KEY, read by name
// from the env at each signInStart and signInCheck, never at build, and never kept, logged or put in an error. Its value
// is 32 random bytes as base64, as make-staging-secrets.sh makes it in place (ADR-016 card G). Unset or empty, or not
// base64 of at least 32 bytes, the call gets no hashing port, so the handler answers 503 with nothing written or
// counted (T-1282's and T-1285's noHashKey), and one JSON line names PROOF_CODE_HASH_KEY and why (unset or unreadable)
// on the call's trace, and nothing else. signOut needs no key and never reads it.
//
// Nothing bound stays closed (DL-768): the part is handed the email part's port (RootOptions.emailRows), the one way a
// code goes out (ADR-016 section 5), which is null anywhere but staging and wherever no test-phone line is bound (no
// HYPERDRIVE_JOB: ./test-phone.ts, ./email.ts). With none it gives null, so the three calls stay unconfigured (503, the
// page entry's notConnected) and no start can answer for a code that has no way to go. At build it reads nothing at all:
// the handle reads each binding at each call, and the key is read at each call. Production binds none: ./options.ts
// builds no part there (STATE note 72; ADR-016 section 5).
//
// Never logged, put in a span or an error here: the key, a hash, a code, a token, a contact, an address or an id.

import { hmacSha256Hash, type KeyedHash } from "@rosie/actions/src/domain/proof-codes/index";
import { scrubbed } from "@rosie/db/repo/clocks";
import type { Sql } from "@rosie/db/repo/scope";
import { sendState } from "@rosie/db/repo/send-state";
import { endSession, personStanding, proveSignIn, signInEntries } from "@rosie/db/repo/sign-in-check";
import { sendSignInCode, startSignIn } from "@rosie/db/repo/sign-in-send";

import type { EmailRowsDeps } from "../../email";
import type { SignInInputs } from "../sign-in";
import type { StagingDb, StagingEnv, StagingPart } from "./part";

/** The Workers secret a code's and a contact's keyed hash are made under (K-22 v1 proof_codes.hash_key_name). */
export const PROOF_CODE_HASH_KEY = "PROOF_CODE_HASH_KEY";

/** What T-1289's builder is handed: the env (PROOF_CODE_HASH_KEY), the root's handle, and the email part's port. */
export interface SignInPart extends StagingPart {
  /**
   * Staging's email port, as the email part binds it (RootOptions.emailRows): the way a code goes out. Null where that
   * part binds none, and then this part binds nothing either.
   */
  readonly email: EmailRowsDeps | null;
}

/** Each call's name on the handle, K-05's own: on its timing line, and on every error that leaves it. */
export const SIGN_IN_CALLS = Object.freeze({
  startSignIn: "startSignIn",
  sendSignInCode: "sendSignInCode",
  proveSignIn: "proveSignIn",
  endSession: "endSession",
  personStanding: "personStanding",
  signInEntries: "signInEntries",
  sendState: "sendState",
} as const);

/** Why a call got no hashing port: the key is not set (or empty), or it is not base64 of at least 32 bytes. */
export type SignInKeyWhy = "unset" | "unreadable";

/** The line a call with no usable key writes: the key's name, why, the call's trace and where the Worker runs. */
export interface SignInKeyLine {
  readonly level: "warn";
  readonly msg: "signInKeyMissing";
  readonly missing: typeof PROOF_CODE_HASH_KEY;
  readonly why: SignInKeyWhy;
  readonly trace_id: string;
  readonly environment: string;
  readonly version: string;
}

/** What a test may stand in: where the key's line goes. */
export interface SignInSeams {
  /** Where the key's line goes. Left out: console.log (Workers Logs). */
  readonly write?: (line: string) => void;
}

/** The line for a call that got no hashing port, read where the Worker runs at the moment it is written. */
export function signInKeyLine(why: SignInKeyWhy, traceId: string, env: StagingEnv): SignInKeyLine {
  return {
    level: "warn",
    msg: "signInKeyMissing",
    missing: PROOF_CODE_HASH_KEY,
    why,
    trace_id: traceId,
    environment: env.ENVIRONMENT,
    version: env.GIT_SHA ?? "unknown",
  };
}

/** A base64 value's bytes, or null when it is not base64 (as db/repo/sealing.ts reads the wrapping key). */
function bytesOf(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value.trim()), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * The hashing port over PROOF_CODE_HASH_KEY, read by name from `env` now: T-322's hmacSha256Hash over its bytes, inside a
 * key that cannot be read back. Null, with one line naming the key, when it is unset or empty, or is not base64 of at
 * least 32 bytes (hmacSha256Hash's own floor). The value is never kept, logged or put in an error.
 */
export async function proofCodeHashOf(
  env: StagingEnv,
  traceId: string,
  write: (line: string) => void,
): Promise<KeyedHash | null> {
  const value: unknown = env.PROOF_CODE_HASH_KEY;
  const missing = (why: SignInKeyWhy): null => {
    write(JSON.stringify(signInKeyLine(why, traceId, env)));
    return null;
  };
  if (typeof value !== "string" || value.trim() === "") return missing("unset");
  const bytes = bytesOf(value);
  if (bytes === null) return missing("unreadable");
  try {
    return await hmacSha256Hash(PROOF_CODE_HASH_KEY, bytes);
  } catch {
    // Shorter than 32 bytes (ProofCodeHashError, which names no value): no key to hash with.
    return missing("unreadable");
  } finally {
    bytes.fill(0);
  }
}

/** One K-05 call on a client of its own on one side, guarded first and ended after, its throw scrubbed. */
async function onSide<T>(
  db: StagingDb,
  side: "runtime" | "toolApi",
  call: string,
  fn: (sql: Sql) => Promise<T>,
  traceId: string | null = null,
): Promise<T> {
  try {
    return await (side === "runtime" ? db.runtime(call, fn, traceId) : db.toolApi(call, fn, traceId));
  } catch (error) {
    throw scrubbed(call, error);
  }
}

/**
 * RootOptions.signIn for staging: K-05 v1.13's sign-in calls on each side's client of the root's handle, the hashing port
 * over PROOF_CODE_HASH_KEY read by name at each call, and the code row's recipient read. Null where the email part binds
 * no port (anywhere but staging, or no test-phone line), so the three calls stay unconfigured. Reads nothing.
 */
export function stagingSignIn(part: SignInPart, seams: SignInSeams = {}): SignInInputs | null {
  const { env, db, email } = part;
  if (email === null) return null;
  const write =
    seams.write ??
    ((line: string) => {
      console.log(line);
    });
  const calls = SIGN_IN_CALLS;
  return {
    send: {
      startSignIn: (request) => onSide(db, "runtime", calls.startSignIn, (sql) => startSignIn(sql, request)),
      sendSignInCode: (request) =>
        onSide(db, "runtime", calls.sendSignInCode, (sql) => sendSignInCode(sql, request), request.traceId),
    },
    check: {
      proveSignIn: (request) => onSide(db, "toolApi", calls.proveSignIn, (sql) => proveSignIn(sql, request)),
      endSession: (request) => onSide(db, "toolApi", calls.endSession, (sql) => endSession(sql, request)),
    },
    afterCheck: {
      personStanding: (request) =>
        onSide(db, "runtime", calls.personStanding, (sql) => personStanding(sql, request)),
      signInEntries: (request) =>
        onSide(db, "runtime", calls.signInEntries, (sql) => signInEntries(sql, request), request.traceId),
    },
    hash: (traceId) => proofCodeHashOf(env, traceId, write),
    async recipientOf(outboxRowId, traceId) {
      const answer = await onSide(
        db,
        "runtime",
        calls.sendState,
        (sql) => sendState(sql, { outboxRowId }),
        traceId,
      );
      // The recipient's handle alone: the answer's address, phone and consent are limit 8's, never kept here.
      return "error" in answer ? null : answer.recipient.handleId;
    },
  };
}
