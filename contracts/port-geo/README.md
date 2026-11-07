# port-geo (K-17): the geo port

**Status: v1, frozen** (`frozen.json`: `{"frozen": ["v1"]}`). Written and frozen by T-026. The freeze takes effect when T-026 merges, and the merge waits for every review below (build prompt 6.2, 6.5).

## Freeze record

Frozen v1, 2026-11-07, reviews required: integrations engineer, action-layer engineer, frontend engineer.

Each reviewer checks its own side (02-contracts section 1): the integrations engineer that C-220's adapter and its double can fill every field from any provider candidate and write the span (C-220 geo); the action-layer engineer the travel-area, address and area checks and distance search that read the answers (C-131 search query; the Tool API's travel-area and address calls, K-09 v1 and v1.2); the frontend engineer what the pages show and confirm (C-187 registration screen 11, the travel centre; C-198 customer booking screen 4, the place). The lead records the freeze in `ops/DECISIONS.md` and on the board (build prompt 5.7).

**Owner:** the architect. **Schema:** `port-geo.v1.schema.json` (JSON Schema 2020-12, `$id` `https://rosie.invalid/contracts/port-geo/port-geo.v1.schema.json`). **Checked by:** `npm run contracts:check`. **Contract test:** `tests/contract/port-geo.v1.test.ts` (QA, T-096). A change after the freeze is a new minor version file, `port-geo.v1.1.schema.json`, with new fixtures (build prompt 6.4); the frozen-contract guard fails any edit to v1's schema, its fixtures or their index entries.

## What it defines

One call, **geocode**: a town, a ZIP code or a street address in; map points out, each with its precision, a normalized address and the point's time zone, or "not found" (02-contracts K-17). It serves flow B's travel area at sign-up (FS rows L02, L03; S1-21), the town or ZIP check before any times (B4-77, S12-07), the street address on the secure page (B4-30), the business's map pin (FS row B03) and search by distance (arch 05 line 237).

| Definition (`$defs`) | What it is                                                                                 | Source                                      |
| -------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `geocode.request`    | `kind` (`zip`, `town`, `streetAddress`) and `text`, the words as typed                     | B4-77, B4-30; FS row L02; arch 05 line 237  |
| `geocode.response`   | `geocode.found` (`matches`, best first, at least one) or `geocode.notFound`                | 02-contracts K-17; FINDINGS.md section 2    |
| `match`              | `point` (`lat`, `lng`), `precision`, `normalizedAddress`, `timeZone`                       | 02-contracts K-17; CQ-08; S13-03            |
| `geocode.errors`     | `error` (`unavailable`, `rateLimited`, `badRequest`) and `retryAfterSeconds`               | arch 10 line 540                            |
| `geocode.exchange`   | One call and its outcome, an answer or an error: what every exchange fixture is            | 02-contracts section 2 item 2               |
| `geocode.span`       | The K-08 v1 `portCall` span the call writes, with a closed list of what it got and decided | K-08 v1 README (`portCall`, provider `geo`) |

The root is any one exchange or span, so the type generator writes a type for each. Field names are camelCase, as K-05's calls spell them; the span keeps K-08's snake_case.

### The call (02-contracts section 2 item 2)

- **Repeating it is safe:** a read with no side effect. The provider bills each call (Geocodio counts a point with its zone as two lookups: FINDINGS.md [C2]), so a caller stores the answer it keeps (below) rather than asking again.
- **Primary or replica:** neither; an outside call through C-220. Each try is one K-08 span with its `attempt`; retries follow arch 10 line 540 for the job or turn that calls it.
- **Time budget:** no source gives one; the calling stage's budget applies (open gaps).
- **Key:** the call needs one secret, the chosen provider's API key, named by the CTO and the release engineer when the provider is picked (Q-25), and never held here (contracts README convention 9). The double needs none.

### Precision, and the partial match

`precision` is the coarse port list each adapter maps its provider's own field to (FINDINGS.md section 2), finest first:

| Value          | Meaning                                                     |
| -------------- | ----------------------------------------------------------- |
| `exact`        | The address's own point (a rooftop or parcel)               |
| `interpolated` | A point estimated along the street from house-number ranges |
| `street`       | The street, no house number matched                         |
| `zip`          | The ZIP code's area                                         |
| `town`         | The town's area                                             |

