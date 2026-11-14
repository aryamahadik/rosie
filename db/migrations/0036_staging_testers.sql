-- T-1402: staging's human testers (K-22 v1.3, frozen: contracts/db-schema/people-access, people-access.v1.3.tables.json
-- and its README's rule 10; DL-535's reading (d); DL-753's R5 (b); ADR-016 section 5 and section 7's card H; DL-757).
-- One row per listing: the person, when staging's testers' seed listed them and when the listing ended. A live listing
-- (removed_at null) makes a live session's person a tester for staging's test tools, beside the test console's member,
-- who stands by a K-36 team row (K-05 v1.15 items 68 and 69: readTesterStanding and personStanding's tester). A listed
-- person holds no team_page_recipients row, so no page to Rosie's team reaches them (build prompt 9.4), and no role.
-- Expand only: one new table with its partial unique index, its CHECK and 0002's version trigger (enforce_version_raise(),
-- T-181); grants to one of the two roles 0012 made (never created or altered here); row-level security with one policy.
-- Nothing is dropped, renamed or retyped, no row is written or removed, and no other table, grant, policy or function
-- changes: v1's, v1.1's and v1.2's tables (0020, 0034) stay as they are. Not here: the testers' seed (T-1281), which
-- writes the rows on staging alone (db/seeds/run.mjs refuses any other database), and the migration-side contract test
-- (QA's, db-schema.people-access.v1.3).
--
-- The table follows the table list word for word: 5 columns in its order, with their types, nulls and defaults; one
-- foreign key on delete restrict to K-04's persons (rule 1: no schema prefix); one partial unique index, one live listing
-- per person, by which the reads find a person's live listing; one CHECK, a listing ends no earlier than it was made.
-- It holds no address, handle, name, number or business (rule 10: the person alone).
--
-- Row-level security (rule 10; scope none: a listing names no business): on, not forced, with one policy,
-- staging_testers_runtime, for all to rosie_job, using (true) with check (true), as rule 9's on sign_in_attempts. The Tool
-- API has no policy of its own, so a grant given by mistake would still show it no row.
--
-- Grants (DL-149: each to a named reader). rosie_job, the runtime side: SELECT and INSERT, and UPDATE of removed_at and
-- version alone: K-05 v1.15's two reads read the list by person; the testers' seed, which writes as rosie_job, lists a
-- person and ends a listing, and never moves one to another person or re-dates it
-- (refuse-staging-tester-moved-to-another-person: 42501). rosie_app, the Tool API: no grant on the table at all, not even
-- a column grant, so any read or write it makes is refused (42501: refuse-staging-tester-tool-api-read,
-- refuse-staging-tester-listed-by-tool-api), whatever its business scope and person. Neither role holds DELETE (a listing
-- ends by removed_at, never by a delete), TRUNCATE, REFERENCES or TRIGGER, neither owns the table, and nothing goes to
-- PUBLIC. A listing that ended is never set live again: its writer's rule (README rule 10), since the grant on removed_at
-- allows the update; a person listed again gets a new row, which the partial unique index admits once the old one ended.

-- Staging's human testers, one row per listing (README rule 10).
create table staging_testers (
  id text primary key,
  person_id text not null,
  added_at timestamptz not null,
  removed_at timestamptz,
  version integer not null default 1,
  constraint staging_testers_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint staging_testers_removed_after_added check (removed_at is null or removed_at >= added_at)
);

-- One live listing per person: a partial unique index, as the table list's unique rule with its where. A second run of
-- the testers' seed adds nothing (refuse-staging-tester-two-live-listings: 23505), and the reads by person use it.
create unique index staging_testers_one_live_per_person on staging_testers (person_id)
  where removed_at is null;

create trigger staging_testers_version_raised
  before update on staging_testers
  for each row execute function enforce_version_raise();

-- The runtime side only (rule 10); the Tool API holds no grant on the table.
grant select, insert on staging_testers to rosie_job;
grant update (removed_at, version) on staging_testers to rosie_job;

-- Rule 10: one policy, the runtime side's, every row. None for the Tool API.
alter table staging_testers enable row level security;
create policy staging_testers_runtime on staging_testers for all to rosie_job
  using (true)
  with check (true);
