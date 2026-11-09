// T-727: the staff seed from fixture set v1, against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/seeds/setup-staff`). Each top-level block migrates a fresh test schema of its own
// (db/repo/test-db.ts), runs the core, setup and kinds seeds (T-200, T-213, T-212) where it needs their rows, and drops
// the schema at the end; the shared public schema is never touched.
//
// The card's proofs: every demo shop with staff in its fixture has them joined and bookable; every flow B shop with on
// call has one on-call person; every value traces to a fixture set v1 file; no real phone number is committed (a grep
// test over the seed code and the shop files it reads, and over every phone row written); re-running is idempotent. Each
// expected row is built here, column by column, from the fixture files themselves (node:fs and node:crypto), never
// through the seed's own reader, and compared with the whole row the database holds. The wrapping key the setup seed
// seals the owners' ID uploads with is made here from random bytes for each run and is never written to a file or
// printed. Bytes are changed only in temporary copies of fixtures/v1 in the OS temp folder.
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_WRAPPING_KEY_NAME, type WrappingKeys } from "../repo/sealing";
import { type Sql, withBusiness } from "../repo/scope";
import { createTestDatabase, type TestDatabase } from "../repo/test-db";
import { seedCore } from "./core";
import { seedKinds } from "./kinds";
import { FICTIONAL_AREA_CODES } from "./lib/demo-shops";
import { FixtureAccessError, FixtureChecksumError, openFixtureSet } from "./lib/fixture-set";
import { seedSetupBusiness } from "./setup-business";
import {
  DEMO_TEAM_PER_FLOW,
  seedSetupStaff,
  seedSetupStaffFrom,
  STAFF_AREA_CODES,
  type StaffSeedResult,
} from "./setup-staff";

const SLOW = { timeout: 120_000 };
const REPO = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const V1 = path.join(REPO, "fixtures/v1");
const SHOPS = "test-kit/shops";
const TABLES = [
  "persons",
  "handles",
  "person_handles",
  "phones",
  "person_roles",
  "staff",
  "staff_skills",
  "on_call",
] as const;
const FLOWS = ["A", "B"] as const;
const TEST_MIXED_KIND: Record<string, string> = { "test-mixed-A": "barber", "test-mixed-B": "plumber" };
// The fiction range: 555-0100 to 555-0199 in an area code, as E.164 (NANP keeps it for fiction).
const FICTIONAL = /^\+1[2-9][0-9]{2}55501[0-9]{2}$/;
// Anything written like a North American phone number: +1 optional, then area code, exchange and line, with or
// without spaces, dots, dashes or brackets, and no letter or digit straight before or after it.
const PHONE_LIKE = /(?<![\w+])(?:\+?1[\s.-]?)?\(?[2-9][0-9]{2}\)?[\s.-]?[0-9]{3}[\s.-]?[0-9]{4}(?!\w)/g;

/** One wrapping key per run for the setup seed's ID uploads: random, in memory only, under the Workers secret's name. */
const WRAP_BYTES = crypto.getRandomValues(new Uint8Array(32));
const KEYS: WrappingKeys = {
  resolve: (name) => (name === DEFAULT_WRAPPING_KEY_NAME ? WRAP_BYTES : undefined),
};

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const sorted = (values: Iterable<string>): string[] => [...values].sort();

interface ShopFile {
  id: string;
  flows: Record<string, { staff?: unknown } | undefined>;
  facts?: string[];
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

/**
 * The demo shop files of fixture set v1, read here: shop id (its file name) to the file, in code-point order of id (the
 * ids, not the file names: "hair" comes before "hair-restoration", while "hair-restoration.json" comes first).
 */
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

/** Whether a shop is one profession: its owner form is listed (forms/<id>.json). */
const hasForm = (id: string): boolean => LISTED.has(`forms/${id}.json`);
const flowsOf = (shop: ShopFile): string[] => FLOWS.filter((flow) => flow in shop.flows);
/** The flows whose staff field is text: the flows that name staff. */
const teamFlowsOf = (shop: ShopFile): string[] =>
  flowsOf(shop).filter((flow) => {
    const staff = shop.flows[flow]?.staff;
    return typeof staff === "string" && staff.trim() !== "";
  });
/** A shop's kind of work: its id for a profession, else the services seed's default (barber or plumber). */
const kindOf = (shop: ShopFile): string => (hasForm(shop.id) ? shop.id : (TEST_MIXED_KIND[shop.id] ?? ""));
/** A shop's facts: its own list, or for insurance cpa's (Master Corrections C5), as the setup seed reads them. */
function factsOf(shop: ShopFile): string[] {
  const facts = shop.facts ?? [];
  if (facts.length === 0 && shop.id === "insurance") {
    return SHOP_FILES.get("cpa")?.facts ?? [];
  }
  return facts;
}
/** Whether a shop takes jobs sent now in flow B: it has flow B and its facts list sentnow (S2-30). */
const onCallShop = (shop: ShopFile): boolean =>
  flowsOf(shop).includes("B") && factsOf(shop).includes("sentnow");

interface Member {
  shopId: string;
  flow: string;
  position: number;
  key: string;
  number: string;
}

/** Every team member the files call for, in the seed's order, with the fictional mobile each one takes. */
function expectedMembers(): Member[] {
  const members: Member[] = [];
  for (const shop of SHOP_FILES.values()) {
    for (const flow of teamFlowsOf(shop)) {
      for (let position = 1; position <= DEMO_TEAM_PER_FLOW; position += 1) {
        const index = members.length;
        const areaCode = STAFF_AREA_CODES[Math.floor(index / 100)] ?? "none";
        members.push({
          shopId: shop.id,
          flow,
          position,
          key: `${shop.id}-${flow.toLowerCase()}-${String(position)}`,
          number: `+1${areaCode}55501${String(index % 100).padStart(2, "0")}`,
        });
      }
    }
  }
  return members;
}

const MEMBERS = expectedMembers();

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
    persons: [...(await sql`select * from persons order by id`)],
    handles: [...(await sql`select * from handles order by id`)],
    person_handles: [...(await sql`select * from person_handles order by person_id, handle_id`)],
    phones: [...(await sql`select * from phones order by number`)],
    person_roles: [...(await sql`select * from person_roles order by id`)],
    staff: [...(await sql`select * from staff order by id`)],
    staff_skills: [...(await sql`select * from staff_skills order by id`)],
    on_call: [...(await sql`select * from on_call order by id`)],
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

/** Every file under a folder of the repository, recursively. */
function filesIn(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const file = path.join(folder, name);
    return statSync(file).isDirectory() ? filesIn(file) : [file];
  });
}

/** The digits of a phone-like match, without the country code: 10 digits for a North American number. */
function nationalDigits(match: string): string {
  const digits = match.replace(/[^0-9]/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

interface Copy {
  root: string;
  fixtures: string;
  v1: string;
}

const copies: string[] = [];

/** A byte-for-byte copy of fixtures/v1 at <temp>/fixtures/v1. */
function copyOfFixtureSet(): Copy {
  const root = mkdtempSync(path.join(tmpdir(), "rosie-seed-staff-"));
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

/** A shop's flow block in a copy being rewritten. */
function flowOf(shop: Record<string, unknown>, flow: string): Record<string, unknown> {
  return (shop.flows as Record<string, Record<string, unknown>>)[flow] ?? {};
}

function seedFromCopy(sql: Sql, copy: Copy): Promise<StaffSeedResult> {
  return seedSetupStaffFrom(sql, openFixtureSet(copy.v1, { jail: copy.fixtures }));
}

afterAll(() => {
  for (const root of copies) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("the staff seed, loaded from fixture set v1 after the core, setup and kinds seeds", () => {
  let db: TestDatabase;
  let first: StaffSeedResult;
  let seededAt: Date;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_staff" });
    await seedCore(db.sql);
    await seedSetupBusiness(db.sql, { wrappingKeys: KEYS });
    await seedKinds(db.sql);
    first = await seedSetupStaff(db.sql);
    seededAt = await fixtureSetMade(db.sql);
  }, 180_000);

  // Dropping a schema can pass the hook default while other builders load the database (a resource guard only).
  afterAll(async () => {
    await db.drop();
  }, 120_000);

  it("seeds a team of two for every flow whose shop file names staff, and none for the 45 shops whose casts name nobody or for test-mixed-A and -B", () => {
    expect(SHOP_FILES.size).toBe(245);
    expect(first.shops.map((shop) => shop.shopId)).toEqual([...SHOP_FILES.keys()]);
    const withTeam = [...SHOP_FILES.values()].filter((shop) => teamFlowsOf(shop).length > 0);
    // Every profession's cast names staff in both of its flows, or in neither; the test-mixed shops have no cast.
    for (const shop of SHOP_FILES.values()) {
      expect([0, flowsOf(shop).length], shop.id).toContain(teamFlowsOf(shop).length);
    }
    expect(withTeam).toHaveLength(198);
    expect(245 - withTeam.length).toBe(47);
    const flowsWithTeam = withTeam.reduce((sum, shop) => sum + teamFlowsOf(shop).length, 0);
    expect(flowsWithTeam).toBe(396);
    const people = flowsWithTeam * DEMO_TEAM_PER_FLOW;
    expect(MEMBERS).toHaveLength(people);
    for (const table of [
      "persons",
      "handles",
      "person_handles",
      "phones",
      "person_roles",
      "staff",
    ] as const) {
      expect(first.tables[table], table).toEqual({ rows: people, inserted: people, kept: 0 });
    }
    // One skill row per team member and per owner; one on-call row per flow B shop whose facts list sentnow.
    expect(first.tables.staff_skills).toEqual({ rows: people + 245, inserted: people + 245, kept: 0 });
    expect(first.tables.on_call).toEqual({ rows: 21, inserted: 21, kept: 0 });
  });

  it("every demo shop with staff in its fixture has them joined and bookable: each team member is a person of their own with the staff role, writing from their own fictional mobile, added, joined from that mobile and bookable on the owner's yes, dated when fixture set v1 was made", async () => {
    expect(Number.isNaN(seededAt.getTime())).toBe(false);
    const staff = await db.sql<Record<string, unknown>[]>`select * from staff order by id`;
    const staffOf = new Map(staff.map((row) => [String(row.id), row]));
    const persons = new Map(
      (await db.sql<Record<string, unknown>[]>`select * from persons`).map((row) => [String(row.id), row]),
    );
    const roles = new Map(
      (await db.sql<Record<string, unknown>[]>`select * from person_roles`).map((row) => [
        String(row.id),
        row,
      ]),
    );
    const handles = new Map(
      (await db.sql<Record<string, unknown>[]>`select * from handles`).map((row) => [String(row.id), row]),
    );
    const links = new Set(
      (await db.sql<{ key: string }[]>`select person_id || ' ' || handle_id as key from person_handles`).map(
        (row) => row.key,
      ),
    );
    const phones = new Map(
      (await db.sql<Record<string, unknown>[]>`select * from phones`).map((row) => [String(row.number), row]),
    );
    for (const member of MEMBERS) {
      const businessId = `biz-demo-${member.shopId}`;
      const owner = `person-demo-${member.shopId}-owner`;
      const personId = `person-demo-${member.key}`;
      const handleId = `handle-demo-${member.key}`;
      expect(staffOf.get(`staff-demo-${member.key}`), member.key).toEqual({
        id: `staff-demo-${member.key}`,
        business_id: businessId,
        person_id: personId,
        mobile: member.number,
        agreed_to_text_ticked_at: seededAt,
        agreed_ticked_by_person_id: owner,
        status: "joined",
        added_at: seededAt,
        joined_at: seededAt,
        joined_from_number: member.number,
        stopped_at: null,
        wrong_number_at: null,
        languages: [],
        day_list_time: null,
        video_link: null,
        calls_customer_mobile: false,
        supervisor_staff_id: null,
        bookable_at: seededAt,
        bookable_by_person_id: owner,
        version: 1,
      });
      // No name or language is taken from a fixture: both stay null until known, as the owners' do.
      expect(persons.get(personId), member.key).toEqual({
        id: personId,
        name: null,
        language: null,
        version: 1,
      });
      expect(roles.get(`role-demo-${member.key}`), member.key).toEqual({
        id: `role-demo-${member.key}`,
        person_id: personId,
        business_id: businessId,
        role: "staff",
        ended_at: null,
        version: 1,
      });
      expect(handles.get(handleId), member.key).toEqual({
        id: handleId,
        kind: "phone",
        address: member.number,
      });
      expect(links.has(`${personId} ${handleId}`), member.key).toBe(true);
      expect(phones.get(member.number), member.key).toEqual({
        number: member.number,
        handle_id: handleId,
        chat_open: false,
        chat_open_at: null,
        chat_way: null,
        stopped: false,
        stop_at: null,
        start_at: null,
        linq_contact_added_at: null,
        poll_voted_at: null,
        optout_line_delivered_at: null,
        version: 1,
      });
    }
    // Each business holds its owner's row and its teams' rows, and nothing else; the owner's row is the setup seed's,
    // untouched.
    for (const shop of SHOP_FILES.values()) {
      const ids = staff
        .filter((row) => row.business_id === `biz-demo-${shop.id}`)
        .map((row) => String(row.id));
      expect(sorted(ids), shop.id).toEqual(
        sorted([
          `staff-demo-${shop.id}-owner`,
          ...MEMBERS.filter((member) => member.shopId === shop.id).map(
            (member) => `staff-demo-${member.key}`,
          ),
        ]),
      );
      expect(staffOf.get(`staff-demo-${shop.id}-owner`), shop.id).toMatchObject({
        person_id: `person-demo-${shop.id}-owner`,
        status: "joined",
        bookable_at: seededAt,
        version: 1,
      });
    }
    // Spot check against plumber.json: "Kenny and Ray (plumbers at the counter)" in flow A and "Marcus and Dre
    // (plumbers)" in flow B give two people each, and their words are not stored.
    expect(first.shops.find((shop) => shop.shopId === "plumber")?.teams).toEqual([
      expect.objectContaining({ flow: "A", at: "flows.A.staff", place: "business" }),
      expect.objectContaining({ flow: "B", at: "flows.B.staff", place: "customer" }),
    ]);
  });

  it("gives every staff row its work: each team member and each owner takes the shop's kind of work as a whole, so only they are offered for it", async () => {
    const skills = await db.sql<Record<string, unknown>[]>`select * from staff_skills order by id`;
    const expected = [
      ...[...SHOP_FILES.values()].map((shop) => ({
        id: `skill-demo-${shop.id}-owner-${kindOf(shop)}`,
        staff_id: `staff-demo-${shop.id}-owner`,
        business_id: `biz-demo-${shop.id}`,
        kind_id: kindOf(shop),
        skill: null,
      })),
      ...MEMBERS.map((member) => {
        const kind = kindOf(SHOP_FILES.get(member.shopId) ?? { id: "", flows: {} });
        return {
          id: `skill-demo-${member.key}-${kind}`,
          staff_id: `staff-demo-${member.key}`,
          business_id: `biz-demo-${member.shopId}`,
          kind_id: kind,
          skill: null,
        };
      }),
    ];
    expect(skills).toHaveLength(expected.length);
    const skillOf = new Map(skills.map((row) => [String(row.id), row]));
    for (const row of expected) {
      expect(skillOf.get(row.id), row.id).toEqual(row);
    }
    // Every staff row has exactly one skill row, of its own business.
    const [orphans] = await db.sql<{ unskilled: number; doubled: number }[]>`
      select
        (select count(*)::int from staff s where not exists (
          select 1 from staff_skills k where k.staff_id = s.id and k.business_id = s.business_id)) as unskilled,
        (select count(*)::int from (select staff_id from staff_skills group by staff_id having count(*) > 1) d) as doubled
    `;
    expect(orphans).toEqual({ unskilled: 0, doubled: 0 });
    // test-mixed-A and -B take the kinds their services are filed under (T-214 default 8).
    expect(skillOf.get("skill-demo-test-mixed-A-owner-barber")).toMatchObject({ kind_id: "barber" });
    expect(skillOf.get("skill-demo-test-mixed-B-owner-plumber")).toMatchObject({ kind_id: "plumber" });
  });

  it("every flow B shop with on call has one on-call person: the 21 whose facts list sentnow, each with one row for open hours on every day, naming the first of its flow B team, or its owner where the cast names no one; no other shop has any", async () => {
    const rows = await db.sql<Record<string, unknown>[]>`
      select id, business_id, kind_id, staff_id, hours, days, holidays, from_time, until_time, version
      from on_call order by id
    `;
    const onCall = [...SHOP_FILES.values()].filter(onCallShop);
    expect(onCall).toHaveLength(21);
    expect(rows).toHaveLength(21);
    const rowOf = new Map(rows.map((row) => [String(row.business_id), row]));
    const solo: string[] = [];
    for (const shop of onCall) {
      const hasTeamB = teamFlowsOf(shop).includes("B");
      if (!hasTeamB) {
        solo.push(shop.id);
      }
      const staffId = hasTeamB ? `staff-demo-${shop.id}-b-1` : `staff-demo-${shop.id}-owner`;
      expect(rowOf.get(`biz-demo-${shop.id}`), shop.id).toEqual({
        id: `oncall-demo-${shop.id}-open-hours`,
        business_id: `biz-demo-${shop.id}`,
        kind_id: shop.id,
        staff_id: staffId,
        hours: "open",
        days: [1, 2, 3, 4, 5, 6, 7],
        holidays: false,
        from_time: null,
        until_time: null,
        version: 1,
      });
    }
    // The three whose casts name nobody: the owner, who works alone, takes them (S1-21).
    expect(sorted(solo)).toEqual(["aquarium", "contractor", "restoration"]);
    expect(rowOf.get("biz-demo-plumber")?.staff_id).toBe("staff-demo-plumber-b-1");
    // Each person on call is one person, joined, bookable and cleared for the kind of work the row names.
    const [check] = await db.sql<{ shops: number; people: number; ready: number }[]>`
      select count(distinct o.business_id)::int as shops, count(distinct o.staff_id)::int as people,
        count(*) filter (
          where s.status = 'joined' and s.bookable_at is not null
            and exists (select 1 from staff_skills k
              where k.staff_id = s.id and k.kind_id = o.kind_id and k.skill is null)
        )::int as ready
      from on_call o join staff s on s.id = o.staff_id and s.business_id = o.business_id
    `;
    expect(check).toEqual({ shops: 21, people: 21, ready: 21 });
    for (const shop of first.shops) {
      const file = SHOP_FILES.get(shop.shopId);
      expect(shop.onCall === null, shop.shopId).toBe(file === undefined || !onCallShop(file));
    }
  });

  it("no real phone number is committed: every phone-like string in the seed code and in the shop files it reads is in the fiction range, and so is every phone row written", async () => {
    const files = [
      ...filesIn(path.join(REPO, "db/seeds")),
      ...filesIn(path.join(V1, SHOPS)),
      path.join(V1, "test-kit/COVERAGE.md"),
    ];
    expect(files).toContain(path.join(REPO, "db/seeds/setup-staff.ts"));
    expect(files).toContain(path.join(REPO, "db/seeds/setup-staff.int.test.ts"));
    const notFictional: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(PHONE_LIKE)) {
        if (!FICTIONAL.test(`+1${nationalDigits(match[0])}`)) {
          notFictional.push(`${path.relative(REPO, file)}: ${match[0]}`);
        }
      }
    }
    expect(notFictional).toEqual([]);
    // The grep catches a number written any common way. The samples are built here from parts, so this file holds no
    // phone-like string: a non-fictional one in area code 555, which serves no one, and a fictional one.
    const parts = ["555", "123", "4567"];
    const fiction = ["212", "555", "0123"];
    for (const [written, isFiction] of [
      [`+1 ${parts.join(" ")}`, false],
      [`(${parts[0] ?? ""}) ${parts[1] ?? ""}-${parts[2] ?? ""}`, false],
      [parts.join("."), false],
      [`+1${parts.join("")}`, false],
      [`+1 ${fiction.join(" ")}`, true],
      [`(${fiction[0] ?? ""}) ${fiction[1] ?? ""}-${fiction[2] ?? ""}`, true],
    ] as const) {
      const matches = [...written.matchAll(PHONE_LIKE)].map((match) => match[0]);
      expect(matches, written).toEqual([written]);
      expect(FICTIONAL.test(`+1${nationalDigits(written)}`), written).toBe(isFiction);
    }

    const numbers = (await db.sql<{ number: string }[]>`select number from phones`).map((row) => row.number);
    expect(numbers).toHaveLength(245 + MEMBERS.length);
    for (const number of numbers) {
      expect(number).toMatch(FICTIONAL);
    }
    expect(new Set(numbers).size).toBe(numbers.length);
    // The team's mobiles are in area codes the owners' are not.
    const ownerCodes: readonly string[] = FICTIONAL_AREA_CODES;
    const staffCodes: readonly string[] = STAFF_AREA_CODES;
    expect(staffCodes.filter((code) => ownerCodes.includes(code))).toEqual([]);
    for (const member of MEMBERS) {
      expect(staffCodes, member.key).toContain(member.number.slice(2, 5));
    }
  });

  it("traces every shop to its fixture set v1 file at the hash MANIFEST.sha256 lists, each team to the flow whose staff field names it, each on-call row to the file's sentnow fact, and each kind to the shop's id or the named default", async () => {
    expect(first.fixtureSet.manifestSha256).toBe(sha256(path.join(V1, "MANIFEST.sha256")));
    expect(first.fixtureSet.filesChecked).toBe(LISTED.size);
    expect(first.seededAt).toEqual({ at: seededAt, source: "test-kit/COVERAGE.md" });
    expect(LISTED.has(first.seededAt.source)).toBe(true);
    for (const shop of first.shops) {
      const file = SHOP_FILES.get(shop.shopId);
      expect(file, shop.shopId).toBeDefined();
      if (file === undefined) {
        continue;
      }
      expect(shop.source).toBe(`${SHOPS}/${shop.shopId}.json`);
      expect(LISTED.get(shop.source), shop.source).toBe(shop.sha256);
      expect(sha256(path.join(V1, shop.source)), shop.source).toBe(shop.sha256);
      expect(
        [shop.businessId, shop.ownerPersonId, shop.ownerStaffId, shop.ownerSkillId],
        shop.source,
      ).toEqual([
        `biz-demo-${shop.shopId}`,
        `person-demo-${shop.shopId}-owner`,
        `staff-demo-${shop.shopId}-owner`,
        `skill-demo-${shop.shopId}-owner-${kindOf(file)}`,
      ]);
      expect([shop.kindId, shop.kindFrom], shop.source).toEqual(
        hasForm(shop.shopId) ? [shop.shopId, "pick"] : [TEST_MIXED_KIND[shop.shopId], "default"],
      );
      expect(shop.flows, shop.source).toEqual(flowsOf(file));
      expect(
        shop.teams.map((team) => team.flow),
        shop.source,
      ).toEqual(teamFlowsOf(file));
      for (const team of shop.teams) {
        const staff = file.flows[team.flow]?.staff;
        expect(team.at, shop.source).toBe(`flows.${team.flow}.staff`);
        expect(typeof staff === "string" && staff.trim() !== "", `${shop.source} ${team.at}`).toBe(true);
        expect(team.place, shop.source).toBe(team.flow === "A" ? "business" : "customer");
        expect(
          team.members.map((member) => member.staffId),
          shop.source,
        ).toEqual(
          MEMBERS.filter((member) => member.shopId === shop.shopId && member.flow === team.flow).map(
            (member) => `staff-demo-${member.key}`,
          ),
        );
      }
      if (shop.onCall !== null) {
        expect(factsOf(file), shop.source).toContain(shop.onCall.fact);
        expect(flowsOf(file), shop.source).toContain("B");
        expect(shop.onCall.who, shop.source).toBe(teamFlowsOf(file).includes("B") ? "team" : "owner");
      }
    }

    // Every row of every table is one shop's, and every shop's keys are in the tables.
    const keys = async (rows: Promise<readonly { key: string }[]>): Promise<string[]> =>
      sorted((await rows).map((row) => row.key));
    const sql = db.sql;
    const members = first.shops.flatMap((shop) => shop.teams.flatMap((team) => team.members));
    expect(
      await keys(sql<{ key: string }[]>`select id as key from staff where id not like '%-owner'`),
    ).toEqual(sorted(members.map((member) => member.staffId)));
    expect(
      await keys(
        sql<{ key: string }[]>`select id || ' ' || mobile as key from staff where id not like '%-owner'`,
      ),
    ).toEqual(sorted(members.map((member) => `${member.staffId} ${member.phoneNumber}`)));
    expect(await keys(sql<{ key: string }[]>`select id as key from staff_skills`)).toEqual(
      sorted([...first.shops.map((shop) => shop.ownerSkillId), ...members.map((member) => member.skillId)]),
    );
    expect(await keys(sql<{ key: string }[]>`select id || ' ' || staff_id as key from on_call`)).toEqual(
      sorted(
        first.shops.flatMap((shop) =>
          shop.onCall === null ? [] : [`${shop.onCall.id} ${shop.onCall.staffId}`],
        ),
      ),
    );
  });

  it("writes as the job role, rosie_job, with no scope; under row-level security a shop's scope shows the Tool API role that shop's team, skills and on-call row only", async () => {
    expect(first.ranAs).toBe("rosie_job");
    const plumber = first.shops.find((shop) => shop.shopId === "plumber");
    const seen = await withBusiness(db.sql, plumber?.businessId ?? "", async (tx) => {
      await tx`set local role rosie_app`;
      const read = async (table: string): Promise<string[]> =>
        (await tx<{ key: string }[]>`select id as key from ${tx(table)} order by 1`).map((row) => row.key);
      return {
        staff: await read("staff"),
        staff_skills: await read("staff_skills"),
        on_call: await read("on_call"),
      };
    });
    expect(seen).toEqual({
      staff: sorted([
        "staff-demo-plumber-owner",
        "staff-demo-plumber-a-1",
        "staff-demo-plumber-a-2",
        "staff-demo-plumber-b-1",
        "staff-demo-plumber-b-2",
      ]),
      staff_skills: sorted([
        "skill-demo-plumber-owner-plumber",
        "skill-demo-plumber-a-1-plumber",
        "skill-demo-plumber-a-2-plumber",
        "skill-demo-plumber-b-1-plumber",
        "skill-demo-plumber-b-2-plumber",
      ]),
      on_call: ["oncall-demo-plumber-open-hours"],
    });
  });

  it(
    "running the seed twice leaves the same rows: the second run writes nothing, and every row and version stays as it was",
    SLOW,
    async () => {
      const before = await snapshot(db.sql);
      const second = await seedSetupStaff(db.sql);
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
      await db.sql`delete from on_call where id = 'oncall-demo-plumber-open-hours'`;
      await db.sql`delete from staff_skills where id in ('skill-demo-yoga-b-2-yoga', 'skill-demo-yoga-owner-yoga')`;
      await db.sql`delete from staff where id = 'staff-demo-yoga-b-2'`;
      await db.sql`delete from person_roles where id = 'role-demo-yoga-b-2'`;
      const third = await seedSetupStaff(db.sql);
      expect([
        third.tables.on_call.inserted,
        third.tables.staff_skills.inserted,
        third.tables.staff.inserted,
        third.tables.person_roles.inserted,
        third.tables.persons.inserted,
        third.tables.phones.inserted,
      ]).toEqual([1, 2, 1, 1, 0, 0]);
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );
});

describe("before the staff seed writes a row", () => {
  let db: TestDatabase;
  let empty: Record<string, number>;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_staff_checks" });
  }, 120_000);

  // Dropping a schema can pass the hook default while other builders load the database (a resource guard only).
  afterAll(async () => {
    await db.drop();
  }, 120_000);

  it(
    "refuses to run before the core, setup and kinds seeds, naming the one to run first, and writes nothing",
    SLOW,
    async () => {
      const noCore = await refusal(seedSetupStaff(db.sql));
      expect(noCore.message).toContain("run db/seeds/core.ts first");
      expect(noCore.message).toContain("245 of 245 shops");
      expect(await rowCounts(db.sql)).toEqual(Object.fromEntries(TABLES.map((table) => [table, 0])));

      await seedCore(db.sql);
      const noSetup = await refusal(seedSetupStaff(db.sql));
      expect(noSetup.message).toContain("run db/seeds/setup-business.ts first");
      expect(noSetup.message).toContain("245 of 245 shops");

      await seedSetupBusiness(db.sql, { wrappingKeys: KEYS });
      empty = await rowCounts(db.sql);
      const noKinds = await refusal(seedSetupStaff(db.sql));
      expect(noKinds.message).toContain("run db/seeds/kinds.ts first");
      expect(await rowCounts(db.sql)).toEqual(empty);
      // Only the core and setup seeds' rows: 245 owners, their staff rows, and no skill or on-call row.
      expect(empty).toMatchObject({ persons: 245, staff: 245, staff_skills: 0, on_call: 0 });
    },
  );

  describe("with the core, setup and kinds seeds' rows in place", () => {
    beforeAll(async () => {
      await seedKinds(db.sql);
      empty = await rowCounts(db.sql);
    }, 120_000);

    it(
      "checks the whole set against MANIFEST.sha256 first: one changed byte in a shop file stops it",
      SLOW,
      async () => {
        const copy = copyOfFixtureSet();
        const changed = `${SHOPS}/plumber.json`;
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
        const error = await refusal(seedSetupStaff(db.sql, { fixturesDir: copy.v1 }));
        expect(error).toBeInstanceOf(FixtureAccessError);
        expect(await rowCounts(db.sql)).toEqual(empty);
      },
    );

    it(
      "refuses, naming the file, a staff field it does not know how to read, rather than guess: a number, empty words, a flow that is not an object",
      SLOW,
      async () => {
        const cases: [string, (shop: Record<string, unknown>) => void, string][] = [
          [
            "barber",
            (shop) => {
              flowOf(shop, "A").staff = 2;
            },
            "flows.A.staff is neither text nor null",
          ],
          [
            "yoga",
            (shop) => {
              flowOf(shop, "B").staff = " ";
            },
            "flows.B.staff is neither text nor null",
          ],
          [
            "plumber",
            (shop) => {
              (shop.flows as Record<string, unknown>).B = "Marcus and Dre";
            },
            "flows.B is not an object",
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
        expect(result.tables.staff).toEqual({
          rows: MEMBERS.length,
          inserted: MEMBERS.length,
          kept: 0,
        });
        const counts = await rowCounts(db.sql);
        expect(counts.staff).toBe(245 + MEMBERS.length);
        expect(counts.on_call).toBe(21);
      },
    );
  });
});
