# port-places (K-15): the Google Places port

**Status: v1, frozen** (`frozen.json`: `{"frozen": ["v1"]}`). Written and frozen by T-024. The freeze takes effect when T-024 merges, and the merge waits for every review below (build prompt 6.2, 6.5).

## Freeze record

Frozen v1, 2026-11-13, reviews required: integrations engineer, action-layer engineer, frontend engineer.

Each reviewer checks its own side (02-contracts section 1): the integrations engineer that C-218's adapter and its double can fill every field from Google's Place and write both spans (C-218 Google Places); the action-layer engineer that the Tool API's listing lookup and the setup steps can take what the port gives (K-09 v1 `lookupListing` and `SetupS1_09`; S1-09's read-back, S1-21's hours, S1-84's photos, and S1-76 on no match); the frontend engineer what registration screens 1 and 2 show and confirm (C-187: B01, B03, B04, B05 [G]), which reach the port through K-21 and K-09. The lead also asked the security reviewer (DL-738: a listing carries a business's phone, and the port names a key). The lead records the freeze in `ops/DECISIONS.md` and on the board (build prompt 5.7).

**Owner:** the architect. **Schema:** `port-places.v1.schema.json` (JSON Schema 2020-12, `$id` `https://rosie.invalid/contracts/port-places/port-places.v1.schema.json`). **Checked by:** `npm run contracts:check`. **Contract test:** `tests/contract/port-places.v1.test.ts` (QA, T-094). A change after the freeze is a new minor version file, `port-places.v1.1.schema.json`, with new fixtures (build prompt 6.4); the frozen-contract guard fails any edit to v1's schema, its fixtures or their index entries.

## What it defines

Two calls (02-contracts K-15), each with `<call>.request`, `<call>.response`, `<call>.errors` and `<call>.exchange` under `$defs`:

- **search**: a business's name and town, or the text read from a photo of its card, sign or listing (S1-09), in; up to five candidates, best first, each with the fields S1-09's read-back shows (name, address, phone, website), or `noMatch`.
- **details**: a listing's reference in; the listing's fields, offered as prefill the owner confirms (FS section 10): name, address, phone, website, opening hours, categories and photos; or `notFound`.

The other definitions:

- `listingRef`, `listingName`, `listingAddress`, `phone` and `website`: the fields both calls share. `candidate` is one search result; `listing` is what details gives.
- `hoursSpan`: one open span of a day, in K-27 v1's `weekly_hours` shape. `photo` and `photoAuthor`: a photo's reference and its credits. `searchText`: the words a search is asked with.
- `placesError` (`error`: `unavailable`, `rateLimited` or `badRequest`, with `retryAfterSeconds`), which `search.errors` and `details.errors` name.
- `search.span` and `details.span`: the K-08 v1 `portCall` spans the calls write, each with a closed list of what it got and decided.

The root is any one exchange or span, so the type generator writes a type for each. Field names are camelCase, as K-09's calls spell them; the spans keep K-08's snake_case. Every field's `description` names its source.

### The calls (02-contracts section 2 item 2)

- **Repeating either is safe:** a read with no side effect. Google bills each request at the highest SKU among the fields it asks for [P9], so the adapter's field mask asks only for the fields here, never a rating or a review.
- **Primary or replica:** neither; an outside call through C-218. Each try is one K-08 span with its `attempt`; retries follow arch 10 line 540 for the turn or page request that calls it.
- **Time budget:** no source gives one, and K-09 v1's `lookupListing` names none either; the calling stage's budget applies (open gaps).
- **Key:** each call needs one secret, Google Places' API key, which Google takes in the `X-Goog-Api-Key` header, with the field mask in `X-Goog-FieldMask` [P3], [P4]. Whether a key exists, and under which Google Cloud project and billing, is Q-24 (J-16, Jay's). Its name is the CTO's and the release engineer's when it lands, and it is never held here (contracts README convention 9). The double needs none.

### When each call is made

- **search:** at S1-09, from the text read from the owner's photo or, when a photo can't be read, from the business's name and town ("A photo that can't be read: Rosie asks for the business name"); at S1-38 for each company after the first ("Its own company: its own listing"); and on registration screen 1 ("search the Google listing, or send a photo of a card or sign"). The Tool API's `lookupListing` (K-09 v1) calls it and adds its own `alreadyOnRosie`.
- **details:** when a step offers the listing's prefill, by the reference a search gave: S1-21's hours ("Hours · From your Google listing"), S1-84's photos, and the categories (FS section 10). Its answers are prefill: the owner confirms each one before anything is kept (FS section 10), and the listing is never kept as read (the spike, "What may be kept").

## The spike: Google Places' public documents (02-contracts K-15)

Read on 2026-11-13, for T-024, through a summarizing fetch of Google's public pages (DL-066), with no key, no request to the API and no account. None of the pages showed its own "last updated" date through the fetch. The pages, cited by their ids here and in the schema:

- [P1] The Place resource (Places API (New) reference): https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places
- [P2] Place data fields (New), with each field's SKU: https://developers.google.com/maps/documentation/places/web-service/data-fields
- [P3] Text Search (New): https://developers.google.com/maps/documentation/places/web-service/text-search
- [P4] Place Details (New): https://developers.google.com/maps/documentation/places/web-service/place-details
- [P5] Place IDs: https://developers.google.com/maps/documentation/places/web-service/place-id
- [P6] Places API policies: https://developers.google.com/maps/documentation/places/web-service/policies
- [P7] Place Photos (New): https://developers.google.com/maps/documentation/places/web-service/place-photos
- [P8] Place types (New): https://developers.google.com/maps/documentation/places/web-service/place-types
- [P9] Usage and billing: https://developers.google.com/maps/documentation/places/web-service/usage-and-billing

### A listing never carries an email

The Place resource has no email field: it lists phone numbers (`nationalPhoneNumber`, `internationalPhoneNumber`) and `websiteUri`, and no email [P1]; the data fields page lists none [P2]; neither Text Search nor Place Details mentions one [P3], [P4]. So a listing read through this port never gives an email (`refuse-email-in-listing.json`).

What follows (02-contracts K-15: "with none, S1-75 takes Q-02's default"): S1-75 proves control by "a code by call, text or email to the public listing's own phone or email". Calls and texts to the listing are out of scope (MC C9; C-252), and this port gives no email, so from the listing alone S1-75 always takes Q-02's no-email branch: "Rosie's team checks within 1 business day and that company stays offline with its setup saved", which is also S1-75's safe default. Registration screen 7 (FS section 6.1) takes the same branch. K-09 v1's `SetupS1_09.listingEmail` and K-23 v1's `business_setup.listing_email` have no source in this port; whether an email from somewhere else (the business's website, its card) may count as "the listing's own email" is a new question (open gaps).

### The listing's fields

Which Google field fills each port field, with its SKU for Place Details and Text Search from [P2]:

- `listingRef`: the Place's `id` [P1] (Essentials IDs Only for both).
- `name`: `displayName.text`, "The localized name of the place" (Pro).
- `address`: `formattedAddress`, "A full, human-readable address for this place" (Essentials for details, Pro for search).
- `phone`: `internationalPhoneNumber`, "in international format", written in E.164 by the adapter (Enterprise). `nationalPhoneNumber` is the national form, which never crosses the port (`refuse-phone-national-form.json`).
- `website`: `websiteUri`, "The authoritative website for this place, e.g. a business' homepage" (Enterprise).
- `openingHours`: `regularOpeningHours.periods`, "in chronological order, in the place-local timezone" (Enterprise); below, "Opening hours".
- `categories`: `primaryTypeDisplayName.text`, "The display name of the primary type, localized" (Pro). The other `types` are tags from Google's type tables [P8], such as `barber_shop` (Table A, "Services"), Google's own values, which never cross the port. A place has "a single primary type", which "may be missing" [P8], so from Google the list holds one name or none.
- `photos`: each photo's `name` and `authorAttributions` (Essentials IDs Only for details, Pro for search); at most 10 a place [P7].

Never asked for and never in the port: `rating` and `userRatingCount` (Enterprise) and `reviews` (Enterprise + Atmosphere), since "Ratings and reviews from Google are not used" (FS section 10; `refuse-reviews-field.json`, `refuse-rating-field.json`); `location`, the map point, since the geo port places the confirmed address (K-17; FS row B03) and Google lets coordinates be cached for only 30 days [P6]; `editorialSummary`, whose "Summary text must be presented as-is and can not be modified or altered" [P1], so it cannot be the draft S1-84 lets the owner change (open gaps).

The fields Rosie needs put each request in Google's Enterprise SKU: phone, website and opening hours are Enterprise fields [P2], and a request is billed at its highest SKU [P9]. Billing must be enabled on the project, and every request carries an API key [P9]. This is Q-24's question for Jay (the project and its billing); the port does not change with the answer.

### What may be kept (Google's policies)

- **The listing's reference may be kept:** "You can therefore store place ID values indefinitely" [P6]; place ids may change, and Google "recommends refreshing place IDs if they are more than 12 months old", free with a details request for the id alone; "The NOT_FOUND status code indicates that the specified place ID is obsolete" [P5], which details answers as `notFound`.
- **A photo's reference is never kept:** "You cannot cache a photo name. Also, the name can expire" [P7]. It is used within the setup that read it.
- **The rest is prefill, never kept as read:** the policies allow caching or storing Google Maps content "only as expressly permitted", and bar copying and saving business names and addresses beyond that [P6]. Rosie keeps what the owner confirms as their own business's details (FS section 10: "The owner confirms each field"), never the listing's answer itself. Whether that is enough under Google's terms, and whether a listing photo may be kept at all, is a new question (open gaps).
- **Credits:** "You must always credit the author when displaying photos or reviews" [P6]; for a photo, "you must include the additional attribution in your application wherever you display the image" [P7]. So each photo carries its `authors`, for whoever shows it.

### What the pages leave open (unverified)

- What Text Search answers when nothing matches: the page shows a `places` array and does not say [P3]. The adapter reads an empty or missing list as `noMatch`.
- Google's error answers: no Places page listing them was found (https://developers.google.com/maps/documentation/places/web-service/error-messages answered 404). Only NOT_FOUND for an obsolete id is documented [P5]. Whether a rate limit carries a Retry-After is unverified; `retryAfterSeconds` is null without one.
- The characters of a place id: the pages give only examples (letters, digits, - and _) and say "there is no maximum length" [P5]. `listingRef` takes K-08's label form, which those examples fit.
- What `formattedAddress` holds for a business that only visits its customers (`pureServiceAreaBusiness`: "a business that visits or delivers to customers directly but does not serve customers at their business address" [P1]): whether it is a street address, an area or absent is not said (open gaps).

## Opening hours

Each span is one open stretch of one day, in K-27 v1's `weekly_hours` shape, so the owner's yes can keep it as it is: `weekday` an ISO day, 1 Monday to 7 Sunday; `opensAt` and `closesAt` local times of day, HH:MM, `closesAt` later on the same day, with 24:00 for midnight. `null` means the listing shows no hours; a list holds at least one span. The adapter's rules from Google's periods [P1]:

- Google's day is 0 Sunday to 6 Saturday; the port's Sunday is 7. Google's own `open` and `close` points never cross the port (`refuse-vendor-hours.json`).
- A period that closes on the next day at 00:00 closes at 24:00 on its own day; one that runs past midnight is two spans, one on each day (K-27: "A span past midnight is two rows").
- "If a place is always open (24 hours), the close field will not be set", with an open at day 0, 00:00 [P1]: seven spans, 00:00 to 24:00.
- Only the regular hours: special days, secondary hours and the current week's hours are not read (FS section 10 offers the opening hours).

That `opensAt` comes before `closesAt`, and that no two spans of a day overlap, is the contract test's check (a schema cannot compare two fields).

## Not found, no match and errors

- **No match** (`no-match.json`): no listing matched; an answer, never an error. S1-09's "No match, or already listed" takes S1-76: Rosie's team checks within 1 business day, setup goes on saved, and nothing goes live meanwhile. Rosie "never says who else listed it" (FS section 10).
- **Already on Rosie** is the Tool API's flag (K-09 v1 `alreadyOnRosie`, for S1-76), told by the listing's reference; the port never knows it.
- **Not found** (`details-not-found.json`): the provider knows no such listing, an unknown or obsolete reference [P5]; an answer, never an error. The caller searches again, or the owner types the details (S1-09).
- **Errors** say the call failed, so nothing is known about the listing: `unavailable` (the provider failed, timed out or refused the key), `rateLimited` (with any Retry-After, arch 10 line 540) or `badRequest` (the provider refused the request itself). The safe default meanwhile is S1-09's "No photo? Type the details, or say them on a call", which K-09 v1's `placesUnavailable` gives.

## No name, address, phone or words in a span or log

The listing's name, address, phone, website, hours, categories and photo credits, and the request's name, town and photo text, never enter a span or a log line (K-08 v1, "never the raw number or words"; arch 02 diagram line 105: full detail only in sealed traces). The listing's phone is a business's public number, not a person's mobile, and still a phone number; a photo's credit may name a person. The calls' spans are K-08 v1's `portCall` hop with provider `google_places` and call `search` or `details`, which K-08's list already holds. Each closes what it got and decided:

- `search.span`: got the step and `searchBy` (`nameAndTown` or `photoText`); decided `candidates` (0 to 5) and the best candidate's `listing` reference. K-08 v1's own example, `span-places-call.json`, is this span, word for word (`span-search.json`).
- `details.span`: got the step and the `listing` reference asked; decided `result` (`found` or `notFound`) and how many `photos`.

So even a one-word town, which K-08 alone would take as a label, is refused (`refuse-town-in-span.json`). An error's code is the span's `error_code`, with `outcome` failed or timedOut, and no `decided`.

## What the caller does, never the port

- **Banned words:** the port gives the listing's words as they are. The caller hides any word a profession bans before anything is shown, and tells the owner and Rosie's team (S1-09: "The listing's words are checked against words the plug-in says are never used ... Such a word is never shown"; S13-11; FS section 10).
- **The match:** whether "the listing matches what they sent" (S1-09's "An owner; the listing matches") is the Tool API's and the owner's call, never the port's.
- **The listing's phone stays the business's:** customers book through Rosie's one number (D102), and the listing's number is never suggested as the owner's sign-in (S1-10; FS section 10).
- **The map pin** comes from the geo port, which geocodes the confirmed address (K-17; FS row B03).

## The double (02-contracts K-15; C-218)

"A few fixed listings for the demo shops." Its world is the master's sample cast and fixture set v1's demo shops; its listings are illustrations, not real places, and no test may check one against Google.

- `places-demo-lees-barbershop`: Lee's Barbershop LLC, 88 Elm St, Springfield, +15555550177, https://example.com; Monday to Friday 09:00 to 17:00 and Saturday 10:00 to 14:00; the category Barber; three photos, each credited to the shop (`search-by-name.json`, `search-by-photo-text.json`, `details.json`). Sources: S1-09's read-back; SPEC-master 6; `test-kit/shops/barber.json`; S1-84's three photos; K-23 v1's seed.
- `places-demo-lee-home-services`: Lee Home Services LLC, 1200 Main St, Springfield, +15555550142, https://example.com; the same hours; the category Plumber; no photos (`details-lee-home-services.json`). Sources: S1-38; SPEC-master 6; `test-kit/shops/plumber.json`.
- `places-demo-yoga-studio`: Yoga studio, 123 Demo St, Anytown, no phone (the demo file names no number), https://example.com; the same hours; the category Yoga studio; no photos (`search-yoga-studio.json`, `details-yoga-studio.json`). Sources: `test-kit/shops/yoga.json`; K-04 v1's seed.

How a test drives the double:

- **A search:** the double answers a request equal to an accepted answer fixture's request (exactly, as written there) with that fixture's outcome; any other search answers `noMatch` (`no-match.json`: the test shop with no listing in fixture set v1), never an error.
- **Details:** the reference of one of its three listings answers `found` with that listing, as its details fixture holds it; any other reference answers `notFound` (`details-not-found.json`).
- **An error:** the test sets the double, before the call, to fail its next call with an error fixture's outcome (`error-unavailable.json`, `error-rate-limited.json`, or `badRequest`); that call returns the error and writes its span with the error code, and later calls answer as before. The setting is the double's test-only option, never a field of the port's request. The error fixtures' requests are the calls a test makes with that setting on: they share theirs with `search-by-name.json` and `details.json`, which answer them when it is off.
- **Spans:** the double writes each call's span as the adapter would.

Phone numbers are the cast's listing numbers, (555) 010-0177 and (555) 010-0142, kept in E.164 by their last four digits as +15555550177 and +15555550142, as K-23 v1's seed and README keep them; both are in the fiction range 555-0100 to 555-0199. The website is the demo shops' reserved `example.com`. Listing and photo references are made up in K-08 v1's form (`places-demo-...`, as K-08 v1's `span-places-call.json` names Lee's Barbershop).

K-09 v1's `listing-lookup.json`, written before this freeze, shows a stand-in candidate the double does not give (`places-double-lees-barbershop`, +15555550111, `leesbarbershop.example`, the name without LLC). It stays as it is (frozen); a Tool API test that replays it gives its own port answer, and one that runs against the double reads the double's (open gaps).

## Producers and consumers (02-contracts K-15)

- **Producer:** integrations engineer: C-218 Google Places, its adapter and its double.
- **Consumers:** action-layer engineer: the Tool API's `lookupListing` (K-09 v1; S1-09, S1-38, S1-76) and the setup steps that take the listing's prefill (K-09 v1 `SetupS1_09`; S1-21's hours; S1-84's photos); frontend engineer: C-187 registration screens 1 and 2 (find and confirm the business: B01, B03, B04, B05 [G]), through K-21 and K-09. The AI engineer's photo reading (C-120, K-02's next minor version, now v1.3) forms the photo text a search takes (02-contracts K-02: "the card fixture's search text is a valid K-15 search request").
- **Builds on it:** the Places adapter against its double (C-218), and S1-09 in M4.
- **Contract test** (QA, its own task, T-094): `tests/contract/port-places.v1.test.ts`: the fixtures against the schema, refused ones refused; the double gives exactly the exchange fixtures' answers for their requests, `noMatch` for any other search and `notFound` for any other reference; the adapter (on recorded vendor samples, once J-16 lands) gives port-level answers the schema accepts; every span the double and the adapter write passes `search.span` or `details.span`. What the schema leaves to the test: each opening-hours span opens before it closes and no two spans of a day overlap; candidates come best first; `decided.candidates` is the number of candidates and `decided.listing` the first one's reference; `decided.photos` is the number of photos; in the double, a found listing's reference is the one asked; no log line holds a name, address, phone, town, photo text or photo credit.

## Fixtures (`fixtures/`, listed in `fixtures/index.json`)

Accepted: `search-by-name.json`, `search-by-photo-text.json`, `details.json`, `no-match.json` (the four 02-contracts K-15 lists); `search-yoga-studio.json` (a candidate with no phone); `details-lee-home-services.json` (S1-38's second company, no photos); `details-yoga-studio.json`; `details-not-found.json`; `error-unavailable.json`, `error-rate-limited.json`; `span-search.json` (`search.span`, K-08 v1's own example) and `span-details.json` (`details.span`). Refused, in `fixtures/invalid/`: `refuse-reviews-field.json` (the one 02-contracts K-15 lists), `refuse-rating-field.json`, `refuse-email-in-listing.json`, `refuse-phone-national-form.json`, `refuse-vendor-hours.json`, `refuse-town-in-span.json`. Each refused fixture is an accepted one with one fault, and is that accepted fixture once the fault is removed (the reviews, the rating or the email dropped; +15555550177 for the national form; the same hours as spans; the town dropped from the span), checked 2026-11-13 by comparing each with its twin.

Names and values come from the master's sample cast and fixture set v1's demo shops (Sam; Riley; Lee's Barbershop LLC at 88 Elm St, Springfield; Lee Home Services LLC at 1200 Main St, Springfield; the yoga studio and the demo shops' 123 Demo St, Anytown, their hours, categories and website; Test Mixed Shop A, which has no listing; S1-84's three photos), never a real person or a real listing (rule 9). These are examples, not from the sources: the listing and photo references, the photo credits (the shop's own name), the Retry-After of 30 seconds, and one review's words in the refused fixture. Span ids follow K-08 v1's fixtures, with bundle v0's id (K-01 `bundle-v0-skeleton.json`).

## Defaults used (T-024)

1. **Q-02:** the port gives no email (the spike), so from the listing alone S1-75 takes Q-02's no-email branch: Rosie's team checks within 1 business day, and that company stays offline with its setup saved.
2. **Q-24:** the Places double meanwhile (J-16: no key, project or billing yet); the fields are those Google's public documents give.
3. **The phone in E.164,** as K-23 v1 and K-09 v1 keep it; the cast's numbers kept by their last four digits, as K-23 v1's seed keeps them.
4. **At most five candidates, best first,** as K-09 v1's `lookupListing` returns (`maxItems` 5).
5. **Opening hours in K-27 v1's shape** (ISO days, local HH:MM, 24:00 for midnight, a span past midnight split in two), with `null` when the listing shows none; only the regular hours.
6. **Categories as words, primary first;** Google's type tags never cross the port, so from Google the list holds one name or none.
7. **Photos as references with their credits,** used within the setup that read them and never kept; no call fetches a photo's image in v1.
8. **No match and not found are answers,** never errors; three errors, as K-17 v1 has them.
9. **Prefill only:** the caller keeps what the owner confirms and the listing's reference, never the listing as read.
10. **The adapter's fit rules:** a result with no name or no formatted address is not a candidate, since it cannot be read back (S1-09), and details answers `notFound` for one; a phone that does not form an E.164 number is `null`; a website that is not an http or https URL is `null`.
11. **US listings in English,** as the cast's are: the adapter asks Google for the region US and the language English.

## Open gaps

- **Q-24 (J-16):** the key, its Google Cloud project and its billing are Jay's. Every request is in Google's Enterprise SKU, since phone, website and hours are Enterprise fields [P2], [P9]; the adapter asks for no other field. The key's name comes with it.
- **New (S1-75's email):** no listing email comes from this port (the spike). Does an email from somewhere else (the business's website, its card) count as "the listing's own email"? Default 1 until Jay rules. K-23 v1's seed holds `shop@example.com` as an example, which this port cannot give.
- **New (keeping what the listing gives):** Google's policies bar keeping its content beyond what its terms permit [P6]. Rosie keeps the owner's confirmed answers and the listing's reference (default 9). Whether that is enough, and whether a listing photo may be kept and shown at all (S1-84 "picks a few photos from the website or listing"; K-23 v1 `business_photos.came_from` listing), and with which credit, is for the CTO with Jay's counsel (J-20). Meanwhile S1-84 has its own path: "Send a few photos from your phone".
- **New (a photo's image):** v1 gives references only. Fetching an image is Place Photos' media call, whose key rides in the URL's query string [P7], so that URL is never logged. It is a minor version with S1-84's task, after the question above.
- **New (already on Rosie):** S1-76's "already on Rosie" needs the listing's reference kept with each business. K-09 v1's `SetupS1_09` carries `listingRef`, but no frozen database part has a column for it (K-23 v1's `business_setup` has none). A new task for the architect: a K-23 minor version.
- **New (About us from the listing):** S1-84 drafts About us "from your Google listing". v1 freezes no description: Google's `editorialSummary` must be "presented as-is and can not be modified or altered" [P1], so it cannot be a draft the owner changes. The draft comes from the website (B05: "read to draft B06 and B07") and the fields here.
- **New (a business that only visits its customers):** whether Google's `formattedAddress` gives a street address, an area or nothing for such a business is unverified [P1]. v1 passes what Google gives, which the owner confirms or fixes (S1-09); with none, default 10 leaves it out, and S1-76's review follows on no match.
- **New (K-09 v1's stand-in):** `listing-lookup.json` (K-09 v1) shows a candidate the double does not give (section "The double"). Nothing changes in K-09; its tests use their own port answer.
- **New (time budget):** no source gives the calls a time budget; the calling stage's budget applies (arch 04 "Latency budget targets").
- **New (coverage and language):** v1 assumes US listings in English (default 11).
- **Unverified on Google's pages:** the empty search's answer, the error answers and any Retry-After, and the place id's characters (section "What the pages leave open"). The adapter's own spike, with recorded samples once J-16 lands, records them; the port does not change.

## Change log

- v1, 2026-11-13 (T-024): first version, frozen: search's and details' requests, responses, errors and exchanges, their K-08 spans; the fixtures and their index; the spike's findings from Google's public documents; the freeze record and `frozen.json`.
