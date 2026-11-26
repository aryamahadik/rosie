-- T-1573: a page's ID upload in flight (K-22 v1.4, frozen: contracts/db-schema/people-access,
-- people-access.v1.4.tables.json and its README's rule 11; DL-1232 on K-05 open gap 107; DL-1250). One row per upload
-- a page's signedUpload made, kept under the upload id the page hands on: the person, the business its page was for
-- (null for a sign_up ID, which is the person's for every company), the purpose, the R2 object key sealed under the
-- person's key, the media type, when it was made, when its signed address lapses, and when finishUpload found the file
-- stored (null until K-13 checkUpload answers stored). K-05 v1.24 item 86 (readPendingUpload) and v1.25 item 94
-- (readUploadFinishedAt) read it by the upload id; the event turn copies the sealed key into S1-10's id_uploads row
-- once the file is stored, and nothing is written to id_uploads before then.
-- Expand only: one new table with its two foreign keys and two CHECKs; grants to one of the two roles 0012 made (never
-- created or altered here); row-level security with one policy. No version column and no 0002 trigger (README default
-- 31: written once, finished once). Nothing is dropped, renamed or retyped, no row is written or removed, and no other
-- table, grant, policy or function changes: v1's, v1.1's, v1.2's and v1.3's tables (0020, 0034, 0036) stay as they are.
-- page_links_person_step_idx, v1.4's other change, is a file of its own (rule 12: built concurrently). Not here:
-- signedUpload's insert and finishUpload's update (card A12), the event turn's copy (card A11), and the migration-side
-- contract test (QA's, db-schema.people-access.v1.4).
--
-- The table follows the table list word for word: 9 columns in its order, with their types and nulls, no defaults; the
-- primary key id; two foreign keys on delete restrict, to K-04's persons and businesses (rule 1: no schema prefix; README
-- default 35); two CHECKs, the purpose known (sign_up or re_check, as id_uploads_purpose_known) and finished no earlier
-- than made (README default 32). No index beyond the primary key: both readers read by the upload id (default 35).
-- object_key is sealed by person_id (rule 6) and never read back to a page.
--
-- Row-level security (rule 11; scope business on business_id, which may be null: README default 30): on, not forced,
-- with one policy, pending_uploads_runtime, for all to rosie_job, 0012's runtime pattern word for word as 0020 writes it
-- for page_links and contact_changes. So the runtime side with no business scope (items 86 and 94, signedUpload's and
-- finishUpload's writes) reads and writes every row, a row with no business included; under a business scope it reads
-- and writes only that business's rows, never another business's and never a row with no business. The Tool API has no
-- policy of its own (README default 34), so a grant given by mistake would still show it no row.
--
-- Grants (DL-149: each to a named reader). rosie_job, the runtime side: SELECT and INSERT, and UPDATE of finished_at
-- alone, so an upload's id, person, business, purpose, object key, media type and times stay as signedUpload bound them
-- (refuse-pending-upload-key-replaced: 42501). rosie_app, the Tool API: no grant on the table at all, not even a column
-- grant, so any read or write it makes is refused (42501: refuse-pending-upload-tool-api-read,
-- refuse-pending-upload-written-by-tool-api), whatever its business scope and person. Neither role holds DELETE (a lapsed
-- upload expires by expires_at and is never touched: DL-1232), TRUNCATE, REFERENCES or TRIGGER, neither owns the table,
-- and nothing goes to PUBLIC. finishUpload sets finished_at only where it is null (its writer's rule, README default 31),
-- since the grant on finished_at allows the update.

-- A page's ID upload, kept under its upload id (README rule 11).
create table pending_uploads (
  id text primary key,
  person_id text not null,
  business_id text,
  purpose text not null,
  object_key bytea not null,
  content_type text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  finished_at timestamptz,
  constraint pending_uploads_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint pending_uploads_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint pending_uploads_purpose_known check (purpose in ('sign_up', 're_check')),
  constraint pending_uploads_finished_after_created check (finished_at is null or finished_at >= created_at)
);

-- The runtime side only (rule 11); the Tool API holds no grant on the table.
grant select, insert on pending_uploads to rosie_job;
grant update (finished_at) on pending_uploads to rosie_job;

-- Rule 11: one policy, the runtime side's, by business as 0012's runtime policy. None for the Tool API.
alter table pending_uploads enable row level security;
create policy pending_uploads_runtime on pending_uploads for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );
