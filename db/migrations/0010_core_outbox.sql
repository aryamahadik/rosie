-- T-189: outbox rows and their parts (K-04 v1 core, frozen: contracts/db-schema/core; states and kinds from K-07 v1).
-- Expand only: two new tables with their indexes and version triggers, and the two foreign keys that 0005 left for the
-- migration that creates outbox_rows. Uses enforce_version_raise() from 0002 (T-181). Nothing is dropped, renamed or
-- retyped. Row-level security is T-191's: outbox_rows is scoped by business_id with the rest of the policies there;
-- outbox_parts has no scope (the dispatcher alone writes and reads it; its row carries the business).
--
-- Foreign keys added here to tables of 0005, because outbox_rows now exists (named in 0005's header, on columns that
-- hold an id the code made):
--   openers_sent_outbox_fk     openers_sent (outbox_row_id)    references outbox_rows (id)  on delete restrict
--   messages_outbox_fk         messages (outbox_row_id)        references outbox_rows (id)  on delete restrict
-- 0009's header names no key for the outbox beyond outbox_rows' own turn key (outbox_rows_turn_fk), which is made here.
-- The bundle key (outbox_rows_bundle_fk) points at 0006's bundles (hash, build), as 0006's header says.
--
-- The table list leaves the states and kinds as free text for K-07. K-07 v1 is frozen, so three CHECKs hold its closed
-- lists: outbox_rows_state_known, outbox_parts_kind_known and outbox_parts_state_known. They add no column. The state
-- moves, claims and the calls that make them are not here (T-196). There is no SMS provider (DL-012): the channel list
-- is K-03 v1's, where sms is only Linq's own SMS service on Rosie's one number.

-- One message to one recipient on one channel (arch 01 line 65), written at the commit with no plan, then given the
-- composer's plan and the final parts. commit_seq is the database's commit order for each recipient (arch 02 line 125).
create table outbox_rows (
  id text primary key,
  turn_id text not null,
  commit_seq bigint generated always as identity,
  recipient_handle_id text not null,
  recipient_person_id text,
  business_id text,
  booking_id text,
  channel text not null,
  send_class text not null default 'routine',
  versions_read jsonb not null,
  open_question_id text,
  plan jsonb,
  final_parts jsonb,
  copy_of_row_id text,
  state text not null default 'planned',
  held_until timestamptz,
  bundle_hash text not null,
  bundle_build integer not null,
  trace_id text not null,
  version integer not null default 1,
  constraint outbox_rows_turn_fk foreign key (turn_id) references turns (id) on delete restrict,
  constraint outbox_rows_handle_fk foreign key (recipient_handle_id) references handles (id) on delete restrict,
  constraint outbox_rows_person_fk foreign key (recipient_person_id) references persons (id) on delete restrict,
  constraint outbox_rows_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint outbox_rows_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint outbox_rows_question_fk foreign key (open_question_id) references open_questions (id) on delete restrict,
  constraint outbox_rows_copy_of_fk foreign key (copy_of_row_id) references outbox_rows (id) on delete restrict,
  constraint outbox_rows_bundle_fk foreign key (bundle_hash, bundle_build)
    references bundles (hash, build) on delete restrict,
  constraint outbox_rows_commit_seq_key unique (commit_seq),
  constraint outbox_rows_channel_known check (channel in ('imessage', 'rcs', 'sms', 'email')),
  constraint outbox_rows_send_class_known check (send_class in ('routine', 'quick_reply', 'visit_now', 'safety')),
  constraint outbox_rows_state_known check (
    state in (
      'planned', 'checked', 'sending', 'sent', 'delivered', 'held', 'dropped_stopped', 'stale', 'withdrawn',
      'failed', 'waiting_chat', 'superseded'
    )
  ),
  constraint outbox_rows_plan_object check (plan is null or jsonb_typeof(plan) = 'object'),
  constraint outbox_rows_final_parts_object check (final_parts is null or jsonb_typeof(final_parts) = 'object'),
  constraint outbox_rows_versions_list check (jsonb_typeof(versions_read) = 'array'),
  constraint outbox_rows_copy_is_email check (copy_of_row_id is null or channel = 'email')
);

-- The dispatcher sends each recipient's rows in commit order.
create index outbox_rows_recipient_order_idx on outbox_rows (recipient_handle_id, commit_seq);
-- After a crash only rows without a plan are composed again (arch 11 line 576).
create index outbox_rows_unplanned_idx on outbox_rows (turn_id) where plan is null;

create trigger outbox_rows_version_raised
  before update on outbox_rows
  for each row execute function enforce_version_raise();

alter table openers_sent
  add constraint openers_sent_outbox_fk foreign key (outbox_row_id) references outbox_rows (id) on delete restrict;

alter table messages
  add constraint messages_outbox_fk foreign key (outbox_row_id) references outbox_rows (id) on delete restrict;

-- One part of a row under one idempotency key (row, part, try): at most two sends, and a retry after a reported
-- failure is a new try under a new key (arch 01 line 65). The key is unique and is always '<row>/<part>/<try>'.
create table outbox_parts (
  outbox_row_id text not null,
  part_no integer not null,
  try_no integer not null,
  idempotency_key text not null,
  attempts integer not null default 1,
  kind text not null,
  linq_message_id text,
  linq_option_ids jsonb,
  state text not null,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  error_code text,
  version integer not null default 1,
  primary key (outbox_row_id, part_no, try_no),
  constraint outbox_parts_row_fk foreign key (outbox_row_id) references outbox_rows (id) on delete restrict,
  constraint outbox_parts_idempotency_key_key unique (idempotency_key),
  constraint outbox_parts_part_no check (part_no in (1, 2)),
  constraint outbox_parts_try_no check (try_no >= 1),
  constraint outbox_parts_attempts check (attempts >= 1),
  constraint outbox_parts_key_form check (idempotency_key = outbox_row_id || '/' || part_no || '/' || try_no),
  constraint outbox_parts_kind_known check (kind in ('words', 'poll', 'linkCard', 'tapback')),
  constraint outbox_parts_state_known check (state in ('pending', 'sent', 'delivered', 'failed'))
);

-- Delivery receipts find their part by Linq's message id (arch 02 line 127).
create index outbox_parts_linq_message_idx on outbox_parts (linq_message_id);

create trigger outbox_parts_version_raised
  before update on outbox_parts
  for each row execute function enforce_version_raise();
