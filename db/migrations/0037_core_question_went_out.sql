-- T-1457: the Tool API's role reads when an open question went out and the poll it went out as, through one narrow
-- security-definer function, never through a grant on a table that spans businesses (lead card from T-1448's open
-- question 1, "serious", and its security reviewer's note a; K-05 v1.2 item 26, default 41; K-04 v1 rule 4).
-- Expand only: one new function, its EXECUTE revoked from PUBLIC and granted to the two roles 0012 made (never created
-- or altered here). Nothing is dropped, renamed or retyped, no row is written or removed, and no table, column, table
-- grant, policy or role changes. 0012's role comment (its lines 15 to 20) stays true: rosie_app gains EXECUTE on one more
-- function, as 0018 gave it handles_id_of_mobile, and holds no grant on a table that spans businesses.
--
-- Why. db/repo/targets.ts liveOpenQuestionsOfHandle, the open questions' read limits 3 and 4 make (K-05 v1.2's
-- openQuestionRead), joins outbox_rows and outbox_parts for when each question went out and its poll. 0012 grants
-- outbox_parts to rosie_job alone (its lines 98 to 103), so under rosie_app, the gate's real side (staging's
-- HYPERDRIVE_APP), the read fails with 42501 "permission denied for table outbox_parts" and no answer to an open question
-- passes limits 3 and 4 there: closed, not leaked. The bound (T-1448's security reviewer, note a): rosie_app is never
-- granted turns, outbox_parts, person_handles, phones, handles or threads, which have no row-level security, since a grant
-- would show the Tool API every business's rows.
--
-- What it answers: for the one question its id names, the two values liveOpenQuestionsOfHandle's join gives, by the same
-- rule (default 41): only the outbox rows that ask the question and go to its own handle count, and only their parts
-- sent or delivered; sent_at is the latest coalesce(sent_at, delivered_at), and poll_id the Linq message id of the latest
-- such part of kind poll (ties broken by commit_seq, part_no and try_no, newest first). Nothing of it gone: no row.
--
-- The bound, checked inside the function, never trusting the id handed in: the question's own business must equal the
-- caller's scope, rosie.business_id (K-04 rule 4), which a security-definer function reads from the caller's settings
-- (0018's lines 19 to 21); nullif(..., '') makes a setting never set and one that ended both "no scope". So another
-- business's question, a question with no business, any question with no scope, and an id no question has answer no
-- row. Each outbox row counted is of that business too, as outbox_rows' row-level security leaves rosie_job's join under
-- that scope (0012's lines 260 to 272): under one business's scope both roles' reads give the same answer
-- (db/repo/targets-app.int.test.ts compares them).
--
-- What it reads: the question's own row (open_questions, by its id, for its business and handle: a business-scoped table
-- rosie_app already reads behind its policy) and, by the question's id, outbox_rows and outbox_parts; no other table,
-- never turns, person_handles, phones, handles or threads. Only a time and a Linq message id leave it: never a part's
-- words, idempotency key, option ids or error code, and nothing of another business.
--
-- Why this form, the narrowest: a grant on outbox_parts is what note a rules out (no business column, no row-level
-- security); a view would be a new grant on a relation that reads every business's parts; reading on rosie_job would take
-- a second connection beside the call's own transaction, outside its one moment. K-05's call and its answer stay as they
-- are. One function answering two values for one question of the caller's own business is the least the read needs.
--
-- The form, as 0012's and 0018's: owned by the migrations' role, which owns the tables and so is not bound by row-level
-- security (0012's line 28); security definer; stable; search_path pinned to pg_catalog, pg_temp; bound to this schema's
-- tables when made (BEGIN ATOMIC), so no name is looked up when it runs and no caller's search_path or temporary table
-- can change what it reads. EXECUTE: rosie_app and rosie_job only, never PUBLIC. Neither role owns it, so neither can
-- alter it.
--
-- Safe to ship dark (build prompt 5.4): no code on main calls it. db/repo/targets.ts (this card) calls it only for a role
-- that may not select from outbox_parts; rosie_job and the tables' owner keep the join as it was.
create function open_questions_went_out(question_wanted text)
returns table (sent_at timestamptz, poll_id text)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
begin atomic
  select max(coalesce(p.sent_at, p.delivered_at)),
         (array_agg(p.linq_message_id
                    order by coalesce(p.sent_at, p.delivered_at) desc, r.commit_seq desc, p.part_no desc,
                             p.try_no desc)
            filter (where p.kind = 'poll'))[1]
    from open_questions q
    join outbox_rows r
      on r.open_question_id = q.id
     and r.recipient_handle_id = q.handle_id
     and r.business_id = q.business_id
    join outbox_parts p on p.outbox_row_id = r.id
    where q.id = open_questions_went_out.question_wanted
      and q.business_id = nullif(current_setting('rosie.business_id', true), '')
      and p.state in ('sent', 'delivered')
    group by q.id;
end;

revoke all on function open_questions_went_out(text) from public;
grant execute on function open_questions_went_out(text) to rosie_app, rosie_job;
