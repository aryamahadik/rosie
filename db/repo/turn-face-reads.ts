// Data-access v1.3: the three reads the Tool API's turn face binds (K-05 v1.3 items 34 to 36; T-1137, T-1138; DL-319,
// DL-326). Their callers are the commit (C-087), compose input (C-090), finalize (C-093) and the fixed-line inserter
// (C-089), each bound in the turn face by T-1141.
//
//   readOpenHolds       what is open on the turn's handle at commit time (the commit's OpenHolds; item 34): the open
//                       safety holds (K-34 safety_holds, released_at null: safety_holds_open_handle_idx) on the handle at
//                       the call's business, in held_at order, a tie to the lower id, each with its release rule and where
//                       it came from; and, of the texts the caller names, each that no safety_outcomes row the scope shows
//                       names (safety_outcomes_event_key), in the request's order: a row the scope hides counts as
//                       missing, so the read fails closed (default 44). A released hold is not open (default 45).
//   readOutboxRow       an outbox row as compose input and finalize read it (item 35): the row (never its plan); its step
//                       and line from the question it asks (line 0), or null for a row that asks none, never a guess
//                       (default 48); its reader (the handle's kind, the person's stored name and language, their live
//                       roles at the row's business, the phone's flags); the turn's texts by event id with their safety
//                       results (never their words: default 47); the slot source K-04 holds (the business head, the
//                       booking head, the question with its clock row); the row's business's sensitive switch (v1.6 item
//                       45, T-1197: below); and the other questions still open with the reader, each with the words part
//                       of the newest asking row that has gone (item 26's rule, default 41; default 51). A row of send
//                       class safety answers fixedLineRow and nothing else (default 49). Every answer is v1.6's
//                       readOutboxRow.v1dot6Response: businessSensitive is always stated, true, false or null.
//                       A row with no turn (K-04 v1.1's job row, such as a sign-in code's email row: turn_id null, a job
//                       id in its place) answers notFound, table outbox_rows, as soon as the row is read: before its
//                       send class, its reader, its turn or anything else, and nothing of it is returned (K-05 v1.13
//                       item 65; ADR-016 section 1's reader table and open point 12; card R0, T-1279; default 4).
//   readFixedLineFacts  the fixed-line facts of a row's own handle and business (item 36): whether Rosie texted the handle
//                       about the business before (K-04's opener mark naming another row; with no business, an earlier row
//                       to the handle with no business whose final parts carry the opener: default 50), the row the opener
//                       went on, and when the opt-out line was first delivered to the handle's phone.
//
// Roles and scope (items 34 to 36; K-04 v1 rule 4; STATE notes 5 and 22; DL-326). The role is the connection's: the
// caller passes the client of the role the read names.
//   readOpenHolds with a business runs as the Tool API's role, rosie_app, under that business's scope: both tables it
//   reads are business-scoped and rosie_app holds SELECT on them (0016). With businessId null it runs on the runtime side,
//   as rosie_job with no scope. rosie_app sees no row without a scope, so there it would answer "nothing open" whatever
//   is open: the call refuses to run with no business on a role that holds rosie_app's rights and not rosie_job's.
//   readOutboxRow and readFixedLineFacts run as rosie_job, since they read tables only the runtime side holds (turns,
//   persons, handles, phones, outbox_parts: 0012). With a business, its scope is set and then confirmed by
//   requireBusinessScope() before the first read (with no scope rosie_job reads every business's rows: T-1094's note N2);
//   with businessId null they run on the runtime side, with no scope.
//   Besides the scope, every read of a business-scoped table names the business (with none: no business), so an answer
//   holds no other business's row even for a role row-level security does not bind (a table's owner).
//
// What these reads never touch (item 35's reason 1; DL-326 note a): no statement here names messages.words,
// safety_outcomes.sealed_words, handles.address, phones.number or any sealing_keys column, and none selects `*`. rosie_job
// holds SELECT on all five of those tables (0012, 0016) and one Worker holds every secret, so each statement's column
// list is the barrier; the integration test reads every statement the three reads send and checks it. No answer carries
// a sealed value, the words of a text, an address, a number, a key or a wrapping key's name: the words a row answers are
// handed in by the runtime caller (default 47), and "the words as sent" of an open question are Rosie's own, from the
// asking row's stored final parts. Of K-23's company_kinds the read names business_id, pf_switches_a and pf_switches_b
// alone, and answers the switch's one value, never a kind of work, its facts, its trade name or another switch
// (v1.6 default 69).
//
// The sensitive switch (K-05 v1.6 item 45; RULES 4.6; S13-22; DL-391), read in readOutboxRow's own transaction, as
// rosie_job under the row's business (company_kinds is business-scoped, and rosie_job reads it behind its runtime
// policy: 0019), naming the business beside the scope (company_kinds_business_idx). A kind of work turns the switch on
// when pf_switches_a or pf_switches_b lists K-26's name for it, sensitive (plugin_switches, 0023; code writes only
// registry names there, and the database checks them for form alone):
//   - true when any of the business's kinds of work lists it, in either flow (default 66: the stricter wins);
//   - false only when the business has kinds of work and each one's two lists were read and neither lists it;
//   - null when it has none (a sign-up before S1-04 writes them), and for a row with no business, for which no
//     company_kinds row is read at all (default 68: a kind whose business is null is a sign-up's, never the row's).
// A NULL element in a list (0019's names check lets one through, since array_to_string skips it) leaves that kind's
// answer unknown, PostgreSQL's three-valued `= any`, and it is never taken as off: with no kind that lists the switch the
// answer is null, which the caller reads as on (default 67; the security review's N2 on T-1196). bool_or skips a NULL
// input, so the unknown kinds are kept apart rather than folded into false. A read that fails is never an answer: it
// fails the whole call, as every other read here does (transient, or thrown).
//
// Reads (arch 10 lines 504, 538): the primary, uncached, in one read-only transaction at repeatable read, so an answer is
// one moment's. Ids are compared byte by byte (collate "C"), never parsed (CQ-09). A serialization failure, a deadlock or
// a lost connection answers transient. Nothing here logs; an error names a call, a field, a table or a column, never a
// value or an id.
//
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. A question's clock row is its first live one (waiting or armed) of kind question, in id order, else its first:
//      clocks.ts's rule for armClock (lockQuestionClock), so the read and the arming name the same row.
//   2. A stored record the answer would have to guess around throws BrokenRecordError rather than answer half (fail
//      closed): a row whose turn, recipient handle, recipient person or business is missing; whose booking or question is
//      not under the row's business (with no business, a row that names a booking, since every booking has one); or a
//      question still open with the reader whose newest asking row that has gone carries no words part.
//   3. "The words part" of an asking row's final parts is its first send of kind words with a non-empty text (K-03 v1
//      finalParts: the words first, then one poll or card).
//   4. A row with no turn answers notFound whatever its send class, a safety row's included (T-1279): item 65 is the
//      rule for the kind of row v1.3 never held, while v1.3's rules, default 49's fixedLineRow among them, were made for
//      the rows it held, every one with a turn. So the check comes before the send class's, and the answer holds
//      nothing of the row, not even its class. A job row is never composed or finalized: no caller names one (the
//      code row is written checked and never goes stale), and with no turn there are no texts to answer.
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.3";
import type * as K05v1dot6 from "../../contracts/generated/data-access/data-access.v1.6";
import { transientOrScrubbed } from "./clocks";
import {
  assertBusinessId,
  BusinessScopeError,
  readBusinessScope,
  requireBusinessScope,
  SCOPE_SETTING,
  type Sql,
  type Tx,
} from "./scope";
import {
  assertId,
  assertRequestShape,
  inRuntimeTransaction,
  type NotFoundError,
  readMoment,
  type ReadOptions,
  type TransientError,
  utc,
  utcOrNull,
} from "./targets";

