// T-722: the money part (K-32 v1), part 1: saved_cards, payments, payment_items, ledger_lines and refunds, with README
// rules 1 to 9 as they bear on those five, against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/repo/money`). The schema comes from migrating a fresh test schema, so every migration
// runs in order and this part's (0030) last: after K-07's effects (0015), T-1094's narrowing (0018) and K-30's parts.
//
// The test's connection is the migrations' role, which owns the tables and is not bound by row-level security. A check
// made as the Tool API (rosie_app, K-05 scope business: C-101's calls, the pages' and the console's) or the runtime side
// (rosie_job: K-05's commit, the effect results and provider events, reconciliation) runs in its own transaction under
// SET LOCAL ROLE, scoped by withBusiness() as a call is scoped, and is rolled back. Seed fixtures are loaded as the
// runtime side with no scope (K-04's fixture format), and committed.
//
// Rule 5's effect_id and save_effect_id checks read effects as the Tool API, so 0030 grants rosie_app SELECT of
// effects.id and effects.business_id alone (DL-298, ruling round 1's NEED); the ruling's five tests are in "rule 5 with
// DL-298's grant" below, with the round 1 refusal shown again in a rolled-back transaction that revokes the grant.
//
// The rows come only from fixtures (rule 9): the card's two K-32 v1 seeds and two refused rows, and the K-04, K-07,
// K-23, K-24 and K-25 rows their after chains name (Lee's Barbershop, the yoga studio and the master's sample cast:
// Sam, Alex M., Riley). A row made here is a fixture row under a new id, or with one fault; its Stripe ids are
// placeholders in K-14's demo form, never a real card.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Sql, type Tx, withBusiness } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const PART_DIR = new URL("../../contracts/db-schema/money/", import.meta.url);
const FIXTURES_DIR = new URL("fixtures/", PART_DIR);
const TOOL_API = "rosie_app";
const RUNTIME = "rosie_job";
type Role = typeof TOOL_API | typeof RUNTIME;
const ROLES: readonly Role[] = [TOOL_API, RUNTIME];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
/**
 * Part 1's five tables, in code-unit order (as PostgreSQL orders a relation's name): the card's payments, refunds and
 * ledger, with saved_cards and payment_items, which rule 1's order and the card's two seeds need first (DL-298).
 */
const OWN_TABLES = ["ledger_lines", "payment_items", "payments", "refunds", "saved_cards"];
/** K-32's other nine tables, part 2's (T-723), in code-unit order. */
const PART_2_TABLES = [
  "booking_fees",
  "credits",
  "memberships",
  "packs",
  "pay_links",
  "plan_charges",
  "reconciliation_findings",
  "reconciliation_runs",
  "rosfield_fees",
];
/** The three of the five that are versioned (rule 4). */
const VERSIONED = ["payments", "refunds", "saved_cards"];
/** The two only ever inserted (rule 4; rule 6: no update grant). */
const INSERT_ONLY = ["ledger_lines", "payment_items"];
/** Rule 6's UPDATE of named columns only, by table, in the README's order: the same for both roles. */
const COLUMN_UPDATES: Record<string, readonly string[]> = {
  saved_cards: [
    "stripe_customer_id",
    "stripe_payment_method_id",
    "saved_at",
    "replaced_at",
    "removed_at",
    "removed_why",
    "version",
  ],
  payments: ["state", "paid_at", "failed_at", "failed_why", "cancelled_at", "version"],
  refunds: ["state", "refunded_at", "failed_at", "marked_done_by_person_id", "version"],
};
/** Rule 7's set-once lists for part 1's three, in the README's order. */
const SET_ONCE: Record<string, readonly string[]> = {
  saved_cards: [
    "stripe_customer_id",
    "stripe_payment_method_id",
    "saved_at",
    "replaced_at",
    "removed_at",
    "removed_why",
  ],
  payments: ["paid_at", "failed_at", "failed_why", "cancelled_at"],
  refunds: ["refunded_at", "failed_at", "marked_done_by_person_id"],
};
/** Rule 5's cross-part columns, in its order, each with the table its check reads. */
const RULE_5_COLUMNS: readonly (readonly [string, string])[] = [
  ["booking_id", "bookings"],
  ["booking_line_id", "booking_lines"],
  ["visit_id", "booking_visits"],
  ["effect_id", "effects"],
  ["save_effect_id", "effects"],
  ["open_question_id", "open_questions"],
  ["reminder_outbox_row_id", "outbox_rows"],
  ["terms_consent_id", "consents"],
];
/** The other tables rule 5's checks read on K-32 (DL-298's round 2 check), whole tables, in code-unit order. */
const RULE_5_READS = ["booking_lines", "booking_visits", "bookings", "consents", "open_questions"];
/** The Tool API policies each of the five holds, by the command its grants allow (rule 5; rule 6). */
const TOOL_API_COMMANDS: Record<string, readonly string[]> = {
  ledger_lines: ["select"],
  payment_items: ["insert", "select"],
  payments: ["insert", "select", "update"],
  refunds: ["insert", "select", "update"],
  saved_cards: ["insert", "select", "update"],
};
/** The keys of part 1's tables that name part 2's tables: part 2 adds them (DL-278's way; DL-298). */
const PART_2_KEYS = ["payments_booking_fee_fk", "payments_plan_charge_fk", "saved_cards_membership_fk"];
/** The two keys rule 1 names in a circle, added by ALTER TABLE once both tables exist. */
const CIRCLE_KEYS = ["ledger_lines_refund_fk", "saved_cards_from_payment_fk"];
/**
 * The other tables the five refer to by their keys (rule 1), in code-unit order: other parts', and part 2's
 * booking_fees, memberships and plan_charges, which PART_2_KEYS name (migration 0031, T-723; DL-225, DL-306).
 */
const REFERRED = [
  "booking_fees",
  "booking_lines",
  "bookings",
  "businesses",
  "effects",
  "memberships",
  "open_questions",
  "persons",
  "plan_charges",
];
const DEPOSIT_SEED = "seed-payment-deposit.json";
const REFUND_SEED = "seed-refund-new-line.json";
/** The card's two seeds. */
const CARD_SEEDS = [DEPOSIT_SEED, REFUND_SEED];
/** The card's two refused rows. */
const LEDGER_UPDATE = "invalid/refuse-ledger-update.json";
const HOLD_PAYMENT = "invalid/refuse-hold-payment.json";
/** K-26's closed registries, written only by migration 0023's own seed (K-26 README rule 5). */
const REGISTRIES = ["plugin_switches", "rule_kinds", "trade_facts"];
const BARBERSHOP = "biz-lees-barbershop";
const YOGA_STUDIO = "biz-yoga-studio";
const RILEY = "person-riley";
const SLOW = { timeout: 120_000 };

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Values = Record<string, Json>;

interface ContractTable {
  name: string;
  columns: { name: string; type: string; null: boolean; default?: string }[];
  primaryKey: string[];
  foreignKeys: {
    name: string;
    columns: string[];
    references: { table: string; columns: string[] };
    onDelete: string;
  }[];
  unique?: { name: string; columns: string[]; where?: string }[];
  checks?: { name: string; expression: string }[];
  indexes?: { name: string; columns: string[]; using?: string; where?: string }[];
  rowLevelSecurity: { scope: string; column?: string };
  versioned: boolean;
  versionColumn?: string;
  effectiveDates: boolean;
}

interface FixtureRow {
  table: string;
  values: Values;
}

interface Refused {
  role: string;
  scope: { businessId: string } | null;
  action: string;
  table: string;
  values?: Values;
  set?: Values;
  where?: Values;
  expect: { sqlstate?: string; constraintOneOf?: string[]; rows?: number };
}

interface FixtureFile {
  after: string[];
  rows: FixtureRow[];
  refused?: Refused;
}

interface IndexEntry {
  file: string;
  version: string;
  table: string;
  expect: string;
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));

const TABLES = (readJson(new URL("money.v1.tables.json", PART_DIR)) as { tables: ContractTable[] }).tables;
/** Part 1's tables as the table list gives them, in its order. */
const OWN = TABLES.filter((table) => OWN_TABLES.includes(table.name));
const INDEX = (readJson(new URL("index.json", FIXTURES_DIR)) as { fixtures: IndexEntry[] }).fixtures;
/** The frozen README, whose rules 5 to 7 this part holds word for word. */
const README = readFileSync(new URL("README.md", PART_DIR), "utf8");
/** Rule 7's set-once function as the README writes it: the text T-041's check used. */
const README_FUNCTION = /The function, which T-041's check used: `([^`]+)`/.exec(README)?.[1] ?? "";

function tableOf(name: string): ContractTable {
  const table = TABLES.find((candidate) => candidate.name === name);
  if (table === undefined) {
    throw new Error(`K-32 v1 lists no table ${name}`);
  }
  return table;
}

/** A table's column names, in the table list's order. */
const columnsOf = (name: string): string[] => tableOf(name).columns.map((column) => column.name);

/** Rule 7's list for `table`, as the README's bullet for it names the columns. */
function readmeSetOnce(table: string): string[] {
  const line = README.split("\n").find((candidate) => candidate.trimStart().startsWith(`- \`${table}\`: `));
  return [...(line ?? "").matchAll(/`([a-z_]+)`/g)].map((match) => match[1] ?? "").slice(1);
}

/**
 * Rule 5's WITH CHECK for `table` as the README writes it, on the table named `on` (the real one, or a probe copy): the
 * business scope, then each cross-part column the table carries in rule 5's order, then, on payments, the paid check.
 */
function readmeCheck(table: string, on: string): string {
  const crossPart = RULE_5_COLUMNS.filter(([column]) => columnsOf(table).includes(column)).map(
    ([column, referenced]) =>
      `(${column} is null or exists (select 1 from ${referenced} r where r.id = ${on}.${column} and r.business_id = ${on}.business_id))`,
  );
  const paid = table === "payments" ? [`(${on}.method in ('cash', 'own_way') or ${on}.state <> 'paid')`] : [];
  return [`business_id = nullif(current_setting('rosie.business_id', true), '')`, ...crossPart, ...paid].join(
    " and ",
  );
}

const fixtureFile = (file: string): FixtureFile => readJson(new URL(file, FIXTURES_DIR)) as FixtureFile;

/** The values of a fixture's own row of `table` whose id is `id`. */
function valuesOf(file: string, table: string, id: string): Values {
  const row = fixtureFile(file).rows.find(
    (candidate) => candidate.table === table && candidate.values.id === id,
  );
  if (row === undefined) {
    throw new Error(`${file} has no ${table} row with id ${id}`);
  }
  return row.values;
}

function refusedOf(file: string): Refused {
  const refused = fixtureFile(file).refused;
  if (refused === undefined) {
    throw new Error(`${file} has no refused action`);
  }
  return refused;
}

/** The role a refused fixture names: toolApi is rosie_app, runtime is rosie_job (K-04's fixture format). */
function roleOf(refused: Refused): Role {
  if (refused.role === "toolApi") {
    return TOOL_API;
  }
  if (refused.role === "runtime") {
    return RUNTIME;
  }
  throw new Error(`a refused fixture names an unknown role ${refused.role}`);
}

/** The fixtures/ folder a fixture file sits in: a refused fixture sits in fixtures/invalid/. */
function fixturesFolderOf(file: URL): URL {
  const folder = new URL(".", file);
  return folder.href.endsWith("/invalid/") ? new URL("..", folder) : folder;
}

/**
 * A fixture's rows, after those of every fixture its `after` names (each path relative to the fixtures/ folder of the
 * file that names it, so K-32's seeds name K-04's as ../../core/fixtures/<file>), each file once.
 */
function fixtureRows(file: URL, seen: Set<string>): FixtureRow[] {
  if (seen.has(file.href)) {
    return [];
  }
  seen.add(file.href);
  const fixture = readJson(file) as FixtureFile;
  const folder = fixturesFolderOf(file);
  return [...fixture.after.flatMap((before) => fixtureRows(new URL(before, folder), seen)), ...fixture.rows];
}

/** The rows a load of `files` reads, each file once with every `after` chain, in load order. */
function rowsOf(files: readonly string[]): FixtureRow[] {
  const seen = new Set<string>();
  return files.flatMap((file) => fixtureRows(new URL(file, FIXTURES_DIR), seen));
}

/** Rows per table, of the tables in `tables` only. */
function countsOf(rows: readonly FixtureRow[], tables: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows.filter((candidate) => tables.includes(candidate.table))) {
    counts[row.table] = (counts[row.table] ?? 0) + 1;
  }
  return counts;
}

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** A fixture value that must be text. */
function textOf(value: Json | undefined): string {
  if (typeof value !== "string") {
    throw new Error(`expected text, found ${JSON.stringify(value)}`);
  }
  return value;
}

/** Collapses each run of white space to one space, as PostgreSQL's printed expressions break lines. */
const oneLine = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();

/** Text with no white space at all, to compare a function body with the README's one-line copy of it. */
const squeezed = (text: string): string => text.replace(/\s+/g, "");

/** Three digits, from 1. */
const pad = (i: number): string => String(i + 1).padStart(3, "0");

/** Seeded rows: Alex's $40 deposit, its card, item, line and effects; his $55 cut paid in full and its $20 refund. */
const DEPOSIT_PAYMENT = valuesOf(DEPOSIT_SEED, "payments", "pay-alex-grooms-deposit");
const DEPOSIT_EFFECT = valuesOf(DEPOSIT_SEED, "effects", "eff-alex-grooms-deposit");
const DEPOSIT_ITEM = valuesOf(DEPOSIT_SEED, "payment_items", "item-alex-grooms-deposit-1");
const DEPOSIT_LINE = valuesOf(DEPOSIT_SEED, "ledger_lines", "ledger-alex-grooms-deposit");
const SAVED_CARD = valuesOf(DEPOSIT_SEED, "saved_cards", "card-alex-grooms-package");
const SAVE_EFFECT = valuesOf(DEPOSIT_SEED, "effects", "eff-alex-grooms-save-card");
const FULL_PAYMENT = valuesOf(REFUND_SEED, "payments", "pay-alex-signature-cut-full");
const REFUND = valuesOf(REFUND_SEED, "refunds", "refund-alex-signature-cut-part");
const REFUND_EFFECT = valuesOf(REFUND_SEED, "effects", "eff-alex-signature-cut-part-refund");
const REFUND_LINE = valuesOf(REFUND_SEED, "ledger_lines", "ledger-alex-signature-cut-part-refund");
const DEPOSIT = textOf(DEPOSIT_PAYMENT.id);
const GROOMS = textOf(DEPOSIT_PAYMENT.booking_id);
/** One seeded row of each of the five, by table. */
const SEEDED_ROW: Record<string, string> = {
  ledger_lines: textOf(DEPOSIT_LINE.id),
  payment_items: textOf(DEPOSIT_ITEM.id),
  payments: DEPOSIT,
  refunds: textOf(REFUND.id),
  saved_cards: textOf(SAVED_CARD.id),
};

/** An effect the commit writes pending, before the runner tries it: a fixture effect under a new id and key. */
function pendingEffect(base: Values, id: string, changes: Values = {}): Values {
  return {
    ...base,
    id,
    idempotency_key: id,
    state: "pending",
    tries: 0,
    first_try_at: null,
    last_try_at: null,
    provider_object_id: null,
    ledger_line_id: null,
    version: 1,
    ...changes,
  };
}

const LEES_ACCOUNT = { kind: "business", accountId: "stripe-acct-demo-lees-barbershop" };
const YOGA_ACCOUNT = { kind: "business", accountId: "stripe-acct-demo-yoga-studio" };
const REST_EFFECT_ID = "eff-probe-alex-grooms-rest";
/** The $100 rest of Alex's Groom's package on his saved card, after the visit: the commit's charge effect. */
const REST_EFFECT = pendingEffect(DEPOSIT_EFFECT, REST_EFFECT_ID, {
  amount_cents: 10000,
  port_request: {
    account: LEES_ACCOUNT,
    purpose: "rest",
    customerId: "stripe-customer-demo-alex",
    paymentMethodId: "stripe-card-demo-alex",
    customerPresent: false,
    description: "Lee's Barbershop: the rest of the Groom's package",
  },
});
/** Its payment, written pending in the same commit; only the effect's result makes it paid (rule 5). */
const REST_PAYMENT: Values = {
  ...DEPOSIT_PAYMENT,
  id: "pay-probe-alex-grooms-rest",
  purpose: "rest",
  amount_cents: 10000,
  state: "pending",
  effect_id: REST_EFFECT_ID,
  asked_at: "2026-11-07T18:00:00Z",
  paid_at: null,
  version: 1,
};
/** The same rest paid in cash at the counter and recorded by Riley (A9-08): no effect, no card, recorded paid. */
const CASH_REST: Values = {
  ...REST_PAYMENT,
  id: "pay-probe-alex-grooms-rest-cash",
  method: "cash",
  effect_id: null,
  saved_card_id: null,
  recorded_by_person_id: RILEY,
  state: "paid",
  paid_at: "2026-11-07T18:05:00Z",
};
const YOGA_EFFECT_ID = "eff-probe-yoga-pack";
/** The yoga studio's $160 pack charged on its page, with no booking: another business's charge effect. */
const YOGA_EFFECT = pendingEffect(DEPOSIT_EFFECT, YOGA_EFFECT_ID, {
  business_id: YOGA_STUDIO,
  booking_id: null,
  amount_cents: 16000,
  port_request: {
    account: YOGA_ACCOUNT,
    purpose: "pack",
    customerId: "stripe-customer-demo-alex-yoga",
    paymentMethodId: "stripe-card-demo-alex-yoga",
    customerPresent: true,
    description: "Yoga studio: pack of 5 visits",
  },
});
/** Its payment, pending, of purpose pack with no booking. */
const YOGA_PAYMENT: Values = {
  ...REST_PAYMENT,
  id: "pay-probe-yoga-pack",
  business_id: YOGA_STUDIO,
  booking_id: null,
  purpose: "pack",
  amount_cents: 16000,
  saved_card_id: null,
  effect_id: YOGA_EFFECT_ID,
};
const SAVE_EFFECT_2_ID = "eff-probe-alex-grooms-save-card-2";
/** A second card save for the Groom's package, written before Stripe names a customer (README default 22). */
const SAVE_EFFECT_2 = pendingEffect(SAVE_EFFECT, SAVE_EFFECT_2_ID, {
  port_request: { account: LEES_ACCOUNT, customerId: null },
});
/** Its row at the commit: no customer id, no payment method, not yet saved. */
const FIRST_SAVE: Values = {
  ...SAVED_CARD,
  id: "card-probe-alex-grooms-2",
  stripe_customer_id: null,
  stripe_payment_method_id: null,
  save_effect_id: SAVE_EFFECT_2_ID,
  asked_at: "2026-11-07T18:10:00Z",
  saved_at: null,
  version: 1,
};
/** The yoga studio's card save effect: another business's. */
const YOGA_SAVE_EFFECT = pendingEffect(SAVE_EFFECT, "eff-probe-yoga-save-card", {
  business_id: YOGA_STUDIO,
  booking_id: null,
  port_request: { account: YOGA_ACCOUNT, customerId: null },
});
const REFUND_EFFECT_2_ID = "eff-probe-alex-signature-cut-refund-2";
/** A second part refund of the Signature cut, $10 on Sam's word, from its own stripe_refund effect. */
const REFUND_EFFECT_2 = pendingEffect(REFUND_EFFECT, REFUND_EFFECT_2_ID, { amount_cents: 1000 });
/** Its refund, written pending. */
const REFUND_2: Values = {
  ...REFUND,
  id: "refund-probe-alex-signature-cut-2",
  amount_cents: 1000,
  effect_id: REFUND_EFFECT_2_ID,
  state: "pending",
  refunded_at: null,
  version: 1,
};
/** The yoga studio's refund effect: another business's. */
const YOGA_REFUND_EFFECT = pendingEffect(REFUND_EFFECT, "eff-probe-yoga-refund", {
  business_id: YOGA_STUDIO,
  booking_id: null,
  amount_cents: 1000,
});

/** Thrown to roll a check's transaction back with its answer. */
class RolledBack extends Error {
  constructor(readonly answer: unknown) {
    super("rolled back on purpose");
  }
}

let db: TestDatabase;
/** The type of each column of the schema's tables, keyed table.column, as format_type prints it. */
const typeOf = new Map<string, string>();
/** PostgreSQL's keywords that it quotes as a column name (all but the unreserved ones). */
const QUOTED = new Set<string>();
/** A column name as pg_get_constraintdef prints it. */
const ident = (name: string): string => (QUOTED.has(name) ? `"${name}"` : name);

/** Runs `fn` in one transaction as `role`, scoped to `businessId` (null: no scope), then rolls it back. */
async function as<T>(role: Role, businessId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const run = async (tx: Tx): Promise<never> => {
    await tx.unsafe(`set local role ${role}`);
    throw new RolledBack(await fn(tx));
  };
  try {
    if (businessId === null) {
      await db.sql.begin(run);
    } else {
      await withBusiness(db.sql, businessId, run);
    }
  } catch (error) {
    if (error instanceof RolledBack) {
      return error.answer as T;
    }
    throw error;
  }
  throw new Error("the check's transaction was not rolled back");
}

/** Runs `fn` in one transaction as the tables' owner (the migrations' role), then rolls it back. */
async function asOwner<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    await db.sql.begin(async (tx) => {
      throw new RolledBack(await fn(tx));
    });
  } catch (error) {
    if (error instanceof RolledBack) {
      return error.answer as T;
    }
    throw error;
  }
  throw new Error("the check's transaction was not rolled back");
}

/** Runs `fn` in one transaction as `role` with no scope, and commits it. */
async function committedAs<T>(role: Role, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const result = await db.sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${role}`);
    return fn(tx);
  });
  return result as T;
}

interface Refusal {
  code: string | undefined;
  constraint: string | undefined;
  message: string;
}

/** The SQLSTATE, constraint and message of a refused statement. */
async function refusal(promise: Promise<unknown>): Promise<Refusal> {
  try {
    await promise;
  } catch (error) {
    const failure = error as { code?: string; constraint_name?: string; message?: string };
    return { code: failure.code, constraint: failure.constraint_name, message: failure.message ?? "" };
  }
  throw new Error("the statement was accepted; the database should have refused it");
}

/** A row's values as the database takes them: JSON for a jsonb column, bytes for a bytea one (`\x` and hex). */
function columnValues(sql: Sql | Tx, table: string, values: Values): Record<string, never> {
  const converted: Record<string, never> = {};
  for (const [column, value] of Object.entries(values)) {
    const type = typeOf.get(`${table}.${column}`);
    let out: unknown = value;
    if (type === "jsonb" && value !== null) {
      out = sql.json(value);
    } else if (type === "bytea" && typeof value === "string") {
      out = fromHex(value.replace(/^\\x/, ""));
    }
    converted[column] = out as never;
  }
  return converted;
}

async function insertRow(sql: Sql | Tx, table: string, values: Values): Promise<void> {
  await sql`insert into ${sql(table)} ${sql(columnValues(sql, table, values))}`;
}

/** Inserts one row and gives it back as stored. */
async function insertReturning(tx: Tx, table: string, values: Values): Promise<Record<string, unknown>[]> {
  return tx<Record<string, unknown>[]>`
    insert into ${tx(table)} ${tx(columnValues(tx, table, values))} returning *
  `;
}

/** `column = value and ...` for each column of `where` (text, or a number). */
function whereOf(sql: Sql | Tx, where: Values) {
  const conditions = Object.entries(where).map(([column, value]) => {
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`a where value is text or a number, found ${JSON.stringify(value)}`);
    }
    return sql`${sql(column)} = ${value}`;
  });
  return conditions.reduce((all, one) => sql`${all} and ${one}`);
}

/** Updates the rows of `table` that `where` names, setting `set` exactly. */
function updateWhere(table: string, where: Values, set: Values): (tx: Tx) => Promise<unknown> {
  return (tx) => tx`update ${tx(table)} set ${tx(columnValues(tx, table, set))} where ${whereOf(tx, where)}`;
}

/**
 * Empties every table the fixtures write: truncating the heads, and K-24's kinds (which fixtures write and no head
 * names), cascades to the rest, the five and effects included (this file's schema only). K-26's registries stay.
 */
async function reset(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags, kinds cascade`;
}

/** The one row of `table` whose every column the fixture gives holds the given value, compared in the column's type. */
async function expectFound(row: FixtureRow): Promise<void> {
  const columns = Object.keys(row.values);
  const typeIn = (column: string): string => typeOf.get(`${row.table}.${column}`) ?? "";
  const matched = columns.map(
    (column, i) => `("${column}")::text is not distinct from ($${String(i + 1)}::${typeIn(column)})::text`,
  );
  const given = columnValues(db.sql, row.table, row.values);
  const [found] = await db.sql.unsafe<{ n: number }[]>(
    `select count(*)::int as n from "${row.table}" where ${matched.join(" and ")}`,
    columns.map((column) => given[column] as never),
  );
  expect(found?.n, `${row.table} ${JSON.stringify(row.values)}`).toBe(1);
}

/**
 * Loads fixture files with their `after` chains, each file once, as the runtime side, and commits. A row of K-26's
 * registries is never inserted (only a migration's seed writes one): it is found as the migration wrote it. Gives the
 * rows inserted, per table.
 */
async function loadFixtures(files: readonly string[]): Promise<Record<string, number>> {
  const rows = rowsOf(files);
  for (const row of rows.filter((candidate) => REGISTRIES.includes(candidate.table))) {
    await expectFound(row);
  }
  return committedAs(RUNTIME, async (tx) => {
    const loaded: Record<string, number> = {};
    for (const row of rows.filter((candidate) => !REGISTRIES.includes(candidate.table))) {
      await insertRow(tx, row.table, row.values);
      loaded[row.table] = (loaded[row.table] ?? 0) + 1;
    }
    return loaded;
  });
}

/**
 * Every column the fixture gives is stored as given, read back as the owner by the row's id (the primary key of the
 * five and of effects) and compared on the server in the column's own type.
 */
async function expectStored(row: FixtureRow): Promise<void> {
  const columns = Object.keys(row.values);
  const typeIn = (column: string): string => typeOf.get(`${row.table}.${column}`) ?? "";
  const compared = columns.map(
    (column, i) =>
      `("${column}")::text is not distinct from ($${String(i + 1)}::${typeIn(column)})::text as "${column}"`,
  );
  const given = columnValues(db.sql, row.table, row.values);
  const found = await db.sql.unsafe<Record<string, boolean>[]>(
    `select ${compared.join(", ")} from "${row.table}" where id = $${String(columns.length + 1)}`,
    [...columns.map((column) => given[column] as never), textOf(row.values.id)],
  );
  const label = `${row.table} ${textOf(row.values.id)}`;
  expect(found, label).toHaveLength(1);
  expect(found[0], label).toEqual(Object.fromEntries(columns.map((column) => [column, true])));
}

async function countRows(sql: Sql | Tx, table: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
  return row?.n ?? -1;
}

/** Rows each of `tables` shows the caller, by table. */
async function rowsIn(sql: Sql | Tx, tables: readonly string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] = await countRows(sql, table);
  }
  return counts;
}

/**
 * A table's checks and indexes as PostgreSQL prints them, by name; an index without its own name and table, but with
 * UNIQUE kept, so a partial unique index is compared as one.
 */
async function definitionsOf(
  sql: Sql | Tx,
  table: string,
): Promise<{ checks: Record<string, string>; indexes: Record<string, string> }> {
  const checks = await sql<{ name: string; definition: string }[]>`
    select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
    where conrelid = ${table}::regclass and contype = 'c'
  `;
  const indexes = await sql<{ name: string; definition: string }[]>`
    select c.relname as name, pg_get_indexdef(i.indexrelid) as definition
    from pg_index i join pg_class c on c.oid = i.indexrelid
    where i.indrelid = ${table}::regclass and not i.indisprimary
  `;
  return {
    checks: Object.fromEntries(checks.map((row) => [row.name, row.definition])),
    indexes: Object.fromEntries(
      indexes.map((row) => [row.name, row.definition.replace(/^CREATE (UNIQUE )?INDEX \S+ ON \S+ /, "$1")]),
    ),
  };
}

/**
 * Rule 5's WITH CHECK for `table` as PostgreSQL prints the README's words: the README's expression made a policy on a
 * copy of the table (in a rolled-back transaction), printed, with the copy's name read back as the table's.
 */
async function readmeCheckAsPrinted(table: string): Promise<string> {
  const probe = `probe_${table}`;
  return asOwner(async (tx) => {
    await tx.unsafe(`create table ${probe} (like ${table})`);
    await tx.unsafe(
      `create policy ${probe}_check on ${probe} for insert with check (${readmeCheck(table, probe)})`,
    );
    const [policy] = await tx<{ check: string | null }[]>`
      select with_check as check from pg_policies where schemaname = ${db.schema} and tablename = ${probe}
    `;
    return oneLine(policy?.check).replaceAll(`${probe}.`, `${table}.`);
  });
}

/** The columns of a table in the schema, in their order (for K-07's effects, whose list is not this part's). */
async function catalogColumns(table: string): Promise<string[]> {
  const rows = await db.sql<{ name: string }[]>`
    select attname as name from pg_attribute
    where attrelid = ${`${db.schema}.${table}`}::regclass and attnum > 0 and not attisdropped
    order by attnum
  `;
  return rows.map((row) => row.name);
}

