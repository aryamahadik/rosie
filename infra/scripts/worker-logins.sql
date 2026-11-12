-- The Worker's two database logins (ADR-014 sections 1 and 3, and section 4's piece 1; T-1252). One DO block, made the
-- way db/migrations/0012_core_rls.sql makes rosie_app and rosie_job (its lines 49 to 76). Not a migration: the logins
-- are cluster-wide and take no password here. create-staging-hyperdrive.mjs runs it on staging, as the migrations'
-- role, before it sets a password (piece 2); the Workers test rig and `npm run db:logins` will run it on the local and
-- CI servers (piece 5). T-1093's deploy-time check reads the same shape.
--
--   rosie_worker_job  the runtime side (K-05 scope runtime), stored by rosie-staging-hyperdrive-job (HYPERDRIVE_JOB):
--                     granted rosie_job, and nothing else.
--   rosie_worker_app  the Tool API (K-05 scope business), stored by rosie-staging-hyperdrive-app (HYPERDRIVE_APP):
--                     granted rosie_app, and nothing else.
--
-- What it does, in one statement and so in one transaction:
--  1. It refuses a server older than PostgreSQL 16 (server_version_num below 160000): a grant's INHERIT and SET options
--     are new in 16. Every CREATE and GRANT below runs through EXECUTE, so on an older server this check, and not a
--     syntax error in a statement it cannot parse, is what stops the block.
--  2. It makes each login only when it is missing: LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS,
--     with no password, and at once grants it its one role WITH INHERIT TRUE, SET FALSE, so no login is ever left made
--     but not granted. Two runs at once may both find a login missing: the second CREATE then fails as a duplicate and
--     is skipped, as 0012 skips a role made beside it; the first run makes and grants the login.
--  3. It reads each login and refuses one in any other shape, naming what is wrong. It never repairs one:
--      - the flags: LOGIN, and none of SUPERUSER, CREATEDB, CREATEROLE, REPLICATION and BYPASSRLS;
--      - the memberships, read by member (the rows of pg_auth_members whose member is the login): exactly one, its role,
--        with inherit true, set false and admin false. A row whose roleid is the login is not the login's own: where a
--        role that is not a superuser makes the login (staging's migrations' role), PostgreSQL 16 and later grant the
--        new login back to its maker WITH ADMIN TRUE, INHERIT FALSE, SET FALSE, and that row is never read;
--      - it owns nothing and is named by nothing, in any database: no row of pg_shdepend, the shared catalog of the
--        owners, grants and policies that name a role, names the login. So it holds no grant of its own, and 0012's
--        grants and each later migration's stay the whole list of what the Worker may do.
--     A refusal raises an error, which rolls the whole block back: a login made by this run is not left behind, and
--     the login refused is left exactly as it was.
-- It never sets a password: create-staging-hyperdrive.mjs sets staging's (ADR-014, "The script's rules"), and piece 5
-- sets the local and CI ones.
do $$
declare
  pair record;
  login record;
  own_count integer;
  right_count integer;
  memberships text;
  named_by text;
  faults text[];
begin
  if pg_catalog.current_setting('server_version_num')::integer < 160000 then
    raise exception 'worker-logins.sql: refused: PostgreSQL 16 or later is needed (a grant WITH INHERIT TRUE, SET FALSE), and this server reports server_version_num %; nothing was made',
      pg_catalog.current_setting('server_version_num')
      using errcode = 'feature_not_supported';
  end if;

  -- Each login, made only when missing, and granted its one role in the same step.
  for pair in
    select v.login_name, v.role_name
    from (values ('rosie_worker_job', 'rosie_job'), ('rosie_worker_app', 'rosie_app')) as v(login_name, role_name)
  loop
    if not exists (select 1 from pg_catalog.pg_roles where rolname = pair.login_name) then
      begin
        execute pg_catalog.format(
          'create role %I login nosuperuser nocreatedb nocreaterole noreplication nobypassrls', pair.login_name);
        execute pg_catalog.format('grant %I to %I with inherit true, set false', pair.role_name, pair.login_name);
      exception
        when duplicate_object or unique_violation then
          null;
      end;
    end if;
  end loop;

  -- Each login's shape, read and never repaired.
  for pair in
    select v.login_name, v.role_name
    from (values ('rosie_worker_job', 'rosie_job'), ('rosie_worker_app', 'rosie_app')) as v(login_name, role_name)
  loop
    select r.oid, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls
      into login
      from pg_catalog.pg_roles r
      where r.rolname = pair.login_name;
    if not found then
      raise exception 'worker-logins.sql: refused: % is missing after this block made it (was it dropped beside it?)',
        pair.login_name
        using errcode = 'object_not_in_prerequisite_state';
    end if;

    faults := array[]::text[];
    if not login.rolcanlogin then
      faults := pg_catalog.array_append(faults, 'NOLOGIN'::text);
    end if;
    if login.rolsuper then
      faults := pg_catalog.array_append(faults, 'SUPERUSER'::text);
    end if;
    if login.rolcreatedb then
      faults := pg_catalog.array_append(faults, 'CREATEDB'::text);
    end if;
    if login.rolcreaterole then
      faults := pg_catalog.array_append(faults, 'CREATEROLE'::text);
    end if;
    if login.rolreplication then
      faults := pg_catalog.array_append(faults, 'REPLICATION'::text);
    end if;
    if login.rolbypassrls then
      faults := pg_catalog.array_append(faults, 'BYPASSRLS'::text);
    end if;

    -- Its memberships, by member only.
    select pg_catalog.count(*)::integer,
           pg_catalog.count(*) filter (
             where r.rolname = pair.role_name and m.inherit_option and not m.set_option and not m.admin_option
           )::integer,
           pg_catalog.string_agg(
             pg_catalog.format('%s (inherit %s, set %s, admin %s)', r.rolname, m.inherit_option::text,
               m.set_option::text, m.admin_option::text),
             ', ' order by r.rolname)
      into own_count, right_count, memberships
      from pg_catalog.pg_auth_members m
      join pg_catalog.pg_roles r on r.oid = m.roleid
      where m.member = login.oid;
    if own_count <> 1 or right_count <> 1 then
      faults := pg_catalog.array_append(faults, pg_catalog.format(
        'its memberships are %s where its one is %s (inherit true, set false, admin false)',
        coalesce(memberships, 'none'), pair.role_name));
    end if;

    -- What owns it or names it, in any database.
    select pg_catalog.string_agg(pg_catalog.format('%s %s', d.how_many, d.what), ', ' order by d.what)
      into named_by
      from (
        select case s.deptype
                 when 'o' then 'object(s) it owns'
                 when 'a' then 'grant(s) of its own'
                 when 'r' then 'policy(ies) naming it'
                 else pg_catalog.format('other row(s) of kind %s', s.deptype)
               end as what,
               pg_catalog.count(*) as how_many
          from pg_catalog.pg_shdepend s
          where s.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass and s.refobjid = login.oid
          group by 1
      ) as d;
    if named_by is not null then
      faults := pg_catalog.array_append(faults, pg_catalog.format('pg_shdepend names it: %s', named_by));
    end if;

    if pg_catalog.cardinality(faults) > 0 then
      raise exception 'worker-logins.sql: refused: % is not in its shape (LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS, one membership: % with inherit true, set false and admin false, owning and named by nothing): %. It is left as it is: this file never repairs a login',
        pair.login_name, pair.role_name, pg_catalog.array_to_string(faults, '; ')
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end loop;
end
$$;
