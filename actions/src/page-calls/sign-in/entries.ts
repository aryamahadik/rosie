// The entries of a sign-in's check and of a sign-out (T-1285; ADR-016 card B2, section 6; K-05 v1.13 item 63; K-08
// v1.1 proof_code.checked; K-08 v1.2 session.started and session.ended): K-05's signInEntries on the runtime side's
// client, run after the page has its answer (K-05 v1.13 README, "The order around the page's answers"), so the answer
// waits on no entry and a failing entry takes back nothing the check or the sign-out committed: a wrong try was counted
// in proveSignIn's own transaction, which committed before the answer (DL-546 note c; K-22 README line 212).
//
// The asks name rows by their ids alone, and K-05 reads every value from the rows (refuse-sign-in-entries-caller-values),
// so no code, hash, token or address reaches an entry from here. An answer that names no row asks nothing, and then no
// call is made at all, since K-05's request needs at least one ask (DL-610 note 2: a wrong or paused check of an attempt
// with no code has no code to log).
//
// One pageRequest span on the call's trace says what became of the entries, in fixed labels alone (T-1282's security
// note b: K-08's label check would pass an id or a 6-digit string, so nothing from a request or an answer goes in it).

import type { PageRequest } from "../../../../runtime/src/gateway";
import { isLabel, type TraceContext } from "../../../../runtime/src/trace";
import type {
  EntriesAfterAnswer,
  EntriesLater,
  EntriesReport,
  SignInAfterCheckStore,
  SignInEntriesOutcome,
  SignInEntriesRequest,
  SignInEntryAsk,
} from "./types";

/** A thrown error by its name, only when that name is a label (its message could carry a value); else "error". */
function labelOf(error: unknown): string {
  return error instanceof Error && isLabel(error.name) ? error.name : "error";
}

/** K-05's answer to the entries as a report of counts and labels. */
function reportOf(outcome: SignInEntriesOutcome): EntriesReport {
  if ("error" in outcome) return { result: "failed", error: outcome.error };
  const written = outcome.entries.filter((entry) => entry.written).length;
  return { result: "logged", written, found: outcome.entries.length - written };
}

/** The entries' one span: the result and, on a failure, its label as the error code. A refused span is never logged. */
function recordEntries(timing: ReturnType<TraceContext["start"]>, report: EntriesReport): void {
  try {
    timing.finish({
      outcome: report.result === "logged" ? "ok" : "failed",
      decided: { signInEntries: report.result },
      errorCode: report.result === "failed" ? (isLabel(report.error) ? report.error : "error") : null,
    });
  } catch {
    // Nothing is logged for a refused span: the entries' report stands.
  }
}

/**
 * The entries `asks` call for, under `jobId` and the call's own trace (the trace the page entry opened, never the
 * envelope's page.traceId, a browser value only shape-checked: as T-1282's default 6), to run after the answer; null
 * when there is nothing to ask. The work never rejects.
 */
export function entriesAfterAnswer(
  page: PageRequest,
  store: Pick<SignInAfterCheckStore, "signInEntries">,
  jobId: string,
  asks: readonly SignInEntryAsk[],
): EntriesAfterAnswer | null {
  const [first, second] = asks;
  if (first === undefined) return null;
  const request: SignInEntriesRequest = {
    jobId,
    traceId: page.trace.traceId,
    entries: second === undefined ? [first] : [first, second],
  };
  return async () => {
    const timing = page.trace.start("pageRequest");
    let report: EntriesReport;
    try {
      report = reportOf(await store.signInEntries(request));
    } catch (error) {
      report = { result: "failed", error: labelOf(error) };
    }
    recordEntries(timing, report);
    return report;
  };
}

/**
 * Hands the entries to `later`, to run once the answer has gone. A binding that cannot run them loses the entries,
 * never the answer, and its span names only the failure.
 */
export function scheduleEntries(
  page: PageRequest,
  later: EntriesLater,
  work: EntriesAfterAnswer | null,
): void {
  if (work === null) return;
  try {
    later(work, page);
  } catch {
    recordEntries(page.trace.start("pageRequest"), { result: "failed", error: "notScheduled" });
  }
}
