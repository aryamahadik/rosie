// The Places double's world (T-434; C-218; K-15 v1 README "The double"): "a few fixed listings for the demo shops".
//
// Its listings are the master's sample cast and fixture set v1's demo shops: Lee's Barbershop LLC at 88 Elm St,
// Springfield (S1-09's read-back; SPEC-master 6; test-kit/shops/barber.json; S1-84's three photos), Lee Home Services
// LLC at 1200 Main St, Springfield (S1-38; SPEC-master 6; test-kit/shops/plumber.json) and the yoga studio at the demo
// shops' 123 Demo St, Anytown (test-kit/shops/yoga.json). They are illustrations, not real places, and no test checks
// one against Google. Their phones are the cast's listing numbers, kept in E.164 by their last four digits as K-23 v1's
// seed keeps them, both in the fiction range 555-0100 to 555-0199; the yoga studio's demo file names no number, so its
// phone is null. The website is the demo shops' reserved example.com. Listing and photo references are made up in
// K-08 v1's label form (places-demo-...). Never a rating, a review, an email or a map point; no real person's or real
// business's data (rule 9).
//
// One entry per listing, as its K-15 v1 details fixture holds it, and one per search K-15 v1 answers found, asked
// exactly as its fixture writes the request. The double's tests check every entry against its fixture. Any other
// search is noMatch (no-match.json: Test Mixed Shop A, which has no listing in fixture set v1), and any other
// reference notFound (details-not-found.json).

import type { HoursSpan, Listing, ListingRef, SearchRequest } from "./types";

export interface DemoListing {
  /** The listing as details gives it. */
  readonly listing: Listing;
  /** The K-15 v1 details fixture (contracts/port-places/fixtures/) whose answer this is. */
  readonly fixture: string;
}

export interface DemoSearch {
  /** The request exactly as K-15 v1's fixture writes it; the double matches it exactly. */
  readonly request: SearchRequest;
  /** The candidates' references, best first; each is one of DEMO_LISTINGS'. */
  readonly listingRefs: readonly ListingRef[];
  /** The K-15 v1 search fixture whose answer this is. */
  readonly fixture: string;
}

/** The demo shops' hours (test-kit/shops: "Mon-Fri 9am-5pm, Sat 10am-2pm (demo)"), as K-27 v1's ISO-day spans. */
const DEMO_HOURS: readonly HoursSpan[] = [
  { weekday: 1, opensAt: "09:00", closesAt: "17:00" },
  { weekday: 2, opensAt: "09:00", closesAt: "17:00" },
  { weekday: 3, opensAt: "09:00", closesAt: "17:00" },
  { weekday: 4, opensAt: "09:00", closesAt: "17:00" },
  { weekday: 5, opensAt: "09:00", closesAt: "17:00" },
  { weekday: 6, opensAt: "10:00", closesAt: "14:00" },
];

/** The demo shops' website (fixture set v1: "https://example.com (demo)"). */
const DEMO_WEBSITE = "https://example.com";

export const LEES_BARBERSHOP_REF = "places-demo-lees-barbershop";
export const LEE_HOME_SERVICES_REF = "places-demo-lee-home-services";
export const YOGA_STUDIO_REF = "places-demo-yoga-studio";

/** Each of S1-84's three photos is credited to the shop itself (K-15 v1 README: an example, not from the sources). */
const SHOP_CREDIT = [{ name: "Lee's Barbershop LLC", uri: null }] as const;

export const DEMO_LISTINGS: readonly DemoListing[] = [
  {
    listing: {
      listingRef: LEES_BARBERSHOP_REF,
      name: "Lee's Barbershop LLC",
      address: "88 Elm St, Springfield",
      phone: "+15555550177",
      website: DEMO_WEBSITE,
      openingHours: DEMO_HOURS,
      categories: ["Barber"],
      // S1-84: "[photo: The shop front] [photo: The chairs] [photo: A chair, ready]".
      photos: [
        { photoRef: `${LEES_BARBERSHOP_REF}/photos/shop-front`, authors: SHOP_CREDIT },
        { photoRef: `${LEES_BARBERSHOP_REF}/photos/chairs`, authors: SHOP_CREDIT },
        { photoRef: `${LEES_BARBERSHOP_REF}/photos/chair-ready`, authors: SHOP_CREDIT },
      ],
    },
    fixture: "details.json",
  },
  {
    // S1-38's second company, with its own listing; no photos, so S1-84 asks for the owner's own.
    listing: {
      listingRef: LEE_HOME_SERVICES_REF,
      name: "Lee Home Services LLC",
      address: "1200 Main St, Springfield",
      phone: "+15555550142",
      website: DEMO_WEBSITE,
      openingHours: DEMO_HOURS,
      categories: ["Plumber"],
      photos: [],
    },
    fixture: "details-lee-home-services.json",
  },
  {
    // The demo file names no number, so the listing shows no phone: the key is there, its value null.
    listing: {
      listingRef: YOGA_STUDIO_REF,
      name: "Yoga studio",
      address: "123 Demo St, Anytown",
      phone: null,
      website: DEMO_WEBSITE,
      openingHours: DEMO_HOURS,
      categories: ["Yoga studio"],
      photos: [],
    },
    fixture: "details-yoga-studio.json",
  },
];

export const DEMO_SEARCHES: readonly DemoSearch[] = [
  {
    // Registration screen 1, or S1-09 when a photo can't be read: the business's name and town.
    request: { by: "nameAndTown", name: "Lee's Barbershop", town: "Springfield" },
    listingRefs: [LEES_BARBERSHOP_REF],
    fixture: "search-by-name.json",
  },
  {
    // S1-09's sample: the name, address and phone read from Sam's photo of the shop front (K-02's card or listing kind).
    request: { by: "photoText", text: "Lee's Barbershop LLC, 88 Elm St, Springfield, (555) 010-0177" },
    listingRefs: [LEES_BARBERSHOP_REF],
    fixture: "search-by-photo-text.json",
  },
  {
    // A demo shop by name and town, whose one candidate shows no phone.
    request: { by: "nameAndTown", name: "Yoga studio", town: "Anytown" },
    listingRefs: [YOGA_STUDIO_REF],
    fixture: "search-yoga-studio.json",
  },
];
