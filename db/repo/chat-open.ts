// Data-access v1.7: a number's text opens its chat, at receipt (K-05 v1.7 item 46; RULES 4.1b; MC C9; QUESTIONS.md
// CQ-194; DL-438; T-1211's card A, T-1212).
//
// RULES 4.1b keeps one flag per mobile, "chat open, set when it first texts Rosie's number. STOP clears it; turning texts
// back on (7.5) sets it again" (K-04 v1 phones.chat_open, with chat_open_at and chat_way). The gateway (C-044) calls
// openChatOnText at receipt, once for each text or photo from a phone handle, after handleSealingKey (whose answer gives
// the handle's id) and before the sealed text reaches the handle's actor, so the chat is open before anything is written
// for the text: its safety record on arrival, its turn, a STOP's record. In one transaction (item 46, "The transaction"):
//   1. the handle by id (handles: kind and address). None answers notFound (table handles), an email handle notAPhone;
//      nothing is written.
//   2. No phone row for the handle: one is inserted, its number the handle's address (read here, never sent or
//      answered), its chat open since the request's receivedAt (default 73) by the request's service, every other column
//      at K-04's defaults (not stopped, version 1), on conflict do nothing, so a parallel first text's insert is waited
//      for and found in step 3. Inserted: the entry is appended and the answer is inserted.
//   3. Else the row is locked FOR UPDATE, so a STOP that is committing is waited for and seen, then, in this order:
//        this text's own entry exists (event_log's primary key, '<event id>/chat-opened'): repeated, with the row as it
//          stands, open or stopped, whatever happened since (default 76); nothing is written;
//        stopped: stopped; nothing is written, in any column, the version included;
//        chat open: alreadyOpen; nothing is written: the first text's time and way and the version stay (default 72);
//        else, closed and not stopped (a mobile saved before it ever texted, such as a booking the business adds): the
//          chat opens, chat_open true, chat_open_at the request's receivedAt where it is null (default 74), chat_way the
//          request's service, the version up by one; the entry is appended and the answer is opened.
// Each answer names the handle and gives the row as the call leaves it (chat open, its time and way, stopped, version),
// never the number, with the entry the call appended, or null.
//
// The entry (item 46, "The entry"; K-08 v1 phone.chat_opened): id '<event id>/chat-opened'; no zone and no business;
// actor provider, Linq, with no person (default 75); table phones, the row by its handle id (K-08 v1 default 3); old
// values null for an insert, else the closed chat's columns that change, and new values the open chat's (chat_open
// always, chat_open_at and chat_way when this call sets them); nothing sealed; why the provider event (linq and the event
// id); no approval and no proofs. It is appended with no turn (none is written yet), the event id as its job id, the
// request's trace id and no bundle, at the call's now. Its id, row and why are the request's event and handle by
// construction (item 33's code check), and the event id and the handle id must be K-08 safe ids, which never read as a
// number (T-1211's security note 2).
//
// What it never changes (item 46): a stopped row, in any column, its version included; stopped, stop_at, start_at,
// linq_contact_added_at, poll_voted_at or optout_line_delivered_at on any row; chat_open_at once it is set; chat_way on
// an open chat; another handle's row (the number is the handle's own address); the chat id; a person, role, consent,
// thread, turn or outbox row. The one update names the locked row's handle and version, not stopped and not open, so a
// stopped row is never written whatever came before. db/repo/phones.ts's recordChatOpened (T-183, which writes a stopped
// row's way and version too) is not this call and does not stand in for it.
//
// Side (README item 46 "Scope"): the runtime side, as rosie_job with no business scope; phones and handles are scoped
// none, and 0012 grants rosie_job SELECT, INSERT and UPDATE on phones, SELECT on handles and SELECT and INSERT on
// event_log, whose runtime policy takes an entry with no business. Reads and writes the primary, uncached, in one read
// committed transaction (targets.ts inRuntimeTransaction, as handle-keys.ts). A serialization failure (40001), a deadlock
// (40P01) or a lost connection answers transient: nothing was written, the gateway answers 503, and Linq's retry is a
// repeat. Nothing here logs. A request of the wrong shape throws a TypeError that names the field, never a value; any
// other database error is thrown as OpenChatOnTextDatabaseError, its SQLSTATE and names alone (PostgreSQL's own error can
// hold a row's values, the number among them: commit-turn.ts's rule).
//
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. A repeat whose row is now closed and not stopped throws (an Error naming the rule): repeated's phone is open or
//      stopped (chatPhoneOpen, chatPhoneStopped), and no frozen writer leaves a chat closed but not stopped once it was
//      open (only STOP closes one, and STOP stops it: default 74).
//   2. A non-transient database error is thrown, never answered: openChatOnText.errors has no constraint answer, and
//      item 46's writes break no rule a valid request can meet. The one known case is a caller's fault: an event id whose
//      entry another handle's text already holds (event_log_pkey), so nothing is written.
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.7";
import { appendEvent } from "./event-log";
import type { Sql, Tx } from "./scope";
import {
  assertId,
  assertRequestShape,
  assertRuntimeSide,
  inRuntimeTransaction,
  readMoment,
  transientOrThrow,
  utc,
  utcOrNull,
} from "./targets";

type Db = Sql | Tx;
type Json = Parameters<Sql["json"]>[0];

// ---- the request and the answers (data-access.v1.7.schema.json) -----------------------------------------------------

/** K-05 v1.7 openChatOnText.request: the text's event, its handle by K-04 id, service, receipt time and trace; no number. */
export type OpenChatOnTextRequest = K05.OpenChatOnTextRequest;
/** K-05 v1.7 openChatOnText.response: inserted, opened, alreadyOpen, stopped or repeated. */
export type OpenChatOnTextResponse = K05.OpenChatOnTextResponse;
export type OpenChatOnTextInserted = K05.OpenChatOnTextInserted;
export type OpenChatOnTextOpened = K05.OpenChatOnTextOpened;
export type OpenChatOnTextAlreadyOpen = K05.OpenChatOnTextAlreadyOpen;
export type OpenChatOnTextStopped = K05.OpenChatOnTextStopped;
export type OpenChatOnTextRepeated = K05.OpenChatOnTextRepeated;
/** K-05 v1.7 chatPhoneOpen: a row whose chat is open, as the call leaves it, never its number. */
export type ChatPhoneOpen = K05.ChatPhoneOpen;
/** K-05 v1.7 chatPhoneStopped: a stopped row as the call finds and leaves it, never its number. */
export type ChatPhoneStopped = K05.ChatPhoneStopped;
/** K-05 v1.7 chatOpenedEvent: the phone.chat_opened entry the call appends when it writes. */
export type ChatOpenedEvent = K05.ChatOpenedEvent;
/** K-05 v1.7 textService: the service Linq reports for a text, never email. */
export type TextService = K05.TextService;
/** K-05 v1.7 notAPhoneError: an email handle opens no mobile's chat. */
export type NotAPhoneError = K05.NotAPhoneError;
/** K-05 v1.7 openChatOnText.errors: notFound (table handles), notAPhone or transient; nothing is written on any. */
export type OpenChatOnTextError = K05.OpenChatOnTextErrors;
export type OpenChatOnTextOutcome = OpenChatOnTextResponse | OpenChatOnTextError;

export interface OpenChatOptions {
  /** When an entry is appended (event_log.at), for the test's fake clock. Default: the transaction's now(). */
  now?: Date;
}

/**
 * A database error the call does not answer, thrown in place of PostgreSQL's own (whose message, detail and parameters
 * can hold a row's values, the number among them): its SQLSTATE and the table and constraint it names, nothing else.
 */
export class OpenChatOnTextDatabaseError extends Error {
  // Plain fields set in the constructor, never parameter properties: Node's type stripping cannot run those, and
  // `npm run typecheck` refuses them in db/ (db/tsconfig.erasable.json, T-1329; as T-1268's round 4 did in clocks.ts).
  readonly code: string;
  readonly table: string | null;
  readonly constraint: string | null;

  constructor(code: string, table: string | null, constraint: string | null) {
    const names = [
      table === null ? "" : `, table ${table}`,
      constraint === null ? "" : `, constraint ${constraint}`,
    ];
    super(`openChatOnText: the database refused the call (SQLSTATE ${code}${names.join("")})`);
    this.code = code;
    this.table = table;
    this.constraint = constraint;
    this.name = "OpenChatOnTextDatabaseError";
  }
}

const CALL = "openChatOnText";
const FIELDS = ["eventId", "handleId", "service", "receivedAt", "traceId"] as const;
const SERVICES = new Set<string>(["imessage", "rcs", "sms"]);
/** K-08 v1 safeId: letters, digits and _ . : / # -, starting with a letter or digit. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/#-]*$/;
/** K-08 v1 safeId's refusal: a run of digits and phone punctuation, seven or more long, reads as a number. */
const READS_AS_NUMBER = /^[0-9().+ -]{7,}$/;
/** common/formats.v1 utc: an RFC 3339 date-time in UTC, ending in Z. */
const UTC_FORM = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const NAME = /^[a-z_][a-z0-9_]*$/;

/** The entry's id: the text's event id, then /chat-opened (item 46), so a text opens a chat at most once. */
export function chatOpenedEntryId(eventId: string): string {
  return `${eventId}/chat-opened`;
}

function assertSafeId(value: unknown, what: string): void {
  if (typeof value !== "string" || !SAFE_ID.test(value) || READS_AS_NUMBER.test(value)) {
    throw new TypeError(`${CALL}: ${what} is a K-08 safe id, never a number, an address or words`);
  }
}

/** Refuses a request that is not item 46's, before anything is read or written; names the field, never a value. */
function validate(request: unknown): void {
  assertRequestShape(request, CALL, FIELDS);
  const values = request as Record<string, unknown>;
  for (const field of FIELDS) {
    if (!Object.hasOwn(values, field)) {
      throw new TypeError(`${CALL}: the request needs ${field}`);
    }
  }
  assertSafeId(values.eventId, "eventId");
  assertSafeId(values.handleId, "handleId");
  if (typeof values.service !== "string" || !SERVICES.has(values.service)) {
    throw new TypeError(`${CALL}: service is imessage, rcs or sms`);
  }
  const { receivedAt } = values;
  if (typeof receivedAt !== "string" || !UTC_FORM.test(receivedAt) || Number.isNaN(Date.parse(receivedAt))) {
    throw new TypeError(`${CALL}: receivedAt is a UTC time such as 2026-10-19T18:05:01Z`);
  }
  assertId(values.traceId, "traceId");
}

// ---- the phone row and its answers ----------------------------------------------------------------------------------

/** The phones columns the call reads and answers; never number, since an answer names the row by its handle. */
interface PhoneRow {
  chat_open: boolean;
  chat_open_at: Date | null;
  chat_way: string | null;
  stopped: boolean;
  version: number;
}

/** A stored chat_way, which K-04's phones_chat_way_known keeps to Linq's three services or null. */
function wayOf(value: string | null): TextService | null {
  if (value === null) {
    return null;
  }
  if (value === "imessage" || value === "rcs" || value === "sms") {
    return value;
  }
  throw new Error(`${CALL}: a phone row's chat_way is not a text service`);
}

/** A row whose chat is open (never stopped: K-04 phones_stop_closes_chat), as chatPhoneOpen. */
function openPhone(row: PhoneRow): ChatPhoneOpen {
  if (!row.chat_open || row.stopped) {
    throw new Error(`${CALL}: the row's chat is not open`);
  }
  return {
    chatOpen: true,
    chatOpenAt: utcOrNull(row.chat_open_at),
    chatWay: wayOf(row.chat_way),
    stopped: false,
    version: row.version,
  };
}

/** A stopped row (its chat closed: K-04 phones_stop_closes_chat), as chatPhoneStopped. */
function stoppedPhone(row: PhoneRow): ChatPhoneStopped {
  if (!row.stopped || row.chat_open) {
    throw new Error(`${CALL}: the row is not stopped`);
  }
  return {
    chatOpen: false,
    chatOpenAt: utcOrNull(row.chat_open_at),
    chatWay: wayOf(row.chat_way),
    stopped: true,
    version: row.version,
  };
}

/** The row as it stands for a repeat: open or stopped (default 1 above: a closed row that is not stopped throws). */
function standingPhone(row: PhoneRow): ChatPhoneOpen | ChatPhoneStopped {
  if (row.stopped) {
    return stoppedPhone(row);
  }
  if (row.chat_open) {
    return openPhone(row);
  }
  throw new Error(
    `${CALL}: this text's entry exists, and its row is closed and not stopped, which no K-05 v1.7 answer holds`,
  );
}

