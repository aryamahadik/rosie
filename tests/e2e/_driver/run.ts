// What a target collects after a text and how the driver judges it (T-465; C-148): the trace by its trace id (K-08 v1),
// the parts the Linq double sent (K-11 v1, K-21 v1) with the double's own receipts and failures, and the outbox rows
// written under that trace (K-07 v1). Shared by the local and the staging target.

import type { DoubleEvent } from "../../../adapters/src/linq/double/types";
import type { Hop, Trace } from "../../../contracts/generated/event-trace/event-trace.v1";
import { SKELETON_HOPS, checkHops, type HopCheck } from "./hops";
import type { OutboxCheck } from "./outbox";
import { checkParts, deliveryName, type PartsCheck, type SentPart } from "./parts";

export type TargetName = "local" | "staging";

/** A text sent into the gateway: the gateway's answer and the trace it opened at receipt. */
export interface SentText {
  readonly target: TargetName;
  /** The K-06 event id the webhook carried. */
  readonly eventId: string;
  /** The trace id the gateway opened at receipt (its x-trace-id answer; K-21 testPhoneSend's traceId). */
  readonly traceId: string;
  /** The gateway's HTTP answer to the webhook: 200 accepted or dropped, 401 a bad signature, 503 a failed write. */
  readonly gatewayStatus: number;
}

export interface Collected {
  readonly target: TargetName;
  readonly traceId: string;
  /** The trace as a K-08 v1 document, or null when the target read no span of it. */
  readonly trace: Trace | null;
  /** Why the trace is missing or not a K-08 v1 trace; empty when it is one. */
  readonly traceProblems: readonly string[];
  /** The parts the Linq double sent, in order (on staging, to the test phone named). */
  readonly parts: readonly SentPart[];
  /**
   * The Linq double's faked receipts, failures and votes, in order (LinqDouble.events()), which say how a sent part
   * ended; null when the target cannot read them (staging: K-21 v1 testPhoneParts gives none).
   */
  readonly linqEvents: readonly DoubleEvent[] | null;
  /** The outbox rows written under the trace, checked against K-07 v1; null when the target has no outbox reader. */
  readonly outbox: OutboxCheck | null;
}

export interface CollectOptions {
  /** Read again until this holds or `timeoutMs` passes: later hops (the batch's 3 s quiet, the receipt) log later. */
  readonly until?: (collected: Collected) => boolean;
  /** Default 0: one read. */
  readonly timeoutMs?: number;
  /** Default 100. */
  readonly pollMs?: number;
}

/** Reads with `read` until `options.until` holds or the time is up; the last reading either way. */
export async function settle(
  read: () => Promise<Collected>,
  options: CollectOptions = {},
): Promise<Collected> {
  const deadline = Date.now() + (options.timeoutMs ?? 0);
  let last = await read();
  while (options.until !== undefined && !options.until(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 100));
    last = await read();
  }
  return last;
}

export interface RunReport {
  readonly traceId: string;
  /** The hop check, or null when there is no trace to check. */
  readonly hops: HopCheck | null;
  readonly parts: PartsCheck;
  /** Outbox rows read under the trace, or null when the target cannot read them. */
  readonly outboxRows: number | null;
  /** Every problem found, one line each, naming hops, rows and keys, never words. Empty when the run passes. */
  readonly problems: readonly string[];
}

/**
 * Judges one collected run: the trace is a K-08 v1 trace and shows `expected` (the skeleton's hops by default) once each,
 * in order; every outbox row passes K-07 v1; no part reached the person twice, by K-07's part states and the Linq
 * double's reports (checkParts). A key sent more than once is K-07's retry on the same key: no problem by itself.
 */
export function checkRun(collected: Collected, expected: readonly Hop[] = SKELETON_HOPS): RunReport {
  const problems: string[] = [...collected.traceProblems];
  const hops = collected.trace === null ? null : checkHops(collected.trace, expected);
  if (hops !== null) problems.push(...hops.problems.map((problem) => problem.message));
  const parts = checkParts(collected.parts, {
    events: collected.linqEvents,
    rows: collected.outbox?.rows ?? null,
  });
  problems.push(
    ...parts.duplicateSends.map(
      ({ part, deliveries }) =>
        `part ${part} reached the person ${String(deliveries.length)} times (${deliveries.map(deliveryName).join(", ")}): each part once`,
    ),
  );
  problems.push(
    ...parts.unjudgedSends.map(
      ({ part, deliveries }) =>
        `part ${part} went as ${String(deliveries.length)} messages (${deliveries.map(deliveryName).join(", ")}) and no K-07 part state or Linq double report was read for them: one delivery cannot be shown`,
    ),
  );
  if (collected.outbox !== null) problems.push(...collected.outbox.problems);
  return {
    traceId: collected.traceId,
    hops,
    parts,
    outboxRows: collected.outbox === null ? null : collected.outbox.rows.length,
    problems,
  };
}
