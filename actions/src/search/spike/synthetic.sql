-- T-739 spike only: a synthetic metro in schema spike_t739_big (migrated first: DB_SCHEMA=spike_t739_big npm run
-- migrate), shaped like arch 05's example funnel (line 239: 1,200,000 businesses, 18,400 plumbers, 1,840 within 10 mi,
-- 212 free on Thursday, 37 past the owner rules, 5 shown) at a quarter of its businesses and the full size of every later
-- step: 300,000 live businesses, one shop each, spread evenly over a 0.8 x 1.1 degree box (about 55 x 56 mi) around
-- 02139, so about 10% lie within 10 mi of its centre; 18,400 of them do one kind (plumber), the rest the other 242 kinds.
-- No row is real (rule 9): every name, place and id is made here.
-- Per plumber only (the one kind searched; the other kinds' rows would only make indexes a level deeper): open hours
-- Mon-Fri 08:00-17:00 at the shop, 1 to 3 workers, booked reservations filling Wednesday and Friday, and Thursday full for
-- 88% of them (one hour taken for the rest), photo busy blocks on Thursday for a fifth of the free ones, the shop closed
-- on Thursday for 1%, a $250 minimum job for 95% (prices $80 to $280) and a 2-hour notice for a third.
--   psql -f synthetic.sql   (about 2 to 4 minutes on the build Mac's emulated PostgreSQL)
\set ON_ERROR_STOP on
set search_path to spike_t739_big, public;
select setseed(0.739);

insert into kinds select * from spike_t739.kinds;
insert into persons (id, name) values ('p-synth-owner', 'Synthetic owner');

create temporary table other_kinds as
select row_number() over (order by id) - 1 as k, id
from kinds
where id <> 'plumber' and source = 'trade_file';

create temporary table synth as
select
  n,
  case when n <= 18400 then 'plumber' end as kind_id,
  42.3647 + (random() * 0.8 - 0.4) as lat,
  -71.1042 + (random() * 1.1 - 0.55) as lng,
  8000 + floor(random() * 20000)::integer as price_cents,
  random() as r_rule,
  random() as r_busy,
  1 + floor(random() * 3)::integer as workers
from generate_series(1, 300000) n;

update synth s
set kind_id = o.id
from other_kinds o
where s.kind_id is null and o.k = s.n % (select count(*) from other_kinds);

insert into businesses (id, name, display_name, status, time_zone)
select 'b-' || n, 'Synthetic ' || n, 'Synthetic ' || n, 'live', 'America/New_York' from synth;

insert into locations (id, business_id, kind, address, map_point)
select 'l-' || n, 'b-' || n, 'shop', 'synthetic', st_setsrid(st_makepoint(lng, lat), 4326)::geography from synth;

insert into services (id, business_id, kind_id, name, price_kind, length, position)
select 's-' || n, 'b-' || n, kind_id, 'Small job', 'one_price', interval '1 hour', 1 from synth;

insert into service_money (id, service_id, business_id, flow, place, location_id, path)
select 'm-' || n, 's-' || n, 'b-' || n, 'A', 'business', 'l-' || n, 'list|none|counter' from synth;

insert into price_rules (id, business_id, service_id, price_cents, currency, set_by_person_id, effective_from)
select 'pr-' || n, 'b-' || n, 's-' || n, price_cents, 'USD', 'p-synth-owner', timestamptz '2026-01-01'
from synth
where n <= 18400;

insert into weekly_hours (id, business_id, owner_kind, location_id, weekday, opens_at, closes_at, time_zone)
select 'h-' || n || '-' || d, 'b-' || n, 'location', 'l-' || n, d, time '08:00', time '17:00', 'America/New_York'
from synth
cross join generate_series(1, 5) d
where n <= 18400;

insert into persons (id, name)
select 'p-w-' || n || '-' || w, 'Worker'
from synth
cross join lateral generate_series(1, workers) w
where n <= 18400;

insert into resources (id, business_id, kind, name, person_id)
select 'w-' || n || '-' || w, 'b-' || n, 'worker', 'Worker', 'p-w-' || n || '-' || w
from synth
cross join lateral generate_series(1, workers) w
where n <= 18400;

-- Wednesday 18, Thursday 19 and Friday 20 November 2026: three 3-hour bookings fill 08:00-17:00; Thursday only for the
-- busy 88%.
insert into reservations (id, business_id, resource_id, resource_kind, worker_person_id, during, state, for_agent_token)
select
  'rv-' || n || '-' || w || '-' || dd || '-' || slot, 'b-' || n, 'w-' || n || '-' || w, 'worker', 'p-w-' || n || '-' || w,
  tstzrange(
    (date '2026-11-18' + dd + time '08:00' + slot * interval '3 hours') at time zone 'America/New_York',
    (date '2026-11-18' + dd + time '08:00' + (slot + 1) * interval '3 hours') at time zone 'America/New_York'
  ),
  'booked', 'synthetic'
from synth
cross join lateral generate_series(1, workers) w
cross join generate_series(0, 2) dd
cross join generate_series(0, 2) slot
where n <= 18400 and (dd <> 1 or r_busy < 0.88);

-- The free 12%: Thursday's first hour taken.
insert into reservations (id, business_id, resource_id, resource_kind, worker_person_id, during, state, for_agent_token)
select
  'rv-' || n || '-' || w || '-1-x', 'b-' || n, 'w-' || n || '-' || w, 'worker', 'p-w-' || n || '-' || w,
  tstzrange(
    (date '2026-11-19' + time '08:00') at time zone 'America/New_York',
    (date '2026-11-19' + time '09:00') at time zone 'America/New_York'
  ),
  'booked', 'synthetic'
from synth
cross join lateral generate_series(1, workers) w
where n <= 18400 and r_busy >= 0.88;

insert into busy_blocks (id, business_id, person_id, source, during, time_zone, confirmed_at, confirmed_by_person_id)
select
  'bb-' || n || '-' || w, 'b-' || n, 'p-w-' || n || '-' || w, 'photo',
  tstzrange(
    (date '2026-11-19' + time '09:00') at time zone 'America/New_York',
    (date '2026-11-19' + time '10:00') at time zone 'America/New_York'
  ),
  'America/New_York', timestamptz '2026-11-01', 'p-synth-owner'
from synth
cross join lateral generate_series(1, workers) w
where n <= 18400 and r_busy >= 0.88 and n % 5 = 0;

insert into time_off (
  id, business_id, owner_kind, kind, during, time_zone, status, asked_by_person_id, asked_at, status_at,
  status_by_person_id
)
select
  'to-' || n, 'b-' || n, 'business', 'closed',
  tstzrange(
    date '2026-11-19' at time zone 'America/New_York', date '2026-11-20' at time zone 'America/New_York'
  ),
  'America/New_York', 'ok', 'p-synth-owner', timestamptz '2026-11-01', timestamptz '2026-11-01', 'p-synth-owner'
from synth
where n <= 18400 and n % 100 = 7;

insert into rules (id, business_id, rule_kind, value_type, value_cents, value_currency, set_by_person_id, effective_from)
select 'ru-min-' || n, 'b-' || n, 'minimum_job', 'money', 25000, 'USD', 'p-synth-owner', timestamptz '2026-01-01'
from synth
where n <= 18400 and r_rule < 0.95;

insert into rules (id, business_id, rule_kind, value_type, value_span, set_by_person_id, effective_from)
select 'ru-notice-' || n, 'b-' || n, 'notice', 'span', interval '2 hours', 'p-synth-owner', timestamptz '2026-01-01'
from synth
where n <= 18400 and n % 3 = 0;

analyze;

select
  (select count(*) from businesses) as businesses,
  (select count(*) from services where kind_id = 'plumber') as plumbers,
  (
    select count(*) from locations l join services s on s.business_id = l.business_id
    where s.kind_id = 'plumber'
      and st_dwithin(l.map_point, st_setsrid(st_makepoint(-71.1042, 42.3647), 4326)::geography, 16093.44)
  ) as plumbers_within_10_mi,
  (
    select count(*) from locations l
    where st_dwithin(l.map_point, st_setsrid(st_makepoint(-71.1042, 42.3647), 4326)::geography, 16093.44)
  ) as all_within_10_mi,
  (select count(*) from resources) as workers,
  (select count(*) from reservations) as reservations,
  (select count(*) from busy_blocks) as busy_blocks,
  (select count(*) from time_off) as time_off,
  (select count(*) from rules) as rules;
