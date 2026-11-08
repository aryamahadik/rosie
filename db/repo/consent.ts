// Consent rows and chat links: the reads and appends (K-29 v1, the conversations and consent part; T-192).
//
// A consent row is never edited (FS line 753): a yes, a STOP, a START and a switch of contact are each a new row, and for
// one person, kind, business and contact the newest row (by `at`, then the lower id) decides. The database refuses an
// update or a delete with SQLSTATE 42501, whoever asks, so this file has no call that edits one. A STOP or a START covers
// every business at once (one number, D102): its row has no business, so no business scope reads it, and the guard and
// limit 8 read consents on the runtime side, unscoped (K-29 rule 4).
//
// The words' hash is made by the database from the words themselves (sha256 over their UTF-8, lowercase hex), so a row
// always holds the hash of its own words; the caller reads it back for the event log's proofs (K-08).
//
// A chat link (MC C9; RULES 4.1b) opens Messages to Rosie's number with a ready text holding a short code. Issuing one is
// an append. Giving it in a new place, telling the owner again and recording its ready text are updates under its
// version (the action layer's C-102, through K-05's commit), not here; so is the check that the mobile is already a Linq
// contact before a link is issued (Q-03).
//
// Row-level security decides what each call sees: pass a transaction scoped by withBusiness() for a Tool API call (K-05
// scope business), or a runtime transaction with no scope (the guard, the dispatcher, the actor). Nothing here logs: a
// row's words and a ready text are personal data.
import { readBusinessScope, type Sql, type Tx } from "./scope";

type Db = Sql | Tx;

/** FS line 735's kinds, without automated calls (Q-05) and face match (MC C10). */
export type ConsentKind =
  "texts" | "photos_shown" | "ticked_terms" | "plan_terms" | "fee_ok" | "health_agreement";
/** Where a yes or a stop was given: no call (Q-05). */
export type ConsentChannel = "text" | "email" | "page" | "ai";
export type ChatLinkPurpose = "booking" | "staff_invite";
/** Where a chat link has been given (MC C9). */
export type ChatLinkPlace = "booking_page" | "confirmation_email" | "customer_ai" | "owner";

/** A consent row as stored, with the exact words shown. */
export interface Consent {
  id: string;
  personId: string;
  /** Null only for a texts row from a STOP or a START, which covers every business. */
  businessId: string | null;
  kind: ConsentKind;
  /** True when the row withdraws a consent of its kind; its `at` is when it was withdrawn. */
  revoked: boolean;
  /** The contact the row is about (handles.id); every texts row names one. */
  handleId: string | null;
  bookingId: string | null;
  /** The words shown when the yes was given, or the person's own words that withdrew it. Never sealed. */
  exactWords: string;
  /** sha256 of `exactWords` in UTF-8, lowercase hex. */
  wordsSha256: string;
  at: Date;
  channel: ConsentChannel;
  chatLinkId: string | null;
  turnId: string | null;
}

/** K-05 v1.2's consent row as `readTurnState` returns it: the row without its exact words (K-05 default 36). */
export type ConsentRead = Omit<Consent, "exactWords">;

/** K-05 v1.2's `sendState.textsConsent`: the newest texts row covering a contact for a business (K-05 default 35). */
export interface TextsConsent {
  consentId: string;
  businessId: string | null;
  revoked: boolean;
  at: Date;
}

export interface NewConsent {
  id: string;
  personId: string;
  /** Required, so a row for every business (a STOP or START) is always asked for by name: null. */
  businessId: string | null;
  kind: ConsentKind;
  /** Default false: a yes. */
  revoked?: boolean;
  handleId?: string | null;
  bookingId?: string | null;
  exactWords: string;
  /** When the yes was given or the stop came. */
  at: Date;
  channel: ConsentChannel;
  chatLinkId?: string | null;
  turnId?: string | null;
}

/** A chat link as stored. */
export interface ChatLink {
  id: string;
  /** In the ready text; matches a sent ready text to this link. Unique across every link. */
  shortCode: string;
  purpose: ChatLinkPurpose;
  businessId: string;
  /** A booking link's booking; null for a staff invite. */
  bookingId: string | null;
  personId: string;
  /** The mobile whose sent ready text counts (phones.number). */
  phoneNumber: string;
  readyText: string;
  givenVia: ChatLinkPlace[];
  issuedAt: Date;
  /** When the owner was told once and given a staff invite again, 48 hours after it went unanswered. */
  ownerRetoldAt: Date | null;
  /** When the ready text arrived from `phoneNumber`. */
  usedAt: Date | null;
  version: number;
}

export interface NewChatLink {
  id: string;
  shortCode: string;
  purpose: ChatLinkPurpose;
  businessId: string;
  /** Required for a booking link, null for a staff invite (the database checks the pair). */
  bookingId: string | null;
  personId: string;
  phoneNumber: string;
  /** Must hold the short code. */
  readyText: string;
  /** At least one place. */
  givenVia: readonly ChatLinkPlace[];
  /** Default: the transaction's now(), as the column's default. */
  issuedAt?: Date;
}

interface ConsentRow {
  id: string;
  person_id: string;
  business_id: string | null;
  kind: ConsentKind;
  revoked: boolean;
  handle_id: string | null;
  booking_id: string | null;
  exact_words: string;
  words_sha256: string;
  at: Date;
  channel: ConsentChannel;
  chat_link_id: string | null;
  turn_id: string | null;
}

type ConsentReadRow = Omit<ConsentRow, "exact_words">;

interface ChatLinkRow {
  id: string;
  short_code: string;
  purpose: ChatLinkPurpose;
  business_id: string;
  booking_id: string | null;
  person_id: string;
  phone_number: string;
  ready_text: string;
  given_via: ChatLinkPlace[];
  issued_at: Date;
  owner_retold_at: Date | null;
  used_at: Date | null;
  version: number;
}

const toConsentRead = (row: ConsentReadRow): ConsentRead => ({
  id: row.id,
  personId: row.person_id,
  businessId: row.business_id,
  kind: row.kind,
  revoked: row.revoked,
  handleId: row.handle_id,
  bookingId: row.booking_id,
  wordsSha256: row.words_sha256,
  at: row.at,
  channel: row.channel,
  chatLinkId: row.chat_link_id,
  turnId: row.turn_id,
});

const toConsent = (row: ConsentRow): Consent => ({ ...toConsentRead(row), exactWords: row.exact_words });

const toChatLink = (row: ChatLinkRow): ChatLink => ({
  id: row.id,
  shortCode: row.short_code,
  purpose: row.purpose,
  businessId: row.business_id,
  bookingId: row.booking_id,
  personId: row.person_id,
  phoneNumber: row.phone_number,
  readyText: row.ready_text,
  givenVia: [...row.given_via],
  issuedAt: row.issued_at,
  ownerRetoldAt: row.owner_retold_at,
  usedAt: row.used_at,
  version: row.version,
});

// ---- consent rows -------------------------------------------------------------------------------------------------

/**
 * Adds one consent row and returns it as stored, its hash made by the database from the words. A STOP is
 * `{ kind: "texts", revoked: true, businessId: null, handleId: <the mobile's handle> }` with the person's own words; a
 * switch of contact is a revoked row for the old contact and a yes for the new one. The database refuses a repeated id
 * (23505), a missing person, business, contact, booking, chat link or turn (23503), and a row that breaks a rule of the
 * table list (23514: an unknown kind or channel, blank words, a row with no business that is not texts, texts with no
 * contact, ticked terms with no booking, a chat link on a row that is not texts). Under a business scope, a row of
 * another business or of none is refused by row-level security (42501).
 */
export async function appendConsent(db: Db, input: NewConsent): Promise<Consent> {
  const [row] = await db<ConsentRow[]>`
    insert into consents (
      id, person_id, business_id, kind, revoked, handle_id, booking_id, exact_words, words_sha256, at, channel,
      chat_link_id, turn_id
    ) values (
      ${input.id}, ${input.personId}, ${input.businessId}, ${input.kind}, ${input.revoked ?? false},
      ${input.handleId ?? null}, ${input.bookingId ?? null}, ${input.exactWords},
      encode(sha256(convert_to(${input.exactWords}::text, 'UTF8')), 'hex'), ${input.at}, ${input.channel},
      ${input.chatLinkId ?? null}, ${input.turnId ?? null}
    )
    returning *
  `;
  if (row === undefined) {
    throw new Error("insert into consents returned no row");
  }
  return toConsent(row);
}

/** One consent row by its id, with its words, or null (also when the transaction's scope hides it). */
export async function getConsent(db: Db, id: string): Promise<Consent | null> {
  const [row] = await db<ConsentRow[]>`select * from consents where id = ${id}`;
  return row === undefined ? null : toConsent(row);
}

/**
 * The consent rows of these people that the transaction's scope shows, without their words (K-05 v1.2 readTurnState's
 * `consents`: under a business scope, that business's rows only, so never a STOP or START row), by `at`, then id.
 */
export async function listConsentsOfPersons(db: Db, personIds: readonly string[]): Promise<ConsentRead[]> {
  if (personIds.length === 0) {
    return [];
  }
  const rows = await db<ConsentReadRow[]>`
    select id, person_id, business_id, kind, revoked, handle_id, booking_id, words_sha256, at, channel, chat_link_id,
           turn_id
    from consents
    where person_id in ${db([...personIds])}
    order by at, id
  `;
  return rows.map(toConsentRead);
}

/**
 * The newest texts row for a contact that covers `businessId`: that business's own rows and the rows for every business
 * (a STOP or a START), by `at`, a tie to the lower id (K-05 v1.2 sendState's `textsConsent`, default 35). With
 * `businessId` null, only the rows for every business count. Null when there is none. It runs on the runtime side, with
 * no scope, and throws under a business scope, which hides the STOP and START rows and so would read a withdrawn yes as
 * standing.
 */
export async function newestTextsConsent(
  db: Db,
  handleId: string,
  businessId: string | null,
): Promise<TextsConsent | null> {
  if ((await readBusinessScope(db)) !== null) {
    throw new Error("newestTextsConsent runs with no business scope: a scope hides the STOP and START rows");
  }
  const [row] = await db<{ id: string; business_id: string | null; revoked: boolean; at: Date }[]>`
    select id, business_id, revoked, at
    from consents
    where handle_id = ${handleId}
      and kind = 'texts'
      and (business_id is null or business_id = ${businessId}::text)
    order by at desc, id
    limit 1
  `;
  return row === undefined
    ? null
    : { consentId: row.id, businessId: row.business_id, revoked: row.revoked, at: row.at };
}

// ---- chat links ---------------------------------------------------------------------------------------------------

/**
 * Issues a chat link at version 1 and returns it as stored. The database refuses a short code already used (23505), a
 * missing business, booking, person or phone (23503), and a link that breaks a rule of the table list (23514: an
 * unknown purpose, a booking link with no booking or an invite with one, a code with a space, a ready text without its
 * code, no place or an unknown one).
 */
export async function issueChatLink(db: Db, input: NewChatLink): Promise<ChatLink> {
  const [row] = await db<ChatLinkRow[]>`
    insert into chat_links (
      id, short_code, purpose, business_id, booking_id, person_id, phone_number, ready_text, given_via, issued_at
    ) values (
      ${input.id}, ${input.shortCode}, ${input.purpose}, ${input.businessId}, ${input.bookingId},
      ${input.personId}, ${input.phoneNumber}, ${input.readyText}, ${[...input.givenVia]}::text[],
      coalesce(${input.issuedAt ?? null}::timestamptz, now())
    )
    returning *
  `;
  if (row === undefined) {
    throw new Error("insert into chat_links returned no row");
  }
  return toChatLink(row);
}

/** One chat link by its id, or null (also when the transaction's scope hides it). */
export async function getChatLink(db: Db, id: string): Promise<ChatLink | null> {
  const [row] = await db<ChatLinkRow[]>`select * from chat_links where id = ${id}`;
  return row === undefined ? null : toChatLink(row);
}

/**
 * The link a short code names, or null. Matching a sent ready text to its link is runtime work, with no scope (K-29
 * rule 4); under a business scope only that business's links are found.
 */
export async function findChatLinkByShortCode(db: Db, shortCode: string): Promise<ChatLink | null> {
  const [row] = await db<ChatLinkRow[]>`select * from chat_links where short_code = ${shortCode}`;
  return row === undefined ? null : toChatLink(row);
}
