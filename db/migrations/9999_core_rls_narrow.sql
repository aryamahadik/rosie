-- T-1094: the definer functions answer only what K-05 needs, a business-scoped call gets a narrow read of one mobile's
-- handle, chat_links' update grant narrows to the columns that may change while a trigger keeps its ready text and code
-- as issued and lets its places only grow, and the Tool API's role loses its grants on effects and provider_events (lead
-- card from T-191's reviews: the security reviewer's notes b and c, the architect's notes a, d and e; DL-121 with T-192's
-- security note N4; round 2's rulings on the security reviewer's two gaps, DL-149; QUESTIONS.md CQ-30 and CQ-70's
-- defaults).
-- Expand only: one function's body replaced by CREATE OR REPLACE FUNCTION with the same name, arguments and result (so
-- its owner and its EXECUTE grants stay 0012's), one new function with its grant, chat_links' UPDATE grant narrowed
-- from the whole row to four of its columns, one trigger function and its trigger on chat_links, and rosie_app's grants
-- on effects and provider_events (0015) revoked. Nothing is dropped, renamed or retyped, and no row is written or removed.
-- Safe to ship dark: reserve() asks reservations_booked_overlap only about its own business's resource and that
-- resource's worker, which the narrowed body answers as before; no code on main calls the new function; no code on main
-- updates chat_links (db/repo/consent.ts inserts and reads it, db/repo/send-state.ts reads its version, and commitTurn's
-- state writes in db/repo/commit-turn.ts may name the table, but no caller on main builds such a write); and every call
-- that reads or writes effects or provider_events runs on the runtime side as rosie_job (K-05 README, v1.1's calls).
-- Until the Worker's login role is granted one of the two roles (T-1093), calls run as the tables' owner, whom no grant
-- stops; the trigger binds it too.
--
-- The caller's business scope, which the two functions below read, is K-04 rule 4's setting rosie.business_id: a
-- security-definer function runs with its owner's rights but sees the caller's settings, and nullif(..., '') makes a
-- setting never set and one that ended both "no scope", as the policies of 0012 do.

-- reservations_booked_overlap (0012, K-05 item 8; T-1085), narrowed: whether a booked time overlaps `during_wanted` for
-- the resource, within the caller's business scope only, or for the worker at any business. Only a worker's booked time
-- crosses businesses (FS line 743: "A booking in any of their businesses blocks that time in all of them"), so another
-- business's room, vehicle or class session answers nothing, as does a worker resource of another business asked about
-- by its id alone; with no scope the resource is matched nowhere. A saved (held) time never counts here:
-- reservations_saved_times (0012, unchanged) stays the only read of saved times across businesses, and it answers only
-- their ids and ends.
create or replace function reservations_booked_overlap(resource_wanted text, worker_wanted text, during_wanted tstzrange)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
begin atomic
  select exists (
    select 1
      from reservations r
      where r.state = 'booked'
        and r.during && reservations_booked_overlap.during_wanted
        and (
          (
            r.resource_id = reservations_booked_overlap.resource_wanted
            and r.business_id = nullif(current_setting('rosie.business_id', true), '')
          )
          or (
            r.resource_kind = 'worker'
            and r.worker_person_id = reservations_booked_overlap.worker_wanted
          )
        )
  );
end;

-- K-05 item 8 (a held row's saved-time clock row is owned by the mobile's handle) and v1.2 item 26 (readTurnState): a
-- business-scoped call runs as rosie_app, which holds no grant on handles or phones (MC C1; 0012), so this answers it
-- the handle id of the one mobile it names, and nothing more: the id alone, or nothing (null) for a number no phone
-- handle has, for an address that is not a mobile's, and with no business scope (the runtime side reads handles
-- itself). Owned by the migrations' role, bound when made, search_path pinned, as 0012's two functions are. EXECUTE:
-- rosie_app only (rosie_job holds SELECT on handles), never PUBLIC.
create function handles_id_of_mobile(mobile_wanted text)
returns text
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
begin atomic
  select h.id
    from handles h
    where h.address = handles_id_of_mobile.mobile_wanted
      and h.kind = 'phone'
      and nullif(current_setting('rosie.business_id', true), '') is not null;
end;

revoke all on function handles_id_of_mobile(text) from public;
grant execute on function handles_id_of_mobile(text) to rosie_app;

-- chat_links (0013, K-29 v1): UPDATE narrows from the whole row to the four columns K-29 changes (README: given_via
-- grows as the link is given in a new place, owner_retold_at records the owner told again, used_at the ready text
-- arriving; rule 2: every update raises the version). So neither role can change the ready text, kept as issued so the
-- text that arrives matches it (table list line 71), nor the link's code, purpose, business, booking, person, mobile or
-- issue time. A grant cannot hold given_via to growing (line 79: none is removed), since UPDATE on a column takes any
-- value; the trigger below does. SELECT ... FOR UPDATE needs UPDATE on one column only, which both keep.
revoke update on chat_links from rosie_app, rosie_job;
grant update (given_via, owner_retold_at, used_at, version) on chat_links to rosie_app, rosie_job;

-- Kept as issued, and the places only grow (K-29 v1 table list line 71: the ready text is "Kept as issued, so the text
-- that arrives can be matched to it"; line 79: given_via, "A new place is added to the list; none is removed"; DL-149):
-- an update that changes a link's short code or ready text, or whose given_via leaves out a place the link was given,
-- is refused with SQLSTATE 42501 (insufficient_privilege), whoever runs it, the tables' owner included, as 0013 refuses
-- every edit of a consent row. The two roles meet the column grants first for the code and the text; given_via they may
-- update, so for them the trigger is what refuses a shrink. The error names the table and the column, never a value. A
-- new place added, the same places in another order, and every update that leaves the three as they are, pass.
create function chat_links_refuse_rewrite() returns trigger
language plpgsql
as $$
begin
  if new.short_code is distinct from old.short_code then
    raise exception '% on % is not allowed: a chat link''s short code is kept as issued', tg_op, tg_table_name
      using errcode = 'insufficient_privilege',
            table = tg_table_name,
            column = 'short_code';
  end if;
  if new.ready_text is distinct from old.ready_text then
    raise exception '% on % is not allowed: a chat link''s ready text is kept as issued', tg_op, tg_table_name
      using errcode = 'insufficient_privilege',
            table = tg_table_name,
            column = 'ready_text';
  end if;
  if not (new.given_via @> old.given_via) then
    raise exception '% on % is not allowed: a chat link''s places only grow, none is removed', tg_op, tg_table_name
      using errcode = 'insufficient_privilege',
            table = tg_table_name,
            column = 'given_via';
  end if;
  return new;
end;
$$;

create trigger chat_links_kept_as_issued
  before update on chat_links
  for each row execute function chat_links_refuse_rewrite();

-- effects and provider_events (0015, K-07 v1's schema addition): rosie_app, the Tool API, loses SELECT, INSERT and
-- UPDATE on both (least privilege; the security reviewer's GAP 2 on T-1094, DL-149). Every K-05 v1.1 call that reads or
-- writes them runs on the runtime side as rosie_job (K-05 README, v1.1's table: claimEffects, recordEffectResult,
-- serviceBack, recordProviderEvent and reconciliationRefund, and commitTurn and fireClock per write), and no Tool API
-- call reads them (reserve, release and extend touch neither). With INSERT, a Tool API path could queue a pending Stripe
-- effect that claimEffects (unscoped) runs with no yes behind it, or take a (provider, event id) first, so
-- recordProviderEvent drops the real event as a repeat; with UPDATE it could change a pending effect. rosie_job keeps
-- SELECT, INSERT and UPDATE behind 0015's policies. The two <table>_tool_api policies stay (expand only) and now let
-- nothing through. A later Tool API path that must read or write one (staging's Fire now, if it is ruled to run as
-- rosie_app; a K-21 page) is granted only what it needs, in its own task.
revoke select, insert, update on effects, provider_events from rosie_app;