type Db = Sql | Tx;

// ---- the requests and the answers (data-access.v1.3.schema.json; readOutboxRow's answer, v1.6's) --------------------

export type ReadOpenHoldsRequest = K05.ReadOpenHoldsRequest;
export type ReadOpenHoldsResponse = K05.ReadOpenHoldsResponse;
export type OpenHold = K05.OpenHold;
export type ReadOpenHoldsOutcome = ReadOpenHoldsResponse | NotFoundError | TransientError;

export type ReadOutboxRowRequest = K05.ReadOutboxRowRequest;
/**
 * K-05 v1.6 readOutboxRow.v1dot6Response (item 45): the answer readOutboxRow gives, v1.3's fields (item 35) with
 * businessSensitive always stated, true, false or null.
 */
export type ReadOutboxRowV1Dot6Response = K05v1dot6.ReadOutboxRowV1Dot6Response;
/**
 * K-05 v1.6 readOutboxRow.response: the same fields with businessSensitive optional, for a consumer that also reads a
 * v1.3 to v1.5 answer, which has none and reads as null, on (default 67). readOutboxRow itself always states it.
 */
export type ReadOutboxRowResponse = K05v1dot6.ReadOutboxRowResponse;
/** K-05 v1.3 fixedLineRowError: a safety row, never composed nor finalized; nothing else is returned. */
export type FixedLineRowError = K05.FixedLineRowError;
export type ReadOutboxRowOutcome =
  ReadOutboxRowV1Dot6Response | NotFoundError | FixedLineRowError | TransientError;

export type ReadFixedLineFactsRequest = K05.ReadFixedLineFactsRequest;
export type ReadFixedLineFactsResponse = K05.ReadFixedLineFactsResponse;
export type ReadFixedLineFactsOutcome = ReadFixedLineFactsResponse | NotFoundError | TransientError;

type RowRead = ReadOutboxRowV1Dot6Response["row"];
type SlotSource = ReadOutboxRowV1Dot6Response["slotSource"];
type Answers = ReadOutboxRowV1Dot6Response["answers"];
type AnsweredText = Answers["texts"][number];
type RowRecipient = ReadOutboxRowV1Dot6Response["recipient"];
type RowQuestion = NonNullable<SlotSource["question"]>;
type BusinessSensitive = ReadOutboxRowV1Dot6Response["businessSensitive"];

/**
 * A stored record one of these reads cannot answer from without guessing (default 2): the read fails closed rather than
 * answer half. Its message names the call and what is missing, never a value or an id.
 */
export class BrokenRecordError extends Error {
  override name = "BrokenRecordError";
}

/** K-01 v1's opener line (arch 07 line 361; S13-01), as finalize's fixed-line inserter names it (C-089). */
const OPENER_LINE = "opener";
/** K-03 v1's send kind that carries the words (finalParts sends). */
const WORDS_SEND = "words";

const notFound = (table: string, rowId: string): NotFoundError => ({ error: "notFound", table, rowId });

// ---- the requests' shape -------------------------------------------------------------------------------------------

const OPEN_HOLDS_FIELDS = ["handleId", "businessId", "eventIds"] as const;
const ROW_FIELDS = ["outboxRowId", "businessId"] as const;

/** The request's fields, refused unless it has exactly `fields`; names the field, never a value. */
function fieldsOf(request: unknown, call: string, fields: readonly string[]): Record<string, unknown> {
  assertRequestShape(request, call, fields);
  const values = request as Record<string, unknown>;
  for (const field of fields) {
    if (!Object.hasOwn(values, field)) {
      throw new TypeError(`${call}: the request needs ${field}`);
    }
  }
  return values;
}

/** The business the call runs under, or null before there is one: always stated (STATE note 22; CQ-70). */
function checkBusinessId(value: unknown): void {
  if (value !== null) {
    assertId(value, "businessId");
    assertBusinessId(value);
  }
}

/** Refuses a request that is not readOpenHolds.request's shape (`refuse-open-holds-no-scope` among them). */
function checkOpenHoldsRequest(request: unknown): asserts request is ReadOpenHoldsRequest {
  const values = fieldsOf(request, "readOpenHolds", OPEN_HOLDS_FIELDS);
  assertId(values.handleId, "handleId");
  checkBusinessId(values.businessId);
  const { eventIds } = values;
  if (!Array.isArray(eventIds)) {
    throw new TypeError("readOpenHolds: eventIds is a list");
  }
  const seen = new Set<string>();
  for (const eventId of eventIds as unknown[]) {
    assertId(eventId, "each of eventIds");
    if (seen.has(eventId)) {
      throw new TypeError("readOpenHolds: eventIds names each text once");
    }
    seen.add(eventId);
  }
}

/**
 * Refuses a request that is not readOutboxRow.request's or readFixedLineFacts.request's shape: the row and the business,
 * nothing else, so no caller names a handle (`refuse-fixed-line-facts-caller-handle`).
 */
function checkRowRequest(
  request: unknown,
  call: string,
): asserts request is { outboxRowId: string; businessId: string | null } {
  const values = fieldsOf(request, call, ROW_FIELDS);
  assertId(values.outboxRowId, "outboxRowId");
  checkBusinessId(values.businessId);
}

// ---- the side a read runs on ---------------------------------------------------------------------------------------

/** Refuses a transaction on the wrong side: the request's own business scope, or with no business no scope at all. */
async function assertSide(db: Db, call: string, businessId: string | null): Promise<void> {
  if (businessId === null) {
    if ((await readBusinessScope(db)) !== null) {
      throw new BusinessScopeError(
        `${call} with no business runs on the runtime side: a business scope hides the rows with none`,
      );
    }
    return;
  }
  if ((await requireBusinessScope(db)) !== businessId) {
    throw new BusinessScopeError(`${call} runs under the request's own business scope`);
  }
}

/**
 * Refuses a role that holds rosie_app's rights and not rosie_job's: with no scope it sees no business-scoped row, so a
 * hold read with no business would answer "nothing open" whatever is open (the database engineer's note 4 on T-1137).
 * rosie_job, and a role row-level security does not bind (a table's owner), read every row with no scope.
 */
async function assertRuntimeRole(db: Db): Promise<void> {
  const [rights] = await db<{ app: boolean; job: boolean }[]>`
    select pg_has_role(current_user, 'rosie_app', 'USAGE') as app,
           pg_has_role(current_user, 'rosie_job', 'USAGE') as job
  `;
  if (rights === undefined || (rights.app && !rights.job)) {
    throw new BusinessScopeError(
      "readOpenHolds with no business runs on the runtime side, as rosie_job: rosie_app sees no row without a scope",
    );
  }
}

/**
 * One read-only transaction at repeatable read on `sql`: on the runtime side (the scope cleared) with no business, else
 * under the business's scope, set first and still the same when the read ends.
 */
async function onSide<T>(
  sql: Sql,
  call: string,
  businessId: string | null,
  read: (tx: Sql) => Promise<T>,
): Promise<T> {
  return inRuntimeTransaction(sql, { readOnly: true }, async (tx) => {
    if (businessId === null) {
      return read(tx);
    }
    await tx`select set_config(${SCOPE_SETTING}, ${businessId}, true)`;
    const outcome = await read(tx);
    if ((await requireBusinessScope(tx)) !== businessId) {
      throw new BusinessScopeError(`${call} must end under the business scope it began with`);
    }
    return outcome;
  });
}

// ---- readOpenHolds (item 34) ---------------------------------------------------------------------------------------

interface HoldRow {
  id: string;
  release_rule: OpenHold["releaseRule"];
  blocks_booking: boolean;
  safety_outcome_id: string;
  booking_id: string | null;
  turn_id: string | null;
  held_at: Date;
  version: number;
}

const toHold = (row: HoldRow): OpenHold => ({
  holdId: row.id,
  releaseRule: row.release_rule,
  blocksBooking: row.blocks_booking,
  safetyOutcomeId: row.safety_outcome_id,
  bookingId: row.booking_id,
  turnId: row.turn_id,
  heldAt: utc(row.held_at),
  version: row.version,
});

/**
 * What is open on the turn's handle, inside the transaction `db`, which must already run on the request's side: under
 * the request's business scope (as rosie_app, the Tool API's call transaction), or with businessId null on the runtime
 * side, with no scope, as rosie_job. It should be read-only at repeatable read, so the answer is one moment's. Prefer
 * readOpenHolds(); this is for a caller that already holds such a transaction, such as the commit's (C-087).
 */
export async function readOpenHoldsIn(
  db: Db,
  request: ReadOpenHoldsRequest,
  options: ReadOptions = {},
): Promise<ReadOpenHoldsResponse | NotFoundError> {
  checkOpenHoldsRequest(request);
  const { handleId, businessId, eventIds } = request;
  await assertSide(db, "readOpenHolds", businessId);
  if (businessId === null) {
    await assertRuntimeRole(db);
  } else {
    // Never "nothing open" under a business that is not there, or that its own scope does not show.
    const [business] = await db<{ id: string }[]>`select id from businesses where id = ${businessId}`;
    if (business === undefined) {
      return notFound("businesses", businessId);
    }
  }
  const readAt = await readMoment(db, options);
  const holds = await db<HoldRow[]>`
    select id, release_rule, blocks_booking, safety_outcome_id, booking_id, turn_id, held_at, version
    from safety_holds
    where handle_id = ${handleId}
      and released_at is null
      and business_id is not distinct from ${businessId}
    order by held_at, id collate "C"
  `;
  const read =
    eventIds.length === 0
      ? []
      : await db<{ event_id: string }[]>`
          select event_id
          from safety_outcomes
          where event_id in ${db([...eventIds])}
            and business_id is not distinct from ${businessId}
        `;
  const withSafetyRow = new Set(read.map((row) => row.event_id));
  return {
    result: "openHolds",
    handleId,
    businessId,
    readAt: utc(readAt),
    holds: holds.map(toHold),
    unreadEventIds: eventIds.filter((eventId) => !withSafetyRow.has(eventId)),
  };
}

/**
 * What is open on a turn's handle at commit time (K-05 v1.3 item 34), for the commit's OpenHolds: one read-only
 * transaction at repeatable read on the primary, uncached. Pass the Tool API's client (rosie_app) with a business, and the
 * runtime's (rosie_job) with businessId null. notFound (table businesses) when the business does not exist or its scope
 * does not show it; transient on a serialization failure, a deadlock or a lost connection. A request of the wrong shape
 * throws a TypeError, a read on the wrong side a BusinessScopeError; the commit fails closed on any of them.
 */
export async function readOpenHolds(
  sql: Sql,
  request: ReadOpenHoldsRequest,
  options: ReadOptions = {},
): Promise<ReadOpenHoldsOutcome> {
  checkOpenHoldsRequest(request);
  try {
    return await onSide(sql, "readOpenHolds", request.businessId, (tx) =>
      readOpenHoldsIn(tx, request, options),
    );
  } catch (error) {
    // A statement's own refusal and postgres.js's statement errors leave scrubbed too: the call's name and the code
    // alone, never the statement's values (T-1322; clocks.ts transientOrScrubbed).
    return transientOrScrubbed("readOpenHolds", error);
  }
}

// ---- readOutboxRow (item 35) ---------------------------------------------------------------------------------------

interface OutboxRowRow {
  id: string;
  /** Null for a row with no turn (K-04 v1.1: its job id stands in its place), which the read answers notFound. */
  turn_id: string | null;
  recipient_handle_id: string;
  recipient_person_id: string | null;
  business_id: string | null;
  booking_id: string | null;
  channel: RowRead["channel"];
  send_class: RowRead["sendClass"] | "safety";
  open_question_id: string | null;
  copy_of_row_id: string | null;
  has_plan: boolean;
  final_parts: RowRead["finalParts"];
  state: RowRead["state"];
  bundle_hash: string;
  bundle_build: number;
  version: number;
}

/** A row a turn committed: the only kind the read goes on to read (K-05 v1.13 item 65; default 4). */
type TurnRow = OutboxRowRow & { turn_id: string };

/** Whether a turn committed the row; a row with no turn (K-04 v1.1's job row) carries a job id in its place. */
const hasTurn = (row: OutboxRowRow): row is TurnRow => row.turn_id !== null;

interface PhoneRow {
  stopped: boolean;
  chat_open: boolean;
  chat_way: NonNullable<RowRecipient["phone"]>["chatWay"];
  poll_voted_at: Date | null;
  version: number;
}

interface SafetyRow {
  event_id: string;
  outcomes: NonNullable<AnsweredText["outcomes"]>;
  tenses: NonNullable<AnsweredText["tenses"]>;
}

interface BookingRow {
  id: string;
  business_id: string;
  flow: "A" | "B";
  stage: NonNullable<SlotSource["booking"]>["stage"];
  booker_person_id: string;
  served_person_id: string | null;
  payer_person_id: string | null;
  private: boolean;
  deceased: boolean;
  version: number;
}

interface QuestionRow {
  id: string;
  step: string;
  status: RowQuestion["status"];
  options: RowQuestion["options"];
  readback: string | null;
  clock: string | null;
  ask_count: number;
  version: number;
}

interface ClockRow {
  id: string;
  state: NonNullable<RowQuestion["clockRow"]>["state"];
  due_at: Date | null;
  due_zone: string | null;
  version: number;
}

/** The reader: the handle's kind (never its address), the person as stored, their live roles here, the phone's flags. */
async function recipientOf(db: Db, row: OutboxRowRow): Promise<RowRecipient> {
  const [handle] = await db<{ kind: RowRecipient["kind"] }[]>`
    select kind from handles where id = ${row.recipient_handle_id}
  `;
  if (handle === undefined) {
    throw new BrokenRecordError("readOutboxRow: the row's recipient handle is missing");
  }
  const personId = row.recipient_person_id;
  let person: { name: string | null; language: string | null } = { name: null, language: null };
  if (personId !== null) {
    const [stored] = await db<{ name: string | null; language: string | null }[]>`
      select name, language from persons where id = ${personId}
    `;
    if (stored === undefined) {
      throw new BrokenRecordError("readOutboxRow: the row's recipient person is missing");
    }
    person = stored;
  }
  const roles =
    personId === null || row.business_id === null
      ? []
      : await db<{ id: string; role: RowRecipient["roles"][number]["role"]; version: number }[]>`
          select id, role, version
          from person_roles
          where person_id = ${personId} and business_id = ${row.business_id} and ended_at is null
          order by id collate "C"
        `;
  // An email handle has no phone row (K-04 phones_handle_fk names a number); a number may have none yet.
  const [phone] =
    handle.kind === "phone"
      ? await db<PhoneRow[]>`
          select stopped, chat_open, chat_way, poll_voted_at, version
          from phones
          where handle_id = ${row.recipient_handle_id}
        `
      : [];
  return {
    handleId: row.recipient_handle_id,
    kind: handle.kind,
    personId,
    name: person.name,
    storedLanguage: person.language,
    roles: roles.map((role) => ({ roleId: role.id, role: role.role, version: role.version })),
    phone:
      phone === undefined
        ? null
        : {
            stopped: phone.stopped,
            chatOpen: phone.chat_open,
            chatWay: phone.chat_way,
            pollVotedAt: utcOrNull(phone.poll_voted_at),
            version: phone.version,
          },
  };
}

/**
 * The turn that committed the row: the handle its texts came from, each text by event id with its safety result. Only
 * a row a turn committed reaches it (item 65: a row with no turn answers notFound first).
 */
async function answersOf(db: Db, row: TurnRow): Promise<Answers> {
  const [turn] = await db<{ handle_id: string; event_ids: string[] }[]>`
    select handle_id, event_ids from turns where id = ${row.turn_id}
  `;
  if (turn === undefined) {
    throw new BrokenRecordError("readOutboxRow: the row's turn is missing");
  }
  const safety =
    turn.event_ids.length === 0
      ? []
      : await db<SafetyRow[]>`
          select event_id, outcomes, tenses
          from safety_outcomes
          where event_id in ${db([...turn.event_ids])}
            and business_id is not distinct from ${row.business_id}
        `;
  const byEvent = new Map(safety.map((outcome) => [outcome.event_id, outcome]));
  const [first, ...rest] = turn.event_ids.map((eventId): AnsweredText => ({
    eventId,
    outcomes: byEvent.get(eventId)?.outcomes ?? null,
    tenses: byEvent.get(eventId)?.tenses ?? null,
  }));
  if (first === undefined) {
    throw new BrokenRecordError("readOutboxRow: the row's turn names no text");
  }
  return { handleId: turn.handle_id, texts: [first, ...rest] };
}

