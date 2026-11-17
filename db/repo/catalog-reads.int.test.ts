// T-1428: K-05 v1.18's five catalog reads (db/repo/catalog-reads.ts) against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/repo/catalog-reads`). The schema comes from migrating a fresh test schema, which
// test-db.ts drops when the file ends.
//
// Every read runs as the Tool API's role, rosie_app (K-05 v1.18 items 72 to 76, default 154), through a client whose
// connections run as that role, under the request's own business. The tables' owner (the migrations' role) loads the
// seeds a fixture's `given` names (K-04's, and K-23's to K-30's as partSeeds, each with its own after chain, each file
// once; a K-26 registry row a chain names is found as migration 0023 wrote it, never inserted again) and writes the rows
// a fixture's note lists (read-price-rules-haircut-tie's two, first) and the rows a test adds. The owner is not bound by
// row-level security, so only the reads under test meet it.
//
// The role client records every statement it sends (postgres.js `debug`: the text, never the values), so the column
// test reads what the five reads sent, not a copy of their SQL: each read's tables and columns and no other, never `*`
// or a whole row, the business named beside every business-scoped table, item 77's names built in SQL (T-1428's card:
// "no column outside the list"; README "What the new tasks must hold to").
//
// Rule 9: every row comes from fixture set v1's demo shops through the frozen seeds, or is a seed row under a new id or
// with one fault (an evening price, a Sunday price, a notice rule, date ranges); no number, address or name is made up.
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BusinessKindRead,
  type CatalogRead,
  type OwnerRuleRead,
  readBusinessKinds,
  readBusinessKindsIn,
  type ReadBusinessKindsResponse,
  readBusinessServices,
  readBusinessServicesIn,
  type ReadBusinessServicesResponse,
  readServicePriceRules,
  readServicePriceRulesIn,
  type ReadServicePriceRulesResponse,
  readServiceWays,
  readServiceWaysIn,
  type ReadServiceWaysResponse,
  readTermsSources,
  readTermsSourcesIn,
  type ReadTermsSourcesResponse,
} from "./catalog-reads";
import { resolvePrimaryUrl } from "./client";
import { BusinessScopeError, setBusinessScope, type Sql, type Tx, withBusiness } from "./scope";
import type { ReadOptions } from "./targets";
import { createTestDatabase, type TestDatabase } from "./test-db";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Request = Record<string, Json>;

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const DB_SCHEMA_DIR = new URL("db-schema/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const VERSION = "v1.18";
const APP_ROLE = "rosie_app";
const SLOW = { timeout: 120_000 };
/** A one-moment transaction, as each read's own begins (targets.ts inRuntimeTransaction; T-1427's review N2). */
const ONE_MOMENT = "isolation level repeatable read read only";

const BARBERSHOP = "biz-lees-barbershop";
const HOME_SERVICES = "biz-lee-home-services";
const YOGA = "biz-yoga-studio";
const MOVERS = "biz-movers";
const HAIRCUT = "svc-lees-haircut";
const SKIN_FADE_WAY = "way-lees-skin-fade-shop";
const FAUCET_REBUILD = "svc-lee-plumbing-faucet-rebuild";
/** Instants the reads are asked at: a day before the haircut's raise, and a week after the tap list. */
const OCT_27 = "2026-10-27T14:00:00Z";
const OCT_29 = "2026-10-29T14:00:00Z";
const NOV_4 = "2026-11-04T14:00:00Z";
/** The start of Mon Nov 2 in the businesses' zone, America/New_York (K-25's seeds: the raise's instant). */
const NOV_2 = "2026-11-02T05:00:00Z";

const CALLS = [
  "readBusinessKinds",
  "readBusinessServices",
  "readServiceWays",
  "readServicePriceRules",
  "readTermsSources",
] as const satisfies readonly CatalogRead[];
type Call = (typeof CALLS)[number];

interface IndexEntry {
  file: string;
  version: string;
  def?: string;
  expect: string;
}

interface Given {
  k04Seeds: string[];
  partSeeds?: string[];
  after: string[];
  now: string;
  note?: string;
}

interface Exchange {
  call: string;
  given: Given;
  request: Request;
  outcome: Record<string, Json>;
}

interface SeedRow {
  table: string;
  values: Record<string, Json>;
}

interface SeedFile {
  after: string[];
  rows: SeedRow[];
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const exchangeOf = (file: string): Exchange => readJson(new URL(file, ACCESS_DIR)) as Exchange;
const INDEX = (readJson(new URL("index.json", ACCESS_DIR)) as { fixtures: IndexEntry[] }).fixtures;
/** Every v1.18 entry of the index, selected by its version, never by a pinned list or count (DL-124, DL-125). */
const ENTRIES = INDEX.filter((entry) => entry.version === VERSION);
const ACCEPTED = ENTRIES.filter((entry) => entry.expect === "accept").map((entry) => entry.file);
/** The refused v1.18 exchanges, each refused for its request (README "Fixtures", v1.18: by `<call>.exchange`). */
const REFUSED_REQUESTS = ENTRIES.filter(
  (entry) => entry.expect === "refuse" && entry.def?.endsWith(".exchange") === true,
).map((entry) => entry.file);

function isCall(call: string): call is Call {
  return (CALLS as readonly string[]).includes(call);
}

function callOf(exchange: Exchange): Call {
  if (!isCall(exchange.call)) {
    throw new Error(`v1.18 adds no call ${exchange.call}`);
  }
  return exchange.call;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The answer as the response `result` names, refused when it is anything else (an error). */
function answerOf<T extends { result: string }>(answer: unknown, result: T["result"]): T {
  if (!isRecord(answer) || answer.result !== result) {
    throw new Error(`expected the answer ${result}`);
  }
  return answer as T;
}

// ---- the contract's own schema, for every answer (Ajv 2020-12, strict, as contracts:check runs it) -------------------

function schemaFiles(dir: URL): URL[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".schema.json") && !file.endsWith(".meta.schema.json"))
    .filter((file) => !file.startsWith("generated/") && !file.startsWith("scripts/"))
    .filter((file) => !file.includes("node_modules"))
    .map((file) => new URL(file, dir));
}

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
for (const file of schemaFiles(CONTRACTS)) {
  ajv.addSchema(readJson(file) as object);
}
const V118_ID = (readJson(new URL("data-access/data-access.v1.18.schema.json", CONTRACTS)) as { $id: string })
  .$id;

/** Ajv's errors for `value` against one $defs entry of data-access v1.18; none when it passes. */
function schemaErrors(def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${V118_ID}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`data-access v1.18 has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

/** An answer against its call's response, or its call's errors when it is one. */
function answerErrors(call: Call, answer: unknown): string[] {
  const isError = isRecord(answer) && "error" in answer;
  return schemaErrors(isError ? `${call}.errors` : `${call}.response`, answer);
}

// ---- databases and clients ------------------------------------------------------------------------------------------

let db: TestDatabase;
/** Connections that run as rosie_app, the Tool API's role, with this file's schema first. */
let app: Sql;
let typedColumns: Map<string, string>;
/** Every table of this file's schema. */
let schemaTables: Set<string>;
/** Every table's columns, by table. */
let schemaColumns: Map<string, Set<string>>;
/** Every statement the role client sent, in order (postgres.js debug: the text, never the values). */
const sent: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase({ name: "catalog_reads" });
  app = db.connect({
    max: 4,
    onnotice: () => undefined,
    debug: (_connection: number, query: string) => {
      sent.push(query);
    },
    connection: { application_name: "rosie-t1428-app", search_path: `${db.schema}, public`, role: APP_ROLE },
  });
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typedColumns = new Map(typed.map((column) => [column.key, column.type]));
  const tables = await db.sql<{ name: string }[]>`
    select table_name as name from information_schema.tables where table_schema = ${db.schema}
  `;
  schemaTables = new Set(tables.map((table) => table.name));
  const columns = await db.sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name from information_schema.columns where table_schema = ${db.schema}
  `;
  schemaColumns = new Map();
  for (const column of columns) {
    const ofTable = schemaColumns.get(column.table_name) ?? new Set<string>();
    schemaColumns.set(column.table_name, ofTable.add(column.column_name));
  }
}, 120_000);

afterAll(async () => {
  await app.end({ timeout: 5 });
  await db.drop();
});

// ---- seeds ------------------------------------------------------------------------------------------------------------

/**
 * Empties every table the seeds write (truncating the heads, and K-24's catalog of kinds, cascades to the rest; this
 * file's schema only). K-26's registries refer to no head, so migration 0023's seed of them stays.
 */
async function reset(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags, kinds restart identity cascade`;
}

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** One row as the database takes it: JSON for a jsonb column, bytes for a bytea one (`\x` and hex). */
async function insertRow(sql: Db, table: string, row: Record<string, Json>): Promise<void> {
  const values: Record<string, never> = {};
  for (const [column, value] of Object.entries(row)) {
    const type = typedColumns.get(`${table}.${column}`);
    let converted: unknown = value;
    if (type === "jsonb" && value !== null) {
      converted = sql.json(value);
    } else if (type === "bytea" && typeof value === "string") {
      converted = fromHex(value.replace(/^\\x/, ""));
    }
    values[column] = converted as never;
  }
  await sql`insert into ${sql(table)} ${sql(values)}`;
}

/** A seed file's rows after those of its `after` chain, each named relative to the file that names it, each file once. */
function seedRows(file: URL, seen: Set<string>): SeedRow[] {
  if (seen.has(file.href)) {
    return [];
  }
  seen.add(file.href);
  const seed = readJson(file) as SeedFile;
  return [...seed.after.flatMap((before) => seedRows(new URL(before, file), seen)), ...seed.rows];
}

/** `<part>/<file>`, a seed of another database part (K-05 given.partSeeds), in that part's fixtures folder. */
function partSeedUrl(name: string): URL {
  const slash = name.indexOf("/");
  if (slash < 1) {
    throw new Error(`partSeeds names <part>/<file>, not ${name}`);
  }
  return new URL(`${name.slice(0, slash)}/fixtures/${name.slice(slash + 1)}`, DB_SCHEMA_DIR);
}

/** The seed files a fixture's given names: K-04's, then the other parts'. */
const seedsOf = (state: Given): URL[] => [
  ...state.k04Seeds.map((seed) => new URL(seed, CORE_DIR)),
  ...(state.partSeeds ?? []).map(partSeedUrl),
];

/** K-26's closed registries and their keys: only a migration's seed writes them (K-26 rule 5). */
const REGISTRY_KEYS: ReadonlyMap<string, string> = new Map([
  ["trade_facts", "name"],
  ["plugin_switches", "name"],
  ["rule_kinds", "id"],
]);

/**
 * Inserts the rows of these seed files and their chains, each row once, then `noted`, in one transaction as the
 * tables' owner. A registry row is found as migration 0023 wrote it and never inserted again (T-1427's database review
 * N4: look up, not insert).
 */
async function loadSeeds(files: readonly URL[], noted: readonly SeedRow[] = []): Promise<void> {
  const seen = new Set<string>();
  const rows = [...files.flatMap((file) => seedRows(file, seen)), ...noted];
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      const key = REGISTRY_KEYS.get(row.table);
      if (key === undefined) {
        await insertRow(tx, row.table, row.values);
        continue;
      }
      const name = row.values[key];
      if (typeof name !== "string") {
        throw new Error(`a ${row.table} seed row names no ${key}`);
      }
      const [found] = await tx<{ rows: number }[]>`
        select count(*)::int as rows from ${tx(row.table)} where ${tx(key)} = ${name}
      `;
      if (found?.rows !== 1) {
        throw new Error(`${row.table} ${name}: migration 0023's registry seed does not hold it`);
      }
    }
  });
}

// ---- the rows read-price-rules-haircut-tie's note lists (README "Fixtures", v1.18: written first, in its order) ------

const TIE_FIXTURE = "read-price-rules-haircut-tie.json";
/** Sam's evening price on the haircut, as the note gives it: every day from 17:00, $45, open from Nov 3. */
const EVENING = {
  id: "price-lees-haircut-evening",
  fromTime: "17:00",
  priceCents: 4500,
  currency: "USD",
  setBy: "person-sam",
  effectiveFrom: "2026-11-03T15:00:00Z",
  version: 1,
} as const;
/** The tie between the home price and the evening price, as the note gives it: asked, not answered. */
const TIE = {
  id: "tie-lees-haircut-home-evening",
  firstRuleId: "price-lees-haircut-home",
  secondRuleId: EVENING.id,
  askedAt: "2026-11-03T15:00:00Z",
  version: 1,
} as const;

const EVENING_RULE: SeedRow = {
  table: "price_rules",
  values: {
    id: EVENING.id,
    business_id: BARBERSHOP,
    service_id: HAIRCUT,
    service_money_id: null,
    worker_resource_id: null,
    weekdays: null,
    from_time: EVENING.fromTime,
    until_time: null,
    price_cents: EVENING.priceCents,
    from_cents: null,
    currency: EVENING.currency,
    set_by_person_id: EVENING.setBy,
    effective_from: EVENING.effectiveFrom,
    effective_to: null,
    version: EVENING.version,
  },
};
const EVENING_TIE: SeedRow = {
  table: "price_rule_ties",
  values: {
    id: TIE.id,
    business_id: BARBERSHOP,
    service_id: HAIRCUT,
    first_rule_id: TIE.firstRuleId,
    second_rule_id: TIE.secondRuleId,
    asked_at: TIE.askedAt,
    winner_rule_id: null,
    answered_at: null,
    answered_by_person_id: null,
    version: TIE.version,
  },
};

/** How the tie fixture's note lists its two rows, in its own words and order, value for value. */
const TIE_NOTE_PHRASES = [
  `price_rules ${EVENING.id} (business ${BARBERSHOP}, service ${HAIRCUT}, no place or worker, every day, from ` +
    `${EVENING.fromTime} with no end time, ${String(EVENING.priceCents)} cents in ${EVENING.currency}, set by ` +
    `${EVENING.setBy}, effective from ${EVENING.effectiveFrom} and open, version ${String(EVENING.version)})`,
  `price_rule_ties ${TIE.id} (business ${BARBERSHOP}, service ${HAIRCUT}, first rule ${TIE.firstRuleId}, second rule ` +
    `${TIE.secondRuleId}, asked at ${TIE.askedAt}, not answered, version ${String(TIE.version)})`,
];

/** By fixture, the rows its note says its database side writes itself, in its order (no frozen seed holds a tie). */
const NOTED_ROWS: Readonly<Record<string, readonly SeedRow[]>> = {
  [TIE_FIXTURE]: [EVENING_RULE, EVENING_TIE],
};

/** Loads a fixture's world: its seeds with their chains, then the rows its note lists. */
async function given(file: string): Promise<Exchange> {
  const exchange = exchangeOf(file);
  if (exchange.given.after.length > 0) {
    throw new Error(`${file}: a v1.18 read runs after no exchange`);
  }
  await reset();
  await loadSeeds(seedsOf(exchange.given), NOTED_ROWS[file] ?? []);
  return exchange;
}

/**
 * Every v1.18 fixture's seeds at once, each file once, K-25's withdrawn price beside them, then the noted rows: the
 * barbershop, Lee Home Services, the yoga studio and the movers, each with its own rows.
 */
const WORLD_SEEDS: URL[] = [
  ...new Set([
    ...ACCEPTED.flatMap((file) => seedsOf(exchangeOf(file).given).map((url) => url.href)),
    partSeedUrl("services-prices/seed-price-withdrawn-before-start.json").href,
  ]),
].map((href) => new URL(href));

async function world(): Promise<void> {
  await reset();
  await loadSeeds(WORLD_SEEDS, Object.values(NOTED_ROWS).flat());
}

// ---- the reads ----------------------------------------------------------------------------------------------------------

type OwnRead = (sql: Sql, request: never, options?: ReadOptions) => Promise<unknown>;
type InRead = (db: Db, request: never, options?: ReadOptions) => Promise<unknown>;

/** Each call in a read-only transaction of its own. */
const OWN: Readonly<Record<Call, OwnRead>> = {
  readBusinessKinds,
  readBusinessServices,
  readServiceWays,
  readServicePriceRules,
  readTermsSources,
};

/** Each call inside a transaction its caller holds. */
const IN: Readonly<Record<Call, InRead>> = {
  readBusinessKinds: readBusinessKindsIn,
  readBusinessServices: readBusinessServicesIn,
  readServiceWays: readServiceWaysIn,
  readServicePriceRules: readServicePriceRulesIn,
  readTermsSources: readTermsSourcesIn,
};

const nowOf = (exchange: Exchange): ReadOptions => ({ now: new Date(exchange.given.now) });

/** The read a fixture names, as rosie_app, in its own transaction, at the fixture's clock. */
async function runRead(exchange: Exchange): Promise<unknown> {
  return await OWN[callOf(exchange)](app, structuredClone(exchange.request) as never, nowOf(exchange));
}

/** An In read as rosie_app, in a transaction `mode` begins (one moment by default), under `scope` when one is given. */
async function appIn(
  call: Call,
  request: Request,
  scope: string | null,
  options: ReadOptions = {},
  mode: string = ONE_MOMENT,
): Promise<unknown> {
  return await app.begin(mode, async (tx) => {
    if (scope !== null) {
      await setBusinessScope(tx, scope);
    }
    return IN[call](tx, request as never, options);
  });
}

/** An In read by the tables' owner, whom row-level security does not bind, in a one-moment transaction under `scope`. */
async function ownerIn(
  call: Call,
  request: Request,
  scope: string,
  options: ReadOptions = {},
): Promise<unknown> {
  return await db.sql.begin(ONE_MOMENT, async (tx) => {
    await setBusinessScope(tx, scope);
    return IN[call](tx, request as never, options);
  });
}

/** One request of each call for `businessId`, naming the barbershop's haircut where a call takes a service. */
function requestsFor(businessId: string): [Call, Request][] {
  return [
    ["readBusinessKinds", { businessId }],
    ["readBusinessServices", { businessId }],
    ["readServiceWays", { businessId, serviceId: HAIRCUT }],
    ["readServicePriceRules", { businessId, serviceId: HAIRCUT, at: OCT_27 }],
    ["readTermsSources", { businessId, at: OCT_29 }],
  ];
}

/**
 * The rows an answer holds, never the request it echoes: each element of its lists (with each kind's flows) and its
 * setup row.
 */
function rowsOf(answer: unknown): unknown[] {
  if (!isRecord(answer)) {
    return [];
  }
  const rows: unknown[] = answer.setup === undefined || answer.setup === null ? [] : [answer.setup];
  for (const value of Object.values(answer)) {
    if (Array.isArray(value)) {
      for (const row of value as unknown[]) {
        rows.push(row);
        if (isRecord(row) && Array.isArray(row.flows)) {
          rows.push(...(row.flows as unknown[]));
        }
      }
    }
  }
  return rows;
}

/** The thrown error of a read that must throw; a read that answers is a failed test. */
async function thrownBy(read: Promise<unknown>): Promise<Error> {
  const error = await read.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof Error)) {
    throw new Error("the read answered; it should have thrown");
  }
  return error;
}

describe("each v1.18 fixture, answered from its seeds as rosie_app (README items 72 to 76)", () => {
  it("the index lists accepted exchanges of each of the five calls, and no other call", () => {
    for (const call of CALLS) {
      expect(
        ACCEPTED.some((file) => exchangeOf(file).call === call),
        call,
      ).toBe(true);
    }
    for (const file of [...ACCEPTED, ...REFUSED_REQUESTS]) {
      expect(isCall(exchangeOf(file).call), file).toBe(true);
    }
    expect(REFUSED_REQUESTS.length).toBeGreaterThan(0);
  });

  for (const file of ACCEPTED) {
    it(
      `${file}: its outcome, in its own transaction and inside the call's, valid at v1.18`,
      SLOW,
      async () => {
        const exchange = await given(file);
        const call = callOf(exchange);
        const answer = await runRead(exchange);
        expect(answer).toEqual(exchange.outcome);
        expect(answerErrors(call, answer)).toEqual([]);
        expect(schemaErrors(`${call}.exchange`, { ...exchange, outcome: answer })).toEqual([]);
        const businessId = exchange.request.businessId;
        if (typeof businessId !== "string") {
          throw new Error(`${file} names no business`);
        }
        expect(await appIn(call, exchange.request, businessId, nowOf(exchange))).toEqual(exchange.outcome);
      },
    );
  }

  it(
    "read-price-rules-haircut-tie: its note lists the two rows written first, in order and value for value; without them no tie or evening price is answered",
    SLOW,
    async () => {
      const exchange = exchangeOf(TIE_FIXTURE);
      const note = exchange.given.note ?? "";
      const [rulePhrase = "", tiePhrase = ""] = TIE_NOTE_PHRASES;
      expect(note).toContain("writes these two rows itself before the read, in this order");
      expect(note).toContain(rulePhrase);
      expect(note).toContain(tiePhrase);
      expect(note.indexOf(rulePhrase)).toBeLessThan(note.indexOf(tiePhrase));
      await reset();
      await loadSeeds(seedsOf(exchange.given));
      const without = answerOf<ReadServicePriceRulesResponse>(await runRead(exchange), "servicePriceRules");
      expect(without.ties).toEqual([]);
      expect(without.rules.map((rule) => rule.id)).not.toContain(EVENING.id);
    },
  );
});

describe("refused requests: each refused before any statement reaches the database", () => {
  for (const file of REFUSED_REQUESTS) {
    it(`${file}: refused with a TypeError, in its own transaction and inside the call's`, SLOW, async () => {
      const exchange = exchangeOf(file);
      const call = callOf(exchange);
      sent.length = 0;
      await expect(
        OWN[call](app, structuredClone(exchange.request) as never, nowOf(exchange)),
      ).rejects.toThrow(TypeError);
      await expect(IN[call](app, structuredClone(exchange.request) as never)).rejects.toThrow(TypeError);
      expect(sent).toEqual([]);
    });
  }

  it(
    "a request of any other wrong shape is refused the same way, and its error names a field, never a value",
    SLOW,
    async () => {
      const words = "Haircut at Lee's Barbershop this Saturday?";
      const refused: [Call, unknown, string][] = [
        ["readBusinessKinds", {}, "readBusinessKinds: the request needs businessId"],
        ["readBusinessKinds", { businessId: "" }, "businessId is a non-empty id"],
        ["readBusinessServices", { businessId: BARBERSHOP, words }, "the request takes only businessId"],
        [
          "readBusinessServices",
          { businessId: words.repeat(5) },
          "a business scope needs a non-empty business id",
        ],
        ["readServiceWays", { businessId: BARBERSHOP, serviceId: 7 }, "serviceId is a non-empty id"],
        [
          "readServicePriceRules",
          { businessId: BARBERSHOP, serviceId: HAIRCUT },
          "readServicePriceRules: the request needs at",
        ],
        [
          "readServicePriceRules",
          { businessId: BARBERSHOP, serviceId: HAIRCUT, at: "2026-02-30T14:00:00Z" },
          "readServicePriceRules: at is not a date that exists",
        ],
        [
          "readTermsSources",
          { businessId: BARBERSHOP, at: "Tue Oct 27 2026 10:00" },
          "readTermsSources: at is not an instant in UTC ending in Z",
        ],
        ["readTermsSources", null, "readTermsSources: the request is an object"],
      ];
      sent.length = 0;
      for (const [call, request, message] of refused) {
        const error = await thrownBy(OWN[call](app, request as never));
        expect(error, message).toBeInstanceOf(TypeError);
        expect(error.message).toContain(message);
        for (const value of [words, "Tue Oct 27", "2026-02-30", "7"]) {
          expect(error.message.includes(value), value).toBe(false);
        }
      }
      expect(sent).toEqual([]);
    },
  );
});

