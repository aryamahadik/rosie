// Fixtures, doubles and the database for the catalog binding's tests (T-1429). Never imported by the Worker.
//
// K-05 v1.18's accepted exchanges (contracts/data-access/fixtures, selected from index.json by version, never by a pinned
// list) are what the five reads answer; a fake of the five answers a request equal to an exchange's with that exchange's
// outcome, so a unit test drives the binding with db/repo's own answers. Each exchange's world is the seeds its `given`
// names (K-04's core seeds and the other parts' partSeeds, each with its own `after` chain, each file once), plus the rows
// read-price-rules-haircut-tie's note says its database side writes itself (no frozen seed holds a tie). The same rows
// feed T-320's in-memory double of the five reads (../test-support.ts readsOf), an independent reading of the seeds the
// tests hold the binding's answers to, and, in the integration test, PostgreSQL, loaded as the tables' owner.
//
// Rule 9: every row and value comes from fixture set v1's demo shops through the frozen seeds and fixtures (Lee's
// Barbershop, Lee Home Services, the yoga studio, the movers; Sam, Dee, Andre); no number, address or name is made here.

import { isDeepStrictEqual } from "node:util";

import type { CatalogRead } from "../../../../../db/repo/catalog-reads";
import type { Sql } from "../../../../../db/repo/scope";
import { insertRow } from "../../../commit/pg/test-support";
import { contractFile } from "../../../tool-api/test-support";
import { seedRows, type SeedRow } from "../test-support";
import type { CatalogK05Reads } from "./reads";

/** The K-05 version whose catalog reads the binding binds. */
export const VERSION = "v1.18";

export const BARBERSHOP = "biz-lees-barbershop";
export const HOME_SERVICES = "biz-lee-home-services";
export const YOGA = "biz-yoga-studio";
export const MOVERS = "biz-movers";

interface IndexEntry {
  readonly file: string;
  readonly version: string;
  readonly def?: string;
  readonly expect: string;
}

/** What an exchange assumes (K-05 README "Fixtures"): the seeds it reads and the fake clock. */
export interface CatalogGiven {
  readonly k04Seeds: readonly string[];
  readonly partSeeds?: readonly string[];
  readonly after: readonly string[];
  readonly now: string;
  readonly note?: string;
}

/** One v1.18 catalog exchange: a read's request and its outcome (its response, or notFound or transient). */
export interface CatalogExchange {
  readonly call: CatalogRead;
  readonly given: CatalogGiven;
  readonly request: Readonly<Record<string, unknown>>;
  readonly outcome: Readonly<Record<string, unknown>>;
}

/** One v1.18 exchange, freshly read (a test may change its copy). */
export function catalogExchange(file: string): CatalogExchange {
  return contractFile(`data-access/fixtures/${file}`) as CatalogExchange;
}

/** Every accepted v1.18 exchange of the index, by its version. */
export function acceptedCatalogFiles(): string[] {
  const index = contractFile("data-access/fixtures/index.json") as { readonly fixtures: IndexEntry[] };
  return index.fixtures
    .filter((entry) => entry.version === VERSION && entry.expect === "accept")
    .map((entry) => entry.file);
}

/** The seed files an exchange's `given` names, as paths under contracts/db-schema/: K-04's, then the other parts'. */
export function seedFilesOf(given: CatalogGiven): string[] {
  return [
    ...given.k04Seeds.map((file) => `core/fixtures/${file}`),
    ...(given.partSeeds ?? []).map((name) => {
      const slash = name.indexOf("/");
      if (slash < 1) throw new Error(`partSeeds names <part>/<file>, not ${name}`);
      return `${name.slice(0, slash)}/fixtures/${name.slice(slash + 1)}`;
    }),
  ];
}

// ---- the rows read-price-rules-haircut-tie's note lists (written first, in its order) --------------------------------

export const TIE_FIXTURE = "read-price-rules-haircut-tie.json";

/** Sam's evening price on the haircut, as the tie fixture's note gives it. */
const EVENING_RULE: SeedRow = {
  table: "price_rules",
  values: {
    id: "price-lees-haircut-evening",
    business_id: BARBERSHOP,
    service_id: "svc-lees-haircut",
    service_money_id: null,
    worker_resource_id: null,
    weekdays: null,
    from_time: "17:00",
    until_time: null,
    price_cents: 4500,
    from_cents: null,
    currency: "USD",
    set_by_person_id: "person-sam",
    effective_from: "2026-11-03T15:00:00Z",
    effective_to: null,
    version: 1,
  },
};

/** The tie between the home price and the evening price, as the note gives it: asked, not answered. */
const EVENING_TIE: SeedRow = {
  table: "price_rule_ties",
  values: {
    id: "tie-lees-haircut-home-evening",
    business_id: BARBERSHOP,
    service_id: "svc-lees-haircut",
    first_rule_id: "price-lees-haircut-home",
    second_rule_id: "price-lees-haircut-evening",
    asked_at: "2026-11-03T15:00:00Z",
    winner_rule_id: null,
    answered_at: null,
    answered_by_person_id: null,
    version: 1,
  },
};

/** By fixture, the rows its note says its database side writes itself, in its order. */
export const NOTED_ROWS: Readonly<Record<string, readonly SeedRow[]>> = {
  [TIE_FIXTURE]: [EVENING_RULE, EVENING_TIE],
};

/** An exchange's world: its seeds' rows with their chains, then the rows its note lists. */
export function rowsOf(file: string): SeedRow[] {
  return [...seedRows(seedFilesOf(catalogExchange(file).given)), ...(NOTED_ROWS[file] ?? [])];
}

/**
 * Every accepted v1.18 exchange's world at once, each seed file once (K-25's withdrawn price beside them, as T-1428's
 * world has it), then every noted row: the barbershop, Lee Home Services, the yoga studio and the movers.
 */
export function worldRows(): SeedRow[] {
  const files = [
    ...new Set([
      ...acceptedCatalogFiles().flatMap((file) => seedFilesOf(catalogExchange(file).given)),
      "services-prices/fixtures/seed-price-withdrawn-before-start.json",
    ]),
  ];
  return [...seedRows(files), ...Object.values(NOTED_ROWS).flat()];
}

// ---- comparing answers --------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** A row's sort key: its id, or a kind's company and kind. */
const keyOf = (row: Row): string =>
  typeof row.id === "string" ? row.id : `${textOf(row.companyId)}/${textOf(row.kindId)}`;

/** Every list of rows in an answer in one order (the port names none), so two readings compare row by row. */
export function ordered(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(ordered);
    return items.every(isRecord) ? [...items].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1)) : items;
  }
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, ordered(item)]));
  return value;
}

/** Every value under a key named `name` anywhere in an answer. */
export function valuesNamed(value: unknown, name: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => valuesNamed(item, name));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => [
    ...(key === name ? [item] : []),
    ...valuesNamed(item, name),
  ]);
}

/** The thrown error of a call that must throw; an answer fails the test. */
export async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("it answered; it should have thrown");
    },
    (error: unknown) => error,
  );
}

// ---- a fake of the five K-05 reads over the exchanges ------------------------------------------------------------------

/** One read the fake was asked, as asked. */
export interface K05Ask {
  readonly call: CatalogRead;
  readonly request: unknown;
}

/**
 * The five reads answering from `exchanges`: a request equal to an exchange's of the same call gets a fresh copy of its
 * outcome; any other request fails the test. Every ask is written down in `asked`.
 */
export function fixtureK05Reads(
  exchanges: readonly CatalogExchange[],
  asked: K05Ask[] = [],
): CatalogK05Reads {
  const answer = (call: CatalogRead, request: unknown): Promise<unknown> => {
    asked.push({ call, request: structuredClone(request) });
    const found = exchanges.find(
      (exchange) => exchange.call === call && isDeepStrictEqual(exchange.request, request),
    );
    if (found === undefined) return Promise.reject(new Error(`no v1.18 fixture answers this ${call}`));
    return Promise.resolve(structuredClone(found.outcome));
  };
  return {
    readBusinessKinds: async (request) =>
      (await answer("readBusinessKinds", request)) as Awaited<
        ReturnType<CatalogK05Reads["readBusinessKinds"]>
      >,
    readBusinessServices: async (request) =>
      (await answer("readBusinessServices", request)) as Awaited<
        ReturnType<CatalogK05Reads["readBusinessServices"]>
      >,
    readServiceWays: async (request) =>
      (await answer("readServiceWays", request)) as Awaited<ReturnType<CatalogK05Reads["readServiceWays"]>>,
    readServicePriceRules: async (request) =>
      (await answer("readServicePriceRules", request)) as Awaited<
        ReturnType<CatalogK05Reads["readServicePriceRules"]>
      >,
    readTermsSources: async (request) =>
      (await answer("readTermsSources", request)) as Awaited<ReturnType<CatalogK05Reads["readTermsSources"]>>,
  };
}

/** The five reads each answering `outcome` to any request (an error answer, or another business's rows), asks noted. */
export function answeringK05Reads(outcome: object, asked: K05Ask[] = []): CatalogK05Reads {
  const answer = (call: CatalogRead, request: unknown): Promise<never> => {
    asked.push({ call, request: structuredClone(request) });
    return Promise.resolve(structuredClone(outcome) as never);
  };
  return {
    readBusinessKinds: (request) => answer("readBusinessKinds", request),
    readBusinessServices: (request) => answer("readBusinessServices", request),
    readServiceWays: (request) => answer("readServiceWays", request),
    readServicePriceRules: (request) => answer("readServicePriceRules", request),
    readTermsSources: (request) => answer("readTermsSources", request),
  };
}

/** The five reads each throwing `error` itself, as db/repo throws (a request it refuses, a value it cannot carry). */
export function throwingK05Reads(error: Error, asked: K05Ask[] = []): CatalogK05Reads {
  const thrown = (call: CatalogRead, request: unknown): Promise<never> => {
    asked.push({ call, request: structuredClone(request) });
    return Promise.reject(error);
  };
  return {
    readBusinessKinds: (request) => thrown("readBusinessKinds", request),
    readBusinessServices: (request) => thrown("readBusinessServices", request),
    readServiceWays: (request) => thrown("readServiceWays", request),
    readServicePriceRules: (request) => thrown("readServicePriceRules", request),
    readTermsSources: (request) => thrown("readTermsSources", request),
  };
}

// ---- PostgreSQL, as the tables' owner ---------------------------------------------------------------------------------

/** K-26's closed registries and their keys: only migration 0023's seed writes them (K-26 rule 5). */
const REGISTRY_KEYS: ReadonlyMap<string, string> = new Map([
  ["trade_facts", "name"],
  ["plugin_switches", "name"],
  ["rule_kinds", "id"],
]);

/**
 * Empties the tables the seeds write (truncating the heads and K-24's catalog of kinds cascades to the rest; this
 * file's schema only), then inserts `rows` in one transaction as the tables' owner: a jsonb column as JSON, a bytea one
 * from its hex, and a K-26 registry row found as migration 0023 wrote it, never inserted again (T-1427's database review
 * N4).
 */
export async function loadWorld(owner: Sql, schema: string, rows: readonly SeedRow[]): Promise<void> {
  await owner`truncate businesses, persons, handles, bundles, release_flags, kinds restart identity cascade`;
  const typed = await owner<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${schema} and data_type in ('jsonb', 'bytea')
  `;
  const columns = new Map(typed.map((column) => [column.key, column.type]));
  await owner.begin(async (tx) => {
    for (const row of rows) {
      const key = REGISTRY_KEYS.get(row.table);
      if (key === undefined) {
        await insertRow(tx, columns, row.table, row.values);
        continue;
      }
      const name = row.values[key];
      if (typeof name !== "string") throw new Error(`a ${row.table} seed row names no ${key}`);
      const [found] = await tx<{ rows: number }[]>`
        select count(*)::int as rows from ${tx(row.table)} where ${tx(key)} = ${name}
      `;
      if (found?.rows !== 1)
        throw new Error(`${row.table}: migration 0023's registry seed does not hold a seed row`);
    }
  });
}
