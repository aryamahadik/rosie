// T-200: the core seed from fixture set v1, against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/seeds/core`). Each top-level block migrates a fresh test schema of its own
// (db/repo/test-db.ts) and drops it at the end; the shared public schema is never touched.
//
// The card's proofs: 245 business heads, one owner each, every row traceable to a fixture set v1 file; running the seed
// twice leaves the same rows; it refuses to read anything outside fixtures/; it checks fixtures/ against its SHA256SUMS
// (fixture set v1's manifest, fixtures/v1/MANIFEST.sha256, from T-002) before loading and stops on a mismatch.
//
// What the rows must be is read here from the fixture files and the manifest themselves (node:fs, node:crypto), never
// through the seed's own reader. Bytes are changed only in temporary copies of fixtures/v1 in the OS temp folder.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Sql, withBusiness } from "../repo/scope";
import { createTestDatabase, type TestDatabase } from "../repo/test-db";
import { type CoreSeedResult, seedCore, seedCoreFrom } from "./core";
import { FixtureAccessError, FixtureChecksumError, openFixtureSet } from "./lib/fixture-set";

const SLOW = { timeout: 120_000 };
const V1 = path.resolve(fileURLToPath(new URL("../../fixtures/v1", import.meta.url)));
const SHOPS = "test-kit/shops";
const TABLES = ["businesses", "persons", "person_roles", "handles", "person_handles", "phones"] as const;
const EMPTY = Object.fromEntries(TABLES.map((table) => [table, 0]));
const ALL_SEEDED = Object.fromEntries(TABLES.map((table) => [table, 245]));
// The fiction range: 555-0100 to 555-0199 in an area code, as E.164.
const FICTIONAL = /^\+1[2-9][0-9]{2}55501[0-9]{2}$/;

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const sorted = (values: Iterable<string>): string[] => [...values].sort();

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

/** The demo shop files of fixture set v1, read here: shop id (its file name) to the shop's `id` and `name`. */
function shopFiles(): Map<string, { id: unknown; name: unknown }> {
  const shops = new Map<string, { id: unknown; name: unknown }>();
  for (const file of readdirSync(path.join(V1, SHOPS)).filter((name) => name.endsWith(".json"))) {
    const shop = JSON.parse(readFileSync(path.join(V1, SHOPS, file), "utf8")) as {
      id: unknown;
      name: unknown;
    };
    shops.set(file.slice(0, -".json".length), { id: shop.id, name: shop.name });
  }
  return shops;
}

async function rowCounts(sql: Sql): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
    counts[table] = row?.n ?? -1;
  }
  return counts;
}

