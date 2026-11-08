// Doubles for the fixed replies' tests (T-267). Not imported by the Worker. They answer as the frozen contracts state:
//
//   - `FakeCore` is the shared core behind K-09 v1's core actions, kept in memory: the phones (K-04: one stopped flag and
//     one chat flag per number), K-29's consent rows, K-07's outbox rows and the open bookings a STOP tells. It answers
//     `recordStopOrStart` and `sendFixedLine` as K-09 v1 and v1.1 describe them: a STOP sets the flag for every business,
//     closes the chat, adds a texts row with no business that withdraws texts, writes the stop reply's row (quick_reply,
//     README default 6) and, for each business with an open booking for that phone, one row to its owner with
//     `textsOffReachTheirWay` (v1.1 default 50); CANCEL and CANCELAR also flag those visits; a START clears the flag,
//     reopens the chat, adds a texts row with no business and writes its reply's row; a fixed line to a stopped number
//     is refused (`phoneStopped`). One commit per turn: a repeat of a turn id answers its first commit, `repeated`.
//   - `FakeCore.rows` answers K-05 v1 `unplannedRows` and `writePlan` over the same rows (writePlan: written, version + 1;
//     alreadyPlanned for a row that holds a plan; versionChanged on another version; notFound).
//   - `seedRowsOf` hands the rows with words to the dispatcher's fakes (../../dispatch/test-support.ts), as claimOutbox
//     would find them once checked.
// Test values only: the master's sample cast and the frozen fixtures' ids; phones in the fictional 555-01xx range, and
// Rosie's line +1 555-555-0199 as K-11's vendor samples give it (rule 9).

import { manifestOf, type Manifest } from "../../bundle";
import { BUNDLE_A, WHOLE_A } from "../../bundle/test-support";
import type { SeedRow } from "../../dispatch/test-support";
import { openTrace, type Span, type TraceContext } from "../../trace";
import type { GuardText } from "../types";
import type {
  BusinessTold,
  Channel,
  CoreCommitAnswer,
  CoreCommitRequest,
  CoreCommitted,
  CoreError,
  FixedFinalParts,
  FixedRowPlan,
  RecordStopOrStartRequest,
  RecordStopOrStartResponse,
  ReplyCoreResult,
  ReplyRows,
  SendFixedLineRequest,
  SendFixedLineResponse,
  UnplannedRowsAnswer,
  WritePlanAnswer,
  WritePlanRequest,
} from "./types";

/** Rosie's line as K-11's vendor samples give it (port-linq README: "Rosie's line is +1 555 555 0199 here"). */
export const ROSIE_NUMBER = "+1 555-555-0199";

// ---- the record --------------------------------------------------------------------------------------------------

/** K-04 phones, as the core keeps one number. */
export interface FakePhone {
  number: string;
  handleId: string;
  personId: string | null;
  stopped: boolean;
  stopAt: string | null;
  chatOpen: boolean;
  version: number;
}

/** K-29 v1 consents, as a STOP or a START writes one. */
export interface FakeConsent {
  id: string;
  personId: string | null;
  businessId: string | null;
  kind: "texts";
  revoked: boolean;
  handleId: string;
  exactWords: string;
  at: string;
  channel: "text";
  turnId: string;
}

/** K-07 outbox rows, as the commit writes them (no words) and writePlan fills them. */
export interface FakeRow {
  id: string;
  turnId: string;
  commitSeq: number;
  recipientHandleId: string;
  businessId: string | null;
  bookingId: string | null;
  channel: Channel;
  sendClass: "quick_reply" | "routine";
  /** The fixed line the core named for the row. */
  fixedLineId: string;
  version: number;
  plan: FixedRowPlan | null;
  finalParts: FixedFinalParts | null;
}

/** A booking at stage entry or booked whose booker, person served or payer has the phone as their own handle. */
export interface OpenBooking {
  bookingId: string;
  businessId: string;
  /** The handle of the business's owner, who is told (K-09 v1.1 default 50). */
  ownerHandleId: string;
}

/** Ids the core uses for one turn, so an exchange's own ids come back (a fixture's outcome); left out: made up. */
export interface TurnIds {
  consent?: string;
  reply?: string;
  /** The notice row to each business, by business id. */
  notices?: Readonly<Record<string, string>>;
}

export interface FakeCore {
  /** What `setReplyDeps` takes as `core`. */
  readonly core: { commitCore(request: CoreCommitRequest): Promise<CoreCommitAnswer> };
  /** What `setReplyDeps` takes as `rows`. */
  readonly rows: ReplyRows;
  readonly phones: Map<string, FakePhone>;
  readonly consents: FakeConsent[];
  readonly outbox: Map<string, FakeRow>;
  /** The open bookings of each number. */
  readonly openBookings: Map<string, OpenBooking[]>;
  readonly ids: Map<string, TurnIds>;
  /** Every commit request, in order. */
  readonly commits: CoreCommitRequest[];
  /** Every commit answer, in order (a copy). */
  readonly answers: CoreCommitAnswer[];
  /** Every writePlan request, in order. */
  readonly plans: WritePlanRequest[];
  /** Every unplannedRows request's turn id, in order. */
  readonly unplannedReads: string[];
  /** While true every core call throws (no answer), as a core with PostgreSQL down does. */
  down: boolean;
  /** Answers the next commit with this error instead (nothing written). */
  failNextCommit: CoreError | null;
  /** The next writePlan for each of these rows throws (no answer), as a crash before the words were written would. */
  readonly failPlanOnce: Set<string>;
  /** The clock, as a UTC string. */
  now: string;
}

/** The phones of the master's sample cast this file's tests use. */
export function phone(number: string, handleId: string, personId: string | null, version = 3): FakePhone {
  return { number, handleId, personId, stopped: false, stopAt: null, chatOpen: true, version };
}

/**
 * The shared core and its rows over these phones. Its rows are numbered in commit order from `firstCommitSeq`, so a test's
 * own rows for a recipient (earlier commits) can sit before them.
 */
export function fakeCore(now: string, phones: readonly FakePhone[], firstCommitSeq = 100): FakeCore {
  let commitSeq = firstCommitSeq - 1;
  const committed = new Map<string, CoreCommitted>();

  const answer = (value: CoreCommitAnswer): Promise<CoreCommitAnswer> => {
    fake.answers.push(structuredClone(value));
    return Promise.resolve(value);
  };

  const fake: FakeCore = {
    phones: new Map(phones.map((entry) => [entry.number, entry])),
    consents: [],
    outbox: new Map(),
    openBookings: new Map(),
    ids: new Map(),
    commits: [],
    answers: [],
    plans: [],
    unplannedReads: [],
    down: false,
    failNextCommit: null,
    failPlanOnce: new Set(),
    now,
    core: {
      commitCore(request) {
        fake.commits.push(structuredClone(request));
        if (fake.down) return Promise.reject(new Error("PostgreSQL is down"));
        if (fake.failNextCommit !== null) {
          const error = fake.failNextCommit;
          fake.failNextCommit = null;
          return answer(error);
        }
        const turnId = request.caller.turnId;
        const first = committed.get(turnId);
        if (first !== undefined) return answer({ ...structuredClone(first), repeated: true });
        const core: ReplyCoreResult[] = request.actions.map((action, index) =>
          action.call === "recordStopOrStart"
            ? { call: "recordStopOrStart", ...stopOrStart(action.request, index) }
            : { call: "sendFixedLine", ...fixedLine(action.request, index) },
        );
        const result: CoreCommitted = { result: "committed", turnId, repeated: false, core };
        committed.set(turnId, structuredClone(result));
        return answer(result);
      },
    },
    rows: {
      unplannedRows({ turnId }): Promise<UnplannedRowsAnswer> {
        fake.unplannedReads.push(turnId);
        if (fake.down) return Promise.reject(new Error("PostgreSQL is down"));
        const rows = [...fake.outbox.values()]
          .filter((row) => row.turnId === turnId && row.plan === null)
          .sort((a, b) => a.commitSeq - b.commitSeq)
          .map((row) => ({
            outboxRowId: row.id,
            version: row.version,
            commitSeq: row.commitSeq,
            recipientHandleId: row.recipientHandleId,
            channel: row.channel,
            copyOfRowId: null,
          }));
        return Promise.resolve({ result: "rows", rows });
      },
      writePlan(request): Promise<WritePlanAnswer> {
        fake.plans.push(structuredClone(request));
        if (fake.down) return Promise.reject(new Error("PostgreSQL is down"));
        if (fake.failPlanOnce.delete(request.outboxRowId)) {
          return Promise.reject(new Error("the actor crashed before the answer"));
        }
        const row = fake.outbox.get(request.outboxRowId);
        if (row === undefined) {
          return Promise.resolve({ error: "notFound", table: "outbox_rows", rowId: request.outboxRowId });
        }
        if (row.plan !== null) {
          return Promise.resolve({ error: "alreadyPlanned", outboxRowId: row.id, version: row.version });
        }
        if (row.version !== request.expectVersion) {
          return Promise.resolve({
            error: "versionChanged",
            changed: [
              {
                table: "outbox_rows",
                rowId: row.id,
                readVersion: request.expectVersion,
                currentVersion: row.version,
              },
            ],
          });
        }
        row.plan = structuredClone(request.plan);
        row.finalParts = structuredClone(request.finalParts);
        row.version += 1;
        return Promise.resolve({ result: "written", outboxRowId: row.id, version: row.version });
      },
    },
  };

  const handleOf = (handleId: string): FakePhone | undefined =>
    [...fake.phones.values()].find((entry) => entry.handleId === handleId);

  function writeRow(row: Omit<FakeRow, "commitSeq" | "version" | "plan" | "finalParts">): string {
    commitSeq += 1;
    fake.outbox.set(row.id, { ...row, commitSeq, version: 1, plan: null, finalParts: null });
    return row.id;
  }

  function stopOrStart(
    request: RecordStopOrStartRequest,
    index: number,
  ): { response: RecordStopOrStartResponse | null; error: CoreError | null } {
    const entry = fake.phones.get(request.phoneNumber);
    if (entry === undefined) {
      return { response: null, error: { error: "notFound", table: "phones", rowId: request.phoneNumber } };
    }
    const turnId = request.caller.turnId;
    const ids = fake.ids.get(turnId) ?? {};
    const stop = request.kind === "stop";
    entry.stopped = stop;
    entry.stopAt = stop ? fake.now : entry.stopAt;
    entry.chatOpen = !stop;
    entry.version += 1;
    const consentId = ids.consent ?? `consent-${turnId}-${String(index + 1)}`;
    fake.consents.push({
      id: consentId,
      personId: entry.personId,
      businessId: null,
      kind: "texts",
      revoked: stop,
      handleId: entry.handleId,
      exactWords: request.words,
      at: fake.now,
      channel: "text",
      turnId,
    });
    const fixedLineId = stop ? "stopReply" : "startReply";
    const replyId = writeRow({
      id: ids.reply ?? `out-${turnId}-${String(index + 1)}-${fixedLineId}`,
      turnId,
      recipientHandleId: entry.handleId,
      businessId: null,
      bookingId: null,
      channel: "imessage",
      sendClass: "quick_reply",
      fixedLineId,
    });
    const open = stop ? (fake.openBookings.get(request.phoneNumber) ?? []) : [];
    const businessesTold: BusinessTold[] = [];
    for (const businessId of [...new Set(open.map((booking) => booking.businessId))]) {
      const booking = open.find((candidate) => candidate.businessId === businessId);
      if (booking === undefined) continue;
      const rowId = writeRow({
        id: ids.notices?.[businessId] ?? `out-${turnId}-${businessId}-texts-off`,
        turnId,
        recipientHandleId: booking.ownerHandleId,
        businessId,
        bookingId: booking.bookingId,
        channel: "imessage",
        sendClass: "routine",
        fixedLineId: "textsOffReachTheirWay",
      });
      businessesTold.push({ businessId, fixedLineId: "textsOffReachTheirWay", outboxRowId: rowId });
    }
    return {
      response: {
        consentRowIds: [consentId],
        stopped: entry.stopped,
        chatOpen: entry.chatOpen,
        phoneVersion: entry.version,
        reply: { fixedLineId, outboxRowId: replyId },
        askedWhichTexts: null,
        flaggedBookingIds: request.alsoCancelVisit ? open.map((booking) => booking.bookingId) : [],
        repeated: false,
        businessesTold,
      },
      error: null,
    };
  }

  function fixedLine(
    request: SendFixedLineRequest,
    index: number,
  ): { response: SendFixedLineResponse | null; error: CoreError | null } {
    const entry = handleOf(request.recipientHandleId);
    if (entry?.stopped === true) {
      return {
        response: null,
        error: { error: "phoneStopped", recipientHandleId: request.recipientHandleId },
      };
    }
    const turnId = request.caller.turnId;
    const rowId = writeRow({
      id: `out-${turnId}-${String(index + 1)}-${request.fixedLineId}`,
      turnId,
      recipientHandleId: request.recipientHandleId,
      businessId: null,
      bookingId: null,
      channel: "imessage",
      sendClass: request.sendClass,
      fixedLineId: request.fixedLineId,
    });
    return { response: { outboxRowId: rowId, repeated: false }, error: null };
  }

  return fake;
}

/**
 * The rows with words, as the dispatcher's fake store seeds them (K-05 claimOutbox finds them checked); with `turnId`, only
 * that turn's rows.
 */
export function seedRowsOf(fake: FakeCore, turnId?: string): SeedRow[] {
  return [...fake.outbox.values()]
    .filter((row) => row.finalParts !== null && (turnId === undefined || row.turnId === turnId))
    .sort((a, b) => a.commitSeq - b.commitSeq)
    .map((row) => ({
      id: row.id,
      recipient: row.recipientHandleId,
      commitSeq: row.commitSeq,
      sends: (row.finalParts?.sends ?? []).map((send) => ({ ...send, options: [...send.options] })),
      sendClass: row.sendClass,
      bookingId: row.bookingId,
      fixedLines: [...(row.finalParts?.fixedLines ?? [])],
      channel: row.channel,
    }));
}

// ---- the pinned bundle and the turn ------------------------------------------------------------------------------

/** Bundle v0's manifest as the pin checks it (K-01's bundle-v0-skeleton.json): its fixed lines are K-01's. */
export async function pinnedManifest(): Promise<Manifest> {
  const manifest = await manifestOf(JSON.stringify(WHOLE_A.manifest), BUNDLE_A);
  if (manifest === null) throw new Error("bundle v0's manifest is not its id's");
  return manifest;
}

/** A copy of a manifest whose fixed line `id` has these words, as a bundle carrying Jay's words would. */
export function withLine(manifest: Manifest, id: string, text: string | null): Manifest {
  const copy = structuredClone(manifest) as Manifest & {
    lists: { fixedLines: { lines: { id: string; text: string | null; status: string }[] } };
  };
  for (const line of copy.lists.fixedLines.lines) {
    if (line.id === id) {
      line.text = text;
      line.status = text === null ? "pendingJay" : "asWritten";
    }
  }
  return copy;
}

/** A turn's trace under bundle v0's id, keeping every span. */
export function turnTrace(turnId: string): { trace: TraceContext; spans: Span[] } {
  const spans: Span[] = [];
  let clock = Date.parse("2026-10-22T16:40:00Z");
  const trace = openTrace({
    openedBy: "textWebhook",
    bundleId: BUNDLE_A,
    sink: (span) => spans.push(span),
    now: () => (clock += 3),
  });
  trace.setTurn(turnId);
  return { trace, spans };
}

/** A typed text (K-06 kind text) with these words and this event id. */
export const typed = (eventId: string, body: string): GuardText => ({
  eventId,
  kind: "text",
  words: { body, subject: null },
});
