-- T-1278: outbox rows with no turn (K-04 v1.1 core, frozen: contracts/db-schema/core, core.v1.1.tables.json and its
-- README's section "v1.1"; ADR-016 section 1 and section 7's card M1; DL-526, DL-545). The two outbox tables only: a row
-- written by work with no turn carries a job id in place of a turn id, an email row may name its K-12 purpose, a row may
-- name the time from which no part of it is sent, and a delivered part holds its delivery time (CQ-211).
-- Expand only: outbox_rows.turn_id's NOT NULL dropped (the migration guard lets DROP NOT NULL pass and holds SET NOT
-- NULL as contracting; outbox_rows_turn_fk to turns stays as 0010 made it); three nullable columns with no default
-- added after v1's columns, in the table list's order (job_id, email_purpose, not_after: README default 14); and five
-- CHECKs, each added NOT VALID and then validated (CQ-211's form): outbox_rows_turn_or_job,
-- outbox_rows_email_purpose_known, outbox_rows_email_purpose_is_email, outbox_rows_code_has_not_after and
-- outbox_parts_delivered_has_time, each expression the table list's word for word. outbox_rows_job_idx is built
-- concurrently in the next file, alone, since PostgreSQL refuses CREATE INDEX CONCURRENTLY inside a transaction and the
-- runner runs this file in one (the migration skill's rule for an index on an existing table). Nothing is dropped,
-- renamed or retyped, and no row is written or removed. No _contract_ step follows: v1.1 keeps every v1 column.
--
-- Grants and row-level security do not change. 0012's table grants (SELECT, INSERT and UPDATE on outbox_rows to
-- rosie_app and rosie_job; on outbox_parts to rosie_job) cover the new columns, as a table grant covers every column,
-- and outbox_rows keeps 0012's two policies on business_id: a job row, which names no business, is seen by no business
-- scope, and by the runtime side only with no scope (K-04 rule 4).
--
-- Safe to ship dark (build prompt 5.4): every writer on main fills turn_id and names no job id, purpose or not_after,
-- and the only code that moves a part to delivered (db/repo/outbox.ts) always sets delivered_at (CQ-211), so every row
-- main writes meets every new CHECK. Validating reads the rows already there: a row that broke one would fail this file,
-- and the file's one transaction would leave nothing applied. In that one transaction the lock each ALTER TABLE takes is
-- held to the commit, the validating scans included; on staging's few rows that is brief.
--
-- No job row is written before K-05's sign-in version (T-1277) and the readers' guard (T-1279): until they land,
-- readOutboxRow throws on a row with no turn (CQ-248's default, ADR-016 open point 12), and no code on main writes one.

-- A call made alone has no turn (arch 01 line 59; K-08 v1.1 default 9): its row names its job id instead.
alter table outbox_rows alter column turn_id drop not null;

-- The work with no turn that wrote the row: for a sign-in code's email row, its attempt's server-made id (ADR-016
-- section 4; CQ-09), never the page's attempt id, the code, its hash or the address.
alter table outbox_rows add column job_id text;
-- For an email row, one of K-12 v1's six purposes as K-12 spells them (README default 11).
alter table outbox_rows add column email_purpose text;
-- No part of the row is sent at or after it (limit 8, at every try); a code row's is its code's expires_at.
alter table outbox_rows add column not_after timestamptz;

-- The event log's own rule (0011's event_log_turn_or_job).
alter table outbox_rows
  add constraint outbox_rows_turn_or_job check (turn_id is not null or job_id is not null) not valid;
-- Null, or one of K-12 v1's six purposes, on an email row only (README default 12: two CHECKs, one fault each).
alter table outbox_rows
  add constraint outbox_rows_email_purpose_known check (
    email_purpose is null or email_purpose in ('confirmation', 'copy', 'emailWay', 'nextWay', 'code', 'notice')
  ) not valid;
alter table outbox_rows
  add constraint outbox_rows_email_purpose_is_email check (email_purpose is null or channel = 'email') not valid;
-- A code dies 10 minutes after it is made (RULES 6.2), and a retry never sends a dead code (ADR-016 section 3).
alter table outbox_rows
  add constraint outbox_rows_code_has_not_after check (
    email_purpose is null or email_purpose <> 'code' or not_after is not null
  ) not valid;
-- CQ-211: a delivered part holds its delivery time.
alter table outbox_parts
  add constraint outbox_parts_delivered_has_time check (state <> 'delivered' or delivered_at is not null) not valid;

-- Every row already there is checked, so each CHECK holds for every row from here on.
alter table outbox_rows validate constraint outbox_rows_turn_or_job;
alter table outbox_rows validate constraint outbox_rows_email_purpose_known;
alter table outbox_rows validate constraint outbox_rows_email_purpose_is_email;
alter table outbox_rows validate constraint outbox_rows_code_has_not_after;
alter table outbox_parts validate constraint outbox_parts_delivered_has_time;
