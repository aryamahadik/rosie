-- T-739 spike only: the indexes the spike tried beyond migrations 0001 to 0035, in a spike schema only (never public,
-- never a migration file: the search-index migration is the database engineer's).
--   psql -v schema=spike_t739_big -f candidate-indexes.sql
\set ON_ERROR_STOP on
set search_path to :"schema", public;

-- 1. A business's bookable workers. resources has no index on business_id (0007 keys it by id only), so step 3 of the
--    query reads every resource row once per candidate, or hashes the whole table.
create index if not exists spike_resources_business_worker_idx on resources (business_id) where kind = 'worker' and active;

-- 2. Trade and place in one index: the arch 05 diagram's "trade index" and "within 10 mi" as one GiST lookup
--    (btree_gist's = on text beside PostGIS's && on geography). Services carry the kind and locations the point, so the
--    spike materializes the pair as a table of its own (one row per active service at a place of the business, flow A);
--    the real thing would be kept by the commit that writes services, service_money and locations, or by a trigger (the
--    database engineer's choice; see SPIKE.md).
create table if not exists spike_search_places as
select
  s.kind_id, s.business_id, s.id as service_id, s.position, s.length, m.id as money_id, l.id as location_id,
  l.map_point
from services s
join service_money m on m.service_id = s.id and m.flow = 'A' and m.place = 'business' and m.active
join locations l on l.id = m.location_id
where s.active and l.map_point is not null;

create index if not exists spike_search_places_kind_point_idx on spike_search_places using gist (kind_id, map_point);

-- 3. The minimum-job price check as an index-only scan: a service's own price rules (no worker and no clock condition)
--    in effect, read without visiting the table (through price_rules_one_in_effect, a GiST, each check cost 0.028 ms).
--    Added to spike_t739_big only, after the other two (see SPIKE.md's table).
create index if not exists spike_price_rules_base_idx on price_rules (service_id, effective_from)
  include (effective_to, service_money_id, weekdays, price_cents)
  where worker_resource_id is null and from_time is null and until_time is null;

analyze resources;
analyze spike_search_places;
analyze price_rules;
