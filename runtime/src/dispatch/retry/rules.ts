// The dispatcher's retry rules (T-258; C-124; K-07 v1 retry rules 1, 2, 5, 6 and 7; K-11 v1 'Outcomes of a send'; arch 01
// line 65; arch 10 lines 524 and 540).
//
// `retryRuleFor` is pure: Linq's reported failure of one part and the row it belongs to go in, the rule for the part's
// next try comes out, picked by K-11's `kind`:
//
//   kind                     rule          what the dispatcher writes, and what the next try waits for
//   transient, no answer     sameKey       nothing on the part: the next try goes under the same key (K-07 rule 1: "a
//   (httpStatus null)                      retry after a timeout or crash reuses the key"), and the re-claim that hands it
//                                          out raises `attempts` (K-05 v1.1 item 13; K-07 part move pending → pending)
//   transient with a status, newKey        markPart failed with retry: the next try's key, written with the failure (K-07
//   refused, rateLimited                   rule 1: "one after a reported failure gets a new key"), with the provider's
//                                          Retry-After as the claim's nextTryNotBefore when it gives one (K-07 rule 6;
//                                          error-rate-limit.json; mark-failed-retry-after.json)
//   mayStillDeliver          awaitReceipt  markPart failed without retry (mark-failed-4006.json): no new key until 1 minute
//   (4001, 4006)                           passes with no delivery receipt; a receipt in that minute moves the part to
//                                          delivered and ends the retries (K-07 rule 2; error-4006.json;
//                                          outbox-4006-new-key.json; mark-delivered-by-key.json)
//   optedOut                 optedOut      markPart failed without retry: never retried on Linq, which blocks every send
//   (403, code 2024)                       after an exact STOP, override_optout or not (K-07 rule 7; arch 10 line 524; K-11
//                                          spike row 15). A row the stop binds goes the stop path: dropped as stopped
//                                          (markRow droppedStopped; error-403-2024.json), as limit 8 drops one. A safety
//                                          line keeps its row for its other ways (C-126: K-07 rule 3).
//
// Every wait rides the retry queue (T-256; arch 10 line 540: "sends follow step 8, each try after any Retry-After").
// The try after it goes under a new claim (K-05 v1.1 item 13: a lapsed claim is claimed again), so no wait is shorter
// than what is left of the claim the failed try was sent under.

import { isSafety, isStopReply } from "../limit8";
import type { ClaimedRow, LinqFailed } from "../types";

/** After a 4001 or 4006 a new key waits this long for a delivery receipt (arch 01 line 65; K-07 RECEIPT_WAIT_MS). */
export const RECEIPT_WAIT_S = 60;
/**
 * Without a Retry-After, the next try waits at least this long: K-07 rule 3's 10 s, the one spacing the sources give
 * (T-256's SEND_SPACING_S). The claim's own life (60 s) is longer, so in practice the try waits for the claim to lapse.
 */
export const RETRY_SPACING_S = 10;
/** Sends still failing after 15 minutes of tries take the next way (arch 02 line 125; K-07 rule 5: GIVE_UP_AFTER_MS). */
export const GIVE_UP_AFTER_MS = 15 * 60_000;

/** The rule for a failed part's next try. `code` is the label recorded with it: Linq's code, else its kind. */
export type RetryRule =
  /** No answer (a timeout or a lost connection): the next try goes under the same key. */
  | { rule: "sameKey"; code: string }
  /** A reported failure: the next try under a new key, after the provider's Retry-After when it gave one. */
  | { rule: "newKey"; code: string; retryAfterSeconds: number | null }
  /** 4001 or 4006, which may still deliver: a new key only if no receipt comes within the minute. */
  | { rule: "awaitReceipt"; code: string }
  /** 403 code 2024: no retry on Linq. `dropRow`: the stop binds the row, so it goes the stop path. */
  | { rule: "optedOut"; code: string; dropRow: boolean };

export type RetryRuleName = RetryRule["rule"];

/**
 * Whether a send of this row may carry override_optout: only a safety line and a stop reply, the sends the rules allow
 * after an exact STOP (arch 10 line 524; RULES 4.3, 4.12). Every other row is bound by the stop (hard invariant: no routine
 * text after STOP).
 */
export const mayOverrideOptout = (row: ClaimedRow): boolean => isSafety(row) || isStopReply(row);

/** A Retry-After as whole seconds from 0, or null when there is none or it cannot be read. */
const secondsOf = (value: number | null): number | null =>
  value !== null && Number.isFinite(value) && value >= 0 ? Math.ceil(value) : null;

/** The rule for the try after Linq's reported failure of a part of `row` (K-11's table; K-07's retry rules). */
export function retryRuleFor(failed: LinqFailed, row: ClaimedRow): RetryRule {
  const code = failed.code ?? failed.kind;
  switch (failed.kind) {
    case "optedOut":
      // Not retried as it was (K-07 rule 7). A stop reply has no other way to go, so it ends with the stop as well.
      return { rule: "optedOut", code, dropRow: !isSafety(row) };
    case "mayStillDeliver":
      return { rule: "awaitReceipt", code };
    case "rateLimited":
    case "refused":
      return { rule: "newKey", code, retryAfterSeconds: secondsOf(failed.retryAfterSeconds) };
    case "transient":
      // No status: no answer came, so Linq may hold the send under its key; a status is a failure Linq reported.
      return failed.httpStatus === null
        ? { rule: "sameKey", code }
        : { rule: "newKey", code, retryAfterSeconds: secondsOf(failed.retryAfterSeconds) };
  }
}

/** Whole seconds from `from` until `until` (UTC), at least 0; 0 when either cannot be read. */
export function secondsBetween(from: string, until: string): number {
  const ms = Date.parse(until) - Date.parse(from);
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : 0;
}

/** The UTC instant `seconds` after `at`. */
export const secondsAfter = (at: string, seconds: number): string =>
  new Date(Date.parse(at) + seconds * 1000).toISOString();

/**
 * How long the next try waits after a failure at `at`: the rule's own wait (the receipt's minute, the provider's
 * Retry-After, else the spacing), and never less than what is left of the claim the failed try went under, since the next
 * try goes under a new claim.
 */
export function waitSecondsFor(rule: RetryRule, at: string, claimLapsesAt: string): number {
  const own =
    rule.rule === "awaitReceipt"
      ? RECEIPT_WAIT_S
      : rule.rule === "newKey" && rule.retryAfterSeconds !== null
        ? rule.retryAfterSeconds
        : RETRY_SPACING_S;
  return Math.max(1, own, secondsBetween(at, claimLapsesAt));
}

/** True once 15 minutes of tries have passed since the claim's first try (K-07 rule 5): no new retry is started. */
export const triesOver = (firstTryAt: string | null, at: string): boolean =>
  firstTryAt !== null && Date.parse(at) - Date.parse(firstTryAt) >= GIVE_UP_AFTER_MS;
