-- T-720: the bookings and changes part (K-30 v1, frozen: contracts/db-schema/bookings-changes, its table list and its
-- README's rules 1 to 10), part 1 of 2: the rest of the booking beside K-04's head row (booking_details: the door, the
-- booking number, the booking values made by, approval, timing, times and taken, the need-by date, who meets the pro,
-- first_link_given_at, staff_told_at, the upset count and how an unbooked request ended), each visit with its
-- reservation, arrival window, free-cancel time and sealed check-in code, new each visit (booking_visits), each line
-- with the way and the price copied in, written once (booking_lines; RULES 3.7), and the terms snapshot with the
-- owner's rules in force named (booking_terms, booking_terms_rules) (arch 09 lines 457, 467 and 490; FS section 9's
-- booking and booking_service rows, line 729's first_sms_at as first_link_given_at under Q-33, MC C9; C-166).
-- Expand only: five new tables with their indexes; the version trigger (enforce_version_raise() from 0002, T-181) on
-- the three versioned ones; rule 6's trigger on booking_details and its function booking_details_set_once(), which runs
-- as the calling role (never as definer); grants to the two roles 0012 made (never created or altered here); row-level
-- security switched on for all five, with rule 5's policies. Nothing is dropped, renamed or retyped, and no row is
-- written or removed; no other part's table is altered.
--
-- Part 2 (T-721, the next migration) makes quotes, quote_options, owner_oks, booking_changes, booking_addresses,
-- secure_links, page_answers and waitlist_entries. Rule 1 creates booking_changes and quote_options before
-- booking_lines' keys to them, so booking_lines here has five of its seven foreign keys: booking_lines_quote_option_fk
-- (quote_option_id, business_id) -> quote_options (id, business_id) and booking_lines_removed_by_fk
-- (removed_by_change_id, booking_id) -> booking_changes (id, booking_id), both on delete restrict, are part 2's to add
-- once it has made those two tables (ALTER TABLE ... ADD CONSTRAINT, expand only). Until then no code writes a line
-- (C-099 is not built), so neither column names a row. Not here either: the bookings service that writes these rows
-- (C-099), the K-05 calls that read and write them, sealing and unsealing (T-182's db/repo/sealing.ts), the rules
-- README rule 10 leaves to code, and the migration-side contract test (QA's tests/contract/db-schema.bookings-changes
-- .v1.test.ts, T-107).
--
-- The five live beside K-04's tables and the other parts' (rule 1), and their foreign keys name them by key with no
-- schema prefix (bookings.id, businesses.id, persons.id, reservations.id, services (id, business_id), service_money
-- (id, service_id), price_rules (id, service_id), consents.id, rules.id, price_ok_limits.id), all on delete restrict.
-- A line's service is its business's, and its way and its price rule that service's, by composite keys on K-25's
-- services_id_business_key, service_money_id_service_key and price_rules_id_service_key. K-04's head has no key on
-- (id, business_id), so a row's business is held to its booking's by rule 5's policies below, not by a key. MATCH
-- SIMPLE: a row with no person, reservation, rule, price rule, consent or limit leaves that key unchecked. Ids are text,
-- opaque strings code makes and never parses (rule 3; CQ-09); booking_details.number is unique within its business.
-- No extension beyond K-04's (rule 2): tstzrange is built in, and no PostGIS type is used.
--
-- Times and money (rule 9): every instant is timestamptz and the arrival window a bounded tstzrange, in UTC, shown in
-- the visit's zone; need_by is a day; the one clock time kept, a copied day-before cancel time, names the zone it was
-- read in (booking_terms.cutoff_zone). Every amount is integer minor units in bigint with its three-letter currency.
--
-- Versions (rule 4): booking_details, booking_visits and booking_lines carry a version that every update raises by
-- exactly one (K-04 rule 2; the trigger refuses any other update, 23514), compared and set by a commit, with a
-- one-column key a commit can name in versions_read. booking_terms and booking_terms_rules are only inserted and carry
-- none.
--
-- Written once (rule 6; FS lines 750 to 752), by privilege and one trigger, the same for both application roles:
-- no DELETE on any of the five (42501; rule 8 keeps a booking and the words agreed 7 years). booking_terms and
-- booking_terms_rules take no UPDATE (42501: refuse-terms-snapshot-update). booking_lines takes UPDATE of state,
-- removed_at, removed_by_change_id and version only, so the copy is never changed (refuse-booking-line-price-change,
-- 42501; RULES 3.7: a booking keeps the price it was made with, whatever K-25's list does later). booking_visits takes
-- UPDATE of reservation_id, arrival_window, cutoff_at and version only, so a move points a visit at its new
-- reservation and moves its window and free-cancel time, and the code never changes. booking_details takes updates,
-- but its BEFORE UPDATE trigger booking_details_set_once refuses any change to booking_id, business_id, number, door or
-- made_by, and any change to approval, timing, times, taken, first_link_given_at, staff_told_at, request_ended_at or
-- request_ended_why once set (a null value may be set once), with SQLSTATE 23514 and constraint
-- booking_details_set_once (refuse-booking-value-reset); need_by, meets_pro, meets_pro_person_id and upset_count move.
--
-- Sealed field (rule 7; T-182's sealing, migration 0003 and db/repo/sealing.ts): booking_visits.check_in_code is
-- bytea holding only the sealed form of the visit's code, under the key of code_for_person_id (the person served, or
-- whoever meets the pro) in core's sealing_keys, never a plain copy, so deleting that person's key erases it (rule 8).
-- Each visit holds its own code (A6-14: new for this visit; A7-01), and no update grant reaches it (A7-03: a move keeps
-- it). Every other column here is plain and holds no words a person typed: the terms they ticked are K-29's consent
-- row, which booking_terms names (rule 7: consent proofs survive).
--
-- Row-level security (arch 10 line 546; K-04 v1 rule 4; README rule 5): all five are scoped by business, on
-- business_id (never null here). Each has 0012's <table>_runtime for rosie_job: every row with no scope (the runtime
-- side reads unscoped only for the dispatcher reading a booking for a message, clock firings and the 45-day erasure,
-- and holds a row's booking to its business by code), else only its scope's. The Tool API (rosie_app) has one policy
-- per command its grants allow: <table>_tool_api_select reads only rows whose business_id equals its scope (the setting
-- rosie.business_id), and none with no scope; <table>_tool_api_insert, and <table>_tool_api_update where an update is
-- granted, also require, on the new row, exists (select 1 from bookings b where b.id = <table>.booking_id and
-- b.business_id = <table>.business_id), which K-04's own row-level security on bookings limits to the call's scope, so
-- a call can never attach a row to another business's booking (refuse-line-on-other-business-booking, 42501), though
-- the key to bookings alone would let it through. No policy allows a delete, and none is forced: the tables' owner (the
-- migrations' role) is not bound. A foreign-key check runs as the owner, so a row's service, way, rule, reservation,
-- person and consent are checked without row-level security.
--
-- Grants (DL-149: each to a named reader; README rule 6, the same for both application roles), table grants but for
-- the two named column grants. No DELETE, TRUNCATE, REFERENCES or TRIGGER, and nothing to PUBLIC. Neither role owns a
-- table or the function.
--   rosie_app, the Tool API, under one business's scope, behind the policies above:
--     booking_details: SELECT, INSERT and UPDATE. Bookings and quotes (C-099; K-09 v1.1 to v1.5) write it in the
--       turn that opens a request at the door or reads back the owner's BOOK, and set each booking value when it is
--       decided; the Agent API (C-110) gives the booking number, never the code; the frontier and record flags, the
--       slot filler and the claim check (C-075, C-078, C-088, C-091) read the booking values; the owner console's
--       Bookings page and the customer booking screens (C-192, C-197, C-198) read them through K-21. The update grant
--       serves a value decided, the need-by date, who meets the pro, the upset count and the version.
--     booking_visits: SELECT, INSERT, and UPDATE of reservation_id, arrival_window, cutoff_at and version. C-099
--       writes each visit when the booking is written (A6-10, B6-10) and a move points it at its new reservation
--       (A7-03); the confirmation, the booking page and the secure page (C-197, C-199) read the window and the
--       free-cancel time.
--     booking_lines: SELECT, INSERT, and UPDATE of state, removed_at, removed_by_change_id and version. C-099 writes
--       each line when the time is saved (A4-21, B4-23) or on the owner's BOOK and removes it at a change of what is
--       booked (A7-31); payments and the fee door (C-101, C-106) and the slot filler (pay.*) read it.
--     booking_terms and booking_terms_rules: SELECT and INSERT. C-099 writes the snapshot in the commit that writes
--       the booking (A6-10, B6-10, A6-12, A3-30); the fee door, cancels and moves (C-106; A7-03 to A7-06) and the
--       owner's rules limit (C-082) read it.
--   rosie_job, the runtime side, behind 0012's policies, the same grants: K-05 commitTurn per write (item 1), whose
--     state writes admit every domain table, writes what a turn decides on these five as the Tool API does above, and
--     compares rows FOR SHARE or FOR UPDATE (which take UPDATE of a column as well as SELECT); readTurnState (item 26)
--     reads them; the outbox dispatcher (C-124) reads a booking for a message and sets staff_told_at on the pro's
--     delivery; clock firings (C-054) read the free-cancel time; the 45-day copy or delete reads a person's bookings
--     unscoped (C-156).

-- The rest of the booking beside K-04's head row (FS line 729): one row per booking, written with the head, holding
-- the door, the booking number, the booking values (null until decided, then set once), the need-by date, who meets
-- the pro, when the first chat link was given and the pro told, the upset count, and how an unbooked request ended.
create table booking_details (
  booking_id text primary key,
  business_id text not null,
  number text not null,
  door text not null,
  made_by text not null,
  approval text,
  timing text,
  times text,
  taken text,
  need_by date,
  meets_pro text,
  meets_pro_person_id text,
  first_link_given_at timestamptz,
  staff_told_at timestamptz,
  upset_count integer not null default 0,
  request_ended_at timestamptz,
  request_ended_why text,
  version integer not null default 1,
  constraint booking_details_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint booking_details_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint booking_details_meets_pro_fk foreign key (meets_pro_person_id) references persons (id) on delete restrict,
  constraint booking_details_number_key unique (business_id, number),
  constraint booking_details_number_form check (number ~ '^[^[:space:]]+$'),
  constraint booking_details_door_known check (door in ('ai', 'page', 'chat', 'business', 'walk_in')),
  constraint booking_details_made_by_known check (made_by in ('customer', 'shop')),
  constraint booking_details_made_by_door check ((door in ('business', 'walk_in')) = (made_by = 'shop')),
  constraint booking_details_approval_known check (approval is null or approval in ('now', 'ownerok')),
  constraint booking_details_shop_books_now check (made_by = 'customer' or approval is null or approval = 'now'),
  constraint booking_details_timing_known check (timing is null or timing in ('settime', 'sentnow')),
  constraint booking_details_times_known check (times is null or times in ('window', 'setstart', 'stay', 'seat')),
  constraint booking_details_taken_known check (taken is null or taken in ('asked', 'nothing')),
  constraint booking_details_meets_pro_known check (
    (meets_pro is null or meets_pro in ('served', 'someone_else', 'nobody_home'))
      and (meets_pro_person_id is null or meets_pro = 'someone_else')
  ),
  constraint booking_details_upset_count check (upset_count >= 0),
  constraint booking_details_request_end check (
    (request_ended_at is null) = (request_ended_why is null)
      and (
        request_ended_why is null
          or request_ended_why in (
            'let_go', 'declined', 'no_answer', 'dropped', 'not_signed', 'not_paid', 'outside_area', 'not_listed',
            'waitlist'
          )
      )
  )
);

create trigger booking_details_version_raised
  before update on booking_details
  for each row execute function enforce_version_raise();

-- Rule 6: the written-once values. Its body is the one the README gives (T-039's check). It reads no table, so, as
-- enforce_version_raise(), it needs no search_path of its own, and it stays security invoker: it runs as the calling
-- role. Its refusal names the constraint booking_details_set_once and no value.
create function booking_details_set_once() returns trigger
language plpgsql
as $$
begin
  if new.booking_id is distinct from old.booking_id
     or new.business_id is distinct from old.business_id
     or new.number is distinct from old.number
     or new.door is distinct from old.door
     or new.made_by is distinct from old.made_by
     or (old.approval is not null and new.approval is distinct from old.approval)
     or (old.timing is not null and new.timing is distinct from old.timing)
     or (old.times is not null and new.times is distinct from old.times)
     or (old.taken is not null and new.taken is distinct from old.taken)
     or (old.first_link_given_at is not null and new.first_link_given_at is distinct from old.first_link_given_at)
     or (old.staff_told_at is not null and new.staff_told_at is distinct from old.staff_told_at)
     or (old.request_ended_at is not null and new.request_ended_at is distinct from old.request_ended_at)
     or (old.request_ended_why is not null and new.request_ended_why is distinct from old.request_ended_why) then
    raise exception 'a booking value is set once and never changed (FS line 752)'
      using errcode = 'check_violation', constraint = 'booking_details_set_once';
  end if;
  return new;
end;
$$;

create trigger booking_details_set_once
  before update on booking_details
  for each row execute function booking_details_set_once();

-- Each visit of a booking (A7-01, A7-05): its reservation, whose during is the booked time itself (K-04), its arrival
-- window or sent-now estimate, its free-cancel time, and its check-in code, new each visit, sealed. A move points it at
-- the new reservation and moves its window and free-cancel time; the code never changes (A7-03).
create table booking_visits (
  id text primary key,
  booking_id text not null,
  business_id text not null,
  position integer not null,
  reservation_id text,
  arrival_window tstzrange,
  cutoff_at timestamptz,
  check_in_code bytea,
  code_for_person_id text,
  version integer not null default 1,
  constraint booking_visits_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint booking_visits_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint booking_visits_reservation_fk foreign key (reservation_id) references reservations (id)
    on delete restrict,
  constraint booking_visits_code_person_fk foreign key (code_for_person_id) references persons (id) on delete restrict,
  constraint booking_visits_position_key unique (booking_id, position),
  constraint booking_visits_id_booking_key unique (id, booking_id),
  constraint booking_visits_reservation_key unique (reservation_id),
  constraint booking_visits_position_from_one check (position >= 1),
  constraint booking_visits_code_with_person check ((check_in_code is null) = (code_for_person_id is null)),
  constraint booking_visits_window_bounded check (
    arrival_window is null
      or (not isempty(arrival_window) and not lower_inf(arrival_window) and not upper_inf(arrival_window))
  )
);

create trigger booking_visits_version_raised
  before update on booking_visits
  for each row execute function enforce_version_raise();

-- One row per service on a booking, with the way and the price copied in when the time is saved (A4-21, B4-23) or on
-- the owner's reply for a booking the business adds (A3-30, B3-08), in integer minor units with their currency, and
-- how it is paid. The copy is written once and never changed; a change of what is booked marks a line removed and adds
-- one (A7-31; RULES 3.8). Part 2 adds booking_lines_quote_option_fk and booking_lines_removed_by_fk (this file's
-- header).
create table booking_lines (
  id text primary key,
  booking_id text not null,
  business_id text not null,
  position integer not null,
  service_id text not null,
  service_money_id text not null,
  price_rule_id text,
  quote_option_id text,
  path text not null,
  price_kind text not null,
  unit text,
  units integer not null default 1,
  price_cents bigint not null,
  up_to_cents bigint,
  from_cents bigint,
  deposit_cents bigint,
  fee_cents bigint,
  currency text not null,
  paid_by text not null default 'money',
  state text not null default 'open',
  removed_at timestamptz,
  removed_by_change_id text,
  version integer not null default 1,
  constraint booking_lines_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint booking_lines_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint booking_lines_service_fk foreign key (service_id, business_id) references services (id, business_id)
    on delete restrict,
  constraint booking_lines_way_fk foreign key (service_money_id, service_id) references service_money (id, service_id)
    on delete restrict,
  constraint booking_lines_price_rule_fk foreign key (price_rule_id, service_id)
    references price_rules (id, service_id) on delete restrict,
  constraint booking_lines_position_key unique (booking_id, position),
  constraint booking_lines_path_form check (
    path ~ '^(list|photos|visit)[|](none|card|deposit|full)[|](none|counter|bill|card|own)$'
  ),
  constraint booking_lines_price_kind_known check (
    price_kind in ('one_price', 'per_hour', 'per_unit', 'by_answers') and (price_kind = 'per_unit') = (unit is not null)
  ),
  constraint booking_lines_units check (units >= 1 and (price_kind <> 'one_price' or units = 1)),
  constraint booking_lines_money check (
    price_cents >= 0
      and (up_to_cents is null or up_to_cents > price_cents)
      and (from_cents is null or from_cents > 0)
      and (deposit_cents is null or deposit_cents > 0)
      and (fee_cents is null or fee_cents > 0)
      and currency ~ '^[A-Z]{3}$'
  ),
  constraint booking_lines_price_source check (
    (split_part(path, '|', 1) = 'photos') = (quote_option_id is not null)
      and (split_part(path, '|', 1) = 'photos') = (price_rule_id is null)
  ),
  constraint booking_lines_range_and_from check (
    (up_to_cents is null or split_part(path, '|', 1) = 'photos')
      and (from_cents is null or split_part(path, '|', 1) = 'visit')
  ),
  constraint booking_lines_deposit_with_deposit_path check (
    (split_part(path, '|', 2) = 'deposit') = (deposit_cents is not null)
      and (
        deposit_cents is null
          or deposit_cents
            <= (case when split_part(path, '|', 1) = 'visit' then coalesce(from_cents, price_cents) else price_cents end)
      )
  ),
  constraint booking_lines_fee_needs_money_before check (fee_cents is null or split_part(path, '|', 2) <> 'none'),
  constraint booking_lines_paid_by_known check (paid_by in ('money', 'credit')),
  constraint booking_lines_state check (
    state in ('open', 'removed')
      and (state = 'removed') = (removed_at is not null)
      and (removed_by_change_id is null or state = 'removed')
  )
);

-- The open lines of a service: what a price or way change leaves as it is (S11-54, S11-56), and K-32's packs and
-- memberships.
create index booking_lines_service_idx on booking_lines (service_id) where state = 'open';

create trigger booking_lines_version_raised
  before update on booking_lines
  for each row execute function enforce_version_raise();

-- The terms snapshot (arch 09 line 457: rules copied in): one row per booking, written once in the commit that writes
-- the booking, never changed. It names the terms the customer ticked (K-29's consent row holds the exact words and
-- their hash), their version and language, the notices shown at booking, and the cancel rule each visit's free-cancel
-- time is worked out from (the way's own, else K-23's default for the flow).
create table booking_terms (
  booking_id text primary key,
  business_id text not null,
  terms_consent_id text,
  terms_version text not null,
  terms_language text not null,
  notices_shown text[] not null default '{}',
  cutoff_before interval,
  cutoff_day_before_at time,
  cutoff_zone text,
  written_at timestamptz not null default now(),
  constraint booking_terms_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint booking_terms_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint booking_terms_consent_fk foreign key (terms_consent_id) references consents (id) on delete restrict,
  constraint booking_terms_consent_key unique (terms_consent_id),
  constraint booking_terms_version_given check (
    length(btrim(terms_version)) > 0 and terms_language ~ '^[a-z]{2,3}(-[A-Za-z0-9]+)*$'
  ),
  constraint booking_terms_one_cutoff check (
    num_nonnulls(cutoff_before, cutoff_day_before_at) <= 1 and (cutoff_before is null or cutoff_before > interval '0')
  ),
  constraint booking_terms_zone_with_clock check (
    (cutoff_day_before_at is null) = (cutoff_zone is null)
      and (cutoff_zone is null or cutoff_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$')
  )
);

-- The owner's rules in force when the booking was written, each named in its snapshot: one row per K-26 rule or price
-- OK limit in force for the booking's flow and kind of work. K-26 never edits a row's value in place or deletes it, so
-- naming the row in force copies its value exactly. Written once with the snapshot, never changed.
create table booking_terms_rules (
  id text primary key,
  booking_id text not null,
  business_id text not null,
  rule_id text,
  price_ok_limit_id text,
  constraint booking_terms_rules_terms_fk foreign key (booking_id) references booking_terms (booking_id)
    on delete restrict,
  constraint booking_terms_rules_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint booking_terms_rules_rule_fk foreign key (rule_id) references rules (id) on delete restrict,
  constraint booking_terms_rules_limit_fk foreign key (price_ok_limit_id) references price_ok_limits (id)
    on delete restrict,
  constraint booking_terms_rules_rule_key unique (booking_id, rule_id),
  constraint booking_terms_rules_limit_key unique (booking_id, price_ok_limit_id),
  constraint booking_terms_rules_one_ref check (num_nonnulls(rule_id, price_ok_limit_id) = 1)
);

-- Grants (rule 6; the readers each serves are named in this file's header): the same for both application roles. No
-- delete; of booking_visits and booking_lines, only the named columns change; the snapshot is insert only.
grant select, insert, update on booking_details to rosie_app, rosie_job;
grant select, insert on booking_visits, booking_lines, booking_terms, booking_terms_rules to rosie_app, rosie_job;
grant update (reservation_id, arrival_window, cutoff_at, version) on booking_visits to rosie_app, rosie_job;
grant update (state, removed_at, removed_by_change_id, version) on booking_lines to rosie_app, rosie_job;

-- Row-level security on the five business-scoped tables (rule 5): rosie_app sees only its scope, and writes a row only
-- onto a booking of its scope's business; rosie_job sees everything with no scope, else only its scope.
alter table booking_details enable row level security;
create policy booking_details_tool_api_select on booking_details for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy booking_details_tool_api_insert on booking_details for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and exists (
      select 1 from bookings b
      where b.id = booking_details.booking_id and b.business_id = booking_details.business_id
    )
  );
create policy booking_details_tool_api_update on booking_details for update to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and exists (
      select 1 from bookings b
      where b.id = booking_details.booking_id and b.business_id = booking_details.business_id
    )
  );
create policy booking_details_runtime on booking_details for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table booking_visits enable row level security;
create policy booking_visits_tool_api_select on booking_visits for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy booking_visits_tool_api_insert on booking_visits for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and exists (
      select 1 from bookings b
      where b.id = booking_visits.booking_id and b.business_id = booking_visits.business_id
    )
  );
create policy booking_visits_tool_api_update on booking_visits for update to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and exists (
      select 1 from bookings b
      where b.id = booking_visits.booking_id and b.business_id = booking_visits.business_id
    )
  );
create policy booking_visits_runtime on booking_visits for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table booking_lines enable row level security;
create policy booking_lines_tool_api_select on booking_lines for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy booking_lines_tool_api_insert on booking_lines for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and exists (
      select 1 from bookings b
      where b.id = booking_lines.booking_id and b.business_id = booking_lines.business_id
    )
  );
create policy booking_lines_tool_api_update on booking_lines for update to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and exists (
      select 1 from bookings b
      where b.id = booking_lines.booking_id and b.business_id = booking_lines.business_id
    )
  );
create policy booking_lines_runtime on booking_lines for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table booking_terms enable row level security;
create policy booking_terms_tool_api_select on booking_terms for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy booking_terms_tool_api_insert on booking_terms for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and exists (
      select 1 from bookings b
      where b.id = booking_terms.booking_id and b.business_id = booking_terms.business_id
    )
  );
create policy booking_terms_runtime on booking_terms for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table booking_terms_rules enable row level security;
create policy booking_terms_rules_tool_api_select on booking_terms_rules for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy booking_terms_rules_tool_api_insert on booking_terms_rules for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and exists (
      select 1 from bookings b
      where b.id = booking_terms_rules.booking_id and b.business_id = booking_terms_rules.business_id
    )
  );
create policy booking_terms_rules_runtime on booking_terms_rules for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );
