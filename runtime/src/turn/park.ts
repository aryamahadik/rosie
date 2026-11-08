// The park after a third crash before the commit (T-253; C-180; arch 11 'Crash in the middle of a turn', architecture.txt
// line 576: "A third crash before the commit parks the turn for Rosie's team, freeing the inbox for later texts; the
// person hears once that nothing changed and that Rosie's team will reply within 1 business day"). The lease
// (../actor/lease.ts) calls it as its `park` hook when a turn's third try lapses with no commit:
//
//   1. The handle's directory names the handle (K-04 handles.id), its person and its business, as for a run of the turn.
//   2. K-05 v1 parkTurn (item 12; park-turn.json), through the turn's K-05 face (`TurnDeps.rows`): the turn with tries 3,
//      when it was parked, its one "nothing changed" row and its event-log entry, written in one transaction. The row is
//      written with no plan (K-05 outboxRowNew): the runtime never composes or words that line. Its id is fixed by rule
//      from the turn id (`out-<turn id>-parked`), as is the entry's (`log-<turn id>-parked`, park-turn.json's form), so a
//      park sent again after a crash is K-05's repeat (`repeated`), never a second row. A transient answer, or one lost on
//      its way, is sent once more as the same request.
//   3. The dispatcher is woken once for that row, as after a commit; it sends the row like any other (limit 8 decides
//      about a stopped number). A repeated park wakes it again, which sends nothing twice: one row, one key per part.
//
// The answer goes back to the lease: parked (first or repeated), alreadyCommitted (the third run's commit went through,
// so the turn is never parked), or why the park could not be done now (a label), and the lease tries again later.
//
// Defaults (no source fixes them): the row goes to the handle the texts came from, on its own way (an email handle by
// email, a phone by iMessage first: RULES 4.8), as a quick reply (K-04 send class; Q-15: a reply in the same turn), about
// no booking and no question; the entry is Rosie's, with park-turn.json's outage path as its `why`. Never logged or put
// in a span: a text's words, a number, a key; the park's `lease` span holds labels, counts and ids only (K-08).
//
// Not here: the 'nothing changed' line's words (the row K-05 writes); K-37's parked_turns row for Rosie's team (its error
// summary, when the person was told, the reply's due time), which no K-05 v1 call takes; the team console (C-194).

import type { ParkAnswer, ParkingTurn } from "../actor";
import { actorNameOf, type HandleRef } from "../gateway/seal";
import { isLabel, type Outcome, type SpanFacts } from "../trace";
import type { RowRef } from "../trace/types";
import type { EventEntry, OutboxRowNew, ParkTurnRequest, TurnDeps, TurnParty } from "./types";

/** How many times parkTurn is sent in all when it answers transient or its answer is lost: the first send and one more. */
export const PARK_SENDS = 2;

/** The try a turn is parked on: K-05 v1 parkTurn's `turn.tries` is 3 (the lease's MAX_TRIES; arch 11 line 576). */
const PARKED_ON_TRY = 3;

/** The one "nothing changed" row's id, fixed by rule from the turn id: a park sent again names the same row. */
export const parkedRowId = (turnId: string): string => `out-${turnId}-parked`;

/** The park's event-log entry's id, fixed by rule from the turn id (park-turn.json's `log-<turn id>-parked`). */
export const parkedEventId = (turnId: string): string => `log-${turnId}-parked`;

/** The outage path the park's entry names (K-08 `why`; park-turn.json). */
const PARKED_WHY = { outage: "third crash before the commit" };

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

/** K-05 v1 parkTurn's answer for this turn; anything that is not the contract's is badAnswer. */
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

/** K-05 v1 parkTurn's request (park-turn.json's shape) for the turn, its handle's party and the time it is parked. */
export function parkRequestOf(
  turn: ParkingTurn,
  party: TurnParty,
  handle: HandleRef,
  parkedAt: string,
): ParkTurnRequest {
  const row: OutboxRowNew = {
    id: parkedRowId(turn.turnId),
    recipientHandleId: party.handleId,
    recipientPersonId: party.personId,
    businessId: party.businessId,
    bookingId: null,
    channel: handle.kind === "email" ? "email" : "imessage",
    sendClass: "quick_reply",
    openQuestionId: null,
    copyOfRowId: null,
    versionsRead: [],
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
    why: { ...PARKED_WHY },
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
    outboxRows: [row],
    events: [entry],
  };
}

/** Sends parkTurn, once more when it answers transient or its answer is lost; with how many sends it took. */
async function sendPark(set: TurnDeps, request: ParkTurnRequest): Promise<{ read: ParkRead; sends: number }> {
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
 * The lease's park hook: parks the turn through K-05 v1 parkTurn and wakes the dispatcher once for its row. Never throws
 * for an outside failure: the answer says why the park was not done, and the lease tries again.
 */
export async function parkThroughRows(set: TurnDeps | null, turn: ParkingTurn): Promise<ParkAnswer> {
  const span = turn.trace.start("lease");
  const got: SpanFacts = { texts: turn.entries.length, tries: turn.tries };
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
        decided: { parked: code === null, ...facts.decided },
        rows: facts.rows ?? [],
        errorCode: code,
      });
    } catch {
      // No span for the park; what it did stands.
    }
    return answer;
  };

  if (set === null) return end({ error: "unwired" });
  if (turn.tries !== PARKED_ON_TRY) return end({ error: "notThirdTry" });
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

  const request = parkRequestOf(turn, party, handle, set.now());
  const { read, sends } = await sendPark(set, request);
  if (read.kind === "notDone") return end({ error: read.code }, { party, decided: { sends } });
  if (read.kind === "committed") {
    return end({ error: "alreadyCommitted", committedAt: read.committedAt }, { party, decided: { sends } });
  }

  // The row is K-05's to word; the dispatcher sends it like any row, once (its parts' keys), however often it is woken.
  let woken = false;
  if (read.rows.length > 0) {
    try {
      await set.dispatcher.wake(
        { turnId: turn.turnId, handleId: party.handleId, outboxRowIds: [...read.rows] },
        turn.trace,
      );
      woken = true;
    } catch {
      // Not taken: the minute sweep claims every recipient's sendable rows.
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
