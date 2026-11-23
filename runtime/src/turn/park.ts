// The park (T-253, T-1552; C-180; arch 11 'Crash in the middle of a turn', architecture.txt line 576: "A third crash
// before the commit parks the turn for Rosie's team, freeing the inbox for later texts; the person hears once that
// nothing changed and that Rosie's team will reply within 1 business day"; K-09 v1.13 default 218: that park, applied
// sooner, on a final answer before the commit). Two ways in, one request form, K-05 v1.23 item 84's `parkTurn.lineRequest`:
//
//   - after a third crash (`parkThroughRows`): the lease (../actor/lease.ts) calls it as its `park` hook when a turn's third
//     try lapses with no commit. The turn is parked on try 3 with no reason, and its entry's `why` is v1's outage path
//     (K-05 v1.23 default 218; T-1529's ruling card 7);
//   - at once on a final answer (`parkAtOnce`): the turn's run (./turn.ts) calls it when gateAndCommit answered turnRefused
//     or notBuilt, or buildFrontier notBuilt, and the turn holds no stop word (K-09 v1.13 default 218; the ruling's card 6).
//     The turn is parked on the try the lease counted (1 to 3), with the refusal's labels as its reason (K-05 v1.23
//     parkReason) and the same labels as its entry's `why` (`{refused: reason}`, default 222).
//
// Either way:
//   1. The handle's directory names the handle (K-04 handles.id), its person and its business, as for a run of the turn.
//   2. K-05 v1.23 parkTurn, through the turn's K-05 face (`TurnDeps.rows`), in one transaction on K-05's side: the turn
//      parked with its tries, K-37's parked_turns row for Rosie's team (its summary K-05's, built from the reason's labels
//      or the fixed crash text: default 220), the one row, and its event-log entry. The row is a quick reply to the turn's
//      own handle (`recipientHandleId` the directory's handle id, on that handle's own way: email for an email handle, a
//      phone by iMessage first, RULES 4.8), about no booking, asking no question, decided on no versions (default 219),
//      whose words are K-01's passedOn fixed line, word for word (`PASSED_ON_LINE`, default 216): code's plan, text alone
//      with no lines, and final parts of one words send with `fixedLines` ["passedOn"]. No model, slot or bundle read
//      words it, and nothing of the turn's texts or the refused part is in it. K-05 writes it planned, then checked at
//      version 2 with that plan and those parts (default 221), so the claim takes it like any checked row. Its id is fixed
//      by rule from the turn id (`out-<turn id>-parked`), as is the entry's (`log-<turn id>-parked`), so a park sent again
//      (after a crash, or by a rerun that meets the same final answer) is K-05's repeat (`repeated`), never a second row or
//      a second line (default 223). A transient answer, or one lost on its way, is sent once more as the same request.
//   3. The dispatcher is woken once for that row, as after a commit; it sends the row like any other (limit 8 decides
//      about a stopped number: RULES 7.2). A repeated park wakes it again, which sends nothing twice: one row, one key per
//      part.
//
// The answer goes back to the caller: parked (first or repeated), alreadyCommitted (the turn committed, so it is never
// parked), or why the park could not be done now (a label): the lease tries a crash park again 30 s on, and a run whose
// park at once was not done leaves the turn to the lease's lapse, whose rerun meets the same final answer and parks again.
// Rosie's team is paged only through T-319's paging (the ruling's ruling 2); nothing here pages.
//
// Never logged or put in a span: a text's words, the line's words, a number, a recipient, a key; the park's `lease` span
// holds labels, counts and ids only (K-08): the reason's labels, the try, the rows' ids.
//
// Not here: when the person counts as told (K-05 v1.23 open gap 104); Jay's words for the park (K-05 open gap 103:
// passedOn stands in); the team console (C-194).

import type { ParkAnswer, ParkingTurn } from "../actor";
import { actorNameOf, type HandleRef } from "../gateway/seal";
import { isLabel, type Outcome, type SpanFacts } from "../trace";
import type { RowRef } from "../trace/types";
import type {
  EventEntry,
  FinalParts,
  OutboxChannel,
  ParkedRowNew,
  ParkReason,
  ParkTurnLineRequest,
  RowPlan,
  TurnDeps,
  TurnParty,
} from "./types";

/** How many times parkTurn is sent in all when it answers transient or its answer is lost: the first send and one more. */
export const PARK_SENDS = 2;

/** The try a crash parks a turn on: K-05 parkTurn's `turn.tries` 3 with no reason (the lease's MAX_TRIES). */
const CRASHED_ON_TRY = 3;

/** The tries a final answer parks a turn on: the try the lease counted, 1 to 3 (K-05 v1.23 item 84). */
const TRIES: readonly number[] = [1, 2, 3];

/**
 * K-01's passedOn fixed line, word for word, its two apostrophes the typographic one (U+2019), as K-05 v1.23's
 * `parkedLineParts` holds it (a constant of the schema, default 216) and bundles/v2's manifest writes it (S13-29).
 */
export const PASSED_ON_LINE = "I’ve passed this on. Rosie’s team will reply within 1 business day.";

/** The K-01 fixed line the park's row carries, by id (`fixedLines`). */
export const PASSED_ON = "passedOn";

/** The one row's id, fixed by rule from the turn id: a park sent again names the same row. */
export const parkedRowId = (turnId: string): string => `out-${turnId}-parked`;

/** The park's event-log entry's id, fixed by rule from the turn id (park-turn.json's `log-<turn id>-parked`). */
export const parkedEventId = (turnId: string): string => `log-${turnId}-parked`;

/** The outage path a crash park's entry names (K-08 `why`; park-turn.json; K-05 v1.23 default 222). */
const CRASHED_WHY = { outage: "third crash before the commit" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What K-05 answered, as the park reads it. */
type ParkRead =
  | {
      readonly kind: "parked";
      readonly parkedAt: string;
      readonly repeated: boolean;
      readonly rows: string[];
    }
  | { readonly kind: "committed"; readonly committedAt: string }
  | { readonly kind: "notDone"; readonly code: string };

/** Codes parkTurn is sent once more on: nothing was written (transient), or the answer was lost on its way. */
const RESEND_CODES: ReadonlySet<string> = new Set(["transient", "noAnswer"]);
/** Codes that say the call could not run (failed) rather than that it was refused. */
const FAILED_CODES: ReadonlySet<string> = new Set(["noAnswer", "transient", "badAnswer", "unwired"]);

const notDone = (code: string): ParkRead => ({ kind: "notDone", code });

/** K-05 parkTurn's answer for this turn; anything that is not the contract's is badAnswer. */
function readPark(answer: unknown, turnId: string): ParkRead {
  if (!isRecord(answer)) return notDone("badAnswer");
  if (answer.result === "parked") {
    const { parkedAt, repeated, outboxRows } = answer;
    if (answer.turnId !== turnId || typeof parkedAt !== "string" || typeof repeated !== "boolean") {
      return notDone("badAnswer");
    }
    if (!Array.isArray(outboxRows)) return notDone("badAnswer");
    const rows = (outboxRows as unknown[]).flatMap((row) =>
      isRecord(row) && isLabel(row.id) ? [row.id] : [],
    );
    return { kind: "parked", parkedAt, repeated, rows };
  }
  if (answer.error === "alreadyCommitted") {
    const { committedAt } = answer;
    if (answer.turnId !== turnId || typeof committedAt !== "string") return notDone("badAnswer");
    return { kind: "committed", committedAt };
  }
  return notDone(isLabel(answer.error) ? answer.error : "badAnswer");
}

/**
 * The passedOn line's plan and final parts for one row (K-05 v1.23 `parkedLinePlan` and `parkedLineParts`): code's plan,
 * text alone with no lines, question, page type, thread or copy; one words send of the line word for word, with no option,
 * link or calendar file, `fixedLines` ["passedOn"] and no slot value; each naming the row and its channel.
 */
export function parkedLineOf(
  rowId: string,
  channel: OutboxChannel,
): { plan: RowPlan; finalParts: FinalParts } {
  return {
    plan: {
      row: rowId,
      channel,
      copyOf: null,
      plan: { formats: ["text"], lines: [], question: null, pageType: null, threadReplyTo: null },
    },
    finalParts: {
      row: rowId,
      channel,
      sends: [{ kind: "words", text: PASSED_ON_LINE, calendarFile: "none", options: [], link: null }],
      fixedLines: [PASSED_ON],
      slotValues: [],
      threadReplyTo: null,
    },
  };
}

/** A copy of a reason, its three fields alone. */
const reasonCopy = (reason: ParkReason): ParkReason => ({
  from: reason.from,
  fault: reason.fault,
  ids: [...reason.ids],
});

/**
 * K-05 v1.23 parkTurn's request (`parkTurn.lineRequest`; park-turn-sam-refused-at-once.json for a final answer,
 * park-turn-maya-crash-with-line.json for a crash) for the turn on the try it reached, its handle's party, the time it is
 * parked and the final refusal's reason (null: a crash, on its third try).
 */
export function parkRequestOf(
  turn: ParkingTurn,
  party: TurnParty,
  handle: HandleRef,
  parkedAt: string,
  reason: ParkReason | null = null,
): ParkTurnLineRequest {
  const id = parkedRowId(turn.turnId);
  const channel: OutboxChannel = handle.kind === "email" ? "email" : "imessage";
  const row: ParkedRowNew = {
    id,
    recipientHandleId: party.handleId,
    recipientPersonId: party.personId,
    businessId: party.businessId,
    bookingId: null,
    channel,
    sendClass: "quick_reply",
    openQuestionId: null,
    copyOfRowId: null,
    versionsRead: [],
    ...parkedLineOf(id, channel),
  };
  const entry: EventEntry = {
    id: parkedEventId(turn.turnId),
    kind: "turn.parked",
    zone: null,
    businessId: party.businessId,
    actorKind: "rosie",
    actorPersonId: null,
    actorRole: null,
    tableName: "turns",
    rowId: turn.turnId,
    oldValues: null,
    newValues: { state: "parked", tries: turn.tries },
    sealed: null,
    why: reason === null ? { ...CRASHED_WHY } : { refused: reasonCopy(reason) },
    approvedBy: null,
    proofs: null,
  };
  return {
    turn: {
      id: turn.turnId,
      handleId: party.handleId,
      eventIds: [...turn.eventIds],
      bundleId: { hash: turn.bundleId.hash, build: turn.bundleId.build },
      traceId: turn.traceId,
      joinedTraceIds: [...turn.joinedTraceIds],
      tries: turn.tries,
    },
    parkedAt,
    ...(reason === null ? {} : { reason: reasonCopy(reason) }),
    outboxRows: [row],
    events: [entry],
  };
}

/** Sends parkTurn, once more when it answers transient or its answer is lost; with how many sends it took. */
async function sendPark(
  set: TurnDeps,
  request: ParkTurnLineRequest,
): Promise<{ read: ParkRead; sends: number }> {
  let read = notDone("noAnswer");
  let sends = 0;
  for (let sent = 1; sent <= PARK_SENDS; sent += 1) {
    sends = sent;
    let answer: unknown;
    try {
      answer = await set.rows.parkTurn(request);
    } catch {
      read = notDone("noAnswer");
      continue;
    }
    read = readPark(answer, request.turn.id);
    if (read.kind !== "notDone" || !RESEND_CODES.has(read.code)) break;
  }
  return { read, sends };
}

/**
 * The park, either way in (see the header): the turn parked through K-05 v1.23 parkTurn with its passedOn row, then the
 * dispatcher woken once for that row. Never throws for an outside failure: the answer says why the park was not done.
 */
async function parkWith(
  set: TurnDeps | null,
  turn: ParkingTurn,
  reason: ParkReason | null,
): Promise<ParkAnswer> {
  const span = turn.trace.start("lease");
  const got: SpanFacts = { texts: turn.entries.length, tries: turn.tries };
  // The reason's labels (K-08 safe ids, as K-05 checks them), for the span: never a value of the turn.
  const why: SpanFacts =
    reason === null
      ? { atOnce: false }
      : { atOnce: true, from: reason.from, fault: reason.fault, ids: [...reason.ids] };
  const end = (
    answer: ParkAnswer,
    facts: { party?: TurnParty; decided?: SpanFacts; rows?: RowRef[] } = {},
  ): ParkAnswer => {
    const code = "error" in answer && isLabel(answer.error) ? answer.error : null;
    const outcome: Outcome =
      code === null ? "ok" : FAILED_CODES.has(code) || code === "noDirectory" ? "failed" : "refused";
    const businessId = facts.party?.businessId;
    try {
      span.finish({
        outcome,
        ...(isLabel(businessId) ? { businessId } : {}),
        got,
        decided: { parked: code === null, ...why, ...facts.decided },
        rows: facts.rows ?? [],
        errorCode: code,
      });
    } catch {
      // No span for the park; what it did stands.
    }
    return answer;
  };

  if (set === null) return end({ error: "unwired" });
  // A crash parks on the third try alone; a final answer on the try the lease counted, 1 to 3.
  if (reason === null && turn.tries !== CRASHED_ON_TRY) return end({ error: "notThirdTry" });
  if (reason !== null && !TRIES.includes(turn.tries)) return end({ error: "badTry" });
  const first = turn.entries[0];
  if (first === undefined) return end({ error: "noTexts" });
  const handle = first.event.handle;
  let party: TurnParty | null;
  try {
    party = await set.directory.partyOf({ actorName: actorNameOf(handle), handle });
  } catch {
    return end({ error: "noDirectory" });
  }
  if (party === null) return end({ error: "unknownHandle" });

  const request = parkRequestOf(turn, party, handle, set.now(), reason);
  const { read, sends } = await sendPark(set, request);
  if (read.kind === "notDone") return end({ error: read.code }, { party, decided: { sends } });
  if (read.kind === "committed") {
    return end({ error: "alreadyCommitted", committedAt: read.committedAt }, { party, decided: { sends } });
  }

  // The row holds its words (K-05 checked it); the dispatcher sends it like any row, once (its parts' keys), however often
  // it is woken.
  let woken = false;
  if (read.rows.length > 0) {
    try {
      await set.dispatcher.wake(
        { turnId: turn.turnId, handleId: party.handleId, outboxRowIds: [...read.rows] },
        turn.trace,
      );
      woken = true;
    } catch {
      // Not taken: the row waits for the recipient's next dispatcher run (a later commit or park wake, an outage or
      // safety-line wake, or the retry door); no sweep runs.
    }
  }
  return end(
    { result: "parked", parkedAt: read.parkedAt, repeated: read.repeated },
    {
      party,
      decided: { repeated: read.repeated, woken, sends },
      rows: [{ table: "turns", id: turn.turnId }, ...read.rows.map((id) => ({ table: "outbox_rows", id }))],
    },
  );
}

/**
 * The lease's park hook (T-253; the ruling's card 7): parks the turn after its third lapse with no commit, on try 3 with
 * no reason and the outage path as its entry's `why`, its one row carrying the passedOn line, and wakes the dispatcher
 * once for that row. Never throws for an outside failure: the answer says why the park was not done, and the lease tries
 * again.
 */
export function parkThroughRows(set: TurnDeps | null, turn: ParkingTurn): Promise<ParkAnswer> {
  return parkWith(set, turn, null);
}

/**
 * The park at once (T-1552; K-09 v1.13 default 218; the ruling's card 6): parks the turn on the try the lease counted, 1
 * to 3, with a final answer's reason (its labels, field for field), its one row carrying the passedOn line, and wakes the
 * dispatcher once for that row. The caller (./turn.ts) parks only a turn that holds no stop word, and only on an answer
 * of a call made before the commit. Never throws for an outside failure.
 */
export function parkAtOnce(set: TurnDeps | null, turn: ParkingTurn, reason: ParkReason): Promise<ParkAnswer> {
  return parkWith(set, turn, reason);
}
