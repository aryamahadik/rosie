// Fakes for the dispatcher's tests (T-257; BP 5.2: tests use fakes, never an outside service). Used only by the
// *.test.ts files beside it; never imported by the Worker.
//
// `FakeOutboxStore` answers the K-05 v1.1 calls the dispatcher makes as the frozen fixtures state, kept in memory:
//   claimOutbox       claim-in-order.json (each recipient's rows in commit order, the claim moves the row to sending,
//                     version + 1), claim-held-lets-later-pass.json (a held row is passed and listed in passedHeld),
//                     claim-lapsed-reclaimed.json (a sending row whose claim lapsed is claimed again: claimNo + 1,
//                     firstTryAt kept, the unsent part under its stored key with attempts + 1). A recipient whose lock
//                     another claim holds is skipped (item 3: pg_try_advisory_xact_lock), and a sending row with a live
//                     claim stops the walk (item 13).
//   renewClaim        renew-claim-first-send.json (lapsesAt = at + 60 s, firstTryAt set once), renew-claim-lost.json
//                     (another claim holds the row: claimLost), renew-claim-not-yet.json (a Retry-After still holds).
//   markPart          mark-sent.json, mark-delivered.json (found by Linq's message id, firstDelivery on the row's
//                     first receipt, a second receipt says repeated), mark-failed-retry-after.json's failed mark
//                     without a retry; a row moves to sent when every part is accepted and to delivered when every
//                     part is delivered (item 15).
// `FakeLinq` answers `sendPart` as send-text.json, send-poll.json and send-link-card.json state (accepted, with a message
// id, and option ids for a poll) and, like Linq, answers a repeated idempotency key with the first message (K-11).

import { openTrace, type Span, type TraceContext } from "../trace";
import type {
  ChatTarget,
  ClaimedRow,
  ClaimOutboxRequest,
  ClaimOutboxResponse,
  ClockArming,
  LinqAccepted,
  LinqFailed,
  LinqPort,
  LinqSendRequest,
  MarkPartRequest,
  MarkPartResponse,
  NotFoundError,
  NotYetError,
  OutboxClaim,
  OutboxStore,
  PartDelivered,
  PlannedSend,
  RecipientDirectory,
  RenewClaimRequest,
  RenewClaimResponse,
  TransientError,
  Utc,
  WrongStateError,
  ClaimLostError,
  MarkRowRequest,
  MarkRowResponse,
  SendState,
  SendStateReader,
  VersionChangedError,
  VersionRef,
} from "./types";

const CLAIM_MS = 60_000;

const addMs = (at: Utc, ms: number): Utc => new Date(Date.parse(at) + ms).toISOString();
const after = (a: Utc, b: Utc): boolean => Date.parse(a) > Date.parse(b);
/** Lets other runs go: a point where a real call would wait for the database or the network. */
export const yieldToOthers = async (turns = 3): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
};

/** A clock the test moves. */
export class FakeClock {
  private ms: number;
  constructor(start: Utc = "2026-11-07T15:06:35.000Z") {
    this.ms = Date.parse(start);
  }
  readonly now = (): Utc => new Date(this.ms).toISOString();
  advance(ms: number): void {
    this.ms += ms;
  }
}

export interface SeedRow {
  id: string;
  recipient: string;
  commitSeq: number;
  sends: readonly PlannedSend[];
  heldUntil?: Utc;
  sendClass?: string;
  openQuestionId?: string | null;
  /** A Retry-After an earlier failure left on the row's claim (K-07 rule 6); kept at the first claim here. */
  nextTryNotBefore?: Utc;
  channel?: string;
  port?: string;
  bookingId?: string | null;
  versionsRead?: readonly VersionRef[];
  fixedLines?: readonly string[];
}

type PartState = "pending" | "sent" | "failed" | "delivered";
interface FakePart {
  partNo: 1 | 2;
  tryNo: number;
  key: string;
  attempts: number;
  state: PartState;
  messageId: string | null;
  deliveredAt: Utc | null;
}
type RowState =
  | "checked"
  | "held"
  | "sending"
  | "sent"
  | "delivered"
  | "failed"
  | "dropped_stopped"
  | "stale"
  | "withdrawn"
  | "waiting_chat";
interface FakeRow {
  seed: SeedRow;
  /** The words as they stand: the seed's, or the new ones after a recomposition. */
  sends: readonly PlannedSend[];
  versionsRead: readonly VersionRef[];
  state: RowState;
  version: number;
  heldUntil: Utc | null;
  claim: OutboxClaim | null;
  parts: FakePart[];
}

export class FakeOutboxStore implements OutboxStore {
  readonly rows = new Map<string, FakeRow>();
  /** Every markPart request, in the order made. */
  readonly marks: MarkPartRequest[] = [];
  /** Every renewClaim request and its answer's kind, in the order made. */
  readonly renewals: { request: RenewClaimRequest; answer: string }[] = [];
  /** Recipients whose claim lock is held right now (an advisory transaction lock). */
  private readonly locks = new Set<string>();
  /** Answers the next claimOutbox with this error instead (a lost connection). */
  failNextClaim: TransientError | null = null;

  constructor(seeds: readonly SeedRow[]) {
    for (const seed of seeds) {
      this.rows.set(seed.id, {
        seed,
        sends: seed.sends,
        versionsRead: seed.versionsRead ?? [],
        state: seed.heldUntil === undefined ? "checked" : "held",
        version: 3,
        heldUntil: seed.heldUntil ?? null,
        claim: null,
        parts: [],
      });
    }
  }

  row(id: string): FakeRow {
    const row = this.rows.get(id);
    if (row === undefined) throw new Error(`no row ${id}`);
    return row;
  }

  async claimOutbox(request: ClaimOutboxRequest): Promise<ClaimOutboxResponse | TransientError> {
    if (this.failNextClaim !== null) {
      const error = this.failNextClaim;
      this.failNextClaim = null;
      return error;
    }
    const claimed: ClaimedRow[] = [];
    const passedHeld: { outboxRowId: string; heldUntil: Utc }[] = [];
    // Finished rows are skipped, a waiting_chat row is passed (K-05 v1.1 item 13), and a stale row (no final parts)
    // stops its recipient's walk as a row with a live claim does.
    const open = [...this.rows.values()].filter(
      (row) =>
        !["sent", "delivered", "failed", "dropped_stopped", "withdrawn", "waiting_chat"].includes(row.state),
    );
    const recipients = [...new Set(open.map((row) => row.seed.recipient))]
      .filter(
        (recipient) => request.recipientHandleId === undefined || recipient === request.recipientHandleId,
      )
      .sort(
        (a, b) =>
          Math.min(...open.filter((r) => r.seed.recipient === a).map((r) => r.seed.commitSeq)) -
          Math.min(...open.filter((r) => r.seed.recipient === b).map((r) => r.seed.commitSeq)),
      );

    for (const recipient of recipients) {
      if (this.locks.has(recipient)) continue; // another claim holds this recipient: skipped
      this.locks.add(recipient);
      try {
        await yieldToOthers(); // the transaction is open: a second claim meets the lock
        const walk = open
          .filter((row) => row.seed.recipient === recipient)
          .sort((a, b) => a.seed.commitSeq - b.seed.commitSeq);
        for (const row of walk) {
          if (claimed.length >= request.limit) break;
          if (row.state === "held" && row.heldUntil !== null && after(row.heldUntil, request.now)) {
            passedHeld.push({ outboxRowId: row.seed.id, heldUntil: row.heldUntil });
            continue;
          }
          if (row.state === "stale") break;
          if (row.state === "sending" && row.claim !== null && after(row.claim.lapsesAt, request.now)) break;
          claimed.push(this.take(row, request));
        }
      } finally {
        this.locks.delete(recipient);
      }
    }
    return { result: "claimed", claimed, passedHeld };
  }

  private take(row: FakeRow, request: ClaimOutboxRequest): ClaimedRow {
    const claimedFrom = row.state === "sending" ? "sending" : row.state === "held" ? "held" : "checked";
    const old = row.claim;
    row.claim = {
      claimer: request.claimer,
      claimedAt: request.now,
      lapsesAt: addMs(request.now, CLAIM_MS),
      claimNo: old === null ? 1 : old.claimNo + 1,
      firstTryAt: old?.firstTryAt ?? null,
      nextTryNotBefore: old?.nextTryNotBefore ?? row.seed.nextTryNotBefore ?? null,
    };
    row.state = "sending";
    row.heldUntil = null;
    row.version += 1;
    if (row.parts.length === 0) {
      row.parts = row.sends.map((_, index) => {
        const partNo = (index + 1) as 1 | 2;
        return {
          partNo,
          tryNo: 1,
          key: `${row.seed.id}/${String(partNo)}/1`,
          attempts: 1,
          state: "pending",
          messageId: null,
          deliveredAt: null,
        };
      });
    } else {
      for (const part of row.parts) if (part.state === "pending") part.attempts += 1;
    }
    return {
      outboxRowId: row.seed.id,
      version: row.version,
      commitSeq: row.seed.commitSeq,
      recipientHandleId: row.seed.recipient,
      recipientPersonId: null,
      businessId: null,
      bookingId: row.seed.bookingId ?? null,
      openQuestionId: row.seed.openQuestionId ?? null,
      channel: row.seed.channel ?? "imessage",
      ...(row.seed.port === undefined ? {} : { port: row.seed.port }),
      sendClass: row.seed.sendClass ?? "routine",
      versionsRead: row.versionsRead,
      finalParts: {
        row: row.seed.id,
        channel: row.seed.channel ?? "imessage",
        sends: row.sends,
        fixedLines: row.seed.fixedLines ?? [],
        threadReplyTo: null,
      },
      parts: row.parts.map((part) => ({
        partNo: part.partNo,
        tryNo: part.tryNo,
        idempotencyKey: part.key,
        attempts: part.attempts,
        sent: part.state === "sent" || part.state === "delivered",
      })),
      traceId: `trace-${row.seed.id}`,
      claim: row.claim,
      claimedFrom,
    };
  }

  /** Every markRow request and its answer's kind, in the order made. */
  readonly rowMarks: { request: MarkRowRequest; answer: string }[] = [];

  /**
   * markRow as mark-held-for-text-hours.json and mark-waiting-chat.json state, and as K-07's moves allow: only a
   * `sending` row moves (mark-row-wrong-state.json), compare-and-set on the version (a repeat gets versionChanged), the
   * version rises by one. held keeps the claim and sets held_until; waitingChat clears both and deletes the claim;
   * stale clears the plan (the parts keep their keys); droppedStopped and withdrawn close the row.
   */
  async markRow(
    request: MarkRowRequest,
  ): Promise<MarkRowResponse | VersionChangedError | WrongStateError | NotFoundError | TransientError> {
    await yieldToOthers(1);
    const answer = this.moveRow(request);
    this.rowMarks.push({ request, answer: "error" in answer ? answer.error : answer.outcome });
    return answer;
  }

  private moveRow(
    request: MarkRowRequest,
  ): MarkRowResponse | VersionChangedError | WrongStateError | NotFoundError {
    const row = this.rows.get(request.outboxRowId);
    if (row === undefined) return { error: "notFound", table: "outbox_rows", rowId: request.outboxRowId };
    if (row.state !== "sending") {
      return { error: "wrongState", table: "outbox_rows", rowId: row.seed.id, state: row.state };
    }
    if (row.version !== request.expectVersion) {
      return {
        error: "versionChanged",
        changed: [
          {
            table: "outbox_rows",
            rowId: row.seed.id,
            readVersion: request.expectVersion,
            currentVersion: row.version,
          },
        ],
      };
    }
    switch (request.outcome) {
      case "held":
        row.state = "held";
        row.heldUntil = request.heldUntil;
        break;
      case "waitingChat":
        row.state = "waiting_chat";
        row.heldUntil = null;
        row.claim = null;
        break;
      case "stale":
        row.state = "stale";
        break;
      case "droppedStopped":
        row.state = "dropped_stopped";
        break;
      case "withdrawn":
        row.state = "withdrawn";
        break;
    }
    row.version += 1;
    return { result: "marked", outboxRowId: row.seed.id, version: row.version, outcome: request.outcome };
  }

  /** The row composed again from today's record (K-05 writePlan: stale to checked), with its new words and versions. */
  recompose(id: string, sends: readonly PlannedSend[], versionsRead: readonly VersionRef[]): void {
    const row = this.row(id);
    if (row.state !== "stale") throw new Error(`row ${id} is ${row.state}, not stale`);
    row.sends = sends;
    row.versionsRead = versionsRead;
    row.state = "checked";
    row.version += 1;
  }

  async renewClaim(
    request: RenewClaimRequest,
  ): Promise<
    RenewClaimResponse | ClaimLostError | NotYetError | WrongStateError | NotFoundError | TransientError
  > {
    await yieldToOthers(1);
    const answer = this.renew(request);
    this.renewals.push({ request, answer: "error" in answer ? answer.error : answer.result });
    return answer;
  }

  private renew(
    request: RenewClaimRequest,
  ): RenewClaimResponse | ClaimLostError | NotYetError | WrongStateError | NotFoundError {
    const row = this.rows.get(request.outboxRowId);
    if (row === undefined) return { error: "notFound", table: "outbox_rows", rowId: request.outboxRowId };
    const claim = row.claim;
    if (row.state !== "sending" || claim?.claimer !== request.claimer || claim.claimNo !== request.claimNo) {
      return {
        error: "claimLost",
        table: "outbox_rows",
        rowId: row.seed.id,
        claimer: claim?.claimer ?? null,
        claimNo: claim?.claimNo ?? null,
        state: row.state,
      };
    }
    const part = row.parts.find((candidate) => candidate.key === request.idempotencyKey);
    if (part?.state !== "pending") {
      return {
        error: "wrongState",
        table: "outbox_parts",
        rowId: request.idempotencyKey,
        state: part?.state ?? "unknown",
      };
    }
    if (claim.nextTryNotBefore !== null && after(claim.nextTryNotBefore, request.at)) {
      return { error: "notYet", outboxRowId: row.seed.id, notBefore: claim.nextTryNotBefore };
    }
    row.claim = {
      ...claim,
      lapsesAt: addMs(request.at, CLAIM_MS),
      firstTryAt: claim.firstTryAt ?? request.at,
      nextTryNotBefore: null,
    };
    return { result: "renewed", outboxRowId: row.seed.id, claim: row.claim };
  }

  async markPart(
    request: MarkPartRequest,
  ): Promise<MarkPartResponse | NotFoundError | WrongStateError | TransientError> {
    await yieldToOthers(1);
    this.marks.push(request);
    if (request.outcome === "delivered") return this.markDelivered(request.providerMessageId, request.at);

    const row = [...this.rows.values()].find((candidate) =>
      candidate.parts.some((part) => part.key === request.idempotencyKey),
    );
    const part = row?.parts.find((candidate) => candidate.key === request.idempotencyKey);
    if (row === undefined || part === undefined) {
      return { error: "notFound", table: "outbox_parts", rowId: request.idempotencyKey };
    }
    if (request.outcome === "sent") {
      if (part.state !== "pending") return this.answer(row, part, true, false); // a second "sent": repeated
      part.state = "sent";
      part.messageId = request.providerMessageId;
      row.version += 1;
      if (row.parts.every((candidate) => candidate.state === "sent")) row.state = "sent";
      return this.answer(row, part, false, false);
    }
    if (part.state !== "pending") return this.answer(row, part, true, false);
    if (request.retry) throw new Error("the fake does not build retries: T-258");
    part.state = "failed";
    row.version += 1;
    return this.answer(row, part, false, false);
  }

  private markDelivered(
    providerMessageId: string,
    at: Utc,
  ): MarkPartResponse | NotFoundError | WrongStateError {
    const row = [...this.rows.values()].find((candidate) =>
      candidate.parts.some((part) => part.messageId === providerMessageId),
    );
    const part = row?.parts.find((candidate) => candidate.messageId === providerMessageId);
    if (row === undefined || part === undefined) {
      return { error: "notFound", table: "outbox_parts", rowId: providerMessageId };
    }
    if (part.state === "delivered") return this.answer(row, part, true, false);
    if (part.state !== "sent") {
      return { error: "wrongState", table: "outbox_parts", rowId: part.key, state: part.state };
    }
    const firstDelivery = row.parts.every((candidate) => candidate.state !== "delivered");
    part.state = "delivered";
    part.deliveredAt = at;
    row.version += 1;
    if (row.parts.every((candidate) => candidate.state === "delivered")) row.state = "delivered";
    return this.answer(row, part, false, firstDelivery);
  }

  private answer(row: FakeRow, part: FakePart, repeated: boolean, firstDelivery: boolean): MarkPartResponse {
    return {
      result: "marked",
      outboxRowId: row.seed.id,
      partNo: part.partNo,
      tryNo: part.tryNo,
      attempts: part.attempts,
      repeated,
      firstDelivery,
      openQuestionId: row.seed.openQuestionId ?? null,
      nextKey: null,
      row: { state: row.state, version: row.version },
    };
  }
}

/** A Linq port that records every call and, like Linq, answers a repeated key with the first message. */
export class FakeLinq implements LinqPort {
  /** Every sendPart request, in the order made (repeats included). */
  readonly requests: LinqSendRequest[] = [];
  /** The message each key got: one per key, however many calls named it. */
  readonly accepted = new Map<string, LinqAccepted>();
  /** An answer for a key instead of an acceptance. */
  readonly failures = new Map<string, LinqFailed>();
  /** Runs before each answer: a test holds a send in the air here. */
  beforeAnswer: ((request: LinqSendRequest) => Promise<void>) | null = null;
  private count = 0;

  constructor(private readonly now: () => Utc) {}

  async sendPart(request: LinqSendRequest): Promise<LinqAccepted | LinqFailed> {
    this.requests.push(request);
    await yieldToOthers(1);
    if (this.beforeAnswer !== null) await this.beforeAnswer(request);
    const failure = this.failures.get(request.idempotencyKey);
    if (failure !== undefined) return failure;
    const first = this.accepted.get(request.idempotencyKey);
    if (first !== undefined) return first;
    this.count += 1;
    const accepted: LinqAccepted = {
      result: "accepted",
      providerMessageId: `linq-msg-test-${String(this.count).padStart(4, "0")}`,
      providerOptionIds:
        request.kind === "poll"
          ? request.options.map((_, index) => `linq-opt-test-${String(index + 1)}`)
          : null,
      chatId: request.chatId,
      service: request.service,
      acceptedAt: this.now(),
    };
    this.accepted.set(request.idempotencyKey, accepted);
    return accepted;
  }

  /** The keys in the order the first call named them. */
  get keysInOrder(): string[] {
    return [...new Set(this.requests.map((request) => request.idempotencyKey))];
  }
}

export class FakeRecipients implements RecipientDirectory {
  /** Runs before an answer: a test holds a run here, after its claim and before its first renewal. */
  beforeAnswer: ((recipientHandleId: string) => Promise<void>) | null = null;

  constructor(private readonly chats: Readonly<Record<string, ChatTarget>>) {}

  async chatFor(recipientHandleId: string): Promise<ChatTarget | null> {
    await yieldToOthers(1);
    if (this.beforeAnswer !== null) await this.beforeAnswer(recipientHandleId);
    return this.chats[recipientHandleId] ?? null;
  }
}

/**
 * A send-state read that answers as K-04's and K-07's fixtures state (NQ-RT-2's default until K-05 v1.2): an open chat,
 * a customer, a business in New York with text hours 08:00 to 20:00 (seed-business-head.json), not stopped, no override,
 * and the versions the row read still current. It gives no stop time and no texts row (K-05 v1.2 `phone.stopAt` and
 * `textsConsent`) unless a test sets them (T-1099). A test sets what differs, for a recipient (handle id) or for one row.
 */
export class FakeSendState implements SendStateReader {
  private readonly byHandle = new Map<string, Partial<SendState>>();
  private readonly byRow = new Map<string, Partial<SendState>>();
  /** How many of the next reads answer transient instead (a lost connection). */
  failReads = 0;
  /** Every row id a read was made for, in order. */
  readonly reads: string[] = [];

  forHandle(handle: string, patch: Partial<SendState>): this {
    this.byHandle.set(handle, { ...this.byHandle.get(handle), ...patch });
    return this;
  }

  forRow(rowId: string, patch: Partial<SendState>): this {
    this.byRow.set(rowId, { ...this.byRow.get(rowId), ...patch });
    return this;
  }

  async sendStateFor(row: ClaimedRow): Promise<SendState | TransientError> {
    await yieldToOthers(1);
    this.reads.push(row.outboxRowId);
    if (this.failReads > 0) {
      this.failReads -= 1;
      return { error: "transient", sqlstate: "08006" };
    }
    return {
      stopped: false,
      chatOpen: true,
      audience: "customer",
      visitZone: null,
      businessZone: "America/New_York",
      textHours: { start: "08:00", end: "20:00" },
      textHoursOverride: false,
      currentVersions: row.versionsRead,
      closed: { booking: false, question: false },
      ...this.byHandle.get(row.recipientHandleId),
      ...this.byRow.get(row.outboxRowId),
    };
  }
}

export class FakeClockArming implements ClockArming {
  readonly delivered: PartDelivered[] = [];

  partDelivered(delivered: PartDelivered): Promise<void> {
    this.delivered.push(delivered);
    return Promise.resolve();
  }
}

/** Opens a row's trace with spans kept in `spans` (the bundle id is a stand-in of the right shape). */
export function traceCollector(spans: Span[]): (row: ClaimedRow) => TraceContext {
  return (row) =>
    openTrace({
      openedBy: "sweep",
      jobId: "dispatch-sweep",
      bundleId: { hash: "0123456789abcdef".repeat(4), build: 1 },
      handleRef: row.recipientHandleId,
      sink: (span) => spans.push(span),
    });
}

export const words = (text: string): PlannedSend => ({
  kind: "words",
  text,
  calendarFile: "none",
  options: [],
  link: null,
});
