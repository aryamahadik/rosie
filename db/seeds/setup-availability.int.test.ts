// T-215: the availability and bill card seed from fixture set v1, against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/seeds/setup-availability`). Each top-level block migrates a fresh test schema of its
// own (db/repo/test-db.ts), runs the core, setup, kinds, services and staff seeds (T-200, T-213, T-212, T-214, T-727)
// where it needs their rows, and drops the schema at the end; the shared public schema is never touched.
//
// The card's proofs: every shop has hours; class trades have sessions with capacity; no busy block carries a title;
// re-running is idempotent. Each expected row is built here from the fixture files themselves (node:fs and node:crypto),
// never through the seed's own reader, and compared with the whole row the database holds; the sessions' instants, the
// classes' ends and the sessions' names are worked out again by PostgreSQL from the class rows (its own time zone rules,
// not the seed's). The wrapping key the setup seed seals the owners' ID uploads with is made here from random bytes for
// each run and is never written to a file or printed. Bytes are changed only in temporary copies of fixtures/v1 in the OS
// temp folder.
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_WRAPPING_KEY_NAME, type WrappingKeys } from "../repo/sealing";
import { type Sql, withBusiness } from "../repo/scope";
import { createTestDatabase, type TestDatabase } from "../repo/test-db";
import { seedCore } from "./core";
import { seedKinds } from "./kinds";
import { FixtureAccessError, FixtureChecksumError, openFixtureSet } from "./lib/fixture-set";
import {
  type AvailabilitySeedResult,
  DEMO_CLASS_SEATS,
  hoursOf,
  NOT_SEEDED,
  seedSetupAvailability,
  seedSetupAvailabilityFrom,
  SESSIONS_AHEAD_DAYS,
} from "./setup-availability";
import { seedSetupBusiness } from "./setup-business";
import { seedSetupServicesRules } from "./setup-services-rules";
import { seedSetupStaff } from "./setup-staff";

const SLOW = { timeout: 120_000 };
const REPO = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const V1 = path.join(REPO, "fixtures/v1");
const SHOPS = "test-kit/shops";
const ZONE = "America/New_York";
const TABLES = [
  "weekly_hours",
  "resources",
  "class_seats",
  "classes",
  "class_sessions",
  "bill_cards",
] as const;
const FLOWS = ["A", "B"] as const;
/** Every demo listing's hours, as test-kit.js writes them into each profession shop's google_prefill (its line 87). */
const DEMO_HOURS = "[G] Mon-Fri 9am-5pm, Sat 10am-2pm (demo)";
/** The spans those words give, as PostgreSQL reads back a time: Monday to Friday 9 to 5, Saturday 10 to 2. */
const DEMO_SPANS = [
  { weekday: 1, day: "mon", opens: "09:00:00", closes: "17:00:00" },
  { weekday: 2, day: "tue", opens: "09:00:00", closes: "17:00:00" },
  { weekday: 3, day: "wed", opens: "09:00:00", closes: "17:00:00" },
  { weekday: 4, day: "thu", opens: "09:00:00", closes: "17:00:00" },
  { weekday: 5, day: "fri", opens: "09:00:00", closes: "17:00:00" },
  { weekday: 6, day: "sat", opens: "10:00:00", closes: "14:00:00" },
] as const;
/** K-27 v1's busy_blocks columns: when a person is busy and where it came from, never what (README "Busy blocks"). */
const BUSY_BLOCK_COLUMNS = [
  "id",
  "business_id",
  "person_id",
  "source",
  "calendar_link_id",
  "provider_event_ref",
  "during",
  "time_zone",
  "confirmed_at",
  "confirmed_by_person_id",
  "version",
];
const DOCUMENT_TABLES = [
  "documents",
  "document_files",
  "document_texts",
  "document_signers",
  "document_signatures",
] as const;

/** One wrapping key per run for the setup seed's ID uploads: random, in memory only, under the Workers secret's name. */
const WRAP_BYTES = crypto.getRandomValues(new Uint8Array(32));
const KEYS: WrappingKeys = {
  resolve: (name) => (name === DEFAULT_WRAPPING_KEY_NAME ? WRAP_BYTES : undefined),
};

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const sorted = (values: Iterable<string>): string[] => [...values].sort();
/** Rows in code-point order of their id (the database's collation may order dashes and capitals otherwise). */
const byId = <T extends Record<string, unknown>>(rows: Iterable<T>): T[] =>
  [...rows].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));

interface MoneyExample {
  combo: string;
  name: string;
}

interface ShopFile {
  id: string;
  flows: Record<string, { services: MoneyExample[] } | undefined>;
  facts?: string[];
  google_prefill?: { hours?: unknown };
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

/** The demo shop files of fixture set v1, read here: shop id (its file name) to the file, in code-point order of id. */
function shopFiles(): Map<string, ShopFile> {
  const shops = new Map<string, ShopFile>();
  const ids = readdirSync(path.join(V1, SHOPS))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length));
  for (const id of sorted(ids)) {
    shops.set(id, JSON.parse(readFileSync(path.join(V1, SHOPS, `${id}.json`), "utf8")) as ShopFile);
  }
  return shops;
}

const SHOP_FILES = shopFiles();
const LISTED = manifest();

const flowsOf = (shop: ShopFile): string[] => FLOWS.filter((flow) => flow in shop.flows);
/** A shop's facts: its own list, or for insurance cpa's (Master Corrections C5), as the setup seed reads them. */
function factsOf(shop: ShopFile): string[] {
  const facts = shop.facts ?? [];
  if (facts.length === 0 && shop.id === "insurance") {
    return SHOP_FILES.get("cpa")?.facts ?? [];
  }
  return facts;
}
/** A shop whose work runs classes: its facts list classes (FS rows K01 and K02). */
const runsClasses = (shop: ShopFile): boolean => factsOf(shop).includes("classes");

interface ExpectedClass {
  shopId: string;
  key: string;
  serviceId: string;
  flow: string;
  combo: string;
  at: string;
  picked: "list" | "first";
}

/** The class a shop that runs classes gets: its first service priced from the list, flow A first, else its first. */
function expectedClass(shop: ShopFile): ExpectedClass {
  const examples = flowsOf(shop).flatMap((flow) =>
    (shop.flows[flow]?.services ?? []).map((example, index) => ({ flow, index, combo: example.combo })),
  );
  const fromList = examples.find((example) => example.combo.startsWith("list|"));
  const picked = fromList ?? examples[0];
  if (picked === undefined) {
    throw new Error(`${shop.id} has no money example`);
  }
  const part = `${picked.flow.toLowerCase()}-${picked.combo.replaceAll("|", "-")}`;
  return {
    shopId: shop.id,
    key: `${shop.id}-${part}`,
    serviceId: `svc-demo-${shop.id}-${part}`,
    flow: picked.flow,
    combo: picked.combo,
    at: `flows.${picked.flow}.services[${String(picked.index)}]`,
    picked: fromList === undefined ? "first" : "list",
  };
}

const CLASS_SHOPS = [...SHOP_FILES.values()].filter(runsClasses);
const CLASSES = CLASS_SHOPS.map(expectedClass);

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

