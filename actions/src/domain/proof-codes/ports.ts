// What the proof-code service reaches (T-322; C-095), each a port another task fills, so the service is tested with
// doubles and fails closed while one is not built:
//
//   - ProofCodeStore: K-22 v1's proof_codes through the data-access calls: the send's one write (the code row, its email
//     row with plan and final parts, and its entries, all or nothing under the call's key: ADR-016 section 1), a
//     repeat's first send, the contact's limits (K-22 v1 proof_code_limits), a code's row without its hash, and a typed
//     code's check (K-22 v1 check_proof_code) with its entry. K-05 has no such calls yet (ADR-016 card V3's sign-in
//     version names sendSignInCode; CQ-44's commit with no turn the rest), so the default store answers notBuilt for
//     every call and nothing is written;
//   - KeyedHash (hashing.ts): the code's HMAC under the Workers secret, handed in by the composition root;
//   - ProofCodeIds: the ids of the rows a send writes, made from the call's key (CQ-09: opaque, made by code).
//
// No port is handed a code: the store gets the code's keyed hash, and the code only inside the email row's final parts,
// which hold it by design (K-09 v1 sendProofCode: "the email row's final parts hold it").

import type { EventEntry } from "../../commit";
import { NotBuiltError, type CallName } from "../../tool-api";
import { sha256Hex } from "./draw";
import type { CodeChannel, CodeState, StoredPurpose } from "./rules";
import type { CodeFinalParts, CodeRowPlan } from "./words";

// ---- the rows a send writes ------------------------------------------------------------------------------------------

/**
 * K-22 v1 proof_codes as a send writes it: the columns K-22 v1 rule 5's INSERT grants, keyed by column. used_at,
 * wrong_tries, last_wrong_at, paused_until and version keep their defaults, so a code starts unused, untried and unpaused.
 */
export interface CodeRow {
  readonly id: string;
  readonly purpose: StoredPurpose;
  readonly person_id: string | null;
  readonly business_id: string | null;
  readonly sent_to_handle_id: string;
  readonly channel: CodeChannel;
  /** HMAC-SHA-256 of the code under hash_key_name's secret, lower-case hex: never the code (BP rule 7). */
  readonly code_hash: string;
  readonly hash_key_name: string;
  readonly sent_at: string;
  readonly expires_at: string;
}

/**
 * A code's email row (ADR-016 section 1): K-05 v1 outboxRowNew's fields, with K-04 v1.1's email purpose and end (card
 * V1). Its job id is the send's key: a call with no turn writes it.
 */
export interface CodeEmailRow {
  readonly id: string;
  readonly recipientHandleId: string;
  readonly recipientPersonId: string;
  /** Null for a sign-in code, which names no business (K-09 v1 tool-api schema line 4065). */
  readonly businessId: string | null;
  readonly bookingId: null;
  readonly channel: "email";
  /** RULES 4.3: a quick reply goes at any hour (ADR-016 section 3). */
  readonly sendClass: "quick_reply";
  readonly openQuestionId: null;
  readonly copyOfRowId: null;
  /** Empty: limit 8 never makes it stale by a version (ADR-016 section 3). */
  readonly versionsRead: readonly never[];
  /** K-04 v1.1 outbox_rows.email_purpose: K-12 v1's purpose of a code's email. */
  readonly emailPurpose: "code";
  /** K-04 v1.1 outbox_rows.not_after: the code's expires_at; no part of the row is sent at or after it. */
  readonly notAfter: string;
}

/** The email row with the plan and final parts it is written with, in the send's one transaction (ADR-016 section 1). */
export interface CodeEmail {
  readonly row: CodeEmailRow;
  readonly plan: CodeRowPlan;
  /** They hold the code: never logged, never in a span or an entry (K-08 v1.1 proof_code.sent). */
  readonly finalParts: CodeFinalParts;
}

/**
 * One send, written all or nothing under its key: the code row, its email row (none for a ready text: MC C9), and the
 * entries, none of which holds the plan, the final parts, the code, its hash or an address (ADR-016 section 1, "The
 * entries"). A repeated key writes nothing.
 */
export interface CodeSend {
  /** The key a repeat is known by: the caller's request id. Also the job id of the rows and entries (no turn). */
  readonly key: string;
  /** The call's trace id (K-08). */
  readonly traceId: string;
  readonly code: CodeRow;
  readonly email: CodeEmail | null;
  readonly events: readonly EventEntry[];
}

/** A send already written under a key, as a repeat answers it: never the code, which is not kept. */
export interface SentCode {
  readonly proofCodeId: string;
  readonly expiresAt: string;
  readonly outboxRowId: string | null;
}

/** K-05 transientError: nothing was written; the same request may be sent again. */
export interface TransientRefusal {
  readonly error: "transient";
  readonly sqlstate: string;
}

/** The send written (or found written under its key: `repeated`, with the first send), or refused with nothing written. */
export type SendCommitAnswer =
  { readonly committed: true; readonly repeated: boolean; readonly first: SentCode } | TransientRefusal;

/** What K-22 v1 proof_code_limits is asked: the contact a code is about to go to. */
export interface LimitsAsk {
  readonly handleId: string;
  readonly purpose: StoredPurpose;
  /** The start of the window codes are counted in. */
  readonly since: string;
  readonly at: string;
}

/** K-22 v1 proof_code_limits: codes to the contact since `since` (every person and purpose), and its pause. */
export interface CodeLimits {
  readonly sentSince: number;
  /** The latest pause after `at` of a code for that contact and purpose, or null. */
  readonly pausedUntil: string | null;
}

// ---- a typed code's check ----------------------------------------------------------------------------------------

/** K-22 v1 check_proof_code's answer. */
export type CheckOutcome = "unknown" | "used" | "paused" | "expired" | "right" | "wrong";

/** One typed code's check, keyed: the caller hashed it first with the key hash_key_name names. */
export interface CheckAsk {
  /** The inbound event or page request id: a repeat answers its first result (K-09 v1 proveCode). */
  readonly key: string;
  readonly codeId: string;
  readonly typedHash: string;
  readonly at: string;
}

/** A check's result: the outcome and the row after it, without its hash. */
export interface CheckResult {
  readonly outcome: CheckOutcome;
  /** The code's row after the check; null when there is none (unknown). */
  readonly code: CodeState | null;
  /** True when this key was checked before: the first check's outcome and row, nothing counted again. */
  readonly repeated: boolean;
}

// ---- the store -----------------------------------------------------------------------------------------------------

/** K-22 v1's codes through the data-access calls, on the call's transaction. */
export interface ProofCodeStore {
  /** The send already written under this key, or null. */
  sentFor(key: string): Promise<SentCode | null>;
  /** K-22 v1 proof_code_limits for the contact. */
  limits(ask: LimitsAsk): Promise<CodeLimits>;
  /** Writes one send, all or nothing; a key already written writes nothing and answers the first send. */
  commitSend(send: CodeSend): Promise<SendCommitAnswer>;
  /** The code's row without its hash (K-22 v1 rule 5's SELECT), or null. */
  code(codeId: string): Promise<CodeState | null>;
  /** The first check of this code under this key, or null. */
  checkedFor(key: string, codeId: string): Promise<CheckResult | null>;
  /** K-22 v1 check_proof_code under the key: locks the row, counts a wrong try, sets the pause at the fifth. */
  check(ask: CheckAsk): Promise<CheckResult>;
  /** Appends a check's entries (K-08 v1.1 proof_code.checked) in the call's transaction. */
  logCheck(key: string, events: readonly EventEntry[]): Promise<void>;
}

/** No data-access calls for codes yet (K-05: ADR-016 card V3, CQ-44): every call answers notBuilt and writes nothing. */
export function notBuiltStore(call: CallName): ProofCodeStore {
  const refuse = (): Promise<never> => Promise.reject(new NotBuiltError(call));
  return {
    sentFor: refuse,
    limits: refuse,
    commitSend: refuse,
    code: refuse,
    checkedFor: refuse,
    check: refuse,
    logCheck: refuse,
  };
}

// ---- ids -------------------------------------------------------------------------------------------------------------

/** The ids of the rows a send writes, made from its key, so a repeat names the same rows. */
export interface ProofCodeIds {
  /** The K-22 v1 proof_codes row's id. */
  codeId(key: string): Promise<string>;
  /** The email row's id (K-04 outbox_rows). */
  emailRowId(key: string): Promise<string>;
}

/**
 * The ids the Worker uses: a prefix and the first 32 hex digits of the sha256 of the row's kind and the key, so they
 * carry no key, address or code, and are K-08 safe ids.
 */
export const KEYED_CODE_IDS: ProofCodeIds = {
  codeId: async (key) => `proof-${(await sha256Hex(JSON.stringify(["proofCode", key]))).slice(0, 32)}`,
  emailRowId: async (key) =>
    `out-proof-code-${(await sha256Hex(JSON.stringify(["codeEmail", key]))).slice(0, 32)}`,
};
