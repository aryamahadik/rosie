-- T-192: the conversations and consent part (K-29 v1, frozen: contracts/db-schema/conversations-consent): chat links
-- with their short code and ready text, and consent rows that are only ever added, both under row-level security per
-- business in T-191's pattern (0012).
-- Expand only: two new tables with their indexes; chat_links' version trigger (enforce_version_raise() from 0002, T-181);
-- one trigger function and trigger that refuse every edit of a consent row, as 0011 does for event_log; grants to the two
-- roles 0012 made (never created or altered here); row-level security switched on with two policies on each table.
-- Nothing is dropped, renamed or retyped, and no row is written or removed. Not here: the consent service and the calls
-- that give a link in a new place, tell the owner again or match a sent ready text (the action layer's C-102; the
-- runtime's actor), and K-30's first_link_given_at.
--
-- Both tables live beside K-04's tables, and their foreign keys name core tables by K-04's keys, all on delete restrict
-- (K-29 rule 1). Ids and short codes are text: opaque strings code makes and never parses (rule 3; CQ-09).
--
-- chat_links: each chat link issued (MC C9; RULES 4.1b; S2-05). A link opens Messages to Rosie's number with a ready text
-- holding a short code (chat_links_ready_text_has_code), and each code finds one link (chat_links_short_code_key). A row
-- is updated as the link is given in a new place, the owner is told again or the ready text arrives, so it carries a
-- version that every update raises by exactly one (K-04 rule 2; the trigger refuses any other update, 23514). That a link
-- is issued only for a mobile already added as a Linq contact (Q-03) spans two tables: code checks it before issuing.
--
-- consents: every yes and every stop as its own row (FS lines 735, 753, 756). A STOP, a START and a switch of contact are
-- each a new row, and for one person, kind, business and contact the newest row (by at, then the lower id) decides. A
-- STOP or START covers every business at once (one number, D102), so its row has no business; only texts rows may have
-- none (consents_every_business_only_texts). No column is sealed: the words shown and their sha256
-- (consents_words_sha256_match) are the proof that outlives a person's deleted key (arch 09 line 492; RULES 4.10).
--
-- Never edited (K-29 rule 5; FS line 753): the two roles hold INSERT and SELECT on consents only, so an update or a delete
-- by either is refused by privilege, SQLSTATE 42501 (refuse-consent-update.json), and TRUNCATE, which no row trigger
-- sees, is never granted. The trigger below refuses an update or a delete by every role, the tables' owner included, with
-- the same SQLSTATE, naming the table and never a value, as 0011 does for event_log: until the Worker's login role is
-- granted one of the two roles (T-1093), calls run as the owner, whom no privilege stops. Neither role owns either table
-- or the trigger function.
--
-- Row-level security (arch 10 line 546; K-04 rule 4; K-29 rule 4), as 0012: on each table, <table>_tool_api lets
-- rosie_app see and write only rows whose business_id equals its scope (the setting rosie.business_id), and none with no
-- scope; <table>_runtime lets rosie_job see every row with no scope, else only its scope's. A STOP or START row (business
-- null) is seen by no business scope: the guard and limit 8 read consents on the runtime side, unscoped, and so does the
-- actor matching a sent ready text to its link.
--
-- Grants, as 0012's: SELECT and INSERT to both roles, behind the policies; UPDATE only on the versioned table
-- (chat_links); no DELETE, TRUNCATE, REFERENCES or TRIGGER on either table.

-- Each chat link issued: its short code and ready text, its purpose (a booking, or a staff invite), the business, booking,
-- person and mobile it is for, where it was given, when it was issued, when the owner was told again, and when its ready
-- text arrived (MC C9; RULES 4.1b; S2-05).
create table chat_links (
  id text primary key,
  short_code text not null,
  purpose text not null,
  business_id text not null,
  booking_id text,
  person_id text not null,
  phone_number text not null,
  ready_text text not null,
  given_via text[] not null,
  issued_at timestamptz not null default now(),
  owner_retold_at timestamptz,
  used_at timestamptz,
  version integer not null default 1,
  constraint chat_links_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint chat_links_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint chat_links_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint chat_links_phone_fk foreign key (phone_number) references phones (number) on delete restrict,
  constraint chat_links_short_code_key unique (short_code),
  constraint chat_links_purpose_known check (purpose in ('booking', 'staff_invite')),
  constraint chat_links_booking_only_for_booking check ((purpose = 'booking') = (booking_id is not null)),
  constraint chat_links_short_code_form check (short_code ~ '^[^[:space:]]+$'),
  constraint chat_links_ready_text_has_code check (strpos(ready_text, short_code) > 0),
  constraint chat_links_given_via_known check (
    cardinality(given_via) >= 1
    and given_via <@ array['booking_page', 'confirmation_email', 'customer_ai', 'owner']::text[]
  ),
  constraint chat_links_retold_only_staff check (owner_retold_at is null or purpose = 'staff_invite'),
  constraint chat_links_used_after_issued check (used_at is null or used_at >= issued_at)
);

-- A mobile's links, when its first text arrives without the code or a new booking asks whether its chat was ever opened
-- (RULES 4.1b; MC C9 "Never opened").
create index chat_links_phone_idx on chat_links (phone_number);
-- A booking's link, for its page, its confirmation email and its customer's AI (MC C9).
create index chat_links_booking_idx on chat_links (booking_id) where booking_id is not null;
-- Staff invites still unanswered, so the owner is told once after 48 hours (MC C9).
create index chat_links_open_invites_idx on chat_links (issued_at)
  where purpose = 'staff_invite' and used_at is null and owner_retold_at is null;

create trigger chat_links_version_raised
  before update on chat_links
  for each row execute function enforce_version_raise();

-- Every yes, and every stop, as its own row: the person, the business, the kind, whether it withdraws, the contact, the
-- booking, the exact words shown and their sha256, the time, the channel, the chat link and the turn (FS lines 735, 752,
-- 753, 756; arch 01 line 89; arch 09 lines 457, 492). Kinds: FS line 735's without automated calls (no voice provider:
-- Q-05) and face match (MC C10).
create table consents (
  id text primary key,
  person_id text not null,
  business_id text,
  kind text not null,
  revoked boolean not null default false,
  handle_id text,
  booking_id text,
  exact_words text not null,
  words_sha256 text not null,
  at timestamptz not null,
  channel text not null,
  chat_link_id text,
  turn_id text,
  constraint consents_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint consents_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint consents_handle_fk foreign key (handle_id) references handles (id) on delete restrict,
  constraint consents_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint consents_chat_link_fk foreign key (chat_link_id) references chat_links (id) on delete restrict,
  constraint consents_turn_fk foreign key (turn_id) references turns (id) on delete restrict,
  constraint consents_kind_known check (
    kind in ('texts', 'photos_shown', 'ticked_terms', 'plan_terms', 'fee_ok', 'health_agreement')
  ),
  constraint consents_channel_known check (channel in ('text', 'email', 'page', 'ai')),
  constraint consents_words_given check (length(btrim(exact_words)) > 0),
  constraint consents_words_sha256_match check (
    words_sha256 = encode(sha256(convert_to(exact_words, 'UTF8')), 'hex')
  ),
  constraint consents_every_business_only_texts check (business_id is not null or kind = 'texts'),
  constraint consents_texts_has_contact check (kind <> 'texts' or handle_id is not null),
  constraint consents_ticked_terms_has_booking check (kind <> 'ticked_terms' or booking_id is not null),
  constraint consents_chat_link_only_texts check (chat_link_id is null or kind = 'texts')
);

-- A person's newest row of a kind decides (FS line 753).
create index consents_person_kind_at_idx on consents (person_id, kind, at);
-- The guard's STOP record and limit 8's texts check read a contact's newest texts row (RULES 7.1, 7.2; arch 02 line 115).
create index consents_handle_kind_at_idx on consents (handle_id, kind, at) where handle_id is not null;
-- A business's fee OK and agreements, which Go live checks (S1-29, S1-25, S1-72).
create index consents_business_kind_idx on consents (business_id, kind);
-- A booking's terms ticked and texts yes (A5-07; RULES 7.5).
create index consents_booking_idx on consents (booking_id) where booking_id is not null;

-- Never edited: an update or a delete is an insufficient privilege (K-29 rule 5), whoever runs it.
create function consents_refuse_edit() returns trigger
language plpgsql
as $$
begin
  raise exception '% on % is not allowed: consent rows are never edited', tg_op, tg_table_name
    using errcode = 'insufficient_privilege',
          table = tg_table_name;
end;
$$;

create trigger consents_never_edited
  before update or delete on consents
  for each row execute function consents_refuse_edit();

-- The versioned table: both roles, behind the policies below.
grant select, insert, update on chat_links to rosie_app, rosie_job;

-- Only ever added: insert and select, nothing else.
grant select, insert on consents to rosie_app, rosie_job;

-- Row-level security: rosie_app sees only its scope; rosie_job sees everything with no scope, else only its scope.
alter table chat_links enable row level security;
create policy chat_links_tool_api on chat_links for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy chat_links_runtime on chat_links for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table consents enable row level security;
create policy consents_tool_api on consents for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy consents_runtime on consents for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );
