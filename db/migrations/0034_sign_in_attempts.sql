-- T-1278: sign-in attempts (K-22 v1.2, frozen: contracts/db-schema/people-access, people-access.v1.2.tables.json and
-- its README's rule 9; ADR-016 sections 4 and 6 and section 7's card M1; DL-526, DL-538, DL-545). Each sign-in started
-- on a page (K-21 v1 signInStart), kept on the server from its start to its last check: the page's attempt id bound to
-- the starting device by the device cookie's sha256, the start's repeat key, the typed contact as a keyed hash, the way,
-- the one account's person and whether they held a live owner or admin role, the code sent for it, its 10 minutes, its
-- own wrong tries and the pause at the fifth, the last check's repeat key and answer, and the session it started. The
-- start's hourly bound, the contact's pause and the day's cap read it (rule 9's counts, which K-05's calls make).
-- Expand only: one new table with its two indexes and 0002's version trigger (enforce_version_raise(), T-181); grants to
-- one of the two roles 0012 made (never created or altered here); row-level security with one policy; three new
-- security-definer functions. Nothing is dropped, renamed or retyped, no row is written or removed, and no other
-- table, grant, policy or function changes: v1's and v1.1's tables (0020) stay as they are. Not here: K-05's calls that
-- start, send and check a sign-in (T-1277, T-1280, T-1284), and the migration-side contract test (T-1291).
--
-- The table follows the table list word for word: 19 columns in its order, with their types, nulls and defaults; three
-- foreign keys on delete restrict to K-04's persons and v1's proof_codes and sessions (rule 1: no schema prefix); four
-- unique rules; fourteen CHECKs (only hashes are kept, each held to its form: BP rule 7); two indexes, on (contact_hash,
-- started_at) for the contact's pause and the day's cap, and on started_at for the hourly bound (rule 9). started_at
-- takes the database's clock, now(), the start's transaction time, which every count of rule 9 compares against.
--
-- Row-level security (rule 9; scope none: a sign-in covers every business of the person): on, not forced, with one
-- policy, sign_in_attempts_runtime, for all to rosie_job, using (true) with check (true), so the runtime side reads and
-- writes every row unscoped, as on proof_codes and sessions. The Tool API has no policy of its own, so a grant given by
-- mistake would still show it no row. Not forced: the table's owner (the migrations' role) is not bound, which the three
-- functions rely on.
--
-- Grants (DL-149: each to a named reader). rosie_job, the runtime side: SELECT, INSERT and UPDATE: K-05's startSignIn
-- (rule 9's counts, rule 1's repeat and the insert, ADR-016 section 4) and sendSignInCode (the code's id and the version,
-- in the commit that writes the code and its outbox row, ADR-016 section 1), and the rows FOR UPDATE they lock. rosie_app,
-- the Tool API: no grant on the table at all, not even a column grant, so any read or write it makes is refused (42501:
-- refuse-sign-in-attempt-tool-api-read); it reaches an attempt only through the three functions. EXECUTE on the three
-- functions to both roles: K-05's proveSignIn as rosie_app (ADR-016 section 6). Neither role holds DELETE (no delete job
-- yet: CQ-246), TRUNCATE, REFERENCES or TRIGGER, neither owns the table or a function, and nothing goes to PUBLIC.
--
-- The three functions (rule 9) are SECURITY DEFINER, owned by the migrations' role, which owns the table and so is not
-- bound by its row-level security; each is keyed by what the caller holds and never returns a hash. Every column is
-- qualified with the table's alias and every parameter with the function's name, since parameters and output columns
-- share names with columns (id, attempt_id, device_sha256, session_id, wrong_tries, paused_until, last_outcome). Each
-- one's search_path is pinned below, once made: this file's own schema, then pg_temp last, so neither another schema's
-- object nor a temporary table the caller makes stands in for a table here; sign_in_attempt, a SQL function, is also
-- bound to this schema's table when made (BEGIN ATOMIC), as 0020's are. None raises an error whose detail could carry a
-- row (DL-170: a CHECK error's detail is the whole row, hashes included, read as the owner): each answers before any
-- write a NULL or a bad value could break, and every value it writes is one the CHECKs and the unique rules admit.

-- Each sign-in started on a page, from its start to its last check (ADR-016 section 4).
create table sign_in_attempts (
  id text primary key,
  attempt_id text not null,
  request_sha256 text not null,
  device_sha256 text not null,
  contact_hash text not null,
  hash_key_name text not null,
  way text not null,
  person_id text,
  owner_or_admin boolean not null default false,
  proof_code_id text,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  wrong_tries integer not null default 0,
  last_wrong_at timestamptz,
  paused_until timestamptz,
  last_check_sha256 text,
  last_outcome text,
  session_id text,
  version integer not null default 1,
  constraint sign_in_attempts_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint sign_in_attempts_proof_code_fk foreign key (proof_code_id) references proof_codes (id) on delete restrict,
  constraint sign_in_attempts_session_fk foreign key (session_id) references sessions (id) on delete restrict,
  constraint sign_in_attempts_attempt_key unique (attempt_id),
  constraint sign_in_attempts_request_key unique (request_sha256),
  constraint sign_in_attempts_proof_code_key unique (proof_code_id),
  constraint sign_in_attempts_session_key unique (session_id),
  constraint sign_in_attempts_request_hash_form check (request_sha256 ~ '^[0-9a-f]{64}$'),
  constraint sign_in_attempts_device_hash_form check (device_sha256 ~ '^[0-9a-f]{64}$'),
  constraint sign_in_attempts_contact_hash_form check (contact_hash ~ '^[0-9a-f]{64}$'),
  constraint sign_in_attempts_check_hash_form check (
    last_check_sha256 is null or last_check_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint sign_in_attempts_key_name_form check (hash_key_name ~ '^[A-Z][A-Z0-9_]*$'),
  constraint sign_in_attempts_way_known check (way in ('email', 'text')),
  constraint sign_in_attempts_role_has_person check (person_id is not null or not owner_or_admin),
  constraint sign_in_attempts_code_has_person check (proof_code_id is null or person_id is not null),
  constraint sign_in_attempts_session_has_code check (session_id is null or proof_code_id is not null),
  constraint sign_in_attempts_ten_minutes check (expires_at = started_at + interval '10 minutes'),
  constraint sign_in_attempts_wrong_tries_range check (
    wrong_tries between 0 and 5 and (wrong_tries = 0) = (last_wrong_at is null)
  ),
  constraint sign_in_attempts_pause_after_five check (
    (wrong_tries >= 5) = (paused_until is not null)
      and (paused_until is null or paused_until = last_wrong_at + interval '15 minutes')
  ),
  constraint sign_in_attempts_outcome_known check (
    last_outcome in (
      'signedIn', 'secondProofNeeded', 'wrong', 'paused', 'expired', 'alreadySignedIn', 'attemptNotFound',
      'waitingForText'
    )
  ),
  constraint sign_in_attempts_check_has_outcome check ((last_check_sha256 is null) = (last_outcome is null))
);

-- The contact's pause (rule 2) and the day's cap (rule 3): the contact's attempts started in the last 24 hours.
create index sign_in_attempts_contact_idx on sign_in_attempts (contact_hash, started_at);
-- The hourly bound (rule 0): every contact's attempts started in the last hour.
create index sign_in_attempts_started_idx on sign_in_attempts (started_at);

create trigger sign_in_attempts_version_raised
  before update on sign_in_attempts
  for each row execute function enforce_version_raise();

-- The runtime side only (rule 9); the Tool API holds no grant on the table.
grant select, insert, update on sign_in_attempts to rosie_job;

-- Rule 9: one policy, the runtime side's, every row. None for the Tool API.
alter table sign_in_attempts enable row level security;
create policy sign_in_attempts_runtime on sign_in_attempts for all to rosie_job
  using (true)
  with check (true);

-- sign_in_attempt (rule 9): the attempt with that page attempt id whose device_sha256 is the one given, locked FOR
-- UPDATE for the rest of the caller's transaction, so the checks of one attempt run one at a time; no row for an unknown
-- id, for another device and for a NULL argument, one answer for all three (K-21's attemptNotFound). expired is `at`
-- after expires_at (at expires_at itself the attempt is still in time, as check_proof_code reads a code); paused is
-- paused_until after `at`; signed_in is a session named. It answers the person because the call cannot read the row (as
-- session_for_token does); the check acts for that person only once the code is right (rule 4). Volatile: it locks.
create function sign_in_attempt(attempt_id text, device_sha256 text, at timestamptz)
returns table (
  id text,
  person_id text,
  owner_or_admin boolean,
  proof_code_id text,
  way text,
  expires_at timestamptz,
  expired boolean,
  wrong_tries integer,
  paused_until timestamptz,
  paused boolean,
  signed_in boolean,
  last_outcome text
)
language sql
volatile
security definer
begin atomic
  select a.id,
         a.person_id,
         a.owner_or_admin,
         a.proof_code_id,
         a.way,
         a.expires_at,
         sign_in_attempt.at > a.expires_at,
         a.wrong_tries,
         a.paused_until,
         coalesce(a.paused_until > sign_in_attempt.at, false),
         a.session_id is not null,
         a.last_outcome
    from sign_in_attempts a
    where a.attempt_id = sign_in_attempt.attempt_id
      and a.device_sha256 = sign_in_attempt.device_sha256
      and sign_in_attempt.at is not null
    for update of a;
end;

-- sign_in_attempt_tried (rule 9): records one check of the attempt with that id, locking it FOR UPDATE. A NULL id,
-- check_sha256 or at, a check_sha256 not of the form ^[0-9a-f]{64}$, an unknown id, or an outcome that is neither NULL
-- nor one of K-21's eight labels answers no row and writes nothing. Then, in order: (1) check_sha256 equal to the
-- attempt's last_check_sha256 is a repeat: nothing written, and it answers repeated true with the first result; (2) a
-- NULL outcome is the look: nothing written, the attempt as it stands; (3) wrong is a wrong try, counted when the attempt
-- has fewer than five, no pause, and `at` is not after expires_at: wrong_tries rises by one, last_wrong_at becomes `at`,
-- and at the fifth paused_until becomes `at` plus 15 minutes, as check_proof_code counts a code's, the check recorded as
-- wrong, or paused at the fifth; otherwise nothing is counted and the check is recorded as paused while the pause is on
-- at `at`, else expired; (4) any other label is recorded as it is, nothing counted. Each write sets last_check_sha256 and
-- raises the version by one, and the call answers repeated false with the attempt after it. A count never passes five
-- and a pause is always the fifth's `at` plus 15 minutes, so every write meets the table's CHECKs (DL-170).
create function sign_in_attempt_tried(id text, check_sha256 text, outcome text, at timestamptz)
returns table (repeated boolean, wrong_tries integer, paused_until timestamptz, last_outcome text)
language plpgsql
volatile
security definer
as $$
declare
  attempt sign_in_attempts%rowtype;
  recorded text;
  tries integer;
  pause timestamptz;
  answer text;
begin
  if sign_in_attempt_tried.id is null
     or sign_in_attempt_tried.check_sha256 is null
     or sign_in_attempt_tried.at is null
     or sign_in_attempt_tried.check_sha256 !~ '^[0-9a-f]{64}$'
     or (
       sign_in_attempt_tried.outcome is not null
       and sign_in_attempt_tried.outcome not in (
         'signedIn', 'secondProofNeeded', 'wrong', 'paused', 'expired', 'alreadySignedIn', 'attemptNotFound',
         'waitingForText'
       )
     ) then
    return;
  end if;
  select a.* into attempt from sign_in_attempts a where a.id = sign_in_attempt_tried.id for update;
  if not found then
    return;
  end if;
  if attempt.last_check_sha256 = sign_in_attempt_tried.check_sha256 then
    return query select true, attempt.wrong_tries, attempt.paused_until, attempt.last_outcome;
    return;
  end if;
  if sign_in_attempt_tried.outcome is null then
    return query select false, attempt.wrong_tries, attempt.paused_until, attempt.last_outcome;
    return;
  end if;
  if sign_in_attempt_tried.outcome = 'wrong'
     and attempt.wrong_tries < 5
     and attempt.paused_until is null
     and sign_in_attempt_tried.at <= attempt.expires_at then
    update sign_in_attempts a
      set wrong_tries = a.wrong_tries + 1,
          last_wrong_at = sign_in_attempt_tried.at,
          paused_until = case
            when a.wrong_tries + 1 = 5 then sign_in_attempt_tried.at + interval '15 minutes'
          end,
          last_outcome = case when a.wrong_tries + 1 = 5 then 'paused' else 'wrong' end,
          last_check_sha256 = sign_in_attempt_tried.check_sha256,
          version = a.version + 1
      where a.id = attempt.id
      returning a.wrong_tries, a.paused_until, a.last_outcome into tries, pause, answer;
    return query select false, tries, pause, answer;
    return;
  end if;
  if sign_in_attempt_tried.outcome = 'wrong' then
    recorded := case when attempt.paused_until > sign_in_attempt_tried.at then 'paused' else 'expired' end;
  else
    recorded := sign_in_attempt_tried.outcome;
  end if;
  update sign_in_attempts a
    set last_outcome = recorded,
        last_check_sha256 = sign_in_attempt_tried.check_sha256,
        version = a.version + 1
    where a.id = attempt.id
    returning a.wrong_tries, a.paused_until, a.last_outcome into tries, pause, answer;
  return query select false, tries, pause, answer;
end;
$$;

-- sign_in_attempt_signed_in (rule 9): sets the attempt's session_id and raises its version only when the attempt names a
-- code, names no session yet, and the session exists with the attempt's person and the attempt's code as its
-- proof_code_id (rule 5's sessions_proof_code_key then lets that code start no other); answers true. Anything else, a
-- NULL argument included, writes nothing and answers false. A new device's second proof starts its session naming the
-- same sign-in code (rule 4), so the call that completes it names the attempt the same way. One code names at most one
-- attempt and one session, so no other attempt can name that session: the write meets every unique rule and CHECK.
create function sign_in_attempt_signed_in(id text, session_id text)
returns boolean
language plpgsql
volatile
security definer
as $$
begin
  if sign_in_attempt_signed_in.id is null or sign_in_attempt_signed_in.session_id is null then
    return false;
  end if;
  update sign_in_attempts a
    set session_id = sign_in_attempt_signed_in.session_id,
        version = a.version + 1
    where a.id = sign_in_attempt_signed_in.id
      and a.proof_code_id is not null
      and a.session_id is null
      and exists (
        select 1
          from sessions s
          where s.id = sign_in_attempt_signed_in.session_id
            and s.person_id = a.person_id
            and s.proof_code_id = a.proof_code_id
      );
  return found;
end;
$$;

-- The search_path of each function: this file's schema (public on staging, preview_<slug> for a preview, a test's own
-- schema), known only when it runs, then pg_temp last (PostgreSQL searches pg_temp first unless it is named).
do $$
begin
  execute format(
    'alter function %I.sign_in_attempt(text, text, timestamptz) set search_path = %I, pg_temp',
    current_schema(), current_schema()
  );
  execute format(
    'alter function %I.sign_in_attempt_tried(text, text, text, timestamptz) set search_path = %I, pg_temp',
    current_schema(), current_schema()
  );
  execute format(
    'alter function %I.sign_in_attempt_signed_in(text, text) set search_path = %I, pg_temp',
    current_schema(), current_schema()
  );
end
$$;

revoke all on function sign_in_attempt(text, text, timestamptz) from public;
revoke all on function sign_in_attempt_tried(text, text, text, timestamptz) from public;
revoke all on function sign_in_attempt_signed_in(text, text) from public;
grant execute on function sign_in_attempt(text, text, timestamptz) to rosie_app, rosie_job;
grant execute on function sign_in_attempt_tried(text, text, text, timestamptz) to rosie_app, rosie_job;
grant execute on function sign_in_attempt_signed_in(text, text) to rosie_app, rosie_job;
