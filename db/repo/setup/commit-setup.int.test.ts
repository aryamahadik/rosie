// T-667: K-05 v1.1's commitTurn with the setup tables as write targets (db/repo/commit-turn.ts), against local
// PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/setup`). The schema comes from migrating a fresh test
// schema, which test-db.ts drops when the file ends.
//
// Every commit runs as K-05 states it (README "Scope": per write): through a client whose connections run as rosie_job
// with no business scope at the start of each transaction, so the grants and row-level security are the ones the commit
// meets. The tables' owner (the migrations' role) loads the seeds and reads what a commit wrote. The rows come only from
// fixture set v1's demo shops (rule 9): K-22's, K-23's, K-24's, K-25's and K-30's seeds and the K-04 seeds their chains
// name (Lee's Barbershop, Lee Home Services, the pet boarding shop and the master's sample cast), K-27's calendar link
// seed (read for one row's values, never loaded) and K-05 v1.18's read-price-rules-haircut-tie.json, whose note names
// the two rows its database side writes. A row a commit writes here is one of those rows, or a seed row under a new id.
//
// K-05 v1.18 item 77 (DL-911, DL-913): a two-column key's row is named by its key's values joined by "/" in key order,
// built by the SQL and compared whole; a state update names it by its key, column to value; a version read by its name,
// under the businesses the commit writes, so another business's name finds no row.
//
// Round 2 (DL-925 item 8d): a commit never moves a row of a business to another business or to none. Its test adds K-27's
// seed photo block (seed-busy-block.json's own row, which names no link, so none of its chain), which, like K-22's codes,
// row-level security does not hold to its business on the runtime side (rosie_job's policy is true), so the commit
// refuses the move itself.
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BUSINESS_UNHELD_TABLES,
  commitTurn,
  type CommitTurnOutcome,
  type CommitTurnRequest,
} from "../commit-turn";
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
  ["people-access", "seed-session.json"],
  ["business-setup", "seed-business-demo-shop.json"],
  ["business-setup", "seed-company-two-kinds.json"],
  ["kinds-of-work", "seed-kinds-sample.json"],
  ["kinds-of-work", "seed-new-work-draft.json"],
  ["services-prices", "seed-services-price-list.json"],
  ["services-prices", "seed-service-money-paths.json"],
  ["services-prices", "seed-item-services.json"],
  ["services-prices", "seed-price-rule-dates.json"],
  ["bookings-changes", "seed-terms-snapshot.json"],
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

/** Every own row of `table` in a seed whose values hold each of `match`'s, in the seed's order. */
function seedRows(part: string, file: string, table: string, match: Values = {}): Values[] {
  return (readJson(seedUrl(part, file)) as SeedFile).rows
    .filter(
      (row) =>
        row.table === table && Object.entries(match).every(([column, value]) => row.values[column] === value),
    )
    .map((row) => row.values);
}

/** The one own row of `table` in a seed whose values hold each of `match`'s. */
function seedRowWhere(part: string, file: string, table: string, match: Values): Values {
  const [row, ...more] = seedRows(part, file, table, match);
  if (row === undefined || more.length > 0) {
    throw new Error(`${file} has no one ${table} row that matches`);
  }
  return row;
}

/** A seed value that must be text (an id). */
function textOf(value: Json | undefined): string {
  if (typeof value !== "string") {
    throw new Error("expected a seed id as text");
  }
  return value;
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

/** The registries a migration seeds (K-26 rule 5): a seed chain names their rows, which are already there. */
const MIGRATION_SEEDED = new Set(["trade_facts", "plugin_switches", "rule_kinds"]);

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
      if (MIGRATION_SEEDED.has(row.table)) {
        await tx`insert into ${tx(row.table)} ${tx(values)} on conflict do nothing`;
      } else {
        await tx`insert into ${tx(row.table)} ${tx(values)}`;
      }
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
const FLOW_A_DEFAULTS = seedRowWhere("business-setup", "seed-business-demo-shop.json", "flow_defaults", {
  flow: "A",
});

/** K-05 v1.18's read-price-rules-haircut-tie.json, as far as this file reads it: its answer's rules and ties. */
interface TieFixture {
  outcome: {
    rules: {
      id: string;
      businessId: string;
      serviceId: string;
      conditions: {
        serviceMoneyId: string | null;
        workerResourceId: string | null;
        weekdays: string | null;
        fromTime: string | null;
        untilTime: string | null;
      };
      priceCents: number;
      fromCents: number | null;
      currency: string;
      setByPersonId: string;
      effectiveFrom: string;
      effectiveTo: string | null;
    }[];
    ties: {
      id: string;
      businessId: string;
      serviceId: string;
      firstRuleId: string;
      secondRuleId: string;
      askedAt: string;
      winnerRuleId: string | null;
      answeredAt: string | null;
      answeredByPersonId: string | null;
    }[];
  };
}

/**
 * The two rows K-05 v1.18's tie fixture says its database side writes (its note: no frozen seed holds a tie), as the
 * columns of K-25's price_rules and price_rule_ties, taken from the fixture's answer: the haircut's evening price and its
 * tie with the price at the customer's home, as T-320's catalog adds them when Sam saves the evening price.
 */
function tieFixtureRows(): { evening: Values; tie: Values } {
  const fixture = readJson(
    new URL("data-access/fixtures/read-price-rules-haircut-tie.json", CONTRACTS),
  ) as TieFixture;
  const [tie, ...moreTies] = fixture.outcome.ties;
  const evening = fixture.outcome.rules.find((rule) => rule.id === tie?.secondRuleId);
  if (tie === undefined || moreTies.length > 0 || evening === undefined) {
    throw new Error("read-price-rules-haircut-tie.json has no one tie with its second rule");
  }
  return {
    evening: {
      id: evening.id,
      business_id: evening.businessId,
      service_id: evening.serviceId,
      service_money_id: evening.conditions.serviceMoneyId,
      worker_resource_id: evening.conditions.workerResourceId,
      weekdays: evening.conditions.weekdays,
      from_time: evening.conditions.fromTime,
      until_time: evening.conditions.untilTime,
      price_cents: evening.priceCents,
      from_cents: evening.fromCents,
      currency: evening.currency,
      set_by_person_id: evening.setByPersonId,
      effective_from: evening.effectiveFrom,
      effective_to: evening.effectiveTo,
    },
    tie: {
      id: tie.id,
      business_id: tie.businessId,
      service_id: tie.serviceId,
      first_rule_id: tie.firstRuleId,
      second_rule_id: tie.secondRuleId,
      asked_at: tie.askedAt,
      winner_rule_id: tie.winnerRuleId,
      answered_at: tie.answeredAt,
      answered_by_person_id: tie.answeredByPersonId,
    },
  };
}

/** The barbershop's own write, at its seed version: a commit whose one business is the barbershop. */
const SHOP_NO_MONEY = {
  op: "update",
  table: "business_setup",
  key: { business_id: BARBERSHOP },
  expectVersion: 4,
  set: { no_money: true },
} as unknown as StateWrite;

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
            // A business's own defaults written (S1-21), the barbershop's flow A row under the movers' business.
            op: "insert",
            table: "flow_defaults",
            values: { ...FLOW_A_DEFAULTS, business_id: MOVERS, version: undefined },
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
            { table: "flow_defaults", rowId: `${MOVERS}/A`, version: 1 },
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
      const shopWrite = SHOP_NO_MONEY;
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

  it(
    "compares a sign-up's version reads under no business, S1-09's under none and the business it gives",
    SLOW,
    async () => {
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
      await expect(commit(turnOf("turn-t667-sign-up-other", [SHOP_NO_MONEY], [earlyKind]))).rejects.toThrow(
        /a row of company_kinds the request names does not exist/,
      );
      expect(await versionNow("business_setup", BARBERSHOP)).toBe(4);
      // S1-09: the commit that gives the company its business names the plumbing kind by its key, found as it stands (no
      // business), its business set in the same commit as its company's; its version read is the same row, compared once.
      // It writes rows with no business and the movers', so its version read of the electrician kind, which it does not
      // write, is found with no business too.
      const electrician: RowRef = {
        table: "company_kinds",
        rowId: "company-sam-sign-up/electrician",
        version: 1,
      };
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
          [earlyKind, electrician],
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
      // The electrician kind's own move to the movers: a commit of that shape never finds another business's kind.
      const placeElectrician = {
        op: "update",
        table: "company_kinds",
        key: { company_id: "company-sam-sign-up", kind_id: "electrician" },
        expectVersion: 1,
        set: { business_id: MOVERS },
      } as unknown as StateWrite;
      await expect(
        commit(
          turnOf(
            "turn-t667-sign-up-placed-other",
            [placeElectrician],
            [{ table: "company_kinds", rowId: "company-lees-barbershop/barber", version: 1 }],
          ),
        ),
      ).rejects.toThrow(/a row of company_kinds the request names does not exist/);
      expect(await versionNow("company_kinds", "company-sam-sign-up/electrician")).toBe(1);
      // Under the business it moves the row to, it finds the plumbing kind placed before it.
      const placedElectrician = await commit(
        turnOf("turn-t667-sign-up-placed-2", [placeElectrician], [{ ...earlyKind, version: 2 }]),
      );
      expect(answerErrors(placedElectrician)).toEqual([]);
      expect(placedElectrician).toMatchObject({
        result: "committed",
        committed: {
          written: [{ table: "company_kinds", rowId: "company-sam-sign-up/electrician", version: 2 }],
        },
      });
    },
  );

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
    "names a draft's block, a key whose second column is a number, by item 77's name: added, changed, read and refused",
    SLOW,
    async () => {
      const no = seedRowWhere("kinds-of-work", "seed-new-work-draft.json", "new_work_draft_blocks", {
        block: 3,
      });
      const draft = textOf(no.draft_id);
      const asNo = {
        outcome: no.outcome,
        answer: no.answer,
        facts_on: no.facts_on,
        switches_on: no.switches_on,
      };
      const blockNow = async (block: number): Promise<{ outcome: string; version: number } | undefined> => {
        const [row] = await db.sql<{ outcome: string; version: number }[]>`
          select outcome, version from new_work_draft_blocks where draft_id = ${draft} and block = ${block}
        `;
        return row;
      };
      // S1-03's checklist: block 5, at its safe default with no row, gets a clear no (block 3's row under block 5),
      // and block 4's answer becomes a no, at its version; both rest on block 6 as read.
      const outcome = await commit(
        turnOf(
          "turn-t667-draft-blocks",
          [
            {
              op: "insert",
              table: "new_work_draft_blocks",
              values: { ...no, block: 5, version: undefined },
            },
            {
              op: "update",
              table: "new_work_draft_blocks",
              key: { draft_id: draft, block: 4 },
              expectVersion: 1,
              set: asNo,
            },
          ] as unknown as StateWrite[],
          [{ table: "new_work_draft_blocks", rowId: `${draft}/6`, version: 1 }],
        ),
      );
      expect(answerErrors(outcome)).toEqual([]);
      expect(outcome).toMatchObject({
        result: "committed",
        committed: {
          written: [
            { table: "new_work_draft_blocks", rowId: `${draft}/5`, version: 1 },
            { table: "new_work_draft_blocks", rowId: `${draft}/4`, version: 2 },
          ],
        },
      });
      // A version read of block 4 by its name, at the version before: versionChanged names it so, and nothing is written.
      const stale = await commit(
        turnOf(
          "turn-t667-draft-stale",
          [
            {
              op: "update",
              table: "new_work_draft_blocks",
              key: { draft_id: draft, block: 8 },
              expectVersion: 1,
              set: asNo,
            },
          ] as unknown as StateWrite[],
          [{ table: "new_work_draft_blocks", rowId: `${draft}/4`, version: 1 }],
        ),
      );
      expect(answerErrors(stale)).toEqual([]);
      expect(stale).toEqual({
        error: "versionChanged",
        changed: [{ table: "new_work_draft_blocks", rowId: `${draft}/4`, readVersion: 1, currentVersion: 2 }],
      });
      expect(await turnWritten("turn-t667-draft-stale")).toBe(false);
      // The barbershop's write never finds the pet boarding shop's block by its name.
      await expect(
        commit(
          turnOf(
            "turn-t667-draft-other-business",
            [SHOP_NO_MONEY],
            [{ table: "new_work_draft_blocks", rowId: `${draft}/6`, version: 1 }],
          ),
        ),
      ).rejects.toThrow(/a row of new_work_draft_blocks the request names does not exist/);
      expect(await blockNow(4)).toEqual({ outcome: "no", version: 2 });
      expect(await blockNow(5)).toEqual({ outcome: "no", version: 1 });
      expect(await blockNow(8)).toEqual({ outcome: "answered", version: 1 });
      expect(await versionNow("business_setup", BARBERSHOP)).toBe(4);
    },
  );

  it(
    "carries the catalog's writes (T-320's set) at their versions: services, ways, prices and ties added and changed, a space's link and a terms snapshot added",
    SLOW,
    async () => {
      const way = seedRowWhere("services-prices", "seed-service-money-paths.json", "service_money", {
        id: "way-lees-haircut-shop",
      });
      const price = seedRowWhere("services-prices", "seed-item-services.json", "price_rules", {
        id: "price-boarding-cat-condo",
      });
      const link = seedRowWhere("services-prices", "seed-item-services.json", "item_services", {
        place_or_thing_id: "place-pet-boarding-cat-condo",
      });
      const place = textOf(link.place_or_thing_id);
      const service = seedRowWhere("services-prices", "seed-item-services.json", "services", {
        id: textOf(link.service_id),
      });
      const consult = seedRowWhere("services-prices", "seed-services-price-list.json", "services", {
        id: "svc-lees-style-consult",
      });
      const home = seedRowWhere("services-prices", "seed-price-rule-dates.json", "price_rules", {
        id: "price-lees-haircut-home",
      });
      const { evening, tie } = tieFixtureRows();
      const terms = seedRowWhere("bookings-changes", "seed-terms-snapshot.json", "booking_terms", {
        booking_id: "booking-dee-skin-fade",
      });
      const booking = textOf(terms.booking_id);
      const termsRules = seedRows("bookings-changes", "seed-terms-snapshot.json", "booking_terms_rules", {
        booking_id: booking,
      });
      expect(termsRules).toHaveLength(4);
      // The seed's own link and terms snapshot, taken out by the owner so the commit adds them, as S1-81 adds a space's
      // link and a booking's commit its terms snapshot (K-30; T-320's takeTermsSnapshot).
      await db.sql`
        delete from item_services where place_or_thing_id = ${place} and service_id = ${textOf(service.id)}
      `;
      await db.sql`delete from booking_terms_rules where booking_id = ${booking}`;
      await db.sql`delete from booking_terms where booking_id = ${booking}`;
      const outcome = await commit(
        turnOf(
          "turn-t667-catalog",
          [
            {
              op: "insert",
              table: "services",
              values: { ...HAIRCUT, id: "svc-lees-haircut-t667", position: 11, version: undefined },
            },
            {
              op: "insert",
              table: "service_money",
              values: {
                ...way,
                id: "way-lees-haircut-t667-shop",
                service_id: "svc-lees-haircut-t667",
                version: undefined,
              },
            },
            { op: "insert", table: "price_rules", values: evening },
            { op: "insert", table: "price_rule_ties", values: tie },
            {
              op: "update",
              table: "services",
              key: { id: consult.id },
              expectVersion: consult.version,
              set: { active: false },
            },
            {
              op: "update",
              table: "service_money",
              key: { id: way.id },
              expectVersion: way.version,
              set: { fee_cents: 2500 },
            },
            {
              op: "update",
              table: "price_rules",
              key: { id: price.id },
              expectVersion: price.version,
              set: { effective_to: "2026-11-16T15:00:00Z" },
            },
            { op: "insert", table: "item_services", values: link },
            { op: "insert", table: "booking_terms", values: terms },
            ...termsRules.map((values) => ({ op: "insert", table: "booking_terms_rules", values })),
          ] as unknown as StateWrite[],
          [
            { table: "services", rowId: textOf(service.id), version: service.version as number },
            { table: "price_rules", rowId: textOf(home.id), version: home.version as number },
          ],
        ),
      );
      expect(answerErrors(outcome)).toEqual([]);
      // item_services, booking_terms and booking_terms_rules carry no version, so the answer names no row of them (K-05
      // item 1).
      expect(outcome).toMatchObject({
        result: "committed",
        committed: {
          written: [
            { table: "services", rowId: "svc-lees-haircut-t667", version: 1 },
            { table: "service_money", rowId: "way-lees-haircut-t667-shop", version: 1 },
            { table: "price_rules", rowId: evening.id, version: 1 },
            { table: "price_rule_ties", rowId: tie.id, version: 1 },
            { table: "services", rowId: consult.id, version: (consult.version as number) + 1 },
            { table: "service_money", rowId: way.id, version: (way.version as number) + 1 },
            { table: "price_rules", rowId: price.id, version: (price.version as number) + 1 },
          ],
        },
      });
      // The owner answers the tie (S13-25 rule 19): an update at the version the insert gave it, resting on the evening
      // price as the first commit wrote it.
      const answered = await commit(
        turnOf(
          "turn-t667-tie-answered",
          [
            {
              op: "update",
              table: "price_rule_ties",
              key: { id: tie.id },
              expectVersion: 1,
              set: {
                winner_rule_id: home.id,
                answered_at: "2026-11-16T15:00:00Z",
                answered_by_person_id: evening.set_by_person_id,
              },
            },
          ] as unknown as StateWrite[],
          [{ table: "price_rules", rowId: textOf(evening.id), version: 1 }],
        ),
      );
      expect(answerErrors(answered)).toEqual([]);
      expect(answered).toMatchObject({
        result: "committed",
        committed: { written: [{ table: "price_rule_ties", rowId: tie.id, version: 2 }] },
      });
      const [linked] = await db.sql<{ business_id: string }[]>`
        select business_id from item_services where place_or_thing_id = ${place} and service_id = ${textOf(service.id)}
      `;
      expect(linked?.business_id).toBe(link.business_id);
      const [closed] = await db.sql<{ open: boolean }[]>`
        select effective_to is null as open from price_rules where id = ${textOf(price.id)}
      `;
      expect(closed?.open).toBe(false);
      const [winner] = await db.sql<{ winner: string | null; version: number }[]>`
        select winner_rule_id as winner, version from price_rule_ties where id = ${textOf(tie.id)}
      `;
      expect(winner).toEqual({ winner: home.id, version: 2 });
      const [snapshot] = await db.sql<{ consent: string | null; rules: number }[]>`
        select t.terms_consent_id as consent,
               (select count(*)::integer from booking_terms_rules r where r.booking_id = t.booking_id) as rules
        from booking_terms t where t.booking_id = ${booking}
      `;
      expect(snapshot).toEqual({ consent: terms.terms_consent_id, rules: termsRules.length });
      expect(await versionNow("services", textOf(consult.id))).toBe((consult.version as number) + 1);
    },
  );

  it(
    "writes K-27's calendar link and ends a K-22 session, the tables bound by person, on the runtime side at their versions",
    SLOW,
    async () => {
      // K-27's connecting link (Avery's, the seed's one) under a new id for Sam, whose own link this file does not load,
      // as the connect's start writes it through the commit (K-27 rule 5); Sam's live session ended at its version, as
      // the commit ends someone else's sessions on the runtime side (K-22 rule 5: handed_over, S11-100).
      const connecting = seedRowWhere("availability", "seed-calendar-link.json", "calendar_links", {
        state: "connecting",
      });
      const session = seedRowWhere("people-access", "seed-session.json", "sessions", { ended_at: null });
      const sessionId = textOf(session.id);
      const endSession = {
        op: "update",
        table: "sessions",
        key: { id: sessionId },
        expectVersion: session.version,
        set: { ended_at: "2026-11-16T15:00:00Z", ended_why: "handed_over" },
      } as unknown as StateWrite;
      const outcome = await commit(
        turnOf("turn-t667-person-bound", [
          {
            op: "insert",
            table: "calendar_links",
            values: { ...connecting, id: "callink-sam-google", person_id: "person-sam", version: undefined },
          },
          endSession,
        ] as unknown as StateWrite[]),
      );
      expect(answerErrors(outcome)).toEqual([]);
      expect(outcome).toMatchObject({
        result: "committed",
        committed: {
          written: [
            { table: "calendar_links", rowId: "callink-sam-google", version: 1 },
            { table: "sessions", rowId: sessionId, version: (session.version as number) + 1 },
          ],
        },
      });
      // The same end again, at the version it read before: refused with the row that changed, nothing written.
      const stale = await commit(turnOf("turn-t667-person-bound-stale", [endSession]));
      expect(answerErrors(stale)).toEqual([]);
      expect(stale).toEqual({
        error: "versionChanged",
        changed: [
          {
            table: "sessions",
            rowId: sessionId,
            readVersion: session.version,
            currentVersion: (session.version as number) + 1,
          },
        ],
      });
      expect(await turnWritten("turn-t667-person-bound-stale")).toBe(false);
    },
  );

  it(
    "refuses an update that moves a code or a photo block to another business or to none, before any write (round 2)",
    SLOW,
    async () => {
      // K-27's seed photo block: Sam's schedule photo at the movers, on Sam's yes. It names no link, so it is added alone.
      const photo = seedRowWhere("availability", "seed-busy-block.json", "busy_blocks", { source: "photo" });
      await db.sql`insert into busy_blocks ${db.sql(photo as unknown as Record<string, never>)}`;
      const ownerEmail = seedRowWhere("people-access", "seed-proof-code.json", "proof_codes", {
        id: "code-sam-owner-email",
      });
      const signIn = seedRowWhere("people-access", "seed-proof-code.json", "proof_codes", {
        id: "code-sam-sign-in-oct20",
      });
      const setBusiness = (table: string, row: Values, business: string | null): StateWrite =>
        ({
          op: "update",
          table,
          key: { id: row.id },
          expectVersion: row.version,
          set: { business_id: business },
        }) as unknown as StateWrite;
      const rowNow = async (
        table: string,
        id: Json | undefined,
      ): Promise<{ business_id: string | null; version: number } | undefined> => {
        const [row] = await db.sql<{ business_id: string | null; version: number }[]>`
          select business_id, version from ${db.sql(table)} where id = ${textOf(id)}
        `;
        return row;
      };
      expect(ownerEmail.business_id).toBe(BARBERSHOP);
      expect(photo.business_id).toBe(MOVERS);
      for (const [turnId, move] of [
        ["turn-t667-move-code", setBusiness("proof_codes", ownerEmail, MOVERS)],
        ["turn-t667-move-code-to-none", setBusiness("proof_codes", ownerEmail, null)],
        ["turn-t667-move-photo", setBusiness("busy_blocks", photo, BARBERSHOP)],
        ["turn-t667-move-photo-to-none", setBusiness("busy_blocks", photo, null)],
      ] as const) {
        // The barbershop's own write comes first in the list, and is not written either: the refusal comes first.
        await expect(commit(turnOf(turnId, [SHOP_NO_MONEY, move]))).rejects.toThrow(
          /may not move a row of a business to another business/,
        );
        expect(await turnWritten(turnId), turnId).toBe(false);
      }
      expect(await versionNow("business_setup", BARBERSHOP)).toBe(4);
      expect(await rowNow("proof_codes", ownerEmail.id)).toEqual({
        business_id: BARBERSHOP,
        version: ownerEmail.version,
      });
      expect(await rowNow("busy_blocks", photo.id)).toEqual({ business_id: MOVERS, version: photo.version });
      // A stale move is answered versionChanged first, as any stale write, and writes nothing.
      const stale = await commit(
        turnOf("turn-t667-move-stale", [
          { ...setBusiness("proof_codes", ownerEmail, MOVERS), expectVersion: 1 } as unknown as StateWrite,
        ]),
      );
      expect(stale).toEqual({
        error: "versionChanged",
        changed: [
          {
            table: "proof_codes",
            rowId: ownerEmail.id,
            readVersion: 1,
            currentVersion: ownerEmail.version,
          },
        ],
      });
      // The row's own business named again moves nothing, and a code with no business may be given one (S1-09's way):
      // both commit, each at its version.
      const kept = await commit(
        turnOf("turn-t667-business-kept", [
          setBusiness("busy_blocks", photo, MOVERS),
          setBusiness("proof_codes", signIn, BARBERSHOP),
        ]),
      );
      expect(answerErrors(kept)).toEqual([]);
      expect(kept).toMatchObject({
        result: "committed",
        committed: {
          written: [
            { table: "busy_blocks", rowId: photo.id, version: (photo.version as number) + 1 },
            { table: "proof_codes", rowId: signIn.id, version: (signIn.version as number) + 1 },
          ],
        },
      });
      expect(await rowNow("proof_codes", signIn.id)).toEqual({
        business_id: BARBERSHOP,
        version: (signIn.version as number) + 1,
      });
    },
  );

  it(
    "holds BUSINESS_UNHELD_TABLES to the catalog: each table with a business whose rosie_job policy admits any row",
    SLOW,
    async () => {
      const open = await db.sql<{ name: string }[]>`
      select distinct c.relname::text as name
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${db.schema}
        and p.polpermissive
        and p.polcmd in ('*', 'w')
        and p.polroles @> array[to_regrole('rosie_job')::oid]
        and pg_get_expr(coalesce(p.polwithcheck, p.polqual), p.polrelid) = 'true'
        and exists (
          select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped
        )
      order by 1
    `;
      expect(open.map((row) => row.name)).toEqual([...BUSINESS_UNHELD_TABLES].sort());
    },
  );
});
