-- T-211: the customers part (K-28 v1, frozen: contracts/db-schema/customers, its table list and its README's rules 1
-- to 7): a business's record of one customer, per business and person (FS line 727: the name the business has on file,
-- the mobile and the optional email on file as K-04 handles, the way they are reached, their contact preferences, their
-- age band and the owner's fee-free mark), and a business's block of one person by their number or by their address
-- for home visits, with its lift (S11-62) (arch 09 line 465: 7 tables, no names; K-04 already holds the person, the
-- roles, the handles, the phones and the pauses, so this part holds 2; MC C2; Q-07; C-164).
-- Expand only: two new tables with their indexes; the version trigger (enforce_version_raise() from 0002, T-181) on
-- both; grants to the two roles 0012 made (never created or altered here); row-level security switched on with 0012's
-- two policies on both. Nothing is dropped, renamed or retyped, and no row is written or removed; no K-04, K-23 or K-29
-- table is altered. Not here: bookings (K-30, journey 3's); the Tool API's calls that find or add a customer by mobile,
-- change the contact on file and block or lift (C-074, C-094, C-105); sealing and unsealing (T-182's
-- db/repo/sealing.ts); the rules README rule 7 leaves to code (a customer row comes with a live K-04 person_roles row of
-- role customer for the same person and business, written in the same commit; email_handle_id names a handle of kind
-- email, since K-04 v1 gives handles no key on its kind; a mobile is required when the customer or their own AI books,
-- checked by the reach card's call, since a customer the business books may have none; a new booking's mobile, and in
-- flow B its address, are checked against the business's open blocks before anything is saved); the migration-side
-- contract test (QA's tests/contract/db-schema.customers.v1.test.ts, T-105).
--
-- The two tables live beside K-04's (rule 1), and their foreign keys name K-04's tables by key (businesses.id,
-- persons.id, phones.handle_id, person_handles (person_id, handle_id), turns.id), with no schema prefix, all on delete
-- restrict. No table here refers to K-23 or K-29, and none of theirs to these. A customer's mobile is the handle of a
-- K-04 phones row and one of their own handles (customers_mobile_phone_fk, customers_mobile_own_fk), and their email one
-- of their own handles (customers_email_own_fk); a number block's handle is the same (customer_blocks_phone_fk,
-- customer_blocks_phone_own_fk). So neither table holds a phone number or an email address: those are the K-04
-- handle's. A block names the business and the person, never a customer row (default 11), so Sam may block a
-- first-time sender who booked nothing, and a block adds no customer row or customer role. MATCH SIMPLE: a row with no
-- mobile, email, number, turn or lift leaves that key unchecked. Ids are text, opaque strings code makes and never
-- parses (rule 3; CQ-09); every time is timestamptz, an instant in UTC.
--
-- The contact on file and the way (A4-82, B4-93; S13-19; MC C2; Q-07): a person has at most one record at a business
-- (customers_business_person_key; RULES 4.10: a business's record is never joined across businesses, so a customer of
-- two businesses has two rows). The way is texts, textsonly or email, spelt as K-01 v1's bookingValues.reach; calls
-- only is not offered (customers_way_known, 23514), and the way fits the contact on file (customers_way_fits_contact):
-- texts and textsonly need the mobile, email needs the email, and a record with no contact has no way. The age band is
-- 18_or_older or under_18, never an exact age (customers_age_band_known; A4-80).
--
-- Blocks (S11-62): by number (the person's own mobile handle) or by address (sealed, below), never both
-- (customer_blocks_one_target). A number has at most one open block per business (customer_blocks_one_open_number, a
-- partial unique index, 23505); an address is sealed, so code unseals the business's open address blocks
-- (customer_blocks_open_address_idx) and compares them. Lifting sets lifted_at and who, together; the row stays, so
-- Rosie's team sees each block, lifted or not. A block is not a K-04 pause: a pause holds visits, a block refuses new
-- bookings.
--
-- Sealed field (rule 6; T-182's sealing, migration 0003 and db/repo/sealing.ts): customer_blocks.address is bytea
-- holding only the sealed form of the street address for home visits, under the key of the row's person_id in core's
-- sealing_keys, as K-04's pauses.address; no column keeps a plain copy, so deleting the person's key erases it.
-- customers.name and contact_times are plain, as K-04's persons.name (K-04 v1 README, "Erasure of plain columns"; CQ-26's
-- default): the 45-day delete redacts or deletes them.
--
-- Versions (rule 2): both are updated (a contact switched, the way or preferences changed, fee-free marked, a block
-- lifted), so each carries a version that every update raises by exactly one (K-04 rule 2; the trigger refuses any other
-- update, 23514), compared and set by a commit, with a one-column key (id) a commit can name in versions_read.
--
-- Row-level security (arch 10 line 546; K-04 v1 rule 4; README rule 4): both are scoped by business, on business_id
-- (never null here), with 0012's two policies: <table>_tool_api lets rosie_app see and write only rows whose business_id
-- equals its scope (the setting rosie.business_id), and none with no scope, so one business never reads another's
-- record of the same person; <table>_runtime lets rosie_job see every row with no scope (the jobs that work by person
-- or handle), else only its scope's. None is forced: the tables' owner (the migrations' role) is not bound. A
-- foreign-key check runs as the owner, so a row's person, handle, phone and turn are checked without row-level
-- security and without the Tool API holding any grant on K-04's handles or phones.
--
-- Grants (DL-149: each to a named reader; README rule 5, the same for both application roles). SELECT, INSERT and
-- UPDATE on both tables, as table grants, with no column grant. No DELETE (42501: a lifted block keeps its row, S11-62;
-- records are kept, RULES 4.10), TRUNCATE, REFERENCES or TRIGGER, and nothing to PUBLIC. Neither role owns a table.
--   rosie_app, the Tool API, under one business's scope, behind 0012's policies:
--     customers: journey 3's Tool API calls (C-074; K-09 v1.1: find or add the customer by mobile, the reach card's way
--       and contact, the owner's read-back of a booking the business adds) write the record once booked (A4-23) and
--       read it; identity and access (C-094: the contact on file and the one proof rule; D75, D77, D100) switches the
--       contact; the Agent API (C-110: the name and number an AI sends); the slot filler and the claim check (C-088,
--       C-091: reach.way and reach.to, each field's audience, the age band); K-26's own-customers rule (C-082); bookings
--       and quotes (C-099); the page calls behind the customer booking screens 2 and 3 (C-198), screen 21 (C-201) and
--       the owner console's Customers page (C-192: mark fee-free), through K-21. The update grant serves a contact
--       switched, the way or preferences changed, fee-free marked, and the version every commit compares and sets.
--     customer_blocks: block and pause (C-105; S11-62: Sam blocks a number, or an address for home visits, by telling
--       the AI) and the owner console's Customers page (C-192, through K-21: block a number or an address, lift it)
--       write a block and its lift; the Agent API, the booking page and bookings (C-110, C-099) read the business's
--       open blocks before a new booking is saved, and the read-back of a block reads a person's blocks. The update
--       grant serves the lift and the version.
--   rosie_job, the runtime side, behind 0012's policies: K-05 commitTurn per write (item 1), whose state writes admit
--     every domain table, writes what a turn decides on these two as the Tool API does above (a customer added once
--     booked, a contact switched, a block set or lifted in the owner's chat), and compares rows FOR SHARE or FOR UPDATE
--     (which take UPDATE as well as SELECT); readTurnState (item 26) reads them; the outbox dispatcher (C-124) reads
--     each customer's way, an email on file getting every message; the 45-day copy or delete reads a person's records
--     across businesses, unscoped (C-156; RULES 4.10), and the reassigned-numbers check reads them by handle (RULES
--     6.5).

-- A business's record of one customer (FS line 727), per business and person: the name this business has on file, the
-- mobile and the optional email on file as K-04 handles, the way they are reached, their contact preferences, their age
-- band, the owner's fee-free mark and when the list gained them. Never deleted by either application role.
create table customers (
  id text primary key,
  business_id text not null,
  person_id text not null,
  name text not null,
  mobile_handle_id text,
  email_handle_id text,
  way text,
  contact_times text,
  first_name_only boolean not null default false,
  no_voicemail boolean not null default false,
  age_band text,
  fee_free boolean not null default false,
  added_at timestamptz not null default now(),
  version integer not null default 1,
  constraint customers_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint customers_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint customers_mobile_phone_fk foreign key (mobile_handle_id) references phones (handle_id) on delete restrict,
  constraint customers_mobile_own_fk foreign key (person_id, mobile_handle_id)
    references person_handles (person_id, handle_id) on delete restrict,
  constraint customers_email_own_fk foreign key (person_id, email_handle_id)
    references person_handles (person_id, handle_id) on delete restrict,
  constraint customers_business_person_key unique (business_id, person_id),
  constraint customers_way_known check (way is null or way in ('texts', 'textsonly', 'email')),
  constraint customers_way_fits_contact check (
    ((way is null) = (mobile_handle_id is null and email_handle_id is null))
      and (way <> 'email' or email_handle_id is not null)
      and (way not in ('texts', 'textsonly') or mobile_handle_id is not null)
  ),
  constraint customers_age_band_known check (age_band is null or age_band in ('under_18', '18_or_older')),
  constraint customers_name_given check (length(btrim(name)) > 0),
  constraint customers_contact_times_given check (contact_times is null or length(btrim(contact_times)) > 0)
);

-- The business's record on file for a proven mobile (S13-45; K-09 v1.1, journey 3: find or add the customer by
-- mobile), and K-26's own-customers rule (FS K10).
create index customers_mobile_idx on customers (business_id, mobile_handle_id) where mobile_handle_id is not null;
-- The business's record on file for a proven email (S13-45; RULES 9.2b).
create index customers_email_idx on customers (business_id, email_handle_id) where email_handle_id is not null;
-- A person's records, for the runtime side's jobs that work by person, such as the 45-day copy or delete (RULES 4.10).
create index customers_person_idx on customers (person_id);

create trigger customers_version_raised
  before update on customers
  for each row execute function enforce_version_raise();

-- A business's block of one person (S11-62; FS line 727, blocked; FS section 6.2, Customers): by their number, or by
-- their address for home visits, sealed under their key; who set it and when, from the AI (a turn) or the portal; and
-- its lift. While it holds, a new booking that gives that number or address hears only that the business can't take
-- it, with no reason. One row per block; lifting keeps the row.
create table customer_blocks (
  id text primary key,
  business_id text not null,
  person_id text not null,
  target text not null,
  phone_handle_id text,
  address bytea,
  set_at timestamptz not null,
  set_by_person_id text not null,
  set_by_turn_id text,
  lifted_at timestamptz,
  lifted_by_person_id text,
  version integer not null default 1,
  constraint customer_blocks_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint customer_blocks_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint customer_blocks_phone_fk foreign key (phone_handle_id) references phones (handle_id) on delete restrict,
  constraint customer_blocks_phone_own_fk foreign key (person_id, phone_handle_id)
    references person_handles (person_id, handle_id) on delete restrict,
  constraint customer_blocks_set_by_fk foreign key (set_by_person_id) references persons (id) on delete restrict,
  constraint customer_blocks_turn_fk foreign key (set_by_turn_id) references turns (id) on delete restrict,
  constraint customer_blocks_lifted_by_fk foreign key (lifted_by_person_id) references persons (id) on delete restrict,
  constraint customer_blocks_target_known check (target in ('number', 'address')),
  constraint customer_blocks_one_target check (
    (target <> 'number' or (phone_handle_id is not null and address is null))
      and (target <> 'address' or (address is not null and phone_handle_id is null))
  ),
  constraint customer_blocks_lifted_together check ((lifted_at is null) = (lifted_by_person_id is null)),
  constraint customer_blocks_lifted_after_set check (lifted_at is null or lifted_at >= set_at)
);

-- A number is blocked at a business, or it is not (S11-62): at most one open block per number and business, a partial
-- unique index, as the table list's unique rule with its where. An address block has no number, so it never collides.
create unique index customer_blocks_one_open_number on customer_blocks (business_id, phone_handle_id)
  where lifted_at is null;
-- A person's blocks at a business, for the Customers page and the read-back that names any plan, membership or credits
-- a block ends (S11-62).
create index customer_blocks_customer_idx on customer_blocks (business_id, person_id);
-- A flow B booking's address is checked against the business's open address blocks (S11-62).
create index customer_blocks_open_address_idx on customer_blocks (business_id)
  where target = 'address' and lifted_at is null;

create trigger customer_blocks_version_raised
  before update on customer_blocks
  for each row execute function enforce_version_raise();

-- Grants (rule 5; the readers each serves are named in this file's header): the same for both application roles, as
-- table grants. No delete.
grant select, insert, update on customers, customer_blocks to rosie_app, rosie_job;

-- Row-level security on the two business-scoped tables: rosie_app sees only its scope; rosie_job sees everything with no
-- scope, else only its scope.
alter table customers enable row level security;
create policy customers_tool_api on customers for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy customers_runtime on customers for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table customer_blocks enable row level security;
create policy customer_blocks_tool_api on customer_blocks for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy customer_blocks_runtime on customer_blocks for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );
