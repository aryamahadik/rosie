// T-723: the money part (K-32 v1), part 2: memberships, pay_links, packs, credits, booking_fees, plan_charges,
// rosfield_fees, reconciliation_runs and reconciliation_findings, with the three keys of part 1's tables that name them
// and README rules 1 to 9 as they bear on those nine, against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/repo/money-2`). The schema comes from migrating a fresh test schema, so every migration
// runs in order and this part's (0031) right after part 1's (0030, T-722): after K-07's effects, K-25's services, K-28's
// customers, K-29's consents and both K-30 parts.
//
// The test's connection is the migrations' role, which owns the tables and is not bound by row-level security. A check
// made as the Tool API (rosie_app, K-05 scope business: C-101's and C-106's calls, the pages' and the console's) or the
// runtime side (rosie_job: K-05's commit, the plan charge job, the effect results and provider events, reconciliation,
// the monthly bill job, the pay page's server) runs in its own transaction under SET LOCAL ROLE, scoped by withBusiness()
// as a call is scoped, and is rolled back; the 50 parallel uses of a pack's last credit commit, as the booking's money
// step does. Seed fixtures are loaded as the runtime side with no scope (K-04's fixture format), and committed.
//
// Rule 5's checks here read bookings, booking_lines, booking_visits, consents, open_questions and outbox_rows as the
// Tool API, and rosie_app reads each of them whole, so part 2 needs none of DL-298's two-column grants (the card's
// exception (5), checked by name below); effects keeps DL-298's two columns, which part 1's checks read.
//
// The rows come only from fixtures (rule 9): K-32 v1's seeds and refused rows and the K-04, K-07, K-23, K-24, K-25,
// K-28, K-29, K-30 and K-33 rows their after chains name (Lee's Barbershop, the yoga studio and the master's sample cast:
// Sam, Alex M., Riley, Avery, Maya, Dee, Ben T., Owen H.). A row made here is a fixture row under a new id, or with one
// fault or change; its Stripe ids are placeholders in K-14's demo form, never a real card, and a pay link's code is the
// seed's demo code or a probe's.
import { createHash } from "node:crypto";
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
 * Part 2's nine tables, in code-unit order (as PostgreSQL orders a relation's name): the four the card names (fees,
 * memberships, packs and credits, with plan_charges and rosfield_fees) and the three neither part's card named
 * (pay_links, reconciliation_runs, reconciliation_findings; DL-298, DL-306).
 */
const OWN_TABLES = [
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
/** Part 1's five tables (migration 0030, T-722), in code-unit order. */
const PART_1_TABLES = ["ledger_lines", "payment_items", "payments", "refunds", "saved_cards"];
/** All fourteen of K-32's tables, in code-unit order. */
const MONEY_TABLES = [...OWN_TABLES, ...PART_1_TABLES].sort();
/** The seven of the nine that are versioned (rule 4). */
const VERSIONED = [
  "booking_fees",
  "credits",
  "memberships",
  "packs",
  "pay_links",
  "plan_charges",
  "reconciliation_runs",
];
/** The two only ever inserted (rule 4; rule 6: no update grant). */
const INSERT_ONLY = ["reconciliation_findings", "rosfield_fees"];
/** Rule 6's UPDATE of named columns only, by table, in the README's order: the same for both roles. */
const COLUMN_UPDATES: Record<string, readonly string[]> = {
  memberships: ["next_charge_on", "status", "paused_at", "ended_at", "ended_why", "version"],
  pay_links: ["given_via", "ended_at", "ended_why", "version"],
  packs: ["credits_used", "version"],
  credits: ["returned_at", "returned_why", "version"],
  booking_fees: [
    "reminded_at",
    "answer",
    "answered_at",
    "answered_by_person_id",
    "answered_by_role",
    "option_id",
    "event_id",
    "state",
    "charged_at",
    "dropped_at",
    "version",
  ],
  plan_charges: [
    "reminder_outbox_row_id",
    "state",
    "skipped_why",
    "charged_at",
    "failed_at",
    "skipped_at",
    "version",
  ],
};
/** Rule 6's runtime-only UPDATE: a run's finish, which only the runtime side writes. */
const RUNTIME_UPDATES: Record<string, readonly string[]> = {
  reconciliation_runs: ["finished_at", "charges_listed", "refunds_listed", "version"],
};
/** Rule 7's set-once lists for part 2's six, in the README's order. */
const SET_ONCE: Record<string, readonly string[]> = {
  memberships: ["ended_at", "ended_why"],
  pay_links: ["given_via", "ended_at", "ended_why"],
  credits: ["returned_at", "returned_why"],
  booking_fees: [
    "reminded_at",
    "answer",
    "answered_at",
    "answered_by_person_id",
    "answered_by_role",
    "option_id",
    "event_id",
    "charged_at",
    "dropped_at",
  ],
  plan_charges: ["reminder_outbox_row_id", "skipped_why", "charged_at", "failed_at", "skipped_at"],
  reconciliation_runs: ["finished_at", "charges_listed", "refunds_listed"],
};
/** Rule 7's set-once tables of part 1 (0030), which with part 2's six make the README's nine. */
const PART_1_SET_ONCE = ["payments", "refunds", "saved_cards"];
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
/** The tables part 2's rule 5 checks read (the card's exception (5)), in code-unit order. */
const RULE_5_READS = [
  "booking_lines",
  "booking_visits",
  "bookings",
  "consents",
  "open_questions",
  "outbox_rows",
];
/** The Tool API policies each of the nine holds, by the command its grants allow (rule 5; rule 6). */
const TOOL_API_COMMANDS: Record<string, readonly string[]> = {
  booking_fees: ["insert", "select", "update"],
  credits: ["insert", "select", "update"],
  memberships: ["insert", "select", "update"],
  packs: ["insert", "select", "update"],
  pay_links: ["insert", "select", "update"],
  plan_charges: ["insert", "select", "update"],
  reconciliation_findings: ["select"],
  reconciliation_runs: ["select"],
  rosfield_fees: ["insert", "select"],
};
/** Part 1's three keys that name part 2's tables, which this part adds (DL-278's way; DL-298). */
const PART_2_KEYS = ["payments_booking_fee_fk", "payments_plan_charge_fk", "saved_cards_membership_fk"];
/** The other tables the nine refer to by their keys (rule 1), in code-unit order: other parts' and part 1's. */
const REFERRED = [
  "booking_lines",
  "booking_visits",
  "bookings",
  "businesses",
  "consents",
  "customers",
  "ledger_lines",
  "open_questions",
  "outbox_rows",
  "payments",
  "persons",
  "refunds",
  "saved_cards",
  "services",
];
/** The Tool API's SELECT of pay_links: every column but code_sha256 (rule 6; refuse-pay-link-code-read). */
const PAY_LINK_SELECTS = [
  "id",
  "business_id",
  "payment_id",
  "person_id",
  "given_via",
  "due_at",
  "sent_at",
  "ended_at",
  "ended_why",
  "version",
];
const FEES_SEED = "seed-fee-rosfield-2.json";
const PACK_SEED = "seed-pack-credits.json";
const MEMBERSHIP_SEED = "seed-membership.json";
/** The card's three seeds. */
const CARD_SEEDS = [FEES_SEED, PACK_SEED, MEMBERSHIP_SEED];
const TWICE_SEED = "seed-fee-charged-twice.json";
const LINK_SEED = "seed-pay-link.json";
/** Part 2's refused rows: the pack over its credits, the $2 edited, the pay link's code read, a fee on silence. */
const PACK_OVER = "invalid/refuse-pack-over-credits.json";
const FEE_UPDATE = "invalid/refuse-rosfield-fee-update.json";
const CODE_READ = "invalid/refuse-pay-link-code-read.json";
const FEE_ON_SILENCE = "invalid/refuse-fee-on-silence.json";
/** K-26's closed registries, written only by migration 0023's own seed (K-26 README rule 5). */
const REGISTRIES = ["plugin_switches", "rule_kinds", "trade_facts"];
const BARBERSHOP = "biz-lees-barbershop";
const YOGA_STUDIO = "biz-yoga-studio";
/** The pay link seed's demo code (README default 21's length; not made with any secret), kept only as its sha256. */
const PAY_LINK_DEMO_CODE = "demoPayLinkCodeAlexHomeGroomingBill00000001";
/** Every money table's rows once all seven seeds are loaded, as the README's round 3 check counts them. */
const SEVEN_SEEDED: Record<string, number> = {
  booking_fees: 1,
  credits: 1,
  ledger_lines: 9,
  memberships: 1,
  packs: 1,
  pay_links: 1,
  payment_items: 3,
  payments: 6,
  plan_charges: 1,
  reconciliation_findings: 1,
  reconciliation_runs: 1,
  refunds: 2,
  rosfield_fees: 3,
  saved_cards: 3,
};
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
/** Part 2's tables as the table list gives them, in its order. */
const OWN = TABLES.filter((table) => OWN_TABLES.includes(table.name));
const INDEX = (readJson(new URL("index.json", FIXTURES_DIR)) as { fixtures: IndexEntry[] }).fixtures;
/** All seven accepted seeds, in the index's order. */
const ALL_SEEDS = INDEX.filter((entry) => entry.expect === "accept").map((entry) => entry.file);
/** The frozen README, whose rules 5 to 7 this part holds word for word. */
const README = readFileSync(new URL("README.md", PART_DIR), "utf8");

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

/** The tables rule 7's bullets name, in the README's order. */
function readmeSetOnceTables(): string[] {
  const start = README.indexOf("7. **Set once, by one trigger function:**");
  const end = README.indexOf("With the CHECKs that hold each state", start);
  return [...README.slice(start, end).matchAll(/^ {3}- `([a-z_]+)`: /gm)].map((match) => match[1] ?? "");
}

/**
 * Rule 5's WITH CHECK for `table` as the README writes it, on the table named `on` (the real one, or a probe copy): the
 * business scope, then each cross-part column the table carries in rule 5's order.
 */
function readmeCheck(table: string, on: string): string {
  const crossPart = RULE_5_COLUMNS.filter(([column]) => columnsOf(table).includes(column)).map(
    ([column, referenced]) =>
      `(${column} is null or exists (select 1 from ${referenced} r where r.id = ${on}.${column} and r.business_id = ${on}.business_id))`,
  );
  return [`business_id = nullif(current_setting('rosie.business_id', true), '')`, ...crossPart].join(" and ");
}

const fixtureFile = (file: string): FixtureFile => readJson(new URL(file, FIXTURES_DIR)) as FixtureFile;

/** The values of the row of `table` whose id is `id`, in a fixture's own rows or those of its after chain. */
function valuesOf(file: string, table: string, id: string): Values {
  const row = rowsOf([file]).find((candidate) => candidate.table === table && candidate.values.id === id);
  if (row === undefined) {
    throw new Error(`${file} and its after chain have no ${table} row with id ${id}`);
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

/** Rows per table of `tables`, every one of them named (0 when none). */
function countsOf(rows: readonly FixtureRow[], tables: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(tables.map((table) => [table, 0]));
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

/** Three digits, from 1. */
const pad = (i: number): string => String(i + 1).padStart(3, "0");

/** The sha256 of a text, in lowercase hex, as a pay link keeps its code's. */
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Seeded rows: Alex's pack and its credit at the yoga studio, with the Hot Flow booking, line and pack charge. */
const PACK = valuesOf(PACK_SEED, "packs", "pack-alex-yoga-5-visits");
const CREDIT = valuesOf(PACK_SEED, "credits", "credit-alex-hot-flow-1");
const HOT_FLOW_BOOKING = valuesOf(PACK_SEED, "bookings", "booking-alex-hot-flow");
const HOT_FLOW_LINE = valuesOf(PACK_SEED, "booking_lines", "line-alex-hot-flow-1");
const PACK_EFFECT = valuesOf(PACK_SEED, "effects", "eff-alex-hot-flow-pack");
const PACK_PAYMENT = valuesOf(PACK_SEED, "payments", "pay-alex-hot-flow-pack");
/** Owen H.'s haircut plan at Lee's Barbershop: its yes, card, Oct 31 charge, payment, effects and reminder. */
const PLAN = valuesOf(MEMBERSHIP_SEED, "memberships", "plan-owen-haircut");
const PLAN_TERMS = valuesOf(MEMBERSHIP_SEED, "consents", "consent-owen-plan-terms");
const PLAN_CARD = valuesOf(MEMBERSHIP_SEED, "saved_cards", "card-owen-plan");
const PLAN_SAVE_EFFECT = valuesOf(MEMBERSHIP_SEED, "effects", "eff-owen-plan-save-card");
const PLAN_CHARGE = valuesOf(MEMBERSHIP_SEED, "plan_charges", "plancharge-owen-2026-10-31");
const PLAN_PAYMENT = valuesOf(MEMBERSHIP_SEED, "payments", "pay-owen-plan-oct31");
const PLAN_EFFECT = valuesOf(MEMBERSHIP_SEED, "effects", "eff-owen-plan-oct31-charge");
const REMINDER = valuesOf(MEMBERSHIP_SEED, "outbox_rows", "out-a7-54-owen-oct31");
/** Ben T.'s $2 at DONE and his trim's visit and booking (K-33's October bill). */
const BEN_FEE = valuesOf(FEES_SEED, "rosfield_fees", "fee-rosfield2-ben-trim");
const BEN_VISIT = valuesOf(FEES_SEED, "booking_visits", "visit-ben-trim-1");
const BEN_BOOKING = valuesOf(FEES_SEED, "bookings", "booking-ben-trim");
/** Dee's late-cancel fee, charged on Sam's yes, its payment and effect, and the daily check that refunded it twice. */
const DEE_FEE = valuesOf(TWICE_SEED, "booking_fees", "fee-dee-late-cancel");
const DEE_FEE_PAYMENT = valuesOf(TWICE_SEED, "payments", "pay-dee-late-cancel-fee");
const DEE_FEE_EFFECT = valuesOf(TWICE_SEED, "effects", "eff-dee-late-cancel-fee");
const RUN = valuesOf(TWICE_SEED, "reconciliation_runs", "recon-lees-barbershop-2026-11-09");
const FINDING = valuesOf(TWICE_SEED, "reconciliation_findings", "finding-2026-11-09-dee-second-charge");
/** Alex's home grooming bill's pay link and its payment. */
const PAY_LINK = valuesOf(LINK_SEED, "pay_links", "link-alex-home-grooming-bill");
const LINK_PAYMENT = valuesOf(LINK_SEED, "payments", "pay-alex-home-grooming-rest");
const PACK_ID = textOf(PACK.id);
/** One seeded row of each of the nine, by table, with the business whose scope reads it. */
const SEEDED_ROW: Record<string, readonly [string, string]> = {
  booking_fees: [textOf(DEE_FEE.id), BARBERSHOP],
  credits: [textOf(CREDIT.id), YOGA_STUDIO],
  memberships: [textOf(PLAN.id), BARBERSHOP],
  packs: [PACK_ID, YOGA_STUDIO],
  pay_links: [textOf(PAY_LINK.id), BARBERSHOP],
  plan_charges: [textOf(PLAN_CHARGE.id), BARBERSHOP],
  reconciliation_findings: [textOf(FINDING.id), BARBERSHOP],
  reconciliation_runs: [textOf(RUN.id), BARBERSHOP],
  rosfield_fees: [textOf(BEN_FEE.id), BARBERSHOP],
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

/**
 * Probe rows for rule 5 and the three keys, committed beside all seven seeds: Alex's own yes to a yoga membership's
 * terms (Owen's words under a new id, K-29 plan_terms), a visit of his Hot Flow class (K-30), and one more Hot Flow
 * booking and line for a credit.
 */
const YOGA_TERMS: Values = {
  ...PLAN_TERMS,
  id: "consent-probe-alex-yoga-plan-terms",
  person_id: "person-alex",
  business_id: YOGA_STUDIO,
  at: "2026-11-05T14:59:00Z",
};
const YOGA_VISIT: Values = {
  ...BEN_VISIT,
  id: "visit-probe-alex-hot-flow-1",
  booking_id: textOf(HOT_FLOW_BOOKING.id),
  business_id: YOGA_STUDIO,
};
const YOGA_BOOKING_2: Values = { ...HOT_FLOW_BOOKING, id: "booking-probe-alex-hot-flow-2" };
const YOGA_LINE_2: Values = {
  ...HOT_FLOW_LINE,
  id: "line-probe-alex-hot-flow-2",
  booking_id: textOf(YOGA_BOOKING_2.id),
};
/** Alex's monthly membership at the yoga studio, bought on the page with its own yes (A5-22): Owen's plan, changed. */
const YOGA_MEMBERSHIP: Values = {
  ...PLAN,
  id: "plan-probe-alex-yoga-monthly",
  business_id: YOGA_STUDIO,
  person_id: "person-alex",
  service_id: "svc-yoga-hot-flow",
  kind: "membership",
  name: "Monthly membership",
  period: "1 month",
  billed: "monthly",
  terms_consent_id: textOf(YOGA_TERMS.id),
  started_on: "2026-11-05",
  renews_on: null,
  next_charge_on: "2026-12-05",
};
/** Its first charge, made with the customer present as it is bought (A5-22): no reminder and no booking. */
const YOGA_FIRST_CHARGE: Values = {
  ...PLAN_CHARGE,
  id: "plancharge-probe-alex-yoga-first",
  business_id: YOGA_STUDIO,
  membership_id: textOf(YOGA_MEMBERSHIP.id),
  booking_id: null,
  period_start: "2026-11-05",
  period_end: "2026-12-04",
  due_on: "2026-11-05",
  reminder_outbox_row_id: null,
  customer_present: true,
  state: "due",
  charged_at: null,
  version: 1,
};
const YOGA_ACCOUNT = { kind: "business", accountId: "stripe-acct-demo-yoga-studio" };
/** A yoga charge effect and a yoga card save effect, for the three keys' probes: the pack's effect under new ids. */
const YOGA_CHARGE_EFFECT = pendingEffect(PACK_EFFECT, "eff-probe-yoga-charge", { amount_cents: 3500 });
const YOGA_SAVE_EFFECT = pendingEffect(PLAN_SAVE_EFFECT, "eff-probe-yoga-save-card", {
  business_id: YOGA_STUDIO,
  person_id: "person-alex",
  port_request: { account: YOGA_ACCOUNT, customerId: null },
});
/** A yoga card payment that failed (so no one-live index speaks), to be pointed at a fee or a plan charge. */
const YOGA_FAILED_PAYMENT: Values = {
  ...PACK_PAYMENT,
  id: "pay-probe-yoga-failed",
  amount_cents: 3500,
  state: "failed",
  effect_id: textOf(YOGA_CHARGE_EFFECT.id),
  paid_at: null,
  failed_at: "2026-11-05T15:00:02Z",
  failed_why: "declined",
  version: 1,
};
/** A card saved on the yoga studio's Stripe for a membership: Owen's plan card under a new id. */
const YOGA_PLAN_CARD: Values = {
  ...PLAN_CARD,
  id: "card-probe-alex-yoga-plan",
  business_id: YOGA_STUDIO,
  person_id: "person-alex",
  booking_id: null,
  membership_id: textOf(YOGA_MEMBERSHIP.id),
  stripe_customer_id: "stripe-customer-demo-alex-yoga-studio",
  stripe_payment_method_id: "stripe-card-demo-alex-yoga-studio",
  save_effect_id: textOf(YOGA_SAVE_EFFECT.id),
};

/** Thrown to roll a check's transaction back with its answer. */
class RolledBack extends Error {
  constructor(readonly answer: unknown) {
    super("rolled back on purpose");
  }
}

/** Refused by the compare-and-set: the pack's version moved since it was read, so the commit writes nothing. */
class VersionMoved extends Error {
  constructor() {
    super("the pack's version moved since it was read");
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

/** Inserts one row and gives back its id and business as stored. */
async function insertReturning(
  tx: Tx,
  table: string,
  values: Values,
): Promise<{ id: string; business: string }[]> {
  return tx<{ id: string; business: string }[]>`
    insert into ${tx(table)} ${tx(columnValues(tx, table, values))} returning id, business_id as business
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
 * names), cascades to the rest, the fourteen money tables and effects included (this file's schema only). K-26's
 * registries stay.
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
 * fourteen and of effects) and compared on the server in the column's own type.
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

/** Rows of each of `tables` whose business is `businessId`, read as the owner. */
async function ownerRowsOf(businessId: string, tables: readonly string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const [row] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from ${db.sql(table)} where business_id = ${businessId}
    `;
    counts[table] = row?.n ?? -1;
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

beforeAll(async () => {
  // 20 connections, so the 50 parallel uses below meet each other in the database, not in the pool's queue alone.
  db = await createTestDatabase({ name: "money_2", client: { max: 20 } });
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

describe("the migration against the frozen table list (K-32 v1): part 2's nine tables", () => {
  /** The table list's types as format_type prints them; the others print as the list writes them. */
  const typeNames: Record<string, string> = { timestamptz: "timestamp with time zone" };

  it("the table list names 14 tables, each scoped by business on business_id with no effective dates: part 1's five and part 2's nine are all in the schema now; seven of the nine are versioned (rule 4), and rosfield_fees and reconciliation_findings carry no version", async () => {
    expect(TABLES.map((table) => table.name).sort()).toEqual(MONEY_TABLES);
    expect(OWN.map((table) => table.name).sort()).toEqual(OWN_TABLES);
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
      where c.relnamespace = ${db.schema}::regnamespace and c.relkind = 'r' and c.relname in ${db.sql(MONEY_TABLES)}
    `;
    expect(found.map((row) => row.name).sort()).toEqual(MONEY_TABLES);
  });

  it("is recorded in schema_migrations as money_fees_packs, right after part 1's money_payments_ledger (T-722), so after effects_provider_events (K-07), consent (K-29), services_prices (K-25), customers (K-28), platform_billing (K-33) and both K-30 parts", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    const part1 = names.indexOf("money_payments_ledger");
    expect(part1).toBeGreaterThan(-1);
    expect(names.indexOf("money_fees_packs")).toBe(part1 + 1);
    for (const before of [
      "effects_provider_events",
      "consent",
      "services_prices",
      "customers",
      "platform_billing",
      "bookings_changes_details",
      "bookings_changes_quotes_links",
    ]) {
      expect(names.indexOf(before), before).toBeGreaterThan(-1);
      expect(part1, before).toBeGreaterThan(names.indexOf(before));
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

    it(`${table.name}: primary key, foreign keys with no schema prefix and their on delete, unique rules (one with a where as a partial unique index) and index names are the table list's`, async () => {
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
      const unique = table.unique ?? [];
      const plain = unique.filter((rule) => rule.where === undefined);
      expect(named("c")).toEqual((table.checks ?? []).map((check) => check.name).sort());
      expect(named("f")).toEqual(table.foreignKeys.map((key) => key.name).sort());
      expect(named("u")).toEqual(plain.map((rule) => rule.name).sort());
      expect(named("x")).toEqual([]);
      for (const key of table.foreignKeys) {
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

  it("rule 1's order and DL-278's way: part 1's three keys that name part 2's tables, saved_cards_membership_fk, payments_booking_fee_fk and payments_plan_charge_fk, are added once those tables exist, as the table list writes them; every key of the nine and of part 1's five is checked against every row (none NOT VALID)", async () => {
    const keys = await db.sql<{ table: string; name: string; definition: string; validated: boolean }[]>`
      select c.relname as table, k.conname as name, pg_get_constraintdef(k.oid) as definition,
             k.convalidated as validated
      from pg_constraint k join pg_class c on c.oid = k.conrelid
      where k.contype = 'f' and c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(MONEY_TABLES)}
    `;
    expect(keys.filter((key) => !key.validated).map((key) => key.name)).toEqual([]);
    const listed = TABLES.flatMap((table) =>
      table.foreignKeys
        .filter((key) => PART_2_KEYS.includes(key.name))
        .map(
          (key) =>
            `${table.name} FOREIGN KEY (${key.columns.join(", ")}) REFERENCES ${key.references.table}(${key.references.columns.join(", ")}) ON DELETE ${key.onDelete.toUpperCase()}`,
        ),
    ).sort();
    expect(listed).toEqual([
      "payments FOREIGN KEY (booking_fee_id, business_id) REFERENCES booking_fees(id, business_id) ON DELETE RESTRICT",
      "payments FOREIGN KEY (plan_charge_id, business_id) REFERENCES plan_charges(id, business_id) ON DELETE RESTRICT",
      "saved_cards FOREIGN KEY (membership_id, business_id) REFERENCES memberships(id, business_id) ON DELETE RESTRICT",
    ]);
    expect(
      keys
        .filter((key) => PART_2_KEYS.includes(key.name))
        .map((key) => `${key.table} ${key.definition}`)
        .sort(),
    ).toEqual(listed);
    expect(
      keys
        .filter((key) => PART_2_KEYS.includes(key.name))
        .map((key) => key.name)
        .sort(),
    ).toEqual(PART_2_KEYS);
  });

  it("the nine refer to other tables only by their keys (rule 1): K-04's businesses, persons, bookings, open_questions and outbox_rows, K-25's services and K-28's customers (by their business), K-29's consents, K-30's booking_lines and booking_visits (a visit with its booking), and part 1's payments, saved_cards, ledger_lines and refunds (by their business); among themselves by (id, business_id); of every other table only part 1's saved_cards and payments refer to them, by the three keys", async () => {
    const keys = await db.sql<{ table: string; name: string; referenced: string; definition: string }[]>`
      select src.relname as table, k.conname as name, dst.relname as referenced,
             pg_get_constraintdef(k.oid) as definition
      from pg_constraint k
        join pg_class src on src.oid = k.conrelid
        join pg_class dst on dst.oid = k.confrelid
      where k.contype = 'f' and src.relnamespace = ${db.schema}::regnamespace and src.relname in ${db.sql(OWN_TABLES)}
    `;
    expect(keys.map((key) => `${key.table} ${key.name} ${key.referenced}`).sort()).toEqual(
      OWN.flatMap((table) =>
        table.foreignKeys.map((key) => `${table.name} ${key.name} ${key.references.table}`),
      ).sort(),
    );
    expect(
      [...new Set(keys.map((key) => key.referenced))].filter((name) => !OWN_TABLES.includes(name)).sort(),
    ).toEqual(REFERRED);
    const composite = /^FOREIGN KEY \(\w+, business_id\) REFERENCES \w+\(id, business_id\)/;
    const inside = keys.filter((key) => OWN_TABLES.includes(key.referenced));
    expect(inside.map((key) => key.name).sort()).toEqual([
      "booking_fees_credit_fk",
      "credits_membership_fk",
      "credits_pack_fk",
      "plan_charges_membership_fk",
      "reconciliation_findings_run_fk",
      "rosfield_fees_plan_charge_fk",
    ]);
    const toPart1 = keys.filter((key) => PART_1_TABLES.includes(key.referenced));
    expect(toPart1.map((key) => key.name).sort()).toEqual([
      "booking_fees_from_payment_fk",
      "booking_fees_saved_card_fk",
      "packs_payment_fk",
      "pay_links_payment_fk",
      "reconciliation_findings_line_fk",
      "reconciliation_findings_refund_fk",
    ]);
    for (const key of [...inside, ...toPart1]) {
      expect(key.definition, key.name).toMatch(composite);
    }
    expect(
      keys
        .filter((key) => ["customers", "services", "booking_visits"].includes(key.referenced))
        .map((key) => `${key.name} ${key.definition.replace(/ ON DELETE RESTRICT$/, "")}`)
        .sort(),
    ).toEqual([
      "booking_fees_visit_fk FOREIGN KEY (visit_id, booking_id) REFERENCES booking_visits(id, booking_id)",
      "memberships_customer_fk FOREIGN KEY (business_id, person_id) REFERENCES customers(business_id, person_id)",
      "memberships_service_fk FOREIGN KEY (service_id, business_id) REFERENCES services(id, business_id)",
      "packs_customer_fk FOREIGN KEY (business_id, person_id) REFERENCES customers(business_id, person_id)",
      "packs_service_fk FOREIGN KEY (service_id, business_id) REFERENCES services(id, business_id)",
      "rosfield_fees_visit_fk FOREIGN KEY (visit_id, booking_id) REFERENCES booking_visits(id, booking_id)",
    ]);
    const into = await db.sql<{ table: string; name: string }[]>`
      select src.relname as table, k.conname as name from pg_constraint k
        join pg_class src on src.oid = k.conrelid
        join pg_class dst on dst.oid = k.confrelid
      where k.contype = 'f' and dst.relnamespace = ${db.schema}::regnamespace and dst.relname in ${db.sql(OWN_TABLES)}
        and src.relname not in ${db.sql(OWN_TABLES)}
      order by 2
    `;
    expect(into).toEqual([
      { table: "payments", name: "payments_booking_fee_fk" },
      { table: "payments", name: "payments_plan_charge_fk" },
      { table: "saved_cards", name: "saved_cards_membership_fk" },
    ]);
  });

  it("versions and set once (rules 4 and 7): <table>_version_raised on the seven versioned tables and <table>_set_once on the six rule 7 lists here, each with its list in the README's order, all BEFORE UPDATE FOR EACH ROW; packs holds only its version trigger, and rosfield_fees and reconciliation_findings hold none; with part 1's three, rule 7's nine tables are the README's", async () => {
    const triggers = await db.sql<{ table: string; name: string; definition: string }[]>`
      select c.relname as table, t.tgname as name, pg_get_triggerdef(t.oid) as definition
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)} and not t.tgisinternal
    `;
    expect(triggers.map((trigger) => `${trigger.table} ${trigger.name}`).sort()).toEqual(
      [
        ...VERSIONED.map((table) => `${table} ${table}_version_raised`),
        ...Object.keys(SET_ONCE).map((table) => `${table} ${table}_set_once`),
      ].sort(),
    );
    const byName = (name: string): string =>
      triggers.find((trigger) => trigger.name === name)?.definition ?? "";
    for (const table of VERSIONED) {
      expect(byName(`${table}_version_raised`), table).toContain("BEFORE UPDATE ON");
      expect(byName(`${table}_version_raised`), table).toContain(
        "FOR EACH ROW EXECUTE FUNCTION enforce_version_raise()",
      );
    }
    for (const [table, list] of Object.entries(SET_ONCE)) {
      expect(readmeSetOnce(table), table).toEqual(list);
      expect(byName(`${table}_set_once`), table).toContain("BEFORE UPDATE ON");
      expect(byName(`${table}_set_once`), table).toContain(
        `FOR EACH ROW EXECUTE FUNCTION money_set_once(${list.map((column) => `'${column}'`).join(", ")})`,
      );
    }
    expect(readmeSetOnceTables().sort()).toEqual([...Object.keys(SET_ONCE), ...PART_1_SET_ONCE].sort());
  });

  it("rule 7's set-once triggers run 0030's money_set_once(), which part 2 does not make again: it is the money part's only function, plpgsql, security invoker, owned by the migrations' role, and every one of the nine set-once triggers calls it", async () => {
    const functions = await db.sql<
      {
        name: string;
        language: string;
        definer: boolean;
        owner: string;
        me: string;
        config: string[] | null;
      }[]
    >`
      select p.proname as name, l.lanname as language, p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner,
             current_user as me, p.proconfig as config
      from pg_proc p join pg_language l on l.oid = p.prolang
      where p.pronamespace = ${db.schema}::regnamespace
        and (p.proname like 'money%' or p.proname like any (${MONEY_TABLES.map((table) => `${table}%`)}::text[]))
    `;
    expect(functions.map((fn) => [fn.name, fn.language, fn.definer, fn.owner === fn.me, fn.config])).toEqual([
      ["money_set_once", "plpgsql", false, true, null],
    ]);
    const callers = await db.sql<{ name: string }[]>`
      select t.tgname as name from pg_trigger t join pg_proc p on p.oid = t.tgfoid
      where p.pronamespace = ${db.schema}::regnamespace and p.proname = 'money_set_once' and not t.tgisinternal
      order by 1
    `;
    expect(callers.map((caller) => caller.name)).toEqual(
      [...Object.keys(SET_ONCE), ...PART_1_SET_ONCE].map((table) => `${table}_set_once`).sort(),
    );
  });

  it("money and times (rule 9; CQ-09): every amount of the nine is bigint minor units beside a not-null three-letter currency text (Rosfield's fees USD only), never a decimal, float or money type; counts are integers; ids are text, every instant timestamptz and every day a date", () => {
    const own = [...typeOf.entries()].filter(([key]) => OWN_TABLES.includes(key.split(".")[0] ?? ""));
    expect(own).toHaveLength(OWN.reduce((sum, table) => sum + table.columns.length, 0));
    expect(
      own
        .filter(([, type]) =>
          ["bigint", "numeric", "real", "double precision", "money", "integer", "smallint"].includes(type),
        )
        .map(([key, type]) => `${key} ${type}`)
        .sort(),
    ).toEqual([
      "booking_fees.amount_cents bigint",
      "booking_fees.version integer",
      "credits.units integer",
      "credits.version integer",
      "memberships.price_cents bigint",
      "memberships.version integer",
      "memberships.visits_per_period integer",
      "packs.credits_total integer",
      "packs.credits_used integer",
      "packs.price_cents bigint",
      "packs.version integer",
      "pay_links.version integer",
      "plan_charges.amount_cents bigint",
      "plan_charges.version integer",
      "reconciliation_runs.charges_listed integer",
      "reconciliation_runs.refunds_listed integer",
      "reconciliation_runs.version integer",
      "rosfield_fees.amount_cents bigint",
      "rosfield_fees.plan_charge_cents bigint",
    ]);
    const moneyChecks: Record<string, string> = {
      booking_fees: "amount_cents > 0 and currency ~ '^[A-Z]{3}$'",
      memberships: "price_cents > 0 and currency ~ '^[A-Z]{3}$'",
      packs: "price_cents >= 0 and currency ~ '^[A-Z]{3}$'",
      plan_charges: "amount_cents > 0 and currency ~ '^[A-Z]{3}$'",
      rosfield_fees: "amount_cents >= 0 and currency = 'USD'",
    };
    expect(
      OWN.filter((table) => table.columns.some((column) => column.name.endsWith("_cents")))
        .map((table) => table.name)
        .sort(),
    ).toEqual(Object.keys(moneyChecks).sort());
    for (const [table, expression] of Object.entries(moneyChecks)) {
      expect([
        typeOf.get(`${table}.currency`),
        tableOf(table).columns.find((c) => c.name === "currency")?.null,
      ]).toEqual(["text", false]);
      expect(
        (tableOf(table).checks ?? []).find((check) => check.name === `${table}_money`)?.expression,
        table,
      ).toBe(expression);
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
    expect(
      own
        .filter(([, type]) => type === "date")
        .map(([key]) => key)
        .sort(),
    ).toEqual([
      "memberships.next_charge_on",
      "memberships.renews_on",
      "memberships.started_on",
      "plan_charges.due_on",
      "plan_charges.period_end",
      "plan_charges.period_start",
      "rosfield_fees.month",
    ]);
  });

  it("neither role owns any of the nine: they stay the migrations' role's, so neither can alter, drop or disable a table, its policies or its triggers (rule 6)", async () => {
    const owners = await db.sql<{ name: string; owner: string; me: string }[]>`
      select c.relname as name, pg_get_userbyid(c.relowner) as owner, current_user as me from pg_class c
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
    `;
    expect(owners.map((row) => row.name).sort()).toEqual(OWN_TABLES);
    for (const row of owners) {
      expect(row.owner, row.name).toBe(row.me);
      expect(ROLES, row.name).not.toContain(row.owner);
    }
  });
});

describe("row-level security, policies and grants in the catalog (README rules 5 and 6; the card's exceptions (1) to (5))", () => {
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

  it("row-level security is on for all nine, and forced on none", async () => {
    const flags = await db.sql<{ name: string; on: boolean; forced: boolean }[]>`
      select relname as name, relrowsecurity as on, relforcerowsecurity as forced from pg_class
      where relnamespace = ${db.schema}::regnamespace and relname in ${db.sql(OWN_TABLES)}
      order by relname
    `;
    expect(flags).toEqual(OWN_TABLES.map((name) => ({ name, on: true, forced: false })));
  });

  it("exception (1): each holds 0012's <table>_runtime for rosie_job word for word (read from outbox_rows', which keys on the same column) beside one Tool API policy per command its grants allow: _select reads only its scope; _insert, and _update where an update is granted, hold the scope and rule 5's cross-part checks in WITH CHECK, as PostgreSQL reads the README's words, each by name; none of those checks is in any USING; none for delete", async () => {
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
      }
    }
    // The cross-part checks the card names for part 2, by table and column (rule 5's order).
    const checked = Object.fromEntries(
      OWN_TABLES.filter((table) => (TOOL_API_COMMANDS[table] ?? []).includes("insert")).map((table) => [
        table,
        RULE_5_COLUMNS.filter(([column]) => columnsOf(table).includes(column)).map(([column]) => column),
      ]),
    );
    expect(checked).toEqual({
      booking_fees: ["booking_id", "visit_id", "open_question_id"],
      credits: ["booking_line_id"],
      memberships: ["terms_consent_id"],
      packs: [],
      pay_links: [],
      plan_charges: ["booking_id", "reminder_outbox_row_id"],
      rosfield_fees: ["booking_id", "visit_id"],
    });
    expect(policies.filter((policy) => policy.command === "DELETE")).toEqual([]);
  });

  it("exception (3), table grants (rule 6): both roles select and insert memberships, packs, credits, booking_fees, plan_charges and rosfield_fees (rosfield_fees insert only); pay_links is the runtime side's to select and insert and the Tool API's to insert, its read being a column grant; reconciliation_runs and reconciliation_findings are the Tool API's to select only and the runtime side's to select and insert; every UPDATE is a column grant; no delete, truncate, references or trigger for either role; nothing to PUBLIC or any other grantee", async () => {
    const held = await db.sql<{ role: string; table: string; privilege: string }[]>`
      select r.role, c.relname as table, p.privilege
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_class c
        cross join unnest(${PRIVILEGES}::text[]) as p(privilege)
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and has_table_privilege(r.role, c.oid, p.privilege)
    `;
    const privileges = (role: Role, table: string): string[] => {
      if (["reconciliation_findings", "reconciliation_runs"].includes(table)) {
        return role === TOOL_API ? ["SELECT"] : ["INSERT", "SELECT"];
      }
      if (table === "pay_links" && role === TOOL_API) {
        return ["INSERT"];
      }
      return ["INSERT", "SELECT"];
    };
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

  it("exceptions (2) and (3), column grants (rule 6): both roles' UPDATE of rule 6's named columns of memberships, pay_links, packs, credits, booking_fees and plan_charges, the runtime side's of reconciliation_runs' finish, and the Tool API's SELECT of every pay_links column but code_sha256, every grantee on the nine held to exactly them; has_column_privilege agrees, column by column: no price, period, terms, count total, amount, source or customer_present is updatable, nothing of rosfield_fees or reconciliation_findings, and no code hash is the Tool API's to read", async () => {
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
      [
        ...Object.entries(COLUMN_UPDATES).flatMap(([table, columns]) =>
          columns.flatMap((column) =>
            ROLES.map((grantee) => key({ table, column, grantee, privilege: "UPDATE" })),
          ),
        ),
        ...Object.entries(RUNTIME_UPDATES).flatMap(([table, columns]) =>
          columns.map((column) => key({ table, column, grantee: RUNTIME, privilege: "UPDATE" })),
        ),
        ...PAY_LINK_SELECTS.map((column) =>
          key({ table: "pay_links", column, grantee: TOOL_API, privilege: "SELECT" }),
        ),
      ].sort(),
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
      const ordered = (list: readonly string[]): string[] =>
        columnsOf(table).filter((column) => list.includes(column));
      const both = ordered(COLUMN_UPDATES[table] ?? []);
      const runtimeOnly = ordered(RUNTIME_UPDATES[table] ?? []);
      expect(updatable, table).toEqual([
        ...both.map((column) => ({ role: TOOL_API, column })),
        ...[...both, ...runtimeOnly].map((column) => ({ role: RUNTIME, column })),
      ]);
    }
    const readable = await db.sql<{ role: string; column: string }[]>`
      select r.role, a.attname as column
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_attribute a
      where a.attrelid = ${`${db.schema}.pay_links`}::regclass and a.attnum > 0 and not a.attisdropped
        and has_column_privilege(r.role, a.attrelid, a.attnum, 'SELECT')
      order by 1, a.attnum
    `;
    expect(readable.filter((row) => row.role === TOOL_API).map((row) => row.column)).toEqual(
      PAY_LINK_SELECTS,
    );
    expect(readable.filter((row) => row.role === RUNTIME).map((row) => row.column)).toEqual(
      columnsOf("pay_links"),
    );
    expect(columnsOf("pay_links").filter((column) => !PAY_LINK_SELECTS.includes(column))).toEqual([
      "code_sha256",
    ]);
    for (const [table, columns] of [
      [
        "memberships",
        ["price_cents", "currency", "period", "billed", "terms_consent_id", "person_id", "service_id"],
      ],
      ["packs", ["credits_total", "price_cents", "payment_id", "bought_via"]],
      ["credits", ["pack_id", "membership_id", "booking_line_id", "units"]],
      [
        "booking_fees",
        ["amount_cents", "comes_from", "from_payment_id", "saved_card_id", "credit_id", "kind"],
      ],
      ["plan_charges", ["amount_cents", "membership_id", "period_start", "customer_present", "booking_id"]],
      ["pay_links", ["code_sha256", "payment_id", "person_id", "due_at"]],
    ] as const) {
      for (const column of columns) {
        expect(COLUMN_UPDATES[table], `${table}.${column}`).not.toContain(column);
      }
    }
  });

  it("exception (5) needs no grant here (DL-298's form; DL-306): the Tool API already reads whole every table part 2's rule 5 checks read: bookings, booking_lines, booking_visits, consents, open_questions and outbox_rows; effects keeps DL-298's two columns alone (part 1's checks), and provider_events nothing", async () => {
    const held = await db.sql<{ table: string; select: boolean }[]>`
      select c.relname as table, has_table_privilege(${TOOL_API}, c.oid, 'SELECT') as select
      from pg_class c where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(RULE_5_READS)}
      order by 1
    `;
    expect(held).toEqual(RULE_5_READS.map((table) => ({ table, select: true })));
    expect(
      [
        ...new Set(
          OWN_TABLES.filter((table) => (TOOL_API_COMMANDS[table] ?? []).includes("insert")).flatMap((table) =>
            RULE_5_COLUMNS.filter(([column]) => columnsOf(table).includes(column)).map(
              ([, referenced]) => referenced,
            ),
          ),
        ),
      ].sort(),
    ).toEqual(RULE_5_READS);
    const effects = await db.sql<{ column: string; privilege: string }[]>`
      select a.attname as column, p.privilege
      from pg_attribute a cross join unnest(${["SELECT", "INSERT", "UPDATE", "REFERENCES"]}::text[]) as p(privilege)
      where a.attrelid = ${`${db.schema}.effects`}::regclass and a.attnum > 0 and not a.attisdropped
        and has_column_privilege(${TOOL_API}, a.attrelid, a.attnum, p.privilege)
      order by a.attnum, 2
    `;
    expect(effects).toEqual([
      { column: "id", privilege: "SELECT" },
      { column: "business_id", privilege: "SELECT" },
    ]);
    const [events] = await db.sql<{ any: boolean }[]>`
      select has_any_column_privilege(${TOOL_API}, ${`${db.schema}.provider_events`}, 'SELECT, INSERT, UPDATE, REFERENCES') as any
    `;
    expect(events?.any).toBe(false);
  });
});

describe("the seed fixtures load (fixtures/index.json): the card's three, seed-fee-rosfield-2.json, seed-pack-credits.json and seed-membership.json, and all seven together", () => {
  /** The fourteen money tables and effects, whose seeded rows are checked column by column. */
  const LOADED_TABLES = [...MONEY_TABLES, "effects"];

  it("the index lists seven seeds and nine refused rows, all K-32 v1; the card's three are rosfield_fees', packs' and memberships'; the other part 2 seeds are reconciliation_runs' (seed-fee-charged-twice) and pay_links' (seed-pay-link); part 2's refused rows are packs', rosfield_fees', pay_links' and booking_fees'", () => {
    expect(ALL_SEEDS).toHaveLength(7);
    expect(INDEX.filter((entry) => entry.expect === "refuse")).toHaveLength(9);
    expect(INDEX.every((entry) => entry.version === "v1")).toBe(true);
    expect(
      [...CARD_SEEDS, TWICE_SEED, LINK_SEED, PACK_OVER, FEE_UPDATE, CODE_READ, FEE_ON_SILENCE].map((file) => {
        const entry = INDEX.find((candidate) => candidate.file === file);
        return [file, entry?.table, entry?.expect];
      }),
    ).toEqual([
      [FEES_SEED, "rosfield_fees", "accept"],
      [PACK_SEED, "packs", "accept"],
      [MEMBERSHIP_SEED, "memberships", "accept"],
      [TWICE_SEED, "reconciliation_runs", "accept"],
      [LINK_SEED, "pay_links", "accept"],
      [PACK_OVER, "packs", "refuse"],
      [FEE_UPDATE, "rosfield_fees", "refuse"],
      [CODE_READ, "pay_links", "refuse"],
      [FEE_ON_SILENCE, "booking_fees", "refuse"],
    ]);
  });

  for (const file of CARD_SEEDS) {
    it(
      `${file} inserts alone with its after chain, whole, as the runtime side: every row of the fourteen money tables and of effects is stored as given`,
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
        expect(chain.filter((row) => OWN_TABLES.includes(row.table)).length, file).toBeGreaterThan(0);
        for (const row of chain) {
          await expectStored(row);
        }
      },
    );
  }

  it(
    "the card's three insert together, each after chain once: three $2s, the pack with its credit, its payment and charge line, and the plan with its card, its charge naming its reminder, the charge's payment and line; every row stored as given",
    SLOW,
    async () => {
      await reset();
      const loaded = await loadFixtures(CARD_SEEDS);
      const rows = rowsOf(CARD_SEEDS).filter((row) => LOADED_TABLES.includes(row.table));
      const want = {
        booking_fees: 0,
        credits: 1,
        ledger_lines: 2,
        memberships: 1,
        packs: 1,
        pay_links: 0,
        payment_items: 0,
        payments: 2,
        plan_charges: 1,
        reconciliation_findings: 0,
        reconciliation_runs: 0,
        refunds: 0,
        rosfield_fees: 3,
        saved_cards: 1,
      };
      expect(countsOf(rows, MONEY_TABLES)).toEqual(want);
      expect(Object.fromEntries(MONEY_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(want);
      expect(await rowsIn(db.sql, MONEY_TABLES)).toEqual(want);
      expect(await countRows(db.sql, "effects")).toBe(countsOf(rows, ["effects"]).effects);
      for (const row of rows) {
        await expectStored(row);
      }
    },
  );

  it(
    "all seven insert together, each after chain once, and every one of the fourteen tables holds seed rows, as the README's round 3 check counts them: memberships 1, saved_cards 3, payments 6, payment_items 3, ledger_lines 9, refunds 2, pay_links 1, packs 1, credits 1, booking_fees 1, plan_charges 1, rosfield_fees 3, reconciliation_runs 1, reconciliation_findings 1; every row stored as given",
    SLOW,
    async () => {
      await reset();
      const loaded = await loadFixtures(ALL_SEEDS);
      const rows = rowsOf(ALL_SEEDS).filter((row) => LOADED_TABLES.includes(row.table));
      expect(countsOf(rows, MONEY_TABLES)).toEqual(SEVEN_SEEDED);
      expect(Object.fromEntries(MONEY_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(
        SEVEN_SEEDED,
      );
      expect(await rowsIn(db.sql, MONEY_TABLES)).toEqual(SEVEN_SEEDED);
      for (const row of rows) {
        await expectStored(row);
      }
    },
  );
});

describe("with all seven seeds loaded (and, for rule 5, the yoga studio's probe rows: Alex's own yes, a Hot Flow visit and a second Hot Flow line)", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(ALL_SEEDS);
    await committedAs(RUNTIME, async (tx) => {
      await insertRow(tx, "consents", YOGA_TERMS);
      await insertRow(tx, "booking_visits", YOGA_VISIT);
      await insertRow(tx, "bookings", YOGA_BOOKING_2);
      await insertRow(tx, "booking_lines", YOGA_LINE_2);
    });
  }, 120_000);

  describe("the seeded rows read back", () => {
    it("seed-pack-credits: Alex's pack of 5 visits, $160, bought on the yoga studio's page through its own payment (purpose pack, no booking, paid) and charged once; 1 of 5 used, by the one live credit that pays the Hot Flow class's line, paid by credit and of the pack's own service: 4 left", async () => {
      const [pack] = await db.sql<Record<string, unknown>[]>`
        select k.name, k.unit, k.credits_total as total, k.credits_used as used, k.credits_total - k.credits_used as "left",
               k.price_cents::text as price, k.bought_via as via, p.purpose, p.state, p.booking_id as "paymentBooking",
               p.amount_cents = k.price_cents as "paidThePrice", c.units, l.paid_by as "paidBy",
               l.service_id = k.service_id as "ownService", c.returned_at as returned
        from packs k
          join payments p on p.id = k.payment_id
          join credits c on c.pack_id = k.id
          join booking_lines l on l.id = c.booking_line_id
        where k.id = ${PACK_ID}
      `;
      expect(pack).toEqual({
        name: "Pack of 5 visits",
        unit: "visit",
        total: 5,
        used: 1,
        left: 4,
        price: "16000",
        via: "rosie",
        purpose: "pack",
        state: "paid",
        paymentBooking: null,
        paidThePrice: true,
        units: 1,
        paidBy: "credit",
        ownService: true,
        returned: null,
      });
    });

    it("seed-membership: Owen H.'s haircut plan, $35 a visit every 28 days, paid by the visit, renewing Sat Dec 26, with its own yes (a plan_terms consent of its business, named, never copied); its card names the plan (saved_cards_membership_fk); the Oct 31 charge names its delivered reminder and was charged when its payment was paid; that payment names the charge (payments_plan_charge_fk), runs from its own stripe_charge effect and has one charge line", async () => {
      const [plan] = await db.sql<Record<string, unknown>[]>`
        select m.kind, m.billed, m.price_cents::text as price, m.period::text as period, m.status,
               m.renews_on::text as renews, t.kind as "yesKind", t.business_id = m.business_id as "ownYes",
               s.stripe_payment_method_id as card, pc.state as "chargeState", pc.customer_present as present,
               o.state as "reminderState", pc.charged_at = p.paid_at as "chargedWhenPaid", p.purpose,
               p.state as "paymentState", p.saved_card_id = s.id as "onThePlansCard", e.id as effect,
               e.kind as "effectKind", l.kind as "lineKind", l.amount_cents::text as "lineAmount"
        from memberships m
          join consents t on t.id = m.terms_consent_id
          join saved_cards s on s.membership_id = m.id
          join plan_charges pc on pc.membership_id = m.id
          join outbox_rows o on o.id = pc.reminder_outbox_row_id
          join payments p on p.plan_charge_id = pc.id
          join effects e on e.id = p.effect_id
          join ledger_lines l on l.payment_id = p.id
        where m.id = ${textOf(PLAN.id)}
      `;
      expect(plan).toEqual({
        kind: "plan",
        billed: "per_visit",
        price: "3500",
        period: "28 days",
        status: "active",
        renews: "2026-12-26",
        yesKind: "plan_terms",
        ownYes: true,
        card: "stripe-card-demo-owen",
        chargeState: "charged",
        present: false,
        reminderState: "delivered",
        chargedWhenPaid: true,
        purpose: "plan_charge",
        paymentState: "paid",
        onThePlansCard: true,
        effect: textOf(PLAN_EFFECT.id),
        effectKind: "stripe_charge",
        lineKind: "charge",
        lineAmount: "3500",
      });
      expect([textOf(PLAN_PAYMENT.plan_charge_id), textOf(PLAN_CHARGE.reminder_outbox_row_id)]).toEqual([
        textOf(PLAN_CHARGE.id),
        textOf(REMINDER.id),
      ]);
    });

    it("seed-fee-rosfield-2: Lee's Barbershop's three $2s of October, each exactly 200 cents in USD, one per booking, counted at the first check-in code or at DONE toward the person who gave the work, in the month 2026-10-01; each is named by one line of K-33's October bill", async () => {
      const fees = await db.sql<Record<string, unknown>[]>`
        select f.id, f.kind, f.amount_cents::text as amount, f.currency, f.month::text as month, f.counted_by as "countedBy",
               f.counts_for_person_id as "countsFor", f.plan_charge_id as "planCharge",
               (select count(*)::int from monthly_bill_lines b where b.fee_id = f.id) as "billLines"
        from rosfield_fees f order by f.id
      `;
      const fee = (id: string, countedBy: string, countsFor: string): Record<string, unknown> => ({
        id,
        kind: "rosfield_2",
        amount: "200",
        currency: "USD",
        month: "2026-10-01",
        countedBy,
        countsFor,
        planCharge: null,
        billLines: 1,
      });
      expect(fees).toEqual([
        fee("fee-rosfield2-alex-haircut", "check_in_code", "person-riley"),
        fee("fee-rosfield2-ben-trim", "done", "person-avery"),
        fee("fee-rosfield2-owen-plan-oct31", "done", "person-riley"),
      ]);
    });

    it("seed-fee-charged-twice: Dee's late-cancel fee, taken only on Sam's yes (K-08's ownerYes shape), charged to her saved card by a payment naming the fee (payments_booking_fee_fk) and kept charged; the 03:00 UTC check over the last 48 hours found the second charge, wrote its line and refunded it at once as a double charge naming no payment, with a new refund line, and recorded the finding, not for the team", async () => {
      const [fee] = await db.sql<Record<string, unknown>[]>`
        select f.kind, f.state, f.answer, f.answered_by_role as role, f.comes_from as "comesFrom",
               f.charged_at = p.paid_at as "chargedWhenPaid", p.purpose, p.state as "paymentState",
               p.saved_card_id = f.saved_card_id as "onItsCard",
               extract(epoch from r.window_to - r.window_from)::int / 3600 as hours, r.charges_listed as charges,
               r.refunds_listed as refunds, x.kind as finding, x.to_team as "toTeam", x.effect_id = p.effect_id as "sameEffect",
               rf.reason, rf.decided_by as "decidedBy", rf.payment_id as "refundPayment", n.kind as "newLine"
        from booking_fees f
          join payments p on p.booking_fee_id = f.id
          join reconciliation_runs r on r.business_id = f.business_id
          join reconciliation_findings x on x.run_id = r.id
          join refunds rf on rf.id = x.refund_id
          join ledger_lines n on n.refund_id = rf.id
        where f.id = ${textOf(DEE_FEE.id)}
      `;
      expect(fee).toEqual({
        kind: "late_cancel",
        state: "charged",
        answer: "charge",
        role: "owner",
        comesFrom: "card",
        chargedWhenPaid: true,
        purpose: "fee",
        paymentState: "paid",
        onItsCard: true,
        hours: 48,
        charges: 2,
        refunds: 0,
        finding: "refunded_at_once",
        toTeam: false,
        sameEffect: true,
        reason: "double_charge",
        decidedBy: "at_once",
        refundPayment: null,
        newLine: "refund",
      });
      expect(textOf(DEE_FEE_PAYMENT.booking_fee_id)).toBe(textOf(DEE_FEE.id));
    });

    it("seed-pay-link: Alex's bill went as one pay link, texted and emailed, with no deadline, for the payment its stripe_pay_link effect made; paid that evening, the link ended paid; only its code's sha256 is kept, and the runtime side, with no scope (the pay page's server before it knows the business), finds the link by hashing the demo code (1 row)", async () => {
      const [link] = await db.sql<Record<string, unknown>[]>`
        select k.given_via as "givenVia", k.due_at as due, k.ended_why as why, k.ended_at = p.paid_at as "endedWhenPaid",
               e.kind as "effectKind", p.purpose, p.state, l.written_by as "writtenBy"
        from pay_links k
          join payments p on p.id = k.payment_id
          join effects e on e.id = p.effect_id
          join ledger_lines l on l.payment_id = p.id
        where k.id = ${textOf(PAY_LINK.id)}
      `;
      expect(link).toEqual({
        givenVia: ["text", "email"],
        due: null,
        why: "paid",
        endedWhenPaid: true,
        effectKind: "stripe_pay_link",
        purpose: "rest",
        state: "paid",
        writtenBy: "provider_event",
      });
      expect(sha256(PAY_LINK_DEMO_CODE)).toBe(textOf(PAY_LINK.code_sha256));
      const found = await as(
        RUNTIME,
        null,
        (tx) =>
          tx<{ id: string; payment: string }[]>`
            select id, payment_id as payment from pay_links where code_sha256 = ${sha256(PAY_LINK_DEMO_CODE)}
          `,
      );
      expect(found).toEqual([{ id: textOf(PAY_LINK.id), payment: textOf(LINK_PAYMENT.id) }]);
    });
  });

  describe("row-level security per business on every new business-scoped table (arch 10 line 546; README rule 5)", () => {
    const yoga = {
      booking_fees: 0,
      credits: 1,
      memberships: 0,
      packs: 1,
      pay_links: 0,
      plan_charges: 0,
      reconciliation_findings: 0,
      reconciliation_runs: 0,
      rosfield_fees: 0,
    };
    const lees = {
      booking_fees: 1,
      credits: 0,
      memberships: 1,
      packs: 0,
      pay_links: 1,
      plan_charges: 1,
      reconciliation_findings: 1,
      reconciliation_runs: 1,
      rosfield_fees: 3,
    };
    const none = Object.fromEntries(OWN_TABLES.map((table) => [table, 0]));

    it("the Tool API scoped to the yoga studio sees only its pack and credit, scoped to Lee's Barbershop only Lee's rows of the nine, and with no scope none: each count is the owner's count of that business's rows", async () => {
      expect(await ownerRowsOf(YOGA_STUDIO, OWN_TABLES)).toEqual(yoga);
      expect(await ownerRowsOf(BARBERSHOP, OWN_TABLES)).toEqual(lees);
      expect(await as(TOOL_API, YOGA_STUDIO, (tx) => rowsIn(tx, OWN_TABLES))).toEqual(yoga);
      expect(await as(TOOL_API, BARBERSHOP, (tx) => rowsIn(tx, OWN_TABLES))).toEqual(lees);
      expect(await as(TOOL_API, null, (tx) => rowsIn(tx, OWN_TABLES))).toEqual(none);
    });

    it("the runtime side with no scope (the plan charge job, reconciliation, the monthly bill job) sees every row of the nine, and scoped only its business's", async () => {
      expect(await as(RUNTIME, null, (tx) => rowsIn(tx, OWN_TABLES))).toEqual(
        Object.fromEntries(OWN_TABLES.map((table) => [table, SEVEN_SEEDED[table] ?? -1])),
      );
      expect(await as(RUNTIME, YOGA_STUDIO, (tx) => rowsIn(tx, OWN_TABLES))).toEqual(yoga);
      expect(await as(RUNTIME, BARBERSHOP, (tx) => rowsIn(tx, OWN_TABLES))).toEqual(lees);
    });

    it("a Tool API write lands only in its own scope's business: the yoga studio's scope writing Lee's Barbershop's $2 or membership is refused (42501)", async () => {
      const writes: readonly (readonly [string, Values])[] = [
        ["rosfield_fees", { ...BEN_FEE, id: "fee-rosfield2-probe-ben-trim-yoga" }],
        ["memberships", { ...PLAN, id: "plan-probe-owen-haircut-yoga" }],
      ];
      for (const [table, values] of writes) {
        const outcome = await refusal(as(TOOL_API, YOGA_STUDIO, (tx) => insertRow(tx, table, values)));
        expect([outcome.code, outcome.message], table).toEqual([
          "42501",
          `new row violates row-level security policy for table "${table}"`,
        ]);
      }
    });
  });

  describe("rule 5 on part 2's tables: a Tool API write names only its own business's bookings, lines, visits, questions, reminders and yeses (42501), and part 1's rows only of its business (composite keys, 23503)", () => {
    const refusedByPolicy = async (
      scope: string,
      table: string,
      rows: readonly (readonly [string, Values])[],
    ) => {
      const outcome = await refusal(
        as(TOOL_API, scope, async (tx) => {
          for (const [name, values] of rows) {
            await insertRow(tx, name, values);
          }
        }),
      );
      expect([outcome.code, outcome.message], `${scope} ${table}`).toEqual([
        "42501",
        `new row violates row-level security policy for table "${table}"`,
      ]);
    };

    it("memberships (terms_consent_id): the yoga studio's membership with Alex's own yes passes as the Tool API; naming Owen's yes at Lee's Barbershop is refused (42501); for Owen, no customer of the yoga studio, by memberships_customer_fk (23503); with no yes and not paid outside Rosie by memberships_terms_yes (23514)", async () => {
      const stored = await as(TOOL_API, YOGA_STUDIO, (tx) =>
        insertReturning(tx, "memberships", YOGA_MEMBERSHIP),
      );
      expect(stored).toEqual([{ id: YOGA_MEMBERSHIP.id, business: YOGA_STUDIO }]);
      await refusedByPolicy(YOGA_STUDIO, "memberships", [
        ["memberships", { ...YOGA_MEMBERSHIP, terms_consent_id: textOf(PLAN_TERMS.id) }],
      ]);
      const notACustomer = await refusal(
        as(TOOL_API, YOGA_STUDIO, (tx) =>
          insertRow(tx, "memberships", { ...YOGA_MEMBERSHIP, person_id: "person-owen" }),
        ),
      );
      expect([notACustomer.code, notACustomer.constraint]).toEqual(["23503", "memberships_customer_fk"]);
      const noYes = await refusal(
        as(TOOL_API, YOGA_STUDIO, (tx) =>
          insertRow(tx, "memberships", { ...YOGA_MEMBERSHIP, terms_consent_id: null }),
        ),
      );
      expect([noYes.code, noYes.constraint]).toEqual(["23514", "memberships_terms_yes"]);
    });

    it("credits (booking_line_id): the yoga studio's credit from Alex's pack for its own second Hot Flow line passes as the Tool API, its pack's count raised in the same commit; naming Lee's Barbershop's line is refused (42501)", async () => {
      const credit: Values = {
        ...CREDIT,
        id: "credit-probe-alex-hot-flow-2",
        booking_line_id: textOf(YOGA_LINE_2.id),
      };
      const stored = await as(TOOL_API, YOGA_STUDIO, async (tx) => {
        const raised = await tx<{ used: number }[]>`
          update packs set credits_used = credits_used + 1, version = version + 1 where id = ${PACK_ID}
          returning credits_used as used
        `;
        return [raised, await insertReturning(tx, "credits", credit)];
      });
      expect(stored).toEqual([[{ used: 2 }], [{ id: credit.id, business: YOGA_STUDIO }]]);
      await refusedByPolicy(YOGA_STUDIO, "credits", [
        ["credits", { ...credit, booking_line_id: "line-alex-grooms-1" }],
      ]);
    });

    it("booking_fees (booking_id, visit_id, open_question_id): Lee's Barbershop's no-show fee for Ben T.'s trim, asked with Sam's question, passes as the Tool API; the same fee naming the yoga studio's Hot Flow booking and visit is refused (42501)", async () => {
      const fee: Values = {
        ...DEE_FEE,
        id: "fee-probe-ben-no-show",
        booking_id: textOf(BEN_BOOKING.id),
        visit_id: textOf(BEN_VISIT.id),
        kind: "no_show",
        asked_at: "2026-11-09T15:00:00Z",
        answer_by: "2026-11-10T15:00:00Z",
        answer: null,
        answered_at: null,
        answered_by_person_id: null,
        answered_by_role: null,
        option_id: null,
        event_id: null,
        state: "asked",
        charged_at: null,
        version: 1,
      };
      const stored = await as(TOOL_API, BARBERSHOP, (tx) => insertReturning(tx, "booking_fees", fee));
      expect(stored).toEqual([{ id: fee.id, business: BARBERSHOP }]);
      await refusedByPolicy(BARBERSHOP, "booking_fees", [
        [
          "booking_fees",
          { ...fee, booking_id: textOf(HOT_FLOW_BOOKING.id), visit_id: textOf(YOGA_VISIT.id) },
        ],
      ]);
    });

    it("plan_charges (booking_id, reminder_outbox_row_id): the yoga membership's first charge, made with Alex present, passes as the Tool API; the same charge naming Owen's reminder or Owen's booking at Lee's Barbershop is refused (42501)", async () => {
      const stored = await as(TOOL_API, YOGA_STUDIO, async (tx) => {
        await insertRow(tx, "memberships", YOGA_MEMBERSHIP);
        return insertReturning(tx, "plan_charges", YOGA_FIRST_CHARGE);
      });
      expect(stored).toEqual([{ id: YOGA_FIRST_CHARGE.id, business: YOGA_STUDIO }]);
      for (const fault of [
        { customer_present: false, reminder_outbox_row_id: textOf(REMINDER.id) },
        { customer_present: false, booking_id: textOf(PLAN_CHARGE.booking_id) },
      ] satisfies Values[]) {
        await refusedByPolicy(YOGA_STUDIO, "plan_charges", [
          ["memberships", YOGA_MEMBERSHIP],
          ["plan_charges", { ...YOGA_FIRST_CHARGE, ...fault }],
        ]);
      }
    });

    it("rosfield_fees (booking_id, visit_id): the yoga studio's $2 for Alex's Hot Flow class at its visit, toward Maya, passes as the Tool API; naming Ben T.'s booking and visit at Lee's Barbershop is refused (42501)", async () => {
      const fee: Values = {
        ...BEN_FEE,
        id: "fee-rosfield2-probe-alex-hot-flow",
        business_id: YOGA_STUDIO,
        booking_id: textOf(HOT_FLOW_BOOKING.id),
        visit_id: textOf(YOGA_VISIT.id),
        counted_at: "2026-11-09T15:05:00Z",
        counted_by: "check_in_code",
        counts_for_person_id: "person-maya",
        month: "2026-11-01",
      };
      const stored = await as(TOOL_API, YOGA_STUDIO, (tx) => insertReturning(tx, "rosfield_fees", fee));
      expect(stored).toEqual([{ id: fee.id, business: YOGA_STUDIO }]);
      await refusedByPolicy(YOGA_STUDIO, "rosfield_fees", [
        ["rosfield_fees", { ...fee, booking_id: textOf(BEN_BOOKING.id), visit_id: textOf(BEN_VISIT.id) }],
      ]);
    });

    it("inside the part, composite keys hold a row to its business's payment (rule 5): the yoga studio's pack bought by Lee's payment is refused by packs_payment_fk, and its pay link for Lee's payment by pay_links_payment_fk (23503)", async () => {
      const crossed: readonly (readonly [string, Values, string])[] = [
        [
          "packs",
          { ...PACK, id: "pack-probe-alex-yoga-lees-payment", payment_id: textOf(LINK_PAYMENT.id) },
          "packs_payment_fk",
        ],
        [
          "pay_links",
          {
            ...PAY_LINK,
            id: "link-probe-yoga-lees-payment",
            business_id: YOGA_STUDIO,
            code_sha256: sha256("probe-code-yoga-lees-payment"),
            ended_at: null,
            ended_why: null,
            version: 1,
          },
          "pay_links_payment_fk",
        ],
      ];
      for (const [table, values, constraint] of crossed) {
        const outcome = await refusal(as(TOOL_API, YOGA_STUDIO, (tx) => insertRow(tx, table, values)));
        expect([outcome.code, outcome.constraint], table).toEqual(["23503", constraint]);
      }
    });
  });

  describe("the three keys of part 1's tables hold (DL-278's way): saved_cards_membership_fk, payments_booking_fee_fk and payments_plan_charge_fk", () => {
    it("a card, a fee's payment and a plan charge's payment naming their own business's membership, fee and plan charge pass on the runtime side; naming another business's are refused by the key (23503)", async () => {
      const own = await as(RUNTIME, null, async (tx) => {
        await insertRow(tx, "memberships", YOGA_MEMBERSHIP);
        await insertRow(tx, "plan_charges", YOGA_FIRST_CHARGE);
        await insertRow(tx, "effects", YOGA_SAVE_EFFECT);
        await insertRow(tx, "effects", YOGA_CHARGE_EFFECT);
        const card = await insertReturning(tx, "saved_cards", YOGA_PLAN_CARD);
        const payment = await insertReturning(tx, "payments", {
          ...YOGA_FAILED_PAYMENT,
          purpose: "plan_charge",
          plan_charge_id: textOf(YOGA_FIRST_CHARGE.id),
        });
        return [card, payment];
      });
      expect(own).toEqual([
        [{ id: YOGA_PLAN_CARD.id, business: YOGA_STUDIO }],
        [{ id: YOGA_FAILED_PAYMENT.id, business: YOGA_STUDIO }],
      ]);
      const crossed: readonly (readonly [string, Values, string])[] = [
        ["saved_cards", { ...YOGA_PLAN_CARD, membership_id: textOf(PLAN.id) }, "saved_cards_membership_fk"],
        [
          "payments",
          {
            ...YOGA_FAILED_PAYMENT,
            purpose: "fee",
            booking_id: textOf(HOT_FLOW_BOOKING.id),
            booking_fee_id: textOf(DEE_FEE.id),
          },
          "payments_booking_fee_fk",
        ],
        [
          "payments",
          { ...YOGA_FAILED_PAYMENT, purpose: "plan_charge", plan_charge_id: textOf(PLAN_CHARGE.id) },
          "payments_plan_charge_fk",
        ],
      ];
      for (const [table, values, constraint] of crossed) {
        const outcome = await refusal(
          as(RUNTIME, null, async (tx) => {
            await insertRow(tx, "effects", YOGA_SAVE_EFFECT);
            await insertRow(tx, "effects", YOGA_CHARGE_EFFECT);
            await insertRow(tx, table, values);
          }),
        );
        expect([outcome.code, outcome.constraint], constraint).toEqual(["23503", constraint]);
      }
    });

    it("the keys are on delete restrict: even the migrations' role cannot remove Dee's fee or Owen's Oct 31 charge while a payment names it, nor the yoga membership while its card names it (23503)", async () => {
      for (const [table, id, constraint] of [
        ["booking_fees", textOf(DEE_FEE.id), "payments_booking_fee_fk"],
        ["plan_charges", textOf(PLAN_CHARGE.id), "payments_plan_charge_fk"],
      ] as const) {
        const outcome = await refusal(asOwner((tx) => tx.unsafe(`delete from ${table} where id = $1`, [id])));
        expect([outcome.code, outcome.constraint], table).toEqual(["23503", constraint]);
      }
      const membership = await refusal(
        asOwner(async (tx) => {
          await insertRow(tx, "memberships", YOGA_MEMBERSHIP);
          await insertRow(tx, "effects", YOGA_SAVE_EFFECT);
          await insertRow(tx, "saved_cards", YOGA_PLAN_CARD);
          await tx`delete from memberships where id = ${textOf(YOGA_MEMBERSHIP.id)}`;
        }),
      );
      expect([membership.code, membership.constraint]).toEqual(["23503", "saved_cards_membership_fk"]);
    });
  });

  describe("rules 6 and 7 on the seeded rows: what may change, by privilege and by the set-once trigger", () => {
    /** The columns `role` may update on `table`: rule 6's list (both roles), and a run's finish for the runtime side. */
    const updatableBy = (role: Role, table: string): readonly string[] => [
      ...(COLUMN_UPDATES[table] ?? []),
      ...(role === RUNTIME ? (RUNTIME_UPDATES[table] ?? []) : []),
    ];

    it(
      "no column outside rule 6's list is updated by either role (42501), column by column, on all nine: rosfield_fees and reconciliation_findings take no update at all, a run only its finish and only by the runtime side, and no price, period, terms, count total, amount, source, code hash or customer_present changes in place",
      SLOW,
      async () => {
        for (const table of OWN_TABLES) {
          const [id, business] = SEEDED_ROW[table] ?? ["", ""];
          for (const [role, scope] of [
            [TOOL_API, business],
            [RUNTIME, null],
          ] as const) {
            for (const column of columnsOf(table).filter(
              (name) => !updatableBy(role, table).includes(name),
            )) {
              const outcome = await refusal(
                as(role, scope, (tx) =>
                  tx.unsafe(`update ${table} set "${column}" = "${column}" where id = $1`, [id]),
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
      "no role deletes or truncates any of the nine, scoped or not (42501): money records stay 7 years (rule 9); every row stays",
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
        expect(await rowsIn(db.sql, OWN_TABLES)).toEqual(
          Object.fromEntries(OWN_TABLES.map((table) => [table, SEVEN_SEEDED[table] ?? -1])),
        );
      },
    );

    /** Runs `steps` on the runtime side with no scope, in one rolled-back transaction, and gives its refusal. */
    const refusedOnRuntime = (steps: (tx: Tx) => Promise<unknown>): Promise<Refusal> =>
      refusal(as(RUNTIME, null, steps));

    it("memberships (rule 7: ended_at, ended_why): Owen's plan stopped passes; then its reason changed, or the plan made active again, is refused by memberships_set_once (23514); its price, period or terms changed by either role by privilege (42501)", async () => {
      const id = textOf(PLAN.id);
      const stop = (tx: Tx) =>
        tx`
          update memberships set status = 'ended', ended_at = '2026-11-09T16:00:00Z', ended_why = 'stopped',
            version = version + 1
          where id = ${id} returning status, ended_why as why, version
        `;
      expect(await as(RUNTIME, null, stop)).toEqual([{ status: "ended", why: "stopped", version: 2 }]);
      for (const [label, statement] of [
        [
          "its reason changed",
          "update memberships set ended_why = 'new_terms', version = version + 1 where id = $1",
        ],
        [
          "made active again",
          "update memberships set status = 'active', ended_at = null, ended_why = null, version = version + 1 where id = $1",
        ],
      ] as const) {
        const outcome = await refusedOnRuntime(async (tx) => {
          await stop(tx);
          await tx.unsafe(statement, [id]);
        });
        expect([outcome.code, outcome.constraint], label).toEqual(["23514", "memberships_set_once"]);
      }
      for (const [role, scope] of [
        [TOOL_API, BARBERSHOP],
        [RUNTIME, null],
      ] as const) {
        for (const set of ["price_cents = 4000", "period = '14 days'", "terms_consent_id = null"]) {
          const outcome = await refusal(
            as(role, scope, (tx) =>
              tx.unsafe(`update memberships set ${set}, version = version + 1 where id = $1`, [id]),
            ),
          );
          expect([outcome.code, outcome.message], `${role} ${set}`).toEqual([
            "42501",
            "permission denied for table memberships",
          ]);
        }
      }
    });

    it("pay_links (rule 7: given_via grows only, ended_at, ended_why): a place added passes; one removed, or its end changed, is refused by pay_links_set_once (23514); a second live link for one payment by pay_links_one_live (23505); a link given by sms by pay_links_given_via, and one keeping its raw code by pay_links_code_hash_form (23514); the Tool API changing its code hash by privilege (42501)", async () => {
      const id = textOf(PAY_LINK.id);
      const added = await as(
        RUNTIME,
        null,
        (tx) =>
          tx<{ via: string[] }[]>`
            update pay_links set given_via = given_via || '{ai}'::text[], version = version + 1 where id = ${id}
            returning given_via as via
          `,
      );
      expect(added).toEqual([{ via: ["text", "email", "ai"] }]);
      for (const [label, statement] of [
        ["one removed", "update pay_links set given_via = '{text}', version = version + 1 where id = $1"],
        ["its end changed", "update pay_links set ended_why = 'closed', version = version + 1 where id = $1"],
      ] as const) {
        const outcome = await refusedOnRuntime((tx) => tx.unsafe(statement, [id]));
        expect([outcome.code, outcome.constraint], label).toEqual(["23514", "pay_links_set_once"]);
      }
      const live: Values = {
        ...PAY_LINK,
        id: "link-probe-alex-home-grooming-2",
        code_sha256: sha256("probe-code-alex-home-grooming-2"),
        sent_at: "2026-11-06T09:00:00Z",
        ended_at: null,
        ended_why: null,
        version: 1,
      };
      const second = await refusedOnRuntime(async (tx) => {
        await insertRow(tx, "pay_links", live);
        await insertRow(tx, "pay_links", {
          ...live,
          id: "link-probe-alex-home-grooming-3",
          code_sha256: sha256("probe-code-alex-home-grooming-3"),
        });
      });
      expect([second.code, second.constraint]).toEqual(["23505", "pay_links_one_live"]);
      const faults: readonly (readonly [Values, string])[] = [
        [{ given_via: ["sms"] }, "pay_links_given_via"],
        [{ code_sha256: PAY_LINK_DEMO_CODE }, "pay_links_code_hash_form"],
      ];
      for (const [fault, constraint] of faults) {
        const outcome = await refusedOnRuntime((tx) => insertRow(tx, "pay_links", { ...live, ...fault }));
        expect([outcome.code, outcome.constraint], constraint).toEqual(["23514", constraint]);
      }
      const changed = await refusal(
        as(TOOL_API, BARBERSHOP, (tx) =>
          tx.unsafe("update pay_links set code_sha256 = $1, version = version + 1 where id = $2", [
            sha256("probe-code-alex-home-grooming-4"),
            id,
          ]),
        ),
      );
      expect([changed.code, changed.message]).toEqual(["42501", "permission denied for table pay_links"]);
    });

    it("credits (rule 7: returned_at, returned_why): a second live credit for the line is refused by credits_one_live_per_line (23505); given back for a reason no source names by credits_returned (23514); given back after a no-show with no fee (no_fee), its pack's count lowered in the same commit, passes; then given back again is refused by credits_set_once (23514)", async () => {
      const id = textOf(CREDIT.id);
      const second = await refusedOnRuntime((tx) =>
        insertRow(tx, "credits", { ...CREDIT, id: "credit-probe-alex-hot-flow-again" }),
      );
      expect([second.code, second.constraint]).toEqual(["23505", "credits_one_live_per_line"]);
      const unknown = await refusedOnRuntime(
        (tx) =>
          tx`
          update credits set returned_at = '2026-11-06T10:00:00Z', returned_why = 'lost', version = version + 1
          where id = ${id}
        `,
      );
      expect([unknown.code, unknown.constraint]).toEqual(["23514", "credits_returned"]);
      const giveBack = async (tx: Tx) => {
        await tx`
          update credits set returned_at = '2026-11-06T10:00:00Z', returned_why = 'no_fee', version = version + 1
          where id = ${id}
        `;
        return tx<{ used: number }[]>`
          update packs set credits_used = credits_used - 1, version = version + 1 where id = ${PACK_ID}
          returning credits_used as used
        `;
      };
      expect(await as(RUNTIME, null, giveBack)).toEqual([{ used: 0 }]);
      const again = await refusedOnRuntime(async (tx) => {
        await giveBack(tx);
        await tx`update credits set returned_why = 'cancel_in_time', version = version + 1 where id = ${id}`;
      });
      expect([again.code, again.constraint]).toEqual(["23514", "credits_set_once"]);
    });

    it("booking_fees (rule 7): Dee's charged fee moved to dropped is refused by booking_fees_state_times; its charged time cleared to drop it, or its answer changed, by booking_fees_set_once (23514); its amount changed by either role by privilege (42501); a second paid payment for the fee by payments_one_live_per_fee (23505)", async () => {
      const id = textOf(DEE_FEE.id);
      for (const [label, statement, constraint] of [
        [
          "moved to dropped",
          "update booking_fees set state = 'dropped', dropped_at = '2026-11-08T10:00:00Z', version = version + 1 where id = $1",
          "booking_fees_state_times",
        ],
        [
          "its charged time cleared to drop it",
          "update booking_fees set state = 'dropped', charged_at = null, dropped_at = '2026-11-08T10:00:00Z', version = version + 1 where id = $1",
          "booking_fees_set_once",
        ],
        [
          "its answer changed",
          "update booking_fees set answer = 'no_fee', version = version + 1 where id = $1",
          "booking_fees_set_once",
        ],
      ] as const) {
        const outcome = await refusedOnRuntime((tx) => tx.unsafe(statement, [id]));
        expect([outcome.code, outcome.constraint], label).toEqual(["23514", constraint]);
      }
      for (const [role, scope] of [
        [TOOL_API, BARBERSHOP],
        [RUNTIME, null],
      ] as const) {
        const outcome = await refusal(
          as(role, scope, (tx) =>
            tx.unsafe("update booking_fees set amount_cents = 4000, version = version + 1 where id = $1", [
              id,
            ]),
          ),
        );
        expect([outcome.code, outcome.message], role).toEqual([
          "42501",
          "permission denied for table booking_fees",
        ]);
      }
      const effect = pendingEffect(DEE_FEE_EFFECT, "eff-probe-dee-late-cancel-fee-2");
      const twice = await refusedOnRuntime(async (tx) => {
        await insertRow(tx, "effects", effect);
        await insertRow(tx, "payments", {
          ...DEE_FEE_PAYMENT,
          id: "pay-probe-dee-late-cancel-fee-2",
          effect_id: textOf(effect.id),
        });
      });
      expect([twice.code, twice.constraint]).toEqual(["23505", "payments_one_live_per_fee"]);
    });

    it("plan_charges (rule 7): Owen's charged Oct 31 charge moved to failed is refused by plan_charges_outcome, its charged time cleared by plan_charges_set_once (23514); a second charge of the period by plan_charges_one_per_period (23505); a charge charged with no reminder by plan_charges_reminded_first (23514); either role changing customer_present by privilege (42501); his November charge, due after its reminder, passes", async () => {
      const id = textOf(PLAN_CHARGE.id);
      for (const [label, statement, constraint] of [
        [
          "moved to failed",
          "update plan_charges set state = 'failed', failed_at = '2026-11-01T10:00:00Z', version = version + 1 where id = $1",
          "plan_charges_outcome",
        ],
        [
          "its charged time cleared",
          "update plan_charges set state = 'due', charged_at = null, version = version + 1 where id = $1",
          "plan_charges_set_once",
        ],
      ] as const) {
        const outcome = await refusedOnRuntime((tx) => tx.unsafe(statement, [id]));
        expect([outcome.code, outcome.constraint], label).toEqual(["23514", constraint]);
      }
      const november: Values = {
        ...PLAN_CHARGE,
        id: "plancharge-probe-owen-2026-11-28",
        booking_id: null,
        period_start: "2026-11-28",
        period_end: "2026-11-28",
        due_on: "2026-11-28",
        state: "due",
        charged_at: null,
        version: 1,
      };
      expect(await as(RUNTIME, null, (tx) => insertReturning(tx, "plan_charges", november))).toEqual([
        { id: november.id, business: BARBERSHOP },
      ]);
      const twice = await refusedOnRuntime((tx) =>
        insertRow(tx, "plan_charges", { ...november, period_start: "2026-10-31" }),
      );
      expect([twice.code, twice.constraint]).toEqual(["23505", "plan_charges_one_per_period"]);
      const unreminded = await refusedOnRuntime((tx) =>
        insertRow(tx, "plan_charges", {
          ...november,
          reminder_outbox_row_id: null,
          state: "charged",
          charged_at: "2026-11-28T15:00:00Z",
        }),
      );
      expect([unreminded.code, unreminded.constraint]).toEqual(["23514", "plan_charges_reminded_first"]);
      for (const [role, scope] of [
        [TOOL_API, BARBERSHOP],
        [RUNTIME, null],
      ] as const) {
        const outcome = await refusal(
          as(role, scope, (tx) =>
            tx.unsafe(
              "update plan_charges set customer_present = true, version = version + 1 where id = $1",
              [id],
            ),
          ),
        );
        expect([outcome.code, outcome.message], role).toEqual([
          "42501",
          "permission denied for table plan_charges",
        ]);
      }
    });

    it("reconciliation (rule 7: a run's finish): the finished run's counts changed are refused by reconciliation_runs_set_once (23514); a second run of one window by reconciliation_runs_one_per_window (23505); a finding with no effect id not sent to the team by reconciliation_findings_fits (23514); the Tool API writing a run or a finding by privilege (42501)", async () => {
      const counts = await refusedOnRuntime(
        (tx) =>
          tx`update reconciliation_runs set charges_listed = 1, version = version + 1 where id = ${textOf(RUN.id)}`,
      );
      expect([counts.code, counts.constraint]).toEqual(["23514", "reconciliation_runs_set_once"]);
      const run: Values = { ...RUN, id: "recon-probe-lees-barbershop-2026-11-09" };
      const twice = await refusedOnRuntime((tx) => insertRow(tx, "reconciliation_runs", run));
      expect([twice.code, twice.constraint]).toEqual(["23505", "reconciliation_runs_one_per_window"]);
      const finding: Values = {
        ...FINDING,
        id: "finding-probe-2026-11-09-no-effect",
        kind: "no_effect_id",
        stripe_object_id: "stripe-charge-demo-probe-0301",
        effect_id: null,
        ledger_line_id: null,
        refund_id: null,
      };
      const unsent = await refusedOnRuntime((tx) =>
        insertRow(tx, "reconciliation_findings", { ...finding, to_team: false }),
      );
      expect([unsent.code, unsent.constraint]).toEqual(["23514", "reconciliation_findings_fits"]);
      expect(
        await as(RUNTIME, null, (tx) =>
          insertReturning(tx, "reconciliation_findings", { ...finding, to_team: true }),
        ),
      ).toEqual([{ id: finding.id, business: BARBERSHOP }]);
      for (const [table, values] of [
        [
          "reconciliation_runs",
          { ...run, window_from: "2026-11-08T03:00:00Z", window_to: "2026-11-10T03:00:00Z" },
        ],
        ["reconciliation_findings", { ...finding, to_team: true }],
      ] as const) {
        const outcome = await refusal(as(TOOL_API, BARBERSHOP, (tx) => insertRow(tx, table, values)));
        expect([outcome.code, outcome.message], table).toEqual([
          "42501",
          `permission denied for table ${table}`,
        ]);
      }
    });

    it("rosfield_fees: a $2 of 300 cents is refused by rosfield_fees_two_dollars (23514), a second $2 for one booking by rosfield_fees_one_per_booking (23505); the 1% of Owen's $35 plan charge at 70 cents by rosfield_fees_one_percent, and at 35 cents it passes; a fee in euros by rosfield_fees_money (23514)", async () => {
      const second: Values = { ...BEN_FEE, id: "fee-rosfield2-probe-ben-trim-2" };
      const outcomes = [
        await refusedOnRuntime((tx) =>
          insertRow(tx, "rosfield_fees", {
            ...second,
            booking_id: "booking-dee-beard-trim",
            visit_id: "visit-dee-beard-trim-1",
            amount_cents: 300,
          }),
        ),
        await refusedOnRuntime((tx) => insertRow(tx, "rosfield_fees", second)),
      ];
      expect(outcomes.map((outcome) => [outcome.code, outcome.constraint])).toEqual([
        ["23514", "rosfield_fees_two_dollars"],
        ["23505", "rosfield_fees_one_per_booking"],
      ]);
      const onePercent: Values = {
        id: "fee-rosfield1pct-probe-owen-oct31",
        business_id: BARBERSHOP,
        kind: "rosfield_1pct",
        booking_id: null,
        visit_id: null,
        plan_charge_id: textOf(PLAN_CHARGE.id),
        counted_at: "2026-10-31T14:40:02Z",
        counted_by: "plan_charge",
        counts_for_person_id: null,
        month: "2026-10-01",
        amount_cents: 70,
        currency: "USD",
        plan_charge_cents: 3500,
      };
      const seventy = await refusedOnRuntime((tx) => insertRow(tx, "rosfield_fees", onePercent));
      expect([seventy.code, seventy.constraint]).toEqual(["23514", "rosfield_fees_one_percent"]);
      expect(
        await as(RUNTIME, null, (tx) =>
          insertReturning(tx, "rosfield_fees", { ...onePercent, amount_cents: 35 }),
        ),
      ).toEqual([{ id: onePercent.id, business: BARBERSHOP }]);
      const euros = await refusedOnRuntime((tx) =>
        insertRow(tx, "rosfield_fees", { ...onePercent, amount_cents: 35, currency: "EUR" }),
      );
      expect([euros.code, euros.constraint]).toEqual(["23514", "rosfield_fees_money"]);
    });
  });

  describe("money is integer cents with a currency code (CQ-09; rule 9): each of part 2's five amount columns", () => {
    /** A seeded row of each table with an amount, its amount column and whether an update must raise its version. */
    const AMOUNTS: readonly (readonly [string, string, string, boolean])[] = [
      ["booking_fees", textOf(DEE_FEE.id), "amount_cents", true],
      ["memberships", textOf(PLAN.id), "price_cents", true],
      ["packs", PACK_ID, "price_cents", true],
      ["plan_charges", textOf(PLAN_CHARGE.id), "amount_cents", true],
      ["rosfield_fees", textOf(BEN_FEE.id), "amount_cents", false],
    ];

    it(
      "'39.50' as cents is refused by the type (22P02); a negative amount (but a $2's, which rosfield_fees_two_dollars holds at 200) or a lower-case currency by the table's <table>_money check (23514); the stored amounts are whole cents in USD",
      SLOW,
      async () => {
        for (const [table, id, amount, versioned] of AMOUNTS) {
          const probes: readonly (readonly [string, string | number, string, string | undefined])[] = [
            [amount, "39.50", "22P02", undefined],
            ...(table === "rosfield_fees" ? [] : [[amount, -100, "23514", `${table}_money`] as const]),
            ["currency", "usd", "23514", `${table}_money`],
          ];
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
            expect(
              [outcome.code, outcome.constraint],
              `${table}.${column} = ${JSON.stringify(value)}`,
            ).toEqual([code, constraint]);
          }
        }
        const stored = await db.sql<{ amount: string; currency: string }[]>`
          select amount_cents::text as amount, currency from booking_fees
          union all select price_cents::text, currency from memberships
          union all select price_cents::text, currency from packs
          union all select amount_cents::text, currency from plan_charges
          union all select amount_cents::text, currency from rosfield_fees
        `;
        expect(stored).toHaveLength(7);
        for (const row of stored) {
          expect(row.amount).toMatch(/^[1-9][0-9]*$/);
          expect(row.currency).toBe("USD");
        }
      },
    );
  });
});

describe("refuse-pack-over-credits.json: a pack's used count never passes its total (CHECK packs_credits_within_total; arch 10 line 510)", () => {
  const refused = refusedOf(PACK_OVER);

  beforeEach(async () => {
    await reset();
    await loadFixtures([PACK_OVER]);
  }, 120_000);

  it("the fixture: the Tool API, scoped to the yoga studio, raising Alex's pack to 6 of its 5 visits is refused by packs_credits_within_total (23514), and so is the runtime side; the pack reads 1 of 5 as written", async () => {
    expect([refused.role, refused.action, refused.table, refused.scope?.businessId]).toEqual([
      "toolApi",
      "update",
      "packs",
      YOGA_STUDIO,
    ]);
    expect(refused.set).toEqual({ credits_used: 6, version: 3 });
    for (const [role, scope] of [
      [roleOf(refused), YOGA_STUDIO],
      [RUNTIME, null],
    ] as const) {
      const outcome = await refusal(
        as(role, scope, updateWhere(refused.table, refused.where ?? {}, refused.set ?? {})),
      );
      expect([outcome.code, outcome.constraint], role).toEqual(["23514", "packs_credits_within_total"]);
      expect(refused.expect.constraintOneOf).toContain(outcome.constraint);
      expect(outcome.code).toBe(refused.expect.sqlstate);
    }
    const [pack] = await db.sql<{ used: number; total: number; version: number }[]>`
      select credits_used as used, credits_total as total, version from packs where id = ${PACK_ID}
    `;
    expect(pack).toEqual({ used: 1, total: 5, version: 2 });
  });

  it("without its one fault, raising it to 2 of 5 passes as the Tool API (its version raised by one: rule 4); a count below zero is refused by the same CHECK (23514)", async () => {
    const raised = await as(TOOL_API, YOGA_STUDIO, async (tx) => {
      await updateWhere(refused.table, refused.where ?? {}, { ...refused.set, credits_used: 2 })(tx);
      return tx<{ used: number; version: number }[]>`
        select credits_used as used, version from packs where id = ${PACK_ID}
      `;
    });
    expect(raised).toEqual([{ used: 2, version: 3 }]);
    const below = await refusal(
      as(
        TOOL_API,
        YOGA_STUDIO,
        updateWhere(refused.table, refused.where ?? {}, { ...refused.set, credits_used: -1 }),
      ),
    );
    expect([below.code, below.constraint]).toEqual(["23514", "packs_credits_within_total"]);
  });
});

describe("a pack's credits never go below zero: 50 parallel uses of its last credit give exactly one success (CHECK plus compare-and-set; FS line 738; A5-03; arch 10 line 510)", () => {
  const TRIES = 50;
  /** Three uses first take the pack from 1 to 4 of its 5 visits; then 50 bookings race for its last credit. */
  const SETUP = 3;
  const bookingOf = (n: number): string => `booking-probe-alex-hot-flow-${pad(n)}`;
  const lineOf = (n: number): string => `line-probe-alex-hot-flow-${pad(n)}`;
  const creditOf = (n: number): string => `credit-probe-alex-hot-flow-${pad(n)}`;
  const RACED = Array.from({ length: TRIES }, (_, i) => lineOf(SETUP + i));

  /** Each use's outcome: the credit it stored, or why it was refused. */
  type Outcome = { stored: string } | { refused: string };
  const settle = (use: Promise<string>): Promise<Outcome> =>
    use.then(
      (stored) => ({ stored }),
      (error: unknown) => {
        if (error instanceof VersionMoved) {
          return { refused: "version moved" };
        }
        const failure = error as { code?: string; constraint_name?: string };
        return { refused: `${failure.code ?? "no code"} ${failure.constraint_name ?? "no constraint"}` };
      },
    );
  const storedOf = (outcomes: readonly Outcome[]): string[] =>
    outcomes.flatMap((outcome) => ("stored" in outcome ? [outcome.stored] : []));
  const refusalsOf = (outcomes: readonly Outcome[]): string[] =>
    outcomes.flatMap((outcome) => ("refused" in outcome ? [outcome.refused] : []));

  /**
   * One booking's money step (C-101; A5-03) as the Tool API, scoped to the yoga studio, in one transaction: it reads the
   * pack, raises its used count with its version, comparing the version it read when `compare` (the commit's
   * compare-and-set: arch 10 line 506), and writes the credit that pays the line. Nothing is written unless all is.
   */
  const useCredit = (n: number, compare: boolean): Promise<string> =>
    withBusiness(db.sql, YOGA_STUDIO, async (tx) => {
      await tx.unsafe(`set local role ${TOOL_API}`);
      const [read] = await tx<{ version: number }[]>`select version from packs where id = ${PACK_ID}`;
      const raised = compare
        ? await tx`
            update packs set credits_used = credits_used + 1, version = version + 1
            where id = ${PACK_ID} and version = ${read?.version ?? -1} returning id
          `
        : await tx`
            update packs set credits_used = credits_used + 1, version = version + 1 where id = ${PACK_ID} returning id
          `;
      if (raised.length !== 1) {
        throw new VersionMoved();
      }
      await insertRow(tx, "credits", {
        ...CREDIT,
        id: creditOf(n),
        booking_line_id: lineOf(n),
        used_at: "2026-11-08T15:00:00Z",
      });
      return creditOf(n);
    });

  /** The pack's count, total and version, and its live credits, as the owner reads them. */
  const packState = async (): Promise<
    { used: number; total: number; version: number; live: number } | undefined
  > => {
    const [row] = await db.sql<{ used: number; total: number; version: number; live: number }[]>`
      select p.credits_used as used, p.credits_total as total, p.version,
             (select count(*)::int from credits c where c.pack_id = p.id and c.returned_at is null) as live
      from packs p where p.id = ${PACK_ID}
    `;
    return row;
  };

  /** The credits written for the 50 raced lines. */
  const racedCredits = async (): Promise<string[]> => {
    const rows = await db.sql<{ id: string }[]>`
      select id from credits where booking_line_id in ${db.sql(RACED)} order by id
    `;
    return rows.map((row) => row.id);
  };

  beforeEach(async () => {
    await reset();
    await loadFixtures([PACK_SEED]);
    await committedAs(RUNTIME, async (tx) => {
      for (let n = 0; n < SETUP + TRIES; n += 1) {
        await insertRow(tx, "bookings", { ...HOT_FLOW_BOOKING, id: bookingOf(n) });
        await insertRow(tx, "booking_lines", { ...HOT_FLOW_LINE, id: lineOf(n), booking_id: bookingOf(n) });
      }
    });
    for (let n = 0; n < SETUP; n += 1) {
      await useCredit(n, true);
    }
  }, 120_000);

  it(
    "each money step compares the version it read and sets it: of 50 at once, exactly one takes the last credit; each other is refused whole, by the compare-and-set (the version moved) or by packs_credits_within_total (23514), and writes no credit; the pack ends 5 of 5 used, its version raised once, with no credit left below zero",
    SLOW,
    async () => {
      expect(await packState()).toEqual({ used: 4, total: 5, version: 5, live: 4 });
      const outcomes = await Promise.all(
        Array.from({ length: TRIES }, (_, i) => settle(useCredit(SETUP + i, true))),
      );
      const stored = storedOf(outcomes);
      expect(stored).toHaveLength(1);
      const refused = refusalsOf(outcomes);
      expect(refused).toHaveLength(TRIES - 1);
      expect(
        refused.filter((reason) => !["version moved", "23514 packs_credits_within_total"].includes(reason)),
      ).toEqual([]);
      expect(await packState()).toEqual({ used: 5, total: 5, version: 6, live: 5 });
      expect(await racedCredits()).toEqual(stored);
    },
  );

  it(
    "a write that does not compare the version is still held by the CHECK: of 50 at once, exactly one raises the count to 5 of 5; the other 49 are refused by packs_credits_within_total (23514) and write no credit, so no credit is used twice and none is left below zero",
    SLOW,
    async () => {
      expect(await packState()).toEqual({ used: 4, total: 5, version: 5, live: 4 });
      const outcomes = await Promise.all(
        Array.from({ length: TRIES }, (_, i) => settle(useCredit(SETUP + i, false))),
      );
      const stored = storedOf(outcomes);
      expect(stored).toHaveLength(1);
      expect(refusalsOf(outcomes)).toEqual(
        Array.from({ length: TRIES - 1 }, () => "23514 packs_credits_within_total"),
      );
      expect(await packState()).toEqual({ used: 5, total: 5, version: 6, live: 5 });
      expect(await racedCredits()).toEqual(stored);
    },
  );
});

describe("refuse-pay-link-code-read.json: only the runtime side reads a pay link's code hash (rule 6; BP rule 7)", () => {
  const refused = refusedOf(CODE_READ);

  beforeAll(async () => {
    await reset();
    await loadFixtures([CODE_READ]);
  }, 120_000);

  it("the fixture: a Tool API call scoped to Lee's Barbershop reading Alex's pay link's whole row is refused by privilege (42501); so are a read of code_sha256 alone, a search by it and a change of it", async () => {
    expect([
      refused.role,
      refused.action,
      refused.table,
      refused.scope?.businessId,
      refused.expect.sqlstate,
    ]).toEqual(["toolApi", "select", "pay_links", BARBERSHOP, "42501"]);
    const id = textOf(refused.where?.id);
    expect(id).toBe(textOf(PAY_LINK.id));
    const hash = sha256(PAY_LINK_DEMO_CODE);
    for (const [statement, values] of [
      ["select * from pay_links where id = $1", [id]],
      ["select code_sha256 from pay_links where id = $1", [id]],
      ["select id from pay_links where code_sha256 = $1", [hash]],
      ["update pay_links set code_sha256 = $1, version = version + 1 where id = $2", [hash, id]],
    ] as const) {
      const outcome = await refusal(
        as(roleOf(refused), BARBERSHOP, (tx) => tx.unsafe(statement, [...values])),
      );
      expect([outcome.code, outcome.message], statement).toEqual([
        refused.expect.sqlstate,
        "permission denied for table pay_links",
      ]);
    }
  });

  it("without its fault the same read of the link's other columns passes (1 row, ended paid); the runtime side reads the whole row and finds the link by the hash of its code", async () => {
    const id = textOf(PAY_LINK.id);
    const read = await as(TOOL_API, BARBERSHOP, (tx) =>
      tx.unsafe<Record<string, unknown>[]>(
        `select ${PAY_LINK_SELECTS.join(", ")} from pay_links where id = $1`,
        [id],
      ),
    );
    expect(read.map((row) => [row.id, row.payment_id, row.given_via, row.ended_why])).toEqual([
      [id, textOf(LINK_PAYMENT.id), ["text", "email"], "paid"],
    ]);
    expect(read.map((row) => Object.keys(row))).toEqual([PAY_LINK_SELECTS]);
    const whole = await as(
      RUNTIME,
      null,
      (tx) =>
        tx<{ id: string; hash: string }[]>`
        select id, code_sha256 as hash from pay_links where code_sha256 = ${sha256(PAY_LINK_DEMO_CODE)}
      `,
    );
    expect(whole).toEqual([{ id, hash: textOf(PAY_LINK.code_sha256) }]);
  });
});

describe("refuse-rosfield-fee-update.json: a counted $2 is never edited (rule 6: insert only); a wrong line comes off on K-33's bill instead", () => {
  const refused = refusedOf(FEE_UPDATE);
  /** A booking of Ben T.'s with a visit and no $2 yet: his trim's booking and visit under new ids. */
  const BOOKING_2: Values = { ...BEN_BOOKING, id: "booking-probe-ben-trim-2" };
  const VISIT_2: Values = { ...BEN_VISIT, id: "visit-probe-ben-trim-2", booking_id: textOf(BOOKING_2.id) };

  beforeAll(async () => {
    await reset();
    await loadFixtures([FEE_UPDATE]);
    await committedAs(RUNTIME, async (tx) => {
      await insertRow(tx, "bookings", BOOKING_2);
      await insertRow(tx, "booking_visits", VISIT_2);
    });
  }, 120_000);

  it(
    "the fixture: the runtime side setting Ben T.'s questioned $2 to $0 is refused by privilege (42501), and so is the Tool API's, scoped to Lee's Barbershop; every column, for both roles; the $2 reads 200 cents as counted",
    SLOW,
    async () => {
      expect([refused.role, refused.action, refused.table, refused.scope, refused.expect.sqlstate]).toEqual([
        "runtime",
        "update",
        "rosfield_fees",
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
          "permission denied for table rosfield_fees",
        ]);
        for (const column of columnsOf("rosfield_fees")) {
          const changed = await refusal(
            as(role, scope, (tx) =>
              tx.unsafe(`update rosfield_fees set "${column}" = "${column}" where id = $1`, [
                textOf(where.id),
              ]),
            ),
          );
          expect(changed.code, `${role} ${column}`).toBe("42501");
        }
      }
      const [fee] = await db.sql<{ amount: string; kind: string }[]>`
        select amount_cents::text as amount, kind from rosfield_fees where id = ${textOf(where.id)}
      `;
      expect(fee).toEqual({ amount: "200", kind: "rosfield_2" });
    },
  );

  it("a $2 is inserted instead, by either role, for a booking that has none: Ben T.'s second booking at its visit passes; the same booking counted twice is refused by rosfield_fees_one_per_booking (23505)", async () => {
    const fee: Values = {
      ...BEN_FEE,
      id: "fee-rosfield2-probe-ben-trim-2",
      booking_id: textOf(BOOKING_2.id),
      visit_id: textOf(VISIT_2.id),
      counted_at: "2026-11-09T18:30:00Z",
      month: "2026-11-01",
    };
    for (const [role, scope] of [
      [RUNTIME, null],
      [TOOL_API, BARBERSHOP],
    ] as const) {
      expect(await as(role, scope, (tx) => insertReturning(tx, "rosfield_fees", fee)), role).toEqual([
        { id: fee.id, business: BARBERSHOP },
      ]);
    }
    const twice = await refusal(
      as(RUNTIME, null, async (tx) => {
        await insertRow(tx, "rosfield_fees", fee);
        await insertRow(tx, "rosfield_fees", { ...fee, id: "fee-rosfield2-probe-ben-trim-3" });
      }),
    );
    expect([twice.code, twice.constraint]).toEqual(["23505", "rosfield_fees_one_per_booking"]);
  });
});

describe("refuse-fee-on-silence.json: only the owner's yes takes a fee, never silence (S11-25; RULES 3.3, 3.4; S13-26)", () => {
  const refused = refusedOf(FEE_ON_SILENCE);
  const values = refused.values ?? {};

  beforeAll(async () => {
    await reset();
    await loadFixtures([FEE_ON_SILENCE]);
  }, 120_000);

  it("the fixture: keeping Alex's $40 deposit as the no-show fee when Sam did not answer by the deadline is refused by booking_fees_only_owner_yes_takes (23514), written by the Tool API scoped to Lee's Barbershop, and on the runtime side too", async () => {
    expect([refused.role, refused.action, refused.table, refused.scope?.businessId]).toEqual([
      "toolApi",
      "insert",
      "booking_fees",
      BARBERSHOP,
    ]);
    expect([values.answer, values.state]).toEqual(["no_answer", "charged"]);
    for (const [role, scope] of [
      [roleOf(refused), BARBERSHOP],
      [RUNTIME, null],
    ] as const) {
      const outcome = await refusal(as(role, scope, (tx) => insertRow(tx, "booking_fees", values)));
      expect([outcome.code, outcome.constraint], role).toEqual([
        "23514",
        "booking_fees_only_owner_yes_takes",
      ]);
      expect(refused.expect.constraintOneOf).toContain(outcome.constraint);
      expect(outcome.code).toBe(refused.expect.sqlstate);
    }
  });

  it("without its fault the same fee, dropped at the deadline with no fee, passes as the Tool API: rule 5's checks find its booking, visit and question in Lee's Barbershop", async () => {
    const dropped: Values = {
      ...values,
      state: "dropped",
      charged_at: null,
      dropped_at: values.answered_at ?? null,
    };
    const stored = await as(TOOL_API, BARBERSHOP, async (tx) => {
      await insertRow(tx, "booking_fees", dropped);
      return tx<{ state: string; answer: string }[]>`
        select state, answer from booking_fees where id = ${textOf(values.id)}
      `;
    });
    expect(stored).toEqual([{ state: "dropped", answer: "no_answer" }]);
  });

  it("its rows (README probes): a fee from two sources is refused by booking_fees_source; Sam's yes to the no-show fee on the saved card passes, dropped when its one pay link went unpaid passes; then moved to charged is refused by booking_fees_state_times, its dropped time cleared by booking_fees_set_once (23514)", async () => {
    const twoSources = await refusal(
      as(TOOL_API, BARBERSHOP, (tx) =>
        insertRow(tx, "booking_fees", {
          ...values,
          state: "dropped",
          charged_at: null,
          dropped_at: values.answered_at ?? null,
          saved_card_id: "card-alex-grooms-package",
        }),
      ),
    );
    expect([twoSources.code, twoSources.constraint]).toEqual(["23514", "booking_fees_source"]);
    const yes: Values = {
      ...values,
      comes_from: "card",
      from_payment_id: null,
      saved_card_id: "card-alex-grooms-package",
      answer: "charge",
      answered_at: "2026-11-14T17:00:00Z",
      answered_by_person_id: "person-sam",
      answered_by_role: "owner",
      option_id: "S11-25/1",
      event_id: "evt-probe-sam-0101",
      state: "owner_yes",
      charged_at: null,
      dropped_at: null,
    };
    const id = textOf(values.id);
    const drop = async (tx: Tx) => {
      await insertRow(tx, "booking_fees", yes);
      return tx<{ state: string; version: number }[]>`
        update booking_fees set state = 'dropped', dropped_at = '2026-11-15T17:00:00Z', version = version + 1
        where id = ${id} returning state, version
      `;
    };
    expect(await as(TOOL_API, BARBERSHOP, drop)).toEqual([{ state: "dropped", version: 2 }]);
    for (const [label, statement, constraint] of [
      [
        "moved to charged",
        "update booking_fees set state = 'charged', charged_at = '2026-11-15T18:00:00Z', version = version + 1 where id = $1",
        "booking_fees_state_times",
      ],
      [
        "its dropped time cleared",
        "update booking_fees set state = 'charged', charged_at = '2026-11-15T18:00:00Z', dropped_at = null, version = version + 1 where id = $1",
        "booking_fees_set_once",
      ],
    ] as const) {
      const outcome = await refusal(
        as(TOOL_API, BARBERSHOP, async (tx) => {
          await drop(tx);
          await tx.unsafe(statement, [id]);
        }),
      );
      expect([outcome.code, outcome.constraint], label).toEqual(["23514", constraint]);
    }
  });
});
