-- T-1463: the Tool API's role reads whether a sign-up's sender writes from the turn's handle, limit 1's default 14 fact
-- (c), through one narrow security-definer function, never through a grant on a table that spans businesses (the
-- architect's N2 on T-1459, after T-1459's builder's handoff 1 and its security reviewer's note b; DL-961, DL-964; K-04
-- v1 rule 4).
-- Expand only: one new function, its EXECUTE revoked from PUBLIC and granted to the two roles 0012 made (never created
-- or altered here). Nothing is dropped, renamed or retyped, no row is written or removed, and no table, column, table
-- grant, policy or role changes. 0012's role comment (its lines 15 to 20) stays true: rosie_app gains EXECUTE on one more
-- function, as 0018 and 0037 gave it theirs, and holds no grant on a table that spans businesses.
--
-- Why. Default 14 (actions/src/gate/limit-1/allowed.ts, T-1459) passes a sign-up's own answer to an open question only
-- when, beside its other facts, (c) the sender's person is linked to the turn's handle (K-04 person_handles) and (d) the
-- business's control is not proven (K-23 business_setup.control_proven_at null). T-1459 read both through K-05 v1.2's
-- readTurnState, whose first statement reads handles (db/repo/turn-state.ts line 792) and whose link read joins
-- person_handles and persons (its lines 818 to 824). 0012 grants those tables to rosie_job alone (its lines 98 to 103),
-- so under rosie_app, the gate's real side (staging's HYPERDRIVE_APP; ADR-014; DL-950), the read failed with 42501 and
-- the call failed: closed, not leaked. (d) needs no new privilege: rosie_app already selects business_setup under one
-- business's scope (0019's lines 48 to 58). (c) does, and a grant on person_handles would show the Tool API every
-- business's links of people to handles (DL-950 note a).
--
-- What it answers: whether the person it names writes from the handle it names, true only when both hold, else false:
--   - person_handles links the person to the handle;
--   - the handle has a live open question (waiting or open, as open_questions_handle_live_idx and
--     db/repo/targets.ts liveOpenQuestionsOfHandle read live) of the business the caller's scope names.
-- A boolean, never an id, a count or a row: nothing of the handle, its address, its other people, the question or another
-- business leaves it.
--
-- The bound, checked inside the function, never trusting the ids handed in: the question's business must equal the
-- caller's scope, rosie.business_id (K-04 rule 4), which a security-definer function reads from the caller's settings
-- (0018's lines 19 to 21); nullif(..., '') makes a setting never set and one that ended both "no scope", so with no scope
-- it answers false. So a caller can probe only the handles its own business has a live question on, which rosie_app
-- already reads behind open_questions_tool_api (0012's lines 232 to 235). A handle whose only live questions are another
-- business's or have no business, a handle with none live, a person not linked to the handle, an id no row has, and any
-- pair with no scope answer false. Default 14 asks it only once its fact (b) has found such a question on the handle,
-- asked of the sender, so under the call's scope the bound never changes default 14's answer.
--
-- What it reads: person_handles by its key (person_id, handle_id), and open_questions by the handle through
-- open_questions_handle_live_idx (0009's line 91); no other table, never handles, persons, phones, threads or turns.
--
-- Why this form, the narrowest: a grant on person_handles is what DL-950 note a rules out (no business column, no
-- row-level security); a view would be a new grant on a relation that reads every business's links; reading on rosie_job
-- would take a second connection beside the call's own transaction, outside its one moment. One function answering yes
-- or no for one person on one handle that the caller's own business has a live question on is the least the read needs.
--
-- The form, as 0012's, 0018's and 0037's: owned by the migrations' role, which owns the tables and so is not bound by
-- row-level security (0012's line 28); security definer; stable; search_path pinned to pg_catalog, pg_temp; bound to this
-- schema's tables when made (BEGIN ATOMIC), so no name is looked up when it runs and no caller's search_path or temporary
-- table can change what it reads. EXECUTE: rosie_app and rosie_job only, never PUBLIC. Neither role owns it, so neither
-- can alter it.
--
-- Safe to ship dark (build prompt 5.4): no code on main calls it. db/repo/sign-up-reads.ts (this card) calls it only for
-- a role that may not select from person_handles; rosie_job and the tables' owner read the link directly, as before.
create function person_handles_linked(person_wanted text, handle_wanted text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
begin atomic
  select exists (
           select 1
             from person_handles ph
             where ph.person_id = person_handles_linked.person_wanted
               and ph.handle_id = person_handles_linked.handle_wanted
         )
     and exists (
           select 1
             from open_questions q
             where q.handle_id = person_handles_linked.handle_wanted
               and q.business_id = nullif(current_setting('rosie.business_id', true), '')
               and q.status in ('waiting', 'open')
         );
end;

revoke all on function person_handles_linked(text, text) from public;
grant execute on function person_handles_linked(text, text) to rosie_app, rosie_job;