/** The question the row asks, with its clock row (default 1), under the row's business. */
async function questionOf(db: Db, questionId: string, businessId: string | null): Promise<RowQuestion> {
  const [question] = await db<QuestionRow[]>`
    select id, step, status, options, readback, clock, ask_count, version
    from open_questions
    where id = ${questionId} and business_id is not distinct from ${businessId}
  `;
  if (question === undefined) {
    throw new BrokenRecordError("readOutboxRow: the row's open question is not under the row's business");
  }
  const clocks = await db<ClockRow[]>`
    select id, state, due_at, due_zone, version
    from clock_rows
    where open_question_id = ${questionId}
      and kind = 'question'
      and business_id is not distinct from ${businessId}
    order by id collate "C"
  `;
  const clock = clocks.find((row) => row.state === "waiting" || row.state === "armed") ?? clocks[0];
  return {
    id: question.id,
    step: question.step,
    status: question.status,
    options: question.options,
    readback: question.readback,
    clock: question.clock,
    askCount: question.ask_count,
    version: question.version,
    clockRow:
      clock === undefined
        ? null
        : {
            id: clock.id,
            state: clock.state,
            dueAt: utcOrNull(clock.due_at),
            dueZone: clock.due_zone,
            version: clock.version,
          },
  };
}

/** The record the row's slots are filled from, as far as K-04 holds it: business head, booking head, question. */
async function slotSourceOf(db: Db, row: OutboxRowRow): Promise<SlotSource> {
  let business: SlotSource["business"] = null;
  if (row.business_id !== null) {
    const [head] = await db<
      { id: string; name: string; display_name: string; time_zone: string; version: number }[]
    >`
      select id, name, display_name, time_zone, version from businesses where id = ${row.business_id}
    `;
    if (head === undefined) {
      throw new BrokenRecordError("readOutboxRow: the row's business is missing");
    }
    business = {
      id: head.id,
      name: head.name,
      displayName: head.display_name,
      timeZone: head.time_zone,
      version: head.version,
    };
  }
  let booking: SlotSource["booking"] = null;
  if (row.booking_id !== null) {
    const [head] = await db<BookingRow[]>`
      select id, business_id, flow, stage, booker_person_id, served_person_id, payer_person_id, private, deceased,
             version
      from bookings
      where id = ${row.booking_id} and business_id is not distinct from ${row.business_id}
    `;
    if (head === undefined) {
      throw new BrokenRecordError("readOutboxRow: the row's booking is not under the row's business");
    }
    booking = {
      id: head.id,
      businessId: head.business_id,
      flow: head.flow,
      stage: head.stage,
      bookerPersonId: head.booker_person_id,
      servedPersonId: head.served_person_id,
      payerPersonId: head.payer_person_id,
      private: head.private,
      deceased: head.deceased,
      version: head.version,
    };
  }
  const question =
    row.open_question_id === null ? null : await questionOf(db, row.open_question_id, row.business_id);
  return { business, booking, question };
}

/** The words part's text of stored final parts (default 3), or null when they carry none. */
function wordsOf(finalParts: unknown): string | null {
  const sends = (finalParts as { sends?: unknown } | null)?.sends;
  if (!Array.isArray(sends)) {
    return null;
  }
  for (const send of sends as unknown[]) {
    const { kind, text } = (send ?? {}) as { kind?: unknown; text?: unknown };
    if (kind === WORDS_SEND && typeof text === "string" && text !== "") {
      return text;
    }
  }
  return null;
}

/**
 * The other live questions sent to the reader's handle at the row's business that have gone, in id order, each with the
 * words part of the newest asking row to that handle that has gone (a part sent or delivered). The asking rows are read
 * through the handle's rows (outbox_rows_recipient_order_idx), newest first, since outbox_rows has no index on
 * open_question_id; of outbox_parts only the state of each row's parts is read, by the row's key. The parts check is a
 * subquery per row, not EXISTS: PostgreSQL turns EXISTS into a semi-join it may start from outbox_parts, a scan of every
 * part ever sent, where this way the scan starts from the handle's newest row and stops at the first that has gone.
 */
async function openQuestionsOf(db: Db, row: OutboxRowRow): Promise<ReadOutboxRowResponse["openQuestions"]> {
  const questions = await db<{ id: string; step: string; final_parts: unknown }[]>`
    select q.id, q.step, went.final_parts
    from open_questions q
    join lateral (
      select r.final_parts
      from outbox_rows r
      where r.recipient_handle_id = ${row.recipient_handle_id}
        and r.open_question_id = q.id
        and r.business_id is not distinct from ${row.business_id}
        and (
          select true from outbox_parts p
          where p.outbox_row_id = r.id and p.state in ('sent', 'delivered')
          limit 1
        )
      order by r.commit_seq desc
      limit 1
    ) went on true
    where q.handle_id = ${row.recipient_handle_id}
      and q.status in ('waiting', 'open')
      and q.business_id is not distinct from ${row.business_id}
      and q.id is distinct from ${row.open_question_id}
    order by q.id collate "C"
  `;
  return questions.map((question) => {
    const text = wordsOf(question.final_parts);
    if (text === null) {
      throw new BrokenRecordError(
        "readOutboxRow: a question still open with the reader went with no words part",
      );
    }
    return { id: question.id, step: question.step, text };
  });
}

/**
 * The row's business's sensitive switch (v1.6 item 45; see the top of this file): of K-23's company_kinds under the
 * row's business, whether any kind of work lists K-26's sensitive in pf_switches_a or pf_switches_b (`listed`), and
 * whether any kind's answer is unknown, a list holding a NULL element and not the switch (`unknown`). Over no rows both
 * aggregates are null. With no business, no company_kinds row is read (default 68).
 */
async function businessSensitiveOf(db: Db, businessId: string | null): Promise<BusinessSensitive> {
  if (businessId === null) {
    return null;
  }
  const [kinds] = await db<{ listed: boolean | null; unknown: boolean | null }[]>`
    select bool_or(kind.listed) as listed, bool_or(kind.listed is null) as unknown
    from (
      select 'sensitive' = any(pf_switches_a) or 'sensitive' = any(pf_switches_b) as listed
      from company_kinds
      where business_id = ${businessId}
    ) as kind
  `;
  if (kinds?.listed === true) {
    return true;
  }
  // Off only when there are kinds of work and each one's answer was a plain no; none stored, or one unknown, is null.
  return kinds?.unknown === false ? false : null;
}

/**
 * An outbox row as compose input and finalize read it, inside the transaction `db`, which must already run on the
 * request's side as rosie_job: under the request's business scope (confirmed here by requireBusinessScope() before the
 * first read), or with businessId null on the runtime side, with no scope. It should be read-only at repeatable read.
 * Prefer readOutboxRow(); this is for a caller that already holds such a transaction.
 */
export async function readOutboxRowIn(
  db: Db,
  request: ReadOutboxRowRequest,
  options: ReadOptions = {},
): Promise<ReadOutboxRowV1Dot6Response | NotFoundError | FixedLineRowError> {
  checkRowRequest(request, "readOutboxRow");
  const { outboxRowId, businessId } = request;
  await assertSide(db, "readOutboxRow", businessId);
  const [row] = await db<OutboxRowRow[]>`
    select id, turn_id, recipient_handle_id, recipient_person_id, business_id, booking_id, channel, send_class,
           open_question_id, copy_of_row_id, plan is not null as has_plan, final_parts, state, bundle_hash,
           bundle_build, version
    from outbox_rows
    where id = ${outboxRowId} and business_id is not distinct from ${businessId}
  `;
  if (row === undefined) {
    return notFound("outbox_rows", outboxRowId);
  }
  if (!hasTurn(row)) {
    // A row with no turn (K-04 v1.1's job row) is a kind of row v1.3 never held: notFound, before its send class or
    // anything else is read, so its turn is never looked for and nothing of it is returned (K-05 v1.13 item 65;
    // ADR-016 section 1's reader table and open point 12; default 4).
    return notFound("outbox_rows", outboxRowId);
  }
  const sendClass = row.send_class;
  if (sendClass === "safety") {
    // A safety line stays fixed text (arch 07 line 347): no compose or finalize view of it (default 49).
    return { error: "fixedLineRow", outboxRowId: row.id, sendClass };
  }
  const readAt = await readMoment(db, options);
  const recipient = await recipientOf(db, row);
  const answers = await answersOf(db, row);
  const slotSource = await slotSourceOf(db, row);
  const businessSensitive = await businessSensitiveOf(db, row.business_id);
  const openQuestions = await openQuestionsOf(db, row);
  return {
    result: "outboxRow",
    outboxRowId: row.id,
    businessId: row.business_id,
    readAt: utc(readAt),
    row: {
      turnId: row.turn_id,
      bundleId: { hash: row.bundle_hash, build: row.bundle_build },
      state: row.state,
      version: row.version,
      channel: row.channel,
      sendClass,
      bookingId: row.booking_id,
      openQuestionId: row.open_question_id,
      copyOfRowId: row.copy_of_row_id,
      hasPlan: row.has_plan,
      finalParts: row.final_parts,
    },
    // The step that asks, line 0 (CQ-151 (a)'s default 2); a row that asks no question has none (default 48).
    line:
      slotSource.question === null
        ? null
        : { step: slotSource.question.step, index: 0, from: "openQuestion" },
    recipient,
    answers,
    slotSource,
    businessSensitive,
    openQuestions,
  };
}

/**
 * An outbox row as compose input and finalize read it (K-05 v1.3 item 35), with its business's sensitive switch (v1.6
 * item 45): one read-only transaction at repeatable read on the primary, uncached. Pass the runtime's client (rosie_job):
 * with a business the read runs under its scope, set and confirmed before the first read; with businessId null on the
 * runtime side. notFound when there is no such row, the scope hides it, or it has no turn (K-04 v1.1's job row: K-05
 * v1.13 item 65, before anything else of it is read); fixedLineRow for a safety row; transient on a serialization
 * failure, a deadlock or a lost connection. A request of the wrong shape throws a TypeError, a broken record a
 * BrokenRecordError, and any other failed read its own error: never an answer, so never a switch read as off.
 */
export async function readOutboxRow(
  sql: Sql,
  request: ReadOutboxRowRequest,
  options: ReadOptions = {},
): Promise<ReadOutboxRowOutcome> {
  checkRowRequest(request, "readOutboxRow");
  try {
    return await onSide(sql, "readOutboxRow", request.businessId, (tx) =>
      readOutboxRowIn(tx, request, options),
    );
  } catch (error) {
    // A statement's own refusal and postgres.js's statement errors leave scrubbed too: the call's name and the code
    // alone, never the statement's values (T-1322; clocks.ts transientOrScrubbed).
    return transientOrScrubbed("readOutboxRow", error);
  }
}

// ---- readFixedLineFacts (item 36) ----------------------------------------------------------------------------------

/**
 * The fixed-line facts of a row's own handle and business, inside the transaction `db`, which must already run on the
 * request's side as rosie_job: under the request's business scope (confirmed here by requireBusinessScope()), or with
 * businessId null on the runtime side, with no scope. Prefer readFixedLineFacts(); this is for a caller that already
 * holds such a transaction.
 */
export async function readFixedLineFactsIn(
  db: Db,
  request: ReadFixedLineFactsRequest,
  options: ReadOptions = {},
): Promise<ReadFixedLineFactsResponse | NotFoundError> {
  checkRowRequest(request, "readFixedLineFacts");
  const { outboxRowId, businessId } = request;
  await assertSide(db, "readFixedLineFacts", businessId);
  const [row] = await db<{ recipient_handle_id: string }[]>`
    select recipient_handle_id
    from outbox_rows
    where id = ${outboxRowId} and business_id is not distinct from ${businessId}
  `;
  if (row === undefined) {
    return notFound("outbox_rows", outboxRowId);
  }
  const handleId = row.recipient_handle_id;
  const readAt = await readMoment(db, options);
  let openerRowId: string | null;
  let textedAboutBusiness: boolean;
  if (businessId === null) {
    // openers_sent holds no mark with no business: an earlier row to the handle with none that carries the opener.
    const [earlier] = await db<{ id: string }[]>`
      select r.id
      from outbox_rows r
      where r.recipient_handle_id = ${handleId}
        and r.business_id is null
        and r.commit_seq < (select o.commit_seq from outbox_rows o where o.id = ${outboxRowId} and o.business_id is null)
        and r.final_parts -> 'fixedLines' @> jsonb_build_array(${OPENER_LINE}::text)
      order by r.commit_seq
      limit 1
    `;
    openerRowId = earlier?.id ?? null;
    textedAboutBusiness = earlier !== undefined;
  } else {
    const [mark] = await db<{ outbox_row_id: string }[]>`
      select outbox_row_id from openers_sent where handle_id = ${handleId} and business_id = ${businessId}
    `;
    openerRowId = mark?.outbox_row_id ?? null;
    // The mark naming this row means this row is the first text: it carries the opener whenever it is finalized.
    textedAboutBusiness = mark !== undefined && mark.outbox_row_id !== outboxRowId;
  }
  const [phone] = await db<{ optout_line_delivered_at: Date | null }[]>`
    select optout_line_delivered_at from phones where handle_id = ${handleId}
  `;
  return {
    result: "fixedLineFacts",
    outboxRowId,
    businessId,
    recipientHandleId: handleId,
    readAt: utc(readAt),
    textedAboutBusiness,
    openerRowId,
    optOutLineDeliveredAt: utcOrNull(phone?.optout_line_delivered_at ?? null),
  };
}

/**
 * The fixed-line facts of one row (K-05 v1.3 item 36), for the fixed-line inserter: one read-only transaction at
 * repeatable read on the primary, uncached. Pass the runtime's client (rosie_job): with a business the read runs under
 * its scope, set and confirmed before the first read; with businessId null on the runtime side. notFound when there is
 * no such row or the scope hides it; transient on a serialization failure, a deadlock or a lost connection. A request of
 * the wrong shape throws a TypeError.
 */
export async function readFixedLineFacts(
  sql: Sql,
  request: ReadFixedLineFactsRequest,
  options: ReadOptions = {},
): Promise<ReadFixedLineFactsOutcome> {
  checkRowRequest(request, "readFixedLineFacts");
  try {
    return await onSide(sql, "readFixedLineFacts", request.businessId, (tx) =>
      readFixedLineFactsIn(tx, request, options),
    );
  } catch (error) {
    // A statement's own refusal and postgres.js's statement errors leave scrubbed too: the call's name and the code
    // alone, never the statement's values (T-1322; clocks.ts transientOrScrubbed).
    return transientOrScrubbed("readFixedLineFacts", error);
  }
}
