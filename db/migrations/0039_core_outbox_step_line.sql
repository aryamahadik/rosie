-- T-1473: an outbox row holds its own step and line (K-04 v1.2 core, frozen: contracts/db-schema/core,
-- core.v1.2.tables.json and its README's section "v1.2", "The migration"; K-05 README open gap 29; DL-999 decision (e)
-- and card 4). outbox_rows only: a row may hold the step whose line it carries to its reader and that line's index among
-- the step's lines, both or neither, so a row that asks no question holds them too.
-- Expand only: two nullable columns with no default added after v1.1's columns, in the table list's order (step, then
-- line_no: README default 21); and three CHECKs, each added NOT VALID and then validated (0032's form), each expression
-- the table list's word for word: outbox_rows_step_form, outbox_rows_line_no_not_negative and
-- outbox_rows_step_with_line. No index (README default 26), no backfill and no row written or removed (default 27).
-- Nothing is dropped, renamed or retyped, and outbox_parts and every other table are untouched. No _contract_ step
-- follows: v1.2 keeps every v1.1 column.
--
-- Grants and row-level security do not change. 0012's table grants (SELECT, INSERT and UPDATE on outbox_rows to
-- rosie_app and rosie_job) cover the new columns, as a table grant covers every column (0032's header says the same of
-- v1.1's), and outbox_rows keeps 0012's two policies, which read business_id alone.
--
-- Safe to ship dark (build prompt 5.4): every writer on main names neither column, so every row it writes holds both
-- null and meets all three CHECKs; no reader on main names either. Validating reads the rows already there, each of
-- which holds both null: a row that broke one would fail this file, and the file's one transaction would leave nothing
-- applied. In that one transaction the lock each ALTER TABLE takes is held to the commit, the validating scans
-- included; on staging's few rows that is brief.
--
-- The database holds the form only (README default 25): no key or CHECK ties step to the row's bundle, line_no to the
-- step's lines, or a row's step to the step of the question it asks. Which K-05 call writes the two columns is K-05's
-- next minor version's (T-1474), and db/repo's build of it is T-1476's.

-- The step whose line the row carries to its reader, a K-01 step id.
alter table outbox_rows add column step text;
-- That line's index among the step's lines from Rosie to this reader, in the step's say order, 0 the first.
alter table outbox_rows add column line_no integer;

-- The form open_questions.step has (0009's open_questions_step_form), or none.
alter table outbox_rows
  add constraint outbox_rows_step_form check (step is null or step ~ '^[SAB](1[0-3]|[1-9])-x?[0-9]{2,3}$') not valid;
-- K-05 open gap 29's CHECK as written there: none, or not negative.
alter table outbox_rows
  add constraint outbox_rows_line_no_not_negative check (line_no is null or line_no >= 0) not valid;
-- Both or neither (DL-999 decision (e)): a step with no line, or a line with no step, is refused.
alter table outbox_rows
  add constraint outbox_rows_step_with_line check ((step is null) = (line_no is null)) not valid;

-- Every row already there is checked, so each CHECK holds for every row from here on.
alter table outbox_rows validate constraint outbox_rows_step_form;
alter table outbox_rows validate constraint outbox_rows_line_no_not_negative;
alter table outbox_rows validate constraint outbox_rows_step_with_line;
