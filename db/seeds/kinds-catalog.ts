// T-1469: the kinds catalog set (C-155; K-24 v1 kinds of work, frozen: contracts/db-schema/kinds-of-work, its table list
// and its README's rules 2 and 7; DL-961, card G and its item 4; DL-988). It writes K-24's catalog alone, kinds and
// kind_flows from the 243 trade files, exactly as the kinds seed (kinds.ts, T-212) writes them, and no demo shop's pick,
// so staging's catalog can be filled before bundle v1 goes live there. S1-02's writer (T-633) matches the owner's words
// against this catalog (item 78), and on staging it may be empty: staging-core writes core rows only, and the kinds seed
// cannot run there, since it first checks for the demo shops' company kinds that the setup seed writes, which staging
// never seeds.
//   kinds       one row per trade file, as the kinds seed writes it: its id (the file's name), name, style, pattern and
//               facts, source trade_file (insurance, which lists no facts, takes cpa.json's: MC C5)
//   kind_flows  two rows per trade file, flows A and B, as the kinds seed writes them: money.<flow>'s main path and the
//               paths it lists, the switches on, and the settings with MC C5's start values
// It writes no picked_kinds or picked_kind_texts row, reads no demo shop and needs no setup seed (nor the core seed: no
// catalog row names a business or a person). The plan and the two inserts are the kinds seed's own (catalogPlanOf,
// insertCatalog), never a copy, so both sets write the same rows from the same trade files.
//
//   const result = await seedKindsCatalog(sql);   // result.tables.kinds: { rows: 243, inserted: 243, kept: 0 }
//
// In order, stopping at the first failure, as the kinds seed does for these two tables: opens the trade files' set,
// fixtures/master, inside fixtures/ only, and checks the whole set against its SHA256SUMS before any file is parsed
// (verifyTradeSet), so only bytes that were hashed are parsed; reads every trade file through T-133's loader and refuses,
// naming the file, any value it does not know how to read rather than guess; then, in one transaction as the job role
// rosie_job with no business scope (T-191; K-24 README rule 2: the catalog seed job writes kinds and kind_flows):
//   1. writes each row only when its key is free (ON CONFLICT DO NOTHING; nothing is ever updated or deleted);
//   2. reads back the catalog rows of every trade file's kind, FOR SHARE so none can change before the commit, and
//      refuses, naming each kind id with the table and columns, any row whose values differ from its trade file's: the
//      transaction rolls back, so nothing is written and that row stays as it was. Only the columns this set writes are
//      compared: version, which every update raises, is no trade file's value.
// Fixture set v1's demo shops, which the kinds seed checks for its picks, are not opened: nothing of them is read.
//
// Idempotent: a second run inserts 0 and keeps every row (243 kinds, 486 kind_flows), version included; a row that went
// missing is written again as the first run wrote it. Any other row of the two tables (a kind drafted as new work, id
// new-..., source new_work) is neither compared nor changed. Nothing is printed: the runner (T-201) prints the counts
// this returns.
//
// It runs only when named: `npm run seed:staging -- --set kinds-catalog` on staging (seed-staging.sh runs any
// db/seeds/<name>.ts as a set by its name), never in D-017's run; locally `node db/seeds/run.mjs --set kinds-catalog`.
import { SCOPE_SETTING, type Sql, type Tx } from "../repo/scope";
import { type CoreSeedTableCount, SEED_ROLE } from "./core";
import {
  catalogPlanOf,
  insertCatalog,
  type KindsCatalogRows,
  type KindsCatalogTable,
  openTradeSet,
  type SeededKind,
  verifyTradeSet,
} from "./kinds";
import type { FixtureSet } from "./lib/fixture-set";

/** How many kinds a refusal's message names; its `kindIds` holds every one. */
const KINDS_IN_MESSAGE = 10;

export interface KindsCatalogSeedResult {
  /** The database role that wrote the rows (current_user inside the seed's transaction). */
  readonly ranAs: string;
  /** The trade files' set, checked: its folder, the sha256 of SHA256SUMS and how many files it lists. */
  readonly tradeSet: {
    readonly dir: string;
    readonly sumsSha256: string;
    readonly filesChecked: number;
  };
  readonly tables: Readonly<Record<KindsCatalogTable, CoreSeedTableCount>>;
  /** One entry per kind, in code-point order of id: its trade file, and each value not from it (the kinds seed's). */
  readonly kinds: readonly SeededKind[];
}

export interface KindsCatalogSeedOptions {
  /** The trade files' set. Default fixtures/master. Anything outside the repository's fixtures/ folder is refused. */
  tradesDir?: string;
}

/** A catalog row as read back from the database, column by column. */
export type CatalogRowRead = Readonly<Record<string, unknown>>;

/** One kind whose catalog rows differ from its trade file. */
export interface CatalogDifference {
  readonly kindId: string;
  /** Each row that differs: its table (and flow) with the columns that differ, or "no row": "kind_flows B: cutoff". */
  readonly parts: readonly string[];
}

/** The set refused, writing nothing: a catalog row differs from its trade file. The message names each kind id. */
export class KindsCatalogSeedError extends Error {
  override readonly name = "KindsCatalogSeedError";
  /** Every kind whose rows differ, in code-point order of id. */
  readonly kindIds: readonly string[];

  constructor(differences: readonly CatalogDifference[]) {
    const shown = differences
      .slice(0, KINDS_IN_MESSAGE)
      .map((difference) => `${difference.kindId} (${difference.parts.join("; ")})`)
      .join(", ");
    const more =
      differences.length > KINDS_IN_MESSAGE
        ? ` (and ${String(differences.length - KINDS_IN_MESSAGE)} more)`
        : "";
    const kinds = differences.length === 1 ? "1 kind" : `${String(differences.length)} kinds`;
    super(
      `the kinds catalog seed refused, writing nothing: the catalog rows of ${kinds} differ from the trade files, ` +
        `and a catalog row is never changed here: ${shown}${more}`,
    );
    this.kindIds = differences.map((difference) => difference.kindId);
  }
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

/** Whether a value read back is the planned one: the same text, number or null, or a list of the same items in order. */
function sameValue(planned: unknown, read: unknown): boolean {
  if (isList(planned) || isList(read)) {
    return (
      isList(planned) &&
      isList(read) &&
      planned.length === read.length &&
      planned.every((item, index) => item === read[index])
    );
  }
  return planned === read;
}

/** What differs in one row: "<table>: <columns>" for the planned columns whose value differs, "<table>: no row", or null. */
function partOf(table: string, planned: object, read: CatalogRowRead | undefined): string | null {
  if (read === undefined) {
    return `${table}: no row`;
  }
  const columns = Object.entries(planned)
    .filter(([column, value]) => !sameValue(value, read[column]))
    .map(([column]) => column);
  return columns.length === 0 ? null : `${table}: ${columns.join(", ")}`;
}

/**
 * Compares the catalog rows read back with the rows planned from the trade files (pure): each kind whose kinds row or a
 * kind_flows row differs, in code-point order of id, its kinds row first, then its flows in the plan's order. Only the
 * columns the set writes are compared (version is no trade file's value), and a row read back that the plan does not
 * name is not looked at.
 */
export function catalogDifferences(
  rows: KindsCatalogRows,
  kinds: readonly CatalogRowRead[],
  flows: readonly CatalogRowRead[],
): CatalogDifference[] {
  const kindRead = new Map(kinds.map((row) => [String(row.id), row]));
  const flowRead = new Map(flows.map((row) => [`${String(row.kind_id)} ${String(row.flow)}`, row]));
  const partsOf = new Map<string, string[]>();
  const note = (kindId: string, part: string | null): void => {
    if (part !== null) {
      partsOf.set(kindId, [...(partsOf.get(kindId) ?? []), part]);
    }
  };
  for (const planned of rows.kinds) {
    note(planned.id, partOf("kinds", planned, kindRead.get(planned.id)));
  }
  for (const planned of rows.kind_flows) {
    const read = flowRead.get(`${planned.kind_id} ${planned.flow}`);
    note(planned.kind_id, partOf(`kind_flows ${planned.flow}`, planned, read));
  }
  return [...partsOf]
    .map(([kindId, parts]) => ({ kindId, parts }))
    .sort((a, b) => byCodePoint(a.kindId, b.kindId));
}

/**
 * Reads back the catalog rows of the planned kinds in `tx`, FOR SHARE (none can be changed or removed before the commit,
 * and one another transaction is changing is read as it commits), and refuses any that differs from the plan.
 */
async function refuseDifferingRows(tx: Tx, rows: KindsCatalogRows): Promise<void> {
  const ids = rows.kinds.map((row) => row.id);
  const kinds = await tx<CatalogRowRead[]>`select * from kinds where id = any(${ids}::text[]) for share`;
  const flows = await tx<CatalogRowRead[]>`
    select * from kind_flows where kind_id = any(${ids}::text[]) for share
  `;
  const differences = catalogDifferences(rows, kinds, flows);
  if (differences.length > 0) {
    throw new KindsCatalogSeedError(differences);
  }
}

/** Seeds K-24's catalog alone, kinds and kind_flows, from the trade files (see the top of this file). */
export async function seedKindsCatalog(
  sql: Sql,
  options: KindsCatalogSeedOptions = {},
): Promise<KindsCatalogSeedResult> {
  return seedKindsCatalogFrom(sql, openTradeSet(options.tradesDir));
}

/** The entry every seed set exports under one name, so a runner finds a set by its file name (T-201). */
export const seed = seedKindsCatalog;

/** seedKindsCatalog, from a trade files' set already opened (tests open temporary copies inside their own jails). */
export async function seedKindsCatalogFrom(sql: Sql, tradeSet: FixtureSet): Promise<KindsCatalogSeedResult> {
  const trades = verifyTradeSet(tradeSet);
  const plan = catalogPlanOf(trades);
  const { rows } = plan;

  const written = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${SEED_ROLE}`);
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    const [who] = await tx<{ role: string }[]>`select current_user as role`;
    const inserted = await insertCatalog(tx, rows);
    await refuseDifferingRows(tx, rows);
    return { ranAs: who?.role ?? "", inserted };
  });

  const count = (table: KindsCatalogTable): CoreSeedTableCount => {
    const total = rows[table].length;
    const inserted = written.inserted[table];
    return { rows: total, inserted, kept: total - inserted };
  };
  return {
    ranAs: written.ranAs,
    tradeSet: { dir: trades.dir, sumsSha256: trades.sumsSha256, filesChecked: trades.filesChecked },
    tables: { kinds: count("kinds"), kind_flows: count("kind_flows") },
    kinds: plan.kinds,
  };
}
