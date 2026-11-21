// Data-access K-05 v1.1 item 1: commit a turn, all or nothing, once per turn id (T-195; DL-136; K-05 README items 1, 18
// and 19; arch 01 lines 39 to 41; arch 02 line 121; arch 10 line 508; arch 04 line 223: gate and commit within 300 ms).
// The gate has passed limits 1 to 6; commitTurn writes what the turn decided in one transaction on the primary, or
// nothing at all. A v1 request is a v1.1 request (its two v1.1 lists left out), so K-05 v1's exchanges hold unchanged.
//
//   1. The turn row, as committed (QUESTIONS.md NQ-RT-3's default: written once). Its id is the primary key, so a repeat
//      (a lost reply, a rerun) meets the first commit's row: `insert ... on conflict (id) do nothing` waits for a commit
//      of the same id still in flight and then finds it. A committed turn answers its first commit (turn id, time and its
//      outbox rows by turn id in commit order; written and promoted empty, since K-04 keeps no copy of a result) with
//      repeated true, whatever the repeat's body; a parked turn answers turnParked. A repeat writes nothing.
//   2. The locks, then the compares, before any other write: the saved-time clock rows of the reservations it confirms
//      or releases (so the commit takes a clock row before its reservation, as a firing does), the slot locks of the
//      reservations it releases (reservations.ts's order: the slot before the row), then every row it compares, once
//      each, in (table, row id) order: a row it writes FOR UPDATE, a row it only read FOR SHARE. A reservation to confirm
//      that is not held, or is held past its held_until, refuses the commit with reservationLost (limit 5, checked before
//      its version: arch 06 line 307); then any version that moved refuses it with versionChanged, every changed row
//      listed (limit 4: arch 06 line 305); then an effect let go that is not in outage refuses it with wrongState; then a
//      state update that would move a row of a business to another business, or to none, where row-level security does
//      not hold the row there, throws (default 16).
//   3. The writes, in K-05's order: state writes (an update raises the version by one); open questions opened (waiting)
//      or closed; clock rows made (waiting, or armed with their due time) or cancelled; outbox rows with no plan (K-04's
//      first state; commit_seq from the identity column, so commit order is the database's); reservations confirmed
//      (booked, with the booking, and the saved-time clock row cancelled) or released (as release does, promotion
//      included: db/repo/reservations.ts releaseIn); then K-05 v1.1's effects (written pending under the turn's id, and
//      outage rows let go) and waiting rows (superseded or withdrawn, each with its own event-log entry); then the
//      request's event-log entries, each under the turn id, its trace id and its bundle. A K-36 state write that names a
//      clock row or an outbox row this commit makes waits for it, right after the outbox rows (default 17; T-1442).
//   4. The answer: every row inserted or updated with its version after the commit (turn, outbox and event-log rows
//      left out, and rows of a table with no version, which a row reference cannot name), the outbox rows in commit
//      order, the next in line its releases promoted, and the waiting rows it ended. Each row it names (written, and
//      versionChanged's changed rows) is named by its primary key, save a phones row when the request asks for its
//      handle id (below).
//
// A phones row in the answer (T-1417; K-05 v1.17 item 71 and defaults 145 to 151; DL-872, DL-876, DL-877): K-08 v1
// names a phone row by its handle id (phones.handle_id, unique and not null in K-04), never by its number
// (contracts/event-trace/README.md lines 42 and 263), and the turn's span copies the rows this call answers
// (actions/src/commit/commit.ts spanRowsOf). A request that carries answerPhoneRowsBy "handleId" is answered with
// every row reference naming a phones row by the handle id of the row itself, as the commit locked it (versionChanged)
// or as its write returned it (written), never by a second read, and a phones row with no handle id, or an empty one,
// throws (fail closed): the number is never answered in its place. A request without the field is answered as v1.16
// answers it, byte for byte (a phones row by its number), by v1.16's own statements. Either way nothing changes inside
// the commit: a request still names a phones row by its primary key, the number (a state write's key, versionsRead),
// and the lock, the compare and the write use it; an answered handle id passed back where a request names a phones row
// names no row, so the call throws and writes nothing (default 1).
//
// A question asked again (T-1509; K-05 v1.21 item 81 and defaults 192 to 199; DL-1030, DL-1045): a request whose
// writes.openQuestions holds askAgain raises one live open question's ask count by one, with the turn's other writes.
// checkRequest takes exactly one raise, its id and the version the turn read and no other field, with close empty, or
// throws before the database is reached, naming the field alone (default 194; db/repo default 1). The question is locked
// FOR UPDATE beside the closes and compared as an update (versionChanged, limit 4); then it must be live, waiting or open,
// else wrongState with its status now, after an effect let go's (default 193). After the questions opened and closed, its
// ask_count and version are each raised by one at the version read while it is live (default 192), and nothing else of it
// moves (default 195); written names it at its new version, after the opens and closes (default 198). Its
// open_question.asked_again entry is the request's own, written with the other entries (default 196). A request with no
// askAgain runs statement for statement as before, and keeps v1.20's answer type: commitTurn's overloads give v1.21's
// errors only to a request typed with askAgain given (default 199). A firing raises nothing: clocks.ts's checkFire throws
// on one that carries askAgain (default 199).
//
// A row's own step and line (T-1476; K-05 v1.22 item 82 and defaults 206 to 213; K-04 core v1.2, migration 0039; DL-999,
// DL-1073): each writes.outboxRows item may name step, the K-01 step whose line the row carries to its reader, and lineNo,
// that line's index, both or neither. checkRequest takes both left out, or both given with the step in K-01's step id form
// and the line an integer from 0 that the column holds, or throws before the database is reached, naming the field alone
// (default 206; db/repo default 1; default 18 below): never written half, and never answered constraint. writeOutboxRows
// inserts them as outbox_rows.step and line_no in the insert that writes the row's other columns, each the request's
// value or null, so a row that names neither holds both null as before. Nothing else changes: no read, lock, compare,
// entry or field of the answer. The step is not checked against the turn's bundle, the line against the step's lines, or
// a row's step against its question's (defaults 208 and 209: the walk's, T-1479). A firing's rows are clocks.ts's and
// carry neither (default 211).
//
// Scope (K-05 README "Scope": per write; T-191's roles): the call runs on the runtime side, as rosie_job, in one read
// committed transaction that starts with no business scope. Before each write the scope is set to that write's own
// business (set_config(..., true)), so row-level security holds each write to its business, and a turn touching two
// businesses' rows never writes a third's: a row the request names takes its business from the request, a row the commit
// updates takes it from the row as locked; a write with no business, and a table with no row-level security (turns,
// handles, phones, persons, threads, consents with no business), goes on the runtime side. The compares, the search for
// waiting rows and a repeat's outbox rows read on the runtime side, where every business's rows are seen.
//
// Refusals write nothing: the transaction rolls back. A database rule that refuses a write (EXCLUDE 23P01, CHECK 23514,
// unique 23505, foreign key 23503) answers constraint with the SQLSTATE and the constraint's name only; a serialization
// failure, a deadlock or a lost connection answers transient (the same request may be sent again); anything else
// (a request this layer cannot carry out, a row it names that does not exist) throws, and nothing is written either.
//
// Nothing here logs. What it throws names a call, a table, a column or a fault, never a value or a row id (a phone's row
// id is its number); a refusal never carries PostgresError.detail (STATE's notes for later cards, 3).
//
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. A row the request names (a version read or a write's row) that does not exist throws: K-05's errors have no
//      answer for it (versionChanged needs the version now), and rows that carry a version are never deleted.
//   2. `written` keeps the order of the writes: state, open questions opened then closed, clock rows made then cancelled,
//      the state writes that waited for them (default 17), reservations confirmed (each with its saved-time clock row)
//      then released (each with its class seats, its saved-time clock row, the promoted row and the promoted row's clock
//      row), effects written then let go.
//   3. A confirm or a release cancels the reservation's saved-time clock row only while it is waiting or armed; a
//      cancelled or fired one stays as it is and is not listed.
//   4. The promoted next in line gets its saved-time clock row here (K-05 item 9: "with its own saved-time clock row"),
//      as item 8 makes one: armed, due at held_until in the business's zone (CQ-05), owned by the mobile's handle or
//      else by the sweep, firing {"release": <id>, "why": "expired"}.
//   5. A waiting row's entry (item 19) carries the row's business and that business's zone (null, UTC, with none); its
//      why is {"followUp": "chatOpenAnswer", "supersededBy": <answer row>} or {"closedBooking": <id>} or
//      {"closedQuestion": <id>}, in the style of K-05 v1.1's follow-up entries (dispatcher-gives-up.json's followUpOf).
//   6. A repeat leaves waitingChat out of its answer: it ended no waiting row.
//   7. The changed rows are listed once per (table, row, version read), the versions read first, then the writes, in
//      the request's order.
//   8. A state write to K-07's tables (effects, provider_events, outbox_claims) is refused as the schema refuses
//      K-04's: each has its own list or call (stateTable: "except those the commit writes through their own lists").
//   9. A calendar effect with no provider answers constraint effects_calendar_keyed: the frozen CHECK lets a null
//      provider through (null in (...) is unknown), so code holds the rule until K-07's minor version (CQ-76, DL-132).
//  10. Every time the commit writes (committed_at, closed_at, cancelled_at, armed_at, released_at, an effect's
//      created_at, each entry's at) is one moment, the transaction's now() (the test's clock when given).
//  11. A state write's value for a bytea column (a sealed value, such as safety_outcomes.sealed_words or a pause's
//      address) is K-04's text form, "\x" and hex digit pairs, and is written as the bytes it spells (bytea.ts; T-1185):
//      postgres.js would store a string's own characters. A value in any other form throws, and nothing is written.
//  12. answerPhoneRowsBy left out answers as v1.16 and "handleId" as K-05 v1.17 item 71; any other value (null, a
//      boolean, another spelling) throws before the database is reached, naming the field alone, so a request that
//      means to ask is never answered with a number in silence (fail closed).
//  13. A table the answer names by a column other than its primary key (phones, by handle_id, when the request asks)
//      that has no such column throws; its rows are never answered by their primary key instead.
//  14. (T-667) A two-column key's version read is compared under the businesses the commit writes: those its request
//      names (a state insert's business, an open question's, a clock row's, an outbox row's, an effect's, an event's),
//      those of the rows it updates, as they stand before its locks, and the business a state update gives a row that
//      has none, a write with no business naming none. So the name finds a row of one of those businesses, or a row with
//      no business when one of those writes has none or the commit writes no business's row at all (a sign-up's turns,
//      and S1-09's, which moves rows with no business to the new one), and never another business's row. A table scoped
//      none (kind_flows) has no business to compare.
//  15. (T-667) K-22's sessions and K-27's calendar_links, which row-level security binds by person and which have no
//      business column, are written on the runtime side, where their runtime policies give rosie_job every row: K-22
//      rule 5 has the commit end someone else's sessions there (left, handed_over), and K-27 rule 5 has it write a
//      link's connect start and an unlink there.
//  16. (T-667 round 2; DL-925 item 8d) A state update never moves a row of a business to another business or to none;
//      one that gives a row with no business its business stays allowed (S1-09). Where row-level security holds the row
//      to its business (a rosie_job policy that compares business_id with the scope, which the commit sets to the row's
//      own business before its update), the update is refused there, 42501 with nothing written, as before
//      (commit-turn.int.test.ts's booking moved to another business). Where it does not (BUSINESS_UNHELD_TABLES, whose
//      rosie_job policy is true: K-22 proof_codes and K-27 busy_blocks; and a table with a business_id column and no
//      row-level security), the commit throws on the row as locked, after the compares and before any write.
//  17. (T-1442; DL-930, DL-936) K-36 v1's three foreign keys from a state row to a clock row or an outbox row are not
//      deferrable (0017: hand_offs_alert_outbox_fk, hand_offs_clock_fk, team_pages_clock_fk), so each is checked at the
//      state row's own write, and K-36 rule 5 has a hand-off's alert written in the same commit. So a hand_offs or
//      team_pages write (an insert's values or an update's set) whose alert_outbox_row_id, escalation_clock_row_id or
//      next_page_clock_row_id names a row this commit makes (clockRows.make, outboxRows) waits: it is written right after
//      the outbox rows, before the reservations and the effects, and so is every hand_offs and team_pages write after it,
//      in the request's order (a page after the hand-off it points at: team_pages_hand_off_fk). Every other write keeps
//      K-05 item 1's order, where the clock and outbox rows find what they name (a booking, a person, an open question).
//      A request with no such write is written statement for statement as before, and one with such a write failed
//      before (23503, or 23505 for a made row's id already taken), so nothing that committed before changes. K-05 item 1
//      orders the turn row, then the locks and compares, then the writes, in one transaction; the outbox rows keep their
//      commit order, and the effects still follow every state write (item 18).
//  18. (T-1476) A row's lineNo above 2147483647, the largest value K-04's integer line_no holds, throws in checkRequest
//      with the other malformed lines (K-05 v1.22 default 207 sets no upper bound; the database engineer's note 1 on
//      T-1474): the insert would fail with 22003, which is no constraint's answer, so the call would throw anyway, and
//      this way it throws before any statement, as item 82 has every malformed line do. A step or lineNo given as
//      undefined is left out, as a JSON request can only leave it out; given as null it is malformed (default 206: left
//      out, never null).
//
// The setup tables (T-667; K-05 v1.18 item 77; DL-867, DL-911, DL-913): the state writes take every setup part's table
// (K-22 to K-27, K-33, K-35) as any other domain table, an update naming the version it read. A table whose primary key is
// two columns (K-23 company_kinds and flow_defaults, K-24 kind_flows, picked_kind_texts and new_work_draft_blocks) names
// its row by item 77's name, the key's values joined by "/" in key order (setup/row-names.ts), which the database builds:
//   - a state insert answers the row by the name its `returning` builds from the row's own columns;
//   - a state update names the row by its key, column to value (K-05 v1 stateWrite), and is found by those columns; the
//     name it is locked, compared and answered by is the one the database builds for that row, read before the locks;
//   - a version read names the row by its name, which the SQL compares whole with the row's own name, never splitting the
//     rowId (CQ-09), with business_id one of the businesses the commit writes, or null where one of its writes has no
//     business (default 14; T-1427's security reviewer's N2, DL-913), so another business's name finds no row and the
//     commit throws (default 1, fail closed), and the compare is narrowed by the business, through its index where the
//     table has one (T-1427's database engineer's N3: company_kinds_business_idx, picked_kind_texts_business_idx,
//     flow_defaults' own key);
//   - versionChanged names a changed row by its name.
// A table of one key column is named, locked, compared and answered as before, by the same statements.
//
// One reading for both writers (T-1437; DL-927, DL-935): clocks.ts's fireClock commits a firing's writes as this file
// commits a turn's, and reads each table (tableInfo), names its key (oneKey, stateUpdateTarget), finds and locks each row
// (lockRow), reads the businesses a two-column version read is compared under (comparedBusinesses) and refuses a move
// (refuseBusinessMoves) by these exported helpers, through RowWriter, so the two writers take the same targets and never
// drift. A helper's error starts with its writer's name. A firing's row of a table scoped none must also meet
// setup/fact-homes.ts rowBound, the one rule every reader of a setup row by its name calls, passed to lockRow as `bound`
// (clocks.ts); commitTurn passes none, so what it accepts is unchanged.
import type postgres from "postgres";
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.1";
import type * as K05v117 from "../../contracts/generated/data-access/data-access.v1.17";
import type * as K05v121 from "../../contracts/generated/data-access/data-access.v1.21";
import type * as K05v122 from "../../contracts/generated/data-access/data-access.v1.22";
import { byteaFromText } from "./bytea";
import { appendEvent, type EventEntry as LogEntry } from "./event-log";
import { releaseIn } from "./reservations";
import { assertBusinessId, SCOPE_SETTING, type Sql } from "./scope";
import { isNamedKey, rowNameSql, twoColumnKeyOf } from "./setup/row-names";
import { inRuntimeTransaction, transientOrThrow, utc } from "./targets";

/**
 * K-05 v1.22 outboxRowNew (README item 82; T-1476): v1's ten fields, and the row's own step and lineNo, both or neither
 * (checkRequest holds the rule the generated type leaves out). Left out, the row is v1's.
 */
export type OutboxRowNew = K05v122.OutboxRowNew;

/**
 * K-05 v1.1 commitTurn.request (the turn row, the versions read and every write), with K-05 v1.17's optional
 * answerPhoneRowsBy (item 71), which changes only what the call answers, and its outbox rows v1.22's (item 82; T-1476),
 * each of which may name its step and line. Without answerPhoneRowsBy the request is v1.16's; a request whose rows name
 * no step is v1.21's, so every caller's v1.1 request is one of these unchanged.
 */
export type CommitTurnRequest = Omit<K05.CommitTurnRequest, "writes"> & {
  writes: Omit<K05.CommitTurnRequest["writes"], "outboxRows"> & { outboxRows: OutboxRowNew[] };
} & Pick<K05v117.CommitTurnRequest, "answerPhoneRowsBy">;
/** K-05 v1.1 commitTurn.response: committed; a repeated turn id answers the first commit with repeated true. */
export type CommitTurnResponse = K05.CommitTurnResponse;
/** K-05 v1.1 commitTurn.errors: refused, nothing written. */
export type CommitTurnError = K05.CommitTurnErrors;
export type CommitTurnOutcome = CommitTurnResponse | CommitTurnError;

/**
 * K-05 v1.21 commitTurn.request with writes.openQuestions.askAgain given (README item 81; T-1509): the turn asks one open
 * question again, its ask count raised by one. Only a request typed so may answer v1.21's errors (default 199). Typed at
 * v1.22, which restates v1.21's request with the raise kept (README item 82; T-1476), so the row that asks the question
 * again may name its step and line; a v1.21 request is one of these unchanged.
 */
export type CommitTurnAskAgainRequest = K05v122.CommitTurnRequest & {
  readonly writes: { readonly openQuestions: { readonly askAgain: [K05v122.OpenQuestionAskAgain] } };
};
/** K-05 v1.21 commitTurn.errors: v1.1's, and wrongState for an open question asked again that is not live. */
export type CommitTurnAskAgainError = K05v121.CommitTurnErrors;
export type CommitTurnAskAgainOutcome = CommitTurnResponse | CommitTurnAskAgainError;

/**
 * A request that raises no question (writes.openQuestions.askAgain left out): v1.20's call, whose answer is v1.20's
 * (README item 81; default 199), so a value typed with a raise never takes this answer type.
 */
interface RaisesNothing {
  readonly writes: { readonly openQuestions: { readonly askAgain?: undefined } };
}

/** The open question a request asks again, as checkRequest checked it (README item 81). */
interface Raise {
  readonly id: string;
  readonly expectVersion: number;
}

export interface CommitOptions {
  /** The commit's moment (K-05 `given.now`, the test's fake clock). Default: the transaction's now() on the database. */
  now?: Date;
}

type Json = Parameters<Sql["json"]>[0];
type Row = Record<string, unknown>;
/** An optional field of event-log.ts's entry as this call always gives it: present, a value or null. */
type Given<T> = Exclude<T, undefined>;
type ChangedRow = K05.ChangedRow;
type RowRef = K05.RowRef;
type Promotion = K05.Promotion;
type LostReservation = K05.ReservationLostError["reservations"][number];

/**
 * The tables a state write never names: K-05 v1 stateTable's list (each has its own list in the request, or is written
 * once by a call of its own), and K-07's three tables, which v1.1 gives their own lists and calls (default 8).
 */
export const NOT_STATE_TABLES: ReadonlySet<string> = new Set([
  "turns",
  "open_questions",
  "clock_rows",
  "outbox_rows",
  "outbox_parts",
  "reservations",
  "class_seats",
  "event_log",
  "bundles",
  "bundle_values",
  "sealing_keys",
  "effects",
  "provider_events",
  "outbox_claims",
]);

/**
 * The setup parts' tables that row-level security binds by person, with no business column, and whose runtime policy
 * gives rosie_job every row (K-22 v1 rule 5's sessions, which the commit ends for someone else; K-27 v1 rule 5's
 * calendar_links, which the commit starts connecting and unlinks): written on the runtime side (default 15; T-667).
 */
const PERSON_BOUND_TABLES: ReadonlySet<string> = new Set(["sessions", "calendar_links"]);

/**
 * The tables with a business whose rosie_job policy is `using (true) with check (true)` (0020 proof_codes_runtime, 0024
 * busy_blocks_runtime): under the row's own scope, row-level security does not hold such a row to its business when the
 * commit updates it, so the commit refuses a move itself (default 16; T-667 round 2). The setup tests hold this list to
 * the catalog's policies.
 */
export const BUSINESS_UNHELD_TABLES: ReadonlySet<string> = new Set(["busy_blocks", "proof_codes"]);

/** A database rule that refuses a write answers `constraint` (K-05 README item 1). */
const CONSTRAINT_SQLSTATES = new Set(["23P01", "23514", "23505", "23503"]);
const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const BUNDLE_HASH = /^[0-9a-f]{64}$/;
const CLOCK_KINDS = new Set(["question", "never_delivered", "saved_time", "step", "job"]);
const CALENDAR_PROVIDERS = new Set(["google", "microsoft"]);
/** K-01 v1's stepId form (K-05 v1.22 outboxRowNew.step), as K-04 v1.2's outbox_rows_step_form holds it (0039). */
const STEP_ID = /^[SAB](1[0-3]|[1-9])-x?[0-9]{2,3}$/;
/** The largest line index K-04 v1.2's line_no holds (PostgreSQL's integer): a larger one is refused (default 18). */
const MAX_LINE_NO = 2_147_483_647;

/** Thrown inside the transaction to roll it back and answer one of K-05's refusals. */
class Refused extends Error {
  readonly answer: CommitTurnAskAgainError;

  constructor(answer: CommitTurnAskAgainError) {
    super("commitTurn refused");
    this.answer = answer;
  }
}

// ---- request checks: what the database cannot be trusted to refuse, or what reaches SQL as a name -------------------

/**
 * The two writers of a turn's state rows: commitTurn here, and clocks.ts's fireClock, whose firing reads, names, finds,
 * locks and compares its rows by this file's helpers below (T-1437).
 */
export type WriterCall = "commitTurn" | "fireClock";

/** A request the writer `call` cannot carry out, named by that call (commitTurn unless a shared helper names another). */
function fail(what: string, call: WriterCall = "commitTurn"): never {
  throw new TypeError(`${call}: ${what}`);
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertName(value: unknown, what: string, call?: WriterCall): asserts value is string {
  if (typeof value !== "string" || !NAME.test(value)) {
    fail(`${what} is not a plain lower-case SQL name`, call);
  }
}

function assertId(value: unknown, what: string, call?: WriterCall): asserts value is string {
  if (typeof value !== "string" || value === "" || value.includes("\u0000")) {
    fail(`${what} is not a non-empty id`, call);
  }
}

function assertNullableId(value: unknown, what: string, call?: WriterCall): asserts value is string | null {
  if (value !== null) {
    assertId(value, what, call);
  }
}

function assertVersion(value: unknown, what: string, call?: WriterCall): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail(`${what} is not a version (a positive integer)`, call);
  }
}

function idField(record: Row, field: string, what: string): string {
  const value = record[field];
  assertId(value, `${what}.${field}`);
  return value;
}

function nullableIdField(record: Row, field: string, what: string): string | null {
  const value = record[field];
  assertNullableId(value, `${what}.${field}`);
  return value;
}

function objectField(record: Row, field: string, what: string): Row {
  const value = record[field];
  if (!isRecord(value)) {
    fail(`${what}.${field} is not an object`);
  }
  return value;
}

function listOf(record: Row, field: string, what: string): unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    fail(`${what}.${field} is not a list`);
  }
  return value as unknown[];
}

function checkTurn(turn: Row): void {
  idField(turn, "id", "turn");
  idField(turn, "handleId", "turn");
  idField(turn, "traceId", "turn");
  const eventIds = listOf(turn, "eventIds", "turn");
  if (eventIds.length === 0) {
    fail("turn.eventIds is empty: a turn joins at least one text");
  }
  eventIds.forEach((id) => {
    assertId(id, "turn.eventIds[]");
  });
  listOf(turn, "joinedTraceIds", "turn").forEach((id) => {
    assertId(id, "turn.joinedTraceIds[]");
  });
  const bundle = objectField(turn, "bundleId", "turn");
  if (typeof bundle.hash !== "string" || !BUNDLE_HASH.test(bundle.hash)) {
    fail("turn.bundleId.hash is not 64 lower-case hex characters");
  }
  assertVersion(bundle.build, "turn.bundleId.build");
  const tries = turn.tries;
  if (tries !== 1 && tries !== 2 && tries !== 3) {
    fail("turn.tries is not 1, 2 or 3");
  }
}

/**
 * K-05 v1.21's raise (README item 81; T-1509): writes.openQuestions.askAgain left out (null: the call is v1.20's,
 * statement for statement), or a list of exactly one raise, its id and the version the turn read and no other field, with
 * openQuestions.close empty. Anything else throws before the database is reached, naming the field alone (default 194;
 * db/repo default 1): a second raise, or a raise beside a close, contradicts itself, and no reload cures it.
 */
function raiseOf(questions: Row): Raise | null {
  if (questions.askAgain === undefined) {
    return null;
  }
  const [raise, ...more] = listOf(questions, "askAgain", "writes.openQuestions");
  if (raise === undefined || more.length > 0) {
    fail("writes.openQuestions.askAgain does not hold exactly one raise (K-05 v1.21 default 194)");
  }
  if (!isRecord(raise) || Object.keys(raise).some((field) => field !== "id" && field !== "expectVersion")) {
    fail("writes.openQuestions.askAgain[] is not a raise: an id and an expectVersion alone");
  }
  assertId(raise.id, "writes.openQuestions.askAgain[].id");
  assertVersion(raise.expectVersion, "writes.openQuestions.askAgain[].expectVersion");
  if (listOf(questions, "close", "writes.openQuestions").length > 0) {
    fail("writes.openQuestions.close is not empty beside askAgain (K-05 v1.21 default 194)");
  }
  return { id: raise.id, expectVersion: raise.expectVersion };
}

/**
 * K-05 v1.22's line of an outbox row (README item 82; T-1476): step and lineNo both left out (the row is v1.21's and
 * holds both null), or both given, the step in K-01's step id form and the line an integer from 0 that line_no holds.
 * One without the other, or either malformed, throws before the database is reached, naming the field alone (default
 * 206; db/repo default 1; default 18), so a row is never written half and never answered constraint.
 */
function checkRowLine(row: Row): void {
  const named = row.step !== undefined;
  if (named !== (row.lineNo !== undefined)) {
    fail(
      named
        ? "an outbox row names step without lineNo: both or neither (K-05 v1.22 default 206)"
        : "an outbox row names lineNo without step: both or neither (K-05 v1.22 default 206)",
    );
  }
  if (!named) {
    return;
  }
  if (typeof row.step !== "string" || !STEP_ID.test(row.step)) {
    fail("writes.outboxRows[].step is not a K-01 step id");
  }
  const line = row.lineNo;
  if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 0 || line > MAX_LINE_NO) {
    fail("writes.outboxRows[].lineNo is not a line index (an integer from 0 to 2147483647)");
  }
}

/**
 * What code checks before the database is reached (the schema's rules this layer relies on, and every name that reaches
 * SQL as an identifier), so a malformed request writes nothing and touches nothing. Answers the raise a v1.21 request
 * carries (raiseOf), or null.
 */
function checkRequest(request: CommitTurnRequest): Raise | null {
  const raw: unknown = request;
  if (!isRecord(raw)) {
    fail("the request is not an object");
  }
  if (raw.answerPhoneRowsBy !== undefined && raw.answerPhoneRowsBy !== "handleId") {
    // Default 12: an ask in any other spelling is refused, never read as no ask (fail closed).
    fail('answerPhoneRowsBy is neither left out nor "handleId"');
  }
  checkTurn(objectField(raw, "turn", "request"));
  for (const ref of listOf(raw, "versionsRead", "request")) {
    if (!isRecord(ref)) {
      fail("versionsRead[] is not a row reference");
    }
    assertName(ref.table, "versionsRead[].table");
    assertId(ref.rowId, "versionsRead[].rowId");
    assertVersion(ref.version, "versionsRead[].version");
  }
  const writes = objectField(raw, "writes", "request");
  const pairs = [
    ["openQuestions", "open", "close"],
    ["clockRows", "make", "cancel"],
    ["reservations", "confirm", "release"],
  ] as const;
  for (const [group, first, second] of pairs) {
    const lists = objectField(writes, group, "writes");
    listOf(lists, first, `writes.${group}`);
    listOf(lists, second, `writes.${group}`);
  }
  const raise = raiseOf(objectField(writes, "openQuestions", "writes"));
  listOf(writes, "outboxRows", "writes");
  listOf(writes, "events", "writes");
  if (writes.effects !== undefined) {
    const effects = objectField(writes, "effects", "writes");
    listOf(effects, "write", "writes.effects");
    listOf(effects, "letGo", "writes.effects");
  }
  for (const write of listOf(writes, "state", "writes")) {
    if (!isRecord(write)) {
      fail("a state write is not an object");
    }
    assertName(write.table, "a state write's table");
    if (NOT_STATE_TABLES.has(write.table)) {
      fail(`a state write may not name ${write.table}: the commit writes it through its own list or call`);
    }
    if (write.op === "update") {
      assertVersion(write.expectVersion, "a state update's expectVersion");
      objectField(write, "key", "a state update");
      if (Object.hasOwn(objectField(write, "set", "a state update"), "version")) {
        fail("a state update may not set the version: the update raises it");
      }
    } else if (write.op === "insert") {
      objectField(write, "values", "a state insert");
    } else {
      fail("a state write is neither an insert nor an update");
    }
  }
  for (const row of request.writes.outboxRows) {
    if (Object.hasOwn(row, "plan") || Object.hasOwn(row, "finalParts")) {
      fail("an outbox row at the commit carries no plan: words are written into it after the commit");
    }
    checkRowLine(row as unknown as Row);
  }
  if (writes.waitingChat !== undefined) {
    const waiting = objectField(writes, "waitingChat", "writes");
    listOf(waiting, "withdrawForBookings", "writes.waitingChat");
    listOf(waiting, "withdrawForQuestions", "writes.waitingChat");
    const supersede = request.writes.waitingChat?.supersede ?? null;
    if (supersede !== null) {
      // K-05 v1.1 item 19's code check: the one answer is this commit's own row to the mobile that texted in.
      const answer = request.writes.outboxRows.find(
        (row) => row.id === supersede.answerRowId && row.recipientHandleId === supersede.recipientHandleId,
      );
      if (answer === undefined) {
        fail("waitingChat.supersede's answer row is not one of this commit's outbox rows to that handle");
      }
    }
  }
  return raise;
}

// ---- the transaction's scope, set per write ---------------------------------------------------------------------------

/** The business scope of the commit's transaction, set to each write's own business (null: the runtime side). */
class Scope {
  private readonly tx: Sql;
  private current: string | null = null;

  constructor(tx: Sql) {
    this.tx = tx;
  }

  async to(businessId: string | null): Promise<void> {
    if (businessId === this.current) {
      return;
    }
    if (businessId !== null) {
      assertBusinessId(businessId);
    }
    await this.tx`select set_config(${SCOPE_SETTING}, ${businessId ?? ""}, true)`;
    this.current = businessId;
  }
}

// ---- tables, read from the catalog once per call ------------------------------------------------------------------------

/**
 * A writer of a turn's state rows (T-1437; DL-927): commitTurn's Context, or clocks.ts's firing, whose firing commits its
 * writes as this file does. Each reads a table, names a row, and finds, locks and compares it by the same helpers here
 * (tableInfo, oneKey, stateUpdateTarget, lockRow, comparedBusinesses and refuseBusinessMoves), so the two writers accept
 * the same targets and never drift. Each helper's error starts with the writer's `call`.
 */
export interface RowWriter {
  readonly tx: Sql;
  readonly call: WriterCall;
  /** Each table read from the catalog, once per call. */
  readonly tables: Map<string, TableInfo>;
  /** Each state update of a two-column key, found once by its key's columns (T-667), by the write it is. */
  readonly namedUpdates: Map<object, UpdateTarget>;
}

/**
 * What each writer's errors call its writes, and where its rule for a row it names that does not exist is written (this
 * file's default 1, which the firing follows).
 */
const WRITER_WORDS: Readonly<Record<WriterCall, { readonly writes: string; readonly missing: string }>> = {
  commitTurn: { writes: "commit", missing: "default 1" },
  fireClock: { writes: "firing", missing: "commit-turn.ts default 1" },
};

export interface TableInfo {
  readonly name: string;
  readonly columns: ReadonlySet<string>;
  readonly jsonColumns: ReadonlySet<string>;
  /** The columns of type bytea, whose values come in K-04's text form and are written as their bytes (default 11). */
  readonly byteaColumns: ReadonlySet<string>;
  readonly key: readonly string[];
  readonly versioned: boolean;
  /** The column row-level security scopes the table by (K-04 rule 4), or null for a table with none. */
  readonly scopeColumn: string | null;
  /**
   * The column holding a row's business where row-level security does not hold the row there on update (default 16): a
   * table of BUSINESS_UNHELD_TABLES, or a table with business_id and no row-level security; null where it holds the row,
   * or the table has no business.
   */
  readonly unheldBusiness: string | null;
}

interface Context extends RowWriter {
  readonly call: "commitTurn";
  readonly now: Date;
  /** `now` in the contract's form. */
  readonly at: string;
  readonly turn: K05.Turn;
  readonly scope: Scope;
  /**
   * The tables whose rows the answer names by a column other than their primary key, by that column:
   * PHONES_BY_HANDLE_ID when the request asks (answerPhoneRowsBy "handleId": K-05 v1.17 item 71; T-1417), else
   * none (v1.16's answer).
   */
  readonly answerNames: ReadonlyMap<string, string>;
  /** The open question the request asks again (K-05 v1.21 item 81; T-1509), or null: it raises none. */
  readonly raise: Raise | null;
}

/**
 * The row a state update names: its rowId (the one key column's value, or item 77's name the database built for the row
 * a two-column key finds), the key's columns to values when it has two (null for one), and for two its business as read
 * before the locks (undefined for one: read only when a compare needs it).
 */
export interface UpdateTarget {
  readonly rowId: string;
  readonly keyValues: Row | null;
  readonly business: string | null | undefined;
}

/**
 * A table's columns, its JSON and bytea columns, its primary key and its row-level security, from the catalog: an
 * ordinary table of this connection's search path (never one of PostgreSQL's own), or a throw. Read once per call, for
 * either writer (T-1437).
 */
export async function tableInfo(w: RowWriter, table: string): Promise<TableInfo> {
  const known = w.tables.get(table);
  if (known !== undefined) {
    return known;
  }
  assertName(table, "a table name", w.call);
  const [row] = await w.tx<
    { rls: boolean; columns: string[]; json_columns: string[]; bytea_columns: string[]; key: string[] }[]
  >`
    select c.relrowsecurity as rls,
           array(select a.attname::text from pg_attribute a
                 where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                 order by a.attnum) as columns,
           array(select a.attname::text from pg_attribute a
                 where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                   and a.atttypid in ('json'::regtype, 'jsonb'::regtype)
                 order by a.attnum) as json_columns,
           array(select a.attname::text from pg_attribute a
                 where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                   and a.atttypid = 'bytea'::regtype
                 order by a.attnum) as bytea_columns,
           array(select a.attname::text
                 from pg_index i
                 cross join lateral unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                 where i.indrelid = c.oid and i.indisprimary
                 order by k.ord) as key
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.oid = to_regclass(${table}) and c.relkind in ('r', 'p') and n.nspname = any (current_schemas(false))
  `;
  if (row === undefined) {
    fail(`no table ${table} in this database's schema`, w.call);
  }
  const columns = new Set(row.columns);
  let scopeColumn: string | null = null;
  if (row.rls) {
    const column = table === "businesses" ? "id" : "business_id";
    if (columns.has(column)) {
      scopeColumn = column;
    } else if (!PERSON_BOUND_TABLES.has(table)) {
      fail(`${table} has row-level security but no business column this call can scope by`, w.call);
    }
  }
  const info: TableInfo = {
    name: table,
    columns,
    jsonColumns: new Set(row.json_columns),
    byteaColumns: new Set(row.bytea_columns),
    key: row.key,
    versioned: columns.has("version"),
    scopeColumn,
    unheldBusiness:
      columns.has("business_id") && (!row.rls || BUSINESS_UNHELD_TABLES.has(table)) ? "business_id" : null,
  };
  w.tables.set(table, info);
  return info;
}

/**
 * The key columns of a versioned table, by which a row reference names its rows as one text (K-02 fact rowId): one
 * column, or the two of a table K-05 v1.18 item 77 names (setup/row-names.ts TWO_COLUMN_KEYS; T-667), whose rows are
 * named by the two values joined by "/". Any other key of more than one column names no row.
 */
export function oneKey(w: RowWriter, info: TableInfo): readonly string[] {
  const [key, ...more] = info.key;
  if (!info.versioned) {
    fail(
      `${info.name} carries no version, so no ${WRITER_WORDS[w.call].writes} compares or names its rows`,
      w.call,
    );
  }
  if (key === undefined || (more.length > 0 && !isNamedKey(info.name, info.key))) {
    fail(`${info.name}'s primary key is not one column, so a row reference cannot name its rows`, w.call);
  }
  return info.key;
}

/** The one column of a key of one column, or null for a key of two (item 77's name). */
export function singleColumn(key: readonly string[]): string | null {
  const [column, ...more] = key;
  return column !== undefined && more.length === 0 ? column : null;
}

/** A two-column key's columns, matched to the values its write names (setup/row-names.ts: one or two columns only). */
function twoColumns(w: RowWriter, key: readonly string[]): readonly [string, string] {
  const [first, second, ...more] = key;
  if (first === undefined || second === undefined || more.length > 0) {
    throw new Error(`${w.call}: a row named by item 77's name has a key of two columns`);
  }
  return [first, second];
}

/** The business of `row`, a row of `info`'s table or the values a write gives one: its scope column's id, or null. */
export function businessOf(w: RowWriter, info: TableInfo, row: Row): string | null {
  if (info.scopeColumn === null) {
    return null;
  }
  const value = row[info.scopeColumn];
  if (value === null || value === undefined) {
    return null;
  }
  assertId(value, `${info.name}.${info.scopeColumn}`, w.call);
  return value;
}

/**
 * The answer of a request that asks for phones rows by handle id (answerPhoneRowsBy "handleId": K-05 v1.17 item 71;
 * T-1417): a phones row is named by its handle id, never by its number (K-08 v1 README line 42 and default 3).
 * Every other table's rows are named by their primary key, as v1.16 names them.
 */
const PHONES_BY_HANDLE_ID: ReadonlyMap<string, string> = new Map([["phones", "handle_id"]]);

/** The answer of a request that does not ask: every row named by its primary key, v1.16's answer, byte for byte. */
const BY_PRIMARY_KEY: ReadonlyMap<string, string> = new Map();

/** The names the request's answer gives rows (checkRequest has held the field to left out or "handleId"). */
function answerNamesOf(request: CommitTurnRequest): ReadonlyMap<string, string> {
  return request.answerPhoneRowsBy === "handleId" ? PHONES_BY_HANDLE_ID : BY_PRIMARY_KEY;
}

/**
 * The column the answer names `info`'s rows by when it is not the primary key (a phones row's handle_id, when the
 * request asks: T-1417), or null: the row is named by its key, and its write returns what v1.16's returns. A table
 * without that column throws (default 13): its rows are never answered by their key instead.
 */
function answerColumn(ctx: Context, info: TableInfo): string | null {
  const column = ctx.answerNames.get(info.name);
  if (column === undefined) {
    return null;
  }
  if (!info.columns.has(column)) {
    throw new Error(`commitTurn: ${info.name} has no ${column} column to name its rows by in the answer`);
  }
  return column;
}

/**
 * The id the answer names a row by: its primary key's value `keyValue`, as v1.16 names it, unless the request asks for
 * another name (T-1417): then a phones row's handle id, read from `row`, the row as the commit locked it or as its write
 * returned it (never a second read). A row with no such id, or an empty one, throws, naming the table and the column
 * alone: the number is never answered in its place (fail closed; K-05 v1.17 default 146).
 */
function answeredRowId(ctx: Context, table: string, keyValue: string, row: Row): string {
  const column = ctx.answerNames.get(table);
  if (column === undefined) {
    return keyValue;
  }
  const value = row[column];
  if (typeof value !== "string" || value === "" || value.includes("\u0000")) {
    throw new Error(`commitTurn: a ${table} row has no ${column} to name it by in the answer`);
  }
  return value;
}

/**
 * One column's value as postgres.js takes it: null as null, a JSON column's as JSON, a bytea column's as the bytes its
 * text form spells (default 11: any other form throws, naming the column, never the value), the rest as PostgreSQL text
 * input (K-05 v1).
 */
function columnValue(ctx: Context, info: TableInfo, column: string, value: unknown, what: string): unknown {
  if (value === null) {
    return null;
  }
  if (info.jsonColumns.has(column)) {
    return ctx.tx.json(value as Json);
  }
  if (info.byteaColumns.has(column)) {
    const bytes = byteaFromText(value);
    if (bytes === null) {
      fail(`${what} gives ${info.name}.${column} a value that is not "\\x" and hex digit pairs`);
    }
    return bytes;
  }
  return value;
}

/** Column to value for an insert or an update, each as columnValue gives it. */
function columnValues(ctx: Context, info: TableInfo, values: Row, what: string): Record<string, never> {
  const out: Record<string, never> = {};
  for (const [column, value] of Object.entries(values)) {
    if (value === undefined) {
      continue;
    }
    assertName(column, `${what}'s column`);
    if (!info.columns.has(column)) {
      fail(`${what} names a column ${info.name} does not have`);
    }
    out[column] = columnValue(ctx, info, column, value, what) as never;
  }
  if (Object.keys(out).length === 0) {
    fail(`${what} writes no column`);
  }
  return out;
}

// ---- 2. the locks and the compares ---------------------------------------------------------------------------------------

export type Mode = "share" | "update";

export interface Locked {
  readonly table: string;
  readonly rowId: string;
  readonly version: number;
  readonly business: string | null;
  readonly row: Row;
}

/** A row's key among the rows a writer compares or writes: its table and its rowId (a two-column row's name). */
export const targetKey = (table: string, rowId: string): string => `${table}\u0000${rowId}`;
const savedTimeClockId = (reservationId: string): string => `${reservationId}/saved-time`;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A row the commit locks: by its rowId, or (a two-column row a state update names: T-667) by its key's columns. */
export interface LockTarget {
  readonly table: string;
  readonly rowId: string;
  readonly mode: Mode;
  /** The key's columns to values of a two-column row a state update names, found by them; null: found by its rowId. */
  readonly keyValues: Row | null;
  /** That row's business as read before the locks (undefined: not read). */
  readonly business: string | null | undefined;
}

/** The key's columns to values of a two-column row a state update names (stateUpdateTarget set them). */
export function keyValuesOf(w: RowWriter, target: UpdateTarget): Row {
  if (target.keyValues === null) {
    throw new Error(`${w.call}: a two-column row to update has no key's values`);
  }
  return target.keyValues;
}

/** A two-column key's columns, each with the value a state update names it by (stateUpdateTarget checked each). */
export function keyWhere(w: RowWriter, key: readonly string[], keyValues: Row) {
  const { tx } = w;
  const [first, second] = twoColumns(w, key);
  return tx`${tx(first)} = ${keyValues[first] as string | number} and ${tx(second)} = ${keyValues[second] as string | number}`;
}

/** The businesses the commit writes (default 14; T-667), read once, before the locks, when a compare needs them. */
export interface WriteBusinesses {
  /** Each business a write names or a row it updates holds. */
  readonly ids: ReadonlySet<string>;
  /** Whether a write has no business (the runtime side's rows), or the commit writes no business's row at all. */
  readonly none: boolean;
}

/**
 * How a two-column row is found (T-667): a state update's by its key's columns; a version read's by item 77's name, the
 * SQL's own name for the row compared whole with the rowId, of one of the businesses the commit writes, or with no
 * business when one of its writes has none (default 14), or of no business at all for a table scoped none.
 */
function namedRowWhere(
  w: RowWriter,
  info: TableInfo,
  target: LockTarget,
  businesses: WriteBusinesses | null,
) {
  const { tx } = w;
  if (target.keyValues !== null) {
    return keyWhere(w, info.key, target.keyValues);
  }
  const name = rowNameSql(tx, info.key);
  if (info.scopeColumn === null) {
    return tx`${name} = ${target.rowId}`;
  }
  if (businesses === null) {
    throw new Error(
      `${w.call}: a two-column version read was compared before the ${WRITER_WORDS[w.call].writes}'s businesses were read`,
    );
  }
  if (businesses.ids.size === 0) {
    return tx`${name} = ${target.rowId} and ${tx(info.scopeColumn)} is null`;
  }
  const ids = [...businesses.ids];
  return businesses.none
    ? tx`${name} = ${target.rowId} and (${tx(info.scopeColumn)} in ${tx(ids)} or ${tx(info.scopeColumn)} is null)`
    : tx`${name} = ${target.rowId} and ${tx(info.scopeColumn)} in ${tx(ids)}`;
}

/**
 * Finds and locks one row a writer compares or writes (FOR UPDATE to write it, FOR SHARE to compare it), by its one key
 * column, or a two-column row as namedRowWhere finds it; with `bound`, only a row that also meets it: SQL that follows
 * the row's compare and starts with "and" (or is empty), as setup/fact-homes.ts rowBound writes it (a firing's rows of a
 * table scoped none: clocks.ts, T-1437), never one for commitTurn. A row it does not find throws (default 1, fail
 * closed).
 */
export async function lockRow(
  w: RowWriter,
  target: LockTarget,
  businesses: WriteBusinesses | null,
  bound: postgres.Fragment | null = null,
): Promise<Locked> {
  const { table, rowId, mode } = target;
  const info = await tableInfo(w, table);
  const key = oneKey(w, info);
  const column = singleColumn(key);
  const { tx } = w;
  const named = column === null ? namedRowWhere(w, info, target, businesses) : tx`${tx(column)} = ${rowId}`;
  const where = bound === null ? named : tx`${named} ${bound}`;
  const [row] =
    mode === "update"
      ? await tx<Row[]>`select * from ${tx(table)} where ${where} for update`
      : await tx<Row[]>`select * from ${tx(table)} where ${where} for share`;
  if (row === undefined) {
    fail(`a row of ${table} the request names does not exist (${WRITER_WORDS[w.call].missing})`, w.call);
  }
  const version = row.version;
  assertVersion(version, `${table}.version`, w.call);
  return { table, rowId, version, business: businessOf(w, info, row), row };
}

/** The saved-time clock rows of the reservations the commit confirms or releases, locked first (FOR UPDATE). */
async function lockSavedTimeClocks(
  ctx: Context,
  reservationIds: readonly string[],
): Promise<Map<string, Row>> {
  const ids = [...new Set(reservationIds.map(savedTimeClockId))].sort(compareText);
  const rows =
    ids.length === 0
      ? []
      : await ctx.tx<Row[]>`
          select id, business_id, state, version from clock_rows where id in ${ctx.tx(ids)}
          order by id collate "C" for update
        `;
  return new Map(rows.map((row) => [String(row.id), row]));
}

/**
 * The slot locks of the reservations the commit releases, taken before any reservation row is locked: the same keys,
 * in the same order, as db/repo/reservations.ts's lockSlot (the resource, and for a worker the person, sorted), so a
 * release inside a commit and a reserve or release on its own always take the slot before the row.
 */
async function lockReleaseSlots(ctx: Context, reservationIds: readonly string[]): Promise<void> {
  if (reservationIds.length === 0) {
    return;
  }
  const slots = await ctx.tx<
    { resource_id: string; resource_kind: string; worker_person_id: string | null }[]
  >`
    select resource_id, resource_kind, worker_person_id from reservations where id in ${ctx.tx([...reservationIds])}
  `;
  const keys = new Set<string>();
  for (const slot of slots) {
    if (slot.resource_kind === "class_session") {
      continue;
    }
    keys.add(`resource:${slot.resource_id}`);
    if (slot.worker_person_id !== null) {
      keys.add(`person:${slot.worker_person_id}`);
    }
  }
  for (const key of [...keys].sort()) {
    await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}

interface Compared {
  /** Every row compared or written, by targetKey. */
  readonly rows: ReadonlyMap<string, Locked>;
  /** The saved-time clock rows found, by clock row id. */
  readonly savedTimeClocks: ReadonlyMap<string, Row>;
}

export interface Expectation {
  readonly table: string;
  readonly rowId: string;
  readonly version: number;
}

/**
 * Adds a row a writer compares or writes to `modes`, once, with the strongest lock it needs, and the version it read or
 * expects to `expected`. A two-column row a state update names keeps the key it is found by, and its business as read
 * (T-667).
 */
export function addTarget(
  modes: Map<string, LockTarget>,
  expected: Expectation[],
  table: string,
  rowId: string,
  mode: Mode,
  version: number,
  update: UpdateTarget | null = null,
): void {
  const key = targetKey(table, rowId);
  const known = modes.get(key);
  if (known === undefined || (known.mode === "share" && mode === "update")) {
    modes.set(key, {
      table,
      rowId,
      mode,
      keyValues: update === null ? (known?.keyValues ?? null) : update.keyValues,
      business: update === null ? known?.business : update.business,
    });
  }
  expected.push({ table, rowId, version });
}

/**
 * A state update's row, the key naming exactly the primary key (no wider update), each column with a value: a key of one
 * column names the row by its value; a key of two (K-05 v1.18 item 77; T-667) by the name the database builds for the
 * row those values find, with that row's business, read once per write before any lock (default 1 when there is none).
 */
export async function stateUpdateTarget(
  w: RowWriter,
  write: Extract<K05.StateWrite, { op: "update" }>,
): Promise<UpdateTarget> {
  const known = w.namedUpdates.get(write);
  if (known !== undefined) {
    return known;
  }
  const info = await tableInfo(w, write.table);
  const key = oneKey(w, info);
  const named = Object.keys(write.key);
  const column = singleColumn(key);
  if (column !== null) {
    if (named.length !== 1 || named[0] !== column) {
      fail(`a state update of ${write.table} must name the row by its primary key alone`, w.call);
    }
    const value = write.key[column];
    if ((typeof value !== "string" && typeof value !== "number") || value === "") {
      fail(`a state update of ${write.table} names its key with no value`, w.call);
    }
    if (Object.hasOwn(write.set, column)) {
      fail(`a state update of ${write.table} may not change the row's key`, w.call);
    }
    return { rowId: String(value), keyValues: null, business: undefined };
  }
  if (named.length !== key.length || !key.every((keyColumn) => named.includes(keyColumn))) {
    fail(`a state update of ${write.table} must name the row by its primary key alone`, w.call);
  }
  const keyValues: Row = {};
  for (const keyColumn of key) {
    const value = write.key[keyColumn];
    if ((typeof value !== "string" && typeof value !== "number") || value === "") {
      fail(`a state update of ${write.table} names its key with no value`, w.call);
    }
    if (Object.hasOwn(write.set, keyColumn)) {
      fail(`a state update of ${write.table} may not change the row's key`, w.call);
    }
    keyValues[keyColumn] = value;
  }
  const { tx } = w;
  const where = keyWhere(w, key, keyValues);
  const [row] =
    info.scopeColumn === null
      ? await tx<{ name: string; business: string | null }[]>`
          select ${rowNameSql(tx, key)} as name, null::text as business from ${tx(write.table)} where ${where}
        `
      : await tx<{ name: string; business: string | null }[]>`
          select ${rowNameSql(tx, key)} as name, ${tx(info.scopeColumn)} as business
          from ${tx(write.table)} where ${where}
        `;
  if (row === undefined) {
    fail(
      `a row of ${write.table} the request names does not exist (${WRITER_WORDS[w.call].missing})`,
      w.call,
    );
  }
  assertId(row.name, `${write.table}'s row name`, w.call);
  assertNullableId(row.business, `${write.table}.${info.scopeColumn ?? "business"}`, w.call);
  const target: UpdateTarget = { rowId: row.name, keyValues, business: row.business };
  w.namedUpdates.set(write, target);
  return target;
}

/**
 * The businesses the commit writes (default 14; T-667): each one its request names (a state insert's business, an open
 * question's, a clock row's, an outbox row's, an effect's, an event's), each one of a row it updates, read now, before
 * the locks, on the runtime side, and the business a state update gives a row that has none (S1-09), a write with no
 * business naming none. Read only when a two-column version read of a business-scoped table needs it. `also` holds the
 * businesses of what the writer writes beside its request's lists (a firing's own clock row: clocks.ts, T-1437); none
 * for a commit.
 */
async function writeBusinesses(
  w: RowWriter,
  writes: K05.Writes,
  targets: readonly LockTarget[],
  also: readonly (string | null)[],
): Promise<WriteBusinesses> {
  // Each write's business as it names it or its row holds it: an id, or null for none.
  const named: unknown[] = [...also];
  for (const write of writes.state) {
    if (write.op === "insert") {
      const info = await tableInfo(w, write.table);
      if (info.scopeColumn !== null) {
        named.push(write.values[info.scopeColumn] ?? null);
      }
    }
  }
  const records: readonly unknown[] = [
    ...writes.openQuestions.open,
    ...writes.clockRows.make,
    ...writes.outboxRows,
    ...(writes.effects?.write ?? []),
    ...writes.events,
  ];
  for (const record of records) {
    if (isRecord(record) && Object.hasOwn(record, "businessId")) {
      named.push(record.businessId);
    }
  }
  // The business of each row the commit updates, as it stands before the locks, by targetKey.
  const before = new Map<string, unknown>();
  const { tx } = w;
  for (const target of targets) {
    if (target.mode !== "update") {
      continue;
    }
    const info = await tableInfo(w, target.table);
    if (info.scopeColumn === null) {
      continue;
    }
    if (target.business !== undefined) {
      before.set(targetKey(target.table, target.rowId), target.business);
      continue;
    }
    const column = singleColumn(oneKey(w, info));
    if (column === null) {
      throw new Error(`${w.call}: a two-column row to update was not read before its business was asked`);
    }
    const [row] = await tx<{ business: unknown }[]>`
      select ${tx(info.scopeColumn)} as business from ${tx(target.table)} where ${tx(column)} = ${target.rowId}
    `;
    // A row that does not exist names no business here; its lock throws (default 1).
    if (row !== undefined) {
      before.set(targetKey(target.table, target.rowId), row.business);
    }
  }
  named.push(...before.values());
  // A state update that gives a row with no business its business (S1-09: a sign-up's rows to the new business) writes
  // that business too. A row of a business is never moved to another business or to none (default 16): row-level
  // security refuses that update under the row's own scope where it holds the row there (42501), and where it does not
  // (rosie_job's policy of true on busy_blocks and proof_codes, or a table with no row-level security) lockAndCompare
  // refuses it on the row as locked, before any write. So a set's business counts here only for a row with none.
  for (const write of writes.state) {
    if (write.op !== "update") {
      continue;
    }
    const info = await tableInfo(w, write.table);
    if (info.scopeColumn === null || !Object.hasOwn(write.set, info.scopeColumn)) {
      continue;
    }
    const target = await stateUpdateTarget(w, write);
    if (before.get(targetKey(write.table, target.rowId)) === null) {
      named.push(write.set[info.scopeColumn] ?? null);
    }
  }
  const ids = new Set<string>();
  let none = false;
  for (const value of named) {
    if (value === null) {
      none = true;
    } else if (typeof value === "string" && value !== "") {
      ids.add(value);
    }
  }
  return { ids, none: none || ids.size === 0 };
}

/**
 * The businesses a two-column version read of a business-scoped table is compared under (default 14; T-667), read before
 * any row is locked: null when no target is such a read, so a writer with none reads nothing more. `also`: as
 * writeBusinesses.
 */
export async function comparedBusinesses(
  w: RowWriter,
  writes: K05.Writes,
  targets: readonly LockTarget[],
  also: readonly (string | null)[] = [],
): Promise<WriteBusinesses | null> {
  for (const target of targets) {
    if (target.keyValues === null && twoColumnKeyOf(target.table) !== null) {
      const info = await tableInfo(w, target.table);
      if (info.scopeColumn !== null) {
        return writeBusinesses(w, writes, targets, also);
      }
    }
  }
  return null;
}

/**
 * A state update never moves a row of a business to another business or to none (default 16; T-667 round 2): where
 * row-level security does not hold the row there, the row as locked (`locked`) is compared with the set, after the
 * compares and before any write, and a move throws. A row with no business may be given one (S1-09).
 */
export async function refuseBusinessMoves(
  w: RowWriter,
  state: readonly K05.StateWrite[],
  locked: (table: string, rowId: string) => Locked,
): Promise<void> {
  for (const write of state) {
    if (write.op !== "update") {
      continue;
    }
    const info = await tableInfo(w, write.table);
    const column = info.unheldBusiness;
    // A column whose value is undefined is not written (columnValues), so it moves nothing.
    if (column === null || write.set[column] === undefined) {
      continue;
    }
    const held = locked(write.table, (await stateUpdateTarget(w, write)).rowId).row[column];
    if (held !== null && held !== undefined && write.set[column] !== held) {
      fail(`a state update of ${write.table} may not move a row of a business to another business`, w.call);
    }
  }
}

async function lockAndCompare(ctx: Context, request: CommitTurnRequest): Promise<Compared> {
  const { writes } = request;
  const confirms = writes.reservations.confirm;
  const releases = writes.reservations.release;
  const letGos = writes.effects?.letGo ?? [];

  const savedTimeClocks = await lockSavedTimeClocks(ctx, [
    ...confirms.map((confirm) => confirm.id),
    ...releases.map((release) => release.id),
  ]);
  await lockReleaseSlots(
    ctx,
    releases.map((release) => release.id),
  );

  // Every row compared or written, with the strongest lock it needs, and every version the request read or expects. A
  // two-column row a state update names keeps the key it is found by (T-667).
  const modes = new Map<string, LockTarget>();
  const expected: Expectation[] = [];
  const want = (
    table: string,
    rowId: string,
    mode: Mode,
    version: number,
    update: UpdateTarget | null = null,
  ): void => {
    addTarget(modes, expected, table, rowId, mode, version, update);
  };
  for (const ref of request.versionsRead) {
    want(ref.table, ref.rowId, "share", ref.version);
  }
  for (const write of writes.state) {
    if (write.op === "update") {
      const update = await stateUpdateTarget(ctx, write);
      want(write.table, update.rowId, "update", write.expectVersion, update);
    }
  }
  for (const close of writes.openQuestions.close) {
    assertId(close.id, "openQuestions.close[].id");
    assertVersion(close.expectVersion, "openQuestions.close[].expectVersion");
    want("open_questions", close.id, "update", close.expectVersion);
  }
  // The question a v1.21 request asks again (item 81; T-1509), beside the closes: locked FOR UPDATE with the commit's
  // other rows in (table, row id) order and compared as an update, so a version moved since the turn read it answers
  // versionChanged, each changed row listed once (default 7). One the request names that does not exist, or one this
  // commit opens, is not there when the locks are taken, so its lock throws (default 1).
  if (ctx.raise !== null) {
    want("open_questions", ctx.raise.id, "update", ctx.raise.expectVersion);
  }
  for (const cancel of writes.clockRows.cancel) {
    assertId(cancel.id, "clockRows.cancel[].id");
    assertVersion(cancel.expectVersion, "clockRows.cancel[].expectVersion");
    want("clock_rows", cancel.id, "update", cancel.expectVersion);
  }
  for (const move of [...confirms, ...releases]) {
    assertId(move.id, "a reservation's id");
    assertVersion(move.expectVersion, "a reservation's expectVersion");
    want("reservations", move.id, "update", move.expectVersion);
  }
  for (const letGo of letGos) {
    assertId(letGo.effectId, "effects.letGo[].effectId");
    assertVersion(letGo.expectVersion, "effects.letGo[].expectVersion");
    want("effects", letGo.effectId, "update", letGo.expectVersion);
  }

  // A two-column version read of a business-scoped table is compared under the businesses the commit writes, read
  // before any row is locked (default 14; T-667). A commit with no such read reads nothing more.
  const businesses = await comparedBusinesses(ctx, writes, [...modes.values()]);

  // Locked in one fixed order, so two commits never wait on each other in a circle.
  const rows = new Map<string, Locked>();
  const order = [...modes.values()].sort(
    (a, b) => compareText(a.table, b.table) || compareText(a.rowId, b.rowId),
  );
  for (const target of order) {
    rows.set(targetKey(target.table, target.rowId), await lockRow(ctx, target, businesses));
  }
  const locked = (table: string, rowId: string): Locked => {
    const row = rows.get(targetKey(table, rowId));
    if (row === undefined) {
      throw new Error(`commitTurn: a ${table} row was compared but not locked`);
    }
    return row;
  };

  // Limit 5: a reservation to confirm must still be held, and not past its end (checked before its version).
  const lost: LostReservation[] = [];
  for (const confirm of confirms) {
    const { row } = locked("reservations", confirm.id);
    const heldUntil = row.held_until instanceof Date ? row.held_until : null;
    if (row.state !== "held" || heldUntil === null || heldUntil.getTime() <= ctx.now.getTime()) {
      lost.push({
        id: confirm.id,
        state: row.state as LostReservation["state"],
        heldUntil: heldUntil === null ? null : utc(heldUntil),
        releasedWhy: (row.released_why ?? null) as LostReservation["releasedWhy"],
      });
    }
  }
  const lostList = nonEmpty(lost);
  if (lostList !== null) {
    throw new Refused({ error: "reservationLost", reservations: lostList });
  }

  // Limit 4: every row read or written at the version the turn saw, each changed row listed once, named as the answer
  // names it (a phones row, when the request asks, by the handle id of the row as locked: T-1417).
  const changed: ChangedRow[] = [];
  const listed = new Set<string>();
  for (const expectation of expected) {
    const now = locked(expectation.table, expectation.rowId);
    const key = `${targetKey(expectation.table, expectation.rowId)}\u0000${String(expectation.version)}`;
    if (now.version !== expectation.version && !listed.has(key)) {
      listed.add(key);
      changed.push({
        table: expectation.table,
        rowId: answeredRowId(ctx, expectation.table, expectation.rowId, now.row),
        readVersion: expectation.version,
        currentVersion: now.version,
      });
    }
  }
  const changedList = nonEmpty(changed);
  if (changedList !== null) {
    throw new Refused({ error: "versionChanged", changed: changedList });
  }

  // An effect is let go only from its service's outage (K-07 letGo; K-05 v1.1 item 18).
  for (const letGo of letGos) {
    const { row } = locked("effects", letGo.effectId);
    if (row.state !== "outage") {
      throw new Refused({
        error: "wrongState",
        table: "effects",
        rowId: letGo.effectId,
        state: row.state as K05.EffectState,
      });
    }
  }

  // The question asked again must be live, waiting or open, at the version read; else wrongState with its status now,
  // after versionChanged and an effect let go's (K-05 v1.21 item 81, step 2; default 193).
  if (ctx.raise !== null) {
    const status = locked("open_questions", ctx.raise.id).row.status;
    if (status !== "waiting" && status !== "open") {
      if (status !== "answered" && status !== "defaulted" && status !== "withdrawn") {
        throw new Error("commitTurn: an open question to ask again has a status K-04 does not name");
      }
      throw new Refused({ error: "wrongState", table: "open_questions", rowId: ctx.raise.id, state: status });
    }
  }

  // A state update never moves a row of a business to another business or to none (default 16; T-667 round 2): where
  // row-level security does not hold the row there, the row as locked is compared with the set, before any write. A row
  // with no business may be given one (S1-09).
  await refuseBusinessMoves(ctx, writes.state, locked);

  return { rows, savedTimeClocks };
}

function nonEmpty<T>(items: readonly T[]): [T, ...T[]] | null {
  const [first, ...rest] = items;
  return first === undefined ? null : [first, ...rest];
}

// ---- 3. the writes -----------------------------------------------------------------------------------------------------

interface Written {
  readonly written: RowRef[];
  readonly outboxRows: K05.OutboxRowWritten[];
  readonly promoted: Promotion[];
  readonly superseded: RowRef[];
  readonly withdrawn: RowRef[];
}

function lockedRow(compared: Compared, table: string, rowId: string): Locked {
  const row = compared.rows.get(targetKey(table, rowId));
  if (row === undefined) {
    throw new Error(`commitTurn: a ${table} row is written but was not locked`);
  }
  return row;
}

async function writeState(
  ctx: Context,
  request: CommitTurnRequest,
  compared: Compared,
  out: Written,
): Promise<void> {
  const { tx } = ctx;
  for (const write of request.writes.state) {
    const info = await tableInfo(ctx, write.table);
    if (write.op === "insert") {
      const what = `a state insert into ${write.table}`;
      const values = columnValues(ctx, info, write.values, what);
      const business = info.scopeColumn === null ? null : businessOf(ctx, info, write.values);
      await ctx.scope.to(business);
      if (!info.versioned) {
        await tx`insert into ${tx(write.table)} ${tx(values)}`;
        continue;
      }
      const key = oneKey(ctx, info);
      const column = singleColumn(key);
      // The column the answer names the row by, when it is not the key, comes back with it (a phones row's handle id,
      // when the request asks: T-1417); otherwise the insert returns what v1.16's returns. A two-column row comes back
      // with item 77's name, which the database builds from the row's own columns (T-667).
      const named = answerColumn(ctx, info);
      const [row] =
        column === null
          ? await tx<(Row & { key: unknown; version: number })[]>`
              insert into ${tx(write.table)} ${tx(values)} returning ${rowNameSql(tx, key)} as key, version
            `
          : named === null
            ? await tx<(Row & { key: unknown; version: number })[]>`
                insert into ${tx(write.table)} ${tx(values)} returning ${tx(column)} as key, version
              `
            : await tx<(Row & { key: unknown; version: number })[]>`
                insert into ${tx(write.table)} ${tx(values)} returning ${tx(column)} as key, ${tx(named)}, version
              `;
      if (row === undefined) {
        throw new Error(`commitTurn: ${what} returned no row`);
      }
      out.written.push({
        table: write.table,
        rowId: answeredRowId(ctx, write.table, String(row.key), row),
        version: row.version,
      });
      continue;
    }
    const target = await stateUpdateTarget(ctx, write);
    const { rowId } = target;
    const key = oneKey(ctx, info);
    const column = singleColumn(key);
    const locked = lockedRow(compared, write.table, rowId);
    const set = columnValues(ctx, info, write.set, `a state update of ${write.table}`);
    await ctx.scope.to(locked.business);
    // As the insert: the update returns the answer's column too only when the answer names the row by it (T-1417). A
    // two-column row is found by its key's columns, as the write names it, and answered by its name (T-667).
    const named = answerColumn(ctx, info);
    const [row] =
      column === null
        ? await tx<(Row & { version: number })[]>`
            update ${tx(write.table)} set ${tx(set)}, version = ${write.expectVersion + 1}
            where ${keyWhere(ctx, key, keyValuesOf(ctx, target))} and version = ${write.expectVersion}
            returning version
          `
        : named === null
          ? await tx<(Row & { version: number })[]>`
              update ${tx(write.table)} set ${tx(set)}, version = ${write.expectVersion + 1}
              where ${tx(column)} = ${rowId} and version = ${write.expectVersion}
              returning version
            `
          : await tx<(Row & { version: number })[]>`
              update ${tx(write.table)} set ${tx(set)}, version = ${write.expectVersion + 1}
              where ${tx(column)} = ${rowId} and version = ${write.expectVersion}
              returning ${tx(named)}, version
            `;
    if (row === undefined) {
      throw new Error(`commitTurn: a state update of ${write.table} matched no row at its version`);
    }
    out.written.push({
      table: write.table,
      rowId: answeredRowId(ctx, write.table, rowId, row),
      version: row.version,
    });
  }
}

async function writeOpenQuestions(
  ctx: Context,
  request: CommitTurnRequest,
  compared: Compared,
  out: Written,
): Promise<void> {
  const { tx, turn } = ctx;
  for (const question of request.writes.openQuestions.open) {
    const what = "openQuestions.open[]";
    const record = question as unknown as Row;
    idField(record, "id", what);
    idField(record, "handleId", what);
    nullableIdField(record, "personId", what);
    const business = nullableIdField(record, "businessId", what);
    nullableIdField(record, "bookingId", what);
    await ctx.scope.to(business);
    const [row] = await tx<{ version: number }[]>`
      insert into open_questions (
        id, turn_id, handle_id, person_id, business_id, booking_id, step, options, readback, versions_read,
        bundle_hash, bundle_build, clock
      ) values (
        ${question.id}, ${turn.id}, ${question.handleId}, ${question.personId}, ${question.businessId},
        ${question.bookingId}, ${question.step}, ${tx.json(question.options as unknown as Json)}, ${question.readback},
        ${tx.json(question.versionsRead as unknown as Json)}, ${turn.bundleId.hash}, ${turn.bundleId.build},
        ${question.clock}
      )
      returning version
    `;
    out.written.push({ table: "open_questions", rowId: question.id, version: row?.version ?? 1 });
  }
  for (const close of request.writes.openQuestions.close) {
    assertNullableId(close.answeredOptionId, "openQuestions.close[].answeredOptionId");
    const locked = lockedRow(compared, "open_questions", close.id);
    await ctx.scope.to(locked.business);
    const [row] = await tx<{ version: number }[]>`
      update open_questions
      set status = ${close.status}, answered_option_id = ${close.answeredOptionId}, closed_at = ${ctx.now},
          version = ${close.expectVersion + 1}
      where id = ${close.id} and version = ${close.expectVersion}
      returning version
    `;
    if (row === undefined) {
      throw new Error("commitTurn: an open question's close matched no row at its version");
    }
    out.written.push({ table: "open_questions", rowId: close.id, version: row.version });
  }
  // After the opens and closes, the question a v1.21 request asks again (item 81, step 3; T-1509): its ask count and its
  // version each raised by one, at the version read and while it is live, under its business as locked; nothing else of
  // it moves (default 195). written names it at its new version, after the opens and closes (default 198).
  const raise = ctx.raise;
  if (raise !== null) {
    const locked = lockedRow(compared, "open_questions", raise.id);
    await ctx.scope.to(locked.business);
    const [row] = await tx<{ version: number }[]>`
      update open_questions set ask_count = ask_count + 1, version = ${raise.expectVersion + 1}
      where id = ${raise.id} and version = ${raise.expectVersion} and status in ('waiting', 'open')
      returning version
    `;
    if (row === undefined) {
      throw new Error("commitTurn: an open question asked again matched no live row at its version");
    }
    out.written.push({ table: "open_questions", rowId: raise.id, version: row.version });
  }
}

interface ClockFields {
  readonly id: string;
  readonly kind: string;
  readonly openQuestionId: string | null;
  readonly reservationId: string | null;
  readonly handleId: string | null;
  readonly businessId: string | null;
  readonly bookingId: string | null;
  readonly fires: Row;
  readonly due: { dueAt: string; dueZone: string } | null;
}

/** K-05 v1 clockNew (typed loosely by the generator): the fields this call writes, checked. */
function clockFields(clock: K05.ClockNew): ClockFields {
  const what = "clockRows.make[]";
  const kind = clock.kind;
  if (typeof kind !== "string" || !CLOCK_KINDS.has(kind)) {
    fail(`${what}.kind is not one of K-04's clock kinds`);
  }
  let due: ClockFields["due"] = null;
  if (clock.due !== undefined) {
    const record = objectField(clock, "due", what);
    const dueAt = record.dueAt;
    const dueZone = record.dueZone;
    if (typeof dueAt !== "string" || Number.isNaN(Date.parse(dueAt)) || typeof dueZone !== "string") {
      fail(`${what}.due needs dueAt (UTC) and dueZone`);
    }
    due = { dueAt, dueZone };
  }
  return {
    id: idField(clock, "id", what),
    kind,
    openQuestionId: nullableIdField(clock, "openQuestionId", what),
    reservationId: nullableIdField(clock, "reservationId", what),
    handleId: nullableIdField(clock, "handleId", what),
    businessId: nullableIdField(clock, "businessId", what),
    bookingId: nullableIdField(clock, "bookingId", what),
    fires: objectField(clock, "fires", what),
    due,
  };
}

async function insertClock(ctx: Context, clock: ClockFields): Promise<RowRef> {
  const { tx, turn } = ctx;
  await ctx.scope.to(clock.businessId);
  const [row] = await tx<{ version: number }[]>`
    insert into clock_rows (
      id, kind, open_question_id, reservation_id, handle_id, business_id, booking_id, due_at, due_zone, state,
      armed_at, fires, created_by_turn_id
    ) values (
      ${clock.id}, ${clock.kind}, ${clock.openQuestionId}, ${clock.reservationId}, ${clock.handleId},
      ${clock.businessId}, ${clock.bookingId}, ${clock.due?.dueAt ?? null}, ${clock.due?.dueZone ?? null},
      ${clock.due === null ? "waiting" : "armed"}, ${clock.due === null ? null : ctx.now},
      ${tx.json(clock.fires as Json)}, ${turn.id}
    )
    returning version
  `;
  return { table: "clock_rows", rowId: clock.id, version: row?.version ?? 1 };
}

async function writeClockRows(
  ctx: Context,
  request: CommitTurnRequest,
  compared: Compared,
  out: Written,
): Promise<void> {
  const { tx } = ctx;
  for (const clock of request.writes.clockRows.make) {
    out.written.push(await insertClock(ctx, clockFields(clock)));
  }
  for (const cancel of request.writes.clockRows.cancel) {
    const locked = lockedRow(compared, "clock_rows", cancel.id);
    await ctx.scope.to(locked.business);
    const [row] = await tx<{ version: number }[]>`
      update clock_rows set state = 'cancelled', cancelled_at = ${ctx.now}, version = ${cancel.expectVersion + 1}
      where id = ${cancel.id} and version = ${cancel.expectVersion}
      returning version
    `;
    if (row === undefined) {
      throw new Error("commitTurn: a clock row's cancel matched no row at its version");
    }
    out.written.push({ table: "clock_rows", rowId: cancel.id, version: row.version });
  }
}

/**
 * The turn's outbox rows with no plan, in commit order, each under its own business. From K-05 v1.22 (item 82; T-1476)
 * the one insert also writes the row's step and line_no, each the request's value or null (checkRequest has held them
 * both or neither), so a row that names neither holds both null as before.
 */
async function writeOutboxRows(ctx: Context, request: CommitTurnRequest, out: Written): Promise<void> {
  const { tx, turn } = ctx;
  for (const outboxRow of request.writes.outboxRows) {
    const what = "outboxRows[]";
    const record = outboxRow as unknown as Row;
    idField(record, "id", what);
    idField(record, "recipientHandleId", what);
    nullableIdField(record, "recipientPersonId", what);
    const business = nullableIdField(record, "businessId", what);
    nullableIdField(record, "bookingId", what);
    nullableIdField(record, "openQuestionId", what);
    nullableIdField(record, "copyOfRowId", what);
    await ctx.scope.to(business);
    const [row] = await tx<{ commit_seq: string | number }[]>`
      insert into outbox_rows (
        id, turn_id, recipient_handle_id, recipient_person_id, business_id, booking_id, channel, send_class,
        versions_read, open_question_id, copy_of_row_id, bundle_hash, bundle_build, trace_id, step, line_no
      ) values (
        ${outboxRow.id}, ${turn.id}, ${outboxRow.recipientHandleId}, ${outboxRow.recipientPersonId},
        ${outboxRow.businessId}, ${outboxRow.bookingId}, ${outboxRow.channel}, ${outboxRow.sendClass},
        ${tx.json(outboxRow.versionsRead as unknown as Json)}, ${outboxRow.openQuestionId}, ${outboxRow.copyOfRowId},
        ${turn.bundleId.hash}, ${turn.bundleId.build}, ${turn.traceId}, ${outboxRow.step ?? null},
        ${outboxRow.lineNo ?? null}
      )
      returning commit_seq
    `;
    out.outboxRows.push({ id: outboxRow.id, commitSeq: commitSeqOf(row?.commit_seq) });
  }
}

function commitSeqOf(value: unknown): number {
  const seq = Number(value);
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new Error("commitTurn: an outbox row's commit_seq is not a positive integer");
  }
  return seq;
}

/** Cancels a reservation's saved-time clock row while it is waiting or armed (default 3), under its own business. */
async function cancelSavedTimeClock(
  ctx: Context,
  compared: Compared,
  reservationId: string,
): Promise<RowRef | null> {
  const id = savedTimeClockId(reservationId);
  const clock = compared.savedTimeClocks.get(id);
  if (clock === undefined || (clock.state !== "waiting" && clock.state !== "armed")) {
    return null;
  }
  const business = clock.business_id;
  assertNullableId(business, "clock_rows.business_id");
  await ctx.scope.to(business);
  const [row] = await ctx.tx<{ version: number }[]>`
    update clock_rows set state = 'cancelled', cancelled_at = ${ctx.now}, version = version + 1
    where id = ${id} and state in ('waiting', 'armed')
    returning version
  `;
  return row === undefined ? null : { table: "clock_rows", rowId: id, version: row.version };
}

/** The promoted next in line's saved-time clock row (default 4; K-05 items 8 and 9). */
async function promotedClock(ctx: Context, promotion: Promotion, business: string): Promise<RowRef> {
  const [owner] =
    promotion.forPhoneNumber === null
      ? []
      : await ctx.tx<{ handle_id: string | null }[]>`
          select handle_id from phones where number = ${promotion.forPhoneNumber}
        `;
  await ctx.scope.to(business);
  const [zone] = await ctx.tx<
    { time_zone: string }[]
  >`select time_zone from businesses where id = ${business}`;
  if (zone === undefined) {
    throw new Error("commitTurn: the promoted reservation's business was not found under its own scope");
  }
  return insertClock(ctx, {
    id: promotion.savedTimeClockId,
    kind: "saved_time",
    openQuestionId: null,
    reservationId: promotion.reservationId,
    handleId: owner?.handle_id ?? null,
    businessId: business,
    bookingId: promotion.bookingId,
    fires: { release: promotion.reservationId, why: "expired" },
    due: { dueAt: promotion.heldUntil, dueZone: zone.time_zone },
  });
}

async function writeReservations(
  ctx: Context,
  request: CommitTurnRequest,
  compared: Compared,
  out: Written,
): Promise<void> {
  const { tx } = ctx;
  for (const confirm of request.writes.reservations.confirm) {
    assertId(confirm.bookingId, "reservations.confirm[].bookingId");
    const locked = lockedRow(compared, "reservations", confirm.id);
    await ctx.scope.to(locked.business);
    const [row] = await tx<{ version: number }[]>`
      update reservations set state = 'booked', booking_id = ${confirm.bookingId},
                              version = ${confirm.expectVersion + 1}
      where id = ${confirm.id} and version = ${confirm.expectVersion} and state = 'held'
      returning version
    `;
    if (row === undefined) {
      throw new Error("commitTurn: a reservation's confirm matched no held row at its version");
    }
    out.written.push({ table: "reservations", rowId: confirm.id, version: row.version });
    const clock = await cancelSavedTimeClock(ctx, compared, confirm.id);
    if (clock !== null) {
      out.written.push(clock);
    }
  }
  for (const release of request.writes.reservations.release) {
    const locked = lockedRow(compared, "reservations", release.id);
    const business = locked.business;
    if (business === null) {
      throw new Error("commitTurn: a reservation to release has no business");
    }
    await ctx.scope.to(business);
    const outcome = await releaseIn(tx, {
      reservationId: release.id,
      businessId: business,
      expectVersion: release.expectVersion,
      why: release.why,
      at: ctx.at,
    });
    if ("error" in outcome) {
      // The row was locked and compared above, so a refusal here is a fault, never an answer.
      throw new Error(`commitTurn: a reservation's release was refused after its compare (${outcome.error})`);
    }
    if (outcome.repeated) {
      continue;
    }
    out.written.push({ table: "reservations", rowId: release.id, version: outcome.version });
    if (locked.row.resource_kind === "class_session") {
      const [seats] = await tx<{ version: number }[]>`
        select version from class_seats where resource_id = ${String(locked.row.resource_id)}
      `;
      if (seats !== undefined) {
        out.written.push({
          table: "class_seats",
          rowId: String(locked.row.resource_id),
          version: seats.version,
        });
      }
    }
    const clock = await cancelSavedTimeClock(ctx, compared, release.id);
    if (clock !== null) {
      out.written.push(clock);
    }
    if (outcome.promoted !== null) {
      const promotion: Promotion = { ...outcome.promoted };
      out.written.push({ table: "reservations", rowId: promotion.reservationId, version: promotion.version });
      out.written.push(await promotedClock(ctx, promotion, business));
      out.promoted.push(promotion);
    }
  }
}

interface EffectFields {
  readonly effectId: string;
  readonly businessId: string | null;
  readonly bookingId: string | null;
  readonly kind: string;
  readonly port: string;
  readonly calendarProvider: string | null;
  readonly visitId: string | null;
  readonly personId: string | null;
  readonly handleId: string | null;
  readonly amount: { cents: number; currency: string } | null;
  readonly portRequest: Row;
  readonly idempotencyKey: string;
  readonly traceId: string;
}

/** K-05 v1.1 effectNew (typed loosely by the generator): the fields this call writes, checked. */
function effectFields(effect: K05.EffectNew): EffectFields {
  const what = "effects.write[]";
  const kind = effect.kind;
  const port = effect.port;
  if (typeof kind !== "string" || typeof port !== "string") {
    fail(`${what} needs a kind and a port`);
  }
  const provider = effect.calendarProvider;
  if (provider !== null && (typeof provider !== "string" || !CALENDAR_PROVIDERS.has(provider))) {
    fail(`${what}.calendarProvider is not google, microsoft or null`);
  }
  let amount: EffectFields["amount"] = null;
  if (effect.amount !== null) {
    const record = objectField(effect, "amount", what);
    if (!Number.isSafeInteger(record.cents) || typeof record.currency !== "string") {
      fail(`${what}.amount needs whole cents and a currency`);
    }
    amount = { cents: record.cents as number, currency: record.currency };
  }
  const key = effect.idempotencyKey;
  if (typeof key !== "string" || key === "") {
    fail(`${what}.idempotencyKey is not a non-empty key`);
  }
  return {
    effectId: idField(effect, "effectId", what),
    businessId: nullableIdField(effect, "businessId", what),
    bookingId: nullableIdField(effect, "bookingId", what),
    kind,
    port,
    calendarProvider: provider,
    visitId: nullableIdField(effect, "visitId", what),
    personId: nullableIdField(effect, "personId", what),
    handleId: nullableIdField(effect, "handleId", what),
    amount,
    portRequest: objectField(effect, "portRequest", what),
    idempotencyKey: key,
    traceId: idField(effect, "traceId", what),
  };
}

async function writeEffects(
  ctx: Context,
  request: CommitTurnRequest,
  compared: Compared,
  out: Written,
): Promise<void> {
  const { tx, turn } = ctx;
  const effects = request.writes.effects;
  if (effects === undefined) {
    return;
  }
  for (const effect of effects.write.map(effectFields)) {
    if (effect.port === "calendar" && effect.calendarProvider === null) {
      // The CHECK effects_calendar_keyed lets a null provider through; its refusal is answered here (default 9).
      throw new Refused({ error: "constraint", sqlstate: "23514", constraint: "effects_calendar_keyed" });
    }
    await ctx.scope.to(effect.businessId);
    const [row] = await tx<{ version: number }[]>`
      insert into effects (
        id, turn_id, job_id, business_id, booking_id, kind, port, calendar_provider, visit_id, person_id, handle_id,
        amount_cents, currency, port_request, idempotency_key, trace_id, created_at
      ) values (
        ${effect.effectId}, ${turn.id}, null, ${effect.businessId}, ${effect.bookingId}, ${effect.kind},
        ${effect.port}, ${effect.calendarProvider}, ${effect.visitId}, ${effect.personId}, ${effect.handleId},
        ${effect.amount?.cents ?? null}, ${effect.amount?.currency ?? null}, ${tx.json(effect.portRequest as Json)},
        ${effect.idempotencyKey}, ${effect.traceId}, ${ctx.now}
      )
      returning version
    `;
    out.written.push({ table: "effects", rowId: effect.effectId, version: row?.version ?? 1 });
  }
  for (const letGo of effects.letGo) {
    const locked = lockedRow(compared, "effects", letGo.effectId);
    await ctx.scope.to(locked.business);
    const [row] = await tx<{ version: number }[]>`
      update effects set state = 'cancelled', version = ${letGo.expectVersion + 1}
      where id = ${letGo.effectId} and version = ${letGo.expectVersion} and state = 'outage'
      returning version
    `;
    if (row === undefined) {
      throw new Error("commitTurn: an effect let go matched no outage row at its version");
    }
    out.written.push({ table: "effects", rowId: letGo.effectId, version: row.version });
  }
}

interface WaitingRow {
  id: string;
  version: number;
  business_id: string | null;
  booking_id: string | null;
  open_question_id: string | null;
  time_zone: string | null;
}

/** Moves one waiting row (K-07 waiting_chat) to superseded or withdrawn, under its business, with its entry. */
async function endWaitingRow(
  ctx: Context,
  row: WaitingRow,
  to: "superseded" | "withdrawn",
  why: Record<string, string>,
): Promise<RowRef> {
  await ctx.scope.to(row.business_id);
  const [moved] = await ctx.tx<{ version: number }[]>`
    update outbox_rows set state = ${to}, version = ${row.version + 1}
    where id = ${row.id} and version = ${row.version} and state = 'waiting_chat'
    returning version
  `;
  if (moved === undefined) {
    throw new Error("commitTurn: a waiting row moved while it was locked");
  }
  await appendEvent(ctx.tx, eventContext(ctx), {
    id: `${row.id}/${to}`,
    kind: "outbox_row.state_changed",
    zone: row.time_zone,
    businessId: row.business_id,
    actorKind: "rosie",
    tableName: "outbox_rows",
    rowId: row.id,
    oldValues: { state: "waiting_chat" },
    newValues: { state: to },
    why,
    at: ctx.now,
  });
  return { table: "outbox_rows", rowId: row.id, version: moved.version };
}

/** K-05 v1.1 item 19: the waiting rows this commit ends, found by the call itself, FOR UPDATE, so none is missed. */
async function writeWaitingChat(ctx: Context, request: CommitTurnRequest, out: Written): Promise<void> {
  const waiting = request.writes.waitingChat;
  if (waiting === undefined) {
    return;
  }
  const { tx } = ctx;
  if (waiting.supersede !== null) {
    // checkRequest held the answer row to this commit's own rows to that handle.
    const { recipientHandleId, answerRowId } = waiting.supersede;
    await ctx.scope.to(null);
    const rows = await tx<WaitingRow[]>`
      select r.id, r.version, r.business_id, r.booking_id, r.open_question_id, b.time_zone
      from outbox_rows r left join businesses b on b.id = r.business_id
      where r.state = 'waiting_chat' and r.recipient_handle_id = ${recipientHandleId}
      order by r.commit_seq
      for update of r
    `;
    for (const row of rows) {
      out.superseded.push(
        await endWaitingRow(ctx, row, "superseded", {
          followUp: "chatOpenAnswer",
          supersededBy: answerRowId,
        }),
      );
    }
  }
  const lists = [
    { ids: waiting.withdrawForBookings, column: "booking_id", why: "closedBooking" },
    { ids: waiting.withdrawForQuestions, column: "open_question_id", why: "closedQuestion" },
  ] as const;
  for (const list of lists) {
    if (list.ids.length === 0) {
      continue;
    }
    list.ids.forEach((id) => {
      assertId(id, `waitingChat's ${list.why} id`);
    });
    await ctx.scope.to(null);
    const rows = await tx<WaitingRow[]>`
      select r.id, r.version, r.business_id, r.booking_id, r.open_question_id, b.time_zone
      from outbox_rows r left join businesses b on b.id = r.business_id
      where r.state = 'waiting_chat' and ${tx(`r.${list.column}`)} in ${tx([...list.ids])}
      order by r.commit_seq
      for update of r
    `;
    for (const row of rows) {
      const closed = list.column === "booking_id" ? row.booking_id : row.open_question_id;
      out.withdrawn.push(await endWaitingRow(ctx, row, "withdrawn", { [list.why]: closed ?? "" }));
    }
  }
}

function eventContext(ctx: Context): {
  turnId: string;
  traceId: string;
  bundle: { hash: string; build: number };
} {
  return {
    turnId: ctx.turn.id,
    traceId: ctx.turn.traceId,
    bundle: { hash: ctx.turn.bundleId.hash, build: ctx.turn.bundleId.build },
  };
}

function base64Bytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/** The request's event-log entries (K-05 v1 eventEntry), each under its own business, with the turn's id, trace and bundle. */
async function writeEvents(ctx: Context, request: CommitTurnRequest): Promise<void> {
  for (const entry of request.writes.events) {
    assertId(entry.id, "events[].id");
    assertNullableId(entry.businessId, "events[].businessId");
    await ctx.scope.to(entry.businessId);
    const logEntry: LogEntry = {
      id: entry.id,
      kind: entry.kind,
      zone: entry.zone,
      businessId: entry.businessId,
      actorKind: entry.actorKind,
      actorPersonId: entry.actorPersonId,
      actorRole: entry.actorRole,
      tableName: entry.tableName,
      rowId: entry.rowId,
      oldValues: entry.oldValues as Given<LogEntry["oldValues"]>,
      newValues: entry.newValues as Given<LogEntry["newValues"]>,
      sealed:
        entry.sealed === null
          ? null
          : { forPersonId: entry.sealed.forPersonId, bytes: base64Bytes(entry.sealed.base64) },
      why: entry.why as Given<LogEntry["why"]>,
      approvedBy: entry.approvedBy as Given<LogEntry["approvedBy"]>,
      proofs: entry.proofs as Given<LogEntry["proofs"]>,
      at: ctx.now,
    };
    await appendEvent(ctx.tx, eventContext(ctx), logEntry);
  }
}

/** A table's state columns that name a row by a foreign key checked at the write, each with the list making such rows. */
type NamingColumns = readonly (readonly [column: string, list: "clockRows" | "outboxRows"])[];

/**
 * K-36 v1's columns that name a clock row or an outbox row by a foreign key checked at the write itself (0017:
 * hand_offs_alert_outbox_fk, hand_offs_clock_fk and team_pages_clock_fk, none deferrable), by table (default 17).
 */
const NAMES_A_MADE_ROW: ReadonlyMap<string, NamingColumns> = new Map<string, NamingColumns>([
  [
    "hand_offs",
    [
      ["alert_outbox_row_id", "outboxRows"],
      ["escalation_clock_row_id", "clockRows"],
    ],
  ],
  ["team_pages", [["next_page_clock_row_id", "clockRows"]]],
]);

/** The ids a list of the request gives its rows, each one that is text (the writes check every id). */
function idsOf(rows: readonly unknown[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (isRecord(row) && typeof row.id === "string") {
      ids.add(row.id);
    }
  }
  return ids;
}

/**
 * The request's state writes in the two places the commit writes them (default 17): `first`, K-05 item 1's place before
 * the open questions, and `afterRows`, right after the outbox rows: from the first hand_offs or team_pages write that
 * names a clock row or an outbox row this commit makes, every hand_offs and team_pages write, in the request's order.
 * Each write stays the request's own object (namedUpdates knows an update by it).
 */
function stateWritesInPlace(request: CommitTurnRequest): {
  readonly first: K05.StateWrite[];
  readonly afterRows: K05.StateWrite[];
} {
  const made = {
    clockRows: idsOf(request.writes.clockRows.make),
    outboxRows: idsOf(request.writes.outboxRows),
  };
  const first: K05.StateWrite[] = [];
  const afterRows: K05.StateWrite[] = [];
  for (const write of request.writes.state) {
    const columns = NAMES_A_MADE_ROW.get(write.table);
    const values: Row = write.op === "insert" ? write.values : write.set;
    const namesMadeRow =
      columns?.some(([column, list]) => {
        const id = values[column];
        return typeof id === "string" && made[list].has(id);
      }) ?? false;
    if (columns !== undefined && (namesMadeRow || afterRows.length > 0)) {
      afterRows.push(write);
    } else {
      first.push(write);
    }
  }
  return { first, afterRows };
}

/** The request with `state` for its state writes and every other list as it is: what writeState writes. */
function withState(request: CommitTurnRequest, state: K05.StateWrite[]): CommitTurnRequest {
  return { ...request, writes: { ...request.writes, state } };
}

// ---- 1. the turn, and a repeat ------------------------------------------------------------------------------------------

async function commitMoment(tx: Sql, options: CommitOptions): Promise<Date> {
  if (options.now !== undefined) {
    if (Number.isNaN(options.now.getTime())) {
      fail("now is not a valid date");
    }
    return options.now;
  }
  const [row] = await tx<{ now: Date }[]>`select now() as now`;
  if (row === undefined) {
    throw new Error("commitTurn: select now() returned no row");
  }
  return row.now;
}

/** A turn id met again: its first commit (K-05 item 1), or turnParked; nothing is written. */
async function repeatOf(tx: Sql, turnId: string): Promise<CommitTurnOutcome> {
  const [turn] = await tx<{ state: string; committed_at: Date | null; parked_at: Date | null }[]>`
    select state, committed_at, parked_at from turns where id = ${turnId}
  `;
  if (turn?.state === "parked" && turn.parked_at !== null) {
    return { error: "turnParked", turnId, parkedAt: utc(turn.parked_at) };
  }
  if (turn?.state !== "committed" || turn.committed_at === null) {
    throw new Error("commitTurn: the turn id is taken by a turn that is neither committed nor parked");
  }
  const rows = await tx<{ id: string; commit_seq: string | number }[]>`
    select id, commit_seq from outbox_rows where turn_id = ${turnId} order by commit_seq
  `;
  return {
    result: "committed",
    turnId,
    committedAt: utc(turn.committed_at),
    repeated: true,
    committed: {
      written: [],
      outboxRows: rows.map((row) => ({ id: row.id, commitSeq: commitSeqOf(row.commit_seq) })),
      promoted: [],
    },
  };
}

/**
 * The whole commit inside the transaction `tx` (the runtime side, no scope at its start), with the raise checkRequest
 * took from the request (null: it raises none).
 */
async function commitIn(
  tx: Sql,
  request: CommitTurnRequest,
  raise: Raise | null,
  options: CommitOptions,
): Promise<CommitTurnAskAgainOutcome> {
  const { turn } = request;
  const now = await commitMoment(tx, options);
  const inserted = await tx<{ id: string }[]>`
    insert into turns (
      id, handle_id, event_ids, state, bundle_hash, bundle_build, trace_id, joined_trace_ids, tries, committed_at
    ) values (
      ${turn.id}, ${turn.handleId}, ${turn.eventIds}, 'committed', ${turn.bundleId.hash}, ${turn.bundleId.build},
      ${turn.traceId}, ${turn.joinedTraceIds}, ${turn.tries}, ${now}
    )
    on conflict (id) do nothing
    returning id
  `;
  if (inserted.length === 0) {
    return repeatOf(tx, turn.id);
  }

  const ctx: Context = {
    tx,
    call: "commitTurn",
    now,
    at: utc(now),
    turn,
    scope: new Scope(tx),
    tables: new Map(),
    answerNames: answerNamesOf(request),
    namedUpdates: new Map(),
    raise,
  };
  const compared = await lockAndCompare(ctx, request);
  const out: Written = { written: [], outboxRows: [], promoted: [], superseded: [], withdrawn: [] };
  // A K-36 state write that names a clock row or an outbox row of this commit waits for it (default 17).
  const state = stateWritesInPlace(request);
  await writeState(ctx, withState(request, state.first), compared, out);
  await writeOpenQuestions(ctx, request, compared, out);
  await writeClockRows(ctx, request, compared, out);
  await writeOutboxRows(ctx, request, out);
  await writeState(ctx, withState(request, state.afterRows), compared, out);
  await writeReservations(ctx, request, compared, out);
  await writeEffects(ctx, request, compared, out);
  await writeWaitingChat(ctx, request, out);
  await writeEvents(ctx, request);

  const ended = out.superseded.length + out.withdrawn.length > 0;
  return {
    result: "committed",
    turnId: turn.id,
    committedAt: ctx.at,
    repeated: false,
    committed: {
      written: out.written,
      outboxRows: out.outboxRows,
      promoted: out.promoted,
      ...(ended ? { waitingChat: { superseded: out.superseded, withdrawn: out.withdrawn } } : {}),
    },
  };
}

/** A database rule's refusal as K-05's constraint answer: the SQLSTATE and the constraint's name, nothing else. */
function constraintOf(error: unknown): K05.ConstraintError | null {
  const failure = error as { code?: unknown; constraint_name?: unknown } | null | undefined;
  const code = failure?.code;
  const constraint = failure?.constraint_name;
  if (typeof code === "string" && CONSTRAINT_SQLSTATES.has(code) && typeof constraint === "string") {
    if (NAME.test(constraint)) {
      return { error: "constraint", sqlstate: code, constraint };
    }
  }
  return null;
}

/**
 * Any other refusal by the database, as it leaves this call: its SQLSTATE and the names of its table and constraint,
 * never PostgresError's message, detail or query, which can hold a row's values (STATE's notes for later cards, 3).
 */
export class CommitTurnDatabaseError extends Error {
  readonly code: string;
  readonly table: string | null;
  readonly constraint: string | null;

  constructor(code: string, table: string | null, constraint: string | null) {
    const names = [
      table === null ? "" : `, table ${table}`,
      constraint === null ? "" : `, constraint ${constraint}`,
    ];
    super(`commitTurn: the database refused the commit (SQLSTATE ${code}${names.join("")})`);
    this.code = code;
    this.table = table;
    this.constraint = constraint;
    this.name = "CommitTurnDatabaseError";
  }
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

function nameOrNull(value: unknown): string | null {
  return typeof value === "string" && NAME.test(value) ? value : null;
}

/**
 * An error the commit throws, as it leaves this call (T-1339, as clocks.ts's scrubbed does: T-1268): PostgreSQL's
 * refusal (a PostgresError with a SQLSTATE) as CommitTurnDatabaseError, its SQLSTATE and the names of its table and
 * constraint; an error of the database client as a new Error that carries the call's name and the client's code alone
 * (`call`, `code`: a plain code such as UNDEFINED_VALUE or ERR_INVALID_ARG_TYPE, or null), with no message, stack,
 * cause or property of the original's; db/repo's own errors as they are.
 *
 * The client's error is never passed on. postgres.js puts the statement on every error it rejects a statement with
 * (query, parameters, args, types, and the statement's origin on its stack), and args holds the statement's values, a
 * row's among them: its own UNDEFINED_VALUE (a value that is undefined) and the TypeError a serializer throws for a value
 * it cannot send (the bytea serializer's message quotes the value) carry them, and transientOrThrow lets both through as
 * it lets a statement's refusal through. Such an error is known by those properties or by a mark of a connection
 * (address, port, hostname, host, cert, errors, syscall, errno), which db/repo's own errors never carry; a PostgresError
 * with no SQLSTATE goes the same way. A session's failure never reaches here: transientOrThrow throws it scrubbed.
 */
function scrubbed(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const failure = error as Error & { code?: unknown; table_name?: unknown; constraint_name?: unknown };
  if (error.name === "PostgresError" && typeof failure.code === "string" && SQLSTATE.test(failure.code)) {
    return new CommitTurnDatabaseError(
      failure.code,
      nameOrNull(failure.table_name),
      nameOrNull(failure.constraint_name),
    );
  }
  const clientFields = [
    "query",
    "parameters",
    "args",
    "types",
    "address",
    "port",
    "hostname",
    "host",
    "cert",
    "errors",
    "syscall",
    "errno",
  ];
  if (error.name !== "PostgresError" && !clientFields.some((field) => Object.hasOwn(error, field))) {
    return error;
  }
  const code =
    typeof failure.code === "string" && /^[A-Z0-9_]{1,64}$/.test(failure.code) ? failure.code : null;
  return Object.assign(
    new Error(`commitTurn: the database call failed (${code === null ? "no code" : `code ${code}`})`),
    { call: "commitTurn", code },
  );
}

/**
 * Commits a turn (K-05 v1.1 item 1): one transaction on the primary, on the runtime side with the business scope set per
 * write. Pass the client's primary handle, run as rosie_job. Answers committed (repeated true for a turn id already
 * committed, which writes nothing), or a refusal that wrote nothing: versionChanged (limit 4), reservationLost (limit
 * 5), turnParked, wrongState (an effect let go not in outage), constraint (a database rule) or transient. A request
 * that carries answerPhoneRowsBy "handleId" (K-05 v1.17 item 71) is answered with every phones row it names (written,
 * versionChanged's changed) named by its handle id; without the field the answer is v1.16's. Throws for a request it
 * cannot carry out (see the top of this file), a database error as CommitTurnDatabaseError; nothing is written then
 * either.
 *
 * Two overloads (K-05 v1.21 item 81 and default 199; T-1509): a request that asks an open question again
 * (writes.openQuestions.askAgain given) may also answer v1.21's wrongState for that question, when it is not live; a
 * request with no askAgain is v1.20's call and keeps v1.20's answer type, since a commit that raises nothing never answers
 * that wrongState.
 */
export async function commitTurn(
  sql: Sql,
  request: CommitTurnAskAgainRequest,
  options?: CommitOptions,
): Promise<CommitTurnAskAgainOutcome>;
export async function commitTurn(
  sql: Sql,
  request: CommitTurnRequest & RaisesNothing,
  options?: CommitOptions,
): Promise<CommitTurnOutcome>;
export async function commitTurn(
  sql: Sql,
  request: CommitTurnRequest | CommitTurnAskAgainRequest,
  options: CommitOptions = {},
): Promise<CommitTurnAskAgainOutcome> {
  const raise = checkRequest(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: false }, (tx) =>
      commitIn(tx, request, raise, options),
    );
  } catch (error) {
    if (error instanceof Refused) {
      return error.answer;
    }
    const refused = constraintOf(error);
    if (refused !== null) {
      return refused;
    }
    try {
      return transientOrThrow(error, "commitTurn");
    } catch (thrown) {
      // transientOrThrow throws a session's failure already scrubbed (T-1268): that goes on as it is. What it lets
      // through unchanged (a statement's own refusal) is scrubbed here, as before.
      throw thrown === error ? scrubbed(error) : thrown;
    }
  }
}
