-- T-723: the money part (K-32 v1, frozen: contracts/db-schema/money, its table list and its README's rules 1 to 10),
-- part 2 of 2: a membership or repeat plan (memberships), each pay link to Rosie's own pay page (pay_links), a pack of
-- credits (packs), a credit used from a pack or membership (credits), the one late-cancel or no-show fee asked about a
-- visit (booking_fees), each charge of a plan (plan_charges), Rosfield's insert-only fee ledger of $2s and 1%s
-- (rosfield_fees), and the daily reconciliation of a business's own Stripe with what it found (reconciliation_runs,
-- reconciliation_findings) (FS lines 733, 737 to 739; arch 09 line 457; arch 10 line 550; RULES 3.9; C-168).
-- Expand only: nine new tables with their indexes; the three keys of part 1's tables (0030, T-722) that name part 2's
-- tables, added with ALTER TABLE ... ADD CONSTRAINT once those tables exist, checked against every row (no NOT VALID;
-- DL-278's way, DL-298): saved_cards_membership_fk, payments_booking_fee_fk and payments_plan_charge_fk; rule 7's
-- set-once triggers on the six tables rule 7 lists here, with 0030's money_set_once() (never made again); the version
-- trigger (enforce_version_raise() from 0002, T-181) on the seven versioned tables; grants to the two roles 0012 made
-- (never created or altered here); row-level security switched on for all nine, with rule 5's policies. Nothing is
-- dropped, renamed or retyped, no row is written or removed, and no other part's table is altered but part 1's two by
-- their three keys. No grant reaches outside the part: rule 5's checks here read consents, booking_lines, bookings,
-- booking_visits, open_questions and outbox_rows, which rosie_app already reads whole (0012, 0013, 0028), so none needs
-- DL-298's two-column form (that grant on effects, 0030's, is unchanged).
--
-- Not here: counting the $2 and the 1% (journey 9, C-107), Rosfield's monthly bill (K-33, T-209), the payments service
-- (C-101) and the K-05 calls that read and write these rows, the rules README rule 10 leaves to code, and the
-- migration-side contract test (QA's tests/contract/db-schema.money.v1.test.ts, T-109).
--
-- The nine live beside K-04's tables and the other parts' (rule 1), and their foreign keys name them by key with no
-- schema prefix (businesses.id, persons.id, bookings.id, open_questions.id, outbox_rows.id, consents.id, services (id,
-- business_id), customers (business_id, person_id), booking_lines.id, booking_visits (id, booking_id)), all on delete
-- restrict, so a pack and a membership name a customer and a service of their own business. Inside the part, composite
-- keys hold every row to its own business ((x_id, business_id) to (id, business_id)). K-04's, K-29's and K-30's rows are
-- keyed without their business (by id, a visit by (id, booking_id)), so a row's business is held to theirs by rule 5's
-- policies below, not by a key. MATCH SIMPLE: a row
-- with no booking, visit, payment, card, credit, plan charge, line, refund, reminder, yes or person leaves that key
-- unchecked. The tables follow the table list's order, each after every table it names (rule 1). Ids are text, opaque
-- strings code makes and never parses (rule 3; CQ-09). No extension beyond K-04's (rule 2).
--
-- Money and times (rule 9): every amount is integer minor units in bigint with its three-letter currency, never a
-- decimal (CQ-09); Rosfield's fees are USD, as K-33's bill. Every instant is timestamptz in UTC; every day (a plan's
-- start, renewal and next charge, a plan charge's period and day, a fee's month) is a date in the business's zone.
--
-- Versions (rule 4): memberships, pay_links, packs, credits, booking_fees, plan_charges and reconciliation_runs carry a
-- version that every update raises by exactly one (K-04 rule 2; the trigger refuses any other update, 23514).
-- rosfield_fees and reconciliation_findings are only inserted and carry none.
--
-- Set once (rule 7): 0030's money_set_once() refuses any change to a listed column once it is not null (23514, the
-- trigger's name as the constraint), and a listed array (pay_links.given_via) may only gain items. With the CHECKs that
-- hold each state to its times, a membership once ended, a pay link once ended, a credit once given back, a fee once
-- charged or dropped (its answer once given), a plan charge once charged or skipped (one that failed only goes on to
-- charged, keeping failed_at) and a finished run never change.
--
-- What may be written (rule 6), by privilege: no DELETE and no TRUNCATE on any of the nine (42501; rule 9 keeps money
-- records 7 years), and neither application role owns a table. reconciliation_runs and reconciliation_findings: the
-- Tool API may only SELECT; the runtime side inserts, never updates a finding, and updates a run only in finished_at,
-- charges_listed, refunds_listed and version. rosfield_fees: insert only (refuse-rosfield-fee-update, 42501). UPDATE of
-- named columns only, for both roles: memberships (next_charge_on, status, paused_at, ended_at, ended_why, version),
-- pay_links (given_via, ended_at, ended_why, version), packs (credits_used, version), credits (returned_at, returned_why,
-- version), booking_fees (reminded_at, answer, answered_at, answered_by_person_id, answered_by_role, option_id, event_id,
-- state, charged_at, dropped_at, version) and plan_charges (reminder_outbox_row_id, state, skipped_why, charged_at,
-- failed_at, skipped_at, version). So no price, period, terms, count total, amount, source, pay link code or plan
-- charge's customer_present is ever changed in place. The Tool API's SELECT of pay_links names every column but
-- code_sha256, so only the runtime side reads a code's hash, and a Tool API read of the whole row is refused
-- (refuse-pay-link-code-read, 42501).
--
-- Row-level security (arch 10 line 546; K-04 v1 rule 4; README rule 5): all nine are scoped by business, on business_id
-- (never null here). Each has 0012's <table>_runtime for rosie_job: every row with no scope (the plan charge job,
-- reconciliation, the monthly bill job, the pay page's server finding a link by its code's hash), else only its
-- scope's. The Tool API (rosie_app) has one policy per command its grants allow: <table>_tool_api_select reads only
-- rows whose business_id equals its scope, and none with no scope; <table>_tool_api_insert, and <table>_tool_api_update
-- where an update is granted, hold the same scope in WITH CHECK (and the update's USING), and also require in WITH
-- CHECK only, for each of booking_id, booking_line_id, visit_id, open_question_id, reminder_outbox_row_id and
-- terms_consent_id the row carries, rule 5's clause (<col> is null or exists (select 1 from <table> r where r.id =
-- <row>.<col> and r.business_id = <row>.business_id)), so a call never names another business's booking, line, visit,
-- question, reminder or yes (42501). reconciliation_runs and reconciliation_findings have only the select policy for
-- the Tool API, rosfield_fees no update policy. No policy is for delete alone; each <table>_runtime is for every
-- command, but no grant allows a delete. None is forced: the tables' owner (the migrations' role) is not bound.

-- A membership or repeat plan with one business (FS line 737): its service and price per charge, written once, how
-- often and how it is paid, its own yes to its terms (a K-29 plan_terms consent, named, never copied), its status. Its
-- cards (saved_cards_membership_fk, below), charges and credits name it.
create table memberships (
  id text primary key,
  business_id text not null,
  person_id text not null,
  service_id text not null,
  kind text not null,
  name text not null,
  price_cents bigint not null,
  currency text not null,
  period interval not null,
  billed text not null,
  visits_per_period integer,
  terms_consent_id text,
  started_on date not null,
  renews_on date,
  next_charge_on date,
  status text not null default 'active',
  paused_at timestamptz,
  ended_at timestamptz,
  ended_why text,
  version integer not null default 1,
  constraint memberships_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint memberships_customer_fk foreign key (business_id, person_id) references customers (business_id, person_id)
    on delete restrict,
  constraint memberships_service_fk foreign key (service_id, business_id) references services (id, business_id)
    on delete restrict,
  constraint memberships_terms_fk foreign key (terms_consent_id) references consents (id) on delete restrict,
  constraint memberships_id_business_key unique (id, business_id),
  constraint memberships_kind_known check (kind in ('membership', 'plan')),
  constraint memberships_billed_known check (billed in ('monthly', 'per_visit', 'outside')),
  constraint memberships_money check (price_cents > 0 and currency ~ '^[A-Z]{3}$'),
  constraint memberships_name_given check (length(btrim(name)) > 0),
  constraint memberships_period_positive check (period > interval '0'),
  constraint memberships_terms_yes check (billed = 'outside' or terms_consent_id is not null),
  constraint memberships_allowance check (visits_per_period is null or visits_per_period > 0),
  constraint memberships_next_charge check (next_charge_on is null or (billed = 'monthly' and status <> 'ended')),
  constraint memberships_status check (
    status in ('active', 'paused', 'ended')
      and (status = 'paused') = (paused_at is not null)
      and (status = 'ended') = (ended_at is not null)
      and (ended_at is null) = (ended_why is null)
      and (ended_why is null or ended_why in ('stopped', 'price_not_agreed', 'business_closed', 'new_terms', 'not_paid'))
  ),
  constraint memberships_dates check (renews_on is null or renews_on > started_on)
);

-- A customer's live memberships and plans: the page's package or membership (A5-01), a credit to use (A5-03), a skip,
-- pause or end (A7-32).
create index memberships_customer_idx on memberships (business_id, person_id) where status <> 'ended';
-- The plan charge job finds the charges due, and the day-before text (S13-39; A7-54).
create index memberships_next_charge_idx on memberships (next_charge_on) where status = 'active' and billed = 'monthly';

create trigger memberships_version_raised
  before update on memberships
  for each row execute function enforce_version_raise();

-- saved_cards' key to the membership a card is saved for (A7-54), now that memberships exists (rule 1; DL-278, DL-298).
alter table saved_cards
  add constraint saved_cards_membership_fk foreign key (membership_id, business_id)
    references memberships (id, business_id) on delete restrict;

-- Each pay link to Rosie's own pay page for one payment its stripe_pay_link effect made (A6-32; A9-05; A9-10): whom it
-- is for, where it was given, its deadline, when it ended; only its code's sha256, never the code. One live link per
-- payment.
create table pay_links (
  id text primary key,
  business_id text not null,
  payment_id text not null,
  person_id text not null,
  given_via text[] not null,
  code_sha256 text not null,
  due_at timestamptz,
  sent_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_why text,
  version integer not null default 1,
  constraint pay_links_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint pay_links_payment_fk foreign key (payment_id, business_id) references payments (id, business_id)
    on delete restrict,
  constraint pay_links_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint pay_links_code_key unique (code_sha256),
  constraint pay_links_given_via check (
    cardinality(given_via) >= 1 and given_via <@ array['text', 'email', 'ai', 'page']::text[]
  ),
  constraint pay_links_code_hash_form check (code_sha256 ~ '^[0-9a-f]{64}$'),
  constraint pay_links_ended check (
    (ended_at is null) = (ended_why is null)
      and (ended_why is null or ended_why in ('paid', 'closed', 'replaced', 'booking_ended'))
      and (ended_at is null or ended_at >= sent_at)
  ),
  constraint pay_links_due_after_sent check (due_at is null or due_at > sent_at)
);

-- One live link per payment: one pay link, with no chasing (S11-68; A6-32), one more only at the owner's word (A9-10).
create unique index pay_links_one_live on pay_links (payment_id) where ended_at is null;
-- A payment's links: the live one the page and the clock row read, and those it replaced (A9-10).
create index pay_links_payment_idx on pay_links (payment_id);

create trigger pay_links_version_raised
  before update on pay_links
  for each row execute function enforce_version_raise();

-- A pack of credits for one service (FS line 738): in visits, minutes or cents, its used count a counter the uses raise
-- in the same commit, held under its total by a CHECK as K-04's class seats are; bought through Rosie by its payment
-- (A5-22) or at the shop (A5-03).
create table packs (
  id text primary key,
  business_id text not null,
  person_id text not null,
  service_id text not null,
  name text not null,
  unit text not null,
  credits_total integer not null,
  credits_used integer not null default 0,
  price_cents bigint not null,
  currency text not null,
  bought_at timestamptz not null,
  bought_via text not null,
  payment_id text,
  recorded_by_person_id text,
  version integer not null default 1,
  constraint packs_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint packs_customer_fk foreign key (business_id, person_id) references customers (business_id, person_id)
    on delete restrict,
  constraint packs_service_fk foreign key (service_id, business_id) references services (id, business_id)
    on delete restrict,
  constraint packs_payment_fk foreign key (payment_id, business_id) references payments (id, business_id)
    on delete restrict,
  constraint packs_recorded_by_fk foreign key (recorded_by_person_id) references persons (id) on delete restrict,
  constraint packs_id_business_key unique (id, business_id),
  constraint packs_payment_key unique (payment_id),
  constraint packs_unit_known check (unit in ('visit', 'minute', 'cent')),
  constraint packs_credits_within_total check (
    credits_total > 0 and credits_used >= 0 and credits_used <= credits_total
  ),
  constraint packs_money check (price_cents >= 0 and currency ~ '^[A-Z]{3}$'),
  constraint packs_bought_via check (
    bought_via in ('rosie', 'shop')
      and (bought_via = 'rosie') = (payment_id is not null)
      and (bought_via = 'shop') = (recorded_by_person_id is not null)
  ),
  constraint packs_name_given check (length(btrim(name)) > 0)
);

-- A customer's packs with credits left: the page's package or membership (A5-01), a credit from Alex's pack (A5-03).
create index packs_customer_idx on packs (business_id, person_id) where credits_used < credits_total;

create trigger packs_version_raised
  before update on packs
  for each row execute function enforce_version_raise();

