-- T-188: turns, open questions and clock rows (K-04 v1 core, frozen: contracts/db-schema/core).
-- Expand only: three new tables with their indexes and version triggers, and the one foreign key that 0004 left for the
-- migration that creates turns. Uses enforce_version_raise() from 0002 (T-181). Nothing is dropped, renamed or retyped.
-- Row-level security is T-191's: open_questions and clock_rows are scoped by business_id with the rest of the policies
-- there; turns span businesses (a turn belongs to a handle), so they have none.
--
-- Foreign key added here to a table of 0004, because turns now exists (named in 0004's header, on a column that is null
-- or holds a turn id the code made):
--   pauses_turn_fk             pauses (set_by_turn_id)         references turns (id)        on delete restrict
--
-- The bundle keys (turns_bundle_fk, open_questions_bundle_fk) point at 0006's bundles (hash, build), as 0006's header
-- says. clock_rows_reservation_fk points at 0008's reservations. Not here: the commit and clock calls over these tables
-- (T-195, T-197), and outbox_rows with its turn key (a later migration).

-- One turn: a batch of a handle's texts, committed once under its turn id (arch 01 line 59; arch 10 line 508). The
-- primary key on the id makes a crash or a retry unable to commit a turn twice.
create table turns (
  id text primary key,
  handle_id text not null,
  event_ids text[] not null,
  state text not null,
  lease_until timestamptz,
  bundle_hash text not null,
  bundle_build integer not null,
  trace_id text not null,
  joined_trace_ids text[] not null default '{}',
  tries integer not null default 1,
  committed_at timestamptz,
  parked_at timestamptz,
  version integer not null default 1,
  constraint turns_handle_fk foreign key (handle_id) references handles (id) on delete restrict,
  constraint turns_bundle_fk foreign key (bundle_hash, bundle_build)
    references bundles (hash, build) on delete restrict,
  constraint turns_state_known check (state in ('leased', 'committed', 'parked')),
  constraint turns_has_events check (cardinality(event_ids) >= 1),
  constraint turns_leased_has_lease check (state <> 'leased' or lease_until is not null),
  constraint turns_committed_has_time check ((state = 'committed') = (committed_at is not null)),
  constraint turns_parked_has_time check ((state = 'parked') = (parked_at is not null)),
  constraint turns_tries_range check (tries between 1 and 3)
);

create index turns_handle_idx on turns (handle_id);

create trigger turns_version_raised
  before update on turns
  for each row execute function enforce_version_raise();

alter table pauses
  add constraint pauses_turn_fk foreign key (set_by_turn_id) references turns (id) on delete restrict;

-- A row per question sent (arch 01 line 63; arch 09 line 490): the step, the options as sent, the read-back an exact
-- yes binds to, the versions read, the bundle id, the clock, the ask count and the status.
create table open_questions (
  id text primary key,
  turn_id text not null,
  handle_id text not null,
  person_id text,
  business_id text,
  booking_id text,
  step text not null,
  options jsonb not null,
  readback text,
  versions_read jsonb not null,
  bundle_hash text not null,
  bundle_build integer not null,
  clock text,
  ask_count integer not null default 1,
  status text not null default 'waiting',
  answered_option_id text,
  closed_at timestamptz,
  version integer not null default 1,
  constraint open_questions_turn_fk foreign key (turn_id) references turns (id) on delete restrict,
  constraint open_questions_handle_fk foreign key (handle_id) references handles (id) on delete restrict,
  constraint open_questions_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint open_questions_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint open_questions_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint open_questions_bundle_fk foreign key (bundle_hash, bundle_build)
    references bundles (hash, build) on delete restrict,
  constraint open_questions_step_form check (step ~ '^[SAB](1[0-3]|[1-9])-x?[0-9]{2,3}$'),
  constraint open_questions_status_known check (status in ('waiting', 'open', 'answered', 'defaulted', 'withdrawn')),
  constraint open_questions_options_list check (jsonb_typeof(options) = 'array'),
  constraint open_questions_versions_list check (jsonb_typeof(versions_read) = 'array'),
  constraint open_questions_ask_count check (ask_count >= 1),
  constraint open_questions_closed_has_time check (
    (status in ('answered', 'defaulted', 'withdrawn')) = (closed_at is not null)
  ),
  constraint open_questions_answer_only_when_answered check (answered_option_id is null or status = 'answered')
);

-- The guard and the frontier list every open question sent to a handle (arch 03 line 159; arch 02 line 115).
create index open_questions_handle_live_idx on open_questions (handle_id) where status in ('waiting', 'open');
create index open_questions_booking_idx on open_questions (booking_id);

create trigger open_questions_version_raised
  before update on open_questions
  for each row execute function enforce_version_raise();

-- Every clock is a row with a due time and zone; the actor's alarm only triggers it, and the minute sweep fires missed
-- rows and rows no handle owns (arch 01 line 83; arch 10 line 540).
create table clock_rows (
  id text primary key,
  kind text not null,
  open_question_id text,
  reservation_id text,
  handle_id text,
  business_id text,
  booking_id text,
  due_at timestamptz,
  due_zone text,
  state text not null default 'waiting',
  armed_at timestamptz,
  fires jsonb not null,
  fired_at timestamptz,
  cancelled_at timestamptz,
  created_by_turn_id text,
  version integer not null default 1,
  constraint clock_rows_question_fk foreign key (open_question_id) references open_questions (id) on delete restrict,
  constraint clock_rows_reservation_fk foreign key (reservation_id) references reservations (id) on delete restrict,
  constraint clock_rows_handle_fk foreign key (handle_id) references handles (id) on delete restrict,
  constraint clock_rows_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint clock_rows_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint clock_rows_turn_fk foreign key (created_by_turn_id) references turns (id) on delete restrict,
  constraint clock_rows_kind_known check (kind in ('question', 'never_delivered', 'saved_time', 'step', 'job')),
  constraint clock_rows_state_known check (state in ('waiting', 'armed', 'fired', 'cancelled')),
  constraint clock_rows_armed_has_due check (
    state not in ('armed', 'fired') or (due_at is not null and due_zone is not null and armed_at is not null)
  ),
  constraint clock_rows_due_zone_form check (
    due_zone is null or due_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$'
  ),
  constraint clock_rows_fired_has_time check ((state = 'fired') = (fired_at is not null)),
  constraint clock_rows_cancelled_has_time check ((state = 'cancelled') = (cancelled_at is not null)),
  constraint clock_rows_question_has_question check (
    kind not in ('question', 'never_delivered') or open_question_id is not null
  ),
  constraint clock_rows_saved_time_has_reservation check (kind <> 'saved_time' or reservation_id is not null),
  constraint clock_rows_job_has_no_handle check (kind <> 'job' or handle_id is null),
  constraint clock_rows_fires_object check (jsonb_typeof(fires) = 'object')
);

-- Each actor keeps one alarm at its earliest row; the minute sweep fires missed rows and rows no handle owns.
create index clock_rows_handle_due_idx on clock_rows (handle_id, due_at) where state = 'armed';
create index clock_rows_due_idx on clock_rows (due_at) where state = 'armed';

create trigger clock_rows_version_raised
  before update on clock_rows
  for each row execute function enforce_version_raise();
