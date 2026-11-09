-- T-208: the availability part (K-27 v1, frozen: contracts/db-schema/availability, its table list and its README's rules
-- 1 to 7): weekly open hours, time off and closed days, the class timetable and its dated sessions with seats, a
-- person's one calendar link with its tokens sealed under the person's key, the businesses that read it through a
-- share, and busy blocks that hold times and never what (arch 09 line 464: 5 tables, no names; the README holds 7;
-- arch 05 lines 259 to 271; FS line 726 and rows H01 to H03, K01, K02; S1-21, S1-24, S1-38, S1-81, S1-83, S11-13,
-- S11-43 to S11-45, S12-13, S12-33; C-163).
-- Expand only: seven new tables with their indexes and three EXCLUDEs; the version trigger (enforce_version_raise() from
-- 0002, T-181) on all seven; grants to the two roles 0012 made (never created or altered here); row-level security with
-- its policies on all seven. Nothing is dropped, renamed or retyped, and no row is written or removed; no K-04, K-22,
-- K-23 or K-25 table is altered. Not here: calendar sync, its OAuth and the provider's events (the integrations
-- engineer's adapters, K-16); sealing and unsealing the tokens (T-182's db/repo/sealing.ts, on the runtime side); the
-- rules README rule 7 leaves to code (a row's location, resource, space, class and teacher are its business's; a
-- session's reservations, resource and counter move with it in one commit; a link's shares end when it is unlinked;
-- the lapse at 8:00am the day before; a busy block only for an event that counts and never for Rosie's own); the
-- migration-side contract test (QA's tests/contract/db-schema.availability.v1.test.ts, T-104).
--
-- The seven tables live beside K-04's, K-22's, K-23's and K-25's (rule 1), and their foreign keys name K-04's, K-23's and
-- K-25's tables by key (businesses.id, persons.id, resources (id, kind), locations.id, places_or_things.id,
-- services (id, business_id)) and each other, with no schema prefix, all on delete restrict. Nothing here refers to a
-- K-22 table: a link's person is K-04's persons, since an owner has no staff row. A worker's, room's, vehicle's,
-- teacher's or session's resource is held to its kind by the composite key on K-04's resources_id_kind_key, with the
-- kind column held to one value by a CHECK; a class's and a session's service to a service of the same business by
-- K-25's services_id_business_key (classes_service_fk, class_sessions_service_fk); a session's class to a class of the
-- same business (classes_id_business_key); a share's and a calendar block's person to the link's person
-- (calendar_links_id_person_key). MATCH SIMPLE: a row with no teacher, room, class or link leaves that key unchecked.
-- Ids are text, opaque strings code makes and never parses (rule 4; CQ-09), and the provider's strings (sync_cursor,
-- subscription_id, subscription_resource_id, provider_event_ref) are kept as given.
--
-- Times (README "Times and zones"): a time of day is time, read in the IANA zone its row names (time_zone); every
-- instant is timestamptz and every window a tstzrange [start, end) with the zone it is read back in. 24:00 closes a span
-- at midnight. Exclusions (rule 2): gist with = on text and smallint from btree_gist (0001, in public, which migrate.mjs
-- searches after this schema) beside && on ranges through PostgreSQL's own range_ops; weekly_hours_no_overlap compares
-- spans as tsrange(date '2000-01-03' + opens_at, date '2000-01-03' + closes_at, '[)'), an immutable expression on one
-- fixed day, so 24:00 ends the day and two spans of one owner on one day never overlap (23P01). A room or a teacher is
-- never in two scheduled sessions at once (class_sessions_one_per_room, class_sessions_one_per_teacher, 23P01).
--
-- Versions (rule 3): all seven carry a version that every update raises by exactly one (K-04 rule 2; the trigger refuses
-- any other update, 23514), compared and set by each writer; each has a one-column key a commit can name in
-- versions_read (class_sessions by resource_id, the rest by id). The runtime side's sync writes raise it too, and one
-- version covers a link's tokens and its sync marks.
--
-- Sealed field (rule 6; T-182's sealing, migration 0003 and db/repo/sealing.ts): calendar_links.tokens is bytea holding
-- only the sealed form of the provider's OAuth tokens, under the key of the person in person_id in core's sealing_keys,
-- which only the runtime side reaches; no column keeps a plain copy, so erasing the key leaves them unreadable. A link
-- has tokens only while linked or dropped (calendar_links_tokens_while_live). No grant of the Tool API reaches the
-- column, and busy_blocks has no column for a title, description, place, attendee or organizer (refused 42703).
--
-- Row-level security (arch 10 line 546; K-04 v1 rule 4; K-22 v1 rule 4's rosie.person_id; README rule 5):
--   weekly_hours, time_off, classes, class_sessions: scoped by business_id (never null here) with 0012's two policies:
--     <table>_tool_api lets rosie_app see and write only rows whose business_id equals its scope (the setting
--     rosie.business_id), and none with no scope; <table>_runtime lets rosie_job see every row with no scope, else only
--     its scope's.
--   calendar_link_shares: scoped by business_id (never null), with 0012's <table>_runtime for rosie_job and, for
--     rosie_app, one policy per command: _tool_api_select (its business's rows), _tool_api_insert and _tool_api_update,
--     the last two the README's expressions word for word (a business reads a calendar only when the calendar's own
--     person shares it, in that person's own call at that business; a business only ends its own live share and never
--     reopens one). No delete policy: no role may delete a share.
--   calendar_links: scope none (a link is a person's, across every business: FS line 743), so it has no business
--     column; row-level security is on: _tool_api_select (README rule 5 word for word) admits a link its business reads
--     through a live share, or the call's own person's link; _runtime lets rosie_job see and write every row (full
--     access, unscoped). No Tool API write policy: every write of a link is the runtime side's.
--   busy_blocks: scope none (a calendar block is its link's, with no business; a photo block has its business); row-level
--     security is on: _tool_api_select admits the business's own photo blocks and the calendar blocks of the links it
--     reads through a live share; _tool_api_insert, _update and _delete only its own photo rows (README rule 5 word for
--     word, so a calendar block written by the Tool API is refused, 42501, and its update or delete changes no row);
--     _runtime lets rosie_job see and write every row (full access, unscoped).
--   None is forced: the tables' owner (the migrations' role) is not bound. A foreign-key check runs as the owner, so a
--   share's insert checks its link without the Tool API reading the link's tokens.
--
-- Grants (DL-149: each to a named reader; README rule 5). No TRUNCATE, REFERENCES or TRIGGER, and nothing to PUBLIC.
-- Neither role owns a table.
--   rosie_job, the runtime side:
--     weekly_hours, time_off, classes, class_sessions, calendar_link_shares: SELECT, INSERT, UPDATE. K-05 commitTurn per
--       write (item 1), whose state writes admit every domain table, writes what journey 1's and journey 11's turns
--       decide (S1-21's hours kept in a turn, S1-81, S1-83's timetable and its sessions, S11-13's BLOCK, S11-43's OFF
--       and S11-44's answer; the connect's start's share under the business, README rule 5), compares rows FOR SHARE or
--       FOR UPDATE (which take UPDATE as well as SELECT), and the clock firing writes the lapse and the cutoff count
--       (K-05 fireClock); readTurnState (item 26) and the context bundle (C-114: the hours and timetable the planner
--       answers from) read them; the unlink and erasure end a link's shares (C-182; RULES 4.10). K-05's state writes
--       insert and update and remove nothing, so rosie_job deletes none of these.
--     calendar_links: SELECT, INSERT, UPDATE on every column, the tokens included (README rule 5's runtime list): the
--       connect's start (C-189 through K-05's commit: the connecting row), the connect's return (K-16 v1 connectReturn:
--       the tokens sealed, linked), the watch and renewals, calendar sync in and the 30-minute poll (C-136, C-137), the
--       fresh free/busy read (C-133) and the calendar effects (C-138, C-109), which unseal the tokens and seal each
--       refresh again, a drop and its reminder (C-182), an unlink and erasure. A link is kept as the record: no DELETE.
--     busy_blocks: SELECT, INSERT, UPDATE, DELETE: calendar sync in and the 30-minute poll write a link's blocks once,
--       rewrite a moved event's row and delete a block whose event is deleted, declined or marked free, or that has
--       ended (default 8); an unlink deletes its link's blocks and erasure the person's (C-136, C-137, C-182; open gap
--       13); K-05's commit writes a photo block per write under its business.
--   rosie_app, the Tool API, under one business's scope:
--     weekly_hours: SELECT, INSERT, UPDATE, DELETE, behind 0012's policies: S1-21's hours, S1-81's space hours, a
--       worker's own hours and Settings (S11-57) on the registration screens and the owner console (C-187, C-192,
--       through K-21), where a span no longer open is deleted (the event log keeps it); the times card and search (C-098,
--       C-131, C-133), the listing page (H01) and the Team page (S2-21) read them.
--     time_off, classes, class_sessions: SELECT, INSERT, UPDATE, behind 0012's policies, and no DELETE (42501): a window
--       is cancelled, a class set inactive, a session cancelled. The owner's BLOCK and answer, a team member's OFF
--       (S11-13, S11-43, S11-44), closed days (S1-81, Settings), the timetable (S1-83, S11-57) and a session's cancel or
--       stand-in teacher; the times card (A4-33), search, day lists and the Team page read them; and K-27's refused
--       fixture refuse-two-sessions-one-room names the Tool API inserting a session, refused by its EXCLUDE (23P01),
--       never by privilege.
--     calendar_links: SELECT of every column but tokens (column grants), of the rows its select policy admits: the Team
--       page and S2-21 (provider and state), the time finder (a connecting link takes nothing out; a dropped link's
--       person is not offered; synced_at caps the 90 days), and the person in their own call (S1-38's carry-over finds
--       the link). A read naming tokens, a search by it or select * is refused (42501; refuse-calendar-tokens-read). No
--       INSERT, UPDATE or DELETE (42501).
--     calendar_link_shares: SELECT of its business's rows (the read policies of calendar_links and busy_blocks; the Team
--       page, S2-21); INSERT of id, calendar_link_id, person_id, business_id and shared_at only (column grants: the
--       connect's start on the business's page, S1-38's carry-over), so a share starts live at version 1; UPDATE of
--       ended_at and version only (column grants: the person takes it off this business, or leaves its team, RULES 8.7).
--       No DELETE.
--     busy_blocks: SELECT, INSERT, UPDATE, DELETE, behind its policies: the times card and search, the fresh read before
--       a booking (A6-10; C-133) and the clash check (S12-33; C-181) read a person's blocks; the commit of S1-24's yes
--       writes a photo block and the owner takes one back.

-- Weekly open hours (H01; FS line 726, kind hours): one row per open span on one day of the week, for a location (its
-- opening hours), a resource (a worker's own hours, at one of the business's locations or any; a room's or vehicle's)
-- or a space or thing (S1-81), as local times read in the zone the row names.
create table weekly_hours (
  id text primary key,
  business_id text not null,
  owner_kind text not null,
  location_id text,
  resource_id text,
  resource_kind text,
  place_or_thing_id text,
  weekday smallint not null,
  opens_at time not null,
  closes_at time not null,
  time_zone text not null,
  version integer not null default 1,
  constraint weekly_hours_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint weekly_hours_location_fk foreign key (location_id) references locations (id) on delete restrict,
  constraint weekly_hours_resource_fk foreign key (resource_id, resource_kind)
    references resources (id, kind) on delete restrict,
  constraint weekly_hours_place_fk foreign key (place_or_thing_id) references places_or_things (id) on delete restrict,
  constraint weekly_hours_no_overlap exclude using gist (
    owner_kind with =,
    (coalesce(resource_id, place_or_thing_id, location_id)) with =,
    weekday with =,
    (tsrange(date '2000-01-03' + opens_at, date '2000-01-03' + closes_at, '[)')) with &&
  ),
  constraint weekly_hours_owner_kind_known check (owner_kind in ('location', 'resource', 'place')),
  constraint weekly_hours_one_owner check (
    (owner_kind = 'location' and location_id is not null and resource_id is null and place_or_thing_id is null)
      or (owner_kind = 'resource' and resource_id is not null and place_or_thing_id is null)
      or (owner_kind = 'place' and place_or_thing_id is not null and location_id is null and resource_id is null)
  ),
  constraint weekly_hours_resource_kind_known check (
    (resource_id is null) = (resource_kind is null)
      and (resource_kind is null or resource_kind in ('worker', 'room', 'vehicle'))
  ),
  constraint weekly_hours_weekday_known check (weekday between 1 and 7),
  constraint weekly_hours_span_in_order check (opens_at < closes_at),
  constraint weekly_hours_time_zone_form check (time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$')
);

-- A business's open spans for a day: the times card and search (A4-14; arch 05 line 259).
create index weekly_hours_business_day_idx on weekly_hours (business_id, weekday);
-- A worker's own hours, for the times card and the Team page (S2-21).
create index weekly_hours_resource_idx on weekly_hours (resource_id) where resource_id is not null;

create trigger weekly_hours_version_raised
  before update on weekly_hours
  for each row execute function enforce_version_raise();

-- Time off, closed days and blocked times (H02; FS line 726, kind time off): a window of instants in which the whole
-- business, a location, a resource or a space takes no new bookings, with its status (asked, ok, declined, lapsed,
-- cancelled). Only asked and ok rows take times out. No reason is kept: a reason can be a health detail (RULES 4.5).
create table time_off (
  id text primary key,
  business_id text not null,
  owner_kind text not null,
  location_id text,
  resource_id text,
  resource_kind text,
  place_or_thing_id text,
  kind text not null,
  during tstzrange not null,
  time_zone text not null,
  status text not null default 'ok',
  asked_by_person_id text not null,
  asked_at timestamptz not null,
  status_at timestamptz not null,
  status_by_person_id text,
  version integer not null default 1,
  constraint time_off_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint time_off_location_fk foreign key (location_id) references locations (id) on delete restrict,
  constraint time_off_resource_fk foreign key (resource_id, resource_kind)
    references resources (id, kind) on delete restrict,
  constraint time_off_place_fk foreign key (place_or_thing_id) references places_or_things (id) on delete restrict,
  constraint time_off_asked_by_fk foreign key (asked_by_person_id) references persons (id) on delete restrict,
  constraint time_off_status_by_fk foreign key (status_by_person_id) references persons (id) on delete restrict,
  constraint time_off_owner_kind_known check (owner_kind in ('business', 'location', 'resource', 'place')),
  constraint time_off_one_owner check (
    (owner_kind = 'business' and location_id is null and resource_id is null and place_or_thing_id is null)
      or (owner_kind = 'location' and location_id is not null and resource_id is null and place_or_thing_id is null)
      or (owner_kind = 'resource' and resource_id is not null and location_id is null and place_or_thing_id is null)
      or (owner_kind = 'place' and place_or_thing_id is not null and location_id is null and resource_id is null)
  ),
  constraint time_off_resource_kind_known check (
    (resource_id is null) = (resource_kind is null)
      and (resource_kind is null or resource_kind in ('worker', 'room', 'vehicle'))
  ),
  constraint time_off_kind_known check (kind in ('off', 'closed', 'blocked')),
  constraint time_off_kind_fits_owner check (
    (kind <> 'off' or resource_kind is not distinct from 'worker')
      and (kind <> 'closed' or resource_kind is distinct from 'worker')
  ),
  constraint time_off_status_known check (status in ('asked', 'ok', 'declined', 'lapsed', 'cancelled')),
  constraint time_off_status_by_known check ((status = 'lapsed') = (status_by_person_id is null)),
  constraint time_off_asked_is_asker check (
    status <> 'asked' or (status_by_person_id is not distinct from asked_by_person_id and status_at = asked_at)
  ),
  constraint time_off_times_in_order check (status_at >= asked_at),
  constraint time_off_window_bounded check (not isempty(during) and not lower_inf(during) and not upper_inf(during)),
  constraint time_off_time_zone_form check (time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$')
);

-- A business's windows in force over the times asked: the times card and search take them out (RULES 2.6; S11-43).
create index time_off_business_during_idx on time_off using gist (business_id, during) where status in ('asked', 'ok');
-- A person's time off, or a closed room, on the Team page (S1-83; S2-21).
create index time_off_resource_idx on time_off (resource_id) where resource_id is not null;

create trigger time_off_version_raised
  before update on time_off
  for each row execute function enforce_version_raise();

-- The class timetable (K01, K02; S1-83): one row per class that meets each week, with the service a seat sells, its day
-- and time, who teaches and the room, where it meets, the seats Rosie can book and the fewest it needs to run. Taken off
-- the timetable by active false, never deleted.
create table classes (
  id text primary key,
  business_id text not null,
  service_id text not null,
  weekday smallint not null,
  starts_at time not null,
  ends_at time not null,
  time_zone text not null,
  teacher_resource_id text,
  teacher_kind text not null default 'worker',
  room_resource_id text,
  room_kind text not null default 'room',
  location_id text,
  seats integer not null,
  minimum integer,
  active boolean not null default true,
  version integer not null default 1,
  constraint classes_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint classes_service_fk foreign key (service_id, business_id)
    references services (id, business_id) on delete restrict,
  constraint classes_teacher_fk foreign key (teacher_resource_id, teacher_kind)
    references resources (id, kind) on delete restrict,
  constraint classes_room_fk foreign key (room_resource_id, room_kind) references resources (id, kind) on delete restrict,
  constraint classes_location_fk foreign key (location_id) references locations (id) on delete restrict,
  constraint classes_id_business_key unique (id, business_id),
  constraint classes_weekday_known check (weekday between 1 and 7),
  constraint classes_times_in_order check (starts_at < ends_at),
  constraint classes_time_zone_form check (time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$'),
  constraint classes_teacher_is_worker check (teacher_kind = 'worker'),
  constraint classes_room_is_room check (room_kind = 'room'),
  constraint classes_seats_positive check (seats > 0),
  constraint classes_minimum_positive check (minimum is null or minimum >= 1)
);

-- The classes of the service a customer picked (A4-33), and the timetable read back (S1-83).
create index classes_business_service_idx on classes (business_id, service_id) where active;

create trigger classes_version_raised
  before update on classes
  for each row execute function enforce_version_raise();

-- One dated session of a class, or a one-off session such as a workshop (A4-33; S1-83): its time, teacher, room, place
-- and minimum, the count at the cutoff and whether it was called off. The session is a K-04 resources row of kind
-- class_session, whose class_seats row counts its seats and whose reservations are the seats booked or saved.
create table class_sessions (
  resource_id text primary key,
  resource_kind text not null default 'class_session',
  business_id text not null,
  class_id text,
  service_id text not null,
  during tstzrange not null,
  time_zone text not null,
  teacher_resource_id text,
  teacher_kind text not null default 'worker',
  room_resource_id text,
  room_kind text not null default 'room',
  location_id text,
  minimum integer,
  status text not null default 'scheduled',
  counted_at timestamptz,
  too_few boolean,
  cancelled_at timestamptz,
  cancelled_by_person_id text,
  version integer not null default 1,
  constraint class_sessions_resource_fk foreign key (resource_id, resource_kind)
    references resources (id, kind) on delete restrict,
  constraint class_sessions_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint class_sessions_class_fk foreign key (class_id, business_id)
    references classes (id, business_id) on delete restrict,
  constraint class_sessions_service_fk foreign key (service_id, business_id)
    references services (id, business_id) on delete restrict,
  constraint class_sessions_teacher_fk foreign key (teacher_resource_id, teacher_kind)
    references resources (id, kind) on delete restrict,
  constraint class_sessions_room_fk foreign key (room_resource_id, room_kind)
    references resources (id, kind) on delete restrict,
  constraint class_sessions_location_fk foreign key (location_id) references locations (id) on delete restrict,
  constraint class_sessions_cancelled_by_fk foreign key (cancelled_by_person_id)
    references persons (id) on delete restrict,
  constraint class_sessions_one_per_room exclude using gist (
    room_resource_id with =,
    during with &&
  ) where (status = 'scheduled' and room_resource_id is not null),
  constraint class_sessions_one_per_teacher exclude using gist (
    teacher_resource_id with =,
    during with &&
  ) where (status = 'scheduled' and teacher_resource_id is not null),
  constraint class_sessions_kind check (resource_kind = 'class_session'),
  constraint class_sessions_teacher_is_worker check (teacher_kind = 'worker'),
  constraint class_sessions_room_is_room check (room_kind = 'room'),
  constraint class_sessions_status_known check (status in ('scheduled', 'cancelled')),
  constraint class_sessions_during_bounded check (
    not isempty(during) and not lower_inf(during) and not upper_inf(during)
  ),
  constraint class_sessions_time_zone_form check (time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$'),
  constraint class_sessions_minimum_positive check (minimum is null or minimum >= 1),
  constraint class_sessions_counted_whole check (
    (counted_at is null) = (too_few is null) and (counted_at is null or counted_at < lower(during))
  ),
  constraint class_sessions_cancelled_has_time check (
    (status = 'cancelled') = (cancelled_at is not null) and (cancelled_at is null) = (cancelled_by_person_id is null)
  )
);

-- A service's sessions, soonest first, for the times card (A4-33).
create index class_sessions_service_idx on class_sessions (service_id, during) where status = 'scheduled';
-- A class's sessions, when sessions are made from the timetable or the class changes (S1-83; S11-57).
create index class_sessions_class_idx on class_sessions (class_id) where class_id is not null;

create trigger class_sessions_version_raised
  before update on class_sessions
  for each row execute function enforce_version_raise();

-- A person's own calendar linked to Rosie (H03; S1-24; S2-06): Google or Microsoft, busy times only; one live link per
-- person across every business, read by each business through its own share. The provider, the state (connecting,
-- linked, dropped, unlinked), the sync marks, and the OAuth tokens sealed under the person's key.
create table calendar_links (
  id text primary key,
  person_id text not null,
  provider text not null,
  state text not null default 'connecting',
  tokens bytea,
  linked_at timestamptz,
  sync_cursor text,
  synced_at timestamptz,
  subscription_id text,
  subscription_resource_id text,
  subscribed_at timestamptz,
  subscription_expires_at timestamptz,
  dropped_at timestamptz,
  dropped_why text,
  drop_reminded_at timestamptz,
  unlinked_at timestamptz,
  version integer not null default 1,
  constraint calendar_links_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint calendar_links_id_person_key unique (id, person_id),
  constraint calendar_links_provider_known check (provider in ('google', 'microsoft')),
  constraint calendar_links_state_known check (state in ('connecting', 'linked', 'dropped', 'unlinked')),
  constraint calendar_links_tokens_while_live check ((state in ('linked', 'dropped')) = (tokens is not null)),
  constraint calendar_links_linked_has_time check (
    (state <> 'connecting' or linked_at is null) and (state not in ('linked', 'dropped') or linked_at is not null)
  ),
  constraint calendar_links_connecting_unread check (
    state <> 'connecting' or (sync_cursor is null and synced_at is null and subscription_id is null)
  ),
  constraint calendar_links_dropped_has_time check (
    (state = 'dropped') = (dropped_at is not null)
      and (dropped_at is null) = (dropped_why is null)
      and (dropped_why is null or dropped_why in ('renewal_failed', 'access_refused'))
  ),
  constraint calendar_links_reminded_while_dropped check (
    drop_reminded_at is null or (state = 'dropped' and drop_reminded_at >= dropped_at)
  ),
  constraint calendar_links_unlinked_has_time check ((state = 'unlinked') = (unlinked_at is not null)),
  constraint calendar_links_subscription_whole check (
    (subscription_id is null) = (subscribed_at is null)
      and (subscription_id is null) = (subscription_expires_at is null)
      and (subscription_resource_id is null or subscription_id is not null)
      and (subscription_expires_at is null or subscription_expires_at > subscribed_at)
      and (state <> 'unlinked' or subscription_id is null)
  ),
  constraint calendar_links_times_in_order check (
    (dropped_at is null or dropped_at >= linked_at)
      and (unlinked_at is null or unlinked_at >= linked_at)
      and (synced_at is null or synced_at >= linked_at)
  )
);

-- One live link per person (FS row H03; FS line 743; S1-24), and a notification finds its one link by its channel or
-- subscription (arch 05 line 261): partial unique indexes, as the table list's unique rules with their where.
create unique index calendar_links_one_live_per_person on calendar_links (person_id) where state <> 'unlinked';
create unique index calendar_links_subscription_key on calendar_links (provider, subscription_id)
  where subscription_id is not null;
-- The links whose subscription nears half its life, for renewal (arch 05 line 271).
create index calendar_links_renewal_idx on calendar_links (subscription_expires_at)
  where state = 'linked' and subscription_id is not null;
-- A person's links, live and unlinked: S1-38's carry-over finds the live one, erasure finds them all.
create index calendar_links_person_idx on calendar_links (person_id);

create trigger calendar_links_version_raised
  before update on calendar_links
  for each row execute function enforce_version_raise();

-- A business that reads a person's link: one row per link and business while it reads it (S1-24; S1-38's carry-over),
-- seeing only free or busy through it. Ended, never deleted or reopened (RULES 8.7).
create table calendar_link_shares (
  id text primary key,
  calendar_link_id text not null,
  person_id text not null,
  business_id text not null,
  shared_at timestamptz not null,
  ended_at timestamptz,
  version integer not null default 1,
  constraint calendar_link_shares_link_fk foreign key (calendar_link_id, person_id)
    references calendar_links (id, person_id) on delete restrict,
  constraint calendar_link_shares_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint calendar_link_shares_times_in_order check (ended_at is null or ended_at >= shared_at)
);

-- A business reads one calendar per person (S1-24; FS line 743): a partial unique index, as the table list's unique
-- rule with its where.
create unique index calendar_link_shares_one_per_person on calendar_link_shares (business_id, person_id)
  where ended_at is null;
-- The businesses that read a link: the read policies of calendar_links and busy_blocks, and a drop told to each
-- business's owner (S12-13; C-182).
create index calendar_link_shares_link_idx on calendar_link_shares (calendar_link_id) where ended_at is null;

create trigger calendar_link_shares_version_raised
  before update on calendar_link_shares
  for each row execute function enforce_version_raise();

-- When a person is busy, never what (S1-24; arch 05 line 261): start, end and source only. A calendar block is its
-- link's, written once however many businesses read the link; a photo block is its business's, written only on the
-- owner's yes (limit 6). No column for a title, description, place, attendee or organizer.
create table busy_blocks (
  id text primary key,
  business_id text,
  person_id text not null,
  source text not null,
  calendar_link_id text,
  provider_event_ref text,
  during tstzrange not null,
  time_zone text not null,
  confirmed_at timestamptz,
  confirmed_by_person_id text,
  version integer not null default 1,
  constraint busy_blocks_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint busy_blocks_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint busy_blocks_link_fk foreign key (calendar_link_id, person_id)
    references calendar_links (id, person_id) on delete restrict,
  constraint busy_blocks_confirmed_by_fk foreign key (confirmed_by_person_id)
    references persons (id) on delete restrict,
  constraint busy_blocks_source_known check (source in ('calendar', 'photo')),
  constraint busy_blocks_source_fields check (
    (
      source = 'calendar' and business_id is null and calendar_link_id is not null and provider_event_ref is not null
        and confirmed_at is null and confirmed_by_person_id is null
    ) or (
      source = 'photo' and business_id is not null and calendar_link_id is null and provider_event_ref is null
        and confirmed_at is not null and confirmed_by_person_id is not null
    )
  ),
  constraint busy_blocks_during_bounded check (not isempty(during) and not lower_inf(during) and not upper_inf(during)),
  constraint busy_blocks_time_zone_form check (time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$')
);

-- One block per event, repeats expanded (arch 05 line 265): a repeated or late notification rewrites the same row. A
-- partial unique index, as the table list's unique rule with its where.
create unique index busy_blocks_event_key on busy_blocks (calendar_link_id, provider_event_ref)
  where source = 'calendar';
-- A person's blocks over the times asked: the times card, search and the fresh read before a booking (A6-10).
create index busy_blocks_person_during_idx on busy_blocks using gist (person_id, during);
-- A link's blocks: the read policy through its shares, a full read replacing them, their delete at an unlink.
create index busy_blocks_link_idx on busy_blocks (calendar_link_id) where calendar_link_id is not null;

create trigger busy_blocks_version_raised
  before update on busy_blocks
  for each row execute function enforce_version_raise();

-- Grants (the readers each serves are named in this file's header).
-- Business-scoped, versioned: both roles, behind the policies below; the Tool API alone deletes a span (rule 5).
grant select, insert, update on weekly_hours, time_off, classes, class_sessions to rosie_app, rosie_job;
grant delete on weekly_hours to rosie_app;
-- A link: the runtime side in full, the tokens included; the Tool API reads every column but the tokens (rule 5).
grant select, insert, update on calendar_links to rosie_job;
grant
  select (
    id, person_id, provider, state, linked_at, sync_cursor, synced_at, subscription_id, subscription_resource_id,
    subscribed_at, subscription_expires_at, dropped_at, dropped_why, drop_reminded_at, unlinked_at, version
  )
on calendar_links to rosie_app;
-- A share: the runtime side in full; the Tool API reads its business's, starts one live at version 1 and ends it.
grant select, insert, update on calendar_link_shares to rosie_job;
grant
  select,
  insert (id, calendar_link_id, person_id, business_id, shared_at),
  update (ended_at, version)
on calendar_link_shares to rosie_app;
-- Busy blocks: both roles, behind the policies below (the Tool API's writes only its own photo rows).
grant select, insert, update, delete on busy_blocks to rosie_app, rosie_job;

-- Row-level security on the four business-scoped tables of 0012's pattern: rosie_app sees only its scope; rosie_job sees
-- everything with no scope, else only its scope.
alter table weekly_hours enable row level security;
create policy weekly_hours_tool_api on weekly_hours for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy weekly_hours_runtime on weekly_hours for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table time_off enable row level security;
create policy time_off_tool_api on time_off for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy time_off_runtime on time_off for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table classes enable row level security;
create policy classes_tool_api on classes for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy classes_runtime on classes for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table class_sessions enable row level security;
create policy class_sessions_tool_api on class_sessions for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy class_sessions_runtime on class_sessions for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

-- Rule 5: shares, scoped by business. Its own business's shares are read; one is started only by the calendar's own
-- person, in that person's own call at that business; a live one of its own business is ended, never reopened. The
-- runtime side: 0012's policy.
alter table calendar_link_shares enable row level security;
create policy calendar_link_shares_tool_api_select on calendar_link_shares for select to rosie_app
  using (business_id = current_setting('rosie.business_id', true));
create policy calendar_link_shares_tool_api_insert on calendar_link_shares for insert to rosie_app
  with check (
    business_id = current_setting('rosie.business_id', true)
    and person_id = nullif(current_setting('rosie.person_id', true), '')
  );
create policy calendar_link_shares_tool_api_update on calendar_link_shares for update to rosie_app
  using (business_id = current_setting('rosie.business_id', true) and ended_at is null)
  with check (business_id = current_setting('rosie.business_id', true) and ended_at is not null);
create policy calendar_link_shares_runtime on calendar_link_shares for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

-- Rule 5: links, a person's (scope none). The Tool API reads a link its business reads through a live share, or the
-- call's own person's link, and writes none. The runtime side: every row.
alter table calendar_links enable row level security;
create policy calendar_links_tool_api_select on calendar_links for select to rosie_app
  using (
    exists (
      select 1 from calendar_link_shares s
      where s.calendar_link_id = calendar_links.id
        and s.business_id = current_setting('rosie.business_id', true)
        and s.ended_at is null
    )
    or person_id = nullif(current_setting('rosie.person_id', true), '')
  );
create policy calendar_links_runtime on calendar_links for all to rosie_job
  using (true)
  with check (true);

-- Rule 5: busy blocks (scope none). The Tool API reads its own photo blocks and the calendar blocks of the links it
-- reads through a live share, and writes only its own photo rows. The runtime side: every row.
alter table busy_blocks enable row level security;
create policy busy_blocks_tool_api_select on busy_blocks for select to rosie_app
  using (
    (source = 'photo' and business_id = current_setting('rosie.business_id', true))
    or (
      source = 'calendar'
      and exists (
        select 1 from calendar_link_shares s
        where s.calendar_link_id = busy_blocks.calendar_link_id
          and s.business_id = current_setting('rosie.business_id', true)
          and s.ended_at is null
      )
    )
  );
create policy busy_blocks_tool_api_insert on busy_blocks for insert to rosie_app
  with check (business_id = current_setting('rosie.business_id', true) and source = 'photo');
create policy busy_blocks_tool_api_update on busy_blocks for update to rosie_app
  using (business_id = current_setting('rosie.business_id', true) and source = 'photo')
  with check (business_id = current_setting('rosie.business_id', true) and source = 'photo');
create policy busy_blocks_tool_api_delete on busy_blocks for delete to rosie_app
  using (business_id = current_setting('rosie.business_id', true) and source = 'photo');
create policy busy_blocks_runtime on busy_blocks for all to rosie_job
  using (true)
  with check (true);
