-- T-580: the safety and incidents part (K-34 v1, frozen: contracts/db-schema/safety-incidents): the safety read's
-- outcome for each text, with the person's words sealed; what an outcome holds and its release; harm reports Rosie's
-- team follows up that day; check-out timers for a pro working alone; and privacy slips (arch 06 lines 315 to 329;
-- arch 11 line 566; A3-22 to A3-26, A3-48 to A3-50; B3-17; B8-86; S13-10; S12-29 to S12-31).
-- Expand only: five new tables with their indexes; the version trigger (enforce_version_raise() from 0002, T-181) on
-- the four that are updated; grants to the two roles 0012 made (never created or altered here); row-level security
-- switched on with 0012's two policies on each of the four business-scoped tables. Nothing is dropped, renamed or
-- retyped, and no row is written or removed. Not here: the writes, which go through the one commit (K-05; C-087), the
-- safety service (T-318) and the migration-side contract test (T-583).
--
-- The five tables live beside K-04's tables, and their foreign keys name core tables by K-04's keys (businesses.id,
-- persons.id, handles.id, bookings.id, turns.id, clock_rows.id, outbox_rows.id) with no schema prefix, all on delete
-- restrict (K-34 rule 1). Ids are text: opaque strings code makes and never parses (rule 3; CQ-09). The paused flag a
-- threat sets is core's pauses row (pauses.set_by_turn_id), and an emergency contact is a core persons row.
--
-- Sealed fields (rule 6) are bytea, each sealed under one person's key in core's sealing_keys (db/repo/sealing.ts,
-- T-182), so deleting that key erases them (arch 09 line 492): safety_outcomes.sealed_words under person_id (each
-- label's evidence words, who is at risk and who wrote it, and the danger words matched), harm_reports.sealed_details
-- under sealed_for_person_id, and safety_timers.address under address_for_person_id. The labels, tenses, outcomes and
-- danger-word lists and kinds stay plain, so the gate, the actor's danger-first order and the gold set read them
-- without the person's key (K-34 README, open gaps). The wrapping key stays a Workers secret.
--
-- Versions (rule 2): safety_holds, harm_reports, safety_timers and privacy_incidents are updated (a release, a
-- follow-up, a miss or a SAFE, each step of an incident), so each carries a version that every update raises by exactly
-- one (K-04 rule 2; the trigger refuses any other update, 23514). safety_outcomes is only appended and carries none.
--
-- Rules across rows and tables are kept by code (C-104; K-34 README): which rule an outcome's hold takes (the strictest
-- of its outcomes); that a safe release's own read holds no danger; a threat's core pauses rows, set by the same turn;
-- that no timer starts or runs after the contact's yes ends; the "that day" and 1-business-day deadlines, counted from
-- reported_at in day_zone and from found_at.
--
-- Row-level security (arch 10 line 546; K-34 rules 4 and 5, which win over 0012's general rule where they differ):
--   safety_outcomes, safety_holds, safety_timers and privacy_incidents (scope business, on business_id), as 0012:
--     <table>_tool_api lets rosie_app see and write only rows whose business_id equals its scope (the setting
--     rosie.business_id), and none with no scope; <table>_runtime lets rosie_job see every row with no scope, else only
--     its scope's. A row whose business_id is null (a text before there is a business) is seen by no business scope:
--     the actor, the guard and the dispatcher read unscoped.
--   harm_reports (scope none): Rosie's team's rows, never a business's, since a report may name the owner or staff, who
--     must never hear of it (S13-10; arch 06 line 329). Row-level security stays off. rosie_app, the Tool API, may only
--     insert (the commit writes the report): it holds no SELECT, UPDATE or DELETE, so no business reads a report, its
--     owner included (42501), and its insert takes no RETURNING. rosie_job, Rosie's team's side until K-21 names its
--     role, reads and follows up unscoped.
--
-- Grants: SELECT and INSERT to both roles on the four business-scoped tables, behind their policies, and UPDATE on the
-- three of them that are versioned. safety_outcomes is never edited (rule 5): both roles hold INSERT and SELECT only, so
-- an update or a delete by either is refused by privilege (42501), as K-04 does for event_log. Rule 5 names privilege
-- alone, so no refusing trigger is added (event_log and consents have one beside their grants: 0011, 0013); an update
-- by the tables' owner, whom no privilege stops, is not refused here. harm_reports: INSERT to rosie_app; SELECT, INSERT
-- and UPDATE to rosie_job. No DELETE, TRUNCATE, REFERENCES or TRIGGER on any table, and nothing to PUBLIC. Neither
-- role owns a table.

-- The safety read's outcome for each raw text, and for free text from a secure page or an outside AI (K-02 v1
-- safetyResult): the read's labels with their tense, the danger words' lists and kinds, the model tries and the timeout
-- marker, and what holds after code's rules; the person's words sealed. One row per text (safety_outcomes_event_key).
create table safety_outcomes (
  id text primary key,
  event_id text not null,
  source text not null,
  handle_id text,
  person_id text,
  business_id text,
  booking_id text,
  turn_id text,
  read_at timestamptz not null,
  tries jsonb not null,
  timed_out boolean not null,
  labels text[] not null default '{}',
  tenses text[] not null default '{}',
  danger_word_lists text[] not null default '{}',
  danger_word_kinds text[] not null default '{}',
  sealed_words bytea,
  outcomes text[] not null default '{}',
  lifted_to_unsure boolean not null default false,
  constraint safety_outcomes_handle_fk foreign key (handle_id) references handles (id) on delete restrict,
  constraint safety_outcomes_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint safety_outcomes_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint safety_outcomes_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint safety_outcomes_turn_fk foreign key (turn_id) references turns (id) on delete restrict,
  constraint safety_outcomes_event_key unique (event_id),
  constraint safety_outcomes_source_known check (source in ('text', 'page', 'agent')),
  constraint safety_outcomes_text_has_handle_and_turn check (
    source <> 'text' or (handle_id is not null and turn_id is not null)
  ),
  constraint safety_outcomes_labels_known check (
    labels <@ array['No', 'Safety steps, then go on', 'An emergency', 'Crisis words', 'A threat to staff or others',
      'Harm to a child or older adult', 'Unsafe at home', 'Needs the business''s own line', 'Unsure']::text[]
  ),
  constraint safety_outcomes_tenses_known check (
    tenses <@ array['now', 'could restart', 'over', 'joke', 'unknown']::text[]
  ),
  constraint safety_outcomes_one_tense_per_label check (cardinality(labels) = cardinality(tenses)),
  constraint safety_outcomes_timeout_has_no_labels check (timed_out = (cardinality(labels) = 0)),
  constraint safety_outcomes_danger_words_known check (
    cardinality(danger_word_lists) = cardinality(danger_word_kinds)
      and danger_word_lists <@ array['general', 'plugin']::text[]
      and danger_word_kinds <@ array['selfHarm', 'other']::text[]
  ),
  constraint safety_outcomes_outcomes_known check (
    outcomes <@ array['No', 'Safety steps, then go on', 'An emergency', 'Crisis words', 'A threat to staff or others',
      'Harm to a child or older adult', 'Unsafe at home', 'Needs the business''s own line', 'Unsure']::text[]
  ),
  constraint safety_outcomes_verdict_has_outcome check (timed_out or cardinality(outcomes) >= 1),
  constraint safety_outcomes_timeout_rule check (
    not timed_out
      or outcomes = (case when cardinality(danger_word_kinds) = 0 then '{}'::text[] else array['Unsure']::text[] end)
  ),
  constraint safety_outcomes_lift_gives_unsure check (not lifted_to_unsure or 'Unsure' = any(outcomes)),
  constraint safety_outcomes_sealed_has_person check (sealed_words is null or person_id is not null),
  constraint safety_outcomes_tries_list check (
    jsonb_typeof(tries) = 'array' and jsonb_array_length(tries) between 1 and 2
  )
);

-- A handle's recent outcomes: the actor's danger-first order on return (arch 11 lines 564, 566) and the gate's holds.
create index safety_outcomes_handle_read_idx on safety_outcomes (handle_id, read_at) where handle_id is not null;
-- A turn's safety outcome (key safe: A3-22, B3-17).
create index safety_outcomes_turn_idx on safety_outcomes (turn_id) where turn_id is not null;
-- A business's danger cases, for the gold set and replay (arch 08 line 449).
create index safety_outcomes_business_read_idx on safety_outcomes (business_id, read_at);

-- What an outcome holds and when it is released (arch 06 lines 315 to 327): one row per outcome, with the strictest
-- rule of its outcomes. at_once after the outcome's message; when_private once the booking is private; after_safe after
-- a clear "we're safe" whose own read holds no danger, with a fresh read-back; never for a threat (the owner's decision
-- clears the core pause, not the hold). The visit never releases one.
create table safety_holds (
  id text primary key,
  safety_outcome_id text not null,
  business_id text,
  handle_id text not null,
  person_id text,
  booking_id text,
  turn_id text,
  release_rule text not null,
  blocks_booking boolean not null default false,
  held_at timestamptz not null,
  released_at timestamptz,
  released_why text,
  released_by_turn_id text,
  released_by_outcome_id text,
  version integer not null default 1,
  constraint safety_holds_outcome_fk foreign key (safety_outcome_id) references safety_outcomes (id) on delete restrict,
  constraint safety_holds_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint safety_holds_handle_fk foreign key (handle_id) references handles (id) on delete restrict,
  constraint safety_holds_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint safety_holds_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint safety_holds_turn_fk foreign key (turn_id) references turns (id) on delete restrict,
  constraint safety_holds_released_turn_fk foreign key (released_by_turn_id) references turns (id) on delete restrict,
  constraint safety_holds_released_outcome_fk foreign key (released_by_outcome_id)
    references safety_outcomes (id) on delete restrict,
  constraint safety_holds_one_per_outcome unique (safety_outcome_id),
  constraint safety_holds_rule_known check (release_rule in ('at_once', 'when_private', 'after_safe', 'never')),
  constraint safety_holds_released_pair check ((released_at is null) = (released_why is null)),
  constraint safety_holds_why_fits_rule check (
    released_why is null
      or (release_rule = 'at_once' and released_why = 'outcome_message_sent')
      or (release_rule = 'when_private' and released_why = 'booking_private')
      or (release_rule = 'after_safe' and released_why = 'safe_readback')
  ),
  constraint safety_holds_threat_never_released check (release_rule <> 'never' or released_at is null),
  constraint safety_holds_safe_release_has_read check (
    released_why is distinct from 'safe_readback'
      or (released_by_turn_id is not null and released_by_outcome_id is not null)
  ),
  constraint safety_holds_private_has_booking check (release_rule <> 'when_private' or booking_id is not null),
  constraint safety_holds_released_after_held check (released_at is null or released_at >= held_at),
  constraint safety_holds_not_released_by_itself check (
    released_by_outcome_id is null or released_by_outcome_id <> safety_outcome_id
  )
);

-- The gate checks a handle's open holds before any routine commit (arch 06 lines 315 to 327; arch 02 line 111).
create index safety_holds_open_handle_idx on safety_holds (handle_id) where released_at is null;
-- A booking's holds: Unsafe at home is released once it is private (A3-50).
create index safety_holds_booking_idx on safety_holds (booking_id) where booking_id is not null;

create trigger safety_holds_version_raised
  before update on safety_holds
  for each row execute function enforce_version_raise();

-- Reports Rosie's team follows up that day (A3-49; S13-10): harm to a child, an older adult or someone in care; a report
-- that the owner or staff harmed someone, never told to the one it names; a risk at home only the team hears of. A
-- child-or-elder report names the hotline given first (its number is never stored or made up). Rosie's team's rows.
create table harm_reports (
  id text primary key,
  business_id text not null,
  kind text not null,
  safety_outcome_id text,
  reporter_person_id text,
  booking_id text,
  named_person_id text,
  hotline text,
  sealed_details bytea,
  sealed_for_person_id text,
  reported_at timestamptz not null,
  day_zone text not null,
  followed_up_at timestamptz,
  followed_up_by_person_id text,
  version integer not null default 1,
  constraint harm_reports_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint harm_reports_outcome_fk foreign key (safety_outcome_id) references safety_outcomes (id) on delete restrict,
  constraint harm_reports_reporter_fk foreign key (reporter_person_id) references persons (id) on delete restrict,
  constraint harm_reports_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint harm_reports_named_fk foreign key (named_person_id) references persons (id) on delete restrict,
  constraint harm_reports_sealed_for_fk foreign key (sealed_for_person_id) references persons (id) on delete restrict,
  constraint harm_reports_followed_up_by_fk foreign key (followed_up_by_person_id)
    references persons (id) on delete restrict,
  constraint harm_reports_kind_known check (
    kind in ('harm_to_child_or_elder', 'about_owner_or_staff', 'unsafe_at_home')
  ),
  constraint harm_reports_named_only_about_owner_or_staff check (
    (kind = 'about_owner_or_staff') = (named_person_id is not null)
  ),
  constraint harm_reports_hotline_known check (
    hotline is null or hotline in ('child_abuse', 'youth_crisis', 'family_violence', 'elder_care')
  ),
  constraint harm_reports_child_or_elder_has_hotline check (kind <> 'harm_to_child_or_elder' or hotline is not null),
  constraint harm_reports_sealed_has_person check (sealed_details is null or sealed_for_person_id is not null),
  constraint harm_reports_followed_up_pair check ((followed_up_at is null) = (followed_up_by_person_id is null)),
  constraint harm_reports_followed_after_reported check (followed_up_at is null or followed_up_at >= reported_at),
  constraint harm_reports_day_zone_form check (day_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$')
);

-- Reports Rosie's team has yet to follow up that day (A3-49; S13-10).
create index harm_reports_open_idx on harm_reports (reported_at) where followed_up_at is null;

create trigger harm_reports_version_raised
  before update on harm_reports
  for each row execute function enforce_version_raise();

-- Check-out timers for a pro working alone (S13-10; B8-86): only with an emergency contact who said yes, due at the
-- check-out time; a missed check stays missed until the pro replies SAFE. The row holds what the actor keeps its own
-- copy of (due time and zone, the sealed address, the contact's handle), so a running timer fires while PostgreSQL is
-- down (arch 11 line 566); the core clock row (kind step) fires the miss when it is up.
create table safety_timers (
  id text primary key,
  business_id text not null,
  booking_id text,
  worker_person_id text not null,
  worker_handle_id text not null,
  emergency_contact_person_id text not null,
  emergency_contact_handle_id text not null,
  contact_yes_at timestamptz not null,
  started_at timestamptz not null,
  started_by_turn_id text,
  due_at timestamptz not null,
  due_zone text not null,
  address bytea not null,
  address_for_person_id text not null,
  clock_row_id text not null,
  state text not null default 'running',
  missed_at timestamptz,
  safe_at timestamptz,
  pro_alerted_at timestamptz,
  contact_alerted_at timestamptz,
  owner_alerted_at timestamptz,
  version integer not null default 1,
  constraint safety_timers_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint safety_timers_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint safety_timers_worker_fk foreign key (worker_person_id) references persons (id) on delete restrict,
  constraint safety_timers_worker_handle_fk foreign key (worker_handle_id) references handles (id) on delete restrict,
  constraint safety_timers_contact_fk foreign key (emergency_contact_person_id)
    references persons (id) on delete restrict,
  constraint safety_timers_contact_handle_fk foreign key (emergency_contact_handle_id)
    references handles (id) on delete restrict,
  constraint safety_timers_turn_fk foreign key (started_by_turn_id) references turns (id) on delete restrict,
  constraint safety_timers_address_for_fk foreign key (address_for_person_id) references persons (id) on delete restrict,
  constraint safety_timers_clock_fk foreign key (clock_row_id) references clock_rows (id) on delete restrict,
  constraint safety_timers_clock_key unique (clock_row_id),
  constraint safety_timers_state_known check (state in ('running', 'missed', 'safe')),
  constraint safety_timers_state_times check (
    (state = 'running' and missed_at is null and safe_at is null)
      or (state = 'missed' and missed_at is not null and safe_at is null)
      or (state = 'safe' and safe_at is not null)
  ),
  constraint safety_timers_due_after_start check (due_at > started_at),
  constraint safety_timers_yes_before_start check (contact_yes_at <= started_at),
  constraint safety_timers_contact_not_worker check (emergency_contact_person_id <> worker_person_id),
  constraint safety_timers_missed_after_due check (missed_at is null or missed_at >= due_at),
  constraint safety_timers_alerts_after_miss check (
    missed_at is not null or (pro_alerted_at is null and contact_alerted_at is null and owner_alerted_at is null)
  ),
  constraint safety_timers_due_zone_form check (due_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$')
);

-- Running and missed timers: the actor reloads its copies, and missed checks keep being tried until SAFE.
create index safety_timers_live_due_idx on safety_timers (due_at) where state in ('running', 'missed');
-- The pro's open timer, which a SAFE reply closes (B8-86).
create index safety_timers_worker_live_idx on safety_timers (worker_handle_id) where state in ('running', 'missed');

create trigger safety_timers_version_raised
  before update on safety_timers
  for each row execute function enforce_version_raise();

-- Privacy slips (S12-29 to S12-31): a detail Rosie never keeps that arrived anyway (deleted, the person told where it
-- goes, the business told only that one came), or a private detail that reached the wrong person (sends to it stopped,
-- any code it showed replaced, everyone told, the team's look within 1 business day). Never the detail itself: its
-- kind, and the fields it showed by name.
create table privacy_incidents (
  id text primary key,
  business_id text not null,
  kind text not null,
  person_id text not null,
  booking_id text,
  detail_kind text,
  event_id text,
  outbox_row_id text,
  sent_to_handle_id text,
  fields_shown text[] not null default '{}',
  found_at timestamptz not null,
  deleted_at timestamptz,
  stopped_at timestamptz,
  codes_replaced_at timestamptz,
  person_told_at timestamptz,
  business_told_at timestamptz,
  team_reviewed_at timestamptz,
  version integer not null default 1,
  constraint privacy_incidents_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint privacy_incidents_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint privacy_incidents_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint privacy_incidents_outbox_fk foreign key (outbox_row_id) references outbox_rows (id) on delete restrict,
  constraint privacy_incidents_sent_to_fk foreign key (sent_to_handle_id) references handles (id) on delete restrict,
  constraint privacy_incidents_kind_known check (kind in ('detail_never_kept', 'wrong_person')),
  constraint privacy_incidents_detail_kind_known check (
    detail_kind is null or detail_kind in ('card_number', 'ssn', 'password', 'door_code', 'plugin_list')
  ),
  constraint privacy_incidents_never_kept_fields check (
    kind <> 'detail_never_kept'
      or (detail_kind is not null and sent_to_handle_id is null and outbox_row_id is null
        and cardinality(fields_shown) = 0)
  ),
  constraint privacy_incidents_wrong_person_fields check (
    kind <> 'wrong_person'
      or (sent_to_handle_id is not null and detail_kind is null and event_id is null and deleted_at is null)
  ),
  constraint privacy_incidents_steps_after_found check (
    (deleted_at is null or deleted_at >= found_at)
      and (stopped_at is null or stopped_at >= found_at)
      and (codes_replaced_at is null or codes_replaced_at >= found_at)
      and (person_told_at is null or person_told_at >= found_at)
      and (business_told_at is null or business_told_at >= found_at)
      and (team_reviewed_at is null or team_reviewed_at >= found_at)
  )
);

-- A business's incidents, and those whose 1-business-day steps are still open (S12-31; RULES 4.10).
create index privacy_incidents_business_found_idx on privacy_incidents (business_id, found_at);
-- Whether a handle was cut off by a privacy slip (limit 8 and the links; S12-31).
create index privacy_incidents_sent_to_idx on privacy_incidents (sent_to_handle_id) where sent_to_handle_id is not null;

create trigger privacy_incidents_version_raised
  before update on privacy_incidents
  for each row execute function enforce_version_raise();

-- Never edited (rule 5): both roles insert and select, behind the policies below; nothing else.
grant select, insert on safety_outcomes to rosie_app, rosie_job;

-- The business-scoped tables that are updated: both roles, behind the policies below.
grant select, insert, update on safety_holds, safety_timers, privacy_incidents to rosie_app, rosie_job;

-- Rosie's team's rows (scope none, rule 4): the Tool API adds a report and nothing more; the team's side reads, adds and
-- follows up.
grant insert on harm_reports to rosie_app;
grant select, insert, update on harm_reports to rosie_job;

-- Row-level security: rosie_app sees only its scope; rosie_job sees everything with no scope, else only its scope.
alter table safety_outcomes enable row level security;
create policy safety_outcomes_tool_api on safety_outcomes for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy safety_outcomes_runtime on safety_outcomes for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table safety_holds enable row level security;
create policy safety_holds_tool_api on safety_holds for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy safety_holds_runtime on safety_holds for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table safety_timers enable row level security;
create policy safety_timers_tool_api on safety_timers for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy safety_timers_runtime on safety_timers for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table privacy_incidents enable row level security;
create policy privacy_incidents_tool_api on privacy_incidents for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy privacy_incidents_runtime on privacy_incidents for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );
