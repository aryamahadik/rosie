-- T-1333: the migrations' role may SET ROLE to rosie_app and rosie_job where it is no superuser, as on staging (Neon),
-- so the seed runner writes as rosie_job there (DL-634: seed:staging stopped at its first set, core, with "permission
-- denied to set role "rosie_job"", 42501, and wrote nothing).
-- Expand only: at most two role-membership grants, each to the role that runs this file and to no other. Nothing is
-- made, dropped, renamed, retyped or revoked, and no row of any table is written or removed.
--
-- Why. 0012 makes rosie_app and rosie_job as the migrations' role (its lines 49 to 76). PostgreSQL 16 and later: "When a
-- non-superuser creates a role using the CREATEROLE privilege, the created role is automatically granted back to the
-- creating user, just as if the bootstrap superuser had executed the command GRANT created_user TO creating_user WITH
-- ADMIN TRUE, SET FALSE, INHERIT FALSE", so "the CREATEROLE user doesn't inherit the privileges of the created role, nor
-- can it access the privileges of that role using SET ROLE" (PostgreSQL 17, Role Attributes), unless the server's
-- createrole_self_grant names set (its default is empty). And SET ROLE asks it of the session's own login: "The current
-- session user must have the SET option for the specified role_name ... (If the session user is a superuser, any role
-- can be selected.)" (PostgreSQL 17, SET ROLE). Staging's server reports PostgreSQL 17.11 (infra/spikes/hyperdrive-host/
-- FINDINGS.md lines 11 and 50) and its migrations' role is no superuser (ADR-014); the seed runner logs in as that role
-- (infra/scripts/seed-staging.sh) and each set switches with SET LOCAL ROLE rosie_job (db/seeds/core.ts line 90), which
-- is refused. rosie_app, made in the same block, has the same gap. Locally and in CI the migrations' role is the
-- superuser rosie, which may become any role, so no test met it there.
--
-- What it does: for each of rosie_app and rosie_job, only when all of these hold,
--   1. the server is PostgreSQL 16 or later (the maker's row, a grant's SET and INHERIT options and pg_has_role's SET are
--      new in 16; an older server has nothing here to change);
--   2. the role running this file (current_user) is no superuser (a superuser may become any role: a no-op locally);
--   3. it may not SET ROLE to that role yet (pg_has_role ... 'SET'; a later run, in another schema, finds it may);
--   4. it holds, as its own member, a row of pg_auth_members for that role WITH ADMIN OPTION: the maker's row above.
--      So the grant adds an option to a membership the role already has and never makes a new one, and it is never
--      given through another role's ADMIN OPTION;
-- it grants that role to itself WITH SET TRUE, INHERIT FALSE, which the same page says a maker may do: "the CREATEROLE
-- user can gain access to the created role by simply granting that role back to themselves with the INHERIT and/or SET
-- options". PostgreSQL records it with the role itself as grantor, on a row of its own beside the maker's row, which
-- stays as it is. SET TRUE lets it become the role, as the seeds do inside their transaction; INHERIT FALSE gives it
-- none of the role's privileges and none of its policies while it is itself (a policy binds the roles whose privileges
-- a user has). Where 4 does not hold, nothing changes and the seed runner still refuses: this file never fails a deploy
-- for it.
--
-- What does not change: no other role is granted anything, so no login gains a membership it did not have. 0012's rule
-- holds: the deploy names the login role that is granted one of the two, never both (ADR-014: rosie_worker_job inherits
-- rosie_job only and rosie_worker_app rosie_app only, each WITH INHERIT TRUE, SET FALSE; worker-logins.sql reads their
-- memberships by member, and this file adds none). The migrations' role owns every table, so it already bypasses
-- row-level security (0012 line 28): becoming rosie_job narrows what it may do and never widens it.
--
-- The roles are cluster-wide and every schema on one server runs this file: the first run grants and each later one
-- finds the grant (3). PostgreSQL changes one role's memberships in one transaction at a time, so a run beside it waits
-- for that grant, then finds it made and adds nothing.
do $$
declare
  role_name text;
begin
  if pg_catalog.current_setting('server_version_num')::integer < 160000 then
    return;
  end if;
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname = current_user and r.rolsuper) then
    return;
  end if;
  foreach role_name in array array['rosie_app', 'rosie_job']::text[] loop
    if not pg_catalog.pg_has_role(current_user, role_name::pg_catalog.name, 'SET') then
      if exists (
        select 1
          from pg_catalog.pg_auth_members m
          join pg_catalog.pg_roles granted on granted.oid = m.roleid
          join pg_catalog.pg_roles holder on holder.oid = m.member
          where granted.rolname = role_name
            and holder.rolname = current_user
            and m.admin_option
      ) then
        -- Through EXECUTE, so a server older than 16 never parses the SET and INHERIT options (1 returns first there).
        execute pg_catalog.format('grant %I to current_user with set true, inherit false', role_name);
      end if;
    end if;
  end loop;
end
$$;
