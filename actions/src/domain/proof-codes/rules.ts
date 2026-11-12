// RULES 6.2 in code (T-322; C-095): "A code works 10 minutes. Five wrong codes pause it 15 minutes. Rosie never asks for
// a code." The numbers are code's (K-22 README "the number and the window are code's"; ADR-016 section 4, "The
// numbers"), and K-22 v1's CHECKs and check_proof_code hold the same ones in the database: two locks.
//
// A code's standing at a time is read from its row without its hash (K-22 v1 rule 5's SELECT): used once, paused for 15
// minutes from its fifth wrong code, and dead outside its 10 minutes. Only a live code is checked against its hash
// (check_proof_code), so a code past its 10 minutes or inside its pause fails here, before any try is made or counted.
//
// The K-09 v1 purposes map to K-22 v1's as the K-09 README's "Proof codes in K-22 v1" table maps them.

import type { RequestOf } from "../../tool-api";

/** A code works this long after it is made (RULES 6.2; K-22 v1 proof_codes_ten_minutes). */
export const CODE_LIFE_MINUTES = 10;

/** The wrong codes that pause a code (RULES 6.2; K-22 v1 proof_codes_pause_after_five). */
export const WRONG_TRIES_TO_PAUSE = 5;

/** How long the fifth wrong code pauses it (RULES 6.2; K-22 v1 proof_codes_pause_after_five). */
export const PAUSE_MINUTES = 15;

/**
 * At most this many codes go to one contact in DAY_HOURS, every person and purpose (S13-45: "At most a few codes a day
 * per contact"; ADR-016 open point 1's default, which sendSignInCode reads through K-22 v1 proof_code_limits).
 */
export const CODES_PER_CONTACT_PER_DAY = 5;

/** The window the day's codes are counted in, rolling (ADR-016 section 4, rule 3). */
export const DAY_HOURS = 24;

const MINUTE_MS = 60_000;

/** K-09 v1 sendProofCode.request.purpose. */
export type Purpose = RequestOf<"sendProofCode">["purpose"];
/** K-09 v1 sendProofCode.request.route. */
export type Route = RequestOf<"sendProofCode">["route"];

/** K-22 v1 proof_codes.purpose (proof_codes_purpose_known). */
export type StoredPurpose =
  | "sign_in"
  | "owner_email"
  | "new_device"
  | "contact_change"
  | "listing_control"
  | "closing_or_export"
  | "hand_over"
  | "link_record";

/** Each K-09 v1 purpose is one K-22 v1 purpose (K-09 README "Proof codes in K-22 v1"; default 34). */
export const STORED_PURPOSE: Readonly<Record<Purpose, StoredPurpose>> = {
  signIn: "sign_in",
  emailCheck: "owner_email",
  unprovenSender: "link_record",
  newContact: "contact_change",
  control: "listing_control",
};

/** K-22 v1 proof_codes.channel: email on an email route, text on textFromMobile (K-09 README "Proof codes in K-22 v1"). */
export type CodeChannel = "text" | "email";

export function channelOf(route: Route): CodeChannel {
  return route === "textFromMobile" ? "text" : "email";
}

/** Milliseconds since the epoch of a UTC instant; a value that is not one throws, naming no value. */
export function msOf(utc: string): number {
  const ms = Date.parse(utc);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u.test(utc) || Number.isNaN(ms)) {
    throw new TypeError("a time must be an instant in UTC ending in Z");
  }
  return ms;
}

/** An instant in UTC ending in Z, to the whole second unless it has milliseconds (the fixtures' form). */
export function utcOf(ms: number): string {
  return new Date(ms).toISOString().replace(/\.000Z$/u, "Z");
}

/** When a code made at `sentAt` stops working: 10 minutes on (K-22 v1 proof_codes_ten_minutes). */
export function expiresAtOf(sentAt: string): string {
  return utcOf(msOf(sentAt) + CODE_LIFE_MINUTES * MINUTE_MS);
}

/** When the pause set by a fifth wrong code at `lastWrongAt` ends: 15 minutes on (proof_codes_pause_after_five). */
export function pauseEndOf(lastWrongAt: string): string {
  return utcOf(msOf(lastWrongAt) + PAUSE_MINUTES * MINUTE_MS);
}

/** The start of the day's window that ends at `now`. */
export function dayWindowStartOf(now: string): string {
  return utcOf(msOf(now) - DAY_HOURS * 60 * MINUTE_MS);
}

/** A K-22 v1 proof_codes row as the service reads it: every column but code_hash (K-22 v1 rule 5's SELECT). */
export interface CodeState {
  readonly id: string;
  readonly purpose: StoredPurpose;
  /** The person the code proves; null only for a listing's control code. */
  readonly personId: string | null;
  /** The business its words name; null for a sign-in code. */
  readonly businessId: string | null;
  /** Where it went (K-04 handles.id). */
  readonly sentToHandleId: string;
  readonly channel: CodeChannel;
  readonly sentAt: string;
  readonly expiresAt: string;
  /** Wrong codes typed for it, 0 to 5. */
  readonly wrongTries: number;
  readonly lastWrongAt: string | null;
  readonly pausedUntil: string | null;
  readonly usedAt: string | null;
  readonly version: number;
}

/** What a code is at one time, read from its row alone. */
export type Standing =
  /** It may be checked against its hash. */
  | { readonly standing: "live" }
  /** Its right code was typed: it works once (RULES 6.1, 6.2). */
  | { readonly standing: "used" }
  /** Five wrong codes paused it: nothing for it is taken until `until` (RULES 6.2). */
  | { readonly standing: "paused"; readonly until: string }
  /** Outside its 10 minutes, or dead after five wrong codes once the pause is over (proof_codes_used_in_time). */
  | { readonly standing: "expired" };

/**
 * A code's standing at `at`, by RULES 6.2 alone: used once; paused for PAUSE_MINUTES from its fifth wrong code, during
 * which a right code fails too; never usable after five wrong codes; and live only from when it was made to
 * CODE_LIFE_MINUTES on, both ends included (K-22 v1 proof_codes_used_in_time: sent_at <= used_at <= expires_at).
 */
export function standingAt(code: CodeState, at: string): Standing {
  const when = msOf(at);
  if (code.usedAt !== null) return { standing: "used" };
  if (code.wrongTries >= WRONG_TRIES_TO_PAUSE) {
    if (code.lastWrongAt === null) return { standing: "expired" };
    const until = pauseEndOf(code.lastWrongAt);
    return when < msOf(until) ? { standing: "paused", until } : { standing: "expired" };
  }
  const end = Math.min(msOf(code.expiresAt), msOf(expiresAtOf(code.sentAt)));
  if (when < msOf(code.sentAt) || when > end) return { standing: "expired" };
  return { standing: "live" };
}

/** Wrong tries left before the pause, after `wrongTries` wrong codes (K-09 v1 ProofWrong.triesLeft: 0 to 4). */
export function triesLeftAfter(wrongTries: number): number {
  return Math.max(0, WRONG_TRIES_TO_PAUSE - wrongTries);
}
