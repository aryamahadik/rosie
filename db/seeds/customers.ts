// T-217: the customers seed (C-155; K-28 v1 customers, frozen: contracts/db-schema/customers, its table list, README
// rules 1 to 7 and seed fixtures, built by migration 0027; 02-contracts section 10: the customer seeds come after F15;
// Master Corrections C6; build prompt rule 9). For each of fixture set v1's 245 demo shops, the customers on its list,
// so journey 3 to 6 tests start from seeded customers: one customer for each way K-28 v1 reaches a customer, each with
// a fictional mobile on file. It runs after the core seed (core.ts, T-200) and the setup seed (setup-business.ts, T-213),
// and takes its shops, businesses and dates from the setup seed's plan (setupPlanOf). Per shop, with ids made from the
// shop's id (its file's name) and the customer's place on the list, in the shape K-28's seed fixtures give Tessa and
// Alex M. (seed-customer-business-added.json, seed-customer-mobile-email.json):
//   persons, handles,       person-demo-<shop>-customer-<n>, handle-demo-<shop>-customer-<n> and the mobile's phone row:
//   person_handles, phones  the customer, writing from a fictional mobile of their own; the customer whose way is email
//                           also has an email handle of their own, handle-demo-<shop>-customer-<n>-email
//   person_roles            role-demo-<shop>-customer-<n>: the customer role at the shop's business, written in the same
//                           commit as the customer row (K-28 rule 7; A4-23: added to the list once booked)
//   customers               customer-demo-<shop>-<n>: the business's record of them: the name on file, the mobile on file
//                           (and for the email way the email), the way, the age band, added when fixture set v1 was made
//
//   const result = await seedCustomers(sql);   // result.tables.customers: { rows: 735, inserted: 735, kept: 0 }
//
// What is read, and from where (rule 9):
//   - the demo shops, through lib/fixture-set.ts and the setup seed's plan, which reads and checks every shop file: each
//     shop's id, file and hash, and its business (the core seed's keys).
//   - when fixture set v1 was made (test-kit/COVERAGE.md line 3, Eastern time), which dates every customer row, as the
//     other seeds date theirs, so a second run writes the same rows.
//   Not read: each flow's customer field (flows.<A|B>.customer; test-kit.js line 75: cast.cust), the trade file's sample
//   cast, such as "Alex M. (customer) · other customers", which MC C6 makes an illustration, never a live value: no name,
//   age, address, pet or head count is read out of it, none of it is stored, and whether a flow has one decides nothing
//   (every shop gets the same list). No phone number, email address or name is taken from a fixture.
//
// Defaults where the files give nothing (each named in the constants below and in the card's report):
//   1. The list: one customer for each way K-28 v1 allows (customers_way_known: texts, textsonly and email, spelt as K-01
//      v1's bookingValues.reach), in the reach card's order (A4-82, B4-93), with calls only left out (Q-07; MC C2), so a
//      test of any way starts from a seeded customer. Customer 1 texts, the reach card's default ("Default: texts to the
//      mobile they give"). Each is a person of their own at one business: no person is on two lists (RULES 4.10).
//   2. Mobiles: every customer has one (MC C2: required when the customer or their own AI books), in the fiction range
//      555-0100 to 555-0199 (NANP keeps it for fiction in every area code) in CUSTOMER_AREA_CODES, which neither the
//      owners' mobiles (lib/demo-shops.ts) nor the team's (setup-staff.ts) use, taken in order: shops in code-point order
//      of id, then place on the list. Each phone row keeps K-04's defaults: chat not open, not stopped, and no Linq contact
//      add recorded (Q-03 adds a mobile when it is saved on the real line; a fictional number never is, T-218).
//   3. Names: the business's name on file is DEMO_CUSTOMER_NAME_PREFIX and the place on the list, a label and never a
//      person's name; each person's own name and language stay null ("null until known", K-04 persons), as the core and
//      staff seeds leave theirs, since the name on file is the business's (K-28 default 4).
//   4. The email: only the customer whose way is email has one (MC C2: an email stays optional), the customer's id at
//      DEMO_EMAIL_DOMAIN, kept for examples (RFC 2606) and K-28's own seeds' domain, in lower case (K-04 handles).
//   5. The age band: 18_or_older, the answer to "are you 18 or older?" (A4-80, B4-92) that a customer added once booked
//      gave, as K-28's seeds give their adults; no child is seeded (RULES 4.7).
//   6. The rest: K-28's defaults: no contact times, not first name only, voicemail not refused, not fee-free (S11-57:
//      the owner marks it).
//   Not seeded: blocks (customer_blocks; S11-62: the owner sets one by telling the AI or in the portal, and no file gives
//   one), bookings (the card's Not here), and so no yes to texts (K-29: a consent row is for one booking).
//
// Checked before anything is written: the customers' area codes are none of the owners' or the team's; every mobile is
// in the fiction range; every id, number and address is made once. Inside the transaction: each shop's business
// (core) and its business setup row (setup).
//
// In order, stopping at the first failure: opens and checks fixture set v1 against its manifest as the core seed does
// (lib/fixture-set.ts), so only bytes that were hashed are parsed; plans every row from the setup seed's plan, which
// refuses, naming the file, any shop value it does not know how to read; then, in one transaction as the job role
// rosie_job with no business scope (T-191), checks that the core and setup seeds' rows are there, and writes the rows
// through K-28's customers table and the K-04 people rows its records need. Idempotent, as the other seeds: a row is
// inserted only when its primary key is free (ON CONFLICT DO NOTHING), nothing is updated or deleted, so a second run
// writes nothing and leaves every row as it was, version included; a row that went missing is written again as the first
// run wrote it. A clash on any other key (a number or address another handle holds, a second record of one person at a
// business, a second live customer role) is an error, and the transaction rolls back. Nothing is printed, and no error
// names a value of a row.
import { SCOPE_SETTING, type Sql, type Tx } from "../repo/scope";
import { type CoreSeedTableCount, SEED_ROLE } from "./core";
import { FICTIONAL_AREA_CODES, FICTIONAL_MOBILE } from "./lib/demo-shops";
import {
  type FixtureSet,
  openFixtureSet,
  type VerifiedFixtureSet,
  verifyFixtureSet,
} from "./lib/fixture-set";
import { setupPlanOf } from "./setup-business";
import { STAFF_AREA_CODES } from "./setup-staff";

