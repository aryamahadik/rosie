// The ids of the rows the safety service writes (T-318). Ids are opaque strings code makes and never parses (CQ-09; K-04
// v1 rule 3). Each is made from the text's event id, the key K-09 v1 names for recordSafetyOutcome ("Repeat: safe: the
// text's event id is the key; one outcome row per text"), so the same text recorded again, by a lapsed turn's rerun or by
// the batch turn after the actor's arrival record, names the same rows, finds them written and answers `repeated`.

/** The rows a safety record writes. */
export type SafetyRow =
  /** The outcome row (K-34 v1 safety_outcomes). */
  | "outcome"
  /** Its hold on routine actions (K-34 v1 safety_holds). */
  | "hold"
  /** The outcome step's checked line, an outbox row of send class safety (K-09 v1 recordSafetyOutcome). */
  | "line"
  /** A harm report to Rosie's team that day (K-34 v1 harm_reports; A3-49). */
  | "harmReport";

export interface SafetyIds {
  /** The id of the row of `row` for the text whose event id is `eventId`. */
  rowId(row: SafetyRow, eventId: string): Promise<string>;
}

const PREFIX: Readonly<Record<SafetyRow, string>> = {
  outcome: "safety-outcome",
  hold: "safety-hold",
  line: "out-safety-line",
  harmReport: "harm-report",
};

const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The ids the Worker uses: the row's kind and the first 32 hex digits of the SHA-256 of its kind and the event id, so they
 * carry no words, number or name, and are K-08 v1 safe ids (letters, digits and dashes).
 */
export const KEYED_SAFETY_IDS: SafetyIds = {
  async rowId(row, eventId) {
    const hash = await sha256Hex(JSON.stringify([row, eventId]));
    return `${PREFIX[row]}-${hash.slice(0, 32)}`;
  },
};
