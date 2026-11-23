// T-321's staff proofs (the card's "Proves it with"), on K-22 v1's seed rows (seed-staff-invited, seed-staff-joined) and
// the master's own examples, through an in-memory reader, never a database:
//   - a stopped staff member is never offered as bookable (S2-08);
//   - an admin without the fee power is not the decider for a refund beyond the terms (S13-31; S13-45 row 8; RULES 3.10),
//     through the identity-and-access base (T-308) with teamAdminPowers over K-22's team powers.
// And the reads around them: each member's status (invited, joined, stopped, removed), who is offered, each admin's
// powers, one business per service, and answers that carry ids, labels and the owner's amounts only.

import { describe, expect, it } from "vitest";

import { ADMIN_POWERS } from "../facts";
import { BUSINESS_MATTERS, OWNER_ONLY_MATTERS, createIdentityAccess } from "../identity-access";
import {
  BARBERSHOP,
  HOME_SERVICES,
  YOGA_STUDIO,
  readerOf,
  recordOf,
  seedRecord,
  seedRows,
  stringsIn,
} from "../test-support";
import {
  STAFF_STATUSES,
  StaffReadError,
  TEAM_POWERS,
  createStaffAccess,
  teamAdminPowers,
  type StaffAccess,
  type StaffOnFile,
  type TeamPower,
} from "./staff";
import {
  STAFF_SEEDS,
  endPower,
  givePower,
  leakyStaffReaderOf,
  removed,
  seedTeam,
  staffReaderOf,
  stopped,
  withStaff,
  withStatus,
  type TeamAsked,
  type TeamRecord,
} from "./test-support";

const TEAM = seedTeam();

const PAT = "staff-pat-home-services";
const JORDAN = "staff-jordan-home-services";
const CASEY = "staff-casey-home-services";
const RILEY = "staff-riley-barbershop";

function staffAt(businessId: string, record: TeamRecord = TEAM): StaffAccess {
  return createStaffAccess({ businessId, reader: staffReaderOf(record) });
}

/** The identity-and-access base at Lee Home Services, its admins' powers read from K-22's team rows. */
function homeServicesIdentity(team: TeamRecord) {
  return createIdentityAccess({
    businessId: HOME_SERVICES,
    reader: readerOf(seedRecord()),
    adminPowers: teamAdminPowers(staffReaderOf(team)),
  });
}

const SAM_OWNER = { personId: "person-sam", as: "owner" } as const;
const PAT_ADMIN = { personId: "person-pat", as: "admin" } as const;

describe("staff status (K-22 v1 staff.status; FS line 723)", () => {
  it("reads each member's status from the seeds: Pat invited, Jordan and Casey joined, Riley joined", async () => {
    const homeServices = staffAt(HOME_SERVICES);
    expect(await homeServices.statusOf("person-pat")).toBe("invited");
    expect(await homeServices.statusOf("person-jordan")).toBe("joined");
    expect(await homeServices.statusOf("person-casey")).toBe("joined");
    expect(await staffAt(BARBERSHOP).statusOf("person-riley")).toBe("joined");
  });

  it("a person with no staff row here has no status: the owner, a customer, staff of another business", async () => {
    const homeServices = staffAt(HOME_SERVICES);
    expect(await homeServices.statusOf("person-sam")).toBeNull();
    expect(await homeServices.statusOf("person-alex")).toBeNull();
    expect(await homeServices.statusOf("person-riley")).toBeNull();
    expect(await homeServices.member("person-sam")).toBeNull();
    expect(await staffAt(YOGA_STUDIO).team()).toEqual([]);
  });

  it("the team is this business's members only, every status, by person, with what each may be offered and OK", async () => {
    expect(await staffAt(HOME_SERVICES).team()).toEqual([
      { staffId: CASEY, personId: "person-casey", status: "joined", bookable: true, powers: [] },
      { staffId: JORDAN, personId: "person-jordan", status: "joined", bookable: true, powers: [] },
      {
        staffId: PAT,
        personId: "person-pat",
        status: "invited",
        bookable: false,
        powers: [{ power: "prices", over: { cents: 50000, currency: "USD" } }],
      },
    ]);
    expect(await staffAt(BARBERSHOP).team()).toEqual([
      { staffId: RILEY, personId: "person-riley", status: "joined", bookable: true, powers: [] },
    ]);
  });

  it("each of K-22's four statuses reads as written: a STOP, a START and a removal", async () => {
    const record = removed(stopped(TEAM, JORDAN), CASEY);
    const homeServices = staffAt(HOME_SERVICES, record);
    expect(await homeServices.statusOf("person-jordan")).toBe("stopped");
    expect(await homeServices.statusOf("person-casey")).toBe("removed");
    expect(await homeServices.statusOf("person-pat")).toBe("invited");
    const started = withStatus(record, JORDAN, "joined");
    expect(await staffAt(HOME_SERVICES, started).statusOf("person-jordan")).toBe("joined");
    expect(new Set((await staffAt(HOME_SERVICES, record).team()).map((one) => one.status))).toEqual(
      new Set(STAFF_STATUSES.filter((status) => status !== "joined")),
    );
  });
});

describe("who may be offered to customers (S2-07, S2-08, S2-22, S2-24)", () => {
  it("joined members the owner let take bookings are offered: Jordan and Casey, Riley at the barbershop", async () => {
    expect(await staffAt(HOME_SERVICES).bookable()).toEqual(["person-casey", "person-jordan"]);
    expect(await staffAt(BARBERSHOP).bookable()).toEqual(["person-riley"]);
    expect(await staffAt(BARBERSHOP).isBookable("person-riley")).toBe(true);
  });

  it("a stopped staff member is never offered as bookable (S2-08: not offered for new bookings until START)", async () => {
    const barbershop = staffAt(BARBERSHOP, stopped(TEAM, RILEY));
    expect(await barbershop.bookable()).toEqual([]);
    expect(await barbershop.isBookable("person-riley")).toBe(false);
    expect((await barbershop.member("person-riley"))?.bookable).toBe(false);

    const homeServices = staffAt(HOME_SERVICES, stopped(TEAM, JORDAN));
    expect(await homeServices.bookable()).toEqual(["person-casey"]);
    expect(await homeServices.isBookable("person-jordan")).toBe(false);

    // The owner's earlier yes (bookable_at) is still on the row, and still offers nobody while stopped.
    const row = stopped(TEAM, RILEY).staff.find((one) => one.id === RILEY);
    expect(row?.bookableAt).not.toBeNull();
  });

  it("START returns a stopped member to joined, offered again on the owner's earlier yes", async () => {
    const started = withStatus(stopped(TEAM, RILEY), RILEY, "joined");
    expect(await staffAt(BARBERSHOP, started).bookable()).toEqual(["person-riley"]);
  });

  it("nobody is offered before joining and the owner's yes (S2-07, S2-22): Pat invited, a joined member not yet let", async () => {
    const homeServices = staffAt(HOME_SERVICES);
    expect(await homeServices.isBookable("person-pat")).toBe(false);
    const notYetLet = withStaff(TEAM, CASEY, { bookableAt: null });
    expect(await staffAt(HOME_SERVICES, notYetLet).bookable()).toEqual(["person-jordan"]);
  });

  it("a removed member is never offered, and nor is a person with no staff row here", async () => {
    const homeServices = staffAt(HOME_SERVICES, removed(TEAM, CASEY));
    expect(await homeServices.bookable()).toEqual(["person-jordan"]);
    expect(await homeServices.isBookable("person-casey")).toBe(false);
    expect(await homeServices.isBookable("person-sam")).toBe(false);
    expect(await homeServices.isBookable("person-riley")).toBe(false);
  });
});

describe("admins' powers (K-22 v1 team_powers; S13-45 row 8; RULES 6.8)", () => {
  it("Pat may OK prices over $500, as the owner named it (S2-02), and holds nothing more", async () => {
    const homeServices = staffAt(HOME_SERVICES);
    expect(await homeServices.powersOf("person-pat")).toEqual([
      { power: "prices", over: { cents: 50000, currency: "USD" } },
    ]);
    expect(await homeServices.holds("person-pat", "prices")).toBe(true);
    for (const power of TEAM_POWERS.filter((one) => one !== "prices")) {
      expect(await homeServices.holds("person-pat", power)).toBe(false);
    }
    expect(await homeServices.powersOf("person-jordan")).toEqual([]);
    expect(await homeServices.powersOf("person-sam")).toEqual([]);
  });

  it("an admin without the fee power is not the decider for a refund beyond the terms (S13-31; RULES 3.10)", async () => {
    const identity = homeServicesIdentity(TEAM);
    expect(await identity.whoDecides({ kind: "refund" })).toEqual({ ok: true, deciders: [SAM_OWNER] });
    expect(await identity.whoDecides({ kind: "fee" })).toEqual({ ok: true, deciders: [SAM_OWNER] });
    expect(await identity.decides({ kind: "refund" }, "person-pat")).toBe(false);
    expect(await identity.decides({ kind: "refund" }, "person-sam")).toBe(true);
  });

  it("with the money power the owner gave, Pat decides fees and refunds; taken back, Pat decides neither", async () => {
    const withMoney = givePower(TEAM, PAT, "money");
    const identity = homeServicesIdentity(withMoney);
    expect(await identity.whoDecides({ kind: "refund" })).toEqual({
      ok: true,
      deciders: [SAM_OWNER, PAT_ADMIN],
    });
    expect(await identity.whoDecides({ kind: "fee" })).toEqual({
      ok: true,
      deciders: [SAM_OWNER, PAT_ADMIN],
    });
    expect(await identity.whoDecides({ kind: "team" })).toEqual({ ok: true, deciders: [SAM_OWNER] });
    expect(await identity.decides({ kind: "refund" }, "person-pat")).toBe(true);

    const takenBack = homeServicesIdentity(endPower(withMoney, `power-${PAT}-money`));
    expect(await takenBack.decides({ kind: "refund" }, "person-pat")).toBe(false);
    expect(
      await staffAt(HOME_SERVICES, endPower(withMoney, `power-${PAT}-money`)).holds("person-pat", "money"),
    ).toBe(false);
  });

  it("with every power, Pat still never closes, exports, hands over or removes the owner", async () => {
    let record = TEAM;
    for (const power of TEAM_POWERS.filter((one) => one !== "prices")) record = givePower(record, PAT, power);
    expect((await staffAt(HOME_SERVICES, record).powersOf("person-pat")).map((held) => held.power)).toEqual([
      ...TEAM_POWERS,
    ]);
    const identity = homeServicesIdentity(record);
    for (const kind of BUSINESS_MATTERS) {
      expect(await identity.whoDecides({ kind })).toEqual({ ok: true, deciders: [SAM_OWNER, PAT_ADMIN] });
    }
    for (const kind of OWNER_ONLY_MATTERS) {
      expect(await identity.whoDecides({ kind })).toEqual({ ok: true, deciders: [SAM_OWNER] });
    }
  });

  it("staff decide no business matter, whatever power a row gives them (S13-31 names an admin)", async () => {
    const identity = homeServicesIdentity(givePower(TEAM, JORDAN, "money"));
    expect(await identity.whoDecides({ kind: "refund" })).toEqual({ ok: true, deciders: [SAM_OWNER] });
  });

  it("a removed member holds no power; a stopped one keeps the owner's (defaults S1 and S2)", async () => {
    const withMoney = givePower(TEAM, PAT, "money");
    expect(await staffAt(HOME_SERVICES, removed(withMoney, PAT)).powersOf("person-pat")).toEqual([]);
    expect(await staffAt(HOME_SERVICES, removed(withMoney, PAT)).holds("person-pat", "money")).toBe(false);
    expect(await staffAt(HOME_SERVICES, stopped(withMoney, PAT)).holds("person-pat", "money")).toBe(true);
    expect(await staffAt(HOME_SERVICES, withMoney).holds("person-pat", "money")).toBe(true);
  });

  it("teamAdminPowers answers each admin power as the member's live rows here hold it", async () => {
    const record = givePower(givePower(TEAM, PAT, "money"), PAT, "settings");
    const port = teamAdminPowers(staffReaderOf(record));
    const held = new Map<string, boolean>();
    for (const power of ADMIN_POWERS) held.set(power, await port.holds(HOME_SERVICES, "person-pat", power));
    expect(Object.fromEntries(held)).toEqual({ money: true, team: false, settings: true });
    const asTeamPowers: readonly TeamPower[] = ADMIN_POWERS;
    expect(asTeamPowers.every((power) => TEAM_POWERS.includes(power))).toBe(true);
  });
});

