// The AI provider down (T-271; C-174; S12-12; arch 11 'AI provider down or slow', architecture.txt line 564: "One retry,
// then the other model once ... Still failing: each text whose turn has not committed gets 'Rosie is down for a few
// minutes. If anyone is in danger, call 911.' once, never to a stopped number. The turn retries every 30 s. On return:
// danger first, then stops, then the rest in order"; arch 06 'A model call fails', line 293: "before the commit, section
// 11's outage rows; after it, step 7's fallback for that row").
//
// The one retry and the other model are the AI gateway's (T-361): what reaches the turn is its typed `modelsDown`, through
// decide or the one re-read (`MODELS_DOWN`). This file is what the handle actor does with it, inside the turn's lease:
//
//   1. A run of the turn ends with nothing committed and the models down (the turn says who waits: `WaitingTurn`).
//   2. Each of its texts gets the outage line once (K-01 fixed line `outage`, K-09 v1 sendFixedLine, send class
//      quick_reply), never to a stopped number: not when one of the turn's own texts is a stop word; not while the handle
//      actor that runs the turn says the number may have asked to stop by a word no commit has recorded yet (T-1323: its
//      copy of the flag, or a text no commit has taken that may hold a stop word, such as a STOP waiting behind a turn that
//      has used its second restart or one in its open batch window, by the one reading the safety read's own outage line
//      asks, T-1313), asked right before each text's line, since the actor takes texts while a line is out, and before
//      the try's rows are woken; not when the handle's stopped flag says stopped; not after the core answers
//      `phoneStopped`; at send, limit 8 drops the row for a stopped phone (T-259), and the dispatcher asks the recipient
//      actor this same reading right before each part goes, dropping the row on any answer but exactly false (T-1337).
//      Every row the try's lines named, first or repeated, is woken once the try's last line is asked, while the actor
//      still says no word waits, so it goes, or is dropped by the dispatcher's own ask, at once (T-1341, DL-669); after
//      its word none is woken (a wake runs every sendable row of the recipient, and a routine row is not asked: T-1342),
//      and a row not woken, or whose wake fails, waits for the recipient's next dispatcher run, which asks the reading
//      again; no sweep runs. A line held back here for a stop is not asked for again in that run (the turn's next run
//      checks again). The request is the one the safety read's timeout rule sends
//      for the same text (kind job, request id `safety:<event id>`: runtime/src/safety), and K-09 sends a fixed line once
//      per request id, so a text gets the line once whichever path asks first, a rerun of the turn included (it asks again
//      and is answered `repeated`). A text the safety read already gave the line is not asked for at all. A line the core
//      does not answer for now is asked for again on the next retry.
//   3. The turn runs again 30 s after the last try began, and every 30 s while the models are down, until it commits (a
//      try the gateway's own timeouts made slow does not push the next one back). The retry its lease would not outlast
//      is not run: the lease's lapse reruns the turn then (T-248; its 60 s lease is two tries), 30 s after the last try
//      began, and the rerun goes on the same way. A run no longer the turn's stops at once.
//   4. Only a turn with no stop word waits for the models' return. A turn holding one never does (DL-508, DL-521; arch
//      06 line 329: a change that only protects commits at once): whatever the models answer, its keyword texts commit on
//      the run, core-only on the run that finds the models down (runtime/src/turn), so this path holds such a turn only
//      when that commit does not go through, and then it waits for the core, not the models: on a later try it commits
//      core-only while they are still down, or with the decided input once they are back. On return the turn commits
//      once, its core actions in the return order (`inReturnOrder`, in the turn's commit), the order a STOP's core-only
//      commit keeps too: every text's safety record first, the danger texts' leading ("danger words are read first":
//      S12-12), then the stop and start records ("and stops next"), then the rest of the keyword texts' actions; the
//      decided parts follow the core actions in the commit (C-087: "the turn's core actions, then the parts"), so the
//      routine texts come last.
//
// After the commit nothing here runs: a model call that fails then takes step 7's path for its row (the turn's compose,
// ../../turn/compose.ts), never the outage line. Unwired (no `setOutageDeps`), a run whose models are down ends as it did
// before: nothing is sent, and the lease's lapse reruns the turn. Every run the lease starts names its handle actor first
// (`setOutageHost`, at the run's pin); a run with no actor named (a test's own leased turn) asks no actor, and its other
// checks stand. Never logged or put in a span: a text's words, a number.
//
// Not here: the AI gateway's retry and other model (T-361); the database-down path (T-270); the outage state pages and AIs
// read (T-608); pausing customer deadlines (T-272).

import { RETURN_RANKS, type ReturnRank } from "../../actor/copies/return-queue";
import type { SendFixedLineRequest, SendFixedLineResponse } from "../../safety/types";
import type {
  OutageClock,
  OutageDeps,
  OutageEnd,
  OutageHost,
  OutageLineSent,
  OutageReport,
  WaitingText,
  WaitingTurn,
} from "./types";

/** How often the turn runs again while the models are down (arch 11 line 564: "The turn retries every 30 s"). */
export const RETRY_MS = 30_000;

/** The K-01 v1 fixed line the outage path sends (contracts/bundle fixed-lines.json `outage`). */
export const OUTAGE_LINE_ID = "outage";

/**
 * The code a decide stage answers when the AI gateway gave up on both models (T-361's typed `modelsDown`, after its one
 * retry and the other model once): the turn's `DecideFailed.error`, and the composer's after the commit.
 */
export const MODELS_DOWN = "modelsDown";

let deps: OutageDeps | null = null;

/** Sets what the AI-down path reaches for this Worker isolate; returns the function that puts the earlier one back. */
export function setOutageDeps(next: OutageDeps | null): () => void {
  const before = deps;
  deps = next;
  return () => {
    deps = before;
  };
}

/**
 * The handle actor that runs each turn, by the run's signal (T-1323): the lease hands one run the same signal for its pin,
 * which goes through the actor, and for its work (../../actor/lease.ts `start`). Weakly held: an entry goes with its run.
 */
const hosts = new WeakMap<AbortSignal, OutageHost>();

/**
 * Names the handle actor that runs a turn as the AI-down path's host for one run, by the run's signal (the actor does this
 * at the run's pin, before the run's work starts): right before each outage line of that run goes, and before the run's
 * rows are woken, the path asks it whether the number may have asked to stop (`OutageHost.stopped`; T-1323).
 */
export function setOutageHost(signal: AbortSignal, host: OutageHost): void {
  hosts.set(signal, host);
}

/** How one run of a turn ended, as far as the AI-down path reads it. */
export type RunEnd =
  { readonly result: "committed" } | { readonly result: "notCommitted"; readonly aiDown?: WaitingTurn };

/** What the lease handed the run, as far as the AI-down path reads it (`LeasedTurn`). */
export interface LeaseView {
  /** Aborted once the run is no longer the turn's. */
  readonly signal: AbortSignal;
  /** When the lease lapses, on the actor's clock (the outage clock in a joined isolate: both are the Workers clock). */
  readonly leaseUntil: number;
}

// ---- the outage line ----------------------------------------------------------------------------------------------

/**
 * K-09 v1 sendFixedLine's request for one waiting text: the outage line to the turn's handle, send class quick_reply (a
 * reply to the person's own text, which limit 8 drops for a stopped phone: QUESTIONS.md, T-246's default), sent by the
 * actor alone (kind job, no turn), under the request id the safety read's timeout rule sends the same line under, so the
 * line goes once per text whichever path asks.
 */
export function outageLineRequest(waiting: WaitingTurn, text: WaitingText): SendFixedLineRequest {
  return {
    caller: {
      kind: "job",
      turnId: null,
      requestId: `safety:${text.eventId}`,
      businessId: waiting.businessId,
      personId: waiting.personId,
      traceId: text.traceId,
    },
    fixedLineId: OUTAGE_LINE_ID,
    recipientHandleId: waiting.handleId,
    sendClass: "quick_reply",
    sentByActor: null,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The core's answer as K-09's written response, or null when it is not one. */
function writtenOf(answer: unknown): SendFixedLineResponse | null {
  if (!isRecord(answer) || "error" in answer || typeof answer.repeated !== "boolean") return null;
  const row = answer.outboxRowId;
  return row === null || (typeof row === "string" && row !== "")
    ? { outboxRowId: row, repeated: answer.repeated }
    : null;
}

/** A K-09 error's code (`phoneStopped`, `notFound`, `transient`), or null when the answer is not an error. */
const errorOf = (answer: unknown): string | null =>
  isRecord(answer) && typeof answer.error === "string" ? answer.error : null;

/**
 * True when the handle's stopped flag says stopped; null when it cannot be read now (nothing is sent then, and the next
 * retry asks again). False when no read is wired: the core and limit 8 check it.
 */
async function stoppedNow(set: OutageDeps, actorName: string): Promise<boolean | null> {
  if (set.isStopped === undefined) return false;
  try {
    return await set.isStopped(actorName);
  } catch {
    return null;
  }
}

/**
 * True when the handle actor that runs the turn says the number may have asked to stop by a word no commit has recorded
 * yet (`OutageHost.stopped`, T-1323), or cannot say: a throw, or an answer that is not false (RULES 7.2: "Unsure: treat it
 * as a stop"). False for a run with no actor named.
 */
function actorSaysStopped(host: OutageHost | null): boolean {
  if (host === null) return false;
  try {
    const answer: unknown = host.stopped();
    return answer !== false;
  } catch {
    return true;
  }
}

/**
 * Sends the outage line to each waiting text that has not had it (`done` holds the texts this run is finished with: the
 * line went, or it never will). Never throws.
 *
 * The handle actor that runs the turn takes a text during every await here (handle-actor.ts `accept` writes it and opens
 * its batch window in one synchronous step), so a STOP can come while the stopped flag is read or an earlier text's line is
 * out. So the actor's word (T-1323) is asked before the flag is read, again right before each text's line, with nothing
 * awaited between its answer and the line's request, and once more right before the try's rows (every row its lines named,
 * first or repeated: T-1341) are woken: from its first true answer on, no later line of the try is asked for (as after the
 * core's `phoneStopped`), and none of the try's rows is woken; each waits for the recipient's next dispatcher run, whose
 * own ask of the same reading drops it unless that says exactly false (T-1337).
 */
async function sendLines(
  set: OutageDeps,
  waiting: WaitingTurn,
  host: OutageHost | null,
  done: Set<string>,
  lines: OutageLineSent[],
): Promise<void> {
  const pending = waiting.texts.filter((text) => !text.lined && !done.has(text.eventId));
  if (pending.length === 0) return;
  // Never to a stopped number: a stop word among the turn's own texts; the actor's word that the number may have asked to
  // stop, which no commit has recorded yet (T-1323; when it holds the lines, the flag is not read); or the stopped flag.
  const stopped =
    waiting.stopAsked || actorSaysStopped(host) ? true : await stoppedNow(set, waiting.actorName);
  if (stopped === null) return;
  if (stopped) {
    for (const text of pending) done.add(text.eventId);
    return;
  }
  const rows: string[] = [];
  let held = false;
  for (const text of pending) {
    // Asked again right before this line: a STOP the actor took while the flag was read or an earlier line was out holds
    // this line and every later one of the try (RULES 7.2: "It stops texts from the number it answers, at once").
    if (actorSaysStopped(host)) {
      held = true;
      for (const other of pending) done.add(other.eventId);
      break;
    }
    let answer: unknown;
    try {
      answer = await set.lines.sendFixedLine(outageLineRequest(waiting, text));
    } catch {
      // The core is not answering: the line is asked for again on the next retry.
      continue;
    }
    const written = writtenOf(answer);
    if (written !== null) {
      done.add(text.eventId);
      lines.push({ eventId: text.eventId, outboxRowId: written.outboxRowId, repeated: written.repeated });
      // First or repeated (T-1341): a repeated answer, at a rerun of the turn, names a row whose first wake may have been
      // lost, so it is woken again; a second wake sends nothing twice (one claim, one key per part).
      if (written.outboxRowId !== null) rows.push(written.outboxRowId);
      continue;
    }
    const code = errorOf(answer);
    if (code === "phoneStopped") {
      // The number is stopped: none of the turn's texts gets the line.
      for (const other of pending) done.add(other.eventId);
      break;
    }
    // No such handle: nothing to send to. Anything else (transient, a bad answer): asked for again on the next retry.
    if (code === "notFound") done.add(text.eventId);
  }
  // The rows the try's lines named go to the dispatcher at once only while the actor still says no word waits (asked again
  // here, with nothing awaited before the wake, for a STOP taken while the try's last line was out: T-1341, DL-669). The
  // dispatcher asks the same reading right before each outage part goes and drops the row unless it says exactly false
  // (T-1337). After the actor's word no row is woken: a wake runs every sendable row of the recipient, and a routine row is
  // not asked (T-1342). Unwoken, they wait for the recipient's next dispatcher run, which asks the reading again, and limit
  // 8 drops them once the STOP commits (T-259); no sweep runs.
  if (rows.length > 0 && set.wake !== undefined && !held && !actorSaysStopped(host)) {
    try {
      await set.wake({ handleId: waiting.handleId, outboxRowIds: rows });
    } catch {
      // Not woken: the rows wait for the recipient's next dispatcher run (a commit or park wake, another outage or
      // safety-line wake, or the retry door), which asks the same reading; no sweep runs. The lines stand.
    }
  }
}

// ---- the retries ----------------------------------------------------------------------------------------------------

/**
 * True once the run is no longer the turn's: a restart replaced the turn, or its lapse started a rerun (the lease aborts
 * the run's signal). Read through a call, so it is read afresh after every wait.
 */
function replaced(lease: LeaseView): boolean {
  return lease.signal.aborted;
}

/** Resolves after `ms` on the clock, or at once when the run stops being the turn's. */
function waitOrStop(clock: OutageClock, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const stop = (): void => {
      resolve();
    };
    signal.addEventListener("abort", stop, { once: true });
    clock.after(ms).then(
      () => {
        signal.removeEventListener("abort", stop);
        resolve();
      },
      () => {
        signal.removeEventListener("abort", stop);
        resolve();
      },
    );
  });
}

/**
 * Runs a turn through the AI-down path inside its lease: `once` is one run of the turn (the turn loop's steps 1 to 7).
 * While a run ends with the models down and nothing committed, each waiting text gets the outage line once (never to a
 * stopped number) and the turn runs again 30 s after that try began, until it commits, ends for another reason, stops
 * being the turn's, or the next retry would not come before its lease lapses. Never throws for an outside failure.
 */
export async function runThroughOutage<T extends RunEnd>(
  lease: LeaseView,
  once: () => Promise<T>,
): Promise<OutageReport<T>> {
  const lines: OutageLineSent[] = [];
  const triedAt: number[] = [];
  const done = new Set<string>();
  const host = hosts.get(lease.signal) ?? null;
  const report = (outcome: T, end: OutageEnd): OutageReport<T> => ({
    outcome,
    tries: Math.max(1, triedAt.length),
    triedAt,
    lines,
    end,
  });
  for (;;) {
    const began = deps?.clock.now() ?? null;
    if (began !== null) triedAt.push(began);
    const outcome = await once();
    if (outcome.result === "committed") return report(outcome, "committed");
    const waiting = outcome.aiDown;
    if (waiting === undefined) return report(outcome, "notDown");
    const set = deps;
    if (set === null) return report(outcome, "unwired");
    if (replaced(lease)) return report(outcome, "replaced");
    await sendLines(set, waiting, host, done, lines);
    if (replaced(lease)) return report(outcome, "replaced");
    // The next try comes 30 s after this one began; the one the lease would not outlast is the lease's own rerun, at its
    // lapse, which comes then (a run starts with a 60 s lease: two tries).
    const next = (began ?? set.clock.now()) + RETRY_MS;
    if (next >= lease.leaseUntil) return report(outcome, "leaseEnds");
    await waitOrStop(set.clock, Math.max(0, next - set.clock.now()), lease.signal);
    if (replaced(lease)) return report(outcome, "replaced");
  }
}

// ---- the return order ---------------------------------------------------------------------------------------------

/**
 * The given items in the return order (arch 11 lines 564 and 566: "danger first, then stops, then the rest in order"; the
 * actor's write-on-return queue's ranks, RETURN_RANKS): each rank in turn, each item keeping its place within its rank.
 */
export function inReturnOrder<T>(items: readonly T[], rankOf: (item: T) => ReturnRank): T[] {
  return RETURN_RANKS.flatMap((rank) => items.filter((item) => rankOf(item) === rank));
}
