-- T-203: the business setup part (K-23 v1, frozen: contracts/db-schema/business-setup): the business fields core's
-- businesses row does not hold, the flow defaults, companies and their kinds of work, the profile's photos and FAQs,
-- locations with their map points and flow B travel area, places and things, and the owner's PAUSE of new bookings (arch
-- 09 line 460: 9 tables; FS lines 721, 722 and 741; S1-04, S1-09, S1-21, S1-27, S1-29, S1-75, S1-81, S1-84, S11-15,
-- S11-16).
-- Expand only: nine new tables with their indexes; the version trigger (enforce_version_raise() from 0002, T-181) on all
-- nine; grants to the two roles 0012 made (never created or altered here); row-level security switched on with 0012's
-- two policies on each of the nine. Nothing is dropped, renamed or retyped, and no row is written or removed. K-04's
-- businesses row (0002) keeps its columns as they are: K-23 v1 adds no column to it, and holds the rest of FS line 721 in
-- business_setup, one row per business beside it, never repeating a core column. Not here: turning an address into a
-- map point (the geo port, K-17), the writes themselves (K-09's setup calls through the one commit) and the
-- migration-side contract test (QA's tests/contract/db-schema.business-setup.v1.test.ts).
--
-- The nine tables live beside K-04's tables (K-23 README rule 1), and their foreign keys name core tables by K-04's keys
-- (businesses.id, persons.id), with no schema prefix, all on delete restrict. No table here refers to K-29 or K-37.
-- Ids are text: opaque strings code makes and never parses (rule 4; CQ-09); kind_id is the profession file's id, whose
-- foreign key K-24 adds. Money is whole cents with a currency code, both or neither (rule 7). Map points are PostGIS
-- geography(Point,4326) (rule 2): postgis lives in public (0001), which migrate.mjs searches after this schema; a value is
-- given as EWKT, such as SRID=4326;POINT(-90 40), and the travel check is ST_DWithin on stored points (Q-25).
--
-- Versions (rule 3): every table here is updated, so each carries a version that every update raises by exactly one
-- (K-04 rule 2; the trigger refuses any other update, 23514), compared and set by a commit. The versioned tables with a
-- one-column key, which a commit can name in versions_read, are business_setup (business_id), companies,
-- business_photos, business_faqs, locations, places_or_things and new_booking_pauses (id); flow_defaults (business_id,
-- flow) and company_kinds (company_id, kind_id) have two-column keys.
--
-- Companies and kinds (S1-04): a company may be written before its business, so companies.business_id is null until
-- then; companies_business_key keeps one company per business, and companies_id_business_key is the key
-- company_kinds_company_business_fk names, so a kind's business_id, copied from its company for row-level security, is
-- always its company's (MATCH SIMPLE: with business_id null only company_kinds_company_fk holds it). Rules across rows are
-- kept by code: that each kind belongs to one company of an owner; that photos show only the place, the team or a logo
-- for sensitive work (S13-22); which fact and switch names are known (K-26's registry).
--
-- Row-level security (arch 10 line 546; K-04 v1 rule 4; K-23 README rule 5): all nine are scoped by business, on
-- business_id, with 0012's two policies: <table>_tool_api lets rosie_app see and write only rows whose business_id equals
-- its scope (the setting rosie.business_id), and none with no scope; <table>_runtime lets rosie_job see every row with
-- no scope, else only its scope's. A company, or a company's kind, whose business is null is seen by no business scope:
-- sign-up's turns read and write it on the runtime side.
--
-- Grants (DL-149: each to a named reader): SELECT, INSERT and UPDATE on all nine to both roles, behind the policies; no
-- DELETE (no row here is ever removed), TRUNCATE, REFERENCES or TRIGGER, and nothing to PUBLIC. Neither role owns a table.
--   rosie_job, the runtime side: K-05 commitTurn (item 1, per write), whose state writes admit every domain table, writes
--     each K-23 row a turn decides (K-09: S1-04's companies and kinds, before the business exists included; S1-13's
--     no_money; S1-21's flow defaults; S1-43's locations; S1-81's spaces; S11-15's PAUSE and S11-16's RESUME), and reads
--     each row a turn compares FOR SHARE or FOR UPDATE (which take UPDATE as well as SELECT); K-05 fireClock (item 7,
--     writes per write) sets new_booking_pauses.reminded_at (S11-15: still paused at 8am, Rosie asks once); K-05
--     readTurnState with no business (item 26) reads companies and kinds before there is a business; K-09
--     decideReviewItem from the team console (K-21: the runtime side) writes business_setup's control back (team_check).
--   rosie_app, the Tool API, under one business's scope: SELECT on all nine for K-05 readTurnState (item 26: each fact
--     from its home, any versioned table of a frozen list; K-23's facts are T-667's) and K-09 readSetup (each key given
--     or missing), with K-21's listing read (photos and FAQs in order), the booking page and the AI door's PAUSE check
--     (S11-15), K-21 stripeOnboardingStart (the account id from Rosie's own record) and K-09 v1.1 confirmBusinessBooking
--     (flow_defaults.arrive); INSERT and UPDATE for K-09 saveSetupStep made alone under a page's or the console's
--     business (registration screen 2's S1-09 inserts business_setup; the pay page's S1-27, the preview's S1-29 and
--     screen 7's S1-84 update it, and S1-84 adds photos; S1-04, S1-21, S1-43, S1-81 and S1-84's FAQs write their rows the
--     same way: K-23's freeze record), K-09 proveCode (S1-75: control_proven_at), the owner's PAUSE and RESUME (S11-15,
--     S11-16), and K-23's refused fixtures, which name the Tool API side inserting photos, locations and pauses and
--     updating a kind, each refused by its own rule (23514, 23505), never by privilege.

-- One row per business beside core's businesses row (FS line 721): the listing's phone and email, website, About us and
-- the profile's confirmation, the Stripe account, no money through Rosie, the terms and who ticked them, and how control
-- of the business was proven (S1-09, S1-13, S1-27, S1-29, S1-75, S1-84).
create table business_setup (
  business_id text primary key,
  listing_phone text,
  listing_email text,
  website text,
  about text,
  profile_confirmed_at timestamptz,
  stripe_account_id text,
  no_money boolean not null default false,
  terms_accepted_at timestamptz,
  terms_accepted_by_person_id text,
  control_proven_at timestamptz,
  control_proven_via text,
  version integer not null default 1,
  constraint business_setup_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint business_setup_terms_by_fk foreign key (terms_accepted_by_person_id)
    references persons (id) on delete restrict,
  constraint business_setup_listing_phone_form check (listing_phone is null or listing_phone ~ '^\+[1-9][0-9]{6,14}$'),
  constraint business_setup_listing_email_form check (
    listing_email is null or (listing_email ~ '^[^@[:space:]]+@[^@[:space:]]+$' and listing_email = lower(listing_email))
  ),
  constraint business_setup_website_form check (website is null or website ~ '^https?://[^[:space:]]+$'),
  constraint business_setup_terms_with_who check ((terms_accepted_at is null) = (terms_accepted_by_person_id is null)),
  constraint business_setup_control_with_way check ((control_proven_at is null) = (control_proven_via is null)),
  constraint business_setup_control_way_known check (
    control_proven_via is null or control_proven_via in ('listing_code', 'team_check')
  )
);

create trigger business_setup_version_raised
  before update on business_setup
  for each row execute function enforce_version_raise();

-- The default free-cancel time (H06) and arrival setting (H07), one row per flow the business offers (A: the customer
-- comes to the business; B: the business goes to the customer), from the plug-in's pf.settings, kept or changed at S1-21.
-- A booking copies its free-cancel time in when it is made, so a change here applies to new bookings only.
create table flow_defaults (
  business_id text not null,
  flow text not null,
  cutoff_before interval,
  cutoff_day_before_at time,
  arrive text not null,
  version integer not null default 1,
  primary key (business_id, flow),
  constraint flow_defaults_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint flow_defaults_flow_known check (flow in ('A', 'B')),
  constraint flow_defaults_arrive_known check (arrive in ('setstart', 'window')),
  constraint flow_defaults_one_cutoff check (num_nonnulls(cutoff_before, cutoff_day_before_at) = 1),
  constraint flow_defaults_cutoff_before_positive check (cutoff_before is null or cutoff_before > interval '0')
);

create trigger flow_defaults_version_raised
  before update on flow_defaults
  for each row execute function enforce_version_raise();

-- A company (B10): kinds of work that share one tax number, one Stripe and one bill. One company is one business; a
-- second company is a second business on the same login (S1-04). It may exist before its business row.
create table companies (
  id text primary key,
  owner_person_id text not null,
  name text not null,
  business_id text,
  version integer not null default 1,
  constraint companies_owner_fk foreign key (owner_person_id) references persons (id) on delete restrict,
  constraint companies_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint companies_business_key unique (business_id),
  constraint companies_id_business_key unique (id, business_id)
);

-- An owner's companies: S1-04's split, S1-35's 'Next' and S11-15's 'Pause which business?'.
create index companies_owner_idx on companies (owner_person_id);

create trigger companies_version_raised
  before update on companies
  for each row execute function enforce_version_raise();

-- Each kind of work and its company (S1-04), with the kind's own trade name (B01) and the plug-in's facts and the
-- switches on in each flow as typed columns, because logic reads them (FS line 746; SPEC-master 5b, 5d).
create table company_kinds (
  company_id text not null,
  kind_id text not null,
  business_id text,
  trade_name text,
  pf_facts text[] not null default '{}',
  pf_switches_a text[] not null default '{}',
  pf_switches_b text[] not null default '{}',
  version integer not null default 1,
  primary key (company_id, kind_id),
  constraint company_kinds_company_fk foreign key (company_id) references companies (id) on delete restrict,
  constraint company_kinds_company_business_fk foreign key (company_id, business_id)
    references companies (id, business_id) on delete restrict,
  constraint company_kinds_kind_id_form check (kind_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint company_kinds_names_form check (
    array_to_string(pf_facts || pf_switches_a || pf_switches_b, ',') ~ '^([a-z0-9]+(,[a-z0-9]+)*)?$'
  ),
  constraint company_kinds_nomoney_fact_and_switch check (
    ('nomoney' = any(pf_facts)) = ('nomoney' = any(pf_switches_a) or 'nomoney' = any(pf_switches_b))
  )
);

-- A business's kinds of work with their facts and switches (the frontier and the gate read them).
create index company_kinds_business_idx on company_kinds (business_id);

create trigger company_kinds_version_raised
  before update on company_kinds
  for each row execute function enforce_version_raise();

-- The profile's photos (B07): the place, the work, the team or a logo, drafted from the listing or website or sent by
-- the owner, shown once the owner confirms the profile; never a person not on the team without the owner confirming
-- that person's written yes (S1-84).
create table business_photos (
  id text primary key,
  business_id text not null,
  object_key text not null,
  label text,
  shows text not null,
  came_from text not null,
  position integer not null,
  shows_person_not_on_team boolean not null default false,
  written_yes_confirmed_at timestamptz,
  version integer not null default 1,
  constraint business_photos_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint business_photos_shows_known check (shows in ('place', 'work', 'team', 'logo')),
  constraint business_photos_came_from_known check (came_from in ('listing', 'website', 'owner')),
  constraint business_photos_position_positive check (position >= 1),
  constraint business_photos_person_needs_yes check (
    not shows_person_not_on_team or written_yes_confirmed_at is not null
  )
);

-- The listing page and the preview show a business's photos in order (S1-29, S1-84).
create index business_photos_business_idx on business_photos (business_id, position);

create trigger business_photos_version_raised
  before update on business_photos
  for each row execute function enforce_version_raise();

-- Optional FAQs (B08): a question and the owner's answer, which the listing page shows and Rosie answers from.
create table business_faqs (
  id text primary key,
  business_id text not null,
  question text not null,
  answer text not null,
  position integer not null,
  version integer not null default 1,
  constraint business_faqs_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint business_faqs_words_given check (length(btrim(question)) > 0 and length(btrim(answer)) > 0),
  constraint business_faqs_position_positive check (position >= 1)
);

-- The listing page and the planner read a business's FAQs in order (S1-84).
create index business_faqs_business_idx on business_faqs (business_id, position);

create trigger business_faqs_version_raised
  before update on business_faqs
  for each row execute function enforce_version_raise();

-- Where the business is (FS line 722): a shop, an office or a meeting spot, with its address and map point; a shop or
-- office can be the centre of the flow B travel area, with its miles, a centre other than its own address (as a map pin
-- and that address, both or neither) and a travel fee for farther towns (L02, L03). Its opening hours are K-27's.
create table locations (
  id text primary key,
  business_id text not null,
  kind text not null,
  name text,
  address text not null,
  map_point geography(Point, 4326),
  end_address text,
  travel_miles numeric,
  travel_centre geography(Point, 4326),
  travel_centre_address text,
  travel_fee_cents integer,
  travel_fee_currency text,
  version integer not null default 1,
  constraint locations_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint locations_kind_known check (kind in ('shop', 'office', 'meeting_spot')),
  constraint locations_meeting_spot_named check (kind <> 'meeting_spot' or name is not null),
  constraint locations_end_only_for_meeting_spot check (end_address is null or kind = 'meeting_spot'),
  constraint locations_travel_from_shop_or_office check (travel_miles is null or kind in ('shop', 'office')),
  constraint locations_travel_miles_positive check (travel_miles is null or travel_miles > 0),
  constraint locations_travel_parts_need_miles check (
    travel_miles is not null or (travel_centre is null and travel_fee_cents is null)
  ),
  constraint locations_travel_centre_with_address check ((travel_centre is null) = (travel_centre_address is null)),
  constraint locations_travel_fee_money check (
    (travel_fee_cents is null) = (travel_fee_currency is null)
      and (travel_fee_cents is null or travel_fee_cents >= 0)
      and (travel_fee_currency is null or travel_fee_currency ~ '^[A-Z]{3}$')
  )
);

-- A business's places for the listing page, the place pick and the travel check (B4-01, B4-77).
create index locations_business_idx on locations (business_id);
-- Distance on stored points: the travel check (B4-77) and M5's distance search (Q-25).
create index locations_map_point_idx on locations using gist (map_point);

create trigger locations_version_raised
  before update on locations
  for each row execute function enforce_version_raise();

-- Spaces and things booked by themselves (FS line 741; S1-81): customers pick a space and its size, never a person. Its
-- hours and closed days are K-27's, the services that use it K-25's, and its papers K-35's.
create table places_or_things (
  id text primary key,
  business_id text not null,
  name text not null,
  kind text not null,
  fits integer not null,
  bookable_count integer not null,
  bookable_per text not null,
  turnaround interval,
  version integer not null default 1,
  constraint places_or_things_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint places_or_things_kind_known check (kind in ('space', 'thing')),
  constraint places_or_things_fits_positive check (fits > 0),
  constraint places_or_things_bookable_not_negative check (bookable_count >= 0),
  constraint places_or_things_bookable_per_known check (bookable_per in ('slot', 'day')),
  constraint places_or_things_turnaround_positive check (turnaround is null or turnaround > interval '0')
);

-- A business's spaces and things for the place pick (A4-62) and the setup summary.
create index places_or_things_business_idx on places_or_things (business_id);

create trigger places_or_things_version_raised
  before update on places_or_things
  for each row execute function enforce_version_raise();

-- The owner's PAUSE of new bookings (S11-15) until RESUME (S11-16), one row per pause and business ('Both' is a row
-- each), with the one reminder at 8am the next day. Not core's pauses (a person, phone or address held, A3-48), and not
-- K-33's pause for an unpaid monthly bill.
create table new_booking_pauses (
  id text primary key,
  business_id text not null,
  paused_at timestamptz not null,
  paused_by_person_id text not null,
  reminded_at timestamptz,
  resumed_at timestamptz,
  resumed_by_person_id text,
  version integer not null default 1,
  constraint new_booking_pauses_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint new_booking_pauses_paused_by_fk foreign key (paused_by_person_id)
    references persons (id) on delete restrict,
  constraint new_booking_pauses_resumed_by_fk foreign key (resumed_by_person_id)
    references persons (id) on delete restrict,
  constraint new_booking_pauses_resumed_with_who check ((resumed_at is null) = (resumed_by_person_id is null)),
  constraint new_booking_pauses_times_in_order check (
    (resumed_at is null or resumed_at >= paused_at) and (reminded_at is null or reminded_at >= paused_at)
  )
);

-- One open PAUSE per business at a time (S11-15, S11-16): a partial unique index, as the table list's unique rule with
-- its where.
create unique index new_booking_pauses_one_open on new_booking_pauses (business_id) where resumed_at is null;

create trigger new_booking_pauses_version_raised
  before update on new_booking_pauses
  for each row execute function enforce_version_raise();

-- All nine are scoped by business and versioned: both roles, behind the policies below (the readers each serves are
-- named in this file's header).
grant select, insert, update on
  business_setup, flow_defaults, companies, company_kinds, business_photos, business_faqs, locations,
  places_or_things, new_booking_pauses
to rosie_app, rosie_job;

-- Row-level security: rosie_app sees only its scope; rosie_job sees everything with no scope, else only its scope.
alter table business_setup enable row level security;
create policy business_setup_tool_api on business_setup for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy business_setup_runtime on business_setup for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table flow_defaults enable row level security;
create policy flow_defaults_tool_api on flow_defaults for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy flow_defaults_runtime on flow_defaults for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table companies enable row level security;
create policy companies_tool_api on companies for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy companies_runtime on companies for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table company_kinds enable row level security;
create policy company_kinds_tool_api on company_kinds for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy company_kinds_runtime on company_kinds for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table business_photos enable row level security;
create policy business_photos_tool_api on business_photos for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy business_photos_runtime on business_photos for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table business_faqs enable row level security;
create policy business_faqs_tool_api on business_faqs for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy business_faqs_runtime on business_faqs for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table locations enable row level security;
create policy locations_tool_api on locations for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy locations_runtime on locations for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table places_or_things enable row level security;
create policy places_or_things_tool_api on places_or_things for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy places_or_things_runtime on places_or_things for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table new_booking_pauses enable row level security;
create policy new_booking_pauses_tool_api on new_booking_pauses for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy new_booking_pauses_runtime on new_booking_pauses for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );
