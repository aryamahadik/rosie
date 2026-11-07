-- T-181: core business head, persons and per-business roles (K-04 v1 core, frozen: contracts/db-schema/core).
-- Tables: businesses, persons, person_roles. Expand only: new tables, new function, new triggers, new indexes on
-- the new tables. Row-level security on these tables is T-191; handles and person_handles are a later migration.
--
-- Conventions every later core table follows (K-04 v1 "Database rules beyond the table list"):
--   ids          text: opaque strings the code makes and never parses (CQ-09).
--   versions     integer not null default 1 on every table that is ever updated; an update must raise it by exactly
--                one (trigger below), so a commit that compares and sets the version cannot be undone by a stale write.
--   time         timestamptz (UTC instant); a zone is a separate IANA name in a text column (CQ-09).
--   money        integer cents with a currency column (CQ-09); none in these tables.

-- The version rule (arch 01 line 85; arch 10 line 506): attached to each versioned table as a BEFORE UPDATE trigger.
-- An update that leaves the version as it was, or sets it to anything but old + 1, is refused with SQLSTATE 23514.
create function enforce_version_raise() returns trigger
language plpgsql
as $$
begin
  if new.version is distinct from old.version + 1 then
    raise exception 'update of % must raise version from % to % (got %)',
      tg_table_name, old.version, old.version + 1, new.version
      using errcode = 'check_violation',
            table = tg_table_name,
            column = 'version',
            constraint = tg_table_name || '_version_raised';
  end if;
  return new;
end;
$$;

-- The business head row (CQ-03): only what M2 reads. Row-level security keys on id (T-191).
create table businesses (
  id text primary key,
  name text not null,
  display_name text not null,
  status text not null default 'offline',
  time_zone text not null,
  text_hours_start time not null default '08:00',
  text_hours_end time not null default '20:00',
  version integer not null default 1,
  constraint businesses_status_known check (status in ('offline', 'saved', 'live')),
  constraint businesses_time_zone_form check (time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$'),
  constraint businesses_text_hours_order check (text_hours_start < text_hours_end)
);

create trigger businesses_version_raised
  before update on businesses
  for each row execute function enforce_version_raise();

-- One row per human across every business (FS line 743). No business column: the link is person_roles.
create table persons (
  id text primary key,
  name text,
  language text,
  version integer not null default 1,
  constraint persons_language_form check (language is null or language ~ '^[a-z]{2,3}(-[A-Za-z0-9]+)*$')
);

create trigger persons_version_raised
  before update on persons
  for each row execute function enforce_version_raise();

-- A person's role at one business. A role that ends keeps its row with ended_at.
create table person_roles (
  id text primary key,
  person_id text not null,
  business_id text not null,
  role text not null,
  ended_at timestamptz,
  version integer not null default 1,
  constraint person_roles_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint person_roles_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint person_roles_role_known check (role in ('owner', 'admin', 'staff', 'own_business', 'customer'))
);

create unique index person_roles_one_live_role
  on person_roles (person_id, business_id, role)
  where ended_at is null;

-- The guard lists a handle's roles across every business (arch 02 line 115).
create index person_roles_person_idx on person_roles (person_id);

-- A business's owners and staff (limit 8; RULES 4.3).
create index person_roles_business_role_idx on person_roles (business_id, role);

create trigger person_roles_version_raised
  before update on person_roles
  for each row execute function enforce_version_raise();
