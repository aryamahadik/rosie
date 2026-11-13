// The outbox dispatcher (T-257, T-258; C-124; arch 02 step 8 'Send', line 125; arch 01 'Outbox row', line 65; RULES 4.1,
// 4.8).
//
// A run claims the sendable rows (K-05 v1.1 `claimOutbox`: each recipient's rows in commit order, a row held for text
// hours passed so later rows go), then sends each claimed row's parts through the Linq port, one recipient after
// another's rows but all recipients at once, and records each part: `markPart` sent on Linq's acceptance, failed on a
// reported failure. A delivery receipt (`handleDeliveryReceipt`) marks the part delivered and hands it to clock arming;
// a repeated receipt of the row's first delivery is handed on again (K-05 v1.9 item 48; T-1228), so an arming a crash
// lost is made by the provider's retry.
//
// What makes a part go exactly once, however many runs there are (K-05 v1.1 items 3, 13, 14):
//   1. `claimOutbox` takes each recipient under a lock keyed on the recipient's handle and moves the row to `sending`
//      with a claim that lapses 60 s later. A second run meets that lock and skips the recipient, or meets the live
//      claim and stops its walk at the row: it is never handed the same row.
//   2. A claim that lapses (a run that died or stalled) is claimed again by another run, which sends under the part's
//      stored key. The first run, if it comes back, calls `renewClaim` before each send; the call answers `claimLost`
//      once another run holds the claim, and the first run sends nothing more.
//   3. A send already in the air when its claim lapsed is the one case left: it goes under the same idempotency key
//      (`<row>/<part>/<try>`), and Linq answers a repeated key with the first message (K-11 'Repeating it'), so the
//      person gets one message. `markPart` sent for a part already sent says `repeated` and changes nothing.
//
// Limit 8 (T-259, limit8/limit8.ts) runs before each send, ahead of the claim's renewal: a row it holds, drops, makes
// stale or withdraws, or parks for a chat, is marked through K-05 `markRow` and nothing is sent; one it cannot read or
// mark sends nothing and keeps its claim. A held row, a waiting row and a finished one let the recipient's later rows go.
//
// An outage line's row (K-01 fixed line `outage` in its final parts: the AI-down path's line and the safety read's
// timeout line, each written through K-09 sendFixedLine) also asks the recipient's handle actor its one reading (T-1337;
// DL-656): whether the number may have asked to stop by a word no commit has recorded yet, which the stopped flag limit 8
// reads cannot show (a STOP stored behind its unread hold while the models are down). Asked once per part, after limit 8
// and the stopped flag's second read have let the part go, as the last await before the send: anything but exactly false
// (true, a throw, no answer within ACTOR_READING_MS, an answer that is not a boolean, no actor named, no port joined)
// sends nothing and drops the row as stopped, as the second read does (RULES 7.2: "Unsure: treat it as a stop"). No other
// row is asked: a safety line, a stop reply and a routine row go as limit 8 decides (RULES 4.12).
//
// Retries (T-258, retry/rules.ts): Linq's reported failure picks the part's next try under K-07's key rules. No answer:
// the same key. A reported failure: a new key, after any Retry-After. 4001 or 4006: a new key only if no receipt comes
// within the minute. 403 code 2024: never again on Linq, and a row the stop binds is dropped as stopped. A run that leaves
// a row waiting for its next try starts one job on the retry queue for it (retry/plan.ts, T-256), and the job's door
// (retry/door.ts) runs the recipient's rows again when it is due; the row holds the recipient's later rows back until
// then (commit order). override_optout goes only on a safety line or a stop reply (hard invariant: no routine text after
// STOP; arch 10 line 524).
//
// Not here: the second part waiting for the first's receipt (T-262), a refused part's plain form (C-127, C-128), a failed
// safety line's other ways and the row's end after 15 minutes of tries (C-126: T-273, T-1136's store calls), email
// (T-264).
//
// No words, number or key is logged: spans carry ids, counts and labels only (runtime/src/trace; K-08 v1).

import { OUTAGE_LINE_ID } from "../outage/ai/outage";
import { decideLimit8, isSafety, isSmsPort, isStopReply, type YesRefused } from "./limit8";
import { retryPlanOf, type RetryChain, type RetryScheduler, type RetryWhy } from "./retry/plan";
import {
  mayOverrideOptout,
  RETRY_SPACING_S,
  retryRuleFor,
  secondsAfter,
  secondsBetween,
  triesOver,
  waitSecondsFor,
  type RetryRule,
} from "./retry/rules";
import type { Outcome, SpanFields, TraceContext } from "../trace";
import type {
  CalendarFileBuilder,
  ChatTarget,
  ClaimedPart,
  ClaimedRow,
  ClockArming,
  LinqAccepted,
  LinqFailed,
  LinqPort,
  LinqSendRequest,
  MarkPartResponse,
  OutboxStore,
  PlannedSend,
  RecipientDirectory,
  SendStateReader,
  TransientError,
  Utc,
} from "./types";

type LimitResult = NonNullable<SpanFields["limits"]>[number];

/** How many times a transient store answer is repeated before the run leaves the row to its claim's lapse. */
const TRANSIENT_TRIES = 3;
/** The rows one claim takes at most (K-05 `claimOutbox.limit`, 1 to 100). */
const DEFAULT_LIMIT = 10;
/**
 * How long a run waits for the recipient actor's reading of an outage line's row (T-1337) before it counts the reading as
 * a stop: far below the claim's 60 s, which the renewal just before it started, so the send that follows still goes
 * within the claim with Linq's own time limit (K-07 default 2).
 */
export const ACTOR_READING_MS = 5_000;

export interface DispatchDeps {
  store: OutboxStore;
  linq: LinqPort;
  recipients: RecipientDirectory;
  /** Limit 8's read of the recipient's send state, made before each send (NQ-RT-2; K-05 v1.2 later). */
  sendState: SendStateReader;
  /**
   * The Worker's `ENVIRONMENT` var (wrangler.jsonc sets it: "staging" under env.staging, "production" elsewhere). The
   * staging test phone's text-hours override (BP 9.4) is honoured when it is exactly "staging", ignored otherwise.
   */
  environment: string;
  /** Builds a booking's calendar file; without it a words part that names a file goes without one (open question). */
  calendar?: CalendarFileBuilder;
  /** The trace of a claimed row: the row's `traceId` (one id from the webhook to the receipt) and the bundle in force. */
  traceFor(row: ClaimedRow): TraceContext;
  /** The clock, as a UTC string. */
  now(): Utc;
  /** This dispatcher instance's name, kept on every claim (K-05 `claimOutbox.claimer`). */
  claimer: string;
  limit?: number;
  /**
   * Where a row left waiting for its next try is put (T-258): the retry queue (`queueRetries` on the RETRY_QUEUE binding,
   * T-256), whose door (`dispatchSendDoor`) runs the recipient's rows again when the wait is over. Left out, the wait is
   * only reported, and the row waits for the next run that claims it.
   */
  retries?: RetryScheduler;
  /**
   * The recipient's handle actor's one reading (T-1337; DL-656; HandleActor.mayHaveStoppedNow), by the row's recipient K-04
   * id: whether the number may have asked to stop by a word no commit has recorded yet (its copy of the stopped flag, or a
   * text no commit has taken that may hold a stop word). Asked only for an outage line's row, once per part, as the last
   * await before the part's send; only an answer of exactly false lets the part go. The composition root always joins it
   * (../wiring/root.ts). Left out, every outage line's row is dropped at send, as for an actor that cannot be named.
   */
  mayHaveStopped?: (recipientHandleId: string) => Promise<boolean>;
  /** How long the actor's reading is waited for: ACTOR_READING_MS when left out (a test's shorter wait). */
  actorReadingMs?: number;
}

export interface DispatchOptions {
  /**
   * One recipient, from a wake (a commit, a park, an outage or safety line's writer: T-1341) or a retry job. Left out, it
   * means every recipient with sendable rows, a run no production code makes: no outbox sweep runs, and the Worker's cron
   * runs only the clock rows' sweep (runtime/src/index.ts).
   */
  recipientHandleId?: string;
}

/** How a claimed row's run ended. */
export type RowOutcome =
  /** Every part is accepted by Linq and recorded sent. */
  | "sent"
  /** Another run holds the claim now: this run sent nothing more for the row. */
  | "claimLost"
  /** The provider's Retry-After has not passed: the row waits for it on the retry queue. */
  | "retryAfter"
  /**
   * Linq reported a failure, or gave no answer: the part's next try waits on the retry queue under K-07's key rules
   * (`retry` says which), or, with no message id on an acceptance, the part is failed.
   */
  | "failed"
  /** 403 code 2024: never retried on Linq; a row the stop binds is dropped as stopped (the stop path). */
  | "optedOut"
  /** The part's latest try failed with no next try yet (a 4001 or 4006 within its minute): nothing is sent now. */
  | "awaitingRetry"
  /** No chat is known for the recipient: nothing was sent. */
  | "noChat"
  /** The store kept answering transient or an answer the run cannot use: the claim's lapse hands the row on. */
  | "storeError"
  /** The row's parts do not match its final parts: nothing was sent for the part. */
  | "badRow"
  /** An earlier row of the same recipient did not finish, so this one waits (commit order). */
  | "notReached"
  /** Limit 8 held the row for text hours (markRow held): later rows pass it. */
  | "held"
  /** Limit 8 dropped the row, its phone being stopped (its question takes the never-delivered path, T-255). */
  | "droppedStopped"
  /** Limit 8 found the row's read versions changed: its plan is cleared and it is composed again. */
  | "stale"
  /** Limit 8 found it stale and its booking or question closed: it is never sent. */
  | "withdrawn"
  /** Limit 8 found a phone, not stopped, with no open chat: no text, no clock, the row waits (MC C9). */
  | "waitingChat"
  /** A row by an SMS port: refused, nothing sent (DL-012); later rows pass it. */
  | "refusedSms"
  /** Limit 8 could not read the send state or its zone and hours: nothing was sent. */
  | "unreadable";

/** The outcomes after which the recipient's later rows still go: the row is held, waiting or finished. */
const LETS_LATER_PASS: ReadonlySet<RowOutcome> = new Set<RowOutcome>([
  "sent",
  "held",
  "waitingChat",
  "droppedStopped",
  "withdrawn",
  // A refused SMS-port row has no K-05 move (CQ-55 (1)), but it never holds back the recipient's later rows.
  "refusedSms",
  // A 2024 ends the row's tries on Linq: dropped as stopped, or a safety line left to its other ways (C-126).
  "optedOut",
]);

/** How a limit-8 outcome shows in the dispatch span (K-08 v1 outcomes). */
const LIMIT8_SPAN_OUTCOME: Partial<Record<RowOutcome, Outcome>> = {
  held: "held",
  waitingChat: "held",
  droppedStopped: "dropped",
  withdrawn: "dropped",
  stale: "refused",
  refusedSms: "refused",
  unreadable: "refused",
};

/** The retry job a run started for a row it left waiting (T-258). */
export interface RetryReport {
  why: RetryWhy;
  chain: RetryChain;
  /** The job's key on the retry queue: `retry-<part key>#<attempts>`. */
  jobKey: string;
  /** How long the next try waits, in seconds. */
  waitSeconds: number;
  /**
   * "queued", or why not: "noScheduler" (no retry queue joined), "triesOver" (15 minutes of tries have passed: K-07 rule
   * 5), "scheduleFailed", or the producer's error label (noQueue, queueFailed, badJob, badFailure, noTriesLeft).
   */
  scheduled: string;
}

export interface RowReport {
  outboxRowId: string;
  recipientHandleId: string;
  outcome: RowOutcome;
  /** The parts Linq accepted in this run. */
  partsSent: number;
  /** Set when the row waits for its next try (T-258). */
  retry?: RetryReport;
}

export interface DispatchReport {
  /** Set when the claim itself failed: nothing was claimed or sent. */
  claimError: TransientError["error"] | null;
  claimed: number;
  passedHeld: readonly { outboxRowId: string; heldUntil: Utc }[];
  rows: readonly RowReport[];
}

/** One run: claim, then send. Recipients go at once; one recipient's rows go one after another in commit order. */
export async function runDispatch(
  deps: DispatchDeps,
  options: DispatchOptions = {},
): Promise<DispatchReport> {
  const claim = await deps.store.claimOutbox({
    claimer: deps.claimer,
    ...(options.recipientHandleId === undefined ? {} : { recipientHandleId: options.recipientHandleId }),
    now: deps.now(),
    limit: deps.limit ?? DEFAULT_LIMIT,
  });
  if ("error" in claim) return { claimError: claim.error, claimed: 0, passedHeld: [], rows: [] };

  const byRecipient = new Map<string, ClaimedRow[]>();
  for (const row of claim.claimed) {
    const rows = byRecipient.get(row.recipientHandleId);
    if (rows === undefined) byRecipient.set(row.recipientHandleId, [row]);
    else rows.push(row);
  }
  const reports = await Promise.all([...byRecipient.values()].map((rows) => sendRecipient(deps, rows)));
  return {
    claimError: null,
    claimed: claim.claimed.length,
    passedHeld: claim.passedHeld,
    rows: reports.flat(),
  };
}

async function sendRecipient(deps: DispatchDeps, rows: readonly ClaimedRow[]): Promise<RowReport[]> {
  const reports: RowReport[] = [];
  let stopped = false;
  for (const row of rows) {
    if (stopped) {
      reports.push(report(row, "notReached", 0));
      continue;
    }
    const done = await sendRow(deps, row);
    const retry = done.wait === null ? null : await scheduleWait(deps, row, done.wait);
    reports.push(retry === null ? done.report : { ...done.report, retry });
    stopped = !LETS_LATER_PASS.has(done.report.outcome);
  }
  return reports;
}

const report = (row: ClaimedRow, outcome: RowOutcome, partsSent: number): RowReport => ({
  outboxRowId: row.outboxRowId,
  recipientHandleId: row.recipientHandleId,
  outcome,
  partsSent,
});

const isTransient = (answer: object): boolean => "error" in answer && answer.error === "transient";

/** Repeats a store call that answered transient (nothing was written: K-05), up to TRANSIENT_TRIES times. */
export async function untilNotTransient<T extends object>(
  call: () => Promise<T | TransientError>,
): Promise<T | TransientError> {
  let answer = await call();
  for (let tries = 1; tries < TRANSIENT_TRIES && isTransient(answer); tries += 1) {
    answer = await call();
  }
  return answer;
}

/** A wait a row is left in: the part it is for, the chain the door runs, and when the next try may go. */
interface Wait {
  part: ClaimedPart;
  why: RetryWhy;
  chain: RetryChain;
  code: string;
  at: Utc;
  waitSeconds: number;
  firstTryAt: Utc | null;
}

/** Starts the wait's retry job (T-256's producer), unless 15 minutes of tries have passed (K-07 rule 5). */
async function scheduleWait(deps: DispatchDeps, row: ClaimedRow, wait: Wait): Promise<RetryReport> {
  const plan = retryPlanOf({
    row,
    part: wait.part,
    chain: wait.chain,
    code: wait.code,
    at: wait.at,
    waitSeconds: wait.waitSeconds,
    firstTryAt: wait.firstTryAt,
  });
  const base = { why: wait.why, chain: wait.chain, jobKey: plan.job.key, waitSeconds: wait.waitSeconds };
  if (triesOver(wait.firstTryAt, wait.at)) return { ...base, scheduled: "triesOver" };
  if (deps.retries === undefined) return { ...base, scheduled: "noScheduler" };
  try {
    return { ...base, scheduled: await deps.retries.schedule(plan) };
  } catch {
    return { ...base, scheduled: "scheduleFailed" };
  }
}

/** What one row's run did: its report, and the wait it was left in, if any. */
interface RowDone {
  report: RowReport;
  wait: Wait | null;
}

async function sendRow(deps: DispatchDeps, row: ClaimedRow): Promise<RowDone> {
  const trace = deps.traceFor(row);
  const timer = trace.start("dispatch");
  let attempted: ClaimedPart | null = null;
  let partsSent = 0;
  let errorCode: string | null = null;
  /** The row's version as the store last said it (markPart answers raise it); a markRow compares it. */
  let version = row.version;
  let limit8: LimitResult | null = null;
  /** Why a stopped phone's newest texts yes did not lift the stop (T-1099): a label on the span. */
  let textsYes: YesRefused | null = null;
  /** What the recipient actor's reading of an outage line's row said (T-1337): a label on the span. */
  let actorReading: ActorReading | null = null;
  /** The claim as this run last knew it: its lapse bounds every wait, its first try starts the 15 minutes. */
  let lapsesAt: Utc = row.claim.lapsesAt;
  let firstTryAt: Utc | null = row.claim.firstTryAt;
  let wait: Wait | null = null;
  /** No answer from Linq shows as timedOut, not failed (K-08 v1 outcomes). */
  let timedOut = false;

  const leaveWaiting = (
    part: ClaimedPart,
    why: RetryWhy,
    chain: RetryChain,
    code: string,
    at: Utc,
    seconds: number,
  ) => {
    wait = { part, why, chain, code, at, waitSeconds: seconds, firstTryAt };
  };

  const end = (outcome: RowOutcome): RowDone => {
    const spanOutcome: Outcome =
      outcome === "sent"
        ? "ok"
        : attempted !== null
          ? timedOut
            ? "timedOut"
            : "failed"
          : (LIMIT8_SPAN_OUTCOME[outcome] ??
            (outcome === "retryAfter" || outcome === "awaitingRetry" ? "held" : "refused"));
    const waiting: Wait | null = wait;
    timer.finish({
      outcome: spanOutcome,
      ...(limit8 === null ? {} : { limits: [limit8] }),
      ...(attempted === null
        ? {}
        : { provider: "linq" as const, call: "sendPart", attempt: attempted.tryNo }),
      got: { parts: row.parts.length, partsSent },
      decided: {
        result: outcome,
        claimNo: row.claim.claimNo,
        ...(textsYes === null ? {} : { textsYes }),
        ...(actorReading === null ? {} : { actorReading }),
        ...(waiting === null ? {} : { retry: waiting.why, waitSeconds: waiting.waitSeconds }),
      },
      rows: [{ table: "outbox_rows", id: row.outboxRowId }],
      errorCode,
    });
    return { report: report(row, outcome, partsSent), wait: waiting };
  };

  const parts = [...row.parts].sort((a, b) => a.partNo - b.partNo);
  let chat: ChatTarget | null = null;
  for (const part of parts) {
    if (part.sent) continue;
    const send = row.finalParts.sends[part.partNo - 1];
    if (send === undefined) return end("badRow");

    // Limit 8, before each send and before the claim is renewed (a held row must not start the 15 minutes of tries).
    const gate = await checkLimit8(
      deps,
      row,
      version,
      parts.some((candidate) => candidate.sent) || partsSent > 0,
    );
    limit8 = gate.limit;
    if (!gate.go) {
      errorCode = gate.errorCode;
      textsYes = gate.yesRefused ?? null;
      return end(gate.outcome);
    }
    const { overrideOptout } = gate;

    chat ??= await deps.recipients.chatFor(row.recipientHandleId);
    if (chat === null) return end("noChat");

    // The claim is renewed just before each send (K-05 v1.1 item 14): a run whose claim another run took stops here.
    const renewed = await untilNotTransient(() =>
      deps.store.renewClaim({
        outboxRowId: row.outboxRowId,
        claimer: deps.claimer,
        claimNo: row.claim.claimNo,
        idempotencyKey: part.idempotencyKey,
        at: deps.now(),
      }),
    );
    if ("error" in renewed) {
      switch (renewed.error) {
        case "claimLost":
          return end("claimLost");
        case "notYet": {
          // The Retry-After a reported failure left on the claim (K-07 rule 6): the try waits for it, on the queue.
          const at = deps.now();
          const seconds = Math.max(1, secondsBetween(at, renewed.notBefore), secondsBetween(at, lapsesAt));
          leaveWaiting(part, "notYet", "rerun", "notYet", at, seconds);
          return end("retryAfter");
        }
        case "wrongState":
          if (renewed.state === "failed") {
            // The part's latest try failed and its next try is not written yet: a 4001 or 4006 within its minute, whose
            // own job writes it (K-07 rule 2), or a safety line Linq refused with 2024, whose other ways are C-126's. No
            // new key is ever made here, so none can come before the minute is out.
            const at = deps.now();
            const seconds = Math.max(RETRY_SPACING_S, secondsBetween(at, lapsesAt));
            leaveWaiting(part, "failedTry", "rerun", "failedTry", at, seconds);
            return end("awaitingRetry");
          }
          // The part is no longer pending: it was sent by the run that holds the claim, or is not this row's.
          continue;
        default:
          return end("storeError");
      }
    }
    lapsesAt = renewed.claim.lapsesAt;
    firstTryAt = renewed.claim.firstTryAt ?? firstTryAt;

    attempted = part;
    const request = await buildRequest(deps, row, part, send, chat, overrideOptout);

    // The stopped flag again, immediately before the send: a stop that committed during the chat lookup, the renewal or
    // the calendar build lets no part out. What is left is the read to Linq's acceptance (K-05 v1.2, T-072, folds it in).
    const recheck = await checkStoppedAgain(deps, row, version);
    if (!recheck.go) {
      errorCode = recheck.errorCode;
      limit8 = recheck.limit;
      return end(recheck.outcome);
    }
    // override_optout only on a safety line or a stop reply, whatever any read said (hard invariant: no routine text
    // after STOP; arch 10 line 524).
    const override = (request.overrideOptout || recheck.overrideOptout) && mayOverrideOptout(row);
    // An outage line's row: the recipient actor's one reading, the last await before the send (T-1337), since a STOP
    // stored behind its unread hold sets no stopped flag until it commits. Only exactly false lets the part go; anything
    // else drops the row as stopped, with nothing sent (RULES 7.2), as the second read above does.
    if (isOutageLine(row)) {
      actorReading = await readActor(deps, row);
      if (actorReading !== "notStopped") {
        // Nothing went to Linq for this part: the span shows the drop, not a send.
        attempted = null;
        limit8 = limit8Failed("droppedStopped");
        const dropped = await markDroppedStopped(deps, row, version);
        errorCode = dropped.errorCode;
        return end(dropped.outcome);
      }
    }
    const outcome = await deps.linq.sendPart(
      override === request.overrideOptout ? request : { ...request, overrideOptout: override },
    );

    if (outcome.result === "failed") {
      errorCode = failureCode(outcome);
      const rule = retryRuleFor(outcome, row);
      timedOut = rule.rule === "sameKey";
      const after = await afterFailure(deps, row, part, outcome, rule, version, lapsesAt);
      if (after.wait !== null) {
        leaveWaiting(part, after.wait.why, after.wait.chain, rule.code, after.wait.at, after.wait.seconds);
      }
      return end(after.outcome);
    }

    const marked = await recordSent(deps, part, outcome);
    if (marked === null) {
      errorCode = "noMessageId";
      await deps.store.markPart({
        outcome: "failed",
        idempotencyKey: part.idempotencyKey,
        errorCode,
        retry: false,
        at: deps.now(),
      });
      return end("failed");
    }
    if ("error" in marked) return end("storeError");

    version = marked.row?.version ?? version;
    partsSent += 1;
    trace.record({
      hop: "providerAccepted",
      ms: 0,
      at: outcome.acceptedAt,
      outcome: "ok",
      provider: "linq",
      rows: [{ table: "outbox_parts", id: part.idempotencyKey }],
    });
  }
  return end("sent");
}

interface AfterFailure {
  outcome: RowOutcome;
  wait: { why: RetryWhy; chain: RetryChain; at: Utc; seconds: number } | null;
}

/**
 * Carries out K-07's rule for Linq's reported failure of `part` (retry/rules.ts): the mark, the stop path for a 2024, and
 * the wait for the next try. A mark the store does not take leaves the part pending under its key, so the row goes again
 * after the claim lapses and Linq answers the same key the same way (K-11 'Repeating it').
 */
async function afterFailure(
  deps: DispatchDeps,
  row: ClaimedRow,
  part: ClaimedPart,
  failed: LinqFailed,
  rule: RetryRule,
  version: number,
  lapsesAt: Utc,
): Promise<AfterFailure> {
  const at = deps.now();
  const seconds = waitSecondsFor(rule, at, lapsesAt);
  const storeError = (): AfterFailure => ({
    outcome: "storeError",
    wait: {
      why: "storeError",
      chain: "rerun",
      at,
      seconds: Math.max(RETRY_SPACING_S, secondsBetween(at, lapsesAt)),
    },
  });
  const markFailed = (retry: boolean, nextTryNotBefore: Utc | null) =>
    untilNotTransient(() =>
      deps.store.markPart({
        outcome: "failed",
        idempotencyKey: part.idempotencyKey,
        errorCode: rule.code,
        retry,
        at,
        providerMessageId: failed.providerMessageId,
        ...(retry ? { nextTryNotBefore } : {}),
      }),
    );

  switch (rule.rule) {
    case "sameKey":
      // No answer: nothing is marked; the part stays pending under its key for the next claim (attempts + 1).
      return { outcome: "failed", wait: { why: "sameKey", chain: "rerun", at, seconds } };

    case "newKey": {
      const notBefore = rule.retryAfterSeconds === null ? null : secondsAfter(at, rule.retryAfterSeconds);
      const marked = await markFailed(true, notBefore);
      if ("error" in marked || marked.nextKey === null) return storeError();
      return { outcome: "failed", wait: { why: "newKey", chain: "rerun", at, seconds } };
    }

    case "awaitReceipt": {
      const marked = await markFailed(false, null);
      if ("error" in marked) return storeError();
      return { outcome: "failed", wait: { why: "awaitReceipt", chain: "awaitReceipt", at, seconds } };
    }

    case "optedOut": {
      const marked = await markFailed(false, null);
      if ("error" in marked) return storeError();
      if (!rule.dropRow) return { outcome: "optedOut", wait: null };
      // The row's version as the failure's mark left it, which the drop compares (K-05 v1.1 item 15's `row`).
      const after = marked.row?.version ?? version;
      // The stop path: dropped as stopped, as limit 8 drops a row to a stopped phone (its question takes the
      // never-delivered path, T-255). Linq's block means an exact STOP came; Rosie's own flag follows when it lands.
      const dropped = await untilNotTransient(() =>
        deps.store.markRow({
          outboxRowId: row.outboxRowId,
          expectVersion: after,
          outcome: "droppedStopped",
          heldUntil: null,
          at,
        }),
      );
      if ("error" in dropped) return { outcome: "storeError", wait: null };
      return { outcome: "optedOut", wait: null };
    }
  }
}

type Limit8Gate =
  | { go: true; overrideOptout: boolean; limit: LimitResult }
  | {
      go: false;
      outcome: RowOutcome;
      errorCode: string | null;
      limit: LimitResult | null;
      /** Set when a stopped phone's newest texts row was a yes that did not lift the stop (T-1099). */
      yesRefused?: YesRefused;
    };

const limit8Failed = (outcome: string): LimitResult => ({ limit: 8, result: "fail", outcome });

/**
 * Limit 8 for one send (T-259): reads the recipient's send state, decides (limit8/limit8.ts) and carries a mark out.
 * Anything it cannot read or mark sends nothing: the row keeps its claim and the claim's lapse hands it on.
 */
async function checkLimit8(
  deps: DispatchDeps,
  row: ClaimedRow,
  version: number,
  partOut: boolean,
): Promise<Limit8Gate> {
  // No SMS provider exists (DL-012): refused before anything is read, with no K-05 move to record it (open question).
  if (isSmsPort(row)) {
    return { go: false, outcome: "refusedSms", errorCode: "smsRefused", limit: limit8Failed("refusedSms") };
  }
  const state = await untilNotTransient(() => deps.sendState.sendStateFor(row));
  if ("error" in state) {
    return { go: false, outcome: "storeError", errorCode: "sendStateUnavailable", limit: null };
  }

  const decision = decideLimit8({
    row,
    state,
    now: deps.now(),
    honourOverride: deps.environment === "staging",
    partOut,
  });
  switch (decision.action) {
    case "send":
      return {
        go: true,
        overrideOptout: decision.overrideOptout,
        limit: { limit: 8, result: "pass", outcome: null },
      };
    case "refuseSms":
      return { go: false, outcome: "refusedSms", errorCode: "smsRefused", limit: limit8Failed("refusedSms") };
    case "unreadable":
      return {
        go: false,
        outcome: "unreadable",
        errorCode: "sendStateInvalid",
        limit: limit8Failed("unreadable"),
      };
    case "mark": {
      const marked = await untilNotTransient(() =>
        deps.store.markRow({
          outboxRowId: row.outboxRowId,
          expectVersion: version,
          outcome: decision.outcome,
          heldUntil: decision.heldUntil,
          at: deps.now(),
        }),
      );
      const limit = limit8Failed(decision.outcome);
      const refused = decision.yesRefused === undefined ? {} : { yesRefused: decision.yesRefused };
      if ("error" in marked) {
        return { go: false, outcome: "storeError", errorCode: marked.error, limit, ...refused };
      }
      return { go: false, outcome: decision.outcome, errorCode: null, limit, ...refused };
    }
  }
}

type StoppedRecheck =
  | { go: true; overrideOptout: boolean }
  | { go: false; outcome: RowOutcome; errorCode: string | null; limit: LimitResult | null };

/**
 * Reads the stopped flag once more just before a send. Stopped: only a safety line and a stop reply still go (with the
 * opt-out override); any other row is dropped as limit 8 drops it. A read that stays transient sends nothing.
 *
 * No texts yes counts here (T-1099): a row the person's own yes lifted past limit 8 waits for the chat, since a stopped
 * phone's chat is closed (K-04 phones_stop_closes_chat), so with the flag set it never reaches this read but by a part
 * already out; should one reach it, it is dropped, which fails closed.
 */
async function checkStoppedAgain(
  deps: DispatchDeps,
  row: ClaimedRow,
  version: number,
): Promise<StoppedRecheck> {
  const state = await untilNotTransient(() => deps.sendState.sendStateFor(row));
  if ("error" in state)
    return { go: false, outcome: "storeError", errorCode: "sendStateUnavailable", limit: null };
  if (!state.stopped) return { go: true, overrideOptout: false };
  if (isSafety(row) || isStopReply(row)) return { go: true, overrideOptout: true };

  const dropped = await markDroppedStopped(deps, row, version);
  return { go: false, ...dropped, limit: limit8Failed("droppedStopped") };
}

/**
 * Drops the row as stopped (K-05 markRow droppedStopped, compared on the run's version): its question takes the
 * never-delivered path (T-255), and the recipient's later rows go. A mark the store does not take is storeError: nothing
 * is sent, and the claim's lapse hands the row on.
 */
