// The setup parts' fact homes (T-667; K-05 v1.2 item 26 and default 30; README "v1.2's consumers": "T-667 (the
// setup-part facts readTurnState reads, over K-22 to K-35, in M4)"; arch 02 line 117: each fact once, from its home,
// with its row and version).
//
// A fact names its home: a table, the row's name (K-05 rowId) and a column. K-04 core's homes are db/repo/turn-state.ts's
// FACT_HOMES; these are the eight setup parts' that journeys 1 and 2 write and the frontier reads: K-22 v1 to v1.3
// (people and access), K-23 v1 and v1.1 (business setup), K-24 v1 (kinds of work), K-25 v1 (services and prices),
// K-26 v1 (rules), K-27 v1 (availability), K-33 v1 (platform billing) and K-35 v1 (documents and licenses). Each is a versioned
// table of its part's frozen table list (contracts/db-schema/<part>/), so a fact is compared and set by its row's version
// (limit 4), with every column the list gives and its type as the list spells it, so no read is built from a request's
// words alone. The integration test holds this list to the frozen ones.
//
// What is never a fact here (defaults 1 to 4 of setup/turn-state.ts, for ops/QUESTIONS.md):
//   - a secret's hash: K-22 proof_codes.code_hash, sessions.token_sha256 and sessions.device_sha256 (K-05 v1.2
//     secretColumn), and page_links.code_sha256, a page link's code kept only as its hash (K-22 v1.1 rule 8: no Tool API
//     column grant reaches it), by the same rule;
//   - a sealed column (a list's sealedBy): K-22 emergency_contacts.name and mobile, K-27 calendar_links.tokens and K-35
//     documents.number, issuer and ends, which only the runtime side unseals under a person's key (rule 7);
//   - a map point (K-23 locations.map_point and travel_centre, geography): the travel check compares points in SQL
//     (ST_DWithin, Q-25), and a point has no text form a fact could carry as K-04's seeds write values;
//   - a table the Tool API never reads: K-22 v1.2 sign_in_attempts (reached only through its security-definer calls,
//     README rule 9) and v1.3 staging_testers (README rule 10);
//   - a table with no version (a registry, a link, a row written once: staff_skills, contact_changes, id_uploads,
//     item_services, trade_facts, plugin_switches, rule_kinds, document_files, document_texts, document_signers,
//     document_signatures), since a fact is compared by its row's version.
// A two-column key names its row by K-05 v1.18 item 77's name (row-names.ts): company_kinds, flow_defaults, kind_flows,
// picked_kind_texts and new_work_draft_blocks.
//
// A table scoped none is never read by its row's name alone under any business (T-667 round 2; DL-925 item 8, which
// withdraws run 2's default 8): each has its rule, UNSCOPED_ROWS, whose SQL rowBound (below) writes into the read. It is
// the one function every reader of a setup row by its name calls, with its own business and people (T-1436 round 2;
// DL-938, DL-941): setup/turn-state.ts's readTurnState, send-state.ts's sendState and, from T-1437, clocks.ts's fireClock.
import type postgres from "postgres";
import type { Sql, Tx } from "../scope";

type Db = Sql | Tx;

/** A column type a setup fact may hold, as the frozen table lists spell it. */
export type SetupColumnType =
  | "text"
  | "integer"
  | "smallint"
  | "bigint"
  | "boolean"
  | "timestamptz"
  | "time"
  | "date"
  | "interval"
  | "numeric"
  | "text[]"
  | "smallint[]"
  | "tstzrange"
  | "daterange";

/** The frozen table list a home comes from. */
export type SetupPart =
  | "people-access"
  | "business-setup"
  | "kinds-of-work"
  | "services-prices"
  | "rules"
  | "availability"
  | "platform-billing"
  | "documents-licenses";

export interface SetupFactHome {
  readonly part: SetupPart;
  /** The primary key's columns in key order: one, or two named by item 77 (row-names.ts TWO_COLUMN_KEYS). */
  readonly key: readonly string[];
  /**
   * The column row-level security scopes the table by (the list's rowLevelSecurity.column), or null for scope none, whose
   * rows answer by the table's rule in UNSCOPED_ROWS.
   */
  readonly scopedBy: string | null;
  /** Each column a fact may name, with its type. */
  readonly columns: Readonly<Record<string, SetupColumnType>>;
}

function home(
  part: SetupPart,
  key: readonly string[],
  scopedBy: string | null,
  columns: Record<string, SetupColumnType>,
): SetupFactHome {
  return Object.freeze({
    part,
    key: Object.freeze([...key]),
    scopedBy,
    columns: Object.freeze({ ...columns }),
  });
}

const PEOPLE = "people-access";
const SETUP = "business-setup";
const KINDS = "kinds-of-work";
const SERVICES = "services-prices";
const RULES = "rules";
const AVAILABILITY = "availability";
const BILLING = "platform-billing";
const DOCUMENTS = "documents-licenses";
const BY_BUSINESS = "business_id";

/** Every setup fact home, by table. */
export const SETUP_FACT_HOMES: Readonly<Record<string, SetupFactHome>> = Object.freeze({
  // ---- K-22 people and access (0020; v1.1's page_links) ----
  accounts: home(PEOPLE, ["person_id"], null, {
    person_id: "text",
    mobile: "text",
    mobile_proven_at: "timestamptz",
    email: "text",
    email_proven_at: "timestamptz",
    version: "integer",
  }),
  staff: home(PEOPLE, ["id"], BY_BUSINESS, {
    id: "text",
    business_id: "text",
    person_id: "text",
    mobile: "text",
    agreed_to_text_ticked_at: "timestamptz",
    agreed_ticked_by_person_id: "text",
    status: "text",
    added_at: "timestamptz",
    joined_at: "timestamptz",
    joined_from_number: "text",
    stopped_at: "timestamptz",
    wrong_number_at: "timestamptz",
    languages: "text[]",
    day_list_time: "time",
    video_link: "text",
    calls_customer_mobile: "boolean",
    supervisor_staff_id: "text",
    bookable_at: "timestamptz",
    bookable_by_person_id: "text",
    version: "integer",
  }),
  team_powers: home(PEOPLE, ["id"], BY_BUSINESS, {
    id: "text",
    staff_id: "text",
    business_id: "text",
    power: "text",
    over_cents: "integer",
    over_currency: "text",
    granted_at: "timestamptz",
    granted_by_person_id: "text",
    ended_at: "timestamptz",
    version: "integer",
  }),
  on_call: home(PEOPLE, ["id"], BY_BUSINESS, {
    id: "text",
    business_id: "text",
    kind_id: "text",
    staff_id: "text",
    hours: "text",
    days: "smallint[]",
    holidays: "boolean",
    from_time: "time",
    until_time: "time",
    version: "integer",
  }),
  emergency_contacts: home(PEOPLE, ["id"], BY_BUSINESS, {
    id: "text",
    business_id: "text",
    person_id: "text",
    agreed_ticked_at: "timestamptz",
    added_at: "timestamptz",
    contact_person_id: "text",
    contact_handle_id: "text",
    contact_yes_at: "timestamptz",
    contact_no_at: "timestamptz",
    ended_at: "timestamptz",
    ended_why: "text",
    version: "integer",
  }),
  proof_codes: home(PEOPLE, ["id"], null, {
    id: "text",
    purpose: "text",
    person_id: "text",
    business_id: "text",
    sent_to_handle_id: "text",
    channel: "text",
    hash_key_name: "text",
    sent_at: "timestamptz",
    expires_at: "timestamptz",
    wrong_tries: "integer",
    last_wrong_at: "timestamptz",
    paused_until: "timestamptz",
    used_at: "timestamptz",
    version: "integer",
  }),
  sessions: home(PEOPLE, ["id"], null, {
    id: "text",
    person_id: "text",
    proven_via: "text",
    proof_code_id: "text",
    started_at: "timestamptz",
    last_seen_at: "timestamptz",
    expires_at: "timestamptz",
    ended_at: "timestamptz",
    ended_why: "text",
    version: "integer",
  }),
  page_links: home(PEOPLE, ["id"], BY_BUSINESS, {
    id: "text",
    business_id: "text",
    person_id: "text",
    purpose: "text",
    step_id: "text",
    sent_to_handle_id: "text",
    issued_at: "timestamptz",
    expires_at: "timestamptz",
    ended_at: "timestamptz",
    ended_why: "text",
    ended_by_contact_change_id: "text",
    version: "integer",
  }),

  // ---- K-23 business setup (0019; v1.1's two claim columns, 0040) ----
  // signup_claim and claimed_by_person_id (K-23 v1.1, migration 0040; K-05 v1.24 item 87, T-1561): S1-09's claim, read
  // as facts by item 26 on the runtime side as pgListingK05Reads runs it (rosie_job), written once by a business_setup
  // StepRow through stateWrite (business_setup_claim_set_once refuses a second write, 23514). Audience never (K-23 v1.1
  // default 14): code's label for S1-75's control item, never in a text.
  business_setup: home(SETUP, ["business_id"], BY_BUSINESS, {
    business_id: "text",
    listing_phone: "text",
    listing_email: "text",
    website: "text",
    about: "text",
    profile_confirmed_at: "timestamptz",
    stripe_account_id: "text",
    no_money: "boolean",
    terms_accepted_at: "timestamptz",
    terms_accepted_by_person_id: "text",
    control_proven_at: "timestamptz",
    control_proven_via: "text",
    version: "integer",
    signup_claim: "text",
    claimed_by_person_id: "text",
  }),
  flow_defaults: home(SETUP, ["business_id", "flow"], BY_BUSINESS, {
    business_id: "text",
    flow: "text",
    cutoff_before: "interval",
    cutoff_day_before_at: "time",
    arrive: "text",
    version: "integer",
  }),
  companies: home(SETUP, ["id"], BY_BUSINESS, {
    id: "text",
    owner_person_id: "text",
    name: "text",
    business_id: "text",
    version: "integer",
  }),
  company_kinds: home(SETUP, ["company_id", "kind_id"], BY_BUSINESS, {
    company_id: "text",
    kind_id: "text",
    business_id: "text",
    trade_name: "text",
    pf_facts: "text[]",
    pf_switches_a: "text[]",
    pf_switches_b: "text[]",
    version: "integer",
  }),
  business_photos: home(SETUP, ["id"], BY_BUSINESS, {
    id: "text",
    business_id: "text",
    object_key: "text",
    label: "text",
    shows: "text",
    came_from: "text",
    position: "integer",
    shows_person_not_on_team: "boolean",
    written_yes_confirmed_at: "timestamptz",
    version: "integer",
  }),
  business_faqs: home(SETUP, ["id"], BY_BUSINESS, {
    id: "text",
    business_id: "text",
    question: "text",
    answer: "text",
    position: "integer",
    version: "integer",
  }),
  locations: home(SETUP, ["id"], BY_BUSINESS, {
    id: "text",
    business_id: "text",
    kind: "text",
    name: "text",
    address: "text",
    end_address: "text",
    travel_miles: "numeric",
    travel_centre_address: "text",
    travel_fee_cents: "integer",
    travel_fee_currency: "text",
    version: "integer",
  }),
  places_or_things: home(SETUP, ["id"], BY_BUSINESS, {
    id: "text",
    business_id: "text",
    name: "text",
    kind: "text",
    fits: "integer",
    bookable_count: "integer",
    bookable_per: "text",
    turnaround: "interval",
    version: "integer",
  }),
  new_booking_pauses: home(SETUP, ["id"], BY_BUSINESS, {
    id: "text",
    business_id: "text",
    paused_at: "timestamptz",
    paused_by_person_id: "text",
    reminded_at: "timestamptz",
    resumed_at: "timestamptz",
    resumed_by_person_id: "text",
    version: "integer",
  }),

  // ---- K-24 kinds of work (0021) ----
  kinds: home(KINDS, ["id"], null, {
    id: "text",
    name: "text",
    style: "text",
    pattern: "text",
    facts: "text[]",
    source: "text",
    version: "integer",
  }),
  kind_flows: home(KINDS, ["kind_id", "flow"], null, {
    kind_id: "text",
    flow: "text",
    main_combo: "text",
    combos: "text[]",
    switches_on: "text[]",
    arrive: "text",
    arrive_window_hours: "integer",
    cutoff: "text",
    version: "integer",
  }),
  picked_kinds: home(KINDS, ["id"], BY_BUSINESS, {
    id: "text",
    owner_person_id: "text",
    position: "integer",
    words: "text",
    outcome: "text",
    kind_id: "text",
    company_id: "text",
    business_id: "text",
    picked_at: "timestamptz",
    version: "integer",
  }),
  picked_kind_texts: home(KINDS, ["picked_kind_id", "pf_key"], BY_BUSINESS, {
    picked_kind_id: "text",
    pf_key: "text",
    business_id: "text",
    block: "text",
    version: "integer",
  }),
  new_work_drafts: home(KINDS, ["id"], BY_BUSINESS, {
    id: "text",
    picked_kind_id: "text",
    business_id: "text",
    state: "text",
    drafted_at: "timestamptz",
    version: "integer",
  }),
  new_work_draft_blocks: home(KINDS, ["draft_id", "block"], BY_BUSINESS, {
    draft_id: "text",
    block: "integer",
    business_id: "text",
    outcome: "text",
    answer: "text",
    facts_on: "text[]",
    switches_on: "text[]",
    answered_at: "timestamptz",
    version: "integer",
  }),

  // ---- K-25 services and prices (0022) ----
  services: home(SERVICES, ["id"], BY_BUSINESS, {
    id: "text",
    business_id: "text",
    kind_id: "text",
    name: "text",
    price_kind: "text",
    unit: "text",
    length: "interval",
    position: "integer",
    active: "boolean",
    extras: "text",
    version: "integer",
  }),
  service_money: home(SERVICES, ["id"], BY_BUSINESS, {
    id: "text",
    service_id: "text",
    business_id: "text",
    flow: "text",
    place: "text",
    location_id: "text",
    path: "text",
    deposit_cents: "bigint",
    deposit_percent: "integer",
    fee_cents: "bigint",
    currency: "text",
    cutoff_before: "interval",
    cutoff_day_before_at: "time",
    tip_line: "boolean",
    active: "boolean",
    version: "integer",
  }),
  price_rules: home(SERVICES, ["id"], BY_BUSINESS, {
    id: "text",
    business_id: "text",
    service_id: "text",
    service_money_id: "text",
    worker_resource_id: "text",
    worker_resource_kind: "text",
    weekdays: "text",
    from_time: "time",
    until_time: "time",
    price_cents: "bigint",
    from_cents: "bigint",
    currency: "text",
    set_by_person_id: "text",
    effective_from: "timestamptz",
    effective_to: "timestamptz",
    version: "integer",
  }),
  price_rule_ties: home(SERVICES, ["id"], BY_BUSINESS, {
    id: "text",
    business_id: "text",
    service_id: "text",
    first_rule_id: "text",
    second_rule_id: "text",
    asked_at: "timestamptz",
    winner_rule_id: "text",
    answered_at: "timestamptz",
    answered_by_person_id: "text",
    version: "integer",
  }),

  // ---- K-26 rules (0023) ----
  rules: home(RULES, ["id"], BY_BUSINESS, {
    id: "text",
    business_id: "text",
    rule_kind: "text",
    value_type: "text",
    flow: "text",
    kind_id: "text",
    value_on: "boolean",
    value_cents: "integer",
    value_currency: "text",
    value_span: "interval",
    value_count: "integer",
    value_dates: "daterange",
    words: "text",
    set_by_person_id: "text",
    effective_from: "timestamptz",
    effective_to: "timestamptz",
    version: "integer",
  }),
  price_ok_limits: home(RULES, ["id"], BY_BUSINESS, {
    id: "text",
    business_id: "text",
    flow: "text",
    kind_id: "text",
    quotes: "boolean",
    bills: "boolean",
    over_cents: "integer",
    currency: "text",
    set_by_person_id: "text",
    effective_from: "timestamptz",
    effective_to: "timestamptz",
    version: "integer",
  }),

  // ---- K-27 availability (0024) ----
  weekly_hours: home(AVAILABILITY, ["id"], BY_BUSINESS, {
    id: "text",
    business_id: "text",
    owner_kind: "text",
    location_id: "text",
    resource_id: "text",
    resource_kind: "text",
    place_or_thing_id: "text",
    weekday: "smallint",
    opens_at: "time",
    closes_at: "time",
    time_zone: "text",
    version: "integer",
  }),
  time_off: home(AVAILABILITY, ["id"], BY_BUSINESS, {
    id: "text",
    business_id: "text",
    owner_kind: "text",
    location_id: "text",
    resource_id: "text",
    resource_kind: "text",
    place_or_thing_id: "text",
    kind: "text",
    during: "tstzrange",
    time_zone: "text",
    status: "text",
    asked_by_person_id: "text",
    asked_at: "timestamptz",
    status_at: "timestamptz",
    status_by_person_id: "text",
    version: "integer",
  }),
  classes: home(AVAILABILITY, ["id"], BY_BUSINESS, {
    id: "text",
    business_id: "text",
    service_id: "text",
    weekday: "smallint",
    starts_at: "time",
    ends_at: "time",
    time_zone: "text",
    teacher_resource_id: "text",
    teacher_kind: "text",
    room_resource_id: "text",
    room_kind: "text",
    location_id: "text",
    seats: "integer",
    minimum: "integer",
    active: "boolean",
    version: "integer",
  }),
  class_sessions: home(AVAILABILITY, ["resource_id"], BY_BUSINESS, {
    resource_id: "text",
    resource_kind: "text",
    business_id: "text",
    class_id: "text",
    service_id: "text",
    during: "tstzrange",
    time_zone: "text",
    teacher_resource_id: "text",
    teacher_kind: "text",
    room_resource_id: "text",
    room_kind: "text",
    location_id: "text",
    minimum: "integer",
    status: "text",
    counted_at: "timestamptz",
    too_few: "boolean",
    cancelled_at: "timestamptz",
    cancelled_by_person_id: "text",
    version: "integer",
  }),
  calendar_links: home(AVAILABILITY, ["id"], null, {
    id: "text",
    person_id: "text",
    provider: "text",
    state: "text",
    linked_at: "timestamptz",
    sync_cursor: "text",
    synced_at: "timestamptz",
    subscription_id: "text",
    subscription_resource_id: "text",
    subscribed_at: "timestamptz",
    subscription_expires_at: "timestamptz",
    dropped_at: "timestamptz",
    dropped_why: "text",
    drop_reminded_at: "timestamptz",
    unlinked_at: "timestamptz",
    version: "integer",
  }),
  calendar_link_shares: home(AVAILABILITY, ["id"], BY_BUSINESS, {
    id: "text",
    calendar_link_id: "text",
    person_id: "text",
    business_id: "text",
    shared_at: "timestamptz",
    ended_at: "timestamptz",
    version: "integer",
  }),
  busy_blocks: home(AVAILABILITY, ["id"], null, {
    id: "text",
    business_id: "text",
    person_id: "text",
    source: "text",
    calendar_link_id: "text",
    provider_event_ref: "text",
    during: "tstzrange",
    time_zone: "text",
    confirmed_at: "timestamptz",
    confirmed_by_person_id: "text",
    version: "integer",
  }),

  // ---- K-33 platform billing (0025) ----
  bill_cards: home(BILLING, ["id"], BY_BUSINESS, {
    id: "text",
    business_id: "text",
    saved_by_person_id: "text",
    stripe_customer_id: "text",
    stripe_payment_method_id: "text",
    saved_at: "timestamptz",
    removed_at: "timestamptz",
    version: "integer",
  }),
  monthly_bills: home(BILLING, ["id"], BY_BUSINESS, {
    id: "text",
    business_id: "text",
    month: "date",
    bill_date: "date",
    charge_on: "date",
    sent_at: "timestamptz",
    total_cents: "bigint",
    currency: "text",
    bill_card_id: "text",
    state: "text",
    charge_effect_id: "text",
    charged_at: "timestamptz",
    declined_at: "timestamptz",
    pay_link_effect_id: "text",
    pay_link_sent_at: "timestamptz",
    pay_by: "date",
    paid_at: "timestamptz",
    paused_at: "timestamptz",
    version: "integer",
  }),
  monthly_bill_lines: home(BILLING, ["id"], BY_BUSINESS, {
    id: "text",
    bill_id: "text",
    business_id: "text",
    kind: "text",
    fee_id: "text",
    booking_id: "text",
    counts_for_person_id: "text",
    plan_charge_cents: "bigint",
    amount_cents: "bigint",
    currency: "text",
    questioned_at: "timestamptz",
    questioned_by_person_id: "text",
    question: "text",
    answered_at: "timestamptz",
    answered_by_person_id: "text",
    outcome: "text",
    version: "integer",
  }),

  // ---- K-35 documents and licenses (0026) ----
  documents: home(DOCUMENTS, ["id"], BY_BUSINESS, {
    id: "text",
    business_id: "text",
    owner_kind: "text",
    staff_person_id: "text",
    place_or_thing_id: "text",
    booking_id: "text",
    customer_person_id: "text",
    person_id: "text",
    kind: "text",
    kind_id: "text",
    title: "text",
    shown_on_listing: "boolean",
    origin: "text",
    given_by_person_id: "text",
    given_via: "text",
    added_at: "timestamptz",
    signed_by_all_at: "timestamptz",
    withdrawn_at: "timestamptz",
    withdrawn_why: "text",
    withdrawn_by_person_id: "text",
    version: "integer",
    service_id: "text",
  }),
});

/**
 * Which rows of a table scoped none answer a setup fact (T-667 round 2; DL-925 item 8). The read runs on the job handle
 * (rosie_job), whose policies on K-22's codes and sessions and K-27's links and busy blocks are `using (true)`, and K-22's
 * accounts have no row-level security (0020, 0024; DL-247's note for this card), so the read's own SQL holds each rule:
 *   - catalog (K-24 kinds, kind_flows): the shared catalog, the same rows under any business and under none;
 *   - person (K-22 accounts, sessions): a row whose person is one of the request handle's people (person_handles, as
 *     K-05 item 26 reads them), K-22 rule 5's binding to the call's person and its accounts note ("a row predicate on
 *     the call's person first": contracts/db-schema/people-access/README.md lines 97 and 329; K-05 default 25);
 *   - personCode (K-22 proof_codes): the same, and only a code whose business is none or the request's; a code with no
 *     person (a listing's control code) never answers;
 *   - calendarLink (K-27 calendar_links): the Tool API's select policy (contracts/db-schema/availability/README.md line
 *     108): a link with a live share (calendar_link_shares, ended_at null) to the request's business, or a link whose
 *     person is one of the handle's people;
 *   - busyBlock (K-27 busy_blocks): the Tool API's select policy (the same README, line 110): a photo block of the
 *     request's business, or a calendar block whose link has a live share to the request's business.
 * With businessId null (a sign-up) no business or share stands: a person's own rows only, so no busy block answers. Any
 * other row answers notFound, as K-05 item 26 answers a row the scope hides. A table scoped none with no rule here throws
 * before it is read.
 */
export type UnscopedRows = "catalog" | "person" | "personCode" | "calendarLink" | "busyBlock";

/** The rule of each table scoped none that SETUP_FACT_HOMES lists (the integration test holds the two lists together). */
export const UNSCOPED_ROWS: Readonly<Record<string, UnscopedRows>> = Object.freeze({
  accounts: "person",
  proof_codes: "personCode",
  sessions: "person",
  kinds: "catalog",
  kind_flows: "catalog",
  calendar_links: "calendarLink",
  busy_blocks: "busyBlock",
});

/** The rule a fact of `table`, a table scoped none, is read by; a throw when it has none (never read by name alone). */
export function unscopedRowsOf(table: string): UnscopedRows {
  const rule = Object.hasOwn(UNSCOPED_ROWS, table) ? UNSCOPED_ROWS[table] : undefined;
  if (rule === undefined) {
    throw new Error(`readTurnState: ${table} is scoped none and has no rule for which of its rows answer`);
  }
  return rule;
}

/**
 * What a row of the setup home `table` must meet beside its name, as SQL that follows the name's compare in a read from
 * `table` (K-05 v1.2 item 26; T-667 round 2's items 8a and 8b). It is the one function every reader of a setup row by
 * its name calls, so no reader holds a second copy that could drift (T-1436 round 2; DL-938, DL-941):
 *   - a business-scoped table's row (its scopedBy column) must be of `businessId`, or have no business when it is null;
 *   - a row of a table scoped none must meet its table's rule (UNSCOPED_ROWS, through unscopedRowsOf), with `businessId`
 *     for rosie.business_id and `people` for rosie.person_id. The K-27 rules are the Tool API's select policies (0024
 *     calendar_links_tool_api_select, busy_blocks_tool_api_select), each on its own table only. With businessId null no
 *     business or share stands: a person's own rows only, and no busy block.
 * Each caller passes its own business and people, from its checked request or its own stored row, never from a row's
 * name: readTurnState the request's business and the request handle's people; sendState the outbox row's business and
 * the people of its turn's handle (send-state.ts default 1); fireClock (T-1437) the clock row's business and the people
 * of its handle. `people` is a subquery in parentheses that selects person ids, built by the caller's own tagged
 * template; one that finds no one finds no row of a person's. The SQL starts with "and" (the catalog's is empty), names
 * `table`'s own columns, and names calendar_links.id and busy_blocks.calendar_link_id by their table's name. A table
 * that is no setup home throws, as does a table scoped none with no rule; a rule with no SQL here is a type error, never
 * a row read unbound.
 */
export function rowBound(
  db: Db,
  table: string,
  businessId: string | null,
  people: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
  const home = Object.hasOwn(SETUP_FACT_HOMES, table) ? SETUP_FACT_HOMES[table] : undefined;
  if (home === undefined) {
    throw new Error(`rowBound: ${table} is not a setup home`);
  }
  if (home.scopedBy !== null) {
    return businessId === null
      ? db`and ${db(home.scopedBy)} is null`
      : db`and ${db(home.scopedBy)} = ${businessId}`;
  }
  const rule = unscopedRowsOf(table);
  switch (rule) {
    case "catalog":
      return db``;
    case "person":
      return db`and person_id in ${people}`;
    case "personCode":
      return businessId === null
        ? db`and person_id in ${people} and business_id is null`
        : db`and person_id in ${people} and (business_id is null or business_id = ${businessId})`;
    case "calendarLink":
      if (table !== "calendar_links") {
        throw new Error("rowBound: a link's rule reads calendar_links alone");
      }
      return businessId === null
        ? db`and person_id in ${people}`
        : db`and (
            exists (
              select 1 from calendar_link_shares s
              where s.calendar_link_id = calendar_links.id and s.business_id = ${businessId} and s.ended_at is null
            )
            or person_id in ${people}
          )`;
    case "busyBlock":
      if (table !== "busy_blocks") {
        throw new Error("rowBound: a busy block's rule reads busy_blocks alone");
      }
      return businessId === null
        ? db`and false`
        : db`and (
            (source = 'photo' and business_id = ${businessId})
            or (
              source = 'calendar'
              and exists (
                select 1 from calendar_link_shares s
                where s.calendar_link_id = busy_blocks.calendar_link_id and s.business_id = ${businessId}
                  and s.ended_at is null
              )
            )
          )`;
  }
}

/**
 * Never a setup fact, whatever SETUP_FACT_HOMES may come to list: a secret's hash (K-05 v1.2 secretColumn, and K-22
 * v1.1's page link code by the same rule) and a sealed column.
 */
export const NEVER_SETUP_COLUMNS: ReadonlySet<string> = new Set([
  "proof_codes.code_hash",
  "sessions.token_sha256",
  "sessions.device_sha256",
  "page_links.code_sha256",
  "emergency_contacts.name",
  "emergency_contacts.mobile",
  "calendar_links.tokens",
  "documents.number",
  "documents.issuer",
  "documents.ends",
]);

/** Never a setup fact: the tables the Tool API never reads (K-22 v1.2 and v1.3), and every table K-05's factTable bars. */
export const NEVER_SETUP_TABLES: ReadonlySet<string> = new Set([
  "sign_in_attempts",
  "staging_testers",
  "sealing_keys",
  "harm_reports",
  "team_pages",
  "team_page_recipients",
  "parked_turns",
  "dead_letters",
  "gap_cases",
  "review_items",
  "live_turn_labels",
]);

/** The setup home of `table`'s `column`, or null when it is none (unknownFact). */
export function setupHomeOf(table: string, column: string): SetupFactHome | null {
  if (!Object.hasOwn(SETUP_FACT_HOMES, table) || NEVER_SETUP_TABLES.has(table)) {
    return null;
  }
  const found = SETUP_FACT_HOMES[table];
  if (
    found === undefined ||
    !Object.hasOwn(found.columns, column) ||
    NEVER_SETUP_COLUMNS.has(`${table}.${column}`)
  ) {
    return null;
  }
  return found;
}
