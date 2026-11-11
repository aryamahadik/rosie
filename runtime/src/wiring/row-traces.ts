// The trace each outbox row was sent on, kept by the composition root (T-550) so a delivery receipt lands on its text's
// trace (K-08: one trace id from the webhook to the delivery receipt; ADR-009). The dispatcher hands each claimed row the
// trace of the turn that woke it; the receipt door finds that trace again by the part key the receipt echoes (K-11
// `partKey`, K-07's <row>/<part>/<try>).
//
// This isolate's memory only: K-05 markPart's answer names no trace id (QUESTIONS.md CQ-102, T-260's gap receiptTrace),
// so a receipt for a row this isolate did not send, or one that echoes no part key, goes on the receipt's own trace, as the
// gateway opened it. The newest ROW_MEMORY rows are kept; the oldest is forgotten first.

import type { TraceContext } from "../trace";

/** How many rows' traces one isolate keeps (as many as the clock arming's memory of armed parts). */
export const ROW_MEMORY = 1024;

export class RowTraces {
  private readonly traces = new Map<string, TraceContext>();

  constructor(private readonly limit: number = ROW_MEMORY) {}

  /** Keeps the trace a row is sent on. */
  keep(outboxRowId: string, trace: TraceContext): void {
    this.traces.delete(outboxRowId);
    this.traces.set(outboxRowId, trace);
    while (this.traces.size > this.limit) {
      const oldest = this.traces.keys().next().value;
      if (oldest === undefined) break;
      this.traces.delete(oldest);
    }
  }

  /** The trace of the row a part key names, or null when the key is missing or this isolate sent no such row. */
  forPart(partKey: string | null): TraceContext | null {
    if (partKey === null) return null;
    const outboxRowId = partKey.split("/")[0] ?? "";
    return this.traces.get(outboxRowId) ?? null;
  }

  /** The trace a row was sent on, or null when this isolate sent no such row (a retry run's row: T-563). */
  forRow(outboxRowId: string): TraceContext | null {
    return this.traces.get(outboxRowId) ?? null;
  }
}
