// T-214: the services and rules seed (C-155; K-25 v1 services and prices and K-26 v1 rules, both frozen:
// contracts/db-schema/services-prices and contracts/db-schema/rules, their table lists, READMEs and seed fixtures, built
// by migrations 0022 and 0023; DL-235; Master Corrections R3; build prompt rule 9 and section 3.5). From fixture set v1's
// 245 demo shops, each shop's money examples as services with their ways and list prices, and the owner rules and price
// OK limit S1-21's tap list keeps, so search (it reads price rules, build prompt 3.5) and journeys 3 to 6 can price,
// filter and book against seeded businesses. It runs after the core seed (core.ts, T-200), the setup seed
// (setup-business.ts, T-213) and the kinds seed (kinds.ts, T-212): its rows hang off their businesses, owners, locations
// and picked kinds, and take their ids from the same plan (setupPlanOf). Per shop, with ids made from the shop's id (its
// file's name), the flow and the money path:
//   services         svc-demo-<shop>-<flow>-<path>: one per money example in the shop file (flows.<A|B>.services), in
//                    the file's order, flow A first, numbered from 1; named as the example names it; filed under the
//                    kind of work the kinds seed picked for the shop (picked_kinds); one price; DEMO_SERVICE_LENGTH long
//   service_money    way-demo-<shop>-<flow>-<path>: the example's one way: flow A at the shop (place business), flow B at
//                    the customer's place served from the shop's travel area, both at loc-demo-<shop>; its money path;
//                    the deposit on a deposit path; the late-cancel and no-show fee on a path that takes money before
//   price_rules      price-demo-<shop>-<flow>-<path>: a list path's price, the service's own (no condition), set by the
//                    shop's owner, in effect from when fixture set v1 was made, with no end
//   rules            rule-demo-<shop>-ok-same-day and -ok-new-customer: S1-21's row "Same-day and new customers · Ask you
//                    first", for the whole business; rule-demo-<shop>-tip-line: its row "Bills Rosie sends: a tip line",
//                    where the shop's facts list tips (the kind's needs_fact) and some way sends Rosie's bill
//   price_ok_limits  pok-demo-<shop>-quotes: its row "Price OKs": every quote (priced from photos or at the visit) comes
//                    to the owner first (over $0), in the flows with a quoted way; list prices never need one
//
//   const result = await seedSetupServicesRules(sql);   // result.tables.services: { rows: n, inserted: n, kept: 0 }
//
// What is read, and from where (rule 9; MC R3: code reads a trade's pf.facts, pf.switches and pf.settings by name, and
// every other pf.* value is free text for the AI, never parsed):
//   - from each test-kit/shops/<id>.json, through lib/fixture-set.ts and the setup seed's own reader: its flows, and in
//     each flow's money examples their path (combo), name, price, deposit and fee, each read by name. A price, deposit
//     or fee is dollars ("$35") and becomes whole cents; "free" is a list price of 0, or no fee. The example's words (its
//     price-kind label, before and after words and story) and its worked-out lines (rest, paid_now, due_now_at_booking)
//     are not stored: the path holds them, and code works the rest out (K-25 README).
//   - the shop's facts and switches as the setup seed reads them by name (tips for the tip line; sensitive for a fee),
//     and whether money goes through Rosie (K-23 no_money).
//   - when fixture set v1 was made (test-kit/COVERAGE.md line 3, Eastern time), which dates every price and rule, as the
//     setup and kinds seeds date their rows, so a second run writes the same times.
//   No phone number, email address or person's name is taken from a fixture: a service name that looks like a phone
//   number or an email address is refused.
//
// Defaults where the files give nothing (each named in the constants below and in the card's report):
//   1. Price kind one_price: each money example gives one price for the service as it names it ("Stay in a standard run
//      (2 nights)", $96); per hour, per unit and by the customer's answers appear only in pf.services' words (MC R3).
//   2. Length DEMO_SERVICE_LENGTH: no field code may read gives one (FS row V04 makes it required; the owner sets it at
//      S1-12).
//   3. Place: flow A at the business (every demo location is a shop, T-213), flow B at the customer's place (K-25
//      service_money_flow_matches_place).
//   4. Currency DEMO_CURRENCY: the shop files write every amount in dollars, and the demo shops are in America/New_York.
//   5. A path that takes nothing before holds no fee (K-25 service_money_fee_needs_money_before; FS section 4: "no fee
//      possible"), so the file's fee on it is recorded as not held (feeNotHeld); a fee the file calls free, or $0, is no
//      fee of the way's own (K-25 holds a fee above $0, else null), as auto-body.json's and doula.json's are. Likewise a
//      deposit is held only on a deposit path (service_money_deposit_with_deposit_path): the test kit's amounts give some
//      other paths one too (camp.json's week paid in full), recorded as not held (depositNotHeld).
//   6. A path priced from photos or at the visit gets no price rule: a photo quote is made for each booking (K-25 README,
//      Prices; K-30) and a visit's price is set at the visit (S13-45). The example's price is that one booking's (the
//      leak repair's $245 is $89 before and $156 after), and code cannot tell a promised visit price from it without the
//      story's words, so it is recorded as not held (priceNotHeld).
//   7. Extras null: the kind's pf.services and pf.questions are stored whole in K-24's picked_kind_texts (T-212); no code
//      picks one entry out of them (MC R3; K-25 README, Services).
//   8. TEST_MIXED_KINDS for test-mixed-A and -B, which have no profession and so no kind (T-213, T-212).
//   9. The rules and price OK limit: S1-21's safe default, "every suggestion kept as shown", for the rows every tap list
//      shows (OWNER_RULE_KINDS, QUOTE_OK_OVER_CENTS). A row S1-21 shows only where the plug-in suggests it (own customers
//      only, deposit and fee caps) is in pf.rules' and pf.money's words, and an amount S1-21 asks of the owner (bank
//      transfer over an amount) is in no file: none is made. The rest stay unset, which K-26 reads as their default.
//   No item_services: the setup seed lists no places or things (QUESTIONS.md CQ-126 (a)). No price_rule_ties: each
//   service has one price rule.
//
// Checked before anything is written (K-25 README rule 9 and K-26's "Which part owns what" are kept by code, so the
// seed keeps them for its own rows): every path is one of its flow's 28, and one flow holds each path once (one way per
// service and place); a deposit path has its deposit, never above a list price; a card or full path has its fee unless
// the file says free or $0, except sensitive work (FS row V08; RULES 3.5); a business with no money through Rosie takes
// nothing before and sends no bill or card charge; and, inside the
// transaction, each of the 243 profession shops' paths is one its kind's plug-in offers in that flow (K-24
// kind_flows.combos), each service's kind is the shop's pick, each flow B location has a travel area (K-23), and each
// owner rule's kind is in K-26's registry (migration 0023 seeds it; this seed never writes it, DL-235) with its one
// value type and the fact it needs. test-mixed-A and -B cover exactly the paths no profession uses, so theirs are not
// held to their default kind's paths, and they have no company kind (recorded per shop: kindFrom).
//
// In order, stopping at the first failure: opens and checks fixture set v1 against its manifest as the core seed does
// (lib/fixture-set.ts), so only bytes that were hashed are parsed; reads every shop and refuses, naming the file and
// the example, any value it does not know how to read rather than guess; then, in one transaction as the job role
// rosie_job with no business scope (T-191), checks that the core, setup and kinds seeds' rows are there, and writes the
// rows. Idempotent, as the other seeds: a row is inserted only when its primary key is free (ON CONFLICT DO NOTHING),
// nothing is updated or deleted, so a second run writes nothing and leaves every row as it was, version included; a row
// that went missing is written again as the first run wrote it. A clash on any other key or constraint (a second price
// or rule in effect for the same service or scope) is an error, and the transaction rolls back. Nothing is printed, and
// no error names a value of a row.
import { SCOPE_SETTING, type Sql, type Tx } from "../repo/scope";
import { type CoreSeedTableCount, SEED_ROLE } from "./core";
import { SHOPS_DIR } from "./lib/demo-shops";
import {
  filesUnder,
  type FixtureSet,
  openFixtureSet,
  type VerifiedFile,
  type VerifiedFixtureSet,
  verifyFixtureSet,
} from "./lib/fixture-set";
import { type Flow, setupPlanOf } from "./setup-business";

