// Data-access v1.24: a business's open review items of one kind (K-05 v1.24 item 88, defaults 226 and 228; T-1561, the
// ruling T-1543's card A10, ops/reviews/signup-remainder/rule-rest.json; DL-1228). Its readers bind it on the runtime
// side: card B11 for B8 (S1-75's reach settler: an open listing_match or control item of the business holds S1-75 back;
// B11 reads it first and releases its connection before item 87's readTurnState), and card E10 (staging's
// testReviewItems, once per kind for each test business item 89 answers, whose decision goes through K-09
// decideReviewItem at the version this read gave).
//
//   openReviewItemsOf  a business id and a K-37 kind give every review_items row of that business and kind whose state
//                      is open or waiting, never done (default 228: an item waiting on someone else is still undecided),
//                      in id order (byte by byte, collate "C": CQ-09), each as its id, kind, state, version and
//                      raised_by_person_id (raisedByPersonId); none is an empty list, never notFound.
//
// Role and side (default 226; K-37 rule 2: no Tool API role reads review_items): the runtime side, as rosie_job (pass the
// runtime side's client: the role is the connection's), the business scope set empty for the transaction, its own
// read-only transaction at repeatable read on its own connection on the primary, uncached, beside a Tool API call's
// transaction and never on it, 1 connection, released before it answers. review_items has no row-level security (0014: a
// table that spans businesses, granted to rosie_job alone), so no policy holds the read to the business: its one
// statement names business_id = the request's business itself (the security reviewer's note (c) on T-1549), and a row of
// another business is never answered. rosie_app holds no grant on review_items, so the Tool API's role is refused by
// PostgreSQL's privilege check (42501, thrown scrubbed as DataAccessDatabaseError).
//
// What it reads and never reads: review_items' id, kind, state, version, raised_by_person_id and business_id. No
// statement names summary (Rosie's team's words for the team console alone: refuse-open-review-items-summary),
// subject_table, subject_row_id, turn_id, opened_at, due_at, wait_until or decided_at.
//
// Errors (K-05 README: every call may answer transient). A serialization failure, a deadlock or a lost connection answers
// transient, with its SQLSTATE alone; any other database error is thrown scrubbed (clocks.ts transientOrScrubbed). A
// request of the wrong shape (a field beside businessId and kind, an id that is no non-empty text, a kind K-37 does not
// name) throws a TypeError before any statement, naming the field, never its value.
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.24";
import { transientOrScrubbed } from "./clocks";
import type { Sql } from "./scope";
import { assertRequestShape, inRuntimeTransaction } from "./targets";

/** K-05 v1.24 openReviewItemsOf.request: the business and the K-37 kind. */
export type OpenReviewItemsOfRequest = K05.OpenReviewItemsOfRequest;
/** K-05 v1.24 openReviewItemsOf.response: the business's open and waiting items of the kind, in id order. */
export type OpenReviewItemsOfResponse = K05.OpenReviewItemsOfResponse;
/** K-05 v1.24 openReviewItemsOf.errors: transient alone. */
export type OpenReviewItemsOfError = K05.OpenReviewItemsOfErrors;
export type OpenReviewItemsOfOutcome = OpenReviewItemsOfResponse | OpenReviewItemsOfError;
export type ReviewItemKind = K05.ReviewItemKind;
export type OpenReviewItem = K05.OpenReviewItem;

const CALL = "openReviewItemsOf";

/** K-37 v1 review_items.kind (review_items_kind_known; K-05 v1.24 reviewItemKind). */
export const REVIEW_ITEM_KINDS: ReadonlySet<string> = new Set<ReviewItemKind>([
  "new_work",
  "control",
  "listing_match",
  "owner_claim",
  "booking_cap",
  "harm_report",
  "missed_deadline",
]);

/** The business and the kind, refused unless each is of its shape. */
function requestOf(request: unknown): { businessId: string; kind: ReviewItemKind } {
  assertRequestShape(request, CALL, ["businessId", "kind"]);
  const { businessId, kind } = request as Record<string, unknown>;
  if (typeof businessId !== "string" || businessId === "" || businessId.includes("\u0000")) {
    throw new TypeError(`${CALL}: businessId is a K-04 business id, a non-empty text`);
  }
  if (typeof kind !== "string" || !REVIEW_ITEM_KINDS.has(kind)) {
    throw new TypeError(`${CALL}: kind is one of K-37's review item kinds`);
  }
  return { businessId, kind: kind as ReviewItemKind };
}

/** The columns read: the item's plain columns alone. */
interface ItemRow {
  id: string;
  kind: ReviewItemKind;
  state: "open" | "waiting";
  version: number;
  raised_by_person_id: string | null;
}

/** The items inside the read's own transaction: one statement, naming the request's business. */
async function itemsIn(
  tx: Sql,
  businessId: string,
  kind: ReviewItemKind,
): Promise<OpenReviewItemsOfResponse> {
  const rows = await tx<ItemRow[]>`
    select id, kind, state, version, raised_by_person_id from review_items
    where business_id = ${businessId} and kind = ${kind} and state in ('open', 'waiting')
    order by id collate "C"
  `;
  return {
    result: "openReviewItems",
    businessId,
    kind,
    items: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      state: row.state,
      version: row.version,
      raisedByPersonId: row.raised_by_person_id,
    })),
  };
}

/**
 * A business's open review items of one kind (K-05 v1.24 item 88): every K-37 review_items row of the business and kind
 * whose state is open or waiting (never done), in id order, each as its id, kind, state, version and raised-by person;
 * none is an empty list. One statement naming the business, in one read-only transaction at repeatable read on the
 * primary, uncached, writing nothing. Pass the runtime side's client (rosie_job): the Tool API's role meets 42501.
 * transient on a serialization failure, a deadlock or a lost connection. Throws a TypeError for a request of the wrong
 * shape, and any other database error scrubbed (DataAccessDatabaseError). The summary is never read.
 */
export async function openReviewItemsOf(
  sql: Sql,
  request: OpenReviewItemsOfRequest,
): Promise<OpenReviewItemsOfOutcome> {
  const { businessId, kind } = requestOf(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, (tx) => itemsIn(tx, businessId, kind));
  } catch (error) {
    return transientOrScrubbed(CALL, error);
  }
}
