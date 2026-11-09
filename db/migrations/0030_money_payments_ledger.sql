-- T-722: the money part (K-32 v1, frozen: contracts/db-schema/money, its table list and its README's rules 1 to 10),
-- part 1 of 2: a card saved on the business's own Stripe (saved_cards), money asked and taken (payments), what each
-- payment pays toward each booking line (payment_items), the append-only ledger of every Stripe charge and refund with
-- its K-07 effect id (ledger_lines), and money given back (refunds) (arch 09 lines 457, 469 and 492; arch 10 line 550;
-- RULES 3.1, 3.2; C-168).
-- Expand only: five new tables with their indexes; the foreign keys rule 1 names in a circle (payments and saved_cards,
-- ledger_lines and refunds) added with ALTER TABLE ... ADD CONSTRAINT once both tables exist, checked against every
-- row (no NOT VALID); rule 7's set-once function money_set_once() and its trigger on the three tables rule 7 lists here;
-- the version trigger (enforce_version_raise() from 0002, T-181) on the three versioned tables; grants to the two roles
-- 0012 made (never created or altered here); row-level security switched on for all five, with rule 5's policies.
-- Nothing is dropped, renamed or retyped, no row is written or removed, and no other part's table is altered. One
-- grant reaches outside the part: rosie_app's SELECT of effects.id and effects.business_id alone, which rule 5's
-- effect checks read (DL-298; the grants below).
--
-- Part 1 takes the tables this card names (payments, refunds, the ledger) with what rule 1's order and the card's two
-- seeds need first: payment_items (each seed's item against its line) and saved_cards (payments_saved_card_fk, and
-- seed-payment-deposit's saved card). Part 2 (T-723) takes memberships, plan_charges, booking_fees, rosfield_fees,
-- packs and credits, and the tables neither card names (pay_links, reconciliation_runs, reconciliation_findings). Three
-- keys of part 1's tables name part 2's tables, so part 2 adds them with ALTER TABLE ... ADD CONSTRAINT once those exist
-- (DL-278's way): saved_cards_membership_fk (membership_id, business_id) -> memberships (id, business_id),
-- payments_booking_fee_fk (booking_fee_id, business_id) -> booking_fees (id, business_id) and payments_plan_charge_fk
-- (plan_charge_id, business_id) -> plan_charges (id, business_id). No code writes these rows yet, so no row names them.
--
-- Not here: the payments service (C-101) and the K-05 calls that read and write these rows, the rules README rule 10
-- leaves to code, and the migration-side contract test (QA's tests/contract/db-schema.money.v1.test.ts, T-109).
--
-- The five live beside K-04's tables and the other parts' (rule 1), and their foreign keys name them by key with no
-- schema prefix (businesses.id, persons.id, bookings.id, effects.id, booking_lines.id, open_questions.id), all on delete
-- restrict. Inside the part, composite keys hold every row to its own business ((x_id, business_id) to (id,
-- business_id)). K-04's, K-07's and K-30's rows are keyed by id alone, so a row's business is held to theirs by rule
-- 5's policies below, not by a key. MATCH SIMPLE: a row with no booking, line, effect, card, question or person leaves
-- that key unchecked. Ids are text, opaque strings code makes and never parses (rule 3; CQ-09). No extension beyond
-- K-04's (rule 2).
--
-- Money and times (rule 9): every amount is integer minor units in bigint with its three-letter currency, never a
-- decimal (CQ-09); a ledger line's amount is positive and its kind says which way the money moved. Nothing is ever held
-- on a card: no state, purpose or column holds a hold or a later capture (RULES 3.2; D65; refuse-hold-payment). Every
-- instant is timestamptz in UTC.
--
-- Versions (rule 4): saved_cards, payments and refunds carry a version that every update raises by exactly one (K-04
-- rule 2; the trigger refuses any other update, 23514). payment_items and ledger_lines are only inserted and carry none.
--
-- Set once (rule 7): money_set_once(), word for word from the README, refuses any change to a listed column once it is
-- not null (23514, the trigger's name as the constraint): a payment once paid, failed or cancelled, a refund once failed
-- and a saved card's Stripe ids never change. It reads no table, so it is plain plpgsql (security invoker) with no
-- search_path of its own, as 0002's enforce_version_raise() and 0028's booking_details_set_once().
--
-- What may be written (rule 6), by privilege: no DELETE and no TRUNCATE on any of the five (42501; rule 9 keeps money
-- records 7 years), and neither application role owns a table or money_set_once(). ledger_lines: the Tool API may only
-- SELECT; the runtime side inserts and never updates (refuse-ledger-update, 42501). payment_items: insert only.
-- UPDATE of named columns only: saved_cards (stripe_customer_id, stripe_payment_method_id, saved_at, replaced_at,
-- removed_at, removed_why, version), payments (state, paid_at, failed_at, failed_why, cancelled_at, version) and refunds
-- (state, refunded_at, failed_at, marked_done_by_person_id, version). So no amount, payer, purpose, method, effect, fee
-- or plan charge a payment names, reason or decider is ever changed in place.
--
-- Row-level security (arch 10 line 546; K-04 v1 rule 4; README rule 5): all five are scoped by business, on business_id
-- (never null here). Each has 0012's <table>_runtime for rosie_job: every row with no scope (effect results, provider
-- events, reconciliation), else only its scope's. The Tool API (rosie_app) has one policy per command its grants allow:
-- <table>_tool_api_select reads only rows whose business_id equals its scope, and none with no scope;
-- <table>_tool_api_insert, and <table>_tool_api_update where an update is granted, hold the same scope in WITH CHECK
-- (and the update's USING), and also require in WITH CHECK only, for each of booking_id, booking_line_id, effect_id,
-- save_effect_id and open_question_id the row carries, rule 5's clause (<col> is null or exists (select 1 from <table> r
-- where r.id = <row>.<col> and r.business_id = <row>.business_id)), and on payments (payments.method in ('cash',
-- 'own_way') or payments.state <> 'paid'): a Tool API write never makes a card or bank-transfer payment paid (42501).
-- None of these checks is in USING, so the Tool API still reads a paid payment and locks it with SELECT ... FOR UPDATE.
-- ledger_lines has only the select policy for the Tool API. No policy is for delete alone; each <table>_runtime is for
-- every command, but no grant allows a delete. None is forced: the tables' owner (the migrations' role) is not bound.

-- A card saved on the business's own Stripe for a booking or a plan: only Stripe's opaque ids, each set once as Stripe
-- names it (A5-07; S13-55; K-14 v1 saveCard, cardSaved, cardReplaced, removeCard). Rule 1 makes it before payments'
-- key to it; its own key to payments follows payments, and its key to memberships is part 2's.
create table saved_cards (
  id text primary key,
  business_id text not null,
  person_id text not null,
  booking_id text,
  membership_id text,
  stripe_customer_id text,
  stripe_payment_method_id text,
  save_effect_id text,
  saved_from_payment_id text,
  asked_at timestamptz not null default now(),
  saved_at timestamptz,
  replaced_at timestamptz,
  removed_at timestamptz,
  removed_why text,
  version integer not null default 1,
  constraint saved_cards_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint saved_cards_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint saved_cards_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint saved_cards_save_effect_fk foreign key (save_effect_id) references effects (id) on delete restrict,
  constraint saved_cards_id_business_key unique (id, business_id),
  constraint saved_cards_save_effect_key unique (save_effect_id),
  constraint saved_cards_from_payment_key unique (saved_from_payment_id),
  constraint saved_cards_no_card_number check (
    (stripe_customer_id is null or regexp_replace(stripe_customer_id, '[ -]', '', 'g') !~ '[0-9]{13,}')
      and (
        stripe_payment_method_id is null
          or regexp_replace(stripe_payment_method_id, '[ -]', '', 'g') !~ '[0-9]{13,}'
      )
  ),
  constraint saved_cards_ids_present check (
    (stripe_customer_id is null or length(stripe_customer_id) > 0)
      and (stripe_payment_method_id is null or length(stripe_payment_method_id) > 0)
  ),
  constraint saved_cards_for_one check ((booking_id is null) <> (membership_id is null)),
  constraint saved_cards_one_source check ((save_effect_id is null) <> (saved_from_payment_id is null)),
  constraint saved_cards_saved_with_method check (
    (saved_at is null) = (stripe_payment_method_id is null) and (saved_at is null or stripe_customer_id is not null)
  ),
  constraint saved_cards_removed_why check (
    (removed_at is null) = (removed_why is null)
      and (removed_why is null or removed_why in ('nothing_needs_it', 'not_booked'))
  ),
  constraint saved_cards_times check (
    (saved_at is null or saved_at >= asked_at)
      and (replaced_at is null or (saved_at is not null and replaced_at >= saved_at))
      and (removed_at is null or removed_at >= asked_at)
  )
);

-- The card saved for a booking, which a charge at the owner's OK, at DONE or for a fee names (A6-03, A9-12, S11-26).
create index saved_cards_booking_idx on saved_cards (booking_id) where booking_id is not null and removed_at is null;
-- The card a plan's charge names (A7-54).
create index saved_cards_membership_idx on saved_cards (membership_id)
  where membership_id is not null and removed_at is null;
-- K-14's cardDetails and cardReplaced events name a saved card by its payment-method id (A9-14).
create index saved_cards_payment_method_idx on saved_cards (stripe_payment_method_id)
  where stripe_payment_method_id is not null;

create trigger saved_cards_version_raised
  before update on saved_cards
  for each row execute function enforce_version_raise();

-- Money asked of a payer and taken into the business's own Stripe, or recorded as paid outside it (FS line 731): one
-- K-07 effect per Stripe payment (payments_effect_key: its idempotency key is the effect's one key), never a hold.
create table payments (
  id text primary key,
  business_id text not null,
  payer_person_id text not null,
  booking_id text,
  purpose text not null,
  method text not null,
  amount_cents bigint not null,
  currency text not null,
  state text not null default 'pending',
  effect_id text,
  saved_card_id text,
  booking_fee_id text,
  plan_charge_id text,
  recorded_by_person_id text,
  asked_at timestamptz not null default now(),
  paid_at timestamptz,
  failed_at timestamptz,
  failed_why text,
  cancelled_at timestamptz,
  version integer not null default 1,
  constraint payments_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint payments_payer_fk foreign key (payer_person_id) references persons (id) on delete restrict,
  constraint payments_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint payments_effect_fk foreign key (effect_id) references effects (id) on delete restrict,
  constraint payments_saved_card_fk foreign key (saved_card_id, business_id) references saved_cards (id, business_id)
    on delete restrict,
  constraint payments_recorded_by_fk foreign key (recorded_by_person_id) references persons (id) on delete restrict,
  constraint payments_id_business_key unique (id, business_id),
  constraint payments_effect_key unique (effect_id),
  constraint payments_purpose_known check (
    purpose in ('deposit', 'full_price', 'rest', 'extra', 'fee', 'tip', 'pack', 'plan_charge')
  ),
  constraint payments_method_known check (method in ('card', 'bank_transfer', 'cash', 'own_way')),
  constraint payments_state_known check (state in ('pending', 'paid', 'failed', 'cancelled')),
  constraint payments_state_times check (
    (state <> 'pending' or (paid_at is null and failed_at is null and cancelled_at is null))
      and (state <> 'paid' or (paid_at is not null and failed_at is null and cancelled_at is null))
      and (state <> 'failed' or (failed_at is not null and paid_at is null and cancelled_at is null))
      and (state <> 'cancelled' or (cancelled_at is not null and paid_at is null and failed_at is null))
  ),
  constraint payments_money check (amount_cents > 0 and currency ~ '^[A-Z]{3}$'),
  constraint payments_stripe_runs_from_effect check ((method in ('card', 'bank_transfer')) = (effect_id is not null)),
  constraint payments_recorded_outside check (
    (method in ('cash', 'own_way')) = (recorded_by_person_id is not null)
      and (method not in ('cash', 'own_way') or state = 'paid')
  ),
  constraint payments_purpose_fits_booking check (
    (purpose = 'pack' and booking_id is null)
      or purpose = 'plan_charge'
      or (purpose not in ('pack', 'plan_charge') and booking_id is not null)
  ),
  constraint payments_fee_names_fee check ((purpose = 'fee') = (booking_fee_id is not null)),
  constraint payments_plan_charge_names_charge check ((purpose = 'plan_charge') = (plan_charge_id is not null)),
  constraint payments_saved_card_is_card check (saved_card_id is null or method = 'card'),
  constraint payments_failed_why check (
    (failed_at is null) = (failed_why is null) and (failed_why is null or failed_why in ('declined', 'bounced'))
  ),
  constraint payments_times_in_order check (
    (paid_at is null or paid_at >= asked_at)
      and (failed_at is null or failed_at >= asked_at)
      and (cancelled_at is null or cancelled_at >= asked_at)
  )
);

-- One fee is paid once, and one plan charge (S11-26; A7-54; S12-26): one pending or paid payment each (23505).
create unique index payments_one_live_per_fee on payments (booking_fee_id) where state in ('pending', 'paid');
create unique index payments_one_live_per_plan_charge on payments (plan_charge_id) where state in ('pending', 'paid');
-- A booking's payments: what it took (pay.took), what is left (pay.left), what goes back (pay.back).
create index payments_booking_idx on payments (booking_id) where booking_id is not null;
-- Payments still waiting: a pay link before its deadline, a bank transfer not yet cleared (K-14 needsAuthentication).
create index payments_pending_idx on payments (asked_at) where state = 'pending';

create trigger payments_version_raised
  before update on payments
  for each row execute function enforce_version_raise();

-- saved_cards' key to the payment whose paid pay link saved it (A6-32), now that payments exists (rule 1).
alter table saved_cards
  add constraint saved_cards_from_payment_fk foreign key (saved_from_payment_id, business_id)
    references payments (id, business_id) on delete restrict;

-- What one payment pays toward each booking line (RULES 3.2): written with its payment and never changed.
create table payment_items (
  id text primary key,
  payment_id text not null,
  business_id text not null,
  booking_line_id text,
  share text not null,
  amount_cents bigint not null,
  currency text not null,
  constraint payment_items_payment_fk foreign key (payment_id, business_id) references payments (id, business_id)
    on delete restrict,
  constraint payment_items_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint payment_items_line_fk foreign key (booking_line_id) references booking_lines (id) on delete restrict,
  constraint payment_items_line_share_key unique (payment_id, booking_line_id, share),
  constraint payment_items_share_known check (
    share in ('deposit', 'full', 'rest', 'extra') and (share = 'extra' or booking_line_id is not null)
  ),
  constraint payment_items_money check (amount_cents > 0 and currency ~ '^[A-Z]{3}$')
);

-- What a line has been paid: money paid ahead a cheaper service lowers (A7-31), a cancel in time gives back (S13-55).
create index payment_items_line_idx on payment_items (booking_line_id) where booking_line_id is not null;

-- The ledger (arch 09 lines 457, 492; arch 10 line 550): one line per Stripe charge and refund with its K-07 effect id
-- and Stripe's own id, never edited: a refund is a new line. Its key to refunds follows refunds (rule 1).
create table ledger_lines (
  id text primary key,
  business_id text not null,
  booking_id text,
  kind text not null,
  amount_cents bigint not null,
  currency text not null,
  payment_id text,
  refund_id text,
  effect_id text not null,
  stripe_object_id text not null,
  moved_at timestamptz not null,
  written_by text not null,
  written_at timestamptz not null default now(),
  constraint ledger_lines_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint ledger_lines_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint ledger_lines_payment_fk foreign key (payment_id, business_id) references payments (id, business_id)
    on delete restrict,
  constraint ledger_lines_effect_fk foreign key (effect_id) references effects (id) on delete restrict,
  constraint ledger_lines_id_business_key unique (id, business_id),
  constraint ledger_lines_stripe_object_key unique (stripe_object_id, kind),
  constraint ledger_lines_kind_known check (kind in ('charge', 'refund', 'refund_failed')),
  constraint ledger_lines_money check (amount_cents > 0 and currency ~ '^[A-Z]{3}$'),
  constraint ledger_lines_kind_names check (
    (kind = 'charge' and refund_id is null)
      or (kind in ('refund', 'refund_failed') and refund_id is not null and payment_id is null)
  ),
  constraint ledger_lines_charge_has_payment check (
    kind <> 'charge' or payment_id is not null or written_by = 'reconciliation'
  ),
  constraint ledger_lines_written_by_known check (written_by in ('effect_result', 'provider_event', 'reconciliation')),
  constraint ledger_lines_stripe_id check (
    length(stripe_object_id) > 0 and regexp_replace(stripe_object_id, '[ -]', '', 'g') !~ '[0-9]{13,}'
  )
);

-- One charge line per payment, and one line per refund and kind: a retried result writes nothing twice (23505).
create unique index ledger_lines_payment_charge_key on ledger_lines (payment_id)
  where kind = 'charge' and payment_id is not null;
create unique index ledger_lines_refund_key on ledger_lines (refund_id, kind) where refund_id is not null;
-- Reconciliation matches each listed Stripe charge and refund by its effect id (arch 10 line 550).
create index ledger_lines_effect_idx on ledger_lines (effect_id);
-- A business's lines over the last 48 hours (arch 10 line 550; A6-32), and the Money page (S11-63).
create index ledger_lines_window_idx on ledger_lines (business_id, moved_at);
-- A booking's money moved, for the record (S13-57).
create index ledger_lines_booking_idx on ledger_lines (booking_id) where booking_id is not null;

-- Money given back to the person who paid (FS line 732; RULES 3.10): one K-07 stripe_refund effect per refund through
-- Stripe, naming the charge line it refunds; the amount, what it refunds and who decided are written once.
create table refunds (
  id text primary key,
  business_id text not null,
  booking_id text,
  booking_line_id text,
  payment_id text,
  charge_line_id text,
  to_person_id text not null,
  via text not null,
  reason text not null,
  decided_by text not null,
  amount_cents bigint not null,
  currency text not null,
  effect_id text,
  answered_by_person_id text,
  answered_by_role text,
  open_question_id text,
  option_id text,
  event_id text,
  answered_at timestamptz,
  marked_done_by_person_id text,
  state text not null default 'pending',
  asked_at timestamptz not null default now(),
  refunded_at timestamptz,
  failed_at timestamptz,
  version integer not null default 1,
  constraint refunds_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint refunds_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint refunds_line_fk foreign key (booking_line_id) references booking_lines (id) on delete restrict,
  constraint refunds_payment_fk foreign key (payment_id, business_id) references payments (id, business_id)
    on delete restrict,
  constraint refunds_charge_line_fk foreign key (charge_line_id, business_id)
    references ledger_lines (id, business_id) on delete restrict,
  constraint refunds_to_person_fk foreign key (to_person_id) references persons (id) on delete restrict,
  constraint refunds_effect_fk foreign key (effect_id) references effects (id) on delete restrict,
  constraint refunds_answered_by_fk foreign key (answered_by_person_id) references persons (id) on delete restrict,
  constraint refunds_question_fk foreign key (open_question_id) references open_questions (id) on delete restrict,
  constraint refunds_marked_done_by_fk foreign key (marked_done_by_person_id) references persons (id)
    on delete restrict,
  constraint refunds_id_business_key unique (id, business_id),
  constraint refunds_effect_key unique (effect_id),
  constraint refunds_via_known check (via in ('stripe', 'own_way')),
  constraint refunds_reason_known check (
    reason in (
      'cancel_in_time', 'called_off', 'work_stopped', 'fee_rest', 'price_lowered', 'right_to_cancel', 'owner_full',
      'owner_part', 'double_charge', 'second_payment', 'unbound_charge', 'late_money'
    )
  ),
  constraint refunds_decided_by_known check (decided_by in ('terms', 'owner', 'at_once')),
  constraint refunds_reason_fits_decider check (
    (reason in ('owner_full', 'owner_part')) = (decided_by = 'owner')
      and (reason in ('double_charge', 'second_payment', 'unbound_charge', 'late_money')) = (decided_by = 'at_once')
  ),
  constraint refunds_owner_yes check (
    (decided_by = 'owner') = (answered_by_person_id is not null)
      and (answered_by_person_id is null) = (answered_by_role is null)
      and (answered_by_person_id is null) = (open_question_id is null)
      and (answered_by_person_id is null) = (event_id is null)
      and (answered_by_person_id is null) = (answered_at is null)
      and (option_id is null or answered_by_person_id is not null)
      and (answered_by_role is null or answered_by_role in ('owner', 'admin'))
  ),
  constraint refunds_runs_by_way check (
    (via = 'stripe') = (effect_id is not null)
      and (via = 'stripe') = (charge_line_id is not null)
      and (marked_done_by_person_id is not null) = (via = 'own_way' and state = 'succeeded')
      and (via = 'stripe' or (state <> 'failed' and payment_id is not null))
  ),
  constraint refunds_double_charge_unasked check (
    (reason = 'double_charge') = (payment_id is null) and (reason <> 'double_charge' or booking_id is null)
  ),
  constraint refunds_money check (amount_cents > 0 and currency ~ '^[A-Z]{3}$'),
  constraint refunds_state_known check (state in ('pending', 'succeeded', 'failed')),
  constraint refunds_state_times check (
    (state <> 'pending' or (refunded_at is null and failed_at is null))
      and (state <> 'succeeded' or (refunded_at is not null and failed_at is null))
      and (state <> 'failed' or failed_at is not null)
  ),
  constraint refunds_times_in_order check (
    (answered_at is null or answered_at <= asked_at)
      and (refunded_at is null or refunded_at >= asked_at)
      and (failed_at is null or failed_at >= asked_at)
  )
);

-- A refund at once gives back the whole payment, so a payment has one that has not failed (RULES 3.10; S12-26; 23505).
create unique index refunds_one_at_once_per_payment on refunds (payment_id)
  where decided_by = 'at_once' and state <> 'failed';
-- What has gone back of a payment, so a refund is never more than what is left (A10-12).
create index refunds_payment_idx on refunds (payment_id) where payment_id is not null;
-- A booking's refunds, for the Refunds page (FS 6.2) and the record (S13-57).
create index refunds_booking_idx on refunds (booking_id) where booking_id is not null;
-- Refunds not yet back: an own-way refund not yet marked done, a Stripe refund still pending.
create index refunds_pending_idx on refunds (asked_at) where state = 'pending';

create trigger refunds_version_raised
  before update on refunds
  for each row execute function enforce_version_raise();

-- ledger_lines' key to the refund a refund or refund_failed line names, now that refunds exists (rule 1).
alter table ledger_lines
  add constraint ledger_lines_refund_fk foreign key (refund_id, business_id)
    references refunds (id, business_id) on delete restrict;

-- Rule 7's set-once function, word for word from the README: any change to a listed column once it is not null is
-- refused (a listed array may only gain items), with SQLSTATE 23514 and the trigger's name as the constraint.
create function money_set_once() returns trigger language plpgsql as $$
declare
  col text;
begin
  foreach col in array tg_argv loop
    if (to_jsonb(old) ->> col) is not null
      and (
        case
          when jsonb_typeof(to_jsonb(old) -> col) = 'array'
            then not coalesce((to_jsonb(new) -> col) @> (to_jsonb(old) -> col), false)
          else (to_jsonb(new) ->> col) is distinct from (to_jsonb(old) ->> col)
        end
      )
    then
      raise exception 'a money value is set once and never changed'
        using errcode = 'check_violation', constraint = tg_name;
    end if;
  end loop;
  return new;
end
$$;

-- Rule 7's lists for part 1's tables, in the README's order (part 2 attaches the same function to its own six).
create trigger saved_cards_set_once
  before update on saved_cards
  for each row execute function money_set_once(
    'stripe_customer_id', 'stripe_payment_method_id', 'saved_at', 'replaced_at', 'removed_at', 'removed_why'
  );
create trigger payments_set_once
  before update on payments
  for each row execute function money_set_once('paid_at', 'failed_at', 'failed_why', 'cancelled_at');
create trigger refunds_set_once
  before update on refunds
  for each row execute function money_set_once('refunded_at', 'failed_at', 'marked_done_by_person_id');

-- Grants (rule 6): no DELETE or TRUNCATE anywhere, nothing to PUBLIC, and neither role owns a table or the function.
grant select, insert on saved_cards, payments, payment_items, refunds to rosie_app, rosie_job;
grant update (
    stripe_customer_id, stripe_payment_method_id, saved_at, replaced_at, removed_at, removed_why, version
  )
  on saved_cards to rosie_app, rosie_job;
grant update (state, paid_at, failed_at, failed_why, cancelled_at, version) on payments to rosie_app, rosie_job;
grant update (state, refunded_at, failed_at, marked_done_by_person_id, version) on refunds to rosie_app, rosie_job;
grant select on ledger_lines to rosie_app;
grant select, insert on ledger_lines to rosie_job;

-- K-32 rule 5's effect_id and save_effect_id checks read effects as the Tool API, and PostgreSQL checks the caller's
-- SELECT on every table a policy names when the statement starts, even when the column is null. 0018 (T-1094, DL-149)
-- revoked every grant rosie_app held on effects, its SELECT "unless a named reader needs it": rule 5's two checks are
-- that named reader, and they read effects.id and effects.business_id only (DL-298). So rosie_app may SELECT those two
-- columns and no other, still only its scope's rows (0015's effects_tool_api); no INSERT, UPDATE, DELETE or TRUNCATE,
-- and provider_events keeps no grant. Without it every Tool API write on saved_cards, payments and refunds is refused
-- (42501), cash recorded paid included.
grant select (id, business_id) on effects to rosie_app;

-- Row-level security on the five business-scoped tables (rule 5): rosie_app sees only its scope, and writes a row only
-- in its scope's business, naming only its business's bookings, lines, effects and questions, never a card or bank
-- payment paid; rosie_job sees everything with no scope, else only its scope.
alter table saved_cards enable row level security;
create policy saved_cards_tool_api_select on saved_cards for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy saved_cards_tool_api_insert on saved_cards for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and (
      booking_id is null
      or exists (
        select 1 from bookings r where r.id = saved_cards.booking_id and r.business_id = saved_cards.business_id
      )
    )
    and (
      save_effect_id is null
      or exists (
        select 1 from effects r
        where r.id = saved_cards.save_effect_id and r.business_id = saved_cards.business_id
      )
    )
  );
create policy saved_cards_tool_api_update on saved_cards for update to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and (
      booking_id is null
      or exists (
        select 1 from bookings r where r.id = saved_cards.booking_id and r.business_id = saved_cards.business_id
      )
    )
    and (
      save_effect_id is null
      or exists (
        select 1 from effects r
        where r.id = saved_cards.save_effect_id and r.business_id = saved_cards.business_id
      )
    )
  );