describe("one business per service", () => {
  it("a power at one business never counts at another, and only this business is asked", async () => {
    const record = givePower(TEAM, PAT, "money");
    for (const businessId of [BARBERSHOP, YOGA_STUDIO]) {
      const asked: TeamAsked[] = [];
      const service = createStaffAccess({ businessId, reader: staffReaderOf(record, asked) });
      expect(await service.holds("person-pat", "money")).toBe(false);
      expect(await service.statusOf("person-pat")).toBeNull();
      expect(asked.every((question) => question.businessId === businessId)).toBe(true);
      expect(await teamAdminPowers(staffReaderOf(record)).holds(businessId, "person-pat", "money")).toBe(
        false,
      );
    }
  });

  it("a reader that gives every business's rows changes no answer", async () => {
    const record = givePower(stopped(TEAM, JORDAN), PAT, "money");
    for (const businessId of [BARBERSHOP, YOGA_STUDIO, HOME_SERVICES]) {
      const scoped = staffAt(businessId, record);
      const leaky = createStaffAccess({ businessId, reader: leakyStaffReaderOf(record) });
      expect(await leaky.team()).toEqual(await scoped.team());
      expect(await leaky.bookable()).toEqual(await scoped.bookable());
      for (const personId of ["person-pat", "person-jordan", "person-riley"]) {
        expect(await leaky.powersOf(personId)).toEqual(await scoped.powersOf(personId));
      }
    }
  });
});

describe("answers carry ids, labels and the owner's amounts only", () => {
  it("no answer carries a member's mobile or name (K-08 v1; CQ-59)", async () => {
    const privateValues = new Set(recordOf(seedRows(STAFF_SEEDS)).privateValues);
    expect(privateValues).toContain("+15555550107");
    expect(privateValues).toContain("Jordan");
    const answers: unknown[] = [];
    for (const businessId of [BARBERSHOP, HOME_SERVICES]) {
      const service = staffAt(businessId, givePower(TEAM, PAT, "money"));
      answers.push(await service.team(), await service.bookable());
      for (const row of TEAM.staff) answers.push(await service.member(row.personId));
    }
    const strings = stringsIn(answers);
    expect(strings.length).toBeGreaterThan(0);
    expect(strings.filter((value) => privateValues.has(value))).toEqual([]);
  });

  it("a missing id or an unknown power is refused, naming the argument and never a value", async () => {
    expect(() => createStaffAccess({ businessId: " ", reader: staffReaderOf(TEAM) })).toThrow(
      new TypeError("businessId must be a non-empty id"),
    );
    const homeServices = staffAt(HOME_SERVICES);
    await expect(homeServices.member("")).rejects.toThrow(new TypeError("personId must be a non-empty id"));
    await expect(homeServices.isBookable("")).rejects.toThrow(
      new TypeError("personId must be a non-empty id"),
    );
    const close = JSON.parse('"close"') as TeamPower;
    await expect(homeServices.holds("person-pat", close)).rejects.toThrow(
      new TypeError("power must be one of K-22 v1's team powers"),
    );
    await expect(teamAdminPowers(staffReaderOf(TEAM)).holds("", "person-pat", "money")).rejects.toThrow(
      new TypeError("businessId must be a non-empty id"),
    );
  });

  it("a row outside K-22's lists, or two rows of one person here, fails closed naming the column (default S3)", async () => {
    const odd = (change: Partial<StaffOnFile>): TeamRecord => withStaff(TEAM, JORDAN, change);
    const unknownStatus = odd(JSON.parse('{"status":"paused"}') as Partial<StaffOnFile>);
    await expect(staffAt(HOME_SERVICES, unknownStatus).bookable()).rejects.toThrow(
      new StaffReadError("staff.status"),
    );

    const jordan = TEAM.staff.find((row) => row.id === JORDAN);
    if (jordan === undefined) throw new Error("no Jordan");
    const twice: TeamRecord = { ...TEAM, staff: [...TEAM.staff, { ...jordan, id: "staff-jordan-again" }] };
    await expect(staffAt(HOME_SERVICES, twice).team()).rejects.toThrow(new StaffReadError("staff.person_id"));

    const unknownPower: TeamRecord = {
      ...TEAM,
      powers: TEAM.powers.map((row) => ({ ...row, power: JSON.parse('"export"') as TeamPower })),
    };
    await expect(staffAt(HOME_SERVICES, unknownPower).powersOf("person-pat")).rejects.toThrow(
      new StaffReadError("team_powers.power"),
    );
    const error = new StaffReadError("staff.status");
    expect(error.message).not.toContain("paused");
  });
});
