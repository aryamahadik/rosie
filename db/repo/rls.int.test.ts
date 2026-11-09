// T-191: row-level security per business on every business-scoped core table, with the Tool API's role and the runtime
// side's role, against local PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/rls`). The schema comes
// from migrating a fresh test schema, with every accepted K-04 v1 seed loaded. T-1094 narrows it: the definer functions
// answer only what K-05 needs, a business-scoped call reads one mobile's handle id, chat_links takes updates on four
// columns only, the Tool API holds nothing on effects and provider_events, and a Tool API path that runs as rosie_job
// refuses an empty scope.
//
// The test's connection is the migrations' role (locally a superuser that owns every table), which bypasses row-level
// security. So every check runs in its own transaction under SET LOCAL ROLE: rosie_app, the Tool API (K-05 scope
// business), or rosie_job, the runtime side (the guard, the dispatcher, the clock sweep), scoped by withBusiness() as a
// call is scoped. Each of those transactions is rolled back, so the seeds stay as loaded.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createResource } from "./bookings-head";
import { BusinessScopeError, requireBusinessScope, type Sql, type Tx, withBusiness } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const CORE_DIR = new URL("../../contracts/db-schema/core/", import.meta.url);
const TOOL_API = "rosie_app";
const RUNTIME = "rosie_job";
type Role = typeof TOOL_API | typeof RUNTIME;
const ROLES: readonly Role[] = [TOOL_API, RUNTIME];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
/** The security-definer functions, in name order: 0012's two (T-1085, narrowed by T-1094) and T-1094's handle read. */
const FUNCTIONS = ["handles_id_of_mobile", "reservations_booked_overlap", "reservations_saved_times"];
/** Who may run each function besides its owner (T-1094: the handle read is the Tool API's alone). */
const RUNS: Record<string, readonly Role[]> = {
  handles_id_of_mobile: [TOOL_API],
  reservations_booked_overlap: [TOOL_API, RUNTIME],
  reservations_saved_times: [TOOL_API, RUNTIME],
};
/** The four chat_links columns K-29 changes, the only ones either role may update (T-1094; DL-121, T-192's N4). */
const CHAT_LINK_UPDATES = ["given_via", "owner_retold_at", "used_at", "version"];
// K-22 v1.1's four named exceptions (T-204; DL-169). Its README's rules 4, 5 and 8 give four tables policies other than
// 0012's pair, rosie_app column grants on three of them and five security-definer calls of their own;
// people-access.int.test.ts checks each against the README word for word. Every other table and function stays held to
// this file's generic checks.
/**
 * (a), (b) The policies on K-22's four excepted tables, by table, in name order. README rule 4 (contact_changes) and
 * rule 8 (page_links): 0012's <table>_runtime beside one Tool API policy per command. Rule 5 (proof_codes, sessions:
 * scope none, row-level security on): Tool API rows bound to the call's person, beside a runtime policy on every row.
 */
const K22_POLICIES: Record<string, readonly string[]> = {
  contact_changes: [
    "contact_changes_runtime",
    "contact_changes_tool_api_insert",
    "contact_changes_tool_api_select",
  ],
  page_links: [
    "page_links_runtime",
    "page_links_tool_api_insert",
    "page_links_tool_api_select",
    "page_links_tool_api_update",
  ],
  proof_codes: ["proof_codes_runtime", "proof_codes_tool_api_insert", "proof_codes_tool_api_select"],
  sessions: [
    "sessions_runtime",
    "sessions_tool_api_insert",
    "sessions_tool_api_select",
    "sessions_tool_api_update",
  ],
};
/**
 * (c) rosie_app's 63 column grants on K-22's tables, never a hash. README rule 5: it reads every proof_codes column but
 * code_hash and inserts a send's ten; it reads every sessions column but token_sha256 and device_sha256 and updates
 * four. Rule 8: it reads every page_links column but code_sha256, inserts an issue's nine and updates the end.
 */
const K22_COLUMN_GRANTS: { table: string; privilege: string; columns: readonly string[] }[] = [
  {
    table: "proof_codes",
    privilege: "SELECT",
    columns: [
      "id",
      "purpose",
      "person_id",
      "business_id",
      "sent_to_handle_id",
      "channel",
      "hash_key_name",
      "sent_at",
      "expires_at",
      "wrong_tries",
      "last_wrong_at",
      "paused_until",
      "used_at",
      "version",
    ],
  },
  {
    table: "proof_codes",
    privilege: "INSERT",
    columns: [
      "id",
      "purpose",
      "person_id",
      "business_id",
      "sent_to_handle_id",
      "channel",
      "code_hash",
      "hash_key_name",
      "sent_at",
      "expires_at",
    ],
  },
  {
    table: "sessions",
    privilege: "SELECT",
    columns: [
      "id",
      "person_id",
      "proven_via",
      "proof_code_id",
      "started_at",
      "last_seen_at",
      "expires_at",
      "ended_at",
      "ended_why",
      "version",
    ],
  },
  { table: "sessions", privilege: "UPDATE", columns: ["last_seen_at", "ended_at", "ended_why", "version"] },
  {
    table: "page_links",
    privilege: "SELECT",
    columns: [
      "id",
      "business_id",
      "person_id",
      "purpose",
      "step_id",
      "sent_to_handle_id",
      "issued_at",
      "expires_at",
      "ended_at",
      "ended_why",
      "ended_by_contact_change_id",
      "version",
    ],
  },
  {
    table: "page_links",
    privilege: "INSERT",
    columns: [
      "id",
      "business_id",
      "person_id",
      "purpose",
      "step_id",
      "code_sha256",
      "sent_to_handle_id",
      "issued_at",
      "expires_at",
    ],
  },
  {
    table: "page_links",
    privilege: "UPDATE",
    columns: ["ended_at", "ended_why", "ended_by_contact_change_id", "version"],
  },
];
/**
 * (d) K-22's five security-definer calls, in name order: README rule 5's four and rule 8's page_link_for_code. Kept out
 * of FUNCTIONS, whose checks expect search_path=pg_catalog, pg_temp: rules 5 and 8 pin these to <schema>, pg_temp.
 */
const K22_FUNCTIONS = [
  "check_proof_code",
  "device_known",
  "page_link_for_code",
  "proof_code_limits",
  "session_for_token",
];
// K-27 v1's three named exceptions (T-208; DL-247). Its README's rule 5 (with rule 6 for the sealed tokens) gives three
// tables policies other than 0012's pair, row-level security on two tables scoped none, and rosie_app column grants on
// two of them; availability.int.test.ts checks each against the README word for word. It adds no security-definer call.
// Every other table and function stays held to this file's generic checks.
/**
 * (a), (b) The policies on K-27's three excepted tables, by table, in name order. K-27 rule 5: calendar_link_shares
 * (scope business) holds 0012's <table>_runtime beside one Tool API policy per command; calendar_links and busy_blocks
 * (scope none, row-level security on) hold a runtime policy on every row beside the Tool API's own, which reads them
 * only through its business's live share.
 */
const K27_POLICIES: Record<string, readonly string[]> = {
  busy_blocks: [
    "busy_blocks_runtime",
    "busy_blocks_tool_api_delete",
    "busy_blocks_tool_api_insert",
    "busy_blocks_tool_api_select",
    "busy_blocks_tool_api_update",
  ],
  calendar_link_shares: [
    "calendar_link_shares_runtime",
    "calendar_link_shares_tool_api_insert",
    "calendar_link_shares_tool_api_select",
    "calendar_link_shares_tool_api_update",
  ],
  calendar_links: ["calendar_links_runtime", "calendar_links_tool_api_select"],
};
/**
 * (c) rosie_app's 23 column grants on K-27's tables, never tokens. K-27 rule 5 (rule 6 seals the tokens): it reads
 * every calendar_links column but tokens (16), inserts a share's five columns and updates its end and version.
 */
const K27_COLUMN_GRANTS: { table: string; privilege: string; columns: readonly string[] }[] = [
  {
    table: "calendar_links",
    privilege: "SELECT",
    columns: [
      "id",
      "person_id",
      "provider",
      "state",
      "linked_at",
      "sync_cursor",
      "synced_at",
      "subscription_id",
      "subscription_resource_id",
      "subscribed_at",
      "subscription_expires_at",
      "dropped_at",
      "dropped_why",
      "drop_reminded_at",
      "unlinked_at",
      "version",
    ],
  },
  {
    table: "calendar_link_shares",
    privilege: "INSERT",
    columns: ["id", "calendar_link_id", "person_id", "business_id", "shared_at"],
  },
  { table: "calendar_link_shares", privilege: "UPDATE", columns: ["ended_at", "version"] },
];
// K-33 v1's named exception (T-209; DL-250). Its README's rule 2 gives rosie_app column grants on two tables;
// platform-billing.int.test.ts checks them against the README too. It adds no policy beyond T-191's pattern and no
// security-definer call. Every other table and function stays held to this file's generic checks.
/**
 * (c) rosie_app's 6 column grants on K-33's tables. K-33 rule 2: it updates only a bill card's removed_at and version
 * (a card replaced; Stripe's ids are never changed in place), and only a line's questioned_at, questioned_by_person_id,
 * question and version (the owner questions a line; the answer is the runtime side's).
 */