beforeAll(async () => {
  // 20 connections, so the 100 parallel writes below meet each other in the database, not in the pool's queue alone.
  db = await createTestDatabase({ name: "money", client: { max: 20 } });
  const typed = await db.sql<{ key: string; type: string }[]>`
    select c.relname || '.' || a.attname as key, format_type(a.atttypid, a.atttypmod) as type
    from pg_attribute a join pg_class c on c.oid = a.attrelid
    where c.relnamespace = ${db.schema}::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  `;
  for (const column of typed) {
    typeOf.set(column.key, column.type);
  }
  const keywords = await db.sql<{ word: string }[]>`select word from pg_get_keywords() where catcode <> 'U'`;
  for (const keyword of keywords) {
    QUOTED.add(keyword.word);
  }
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe("the migration against the frozen table list (K-32 v1): part 1's five tables", () => {
  /** The table list's types as format_type prints them; the others print as the list writes them. */
  const typeNames: Record<string, string> = { timestamptz: "timestamp with time zone" };

  it("the table list names 14 tables, each scoped by business on business_id with no effective dates: part 1's five are in the schema and part 2's nine are migration 0031's (T-723); rule 4's three of the five are versioned, and ledger_lines and payment_items carry no version", async () => {
    expect(TABLES.map((table) => table.name).sort()).toEqual([...OWN_TABLES, ...PART_2_TABLES].sort());
    for (const table of TABLES) {
      expect(
        [table.rowLevelSecurity.scope, table.rowLevelSecurity.column, table.effectiveDates],
        table.name,
      ).toEqual(["business", "business_id", false]);
    }
    expect(
      OWN.filter((table) => table.versioned)
        .map((table) => [table.name, table.versionColumn])
        .sort(),
    ).toEqual(VERSIONED.map((name) => [name, "version"]));
    expect(
      OWN.filter((table) => !table.versioned)
        .map((table) => table.name)
        .sort(),
    ).toEqual(INSERT_ONLY);
    const found = await db.sql<{ name: string }[]>`
      select c.relname as name from pg_class c
      where c.relnamespace = ${db.schema}::regnamespace and c.relkind = 'r'
        and c.relname in ${db.sql([...OWN_TABLES, ...PART_2_TABLES])}
    `;
    // DL-225 (T-723, DL-306): the list gains part 2's nine, made by migration 0031, and stays exact.
    expect(found.map((row) => row.name).sort()).toEqual([...OWN_TABLES, ...PART_2_TABLES].sort());
  });

  it("is recorded in schema_migrations as money_payments_ledger, followed only by part 2's money_fees_packs (T-723), after effects_provider_events (K-07), core_rls_narrow (T-1094), customers (K-28) and both K-30 parts", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    // DL-225 (T-723, DL-306): the files after this part's gain part 2's money_fees_packs (0031), and stay exact.
    expect(names.slice(-2)).toEqual(["money_payments_ledger", "money_fees_packs"]);
    for (const before of [
      "effects_provider_events",
      "core_rls_narrow",
      "customers",
      "bookings_changes_details",
      "bookings_changes_quotes_links",
    ]) {
      expect(names.indexOf(before), before).toBeGreaterThan(-1);
      expect(names.indexOf("money_payments_ledger"), before).toBeGreaterThan(names.indexOf(before));
    }
  });

  for (const table of OWN) {
    it(`${table.name}: columns in order, types, nulls and defaults are the table list's`, async () => {
      const found = await db.sql<{ name: string; type: string; nullable: boolean; default: string | null }[]>`
        select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
               pg_get_expr(d.adbin, d.adrelid) as default
        from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = ${`${db.schema}.${table.name}`}::regclass and a.attnum > 0 and not a.attisdropped
        order by a.attnum
      `;
      expect(found.map((column) => column.name)).toEqual(table.columns.map((column) => column.name));
      for (const column of table.columns) {
        const actual = found.find((candidate) => candidate.name === column.name);
        expect(actual?.type, `${table.name}.${column.name} type`).toBe(typeNames[column.type] ?? column.type);
        expect(actual?.nullable, `${table.name}.${column.name} null`).toBe(column.null);
        if (column.default === undefined) {
          expect(actual?.default, `${table.name}.${column.name} default`).toBeNull();
        } else {
          expect((actual?.default ?? "").replace(/::.*$/, ""), `${table.name}.${column.name} default`).toBe(
            column.default,
          );
        }
      }
    });

    it(`${table.name}: primary key, foreign keys with no schema prefix and their on delete (part 2's three among them, migration 0031's), unique rules (one with a where as a partial unique index) and index names are the table list's`, async () => {
      const constraints = await db.sql<{ name: string; kind: string; definition: string }[]>`
        select conname as name, contype as kind, pg_get_constraintdef(oid) as definition
        from pg_constraint where conrelid = ${`${db.schema}.${table.name}`}::regclass
      `;
      expect(constraints.filter((constraint) => constraint.kind === "p")).toEqual([
        {
          name: `${table.name}_pkey`,
          kind: "p",
          definition: `PRIMARY KEY (${table.primaryKey.map(ident).join(", ")})`,
        },
      ]);
      const named = (kind: string): string[] =>
        constraints
          .filter((constraint) => constraint.kind === kind)
          .map((constraint) => constraint.name)
          .sort();
      // DL-225 (T-723, DL-306): saved_cards' and payments' lists gain part 2's three keys, which migration 0031 adds,
      // and stay exact.
      const keys = table.foreignKeys;
      const unique = table.unique ?? [];
      const plain = unique.filter((rule) => rule.where === undefined);
      expect(named("c")).toEqual((table.checks ?? []).map((check) => check.name).sort());
      expect(named("f")).toEqual(keys.map((key) => key.name).sort());
      expect(named("u")).toEqual(plain.map((rule) => rule.name).sort());
      expect(named("x")).toEqual([]);
      for (const key of keys) {
        expect(constraints.find((constraint) => constraint.name === key.name)?.definition, key.name).toBe(
          `FOREIGN KEY (${key.columns.map(ident).join(", ")}) REFERENCES ${key.references.table}(${key.references.columns.map(ident).join(", ")}) ON DELETE ${key.onDelete.toUpperCase()}`,
        );
      }
      for (const rule of plain) {
        expect(constraints.find((constraint) => constraint.name === rule.name)?.definition, rule.name).toBe(
          `UNIQUE (${rule.columns.map(ident).join(", ")})`,
        );
      }
      const indexes = await db.sql<{ name: string; unique: boolean }[]>`
        select c.relname as name, i.indisunique as unique from pg_index i join pg_class c on c.oid = i.indexrelid
        where i.indrelid = ${`${db.schema}.${table.name}`}::regclass
      `;
      expect(indexes.map((index) => index.name).sort()).toEqual(
        [
          `${table.name}_pkey`,
          ...unique.map((rule) => rule.name),
          ...(table.indexes ?? []).map((index) => index.name),
        ].sort(),
      );
      expect(
        indexes
          .filter((index) => index.unique)
          .map((index) => index.name)
          .sort(),
      ).toEqual([`${table.name}_pkey`, ...unique.map((rule) => rule.name)].sort());
    });

    it(`${table.name}: each check, partial unique rule and index is the table list's own expression, as PostgreSQL reads them`, async () => {
      // The table list's expressions, built on a temporary table with the same columns, then printed by PostgreSQL
      // the same way as the migration's: equal text means the same rule, word for word after PostgreSQL's reading.
      const checks = table.checks ?? [];
      const partial = (table.unique ?? []).filter((rule) => rule.where !== undefined);
      const listed = await asOwner(async (tx) => {
        await tx`create temporary table probe (like ${tx(table.name)}) on commit drop`;
        for (const check of checks) {
          await tx.unsafe(`alter table probe add constraint ${check.name} check (${check.expression})`);
        }
        for (const rule of partial) {
          await tx.unsafe(
            `create unique index ${rule.name} on probe (${rule.columns.join(", ")}) where ${rule.where ?? ""}`,
          );
        }
        for (const index of table.indexes ?? []) {
          const using = index.using === undefined ? "" : ` using ${index.using}`;
          const where = index.where === undefined ? "" : ` where ${index.where}`;
          await tx.unsafe(
            `create index ${index.name} on probe${using} (${index.columns.join(", ")})${where}`,
          );
        }
        return definitionsOf(tx, "probe");
      });
      expect(Object.keys(listed.checks).sort()).toEqual(checks.map((check) => check.name).sort());
      expect(Object.keys(listed.indexes).sort()).toEqual(
        [...partial.map((rule) => rule.name), ...(table.indexes ?? []).map((index) => index.name)].sort(),
      );
      const own = await definitionsOf(db.sql, table.name);
      expect(own.checks).toEqual(listed.checks);
      expect(
        Object.fromEntries(Object.entries(own.indexes).filter(([name]) => name in listed.indexes)),
      ).toEqual(listed.indexes);
    });
  }

  it("rule 1's order: the two keys named in a circle (saved_cards and payments, ledger_lines and refunds) are added once both tables exist, as the table list writes them, and every key of the five is checked against every row (none NOT VALID); the three that name part 2's memberships, booking_fees and plan_charges are left for part 2's ALTER TABLE (DL-278's way; DL-298), which migration 0031 adds (T-723)", async () => {
    const keys = await db.sql<{ table: string; name: string; definition: string; validated: boolean }[]>`
      select c.relname as table, k.conname as name, pg_get_constraintdef(k.oid) as definition,
             k.convalidated as validated
      from pg_constraint k join pg_class c on c.oid = k.conrelid
      where k.contype = 'f' and c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
    `;
    expect(keys.filter((key) => !key.validated).map((key) => key.name)).toEqual([]);
    // DL-225 (T-723, DL-306): the list gains the three keys migration 0031 adds, and stays exact.
    expect(
      keys
        .filter((key) => PART_2_KEYS.includes(key.name))
        .map((key) => key.name)
        .sort(),
    ).toEqual(PART_2_KEYS);
    expect(
      OWN.flatMap((table) => table.foreignKeys.map((key) => key.name))
        .filter((name) => PART_2_KEYS.includes(name))
        .sort(),
    ).toEqual(PART_2_KEYS);
    expect(
      keys
        .filter((key) => CIRCLE_KEYS.includes(key.name))
        .map((key) => `${key.table} ${key.definition}`)
        .sort(),
    ).toEqual([
      "ledger_lines FOREIGN KEY (refund_id, business_id) REFERENCES refunds(id, business_id) ON DELETE RESTRICT",
      "saved_cards FOREIGN KEY (saved_from_payment_id, business_id) REFERENCES payments(id, business_id) ON DELETE RESTRICT",
    ]);
  });

  it("the five refer to other tables only by their keys (rule 1): K-04's businesses, persons, bookings and open_questions, K-07's effects and K-30's booking_lines by id, and part 2's memberships, booking_fees and plan_charges by (id, business_id) (migration 0031's three keys); among themselves by (id, business_id), so a row names only its own business's payment, card, line or refund; of every other table only part 2's booking_fees, packs, pay_links and reconciliation_findings refer to them (migration 0031)", async () => {
    const keys = await db.sql<{ table: string; name: string; referenced: string; definition: string }[]>`
      select src.relname as table, k.conname as name, dst.relname as referenced,
             pg_get_constraintdef(k.oid) as definition
      from pg_constraint k
        join pg_class src on src.oid = k.conrelid
        join pg_class dst on dst.oid = k.confrelid
      where k.contype = 'f' and src.relnamespace = ${db.schema}::regnamespace and src.relname in ${db.sql(OWN_TABLES)}
    `;
    // DL-225 (T-723, DL-306): the list gains part 2's three keys (migration 0031), and stays exact.
    expect(keys.map((key) => `${key.table} ${key.name} ${key.referenced}`).sort()).toEqual(
      OWN.flatMap((table) =>
        table.foreignKeys.map((key) => `${table.name} ${key.name} ${key.references.table}`),
      ).sort(),
    );
    expect(
      [...new Set(keys.map((key) => key.referenced))].filter((name) => !OWN_TABLES.includes(name)).sort(),
    ).toEqual(REFERRED);
    const inside = keys.filter((key) => OWN_TABLES.includes(key.referenced));
    expect(inside.map((key) => key.name).sort()).toEqual([
      "ledger_lines_payment_fk",
      "ledger_lines_refund_fk",
      "payment_items_payment_fk",
      "payments_saved_card_fk",
      "refunds_charge_line_fk",
      "refunds_payment_fk",
      "saved_cards_from_payment_fk",
    ]);
    for (const key of inside) {
      expect(key.definition, key.name).toMatch(
        /^FOREIGN KEY \(\w+, business_id\) REFERENCES \w+\(id, business_id\)/,
      );
    }
    const into = await db.sql<{ table: string }[]>`
      select src.relname as table from pg_constraint k
        join pg_class src on src.oid = k.conrelid
        join pg_class dst on dst.oid = k.confrelid
      where k.contype = 'f' and dst.relnamespace = ${db.schema}::regnamespace and dst.relname in ${db.sql(OWN_TABLES)}
        and src.relname not in ${db.sql(OWN_TABLES)}
      order by 1
    `;
    // DL-225 (T-723, DL-306): the list gains part 2's six keys into the five (migration 0031): booking_fees' to a
    // payment and a saved card, packs' and pay_links' to a payment, and reconciliation_findings' to a line and a
    // refund; ordered by name now that it holds rows, and stays exact.
    expect(into).toEqual([
      { table: "booking_fees" },
      { table: "booking_fees" },
      { table: "packs" },
      { table: "pay_links" },
      { table: "reconciliation_findings" },
      { table: "reconciliation_findings" },
    ]);
  });

  it("versions and set once (rules 4 and 7): <table>_version_raised and <table>_set_once, BEFORE UPDATE FOR EACH ROW, on the three versioned tables, each set-once trigger with rule 7's list in the README's order; ledger_lines and payment_items hold no trigger", async () => {
    const triggers = await db.sql<{ table: string; name: string; definition: string }[]>`
      select c.relname as table, t.tgname as name, pg_get_triggerdef(t.oid) as definition
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)} and not t.tgisinternal
    `;
    expect(triggers.map((trigger) => `${trigger.table} ${trigger.name}`).sort()).toEqual(
      VERSIONED.flatMap((table) => [`${table} ${table}_set_once`, `${table} ${table}_version_raised`]).sort(),
    );
    for (const table of VERSIONED) {
      const list = SET_ONCE[table] ?? [];
      expect(readmeSetOnce(table), table).toEqual(list);
      const byName = (name: string): string =>
        triggers.find((trigger) => trigger.name === name)?.definition ?? "";
      for (const name of [`${table}_set_once`, `${table}_version_raised`]) {
        expect(byName(name), name).toContain("BEFORE UPDATE ON");
      }
      expect(byName(`${table}_version_raised`)).toContain(
        "FOR EACH ROW EXECUTE FUNCTION enforce_version_raise()",
      );
      expect(byName(`${table}_set_once`)).toContain(
        `FOR EACH ROW EXECUTE FUNCTION money_set_once(${list.map((column) => `'${column}'`).join(", ")})`,
      );
    }
  });

  it("rule 7's money_set_once() is word for word the README's (white space apart): plpgsql returning trigger, no arguments, security invoker (it runs as the calling role), no search_path of its own, owned by the migrations' role; it is the part's only function", async () => {
    const functions = await db.sql<
      {
        name: string;
        language: string;
        definer: boolean;
        owner: string;
        me: string;
        config: string[] | null;
        body: string;
        result: string;
        args: string;
      }[]
    >`
      select p.proname as name, l.lanname as language, p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner,
             current_user as me, p.proconfig as config, p.prosrc as body, pg_get_function_result(p.oid) as result,
             pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_language l on l.oid = p.prolang
      where p.pronamespace = ${db.schema}::regnamespace
        and (p.proname like 'money%' or p.proname like any (${OWN_TABLES.map((table) => `${table}%`)}::text[]))
    `;
    expect(
      functions.map((fn) => [
        fn.name,
        fn.language,
        fn.definer,
        fn.owner === fn.me,
        fn.config,
        fn.result,
        fn.args,
      ]),
    ).toEqual([["money_set_once", "plpgsql", false, true, null, "trigger", ""]]);
    expect(README_FUNCTION).toMatch(
      /^create function money_set_once\(\) returns trigger language plpgsql as \$\$/,
    );
    const readmeBody = /\$\$(.*)\$\$/s.exec(README_FUNCTION)?.[1] ?? "";
    expect(readmeBody).toContain("raise exception 'a money value is set once and never changed'");
    expect(squeezed(functions[0]?.body ?? "")).toBe(squeezed(readmeBody));
  });

  it("money and times (rule 9; CQ-09): every amount of the five is bigint minor units beside a not-null three-letter currency text, never a decimal, float or money type; ids are text and every instant timestamptz", () => {
    const own = [...typeOf.entries()].filter(([key]) => OWN_TABLES.includes(key.split(".")[0] ?? ""));
    expect(own).toHaveLength(OWN.reduce((sum, table) => sum + table.columns.length, 0));
    expect(
      own
        .filter(([, type]) =>
          ["bigint", "numeric", "real", "double precision", "money", "integer"].includes(type),
        )
        .map(([key, type]) => `${key} ${type}`)
        .sort(),
    ).toEqual([
      "ledger_lines.amount_cents bigint",
      "payment_items.amount_cents bigint",
      "payments.amount_cents bigint",
      "payments.version integer",
      "refunds.amount_cents bigint",
      "refunds.version integer",
      "saved_cards.version integer",
    ]);
    for (const table of OWN) {
      const currency = table.columns.find((column) => column.name === "currency");
      if (table.columns.some((column) => column.name === "amount_cents")) {
        expect([typeOf.get(`${table.name}.currency`), currency?.null], table.name).toEqual(["text", false]);
        expect(
          (table.checks ?? []).find((check) => check.name === `${table.name}_money`)?.expression,
          table.name,
        ).toBe("amount_cents > 0 and currency ~ '^[A-Z]{3}$'");
      }
    }
    expect(
      own
        .filter(([key]) => key.endsWith(".id") || key.endsWith("_id"))
        .filter(([, type]) => type !== "text")
        .map(([key]) => key),
    ).toEqual([]);
    expect(
      own.filter(([key]) => key.endsWith("_at")).filter(([, type]) => type !== "timestamp with time zone"),
    ).toEqual([]);
    expect(own.filter(([, type]) => type === "timestamp without time zone")).toEqual([]);
  });

  it("neither role owns any of the five or money_set_once(): they stay the migrations' role's, so neither can alter, drop or disable a table, its policies or its triggers (rule 6)", async () => {
    const owners = await db.sql<{ name: string; owner: string; me: string }[]>`
      select c.relname as name, pg_get_userbyid(c.relowner) as owner, current_user as me from pg_class c
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
      union all
      select p.proname, pg_get_userbyid(p.proowner), current_user from pg_proc p
      where p.pronamespace = ${db.schema}::regnamespace and p.proname = 'money_set_once'
    `;
    expect(owners.map((row) => row.name).sort()).toEqual([...OWN_TABLES, "money_set_once"].sort());
    for (const row of owners) {
      expect(row.owner, row.name).toBe(row.me);
      expect(ROLES, row.name).not.toContain(row.owner);
    }
  });
});

describe("row-level security, policies and grants in the catalog (README rules 5 and 6; DL-298)", () => {
  interface Policy {
    table: string;
    name: string;
    permissive: string;
    roles: string[];
    command: string;
    using: string | null;
    check: string | null;
  }

  const policiesOf = (tables: readonly string[]): Promise<Policy[]> =>
    db.sql<Policy[]>`
      select tablename as table, policyname as name, permissive, roles::text[] as roles, cmd as command,
             qual as using, with_check as check
      from pg_policies where schemaname = ${db.schema} and tablename in ${db.sql([...tables])}
      order by tablename, policyname
    `;

  it("row-level security is on for all five, and forced on none", async () => {
    const flags = await db.sql<{ name: string; on: boolean; forced: boolean }[]>`
      select relname as name, relrowsecurity as on, relforcerowsecurity as forced from pg_class
      where relnamespace = ${db.schema}::regnamespace and relname in ${db.sql(OWN_TABLES)}
    `;
    expect([...flags].sort((a, b) => (a.name < b.name ? -1 : 1))).toEqual(
      OWN_TABLES.map((name) => ({ name, on: true, forced: false })),
    );
  });

  it("each holds 0012's <table>_runtime for rosie_job word for word (read from outbox_rows', which keys on the same column) beside one Tool API policy per command its grants allow: _select reads only its scope; _insert, and _update where an update is granted, hold the scope and rule 5's cross-part checks, and on payments the paid check, in WITH CHECK, as PostgreSQL reads the README's words; none of those checks is in any USING; none for delete", async () => {
    const policies = await policiesOf([...OWN_TABLES, "outbox_rows"]);
    const core = policies.filter((policy) => policy.table === "outbox_rows");
    const coreRuntime = core.find((policy) => policy.name === "outbox_rows_runtime");
    const coreToolApi = core.find((policy) => policy.name === "outbox_rows_tool_api");
    expect(coreToolApi?.using).toBe(coreToolApi?.check);
    const scope = coreToolApi?.using ?? "";
    expect(scope).toContain("business_id = NULLIF(current_setting('rosie.business_id'");
    for (const table of OWN_TABLES) {
      const own = policies.filter((policy) => policy.table === table);
      const commands = TOOL_API_COMMANDS[table] ?? [];
      expect(
        own.map((policy) => [policy.name, policy.permissive, policy.roles, policy.command]),
        table,
      ).toEqual([
        [`${table}_runtime`, "PERMISSIVE", [RUNTIME], "ALL"],
        ...commands.map((command) => [
          `${table}_tool_api_${command}`,
          "PERMISSIVE",
          [TOOL_API],
          command.toUpperCase(),
        ]),
      ]);
      const byName = (suffix: string): Policy | undefined =>
        own.find((policy) => policy.name === `${table}_${suffix}`);
      expect([byName("runtime")?.using, byName("runtime")?.check], table).toEqual([
        coreRuntime?.using,
        coreRuntime?.check,
      ]);
      expect([byName("tool_api_select")?.using, byName("tool_api_select")?.check], table).toEqual([
        scope,
        null,
      ]);
      if (commands.includes("insert")) {
        const readme = await readmeCheckAsPrinted(table);
        expect(readme, table).toContain(oneLine(scope));
        expect(
          [byName("tool_api_insert")?.using ?? null, oneLine(byName("tool_api_insert")?.check)],
          table,
        ).toEqual([null, readme]);
        if (commands.includes("update")) {
          expect(
            [byName("tool_api_update")?.using, oneLine(byName("tool_api_update")?.check)],
            table,
          ).toEqual([scope, readme]);
        }
        // Each cross-part check by name, as rls.int.test.ts looks for it (exception (1)).
        for (const [column, referenced] of RULE_5_COLUMNS.filter(([name]) =>
          columnsOf(table).includes(name),
        )) {
          expect(readme, `${table}.${column}`).toContain(
            `((${column} IS NULL) OR (EXISTS ( SELECT 1 FROM ${referenced} r WHERE ((r.id = ${table}.${column}) AND (r.business_id = ${table}.business_id)))))`,
          );
        }
      }
      for (const policy of own) {
        expect(policy.using ?? "", policy.name).not.toContain("EXISTS");
        expect(policy.using ?? "", policy.name).not.toContain("method");
      }
    }
    expect(oneLine(policies.find((policy) => policy.name === "payments_tool_api_insert")?.check)).toContain(
      "((method = ANY (ARRAY['cash'::text, 'own_way'::text])) OR (state <> 'paid'::text))",
    );
    expect(policies.filter((policy) => policy.command === "DELETE")).toEqual([]);
  });

  it("table grants (rule 6): both roles select and insert saved_cards, payments, payment_items and refunds, whose UPDATE is a column grant; ledger_lines is the Tool API's to select only and the runtime side's to select and insert; no delete, truncate, references or trigger for either role; nothing to PUBLIC or any other grantee", async () => {
    const held = await db.sql<{ role: string; table: string; privilege: string }[]>`
      select r.role, c.relname as table, p.privilege
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_class c
        cross join unnest(${PRIVILEGES}::text[]) as p(privilege)
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and has_table_privilege(r.role, c.oid, p.privilege)
    `;
    const privileges = (role: Role, table: string): string[] =>
      table === "ledger_lines" && role === TOOL_API ? ["SELECT"] : ["INSERT", "SELECT"];
    expect(held.map((row) => `${row.role} ${row.table} ${row.privilege}`).sort()).toEqual(
      ROLES.flatMap((role) =>
        OWN_TABLES.flatMap((table) =>
          privileges(role, table).map((privilege) => `${role} ${table} ${privilege}`),
        ),
      ).sort(),
    );
    const others = await db.sql<{ table: string; grantee: string }[]>`
      select c.relname as table, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee
      from pg_class c cross join lateral aclexplode(c.relacl) a
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and a.grantee <> c.relowner and a.grantee not in (${TOOL_API}::regrole, ${RUNTIME}::regrole)
    `;
    expect(others).toEqual([]);
  });

  it("column grants (rule 6): both roles' UPDATE of saved_cards', payments' and refunds' named columns only, every grantee on the five held to exactly them; has_column_privilege agrees, column by column: no amount, payer, purpose, method, effect, reason or decider is updatable, and nothing of ledger_lines or payment_items", async () => {
    const granted = await db.sql<{ table: string; column: string; grantee: string; privilege: string }[]>`
      select c.relname as table, a.attname as column,
             case when g.grantee = 0 then 'PUBLIC' else pg_get_userbyid(g.grantee) end as grantee,
             g.privilege_type as privilege
      from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        cross join lateral aclexplode(a.attacl) g
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and a.attacl is not null
    `;
    const key = (grant: { table: string; column: string; grantee: string; privilege: string }): string =>
      `${grant.table} ${grant.column} ${grant.grantee} ${grant.privilege}`;
    expect(granted.map(key).sort()).toEqual(
      Object.entries(COLUMN_UPDATES)
        .flatMap(([table, columns]) =>
          columns.flatMap((column) =>
            ROLES.map((grantee) => key({ table, column, grantee, privilege: "UPDATE" })),
          ),
        )
        .sort(),
    );
    for (const table of OWN_TABLES) {
      const updatable = await db.sql<{ role: string; column: string }[]>`
        select r.role, a.attname as column
        from unnest(${[...ROLES]}::text[]) as r(role)
          cross join pg_attribute a
        where a.attrelid = ${`${db.schema}.${table}`}::regclass and a.attnum > 0 and not a.attisdropped
          and has_column_privilege(r.role, a.attrelid, a.attnum, 'UPDATE')
        order by 1, a.attnum
      `;
      const ordered = columnsOf(table).filter((column) => (COLUMN_UPDATES[table] ?? []).includes(column));
      expect(updatable, table).toEqual(ROLES.flatMap((role) => ordered.map((column) => ({ role, column }))));
    }
    for (const column of ["amount_cents", "payer_person_id", "purpose", "method", "effect_id", "currency"]) {
      expect(COLUMN_UPDATES.payments, column).not.toContain(column);
    }
    for (const column of ["amount_cents", "reason", "decided_by", "effect_id", "to_person_id"]) {
      expect(COLUMN_UPDATES.refunds, column).not.toContain(column);
    }
  });

  it("DL-298's one grant outside the part: rosie_app's SELECT of effects.id and effects.business_id, by column grant and no other, so rule 5's effect checks can run; no privilege on the whole table and no INSERT, UPDATE or REFERENCES of any column; rosie_job keeps 0015's SELECT, INSERT and UPDATE; provider_events holds nothing for rosie_app (DL-149 otherwise stands)", async () => {
    const granted = await db.sql<{ column: string; grantee: string; privilege: string }[]>`
      select a.attname as column,
             case when g.grantee = 0 then 'PUBLIC' else pg_get_userbyid(g.grantee) end as grantee,
             g.privilege_type as privilege
      from pg_attribute a cross join lateral aclexplode(a.attacl) g
      where a.attrelid = ${`${db.schema}.effects`}::regclass and a.attacl is not null
      order by a.attnum, 2, 3
    `;
    expect(granted).toEqual([
      { column: "id", grantee: TOOL_API, privilege: "SELECT" },
      { column: "business_id", grantee: TOOL_API, privilege: "SELECT" },
    ]);
    const columnPrivileges = await db.sql<{ column: string; privilege: string }[]>`
      select a.attname as column, p.privilege
      from pg_attribute a cross join unnest(${["SELECT", "INSERT", "UPDATE", "REFERENCES"]}::text[]) as p(privilege)
      where a.attrelid = ${`${db.schema}.effects`}::regclass and a.attnum > 0 and not a.attisdropped
        and has_column_privilege(${TOOL_API}, a.attrelid, a.attnum, p.privilege)
      order by a.attnum, 2
    `;
    expect(columnPrivileges).toEqual([
      { column: "id", privilege: "SELECT" },
      { column: "business_id", privilege: "SELECT" },
    ]);
    const tableLevel = await db.sql<{ role: string; table: string; privilege: string }[]>`
      select r.role, c.relname as table, p.privilege
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_class c
        cross join unnest(${PRIVILEGES}::text[]) as p(privilege)
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ('effects', 'provider_events')
        and has_table_privilege(r.role, c.oid, p.privilege)
      order by 1, 2, 3
    `;
    expect(tableLevel.map((row) => `${row.role} ${row.table} ${row.privilege}`)).toEqual([
      `${RUNTIME} effects INSERT`,
      `${RUNTIME} effects SELECT`,
      `${RUNTIME} effects UPDATE`,
      `${RUNTIME} provider_events INSERT`,
      `${RUNTIME} provider_events SELECT`,
      `${RUNTIME} provider_events UPDATE`,
    ]);
    const [events] = await db.sql<{ any: boolean; columns: boolean }[]>`
      select has_any_column_privilege(${TOOL_API}, ${`${db.schema}.provider_events`}, 'SELECT, INSERT, UPDATE, REFERENCES') as any,
             exists (select 1 from pg_attribute where attrelid = ${`${db.schema}.provider_events`}::regclass and attacl is not null) as columns
    `;
    expect(events).toEqual({ any: false, columns: false });
  });

  it("the other tables rule 5's checks read are the Tool API's to read whole (round 2's check, DL-298): bookings, booking_lines, booking_visits, consents and open_questions; so of them only effects needed a grant", async () => {
    const held = await db.sql<{ table: string; select: boolean }[]>`
      select c.relname as table, has_table_privilege(${TOOL_API}, c.oid, 'SELECT') as select
      from pg_class c where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(RULE_5_READS)}
      order by 1
    `;
    expect(held).toEqual(RULE_5_READS.map((table) => ({ table, select: true })));
    const [effects] = await db.sql<{ whole: boolean; id: boolean; business: boolean }[]>`
      select has_table_privilege(${TOOL_API}, ${`${db.schema}.effects`}, 'SELECT') as whole,
             has_column_privilege(${TOOL_API}, ${`${db.schema}.effects`}, 'id', 'SELECT') as id,
             has_column_privilege(${TOOL_API}, ${`${db.schema}.effects`}, 'business_id', 'SELECT') as business
    `;
    expect(effects).toEqual({ whole: false, id: true, business: true });
  });
});

describe("the seed fixtures load (fixtures/index.json): the card's two, seed-payment-deposit.json and seed-refund-new-line.json", () => {
  /** The rows of the card's two seeds, by table, of the five and effects. */
  const SEEDED = { effects: 4, ledger_lines: 3, payment_items: 2, payments: 2, refunds: 1, saved_cards: 1 };
  const LOADED_TABLES = [...OWN_TABLES, "effects"];

  it("the index lists seven seeds and nine refused rows, all K-32 v1; the card's seeds are payments' and refunds', its refused rows ledger_lines' and payments'", () => {
    expect(INDEX.filter((entry) => entry.expect === "accept")).toHaveLength(7);
    expect(INDEX.filter((entry) => entry.expect === "refuse")).toHaveLength(9);
    expect(INDEX.every((entry) => entry.version === "v1")).toBe(true);
    expect(
      [...CARD_SEEDS, LEDGER_UPDATE, HOLD_PAYMENT].map((file) => {
        const entry = INDEX.find((candidate) => candidate.file === file);
        return [file, entry?.table, entry?.expect];
      }),
    ).toEqual([
      [DEPOSIT_SEED, "payments", "accept"],
      [REFUND_SEED, "refunds", "accept"],
      [LEDGER_UPDATE, "ledger_lines", "refuse"],
      [HOLD_PAYMENT, "payments", "refuse"],
    ]);
  });

  for (const file of CARD_SEEDS) {
    it(
      `${file} inserts alone with its after chain, whole, as the runtime side: every row of the five and of effects is stored as given`,
      SLOW,
      async () => {
        await reset();
        const chain = rowsOf([file]).filter((row) => LOADED_TABLES.includes(row.table));
        const loaded = await loadFixtures([file]);
        for (const table of LOADED_TABLES) {
          const given = chain.filter((row) => row.table === table);
          expect(loaded[table] ?? 0, `${file}: ${table}`).toBe(given.length);
          expect(await countRows(db.sql, table), `${file}: ${table} stored`).toBe(given.length);
        }
        for (const row of chain) {
          await expectStored(row);
        }
      },
    );
  }

  it(
    "both insert together, each after chain once: the five and effects hold the seeds' rows (a card, two payments with an item each, three ledger lines, one refund, four effects), every row stored as given",
    SLOW,
    async () => {
      await reset();
      const loaded = await loadFixtures(CARD_SEEDS);
      const rows = rowsOf(CARD_SEEDS).filter((row) => LOADED_TABLES.includes(row.table));
      expect(Object.fromEntries(LOADED_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
      expect(await rowsIn(db.sql, LOADED_TABLES)).toEqual(SEEDED);
      expect(countsOf(rows, LOADED_TABLES)).toEqual(SEEDED);
      for (const row of rows) {
        await expectStored(row);
      }
    },
  );
});

describe("the seeded rows read back (the card's two seeds loaded)", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(CARD_SEEDS);
  }, 120_000);

  it("seed-payment-deposit: the $40 deposit is taken at once, never held (A5-13): one card payment, paid, that names its one K-07 effect (whose idempotency key is its own) and the card saved by its own save effect; one item puts the $40 against the line whose deposit it is; one charge line carries the effect id and Stripe's charge id, and the effect names the line back", async () => {
    const [deposit] = await db.sql<Record<string, unknown>[]>`
      select p.purpose, p.method, p.state, p.amount_cents::text as amount, p.currency,
             e.kind as "effectKind", e.idempotency_key as key, e.amount_cents = p.amount_cents as "effectAmount",
             c.stripe_payment_method_id as card, c.save_effect_id as "savedBy", s.kind as "saveKind",
             l.kind as "lineKind", l.amount_cents::text as "lineAmount", l.effect_id = p.effect_id as "lineEffect",
             l.stripe_object_id as "stripeCharge", e.ledger_line_id = l.id as "namedBack", i.share,
             i.amount_cents::text as "itemAmount", b.deposit_cents = i.amount_cents as "theLinesDeposit"
      from payments p
        join effects e on e.id = p.effect_id
        join saved_cards c on c.id = p.saved_card_id
        join effects s on s.id = c.save_effect_id
        join ledger_lines l on l.payment_id = p.id
        join payment_items i on i.payment_id = p.id
        join booking_lines b on b.id = i.booking_line_id
      where p.id = ${DEPOSIT}
    `;
    expect(deposit).toEqual({
      purpose: "deposit",
      method: "card",
      state: "paid",
      amount: "4000",
      currency: "USD",
      effectKind: "stripe_charge",
      key: textOf(DEPOSIT_EFFECT.id),
      effectAmount: true,
      card: "stripe-card-demo-alex",
      savedBy: textOf(SAVE_EFFECT.id),
      saveKind: "stripe_save_card",
      lineKind: "charge",
      lineAmount: "4000",
      lineEffect: true,
      stripeCharge: "stripe-charge-demo-0001",
      namedBack: true,
      share: "deposit",
      itemAmount: "4000",
      theLinesDeposit: true,
    });
  });

  it("seed-refund-new-line: Sam's $20 of the $55 (A10-09, A10-12) is a refund decided by the owner in K-08's ownerYes shape, from its own stripe_refund effect, naming the charge line it refunds; it writes a new $20 refund line, and the $55 charge line stays a charge of $55 (arch 09 line 492)", async () => {
    const [refund] = await db.sql<Record<string, unknown>[]>`
      select r.reason, r.decided_by, r.state, r.amount_cents::text as amount, r.answered_by_role as role, q.step,
             r.to_person_id = p.payer_person_id as "toThePayer", c.kind as "chargeKind",
             c.amount_cents::text as "chargeAmount", c.payment_id = r.payment_id as "chargeOfItsPayment",
             n.kind as "newKind", n.amount_cents::text as "newAmount", n.effect_id = r.effect_id as "newLineEffect",
             n.payment_id as "newLinePayment", e.kind as "effectKind",
             (select count(*)::int from ledger_lines where booking_id = r.booking_id) as lines
      from refunds r
        join payments p on p.id = r.payment_id
        join ledger_lines c on c.id = r.charge_line_id
        join ledger_lines n on n.refund_id = r.id
        join effects e on e.id = r.effect_id
        join open_questions q on q.id = r.open_question_id
      where r.id = ${textOf(REFUND.id)}
    `;
    expect(refund).toEqual({
      reason: "owner_part",
      decided_by: "owner",
      state: "succeeded",
      amount: "2000",
      role: "owner",
      step: "A10-09",
      toThePayer: true,
      chargeKind: "charge",
      chargeAmount: "5500",
      chargeOfItsPayment: true,
      newKind: "refund",
      newAmount: "2000",
      newLineEffect: true,
      newLinePayment: null,
      effectKind: "stripe_refund",
      lines: 2,
    });
    expect(textOf(REFUND_LINE.refund_id)).toBe(textOf(REFUND.id));
    expect(textOf(FULL_PAYMENT.id)).toBe(textOf(REFUND.payment_id));
  });
});

describe("refuse-ledger-update.json: a ledger line is never edited or removed, by either role (42501); a new line is inserted instead (rule 6; arch 09 lines 457, 492)", () => {
  const refused = refusedOf(LEDGER_UPDATE);

  beforeEach(async () => {
    await reset();
    await loadFixtures([LEDGER_UPDATE]);
  }, 120_000);

  it(
    "the fixture: the runtime side, which writes lines, rewriting the deposit's line to $140 is refused by privilege (42501), and so is the Tool API's, scoped to the barbershop; every column, for both roles; the line reads as written",
    SLOW,
    async () => {
      expect([refused.role, refused.action, refused.table, refused.scope, refused.expect.sqlstate]).toEqual([
        "runtime",
        "update",
        "ledger_lines",
        null,
        "42501",
      ]);
      const where = refused.where ?? {};
      for (const [role, scope] of [
        [roleOf(refused), null],
        [TOOL_API, BARBERSHOP],
      ] as const) {
        const outcome = await refusal(as(role, scope, updateWhere(refused.table, where, refused.set ?? {})));
        expect([outcome.code, outcome.message], role).toEqual([
          refused.expect.sqlstate,
          "permission denied for table ledger_lines",
        ]);
        for (const column of columnsOf("ledger_lines")) {
          const changed = await refusal(
            as(role, scope, (tx) =>
              tx.unsafe(`update ledger_lines set "${column}" = "${column}" where id = $1`, [
                textOf(where.id),
              ]),
            ),
          );
          expect(changed.code, `${role} ${column}`).toBe("42501");
        }
      }
      const [line] = await db.sql<{ amount: string; kind: string }[]>`
      select amount_cents::text as amount, kind from ledger_lines where id = ${textOf(where.id)}
    `;
      expect(line).toEqual({ amount: "4000", kind: "charge" });
    },
  );

  it(
    "deleting the line, or truncating the ledger, is refused for both roles, scoped or not (42501): only the grant stops a truncate (rule 6)",
    SLOW,
    async () => {
      for (const role of ROLES) {
        for (const scope of [BARBERSHOP, null]) {
          for (const statement of [
            `delete from ledger_lines where id = '${textOf(DEPOSIT_LINE.id)}'`,
            "truncate ledger_lines",
          ]) {
            const outcome = await refusal(as(role, scope, (tx) => tx.unsafe(statement)));
            expect([outcome.code, outcome.message], `${role} ${String(scope)}: ${statement}`).toEqual([
              "42501",
              "permission denied for table ledger_lines",
            ]);
          }
        }
      }
      expect(await countRows(db.sql, "ledger_lines")).toBe(1);
    },
  );

  it("without its fault a new line is inserted: the runtime side writes the charge line of the rest, paid by its effect's result, beside the deposit's, which stays as it was; the Tool API writes no line (42501)", async () => {
    const restLine: Values = {
      ...DEPOSIT_LINE,
      id: "ledger-probe-alex-grooms-rest",
      amount_cents: 10000,
      payment_id: textOf(REST_PAYMENT.id),
      effect_id: REST_EFFECT_ID,
      stripe_object_id: "stripe-charge-demo-probe-0101",
      moved_at: "2026-11-07T18:00:02Z",
      written_at: "2026-11-07T18:00:02Z",
    };
    const lines = await as(RUNTIME, null, async (tx) => {
      await insertRow(tx, "effects", { ...REST_EFFECT, state: "succeeded", tries: 1, runs: 1 });
      await insertRow(tx, "payments", { ...REST_PAYMENT, state: "paid", paid_at: "2026-11-07T18:00:02Z" });
      await insertRow(tx, "ledger_lines", restLine);
      return tx<{ id: string; amount: string }[]>`
        select id, amount_cents::text as amount from ledger_lines order by id
      `;
    });
    expect(lines).toEqual([
      { id: textOf(DEPOSIT_LINE.id), amount: "4000" },
      { id: "ledger-probe-alex-grooms-rest", amount: "10000" },
    ]);
    const outcome = await refusal(
      as(TOOL_API, BARBERSHOP, (tx) =>
        insertRow(tx, "ledger_lines", {
          ...restLine,
          payment_id: DEPOSIT,
          effect_id: textOf(DEPOSIT_EFFECT.id),
        }),
      ),
    );
    expect([outcome.code, outcome.message]).toEqual(["42501", "permission denied for table ledger_lines"]);
  });
});

describe("refuse-hold-payment.json: a payment of kind hold cannot be stored (CHECK); nothing is ever held on a card (RULES 3.2; D65)", () => {
  const refused = refusedOf(HOLD_PAYMENT);

  beforeEach(async () => {
    await reset();
    await loadFixtures([HOLD_PAYMENT]);
  }, 120_000);

  it(
    "the fixture: Alex's $40 deposit written held on his card, by a Tool API call scoped to Lee's Barbershop, is refused by payments_state_known (23514); so it is on the runtime side, and as a purpose; no state, purpose or method of the table list holds a hold or a capture",
    SLOW,
    async () => {
      expect([refused.role, refused.action, refused.table, refused.scope?.businessId]).toEqual([
        "toolApi",
        "insert",
        "payments",
        BARBERSHOP,
      ]);
      const values = refused.values ?? {};
      expect(values.state).toBe("held");
      for (const [role, scope] of [
        [roleOf(refused), BARBERSHOP],
        [RUNTIME, null],
      ] as const) {
        const outcome = await refusal(as(role, scope, (tx) => insertRow(tx, "payments", values)));
        expect([outcome.code, outcome.constraint], role).toEqual(["23514", "payments_state_known"]);
        expect(refused.expect.constraintOneOf).toContain(outcome.constraint);
        expect(outcome.code).toBe(refused.expect.sqlstate);
      }
      const asPurpose = await refusal(
        as(RUNTIME, null, (tx) =>
          insertRow(tx, "payments", { ...values, state: "pending", purpose: "hold" }),
        ),
      );
      expect([asPurpose.code, asPurpose.constraint]).toEqual(["23514", "payments_purpose_known"]);
      const payments = tableOf("payments");
      const words = (payments.checks ?? [])
        .filter((check) =>
          ["payments_state_known", "payments_purpose_known", "payments_method_known"].includes(check.name),
        )
        .map((check) => check.expression)
        .join(" ");
      expect(words).not.toMatch(/hold|held|capture|authori/);
      expect(
        payments.columns.map((column) => column.name).filter((name) => /hold|capture|authori/.test(name)),
      ).toEqual([]);
    },
  );

  it("without its one fault the same payment, written pending for its effect to charge at once, passes as the Tool API (it names its own business's effect: DL-298's grant), and only the effect's result, on the runtime side, makes it paid", async () => {
    const values: Values = { ...(refused.values ?? {}), state: "pending" };
    const stored = await as(TOOL_API, BARBERSHOP, async (tx) => {
      const [row] = await insertReturning(tx, "payments", values);
      const paidByTheToolApi = await refusal(
        tx`update payments set state = 'paid', paid_at = '2026-11-07T15:20:02Z', version = version + 1
           where id = ${textOf(values.id)}`,
      );
      return [row?.state, row?.effect_id, paidByTheToolApi.code];
    });
    expect(stored).toEqual(["pending", textOf(DEPOSIT_EFFECT.id), "42501"]);
    const paid = await as(RUNTIME, BARBERSHOP, async (tx) => {
      await insertRow(tx, "payments", values);
      return tx<{ state: string; version: number }[]>`
        update payments set state = 'paid', paid_at = '2026-11-07T15:20:02Z', version = version + 1
        where id = ${textOf(values.id)} returning state, version
      `;
    });
    expect(paid).toEqual([{ state: "paid", version: 2 }]);
  });
});

describe("one idempotency key stores at most one payment: 100 parallel writes (arch 09 line 457; arch 10 lines 508, 542)", () => {
  const TRIES = 100;
  const TIP_KEY = "eff-probe-alex-grooms-tip";

  /** Each write's outcome: the id it stored, or the SQLSTATE and constraint it was refused with. */
  type Outcome = { stored: string } | { code: string | undefined; constraint: string | undefined };
  const settle = (write: Promise<string>): Promise<Outcome> =>
    write.then(
      (stored) => ({ stored }),
      (error: unknown) => {
        const failure = error as { code?: string; constraint_name?: string };
        return { code: failure.code, constraint: failure.constraint_name };
      },
    );
  const storedOf = (outcomes: readonly Outcome[]): string[] =>
    outcomes.flatMap((outcome) => ("stored" in outcome ? [outcome.stored] : []));
  const refusedOf100 = (outcomes: readonly Outcome[]): (string | undefined)[][] =>
    outcomes.flatMap((outcome) => ("stored" in outcome ? [] : [[outcome.code, outcome.constraint]]));

  beforeAll(async () => {
    await reset();
    await loadFixtures([DEPOSIT_SEED]);
    await committedAs(RUNTIME, (tx) => insertRow(tx, "effects", REST_EFFECT));
  }, 120_000);

  it(
    "100 Tool API calls at once, scoped to the barbershop, each writing the rest pending under its own id for the one effect (one idempotency key): exactly one is stored; the other 99 are refused by payments_effect_key (23505)",
    SLOW,
    async () => {
      const write = (n: number): Promise<string> =>
        withBusiness(db.sql, BARBERSHOP, async (tx) => {
          await tx.unsafe(`set local role ${TOOL_API}`);
          const [row] = await tx<{ id: string }[]>`
            insert into payments ${tx(columnValues(tx, "payments", { ...REST_PAYMENT, id: `pay-probe-once-${pad(n)}` }))}
            returning id
          `;
          return row?.id ?? "";
        });
      const outcomes = await Promise.all(Array.from({ length: TRIES }, (_, n) => settle(write(n))));
      expect(storedOf(outcomes)).toHaveLength(1);
      expect(refusedOf100(outcomes)).toEqual(
        Array.from({ length: TRIES - 1 }, () => ["23505", "payments_effect_key"]),
      );
      const stored = await db.sql<{ id: string; key: string }[]>`
        select p.id, e.idempotency_key as key from payments p join effects e on e.id = p.effect_id
        where p.effect_id = ${REST_EFFECT_ID}
      `;
      expect(stored).toEqual([{ id: storedOf(outcomes)[0], key: REST_EFFECT_ID }]);
    },
  );

  it(
    "100 commits at once on the runtime side, each writing a tip's effect under its own id but one idempotency key, with its payment: exactly one effect and one payment are stored; the other 99 commits are refused whole by effects_idempotency_key_key (23505)",
    SLOW,
    async () => {
      const commit = (n: number): Promise<string> =>
        withBusiness(db.sql, BARBERSHOP, async (tx) => {
          await tx.unsafe(`set local role ${RUNTIME}`);
          const effect = `eff-probe-alex-grooms-tip-${pad(n)}`;
          await insertRow(
            tx,
            "effects",
            pendingEffect(REST_EFFECT, effect, { idempotency_key: TIP_KEY, amount_cents: 1500 }),
          );
          await insertRow(tx, "payments", {
            ...REST_PAYMENT,
            id: `pay-probe-alex-grooms-tip-${pad(n)}`,
            purpose: "tip",
            amount_cents: 1500,
            effect_id: effect,
          });
          return effect;
        });
      const outcomes = await Promise.all(Array.from({ length: TRIES }, (_, n) => settle(commit(n))));
      expect(storedOf(outcomes)).toHaveLength(1);
      expect(refusedOf100(outcomes)).toEqual(
        Array.from({ length: TRIES - 1 }, () => ["23505", "effects_idempotency_key_key"]),
      );
      const stored = await db.sql<{ payment: string; effect: string }[]>`
        select p.id as payment, e.id as effect from effects e left join payments p on p.effect_id = e.id
        where e.idempotency_key = ${TIP_KEY}
      `;
      expect(stored).toHaveLength(1);
      expect(stored[0]?.effect).toBe(storedOf(outcomes)[0]);
      expect(stored[0]?.payment).toBe(`pay-probe-alex-grooms-tip-${(stored[0]?.effect ?? "").slice(-3)}`);
    },
  );
});

describe("money is integer cents with a currency code (CQ-09; rule 9): each of the four amount tables", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(CARD_SEEDS);
  }, 120_000);

  /** A seeded row of each table with an amount, and whether its update must raise the version (rule 4). */
  const AMOUNTS: readonly (readonly [string, string, boolean])[] = [
    ["ledger_lines", textOf(DEPOSIT_LINE.id), false],
    ["payment_items", textOf(DEPOSIT_ITEM.id), false],
    ["payments", DEPOSIT, true],
    ["refunds", textOf(REFUND.id), true],
  ];

  it(
    "'39.50' as cents is refused by the type (22P02); a lower-case or two-letter currency, a zero or negative amount by the table's <table>_money check (23514); no currency by its not-null (23502); the stored amounts are whole cents in USD",
    SLOW,
    async () => {
      const probes: readonly (readonly [string, string | number | null, string, string | undefined])[] = [
        ["amount_cents", "39.50", "22P02", undefined],
        ["amount_cents", 0, "23514", "money"],
        ["amount_cents", -4000, "23514", "money"],
        ["currency", "usd", "23514", "money"],
        ["currency", "US", "23514", "money"],
        ["currency", null, "23502", undefined],
      ];
      for (const [table, id, versioned] of AMOUNTS) {
        for (const [column, value, code, constraint] of probes) {
          // As the tables' owner, so only the type and the CHECK speak (no grant lets a role change an amount).
          const outcome = await refusal(
            asOwner((tx) =>
              tx.unsafe(
                `update ${table} set ${column} = $1${versioned ? ", version = version + 1" : ""} where id = $2`,
                [value as never, id],
              ),
            ),
          );
          expect([outcome.code, outcome.constraint], `${table}.${column} = ${JSON.stringify(value)}`).toEqual(
            [code, constraint === undefined ? undefined : `${table}_${constraint}`],
          );
        }
      }
      const stored = await db.sql<{ amount: string; currency: string }[]>`
      select amount_cents::text as amount, currency from payments
      union all select amount_cents::text, currency from payment_items
      union all select amount_cents::text, currency from ledger_lines
      union all select amount_cents::text, currency from refunds
    `;
      expect(stored).toHaveLength(8);
      for (const row of stored) {
        expect(row.amount).toMatch(/^[1-9][0-9]*$/);
        expect(row.currency).toBe("USD");
      }
    },
  );
});

describe("rule 5 with DL-298's grant: the Tool API writes money rows naming only its own business's effects, bookings and lines, and never makes a card payment paid", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(CARD_SEEDS);
    await committedAs(RUNTIME, async (tx) => {
      for (const effect of [
        REST_EFFECT,
        YOGA_EFFECT,
        SAVE_EFFECT_2,
        YOGA_SAVE_EFFECT,
        REFUND_EFFECT_2,
        YOGA_REFUND_EFFECT,
      ]) {
        await insertRow(tx, "effects", effect);
      }
    });
  }, 120_000);

  it("a Tool API cash payment with no effect is stored and recorded paid: Riley records Alex's rest paid in cash at the counter (A9-08); recorded pending, or by nobody, it is refused by payments_recorded_outside (23514)", async () => {
    const stored = await as(TOOL_API, BARBERSHOP, (tx) => insertReturning(tx, "payments", CASH_REST));
    expect(
      stored.map((row) => [
        row.id,
        row.method,
        row.state,
        row.effect_id,
        row.recorded_by_person_id,
        row.version,
      ]),
    ).toEqual([[CASH_REST.id, "cash", "paid", null, RILEY, 1]]);
    for (const fault of [
      { state: "pending", paid_at: null },
      { recorded_by_person_id: null },
    ] satisfies Values[]) {
      const outcome = await refusal(
        as(TOOL_API, BARBERSHOP, (tx) => insertRow(tx, "payments", { ...CASH_REST, ...fault })),
      );
      expect([outcome.code, outcome.constraint], JSON.stringify(fault)).toEqual([
        "23514",
        "payments_recorded_outside",
      ]);
    }
  });

  it("the grant is what lets rule 5's checks run (round 1's finding): with it revoked, in a rolled-back transaction, the same cash payment with no effect is refused with permission denied for table effects (42501), though its effect_id is null", async () => {
    const outcome = await refusal(
      asOwner(async (tx) => {
        await tx`revoke select (id, business_id) on effects from rosie_app`;
        await tx`select set_config('rosie.business_id', ${BARBERSHOP}, true)`;
        await tx.unsafe(`set local role ${TOOL_API}`);
        await insertRow(tx, "payments", CASH_REST);
      }),
    );
    expect([outcome.code, outcome.message]).toEqual(["42501", "permission denied for table effects"]);
    const [grant] = await db.sql<{ id: boolean }[]>`
      select has_column_privilege(${TOOL_API}, ${`${db.schema}.effects`}, 'id', 'SELECT') as id
    `;
    expect(grant?.id).toBe(true);
  });

  it("a Tool API payment naming another business's effect id is refused (42501): Lee's rest naming the yoga studio's charge effect, and the yoga studio's pack naming Lee's; a saved card or a refund naming another business's effect the same", async () => {
    const crossed: readonly (readonly [string, string, Values])[] = [
      [BARBERSHOP, "payments", { ...REST_PAYMENT, effect_id: YOGA_EFFECT_ID }],
      [YOGA_STUDIO, "payments", { ...YOGA_PAYMENT, effect_id: REST_EFFECT_ID }],
      [BARBERSHOP, "saved_cards", { ...FIRST_SAVE, save_effect_id: textOf(YOGA_SAVE_EFFECT.id) }],
      [BARBERSHOP, "refunds", { ...REFUND_2, effect_id: textOf(YOGA_REFUND_EFFECT.id) }],
    ];
    for (const [scope, table, values] of crossed) {
      const outcome = await refusal(as(TOOL_API, scope, (tx) => insertRow(tx, table, values)));
      expect([outcome.code, outcome.message], `${scope} ${table}`).toEqual([
        "42501",
        `new row violates row-level security policy for table "${table}"`,
      ]);
    }
  });

  it("a payment naming its own business's effect passes the check: Lee's rest pending for its charge effect, the yoga studio's pack for its own; a saved card for its own save effect and a refund for its own refund effect, each written by the Tool API", async () => {
    const own: readonly (readonly [string, string, Values])[] = [
      [BARBERSHOP, "payments", REST_PAYMENT],
      [YOGA_STUDIO, "payments", YOGA_PAYMENT],
      [BARBERSHOP, "saved_cards", FIRST_SAVE],
      [BARBERSHOP, "refunds", REFUND_2],
    ];
    for (const [scope, table, values] of own) {
      const stored = await as(TOOL_API, scope, (tx) => insertReturning(tx, table, values));
      expect(
        stored.map((row) => [row.id, row.business_id]),
        `${scope} ${table}`,
      ).toEqual([[values.id, scope]]);
    }
  });

  it("a version-only update of a pending payment passes (a commit compares and sets its version), and so does moving it to cancelled; moving it to paid is refused (42501): only the runtime side's result does that", async () => {
    const pending = await as(TOOL_API, BARBERSHOP, async (tx) => {
      await insertRow(tx, "payments", REST_PAYMENT);
      const bumped = await tx<{ version: number }[]>`
        update payments set version = version + 1 where id = ${textOf(REST_PAYMENT.id)} and version = 1
        returning version
      `;
      const cancelled = await tx<{ state: string; version: number }[]>`
        update payments set state = 'cancelled', cancelled_at = '2026-11-08T18:00:00Z', version = version + 1
        where id = ${textOf(REST_PAYMENT.id)} returning state, version
      `;
      return [bumped, cancelled];
    });
    expect(pending).toEqual([[{ version: 2 }], [{ state: "cancelled", version: 3 }]]);
    const paid = await refusal(
      as(TOOL_API, BARBERSHOP, async (tx) => {
        await insertRow(tx, "payments", REST_PAYMENT);
        await tx`
          update payments set state = 'paid', paid_at = '2026-11-08T18:00:00Z', version = version + 1
          where id = ${textOf(REST_PAYMENT.id)}
        `;
      }),
    );
    expect([paid.code, paid.message]).toEqual([
      "42501",
      'new row violates row-level security policy for table "payments"',
    ]);
    const inserted = await refusal(
      as(TOOL_API, BARBERSHOP, (tx) =>
        insertRow(tx, "payments", { ...REST_PAYMENT, state: "paid", paid_at: "2026-11-07T18:00:02Z" }),
      ),
    );
    expect(inserted.code).toBe("42501");
  });

  it("a Tool API update that leaves a card payment paid is refused (42501): the paid deposit's version-only update, or any other update of it; yet the Tool API reads the paid deposit and locks it with SELECT ... FOR UPDATE (1 row), and the runtime side's result makes a pending card payment paid", async () => {
    for (const statement of [
      "update payments set version = version + 1 where id = $1",
      "update payments set version = version + 1, failed_why = null where id = $1",
    ]) {
      const outcome = await refusal(as(TOOL_API, BARBERSHOP, (tx) => tx.unsafe(statement, [DEPOSIT])));
      expect([outcome.code, outcome.message], statement).toEqual([
        "42501",
        'new row violates row-level security policy for table "payments"',
      ]);
    }
    const locked = await as(
      TOOL_API,
      BARBERSHOP,
      (tx) =>
        tx<{ id: string; state: string }[]>`select id, state from payments where id = ${DEPOSIT} for update`,
    );
    expect(locked).toEqual([{ id: DEPOSIT, state: "paid" }]);
    const paid = await as(RUNTIME, BARBERSHOP, async (tx) => {
      await insertRow(tx, "payments", REST_PAYMENT);
      return tx<{ state: string }[]>`
        update payments set state = 'paid', paid_at = '2026-11-08T18:00:00Z', version = version + 1
        where id = ${textOf(REST_PAYMENT.id)} returning state
      `;
    });
    expect(paid).toEqual([{ state: "paid" }]);
  });

  it(
    "the Tool API reads effects only through id and business_id, and only its own business's rows: the barbershop's scope sees its own, the yoga studio's only its own, no scope none; a whole-row read or any other column is refused (42501); it inserts, updates, deletes and truncates no effect (42501); provider_events stays closed (42501)",
    SLOW,
    async () => {
      const owned = async (business: string): Promise<{ id: string; business_id: string }[]> =>
        db.sql<{ id: string; business_id: string }[]>`
        select id, business_id from effects where business_id = ${business} order by id
      `;
      const read = (tx: Tx) =>
        tx<{ id: string; business_id: string }[]>`select id, business_id from effects order by id`;
      const lees = await owned(BARBERSHOP);
      expect(lees.length).toBeGreaterThan(4);
      expect(await as(TOOL_API, BARBERSHOP, read)).toEqual(lees);
      expect(await as(TOOL_API, YOGA_STUDIO, read)).toEqual(await owned(YOGA_STUDIO));
      expect(await as(TOOL_API, null, read)).toEqual([]);
      for (const column of (await catalogColumns("effects")).filter(
        (name) => !["id", "business_id"].includes(name),
      )) {
        const outcome = await refusal(
          as(TOOL_API, BARBERSHOP, (tx) => tx.unsafe(`select "${column}" from effects`)),
        );
        expect([outcome.code, outcome.message], column).toEqual([
          "42501",
          "permission denied for table effects",
        ]);
      }
      for (const statement of [
        "select * from effects",
        `insert into effects (id) values ('eff-probe-tool-api')`,
        "update effects set version = version + 1",
        "delete from effects",
        "truncate effects",
        "select count(*) from provider_events",
      ]) {
        const outcome = await refusal(as(TOOL_API, BARBERSHOP, (tx) => tx.unsafe(statement)));
        expect(outcome.code, statement).toBe("42501");
        expect(outcome.message, statement).toMatch(/^permission denied for table (effects|provider_events)$/);
      }
    },
  );

  it("rule 5's other cross-part checks: the yoga studio's payment naming Lee's booking, and its item naming Lee's booking line, are refused (42501); the same item with no line (an extra) passes", async () => {
    const booking = await refusal(
      as(TOOL_API, YOGA_STUDIO, (tx) =>
        insertRow(tx, "payments", { ...YOGA_PAYMENT, booking_id: GROOMS, purpose: "rest" }),
      ),
    );
    expect([booking.code, booking.message]).toEqual([
      "42501",
      'new row violates row-level security policy for table "payments"',
    ]);
    const item: Values = {
      ...DEPOSIT_ITEM,
      id: "item-probe-yoga-pack-1",
      payment_id: textOf(YOGA_PAYMENT.id),
      business_id: YOGA_STUDIO,
      amount_cents: 16000,
    };
    const line = await refusal(
      as(TOOL_API, YOGA_STUDIO, async (tx) => {
        await insertRow(tx, "payments", YOGA_PAYMENT);
        await insertRow(tx, "payment_items", item);
      }),
    );
    expect([line.code, line.message]).toEqual([
      "42501",
      'new row violates row-level security policy for table "payment_items"',
    ]);
    const extra = await as(TOOL_API, YOGA_STUDIO, async (tx) => {
      await insertRow(tx, "payments", YOGA_PAYMENT);
      return insertReturning(tx, "payment_items", { ...item, booking_line_id: null, share: "extra" });
    });
    expect(extra.map((row) => [row.id, row.business_id])).toEqual([[item.id, YOGA_STUDIO]]);
  });
});

describe("rules 6 and 7 on the seeded rows: what may change, by privilege and by the set-once trigger", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(CARD_SEEDS);
  }, 120_000);

  it(
    "no column outside rule 6's list is updated by either role (42501), column by column, on all five: ledger_lines and payment_items take no update at all, and no amount, payer, purpose, method, effect, reason or decider changes in place",
    SLOW,
    async () => {
      for (const table of OWN_TABLES) {
        for (const column of columnsOf(table).filter(
          (name) => !(COLUMN_UPDATES[table] ?? []).includes(name),
        )) {
          for (const [role, scope] of [
            [TOOL_API, BARBERSHOP],
            [RUNTIME, null],
          ] as const) {
            const outcome = await refusal(
              as(role, scope, (tx) =>
                tx.unsafe(`update ${table} set "${column}" = "${column}" where id = $1`, [
                  SEEDED_ROW[table] ?? "",
                ]),
              ),
            );
            expect([outcome.code, outcome.message], `${role} ${table}.${column}`).toEqual([
              "42501",
              `permission denied for table ${table}`,
            ]);
          }
        }
      }
    },
  );

  it(
    "no role deletes or truncates any of the five, scoped or not (42501): money records stay 7 years (rule 9)",
    SLOW,
    async () => {
      for (const table of OWN_TABLES) {
        for (const role of ROLES) {
          for (const scope of [BARBERSHOP, null]) {
            for (const statement of [`delete from ${table}`, `truncate ${table}`]) {
              const outcome = await refusal(as(role, scope, (tx) => tx.unsafe(statement)));
              expect([outcome.code, outcome.message], `${role} ${String(scope)}: ${statement}`).toEqual([
                "42501",
                `permission denied for table ${table}`,
              ]);
            }
          }
        }
      }
      expect(await rowsIn(db.sql, OWN_TABLES)).toEqual({
        ledger_lines: 3,
        payment_items: 2,
        payments: 2,
        refunds: 1,
        saved_cards: 1,
      });
    },
  );

  it("seed-payment-deposit on the runtime side: the paid time changed is refused by payments_set_once and the paid payment moved to failed by payments_state_times (23514); a second charge line for it by ledger_lines_payment_charge_key (23505); a card payment with no effect by payments_stripe_runs_from_effect (23514)", async () => {
    const refusals: readonly (readonly [string, (tx: Tx) => Promise<unknown>, string, string])[] = [
      [
        "paid time changed",
        (tx) =>
          tx`update payments set paid_at = paid_at + interval '1 minute', version = version + 1 where id = ${DEPOSIT}`,
        "23514",
        "payments_set_once",
      ],
      [
        "moved to failed",
        (tx) =>
          tx`update payments set state = 'failed', failed_at = '2026-11-08T10:00:00Z', failed_why = 'declined',
             version = version + 1 where id = ${DEPOSIT}`,
        "23514",
        "payments_state_times",
      ],
      [
        "a second charge line",
        (tx) =>
          insertRow(tx, "ledger_lines", {
            ...DEPOSIT_LINE,
            id: "ledger-probe-alex-grooms-deposit-2",
            stripe_object_id: "stripe-charge-demo-probe-0102",
          }),
        "23505",
        "ledger_lines_payment_charge_key",
      ],
      [
        "a card payment with no effect",
        (tx) => insertRow(tx, "payments", { ...REST_PAYMENT, effect_id: null }),
        "23514",
        "payments_stripe_runs_from_effect",
      ],
    ];
    for (const [label, statement, code, constraint] of refusals) {
      const outcome = await refusal(as(RUNTIME, null, statement));
      expect([outcome.code, outcome.constraint], label).toEqual([code, constraint]);
    }
  });

  it("a first card save (README default 22): written with no customer id, the save's result sets it and cardSaved the payment method and saved time; then the customer id changed or cleared, or the payment method changed, is refused by saved_cards_set_once (23514); marked saved with no customer id by saved_cards_saved_with_method; a second card from one save effect by saved_cards_save_effect_key (23505); removed passes, then its reason changed is refused (saved_cards_set_once)", async () => {
    const id = textOf(FIRST_SAVE.id);
    /** The save from its commit up to the step named, on the runtime side, in one rolled-back transaction. */
    const upTo = async (tx: Tx, step: "written" | "customer" | "saved" | "removed"): Promise<void> => {
      await insertRow(tx, "effects", SAVE_EFFECT_2);
      await insertRow(tx, "saved_cards", FIRST_SAVE);
      if (step === "written") {
        return;
      }
      await tx`update saved_cards set stripe_customer_id = 'stripe-customer-demo-alex-2', version = version + 1 where id = ${id}`;
      if (step === "customer") {
        return;
      }
      await tx`
        update saved_cards set stripe_payment_method_id = 'stripe-card-demo-alex-2', saved_at = '2026-11-07T18:11:00Z',
          version = version + 1 where id = ${id}
      `;
      if (step === "saved") {
        return;
      }
      await tx`
        update saved_cards set removed_at = '2026-11-09T09:00:00Z', removed_why = 'nothing_needs_it',
          version = version + 1 where id = ${id}
      `;
    };
    const removed = await as(RUNTIME, null, async (tx) => {
      await upTo(tx, "removed");
      return tx<Record<string, unknown>[]>`
        select stripe_customer_id as customer, stripe_payment_method_id as card, removed_why as why, version
        from saved_cards where id = ${id}
      `;
    });
    expect(removed).toEqual([
      {
        customer: "stripe-customer-demo-alex-2",
        card: "stripe-card-demo-alex-2",
        why: "nothing_needs_it",
        version: 4,
      },
    ]);
    const refusals: readonly (readonly [
      string,
      "written" | "customer" | "saved" | "removed",
      (tx: Tx) => Promise<unknown>,
      string,
      string,
    ])[] = [
      [
        "customer id changed",
        "customer",
        (tx) =>
          tx`update saved_cards set stripe_customer_id = 'stripe-customer-demo-other', version = version + 1 where id = ${id}`,
        "23514",
        "saved_cards_set_once",
      ],
      [
        "customer id cleared",
        "customer",
        (tx) => tx`update saved_cards set stripe_customer_id = null, version = version + 1 where id = ${id}`,
        "23514",
        "saved_cards_set_once",
      ],
      [
        "payment method changed",
        "saved",
        (tx) =>
          tx`update saved_cards set stripe_payment_method_id = 'stripe-card-demo-other', version = version + 1 where id = ${id}`,
        "23514",
        "saved_cards_set_once",
      ],
      [
        "marked saved with no customer id",
        "written",
        (tx) =>
          tx`update saved_cards set stripe_payment_method_id = 'stripe-card-demo-alex-2', saved_at = '2026-11-07T18:11:00Z',
             version = version + 1 where id = ${id}`,
        "23514",
        "saved_cards_saved_with_method",
      ],
      [
        "a second card from one save effect",
        "written",
        (tx) => insertRow(tx, "saved_cards", { ...FIRST_SAVE, id: "card-probe-alex-grooms-3" }),
        "23505",
        "saved_cards_save_effect_key",
      ],
      [
        "removed, then its reason changed",
        "removed",
        (tx) => tx`update saved_cards set removed_why = 'not_booked', version = version + 1 where id = ${id}`,
        "23514",
        "saved_cards_set_once",
      ],
    ];
    for (const [label, step, statement, code, constraint] of refusals) {
      const outcome = await refusal(
        as(RUNTIME, null, async (tx) => {
          await upTo(tx, step);
          await statement(tx);
        }),
      );
      expect([outcome.code, outcome.constraint], label).toEqual([code, constraint]);
    }
  });

  it("seed-refund-new-line on the runtime side: the refund Stripe reports failed after it succeeded, with its new refund_failed line, passes; then moved back to succeeded is refused by refunds_state_times, its failed time cleared by refunds_set_once (23514); its amount changed by either role by privilege (42501)", async () => {
    const id = textOf(REFUND.id);
    const failed = async (tx: Tx): Promise<void> => {
      await tx`update refunds set state = 'failed', failed_at = '2026-11-09T10:00:00Z', version = version + 1 where id = ${id}`;
      await insertRow(tx, "ledger_lines", {
        ...REFUND_LINE,
        id: "ledger-probe-alex-signature-cut-refund-failed",
        kind: "refund_failed",
        moved_at: "2026-11-09T10:00:00Z",
        written_by: "provider_event",
        written_at: "2026-11-09T10:00:01Z",
      });
    };
    const after = await as(RUNTIME, null, async (tx) => {
      await failed(tx);
      return tx<{ kind: string; amount: string }[]>`
        select kind, amount_cents::text as amount from ledger_lines where refund_id = ${id} order by kind
      `;
    });
    expect(after).toEqual([
      { kind: "refund", amount: "2000" },
      { kind: "refund_failed", amount: "2000" },
    ]);
    for (const [label, statement, constraint] of [
      [
        "moved back to succeeded",
        "update refunds set state = 'succeeded', version = version + 1 where id = $1",
        "refunds_state_times",
      ],
      [
        "failed time cleared",
        "update refunds set state = 'succeeded', failed_at = null, version = version + 1 where id = $1",
        "refunds_set_once",
      ],
    ] as const) {
      const outcome = await refusal(
        as(RUNTIME, null, async (tx) => {
          await failed(tx);
          await tx.unsafe(statement, [id]);
        }),
      );
      expect([outcome.code, outcome.constraint], label).toEqual(["23514", constraint]);
    }
    for (const [role, scope] of [
      [TOOL_API, BARBERSHOP],
      [RUNTIME, null],
    ] as const) {
      const outcome = await refusal(
        as(
          role,
          scope,
          (tx) => tx`update refunds set amount_cents = 1500, version = version + 1 where id = ${id}`,
        ),
      );
      expect([outcome.code, outcome.message], role).toEqual(["42501", "permission denied for table refunds"]);
    }
  });
});
