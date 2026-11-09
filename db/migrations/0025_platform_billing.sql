-- T-209: the platform billing part (K-33 v1, frozen: contracts/db-schema/platform-billing, its table list and its
-- README's rules 1 to 5): Rosfield's own billing of each business. The card for Rosfield's monthly bill saved at S1-29
-- as Stripe's opaque ids only; one bill per company (business) and month for last month's $2s and 1%s, sent on the 1st
-- or the next weekday and charged 2 days later, with its one pay link and the pause on new Rosie bookings while it stays
-- unpaid; and the bill's lines, each of which the owner can question (arch 09 line 470: 2 tables, no names; the README
-- holds 3; S1-29; S11-66 to S11-69; FS row M04 and lines 394 to 404, 733; C-169).
-- Expand only: three new tables with their indexes; the version trigger (enforce_version_raise() from 0002, T-181) on
-- all three; grants to the two roles 0012 made (never created or altered here); row-level security switched on with
-- 0012's two policies on all three. Nothing is dropped, renamed or retyped, and no row is written or removed; no K-04,
-- K-07 or K-23 table is altered. Not here: charging the bill and the pay link on Stripe (K-14's port, the integrations
-- engineer's C-215; the effect rows through K-05 v1.1); the monthly billing job and the counting of each fee (K-32);
-- the rules README rule 4 leaves to code (a bill's total is its standing lines with each person's $2s capped at 4900
-- cents; the charge effect's amount is the total when it is written; a bill takes the business's live card when it is
-- made; a line's booking and fee belong to the bill's business and month; a question comes before charge_on; whoever
-- answers is on Rosie's team, Q-18; a card on several businesses belongs to one owner; the charge is written on
-- charge_on and the pause after the whole pay_by day, in the business's zone); the migration-side contract test (QA's
-- tests/contract/db-schema.platform-billing.v1.test.ts, T-110).
--
-- The three tables live beside K-04's tables and K-07's effects (rule 1), and their foreign keys name them by key
-- (businesses.id, persons.id, bookings.id, effects.id) and each other, with no schema prefix, all on delete restrict, so
-- this file runs after 0015, which migrated effects with K-05 v1.1. No table here refers to a K-23 table, and
-- monthly_bill_lines.fee_id has no foreign key yet: K-32 adds the one to its fee table. A bill is charged only on a card
-- of its own business (monthly_bills_card_fk on bill_cards_id_business_key), and a line belongs to its bill's business
-- (monthly_bill_lines_bill_fk on monthly_bills_id_business_key). MATCH SIMPLE: a bill with no card leaves that key
-- unchecked. Ids are text, opaque strings code makes and never parses (rule 5; CQ-09). Money is whole cents in bigint
-- with a currency code, USD only, since Rosfield's fee terms are stated in US dollars ($2, $49) (rule 5).
--
-- No card number, expiry or card detail is ever stored (RULES 4.5; BP rule 7): a card is Stripe's opaque customer and
-- payment-method ids, and bill_cards_no_card_number refuses a run of 13 or more digits in either, with spaces and dashes
-- taken out first (23514). The charge and the pay link are K-07 effect rows (rosfield_monthly_charge, stripe_pay_link)
-- that hold Stripe's object ids and results; a bill names them by charge_effect_id and pay_link_effect_id, each unique,
-- and repeats none of their columns, so a declined charge is never retried and a bill never has a second pay link.
--
-- The days (S11-66, S11-67): monthly_bills_bill_date_rule holds the bill day to the 1st of the next month, or the
-- Monday after it when the 1st is a Saturday or a Sunday (no public holiday moves it: the sources name none), and
-- monthly_bills_charge_two_days_later holds the charge 2 days after; the pay link gives 14 days to pay
-- (monthly_bills_pay_by_fourteen_days), and the pause comes no sooner than 14 days after the link went
-- (monthly_bills_paused_after_pay_by). Each state holds its own times (monthly_bills_state_matches): sent, charged,
-- pay_link (no card, or the card declined), paused, paid (only by the link; paying it ends a pause).
--
-- Versions (rule 3): all three are updated (a card removed; a bill charged, declined, paid or paused; a line questioned
-- or answered), so each carries a version that every update raises by exactly one (K-04 rule 2; the trigger refuses any
-- other update, 23514), compared and set by a commit; each has a one-column key (id) a commit can name in versions_read.
--
-- Row-level security (arch 10 line 546; K-04 v1 rule 4): all three are scoped by business, on business_id (never null
-- here), with 0012's two policies: <table>_tool_api lets rosie_app see and write only rows whose business_id equals its
-- scope (the setting rosie.business_id), and none with no scope; <table>_runtime lets rosie_job see every row with no
-- scope, else only its scope's. None is forced: the tables' owner (the migrations' role) is not bound. What the Tool API
-- may change within its own rows is privilege (rule 2), below. A foreign-key check runs as the owner, so a bill's card
-- and a line's bill are checked without row-level security.
--
-- Grants (DL-149: each to a named reader; README rule 2, K-04 v1 rule 4's two sides). No DELETE (no row here is removed
-- by any named call: a card ends by removed_at, a wrong line comes off by its outcome), TRUNCATE, REFERENCES or TRIGGER,
-- and nothing to PUBLIC. Neither role owns a table.
--   rosie_job, the runtime side: SELECT, INSERT, UPDATE on all three, behind 0012's policies.
--     bill_cards: K-05 commitTurn per write (item 1), whose state writes admit every domain table, writes a card a
--       journey 1 turn keeps (S1-29) and a card replaced, and compares rows FOR SHARE or FOR UPDATE (which take UPDATE
--       as well as SELECT); the monthly billing job (the minute sweep's clock row no handle owns, arch 10 line 540)
--       takes the business's live card when it makes a bill, and the charge names its payment-method id (K-07's
--       rosfield_monthly_charge through K-14, C-215), which also finds every business one card pays
--       (bill_cards_payment_method_idx).
--     monthly_bills: rule 2: the runtime side writes every bill. The monthly billing job makes it (S11-66); the charge's
--       and the pay link's results through K-05 v1.1 (C-109, C-112) set charged, or declined with the one pay link
--       (S11-67, S11-68); the payment's provider event sets paid; the job sets the pause after the pay-by day (S11-69);
--       readTurnState (item 26) and the commit (C-087) read the pause on every new booking.
--     monthly_bill_lines: rule 2: the monthly billing job writes the lines from K-32's fees, and Rosie's team answers a
--       questioned line on this side (C-194, through the open-question reads of monthly_bill_lines_open_question_idx),
--       until K-21 names its role (K-37 v1 rule 2); the bill's total is summed from them (README rule 4).
--   rosie_app, the Tool API, under one business's scope (rule 2), behind 0012's policies:
--     bill_cards: SELECT and INSERT, and UPDATE of removed_at and version only (column grants). S1-29's call (C-074
--       gives bill_card) and the bill card screen through K-21 (C-190, screen 20) save the card, and a new card is a
--       new row after the old one gets removed_at; the owner console's Money page shows it (C-192). Stripe's ids are
--       never changed in place: an update naming any other column is refused (42501).
--     monthly_bills: SELECT only: the owner's Money page (C-192, Rosfield's monthly bill), the pay link page (C-200) and
--       the pause read by a Tool API call that makes a new booking (rule 2; the booking page and the AI assistants'
--       answer, S11-69). Every write is refused (42501).
--     monthly_bill_lines: SELECT, and UPDATE of questioned_at, questioned_by_person_id, question and version only
--       (column grants): the Money page's "See every booking" (C-192, S11-66) reads the lines, and the owner questions one
--       in the portal before the charge. Adding a line or answering one is refused (42501; refuse-owner-removes-line).

-- The card for Rosfield's monthly bill (FS row M04; S1-29), per business, never a customer's card: only Stripe's opaque
-- customer and payment-method ids, who saved it and when. One live card per business; one card may pay every company's
-- bill, so the same Stripe ids may sit on a row of each of the owner's businesses. A new card is a new row, and the old
-- one gets removed_at.
create table bill_cards (
  id text primary key,
  business_id text not null,
  saved_by_person_id text not null,
  stripe_customer_id text not null,
  stripe_payment_method_id text not null,
  saved_at timestamptz not null,
  removed_at timestamptz,
  version integer not null default 1,
  constraint bill_cards_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint bill_cards_saved_by_fk foreign key (saved_by_person_id) references persons (id) on delete restrict,
  constraint bill_cards_id_business_key unique (id, business_id),
  constraint bill_cards_no_card_number check (
    regexp_replace(stripe_customer_id, '[ -]', '', 'g') !~ '[0-9]{13,}'
      and regexp_replace(stripe_payment_method_id, '[ -]', '', 'g') !~ '[0-9]{13,}'
  ),
  constraint bill_cards_ids_present check (length(stripe_customer_id) > 0 and length(stripe_payment_method_id) > 0),
  constraint bill_cards_removed_after_saved check (removed_at is null or removed_at >= saved_at)
);

-- One live card per business (FS row M04; S11-67): a partial unique index, as the table list's unique rule with its
-- where.
create unique index bill_cards_one_live on bill_cards (business_id) where removed_at is null;
-- Every business one card pays, so a card the owner replaces or that Stripe reports changed is found on each company's
-- row (S1-29: "One card can pay every company's bill").
create index bill_cards_payment_method_idx on bill_cards (stripe_payment_method_id) where removed_at is null;

create trigger bill_cards_version_raised
  before update on bill_cards
  for each row execute function enforce_version_raise();

-- Rosfield's monthly bill (S11-66 to S11-69): one per company (business) and month, for last month's $2s and 1%s; its
-- bill day and charge day, total, card, state, the charge and the one pay link as K-07 effect rows, the pay-by day, when
-- it was paid, and the pause on new bookings through Rosie while it stays unpaid.
create table monthly_bills (
  id text primary key,
  business_id text not null,
  month date not null,
  bill_date date not null,
  charge_on date not null,
  sent_at timestamptz not null,
  total_cents bigint not null,
  currency text not null default 'USD',
  bill_card_id text,
  state text not null default 'sent',
  charge_effect_id text,
  charged_at timestamptz,
  declined_at timestamptz,
  pay_link_effect_id text,
  pay_link_sent_at timestamptz,
  pay_by date,
  paid_at timestamptz,
  paused_at timestamptz,
  version integer not null default 1,
  constraint monthly_bills_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint monthly_bills_card_fk foreign key (bill_card_id, business_id)
    references bill_cards (id, business_id) on delete restrict,
  constraint monthly_bills_charge_effect_fk foreign key (charge_effect_id) references effects (id) on delete restrict,
  constraint monthly_bills_pay_link_effect_fk foreign key (pay_link_effect_id)
    references effects (id) on delete restrict,
  constraint monthly_bills_business_month_key unique (business_id, month),
  constraint monthly_bills_id_business_key unique (id, business_id),
  constraint monthly_bills_charge_effect_key unique (charge_effect_id),
  constraint monthly_bills_pay_link_effect_key unique (pay_link_effect_id),
  constraint monthly_bills_month_first_day check (extract(day from month) = 1),
  constraint monthly_bills_bill_date_rule check (
    bill_date = (month + interval '1 month')::date
      + (case extract(isodow from month + interval '1 month') when 6 then 2 when 7 then 1 else 0 end)
  ),
  constraint monthly_bills_charge_two_days_later check (charge_on = bill_date + 2),
  constraint monthly_bills_money check (total_cents >= 0 and currency = 'USD'),
  constraint monthly_bills_state_known check (state in ('sent', 'charged', 'pay_link', 'paused', 'paid')),
  constraint monthly_bills_state_matches check (
    (
      state = 'sent' and charged_at is null and pay_link_sent_at is null and paid_at is null and paused_at is null
    ) or (
      state = 'charged' and charged_at is not null and pay_link_sent_at is null and paid_at is null
        and paused_at is null
    ) or (
      state = 'pay_link' and pay_link_sent_at is not null and paid_at is null and paused_at is null
    ) or (
      state = 'paused' and paused_at is not null and paid_at is null
    ) or (
      state = 'paid' and paid_at is not null
    )
  ),
  constraint monthly_bills_charge_on_card check (
    (charge_effect_id is null or bill_card_id is not null)
      and ((charged_at is null and declined_at is null) or charge_effect_id is not null)
      and (charged_at is null or declined_at is null)
  ),
  constraint monthly_bills_pay_link_when_due check (
    (pay_link_sent_at is not null) = (bill_card_id is null or declined_at is not null)
      and (pay_link_sent_at is null) = (pay_by is null)
      and (pay_link_sent_at is null) = (pay_link_effect_id is null)
  ),
  constraint monthly_bills_pay_by_fourteen_days check (
    pay_by is null or pay_by = (case when declined_at is not null then charge_on else bill_date end) + 14
  ),
  constraint monthly_bills_paid_by_link check (paid_at is null or pay_link_sent_at is not null),
  constraint monthly_bills_paused_after_pay_by check (
    paused_at is null or (pay_link_sent_at is not null and paused_at >= pay_link_sent_at + interval '14 days')
  ),
  constraint monthly_bills_paid_ends_pause check (paused_at is null or paid_at is null or paid_at > paused_at),
  constraint monthly_bills_times_in_order check (
    (charged_at is null or charged_at >= sent_at)
      and (declined_at is null or declined_at >= sent_at)
      and (pay_link_sent_at is null or pay_link_sent_at >= sent_at)
      and (paid_at is null or paid_at >= pay_link_sent_at)
  )
);

