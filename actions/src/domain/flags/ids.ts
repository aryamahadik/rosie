// The ids of the rows the flags service writes (T-317). Ids are opaque strings code makes and never parses (CQ-09; K-04
// v1 rule 3). Each is made from the call's key and the row's part in it, so a repeat of one key names the same rows, finds
// them written and answers `repeated` (K-09 v1 recordStopOrStart: "Repeat: safe: the text's turn ... is the key";
// setRecordFlag: "a flag already as asked answers repeated"). A STOP or START the handle actor writes on return is keyed
// by its text's event id, so the same text replayed twice is written once (arch 11 line 566; T-269's security note c).

/** The rows a flags call writes. */
export type FlagRow =
  /** A consent row of a STOP, a START or a work phone's answer (K-29 v1 consents), one per person behind the phone. */
  | "consent"
  /** The stop's one reply, a quick_reply outbox row (K-09 README default 6; RULES 7.3). */
  | "stopReply"
  /** A work phone's "which texts?" question (RULES 7.7; K-09 v1 askedWhichTexts). */
  | "whichTexts"
  /** A pause row (K-04 v1 pauses). */
  | "pause"
  /** A call-off clock row a pause arms (S11-62; K-04 v1 clock_rows kind step). */
  | "callOff";

export interface FlagIds {
  /** The id of the row of `row` this call writes, for its key and, where a call writes several, the part it is for. */
  rowId(row: FlagRow, key: string, part?: string): Promise<string>;
}

const PREFIX: Readonly<Record<FlagRow, string>> = {
  consent: "consent",
  stopReply: "out-stop-reply",
  whichTexts: "oq-which-texts",
  pause: "pause",
  callOff: "clock-call-off",
};

const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The ids the Worker uses: the row's kind and the first 32 hex digits of the SHA-256 of its kind, key and part, so they
 * carry no key, number or name, and are K-08 v1 safe ids (letters, digits and dashes, never a run of digits).
 */
export const KEYED_IDS: FlagIds = {
  async rowId(row, key, part) {
    const hash = await sha256Hex(JSON.stringify([row, key, part ?? null]));
    return `${PREFIX[row]}-${hash.slice(0, 32)}`;
  },
};
