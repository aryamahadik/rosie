// T-726: the map points seed from the geo double, against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/seeds/setup-points`). Each top-level block with a database migrates a fresh test
// schema of its own (db/repo/test-db.ts), runs the core and setup seeds (T-200, T-213) where it needs their rows, and
// drops the schema at the end; the shared public schema is never touched.
//
// The card's proofs: every seeded location and flow B travel centre has a point and an IANA zone; every point comes from
// the geo double's fixture file (a test compares them: each stored point with the K-17 v1 fixture answer for its
// address, read here from contracts/port-geo/fixtures with node:fs, and with the double's own world and answer);
// re-running is idempotent. Each location's expected address is built here from the shop files themselves, never through
// the seed's own reader. The wrapping key the setup seed seals the owners' ID uploads with is made here from random bytes
// for each run and is never written to a file or printed. Bytes are changed only in temporary copies of fixtures/v1 in
// the OS temp folder. Every address here is fixture set v1's or one of K-17 v1's fixtures' (the master's sample cast and
// the demo shops), never a real one (rule 9); the points and zones are the double's illustrations (MC C6), so none is
// checked against a real map.
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createGeoDouble,
  type GeocodeMatch,
  type GeocodeOutcome,
  type GeoPoint,
  TEST_ADDRESSES,
} from "../../adapters/src/geo/double";
import { DEFAULT_WRAPPING_KEY_NAME, type WrappingKeys } from "../repo/sealing";
import { type Sql, withBusiness } from "../repo/scope";
import { createTestDatabase, type TestDatabase } from "../repo/test-db";
import { seedCore } from "./core";
import { FixtureAccessError, FixtureChecksumError, openFixtureSet } from "./lib/fixture-set";
import { DEMO_TRAVEL_MILES, seedSetupBusiness } from "./setup-business";
import {
  GEO_FIXTURES_DIR,
  type PointsSeedResult,
  pointOf,
  seedSetupPoints,
  seedSetupPointsFrom,
} from "./setup-points";

const SLOW = { timeout: 120_000 };
const REPO = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const V1 = path.join(REPO, "fixtures/v1");
const GEO_FIXTURES = path.join(REPO, GEO_FIXTURES_DIR);
const SHOPS = "test-kit/shops";
// One mile in metres: PostGIS measures geography in metres (K-23 README: travel_miles * 1609.344).
const MILE = 1609.344;
// The tables the setup seed and the core seed wrote, each in its key order.
const SNAPSHOT: readonly (readonly [string, string])[] = [
  ["businesses", "id"],
  ["business_setup", "business_id"],
  ["companies", "id"],
  ["company_kinds", "company_id, kind_id"],
  ["flow_defaults", "business_id, flow"],
  ["locations", "id"],
  ["staff", "id"],
  ["id_uploads", "id"],
  ["sealing_keys", "person_id"],
];

/** One wrapping key per run for the setup seed's ID uploads: random, in memory only, under the Workers secret's name. */
const WRAP_BYTES = crypto.getRandomValues(new Uint8Array(32));
const KEYS: WrappingKeys = {
  resolve: (name) => (name === DEFAULT_WRAPPING_KEY_NAME ? WRAP_BYTES : undefined),
};

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const sorted = (values: Iterable<string>): string[] => [...values].sort();
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8")) as unknown;

interface ShopFile {
  id: string;
  flows: Record<string, unknown>;
  google_prefill?: Record<string, string>;
}

interface Exchange {
  call: "geocode";
  request: { kind: string; text: string };
  outcome: GeocodeOutcome;
}

interface IndexEntry {
  file: string;
  version: string;
  def: string;
  expect: "accept" | "refuse";
}

/** The demo shop files of fixture set v1, read here: shop id (its file name) to the file, in code-point order of id. */
function shopFiles(): Map<string, ShopFile> {
  const shops = new Map<string, ShopFile>();
  const ids = readdirSync(path.join(V1, SHOPS))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length));
  for (const id of sorted(ids)) {
    shops.set(id, readJson(path.join(V1, SHOPS, `${id}.json`)) as ShopFile);
  }
  return shops;
}

/**
 * K-17 v1's accepted answer fixtures (found or not found; the error fixtures share their requests with answers), read
 * here from contracts/port-geo/fixtures: "<kind> <text>" to the fixture's file and outcome.
 */
function geoFixtures(): Map<string, { file: string; outcome: GeocodeOutcome }> {
  const index = (readJson(path.join(GEO_FIXTURES, "index.json")) as { fixtures: IndexEntry[] }).fixtures;
  const answers = new Map<string, { file: string; outcome: GeocodeOutcome }>();
  for (const entry of index) {
    if (entry.version !== "v1" || entry.def !== "geocode.exchange" || entry.expect !== "accept") {
      continue;
    }
    const exchange = readJson(path.join(GEO_FIXTURES, entry.file)) as Exchange;
    if (!("result" in exchange.outcome)) {
      continue;
    }
    const key = `${exchange.request.kind} ${exchange.request.text}`;
    if (answers.has(key)) {
      throw new Error(`two K-17 v1 fixtures answer ${entry.file}'s request`);
    }
    answers.set(key, { file: entry.file, outcome: exchange.outcome });
  }
  return answers;
}

const SHOP_FILES = shopFiles();
const GEO = geoFixtures();
const FIRST_SHOP = [...SHOP_FILES.keys()][0] ?? "";

/** The one match of a found answer. */
function onlyMatch(outcome: GeocodeOutcome | undefined): GeocodeMatch {
  if (outcome === undefined || !("result" in outcome) || outcome.result !== "found") {
    throw new Error("not a found answer");
  }
  const [match, ...others] = outcome.matches;
  if (match === undefined || others.length > 0) {
    throw new Error("not one match");
  }
  return match;
}

/** K-17 v1's fixture answer for a request, as its file and its one match. */
function fixtureAnswer(kind: string, text: string): { file: string; match: GeocodeMatch } {
  const answer = GEO.get(`${kind} ${text}`);
  if (answer === undefined) {
    throw new Error(`no K-17 v1 fixture answers a ${kind} request`);
  }
  return { file: answer.file, match: onlyMatch(answer.outcome) };
}

/** A demo listing value, "[G] <value> (demo)", as the value; null when the shop has no listing. */
function demoAddress(shop: ShopFile): string | null {
  const value = shop.google_prefill?.address;
  if (value === undefined) {
    return null;
  }
  const match = /^\[G\] (.+) \(demo\)$/.exec(value);
  if (match?.[1] === undefined) {
    throw new Error(`${shop.id}: its address is not a demo listing value`);
  }
  return match[1];
}

/** The listing address every demo shop gives; the shops with no listing take it (as the setup seed does). */
function sharedAddress(): string {
  const addresses = new Set(
    [...SHOP_FILES.values()].flatMap((shop) => {
      const address = demoAddress(shop);
      return address === null ? [] : [address];
    }),
  );
  if (addresses.size !== 1) {
    throw new Error("the demo shops do not give one listing address");
  }
  return [...addresses][0] ?? "";
}

/** The address of each shop's location, built here from the shop files: its listing's, or the shared one. */
const ADDRESS_OF = new Map(
  [...SHOP_FILES.values()].map((shop) => [shop.id, demoAddress(shop) ?? sharedAddress()]),
);
const flowsOf = (shop: ShopFile): string[] => ["A", "B"].filter((flow) => flow in shop.flows);

/** A point as PostGIS writes it in EWKT, built here from the fixture's degrees (longitude first). */
const ewktOf = (point: GeoPoint): string => `SRID=4326;POINT(${String(point.lng)} ${String(point.lat)})`;

/** True when the IANA time zone database (through the platform's Intl) knows the name, as it is written. */
function isIanaZone(zone: string): boolean {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone === zone;
  } catch {
    return false;
  }
}

interface PointRow {
  id: string;
  business_id: string;
  address: string;
  travel_miles: string | null;
  ewkt: string | null;
  lat: number | null;
  lng: number | null;
  srid: number | null;
  centre: string | null;
  own_centre: boolean;
  version: number;
  time_zone: string;
  zone_known: boolean;
}

/** Each location with its point, its travel area's centre, and its business's zone, by location id. */
async function pointRows(sql: Sql): Promise<Map<string, PointRow>> {
  const rows = await sql<PointRow[]>`
    select l.id, l.business_id, l.address, l.travel_miles::text as travel_miles,
      st_asewkt(l.map_point) as ewkt, st_y(l.map_point::geometry) as lat, st_x(l.map_point::geometry) as lng,
      st_srid(l.map_point) as srid,
      case when l.travel_miles is null then null else st_asewkt(coalesce(l.travel_centre, l.map_point)) end
        as centre,
      l.travel_centre is null as own_centre, l.version, b.time_zone,
      exists (select 1 from pg_timezone_names z where z.name = b.time_zone) as zone_known
    from locations l join businesses b on b.id = l.business_id
  `;
  return new Map(rows.map((row) => [row.id, row]));
}

/** Every row of the tables the core and setup seeds wrote, in key order, as plain arrays. */
async function snapshot(sql: Sql): Promise<Record<string, unknown[]>> {
  const tables: Record<string, unknown[]> = {};
  for (const [table, key] of SNAPSHOT) {
    tables[table] = [...(await sql.unsafe(`select * from ${table} order by ${key}`))];
  }
  return tables;
}

/** How many locations hold a map point. */
async function pointsHeld(sql: Sql): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(map_point)::int as n from locations`;
  return row?.n ?? -1;
}

/** What a refused call threw. */
async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("the seed ran; it should have refused");
}

interface Copy {
  root: string;
  fixtures: string;
  v1: string;
}

const copies: string[] = [];

/** A byte-for-byte copy of fixtures/v1 at <temp>/fixtures/v1. */
function copyOfFixtureSet(): Copy {
  const root = mkdtempSync(path.join(tmpdir(), "rosie-seed-points-"));
  copies.push(root);
  const fixtures = path.join(root, "fixtures");
  const v1 = path.join(fixtures, "v1");
  cpSync(V1, v1, { recursive: true });
  return { root, fixtures, v1 };
}

/**
 * Gives every shop listing of a copy one other address and rewrites their manifest lines, so the copy still matches its
 * manifest and the shops with no listing take the same address (the setup seed's shared address).
 */
function rewriteListings(copy: Copy, address: string): void {
  const sums = new Map<string, string>();
  for (const id of SHOP_FILES.keys()) {
    const relative = `${SHOPS}/${id}.json`;
    const file = path.join(copy.v1, relative);
    const shop = readJson(file) as { google_prefill?: Record<string, string> };
    if (shop.google_prefill === undefined) {
      continue;
    }
    shop.google_prefill.address = `[G] ${address} (demo)`;
    writeFileSync(file, `${JSON.stringify(shop, null, 1)}\n`);
    sums.set(relative, sha256(file));
  }
  const manifestFile = path.join(copy.v1, "MANIFEST.sha256");
  const lines = readFileSync(manifestFile, "utf8")
    .split("\n")
    .map((line) => {
      const listed = line.slice(66);
      const sum = sums.get(listed);
      return sum === undefined ? line : `${sum}  ${listed}`;
    });
  writeFileSync(manifestFile, lines.join("\n"));
}

/** Flips one bit of the byte in the middle of a file (doing it twice restores the file). */
function flipOneByte(file: string): void {
  const bytes = readFileSync(file);
  const at = Math.floor(bytes.length / 2);
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  writeFileSync(file, bytes);
}

function seedFromCopy(sql: Sql, copy: Copy): Promise<PointsSeedResult> {
  return seedSetupPointsFrom(sql, openFixtureSet(copy.v1, { jail: copy.fixtures }));
}

afterAll(() => {
  for (const root of copies) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("the points seed, loaded from the geo double after the core and setup seeds", () => {
  let db: TestDatabase;
  let before: Record<string, unknown[]>;
  let first: PointsSeedResult;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_points" });
    await seedCore(db.sql);
    await seedSetupBusiness(db.sql, { wrappingKeys: KEYS });
    before = await snapshot(db.sql);
    first = await seedSetupPoints(db.sql);
  }, 180_000);

  // Dropping a schema can pass the hook default while other builders load the database (a resource guard only).
  afterAll(async () => {
    await db.drop();
  }, 120_000);

  it("fills the map point of each of the 245 demo shop locations the setup seed left empty, and gives each of the 244 flow B travel areas its centre", () => {
    expect(SHOP_FILES.size).toBe(245);
    expect(first.locations).toEqual({ rows: 245, filled: 245, kept: 0 });
    expect(first.shops.map((shop) => shop.shopId)).toEqual([...SHOP_FILES.keys()]);
    const flowB = [...SHOP_FILES.values()].filter((shop) => flowsOf(shop).includes("B"));
    expect(flowB).toHaveLength(244);
    expect(first.shops.filter((shop) => shop.travelCentre !== null).map((shop) => shop.shopId)).toEqual(
      flowB.map((shop) => shop.id),
    );
    // The setup seed writes no centre of its own, so each travel area is centred on its location's own point (L02).
    expect(new Set(first.shops.flatMap((shop) => shop.travelCentre?.column ?? []))).toEqual(
      new Set(["map_point"]),
    );
    expect(first.ranAs).toBe("rosie_job");
  });

  it("takes every point from the geo double's fixture file: each stored point is the K-17 v1 fixture answer for its location's address, and the double's own world and answer", async () => {
    const rows = await pointRows(db.sql);
    expect(rows.size).toBe(245);
    const double = createGeoDouble();
    const fixtures = new Set<string>();
    for (const shop of SHOP_FILES.values()) {
      const address = ADDRESS_OF.get(shop.id) ?? "";
      const row = rows.get(`loc-demo-${shop.id}`);
      expect(row?.address, shop.id).toBe(address);
      // The fixture, read here from contracts/port-geo/fixtures, whose request is this address.
      const { file, match } = fixtureAnswer("streetAddress", address);
      fixtures.add(file);
      expect(match.precision, shop.id).toBe("exact");
      expect([row?.lat, row?.lng, row?.srid], shop.id).toEqual([match.point.lat, match.point.lng, 4326]);
      expect(row?.ewkt, shop.id).toBe(ewktOf(match.point));
      // The double's world holds the same point under the same fixture, and the double answers with it.
      const entry = TEST_ADDRESSES.find((test) => test.kind === "streetAddress" && test.text === address);
      expect([entry?.fixture, entry?.match], shop.id).toEqual([file, match]);
      expect(onlyMatch(await double.geocode({ kind: "streetAddress", text: address })), shop.id).toEqual(
        match,
      );
      // The seed's own record names the same fixture, point and zone.
      expect(first.shops.find((seeded) => seeded.shopId === shop.id)?.mapPoint, shop.id).toEqual({
        point: match.point,
        timeZone: match.timeZone,
        fixture: file,
      });
    }
    // Every demo shop gives 123 Demo St, Anytown, which the double places by geocode-demo-shop.json.
    expect(fixtures).toEqual(new Set(["geocode-demo-shop.json"]));
    const [distinct] = await db.sql<{ points: number }[]>`
      select count(distinct st_asewkt(map_point))::int as points from locations
    `;
    expect(distinct?.points).toBe(1);
  });

  it("gives every seeded location and flow B travel centre an IANA zone: the double's zone for its point, which is the zone its business row holds", async () => {
    const rows = await pointRows(db.sql);
    let centres = 0;
    for (const shop of SHOP_FILES.values()) {
      const { file, match } = fixtureAnswer("streetAddress", ADDRESS_OF.get(shop.id) ?? "");
      const row = rows.get(`loc-demo-${shop.id}`);
      // K-23 v1 holds no zone per location: the location's is its business's (K-04 businesses.time_zone), and it is
      // the double's zone for the point.
      expect([row?.business_id, row?.time_zone, row?.zone_known], shop.id).toEqual([
        `biz-demo-${shop.id}`,
        match.timeZone,
        true,
      ]);
      expect(isIanaZone(row?.time_zone ?? ""), shop.id).toBe(true);
      const seeded = first.shops.find((entry) => entry.shopId === shop.id);
      if (!flowsOf(shop).includes("B")) {
        expect([row?.travel_miles, row?.centre, seeded?.travelCentre], shop.id).toEqual([null, null, null]);
        continue;
      }
      centres += 1;
      // Each flow B travel area: the setup seed's miles around its centre, the location's own point, with the
      // business's zone.
      expect([row?.travel_miles, row?.own_centre, row?.centre], shop.id).toEqual([
        String(DEMO_TRAVEL_MILES),
        true,
        ewktOf(match.point),
      ]);
      expect(seeded?.travelCentre, shop.id).toEqual({
        column: "map_point",
        point: match.point,
        timeZone: match.timeZone,
        fixture: file,
      });
    }
    expect(centres).toBe(244);
    expect(new Set([...rows.values()].map((row) => row.time_zone))).toEqual(new Set(["America/New_York"]));
  });

  it("runs the travel-area check and distance search on the seeded rows in PostGIS (Q-25): the double's Springfield is inside every flow B shop's 25 miles and its Riverton outside, and every location is within 25 miles of its ZIP 02139", async () => {
    // Each place as K-17 v1's fixture answers it, and the double the same.
    const double = createGeoDouble();
    const place = async (kind: "town" | "zip", text: string): Promise<GeoPoint> => {
      const { match } = fixtureAnswer(kind, text);
      expect(onlyMatch(await double.geocode({ kind, text })), text).toEqual(match);
      return match.point;
    };
    // The travel check of K-23's README: inside when within travel_miles of coalesce(travel_centre, map_point).
    const travelCheck = async (point: GeoPoint): Promise<{ inside: number; areas: number } | undefined> => {
      const [row] = await db.sql<{ inside: number; areas: number }[]>`
        select count(*) filter (where st_dwithin(
            coalesce(travel_centre, map_point),
            st_setsrid(st_makepoint(${point.lng}::float8, ${point.lat}::float8), 4326)::geography,
            travel_miles::float8 * ${MILE}::float8))::int as inside,
          count(*)::int as areas
        from locations where travel_miles is not null
      `;
      return row;
    };
    expect(await travelCheck(await place("town", "Springfield"))).toEqual({ inside: 244, areas: 244 });
    expect(await travelCheck(await place("town", "Riverton"))).toEqual({ inside: 0, areas: 244 });
    // Distance search (arch 05 line 237, "within 10 mi · PostGIS"), here within 25 miles of the double's ZIP 02139.
    const zip = await place("zip", "02139");
    const [near] = await db.sql<{ n: number; miles: number }[]>`
      select count(*)::int as n,
        max(st_distance(map_point, st_setsrid(st_makepoint(${zip.lng}::float8, ${zip.lat}::float8), 4326)::geography))
          / ${MILE}::float8 as miles
      from locations
      where st_dwithin(map_point, st_setsrid(st_makepoint(${zip.lng}::float8, ${zip.lat}::float8), 4326)::geography,
        25 * ${MILE}::float8)
    `;
    expect(near?.n).toBe(245);
    expect(near?.miles).toBeGreaterThan(0);
    expect(near?.miles).toBeLessThan(25);
  });

  it("writes as the job role, rosie_job, with no scope, and changes only each location's map point and its version (raised once); under row-level security a shop's scope shows the Tool API role its own point only", async () => {
    expect(first.ranAs).toBe("rosie_job");
    const after = await snapshot(db.sql);
    for (const [table] of SNAPSHOT) {
      if (table !== "locations") {
        expect(after[table], table).toEqual(before[table]);
      }
    }
    const was = new Map((before.locations ?? []).map((row) => [(row as { id: string }).id, row]));
    expect(after.locations).toHaveLength(245);
    for (const row of after.locations ?? []) {
      const now = row as { id: string; map_point: unknown; version: number };
      expect(now.map_point, now.id).not.toBeNull();
      expect({ ...now, map_point: null, version: now.version - 1 }, now.id).toEqual(was.get(now.id));
      expect(now.version, now.id).toBe(2);
    }

    const barber = first.shops.find((shop) => shop.shopId === "barber");
    const seen = await withBusiness(db.sql, barber?.businessId ?? "", async (tx) => {
      await tx`set local role rosie_app`;
      return [
        ...(await tx<{ id: string; ewkt: string }[]>`select id, st_asewkt(map_point) as ewkt from locations`),
      ];
    });
    expect(seen).toEqual([
      {
        id: "loc-demo-barber",
        ewkt: ewktOf(fixtureAnswer("streetAddress", ADDRESS_OF.get("barber") ?? "").match.point),
      },
    ]);
  });

  it(
    "running the seed twice leaves the same rows: the second run fills nothing, keeps all 245, and every row and version stays as it was",
    SLOW,
    async () => {
      const held = await snapshot(db.sql);
      const second = await seedSetupPoints(db.sql);
      expect(second.locations).toEqual({ rows: 245, filled: 0, kept: 245 });
      expect(second.shops).toEqual(first.shops);
      expect(second.ranAs).toBe("rosie_job");
      expect(await snapshot(db.sql)).toEqual(held);
    },
  );

  it(
    "fills a point that went missing again, as the first run filled it, raising that row's version once, and changes nothing else",
    SLOW,
    async () => {
      const held = await snapshot(db.sql);
      const [yoga] = await db.sql<{ version: number }[]>`
        update locations set map_point = null, version = version + 1 where id = 'loc-demo-yoga' returning version
      `;
      const third = await seedSetupPoints(db.sql);
      expect(third.locations).toEqual({ rows: 245, filled: 1, kept: 244 });
      const after = await snapshot(db.sql);
      const bump = (rows: unknown[] | undefined): unknown[] =>
        (rows ?? []).map((row) => {
          const location = row as { id: string; version: number };
          return location.id === "loc-demo-yoga" ? { ...location, version: location.version + 2 } : location;
        });
      expect(after.locations).toEqual(bump(held.locations));
      expect({ ...after, locations: [] }).toEqual({ ...held, locations: [] });
      expect((await pointRows(db.sql)).get("loc-demo-yoga")?.version).toBe((yoga?.version ?? 0) + 1);
    },
  );

  it(
    "checks a travel centre of a location's own against the double: one at 1200 Main St, Springfield, at geocode-travel-centre.json's point, is kept and named; one at another point is refused, naming the location, and nothing is written",
    SLOW,
    async () => {
      const centre = fixtureAnswer("streetAddress", "1200 Main St, Springfield");
      expect(centre.file).toBe("geocode-travel-centre.json");
      const setCentre = async (point: GeoPoint | null): Promise<void> => {
        await db.sql`
          update locations set
            travel_centre = case when ${point === null}::boolean then null
              else st_setsrid(st_makepoint(${point?.lng ?? 0}::float8, ${point?.lat ?? 0}::float8), 4326)::geography end,
            travel_centre_address = case when ${point === null}::boolean then null else '1200 Main St, Springfield' end,
            version = version + 1
          where id = 'loc-demo-plumber'
        `;
      };
      await setCentre(centre.match.point);
      const kept = await seedSetupPoints(db.sql);
      expect(kept.locations).toEqual({ rows: 245, filled: 0, kept: 245 });
      expect(kept.shops.find((shop) => shop.shopId === "plumber")?.travelCentre).toEqual({
        column: "travel_centre",
        point: centre.match.point,
        timeZone: centre.match.timeZone,
        fixture: "geocode-travel-centre.json",
      });
      expect(kept.shops.filter((shop) => shop.shopId !== "plumber")).toEqual(
        first.shops.filter((shop) => shop.shopId !== "plumber"),
      );

      // The same centre at the double's Riverton, 40 miles north: refused, and an empty point elsewhere stays empty.
      await setCentre(fixtureAnswer("town", "Riverton").match.point);
      await db.sql`update locations set map_point = null, version = version + 1 where id = 'loc-demo-barber'`;
      const held = await snapshot(db.sql);
      const error = await refusal(seedSetupPoints(db.sql));
      expect(error.message).toContain(
        "1 of 245 locations hold a travel centre of their own at another point",
      );
      expect(error.message).toContain("(first: loc-demo-plumber)");
      expect(error.message).not.toContain("Main St");
      expect(await snapshot(db.sql)).toEqual(held);

      await setCentre(null);
      const restored = await seedSetupPoints(db.sql);
      expect(restored.locations).toEqual({ rows: 245, filled: 1, kept: 244 });
      expect(restored.shops).toEqual(first.shops);
    },
  );

  it(
    "refuses a location that holds another map point than the double's for its address, naming it, and writes nothing: the seed never overwrites a point",
    SLOW,
    async () => {
      const elsewhere = fixtureAnswer("town", "Springfield").match.point;
      await db.sql`
        update locations
        set map_point = st_setsrid(st_makepoint(${elsewhere.lng}::float8, ${elsewhere.lat}::float8), 4326)::geography,
          version = version + 1
        where id = 'loc-demo-yoga'
      `;
      await db.sql`update locations set map_point = null, version = version + 1 where id = 'loc-demo-barber'`;
      const held = await snapshot(db.sql);
      const error = await refusal(seedSetupPoints(db.sql));
      expect(error.message).toContain("1 of 245 locations hold a map point other than the geo double's");
      expect(error.message).toContain("(first: loc-demo-yoga)");
      expect(await snapshot(db.sql)).toEqual(held);
      expect(await pointsHeld(db.sql)).toBe(244);

      await db.sql`update locations set map_point = null, version = version + 1 where id = 'loc-demo-yoga'`;
      const restored = await seedSetupPoints(db.sql);
      expect(restored.locations).toEqual({ rows: 245, filled: 2, kept: 243 });
      const rows = await pointRows(db.sql);
      for (const shop of SHOP_FILES.values()) {
        const { match } = fixtureAnswer("streetAddress", ADDRESS_OF.get(shop.id) ?? "");
        expect(rows.get(`loc-demo-${shop.id}`)?.ewkt, shop.id).toBe(ewktOf(match.point));
      }
    },
  );
});

describe("before the points seed writes a point", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_points_checks" });
  }, 120_000);

  // Dropping a schema can pass the hook default while other builders load the database (a resource guard only).
  afterAll(async () => {
    await db.drop();
  }, 120_000);

  it(
    "refuses to run before the core seed and before the setup seed, naming the one to run first, and writes nothing",
    SLOW,
    async () => {
      const noCore = await refusal(seedSetupPoints(db.sql));
      expect(noCore.message).toContain("run db/seeds/core.ts first");
      expect(noCore.message).toContain("245 of 245 shops");

      await seedCore(db.sql);
      const noSetup = await refusal(seedSetupPoints(db.sql));
      expect(noSetup.message).toContain("run db/seeds/setup-business.ts first");
      expect(noSetup.message).toContain("245 of 245 shops");
      const [locations] = await db.sql<{ n: number }[]>`select count(*)::int as n from locations`;
      expect(locations?.n).toBe(0);

      await seedSetupBusiness(db.sql, { wrappingKeys: KEYS });
      expect(await pointsHeld(db.sql)).toBe(0);
    },
  );

  describe("with the core and setup seeds' rows in place", () => {
    it(
      "checks the whole set against MANIFEST.sha256 first: one changed byte in a shop file stops it",
      SLOW,
      async () => {
        const copy = copyOfFixtureSet();
        const changed = `${SHOPS}/barber.json`;
        flipOneByte(path.join(copy.v1, changed));
        const error = await refusal(seedFromCopy(db.sql, copy));
        expect(error).toBeInstanceOf(FixtureChecksumError);
        expect((error as FixtureChecksumError).problems).toEqual([`changed: ${changed}`]);
        expect(await pointsHeld(db.sql)).toBe(0);
      },
    );

    it(
      "refuses an intact copy of fixture set v1 that lies outside fixtures/, and writes nothing",
      SLOW,
      async () => {
        const copy = copyOfFixtureSet();
        const error = await refusal(seedSetupPoints(db.sql, { fixturesDir: copy.v1 }));
        expect(error).toBeInstanceOf(FixtureAccessError);
        expect(await pointsHeld(db.sql)).toBe(0);
      },
    );

    it(
      "refuses, naming the shop file, an address the geo double cannot place as the address itself, rather than guess: one it does not know (not found) and one it places only at town precision (a partial match)",
      SLOW,
      async () => {
        const cases: [string, string][] = [
          ["the mall", "(K-17 v1 notFound), and no point is guessed"],
          ["42 Oak St, Riverton", "only at town precision, a partial match"],
        ];
        for (const [address, words] of cases) {
          const copy = copyOfFixtureSet();
          rewriteListings(copy, address);
          const error = await refusal(seedFromCopy(db.sql, copy));
          expect(error, words).not.toBeInstanceOf(FixtureChecksumError);
          expect(error.message, words).toContain(`${SHOPS}/${FIRST_SHOP}.json: `);
          expect(error.message, words).toContain(words);
          expect(error.message, words).not.toContain(address);
        }
        expect(await pointsHeld(db.sql)).toBe(0);
      },
    );

    it(
      "refuses, naming the location, one that is not as the setup seed wrote it, or whose business's zone is not the double's for its point, and writes nothing",
      SLOW,
      async () => {
        const [yoga] = await db.sql<{ address: string; time_zone: string }[]>`
          select l.address, b.time_zone from locations l join businesses b on b.id = l.business_id
          where l.id = 'loc-demo-yoga'
        `;
        const address = yoga?.address ?? "";
        const zone = yoga?.time_zone ?? "";
        const setMiles = (miles: number | null): Promise<unknown> => db.sql`
          update locations set travel_miles = ${miles}::numeric, version = version + 1 where id = 'loc-demo-yoga'
        `;
        const setAddress = (text: string): Promise<unknown> => db.sql`
          update locations set address = ${text}, version = version + 1 where id = 'loc-demo-yoga'
        `;
        const setZone = (name: string): Promise<unknown> => db.sql`
          update businesses set time_zone = ${name}, version = version + 1 where id = 'biz-demo-yoga'
        `;
        const cases: [() => Promise<unknown>, () => Promise<unknown>, string, boolean][] = [
          [
            () => setMiles(null),
            () => setMiles(DEMO_TRAVEL_MILES),
            "the setup seed's locations (a travel area for flow B) are missing for 1 of 245 shops: run db/seeds/setup-business.ts first",
            false,
          ],
          [
            () => setAddress("1200 Main St, Springfield"),
            () => setAddress(address),
            "1 of 245 locations hold another address than the one the setup seed wrote from fixture set v1",
            true,
          ],
          [
            () => setZone("America/Chicago"),
            () => setZone(zone),
            "1 of 245 locations lie in another zone in the geo double than their business's (K-04 businesses.time_zone)",
            true,
          ],
        ];
        for (const [change, undo, words, namesIt] of cases) {
          await change();
          const error = await refusal(seedSetupPoints(db.sql));
          await undo();
          expect(error.message, words).toContain(words);
          expect(error.message.includes("(first: loc-demo-yoga)"), words).toBe(namesIt);
          expect(error.message, words).toContain("(nothing was written)");
          expect(error.message, words).not.toContain("Main St");
          expect(await pointsHeld(db.sql), words).toBe(0);
        }
      },
    );

    it(
      "loads from an untouched copy opened the same way, so each refusal above had its one reason",
      SLOW,
      async () => {
        const copy = copyOfFixtureSet();
        const result = await seedFromCopy(db.sql, copy);
        expect(result.ranAs).toBe("rosie_job");
        expect(result.locations).toEqual({ rows: 245, filled: 245, kept: 0 });
        expect(await pointsHeld(db.sql)).toBe(245);
      },
    );
  });
});

describe("the geo double's answer the seed keeps", () => {
  const source = `${SHOPS}/barber.json`;
  const what = "its location's address";
  const demoShop = fixtureAnswer("streetAddress", "123 Demo St, Anytown").match;
  const answerOf = (file: string): GeocodeOutcome =>
    (readJson(path.join(GEO_FIXTURES, file)) as Exchange).outcome;
  const found = (...matches: GeocodeMatch[]): GeocodeOutcome => ({ result: "found", matches });

  it("keeps one exact match, its point in WGS 84 degrees and its IANA zone (geocode-demo-shop.json)", () => {
    expect(pointOf(source, what, answerOf("geocode-demo-shop.json"))).toEqual({
      point: { lat: 40.1, lng: -90.2 },
      timeZone: "America/New_York",
    });
  });

  it("refuses an error, not found, several matches, a partial match, a point outside WGS 84 and a zone the IANA database does not know, naming the file and never the address, point or zone", () => {
    const cases: [GeocodeOutcome, string][] = [
      [
        answerOf("error-unavailable.json"),
        "could not place its location's address (K-17 v1 error unavailable)",
      ],
      [answerOf("not-found.json"), "has no point for its location's address (K-17 v1 notFound)"],
      [found(demoShop, demoShop), "gives 2 matches for its location's address, not one"],
      [found(), "gives 0 matches for its location's address, not one"],
      [answerOf("geocode-street-partial.json"), "places its location's address only at town precision"],
      [found({ ...demoShop, precision: "street" }), "only at street precision, a partial match"],
      [found({ ...demoShop, point: { lat: 91, lng: -90.2 } }), "is not in WGS 84 degrees"],
      [found({ ...demoShop, point: { lat: 40.1, lng: Number.NaN } }), "is not in WGS 84 degrees"],
      [found({ ...demoShop, timeZone: "America/Atlantis" }), "not one the IANA time zone database knows"],
    ];
    for (const [outcome, words] of cases) {
      let thrown: unknown;
      try {
        pointOf(source, what, outcome);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, words).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message.startsWith(`${source}: the geo double`), words).toBe(true);
      expect(message, words).toContain(words);
      for (const value of ["Demo St", "Anytown", "Riverton", "40.1", "-90.2", "Atlantis", "New_York"]) {
        expect(message, words).not.toContain(value);
      }
    }
  });
});