-- One credit used from a pack or a membership to pay a booking line (FS line 739), and when it was given back.
create table credits (
  id text primary key,
  business_id text not null,
  pack_id text,
  membership_id text,
  booking_line_id text not null,
  units integer not null default 1,
  used_at timestamptz not null,
  returned_at timestamptz,
  returned_why text,
  version integer not null default 1,
  constraint credits_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint credits_pack_fk foreign key (pack_id, business_id) references packs (id, business_id) on delete restrict,
  constraint credits_membership_fk foreign key (membership_id, business_id) references memberships (id, business_id)
    on delete restrict,
  constraint credits_line_fk foreign key (booking_line_id) references booking_lines (id) on delete restrict,
  constraint credits_id_business_key unique (id, business_id),
  constraint credits_from_one check ((pack_id is null) <> (membership_id is null)),
  constraint credits_units_positive check (units > 0),
  constraint credits_returned check (
    (returned_at is null) = (returned_why is null)
      and (returned_why is null or returned_why in ('cancel_in_time', 'called_off', 'not_booked', 'refunded', 'no_fee'))
      and (returned_at is null or returned_at >= used_at)
  )
);

-- One live credit per booking line: the visit uses one credit (A5-03; S13-55).
create unique index credits_one_live_per_line on credits (booking_line_id) where returned_at is null;
-- A pack's credits, which its used count adds up (A5-03).
create index credits_pack_idx on credits (pack_id) where pack_id is not null;
-- A membership's credits, against its allowance a period (A5-21).
create index credits_membership_idx on credits (membership_id) where membership_id is not null;

create trigger credits_version_raised
  before update on credits
  for each row execute function enforce_version_raise();

-- The one late-cancel or no-show fee asked about a visit (FS line 733; S11-22 to S11-28): what it comes from, the
-- owner's answer in K-08's ownerYes shape, and where it stands. Only the owner's yes takes it, never silence.
create table booking_fees (
  id text primary key,
  business_id text not null,
  booking_id text not null,
  visit_id text not null,
  kind text not null,
  amount_cents bigint not null,
  currency text not null,
  comes_from text not null,
  from_payment_id text,
  saved_card_id text,
  credit_id text,
  open_question_id text not null,
  asked_at timestamptz not null,
  answer_by timestamptz not null,
  reminded_at timestamptz,
  answer text,
  answered_at timestamptz,
  answered_by_person_id text,
  answered_by_role text,
  option_id text,
  event_id text,
  state text not null default 'asked',
  charged_at timestamptz,
  dropped_at timestamptz,
  version integer not null default 1,
  constraint booking_fees_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint booking_fees_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint booking_fees_visit_fk foreign key (visit_id, booking_id) references booking_visits (id, booking_id)
    on delete restrict,
  constraint booking_fees_from_payment_fk foreign key (from_payment_id, business_id)
    references payments (id, business_id) on delete restrict,
  constraint booking_fees_saved_card_fk foreign key (saved_card_id, business_id)
    references saved_cards (id, business_id) on delete restrict,
  constraint booking_fees_credit_fk foreign key (credit_id, business_id) references credits (id, business_id)
    on delete restrict,
  constraint booking_fees_question_fk foreign key (open_question_id) references open_questions (id)
    on delete restrict,
  constraint booking_fees_answered_by_fk foreign key (answered_by_person_id) references persons (id)
    on delete restrict,
  constraint booking_fees_id_business_key unique (id, business_id),
  constraint booking_fees_one_per_visit unique (visit_id),
  constraint booking_fees_kind_known check (kind in ('late_cancel', 'no_show', 'nobody_home', 'ended_early')),
  constraint booking_fees_source check (
    comes_from in ('payment', 'card', 'credit')
      and (comes_from = 'payment') = (from_payment_id is not null)
      and (comes_from = 'card') = (saved_card_id is not null)
      and (comes_from = 'credit') = (credit_id is not null)
  ),
  constraint booking_fees_money check (amount_cents > 0 and currency ~ '^[A-Z]{3}$'),
  constraint booking_fees_answer_known check (answer is null or answer in ('charge', 'no_fee', 'no_answer')),
  constraint booking_fees_answered_by check (
    (answered_at is null) = (answer is null)
      and (answer is null or answer = 'no_answer') = (answered_by_person_id is null)
      and (answered_by_person_id is null) = (answered_by_role is null)
      and (answered_by_person_id is null) = (event_id is null)
      and (option_id is null or answered_by_person_id is not null)
      and (answered_by_role is null or answered_by_role in ('owner', 'admin'))
      and (answer is distinct from 'no_answer' or answered_at >= answer_by)
  ),
  constraint booking_fees_state_known check (state in ('asked', 'owner_yes', 'charged', 'dropped')),
  constraint booking_fees_only_owner_yes_takes check (state not in ('owner_yes', 'charged') or answer = 'charge'),
  constraint booking_fees_state_times check (
    (state = 'charged') = (charged_at is not null)
      and (state = 'dropped') = (dropped_at is not null)
      and (state <> 'asked' or answer is null)
  ),
  constraint booking_fees_times check (
    answer_by > asked_at
      and (reminded_at is null or (reminded_at >= asked_at and reminded_at <= answer_by))
      and (answered_at is null or answered_at >= asked_at)
      and (charged_at is null or charged_at >= asked_at)
      and (dropped_at is null or dropped_at >= asked_at)
  )
);