create policy saved_cards_runtime on saved_cards for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table payments enable row level security;
create policy payments_tool_api_select on payments for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy payments_tool_api_insert on payments for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and (
      booking_id is null
      or exists (select 1 from bookings r where r.id = payments.booking_id and r.business_id = payments.business_id)
    )
    and (
      effect_id is null
      or exists (select 1 from effects r where r.id = payments.effect_id and r.business_id = payments.business_id)
    )
    and (payments.method in ('cash', 'own_way') or payments.state <> 'paid')
  );
create policy payments_tool_api_update on payments for update to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and (
      booking_id is null
      or exists (select 1 from bookings r where r.id = payments.booking_id and r.business_id = payments.business_id)
    )
    and (
      effect_id is null
      or exists (select 1 from effects r where r.id = payments.effect_id and r.business_id = payments.business_id)
    )
    and (payments.method in ('cash', 'own_way') or payments.state <> 'paid')
  );
create policy payments_runtime on payments for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table payment_items enable row level security;
create policy payment_items_tool_api_select on payment_items for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy payment_items_tool_api_insert on payment_items for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and (
      booking_line_id is null
      or exists (
        select 1 from booking_lines r
        where r.id = payment_items.booking_line_id and r.business_id = payment_items.business_id
      )
    )
  );