const K33_COLUMN_GRANTS: { table: string; privilege: string; columns: readonly string[] }[] = [
  { table: "bill_cards", privilege: "UPDATE", columns: ["removed_at", "version"] },
  {
    table: "monthly_bill_lines",
    privilege: "UPDATE",
    columns: ["questioned_at", "questioned_by_person_id", "question", "version"],
  },
];
// K-35 v1's named exception (T-210; DL-256). Its README's rule 5 gives both application roles column grants on one
// table; documents-licenses.int.test.ts checks them against the README too. It adds no policy beyond T-191's pattern and
// no security-definer call: rule 11's trigger function, documents_signed_by_all_once(), runs as the calling role. Every
// other table and function stays held to this file's generic checks.
/**
 * (c) Both roles' 6 UPDATE column grants on K-35's documents, in chat_links' both-roles form. K-35 rule 5: either role
 * updates only shown_on_listing, signed_by_all_at, the three withdrawn columns and version, so what a person gave, and
 * what a document is, never changes.
 */
const K35_DOCUMENT_UPDATES = [
  "shown_on_listing",
  "signed_by_all_at",
  "withdrawn_at",
  "withdrawn_why",
  "withdrawn_by_person_id",
  "version",
];
// K-30 v1's named exceptions (T-720, DL-271: (1) and (2) on part 1's tables; T-721, DL-278: (1) and (2) extended to
// part 2's tables, and (3)). Its README's rule 5 adds an exists clause to the Tool API's insert and update policies on
// every table with booking_id, beyond T-191's pattern, and its rule 6 gives both application roles UPDATE column grants
// on four tables and keeps secure_links.code_sha256 out of the Tool API's SELECT; bookings-changes.int.test.ts and
// bookings-changes-2.int.test.ts check each against the README word for word. Rule 6's trigger function,
// booking_details_set_once(), runs as the calling role, not as definer, and part 2 makes no function, so the function
// checks stand. quote_options, K-30's one table with no booking_id, keeps T-191's pattern. Every other table and
// function stays held to this file's generic checks.
/** K-30's tables migration 0028 makes (part 1, T-720). */
const K30_PART_1 = [
  "booking_details",
  "booking_lines",
  "booking_terms",
  "booking_terms_rules",
  "booking_visits",
];
/** K-30's tables migration 0029 makes (part 2, T-721). */
const K30_PART_2 = [
  "booking_addresses",
  "booking_changes",
  "owner_oks",
  "page_answers",
  "quote_options",
  "quotes",
  "secure_links",
  "waitlist_entries",
];
/**
 * (1) The policies on K-30's tables with booking_id, by table, in name order (K-30 rule 5; DL-271, DL-278): 0012's
 * <table>_runtime beside one Tool API policy per command its grants allow; its insert and update policies carry rule
 * 5's clause `exists (select 1 from bookings b where b.id = <table>.booking_id and b.business_id = <table>.business_id)`.
 * booking_changes and page_answers are insert only (rule 6), so they hold no update policy.
 */
const K30_POLICIES: Record<string, readonly string[]> = {
  booking_addresses: [
    "booking_addresses_runtime",
    "booking_addresses_tool_api_insert",
    "booking_addresses_tool_api_select",
    "booking_addresses_tool_api_update",
  ],
  booking_changes: [
    "booking_changes_runtime",
    "booking_changes_tool_api_insert",
    "booking_changes_tool_api_select",
  ],
  booking_details: [
    "booking_details_runtime",
    "booking_details_tool_api_insert",
    "booking_details_tool_api_select",
    "booking_details_tool_api_update",
  ],
  booking_lines: [
    "booking_lines_runtime",
    "booking_lines_tool_api_insert",
    "booking_lines_tool_api_select",
    "booking_lines_tool_api_update",
  ],
  booking_terms: ["booking_terms_runtime", "booking_terms_tool_api_insert", "booking_terms_tool_api_select"],
  booking_terms_rules: [
    "booking_terms_rules_runtime",
    "booking_terms_rules_tool_api_insert",
    "booking_terms_rules_tool_api_select",
  ],
  booking_visits: [
    "booking_visits_runtime",
    "booking_visits_tool_api_insert",
    "booking_visits_tool_api_select",
    "booking_visits_tool_api_update",
  ],
  owner_oks: [
    "owner_oks_runtime",
    "owner_oks_tool_api_insert",
    "owner_oks_tool_api_select",
    "owner_oks_tool_api_update",
  ],
  page_answers: ["page_answers_runtime", "page_answers_tool_api_insert", "page_answers_tool_api_select"],
  quotes: ["quotes_runtime", "quotes_tool_api_insert", "quotes_tool_api_select", "quotes_tool_api_update"],
  secure_links: [
    "secure_links_runtime",
    "secure_links_tool_api_insert",
    "secure_links_tool_api_select",
    "secure_links_tool_api_update",
  ],
  waitlist_entries: [
    "waitlist_entries_runtime",
    "waitlist_entries_tool_api_insert",
    "waitlist_entries_tool_api_select",
    "waitlist_entries_tool_api_update",
  ],
};
/**
 * (2) Both roles' 14 UPDATE column grants on K-30's booking_lines, booking_visits, secure_links and waitlist_entries, in
 * chat_links' both-roles form. K-30 rule 6 (DL-271, DL-278): a line's state, removed_at, removed_by_change_id and
 * version only (the copied price is never changed), a visit's reservation_id, arrival_window, cutoff_at and version only
 * (its check-in code never changes), and a link's and a waitlist entry's ended_at, ended_why and version only (only the
 * end moves: a link's code hash, person and contact, and who waits for what and since when, never change).
 */
const K30_COLUMN_UPDATES: Record<string, readonly string[]> = {
  booking_lines: ["state", "removed_at", "removed_by_change_id", "version"],
  booking_visits: ["reservation_id", "arrival_window", "cutoff_at", "version"],
  secure_links: ["ended_at", "ended_why", "version"],
  waitlist_entries: ["ended_at", "ended_why", "version"],
};
/**
 * (3) rosie_app's 11 SELECT column grants on K-30's secure_links: every column but code_sha256, checked by name. K-30
 * rule 6 (DL-278): the code's hash is outside the Tool API's SELECT (a whole-row read is refused, refuse-link-code-read,
 * 42501); the runtime side reads the whole row by its table grant, to find a link by its code's hash.
 */
const K30_LINK_SELECTS = [
  "id",
  "booking_id",
  "business_id",
  "purpose",
  "person_id",
  "handle_id",
  "given_via",
  "issued_at",
  "ended_at",
  "ended_why",
  "version",
];
const SLOW = { timeout: 60_000 };

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface ContractTable {
  name: string;
  columns: { name: string; null: boolean }[];
  rowLevelSecurity: { scope: "business"; column: string } | { scope: "none"; why: string };
  versioned: boolean;
}

interface FixtureFile {
  after: string[];
  rows: { table: string; values: Record<string, Json> }[];
}

interface RefusedFixture {
  after: string[];
  refused: {
    role: string;
    scope: { businessId: string } | null;
    action: string;
    table: string;
    set?: Record<string, Json>;
    where: Record<string, string>;
    expect: { rows?: number; sqlstate?: string };
  };
}

const readCore = (relative: string): unknown => JSON.parse(readFileSync(new URL(relative, CORE_DIR), "utf8"));

const TABLES = (readCore("core.v1.tables.json") as { tables: ContractTable[] }).tables;
/**
 * Every table the migrations make: K-04 v1 core, K-29 v1 conversations and consent (T-192), K-37 v1 platform and
 * review (T-193), K-07 v1's schema addition: effects, provider events and outbox claims (T-194), K-34 v1 safety and
 * incidents (T-580), K-36 v1 notifications (T-581), K-23 v1 business setup (T-203), K-22 v1.1 people and access
 * (T-204: v1's ten tables and v1.1's page_links), K-24 v1 kinds of work (T-205), K-25 v1 services and prices
 * (T-206), K-26 v1 rules (T-207), K-27 v1 availability (T-208), K-33 v1 platform billing (T-209), K-35 v1
 * documents and licenses (T-210), K-28 v1 customers (T-211), and K-30 v1 bookings and changes, part 1 (T-720: the five
 * tables of K30_PART_1) and part 2 (T-721: the eight of K30_PART_2).
 */
const ALL_TABLES = [
  ...TABLES,
  ...(
    JSON.parse(
      readFileSync(
        new URL(
          "../../contracts/db-schema/conversations-consent/conversations-consent.v1.tables.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { tables: ContractTable[] }
  ).tables,
  ...(
    JSON.parse(
      readFileSync(
        new URL("../../contracts/db-schema/platform-review/platform-review.v1.tables.json", import.meta.url),
        "utf8",
      ),
    ) as { tables: ContractTable[] }
  ).tables,
  ...(
    JSON.parse(
      readFileSync(
        new URL("../../contracts/outbox-effects/outbox-effects.v1.tables.json", import.meta.url),
        "utf8",
      ),
    ) as { tables: ContractTable[] }
  ).tables,
  ...(
    JSON.parse(
      readFileSync(
        new URL(
          "../../contracts/db-schema/safety-incidents/safety-incidents.v1.tables.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { tables: ContractTable[] }
  ).tables,
  ...(
    JSON.parse(
      readFileSync(
        new URL("../../contracts/db-schema/notifications/notifications.v1.tables.json", import.meta.url),
        "utf8",
      ),
    ) as { tables: ContractTable[] }
  ).tables,
  ...(
    JSON.parse(
      readFileSync(
        new URL("../../contracts/db-schema/business-setup/business-setup.v1.tables.json", import.meta.url),
        "utf8",
      ),
    ) as { tables: ContractTable[] }
  ).tables,
  ...(
    JSON.parse(
      readFileSync(
        new URL("../../contracts/db-schema/people-access/people-access.v1.tables.json", import.meta.url),
        "utf8",
      ),
    ) as { tables: ContractTable[] }
  ).tables,
  ...(
    JSON.parse(
      readFileSync(
        new URL("../../contracts/db-schema/people-access/people-access.v1.1.tables.json", import.meta.url),
        "utf8",
      ),
    ) as { tables: ContractTable[] }
  ).tables,
  ...(
    JSON.parse(
      readFileSync(
        new URL("../../contracts/db-schema/kinds-of-work/kinds-of-work.v1.tables.json", import.meta.url),
        "utf8",
      ),
    ) as { tables: ContractTable[] }
  ).tables,
  ...(
    JSON.parse(
      readFileSync(
        new URL("../../contracts/db-schema/services-prices/services-prices.v1.tables.json", import.meta.url),
        "utf8",
      ),
    ) as { tables: ContractTable[] }
  ).tables,
  ...(
    JSON.parse(
      readFileSync(new URL("../../contracts/db-schema/rules/rules.v1.tables.json", import.meta.url), "utf8"),
    ) as { tables: ContractTable[] }
  ).tables,
  ...(
    JSON.parse(
      readFileSync(
        new URL("../../contracts/db-schema/availability/availability.v1.tables.json", import.meta.url),
        "utf8",
      ),
    ) as { tables: ContractTable[] }
  ).tables,
  ...(
    JSON.parse(
      readFileSync(
        new URL(
          "../../contracts/db-schema/platform-billing/platform-billing.v1.tables.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { tables: ContractTable[] }
  ).tables,
  ...(
    JSON.parse(
      readFileSync(
        new URL(
          "../../contracts/db-schema/documents-licenses/documents-licenses.v1.tables.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { tables: ContractTable[] }
  ).tables,
  ...(
    JSON.parse(
      readFileSync(
        new URL("../../contracts/db-schema/customers/customers.v1.tables.json", import.meta.url),
        "utf8",
      ),
    ) as { tables: ContractTable[] }
  ).tables,
  ...(
    JSON.parse(
      readFileSync(
        new URL(
          "../../contracts/db-schema/bookings-changes/bookings-changes.v1.tables.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { tables: ContractTable[] }
  ).tables.filter((table) => [...K30_PART_1, ...K30_PART_2].includes(table.name)),
];
/** The business-scoped tables, each with the column its policies key on and whether that column may be null. */
const scopedOf = (tables: readonly ContractTable[]): { name: string; column: string; nullable: boolean }[] =>
  tables.flatMap((table) => {
    const security = table.rowLevelSecurity;
    if (security.scope !== "business") {
      return [];
    }
    const nullable = table.columns.find((column) => column.name === security.column)?.null === true;
    return [{ name: table.name, column: security.column, nullable }];
  });
/** The core tables scoped by business, which the core seeds fill. */
const SCOPED = scopedOf(TABLES);
/** Every business-scoped table in the schema, for the catalog's lists. */
const ALL_SCOPED = scopedOf(ALL_TABLES);
/**
 * (a), (b) The tables with row-level security on and policies, in name order: every business-scoped table, K-22's
 * proof_codes and sessions, scoped none (README rule 5), and K-27's calendar_links and busy_blocks, scoped none (K-27
 * rule 5; DL-247).
 */
const POLICY_TABLES = [
  ...new Set([
    ...ALL_SCOPED.map((table) => table.name),
    ...Object.keys(K22_POLICIES),
    ...Object.keys(K27_POLICIES),
  ]),
].sort();
/** The tables that span businesses (scope none). */
const SPANNING = TABLES.filter((table) => table.rowLevelSecurity.scope === "none").map((table) => table.name);

function fixtureRows(file: string, seen: Set<string>): FixtureFile["rows"] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const fixture = readCore(`fixtures/${file}`) as FixtureFile;
  return [...fixture.after.flatMap((before) => fixtureRows(before, seen)), ...fixture.rows];
}

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** Loads every accepted K-04 seed fixture as the owner, each `after` chain once, as the contract test loads them. */
async function loadSeeds(sql: Sql): Promise<void> {
  const typed = await sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = current_schema() and data_type in ('jsonb', 'bytea')
  `;
  const typeOf = new Map(typed.map((column) => [column.key, column.type]));
  const index = readCore("fixtures/index.json") as { fixtures: { file: string; expect: string }[] };
  const seen = new Set<string>();
  for (const entry of index.fixtures.filter((fixture) => fixture.expect === "accept")) {
    for (const row of fixtureRows(entry.file, seen)) {
      const values: Record<string, never> = {};
      for (const [column, value] of Object.entries(row.values)) {
        const type = typeOf.get(`${row.table}.${column}`);
        let converted: unknown = value;
        if (type === "jsonb" && value !== null) {
          converted = sql.json(value);
        } else if (type === "bytea" && typeof value === "string") {
          converted = fromHex(value.replace(/^\\x/, ""));
        }
        values[column] = converted as never;
      }
      await sql`insert into ${sql(row.table)} ${sql(values)}`;
    }
  }
}

/** Thrown to roll a check's transaction back with its answer. */
class RolledBack extends Error {
  constructor(readonly answer: unknown) {
    super("rolled back on purpose");
  }
}

let db: TestDatabase;

/**
 * Runs `fn` in one transaction as `role`, scoped by withBusiness() to `businessId` (null: no scope, a plain
 * transaction), then rolls it back. A statement the database refuses rejects with its error.
 */
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

/** The SQLSTATE and message of a refused statement. */
async function refusal(promise: Promise<unknown>): Promise<{ code: string | undefined; message: string }> {
  try {
    await promise;
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    return { code: failure.code, message: failure.message ?? "" };
  }
  throw new Error("the statement was accepted; the database should have refused it");
}

async function rowCount(sql: Sql | Tx, table: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
  return row?.n ?? -1;
}

/** Rows each business-scoped table shows the caller, by table. */
async function visibleRows(sql: Sql | Tx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of SCOPED) {
    counts[table.name] = await rowCount(sql, table.name);
  }
  return counts;
}

/** Rows of each business-scoped table whose business column is `businessId` (null: no business), read as the owner. */
async function ownerRows(businessId: string | null): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of SCOPED) {
    const [row] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from ${db.sql(table.name)}
      where ${businessId === null ? db.sql`${db.sql(table.column)} is null` : db.sql`${db.sql(table.column)} = ${businessId}`}
    `;
    counts[table.name] = row?.n ?? -1;
  }
  return counts;
}

/** Rows each business-scoped table shows the caller whose business column is null. */
async function visibleRowsWithNoBusiness(sql: Sql | Tx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of SCOPED) {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from ${sql(table.name)} where ${sql(table.column)} is null
    `;
    counts[table.name] = row?.n ?? -1;
  }
  return counts;
}

async function businessIds(): Promise<string[]> {
  const rows = await db.sql<{ id: string }[]>`select id from businesses order by id`;
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "rls" });
  await loadSeeds(db.sql);
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe("the migration: row-level security on every business-scoped core table (K-04 v1 rule 4)", () => {
  it("the frozen table list names 13 business-scoped tables and 11 that span businesses", () => {
    expect(SCOPED.map((table) => table.name).sort()).toEqual([
      "bookings",
      "businesses",
      "class_seats",
      "clock_rows",
      "event_log",
      "messages",
      "open_questions",
      "openers_sent",
      "outbox_rows",
      "pauses",
      "person_roles",
      "reservations",
      "resources",
    ]);
    expect(SPANNING).toHaveLength(11);
  });

  it("every business-scoped table has row-level security on: the catalog lists none without it", async () => {
    const names = ALL_SCOPED.map((table) => table.name);
    const found = await db.sql<{ name: string }[]>`
      select c.relname as name from pg_class c
      where c.relnamespace = ${db.schema}::regnamespace and c.relkind = 'r' and c.relname in ${db.sql(names)}
    `;
    expect(found).toHaveLength(names.length);
    const without = await db.sql<{ name: string }[]>`
      select c.relname as name from pg_class c
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(names)}
        and not c.relrowsecurity
    `;
    expect(without).toEqual([]);
  });

  it("tables that span businesses keep it off (scope none), and no table forces it on its owner", async () => {
    const on = await db.sql<{ name: string }[]>`
      select c.relname as name from pg_class c
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(SPANNING)} and c.relrowsecurity
    `;
    expect(on).toEqual([]);
    const forced = await db.sql<{ name: string }[]>`
      select c.relname as name from pg_class c
      where c.relnamespace = ${db.schema}::regnamespace and c.relforcerowsecurity
    `;
    expect(forced).toEqual([]);
  });

  it("each business-scoped table has two policies on its business column: <table>_tool_api for rosie_app, <table>_runtime for rosie_job (but K-22's four of README rules 4, 5 and 8, K-27's three of its rule 5, and K-30's tables with booking_id of its rule 5)", async () => {
    const policies = await db.sql<
      {
        table: string;
        name: string;
        permissive: string;
        roles: string[];
        command: string;
        // Null where the policy's command has none: an insert policy's using, a select policy's check.
        using: string | null;
        check: string | null;
      }[]
    >`
      select tablename as table, policyname as name, permissive, roles::text[] as roles, cmd as command,
             qual as using, with_check as check
      from pg_policies where schemaname = ${db.schema}
      order by tablename, policyname
    `;
    expect([...new Set(policies.map((policy) => policy.table))]).toEqual(POLICY_TABLES);
    // (a) K-22's named exceptions: contact_changes (README rule 4), page_links (rule 8), proof_codes and sessions (rule
    // 5) hold their own policies, by name here; people-access.int.test.ts checks each word for word against the README.
    for (const [table, names] of Object.entries(K22_POLICIES)) {
      expect(
        policies.filter((policy) => policy.table === table).map((policy) => policy.name),
        table,
      ).toEqual(names);
    }
    // (a) K-27's named exceptions (K-27 rule 5; DL-247): calendar_link_shares holds 0012's runtime policy beside one
    // Tool API policy per command, and calendar_links and busy_blocks (scope none) hold their own, by name here;
    // availability.int.test.ts checks each word for word against the README.
    for (const [table, names] of Object.entries(K27_POLICIES)) {
      expect(
        policies.filter((policy) => policy.table === table).map((policy) => policy.name),
        table,
      ).toEqual(names);
    }
    // (1) K-30's named exception (K-30 rule 5; DL-271, DL-278): each of its tables with booking_id holds 0012's runtime
    // policy beside one Tool API policy per command, by name here, and the Tool API's insert and update policies carry
    // rule 5's clause on the new row, so a call can never attach a row to another business's booking; no other of its
    // policies does. bookings-changes.int.test.ts and bookings-changes-2.int.test.ts check each word for word against
    // the README. quote_options, with no booking_id, stays under the generic check below.
    for (const [table, names] of Object.entries(K30_POLICIES)) {
      const own = policies.filter((policy) => policy.table === table);
      expect(
        own.map((policy) => policy.name),
        table,
      ).toEqual(names);
      const clause = `(EXISTS ( SELECT 1 FROM bookings b WHERE ((b.id = ${table}.booking_id) AND (b.business_id = ${table}.business_id))))`;
      for (const policy of own) {
        const written = /_tool_api_(insert|update)$/.test(policy.name);
        const check = (policy.check ?? "").replace(/\s+/g, " ");
        expect(check.includes(clause), policy.name).toBe(written);
        expect((policy.using ?? "").includes("EXISTS"), policy.name).toBe(false);
        if (written) {
          expect(check, policy.name).toContain("business_id = NULLIF(current_setting('rosie.business_id'");
        }
      }
    }
    for (const table of ALL_SCOPED.filter(
      (candidate) =>
        !Object.keys(K22_POLICIES).includes(candidate.name) &&
        !Object.keys(K27_POLICIES).includes(candidate.name) &&
        !Object.keys(K30_POLICIES).includes(candidate.name),
    )) {
      const own = policies.filter((policy) => policy.table === table.name);
      expect(own.map((policy) => [policy.name, policy.permissive, policy.roles, policy.command])).toEqual([
        [`${table.name}_runtime`, "PERMISSIVE", [RUNTIME], "ALL"],
        [`${table.name}_tool_api`, "PERMISSIVE", [TOOL_API], "ALL"],
      ]);
      for (const policy of own) {
        expect(policy.using, policy.name).toContain(
          `${table.column} = NULLIF(current_setting('rosie.business_id'`,
        );
        expect(policy.check, policy.name).toBe(policy.using);
      }
      // Only the runtime side has the unscoped branch: with no scope, it reads every business's rows.
      expect(own[0]?.using).toContain("IS NULL");
      expect(own[1]?.using).not.toContain("IS NULL");
    }
  });

  it("is recorded in schema_migrations as core_rls, after core_event_log", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    expect(names).toContain("core_rls");
    expect(names.indexOf("core_rls")).toBeGreaterThan(names.indexOf("core_event_log"));
  });
});

describe("the two roles", () => {
  const roleRows = (): Promise<
    { name: string; oid: number; super: boolean; bypass: boolean; login: boolean }[]
  > =>
    db.sql`
      select rolname as name, oid::int as oid, rolsuper as super, rolbypassrls as bypass, rolcanlogin as login
      from pg_roles where rolname in (${TOOL_API}, ${RUNTIME}) order by rolname
    `;

  it("rosie_app and rosie_job exist, cannot log in, are no superusers, and neither bypasses row-level security", async () => {
    const roles = await roleRows();
    expect(
      roles.map(({ name, super: superuser, bypass, login }) => ({ name, superuser, bypass, login })),
    ).toEqual([
      { name: TOOL_API, superuser: false, bypass: false, login: false },
      { name: RUNTIME, superuser: false, bypass: false, login: false },
    ]);
    const powers = await db.sql<
      { name: string; createrole: boolean; createdb: boolean; replication: boolean }[]
    >`
      select rolname as name, rolcreaterole as createrole, rolcreatedb as createdb, rolreplication as replication
      from pg_roles where rolname in (${TOOL_API}, ${RUNTIME}) order by rolname
    `;
    for (const role of powers) {
      expect(role, role.name).toEqual({
        name: role.name,
        createrole: false,
        createdb: false,
        replication: false,
      });
    }
  });

  it("neither role owns a table or a function: event_log, its trigger function and the three definer functions stay the migrations' role's", async () => {
    const owned = await db.sql<{ owner: string; name: string }[]>`
      select pg_get_userbyid(c.relowner) as owner, c.relname as name from pg_class c
      where c.relnamespace = ${db.schema}::regnamespace and pg_get_userbyid(c.relowner) in (${TOOL_API}, ${RUNTIME})
      union all
      select pg_get_userbyid(p.proowner), p.proname from pg_proc p
      where p.pronamespace = ${db.schema}::regnamespace and pg_get_userbyid(p.proowner) in (${TOOL_API}, ${RUNTIME})
    `;
    expect(owned).toEqual([]);
    const owners = await db.sql<{ name: string; owner: string; me: string }[]>`
      select c.relname as name, pg_get_userbyid(c.relowner) as owner, current_user as me from pg_class c
      where c.oid = ${`${db.schema}.event_log`}::regclass
      union all
      select p.proname, pg_get_userbyid(p.proowner), current_user from pg_proc p
      where p.pronamespace = ${db.schema}::regnamespace and p.proname in ${db.sql(["event_log_refuse_edit", ...FUNCTIONS])}
      order by 1
    `;
    expect(owners.map((row) => row.name)).toEqual(["event_log", "event_log_refuse_edit", ...FUNCTIONS]);
    for (const row of owners) {
      expect(row.owner, row.name).toBe(row.me);
    }
  });

  it(
    "are made only when missing: a second schema migrated on the same server keeps them and gets its own grants and policies",
    SLOW,
    async () => {
      const before = await roleRows();
      const again = await createTestDatabase({ name: "rls_again" });
      try {
        expect(await roleRows()).toEqual(before);
        const [row] = await again.sql<{ on: number; policies: number; usage: boolean }[]>`
          select count(*) filter (where c.relrowsecurity)::int as on,
                 (select count(*)::int from pg_policies where schemaname = ${again.schema}) as policies,
                 has_schema_privilege(${TOOL_API}, ${again.schema}, 'USAGE')
                   and has_schema_privilege(${RUNTIME}, ${again.schema}, 'USAGE') as usage
          from pg_class c where c.relnamespace = ${again.schema}::regnamespace and c.relkind = 'r'
        `;
        // (b) K-22's named exceptions: row-level security is on for proof_codes and sessions as well (README rule 5),
        // and its four excepted tables hold their own policies (rules 4, 5 and 8) in place of 0012's two.
        expect(row).toEqual({
          // (b) K-27's named exception (K-27 rule 5; DL-247): row-level security is on for calendar_links and
          // busy_blocks, scoped none, as well: 2 more (56 to 58 with K-27).
          on: POLICY_TABLES.length,
          // (b) K-27's named exception (K-27 rule 5; DL-247): its three excepted tables hold their own 11 policies,
          // where the generic count gave only the shares 0012's two: 9 more (118 to 127 with K-27).
          // (1) K-30's named exception (K-30 rule 5; DL-271): its five tables of part 1 hold their own 18 policies,
          // where the generic count gave 0012's two each: 8 more. Part 2 (DL-278): its seven tables with booking_id
          // hold their own 26, where the generic count gave 14: 12 more; quote_options holds 0012's two.
          policies: POLICY_TABLES.reduce(
            (sum, name) =>
              sum +
              (K22_POLICIES[name]?.length ?? K27_POLICIES[name]?.length ?? K30_POLICIES[name]?.length ?? 2),
            0,
          ),
          usage: true,
        });
      } finally {
        await again.drop();
      }
    },
  );
});

describe("refuse-cross-business-read.json (K-04 v1): another business's row is hidden from a Tool API call", () => {
  const fixture = readCore("fixtures/invalid/refuse-cross-business-read.json") as RefusedFixture;
  const { refused } = fixture;
  const read = (sql: Sql | Tx): Promise<readonly unknown[]> => {
    const conditions = Object.entries(refused.where).map(([column, value]) => sql`${sql(column)} = ${value}`);
    const where = conditions.reduce((all, condition) => sql`${all} and ${condition}`);
    return sql`select * from ${sql(refused.table)} where ${where}`;
  };

  it("scoped to the yoga studio, the read of Lee's Barbershop's booking returns no row, as the fixture expects", async () => {
    expect([refused.role, refused.action]).toEqual(["toolApi", "select"]);
    expect(await read(db.sql)).toHaveLength(1);
    const scope = refused.scope?.businessId ?? null;
    expect(scope).toBe("biz-yoga-studio");
    expect(await as(TOOL_API, scope, read)).toHaveLength(refused.expect.rows ?? -1);
  });

  it("without its one fault (Lee's Barbershop's own scope) the same read returns the row", async () => {
    expect(await as(TOOL_API, "biz-lees-barbershop", read)).toHaveLength(1);
  });
});

describe("a query with no scope, each business's scope, and rows with no business", () => {
  it(
    "with no scope, the Tool API role reads no row of any business-scoped table, though each has rows",
    SLOW,
    async () => {
      const zeros = Object.fromEntries(SCOPED.map((table) => [table.name, 0]));
      const seeded = await visibleRows(db.sql);
      expect(Object.entries(seeded).filter(([, n]) => n === 0)).toEqual([]);
      expect(await as(TOOL_API, null, visibleRows)).toEqual(zeros);
      // A scope that ended reads back as '' on its connection: no scope either.
      expect(
        await as(TOOL_API, null, async (tx) => {
          await tx`select set_config('rosie.business_id', '', true)`;
          return visibleRows(tx);
        }),
      ).toEqual(zeros);
    },
  );

  it(
    "each business's scope shows the Tool API role exactly that business's rows, in every business-scoped table",
    SLOW,
    async () => {
      const businesses = await businessIds();
      expect(businesses).toEqual(["biz-lees-barbershop", "biz-movers", "biz-yoga-studio"]);
      for (const business of businesses) {
        expect(await as(TOOL_API, business, visibleRows), business).toEqual(await ownerRows(business));
      }
      // A business with no rows at all: nothing.
      expect(await as(TOOL_API, "biz-nobody", visibleRows)).toEqual(await ownerRows("biz-nobody"));
    },
  );

  it(
    "a row whose business column is null is seen by no business scope, under either role",
    SLOW,
    async () => {
      const withNone = await ownerRows(null);
      expect(withNone.event_log).toBeGreaterThan(0);
      for (const table of SCOPED.filter((candidate) => !candidate.nullable)) {
        expect(withNone[table.name], table.name).toBe(0);
      }
      const zeros = Object.fromEntries(SCOPED.map((table) => [table.name, 0]));
      for (const business of await businessIds()) {
        for (const role of ROLES) {
          expect(await as(role, business, visibleRowsWithNoBusiness), `${role} at ${business}`).toEqual(
            zeros,
          );
        }
      }
      // The runtime side, unscoped, works with them (a sweep's job rows, sign-up before there is a business).
      expect(await as(RUNTIME, null, visibleRowsWithNoBusiness)).toEqual(withNone);
    },
  );

  it(
    "the runtime side with no scope reads every business's rows; with a scope set (per write) only that business's",
    SLOW,
    async () => {
      expect(await as(RUNTIME, null, visibleRows)).toEqual(await visibleRows(db.sql));
      for (const business of await businessIds()) {
        expect(await as(RUNTIME, business, visibleRows), business).toEqual(await ownerRows(business));
      }
    },
  );
});

describe("writes under a scope", () => {
  const room = {
    id: "res-rls-room",
    businessId: "biz-lees-barbershop",
    kind: "room" as const,
    name: "Back room",
  };
  const jobEntry = {
    id: "evlog-rls-job",
    trace_id: "trace-rls-0001",
    job_id: "job-rls-sweep",
    actor_kind: "job",
    kind: "clock_row.armed",
  };

  it("the Tool API role writes only its scope's rows: another business's insert is refused (42501), its update finds no row", async () => {
    expect((await refusal(as(TOOL_API, "biz-yoga-studio", (tx) => createResource(tx, room)))).code).toBe(
      "42501",
    );
    expect(await as(TOOL_API, "biz-lees-barbershop", (tx) => createResource(tx, room))).toMatchObject({
      id: room.id,
      businessId: room.businessId,
    });
    const bump = (tx: Tx): Promise<readonly unknown[]> =>
      tx`update bookings set version = version + 1 where id = 'booking-alex-haircut' returning id`;
    expect(await as(TOOL_API, "biz-yoga-studio", bump)).toHaveLength(0);
    expect(await as(TOOL_API, "biz-lees-barbershop", bump)).toHaveLength(1);
  });

  it("the Tool API role cannot move a row to another business, write with no scope, or delete", async () => {
    expect(
      (
        await refusal(
          as(
            TOOL_API,
            "biz-lees-barbershop",
            (tx) =>
              tx`update bookings set business_id = 'biz-yoga-studio', version = version + 1 where id = 'booking-alex-haircut'`,
          ),
        )
      ).code,
    ).toBe("42501");
    expect((await refusal(as(TOOL_API, null, (tx) => createResource(tx, room)))).code).toBe("42501");
    expect(
      (
        await refusal(
          as(
            TOOL_API,
            "biz-lees-barbershop",
            (tx) => tx`delete from bookings where id = 'booking-alex-haircut'`,
          ),
        )
      ).code,
    ).toBe("42501");
  });

  it("the runtime side scoped to one business (per write) cannot write another's row, nor one with no business", async () => {
    expect((await refusal(as(RUNTIME, "biz-yoga-studio", (tx) => createResource(tx, room)))).code).toBe(
      "42501",
    );
    expect(
      (await refusal(as(RUNTIME, "biz-yoga-studio", (tx) => tx`insert into event_log ${tx(jobEntry)}`))).code,
    ).toBe("42501");
    // With no scope, both go on the runtime side.
    expect(
      await as(RUNTIME, null, async (tx) => {
        await createResource(tx, room);
        await tx`insert into event_log ${tx(jobEntry)}`;
        return [await rowCount(tx, "resources"), await rowCount(tx, "event_log")];
      }),
    ).toEqual([(await rowCount(db.sql, "resources")) + 1, (await rowCount(db.sql, "event_log")) + 1]);
  });

  it("an outbox row, whose commit_seq is an identity column, is written with no grant on its sequence", async () => {
    const [row] = await db.sql<{ id: string; business: string }[]>`
      select id, business_id as business from outbox_rows where business_id is not null order by commit_seq limit 1
    `;
    expect(row).toBeDefined();
    const copy = (tx: Tx): Promise<readonly unknown[]> => tx`
      insert into outbox_rows (
        id, turn_id, recipient_handle_id, recipient_person_id, business_id, channel, versions_read, bundle_hash,
        bundle_build, trace_id
      )
      select 'outbox-rls-copy', turn_id, recipient_handle_id, recipient_person_id, business_id, channel, versions_read,
             bundle_hash, bundle_build, trace_id
      from outbox_rows where id = ${row?.id ?? ""}
      returning commit_seq
    `;
    expect(await as(RUNTIME, null, copy)).toHaveLength(1);
    expect(await as(TOOL_API, row?.business ?? "", copy)).toHaveLength(1);
  });
});

describe("tables that span businesses: phones, handles and sealing keys stay the guard's (MC C1)", () => {
  const guarded = ["phones", "handles", "sealing_keys"];

  it("the Tool API role is refused them (42501), scoped or not; the runtime side reads every row", async () => {
    for (const table of guarded) {
      const all = await rowCount(db.sql, table);
      expect(all, table).toBeGreaterThan(0);
      for (const scope of ["biz-lees-barbershop", null]) {
        const refused = await refusal(as(TOOL_API, scope, (tx) => rowCount(tx, table)));
        expect(refused.code, `${table} ${String(scope)}`).toBe("42501");
        expect(refused.message).toContain(`permission denied for table ${table}`);
      }
      expect(await as(RUNTIME, null, (tx) => rowCount(tx, table)), table).toBe(all);
    }
  });

  it("only the runtime side and the tables' owner hold a grant to read them: never PUBLIC or the Tool API role", async () => {
    const grants = await db.sql<{ table: string; grantee: string }[]>`
      select c.relname as table, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee
      from pg_class c cross join lateral aclexplode(c.relacl) a
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(guarded)}
        and a.privilege_type = 'SELECT'
      order by 1, 2
    `;
    const [me] = await db.sql<{ name: string }[]>`select current_user as name`;
    const owner = me?.name ?? "";
    expect(grants).toEqual(
      [...guarded].sort().flatMap((table) => [owner, RUNTIME].sort().map((grantee) => ({ table, grantee }))),
    );
  });

  it("the Tool API role holds no privilege on any table that spans businesses, release_flags included (CQ-59)", async () => {
    const held = await db.sql<{ table: string; privilege: string }[]>`
      select c.relname as table, p.privilege from pg_class c cross join unnest(${PRIVILEGES}::text[]) as p(privilege)
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(SPANNING)}
        and has_table_privilege(${TOOL_API}, c.oid, p.privilege)
    `;
    expect(held).toEqual([]);
    const refused = await refusal(as(TOOL_API, "biz-lees-barbershop", (tx) => rowCount(tx, "release_flags")));
    expect(refused.code).toBe("42501");
    expect(await as(RUNTIME, null, (tx) => rowCount(tx, "release_flags"))).toBeGreaterThan(0);
  });
});

describe("grants: select and insert, update only on versioned tables, delete only of a person's handle link", () => {
  it("each role holds exactly the privileges the migration names, and no truncate, references or trigger anywhere", async () => {
    const expected = (role: Role, table: ContractTable): string[] => {
      // K-34 v1 rule 4: the Tool API adds a harm report and never reads, changes or removes one.
      if (role === TOOL_API && table.name === "harm_reports") {
        return ["INSERT"];
      }
      // K-36 v1 README rule 2: the Tool API adds a page to Rosie's team and never reads, changes or removes one.
      if (role === TOOL_API && table.name === "team_pages") {
        return ["INSERT"];
      }
      // T-1094 (DL-149): the Tool API holds nothing on K-07's effects and provider_events, which only the runtime side's
      // K-05 v1.1 calls read and write.
      if (role === TOOL_API && ["effects", "provider_events"].includes(table.name)) {
        return [];
      }
      // K-22 v1.1 rule 8: the Tool API's grants on page_links are column grants only (never code_sha256), so it holds
      // no privilege on the whole table.
      if (role === TOOL_API && table.name === "page_links") {
        return [];
      }
      // K-22 v1 rule 5: on sessions (scope none) the Tool API holds INSERT on the whole table, under its insert policy;
      // its SELECT and UPDATE are column grants (never token_sha256 or device_sha256).
      if (role === TOOL_API && table.name === "sessions") {
        return ["INSERT"];
      }
      // K-24 v1 README rule 2: kinds and kind_flows are the shared catalog (scope none); the Tool API may select them
      // and never insert, update or delete (refused 42501).
      if (role === TOOL_API && ["kinds", "kind_flows"].includes(table.name)) {
        return ["SELECT"];
      }
      // K-26 v1 README rule 5: the closed registries (scope none) are every role's to read and no application role's
      // to write (refused 42501); only a migration's seed writes them.
      if (["trade_facts", "plugin_switches", "rule_kinds"].includes(table.name)) {
        return ["SELECT"];
      }
      // K-27 v1 README rule 5: the Tool API's grant on calendar_links is a column grant (every column but tokens), so
      // it holds no privilege on the whole table; on calendar_link_shares it holds SELECT, and its INSERT and UPDATE
      // are column grants (a share's five columns; ended_at and version).
      if (role === TOOL_API && table.name === "calendar_links") {
        return [];
      }
      if (role === TOOL_API && table.name === "calendar_link_shares") {
        return ["SELECT"];
      }
      // K-27 v1 README rule 5: busy_blocks (scope none) is both roles' in full, behind its policies: the Tool API reads
      // through a live share and writes only its own photo rows; the runtime side's sync deletes a block whose event
      // went, or that ended.
      if (table.name === "busy_blocks") {
        return ["DELETE", "INSERT", "SELECT", "UPDATE"];
      }
      // K-33 v1 README rule 2: the Tool API selects and inserts a bill card, and its UPDATE of removed_at and version is
      // a column grant; it only selects bills; it selects lines, and its UPDATE of a line's question is a column grant.
      if (role === TOOL_API && table.name === "bill_cards") {
        return ["INSERT", "SELECT"];
      }
      if (role === TOOL_API && ["monthly_bills", "monthly_bill_lines"].includes(table.name)) {
        return ["SELECT"];
      }
      // K-35 v1 README rule 5: both roles select and insert documents, and their UPDATE of its listing flag,
      // signed-by-all time, withdrawal and version is a column grant (the column-grant check); K-35's other four tables,
      // written once, take the generic select and insert.
      if (table.name === "documents") {
        return ["INSERT", "SELECT"];
      }
      // K-30 v1 README rule 6 (DL-278): the Tool API's read of secure_links is a column grant (every column but
      // code_sha256, exception (3)), so on the whole table it holds INSERT alone; the runtime side reads the whole row.
      if (role === TOOL_API && table.name === "secure_links") {
        return ["INSERT"];
      }
      // K-30 v1 README rule 6: both roles select and insert booking_lines, booking_visits, secure_links (the Tool API's
      // select apart, above) and waitlist_entries, and their UPDATE of rule 6's named columns is a column grant (the
      // column-grant check); booking_details, quotes, quote_options, owner_oks and booking_addresses (versioned) take
      // the generic UPDATE, booking_details' written-once values held by its trigger; the snapshot's two tables,
      // booking_changes and page_answers (written once, not versioned) the generic select and insert. No role deletes
      // any of the thirteen.
      if (Object.keys(K30_COLUMN_UPDATES).includes(table.name)) {
        return ["INSERT", "SELECT"];
      }
      // K-28 v1 README rule 5: both roles select, insert and update customers and customer_blocks (business-scoped and
      // versioned), as table grants, and never delete: the generic rule below, with no exception.
      if (role === TOOL_API && table.rowLevelSecurity.scope !== "business") {
        return [];
      }
      return [
        "SELECT",
        "INSERT",
        // chat_links takes UPDATE on four of its columns only, never on the whole row (T-1094; the next check).
        ...(table.versioned && table.name !== "chat_links" ? ["UPDATE"] : []),
        // K-05 item 29 removes a person's handle link; K-07 deletes a claim at a row's move to waiting_chat.
        ...(role === RUNTIME && ["person_handles", "outbox_claims"].includes(table.name) ? ["DELETE"] : []),
        // K-25 v1 README rule 6: the Tool API removes a link between a space and a service (S1-81 and Settings).
        ...(role === TOOL_API && table.name === "item_services" ? ["DELETE"] : []),
        // K-27 v1 README rule 5: the Tool API deletes a span of weekly hours no longer open (S1-21, S11-57).
        ...(role === TOOL_API && table.name === "weekly_hours" ? ["DELETE"] : []),
      ].sort();
    };
    const held = await db.sql<{ role: string; table: string; privilege: string }[]>`
      select r.role, c.relname as table, p.privilege
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_class c
        cross join unnest(${PRIVILEGES}::text[]) as p(privilege)
      where c.relnamespace = ${db.schema}::regnamespace and c.relkind = 'r'
        and has_table_privilege(r.role, c.oid, p.privilege)
      order by 1, 2, 3
    `;
    const tables = [...ALL_TABLES].sort((a, b) => a.name.localeCompare(b.name));
    const want = ROLES.flatMap((role) =>
      tables.flatMap((table) =>
        expected(role, table).map((privilege) => ({ role, table: table.name, privilege })),
      ),
    );
    expect(held).toEqual(want);
    // The migrations' own table is no role's.
    expect(held.filter((row) => row.table === "schema_migrations")).toEqual([]);
  });

  it("column grants: both roles update chat_links' given_via, owner_retold_at, used_at and version only, and no other column of the schema holds a grant of its own but rosie_app's on K-22's proof_codes, sessions and page_links (T-1094; README rules 5 and 8), on K-27's calendar_links and calendar_link_shares (K-27 rule 5) and on K-33's bill_cards and monthly_bill_lines (K-33 rule 2), and both roles' on K-35's documents (K-35 rule 5) and on K-30's booking_lines, booking_visits, secure_links and waitlist_entries, with rosie_app's read of every secure_links column but its code hash (K-30 rule 6)", async () => {
    const columnGrants = await db.sql<
      { table: string; column: string; grantee: string; privilege: string }[]
    >`
      select c.relname as table, a.attname as column,
             case when g.grantee = 0 then 'PUBLIC' else pg_get_userbyid(g.grantee) end as grantee,
             g.privilege_type as privilege
      from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        cross join lateral aclexplode(a.attacl) g
      where c.relnamespace = ${db.schema}::regnamespace and a.attacl is not null
      order by 1, 2, 3, 4
    `;
    // (c) K-22's named exception: rosie_app's column grants on proof_codes and sessions (README rule 5) and page_links
    // (rule 8), every grantee's on those three tables held to exactly them; people-access.int.test.ts checks them too.
    const k22Tables = K22_COLUMN_GRANTS.map((grant) => grant.table);
    const key = (grant: { table: string; column: string; grantee: string; privilege: string }): string =>
      `${grant.table} ${grant.column} ${grant.grantee} ${grant.privilege}`;
    expect(
      columnGrants
        .filter((grant) => k22Tables.includes(grant.table))
        .map(key)
        .sort(),
    ).toEqual(
      K22_COLUMN_GRANTS.flatMap(({ table, privilege, columns }) =>
        columns.map((column) => key({ table, column, grantee: TOOL_API, privilege })),
      ).sort(),
    );
    // (c) K-27's named exception (K-27 rule 5, with rule 6 for the sealed tokens; DL-247): rosie_app's 23 column grants
    // on calendar_links (every column but tokens) and calendar_link_shares (a share's five, and ended_at and version),
    // every grantee's on those two tables held to exactly them, so a column grant of tokens to any role fails here (the
    // runtime side holds the link by table grants); availability.int.test.ts checks them too.
    const k27Tables = K27_COLUMN_GRANTS.map((grant) => grant.table);
    expect(
      columnGrants
        .filter((grant) => k27Tables.includes(grant.table))
        .map(key)
        .sort(),
    ).toEqual(
      K27_COLUMN_GRANTS.flatMap(({ table, privilege, columns }) =>
        columns.map((column) => key({ table, column, grantee: TOOL_API, privilege })),
      ).sort(),
    );
    // (c) K-33's named exception (K-33 rule 2; DL-250): rosie_app's 6 UPDATE column grants on bill_cards (removed_at and
    // version) and monthly_bill_lines (questioned_at, questioned_by_person_id, question and version), every grantee's
    // on those two tables held to exactly them, so a column grant of a card's Stripe ids or a line's amount or answer
    // to any role fails here (the runtime side holds the three tables by table grants); platform-billing.int.test.ts
    // checks them too.
    const k33Tables = K33_COLUMN_GRANTS.map((grant) => grant.table);
    expect(
      columnGrants
        .filter((grant) => k33Tables.includes(grant.table))
        .map(key)
        .sort(),
    ).toEqual(
      K33_COLUMN_GRANTS.flatMap(({ table, privilege, columns }) =>
        columns.map((column) => key({ table, column, grantee: TOOL_API, privilege })),
      ).sort(),
    );
    // (c) K-35's named exception (K-35 rule 5; DL-256), in chat_links' both-roles form: both roles' UPDATE of
    // documents' shown_on_listing, signed_by_all_at, withdrawn_at, withdrawn_why, withdrawn_by_person_id and version
    // only, every grantee's on documents held to exactly them, so a column grant of a given value (number, issuer,
    // ends) or of what a document is to any role fails here; K-35's other four tables stay under the generic check
    // below, so they hold no column grant; documents-licenses.int.test.ts checks them too.
    const k35Tables = ["documents"];
    expect(
      columnGrants
        .filter((grant) => k35Tables.includes(grant.table))
        .map(key)
        .sort(),
    ).toEqual(
      K35_DOCUMENT_UPDATES.flatMap((column) =>
        [...ROLES].map((grantee) => key({ table: "documents", column, grantee, privilege: "UPDATE" })),
      ).sort(),
    );
    // has_column_privilege agrees for documents, column by column, as for chat_links below.
    const documentUpdatable = await db.sql<{ role: string; column: string }[]>`
      select r.role, a.attname as column
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_attribute a
      where a.attrelid = ${`${db.schema}.documents`}::regclass and a.attnum > 0 and not a.attisdropped
        and has_column_privilege(r.role, a.attrelid, a.attnum, 'UPDATE')
      order by 1, a.attnum
    `;
    expect(documentUpdatable).toEqual(
      ROLES.flatMap((role) => K35_DOCUMENT_UPDATES.map((column) => ({ role, column }))),
    );
    // (2) K-30's named exception (K-30 rule 6; DL-271, DL-278), in chat_links' both-roles form: both roles' UPDATE of
    // booking_lines' state, removed_at, removed_by_change_id and version, of booking_visits' reservation_id,
    // arrival_window, cutoff_at and version, and of secure_links' and waitlist_entries' ended_at, ended_why and version
    // only, every grantee's on those four tables held to exactly them (with (3) below), so a column grant of a copied
    // price, a visit's check-in code, a link's code hash or what orders the waitlist to any role fails here; K-30's
    // other nine tables stay under the generic check below, so they hold no column grant;
    // bookings-changes.int.test.ts and bookings-changes-2.int.test.ts check them too.
    const k30Tables = Object.keys(K30_COLUMN_UPDATES);
    expect(
      columnGrants
        .filter((grant) => k30Tables.includes(grant.table))
        .map(key)
        .sort(),
    ).toEqual(
      [
        ...Object.entries(K30_COLUMN_UPDATES).flatMap(([table, columns]) =>
          columns.flatMap((column) =>
            [...ROLES].map((grantee) => key({ table, column, grantee, privilege: "UPDATE" })),
          ),
        ),
        // (3) K-30's named exception (K-30 rule 6; DL-278): rosie_app's SELECT of every secure_links column but
        // code_sha256, by name, the only SELECT column grants on K-30's tables.
        ...K30_LINK_SELECTS.map((column) =>
          key({ table: "secure_links", column, grantee: TOOL_API, privilege: "SELECT" }),
        ),
      ].sort(),
    );
    // (3) has_column_privilege agrees, by name: the Tool API reads every secure_links column but code_sha256, and the
    // runtime side every column, the hash included.
    const linkReadable = await db.sql<{ role: string; column: string }[]>`
      select r.role, a.attname as column
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_attribute a
      where a.attrelid = ${`${db.schema}.secure_links`}::regclass and a.attnum > 0 and not a.attisdropped
        and has_column_privilege(r.role, a.attrelid, a.attnum, 'SELECT')
      order by 1, a.attnum
    `;
    expect(linkReadable.filter((row) => row.role === TOOL_API).map((row) => row.column)).toEqual(
      K30_LINK_SELECTS,
    );
    expect(linkReadable.filter((row) => row.role === RUNTIME).map((row) => row.column)).toEqual([
      "id",
      "booking_id",
      "business_id",
      "purpose",
      "person_id",
      "handle_id",
      "given_via",
      "code_sha256",
      "issued_at",
      "ended_at",
      "ended_why",
      "version",
    ]);
    // has_column_privilege agrees for both, column by column, in each table's column order.
    for (const [table, columns] of Object.entries(K30_COLUMN_UPDATES)) {
      const k30Updatable = await db.sql<{ role: string; column: string }[]>`
        select r.role, a.attname as column
        from unnest(${[...ROLES]}::text[]) as r(role)
          cross join pg_attribute a
        where a.attrelid = ${`${db.schema}.${table}`}::regclass and a.attnum > 0 and not a.attisdropped
          and has_column_privilege(r.role, a.attrelid, a.attnum, 'UPDATE')
        order by 1, a.attnum
      `;
      expect(k30Updatable, table).toEqual(
        ROLES.flatMap((role) => columns.map((column) => ({ role, column }))),
      );
    }
    expect(
      columnGrants.filter(
        (grant) =>
          !k22Tables.includes(grant.table) &&
          !k27Tables.includes(grant.table) &&
          !k33Tables.includes(grant.table) &&
          !k35Tables.includes(grant.table) &&
          !k30Tables.includes(grant.table),
      ),
    ).toEqual(
      CHAT_LINK_UPDATES.flatMap((column) =>
        [...ROLES].sort().map((grantee) => ({ table: "chat_links", column, grantee, privilege: "UPDATE" })),
      ),
    );
    // has_column_privilege agrees, column by column: the ready text, the code and every other column stay as issued.
    const updatable = await db.sql<{ role: string; column: string }[]>`
      select r.role, a.attname as column
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_attribute a
      where a.attrelid = ${`${db.schema}.chat_links`}::regclass and a.attnum > 0 and not a.attisdropped
        and has_column_privilege(r.role, a.attrelid, a.attnum, 'UPDATE')
      order by 1, 2
    `;
    expect(updatable).toEqual(ROLES.flatMap((role) => CHAT_LINK_UPDATES.map((column) => ({ role, column }))));
  });

  it("refuse-event-log-update.json under the runtime side: refused by privilege (42501), before the trigger", async () => {
    const fixture = readCore("fixtures/invalid/refuse-event-log-update.json") as RefusedFixture;
    const { refused } = fixture;
    expect([refused.role, refused.action, refused.scope]).toEqual(["runtime", "update", null]);
    const outcome = await refusal(
      as(
        RUNTIME,
        null,
        (tx) =>
          tx`update ${tx(refused.table)} set new_values = ${tx.json(refused.set?.new_values ?? null)}
             where id = ${refused.where.id ?? ""}`,
      ),
    );
    expect(outcome.code).toBe(refused.expect.sqlstate);
    expect(outcome.message).toContain("permission denied for table event_log");
  });

  it("event_log: both roles insert and select; an update, a delete or a truncate is refused by privilege (42501)", async () => {
    for (const role of ROLES) {
      const entry = {
        id: `evlog-rls-${role}`,
        trace_id: "trace-rls-0002",
        job_id: "job-rls-append",
        actor_kind: "job",
        kind: "clock_row.armed",
        business_id: "biz-lees-barbershop",
      };
      expect(
        await as(role, "biz-lees-barbershop", async (tx) => {
          await tx`insert into event_log ${tx(entry)}`;
          return (await tx`select id from event_log where id = ${entry.id}`).length;
        }),
        role,
      ).toBe(1);
      for (const statement of [
        "update event_log set kind = 'edited' where id = 'evlog-0001'",
        "delete from event_log where id = 'evlog-0001'",
        "truncate event_log",
      ]) {
        const refused = await refusal(as(role, "biz-lees-barbershop", (tx) => tx.unsafe(statement)));
        expect(refused.code, `${role}: ${statement}`).toBe("42501");
        expect(refused.message, `${role}: ${statement}`).toContain("permission denied for table event_log");
      }
    }
  });

  it("bundle_values is written once: neither role may update it (CQ-59)", async () => {
    for (const role of ROLES) {
      const refused = await refusal(as(role, null, (tx) => tx`update bundle_values set sha256 = sha256`));
      expect(refused.code, role).toBe("42501");
    }
  });
});

describe("the security-definer functions: the two that read across businesses (K-05 item 8; T-1085) and the handle read (T-1094)", () => {
  it("are security definer, owned by the tables' owner (not bound by row-level security), bound when made, with a pinned search_path", async () => {
    const rows = await db.sql<
      {
        name: string;
        definer: boolean;
        owner: string;
        config: string[];
        bound: boolean;
        args: string;
        result: string;
      }[]
    >`
      select p.proname as name, p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner, p.proconfig as config,
             p.prosqlbody is not null as bound, pg_get_function_identity_arguments(p.oid) as args,
             pg_get_function_result(p.oid) as result
      from pg_proc p where p.pronamespace = ${db.schema}::regnamespace and p.proname in ${db.sql(FUNCTIONS)}
      order by p.proname
    `;
    const [table] = await db.sql<{ owner: string }[]>`
      select pg_get_userbyid(relowner) as owner from pg_class where oid = ${`${db.schema}.reservations`}::regclass
    `;
    const shared = {
      definer: true,
      owner: table?.owner,
      config: ["search_path=pg_catalog, pg_temp"],
      bound: true,
    };
    expect(rows).toEqual([
      {
        name: "handles_id_of_mobile",
        ...shared,
        args: "mobile_wanted text",
        result: "text",
      },
      {
        name: "reservations_booked_overlap",
        ...shared,
        args: "resource_wanted text, worker_wanted text, during_wanted tstzrange",
        result: "boolean",
      },
      {
        name: "reservations_saved_times",
        ...shared,
        args: "phone_wanted text, held_after timestamp with time zone",
        result: "TABLE(id text, held_until timestamp with time zone)",
      },
    ]);
  });

  it("no other function of the schema is security definer but K-22's five (README rules 5 and 8): reservations_saved_times stays the only read of saved times across businesses", async () => {
    const definers = await db.sql<{ name: string }[]>`
      select p.proname as name from pg_proc p
      where p.pronamespace = ${db.schema}::regnamespace and p.prosecdef
      order by 1
    `;
    // (d) K-22's named exception: README rule 5's four calls and rule 8's page_link_for_code are security definer too,
    // pinned to <schema>, pg_temp; people-access.int.test.ts checks each (owner, search_path, arguments, EXECUTE).
    expect(definers.map((row) => row.name)).toEqual([...FUNCTIONS, ...K22_FUNCTIONS].sort());
  });

  it("only the roles each one names may run them (and their owner): the handle read the Tool API's alone, never PUBLIC", async () => {
    const grants = await db.sql<{ name: string; grantee: string }[]>`
      select p.proname as name, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee
      from pg_proc p cross join lateral aclexplode(p.proacl) a
      where p.pronamespace = ${db.schema}::regnamespace and p.proname in ${db.sql(FUNCTIONS)}
        and a.privilege_type = 'EXECUTE'
      order by 1, 2
    `;
    const [me] = await db.sql<{ name: string }[]>`select current_user as name`;
    expect(grants).toEqual(
      FUNCTIONS.flatMap((name) =>
        [me?.name ?? "", ...(RUNS[name] ?? [])].sort().map((grantee) => ({ name, grantee })),
      ),
    );
  });

  it("run as the Tool API role under one business's scope, they read every business's rows, and the scope stays", async () => {
    // Alex's mobile holds a saved time at Lee's Barbershop (seed-reservation); the yoga studio's scope cannot see it.
    const answer = await as(TOOL_API, "biz-yoga-studio", async (tx) => {
      const direct = await tx<{ id: string }[]>`
        select id from reservations where for_phone_number = '+15555550101' and state = 'held'
      `;
      const saved = await tx<{ id: string }[]>`
        select id from reservations_saved_times('+15555550101', '2026-11-07T15:05:00Z')
      `;
      const [overlap] = await tx<{ yes: boolean }[]>`
        select reservations_booked_overlap('res-maya', 'person-riley',
          tstzrange('2026-10-24T15:10:00Z', '2026-10-24T15:20:00Z', '[)')) as yes
      `;
      const [scope] = await tx<{ value: string }[]>`select current_setting('rosie.business_id') as value`;
      return {
        direct: direct.map((row) => row.id),
        saved: saved.map((row) => row.id),
        overlap: overlap?.yes,
        scope: scope?.value,
      };
    });
    // Riley's booked haircut at Lee's Barbershop covers that time, though the yoga studio's scope cannot see it.
    expect(answer).toEqual({
      direct: [],
      saved: ["rsv-alex-saved-avery"],
      overlap: true,
      scope: "biz-yoga-studio",
    });
  });

  it("the booked-overlap probe crosses businesses only through the worker: another business's resource asked by its id answers nothing, and with no scope a resource matches nowhere (T-1094; FS line 743)", async () => {
    const probe =
      (resource: string, worker: string | null) =>
      async (tx: Tx): Promise<boolean | undefined> => {
        const [row] = await tx<{ yes: boolean }[]>`
          select reservations_booked_overlap(${resource}, ${worker}::text,
            tstzrange('2026-10-24T15:10:00Z', '2026-10-24T15:20:00Z', '[)')) as yes
        `;
        return row?.yes;
      };
    // Riley's booked haircut is on res-riley, Lee's Barbershop's worker (seed-reservation). From the yoga studio, by the
    // worker: yes; by Lee's Barbershop's resource id alone: nothing.
    expect(await as(TOOL_API, "biz-yoga-studio", probe("res-maya", "person-riley"))).toBe(true);
    expect(await as(TOOL_API, "biz-yoga-studio", probe("res-riley", null))).toBe(false);
    // Lee's Barbershop's own scope matches its resource by id; with no scope, under either role, it is matched nowhere.
    expect(await as(TOOL_API, "biz-lees-barbershop", probe("res-riley", null))).toBe(true);
    for (const role of ROLES) {
      expect(await as(role, null, probe("res-riley", null)), role).toBe(false);
    }
  });
});

describe("handles_id_of_mobile: a business-scoped call reads the handle id of one mobile it names, and nothing else (T-1094; K-05 item 8, v1.2 item 26)", () => {
  const read =
    (mobile: string) =>
    (tx: Tx): Promise<Record<string, unknown>[]> =>
      tx<Record<string, unknown>[]>`select * from handles_id_of_mobile(${mobile})`;

  it("answers the Tool API, under any business's scope, the mobile's handle id alone: one column, one value", async () => {
    for (const business of await businessIds()) {
      expect(await as(TOOL_API, business, read("+15555550101")), business).toEqual([
        { handles_id_of_mobile: "handle-alex" },
      ]);
    }
    // A stopped mobile's handle the same (seed-phone-stopped): the id carries no flag and no other column.
    expect(await as(TOOL_API, "biz-lees-barbershop", read("+15555550106"))).toEqual([
      { handles_id_of_mobile: "handle-ben" },
    ]);
    // The tables themselves stay closed to the Tool API (MC C1).
    for (const table of ["handles", "phones"]) {
      const refused = await refusal(as(TOOL_API, "biz-lees-barbershop", (tx) => rowCount(tx, table)));
      expect(refused.code, table).toBe("42501");
    }
  });

  it("answers nothing for an unknown number, for an address that is not a mobile's, and with no scope or a scope that ended", async () => {
    const nothing = [{ handles_id_of_mobile: null }];
    // +15555550199 is a number no seed's handle has; alex@example.com is Alex's email handle (seed-person-roles).
    expect(await as(TOOL_API, "biz-lees-barbershop", read("+15555550199"))).toEqual(nothing);
    expect(await as(TOOL_API, "biz-lees-barbershop", read("alex@example.com"))).toEqual(nothing);
    expect(await as(TOOL_API, null, read("+15555550101"))).toEqual(nothing);
    expect(
      await as(TOOL_API, null, async (tx) => {
        await tx`select set_config('rosie.business_id', '', true)`;
        return read("+15555550101")(tx);
      }),
    ).toEqual(nothing);
  });

  it("is not the runtime side's to run: rosie_job reads handles itself and is refused it (42501)", async () => {
    const refused = await refusal(as(RUNTIME, "biz-lees-barbershop", read("+15555550101")));
    expect(refused.code).toBe("42501");
    expect(refused.message).toContain("permission denied for function handles_id_of_mobile");
  });
});

describe("a Tool API path that runs as rosie_job refuses an empty scope (T-1094; T-191's security review, note b; CQ-70)", () => {
  const bookings = (tx: Tx): Promise<number> => rowCount(tx, "bookings");
  /** Reads bookings only once requireBusinessScope() has found the transaction's scope. */
  const guarded = async (tx: Tx): Promise<number> => {
    await requireBusinessScope(tx);
    return bookings(tx);
  };
  /** withBusiness() as a Tool API call runs it, on the runtime side's role. */
  const onJob = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withBusiness(db.sql, "biz-lees-barbershop", async (tx) => {
      await tx.unsafe(`set local role ${RUNTIME}`);
      return fn(tx);
    });
  const refusedEntry = {
    id: "evlog-t1094-refused",
    trace_id: "trace-t1094-0001",
    job_id: "job-t1094-scope",
    actor_kind: "job",
    kind: "clock_row.armed",
  };

  it("withBusiness refuses an empty or blank business id before it opens a transaction", async () => {
    const callback = vi.fn(() => Promise.resolve());
    for (const empty of ["", "   "]) {
      await expect(withBusiness(db.sql, empty, callback)).rejects.toThrow(TypeError);
    }
    expect(callback).not.toHaveBeenCalled();
  });

  it("requireBusinessScope refuses rosie_job's transaction with no scope, or a scope that ended (''), before it reads; with a scope it answers that scope", async () => {
    const all = await rowCount(db.sql, "bookings");
    const lees = (await ownerRows("biz-lees-barbershop")).bookings;
    expect(lees).toBeLessThan(all);
    // What the check stops: with no scope, the runtime side's role reads every business's bookings.
    expect(await as(RUNTIME, null, bookings)).toBe(all);
    await expect(as(RUNTIME, null, guarded)).rejects.toThrow(BusinessScopeError);
    await expect(
      as(RUNTIME, null, async (tx) => {
        await tx`select set_config('rosie.business_id', '', true)`;
        return guarded(tx);
      }),
    ).rejects.toThrow(BusinessScopeError);
    expect(await as(RUNTIME, "biz-lees-barbershop", requireBusinessScope)).toBe("biz-lees-barbershop");
    expect(await as(RUNTIME, "biz-lees-barbershop", guarded)).toBe(lees);
  });

  it("withBusiness on rosie_job: a call that empties its scope, or changes it, is refused and rolled back, and nothing it read is returned", async () => {
    const all = await rowCount(db.sql, "bookings");
    const lees = (await ownerRows("biz-lees-barbershop")).bookings;
    expect(await onJob(bookings)).toBe(lees);
    let seen = -1;
    await expect(
      onJob(async (tx) => {
        await tx`select set_config('rosie.business_id', '', true)`;
        seen = await bookings(tx);
        await tx`insert into event_log ${tx(refusedEntry)}`;
        return seen;
      }),
    ).rejects.toThrow(BusinessScopeError);
    // The emptied scope did read every business's rows inside the call: none of it left, and its write was undone.
    expect(seen).toBe(all);
    expect(await db.sql`select id from event_log where id = ${refusedEntry.id}`).toHaveLength(0);
    await expect(
      onJob(async (tx) => {
        await tx`select set_config('rosie.business_id', 'biz-yoga-studio', true)`;
        return bookings(tx);
      }),
    ).rejects.toThrow(BusinessScopeError);
  });
});
