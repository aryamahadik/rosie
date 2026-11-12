// Data-access v1.2 and v1.8: a recipient's send state, limit 8's read just before a send (K-05 v1.2 item 28; v1.8 item
// 47; QUESTIONS.md NQ-RT-2; T-259; T-220; T-1216).
//
// sendState takes only the outbox row's id and reads everything else from the row itself, so a caller cannot hand it a
// copy to compare (refuse-send-state-caller-versions), all in one read of the primary:
//   rowState, rowVersion   the row's state now (K-07's words) and its version, which markRow compares;
//   recipient              its handle (kind and address) and person;
//   phone, chat            the phone row (stopped, chat open, the Linq contact, the service Linq reports; null for an
//                          email handle or a number with no phone row) and the handle's chat thread with Linq's chat id;
//   textsConsent           the newest texts consent row for that contact that covers the row's business, its
//                          business's or every business's (K-29 consents_handle_kind_at_idx; default 35), read
//                          through consent.ts's newestTextsConsent; for an email contact it is the stop record. Since
//                          v1.8 (item 47) it also says who gave it and for which booking, fromContact and bookingId
//                          (below), always both;
//   audience               whose text hours apply (RULES 4.3; default 31): owner for a live owner role of the recipient
//                          person at the row's business, team for admin, staff or own_business (FS T01), customer
//                          otherwise, a row with no business or no person included; the highest of a person's roles wins;
//   zone, visitZone,       the zone text hours are read in: the visit's, else the business's (CQ-05). No frozen part
//   businessZone           stores a visit's zone before K-30, so visitZone is null and zone is the business's (default
//                          34); null for a row with no business;
//   textHours              the business's H04 text hours (businesses.text_hours_start and _end) as HH:MM;
//   textHoursOverride      the staging test phone's override: the release flag staging.text-hours-override at scope
//                          phone:<number>, enabled (BP 9.4; QUESTIONS.md M3-M3b.4; default 33); false for an email
//                          handle. The caller honours it on staging only (C-125);
//   currentVersions        each row of the row's versions_read at its version now, in that order; a row that no longer
//                          exists is left out, so limit 8 counts it changed;
//   booking, openQuestion  the row's booking head (stage, the person served, private, deceased, version) and open
//                          question (status, version), each null when the row has none;
//   closed                 the booking done or cancelled, the question answered, defaulted or withdrawn (default 32);
//   pauses                 the open pauses (cleared_at null) at the row's business on its recipient person or on the
//                          recipient's phone, in id order (default 42); none for a row with no business. Address
//                          pauses are not read (K-05 open gap 17).
// What limit 8 does with it, and what each flag holds back, is C-125's (T-259, T-562).
//
// Who gave the texts yes, and for which booking (K-05 v1.8 item 47; defaults 78 to 84; T-1099's handoff). The covering
// row is the one newestTextsConsent picks, as v1.2 picks it (default 35, unchanged); in the same transaction the call
// then reads that row by its id for K-29's channel, turn_id, handle_id and booking_id, and the handle_id of the turn that
// wrote it (K-04 turns, by the turn's id, a left join: none when no turn wrote it). consent.ts keeps v1.2's answer of
// newestTextsConsent as it stands, so this second read names the row by the id the first one chose; a consent row is
// never edited or removed (0013) and no call moves a turn to another handle, so the two reads see one row either way.
//   fromContact            true only for a yes the person sent by text from the contact the row covers: the recipient's
//                          handle is a phone (default 80: an email contact's row reads false), the row does not
//                          withdraw (default 82), its channel is text, and either a turn of the row's own handle wrote it
//                          (turns.handle_id equal to consents.handle_id: a turn batches one handle's texts, so a yes by
//                          text in it came from that number, whoever on it sent it), or no turn wrote it and it has no
//                          business (only a STOP's or a START's row has none, and one that does not withdraw is a START,
//                          which K-09 records only from that number's own START text, on return). False for every other
//                          row, failing closed: a yes the business entered (the owner's '1 Yes' is his own turn's), a
//                          page's, an outside AI's or an email's, a yes by text in another handle's turn, and a yes no
//                          turn wrote that is not a START (default 79), even one that came from the contact;
//   bookingId              consents.booking_id as stored (default 81): the booking a yes was given for; null on a STOP's
//                          or a START's row and on a yes for the business rather than one booking. Whether that booking
//                          was made after the stop is stored nowhere and is not read (default 83, K-05 open gap 52).
// phone.stopped and phone.stopAt stay the phone row as stored, never derived from a consent row (STATE note 10; default
// 84), and no statement here names a consent row's words (exact_words; default 36). Every answer is v1.8's
// sendState.v1dot8Response.
//
// A versions_read entry names its home table and the row's primary key as text (K-02 fact rowId; K-04 versions_read).
// The call reads only the homes VERSIONED_HOMES lists, the versioned tables of K-04 v1 core and K-29 v1 with a
// one-column key, each by its key column; it builds no read from the stored names alone. Any other name throws, since
// leaving it out would read as changed every time and make limit 8 compose the row again for ever. A domain part's
// versioned table joins the list in the task that migrates it.
//
// Side (K-05 v1.2 README line 153; K-04 v1 rule 4; K-29 v1 rule 4: "the guard and limit 8 read consents unscoped"): the
// runtime side, run by rosie_job with no business scope, since a STOP row has no business and the rows a message read
// may span businesses (arch 03 line 159). Under a business scope the call refuses to run. Reads (arch 10 lines 504,
// 538): the primary, uncached, in one read-only transaction at repeatable read, so it is one moment's read; a new call
// right after a STOP commits sees it. A serialization failure, a deadlock or a lost connection answers transient.
// Nothing here logs: the address and the consent are personal data.
import type * as K05v1dot8 from "../../contracts/generated/data-access/data-access.v1.8";
import { type ConsentChannel, newestTextsConsent, type TextsConsent } from "./consent";
import {
  assertId,
  assertRequestShape,
  assertRuntimeSide,
  type BookingStage,
  inRuntimeTransaction,
  type NotFoundError,
  readMoment,
  type ReadOptions,
  type RowRef,
  type TransientError,
  transientOrThrow,
  utc,
  utcOrNull,
} from "./targets";
import type { Sql, Tx } from "./scope";

type Db = Sql | Tx;

/** K-07 v1's row states (outbox-effects.v1.schema.json rowState; K-04 outbox_rows_state_known). */
export type RowState =
  | "planned"
  | "checked"
  | "sending"
  | "sent"
  | "delivered"
  | "held"
  | "dropped_stopped"
  | "stale"
  | "withdrawn"
  | "failed"
  | "waiting_chat"
  | "superseded";

export type QuestionStatus = "waiting" | "open" | "answered" | "defaulted" | "withdrawn";
export type Audience = "customer" | "owner" | "team";
export type ChatWay = "imessage" | "rcs" | "sms";

export interface SendStateRequest {
  outboxRowId: string;
}

/** K-05 v1.2 phoneRead: a mobile's phones row. */
export interface PhoneRead {
  number: string;
  stopped: boolean;
  stopAt: string | null;
  chatOpen: boolean;
  chatWay: ChatWay | null;
  linqContactAddedAt: string | null;
  pollVotedAt: string | null;
  optoutLineDeliveredAt: string | null;
  version: number;
}

/** K-05 v1.2 pauseRead: an open pause on a person or a phone. */
export interface PauseRead {
  id: string;
  target: "person" | "phone";
  personId: string | null;
  phoneNumber: string | null;
  setByTurnId: string | null;
  setAt: string;
  version: number;
}

/**
 * K-05 v1.8 sendState.v1dot8Response (item 47): the answer sendState gives, v1.2's fields (item 28) with textsConsent,
 * when there is one, always stating fromContact and bookingId.
 */
export type SendStateV1Dot8Response = K05v1dot8.SendStateV1Dot8Response;
/** K-05 v1.8 textsConsentV1dot8: the covering texts row as a v1.8 call gives it, who gave it and for which booking. */
export type TextsConsentV1Dot8 = K05v1dot8.TextsConsentV1Dot8;
/**
 * K-05 v1.8 sendState.response: the same fields with fromContact and bookingId optional, for a consumer that also reads
 * an answer of v1.2 to v1.7, which has neither and reads as not known, so no yes lifts a stop (T-1099). sendState itself
 * always states both.
 */
export type SendStateResponse = K05v1dot8.SendStateResponse;

/** What sendState answers: a v1.8 answer, notFound or transient. */
export type SendStateV1Dot8Outcome = SendStateV1Dot8Response | NotFoundError | TransientError;
/** What a consumer of any version's answer reads (the runtime's send-state port): sendState's outcome is one. */
export type SendStateOutcome = SendStateResponse | NotFoundError | TransientError;

/** The release flag of the staging test phone's text-hours override (K-04 seed-flag; QUESTIONS.md M3-M3b.4). */
export const TEXT_HOURS_OVERRIDE_FLAG = "staging.text-hours-override";

/**
 * The homes a versions_read entry may name, each with its one key column: every versioned table of K-04 v1 core and
 * K-29 v1 whose primary key is one column, sealing_keys left out (no key's row is ever a fact: K-05 rule 7). Tables
 * keyed on more than one column (bundles, release_flags, outbox_parts) have no key as one text, so no fact lives there.
 */
export const VERSIONED_HOMES: Readonly<Record<string, string>> = Object.freeze({
  bookings: "id",
  businesses: "id",
  chat_links: "id",
  class_seats: "resource_id",
  clock_rows: "id",
  messages: "id",
  open_questions: "id",
  outbox_rows: "id",
  pauses: "id",
  person_roles: "id",
  persons: "id",
  phones: "number",
  reservations: "id",
  resources: "id",
  threads: "id",
  turns: "id",
});

const TEAM_ROLES = new Set(["admin", "staff", "own_business"]);
const CLOSED_STAGES = new Set<BookingStage>(["done", "cancelled"]);
const CLOSED_STATUSES = new Set<QuestionStatus>(["answered", "defaulted", "withdrawn"]);

interface OutboxRowRead {
  id: string;
  state: RowState;
  version: number;
  recipient_handle_id: string;
  recipient_person_id: string | null;
  business_id: string | null;
  booking_id: string | null;
  open_question_id: string | null;
  versions_read: unknown;
}

interface PhoneRow {
  number: string;
  stopped: boolean;
  stop_at: Date | null;
  chat_open: boolean;
  chat_way: ChatWay | null;
  linq_contact_added_at: Date | null;
  poll_voted_at: Date | null;
  optout_line_delivered_at: Date | null;
  version: number;
}

interface PauseRow {
  id: string;
  target: "person" | "phone";
  person_id: string | null;
  phone_number: string | null;
  set_by_turn_id: string | null;
  set_at: Date;
  version: number;
}

const toPhone = (row: PhoneRow): PhoneRead => ({
  number: row.number,
  stopped: row.stopped,
  stopAt: utcOrNull(row.stop_at),
  chatOpen: row.chat_open,
  chatWay: row.chat_way,
  linqContactAddedAt: utcOrNull(row.linq_contact_added_at),
  pollVotedAt: utcOrNull(row.poll_voted_at),
  optoutLineDeliveredAt: utcOrNull(row.optout_line_delivered_at),
  version: row.version,
});

const toPause = (row: PauseRow): PauseRead => ({
  id: row.id,
  target: row.target,
  personId: row.person_id,
  phoneNumber: row.phone_number,
  setByTurnId: row.set_by_turn_id,
  setAt: utc(row.set_at),
  version: row.version,
});

/** The stored versions_read as row references; anything else in the column is refused (K-04 outbox_rows). */
function rowRefsOf(value: unknown, outboxRowId: string): RowRef[] {
  if (!Array.isArray(value)) {
    throw new Error(`outbox row ${outboxRowId}: versions_read is not a list`);
  }
  return value.map((entry: unknown) => {
    const ref = entry as Partial<RowRef> | null;
    if (
      typeof ref?.table !== "string" ||
      typeof ref.rowId !== "string" ||
      typeof ref.version !== "number" ||
      !Number.isSafeInteger(ref.version)
    ) {
      throw new Error(`outbox row ${outboxRowId}: a versions_read entry is not {table, rowId, version}`);
    }
    return { table: ref.table, rowId: ref.rowId, version: ref.version };
  });
}

/**
 * Each referenced row at its version now, in the order given; a row that no longer exists is left out. Only the homes
 * VERSIONED_HOMES lists are read; any other table name throws.
 */
export async function currentVersionsOf(db: Db, refs: readonly RowRef[]): Promise<RowRef[]> {
  const current: RowRef[] = [];
  for (const ref of refs) {
    const key = Object.hasOwn(VERSIONED_HOMES, ref.table) ? VERSIONED_HOMES[ref.table] : undefined;
    if (key === undefined) {
      throw new Error(`versions_read names ${ref.table}, which is not a versioned home sendState reads`);
    }
    const [row] = await db<{ version: number }[]>`
      select version from ${db(ref.table)} where ${db(key)} = ${ref.rowId}
    `;
    if (row !== undefined) {
      current.push({ table: ref.table, rowId: ref.rowId, version: row.version });
    }
  }
  return current;
}

/** Whose text hours apply, from the person's live roles at the business (RULES 4.3; default 31). */
async function audienceOf(db: Db, personId: string | null, businessId: string | null): Promise<Audience> {
  if (personId === null || businessId === null) {
    return "customer";
  }
  const roles = await db<{ role: string }[]>`
    select role from person_roles
    where person_id = ${personId} and business_id = ${businessId} and ended_at is null
  `;
  if (roles.some((row) => row.role === "owner")) {
    return "owner";
  }
  if (roles.some((row) => TEAM_ROLES.has(row.role))) {
    return "team";
  }
  return "customer";
}

/**
 * What item 47 reads of the covering row besides v1.2's four fields (K-29 v1 consents: channel, turn_id, handle_id,
 * booking_id), with the handle of the turn that wrote it (K-04 v1 turns.handle_id; null when no turn wrote it). Never
 * the row's words.
 */
interface ConsentSourceRow {
  channel: ConsentChannel;
  turn_id: string | null;
  handle_id: string | null;
  booking_id: string | null;
  turn_handle_id: string | null;
}

/** Item 47's read of the covering row by its id, and of the turn that wrote it by the turn's id (K-05 v1.8). */
async function consentSourceOf(db: Db, consentId: string): Promise<ConsentSourceRow> {
  const [row] = await db<ConsentSourceRow[]>`
    select c.channel, c.turn_id, c.handle_id, c.booking_id, t.handle_id as turn_handle_id
    from consents c
    left join turns t on t.id = c.turn_id
    where c.id = ${consentId}
  `;
  if (row === undefined) {
    throw new Error("sendState: the covering texts consent row is missing from its own read");
  }
  return row;
}

/**
 * Whether the covering row is a yes the person sent by text from the contact it covers (K-05 v1.8 item 47, defaults 78
 * to 82): only for a phone contact, a row that does not withdraw, given by text, and written either by a turn of the
 * row's own handle or, with no turn, as a START (no business). Every other row is false, failing closed.
 */
function fromContactOf(
  contactKind: "phone" | "email",
  consent: TextsConsent,
  source: ConsentSourceRow,
): boolean {
  if (contactKind !== "phone" || consent.revoked || source.channel !== "text") {
    return false;
  }
  if (source.turn_id === null) {
    return consent.businessId === null;
  }
  return source.turn_handle_id !== null && source.turn_handle_id === source.handle_id;
}

/** The covering row as a v1.8 call gives it (item 47): v1.2's four fields, who gave it and for which booking. */
async function textsConsentOf(
  db: Db,
  contactKind: "phone" | "email",
  consent: TextsConsent | null,
): Promise<TextsConsentV1Dot8 | null> {
  if (consent === null) {
    return null;
  }
  const source = await consentSourceOf(db, consent.consentId);
  return {
    consentId: consent.consentId,
    businessId: consent.businessId,
    revoked: consent.revoked,
    at: utc(consent.at),
    fromContact: fromContactOf(contactKind, consent, source),
    bookingId: source.booking_id,
  };
}

/**
 * Limit 8's send state inside the transaction `db`, which must run on the runtime side (no business scope). Prefer
 * sendState(); this is for a caller that already holds a transaction.
 */
export async function sendStateIn(
  db: Db,
  request: SendStateRequest,
  options: ReadOptions = {},
): Promise<SendStateV1Dot8Response | NotFoundError> {
  assertRequestShape(request, "sendState", ["outboxRowId"]);
  assertId(request.outboxRowId, "outboxRowId");
  await assertRuntimeSide(db, "sendState");
  const { outboxRowId } = request;

  const [row] = await db<OutboxRowRead[]>`
    select id, state, version, recipient_handle_id, recipient_person_id, business_id, booking_id, open_question_id,
           versions_read
    from outbox_rows where id = ${outboxRowId}
  `;
  if (row === undefined) {
    return { error: "notFound", table: "outbox_rows", rowId: outboxRowId };
  }
  const readAt = await readMoment(db, options);
  const refs = rowRefsOf(row.versions_read, outboxRowId);

  const [handle] = await db<{ id: string; kind: "phone" | "email"; address: string }[]>`
    select id, kind, address from handles where id = ${row.recipient_handle_id}
  `;
  if (handle === undefined) {
    throw new Error(`outbox row ${outboxRowId}: its recipient handle is missing`);
  }
  const isPhone = handle.kind === "phone";

  const [phone] = isPhone
    ? await db<PhoneRow[]>`
        select number, stopped, stop_at, chat_open, chat_way, linq_contact_added_at, poll_voted_at,
               optout_line_delivered_at, version
        from phones where handle_id = ${handle.id}
      `
    : [];

  const [chat] = await db<{ id: string; linq_chat_id: string | null; version: number }[]>`
    select id, linq_chat_id, version from threads where handle_id = ${handle.id} and kind = 'chat'
  `;

  const covering = await newestTextsConsent(db, handle.id, row.business_id);
  const textsConsent = await textsConsentOf(db, handle.kind, covering);
  const audience = await audienceOf(db, row.recipient_person_id, row.business_id);

  const [business] =
    row.business_id === null
      ? []
      : await db<{ time_zone: string; start: string; end: string }[]>`
          select time_zone, to_char(text_hours_start, 'HH24:MI') as start, to_char(text_hours_end, 'HH24:MI') as end
          from businesses where id = ${row.business_id}
        `;

  const [override] = isPhone
    ? await db<{ enabled: boolean }[]>`
        select enabled from release_flags
        where name = ${TEXT_HOURS_OVERRIDE_FLAG} and scope = ${`phone:${handle.address}`}
      `
    : [];

  const currentVersions = await currentVersionsOf(db, refs);

  const [booking] =
    row.booking_id === null
      ? []
      : await db<
          {
            id: string;
            stage: BookingStage;
            served_person_id: string | null;
            private: boolean;
            deceased: boolean;
            version: number;
          }[]
        >`
          select id, stage, served_person_id, private, deceased, version from bookings where id = ${row.booking_id}
        `;

  const [question] =
    row.open_question_id === null
      ? []
      : await db<{ id: string; status: QuestionStatus; version: number }[]>`
          select id, status, version from open_questions where id = ${row.open_question_id}
        `;

  const pauses =
    row.business_id === null
      ? []
      : await db<PauseRow[]>`
          select id, target, person_id, phone_number, set_by_turn_id, set_at, version
          from pauses
          where business_id = ${row.business_id}
            and cleared_at is null
            and (
              (target = 'person' and person_id = ${row.recipient_person_id})
              or (target = 'phone' and phone_number = ${isPhone ? handle.address : null})
            )
          order by id collate "C"
        `;

  const businessZone = business?.time_zone ?? null;
  return {
    result: "sendState",
    outboxRowId,
    rowState: row.state,
    rowVersion: row.version,
    readAt: utc(readAt),
    recipient: {
      handleId: handle.id,
      kind: handle.kind,
      address: handle.address,
      personId: row.recipient_person_id,
    },
    phone: phone === undefined ? null : toPhone(phone),
    chat:
      chat === undefined ? null : { threadId: chat.id, linqChatId: chat.linq_chat_id, version: chat.version },
    textsConsent,
    audience,
    // The visit's zone, else the business's (CQ-05): no frozen part stores a visit's zone before K-30 (default 34).
    zone: businessZone,
    visitZone: null,
    businessZone,
    textHours: business === undefined ? null : { start: business.start, end: business.end },
    textHoursOverride: override?.enabled === true,
    currentVersions,
    booking:
      booking === undefined
        ? null
        : {
            id: booking.id,
            stage: booking.stage,
            servedPersonId: booking.served_person_id,
            private: booking.private,
            deceased: booking.deceased,
            version: booking.version,
          },
    pauses: pauses.map(toPause),
    openQuestion:
      question === undefined ? null : { id: question.id, status: question.status, version: question.version },
    closed: {
      booking: booking !== undefined && CLOSED_STAGES.has(booking.stage),
      question: question !== undefined && CLOSED_STATUSES.has(question.status),
    },
  };
}

/**
 * A recipient's send state for one outbox row (K-05 v1.2 item 28, with v1.8 item 47's fromContact and bookingId), for
 * limit 8 at send: one read-only transaction on the primary, uncached, on the runtime side. Pass the client's primary
 * handle, run as rosie_job. notFound when the row does not exist; transient on a serialization failure, a deadlock or a
 * lost connection. Limit 8 sends nothing on either (it fails closed: T-259).
 */
export async function sendState(
  sql: Sql,
  request: SendStateRequest,
  options: ReadOptions = {},
): Promise<SendStateV1Dot8Outcome> {
  assertRequestShape(request, "sendState", ["outboxRowId"]);
  assertId(request.outboxRowId, "outboxRowId");
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, (tx) => sendStateIn(tx, request, options));
  } catch (error) {
    return transientOrThrow(error, "sendState");
  }
}