/** Every row of the six tables the seed writes, in key order, as plain arrays. */
async function snapshot(sql: Sql): Promise<Record<string, unknown[]>> {
  return {
    weekly_hours: [...(await sql`select * from weekly_hours order by id`)],
    resources: [...(await sql`select * from resources order by id`)],
    class_seats: [...(await sql`select * from class_seats order by resource_id`)],
    classes: [...(await sql`select * from classes order by id`)],
    class_sessions: [...(await sql`select * from class_sessions order by resource_id`)],
    bill_cards: [...(await sql`select * from bill_cards order by id`)],
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

interface Copy {
  root: string;
  fixtures: string;
  v1: string;
}

const copies: string[] = [];

/** A byte-for-byte copy of fixtures/v1 at <temp>/fixtures/v1. */
function copyOfFixtureSet(): Copy {
  const root = mkdtempSync(path.join(tmpdir(), "rosie-seed-availability-"));
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

/** Sets a shop's listing hours in a copy being rewritten. */
const listingHours =
  (words: string) =>
  (shop: Record<string, unknown>): void => {
    (shop.google_prefill as Record<string, unknown>).hours = words;
  };

function seedFromCopy(sql: Sql, copy: Copy): Promise<AvailabilitySeedResult> {
  return seedSetupAvailabilityFrom(sql, openFixtureSet(copy.v1, { jail: copy.fixtures }));
}

afterAll(() => {
  for (const root of copies) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("reading a listing's hours (no database)", () => {
  it("reads the demo listing's hours as six spans, and other forms as the words say", () => {
    expect(hoursOf("x.json", "Mon-Fri 9am-5pm, Sat 10am-2pm")).toEqual([
      { weekday: 1, opens: "09:00", closes: "17:00" },
      { weekday: 2, opens: "09:00", closes: "17:00" },
      { weekday: 3, opens: "09:00", closes: "17:00" },
      { weekday: 4, opens: "09:00", closes: "17:00" },
      { weekday: 5, opens: "09:00", closes: "17:00" },
      { weekday: 6, opens: "10:00", closes: "14:00" },
    ]);
    // Two spans on one day, in day order whatever the words' order; noon is 12pm; 12am closing a span is midnight.
    expect(hoursOf("x.json", "Sun 6pm-12am, Tue 1pm-5:30pm, Tue 9:30am-12pm")).toEqual([
      { weekday: 2, opens: "09:30", closes: "12:00" },
      { weekday: 2, opens: "13:00", closes: "17:30" },
      { weekday: 7, opens: "18:00", closes: "24:00" },
    ]);
  });

  it("refuses, naming the file, hours it does not know how to read, rather than guess", () => {
    const cases: [string, string][] = [
      ["Mon-Fri 9am to 5pm", "groups the seed knows"],
      ["Mon-Fri 9-5", "groups the seed knows"],
      ["Monday 9am-5pm", "groups the seed knows"],
      ["Mon-Fri 9am-5pm; Sat 10am-2pm", "groups the seed knows"],
      ["Mon-Fri 13pm-5pm", "groups the seed knows"],
      ["", "groups the seed knows"],
      ["Sat-Mon 9am-5pm", "wraps past Sunday"],
      ["Fri 6pm-2am", "does not close after it opens"],
      ["Mon 9am-9am", "does not close after it opens"],
      ["Mon 9am-1pm, Mon 12pm-5pm", "overlap"],
    ];
    for (const [words, why] of cases) {
      expect(() => hoursOf("test-kit/shops/x.json", words), words).toThrow("test-kit/shops/x.json");
      expect(() => hoursOf("test-kit/shops/x.json", words), words).toThrow(why);
    }
  });
});

describe("the availability seed, loaded from fixture set v1 after the core, setup, kinds, services and staff seeds", () => {
  let db: TestDatabase;
  let first: AvailabilitySeedResult;
  let seededAt: Date;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_availability" });
    await seedCore(db.sql);
    await seedSetupBusiness(db.sql, { wrappingKeys: KEYS });
    await seedKinds(db.sql);
    await seedSetupServicesRules(db.sql);
    await seedSetupStaff(db.sql);
    first = await seedSetupAvailability(db.sql);
    seededAt = await fixtureSetMade(db.sql);
  }, 240_000);

  // Dropping a schema can pass the hook default while other builders load the database (a resource guard only).
  afterAll(async () => {
    await db.drop();
  }, 120_000);

  it("writes six hours rows for each of the 245 shops, one class for each of the 33 whose work runs classes with its weekly sessions, and a bill card for each shop", () => {
    expect(SHOP_FILES.size).toBe(245);
    expect(first.shops.map((shop) => shop.shopId)).toEqual([...SHOP_FILES.keys()]);
    expect(CLASS_SHOPS).toHaveLength(33);
    const weeks = Math.floor(SESSIONS_AHEAD_DAYS / 7) + 1;
    expect(first.tables).toEqual({
      weekly_hours: { rows: 245 * 6, inserted: 245 * 6, kept: 0 },
      resources: { rows: 33 * weeks, inserted: 33 * weeks, kept: 0 },
      class_seats: { rows: 33 * weeks, inserted: 33 * weeks, kept: 0 },
      classes: { rows: 33, inserted: 33, kept: 0 },
      class_sessions: { rows: 33 * weeks, inserted: 33 * weeks, kept: 0 },
      bill_cards: { rows: 245, inserted: 245, kept: 0 },
    });
    expect(first.notSeeded).toEqual(NOT_SEEDED);
  });

  it("every shop has hours: its location's opening hours, Monday to Friday 9 to 5 and Saturday 10 to 2, read in the business's zone, from its demo listing or, with none, from the one listing hours every shop gives", async () => {
    const rows = await db.sql<Record<string, unknown>[]>`select * from weekly_hours order by id`;
    const rowOf = new Map(rows.map((row) => [String(row.id), row]));
    expect(rows).toHaveLength(245 * DEMO_SPANS.length);
    for (const shop of SHOP_FILES.values()) {
      if (shop.google_prefill !== undefined) {
        expect(shop.google_prefill.hours, shop.id).toBe(DEMO_HOURS);
      }
      for (const span of DEMO_SPANS) {
        const id = `hours-demo-${shop.id}-${span.day}-${span.opens.slice(0, 5).replace(":", "")}`;
        expect(rowOf.get(id), id).toEqual({
          id,
          business_id: `biz-demo-${shop.id}`,
          owner_kind: "location",
          location_id: `loc-demo-${shop.id}`,
          resource_id: null,
          resource_kind: null,
          place_or_thing_id: null,
          weekday: span.weekday,
          opens_at: span.opens,
          closes_at: span.closes,
          time_zone: ZONE,
          version: 1,
        });
      }
    }
    // Each business's zone is the one its rows are read in, and every location of every business has hours.
    const [check] = await db.sql<{ zones: number; open: number; closed: number }[]>`
      select
        (select count(*)::int from weekly_hours h join businesses b on b.id = h.business_id
          where h.time_zone <> b.time_zone) as zones,
        (select count(distinct location_id)::int from weekly_hours) as open,
        (select count(*)::int from locations l
          where not exists (select 1 from weekly_hours h where h.location_id = l.id)) as closed
    `;
    expect(check).toEqual({ zones: 0, open: 245, closed: 0 });
    // test-mixed-A and -B have no listing: their hours name the first shop whose listing gives the same words.
    const firstListed = [...SHOP_FILES.values()].find((shop) => shop.google_prefill !== undefined);
    for (const shop of first.shops) {
      const file = SHOP_FILES.get(shop.shopId);
      const from =
        file?.google_prefill === undefined ? `${SHOPS}/${firstListed?.id ?? ""}.json` : shop.source;
      expect(shop.hours.from, shop.shopId).toBe(from);
      expect(`[G] ${shop.hours.words} (demo)`, shop.shopId).toBe(DEMO_HOURS);
      expect(sorted(shop.hours.ids), shop.shopId).toEqual(
        sorted(rows.filter((row) => row.business_id === shop.businessId).map((row) => String(row.id))),
      );
    }
    expect(
      sorted(first.shops.filter((shop) => shop.hours.from !== shop.source).map((shop) => shop.shopId)),
    ).toEqual(["test-mixed-A", "test-mixed-B"]);
  });

  it("class trades have sessions with capacity: each shop whose facts list classes has one weekly class selling its first list-priced service, at its own location, with its seats, and a scheduled session for each week ahead, each a class-session resource whose seat counter holds the class's seats with none taken", async () => {
    const classes = byId(await db.sql<Record<string, unknown>[]>`select * from classes`);
    expect(classes).toEqual(
      sorted(CLASSES.map((expected) => `class-demo-${expected.key}`)).map((id) => {
        const expected = CLASSES.find((entry) => `class-demo-${entry.key}` === id);
        return {
          id,
          business_id: `biz-demo-${expected?.shopId ?? ""}`,
          service_id: expected?.serviceId,
          weekday: 1,
          starts_at: "09:00:00",
          ends_at: "10:00:00",
          time_zone: ZONE,
          teacher_resource_id: null,
          teacher_kind: "worker",
          room_resource_id: null,
          room_kind: "room",
          location_id: `loc-demo-${expected?.shopId ?? ""}`,
          seats: DEMO_CLASS_SEATS,
          minimum: null,
          active: true,
          version: 1,
        };
      }),
    );
    // Every class sells a service of its own business, and ends after that service's length (K-27: with no end on a
    // photo, code takes the end from the service's length), inside its day's open span.
    const [fit] = await db.sql<{ classes: number; own: number; length: number; open: number }[]>`
      select count(*)::int as classes,
        count(*) filter (where s.business_id = c.business_id)::int as own,
        count(*) filter (where c.ends_at = c.starts_at + s.length)::int as length,
        count(*) filter (where exists (select 1 from weekly_hours h where h.location_id = c.location_id
          and h.weekday = c.weekday and h.opens_at <= c.starts_at and h.closes_at >= c.ends_at))::int as open
      from classes c join services s on s.id = c.service_id
    `;
    expect(fit).toEqual({ classes: 33, own: 33, length: 33, open: 33 });

    // The sessions PostgreSQL works out from each class: every day of the class's weekday in the SESSIONS_AHEAD_DAYS
    // days from the day fixture set v1 was made, at the class's times read in its zone.
    const [sessions] = await db.sql<
      {
        expected: number;
        rows: number;
        missing: number;
        ids: number;
        named: number;
        seats: number;
        resources: number;
      }[]
    >`
      with days as (
        select d::date as day from generate_series(
          (${seededAt}::timestamptz at time zone ${ZONE})::date,
          (${seededAt}::timestamptz at time zone ${ZONE})::date + (${SESSIONS_AHEAD_DAYS}::int - 1),
          interval '1 day') d
      ), expected as (
        select c.id as class_id, c.business_id, c.service_id, c.location_id, days.day,
          tstzrange((days.day + c.starts_at) at time zone c.time_zone, (days.day + c.ends_at) at time zone c.time_zone,
            '[)') as during
        from classes c join days on extract(isodow from days.day) = c.weekday
      )
      select
        (select count(*)::int from expected) as expected,
        (select count(*)::int from class_sessions) as rows,
        (select count(*)::int from expected e where not exists (
          select 1 from class_sessions s where s.class_id = e.class_id and s.business_id = e.business_id
            and s.service_id = e.service_id and s.location_id = e.location_id and s.during = e.during
            and s.time_zone = ${ZONE} and s.status = 'scheduled')) as missing,
        (select count(*)::int from expected e join class_sessions s on s.class_id = e.class_id and s.during = e.during
          where s.resource_id = 'session-demo-' || substr(e.class_id, length('class-demo-') + 1) || '-'
            || to_char(e.day, 'YYYY-MM-DD')) as ids,
        (select count(*)::int from class_sessions s join resources r on r.id = s.resource_id
          join services v on v.id = s.service_id
          where r.name = v.name || ', ' || to_char(lower(s.during) at time zone s.time_zone, 'Dy Mon FMDD FMHH12:MIam'))
          as named,
        (select count(*)::int from class_sessions s join class_seats k on k.resource_id = s.resource_id
          join classes c on c.id = s.class_id
          where k.capacity = c.seats and k.taken = 0 and k.business_id = s.business_id) as seats,
        (select count(*)::int from class_sessions s join resources r on r.id = s.resource_id
          where r.kind = 'class_session' and r.business_id = s.business_id and r.active and r.person_id is null
            and r.version = 1) as resources
    `;
    const weeks = Math.floor(SESSIONS_AHEAD_DAYS / 7) + 1;
    expect(sessions).toEqual({
      expected: 33 * weeks,
      rows: 33 * weeks,
      missing: 0,
      ids: 33 * weeks,
      named: 33 * weeks,
      seats: 33 * weeks,
      resources: 33 * weeks,
    });
    // Shop by shop: each of the 33 has its sessions bookable, each scheduled with seats left on its active resource.
    const perShop = await db.sql<{ business_id: string; open: number }[]>`
      select s.business_id, count(*)::int as open from class_sessions s
        join class_seats k on k.resource_id = s.resource_id join resources r on r.id = s.resource_id
      where s.status = 'scheduled' and k.capacity > 0 and k.taken < k.capacity and r.active
      group by s.business_id
    `;
    expect(sorted(perShop.map((row) => `${row.business_id} ${String(row.open)}`))).toEqual(
      sorted(CLASS_SHOPS.map((shop) => `biz-demo-${shop.id} ${String(weeks)}`)),
    );
    // Each session row is the whole of K-27's scheduled session: no teacher, room, minimum, count or cancel.
    for (const row of await db.sql<Record<string, unknown>[]>`select * from class_sessions`) {
      expect(row, String(row.resource_id)).toEqual({
        resource_id: row.resource_id,
        resource_kind: "class_session",
        business_id: row.business_id,
        class_id: row.class_id,
        service_id: row.service_id,
        during: row.during,
        time_zone: ZONE,
        teacher_resource_id: null,
        teacher_kind: "worker",
        room_resource_id: null,
        room_kind: "room",
        location_id: row.location_id,
        minimum: null,
        status: "scheduled",
        counted_at: null,
        too_few: null,
        cancelled_at: null,
        cancelled_by_person_id: null,
        version: 1,
      });
    }
    // Spot check against yoga.json: the Handstand workshop, its first money example (list|full|none), meets Mondays
    // 9 to 10am Eastern, the first Monday on or after Sat Nov 7 2026 being Nov 9 (14:00 UTC: daylight time has ended).
    const [yoga] = await db.sql<{ name: string; starts: Date }[]>`
      select r.name, lower(s.during) as starts from class_sessions s join resources r on r.id = s.resource_id
      where s.class_id = 'class-demo-yoga-a-list-full-none' order by lower(s.during) limit 1
    `;
    expect(yoga).toEqual({
      name: "Handstand workshop, Mon Nov 9 9:00am",
      starts: new Date("2026-11-09T14:00:00Z"),
    });
    // No shop that does not run classes has a class, a session or a class-session resource.
    const [others] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from resources r where r.kind = 'class_session'
        and r.business_id <> all(${CLASS_SHOPS.map((shop) => `biz-demo-${shop.id}`)}::text[])
    `;
    expect(others?.n).toBe(0);
    for (const shop of first.shops) {
      const file = SHOP_FILES.get(shop.shopId);
      expect(shop.runsClasses, shop.shopId).toBe(file !== undefined && runsClasses(file));
      expect(shop.classes, shop.shopId).toHaveLength(shop.runsClasses ? 1 : 0);
    }
  });

  it("no busy block carries a title: busy_blocks has no column for what a person is doing, and the seed writes no busy block, calendar link, share or time off", async () => {
    const columns = await db.sql<{ name: string }[]>`
      select column_name as name from information_schema.columns
      where table_schema = current_schema() and table_name = 'busy_blocks' order by ordinal_position
    `;
    expect(columns.map((column) => column.name)).toEqual(BUSY_BLOCK_COLUMNS);
    for (const column of columns) {
      expect(column.name).not.toMatch(
        /title|summary|subject|description|location|place|attendee|organizer|note|what/,
      );
    }
    const [none] = await db.sql<
      {
        busy: number;
        links: number;
        shares: number;
        timeOff: number;
        workers: number;
        worker_hours: number;
      }[]
    >`
      select
        (select count(*)::int from busy_blocks) as busy,
        (select count(*)::int from calendar_links) as links,
        (select count(*)::int from calendar_link_shares) as shares,
        (select count(*)::int from time_off) as "timeOff",
        (select count(*)::int from resources where kind <> 'class_session') as workers,
        (select count(*)::int from weekly_hours where owner_kind <> 'location') as worker_hours
    `;
    expect(none).toEqual({ busy: 0, links: 0, shares: 0, timeOff: 0, workers: 0, worker_hours: 0 });
    expect(Object.keys(NOT_SEEDED).sort()).toEqual(
      sorted(["time_off", "busy_blocks", "calendar_links", "calendar_link_shares", "documents"]),
    );
  });

  it("gives each shop a live bill card saved by its owner, holding only the Stripe double's test-mode stand-in ids, never a card number", async () => {
    const cards = byId(await db.sql<Record<string, unknown>[]>`select * from bill_cards`);
    expect(cards).toEqual(
      sorted([...SHOP_FILES.keys()].map((id) => `billcard-demo-${id}-1`)).map((cardId) => {
        const shopId = cardId.slice("billcard-demo-".length, -"-1".length);
        return {
          id: cardId,
          business_id: `biz-demo-${shopId}`,
          saved_by_person_id: `person-demo-${shopId}-owner`,
          stripe_customer_id: `stripe-customer-demo-${shopId}`,
          stripe_payment_method_id: `stripe-card-demo-${shopId}-1`,
          saved_at: seededAt,
          removed_at: null,
          version: 1,
        };
      }),
    );
    for (const card of cards) {
      for (const id of [String(card.stripe_customer_id), String(card.stripe_payment_method_id)]) {
        expect(id).toMatch(/^stripe-(customer|card)-demo-[A-Za-z0-9-]+$/);
        // Never a live Stripe object id, a key or a card number (K-33 bill_cards_no_card_number's 13 digits in a row).
        expect(id).not.toMatch(/^(cus|pm|card|src|tok|sk|pk|rk)_/);
        expect(id.replace(/[ -]/g, "")).not.toMatch(/[0-9]{13,}/);
      }
    }
    // One live card per business, the owner's own (S1-29: saved by the owner, never a helper).
    const [check] = await db.sql<{ live: number; owners: number }[]>`
      select count(distinct c.business_id)::int as live,
        count(*) filter (where exists (select 1 from person_roles r where r.person_id = c.saved_by_person_id
          and r.business_id = c.business_id and r.role = 'owner'))::int as owners
      from bill_cards c where c.removed_at is null
    `;
    expect(check).toEqual({ live: 245, owners: 245 });
  });

  it("writes no document: fixture set v1 gives none a demo owner added, so nothing is sealed, and K-35 holds no column that says checked", async () => {
    for (const table of DOCUMENT_TABLES) {
      const [row] = await db.sql<{ n: number }[]>`select count(*)::int as n from ${db.sql(table)}`;
      expect(row?.n, table).toBe(0);
    }
    const columns = await db.sql<{ name: string }[]>`
      select column_name as name from information_schema.columns
      where table_schema = current_schema() and table_name = any(${[...DOCUMENT_TABLES]}::text[])
    `;
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      expect(column.name).not.toMatch(/check|verif|approv|valid|status/);
    }
  });

  it("traces every shop to its fixture set v1 file at the hash MANIFEST.sha256 lists, each class to the money example it sells and the fact that makes the shop run classes, and dates every card when fixture set v1 was made", () => {
    expect(first.fixtureSet.manifestSha256).toBe(sha256(path.join(V1, "MANIFEST.sha256")));
    expect(first.fixtureSet.filesChecked).toBe(LISTED.size);
    expect(first.seededAt).toEqual({ at: seededAt, source: "test-kit/COVERAGE.md" });
    expect(LISTED.has(first.seededAt.source)).toBe(true);
    for (const shop of first.shops) {
      expect(shop.source).toBe(`${SHOPS}/${shop.shopId}.json`);
      expect(LISTED.get(shop.source), shop.source).toBe(shop.sha256);
      expect(sha256(path.join(V1, shop.source)), shop.source).toBe(shop.sha256);
      expect(LISTED.has(shop.hours.from), shop.source).toBe(true);
      expect([shop.businessId, shop.ownerPersonId, shop.locationId, shop.billCardId], shop.source).toEqual([
        `biz-demo-${shop.shopId}`,
        `person-demo-${shop.shopId}-owner`,
        `loc-demo-${shop.shopId}`,
        `billcard-demo-${shop.shopId}-1`,
      ]);
      const file = SHOP_FILES.get(shop.shopId);
      for (const seeded of shop.classes) {
        const expected = CLASSES.find((entry) => entry.shopId === shop.shopId);
        expect(file !== undefined && factsOf(file).includes("classes"), shop.source).toBe(true);
        expect(
          {
            id: seeded.id,
            serviceId: seeded.serviceId,
            flow: seeded.flow,
            path: seeded.path,
            at: seeded.at,
            picked: seeded.picked,
          },
          shop.source,
        ).toEqual({
          id: `class-demo-${expected?.key ?? ""}`,
          serviceId: expected?.serviceId,
          flow: expected?.flow,
          path: expected?.combo,
          at: expected?.at,
          picked: expected?.picked,
        });
        const [flow, index] = /^flows\.(A|B)\.services\[(\d+)\]$/.exec(seeded.at)?.slice(1) ?? [];
        expect(file?.flows[flow ?? ""]?.services[Number(index)]?.combo, shop.source).toBe(seeded.path);
        expect(seeded.sessions).toHaveLength(Math.floor(SESSIONS_AHEAD_DAYS / 7) + 1);
      }
    }
    // Every class sells a list-priced service: each of the 33 shops has one.
    expect(CLASSES.filter((entry) => entry.picked === "first").map((entry) => entry.shopId)).toEqual([]);
  });

  it("writes as the job role, rosie_job, with no scope; under row-level security a shop's scope shows the Tool API role that shop's hours, class, sessions and bill card only", async () => {
    expect(first.ranAs).toBe("rosie_job");
    const seen = await withBusiness(db.sql, "biz-demo-yoga", async (tx) => {
      await tx`set local role rosie_app`;
      const businesses = async (table: string): Promise<string[]> =>
        (await tx<{ key: string }[]>`select distinct business_id as key from ${tx(table)} order by 1`).map(
          (row) => row.key,
        );
      return {
        weekly_hours: await businesses("weekly_hours"),
        classes: await businesses("classes"),
        class_sessions: await businesses("class_sessions"),
        class_seats: await businesses("class_seats"),
        resources: await businesses("resources"),
        bill_cards: await businesses("bill_cards"),
      };
    });
    expect(seen).toEqual(
      Object.fromEntries(
        ["weekly_hours", "classes", "class_sessions", "class_seats", "resources", "bill_cards"].map(
          (table) => [table, ["biz-demo-yoga"]],
        ),
      ),
    );
  });

  it(
    "running the seed twice leaves the same rows: the second run writes nothing, and every row and version stays as it was",
    SLOW,
    async () => {
      const before = await snapshot(db.sql);
      const second = await seedSetupAvailability(db.sql);
      for (const table of TABLES) {
        const total = first.tables[table].rows;
        expect(second.tables[table], table).toEqual({ rows: total, inserted: 0, kept: total });
      }
      expect(second.shops).toEqual(first.shops);
      expect(second.seededAt).toEqual(first.seededAt);
      expect(second.ranAs).toBe("rosie_job");
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );

  it(
    "writes rows that went missing again, as the first run wrote them, and changes nothing else",
    SLOW,
    async () => {
      const before = await snapshot(db.sql);
      const session =
        first.shops.find((shop) => shop.shopId === "yoga")?.classes[0]?.sessions[2]?.resourceId ?? "";
      expect(session).not.toBe("");
      await db.sql`delete from class_sessions where resource_id = ${session}`;
      await db.sql`delete from class_seats where resource_id = ${session}`;
      await db.sql`delete from resources where id = ${session}`;
      await db.sql`delete from weekly_hours where id in ('hours-demo-barber-sat-1000', 'hours-demo-test-mixed-B-wed-0900')`;
      await db.sql`delete from bill_cards where id = 'billcard-demo-plumber-1'`;
      const third = await seedSetupAvailability(db.sql);
      expect(Object.fromEntries(TABLES.map((table) => [table, third.tables[table].inserted]))).toEqual({
        weekly_hours: 2,
        resources: 1,
        class_seats: 1,
        classes: 0,
        class_sessions: 1,
        bill_cards: 1,
      });
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );
});

describe("before the availability seed writes a row", () => {
  let db: TestDatabase;
  let empty: Record<string, number>;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_availability_checks" });
  }, 120_000);

  // Dropping a schema can pass the hook default while other builders load the database (a resource guard only).
  afterAll(async () => {
    await db.drop();
  }, 120_000);

  it(
    "refuses to run before the core, setup, kinds, services and staff seeds, naming the one to run first, and writes nothing",
    { timeout: 240_000 },
    async () => {
      const zero = Object.fromEntries(TABLES.map((table) => [table, 0]));
      const noCore = await refusal(seedSetupAvailability(db.sql));
      expect(noCore.message).toContain("run db/seeds/core.ts first");
      expect(noCore.message).toContain("245 of 245 shops");
      expect(await rowCounts(db.sql)).toEqual(zero);

      await seedCore(db.sql);
      const noSetup = await refusal(seedSetupAvailability(db.sql));
      expect(noSetup.message).toContain("run db/seeds/setup-business.ts first");
      expect(noSetup.message).toContain("245 of 245 shops");

      await seedSetupBusiness(db.sql, { wrappingKeys: KEYS });
      const noKinds = await refusal(seedSetupAvailability(db.sql));
      expect(noKinds.message).toContain("run db/seeds/kinds.ts first");

      await seedKinds(db.sql);
      const noServices = await refusal(seedSetupAvailability(db.sql));
      expect(noServices.message).toContain("run db/seeds/setup-services-rules.ts first");
      expect(noServices.message).toContain("33 of 33 classes");

      await seedSetupServicesRules(db.sql);
      const noStaff = await refusal(seedSetupAvailability(db.sql));
      expect(noStaff.message).toContain("run db/seeds/setup-staff.ts first");
      expect(noStaff.message).toContain("245 of 245 shops");
      expect(await rowCounts(db.sql)).toEqual(zero);
    },
  );

  describe("with the core, setup, kinds, services and staff seeds' rows in place", () => {
    beforeAll(async () => {
      await seedSetupStaff(db.sql);
      empty = await rowCounts(db.sql);
    }, 120_000);

    it(
      "refuses a kind of work whose flow turns no2 on, whose owner is asked for no bill card, and writes nothing",
      SLOW,
      async () => {
        await db.sql`update kind_flows set switches_on = switches_on || '{no2}', version = version + 1
          where kind_id = 'yoga' and flow = 'A'`;
        const error = await refusal(seedSetupAvailability(db.sql));
        expect(error.message).toContain("turn no2 on");
        expect(await rowCounts(db.sql)).toEqual(empty);
        await db.sql`update kind_flows set switches_on = array_remove(switches_on, 'no2'), version = version + 1
          where kind_id = 'yoga' and flow = 'A'`;
      },
    );

    it(
      "checks the whole set against MANIFEST.sha256 first: one changed byte in a shop file stops it",
      SLOW,
      async () => {
        const copy = copyOfFixtureSet();
        const changed = `${SHOPS}/yoga.json`;
        flipOneByte(path.join(copy.v1, changed));
        const error = await refusal(seedFromCopy(db.sql, copy));
        expect(error).toBeInstanceOf(FixtureChecksumError);
        expect((error as FixtureChecksumError).problems).toEqual([`changed: ${changed}`]);
        expect(await rowCounts(db.sql)).toEqual(empty);
      },
    );

    it(
      "refuses an intact copy of fixture set v1 that lies outside fixtures/, and writes nothing",
      SLOW,
      async () => {
        const copy = copyOfFixtureSet();
        const error = await refusal(seedSetupAvailability(db.sql, { fixturesDir: copy.v1 }));
        expect(error).toBeInstanceOf(FixtureAccessError);
        expect(await rowCounts(db.sql)).toEqual(empty);
      },
    );

    it(
      "refuses, naming the file, listing hours it does not know how to read, rather than guess: other words, no demo mark, a span past midnight, a run of days past Sunday",
      SLOW,
      async () => {
        const cases: [string, (shop: Record<string, unknown>) => void, string][] = [
          ["barber", listingHours("[G] Mon-Fri 9am to 5pm (demo)"), "groups the seed knows"],
          ["yoga", listingHours("Mon-Fri 9am-5pm, Sat 10am-2pm"), "not a demo listing value"],
          ["plumber", listingHours("[G] Fri 6pm-2am (demo)"), "does not close after it opens"],
          ["dentist", listingHours("[G] Sat-Mon 9am-5pm (demo)"), "wraps past Sunday"],
        ];
        for (const [id, change, words] of cases) {
          const copy = copyOfFixtureSet();
          rewriteShop(copy, id, change);
          const error = await refusal(seedFromCopy(db.sql, copy));
          expect(error.message, words).toContain(`${SHOPS}/${id}.json`);
          expect(error.message, words).toContain(words);
          expect(error, words).not.toBeInstanceOf(FixtureChecksumError);
        }
        expect(await rowCounts(db.sql)).toEqual(empty);
      },
    );

    it(
      "loads from an untouched copy opened the same way, so each refusal above had its one reason",
      SLOW,
      async () => {
        const copy = copyOfFixtureSet();
        const result = await seedFromCopy(db.sql, copy);
        expect(result.ranAs).toBe("rosie_job");
        expect(result.tables.weekly_hours).toEqual({ rows: 245 * 6, inserted: 245 * 6, kept: 0 });
        expect(result.tables.bill_cards).toEqual({ rows: 245, inserted: 245, kept: 0 });
        const counts = await rowCounts(db.sql);
        expect(counts.classes).toBe(33);
      },
    );
  });
});
