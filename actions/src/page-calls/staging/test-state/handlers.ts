// The staging-only listing call (T-574; C-074, C-205; K-21 v1 testRoster; build prompt 9.4 'Seeded state' and 'The
// test-phone page'; QUESTIONS M2-qa-frontend.6): a handler of the gateway's page entry (runtime/src/gateway/pages,
// T-266) that lists staging's seeded test businesses and test phones for the test-phone page's picker (T-525). The call,
// its request, the trace the entry opened and the Worker's ENVIRONMENT in; the call's K-21 outcome out. Read-only: it
// writes nothing, and a repeat is safe.
//
// Staging only. Wherever ENVIRONMENT is not exactly "staging", it answers K-21's stagingOnly at once: its request is not
// read and no port is reached (BP 9.4 'Never in production'; K-21 v1 README default 15; fire-now-in-production.json and
// refuse-test-roster-in-production.json). The page entry refuses it there before any handler runs (T-266); this is the
// handler's own refusal besides, as the test-phone calls keep theirs (../test-phone/handlers.ts).
//
// On staging, in this order (K-21 v1 README "Who may call" and "Staging only", "The picker"):
//   1. a page with no session token answers signInNeeded;
//   2. a request that is not K-21 v1's gives no outcome (TestStateError badRequest: the entry answers 503, nothing read);
//   3. the session, by its token's sha256 (K-22 v1 session_for_token): none live answers signInNeeded; a person neither
//      on the roster's testers nor on Rosie's team answers notTester. Nothing of the roster or the seeded rows is read
//      before this;
//   4. the roster (staging's config: Q-53; C-202) is read whole and checked: one K-21 cannot show gives no outcome
//      (badRoster), before any seeded row is read;
//   5. each test business from its seeded rows: its K-04 head (name, live, zone, its own text hours as HH:MM), its kinds
//      of work and whether it is signed up. A roster business with no head gives no outcome (notSeeded);
//   6. each test phone from its seeded rows: its last four digits (never its number, never who holds it: rule 9), its
//      role and label from the roster, the seeded person it texts as when it is an owner's or a staff member's, its
//      seeded customer at its business, whether it is a Linq contact, whether it is stopped, and its text-hours override
//      as the flag row stands (off with version null while it has no row). A phone with no K-04 row yet (one that has not
//      texted) is no Linq contact and not stopped.
//
// The call makes no K-09 call. Every read is handed the entry's trace (`trace.traceId`) as its caller's trace id, never
// the envelope's page.traceId, which is a browser value and is only shape-checked. Nothing here logs or writes a span:
// never a number, a name, a token or a row.

import type { PageHandler, PageOutcome, PageRequest } from "../../../../../runtime/src/gateway";
import { sha256Hex } from "../test-phone/ids";
import { isId, lacksSessionToken } from "../test-phone/request";
import { TestStateError } from "./errors";
import { testRosterProblems, type TestRosterRequest } from "./request";
import type {
  NotTester,
  RosterBusiness,
  RosterBusinessEntry,
  RosterFlow,
  RosterPhone,
  RosterPhoneEntry,
  RosterRole,
  SignInNeeded,
  StagingOnly,
  StagingRoster,
  TestRoster,
  TestStateCaller,
  TestStateDeps,
  TextHoursOverrideState,
} from "./types";

/** The one ENVIRONMENT this call runs in (wrangler.jsonc env.staging); any other value is refused, "" and "Staging" too. */
export const STAGING_ENVIRONMENT = "staging";

/** The call served here (K-21 v1 `$defs/stagingOnlyCall`). */
export type TestStateCall = "testRoster";

/** The handler, for the page entry's handlers (runtime/src/gateway GatewayDeps.pages). */
export interface TestStateHandlers {
  readonly testRoster: PageHandler;
}

/** The handler over its ports. */
export function createTestStateHandlers(deps: TestStateDeps): TestStateHandlers {
  return { testRoster: (page) => testRoster(page, deps) };
}

/** A roster number Linq could send to: E.164, + and 7 to 15 digits. */
const E164 = /^\+[1-9][0-9]{6,14}$/u;
/** common/formats.v1 `zone`. */
const ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/u;
/** K-09 v1 `kindId` (K-24 v1 kinds_id_form). */
const KIND_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/u;
/** A time of day as K-04's seeds write it (HH:MM) or as PostgreSQL prints it (HH:MM:SS, with or without a fraction). */
const TIME_OF_DAY = /^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9]([.][0-9]+)?)?$/u;
/** The characters of a time of day that K-21 v1 `textHours` shows: HH:MM. */
const HOUR_AND_MINUTE = 5;
/** How many of a number's last digits the picker shows (K-21 v1 `RosterPhone.last4`). */
const LAST_DIGITS = 4;

const FLOWS: readonly string[] = ["A", "B"] satisfies readonly RosterFlow[];
const ROLES: readonly string[] = [
  "owner",
  "staff",
  "customer",
  "secondCustomer",
  "stop",
] satisfies readonly RosterRole[];
/** The roles that text as a seeded person of the business's team (K-21 v1 `RosterPhone.personId`: "owner or staff"). */
const TEAM_ROLES: readonly string[] = ["owner", "staff"] satisfies readonly RosterRole[];

/** An instant as K-21's fixtures write it: RFC 3339 UTC, whole seconds, ending in Z. */
const utcSeconds = (ms: number): string => new Date(ms).toISOString().replace(/[.][0-9]+Z$/u, "Z");

const stagingOnly = (): PageOutcome => ({ error: "stagingOnly" }) satisfies StagingOnly;

const signInNeeded = (): PageOutcome => ({ error: "signInNeeded" }) satisfies SignInNeeded;

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const matches = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.test(value);

const isOneOf = (value: unknown, values: readonly string[]): boolean =>
  typeof value === "string" && values.includes(value);

const isYesOrNo = (value: unknown): value is boolean => typeof value === "boolean";

/** K-05 v1 `version`: a whole number from 1. */
const isVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/** A list of K-09 v1 kind ids. */
const isKindIds = (value: unknown): boolean =>
  Array.isArray(value) && value.every((kindId: unknown) => matches(kindId, KIND_ID));

/** K-21 v1 testRoster: staging's seeded test businesses and test phones, for a signed-in tester. */
export async function testRoster(page: PageRequest, deps: TestStateDeps): Promise<PageOutcome> {
  if (page.environment !== STAGING_ENVIRONMENT) return stagingOnly();
  if (page.call !== "testRoster") throw new TestStateError("wrongCall");
  if (lacksSessionToken(page.request)) return signInNeeded();
  const problems = testRosterProblems(page.request);
  if (problems.length > 0) throw new TestStateError("badRequest", problems);
  const request = page.request as unknown as TestRosterRequest;

  const at = utcSeconds((deps.now ?? Date.now)());
  const standing = await deps.access.standing(await sha256Hex(request.page.sessionToken), at);
  if (standing === "noSession") return signInNeeded();
  // Only an answer that says tester admits; any other is notTester.
  if (standing !== "tester") return { error: "notTester" } satisfies NotTester;

  // The entry's own trace, never the envelope's page.traceId.
  const caller: TestStateCaller = { traceId: page.trace.traceId, at };
  const roster = await deps.roster.listing(caller);
  const rosterProblems = rosterProblemsOf(roster);
  if (rosterProblems.length > 0) throw new TestStateError("badRoster", rosterProblems);

  const [businesses, phones] = await Promise.all([
    Promise.all(roster.businesses.map((entry) => businessOf(entry, deps, caller))),
    Promise.all(roster.phones.map((entry) => phoneOf(entry, deps, caller))),
  ]);
  return { result: "testRoster", businesses, phones } satisfies TestRoster;
}

/** What keeps a roster from being listed, by field only; none when K-21 v1 can show every entry. */
function rosterProblemsOf(roster: StagingRoster): string[] {
  const problems: string[] = [];
  const businessIds = new Set<string>();
  for (const entry of roster.businesses) {
    if (!isId(entry.businessId)) problems.push("a roster business has no id");
    else if (businessIds.has(entry.businessId)) problems.push("a roster business is named twice");
    else businessIds.add(entry.businessId);
    if (!isOneOf(entry.flow, FLOWS)) problems.push("a roster business's flow is not A or B");
  }
  const phoneIds = new Set<string>();
  for (const entry of roster.phones) {
    if (!isId(entry.testPhoneId)) problems.push("a roster phone has no id");
    else if (phoneIds.has(entry.testPhoneId)) problems.push("a roster phone is named twice");
    else phoneIds.add(entry.testPhoneId);
    if (!matches(entry.number, E164)) problems.push("a roster phone's number is not E.164");
    if (!isOneOf(entry.role, ROLES)) problems.push("a roster phone's role is not one K-21 v1 names");
    if (!isText(entry.label)) problems.push("a roster phone has no label");
    if (entry.businessId !== null && !businessIds.has(entry.businessId))
      problems.push("a roster phone is seated at a business the roster does not name");
  }
  return problems;
}

/** A time of day as K-21 v1 `textHours` shows it (HH:MM), or null when the column is no time of day. */
const hourAndMinute = (value: unknown): string | null =>
  matches(value, TIME_OF_DAY) ? value.slice(0, HOUR_AND_MINUTE) : null;

/** One test business from its seeded rows. */
async function businessOf(
  entry: RosterBusinessEntry,
  deps: TestStateDeps,
  caller: TestStateCaller,
): Promise<RosterBusiness> {
  const row = await deps.seeded.business(entry.businessId, caller);
  if (row === null) throw new TestStateError("notSeeded");
  const [kindIds, signedUp] = await Promise.all([
    deps.seeded.kindIds(entry.businessId, caller),
    deps.seeded.signedUp(entry.businessId, caller),
  ]);

  const start = hourAndMinute(row.textHoursStart);
  const end = hourAndMinute(row.textHoursEnd);
  const problems: string[] = [];
  if (row.id !== entry.businessId) problems.push("businesses.id is not the id asked for");
  if (!isText(row.name)) problems.push("businesses.name is empty");
  if (!isText(row.status)) problems.push("businesses.status is empty");
  if (!matches(row.timeZone, ZONE)) problems.push("businesses.time_zone is not a zone name");
  if (start === null) problems.push("businesses.text_hours_start is not a time of day");
  if (end === null) problems.push("businesses.text_hours_end is not a time of day");
  if (!isKindIds(kindIds)) problems.push("a kind of work's id is not a kind id");
  if (!isYesOrNo(signedUp)) problems.push("signed up is not yes or no");
  if (problems.length > 0 || start === null || end === null)
    throw new TestStateError("badSeededRow", problems);

  return {
    businessId: entry.businessId,
    name: row.name,
    flow: entry.flow,
    kindIds: [...kindIds],
    signedUp,
    live: row.status === "live",
    zone: row.timeZone,
    textHours: { start, end },
  };
}

/** One test phone from its seeded rows: its number never leaves but as its last four digits. */
async function phoneOf(
  entry: RosterPhoneEntry,
  deps: TestStateDeps,
  caller: TestStateCaller,
): Promise<RosterPhone> {
  const [row, override, personId, customer] = await Promise.all([
    deps.seeded.phone(entry.number, caller),
    deps.seeded.textHoursOverride(entry.number, caller),
    TEAM_ROLES.includes(entry.role) ? deps.seeded.person(entry.number, caller) : null,
    entry.businessId === null ? null : deps.seeded.customer(entry.number, entry.businessId, caller),
  ]);

  const problems: string[] = [];
  if (row !== null) {
    if (!isYesOrNo(row.stopped)) problems.push("phones.stopped is not yes or no");
    const added: unknown = row.linqContactAddedAt;
    if (added !== null && typeof added !== "string" && !(added instanceof Date))
      problems.push("phones.linq_contact_added_at is not a time or null");
  }
  if (override !== null) {
    if (!isYesOrNo(override.enabled)) problems.push("release_flags.enabled is not yes or no");
    if (!isVersion(override.version)) problems.push("release_flags.version is not a row version");
  }
  if (personId !== null && !isId(personId)) problems.push("the seeded person's id is not an id");
  if (customer !== null) {
    if (!isId(customer.id)) problems.push("customers.id is not an id");
    if (!isText(customer.name)) problems.push("customers.name is empty");
  }
  if (problems.length > 0) throw new TestStateError("badSeededRow", problems);

  const textHoursOverride: TextHoursOverrideState =
    override === null ? { on: false, version: null } : { on: override.enabled, version: override.version };
  return {
    testPhoneId: entry.testPhoneId,
    last4: entry.number.slice(-LAST_DIGITS),
    role: entry.role,
    label: entry.label,
    businessId: entry.businessId,
    personId,
    seededCustomer: customer === null ? null : { customerId: customer.id, name: customer.name },
    linqContact: row !== null && row.linqContactAddedAt !== null,
    stopped: row?.stopped === true,
    textHoursOverride,
  };
}
