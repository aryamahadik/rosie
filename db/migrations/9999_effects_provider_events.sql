-- T-194: K-07 v1's schema addition (frozen: contracts/outbox-effects/outbox-effects.v1.tables.json), migrated with K-05
-- v1.1 (K-07 README "The schema addition"; K-05 README v1.1): effect rows, provider events and the claim on a sending
-- outbox row (arch 10 lines 508, 542, 550; arch 02 line 109; CQ-04).
-- Expand only: three new tables with their indexes; each table's version trigger (enforce_version_raise() from 0002,
-- T-181); grants to the two roles 0012 made (never created or altered here); row-level security switched on with two
-- policies on each of the two business-scoped tables, as 0012. Nothing is dropped, renamed or retyped, and no row is
-- written or removed. Not here: the K-05 v1.1 calls that write these tables (T-199).
--
-- The three tables live beside K-04's tables, and their foreign keys name core tables by K-04's keys (turns.id,
-- businesses.id, bookings.id, persons.id, handles.id, outbox_rows.id), all on delete restrict. Ids are text: opaque
-- strings code makes and never parses (CQ-09). effects.visit_id and effects.ledger_line_id have no foreign key yet:
-- K-30 names the visit row and K-28 the ledger.
--
-- effects: one row per Stripe, calendar or Linq contact call a commit causes (or a job with no turn: a clock firing,
-- or the daily reconciliation's refund), so a crash or a retry never doubles or loses it (arch 10 line 508). One
-- idempotency key over all its tries (effects_idempotency_key_key; arch 10 line 542). Money in integer cents with a
-- three-letter currency (CQ-09).
--
-- provider_events: Stripe and calendar events, stored once by (provider, provider_event_id), the primary key, after the
-- gateway verifies them (arch 02 line 109: "Known event id: 200, dropped"). K-05 v1.1's recordProviderEvent inserts with
-- `on conflict (provider, provider_event_id) do nothing`, on the runtime side and unscoped (K-05 README item 23).
--
-- outbox_claims: the claim on an outbox row in state sending, and when it lapses (K-07 README "How a claim lapses").
--
-- Every table here is updated (a claim, a try's result, a renewal, handling an event), so each carries a version that
-- every update raises by exactly one (K-04 rule 2; the trigger refuses any other update, 23514).
--
-- Rules beyond the table list, kept by code (K-07 README "The schema addition"): an effect's port_request and a provider
-- event's payload never hold a key or a card number (BP rule 7; arch 02 line 109); a calendar_update or calendar_delete
-- finds the visit's event by effects_calendar_event_idx; the state moves are K-07's (lifeChain) and K-05 v1.1's calls'.
--
-- Row-level security (arch 10 line 546; K-04 rule 4), as 0012, by each table's rowLevelSecurity.scope:
--   effects and provider_events (scope business, on business_id): <table>_tool_api lets rosie_app see and write only
--     rows whose business_id equals its scope (the setting rosie.business_id), and none with no scope;
--     <table>_runtime lets rosie_job see every row with no scope, else only its scope's. A row whose business_id is
--     null (a Linq contact effect, which belongs to Rosie's one number; a provider event no business is known for) is
--     seen only by rosie_job with no scope. The commit writes effects under its per-write scope (K-05 v1 "Scope").
--   outbox_claims (scope none: the dispatcher alone writes and reads it, as K-04's outbox_parts): row-level security
--     stays off; rosie_job only, rosie_app holds no grant.
--
-- Grants, as 0012's for a versioned table: SELECT, INSERT and UPDATE; to both roles on the business-scoped tables
-- (behind their policies), to rosie_job only on outbox_claims. DELETE only on outbox_claims, to rosie_job: a row's move
-- to waiting_chat deletes its claim (outbox-effects.v1.tables.json line 517; K-05 v1.1 item 16, markRow waitingChat).
-- No DELETE on effects or provider_events, and no TRUNCATE, REFERENCES or TRIGGER on any table; nothing to PUBLIC.
-- Neither role owns a table.

-- One effect row per Stripe, calendar or Linq contact call (arch 10 lines 508, 542, 550; CQ-04).
create table effects (
  id text primary key,
  turn_id text,
  job_id text,
  business_id text,
  booking_id text,
  kind text not null,
  port text not null,
  calendar_provider text,
  visit_id text,
  person_id text,
  handle_id text,
  amount_cents bigint,
  currency text,
  port_request jsonb not null,
  idempotency_key text not null,
  state text not null default 'pending',
  tries integer not null default 0,
  runs integer not null default 1,
  first_try_at timestamptz,
  last_try_at timestamptz,
  claimed_by text,
  claim_lapses_at timestamptz,
  provider_object_id text,
  error_code text,
  ledger_line_id text,
  trace_id text not null,
  created_at timestamptz not null default now(),
  version integer not null default 1,
  constraint effects_turn_fk foreign key (turn_id) references turns (id) on delete restrict,
  constraint effects_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint effects_booking_fk foreign key (booking_id) references bookings (id) on delete restrict,
  constraint effects_person_fk foreign key (person_id) references persons (id) on delete restrict,
  constraint effects_handle_fk foreign key (handle_id) references handles (id) on delete restrict,
  constraint effects_idempotency_key_key unique (idempotency_key),
  constraint effects_turn_or_job check ((turn_id is null) <> (job_id is null)),
  constraint effects_kind_known check (
    kind in ('stripe_save_card', 'stripe_charge', 'stripe_refund', 'stripe_pay_link', 'stripe_dispute_evidence',
      'rosfield_monthly_charge', 'calendar_write', 'calendar_update', 'calendar_delete', 'linq_contact_add')
  ),
  constraint effects_port_matches_kind check (
    (port = 'stripe' and (kind like 'stripe\_%' or kind = 'rosfield_monthly_charge'))
      or (port = 'calendar' and kind like 'calendar\_%') or (port = 'linq' and kind = 'linq_contact_add')
  ),
  constraint effects_state_known check (
    state in ('pending', 'running', 'succeeded', 'declined', 'outage', 'cancelled')
  ),
  constraint effects_calendar_keyed check (
    (port <> 'calendar' or (calendar_provider in ('google', 'microsoft') and booking_id is not null
      and visit_id is not null and person_id is not null))
      and (port = 'calendar' or (calendar_provider is null and visit_id is null))
  ),
  constraint effects_contact_has_handle check ((kind = 'linq_contact_add') = (handle_id is not null)),
  constraint effects_money_kinds_have_amount check (
    (kind not in ('stripe_charge', 'stripe_refund', 'stripe_pay_link', 'rosfield_monthly_charge')
      or amount_cents is not null) and (amount_cents is null) = (currency is null)
      and (currency is null or currency ~ '^[A-Z]{3}$')
  ),
  constraint effects_tries_within_five check (tries between 0 and 5 and runs >= 1),
  constraint effects_port_request_object check (jsonb_typeof(port_request) = 'object'),
  constraint effects_running_is_claimed check (
    (state = 'running') = (claimed_by is not null and claim_lapses_at is not null)
  )
);

-- The effects runner claims pending rows, and running rows whose claim lapsed, oldest first (K-05 v1.1 claimEffects).
create index effects_claimable_idx on effects (created_at) where state in ('pending', 'running');
-- When a service is back, its waiting effects run once, oldest first (arch 11 line 582; K-05 v1.1 serviceBack).
create index effects_outage_idx on effects (port, created_at) where state = 'outage';
-- A move or call-off finds the visit's event for that person (arch 05 line 267).
create index effects_calendar_event_idx on effects (booking_id, visit_id, person_id) where port = 'calendar';
-- A turn's effects, for replay and the console (arch 10 line 508).
create index effects_turn_idx on effects (turn_id);
-- Daily reconciliation over the last 48 hours (arch 10 line 550).
create index effects_reconcile_idx on effects (created_at) where port = 'stripe';

create trigger effects_version_raised
  before update on effects
  for each row execute function enforce_version_raise();

-- Stripe and calendar events, stored once by their event id and linked to their effect rows (arch 02 line 109; arch
-- 11 lines 578 to 582).
create table provider_events (
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  business_id text,
  effect_id text,
  payload jsonb not null,
  trace_id text not null,
  handled_at timestamptz,
  version integer not null default 1,
  primary key (provider, provider_event_id),
  constraint provider_events_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint provider_events_effect_fk foreign key (effect_id) references effects (id) on delete restrict,
  constraint provider_events_provider_known check (provider in ('stripe', 'google_calendar', 'microsoft_calendar')),
  constraint provider_events_payload_object check (jsonb_typeof(payload) = 'object')
);

-- An effect's events, for its result and reconciliation (arch 10 line 550).
create index provider_events_effect_idx on provider_events (effect_id);
-- Events not yet acted on, oldest first.
create index provider_events_unhandled_idx on provider_events (received_at) where handled_at is null;

create trigger provider_events_version_raised
  before update on provider_events
  for each row execute function enforce_version_raise();

-- The claim on an outbox row in state sending: who holds it and when it lapses, so a dispatcher that died never strands
-- its recipient's later rows (K-05 v1 open gap 1; arch 11 line 576). One row per outbox row.
create table outbox_claims (
  outbox_row_id text primary key,
  claimer text not null,
  claimed_at timestamptz not null,
  lapses_at timestamptz not null,
  claim_no integer not null default 1,
  first_try_at timestamptz,
  next_try_not_before timestamptz,
  version integer not null default 1,
  constraint outbox_claims_row_fk foreign key (outbox_row_id) references outbox_rows (id) on delete restrict,
  constraint outbox_claims_lapse_after_claim check (lapses_at > claimed_at and claim_no >= 1)
);

-- The claim walk finds sending rows whose claim lapsed.
create index outbox_claims_lapses_idx on outbox_claims (lapses_at);

create trigger outbox_claims_version_raised
  before update on outbox_claims
  for each row execute function enforce_version_raise();

-- The business-scoped tables, versioned: both roles, behind the policies below.
grant select, insert, update on effects, provider_events to rosie_app, rosie_job;

-- The claim (scope none): the dispatcher on the runtime side only. A row's move to waiting_chat deletes its claim
-- (outbox-effects.v1.tables.json line 517; K-05 v1.1 item 16), so rosie_job may delete a claim; nothing else here does.
grant select, insert, update on outbox_claims to rosie_job;
grant delete on outbox_claims to rosie_job;

-- Row-level security: rosie_app sees only its scope; rosie_job sees everything with no scope, else only its scope.
alter table effects enable row level security;
create policy effects_tool_api on effects for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy effects_runtime on effects for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table provider_events enable row level security;
create policy provider_events_tool_api on provider_events for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy provider_events_runtime on provider_events for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );
