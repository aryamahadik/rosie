// T-215: the availability and bill card seed (C-155; K-27 v1 availability, K-33 v1 platform billing and K-35 v1
// documents and licenses, all frozen: contracts/db-schema/availability, platform-billing and documents-licenses, their
// table lists, READMEs and seed fixtures, built by migrations 0024 to 0026; build prompt 3.5: search reads hours, time
// off and busy blocks; Master Corrections R3; build prompt rule 9). From fixture set v1's 245 demo shops, each shop's
// open hours, the class timetable and its dated sessions with seats for the shops whose work runs classes, and the card
// for Rosfield's monthly bill, so search, the times card (A4-14, A4-33) and the monthly bill (S11-66) run on seeded
// rows. It runs after the core (core.ts, T-200), setup (setup-business.ts, T-213), kinds (kinds.ts, T-212), services
// (setup-services-rules.ts, T-214) and staff (setup-staff.ts, T-727) seeds, and takes its shops, owners, locations,
// services and dates from their plans. Per shop, with ids made from the shop's id (its file's name):
//   weekly_hours    hours-demo-<shop>-<day>-<hhmm>: one row per open span on one day of the week, the opening hours of
//                   the shop's location (loc-demo-<shop>, owner kind location), as local times in the business's zone,
//                   from the demo listing's hours (H01; S1-21's tap list: "Hours · From your Google listing")
//   classes         class-demo-<shop>-<flow>-<path>: for a shop whose facts list classes (FS rows K01 and K02, "R for
//                   class work", are turned on by the fact classes; S1-82, S1-83), one class that meets each week, selling
//                   one of the shop's services (the services seed's svc-demo-<shop>-<flow>-<path>), at its location
//   resources,      session-demo-<shop>-<flow>-<path>-<yyyy-mm-dd>: each dated session of a class, in one go as K-27
//   class_seats,    default 10 makes it: a K-04 resource of kind class_session, its seat counter (capacity the class's
//   class_sessions  seats, none taken) and its class_sessions row, scheduled, for SESSIONS_AHEAD_DAYS days
//   bill_cards      billcard-demo-<shop>-1: the card for Rosfield's monthly bill (FS row M04; S1-29), saved by the
//                   owner, as Stripe test-mode stand-in ids in the Stripe double's form (K-14 v1 "The double"; K-33 v1
//                   seed-bill-card.json): stripe-customer-demo-<shop> and stripe-card-demo-<shop>-1, never a card number
//
//   const result = await seedSetupAvailability(sql);   // result.tables.weekly_hours: { rows: n, inserted: n, kept: 0 }
//
// What is read, and from where (rule 9; MC R3: code reads a trade's pf.facts, pf.switches and pf.settings by name, and
// every other pf.* value is free text for the AI, never parsed):
//   - from each test-kit/shops/<id>.json, through lib/fixture-set.ts and the setup seed's own reader: the demo listing's
//     hours (google_prefill.hours, "[G] <hours> (demo)", the listing every profession shop gives, which the setup seed
//     reads its address and website from), as day ranges and clock times; and the shop's facts, as the setup seed reads
//     them by name (the fact classes).
//   - the services the services seed made from each shop's money examples (their path and length, never their words).
//   - when fixture set v1 was made (test-kit/COVERAGE.md line 3, Eastern time), which dates every saved card and the first
//     day of the sessions, as the other seeds date their rows, so a second run writes the same rows.
//   No phone number, email address or name is taken from a fixture: a session's resource is named by its service, day and
//   time (as K-27 v1's seed names its sessions), and no class names a teacher.
//
// Defaults where the files give nothing (each named in the constants below and in the card's report):
//   1. Hours: the demo listing's hours are each shop's opening hours, as S1-21 offers them and the owner keeps them (FS
//      section 10: the owner confirms each one). test-mixed-A and -B have no listing, so they take the one listing hours
//      every demo shop gives, as the setup seed takes the one listing address (hours.from names the file). No worker,
//      room, vehicle or space has hours of its own: a person with none works the hours of the location (K-27 default
//      4), so no K-04 worker resource is needed, and none is written.
//   2. Classes: no file gives a timetable (S1-83's photo is the owner's), so each shop whose facts list classes gets one
//      class, selling its first service priced from the list in the services seed's order (flow A first; a seat sells
//      at a list price, while a quote from photos or at the visit is made per booking: K-25 README, Prices), else its
//      first service. It meets each week on the first open span of the week, from its opening time, for the service's
//      length (K-27 README: with no end on the photo, code takes the end from the service's length), at the shop's own
//      location, with no teacher or room (no file names who teaches: the cast is an illustration, MC C6), DEMO_CLASS_SEATS
//      seats Rosie can book, and no minimum (S1-83 asks the owner for the fewest it needs; with none it always runs).
//   3. Sessions: one for each week the class meets, SESSIONS_AHEAD_DAYS days from the day fixture set v1 was made (K-27
//      open gap 5: as far ahead as Rosie reads calendars), scheduled, none counted or cancelled, each with its resource
//      active and its seat counter at DEMO_CLASS_SEATS with none taken (K-27 rule 7: its capacity starts from its
//      class's seats, and its service is its class's).
//   4. The bill card: one per shop, since the $2 applies to every kind of work (S1-25; D97: no kind takes the no-$2
//      path, and the seed refuses a kind whose flows turn no2 on rather than guess), live, saved by the owner when
//      fixture set v1 was made; its ids are the Stripe double's stand-ins, which its default outcome charges (K-14 v1:
//      the sandbox's pm_card_visa), and the staging state links real test-mode cards (T-216).
//   NOT_SEEDED names what the files give nothing for, so nothing is written: time off and closed days, busy blocks,
//   calendar links and their shares, and documents (so nothing is sealed, and no row says checked).
//
// Checked before anything is written: every listed shop's hours are spans of known days and clock times, none past
// midnight and none overlapping another on its day; each class fits its day's open span; every id is made once; no
// Stripe id holds 13 digits in a row (K-33 bill_cards_no_card_number). Inside the transaction: each shop's business and
// owner (core), its location (setup), every kind of work in K-24's catalog with no flow that turns no2 on (kinds), each
// class's service at its own business (services), and each shop's owner skill row (staff).
//
// In order, stopping at the first failure: opens and checks fixture set v1 against its manifest as the core seed does
// (lib/fixture-set.ts), so only bytes that were hashed are parsed; reads every shop and refuses, naming the file, any
// value it does not know how to read rather than guess; then, in one transaction as the job role rosie_job with no
// business scope (T-191), checks that the core, setup, kinds, services and staff seeds' rows are there, and writes the
// rows through K-27's and K-33's tables and the K-04 resources and seat counters K-27's sessions need. Idempotent, as the
// other seeds: a row is inserted only when its primary key is free (ON CONFLICT DO NOTHING), nothing is updated or
// deleted, so a second run writes nothing and leaves every row as it was, version included; a row that went missing is
// written again as the first run wrote it. A clash on any other key or constraint (a second live bill card for one
// business, a span over another of the same location and day) is an error, and the transaction rolls back. Nothing is
// printed, and no error names a value of a row.
import { SCOPE_SETTING, type Sql, type Tx } from "../repo/scope";
import { type CoreSeedTableCount, SEED_ROLE } from "./core";
import { DEMO_TIME_ZONE, SHOPS_DIR } from "./lib/demo-shops";
import {
  filesUnder,
  type FixtureSet,
  openFixtureSet,
  type VerifiedFile,
  type VerifiedFixtureSet,
  verifyFixtureSet,
} from "./lib/fixture-set";
import { type Flow, setupPlanOf } from "./setup-business";
import { servicesRulesPlanOf, TEST_MIXED_KINDS } from "./setup-services-rules";
import { staffPlanOf } from "./setup-staff";

/** The fact that says a kind of work runs classes (FS rows K01 and K02 are turned on by it; S1-82). */
export const CLASSES_FACT = "classes";
/** Default 2: the seats Rosie can book in each class and session, K-27 v1's seed class's (the Hot Flow class, 12). */
export const DEMO_CLASS_SEATS = 12;
/** Default 3: how many days ahead of when fixture set v1 was made sessions are made (K-27 open gap 5's default). */
export const SESSIONS_AHEAD_DAYS = 90;
/** Default 4: the Stripe double's stand-in id forms for the bill card (K-14 v1 fixtures; K-33 v1 seed-bill-card). */
export const STRIPE_CUSTOMER_PREFIX = "stripe-customer-demo-";
export const STRIPE_CARD_PREFIX = "stripe-card-demo-";
/** The switch of a kind of work that takes no $2, whose owner is asked for no bill card (S1-25's pf:no2; K-33 README). */
export const NO_TWO_DOLLARS_SWITCH = "no2";
/** The K-04 resource kind a class session is (K-04 resources_kind_known; K-27 class_sessions_kind). */
export const SESSION_KIND = "class_session";
/** What the files give nothing for, so nothing is written, and why. */
export const NOT_SEEDED: Readonly<Record<string, string>> = {
  time_off:
    "no file names a day off, a closed day or a blocked time (FS row H02 is optional, and K-27 open gap 17: the sources give no holiday list)",
  busy_blocks:
    "busy times come only from a linked calendar or a schedule photo on the owner's yes (S1-24); no file gives either",
  calendar_links:
    "a calendar is linked on a page the person has open (Q-10); the staging state's linked calendars are T-216's",
  calendar_link_shares: "a share is made only with a calendar link",
  documents:
    "no file gives a document a demo owner added: licenses are optional and never checked (D96), and pf.license is free text (MC R3) that names what to ask, never an answer",
};

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const MINUTES_PER_DAY = 1440;
/** The days of the week by ISO number, 1 (Monday) to 7 (Sunday), as the listing writes them. */
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
// "[G] <value> (demo)": a value prefilled from the demo listing (as the setup seed reads its address and website).
const DEMO_PREFILL = /^\[G\] (\S(?:.*\S)?) \(demo\)$/;
// One group of the listing's hours: a day or a run of days, then the opening and closing times ("Mon-Fri 9am-5pm").
const HOURS_GROUP =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:-(Mon|Tue|Wed|Thu|Fri|Sat|Sun))? ((?:1[0-2]|[1-9])(?::[0-5][0-9])?(?:am|pm))-((?:1[0-2]|[1-9])(?::[0-5][0-9])?(?:am|pm))$/;
const CLOCK_WORDS = /^(1[0-2]|[1-9])(?::([0-5][0-9]))?(am|pm)$/;
// A service's length as the services seed writes it ("1 hour"; K-25 services.length is an interval).
const LENGTH_WORDS = /^([1-9][0-9]{0,3}) (minute|minutes|hour|hours)$/;
// K-33 bill_cards_no_card_number: 13 or more digits in a row, once spaces and dashes are taken out.
const CARD_NUMBER_RUN = /[0-9]{13,}/;

/** One open span of a day of the week, as local times: "09:00" to "17:00" ("24:00" closes at midnight). */
export interface OpenSpan {
  /** ISO day of the week, 1 (Monday) to 7 (Sunday). */
  readonly weekday: number;
  readonly opens: string;
  readonly closes: string;
}

export interface WeeklyHoursSeedRow {
  readonly id: string;
  readonly business_id: string;
  readonly owner_kind: "location";
  readonly location_id: string;
  readonly resource_id: null;
  readonly resource_kind: null;
  readonly place_or_thing_id: null;
  readonly weekday: number;
  readonly opens_at: string;
  readonly closes_at: string;
  readonly time_zone: string;
}

export interface SessionResourceSeedRow {
  readonly id: string;
  readonly business_id: string;
  readonly kind: typeof SESSION_KIND;
  readonly name: string;
  readonly person_id: null;
  readonly active: true;
}

export interface ClassSeatsSeedRow {
  readonly resource_id: string;
  readonly resource_kind: typeof SESSION_KIND;
  readonly business_id: string;
  readonly capacity: number;
  readonly taken: 0;
}

export interface ClassSeedRow {
  readonly id: string;
  readonly business_id: string;
  readonly service_id: string;
  readonly weekday: number;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly time_zone: string;
  readonly teacher_resource_id: null;
  readonly room_resource_id: null;
  readonly location_id: string;
  readonly seats: number;
  readonly minimum: null;
  readonly active: true;
}

export interface ClassSessionSeedRow {
  readonly resource_id: string;
  readonly resource_kind: typeof SESSION_KIND;
  readonly business_id: string;
  readonly class_id: string;
  readonly service_id: string;
  /** A tstzrange [start, end) of instants, as PostgreSQL reads it. */
  readonly during: string;
  readonly time_zone: string;
  readonly teacher_resource_id: null;
  readonly room_resource_id: null;
  readonly location_id: string;
  readonly minimum: null;
  readonly status: "scheduled";
  readonly counted_at: null;
  readonly too_few: null;
  readonly cancelled_at: null;
  readonly cancelled_by_person_id: null;
}

export interface BillCardSeedRow {
  readonly id: string;
  readonly business_id: string;
  readonly saved_by_person_id: string;
  readonly stripe_customer_id: string;
  readonly stripe_payment_method_id: string;
  readonly saved_at: Date;
  readonly removed_at: null;
}

/** The rows of every shop, table by table, in the order they are written. */
export interface AvailabilitySeedRows {
  readonly weekly_hours: readonly WeeklyHoursSeedRow[];
  readonly resources: readonly SessionResourceSeedRow[];
  readonly class_seats: readonly ClassSeatsSeedRow[];
  readonly classes: readonly ClassSeedRow[];
  readonly class_sessions: readonly ClassSessionSeedRow[];
  readonly bill_cards: readonly BillCardSeedRow[];
}

export type AvailabilitySeedTable = keyof AvailabilitySeedRows;

/** One dated session, as seeded: its K-04 resource (and seat counter) and its window of instants. */
export interface SeededSession {
  readonly resourceId: string;
  readonly during: string;
}

/** One class, as seeded: the service a seat sells, where that service is in the shop file, and its sessions. */
export interface SeededClass {
  readonly id: string;
  readonly serviceId: string;
  readonly flow: Flow;
  readonly path: string;
  /** Where the service's money example is in the shop file: flows.<flow>.services[<index>]. */
  readonly at: string;
  /** "list": the shop's first service priced from the list; "first": its first service, none being priced so. */
  readonly picked: "list" | "first";
  readonly weekday: number;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly seats: number;
  readonly sessions: readonly SeededSession[];
}

/** One entry per shop: its fixture file, its hours and where they came from, and every key the seed wrote. */
export interface SeededAvailabilityShop {
  readonly shopId: string;
  readonly source: string;
  readonly sha256: string;
  readonly businessId: string;
  readonly ownerPersonId: string;
  readonly locationId: string;
  /** The listing's hours as worded, the fixture set v1 file they were read from, and the rows made from them. */
  readonly hours: { readonly words: string; readonly from: string; readonly ids: readonly string[] };
  /** Whether the shop's facts list classes (default 2). */
  readonly runsClasses: boolean;
  /** One entry per class (one for a shop that runs classes, none for the rest). */
  readonly classes: readonly SeededClass[];
  readonly billCardId: string;
}

