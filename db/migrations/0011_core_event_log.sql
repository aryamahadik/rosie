-- T-190: the event log (K-04 v1 core, frozen: contracts/db-schema/core; kinds and fields from K-08 v1.1).
-- Expand only: one new table with its indexes, and one trigger function that refuses edits. Nothing is dropped, renamed
-- or retyped. Row-level security is T-191's: event_log is scoped by business_id with the rest of the policies there (a
-- row whose business_id is null is seen by no business scope, K-04 rule 4).
--
-- Foreign keys: turn, business, actor person and sealed-for person, all on delete restrict, as the table list names
-- them. The bundle pair carries no key (the table list gives none; K-08 writes the bundle id of the turn as it was).
-- The kind is free text with no CHECK: K-08 v1.1 says K-04's event_log.kind needs no migration for a new kind, and the
-- closed list is held by the contract tests and the code that writes it.
--
-- The log is never edited (K-04 rule 5; arch 09 lines 457, 492). The rule says the application roles hold insert and
-- select only, so an update or delete is refused with SQLSTATE 42501 (insufficient_privilege). The roles and their grants
-- come with row-level security (T-191); until then the same refusal is made here by a trigger on every role, the table's
-- owner included, so the table cannot be edited whichever way a later grant is written. UPDATE and DELETE on it raise
-- 42501 and name the table, never a value. Update and delete are the two statements the table list names; erasure of a
-- person deletes their key in sealing_keys (RULES 4.10), never a log row. Update and delete rights are also taken from
-- PUBLIC, so a later role gets none by default.
--
-- Private old and new values go sealed into sealed_values, one person per row (sealed_for_person_id), by
-- db/repo/sealing.ts (T-182); the plain old_values and new_values leave private fields out. Consent proofs (hashes and
-- the words shown) sit in proofs and stay readable after the person's key is deleted.

-- One entry of the log: who, what, old and new, when, why, approved by. Every row carries the turn or the job id, the
-- trace id and the bundle id (the bundle's two columns are null for a write outside a turn).
create table event_log (
  id text primary key,
  at timestamptz not null default now(),
  zone text,
  turn_id text,
  job_id text,
  trace_id text not null,
  bundle_hash text,
  bundle_build integer,
  business_id text,
  actor_kind text not null,
  actor_person_id text,
  actor_role text,
  kind text not null,
  table_name text,
  row_id text,
  old_values jsonb,
  new_values jsonb,
  sealed_values bytea,
  sealed_for_person_id text,
  why jsonb,
  approved_by jsonb,
  proofs jsonb,
  constraint event_log_turn_fk foreign key (turn_id) references turns (id) on delete restrict,
  constraint event_log_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint event_log_actor_fk foreign key (actor_person_id) references persons (id) on delete restrict,
  constraint event_log_sealed_for_fk foreign key (sealed_for_person_id) references persons (id) on delete restrict,
  constraint event_log_actor_kind_known check (actor_kind in ('person', 'rosie', 'job', 'provider')),
  constraint event_log_turn_or_job check (turn_id is not null or job_id is not null),
  constraint event_log_person_actor check (actor_kind <> 'person' or actor_person_id is not null),
  constraint event_log_sealed_has_person check (sealed_values is null or sealed_for_person_id is not null),
  constraint event_log_bundle_pair check ((bundle_hash is null) = (bundle_build is null))
);

-- A business's history.
create index event_log_business_at_idx on event_log (business_id, at);
-- Everything one turn wrote (tour line 416).
create index event_log_turn_idx on event_log (turn_id);
-- One row's history.
create index event_log_row_idx on event_log (table_name, row_id);

-- Never edited: an update or a delete is an insufficient privilege (K-04 rule 5), whoever runs it.
create function event_log_refuse_edit() returns trigger
language plpgsql
as $$
begin
  raise exception '% on % is not allowed: the event log is never edited', tg_op, tg_table_name
    using errcode = 'insufficient_privilege',
          table = tg_table_name;
end;
$$;

create trigger event_log_never_edited
  before update or delete on event_log
  for each row execute function event_log_refuse_edit();

revoke update, delete on event_log from public;
