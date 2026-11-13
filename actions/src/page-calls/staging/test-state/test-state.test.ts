// T-574: the staging-only listing call against K-21 v1. The card's proofs:
//   1. test-roster.json's response comes back from seeded rows: the frozen contracts' own seed rows handed through the
//      ports, and K-21 v1 accepts the exchange;
//   2. wherever ENVIRONMENT is not exactly "staging", production first, the call answers K-21's only answer there,
//      stagingOnly (the pattern of refuse-fire-now-in-production.json), with the request, the trace and every port behind
//      a tripwire untouched.
// Beside them: the sign-in and tester checks, a request K-21 refuses, staging as its seeds leave it before the setup and
// customer seeds (CQ-14), a roster or a row K-21 cannot show, the entry's trace id as every read's caller, and no log
// line at all. No network, no database and no key.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PageRequest } from "../../../../../runtime/src/gateway";
import { isLabel } from "../../../../../runtime/src/trace";
import { STAGING_ENVIRONMENT as TEST_PHONE_STAGING } from "../test-phone/handlers";
import { sha256Hex } from "../test-phone/ids";
import {
  FIRE_NOW_IN_PRODUCTION,
  ROSTER_FIXTURE,
  TESTER_TOKEN,
  fakeAccess,
  k21Fixture,
  k21Problems,
  pageRequest,
  tripwire,
} from "../test-phone/test-support";
import type { TesterStanding } from "../test-phone/types";
import { TestStateError } from "./errors";
import { STAGING_ENVIRONMENT, createTestStateHandlers, testRoster } from "./handlers";
import {
  ROSTER_OUTCOME,
  fakeRoster,
  fakeSeeded,
  fixtureRoster,
  fixtureRows,
  numberOf,
  type RosterOutcome,
  type StagingRows,
} from "./test-support";
import type { RosterPhoneEntry, StagingRoster, TestStateDeps } from "./types";

const NOW = ROSTER_FIXTURE.given.now;
const ENVELOPE_TRACE = (ROSTER_FIXTURE.request.page as { traceId: string }).traceId;
const BARBERSHOP = "biz-lees-barbershop";
const NUMBERS = ROSTER_OUTCOME.phones.map((phone) => numberOf(phone.last4));

async function standings(entries: [string, TesterStanding][]): Promise<Map<string, TesterStanding>> {
  const hashed = await Promise.all(
    entries.map(async ([token, standing]) => [await sha256Hex(token), standing] as const),
  );
  return new Map(hashed);
}

/** The tester of K-21 v1's staging fixtures, signed in. */
const testerAccess = async (): Promise<ReturnType<typeof fakeAccess>> =>
  fakeAccess(await standings([[TESTER_TOKEN, "tester"]]));

/** The ports over a roster and its seeded rows, for the signed-in tester at the fixture's moment. */
async function stagingDeps(
  roster: StagingRoster = fixtureRoster(),
  rows: StagingRows = fixtureRows(),
): Promise<{
  deps: TestStateDeps;
  access: ReturnType<typeof fakeAccess>;
  roster: ReturnType<typeof fakeRoster>;
  seeded: ReturnType<typeof fakeSeeded>;
}> {
  const access = await testerAccess();
  const rosterPort = fakeRoster(roster);
  const seeded = fakeSeeded(rows);
  return {
    deps: { access, roster: rosterPort, seeded, now: () => Date.parse(NOW) },
    access,
    roster: rosterPort,
    seeded,
  };
}

/** test-roster.json's request with another session token, or none. */
const withToken = (token: string | null): Record<string, unknown> => ({
  page: { ...(ROSTER_FIXTURE.request.page as Record<string, unknown>), sessionToken: token },
});

/** The roster with one phone's entry changed. */
function withPhone(testPhoneId: string, changes: Partial<RosterPhoneEntry>): StagingRoster {
  const roster = fixtureRoster();
  return {
    businesses: roster.businesses,
    phones: roster.phones.map((phone) =>
      phone.testPhoneId === testPhoneId ? { ...phone, ...changes } : phone,
    ),
  };
}

/** What a call that gives no outcome threw. */
const failureOf = (answer: Promise<unknown>): Promise<unknown> =>
  answer.then(
    () => null,
    (error: unknown) => error,
  );

let logSpies: unknown[] = [];

beforeEach(() => {
  logSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  // Nothing here logs: never a number, a name, a token or a row.
  for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("test-roster.json's response comes back from seeded rows", () => {
  it("lists the two test businesses and the five test phones from the contracts' seed rows, and K-21 v1 accepts the exchange", async () => {
    const { deps, access, roster, seeded } = await stagingDeps();
    const page = pageRequest("testRoster", ROSTER_FIXTURE.request);

    const answer = await createTestStateHandlers(deps).testRoster(page);

    expect(answer).toEqual(ROSTER_FIXTURE.outcome);
    expect(k21Problems({ ...ROSTER_FIXTURE, outcome: answer })).toEqual([]);
    expect(k21Problems(answer, "testRoster.response")).toEqual([]);
    // The session was asked for by its token's sha256 at the call's moment; the roster was read once.
    expect(access.asked).toEqual([{ tokenSha256: await sha256Hex(TESTER_TOKEN), at: NOW }]);
    expect(roster.asked).toHaveLength(1);
    // Each business's head, kinds and sign-up, and each phone's row and override, were read once.
    const keysOf = (read: string): string[] =>
      seeded.asked.filter((asked) => asked.read === read).map((asked) => asked.key);
    const businessIds = ROSTER_OUTCOME.businesses.map((business) => business.businessId);
    expect(keysOf("business")).toEqual(businessIds);
    expect(keysOf("kindIds")).toEqual(businessIds);
    expect(keysOf("signedUp")).toEqual(businessIds);
    expect(keysOf("phone")).toEqual(NUMBERS);
    expect(keysOf("textHoursOverride")).toEqual(NUMBERS);
    // The seeded person only of the phones that text as an owner or a staff member; the seeded customer of every phone
    // seated at a business, at that business; nothing of either for the STOP phone, which is seated at none.
    expect(keysOf("person")).toEqual([numberOf("0100"), numberOf("0102")]);
    expect(keysOf("customer")).toEqual(
      ["0100", "0102", "0101", "0104"].map((last4) => `${numberOf(last4)} ${BARBERSHOP}`),
    );
  });

  it("hands every read the entry's own trace id as its caller's, never the envelope's page.traceId", async () => {
    const { deps, roster, seeded } = await stagingDeps();
    const page = pageRequest("testRoster", ROSTER_FIXTURE.request);

    await testRoster(page, deps);

    const caller = { traceId: page.trace.traceId, at: NOW };
    expect(page.trace.traceId).not.toBe(ENVELOPE_TRACE);
    expect(roster.asked).toEqual([caller]);
    expect(seeded.asked.length).toBeGreaterThan(0);
    for (const asked of seeded.asked) expect(asked.caller).toEqual(caller);
    expect(JSON.stringify([roster.asked, seeded.asked])).not.toContain(ENVELOPE_TRACE);
  });

  it("shows a phone by its last four digits only: no number is in the answer", async () => {
    const { deps } = await stagingDeps();
    const answer = JSON.stringify(await testRoster(pageRequest("testRoster", ROSTER_FIXTURE.request), deps));
    for (const number of NUMBERS) {
      expect(answer).not.toContain(number);
      expect(answer).not.toContain(number.slice(2));
    }
    expect(answer).not.toContain(TESTER_TOKEN);
  });

  it("is a read: a repeat answers the same, and the rows are as they were", async () => {
    const rows = fixtureRows();
    const before = structuredClone(rows);
    const { deps } = await stagingDeps(fixtureRoster(), rows);
    const first = await testRoster(pageRequest("testRoster", ROSTER_FIXTURE.request), deps);
    const repeat = await testRoster(pageRequest("testRoster", ROSTER_FIXTURE.request), deps);
    expect(repeat).toEqual(first);
    expect(rows).toEqual(before);
  });
});

describe("outside staging the call answers stagingOnly and reaches nothing", () => {
  // The Worker's ENVIRONMENT is "production" there; any value but exactly "staging" is refused the same way.
  const ELSEWHERE = ["production", "", "Staging", "STAGING", "staging ", " staging", "preview", "test"];

  it.each(ELSEWHERE)(
    "testRoster with ENVIRONMENT %j answers stagingOnly, reading nothing and reaching no port",
    async (environment) => {
      const touched: string[] = [];
      const deps: TestStateDeps = tripwire("deps", touched);
      const page: PageRequest = {
        call: "testRoster",
        request: tripwire("request", touched),
        trace: tripwire("trace", touched),
        environment,
      };

      const answer = await createTestStateHandlers(deps).testRoster(page);

      // K-21's one answer outside staging, as fire-now-in-production.json gives it for every staging-only call.
      expect(answer).toEqual(FIRE_NOW_IN_PRODUCTION.outcome);
      expect(answer).toEqual({ error: "stagingOnly" });
      expect(touched).toEqual([]);
      // K-21 v1 accepts it as the call's production outcome, and refuses the fixture's staging answer there (the pattern
      // of invalid/refuse-fire-now-in-production.json).
      const production = { ...ROSTER_FIXTURE, given: { ...ROSTER_FIXTURE.given, environment: "production" } };
      expect(k21Problems({ ...production, outcome: answer })).toEqual([]);
      expect(k21Problems(production)).not.toEqual([]);
    },
  );

  it.each(ELSEWHERE)(
    "with ENVIRONMENT %j each port apart stays untouched, a signed-in tester's request included",
    async (environment) => {
      const touched: string[] = [];
      const deps: TestStateDeps = {
        access: tripwire("access", touched),
        roster: tripwire("roster", touched),
        seeded: tripwire("seeded", touched),
        now: () => {
          touched.push("now");
          return Date.parse(NOW);
        },
      };
      const answer = await testRoster(pageRequest("testRoster", ROSTER_FIXTURE.request, environment), deps);
      expect(answer).toEqual({ error: "stagingOnly" });
      expect(touched).toEqual([]);
    },
  );

  it("the refused fixtures' pattern holds: K-21 v1 refuses a listing and a Fire now answered in production, and accepts their fixed twins", () => {
    expect(k21Problems(k21Fixture("invalid/refuse-fire-now-in-production.json"))).not.toEqual([]);
    expect(k21Problems(FIRE_NOW_IN_PRODUCTION)).toEqual([]);
    const refused = k21Fixture("invalid/refuse-test-roster-in-production.json");
    expect(refused.call).toBe("testRoster");
    expect(k21Problems(refused)).not.toEqual([]);
    expect(k21Problems({ ...refused, outcome: { error: "stagingOnly" } })).toEqual([]);
    expect(k21Problems(ROSTER_FIXTURE)).toEqual([]);
  });

  it("the handler's own staging is exactly the Worker's staging ENVIRONMENT, as the test-phone calls'", () => {
    expect(STAGING_ENVIRONMENT).toBe("staging");
    expect(STAGING_ENVIRONMENT).toBe(TEST_PHONE_STAGING);
  });
});

describe("who may call: a signed-in roster tester or a person on Rosie's team", () => {
  async function checkedDeps(
    standing: [string, TesterStanding][],
    touched: string[],
  ): Promise<TestStateDeps> {
    return {
      access: fakeAccess(await standings(standing)),
      roster: tripwire("roster", touched),
      seeded: tripwire("seeded", touched),
      now: () => Date.parse(NOW),
    };
  }

  it("with no session token answers signInNeeded, asking no one", async () => {
    const touched: string[] = [];
    const deps: TestStateDeps = { ...(await checkedDeps([], touched)), access: tripwire("access", touched) };
    for (const request of [withToken(null), { page: { requestId: "req-1", traceId: "t-1" } }]) {
      const answer = await testRoster(pageRequest("testRoster", request), deps);
      expect(answer).toEqual({ error: "signInNeeded" });
      expect(k21Problems(answer, "testRoster.errors")).toEqual([]);
    }
    expect(touched).toEqual([]);
  });

  it("with a token no live session has answers signInNeeded, reading no roster and no row", async () => {
    const touched: string[] = [];
    const deps = await checkedDeps([[TESTER_TOKEN, "tester"]], touched);
    const answer = await testRoster(
      pageRequest("testRoster", withToken("placeholder-session-token-ended-0009")),
      deps,
    );
    expect(answer).toEqual({ error: "signInNeeded" });
    expect(touched).toEqual([]);
  });

  it("for a person neither on the roster's testers nor on Rosie's team answers notTester, reading no roster and no row", async () => {
    const touched: string[] = [];
    const deps = await checkedDeps([[TESTER_TOKEN, "notTester"]], touched);
    const answer = await testRoster(pageRequest("testRoster", ROSTER_FIXTURE.request), deps);
    expect(answer).toEqual({ error: "notTester" });
    expect(k21Problems(answer, "testRoster.errors")).toEqual([]);
    expect(k21Problems({ ...ROSTER_FIXTURE, outcome: answer })).toEqual([]);
    expect(touched).toEqual([]);
  });

  it("admits only a session the access port says is a tester's: any other answer is notTester", async () => {
    const touched: string[] = [];
    const deps: TestStateDeps = {
      ...(await checkedDeps([], touched)),
      access: { standing: () => Promise.resolve("maybe" as TesterStanding) },
    };
    expect(await testRoster(pageRequest("testRoster", ROSTER_FIXTURE.request), deps)).toEqual({
      error: "notTester",
    });
    expect(touched).toEqual([]);
  });

  it("hands the access port the token's sha256, never the token", async () => {
    const access = fakeAccess(new Map());
    const touched: string[] = [];
    await testRoster(pageRequest("testRoster", ROSTER_FIXTURE.request), {
      ...(await checkedDeps([], touched)),
      access,
    });
    expect(access.asked).toHaveLength(1);
    expect(access.asked[0]?.tokenSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(access.asked)).not.toContain(TESTER_TOKEN);
  });
});

describe("a request that is not K-21 v1's gives no outcome", () => {
  const PAGE = ROSTER_FIXTURE.request.page as Record<string, unknown>;
  const CASES: [string, Record<string, unknown>][] = [
    ["a field K-21 does not name", { ...ROSTER_FIXTURE.request, testPhoneId: "tp-03" }],
    ["a browser value naming a business", { ...ROSTER_FIXTURE.request, businessId: BARBERSHOP }],
    ["a session token too short to be one", { page: { ...PAGE, sessionToken: "short-token" } }],
    ["no request id", { page: { ...PAGE, requestId: "" } }],
    ["a link code that is none", { page: { ...PAGE, linkCode: "no" } }],
    ["a page naming a person", { page: { ...PAGE, personId: "person-sam" } }],
  ];

  it.each(CASES)(
    "%s: TestStateError badRequest, naming fields only, before any port",
    async (_name, request) => {
      const touched: string[] = [];
      const deps: TestStateDeps = tripwire("deps", touched);

      const failure = await failureOf(testRoster(pageRequest("testRoster", request), deps));

      expect(failure).toBeInstanceOf(TestStateError);
      const error = failure as TestStateError;
      expect(error.code).toBe("badRequest");
      expect(error.problems.length).toBeGreaterThan(0);
      expect(isLabel(error.name)).toBe(true);
      for (const value of ["tp-03", BARBERSHOP, "short-token", "person-sam", "personId", TESTER_TOKEN])
        expect(`${error.message} ${error.problems.join(" ")}`).not.toContain(value);
      expect(touched).toEqual([]);
    },
  );

  it("a handler handed another call's request gives no outcome (a wiring fault)", async () => {
    const deps: TestStateDeps = tripwire("deps", []);
    await expect(
      testRoster(pageRequest("testPhoneParts", ROSTER_FIXTURE.request), deps),
    ).rejects.toMatchObject({
      name: "TestStateError",
      code: "wrongCall",
    });
  });
});

describe("the listing shows staging as its seeds leave it", () => {
  /** The answer over a roster and rows, held to K-21 v1. */
  async function listed(roster: StagingRoster, rows: StagingRows): Promise<RosterOutcome> {
    const { deps } = await stagingDeps(roster, rows);
    const answer = await testRoster(pageRequest("testRoster", ROSTER_FIXTURE.request), deps);
    expect(k21Problems(answer, "testRoster.response")).toEqual([]);
    expect(k21Problems({ ...ROSTER_FIXTURE, outcome: answer })).toEqual([]);
    return answer as unknown as RosterOutcome;
  }

  it("before the setup and customer seeds (CQ-14): not signed up, not live, no kinds, no seeded customer, no Linq contact", async () => {
    // T-202's and T-1148's rows alone: business heads at the table's defaults, a phone row with only its number for the
    // seeded phones, and none at all for test owner 1, whose number has not texted yet.
    const rows = fixtureRows();
    rows.businesses = rows.businesses.map((row) => ({ ...row, status: "offline" }));
    rows.kindIds = new Map();
    rows.signedUp = new Set();
    rows.customers = [];
    rows.overrides = new Map();
    rows.phones = new Map(
      NUMBERS.filter((number) => number !== numberOf("0100")).map((number) => [
        number,
        { stopped: false, linqContactAddedAt: null },
      ]),
    );

    const answer = await listed(fixtureRoster(), rows);

    expect(answer.businesses).toEqual(
      ROSTER_OUTCOME.businesses.map((business) => ({
        ...business,
        kindIds: [],
        signedUp: false,
        live: false,
      })),
    );
    expect(answer.phones).toEqual(
      ROSTER_OUTCOME.phones.map((phone) => ({
        ...phone,
        seededCustomer: null,
        linqContact: false,
        stopped: false,
        textHoursOverride: { on: false, version: null },
      })),
    );
  });

  it("a business's own text hours come back as HH:MM, whether the row prints them with seconds or as the seeds write them", async () => {
    const rows = fixtureRows();
    const [barbershop, homeServices] = rows.businesses;
    if (barbershop === undefined || homeServices === undefined) throw new Error("two businesses are seeded");
    rows.businesses = [
      { ...barbershop, textHoursStart: "07:30:00", textHoursEnd: "21:15:00.000" },
      { ...homeServices, textHoursStart: "09:00", textHoursEnd: "17:45" },
    ];
    const answer = await listed(fixtureRoster(), rows);
    expect(answer.businesses.map((business) => business.textHours)).toEqual([
      { start: "07:30", end: "21:15" },
      { start: "09:00", end: "17:45" },
    ]);
  });

  it("a business that is saved but not live shows as not live; its zone is its row's", async () => {
    const rows = fixtureRows();
    rows.businesses = rows.businesses.map((row, index) =>
      index === 1 ? { ...row, status: "saved", timeZone: "America/Chicago" } : row,
    );
    const answer = await listed(fixtureRoster(), rows);
    expect(answer.businesses.map((business) => [business.live, business.zone])).toEqual([
      [true, "America/New_York"],
      [false, "America/Chicago"],
    ]);
  });

  it("a stopped phone shows as stopped; an override row that is off keeps its version; one that is on shows on", async () => {
    const rows = fixtureRows();
    const stop = numberOf("0105");
    rows.phones.set(stop, { stopped: true, linqContactAddedAt: "2026-10-19T14:00:00Z" });
    rows.overrides.set(stop, { enabled: false, version: 2 });
    rows.overrides.set(numberOf("0101"), { enabled: true, version: 1 });

    const answer = await listed(fixtureRoster(), rows);

    const byId = new Map(answer.phones.map((phone) => [phone.testPhoneId, phone]));
    expect(byId.get("tp-05")).toMatchObject({
      stopped: true,
      linqContact: true,
      textHoursOverride: { on: false, version: 2 },
    });
    expect(byId.get("tp-03")?.textHoursOverride).toEqual({ on: true, version: 1 });
    expect(byId.get("tp-02")?.textHoursOverride).toEqual({ on: true, version: 3 });
    expect(byId.get("tp-01")).toMatchObject({
      stopped: false,
      textHoursOverride: { on: false, version: null },
    });
  });

  it("the seeded person is listed only for an owner's or a staff member's phone, and only when one person writes from it", async () => {
    const rows = fixtureRows();
    // Alex writes from tp-03's number and Riley from tp-02's; a second writer from tp-02's number leaves it unnamed.
    expect(rows.persons.get(numberOf("0101"))).toEqual(["person-alex"]);
    rows.persons.set(numberOf("0102"), ["person-riley", "person-avery"]);
    const answer = await listed(fixtureRoster(), rows);
    expect(answer.phones.map((phone) => [phone.role, phone.personId])).toEqual([
      ["owner", "person-sam"],
      ["staff", null],
      ["customer", null],
      ["secondCustomer", null],
      ["stop", null],
    ]);
  });

  it("a seeded customer is listed for any phone that has one at its business, by the row's id and name", async () => {
    const rows = fixtureRows();
    rows.customers.push({
      number: numberOf("0104"),
      businessId: BARBERSHOP,
      id: "customer-maya-barbershop",
      name: "Maya",
    });
    // A customer row at another business is not the phone's seeded customer at its own.
    rows.customers.push({
      number: numberOf("0102"),
      businessId: "biz-lee-home-services",
      id: "customer-riley-home",
      name: "Riley",
    });
    const answer = await listed(fixtureRoster(), rows);
    expect(answer.phones.map((phone) => phone.seededCustomer)).toEqual([
      null,
      null,
      { customerId: "customer-alex-barbershop", name: "Alex M." },
      { customerId: "customer-maya-barbershop", name: "Maya" },
      null,
    ]);
  });

  it("the lists keep the roster's order, and an empty roster lists nothing", async () => {
    const roster = fixtureRoster();
    const reversed: StagingRoster = {
      businesses: [...roster.businesses].reverse(),
      phones: [...roster.phones].reverse(),
    };
    const answer = await listed(reversed, fixtureRows());
    expect(answer.businesses).toEqual([...ROSTER_OUTCOME.businesses].reverse());
    expect(answer.phones).toEqual([...ROSTER_OUTCOME.phones].reverse());

    expect(await listed({ businesses: [], phones: [] }, fixtureRows())).toEqual({
      result: "testRoster",
      businesses: [],
      phones: [],
    });
  });
});

describe("a roster or a row K-21 v1 cannot show gives no outcome", () => {
  const ROSTER = fixtureRoster();
  const BAD_ROSTERS: [string, StagingRoster][] = [
    ["a phone's number is not E.164", withPhone("tp-03", { number: "555-0101" })],
    ["a phone's number has a space", withPhone("tp-03", { number: "+1555555 0101" })],
    ["a phone's role is none of K-21's", withPhone("tp-03", { role: "tester" as never })],
    ["a phone has no label", withPhone("tp-03", { label: "" })],
    ["a phone has no id", withPhone("tp-03", { testPhoneId: "" })],
    ["a phone is named twice", { ...ROSTER, phones: [...ROSTER.phones, ...ROSTER.phones.slice(0, 1)] }],
    [
      "a phone is seated at a business the roster does not name",
      withPhone("tp-03", { businessId: "biz-movers" }),
    ],
    [
      "a business's flow is neither A nor B",
      { ...ROSTER, businesses: [{ businessId: BARBERSHOP, flow: "C" as never }] },
    ],
    [
      "a business has no id",
      { ...ROSTER, businesses: [...ROSTER.businesses, { businessId: "", flow: "A" }] },
    ],
    ["a business is named twice", { ...ROSTER, businesses: [...ROSTER.businesses, ...ROSTER.businesses] }],
  ];

  it.each(BAD_ROSTERS)(
    "%s: TestStateError badRoster, before any seeded row is read",
    async (_name, roster) => {
      const touched: string[] = [];
      const deps: TestStateDeps = {
        access: await testerAccess(),
        roster: fakeRoster(roster),
        seeded: tripwire("seeded", touched),
        now: () => Date.parse(NOW),
      };

      const failure = await failureOf(testRoster(pageRequest("testRoster", ROSTER_FIXTURE.request), deps));

      expect(failure).toBeInstanceOf(TestStateError);
      const error = failure as TestStateError;
      expect(error.code).toBe("badRoster");
      expect(error.problems.length).toBeGreaterThan(0);
      for (const value of ["555-0101", "0101", "tester", "biz-movers", BARBERSHOP, "tp-03"])
        expect(`${error.message} ${error.problems.join(" ")}`).not.toContain(value);
      expect(touched).toEqual([]);
    },
  );

  it("a roster business with no seeded head: TestStateError notSeeded", async () => {
    const rows = fixtureRows();
    rows.businesses = rows.businesses.slice(0, 1);
    const { deps } = await stagingDeps(fixtureRoster(), rows);
    const failure = await failureOf(testRoster(pageRequest("testRoster", ROSTER_FIXTURE.request), deps));
    expect(failure).toBeInstanceOf(TestStateError);
    expect(failure).toMatchObject({ code: "notSeeded", message: "notSeeded" });
  });

  const BAD_ROWS: [string, (rows: StagingRows) => void][] = [
    [
      "text hours that are no time of day",
      (rows) => {
        rows.businesses = rows.businesses.map((row) => ({ ...row, textHoursStart: "8am" }));
      },
    ],
    [
      "text hours past the day's end",
      (rows) => {
        rows.businesses = rows.businesses.map((row) => ({ ...row, textHoursEnd: "24:00:00" }));
      },
    ],
    [
      "a zone that is no zone name",
      (rows) => {
        rows.businesses = rows.businesses.map((row) => ({ ...row, timeZone: "New York time" }));
      },
    ],
    [
      "a business with no name",
      (rows) => {
        rows.businesses = rows.businesses.map((row) => ({ ...row, name: "" }));
      },
    ],
    [
      "a kind of work's id that is no kind id",
      (rows) => {
        rows.kindIds.set(BARBERSHOP, ["Barber Shop"]);
      },
    ],
    [
      "an override row with no version",
      (rows) => {
        rows.overrides.set(numberOf("0101"), { enabled: true, version: 0 });
      },
    ],
    [
      "an override row that is neither on nor off",
      (rows) => {
        rows.overrides.set(numberOf("0101"), { enabled: "yes" as never, version: 1 });
      },
    ],
    [
      "a phone row that is neither stopped nor not",
      (rows) => {
        rows.phones.set(numberOf("0101"), { stopped: null as never, linqContactAddedAt: null });
      },
    ],
    [
      "a phone row with no Linq contact column",
      (rows) => {
        rows.phones.set(numberOf("0101"), { stopped: false } as never);
      },
    ],
    [
      "a customer with no name",
      (rows) => {
        rows.customers = rows.customers.map((row) => ({ ...row, name: "" }));
      },
    ],
    [
      "a customer with no id",
      (rows) => {
        rows.customers = rows.customers.map((row) => ({ ...row, id: "" }));
      },
    ],
    [
      "a seeded person with no id",
      (rows) => {
        rows.persons.set(numberOf("0100"), [""]);
      },
    ],
  ];

  it.each(BAD_ROWS)("%s: TestStateError badSeededRow, naming columns only", async (_name, change) => {
    const rows = fixtureRows();
    change(rows);
    const { deps } = await stagingDeps(fixtureRoster(), rows);

    const failure = await failureOf(testRoster(pageRequest("testRoster", ROSTER_FIXTURE.request), deps));

    expect(failure).toBeInstanceOf(TestStateError);
    const error = failure as TestStateError;
    expect(error.code).toBe("badSeededRow");
    expect(error.problems.length).toBeGreaterThan(0);
    expect(isLabel(error.name)).toBe(true);
    for (const value of ["8am", "24:00", "New York time", "Barber Shop", "Alex", "Lee", ...NUMBERS])
      expect(`${error.message} ${error.problems.join(" ")}`).not.toContain(value);
  });

  it("a head that is another business's: TestStateError badSeededRow", async () => {
    const { deps, seeded } = await stagingDeps();
    const crossed: TestStateDeps = {
      ...deps,
      seeded: {
        business: (_businessId, caller) => seeded.business(BARBERSHOP, caller),
        kindIds: (businessId, caller) => seeded.kindIds(businessId, caller),
        signedUp: (businessId, caller) => seeded.signedUp(businessId, caller),
        phone: (number, caller) => seeded.phone(number, caller),
        textHoursOverride: (number, caller) => seeded.textHoursOverride(number, caller),
        person: (number, caller) => seeded.person(number, caller),
        customer: (number, businessId, caller) => seeded.customer(number, businessId, caller),
      },
    };
    const failure = await failureOf(testRoster(pageRequest("testRoster", ROSTER_FIXTURE.request), crossed));
    expect(failure).toBeInstanceOf(TestStateError);
    expect(failure).toMatchObject({ code: "badSeededRow" });
  });

  it("a port that fails gives no outcome: the failure is the port's own, and nothing is answered", async () => {
    const { deps } = await stagingDeps();
    const failing: TestStateDeps = {
      ...deps,
      seeded: { ...deps.seeded, phone: () => Promise.reject(new Error("no database is bound")) },
    };
    await expect(testRoster(pageRequest("testRoster", ROSTER_FIXTURE.request), failing)).rejects.toThrow(
      "no database is bound",
    );
    const noRoster: TestStateDeps = {
      ...deps,
      roster: { listing: () => Promise.reject(new Error("no roster is bound")) },
    };
    await expect(testRoster(pageRequest("testRoster", ROSTER_FIXTURE.request), noRoster)).rejects.toThrow(
      "no roster is bound",
    );
  });
});