-- Whether a business's new bookings through Rosie are paused for an unpaid bill, read by every new booking, the booking
-- page and the AI assistants' answer (S11-69).
create index monthly_bills_paused_idx on monthly_bills (business_id) where state = 'paused';
-- The monthly billing job finds the bills to charge on their day (S11-67; arch 10 line 540).
create index monthly_bills_charge_due_idx on monthly_bills (charge_on)
  where state = 'sent' and bill_card_id is not null and charge_effect_id is null;
-- The job finds pay links past due, to pause new bookings (S11-68 "Still unpaid in time"; S11-69).
create index monthly_bills_pay_by_idx on monthly_bills (pay_by) where state = 'pay_link';

create trigger monthly_bills_version_raised
  before update on monthly_bills
  for each row execute function enforce_version_raise();

-- A line of a monthly bill (S11-66; S1-25; A9-21): one counted Rosfield fee, a $2 for a booking (rosfield_2, toward the
-- cap of the person who gave the work) or 1% of a plan charged monthly through Rosie (rosfield_1pct, no cap), as the
-- bill's "See every booking" page shows it; the K-32 fee it bills, once; and the owner's question, with the answer of a
-- person on Rosie's team (stands, or removed: a wrong line comes off).
create table monthly_bill_lines (
  id text primary key,
  bill_id text not null,
  business_id text not null,
  kind text not null,
  fee_id text not null,
  booking_id text,
  counts_for_person_id text,
  plan_charge_cents bigint,
  amount_cents bigint not null,
  currency text not null default 'USD',
  questioned_at timestamptz,
  questioned_by_person_id text,
  question text,
  answered_at timestamptz,
  answered_by_person_id text,
  outcome text,
  version integer not null default 1,
  constraint monthly_bill_lines_bill_fk foreign key (bill_id, business_id)
    references monthly_bills (id, business_id) on delete restrict,
  constraint monthly_bill_lines_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint monthly_bill_lines_counts_for_fk foreign key (counts_for_person_id)
    references persons (id) on delete restrict,
  constraint monthly_bill_lines_questioned_by_fk foreign key (questioned_by_person_id)
    references persons (id) on delete restrict,
  constraint monthly_bill_lines_answered_by_fk foreign key (answered_by_person_id)
    references persons (id) on delete restrict,
  constraint monthly_bill_lines_fee_key unique (fee_id),
  constraint monthly_bill_lines_kind_known check (kind in ('rosfield_2', 'rosfield_1pct')),
  constraint monthly_bill_lines_two_dollars check (
    kind <> 'rosfield_2'
      or (
        amount_cents = 200 and booking_id is not null and counts_for_person_id is not null
          and plan_charge_cents is null
      )
  ),
  constraint monthly_bill_lines_one_percent check (
    kind <> 'rosfield_1pct'
      or (
        plan_charge_cents is not null and plan_charge_cents > 0
          and amount_cents in (plan_charge_cents / 100, (plan_charge_cents + 99) / 100)
          and counts_for_person_id is null
      )
  ),
  constraint monthly_bill_lines_currency check (currency = 'USD'),
  constraint monthly_bill_lines_question_together check (
    (questioned_at is null) = (questioned_by_person_id is null) and (question is null or questioned_at is not null)
  ),
  constraint monthly_bill_lines_answer_together check (
    (answered_at is null) = (answered_by_person_id is null)
      and (answered_at is null) = (outcome is null)
      and (answered_at is null or (questioned_at is not null and answered_at >= questioned_at))
  ),
  constraint monthly_bill_lines_outcome_known check (outcome is null or outcome in ('stands', 'removed'))
);

-- A bill's lines, for "See every booking" and the total (S11-66).
create index monthly_bill_lines_bill_idx on monthly_bill_lines (bill_id);
-- Questioned lines still waiting for Rosie's team, oldest first, in the team console (S11-66; C-194).
create index monthly_bill_lines_open_question_idx on monthly_bill_lines (questioned_at)
  where questioned_at is not null and answered_at is null;
-- The bill line a booking's $2 went on, for the Money page and the booking's own costs (FS line 621; S11-63).
create index monthly_bill_lines_booking_idx on monthly_bill_lines (booking_id) where booking_id is not null;

create trigger monthly_bill_lines_version_raised
  before update on monthly_bill_lines
  for each row execute function enforce_version_raise();

-- Grants (the readers each serves are named in this file's header).
-- The runtime side: every table in full but DELETE, behind the policies below (rule 2: it writes every bill and line).
grant select, insert, update on bill_cards, monthly_bills, monthly_bill_lines to rosie_job;
-- The Tool API (rule 2): a card is selected and inserted, and only its removal and version change; a bill is only read;
-- a line is read, and only its question and version change.
grant select, insert, update (removed_at, version) on bill_cards to rosie_app;
grant select on monthly_bills to rosie_app;
grant select, update (questioned_at, questioned_by_person_id, question, version) on monthly_bill_lines to rosie_app;

-- Row-level security on the three business-scoped tables: rosie_app sees only its scope; rosie_job sees everything with
-- no scope, else only its scope.
alter table bill_cards enable row level security;
create policy bill_cards_tool_api on bill_cards for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy bill_cards_runtime on bill_cards for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table monthly_bills enable row level security;
create policy monthly_bills_tool_api on monthly_bills for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy monthly_bills_runtime on monthly_bills for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table monthly_bill_lines enable row level security;
create policy monthly_bill_lines_tool_api on monthly_bill_lines for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy monthly_bill_lines_runtime on monthly_bill_lines for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );
