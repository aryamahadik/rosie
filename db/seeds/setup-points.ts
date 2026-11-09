// T-726: the map points seed (C-155; K-17 v1 the geo port and K-23 v1 business setup, both frozen: contracts/port-geo,
// its README "The double", "The time zone (CQ-08)" and "Distance is never the port's", and
// contracts/db-schema/business-setup, its locations table and README "Locations and places"; the geo double, T-439,
// adapters/src/geo/double; QUESTIONS.md Q-25's default: the geo double meanwhile, PostGIS distance on stored points;
// build prompt rule 9). The setup seed (setup-business.ts, T-213) wrote each demo shop's location, loc-demo-<shop>, at
// its listing's address with its map point left empty (no geocoding there), and each flow B shop's travel area around
// it. This seed gives each of those locations its map point and zone from the geo double's fixed points, so distance
// search and the travel-area check (B4-77, S12-07) run on seeded rows:
//   map point      locations.map_point: the double's answer for the location's address, asked as K-17 v1's geocode
//                  call (kind streetAddress, the address as the setup seed wrote it), written where it is empty as
//                  ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography (K-17 README), raising the row's version by one
//                  (K-23 rule 3)
//   travel centre  each flow B location's travel area is centred on its own map point: the setup seed writes no centre
//                  of its own (travel_centre null, which K-23 reads as "map_point is the centre", FS row L02), so the
//                  point filled above is the centre's too. A centre of its own (travel_centre with its
//                  travel_centre_address) is never written here, only checked: it must be the double's point for its
//                  address, as geocode-travel-centre.json gives 1200 Main St, Springfield's
//   zone           each point's IANA zone is the double's answer's (CQ-08: the geo port returns each point's zone; the
//                  double gives a fixed zone per test address). K-23 v1 holds no zone per location or centre: a
//                  location's zone is its business's, K-04's businesses.time_zone (FS line 721; CQ-05: the business's
//                  zone, unless a visit's own address gives one), which the core seed set (Q-54). So each point's zone
//                  must be its business's: a point in any other zone is refused rather than stored where no row
//                  carries its zone
//
//   const result = await seedSetupPoints(sql);   // result.locations: { rows: 245, filled: 245, kept: 0 }
//
// What is read, and from where (rule 9): the locations, their addresses and flows through the setup seed's plan
// (setupPlanOf) of fixture set v1, checked against its manifest first, as every seed does (lib/fixture-set.ts); every
// point and zone from the geo double (world.ts's fixed points, each the answer of one K-17 v1 fixture, such as
// geocode-demo-shop.json for the demo shops' 123 Demo St, Anytown). The seed makes its own double and takes no geocoder,
// so no point comes from a live provider (T-440, J-17) and no address leaves the process; the double's spans are
// dropped. Nothing is printed, and no error names an address, a point or a zone.
//
// The double's answer is kept only when it places the address itself: found, one match, at exact precision (the
// address's own point, the map pin FS row B03 confirms), a point in WGS 84 degrees, and a zone the IANA database knows.
// Not found, several matches (B4-77 asks, never guesses), a partial match at a coarser precision (K-17: told apart by
// precision; B4-30's safe default keeps nothing until the address checks) or an error is refused, naming the shop file
// whose location asked, before anything is written.
//
// In order, stopping at the first failure: opens and checks fixture set v1; plans the setup seed's locations and asks the
// double once for each address; then, in one transaction as the job role rosie_job with no business scope (T-191),
// checks that the core seed's businesses (read FOR SHARE) and the setup seed's locations (read FOR UPDATE) are there,
// each location at the business, address and travel area the setup seed wrote, that each point's zone is its business's,
// and that every point or centre a location holds already is the double's; then fills each empty map point. No grant,
// policy or migration: rosie_job's UPDATE on locations is migration 0019's, behind its runtime policy.
//
// Idempotent: only an empty map point is written, and a location holding the double's point already is kept as it is,
// version included, so a second run writes nothing; a point that went missing is written again as the first run wrote
// it. A location holding any other point, or a centre of its own at another point than the double's for its address,
// is an error, and the transaction rolls back: the seed never overwrites a point and never keeps one the double did
// not give.
import {
  createGeoDouble,
  type GeocodeOutcome,
  type GeoPoint,
  TEST_ADDRESSES,
} from "../../adapters/src/geo/double";
import { SCOPE_SETTING, type Sql, type Tx } from "../repo/scope";
import { SEED_ROLE } from "./core";
import {
  type FixtureSet,
  openFixtureSet,
  type VerifiedFixtureSet,
  verifyFixtureSet,
} from "./lib/fixture-set";
import { type Flow, setupPlanOf } from "./setup-business";

/** What a location's address is to the geo port (K-17 v1 geocode.request kind). */
export const ADDRESS_KIND = "streetAddress";
/** The one precision kept: the address's own point (K-17 v1: a rooftop or parcel), the map pin FS row B03 confirms. */
export const PIN_PRECISION = "exact";
/** The folder of the K-17 v1 fixtures whose answers the double gives (each TEST_ADDRESSES entry names its file). */
export const GEO_FIXTURES_DIR = "contracts/port-geo/fixtures/";

/** A point the seed keeps: the double's answer for one address, and the K-17 v1 fixture that answer is. */
export interface SeededPoint {
  /** WGS 84 degrees (K-17 v1 point). */
  readonly point: GeoPoint;
  /** The point's IANA zone (CQ-08), which is its business's (K-04 businesses.time_zone). */
  readonly timeZone: string;
  /** The K-17 v1 fixture, under GEO_FIXTURES_DIR, whose answer the double gave (geocode-demo-shop.json, say). */
  readonly fixture: string;
}

/** The centre of a location's travel area (FS row L02). */
export interface SeededTravelCentre extends SeededPoint {
  /**
   * map_point: the location's own point is the centre (travel_centre null, as the setup seed writes every one);
   * travel_centre: a centre of its own, at its own address, checked against the double's point for that address.
   */
  readonly column: "map_point" | "travel_centre";
}

/** One entry per shop: its fixture file, its location, and the points the seed gave it or checked. */
export interface SeededPointsShop {
  readonly shopId: string;
  readonly source: string;
  readonly sha256: string;
  readonly businessId: string;
  readonly locationId: string;
  /** The flows the shop file has. */
  readonly flows: readonly Flow[];
  /** The location's map point. */
  readonly mapPoint: SeededPoint;
  /** The centre of the location's travel area, or null for a location with none (a shop with no flow B). */
  readonly travelCentre: SeededTravelCentre | null;
}

export interface PointsSeedCount {
  /** Locations the seed gives a map point: one per demo shop. */
  readonly rows: number;
  /** Empty map points this run filled. */
  readonly filled: number;
  /** Locations that held the double's point already, left as they were. */
  readonly kept: number;
}

export interface PointsSeedResult {
  /** The database role that wrote the rows (current_user inside the seed's transaction). */
  readonly ranAs: string;
  /** The fixture set that was checked: its folder, its manifest's sha256 and how many files the manifest lists. */
  readonly fixtureSet: {
    readonly dir: string;
    readonly manifestSha256: string;
    readonly filesChecked: number;
  };
  readonly locations: PointsSeedCount;
  /** One entry per shop, in code-point order of id. */
  readonly shops: readonly SeededPointsShop[];
}

export interface PointsSeedOptions {
  /** Fixture set v1's folder. Default fixtures/v1. Anything outside the repository's fixtures/ folder is refused. */
  fixturesDir?: string;
}

/** A location as planned: the setup seed's row, and the double's point for its address. */
interface PlannedLocation {
  readonly shopId: string;
  readonly source: string;
  readonly sha256: string;
  readonly businessId: string;
  readonly locationId: string;
  readonly flows: readonly Flow[];
  readonly address: string;
  /** Whether the setup seed gave it a travel area (a shop with flow B). */
  readonly travelArea: boolean;
  readonly mapPoint: SeededPoint;
}

/** A location as the database holds it, read FOR UPDATE inside the transaction. */
interface HeldLocation {
  readonly id: string;
  readonly business_id: string;
  readonly address: string;
  readonly travel_area: boolean;
  readonly map_lat: number | null;
  readonly map_lng: number | null;
  readonly centre_lat: number | null;
  readonly centre_lng: number | null;
  readonly centre_address: string | null;
}

/** Asks the double for the point of one address; the answer is checked (pointOf) and its K-17 v1 fixture named. */
type AskTheDouble = (source: string, what: string, text: string) => Promise<SeededPoint>;

/** True when the IANA time zone database (through the platform's Intl) knows the name, as it is written. */
function isIanaZone(zone: string): boolean {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone === zone;
  } catch {
    return false;
  }
}

/**
 * The point and zone kept from one answer of the geo double (see the top of this file): found, one match, at exact
 * precision, in WGS 84 degrees, with a zone the IANA database knows. Anything else is refused, naming `source` (the shop
 * file whose location asked) and `what` was placed, never the address, the point or the zone.
 */
export function pointOf(
  source: string,
  what: string,
  outcome: GeocodeOutcome,
): { point: GeoPoint; timeZone: string } {
  if ("error" in outcome) {
    throw new Error(
      `${source}: the geo double could not place ${what} (K-17 v1 error ${outcome.error}); stopping`,
    );
  }
  if (outcome.result === "notFound") {
    throw new Error(
      `${source}: the geo double has no point for ${what} (K-17 v1 notFound), and no point is guessed; stopping`,
    );
  }
  const [match, ...others] = outcome.matches;
  if (match === undefined || others.length > 0) {
    throw new Error(
      `${source}: the geo double gives ${String(outcome.matches.length)} matches for ${what}, not one, and the seed never picks one (B4-77); stopping`,
    );
  }
  if (match.precision !== PIN_PRECISION) {
    throw new Error(
      `${source}: the geo double places ${what} only at ${match.precision} precision, a partial match (K-17 v1), not the address's own point; stopping`,
    );
  }
  const { lat, lng } = match.point;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Error(`${source}: the geo double's point for ${what} is not in WGS 84 degrees; stopping`);
  }
  if (!isIanaZone(match.timeZone)) {
    throw new Error(
      `${source}: the geo double's zone for ${what} is not one the IANA time zone database knows; stopping`,
    );
  }
  return { point: { lat, lng }, timeZone: match.timeZone };
}

/**
 * A new geo double to ask, made here and never given: no point can come from a live geocoder. Each address is asked
 * once and its answer kept (K-17 README, "The call": a caller stores the answer rather than asking again).
 */
function askTheDouble(): AskTheDouble {
  const double = createGeoDouble();
  const answers = new Map<string, GeocodeOutcome>();
  return async (source, what, text) => {
    let outcome = answers.get(text);
    if (outcome === undefined) {
      outcome = await double.geocode({ kind: ADDRESS_KIND, text });
      answers.set(text, outcome);
    }
    const { point, timeZone } = pointOf(source, what, outcome);
    const entry = TEST_ADDRESSES.find((address) => address.kind === ADDRESS_KIND && address.text === text);
    if (entry === undefined) {
      throw new Error(`${source}: the geo double names no K-17 v1 fixture for ${what}; stopping`);
    }
    return { point, timeZone, fixture: entry.fixture };
  };
}

/** Plans each of the setup seed's locations with the double's point for its address, in the setup seed's order. */
async function pointsPlanOf(verified: VerifiedFixtureSet, ask: AskTheDouble): Promise<PlannedLocation[]> {
  const setup = setupPlanOf(verified);
  const locationOf = new Map(setup.rows.locations.map((row) => [row.id, row]));
  const planned: PlannedLocation[] = [];
  for (const shop of setup.seeded) {
    const location = locationOf.get(shop.locationId);
    if (location === undefined) {
      throw new Error(`${shop.source}: the setup seed's plan has no location for it`);
    }
    planned.push({
      shopId: shop.shopId,
      source: shop.source,
      sha256: shop.sha256,
      businessId: shop.businessId,
      locationId: shop.locationId,
      flows: shop.flows,
      address: location.address,
      travelArea: location.travel_miles !== null,
      mapPoint: await ask(shop.source, "its location's address", location.address),
    });
  }
  return planned;
}

/** Seeds the demo shops' map points and zones from the geo double (see the top of this file). */
export async function seedSetupPoints(sql: Sql, options: PointsSeedOptions = {}): Promise<PointsSeedResult> {
  return seedSetupPointsFrom(sql, openFixtureSet(options.fixturesDir));
}

/** The entry every seed set exports under one name, so a runner finds a set by its file name (T-201). */
export const seed = seedSetupPoints;

const missingMessage = (what: string, missing: number, of: number, unit: string, run: string): string =>
  `${what} are missing for ${String(missing)} of ${String(of)} ${unit}: run ${run} first (nothing was written)`;

/** Refuses when any location breaks a check, naming how many and the first one's id, never a value of its row. */
function refuseAny(locationIds: readonly string[], of: number, what: string): void {
  const [first] = locationIds;
  if (first !== undefined) {
    throw new Error(
      `${String(locationIds.length)} of ${String(of)} locations ${what} (first: ${first}); stopping (nothing was written)`,
    );
  }
}

const samePoint = (point: GeoPoint, lat: number | null, lng: number | null): boolean =>
  point.lat === lat && point.lng === lng;

/** A planned location with its row as the database holds it. */
interface Located {
  readonly location: PlannedLocation;
  readonly row: HeldLocation;
}

/**
 * Refuses to write before the core seed: every shop's business. Returns each business's zone, read FOR SHARE so it
 * stays as checked until the commit.
 */
async function requireCoreRows(tx: Tx, planned: readonly PlannedLocation[]): Promise<Map<string, string>> {
  const businesses = await tx<{ id: string; time_zone: string }[]>`
    select id, time_zone from businesses where id = any(${planned.map((location) => location.businessId)}::text[])
    for share
  `;
  const zoneOf = new Map(businesses.map((row) => [row.id, row.time_zone]));
  const noCore = planned.filter((location) => !zoneOf.has(location.businessId));
  if (noCore.length > 0) {
    throw new Error(
      missingMessage("the core seed's rows", noCore.length, planned.length, "shops", "db/seeds/core.ts"),
    );
  }
  return zoneOf;
}

/**
 * Refuses to write before the setup seed: every shop's location at its business, with a travel area for flow B. Each
 * row is read FOR UPDATE, as the database holds it now, and returned beside its plan.
 */
async function requireSetupRows(tx: Tx, planned: readonly PlannedLocation[]): Promise<Located[]> {
  const held = await tx<HeldLocation[]>`
    select id, business_id, address, travel_miles is not null as travel_area,
      st_y(map_point::geometry) as map_lat, st_x(map_point::geometry) as map_lng,
      st_y(travel_centre::geometry) as centre_lat, st_x(travel_centre::geometry) as centre_lng,
      travel_centre_address as centre_address
    from locations where id = any(${planned.map((location) => location.locationId)}::text[])
    for update
  `;
  const heldOf = new Map(held.map((row) => [row.id, row]));
  const located: Located[] = [];
  let noSetup = 0;
  for (const location of planned) {
    const row = heldOf.get(location.locationId);
    if (row?.business_id !== location.businessId || (location.travelArea && !row.travel_area)) {
      noSetup += 1;
    } else {
      located.push({ location, row });
    }
  }
  if (noSetup > 0) {
    throw new Error(
      missingMessage(
        "the setup seed's locations (a travel area for flow B)",
        noSetup,
        planned.length,
        "shops",
        "db/seeds/setup-business.ts",
      ),
    );
  }
  return located;
}

