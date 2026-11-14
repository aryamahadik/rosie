// Data-access calls for threads, the opener-sent mark and the message log (K-04 v1 core; T-184).
//
// A thread is the chat with Rosie's number (one per handle, across every business: MC C1) or one booking's email reply
// thread. openers_sent says whether Rosie's opener for a business has already gone to a handle (arch 07 line 361).
// The message log is what the context bundle and the composer read: the last 6 messages with one business, up to 30
// days old (arch 03 line 181), for tone only.
//
// Message words are sealed. writeMessage seals them under the key of the message's person (sealing.ts, T-182) and
// stores the sealed bytes as text: "sealed:v1:" followed by the base64 of the sealed form. The table never holds plain
// words. After erasePerson() that person's key is gone, so their words cannot be opened again: a read returns them as
// null (`readable: false`). Any other sealing failure (wrong key, altered bytes, missing environment key) is thrown.
//
// Every value reaches the database as a bound parameter. Updates are compare-and-set on the row's version like
// people.ts; the database refuses any update that does not raise the version by one (trigger from 0002).
//
// readChatHandle is K-05 v1.10 item 51 (T-1259, the D-017 path audit's D1c; DL-492, DL-506; QUESTIONS.md CQ-61): the
// phone handle a Linq chat id names, the number a delivery receipt, Rosie's own reaction or a failed poll belongs to.
// Its caller is the gateway's Linq verify (C-044: adapters/src/linq/webhook/parse.ts ParseLookups.chatHandle, bound by
// the audit's CHAT card), which takes the answer's number, or none: a null answer or a failed read throws
// receiptHandleUnknown and the gateway answers 503, so Linq retries. It reads threads by linq_chat_id
// (threads_linq_chat_key: one row at most), the columns kind and handle_id alone, then that thread's handle by its
// primary key, the columns kind and address alone, and answers handleId and K-06 v1's handle (kind phone, the number in
// E.164 form) when the thread is of kind chat and its handle of kind phone; else both fields null (default 94): no
// thread holds the chat id, a thread of kind email holds it (threads_chat_or_email leaves linq_chat_id free), or the
// chat's handle is an email handle. The chat id is compared as a whole, byte by byte, never parsed (CQ-09).
//
// Its role and scope (item 51; K-04 v1 rule 4; as arming-reads.ts's reads): it runs on the client it is handed, the
// runtime side's, as rosie_job, in one read-only transaction at repeatable read on the primary, uncached (targets.ts
// inRuntimeTransaction, which clears the business scope at its start), so the answer is one moment's and nothing is
// written. threads and handles are scoped none, and rosie_job reads both through its own grants (0012), with no definer
// function and no table owner's rights. rosie_app, the Tool API's role, holds no grant on either (0012), so a Tool API
// client's call is refused by privilege (42501, thrown as DataAccessDatabaseError). The role is the connection's.
//
// What it never touches (the card's security review): no statement names a message's words or any column of
// sealing_keys, and none selects `*` or a whole row; nothing of the thread's booking, reply address or version is read
// or answered, and the answer never holds the chat id. The number is answered to its caller alone: nothing here logs it
// or the chat id, or puts either in an error (K-09 v1.5 default 135). A serialization failure, a deadlock or a lost
// connection answers transient with its SQLSTATE alone; any other database error is thrown scrubbed (clocks.ts's
// transientOrScrubbed); a request of the wrong shape throws a TypeError naming the field, never a value, before any
// statement. Its integration test (threads-chat-handle.int.test.ts) reads every statement it sends and checks it.
//
// Defaults used by readChatHandle (for ops/QUESTIONS.md; each where item 51 is silent):
//   1. A thread of kind email answers both fields null before its handle is read: item 51 answers none for it whatever
//      its handle is, so nothing of that handle, an address, is read.
//   2. A chat thread whose handle row the read cannot see answers both fields null, as an unknown chat does: a receipt
//      is never placed on a guessed handle (default 94). threads_handle_fk keeps the row, so only a role that is not
//      shown it (row-level security) meets this.
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.10";
import { transientOrScrubbed } from "./clocks";
import { SealingError, type WrappingKeys, seal, unsealText } from "./sealing";
import type { Sql, Tx } from "./scope";
import { assertId, assertRequestShape, inRuntimeTransaction } from "./targets";

type Db = Sql | Tx;

export type ThreadKind = "chat" | "email";
export type MessageDirection = "in" | "out";
export type MessageChannel = "text" | "email" | "page" | "ai";
export type MessageService = "imessage" | "rcs" | "sms";
export type MessageRole = "rosie" | "customer" | "owner" | "admin" | "staff" | "own_business" | "team" | "ai";

/** The context bundle reads this many messages ... */
export const CONTEXT_MESSAGE_LIMIT = 6;
/** ... that are at most this many days old. */
export const CONTEXT_MESSAGE_MAX_AGE_DAYS = 30;
/** What stored words start with: a sealed value of format version 1, base64 after it. */
export const SEALED_WORDS_PREFIX = "sealed:v1:";

export interface Thread {
  id: string;
  handleId: string;
  kind: ThreadKind;
  bookingId: string | null;
  linqChatId: string | null;
  replyAddress: string | null;
  version: number;
}

export interface OpenerSent {
  handleId: string;
  businessId: string;
  sentAt: Date;
  outboxRowId: string;
}

export interface Message {
  id: string;
  threadId: string;
  businessId: string | null;
  bookingId: string | null;
  direction: MessageDirection;
  channel: MessageChannel;
  service: MessageService | null;
  fromRole: MessageRole;
  toRole: MessageRole;
  personId: string | null;
  /** The words, opened; null when the person was erased (see `readable`). */
  words: string | null;
  /** False when the words cannot be opened any more because the person's key was erased. */
  readable: boolean;
  eventId: string | null;
  outboxRowId: string | null;
  sentAt: Date;
  deliveredAt: Date | null;
  version: number;
}

/** A compare-and-set: written, or refused with the row as it is now (null when the row does not exist). */
export type UpdateResult<Row> = { ok: true; row: Row } | { ok: false; current: Row | null };

export type NewThread =
  | { id: string; handleId: string; kind: "chat"; linqChatId?: string | null }
  | { id: string; handleId: string; kind: "email"; bookingId: string; replyAddress: string };

export interface NewOpenerSent {
  handleId: string;
  businessId: string;
  outboxRowId: string;
  /** Default: now. */
  sentAt?: Date;
}

export interface NewMessage {
  id: string;
  threadId: string;
  businessId?: string | null;
  bookingId?: string | null;
  direction: MessageDirection;
  channel: MessageChannel;
  service?: MessageService | null;
  fromRole: MessageRole;
  toRole: MessageRole;
  /** Whose key seals the words. Required: words with no person cannot be sealed. */
  personId: string;
  /** The words, without private details (scrubbed and redacted), plain here and sealed before they are stored. */
  words: string;
  /** For a message in: its inbound event id. */
  eventId?: string | null;
  /** For a text or email out: the outbox row it came from. */
  outboxRowId?: string | null;
  sentAt: Date;
  deliveredAt?: Date | null;
}

interface ThreadRow {
  id: string;
  handle_id: string;
  kind: ThreadKind;
  booking_id: string | null;
  linq_chat_id: string | null;
  reply_address: string | null;
  version: number;
}

interface OpenerRow {
  handle_id: string;
  business_id: string;
  sent_at: Date;
  outbox_row_id: string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  business_id: string | null;
  booking_id: string | null;
  direction: MessageDirection;
  channel: MessageChannel;
  service: MessageService | null;
  from_role: MessageRole;
  to_role: MessageRole;
  person_id: string | null;
  words: string;
  event_id: string | null;
  outbox_row_id: string | null;
  sent_at: Date;
  delivered_at: Date | null;
  version: number;
}

const toThread = (row: ThreadRow): Thread => ({
  id: row.id,
  handleId: row.handle_id,
  kind: row.kind,
  bookingId: row.booking_id,
  linqChatId: row.linq_chat_id,
  replyAddress: row.reply_address,
  version: row.version,
});

const toOpener = (row: OpenerRow): OpenerSent => ({
  handleId: row.handle_id,
  businessId: row.business_id,
  sentAt: row.sent_at,
  outboxRowId: row.outbox_row_id,
});

function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError("a row version is a positive integer");
  }
}

// ---- sealed words --------------------------------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/** The stored form of sealed words. */
function packWords(sealed: Uint8Array): string {
  return `${SEALED_WORDS_PREFIX}${toBase64(sealed)}`;
}

/**
 * Opens stored words for their person. Returns null when the person was erased; throws SealingError for any other
 * failure, and for stored text that is not sealed words.
 */
async function openWords(
  sql: Db,
  keys: WrappingKeys,
  personId: string | null,
  stored: string,
): Promise<string | null> {
  if (personId === null || !stored.startsWith(SEALED_WORDS_PREFIX)) {
    throw new SealingError("bad_format");
  }
  let sealed: Uint8Array;
  try {
    sealed = fromBase64(stored.slice(SEALED_WORDS_PREFIX.length));
  } catch {
    throw new SealingError("bad_format");
  }
  try {
    return await unsealText(sql, keys, personId, sealed);
  } catch (error) {
    if (error instanceof SealingError && error.code === "erased") {
      return null;
    }
    throw error;
  }
}

async function toMessage(sql: Db, keys: WrappingKeys, row: MessageRow): Promise<Message> {
  const words = await openWords(sql, keys, row.person_id, row.words);
  return {
    id: row.id,
    threadId: row.thread_id,
    businessId: row.business_id,
    bookingId: row.booking_id,
    direction: row.direction,
    channel: row.channel,
    service: row.service,
    fromRole: row.from_role,
    toRole: row.to_role,
    personId: row.person_id,
    words,
    readable: words !== null,
    eventId: row.event_id,
    outboxRowId: row.outbox_row_id,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
    version: row.version,
  };
}

// ---- threads -------------------------------------------------------------------------------------------------------

export async function getThread(sql: Db, id: string): Promise<Thread | null> {
  const [row] = await sql<ThreadRow[]>`select * from threads where id = ${id}`;
  return row === undefined ? null : toThread(row);
}

/** The one chat thread of a handle, or null. */
export async function getChatThread(sql: Db, handleId: string): Promise<Thread | null> {
  const [row] = await sql<ThreadRow[]>`select * from threads where handle_id = ${handleId} and kind = 'chat'`;
  return row === undefined ? null : toThread(row);
}

/** A booking's email thread, or null. */
export async function getEmailThreadOfBooking(sql: Db, bookingId: string): Promise<Thread | null> {
  const [row] = await sql<ThreadRow[]>`
    select * from threads where booking_id = ${bookingId} and kind = 'email' order by id limit 1
  `;
  return row === undefined ? null : toThread(row);
}

/** The thread that owns a booking reply address, or null. */
export async function getThreadByReplyAddress(sql: Db, replyAddress: string): Promise<Thread | null> {
  const [row] = await sql<ThreadRow[]>`select * from threads where reply_address = ${replyAddress}`;
  return row === undefined ? null : toThread(row);
}

/** The thread Linq's chat id names, or null. */
export async function getThreadByLinqChatId(sql: Db, linqChatId: string): Promise<Thread | null> {
  const [row] = await sql<ThreadRow[]>`select * from threads where linq_chat_id = ${linqChatId}`;
  return row === undefined ? null : toThread(row);
}

