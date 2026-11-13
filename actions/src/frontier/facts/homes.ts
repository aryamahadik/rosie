// The facts' homes (T-295; C-075; arch 02 line 117: "the facts they need, each fact once, from its one home (S13-30)").
// Each key the frontier gives decide as a fact has one home: the K-02 v1 home that holds it (money, contact, proof,
// stop, clock, who, safety, change, record or two: contracts/bundle homes) and the one row and column its value is read
// from. K-05 v1.2 factRef: "Which home a key has is the frontier's and the bundle's (C-075), never this call's", so the
// list is the frontier's own data, checked when it is made:
//   - each key is listed once: a second home for one key is refused (S13-30: "each rule has one home");
//   - a key is a K-02 v1 fact name (^[a-z][a-z0-9_.]*$);
//   - never a person's name or contact: decide is given no other person's name or contact (T-295's lead note; the
//     writer's own are in the context's writer, and C-114 leaves the handle out of the prompt), so the K-04 v1 columns
//     that hold one are refused;
//   - never what K-05 v1.2 refuses as a fact: a column of sealing_keys or of a table only Rosie's team reads (factTable),
//     or a secret's hash (secretColumn).
//
// The default list is empty (NO_FACT_HOMES): no frozen source names the column a needs key lives in yet (02-contracts
// section 8 proposes each key's contract, not its column, under Q-33's default; K-02 v1's context-s1-02.json gives
// S1-02, which needs `thread`, no fact). So until the new question on frontier reads names them, the frontier gives
// decide no fact rather than a value from a guessed column (fail closed).

import type * as K02 from "../../../../contracts/generated/model/model.v1";

/** A K-02 v1 home (contracts/bundle homes: money S13-55, contact S13-19, ... two A9-21). */
export type HomeKind = K02.Fact["home"];

/** Which row of its table a home is for one turn: the call's business, the turn's target booking, or one named row. */
export type HomeRow =
  { readonly of: "business" } | { readonly of: "booking" } | { readonly of: "row"; readonly rowId: string };

/** One key's one home. */
export interface FactHome {
  /** The key, as K-02 v1 names a fact: a needs key, a record value or a named slot. */
  readonly name: string;
  /** The K-02 v1 home that holds it. */
  readonly home: HomeKind;
  /** The table and column its value is read from (K-05 v1.2 factRef). */
  readonly table: string;
  readonly column: string;
  readonly row: HomeRow;
}

/** The homes, each key once: made only by factHomes(), which checks them. */
export interface FactHomes {
  readonly kind: "factHomes";
  readonly size: number;
  get(name: string): FactHome | undefined;
}

/** A list of homes the frontier cannot use: it is the builder's fault, found when the list is made. */
export class FactHomeError extends Error {
  override name = "FactHomeError";
}

/** K-02 v1 fact.name. */
const FACT_NAME = /^[a-z][a-z0-9_.]*$/u;
/** K-05 v1.2 tableName and columnName. */
const SQL_NAME = /^[a-z_][a-z0-9_]*$/u;

const HOME_KINDS: ReadonlySet<string> = new Set<HomeKind>([
  "money",
  "contact",
  "proof",
  "stop",
  "clock",
  "who",
  "safety",
  "change",
  "record",
  "two",
]);

/** K-05 v1.2 factTable: sealing_keys and the tables only Rosie's team reads are never facts. */
const NEVER_TABLES: ReadonlySet<string> = new Set([
  "sealing_keys",
  "harm_reports",
  "team_pages",
  "team_page_recipients",
  "parked_turns",
  "dead_letters",
  "gap_cases",
  "review_items",
  "live_turn_labels",
]);

/**
 * Columns that are never a fact of decide's context, as `table.column`: K-05 v1.2 secretColumn (a secret's hash), and
 * the K-04 v1 columns holding a person's name or contact (persons.name; a worker resource's name, which is its
 * person's; a handle's address; a phone's number; an email thread's reply address; a paused phone or address; the
 * phone a saved time is held for).
 */
const NEVER_COLUMNS: ReadonlySet<string> = new Set([
  "proof_codes.code_hash",
  "sessions.token_sha256",
  "sessions.device_sha256",
  "persons.name",
  "resources.name",
  "handles.address",
  "phones.number",
  "threads.reply_address",
  "pauses.phone_number",
  "pauses.address",
  "reservations.for_phone_number",
]);

function checked(home: FactHome): FactHome {
  const where = `the fact ${JSON.stringify(home.name)}`;
  if (!FACT_NAME.test(home.name)) throw new FactHomeError(`${where} is not a K-02 v1 fact name`);
  if (!HOME_KINDS.has(home.home)) throw new FactHomeError(`${where} names no K-02 v1 home`);
  if (!SQL_NAME.test(home.table) || !SQL_NAME.test(home.column)) {
    throw new FactHomeError(`${where} names no table and column`);
  }
  if (NEVER_TABLES.has(home.table) || NEVER_COLUMNS.has(`${home.table}.${home.column}`)) {
    throw new FactHomeError(`${where} is read from a column that is never a fact of decide's context`);
  }
  if (home.row.of === "row" && home.row.rowId === "") throw new FactHomeError(`${where} names no row`);
  const row: HomeRow = home.row.of === "row" ? { of: "row", rowId: home.row.rowId } : { of: home.row.of };
  return Object.freeze({ name: home.name, home: home.home, table: home.table, column: home.column, row });
}

/** The homes, checked: each key once, a fact name, never a person's name or contact, never what K-05 refuses. */
export function factHomes(list: readonly FactHome[]): FactHomes {
  const byName = new Map<string, FactHome>();
  for (const home of list) {
    if (byName.has(home.name)) {
      throw new FactHomeError(
        `the fact ${JSON.stringify(home.name)} has a second home: each fact has one (S13-30)`,
      );
    }
    byName.set(home.name, checked(home));
  }
  return Object.freeze({
    kind: "factHomes" as const,
    size: byName.size,
    get: (name: string) => byName.get(name),
  });
}

/** No home listed: the default until the new question on frontier reads names the homes (see above). */
export const NO_FACT_HOMES: FactHomes = factHomes([]);

/** The turn's target, as a home's row is found for it: the call's business and the target booking, if any. */
export interface FactTarget {
  readonly businessId: string;
  readonly bookingId: string | null;
}

/** The home's row for the turn's target, or null when the target holds none (no booking for a booking's home). */
export function homeRowId(row: HomeRow, target: FactTarget): string | null {
  switch (row.of) {
    case "business":
      return target.businessId;
    case "booking":
      return target.bookingId;
    case "row":
      return row.rowId;
  }
}