describe("under another business's scope each read answers nothing of the first business's (row-level security)", () => {
  /** The business-scoped tables the five reads read, each holding rows of the barbershop in the world. */
  const SCOPED_TABLES = [
    "business_setup",
    "company_kinds",
    "flow_defaults",
    "price_ok_limits",
    "price_rule_ties",
    "price_rules",
    "rules",
    "service_money",
    "services",
  ];

  beforeAll(async () => {
    await world();
  }, 120_000);

  it(
    "row-level security alone: as rosie_app under another business's scope, no row of the barbershop is seen in any table the reads read, while the tables' owner sees them",
    SLOW,
    async () => {
      for (const table of SCOPED_TABLES) {
        const [owned] = await db.sql<{ rows: number }[]>`
        select count(*)::int as rows from ${db.sql(table)} where business_id = ${BARBERSHOP}
      `;
        expect(owned?.rows, table).toBeGreaterThan(0);
        for (const scope of [YOGA, HOME_SERVICES, MOVERS]) {
          const seen = await withBusiness(app, scope, async (tx) => {
            const [row] = await tx<{ rows: number }[]>`
            select count(*)::int as rows from ${tx(table)} where business_id = ${BARBERSHOP}
          `;
            return row?.rows;
          });
          expect(seen, `${table} under ${scope}`).toBe(0);
        }
      }
      const business = await withBusiness(app, YOGA, async (tx) => {
        const [row] = await tx<
          { rows: number }[]
        >`select count(*)::int as rows from businesses where id = ${BARBERSHOP}`;
        return row?.rows;
      });
      expect(business).toBe(0);
    },
  );

  it(
    "each read for another business, naming the barbershop's own haircut, answers none of the barbershop's rows: as rosie_app, and as the tables' owner, whom only the read's own business filter holds",
    SLOW,
    async () => {
      for (const scope of [YOGA, HOME_SERVICES, MOVERS]) {
        for (const [call, request] of requestsFor(scope)) {
          const answer = await OWN[call](app, request as never, { now: new Date(OCT_29) });
          expect(answerErrors(call, answer), `${call} under ${scope}`).toEqual([]);
          expect(isRecord(answer) ? answer.businessId : null, `${call} under ${scope}`).toBe(scope);
          const rows = rowsOf(answer);
          for (const row of rows) {
            expect(
              isRecord(row) && "businessId" in row ? row.businessId : scope,
              `${call} under ${scope}`,
            ).toBe(scope);
          }
          const text = JSON.stringify(rows);
          for (const theirs of [
            "lees-barbershop",
            "svc-lees-",
            "way-lees-",
            "price-lees-",
            "tie-lees-",
            "barber/",
          ]) {
            expect(text.includes(theirs), `${call} under ${scope}: ${theirs}`).toBe(false);
          }
          const owners = await ownerIn(call, request, scope, { now: new Date(OCT_29) });
          expect(owners, `${call} under ${scope}, as the tables' owner`).toEqual(answer);
        }
      }
    },
  );

  it(
    "the yoga studio, which holds none of these rows, is answered empty lists and no setup, never notFound",
    SLOW,
    async () => {
      const options = { now: new Date(OCT_29) };
      const kinds = answerOf<ReadBusinessKindsResponse>(
        await readBusinessKinds(app, { businessId: YOGA }, options),
        "businessKinds",
      );
      expect([kinds.setup, kinds.kinds]).toEqual([null, []]);
      const services = answerOf<ReadBusinessServicesResponse>(
        await readBusinessServices(app, { businessId: YOGA }, options),
        "businessServices",
      );
      expect(services.services).toEqual([]);
      const ways = answerOf<ReadServiceWaysResponse>(
        await readServiceWays(app, { businessId: YOGA, serviceId: HAIRCUT }, options),
        "serviceWays",
      );
      expect(ways.ways).toEqual([]);
      const prices = answerOf<ReadServicePriceRulesResponse>(
        await readServicePriceRules(app, { businessId: YOGA, serviceId: HAIRCUT, at: NOV_4 }, options),
        "servicePriceRules",
      );
      expect([prices.rules, prices.ties]).toEqual([[], []]);
      const sources = answerOf<ReadTermsSourcesResponse>(
        await readTermsSources(app, { businessId: YOGA, at: OCT_29 }, options),
        "termsSources",
      );
      expect([sources.flowDefaults, sources.rules, sources.priceOkLimits]).toEqual([[], [], []]);
    },
  );

  it(
    "Lee Home Services is answered its own rows alone: every row's businessId is its own",
    SLOW,
    async () => {
      const options = { now: new Date(OCT_29) };
      const kinds = answerOf<ReadBusinessKindsResponse>(
        await readBusinessKinds(app, { businessId: HOME_SERVICES }, options),
        "businessKinds",
      );
      expect(kinds.kinds.map((kind) => kind.rowId)).toEqual([
        "company-lee-home-services/electrician",
        "company-lee-home-services/plumber",
      ]);
      const services = answerOf<ReadBusinessServicesResponse>(
        await readBusinessServices(app, { businessId: HOME_SERVICES }, options),
        "businessServices",
      );
      expect(services.services.map((service) => service.id)).toEqual([
        "svc-lee-electric-wiring-repair",
        FAUCET_REBUILD,
      ]);
      const sources = answerOf<ReadTermsSourcesResponse>(
        await readTermsSources(app, { businessId: HOME_SERVICES, at: OCT_29 }, options),
        "termsSources",
      );
      expect(sources.flowDefaults.map((row) => row.rowId)).toEqual([
        `${HOME_SERVICES}/A`,
        `${HOME_SERVICES}/B`,
      ]);
      expect(sources.priceOkLimits.map((row) => row.id)).toEqual(["pok-lee-home-services"]);
      const rows = [
        ...kinds.kinds,
        ...services.services,
        ...sources.flowDefaults,
        ...sources.rules,
        ...sources.priceOkLimits,
      ];
      for (const row of rows) {
        expect(row.businessId).toBe(HOME_SERVICES);
      }
    },
  );

  it(
    "the scope must be the request's own: an In read under another business's scope, or with none, is refused before any table is read (requireBusinessScope)",
    SLOW,
    async () => {
      for (const [call, request] of requestsFor(BARBERSHOP)) {
        for (const scope of [YOGA, null]) {
          sent.length = 0;
          const error = await thrownBy(appIn(call, request, scope));
          expect(error, `${call} under ${scope ?? "no scope"}`).toBeInstanceOf(BusinessScopeError);
          expect(sent.some((statement) => tablesOf(statement).length > 0)).toBe(false);
        }
      }
    },
  );
});

describe("one moment: each read's own transaction begins at repeatable read, read only, and confirms its scope first (T-1427's review N2)", () => {
  beforeAll(async () => {
    await world();
  }, 120_000);

  /** A statement as one line, its spaces folded. */
  const lineOf = (statement: string): string => statement.replace(/\s+/g, " ").trim();

  it(
    "each read sends one begin of a repeatable read, read-only transaction and one commit; its scope is set, then confirmed by requireBusinessScope, before the business is found first and before any other table is read",
    SLOW,
    async () => {
      for (const [call, request] of requestsFor(BARBERSHOP)) {
        sent.length = 0;
        expect(answerErrors(call, await OWN[call](app, request as never))).toEqual([]);
        const lines = sent.map(lineOf);
        expect(
          lines.filter((line) => line === `begin ${ONE_MOMENT}`),
          call,
        ).toHaveLength(1);
        expect(
          lines.filter((line) => line === "commit"),
          call,
        ).toHaveLength(1);
        const begin = lines.indexOf(`begin ${ONE_MOMENT}`);
        const setScope = lines.indexOf("select set_config($1, $2, true)");
        const confirmed = lines.indexOf("select current_setting($1, true) as scope");
        const firstRead = lines.findIndex((line) => tablesOf(line).length > 0);
        expect(begin, call).toBeGreaterThanOrEqual(0);
        expect([begin < setScope, setScope < confirmed, confirmed < firstRead], call).toEqual([
          true,
          true,
          true,
        ]);
        expect(lines[firstRead], call).toBe("select id from businesses where id = $1");
        const lastRead = lines.reduce((last, line, index) => (tablesOf(line).length > 0 ? index : last), -1);
        expect(lines.indexOf("commit"), call).toBeGreaterThan(lastRead);
      }
    },
  );

  it(
    "an In read refuses a transaction that is not one moment's (read committed, as withBusiness begins one, or one that may write), before any table is read",
    SLOW,
    async () => {
      for (const [call, request] of requestsFor(BARBERSHOP)) {
        sent.length = 0;
        const readCommitted = await thrownBy(
          withBusiness(app, BARBERSHOP, (tx) => IN[call](tx, request as never), { readOnly: true }),
        );
        expect(readCommitted.message, call).toContain("one read-only transaction at repeatable read");
        const mayWrite = await thrownBy(
          appIn(call, request, BARBERSHOP, {}, "isolation level repeatable read"),
        );
        expect(mayWrite.message, call).toContain("one read-only transaction at repeatable read");
        expect(
          sent.some((statement) => tablesOf(statement).length > 0),
          call,
        ).toBe(false);
        const serializable = await appIn(
          call,
          request,
          BARBERSHOP,
          {},
          "isolation level serializable read only",
        );
        expect(answerErrors(call, serializable), call).toEqual([]);
      }
    },
  );

  it("with no clock given, readAt is the database's now, in UTC", SLOW, async () => {
    const before = Date.now();
    const kinds = answerOf<ReadBusinessKindsResponse>(
      await readBusinessKinds(app, { businessId: BARBERSHOP }),
      "businessKinds",
    );
    expect(Math.abs(Date.parse(kinds.readAt) - before)).toBeLessThan(60_000);
    expect(kinds.readAt.endsWith("Z")).toBe(true);
  });

  it(
    "a client that cannot reach the database is answered transient, never thrown (K-05: every call can answer transient)",
    SLOW,
    async () => {
      const closed = createServer();
      closed.listen(0, "127.0.0.1");
      await once(closed, "listening");
      const { port } = closed.address() as AddressInfo;
      closed.close();
      await once(closed, "close");
      const url = new URL(resolvePrimaryUrl());
      url.hostname = "127.0.0.1";
      url.port = String(port);
      const unreachable = postgres(url.href, { max: 1, connect_timeout: 2, onnotice: () => undefined });
      try {
        for (const [call, request] of requestsFor(BARBERSHOP)) {
          expect(await OWN[call](unreachable, request as never), call).toEqual({
            error: "transient",
            sqlstate: "08001",
          });
        }
      } finally {
        await unreachable.end({ timeout: 1 });
      }
    },
  );
});

// ---- the statements' column lists (T-1428's card: "no column outside the list") ----------------------------------------

/** Each read's tables, and no others: the business found first, then the item's own (README items 72 to 76). */
const TABLES_OF: Readonly<Record<Call, readonly string[]>> = {
  readBusinessKinds: ["businesses", "business_setup", "company_kinds", "kind_flows"],
  readBusinessServices: ["businesses", "services"],
  readServiceWays: ["businesses", "service_money"],
  readServicePriceRules: ["businesses", "price_rule_ties", "price_rules"],
  readTermsSources: ["businesses", "flow_defaults", "price_ok_limits", "rules"],
};

/** Each table's column list, as items 72 to 76 name them, and no other column of the table. */
const COLUMNS_OF: Readonly<Record<string, readonly string[]>> = {
  businesses: ["id"],
  business_setup: ["business_id", "no_money", "version"],
  company_kinds: [
    "business_id",
    "company_id",
    "kind_id",
    "pf_facts",
    "pf_switches_a",
    "pf_switches_b",
    "trade_name",
    "version",
  ],
  kind_flows: ["combos", "flow", "kind_id", "version"],
  services: [
    "active",
    "business_id",
    "id",
    "kind_id",
    "length",
    "name",
    "position",
    "price_kind",
    "unit",
    "version",
  ],
  service_money: [
    "active",
    "business_id",
    "currency",
    "cutoff_before",
    "cutoff_day_before_at",
    "deposit_cents",
    "deposit_percent",
    "fee_cents",
    "flow",
    "id",
    "location_id",
    "path",
    "place",
    "service_id",
    "tip_line",
    "version",
  ],
  price_rules: [
    "business_id",
    "currency",
    "effective_from",
    "effective_to",
    "from_cents",
    "from_time",
    "id",
    "price_cents",
    "service_id",
    "service_money_id",
    "set_by_person_id",
    "until_time",
    "version",
    "weekdays",
    "worker_resource_id",
  ],
  price_rule_ties: [
    "answered_at",
    "answered_by_person_id",
    "asked_at",
    "business_id",
    "first_rule_id",
    "id",
    "second_rule_id",
    "service_id",
    "version",
    "winner_rule_id",
  ],
  flow_defaults: ["business_id", "cutoff_before", "cutoff_day_before_at", "flow", "version"],
  rules: [
    "business_id",
    "effective_from",
    "effective_to",
    "flow",
    "id",
    "kind_id",
    "rule_kind",
    "value_cents",
    "value_count",
    "value_currency",
    "value_dates",
    "value_on",
    "value_span",
    "value_type",
    "version",
  ],
  price_ok_limits: ["business_id", "effective_from", "effective_to", "flow", "id", "kind_id", "version"],
};

/** The business-scoped tables the reads read: each statement that reads one names the business beside it. */
const BUSINESS_SCOPED = new Set([
  "business_setup",
  "company_kinds",
  "flow_defaults",
  "price_ok_limits",
  "price_rule_ties",
  "price_rules",
  "rules",
  "service_money",
  "services",
]);

/** Never named by any statement of the five (README "What the new tasks must hold to", T-1428). */
const NEVER_NAMED = new Set(["extras", "words", "listing_phone", "listing_email"]);
/** Never named by readTermsSources, which reads rules and price_ok_limits (default 160). */
const NEVER_NAMED_BY_SOURCES = new Set(["set_by_person_id"]);

/** Words that may follow a table in FROM or JOIN without being its alias. */
const NOT_AN_ALIAS = new Set([
  "where",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "natural",
  "on",
  "using",
  "order",
  "group",
  "having",
  "limit",
  "offset",
  "fetch",
  "for",
  "union",
  "except",
  "intersect",
  "window",
  "returning",
  "tablesample",
]);

/** A statement's tokens: comments, string literals and collations dropped, quoted names unquoted, lower case. */
function tokensOf(statement: string): string[] {
  return (
    statement
      .replace(/--[^\n]*/g, " ")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/'(?:[^']|'')*'/g, " ")
      .replace(/collate\s+"[^"]*"/gi, " ")
      .replaceAll('"', "")
      .toLowerCase()
      .match(/[a-z_][a-z0-9_$]*|\$\d+|\d+|[^\s\w]/g) ?? []
  );
}

const isName = (token: string | undefined): token is string =>
  token !== undefined && /^[a-z_][a-z0-9_$]*$/.test(token);

/** The tables and aliases a statement declares after FROM and JOIN, and the places it declares them. */
function declarationsOf(tokens: readonly string[]): { names: Set<string>; places: Set<number> } {
  const names = new Set<string>();
  const places = new Set<number>();
  tokens.forEach((token, index) => {
    // `is [not] distinct from x` compares; a function after FROM is no table.
    if ((token !== "from" && token !== "join") || tokens[index - 1] === "distinct") {
      return;
    }
    const table = tokens[index + 1];
    if (!isName(table) || tokens[index + 2] === "(") {
      return;
    }
    names.add(table);
    places.add(index + 1);
    const aliasAt = tokens[index + 2] === "as" ? index + 3 : index + 2;
    const alias = tokens[aliasAt];
    if (isName(alias) && !NOT_AN_ALIAS.has(alias)) {
      names.add(alias);
      places.add(aliasAt);
    }
  });
  return { names, places };
}

/** Every table of this file's schema a statement names, wherever it names it. */
function tablesOf(statement: string): string[] {
  return [...new Set(tokensOf(statement).filter((token) => schemaTables.has(token)))];
}

/** Every column of the statement's own tables it names, wherever it names it. */
function columnsOf(statement: string): string[] {
  const tables = tablesOf(statement);
  return [
    ...new Set(
      tokensOf(statement).filter((token) =>
        tables.some((table) => schemaColumns.get(table)?.has(token) === true),
      ),
    ),
  ];
}

/**
 * What is wrong with one statement of `call`: `*`, a whole row (a table or alias named where a value goes), a table
 * beyond the read's own, a column of its tables beyond their lists, a column never named, and a business-scoped table
 * read without its business named beside it.
 */
function problemsOf(statement: string, call: Call): string[] {
  const tokens = tokensOf(statement);
  const { names, places } = declarationsOf(tokens);
  const tables = tablesOf(statement);
  const allowed = new Set(tables.flatMap((table) => COLUMNS_OF[table] ?? []));
  const problems: string[] = [];
  tokens.forEach((token, index) => {
    if (token === "*") {
      problems.push("*");
    }
    if ((names.has(token) || schemaTables.has(token)) && !places.has(index) && tokens[index + 1] !== ".") {
      problems.push(`a whole row: ${token}`);
    }
    if (NEVER_NAMED.has(token) || (call === "readTermsSources" && NEVER_NAMED_BY_SOURCES.has(token))) {
      problems.push(`a column never named: ${token}`);
    }
  });
  for (const table of tables) {
    if (!TABLES_OF[call].includes(table)) {
      problems.push(`a table beyond its own: ${table}`);
    }
  }
  for (const column of columnsOf(statement)) {
    if (!allowed.has(column)) {
      problems.push(`a column beyond its list: ${column}`);
    }
  }
  const line = statement.replace(/\s+/g, " ");
  if (tables.some((table) => BUSINESS_SCOPED.has(table)) && !/\bbusiness_id = \$\d+/.test(line)) {
    problems.push("a business-scoped table read without its business");
  }
  if (tables.includes("businesses") && !/\bwhere id = \$\d+/.test(line)) {
    problems.push("businesses read other than by the request's id");
  }
  return problems;
}

describe("every statement the five reads send names its item's columns and no other (README items 72 to 77; T-1428's card)", () => {
  it("the check finds each fault on statements made to fail, and passes statements shaped as the reads' own", () => {
    const caught: [string, Call, string][] = [
      ["select * from services where business_id = $1", "readBusinessServices", "*"],
      ["select s.* from services s where s.business_id = $1", "readBusinessServices", "*"],
      [
        "select to_json(s) from services s where s.business_id = $1",
        "readBusinessServices",
        "a whole row: s",
      ],
      [
        "select services from services where business_id = $1",
        "readBusinessServices",
        "a whole row: services",
      ],
      [
        "select id, extras from services where business_id = $1",
        "readBusinessServices",
        "a column never named: extras",
      ],
      [
        "select id, extras from services where business_id = $1",
        "readBusinessServices",
        "a column beyond its list: extras",
      ],
      [
        "select id, words from rules where business_id = $1",
        "readTermsSources",
        "a column never named: words",
      ],
      [
        "select id, set_by_person_id from rules where business_id = $1",
        "readTermsSources",
        "a column never named: set_by_person_id",
      ],
      [
        "select business_id, no_money, listing_phone, version from business_setup where business_id = $1",
        "readBusinessKinds",
        "a column never named: listing_phone",
      ],
      [
        "select business_id, website from business_setup where business_id = $1",
        "readBusinessKinds",
        "a column beyond its list: website",
      ],
      [
        "select kind_id, flow, main_combo, combos, version from kind_flows where kind_id = $1",
        "readBusinessKinds",
        "a column beyond its list: main_combo",
      ],
      [
        "select business_id, flow, arrive, version from flow_defaults where business_id = $1",
        "readTermsSources",
        "a column beyond its list: arrive",
      ],
      [
        "select id, over_cents, currency from price_ok_limits where business_id = $1",
        "readTermsSources",
        "a column beyond its list: over_cents",
      ],
      [
        "select id, worker_resource_kind from price_rules where business_id = $1",
        "readServicePriceRules",
        "a column beyond its list: worker_resource_kind",
      ],
      [
        "select id, name, time_zone from businesses where id = $1",
        "readBusinessKinds",
        "a column beyond its list: name",
      ],
      [
        "select id from services where id = $1",
        "readBusinessServices",
        "a business-scoped table read without its business",
      ],
      [
        "select id from service_money where business_id = $1 and exists (select 1 from locations where locations.id = location_id)",
        "readServiceWays",
        "a table beyond its own: locations",
      ],
      ["select id from businesses", "readBusinessKinds", "businesses read other than by the request's id"],
    ];
    for (const [statement, call, problem] of caught) {
      expect(problemsOf(statement, call), statement).toContain(problem);
    }
    const clean: [string, Call][] = [
      ["select id from businesses where id = $1", "readBusinessKinds"],
      [
        "select business_id, no_money, version from business_setup where business_id = $1",
        "readBusinessKinds",
      ],
      [
        'select kind_id || \'/\' || flow as row_id, kind_id, flow, to_json(combos) as combos, version from kind_flows where kind_id in (select kind_id from company_kinds where business_id = $1) order by kind_id collate "C", flow collate "C"',
        "readBusinessKinds",
      ],
      [
        "select id, business_id, rule_kind, value_type, flow, kind_id, extract(epoch from value_span)::text as value_span_seconds, effective_from from rules where business_id = $1 and tstzrange(effective_from, effective_to, '[)') @> $2::timestamptz order by id collate \"C\"",
        "readTermsSources",
      ],
    ];
    for (const [statement, call] of clean) {
      expect(problemsOf(statement, call), statement).toEqual([]);
    }
  });

  it(
    "over every fixture, each other business and the values' own cases, each read names exactly its tables and its columns, never *, a whole row or a column beyond its list, names the business beside every business-scoped table, and builds item 77's names in SQL",
    SLOW,
    async () => {
      const runs: { call: Call; statements: string[] }[] = [];
      const watch = async (call: Call, read: () => Promise<unknown>): Promise<void> => {
        sent.length = 0;
        await read();
        runs.push({ call, statements: sent.filter((statement) => tablesOf(statement).length > 0) });
      };
      for (const file of ACCEPTED) {
        const exchange = await given(file);
        await watch(callOf(exchange), () => runRead(exchange));
      }
      await world();
      for (const scope of [BARBERSHOP, HOME_SERVICES, YOGA, MOVERS]) {
        for (const [call, request] of requestsFor(scope)) {
          await watch(call, () => OWN[call](app, request as never));
        }
      }
      for (const call of CALLS) {
        const statements = runs.filter((run) => run.call === call).flatMap((run) => run.statements);
        expect(statements.length, call).toBeGreaterThan(0);
        const tables = new Set(statements.flatMap(tablesOf));
        expect([...tables].sort(), call).toEqual([...TABLES_OF[call]].sort());
        const columns = new Set(statements.flatMap(columnsOf));
        const listed = new Set(TABLES_OF[call].flatMap((table) => COLUMNS_OF[table] ?? []));
        expect([...columns].sort(), call).toEqual([...listed].sort());
        for (const statement of statements) {
          expect(problemsOf(statement, call), `${call}: ${statement}`).toEqual([]);
        }
      }
      const lines = runs.flatMap((run) => run.statements).map((statement) => statement.replace(/\s+/g, " "));
      for (const name of [
        "company_id || '/' || kind_id as row_id",
        "kind_id || '/' || flow as row_id",
        "business_id || '/' || flow as row_id",
      ]) {
        expect(
          lines.some((line) => line.includes(name)),
          name,
        ).toBe(true);
      }
    },
  );
});

describe("item 77's names and the price withdrawn before it started (README 'What the new tasks must hold to')", () => {
  beforeAll(async () => {
    await world();
  }, 120_000);

  it(
    "each two-column name a read answers, compared whole by the database beside the business filter (T-1427's review N3), names exactly the row it was read from, at its version; a kind's id alone names none",
    SLOW,
    async () => {
      for (const businessId of [BARBERSHOP, HOME_SERVICES]) {
        const kinds = answerOf<ReadBusinessKindsResponse>(
          await readBusinessKinds(app, { businessId }),
          "businessKinds",
        );
        expect(kinds.kinds.length, businessId).toBeGreaterThan(0);
        for (const kind of kinds.kinds) {
          const named = await db.sql<{ version: number }[]>`
          select version from company_kinds
          where company_id || '/' || kind_id = ${kind.rowId} and business_id = ${businessId}
        `;
          expect(named, kind.rowId).toEqual([{ version: kind.version }]);
          const alone = await db.sql<{ version: number }[]>`
          select version from company_kinds
          where company_id || '/' || kind_id = ${kind.kindId} and business_id = ${businessId}
        `;
          expect(alone, kind.kindId).toEqual([]);
          expect(kind.flows.map((flow) => flow.rowId)).toEqual([`${kind.kindId}/A`, `${kind.kindId}/B`]);
          for (const flow of kind.flows) {
            const flowNamed = await db.sql<{ version: number }[]>`
            select version from kind_flows
            where kind_id || '/' || flow = ${flow.rowId}
              and kind_id in (select kind_id from company_kinds where business_id = ${businessId})
          `;
            expect(flowNamed, flow.rowId).toEqual([{ version: flow.version }]);
          }
        }
        const sources = answerOf<ReadTermsSourcesResponse>(
          await readTermsSources(app, { businessId, at: OCT_29 }),
          "termsSources",
        );
        expect(sources.flowDefaults.map((row) => row.rowId)).toEqual([`${businessId}/A`, `${businessId}/B`]);
        for (const row of sources.flowDefaults) {
          const named = await db.sql<{ version: number }[]>`
          select version from flow_defaults
          where business_id || '/' || flow = ${row.rowId} and business_id = ${businessId}
        `;
          expect(named, row.rowId).toEqual([{ version: row.version }]);
        }
      }
    },
  );

  it(
    "a price withdrawn before it started (K-25's seed-price-withdrawn-before-start) is answered while its empty range closes after at, and from that instant on is not (default 157)",
    SLOW,
    async () => {
      /** K-25's seed-price-withdrawn-before-start's rule ids: the faucet rebuild's $35, its $40 and its $35 again. */
      const price = (suffix: string): string => `${FAUCET_REBUILD.replace("svc-", "price-")}-${suffix}`;
      const idsAt = async (at: string): Promise<string[]> => {
        const answer = answerOf<ReadServicePriceRulesResponse>(
          await readServicePriceRules(app, { businessId: HOME_SERVICES, serviceId: FAUCET_REBUILD, at }),
          "servicePriceRules",
        );
        expect(answerErrors("readServicePriceRules", answer)).toEqual([]);
        const withdrawn = answer.rules.find((rule) => rule.id === price("40"));
        if (withdrawn !== undefined) {
          expect(withdrawn.effectiveTo).toBe(withdrawn.effectiveFrom);
        }
        return answer.rules.map((rule) => rule.id);
      };
      expect(await idsAt("2026-11-01T14:00:00Z")).toEqual([price("35"), price("35-again"), price("40")]);
      expect(await idsAt(NOV_2)).toEqual([price("35-again")]);
      expect(await idsAt(NOV_4)).toEqual([price("35-again")]);
    },
  );
});

// ---- values the contract cannot carry (defaults 156 and 166; T-1427's database review N1 and N2) ----------------------

describe("values: never rounded, never an answer the contract refuses; a value it cannot carry throws (defaults 156, 166; T-1427's review N1, N2)", () => {
  /** The haircut's own price under a new id on one weekday, with one fault: a fixture row as K-25's tests make one. */
  const haircutPrice = (id: string, weekdays: string, fault: Record<string, Json>): SeedRow => ({
    table: "price_rules",
    values: {
      ...EVENING_RULE.values,
      id,
      weekdays,
      from_time: null,
      ...fault,
    },
  });

  /** A barbershop rule from the tap list's same-day rule, under a new id with its own kind and value. */
  const barbershopRule = (id: string, kind: string, type: string, value: Record<string, Json>): SeedRow => ({
    table: "rules",
    values: {
      id,
      business_id: BARBERSHOP,
      rule_kind: kind,
      value_type: type,
      flow: null,
      kind_id: null,
      words: null,
      set_by_person_id: "person-sam",
      effective_from: "2026-10-19T18:12:00Z",
      effective_to: null,
      version: 1,
      ...value,
    },
  });

  /** The thrown error names the call, the table and the column and holds none of `values`. */
  async function expectCannotCarry(
    read: Promise<unknown>,
    call: Call,
    column: string,
    values: readonly string[],
  ): Promise<void> {
    const error = await thrownBy(read);
    expect(error.message).toContain(`${call}: ${column} holds`);
    expect(error.message).toContain("which the answer cannot carry");
    for (const value of [...values, BARBERSHOP, "person-sam"]) {
      expect(error.message.includes(value), value).toBe(false);
    }
  }

  it(
    "a price rule's clock time: 24:00 or a fraction of a second throws; whole minutes read HH:MM and other seconds HH:MM:SS",
    SLOW,
    async () => {
      const read = (): Promise<unknown> =>
        readServicePriceRules(app, { businessId: BARBERSHOP, serviceId: HAIRCUT, at: NOV_4 });
      const faults: [SeedRow, string, string][] = [
        [
          haircutPrice("price-lees-haircut-sunday-late", "7", { from_time: "24:00" }),
          "price_rules.from_time",
          "24:00",
        ],
        [
          haircutPrice("price-lees-haircut-saturday-late", "6", { from_time: "17:00:00.5" }),
          "price_rules.from_time",
          "17:00:00.5",
        ],
        [
          haircutPrice("price-lees-haircut-friday-early", "5", { until_time: "23:59:59.5" }),
          "price_rules.until_time",
          "23:59:59.5",
        ],
      ];
      for (const [row, column, value] of faults) {
        await world();
        await loadSeeds([], [row]);
        await expectCannotCarry(read(), "readServicePriceRules", column, [value, String(row.values.id)]);
      }
      await world();
      await loadSeeds(
        [],
        [
          haircutPrice("price-lees-haircut-thursday-late", "4", {
            from_time: "17:30:15",
            until_time: "20:00",
          }),
        ],
      );
      const answer = answerOf<ReadServicePriceRulesResponse>(await read(), "servicePriceRules");
      expect(answerErrors("readServicePriceRules", answer)).toEqual([]);
      const thursday = answer.rules.find((rule) => rule.id === "price-lees-haircut-thursday-late");
      expect(thursday?.conditions).toEqual({
        serviceMoneyId: null,
        workerResourceId: null,
        weekdays: "4",
        fromTime: "17:30:15",
        untilTime: "20:00",
      });
    },
  );

  it(
    "a free-cancel clock time the day before, of a way or of a flow default: 24:00 throws; 20:00 reads 20:00",
    SLOW,
    async () => {
      await world();
      await db.sql`
      update service_money set cutoff_before = null, cutoff_day_before_at = '24:00', version = version + 1
      where id = ${SKIN_FADE_WAY}
    `;
      await expectCannotCarry(
        readServiceWays(app, { businessId: BARBERSHOP, serviceId: "svc-lees-skin-fade" }),
        "readServiceWays",
        "service_money.cutoff_day_before_at",
        ["24:00", SKIN_FADE_WAY],
      );
      await db.sql`
      update service_money set cutoff_day_before_at = '20:00', version = version + 1 where id = ${SKIN_FADE_WAY}
    `;
      const ways = answerOf<ReadServiceWaysResponse>(
        await readServiceWays(app, { businessId: BARBERSHOP, serviceId: "svc-lees-skin-fade" }),
        "serviceWays",
      );
      expect(ways.ways.map((way) => [way.cutoffBeforeMinutes, way.cutoffDayBeforeAt, way.version])).toEqual([
        [null, "20:00", 3],
      ]);
      await db.sql`
      update flow_defaults set cutoff_before = null, cutoff_day_before_at = '24:00', version = version + 1
      where business_id = ${BARBERSHOP} and flow = 'A'
    `;
      await expectCannotCarry(
        readTermsSources(app, { businessId: BARBERSHOP, at: OCT_29 }),
        "readTermsSources",
        "flow_defaults.cutoff_day_before_at",
        ["24:00"],
      );
      await db.sql`
      update flow_defaults set cutoff_day_before_at = '20:00', version = version + 1
      where business_id = ${BARBERSHOP} and flow = 'A'
    `;
      const sources = answerOf<ReadTermsSourcesResponse>(
        await readTermsSources(app, { businessId: BARBERSHOP, at: OCT_29 }),
        "termsSources",
      );
      expect(sources.flowDefaults[0]).toEqual({
        rowId: `${BARBERSHOP}/A`,
        businessId: BARBERSHOP,
        flow: "A",
        cutoffBeforeMinutes: null,
        cutoffDayBeforeAt: "20:00",
        version: 3,
      });
    },
  );

  it(
    "a span: one that counts months, is no whole number of minutes, or is under a minute throws; a night written 1 day is 1440",
    SLOW,
    async () => {
      const services = (): Promise<unknown> => readBusinessServices(app, { businessId: BARBERSHOP });
      for (const length of ["1 mon", "1 year", "1 minute 30 seconds", "45 seconds"]) {
        await world();
        await db.sql`update services set length = ${length}::interval, version = version + 1 where id = ${HAIRCUT}`;
        await expectCannotCarry(services(), "readBusinessServices", "services.length", [length, HAIRCUT]);
      }
      await world();
      await db.sql`update services set length = '1 day', version = version + 1 where id = ${HAIRCUT}`;
      const answer = answerOf<ReadBusinessServicesResponse>(await services(), "businessServices");
      expect(answer.services.find((service) => service.id === HAIRCUT)?.lengthMinutes).toBe(1440);

      for (const cutoff of ["1 mon", "90 seconds"]) {
        await world();
        await db.sql`
        update service_money set cutoff_before = ${cutoff}::interval, version = version + 1 where id = ${SKIN_FADE_WAY}
      `;
        await expectCannotCarry(
          readServiceWays(app, { businessId: BARBERSHOP, serviceId: "svc-lees-skin-fade" }),
          "readServiceWays",
          "service_money.cutoff_before",
          [cutoff, SKIN_FADE_WAY],
        );
        await world();
        await db.sql`
        update flow_defaults set cutoff_before = ${cutoff}::interval, version = version + 1
        where business_id = ${BARBERSHOP} and flow = 'B'
      `;
        await expectCannotCarry(
          readTermsSources(app, { businessId: BARBERSHOP, at: OCT_29 }),
          "readTermsSources",
          "flow_defaults.cutoff_before",
          [cutoff],
        );
      }

      await world();
      await loadSeeds(
        [],
        [barbershopRule("rule-lees-barbershop-notice", "notice", "span", { value_span: "45 seconds" })],
      );
      await expectCannotCarry(
        readTermsSources(app, { businessId: BARBERSHOP, at: OCT_29 }),
        "readTermsSources",
        "rules.value_span",
        ["45 seconds", "rule-lees-barbershop-notice"],
      );
      await world();
      await loadSeeds(
        [],
        [barbershopRule("rule-lees-barbershop-notice", "notice", "span", { value_span: "2 hours" })],
      );
      const sources = answerOf<ReadTermsSourcesResponse>(
        await readTermsSources(app, { businessId: BARBERSHOP, at: OCT_29 }),
        "termsSources",
      );
      expect(answerErrors("readTermsSources", sources)).toEqual([]);
      const notice: OwnerRuleRead | undefined = sources.rules.find(
        (rule) => rule.id === "rule-lees-barbershop-notice",
      );
      expect([notice?.valueType, notice?.valueSpanMinutes]).toEqual(["span", 120]);
    },
  );

  it(
    "a kind's names: an empty trade name, a NULL fact, a lone empty switch name and a NULL combo each throw, never an invalid answer",
    SLOW,
    async () => {
      const kinds = (): Promise<unknown> => readBusinessKinds(app, { businessId: BARBERSHOP });
      const faults: [() => Promise<unknown>, string][] = [
        [
          () =>
            db.sql`
            update company_kinds set trade_name = '', version = version + 1
            where company_id = 'company-lees-barbershop' and kind_id = 'barber'
          `,
          "company_kinds.trade_name",
        ],
        [
          () =>
            db.sql`
            update company_kinds set pf_facts = array['children', null, 'photos']::text[], version = version + 1
            where company_id = 'company-lees-barbershop' and kind_id = 'barber'
          `,
          "company_kinds.pf_facts",
        ],
        [
          () =>
            db.sql`
            update company_kinds set pf_facts = '{}', pf_switches_a = '{}', pf_switches_b = array['']::text[],
              version = version + 1
            where company_id = 'company-lees-barbershop' and kind_id = 'barber'
          `,
          "company_kinds.pf_switches_b",
        ],
        [
          () =>
            db.sql`
            update kind_flows
            set combos = array[null, 'list|card|counter', 'list|none|counter', 'list|deposit|counter']::text[],
              version = version + 1
            where kind_id = 'barber' and flow = 'A'
          `,
          "kind_flows.combos",
        ],
      ];
      for (const [fault, column] of faults) {
        await world();
        await fault();
        await expectCannotCarry(kinds(), "readBusinessKinds", column, [
          "company-lees-barbershop",
          "barber/A",
        ]);
      }
    },
  );

  it(
    "money: K-25's bigint cents are JSON integers; one past the largest safe integer throws",
    SLOW,
    async () => {
      await world();
      const before = answerOf<ReadServiceWaysResponse>(
        await readServiceWays(app, { businessId: BARBERSHOP, serviceId: "svc-lees-grooms-package" }),
        "serviceWays",
      );
      expect(before.ways.map((way) => [way.depositCents, way.feeCents])).toEqual([[4000, 4000]]);
      await loadSeeds(
        [],
        [haircutPrice("price-lees-haircut-wednesday", "3", { price_cents: "9007199254740993" })],
      );
      await expectCannotCarry(
        readServicePriceRules(app, { businessId: BARBERSHOP, serviceId: HAIRCUT, at: NOV_4 }),
        "readServicePriceRules",
        "price_rules.price_cents",
        ["9007199254740993", "price-lees-haircut-wednesday"],
      );
    },
  );

  it(
    "days: a dates rule's range is answered [from, until), each YYYY-MM-DD, an open end null",
    SLOW,
    async () => {
      await world();
      await loadSeeds(
        [],
        [
          barbershopRule("rule-lees-barbershop-ok-dates", "ok_dates", "dates", {
            value_dates: "[2026-11-26,2026-11-28)",
          }),
          barbershopRule("rule-lees-barbershop-ok-dates-after", "ok_dates", "dates", {
            value_dates: "[2026-12-24,)",
          }),
          barbershopRule("rule-lees-barbershop-ok-dates-before", "ok_dates", "dates", {
            value_dates: "(,2026-10-01)",
          }),
        ],
      );
      const sources = answerOf<ReadTermsSourcesResponse>(
        await readTermsSources(app, { businessId: BARBERSHOP, at: OCT_29 }),
        "termsSources",
      );
      expect(answerErrors("readTermsSources", sources)).toEqual([]);
      const datesOf = (id: string): unknown => sources.rules.find((rule) => rule.id === id)?.valueDates;
      expect(datesOf("rule-lees-barbershop-ok-dates")).toEqual({ from: "2026-11-26", until: "2026-11-28" });
      expect(datesOf("rule-lees-barbershop-ok-dates-after")).toEqual({ from: "2026-12-24", until: null });
      expect(datesOf("rule-lees-barbershop-ok-dates-before")).toEqual({ from: null, until: "2026-10-01" });
      expect(datesOf("rule-lees-barbershop-ok-same-day")).toBeNull();
    },
  );

  it(
    "a kind with no kind_flows rows (a drafted kind) is answered with none, and a kind's flows are A then B",
    SLOW,
    async () => {
      await world();
      await db.sql`delete from kind_flows where kind_id = 'electrician'`;
      const kinds = answerOf<ReadBusinessKindsResponse>(
        await readBusinessKinds(app, { businessId: HOME_SERVICES }),
        "businessKinds",
      );
      expect(answerErrors("readBusinessKinds", kinds)).toEqual([]);
      const byKind = (kind: BusinessKindRead): [string, string[]] => [
        kind.kindId,
        kind.flows.map((flow) => flow.flow),
      ];
      expect(kinds.kinds.map(byKind)).toEqual([
        ["electrician", []],
        ["plumber", ["A", "B"]],
      ]);
    },
  );
});
