// T-212: the kinds seed, against local PostgreSQL (`npm run db:up`; `npm run test:integration -- db/seeds/kinds`). Each
// top-level block migrates a fresh test schema of its own (db/repo/test-db.ts), runs the core seed (T-200) and the setup
// seed (T-213) where it needs their rows, and drops the schema at the end; the shared public schema is never touched.
//
// The card's proofs: 243 kinds; insurance has the facts video, forms, firststeps and documents; each demo shop's text
// blocks equal its trade file's values byte for byte; re-running is idempotent. Each expected row is built here, column
// by column, from the trade files, the demo shop files and the K-01 key map themselves (node:fs, node:crypto and
// JSON.parse), never through the seed's own reader or T-133's loader, and compared with the whole row the database holds.
// The wrapping key the setup seed seals the owners' ID uploads with is made here from random bytes for each run and is
// never written to a file or printed. Bytes are changed only in temporary copies of fixtures/master and fixtures/v1 in
// the OS temp folder.
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_WRAPPING_KEY_NAME, type WrappingKeys } from "../repo/sealing";
import { type Sql, withBusiness } from "../repo/scope";
import { createTestDatabase, type TestDatabase } from "../repo/test-db";
import { seedCore } from "./core";
import { type KindsSeedResult, seedKinds, seedKindsFrom, TradeSetChecksumError, openTradeSet } from "./kinds";
import { FixtureAccessError, FixtureChecksumError, openFixtureSet } from "./lib/fixture-set";
import { seedSetupBusiness } from "./setup-business";

const SLOW = { timeout: 120_000 };
const FIXTURES = path.resolve(fileURLToPath(new URL("../../fixtures", import.meta.url)));
const V1 = path.join(FIXTURES, "v1");
const MASTER = path.join(FIXTURES, "master");
const PROF = "engine/work/prof";
const SHOPS = "test-kit/shops";
const KEY_MAP_FILE = fileURLToPath(new URL("../../contracts/bundle/fixtures/key-map.json", import.meta.url));
const KINDS_SAMPLE_FILE = fileURLToPath(
  new URL("../../contracts/db-schema/kinds-of-work/fixtures/seed-kinds-sample.json", import.meta.url),
);
const TABLES = ["kinds", "kind_flows", "picked_kinds", "picked_kind_texts"] as const;
const EMPTY = Object.fromEntries(TABLES.map((table) => [table, 0]));
const FLOWS = ["A", "B"] as const;
// Master Corrections C5: insurance's facts, in its words, and the twelve trades with no pf.settings.
const INSURANCE_FACTS = ["video", "forms", "firststeps", "documents"];
const NO_SETTINGS = [
  "art-classes",
  "band",
  "clown",
  "coding-classes",
  "comedian",
  "cooking-classes",
  "dance",
  "dj",
  "inspector",
  "insurance",
  "language-school",
  "party-characters",
];
// The 11 plug-in text blocks S1-11 gives, in its order, as K-24's picked_kind_texts_key_known names them.
const SLOT_TEXT_KEYS = [
  "pf.license",
  "pf.services",
  "pf.questions",
  "pf.safety",
  "pf.first_steps",
  "pf.visit",
  "pf.money",
  "pf.messages",
  "pf.staff",
  "pf.rules",
  "pf.edges",
];

/** One wrapping key per run for the setup seed: random, in memory only, under the Workers secret's name. */
const WRAP_BYTES = crypto.getRandomValues(new Uint8Array(32));
const KEYS: WrappingKeys = {
  resolve: (name) => (name === DEFAULT_WRAPPING_KEY_NAME ? WRAP_BYTES : undefined),
};

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const sha256OfText = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const sorted = (values: Iterable<string>): string[] => [...values].sort();
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

interface TradeFile {
  id: string;
  name: string;
  style: string;
  pattern: string;
  plugin: Record<string, unknown>;
  money: Record<string, { main: string; combos: string[] }>;
}

interface ShopFile {
  id: string;
  name: string;
}

/** A "<sha256>  <path>" list, read here: path to sha256. */
function sumsOf(file: string): Map<string, string> {
  const listed = new Map<string, string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      listed.set(match[2], match[1]);
    }
  }
  return listed;
}

/** The trade files, read here: trade id (its file name) to the parsed file. */
function tradeFiles(): Map<string, TradeFile> {
  const trades = new Map<string, TradeFile>();
  for (const file of readdirSync(path.join(MASTER, PROF)).filter((name) => name.endsWith(".json"))) {
    trades.set(file.slice(0, -".json".length), readJson(path.join(MASTER, PROF, file)) as TradeFile);
  }
  return trades;
}

/** The demo shop files of fixture set v1, read here: shop id (its file name) to the file's id and name. */
function shopFiles(): Map<string, ShopFile> {
  const shops = new Map<string, ShopFile>();
  for (const file of readdirSync(path.join(V1, SHOPS)).filter((name) => name.endsWith(".json"))) {
    shops.set(file.slice(0, -".json".length), readJson(path.join(V1, SHOPS, file)) as ShopFile);
  }
  return shops;
}

const TRADES = tradeFiles();
const SHOP_FILES = shopFiles();
const SUMS = sumsOf(path.join(MASTER, "SHA256SUMS"));
const LISTED = sumsOf(path.join(V1, "MANIFEST.sha256"));
/** The keys the K-01 v1 key map stores whole as text blocks (as "textBlock", to pluginText/<key>). */
const TEXT_KEYS = (readJson(KEY_MAP_FILE) as { keys: { key: string; as: string; to?: string }[] }).keys
  .filter((entry) => entry.as === "textBlock")
  .map((entry) => entry.key);

/** Whether a shop is one profession: its owner form is listed (forms/<id>.json). */
const hasForm = (id: string): boolean => LISTED.has(`forms/${id}.json`);
const perFlow = (setting: unknown, flow: string): unknown =>
  typeof setting === "object" && setting !== null && ("A" in setting || "B" in setting)
    ? (setting as Record<string, unknown>)[flow]
    : setting;

function trade(id: string): TradeFile {
  const found = TRADES.get(id);
  if (found === undefined) {
    throw new Error(`no trade file ${id}.json`);
  }
  return found;
}

/** A trade's facts: its own pf.facts, or for insurance, which has none, cpa's (Master Corrections C5). */
function factsOf(file: TradeFile): string[] {
  const facts = file.plugin["pf.facts"] as string[] | undefined;
  if (facts === undefined && file.id === "insurance") {
    return trade("cpa").plugin["pf.facts"] as string[];
  }
  if (facts === undefined) {
    throw new Error(`${file.id}: no facts list and no C5 fill`);
  }
  return facts;
}

/** The switches a trade's pf.switches turns on in a flow, in the file's order. */
function switchesOn(file: TradeFile, flow: string): string[] {
  return Object.entries((file.plugin["pf.switches"] ?? {}) as Record<string, unknown>).flatMap(
    ([name, value]) => (perFlow(value, flow) === true ? [name] : []),
  );
}

/** A flow's settings as the file gives them, with MC C5's start values where it gives none: window, no cutoff. */
function settingsOf(
  file: TradeFile,
  flow: string,
): { arrive: string; arrive_window_hours: number | null; cutoff: string | null } {
  const settings = file.plugin["pf.settings"] as { arrive?: unknown; cutoff?: unknown } | undefined;
  const arrive = perFlow(settings?.arrive, flow);
  const cutoff = perFlow(settings?.cutoff, flow);
  if (cutoff !== undefined && typeof cutoff !== "string") {
    throw new Error(`${file.id}: a free-cancel time this test does not know`);
  }
  const words = cutoff ?? null;
  if (arrive === undefined || arrive === "window") {
    return { arrive: "window", arrive_window_hours: null, cutoff: words };
  }
  if (arrive === "setstart") {
    return { arrive: "setstart", arrive_window_hours: null, cutoff: words };
  }
  const hours = (arrive as { window?: unknown }).window;
  if (typeof hours === "number") {
    return { arrive: "window", arrive_window_hours: hours, cutoff: words };
  }
  throw new Error(`${file.id}: an arrival setting this test does not know`);
}

/** The kinds row a trade file gives (K-24 kinds). */
function expectedKind(file: TradeFile): Record<string, unknown> {
  return {
    id: file.id,
    name: file.name,
    style: file.style,
    pattern: file.pattern,
    facts: factsOf(file),
    source: "trade_file",
    version: 1,
  };
}

/** The kind_flows row a trade file gives for one flow (K-24 kind_flows). */
function expectedFlow(file: TradeFile, flow: string): Record<string, unknown> {
  const money = file.money[flow];
  return {
    kind_id: file.id,
    flow,
    main_combo: money?.main,
    combos: money?.combos,
    switches_on: switchesOn(file, flow),
    ...settingsOf(file, flow),
    version: 1,
  };
}

/** A trade file's plug-in text block: its value as JSON text, unchanged (K-01 pluginText). */
function blockOf(file: TradeFile, key: string): string {
  const value = file.plugin[key];
  if (value === undefined) {
    throw new Error(`${file.id}.json has no plug-in value ${key}`);
  }
  return JSON.stringify(value);
}

/**
 * When fixture set v1 was made: line 3 of test-kit/COVERAGE.md, Eastern time (fixtures/v1/README.md), turned into an
 * instant by PostgreSQL (the seeds do it with Intl). The text cast keeps the client from parsing the wall time itself.
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

/** Every row of the four tables the seed writes, in key order, as plain arrays. */
async function snapshot(sql: Sql): Promise<Record<string, unknown[]>> {
  return {
    kinds: [...(await sql`select * from kinds order by id`)],
    kind_flows: [...(await sql`select * from kind_flows order by kind_id, flow`)],
    picked_kinds: [...(await sql`select * from picked_kinds order by id`)],
    picked_kind_texts: [...(await sql`select * from picked_kind_texts order by picked_kind_id, pf_key`)],
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
  /** Its fixtures/ folder: the jail the copies are opened with. */
  fixtures: string;
  master: string;
  v1: string;
}

const copies: string[] = [];

/** Byte-for-byte copies of fixtures/master and fixtures/v1 at <temp>/fixtures/. */
function copyOfFixtures(): Copy {
  const root = mkdtempSync(path.join(tmpdir(), "rosie-seed-kinds-"));
  copies.push(root);
  const fixtures = path.join(root, "fixtures");
  const master = path.join(fixtures, "master");
  const v1 = path.join(fixtures, "v1");
  cpSync(MASTER, master, { recursive: true });
  cpSync(V1, v1, { recursive: true });
  return { root, fixtures, master, v1 };
}

/** Rewrites one trade file of a copy and its SHA256SUMS line, so the copy still matches its list. */
function rewriteTrade(copy: Copy, id: string, change: (file: Record<string, unknown>) => void): void {
  const relative = `${PROF}/${id}.json`;
  const file = path.join(copy.master, relative);
  const parsed = readJson(file) as Record<string, unknown>;
  change(parsed);
  writeFileSync(file, `${JSON.stringify(parsed, null, 1)}\n`);
  const sumsFile = path.join(copy.master, "SHA256SUMS");
  const lines = readFileSync(sumsFile, "utf8")
    .split("\n")
    .map((line) => (line.endsWith(`  ${relative}`) ? `${sha256(file)}  ${relative}` : line));
  writeFileSync(sumsFile, lines.join("\n"));
}

/** Flips one bit of the byte in the middle of a file (doing it twice restores the file). */
function flipOneByte(file: string): void {
  const bytes = readFileSync(file);
  const at = Math.floor(bytes.length / 2);
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  writeFileSync(file, bytes);
}

function seedFromCopy(sql: Sql, copy: Copy): Promise<KindsSeedResult> {
  return seedKindsFrom(
    sql,
    openFixtureSet(copy.v1, { jail: copy.fixtures }),
    openTradeSet(copy.master, { jail: copy.fixtures }),
  );
}

afterAll(() => {
  for (const root of copies) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("the kinds seed, loaded from the trade files and fixture set v1 after the core and setup seeds", () => {
  let db: TestDatabase;
  let first: KindsSeedResult;
  let seededAt: Date;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_kinds" });
    await seedCore(db.sql);
    await seedSetupBusiness(db.sql, { wrappingKeys: KEYS });
    first = await seedKinds(db.sql);
    seededAt = await fixtureSetMade(db.sql);
  }, 120_000);

  // Dropping a schema can pass the 10 s hook default while other builders load the database (a resource guard only).
  afterAll(async () => {
    await db.drop();
  }, 120_000);

  it("seeds 243 kinds, one per trade file, each with its two flows, and one kind for each of the 243 demo shops with its 11 text blocks", async () => {
    expect(TRADES.size).toBe(243);
    expect(first.tables).toEqual({
      kinds: { rows: 243, inserted: 243, kept: 0 },
      kind_flows: { rows: 486, inserted: 486, kept: 0 },
      picked_kinds: { rows: 243, inserted: 243, kept: 0 },
      picked_kind_texts: { rows: 2673, inserted: 2673, kept: 0 },
    });
    expect(await rowCounts(db.sql)).toEqual({
      kinds: 243,
      kind_flows: 486,
      picked_kinds: 243,
      picked_kind_texts: 2673,
    });
    const ids = await db.sql<{ id: string }[]>`select id from kinds`;
    expect(sorted(ids.map((row) => row.id))).toEqual(sorted(TRADES.keys()));
    expect(first.kinds.map((kind) => kind.kindId)).toEqual(sorted(TRADES.keys()));
    expect(sorted(first.picks.map((pick) => pick.shopId))).toEqual(
      sorted([...SHOP_FILES.keys()].filter(hasForm)),
    );
  });

  it("gives each kind its trade file's id, name, style and pattern and its facts; insurance, which lists none, has video, forms, firststeps and documents, cpa.json's list (MC C5)", async () => {
    const rows = await db.sql<Record<string, unknown>[]>`select * from kinds order by id`;
    const rowOf = new Map(rows.map((row) => [String(row.id), row]));
    for (const file of TRADES.values()) {
      expect(rowOf.get(file.id), file.id).toEqual(expectedKind(file));
    }
    const insurance = rowOf.get("insurance")?.facts as string[] | undefined;
    expect(trade("insurance").plugin["pf.facts"]).toBeUndefined();
    expect(sorted(insurance ?? [])).toEqual(sorted(INSURANCE_FACTS));
    expect(insurance).toEqual(trade("cpa").plugin["pf.facts"]);
    // After C5 every trade-file kind has a facts list (K-24 README "The kinds").
    expect(rows.filter((row) => row.facts === null)).toEqual([]);
    expect(rows.filter((row) => (row.facts as string[]).length === 0).map((row) => row.id)).toEqual(
      [...TRADES.values()]
        .filter((file) => (file.plugin["pf.facts"] as string[] | undefined)?.length === 0)
        .map((file) => file.id),
    );
  });

  it("gives each kind its two flows as the trade file has them: the main money path and the paths it lists, the switches on, and the arrival and free-cancel time, with MC C5's start values where the file gives none", async () => {
    const rows = await db.sql<Record<string, unknown>[]>`select * from kind_flows order by kind_id, flow`;
    expect(rows).toHaveLength(486);
    const rowOf = new Map(rows.map((row) => [`${String(row.kind_id)} ${String(row.flow)}`, row]));
    for (const file of TRADES.values()) {
      for (const flow of FLOWS) {
        expect(rowOf.get(`${file.id} ${flow}`), `${file.id} ${flow}`).toEqual(expectedFlow(file, flow));
      }
    }
    // MC C5: the twelve trades with no pf.settings start at window with an empty free-cancel time, in both flows.
    expect(
      sorted([...TRADES.values()].filter((file) => !("pf.settings" in file.plugin)).map((file) => file.id)),
    ).toEqual(NO_SETTINGS);
    for (const id of NO_SETTINGS) {
      for (const flow of FLOWS) {
        expect(rowOf.get(`${id} ${flow}`), `${id} ${flow}`).toMatchObject({
          arrive: "window",
          arrive_window_hours: null,
          cutoff: null,
        });
      }
    }
    // no2 is never on: every trade file of fixture set v1 keeps the $2 (K-24 README; FS line 562).
    expect(rows.filter((row) => (row.switches_on as string[]).includes("no2"))).toEqual([]);
    // Spot checks against the files' words: a set start and 24 hours; a window with no cutoff (plumber's flows); a
    // window of 2 hours and 8pm the day before (dog-walker.json flow B); a cutoff on the day itself, kept as worded.
    expect(rowOf.get("barber A")).toMatchObject({
      main_combo: "list|card|counter",
      arrive: "setstart",
      cutoff: "24 hours before",
    });
    expect(rowOf.get("plumber B")).toMatchObject({
      switches_on: ["cancelright"],
      arrive: "window",
      cutoff: null,
    });
    expect(rowOf.get("dog-walker B")).toMatchObject({
      arrive: "window",
      arrive_window_hours: 2,
      cutoff: "8pm the day before",
    });
    expect(rows.filter((row) => row.cutoff === "7am the day of").length).toBeGreaterThan(0);
    expect(first.kinds.find((kind) => kind.kindId === "insurance")?.startValues).toEqual({
      A: ["arrive", "cutoff"],
      B: ["arrive", "cutoff"],
    });
  });

  it("agrees with K-24 v1's kinds sample, row for row, for the eight kinds it holds (facts as a set: the sample writes insurance's in MC C5's order, the seed in cpa.json's)", async () => {
    const sample = (
      readJson(KINDS_SAMPLE_FILE) as { rows: { table: string; values: Record<string, unknown> }[] }
    ).rows;
    const kindsOfSample = sample.filter((row) => row.table === "kinds");
    const flowsOfSample = sample.filter((row) => row.table === "kind_flows");
    expect([kindsOfSample.length, flowsOfSample.length]).toEqual([8, 16]);
    const withFactsAsSet = (row: Record<string, unknown> | undefined): Record<string, unknown> => ({
      ...row,
      facts: sorted((row?.facts ?? []) as string[]),
    });
    for (const { values } of kindsOfSample) {
      const [row] = await db.sql<
        Record<string, unknown>[]
      >`select * from kinds where id = ${String(values.id)}`;
      expect(withFactsAsSet(row), String(values.id)).toEqual(withFactsAsSet(values));
    }
    for (const { values } of flowsOfSample) {
      const [row] = await db.sql<Record<string, unknown>[]>`
        select * from kind_flows where kind_id = ${String(values.kind_id)} and flow = ${String(values.flow)}
      `;
      expect(row, `${String(values.kind_id)} ${String(values.flow)}`).toEqual(values);
    }
  });

  it("gives each of the 243 demo shops its kind of work, listed and first named, in the shop's own name for it, placed in the company kind the setup seed made, dated when fixture set v1 was made", async () => {
    expect(Number.isNaN(seededAt.getTime())).toBe(false);
    const rows = await db.sql<Record<string, unknown>[]>`select * from picked_kinds order by id`;
    expect(rows).toHaveLength(243);
    const rowOf = new Map(rows.map((row) => [String(row.business_id), row]));
    for (const shop of SHOP_FILES.values()) {
      const businessId = `biz-demo-${shop.id}`;
      if (!hasForm(shop.id)) {
        expect(rowOf.has(businessId), shop.id).toBe(false);
        continue;
      }
      expect(rowOf.get(businessId), shop.id).toEqual({
        id: `pick-demo-${shop.id}`,
        owner_person_id: `person-demo-${shop.id}-owner`,
        position: 1,
        words: shop.name,
        outcome: "listed",
        kind_id: shop.id,
        company_id: `company-demo-${shop.id}`,
        business_id: businessId,
        picked_at: seededAt,
        version: 1,
      });
      // The shop's own name for its kind is its trade's name.
      expect(shop.name, shop.id).toBe(trade(shop.id).name);
    }
    // Each pick is a company kind the setup seed wrote, one pick to each (K-24 picked_kinds_company_kind_fk).
    const placed = await db.sql<{ placed: number; companyKinds: number }[]>`
      select (select count(*)::int from picked_kinds p
          join company_kinds c on c.company_id = p.company_id and c.kind_id = p.kind_id
            and c.business_id = p.business_id) as placed,
        (select count(*)::int from company_kinds) as "companyKinds"
    `;
    expect(placed).toEqual([{ placed: 243, companyKinds: 243 }]);
    expect(first.pickedAt).toEqual({ at: seededAt, source: "test-kit/COVERAGE.md" });
  });

  it("stores each demo shop's 11 plug-in text blocks whole, each equal to its trade file's value byte for byte, and no typed key", async () => {
    expect(TEXT_KEYS).toEqual(SLOT_TEXT_KEYS);
    const rows = await db.sql<
      {
        picked_kind_id: string;
        pf_key: string;
        business_id: string;
        block: string;
        version: number;
        bytes: number;
        sha256: string;
      }[]
    >`
      select t.*, octet_length(t.block) as bytes, encode(sha256(convert_to(t.block, 'UTF8')), 'hex') as sha256
      from picked_kind_texts t order by t.picked_kind_id, t.pf_key
    `;
    expect(rows).toHaveLength(243 * 11);
    const rowOf = new Map(rows.map((row) => [`${row.picked_kind_id} ${row.pf_key}`, row]));
    for (const shop of SHOP_FILES.values()) {
      if (!hasForm(shop.id)) {
        continue;
      }
      const file = trade(shop.id);
      for (const key of TEXT_KEYS) {
        const block = blockOf(file, key);
        const row = rowOf.get(`pick-demo-${shop.id} ${key}`);
        expect([row?.business_id, row?.version, row?.bytes, row?.sha256], `${shop.id} ${key}`).toEqual([
          `biz-demo-${shop.id}`,
          1,
          new TextEncoder().encode(block).length,
          sha256OfText(block),
        ]);
        expect(row?.block === block, `${shop.id} ${key}`).toBe(true);
      }
    }
    // Only the key map's text blocks are stored: never pf.facts, pf.switches or pf.settings, the typed keys.
    expect(sorted(new Set(rows.map((row) => row.pf_key)))).toEqual(sorted(TEXT_KEYS));
    // The barbershop's blocks are the ones K-24's business kinds sample loads (the barber file's own, unchanged).
    const sample = readJson(
      fileURLToPath(
        new URL("../../contracts/db-schema/kinds-of-work/fixtures/seed-business-kinds.json", import.meta.url),
      ),
    ) as { rows: { table: string; values: { pf_key?: string; block?: string } }[] };
    for (const { values } of sample.rows.filter((row) => row.table === "picked_kind_texts")) {
      expect(rowOf.get(`pick-demo-barber ${values.pf_key ?? ""}`)?.block, values.pf_key).toBe(values.block);
    }
  });

  it("starts each demo shop's kind from the same facts and switches the setup seed gave its company kind", async () => {
    const rows = await db.sql<{ kind_id: string; same_facts: boolean; same_a: boolean; same_b: boolean }[]>`
      select c.kind_id, c.pf_facts = k.facts as same_facts, c.pf_switches_a = a.switches_on as same_a,
        c.pf_switches_b = b.switches_on as same_b
      from company_kinds c
      join kinds k on k.id = c.kind_id
      join kind_flows a on a.kind_id = c.kind_id and a.flow = 'A'
      join kind_flows b on b.kind_id = c.kind_id and b.flow = 'B'
      order by c.kind_id
    `;
    expect(rows).toHaveLength(243);
    expect(rows.filter((row) => !row.same_facts || !row.same_a || !row.same_b)).toEqual([]);
  });

  it("traces every kind to its trade file listed in fixtures/master/SHA256SUMS, and every pick to its demo shop listed in fixtures/v1/MANIFEST.sha256, at the hash each has now", () => {
    expect(first.tradeSet).toEqual({
      dir: realpathSync(MASTER),
      sumsSha256: sha256(path.join(MASTER, "SHA256SUMS")),
      filesChecked: SUMS.size,
    });
    expect(first.fixtureSet).toEqual({
      dir: realpathSync(V1),
      manifestSha256: sha256(path.join(V1, "MANIFEST.sha256")),
      filesChecked: LISTED.size,
    });
    for (const kind of first.kinds) {
      expect(kind.source).toBe(`${PROF}/${kind.kindId}.json`);
      expect(SUMS.get(kind.source), kind.source).toBe(kind.sha256);
      expect(sha256(path.join(MASTER, kind.source)), kind.source).toBe(kind.sha256);
      // MC C5's start values, for each setting the file leaves out in a flow.
      const settings = trade(kind.kindId).plugin["pf.settings"] as
        { arrive?: unknown; cutoff?: unknown } | undefined;
      for (const flow of FLOWS) {
        const missing = (["arrive", "cutoff"] as const).filter(
          (setting) => perFlow(settings?.[setting], flow) === undefined,
        );
        expect(kind.startValues[flow], `${kind.kindId} ${flow}`).toEqual(missing);
      }
    }
    // The one value not from a kind's own file: insurance's facts, from cpa.json (MC C5).
    expect(
      Object.fromEntries(
        first.kinds
          .filter((kind) => Object.keys(kind.valuesFrom).length > 0)
          .map((kind) => [kind.kindId, kind.valuesFrom]),
      ),
    ).toEqual({ insurance: { facts: `${PROF}/cpa.json` } });
    expect(first.picks).toHaveLength(243);
    for (const pick of first.picks) {
      expect(pick.source).toBe(`${SHOPS}/${pick.shopId}.json`);
      expect(LISTED.get(pick.source), pick.source).toBe(pick.sha256);
      expect(sha256(path.join(V1, pick.source)), pick.source).toBe(pick.sha256);
      expect(
        [pick.pickId, pick.kindId, pick.companyId, pick.businessId, pick.ownerPersonId, pick.blocksFrom],
        pick.source,
      ).toEqual([
        `pick-demo-${pick.shopId}`,
        pick.shopId,
        `company-demo-${pick.shopId}`,
        `biz-demo-${pick.shopId}`,
        `person-demo-${pick.shopId}-owner`,
        `${PROF}/${pick.shopId}.json`,
      ]);
    }
  });

  it("writes as the job role, rosie_job, with no scope; under a shop's scope the Tool API role sees the whole catalog but only that shop's kind and its 11 blocks", async () => {
    expect(first.ranAs).toBe("rosie_job");
    const seen = await withBusiness(db.sql, "biz-demo-barber", async (tx) => {
      await tx`set local role rosie_app`;
      const [counts] = await tx<{ kinds: number; flows: number }[]>`
        select (select count(*)::int from kinds) as kinds, (select count(*)::int from kind_flows) as flows
      `;
      const picks = await tx<{ id: string }[]>`select id from picked_kinds order by id`;
      const texts = await tx<{ key: string }[]>`select pf_key as key from picked_kind_texts order by pf_key`;
      return { counts, picks: picks.map((row) => row.id), texts: texts.map((row) => row.key) };
    });
    expect(seen).toEqual({
      counts: { kinds: 243, flows: 486 },
      picks: ["pick-demo-barber"],
      texts: sorted(TEXT_KEYS),
    });
  });

  it(
    "running the seed twice leaves the same rows: the second run writes nothing, and every row and version stays as it was",
    SLOW,
    async () => {
      const before = await snapshot(db.sql);
      const second = await seedKinds(db.sql);
      expect(second.tables).toEqual({
        kinds: { rows: 243, inserted: 0, kept: 243 },
        kind_flows: { rows: 486, inserted: 0, kept: 486 },
        picked_kinds: { rows: 243, inserted: 0, kept: 243 },
        picked_kind_texts: { rows: 2673, inserted: 0, kept: 2673 },
      });
      expect(second.kinds).toEqual(first.kinds);
      expect(second.picks).toEqual(first.picks);
      expect(second.pickedAt).toEqual(first.pickedAt);
      expect(second.ranAs).toBe("rosie_job");
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );

  it(
    "writes a row that went missing again, as the first run wrote it, and changes nothing else",
    SLOW,
    async () => {
      const before = await snapshot(db.sql);
      await db.sql`delete from picked_kind_texts where picked_kind_id = 'pick-demo-yoga' and pf_key = 'pf.money'`;
      await db.sql`delete from kind_flows where kind_id = 'yoga' and flow = 'B'`;
      const third = await seedKinds(db.sql);
      expect(third.tables).toEqual({
        kinds: { rows: 243, inserted: 0, kept: 243 },
        kind_flows: { rows: 486, inserted: 1, kept: 485 },
        picked_kinds: { rows: 243, inserted: 0, kept: 243 },
        picked_kind_texts: { rows: 2673, inserted: 1, kept: 2672 },
      });
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );
});

describe("before the kinds seed writes a row", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_kinds_checks" });
  }, 120_000);

  // Dropping a schema can pass the 10 s hook default while other builders load the database (a resource guard only).
  afterAll(async () => {
    await db.drop();
  }, 120_000);

  it("refuses to run before the setup seed, naming it, and writes nothing", SLOW, async () => {
    const error = await refusal(seedKinds(db.sql));
    expect(error.message).toContain("run db/seeds/setup-business.ts first");
    expect(error.message).toContain("243 of 243 demo shops");
    expect(await rowCounts(db.sql)).toEqual(EMPTY);
  });

  describe("with the core and setup seeds' rows in place", () => {
    beforeAll(async () => {
      await seedCore(db.sql);
      await seedSetupBusiness(db.sql, { wrappingKeys: KEYS });
    }, 120_000);

    it(
      "checks the whole trade files' set against SHA256SUMS first: one changed byte in a trade file, a flow or a build script it does not parse, an unlisted trade file and a listed one that is missing each stop it",
      SLOW,
      async () => {
        const copy = copyOfFixtures();
        for (const changed of [
          `${PROF}/barber.json`,
          "engine/work/master/master-A.json",
          "engine/work/build/overlay-core.js",
        ]) {
          flipOneByte(path.join(copy.master, changed));
          const error = await refusal(seedFromCopy(db.sql, copy));
          expect(error, changed).toBeInstanceOf(TradeSetChecksumError);
          expect((error as TradeSetChecksumError).problems, changed).toEqual([`changed: ${changed}`]);
          flipOneByte(path.join(copy.master, changed));
        }
        const extra = path.join(copy.master, PROF, "extra-trade.json");
        writeFileSync(extra, readFileSync(path.join(MASTER, PROF, "barber.json")));
        const unlisted = await refusal(seedFromCopy(db.sql, copy));
        expect((unlisted as TradeSetChecksumError).problems).toEqual([
          `not in SHA256SUMS: ${PROF}/extra-trade.json`,
        ]);
        rmSync(extra);
        rmSync(path.join(copy.master, PROF, "yoga.json"));
        const missing = await refusal(seedFromCopy(db.sql, copy));
        expect((missing as TradeSetChecksumError).problems).toEqual([
          `listed but missing: ${PROF}/yoga.json`,
        ]);
        expect(await rowCounts(db.sql)).toEqual(EMPTY);
      },
    );

    it(
      "checks fixture set v1 against MANIFEST.sha256 first: one changed byte in a demo shop stops it",
      SLOW,
      async () => {
        const copy = copyOfFixtures();
        flipOneByte(path.join(copy.v1, SHOPS, "barber.json"));
        const error = await refusal(seedFromCopy(db.sql, copy));
        expect(error).toBeInstanceOf(FixtureChecksumError);
        expect((error as FixtureChecksumError).problems).toEqual([`changed: ${SHOPS}/barber.json`]);
        expect(await rowCounts(db.sql)).toEqual(EMPTY);
      },
    );

    it(
      "refuses an intact copy of the trade files' set that lies outside fixtures/, and a SHA256SUMS line that names a file outside the set, and writes nothing",
      SLOW,
      async () => {
        const copy = copyOfFixtures();
        const outside = await refusal(seedKinds(db.sql, { tradesDir: copy.master }));
        expect(outside).toBeInstanceOf(FixtureAccessError);
        expect(outside.message).toContain("outside");
        const sumsFile = path.join(copy.master, "SHA256SUMS");
        writeFileSync(
          sumsFile,
          `${readFileSync(sumsFile, "utf8")}${sha256(path.join(MASTER, PROF, "barber.json"))}  ../v1/barber.json\n`,
        );
        const climbing = await refusal(seedFromCopy(db.sql, copy));
        expect(climbing).toBeInstanceOf(FixtureAccessError);
        expect(climbing.message).toContain(JSON.stringify("../v1/barber.json"));
        expect(await rowCounts(db.sql)).toEqual(EMPTY);
      },
    );

    it(
      "refuses, naming the file, a trade file it does not know how to read, rather than guess: a facts list C5 does not cover, an empty free-cancel time, a switch name not in lower case, a main path the file does not list, an id that is not its file's name",
      SLOW,
      async () => {
        const cases: [string, (file: Record<string, unknown>) => void, string][] = [
          [
            "yoga",
            (file) => {
              Reflect.deleteProperty(file.plugin as object, "pf.facts");
            },
            "lists no facts",
          ],
          [
            "barber",
            (file) => {
              (file.plugin as Record<string, unknown>)["pf.settings"] = { arrive: "setstart", cutoff: " " };
            },
            "free-cancel time",
          ],
          [
            "plumber",
            (file) => {
              (file.plugin as Record<string, unknown>)["pf.switches"] = { CancelRight: { B: true } };
            },
            "switch's name",
          ],
          [
            "plumber",
            (file) => {
              const money = file.money as Record<string, Record<string, unknown>>;
              money.A = { ...money.A, main: "photos|full|none" };
            },
            "main path",
          ],
          [
            "barber",
            (file) => {
              file.id = "barbers";
            },
            'expected "barber"',
          ],
        ];
        for (const [id, change, words] of cases) {
          const copy = copyOfFixtures();
          rewriteTrade(copy, id, change);
          const error = await refusal(seedFromCopy(db.sql, copy));
          expect(error.message, words).toContain(`${PROF}/${id}.json`);
          expect(error.message, words).toContain(words);
          expect(error, words).not.toBeInstanceOf(TradeSetChecksumError);
        }
        expect(await rowCounts(db.sql)).toEqual(EMPTY);
      },
    );

    it(
      "loads from untouched copies opened the same way, so each refusal above had its one reason",
      SLOW,
      async () => {
        const copy = copyOfFixtures();
        const result = await seedFromCopy(db.sql, copy);
        expect(result.ranAs).toBe("rosie_job");
        expect(result.tables.kinds).toEqual({ rows: 243, inserted: 243, kept: 0 });
        expect(await rowCounts(db.sql)).toEqual({
          kinds: 243,
          kind_flows: 486,
          picked_kinds: 243,
          picked_kind_texts: 2673,
        });
      },
    );
  });
});
