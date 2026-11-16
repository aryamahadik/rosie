// T-667: K-05 v1.1's commitTurn with the setup tables as write targets (db/repo/commit-turn.ts), against local
// PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/setup`). The schema comes from migrating a fresh test
// schema, which test-db.ts drops when the file ends.
//
// Every commit runs as K-05 states it (README "Scope": per write): through a client whose connections run as rosie_job
// with no business scope at the start of each transaction, so the grants and row-level security are the ones the commit
// meets. The tables' owner (the migrations' role) loads the seeds and reads what a commit wrote. The rows come only from
// fixture set v1's demo shops (rule 9): K-23's, K-24's and K-25's seeds and the K-04 seeds their chains name (Lee's
// Barbershop, Lee Home Services and the master's sample cast). A row a commit writes here is a seed row under a new id.
//
// K-05 v1.18 item 77 (DL-911, DL-913): a two-column key's row is named by its key's values joined by "/" in key order,
// built by the SQL and compared whole; a state update names it by its key, column to value; a version read by its name,
// under the businesses the commit writes, so another business's name finds no row.
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { commitTurn, type CommitTurnOutcome, type CommitTurnRequest } from "../commit-turn";
import type { Sql } from "../scope";
import { createTestDatabase, type TestDatabase } from "../test-db";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Values = Record<string, Json>;
type StateWrite = CommitTurnRequest["writes"]["state"][number];
type RowRef = CommitTurnRequest["versionsRead"][number];

const CONTRACTS = new URL("../../../contracts/", import.meta.url);
const DB_SCHEMA_DIR = new URL("db-schema/", CONTRACTS);
const RUNTIME_ROLE = "rosie_job";
const SLOW = { timeout: 120_000 };
const NOW = new Date("2026-11-16T15:00:00Z");

const BARBERSHOP = "biz-lees-barbershop";
/** The movers (K-04's seed-business-head), which no seed gives a company: S1-09's business for a sign-up's company. */
const MOVERS = "biz-movers";
const BUNDLE = { hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037", build: 1 };

/** The seeds every test starts from, with their chains. */
const SEEDS: readonly [string, string][] = [
  ["core", "seed-bundle-registry.json"],
  ["business-setup", "seed-business-demo-shop.json"],
  ["business-setup", "seed-company-two-kinds.json"],
  ["kinds-of-work", "seed-kinds-sample.json"],
  ["services-prices", "seed-services-price-list.json"],
];

interface SeedRow {
  table: string;
  values: Values;
}

interface SeedFile {
  after: string[];
  rows: SeedRow[];
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
const seedUrl = (part: string, file: string): URL => new URL(`${part}/fixtures/${file}`, DB_SCHEMA_DIR);

/** The one own row of `table` in a seed whose values hold each of `match`'s. */
function seedRowWhere(part: string, file: string, table: string, match: Values): Values {
  const rows = (readJson(seedUrl(part, file)) as SeedFile).rows.filter(
    (row) =>
      row.table === table && Object.entries(match).every(([column, value]) => row.values[column] === value),
  );
  const [row, ...more] = rows;
  if (row === undefined || more.length > 0) {
    throw new Error(`${file} has no one ${table} row that matches`);
  }
  return row.values;
}

/** A seed's rows after those of every seed its `after` names (each path from the naming file's folder), each once. */
function chainRows(file: URL, seen: Set<string>): SeedRow[] {
  if (seen.has(file.href)) {
    return [];
  }
  seen.add(file.href);
  const seed = readJson(file) as SeedFile;
  return [...seed.after.flatMap((before) => chainRows(new URL(before, file), seen)), ...seed.rows];
}

// ---- the contract's own schema, for every answer (Ajv 2020-12, strict, as contracts:check runs it) -----------------

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
const V11_ID = (readJson(new URL("data-access/data-access.v1.1.schema.json", CONTRACTS)) as { $id: string })
  .$id;

/** The answer checked against data-access v1.1's commitTurn response or errors (none when it passes). */
function answerErrors(outcome: unknown): string[] {
  const isError = typeof outcome === "object" && outcome !== null && "error" in outcome;
  const validate = ajv.getSchema(`${V11_ID}#/$defs/${isError ? "commitTurn.errors" : "commitTurn.response"}`);
  if (validate === undefined) {
    throw new Error("data-access v1.1 has no commitTurn definitions");
  }
  return validate(outcome)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

// ---- databases, clients and seeds -------------------------------------------------------------------------------------

let db: TestDatabase;
/** Connections that run as rosie_job, with this file's schema first. */
let runtime: Sql;
/** jsonb and bytea columns of the schema, keyed table.column, for the seed loader. */
let typedColumns: Map<string, string>;

/** Empties every table the seeds and commits write (this file's schema only); the migration's registries stay. */
async function reset(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags, kinds cascade`;
}

/** Loads the seeds with their chains, each file once, as the tables' owner (not bound by row-level security). */
async function loadSeeds(): Promise<void> {
  const seen = new Set<string>();
  const rows = SEEDS.flatMap(([part, file]) => chainRows(seedUrl(part, file), seen));
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      const values: Record<string, never> = {};
      for (const [column, value] of Object.entries(row.values)) {
        const type = typedColumns.get(`${row.table}.${column}`);
        const out =
          type === "jsonb" && value !== null
            ? tx.json(value)
            : type === "bytea" && typeof value === "string"
              ? fromHex(value.replace(/^\\x/, ""))
              : value;
        values[column] = out as never;
      }
      await tx`insert into ${tx(row.table)} ${tx(values)}`;
    }
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "setup_commit" });
  runtime = db.connect({
    max: 4,
    onnotice: () => undefined,
    connection: {
      application_name: "rosie-t667-setup-commit",
      search_path: `${db.schema}, public`,
      role: RUNTIME_ROLE,
    },
  });
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typedColumns = new Map(typed.map((column) => [column.key, column.type]));
}, 180_000);

beforeEach(async () => {
  await reset();
  await loadSeeds();
}, 120_000);

afterAll(async () => {
  await runtime.end({ timeout: 5 });
  await db.drop();
});

/** A turn of Sam's (the owner) that commits `state` after reading `versionsRead`; no other write. */
function turnOf(id: string, state: StateWrite[], versionsRead: RowRef[] = []): CommitTurnRequest {
  return {
    turn: {
      id,
      handleId: "handle-sam",
      eventIds: [`evt-${id}`],
      bundleId: BUNDLE,
      traceId: `trace-${id}`,
      joinedTraceIds: [],
      tries: 1,
    },
    versionsRead,
    writes: {
      state,
      openQuestions: { open: [], close: [] },
      clockRows: { make: [], cancel: [] },
      outboxRows: [],
      reservations: { confirm: [], release: [] },
      events: [],
    },
  } as unknown as CommitTurnRequest;
}

const commit = (request: CommitTurnRequest): Promise<CommitTurnOutcome> =>
  commitTurn(runtime, request, { now: NOW });

/** The version of one row now, read by the owner, by item 77's name (the SQL's own) or its one key. */
async function versionNow(table: string, rowId: string): Promise<number | null> {
  const name =
    table === "company_kinds"
      ? db.sql`company_id || '/' || kind_id`
      : table === "flow_defaults"
        ? db.sql`business_id || '/' || flow`
        : table === "kind_flows"
          ? db.sql`kind_id || '/' || flow`
          : table === "business_setup"
            ? db.sql`business_id`
            : db.sql`id`;
  const [row] = await db.sql<
    { version: number }[]
  >`select version from ${db.sql(table)} where ${name} = ${rowId}`;
  return row?.version ?? null;
}

async function turnWritten(turnId: string): Promise<boolean> {
  const [row] = await db.sql<{ n: number }[]>`select count(*)::integer as n from turns where id = ${turnId}`;
  return row?.n === 1;
}

const HAIRCUT = seedRowWhere("services-prices", "seed-services-price-list.json", "services", {
  id: "svc-lees-haircut",
});
const BARBER_A = seedRowWhere("kinds-of-work", "seed-kinds-sample.json", "kind_flows", {
  kind_id: "barber",
  flow: "A",
});
const ELECTRICIAN = seedRowWhere("business-setup", "seed-company-two-kinds.json", "company_kinds", {
  kind_id: "electrician",
});

describe("commitTurn with the setup tables as write targets (T-667)", () => {
  it(
    "writes each setup table, an update naming its version, and answers a two-column row by item 77's name",
    SLOW,
    async () => {
      const request = turnOf(
        "turn-t667-setup-writes",
        [
          {
            op: "insert",
            table: "services",
            values: { ...HAIRCUT, id: "svc-lees-haircut-t667", position: 11, version: undefined },
          },
          {
            op: "update",
            table: "business_setup",
            key: { business_id: BARBERSHOP },
            expectVersion: 4,
            set: { no_money: true },
          },
          {
            op: "update",
            table: "flow_defaults",
            key: { business_id: BARBERSHOP, flow: "A" },
            expectVersion: 1,
            set: { cutoff_before: "48 hours" },
          },
          {
            op: "update",
            table: "company_kinds",
            key: { kind_id: "barber", company_id: "company-lees-barbershop" },
            expectVersion: 1,
            set: { trade_name: "Lee's Barbershop" },
          },
          {
            op: "insert",
            table: "company_kinds",
            values: {
              ...ELECTRICIAN,
              company_id: "company-lees-barbershop",
              business_id: BARBERSHOP,
              version: undefined,
            },
          },
        ] as unknown as StateWrite[],
        [
          { table: "kind_flows", rowId: "barber/A", version: BARBER_A.version as number },
          { table: "company_kinds", rowId: "company-lees-barbershop/barber", version: 1 },
          { table: "business_setup", rowId: BARBERSHOP, version: 4 },
        ],
      );
      const outcome = await commit(request);
      expect(answerErrors(outcome)).toEqual([]);
      expect(outcome).toEqual({
        result: "committed",
        turnId: "turn-t667-setup-writes",
        committedAt: "2026-11-16T15:00:00Z",
        repeated: false,
        committed: {
          written: [
            { table: "services", rowId: "svc-lees-haircut-t667", version: 1 },
            { table: "business_setup", rowId: BARBERSHOP, version: 5 },
            { table: "flow_defaults", rowId: `${BARBERSHOP}/A`, version: 2 },
            { table: "company_kinds", rowId: "company-lees-barbershop/barber", version: 2 },
            { table: "company_kinds", rowId: "company-lees-barbershop/electrician", version: 1 },
          ],
          outboxRows: [],
          promoted: [],
        },
      });
      const [kind] = await db.sql<{ trade_name: string; business_id: string; version: number }[]>`
      select trade_name, business_id, version from company_kinds
      where company_id = 'company-lees-barbershop' and kind_id = 'barber'
    `;
      expect(kind).toEqual({ trade_name: "Lee's Barbershop", business_id: BARBERSHOP, version: 2 });
      const [cutoff] = await db.sql<{ minutes: number }[]>`
      select (extract(epoch from cutoff_before) / 60)::integer as minutes from flow_defaults
      where business_id = ${BARBERSHOP} and flow = 'A'
    `;
      expect(cutoff?.minutes).toBe(2880);
      expect(await versionNow("business_setup", BARBERSHOP)).toBe(5);
      // A repeat answers the first commit and writes nothing twice.
      const repeat = await commit(request);
      expect(repeat).toMatchObject({ result: "committed", repeated: true, committed: { written: [] } });
      expect(await versionNow("company_kinds", "company-lees-barbershop/barber")).toBe(2);
    },
  );

  it(
    "refuses a stale version with the rows that changed (limit 4), each named as K-05 names it, and writes nothing",
    SLOW,
    async () => {
      const outcome = await commit(
        turnOf(
          "turn-t667-stale",
          [
            {
              op: "update",
              table: "business_setup",
              key: { business_id: BARBERSHOP },
              expectVersion: 3,
              set: { no_money: true },
            },
            {
              op: "update",
              table: "flow_defaults",
              key: { business_id: BARBERSHOP, flow: "B" },
              expectVersion: 2,
              set: { arrive: "window" },
            },
            {
              op: "insert",
              table: "services",
              values: { ...HAIRCUT, id: "svc-lees-haircut-stale", position: 12, version: undefined },
            },
          ] as unknown as StateWrite[],
          [
            { table: "company_kinds", rowId: "company-lees-barbershop/barber", version: 2 },
            { table: "kind_flows", rowId: "barber/A", version: (BARBER_A.version as number) + 8 },
            { table: "services", rowId: "svc-lees-haircut", version: HAIRCUT.version as number },
          ],
        ),
      );
      expect(answerErrors(outcome)).toEqual([]);
      expect(outcome).toEqual({
        error: "versionChanged",
        changed: [
          {
            table: "company_kinds",
            rowId: "company-lees-barbershop/barber",
            readVersion: 2,
            currentVersion: 1,
          },
          {
            table: "kind_flows",
            rowId: "barber/A",
            readVersion: (BARBER_A.version as number) + 8,
            currentVersion: BARBER_A.version,
          },
          { table: "business_setup", rowId: BARBERSHOP, readVersion: 3, currentVersion: 4 },
          { table: "flow_defaults", rowId: `${BARBERSHOP}/B`, readVersion: 2, currentVersion: 1 },
        ],
      });
      expect(await turnWritten("turn-t667-stale")).toBe(false);
      expect(await versionNow("business_setup", BARBERSHOP)).toBe(4);
      expect(await versionNow("flow_defaults", `${BARBERSHOP}/B`)).toBe(1);
      expect(await versionNow("services", "svc-lees-haircut-stale")).toBeNull();
    },
  );

  it(
    "finds a company_kinds version read by its '/' name under its own business, and no row under another's",
    SLOW,
    async () => {
      const plumbing: RowRef = {
        table: "company_kinds",
        rowId: "company-lee-home-services/plumber",
        version: 1,
      };
      // Under its business: a write of Lee Home Services' own (its electrician kind, by its key) rests on the read.
      const own = await commit(
        turnOf(
          "turn-t667-own-business",
          [
            {
              op: "update",
              table: "company_kinds",
              key: { company_id: "company-lee-home-services", kind_id: "electrician" },
              expectVersion: 1,
              set: { pf_switches_b: ["cancelright"] },
            },
          ] as unknown as StateWrite[],
          [plumbing],
        ),
      );
      expect(answerErrors(own)).toEqual([]);
      expect(own).toMatchObject({
        result: "committed",
        committed: {
          written: [{ table: "company_kinds", rowId: "company-lee-home-services/electrician", version: 2 }],
        },
      });
      // Under another business: the barbershop's write names Lee Home Services' kind, which its compare does not find.
      const shopWrite = {
        op: "update",
        table: "business_setup",
        key: { business_id: BARBERSHOP },
        expectVersion: 4,
        set: { no_money: true },
      } as unknown as StateWrite;
      await expect(commit(turnOf("turn-t667-other-business", [shopWrite], [plumbing]))).rejects.toThrow(
        /a row of company_kinds the request names does not exist/,
      );
      expect(await turnWritten("turn-t667-other-business")).toBe(false);
      expect(await versionNow("business_setup", BARBERSHOP)).toBe(4);
      // The kind's id alone names no row, whatever the business.
      await expect(
        commit(
          turnOf(
            "turn-t667-kind-alone",
            [shopWrite],
            [{ table: "company_kinds", rowId: "barber", version: 1 }],
          ),
        ),
      ).rejects.toThrow(/a row of company_kinds the request names does not exist/);
      // Under its own business the same read rests the barbershop's write on its own kind.
      const shop = await commit(
        turnOf(
          "turn-t667-shop",
          [shopWrite],
          [{ table: "company_kinds", rowId: "company-lees-barbershop/barber", version: 1 }],
        ),
      );
      expect(shop).toMatchObject({
        result: "committed",
        committed: { written: [{ table: "business_setup", version: 5 }] },
      });
      expect(await versionNow("company_kinds", "company-lee-home-services/plumber")).toBe(1);
    },
  );

  it("compares a sign-up's version read with no business only under no business", SLOW, async () => {
    const company = seedRowWhere("business-setup", "seed-company-two-kinds.json", "companies", {
      id: "company-lee-home-services",
    });
    const plumber = seedRowWhere("business-setup", "seed-company-two-kinds.json", "company_kinds", {
      kind_id: "plumber",
    });
    // S1-04 before S1-09: a company and its kind with no business, on the runtime side.
    const placed = await commit(
      turnOf("turn-t667-sign-up-1", [
        {
          op: "insert",
          table: "companies",
          values: { ...company, id: "company-sam-sign-up", business_id: null, version: undefined },
        },
        {
          op: "insert",
          table: "company_kinds",
          values: { ...plumber, company_id: "company-sam-sign-up", business_id: null, version: undefined },
        },
      ] as unknown as StateWrite[]),
    );
    expect(placed).toMatchObject({
      result: "committed",
      committed: {
        written: [
          { table: "companies", rowId: "company-sam-sign-up", version: 1 },
          { table: "company_kinds", rowId: "company-sam-sign-up/plumber", version: 1 },
        ],
      },
    });
    const earlyKind: RowRef = { table: "company_kinds", rowId: "company-sam-sign-up/plumber", version: 1 };
    // The next sign-up turn, with no business either, rests a second kind on the first.
    const second = await commit(
      turnOf(
        "turn-t667-sign-up-2",
        [
          {
            op: "insert",
            table: "company_kinds",
            values: {
              ...ELECTRICIAN,
              company_id: "company-sam-sign-up",
              business_id: null,
              version: undefined,
            },
          },
        ] as unknown as StateWrite[],
        [earlyKind],
      ),
    );
    expect(second).toMatchObject({
      result: "committed",
      committed: {
        written: [{ table: "company_kinds", rowId: "company-sam-sign-up/electrician", version: 1 }],
      },
    });
    // A business's write never finds a kind with no business by its name.
    await expect(
      commit(
        turnOf(
          "turn-t667-sign-up-other",
          [
            {
              op: "update",
              table: "business_setup",
              key: { business_id: BARBERSHOP },
              expectVersion: 4,
              set: { no_money: true },
            },
          ] as unknown as StateWrite[],
          [earlyKind],
        ),
      ),
    ).rejects.toThrow(/a row of company_kinds the request names does not exist/);
    expect(await versionNow("business_setup", BARBERSHOP)).toBe(4);
    // The commit that places it names the kind by its key, found as it stands (no business), its business set in the
    // same commit as its company's; its version read is the same row, compared once.
    const placedKind = await commit(
      turnOf(
        "turn-t667-sign-up-placed",
        [
          {
            op: "update",
            table: "companies",
            key: { id: "company-sam-sign-up" },
            expectVersion: 1,
            set: { business_id: MOVERS },
          },
          {
            op: "update",
            table: "company_kinds",
            key: { company_id: "company-sam-sign-up", kind_id: "plumber" },
            expectVersion: 1,
            set: { business_id: MOVERS },
          },
        ] as unknown as StateWrite[],
        [earlyKind],
      ),
    );
    expect(answerErrors(placedKind)).toEqual([]);
    expect(placedKind).toMatchObject({
      result: "committed",
      committed: {
        written: [
          { table: "companies", rowId: "company-sam-sign-up", version: 2 },
          { table: "company_kinds", rowId: "company-sam-sign-up/plumber", version: 2 },
        ],
      },
    });
    const [kind] = await db.sql<{ business_id: string | null }[]>`
      select business_id from company_kinds where company_id = 'company-sam-sign-up' and kind_id = 'plumber'
    `;
    expect(kind?.business_id).toBe(MOVERS);
  });

  it(
    "refuses a two-column update that does not name its whole key, or changes it, before anything is written",
    SLOW,
    async () => {
      for (const [key, set] of [
        [{ company_id: "company-lees-barbershop" }, { trade_name: "x" }],
        [
          { company_id: "company-lees-barbershop", kind_id: "barber", business_id: BARBERSHOP },
          { trade_name: "x" },
        ],
        [{ company_id: "company-lees-barbershop", kind_id: "" }, { trade_name: "x" }],
        [{ company_id: "company-lees-barbershop", kind_id: "barber" }, { kind_id: "plumber" }],
      ] as const) {
        await expect(
          commit(
            turnOf("turn-t667-bad-key", [
              { op: "update", table: "company_kinds", key, expectVersion: 1, set },
            ] as unknown as StateWrite[]),
          ),
        ).rejects.toThrow(/a state update of company_kinds/);
      }
      await expect(
        commit(
          turnOf("turn-t667-no-such-kind", [
            {
              op: "update",
              table: "company_kinds",
              key: { company_id: "company-lees-barbershop", kind_id: "plumber" },
              expectVersion: 1,
              set: { trade_name: "x" },
            },
          ] as unknown as StateWrite[]),
        ),
      ).rejects.toThrow(/a row of company_kinds the request names does not exist/);
      expect(await turnWritten("turn-t667-bad-key")).toBe(false);
      expect(await versionNow("company_kinds", "company-lees-barbershop/barber")).toBe(1);
    },
  );

  it(
    "writes K-27's calendar link, which row-level security binds by person, on the runtime side",
    SLOW,
    async () => {
      const outcome = await commit(
        turnOf("turn-t667-calendar-connect", [
          {
            op: "insert",
            table: "calendar_links",
            values: {
              id: "callink-sam-google-connecting",
              person_id: "person-sam",
              provider: "google",
              state: "connecting",
            },
          },
        ] as unknown as StateWrite[]),
      );
      expect(answerErrors(outcome)).toEqual([]);
      expect(outcome).toMatchObject({
        result: "committed",
        committed: {
          written: [{ table: "calendar_links", rowId: "callink-sam-google-connecting", version: 1 }],
        },
      });
    },
  );
});
