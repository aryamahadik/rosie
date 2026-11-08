-- T-187: reservations that refuse a double booking, and the class seat counter (K-04 v1 core, frozen: contracts/db-schema/core).
-- Expand only: two new tables with their indexes and version triggers. Uses enforce_version_raise() from 0002 (T-181),
-- btree_gist from 0001 (for the text `=` inside EXCLUDE), and resources and bookings from 0007 (T-186). Nothing is dropped,
-- renamed or retyped. Row-level security is T-191's: both tables are scoped by business_id with the rest of the policies there.
--
-- The database itself refuses a double booking (arch 05 line 255; arch 10 line 510):
--   reservations_no_overlap_per_resource  EXCLUDE: one worker, room or vehicle, held or booked time never overlaps (23P01)
--   reservations_no_overlap_per_worker    EXCLUDE: the same per worker person, across businesses (FS line 743)
--   class_seats_taken_within_capacity     CHECK: taken <= capacity (23514)
-- A waiting row (next in line, A4-18) and a released row are outside both EXCLUDEs; so are class sessions, since many
-- people share one session. resource_kind and worker_person_id are copies of the resource's, held to it by the composite
-- foreign keys on resources_id_kind_key and resources_id_person_key (0007), so EXCLUDE reads them from the row.
--
-- Not here: door lengths, next in line, the third saved time and the one extension are the calls' (T-198), and the saved-time
-- clock row waits for clock_rows. The foreign key for reservations_booking_fk uses bookings from 0007.

-- Class seats as a counter row: one row per class session. A reservation of a class session raises `taken` by its seats in
-- the same commit, so the database refuses a seat past capacity.
create table class_seats (
  resource_id text primary key,
  resource_kind text not null default 'class_session',
  business_id text not null,
  capacity integer not null,
  taken integer not null default 0,
  version integer not null default 1,
  constraint class_seats_resource_fk foreign key (resource_id, resource_kind)
    references resources (id, kind) on delete restrict,
  constraint class_seats_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint class_seats_kind check (resource_kind = 'class_session'),
  constraint class_seats_capacity_positive check (capacity > 0),
  constraint class_seats_taken_not_negative check (taken >= 0),
  constraint class_seats_taken_within_capacity check (taken <= capacity)
);

create trigger class_seats_version_raised
  before update on class_seats
  for each row execute function enforce_version_raise();

-- One reservation table: a resource, a time range and a state (arch 09 line 457).
create table reservations (
  id text primary key,
  business_id text not null,
  resource_id text not null,
  resource_kind text not null,
  worker_person_id text,
  during tstzrange not null,
  state text not null,
  queued_at timestamptz not null default now(),
  seats integer not null default 1,
  held_until timestamptz,
  extended boolean not null default false,
  for_phone_number text,
  for_agent_token text,
  booking_id text,
  released_at timestamptz,
  released_why text,
  version integer not null default 1,
  constraint reservations_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint reservations_resource_kind_fk foreign key (resource_id, resource_kind)
    references resources (id, kind) on delete restrict,
  constraint reservations_worker_person_fk foreign key (resource_id, worker_person_id)
    references resources (id, person_id) on delete restrict,
  constraint reservations_phone_fk foreign key (for_phone_number) references phones (number) on delete restrict,
  constraint reservations_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint reservations_no_overlap_per_resource exclude using gist (resource_id with =, during with &&)
    where (resource_kind in ('worker', 'room', 'vehicle') and state in ('held', 'booked')),
  constraint reservations_no_overlap_per_worker exclude using gist (worker_person_id with =, during with &&)
    where (worker_person_id is not null and state in ('held', 'booked')),
  constraint reservations_kind_known check (resource_kind in ('worker', 'room', 'vehicle', 'class_session')),
  constraint reservations_state_known check (state in ('held', 'waiting', 'booked', 'released')),
  constraint reservations_released_why_known check (released_why is null or released_why in ('expired', 'let_go', 'cancelled')),
  constraint reservations_worker_person check ((resource_kind = 'worker') = (worker_person_id is not null)),
  constraint reservations_seats check (seats >= 1 and (resource_kind = 'class_session' or seats = 1)),
  constraint reservations_during_bounded check (not isempty(during) and not lower_inf(during) and not upper_inf(during)),
  constraint reservations_held_has_end check (state <> 'held' or held_until is not null),
  constraint reservations_released_has_why check ((state = 'released') = (released_at is not null and released_why is not null)),
  constraint reservations_for_someone check (for_phone_number is not null or for_agent_token is not null or booking_id is not null)
);

-- Saved times that end are released (arch 05 line 247).
create index reservations_held_until_idx on reservations (held_until) where state = 'held';

-- At most 2 saved times per mobile (arch 05 line 247).
create index reservations_phone_held_idx on reservations (for_phone_number) where state = 'held';

-- Release finds the next in line: a resource's waiting rows, earliest queued_at first, then the lower id (A4-18).
create index reservations_waiting_queue_idx on reservations (resource_id, queued_at, id) where state = 'waiting';

-- A booking's reservations.
create index reservations_booking_idx on reservations (booking_id);

create trigger reservations_version_raised
  before update on reservations
  for each row execute function enforce_version_raise();
