// T-213: the setup seed (C-155; K-23 v1 business setup and K-22 v1 people and access, both frozen; 02-contracts
// section 10, the setup seeds after F14; Master Corrections C5, C10 and R3; build prompt rule 9). From fixture set v1's
// 245 demo shops, the business setup that extends each shop's core rows (core.ts, T-200), so journeys 3 to 6 can be
// built against seeded businesses. Per shop, with ids made from the shop's id, which is its file's name:
//   business_setup  the business fields beside core's businesses row: the listing's website (B05), and no money through
//                   Rosie (M02) for a profession with the fact nomoney and its switch on in every flow
//   companies       company-demo-<shop>: the shop's own name, owned by its owner; one company is one business (B10)
//   company_kinds   the company's one kind of work, the shop's id, with the shop file's facts and the switches on in
//                   each flow, for the 243 shops that have an owner form (forms/<id>.json); test-mixed-A and -B have
//                   none, since no profession file stands behind them
//   flow_defaults   per flow, the free-cancel time (H06) and arrival setting (H07) of the file's settings (pf.settings)
//   locations       loc-demo-<shop>: one shop at the listing's address (B03), with no map point (no geocoding: K-17 and
//                   J-17 are the geo port's); a shop with flow B has a travel area of DEMO_TRAVEL_MILES around it
//   staff           staff-demo-<shop>-owner: the owner works alone ("just me", FS row T01), joined from their own mobile
//                   and bookable
//   id_uploads      idup-demo-<shop>-owner-sign-up: the owner's ID upload at sign-up, which counts as the ID confirmed
//                   (MC C10); its object key is held only in sealed form, under the owner's own key (K-22 rule 6), so
//                   the owner's first seal also makes their row in sealing_keys
//
//   const result = await seedSetupBusiness(sql, { wrappingKeys });  // result.tables.locations: { rows: 245, ... }
//
// What is read, and from where (rule 9; MC R3: code reads a trade's pf.facts, pf.switches and pf.settings by name, and
// every other pf.* value is free text for the AI, never parsed):
//   - from each test-kit/shops/<id>.json: its flows (which of A and B it has), google_prefill's address and website
//     ("[G] <value> (demo)", the demo listing every shop gives), facts, switches and settings. Its listing phone gives
//     no number, so none is stored, and no phone number or email address is ever taken from a fixture.
//   - insurance's facts: MC C5 gives insurance, the one trade with no pf.facts, the list cpa.json has.
//   - the address of test-mixed-A and -B, which have no listing: the one listing address every demo shop gives, as
//     K-23's own seed does where its source gives none (seed-location-travel-centre).
//   - the time each owner's rows are dated: when fixture set v1 was made, line 3 of test-kit/COVERAGE.md, in Eastern
//     time (fixtures/v1/README.md), so a second run writes the same times.
//   Not read: places and things. No field code may read names a shop's spaces, their size or how many Rosie may book
//   (form element K04 is the owner's answer at S1-81), so no places_or_things row is made.
// Defaults where the files give nothing: a flow with no arrival setting starts at "window" (SPEC-prof.md line 127; MC
// C5); a flow with no free-cancel time, or one K-23 v1 cannot hold (a clock time on the day itself, "7am the day of"),
// gets no flow_defaults row, since that table holds exactly one free-cancel time per row (MC C5: the owner sets it at
// sign-up); the travel area is DEMO_TRAVEL_MILES (below).
//
// In order, stopping at the first failure: opens and checks fixture set v1 against its manifest as the core seed does
// (lib/fixture-set.ts), so only bytes that were hashed are parsed; reads every shop and refuses, naming the file, any
// value it does not know how to read rather than guess; then, in one transaction as the job role rosie_job with no
// business scope (T-191), checks that the core seed's rows are there, writes the rows, and seals each missing ID upload.
//
// Idempotent, as the core seed: a row is inserted only when its primary key is free (ON CONFLICT DO NOTHING), nothing is
// updated or deleted, and an owner's object key is sealed only when their upload row is missing, so a second run writes
// nothing and leaves every row as it was. A clash on any other key is an error, and the transaction rolls back.
// Nothing is printed, and no error names a value of a row.
import { seal, type WrappingKeys } from "../repo/sealing";
import { SCOPE_SETTING, type Sql, type Tx } from "../repo/scope";
import { type CoreSeedTableCount, SEED_ROLE } from "./core";
import { coreRowsOf, type DemoShop, readDemoShops, SHOPS_DIR } from "./lib/demo-shops";
import {
  filesUnder,
  type FixtureSet,
  openFixtureSet,
  type VerifiedFile,
  type VerifiedFixtureSet,
  verifyFixtureSet,
} from "./lib/fixture-set";

export type Flow = "A" | "B";
export type Arrive = "setstart" | "window";

/** The flows, in order: A, the customer comes to the business; B, the business goes to the customer. */
export const FLOWS: readonly Flow[] = ["A", "B"];
/** The owner forms. A shop with its form is one profession, and its id is that kind of work's id. */
export const FORMS_DIR = "forms/";
/** The coverage map, whose line 3 says when fixture set v1 was made (fixtures/v1/README.md, Q-36). */
export const COVERAGE_FILE = "test-kit/COVERAGE.md";
/** fixtures/v1/README.md: the scripts stamp line 3 in Eastern time. */
export const FIXTURE_SET_TIME_ZONE = "America/New_York";
/**
 * The travel area of a shop with flow B, in miles (L02). No field code may read gives one (MC R3: pf.services is free
 * text), so every flow B shop takes the travel area the shop texts give as their example, "Travel inside the service
 * area only (the example: 25 miles)" (plumber.json, electrician.json and others), which is also K-23's own seed
 * (seed-location-flow-b) and the master cast's; the owner sets their own at S1-21. Its centre is the shop's own address.
 */
export const DEMO_TRAVEL_MILES = 25;
/** Every demo location is a shop: the test kit calls each business a shop (test-kit/shops/, "Test Mixed Shop B"). */
export const DEMO_LOCATION_KIND = "shop";
/** MC C5: insurance, the one trade with no pf.facts, takes the list cpa.json has. */
export const FACTS_FROM: Readonly<Record<string, string>> = { insurance: "cpa" };
/** SPEC-prof.md line 127 and MC C5: a flow with no arrival setting starts at "window". */
export const DEFAULT_ARRIVE: Arrive = "window";
/** The stand-in object key each demo owner's sealed ID upload names: no ID file exists for a demo owner (rule 9). */
export const DEMO_ID_OBJECT_KEY_PREFIX = "demo/no-file/";
/** The content type the demo ID uploads record (an ID photo, MC C10). */
export const DEMO_ID_CONTENT_TYPE = "image/jpeg";

// The fields test-kit.js writes into every shop's google_prefill (its line 87): any other, a map point among them, is
// refused rather than dropped.
const PREFILL_FIELDS = [
  "address",
  "business name",
  "category",
  "hours",
  "phone",
  "photos",
  "website",
] as const;
// "[G] <value> (demo)": a value prefilled from the demo listing.
const DEMO_PREFILL = /^\[G\] (\S(?:.*\S)?) \(demo\)$/;
// business_setup_website_form (migration 0019).
const WEBSITE = /^https?:\/\/[^\s]+$/;
// A fact's or switch's name (company_kinds_names_form, migration 0019).
const NAME = /^[a-z0-9]+$/;
// A kind of work's id (company_kinds_kind_id_form).
const KIND_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// An email address, or seven or more digits (a phone number), as lib/demo-shops.ts refuses in a name.
const LOOKS_LIKE_CONTACT = /@|[0-9](?:[\s().-]*[0-9]){6}/;
// test-kit/COVERAGE.md line 3: "Generated Sat Nov 07 2026 02:15 from 243 profession files ...".
const GENERATED =
  /^Generated (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-3][0-9]) ([0-9]{4}) ([0-2][0-9]):([0-5][0-9]) from /;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// The free-cancel forms of pf.settings.cutoff (SPEC-prof.md line 128): a span before, or a clock time the day before or
// on the day itself.
const CUTOFF_SPAN = /^([1-9][0-9]{0,3}) (hour|hours|day|days) before$/;
const CUTOFF_CLOCK = /^(1[0-2]|[1-9])(am|pm) the day (before|of)$/;

/** A flow's free-cancel time as the shop file gives it: a span, a clock time the day before, none, or one not held. */
export type Cutoff =
  | { readonly kind: "before"; readonly interval: string }
  | { readonly kind: "dayBeforeAt"; readonly time: string }
  | { readonly kind: "none" }
  | { readonly kind: "notHeld"; readonly words: string };

export interface BusinessSetupSeedRow {
  readonly business_id: string;
  readonly website: string | null;
  readonly no_money: boolean;
}

export interface CompanySeedRow {
  readonly id: string;
  readonly owner_person_id: string;
  readonly name: string;
  readonly business_id: string;
}

export interface CompanyKindSeedRow {
  readonly company_id: string;
  readonly kind_id: string;
  readonly business_id: string;
  readonly trade_name: null;
  readonly pf_facts: readonly string[];
  readonly pf_switches_a: readonly string[];
  readonly pf_switches_b: readonly string[];
}

export interface FlowDefaultSeedRow {
  readonly business_id: string;
  readonly flow: Flow;
  readonly cutoff_before: string | null;
  readonly cutoff_day_before_at: string | null;
  readonly arrive: Arrive;
}

export interface LocationSeedRow {
  readonly id: string;
  readonly business_id: string;
  readonly kind: typeof DEMO_LOCATION_KIND;
  readonly name: null;
  readonly address: string;
  readonly map_point: null;
  readonly travel_miles: number | null;
}

export interface StaffSeedRow {
  readonly id: string;
  readonly business_id: string;
  readonly person_id: string;
  readonly mobile: string;
  readonly agreed_to_text_ticked_at: Date;
  readonly agreed_ticked_by_person_id: string;
  readonly status: "joined";
  readonly added_at: Date;
  readonly joined_at: Date;
  readonly joined_from_number: string;
  readonly bookable_at: Date;
  readonly bookable_by_person_id: string;
}

/** An ID upload as planned: its object key is sealed only inside the transaction, and only when the row is missing. */
export interface IdUploadPlan {
  readonly id: string;
  readonly person_id: string;
  readonly purpose: "sign_up";
  readonly content_type: string;
  readonly uploaded_at: Date;
  readonly objectKey: string;
}

export interface SetupSeedRows {
  readonly business_setup: readonly BusinessSetupSeedRow[];
  readonly companies: readonly CompanySeedRow[];
  readonly company_kinds: readonly CompanyKindSeedRow[];
  readonly flow_defaults: readonly FlowDefaultSeedRow[];
  readonly locations: readonly LocationSeedRow[];
  readonly staff: readonly StaffSeedRow[];
  readonly id_uploads: readonly IdUploadPlan[];
}

export type SetupSeedTable = keyof SetupSeedRows | "sealing_keys";

/** One entry per shop: its fixture file and every key the seed wrote, and where each borrowed value came from. */
export interface SetupSeededShop {
  readonly shopId: string;
  readonly source: string;
  readonly sha256: string;
  readonly businessId: string;
  readonly ownerPersonId: string;
  readonly companyId: string;
  /** The kind of work (the shop's id), or null for a shop with no owner form (test-mixed-A and -B). */
  readonly kindId: string | null;
  readonly locationId: string;
  readonly staffId: string;
  readonly idUploadId: string;
  /** The flows the shop file has. */
  readonly flows: readonly Flow[];
  /** The flows given a free-cancel time and arrival setting (flow_defaults rows). */
  readonly flowDefaults: readonly Flow[];
  /** The flows whose free-cancel time K-23 v1 cannot hold, with the file's words (a clock time on the day itself). */
  readonly cutoffsNotHeld: readonly { readonly flow: Flow; readonly words: string }[];
  /** Each value not read from the shop's own file, by column, and the fixture set v1 file it was read from. */
  readonly valuesFrom: Readonly<Record<string, string>>;
}

export interface SetupSeedPlan {
  readonly rows: SetupSeedRows;
  readonly seeded: readonly SetupSeededShop[];
  /** The time the owners' rows are dated, and the file it came from. */
  readonly seededAt: { readonly at: Date; readonly source: string };
  /** The core seed's keys this seed builds on: each shop's business, and its owner's handle and mobile. */
  readonly core: readonly {
    readonly businessId: string;
    readonly handleId: string;
    readonly phoneNumber: string;
  }[];
}

export interface SetupSeedResult {
  /** The database role that wrote the rows (current_user inside the seed's transaction). */
  readonly ranAs: string;
  /** The fixture set that was checked: its folder, its manifest's sha256 and how many files the manifest lists. */
  readonly fixtureSet: {
    readonly dir: string;
    readonly manifestSha256: string;
    readonly filesChecked: number;
  };
  /** When the owners' staff rows and ID uploads are dated: when fixture set v1 was made, and the file that says so. */
  readonly seededAt: { readonly at: Date; readonly source: string };
  readonly tables: Readonly<Record<SetupSeedTable, CoreSeedTableCount>>;
  /** One entry per shop, in code-point order of id. */
  readonly shops: readonly SetupSeededShop[];
}

export interface SetupSeedOptions {
  /**
   * The wrapping key that seals each owner's ID upload (db/repo/sealing.ts). The caller reads it from the environment
   * by name; this seed never reads a key itself.
   */
  wrappingKeys: WrappingKeys;
  /** Fixture set v1's folder. Default fixtures/v1. Anything outside the repository's fixtures/ folder is refused. */
  fixturesDir?: string;
}

/** What a shop file gives the setup seed, read and checked. */
interface SetupShop {
  readonly shop: DemoShop;
  readonly flows: readonly Flow[];
  readonly listing: { readonly address: string; readonly website: string } | null;
  /** Null for a shop with no owner form. */
  readonly profession: {
    readonly facts: readonly string[];
    readonly switches: Readonly<Record<Flow, readonly string[]>>;
    readonly arrive: Readonly<Record<Flow, Arrive>>;
    readonly cutoff: Readonly<Record<Flow, Cutoff>>;
  } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A list of fact names (company_kinds_names_form). */
const isNameList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item: unknown) => typeof item === "string" && NAME.test(item));

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

/** The flows a shop file has: A, B or both, and nothing else. */
export function flowsOf(source: string, flows: unknown): Flow[] {
  if (!isRecord(flows)) {
    throw new Error(`${source}: its flows are not an object`);
  }
  const named = Object.keys(flows);
  const known = FLOWS.filter((flow) => named.includes(flow));
  if (known.length === 0 || known.length !== named.length) {
    throw new Error(`${source}: its flows must be A, B or both, and nothing else`);
  }
  return known;
}

/** A google_prefill value "[G] <value> (demo)", as the value. */
function demoPrefill(source: string, field: string, value: unknown): string {
  const match = typeof value === "string" ? DEMO_PREFILL.exec(value) : null;
  const found = match?.[1];
  if (found === undefined) {
    throw new Error(
      `${source}: google_prefill's ${field} is not a demo listing value ("[G] <value> (demo)")`,
    );
  }
  if (LOOKS_LIKE_CONTACT.test(found)) {
    throw new Error(
      `${source}: google_prefill's ${field} looks like a phone number or an email address; stopping (rule 9)`,
    );
  }
  return found;
}

/** A shop's demo listing (google_prefill): its address and website, or null when the file has none. */
export function listingOf(
  source: string,
  prefill: unknown,
): { readonly address: string; readonly website: string } | null {
  if (prefill === undefined) {
    return null;
  }
  if (!isRecord(prefill)) {
    throw new Error(`${source}: its google_prefill is not an object`);
  }
  const fields = Object.keys(prefill).sort();
  if (
    fields.length !== PREFILL_FIELDS.length ||
    fields.some((field, index) => field !== PREFILL_FIELDS[index])
  ) {
    throw new Error(
      `${source}: its google_prefill does not hold exactly the fields the seed knows; stopping`,
    );
  }
  const address = demoPrefill(source, "address", prefill.address);
  const website = demoPrefill(source, "website", prefill.website);
  if (!WEBSITE.test(website)) {
    throw new Error(`${source}: google_prefill's website is not an http or https address`);
  }
  return { address, website };
}

/** The switches on in each flow: `true` is on in both, `false` in neither, `{ "A": bool, "B": bool }` per flow. */
export function switchesOf(source: string, switches: unknown): Record<Flow, string[]> {
  if (!isRecord(switches)) {
    throw new Error(`${source}: its switches are not an object`);
  }
  const on: Record<Flow, string[]> = { A: [], B: [] };
  for (const [name, value] of Object.entries(switches)) {
    if (!NAME.test(name)) {
      throw new Error(`${source}: a switch's name is not lower-case letters and digits`);
    }
    const perFlow =
      isRecord(value) &&
      Object.keys(value).every((key) => key === "A" || key === "B") &&
      Object.values(value).every((setting) => typeof setting === "boolean");
    if (typeof value !== "boolean" && !perFlow) {
      throw new Error(`${source}: switch ${name} is not true, false or a value per flow`);
    }
    for (const flow of FLOWS) {
      if (value === true || (isRecord(value) && value[flow] === true)) {
        on[flow].push(name);
      }
    }
  }
  return on;
}

/** A setting's value for one flow: a `{ "A": ..., "B": ... }` object gives each flow its own, any other value both. */
function settingFor(source: string, setting: unknown, flow: Flow): unknown {
  if (isRecord(setting) && ("A" in setting || "B" in setting)) {
    if (!Object.keys(setting).every((key) => key === "A" || key === "B")) {
      throw new Error(`${source}: a setting per flow names something other than A and B`);
    }
    return setting[flow];
  }
  return setting;
}

/** A flow's arrival setting (H07): "setstart", "window", or a window of hours (`{ "window": 2 }`), which is a window. */
export function arriveOf(source: string, flow: Flow, value: unknown): Arrive {
  if (value === undefined) {
    return DEFAULT_ARRIVE;
  }
  if (value === "setstart" || value === "window") {
    return value;
  }
  if (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.window === "number" &&
    Number.isSafeInteger(value.window) &&
    value.window > 0
  ) {
    return "window";
  }
  throw new Error(`${source}: flow ${flow}'s arrival setting is not setstart, window or a window of hours`);
}

/** A flow's free-cancel time (H06), from the forms SPEC-prof.md line 128 names. */
export function cutoffOf(source: string, flow: Flow, value: unknown): Cutoff {
  if (value === undefined || value === null) {
    return { kind: "none" };
  }
  if (typeof value === "string") {
    const span = CUTOFF_SPAN.exec(value);
    if (span?.[1] !== undefined && span[2] !== undefined) {
      return { kind: "before", interval: `${span[1]} ${span[2]}` };
    }
    const clock = CUTOFF_CLOCK.exec(value);
    if (clock?.[1] !== undefined && clock[2] !== undefined) {
      if (clock[3] === "of") {
        return { kind: "notHeld", words: value };
      }
      const hour = (Number(clock[1]) % 12) + (clock[2] === "pm" ? 12 : 0);
      return { kind: "dayBeforeAt", time: `${String(hour).padStart(2, "0")}:00` };
    }
  }
  throw new Error(`${source}: flow ${flow}'s free-cancel time is not a form the seed knows`);
}

// The fixture set's zone's wall clock at an instant, read as if it were UTC (milliseconds).
const FIXTURE_SET_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: FIXTURE_SET_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

function wallClockAt(at: number): number {
  const parts = FIXTURE_SET_CLOCK.formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
}

/** When fixture set v1 was made: line 3 of test-kit/COVERAGE.md, a wall-clock time in Eastern time, as an instant. */
export function seededAtOf(verified: VerifiedFixtureSet): { at: Date; source: string } {
  const file = verified.files.get(COVERAGE_FILE);
  if (file === undefined) {
    throw new Error(`the fixture set at ${verified.dir} has no ${COVERAGE_FILE}`);
  }
  const line =
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(file.bytes).split("\n")[2] ?? "";
  const [, month, day, year, hour, minute] = GENERATED.exec(line) ?? [];
  if (
    month === undefined ||
    day === undefined ||
    year === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    throw new Error(
      `${COVERAGE_FILE}: line 3 does not say when the set was made ("Generated <date> <hh:mm> from")`,
    );
  }
  const wall = Date.UTC(Number(year), MONTHS.indexOf(month), Number(day), Number(hour), Number(minute));
  // The zone's offset at that wall time, found from the clock itself; a time the zone skips or repeats is refused.
  let at = wall - (wallClockAt(wall) - wall);
  at = wall - (wallClockAt(at) - at);
  const oneHour = 3_600_000;
  if (
    Number.isNaN(at) ||
    wallClockAt(at) !== wall ||
    wallClockAt(at - oneHour) === wall ||
    wallClockAt(at + oneHour) === wall
  ) {
    throw new Error(`${COVERAGE_FILE}: line 3's time is not one instant in ${FIXTURE_SET_TIME_ZONE}`);
  }
  return { at: new Date(at), source: COVERAGE_FILE };
}

/** Reads one shop file for the setup seed. `hasForm`: whether forms/<id>.json is in the set. */
function readSetupShop(shop: DemoShop, file: VerifiedFile, hasForm: boolean): SetupShop {
  const parsed = parseShopFile(file);
  const flows = flowsOf(shop.source, parsed.flows);
  const listing = listingOf(shop.source, parsed.google_prefill);
  if (!hasForm) {
    if (parsed.facts !== undefined || parsed.switches !== undefined || parsed.settings !== undefined) {
      throw new Error(
        `${shop.source}: it has profession data but no owner form (${FORMS_DIR}${shop.id}.json)`,
      );
    }
    return { shop, flows, listing, profession: null };
  }
  if (!KIND_ID.test(shop.id)) {
    throw new Error(`${shop.source}: its id is not a kind of work's id (lower-case words and dashes)`);
  }
  const { facts, settings } = parsed;
  if (!isNameList(facts)) {
    throw new Error(`${shop.source}: its facts are not a list of lower-case names`);
  }
  if (!isRecord(settings) || !Object.keys(settings).every((key) => key === "arrive" || key === "cutoff")) {
    throw new Error(`${shop.source}: its settings are not an object of arrive and cutoff`);
  }
  const switches = switchesOf(shop.source, parsed.switches);
  const perFlow = <T>(read: (flow: Flow) => T): Record<Flow, T> => ({ A: read("A"), B: read("B") });
  return {
    shop,
    flows,
    listing,
    profession: {
      facts,
      switches,
      arrive: perFlow((flow) => arriveOf(shop.source, flow, settingFor(shop.source, settings.arrive, flow))),
      cutoff: perFlow((flow) => cutoffOf(shop.source, flow, settingFor(shop.source, settings.cutoff, flow))),
    },
  };
}

/**
 * Plans every row of the setup seed from a verified fixture set (pure: no database). Shops are taken in code-point order
 * of id, as the core seed takes them, so the owners' keys and mobiles are the core seed's.
 */
export function setupPlanOf(verified: VerifiedFixtureSet): SetupSeedPlan {
  const files = filesUnder(verified, SHOPS_DIR);
  const shops = readDemoShops(files);
  if (shops.length === 0) {
    throw new Error(`the fixture set at ${verified.dir} has no demo shop under ${SHOPS_DIR}`);
  }
  const fileOf = new Map(files.map((file) => [file.path, file]));
  const read = shops.map((shop) => {
    const file = fileOf.get(shop.source);
    if (file === undefined) {
      throw new Error(`${shop.source}: not among the verified files`);
    }
    return readSetupShop(shop, file, verified.files.has(`${FORMS_DIR}${shop.id}.json`));
  });
  const byId = new Map(read.map((entry) => [entry.shop.id, entry]));

  // The one listing address every shop with a listing gives, for the shops that have none.
  const withListing = read.filter((entry) => entry.listing !== null);
  const addresses = new Set(withListing.map((entry) => entry.listing?.address));
  const firstListed = withListing[0];
  const sharedAddress = addresses.size === 1 ? firstListed?.listing?.address : undefined;

  const { seeded: coreKeys } = coreRowsOf(shops);
  const coreOf = new Map(coreKeys.map((keys) => [keys.shopId, keys]));
  const seededAt = seededAtOf(verified);

  const rows = {
    business_setup: [] as BusinessSetupSeedRow[],
    companies: [] as CompanySeedRow[],
    company_kinds: [] as CompanyKindSeedRow[],
    flow_defaults: [] as FlowDefaultSeedRow[],
    locations: [] as LocationSeedRow[],
    staff: [] as StaffSeedRow[],
    id_uploads: [] as IdUploadPlan[],
  };
  const seeded: SetupSeededShop[] = [];
  const core: { businessId: string; handleId: string; phoneNumber: string }[] = [];

  for (const { shop, flows, listing, profession } of read) {
    const keys = coreOf.get(shop.id);
    if (keys === undefined) {
      throw new Error(`${shop.source}: the core seed has no keys for it`);
    }
    const valuesFrom: Record<string, string> = {};
    const businessId = keys.businessId;
    const owner = keys.personId;
    const companyId = `company-demo-${shop.id}`;
    const locationId = `loc-demo-${shop.id}`;
    const staffId = `staff-demo-${shop.id}-owner`;
    const idUploadId = `idup-demo-${shop.id}-owner-sign-up`;

    let address = listing?.address;
    if (address === undefined) {
      if (sharedAddress === undefined || firstListed === undefined) {
        throw new Error(
          `${shop.source}: it has no listing, and the demo shops do not give one listing address to take`,
        );
      }
      address = sharedAddress;
      valuesFrom.address = firstListed.shop.source;
    }

    let noMoney = false;
    const flowDefaults: Flow[] = [];
    const cutoffsNotHeld: { flow: Flow; words: string }[] = [];
    if (profession !== null) {
      let facts = profession.facts;
      if (facts.length === 0) {
        const from = byId.get(FACTS_FROM[shop.id] ?? "");
        const borrowed = from?.profession?.facts ?? [];
        if (from === undefined || borrowed.length === 0) {
          throw new Error(`${shop.source}: it lists no facts, and MC C5 gives it no other shop's list`);
        }
        facts = borrowed;
        valuesFrom.pf_facts = from.shop.source;
      }
      if (facts.includes("nomoney")) {
        if (!flows.every((flow) => profession.switches[flow].includes("nomoney"))) {
          throw new Error(`${shop.source}: it has the fact nomoney without its switch on in every flow`);
        }
        noMoney = true;
      }
      rows.company_kinds.push({
        company_id: companyId,
        kind_id: shop.id,
        business_id: businessId,
        trade_name: null,
        pf_facts: facts,
        pf_switches_a: profession.switches.A,
        pf_switches_b: profession.switches.B,
      });
      for (const flow of flows) {
        const cutoff = profession.cutoff[flow];
        if (cutoff.kind === "notHeld") {
          cutoffsNotHeld.push({ flow, words: cutoff.words });
        } else if (cutoff.kind !== "none") {
          rows.flow_defaults.push({
            business_id: businessId,
            flow,
            cutoff_before: cutoff.kind === "before" ? cutoff.interval : null,
            cutoff_day_before_at: cutoff.kind === "dayBeforeAt" ? cutoff.time : null,
            arrive: profession.arrive[flow],
          });
          flowDefaults.push(flow);
        }
      }
    }

    rows.business_setup.push({
      business_id: businessId,
      website: listing?.website ?? null,
      no_money: noMoney,
    });
    rows.companies.push({ id: companyId, owner_person_id: owner, name: shop.name, business_id: businessId });
    rows.locations.push({
      id: locationId,
      business_id: businessId,
      kind: DEMO_LOCATION_KIND,
      name: null,
      address,
      map_point: null,
      travel_miles: flows.includes("B") ? DEMO_TRAVEL_MILES : null,
    });
    rows.staff.push({
      id: staffId,
      business_id: businessId,
      person_id: owner,
      mobile: keys.phoneNumber,
      agreed_to_text_ticked_at: seededAt.at,
      agreed_ticked_by_person_id: owner,
      status: "joined",
      added_at: seededAt.at,
      joined_at: seededAt.at,
      joined_from_number: keys.phoneNumber,
      bookable_at: seededAt.at,
      bookable_by_person_id: owner,
    });
    rows.id_uploads.push({
      id: idUploadId,
      person_id: owner,
      purpose: "sign_up",
      content_type: DEMO_ID_CONTENT_TYPE,
      uploaded_at: seededAt.at,
      objectKey: `${DEMO_ID_OBJECT_KEY_PREFIX}${idUploadId}`,
    });
    core.push({ businessId, handleId: keys.handleId, phoneNumber: keys.phoneNumber });
    seeded.push({
      shopId: shop.id,
      source: shop.source,
      sha256: shop.sha256,
      businessId,
      ownerPersonId: owner,
      companyId,
      kindId: profession === null ? null : shop.id,
      locationId,
      staffId,
      idUploadId,
      flows,
      flowDefaults,
      cutoffsNotHeld,
      valuesFrom,
    });
  }
  return { rows, seeded, seededAt, core };
}

/** Seeds the demo shops' business setup from fixture set v1 (see the top of this file). */
export async function seedSetupBusiness(sql: Sql, options: SetupSeedOptions): Promise<SetupSeedResult> {
  return seedSetupBusinessFrom(sql, openFixtureSet(options.fixturesDir), options);
}

/** The entry every seed set exports under one name, so a runner finds a set by its file name (T-201). */
export const seed = seedSetupBusiness;

/** Refuses to write before the core seed: every shop's business head, and its owner's handle with that mobile. */
async function requireCoreRows(tx: Tx, plan: SetupSeedPlan): Promise<void> {
  const businessIds = plan.core.map((keys) => keys.businessId);
  const handleIds = plan.core.map((keys) => keys.handleId);
  const businesses = await tx<
    { id: string }[]
  >`select id from businesses where id = any(${businessIds}::text[])`;
  const phones = await tx<{ number: string; handle_id: string }[]>`
    select number, handle_id from phones where handle_id = any(${handleIds}::text[])
  `;
  const found = new Set(businesses.map((row) => row.id));
  const mobiles = new Set(phones.map((row) => `${row.handle_id} ${row.number}`));
  const missing = plan.core.filter(
    (keys) => !found.has(keys.businessId) || !mobiles.has(`${keys.handleId} ${keys.phoneNumber}`),
  );
  if (missing.length > 0) {
    throw new Error(
      `the core seed's rows are missing for ${String(missing.length)} of ${String(plan.core.length)} shops: ` +
        `run db/seeds/core.ts first (nothing was written)`,
    );
  }
}

