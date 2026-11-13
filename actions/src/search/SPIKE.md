# Search query plan spike (T-739)

Time-boxed spike (2 hours, card T-739, C-131): the shape of the one search query and the index set that keeps it under
200 ms (arch 05 line 237 and its diagram, line 239; 01-inventory C-131: reads the replica, in 200 ms, DD). Run on
13 Nov 2026 on local rosie-pg (PostgreSQL 17 with PostGIS 3.5, `npm run db:up`), in two schemas of the spike's own,
dropped at the end. Not here: the production query (the search tasks) and the search-index migration (the database
engineer). Every file the spike ran is in `spike/`.

## The answer

- **Query shape**: one statement, four steps in the diagram's order, with the owner rules moved before the free-time
  step because they are cheaper per row: (1) trade and place, (2) owner rules (materialized, once per business),
  (3) free on the day per worker, (4) soonest, then nearest, then business id, top 5 with exact prices.
  `spike/search-a.sql` is the shape over today's tables; `spike/search-a-places.sql` is the same query with step 1 read
  from one trade-and-place index (the recommended shape).
- **Index set** (the list for the search-index migration is below): one GiST on `(kind_id, map_point)` over a table
  that holds both, a business's workers by `resources (business_id)`, and a covering price index for the minimum-job
  check; every other lookup rides an index the migrations already have.
- **Measured** (warm cache, the build Mac): on a synthetic metro shaped like the diagram's funnel, the recommended set
  answers in **126 ms** (+10 ms planning; 128 ms through psql) against **3,465 ms** with the migrated indexes alone. On
  the seeded demo shops: **0.6 ms** (+3.0 ms planning).
- **Not yet under 200 ms in every case**: with no owner rule to cut the candidates (all 1,886 within 10 mi reach the
  free-time step: 3,767 workers), the same set takes **376 ms**. The free-time step costs about 0.08 ms per worker here,
  on PostGIS's amd64 image running under emulation on Apple silicon (infra/docker-compose.yml line 8), so absolute
  times here are pessimistic; loop counts and buffers transfer, milliseconds do not. See "Open points".

## The query (flow A: the customer comes to the business)