export interface AvailabilitySeedPlan {
  readonly rows: AvailabilitySeedRows;
  /** One entry per shop, in code-point order of id. */
  readonly shops: readonly SeededAvailabilityShop[];
  /** When fixture set v1 was made, which dates the bill cards and the first day of the sessions, and the file. */
  readonly seededAt: { readonly at: Date; readonly source: string };
  /** The keys of the other seeds' rows this one builds on, checked inside the transaction. */
  readonly needs: {
    readonly kindIds: readonly string[];
    readonly serviceIds: readonly { readonly id: string; readonly businessId: string }[];
    readonly ownerSkillIds: readonly string[];
  };
}

export interface AvailabilitySeedResult {
  /** The database role that wrote the rows (current_user inside the seed's transaction). */
  readonly ranAs: string;
  /** The fixture set that was checked: its folder, its manifest's sha256 and how many files the manifest lists. */
  readonly fixtureSet: {
    readonly dir: string;
    readonly manifestSha256: string;
    readonly filesChecked: number;
  };
  readonly seededAt: { readonly at: Date; readonly source: string };
  readonly tables: Readonly<Record<AvailabilitySeedTable, CoreSeedTableCount>>;
  /** The tables of K-27 and K-35 the seed writes nothing to, and why (NOT_SEEDED). */
  readonly notSeeded: Readonly<Record<string, string>>;
  readonly shops: readonly SeededAvailabilityShop[];
}

export interface AvailabilitySeedOptions {
  /** Fixture set v1's folder. Default fixtures/v1. Anything outside the repository's fixtures/ folder is refused. */
  fixturesDir?: string;
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

/** Minutes past midnight as "HH:MM" ("24:00" for midnight at the end of a day). */
const clockOf = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** "HH:MM" (as clockOf writes it) in minutes past midnight. */
const minutesOfClockTime = (clock: string): number =>
  Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** A clock time as the listing writes it ("9am", "5:30pm") in minutes past midnight; 12am closing a span is 24:00. */
function minutesOfClock(words: string, closing: boolean): number | null {
  const match = CLOCK_WORDS.exec(words);
  if (match?.[1] === undefined || match[3] === undefined) {
    return null;
  }
  const minutes = ((Number(match[1]) % 12) + (match[3] === "pm" ? 12 : 0)) * 60 + Number(match[2] ?? "0");
  return closing && minutes === 0 ? MINUTES_PER_DAY : minutes;
}

const dayNumber = (name: string | undefined): number | undefined => {
  const index = DAY_NAMES.findIndex((day) => day === name);
  return index < 0 ? undefined : index + 1;
};

/**
 * The open spans of a listing's hours ("Mon-Fri 9am-5pm, Sat 10am-2pm"): groups of a day or a run of days and an opening
 * and closing time, one span per day, in day order. Anything else is refused, naming the file: a day or time the seed
 * does not know, a run of days that wraps past Sunday, a span that does not close after it opens (past midnight is two
 * spans), or two spans of one day that overlap.
 */
export function hoursOf(source: string, words: string): OpenSpan[] {
  const spans: { weekday: number; opens: number; closes: number }[] = [];
  for (const group of words.split(", ")) {
    const match = HOURS_GROUP.exec(group);
    const first = dayNumber(match?.[1]);
    const last = match?.[2] === undefined ? first : dayNumber(match[2]);
    const opens = minutesOfClock(match?.[3] ?? "", false);
    const closes = minutesOfClock(match?.[4] ?? "", true);
    if (first === undefined || last === undefined || opens === null || closes === null) {
      throw new Error(
        `${source}: google_prefill's hours are not "<days> <opens>-<closes>" groups the seed knows`,
      );
    }
    if (last < first) {
      throw new Error(`${source}: google_prefill's hours name a run of days that wraps past Sunday`);
    }
    if (opens >= closes) {
      throw new Error(
        `${source}: google_prefill's hours hold a span that does not close after it opens (past midnight is two spans)`,
      );
    }
    for (let weekday = first; weekday <= last; weekday += 1) {
      spans.push({ weekday, opens, closes });
    }
  }
  spans.sort((a, b) => a.weekday - b.weekday || a.opens - b.opens);
  spans.forEach((span, index) => {
    const before = spans[index - 1];
    if (before?.weekday === span.weekday && before.closes > span.opens) {
      throw new Error(`${source}: google_prefill's hours hold two spans of one day that overlap`);
    }
  });
  return spans.map((span) => ({
    weekday: span.weekday,
    opens: clockOf(span.opens),
    closes: clockOf(span.closes),
  }));
}

/** A listing's hours words ("[G] <hours> (demo)" as the hours), or null for a shop file with no listing. */
function listingHoursOf(source: string, parsed: Record<string, unknown>): string | null {
  const prefill = parsed.google_prefill;
  if (prefill === undefined) {
    return null;
  }
  const value = isRecord(prefill) ? prefill.hours : undefined;
  const found = typeof value === "string" ? DEMO_PREFILL.exec(value)?.[1] : undefined;
  if (found === undefined) {
    throw new Error(`${source}: google_prefill's hours are not a demo listing value ("[G] <value> (demo)")`);
  }
  return found;
}

/** A service's length in minutes, as the services seed writes it ("1 hour"). */
export function lengthMinutesOf(words: string): number | null {
  const match = LENGTH_WORDS.exec(words);
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  return Number(match[1]) * (match[2].startsWith("hour") ? 60 : 1);
}

// The demo shops' zone's wall clock at an instant, read as if it were UTC (milliseconds).
const ZONE_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: DEMO_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

function wallClockAt(at: number): number {
  const parts = ZONE_CLOCK.formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
}

/**
 * The instant of a wall-clock time in the demo shops' zone: `day` is the date's midnight read as UTC (milliseconds) and
 * `minutes` the time past it. A time the zone skips or repeats is refused.
 */
function instantAt(day: number, minutes: number): Date {
  const wall = day + minutes * MINUTE_MS;
  let at = wall - (wallClockAt(wall) - wall);
  at = wall - (wallClockAt(at) - at);
  if (
    Number.isNaN(at) ||
    wallClockAt(at) !== wall ||
    wallClockAt(at - HOUR_MS) === wall ||
    wallClockAt(at + HOUR_MS) === wall
  ) {
    throw new Error(`a class session's start or end is not one instant in ${DEMO_TIME_ZONE}`);
  }
  return new Date(at);
}

/** ISO day of the week of a date's midnight read as UTC: 1 (Monday) to 7 (Sunday). */
const weekdayOf = (day: number): number => ((new Date(day).getUTCDay() + 6) % 7) + 1;

/** A time of day as a person reads it: "9:00am", "12:30pm". */
function twelveHourClock(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 24;
  const shown = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(shown)}:${String(minutes % 60).padStart(2, "0")}${hour < 12 ? "am" : "pm"}`;
}

/** A session's resource name, as K-27 v1's seed names its sessions: "Hot Flow class, Sat Nov 14 10:00am". */
function sessionName(service: string, day: number, minutes: number): string {
  const date = new Date(day);
  const weekday = DAY_NAMES[weekdayOf(day) - 1] ?? "";
  const month = MONTH_NAMES[date.getUTCMonth()] ?? "";
  return `${service}, ${weekday} ${month} ${String(date.getUTCDate())} ${twelveHourClock(minutes)}`;
}

/** Refuses a plan that would write one id twice in a table, which ON CONFLICT DO NOTHING would otherwise drop. */
function requireUnique(table: string, keys: readonly string[]): void {
  if (new Set(keys).size !== keys.length) {
    throw new Error(`the availability seed would write two ${table} rows with one key; stopping`);
  }
}

const idPart = (flow: Flow, path: string): string => `${flow.toLowerCase()}-${path.replaceAll("|", "-")}`;

/**
 * Plans every row of the availability seed from a verified fixture set (pure: no database). Shops are taken in the
 * setup seed's order (code-point order of id), with the keys its plan and the services and staff seeds' plans make, so
 * each row names the business, owner, location and service those seeds wrote.
 */
export function availabilityPlanOf(verified: VerifiedFixtureSet): AvailabilitySeedPlan {
  const setup = setupPlanOf(verified);
  const services = servicesRulesPlanOf(verified);
  const staff = staffPlanOf(verified);
  const fileOf = new Map(filesUnder(verified, SHOPS_DIR).map((file) => [file.path, file]));
  const factsOf = new Map(setup.rows.company_kinds.map((row) => [row.business_id, row.pf_facts]));
  const servicesOf = new Map(services.shops.map((shop) => [shop.businessId, shop]));
  const serviceRowOf = new Map(services.rows.services.map((row) => [row.id, row]));
  const ownerSkillOf = new Map(staff.shops.map((shop) => [shop.businessId, shop.ownerSkillId]));
  const at = setup.seededAt.at;

  // The listing hours of every shop that has a listing, and the one wording they all give, for the shops with none.
  const listed = setup.seeded.map((shop) => {
    const file = fileOf.get(shop.source);
    if (file === undefined) {
      throw new Error(`${shop.source}: not among the verified files`);
    }
    return { shop, words: listingHoursOf(shop.source, parseShopFile(file)) };
  });
  const wordings = new Set(listed.flatMap((entry) => (entry.words === null ? [] : [entry.words])));
  const firstListed = listed.find((entry) => entry.words !== null);
  const sharedHours = wordings.size === 1 ? firstListed : undefined;

  // The first day of the sessions: the day fixture set v1 was made, in the demo shops' zone.
  const firstDay = Math.floor(wallClockAt(at.getTime()) / DAY_MS) * DAY_MS;

  const rows = {
    weekly_hours: [] as WeeklyHoursSeedRow[],
    resources: [] as SessionResourceSeedRow[],
    class_seats: [] as ClassSeatsSeedRow[],
    classes: [] as ClassSeedRow[],
    class_sessions: [] as ClassSessionSeedRow[],
    bill_cards: [] as BillCardSeedRow[],
  };
  const shops: SeededAvailabilityShop[] = [];
  const serviceNeeds: { id: string; businessId: string }[] = [];

  for (const { shop, words } of listed) {
    const business = shop.businessId;
    const owner = shop.ownerPersonId;
    const location = shop.locationId;
    let hoursWords = words;
    let hoursFrom = shop.source;
    if (hoursWords === null) {
      if (sharedHours?.words === undefined || sharedHours.words === null) {
        throw new Error(
          `${shop.source}: it has no listing, and the demo shops do not give one listing hours to take`,
        );
      }
      hoursWords = sharedHours.words;
      hoursFrom = sharedHours.shop.source;
    }
    const spans = hoursOf(hoursFrom, hoursWords);
    const hoursIds: string[] = [];
    for (const span of spans) {
      const id = `hours-demo-${shop.shopId}-${(DAY_NAMES[span.weekday - 1] ?? "").toLowerCase()}-${span.opens.replace(":", "")}`;
      hoursIds.push(id);
      rows.weekly_hours.push({
        id,
        business_id: business,
        owner_kind: "location",
        location_id: location,
        resource_id: null,
        resource_kind: null,
        place_or_thing_id: null,
        weekday: span.weekday,
        opens_at: span.opens,
        closes_at: span.closes,
        time_zone: DEMO_TIME_ZONE,
      });
    }

    const runsClasses = (factsOf.get(business) ?? []).includes(CLASSES_FACT);
    const classes: SeededClass[] = [];
    if (runsClasses) {
      const offered = servicesOf.get(business)?.services ?? [];
      const fromList = offered.find((service) => service.path.startsWith("list|"));
      const service = fromList ?? offered[0];
      const serviceRow = service === undefined ? undefined : serviceRowOf.get(service.serviceId);
      if (service === undefined || serviceRow === undefined) {
        throw new Error(
          `${shop.source}: its work runs classes, but the services seed gives it no service to sell`,
        );
      }
      const length = lengthMinutesOf(serviceRow.length);
      if (length === null) {
        throw new Error(`${shop.source}: ${service.at}'s service length is not a form the seed knows`);
      }
      const span = spans[0];
      if (span === undefined) {
        throw new Error(`${hoursFrom}: google_prefill's hours give no open span`);
      }
      const starts = minutesOfClockTime(span.opens);
      const ends = starts + length;
      if (ends > minutesOfClockTime(span.closes)) {
        throw new Error(`${shop.source}: its class does not fit the first open span of its week`);
      }
      const key = `${shop.shopId}-${idPart(service.flow, service.path)}`;
      const classId = `class-demo-${key}`;
      rows.classes.push({
        id: classId,
        business_id: business,
        service_id: service.serviceId,
        weekday: span.weekday,
        starts_at: span.opens,
        ends_at: clockOf(ends),
        time_zone: DEMO_TIME_ZONE,
        teacher_resource_id: null,
        room_resource_id: null,
        location_id: location,
        seats: DEMO_CLASS_SEATS,
        minimum: null,
        active: true,
      });
      serviceNeeds.push({ id: service.serviceId, businessId: business });
      const sessions: SeededSession[] = [];
      for (let offset = 0; offset < SESSIONS_AHEAD_DAYS; offset += 1) {
        const day = firstDay + offset * DAY_MS;
        if (weekdayOf(day) !== span.weekday) {
          continue;
        }
        const resourceId = `session-demo-${key}-${new Date(day).toISOString().slice(0, 10)}`;
        const during = `[${instantAt(day, starts).toISOString()},${instantAt(day, ends).toISOString()})`;
        rows.resources.push({
          id: resourceId,
          business_id: business,
          kind: SESSION_KIND,
          name: sessionName(serviceRow.name, day, starts),
          person_id: null,
          active: true,
        });
        rows.class_seats.push({
          resource_id: resourceId,
          resource_kind: SESSION_KIND,
          business_id: business,
          capacity: DEMO_CLASS_SEATS,
          taken: 0,
        });
        rows.class_sessions.push({
          resource_id: resourceId,
          resource_kind: SESSION_KIND,
          business_id: business,
          class_id: classId,
          service_id: service.serviceId,
          during,
          time_zone: DEMO_TIME_ZONE,
          teacher_resource_id: null,
          room_resource_id: null,
          location_id: location,
          minimum: null,
          status: "scheduled",
          counted_at: null,
          too_few: null,
          cancelled_at: null,
          cancelled_by_person_id: null,
        });
        sessions.push({ resourceId, during });
      }
      if (sessions.length === 0) {
        throw new Error(
          `${shop.source}: its class meets on no day of the ${String(SESSIONS_AHEAD_DAYS)} ahead`,
        );
      }
      classes.push({
        id: classId,
        serviceId: service.serviceId,
        flow: service.flow,
        path: service.path,
        at: service.at,
        picked: fromList === undefined ? "first" : "list",
        weekday: span.weekday,
        startsAt: span.opens,
        endsAt: clockOf(ends),
        seats: DEMO_CLASS_SEATS,
        sessions,
      });
    }

    const billCardId = `billcard-demo-${shop.shopId}-1`;
    rows.bill_cards.push({
      id: billCardId,
      business_id: business,
      saved_by_person_id: owner,
      stripe_customer_id: `${STRIPE_CUSTOMER_PREFIX}${shop.shopId}`,
      stripe_payment_method_id: `${STRIPE_CARD_PREFIX}${shop.shopId}-1`,
      saved_at: at,
      removed_at: null,
    });

    shops.push({
      shopId: shop.shopId,
      source: shop.source,
      sha256: shop.sha256,
      businessId: business,
      ownerPersonId: owner,
      locationId: location,
      hours: { words: hoursWords, from: hoursFrom, ids: hoursIds },
      runsClasses,
      classes,
      billCardId,
    });
  }

  const cardNumbers = rows.bill_cards.filter((card) =>
    [card.stripe_customer_id, card.stripe_payment_method_id].some((id) =>
      CARD_NUMBER_RUN.test(id.replace(/[ -]/g, "")),
    ),
  );
  if (cardNumbers.length > 0) {
    throw new Error(
      `refusing to write ${String(cardNumbers.length)} bill card(s) whose Stripe ids hold 13 digits in a row (K-33 bill_cards_no_card_number)`,
    );
  }
  requireUnique(
    "weekly_hours",
    rows.weekly_hours.map((row) => row.id),
  );
  requireUnique(
    "resources",
    rows.resources.map((row) => row.id),
  );
  requireUnique(
    "classes",
    rows.classes.map((row) => row.id),
  );
  requireUnique(
    "bill_cards",
    rows.bill_cards.map((row) => row.id),
  );
  const kindIds = [
    ...new Set(
      setup.seeded.map(
        (shop) => shop.kindId ?? TEST_MIXED_KINDS[shop.shopId] ?? `no kind for ${shop.source}`,
      ),
    ),
  ];
  const ownerSkillIds = setup.seeded.map(
    (shop) => ownerSkillOf.get(shop.businessId) ?? `no owner skill for ${shop.source}`,
  );
  return {
    rows,
    shops,
    seededAt: setup.seededAt,
    needs: { kindIds, serviceIds: serviceNeeds, ownerSkillIds },
  };
}