/** Default 2: every demo service's length (V04), until the owner sets it at S1-12. */
export const DEMO_SERVICE_LENGTH = "1 hour";
/** Default 1: every money example is one price for the service as it names it. */
export const DEMO_PRICE_KIND = "one_price";
/** Default 4: the shop files write every amount in dollars. */
export const DEMO_CURRENCY = "USD";
/** Default 3: where a flow's ways happen (K-25 service_money_flow_matches_place; every demo location is a shop). */
export const PLACE_OF_FLOW: Readonly<Record<Flow, "business" | "customer">> = {
  A: "business",
  B: "customer",
};
/**
 * Default 8: the kind of work test-mixed-A's and -B's services are filed under. Neither has a profession (no owner form),
 * so the setup and kinds seeds give it no kind, while K-25's services.kind_id is required. test-kit.js (its line 135)
 * builds each one's services from the master's own money amounts for its flow (master-A.json and master-B.json
 * money.amounts), whose business is the master's sample cast: flow A's Lee's Barbershop, "Riley and Avery (barbers)", and
 * flow B's Lee Home Services, "Jordan and Casey (plumbers)" (each file's cast.staff). K-25 v1's own seeds file those
 * businesses' services under barber and plumber (seed-services-price-list.json, seed-price-withdrawn-before-start.json).
 */
export const TEST_MIXED_KINDS: Readonly<Record<string, string>> = {
  "test-mixed-A": "barber",
  "test-mixed-B": "plumber",
};
/**
 * Default 9: the rows every S1-21 tap list shows, kept as shown ("Safe default: every suggestion kept as shown"; MASTER
 * FLOW A, S1-21: "Rows cover hours, cancel and any fee, same-day and new customers, and price OKs", then "bills Rosie
 * sends: a tip line ... only where bills are sent"), as K-26 v1's seed-rules-tap-list keeps them for Lee's Barbershop.
 * Hours, the cancel time and the fee, and the travel area are other parts' (K-27, K-23, K-25).
 */
export const OWNER_RULE_KINDS = {
  sameDay: "ok_same_day",
  newCustomer: "ok_new_customer",
  tipLine: "tip_line",
} as const;
/** The fact a tip line needs (K-26 rule_kinds.needs_fact of tip_line, migration 0023). */
export const TIPS_FACT = "tips";
/**
 * Default 9: S1-21's "Price OKs: quotes and bills over an amount come to the owner first. List prices never need an OK."
 * No file gives a demo owner's amount, so every quote it covers comes to the owner first: over $0, quotes only, as K-26
 * v1's seed keeps the barbershop's "Color quotes come to you first" (K-26 README default 6).
 */
export const QUOTE_OK_OVER_CENTS = 0;

/** The master's 28 money paths per flow (K-25 service_money_path_known; master-A.json and master-B.json money.combos). */
export const PATHS_OF_FLOW: Readonly<Record<Flow, readonly string[]>> = {
  A: [
    "list|none|none",
    "list|none|counter",
    "list|none|bill",
    "list|card|counter",
    "list|card|bill",
    "list|card|card",
    "list|deposit|counter",
    "list|deposit|bill",
    "list|deposit|card",
    "list|full|none",
    "photos|none|none",
    "photos|none|counter",
    "photos|none|bill",
    "photos|card|counter",
    "photos|card|bill",
    "photos|card|card",
    "photos|deposit|counter",
    "photos|deposit|bill",
    "photos|deposit|card",
    "photos|full|none",
    "visit|none|counter",
    "visit|none|bill",
    "visit|card|counter",
    "visit|card|bill",
    "visit|card|card",
    "visit|deposit|counter",
    "visit|deposit|bill",
    "visit|deposit|card",
  ],
  B: [
    "list|none|none",
    "list|none|bill",
    "list|none|own",
    "list|card|bill",
    "list|card|card",
    "list|card|own",
    "list|deposit|bill",
    "list|deposit|card",
    "list|deposit|own",
    "list|full|none",
    "photos|none|none",
    "photos|none|bill",
    "photos|none|own",
    "photos|card|bill",
    "photos|card|card",
    "photos|card|own",
    "photos|deposit|bill",
    "photos|deposit|card",
    "photos|deposit|own",
    "photos|full|none",
    "visit|none|bill",
    "visit|none|own",
    "visit|card|bill",
    "visit|card|card",
    "visit|card|own",
    "visit|deposit|bill",
    "visit|deposit|card",
    "visit|deposit|own",
  ],
};

// "$35", "$1,200" or "$35.50": dollars, with cents when given.
const DOLLARS = /^\$([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.([0-9]{2}))?$/;
// A list price the file calls free is a list price of 0 (FS row V02).
const FREE = "free";
// An email address, or seven or more digits (a phone number), as lib/demo-shops.ts refuses in a name.
const LOOKS_LIKE_CONTACT = /@|[0-9](?:[\s().-]*[0-9]){6}/;

export interface ServiceSeedRow {
  readonly id: string;
  readonly business_id: string;
  readonly kind_id: string;
  readonly name: string;
  readonly price_kind: typeof DEMO_PRICE_KIND;
  readonly unit: null;
  readonly length: typeof DEMO_SERVICE_LENGTH;
  readonly position: number;
  readonly active: true;
  readonly extras: null;
}

export interface ServiceMoneySeedRow {
  readonly id: string;
  readonly service_id: string;
  readonly business_id: string;
  readonly flow: Flow;
  readonly place: "business" | "customer";
  readonly location_id: string;
  readonly path: string;
  readonly deposit_cents: number | null;
  readonly deposit_percent: null;
  readonly fee_cents: number | null;
  readonly currency: typeof DEMO_CURRENCY | null;
  readonly cutoff_before: null;
  readonly cutoff_day_before_at: null;
  readonly tip_line: null;
  readonly active: true;
}

export interface PriceRuleSeedRow {
  readonly id: string;
  readonly business_id: string;
  readonly service_id: string;
  readonly service_money_id: null;
  readonly worker_resource_id: null;
  readonly weekdays: null;
  readonly from_time: null;
  readonly until_time: null;
  readonly price_cents: number;
  readonly from_cents: null;
  readonly currency: typeof DEMO_CURRENCY;
  readonly set_by_person_id: string;
  readonly effective_from: Date;
  readonly effective_to: null;
}

export interface RuleSeedRow {
  readonly id: string;
  readonly business_id: string;
  readonly rule_kind: (typeof OWNER_RULE_KINDS)[keyof typeof OWNER_RULE_KINDS];
  readonly value_type: "on";
  readonly flow: Flow | null;
  readonly kind_id: null;
  readonly value_on: true;
  readonly words: null;
  readonly set_by_person_id: string;
  readonly effective_from: Date;
  readonly effective_to: null;
}

export interface PriceOkLimitSeedRow {
  readonly id: string;
  readonly business_id: string;
  readonly flow: Flow | null;
  readonly kind_id: null;
  readonly quotes: true;
  readonly bills: false;
  readonly over_cents: typeof QUOTE_OK_OVER_CENTS;
  readonly currency: typeof DEMO_CURRENCY;
  readonly set_by_person_id: string;
  readonly effective_from: Date;
  readonly effective_to: null;
}

export interface ServicesRulesSeedRows {
  readonly services: readonly ServiceSeedRow[];
  readonly service_money: readonly ServiceMoneySeedRow[];
  readonly price_rules: readonly PriceRuleSeedRow[];
  readonly rules: readonly RuleSeedRow[];
  readonly price_ok_limits: readonly PriceOkLimitSeedRow[];
}

export type ServicesRulesSeedTable = keyof ServicesRulesSeedRows;

/** One money example, as seeded: its keys, where it is in the shop file, and what of it was not held. */
export interface SeededService {
  readonly serviceId: string;
  readonly wayId: string;
  /** Its list price's rule, or null for a path priced from photos or at the visit (default 6). */
  readonly priceRuleId: string | null;
  readonly flow: Flow;
  readonly path: string;
  /** Where the example is in the shop file: flows.<flow>.services[<index>]. */
  readonly at: string;
  /** The example's price as the file words it, held as no rule (a quote or a price set at the visit), else null. */
  readonly priceNotHeld: string | null;
  /** The example's deposit as the file words it, held nowhere on a path that takes no deposit, else null. */
  readonly depositNotHeld: string | null;
  /** The example's fee as the file words it, held nowhere on a path that takes nothing before, else null. */
  readonly feeNotHeld: string | null;
}

/** One entry per shop: its fixture file, its kind and where it came from, and every key the seed wrote. */
export interface SeededServicesShop {
  readonly shopId: string;
  readonly source: string;
  readonly sha256: string;
  readonly businessId: string;
  readonly ownerPersonId: string;
  readonly locationId: string;
  readonly kindId: string;
  /** "pick": the kind the kinds seed picked for the shop; "default": TEST_MIXED_KINDS (no profession, no company kind). */
  readonly kindFrom: "pick" | "default";
  /** The shop's facts, as the setup seed reads them (none for a shop with no profession). */
  readonly facts: readonly string[];
  readonly services: readonly SeededService[];
  readonly ruleIds: readonly string[];
  readonly priceOkLimitId: string | null;
}

export interface ServicesRulesSeedPlan {
  readonly rows: ServicesRulesSeedRows;
  /** One entry per shop, in code-point order of id. */
  readonly shops: readonly SeededServicesShop[];
  /** When the prices and rules take effect (when fixture set v1 was made), and the file that says so. */
  readonly seededAt: { readonly at: Date; readonly source: string };
}

export interface ServicesRulesSeedResult {
  /** The database role that wrote the rows (current_user inside the seed's transaction). */
  readonly ranAs: string;
  /** The fixture set that was checked: its folder, its manifest's sha256 and how many files the manifest lists. */
  readonly fixtureSet: {
    readonly dir: string;
    readonly manifestSha256: string;
    readonly filesChecked: number;
  };
  readonly seededAt: { readonly at: Date; readonly source: string };
  readonly tables: Readonly<Record<ServicesRulesSeedTable, CoreSeedTableCount>>;
  readonly shops: readonly SeededServicesShop[];
}

export interface ServicesRulesSeedOptions {
  /** Fixture set v1's folder. Default fixtures/v1. Anything outside the repository's fixtures/ folder is refused. */
  fixturesDir?: string;
}

/** A money example as read: its path's parts and the values the seed stores. */
interface MoneyExample {
  readonly index: number;
  readonly path: string;
  readonly price: "list" | "photos" | "visit";
  readonly before: string;
  readonly after: string;
  readonly name: string;
  /** A list path's price in cents; null on a path priced from photos or at the visit. */
  readonly priceCents: number | null;
  readonly priceNotHeld: string | null;
  readonly depositCents: number | null;
  readonly depositNotHeld: string | null;
  readonly feeCents: number | null;
  readonly feeNotHeld: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseShopFile(file: VerifiedFile): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(file.bytes));
  } catch (error) {
    throw new Error(`${file.path}: not JSON in UTF-8`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error(`${file.path}: not a JSON object`);
  }
  return parsed;
}

/** Dollars as the shop files write them ("$35", "$1,200", "$35.50"), in whole cents. */
export function centsOf(words: string): number | null {
  const match = DOLLARS.exec(words);
  const dollars = match?.[1];
  if (dollars === undefined) {
    return null;
  }
  const cents = Number(dollars.replaceAll(",", "")) * 100 + Number(match?.[2] ?? "0");
  return Number.isSafeInteger(cents) ? cents : null;
}

/** A string field's words, or null when the field is null; anything else is refused. */
function wordsOf(source: string, where: string, field: string, value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${source}: ${where}'s ${field} is neither text nor null`);
  }
  return value;
}

/** An amount field in cents: dollars, and above 0 unless `free` allows the file's "free" as 0. */
function amountOf(source: string, where: string, field: string, words: string, free: boolean): number {
  if (free && words === FREE) {
    return 0;
  }
  const cents = centsOf(words);
  if (cents === null) {
    throw new Error(`${source}: ${where}'s ${field} is not an amount in dollars ("$35")`);
  }
  if (cents === 0 && !free) {
    throw new Error(`${source}: ${where}'s ${field} is $0, which K-25 holds as no ${field}`);
  }
  return cents;
}

/**
 * Reads one money example of a shop file (flows.<flow>.services[<index>]) by name. `noMoney`: the business takes no
 * money through Rosie (K-23); `sensitive`: the switch sensitive is on in the flow (a card or full path may then have no
 * fee, S1-21 "For sensitive work, the suggested fee is $0").
 */
export function readMoneyExample(
  source: string,
  flow: Flow,
  index: number,
  value: unknown,
  facts: { readonly noMoney: boolean; readonly sensitive: boolean },
): MoneyExample {
  const where = `flows.${flow}.services[${String(index)}]`;
  if (!isRecord(value)) {
    throw new Error(`${source}: ${where} is not an object`);
  }
  const path = value.combo;
  if (typeof path !== "string" || !PATHS_OF_FLOW[flow].includes(path)) {
    throw new Error(`${source}: ${where}'s combo is not one of flow ${flow}'s 28 money paths`);
  }
  const [price, before, after] = path.split("|");
  if (
    (price !== "list" && price !== "photos" && price !== "visit") ||
    before === undefined ||
    after === undefined
  ) {
    throw new Error(`${source}: ${where}'s combo is not price|before|after`);
  }
  const name = value.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(`${source}: ${where} has no name`);
  }
  if (LOOKS_LIKE_CONTACT.test(name)) {
    throw new Error(
      `${source}: ${where}'s name looks like a phone number or an email address; stopping (rule 9)`,
    );
  }
  if (facts.noMoney && (before !== "none" || after === "bill" || after === "card")) {
    throw new Error(
      `${source}: ${where}'s path takes money through Rosie, but the business takes none (K-23 no_money)`,
    );
  }

  const priceWords = wordsOf(source, where, "price", value.price);
  let priceCents: number | null = null;
  let priceNotHeld: string | null = null;
  if (price === "list") {
    if (priceWords === null) {
      throw new Error(`${source}: ${where} is priced from the list but gives no price`);
    }
    priceCents = amountOf(source, where, "price", priceWords, true);
  } else {
    priceNotHeld = priceWords;
  }

  // A deposit is held only on a deposit path (K-25 service_money_deposit_with_deposit_path); the test kit's amounts give
  // some other paths one too (camp.json's week paid in full), which is recorded as not held.
  const depositWords = wordsOf(source, where, "deposit", value.deposit);
  let depositCents: number | null = null;
  let depositNotHeld: string | null = null;
  if (before === "deposit") {
    if (depositWords === null) {
      throw new Error(`${source}: ${where}'s path takes a deposit, but it gives none`);
    }
    depositCents = amountOf(source, where, "deposit", depositWords, false);
    if (priceCents !== null && depositCents > priceCents) {
      throw new Error(
        `${source}: ${where}'s deposit is more than its list price (K-25: never more than the price)`,
      );
    }
  } else {
    depositNotHeld = depositWords;
  }

  // A fee the file calls free, or $0, is no fee of the way's own (K-25 holds a fee above $0, else null), on any path.
  const feeWords = wordsOf(source, where, "fee", value.fee);
  const feeGiven = feeWords === null ? null : amountOf(source, where, "fee", feeWords, true);
  let feeCents: number | null = null;
  let feeNotHeld: string | null = null;
  if (feeGiven === 0) {
    feeCents = null;
  } else if (before === "none") {
    feeNotHeld = feeWords;
  } else if (feeGiven !== null) {
    feeCents = feeGiven;
  } else if ((before === "card" || before === "full") && !facts.sensitive) {
    throw new Error(
      `${source}: ${where}'s path takes money before, but it gives no fee (FS row V08; RULES 3.5)`,
    );
  }

  return {
    index,
    path,
    price,
    before,
    after,
    name,
    priceCents,
    priceNotHeld,
    depositCents,
    depositNotHeld,
    feeCents,
    feeNotHeld,
  };
}

/** The scope of a rule that applies in these flows: both flows is the whole business (null), else the one flow. */
function scopeOf(flows: ReadonlySet<Flow>): Flow | null {
  if (flows.size === 1) {
    return [...flows][0] ?? null;
  }
  return null;
}

const idPart = (flow: Flow, path: string): string => `${flow.toLowerCase()}-${path.replaceAll("|", "-")}`;

/**
 * Plans every row of the services and rules seed from a verified fixture set (pure: no database). Shops are taken in
 * the setup seed's order (code-point order of id), with the keys its plan makes, so each row names the business, owner,
 * location and kind the core, setup and kinds seeds wrote.
 */
