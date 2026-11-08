// The hop checker (T-465; C-148): reads one K-08 v1 trace and says whether it shows the walking skeleton's hops once
// each, in D-017's turn order, under one trace id and one bundle id; and reads how a webhook ended at receipt, so a
// repeated webhook (a known K-06 event id) is seen dropped there. The AI gateway's own model-call spans (a portCall to
// provider anthropic per attempt: T-361; CQ-36's default) may sit between the hops; they are spans, not hops.
//
// Every problem names its hop by K-08's hop name and its place by seq. Nothing here reads a span's words: a span holds
// none (K-08 v1 README "Never the raw number or words"), and the checker reports hops, seqs, ids and labels only.

import type { Hop, Span, Trace } from "../../../contracts/generated/event-trace/event-trace.v1";

/**
 * The walking skeleton's hops in D-017's turn order (build prompt section 10, D-017: "the trace shows every hop once, in
 * order"), by K-08 v1's hop names. Each row of ops/plan/02-contracts.md section 11, in its order, and the K-08 hops it
 * writes (K-08 v1 README, "Hops"):
 */
export const SKELETON_HOPS = [
  // Webhook in, signature checked: Linq double to gateway (K-11 verify and parse).
  "receive",
  // Sealed event: gateway to handle actor (K-06); card numbers and SSNs are swapped for a tag before the write.
  "scrub",
  // Safety read on each raw text, on arrival, before batching: actor to safety read (K-02).
  "safetyRead",
  // Batch and turn lease: actor (K-04 turns, K-06 event ids).
  "batch",
  "lease",
  // Guard: keywords, then targets: actor (K-01 keywords; K-04).
  "guard",
  // Frontier from the Tool API: actor to Tool API (K-09, K-02, K-01 bundle v0).
  "frontier",
  // Decide, two reads: AI layer (K-02 verbs).
  "decideReads",
  // Gate and one commit under the turn id: Tool API to PostgreSQL (K-09, K-05, K-04, K-07, K-08).
  "gate",
  "commit",
  // The composer returns that row's plan: Tool API to AI layer (K-09, K-03).
  "compose",
  // Code fills slots and fixed lines; claim check and message checks: Tool API (K-09 finalize, K-03).
  "fillAndChecks",
  // Outbox dispatcher, limit 8: runtime (K-05 claim, K-07 the row's moves).
  "dispatch",
  // Send to the Linq double: Linq accepts the part (K-11 send; CQ-06: reply time ends at the first part's acceptance).
  "providerAccepted",
  // Delivery receipt; the clock arms: Linq double to gateway, dispatcher and clocks (K-06 delivered, K-05 arm).
  "delivered",
  "clockArmed",
] as const satisfies readonly Hop[];

export type HopProblemKind =
  "missing" | "repeated" | "outOfOrder" | "unexpected" | "seq" | "traceId" | "bundleId" | "time";

export interface HopProblem {
  readonly kind: HopProblemKind;
  /** The hop the problem is about, by K-08's name. */
  readonly hop: Hop;
  readonly message: string;
}

export interface HopCheck {
  /** True when no problem was found. */
  readonly ok: boolean;
  readonly traceId: string;
  /** The trace's hops in seq order, model-call spans left out. */
  readonly hops: readonly Hop[];
  /** The seqs of the model-call spans set aside (isModelCallSpan), in order. */
  readonly modelCallSeqs: readonly number[];
  readonly problems: readonly HopProblem[];
}

function sameBundle(a: Span["bundle_id"], b: Trace["bundle_id"]): boolean {
  return a.hash === b.hash && a.build === b.build;
}

/** The trace's spans in seq order (a trace lists them so; a collected one may not). */
export function spansInOrder(trace: Trace): Span[] {
  return [...trace.spans].sort((a, b) => a.seq - b.seq);
}

/**
 * A model call's own span: a portCall to provider anthropic, which T-361's AI gateway writes per attempt beside the
 * turn's hops (ai/src/gateway; CQ-36's default: the cost meter sums these spans' model calls). It is no hop of the turn,
 * so checkHops never counts it as one, missing, repeated or unexpected; a portCall to any other provider is a hop.
 */
export function isModelCallSpan(span: Span): boolean {
  return span.hop === "portCall" && span.provider === "anthropic";
}

/**
 * Checks that `trace` shows each of `expected` once, in that order, and no other hop: by default the walking skeleton's
 * hops (SKELETON_HOPS). Model-call spans (isModelCallSpan) may sit anywhere between them and are not hops. Every span,
 * model calls too, must be under the trace's id and bundle id, seq runs 1, 2, 3 ... and no span starts before the one
 * before it (K-08 v1 README, the contract test's checks).
 */
export function checkHops(trace: Trace, expected: readonly Hop[] = SKELETON_HOPS): HopCheck {
  const spans = spansInOrder(trace);
  const hopSpans = spans.filter((span) => !isModelCallSpan(span));
  const problems: HopProblem[] = [];

  spans.forEach((span, index) => {
    if (span.trace_id !== trace.trace_id) {
      problems.push({
        kind: "traceId",
        hop: span.hop,
        message: `hop ${span.hop} (seq ${String(span.seq)}) is under trace ${span.trace_id}, not ${trace.trace_id}: one trace id from webhook to delivery receipt`,
      });
    }
    if (span.seq !== index + 1) {
      problems.push({
        kind: "seq",
        hop: span.hop,
        message: `hop ${span.hop} has seq ${String(span.seq)} where ${String(index + 1)} comes next: seq runs 1, 2, 3 ...`,
      });
    }
    if (!sameBundle(span.bundle_id, trace.bundle_id)) {
      problems.push({
        kind: "bundleId",
        hop: span.hop,
        message: `hop ${span.hop} (seq ${String(span.seq)}) names bundle build ${String(span.bundle_id.build)} ${span.bundle_id.hash.slice(0, 12)}, not the trace's: one bundle id per trace`,
      });
    }
    const before = spans[index - 1];
    if (before !== undefined && Date.parse(span.at) < Date.parse(before.at)) {
      problems.push({
        kind: "time",
        hop: span.hop,
        message: `hop ${span.hop} (seq ${String(span.seq)}) starts before hop ${before.hop} (seq ${String(before.seq)}): time never goes back`,
      });
    }
  });

  const seqsOf = new Map<Hop, number[]>();
  for (const span of hopSpans) {
    const seqs = seqsOf.get(span.hop) ?? [];
    seqs.push(span.seq);
    seqsOf.set(span.hop, seqs);
  }
  for (const hop of expected) {
    const seqs = seqsOf.get(hop) ?? [];
    if (seqs.length === 0) {
      problems.push({ kind: "missing", hop, message: `hop ${hop} is missing: every hop runs once` });
    } else if (seqs.length > 1) {
      problems.push({
        kind: "repeated",
        hop,
        message: `hop ${hop} runs ${String(seqs.length)} times (seq ${seqs.join(", ")}): every hop runs once`,
      });
    }
  }
  for (const [hop, seqs] of seqsOf) {
    if (!expected.includes(hop)) {
      problems.push({
        kind: "unexpected",
        hop,
        message: `hop ${hop} (seq ${seqs.join(", ")}) is not one of this trace's hops`,
      });
    }
  }

  // The turn order, read from each expected hop's first run.
  const firsts = hopSpans.filter(
    (span, index) => expected.includes(span.hop) && hopSpans.findIndex((s) => s.hop === span.hop) === index,
  );
  firsts.forEach((span, index) => {
    const before = firsts[index - 1];
    if (before !== undefined && expected.indexOf(span.hop) < expected.indexOf(before.hop)) {
      problems.push({
        kind: "outOfOrder",
        hop: span.hop,
        message: `hop ${span.hop} (seq ${String(span.seq)}) runs after hop ${before.hop} (seq ${String(before.seq)}), but the turn order puts ${span.hop} first`,
      });
    }
  });

  return {
    ok: problems.length === 0,
    traceId: trace.trace_id,
    hops: hopSpans.map((s) => s.hop),
    modelCallSeqs: spans.filter(isModelCallSpan).map((s) => s.seq),
    problems,
  };
}

/** How a webhook ended at receipt: the trace's receive span (arch 02 line 109; K-08 v1 hop receive). */
export interface ReceiptReading {
  readonly traceId: string;
  /** The K-06 event id the receive span names (the dedupe key), or null. */
  readonly eventId: string | null;
  readonly outcome: Span["outcome"];
  /** What receive decided: the signature valid, the event id already known, the HTTP answer; null when not said. */
  readonly signatureValid: boolean | null;
  readonly knownEventId: boolean | null;
  readonly answered: number | null;
  /** For a repeated event, the trace of its first arrival, when the span names it. */
  readonly firstTraceId: string | null;
  /** The hops after receive, in seq order: none when the webhook was dropped at receipt. */
  readonly hopsAfter: readonly Hop[];
  /** Dropped at receipt: receive ended `dropped` and no hop ran after it. */
  readonly droppedAtReceipt: boolean;
  /** A repeated webhook: dropped at receipt because its K-06 event id is already known (arch 02 line 109). */
  readonly repeatedWebhook: boolean;
}

function flag(span: Span, name: string): boolean | null {
  const value = span.decided?.[name];
  return typeof value === "boolean" ? value : null;
}

function count(span: Span, name: string): number | null {
  const value = span.decided?.[name];
  return typeof value === "number" ? value : null;
}

function label(span: Span, name: string): string | null {
  const value = span.decided?.[name];
  return typeof value === "string" ? value : null;
}

/** Reads the receive span of a text's trace. Throws when the trace does not start with receive. */
export function readReceipt(trace: Trace): ReceiptReading {
  const [receive, ...after] = spansInOrder(trace);
  if (receive?.hop !== "receive") {
    throw new Error(
      `trace ${trace.trace_id} starts with hop ${receive?.hop ?? "(none)"}, not receive: it is not a webhook's trace`,
    );
  }
  const knownEventId = flag(receive, "knownEventId");
  const droppedAtReceipt = receive.outcome === "dropped" && after.length === 0;
  return {
    traceId: trace.trace_id,
    eventId: receive.event_id ?? null,
    outcome: receive.outcome,
    signatureValid: flag(receive, "signatureValid"),
    knownEventId,
    answered: count(receive, "answered"),
    firstTraceId: label(receive, "firstTrace"),
    hopsAfter: after.map((span) => span.hop),
    droppedAtReceipt,
    repeatedWebhook: droppedAtReceipt && knownEventId === true,
  };
}

/**
 * Checks that `repeat`, a webhook sent again with the event id of `first`, was dropped at receipt as a known event id
 * (K-06: the event id is the dedupe key; arch 02 line 109) and so ran no hop after receive. Problems, one line each.
 */
export function checkRepeat(first: Trace, repeat: Trace): string[] {
  const one = readReceipt(first);
  const two = readReceipt(repeat);
  const problems: string[] = [];
  if (one.droppedAtReceipt) problems.push(`the first trace ${one.traceId} was itself dropped at receipt`);
  if (one.eventId === null || two.eventId !== one.eventId) {
    problems.push(
      `the repeat's receive names event ${two.eventId ?? "(none)"}, the first's ${one.eventId ?? "(none)"}: a repeat carries the same event id`,
    );
  }
  if (!two.repeatedWebhook) {
    problems.push(
      `the repeat ${two.traceId} was not dropped at receipt as a known event id (outcome ${two.outcome}, knownEventId ${String(two.knownEventId)}, ${String(two.hopsAfter.length)} hops after receive)`,
    );
  }
  if (two.firstTraceId !== null && two.firstTraceId !== one.traceId) {
    problems.push(`the repeat names first trace ${two.firstTraceId}, not ${one.traceId}`);
  }
  if (two.traceId === one.traceId)
    problems.push(`the repeat reuses trace id ${one.traceId}: each webhook opens its own`);
  return problems;
}
