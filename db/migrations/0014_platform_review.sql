-- T-193: the platform and review part (K-37 v1, frozen: contracts/db-schema/platform-review): Rosie's team's record of
-- a parked turn, the dead-letter queue, gap cases with their state and frontier, the team review queue, and the
-- human-labelled live turns (arch 11 line 576; arch 10 line 540; arch 01 line 95; arch 03 line 189; arch 08 line 449).
-- Expand only: five new tables with their indexes; each table's version trigger (enforce_version_raise() from 0002,
-- T-181); grants to rosie_job, one of the two roles 0012 made (never created or altered here). Nothing is dropped,
-- renamed or retyped, and no row is written or removed. Not here: parking a turn (the call, T-197), the queues that
-- write dead letters (C-056), the commit that writes a gap case or a review item (C-087), the monthly sample (C-145) and
-- the team console's views (C-194).
--
-- The five tables live beside K-04's tables, and their foreign keys name core tables by K-04's keys (turns.id,
-- businesses.id, persons.id), all on delete restrict (K-37 rule 1). Ids are text: opaque strings code makes and never
-- parses (rule 6; CQ-09). test_ref, fix_ref and gold_item_id name things outside the database, and a review item's
-- subject_table and subject_row_id name a row in any part as event_log names one, so none of them has a foreign key.
-- Rules across tables are kept by code (rule 5): a parked_turns row's turn is parked in core (written once, with tries
-- 3: NQ-RT-3); a review item's subject exists; a labelled live turn is a committed live turn; due_at, reply_due_at and
-- wait_until follow their kind's business-day rule, which code computes (the calendar is an open question).
--
-- No private value in a plain column (rule 4): error_summary, last_error, message_body, summary and outcome hold ids,
-- references and plain descriptions. The two columns that may hold private words are sealed under a per-person key:
-- gap_cases.summary_sealed (K-02's plannerLogGap.summary) and live_turn_labels.label_sealed, each under the key of its
-- row's sealed_for_person_id (arch 01 line 93), so deleting that key erases them (arch 09 line 492). The wrapping key
-- stays a Workers secret (K-04 rule 6).
--
-- Every table here is updated (a reply, a replay, a review, a decision, a label), so each carries a version that every
-- update raises by exactly one (rule 3; K-04 rule 2; the trigger refuses any other update, 23514).
--
-- Rosie's team only, by privilege (rule 2): every table here is rowLevelSecurity.scope none, so row-level security
-- stays off, as on 0012's tables that span businesses, and rosie_app, the Tool API (K-05 scope business), holds no grant
-- on any of them: a select, insert or update from a call scoped to one business is refused with SQLSTATE 42501
-- (refuse-review-item-tool-api-read.json), so no business sees the items about itself (S11-70: a report that the owner
-- or staff harmed someone; S12-28: patterns across businesses). rosie_job, the runtime side, reads and writes them
-- unscoped, as K-04 rule 4 allows for jobs across businesses; the team console works on that side until K-21 names its
-- role.
--
-- Grants, as 0012's for a versioned table that spans businesses: SELECT, INSERT and UPDATE to rosie_job; no DELETE,
-- TRUNCATE, REFERENCES or TRIGGER; nothing to rosie_app or PUBLIC. Neither role owns a table.

-- Rosie's team's record of a turn parked after a third crash before its commit: the error, when the person was told
-- once that nothing changed, when the team's reply is due (1 business day), and the reply (arch 11 line 576; C-180;
-- C-194). The turn itself, with state parked, parked_at and tries 3, is core's turns row.
create table parked_turns (
  turn_id text primary key,
  error_summary text not null,
  person_told_at timestamptz,
  reply_due_at timestamptz not null,
  state text not null default 'open',
  replied_at timestamptz,
  replied_by_person_id text,
  resolution text,
  version integer not null default 1,
  constraint parked_turns_turn_fk foreign key (turn_id) references turns (id) on delete restrict,
  constraint parked_turns_replied_by_fk foreign key (replied_by_person_id) references persons (id) on delete restrict,
  constraint parked_turns_state_known check (state in ('open', 'replied')),
  constraint parked_turns_replied_has_time check ((state = 'replied') = (replied_at is not null)),
  constraint parked_turns_replied_has_who check (
    state <> 'replied' or (replied_by_person_id is not null and resolution is not null)
  ),
  constraint parked_turns_error_given check (length(btrim(error_summary)) > 0)
);

-- The team console's parked turns, the reply due soonest first (C-194; arch 11 line 576).
create index parked_turns_open_due_idx on parked_turns (reply_due_at) where state = 'open';

create trigger parked_turns_version_raised
  before update on parked_turns
  for each row execute function enforce_version_raise();

-- The dead-letter queue in the team console: a queued job other than a send that failed its 5 tries (arch 10 line 540).
-- Sends follow step 8 and never land here; effects take their service's outage row (arch 10 line 542). The team replays
-- it (back to its queue unchanged) or closes it. job_id is the id the event log's job_id carries for the job's writes.
create table dead_letters (
  id text primary key,
  queue text not null,
  job_kind text not null,
  job_id text not null,
  message_body jsonb not null,
  tries integer not null,
  first_tried_at timestamptz not null,
  last_tried_at timestamptz not null,
  last_error text not null,
  business_id text,
  trace_id text not null,
  dead_at timestamptz not null default now(),
  state text not null default 'open',
  resolved_at timestamptz,
  resolved_by_person_id text,
  version integer not null default 1,
  constraint dead_letters_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint dead_letters_resolved_by_fk foreign key (resolved_by_person_id)
    references persons (id) on delete restrict,
  constraint dead_letters_after_five_tries check (tries >= 5),
  constraint dead_letters_tries_in_order check (first_tried_at <= last_tried_at and last_tried_at <= dead_at),
  constraint dead_letters_state_known check (state in ('open', 'replayed', 'closed')),
  constraint dead_letters_resolved_has_time check ((state = 'open') = (resolved_at is null)),
  constraint dead_letters_resolved_has_who check (state = 'open' or resolved_by_person_id is not null),
  constraint dead_letters_error_given check (length(btrim(last_error)) > 0)
);

-- The team console's dead-letter queue, oldest first (arch 10 line 540; C-194).
create index dead_letters_open_idx on dead_letters (dead_at) where state = 'open';
-- A job's dead letters, and its writes in the event log by the same job id (K-04 v1 event_log.job_id).
create index dead_letters_job_idx on dead_letters (job_id);

create trigger dead_letters_version_raised
  before update on dead_letters
  for each row execute function enforce_version_raise();

-- A gap case: a turn that no choice fit, logged with its state and frontier for the weekly review (arch 01 line 95;
-- arch 03 line 189). One per turn. Its state is the open questions sent to the handle and the rows the turn read (K-04's
-- {"table", "rowId", "version"} references); its frontier is the K-02 v1 choice array offered on the last read, with
-- meaning search's entry steps. References only: the values are re-read from the rows and the event log. outcome is
-- the planner's verb, or to_person; the weekly review records the test and the fix each miss becomes (HANDOFF 10).
create table gap_cases (
  turn_id text primary key,
  business_id text,
  outcome text not null,
  summary_sealed bytea,
  sealed_for_person_id text,
  open_question_ids text[] not null default '{}',
  versions_read jsonb not null default '[]',
  frontier jsonb not null,
  logged_at timestamptz not null default now(),
  review_state text not null default 'open',
  reviewed_at timestamptz,
  reviewed_by_person_id text,
  test_ref text,
  fix_ref text,
  version integer not null default 1,
  constraint gap_cases_turn_fk foreign key (turn_id) references turns (id) on delete restrict,
  constraint gap_cases_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint gap_cases_sealed_for_fk foreign key (sealed_for_person_id) references persons (id) on delete restrict,
  constraint gap_cases_reviewed_by_fk foreign key (reviewed_by_person_id) references persons (id) on delete restrict,
  constraint gap_cases_outcome_known check (
    outcome in ('answer', 'ask', 'pass_on', 'hand_off', 'log_gap', 'to_person')
  ),
  constraint gap_cases_sealed_has_person check (summary_sealed is null or sealed_for_person_id is not null),
  constraint gap_cases_frontier_is_list check (
    jsonb_typeof(frontier) = 'array' and jsonb_array_length(frontier) >= 1
  ),
  constraint gap_cases_versions_read_is_list check (jsonb_typeof(versions_read) = 'array'),
  constraint gap_cases_review_state_known check (review_state in ('open', 'reviewed')),
  constraint gap_cases_reviewed_has_time check ((review_state = 'reviewed') = (reviewed_at is not null)),
  constraint gap_cases_reviewed_has_who check (review_state <> 'reviewed' or reviewed_by_person_id is not null)
);

-- The week's gap cases still to review, in the team console (arch 03 line 189; C-194).
create index gap_cases_open_idx on gap_cases (logged_at) where review_state = 'open';
-- One business's gap cases, since meaning search ran over that business's step graph (arch 03 line 189).
create index gap_cases_business_idx on gap_cases (business_id, logged_at) where business_id is not null;

create trigger gap_cases_version_raised
  before update on gap_cases
  for each row execute function enforce_version_raise();

-- The team review queue: each thing the sources send to a person on Rosie's team, never to the AI alone, with when the
-- answer is due. Within 1 business day: new work (S1-03), control (S1-75), a listing match (S1-76), an owner's claim
-- (S11-52), a booking cap (S12-28); the same day: a harm report (A3-49; S11-70) and a missed legal deadline (S11-70).
-- The thing under review lives in its own part; this row is the queue entry that points at it, and what the decision
-- changes is written there.
create table review_items (
  id text primary key,
  kind text not null,
  business_id text,
  subject_table text,
  subject_row_id text,
  turn_id text,
  raised_by_person_id text,
  summary text not null,
  opened_at timestamptz not null default now(),
  due_at timestamptz not null,
  state text not null default 'open',
  wait_until timestamptz,
  decided_at timestamptz,
  decided_by_person_id text,
  outcome text,
  version integer not null default 1,
  constraint review_items_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint review_items_turn_fk foreign key (turn_id) references turns (id) on delete restrict,
  constraint review_items_raised_by_fk foreign key (raised_by_person_id) references persons (id) on delete restrict,
  constraint review_items_decided_by_fk foreign key (decided_by_person_id)
    references persons (id) on delete restrict,
  constraint review_items_kind_known check (
    kind in ('new_work', 'control', 'listing_match', 'owner_claim', 'booking_cap', 'harm_report', 'missed_deadline')
  ),
  constraint review_items_state_known check (state in ('open', 'waiting', 'done')),
  constraint review_items_waiting_has_until check ((state = 'waiting') = (wait_until is not null)),
  constraint review_items_done_has_time check ((state = 'done') = (decided_at is not null)),
  constraint review_items_done_has_who check (
    state <> 'done' or (decided_by_person_id is not null and outcome is not null)
  ),
  constraint review_items_subject_pair check ((subject_table is null) = (subject_row_id is null)),
  constraint review_items_due_after_opened check (due_at > opened_at),
  constraint review_items_summary_given check (length(btrim(summary)) > 0)
);

-- The team console's review queue, the answer due soonest first (C-194; Q-18).
create index review_items_queue_idx on review_items (due_at) where state <> 'done';
-- A row's reviews, for example whether a business still waits on its control check (S1-75).
create index review_items_subject_idx on review_items (subject_table, subject_row_id) where subject_table is not null;
-- One business's reviews, for the team (S1-76, S11-52, S12-28).
create index review_items_business_idx on review_items (business_id, opened_at) where business_id is not null;

create trigger review_items_version_raised
  before update on review_items
  for each row execute function enforce_version_raise();

-- The human-labelled live turns after launch: 300 live turns sampled each month, each waiting in the team console for a
-- person's label, then the gold-set item it became (arch 08 lines 447, 449; C-145; QUESTIONS.md M6-M8.7). One row per
-- sampled turn; sample_month is the month's first day.
create table live_turn_labels (
  turn_id text primary key,
  sample_month date not null,
  sampled_at timestamptz not null default now(),
  state text not null default 'waiting',
  label_sealed bytea,
  sealed_for_person_id text,
  labelled_at timestamptz,
  labelled_by_person_id text,
  gold_item_id text,
  version integer not null default 1,
  constraint live_turn_labels_turn_fk foreign key (turn_id) references turns (id) on delete restrict,
  constraint live_turn_labels_sealed_for_fk foreign key (sealed_for_person_id)
    references persons (id) on delete restrict,
  constraint live_turn_labels_labelled_by_fk foreign key (labelled_by_person_id)
    references persons (id) on delete restrict,
  constraint live_turn_labels_month_start check (sample_month = date_trunc('month', sample_month)::date),
  constraint live_turn_labels_state_known check (state in ('waiting', 'labelled')),
  constraint live_turn_labels_labelled_has_label check (
    (state = 'labelled') = (label_sealed is not null and labelled_at is not null and labelled_by_person_id is not null)
  ),
  constraint live_turn_labels_sealed_has_person check (label_sealed is null or sealed_for_person_id is not null),
  constraint live_turn_labels_gold_after_label check (gold_item_id is null or state = 'labelled')
);

-- A month's sample and how many still wait for a label (arch 08 line 449: 300 a month; QUESTIONS.md M6-M8.7).
create index live_turn_labels_month_state_idx on live_turn_labels (sample_month, state);

create trigger live_turn_labels_version_raised
  before update on live_turn_labels
  for each row execute function enforce_version_raise();

-- Rosie's team's tables: the runtime side only, unscoped (no row-level security: none is scoped by business).
grant select, insert, update on parked_turns, dead_letters, gap_cases, review_items, live_turn_labels to rosie_job;
