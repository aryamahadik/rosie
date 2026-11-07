// Data-access calls for handles, the people behind them, phones with the stopped flag, and the paused flag
// (K-04 v1 core; T-183).
//
// One handle per phone number or email address, one phone row per mobile across every business (MC C1): STOP sets the
// stopped flag on that one row and every business sees it, until START clears it. Acting on the flag at send is the
// runtime's (C-125); this file only keeps it true.
//
// Every update of a phone or a pause is a compare-and-set on the row's version, as db/repo/people.ts: the caller passes
// the version it read, the row is written only if it still has that version, and the version rises by one. A write made
// from an old read changes nothing and returns the row as it is now. The database refuses any other update that does
// not raise the version by one (trigger from 0002), so no other path can skip the rule.
//
// setPhoneStopped is the call STOP and START use: it reads, compares and sets, and reads again when it loses, so any
// number of parallel STOPs and STARTs on one mobile each apply once or find the state already as asked, in a row of
// versions with no gap.
import type { Sql, Tx } from "./scope";

type Db = Sql | Tx;

export type HandleKind = "phone" | "email";
export type ChatWay = "imessage" | "rcs" | "sms";
export type PauseTarget = "person" | "phone" | "address";

export interface Handle {
  id: string;
  kind: HandleKind;
  /** The phone number in E.164 form, or the email address in lower case. */
  address: string;
}

export interface Phone {
  /** The mobile number in E.164 form; the same as its handle's address. */
  number: string;
  handleId: string;
  chatOpen: boolean;
  chatOpenAt: Date | null;
  /** The service Linq reports for the chat: imessage, rcs or sms. Null until the first text. */
  chatWay: ChatWay | null;
  stopped: boolean;
  /** When the last STOP came; null: never stopped. */
  stopAt: Date | null;
  /** When the last START came; null: never. */
  startAt: Date | null;
  linqContactAddedAt: Date | null;
  pollVotedAt: Date | null;
  optoutLineDeliveredAt: Date | null;
  version: number;
}

export interface Pause {
  id: string;
  businessId: string;
  target: PauseTarget;
  personId: string | null;
  phoneNumber: string | null;
  /** For an address pause: the address sealed under the key of sealedForPersonId (sealing.ts); never plain text. */
  address: Uint8Array | null;
  sealedForPersonId: string | null;
  setByTurnId: string | null;
  setAt: Date;
  clearedAt: Date | null;
  clearedByPersonId: string | null;
  version: number;
}

/** A compare-and-set: written, or refused with the row as it is now (null when the row does not exist). */
export type UpdateResult<Row> = { ok: true; row: Row } | { ok: false; current: Row | null };

export interface NewHandle {
  id: string;
  kind: HandleKind;
  address: string;
}

export interface NewPhone {
  number: string;
  /** The handle whose address is `number`. */
  handleId: string;
}

interface NewPauseBase {
  id: string;
  businessId: string;
  setByTurnId?: string | null;
  /** Default: now. */
  setAt?: Date;
}

export type NewPause =
  | (NewPauseBase & { target: "person"; personId: string })
  | (NewPauseBase & { target: "phone"; phoneNumber: string })
  | (NewPauseBase & { target: "address"; address: Uint8Array; sealedForPersonId: string });

interface HandleRow {
  id: string;
  kind: HandleKind;
  address: string;
}

interface PhoneRow {
  number: string;
  handle_id: string;
  chat_open: boolean;
  chat_open_at: Date | null;
  chat_way: ChatWay | null;
  stopped: boolean;
  stop_at: Date | null;
  start_at: Date | null;
  linq_contact_added_at: Date | null;
  poll_voted_at: Date | null;
  optout_line_delivered_at: Date | null;
  version: number;
}

interface PauseRow {
  id: string;
  business_id: string;
  target: PauseTarget;
  person_id: string | null;
  phone_number: string | null;
  address: Uint8Array | null;
  sealed_for_person_id: string | null;
  set_by_turn_id: string | null;
  set_at: Date;
  cleared_at: Date | null;
  cleared_by_person_id: string | null;
  version: number;
}

const toHandle = (row: HandleRow): Handle => ({ id: row.id, kind: row.kind, address: row.address });

const toPhone = (row: PhoneRow): Phone => ({
  number: row.number,
  handleId: row.handle_id,
  chatOpen: row.chat_open,
  chatOpenAt: row.chat_open_at,
  chatWay: row.chat_way,
  stopped: row.stopped,
  stopAt: row.stop_at,
  startAt: row.start_at,
  linqContactAddedAt: row.linq_contact_added_at,
  pollVotedAt: row.poll_voted_at,
  optoutLineDeliveredAt: row.optout_line_delivered_at,
  version: row.version,
});

const toPause = (row: PauseRow): Pause => ({
  id: row.id,
  businessId: row.business_id,
  target: row.target,
  personId: row.person_id,
  phoneNumber: row.phone_number,
  address: row.address,
  sealedForPersonId: row.sealed_for_person_id,
  setByTurnId: row.set_by_turn_id,
  setAt: row.set_at,
  clearedAt: row.cleared_at,
  clearedByPersonId: row.cleared_by_person_id,
  version: row.version,
});

function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError("a row version is a positive integer");
  }
}

// ---- handles and the people behind them ---------------------------------------------------------------------------

export async function getHandle(sql: Db, id: string): Promise<Handle | null> {
  const [row] = await sql<HandleRow[]>`select * from handles where id = ${id}`;
  return row === undefined ? null : toHandle(row);
}

/** The handle of a phone number or email address (one each), or null. */
export async function getHandleByAddress(sql: Db, address: string): Promise<Handle | null> {
  const [row] = await sql<HandleRow[]>`select * from handles where address = ${address}`;
  return row === undefined ? null : toHandle(row);
}

/**
 * Makes a handle. Written once: there is no update. A second handle for the same address, a phone address that is not
 * E.164, or an email that is not lower case is refused by the database.
 */
export async function createHandle(sql: Db, input: NewHandle): Promise<Handle> {
  const [row] = await sql<HandleRow[]>`
    insert into handles (id, kind, address) values (${input.id}, ${input.kind}, ${input.address})
    returning *
  `;
  if (row === undefined) {
    throw new Error("insert into handles returned no row");
  }
  return toHandle(row);
}

/** Says that a person writes from a handle. Saying it twice changes nothing. */
export async function addPersonHandle(sql: Db, personId: string, handleId: string): Promise<void> {
  await sql`
    insert into person_handles (person_id, handle_id) values (${personId}, ${handleId})
    on conflict (person_id, handle_id) do nothing
  `;
}

/** Says that a person no longer writes from a handle. Returns whether a row was removed. */
export async function removePersonHandle(sql: Db, personId: string, handleId: string): Promise<boolean> {
  const rows = await sql`
    delete from person_handles where person_id = ${personId} and handle_id = ${handleId} returning person_id
  `;
  return rows.length > 0;
}

/** The people who write from a handle (one handle can be several people), by id. */
export async function listPersonIdsOfHandle(sql: Db, handleId: string): Promise<string[]> {
  const rows = await sql<{ person_id: string }[]>`
    select person_id from person_handles where handle_id = ${handleId} order by person_id
  `;
  return rows.map((row) => row.person_id);
}

/** The handles a person writes from, by id. */
export async function listHandleIdsOfPerson(sql: Db, personId: string): Promise<string[]> {
  const rows = await sql<{ handle_id: string }[]>`
    select handle_id from person_handles where person_id = ${personId} order by handle_id
  `;
  return rows.map((row) => row.handle_id);
}

// ---- phones -------------------------------------------------------------------------------------------------------

export async function getPhone(sql: Db, number: string): Promise<Phone | null> {
  const [row] = await sql<PhoneRow[]>`select * from phones where number = ${number}`;
  return row === undefined ? null : toPhone(row);
}

export async function getPhoneByHandle(sql: Db, handleId: string): Promise<Phone | null> {
  const [row] = await sql<PhoneRow[]>`select * from phones where handle_id = ${handleId}`;
  return row === undefined ? null : toPhone(row);
}

/**
 * Makes the one phone row of a mobile, at version 1, chat closed and not stopped. The number must be the address of a
 * handle of kind phone, named by `handleId` (the database checks the pair); a second row for a number, or for a handle,
 * is refused.
 */
export async function createPhone(sql: Db, input: NewPhone): Promise<Phone> {
  const [row] = await sql<PhoneRow[]>`
    insert into phones (number, handle_id) values (${input.number}, ${input.handleId}) returning *
  `;
  if (row === undefined) {
    throw new Error("insert into phones returned no row");
  }
  return toPhone(row);
}

/**
 * STOP: sets the stopped flag with its stop time and closes the chat, if the phone is still at `expectedVersion`.
 * The flag is on the one row, so every business sees it. `at` is when the STOP came (default now). Stopping a phone
 * that is already stopped is a plain write too: it moves the stop time; use setPhoneStopped to leave a repeat alone.
 */
export async function stopPhone(
  sql: Db,
  number: string,
  expectedVersion: number,
  at?: Date,
): Promise<UpdateResult<Phone>> {
  assertVersion(expectedVersion);
  const [row] = await sql<PhoneRow[]>`
    update phones set
      stopped = true,
      chat_open = false,
      stop_at = coalesce(${at ?? null}::timestamptz, clock_timestamp()),
      version = ${expectedVersion + 1}
    where number = ${number} and version = ${expectedVersion}
    returning *
  `;
  if (row !== undefined) {
    return { ok: true, row: toPhone(row) };
  }
  return { ok: false, current: await getPhone(sql, number) };
}

/**
 * START: clears the stopped flag, records the start time and opens the chat again (RULES 4.1b: START sets it), if the
 * phone is still at `expectedVersion`. The stop time stays as the last STOP's. `at` is when the START came (default now).
 */
export async function startPhone(
  sql: Db,
  number: string,
  expectedVersion: number,
  at?: Date,
): Promise<UpdateResult<Phone>> {
  assertVersion(expectedVersion);
  const [row] = await sql<PhoneRow[]>`
    update phones set
      stopped = false,
      chat_open = true,
      chat_open_at = coalesce(chat_open_at, coalesce(${at ?? null}::timestamptz, clock_timestamp())),
      start_at = coalesce(${at ?? null}::timestamptz, clock_timestamp()),
      version = ${expectedVersion + 1}
    where number = ${number} and version = ${expectedVersion}
    returning *
  `;
  if (row !== undefined) {
    return { ok: true, row: toPhone(row) };
  }
  return { ok: false, current: await getPhone(sql, number) };
}

export interface SetStoppedOptions {
  /** When the STOP or START came (default now). */
  at?: Date;
  /** Reads and writes tried before giving up (default 100; each lost round means another writer won it). */
  maxAttempts?: number;
}

/**
 * STOP (`stopped` true) or START (false) that always lands: reads the phone, returns at once when it is already as
 * asked (`changed` false, nothing written, no version spent), else compares and sets, and reads again when another
 * writer got there first. Returns null when the phone does not exist. Throws only after `maxAttempts` lost rounds.
 */
export async function setPhoneStopped(
  sql: Db,
  number: string,
  stopped: boolean,
  options: SetStoppedOptions = {},
): Promise<{ changed: boolean; phone: Phone } | null> {
  const maxAttempts = options.maxAttempts ?? 100;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const phone = await getPhone(sql, number);
    if (phone === null) {
      return null;
    }
    if (phone.stopped === stopped) {
      return { changed: false, phone };
    }
    const result = stopped
      ? await stopPhone(sql, number, phone.version, options.at)
      : await startPhone(sql, number, phone.version, options.at);
    if (result.ok) {
      return { changed: true, phone: result.row };
    }
  }
  throw new Error(`setPhoneStopped: lost ${String(maxAttempts)} rounds to other writers`);
}

/**
 * The mobile texted Rosie's number: records the first text time and the service Linq reports, and opens the chat
 * unless the phone is stopped (a text while stopped is not a START). A later text keeps the first time.
 */
export async function recordChatOpened(
  sql: Db,
  number: string,
  expectedVersion: number,
  options: { chatWay?: ChatWay; at?: Date } = {},
): Promise<UpdateResult<Phone>> {
  assertVersion(expectedVersion);
  const [row] = await sql<PhoneRow[]>`
    update phones set
      chat_open = not stopped,
      chat_open_at = coalesce(chat_open_at, ${options.at ?? null}::timestamptz, clock_timestamp()),
      chat_way = coalesce(${options.chatWay ?? null}, chat_way),
      version = ${expectedVersion + 1}
    where number = ${number} and version = ${expectedVersion}
    returning *
  `;
  if (row !== undefined) {
    return { ok: true, row: toPhone(row) };
  }
  return { ok: false, current: await getPhone(sql, number) };
}

/** The mobile was added as a Linq contact (MC C9). The first time stays if it was added before. */
export async function recordLinqContactAdded(
  sql: Db,
  number: string,
  expectedVersion: number,
  at?: Date,
): Promise<UpdateResult<Phone>> {
  assertVersion(expectedVersion);
  const [row] = await sql<PhoneRow[]>`
    update phones set
      linq_contact_added_at = coalesce(linq_contact_added_at, ${at ?? null}::timestamptz, clock_timestamp()),
      version = ${expectedVersion + 1}
    where number = ${number} and version = ${expectedVersion}
    returning *
  `;
  if (row !== undefined) {
    return { ok: true, row: toPhone(row) };
  }
  return { ok: false, current: await getPhone(sql, number) };
}

/** The mobile voted in a poll. The first time stays. */
export async function recordPollVoted(
  sql: Db,
  number: string,
  expectedVersion: number,
  at?: Date,
): Promise<UpdateResult<Phone>> {
  assertVersion(expectedVersion);
  const [row] = await sql<PhoneRow[]>`
    update phones set
      poll_voted_at = coalesce(poll_voted_at, ${at ?? null}::timestamptz, clock_timestamp()),
      version = ${expectedVersion + 1}
    where number = ${number} and version = ${expectedVersion}
    returning *
  `;
  if (row !== undefined) {
    return { ok: true, row: toPhone(row) };
  }
  return { ok: false, current: await getPhone(sql, number) };
}

/** The STOP, HELP and rates line was delivered to the mobile. The first time stays. */
export async function recordOptoutLineDelivered(
  sql: Db,
  number: string,
  expectedVersion: number,
  at?: Date,
): Promise<UpdateResult<Phone>> {
  assertVersion(expectedVersion);
  const [row] = await sql<PhoneRow[]>`
    update phones set
      optout_line_delivered_at = coalesce(optout_line_delivered_at, ${at ?? null}::timestamptz, clock_timestamp()),
      version = ${expectedVersion + 1}
    where number = ${number} and version = ${expectedVersion}
    returning *
  `;
  if (row !== undefined) {
    return { ok: true, row: toPhone(row) };
  }
  return { ok: false, current: await getPhone(sql, number) };
}

// ---- pauses -------------------------------------------------------------------------------------------------------

export async function getPause(sql: Db, id: string): Promise<Pause | null> {
  const [row] = await sql<PauseRow[]>`select * from pauses where id = ${id}`;
  return row === undefined ? null : toPause(row);
}

/**
 * Sets a pause on a person, a phone or an address, at version 1. Exactly the fields of its target are set (the
 * database checks pauses_one_target). An address arrives already sealed (sealing.ts) with the person whose key sealed it.
 */
export async function createPause(sql: Db, input: NewPause): Promise<Pause> {
  const personId = input.target === "person" ? input.personId : null;
  const phoneNumber = input.target === "phone" ? input.phoneNumber : null;
  const address = input.target === "address" ? input.address : null;
  const sealedFor = input.target === "address" ? input.sealedForPersonId : null;
  const [row] = await sql<PauseRow[]>`
    insert into pauses (
      id, business_id, target, person_id, phone_number, address, sealed_for_person_id, set_by_turn_id, set_at
    )
    values (
      ${input.id}, ${input.businessId}, ${input.target}, ${personId}, ${phoneNumber}, ${address}, ${sealedFor},
      ${input.setByTurnId ?? null}, coalesce(${input.setAt ?? null}::timestamptz, clock_timestamp())
    )
    returning *
  `;
  if (row === undefined) {
    throw new Error("insert into pauses returned no row");
  }
  return toPause(row);
}

/**
 * The owner clears a pause: records the time and who, if it is still at `expectedVersion` and not yet cleared. The row
 * stays. Clearing a cleared pause is refused as a conflict, with the row as it is.
 */
export async function clearPause(
  sql: Db,
  id: string,
  expectedVersion: number,
  clearedByPersonId: string,
  at?: Date,
): Promise<UpdateResult<Pause>> {
  assertVersion(expectedVersion);
  const [row] = await sql<PauseRow[]>`
    update pauses set
      cleared_at = coalesce(${at ?? null}::timestamptz, clock_timestamp()),
      cleared_by_person_id = ${clearedByPersonId},
      version = ${expectedVersion + 1}
    where id = ${id} and version = ${expectedVersion} and cleared_at is null
    returning *
  `;
  if (row !== undefined) {
    return { ok: true, row: toPause(row) };
  }
  return { ok: false, current: await getPause(sql, id) };
}

/** A person's pauses that still hold (the gate and the dispatcher check these), across every business. */
export async function listOpenPausesOfPerson(sql: Db, personId: string): Promise<Pause[]> {
  const rows = await sql<PauseRow[]>`
    select * from pauses where person_id = ${personId} and cleared_at is null order by set_at, id
  `;
  return rows.map(toPause);
}

/** A phone's pauses that still hold, across every business. */
export async function listOpenPausesOfPhone(sql: Db, number: string): Promise<Pause[]> {
  const rows = await sql<PauseRow[]>`
    select * from pauses where phone_number = ${number} and cleared_at is null order by set_at, id
  `;
  return rows.map(toPause);
}
