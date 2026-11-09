// T-213: the setup seed from fixture set v1, against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/seeds/setup-business`). Each top-level block migrates a fresh test schema of its own
// (db/repo/test-db.ts), runs the core seed (T-200) where it needs the core rows, and drops the schema at the end; the
// shared public schema is never touched.
//
// The card's proofs: 245 shops with business fields and at least one location; flow B shops have a travel area; every
// value traces to a fixture set v1 file; map points stay empty unless the fixture gives one; re-running is idempotent.
// Each expected row is built here, column by column, from the fixture files themselves (node:fs and node:crypto), never
// through the seed's own reader, and compared with the whole row the database holds. The wrapping key that seals the
// owners' ID uploads is made here from random bytes for each run and is never written to a file or printed. Bytes are
// changed only in temporary copies of fixtures/v1 in the OS temp folder.
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_WRAPPING_KEY_NAME, SealingError, unsealText, type WrappingKeys } from "../repo/sealing";
import { type Sql, withBusiness } from "../repo/scope";
import { createTestDatabase, type TestDatabase } from "../repo/test-db";
import { seedCore } from "./core";
import { FixtureAccessError, FixtureChecksumError, openFixtureSet } from "./lib/fixture-set";
import {
  DEMO_ID_CONTENT_TYPE,
  DEMO_ID_OBJECT_KEY_PREFIX,
  DEMO_TRAVEL_MILES,
  type SetupSeedResult,
  seedSetupBusiness,
  seedSetupBusinessFrom,
} from "./setup-business";

const SLOW = { timeout: 120_000 };
const V1 = path.resolve(fileURLToPath(new URL("../../fixtures/v1", import.meta.url)));
const SHOPS = "test-kit/shops";
const TABLES = [
  "business_setup",
  "companies",
  "company_kinds",
  "flow_defaults",
  "locations",
  "staff",
  "id_uploads",
  "sealing_keys",
] as const;
const PER_SHOP = ["business_setup", "companies", "locations", "staff", "id_uploads", "sealing_keys"] as const;
const EMPTY = Object.fromEntries(TABLES.map((table) => [table, 0]));
const TEST_MIXED = ["test-mixed-A", "test-mixed-B"];
// The fields test-kit.js writes into every demo shop's google_prefill; none is a map point.
const PREFILL_FIELDS = ["address", "business name", "category", "hours", "phone", "photos", "website"];
// The sealed form (db/repo/sealing.ts): format byte 0x01, a 12-byte IV, the ciphertext and a 16-byte tag.
const SEAL_OVERHEAD = 29;

/** One wrapping key per run: random, in memory only, under the Workers secret's name. */
const WRAP_BYTES = crypto.getRandomValues(new Uint8Array(32));
const KEYS: WrappingKeys = {
  resolve: (name) => (name === DEFAULT_WRAPPING_KEY_NAME ? WRAP_BYTES : undefined),
};
const NO_KEYS: WrappingKeys = { resolve: () => undefined };

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const sorted = (values: Iterable<string>): string[] => [...values].sort();

interface ShopFile {
  id: string;
  name: string;
  flows: Record<string, unknown>;
  google_prefill?: Record<string, string>;
  facts?: string[];
  switches?: Record<string, boolean | Record<string, boolean>>;
  settings?: { arrive?: unknown; cutoff?: unknown };
}

/** fixtures/v1/MANIFEST.sha256, read here: path to sha256. */
function manifest(): Map<string, string> {
  const listed = new Map<string, string>();
  for (const line of readFileSync(path.join(V1, "MANIFEST.sha256"), "utf8").split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      listed.set(match[2], match[1]);
    }
  }
  return listed;
}

/** The demo shop files of fixture set v1, read here: shop id (its file name) to the file. */
function shopFiles(): Map<string, ShopFile> {
  const shops = new Map<string, ShopFile>();
  for (const file of readdirSync(path.join(V1, SHOPS)).filter((name) => name.endsWith(".json"))) {
    shops.set(
      file.slice(0, -".json".length),
      JSON.parse(readFileSync(path.join(V1, SHOPS, file), "utf8")) as ShopFile,
    );
  }
  return shops;
}

const SHOP_FILES = shopFiles();
const LISTED = manifest();

/** A demo listing value, "[G] <value> (demo)", as the value; null when the shop has no listing. */
function demoValue(shop: ShopFile, field: string): string | null {
  const value = shop.google_prefill?.[field];
  if (value === undefined) {
    return null;
  }
  const match = /^\[G\] (.+) \(demo\)$/.exec(value);
  if (match?.[1] === undefined) {
    throw new Error(`${shop.id}: ${field} is not a demo listing value`);
  }
  return match[1];
}

/** Whether a shop is one profession: its owner form is listed (forms/<id>.json). */
const hasForm = (id: string): boolean => LISTED.has(`forms/${id}.json`);
const flowsOf = (shop: ShopFile): string[] => ["A", "B"].filter((flow) => flow in shop.flows);
const perFlow = (setting: unknown, flow: string): unknown =>
  typeof setting === "object" && setting !== null && ("A" in setting || "B" in setting)
    ? (setting as Record<string, unknown>)[flow]
    : setting;

/** The listing address every demo shop gives; the shops with no listing take it (K-23's own seed does the same). */
function sharedAddress(): string {
  const addresses = new Set(
    [...SHOP_FILES.values()].flatMap((shop) => {
      const address = demoValue(shop, "address");
      return address === null ? [] : [address];
    }),
  );
  expect(addresses.size).toBe(1);
  return [...addresses][0] ?? "";
}

/** A shop's facts: its own list, or for insurance cpa's (Master Corrections C5). */
function factsOf(shop: ShopFile): string[] {
  const facts = shop.facts ?? [];
  if (facts.length === 0 && shop.id === "insurance") {
    return SHOP_FILES.get("cpa")?.facts ?? [];
  }
  return facts;
}

/** The switches the file turns on in a flow. */
function switchesOn(shop: ShopFile, flow: string): string[] {
  return Object.entries(shop.switches ?? {}).flatMap(([name, value]) =>
    value === true || (typeof value === "object" && value[flow] === true) ? [name] : [],
  );
}

/** A flow's arrival setting as the file gives it: none starts at window (SPEC-prof.md line 127; MC C5). */
function arriveOf(shop: ShopFile, flow: string): string {
  const value = perFlow(shop.settings?.arrive, flow);
  if (value === undefined || value === "window") {
    return "window";
  }
  if (value === "setstart") {
    return "setstart";
  }
  if (typeof value === "object" && value !== null && "window" in value) {
    return "window";
  }
  throw new Error(`${shop.id}: an arrival setting this test does not know`);
}

/** A flow's free-cancel time as the file gives it, in the two forms K-23 holds; null for none or one not held. */
function cutoffOf(
  shop: ShopFile,
  flow: string,
): { before_seconds: number | null; day_before_at: string | null } | null | "not held" {
  const text = perFlow(shop.settings?.cutoff, flow);
  if (text === undefined || text === null) {
    return null;
  }
  if (typeof text !== "string") {
    throw new Error(`${shop.id}: a free-cancel time that is not words`);
  }
  const span = /^(\d+) (hours?|days?) before$/.exec(text);
  if (span?.[1] !== undefined && span[2] !== undefined) {
    const unit = span[2].startsWith("hour") ? 3600 : 86_400;
    return { before_seconds: Number(span[1]) * unit, day_before_at: null };
  }
  const clock = /^(\d+)(am|pm) the day (before|of)$/.exec(text);
  if (clock?.[1] !== undefined && clock[2] !== undefined) {
    if (clock[3] === "of") {
      return "not held";
    }
    const hour = (Number(clock[1]) % 12) + (clock[2] === "pm" ? 12 : 0);
    return { before_seconds: null, day_before_at: `${String(hour).padStart(2, "0")}:00:00` };
  }
  throw new Error(`${shop.id}: a free-cancel time this test does not know`);
}

/**
 * When fixture set v1 was made: line 3 of test-kit/COVERAGE.md, Eastern time (fixtures/v1/README.md), turned into an
 * instant by PostgreSQL (the seed does it with Intl). The text cast keeps the client from parsing the wall time itself.
 */
async function fixtureSetMade(sql: Sql): Promise<Date> {
  const line = readFileSync(path.join(V1, "test-kit/COVERAGE.md"), "utf8").split("\n")[2] ?? "";
  const match = /^Generated \w{3} (\w{3}) (\d{2}) (\d{4}) (\d{2}):(\d{2}) from /.exec(line);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = String(months.indexOf(match?.[1] ?? "") + 1).padStart(2, "0");
  const local = `${match?.[3] ?? ""}-${month}-${match?.[2] ?? ""} ${match?.[4] ?? ""}:${match?.[5] ?? ""}`;
  const [row] = await sql<{ at: Date }[]>`
    select (${local}::text::timestamp at time zone 'America/New_York') as at
  `;
  return row?.at ?? new Date(Number.NaN);
}

async function rowCounts(sql: Sql): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
    counts[table] = row?.n ?? -1;
  }
  return counts;
}

/** Every row of the eight tables the seed writes, in key order, as plain arrays. */
async function snapshot(sql: Sql): Promise<Record<string, unknown[]>> {
  return {
    business_setup: [...(await sql`select * from business_setup order by business_id`)],
    companies: [...(await sql`select * from companies order by id`)],
    company_kinds: [...(await sql`select * from company_kinds order by company_id, kind_id`)],
    flow_defaults: [...(await sql`select * from flow_defaults order by business_id, flow`)],
    locations: [...(await sql`select * from locations order by id`)],
    staff: [...(await sql`select * from staff order by id`)],
    id_uploads: [...(await sql`select * from id_uploads order by id`)],
    sealing_keys: [...(await sql`select * from sealing_keys order by person_id`)],
  };
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

/** Whether two byte strings are the same bytes. */
const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/** Whether `needle` appears anywhere inside `haystack`. */
function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((byte, index) => haystack[start + index] === byte)) {
      return true;
    }
  }
  return false;
}

interface Copy {
  root: string;
  fixtures: string;
  v1: string;
}

const copies: string[] = [];

/** A byte-for-byte copy of fixtures/v1 at <temp>/fixtures/v1. */
function copyOfFixtureSet(): Copy {
  const root = mkdtempSync(path.join(tmpdir(), "rosie-seed-setup-"));
  copies.push(root);
  const fixtures = path.join(root, "fixtures");
  const v1 = path.join(fixtures, "v1");
  cpSync(V1, v1, { recursive: true });
  return { root, fixtures, v1 };
}

/** Rewrites one shop of a copy and its manifest line, so the copy still matches its manifest. */
function rewriteShop(copy: Copy, id: string, change: (shop: Record<string, unknown>) => void): void {
  const relative = `${SHOPS}/${id}.json`;
  const file = path.join(copy.v1, relative);
  const shop = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  change(shop);
  writeFileSync(file, `${JSON.stringify(shop, null, 1)}\n`);
  const manifestFile = path.join(copy.v1, "MANIFEST.sha256");
  const lines = readFileSync(manifestFile, "utf8")
    .split("\n")
    .map((line) => (line.endsWith(`  ${relative}`) ? `${sha256(file)}  ${relative}` : line));
  writeFileSync(manifestFile, lines.join("\n"));
}

/** Flips one bit of the byte in the middle of a file (doing it twice restores the file). */
function flipOneByte(file: string): void {
  const bytes = readFileSync(file);
  const at = Math.floor(bytes.length / 2);
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  writeFileSync(file, bytes);
}

function seedFromCopy(sql: Sql, copy: Copy, wrappingKeys: WrappingKeys = KEYS): Promise<SetupSeedResult> {
  return seedSetupBusinessFrom(sql, openFixtureSet(copy.v1, { jail: copy.fixtures }), { wrappingKeys });
}

afterAll(() => {
  for (const root of copies) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("the setup seed, loaded from fixture set v1 after the core seed", () => {
  let db: TestDatabase;
  let first: SetupSeedResult;
  let seededAt: Date;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_setup" });
    await seedCore(db.sql);
    first = await seedSetupBusiness(db.sql, { wrappingKeys: KEYS });
    seededAt = await fixtureSetMade(db.sql);
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  it("seeds 245 shops: the 243 demo shops and test-mixed-A and -B, each with one company, one location, the owner's staff row and ID upload", () => {
    expect(SHOP_FILES.size).toBe(245);
    expect([...SHOP_FILES.keys()].filter(hasForm)).toHaveLength(243);
    for (const table of PER_SHOP) {
      expect(first.tables[table], table).toEqual({ rows: 245, inserted: 245, kept: 0 });
    }
    expect(first.tables.company_kinds).toEqual({ rows: 243, inserted: 243, kept: 0 });
    expect(first.shops.map((shop) => shop.shopId)).toEqual(sorted(SHOP_FILES.keys()));
  });

  it("gives each business its fields: the listing's website, no money through Rosie for the nomoney professions (M02), the rest empty until the owner gives them", async () => {
    const rows = await db.sql<Record<string, unknown>[]>`select * from business_setup order by business_id`;
    expect(rows).toHaveLength(245);
    const expected = [...SHOP_FILES.values()]
      .map((shop) => ({
        business_id: `biz-demo-${shop.id}`,
        listing_phone: null,
        listing_email: null,
        website: demoValue(shop, "website"),
        about: null,
        profile_confirmed_at: null,
        stripe_account_id: null,
        no_money: factsOf(shop).includes("nomoney"),
        terms_accepted_at: null,
        terms_accepted_by_person_id: null,
        control_proven_at: null,
        control_proven_via: null,
        version: 1,
      }))
      .sort((a, b) => (a.business_id < b.business_id ? -1 : 1));
    expect(sorted(rows.map((row) => String(row.business_id)))).toEqual(
      expected.map((row) => row.business_id),
    );
    const byId = new Map(rows.map((row) => [String(row.business_id), row]));
    for (const row of expected) {
      expect(byId.get(row.business_id), row.business_id).toEqual(row);
    }
    // The demo website, from every demo shop's listing; none for the two test-mixed shops, which have no listing.
    expect(new Set(rows.map((row) => row.website))).toEqual(new Set(["https://example.com", null]));
    expect(rows.filter((row) => row.no_money === true).map((row) => row.business_id)).toEqual([
      "biz-demo-realtor",
      "biz-demo-senior-living",
    ]);
  });

  it("gives each business one company, named as the shop and owned by its owner, and each of the 243 professions its kind of work with the file's facts and the switches on in each flow", async () => {
    const companies = await db.sql<Record<string, unknown>[]>`select * from companies order by id`;
    expect(companies).toHaveLength(245);
    const companyOf = new Map(companies.map((row) => [String(row.business_id), row]));
    const kinds = await db.sql<Record<string, unknown>[]>`select * from company_kinds order by company_id`;
    expect(kinds).toHaveLength(243);
    const kindOf = new Map(kinds.map((row) => [String(row.business_id), row]));
    for (const shop of SHOP_FILES.values()) {
      const businessId = `biz-demo-${shop.id}`;
      expect(companyOf.get(businessId), shop.id).toEqual({
        id: `company-demo-${shop.id}`,
        owner_person_id: `person-demo-${shop.id}-owner`,
        name: shop.name,
        business_id: businessId,
        version: 1,
      });
      if (!hasForm(shop.id)) {
        expect(TEST_MIXED).toContain(shop.id);
        expect(kindOf.has(businessId), shop.id).toBe(false);
        continue;
      }
      expect(kindOf.get(businessId), shop.id).toEqual({
        company_id: `company-demo-${shop.id}`,
        kind_id: shop.id,
        business_id: businessId,
        trade_name: null,
        pf_facts: factsOf(shop),
        pf_switches_a: switchesOn(shop, "A"),
        pf_switches_b: switchesOn(shop, "B"),
        version: 1,
      });
    }
    // MC C5: insurance, whose trade gives no facts, has cpa's list; the shop files' own switches reach the kinds.
    expect(kindOf.get("biz-demo-insurance")?.pf_facts).toEqual(["forms", "firststeps", "documents", "video"]);
    expect(kindOf.get("biz-demo-plumber")).toMatchObject({
      pf_switches_a: [],
      pf_switches_b: ["cancelright"],
    });
  });

  it("gives every shop at least one location: a shop at the listing's address, with its map point left empty; every flow B shop has a travel area around it", async () => {
    const rows = await db.sql<Record<string, unknown>[]>`select * from locations order by id`;
    expect(rows).toHaveLength(245);
    const address = sharedAddress();
    const locationOf = new Map(rows.map((row) => [String(row.business_id), row]));
    let flowB = 0;
    for (const shop of SHOP_FILES.values()) {
      const hasB = flowsOf(shop).includes("B");
      flowB += hasB ? 1 : 0;
      expect(locationOf.get(`biz-demo-${shop.id}`), shop.id).toEqual({
        id: `loc-demo-${shop.id}`,
        business_id: `biz-demo-${shop.id}`,
        kind: "shop",
        name: null,
        address: demoValue(shop, "address") ?? address,
        map_point: null,
        end_address: null,
        travel_miles: hasB ? String(DEMO_TRAVEL_MILES) : null,
        travel_centre: null,
        travel_centre_address: null,
        travel_fee_cents: null,
        travel_fee_currency: null,
        version: 1,
      });
    }
    expect(flowB).toBe(244);
    const [areas] = await db.sql<{ shops: number; points: number }[]>`
      select count(*) filter (where travel_miles > 0 and kind in ('shop', 'office'))::int as shops,
        count(*) filter (where map_point is not null or travel_centre is not null)::int as points
      from locations
    `;
    expect(areas).toEqual({ shops: 244, points: 0 });
    // No shop file gives a map point: the demo listing holds only the seven fields test-kit.js writes.
    for (const shop of SHOP_FILES.values()) {
      if (shop.google_prefill !== undefined) {
        expect(sorted(Object.keys(shop.google_prefill)), shop.id).toEqual(PREFILL_FIELDS);
      }
      expect(JSON.stringify(shop), shop.id).not.toMatch(
        /"(?:lat|lng|lon|latitude|longitude|map[ _]?(?:pin|point))"/i,
      );
    }
  });

  it("gives each flow its free-cancel time and arrival setting as the file's settings say, and none where the file gives no free-cancel time or one K-23 cannot hold", async () => {
    interface FlowDefault {
      business_id: string;
      flow: string;
      before_seconds: number | null;
      day_before_at: string | null;
      arrive: string;
      version: number;
    }
    const rows = await db.sql<FlowDefault[]>`
      select business_id, flow, extract(epoch from cutoff_before)::int as before_seconds,
        cutoff_day_before_at::text as day_before_at, arrive, version
      from flow_defaults order by business_id, flow
    `;
    const expected: FlowDefault[] = [];
    const notHeld: string[] = [];
    for (const shop of SHOP_FILES.values()) {
      if (!hasForm(shop.id)) {
        continue;
      }
      for (const flow of flowsOf(shop)) {
        const cutoff = cutoffOf(shop, flow);
        if (cutoff === "not held") {
          notHeld.push(`${shop.id} ${flow}`);
        } else if (cutoff !== null) {
          expected.push({
            business_id: `biz-demo-${shop.id}`,
            flow,
            ...cutoff,
            arrive: arriveOf(shop, flow),
            version: 1,
          });
        }
      }
    }
    const key = (row: { business_id: string; flow: string }): string => `${row.business_id} ${row.flow}`;
    // The 486 flows of the 243 professions, less the 44 with no free-cancel time, the 11 flows A whose file gives
    // one for flow B only, and the 13 it gives on the day itself.
    expect(rows).toHaveLength(418);
    expect(first.tables.flow_defaults).toEqual({ rows: 418, inserted: 418, kept: 0 });
    expect(sorted(rows.map(key))).toEqual(sorted(expected.map(key)));
    const rowOf = new Map(rows.map((row) => [key(row), row]));
    for (const row of expected) {
      expect(rowOf.get(key(row)), key(row)).toEqual(row);
    }
    // The 13 flows whose free-cancel time is a clock time on the day itself ("7am the day of") are named, not guessed.
    expect(notHeld).toHaveLength(13);
    expect(
      sorted(first.shops.flatMap((shop) => shop.cutoffsNotHeld.map((flow) => `${shop.shopId} ${flow.flow}`))),
    ).toEqual(sorted(notHeld));
    expect(new Set(first.shops.flatMap((shop) => shop.cutoffsNotHeld.map((flow) => flow.words)))).toEqual(
      new Set(["7am the day of"]),
    );
    // Spot checks against the files' words: 24 hours; 2 days; 6pm the day before; 8pm the day before with a window of
    // 2 hours, which is a window (dog-walker.json: "B": { "window": 2 }).
    expect(rowOf.get("biz-demo-barber A")).toMatchObject({ before_seconds: 86_400, arrive: "setstart" });
    expect(rowOf.get("biz-demo-architect B")).toMatchObject({ before_seconds: 172_800 });
    expect(rowOf.get("biz-demo-makeup B")).toMatchObject({ before_seconds: null, day_before_at: "18:00:00" });
    expect(rowOf.get("biz-demo-dog-walker B")).toMatchObject({
      before_seconds: null,
      day_before_at: "20:00:00",
      arrive: "window",
    });
    // MC C5's twelve trades with no settings, and trades with no free-cancel time (plumber), get no row.
    expect(
      rows.some((row) => row.business_id === "biz-demo-band" || row.business_id === "biz-demo-plumber"),
    ).toBe(false);
  });

  it("gives each owner one staff row at their business: joined from their own mobile and bookable, dated when fixture set v1 was made", async () => {
    expect(Number.isNaN(seededAt.getTime())).toBe(false);
    const rows = await db.sql<Record<string, unknown>[]>`select * from staff order by id`;
    expect(rows).toHaveLength(245);
    const owners = await db.sql<{ business_id: string; person_id: string; number: string }[]>`
      select r.business_id, r.person_id, p.number
      from person_roles r
      join person_handles ph on ph.person_id = r.person_id
      join phones p on p.handle_id = ph.handle_id
      where r.role = 'owner' and r.ended_at is null
    `;
    const ownerOf = new Map(owners.map((owner) => [owner.business_id, owner]));
    const staffOf = new Map(rows.map((row) => [String(row.business_id), row]));
    for (const shop of SHOP_FILES.values()) {
      const businessId = `biz-demo-${shop.id}`;
      const owner = ownerOf.get(businessId);
      expect(owner?.person_id, shop.id).toBe(`person-demo-${shop.id}-owner`);
      expect(staffOf.get(businessId), shop.id).toEqual({
        id: `staff-demo-${shop.id}-owner`,
        business_id: businessId,
        person_id: owner?.person_id,
        mobile: owner?.number,
        agreed_to_text_ticked_at: seededAt,
        agreed_ticked_by_person_id: owner?.person_id,
        status: "joined",
        added_at: seededAt,
        joined_at: seededAt,
        joined_from_number: owner?.number,
        stopped_at: null,
        wrong_number_at: null,
        languages: [],
        day_list_time: null,
        video_link: null,
        calls_customer_mobile: false,
        supervisor_staff_id: null,
        bookable_at: seededAt,
        bookable_by_person_id: owner?.person_id,
        version: 1,
      });
    }
    expect(first.seededAt).toEqual({ at: seededAt, source: "test-kit/COVERAGE.md" });
  });

  it(
    "gives each owner one ID upload at sign-up, which counts as the ID confirmed (MC C10), its object key only in sealed form under the owner's own key",
    SLOW,
    async () => {
      const rows = await db.sql<
        {
          id: string;
          person_id: string;
          purpose: string;
          object_key: Uint8Array;
          content_type: string;
          uploaded_at: Date;
        }[]
      >`select * from id_uploads order by id`;
      expect(rows).toHaveLength(245);
      expect(new Set(rows.map((row) => row.person_id)).size).toBe(245);
      const encoder = new TextEncoder();
      for (const row of rows) {
        const shop = first.shops.find((entry) => entry.idUploadId === row.id);
        expect(shop, row.id).toBeDefined();
        expect(row.id).toBe(`idup-demo-${shop?.shopId ?? ""}-owner-sign-up`);
        expect([row.person_id, row.purpose, row.content_type, row.uploaded_at], row.id).toEqual([
          shop?.ownerPersonId,
          "sign_up",
          DEMO_ID_CONTENT_TYPE,
          seededAt,
        ]);
        const objectKey = `${DEMO_ID_OBJECT_KEY_PREFIX}${row.id}`;
        const bytes = new Uint8Array(row.object_key);
        expect(bytes[0], row.id).toBe(0x01);
        expect(bytes.length, row.id).toBe(encoder.encode(objectKey).length + SEAL_OVERHEAD);
        expect(contains(bytes, encoder.encode(objectKey)), row.id).toBe(false);
        expect(await unsealText(db.sql, KEYS, row.person_id, bytes), row.id).toBe(objectKey);
      }
      const keys = await db.sql<
        { person_id: string; held: boolean; wrapping_key_name: string; version: number }[]
      >`
      select person_id, wrapped_key is not null and erased_at is null as held, wrapping_key_name, version
      from sealing_keys order by person_id
    `;
      // Both sorted here: the database's collation and code-point order differ ("gym-" and "gymnastics").
      expect(sorted(keys.map((key) => key.person_id))).toEqual(sorted(rows.map((row) => row.person_id)));
      for (const key of keys) {
        expect([key.held, key.wrapping_key_name, key.version], key.person_id).toEqual([
          true,
          DEFAULT_WRAPPING_KEY_NAME,
          1,
        ]);
      }
    },
  );

  it("traces every row to a fixture set v1 file listed in MANIFEST.sha256 at the hash it has now, and each borrowed value to the file it came from", async () => {
    expect(first.fixtureSet.manifestSha256).toBe(sha256(path.join(V1, "MANIFEST.sha256")));
    expect(first.fixtureSet.filesChecked).toBe(LISTED.size);
    expect(first.shops).toHaveLength(245);
    for (const shop of first.shops) {
      expect(shop.source).toBe(`${SHOPS}/${shop.shopId}.json`);
      expect(LISTED.get(shop.source), shop.source).toBe(shop.sha256);
      expect(sha256(path.join(V1, shop.source)), shop.source).toBe(shop.sha256);
      // Each key is made from the shop's id, which is its file's name.
      expect(
        [shop.businessId, shop.ownerPersonId, shop.companyId, shop.locationId, shop.staffId, shop.idUploadId],
        shop.source,
      ).toEqual([
        `biz-demo-${shop.shopId}`,
        `person-demo-${shop.shopId}-owner`,
        `company-demo-${shop.shopId}`,
        `loc-demo-${shop.shopId}`,
        `staff-demo-${shop.shopId}-owner`,
        `idup-demo-${shop.shopId}-owner-sign-up`,
      ]);
      expect(shop.kindId, shop.source).toBe(hasForm(shop.shopId) ? shop.shopId : null);
      // A value not in the shop's own file names the listed file it came from, which holds it.
      for (const [column, from] of Object.entries(shop.valuesFrom)) {
        expect(LISTED.has(from), `${shop.source} ${column}`).toBe(true);
        const source = SHOP_FILES.get(path.basename(from, ".json"));
        expect(source, `${shop.source} ${column}`).toBeDefined();
        if (column === "address") {
          const [row] = await db.sql<{ value: string }[]>`
            select address as value from locations where id = ${shop.locationId}
          `;
          expect(row?.value, shop.source).toBe(
            source === undefined ? undefined : demoValue(source, "address"),
          );
        } else {
          expect(column, shop.source).toBe("pf_facts");
          const [row] = await db.sql<{ value: string[] }[]>`
            select pf_facts as value from company_kinds where company_id = ${shop.companyId}
          `;
          expect(row?.value, shop.source).toEqual(source?.facts);
        }
      }
    }
    expect(
      Object.fromEntries(
        first.shops
          .filter((shop) => Object.keys(shop.valuesFrom).length > 0)
          .map((shop) => [shop.shopId, Object.keys(shop.valuesFrom)]),
      ),
    ).toEqual({ insurance: ["pf_facts"], "test-mixed-A": ["address"], "test-mixed-B": ["address"] });
    expect(LISTED.has(first.seededAt.source)).toBe(true);

    // Every row of every table is one shop's, and every shop has its row in each.
    const keys = async (rows: Promise<readonly { key: string }[]>): Promise<string[]> =>
      sorted((await rows).map((row) => row.key));
    const sql = db.sql;
    expect(await keys(sql<{ key: string }[]>`select business_id as key from business_setup`)).toEqual(
      sorted(first.shops.map((shop) => shop.businessId)),
    );
    expect(await keys(sql<{ key: string }[]>`select id || ' ' || business_id as key from companies`)).toEqual(
      sorted(first.shops.map((shop) => `${shop.companyId} ${shop.businessId}`)),
    );
    expect(
      await keys(sql<{ key: string }[]>`select company_id || ' ' || kind_id as key from company_kinds`),
    ).toEqual(
      sorted(
        first.shops.flatMap((shop) => (shop.kindId === null ? [] : [`${shop.companyId} ${shop.kindId}`])),
      ),
    );
    expect(
      await keys(sql<{ key: string }[]>`select business_id || ' ' || flow as key from flow_defaults`),
    ).toEqual(
      sorted(first.shops.flatMap((shop) => shop.flowDefaults.map((flow) => `${shop.businessId} ${flow}`))),
    );
    expect(await keys(sql<{ key: string }[]>`select id || ' ' || business_id as key from locations`)).toEqual(
      sorted(first.shops.map((shop) => `${shop.locationId} ${shop.businessId}`)),
    );
    expect(await keys(sql<{ key: string }[]>`select id || ' ' || person_id as key from staff`)).toEqual(
      sorted(first.shops.map((shop) => `${shop.staffId} ${shop.ownerPersonId}`)),
    );
    expect(await keys(sql<{ key: string }[]>`select id || ' ' || person_id as key from id_uploads`)).toEqual(
      sorted(first.shops.map((shop) => `${shop.idUploadId} ${shop.ownerPersonId}`)),
    );
  });

  it("writes as the job role, rosie_job, with no scope; under row-level security a shop's scope shows the Tool API role that shop's setup only", async () => {
    expect(first.ranAs).toBe("rosie_job");
    const barber = first.shops.find((shop) => shop.shopId === "barber");
    const seen = await withBusiness(db.sql, barber?.businessId ?? "", async (tx) => {
      await tx`set local role rosie_app`;
      const read = async (table: string, column: string): Promise<string[]> =>
        (await tx<{ key: string }[]>`select ${tx(column)} as key from ${tx(table)} order by 1`).map(
          (row) => row.key,
        );
      return {
        business_setup: await read("business_setup", "business_id"),
        companies: await read("companies", "id"),
        company_kinds: await read("company_kinds", "kind_id"),
        flow_defaults: await read("flow_defaults", "flow"),
        locations: await read("locations", "id"),
        staff: await read("staff", "id"),
      };
    });
    expect(seen).toEqual({
      business_setup: [barber?.businessId],
      companies: [barber?.companyId],
      company_kinds: ["barber"],
      flow_defaults: ["A", "B"],
      locations: [barber?.locationId],
      staff: [barber?.staffId],
    });
  });

  it(
    "running the seed twice leaves the same rows: the second run writes nothing, seals nothing, and every row and version stays as it was",
    SLOW,
    async () => {
      const before = await snapshot(db.sql);
      const second = await seedSetupBusiness(db.sql, { wrappingKeys: KEYS });
      for (const table of TABLES) {
        const total =
          table === "company_kinds" ? 243 : table === "flow_defaults" ? first.tables.flow_defaults.rows : 245;
        expect(second.tables[table], table).toEqual({ rows: total, inserted: 0, kept: total });
      }
      expect(second.shops).toEqual(first.shops);
      expect(second.seededAt).toEqual(first.seededAt);
      expect(second.ranAs).toBe("rosie_job");
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );

  it(
    "writes a row that went missing again, as the first run wrote it, and changes nothing else; a missing ID upload is sealed again under the owner's same key",
    SLOW,
    async () => {
      const before = await snapshot(db.sql);
      await db.sql`delete from locations where id = 'loc-demo-yoga'`;
      await db.sql`delete from staff where id = 'staff-demo-yoga-owner'`;
      await db.sql`delete from flow_defaults where business_id = 'biz-demo-yoga' and flow = 'B'`;
      const third = await seedSetupBusiness(db.sql, { wrappingKeys: KEYS });
      expect([third.tables.locations, third.tables.staff, third.tables.flow_defaults.inserted]).toEqual([
        { rows: 245, inserted: 1, kept: 244 },
        { rows: 245, inserted: 1, kept: 244 },
        1,
      ]);
      expect(await snapshot(db.sql)).toEqual(before);

      const [upload] = await db.sql<{ object_key: Uint8Array }[]>`
        delete from id_uploads where id = 'idup-demo-yoga-owner-sign-up' returning object_key
      `;
      const fourth = await seedSetupBusiness(db.sql, { wrappingKeys: KEYS });
      expect([fourth.tables.id_uploads, fourth.tables.sealing_keys]).toEqual([
        { rows: 245, inserted: 1, kept: 244 },
        { rows: 245, inserted: 0, kept: 245 },
      ]);
      const after = await snapshot(db.sql);
      const [again] = await db.sql<{ object_key: Uint8Array }[]>`
        select object_key from id_uploads where id = 'idup-demo-yoga-owner-sign-up'
      `;
      // A fresh seal has a fresh IV: the bytes differ, the key they hold does not.
      expect(same(new Uint8Array(again?.object_key ?? []), new Uint8Array(upload?.object_key ?? []))).toBe(
        false,
      );
      expect(
        await unsealText(db.sql, KEYS, "person-demo-yoga-owner", new Uint8Array(again?.object_key ?? [])),
      ).toBe(`${DEMO_ID_OBJECT_KEY_PREFIX}idup-demo-yoga-owner-sign-up`);
      const withoutKeys = (rows: unknown[] | undefined): unknown[] =>
        (rows ?? []).map((row) => ({ ...(row as Record<string, unknown>), object_key: null }));
      expect(withoutKeys(after.id_uploads)).toEqual(withoutKeys(before.id_uploads));
      expect({ ...after, id_uploads: [] }).toEqual({ ...before, id_uploads: [] });
    },
  );
});

describe("before the setup seed writes a row", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_setup_checks" });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  it("refuses to run before the core seed, naming it, and writes nothing", SLOW, async () => {
    const error = await refusal(seedSetupBusiness(db.sql, { wrappingKeys: KEYS }));
    expect(error.message).toContain("run db/seeds/core.ts first");
    expect(error.message).toContain("245 of 245 shops");
    expect(await rowCounts(db.sql)).toEqual(EMPTY);
  });

  describe("with the core seed's rows in place", () => {
    beforeAll(async () => {
      await seedCore(db.sql);
    }, 120_000);

    it(
      "refuses without the wrapping key that seals the ID uploads, and writes nothing (the transaction rolls back)",
      SLOW,
      async () => {
        const error = await refusal(seedSetupBusiness(db.sql, { wrappingKeys: NO_KEYS }));
        expect(error).toBeInstanceOf(SealingError);
        expect((error as SealingError).code).toBe("wrapping_key_missing");
        expect(await rowCounts(db.sql)).toEqual(EMPTY);
      },
    );

    it(
      "checks the whole set against MANIFEST.sha256 first: one changed byte in a shop or in the coverage map it dates from stops it",
      SLOW,
      async () => {
        const copy = copyOfFixtureSet();
        for (const changed of [`${SHOPS}/barber.json`, "test-kit/COVERAGE.md"]) {
          flipOneByte(path.join(copy.v1, changed));
          const error = await refusal(seedFromCopy(db.sql, copy));
          expect(error, changed).toBeInstanceOf(FixtureChecksumError);
          expect((error as FixtureChecksumError).problems, changed).toEqual([`changed: ${changed}`]);
          flipOneByte(path.join(copy.v1, changed));
        }
        expect(await rowCounts(db.sql)).toEqual(EMPTY);
      },
    );

    it(
      "refuses an intact copy of fixture set v1 that lies outside fixtures/, and writes nothing",
      SLOW,
      async () => {
        const copy = copyOfFixtureSet();
        const error = await refusal(seedSetupBusiness(db.sql, { wrappingKeys: KEYS, fixturesDir: copy.v1 }));
        expect(error).toBeInstanceOf(FixtureAccessError);
        expect(await rowCounts(db.sql)).toEqual(EMPTY);
      },
    );

    it(
      "refuses, naming the file, a value it does not know how to read, rather than guess: a free-cancel time in another form, a listing field such as a map pin, a facts list C5 does not cover",
      SLOW,
      async () => {
        const cases: [string, (shop: Record<string, unknown>) => void, string][] = [
          [
            "barber",
            (shop) => {
              shop.settings = { arrive: "setstart", cutoff: "the night before" };
            },
            "free-cancel time",
          ],
          [
            "barber",
            (shop) => {
              shop.google_prefill = { ...(shop.google_prefill as object), "map pin": "40.0, -90.0" };
            },
            "google_prefill",
          ],
          [
            "yoga",
            (shop) => {
              shop.facts = [];
            },
            "lists no facts",
          ],
          [
            "yoga",
            (shop) => {
              shop.switches = { sensitive: "yes" };
            },
            "switch sensitive",
          ],
          [
            "yoga",
            (shop) => {
              shop.settings = { arrive: "whenever" };
            },
            "arrival setting",
          ],
        ];
        for (const [id, change, words] of cases) {
          const copy = copyOfFixtureSet();
          rewriteShop(copy, id, change);
          const error = await refusal(seedFromCopy(db.sql, copy));
          expect(error.message, words).toContain(`${SHOPS}/${id}.json`);
          expect(error.message, words).toContain(words);
          expect(error, words).not.toBeInstanceOf(FixtureChecksumError);
        }
        expect(await rowCounts(db.sql)).toEqual(EMPTY);
      },
    );

    it(
      "loads from an untouched copy opened the same way, so each refusal above had its one reason",
      SLOW,
      async () => {
        const copy = copyOfFixtureSet();
        const result = await seedFromCopy(db.sql, copy);
        expect(result.ranAs).toBe("rosie_job");
        expect(result.tables.locations).toEqual({ rows: 245, inserted: 245, kept: 0 });
        const counts = await rowCounts(db.sql);
        for (const table of PER_SHOP) {
          expect(counts[table], table).toBe(245);
        }
      },
    );
  });
});