/** seedSetupPoints, from a fixture set already opened (tests open a temporary copy of the set inside its own jail). */
export async function seedSetupPointsFrom(sql: Sql, set: FixtureSet): Promise<PointsSeedResult> {
  const verified = verifyFixtureSet(set);
  const ask = askTheDouble();
  const planned = await pointsPlanOf(verified, ask);
  const total = planned.length;

  const written = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${SEED_ROLE}`);
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    const [who] = await tx<{ role: string }[]>`select current_user as role`;
    const zoneOf = await requireCoreRows(tx, planned);
    const located = await requireSetupRows(tx, planned);
    const ids = (pairs: readonly Located[]): string[] => pairs.map(({ location }) => location.locationId);

    refuseAny(
      ids(located.filter(({ location, row }) => row.address !== location.address)),
      total,
      "hold another address than the one the setup seed wrote from fixture set v1, so the geo double's point is not theirs",
    );
    refuseAny(
      ids(located.filter(({ location }) => zoneOf.get(location.businessId) !== location.mapPoint.timeZone)),
      total,
      "lie in another zone in the geo double than their business's (K-04 businesses.time_zone), and K-23 v1 holds no zone of a location's own",
    );
    refuseAny(
      ids(
        located.filter(
          ({ location, row }) =>
            row.map_lat !== null && !samePoint(location.mapPoint.point, row.map_lat, row.map_lng),
        ),
      ),
      total,
      "hold a map point other than the geo double's for their address, which the seed never overwrites",
    );

    // Each travel area's centre: the location's own point, or a centre of its own, which must be the double's point
    // for its address, in the business's zone.
    const shops: SeededPointsShop[] = [];
    const centreElsewhere: string[] = [];
    const centreOtherZone: string[] = [];
    for (const { location, row } of located) {
      let travelCentre: SeededTravelCentre | null = null;
      if (row.centre_address !== null) {
        const centre = await ask(location.source, "its travel centre's address", row.centre_address);
        if (!samePoint(centre.point, row.centre_lat, row.centre_lng)) {
          centreElsewhere.push(location.locationId);
        }
        if (zoneOf.get(location.businessId) !== centre.timeZone) {
          centreOtherZone.push(location.locationId);
        }
        travelCentre = { column: "travel_centre", ...centre };
      } else if (row.travel_area) {
        travelCentre = { column: "map_point", ...location.mapPoint };
      }
      shops.push({
        shopId: location.shopId,
        source: location.source,
        sha256: location.sha256,
        businessId: location.businessId,
        locationId: location.locationId,
        flows: location.flows,
        mapPoint: location.mapPoint,
        travelCentre,
      });
    }
    refuseAny(
      centreElsewhere,
      total,
      "hold a travel centre of their own at another point than the geo double's for its address",
    );
    refuseAny(
      centreOtherZone,
      total,
      "hold a travel centre of their own in another zone than their business's (K-04 businesses.time_zone)",
    );

    // Only the empty map points are filled; the version is raised once for each row written (K-23 rule 3).
    const empty = located.filter(({ row }) => row.map_lat === null).map(({ location }) => location);
    const filled =
      empty.length === 0
        ? { count: 0 }
        : await tx`
            update locations as l
            set map_point = st_setsrid(st_makepoint(v.lng, v.lat), 4326)::geography, version = l.version + 1
            from unnest(
              ${empty.map((location) => location.locationId)}::text[],
              ${empty.map((location) => location.mapPoint.point.lng)}::float8[],
              ${empty.map((location) => location.mapPoint.point.lat)}::float8[]
            ) as v (id, lng, lat)
            where l.id = v.id and l.map_point is null
          `;
    return { ranAs: who?.role ?? "", filled: filled.count, shops };
  });

  return {
    ranAs: written.ranAs,
    fixtureSet: {
      dir: verified.dir,
      manifestSha256: verified.manifestSha256,
      filesChecked: verified.filesChecked,
    },
    locations: { rows: total, filled: written.filled, kept: total - written.filled },
    shops: written.shops,
  };
}