export function servicesRulesPlanOf(verified: VerifiedFixtureSet): ServicesRulesSeedPlan {
  const setup = setupPlanOf(verified);
  const fileOf = new Map(filesUnder(verified, SHOPS_DIR).map((file) => [file.path, file]));
  const kindOf = new Map(setup.rows.company_kinds.map((row) => [row.business_id, row]));
  const noMoneyOf = new Map(setup.rows.business_setup.map((row) => [row.business_id, row.no_money]));
  const at = setup.seededAt.at;

  const rows = {
    services: [] as ServiceSeedRow[],
    service_money: [] as ServiceMoneySeedRow[],
    price_rules: [] as PriceRuleSeedRow[],
    rules: [] as RuleSeedRow[],
    price_ok_limits: [] as PriceOkLimitSeedRow[],
  };
  const shops: SeededServicesShop[] = [];

  for (const shop of setup.seeded) {
    const file = fileOf.get(shop.source);
    if (file === undefined) {
      throw new Error(`${shop.source}: not among the verified files`);
    }
    const kindId = shop.kindId ?? TEST_MIXED_KINDS[shop.shopId];
    if (kindId === undefined) {
      throw new Error(`${shop.source}: it has no kind of work, and no default names one`);
    }
    const companyKind = kindOf.get(shop.businessId);
    const facts = companyKind?.pf_facts ?? [];
    const switchesOn: Record<Flow, readonly string[]> = {
      A: companyKind?.pf_switches_a ?? [],
      B: companyKind?.pf_switches_b ?? [],
    };
    const noMoney = noMoneyOf.get(shop.businessId) ?? false;
    const owner = shop.ownerPersonId;
    const parsed = parseShopFile(file);
    const flowBlocks = parsed.flows;
    if (!isRecord(flowBlocks)) {
      throw new Error(`${shop.source}: its flows are not an object`);
    }

    const services: SeededService[] = [];
    const billFlows = new Set<Flow>();
    const quotedFlows = new Set<Flow>();
    let position = 0;
    for (const flow of shop.flows) {
      const block = flowBlocks[flow];
      const examples = isRecord(block) ? block.services : undefined;
      if (!Array.isArray(examples)) {
        throw new Error(`${shop.source}: flows.${flow} has no list of services`);
      }
      const paths = new Set<string>();
      examples.forEach((value: unknown, index) => {
        const example = readMoneyExample(shop.source, flow, index, value, {
          noMoney,
          sensitive: switchesOn[flow].includes("sensitive"),
        });
        if (paths.has(example.path)) {
          throw new Error(
            `${shop.source}: flows.${flow}.services[${String(index)}] repeats a money path of flow ${flow}, and K-25 holds one way per service and place`,
          );
        }
        paths.add(example.path);
        position += 1;
        const key = `${shop.shopId}-${idPart(flow, example.path)}`;
        const serviceId = `svc-demo-${key}`;
        const wayId = `way-demo-${key}`;
        const priceRuleId = example.priceCents === null ? null : `price-demo-${key}`;
        rows.services.push({
          id: serviceId,
          business_id: shop.businessId,
          kind_id: kindId,
          name: example.name,
          price_kind: DEMO_PRICE_KIND,
          unit: null,
          length: DEMO_SERVICE_LENGTH,
          position,
          active: true,
          extras: null,
        });
        const holdsMoney = example.depositCents !== null || example.feeCents !== null;
        rows.service_money.push({
          id: wayId,
          service_id: serviceId,
          business_id: shop.businessId,
          flow,
          place: PLACE_OF_FLOW[flow],
          location_id: shop.locationId,
          path: example.path,
          deposit_cents: example.depositCents,
          deposit_percent: null,
          fee_cents: example.feeCents,
          currency: holdsMoney ? DEMO_CURRENCY : null,
          cutoff_before: null,
          cutoff_day_before_at: null,
          tip_line: null,
          active: true,
        });
        if (priceRuleId !== null && example.priceCents !== null) {
          rows.price_rules.push({
            id: priceRuleId,
            business_id: shop.businessId,
            service_id: serviceId,
            service_money_id: null,
            worker_resource_id: null,
            weekdays: null,
            from_time: null,
            until_time: null,
            price_cents: example.priceCents,
            from_cents: null,
            currency: DEMO_CURRENCY,
            set_by_person_id: owner,
            effective_from: at,
            effective_to: null,
          });
        }
        if (example.after === "bill") {
          billFlows.add(flow);
        }
        if (example.price !== "list") {
          quotedFlows.add(flow);
        }
        services.push({
          serviceId,
          wayId,
          priceRuleId,
          flow,
          path: example.path,
          at: `flows.${flow}.services[${String(index)}]`,
          priceNotHeld: example.priceNotHeld,
          depositNotHeld: example.depositNotHeld,
          feeNotHeld: example.feeNotHeld,
        });
      });
    }

    const rule = (kind: RuleSeedRow["rule_kind"], suffix: string, flow: Flow | null): RuleSeedRow => ({
      id: `rule-demo-${shop.shopId}-${suffix}`,
      business_id: shop.businessId,
      rule_kind: kind,
      value_type: "on",
      flow,
      kind_id: null,
      value_on: true,
      words: null,
      set_by_person_id: owner,
      effective_from: at,
      effective_to: null,
    });
    const shopRules = [
      rule(OWNER_RULE_KINDS.sameDay, "ok-same-day", null),
      rule(OWNER_RULE_KINDS.newCustomer, "ok-new-customer", null),
    ];
    if (facts.includes(TIPS_FACT) && billFlows.size > 0) {
      shopRules.push(rule(OWNER_RULE_KINDS.tipLine, "tip-line", scopeOf(billFlows)));
    }
    rows.rules.push(...shopRules);
    let priceOkLimitId: string | null = null;
    if (quotedFlows.size > 0) {
      priceOkLimitId = `pok-demo-${shop.shopId}-quotes`;
      rows.price_ok_limits.push({
        id: priceOkLimitId,
        business_id: shop.businessId,
        flow: scopeOf(quotedFlows),
        kind_id: null,
        quotes: true,
        bills: false,
        over_cents: QUOTE_OK_OVER_CENTS,
        currency: DEMO_CURRENCY,
        set_by_person_id: owner,
        effective_from: at,
        effective_to: null,
      });
    }

    shops.push({
      shopId: shop.shopId,
      source: shop.source,
      sha256: shop.sha256,
      businessId: shop.businessId,
      ownerPersonId: owner,
      locationId: shop.locationId,
      kindId,
      kindFrom: shop.kindId === null ? "default" : "pick",
      facts,
      services,
      ruleIds: shopRules.map((row) => row.id),
      priceOkLimitId,
    });
  }
  return { rows, shops, seededAt: setup.seededAt };
}

/** Seeds the demo shops' services, ways, prices and owner rules from fixture set v1 (see the top of this file). */
export async function seedSetupServicesRules(
  sql: Sql,
  options: ServicesRulesSeedOptions = {},
): Promise<ServicesRulesSeedResult> {
  return seedSetupServicesRulesFrom(sql, openFixtureSet(options.fixturesDir));
}

/** The entry every seed set exports under one name, so a runner finds a set by its file name (T-201). */
export const seed = seedSetupServicesRules;

const missingMessage = (what: string, missing: number, of: number, unit: string, run: string): string =>
  `${what} are missing for ${String(missing)} of ${String(of)} ${unit}: run ${run} first (nothing was written)`;

/**
 * Refuses to write before the seeds this one builds on, and checks the rules K-25 and K-26 leave to code against their
 * rows: each business and owner (core), each location with a travel area for flow B (setup), each profession shop's
 * pick and every kind's paths (kinds), and each owner rule's kind in K-26's registry.
 */
async function requirePriorRows(tx: Tx, plan: ServicesRulesSeedPlan): Promise<void> {
  const { shops } = plan;
  const businesses = await tx<{ id: string }[]>`
    select id from businesses where id = any(${shops.map((shop) => shop.businessId)}::text[])
  `;
  const persons = await tx<{ id: string }[]>`
    select id from persons where id = any(${shops.map((shop) => shop.ownerPersonId)}::text[])
  `;
  const haveBusiness = new Set(businesses.map((row) => row.id));
  const havePerson = new Set(persons.map((row) => row.id));
  const noCore = shops.filter(
    (shop) => !haveBusiness.has(shop.businessId) || !havePerson.has(shop.ownerPersonId),
  );
  if (noCore.length > 0) {
    throw new Error(
      missingMessage("the core seed's rows", noCore.length, shops.length, "shops", "db/seeds/core.ts"),
    );
  }

  const locations = await tx<{ id: string; business_id: string; travel_miles: number | null }[]>`
    select id, business_id, travel_miles from locations
    where id = any(${shops.map((shop) => shop.locationId)}::text[])
  `;
  const locationOf = new Map(locations.map((row) => [row.id, row]));
  const noSetup = shops.filter((shop) => {
    const location = locationOf.get(shop.locationId);
    const servesFlowB = shop.services.some((service) => service.flow === "B");
    return location?.business_id !== shop.businessId || (servesFlowB && location.travel_miles === null);
  });
  if (noSetup.length > 0) {
    throw new Error(
      missingMessage(
        "the setup seed's locations (a travel area for flow B)",
        noSetup.length,
        shops.length,
        "shops",
        "db/seeds/setup-business.ts",
      ),
    );
  }

  const picked = shops.filter((shop) => shop.kindFrom === "pick");
  const picks = await tx<{ business_id: string; kind_id: string }[]>`
    select business_id, kind_id from picked_kinds where business_id = any(${picked.map((shop) => shop.businessId)}::text[])
  `;
  const havePick = new Set(picks.map((row) => `${row.business_id} ${row.kind_id}`));
  const noPick = picked.filter((shop) => !havePick.has(`${shop.businessId} ${shop.kindId}`));
  if (noPick.length > 0) {
    throw new Error(
      missingMessage(
        "the kinds seed's picks",
        noPick.length,
        picked.length,
        "demo shops",
        "db/seeds/kinds.ts",
      ),
    );
  }
  const kindIds = [...new Set(shops.map((shop) => shop.kindId))];
  const kindFlows = await tx<{ kind_id: string; flow: string; combos: string[] }[]>`
    select kind_id, flow, combos from kind_flows where kind_id = any(${kindIds}::text[])
  `;
  const combosOf = new Map(kindFlows.map((row) => [`${row.kind_id} ${row.flow}`, new Set(row.combos)]));
  const noKind = kindIds.filter((kindId) => !combosOf.has(`${kindId} A`) || !combosOf.has(`${kindId} B`));
  if (noKind.length > 0) {
    throw new Error(
      missingMessage(
        "the kinds seed's kinds",
        noKind.length,
        kindIds.length,
        "kinds of work",
        "db/seeds/kinds.ts",
      ),
    );
  }
  for (const shop of picked) {
    for (const service of shop.services) {
      if (combosOf.get(`${shop.kindId} ${service.flow}`)?.has(service.path) !== true) {
        throw new Error(
          `${shop.source}: ${service.at}'s money path is not one its kind of work offers in flow ${service.flow} (K-24 kind_flows.combos); nothing was written`,
        );
      }
    }
  }

  const ruleKinds = [...new Set(plan.rows.rules.map((row) => row.rule_kind))];
  const registry = await tx<{ id: string; value_type: string; needs_fact: string | null }[]>`
    select id, value_type, needs_fact from rule_kinds where id = any(${ruleKinds}::text[])
  `;
  const registryOf = new Map(registry.map((row) => [row.id, row]));
  const factsOf = new Map(shops.map((shop) => [shop.businessId, shop.facts]));
  for (const row of plan.rows.rules) {
    const kind = registryOf.get(row.rule_kind);
    if (kind?.value_type !== row.value_type) {
      throw new Error(
        `K-26's rule kinds registry (migration 0023) has no kind ${row.rule_kind} of type ${row.value_type}; nothing was written`,
      );
    }
    if (kind.needs_fact !== null && !(factsOf.get(row.business_id) ?? []).includes(kind.needs_fact)) {
      throw new Error(
        `${row.id}: its kind needs the fact ${kind.needs_fact}, which the shop's kind does not list; nothing was written`,
      );
    }
  }
}

