// What the paging and hand-offs service reads (T-319; C-104), each a port another task binds, so the service is tested
// with doubles and fails closed while one is not bound:
//
//   - PagingReader: K-36 v1's pages, recipients and hand-offs, K-37 v1's review items, the K-04 rows they lean on (a
//     clock row's state, a chat's state, the business's owner and zone) and the version of the row a review decision
//     writes back to. K-36 rule 2 and K-37 rule 2 keep team_pages, team_page_recipients and review_items from the Tool
//     API role (insert only on team_pages; no grant on the other two), so those reads are the runtime side's, which the
//     binding chooses: this service never opens a transaction. The default reader refuses every read (notBuilt);
//   - TestRoster: on staging, which handles are roster test phones (build prompt 9.4; QUESTIONS.md M3-M3b.5; the user's
//     rule, DL-839). The default knows none, so on staging every page and alert waits in the test console and no row is
//     written to anyone (recipients.ts).
//
// No port is called for anything but a read: a repeated turn runs a core action again before K-05 answers `repeated`,
// so nothing here may send, store or tell outside the one commit (../../commit/types.ts CommitPorts).

import { NotBuiltError, type CallName } from "../../tool-api";

/** K-36 v1 team_pages.reason. */
export type PageReason =
  | "hand_off"
  | "owner_cannot_act"
  | "harm_report"
  | "review_item"
  | "safety_timer_missed"
  | "passed_on"
  | "hard_invariant_breach";

/** K-36 v1 hand_offs.kind (arch 06 line 329's "Who is told"). */
export type HandOffKind = "crisis_words" | "emergency" | "threat" | "other";

/** K-37 v1 review_items.kind. */
export type ReviewKind =
  | "new_work"
  | "control"
  | "listing_match"
  | "owner_claim"
  | "booking_cap"
  | "harm_report"
  | "missed_deadline";

/** A K-36 v1 team_pages row as the service reads it. Times are UTC ending in Z. */
export interface StoredPage {
  readonly id: string;
  readonly reason: PageReason;
  readonly businessId: string | null;
  readonly handOffId: string | null;
  readonly harmReportId: string | null;
  readonly reviewItemId: string | null;
  readonly safetyTimerId: string | null;
  readonly turnId: string | null;
  readonly namedPersonId: string | null;
  /** What the team needs to know: ids and kinds, never a person's words (K-36 v1 team_pages.summary). */
  readonly summary: string;
  readonly openedAt: string;
  readonly lastPagedAt: string;
  readonly timesPaged: number;
  /** 5 for a page that repeats every 5 minutes until acknowledged; null for one paged once (K-36 v1). */
  readonly repeatMinutes: 5 | null;
  readonly nextPageClockRowId: string | null;
  readonly state: "open" | "acknowledged";
  readonly acknowledgedAt: string | null;
  readonly acknowledgedByPersonId: string | null;
  readonly acknowledgedVia: "reply" | "console_tap" | null;
  readonly version: number;
}

/** A K-36 v1 hand_offs row as the service reads it. Times are UTC ending in Z. */
export interface StoredHandOff {
  readonly id: string;
  readonly businessId: string;
  readonly kind: HandOffKind;
  readonly safetyOutcomeId: string | null;
  readonly turnId: string | null;
  readonly bookingId: string | null;
  readonly aboutPersonId: string | null;
  readonly toldPersonId: string;
  readonly toldAs: "owner" | "named";
  readonly alertOutboxRowId: string | null;
  readonly handedAt: string;
  readonly escalateAt: string;
  readonly escalationClockRowId: string | null;
  readonly answeredAt: string | null;
  readonly answeredVia: "reply" | "console_tap" | null;
  readonly answeredByPersonId: string | null;
  readonly escalatedAt: string | null;
  readonly version: number;
}

/** A K-37 v1 review_items row as the service reads it. Times are UTC ending in Z. */
export interface StoredReviewItem {
  readonly id: string;
  readonly kind: ReviewKind;
  readonly businessId: string | null;
  readonly subjectTable: string | null;
  readonly subjectRowId: string | null;
  readonly turnId: string | null;
  readonly raisedByPersonId: string | null;
  readonly openedAt: string;
  readonly dueAt: string;
  readonly state: "open" | "waiting" | "done";
  readonly waitUntil: string | null;
  readonly decidedAt: string | null;
  readonly decidedByPersonId: string | null;
  readonly outcome: string | null;
  readonly version: number;
}

/**
 * A row a review reads by its table and primary key: its version, and the business it belongs to (arch 10 line 546), read
 * together, so the business a decision checks is the one its compare-and-set on that version holds (K-04 v1 rule 2).
 */
export interface StoredRow {
  readonly version: number;
  /** Its business_id (a businesses row's own id), or null for a row of no business (a draft whose pick has none, K-24). */
  readonly businessId: string | null;
}

/** A K-04 v1 clock_rows row's state, as an answer or an acknowledgement cancels it. */
export interface StoredClock {
  readonly id: string;
  readonly state: "waiting" | "armed" | "fired" | "cancelled";
  readonly version: number;
}

/** One member of Rosie's team on K-36 v1 team_page_recipients, live while removedAt is null. Times are UTC ending in Z. */
export interface TeamMember {
  /** The recipient row's id. */
  readonly id: string;
  readonly personId: string;
  /** The member's mobile (handles.id), whose own chat with Rosie carries pages while it is open; null for none. */
  readonly chatHandleId: string | null;
  /** The member's email address (handles.id), used when there is no open chat; null for none. */
  readonly emailHandleId: string | null;
  readonly addedAt: string;
  readonly removedAt: string | null;
}

/** The service Linq reports for a chat (K-04 v1 phones; imessage, rcs or sms through Linq: DL-031). */
export type ChatWay = "imessage" | "rcs" | "sms";

/** A mobile's chat with Rosie's number (K-04 v1 phones by its handle id): never its number. */
export interface ChatState {
  readonly handleId: string;
  /** Set by the phone's first text to Rosie's number, cleared by STOP (RULES 4.1b; MC C9). */
  readonly open: boolean;
  /** The chat's service, or null before Linq reported one. */
  readonly way: ChatWay | null;
}

/** How one person is reached: their mobiles' chats and their email addresses, by handle id, in handle id order. */
export interface PersonReach {
  readonly personId: string;
  readonly chats: readonly ChatState[];
  /** Their email addresses' handle ids. */
  readonly emails: readonly string[];
}

/**
 * The reads the service makes. Each is one data-access call once K-05 and its binding have it, on the side the binding
 * picks (K-36 rule 2, K-37 rule 2: the runtime side for team_pages, team_page_recipients and review_items).
 */
export interface PagingReader {
  /** K-36 team_pages by id, or null. */
  page(pageId: string): Promise<StoredPage | null>;
  /** Every K-36 team_page_recipients row, live and removed (a member leaves by removed_at, never a delete). */
  members(): Promise<readonly TeamMember[]>;
  /** K-04 phones by handle id: whether its chat with Rosie is open, and its service; null for no phone. */
  chat(handleId: string): Promise<ChatState | null>;
  /** How a person (the owner, whoever the owner named) is reached, or null for no such person. */
  reachOf(personId: string): Promise<PersonReach | null>;
  /** K-36 hand_offs by id, under the business's scope, or null. */
  handOff(handOffId: string): Promise<StoredHandOff | null>;
  /** K-04 person_roles: the business's live owner, or null. */
  ownerOf(businessId: string): Promise<string | null>;
  /** K-04 businesses.time_zone: the IANA zone the business's days and clock rows are read in (CQ-05), or null. */
  businessZone(businessId: string): Promise<string | null>;
  /** K-04 clock_rows by id: its state and version, or null. */
  clock(clockRowId: string): Promise<StoredClock | null>;
  /** K-37 review_items by id, or null. */
  reviewItem(reviewItemId: string): Promise<StoredReviewItem | null>;
  /**
   * A row by its table and primary key, as its version and its business, or null when there is none: a review item's
   * subject (K-37 rule 5: "a review_items row's subject exists", kept by code) and the row a decision writes back to (K-23
   * business_setup by its business; K-24 new_work_drafts by id), whose business the decision checks before any write.
   */
  row(table: string, rowId: string): Promise<StoredRow | null>;
  /**
   * K-04 outbox_rows: whether a row with this id is written, never its words (K-05 v1.4 readOutboxRowWritten, under the
   * row's business: the page's and the alert's rows are written under the business they are about, K-05 open gap 78).
   * A repeat names only the rows the first call wrote.
   */
  outboxRowWritten(rowId: string): Promise<boolean>;
}

/** No reads bound yet: every read answers notBuilt, so the call fails closed. */
export function noPagingReads(call: CallName): PagingReader {
  const refuse = (): Promise<never> => Promise.reject(new NotBuiltError(call));
  return {
    page: refuse,
    members: refuse,
    chat: refuse,
    reachOf: refuse,
    handOff: refuse,
    ownerOf: refuse,
    businessZone: refuse,
    clock: refuse,
    reviewItem: refuse,
    row: refuse,
    outboxRowWritten: refuse,
  };
}

/**
 * Staging's roster test phones (build prompt 9.4: "On staging, the owner, any emergency contact and every alert to
 * Rosie's team go to test phones or the test console, so no real person is alerted"; the roster in
 * ops/plan/08-needs-from-jay.md; K-21 v1 "Staging only"), asked by handle id: never by a number.
 */
export interface TestRoster {
  /** Whether this handle is one of the roster's test phones. */
  isTestPhone(handleId: string): Promise<boolean>;
}

/** No roster bound: no handle is a test phone, so on staging every page and alert waits in the test console. */
export const NO_TEST_PHONES: TestRoster = {
  isTestPhone: () => Promise.resolve(false),
};

/** The one ENVIRONMENT whose pages and alerts reach real people (wrangler.jsonc's top level and env.production). */
export const PRODUCTION_ENVIRONMENT = "production";
