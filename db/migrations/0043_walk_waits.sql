-- T-1574: walk_waits, the record of a walk stopped waiting on an event (K-04 v1.3 core, frozen:
-- contracts/db-schema/core, core.v1.3.tables.json and its README's section "v1.3", rules V1 to V3, "The migration";
-- DL-1244, DL-1253). One row per waitsOnEvent stop, written by the commit of the turn whose walk stopped there and ended
-- once by the commit that walks on from the step; K-05 v1.25's readWaitingStep (item 97) reads the live row.
-- Expand only: one new table, the nine columns in the table list's order with their types and nulls and no defaults;
-- the primary key, the four foreign keys (on delete restrict, as every core key: README default 37), the two CHECKs
-- and the partial unique index walk_waits_one_live, each named as the list names it and every expression word for
-- word. The table is new and empty, so its one index is made with it here (the migration skill's concurrent build is
-- for an index on an existing table; README default 36: no other index). No version column (default 31) and so no
-- <table>_version_raised trigger: the row's one update is its end, compared on ended_at is null (rule V3). No trigger,
-- no row written, nothing dropped, renamed or retyped, and no _contract_ step after it.
--
-- Grants (rule V1; default 38): rosie_job, the runtime side that commits turns and runs item 97, may SELECT and INSERT
-- and UPDATE the two end columns only, as 0018 narrows chat_links' update to its columns; so no role but the tables'
-- owner can change a row's person, business, step, key, start time or stopping turn after it is written. rosie_app
-- gets nothing (no Tool API call reads or writes the table), and no role gets DELETE, TRUNCATE, REFERENCES or TRIGGER.
-- Row-level security (rule V2; default 39): on, with one policy, walk_waits_runtime, for rosie_job in 0012's form: with
-- no scope every row, with a scope only that business's rows, in using and with check. No _tool_api policy.
--
-- Safe to ship dark (build prompt 5.4): no code on main reads or writes walk_waits until the walk's write, the end and
-- item 97's build merge.

create table walk_waits (
  id text not null,
  business_id text not null,
  person_id text not null,
  step_id text not null,
  key text not null,
  waiting_since timestamptz not null,
  turn_id text not null,
  ended_at timestamptz,
  ended_by_turn_id text,
  constraint walk_waits_pkey primary key (id),
  constraint walk_waits_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint walk_waits_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint walk_waits_turn_fk foreign key (turn_id) references turns (id) on delete restrict,
  constraint walk_waits_ended_by_turn_fk foreign key (ended_by_turn_id) references turns (id) on delete restrict,
  -- An end comes after the stop (README default 35: strictly after, each commit stamping its own time).
  constraint walk_waits_ended_after_waiting check (ended_at is null or ended_at > waiting_since),
  -- The ending turn is named exactly when the end time is, in open_questions_closed_has_time's form.
  constraint walk_waits_ended_by_turn check ((ended_at is null) = (ended_by_turn_id is null))
);

-- One live row per person, business and step (DL-1244), in that column order so item 97's read by person and business
-- (person_id = $1 and business_id = $2 and ended_at is null) uses its leading columns and its own predicate.
create unique index walk_waits_one_live on walk_waits (person_id, business_id, step_id) where ended_at is null;

-- Rule V1: the runtime side alone; its update holds the two end columns only.
grant select, insert on walk_waits to rosie_job;
grant update (ended_at, ended_by_turn_id) on walk_waits to rosie_job;

-- Rule V2: rosie_job sees everything with no scope, else only its scope (0012's form).
alter table walk_waits enable row level security;
create policy walk_waits_runtime on walk_waits for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );
