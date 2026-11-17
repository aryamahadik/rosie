// The ids of the rows the paging and hand-offs service writes (T-319). Ids are opaque strings code makes and never parses
// (CQ-09; K-04 v1 rule 3). Each is made from the call's key and the row's part in it, so a repeat of one key names the
// same rows, finds them written and answers `repeated` (K-09 v1: handOff "the turn or request id is the key"; pageTeam
// "the caller's request id (or, for a repeat page, the clock row) is the key"; openReviewItem "the turn or request id is
// the key"). A page's rows and clock rows are keyed by the page and the page's number, so the n-th page of a page names
// the same rows however often its clock's firing is run again.

/** The rows the service writes. */
export type PagingRow =
  /** A page to Rosie's team (K-36 v1 team_pages), by its key (page.ts pageKeyOf). */
  | "page"
  /** One person's outbox row of one page: the key is the page's id, the part `<page number>/<person id>`. */
  | "pageRow"
  /** The clock row that sends a repeating page's next page: the key is the page's id, the part the number it sends. */
  | "pageClock"
  /** A hand-off (K-36 v1 hand_offs), by its key (hand-off.ts handOffKeyOf). */
  | "handOff"
  /** A hand-off's alert to the person told (K-36 v1 hand_offs.alert_outbox_row_id): the key is the hand-off's id. */
  | "alert"
  /** A hand-off's escalation clock row (K-36 v1 hand_offs.escalation_clock_row_id): the key is the hand-off's id. */
  | "escalation"
  /** A report about the owner or staff (K-34 v1 harm_reports, about_owner_or_staff), by the hand-off's key. */
  | "harmReport"
  /** A team review item (K-37 v1 review_items), by its key (review.ts reviewKeyOf). */
  | "reviewItem";

export interface PagingIds {
  /** The id of the row of `row` this call writes, for its key and, where a call writes several, the part it is for. */
  rowId(row: PagingRow, key: string, part?: string): Promise<string>;
}

const PREFIX: Readonly<Record<PagingRow, string>> = {
  page: "page",
  pageRow: "out-page",
  pageClock: "clock-page",
  handOff: "handoff",
  alert: "out-alert",
  escalation: "clock-handoff",
  harmReport: "harm",
  reviewItem: "review",
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
export const KEYED_PAGING_IDS: PagingIds = {
  async rowId(row, key, part) {
    const hash = await sha256Hex(JSON.stringify(["paging", row, key, part ?? null]));
    return `${PREFIX[row]}-${hash.slice(0, 32)}`;
  },
};