A **partial match** is an answer with a coarser precision than the `kind` asked, such as a town found for a street address (`geocode-street-partial.json`). It is told apart by `precision`, never by an error (`refuse-partial-as-error.json`): B4-30's safe default asks for the address again, and nothing is booked until it checks. A provider's own values (ROOFTOP, rooftop, range_interpolation, houseNumber …) never cross the port (`refuse-vendor-precision.json`).

### Not found, several matches and errors

- **Not found** (`not-found.json`): nothing matched, the answer to an empty result (FINDINGS.md section 2). It is an answer, not an error. B4-77's safe default follows: ask for the ZIP; the street address on the page decides.
- **Several matches:** the text fits several places, best first. B4-77: "a town two states share? Ask for the ZIP." The double gives one match for each test address.
- **Errors** say the call failed, so nothing is known about the place: `unavailable` (the provider failed, timed out or refused the key), `rateLimited` (with any Retry-After, arch 10 line 540) or `badRequest`. The calling step's safe default holds meanwhile (B4-77, B4-30).

### The time zone (CQ-08)

Every match carries its point's IANA zone (`refuse-match-without-time-zone.json`), since a visit at the customer's place uses that place's zone (S13-03; arch 06 line 309). This is CQ-08's default: "the geo port returns each point's zone; the geo double gives a fixed zone per test address; the provider pick (Q-25) must supply it." Of T-1122's candidates, Geocodio, HERE and Google give it (Google by a second paid call); Mapbox and the US Census Geocoder do not (FINDINGS.md section 2, "FLAG: time zone"). So the zone is a requirement on the pick, as CQ-08 says: with Mapbox the adapter would need its own zone source, and Census cannot be the provider anyway (no ZIP or town lookups). FINDINGS.md recommends Geocodio, which fills every field here and allows stored points (DL-067: the geo pick awaiting Jay's cost OK).

### Distance is never the port's

The port gives points; the distance is computed in PostGIS on the stored points (Q-25's default; arch 05 line 237, "within 10 mi · PostGIS"), so no answer carries one (`refuse-distance-in-match.json`). K-23 v1 (contracts/db-schema/business-setup, T-032) stores a point as `geography(Point,4326)`: `locations.map_point`, and the owner-only travel centre `locations.travel_centre` with its address text `travel_centre_address`. A match's `point` is WGS 84 (EPSG 4326) and goes in as `ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography`; `lat` and `lng` are named, so nobody confuses PostGIS's longitude-first order. Whether a provider lets Rosie keep its points is the pick's question (FINDINGS.md: Geocodio yes; Google and HERE 30 days; Mapbox only permanent results).

### No address in a span or log

The request's text and the answer's `normalizedAddress` are addresses: neither enters a span or a log line (K-08 v1, "never the raw number or words"; arch 02 diagram line 105: full detail only in sealed traces). The call's span is K-08 v1's `portCall` hop with provider `geo` (already in K-08's list), call `geocode` and its `attempt`; `geocode.span` closes what it got (`step`, `kind`) and decided (`result`, `matches`, `precision`), so even a one-word town or a ZIP, which K-08 alone would take as a label, is refused (`refuse-town-in-span.json`). An error's code is the span's `error_code`, with `outcome` failed or timedOut.

## Which field of each candidate fills each port field

From T-1122's findings (`adapters/spikes/geo-provider/FINDINGS.md`, read on 2026-11-07; the bracketed ids are its sources). The value-by-value mapping is the adapter's, written from the chosen provider's own documents in its vendor spike once the CTO picks (Q-25; not this task).

| Port field          | Google (Geocoding and Time Zone APIs)                                        | Mapbox (Geocoding v6)                                               | Geocodio (v2.1)                      | HERE (Geocoding & Search v7)                                      | US Census Geocoder                          |
| ------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------- |
| `kind`              | an address, or `components=postal_code:` or `locality:` with no address [G1] | `types`: address, postcode, place [M1]                              | addresses, cities and ZIP codes [C1] | `resultType`: houseNumber, street, postalCodePoint, locality [H1] | street addresses only [U1]                  |
| `point`             | the result's lat/lng [G1]                                                    | the feature's coordinates [M1]                                      | `location` [C1]                      | `position` [H2]                                                   | its matched point, from address ranges [U2] |
| `precision`         | `geometry.location_type`, ROOFTOP to APPROXIMATE [G1]                        | `coordinates.accuracy` (rooftop to interpolated), `match_code` [M1] | `accuracy_type`, `accuracy` [C1]     | `resultType` [H1]                                                 | interpolated (approximate points) [U2]      |
| `normalizedAddress` | `formatted_address`                                                          | `full_address`                                                      | `formatted_address` [C1]             | `address.label` [H2]                                              | its matched address                         |
| `timeZone`          | Time Zone API `timeZoneId`, a second call per point [G2]                     | none [M1]; only Tilequery on a custom tileset [M2]                  | the `timezone` append's name [C2]    | `show=tz`: `timeZone.name` [H2]                                   | none [U1]                                   |
| not found           | an empty result                                                              | an empty result                                                     | an empty result                      | an empty result                                                   | an empty result                             |

Every candidate fills `point`, `precision`, `normalizedAddress` and not found from a street address; all but Census also from a ZIP and a town. `timeZone` is CQ-08's requirement on the pick (above).

## The double (02-contracts K-17; C-220)

Fixed points and zones for the test addresses; the exchange fixtures are its answers. Its world is the master's sample cast and fixture set v1's demo shops, which give towns but no state, so its points and its zone are illustrations, not real geography: no test may check one against a real map or zone table (MC C6).

| Asked (`kind`, `text`)                     | Answer                                            | Fixture                       | Source                                           |
| ------------------------------------------ | ------------------------------------------------- | ----------------------------- | ------------------------------------------------ |
| streetAddress `1200 Main St, Springfield`  | exact, 40, -90                                    | `geocode-travel-centre.json`  | B4-77, S12-07; K-23 v1 seed (POINT(-90 40))      |
| streetAddress `42 Oak Street, Springfield` | exact, 40.02, -90.03, "42 Oak St, Springfield"    | `geocode-street.json`         | B4-30 (about 2 miles from 1200 Main St)          |
| streetAddress `123 Demo St, Anytown`       | exact, 40.1, -90.2                                | `geocode-demo-shop.json`      | test-kit shops; K-23 v1 seed (POINT(-90.2 40.1)) |
| town `Springfield`                         | town, 40.01, -90                                  | `geocode-town.json`           | B4-77                                            |
| town `Riverton`                            | town, 40.58, -90 (40 miles north of 1200 Main St) | `geocode-town-riverton.json`  | S12-07, B4-31                                    |
| streetAddress `42 Oak St, Riverton`        | town, Riverton's point (a partial match)          | `geocode-street-partial.json` | B4-30                                            |
| zip `02139`                                | zip, 40.03, -90.02                                | `geocode-zip.json`            | arch 05 line 237                                 |
| town `the mall`                            | notFound                                          | `not-found.json`              | B4-77                                            |

Every zone is `America/New_York`, the zone of every demo business in K-04 v1's and K-23 v1's seeds. The double also fakes `unavailable` and `rateLimited` (`error-unavailable.json`, `error-rate-limited.json`). How a test asks it for an error or for an address it does not know (it answers notFound) is C-220's.

## Producers and consumers (02-contracts K-17)

- **Producer:** integrations engineer: C-220 geo, its adapter and its double.
- **Consumers:** action-layer engineer: C-131 search query (distance search, M5), the Tool API's travel-area and address calls (K-09 v1 and v1.2: B4-77, B4-30, S12-07); frontend engineer: C-187 registration screen 11 (the travel centre, M4), C-198 customer booking screen 4 (the place).
- **Contract test** (QA, its own task, T-096): `tests/contract/port-geo.v1.test.ts`: the fixtures against the schema, refused ones refused; the double gives exactly the exchange fixtures' answers for their requests; the adapter (on recorded vendor samples, once a provider is picked) gives port-level answers the schema accepts; every span the double and adapter write passes `geocode.span`. What the schema leaves to the test: a match's precision is never finer than the text allows (a ZIP answered at `exact`); `decided.precision` is the first match's; `decided.matches` is the number of matches; no log line holds the request's text or a normalized address.

## Fixtures (`fixtures/`, listed in `fixtures/index.json`)

Accepted: `geocode-zip.json`, `geocode-street.json`, `geocode-town.json`, `not-found.json` (the card's four); `geocode-street-partial.json` (a partial match); `geocode-town-riverton.json` (S12-07's town outside the 25 miles); `geocode-travel-centre.json` (flow B's centre at sign-up); `geocode-demo-shop.json` (the demo shops' address); `error-unavailable.json`, `error-rate-limited.json`; `span-geocode.json` (`geocode.span`). Refused, in `fixtures/invalid/`: `refuse-partial-as-error.json`, `refuse-vendor-precision.json`, `refuse-match-without-time-zone.json`, `refuse-distance-in-match.json`, `refuse-not-found-with-match.json`, `refuse-town-in-span.json`. Each refused fixture is refused for its one reason: with that one fault fixed (the partial answered as a town match, `exact` for ROOFTOP, the zone added, the distance dropped, the match dropped, the town dropped from the span) it is accepted (checked 2026-11-07).

Names and values come from the master's sample cast and fixture set v1's demo shops (Alex, Sam; Lee Home Services and its 1200 Main St, Alex's 42 Oak St in Springfield, Riverton; Lee's Barbershop's 123 Demo St, Anytown), never a real person (rule 9). One value comes from elsewhere: the ZIP code 02139, arch 05 line 237's own example request ("near 02139"), since neither the cast nor the demo shops has a ZIP code; it is no one's personal data, and the double places it beside its Springfield. Span ids follow K-08 v1's fixtures, with bundle v0's id (K-01 `bundle-v0-skeleton.json`).

## Defaults used (T-026)

1. **CQ-08:** the port returns each point's zone, required on every match; the provider pick must supply it.
2. **Q-25:** the geo double meanwhile; distance in PostGIS on stored points, never in the port.
3. **Provider-neutral fields** are those FINDINGS.md section 2 finds every candidate fills; Census, which cannot place a ZIP or a town, counts as a possible street-only backup, not as the provider.
4. **The precision list** is FINDINGS.md section 2's coarse port list (exact, interpolated, street, zip, town); the adapter maps its provider's field to it.
5. **Matches, best first,** so a town two states share can be told (B4-77 asks for the ZIP); every provider answers with a list, and not found is its empty answer.
6. **The double's world:** K-23 v1's illustrative seed points, the cast's towns, and the demo businesses' zone, America/New_York.
7. **Three errors** (unavailable, rateLimited with Retry-After, badRequest); nothing about the place is an error.

## Open gaps

- **Q-25** (the provider and its cost): the pick, its key's name and its vendor spike (the value-by-value mapping, recorded samples) wait for the CTO and Jay (BP 3.7 J-17). FINDINGS.md recommends Geocodio.
- **CQ-08** (where a visit address's zone comes from): default 1. If the pick cannot give a zone, the adapter needs its own zone source; the port does not change.
- **New (the state):** B4-30 says "the address decides which state's rules apply" and B4-31 refuses "a town in a state whose form Sam hasn't filled in", but FINDINGS.md names only the one-line address for every candidate, so v1 has no separate state field. Proposed: a v1.1 that adds the state (an optional field, additive) once the pick's spike confirms each candidate's field; meanwhile the action layer reads no state from the port.
- **New (a hint for ambiguous towns):** no source gives the port a place to bias toward (such as the business's travel centre); B4-77 asks for the ZIP instead. A bias would be an optional request field in a minor version.
- **New (time budget):** no source gives the geocode call a time budget; the calling stage's budget applies (arch 04 "Latency budget targets").
- **New (coverage):** the candidates' coverage differs (Geocodio: US, Canada, Mexico, UK, Australia, New Zealand; Census: US only); v1 assumes US addresses, as the cast's are.

## Change log

- v1, 2026-11-07 (T-026): first version, frozen: geocode's request, response, errors and exchange, its K-08 span; the fixtures and their index; the freeze record and `frozen.json`.
