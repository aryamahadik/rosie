-- T-191: row-level security per business on every business-scoped core table, the two application roles with their
-- grants, and the two reads reserve() makes across businesses (K-04 v1 core, frozen: contracts/db-schema/core, README
-- rule 4; K-05 v1 README "Scope" and item 8; lead card T-1085 folded in, DL-111).
-- Expand only: two roles (made only when missing), grants, row-level security switched on with two policies on each of
-- the 13 tables whose rowLevelSecurity.scope is business, and two new functions. Nothing is dropped, renamed or retyped,
-- and no row is written or removed. Each later domain migration adds its own policies in the same pattern (T-192 on).
--
-- The scope (K-04 rule 4; K-05 "Scope"): the setting rosie.business_id, set for one transaction by withBusiness()
-- (db/repo/scope.ts, T-180) with set_config(..., true), so it ends with the transaction. A setting never set reads as
-- null and one that ended reads as ''; nullif(..., '') makes both "no scope".
--
-- The roles are cluster-wide, and every schema on one server (each test schema, each preview, merge-check's database)
-- runs this file, so each is made only when missing; the grants and policies are per schema. Both are NOLOGIN: the
-- deploy names the login role that is granted one of them (never both: a member of both would take both policies).
--   rosie_app  The Tool API (K-05 scope business). It sees and writes only rows whose business column equals its scope,
--              and with no scope none; a row whose business column is null is seen by no scope. NOBYPASSRLS, owns no
--              table, and holds grants only on the 13 business-scoped tables (behind their policies) and EXECUTE on
--              the two functions below: none on a table that spans businesses (persons, handles, person_handles,
--              phones, threads, turns, outbox_parts, sealing_keys, bundles, bundle_values) or on release_flags
--              (QUESTIONS.md CQ-59: no select on release_flags, no update on bundle_values).
--   rosie_job  The runtime side (K-05 scope runtime: the guard, the dispatcher, the clock sweep, the gateway's
--              recordProviderEvent, the publisher). With no scope it sees every business's rows; with a scope set
--              (K-05's per write, and a business-scoped read that also needs a cross-business table) only that
--              business's, and a row with no business only with no scope. NOBYPASSRLS: it reads across businesses
--              through its own policies, never by bypass, so a new table it has no policy on shows it nothing. It is
--              the guard's role: the only role that reads phones, handles and sealing keys (cross-business by design,
--              MC C1). It owns nothing.
-- A superuser and a table's owner (the migrations' role) bypass row-level security; no table forces it on its owner.
--
-- Grants: SELECT and INSERT; UPDATE only on the versioned tables (K-04 rule 2: handles, person_handles, openers_sent,
-- event_log and bundle_values are written once and never take an update); DELETE only on person_handles, for the runtime
-- (a person's link to a handle is added or removed, never updated: K-05 item 29); no TRUNCATE, REFERENCES or TRIGGER on
-- any table. So event_log takes INSERT and SELECT only from both roles (K-04 rule 5: an update or a delete is refused by
-- privilege, 42501, before 0011's trigger, which stays as the second guard; TRUNCATE, which no row trigger sees, is never
-- granted), and neither role owns event_log or event_log_refuse_edit().
--
-- Two reads cross businesses on purpose (K-05 item 8; T-1085), so row-level security cannot hide what they must count:
-- the saved times a mobile holds at every business (the cap of 2, arch 05 line 247), after locking its phones row so two
-- parallel reserves for one mobile run one after the other; and whether a booked time covers the asked one for the
-- resource or, for a worker, the person at any business (FS line 743). Each is a security-definer function owned by the
-- migrations' role, which owns the tables and so reads every business's rows (an owner is not bound by row-level
-- security). It is not given to rosie_job: a role that is not a superuser may hand a function to a new owner only if it
-- may act as that owner and the owner may create objects in the schema, and neither is wanted; and since neither
-- application role owns them, neither can alter them. Each has a pinned search_path, and its body is bound to this
-- schema's tables when it is made (BEGIN ATOMIC), so no name is looked up when it runs and no caller's search_path or
-- temporary table can change what it reads. Only the held rows' ids and ends, or yes or no, leave them. EXECUTE: the two
-- roles only, never PUBLIC.

-- The two roles, made only when missing. Two schemas migrating at once may both find a role missing: the second CREATE
-- then fails as a duplicate and is skipped. A role found with the power to bypass row-level security is refused.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'rosie_app') then
    begin
      create role rosie_app nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    exception
      when duplicate_object or unique_violation then
        null;
    end;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'rosie_job') then
    begin
      create role rosie_job nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    exception
      when duplicate_object or unique_violation then
        null;
    end;
  end if;
  if exists (
    select 1 from pg_roles where rolname in ('rosie_app', 'rosie_job') and (rolsuper or rolbypassrls)
  ) then
    raise exception 'rosie_app and rosie_job must not be superusers or bypass row-level security'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- This file's schema (a test or preview schema; public, where every role already has it, is left as it is), whose name
-- is known only when it runs.
do $$
begin
  if not has_schema_privilege('rosie_app', current_schema(), 'USAGE')
    or not has_schema_privilege('rosie_job', current_schema(), 'USAGE') then
    execute format('grant usage on schema %I to rosie_app, rosie_job', current_schema());
  end if;
end
$$;

-- Business-scoped tables, versioned: both roles, behind the policies below.
grant select, insert, update on
  businesses, person_roles, messages, bookings, pauses, resources, class_seats, reservations, open_questions,
  clock_rows, outbox_rows
to rosie_app, rosie_job;

-- Business-scoped tables written once: no update.
grant select, insert on openers_sent, event_log to rosie_app, rosie_job;

-- Tables that span businesses (scope none): the runtime side only.
grant select, insert, update on
  persons, phones, threads, turns, outbox_parts, bundles, release_flags, sealing_keys
to rosie_job;
grant select, insert on handles, person_handles, bundle_values to rosie_job;
grant delete on person_handles to rosie_job;

-- Row-level security: rosie_app sees only its scope; rosie_job sees everything with no scope, else only its scope.
alter table businesses enable row level security;
create policy businesses_tool_api on businesses for all to rosie_app
  using (id = nullif(current_setting('rosie.business_id', true), ''))
  with check (id = nullif(current_setting('rosie.business_id', true), ''));
create policy businesses_runtime on businesses for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table person_roles enable row level security;
create policy person_roles_tool_api on person_roles for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy person_roles_runtime on person_roles for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table openers_sent enable row level security;
create policy openers_sent_tool_api on openers_sent for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy openers_sent_runtime on openers_sent for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table messages enable row level security;
create policy messages_tool_api on messages for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy messages_runtime on messages for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table bookings enable row level security;
create policy bookings_tool_api on bookings for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy bookings_runtime on bookings for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table pauses enable row level security;
create policy pauses_tool_api on pauses for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy pauses_runtime on pauses for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table resources enable row level security;
create policy resources_tool_api on resources for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy resources_runtime on resources for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table class_seats enable row level security;
create policy class_seats_tool_api on class_seats for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy class_seats_runtime on class_seats for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table reservations enable row level security;
create policy reservations_tool_api on reservations for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy reservations_runtime on reservations for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table open_questions enable row level security;
create policy open_questions_tool_api on open_questions for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy open_questions_runtime on open_questions for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table clock_rows enable row level security;
create policy clock_rows_tool_api on clock_rows for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy clock_rows_runtime on clock_rows for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table outbox_rows enable row level security;
create policy outbox_rows_tool_api on outbox_rows for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy outbox_rows_runtime on outbox_rows for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table event_log enable row level security;
create policy event_log_tool_api on event_log for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy event_log_runtime on event_log for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

-- K-05 item 8: the saved times (held, ending after `held_after`) a mobile holds at every business, after its phones row
-- is locked FOR UPDATE for the rest of the caller's transaction. Each statement takes a fresh snapshot (a volatile
-- function), so the count sees what a parallel reserve committed while this one waited for the lock.
create function reservations_saved_times(phone_wanted text, held_after timestamptz)
returns table (id text, held_until timestamptz)
language sql
volatile
security definer
set search_path = pg_catalog, pg_temp
begin atomic
  select 1 from phones p where p.number = reservations_saved_times.phone_wanted for update;
  select r.id, r.held_until
    from reservations r
    where r.for_phone_number = reservations_saved_times.phone_wanted
      and r.state = 'held'
      and r.held_until > reservations_saved_times.held_after
    order by r.held_until, r.id;
end;

-- Whether a booked time overlaps `during_wanted` for the resource or, for a worker, the person at any business.
create function reservations_booked_overlap(resource_wanted text, worker_wanted text, during_wanted tstzrange)
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
          r.resource_id = reservations_booked_overlap.resource_wanted
          or r.worker_person_id = reservations_booked_overlap.worker_wanted
        )
  );
end;

revoke all on function reservations_saved_times(text, timestamptz) from public;
revoke all on function reservations_booked_overlap(text, text, tstzrange) from public;
grant execute on function reservations_saved_times(text, timestamptz) to rosie_app, rosie_job;
grant execute on function reservations_booked_overlap(text, text, tstzrange) to rosie_app, rosie_job;
