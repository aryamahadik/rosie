// T-728: the journey-states seed set, against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/seeds/journey-states`). Each block migrates a fresh test schema of its own
// (db/repo/test-db.ts), seeds there only, and drops it at the end; the shared public schema is never touched.
//
// The card's proofs: `node db/seeds/run.mjs --set journey-states` loads one state per money combo SCENARIOS.md lists,
// for flow A and flow B; each seeded saved time holds a reservation that reserve() refuses to give anyone else; the
// staging seed run never loads the set (its sets, run as seed-staging.sh runs them, and `--set staging-signed-up`, leave
// no row of it); re-running is idempotent. The set runs through the runner itself, in a process of its own, as the card
// names it, on a schema the sets it builds on were seeded into first (core, setup, kinds, services, staff, availability
// and customers: setup-business takes a wrapping key, which only a caller can hand it, so they run here as functions).
//
// What each state must hold is built here from the fixture files themselves (node:fs): SCENARIOS.md's combo lines, each
// shop file's money example of that flow and path (its price, deposit and staff), and the ids the other seeds' cards
// name, never through the set's own planner, then compared with the rows the database holds. The wrapping key the setup
// seed seals the owners' ID uploads with is made here from random bytes for each run and never written or printed.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "../repo/client";
import { reserve, STANDARD_HOLD_MINUTES } from "../repo/reservations";
import { DEFAULT_WRAPPING_KEY_NAME, type WrappingKeys } from "../repo/sealing";
import type { Sql } from "../repo/scope";
import { createTestDatabase, type TestDatabase } from "../repo/test-db";
import { seedCore } from "./core";
import { seedCustomers } from "./customers";
import {
  JOURNEY_STAGES,
  type JourneyStage,
  journeyStatesPlanOf,
  SAVED_TIME_MINUTES,
  SEALED_ADDRESS_STAND_IN,
  scenariosOf,
} from "./journey-states";
import { seedKinds } from "./kinds";
import { openFixtureSet, verifyFixtureSet } from "./lib/fixture-set";
import { seedSetupAvailability } from "./setup-availability";
import { seedSetupBusiness } from "./setup-business";
import { PATHS_OF_FLOW, seedSetupServicesRules } from "./setup-services-rules";
import { seedSetupStaff } from "./setup-staff";

const SLOW = { timeout: 300_000 };
const SETUP_MS = 900_000;
const REPO = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const V1 = path.join(REPO, "fixtures/v1");
const RUNNER = path.join(REPO, "db/seeds/run.mjs");
const SEED_STAGING = path.join(REPO, "infra/scripts/seed-staging.sh");
const SET = "journey-states";
const LOCAL_URL = resolvePrimaryUrl();
// The variables the runner reads: each run sets only the ones it names.
const RUNNER_VARIABLES = new Set([
  "DATABASE_URL",
  "DATABASE_REPLICA_URL",
  "DB_SCHEMA",
  "STAGING_DATABASE_URL",
  "STAGING_TEST_PHONES",
  "STAGING_CHECK_TESTER_TOKEN_SHA256",
  "CI",
]);
// Every table the set writes, in the order it writes them.
const TABLES = [
  "resources",
  "price_rules",
  "bookings",
  "booking_details",
  "quotes",
  "quote_options",
  "booking_lines",
  "reservations",
  "booking_addresses",
  "secure_links",
  "effects",
  "saved_cards",
  "payments",
  "payment_items",
  "ledger_lines",
  "booking_visits",
  "booking_terms",
  "booking_terms_rules",
] as const;
// The tables that hold only booking states: the sets the set builds on write none of them.
const STATE_TABLES = TABLES.filter((table) => table !== "resources" && table !== "price_rules");
// The demo shops' zone (QUESTIONS.md Q-54), in which their open hours (the availability seed's weekly_hours rows) and
// every visit's local day and time are read.
const ZONE = "America/New_York";
// The town of the one listing address every demo shop gives ("[G] 123 Demo St, Anytown (demo)"): flow B's area.
const DEMO_TOWN = "Anytown";

/** One wrapping key per run for the setup seed's ID uploads: random, in memory only, under the Workers secret's name. */
const WRAP_BYTES = crypto.getRandomValues(new Uint8Array(32));
const KEYS: WrappingKeys = {
  resolve: (name) => (name === DEFAULT_WRAPPING_KEY_NAME ? WRAP_BYTES : undefined),
};

type Flow = "A" | "B";

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `node db/seeds/run.mjs <args>` with this environment's variables, less the runner's own, plus `env`. */
function runSeed(args: readonly string[], env: Readonly<Record<string, string>>): Promise<Run> {
  const childEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !RUNNER_VARIABLES.has(name)) {
      childEnv[name] = value;
    }
  }
  Object.assign(childEnv, env);
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [RUNNER, ...args],
      { cwd: REPO, env: childEnv, timeout: 280_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : error.code;
        if (typeof code === "number") {
          resolve({ code, stdout, stderr });
        } else {
          reject(error ?? new Error("the runner ended with no exit code"));
        }
      },
    );
  });
}

/** Seeds every set journey-states builds on, in their order, as functions (setup-business takes the wrapping key). */
async function seedPriorSets(sql: Sql): Promise<void> {
  await seedCore(sql);
  await seedSetupBusiness(sql, { wrappingKeys: KEYS });
  await seedKinds(sql);
  await seedSetupServicesRules(sql);
  await seedSetupStaff(sql);
  await seedSetupAvailability(sql);
  await seedCustomers(sql);
}

/** Dollars as the shop files write them ("$35", "$1,200", "free"), in cents; null for none. */
function centsOf(words: unknown): number | null {
  if (typeof words !== "string") {
    return null;
  }
  if (words === "free") {
    return 0;
  }
  const match = /^\$([0-9,]+)(?:\.([0-9]{2}))?$/.exec(words);
  return match?.[1] === undefined
    ? null
    : Number(match[1].replaceAll(",", "")) * 100 + Number(match[2] ?? "0");
}

interface Expected {
  readonly flow: Flow;
  readonly path: string;
  readonly shopId: string;
  readonly service: string;
  readonly key: string;
  readonly business: string;
  readonly customerId: string;
  readonly customerPerson: string;
  readonly customerHandle: string;
  readonly otherCustomerHandle: string;
  /** The pro: the flow's first team member where the shop file names staff, else the owner. */
  readonly pro: string;
  readonly priceBy: "list" | "photos" | "visit";
  readonly before: "none" | "card" | "deposit" | "full";
  /** The example's price, deposit and the stage ids. */
  readonly price: number | null;
  readonly deposit: number | null;
  readonly bookings: Readonly<Record<JourneyStage, string>>;
}

const STAGE_SLUGS: Readonly<Record<JourneyStage, string>> = {
  request: "request",
  time_saved: "time-saved",
  money_before: "money-before",
  booked: "booked",
};

/** Every combo SCENARIOS.md lists and what its states must hold, read here from the files themselves. */
function expectedStates(): Expected[] {
  const text = readFileSync(path.join(V1, "test-kit/SCENARIOS.md"), "utf8");
  const out: Expected[] = [];
  for (const line of text.split("\n")) {
    const match = /^### (A|B) · `([^`]+)` on (\S+) \((.*)\)$/.exec(line);
    if (
      match?.[1] === undefined ||
      match[2] === undefined ||
      match[3] === undefined ||
      match[4] === undefined
    ) {
      continue;
    }
    const flow = match[1] as Flow;
    const comboPath = match[2];
    const shopId = match[3];
    const shop = JSON.parse(readFileSync(path.join(V1, "test-kit/shops", `${shopId}.json`), "utf8")) as {
      flows: Record<
        string,
        { staff?: unknown; services: { combo: string; price: unknown; deposit: unknown }[] }
      >;
    };
    const block = shop.flows[flow];
    const example = block?.services.find((entry) => entry.combo === comboPath);
    if (block === undefined || example === undefined) {
      throw new Error(`SCENARIOS.md names ${shopId}'s flow ${flow} ${comboPath}, which its file lacks`);
    }
    const [priceBy, before] = comboPath.split("|") as [Expected["priceBy"], Expected["before"]];
    const key = `${shopId}-${flow.toLowerCase()}-${comboPath.replaceAll("|", "-")}`;
    const namesStaff = typeof block.staff === "string" && block.staff.trim() !== "";
    out.push({
      flow,
      path: comboPath,
      shopId,
      service: match[4],
      key,
      business: `biz-demo-${shopId}`,
      customerId: `customer-demo-${shopId}-1`,
      customerPerson: `person-demo-${shopId}-customer-1`,
      customerHandle: `handle-demo-${shopId}-customer-1`,
      otherCustomerHandle: `handle-demo-${shopId}-customer-2`,
      pro: namesStaff ? `person-demo-${shopId}-${flow.toLowerCase()}-1` : `person-demo-${shopId}-owner`,
      priceBy,
      before,
      price: centsOf(example.price),
      deposit: before === "deposit" ? centsOf(example.deposit) : null,
      bookings: {
        request: `booking-journey-${key}-${STAGE_SLUGS.request}`,
        time_saved: `booking-journey-${key}-${STAGE_SLUGS.time_saved}`,
        money_before: `booking-journey-${key}-${STAGE_SLUGS.money_before}`,
        booked: `booking-journey-${key}-${STAGE_SLUGS.booked}`,
      },
    });
  }
  return out;
}

const EXPECTED = expectedStates();
const BY_BOOKING = new Map(
  EXPECTED.flatMap((combo) =>
    JOURNEY_STAGES.map((stage) => [combo.bookings[stage], { combo, stage }] as const),
  ),
);

/** The flows' arrival settings: the setup seed's flow_defaults row, else window (its DEFAULT_ARRIVE, MC C5). */
async function arriveOf(sql: Sql): Promise<Map<string, string>> {
  const rows = await sql<{ business_id: string; flow: string; arrive: string }[]>`
    select business_id, flow, arrive from flow_defaults
  `;
  return new Map(rows.map((row) => [`${row.business_id} ${row.flow}`, row.arrive]));
}

/**
 * How many rows of `table` are the set's: every row of a state table (the sets before it write none), and of the two
 * tables other sets write too, the ids the set makes (res-journey-..., price-journey-...).
 */
async function setRowsIn(sql: Sql, table: string): Promise<number> {
  const prefix = table === "resources" ? "res-journey-" : table === "price_rules" ? "price-journey-" : null;
  if (prefix === null) {
    return countOf(sql, table);
  }
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from ${sql(table)} where starts_with(id, ${prefix})
  `;
  return row?.n ?? -1;
}

/** Every row of the set's tables (and the other sets' rows in the two they share), by primary key, as stored. */
async function snapshot(sql: Sql): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    const key = table === "booking_details" || table === "booking_terms" ? "booking_id" : "id";
    out[table] = [...(await sql`select * from ${sql(table)} order by ${sql(key)}`)];
  }
  return out;
}

async function countOf(sql: Sql, table: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
  return row?.n ?? -1;
}

const linesOf = (text: string): string[] => text.split("\n").filter((line) => line !== "");

describe("journey-states, through the seed runner, on a schema holding every set it builds on", () => {
  let db: TestDatabase;
  let first: Run;
  let firstRows: Record<string, unknown[]>;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_journey_states" });
    await seedPriorSets(db.sql);
    first = await runSeed(["--set", SET], { DATABASE_URL: LOCAL_URL, DB_SCHEMA: db.schema });
    firstRows = await snapshot(db.sql);
  }, SETUP_MS);

  afterAll(async () => {
    await db.drop();
  });

  it("SCENARIOS.md lists money combos for both flows, each once, and the set plans one state per combo and stage", () => {
    // Every one of each flow's 28 money paths (K-25 service_money_path_known), once: one test per money combo.
    for (const flow of ["A", "B"] as const) {
      const listed = EXPECTED.filter((combo) => combo.flow === flow).map((combo) => combo.path);
      expect(listed.length, flow).toBe(PATHS_OF_FLOW[flow].length);
      expect([...listed].sort(), flow).toEqual([...PATHS_OF_FLOW[flow]].sort());
    }
    expect(new Set(EXPECTED.map((combo) => `${combo.flow} ${combo.path}`)).size).toBe(EXPECTED.length);
    const plan = journeyStatesPlanOf(verifyFixtureSet(openFixtureSet()));
    expect(plan.scenarios.map((scenario) => `${scenario.flow} ${scenario.path} ${scenario.shopId}`)).toEqual(
      EXPECTED.map((combo) => `${combo.flow} ${combo.path} ${combo.shopId}`),
    );
    expect(plan.states.map((state) => state.bookingId)).toEqual(
      EXPECTED.flatMap((combo) => JOURNEY_STAGES.map((stage) => combo.bookings[stage])),
    );
  });

  it("refuses a SCENARIOS.md line it cannot read, a path no flow has, and a combo listed twice", () => {
    expect(() => scenariosOf("### A · list|card|counter on aba (Session)\n")).toThrow(/line 1/);
    expect(() => scenariosOf("### A · `list|card|own` on aba (Session)\n")).toThrow(/flow A's 28/);
    const twice = "### B · `list|card|bill` on aba (Session)\n\n### B · `list|card|bill` on baker (Cake)\n";
    expect(() => scenariosOf(twice)).toThrow(/line 3: flow B's path list\|card\|bill is listed twice/);
    expect(() => scenariosOf("# Nothing here\n")).toThrow(/lists no money combo/);
  });

  it(
    "`node db/seeds/run.mjs --set journey-states` exits 0 and prints each table's rows, all inserted",
    SLOW,
    async () => {
      expect(first.stderr).toBe("");
      expect(first.code).toBe(0);
      const out = linesOf(first.stdout);
      expect(out[0]).toBe(`seed: set ${SET} into schema ${db.schema} on the local database`);
      for (const table of TABLES) {
        const n = await setRowsIn(db.sql, table);
        expect(n, table).toBeGreaterThan(0);
        expect(out, table).toContain(
          `seed: ${table}: ${String(n)} ${n === 1 ? "row" : "rows"} (${String(n)} inserted, 0 kept)`,
        );
      }
      expect(out.at(-1)).toMatch(/^seed: done: set journey-states into schema \S+: \d+ rows in 18 tables /);
    },
  );

  it(
    "loads one state per money combo SCENARIOS.md lists, for flow A and flow B: four bookings each, one per stage",
    SLOW,
    async () => {
      const bookings = await db.sql<
        {
          id: string;
          business_id: string;
          flow: string;
          stage: string;
          booker_person_id: string;
          served_person_id: string;
          payer_person_id: string;
        }[]
      >`select id, business_id, flow, stage, booker_person_id, served_person_id, payer_person_id from bookings`;
      expect(bookings.map((row) => row.id).sort()).toEqual([...BY_BOOKING.keys()].sort());
      for (const flow of ["A", "B"] as const) {
        const combos = EXPECTED.filter((combo) => combo.flow === flow).length;
        expect(bookings.filter((row) => row.flow === flow).length, flow).toBe(combos * JOURNEY_STAGES.length);
      }
      for (const row of bookings) {
        const found = BY_BOOKING.get(row.id);
        if (found === undefined) {
          throw new Error(`${row.id} is no state of the set`);
        }
        const { combo, stage } = found;
        // request and who_for: the head, with the customer as booker, person served and payer.
        expect(row, row.id).toEqual({
          id: row.id,
          business_id: combo.business,
          flow: combo.flow,
          stage: stage === "booked" ? "booked" : "entry",
          booker_person_id: combo.customerPerson,
          served_person_id: combo.customerPerson,
          payer_person_id: combo.customerPerson,
        });
      }
      // reach_by and customer: the customers seed's record of that customer at the business, who texts.
      const customers = await db.sql<{ id: string; business_id: string; person_id: string; way: string }[]>`
      select id, business_id, person_id, way from customers
      where id = any(${[...new Set(EXPECTED.map((combo) => combo.customerId))]}::text[])
    `;
      for (const combo of EXPECTED) {
        expect(customers.find((row) => row.id === combo.customerId)).toEqual({
          id: combo.customerId,
          business_id: combo.business,
          person_id: combo.customerPerson,
          way: "texts",
        });
      }
    },
  );

  it("each stage's details hold the booking values decided by then, and nothing later", SLOW, async () => {
    const arrive = await arriveOf(db.sql);
    const details = await db.sql<
      {
        booking_id: string;
        business_id: string;
        number: string;
        door: string;
        made_by: string;
        approval: string | null;
        timing: string | null;
        times: string | null;
        taken: string | null;
        staff_told_at: Date | null;
        first_link_given_at: Date | null;
        request_ended_at: Date | null;
      }[]
    >`
      select booking_id, business_id, number, door, made_by, approval, timing, times, taken, staff_told_at,
             first_link_given_at, request_ended_at
      from booking_details
    `;
    expect(details.length).toBe(BY_BOOKING.size);
    const numbers = new Set<string>();
    for (const row of details) {
      const found = BY_BOOKING.get(row.booking_id);
      if (found === undefined) {
        throw new Error(`${row.booking_id} is no state of the set`);
      }
      const { combo, stage } = found;
      const saved = stage !== "request";
      const paid = stage === "money_before" || stage === "booked";
      numbers.add(`${row.business_id} ${row.number}`);
      expect(row, row.booking_id).toEqual({
        booking_id: row.booking_id,
        business_id: combo.business,
        number: row.number,
        door: "chat",
        made_by: "customer",
        approval: saved ? "now" : null,
        timing: saved ? "settime" : null,
        times: saved ? (arrive.get(`${combo.business} ${combo.flow}`) ?? "window") : null,
        taken: paid ? "asked" : null,
        staff_told_at: null,
        first_link_given_at: null,
        request_ended_at: null,
      });
    }
    expect(numbers.size).toBe(details.length);
  });

  it(
    "from time_saved on, the line copies the combo's service, way and price; before it, there is none",
    SLOW,
    async () => {
      const lines = await db.sql<
        {
          booking_id: string;
          service_id: string;
          service_money_id: string;
          price_rule_id: string | null;
          quote_option_id: string | null;
          path: string;
          price_cents: string;
          from_cents: string | null;
          deposit_cents: string | null;
          fee_cents: string | null;
          way_fee: string | null;
          way_deposit: string | null;
          rule_price: string | null;
          option_price: string | null;
          currency: string;
          state: string;
        }[]
      >`
      select l.booking_id, l.service_id, l.service_money_id, l.price_rule_id, l.quote_option_id, l.path,
             l.price_cents::text, l.from_cents::text, l.deposit_cents::text, l.fee_cents::text,
             w.fee_cents::text as way_fee, w.deposit_cents::text as way_deposit, r.price_cents::text as rule_price,
             o.price_cents::text as option_price, l.currency, l.state
      from booking_lines l
      join service_money w on w.id = l.service_money_id
      left join price_rules r on r.id = l.price_rule_id
      left join quote_options o on o.id = l.quote_option_id
    `;
      const byBooking = new Map(lines.map((row) => [row.booking_id, row]));
      expect(lines.length).toBe(byBooking.size);
      for (const combo of EXPECTED) {
        expect(byBooking.has(combo.bookings.request), combo.bookings.request).toBe(false);
        for (const stage of ["time_saved", "money_before", "booked"] as const) {
          const line = byBooking.get(combo.bookings[stage]);
          const id = combo.bookings[stage];
          expect(line, id).toBeDefined();
          if (line === undefined) {
            continue;
          }
          expect(line.service_id, id).toBe(`svc-demo-${combo.key}`);
          expect(line.service_money_id, id).toBe(`way-demo-${combo.key}`);
          expect(line.path, id).toBe(combo.path);
          expect([line.currency, line.state], id).toEqual(["USD", "open"]);
          expect(line.fee_cents, id).toBe(line.way_fee);
          expect(line.deposit_cents, id).toBe(combo.deposit === null ? null : String(combo.deposit));
          expect(line.deposit_cents, id).toBe(line.way_deposit);
          if (combo.priceBy === "list") {
            expect(line.price_rule_id, id).toBe(`price-demo-${combo.key}`);
            expect([line.price_cents, line.rule_price], id).toEqual([
              String(combo.price),
              String(combo.price),
            ]);
            expect(line.quote_option_id, id).toBeNull();
          } else if (combo.priceBy === "photos") {
            expect(line.price_rule_id, id).toBeNull();
            expect([line.price_cents, line.option_price], id).toEqual([
              String(combo.price),
              String(combo.price),
            ]);
          } else {
            // Default 7: nothing promised before the visit, as a price rule of the set's own; a deposit is its 'from'.
            expect(line.price_rule_id, id).toBe(`price-journey-${combo.key}`);
            expect([line.price_cents, line.rule_price], id).toEqual(["0", "0"]);
            expect(line.from_cents, id).toBe(combo.deposit === null ? null : String(combo.deposit));
          }
        }
      }
    },
  );

  it(
    "from time_saved on, the saved time is the pro's time in the shop's open hours, held, then booked",
    SLOW,
    async () => {
      const reservations = await db.sql<
        {
          id: string;
          booking_id: string;
          business_id: string;
          resource_business: string;
          resource_kind: string;
          resource_person: string;
          worker_person_id: string;
          state: string;
          seats: number;
          held_minutes: number | null;
          for_phone_number: string | null;
          for_agent_token: string | null;
          queued_at: Date;
          starts_after_set_made: boolean;
          in_open_hours: boolean;
        }[]
      >`
      select r.id, r.booking_id, r.business_id, s.business_id as resource_business, s.kind as resource_kind,
             s.person_id as resource_person, r.worker_person_id, r.state, r.seats,
             (extract(epoch from r.held_until - r.queued_at) / 60)::int as held_minutes,
             r.for_phone_number, r.for_agent_token, r.queued_at,
             lower(r.during) > r.queued_at as starts_after_set_made,
             exists (
               select 1 from weekly_hours h
               where h.business_id = r.business_id
                 and h.weekday = extract(isodow from lower(r.during) at time zone ${ZONE})
                 and (lower(r.during) at time zone ${ZONE})::time >= h.opens_at
                 and (upper(r.during) at time zone ${ZONE})::date = (lower(r.during) at time zone ${ZONE})::date
                 and (upper(r.during) at time zone ${ZONE})::time <= h.closes_at
             ) as in_open_hours
      from reservations r join resources s on s.id = r.resource_id
    `;
      const byBooking = new Map(reservations.map((row) => [row.booking_id, row]));
      expect(reservations.length).toBe(byBooking.size);
      for (const combo of EXPECTED) {
        expect(byBooking.has(combo.bookings.request), combo.bookings.request).toBe(false);
        for (const stage of ["time_saved", "money_before", "booked"] as const) {
          const id = combo.bookings[stage];
          const row = byBooking.get(id);
          expect(row, id).toBeDefined();
          if (row === undefined) {
            continue;
          }
          const booked = stage === "booked";
          expect(
            {
              business: row.business_id,
              resourceBusiness: row.resource_business,
              kind: row.resource_kind,
              pro: row.resource_person,
              worker: row.worker_person_id,
              state: row.state,
              seats: row.seats,
              heldMinutes: row.held_minutes,
              phone: row.for_phone_number,
              token: row.for_agent_token,
              future: row.starts_after_set_made,
              inHours: row.in_open_hours,
            },
            id,
          ).toEqual({
            business: combo.business,
            resourceBusiness: combo.business,
            kind: "worker",
            pro: combo.pro,
            worker: combo.pro,
            state: booked ? "booked" : "held",
            seats: 1,
            heldMinutes: booked ? null : STANDARD_HOLD_MINUTES,
            phone: null,
            token: null,
            future: true,
            inHours: true,
          });
        }
      }
      expect(SAVED_TIME_MINUTES).toBe(STANDARD_HOLD_MINUTES);
    },
  );

  it(
    "from time_saved on, the secure link went to the customer's mobile; flow B's address is the town and a sealed stand-in",
    SLOW,
    async () => {
      const links = await db.sql<
        {
          booking_id: string;
          purpose: string;
          person_id: string;
          handle_id: string | null;
          given_via: string;
          code_sha256: string;
          ended_at: Date | null;
        }[]
      >`select booking_id, purpose, person_id, handle_id, given_via, code_sha256, ended_at from secure_links`;
      const addresses = await db.sql<
        {
          booking_id: string;
          position: number;
          area: string;
          address: Uint8Array | null;
          sealed_for_person_id: string | null;
          zone: string | null;
          location_id: string;
          checked_at: Date | null;
        }[]
      >`
      select booking_id, position, area, address, sealed_for_person_id, zone, location_id, checked_at
      from booking_addresses
    `;
      expect(new Set(links.map((row) => row.code_sha256)).size).toBe(links.length);
      for (const combo of EXPECTED) {
        for (const stage of JOURNEY_STAGES) {
          const id = combo.bookings[stage];
          const saved = stage !== "request";
          const link = links.filter((row) => row.booking_id === id);
          const address = addresses.filter((row) => row.booking_id === id);
          expect(link.length, id).toBe(saved ? 1 : 0);
          expect(address.length, id).toBe(saved && combo.flow === "B" ? 1 : 0);
          if (link[0] !== undefined) {
            expect({ ...link[0], code_sha256: /^[0-9a-f]{64}$/.test(link[0].code_sha256) }, id).toEqual({
              booking_id: id,
              purpose: "secure_page",
              person_id: combo.customerPerson,
              handle_id: combo.customerHandle,
              given_via: "text",
              code_sha256: true,
              ended_at: null,
            });
          }
          const place = address[0];
          if (place !== undefined) {
            expect(
              {
                position: place.position,
                area: place.area,
                address: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
                  place.address ?? new Uint8Array(),
                ),
                sealedFor: place.sealed_for_person_id,
                zone: place.zone,
                location: place.location_id,
                checked: place.checked_at,
              },
              id,
            ).toEqual({
              position: 1,
              area: DEMO_TOWN,
              address: SEALED_ADDRESS_STAND_IN,
              sealedFor: combo.customerPerson,
              zone: ZONE,
              location: `loc-demo-${combo.shopId}`,
              checked: null,
            });
          }
        }
      }
    },
  );

  it(
    "from money_before on, money before is the combo's: nothing, a saved card, or a card and the deposit or full price taken",
    SLOW,
    async () => {
      const cards = await db.sql<
        { booking_id: string; person_id: string; saved: boolean; effect_state: string; effect_kind: string }[]
      >`
      select c.booking_id, c.person_id, c.saved_at is not null and c.stripe_payment_method_id is not null as saved,
             e.state as effect_state, e.kind as effect_kind
      from saved_cards c join effects e on e.id = c.save_effect_id
    `;
      const payments = await db.sql<
        {
          booking_id: string;
          purpose: string;
          method: string;
          amount_cents: string;
          state: string;
          payer_person_id: string;
          card_booking: string | null;
          effect_amount: string | null;
          effect_state: string;
          items: string;
          item_line_booking: string | null;
          ledger: string;
        }[]
      >`
      select p.booking_id, p.purpose, p.method, p.amount_cents::text, p.state, p.payer_person_id,
             c.booking_id as card_booking, e.amount_cents::text as effect_amount, e.state as effect_state,
             (select coalesce(sum(i.amount_cents), 0) from payment_items i where i.payment_id = p.id)::text as items,
             (select min(l.booking_id) from payment_items i join booking_lines l on l.id = i.booking_line_id
               where i.payment_id = p.id) as item_line_booking,
             (select coalesce(sum(g.amount_cents), 0) from ledger_lines g
               where g.payment_id = p.id and g.kind = 'charge')::text as ledger
      from payments p join effects e on e.id = p.effect_id left join saved_cards c on c.id = p.saved_card_id
    `;
      const lines = await db.sql<{ booking_id: string; price_cents: string }[]>`
      select booking_id, price_cents::text from booking_lines
    `;
      const priceOf = new Map(lines.map((row) => [row.booking_id, row.price_cents]));
      for (const combo of EXPECTED) {
        for (const stage of JOURNEY_STAGES) {
          const id = combo.bookings[stage];
          const paid = stage === "money_before" || stage === "booked";
          const card = cards.filter((row) => row.booking_id === id);
          const payment = payments.filter((row) => row.booking_id === id);
          expect(card.length, id).toBe(paid && combo.before !== "none" ? 1 : 0);
          if (card[0] !== undefined) {
            expect(card[0], id).toEqual({
              booking_id: id,
              person_id: combo.customerPerson,
              saved: true,
              effect_state: "succeeded",
              effect_kind: "stripe_save_card",
            });
          }
          const charged = paid && (combo.before === "deposit" || combo.before === "full");
          expect(payment.length, id).toBe(charged ? 1 : 0);
          if (payment[0] !== undefined) {
            const amount =
              combo.before === "deposit" ? String(combo.deposit) : (priceOf.get(id) ?? "no line price");
            expect(payment[0], id).toEqual({
              booking_id: id,
              purpose: combo.before === "deposit" ? "deposit" : "full_price",
              method: "card",
              amount_cents: amount,
              state: "paid",
              payer_person_id: combo.customerPerson,
              card_booking: id,
              effect_amount: amount,
              effect_state: "succeeded",
              items: amount,
              item_line_booking: id,
              ledger: amount,
            });
          }
        }
      }
    },
  );

  it(
    "booked holds the visit on its reservation, its free-cancel time, and the terms snapshot with the rules in force",
    SLOW,
    async () => {
      const visits = await db.sql<
        {
          booking_id: string;
          position: number;
          visit_reservation_booking: string | null;
          window_inside: boolean | null;
          has_window: boolean;
          cutoff_before_start: boolean | null;
          check_in_code: Uint8Array | null;
        }[]
      >`
      select v.booking_id, v.position, r.booking_id as visit_reservation_booking,
             v.arrival_window <@ r.during as window_inside, v.arrival_window is not null as has_window,
             v.cutoff_at < lower(r.during) as cutoff_before_start, v.check_in_code
      from booking_visits v join reservations r on r.id = v.reservation_id
    `;
      const terms = await db.sql<{ booking_id: string; terms_language: string; consent: string | null }[]>`
      select booking_id, terms_language, terms_consent_id as consent from booking_terms
    `;
      const rules = await db.sql<
        { booking_id: string; rule_id: string | null; price_ok_limit_id: string | null }[]
      >`
      select booking_id, rule_id, price_ok_limit_id from booking_terms_rules
    `;
      const details = await db.sql<{ booking_id: string; times: string | null }[]>`
      select booking_id, times from booking_details
    `;
      const timesOf = new Map(details.map((row) => [row.booking_id, row.times]));
      for (const combo of EXPECTED) {
        for (const stage of JOURNEY_STAGES) {
          const id = combo.bookings[stage];
          const visit = visits.filter((row) => row.booking_id === id);
          const snapshot = terms.filter((row) => row.booking_id === id);
          if (stage !== "booked") {
            expect([visit.length, snapshot.length], id).toEqual([0, 0]);
            continue;
          }
          const windowed = timesOf.get(id) === "window";
          expect(visit.length, id).toBe(1);
          expect(
            {
              position: visit[0]?.position,
              reservationOf: visit[0]?.visit_reservation_booking,
              hasWindow: visit[0]?.has_window,
              windowInside: visit[0]?.window_inside,
              cutoffBeforeStart: visit[0]?.cutoff_before_start ?? true,
              code: visit[0]?.check_in_code,
            },
            id,
          ).toEqual({
            position: 1,
            reservationOf: id,
            hasWindow: windowed,
            windowInside: windowed ? true : null,
            cutoffBeforeStart: true,
            code: null,
          });
          expect(snapshot, id).toEqual([{ booking_id: id, terms_language: "en", consent: null }]);
          const named = rules
            .filter((row) => row.booking_id === id)
            .map((row) => row.rule_id ?? row.price_ok_limit_id);
          expect(named, id).toEqual(
            expect.arrayContaining([
              `rule-demo-${combo.shopId}-ok-same-day`,
              `rule-demo-${combo.shopId}-ok-new-customer`,
            ]),
          );
        }
      }
    },
  );

  it("writes no phone number, and no Stripe id with a card number's run of digits", SLOW, async () => {
    expect(await db.sql`select 1 from reservations where for_phone_number is not null`).toEqual([]);
    const ids = await db.sql<{ id: string }[]>`
      select stripe_customer_id as id from saved_cards union all
      select stripe_payment_method_id from saved_cards union all
      select stripe_object_id from ledger_lines union all
      select provider_object_id from effects
    `;
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((row) => /[0-9]{7}/.test(row.id.replace(/[ -]/g, "")))).toEqual([]);
  });

  it(
    "re-running is idempotent: the runner's second run writes nothing and every row stays as it was",
    SLOW,
    async () => {
      const second = await runSeed(["--set", SET], { DATABASE_URL: LOCAL_URL, DB_SCHEMA: db.schema });
      expect(second.stderr).toBe("");
      expect(second.code).toBe(0);
      const out = linesOf(second.stdout);
      for (const table of TABLES) {
        const n = await setRowsIn(db.sql, table);
        expect(out, table).toContain(
          `seed: ${table}: ${String(n)} ${n === 1 ? "row" : "rows"} (0 inserted, ${String(n)} kept)`,
        );
      }
      expect(await snapshot(db.sql)).toEqual(firstRows);
    },
  );

  it(
    "each seeded saved time holds a reservation that reserve() refuses to give anyone else",
    SLOW,
    async () => {
      const held = await db.sql<
        {
          id: string;
          business_id: string;
          resource_id: string;
          booking_id: string;
          state: string;
          start: Date;
          end: Date;
        }[]
      >`
      select id, business_id, resource_id, booking_id, state, lower(during) as start, upper(during) as end
      from reservations where state in ('held', 'booked') order by id
    `;
      // Two saved times per combo (time_saved and money_before), and its booked time.
      expect(held.filter((row) => row.state === "held").length).toBe(EXPECTED.length * 2);
      expect(held.filter((row) => row.state === "booked").length).toBe(EXPECTED.length);
      const phones = await db.sql<{ handle_id: string; number: string }[]>`
      select handle_id, number from phones
      where handle_id = any(${EXPECTED.map((combo) => combo.otherCustomerHandle)}::text[])
    `;
      const phoneOf = new Map(phones.map((row) => [row.handle_id, row.number]));
      const before = await snapshot(db.sql);
      const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      let probe = 0;
      for (const row of held) {
        const combo = BY_BOOKING.get(row.booking_id)?.combo;
        const other = combo === undefined ? undefined : phoneOf.get(combo.otherCustomerHandle);
        expect(other, row.id).toBeDefined();
        const during = { start: row.start.toISOString(), end: row.end.toISOString() };
        for (const waitIfSaved of [false, true]) {
          probe += 1;
          const outcome = await reserve(db.sql, {
            reservationId: `probe-t728-${String(probe)}`,
            businessId: row.business_id,
            resourceId: row.resource_id,
            during,
            seats: 1,
            for: { phoneNumber: other ?? "" },
            door: "standard",
            holdMinutes: null,
            waitIfSaved,
            at,
          });
          if (waitIfSaved && row.state === "held") {
            // A saved time: the most another customer gets is a place in line behind it (A4-18), never the time.
            expect(outcome, row.id).toMatchObject({ result: "waiting" });
          } else {
            // Asked outright, or a booked time, which has no line (reservations.ts bookedOverlap).
            expect(outcome, row.id).toEqual({ error: "overlap", resourceId: row.resource_id });
          }
        }
      }
      // The set's rows are as they were (beside the probes' own places in line), and no probe holds a time.
      const after = await snapshot(db.sql);
      after.reservations = (after.reservations ?? []).filter(
        (row) => !(row as { id: string }).id.startsWith("probe-t728-"),
      );
      expect(after).toEqual(before);
      expect(
        await db.sql`select id from reservations where id like 'probe-t728-%' and state <> 'waiting'`,
      ).toEqual([]);
    },
  );
});

describe("the staging seed run never loads the set", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_journey_states_staging" });
  }, SETUP_MS);
  afterAll(async () => {
    await db.drop();
  });

  /** D-017's sets, the ones `npm run seed:staging` runs when no set is named (infra/scripts/seed-staging.sh). */
  function stagingSets(): string[] {
    const script = readFileSync(SEED_STAGING, "utf8");
    const match = /^D017_SETS=\(([^)]*)\)$/m.exec(script);
    if (match?.[1] === undefined) {
      throw new Error("seed-staging.sh names no D017_SETS");
    }
    return match[1].trim().split(/\s+/);
  }

  it("seed-staging.sh's default sets do not name journey-states", () => {
    const sets = stagingSets();
    expect(sets.length).toBeGreaterThan(0);
    expect(sets).not.toContain(SET);
  });

  it(
    "its sets, run as seed-staging.sh runs them, and `--set staging-signed-up` leave no booking state",
    SLOW,
    async () => {
      // As seed-staging.sh hands each run the staging database's URL under both names; the check tester's set takes a
      // made-up hash (64 hex characters of random bytes, a token's sha256 form) and refuses any schema but public.
      const staging = {
        DATABASE_URL: LOCAL_URL,
        STAGING_DATABASE_URL: LOCAL_URL,
        DB_SCHEMA: db.schema,
        STAGING_CHECK_TESTER_TOKEN_SHA256: randomBytes(32).toString("hex"),
      };
      const runs: { set: string; code: number }[] = [];
      for (const set of [...stagingSets(), "staging-signed-up"]) {
        const run = await runSeed(["--set", set], staging);
        runs.push({ set, code: run.code });
      }
      // The staging sets ran: core seeded the demo shops' businesses.
      expect(runs.find((run) => run.set === "core")?.code).toBe(0);
      expect(await countOf(db.sql, "businesses")).toBeGreaterThan(0);
      for (const table of STATE_TABLES) {
        expect(await countOf(db.sql, table), table).toBe(0);
      }
      expect(await db.sql`select id from resources where id like 'res-journey-%'`).toEqual([]);
      expect(await db.sql`select id from price_rules where id like 'price-journey-%'`).toEqual([]);
    },
  );
});

describe("journey-states refuses before the sets it builds on, writing nothing", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_journey_states_order" });
    await seedCore(db.sql);
  }, SETUP_MS);
  afterAll(async () => {
    await db.drop();
  });

  it(
    "with only the core seed, the runner exits 1 naming the first set to run, and no row is written",
    SLOW,
    async () => {
      const run = await runSeed(["--set", SET], { DATABASE_URL: LOCAL_URL, DB_SCHEMA: db.schema });
      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/^seed: failed/);
      expect(run.stderr).toContain(
        "run db/seeds/core.ts and db/seeds/setup-staff.ts first (nothing was written)",
      );
      for (const table of STATE_TABLES) {
        expect(await countOf(db.sql, table), table).toBe(0);
      }
      expect(await db.sql`select id from resources where id like 'res-journey-%'`).toEqual([]);
    },
  );
});
