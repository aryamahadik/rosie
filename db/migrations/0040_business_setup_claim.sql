-- T-1553: the sign-up's claim per business (K-23 v1.1 business setup, frozen: contracts/db-schema/business-setup,
-- business-setup.v1.1.tables.json and its README's section "v1.1", "The migration" and rule 8; the ruling T-1543's card
-- B14, ops/reviews/signup-remainder/rule-rest.json; DL-1191, DL-1201). business_setup only: the row keeps whose claim
-- the answer to S1-09 carried, owner or helper, and the person whose answer carried it, both or neither, written once by
-- S1-09's writer and read by S1-75 to label its control item (K-09 README default 215 (a) to (c), open gap 200).
-- Expand only: two nullable columns with no default added after v1's columns, in the table list's order (signup_claim,
-- then claimed_by_person_id: README default 10); one foreign key and two CHECKs, each added NOT VALID and then
-- validated (0032's and 0039's form), each the table list's word for word: business_setup_claimed_by_fk,
-- business_setup_signup_claim_known and business_setup_claim_with_person; and rule 8's BEFORE UPDATE row trigger
-- business_setup_claim_set_once with its function, named after it as 0028 names booking_details_set_once(). No index
-- (README default 12), no backfill and no row written or removed (default 13). Nothing is dropped, renamed or retyped,
-- and the other eight tables of the part are untouched. No _contract_ step follows: v1.1 keeps every v1 column.
--
-- Grants and row-level security do not change. 0019's table grants (SELECT, INSERT and UPDATE on business_setup to
-- rosie_app and rosie_job, with no column grant) cover the new columns, as a table grant covers every column, and
-- business_setup keeps 0019's two policies, which read business_id alone.
--
-- Safe to ship dark (build prompt 5.4): every writer on main names neither column, so every row it writes holds both
-- null, meets both CHECKs and the foreign key, and is never refused by rule 8's trigger, which acts only on a row whose
-- claim is on file. Validating reads the rows already there, each of which holds both null: a row that broke one would
-- fail this file, and the file's one transaction would leave nothing applied. In that one transaction the lock each
-- ALTER TABLE takes is held to the commit, the validating scans included (the foreign key's also on persons); on
-- staging's few rows that is brief.
--
-- The database holds the form, the pairing and "once" (README, "What the database holds, and what it leaves to code").
-- That the claimed-by person is the turn's own person, that an owner's claim names the owner of the company the turn
-- runs under, and that a helper is not the owner are rules across tables, kept by S1-09's writer (card B15). Which K-05
-- read gives the claim and which write stores it are K-05 v1.24's (card A9); db/repo's build of them is card A10's.

-- Whose claim the answer to S1-09 carried: owner or helper, as S1-09's settler read it. Null: no claim kept, which S1-75
-- labels unknown.
alter table business_setup add column signup_claim text;
-- The person whose answer to S1-09 carried the claim (persons.id): the turn's own person, on either claim.
alter table business_setup add column claimed_by_person_id text;

-- As v1's business_setup_terms_by_fk (rule 1: core's keys, no schema prefix).
alter table business_setup
  add constraint business_setup_claimed_by_fk foreign key (claimed_by_person_id)
    references persons (id) on delete restrict not valid;
-- S1-09's two answers; unknown, S1-75's label for no claim kept, is never stored (refuse-signup-claim-unknown-word).
alter table business_setup
  add constraint business_setup_signup_claim_known check (
    signup_claim is null or signup_claim in ('owner', 'helper')
  ) not valid;
-- Both or neither: a claim always names its person (refuse-signup-claim-without-person).
alter table business_setup
  add constraint business_setup_claim_with_person check (
    (signup_claim is null) = (claimed_by_person_id is null)
  ) not valid;

-- Every row already there is checked, so each holds for every row from here on.
alter table business_setup validate constraint business_setup_claimed_by_fk;
alter table business_setup validate constraint business_setup_signup_claim_known;
alter table business_setup validate constraint business_setup_claim_with_person;

-- Rule 8: the claim is written once. Its body is the one the README gives. Once signup_claim is on file, any change to
-- it or to claimed_by_person_id, clearing either included, is refused with SQLSTATE 23514 and constraint
-- business_setup_claim_set_once (refuse-signup-claim-second-write); a null claim may be set once, on the insert or by
-- one update, and an update that leaves both as they are passes. A claim on file always has its person
-- (business_setup_claim_with_person), so the old claim alone says whether one is on file. It reads no table, so, as
-- enforce_version_raise() and booking_details_set_once(), it needs no search_path of its own, and it stays security
-- invoker: it runs as the calling role, either application role alike. Its refusal names the constraint and no value.
-- It checks no insert: an insert has no claim on file, and the primary key refuses a second row for a business (23505).
create function business_setup_claim_set_once() returns trigger
language plpgsql
as $$
begin
  if old.signup_claim is not null
     and (new.signup_claim is distinct from old.signup_claim
          or new.claimed_by_person_id is distinct from old.claimed_by_person_id) then
    raise exception 'the sign-up claim is written once and never changed (K-23 v1.1)'
      using errcode = 'check_violation', constraint = 'business_setup_claim_set_once';
  end if;
  return new;
end;
$$;

-- Beside 0019's business_setup_version_raised: PostgreSQL fires a table's BEFORE row triggers in name order, so this
-- one runs first, and either refusal rolls the statement back.
create trigger business_setup_claim_set_once
  before update on business_setup
  for each row execute function business_setup_claim_set_once();
