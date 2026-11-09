-- T-206: the services and prices part (K-25 v1, frozen: contracts/db-schema/services-prices, its table list and its
-- README's rules 1 to 9): the business's services, where each happens and how it is paid there (one way per service and
-- place), which services each space or thing takes, every price as a rule by place, worker and time with effective
-- dates, and a possible tie between two rules with the owner's answer (arch 09 line 462: 10 tables, no names; arch 09
-- lines 457, 478, 488; arch 05 line 253; FS lines 724, 725, 741 and section 2b; S1-12, S1-13, S1-43, S1-81, S2-15,
-- S11-54, S11-56).
-- Expand only: five new tables with their indexes and one EXCLUDE; the version trigger (enforce_version_raise() from
-- 0002, T-181) on the four versioned ones; grants to the two roles 0012 made (never created or altered here); row-level
-- security switched on with 0012's two policies on all five. Nothing is dropped, renamed or retyped, and no row is
-- written or removed; no K-04, K-23 or K-24 table is altered. Not here: price resolution at quote time (the action
-- layer's C-096 and the resolver C-132, README "How a price is found"); the setup seeds (C-155); the rules README rule 9
-- leaves to code (a service's kind is one of the business's, a way's path one its kind offers in that flow, a deposit
-- never more than the price, the tie found at a save, the lower price until it is answered); the migration-side
-- contract test (QA's tests/contract/db-schema.services-prices.v1.test.ts, T-102).
--
-- The five tables live beside K-04's, K-23's and K-24's tables (rule 1), and their foreign keys name them by their keys
-- (businesses.id, persons.id, resources (id, kind), locations.id, places_or_things.id, kinds.id), with no schema prefix,
-- all on delete restrict. Nothing here refers to K-22, K-26, K-27 or K-30. Ids are text, opaque strings code makes and
-- never parses (rule 4; CQ-09); kind_id is K-24's kind id. Money is whole cents in bigint with a three-letter currency
-- code (rule 7). Clock times are time, read in the visit's zone, else the business's; effective dates are instants
-- (timestamptz) matched against a visit's start (rule 8).
--
-- Business and composite keys (rule 5): every table is scoped by business_id, which ways, prices, ties and links copy
-- from their service and hold to it by the composite foreign keys on services_id_business_key, so a row's business is
-- always its service's. A price rule's place is a way of its own service (price_rules_place_fk, on
-- service_money_id_service_key); a tie's two rules are rules of its service (price_rule_ties_first_fk and _second_fk, on
-- price_rules_id_service_key); a rule's worker is a worker resource (price_rules_worker_fk, on K-04's
-- resources_id_kind_key, worker_resource_kind held to 'worker'). MATCH SIMPLE: a rule with no place or no worker leaves
-- that key unchecked, and holds at every place of its service, or whoever goes.
--
-- One price in effect (arch 09 line 488; README "Prices"): price_rules_one_in_effect refuses two rows of one service with
-- the same conditions whose dates overlap (23P01): gist with = on text (the service, and the place, worker and days with
-- none read as '') and on time (the clock times, a day's start and end with none), from btree_gist (0001, in public,
-- which migrate.mjs searches after this schema), beside && on tstzrange(effective_from, effective_to, '[)'). A null
-- effective_to is an open end. A change closes one row and opens the next at the same instant, so [from, to) meets
-- [to, ...) without overlapping. A price withdrawn or corrected before it starts is closed at its own start, an empty
-- range that overlaps nothing, so it stands beside the row that takes over at that instant. A CHECK is tested before the
-- index, so a row closed before its own start is refused by price_rules_dates_in_order (23514), never by the range.
--
-- Versions (rule 3): services, service_money, price_rules and price_rule_ties are updated, so each carries a version that
-- every update raises by exactly one (K-04 rule 2; the trigger refuses any other update, 23514), compared and set by a
-- commit; each has a one-column key (id) a commit can name in versions_read. item_services rows are only inserted and
-- deleted, and carry none. A price rule's values are never edited in place: an update only closes it, which the commit
-- keeps (rule 6, as K-26 v1 does for rules).
--
-- Row-level security (arch 10 line 546; K-04 v1 rule 4; README rule 5): all five are scoped by business, on business_id
-- (never null here), with 0012's two policies: <table>_tool_api lets rosie_app see and write only rows whose business_id
-- equals its scope (the setting rosie.business_id), and none with no scope; <table>_runtime lets rosie_job see every row
-- with no scope, else only its scope's. None is forced: the tables' owner (the migrations' role) is not bound.
--
-- Grants (DL-149: each to a named reader; README rule 6). No TRUNCATE, REFERENCES or TRIGGER, and nothing to PUBLIC.
-- Neither role owns a table.
--   services, service_money, price_rules, price_rule_ties: SELECT, INSERT, UPDATE to both roles, behind the policies,
--     and no DELETE: a service or a way stops by active false and a price by effective_to, so ids stay stable for K-26
--     v1.1, K-30 and K-32 (CQ-51) and history stays (arch 09 line 488); the Tool API's delete is refused (42501).
--   item_services: SELECT and INSERT to both roles; DELETE to rosie_app alone, for S1-81 and Settings (rule 6). The
--     runtime side's commit inserts and updates state rows and removes none of these, so rosie_job holds no DELETE.
--   rosie_job, the runtime side: K-05 commitTurn per write (item 1), whose state writes admit every domain table, writes
--     what journey 1's and journey 11's turns decide (K-09 saveSetupStep in a turn: S1-12 gives services, S1-13 gives
--     ways, S1-43's places, S1-81's links, S2-15's prices by person; S11-54's raise from a date, a price closed and the
--     next opened in one commit; S11-56's change of how a service is paid), and compares rows FOR SHARE or FOR UPDATE
--     (which take UPDATE as well as SELECT); readTurnState (item 26) and the context bundle (C-114: the services, ways
--     and extras the planner answers from) read them.
--   rosie_app, the Tool API, under one business's scope: K-09 saveSetupStep made alone and readSetup (registration
--     screens 10 to 13, C-187, through K-21), the owner console's Settings (C-192: services, ways, prices and the links
--     of the Items tab, Q-46), the booking page and the customer's booking screens (C-197, C-198: the place pick with
--     both prices, the money lines before the yes) and the catalog and pricing calls (C-096); and K-25's refused
--     fixtures, which name the Tool API side inserting a price rule (23P01, 23503), updating a way (23514) and reading
--     another business's prices (0 rows), each refused by its own rule, never by privilege.

-- The business's services, one row per line of its list (S1-12 gives services; FS line 724): the kind of work it was
-- matched to, name, price kind, unit, time it takes, order, whether it is offered, and what the profession file says
-- about it as JSON text (FS Service.extras: no code reads a sub-key, and no price or length comes from it).
create table services (
  id text primary key,
  business_id text not null,
  kind_id text not null,
  name text not null,
  price_kind text not null,
  unit text,
  length interval not null,
  position integer not null,
  active boolean not null default true,
  extras text,
  version integer not null default 1,
  constraint services_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint services_kind_fk foreign key (kind_id) references kinds (id) on delete restrict,
  constraint services_id_business_key unique (id, business_id),
  constraint services_name_given check (length(btrim(name)) > 0),
  constraint services_price_kind_known check (price_kind in ('one_price', 'per_hour', 'per_unit', 'by_answers')),
  constraint services_unit_with_per_unit check (
    (price_kind = 'per_unit') = (unit is not null) and (unit is null or length(btrim(unit)) > 0)
  ),
  constraint services_length_positive check (length > interval '0'),
  constraint services_position_from_one check (position >= 1),
  constraint services_extras_json check (extras is null or extras is json object)
);

-- A business's services in order: the money card (S1-13), Settings (S11-54), the booking page and the context bundle.
create index services_business_idx on services (business_id, position);
-- Search's trade filter: the active services of one kind of work across businesses (arch 05 lines 237, 239).
create index services_kind_idx on services (kind_id, business_id) where active;

create trigger services_version_raised
  before update on services
  for each row execute function enforce_version_raise();

-- Where each service happens and how it is paid there (FS service_money; S1-13 gives ways; S1-43), one row per service
-- and place: the place and its flow, the location, the money path (one of the master's 28 for that flow), the deposit,
-- the late-cancel and no-show fee, and this way's own free-cancel time and tip line where the owner set one (else
-- K-23's flow_defaults and K-26's tip_line rule). The price is a price rule; the rest and the amount paid are worked
-- out by code, never stored.
create table service_money (
  id text primary key,
  service_id text not null,
  business_id text not null,
  flow text not null,
  place text not null,
  location_id text,
  path text not null,
  deposit_cents bigint,
  deposit_percent integer,
  fee_cents bigint,
  currency text,
  cutoff_before interval,
  cutoff_day_before_at time,
  tip_line boolean,
  active boolean not null default true,
  version integer not null default 1,
  constraint service_money_service_fk foreign key (service_id, business_id)
    references services (id, business_id) on delete restrict,
  constraint service_money_location_fk foreign key (location_id) references locations (id) on delete restrict,
  constraint service_money_id_service_key unique (id, service_id),
  constraint service_money_flow_known check (flow in ('A', 'B')),
  constraint service_money_place_known check (place in ('business', 'customer', 'meeting_spot', 'video')),
  constraint service_money_flow_matches_place check ((place = 'customer') = (flow = 'B')),
  constraint service_money_location_by_place check ((place = 'video') = (location_id is null)),
  constraint service_money_path_known check (
    (
      flow = 'A' and path in (
        'list|none|none', 'list|none|counter', 'list|none|bill', 'list|card|counter', 'list|card|bill',
        'list|card|card', 'list|deposit|counter', 'list|deposit|bill', 'list|deposit|card', 'list|full|none',
        'photos|none|none', 'photos|none|counter', 'photos|none|bill', 'photos|card|counter', 'photos|card|bill',
        'photos|card|card', 'photos|deposit|counter', 'photos|deposit|bill', 'photos|deposit|card', 'photos|full|none',
        'visit|none|counter', 'visit|none|bill', 'visit|card|counter', 'visit|card|bill', 'visit|card|card',
        'visit|deposit|counter', 'visit|deposit|bill', 'visit|deposit|card'
      )
    ) or (
      flow = 'B' and path in (
        'list|none|none', 'list|none|bill', 'list|none|own', 'list|card|bill', 'list|card|card', 'list|card|own',
        'list|deposit|bill', 'list|deposit|card', 'list|deposit|own', 'list|full|none', 'photos|none|none',
        'photos|none|bill', 'photos|none|own', 'photos|card|bill', 'photos|card|card', 'photos|card|own',
        'photos|deposit|bill', 'photos|deposit|card', 'photos|deposit|own', 'photos|full|none', 'visit|none|bill',
        'visit|none|own', 'visit|card|bill', 'visit|card|card', 'visit|card|own', 'visit|deposit|bill',
        'visit|deposit|card', 'visit|deposit|own'
      )
    )
  ),
  constraint service_money_deposit_with_deposit_path check (
    (split_part(path, '|', 2) = 'deposit') = (num_nonnulls(deposit_cents, deposit_percent) = 1)
  ),
  constraint service_money_deposit_in_range check (
    (deposit_cents is null or deposit_cents > 0) and (deposit_percent is null or deposit_percent between 1 and 99)
  ),
  constraint service_money_fee_needs_money_before check (
    fee_cents is null or (fee_cents > 0 and split_part(path, '|', 2) <> 'none')
  ),
  constraint service_money_currency_with_amount check (
    (currency is null) = (deposit_cents is null and fee_cents is null) and (currency is null or currency ~ '^[A-Z]{3}$')
  ),
  constraint service_money_one_cutoff check (
    num_nonnulls(cutoff_before, cutoff_day_before_at) <= 1 and (cutoff_before is null or cutoff_before > interval '0')
  ),
  constraint service_money_tip_line_on_bills check (tip_line is null or split_part(path, '|', 3) = 'bill')
);

-- One way per service and place (S1-13: 'A service in two places has two prices and two money rows'), and one by video:
-- partial unique indexes, as the table list's unique rules with their where.
create unique index service_money_one_per_place on service_money (service_id, place, location_id)
  where location_id is not null;
create unique index service_money_one_video on service_money (service_id) where place = 'video';
-- A service's places and ways: the money card and its read-back (S1-13), the place pick and the booking page, Settings.
create index service_money_service_idx on service_money (service_id);
-- A business's ways, for the one-page summary (S1-79) and the money read-back.
create index service_money_business_idx on service_money (business_id);

create trigger service_money_version_raised
  before update on service_money
  for each row execute function enforce_version_raise();

-- Which services each space or thing takes (S1-81: 'Which services use it'; FS section 2b's item_service link), one row
-- per space or thing and service. The space itself is K-23's places_or_things; that it is the same business's spans
-- K-23's table, so code checks it. Added or removed, never updated.
create table item_services (
  place_or_thing_id text not null,
  service_id text not null,
  business_id text not null,
  primary key (place_or_thing_id, service_id),
  constraint item_services_place_or_thing_fk foreign key (place_or_thing_id)
    references places_or_things (id) on delete restrict,
  constraint item_services_service_fk foreign key (service_id, business_id)
    references services (id, business_id) on delete restrict
);

-- The spaces and things a service books, for the space pick (A4-62) and a stay (A4-68).
create index item_services_service_idx on item_services (service_id);

-- Every price (arch 09 line 457: 'Price rule: worker · place · time'), one row per price of a service: the conditions it
-- holds under (a way of the service, a worker, days of the week and clock times; none: the service's own price), the
-- price and any 'from' price, who set it, and its effective dates (arch 09 line 488). The rule with the most conditions
-- set wins at quote time (arch 05 line 253), in code.
create table price_rules (
  id text primary key,
  business_id text not null,
  service_id text not null,
  service_money_id text,
  worker_resource_id text,
  worker_resource_kind text not null default 'worker',
  weekdays text,
  from_time time,
  until_time time,
  price_cents bigint not null,
  from_cents bigint,
  currency text not null,
  set_by_person_id text not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  version integer not null default 1,
  constraint price_rules_service_fk foreign key (service_id, business_id)
    references services (id, business_id) on delete restrict,
  constraint price_rules_place_fk foreign key (service_money_id, service_id)
    references service_money (id, service_id) on delete restrict,
  constraint price_rules_worker_fk foreign key (worker_resource_id, worker_resource_kind)
    references resources (id, kind) on delete restrict,
  constraint price_rules_set_by_fk foreign key (set_by_person_id) references persons (id) on delete restrict,
  constraint price_rules_id_service_key unique (id, service_id),
  constraint price_rules_one_in_effect exclude using gist (
    service_id with =,
    (coalesce(service_money_id, '')) with =,
    (coalesce(worker_resource_id, '')) with =,
    (coalesce(weekdays, '')) with =,
    (coalesce(from_time, time '00:00')) with =,
    (coalesce(until_time, time '24:00')) with =,
    (tstzrange(effective_from, effective_to, '[)')) with &&
  ),
  constraint price_rules_worker_kind check (worker_resource_kind = 'worker'),
  constraint price_rules_weekdays_form check (
    weekdays is null or (weekdays ~ '^1?2?3?4?5?6?7?$' and length(weekdays) between 1 and 6)
  ),
  constraint price_rules_times_form check (
    (from_time is null or from_time > time '00:00')
      and (until_time is null or until_time < time '24:00')
      and (from_time is null or until_time is null or from_time < until_time)
  ),
  constraint price_rules_money check (
    price_cents >= 0 and (from_cents is null or from_cents > 0) and currency ~ '^[A-Z]{3}$'
  ),
  constraint price_rules_dates_in_order check (effective_to is null or effective_to >= effective_from)
);

-- A service's rules in effect at a visit's start: the price resolver (arch 05 line 253; C-132), search's five rows with
-- exact prices (arch 05 line 239; C-131), the times card (A4-14) and the read-back at a save (S11-54).
create index price_rules_service_idx on price_rules (service_id, effective_from);

create trigger price_rules_version_raised
  before update on price_rules
  for each row execute function enforce_version_raise();

-- A possible tie between two rules of one service with as many conditions set that can both apply to one booking,
-- caught when the owner saves the second (arch 05 line 253): when the read-back asked which wins, and the owner's answer,
-- who and when. Until it is answered, the lower price applies (S13-25 rule 19), in code. One row per pair caught.
create table price_rule_ties (
  id text primary key,
  business_id text not null,
  service_id text not null,
  first_rule_id text not null,
  second_rule_id text not null,
  asked_at timestamptz not null,
  winner_rule_id text,
  answered_at timestamptz,
  answered_by_person_id text,
  version integer not null default 1,
  constraint price_rule_ties_service_fk foreign key (service_id, business_id)
    references services (id, business_id) on delete restrict,
  constraint price_rule_ties_first_fk foreign key (first_rule_id, service_id)
    references price_rules (id, service_id) on delete restrict,
  constraint price_rule_ties_second_fk foreign key (second_rule_id, service_id)
    references price_rules (id, service_id) on delete restrict,
  constraint price_rule_ties_answered_by_fk foreign key (answered_by_person_id)
    references persons (id) on delete restrict,
  constraint price_rule_ties_pair_key unique (first_rule_id, second_rule_id),
  constraint price_rule_ties_two_rules check (first_rule_id <> second_rule_id),
  constraint price_rule_ties_winner_of_pair check (
    winner_rule_id is null or winner_rule_id in (first_rule_id, second_rule_id)
  ),
  constraint price_rule_ties_answer_together check (
    (winner_rule_id is null) = (answered_at is null)
      and (answered_at is null) = (answered_by_person_id is null)
      and (answered_at is null or answered_at >= asked_at)
  )
);

-- A service's ties and their answers, read with its rules by the price resolver (arch 05 line 253).
create index price_rule_ties_service_idx on price_rule_ties (service_id);

create trigger price_rule_ties_version_raised
  before update on price_rule_ties
  for each row execute function enforce_version_raise();

-- Grants (the readers each serves are named in this file's header).
-- Versioned and never deleted (README rule 6): both roles, behind the policies below.
grant select, insert, update on services, service_money, price_rules, price_rule_ties to rosie_app, rosie_job;
-- Added or removed, never updated: both roles add a link; the Tool API alone removes one (README rule 6).
grant select, insert on item_services to rosie_app, rosie_job;
grant delete on item_services to rosie_app;

-- Row-level security on all five: rosie_app sees only its scope; rosie_job sees everything with no scope, else only its
-- scope.
alter table services enable row level security;
create policy services_tool_api on services for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy services_runtime on services for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table service_money enable row level security;
create policy service_money_tool_api on service_money for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy service_money_runtime on service_money for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table item_services enable row level security;
create policy item_services_tool_api on item_services for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy item_services_runtime on item_services for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table price_rules enable row level security;
create policy price_rules_tool_api on price_rules for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy price_rules_runtime on price_rules for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table price_rule_ties enable row level security;
create policy price_rule_ties_tool_api on price_rule_ties for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy price_rule_ties_runtime on price_rule_ties for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );
