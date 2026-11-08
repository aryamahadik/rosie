// The geo double's world (T-439; C-220; K-17 v1 README "The double"): fixed points and zones for the test addresses.
//
// Its places are the master's sample cast and fixture set v1's demo shops: Lee Home Services' 1200 Main St and Alex's
// 42 Oak St in Springfield, Riverton (40 miles north of 1200 Main St, S12-07), and Lee's Barbershop's 123 Demo St,
// Anytown (fixture set v1 test-kit/shops); plus arch 05 line 237's ZIP code 02139 ("near 02139"), which the double
// places beside its Springfield. They are illustrations, not real geography (MC C6): the points are K-23 v1's
// illustrative seed points (POINT(-90 40), POINT(-90.2 40.1)) and their neighbours, every zone is America/New_York (the
// zone of every demo business in K-04 v1's and K-23 v1's seeds), and every state is MA (the lead's example for T-026's
// second round) except Anytown's town answer, which shows the null state. No real address, no one's personal data
// (rule 9).
//
// One entry per test address, asked by its kind and its text exactly as K-17 v1's answer fixture writes it; the double's
// tests check each entry against that fixture. Any other request is not found (not-found.json: "the mall").

import type { GeocodeKind, GeocodeMatch } from "./types";

export interface TestAddress {
  readonly kind: GeocodeKind;
  /** The words as K-17 v1's fixture types them; the double matches them exactly. */
  readonly text: string;
  /** The double's one match for them. */
  readonly match: GeocodeMatch;
  /** The K-17 v1 fixture (contracts/port-geo/fixtures/) whose answer this is. */
  readonly fixture: string;
}

/** Every demo business's zone in K-04 v1's and K-23 v1's seeds (CQ-08: the double gives a fixed zone per address). */
const ZONE = "America/New_York";
/** The double's one state, an illustration (K-17 v1 README "The double"). */
const STATE = "MA";

export const TEST_ADDRESSES: readonly TestAddress[] = [
  {
    // Flow B's travel centre at sign-up, the one Sam confirms (FS row L02; B4-77, S12-07): K-23 v1's POINT(-90 40).
    kind: "streetAddress",
    text: "1200 Main St, Springfield",
    match: {
      point: { lat: 40, lng: -90 },
      precision: "exact",
      normalizedAddress: "1200 Main St, Springfield",
      state: STATE,
      timeZone: ZONE,
    },
    fixture: "geocode-travel-centre.json",
  },
  {
    // Alex types his street address on the secure page (B4-30): about 2 miles from 1200 Main St.
    kind: "streetAddress",
    text: "42 Oak Street, Springfield",
    match: {
      point: { lat: 40.02, lng: -90.03 },
      precision: "exact",
      normalizedAddress: "42 Oak St, Springfield",
      state: STATE,
      timeZone: ZONE,
    },
    fixture: "geocode-street.json",
  },
  {
    // The demo shops' address (Lee's Barbershop's, fixture set v1): K-23 v1's POINT(-90.2 40.1), the business's map pin.
    kind: "streetAddress",
    text: "123 Demo St, Anytown",
    match: {
      point: { lat: 40.1, lng: -90.2 },
      precision: "exact",
      normalizedAddress: "123 Demo St, Anytown",
      state: STATE,
      timeZone: ZONE,
    },
    fixture: "geocode-demo-shop.json",
  },
  {
    // A partial match (B4-30): of this street address only the town is found, so it answers at town precision.
    kind: "streetAddress",
    text: "42 Oak St, Riverton",
    match: {
      point: { lat: 40.58, lng: -90 },
      precision: "town",
      normalizedAddress: "Riverton",
      state: STATE,
      timeZone: ZONE,
    },
    fixture: "geocode-street-partial.json",
  },
  {
    // The town in Alex's request, checked against the travel area before any times (B4-77).
    kind: "town",
    text: "Springfield",
    match: {
      point: { lat: 40.01, lng: -90 },
      precision: "town",
      normalizedAddress: "Springfield",
      state: STATE,
      timeZone: ZONE,
    },
    fixture: "geocode-town.json",
  },
  {
    // A town 40 miles north of 1200 Main St, outside Lee Home Services' 25 miles (S12-07, B4-31).
    kind: "town",
    text: "Riverton",
    match: {
      point: { lat: 40.58, lng: -90 },
      precision: "town",
      normalizedAddress: "Riverton",
      state: STATE,
      timeZone: ZONE,
    },
    fixture: "geocode-town-riverton.json",
  },
  {
    // A match whose state the provider gave none of (B4-30, B4-31): the key is there, its value null.
    kind: "town",
    text: "Anytown",
    match: {
      point: { lat: 40.1, lng: -90.2 },
      precision: "town",
      normalizedAddress: "Anytown",
      state: null,
      timeZone: ZONE,
    },
    fixture: "geocode-town-no-state.json",
  },
  {
    // A customer's request names a ZIP code (arch 05 line 237): placed beside Springfield, for distance search.
    kind: "zip",
    text: "02139",
    match: {
      point: { lat: 40.03, lng: -90.02 },
      precision: "zip",
      normalizedAddress: "02139",
      state: STATE,
      timeZone: ZONE,
    },
    fixture: "geocode-zip.json",
  },
];
