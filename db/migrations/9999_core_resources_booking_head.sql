-- T-186: bookable resources and the booking head row (K-04 v1 core, frozen: contracts/db-schema/core).
-- Expand only: two new tables with their indexes and version triggers, and the two foreign keys that 0005 left for the
-- migration that creates bookings. Uses enforce_version_raise() from 0002 (T-181). Nothing is dropped, renamed or retyped.
-- Row-level security is T-191's: resources and bookings are scoped by business_id with the rest of the policies there.
--
-- Foreign keys added here to tables of 0005, because bookings now exists (named in 0005's header, on columns that are
-- null or hold an id the code made):
--   threads_booking_fk         threads (booking_id)            references bookings (id)     on delete restrict
--   messages_booking_fk        messages (booking_id)           references bookings (id)     on delete restrict
--
-- Not here: reservations and class_seats (they refer to resources), and the rest of the booking (K-30). The two
-- foreign keys that still wait for outbox_rows (openers_sent_outbox_fk, messages_outbox_fk) are left to its migration.

-- Bookable resources: a worker, a room, a vehicle or a class session (CQ-03).
create table resources (
  id text primary key,
  business_id text not null,
  kind text not null,
  name text not null,
  person_id text,
  active boolean not null default true,
  version integer not null default 1,
  constraint resources_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint resources_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint resources_id_kind_key unique (id, kind),
  constraint resources_id_person_key unique (id, person_id),
  constraint resources_kind_known check (kind in ('worker', 'room', 'vehicle', 'class_session')),
  constraint resources_worker_is_person check ((kind = 'worker') = (person_id is not null))
);

create trigger resources_version_raised
  before update on resources
  for each row execute function enforce_version_raise();

-- The booking head row (CQ-03): who booked, who is served and who pays are three separate references.
create table bookings (
  id text primary key,
  business_id text not null,
  flow text not null,
  stage text not null default 'entry',
  booker_person_id text not null,
  served_person_id text,
  payer_person_id text,
  private boolean not null default false,
  deceased boolean not null default false,
  version integer not null default 1,
  constraint bookings_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint bookings_booker_fk foreign key (booker_person_id) references persons (id) on delete restrict,
  constraint bookings_served_fk foreign key (served_person_id) references persons (id) on delete restrict,
  constraint bookings_payer_fk foreign key (payer_person_id) references persons (id) on delete restrict,
  constraint bookings_flow_known check (flow in ('A', 'B')),
  constraint bookings_stage_known check (stage in ('entry', 'booked', 'checked_in', 'done', 'cancelled'))
);

create index bookings_business_stage_idx on bookings (business_id, stage);
create index bookings_booker_idx on bookings (booker_person_id);
create index bookings_served_idx on bookings (served_person_id);

create trigger bookings_version_raised
  before update on bookings
  for each row execute function enforce_version_raise();

alter table threads
  add constraint threads_booking_fk foreign key (booking_id) references bookings (id) on delete restrict;

alter table messages
  add constraint messages_booking_fk foreign key (booking_id) references bookings (id) on delete restrict;