async function markDroppedStopped(
  deps: DispatchDeps,
  row: ClaimedRow,
  version: number,
): Promise<{ outcome: RowOutcome; errorCode: string | null }> {
  const marked = await untilNotTransient(() =>
    deps.store.markRow({
      outboxRowId: row.outboxRowId,
      expectVersion: version,
      outcome: "droppedStopped",
      heldUntil: null,
      at: deps.now(),
    }),
  );
  if ("error" in marked) return { outcome: "storeError", errorCode: marked.error };
  return { outcome: "droppedStopped", errorCode: null };
}

/**
 * True for a row that carries K-01's outage line (`outage` among its final parts' fixed lines; K-03 v1 finalParts
 * .fixedLines, which the writer of a fixed line's row names: K-05 README item 38, K-09 README default 139): the AI-down
 * path's line and the safety read's timeout line, both sent through K-09 sendFixedLine. Read as limit 8 reads a stop
 * reply (limit8.ts isStopReply).
 */
export const isOutageLine = (row: ClaimedRow): boolean => row.finalParts.fixedLines.includes(OUTAGE_LINE_ID);

/**
 * What the recipient actor's reading said for an outage line's row (T-1337), a label for the span: notStopped (exactly
 * false: the part goes) or why it counts as a stop: stopped (true), notBoolean, threw (a throw or a rejected call, an actor
 * that cannot be named or reached among them), noAnswer (none within the wait), noPort (none joined).
 */
export type ActorReading = "notStopped" | "stopped" | "notBoolean" | "threw" | "noAnswer" | "noPort";

/** The mark a reading that never came leaves: a value no actor can answer. */
const NO_ANSWER = Symbol("noAnswer");

/**
 * Asks the recipient's handle actor its one reading for this row (DispatchDeps.mayHaveStopped), within the wait: only an
 * answer of exactly false reads notStopped. Never throws.
 */
async function readActor(deps: DispatchDeps, row: ClaimedRow): Promise<ActorReading> {
  const ask = deps.mayHaveStopped;
  if (ask === undefined) return "noPort";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof NO_ANSWER>((resolve) => {
    timer = setTimeout(() => {
      resolve(NO_ANSWER);
    }, deps.actorReadingMs ?? ACTOR_READING_MS);
  });
  try {
    const answer: unknown = await Promise.race([
      Promise.resolve().then(() => ask(row.recipientHandleId)),
      late,
    ]);
    if (answer === NO_ANSWER) return "noAnswer";
    if (answer === false) return "notStopped";
    return answer === true ? "stopped" : "notBoolean";
  } catch {
    return "threw";
  } finally {
    clearTimeout(timer);
  }
}

/** What Linq's failure is recorded as: its code, else its kind (K-04 `outbox_parts.error_code`, a label). */
const failureCode = (failed: LinqFailed): string => failed.code ?? failed.kind;

/** `markPart` sent for an accepted part; null when Linq named no message id, which a text, poll or card always has. */
async function recordSent(
  deps: DispatchDeps,
  part: ClaimedPart,
  accepted: LinqAccepted,
): Promise<MarkPartResponse | ReturnType<typeof storeFailure> | null> {
  if (accepted.providerMessageId === null) return null;
  const providerMessageId = accepted.providerMessageId;
  const answer = await untilNotTransient(() =>
    deps.store.markPart({
      outcome: "sent",
      idempotencyKey: part.idempotencyKey,
      providerMessageId,
      providerOptionIds: accepted.providerOptionIds,
      at: accepted.acceptedAt,
    }),
  );
  return "error" in answer ? storeFailure(answer.error) : answer;
}

const storeFailure = (error: string): { error: string } => ({ error });

async function buildRequest(
  deps: DispatchDeps,
  row: ClaimedRow,
  part: ClaimedPart,
  send: PlannedSend,
  chat: ChatTarget,
  overrideOptout: boolean,
): Promise<LinqSendRequest> {
  // A file and a thread reach iMessage only: a chat Linq reports as SMS or RCS gets words alone (DL-031; arch 07 line 383).
  const iMessage = chat.service === "imessage";
  const calendarFile =
    send.kind === "words" && send.calendarFile !== "none" && iMessage && deps.calendar !== undefined
      ? await deps.calendar.build(row, send.calendarFile)
      : null;
  const thread = row.finalParts.threadReplyTo;
  return {
    idempotencyKey: part.idempotencyKey,
    to: chat.to,
    chatId: chat.chatId,
    service: chat.service,
    kind: send.kind === "tapback" ? "words" : send.kind,
    text: send.kind === "words" ? send.text : null,
    calendarFile,
    options: send.kind === "poll" ? send.options : [],
    link: send.kind === "linkCard" ? send.link : null,
    photo: null,
    tapback: null,
    threadedReplyTo: send.kind === "words" && iMessage && thread !== null ? { messageId: thread } : null,
    typing: null,
    overrideOptout,
  };
}

/** A delivery receipt as the gateway hands it on (C-044): the K-06 event's status and, beside it, the echoed key. */
export interface DeliveryReceipt {
  /** Linq's message id (K-06 `status.messageId`). */
  providerMessageId: string;
  /** The part key the receipt echoes (K-11 `partKey`), or null. */
  partKey: string | null;
  /** When the receipt says it was delivered (K-06 `status.at`). */
  at: Utc;
}

export interface ReceiptDeps {
  store: OutboxStore;
  clockArming: ClockArming;
  /** The receipt's own trace (the gateway opened it; the id the row carries is the same id end to end). */
  trace: TraceContext;
}

export type ReceiptResult =
  /** The part is marked delivered and handed to clock arming. */
  | { result: "delivered"; outboxRowId: string; partNo: 1 | 2; firstDelivery: boolean }
  /**
   * A receipt for a part already delivered: nothing was written. A repeat of the row's first delivery was handed to
   * clock arming again (K-05 v1.9 item 48), which arms a clock once; any other repeat was handed to no one.
   */
  | { result: "repeated"; outboxRowId: string; partNo: 1 | 2 }
  /**
   * No part holds this message id, and none under the echoed key is waiting for it (no key echoed, no part under it, or
   * a part that holds another message id: K-05 v1.2 item 31).
   */
  | { result: "unmatched"; partKey: string | null }
  /** The store kept answering transient or wrongState: the receipt is not lost (Linq sends it again). */
  | { result: "storeError" };

/**
 * The stored time of the row's first delivery when `answer` is a repeat of it (K-05 v1.9 item 48): `repeated`, with
 * `repeatedDelivery.firstOfRow` true. Null for every other answer: a mark that records a delivery, a repeat of a later
 * part's delivery, `repeatedDelivery` null, an answer without it (v1 to v1.8) and one whose field cannot be read. A
 * missing field is never read as a first delivery (default 89), and the time is never the receipt's own (default 86).
 */
function repeatedFirstDeliveryAt(answer: MarkPartResponse): Utc | null {
  if (!answer.repeated) return null;
  const repeats: unknown = answer.repeatedDelivery;
  if (typeof repeats !== "object" || repeats === null) return null;
  const { firstOfRow, deliveredAt } = repeats as { firstOfRow?: unknown; deliveredAt?: unknown };
  return firstOfRow === true && typeof deliveredAt === "string" ? deliveredAt : null;
}

/**
 * Marks a part delivered and hands it to clock arming (arch 02 line 127). The part is found by Linq's message id,
 * else by the key the receipt echoes when the part holds no message id (K-05 v1.2 item 31): a part that failed with 4001
 * or 4006 named none, and its receipt within the minute moves it to delivered, so no new key goes (K-07 rule 2; K-11
 * verify-delivered-after-4006.json).
 *
 * A repeated receipt writes nothing. One that repeats the row's first delivery (K-05 v1.9 item 48) is handed to clock
 * arming again, as a first delivery at the stored time, named by the answer's row, part, try and question: a crash
 * between markPart's commit and the arming left the clock unarmed and Linq unanswered, so Linq's retry is the arming's
 * second chance (STATE note 38). The arming is safe to repeat (K-05 armClock), so a clock already armed stays armed
 * once. Any other repeat is handed to no one.
 *
 * A store call that throws (markPart cannot read what a repeat repeats) and an arming that throws both reject here,
 * with nothing handed on after the throw: the caller answers Linq 503 and Linq sends the receipt again.
 */
export async function handleDeliveryReceipt(
  deps: ReceiptDeps,
  receipt: DeliveryReceipt,
): Promise<ReceiptResult> {
  const timer = deps.trace.start("delivered");
  const answer = await untilNotTransient(() =>
    deps.store.markPart({
      outcome: "delivered",
      providerMessageId: receipt.providerMessageId,
      at: receipt.at,
      ...(receipt.partKey === null ? {} : { idempotencyKey: receipt.partKey }),
    }),
  );

  if ("error" in answer) {
    const unmatched = answer.error === "notFound";
    timer.finish({
      outcome: unmatched ? "dropped" : "failed",
      provider: "linq",
      decided: { result: unmatched ? "unmatched" : "storeError" },
      errorCode: unmatched ? null : answer.error,
    });
    return unmatched ? { result: "unmatched", partKey: receipt.partKey } : { result: "storeError" };
  }

  const repeatedFirstAt = repeatedFirstDeliveryAt(answer);
  timer.finish({
    outcome: "ok",
    provider: "linq",
    got: {
      firstDelivery: answer.firstDelivery,
      repeated: answer.repeated,
      // A label only, set when the repeat is handed on: the stored time stays out of the span.
      ...(repeatedFirstAt === null ? {} : { firstOfRow: true }),
    },
    rows: [{ table: "outbox_rows", id: answer.outboxRowId }],
  });
  if (answer.repeated) {
    if (repeatedFirstAt !== null) {
      await deps.clockArming.partDelivered({
        outboxRowId: answer.outboxRowId,
        partNo: answer.partNo,
        tryNo: answer.tryNo,
        firstDelivery: true,
        openQuestionId: answer.openQuestionId,
        deliveredAt: repeatedFirstAt,
      });
    }
    return { result: "repeated", outboxRowId: answer.outboxRowId, partNo: answer.partNo };
  }

  await deps.clockArming.partDelivered({
    outboxRowId: answer.outboxRowId,
    partNo: answer.partNo,
    tryNo: answer.tryNo,
    firstDelivery: answer.firstDelivery,
    openQuestionId: answer.openQuestionId,
    deliveredAt: receipt.at,
  });
  return {
    result: "delivered",
    outboxRowId: answer.outboxRowId,
    partNo: answer.partNo,
    firstDelivery: answer.firstDelivery,
  };
}
