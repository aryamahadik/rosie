-- T-210: the documents and licenses part (K-35 v1, frozen: contracts/db-schema/documents-licenses, its table list and
-- its README's rules 1 to 11): the documents of a business, a team member, a space or thing, a booking or a customer,
-- kept as the business gave them, with no column that says Rosie checked anything; their files as R2 object keys
-- only, sealed; the words of a document Rosie built, per language, with their sha256; who it asks to sign; and each
-- signature, written once (arch 09 line 472: 5 tables, no names; FS line 736; MC C4, C7, C10; D96; RULES 10.1 to 10.5;
-- S1-23, S1-29, S1-61, S1-72, S1-81, S2-06, S2-11, S2-29, A4-24, A4-25, A4-43, A5-19 to A5-23; C-171).
-- Expand only: five new tables with their indexes; the version trigger (enforce_version_raise() from 0002, T-181) on
-- documents, the only one updated; rule 11's trigger on documents and its function documents_signed_by_all_once(),
-- which runs as the calling role (never as definer); grants to the two roles 0012 made (never created or altered here);
-- row-level security switched on with 0012's two policies on all five. Nothing is dropped, renamed or retyped, and no
-- row is written or removed; no K-04, K-22, K-23 or K-25 table is altered. Not here: the files themselves (K-13's files
-- port: the signed upload, the short read link that logs each view, the delete for erasure, which runs before
-- erasePerson() deletes the key); sealing and unsealing (T-182's db/repo/sealing.ts); the rules README rule 9 leaves to
-- code (a booking's document's person is its person served; a booking and a space named here are the document's
-- business's; a given document has files and no texts or signers, a built one texts and signers and no files; a built
-- document is inserted with signed_by_all_at null, and no signer is added once it is set; each signature's commit
-- raises its document's version; a signature is written only by the sign call of the signer's own link; a signature's
-- signed_at is not before its signer's asked_at; S1-72's consent row is written in the signature's commit; a customer's
-- or a booking's number, issuer and end go only to the secure page; title never holds words the person typed); the
-- migration-side contract test (QA's tests/contract/db-schema.documents-licenses.v1.test.ts, T-112).
--
-- The five tables live beside K-04's, K-22's, K-23's and K-25's (rule 1), and their foreign keys name them by key
-- (businesses.id, persons.id and bookings.id; staff (business_id, person_id), K-22's staff_business_person_key;
-- places_or_things.id; services (id, business_id), K-25's services_id_business_key) and each other, with no schema
-- prefix, all on delete restrict. No table here refers to K-29, K-13 or K-30. A team member's document names their staff
-- row at the document's business (documents_staff_fk); the standard agreement names a service of the document's
-- business (documents_service_fk); a file, a text, a signer and a signature stay inside their document's business
-- (documents_id_business_key), a file under its document's person (documents_id_business_person_key), and a signature
-- names its own document's signer and person (document_signers_id_document_person_key) and the exact words of its own
-- document's text (document_texts_id_document_words_key). MATCH SIMPLE: a document with no staff member or service
-- leaves that key unchecked. A booking and a space are held by id alone (K-04 and K-23 give them no key with the
-- business; rule 9). kind_id has no foreign key (the README's open gap, as K-22's staff_skills.kind_id and K-23's
-- company_kinds.kind_id). Ids are text, opaque strings code makes and never parses (rule 3; CQ-09); every time is
-- timestamptz, an instant in UTC, and ends is the words given, never a date (rule 7; MC C4).
--
-- Kept as given, never checked (MC C4, C7; D96; RULES 10): no column says Rosie checked, verified or approved a
-- document, and none holds a lookup result, a status or a parsed end date (refuse-checked-column: 42703). What a person
-- gave, and what a document is, never changes under either application role (rule 5, below): a correction is a new
-- document, and the old one is withdrawn as replaced. A file is taken only on the secure page or in the portal, never
-- from the chat (document_files_via_page_or_portal), and never as a type a browser runs as a page. Only the business's
-- own papers may be on the listing (documents_listing_only_own_papers), and a family's legal papers or court order are
-- a customer's or a booking's only (documents_legal_papers_for_customer).
--
-- Sealed fields (rule 6; T-182's sealing, migration 0003 and db/repo/sealing.ts): documents.number, issuer and ends and
-- document_files.object_key are bytea holding only the sealed form, under the key of the row's person_id in core's
-- sealing_keys (the team member or the customer for their own, documents_sealed_for_owner; the person who gave a
-- business's or a space's paper, documents_paper_sealed_for_giver), and document_signatures.typed_name under the
-- signer's (person_id); no column keeps a plain copy, so erasing the key leaves them unreadable while the proof of each
-- signature stays: who by id, when, how, the words' hash and the words shown, which are never sealed (arch 09 line 492).
--
-- Versions (rule 2): documents carries a version that every update raises by exactly one (K-04 rule 2; the trigger
-- refuses any other update, 23514), compared and set by a commit, with a one-column key (id) a commit can name in
-- versions_read; each signature's commit raises it too (rule 9). The other four are written once and carry none.
--
-- Signed by all, once (rule 11): documents_signed_by_all_once, a second BEFORE UPDATE trigger, refuses an update that
-- moves or clears signed_by_all_at once it is set, and one that sets it while the document has no document_signers row
-- or any signer row has no document_signatures row (matched by signer_id): SQLSTATE 23514 naming the constraint
-- documents_signed_by_all_once, as enforce_version_raise() names <table>_version_raised, never a value. Its function
-- runs as the calling role, so row-level security shows it only its own business's signers and signatures, and a call
-- that sees no signer is refused; its search_path is pinned below to this file's schema, then pg_temp last, so a
-- temporary table the caller makes never stands in for either table. It fires on update only: a built document is
-- inserted before its signer rows (their foreign key), so an insert's signed_by_all_at is code's (rule 9), and a seed
-- loads a signed document as it stands (seed-agreement-signed). Any other update passes it.
--
-- Row-level security (arch 10 line 546; K-04 v1 rule 4; README rule 4): all five are scoped by business, on business_id
-- (never null here), with 0012's two policies: <table>_tool_api lets rosie_app see and write only rows whose business_id
-- equals its scope (the setting rosie.business_id), and none with no scope; <table>_runtime lets rosie_job see every row
-- with no scope (the 45-day copy or delete works by person across businesses: C-156; RULES 4.10), else only its scope's.
-- None is forced: the tables' owner (the migrations' role) is not bound. A foreign-key check runs as the owner, so a
-- file's document and a signature's signer and text are checked without row-level security.
--
-- Grants (DL-149: each to a named reader; README rule 5, the same for both application roles). SELECT and INSERT on all
-- five; UPDATE of documents' shown_on_listing, signed_by_all_at, withdrawn_at, withdrawn_why, withdrawn_by_person_id and
-- version only (column grants), so an update naming any other column of documents, or any update of the other four, is
-- refused (42501: refuse-as-given-edit, refuse-signature-edit). No DELETE (records are kept 7 years: RULES 4.10; S13-08;
-- FS line 754; a withdrawn document keeps its row), TRUNCATE, REFERENCES or TRIGGER, and nothing to PUBLIC. Only the
-- tables' owner, the migrations' role, holds more, as K-29 v1 does for consents. Neither role owns a table or the
-- function.
--   rosie_app, the Tool API, under one business's scope, behind 0012's policies:
--     documents: K-09 saveSetupStep and the turn's Tool API calls of journeys 1 and 2 (C-074) write a paper texted in
--       the owner's chat (S1-23, S1-61), a space's papers (S1-81), the agreement the work needs built and sent to the
--       owner (S1-72) and the business's own standard agreement (S1-29); the page calls behind the secure page and the
--       owner console (K-21; C-199, C-192) write a team member's paper (S2-06, kept as added at S2-11, S2-29) and take
--       one off; Go live's "Left unsigned" check (S1-29), the listing page (C-196: documents only as added by the
--       business), the staff page (C-195), the owner console's Documents page and the slot filler and claim check
--       (C-088, C-091) read them. The update grant serves taking a paper off or replacing it, showing it on the listing,
--       signed_by_all_at in the commit of the last signature, and the version every commit compares and sets.
--     document_files: the page calls that take an upload on the secure page or in the portal, through K-13's signed
--       upload (K-21: "a signed upload for ... license files"; S2-06), and the secure page and portal reading a file's
--       object key for K-13's logged read link (C-094).
--     document_texts, document_signers: the call that builds and sends a document (S1-72; A4-43, A5-19 with journeys
--       4 and 5) writes its words per language and asks its signers; the secure page (C-199, C-185) and the portal read
--       them, and Go live's check counts the signers.
--     document_signatures: the secure page's sign call (C-185: "a typed name signs"; S1-72, A5-20), in the commit that
--       raises its document's version; the owner's portal, the customer whose booking it is, and rule 11's trigger
--       (run as the calling role) read them.
--   rosie_job, the runtime side, behind 0012's policies: K-05 commitTurn per write (item 1), whose state writes admit
--     every domain table, writes what a turn decides on these five as the Tool API does above (a paper given in the
--     chat, a document built and sent, a signature's commit), compares documents FOR SHARE or FOR UPDATE (which take
--     UPDATE of a column as well as SELECT); readTurnState (item 26) reads them; the clock withdraws a document not
--     signed in time (A5-23: withdrawn_why not_signed_in_time, no person) through K-05 fireClock; the 45-day copy or
--     delete reads a person's rows across businesses, unscoped (C-156; RULES 4.10).

-- One document of a business, a team member, a space or thing, a booking or a customer (FS line 736): a paper a person
-- gave as their own word, kept exactly as given and never checked, or a document Rosie built for its signers to sign or
-- OK on the secure page. Its number, issuer and end are sealed under person_id's key. Never deleted: a document taken
-- off, replaced or not signed in time keeps its row with withdrawn_at.
create table documents (
  id text primary key,
  business_id text not null,
  owner_kind text not null,
  staff_person_id text,
  place_or_thing_id text,
  booking_id text,
  customer_person_id text,
  person_id text not null,
  kind text not null,
  kind_id text,
  title text not null,
  number bytea,
  issuer bytea,
  ends bytea,
  shown_on_listing boolean not null default false,
  origin text not null,
  given_by_person_id text,
  given_via text,
  added_at timestamptz not null,
  signed_by_all_at timestamptz,
  withdrawn_at timestamptz,
  withdrawn_why text,
  withdrawn_by_person_id text,
  version integer not null default 1,
  service_id text,
  constraint documents_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint documents_staff_fk foreign key (business_id, staff_person_id)
    references staff (business_id, person_id) on delete restrict,
  constraint documents_place_or_thing_fk foreign key (place_or_thing_id)
    references places_or_things (id) on delete restrict,
  constraint documents_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint documents_customer_fk foreign key (customer_person_id) references persons (id) on delete restrict,
  constraint documents_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint documents_given_by_fk foreign key (given_by_person_id) references persons (id) on delete restrict,
  constraint documents_withdrawn_by_fk foreign key (withdrawn_by_person_id) references persons (id) on delete restrict,
  constraint documents_service_fk foreign key (service_id, business_id)
    references services (id, business_id) on delete restrict,
  constraint documents_id_business_key unique (id, business_id),
  constraint documents_id_business_person_key unique (id, business_id, person_id),
  constraint documents_owner_kind_known check (owner_kind in ('business', 'staff', 'place_or_thing', 'booking', 'customer')),
  constraint documents_owner_named check (
    (owner_kind = 'staff') = (staff_person_id is not null)
      and (owner_kind = 'place_or_thing') = (place_or_thing_id is not null)
      and (owner_kind = 'booking') = (booking_id is not null)
      and (owner_kind = 'customer') = (customer_person_id is not null)
  ),
  constraint documents_sealed_for_owner check (
    (staff_person_id is null or person_id = staff_person_id)
      and (customer_person_id is null or person_id = customer_person_id)
  ),
  constraint documents_kind_known check (
    kind in (
      'license', 'insurance', 'registration', 'background_check', 'certificate', 'contract', 'estimate', 'proposal',
      'design', 'form', 'agreement', 'bond', 'legal_papers', 'court_order', 'other'
    )
  ),
  constraint documents_title_given check (length(btrim(title)) > 0),
  constraint documents_origin_known check (origin in ('given', 'built')),
  constraint documents_given_by_whom check (
    (origin = 'given' and given_by_person_id is not null and given_via is not null)
      or (origin = 'built' and given_by_person_id is null and given_via is null)
  ),
  constraint documents_given_via_known check (given_via is null or given_via in ('chat', 'secure_page', 'portal')),
  constraint documents_built_to_sign check (
    origin = 'given' or kind in ('contract', 'estimate', 'proposal', 'design', 'form', 'agreement')
  ),
  constraint documents_built_holds_no_given_values check (
    origin = 'given' or (number is null and issuer is null and ends is null)
  ),
  constraint documents_paper_sealed_for_giver check (
    origin = 'built' or owner_kind not in ('business', 'place_or_thing') or person_id = given_by_person_id
  ),
  constraint documents_signed_only_built check (
    signed_by_all_at is null or (origin = 'built' and signed_by_all_at >= added_at)
  ),
  constraint documents_withdrawn_with_why check (
    (withdrawn_at is null) = (withdrawn_why is null) and (withdrawn_at is null or withdrawn_at >= added_at)
  ),
  constraint documents_withdrawn_why_known check (
    withdrawn_why is null or withdrawn_why in ('taken_off', 'replaced', 'not_signed_in_time')
  ),
  constraint documents_withdrawn_by_whom check (
    case
      when withdrawn_why is null then withdrawn_by_person_id is null
      else (withdrawn_why = 'not_signed_in_time') = (withdrawn_by_person_id is null)
    end
  ),
  constraint documents_not_signed_only_built check (
    withdrawn_why is distinct from 'not_signed_in_time' or (origin = 'built' and signed_by_all_at is null)
  ),
  constraint documents_listing_only_own_papers check (
    not shown_on_listing or owner_kind in ('business', 'staff', 'place_or_thing')
  ),
  constraint documents_legal_papers_for_customer check (
    kind not in ('legal_papers', 'court_order') or owner_kind in ('customer', 'booking')
  ),
  constraint documents_standard_agreement_for_service check (
    service_id is null or (owner_kind = 'business' and origin = 'built' and kind = 'agreement' and kind_id is null)
  )
);

-- One standing standard agreement per service, the one A5-19 reads; a new one replaces it (FS row Q02; S1-29; default
-- 16): a partial unique index, as the table list's unique rule with its where.
create unique index documents_one_standard_agreement_per_service on documents (service_id)
  where service_id is not null and withdrawn_at is null;
-- A business's documents by whose they are: the owner console's Documents page and Go live's check for an agreement
-- left unsigned (S1-29).
create index documents_business_owner_idx on documents (business_id, owner_kind);
-- A kind of work's licenses and agreements: Go live keeps that work offline while an agreement it needs is unsigned
-- (S1-29, S1-31; S1-72).
create index documents_kind_of_work_idx on documents (business_id, kind_id) where kind_id is not null;
-- A team member's papers: their secure page and read-back (S2-06), S2-11 and S2-29, and the job limits the business
-- states (S13-15).
create index documents_staff_idx on documents (business_id, staff_person_id) where staff_person_id is not null;
-- A space's or thing's papers (S1-81; FS line 741).
create index documents_place_or_thing_idx on documents (place_or_thing_id) where place_or_thing_id is not null;
-- A booking's documents to sign before its money step (A4-43, A5-19, A5-20).
create index documents_booking_idx on documents (booking_id) where booking_id is not null;
-- A customer's own documents at a business, on their secure page.
create index documents_customer_idx on documents (business_id, customer_person_id) where customer_person_id is not null;
-- The documents the listing shows, as the business's own word (S1-23; S13-11; C-196).
create index documents_listing_idx on documents (business_id) where shown_on_listing and withdrawn_at is null;
-- A person's documents: their own secure page, and the 45-day copy or delete (RULES 4.10; S13-08).
create index documents_person_idx on documents (person_id);

create trigger documents_version_raised
  before update on documents
  for each row execute function enforce_version_raise();

-- A file of a given document (FS line 736, "file (secure)"): a photo or a file such as a PDF, kept private in R2 behind
-- K-13; the row holds only its object key, sealed under the document's person's key, never the file or its bytes.
-- Taken only on the secure page or in the portal. Written once.
create table document_files (
  id text primary key,
  document_id text not null,
  business_id text not null,
  person_id text not null,
  object_key bytea not null,
  content_type text not null,
  uploaded_at timestamptz not null,
  uploaded_by_person_id text not null,
  uploaded_via text not null,
  constraint document_files_document_fk foreign key (document_id, business_id, person_id)
    references documents (id, business_id, person_id) on delete restrict,
  constraint document_files_uploaded_by_fk foreign key (uploaded_by_person_id) references persons (id) on delete restrict,
  constraint document_files_content_type_form check (
    content_type ~ '^(image|application)/[a-z0-9.+-]+$' and content_type not in ('image/svg+xml', 'application/xhtml+xml')
  ),
  constraint document_files_via_page_or_portal check (uploaded_via in ('secure_page', 'portal'))
);

-- A document's files, for the secure page and the portal (S2-06).
create index document_files_document_idx on document_files (document_id);
-- A person's files, for the 45-day copy or delete (RULES 4.10; S13-08).
create index document_files_person_idx on document_files (person_id);

-- The exact words of a document Rosie built, as its signers read them, each in their own language from a checked text
-- (A5-20; RULES 4.11): the words, their sha256 and the checked text's version. One per document and language, written
-- once; never sealed, so a signature's proof survives a person's key being deleted (arch 09 line 492).
create table document_texts (
  id text primary key,
  document_id text not null,
  business_id text not null,
  language text not null,
  words text not null,
  words_sha256 text not null,
  text_version text not null,
  made_at timestamptz not null,
  constraint document_texts_document_fk foreign key (document_id, business_id)
    references documents (id, business_id) on delete restrict,
  constraint document_texts_one_per_language unique (document_id, language),
  constraint document_texts_id_document_words_key unique (id, document_id, words_sha256),
  constraint document_texts_language_form check (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]+)*$'),
  constraint document_texts_words_given check (length(btrim(words)) > 0),
  constraint document_texts_words_sha256_match check (words_sha256 = encode(sha256(convert_to(words, 'UTF8')), 'hex')),
  constraint document_texts_version_given check (length(btrim(text_version)) > 0)
);

-- Who a document Rosie built asks to sign or OK it (FS line 736, "signers"; A5-20; S1-72): the owner, or everyone the
-- plug-in or the owner names, each on their own link; never the business itself. Written once, when it is sent.
create table document_signers (
  id text primary key,
  document_id text not null,
  business_id text not null,
  person_id text not null,
  signs_as text not null,
  asked_at timestamptz not null,
  constraint document_signers_document_fk foreign key (document_id, business_id)
    references documents (id, business_id) on delete restrict,
  constraint document_signers_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint document_signers_one_per_person unique (document_id, person_id),
  constraint document_signers_id_document_person_key unique (id, document_id, person_id),
  constraint document_signers_signs_as_given check (length(btrim(signs_as)) > 0)
);

-- A person's documents to sign, on their own secure page (A5-20; S1-72), and the 45-day copy (RULES 4.10).
create index document_signers_person_idx on document_signers (person_id);

-- One signer's signature, written once and never edited or deleted (FS line 736, "signed_at"; A5-20; S1-72; A4-43): who
-- (their signer row and person), when, how (a tap or a typed name, on the secure page) and the exact words they read
-- (their text row and its sha256). The typed name is sealed under the signer's key; the rest is the proof.
create table document_signatures (
  id text primary key,
  document_id text not null,
  business_id text not null,
  signer_id text not null,
  person_id text not null,
  document_text_id text not null,
  words_sha256 text not null,
  signed_at timestamptz not null,
  how text not null,
  typed_name bytea,
  channel text not null,
  constraint document_signatures_document_fk foreign key (document_id, business_id)
    references documents (id, business_id) on delete restrict,
  constraint document_signatures_signer_fk foreign key (signer_id, document_id, person_id)
    references document_signers (id, document_id, person_id) on delete restrict,
  constraint document_signatures_text_fk foreign key (document_text_id, document_id, words_sha256)
    references document_texts (id, document_id, words_sha256) on delete restrict,
  constraint document_signatures_one_per_signer unique (signer_id),
  constraint document_signatures_how_known check (how in ('tap', 'typed_name')),
  constraint document_signatures_typed_name_given check ((how = 'typed_name') = (typed_name is not null)),
  constraint document_signatures_channel_known check (channel in ('secure_page'))
);

-- Whether everyone has signed (A5-20's "Does everyone sign in time?"; S1-29's "Left unsigned"), and rule 11's trigger.
create index document_signatures_document_idx on document_signatures (document_id);
-- A person's signatures, for their copy and the 45-day copy or delete (RULES 4.10; S13-08).
create index document_signatures_person_idx on document_signatures (person_id);

-- Rule 11: signed_by_all_at is set once, and only while every signer of the document has signed. It reads the signer
-- and signature rows as the calling role (security invoker), so row-level security shows it its own business's, and
-- a call that sees no signer is refused. Each refusal names the constraint documents_signed_by_all_once and no value.
create function documents_signed_by_all_once() returns trigger
language plpgsql
as $$
begin
  if new.signed_by_all_at is not distinct from old.signed_by_all_at then
    return new;
  end if;
  if old.signed_by_all_at is not null then
    raise exception 'update of % must not move or clear signed_by_all_at once it is set', tg_table_name
      using errcode = 'check_violation',
            table = tg_table_name,
            column = 'signed_by_all_at',
            constraint = 'documents_signed_by_all_once';
  end if;
  if not exists (select 1 from document_signers s where s.document_id = new.id)
     or exists (
       select 1 from document_signers s
       where s.document_id = new.id
         and not exists (select 1 from document_signatures g where g.signer_id = s.id)
     ) then
    raise exception 'update of % must not set signed_by_all_at while it has no signer or a signer has not signed',
      tg_table_name
      using errcode = 'check_violation',
            table = tg_table_name,
            column = 'signed_by_all_at',
            constraint = 'documents_signed_by_all_once';
  end if;
  return new;
end;
$$;

-- The function's search_path: this file's schema (public on staging, preview_<slug> for a preview, a test's own
-- schema), known only when it runs, then pg_temp last (PostgreSQL searches pg_temp first unless it is named), as 0020
-- pins its calls'. It stays security invoker.
do $$
begin
  execute format(
    'alter function %I.documents_signed_by_all_once() set search_path = %I, pg_temp',
    current_schema(), current_schema()
  );
end
$$;

create trigger documents_signed_by_all_once
  before update on documents
  for each row execute function documents_signed_by_all_once();

-- Grants (rule 5; the readers each serves are named in this file's header): the same for both application roles.
-- Select and insert on all five; of documents, only its listing flag, signed-by-all time, withdrawal and version change.
grant select, insert on documents, document_files, document_texts, document_signers, document_signatures
  to rosie_app, rosie_job;
grant update (shown_on_listing, signed_by_all_at, withdrawn_at, withdrawn_why, withdrawn_by_person_id, version)
  on documents to rosie_app, rosie_job;

-- Row-level security on the five business-scoped tables: rosie_app sees only its scope; rosie_job sees everything with
-- no scope, else only its scope.
alter table documents enable row level security;
create policy documents_tool_api on documents for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy documents_runtime on documents for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table document_files enable row level security;
create policy document_files_tool_api on document_files for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy document_files_runtime on document_files for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table document_texts enable row level security;
create policy document_texts_tool_api on document_texts for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy document_texts_runtime on document_texts for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table document_signers enable row level security;
create policy document_signers_tool_api on document_signers for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy document_signers_runtime on document_signers for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table document_signatures enable row level security;
create policy document_signatures_tool_api on document_signatures for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy document_signatures_runtime on document_signatures for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );
