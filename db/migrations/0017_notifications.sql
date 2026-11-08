-- T-581: the notifications part (K-36 v1, frozen: contracts/db-schema/notifications): owner alerts and hand-offs with
-- their answer and escalation, pages to Rosie's team with their acknowledgement and 5-minute repeat clock, and the
-- members of Rosie's team who get every page (arch 06 line 329; S11-19; S13-29 rules 53, 54, 57; QUESTIONS.md
-- M3-M3b.5; Q-18).
-- Expand only: three new tables with their indexes; the version trigger (enforce_version_raise() from 0002, T-181) on
-- all three; grants to the two roles 0012 made (never created or altered here); row-level security switched on with
-- 0012's two policies on hand_offs, the one business-scoped table. Nothing is dropped, renamed or retyped, and no row is
-- written or removed. Not here: the paging calls (T-319), delivery (T-614) and the migration-side contract test (T-584).
--
-- The three tables live beside K-04's tables (K-36 README rule 1), and their foreign keys name core tables by K-04's
-- keys (businesses.id, persons.id, handles.id, bookings.id, turns.id, clock_rows.id, outbox_rows.id) and the K-34 and
-- K-37 rows a hand-off or a page points at by theirs (safety_outcomes.id, harm_reports.id, safety_timers.id,
-- review_items.id), with no schema prefix, all on delete restrict; so this file runs after 0014 (K-37) and 0016 (K-34).
-- Ids are text: opaque strings code makes and never parses (rule 6; CQ-09).
--
-- Who is told (arch 06 line 329) is held by the checks: crisis words page Rosie's team at once (escalate_at equals
-- handed_at, no clock row); an emergency or a threat pages the team, and whoever the owner named, 5 minutes after the
-- owner is told, through a core clock row; any other hand-off no sooner than 2 days after (code counts the 2 days from
-- text hours). A page repeats every 5 minutes or is paged once (repeat_minutes 5 or null); a clock row fires once
-- (K-05 item 5), so each page arms a new one and an open repeating page always names its next one.
--
-- No private value in a plain column (rule 4): hand_offs.summary holds only what the owner may hear, and
-- team_pages.summary ids, kinds and plain words; a person's words stay sealed in the K-34 row a hand-off or a page
-- points at. This part seals nothing itself.
--
-- Versions (rule 3): all three tables are updated (answered, escalated, paged again, acknowledged, a member removed), so
-- each carries a version that every update raises by exactly one (K-04 rule 2; the trigger refuses any other update,
-- 23514).
--
-- Rules across rows and tables are kept by code (rule 5), not constraints: a hand-off's kind matches its safety read's
-- outcome; its alert outbox row is written in the same commit and linked by code; a page's next clock row is live; a
-- page acknowledged by a reply comes from one of the people paged; the members paged are those live on the list when
-- each page goes.
--
-- Row-level security and grants (K-36 README rule 2, which wins over 0012's general rule where they differ):
--   hand_offs (scope business, on business_id), as 0012: hand_offs_tool_api lets rosie_app, the Tool API (the commit,
--     and the owner's answer), see and write only rows whose business_id equals its scope (the setting
--     rosie.business_id), and none with no scope; hand_offs_runtime lets rosie_job see every row with no scope (the
--     clock that escalates a hand-off, the team console), else only its scope's. SELECT, INSERT and UPDATE to both,
--     behind the policies.
--   team_pages (scope none): Rosie's team's rows, never a business's, since a page may point at a harm report that names
--     the owner or staff, or at a review item the business must not see. Row-level security stays off. rosie_app may
--     only insert (the commit pages for crisis words, a harm report or a reply passed on): it holds no SELECT, UPDATE or
--     DELETE, so no business reads a page, its owner included (42501), and its insert takes no RETURNING. rosie_job, the
--     team's side until K-21 names its role, reads, pages again and acknowledges unscoped: SELECT, INSERT and UPDATE.
--   team_page_recipients (scope none): Rosie's team's own list. No grant to rosie_app; SELECT, INSERT and UPDATE to
--     rosie_job, the paging job and the team console (a member leaves by removed_at, never by a delete).
-- No DELETE, TRUNCATE, REFERENCES or TRIGGER on any table, and nothing to PUBLIC. Neither role owns a table.

-- Owner alerts and hand-offs (S13-29 rules 53 to 57; arch 06 line 329; S11-19): who was told (the owner, or whoever they
-- named), why, about which safety read or booking, when Rosie's team is paged if nobody answers, and the answer. The
-- alert itself is a core outbox row; the page to the team is a team_pages row that points here. Harm to a child or an
-- older adult, and a report about the owner or staff, never go to the owner: they are K-34 harm reports.
create table hand_offs (
  id text primary key,
  business_id text not null,
  kind text not null,
  safety_outcome_id text,
  turn_id text,
  booking_id text,
  about_person_id text,
  told_person_id text not null,
  told_as text not null,
  alert_outbox_row_id text,
  summary text not null,
  handed_at timestamptz not null,
  escalate_at timestamptz not null,
  escalation_clock_row_id text,
  answered_at timestamptz,
  answered_via text,
  answered_by_person_id text,
  escalated_at timestamptz,
  version integer not null default 1,
  constraint hand_offs_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint hand_offs_safety_outcome_fk foreign key (safety_outcome_id)
    references safety_outcomes (id) on delete restrict,
  constraint hand_offs_turn_fk foreign key (turn_id) references turns (id) on delete restrict,
  constraint hand_offs_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint hand_offs_about_person_fk foreign key (about_person_id) references persons (id) on delete restrict,
  constraint hand_offs_told_person_fk foreign key (told_person_id) references persons (id) on delete restrict,
  constraint hand_offs_alert_outbox_fk foreign key (alert_outbox_row_id) references outbox_rows (id) on delete restrict,
  constraint hand_offs_clock_fk foreign key (escalation_clock_row_id) references clock_rows (id) on delete restrict,
  constraint hand_offs_answered_by_fk foreign key (answered_by_person_id) references persons (id) on delete restrict,
  constraint hand_offs_clock_key unique (escalation_clock_row_id),
  constraint hand_offs_kind_known check (kind in ('crisis_words', 'emergency', 'threat', 'other')),
  constraint hand_offs_told_as_known check (told_as in ('owner', 'named')),
  constraint hand_offs_safety_kind_has_outcome check ((kind = 'other') = (safety_outcome_id is null)),
  constraint hand_offs_crisis_words_at_once check (kind <> 'crisis_words' or escalate_at = handed_at),
  constraint hand_offs_emergency_threat_five_minutes check (
    kind not in ('emergency', 'threat') or escalate_at = handed_at + interval '5 minutes'
  ),
  constraint hand_offs_other_two_days check (kind <> 'other' or escalate_at >= handed_at + interval '2 days'),
  constraint hand_offs_clock_unless_at_once check ((kind = 'crisis_words') = (escalation_clock_row_id is null)),
  constraint hand_offs_answered_via_known check (answered_via is null or answered_via in ('reply', 'console_tap')),
  constraint hand_offs_answered_together check (
    (answered_at is null) = (answered_via is null) and (answered_at is null) = (answered_by_person_id is null)
  ),
  constraint hand_offs_answered_after_handed check (answered_at is null or answered_at >= handed_at),
  constraint hand_offs_escalated_when_due check (escalated_at is null or escalated_at >= escalate_at)
);

-- Hand-offs nobody has answered yet, due to go to Rosie's team (arch 06 line 329; S11-19).
create index hand_offs_waiting_idx on hand_offs (escalate_at) where answered_at is null and escalated_at is null;
-- A business's hand-offs, newest first, for the owner console and the owner's answer (arch 06 line 329).
create index hand_offs_business_handed_idx on hand_offs (business_id, handed_at);
-- The hand-off a safety read raised (K-34 v1 safety_outcomes).
create index hand_offs_safety_outcome_idx on hand_offs (safety_outcome_id) where safety_outcome_id is not null;

create trigger hand_offs_version_raised
  before update on hand_offs
  for each row execute function enforce_version_raise();

-- Pages to Rosie's team and their acknowledgement (arch 06 line 329; arch 02 diagram line 105; arch 03 line 123; arch
-- 08 line 447; S11-19; S13-10): why, the one row each reason points at, how many times it was paged, whether it repeats
-- every 5 minutes until acknowledged, and who acknowledged it, how and when. For an emergency or a threat, whoever the
-- owner named is paged with the team. Each page to each person is a core outbox row (send class safety).
create table team_pages (
  id text primary key,
  reason text not null,
  business_id text,
  hand_off_id text,
  harm_report_id text,
  review_item_id text,
  safety_timer_id text,
  turn_id text,
  named_person_id text,
  summary text not null,
  opened_at timestamptz not null,
  last_paged_at timestamptz not null,
  times_paged integer not null default 1,
  repeat_minutes integer,
  next_page_clock_row_id text,
  state text not null default 'open',
  acknowledged_at timestamptz,
  acknowledged_by_person_id text,
  acknowledged_via text,
  version integer not null default 1,
  constraint team_pages_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint team_pages_hand_off_fk foreign key (hand_off_id) references hand_offs (id) on delete restrict,
  constraint team_pages_harm_report_fk foreign key (harm_report_id) references harm_reports (id) on delete restrict,
  constraint team_pages_review_item_fk foreign key (review_item_id) references review_items (id) on delete restrict,
  constraint team_pages_safety_timer_fk foreign key (safety_timer_id) references safety_timers (id) on delete restrict,
  constraint team_pages_turn_fk foreign key (turn_id) references turns (id) on delete restrict,
  constraint team_pages_named_person_fk foreign key (named_person_id) references persons (id) on delete restrict,
  constraint team_pages_clock_fk foreign key (next_page_clock_row_id) references clock_rows (id) on delete restrict,
  constraint team_pages_acknowledged_by_fk foreign key (acknowledged_by_person_id)
    references persons (id) on delete restrict,
  constraint team_pages_clock_key unique (next_page_clock_row_id),
  constraint team_pages_reason_known check (
    reason in ('hand_off', 'owner_cannot_act', 'harm_report', 'review_item', 'safety_timer_missed', 'passed_on',
      'hard_invariant_breach')
  ),
  constraint team_pages_hand_off_pointer check ((reason = 'hand_off') = (hand_off_id is not null)),
  constraint team_pages_harm_report_pointer check ((reason = 'harm_report') = (harm_report_id is not null)),
  constraint team_pages_review_item_pointer check ((reason = 'review_item') = (review_item_id is not null)),
  constraint team_pages_safety_timer_pointer check ((reason = 'safety_timer_missed') = (safety_timer_id is not null)),
  constraint team_pages_passed_on_has_turn check (reason <> 'passed_on' or turn_id is not null),
  constraint team_pages_owner_cannot_act_has_business check (reason <> 'owner_cannot_act' or business_id is not null),
  constraint team_pages_named_only_for_hand_off check (named_person_id is null or reason = 'hand_off'),
  constraint team_pages_repeat_every_five check (repeat_minutes is null or repeat_minutes = 5),
  constraint team_pages_times_paged check (times_paged >= 1 and (times_paged = 1 or repeat_minutes is not null)),
  constraint team_pages_last_paged_in_order check (
    last_paged_at >= opened_at and (times_paged = 1 or last_paged_at > opened_at)
  ),
  constraint team_pages_state_known check (state in ('open', 'acknowledged')),
  constraint team_pages_acknowledged_via_known check (
    acknowledged_via is null or acknowledged_via in ('reply', 'console_tap')
  ),
  constraint team_pages_acknowledged_together check (
    (state = 'acknowledged') = (acknowledged_at is not null)
      and (acknowledged_at is null) = (acknowledged_by_person_id is null)
      and (acknowledged_at is null) = (acknowledged_via is null)
  ),
  constraint team_pages_acknowledged_after_paged check (acknowledged_at is null or acknowledged_at >= last_paged_at),
  constraint team_pages_open_repeat_has_clock check (
    state <> 'open' or repeat_minutes is null or next_page_clock_row_id is not null
  )
);

-- A hand-off goes to Rosie's team once, then is paged until acknowledged (arch 06 line 329): a partial unique index,
-- as the table list's unique rule with its where.
create unique index team_pages_one_per_hand_off on team_pages (hand_off_id) where hand_off_id is not null;
-- The team console's open pages, oldest first (arch 02 diagram line 105; arch 06 line 329).
create index team_pages_open_idx on team_pages (opened_at) where state = 'open';
-- The page a harm report raised (A3-49).
create index team_pages_harm_report_idx on team_pages (harm_report_id) where harm_report_id is not null;
-- The page a review item raised (K-37 v1 review_items).
create index team_pages_review_item_idx on team_pages (review_item_id) where review_item_id is not null;
-- The page a missed safety check raised (S13-10; B8-86).
create index team_pages_safety_timer_idx on team_pages (safety_timer_id) where safety_timer_id is not null;

create trigger team_pages_version_raised
  before update on team_pages
  for each row execute function enforce_version_raise();

-- The members of Rosie's team who get every page, each reached in their own open chat with Rosie, else by email, since
-- Rosie never writes first (QUESTIONS.md M3-M3b.5; Q-18; MC C9). Until launch the members are Jay and the CTO; on
-- staging the staging database holds its own rows (BP 9.4). A member leaves the list by removed_at, never by a delete.
create table team_page_recipients (
  id text primary key,
  person_id text not null,
  chat_handle_id text,
  email_handle_id text,
  added_at timestamptz not null,
  removed_at timestamptz,
  version integer not null default 1,
  constraint team_page_recipients_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint team_page_recipients_chat_handle_fk foreign key (chat_handle_id)
    references handles (id) on delete restrict,
  constraint team_page_recipients_email_handle_fk foreign key (email_handle_id)
    references handles (id) on delete restrict,
  constraint team_page_recipients_reachable check (chat_handle_id is not null or email_handle_id is not null),
  constraint team_page_recipients_removed_after_added check (removed_at is null or removed_at >= added_at)
);

-- Each member gets each page once (QUESTIONS.md M3-M3b.5): one live row per person, a partial unique index, as the
-- table list's unique rule with its where.
create unique index team_page_recipients_one_live_per_person on team_page_recipients (person_id)
  where removed_at is null;

create trigger team_page_recipients_version_raised
  before update on team_page_recipients
  for each row execute function enforce_version_raise();

-- The one business-scoped table, versioned: both roles, behind the policies below.
grant select, insert, update on hand_offs to rosie_app, rosie_job;

-- Rosie's team's rows (scope none, K-36 README rule 2): the Tool API adds a page and nothing more; it holds no grant on
-- the recipient list. The team's side reads, adds, pages again, acknowledges and removes a member by removed_at.
grant insert on team_pages to rosie_app;
grant select, insert, update on team_pages, team_page_recipients to rosie_job;

-- Row-level security: rosie_app sees only its scope; rosie_job sees everything with no scope, else only its scope.
alter table hand_offs enable row level security;
create policy hand_offs_tool_api on hand_offs for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy hand_offs_runtime on hand_offs for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );
