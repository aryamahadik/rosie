-- T-184: threads, openers_sent and messages (K-04 v1 core, frozen: contracts/db-schema/core).
-- Expand only: three new tables, new triggers and indexes on them. Uses enforce_version_raise() from 0002 (T-181).
-- Row-level security is T-191's: threads are one per handle across every business (MC C1), so they carry no scope;
-- openers_sent and messages are scoped by business_id with the rest of the policies there.
--
-- Foreign keys that wait for a later migration, because the table they name does not exist yet. Each is added by the
-- migration that creates the referenced table, on columns that are null or hold an id the code made. Nothing is dropped
-- or retyped. The names are the table list's:
--   threads_booking_fk         threads (booking_id)            references bookings (id)     on delete restrict
--   messages_booking_fk        messages (booking_id)           references bookings (id)     on delete restrict
--   openers_sent_outbox_fk     openers_sent (outbox_row_id)    references outbox_rows (id)  on delete restrict
--   messages_outbox_fk         messages (outbox_row_id)        references outbox_rows (id)  on delete restrict
--
-- messages.words is text in the table list. The data-access code (db/repo/threads.ts) stores the words sealed under the
-- key of messages.person_id (db/repo/sealing.ts), written as text; the column holds no plain words.

-- A thread: the chat with Rosie's number (one per handle), or one booking's email reply thread (RULES 4.1).
create table threads (
  id text primary key,
  handle_id text not null,
  kind text not null,
  booking_id text,
  linq_chat_id text,
  reply_address text,
  version integer not null default 1,
  constraint threads_handle_fk foreign key (handle_id) references handles (id) on delete restrict,
  constraint threads_reply_address_key unique (reply_address),
  constraint threads_linq_chat_key unique (linq_chat_id),
  constraint threads_kind_known check (kind in ('chat', 'email')),
  constraint threads_chat_or_email check (
    (kind = 'chat' and booking_id is null and reply_address is null)
    or (kind = 'email' and booking_id is not null and reply_address is not null)
  )
);

-- One chat per handle across every business (MC C1).
create unique index threads_one_chat_per_handle on threads (handle_id) where kind = 'chat';

create trigger threads_version_raised
  before update on threads
  for each row execute function enforce_version_raise();

-- Whether Rosie's opener for a business has gone to a handle (arch 07 line 361). Written once: no version.
create table openers_sent (
  handle_id text not null,
  business_id text not null,
  sent_at timestamptz not null,
  outbox_row_id text not null,
  primary key (handle_id, business_id),
  constraint openers_sent_handle_fk foreign key (handle_id) references handles (id) on delete restrict,
  constraint openers_sent_business_fk foreign key (business_id) references businesses (id) on delete restrict
);

-- The message log the context bundle and the composer read.
create table messages (
  id text primary key,
  thread_id text not null,
  business_id text,
  booking_id text,
  direction text not null,
  channel text not null,
  service text,
  from_role text not null,
  to_role text not null,
  person_id text,
  words text not null,
  event_id text,
  outbox_row_id text,
  sent_at timestamptz not null,
  delivered_at timestamptz,
  version integer not null default 1,
  constraint messages_thread_fk foreign key (thread_id) references threads (id) on delete restrict,
  constraint messages_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint messages_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint messages_event_id_key unique (event_id),
  constraint messages_direction_known check (direction in ('in', 'out')),
  constraint messages_channel_known check (channel in ('text', 'email', 'page', 'ai')),
  constraint messages_service_known check (service is null or service in ('imessage', 'rcs', 'sms')),
  constraint messages_service_only_for_text check (service is null or channel = 'text'),
  constraint messages_from_role_known check (
    from_role in ('rosie', 'customer', 'owner', 'admin', 'staff', 'own_business', 'team', 'ai')
  ),
  constraint messages_to_role_known check (
    to_role in ('rosie', 'customer', 'owner', 'admin', 'staff', 'own_business', 'team', 'ai')
  ),
  constraint messages_in_has_event check (direction = 'out' or event_id is not null),
  constraint messages_out_has_row check (
    direction = 'in' or channel not in ('text', 'email') or outbox_row_id is not null
  )
);

-- The context bundle's last 6 messages (arch 03 line 181), and messages with one business (arch 07 line 397).
create index messages_thread_sent_idx on messages (thread_id, sent_at);
create index messages_business_sent_idx on messages (business_id, sent_at);

create trigger messages_version_raised
  before update on messages
  for each row execute function enforce_version_raise();