/** seedSetupServicesRules, from a fixture set already opened (tests open a temporary copy of the set inside its own jail). */
export async function seedSetupServicesRulesFrom(
  sql: Sql,
  set: FixtureSet,
): Promise<ServicesRulesSeedResult> {
  const verified = verifyFixtureSet(set);
  const plan = servicesRulesPlanOf(verified);
  const { rows } = plan;

  const written = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${SEED_ROLE}`);
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    const [who] = await tx<{ role: string }[]>`select current_user as role`;
    await requirePriorRows(tx, plan);

    const services =
      rows.services.length === 0
        ? { count: 0 }
        : await tx`
            insert into services ${tx(
              rows.services,
              "id",
              "business_id",
              "kind_id",
              "name",
              "price_kind",
              "unit",
              "length",
              "position",
              "active",
              "extras",
            )}
            on conflict (id) do nothing
          `;
    const serviceMoney =
      rows.service_money.length === 0
        ? { count: 0 }
        : await tx`
            insert into service_money ${tx(
              rows.service_money,
              "id",
              "service_id",
              "business_id",
              "flow",
              "place",
              "location_id",
              "path",
              "deposit_cents",
              "deposit_percent",
              "fee_cents",
              "currency",
              "cutoff_before",
              "cutoff_day_before_at",
              "tip_line",
              "active",
            )}
            on conflict (id) do nothing
          `;
    const priceRules =
      rows.price_rules.length === 0
        ? { count: 0 }
        : await tx`
            insert into price_rules ${tx(
              rows.price_rules,
              "id",
              "business_id",
              "service_id",
              "service_money_id",
              "worker_resource_id",
              "weekdays",
              "from_time",
              "until_time",
              "price_cents",
              "from_cents",
              "currency",
              "set_by_person_id",
              "effective_from",
              "effective_to",
            )}
            on conflict (id) do nothing
          `;
    const rules =
      rows.rules.length === 0
        ? { count: 0 }
        : await tx`
            insert into rules ${tx(
              rows.rules,
              "id",
              "business_id",
              "rule_kind",
              "value_type",
              "flow",
              "kind_id",
              "value_on",
              "words",
              "set_by_person_id",
              "effective_from",
              "effective_to",
            )}
            on conflict (id) do nothing
          `;
    const priceOkLimits =
      rows.price_ok_limits.length === 0
        ? { count: 0 }
        : await tx`
            insert into price_ok_limits ${tx(
              rows.price_ok_limits,
              "id",
              "business_id",
              "flow",
              "kind_id",
              "quotes",
              "bills",
              "over_cents",
              "currency",
              "set_by_person_id",
              "effective_from",
              "effective_to",
            )}
            on conflict (id) do nothing
          `;
    return {
      ranAs: who?.role ?? "",
      inserted: {
        services: services.count,
        service_money: serviceMoney.count,
        price_rules: priceRules.count,
        rules: rules.count,
        price_ok_limits: priceOkLimits.count,
      },
    };
  });

  const count = (table: ServicesRulesSeedTable): CoreSeedTableCount => {
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
      services: count("services"),
      service_money: count("service_money"),
      price_rules: count("price_rules"),
      rules: count("rules"),
      price_ok_limits: count("price_ok_limits"),
    },
    shops: plan.shops,
  };
}