-- Fee questions waiting for the owner: the one reminder and the deadline's no fee (S11-25, S11-28), Needs you (FS 6.2).
create index booking_fees_waiting_idx on booking_fees (answer_by) where state = 'asked';
-- A booking's fee, for its record (S13-57) and the money words (pay.late, pay.noshow).
create index booking_fees_booking_idx on booking_fees (booking_id);

create trigger booking_fees_version_raised
  before update on booking_fees
  for each row execute function enforce_version_raise();

-- payments' key to the fee a fee's payment names (S11-26), now that booking_fees exists (rule 1; DL-278, DL-298).
alter table payments
  add constraint payments_booking_fee_fk foreign key (booking_fee_id, business_id)
    references booking_fees (id, business_id) on delete restrict;

-- One charge of a membership or plan (S13-39; A7-54): the period or visit it pays, its amount and day, the reminder
-- that reached the customer first (or, for a membership's first, bought on the page, that the customer was there), and
-- how it ended, each end set once. One per plan and period, so a retried charge job never charges twice.
create table plan_charges (
  id text primary key,
  business_id text not null,
  membership_id text not null,
  booking_id text,
  period_start date not null,
  period_end date not null,
  amount_cents bigint not null,
  currency text not null,
  due_on date not null,
  reminder_outbox_row_id text,
  customer_present boolean not null default false,
  state text not null default 'due',
  skipped_why text,
  charged_at timestamptz,
  failed_at timestamptz,
  skipped_at timestamptz,
  version integer not null default 1,
  constraint plan_charges_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint plan_charges_membership_fk foreign key (membership_id, business_id)
    references memberships (id, business_id) on delete restrict,
  constraint plan_charges_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint plan_charges_reminder_fk foreign key (reminder_outbox_row_id) references outbox_rows (id)
    on delete restrict,
  constraint plan_charges_id_business_key unique (id, business_id),
  constraint plan_charges_one_per_period unique (membership_id, period_start),
  constraint plan_charges_state_known check (state in ('due', 'charged', 'skipped', 'failed')),
  constraint plan_charges_money check (amount_cents > 0 and currency ~ '^[A-Z]{3}$'),
  constraint plan_charges_period check (period_end >= period_start),
  constraint plan_charges_reminded_first check (
    state not in ('charged', 'failed') or reminder_outbox_row_id is not null or customer_present
  ),
  constraint plan_charges_customer_present check (not customer_present or booking_id is null),
  constraint plan_charges_outcome check (
    (state = 'charged') = (charged_at is not null)
      and (state = 'skipped') = (skipped_at is not null)
      and (state <> 'failed' or failed_at is not null)
      and (failed_at is null or state in ('failed', 'charged'))
  ),
  constraint plan_charges_skipped check (
    (state = 'skipped') = (skipped_why is not null)
      and (skipped_why is null or skipped_why in ('no_reminder', 'paused', 'visit_not_given'))
  ),
  constraint plan_charges_times check ((charged_at is null or failed_at is null or charged_at >= failed_at))
);

-- Only a membership's first charge, bought on the page, is made with the customer present (A5-22; S13-39).
create unique index plan_charges_one_customer_present on plan_charges (membership_id) where customer_present;
-- The plan charge job finds the charges due and their day-before texts (S13-39; A7-54).
create index plan_charges_due_idx on plan_charges (due_on) where state = 'due';

create trigger plan_charges_version_raised
  before update on plan_charges
  for each row execute function enforce_version_raise();

-- payments' key to the plan charge a plan charge's payment names (A7-54), now that plan_charges exists (rule 1; DL-278,
-- DL-298).
alter table payments
  add constraint payments_plan_charge_fk foreign key (plan_charge_id, business_id)
    references plan_charges (id, business_id) on delete restrict;

-- Rosfield's fee ledger (C-107; FS line 733): each $2 counted per booking made through Rosie, toward the cap of the
-- person who gave the work, and each 1% of a plan's monthly charge; insert only, billed on K-33's monthly bill (Q-22),
-- whose line names it.
create table rosfield_fees (
  id text primary key,
  business_id text not null,
  kind text not null,
  booking_id text,
  visit_id text,
  plan_charge_id text,
  counted_at timestamptz not null,
  counted_by text not null,
  counts_for_person_id text,
  month date not null,
  amount_cents bigint not null,
  currency text not null default 'USD',
  plan_charge_cents bigint,
  constraint rosfield_fees_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint rosfield_fees_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint rosfield_fees_visit_fk foreign key (visit_id, booking_id) references booking_visits (id, booking_id)
    on delete restrict,
  constraint rosfield_fees_plan_charge_fk foreign key (plan_charge_id, business_id)
    references plan_charges (id, business_id) on delete restrict,
  constraint rosfield_fees_counts_for_fk foreign key (counts_for_person_id) references persons (id)
    on delete restrict,
  constraint rosfield_fees_id_business_key unique (id, business_id),
  constraint rosfield_fees_kind_known check (kind in ('rosfield_2', 'rosfield_1pct')),
  constraint rosfield_fees_counted_by_known check (counted_by in ('check_in_code', 'done', 'plan_charge')),
  constraint rosfield_fees_two_dollars check (
    kind <> 'rosfield_2'
      or (
        amount_cents = 200
          and booking_id is not null
          and visit_id is not null
          and counts_for_person_id is not null
          and counted_by in ('check_in_code', 'done')
          and plan_charge_id is null
          and plan_charge_cents is null
      )
  ),
  constraint rosfield_fees_one_percent check (
    kind <> 'rosfield_1pct'
      or (
        plan_charge_id is not null
          and plan_charge_cents > 0
          and amount_cents in (plan_charge_cents / 100, (plan_charge_cents + 99) / 100)
          and counted_by = 'plan_charge'
          and counts_for_person_id is null
          and booking_id is null
          and visit_id is null
      )
  ),
  constraint rosfield_fees_money check (amount_cents >= 0 and currency = 'USD'),
  constraint rosfield_fees_month_first_day check (extract(day from month) = 1)
);

-- One $2 per booking (A9-21), and one 1% per plan charge (S1-25): a counting write repeated writes nothing twice.
create unique index rosfield_fees_one_per_booking on rosfield_fees (booking_id) where kind = 'rosfield_2';
create unique index rosfield_fees_one_per_plan_charge on rosfield_fees (plan_charge_id) where plan_charge_id is not null;
-- The monthly bill job reads a business's fees of last month (S11-66; K-33).
create index rosfield_fees_month_idx on rosfield_fees (business_id, month);
-- A person's $2s in a month, toward the $49 cap (A9-21).
create index rosfield_fees_cap_idx on rosfield_fees (business_id, month, counts_for_person_id)
  where kind = 'rosfield_2';

-- Each daily check of one business's own Stripe account (arch 10 line 550): its 48-hour window, when it ran and
-- finished, and what it listed. One per business and window, so a job run again writes no second run.
create table reconciliation_runs (
  id text primary key,
  business_id text not null,
  window_from timestamptz not null,
  window_to timestamptz not null,
  job_id text not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  charges_listed integer,
  refunds_listed integer,
  version integer not null default 1,
  constraint reconciliation_runs_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint reconciliation_runs_id_business_key unique (id, business_id),
  constraint reconciliation_runs_one_per_window unique (business_id, window_from),
  constraint reconciliation_runs_window check (window_to > window_from),
  constraint reconciliation_runs_finished check (
    (finished_at is null) = (charges_listed is null)
      and (finished_at is null) = (refunds_listed is null)
      and (charges_listed is null or (charges_listed >= 0 and refunds_listed >= 0))
      and (finished_at is null or finished_at >= started_at)
  )
);

create trigger reconciliation_runs_version_raised
  before update on reconciliation_runs
  for each row execute function enforce_version_raise();

-- What a daily check found that did not already match, and what it did (arch 10 line 550; S12-24; S12-26; CQ-15):
-- written once by the job, never edited.
create table reconciliation_findings (
  id text primary key,
  run_id text not null,
  business_id text not null,
  kind text not null,
  stripe_object_id text,
  effect_id text,
  ledger_line_id text,
  refund_id text,
  to_team boolean not null,
  found_at timestamptz not null default now(),
  constraint reconciliation_findings_run_fk foreign key (run_id, business_id)
    references reconciliation_runs (id, business_id) on delete restrict,
  constraint reconciliation_findings_business_fk foreign key (business_id) references businesses (id)
    on delete restrict,
  constraint reconciliation_findings_line_fk foreign key (ledger_line_id, business_id)
    references ledger_lines (id, business_id) on delete restrict,
  constraint reconciliation_findings_refund_fk foreign key (refund_id, business_id)
    references refunds (id, business_id) on delete restrict,
  constraint reconciliation_findings_kind_known check (
    kind in ('line_written', 'refunded_at_once', 'line_without_charge', 'no_effect_id', 'other')
  ),
  constraint reconciliation_findings_fits check (
    (kind <> 'line_written' or (ledger_line_id is not null and stripe_object_id is not null and refund_id is null))
      and (
        kind <> 'refunded_at_once'
          or (ledger_line_id is not null and stripe_object_id is not null and refund_id is not null)
      )
      and (kind <> 'line_without_charge' or (ledger_line_id is not null and stripe_object_id is null))
      and (
        kind <> 'no_effect_id'
          or (stripe_object_id is not null and effect_id is null and ledger_line_id is null and refund_id is null)
      )
      and to_team = (kind in ('no_effect_id', 'other'))
  )
);

-- Each listed object found once a run, and each line with no charge: a job run again writes nothing twice.
create unique index reconciliation_findings_object_key on reconciliation_findings (run_id, stripe_object_id)
  where stripe_object_id is not null;
create unique index reconciliation_findings_line_key on reconciliation_findings (run_id, ledger_line_id)
  where kind = 'line_without_charge';
-- What went to Rosie's team, oldest first, within 1 business day (S12-24; C-194).
create index reconciliation_findings_team_idx on reconciliation_findings (found_at) where to_team;

-- Rule 7's lists for part 2's six tables, in the README's order, on 0030's money_set_once() (made once, there).
create trigger memberships_set_once
  before update on memberships
  for each row execute function money_set_once('ended_at', 'ended_why');
create trigger pay_links_set_once
  before update on pay_links
  for each row execute function money_set_once('given_via', 'ended_at', 'ended_why');
create trigger credits_set_once
  before update on credits
  for each row execute function money_set_once('returned_at', 'returned_why');
create trigger booking_fees_set_once
  before update on booking_fees
  for each row execute function money_set_once(
    'reminded_at', 'answer', 'answered_at', 'answered_by_person_id', 'answered_by_role', 'option_id', 'event_id',
    'charged_at', 'dropped_at'
  );
create trigger plan_charges_set_once
  before update on plan_charges
  for each row execute function money_set_once(
    'reminder_outbox_row_id', 'skipped_why', 'charged_at', 'failed_at', 'skipped_at'
  );
create trigger reconciliation_runs_set_once
  before update on reconciliation_runs
  for each row execute function money_set_once('finished_at', 'charges_listed', 'refunds_listed');

-- Grants (rule 6): no DELETE or TRUNCATE anywhere, nothing to PUBLIC, and neither role owns a table. The same for both
-- application roles but for pay_links' code hash, which only the runtime side reads, and reconciliation, which only
-- the runtime side writes.
grant select, insert on memberships, packs, credits, booking_fees, plan_charges, rosfield_fees to rosie_app, rosie_job;
grant update (next_charge_on, status, paused_at, ended_at, ended_why, version) on memberships to rosie_app, rosie_job;
grant update (credits_used, version) on packs to rosie_app, rosie_job;
grant update (returned_at, returned_why, version) on credits to rosie_app, rosie_job;
grant update (
    reminded_at, answer, answered_at, answered_by_person_id, answered_by_role, option_id, event_id, state, charged_at,
    dropped_at, version
  )
  on booking_fees to rosie_app, rosie_job;
grant update (reminder_outbox_row_id, state, skipped_why, charged_at, failed_at, skipped_at, version)
  on plan_charges to rosie_app, rosie_job;
grant select, insert on pay_links to rosie_job;
grant insert on pay_links to rosie_app;
grant select (id, business_id, payment_id, person_id, given_via, due_at, sent_at, ended_at, ended_why, version)
  on pay_links to rosie_app;
grant update (given_via, ended_at, ended_why, version) on pay_links to rosie_app, rosie_job;
grant select on reconciliation_runs, reconciliation_findings to rosie_app;
grant select, insert on reconciliation_runs, reconciliation_findings to rosie_job;
grant update (finished_at, charges_listed, refunds_listed, version) on reconciliation_runs to rosie_job;

-- Row-level security on the nine business-scoped tables (rule 5): rosie_app sees only its scope, and writes a row only
-- in its scope's business, naming only its business's bookings, lines, visits, questions, reminders and yeses; rosie_job
-- sees everything with no scope, else only its scope.
alter table memberships enable row level security;
create policy memberships_tool_api_select on memberships for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy memberships_tool_api_insert on memberships for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and (
      terms_consent_id is null
      or exists (
        select 1 from consents r
        where r.id = memberships.terms_consent_id and r.business_id = memberships.business_id
      )
    )
  );