Seven parameters: the kind picked ($1, search's trade filter), the customer's point as geography ($2), the radius in
metres ($3, 10 mi = 16093.44), the day asked ($4, read in each business's zone), now ($5), the customer's person id
for `own_customers_only` ($6), and the day's ISO weekday ($7, as `weekly_hours.weekday` holds it, 1 = Monday).

1. **Trade and place**: active services of the kind at a place of the business (`service_money` flow A, place
   business, its location) within the radius (`ST_DWithin` on stored geography points, Q-25); the business live and
   not paused (`new_booking_pauses` open row); one row per business, its nearest place that offers the kind, then its
   first service of the kind.
2. **Owner rules** (`materialized`): rules in effect at now in the business's scope (flow A or none, the kind or none):
   `months_offered` must hold the day, `own_customers_only` needs the customer in `customers`, `minimum_job` is compared
   with the service's own price (the price rule with no worker or clock condition; a service with no price before the
   visit passes, as `rule_kinds` says), and `notice` moves the earliest start.
3. **Free on the day**, per active worker resource of the business: the place's open hours that day (`weekly_hours`,
   local times read in the row's zone, as a multirange) minus held and booked reservations, the person's busy blocks
   the business may read (its own photo blocks, calendar blocks through a live share) and time off (the business,
   the place or the worker; asked or ok); the soonest start at or after `greatest(day start, now + notice)` where the
   service's length fits. Multirange arithmetic (`range_agg`, `-`, `unnest`), PostgreSQL 14 and later.
4. **Order**: per business its soonest worker; then soonest, nearest, business id (one order for everyone, RULES 1.5,
   1.6); `limit 5`; each of the five with its exact price (the price rule with the most conditions set that holds for
   the worker, the weekday and the start time; a tie takes the lower price, arch 05 line 253).

Two settings found by measuring: the rules step must be `materialized` (inlined, the planner joined the workers first
and ran the rules and the price once per worker: 3,767 times instead of 1,886), and the statement runs with
`set local max_parallel_workers_per_gather = 0` (parallel workers cost about 50 ms to start here, more than they
saved).

## Index list for the search-index migration

New (each tried only in the spike's schemas; no migration file was written):

1. **Trade and place in one index**: `gist (kind_id, map_point)` (btree_gist's `=` on text beside PostGIS's `&&` on
   geography) on a table holding one row per active service at a place of a business: kind_id, flow, business_id,
   service_id, service_money id, location_id, map_point (and, for flow B, the travel area). The kind lives on
   `services` and the point on `locations`, so no index over today's tables can do both: step 1 took 331 ms from
   `services_kind_idx` plus 18,400 `locations_pkey` probes, and 27 to 41 ms from this index (3,167 index hits, 1,886 after
   the exact distance check). The spike built it as `spike_search_places` (`spike/candidate-indexes.sql`); the real
   one needs a writer: the commit that writes services, service_money and locations, or a trigger, and a db-schema
   contract change (architect), with the table and index in the database engineer's migration.
2. **A business's workers**: `resources (business_id) where kind = 'worker' and active`. `resources` has no index on
   business_id (0007), so step 3 read all 36,695 rows once per candidate (13,026,008 rows removed by the join filter):
   3,465 ms without it, 1,430 ms with it, before any other change.
3. **The minimum-job price check**, index-only:
   `price_rules (service_id, effective_from) include (effective_to, service_money_id, weekdays, price_cents)` with
   `where worker_resource_id is null and from_time is null and until_time is null`: 0.005 ms per business instead of
   0.028 ms through `price_rules_one_in_effect` (1,797 checks: 50 ms to 9 ms).

Already in migrations 0001 to 0035 and used by the plan (keep them):

- `rules_business_idx` (owner rules per business), `weekly_hours_business_day_idx` (open hours of the day),
  `busy_blocks_person_during_idx` and `time_off_business_during_idx` (GiST, busy and closed times of the day),
  `businesses_pkey`, `new_booking_pauses_one_open`, `customers_person_idx`, and `price_rules_one_in_effect` (the exact
  price of the five).
- `reservations_no_overlap_per_resource`, the GiST index of the per-resource EXCLUDE (0008), serves the held and booked
  times of a worker as an index-only scan, but only while the query's predicates imply its WHERE: write
  `resource_kind in ('worker', 'room', 'vehicle') and state in ('held', 'booked')` as `spike/search-a.sql` does.
- `services_kind_idx` and `locations_map_point_idx` stay for the flow B travel check and other readers; search's step 1
  should not depend on them (item 1).

## Measurements

### On the seeded demo shops

Schema `spike_t739`: every migration, then the sets in the order `db/seeds/journey-states.int.test.ts` seeds them
(core, setup-business, kinds, setup-services-rules, setup-staff, setup-availability, customers), then setup-points
(T-726) and journey-states (T-728), through `spike/seed-demo-shops.mjs` (setup-business takes a wrapping key, which
the seed runner cannot hand it; the script makes one from random bytes in memory). All 245 demo shops are seeded
`offline`, so the spike set them `live` in its own schema (version raised by one) to let rows through step 1.

Search: kind `appliance` (the demo shop with 2 workers and 4 reservations on Thursday 7 January 2027), a customer
point 2.8 km from the shop (40.12, -90.18), day 2027-01-07, now 2027-01-04 12:00 New York.

Result, one row (the one shop of that kind): `biz-demo-appliance`, worker `res-journey-appliance-a-1`, starts
2027-01-07 20:00Z (15:00 New York, its earlier hours held or booked), 2,800 m, 0 cents (a service priced at the visit).
Both shapes return it.

- Migrated indexes only (`search-a.sql`): first execution 121.9 ms (+134.3 ms planning, cold caches), second 1.3 ms
  (+3.8 ms planning).
- Recommended set (`candidate-indexes.sql` items 1 and 2, then `search-a-places.sql`): first 138.2 ms (+118.2 ms
  planning), second 0.6 ms (+3.0 ms planning); 3.8 ms through psql. Item 3, the price index, was added to the
  synthetic schema only: no seeded shop has a minimum-job rule, so that check never runs here ("never executed" below).

EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) of the recommended shape on the seeded demo shops, second execution:

```
Subquery Scan on t (actual time=0.432..0.439 rows=1 loops=1)
  Buffers: shared hit=48
  CTE priced
    ->  Nested Loop (actual time=0.189..0.194 rows=1 loops=1)
          Buffers: shared hit=23
          ->  Unique (actual time=0.158..0.162 rows=1 loops=1)
                Buffers: shared hit=21
                ->  Incremental Sort (actual time=0.157..0.159 rows=6 loops=1)
                      Sort Key: sp.business_id, (st_distance(sp.map_point, '0101000020E6100000EC51B81E858B56C08FC2F5285C0F4440'::geography, true)), sp."position", sp.service_id
                      Presorted Key: sp.business_id
                      Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 26kB  Peak Memory: 26kB
                      Buffers: shared hit=21
                      ->  Nested Loop (actual time=0.120..0.151 rows=6 loops=1)
                            Buffers: shared hit=21
                            ->  Merge Anti Join (actual time=0.082..0.086 rows=6 loops=1)
                                  Merge Cond: (sp.business_id = np.business_id)
                                  Buffers: shared hit=3
                                  ->  Sort (actual time=0.058..0.059 rows=6 loops=1)
                                        Sort Key: sp.business_id
                                        Sort Method: quicksort  Memory: 26kB
                                        Buffers: shared hit=3
                                        ->  Bitmap Heap Scan on spike_search_places sp (actual time=0.046..0.051 rows=6 loops=1)
                                              Recheck Cond: (kind_id = 'appliance'::text)
                                              Filter: st_dwithin(map_point, '0101000020E6100000EC51B81E858B56C08FC2F5285C0F4440'::geography, '16093.44'::double precision, true)
                                              Heap Blocks: exact=1
                                              Buffers: shared hit=3
                                              ->  Bitmap Index Scan on spike_search_places_kind_point_idx (actual time=0.026..0.027 rows=6 loops=1)
                                                    Index Cond: ((kind_id = 'appliance'::text) AND (map_point && _st_expand('0101000020E6100000EC51B81E858B56C08FC2F5285C0F4440'::geography, '16093.44'::double precision)))
                                                    Buffers: shared hit=2
                                  ->  Sort (actual time=0.021..0.021 rows=0 loops=1)
                                        Sort Key: np.business_id
                                        Sort Method: quicksort  Memory: 25kB
                                        ->  Seq Scan on new_booking_pauses np (actual time=0.004..0.004 rows=0 loops=1)
                                              Filter: (resumed_at IS NULL)
                            ->  Index Scan using businesses_pkey on businesses b_1 (actual time=0.005..0.005 rows=1 loops=6)
                                  Index Cond: (id = sp.business_id)
                                  Filter: (status = 'live'::text)
                                  Buffers: shared hit=18
          ->  Subquery Scan on r (actual time=0.029..0.030 rows=1 loops=1)
                Filter: (((r.minimum_cents IS NULL) OR COALESCE(((SubPlan 3) >= r.minimum_cents), true)) AND ((r.own_only IS NOT TRUE) OR (ANY (sp.business_id = (hashed SubPlan 2).col1))))
                Buffers: shared hit=2
                ->  Aggregate (actual time=0.027..0.027 rows=1 loops=1)
                      Filter: ((range_agg(ru.value_dates) FILTER (WHERE (ru.rule_kind = 'months_offered'::text)) IS NULL) OR (range_agg(ru.value_dates) FILTER (WHERE (ru.rule_kind = 'months_offered'::text)) @> '2027-01-07'::date))
                      Buffers: shared hit=2
                      ->  Index Scan using rules_business_idx on rules ru (actual time=0.022..0.022 rows=0 loops=1)
                            Index Cond: ((business_id = sp.business_id) AND (rule_kind = ANY ('{notice,minimum_job,months_offered,own_customers_only}'::text[])) AND (effective_from <= '2027-01-04 17:00:00+00'::timestamp with time zone))
                            Filter: (((effective_to IS NULL) OR (effective_to > '2027-01-04 17:00:00+00'::timestamp with time zone)) AND ((flow IS NULL) OR (flow = 'A'::text)) AND ((kind_id IS NULL) OR (kind_id = 'appliance'::text)))
                            Buffers: shared hit=2
                SubPlan 3
                  ->  Limit (never executed)
                        ->  Sort (never executed)
                              Sort Key: (num_nonnulls(pr.service_money_id, pr.weekdays)) DESC, pr.price_cents
                              ->  Index Scan using price_rules_one_in_effect on price_rules pr (never executed)
                                    Index Cond: (service_id = sp.service_id)
                                    Filter: ((worker_resource_id IS NULL) AND (from_time IS NULL) AND (until_time IS NULL) AND ((service_money_id IS NULL) OR (service_money_id = sp.money_id)) AND (effective_from <= '2027-01-04 17:00:00+00'::timestamp with time zone) AND ((effective_to IS NULL) OR (effective_to > '2027-01-04 17:00:00+00'::timestamp with time zone)) AND ((weekdays IS NULL) OR (strpos(weekdays, '4'::text) > 0)))
                SubPlan 2
                  ->  Index Scan using customers_person_idx on customers k (never executed)
                        Index Cond: (person_id = 'none'::text)
  ->  Limit (actual time=0.374..0.377 rows=1 loops=1)
        Buffers: shared hit=42
        ->  Sort (actual time=0.373..0.375 rows=1 loops=1)
              Sort Key: (min(GREATEST(lower(fr.fr), GREATEST(('2027-01-07 00:00:00'::timestamp without time zone AT TIME ZONE b.time_zone), ('2027-01-04 17:00:00+00'::timestamp with time zone + COALESCE(p.notice, '00:00:00'::interval)))))), p.metres, p.business_id
              Sort Method: quicksort  Memory: 25kB
              Buffers: shared hit=42
              ->  Unique (actual time=0.368..0.371 rows=1 loops=1)
                    Buffers: shared hit=42
                    ->  Sort (actual time=0.367..0.369 rows=2 loops=1)
                          Sort Key: p.business_id, (min(GREATEST(lower(fr.fr), GREATEST(('2027-01-07 00:00:00'::timestamp without time zone AT TIME ZONE b.time_zone), ('2027-01-04 17:00:00+00'::timestamp with time zone + COALESCE(p.notice, '00:00:00'::interval)))))), wr.id
                          Sort Method: quicksort  Memory: 25kB
                          Buffers: shared hit=42
                          ->  Nested Loop (actual time=0.323..0.365 rows=2 loops=1)
                                Buffers: shared hit=42
                                ->  Nested Loop (actual time=0.303..0.339 rows=2 loops=1)
                                      Buffers: shared hit=42
                                      ->  Nested Loop (actual time=0.281..0.309 rows=2 loops=1)
                                            Buffers: shared hit=36
                                            ->  CTE Scan on priced p (actual time=0.192..0.195 rows=1 loops=1)
                                                  Buffers: shared hit=23
                                            ->  Nested Loop (actual time=0.088..0.112 rows=2 loops=1)
                                                  Buffers: shared hit=13
                                                  ->  Index Scan using businesses_pkey on businesses b (actual time=0.011..0.011 rows=1 loops=1)
                                                        Index Cond: (id = p.business_id)
                                                        Buffers: shared hit=3
                                                  ->  Nested Loop (actual time=0.076..0.099 rows=2 loops=1)
                                                        Buffers: shared hit=10
                                                        ->  Index Scan using spike_resources_business_worker_idx on resources wr (actual time=0.010..0.012 rows=2 loops=1)
                                                              Index Cond: (business_id = b.id)
                                                              Buffers: shared hit=2
                                                        ->  Aggregate (actual time=0.042..0.042 rows=1 loops=2)
                                                              Buffers: shared hit=8
                                                              ->  Append (actual time=0.032..0.037 rows=2 loops=2)
                                                                    Buffers: shared hit=8
                                                                    ->  Index Only Scan using reservations_no_overlap_per_resource on reservations rv (actual time=0.026..0.028 rows=2 loops=2)
                                                                          Index Cond: ((resource_id = wr.id) AND (during && tstzrange(('2027-01-07 00:00:00'::timestamp without time zone AT TIME ZONE b.time_zone), ('2027-01-08 00:00:00'::timestamp without time zone AT TIME ZONE b.time_zone))))
                                                                          Heap Fetches: 4
                                                                          Buffers: shared hit=8
                                                                    ->  Seq Scan on busy_blocks bb (actual time=0.001..0.001 rows=0 loops=2)
                                                                          Filter: ((person_id = wr.person_id) AND (((source = 'photo'::text) AND (business_id = p.business_id)) OR ((source = 'calendar'::text) AND EXISTS(SubPlan 6))) AND (during && tstzrange(('2027-01-07 00:00:00'::timestamp without time zone AT TIME ZONE b.time_zone), ('2027-01-08 00:00:00'::timestamp without time zone AT TIME ZONE b.time_zone))))
                                                                          SubPlan 6
                                                                            ->  Seq Scan on calendar_link_shares sh (never executed)
                                                                                  Filter: ((ended_at IS NULL) AND (calendar_link_id = bb.calendar_link_id) AND (business_id = p.business_id))
                                                                    ->  Seq Scan on time_off t_1 (actual time=0.000..0.001 rows=0 loops=2)
                                                                          Filter: ((status = ANY ('{asked,ok}'::text[])) AND (business_id = p.business_id) AND ((owner_kind = 'business'::text) OR (location_id = p.location_id) OR (resource_id = wr.id)) AND (during && tstzrange(('2027-01-07 00:00:00'::timestamp without time zone AT TIME ZONE b.time_zone), ('2027-01-08 00:00:00'::timestamp without time zone AT TIME ZONE b.time_zone))))
                                      ->  Aggregate (actual time=0.014..0.014 rows=1 loops=2)
                                            Buffers: shared hit=6
                                            ->  Index Scan using weekly_hours_business_day_idx on weekly_hours h (actual time=0.010..0.011 rows=1 loops=2)
                                                  Index Cond: ((business_id = p.business_id) AND (weekday = 4))
                                                  Filter: ((owner_kind = 'location'::text) AND (location_id = p.location_id))
                                                  Buffers: shared hit=6
                                ->  Aggregate (actual time=0.011..0.012 rows=1 loops=2)
                                      Filter: (min(GREATEST(lower(fr.fr), GREATEST(('2027-01-07 00:00:00'::timestamp without time zone AT TIME ZONE b.time_zone), ('2027-01-04 17:00:00+00'::timestamp with time zone + COALESCE(p.notice, '00:00:00'::interval))))) IS NOT NULL)
                                      ->  Function Scan on unnest fr (actual time=0.008..0.009 rows=1 loops=2)
                                            Filter: ((upper(fr) - GREATEST(lower(fr), GREATEST(('2027-01-07 00:00:00'::timestamp without time zone AT TIME ZONE b.time_zone), ('2027-01-04 17:00:00+00'::timestamp with time zone + COALESCE(p.notice, '00:00:00'::interval))))) >= p.length)
  SubPlan 5
    ->  Limit (actual time=0.053..0.054 rows=1 loops=1)
          Buffers: shared hit=6
          ->  Sort (actual time=0.052..0.053 rows=1 loops=1)
                Sort Key: (num_nonnulls(pr_1.service_money_id, pr_1.worker_resource_id, pr_1.weekdays, pr_1.from_time, pr_1.until_time)) DESC, pr_1.price_cents
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=6
                ->  Nested Loop (actual time=0.048..0.049 rows=1 loops=1)
                      Join Filter: (((pr_1.from_time IS NULL) OR (((t.starts_at AT TIME ZONE b_2.time_zone))::time without time zone >= pr_1.from_time)) AND ((pr_1.until_time IS NULL) OR (((t.starts_at AT TIME ZONE b_2.time_zone))::time without time zone < pr_1.until_time)))
                      Buffers: shared hit=6
                      ->  Index Scan using price_rules_one_in_effect on price_rules pr_1 (actual time=0.037..0.037 rows=1 loops=1)
                            Index Cond: (service_id = t.service_id)
                            Filter: (((service_money_id IS NULL) OR (service_money_id = t.money_id)) AND ((worker_resource_id IS NULL) OR (worker_resource_id = t.resource_id)) AND (effective_from <= t.starts_at) AND ((effective_to IS NULL) OR (effective_to > t.starts_at)) AND ((weekdays IS NULL) OR (strpos(weekdays, '4'::text) > 0)))
                            Buffers: shared hit=3
                      ->  Index Scan using businesses_pkey on businesses b_2 (actual time=0.008..0.008 rows=1 loops=1)
                            Index Cond: (id = t.business_id)
                            Buffers: shared hit=3
Planning:
  Buffers: shared hit=27
Planning Time: 3.018 ms
Execution Time: 0.598 ms
```

### What the seeded set is too small to show

The plan above is right in shape but says nothing about the 200 ms budget: every table is small enough that any plan
is fast, and the planner picks sequential scans where a large table would need an index (`service_money`, 1,646 rows;
`resources`, 461; `busy_blocks` and `time_off`, empty). The rows it had:

- 245 businesses, one location each, and **all 245 at one map point** (the geo double's answer for "123 Demo St,
  Anytown", 40.1, -90.2): distance filters nothing and orders nothing.
- **One shop per kind** (243 kinds, 243 company kinds): step 1 finds at most one business; nothing to sort.
- All 245 seeded `offline` (set `live` here only).
- 1,646 services, 1,215 price rules, 1,470 weekly hours (all at the location), 461 resources of which **32 workers at
  26 shops** (the journey-states pros; the other shops have no bookable worker resource, so step 3 finds no free time
  for them), 168 reservations (112 held, 56 booked, 6 to 14 January 2027), **0 busy blocks, 0 time off**, and 513 owner
  rules, none of a kind search filters on (`ok_new_customer`, `ok_same_day`, `tip_line`).

### On a synthetic metro

Schema `spike_t739_big`, built by `spike/synthetic.sql` (every row made there; no real data): the diagram's example
funnel (1,200,000 businesses, 18,400 plumbers, 1,840 within 10 mi, 212 free on Thursday, 37 past the owner rules, 5
shown) at a quarter of its businesses and full size from the trade filter on. 300,000 live businesses, one shop each,
spread evenly over a box of about 55 by 56 mi around 02139; 18,400 do the kind searched (plumber), the rest the other
242 kinds. Per plumber only: open Monday to Friday 08:00 to 17:00, 1 to 3 workers (36,695), Wednesday and Friday fully
booked, Thursday fully booked for 88% (the first hour taken for the rest), photo busy blocks for a fifth of the free
ones, closed on Thursday for 1%, a $250 minimum job for 95% (prices $80 to $280) and a 2-hour notice for a third. Rows:
321,419 reservations, 904 busy blocks, 184 time off, 23,634 rules, 92,000 weekly hours, 18,400 price rules.

Search: plumber, the box's centre (42.3647, -71.1042), Thursday 19 November 2026, now Monday 16 November 09:00.
Funnel measured: 18,400 plumbers, **1,886 within 10 mi** (of 30,510 businesses of any kind), **355 past the owner
rules**, 717 workers, 88 of them free, **44 businesses free**, 5 shown. Every run with the owner rules in effect
returned the same five rows: five shops free at 09:00 New York, 3,161 m to 5,949 m away, each with its exact price.

| Run (second execution, warm)                                   | Execution | Planning | Biggest cost                                     |
| -------------------------------------------------------------- | --------: | -------: | ------------------------------------------------ |
| Migrated indexes only, rules inlined                           |  3,465 ms |   7.5 ms | `resources` scanned whole once per candidate     |
| + `resources (business_id)` workers index                      |  1,430 ms |  16.9 ms | step 1 (813 ms), rules run once per worker       |
| + rules `materialized`, no parallel workers                    |    587 ms |   6.7 ms | step 1: 300,000-row scan, 18,400 location probes |
| + trade-and-place GiST `(kind_id, map_point)`                  |    183 ms |  10.6 ms | price check 50 ms, free step about 75 ms         |
| + covering price index (the recommended set)                   |    126 ms |  10.0 ms | free step about 70 ms, step 1 27 ms              |
| Trade-and-place GiST, as `rosie_job` under its RLS policies    |    200 ms |   5.7 ms | +9% against 183 ms as the tables' owner          |
| Trade-and-place GiST, no owner rule in effect (all 1,886 pass) |    376 ms |   5.7 ms | free step: 3,767 workers at 0.078 ms             |

The first execution of each run took 1.1 to 2.9 times its second (cold buffers, and planning up to 135 ms on a new
session); a pooled connection with the statement prepared once is what keeps planning off the budget.

## Open points for the search tasks and the database engineer

- **Which role runs it** (QUESTIONS.md candidate, architect and security reviewer): search spans businesses, and
  `rosie_app` sees only its one scoped business (0012's policies), so the one query cannot run as the Tool API's role
  under a scope. Options: `rosie_job` unscoped on the replica (measured +9%, but `db/repo/scope.ts` warns that a Tool
  API path on `rosie_job` fails open), a read-only search role with select policies of its own, or a security
  definer function that returns only the five rows. The spike measured as the tables' owner.
- **The free-time step is linear in candidate workers**, about 0.08 ms each here (three index probes per worker:
  reservations, busy blocks, time off). The 200 ms check belongs on the staging PostgreSQL host (J-06), since this
  Mac's PostGIS image runs under emulation. If it still misses there in the no-rules case: stop early (take candidates
  by their earliest possible start and stop once five are found at or before the next one's opening; a loop in code or
  a recursive CTE), or keep a per-worker free-time summary per day written by the commit.
- **The trade-and-place table needs a writer** and a db-schema contract change (item 1 of the index list).
- **Flow B** (the business comes to the customer) is not measured: the customer's point must lie inside each
  business's travel area, `ST_DWithin(coalesce(travel_centre, map_point), point, travel_miles * 1609.344)`, a radius per
  row that no GiST lookup takes as it stands. Store the area as a polygon in the trade-and-place table and index
  `(kind_id, area)`, or prefilter by the largest radius in use and check each row exactly.
- **What the spike's query leaves out** (defaults it used, each for the search tasks to settle): workers are filtered
  by `staff_skills` in the real query (`staff_skills_business_kind_idx` exists, one more probe per business); a
  worker's own hours (`weekly_hours` of owner kind resource) are not intersected with the place's; the most specific
  owner rule is approximated by `max()` per kind where the shared evaluator (C-082) decides; a business with no worker
  resource gets no free time (the seeded owners have none).
- **Zero results** (A4-19: the next day with results) and **none fit** (A4-17: another day): the same statement with
  the next day; one statement per day tried, or the days as one more parameter. Not measured.
- Distance is computed on the spheroid (`ST_Distance(geography)`'s default) for every candidate; ordering on the sphere
  is cheaper and differs little within 10 mi. Not measured.

## Reproduce

On local rosie-pg only, never in public (`seed-demo-shops.mjs` refuses any schema not named `spike_...`, and
`synthetic.sql` writes only `spike_t739_big`):

```
npm run db:up
DB_SCHEMA=spike_t739 npm run migrate
DB_SCHEMA=spike_t739 node actions/src/search/spike/seed-demo-shops.mjs
DB_SCHEMA=spike_t739_big npm run migrate
```

Then, with each `.sql` file copied into the container (`docker compose -f infra/docker-compose.yml cp`), through
`docker compose -f infra/docker-compose.yml exec -T rosie-pg psql -U rosie rosie`: set the demo shops live in
`spike_t739`; `-f synthetic.sql`; `-v schema=... -f candidate-indexes.sql`; and `search-a.sql` or
`search-a-places.sql` with `-v schema= -v kind= -v lng= -v lat= -v day= -v now= -v person=` and
`-c "set max_parallel_workers_per_gather = 0"` first. Afterwards `drop schema spike_t739 cascade` and
`drop schema spike_t739_big cascade`.
