// T-214: the services and rules seed, against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/seeds/setup-services-rules`). Each top-level block migrates a fresh test schema of its
// own (db/repo/test-db.ts), runs the core (T-200), setup (T-213) and kinds (T-212) seeds where it needs their rows, and
// drops the schema at the end; the shared public schema is never touched.
//
// The card's proofs: each shop has its fixture services; test-mixed-B offers list|card|bill (G2); no price rule overlaps;
// amounts are integer cents; re-running is idempotent. Each expected row is built here, column by column, from the demo
// shop files themselves (node:fs and JSON.parse), never through the seed's reader, and compared with the whole row the
// database holds; amounts are read back as text, so no client parsing stands between the cents and the check. The
// wrapping key the setup seed seals the owners' ID uploads with is made here from random bytes for each run and is never
// written to a file or printed. Bytes are changed only in temporary copies of fixtures/v1 in the OS temp folder.
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
import { seedKinds } from "./kinds";
import { FixtureAccessError, FixtureChecksumError, openFixtureSet } from "./lib/fixture-set";
import { seedSetupBusiness } from "./setup-business";
import {
  readMoneyExample,
  seedSetupServicesRules,
  seedSetupServicesRulesFrom,
  type ServicesRulesSeedResult,
} from "./setup-services-rules";

const SLOW = { timeout: 180_000 };
const FIXTURES = path.resolve(fileURLToPath(new URL("../../fixtures", import.meta.url)));
const V1 = path.join(FIXTURES, "v1");
const SHOPS = "test-kit/shops";
const FLOWS = ["A", "B"] as const;
type Flow = (typeof FLOWS)[number];
const TABLES = ["services", "service_money", "price_rules", "rules", "price_ok_limits"] as const;
type Table = (typeof TABLES)[number];
const EMPTY = Object.fromEntries(TABLES.map((table) => [table, 0]));
// test-mixed-A and -B have no profession: their money examples are the master's flow A and flow B sample businesses'
// (test-kit.js line 135; master-A.json cast: Lee's Barbershop's barbers; master-B.json cast: Lee Home Services' plumbers).
const MIXED_KINDS: Readonly<Record<string, string>> = { "test-mixed-A": "barber", "test-mixed-B": "plumber" };
// Master Corrections C5: insurance, the one trade with no facts, takes the list cpa.json has.
const FACTS_FROM: Readonly<Record<string, string>> = { insurance: "cpa" };
// The master's 56 money paths: 28 per flow (K-25 service_money_path_known).
const PATH_COUNT = 56;

/** One wrapping key per run for the setup seed: random, in memory only, under the Workers secret's name. */
const WRAP_BYTES = crypto.getRandomValues(new Uint8Array(32));
const KEYS: WrappingKeys = {
  resolve: (name) => (name === DEFAULT_WRAPPING_KEY_NAME ? WRAP_BYTES : undefined),
};

interface MoneyExample {
  combo: string;
  name: string;
  price: string | null;
  deposit: string | null;
  fee: string | null;
  due_now_at_booking: number;
}

interface ShopFile {
  id: string;
  name: string;
  flows: Partial<Record<Flow, { services: MoneyExample[] }>>;
  facts?: string[];
}

type Row = Record<string, unknown>;

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byId = (a: Row, b: Row): number => byCodePoint(String(a.id), String(b.id));
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

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

/** The demo shop files of fixture set v1, read here, in code-point order of id. */
function shopFiles(): ShopFile[] {
  return readdirSync(path.join(V1, SHOPS))
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(path.join(V1, SHOPS, name)) as ShopFile)
    .sort((a, b) => byCodePoint(a.id, b.id));
}

const SHOP_FILES = shopFiles();
const SHOP_OF = new Map(SHOP_FILES.map((shop) => [shop.id, shop]));
const LISTED = sumsOf(path.join(V1, "MANIFEST.sha256"));

/** Whether a shop is one profession: its owner form is listed (forms/<id>.json). */
const hasForm = (id: string): boolean => LISTED.has(`forms/${id}.json`);

/** "$35", "$1,200" or "$35.50" in whole cents, read here. */
function dollarsToCents(words: string): number {
  const match = /^\$([0-9,]+)(?:\.([0-9]{2}))?$/.exec(words);
  if (match?.[1] === undefined) {
    throw new Error(`not an amount in dollars: ${words}`);
  }
  return Number(match[1].replaceAll(",", "")) * 100 + Number(match[2] ?? "0");
}

/** A fee as the way holds it: none on a path that takes nothing before; "free" or $0 is no fee (K-25: above $0). */
function feeOf(before: string, words: string | null): number | null {
  if (before === "none" || words === null || words === "free") {
    return null;
  }
  const cents = dollarsToCents(words);
  return cents === 0 ? null : cents;
}

/** A shop's facts: its own, or for insurance, which lists none, cpa's (MC C5); none for a shop with no profession. */
function factsOf(shop: ShopFile): string[] {
  const own = shop.facts ?? [];
  const from = FACTS_FROM[shop.id];
  return own.length === 0 && from !== undefined ? (SHOP_OF.get(from)?.facts ?? []) : own;
}

/** A rule's scope over the flows it applies in: both is the whole business (null), else the one flow. */
const scopeOf = (flows: ReadonlySet<Flow>): Flow | null =>
  flows.size === 1 ? ([...flows][0] ?? null) : null;

interface Expected {
  rows: Record<Table, Row[]>;
  /** Per shop: its examples, in order, with their flow, position and ids. */
  examples: Map<string, { flow: Flow; index: number; example: MoneyExample; key: string }[]>;
}

/** Every row the seed should hold, built here from the shop files, each table in code-point order of id. */
function expectedRows(seededAt: Date): Expected {
  const rows: Record<Table, Row[]> = {
    services: [],
    service_money: [],
    price_rules: [],
    rules: [],
    price_ok_limits: [],
  };
  const examples = new Map<string, { flow: Flow; index: number; example: MoneyExample; key: string }[]>();
  for (const shop of SHOP_FILES) {
    const businessId = `biz-demo-${shop.id}`;
    const owner = `person-demo-${shop.id}-owner`;
    const kindId = hasForm(shop.id) ? shop.id : MIXED_KINDS[shop.id];
    const ofShop: { flow: Flow; index: number; example: MoneyExample; key: string }[] = [];
    const billFlows = new Set<Flow>();
    const quotedFlows = new Set<Flow>();
    let position = 0;
    for (const flow of FLOWS) {
      (shop.flows[flow]?.services ?? []).forEach((example, index) => {
        position += 1;
        const [price, before, after] = example.combo.split("|");
        const key = `${shop.id}-${flow.toLowerCase()}-${example.combo.split("|").join("-")}`;
        ofShop.push({ flow, index, example, key });
        const deposit =
          before === "deposit" && example.deposit !== null ? dollarsToCents(example.deposit) : null;
        const fee = feeOf(before ?? "", example.fee);
        rows.services.push({
          id: `svc-demo-${key}`,
          business_id: businessId,
          kind_id: kindId,
          name: example.name,
          price_kind: "one_price",
          unit: null,
          length: "01:00:00",
          position,
          active: true,
          extras: null,
          version: 1,
        });
        rows.service_money.push({
          id: `way-demo-${key}`,
          service_id: `svc-demo-${key}`,
          business_id: businessId,
          flow,
          place: flow === "A" ? "business" : "customer",
          location_id: `loc-demo-${shop.id}`,
          path: example.combo,
          deposit_cents: deposit === null ? null : String(deposit),
          deposit_percent: null,
          fee_cents: fee === null ? null : String(fee),
          currency: deposit !== null || fee !== null ? "USD" : null,
          cutoff_before: null,
          cutoff_day_before_at: null,
          tip_line: null,
          active: true,
          version: 1,
        });
        if (price === "list") {
          rows.price_rules.push({
            id: `price-demo-${key}`,
            business_id: businessId,
            service_id: `svc-demo-${key}`,
            service_money_id: null,
            worker_resource_id: null,
            worker_resource_kind: "worker",
            weekdays: null,
            from_time: null,
            until_time: null,
            price_cents: String(example.price === "free" ? 0 : dollarsToCents(example.price ?? "")),
            from_cents: null,
            currency: "USD",
            set_by_person_id: owner,
            effective_from: seededAt,
            effective_to: null,
            version: 1,
          });
        } else {
          quotedFlows.add(flow);
        }
        if (after === "bill") {
          billFlows.add(flow);
        }
      });
    }
    examples.set(shop.id, ofShop);
    const rule = (id: string, kind: string, flow: Flow | null): Row => ({
      id: `rule-demo-${shop.id}-${id}`,
      business_id: businessId,
      rule_kind: kind,
      value_type: "on",
      flow,
      kind_id: null,
      value_on: true,
      value_cents: null,
      value_currency: null,
      value_span: null,
      value_count: null,
      value_dates: null,
      words: null,
      set_by_person_id: owner,
      effective_from: seededAt,
      effective_to: null,
      version: 1,
    });
    rows.rules.push(
      rule("ok-same-day", "ok_same_day", null),
      rule("ok-new-customer", "ok_new_customer", null),
    );
    if (factsOf(shop).includes("tips") && billFlows.size > 0) {
      rows.rules.push(rule("tip-line", "tip_line", scopeOf(billFlows)));
    }
    if (quotedFlows.size > 0) {
      rows.price_ok_limits.push({
        id: `pok-demo-${shop.id}-quotes`,
        business_id: businessId,
        flow: scopeOf(quotedFlows),
        kind_id: null,
        quotes: true,
        bills: false,
        over_cents: 0,
        currency: "USD",
        set_by_person_id: owner,
        effective_from: seededAt,
        effective_to: null,
        version: 1,
      });
    }
  }
  for (const table of TABLES) {
    rows[table].sort(byId);
  }
  return { rows, examples };
}

/** Every row of the five tables, as plain objects in code-point order of id, amounts and intervals read as text. */
async function snapshot(sql: Sql): Promise<Record<Table, Row[]>> {
  const sorted = (found: Iterable<Row>): Row[] => [...found].sort(byId);
  return {
    services: sorted(
      await sql<Row[]>`
      select id, business_id, kind_id, name, price_kind, unit, length::text as length, position, active, extras,
        version
      from services
    `,
    ),
    service_money: sorted(
      await sql<Row[]>`
      select id, service_id, business_id, flow, place, location_id, path, deposit_cents::text as deposit_cents,
        deposit_percent, fee_cents::text as fee_cents, currency, cutoff_before::text as cutoff_before,
        cutoff_day_before_at::text as cutoff_day_before_at, tip_line, active, version
      from service_money
    `,
    ),
    price_rules: sorted(
      await sql<Row[]>`
      select id, business_id, service_id, service_money_id, worker_resource_id, worker_resource_kind, weekdays,
        from_time::text as from_time, until_time::text as until_time, price_cents::text as price_cents,
        from_cents::text as from_cents, currency, set_by_person_id, effective_from, effective_to, version
      from price_rules
    `,
    ),
    rules: sorted(
      await sql<Row[]>`
      select id, business_id, rule_kind, value_type, flow, kind_id, value_on, value_cents, value_currency,
        value_span::text as value_span, value_count, value_dates::text as value_dates, words, set_by_person_id,
        effective_from, effective_to, version
      from rules
    `,
    ),
    price_ok_limits: sorted(await sql<Row[]>`select * from price_ok_limits`),
  };
}

async function rowCounts(sql: Sql): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
    counts[table] = row?.n ?? -1;
  }
  return counts;
}

/** K-26's three registries, whole, in key order. */
async function registries(sql: Sql): Promise<Record<string, Row[]>> {
  return {
    plugin_switches: [...(await sql<Row[]>`select * from plugin_switches order by name`)],
    rule_kinds: [...(await sql<Row[]>`select * from rule_kinds order by id`)],
    trade_facts: [...(await sql<Row[]>`select * from trade_facts order by name`)],
  };
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

/** What a refused call threw. */
async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("the seed ran; it should have refused");
}

/** What a refused synchronous call threw. */
function thrown(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("the call ran; it should have refused");
}

interface Copy {
  root: string;
  /** Its fixtures/ folder: the jail the copy is opened with. */
  fixtures: string;
  v1: string;
}

const copies: string[] = [];

/** A byte-for-byte copy of fixtures/v1 at <temp>/fixtures/v1. */
function copyOfV1(): Copy {
  const root = mkdtempSync(path.join(tmpdir(), "rosie-seed-services-"));
  copies.push(root);
  const fixtures = path.join(root, "fixtures");
  const v1 = path.join(fixtures, "v1");
  cpSync(V1, v1, { recursive: true });
  return { root, fixtures, v1 };
}

/** Rewrites one demo shop file of a copy and its MANIFEST.sha256 line, so the copy still matches its manifest. */
function rewriteShop(copy: Copy, id: string, change: (file: ShopFile) => void): void {
  const relative = `${SHOPS}/${id}.json`;
  const file = path.join(copy.v1, relative);
  const parsed = readJson(file) as ShopFile;
  change(parsed);
  writeFileSync(file, `${JSON.stringify(parsed, null, 1)}\n`);
  const manifest = path.join(copy.v1, "MANIFEST.sha256");
  const lines = readFileSync(manifest, "utf8")
    .split("\n")
    .map((line) => (line.endsWith(`  ${relative}`) ? `${sha256(file)}  ${relative}` : line));
  writeFileSync(manifest, lines.join("\n"));
}

/** One money example of a parsed shop file, to change in a copy. */
function exampleOf(file: ShopFile, flow: Flow, index: number): MoneyExample {
  const found = file.flows[flow]?.services[index];
  if (found === undefined) {
    throw new Error(`${file.id} has no flows.${flow}.services[${String(index)}]`);
  }
  return found;
}

/** Flips one bit of the byte in the middle of a file (doing it twice restores the file). */
function flipOneByte(file: string): void {
  const bytes = readFileSync(file);
  const at = Math.floor(bytes.length / 2);
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  writeFileSync(file, bytes);
}

const seedFromCopy = (sql: Sql, copy: Copy): Promise<ServicesRulesSeedResult> =>
  seedSetupServicesRulesFrom(sql, openFixtureSet(copy.v1, { jail: copy.fixtures }));

afterAll(() => {
  for (const root of copies) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("the services and rules seed, loaded from fixture set v1 after the core, setup and kinds seeds", () => {
  let db: TestDatabase;
  let first: ServicesRulesSeedResult;
  let seededAt: Date;
  let expected: Expected;
  let registriesBefore: Record<string, Row[]>;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_services_rules" });
    await seedCore(db.sql);
    await seedSetupBusiness(db.sql, { wrappingKeys: KEYS });
    await seedKinds(db.sql);
    registriesBefore = await registries(db.sql);
    first = await seedSetupServicesRules(db.sql);
    seededAt = await fixtureSetMade(db.sql);
    expected = expectedRows(seededAt);
  }, 180_000);

  // Dropping a schema can pass the 10 s hook default while other builders load the database (a resource guard only).
  afterAll(async () => {
    await db.drop();
  }, 120_000);

  it("gives each of the 245 shops its fixture services: one service and one way per money example of its file, in the file's order, named as the file names them, at the shop's own location and filed under its kind", async () => {
    expect(SHOP_FILES).toHaveLength(245);
    expect(Number.isNaN(seededAt.getTime())).toBe(false);
    const held = await snapshot(db.sql);
    expect(held.services).toEqual(expected.rows.services);
    expect(held.service_money).toEqual(expected.rows.service_money);
    expect(first.tables).toEqual(
      Object.fromEntries(
        TABLES.map((table) => [
          table,
          { rows: expected.rows[table].length, inserted: expected.rows[table].length, kept: 0 },
        ]),
      ),
    );
    // Every shop has services, and as many as its file has money examples; flow A's come first in each list.
    const perShop = new Map<string, number>();
    for (const row of held.services) {
      perShop.set(String(row.business_id), (perShop.get(String(row.business_id)) ?? 0) + 1);
    }
    for (const shop of SHOP_FILES) {
      const inFile = FLOWS.reduce((sum, flow) => sum + (shop.flows[flow]?.services.length ?? 0), 0);
      expect(inFile, shop.id).toBeGreaterThan(0);
      expect(perShop.get(`biz-demo-${shop.id}`), shop.id).toBe(inFile);
    }
    // Each service of a profession shop is filed under the kind the kinds seed picked for that shop.
    const [filed] = await db.sql<{ picked: number; mixed: number; all: number }[]>`
      select
        (select count(*)::int from services s join picked_kinds p
           on p.business_id = s.business_id and p.kind_id = s.kind_id) as picked,
        (select count(*)::int from services s
           where s.business_id in ('biz-demo-test-mixed-A', 'biz-demo-test-mixed-B')) as mixed,
        (select count(*)::int from services) as "all"
    `;
    expect(filed?.picked).toBe((filed?.all ?? 0) - (filed?.mixed ?? 0));
    expect(
      first.shops.filter((shop) => shop.kindFrom === "default").map((shop) => [shop.shopId, shop.kindId]),
    ).toEqual([
      ["test-mixed-A", "barber"],
      ["test-mixed-B", "plumber"],
    ]);
  });

  it("test-mixed-B offers list|card|bill (G2): its kitchen drain clearing at the customer's place in flow B, a card saved for the $89 fee, Rosie's bill after, $179 from the list; and every path of the two test-mixed files is offered, so all 56 paths are", async () => {
    const offered = await db.sql<Row[]>`
      select s.name, m.flow, m.place, m.location_id, m.fee_cents::text as fee, m.currency, m.active,
        r.price_cents::text as price, r.effective_to
      from service_money m
      join services s on s.id = m.service_id
      left join price_rules r on r.service_id = s.id
      where m.business_id = 'biz-demo-test-mixed-B' and m.path = 'list|card|bill'
    `;
    expect(offered).toEqual([
      {
        name: "Kitchen drain clearing",
        flow: "B",
        place: "customer",
        location_id: "loc-demo-test-mixed-B",
        fee: "8900",
        currency: "USD",
        active: true,
        price: "17900",
        effective_to: null,
      },
    ]);
    for (const id of ["test-mixed-A", "test-mixed-B"]) {
      const inFile = FLOWS.flatMap((flow) =>
        (SHOP_OF.get(id)?.flows[flow]?.services ?? []).map((example) => `${flow} ${example.combo}`),
      ).sort();
      const held = await db.sql<{ way: string }[]>`
        select flow || ' ' || path as way from service_money where business_id = ${`biz-demo-${id}`}
      `;
      expect(held.map((row) => row.way).sort(), id).toEqual(inFile);
    }
    const [paths] = await db.sql<
      { n: number }[]
    >`select count(distinct (flow, path))::int as n from service_money`;
    expect(paths?.n).toBe(PATH_COUNT);
  });

  it("no price rule overlaps: each list-priced service has one rule, its own price from when fixture set v1 was made with no end; no two rules of one service with the same conditions are in effect at once, and the database refuses one more (23P01); photo and visit paths have none", async () => {
    const held = await snapshot(db.sql);
    expect(held.price_rules).toEqual(expected.rows.price_rules);
    const [overlaps] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from price_rules a join price_rules b
        on a.service_id = b.service_id and a.id <> b.id
        and coalesce(a.service_money_id, '') = coalesce(b.service_money_id, '')
        and coalesce(a.worker_resource_id, '') = coalesce(b.worker_resource_id, '')
        and coalesce(a.weekdays, '') = coalesce(b.weekdays, '')
        and coalesce(a.from_time, time '00:00') = coalesce(b.from_time, time '00:00')
        and coalesce(a.until_time, time '24:00') = coalesce(b.until_time, time '24:00')
        and tstzrange(a.effective_from, a.effective_to, '[)') && tstzrange(b.effective_from, b.effective_to, '[)')
    `;
    expect(overlaps?.n).toBe(0);
    const [ways] = await db.sql<
      { list: number; listWithOne: number; quoted: number; quotedWithRule: number }[]
    >`
      select
        count(*) filter (where split_part(m.path, '|', 1) = 'list')::int as list,
        count(*) filter (where split_part(m.path, '|', 1) = 'list' and
          (select count(*) from price_rules r where r.service_id = m.service_id
             and tstzrange(r.effective_from, r.effective_to, '[)') @> ${seededAt}::timestamptz
             and tstzrange(r.effective_from, r.effective_to, '[)') @> now()) = 1)::int as "listWithOne",
        count(*) filter (where split_part(m.path, '|', 1) <> 'list')::int as quoted,
        count(*) filter (where split_part(m.path, '|', 1) <> 'list' and
          exists (select 1 from price_rules r where r.service_id = m.service_id))::int as "quotedWithRule"
      from service_money m
    `;
    expect(ways?.listWithOne).toBe(ways?.list);
    expect(ways?.list).toBe(expected.rows.price_rules.length);
    expect(ways?.quotedWithRule).toBe(0);
    expect(ways?.quoted).toBeGreaterThan(0);
    // A second rule with the same conditions in effect beside a seeded one is refused by the EXCLUDE itself.
    const one = expected.rows.price_rules[0];
    const error = await refusal(
      db.sql.begin(async (tx) => {
        await tx`
          insert into price_rules (id, business_id, service_id, price_cents, currency, set_by_person_id, effective_from)
          values (${"price-demo-probe-second"}, ${String(one?.business_id)}, ${String(one?.service_id)}, 1, 'USD',
            ${String(one?.set_by_person_id)}, ${seededAt})
        `;
      }),
    );
    expect(error).toMatchObject({ code: "23P01", constraint_name: "price_rules_one_in_effect" });
  });

  it("amounts are integer cents: every price, deposit and fee is the file's dollars times 100, in whole-cent columns, agreeing with the file's own due-now figure, in USD; a deposit only on a deposit path and never above its list price, and no fee on a path that takes nothing before", async () => {
    const columns = await db.sql<{ table_name: string; column_name: string; data_type: string }[]>`
      select table_name, column_name, data_type from information_schema.columns
      where table_schema = current_schema() and column_name in ('price_cents', 'from_cents', 'deposit_cents',
        'fee_cents', 'over_cents') and table_name in ('service_money', 'price_rules', 'price_ok_limits')
      order by table_name, column_name
    `;
    expect(columns.map((row) => `${row.table_name}.${row.column_name} ${row.data_type}`)).toEqual([
      "price_ok_limits.over_cents integer",
      "price_rules.from_cents bigint",
      "price_rules.price_cents bigint",
      "service_money.deposit_cents bigint",
      "service_money.fee_cents bigint",
    ]);
    const held = await snapshot(db.sql);
    const wholeCents = /^(0|[1-9][0-9]*)$/;
    const wayOf = new Map(held.service_money.map((row) => [String(row.id), row]));
    const ruleOf = new Map(held.price_rules.map((row) => [String(row.service_id), row]));
    let deposits = 0;
    for (const [shopId, examples] of expected.examples) {
      for (const { example, key } of examples) {
        const [price, before] = example.combo.split("|");
        const way = wayOf.get(`way-demo-${key}`);
        const rule = ruleOf.get(`svc-demo-${key}`);
        const label = `${shopId} ${key}`;
        // Read back as text, each amount held is a whole number of cents.
        for (const amount of [way?.deposit_cents, way?.fee_cents, rule?.price_cents]) {
          if (amount !== null && amount !== undefined) {
            expect(amount, label).toMatch(wholeCents);
          }
        }
        if (before === "deposit") {
          deposits += 1;
          // The deposit taken at booking is the file's due-now figure, in dollars.
          expect(Number(way?.deposit_cents), label).toBe(example.due_now_at_booking * 100);
          if (rule !== undefined) {
            expect(Number(way?.deposit_cents), label).toBeLessThanOrEqual(Number(rule.price_cents));
          }
        } else {
          expect(way?.deposit_cents, label).toBeNull();
        }
        if (price === "list" && before === "full") {
          // A list price paid in full when booking is the file's due-now figure, in dollars.
          expect(Number(rule?.price_cents), label).toBe(example.due_now_at_booking * 100);
        }
        if (before === "none") {
          expect(way?.fee_cents, label).toBeNull();
        }
        expect(way, label).toBeDefined();
        const holdsMoney = way !== undefined && (way.deposit_cents !== null || way.fee_cents !== null);
        expect(way?.currency, label).toBe(holdsMoney ? "USD" : null);
      }
    }
    expect(deposits).toBeGreaterThan(0);
    expect(held.price_rules.every((row) => row.currency === "USD" && row.from_cents === null)).toBe(true);
    expect(held.price_ok_limits.every((row) => row.over_cents === 0 && row.currency === "USD")).toBe(true);
  });

  it("keeps S1-21's tap list as shown for every shop: same-day and new customers ask the owner first; a tip line where the shop's facts list tips and a way sends Rosie's bill; every quote comes to the owner first in the flows with a quoted way; nothing else, and K-26's registries are untouched", async () => {
    const held = await snapshot(db.sql);
    expect(held.rules).toEqual(expected.rows.rules);
    expect(held.price_ok_limits).toEqual(expected.rows.price_ok_limits);
    const kinds = await db.sql<{ rule_kind: string; n: number }[]>`
      select rule_kind, count(*)::int as n from rules group by rule_kind order by rule_kind
    `;
    const tipLines = expected.rows.rules.filter((row) => row.rule_kind === "tip_line").length;
    expect(tipLines).toBeGreaterThan(0);
    expect(kinds).toEqual([
      { rule_kind: "ok_new_customer", n: 245 },
      { rule_kind: "ok_same_day", n: 245 },
      { rule_kind: "tip_line", n: tipLines },
    ]);
    // Each owner rule's kind is in the registry with its type, and the fact it needs is one the shop's kind lists.
    const [unmatched] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from rules r
      join rule_kinds k on k.id = r.rule_kind
      left join company_kinds c on c.business_id = r.business_id
      where k.value_type <> r.value_type
        or (k.needs_fact is not null and not (coalesce(c.pf_facts, '{}') @> array[k.needs_fact]))
    `;
    expect(unmatched?.n).toBe(0);
    expect(await registries(db.sql)).toEqual(registriesBefore);
    expect(registriesBefore.rule_kinds).toHaveLength(16);
    expect(registriesBefore.trade_facts).toHaveLength(28);
    expect(registriesBefore.plugin_switches).toHaveLength(6);
  });

  it("traces every shop to its fixture set v1 file at the hash MANIFEST.sha256 lists, and records each value of an example it does not hold, as the file words it", () => {
    expect(first.fixtureSet).toEqual({
      dir: realpathSync(V1),
      manifestSha256: sha256(path.join(V1, "MANIFEST.sha256")),
      filesChecked: LISTED.size,
    });
    expect(first.seededAt).toEqual({ at: seededAt, source: "test-kit/COVERAGE.md" });
    expect(first.shops.map((shop) => shop.shopId)).toEqual(SHOP_FILES.map((shop) => shop.id));
    for (const shop of first.shops) {
      const file = SHOP_OF.get(shop.shopId);
      expect(shop.source).toBe(`${SHOPS}/${shop.shopId}.json`);
      expect(LISTED.get(shop.source), shop.source).toBe(shop.sha256);
      expect(sha256(path.join(V1, shop.source)), shop.source).toBe(shop.sha256);
      expect(shop.kindFrom, shop.shopId).toBe(hasForm(shop.shopId) ? "pick" : "default");
      expect(shop.facts, shop.shopId).toEqual(file === undefined ? [] : factsOf(file));
      const examples = expected.examples.get(shop.shopId) ?? [];
      expect(
        shop.services.map((service) => [
          service.at,
          service.flow,
          service.path,
          service.priceNotHeld,
          service.depositNotHeld,
          service.feeNotHeld,
        ]),
        shop.shopId,
      ).toEqual(
        examples.map(({ flow, index, example }) => {
          const [price, before] = example.combo.split("|");
          const freeFee =
            example.fee === "free" || (example.fee !== null && dollarsToCents(example.fee) === 0);
          return [
            `flows.${flow}.services[${String(index)}]`,
            flow,
            example.combo,
            price === "list" ? null : example.price,
            before === "deposit" ? null : example.deposit,
            before === "none" && !freeFee ? example.fee : null,
          ];
        }),
      );
    }
  });

  it("writes as the job role, rosie_job, with no scope; under a shop's scope the Tool API role sees only that shop's services, ways, prices, rules and price OK limits", async () => {
    expect(first.ranAs).toBe("rosie_job");
    const seen = await withBusiness(db.sql, "biz-demo-barber", async (tx) => {
      await tx`set local role rosie_app`;
      const ids = async (table: Table): Promise<string[]> =>
        (await tx<{ id: string }[]>`select id from ${tx(table)}`).map((row) => row.id).sort(byCodePoint);
      return {
        services: await ids("services"),
        service_money: await ids("service_money"),
        price_rules: await ids("price_rules"),
        rules: await ids("rules"),
        price_ok_limits: await ids("price_ok_limits"),
      };
    });
    const barbers = (table: Table): string[] =>
      expected.rows[table]
        .filter((row) => row.business_id === "biz-demo-barber")
        .map((row) => String(row.id))
        .sort(byCodePoint);
    expect(seen).toEqual(Object.fromEntries(TABLES.map((table) => [table, barbers(table)])));
    expect(seen.services.length).toBeGreaterThan(0);
    expect(seen.rules).toEqual(["rule-demo-barber-ok-new-customer", "rule-demo-barber-ok-same-day"]);
    expect(seen.price_ok_limits).toEqual(["pok-demo-barber-quotes"]);
  });

  it(
    "running the seed twice leaves the same rows: the second run writes nothing, and every row and version stays as it was",
    SLOW,
    async () => {
      const before = await snapshot(db.sql);
      const second = await seedSetupServicesRules(db.sql);
      expect(second.tables).toEqual(
        Object.fromEntries(
          TABLES.map((table) => [
            table,
            { rows: expected.rows[table].length, inserted: 0, kept: expected.rows[table].length },
          ]),
        ),
      );
      expect(second.shops).toEqual(first.shops);
      expect(second.seededAt).toEqual(first.seededAt);
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
      const priceRuleId = barber?.services.find((service) => service.priceRuleId !== null)?.priceRuleId ?? "";
      expect(priceRuleId).not.toBe("");
      await db.sql`delete from price_rules where id = ${priceRuleId}`;
      await db.sql`delete from rules where id = 'rule-demo-barber-ok-new-customer'`;
      await db.sql`delete from price_ok_limits where id = 'pok-demo-barber-quotes'`;
      const third = await seedSetupServicesRules(db.sql);
      expect(Object.fromEntries(TABLES.map((table) => [table, third.tables[table].inserted]))).toEqual({
        services: 0,
        service_money: 0,
        price_rules: 1,
        rules: 1,
        price_ok_limits: 1,
      });
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );
});

describe("before the services and rules seed writes a row", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_services_rules_checks" });
  }, 120_000);

  // Dropping a schema can pass the 10 s hook default while other builders load the database (a resource guard only).
  afterAll(async () => {
    await db.drop();
  }, 120_000);

  it(
    "refuses to run before each seed it builds on, naming the one to run first, and writes nothing: the core seed, then the setup seed, then the kinds seed",
    SLOW,
    async () => {
      const noCore = await refusal(seedSetupServicesRules(db.sql));
      expect(noCore.message).toContain("run db/seeds/core.ts first");
      expect(noCore.message).toContain("245 of 245 shops");
      await seedCore(db.sql);
      const noSetup = await refusal(seedSetupServicesRules(db.sql));
      expect(noSetup.message).toContain("run db/seeds/setup-business.ts first");
      expect(noSetup.message).toContain("245 of 245 shops");
      await seedSetupBusiness(db.sql, { wrappingKeys: KEYS });
      const noKinds = await refusal(seedSetupServicesRules(db.sql));
      expect(noKinds.message).toContain("run db/seeds/kinds.ts first");
      expect(noKinds.message).toContain("243 of 243 demo shops");
      expect(await rowCounts(db.sql)).toEqual(EMPTY);
    },
  );

  it("refuses, naming the example, a way the files would give that K-25 or K-23 forbids: money through Rosie for a business that takes none, and a card path with no fee unless the work is sensitive", () => {
    const haircut = { combo: "list|card|counter", name: "Haircut", price: "$35", deposit: null, fee: "$20" };
    const noMoney = thrown(() =>
      readMoneyExample("x.json", "A", 0, haircut, { noMoney: true, sensitive: false }),
    );
    expect(noMoney.message).toContain("x.json: flows.A.services[0]'s path takes money through Rosie");
    const card = { ...haircut, fee: null };
    expect(
      thrown(() => readMoneyExample("x.json", "A", 0, card, { noMoney: false, sensitive: false })).message,
    ).toContain("gives no fee");
    expect(readMoneyExample("x.json", "A", 0, card, { noMoney: false, sensitive: true }).feeCents).toBeNull();
    const nothingTaken = { ...haircut, combo: "list|none|counter" };
    expect(
      readMoneyExample("x.json", "A", 0, nothingTaken, { noMoney: true, sensitive: false }),
    ).toMatchObject({
      priceCents: 3500,
      feeCents: null,
      feeNotHeld: "$20",
    });
  });

  describe("with the core, setup and kinds seeds' rows in place", () => {
    beforeAll(async () => {
      await seedCore(db.sql);
      await seedSetupBusiness(db.sql, { wrappingKeys: KEYS });
      await seedKinds(db.sql);
    }, 180_000);

    it(
      "checks fixture set v1 against MANIFEST.sha256 first: one changed byte in a demo shop stops it",
      SLOW,
      async () => {
        const copy = copyOfV1();
        flipOneByte(path.join(copy.v1, SHOPS, "barber.json"));
        const error = await refusal(seedFromCopy(db.sql, copy));
        expect(error).toBeInstanceOf(FixtureChecksumError);
        expect((error as FixtureChecksumError).problems).toEqual([`changed: ${SHOPS}/barber.json`]);
        expect(await rowCounts(db.sql)).toEqual(EMPTY);
      },
    );

    it(
      "refuses an intact copy of fixture set v1 that lies outside fixtures/, and writes nothing",
      SLOW,
      async () => {
        const copy = copyOfV1();
        const outside = await refusal(seedSetupServicesRules(db.sql, { fixturesDir: copy.v1 }));
        expect(outside).toBeInstanceOf(FixtureAccessError);
        expect(outside.message).toContain("outside");
        expect(await rowCounts(db.sql)).toEqual(EMPTY);
      },
    );

    it(
      "refuses, naming the file and the example, a money example it does not know how to read rather than guess: a list price in words, a deposit path with no deposit, a deposit above its list price, a path not among the flow's 28, a path repeated in one flow, a name that looks like a phone number, a card path with no fee",
      SLOW,
      async () => {
        const cases: [Flow, number, (example: MoneyExample) => void, string][] = [
          [
            "A",
            0,
            (example) => {
              example.price = "about 35 dollars";
            },
            "flows.A.services[0]'s price is not an amount in dollars",
          ],
          [
            "A",
            2,
            (example) => {
              example.deposit = null;
            },
            "flows.A.services[2]'s path takes a deposit, but it gives none",
          ],
          [
            "A",
            2,
            (example) => {
              example.deposit = "$400";
            },
            "flows.A.services[2]'s deposit is more than its list price",
          ],
          [
            "A",
            0,
            (example) => {
              example.combo = "list|card|own";
            },
            "flows.A.services[0]'s combo is not one of flow A's 28 money paths",
          ],
          [
            "A",
            1,
            (example) => {
              // The nothing-taken haircut becomes a second card-saved one, with its fee, so the repeat is its one fault.
              example.combo = "list|card|counter";
              example.fee = "$20";
            },
            "flows.A.services[1] repeats a money path of flow A",
          ],
          [
            "B",
            0,
            (example) => {
              example.name = "Call 212 555 0100";
            },
            "flows.B.services[0]'s name looks like a phone number",
          ],
          [
            "A",
            0,
            (example) => {
              example.fee = null;
            },
            "flows.A.services[0]'s path takes money before, but it gives no fee",
          ],
        ];
        for (const [flow, index, change, words] of cases) {
          const copy = copyOfV1();
          rewriteShop(copy, "barber", (file) => {
            change(exampleOf(file, flow, index));
          });
          const error = await refusal(seedFromCopy(db.sql, copy));
          expect(error.message, words).toContain(`${SHOPS}/barber.json: ${words}`);
          expect(error, words).not.toBeInstanceOf(FixtureChecksumError);
        }
        expect(await rowCounts(db.sql)).toEqual(EMPTY);
      },
    );

    it(
      "refuses a profession shop's path its kind of work does not offer in that flow (K-24 kind_flows.combos), naming the example, and writes nothing",
      SLOW,
      async () => {
        const copy = copyOfV1();
        rewriteShop(copy, "barber", (file) => {
          exampleOf(file, "A", 0).combo = "list|full|none";
        });
        const error = await refusal(seedFromCopy(db.sql, copy));
        expect(error.message).toContain(
          `${SHOPS}/barber.json: flows.A.services[0]'s money path is not one its kind of work offers in flow A`,
        );
        expect(await rowCounts(db.sql)).toEqual(EMPTY);
      },
    );

    it(
      "loads from an untouched copy opened the same way, so each refusal above had its one reason",
      SLOW,
      async () => {
        const copy = copyOfV1();
        const result = await seedFromCopy(db.sql, copy);
        expect(result.ranAs).toBe("rosie_job");
        expect(result.tables.services.inserted).toBe(result.tables.services.rows);
        expect(result.tables.services.rows).toBeGreaterThan(245);
        expect((await rowCounts(db.sql)).services).toBe(result.tables.services.rows);
      },
    );
  });
});