/** A handle's threads, optionally of one kind (the channel of the thread: chat or email), in id order. */
export async function listThreadsOfHandle(sql: Db, handleId: string, kind?: ThreadKind): Promise<Thread[]> {
  const rows = await sql<ThreadRow[]>`
    select * from threads
    where handle_id = ${handleId} and (${kind ?? null}::text is null or kind = ${kind ?? null})
    order by id
  `;
  return rows.map(toThread);
}

/**
 * Makes a thread at version 1. A second chat for a handle, a reply address or a Linq chat id already used, or a chat
 * with a booking or an email without one, is refused by the database.
 */
export async function createThread(sql: Db, input: NewThread): Promise<Thread> {
  const bookingId = input.kind === "email" ? input.bookingId : null;
  const replyAddress = input.kind === "email" ? input.replyAddress : null;
  const linqChatId = input.kind === "chat" ? (input.linqChatId ?? null) : null;
  const [row] = await sql<ThreadRow[]>`
    insert into threads (id, handle_id, kind, booking_id, linq_chat_id, reply_address)
    values (${input.id}, ${input.handleId}, ${input.kind}, ${bookingId}, ${linqChatId}, ${replyAddress})
    returning *
  `;
  if (row === undefined) {
    throw new Error("insert into threads returned no row");
  }
  return toThread(row);
}

/**
 * The chat thread of a handle, made with `newId` when the handle has none. Parallel calls for one handle all get the
 * same thread: the one that lost the insert reads the winner's row.
 */
export async function ensureChatThread(sql: Db, handleId: string, newId: string): Promise<Thread> {
  await sql`
    insert into threads (id, handle_id, kind) values (${newId}, ${handleId}, 'chat')
    on conflict (handle_id) where kind = 'chat' do nothing
  `;
  const thread = await getChatThread(sql, handleId);
  if (thread === null) {
    throw new Error("the chat thread of the handle is missing after the insert");
  }
  return thread;
}

/** Records the id Linq reports for a chat, if the thread is still at `expectedVersion`. */
export async function setLinqChatId(
  sql: Db,
  id: string,
  expectedVersion: number,
  linqChatId: string,
): Promise<UpdateResult<Thread>> {
  assertVersion(expectedVersion);
  const [row] = await sql<ThreadRow[]>`
    update threads set linq_chat_id = ${linqChatId}, version = ${expectedVersion + 1}
    where id = ${id} and version = ${expectedVersion}
    returning *
  `;
  if (row !== undefined) {
    return { ok: true, row: toThread(row) };
  }
  return { ok: false, current: await getThread(sql, id) };
}

// ---- the chat's phone handle (K-05 v1.10 item 51) -----------------------------------------------------------------

/** K-05 v1.10 readChatHandle.request: Linq's chat id alone. */
export type ReadChatHandleRequest = K05.ReadChatHandleRequest;
/** K-05 v1.10 readChatHandle.response: the chat's phone handle, its id and its number, or both fields null. */
export type ReadChatHandleResponse = K05.ReadChatHandleResponse;
/** K-05 v1.10 readChatHandle.errors: transient alone; an unknown chat is an answer, not an error (default 95). */
export type ReadChatHandleError = K05.ReadChatHandleErrors;
export type ReadChatHandleOutcome = ReadChatHandleResponse | ReadChatHandleError;

const READ_CHAT_HANDLE = "readChatHandle";

/** The columns item 51 reads of the chat's thread: its kind and its handle, never its booking, address or version. */
interface ChatThreadRow {
  kind: ThreadKind;
  handle_id: string;
}

/** The columns item 51 reads of the thread's handle: its kind and its address. */
interface ChatHandleRow {
  kind: "phone" | "email";
  address: string;
}

/** The chat id: the request names it alone; a refusal names the call and the field, never a value. */
function linqChatIdOf(request: unknown): string {
  assertRequestShape(request, READ_CHAT_HANDLE, ["linqChatId"]);
  const values = request as Record<string, unknown>;
  if (!Object.hasOwn(values, "linqChatId")) {
    throw new TypeError(`${READ_CHAT_HANDLE}: the request needs linqChatId`);
  }
  const linqChatId = values.linqChatId;
  assertId(linqChatId, `${READ_CHAT_HANDLE}: linqChatId`);
  return linqChatId;
}

/** No chat thread of a phone handle holds the chat id (default 94): both fields null. */
function noChatHandle(): ReadChatHandleResponse {
  return { handleId: null, handle: null };
}

/**
 * The chat's phone handle inside the read's own transaction (item 51): the thread by its chat id, its kind and its
 * handle alone; then, for a thread of kind chat, its handle by its key, its kind and its address alone (default 1: the
 * handle of a thread of kind email is never read). A handle the read cannot see answers none (default 2).
 */
async function chatHandleIn(tx: Sql, linqChatId: string): Promise<ReadChatHandleResponse> {
  const [thread] = await tx<ChatThreadRow[]>`
    select kind, handle_id from threads where linq_chat_id = ${linqChatId}
  `;
  if (thread?.kind !== "chat") {
    return noChatHandle();
  }
  const [handle] = await tx<ChatHandleRow[]>`
    select kind, address from handles where id = ${thread.handle_id}
  `;
  if (handle?.kind !== "phone") {
    return noChatHandle();
  }
  return { handleId: thread.handle_id, handle: { kind: "phone", address: handle.address } };
}

/**
 * The phone handle a Linq chat id names (K-05 v1.10 item 51): its id and its number in E.164 form when a thread of
 * kind chat holds the chat id and its handle is a phone; else both fields null (default 94), which the Linq verify
 * answers 503. One read-only transaction at repeatable read on the primary, uncached, writing nothing. Pass the runtime
 * side's client (rosie_job): the role is the connection's. transient on a serialization failure, a deadlock or a lost
 * connection. Throws a TypeError for a request of the wrong shape, and any other database error scrubbed
 * (DataAccessDatabaseError: the Tool API's role meets 42501). The number is a person's: never log it, nor the chat id.
 */
export async function readChatHandle(
  sql: Sql,
  request: ReadChatHandleRequest,
): Promise<ReadChatHandleOutcome> {
  const linqChatId = linqChatIdOf(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, (tx) => chatHandleIn(tx, linqChatId));
  } catch (error) {
    return transientOrScrubbed(READ_CHAT_HANDLE, error);
  }
}

// ---- the opener-sent mark -----------------------------------------------------------------------------------------

/** The mark that Rosie's opener for a business went to a handle, or null when it has not. */
export async function getOpenerSent(
  sql: Db,
  handleId: string,
  businessId: string,
): Promise<OpenerSent | null> {
  const [row] = await sql<OpenerRow[]>`
    select * from openers_sent where handle_id = ${handleId} and business_id = ${businessId}
  `;
  return row === undefined ? null : toOpener(row);
}

/** Whether the opener for this business has gone to this handle. */
export async function hasOpenerBeenSent(sql: Db, handleId: string, businessId: string): Promise<boolean> {
  return (await getOpenerSent(sql, handleId, businessId)) !== null;
}

/**
 * Marks the opener as sent. Written once: when the mark already exists nothing changes and `created` is false, with
 * the first mark returned. Two parallel calls give exactly one `created: true`.
 */
export async function markOpenerSent(
  sql: Db,
  input: NewOpenerSent,
): Promise<{ created: boolean; mark: OpenerSent }> {
  const [row] = await sql<OpenerRow[]>`
    insert into openers_sent (handle_id, business_id, sent_at, outbox_row_id)
    values (
      ${input.handleId}, ${input.businessId}, coalesce(${input.sentAt ?? null}::timestamptz, clock_timestamp()),
      ${input.outboxRowId}
    )
    on conflict (handle_id, business_id) do nothing
    returning *
  `;
  if (row !== undefined) {
    return { created: true, mark: toOpener(row) };
  }
  const first = await getOpenerSent(sql, input.handleId, input.businessId);
  if (first === null) {
    throw new Error("the opener mark is missing after a conflict");
  }
  return { created: false, mark: first };
}