/** A chat this call opened, inserted or not: open since a time, by a way, not stopped. */
function openedPhone(row: PhoneRow): {
  chatOpen: true;
  chatOpenAt: string;
  chatWay: TextService;
  stopped: false;
  version: number;
} {
  const way = wayOf(row.chat_way);
  if (!row.chat_open || row.stopped || row.chat_open_at === null || way === null) {
    throw new Error(`${CALL}: the row the call wrote is not an open chat with its time and way`);
  }
  return {
    chatOpen: true,
    chatOpenAt: utc(row.chat_open_at),
    chatWay: way,
    stopped: false,
    version: row.version,
  };
}

// ---- the entry ------------------------------------------------------------------------------------------------------

/** Every field of the request's phone.chat_opened entry but its old and new values (item 46, "The entry"). */
function entryOf(request: OpenChatOnTextRequest) {
  return {
    id: chatOpenedEntryId(request.eventId),
    kind: "phone.chat_opened",
    zone: null,
    businessId: null,
    actorKind: "provider",
    actorPersonId: null,
    actorRole: null,
    tableName: "phones",
    rowId: request.handleId,
    sealed: null,
    why: { provider_event: { provider: "linq", event_id: request.eventId } },
    approvedBy: null,
    proofs: null,
  } as const;
}

/** Old or new values in event-log.ts's form: chat_open, with chat_open_at and chat_way when they are given. */
function logValues(values: {
  chat_open: boolean;
  chat_open_at?: string | null;
  chat_way?: TextService | null;
}): Record<string, Json> {
  const logged: Record<string, Json> = { chat_open: values.chat_open };
  if (values.chat_open_at !== undefined) {
    logged.chat_open_at = values.chat_open_at;
  }
  if (values.chat_way !== undefined) {
    logged.chat_way = values.chat_way;
  }
  return logged;
}

/**
 * Appends the answer's entry in the call's transaction: with no turn, the text's event id as its job id, the request's
 * trace and no bundle (item 46), at the call's now.
 */
async function appendEntry(
  db: Db,
  request: OpenChatOnTextRequest,
  event: ChatOpenedEvent,
  options: OpenChatOptions,
): Promise<void> {
  await appendEvent(
    db,
    { turnId: null, jobId: request.eventId, traceId: request.traceId, bundle: null },
    {
      ...entryOf(request),
      oldValues: event.oldValues === null ? null : logValues(event.oldValues),
      newValues: logValues(event.newValues),
      at: await readMoment(db, options),
    },
  );
}

// ---- the call -------------------------------------------------------------------------------------------------------

/**
 * Opens the chat of the request's number for its text (K-05 v1.7 item 46) inside the transaction `db`, which must run on
 * the runtime side (no business scope) at read committed, so that each statement after a wait sees what the writer it
 * waited for committed. Prefer openChatOnText(); this is for a caller that already holds such a transaction. Answers
 * notFound or notAPhone writing nothing; a database error is thrown as PostgreSQL gives it.
 */
export async function openChatOnTextIn(
  db: Db,
  request: OpenChatOnTextRequest,
  options: OpenChatOptions = {},
): Promise<OpenChatOnTextResponse | K05.NotFoundError | NotAPhoneError> {
  validate(request);
  await assertRuntimeSide(db, CALL);
  const { handleId, service, receivedAt } = request;

  // 1. The handle by id: its kind, and a phone's address, which is its number (read here; never answered or logged).
  const [handle] = await db<{ kind: string; address: string }[]>`
    select kind, address from handles where id = ${handleId}
  `;
  if (handle === undefined) {
    return { error: "notFound", table: "handles", rowId: handleId };
  }
  if (handle.kind !== "phone") {
    return { error: "notAPhone", handleId };
  }

  // 2. No phone row: one is inserted, its chat open. A parallel first text's insert is waited for; when it commits,
  //    nothing is inserted here and its row is found in step 3. (A number's row is its handle's: phones_handle_fk.)
  const [inserted] = await db<PhoneRow[]>`
    insert into phones (number, handle_id, chat_open, chat_open_at, chat_way)
    values (${handle.address}, ${handleId}, true, ${receivedAt}::timestamptz, ${service})
    on conflict do nothing
    returning chat_open, chat_open_at, chat_way, stopped, version
  `;
  if (inserted !== undefined) {
    const phone = openedPhone(inserted);
    if (phone.version !== 1) {
      throw new Error(`${CALL}: an inserted phone row starts at version 1`);
    }
    const answer: OpenChatOnTextInserted = {
      result: "inserted",
      handleId,
      phone: { ...phone, version: 1 },
      event: {
        ...entryOf(request),
        oldValues: null,
        newValues: { chat_open: true, chat_open_at: phone.chatOpenAt, chat_way: phone.chatWay },
      },
    };
    await appendEntry(db, request, answer.event, options);
    return answer;
  }

  // 3. The row, locked: a STOP committing now is waited for, and its row is read once it has committed.
  const [row] = await db<PhoneRow[]>`
    select chat_open, chat_open_at, chat_way, stopped, version from phones where handle_id = ${handleId} for update
  `;
  if (row === undefined) {
    throw new Error(`${CALL}: the phone row could be neither written nor read`);
  }
  const [own] = await db<{ id: string }[]>`
    select id from event_log where id = ${chatOpenedEntryId(request.eventId)}
  `;
  if (own !== undefined) {
    return { result: "repeated", handleId, phone: standingPhone(row), event: null };
  }
  if (row.stopped) {
    return { result: "stopped", handleId, phone: stoppedPhone(row), event: null };
  }
  if (row.chat_open) {
    return { result: "alreadyOpen", handleId, phone: openPhone(row), event: null };
  }

  // Closed and not stopped: the chat opens. The update names the locked row as it was read, so it can never write a
  // stopped or open row; chat_open_at is set only where it is null (default 74).
  const [after] = await db<PhoneRow[]>`
    update phones set
      chat_open = true,
      chat_open_at = coalesce(chat_open_at, ${receivedAt}::timestamptz),
      chat_way = ${service},
      version = version + 1
    where handle_id = ${handleId} and version = ${row.version} and not stopped and not chat_open
    returning chat_open, chat_open_at, chat_way, stopped, version
  `;
  if (after === undefined) {
    throw new Error(`${CALL}: the locked phone row changed under its lock`);
  }
  const phone = openedPhone(after);
  const setsTime = row.chat_open_at === null;
  const wayBefore = wayOf(row.chat_way);
  const changesWay = wayBefore !== phone.chatWay;
  const answer: OpenChatOnTextOpened = {
    result: "opened",
    handleId,
    phone,
    event: {
      ...entryOf(request),
      oldValues: {
        chat_open: false,
        ...(setsTime ? { chat_open_at: null } : {}),
        ...(changesWay ? { chat_way: wayBefore } : {}),
      },
      newValues: {
        chat_open: true,
        ...(setsTime ? { chat_open_at: phone.chatOpenAt } : {}),
        ...(changesWay ? { chat_way: phone.chatWay } : {}),
      },
    },
  };
  await appendEntry(db, request, answer.event, options);
  return answer;
}

/** PostgreSQL's error as OpenChatOnTextDatabaseError; any other error as it is. */
function scrubbed(error: unknown): unknown {
  if (!(error instanceof Error) || error.name !== "PostgresError") {
    return error;
  }
  const failure = error as Error & { code?: unknown; table_name?: unknown; constraint_name?: unknown };
  if (typeof failure.code !== "string" || !SQLSTATE.test(failure.code)) {
    return error;
  }
  const nameOrNull = (value: unknown): string | null =>
    typeof value === "string" && NAME.test(value) ? value : null;
  return new OpenChatOnTextDatabaseError(
    failure.code,
    nameOrNull(failure.table_name),
    nameOrNull(failure.constraint_name),
  );
}

/**
 * A number's text opens its chat (K-05 v1.7 item 46), for the gateway at receipt: one read committed transaction on the
 * primary, uncached, on the runtime side. Pass the client's primary handle, run as rosie_job. Answers inserted, opened,
 * alreadyOpen, stopped or repeated; notFound or notAPhone, nothing written; transient on a serialization failure, a
 * deadlock or a lost connection, nothing written. A request of the wrong shape throws a TypeError before anything is
 * read; any other database error is thrown as OpenChatOnTextDatabaseError, nothing written.
 */
export async function openChatOnText(
  sql: Sql,
  request: OpenChatOnTextRequest,
  options: OpenChatOptions = {},
): Promise<OpenChatOnTextOutcome> {
  validate(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: false }, (tx) =>
      openChatOnTextIn(tx, request, options),
    );
  } catch (error) {
    try {
      return transientOrThrow(error, CALL);
    } catch (thrown) {
      // transientOrThrow throws a session's failure already scrubbed (T-1268): that goes on as it is. What it lets
      // through unchanged (a statement's own refusal) is scrubbed here, as before.
      throw thrown === error ? scrubbed(error) : thrown;
    }
  }
}
