-- T-739 spike only: search-a.sql with step 1 read from one trade-and-place index (candidate-indexes.sql's
-- spike_search_places and its GiST on (kind_id, map_point)) instead of joining services, service_money and locations.
-- Steps 2 to 4 are search-a.sql's word for word. Same psql variables:
--   psql -v schema=spike_t739_big -v kind=plumber -v lng=-71.1042 -v lat=42.3647 -v day=2026-11-19 \
--        -v now=2026-11-16T09:00:00-05:00 -v person=none -f search-a-places.sql
\set ON_ERROR_STOP on
set search_path to :"schema", public;

prepare search_a(text, geography, float8, date, timestamptz, text, integer) as
with candidates as (
  select distinct on (sp.business_id)
    sp.business_id, sp.service_id, sp.length, sp.money_id, sp.location_id,
    st_distance(sp.map_point, $2) as metres
  from spike_search_places sp
  join businesses b on b.id = sp.business_id
  where sp.kind_id = $1
    and b.status = 'live'
    and st_dwithin(sp.map_point, $2, $3)
    and not exists (
      select 1 from new_booking_pauses np where np.business_id = sp.business_id and np.resumed_at is null
    )
  order by sp.business_id, st_distance(sp.map_point, $2), sp.position, sp.service_id
),
ruled as (
  select c.*, r.notice, r.minimum_cents
  from candidates c
  cross join lateral (
    select
      max(ru.value_span) filter (where ru.rule_kind = 'notice') as notice,
      max(ru.value_cents) filter (where ru.rule_kind = 'minimum_job') as minimum_cents,
      range_agg(ru.value_dates) filter (where ru.rule_kind = 'months_offered') as months,
      bool_or(ru.value_on) filter (where ru.rule_kind = 'own_customers_only') as own_only
    from rules ru
    where ru.business_id = c.business_id
      and ru.rule_kind in ('notice', 'minimum_job', 'months_offered', 'own_customers_only')
      and ru.effective_from <= $5
      and (ru.effective_to is null or ru.effective_to > $5)
      and (ru.flow is null or ru.flow = 'A')
      and (ru.kind_id is null or ru.kind_id = $1)
  ) r
  where (r.months is null or r.months @> $4)
    and (r.own_only is not true or exists (
      select 1 from customers k where k.business_id = c.business_id and k.person_id = $6
    ))
),
-- materialized: the owner rules run once per candidate business, before the workers are joined (inlined, the planner
-- joined the workers first and ran the rules and the price once per worker: 3,767 times for 1,886 businesses)
priced as materialized (
  select r.*
  from ruled r
  -- a service with no price before the visit passes the minimum (rule_kinds minimum_job), so a null compare passes
  where r.minimum_cents is null or coalesce((
    select pr.price_cents
    from price_rules pr
    where pr.service_id = r.service_id
      and (pr.service_money_id is null or pr.service_money_id = r.money_id)
      and pr.worker_resource_id is null
      and pr.from_time is null
      and pr.until_time is null
      and (pr.weekdays is null or strpos(pr.weekdays, $7::text) > 0)
      and pr.effective_from <= $5
      and (pr.effective_to is null or pr.effective_to > $5)
    order by num_nonnulls(pr.service_money_id, pr.weekdays) desc, pr.price_cents
    limit 1
  ) >= r.minimum_cents, true)
),
free as (
  select p.business_id, p.location_id, p.service_id, p.money_id, p.metres, w.resource_id, f.starts_at
  from priced p
  join businesses b on b.id = p.business_id
  cross join lateral (
    select
      tstzrange($4::timestamp at time zone b.time_zone, ($4 + 1)::timestamp at time zone b.time_zone) as day,
      greatest($4::timestamp at time zone b.time_zone, $5 + coalesce(p.notice, interval '0')) as earliest
  ) d
  cross join lateral (
    select range_agg(tstzrange(($4 + h.opens_at) at time zone h.time_zone, ($4 + h.closes_at) at time zone h.time_zone))
      as open
    from weekly_hours h
    where h.business_id = p.business_id
      and h.weekday = $7
      and h.owner_kind = 'location'
      and h.location_id = p.location_id
  ) o
  cross join lateral (
    select wr.id as resource_id, wr.person_id
    from resources wr
    where wr.business_id = p.business_id and wr.kind = 'worker' and wr.active
  ) w
  cross join lateral (
    select coalesce(range_agg(x.during), '{}'::tstzmultirange) as busy
    from (
      select rv.during
      from reservations rv
      where rv.resource_id = w.resource_id
        and rv.resource_kind in ('worker', 'room', 'vehicle')
        and rv.state in ('held', 'booked')
        and rv.during && d.day
      union all
      select bb.during
      from busy_blocks bb
      where bb.person_id = w.person_id
        and bb.during && d.day
        and (
          (bb.source = 'photo' and bb.business_id = p.business_id)
          or (bb.source = 'calendar' and exists (
            select 1 from calendar_link_shares sh
            where sh.calendar_link_id = bb.calendar_link_id and sh.business_id = p.business_id and sh.ended_at is null
          ))
        )
      union all
      select t.during
      from time_off t
      where t.business_id = p.business_id
        and t.status in ('asked', 'ok')
        and t.during && d.day
        and (t.owner_kind = 'business' or t.location_id = p.location_id or t.resource_id = w.resource_id)
    ) x
  ) bz
  cross join lateral (
    select min(greatest(lower(fr), d.earliest)) as starts_at
    from unnest(o.open - bz.busy) fr
    where upper(fr) - greatest(lower(fr), d.earliest) >= p.length
  ) f
  where f.starts_at is not null
),
soonest as (
  select distinct on (business_id) *
  from free
  order by business_id, starts_at, resource_id
),
top5 as (
  select * from soonest order by starts_at, metres, business_id limit 5
)
select
  t.business_id, t.location_id, t.service_id, t.resource_id, t.starts_at, round(t.metres)::integer as metres,
  (
    select pr.price_cents
    from price_rules pr
    join businesses b on b.id = t.business_id
    where pr.service_id = t.service_id
      and (pr.service_money_id is null or pr.service_money_id = t.money_id)
      and (pr.worker_resource_id is null or pr.worker_resource_id = t.resource_id)
      and (pr.weekdays is null or strpos(pr.weekdays, $7::text) > 0)
      and (pr.from_time is null or (t.starts_at at time zone b.time_zone)::time >= pr.from_time)
      and (pr.until_time is null or (t.starts_at at time zone b.time_zone)::time < pr.until_time)
      and pr.effective_from <= t.starts_at
      and (pr.effective_to is null or pr.effective_to > t.starts_at)
    order by num_nonnulls(pr.service_money_id, pr.worker_resource_id, pr.weekdays, pr.from_time, pr.until_time) desc,
      pr.price_cents
    limit 1
  ) as price_cents
from top5 t
order by t.starts_at, t.metres, t.business_id;

\echo '--- EXPLAIN (ANALYZE, BUFFERS), first execution'
explain (analyze, buffers, costs off, summary on)
execute search_a(:'kind', st_setsrid(st_makepoint(:lng, :lat), 4326)::geography, 16093.44, :'day', :'now', :'person',
  extract(isodow from date :'day')::integer);
\echo '--- EXPLAIN (ANALYZE, BUFFERS), second execution (warm cache)'
explain (analyze, buffers, costs off, summary on)
execute search_a(:'kind', st_setsrid(st_makepoint(:lng, :lat), 4326)::geography, 16093.44, :'day', :'now', :'person',
  extract(isodow from date :'day')::integer);
\echo '--- the five rows'
\timing on
execute search_a(:'kind', st_setsrid(st_makepoint(:lng, :lat), 4326)::geography, 16093.44, :'day', :'now', :'person',
  extract(isodow from date :'day')::integer);
\timing off
deallocate search_a;