// ---- the message log ----------------------------------------------------------------------------------------------

/**
 * Writes a message at version 1 with its words sealed under the key of `personId` (made on their first seal). Returns
 * the message with its words as given. Throws SealingError "erased" for an erased person.
 */
export async function writeMessage(sql: Db, keys: WrappingKeys, input: NewMessage): Promise<Message> {
  const stored = packWords(await seal(sql, keys, input.personId, input.words));
  const [row] = await sql<MessageRow[]>`
    insert into messages (
      id, thread_id, business_id, booking_id, direction, channel, service, from_role, to_role, person_id, words,
      event_id, outbox_row_id, sent_at, delivered_at
    )
    values (
      ${input.id}, ${input.threadId}, ${input.businessId ?? null}, ${input.bookingId ?? null}, ${input.direction},
      ${input.channel}, ${input.service ?? null}, ${input.fromRole}, ${input.toRole}, ${input.personId}, ${stored},
      ${input.eventId ?? null}, ${input.outboxRowId ?? null}, ${input.sentAt}, ${input.deliveredAt ?? null}
    )
    returning *
  `;
  if (row === undefined) {
    throw new Error("insert into messages returned no row");
  }
  return { ...(await toMessage(sql, keys, row)), words: input.words, readable: true };
}

export async function getMessage(sql: Db, keys: WrappingKeys, id: string): Promise<Message | null> {
  const [row] = await sql<MessageRow[]>`select * from messages where id = ${id}`;
  return row === undefined ? null : toMessage(sql, keys, row);
}

export interface RecentMessagesOptions {
  /** How many to return (default 6). */
  limit?: number;
  /** How old the oldest may be, in days (default 30). */
  maxAgeDays?: number;
  /** The moment the age counts from (default the database clock). */
  now?: Date;
}

/**
 * The context bundle's messages: the latest `limit` (default 6) messages of one thread with one business that are at
 * most `maxAgeDays` (default 30) old, oldest first. Words of an erased person come back null.
 */
export async function listRecentMessages(
  sql: Db,
  keys: WrappingKeys,
  threadId: string,
  businessId: string,
  options: RecentMessagesOptions = {},
): Promise<Message[]> {
  const limit = options.limit ?? CONTEXT_MESSAGE_LIMIT;
  const maxAgeDays = options.maxAgeDays ?? CONTEXT_MESSAGE_MAX_AGE_DAYS;
  if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(maxAgeDays) || maxAgeDays < 0) {
    throw new TypeError("limit and maxAgeDays are whole numbers of 0 or more");
  }
  const rows = await sql<MessageRow[]>`
    select * from (
      select * from messages
      where thread_id = ${threadId}
        and business_id = ${businessId}
        and sent_at >= coalesce(${options.now ?? null}::timestamptz, clock_timestamp()) - make_interval(days => ${maxAgeDays})
      order by sent_at desc, id desc
      limit ${limit}
    ) as latest
    order by sent_at, id
  `;
  return Promise.all(rows.map((row) => toMessage(sql, keys, row)));
}

/** A delivery receipt came: records the time if the message is still at `expectedVersion`. The first time stays. */
export async function markMessageDelivered(
  sql: Db,
  keys: WrappingKeys,
  id: string,
  expectedVersion: number,
  at?: Date,
): Promise<UpdateResult<Message>> {
  assertVersion(expectedVersion);
  const [row] = await sql<MessageRow[]>`
    update messages set
      delivered_at = coalesce(delivered_at, ${at ?? null}::timestamptz, clock_timestamp()),
      version = ${expectedVersion + 1}
    where id = ${id} and version = ${expectedVersion}
    returning *
  `;
  if (row !== undefined) {
    return { ok: true, row: await toMessage(sql, keys, row) };
  }
  return { ok: false, current: await getMessage(sql, keys, id) };
}
