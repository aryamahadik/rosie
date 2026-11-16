// A row's name, as K-05 names a row by one rowId (T-667; K-05 v1.18 item 77; QUESTIONS.md CQ-349 (1); DL-911, DL-913).
//
// A row reference names a row by "the row's primary key as text" (K-05 v1 rowRef). A key of one column is that column's
// value. A key of two columns is item 77's name: the key's values as text, in the primary key's column order, joined by
// a slash: company_kinds as `company id/kind id` (company-lee-home-services/plumber), kind_flows as `kind id/flow`
// (plumber/B), flow_defaults as `business id/flow` (biz-lees-barbershop/A), and K-24's picked_kind_texts as
// `pick id/pf key` and new_work_draft_blocks as `draft id/block`. Every key column but the first of each holds no slash
// by its own CHECK (company_kinds_kind_id_form, kind_flows_flow_known, flow_defaults_flow_known,
// picked_kind_texts_key_known, new_work_draft_blocks_block_range), so no two rows share a name, whatever the first
// column holds.
//
// The database builds the name, and nobody parses it (CQ-09: an id is compared, never parsed): a read answers it from the
// row's own columns, and a compare tests the same expression against a rowId as a whole, never splitting the rowId. A
// table of two key columns that is not listed here, or whose later key column could hold a slash, has no name (item 77:
// such a table needs its own rule in a later version, open gap 85), so no call names its rows.
import type { Sql, Tx } from "../scope";

type Db = Sql | Tx;

/** The tables item 77 names, each with its primary key's two columns in key order. */
export const TWO_COLUMN_KEYS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  company_kinds: Object.freeze(["company_id", "kind_id"] as const),
  flow_defaults: Object.freeze(["business_id", "flow"] as const),
  kind_flows: Object.freeze(["kind_id", "flow"] as const),
  new_work_draft_blocks: Object.freeze(["draft_id", "block"] as const),
  picked_kind_texts: Object.freeze(["picked_kind_id", "pf_key"] as const),
});

/** The two key columns item 77 gives `table`, or null when it names no table of two key columns. */
export function twoColumnKeyOf(table: string): readonly [string, string] | null {
  return Object.hasOwn(TWO_COLUMN_KEYS, table) ? (TWO_COLUMN_KEYS[table] ?? null) : null;
}

/**
 * Whether a primary key read from the catalog (`key`, in key order) is the one item 77 names for `table`: a key of one
 * column always is (its value is its name); a key of two columns only for a listed table, column for column.
 */
export function isNamedKey(table: string, key: readonly string[]): boolean {
  if (key.length === 1) {
    return true;
  }
  const named = twoColumnKeyOf(table);
  return named !== null && key.length === 2 && key[0] === named[0] && key[1] === named[1];
}

/**
 * The SQL expression of a row's name for the key `key` (its columns in key order): the one column as it is, or the two
 * columns as text joined by "/". The caller has checked the key with isNamedKey; every name in it is a catalog's or a
 * fixed list's, never a request's words.
 */
export function rowNameSql(db: Db, key: readonly string[]) {
  const [first, second, ...more] = key;
  if (first === undefined || more.length > 0) {
    throw new Error("rowNameSql: a row's name is built from one or two key columns");
  }
  if (second === undefined) {
    return db`${db(first)}`;
  }
  return db`(${db(first)}::text || '/' || ${db(second)}::text)`;
}
