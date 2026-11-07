-- T-183: handles, person_handles, phones (with the stopped flag) and pauses (K-04 v1 core, frozen: contracts/db-schema/core).
-- Expand only: four new tables, new triggers and indexes on them. Uses enforce_version_raise() from 0002 (T-181).
-- Row-level security is T-191's: none of handles, person_handles and phones is scoped to a business (they span every
-- business, MC C1), and the business scope of pauses is added with the rest of the policies there.
--
-- pauses.set_by_turn_id is the turn that set a pause (turns.id). The turns table is a later migration's, so this file
-- makes the column without its foreign key (pauses_turn_fk); that migration adds the key, on a column that is null or
-- holds a turn id the code made. An expand step: nothing here is dropped or retyped.

-- One handle per phone number or email address that writes to Rosie (arch 01 line 55). Written once: no version.
create table handles (
  id text primary key,
  kind text not null,
  address text not null,
  constraint handles_address_key unique (address),
  -- The target of phones' foreign key: a phone refers to its handle by id and number (FS line 728).
  constraint handles_id_address_key unique (id, address),
  constraint handles_kind_known check (kind in ('phone', 'email')),
  constraint handles_address_form check (
    (kind = 'phone' and address ~ '^\+[1-9][0-9]{6,14}$')
    or (kind = 'email' and address ~ '^[^@[:space:]]+@[^@[:space:]]+$' and address = lower(address))
  )
);

-- Which people write from which handle. Rows are added or removed, never updated: no version.
create table person_handles (
  person_id text not null,
  handle_id text not null,
  primary key (person_id, handle_id),
  constraint person_handles_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint person_handles_handle_fk foreign key (handle_id) references handles (id) on delete restrict
);

-- The guard lists a handle's people (arch 02 line 115).
create index person_handles_handle_idx on person_handles (handle_id);

-- One phone row per mobile across every business, since there is one number (FS line 728; MC C1). STOP sets the stopped
-- flag here once and every business sees it; START clears it. The paused flag is a pauses row.
create table phones (
  number text primary key,
  handle_id text not null,
  chat_open boolean not null default false,
  chat_open_at timestamptz,
  chat_way text,
  stopped boolean not null default false,
  stop_at timestamptz,
  start_at timestamptz,
  linq_contact_added_at timestamptz,
  poll_voted_at timestamptz,
  optout_line_delivered_at timestamptz,
  version integer not null default 1,
  constraint phones_handle_fk foreign key (handle_id, number) references handles (id, address) on delete restrict,
  constraint phones_handle_key unique (handle_id),
  constraint phones_number_form check (number ~ '^\+[1-9][0-9]{6,14}$'),
  constraint phones_chat_way_known check (chat_way is null or chat_way in ('imessage', 'rcs', 'sms')),
  constraint phones_stop_closes_chat check (not (stopped and chat_open)),
  constraint phones_stopped_has_time check (not stopped or stop_at is not null)
);

create trigger phones_version_raised
  before update on phones
  for each row execute function enforce_version_raise();

-- The paused flag for a person, phone or address (arch 03 lines 175, 177). One row per pause; a cleared pause keeps its
-- row. An address is sealed under the key of sealed_for_person_id (T-182 sealing_keys).
create table pauses (
  id text primary key,
  business_id text not null,
  target text not null,
  person_id text,
  phone_number text,
  address bytea,
  sealed_for_person_id text,
  set_by_turn_id text,
  set_at timestamptz not null,
  cleared_at timestamptz,
  cleared_by_person_id text,
  version integer not null default 1,
  constraint pauses_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint pauses_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint pauses_phone_fk foreign key (phone_number) references phones (number) on delete restrict,
  constraint pauses_sealed_for_fk foreign key (sealed_for_person_id) references persons (id) on delete restrict,
  constraint pauses_cleared_by_fk foreign key (cleared_by_person_id) references persons (id) on delete restrict,
  constraint pauses_target_known check (target in ('person', 'phone', 'address')),
  constraint pauses_one_target check (
    (target = 'person' and person_id is not null and phone_number is null and address is null)
    or (target = 'phone' and phone_number is not null and person_id is null and address is null)
    or (target = 'address' and address is not null and sealed_for_person_id is not null
        and person_id is null and phone_number is null)
  )
);

-- The gate and the dispatcher check a person's and a phone's open pause (arch 03 line 175).
create index pauses_open_person_idx on pauses (person_id) where cleared_at is null;
create index pauses_open_phone_idx on pauses (phone_number) where cleared_at is null;

create trigger pauses_version_raised
  before update on pauses
  for each row execute function enforce_version_raise();
