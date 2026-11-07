# db-schema/rules (K-26): the database schema, rules part

**Status: v1, frozen** (`frozen.json`: `{"frozen": ["v1"]}`). Written and frozen by T-035. The freeze takes effect when T-035 merges, and the merge waits for every review below (build prompt 6.2, 6.5).

## Freeze record

Frozen v1, 2026-11-07, reviews required: database engineer, action-layer engineer, QA and eval engineer.

Each reviewer checks its own side (02-contracts section 1): the database engineer that the migrations can produce exactly this table list, with the rules below, beside K-04 core and K-23 business setup without redefining any of their columns, and that the closed registries are seeded by a migration (C-162 rules tables, C-157 closed registry, with C-154 migrations queue and C-155 seeds); the action-layer engineer the rows S1-21's Tool API call writes (booking_rules and price_oks; C-074), the rows limit 2's one rule evaluator reads (C-082, T-300; arch 06 line 301), the request decision (A4-98, B4-115), the price OK before a quote or bill goes (A4-05, A4-09; C-099), search's owner-rule filter (C-097; arch 05 line 237) and the Settings changes (S11-57); QA and eval the seeds and refused rows (C-147; the contract test `tests/contract/db-schema.rules.v1.test.ts`, T-103). The lead records the freeze in `ops/DECISIONS.md` and on the board (build prompt 5.7).

**Owner:** the architect. **Table list:** `rules.v1.tables.json`, checked against `../tables.meta.schema.json` (02-contracts section 2 item 3). **Checked by:** `npm run contracts:check` (the list's shape, that every column a key, constraint, index, scope, version, effective date or seal names exists, and the fixtures index). **Contract test:** `tests/contract/db-schema.rules.v1.test.ts` (QA, T-103, not T-035): migrate a fresh schema with the core and business-setup parts, compare the catalog with the table list, load the seeds, refuse the refused rows. A change after the freeze is a new file, `rules.v1.1.tables.json` (additive) or `rules.v2.tables.json` (breaking, with the CTO's OK), with new fixtures (build prompt 6.4); the frozen-contract guard fails any edit to v1's table list, its fixtures or their index entries.

## What it defines

The five tables of arch 09's "Rules" domain (arch 09 line 463: 5 tables; line 457: "Rule type · scope · value"), under Q-33's default (arch 09's shape, FS as the checklist), following 02-contracts section 7 row K-26: typed owner rules with effective dates (lines 457, 488), the closed registry of rule kinds and trade facts (line 480; C-157), notes kept as notes that the read-back names (line 482), and S1-21's booking rules and price OK limits (section 8: `booking_rules`, `price_oks`). Arch 09 gives only the count; every table and column names its source in `rules.v1.tables.json`.

| Table             | What it holds                                                                                                                                                                       | Source                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `trade_facts`     | The closed registry of plug-in facts (pf.facts): the 28 the master keeps live.                                                                                                      | arch 09 line 480; SPEC-master 5d; master live.facts; MC C5  |
| `plugin_switches` | The closed registry of plug-in switches (pf.switches): the 5 the master keeps live, and nomoney, which is set with its fact.                                                        | SPEC-master 5b, 5d; master live.switches; K-23 v1 README    |
| `rule_kinds`      | The closed registry of rule kinds: each kind's one value type, the fact the work must list before it is offered, and what holds when it is unset. 16 in v1, `note` among them.      | arch 09 lines 480, 482; S1-21; FS rows H05, H08, V11 to V21 |
| `rules`           | The owner's own rules: a kind, a scope (the business, a flow, a kind of work, or both), and a typed value of the kind's type or the owner's words for a note, with effective dates. | arch 09 lines 457, 482, 488; S1-21 (booking_rules); S11-57  |
| `price_ok_limits` | The owner's price OK limit: a quote, a bill or both over an amount comes to the owner first; list prices never need one. Scoped like a rule, with effective dates.                  | S1-21 (price_oks); FS row V21; A4-09; SPEC-master 6         |

### Which part owns what

- **K-04 core** owns the business head (`businesses`: id, time zone, text hours H04) and `persons`. This part names them by K-04's keys, `businesses.id` and `persons.id`, and repeats none of their columns. The owner's text hours (8am to 8pm by default, S1-21's "Not shown, kept at a safe default") stay core's.
- **K-23 business setup** (frozen, #78) owns the free-cancel time H06 and arrival setting H07 (`flow_defaults`), the travel area L02 and L03 (`locations`), and the companies with each kind of work and its fact and switch arrays (`company_kinds`). This part refers to a kind of work only by `kind_id`, the profession file's id as `company_kinds.kind_id` holds it, with K-23's form check and no foreign key: that the business has the kind spans rows, so code checks it. The registries here are the closed lists K-23's README points to ("Which names are known facts and switches is K-26's closed registry"): code checks each name in `pf_facts`, `pf_switches_a` and `pf_switches_b` against `trade_facts` and `plugin_switches` when it writes them, since an array carries no foreign key. Nothing in K-23 changes.
- **K-24 kinds of work** (frozen alongside, F14) owns the 243 kinds and each kind's plug-in text blocks, `pf.rules` among them: the profession's own rules, written "where the state's rules require it", stay text there (MC R3; FS line 746). This part holds the owner's own rules, and a rule kind's `needs_fact` names the fact a kind's list must hold before the rule is offered. No foreign key to K-24 in v1.
- **K-22 people and access** (frozen alongside, F14) owns who may OK what (T05), on call and who takes jobs sent now (T12, S2-27) and admins' powers (S13-45 row 8). `set_by_person_id` names a core person; whether that person may change settings is K-22's.
- **K-25 services and prices** owns each service's late-cancel and no-show fee (V08), a service path's tip setting (FS line 725) and price rules by worker, place and time. **K-27 availability** owns hours (H01) and time off. **K-30 bookings** copies the rules in effect into the booking's terms snapshot (FS line 750; S1-21: "A booking keeps the rules it was made with").
- **The phone line** (S1-21's phone-line row, FS row N02, and the `voice` key) is out (C-236; 02-contracts section 8): no table, column or rule kind here, and `refuse-unknown-rule-kind` shows a phone-line rule refused.

### S1-21's tap list, row by row

| Tap-list row (S1-21)                                           | Lives in                                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Hours                                                          | K-27 (H01)                                                                                             |
| Cancel: free-cancel time; the fee, asked of Sam each time      | K-23 `flow_defaults` (H06); K-25 (V08); a fee cap the plug-in knows: `fee_cap` here                    |
| Same-day and new customers: ask you first                      | `rules`: `ok_same_day`, `ok_new_customer`; dates: `ok_dates`                                           |
| Price OKs: quotes and bills over an amount; list prices never  | `price_ok_limits`                                                                                      |
| Travel area                                                    | K-23 `locations` (L02, L03)                                                                            |
| Jobs sent now: who takes them                                  | K-22 (T12)                                                                                             |
| Phone line                                                     | out (C-236)                                                                                            |
| Bills Rosie sends: a tip line; bank transfer over an amount    | `rules`: `tip_line`, `bank_transfer_over`                                                              |
| Members who pay elsewhere (membership work)                    | `rules`: `members_paying_elsewhere` (on unless turned off)                                             |
| Only the business's own customers (where the plug-in suggests) | `rules`: `own_customers_only` (the list: open gaps)                                                    |
| Not shown, kept at a safe default                              | waitlist, one bill, no-show count, months offered: `rules` (unset means the default); text hours: core |
| Deposit or fee caps the plug-in knows                          | `rules`: `deposit_cap`, `fee_cap`                                                                      |

A suggestion is never stored: only a kept one becomes a row (S1-21: "Never: ... let a suggestion run before the owner keeps it"). "Safe default: every suggestion kept as shown."

### The closed registries (`seed-rule-registry.json`)

`rule_kinds`, v1 (value type; the fact needed; unset means):

| Kind                       | Type  | Needs fact   | Unset                           | Source                             |
| -------------------------- | ----- | ------------ | ------------------------------- | ---------------------------------- |
| `ok_same_day`              | on    |              | books on the yes                | S1-21; FS H05; A4-98               |
| `ok_new_customer`          | on    |              | books on the yes                | S1-21; FS H05; A4-98; B4-115       |
| `ok_dates`                 | dates |              | no date waits                   | A4-98 ("date ranges"); S1-21       |
| `notice`                   | span  |              | no notice beyond the times card | FS H05 ("notice"); S11-57          |
| `months_offered`           | dates |              | all year                        | FS H08; S1-21; S11-57              |
| `minimum_job`              | money |              | no minimum                      | arch 06 line 301; arch 05 line 239 |
| `deposit_cap`              | money |              | no cap beyond the price known   | S1-21; S1-03 block 6               |
| `fee_cap`                  | money |              | no cap beyond what was paid now | S1-21; S1-03 block 6; FS V08       |
| `waitlist`                 | on    | waitlist     | off                             | S1-21; FS V14                      |
| `tip_line`                 | on    | tips         | off                             | S1-21; FS V11                      |
| `bank_transfer_over`       | money | banktransfer | off                             | S1-21; FS V12                      |
| `one_bill`                 | on    | monthlybill  | off                             | S1-21; FS V17                      |
| `no_show_count`            | count |              | off                             | S1-21; S11-57                      |
| `members_paying_elsewhere` | on    | packs        | on                              | S1-21; A4-80                       |
| `own_customers_only`       | on    |              | off                             | S1-21; FS K10; A4-43               |
| `note`                     | note  |              | no note                         | arch 09 line 482                   |

- **Types:** `on` (`value_on`), `money` (`value_cents` with `value_currency`), `span` (`value_span`), `count` (`value_count`, from 1), `dates` (`value_dates`, days in the business's zone), `note` (`words` only). `rules_kind_fk` holds a rule's `(rule_kind, value_type)` to the registry, so a kind not in it, or a value of another type, is refused (23503); `rules_value_matches_type` makes exactly that type's column set (23514). A `dates` or `note` kind may have several rows in effect in one scope; every other kind one at a time (`rules_one_in_effect`).
- **Facts** (28): the master's live list (`master-A.json` live.facts): plans, packs, groups, classes, firststeps, forms, sentnow, results, planbill, dropoff, multiday, spaces, children, incare, animals, video, aftercare, photos, documents, waitlist, tips, discounts, stages, monthlybill, banktransfer, extrawork, nomoney, capacitycheck. `means` is the master's header text where it gives one, else null.
- **Switches** (6): sensitive, no2, welfare, cancelright, verify (live.switches) and nomoney, set with its fact (SPEC-master 5d; K-23's `company_kinds_nomoney_fact_and_switch`).
- Every fact and switch named by the 243 demo shops of fixture set v1 is in these lists (checked by a throwaway script on 2026-11-07: 28 fact names and 5 switch names in use).

### Notes (arch 09 line 482)

A rule the owner states that fits no kind is saved as a rule of kind `note`: the owner's own `words`, which the AI reads (and may say: audience customer, staff and owner) and code never enforces. The read-back tells the owner it was saved only as a note; the kind `note` is what tells it so. A typed rule may also keep the owner's words in `words`.

### Effective dates and scope

- A change closes one row and opens the next (arch 09 line 488): the commit sets `effective_to` on the row in effect (raising its version) and inserts the next row from the same instant. Values are never edited in place and rows are never deleted. Turning a rule off closes its row, or, for a kind whose unset default is on (`members_paying_elsewhere`), opens a row with `value_on` false.
- Bookings follow the rules in effect when they are made (S11-57: "for new bookings only"), read as `tstzrange(effective_from, effective_to, '[)') @> <made at>`; K-30's terms snapshot copies them.
- Scope: `flow` (null: both) and `kind_id` (null: all the business's kinds). Where rows of one kind in several scopes are in effect, the most specific wins: kind and flow, then kind, then flow, then the whole business, as price rules (arch 05 line 253). Two rows of one kind in one scope at once are refused (`rules_one_in_effect`, `price_ok_limits_one_in_effect`, 23P01), so no tie arises within a scope.

## Database rules beyond the table list

The table list's meta-schema has no place for these; the migrations must produce them too, and the contract test checks them.

1. **Same schema as core:** the five tables live beside K-04's and K-23's tables, and their foreign keys name core tables by K-04's keys (`businesses.id`, `persons.id`), so the references carry no schema prefix. No foreign key names a K-23 table.
2. **Extensions:** `btree_gist` (K-04 v1 rule 1), for EXCLUDE's `=` on text columns beside `&&` on `tstzrange(effective_from, effective_to, '[)')`. A null `effective_to` is an open end. No PostGIS type here.
3. **Versions:** `rules` and `price_ok_limits` are updated (to close a row), so each has `version integer not null default 1`, raised by every update and compared and set by a commit (arch 01 line 85; K-04 v1 rule 2). The three registries are written once, by a migration's seed, and carry none.
4. **Ids** are `text`, opaque strings code makes (CQ-09). `rule_kinds.id`, `trade_facts.name` and `plugin_switches.name` are names, not ids code makes.
5. **Row-level security per business** (arch 10 line 546; K-04 v1 rule 4): `rules` and `price_ok_limits` are scoped by `business_id`. The registries are not per business: every role may read them, and no application role may write them (an insert by a Tool API call is refused, 42501). Only a migration's seed writes them (C-157).
6. **A new registry entry** (a rule kind, fact or switch) is a row a migration's seed adds, never a column (arch 09 line 480), and the contract records it as a minor version of this part with a new fixture, so limit 2's evaluator and the settings pages know it before a row uses it.
7. **Money** is whole cents with a currency code (CQ-09): `value_cents` with `value_currency`, both or neither; `over_cents` with `currency`.
8. **Dates** in `value_dates` are days in the business's zone (`businesses.time_zone`); instants are `timestamptz` in UTC.

## Seed and refused-row fixtures (`fixtures/`, listed in `fixtures/index.json`)

The fixture file format is K-04's (`../core/README.md`, "Seed and refused-row fixtures"): `after`, `rows`, and for a refused fixture `refused` with `role`, `scope`, `action` and `expect`. Each `after` path is relative to this part's `fixtures/` folder, so its seeds name K-04's as `../../core/fixtures/<file>` and K-23's as `../../business-setup/fixtures/<file>`; a loader loads each file once, its own `after` first. `npm run contracts:check` counts each entry as a seed row and leaves it to the contract test (02-contracts section 2 item 12).

Accepted (4): the three of 02-contracts row K-26, `seed-rules-tap-list` (Lee's Barbershop's S1-21 tap list kept as shown: same-day and new customers ask Sam first; color quotes come to Sam first, as flow A quotes over $0; board prices never need an OK), `seed-price-ok-limit` (Sam's $500 limit for Lee Home Services' quotes and bills in both flows; and the barbershop's barbers in flow B, where any wedding party quote over $500 comes to Sam first), `seed-note-only-rule` (who may book a kids cut, in Sam's words, saved only as a note for the barber kind); and one beyond its list, as K-04 added `seed-pause`: `seed-rule-registry` (the closed registries, which every rule row needs). Refused (2, in `fixtures/invalid/`): `refuse-unknown-rule-kind`, the row's own (S1-21's phone-line row as a rule of kind `phone_line`, which has no registry entry since C-236: foreign key `rules_kind_fk`, 23503), and one beyond the row's list, `refuse-overlapping-rule-dates` (a second new-customer rule from Nov 2 while the kept one is in effect: EXCLUDE `rules_one_in_effect`, 23P01). Each is refused for its one reason: the same row with the registry kind `ok_same_day`, and the same row once the first is closed at that instant, each pass.

Names and values come from fixture set v1's demo shops (`fixtures/v1/test-kit/shops/barber.json`: the flow B wedding party quoted from photos; `fixtures/v1/forms/barber.json`: "any wedding party quote over $500", who may book a kids cut; all 243 shops' facts and switches) and the master's sample cast and steps (SPEC-master 6: Sam Lee, Lee's Barbershop, Lee Home Services, "Sam's price OK limit: $500", "Price OK limit: none needed for list prices", the Nov 2 change date; S1-21's tap list and its phone-line row with (555) 010-0177), never a real person (rule 9). The businesses and people are K-04's and K-23's seed rows. These are examples, not from the sources: the row ids, the time Sam kept the tap list (2:12pm Mon Oct 19, between sign-up at 2:05pm and live at 2:20pm), and Nov 2's start as midnight in the business's zone.

**Checked on 2026-11-07** by a throwaway script against PostgreSQL 17 with PostGIS 3.5 in a private Docker container (the local image `postgis/postgis:17-3.5`, stopped and removed after; never the shared database): DDL built from the core, business-setup and rules table lists (38 tables), with `postgis` and `btree_gist`, a Tool API role and row-level security by `rosie.business_id`; every listed column with its nullability, and every constraint of the five tables, found in the catalog; all 18 core seeds, the 6 business-setup seeds and these 4 loaded together (16 rule kinds, 28 facts, 6 switches, 3 rules, 3 price OK limits), and each of these 4 alone with its `after` chain; each refused fixture refused as its `expect` says (23503 `rules_kind_fk`, 23P01 `rules_one_in_effect`) and passed once its fault was removed. 33 more probes: a value of another type than its kind's (23503), a money value without its currency, an on value on a money kind, negative cents, an empty date range, a zero span or count, a flow C, a kind id out of form, dates out of order, an unknown person, a note without words or with blank words, a price OK covering nothing, out of form or in a second row of one scope (each refused by its named constraint); a minimum job, a second note and two overlapping date ranges in one scope, a kind-of-work rule beside the business's, and a price OK change that closes one row and opens the next, each passed; an insert into another business, and a Tool API insert into a registry, refused (42501); a rule kind needing an unknown fact, a second note kind, a value type outside the list and names out of form refused; the yoga studio's scope saw none of the barbershop's rules or price OK limits and every registry row; the rule in effect at a booking time was read through `rules_business_idx`. **The frozen-file guard** was run as it is (`infra/ci/contract-freeze-guard.mjs`, its `main` against a temporary git repository whose base freezes this part's v1, never by editing a frozen file on the branch): an edit to the table list, an accepted fixture, a refused fixture or an index entry, removing a fixture and unfreezing v1 each failed (exit 1); adding `rules.v1.1.tables.json` and a new fixture passed (exit 0). The contract test is QA's task.

## Producers and consumers (02-contracts K-26 and section 7)

- **Producers:** database engineer: C-162 rules tables, C-157 the closed registry and its seed, with C-154 migrations queue and C-155 seeds from fixture set v1 (its setup seeds after F14: 02-contracts section 7 notes).
- **Consumers:** action-layer engineer: C-074 Tool API journey 1 calls (S1-21 writes booking_rules and price_oks; S1-79's summary reads them), C-082 limit 2's one rule evaluator (T-300, waiting on this freeze: QUESTIONS.md M2-action-adapters.3), C-097 search (owner rules as an exact filter, arch 05 line 237), C-099 bookings and quotes (the request decision A4-98 and B4-115, the price OK A4-05 and A4-09, the terms snapshot), the owner commands of journey 11 (S11-56, S11-57); AI engineer: C-114 context bundle (the notes and rules the planner answers from); frontend engineer (through K-21): C-187 registration screen 14 (the tap list), C-192 owner console Settings (S11-57); database engineer: C-202 staging seeded state; QA: C-147 scenario tests and the contract test (T-103). K-30 (bookings, F15) refers to these rows for its terms snapshot.
- **Frozen before it:** K-04 (frozen, #55) and K-23 (frozen, #78). **Frozen with it (F14):** K-22, K-24, K-25, K-27, K-33, K-35 and K-02 v1.1; nothing here refers to them.

## Defaults used (T-035)

1. **Q-33** (arch 09's shape, FS as the checklist): five tables named here from 02-contracts row K-26. FS section 9 has no rules table, so the checklist is FS section 2's rule rows (H05, H08, V11, V12, V14, V17, V21, K10) and S1-21's list.
2. **MC C5:** insurance's facts are cpa's list (`video`, `forms`, `firststeps`, `documents`), all in the registry, so every one of the 243 kinds' facts lists names only registry facts; the 12 kinds with no `pf.settings` start the arrival setting at "window" and the free-cancel time empty, which is K-23's `flow_defaults`, not a rule here.
3. **The registries are the master's live lists** (live.facts, live.switches), plus nomoney as a switch because K-23 v1 requires it with its fact. Merged names (memberships, series, claims, storage, crews, contracts, designs, proposals; the switches grief and credit) are not entries, so a merged name is refused like any unknown.
4. **The price OK limit is its own table** (02-contracts section 8: price_oks is "the owner's price OK limit"), with quotes, bills or both over one amount (S1-21, V21); 0 means every priced quote or bill it covers.
5. **The no-show count:** the master names it ("all off"; "stays off unless Sam turns it on") without its meaning; the plug-ins' edge "after 2 no-shows or late cancels with no card, a card is needed to book (the owner's setting)" gives it, kept as a count.
6. **The tap list's color quotes** ("Color quotes come to you first. Board prices never need one") are stored as flow A quotes over $0, since color is the barbershop's one quoted service in flow A (SPEC-master 6) and v1 has no service scope; likewise the wedding party's limit is flow B quotes of the barber kind.

## Open gaps

- **A rule for some services** (A4-98: "same day, new customers, some services, date ranges"; the color and wedding party quotes): a service scope needs K-25's service ids, frozen alongside; a K-26 v1.1 column `service_id` once K-25 is frozen. Proposed for QUESTIONS.md.
- **The list of the business's own customers** (FS K10: "on or off + list"): needs K-28's customers (F15); v1 holds the switch only.
- **Kinds S1-21 and S11-57 name with no value shape in the sources:** peak dates (their effect), fee-free reasons (the per-customer mark is K-28's `fee_free`), kept times, terms by customer, signed dated schedules, who may book (the plug-in's Q05 rule is K-24's). Until a registry entry is added, the owner's words are saved as a note. Proposed for QUESTIONS.md.
- **Discount codes (V13) and the capacity check-in (K09, D87)** are owner settings of journey 11 (S11-56, S11-12) with their codes and times; their facts are in the registry, their rule kinds come as a minor version with journey 11.
- **A deposit or fee cap as a share** of the price (the plug-ins' "deposit cap: from the state form"): v1 holds an amount only.
- **A booking with lines of two kinds of work** whose kind-scoped rules differ: for an OK rule, any rule that applies makes the booking a request (A4-98: "one of Sam's rules applies"); for a money kind such as a minimum, whether a kind-scoped rule applies to that kind's lines or to the whole total is not in the sources. Proposed for QUESTIONS.md.
- **CQ-09's id forms:** ids are opaque text until the CTO rules.

## Change log

- v1, 2026-11-07 (T-035): first version, frozen.