/**
 * Default 1: each shop's customers, one for each way K-28 v1 allows (customers_way_known), spelt as K-01 v1's
 * bookingValues.reach, in the reach card's order with calls only left out (A4-82, B4-93; Q-07; MC C2).
 */
export const DEMO_CUSTOMER_WAYS = ["texts", "textsonly", "email"] as const;
export type CustomerWay = (typeof DEMO_CUSTOMER_WAYS)[number];
/**
 * Default 2: the area codes of the customers' fictional mobiles, 100 numbers each (555-0100 to 555-0199), none of them
 * the owners' (lib/demo-shops.ts FICTIONAL_AREA_CODES) or the team's (setup-staff.ts STAFF_AREA_CODES). 1,000 in all.
 */
export const CUSTOMER_AREA_CODES = [
  "206",
  "214",
  "303",
  "313",
  "412",
  "512",
  "615",
  "702",
  "801",
  "919",
] as const;
/** The role each customer holds at the business (K-04 person_roles; K-28 rule 7). */
export const CUSTOMER_ROLE = "customer";
/** Default 3: the name on file is this label and the customer's place on the list, never a person's name (rule 9). */
export const DEMO_CUSTOMER_NAME_PREFIX = "Demo customer ";
/** Default 4: the email way's domain: kept for examples (RFC 2606), and the domain of K-28's own seeds. */
export const DEMO_EMAIL_DOMAIN = "example.com";
/** Default 5: the answer on file to "are you 18 or older?" (A4-80, B4-92). */
export const DEMO_AGE_BAND = "18_or_older";

export interface CustomerPersonSeedRow {
  readonly id: string;
}

export interface CustomerHandleSeedRow {
  readonly id: string;
  readonly kind: "phone" | "email";
  readonly address: string;
}

export interface CustomerPersonHandleSeedRow {
  readonly person_id: string;
  readonly handle_id: string;
}

export interface CustomerPhoneSeedRow {
  readonly number: string;
  readonly handle_id: string;
}

export interface CustomerRoleSeedRow {
  readonly id: string;
  readonly person_id: string;
  readonly business_id: string;
  readonly role: typeof CUSTOMER_ROLE;
}

/** A customer row as this seed writes it: always with a mobile on file, and a way K-28 v1 allows. */
export interface CustomerSeedRow {
  readonly id: string;
  readonly business_id: string;
  readonly person_id: string;
  readonly name: string;
  readonly mobile_handle_id: string;
  readonly email_handle_id: string | null;
  readonly way: CustomerWay;
  readonly contact_times: null;
  readonly first_name_only: false;
  readonly no_voicemail: false;
  readonly age_band: typeof DEMO_AGE_BAND;
  readonly fee_free: false;
  readonly added_at: Date;
}

/** The rows of every shop, table by table, in the order they are written. */
export interface CustomerSeedRows {
  readonly persons: readonly CustomerPersonSeedRow[];
  readonly handles: readonly CustomerHandleSeedRow[];
  readonly person_handles: readonly CustomerPersonHandleSeedRow[];
  readonly phones: readonly CustomerPhoneSeedRow[];
  readonly person_roles: readonly CustomerRoleSeedRow[];
  readonly customers: readonly CustomerSeedRow[];
}

export type CustomerSeedTable = keyof CustomerSeedRows;

/** One customer, as seeded: every key written for them. */
export interface SeededCustomer {
  /** Their place on the shop's list, from 1. */
  readonly position: number;
  readonly way: CustomerWay;
  readonly customerId: string;
  readonly personId: string;
  readonly roleId: string;
  /** The mobile on file: its handle and number. */
  readonly handleId: string;
  readonly phoneNumber: string;
  /** The email on file, for the email way only. */
  readonly email: { readonly handleId: string; readonly address: string } | null;
}

/** One entry per shop: its fixture file, its business, and every customer the seed wrote for it. */
export interface SeededCustomerShop {
  readonly shopId: string;
  readonly source: string;
  readonly sha256: string;
  readonly businessId: string;
  readonly customers: readonly SeededCustomer[];
}

export interface CustomerSeedPlan {
  readonly rows: CustomerSeedRows;
  /** One entry per shop, in code-point order of id. */
  readonly shops: readonly SeededCustomerShop[];
  /** When the customer rows are dated (when fixture set v1 was made), and the file that says so. */
  readonly seededAt: { readonly at: Date; readonly source: string };
}

export interface CustomerSeedResult {
  /** The database role that wrote the rows (current_user inside the seed's transaction). */
  readonly ranAs: string;
  /** The fixture set that was checked: its folder, its manifest's sha256 and how many files the manifest lists. */
  readonly fixtureSet: {
    readonly dir: string;
    readonly manifestSha256: string;
    readonly filesChecked: number;
  };
  readonly seededAt: { readonly at: Date; readonly source: string };
  readonly tables: Readonly<Record<CustomerSeedTable, CoreSeedTableCount>>;
  readonly shops: readonly SeededCustomerShop[];
}

export interface CustomerSeedOptions {
  /** Fixture set v1's folder. Default fixtures/v1. Anything outside the repository's fixtures/ folder is refused. */
  fixturesDir?: string;
}

/** The fictional mobile of the customer at `index` (0-based, in the seed's order). 1,000 numbers in all. */
export function customerMobile(index: number): string {
  const areaCode =
    Number.isSafeInteger(index) && index >= 0 ? CUSTOMER_AREA_CODES[Math.floor(index / 100)] : undefined;
  if (areaCode === undefined) {
    throw new RangeError(
      `no fictional mobile for customer ${String(index)}: ${String(CUSTOMER_AREA_CODES.length * 100)} numbers in all`,
    );
  }
  return `+1${areaCode}55501${String(index % 100).padStart(2, "0")}`;
}

/** Refuses a plan that would write one key twice in a table, which ON CONFLICT DO NOTHING would otherwise drop. */
function requireUnique(what: string, keys: readonly string[]): void {
  if (new Set(keys).size !== keys.length) {
    throw new Error(`the customers seed would write two ${what} with one key; stopping`);
  }
}

/**
 * Plans every row of the customers seed from a verified fixture set (pure: no database). Shops are taken in the setup
 * seed's order (code-point order of id), with the keys its plan makes, so each customer names the business the core
 * seed wrote.
 */
export function customersPlanOf(verified: VerifiedFixtureSet): CustomerSeedPlan {
  const taken: readonly string[] = [...FICTIONAL_AREA_CODES, ...STAFF_AREA_CODES];
  if (CUSTOMER_AREA_CODES.some((code) => taken.includes(code))) {
    throw new Error(
      "the customers' area codes must differ from the owners' and the team's (lib/demo-shops.ts, setup-staff.ts)",
    );
  }
  const setup = setupPlanOf(verified);
  const at = setup.seededAt.at;

  const rows = {
    persons: [] as CustomerPersonSeedRow[],
    handles: [] as CustomerHandleSeedRow[],
    person_handles: [] as CustomerPersonHandleSeedRow[],
    phones: [] as CustomerPhoneSeedRow[],
    person_roles: [] as CustomerRoleSeedRow[],
    customers: [] as CustomerSeedRow[],
  };
  const shops: SeededCustomerShop[] = [];
  let mobiles = 0;

  for (const shop of setup.seeded) {
    const customers: SeededCustomer[] = [];
    for (const [offset, way] of DEMO_CUSTOMER_WAYS.entries()) {
      const position = offset + 1;
      const key = `${shop.shopId}-customer-${String(position)}`;
      const customerId = `customer-demo-${shop.shopId}-${String(position)}`;
      const customer: SeededCustomer = {
        position,
        way,
        customerId,
        personId: `person-demo-${key}`,
        roleId: `role-demo-${key}`,
        handleId: `handle-demo-${key}`,
        phoneNumber: customerMobile(mobiles),
        email:
          way === "email"
            ? {
                handleId: `handle-demo-${key}-email`,
                address: `${customerId}@${DEMO_EMAIL_DOMAIN}`.toLowerCase(),
              }
            : null,
      };
      mobiles += 1;
      rows.persons.push({ id: customer.personId });
      rows.handles.push({ id: customer.handleId, kind: "phone", address: customer.phoneNumber });
      rows.person_handles.push({ person_id: customer.personId, handle_id: customer.handleId });
      if (customer.email !== null) {
        rows.handles.push({ id: customer.email.handleId, kind: "email", address: customer.email.address });
        rows.person_handles.push({ person_id: customer.personId, handle_id: customer.email.handleId });
      }
      rows.phones.push({ number: customer.phoneNumber, handle_id: customer.handleId });
      rows.person_roles.push({
        id: customer.roleId,
        person_id: customer.personId,
        business_id: shop.businessId,
        role: CUSTOMER_ROLE,
      });
      rows.customers.push({
        id: customerId,
        business_id: shop.businessId,
        person_id: customer.personId,
        name: `${DEMO_CUSTOMER_NAME_PREFIX}${String(position)}`,
        mobile_handle_id: customer.handleId,
        email_handle_id: customer.email?.handleId ?? null,
        way,
        contact_times: null,
        first_name_only: false,
        no_voicemail: false,
        age_band: DEMO_AGE_BAND,
        fee_free: false,
        added_at: at,
      });
      customers.push(customer);
    }
    shops.push({
      shopId: shop.shopId,
      source: shop.source,
      sha256: shop.sha256,
      businessId: shop.businessId,
      customers,
    });
  }

  const notFictional = rows.phones.filter((phone) => !FICTIONAL_MOBILE.test(phone.number));
  if (notFictional.length > 0) {
    throw new Error(
      `refusing to write ${String(notFictional.length)} mobile(s) outside the fiction range 555-0100 to 555-0199`,
    );
  }
  requireUnique(
    "persons",
    rows.persons.map((row) => row.id),
  );
  requireUnique(
    "handles",
    rows.handles.map((row) => row.id),
  );
  requireUnique(
    "handle addresses",
    rows.handles.map((row) => row.address),
  );
  requireUnique(
    "phones",
    rows.phones.map((row) => row.number),
  );
  requireUnique(
    "person_roles",
    rows.person_roles.map((row) => row.id),
  );
  requireUnique(
    "customers",
    rows.customers.map((row) => row.id),
  );
  return { rows, shops, seededAt: setup.seededAt };
}

/** Seeds the demo shops' customers from fixture set v1 (see the top of this file). */
export async function seedCustomers(
  sql: Sql,
  options: CustomerSeedOptions = {},
): Promise<CustomerSeedResult> {
  return seedCustomersFrom(sql, openFixtureSet(options.fixturesDir));
}

/** The entry every seed set exports under one name, so a runner finds a set by its file name (T-201). */
export const seed = seedCustomers;

const missingMessage = (what: string, missing: number, of: number, run: string): string =>
  `${what} are missing for ${String(missing)} of ${String(of)} shops: run ${run} first (nothing was written)`;

/** Refuses to write before the seeds this one builds on: each shop's business (core) and business setup row (setup). */
async function requirePriorRows(tx: Tx, plan: CustomerSeedPlan): Promise<void> {
  const businessIds = plan.shops.map((shop) => shop.businessId);
  const businesses = await tx<{ id: string }[]>`
    select id from businesses where id = any(${businessIds}::text[])
  `;
  const haveBusiness = new Set(businesses.map((row) => row.id));
  const noCore = businessIds.filter((id) => !haveBusiness.has(id));
  if (noCore.length > 0) {
    throw new Error(
      missingMessage("the core seed's business rows", noCore.length, businessIds.length, "db/seeds/core.ts"),
    );
  }
  const setups = await tx<{ business_id: string }[]>`
    select business_id from business_setup where business_id = any(${businessIds}::text[])
  `;
  const haveSetup = new Set(setups.map((row) => row.business_id));
  const noSetup = businessIds.filter((id) => !haveSetup.has(id));
  if (noSetup.length > 0) {
    throw new Error(
      missingMessage(
        "the setup seed's business setup rows",
        noSetup.length,
        businessIds.length,
        "db/seeds/setup-business.ts",
      ),
    );
  }
}

/**
 * Writes customer rows inside the caller's transaction, each only when its primary key is free, in the order their
 * foreign keys need: the K-04 people rows first, then each customer's role and record, so both land in the caller's one
 * commit (K-28 rule 7). Returns how many rows of each table this call wrote. Kept apart from the plan so a later seed
 * that brings its own rows (T-218, a customer for each test phone) writes them the same way.
 */
export async function insertCustomerRows(
  tx: Tx,
  rows: CustomerSeedRows,
): Promise<Record<CustomerSeedTable, number>> {
  const none = { count: 0 };
  const persons =
    rows.persons.length === 0
      ? none
      : await tx`insert into persons ${tx(rows.persons, "id")} on conflict (id) do nothing`;
  const handles =
    rows.handles.length === 0
      ? none
      : await tx`
          insert into handles ${tx(rows.handles, "id", "kind", "address")}
          on conflict (id) do nothing
        `;
  const personHandles =
    rows.person_handles.length === 0
      ? none
      : await tx`
          insert into person_handles ${tx(rows.person_handles, "person_id", "handle_id")}
          on conflict (person_id, handle_id) do nothing
        `;
  const phones =
    rows.phones.length === 0
      ? none
      : await tx`
          insert into phones ${tx(rows.phones, "number", "handle_id")}
          on conflict (number) do nothing
        `;
  const personRoles =
    rows.person_roles.length === 0
      ? none
      : await tx`
          insert into person_roles ${tx(rows.person_roles, "id", "person_id", "business_id", "role")}
          on conflict (id) do nothing
        `;
  const customers =
    rows.customers.length === 0
      ? none
      : await tx`
          insert into customers ${tx(
            rows.customers,
            "id",
            "business_id",
            "person_id",
            "name",
            "mobile_handle_id",
            "email_handle_id",
            "way",
            "contact_times",
            "first_name_only",
            "no_voicemail",
            "age_band",
            "fee_free",
            "added_at",
          )}
          on conflict (id) do nothing
        `;
  return {
    persons: persons.count,
    handles: handles.count,
    person_handles: personHandles.count,
    phones: phones.count,
    person_roles: personRoles.count,
    customers: customers.count,
  };
}

/** seedCustomers, from a fixture set already opened (tests open a temporary copy of the set inside its own jail). */
export async function seedCustomersFrom(sql: Sql, set: FixtureSet): Promise<CustomerSeedResult> {
  const verified = verifyFixtureSet(set);
  const plan = customersPlanOf(verified);
  const { rows } = plan;

  const written = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${SEED_ROLE}`);
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    const [who] = await tx<{ role: string }[]>`select current_user as role`;
    await requirePriorRows(tx, plan);
    return { ranAs: who?.role ?? "", inserted: await insertCustomerRows(tx, rows) };
  });

  const count = (table: CustomerSeedTable): CoreSeedTableCount => {
    const total = rows[table].length;
    const inserted = written.inserted[table];
    return { rows: total, inserted, kept: total - inserted };
  };
  return {
    ranAs: written.ranAs,
    fixtureSet: {
      dir: verified.dir,
      manifestSha256: verified.manifestSha256,
      filesChecked: verified.filesChecked,
    },
    seededAt: plan.seededAt,
    tables: {
      persons: count("persons"),
      handles: count("handles"),
      person_handles: count("person_handles"),
      phones: count("phones"),
      person_roles: count("person_roles"),
      customers: count("customers"),
    },
    shops: plan.shops,
  };
}
