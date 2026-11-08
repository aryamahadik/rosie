// Data-access K-05 v1 item 12: park a turn after a third crash before its commit (T-197; C-152; K-05 README item 12;
// arch 11 line 576: "A third crash before the commit parks the turn for Rosie's team, freeing the inbox for later texts;
// the person hears once that nothing changed and that Rosie's team will reply within 1 business day"; K-37 v1
// parked_turns; QUESTIONS.md CQ-96). The runtime's park (runtime/src/turn/park.ts, TurnRows.parkTurn; joined at D-017)
// calls it; no Tool API path does.
//
// One transaction on the primary, on the runtime side (K-05 README "Scope": runtime; run as rosie_job, no business
// scope), writes all of it or nothing:
//   1. the turns row as parked, with tries 3 and parked_at (NQ-RT-3's default: a turn row is written once, as committed
//      or parked). Its id is the primary key, so a park sent again (a lost answer, the lease's retry) meets the first:
//      `insert ... on conflict (id) do nothing` waits for a park of the same id still in flight and then finds it. A
//      parked turn answers its first park (when, and its outbox rows by turn id in commit order) with repeated true,
//      whatever the repeat's body, and writes nothing; a committed turn answers alreadyCommitted: it is never parked.
//   2. K-37's parked_turns row for Rosie's team: open, with a plain, fixed error summary (default 1), the reply due 1
//      business day after the park (default 2), and when the person was told left empty (default 3).
//   3. the one "nothing changed" outbox row (at most one), with no plan, in K-04's first state, as the request gives it
//      (CQ-96 (a): the row as K-05's fixture writes it), under the turn's id, bundle and trace id, with commit_seq from
//      K-04's identity column; the runtime never words it.
//   4. the request's event-log entries, each under the turn's id, trace id and bundle, at parkedAt.
//
// Answers: parked (repeated or not), alreadyCommitted, or transient (a serialization failure, a deadlock or a lost
// connection: nothing was written, and the same request may be sent again). K-05 v1 gives parkTurn no other refusal, so
// a database rule that refuses a write (an outbox row id already taken, a handle that does not exist) throws
// DataAccessDatabaseError, carrying only the SQLSTATE and the names of the table and the constraint, and a request this
// call cannot carry out throws a TypeError; nothing is written either way.
//
// Nothing here logs. error_summary holds no value from the turn's sealed texts, nor any value the request carries: it is
// one fixed description (K-37 rule 4: plain descriptions only).
//
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. error_summary is PARKED_ERROR_SUMMARY, fixed: K-05 v1's parkTurn carries no error (QUESTIONS.md CQ-96 (b)), and
//      a fixed text can never hold a value from the sealed texts.
//   2. reply_due_at is 1 business day after parked_at in Rosie's team's zone, America/New_York (Q-54's default zone for
//      the team's day; Q-18: the team is Jay and the CTO), Monday to Friday, no holidays (K-37 open gap: the business-day
//      calendar): the next weekday at the same local time, so a Saturday park is due on Monday, as K-37's
//      seed-parked-turn shows.
//   3. person_told_at stays null at the park: the "nothing changed" row is written, not yet sent (who sets it once the
//      row goes out is a new question).
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.1";
import {
  checkEventEntry,
  checkOutboxRowNew,
  checkTurn,
  insertOutboxRow,
  instantOf,
  logEntryOf,
  outboxRowsOfTurn,
  transientOrScrubbed,
} from "./clocks";
import { appendEvent } from "./event-log";
import type { Sql } from "./scope";
import { assertRequestShape, inRuntimeTransaction, utc } from "./targets";

/** K-05 v1 parkTurn.request (park-turn.json): the turn with tries 3, when, the one row and its entries. */
export type ParkTurnRequest = K05.ParkTurnRequest;
/** K-05 v1 parkTurn.response: parked; a repeat writes nothing and answers the first park with repeated true. */
export type ParkTurnResponse = K05.ParkTurnResponse;
/** K-05 v1 parkTurn.errors: the turn committed (never parked), or transient (nothing written). */
export type ParkTurnError = K05.AlreadyCommittedError | K05.TransientError;
export type ParkTurnOutcome = ParkTurnResponse | ParkTurnError;

/** The parked turn's error for Rosie's team: plain and fixed, never a value of the turn or the request (default 1). */
export const PARKED_ERROR_SUMMARY =
  "Crashed three times before the commit (try 3 of 3); nothing was committed";

/** The zone Rosie's team's business days are counted in (default 2). */
export const TEAM_ZONE = "America/New_York";

const PARK = "parkTurn";

/** What code checks before the database is reached; returns parkedAt. */
function checkPark(request: ParkTurnRequest): Date {
  assertRequestShape(request, PARK, ["turn", "parkedAt", "outboxRows", "events"]);
  const raw = request as unknown as Record<string, unknown>;
  checkTurn(PARK, raw.turn, 3);
  const parkedAt = instantOf(PARK, raw.parkedAt, "parkedAt");
  const { outboxRows, events } = raw;
  if (!Array.isArray(outboxRows) || outboxRows.length > 1) {
    throw new TypeError(`${PARK}: outboxRows is a list of at most one row (the one "nothing changed" line)`);
  }
  outboxRows.forEach((row: unknown) => {
    checkOutboxRowNew(PARK, row);
  });
  if (!Array.isArray(events)) {
    throw new TypeError(`${PARK}: events is not a list`);
  }
  events.forEach((entry: unknown) => {
    checkEventEntry(PARK, entry);
  });
  return parkedAt;
}

/** A turn id met again: its first park, or alreadyCommitted; nothing is written. */
async function repeatOf(tx: Sql, turnId: string): Promise<ParkTurnOutcome> {
  const [turn] = await tx<{ state: string; committed_at: Date | null; parked_at: Date | null }[]>`
    select state, committed_at, parked_at from turns where id = ${turnId}
  `;
  if (turn?.state === "committed" && turn.committed_at !== null) {
    return { error: "alreadyCommitted", turnId, committedAt: utc(turn.committed_at) };
  }
  if (turn?.state !== "parked" || turn.parked_at === null) {
    throw new Error("parkTurn: the turn id is taken by a turn that is neither parked nor committed");
  }
  return {
    result: "parked",
    turnId,
    parkedAt: utc(turn.parked_at),
    outboxRows: await outboxRowsOfTurn(tx, turnId),
    repeated: true,
  };
}

/** The whole park inside the transaction `tx` (the runtime side, no scope). */
async function parkIn(tx: Sql, request: ParkTurnRequest, parkedAt: Date): Promise<ParkTurnOutcome> {
  const { turn } = request;
  const inserted = await tx<{ id: string }[]>`
    insert into turns (
      id, handle_id, event_ids, state, bundle_hash, bundle_build, trace_id, joined_trace_ids, tries, parked_at
    ) values (
      ${turn.id}, ${turn.handleId}, ${turn.eventIds}, 'parked', ${turn.bundleId.hash}, ${turn.bundleId.build},
      ${turn.traceId}, ${turn.joinedTraceIds}, ${turn.tries}, ${parkedAt}
    )
    on conflict (id) do nothing
    returning id
  `;
  if (inserted.length === 0) {
    return repeatOf(tx, turn.id);
  }

  // K-37's row for the team: the next weekday at the same local time in the team's zone (default 2).
  await tx`
    insert into parked_turns (turn_id, error_summary, person_told_at, reply_due_at)
    select ${turn.id}, ${PARKED_ERROR_SUMMARY}, null,
           (parked.local + case extract(isodow from parked.local)
                             when 5 then interval '3 days'
                             when 6 then interval '2 days'
                             else interval '1 day'
                           end) at time zone ${TEAM_ZONE}::text
    from (select ${parkedAt}::timestamptz at time zone ${TEAM_ZONE}::text as local) as parked
  `;

  const outboxRows: K05.OutboxRowWritten[] = [];
  for (const row of request.outboxRows) {
    outboxRows.push(await insertOutboxRow(tx, turn, row));
  }
  const context = {
    turnId: turn.id,
    traceId: turn.traceId,
    bundle: { hash: turn.bundleId.hash, build: turn.bundleId.build },
  };
  for (const entry of request.events) {
    await appendEvent(tx, context, logEntryOf(entry, parkedAt));
  }
  return { result: "parked", turnId: turn.id, parkedAt: utc(parkedAt), outboxRows, repeated: false };
}

/**
 * Parks a turn after a third crash before its commit (K-05 v1 item 12; arch 11 line 576): one transaction on the
 * primary, on the runtime side. Pass the client's primary handle, run as rosie_job. Answers parked (repeated true for a
 * turn already parked, which writes nothing), alreadyCommitted (the turn committed: it is never parked) or transient.
 * Throws for a request it cannot carry out, a database refusal as DataAccessDatabaseError; nothing is written then
 * either.
 */
export async function parkTurn(sql: Sql, request: ParkTurnRequest): Promise<ParkTurnOutcome> {
  const parkedAt = checkPark(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: false }, (tx) => parkIn(tx, request, parkedAt));
  } catch (error) {
    return transientOrScrubbed(PARK, error);
  }
}