/** Every row of the six tables, in key order, as plain arrays. */
async function snapshot(sql: Sql): Promise<Record<string, unknown[]>> {
  return {
    businesses: [...(await sql`select * from businesses order by id`)],
    persons: [...(await sql`select * from persons order by id`)],
    person_roles: [...(await sql`select * from person_roles order by id`)],
    handles: [...(await sql`select * from handles order by id`)],
    person_handles: [...(await sql`select * from person_handles order by person_id, handle_id`)],
    phones: [...(await sql`select * from phones order by number`)],
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
  /** The temporary folder. */
  root: string;
  /** Its fixtures/ folder: the jail the copy is opened with. */
  fixtures: string;
  /** The copy of fixtures/v1. */
  v1: string;
}

const copies: string[] = [];

/** A byte-for-byte copy of fixtures/v1 at <temp>/fixtures/v1. */
function copyOfFixtureSet(): Copy {
  const root = mkdtempSync(path.join(tmpdir(), "rosie-seed-core-"));
  copies.push(root);
  const fixtures = path.join(root, "fixtures");
  const v1 = path.join(fixtures, "v1");
  cpSync(V1, v1, { recursive: true });
  return { root, fixtures, v1 };
}

/** The seed on a folder, opened with `jail` as the folder no read may leave. Opening may refuse: a rejection, too. */
async function seedFromFolder(sql: Sql, dir: string, jail: string): Promise<CoreSeedResult> {
  return seedCoreFrom(sql, openFixtureSet(dir, { jail }));
}

/** The seed on a copy, opened with the copy's own fixtures/ folder as its jail. */
function seedFromCopy(sql: Sql, copy: Copy): Promise<CoreSeedResult> {
  return seedFromFolder(sql, copy.v1, copy.fixtures);
}

/** Flips one bit of the byte in the middle of a file (doing it twice restores the file). */
function flipOneByte(file: string): void {
  const bytes = readFileSync(file);
  const at = Math.floor(bytes.length / 2);
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  writeFileSync(file, bytes);
}

afterAll(() => {
  for (const root of copies) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("the core seed, loaded from fixture set v1", () => {
  let db: TestDatabase;
  let first: CoreSeedResult;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_core" });
    first = await seedCore(db.sql);
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  it("loads 245 business heads: the 243 demo shops of test-kit/shops/, each with its owner form, plus test-mixed-A and test-mixed-B", async () => {
    const shops = shopFiles();
    expect(shops.size).toBe(245);
    const demo = [...shops.keys()].filter((id) => id !== "test-mixed-A" && id !== "test-mixed-B");
    expect(demo).toHaveLength(243);
    const listed = manifest();
    for (const id of demo) {
      expect(listed.has(`forms/${id}.json`), id).toBe(true);
    }

    expect(first.tables.businesses).toEqual({ rows: 245, inserted: 245, kept: 0 });
    const rows = await db.sql<
      {
        id: string;
        name: string;
        display_name: string;
        status: string;
        time_zone: string;
        text_hours_start: string;
        text_hours_end: string;
        version: number;
      }[]
    >`select * from businesses order by id`;
    expect(rows).toHaveLength(245);
    const shopOf = new Map(first.shops.map((shop) => [shop.businessId, shop.shopId]));
    expect(sorted(shopOf.values())).toEqual(sorted(shops.keys()));
    for (const row of rows) {
      const shopId = shopOf.get(row.id) ?? "";
      expect(row.id, shopId).toBe(`biz-demo-${shopId}`);
      // The shop's own name, from its file; the display name starts as the name (owner form B02).
      expect(row.name, row.id).toBe(shops.get(shopId)?.name);
      expect(row.display_name, row.id).toBe(row.name);
      // The table's defaults: offline until the setup seeds; text hours 8 to 8; QUESTIONS.md Q-54's zone.
      expect(
        [row.status, row.time_zone, row.text_hours_start, row.text_hours_end, row.version],
        row.id,
      ).toEqual(["offline", "America/New_York", "08:00:00", "20:00:00", 1]);
    }
  });

  it("gives each business exactly one owner: a person of its own with the owner role, writing from a handle of kind phone that has the mobile's phone row", async () => {
    const roles = await db.sql<{ business_id: string; roles: number; live_owners: number }[]>`
      select b.id as business_id,
        (select count(*)::int from person_roles r where r.business_id = b.id) as roles,
        (select count(*)::int from person_roles r
          where r.business_id = b.id and r.role = 'owner' and r.ended_at is null) as live_owners
      from businesses b order by b.id
    `;
    expect(roles).toHaveLength(245);
    for (const row of roles) {
      expect([row.roles, row.live_owners], row.business_id).toEqual([1, 1]);
    }

    const owners = await db.sql<
      {
        business_id: string;
        person_id: string;
        person_roles: number;
        person_handles: number;
        name: string | null;
        language: string | null;
        kind: string;
        address: string;
        number: string;
        stopped: boolean;
        chat_open: boolean;
        version: number;
      }[]
    >`
      select b.id as business_id, r.person_id,
        (select count(*)::int from person_roles x where x.person_id = r.person_id) as person_roles,
        (select count(*)::int from person_handles x where x.person_id = r.person_id) as person_handles,
        pe.name, pe.language, h.kind, h.address, p.number, p.stopped, p.chat_open, p.version
      from businesses b
      join person_roles r on r.business_id = b.id
      join persons pe on pe.id = r.person_id
      join person_handles ph on ph.person_id = r.person_id
      join handles h on h.id = ph.handle_id
      join phones p on p.handle_id = h.id
      order by b.id
    `;
    expect(owners).toHaveLength(245);
    expect(new Set(owners.map((owner) => owner.person_id)).size).toBe(245);
    for (const owner of owners) {
      expect(owner, owner.business_id).toEqual({
        business_id: owner.business_id,
        person_id: owner.person_id,
        person_roles: 1,
        person_handles: 1,
        // The shop files name no owner (Sam in their stories is the master's sample owner: MC C6).
        name: null,
        language: null,
        kind: "phone",
        address: owner.number,
        number: owner.number,
        stopped: false,
        chat_open: false,
        version: 1,
      });
    }
  });

  it("traces every row of the six tables to a fixture set v1 file listed in MANIFEST.sha256 at the hash it has now", async () => {
    const listed = manifest();
    expect(first.fixtureSet).toEqual({
      dir: realpathSync(V1),
      manifestSha256: sha256(path.join(V1, "MANIFEST.sha256")),
      filesChecked: listed.size,
    });

    expect(first.shops).toHaveLength(245);
    for (const shop of first.shops) {
      const file = path.join(V1, shop.source);
      expect(shop.source).toBe(`${SHOPS}/${shop.shopId}.json`);
      expect(listed.get(shop.source), shop.source).toBe(shop.sha256);
      expect(sha256(file), shop.source).toBe(shop.sha256);
      expect((JSON.parse(readFileSync(file, "utf8")) as { id: unknown }).id, shop.source).toBe(shop.shopId);
      // Each key is made from the shop's id, so a row's key names its file.
      expect([shop.businessId, shop.personId, shop.roleId, shop.handleId], shop.source).toEqual([
        `biz-demo-${shop.shopId}`,
        `person-demo-${shop.shopId}-owner`,
        `role-demo-${shop.shopId}-owner`,
        `handle-demo-${shop.shopId}-owner`,
      ]);
    }

    // Every row of every table is one shop's, and every shop has its row in each.
    const keys = async (rows: Promise<readonly { key: string }[]>): Promise<string[]> =>
      sorted((await rows).map((row) => row.key));
    const sql = db.sql;
    expect(await keys(sql<{ key: string }[]>`select id as key from businesses`)).toEqual(
      sorted(first.shops.map((shop) => shop.businessId)),
    );
    expect(await keys(sql<{ key: string }[]>`select id as key from persons`)).toEqual(
      sorted(first.shops.map((shop) => shop.personId)),
    );
    expect(
      await keys(
        sql<{ key: string }[]>`select id || ' ' || person_id || ' ' || business_id as key from person_roles`,
      ),
    ).toEqual(sorted(first.shops.map((shop) => `${shop.roleId} ${shop.personId} ${shop.businessId}`)));
    expect(await keys(sql<{ key: string }[]>`select id || ' ' || address as key from handles`)).toEqual(
      sorted(first.shops.map((shop) => `${shop.handleId} ${shop.phoneNumber}`)),
    );
    expect(
      await keys(sql<{ key: string }[]>`select person_id || ' ' || handle_id as key from person_handles`),
    ).toEqual(sorted(first.shops.map((shop) => `${shop.personId} ${shop.handleId}`)));
    expect(await keys(sql<{ key: string }[]>`select number || ' ' || handle_id as key from phones`)).toEqual(
      sorted(first.shops.map((shop) => `${shop.phoneNumber} ${shop.handleId}`)),
    );
  });

  it("writes only fictional mobiles: every number in the 555-0100 to 555-0199 range, each held by one handle", async () => {
    const handles = await db.sql<{ kind: string; address: string }[]>`select kind, address from handles`;
    const phones = await db.sql<{ number: string }[]>`select number from phones`;
    expect(handles).toHaveLength(245);
    expect(phones).toHaveLength(245);
    for (const handle of handles) {
      expect(handle.kind, handle.address).toBe("phone");
      expect(handle.address).toMatch(FICTIONAL);
    }
    for (const phone of phones) {
      expect(phone.number).toMatch(FICTIONAL);
    }
    expect(new Set(phones.map((phone) => phone.number)).size).toBe(245);
  });

  it("writes as the job role, rosie_job, with no scope; under row-level security a shop's scope shows the Tool API role that shop's head and owner role only", async () => {
    expect(first.ranAs).toBe("rosie_job");
    const barber = first.shops.find((shop) => shop.shopId === "barber");
    expect(barber).toBeDefined();
    const seen = await withBusiness(db.sql, barber?.businessId ?? "", async (tx) => {
      await tx`set local role rosie_app`;
      const businesses = await tx<{ id: string }[]>`select id from businesses order by id`;
      const roles = await tx<{ id: string }[]>`select id from person_roles order by id`;
      return { businesses: businesses.map((row) => row.id), roles: roles.map((row) => row.id) };
    });
    expect(seen).toEqual({ businesses: [barber?.businessId], roles: [barber?.roleId] });
  });

  it(
    "running the seed twice leaves the same rows: the second run writes nothing, and every row and version stays as it was",
    SLOW,
    async () => {
      const before = await snapshot(db.sql);
      const second = await seedCore(db.sql);
      for (const table of TABLES) {
        expect(second.tables[table], table).toEqual({ rows: 245, inserted: 0, kept: 245 });
      }
      expect(second.shops).toEqual(first.shops);
      expect(second.ranAs).toBe("rosie_job");
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );

  it(
    "writes a row that went missing again, as the first run wrote it, and changes nothing else",
    SLOW,
    async () => {
      const before = await snapshot(db.sql);
      const barber = first.shops.find((shop) => shop.shopId === "barber");
      await db.sql`delete from phones where number = ${barber?.phoneNumber ?? ""}`;
      expect((await rowCounts(db.sql)).phones).toBe(244);
      const third = await seedCore(db.sql);
      expect(third.tables.phones).toEqual({ rows: 245, inserted: 1, kept: 244 });
      for (const table of TABLES.filter((name) => name !== "phones")) {
        expect(third.tables[table], table).toEqual({ rows: 245, inserted: 0, kept: 245 });
      }
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );
});

describe("before the core seed writes a row", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_core_checks" });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  describe("it refuses to read anything outside fixtures/", () => {
    it(
      "refuses an intact copy of fixture set v1 that lies outside fixtures/, and writes nothing",
      SLOW,
      async () => {
        const copy = copyOfFixtureSet();
        const error = await refusal(seedCore(db.sql, { fixturesDir: copy.v1 }));
        expect(error).toBeInstanceOf(FixtureAccessError);
        expect(error.message).toContain("outside");
        expect(await rowCounts(db.sql)).toEqual(EMPTY);
      },
    );

    it("refuses a path that climbs out of fixtures/ with `..`, the repository's other folders and the temp folder, as a refusal and not a failed check", async () => {
      for (const dir of [
        path.join(V1, "..", "..", "db"),
        path.join(V1, "..", ".."),
        path.join(V1, "..", "..", "contracts", "db-schema", "core", "fixtures"),
        tmpdir(),
      ]) {
        const error = await refusal(seedCore(db.sql, { fixturesDir: dir }));
        // A checksum error would mean something in the folder was read first.
        expect(error, dir).toBeInstanceOf(FixtureAccessError);
        expect(error, dir).not.toBeInstanceOf(FixtureChecksumError);
      }
      expect(await rowCounts(db.sql)).toEqual(EMPTY);
    });

    it(
      "refuses a manifest line that names a file outside the set, even at that file's true hash",
      SLOW,
      async () => {
        const copy = copyOfFixtureSet();
        const outside = path.join(copy.root, "outside.json");
        writeFileSync(outside, readFileSync(path.join(V1, SHOPS, "barber.json")));
        const manifestFile = path.join(copy.v1, "MANIFEST.sha256");
        const intact = readFileSync(manifestFile);
        for (const named of ["../../outside.json", outside, "test-kit/../../../outside.json"]) {
          writeFileSync(manifestFile, intact);
          appendFileSync(manifestFile, `${sha256(outside)}  ${named}\n`);
          const error = await refusal(seedFromCopy(db.sql, copy));
          expect(error, named).toBeInstanceOf(FixtureAccessError);
          expect(error.message, named).toContain(JSON.stringify(named));
        }
        expect(await rowCounts(db.sql)).toEqual(EMPTY);
      },
    );

    it(
      "refuses a symbolic link in the set, even to a file whose bytes match the manifest, and a set folder that is a link out of fixtures/",
      SLOW,
      async () => {
        const copy = copyOfFixtureSet();
        const shop = path.join(copy.v1, SHOPS, "barber.json");
        const outside = path.join(copy.root, "barber.json");
        cpSync(shop, outside);
        rmSync(shop);
        symlinkSync(outside, shop);
        const error = await refusal(seedFromCopy(db.sql, copy));
        expect(error).toBeInstanceOf(FixtureAccessError);
        expect(error.message).toContain("symbolic link");

        const elsewhere = path.join(copy.root, "elsewhere");
        mkdirSync(elsewhere);
        symlinkSync(elsewhere, path.join(copy.fixtures, "linked"));
        const linked = await refusal(
          seedFromFolder(db.sql, path.join(copy.fixtures, "linked"), copy.fixtures),
        );
        expect(linked).toBeInstanceOf(FixtureAccessError);
        expect(linked.message).toContain("outside");
        expect(await rowCounts(db.sql)).toEqual(EMPTY);
      },
    );
  });

  describe("it checks fixtures/ against its SHA256SUMS (fixtures/v1/MANIFEST.sha256) and stops on a mismatch", () => {
    it("stops on one changed byte in a demo shop", SLOW, async () => {
      const copy = copyOfFixtureSet();
      flipOneByte(path.join(copy.v1, SHOPS, "barber.json"));
      const error = await refusal(seedFromCopy(db.sql, copy));
      expect(error).toBeInstanceOf(FixtureChecksumError);
      expect((error as FixtureChecksumError).problems).toEqual([`changed: ${SHOPS}/barber.json`]);
      expect(await rowCounts(db.sql)).toEqual(EMPTY);
    });

    it(
      "stops on a changed byte in a file it does not load, so the whole set is checked: an owner form, the coverage map, the profession map",
      SLOW,
      async () => {
        const copy = copyOfFixtureSet();
        for (const changed of ["forms/aba.json", "test-kit/COVERAGE.md", "PROFESSION-MAP.md"]) {
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
      "stops on a demo shop the manifest does not list, on a listed shop that is missing, and on a manifest line that is not a hash line",
      SLOW,
      async () => {
        const copy = copyOfFixtureSet();
        const extra = path.join(copy.v1, SHOPS, "extra-shop.json");
        writeFileSync(extra, `${JSON.stringify({ id: "extra-shop", name: "Extra shop" })}\n`);
        const unlisted = await refusal(seedFromCopy(db.sql, copy));
        expect(unlisted).toBeInstanceOf(FixtureChecksumError);
        expect((unlisted as FixtureChecksumError).problems).toEqual([
          `not in the manifest: ${SHOPS}/extra-shop.json`,
        ]);
        rmSync(extra);

        const yoga = path.join(copy.v1, SHOPS, "yoga.json");
        const yogaBytes = readFileSync(yoga);
        rmSync(yoga);
        const missing = await refusal(seedFromCopy(db.sql, copy));
        expect(missing).toBeInstanceOf(FixtureChecksumError);
        expect((missing as FixtureChecksumError).problems).toEqual([
          `listed but missing: ${SHOPS}/yoga.json`,
        ]);
        writeFileSync(yoga, yogaBytes);

        appendFileSync(path.join(copy.v1, "MANIFEST.sha256"), "not a hash line\n");
        const malformed = await refusal(seedFromCopy(db.sql, copy));
        expect(malformed).toBeInstanceOf(FixtureChecksumError);
        expect(malformed.message).toContain("is not");
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
        expect(result.fixtureSet.filesChecked).toBe(manifest().size);
        expect(result.tables.businesses).toEqual({ rows: 245, inserted: 245, kept: 0 });
        expect(await rowCounts(db.sql)).toEqual(ALL_SEEDED);
      },
    );
  });
});