/** Seeds the demo shops' hours, classes with their sessions and bill cards from fixture set v1 (see the top of this file). */
export async function seedSetupAvailability(
  sql: Sql,
  options: AvailabilitySeedOptions = {},
): Promise<AvailabilitySeedResult> {
  return seedSetupAvailabilityFrom(sql, openFixtureSet(options.fixturesDir));
}

/** The entry every seed set exports under one name, so a runner finds a set by its file name (T-201). */
export const seed = seedSetupAvailability;

const missingMessage = (what: string, missing: number, of: number, unit: string, run: string): string =>
  `${what} are missing for ${String(missing)} of ${String(of)} ${unit}: run ${run} first (nothing was written)`;

/**
 * Refuses to write before the seeds this one builds on: each shop's business and owner (core), its location at that
 * business (setup), every kind of work in K-24's catalog, none of whose flows turns no2 on (kinds), each class's service
 * at its own business (services), and each shop's owner skill row (staff).
 */
async function requirePriorRows(tx: Tx, plan: AvailabilitySeedPlan): Promise<void> {
  const { shops, needs } = plan;
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

  const locations = await tx<{ id: string; business_id: string }[]>`
    select id, business_id from locations where id = any(${shops.map((shop) => shop.locationId)}::text[])
  `;
  const locationOf = new Map(locations.map((row) => [row.id, row.business_id]));
  const noSetup = shops.filter((shop) => locationOf.get(shop.locationId) !== shop.businessId);
  if (noSetup.length > 0) {
    throw new Error(
      missingMessage(
        "the setup seed's locations",
        noSetup.length,
        shops.length,
        "shops",
        "db/seeds/setup-business.ts",
      ),
    );
  }

  const kinds = await tx<{ id: string }[]>`select id from kinds where id = any(${needs.kindIds}::text[])`;
  const haveKind = new Set(kinds.map((row) => row.id));
  const noKind = needs.kindIds.filter((kindId) => !haveKind.has(kindId));
  if (noKind.length > 0) {
    throw new Error(
      missingMessage(
        "the kinds seed's kinds",
        noKind.length,
        needs.kindIds.length,
        "kinds of work",
        "db/seeds/kinds.ts",
      ),
    );
  }
  const noTwoDollars = await tx<{ kind_id: string }[]>`
    select distinct kind_id from kind_flows
    where kind_id = any(${needs.kindIds}::text[]) and ${NO_TWO_DOLLARS_SWITCH} = any(switches_on)
  `;
  if (noTwoDollars.length > 0) {
    throw new Error(
      `${String(noTwoDollars.length)} kind(s) of work turn ${NO_TWO_DOLLARS_SWITCH} on, whose owners are asked for no bill card (S1-25), while every demo shop gets one; nothing was written`,
    );
  }

  const serviceRows = await tx<{ id: string; business_id: string }[]>`
    select id, business_id from services where id = any(${needs.serviceIds.map((service) => service.id)}::text[])
  `;
  const serviceOf = new Map(serviceRows.map((row) => [row.id, row.business_id]));
  const noService = needs.serviceIds.filter((service) => serviceOf.get(service.id) !== service.businessId);
  if (noService.length > 0) {
    throw new Error(
      missingMessage(
        "the services seed's services",
        noService.length,
        needs.serviceIds.length,
        "classes",
        "db/seeds/setup-services-rules.ts",
      ),
    );
  }

  const skills = await tx<{ id: string }[]>`
    select id from staff_skills where id = any(${needs.ownerSkillIds}::text[])
  `;
  const haveSkill = new Set(skills.map((row) => row.id));
  const noStaff = needs.ownerSkillIds.filter((id) => !haveSkill.has(id));
  if (noStaff.length > 0) {
    throw new Error(
      missingMessage(
        "the staff seed's owner skill rows",
        noStaff.length,
        needs.ownerSkillIds.length,
        "shops",
        "db/seeds/setup-staff.ts",
      ),
    );
  }
}

/** seedSetupAvailability, from a fixture set already opened (tests open a temporary copy of the set inside its own jail). */
export async function seedSetupAvailabilityFrom(sql: Sql, set: FixtureSet): Promise<AvailabilitySeedResult> {
  const verified = verifyFixtureSet(set);
  const plan = availabilityPlanOf(verified);
  const { rows } = plan;

  const written = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${SEED_ROLE}`);
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    const [who] = await tx<{ role: string }[]>`select current_user as role`;
    await requirePriorRows(tx, plan);

    const none = { count: 0 };
    const weeklyHours =
      rows.weekly_hours.length === 0
        ? none
        : await tx`
            insert into weekly_hours ${tx(
              rows.weekly_hours,
              "id",
              "business_id",
              "owner_kind",
              "location_id",
              "resource_id",
              "resource_kind",
              "place_or_thing_id",
              "weekday",
              "opens_at",
              "closes_at",
              "time_zone",
            )}
            on conflict (id) do nothing
          `;
    const resources =
      rows.resources.length === 0
        ? none
        : await tx`
            insert into resources ${tx(rows.resources, "id", "business_id", "kind", "name", "person_id", "active")}
            on conflict (id) do nothing
          `;
    const classSeats =
      rows.class_seats.length === 0
        ? none
        : await tx`
            insert into class_seats ${tx(
              rows.class_seats,
              "resource_id",
              "resource_kind",
              "business_id",
              "capacity",
              "taken",
            )}
            on conflict (resource_id) do nothing
          `;
    const classes =
      rows.classes.length === 0
        ? none
        : await tx`
            insert into classes ${tx(
              rows.classes,
              "id",
              "business_id",
              "service_id",
              "weekday",
              "starts_at",
              "ends_at",
              "time_zone",
              "teacher_resource_id",
              "room_resource_id",
              "location_id",
              "seats",
              "minimum",
              "active",
            )}
            on conflict (id) do nothing
          `;
    const classSessions =
      rows.class_sessions.length === 0
        ? none
        : await tx`
            insert into class_sessions ${tx(
              rows.class_sessions,
              "resource_id",
              "resource_kind",
              "business_id",
              "class_id",
              "service_id",
              "during",
              "time_zone",
              "teacher_resource_id",
              "room_resource_id",
              "location_id",
              "minimum",
              "status",
              "counted_at",
              "too_few",
              "cancelled_at",
              "cancelled_by_person_id",
            )}
            on conflict (resource_id) do nothing
          `;
    const billCards =
      rows.bill_cards.length === 0
        ? none
        : await tx`
            insert into bill_cards ${tx(
              rows.bill_cards,
              "id",
              "business_id",
              "saved_by_person_id",
              "stripe_customer_id",
              "stripe_payment_method_id",
              "saved_at",
              "removed_at",
            )}
            on conflict (id) do nothing
          `;
    return {
      ranAs: who?.role ?? "",
      inserted: {
        weekly_hours: weeklyHours.count,
        resources: resources.count,
        class_seats: classSeats.count,
        classes: classes.count,
        class_sessions: classSessions.count,
        bill_cards: billCards.count,
      },
    };
  });

  const count = (table: AvailabilitySeedTable): CoreSeedTableCount => {
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
      weekly_hours: count("weekly_hours"),
      resources: count("resources"),
      class_seats: count("class_seats"),
      classes: count("classes"),
      class_sessions: count("class_sessions"),
      bill_cards: count("bill_cards"),
    },
    notSeeded: NOT_SEEDED,
    shops: plan.shops,
  };
}
