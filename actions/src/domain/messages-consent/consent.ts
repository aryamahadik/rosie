// The consent rows the messages-and-consent service gives the commit (T-307; C-102; K-29 v1 consents): every yes and
// every stop as its own row, never edited (FS line 753). A withdrawal is a new row with revoked true; START, or a fresh yes
// on a new booking from that number, is a new row with revoked false (RULES 7.5); for one person, kind, business and
// contact the newest row decides (K-29 README "Revoked is a row, not an edit").
//
// A row reaches the database as one K-05 v1 state write, an insert into consents, inside the turn's one commit (arch 10
// line 508). The database refuses an update or a delete of a consent row (SQLSTATE 42501: refuse-consent-update.json);
// code refuses one first (assertConsentsAppendOnly), so an edit is never sent.

import type { ConsentChannel, ConsentKind, ConsentRead } from "../../../../db/repo/consent";
import type { StateWrite } from "../../commit";

export type { ConsentChannel, ConsentKind };

/** K-29 v1 consents_kind_known: FS line 735's kinds, with no automated calls (Q-05) and no face match (MC C10). */
export const CONSENT_KINDS: readonly ConsentKind[] = [
  "texts",
  "photos_shown",
  "ticked_terms",
  "plan_terms",
  "fee_ok",
  "health_agreement",
];

/** K-29 v1 consents_channel_known: where a yes or a stop was given; no call (Q-05). */
export const CONSENT_CHANNELS: readonly ConsentChannel[] = ["text", "email", "page", "ai"];

export const CONSENTS_TABLE = "consents";

/** Why a consent row is refused: each names a fault, never a value. */
export type ConsentFault =
  /** Not one of K-29's kinds (consents_kind_known; refuse-face-match-kind.json). */
  | "kindUnknown"
  /** Not one of K-29's channels (consents_channel_known). */
  | "channelUnknown"
  /** No words shown, or blank (consents_words_given; RULES 6.7: "Each yes is kept with the words shown"). */
  | "wordsMissing"
  /** A texts row names no contact (consents_texts_has_contact; RULES 7.2). */
  | "textsNeedContact"
  /** Ticked terms name no booking (consents_ticked_terms_has_booking; A5-07). */
  | "termsNeedBooking"
  /** A chat link on a row that is not texts (consents_chat_link_only_texts; MC C9). */
  | "chatLinkOnlyTexts"
  /** A row for every business (no business) that is not texts (consents_every_business_only_texts; D102). */
  | "everyBusinessOnlyTexts"
  /** The time is not an instant in UTC ending in Z (CQ-09). */
  | "timeNotUtc"
  /** An id that is not a non-empty string (CQ-09). */
  | "idMissing"
  /** The contact is not one of the person's own handles (RULES 7.1: "their own number"; RULES 7.2: a stop for another number changes nothing). */
  | "notTheirContact"
  /** The yes came from a handle that is not the person's (RULES 7.1: "Never on someone else's word"; S13-32). */
  | "notFromThem"
  /**
   * A texts yes for a stopped mobile that is not a fresh yes on a booking sent from that number: only START turns texts
   * back on for every business (RULES 7.5; MC C1; T-192 security note N5).
   */
  | "stoppedNumber"
  /** An update or a delete of a consent row (FS line 753; K-29 refuse-consent-update.json, SQLSTATE 42501). */
  | "neverEdited";

/** A consent row refused before the commit (fail closed: nothing is written for it). */
export class ConsentRefusedError extends Error {
  readonly fault: ConsentFault;

  constructor(fault: ConsentFault) {
    super(`consent row refused: ${fault}`);
    this.name = "ConsentRefusedError";
    this.fault = fault;
  }
}

/** A consent row's columns as K-29 v1 names them and its seeds write them (K-05 v1 stateWrite: "as K-04's seed fixtures write them"). */
export interface ConsentValues {
  id: string;
  person_id: string;
  /** Null only on a texts row from a STOP or a START, which covers every business (D102; RULES 7.2, 7.5). */
  business_id: string | null;
  kind: ConsentKind;
  revoked: boolean;
  handle_id: string | null;
  booking_id: string | null;
  /** The words shown when the yes was given, or the person's own words that withdrew it; never sealed (arch 09 line 492). */
  exact_words: string;
  /** sha256 of exact_words in UTF-8, lowercase hex (consents_words_sha256_match). */
  words_sha256: string;
  /** An instant in UTC ending in Z. */
  at: string;
  channel: ConsentChannel;
  chat_link_id: string | null;
  /** The turn that committed the row, whose read-back the yes answered; null for a row no turn wrote. */
  turn_id: string | null;
}

/** One consent row as the insert the commit writes for it: the only write a consent row ever gets (K-29 rule 5). */
export interface ConsentWrite {
  readonly op: "insert";
  readonly table: typeof CONSENTS_TABLE;
  readonly values: ConsentValues;
}

/** The consent row as a K-05 v1 state write, for UnitWrites.state. */
export function stateWriteOf(write: ConsentWrite): StateWrite {
  return { op: write.op, table: write.table, values: { ...write.values } };
}

const UTC = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:[.][0-9]+)?Z$/;

/**
 * An instant in UTC ending in Z that names a real moment (common formats v1 utc: "Whether the date exists is a code
 * check"): its date and time read back the same, so the 30th of February is refused, not moved to March.
 */
export function assertUtc(at: unknown): asserts at is string {
  const parts = typeof at === "string" ? UTC.exec(at)?.slice(1, 7).map(Number) : undefined;
  const [year, month, day, hour, minute, second] = parts ?? [];
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    throw new ConsentRefusedError("timeNotUtc");
  }
  const moment = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const readsBack =
    moment.getUTCFullYear() === year &&
    moment.getUTCMonth() === month - 1 &&
    moment.getUTCDate() === day &&
    moment.getUTCHours() === hour &&
    moment.getUTCMinutes() === minute &&
    moment.getUTCSeconds() === second;
  if (!readsBack) throw new ConsentRefusedError("timeNotUtc");
}

const encoder = new TextEncoder();

/** The sha256 of the words in UTF-8, in lowercase hex (K-29 default 5; the CHECK the database holds it to). */
export async function wordsSha256(words: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(words));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Holds a new row to the rules K-29's table list gives it (consents_kind_known, consents_channel_known,
 * consents_words_given, consents_texts_has_contact, consents_ticked_terms_has_booking, consents_chat_link_only_texts,
 * consents_every_business_only_texts), so a malformed row is refused before the commit rather than by the database.
 */
export function checkConsentValues(values: ConsentValues): void {
  if (!CONSENT_KINDS.includes(values.kind)) throw new ConsentRefusedError("kindUnknown");
  if (!CONSENT_CHANNELS.includes(values.channel)) throw new ConsentRefusedError("channelUnknown");
  if (typeof values.exact_words !== "string" || values.exact_words.trim() === "") {
    throw new ConsentRefusedError("wordsMissing");
  }
  if (values.kind === "texts" && values.handle_id === null) throw new ConsentRefusedError("textsNeedContact");
  if (values.kind === "ticked_terms" && values.booking_id === null)
    throw new ConsentRefusedError("termsNeedBooking");
  if (values.chat_link_id !== null && values.kind !== "texts")
    throw new ConsentRefusedError("chatLinkOnlyTexts");
  if (values.business_id === null && values.kind !== "texts") {
    throw new ConsentRefusedError("everyBusinessOnlyTexts");
  }
  assertUtc(values.at);
}

/**
 * Refuses any state write that would edit a consent row: K-29 v1's consents take inserts only (FS line 753: "consent
 * rows are never edited"; rule 5: no update or delete grant, SQLSTATE 42501; refuse-consent-update.json). A STOP, a START
 * or a switch of contact is a new row. Run on a unit's state writes before the commit, so an edit never reaches it.
 */
export function assertConsentsAppendOnly(writes: readonly StateWrite[]): void {
  for (const write of writes) {
    if (write.table === CONSENTS_TABLE && write.op !== "insert") throw new ConsentRefusedError("neverEdited");
  }
}

/** Ids compared as whole strings, never parsed (CQ-09). */
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The row that decides among rows of one person, kind, business and contact: the newest by `at`, a tie to the lower id
 * (K-29 README; K-05 v1.2 default 35). Null when there is none.
 */
export function newestDecides<Row extends Pick<ConsentRead, "id" | "at">>(rows: readonly Row[]): Row | null {
  let newest: Row | null = null;
  for (const row of rows) {
    if (
      newest === null ||
      row.at.getTime() > newest.at.getTime() ||
      (row.at.getTime() === newest.at.getTime() && byId(row.id, newest.id) < 0)
    ) {
      newest = row;
    }
  }
  return newest;
}

/**
 * The row that decides whether a person's contact takes texts for a business: of the person's texts rows for that
 * contact, the business's own and those for every business (a STOP or a START), the newest (K-29 README; default 35).
 * Under a business scope the rows for every business are not read (K-29 rule 4), so for a mobile the stopped flag is
 * what tells a STOP (RULES 4.1b; K-04 phones.stopped, written in the STOP's commit).
 */
export function textsStanding(
  rows: readonly ConsentRead[],
  personId: string,
  businessId: string,
  handleId: string,
): ConsentRead | null {
  return newestDecides(
    rows.filter(
      (row) =>
        row.personId === personId &&
        row.kind === "texts" &&
        row.handleId === handleId &&
        (row.businessId === businessId || row.businessId === null),
    ),
  );
}