create policy payment_items_runtime on payment_items for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table ledger_lines enable row level security;
create policy ledger_lines_tool_api_select on ledger_lines for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy ledger_lines_runtime on ledger_lines for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table refunds enable row level security;
create policy refunds_tool_api_select on refunds for select to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy refunds_tool_api_insert on refunds for insert to rosie_app
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and (
      booking_id is null
      or exists (select 1 from bookings r where r.id = refunds.booking_id and r.business_id = refunds.business_id)
    )
    and (
      booking_line_id is null
      or exists (
        select 1 from booking_lines r where r.id = refunds.booking_line_id and r.business_id = refunds.business_id
      )
    )
    and (
      effect_id is null
      or exists (select 1 from effects r where r.id = refunds.effect_id and r.business_id = refunds.business_id)
    )
    and (
      open_question_id is null
      or exists (
        select 1 from open_questions r
        where r.id = refunds.open_question_id and r.business_id = refunds.business_id
      )
    )
  );
create policy refunds_tool_api_update on refunds for update to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (
    business_id = nullif(current_setting('rosie.business_id', true), '')
    and (
      booking_id is null
      or exists (select 1 from bookings r where r.id = refunds.booking_id and r.business_id = refunds.business_id)
    )
    and (
      booking_line_id is null
      or exists (
        select 1 from booking_lines r where r.id = refunds.booking_line_id and r.business_id = refunds.business_id
      )
    )
    and (
      effect_id is null
      or exists (select 1 from effects r where r.id = refunds.effect_id and r.business_id = refunds.business_id)
    )
    and (
      open_question_id is null
      or exists (
        select 1 from open_questions r
        where r.id = refunds.open_question_id and r.business_id = refunds.business_id
      )
    )
  );
create policy refunds_runtime on refunds for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );
