-- T-204: the people and access part (K-22 v1.1, frozen: contracts/db-schema/people-access, its two table lists and its
-- README's rules 1 to 8): staff details per business, their skills, powers and on-call rows, the emergency contact, the
-- owner's sign-in account and ID upload record, proof codes, sign-in sessions, contact changes and page links (arch 09
-- line 459; FS line 723, rows T01 to T12; MC C9, C10; RULES 6.2; S1-10, S1-70, S1-78, S2-02 to S2-27, S11-52, S13-45).
-- Expand only: eleven new tables with their indexes; the version trigger (enforce_version_raise() from 0002, T-181) on
-- the eight versioned ones; grants to the two roles 0012 made (never created or altered here); row-level security with
-- its policies; five new security-definer functions. Nothing is dropped, renamed or retyped, and no row is written or
-- removed. Not here: the ID file itself (R2, K-13); setting rosie.person_id per call (db/repo/scope.ts and K-05's
-- minor version, README open gaps); the migration-side contract tests (QA's db-schema.people-access.v1 and v1.1).
--
-- The tables live beside K-04's (rule 1), and their foreign keys name core tables by K-04's keys (businesses.id,
-- persons.id, handles.id, handles.address, phones.number, person_handles' key), with no schema prefix. v1's keys are
-- all on delete restrict, as its table list says; v1.1's page_links names no on delete, so its keys keep PostgreSQL's
-- default (no action). No table here refers to K-23, K-29 or K-34. Ids are text, opaque strings code makes (rule 3).
-- Arrays (rule 7): staff.languages is text[] and on_call.days smallint[], not null, default '{}'.
--
-- Versions (rule 2): every table that is updated carries a version that every update raises by exactly one (the
-- trigger refuses any other update, 23514), compared and set by a commit. All eight have a one-column key a commit can
-- name in versions_read: accounts (person_id), staff, team_powers, on_call, emergency_contacts, proof_codes, sessions
-- and page_links (id). id_uploads, staff_skills and contact_changes are written once and carry none.
--
-- Sealed fields (rule 6; T-182's sealing, migration 0003 and db/repo/sealing.ts): id_uploads.object_key (by person_id),
-- emergency_contacts.name and emergency_contacts.mobile (by person_id, the pro) are bytea holding only the sealed form,
-- under that person's own key in core's sealing_keys; no column keeps a plain copy, so erasing the key erases them.
-- Codes, tokens, devices and link codes are kept only as hashes, held to their form by CHECKs (BP rule 7).
--
-- Proof codes (RULES 6.2): a code works 10 minutes (proof_codes_ten_minutes); five wrong codes pause it 15 minutes from
-- the fifth (proof_codes_pause_after_five), and the count never passes five (proof_codes_wrong_tries_range, so a sixth
-- wrong try is refused); a code is used once, within its 10 minutes, never after five wrong codes
-- (proof_codes_used_in_time). check_proof_code below is the only way the Tool API counts a try or uses a code.
--
-- Row-level security (arch 10 line 546; K-04 v1 rule 4; README rules 4, 5 and 8):
--   staff, staff_skills, team_powers, on_call, emergency_contacts: scoped by business_id with 0012's two policies:
--     <table>_tool_api lets rosie_app see and write only rows whose business_id is its scope (rosie.business_id), and
--     none with no scope; <table>_runtime lets rosie_job see every row with no scope, else only its scope's.
--   contact_changes (rule 4), page_links (rule 8): scoped by business_id, with 0012's <table>_runtime for rosie_job and,
--     for rosie_app, one policy per command, each the README's expression word for word: contact_changes_tool_api_select
--     and _insert (a business scope writes only its own desk and team-edit rows; a row with no business only for the
--     call's own person, rosie.person_id, and by own_code or email_on_file only with a used code of that person; no
--     Tool API call reads a row with no business); page_links_tool_api_select, _insert and _update (a live link of its
--     own business is ended, never reopened).
--   proof_codes, sessions (rule 5): scope none (a sign-in covers every business), so their Tool API rows are bound to
--     the call's person instead: <table>_tool_api_select, _insert (and sessions_tool_api_update) for rosie_app, the
--     README's expressions word for word; <table>_runtime lets rosie_job see and write every row (full access,
--     unscoped).
--   accounts, id_uploads: scope none and no Tool API grant (README open gap), so row-level security stays off, as on
--     K-04's persons; only rosie_job holds grants.
--   None is forced: the tables' owner (the migrations' role) is not bound, which the five functions rely on.
--
-- Grants (DL-149: each to a named reader). No DELETE (no row here is removed by any named call), TRUNCATE, REFERENCES
-- or TRIGGER, and nothing to PUBLIC. Neither role owns a table or a function.
--   rosie_job, the runtime side:
--     staff, team_powers, on_call, emergency_contacts: SELECT, INSERT, UPDATE; staff_skills: SELECT, INSERT. K-05
--       commitTurn per write (item 1; v1.2's state writes admit every domain table) writes what journey 2's turns and
--       S1-78's decide (K-09 v1 saveSetupStep in a turn: S2-02 adds a person invited, S2-05's ready text joins them,
--       a STOP sets stopped, S2-15 skills and powers, S2-24 bookable, S2-27 on call, the contact's own yes), compares
--       rows FOR SHARE or FOR UPDATE (which take UPDATE as well as SELECT), and readTurnState with no business
--       (item 26) reads them.
--     accounts: SELECT, INSERT, UPDATE; id_uploads: SELECT, INSERT. No Tool API grant (README open gap): the account a
--       sign-in finds by the typed mobile or email (K-21 v1 signInStart through K-09 sendProofCode), S1-10's owner
--       mobile, email and email_proven_at (K-09 saveSetupStep S1-10), K-21 finishUpload's ID upload (S1-10's sign_up,
--       S13-45 row 8's re_check), and S1-32's gate reading the upload (README, "Every path that binds a person").
--     proof_codes, sessions: SELECT, INSERT, UPDATE, unscoped (rules 4 and 5): a turn's code sent in its one commit
--       with its outbox row (arch 10 line 508), the commits that end another person's sessions (left, handed_over:
--       RULES 8.7; S11-100), K-05 v1's commit writing tables scoped none (data-access README, "Scope").
--     contact_changes: SELECT, INSERT (never edited): commitTurn per write (a change with no business goes on the
--       runtime side) and the "don't text me" proof (FS line 756).
--     page_links: SELECT, INSERT, UPDATE: K-05 v1.2 commitTurn's stateWrite issues a link with the outbox row that
--       carries it and ends links (step_done, contact_changed, left, handed_over) (README section v1.1).
--     EXECUTE on the five functions (rules 5 and 8).
--   rosie_app, the Tool API:
--     staff, team_powers, on_call, emergency_contacts: SELECT, INSERT, UPDATE; staff_skills: SELECT, INSERT, behind
--       the business policies: K-09 v1 saveSetupStep made alone under a page's or the console's business (S2-06's
--       staff page, S1-78 on S1-70's page, S2-15 and S2-27 from the console) and readSetup (the team and who can be
--       booked), K-21 v1 readStaffPage (the person's own profile and emergency contact state), and K-22's refused
--       fixtures, which name the Tool API side updating staff and inserting a power and a contact, each refused by its
--       CHECK (23514), never by privilege.
--     contact_changes: SELECT, INSERT, under rule 4's two policies: the turn or call that proves a person's own change
--       (D75 own_chat, D100 email_on_file, FS section 8 own_code, S13-45 row 8 signed_in_id_re_check), the desk's
--       in_person change (D77) and the owner's team edit (S11-20).
--     proof_codes (rule 5): SELECT of every column but code_hash and INSERT of a send's ten columns only: K-21 v1
--       signInStart and codeStart through K-09 v1 sendProofCode (the send) and the person's own live code, key name
--       and pause; used_at, wrong_tries, last_wrong_at, paused_until and version keep their defaults on insert.
--     sessions (rule 5): SELECT of every column but token_sha256 and device_sha256, INSERT of the call's own person's
--       session with a used sign-in code of that person, UPDATE of last_seen_at, ended_at, ended_why and version: K-21
--       v1 signInCheck (the session starts), signOut (it ends) and every signed-in call (last seen).
--     page_links (rule 8): SELECT of every column but code_sha256, INSERT of an issue's nine columns, UPDATE of the end
--       and the version: K-09 saveSetupStep made alone (S1-10's link ends step_done once its keys are given) and a
--       commit's version compare.
--     EXECUTE on the five functions: K-21 v1 openLink (page_link_for_code, session_for_token), signInCheck and codeCheck
--       through K-09 proveCode (check_proof_code, device_known), signInStart and codeStart (proof_code_limits).

-- How a person on the business side signs in, one row per person across every business (FS rows B11 to B13; S1-10).
create table accounts (
  person_id text primary key,
  mobile text,
  mobile_proven_at timestamptz,
  email text,
  email_proven_at timestamptz,
  version integer not null default 1,
  constraint accounts_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint accounts_mobile_fk foreign key (mobile) references phones (number) on delete restrict,
  constraint accounts_email_fk foreign key (email) references handles (address) on delete restrict,
  constraint accounts_mobile_key unique (mobile),
  constraint accounts_email_form check (
    email is null or (email ~ '^[^@[:space:]]+@[^@[:space:]]+$' and email = lower(email))
  ),
  constraint accounts_mobile_proven_has_mobile check (mobile_proven_at is null or mobile is not null),
  constraint accounts_email_proven_has_email check (email_proven_at is null or email is not null)
);

create trigger accounts_version_raised
  before update on accounts
  for each row execute function enforce_version_raise();

-- An ID document uploaded on the secure page, accepted as given (MC C10); a sign_up upload counts as the ID confirmed.
-- Written once: no version. The R2 object key is sealed under the person's key.
create table id_uploads (
  id text primary key,
  person_id text not null,
  purpose text not null,
  object_key bytea not null,
  content_type text not null,
  uploaded_at timestamptz not null,
  constraint id_uploads_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint id_uploads_purpose_known check (purpose in ('sign_up', 're_check')),
  constraint id_uploads_content_type_form check (content_type ~ '^(image|application)/[a-z0-9.+-]+$')
);

-- The ID at sign-up is done once, for every company (S1-10): a partial unique index, as the table list's unique rule
-- with its where.
create unique index id_uploads_one_sign_up on id_uploads (person_id) where purpose = 'sign_up';
-- Whether a person's ID is confirmed (S1-32's gate) and their latest re-check (S13-45 row 8).
create index id_uploads_person_idx on id_uploads (person_id, uploaded_at);

-- A team member at one business (FS line 723): mobile, the owner's tick, status, join, stop and wrong-number times,
-- languages, day-list time, video link or call, supervisor, bookable. The person, name and role are K-04 core's.
create table staff (
  id text primary key,
  business_id text not null,
  person_id text not null,
  mobile text not null,
  agreed_to_text_ticked_at timestamptz not null,
  agreed_ticked_by_person_id text not null,
  status text not null default 'invited',
  added_at timestamptz not null,
  joined_at timestamptz,
  joined_from_number text,
  stopped_at timestamptz,
  wrong_number_at timestamptz,
  languages text[] not null default '{}',
  day_list_time time,
  video_link text,
  calls_customer_mobile boolean not null default false,
  supervisor_staff_id text,
  bookable_at timestamptz,
  bookable_by_person_id text,
  version integer not null default 1,
  constraint staff_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint staff_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint staff_mobile_fk foreign key (mobile) references phones (number) on delete restrict,
  constraint staff_joined_from_fk foreign key (joined_from_number) references phones (number) on delete restrict,
  constraint staff_agreed_by_fk foreign key (agreed_ticked_by_person_id) references persons (id) on delete restrict,
  constraint staff_bookable_by_fk foreign key (bookable_by_person_id) references persons (id) on delete restrict,
  constraint staff_business_person_key unique (business_id, person_id),
  constraint staff_business_mobile_key unique (business_id, mobile),
  constraint staff_id_business_key unique (id, business_id),
  constraint staff_supervisor_fk foreign key (supervisor_staff_id, business_id)
    references staff (id, business_id) on delete restrict,
  constraint staff_status_known check (status in ('invited', 'joined', 'stopped', 'removed')),
  constraint staff_joined_from_own_mobile check (
    (joined_at is null) = (joined_from_number is null) and (joined_from_number is null or joined_from_number = mobile)
  ),
  constraint staff_joined_has_time check (status <> 'joined' or joined_at is not null),
  constraint staff_stopped_has_time check (status <> 'stopped' or stopped_at is not null),
  constraint staff_bookable_after_join check (
    bookable_at is null or (joined_at is not null and bookable_at >= joined_at)
  ),
  constraint staff_bookable_with_who check ((bookable_at is null) = (bookable_by_person_id is null)),
  constraint staff_times_in_order check (
    added_at >= agreed_to_text_ticked_at and (joined_at is null or joined_at >= added_at)
  ),
  constraint staff_supervisor_not_self check (supervisor_staff_id is null or supervisor_staff_id <> id),
  constraint staff_video_link_form check (video_link is null or video_link ~ '^https://[^[:space:]]+$'),
  constraint staff_video_or_call check (not (video_link is not null and calls_customer_mobile)),
  constraint staff_languages_form check (
    array_to_string(languages, ',') ~ '^([a-z]{2,3}(-[A-Za-z0-9]+)*(,[a-z]{2,3}(-[A-Za-z0-9]+)*)*)?$'
  )
);

-- A person's teams across businesses: one calendar (FS line 743), 'Which business?' on OFF, LATE or DONE (S11-43).
create index staff_person_idx on staff (person_id);

create trigger staff_version_raised
  before update on staff
  for each row execute function enforce_version_raise();

-- Which work each team member takes (T04): a kind of work, or a named skill of it. Added or removed, never updated.
create table staff_skills (
  id text primary key,
  staff_id text not null,
  business_id text not null,
  kind_id text not null,
  skill text,
  constraint staff_skills_staff_fk foreign key (staff_id, business_id)
    references staff (id, business_id) on delete restrict,
  constraint staff_skills_kind_id_form check (kind_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint staff_skills_skill_given check (skill is null or length(btrim(skill)) > 0)
);

-- Each kind once per person, and each named skill once (T04): partial unique indexes.
create unique index staff_skills_kind_key on staff_skills (staff_id, kind_id) where skill is null;
create unique index staff_skills_skill_key on staff_skills (staff_id, kind_id, skill) where skill is not null;
-- Who may be offered for a kind of work on the times card (T04).
create index staff_skills_business_kind_idx on staff_skills (business_id, kind_id);

-- What a team member other than the account owner may OK or do (T05); never closing, export, hand-over or removing
-- the owner (S13-45 row 8; RULES 6.8). Ending a power closes its row.
create table team_powers (
  id text primary key,
  staff_id text not null,
  business_id text not null,
  power text not null,
  over_cents integer,
  over_currency text,
  granted_at timestamptz not null,
  granted_by_person_id text not null,
  ended_at timestamptz,
  version integer not null default 1,
  constraint team_powers_staff_fk foreign key (staff_id, business_id)
    references staff (id, business_id) on delete restrict,
  constraint team_powers_granted_by_fk foreign key (granted_by_person_id) references persons (id) on delete restrict,
  constraint team_powers_power_known check (power in ('prices', 'money', 'team', 'settings', 'cancels')),
  constraint team_powers_amount_for_prices check (over_cents is null or power = 'prices'),
  constraint team_powers_amount_money check (
    (over_cents is null) = (over_currency is null)
      and (over_cents is null or over_cents >= 0)
      and (over_currency is null or over_currency ~ '^[A-Z]{3}$')
  ),
  constraint team_powers_times_in_order check (ended_at is null or ended_at >= granted_at)
);

-- One live rule per person and power (T05): a partial unique index.
create unique index team_powers_one_live on team_powers (staff_id, power) where ended_at is null;
-- Who may answer a request waiting for an OK (FS 6.2 'Needs you'; S11-03).
create index team_powers_business_power_idx on team_powers (business_id, power);

create trigger team_powers_version_raised
  before update on team_powers
  for each row execute function enforce_version_raise();

-- Who takes jobs sent now, per kind of work (T12; S2-27): in open hours a named person or the nearest free one; while
-- closed, the person on call by days, times and holidays.
create table on_call (
  id text primary key,
  business_id text not null,
  kind_id text not null,
  staff_id text,
  hours text not null,
  days smallint[] not null default '{}',
  holidays boolean not null default false,
  from_time time,
  until_time time,
  version integer not null default 1,
  constraint on_call_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint on_call_staff_fk foreign key (staff_id, business_id) references staff (id, business_id) on delete restrict,
  constraint on_call_hours_known check (hours in ('open', 'closed')),
  constraint on_call_closed_names_person check (staff_id is not null or hours = 'open'),
  constraint on_call_days_known check (days <@ '{1,2,3,4,5,6,7}'::smallint[] and (cardinality(days) > 0 or holidays)),
  constraint on_call_times_pair check (
    (from_time is null) = (until_time is null) and (from_time is null or from_time <> until_time)
  ),
  constraint on_call_kind_id_form check (kind_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

-- Who takes a job sent now for this kind of work, now (S2-27; B4-91).
create index on_call_business_kind_idx on on_call (business_id, kind_id);

create trigger on_call_version_raised
  before update on on_call
  for each row execute function enforce_version_raise();

-- A lone pro's one emergency contact (T11): name and mobile sealed under the pro's key, the pro's tick, and the
-- contact's own yes (or no) by texting Rosie, which a safety timer needs (S1-78; Q-06).
create table emergency_contacts (
  id text primary key,
  business_id text not null,
  person_id text not null,
  name bytea not null,
  mobile bytea not null,
  agreed_ticked_at timestamptz not null,
  added_at timestamptz not null,
  contact_person_id text,
  contact_handle_id text,
  contact_yes_at timestamptz,
  contact_no_at timestamptz,
  ended_at timestamptz,
  ended_why text,
  version integer not null default 1,
  constraint emergency_contacts_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint emergency_contacts_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint emergency_contacts_contact_person_fk foreign key (contact_person_id)
    references persons (id) on delete restrict,
  constraint emergency_contacts_contact_handle_fk foreign key (contact_handle_id)
    references handles (id) on delete restrict,
  constraint emergency_contacts_not_the_pro check (contact_person_id is null or contact_person_id <> person_id),
  constraint emergency_contacts_contact_with_handle check ((contact_person_id is null) = (contact_handle_id is null)),
  constraint emergency_contacts_answer_from_contact check (
    (contact_yes_at is null and contact_no_at is null) or contact_handle_id is not null
  ),
  constraint emergency_contacts_one_answer check (contact_yes_at is null or contact_no_at is null),
  constraint emergency_contacts_ended_has_why check (
    (ended_at is null) = (ended_why is null) and (ended_why is null or ended_why in ('stop', 'removed', 'replaced'))
  ),
  constraint emergency_contacts_times_in_order check (
    added_at >= agreed_ticked_at
      and (contact_yes_at is null or contact_yes_at >= agreed_ticked_at)
      and (ended_at is null or ended_at >= added_at)
  )
);

-- One live contact per pro and business (S1-78): a partial unique index.
create unique index emergency_contacts_one_live on emergency_contacts (business_id, person_id) where ended_at is null;
-- A contact's STOP ends every yes given from that handle (S13-10).
create index emergency_contacts_contact_handle_idx on emergency_contacts (contact_handle_id);

create trigger emergency_contacts_version_raised
  before update on emergency_contacts
  for each row execute function enforce_version_raise();

-- Each code sent to prove a contact (RULES 6.1, 6.2; S13-45), as its keyed hash, never the code: 10 minutes, five wrong
-- codes pause it 15 minutes.
create table proof_codes (
  id text primary key,
  purpose text not null,
  person_id text,
  business_id text,
  sent_to_handle_id text not null,
  channel text not null,
  code_hash text not null,
  hash_key_name text not null,
  sent_at timestamptz not null,
  expires_at timestamptz not null,
  wrong_tries integer not null default 0,
  last_wrong_at timestamptz,
  paused_until timestamptz,
  used_at timestamptz,
  version integer not null default 1,
  constraint proof_codes_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint proof_codes_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint proof_codes_sent_to_fk foreign key (sent_to_handle_id) references handles (id) on delete restrict,
  constraint proof_codes_purpose_known check (
    purpose in (
      'sign_in', 'owner_email', 'new_device', 'contact_change', 'listing_control', 'closing_or_export', 'hand_over',
      'link_record'
    )
  ),
  constraint proof_codes_channel_known check (channel in ('text', 'email')),
  constraint proof_codes_hash_form check (code_hash ~ '^[0-9a-f]{64}$'),
  constraint proof_codes_key_name_form check (hash_key_name ~ '^[A-Z][A-Z0-9_]*$'),
  constraint proof_codes_who check (
    person_id is not null or (purpose = 'listing_control' and business_id is not null)
  ),
  constraint proof_codes_ten_minutes check (expires_at = sent_at + interval '10 minutes'),
  constraint proof_codes_wrong_tries_range check (
    wrong_tries between 0 and 5 and (wrong_tries = 0) = (last_wrong_at is null)
  ),
  constraint proof_codes_pause_after_five check (
    (wrong_tries = 5) = (paused_until is not null)
      and (paused_until is null or paused_until = last_wrong_at + interval '15 minutes')
  ),
  constraint proof_codes_used_in_time check (
    used_at is null or (used_at >= sent_at and used_at <= expires_at and wrong_tries < 5)
  )
);

-- The live code for a contact, its pause, and 'at most a few codes a day per contact' (S13-45).
create index proof_codes_sent_to_idx on proof_codes (sent_to_handle_id, sent_at);

create trigger proof_codes_version_raised
  before update on proof_codes
  for each row execute function enforce_version_raise();

-- A signed-in portal session (S11-52): the token's sha256 and the device's, never the token; how it was proven; when
-- it ends and why.
create table sessions (
  id text primary key,
  person_id text not null,
  token_sha256 text not null,
  device_sha256 text,
  proven_via text not null,
  proof_code_id text not null,
  started_at timestamptz not null,
  last_seen_at timestamptz not null,
  expires_at timestamptz not null,
  ended_at timestamptz,
  ended_why text,
  version integer not null default 1,
  constraint sessions_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint sessions_proof_code_fk foreign key (proof_code_id) references proof_codes (id) on delete restrict,
  constraint sessions_token_key unique (token_sha256),
  constraint sessions_proof_code_key unique (proof_code_id),
  constraint sessions_token_hash_form check (token_sha256 ~ '^[0-9a-f]{64}$'),
  constraint sessions_device_hash_form check (device_sha256 is null or device_sha256 ~ '^[0-9a-f]{64}$'),
  constraint sessions_proven_via_known check (proven_via in ('code', 'code_and_email_code', 'code_and_id_re_check')),
  constraint sessions_times_in_order check (
    last_seen_at >= started_at and expires_at > started_at and (ended_at is null or ended_at >= started_at)
  ),
  constraint sessions_ended_has_why check (
    (ended_at is null) = (ended_why is null)
      and (ended_why is null or ended_why in ('signed_out', 'contact_changed', 'left', 'handed_over'))
  )
);

-- End a person's sessions when their sign-in contact changes or they leave (RULES 8.7, 9.1).
create index sessions_person_idx on sessions (person_id);

create trigger sessions_version_raised
  before update on sessions
  for each row execute function enforce_version_raise();

-- A change of where a person's updates go, or of an owner's or staff member's own phone or email (D75, D77, D100;
-- RULES 9.1 to 9.3): old, new, the way, its code or ID re-check, who and when. Never edited: no version.
create table contact_changes (
  id text primary key,
  person_id text not null,
  business_id text,
  old_handle_id text not null,
  new_handle_id text not null,
  way text not null,
  proof_code_id text,
  id_upload_id text,
  changed_by_person_id text not null,
  changed_at timestamptz not null,
  constraint contact_changes_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint contact_changes_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint contact_changes_old_handle_fk foreign key (old_handle_id) references handles (id) on delete restrict,
  constraint contact_changes_new_handle_fk foreign key (new_handle_id) references handles (id) on delete restrict,
  constraint contact_changes_proof_code_fk foreign key (proof_code_id) references proof_codes (id) on delete restrict,
  constraint contact_changes_id_upload_fk foreign key (id_upload_id) references id_uploads (id) on delete restrict,
  constraint contact_changes_changed_by_fk foreign key (changed_by_person_id)
    references persons (id) on delete restrict,
  constraint contact_changes_way_known check (
    way in ('own_chat', 'email_on_file', 'in_person', 'own_code', 'signed_in_id_re_check', 'owner_team_edit')
  ),
  constraint contact_changes_new_contact check (old_handle_id <> new_handle_id),
  constraint contact_changes_code_proof check (
    (way in ('own_chat', 'email_on_file', 'in_person', 'own_code')) = (proof_code_id is not null)
  ),
  constraint contact_changes_id_proof check ((way = 'signed_in_id_re_check') = (id_upload_id is not null)),
  constraint contact_changes_by_whom check (
    (way in ('in_person', 'owner_team_edit')) = (changed_by_person_id <> person_id)
  ),
  constraint contact_changes_desk_has_business check (
    way not in ('in_person', 'owner_team_edit') or business_id is not null
  )
);

-- A person's contact history: the 'don't text me' proof (FS line 756) and 'Contact details changed.' (RULES 9.3).
create index contact_changes_person_idx on contact_changes (person_id, changed_at);

-- v1.1 (T-030): each signed link to a page (K-21 v1 openLink; A4-42), its code kept only as its sha256.
create table page_links (
  id text primary key,
  business_id text not null,
  person_id text not null,
  purpose text not null,
  step_id text not null,
  code_sha256 text not null,
  sent_to_handle_id text not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  ended_at timestamptz,
  ended_why text,
  ended_by_contact_change_id text,
  version integer not null default 1,
  constraint page_links_business_fk foreign key (business_id) references businesses (id),
  constraint page_links_person_fk foreign key (person_id) references persons (id),
  constraint page_links_sent_to_fk foreign key (person_id, sent_to_handle_id)
    references person_handles (person_id, handle_id),
  constraint page_links_contact_change_fk foreign key (ended_by_contact_change_id) references contact_changes (id),
  constraint page_links_code_key unique (code_sha256),
  constraint page_links_code_hash_form check (code_sha256 ~ '^[0-9a-f]{64}$'),
  constraint page_links_purpose_known check (
    purpose in ('setup_id_check', 'owner_confirm', 'registration', 'staff_page')
  ),
  constraint page_links_purpose_step check (
    (purpose = 'setup_id_check' and step_id = 'S1-10')
      or (purpose = 'owner_confirm' and step_id = 'S1-77')
      or (purpose = 'staff_page' and step_id = 'S2-06')
      or (purpose = 'registration' and step_id ~ '^S1-[0-9]{2}$')
  ),
  constraint page_links_expires_after_issue check (expires_at > issued_at),
  constraint page_links_end_has_why check ((ended_at is null) = (ended_why is null)),
  constraint page_links_end_why_known check (ended_why in ('step_done', 'contact_changed', 'left', 'handed_over')),
  constraint page_links_contact_change_named check (
    (ended_why is not distinct from 'contact_changed') = (ended_by_contact_change_id is not null)
  ),
  constraint page_links_ended_after_issue check (ended_at is null or ended_at >= issued_at)
);

-- A contact change, a leaver or a hand-over ends the person's live links in its own commit (D75; RULES 8.7; S11-100).
create index page_links_person_live_idx on page_links (person_id) where ended_at is null;

create trigger page_links_version_raised
  before update on page_links
  for each row execute function enforce_version_raise();

-- Grants (the readers each serves are named in this file's header).
-- Business-scoped, versioned: both roles, behind the policies below.
grant select, insert, update on staff, team_powers, on_call, emergency_contacts to rosie_app, rosie_job;
-- Business-scoped, written once: no update.
grant select, insert on staff_skills, contact_changes to rosie_app, rosie_job;
-- Scope none: the runtime side only (accounts, id_uploads), or the runtime side in full and the Tool API's narrow
-- column grants below (proof_codes, sessions: rule 5).
grant select, insert, update on accounts, proof_codes, sessions to rosie_job;
grant select, insert on id_uploads to rosie_job;
-- page_links: the runtime side in full; the Tool API's column grants below (rule 8).
grant select, insert, update on page_links to rosie_job;

-- Rule 5: no Tool API column grant reaches a hash; a send writes its own columns only, so a code starts unused,
-- untried and unpaused at version 1.
grant
  select (
    id, purpose, person_id, business_id, sent_to_handle_id, channel, hash_key_name, sent_at, expires_at, wrong_tries,
    last_wrong_at, paused_until, used_at, version
  ),
  insert (id, purpose, person_id, business_id, sent_to_handle_id, channel, code_hash, hash_key_name, sent_at, expires_at)
on proof_codes to rosie_app;
grant
  select (
    id, person_id, proven_via, proof_code_id, started_at, last_seen_at, expires_at, ended_at, ended_why, version
  ),
  insert,
  update (last_seen_at, ended_at, ended_why, version)
on sessions to rosie_app;
-- Rule 8: never the link's hash; an issue writes its own columns, so a link starts live at version 1.
grant
  select (
    id, business_id, person_id, purpose, step_id, sent_to_handle_id, issued_at, expires_at, ended_at, ended_why,
    ended_by_contact_change_id, version
  ),
  insert (id, business_id, person_id, purpose, step_id, code_sha256, sent_to_handle_id, issued_at, expires_at),
  update (ended_at, ended_why, ended_by_contact_change_id, version)
on page_links to rosie_app;

-- Row-level security on the five business-scoped tables of 0012's pattern: rosie_app sees only its scope; rosie_job
-- sees everything with no scope, else only its scope.
alter table staff enable row level security;
create policy staff_tool_api on staff for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy staff_runtime on staff for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table staff_skills enable row level security;
create policy staff_skills_tool_api on staff_skills for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy staff_skills_runtime on staff_skills for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table team_powers enable row level security;
create policy team_powers_tool_api on team_powers for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy team_powers_runtime on team_powers for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table on_call enable row level security;
create policy on_call_tool_api on on_call for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy on_call_runtime on on_call for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table emergency_contacts enable row level security;
create policy emergency_contacts_tool_api on emergency_contacts for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy emergency_contacts_runtime on emergency_contacts for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

-- Rule 4: contact changes. A business scope reads only its own rows and writes only its own desk and team-edit rows; a
-- row with no business is admitted only for the call's own person, who made it, and by own_code or email_on_file only
-- with a used code of that person; no Tool API call reads one back. The runtime side: 0012's policy.
alter table contact_changes enable row level security;
create policy contact_changes_tool_api_select on contact_changes for select to rosie_app
  using (business_id = current_setting('rosie.business_id', true));
create policy contact_changes_tool_api_insert on contact_changes for insert to rosie_app
  with check (
    (business_id = current_setting('rosie.business_id', true) and way in ('in_person', 'owner_team_edit'))
    or (
      business_id is null
      and person_id = nullif(current_setting('rosie.person_id', true), '')
      and changed_by_person_id = person_id
      and (
        way not in ('own_code', 'email_on_file')
        or exists (
          select 1 from proof_codes c
          where c.id = contact_changes.proof_code_id and c.person_id = contact_changes.person_id and c.used_at is not null
        )
      )
    )
  );
create policy contact_changes_runtime on contact_changes for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

-- Rule 5: proof codes, bound to the call's person. The call's own person's codes, and a listing's control code (no
-- person) in its own business's scope; a send is not bound to the call's person. The runtime side: every row.
alter table proof_codes enable row level security;
create policy proof_codes_tool_api_select on proof_codes for select to rosie_app
  using (
    person_id = nullif(current_setting('rosie.person_id', true), '')
    or (person_id is null and business_id = current_setting('rosie.business_id', true))
  );
create policy proof_codes_tool_api_insert on proof_codes for insert to rosie_app
  with check (true);
create policy proof_codes_runtime on proof_codes for all to rosie_job
  using (true)
  with check (true);

-- Rule 5: sessions, bound to the call's person. Its own sessions are read, touched and ended while not yet ended; one
-- starts only with a used sign-in code (sign_in or new_device) of that same person. The runtime side: every row.
alter table sessions enable row level security;
create policy sessions_tool_api_select on sessions for select to rosie_app
  using (person_id = nullif(current_setting('rosie.person_id', true), ''));
create policy sessions_tool_api_insert on sessions for insert to rosie_app
  with check (
    person_id = nullif(current_setting('rosie.person_id', true), '')
    and exists (
      select 1 from proof_codes c
      where c.id = sessions.proof_code_id
        and c.person_id = sessions.person_id
        and c.used_at is not null
        and c.purpose in ('sign_in', 'new_device')
    )
  );
create policy sessions_tool_api_update on sessions for update to rosie_app
  using (person_id = nullif(current_setting('rosie.person_id', true), '') and ended_at is null)
  with check (person_id = nullif(current_setting('rosie.person_id', true), ''));
create policy sessions_runtime on sessions for all to rosie_job
  using (true)
  with check (true);

-- Rule 8: page links, scoped by business. Its own business's links are read and issued, and a live one ended, never
-- reopened. The runtime side: 0012's policy.
alter table page_links enable row level security;
create policy page_links_tool_api_select on page_links for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy page_links_tool_api_insert on page_links for insert to rosie_app
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy page_links_tool_api_update on page_links for update to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), '') and ended_at is null)
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy page_links_runtime on page_links for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

-- The five security-definer calls (rules 5 and 8). Each runs as its owner, the migrations' role, which owns the tables
-- and so is not bound by their row-level security; each is keyed by what the caller holds and never returns a hash.
-- Every column is qualified with its table's alias and every parameter with the call's name, since parameters and
-- output columns share names with columns. Each one's search_path is pinned below, once made: this file's own schema,
-- then pg_temp last, so neither another schema's object nor a temporary table the caller makes stands in for a table
-- here. The four SQL calls are also bound to this schema's tables when made (BEGIN ATOMIC), as 0012's are.

-- check_proof_code (rule 5): the only way a typed code is checked. The caller hashes the typed code with the key
-- hash_key_name names, which never enters the database. Locks the row; answers unknown, used, paused (after five wrong
-- codes), expired (outside its 10 minutes), right (sets used_at) or wrong (raises wrong_tries, sets last_wrong_at, and
-- at the fifth sets paused_until 15 minutes on and answers paused). It runs in the caller's transaction, so a try is
-- counted in the turn's one commit. Keyed by the code id the caller made, not by the call's person (D77, D100).
create function check_proof_code(code_id text, typed_hash text, at timestamptz)
returns text
language plpgsql
volatile
security definer
as $$
declare
  code proof_codes%rowtype;
begin
  select c.* into code from proof_codes c where c.id = check_proof_code.code_id for update;
  if not found then
    return 'unknown';
  end if;
  if code.used_at is not null then
    return 'used';
  end if;
  if code.paused_until is not null then
    return 'paused';
  end if;
  if check_proof_code.at < code.sent_at or check_proof_code.at > code.expires_at then
    return 'expired';
  end if;
  if code.code_hash = check_proof_code.typed_hash then
    update proof_codes c set used_at = check_proof_code.at, version = c.version + 1 where c.id = code.id;
    return 'right';
  end if;
  if code.wrong_tries + 1 = 5 then
    update proof_codes c
      set wrong_tries = c.wrong_tries + 1,
          last_wrong_at = check_proof_code.at,
          paused_until = check_proof_code.at + interval '15 minutes',
          version = c.version + 1
      where c.id = code.id;
    return 'paused';
  end if;
  update proof_codes c
    set wrong_tries = c.wrong_tries + 1, last_wrong_at = check_proof_code.at, version = c.version + 1
    where c.id = code.id;
  return 'wrong';
end;
$$;

-- proof_code_limits (rule 5): for the contact a code is about to go to, how many codes went to it since `since`, for
-- every person and purpose (S13-45: 'At most a few codes a day per contact'), and the latest paused_until after `at` of
-- a code for that contact and purpose (default 8), else null. One row; never an id, a person, a business or a hash.
create function proof_code_limits(handle_id text, purpose text, since timestamptz, at timestamptz)
returns table (sent_since integer, paused_until timestamptz)
language sql
stable
security definer
begin atomic
  select (count(*) filter (where c.sent_at >= proof_code_limits.since))::integer,
         max(c.paused_until) filter (
           where c.purpose = proof_code_limits.purpose and c.paused_until > proof_code_limits.at
         )
    from proof_codes c
    where c.sent_to_handle_id = proof_code_limits.handle_id;
end;

-- session_for_token (rule 5): the session with that token hash that has not ended and has not expired at `at`, with its
-- person, whom the call then acts for (rule 4); no row otherwise; never a hash.
create function session_for_token(token_sha256 text, at timestamptz)
returns table (session_id text, person_id text)
language sql
stable
security definer
begin atomic
  select s.id, s.person_id
    from sessions s
    where s.token_sha256 = session_for_token.token_sha256
      and s.ended_at is null
      and s.expires_at > session_for_token.at;
end;

-- device_known (rule 5): true when the call's own person (rosie.person_id) has a session, live or ended, from that
-- device, so a sign-in from a new device asks the extra proof (S13-45 row 8); false otherwise and with no person set.
create function device_known(device_sha256 text)
returns boolean
language sql
stable
security definer
begin atomic
  select exists (
    select 1
      from sessions s
      where s.device_sha256 = device_known.device_sha256
        and s.person_id = nullif(current_setting('rosie.person_id', true), '')
  );
end;

-- page_link_for_code (rule 8): the link with that code hash that has not ended and has not lapsed at `at`, else no
-- row, so an unknown, a lapsed and an ended code answer alike (K-21 linkExpired); never the hash.
create function page_link_for_code(code_sha256 text, at timestamptz)
returns table (
  page_link_id text,
  business_id text,
  person_id text,
  purpose text,
  step_id text,
  expires_at timestamptz,
  version integer
)
language sql
stable
security definer
begin atomic
  select l.id, l.business_id, l.person_id, l.purpose, l.step_id, l.expires_at, l.version
    from page_links l
    where l.code_sha256 = page_link_for_code.code_sha256
      and l.ended_at is null
      and l.expires_at > page_link_for_code.at;
end;

-- The search_path of each call: this file's schema (public on staging, preview_<slug> for a preview, a test's own
-- schema), known only when it runs, then pg_temp last (PostgreSQL searches pg_temp first unless it is named).
do $$
begin
  execute format(
    'alter function %I.check_proof_code(text, text, timestamptz) set search_path = %I, pg_temp',
    current_schema(), current_schema()
  );
  execute format(
    'alter function %I.proof_code_limits(text, text, timestamptz, timestamptz) set search_path = %I, pg_temp',
    current_schema(), current_schema()
  );
  execute format(
    'alter function %I.session_for_token(text, timestamptz) set search_path = %I, pg_temp',
    current_schema(), current_schema()
  );
  execute format(
    'alter function %I.device_known(text) set search_path = %I, pg_temp',
    current_schema(), current_schema()
  );
  execute format(
    'alter function %I.page_link_for_code(text, timestamptz) set search_path = %I, pg_temp',
    current_schema(), current_schema()
  );
end
$$;

revoke all on function check_proof_code(text, text, timestamptz) from public;
revoke all on function proof_code_limits(text, text, timestamptz, timestamptz) from public;
revoke all on function session_for_token(text, timestamptz) from public;
revoke all on function device_known(text) from public;
revoke all on function page_link_for_code(text, timestamptz) from public;
grant execute on function check_proof_code(text, text, timestamptz) to rosie_app, rosie_job;
grant execute on function proof_code_limits(text, text, timestamptz, timestamptz) to rosie_app, rosie_job;
grant execute on function session_for_token(text, timestamptz) to rosie_app, rosie_job;
grant execute on function device_known(text) to rosie_app, rosie_job;
grant execute on function page_link_for_code(text, timestamptz) to rosie_app, rosie_job;
