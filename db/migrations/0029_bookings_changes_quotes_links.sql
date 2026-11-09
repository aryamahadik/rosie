-- T-721: the bookings and changes part (K-30 v1, frozen: contracts/db-schema/bookings-changes, its table list and its
-- README's rules 1 to 10), part 2 of 2: each change after booking, appended and never edited (booking_changes), a
-- price made for one customer and its prices (quotes, quote_options), each ask to the owner with the answer in K-08's
-- ownerYes shape (owner_oks), flow B's town and sealed street address with its zone and state (booking_addresses),
-- each secure link issued with the contact it went to and only its code's hash (secure_links), what a person typed on
-- the secure page, sealed (page_answers), and the waitlist with each customer's own yes (waitlist_entries) (arch 09
-- lines 467, 484 and 490; arch 02's "Bookings & quotes"; 02-contracts section 8's keys quote, choice, contact, link,
-- address, access, answers and staff_told; C-166). The upset count (booking_details.upset_count) and staff_told as a
-- delivered time (booking_details.staff_told_at, Q-33) are booking_details columns, where K-30 puts them: 0028 made
-- them, and this part adds none.
-- Expand only: eight new tables with their indexes; booking_lines' two foreign keys to two of them, added once they
-- exist (rule 1), with ALTER TABLE ... ADD CONSTRAINT and checked against every row (no NOT VALID; 0028's header and
-- DL-278; booking_lines has no row that names either column, since no code writes a line yet); the version trigger
-- (enforce_version_raise() from 0002, T-181) on the six versioned tables; grants to the two roles 0012 made (never
-- created or altered here); row-level security switched on for all eight, with rule 5's policies. Nothing is dropped,
-- renamed or retyped, no row is written or removed, no function is made, and no other part's table is altered but
-- booking_lines, part 1's, by those two keys.
--
-- Not here: the bookings service that writes these rows (C-099), the page server that finds a link by its code's hash
-- and the page calls that save answers (K-21; C-199), the K-05 calls that read and write them, sealing and unsealing
-- (T-182's db/repo/sealing.ts), the rules README rule 10 leaves to code (a sent quote's options never change, an
-- owner's answer comes from someone allowed, a change's booking_version_before is the version it read, private fields
-- stay out of a change's old and new values), and the migration-side contract test (QA's tests/contract/db-schema
-- .bookings-changes.v1.test.ts, T-107). Visit rows (K-31) are journey 7 and 8's (M6).
--
-- The eight live beside K-04's tables and the other parts' (rule 1), and their foreign keys name them by key with no
-- schema prefix (bookings.id, businesses.id, persons.id, booking_visits (id, booking_id), turns.id, services (id,
-- business_id), price_ok_limits.id, quotes (id, business_id), open_questions.id, locations.id, person_handles
-- (person_id, handle_id), resources.id, consents.id), all on delete restrict. A change names a visit of its own booking
-- (booking_visits_id_booking_key, 0028), a removed line a change of its own booking (booking_changes_id_booking_key), an
-- option, an owner's ask about a quote and a line its quote or option of the same business (quotes_id_business_key,
-- quote_options_id_business_key), a quote and a waitlist entry a service of their business (K-25's
-- services_id_business_key), and a link a handle of its own person (K-04's person_handles key). K-04's head has no key
-- on (id, business_id), so a row's business is held to its booking's by rule 5's policies below, not by a key. MATCH
-- SIMPLE: a row with no visit, person, turn, limit, quote, option, question, handle, change or resource leaves that key
-- unchecked. Ids are text, opaque strings code makes and never parses (rule 3; CQ-09). No extension beyond K-04's
-- (rule 2): tstzrange is built in, and no PostGIS type is used.
--
-- Times and money (rule 9): every instant is timestamptz and the times a customer waits for a bounded tstzrange, in
-- UTC, shown in the visit's zone (an address's own zone, booking_addresses.zone, for a visit at the customer's place);
-- a quote stays good 168 hours after it is sent (7 days, never read in a session's zone). Every amount is integer minor
-- units in bigint, in its quote's three-letter currency.
--
-- Versions (rule 4): quotes, quote_options, owner_oks, booking_addresses, secure_links and waitlist_entries carry a
-- version that every update raises by exactly one (K-04 rule 2; the trigger refuses any other update, 23514), compared
-- and set by a commit, with a one-column key a commit can name in versions_read. booking_changes and page_answers are
-- only inserted and carry none: a change names the head's version before and after instead, so a repeat from an old
-- read fails, and a newer answer is a new row.
--
-- Partial unique rules (the table list's unique rules with a where), as unique indexes: one waiting ask to the owner
-- per booking and kind of ask, and one per quote (owner_oks_one_waiting, owner_oks_one_waiting_per_quote), and one open
-- waitlist entry per person and service at a business (waitlist_entries_one_open), so a repeated ask or join writes no
-- second row (23505). A waitlist entry has no position of its own: its place on the list is its joined_at, then its id,
-- and neither ever changes (no update grant reaches them; rule 6).
--
-- What may be written (rule 6), by privilege, the same for both application roles: no DELETE on any of the eight
-- (42501; rule 8 keeps a booking and its records 7 years). booking_changes and page_answers take no UPDATE (42501:
-- refuse-change-row-update; an answer is never edited). secure_links takes UPDATE of ended_at, ended_why and version
-- only (a link ends; its code's hash, its person and where it went never change), and waitlist_entries the same (an
-- entry ends; who waits, for what and since when never change). quotes, quote_options, owner_oks and booking_addresses
-- take updates as table grants (a quote priced, OK'd and sent; an option changed by the owner's read-back before it is
-- sent; an ask reminded and answered; an address typed and checked). secure_links.code_sha256 is outside the Tool API's
-- SELECT: rosie_app holds SELECT of every other column of secure_links (a whole-row read is refused,
-- refuse-link-code-read, 42501), and only the runtime side reads the hash, to find a link by its code (rule 5; the page
-- server, through secure_links_code_key).
--
-- Sealed fields (rule 7; T-182's sealing, migration 0003 and db/repo/sealing.ts): booking_addresses.address and
-- page_answers.answer are bytea holding only the sealed form, under the key of the row's sealed_for_person_id and
-- person_id in core's sealing_keys, never a plain copy, so deleting that person's key erases them (rule 8); the
-- secure page and the job page open them, and no plain column holds a word a person typed (a page question's words
-- are the plug-in's). Only the sha256 of a link's code is kept (BP rule 7), never the code.
--
-- Row-level security (arch 10 line 546; K-04 v1 rule 4; README rule 5): all eight are scoped by business, on
-- business_id (never null here). Each has 0012's <table>_runtime for rosie_job: every row with no scope (the runtime
-- side reads unscoped only to find a link by its code's hash, for the dispatcher reading a booking for a message, clock
-- firings and the 45-day erasure, and holds a row's booking to its business by code), else only its scope's. On the
-- seven with booking_id the Tool API (rosie_app) has one policy per command its grants allow: <table>_tool_api_select
-- reads only rows whose business_id equals its scope (the setting rosie.business_id), and none with no scope;
-- <table>_tool_api_insert, and <table>_tool_api_update where an update is granted, also require, on the new row,
-- exists (select 1 from bookings b where b.id = <table>.booking_id and b.business_id = <table>.business_id), which
-- K-04's own row-level security on bookings limits to the call's scope, so a call can never attach a row to another
-- business's booking (42501), though the key to bookings alone would let it through. quote_options has no booking_id:
-- it keeps T-191's pattern, quote_options_tool_api for every command on its scope, and its quote_options_quote_fk holds
-- it to its quote's business. No policy is for delete alone; quote_options_tool_api and each <table>_runtime are for
-- every command, but no grant allows a delete, so either role's delete is refused by privilege (42501). None is
-- forced: the tables' owner (the migrations' role) is not bound. A foreign-key check runs as the owner, so a row's
-- booking, visit, service, quote, question, location, handle, resource and consent are checked without row-level
-- security.
--
-- Grants (DL-149: each to a named reader; README rule 6, the same for both application roles but the code's hash),
-- table grants but for the named column grants. No DELETE, TRUNCATE, REFERENCES or TRIGGER, and nothing to PUBLIC.
-- Neither role owns a table.
--   rosie_app, the Tool API, under one business's scope, behind the policies above:
--     booking_changes: SELECT and INSERT. Bookings and quotes (C-099; K-09 v1.1 to v1.5) write a row in the commit of
--       each change (A7-03, A7-05, A7-06, A7-31, S13-56, S11-62); the owner console's Bookings page (C-192) and the
--       booking screens (C-198) read them through K-21, and the fee door (C-106) a late cancel.
--     quotes and quote_options: SELECT, INSERT and UPDATE. C-099 writes a quote when the photos are asked (A4-07,
--       B4-08), prices it with its options (A4-08, B4-09), sends it once the owner OKs it (A4-12, B4-13), and changes an
--       option only on the owner's read-back before sending (A4-10, B4-11); the pro's pricing page and the customer's
--       quote page (C-199) read them through K-21, and the booking line's copy reads the option picked.
--     owner_oks: SELECT, INSERT and UPDATE. C-099 asks the owner (A6-02, B6-04, A4-09, B4-10, A5-08, A7-03) and the
--       owner's answer turn records the answer in K-08's ownerYes shape; Needs you (C-192, FS 6.2) and the customer's
--       wait notice (A6-02, A4-11) read them through K-21.
--     booking_addresses: SELECT, INSERT and UPDATE. C-099 writes the town at the travel check (B4-77) and the sealed
--       street address, zone and state when the secure page saves and checks it (B4-30); the job page (C-195, B6-14)
--       opens it, and the travel check reads the town.
--     secure_links: INSERT, SELECT of every column but code_sha256, and UPDATE of ended_at, ended_why and version.
--       C-099 issues a link when it sends one (A4-07, A4-12, A4-42, B4-29), and identity and access (C-094) ends a
--       person's open links at a contact switch (D75; S13-19); the console and the booking screens read which links
--       went where, never the hash.
--     page_answers: SELECT and INSERT. The secure page's calls (C-199, K-21; with no turn: CQ-44) save each answer
--       sealed as it is typed (A4-65, B4-34); the job page for the person on the job (C-195; B6-14, A6-15) reads them.
--     waitlist_entries: SELECT, INSERT, and UPDATE of ended_at, ended_why and version. C-099 writes the entry at A4-60
--       (B4-64) with the customer's own yes, and ends it when they leave, the time passes or they book; the booking
--       screens (C-198) read it through K-21.
--   rosie_job, the runtime side, behind 0012's policies, the same grants, with SELECT of every column of secure_links:
--     K-05 commitTurn per write (item 1), whose state writes admit every domain table, writes what a turn decides on
--     these eight as the Tool API does above, and compares rows FOR SHARE or FOR UPDATE (which take UPDATE of a column
--     as well as SELECT); readTurnState (item 26) reads them; the page server finds a link by its code's hash, before any
--     business is known (README rule 5); clock firings (C-054) answer an owner's ask no_answer at its deadline, send its
--     one reminder, and mark a quote not_priced or a waitlist entry time_passed; the outbox dispatcher (C-124) reads a
--     booking for a message, and the spot-opened notice (A4-60) the open entries of a service; the 45-day copy or
--     delete reads a person's rows unscoped (C-156).

-- Each change to a booking after it was written (FS line 756; S13-56): who asked and the yes behind it, when, by which
-- turn or job, late or not, the plain fields before and after, and the versions before and after of the head and of
-- every other row it wrote. Appended and never edited. Rule 1 makes it before booking_lines' key to it.
create table booking_changes (
  id text primary key,
  booking_id text not null,
  business_id text not null,
  visit_id text,
  kind text not null,
  asked_by text not null,
  asked_by_person_id text,
  approved_by jsonb,
  turn_id text,
  job_id text,
  at timestamptz not null default now(),
  after_free_cancel boolean not null,
  old_values jsonb not null,
  new_values jsonb not null,
  booking_version_before integer not null,
  booking_version_after integer not null,
  rows_changed jsonb not null,
  constraint booking_changes_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint booking_changes_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint booking_changes_visit_fk foreign key (visit_id, booking_id) references booking_visits (id, booking_id)
    on delete restrict,
  constraint booking_changes_asked_by_fk foreign key (asked_by_person_id) references persons (id) on delete restrict,
  constraint booking_changes_turn_fk foreign key (turn_id) references turns (id) on delete restrict,
  constraint booking_changes_id_booking_key unique (id, booking_id),
  constraint booking_changes_kind_known check (kind in ('moved', 'cancelled', 'stand_in', 'what_changed')),
  constraint booking_changes_asked_by_known check (
    asked_by in ('customer', 'owner', 'staff', 'team', 'rosie')
      and (asked_by not in ('customer', 'owner', 'staff') or asked_by_person_id is not null)
      and (asked_by <> 'rosie' or asked_by_person_id is null)
  ),
  constraint booking_changes_turn_or_job check (turn_id is not null or job_id is not null),
  constraint booking_changes_versions check (
    booking_version_before >= 1 and booking_version_after > booking_version_before
  ),
  constraint booking_changes_json_shapes check (
    jsonb_typeof(old_values) = 'object'
      and jsonb_typeof(new_values) = 'object'
      and jsonb_typeof(rows_changed) = 'array'
      and (approved_by is null or jsonb_typeof(approved_by) = 'object')
  )
);

-- A booking's changes in order: the owner's Bookings page, the record (S13-57) and the late-cancel count.
create index booking_changes_booking_at_idx on booking_changes (booking_id, at);

-- A price made for one customer before any time is saved (A4-07 to A4-12, B4-08 to B4-13): the service, from photos or
-- answers, who priced it and when, the owner's price OK limit that asked for an OK (the OK is an owner_oks row), its
-- state, when it was sent and how long it stays good. Its prices are quote_options.
create table quotes (
  id text primary key,
  booking_id text not null,
  business_id text not null,
  service_id text not null,
  basis text not null,
  priced_by_person_id text,
  priced_at timestamptz,
  price_ok_limit_id text,
  state text not null default 'pricing',
  sent_at timestamptz,
  good_until timestamptz,
  currency text not null,
  version integer not null default 1,
  constraint quotes_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint quotes_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint quotes_service_fk foreign key (service_id, business_id) references services (id, business_id)
    on delete restrict,
  constraint quotes_priced_by_fk foreign key (priced_by_person_id) references persons (id) on delete restrict,
  constraint quotes_price_ok_limit_fk foreign key (price_ok_limit_id) references price_ok_limits (id)
    on delete restrict,
  constraint quotes_id_business_key unique (id, business_id),
  constraint quotes_basis_known check (basis in ('photos', 'answers')),
  constraint quotes_state_known check (
    state in ('pricing', 'with_owner', 'sent', 'see_first', 'declined', 'not_priced')
  ),
  constraint quotes_priced_pair check (
    (priced_by_person_id is null) = (priced_at is null)
      and (state in ('pricing', 'not_priced') or priced_at is not null)
  ),
  constraint quotes_sent_good_7_days check (
    (state = 'sent') = (sent_at is not null)
      and (sent_at is null) = (good_until is null)
      and (good_until is null or good_until = sent_at + interval '168 hours')
  ),
  constraint quotes_currency_form check (currency ~ '^[A-Z]{3}$')
);

-- A booking request's quotes, for the times card and the booking line's copy.
create index quotes_booking_idx on quotes (booking_id);

create trigger quotes_version_raised
  before update on quotes
  for each row execute function enforce_version_raise();

-- A quote's prices: one, or options the customer picks one of before any yes, each a set price or a range set at the
-- visit inside it, in integer minor units in the quote's currency. Rule 1 makes it before booking_lines' key to it.
create table quote_options (
  id text primary key,
  quote_id text not null,
  business_id text not null,
  position integer not null,
  label text,
  price_cents bigint not null,
  up_to_cents bigint,
  version integer not null default 1,
  constraint quote_options_quote_fk foreign key (quote_id, business_id) references quotes (id, business_id)
    on delete restrict,
  constraint quote_options_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint quote_options_position_key unique (quote_id, position),
  constraint quote_options_id_business_key unique (id, business_id),
  constraint quote_options_position_from_one check (position >= 1),
  constraint quote_options_money check (
    price_cents >= 0
      and (up_to_cents is null or up_to_cents > price_cents)
      and (label is null or length(btrim(label)) > 0)
  )
);

create trigger quote_options_version_raised
  before update on quote_options
  for each row execute function enforce_version_raise();

-- booking_lines' two keys to the tables just made (0028's header; rule 1; DL-278): a photos line names the option it
-- copies, of its own business, and a removed line the change that removed it, of its own booking. Both are checked
-- against every row, on delete restrict.
alter table booking_lines
  add constraint booking_lines_quote_option_fk foreign key (quote_option_id, business_id)
    references quote_options (id, business_id) on delete restrict;
alter table booking_lines
  add constraint booking_lines_removed_by_fk foreign key (removed_by_change_id, booking_id)
    references booking_changes (id, booking_id) on delete restrict;

-- Each ask to the owner, or an admin the owner lets answer, about one booking (A6-02, B6-04, A4-09, B4-10, A5-08,
-- A7-03): when asked, the deadline and the one reminder, and the answer with who gave it in K-08's ownerYes shape, or
-- no answer by the deadline. The first answer from someone allowed counts; silence never says yes.
create table owner_oks (
  id text primary key,
  booking_id text not null,
  business_id text not null,
  about text not null,
  quote_id text,
  asked_at timestamptz not null,
  answer_by timestamptz not null,
  reminded_at timestamptz,
  answer text,
  answered_at timestamptz,
  answered_by_person_id text,
  answered_by_role text,
  open_question_id text,
  option_id text,
  event_id text,
  version integer not null default 1,
  constraint owner_oks_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint owner_oks_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint owner_oks_quote_fk foreign key (quote_id, business_id) references quotes (id, business_id)
    on delete restrict,
  constraint owner_oks_answered_by_fk foreign key (answered_by_person_id) references persons (id) on delete restrict,
  constraint owner_oks_question_fk foreign key (open_question_id) references open_questions (id) on delete restrict,
  constraint owner_oks_about_known check (
    about in ('request', 'quote', 'nothing_taken', 'late_move') and (about = 'quote') = (quote_id is not null)
  ),
  constraint owner_oks_answer_fits check (
    answer is null
      or answer = 'no_answer'
      or (about in ('request', 'late_move') and answer in ('accept', 'another_time', 'decline'))
      or (about = 'quote' and answer in ('send', 'change', 'see_first', 'decline'))
      or (about = 'nothing_taken' and answer in ('book', 'let_go'))
  ),
  constraint owner_oks_answered_by check (
    (answer is null) = (answered_at is null)
      and (answer is null or answer = 'no_answer') = (answered_by_person_id is null)
      and (answered_by_person_id is null) = (answered_by_role is null)
      and (answered_by_person_id is null) = (open_question_id is null)
      and (answered_by_person_id is null) = (event_id is null)
      and (option_id is null or answered_by_person_id is not null)
      and (answered_by_role is null or answered_by_role in ('owner', 'admin'))
  ),
  constraint owner_oks_times check (
    answer_by > asked_at
      and (reminded_at is null or reminded_at >= asked_at)
      and (answered_at is null or answered_at >= asked_at)
      and (answer is distinct from 'no_answer' or answered_at >= answer_by)
  )
);

-- One waiting ask per booking and kind of ask, and one per quote: a repeated ask writes no second row (A6-02, A5-08,
-- A4-09, B4-10).
create unique index owner_oks_one_waiting on owner_oks (booking_id, about) where answer is null and quote_id is null;
create unique index owner_oks_one_waiting_per_quote on owner_oks (quote_id)
  where answer is null and quote_id is not null;
-- A booking's asks to the owner.
create index owner_oks_booking_idx on owner_oks (booking_id);
-- What waits on the owner, soonest deadline first (S11-03; A6-02's reminder).
create index owner_oks_waiting_idx on owner_oks (business_id, answer_by) where answer is null;

create trigger owner_oks_version_raised
  before update on owner_oks
  for each row execute function enforce_version_raise();

-- Flow B's place (B4-77, B4-30): the town or ZIP checked against the travel area before any times, then the street
-- address typed on the secure page, sealed, with its zone and state; two for a move, a ride or a tow.
create table booking_addresses (
  id text primary key,
  booking_id text not null,
  business_id text not null,
  position integer not null,
  area text not null,
  address bytea,
  sealed_for_person_id text,
  zone text,
  state_code text,
  location_id text not null,
  checked_at timestamptz,
  version integer not null default 1,
  constraint booking_addresses_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint booking_addresses_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint booking_addresses_sealed_for_fk foreign key (sealed_for_person_id) references persons (id)
    on delete restrict,
  constraint booking_addresses_location_fk foreign key (location_id) references locations (id) on delete restrict,
  constraint booking_addresses_position_key unique (booking_id, position),
  constraint booking_addresses_position_known check (position in (1, 2) and length(btrim(area)) > 0),
  constraint booking_addresses_sealed_with_person check ((address is null) = (sealed_for_person_id is null)),
  constraint booking_addresses_zone_state_form check (
    (zone is null or zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$')
      and (state_code is null or state_code ~ '^[A-Z]{2}$')
  ),
  constraint booking_addresses_checked_has_address check (
    checked_at is null or (address is not null and zone is not null and state_code is not null)
  )
);

create trigger booking_addresses_version_raised
  before update on booking_addresses
  for each row execute function enforce_version_raise();

-- Each secure link issued for a booking (A4-42, B4-29; A4-07, B4-08; A4-12, B4-13): the page it opens, the person it
-- is for, the contact it went to (a K-04 handle of that person) or where else it was given, the sha256 of its short
-- code (never the code), and when and why it ended (S13-19; D75).
create table secure_links (
  id text primary key,
  booking_id text not null,
  business_id text not null,
  purpose text not null,
  person_id text not null,
  handle_id text,
  given_via text not null,
  code_sha256 text not null,
  issued_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_why text,
  version integer not null default 1,
  constraint secure_links_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint secure_links_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint secure_links_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint secure_links_handle_own_fk foreign key (person_id, handle_id)
    references person_handles (person_id, handle_id) on delete restrict,
  constraint secure_links_code_key unique (code_sha256),
  constraint secure_links_purpose_known check (purpose in ('secure_page', 'photos', 'quote')),
  constraint secure_links_given_via check (
    given_via in ('text', 'email', 'ai', 'page') and (given_via in ('text', 'email')) = (handle_id is not null)
  ),
  constraint secure_links_code_hash_form check (code_sha256 ~ '^[0-9a-f]{64}$'),
  constraint secure_links_ended check (
    (ended_at is null) = (ended_why is null)
      and (ended_why is null or ended_why in ('contact_switched', 'booking_ended', 'replaced'))
      and (ended_at is null or ended_at >= issued_at)
  )
);

-- A change of where updates go ends a person's open links at that business at once (D75; S13-19; FIX7 P-1).
create index secure_links_person_open_idx on secure_links (person_id, business_id) where ended_at is null;
-- A booking's links, ended when the booking ends.
create index secure_links_booking_idx on secure_links (booking_id);

create trigger secure_links_version_raised
  before update on secure_links
  for each row execute function enforce_version_raise();

-- What a person typed on the booking's secure page (A4-65, B4-34, A4-25, A4-64, A4-07): each answer its own row, sealed
-- under the key of the person who typed it, never edited; a newer answer of the same kind and question wins.
create table page_answers (
  id text primary key,
  booking_id text not null,
  business_id text not null,
  person_id text not null,
  kind text not null,
  question text,
  answer bytea not null,
  answered_at timestamptz not null default now(),
  constraint page_answers_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint page_answers_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint page_answers_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint page_answers_kind_known check (
    kind in (
      'question', 'note', 'access', 'entry_code', 'safety_need', 'emergency_contact', 'child_details', 'authority',
      'photo'
    )
      and (kind = 'question') = (question is not null)
      and (question is null or length(btrim(question)) > 0)
  )
);

-- A booking's answers for the job page, the newest of each kind first.
create index page_answers_booking_idx on page_answers (booking_id, kind, answered_at);

-- A customer waiting for a spot of a service (A4-60, B4-64), in the times they want, with their own yes to messages
-- about it. Nothing is taken or saved; when a spot opens everyone on it hears at once, and the first to book gets it.
create table waitlist_entries (
  id text primary key,
  business_id text not null,
  booking_id text not null,
  person_id text not null,
  service_id text not null,
  resource_id text,
  wanted tstzrange not null,
  consent_id text not null,
  joined_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_why text,
  version integer not null default 1,
  constraint waitlist_entries_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint waitlist_entries_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint waitlist_entries_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint waitlist_entries_service_fk foreign key (service_id, business_id) references services (id, business_id)
    on delete restrict,
  constraint waitlist_entries_resource_fk foreign key (resource_id) references resources (id) on delete restrict,
  constraint waitlist_entries_consent_fk foreign key (consent_id) references consents (id) on delete restrict,
  constraint waitlist_entries_wanted_bounded check (
    not isempty(wanted) and not lower_inf(wanted) and not upper_inf(wanted)
  ),
  constraint waitlist_entries_ended check (
    (ended_at is null) = (ended_why is null)
      and (ended_why is null or ended_why in ('left', 'time_passed', 'booked'))
      and (ended_at is null or ended_at >= joined_at)
  )
);

-- A person is on a service's list at a business once: a repeated join writes no second row (A4-60).
create unique index waitlist_entries_one_open on waitlist_entries (business_id, person_id, service_id)
  where ended_at is null;
-- When a spot opens, everyone waiting for that service hears at once (A4-60).
create index waitlist_entries_open_idx on waitlist_entries (business_id, service_id) where ended_at is null;

create trigger waitlist_entries_version_raised
  before update on waitlist_entries
  for each row execute function enforce_version_raise();

-- Grants (rule 6; the readers each serves are named in this file's header): the same for both application roles but
-- the code's hash. No delete; of secure_links and waitlist_entries only the end changes; changes and answers are
-- insert only.
grant select, insert, update on quotes, quote_options, owner_oks, booking_addresses to rosie_app, rosie_job;
grant select, insert on booking_changes, page_answers, waitlist_entries to rosie_app, rosie_job;
grant update (ended_at, ended_why, version) on waitlist_entries to rosie_app, rosie_job;
grant select, insert on secure_links to rosie_job;
grant insert on secure_links to rosie_app;
grant select (
    id, booking_id, business_id, purpose, person_id, handle_id, given_via, issued_at, ended_at, ended_why, version
  )
  on secure_links to rosie_app;
grant update (ended_at, ended_why, version) on secure_links to rosie_app, rosie_job;

-- Row-level security on the eight business-scoped tables (rule 5): rosie_app sees only its scope, and writes a row
-- only onto a booking of its scope's business; rosie_job sees everything with no scope, else only its scope.
alter table booking_changes enable row level security;
create policy booking_changes_tool_api_select on booking_changes for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy booking_changes_tool_api_insert on booking_changes for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and exists (
      select 1 from bookings b
      where b.id = booking_changes.booking_id and b.business_id = booking_changes.business_id
    )
  );
create policy booking_changes_runtime on booking_changes for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table quotes enable row level security;
create policy quotes_tool_api_select on quotes for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy quotes_tool_api_insert on quotes for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and exists (
      select 1 from bookings b
      where b.id = quotes.booking_id and b.business_id = quotes.business_id
    )
  );
create policy quotes_tool_api_update on quotes for update to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and exists (
      select 1 from bookings b
      where b.id = quotes.booking_id and b.business_id = quotes.business_id
    )
  );
create policy quotes_runtime on quotes for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table quote_options enable row level security;
create policy quote_options_tool_api on quote_options for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy quote_options_runtime on quote_options for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table owner_oks enable row level security;
create policy owner_oks_tool_api_select on owner_oks for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy owner_oks_tool_api_insert on owner_oks for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and exists (
      select 1 from bookings b
      where b.id = owner_oks.booking_id and b.business_id = owner_oks.business_id
    )
  );
create policy owner_oks_tool_api_update on owner_oks for update to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and exists (
      select 1 from bookings b
      where b.id = owner_oks.booking_id and b.business_id = owner_oks.business_id
    )
  );
create policy owner_oks_runtime on owner_oks for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table booking_addresses enable row level security;
create policy booking_addresses_tool_api_select on booking_addresses for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy booking_addresses_tool_api_insert on booking_addresses for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and exists (
      select 1 from bookings b
      where b.id = booking_addresses.booking_id and b.business_id = booking_addresses.business_id
    )
  );
create policy booking_addresses_tool_api_update on booking_addresses for update to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and exists (
      select 1 from bookings b
      where b.id = booking_addresses.booking_id and b.business_id = booking_addresses.business_id
    )
  );
create policy booking_addresses_runtime on booking_addresses for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table secure_links enable row level security;
create policy secure_links_tool_api_select on secure_links for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy secure_links_tool_api_insert on secure_links for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and exists (
      select 1 from bookings b
      where b.id = secure_links.booking_id and b.business_id = secure_links.business_id
    )
  );
create policy secure_links_tool_api_update on secure_links for update to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and exists (
      select 1 from bookings b
      where b.id = secure_links.booking_id and b.business_id = secure_links.business_id
    )
  );
create policy secure_links_runtime on secure_links for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table page_answers enable row level security;
create policy page_answers_tool_api_select on page_answers for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy page_answers_tool_api_insert on page_answers for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and exists (
      select 1 from bookings b
      where b.id = page_answers.booking_id and b.business_id = page_answers.business_id
    )
  );
create policy page_answers_runtime on page_answers for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table waitlist_entries enable row level security;
create policy waitlist_entries_tool_api_select on waitlist_entries for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy waitlist_entries_tool_api_insert on waitlist_entries for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and exists (
      select 1 from bookings b
      where b.id = waitlist_entries.booking_id and b.business_id = waitlist_entries.business_id
    )
  );
create policy waitlist_entries_tool_api_update on waitlist_entries for update to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and exists (
      select 1 from bookings b
      where b.id = waitlist_entries.booking_id and b.business_id = waitlist_entries.business_id
    )
  );
create policy waitlist_entries_runtime on waitlist_entries for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );
