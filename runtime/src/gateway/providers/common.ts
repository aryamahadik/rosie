// What the Stripe and calendar doors share (T-275; C-044): the verdict each request ends in, the scrub of a provider
// event's payload before its write, and the one call that stores the event once (K-05 v1.1 recordProviderEvent).
//
// Answers follow T-241's rules (../answer.ts): 401 before any write; 200 for a duplicate, which the store itself says in
// the same step as the write (T-241's and T-244's rule: a check apart from the write could let two retries both pass);
// 503 when the write fails, so the provider retries; and 200 only on an answer the door positively knows, so a port or
// store answer a later minor version adds is never read as a success.

import { scrub } from "../../scrub/scrub";
import { isLabel, type SpanFacts } from "../../trace";
import type { Answer } from "../answer";
import type { ProviderEvent, ProviderEventStore } from "./types";

/** How one request ends: its status, the span's outcome, a label naming a refusal or failure, and what was decided. */
export interface Verdict {
  status: 200 | 400 | 401 | 503;
  outcome: "ok" | "dropped" | "refused" | "failed";
  errorCode: string | null;
  decided: SpanFacts;
}

/** 200: the event was written once. */
export function written(decided: SpanFacts): Verdict {
  return { status: 200, outcome: "ok", errorCode: null, decided };
}

/** 200 with nothing (more) stored: a known event id, a type Rosie does not use, an event from the other mode. */
export function dropped(decided: SpanFacts): Verdict {
  return { status: 200, outcome: "dropped", errorCode: null, decided };
}

/** 401 with nothing stored (arch 02 line 109: "Bad signature: 401, dropped"). */
export function refused(code: string, decided: SpanFacts = {}): Verdict {
  return { status: 401, outcome: "refused", errorCode: labelOr(code, "rejected"), decided };
}

/** 400: the body could not be read (T-241's default). */
export function unreadableBody(decided: SpanFacts = {}): Verdict {
  return { status: 400, outcome: "refused", errorCode: "unreadableBody", decided };
}

/** 503 with nothing stored, so the provider retries (arch 02 line 109: "Write fails: 503, and the provider retries"). */
export function failed(code: string, decided: SpanFacts = {}): Verdict {
  return { status: 503, outcome: "failed", errorCode: labelOr(code, "failed"), decided };
}

/** The JSON answer for a verdict: its status and a fixed label, never a value from the request. */
export function answerOf(verdict: Verdict): Answer {
  switch (verdict.status) {
    case 200:
      return { status: 200 };
    case 400:
      return { status: 400, error: "bad_request" };
    case 401:
      return { status: 401, error: "unauthorized" };
    case 503:
      return { status: 503, error: "unavailable" };
  }
}

function labelOr(code: string, fallback: string): string {
  return isLabel(code) ? code : fallback;
}

/** A plain object (an answer read as unknown). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string: an id or a name as the contracts hold them. */
export function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** A non-empty string or null. */
export function isTextOrNull(value: unknown): value is string | null {
  return value === null || isText(value);
}

function scrubValue(value: unknown, counts: { swapped: number }): unknown {
  if (typeof value === "string") {
    const result = scrub(value);
    counts.swapped += result.cards + result.ssns;
    return result.text;
  }
  if (Array.isArray(value)) return (value as unknown[]).map((item) => scrubValue(item, counts));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubValue(item, counts)]));
  }
  return value;
}

/**
 * The payload with every card number and Social Security number in any of its text swapped for K-06's tag (arch 02 line
 * 109: "Before any write it swaps card numbers ... and Social Security numbers for a tag"; K-07: a provider event's
 * payload never holds a card number). The ports keep only ids and a card's brand and last four, so this swaps nothing
 * on any contract answer; it holds the rule at the edge whatever an adapter sends. `swapped` counts the swaps.
 */
export function scrubPayload(payload: Record<string, unknown>): {
  payload: Record<string, unknown>;
  swapped: number;
} {
  const counts = { swapped: 0 };
  const clean = scrubValue(payload, counts) as Record<string, unknown>;
  return { payload: clean, swapped: counts.swapped };
}

/** What came of storing one event: written, a known event id (nothing more stored), or a failure named by a label. */
export type RecordOutcome = { kind: "written" } | { kind: "duplicate" } | { kind: "failed"; code: string };

/**
 * Stores one verified event once (K-05 v1.1 recordProviderEvent). Written or duplicate only on the store's own positive
 * answer for this event; a throw, an error answer (transient, constraint) or any other answer is a failure, with
 * nothing written, and the door answers 503.
 */
export async function recordOnce(
  store: ProviderEventStore,
  event: ProviderEvent,
  onError: (stage: string, error: unknown) => void,
): Promise<RecordOutcome> {
  let answer: unknown;
  try {
    answer = await store.recordProviderEvent(event);
  } catch (error) {
    onError("record", error);
    return { kind: "failed", code: "writeFailed" };
  }
  if (!isRecord(answer)) return { kind: "failed", code: "unknownStoreAnswer" };
  if (
    answer.result === "recorded" &&
    answer.provider === event.provider &&
    answer.providerEventId === event.providerEventId
  ) {
    if (answer.repeated === false) return { kind: "written" };
    if (answer.repeated === true) return { kind: "duplicate" };
  }
  if (answer.error === "transient" || answer.error === "constraint") {
    return { kind: "failed", code: answer.error };
  }
  return { kind: "failed", code: "unknownStoreAnswer" };
}