/** seedSetupBusiness, from a fixture set already opened (tests open a temporary copy of the set inside its own jail). */
export async function seedSetupBusinessFrom(
  sql: Sql,
  set: FixtureSet,
  options: Pick<SetupSeedOptions, "wrappingKeys">,
): Promise<SetupSeedResult> {
  const verified = verifyFixtureSet(set);
  const plan = setupPlanOf(verified);
  const { rows } = plan;
  const owners = rows.id_uploads.map((upload) => upload.person_id);

  const written = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${SEED_ROLE}`);
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    const [who] = await tx<{ role: string }[]>`select current_user as role`;
    await requireCoreRows(tx, plan);

    const businessSetup = await tx`
      insert into business_setup ${tx(rows.business_setup, "business_id", "website", "no_money")}
      on conflict (business_id) do nothing
    `;
    const companies = await tx`
      insert into companies ${tx(rows.companies, "id", "owner_person_id", "name", "business_id")}
      on conflict (id) do nothing
    `;
    const companyKinds =
      rows.company_kinds.length === 0
        ? { count: 0 }
        : await tx`
            insert into company_kinds ${tx(
              rows.company_kinds,
              "company_id",
              "kind_id",
              "business_id",
              "trade_name",
              "pf_facts",
              "pf_switches_a",
              "pf_switches_b",
            )}
            on conflict (company_id, kind_id) do nothing
          `;
    const flowDefaults =
      rows.flow_defaults.length === 0
        ? { count: 0 }
        : await tx`
            insert into flow_defaults ${tx(
              rows.flow_defaults,
              "business_id",
              "flow",
              "cutoff_before",
              "cutoff_day_before_at",
              "arrive",
            )}
            on conflict (business_id, flow) do nothing
          `;
    const locations = await tx`
      insert into locations ${tx(
        rows.locations,
        "id",
        "business_id",
        "kind",
        "name",
        "address",
        "map_point",
        "travel_miles",
      )}
      on conflict (id) do nothing
    `;
    const staff = await tx`
      insert into staff ${tx(
        rows.staff,
        "id",
        "business_id",
        "person_id",
        "mobile",
        "agreed_to_text_ticked_at",
        "agreed_ticked_by_person_id",
        "status",
        "added_at",
        "joined_at",
        "joined_from_number",
        "bookable_at",
        "bookable_by_person_id",
      )}
      on conflict (id) do nothing
    `;

    // Only a missing upload is sealed, so a second run makes no key and seals nothing. The owner's first seal makes
    // their sealing key, wrapped under the caller's wrapping key (sealing.ts).
    const present = await tx<{ id: string }[]>`
      select id from id_uploads where id = any(${rows.id_uploads.map((upload) => upload.id)}::text[])
    `;
    const have = new Set(present.map((row) => row.id));
    const keysBefore = await tx<{ n: number }[]>`
      select count(*)::int as n from sealing_keys where person_id = any(${owners}::text[])
    `;
    const missing = rows.id_uploads.filter((upload) => !have.has(upload.id));
    const sealed: (Omit<IdUploadPlan, "objectKey"> & { object_key: Uint8Array })[] = [];
    for (const upload of missing) {
      const objectKey = await seal(tx, options.wrappingKeys, upload.person_id, upload.objectKey);
      sealed.push({
        id: upload.id,
        person_id: upload.person_id,
        purpose: upload.purpose,
        object_key: objectKey,
        content_type: upload.content_type,
        uploaded_at: upload.uploaded_at,
      });
    }
    const idUploads =
      sealed.length === 0
        ? { count: 0 }
        : await tx`
            insert into id_uploads ${tx(
              sealed,
              "id",
              "person_id",
              "purpose",
              "object_key",
              "content_type",
              "uploaded_at",
            )}
            on conflict (id) do nothing
          `;
    const keysAfter = await tx<{ n: number }[]>`
      select count(*)::int as n from sealing_keys where person_id = any(${owners}::text[])
    `;
    return {
      ranAs: who?.role ?? "",
      inserted: {
        business_setup: businessSetup.count,
        companies: companies.count,
        company_kinds: companyKinds.count,
        flow_defaults: flowDefaults.count,
        locations: locations.count,
        staff: staff.count,
        id_uploads: idUploads.count,
      },
      sealingKeys: { before: keysBefore[0]?.n ?? 0, after: keysAfter[0]?.n ?? 0 },
    };
  });

  const count = (table: keyof SetupSeedRows): CoreSeedTableCount => {
    const total = rows[table].length;
    const inserted = written.inserted[table];
    return { rows: total, inserted, kept: total - inserted };
  };
  const { before, after } = written.sealingKeys;
  return {
    ranAs: written.ranAs,
    fixtureSet: {
      dir: verified.dir,
      manifestSha256: verified.manifestSha256,
      filesChecked: verified.filesChecked,
    },
    seededAt: plan.seededAt,
    tables: {
      business_setup: count("business_setup"),
      companies: count("companies"),
      company_kinds: count("company_kinds"),
      flow_defaults: count("flow_defaults"),
      locations: count("locations"),
      staff: count("staff"),
      id_uploads: count("id_uploads"),
      sealing_keys: { rows: after, inserted: after - before, kept: before },
    },
    shops: plan.seeded,
  };
}
