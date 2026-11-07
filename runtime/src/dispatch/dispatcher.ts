// The outbox dispatcher (T-257; C-124; arch 02 step 8 'Send', line 125; arch 01 'Outbox row', line 65; RULES 4.1, 4.8).
//
// A run claims the sendable rows (K-05 v1.1 `claimOutbox`: each recipient's rows in commit order, a row held for text
// hours passed so later rows go), then sends each claimed row's parts through the Linq port, one recipient after
// another's rows but all recipients at once, and records each part: `markPart` sent on Linq's acceptance, failed on a
// reported failure. A delivery receipt (`handleDeliveryReceipt`) marks the part delivered and hands it to clock arming.
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
// Not here: retry keys and the Linq error kinds (T-258: a reported failure is only recorded, with
// `retry` false, and its row's recipient stops), the second part waiting for the first's receipt (T-262), email (T-264).
//
// No words, number or key is logged: spans carry ids, counts and labels only (runtime/src/trace; K-08 v1).

import { decideLimit8 } from "./limit8";
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
}

export interface DispatchOptions {
  /** One recipient (the actor's own after a commit); left out: every recipient with sendable rows (the sweep). */
  recipientHandleId?: string;
}

/** How a claimed row's run ended. */
export type RowOutcome =
  /** Every part is accepted by Linq and recorded sent. */
  | "sent"
  /** Another run holds the claim now: this run sent nothing more for the row. */
  | "claimLost"
  /** The provider's Retry-After has not passed: the row waits for its claim to lapse. */
  | "retryAfter"
  /** Linq reported a failure, recorded for T-258's retry rules. */
  | "failed"
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
  /** Limit 8 found a customer mobile with no open chat: no text, no clock, the row waits. */
  | "waitingChat"
  /** An SMS channel: refused, nothing sent (DL-012). */
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

export interface RowReport {
  outboxRowId: string;
  recipientHandleId: string;
  outcome: RowOutcome;
  /** The parts Linq accepted in this run. */
  partsSent: number;
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
    reports.push(done);
    stopped = !LETS_LATER_PASS.has(done.outcome);
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
async function untilNotTransient<T extends object>(
  call: () => Promise<T | TransientError>,
): Promise<T | TransientError> {
  let answer = await call();
  for (let tries = 1; tries < TRANSIENT_TRIES && isTransient(answer); tries += 1) {
    answer = await call();
  }
  return answer;
}

async function sendRow(deps: DispatchDeps, row: ClaimedRow): Promise<RowReport> {
  const trace = deps.traceFor(row);
  const timer = trace.start("dispatch");
  let attempted: ClaimedPart | null = null;
  let partsSent = 0;
  let errorCode: string | null = null;
  /** The row's version as the store last said it (markPart answers raise it); a markRow compares it. */
  let version = row.version;
  let limit8: LimitResult | null = null;

  const end = (outcome: RowOutcome): RowReport => {
    const spanOutcome: Outcome =
      outcome === "sent"
        ? "ok"
        : attempted !== null
          ? "failed"
          : (LIMIT8_SPAN_OUTCOME[outcome] ?? (outcome === "retryAfter" ? "held" : "refused"));
    timer.finish({
      outcome: spanOutcome,
      ...(limit8 === null ? {} : { limits: [limit8] }),
      ...(attempted === null
        ? {}
        : { provider: "linq" as const, call: "sendPart", attempt: attempted.tryNo }),
      got: { parts: row.parts.length, partsSent },
      decided: { result: outcome, claimNo: row.claim.claimNo },
      rows: [{ table: "outbox_rows", id: row.outboxRowId }],
      errorCode,
    });
    return report(row, outcome, partsSent);
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
        case "notYet":
          return end("retryAfter");
        case "wrongState":
          // The part is no longer pending: it was sent by the run that holds the claim, or is not this row's.
          continue;
        default:
          return end("storeError");
      }
    }

    attempted = part;
    const request = await buildRequest(deps, row, part, send, chat, overrideOptout);
    const outcome = await deps.linq.sendPart(request);

    if (outcome.result === "failed") {
      errorCode = failureCode(outcome);
      await deps.store.markPart({
        outcome: "failed",
        idempotencyKey: part.idempotencyKey,
        errorCode,
        retry: false,
        at: deps.now(),
        providerMessageId: outcome.providerMessageId,
      });
      return end("failed");
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

type Limit8Gate =
  | { go: true; overrideOptout: boolean; limit: LimitResult }
  | { go: false; outcome: RowOutcome; errorCode: string | null; limit: LimitResult | null };

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
  if (row.channel === "sms") {
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
      if ("error" in marked) return { go: false, outcome: "storeError", errorCode: marked.error, limit };
      return { go: false, outcome: decision.outcome, errorCode: null, limit };
    }
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
  /** A receipt for a part already delivered: nothing changed, nothing was handed on. */
  | { result: "repeated"; outboxRowId: string; partNo: 1 | 2 }
  /**
   * No part holds this message id. When the receipt echoes a key, the part may have failed with 4001 or 4006 and so
   * hold no message id (K-11 README 'A late receipt after 4001 or 4006'); K-05 v1.1 has no `markPart` by key, so the
   * match waits for T-258 and a K-05 minor version (open question).
   */
  | { result: "unmatched"; partKey: string | null }
  /** The store kept answering transient or wrongState: the receipt is not lost (Linq sends it again). */
  | { result: "storeError" };

/** Marks a part delivered by its message id and hands it to clock arming once (arch 02 line 127). */
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

  timer.finish({
    outcome: "ok",
    provider: "linq",
    got: { firstDelivery: answer.firstDelivery, repeated: answer.repeated },
    rows: [{ table: "outbox_rows", id: answer.outboxRowId }],
  });
  if (answer.repeated) return { result: "repeated", outboxRowId: answer.outboxRowId, partNo: answer.partNo };

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
