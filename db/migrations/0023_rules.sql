-- T-207: the rules part (K-26 v1, frozen: contracts/db-schema/rules, its table list and its README's rules 1 to 8):
-- the closed registries of plug-in facts, plug-in switches and rule kinds, the owner's own typed rules with a scope and
-- effective dates (a note in the owner's words among them), and the owner's price OK limits (arch 09 line 463: 5
-- tables; arch 09 lines 457, 478 to 484, 488; S1-21's booking_rules and price_oks; S11-57; C-157, C-162).
-- Expand only: five new tables with their indexes and two EXCLUDEs; the version trigger (enforce_version_raise() from
-- 0002, T-181) on the two versioned ones; grants to the two roles 0012 made (never created or altered here); row-level
-- security switched on with 0012's two policies on the two business-scoped tables; and the closed registries' seed.
-- Nothing is dropped, renamed or retyped, and no row is removed; no K-04 or K-23 table is altered. Not here: applying
-- the rules in the gate (the action layer's C-081) and limit 2's one rule evaluator (C-082, T-300); the checks README
-- "Which part owns what" leaves to code (a rule's kind_id is one of the business's kinds; set_by_person_id may change
-- settings, K-22; K-23's pf_facts, pf_switches_a and pf_switches_b name only registry entries, since an array carries
-- no foreign key; the most specific scope wins); the migration-side contract test (QA's
-- tests/contract/db-schema.rules.v1.test.ts, T-103).
--
-- The five tables live beside K-04's and K-23's tables (rule 1), and their foreign keys name K-04's tables by their keys
-- (businesses.id, persons.id), with no schema prefix, all on delete restrict. No foreign key names a K-23 or K-24 table:
-- kind_id is the profession file's id as K-23's company_kinds.kind_id holds it, checked for form only. Ids are text
-- (rule 4): rules.id and price_ok_limits.id are opaque strings code makes and never parses (CQ-09); rule_kinds.id,
-- trade_facts.name and plugin_switches.name are names. Money is whole cents in integer with a three-letter currency code,
-- both or neither (rule 7). value_dates holds days in the business's zone; instants are timestamptz (rule 8).
--
-- The closed registries (rules 3, 5 and 6; arch 09 line 480; C-157): trade_facts (the 28 live facts), plugin_switches
-- (the 5 live switches and nomoney) and rule_kinds (16 kinds, each with its one value type). A rule names a kind and
-- copies its type, held to the registry by rules_kind_fk on rule_kinds_id_type_key, so a kind not in it, or a value of
-- another type, is refused (23503); rules_value_matches_type sets exactly that type's columns (23514). A new kind of rule,
-- fact or switch is a registry row a migration's seed adds, never a column. The registries are written only by a
-- migration's seed: the inserts at the end of this file, which are seed-rule-registry.json's rows word for word.
--
-- One in effect (arch 09 line 488; README "Effective dates and scope"): rules_one_in_effect refuses two rows of one kind
-- in one scope (the business, the flow and the kind of work, none read as '') whose dates overlap (23P01), except a
-- dates or note kind, which may have several rows in effect at once (its where); price_ok_limits_one_in_effect refuses
-- two price OK limits in one scope. Both are gist with = on text, from btree_gist (0001, in public, which migrate.mjs
-- searches after this schema), beside && on tstzrange(effective_from, effective_to, '[)'). A null effective_to is an
-- open end. A change closes one row and opens the next at the same instant, so [from, to) meets [to, ...) without
-- overlapping. effective_to is always after effective_from: a CHECK is tested before the index, so a row closed at or
-- before its own start is refused by <table>_dates_in_order (23514), never by the range.
--
-- Versions (rule 3): rules and price_ok_limits are updated (to close a row), so each carries a version that every update
-- raises by exactly one (K-04 rule 2; the trigger refuses any other update, 23514), compared and set by a commit; each
-- has a one-column key (id) a commit can name in versions_read. Values are never edited in place and rows are never
-- deleted (README "Effective dates and scope"), which the commit keeps. The three registries are written once and carry
-- no version.
--
-- Row-level security (arch 10 line 546; K-04 v1 rule 4; README rule 5):
--   rules, price_ok_limits: scoped by business, on business_id (never null here), with 0012's two policies:
--     <table>_tool_api lets rosie_app see and write only rows whose business_id equals its scope (the setting
--     rosie.business_id), and none with no scope; <table>_runtime lets rosie_job see every row with no scope, else only
--     its scope's.
--   trade_facts, plugin_switches, rule_kinds: the same for every business (scope none), so row-level security stays
--     off, as on K-24's catalog; what keeps every application role from writing them is privilege (README rule 5:
--     refused 42501). None is forced: the tables' owner (the migrations' role, which writes the seed) is not bound.
--
-- Grants (DL-149: each to a named reader). No DELETE (no row here is removed by any named call), TRUNCATE, REFERENCES or
-- TRIGGER, and nothing to PUBLIC. Neither role owns a table.
--   trade_facts, plugin_switches, rule_kinds: SELECT only, to both roles (README rule 5: every role reads them, no
--     application role writes them).
--     rosie_job, the runtime side: limit 2's one rule evaluator reads each rule's kind and type (C-082, T-300; arch 06
--       line 301); the context bundle (C-114: the notes and rules the planner answers from); K-09 saveSetupStep in a
--       turn (S1-21's tap list: a kind is offered once the business's kinds list its needs_fact; S1-04 and S11-58
--       check K-23's fact and switch names at each write) and readTurnState (item 26).
--     rosie_app, the Tool API, under one business's scope: S1-21's call that writes booking_rules and price_oks and
--       S1-79's summary that reads them (C-074); registration screen 14's tap list (C-187) and the owner console's
--       Settings (C-192, S11-57), through K-21; search's owner-rule filter (C-097; arch 05 line 237); K-09
--       saveSetupStep made alone, checking K-23's names.
--   rules, price_ok_limits: SELECT, INSERT, UPDATE to both roles, behind the policies (a change closes one row by
--     effective_to and opens the next; history stays, arch 09 line 488); the Tool API's delete is refused (42501).
--     rosie_job: K-05 commitTurn per write (item 1), whose state writes admit every domain table, writes what journey
--       1's and journey 11's turns decide (S1-21 kept in a turn; S11-57's change for new bookings only, one row closed
--       and the next opened in one commit), and compares rows FOR SHARE or FOR UPDATE (which take UPDATE as well as
--       SELECT); limit 2's evaluator (C-082), the request decision (A4-98, B4-115), the price OK before a quote or bill
--       goes (A4-05, A4-09; C-099) and readTurnState (item 26) read them; K-30's terms snapshot copies them later.
--     rosie_app: S1-21's call (C-074) writes them and S1-79's summary reads them; Settings (C-192, S11-57) changes
--       them; search's owner-rule filter (C-097) reads them; and K-26's refused fixtures name the Tool API side
--       inserting a rule (23503, 23P01), each refused by its own rule, never by privilege.

-- The closed registry of plug-in facts (pf.facts; SPEC-master 5d): one row per known fact, the same for every business.
-- K-23's company_kinds.pf_facts names only these, which code checks at each write.
create table trade_facts (
  name text primary key,
  means text,
  source text not null,
  constraint trade_facts_name_form check (name ~ '^[a-z0-9]+$')
);

-- The closed registry of plug-in switches (pf.switches; SPEC-master 5b): one row per known switch, the same for every
-- business. K-23's company_kinds.pf_switches_a and pf_switches_b name only these, which code checks at each write.
create table plugin_switches (
  name text primary key,
  means text not null,
  source text not null,
  constraint plugin_switches_name_form check (name ~ '^[a-z0-9]+$')
);

-- The closed registry of rule kinds (arch 09 lines 480, 482): each kind's one value type, the fact a business's kinds of
-- work must list before the rule is offered, and what holds when the business has no rule of the kind in effect. The
-- kind note holds the owner's own words, which the AI reads and code never enforces.
create table rule_kinds (
  id text primary key,
  value_type text not null,
  needs_fact text,
  unset_means text not null,
  means text not null,
  source text not null,
  constraint rule_kinds_needs_fact_fk foreign key (needs_fact) references trade_facts (name) on delete restrict,
  constraint rule_kinds_id_type_key unique (id, value_type),
  constraint rule_kinds_id_form check (id ~ '^[a-z]+(_[a-z]+)*$'),
  constraint rule_kinds_value_type_known check (value_type in ('on', 'money', 'span', 'count', 'dates', 'note')),
  constraint rule_kinds_note_is_note check ((id = 'note') = (value_type = 'note'))
);

-- The owner's own rules (arch 09 line 457: 'Rule type · scope · value'; S1-21 gives booking_rules; S11-57): a kind from
-- the registry, a scope (the business, or one flow, one kind of work, or both) and a typed value of the kind's one type,
-- or a note in the owner's words, with effective dates. A suggestion from the tap list becomes a row only when the owner
-- keeps it.
create table rules (
  id text primary key,
  business_id text not null,
  rule_kind text not null,
  value_type text not null,
  flow text,
  kind_id text,
  value_on boolean,
  value_cents integer,
  value_currency text,
  value_span interval,
  value_count integer,
  value_dates daterange,
  words text,
  set_by_person_id text not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  version integer not null default 1,
  constraint rules_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint rules_kind_fk foreign key (rule_kind, value_type) references rule_kinds (id, value_type) on delete restrict,
  constraint rules_set_by_fk foreign key (set_by_person_id) references persons (id) on delete restrict,
  constraint rules_one_in_effect exclude using gist (
    business_id with =,
    rule_kind with =,
    (coalesce(flow, '')) with =,
    (coalesce(kind_id, '')) with =,
    (tstzrange(effective_from, effective_to, '[)')) with &&
  ) where (value_type not in ('dates', 'note')),
  constraint rules_flow_known check (flow is null or flow in ('A', 'B')),
  constraint rules_kind_id_form check (kind_id is null or kind_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint rules_value_matches_type check (
    (value_on is not null) = (value_type = 'on')
      and (value_cents is not null) = (value_type = 'money')
      and (value_currency is not null) = (value_type = 'money')
      and (value_span is not null) = (value_type = 'span')
      and (value_count is not null) = (value_type = 'count')
      and (value_dates is not null) = (value_type = 'dates')
  ),
  constraint rules_value_in_range check (
    (value_cents is null or value_cents >= 0)
      and (value_currency is null or value_currency ~ '^[A-Z]{3}$')
      and (value_span is null or value_span > interval '0')
      and (value_count is null or value_count >= 1)
      and (value_dates is null or not isempty(value_dates))
  ),
  constraint rules_note_has_words check (value_type <> 'note' or (words is not null and length(btrim(words)) > 0)),
  constraint rules_dates_in_order check (effective_to is null or effective_to > effective_from)
);

-- A business's rules in effect at a time: limit 2's rule evaluator and search (arch 06 line 301, arch 05 line 237), the
-- request decision (A4-98), the read-back and summary (S1-21, S1-79) and the Settings page (S11-57).
create index rules_business_idx on rules (business_id, rule_kind, effective_from);

create trigger rules_version_raised
  before update on rules
  for each row execute function enforce_version_raise();

-- The owner's price OK limit (S1-21 gives price_oks; FS row V21): a quote, a bill or both over an amount comes to the
-- owner first, before the customer sees it (A4-09); 0 is every priced quote or bill it covers. List prices never need
-- one. Scoped like a rule, with effective dates.
create table price_ok_limits (
  id text primary key,
  business_id text not null,
  flow text,
  kind_id text,
  quotes boolean not null,
  bills boolean not null,
  over_cents integer not null,
  currency text not null,
  set_by_person_id text not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  version integer not null default 1,
  constraint price_ok_limits_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint price_ok_limits_set_by_fk foreign key (set_by_person_id) references persons (id) on delete restrict,
  constraint price_ok_limits_one_in_effect exclude using gist (
    business_id with =,
    (coalesce(flow, '')) with =,
    (coalesce(kind_id, '')) with =,
    (tstzrange(effective_from, effective_to, '[)')) with &&
  ),
  constraint price_ok_limits_flow_known check (flow is null or flow in ('A', 'B')),
  constraint price_ok_limits_kind_id_form check (kind_id is null or kind_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint price_ok_limits_covers_something check (quotes or bills),
  constraint price_ok_limits_money check (over_cents >= 0 and currency ~ '^[A-Z]{3}$'),
  constraint price_ok_limits_dates_in_order check (effective_to is null or effective_to > effective_from)
);

-- A business's price OK limits in effect when a quote or bill is priced (A4-05, A4-09).
create index price_ok_limits_business_idx on price_ok_limits (business_id, effective_from);

create trigger price_ok_limits_version_raised
  before update on price_ok_limits
  for each row execute function enforce_version_raise();

-- Grants (the readers each serves are named in this file's header).
-- The closed registries (scope none): every role reads them; only a migration's seed writes them (README rule 5).
grant select on trade_facts, plugin_switches, rule_kinds to rosie_app, rosie_job;
-- Business-scoped, versioned and never deleted: both roles, behind the policies below.
grant select, insert, update on rules, price_ok_limits to rosie_app, rosie_job;

-- Row-level security on the two business-scoped tables: rosie_app sees only its scope; rosie_job sees everything with no
-- scope, else only its scope.
alter table rules enable row level security;
create policy rules_tool_api on rules for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy rules_runtime on rules for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table price_ok_limits enable row level security;
create policy price_ok_limits_tool_api on price_ok_limits for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy price_ok_limits_runtime on price_ok_limits for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

-- The closed registries' seed (C-157; README rules 3, 5 and 6): seed-rule-registry.json's rows, column for column. A
-- later registry entry is a row a later migration's seed adds, recorded as a minor version of K-26 with a new fixture.
-- The 28 plug-in facts the master keeps live (master-A.json live.facts); means is the master's header text, else null.
insert into trade_facts (name, means, source) values
  ('plans', null, 'SPEC-master 5d (FACTS); master-A.json live.facts'),
  ('packs', null, 'SPEC-master 5d (FACTS); master-A.json live.facts'),
  ('groups', null, 'SPEC-master 5d (FACTS); master-A.json live.facts'),
  ('classes', null, 'SPEC-master 5d (FACTS); master-A.json live.facts'),
  ('firststeps', null, 'SPEC-master 5d (FACTS); master-A.json live.facts; MC C5 (insurance)'),
  ('forms', null, 'SPEC-master 5d (FACTS); master-A.json live.facts; MC C5 (insurance)'),
  ('sentnow', null, 'SPEC-master 5d (FACTS); master-A.json live.facts'),
  ('results', null, 'SPEC-master 5d (FACTS); master-A.json live.facts'),
  ('planbill', null, 'SPEC-master 5d (FACTS); master-A.json live.facts'),
  ('dropoff', null, 'SPEC-master 5d (FACTS); master-A.json live.facts'),
  ('multiday', null, 'SPEC-master 5d (FACTS); master-A.json live.facts'),
  ('spaces', null, 'SPEC-master 5d (FACTS); master-A.json live.facts'),
  ('children', null, 'SPEC-master 5d (FACTS); master-A.json live.facts'),
  ('incare', null, 'SPEC-master 5d (FACTS); master-A.json live.facts'),
  ('animals', null, 'SPEC-master 5d (FACTS); master-A.json live.facts'),
  ('video', null, 'SPEC-master 5d (FACTS); master-A.json live.facts; MC C5 (insurance)'),
  ('aftercare', null, 'SPEC-master 5d (FACTS); master-A.json live.facts'),
  ('photos', null, 'SPEC-master 5d (FACTS: ''the plug-in shows work photos''); master-A.json live.facts'),
  (
    'documents',
    'A document to sign or OK on the secure page before the work: a contract, a written estimate, a proposal or a design (the business sending it is its signature; REDESIGN 2).',
    'master-A.json header facts; live.facts; MC C5 (insurance)'
  ),
  (
    'waitlist',
    'The business keeps a waitlist for full times (the owner''s booking rules turn it on, S1-21).',
    'master-A.json header facts; live.facts'
  ),
  (
    'tips',
    'A tip line on the bills Rosie sends (the owner''s tip setting in S1-21''s "Bills I send" row, or S11-56).',
    'master-A.json header facts; live.facts'
  ),
  (
    'discounts',
    'The business takes its own discount codes on the booking page (the owner turns them on in the portal, S11-56). Off: the booking never asks for one. Gift cards are never taken through Rosie.',
    'master-A.json header facts; live.facts'
  ),
  (
    'stages',
    'Big jobs paid in stages, each stage billed before the next (the plug-in''s or the owner''s stage plan).',
    'master-A.json header facts; live.facts'
  ),
  (
    'monthlybill',
    'One bill a period for plans or business accounts (the owner turns it on in the portal, S11-56).',
    'master-A.json header facts; live.facts'
  ),
  (
    'banktransfer',
    'Big bills may be paid by bank transfer (the owner''s setting in S1-21, or S11-56).',
    'master-A.json header facts; live.facts'
  ),
  (
    'extrawork',
    'Work can change at the visit: an add-on, a bigger job found, goods or an urgent part (the plug-in''s visit rules).',
    'master-A.json header facts; live.facts'
  ),
  (
    'nomoney',
    'A whole business with no money through Rosie; a switch and a fact, set both or neither (SPEC-master 5d).',
    'SPEC-master 5b, 5d (FACTS); master-A.json live.facts'
  ),
  (
    'capacitycheck',
    'The owner turns it on: at the times they pick, the AI asks how many more a window can take; silence turns that window''s new bookings into requests (D87).',
    'master-A.json header facts; live.facts'
  );

-- The 6 plug-in switches: the 5 the master keeps live (live.switches) and nomoney, set with its fact (SPEC-master 5d).
insert into plugin_switches (name, means, source) values
  (
    'sensitive',
    'On for health care, therapy, addiction, legal and immigration work, children''s services, funeral and grief work, investigators; off: normal texts. The switch grief is merged into it.',
    'SPEC-master 5b; master-A.json live.switches, live.merged.switches'
  ),
  (
    'no2',
    'On for human health practices and law firms; off: the $2 lines. It follows the owner''s choice at the $2 split, never set by hand.',
    'SPEC-master 5b; SPEC-prof section 3 (no2); master-A.json live.switches'
  ),
  (
    'welfare',
    'On for work where the person served may be unable to answer; off: normal no-show words.',
    'SPEC-master 5b; master-A.json live.switches'
  ),
  (
    'cancelright',
    'On for work sold at the customer''s place with a written cancel period; off: no cancel period for work already given.',
    'SPEC-master 5b; master-A.json live.switches; FS row V20'
  ),
  (
    'verify',
    'License and document checks: off for now (D96; not launched). Off: licenses and documents are optional, shown as the business gave them and never checked.',
    'master-A.json header switches; live.switches; D96'
  ),
  (
    'nomoney',
    'A whole business with no money through Rosie; merged into the fact nomoney, and set with it (SPEC-master 5d; K-23 v1 company_kinds_nomoney_fact_and_switch).',
    'SPEC-master 5b, 5d; master-A.json live.merged.switches'
  );

-- The 16 rule kinds of v1, each with its one value type, the fact it needs and what holds when it is unset.
insert into rule_kinds (id, value_type, needs_fact, unset_means, means, source) values
  (
    'ok_same_day',
    'on',
    null,
    'A same-day booking books on the yes, unless another rule asks.',
    'A same-day booking waits for the owner''s OK: the page says ''This is a request'' before the yes, and nothing is charged until the OK (A4-98).',
    'S1-21 (''Same-day and new customers: Ask you first''); FS row H05; A4-98; B4-115'
  ),
  (
    'ok_new_customer',
    'on',
    null,
    'A new customer''s booking books on the yes, unless another rule asks.',
    'A new customer''s booking waits for the owner''s OK (A4-98); where it covers a job sent now, the owner gets 5 minutes, any hour, and silence sends nobody (B4-115).',
    'S1-21 (''Same-day and new customers: Ask you first''); FS row H05; A4-98; B4-115'
  ),
  (
    'ok_dates',
    'dates',
    null,
    'No date waits for an OK.',
    'A booking on these dates waits for the owner''s OK; several ranges may be in effect at once.',
    'A4-98 (''same day, new customers, some services, date ranges''); S1-21 (''some services or dates''); FS row H05'
  ),
  (
    'notice',
    'span',
    null,
    'No notice beyond the times the times card offers.',
    'A booking needs at least this much notice before its start; a time with less is not offered.',
    'FS row H05 (''notice''); S11-57 (''hours, notice'')'
  ),
  (
    'months_offered',
    'dates',
    null,
    'All year.',
    'Bookings are offered only on these dates; several ranges add up.',
    'FS row H08 (''Months offered'', O: all year); S1-21 (''Also months offered'', kept at default); S11-57'
  ),
  (
    'minimum_job',
    'money',
    null,
    'No minimum.',
    'The least a booking''s total may be, with any extra work; a photo quote is checked when priced, and a price set only at the visit or by the hour passes, with a note on the owner''s booking card (limit 2).',
    'arch 06 line 301 (limit 2: ''The $250 minimum''); arch 05 line 239 (''owner rules · minimum job''); C-082'
  ),
  (
    'deposit_cap',
    'money',
    null,
    'No cap beyond the price known then (FS row V06).',
    'The most a deposit may be: a cap the plug-in knows, shown as a suggested row and kept by the owner as the owner''s own rule, never Rosie''s check.',
    'S1-21 (''Deposit or fee caps the plug-in knows show as suggested rows. They''re the owner''s own rules, never Rosie''s checks''); S1-03 block 6'
  ),
  (
    'fee_cap',
    'money',
    null,
    'No cap beyond what was paid now, when money was paid now (S1-21).',
    'The most a late-cancel or no-show fee may be: a cap the plug-in knows, kept by the owner as the owner''s own rule, never Rosie''s check.',
    'S1-21 (''Deposit or fee caps the plug-in knows show as suggested rows''); S1-03 block 6; FS row V08'
  ),
  (
    'waitlist',
    'on',
    'waitlist',
    'Off.',
    'The business keeps a waitlist for full times (A4-60).',
    'S1-21 (''Also the waitlist ... all off''); FS row V14; master-A.json header facts (waitlist)'
  ),
  (
    'tip_line',
    'on',
    'tips',
    'Off.',
    'A tip line on the bills Rosie sends, only where bills are sent.',
    'S1-21 (''Bills Rosie sends: a tip line''); FS row V11; master-A.json header facts (tips)'
  ),
  (
    'bank_transfer_over',
    'money',
    'banktransfer',
    'Off: no bill is paid by bank transfer.',
    'A bill Rosie sends over this amount may be paid by bank transfer.',
    'S1-21 (''bank transfer over an amount''); FS row V12; master-A.json header facts (banktransfer)'
  ),
  (
    'one_bill',
    'on',
    'monthlybill',
    'Off.',
    'One bill a period for many visits.',
    'S1-21 (''one bill for many visits ... all off''); FS row V17; S11-56; master-A.json header facts (monthlybill)'
  ),
  (
    'no_show_count',
    'count',
    null,
    'Off.',
    'The no-show count, off unless the owner turns it on: after this many no-shows or late cancels with no card, a card is needed to book.',
    'S1-21 (''the no-show count, all off''); S11-57 (''The no-show count stays off unless Sam turns it on''); the plug-ins'' pf.edges repeatNoShow (''the owner''s setting'')'
  ),
  (
    'members_paying_elsewhere',
    'on',
    'packs',
    'On: bookings from members who pay elsewhere are taken, each class $2 at check-in.',
    'Take bookings from members who pay elsewhere; off: those bookings are declined (A4-80).',
    'S1-21 (''take bookings from members who pay elsewhere? On unless Sam turns it off''); A4-80; master-A.json live.merged.facts (memberships: packs)'
  ),
  (
    'own_customers_only',
    'on',
    null,
    'Off: anyone may book.',
    'Only the business''s own customers may book; the booking page says so kindly.',
    'S1-21 (''Only the business''s own customers may book''); FS row K10; A4-43; A4-80'
  ),
  (
    'note',
    'note',
    null,
    'No note.',
    'The owner''s own words, which the AI reads and code never enforces; the read-back tells the owner it was saved only as a note.',
    'arch 09 line 482; C-157'
  );