create policy memberships_tool_api_update on memberships for update to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and (
      terms_consent_id is null
      or exists (
        select 1 from consents r
        where r.id = memberships.terms_consent_id and r.business_id = memberships.business_id
      )
    )
  );
create policy memberships_runtime on memberships for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table pay_links enable row level security;
create policy pay_links_tool_api_select on pay_links for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy pay_links_tool_api_insert on pay_links for insert to rosie_app
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy pay_links_tool_api_update on pay_links for update to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy pay_links_runtime on pay_links for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table packs enable row level security;
create policy packs_tool_api_select on packs for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy packs_tool_api_insert on packs for insert to rosie_app
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy packs_tool_api_update on packs for update to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy packs_runtime on packs for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table credits enable row level security;
create policy credits_tool_api_select on credits for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy credits_tool_api_insert on credits for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and (
      booking_line_id is null
      or exists (
        select 1 from booking_lines r where r.id = credits.booking_line_id and r.business_id = credits.business_id
      )
    )
  );
create policy credits_tool_api_update on credits for update to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and (
      booking_line_id is null
      or exists (
        select 1 from booking_lines r where r.id = credits.booking_line_id and r.business_id = credits.business_id
      )
    )
  );
create policy credits_runtime on credits for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table booking_fees enable row level security;
create policy booking_fees_tool_api_select on booking_fees for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy booking_fees_tool_api_insert on booking_fees for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and (
      booking_id is null
      or exists (
        select 1 from bookings r where r.id = booking_fees.booking_id and r.business_id = booking_fees.business_id
      )
    )
    and (
      visit_id is null
      or exists (
        select 1 from booking_visits r
        where r.id = booking_fees.visit_id and r.business_id = booking_fees.business_id
      )
    )
    and (
      open_question_id is null
      or exists (
        select 1 from open_questions r
        where r.id = booking_fees.open_question_id and r.business_id = booking_fees.business_id
      )
    )
  );
create policy booking_fees_tool_api_update on booking_fees for update to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and (
      booking_id is null
      or exists (
        select 1 from bookings r where r.id = booking_fees.booking_id and r.business_id = booking_fees.business_id
      )
    )
    and (
      visit_id is null
      or exists (
        select 1 from booking_visits r
        where r.id = booking_fees.visit_id and r.business_id = booking_fees.business_id
      )
    )
    and (
      open_question_id is null
      or exists (
        select 1 from open_questions r
        where r.id = booking_fees.open_question_id and r.business_id = booking_fees.business_id
      )
    )
  );
create policy booking_fees_runtime on booking_fees for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table plan_charges enable row level security;
create policy plan_charges_tool_api_select on plan_charges for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy plan_charges_tool_api_insert on plan_charges for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and (
      booking_id is null
      or exists (
        select 1 from bookings r where r.id = plan_charges.booking_id and r.business_id = plan_charges.business_id
      )
    )
    and (
      reminder_outbox_row_id is null
      or exists (
        select 1 from outbox_rows r
        where r.id = plan_charges.reminder_outbox_row_id and r.business_id = plan_charges.business_id
      )
    )
  );
create policy plan_charges_tool_api_update on plan_charges for update to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and (
      booking_id is null
      or exists (
        select 1 from bookings r where r.id = plan_charges.booking_id and r.business_id = plan_charges.business_id
      )
    )
    and (
      reminder_outbox_row_id is null
      or exists (
        select 1 from outbox_rows r
        where r.id = plan_charges.reminder_outbox_row_id and r.business_id = plan_charges.business_id
      )
    )
  );
create policy plan_charges_runtime on plan_charges for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table rosfield_fees enable row level security;
create policy rosfield_fees_tool_api_select on rosfield_fees for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy rosfield_fees_tool_api_insert on rosfield_fees for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and (
      booking_id is null
      or exists (
        select 1 from bookings r where r.id = rosfield_fees.booking_id and r.business_id = rosfield_fees.business_id
      )
    )
    and (
      visit_id is null
      or exists (
        select 1 from booking_visits r
        where r.id = rosfield_fees.visit_id and r.business_id = rosfield_fees.business_id
      )
    )
  );
create policy rosfield_fees_runtime on rosfield_fees for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table reconciliation_runs enable row level security;
create policy reconciliation_runs_tool_api_select on reconciliation_runs for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy reconciliation_runs_runtime on reconciliation_runs for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table reconciliation_findings enable row level security;
create policy reconciliation_findings_tool_api_select on reconciliation_findings for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy reconciliation_findings_runtime on reconciliation_findings for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );
