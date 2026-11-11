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
//                     first receipt, a second receipt says repeated and, as K-05 v1.9 item 48 answers it, what it
//                     repeats: mark-a7-03-delivered-repeat.json, mark-a7-03-poll-delivered-repeat.json; every other
//                     answer states repeatedDelivery null), mark-delivered-by-key.json (v1.2 item 31: no part
//                     holds the message id, so the part under the echoed key that holds none is the receipt's, failed
//                     to delivered after a 4001 or 4006), mark-failed-4006.json (failed, no next try),
//                     mark-failed-retry-after.json (failed with retry: the next try's key, try + 1, and the
//                     Retry-After kept as the claim's nextTryNotBefore). A failed mark with retry on a part that already
//                     failed with no next try writes it then (K-07 outbox-4006-new-key.json: try 2 written by markPart a
//                     minute after try 1 failed, with no move of try 1); once the next try exists it says repeated with
//                     its key; on a part delivered since, wrongState. The row follows each part's latest try (item 15):
//                     every one accepted, sent; every one delivered, delivered (from sending after a 4001 or 4006).
// `FakeLinq` answers `sendPart` as send-text.json, send-poll.json and send-link-card.json state (accepted, with a message
// id, and option ids for a poll) and, like Linq, answers a repeated idempotency key with the first message (K-11). A test
// gives a key a fixed failure (`failures`: Linq answers that key so every time, as it replays a stored failure) or a
// script of answers, one per call (`scripts`: a timeout, then the acceptance of the same key).

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
  RepeatedDelivery,
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
/** One try of a part (K-04 outbox_parts: one row per try, `<row>/<part>/<try>`). */
interface FakePart {
  partNo: 1 | 2;
  tryNo: number;
  key: string;
  attempts: number;
  state: PartState;
  messageId: string | null;
  /** When the try was written: by the claim (try 1), or by the failed mark that made it (a later try). */
  writtenAt: Utc;
  sentAt: Utc | null;
  deliveredAt: Utc | null;
  failedAt: Utc | null;
  errorCode: string | null;
}

/** Each part's latest try, by part number. */
function latestTries(parts: readonly FakePart[]): FakePart[] {
  const latest = new Map<number, FakePart>();
  for (const part of parts) {
    const known = latest.get(part.partNo);
    if (known === undefined || part.tryNo > known.tryNo) latest.set(part.partNo, part);
  }
  return [...latest.values()].sort((a, b) => a.partNo - b.partNo);
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
      // Kept across a re-claim (K-05 v1.1 item 13); a seed's Retry-After stands in for an earlier failure's.
      nextTryNotBefore: old === null ? (row.seed.nextTryNotBefore ?? null) : old.nextTryNotBefore,
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
          writtenAt: request.now,
          sentAt: null,
          deliveredAt: null,
          failedAt: null,
          errorCode: null,
        };
      });
    } else {
      // A part the provider never accepted keeps its stored key with attempts raised (K-05 v1 item 3; arch 11 line 576).
      for (const part of latestTries(row.parts)) {
        if (part.state === "pending" || part.state === "failed") part.attempts += 1;
      }
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
      // Each part's latest try (claim-lapsed-reclaimed.json lists try 2 alone).
      parts: latestTries(row.parts).map((part) => ({
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
    if (request.outcome === "delivered") return this.markDelivered(request);

    const found = this.partByKey(request.idempotencyKey);
    if (found === null) return { error: "notFound", table: "outbox_parts", rowId: request.idempotencyKey };
    const { row, part } = found;
    if (request.outcome === "sent") {
      if (part.state !== "pending") return this.answer(row, part, { repeated: true }); // a second "sent"
      part.state = "sent";
      part.messageId = request.providerMessageId;
      part.sentAt = request.at;
      row.version += 1;
      this.followParts(row);
      return this.answer(row, part, {});
    }

    // failed (K-07 part moves: pending or sent → failed; a failed try's next try written by markPart).
    if (part.state === "delivered") {
      return { error: "wrongState", table: "outbox_parts", rowId: part.key, state: part.state };
    }
    if (part.state === "failed") {
      if (!request.retry) return this.answer(row, part, { repeated: true });
      const next = row.parts.find(
        (candidate) => candidate.partNo === part.partNo && candidate.tryNo === part.tryNo + 1,
      );
      if (next !== undefined) return this.answer(row, part, { repeated: true, nextKey: next.key });
      // A 4001 or 4006 whose minute passed with no receipt: its next try now (outbox-4006-new-key.json).
      const written = this.writeNextTry(row, part, request.at, request.nextTryNotBefore ?? null);
      row.version += 1;
      return this.answer(row, part, { nextKey: written.key });
    }
    const wasSent = part.state === "sent";
    part.state = "failed";
    part.failedAt = request.at;
    part.errorCode = request.errorCode;
    // Kept so a receipt after a 4001 or 4006 finds the part (K-05 v1.1 item 15: when the part has none).
    if (part.messageId === null && request.providerMessageId !== undefined) {
      part.messageId = request.providerMessageId;
    }
    let nextKey: string | null = null;
    if (request.retry) {
      nextKey = this.writeNextTry(row, part, request.at, request.nextTryNotBefore ?? null).key;
      // An accepted part reported failed goes again: its row is open again (K-07 sent → checked).
      if (wasSent && row.state === "sent") row.state = "checked";
    }
    row.version += 1;
    return this.answer(row, part, { nextKey });
  }

  /** The try after `part`, pending under a new key; the provider's Retry-After goes on the claim (K-05 v1.1 item 15). */
  private writeNextTry(row: FakeRow, part: FakePart, at: Utc, nextTryNotBefore: Utc | null): FakePart {
    const tryNo = part.tryNo + 1;
    const next: FakePart = {
      partNo: part.partNo,
      tryNo,
      key: `${row.seed.id}/${String(part.partNo)}/${String(tryNo)}`,
      attempts: 1,
      state: "pending",
      messageId: null,
      writtenAt: at,
      sentAt: null,
      deliveredAt: null,
      failedAt: null,
      errorCode: null,
    };
    row.parts.push(next);
    if (nextTryNotBefore !== null && row.claim !== null) row.claim = { ...row.claim, nextTryNotBefore };
    return next;
  }

  /** The row follows each part's latest try (K-05 v1.1 item 15). */
  private followParts(row: FakeRow): void {
    const latest = latestTries(row.parts);
    if (latest.every((part) => part.state === "delivered")) row.state = "delivered";
    else if (latest.every((part) => part.state === "sent" || part.state === "delivered")) row.state = "sent";
  }

  private partByKey(key: string): { row: FakeRow; part: FakePart } | null {
    for (const row of this.rows.values()) {
      const part = row.parts.find((candidate) => candidate.key === key);
      if (part !== undefined) return { row, part };
    }
    return null;
  }

  /** Every try of a row's parts, by part and then try (a test reads them against K-07's fixtures). */
  tries(id: string): readonly FakePart[] {
    return [...this.row(id).parts].sort((a, b) => a.partNo - b.partNo || a.tryNo - b.tryNo);
  }

  private markDelivered(
    request: Extract<MarkPartRequest, { outcome: "delivered" }>,
  ): MarkPartResponse | NotFoundError | WrongStateError {
    const byId = [...this.rows.values()]
      .map((row) => ({
        row,
        part: row.parts.find((candidate) => candidate.messageId === request.providerMessageId),
      }))
      .find((entry) => entry.part !== undefined);
    let found = byId?.part === undefined ? null : { row: byId.row, part: byId.part };
    if (found === null && request.idempotencyKey !== undefined) {
      // K-05 v1.2 item 31: the part under the echoed key is the receipt's only if it holds no message id of its own.
      const byKey = this.partByKey(request.idempotencyKey);
      if (byKey?.part.messageId === null) {
        byKey.part.messageId = request.providerMessageId;
        found = byKey;
      }
    }
    if (found === null) return { error: "notFound", table: "outbox_parts", rowId: request.providerMessageId };
    const { row, part } = found;
    if (part.state === "delivered") {
      // K-05 v1.9 item 48: a repeat writes nothing and says what it repeats, from the stored times.
      return this.answer(row, part, { repeated: true, repeatedDelivery: this.repeatedDeliveryOf(row, part) });
    }
    // A receipt moves a sent part, or a failed one after a 4001 or 4006 that delivered anyway (K-07).
    if (part.state !== "sent" && part.state !== "failed") {
      return { error: "wrongState", table: "outbox_parts", rowId: part.key, state: part.state };
    }
    const firstDelivery = row.parts.every((candidate) => candidate.state !== "delivered");
    part.state = "delivered";
    part.deliveredAt = request.at;
    row.version += 1;
    this.followParts(row);
    return this.answer(row, part, { firstDelivery });
  }

  /**
   * What a repeated delivery receipt repeats (K-05 v1.9 item 48; mark-a7-03-delivered-repeat.json and
   * mark-a7-03-poll-delivered-repeat.json): `firstOfRow` when no other part try of the row holds an earlier delivery
   * time, a tie counting as first (default 85), and the part try's stored time, never the repeat's own (default 86). A
   * delivered part try with no delivery time is thrown, never answered by a guess (db/repo outbox.ts default 21).
   */
  private repeatedDeliveryOf(row: FakeRow, part: FakePart): RepeatedDelivery {
    const deliveredAt = part.deliveredAt;
    if (
      deliveredAt === null ||
      row.parts.some((one) => one.state === "delivered" && one.deliveredAt === null)
    ) {
      throw new Error("markPart: a delivered part holds no delivered_at");
    }
    const firstOfRow = row.parts.every(
      (one) => one.deliveredAt === null || !after(deliveredAt, one.deliveredAt),
    );
    return { firstOfRow, deliveredAt };
  }

  private answer(
    row: FakeRow,
    part: FakePart,
    said: {
      repeated?: boolean;
      firstDelivery?: boolean;
      nextKey?: string | null;
      repeatedDelivery?: RepeatedDelivery;
    },
  ): MarkPartResponse {
    return {
      result: "marked",
      outboxRowId: row.seed.id,
      partNo: part.partNo,
      tryNo: part.tryNo,
      attempts: part.attempts,
      repeated: said.repeated ?? false,
      firstDelivery: said.firstDelivery ?? false,
      openQuestionId: row.seed.openQuestionId ?? null,
      nextKey: said.nextKey ?? null,
      row: { state: row.state, version: row.version },
      // A v1.9 call always states it: null on every answer but a repeated delivery receipt's (default 87).
      repeatedDelivery: said.repeatedDelivery ?? null,
    };
  }
}

/** A Linq port that records every call and, like Linq, answers a repeated key with the first message. */
export class FakeLinq implements LinqPort {
  /** Every sendPart request, in the order made (repeats included). */
  readonly requests: LinqSendRequest[] = [];
  /** The message each key got: one per key, however many calls named it. */
  readonly accepted = new Map<string, LinqAccepted>();
  /** An answer for a key instead of an acceptance, every time the key is named (a failure Linq stored for it). */
  readonly failures = new Map<string, LinqFailed>();
  /** Answers for a key, one per call in order (a timeout, then the acceptance); used up, the key goes on as above. */
  readonly scripts = new Map<string, (LinqFailed | LinqAccepted | "accept")[]>();
  /** Runs before each answer: a test holds a send in the air here. */
  beforeAnswer: ((request: LinqSendRequest) => Promise<void>) | null = null;
  private count = 0;

  constructor(private readonly now: () => Utc) {}

  async sendPart(request: LinqSendRequest): Promise<LinqAccepted | LinqFailed> {
    this.requests.push(request);
    await yieldToOthers(1);
    if (this.beforeAnswer !== null) await this.beforeAnswer(request);
    const scripted = this.scripts.get(request.idempotencyKey)?.shift();
    if (scripted !== undefined && scripted !== "accept") {
      if (scripted.result === "accepted") this.accepted.set(request.idempotencyKey, scripted);
      return scripted;
    }
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
