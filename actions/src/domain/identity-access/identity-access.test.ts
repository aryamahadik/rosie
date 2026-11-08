// T-308's proofs (the card's "Proves it with"), on the frozen contracts' seed rows (K-04 v1's demo shops and sample cast,
// K-22 v1's team at Lee Home Services) and the master's own examples, through an in-memory reader, never a database:
//   - the person served decides for their visit;
//   - a parent decides for a child;
//   - fees, refunds, team and settings resolve to the owner or a permitted admin (S13-31);
//   - a booker who is not the person served is not the decider;
//   - a payer is never the decider by being the payer.
// And the base around them: who a sender is for a business, the three parties kept apart, one business per service, and
// answers that carry ids and labels only, never a name, number or email (K-08 v1; CQ-59).

import { describe, expect, it } from "vitest";

import { NOTHING_ON_FILE, type AdminPowers, type ServedFacts, type ServedFactsReader } from "./facts";
import {
  BUSINESS_MATTERS,
  OWNER_ONLY_MATTERS,
  createIdentityAccess,
  partsOf,
  type IdentityAccess,
  type Matter,
} from "./identity-access";
import {
  BARBERSHOP,
  CUT_PAID_BY_EMPLOYER,
  DEATH_REPORTED,
  GIFT_FOR_BROTHER,
  HOME_SERVICES,
  KIDS_CUT_FOR_SON,
  KIDS_CUT_PAID_BY_SOMEONE_ELSE,
  MOVERS,
  SON_WITH_ALEX_ON_FILE,
  WHO_FOR_NOT_ANSWERED,
  YOGA_STUDIO,
  adminPowersOf,
  leakyReaderOf,
  powerRow,
  readerOf,
  roleRow,
  seedRecord,
  servedFactsOf,
  stringsIn,
  withRows,
  type PowerAsked,
  type ServedAsked,
  type TestRecord,
} from "./test-support";

/** The seeds with the master's examples added (A4-24, A4-25, A4-26, A4-55, A7-81). */
const RECORD = withRows(seedRecord(), {
  bookings: [
    GIFT_FOR_BROTHER,
    KIDS_CUT_FOR_SON,
    KIDS_CUT_PAID_BY_SOMEONE_ELSE,
    CUT_PAID_BY_EMPLOYER,
    WHO_FOR_NOT_ANSWERED,
    DEATH_REPORTED,
  ],
});

/** The son's facts on file for both of his bookings (A4-25). */
const SON_ON_FILE = servedFactsOf({
  [KIDS_CUT_FOR_SON.id]: SON_WITH_ALEX_ON_FILE,
  [KIDS_CUT_PAID_BY_SOMEONE_ELSE.id]: SON_WITH_ALEX_ON_FILE,
});

interface Setup {
  /** Default RECORD. */
  record?: TestRecord;
  /** Default: K-22's team powers over the record. */
  adminPowers?: AdminPowers;
  /** Default: the son's facts on file. */
  servedFacts?: ServedFactsReader;
}

/** The service of one business over the record, as a Tool API call would make it under that business's scope. */
function serviceFor(businessId: string, setup: Setup = {}): IdentityAccess {
  const record = setup.record ?? RECORD;
  return createIdentityAccess({
    businessId,
    reader: readerOf(record),
    adminPowers: setup.adminPowers ?? adminPowersOf(record),
    servedFacts: setup.servedFacts ?? SON_ON_FILE,
  });
}

const visit = (bookingId: string): Matter => ({ kind: "visit", bookingId });

const SAM_OWNER = { personId: "person-sam", as: "owner" } as const;
const PAT_ADMIN = { personId: "person-pat", as: "admin" } as const;

/** The record with one role ended (staff stopped or removed, an owner handed over: FS line 723). */
function endRole(record: TestRecord, roleId: string): TestRecord {
  return {
    ...record,
    roles: record.roles.map((row) =>
      row.id === roleId
        ? { ...row, endedAt: new Date("2026-11-01T12:00:00Z"), version: row.version + 1 }
        : row,
    ),
  };
}

/** Pat's staff row at Lee Home Services (K-22 seed-staff-invited), given more powers. */
function patWith(...powers: string[]): TestRecord {
  return withRows(RECORD, {
    powers: powers.map((power) => powerRow("staff-pat-home-services", HOME_SERVICES, power)),
  });
}

describe("who decides a visit (S13-31; S13-45 rows 2 and 5)", () => {
  it("the person served decides for their visit: Alex for his own haircut, his brother for the gift (A4-26)", async () => {
    const barbershop = serviceFor(BARBERSHOP);
    expect(await barbershop.whoDecides(visit("booking-alex-haircut"))).toEqual({
      ok: true,
      deciders: [{ personId: "person-alex", as: "served" }],
    });
    expect(await barbershop.whoDecides(visit(GIFT_FOR_BROTHER.id))).toEqual({
      ok: true,
      deciders: [{ personId: "person-alex-brother", as: "served" }],
    });
    expect(await serviceFor(YOGA_STUDIO).whoDecides(visit("booking-alex-workshop"))).toEqual({
      ok: true,
      deciders: [{ personId: "person-alex", as: "served" }],
    });
  });

  it("a parent decides for a child: Alex for his son's kids cut, never the son himself (A4-25)", async () => {
    const barbershop = serviceFor(BARBERSHOP);
    expect(await barbershop.whoDecides(visit(KIDS_CUT_FOR_SON.id))).toEqual({
      ok: true,
      deciders: [{ personId: "person-alex", as: "parentOrGuardian" }],
    });
    expect(await barbershop.decides(visit(KIDS_CUT_FOR_SON.id), "person-alex")).toBe(true);
    expect(await barbershop.decides(visit(KIDS_CUT_FOR_SON.id), "person-alex-son")).toBe(false);
  });

  it("either parent on file decides for a minor (A4-25: 'either parent named there may book and hear')", async () => {
    const bothParents: ServedFacts = {
      ageBand: "under_18",
      parentOrGuardianIds: ["person-alex-co-parent", "person-alex", "person-alex"],
    };
    const barbershop = serviceFor(BARBERSHOP, {
      servedFacts: servedFactsOf({ [KIDS_CUT_FOR_SON.id]: bothParents }),
    });
    expect(await barbershop.whoDecides(visit(KIDS_CUT_FOR_SON.id))).toEqual({
      ok: true,
      deciders: [
        { personId: "person-alex", as: "parentOrGuardian" },
        { personId: "person-alex-co-parent", as: "parentOrGuardian" },
      ],
    });
  });

  it("a minor with no parent or guardian on file names nobody, not the booker who says he is the parent", async () => {
    const barbershop = serviceFor(BARBERSHOP, {
      servedFacts: servedFactsOf({ [KIDS_CUT_FOR_SON.id]: { ageBand: "under_18", parentOrGuardianIds: [] } }),
    });
    expect(await barbershop.whoDecides(visit(KIDS_CUT_FOR_SON.id))).toEqual({
      ok: false,
      why: "noParentOrGuardian",
    });
    expect(await barbershop.decides(visit(KIDS_CUT_FOR_SON.id), "person-alex")).toBe(false);
  });

  it("with no age band on file, or 18 or older, the person served decides as an adult (A4-24; S13-31)", async () => {
    const nothingOnFile = serviceFor(BARBERSHOP, { servedFacts: NOTHING_ON_FILE });
    expect(await nothingOnFile.whoDecides(visit(KIDS_CUT_FOR_SON.id))).toEqual({
      ok: true,
      deciders: [{ personId: "person-alex-son", as: "served" }],
    });
    const adult = serviceFor(BARBERSHOP, {
      servedFacts: servedFactsOf({
        [KIDS_CUT_FOR_SON.id]: { ageBand: "18_or_older", parentOrGuardianIds: ["person-alex"] },
      }),
    });
    expect(await adult.whoDecides(visit(KIDS_CUT_FOR_SON.id))).toEqual({
      ok: true,
      deciders: [{ personId: "person-alex-son", as: "served" }],
    });
    const defaults = createIdentityAccess({ businessId: BARBERSHOP, reader: readerOf(RECORD) });
    expect(await defaults.whoDecides(visit(KIDS_CUT_FOR_SON.id))).toEqual({
      ok: true,
      deciders: [{ personId: "person-alex-son", as: "served" }],
    });
  });

  it("a booker who is not the person served is not the decider (A4-24, A4-26)", async () => {
    const barbershop = serviceFor(BARBERSHOP);
    expect(await barbershop.decides(visit(GIFT_FOR_BROTHER.id), "person-alex")).toBe(false);
    expect(await barbershop.decides(visit(GIFT_FOR_BROTHER.id), "person-alex-brother")).toBe(true);

    // Before who it is for is answered, nobody decides: the booker is never read into the gap.
    expect(await barbershop.whoDecides(visit(WHO_FOR_NOT_ANSWERED.id))).toEqual({
      ok: false,
      why: "servedNotOnRecord",
    });
    expect(await barbershop.decides(visit(WHO_FOR_NOT_ANSWERED.id), "person-alex")).toBe(false);

    // A child's booker decides only as a parent on file: papers that allow only the other parent leave Alex out.
    const otherParentOnly = serviceFor(BARBERSHOP, {
      servedFacts: servedFactsOf({
        [KIDS_CUT_FOR_SON.id]: { ageBand: "under_18", parentOrGuardianIds: ["person-alex-co-parent"] },
      }),
    });
    expect(await otherParentOnly.whoDecides(visit(KIDS_CUT_FOR_SON.id))).toEqual({
      ok: true,
      deciders: [{ personId: "person-alex-co-parent", as: "parentOrGuardian" }],
    });
    expect(await otherParentOnly.decides(visit(KIDS_CUT_FOR_SON.id), "person-alex")).toBe(false);
  });

  it("a payer is never the decider by being the payer (A4-55; A4-24: a child paid for by someone else)", async () => {
    const barbershop = serviceFor(BARBERSHOP);
    expect(await barbershop.whoDecides(visit(CUT_PAID_BY_EMPLOYER.id))).toEqual({
      ok: true,
      deciders: [{ personId: "person-alex", as: "served" }],
    });
    expect(await barbershop.decides(visit(CUT_PAID_BY_EMPLOYER.id), "person-alex-employer")).toBe(false);

    expect(await barbershop.whoDecides(visit(KIDS_CUT_PAID_BY_SOMEONE_ELSE.id))).toEqual({
      ok: true,
      deciders: [{ personId: "person-alex", as: "parentOrGuardian" }],
    });
    expect(await barbershop.decides(visit(KIDS_CUT_PAID_BY_SOMEONE_ELSE.id), "person-other-payer")).toBe(
      false,
    );

    // Alex pays for his brother's gift and still decides nothing about it.
    expect(await barbershop.decides(visit(GIFT_FOR_BROTHER.id), "person-alex")).toBe(false);
  });

  it("after a death is reported on the booking, the owner decides the rest, never the person served (A7-81)", async () => {
    const barbershop = serviceFor(BARBERSHOP);
    expect(await barbershop.whoDecides(visit(DEATH_REPORTED.id))).toEqual({
      ok: true,
      deciders: [SAM_OWNER],
    });
    expect(await barbershop.decides(visit(DEATH_REPORTED.id), "person-alex")).toBe(false);
    const noOwner = serviceFor(BARBERSHOP, { record: endRole(RECORD, "role-sam-barber") });
    expect(await noOwner.whoDecides(visit(DEATH_REPORTED.id))).toEqual({ ok: false, why: "nobodyAllowed" });
  });

  it("a booking of another business, or none, is never answered", async () => {
    const barbershop = serviceFor(BARBERSHOP);
    expect(await barbershop.whoDecides(visit("booking-alex-workshop"))).toEqual({
      ok: false,
      why: "bookingNotFound",
    });
    expect(await barbershop.whoDecides(visit("booking-never-made"))).toEqual({
      ok: false,
      why: "bookingNotFound",
    });
  });

  it("asks what is on file only for this business's booking and its person served, and only when it decides", async () => {
    const asked: ServedAsked[] = [];
    const barbershop = serviceFor(BARBERSHOP, { servedFacts: servedFactsOf({}, asked) });
    for (const bookingId of [DEATH_REPORTED.id, WHO_FOR_NOT_ANSWERED.id, "booking-alex-workshop"]) {
      await barbershop.whoDecides(visit(bookingId));
    }
    expect(asked).toEqual([]);
    await barbershop.whoDecides(visit(GIFT_FOR_BROTHER.id));
    expect(asked).toEqual([
      { businessId: BARBERSHOP, bookingId: GIFT_FOR_BROTHER.id, servedPersonId: "person-alex-brother" },
    ]);
  });
});

describe("who decides fees, refunds, the team and settings (S13-31; S13-45 row 8; RULES 6.8)", () => {
  const ALL_MATTERS: Matter[] = [
    ...BUSINESS_MATTERS.map((kind): Matter => ({ kind })),
    ...OWNER_ONLY_MATTERS.map((kind): Matter => ({ kind })),
  ];

  it("the owner decides every business matter: Sam at each of his businesses, never staff or customers", async () => {
    for (const businessId of [BARBERSHOP, YOGA_STUDIO, MOVERS, HOME_SERVICES]) {
      const service = serviceFor(businessId);
      for (const matter of ALL_MATTERS) {
        expect(await service.whoDecides(matter)).toEqual({ ok: true, deciders: [SAM_OWNER] });
      }
    }
    const barbershop = serviceFor(BARBERSHOP);
    for (const personId of ["person-riley", "person-avery", "person-alex"]) {
      expect(await barbershop.decides({ kind: "fee" }, personId)).toBe(false);
    }
    expect(await barbershop.decides({ kind: "refund" }, "person-sam")).toBe(true);
  });

  it("an admin with only the price power decides no fee, refund, team or setting (S2-02: Pat OKs prices)", async () => {
    const asked: PowerAsked[] = [];
    const homeServices = serviceFor(HOME_SERVICES, { adminPowers: adminPowersOf(RECORD, asked) });
    for (const kind of BUSINESS_MATTERS) {
      expect(await homeServices.whoDecides({ kind })).toEqual({ ok: true, deciders: [SAM_OWNER] });
    }
    expect(asked).toEqual([
      { businessId: HOME_SERVICES, personId: "person-pat", power: "money" },
      { businessId: HOME_SERVICES, personId: "person-pat", power: "money" },
      { businessId: HOME_SERVICES, personId: "person-pat", power: "team" },
      { businessId: HOME_SERVICES, personId: "person-pat", power: "settings" },
    ]);
  });

  it("an admin the owner lets decides with that power only: Pat with money decides fees and refunds", async () => {
    const homeServices = serviceFor(HOME_SERVICES, { record: patWith("money") });
    expect(await homeServices.whoDecides({ kind: "fee" })).toEqual({
      ok: true,
      deciders: [SAM_OWNER, PAT_ADMIN],
    });
    expect(await homeServices.whoDecides({ kind: "refund" })).toEqual({
      ok: true,
      deciders: [SAM_OWNER, PAT_ADMIN],
    });
    expect(await homeServices.whoDecides({ kind: "team" })).toEqual({ ok: true, deciders: [SAM_OWNER] });
    expect(await homeServices.whoDecides({ kind: "settings" })).toEqual({ ok: true, deciders: [SAM_OWNER] });
    expect(await homeServices.decides({ kind: "refund" }, "person-pat")).toBe(true);
  });

  it("with every power, Pat still never closes, exports, hands over or removes the owner (RULES 6.8)", async () => {
    const homeServices = serviceFor(HOME_SERVICES, {
      record: patWith("money", "team", "settings", "prices", "cancels"),
    });
    for (const kind of BUSINESS_MATTERS) {
      expect(await homeServices.whoDecides({ kind })).toEqual({ ok: true, deciders: [SAM_OWNER, PAT_ADMIN] });
    }
    for (const kind of OWNER_ONLY_MATTERS) {
      expect(await homeServices.whoDecides({ kind })).toEqual({ ok: true, deciders: [SAM_OWNER] });
      expect(await homeServices.decides({ kind }, "person-pat")).toBe(false);
    }
  });

  it("staff never decide a business matter, whatever power a row gives them", async () => {
    const record = withRows(RECORD, {
      powers: [powerRow("staff-jordan-home-services", HOME_SERVICES, "money")],
    });
    const asked: PowerAsked[] = [];
    const homeServices = serviceFor(HOME_SERVICES, { record, adminPowers: adminPowersOf(record, asked) });
    expect(await homeServices.whoDecides({ kind: "fee" })).toEqual({ ok: true, deciders: [SAM_OWNER] });
    expect(asked.map((question) => question.personId)).toEqual(["person-pat"]);
  });

  it("with no admins' powers port, the owner alone decides (until T-321 reads K-22's team powers)", async () => {
    const homeServices = createIdentityAccess({
      businessId: HOME_SERVICES,
      reader: readerOf(patWith("money")),
    });
    expect(await homeServices.whoDecides({ kind: "fee" })).toEqual({ ok: true, deciders: [SAM_OWNER] });
  });

  it("an owner whose role ended decides nothing; with nobody left allowed, nobody is named", async () => {
    const movers = serviceFor(MOVERS, { record: endRole(RECORD, "role-sam-movers") });
    for (const matter of ALL_MATTERS) {
      expect(await movers.whoDecides(matter)).toEqual({ ok: false, why: "nobodyAllowed" });
    }
    // Lee Home Services without its owner: the admin the owner let keeps that power, and nothing more.
    const homeServices = serviceFor(HOME_SERVICES, {
      record: endRole(patWith("money"), "role-sam-home-services"),
    });
    expect(await homeServices.whoDecides({ kind: "fee" })).toEqual({ ok: true, deciders: [PAT_ADMIN] });
    expect(await homeServices.whoDecides({ kind: "close" })).toEqual({ ok: false, why: "nobodyAllowed" });
  });
});

describe("who a sender is for a business", () => {
  it("a handle's person and their live roles here: Sam the owner, Riley staff, Alex a customer, Pat an admin", async () => {
    const barbershop = serviceFor(BARBERSHOP);
    expect(await barbershop.sender("handle-sam")).toEqual({
      handleId: "handle-sam",
      people: [{ personId: "person-sam", roles: ["owner"] }],
      roles: ["owner"],
    });
    expect(await barbershop.sender("handle-riley")).toEqual({
      handleId: "handle-riley",
      people: [{ personId: "person-riley", roles: ["staff"] }],
      roles: ["staff"],
    });
    for (const handleId of ["handle-alex", "handle-alex-email"]) {
      expect(await barbershop.sender(handleId)).toEqual({
        handleId,
        people: [{ personId: "person-alex", roles: ["customer"] }],
        roles: ["customer"],
      });
    }
    expect(await serviceFor(HOME_SERVICES).sender("handle-pat")).toEqual({
      handleId: "handle-pat",
      people: [{ personId: "person-pat", roles: ["admin"] }],
      roles: ["admin"],
    });
  });

  it("roles count only at this business: Alex has none at the movers, Riley none at the yoga studio", async () => {
    expect(await serviceFor(MOVERS).sender("handle-alex")).toEqual({
      handleId: "handle-alex",
      people: [{ personId: "person-alex", roles: [] }],
      roles: [],
    });
    expect(await serviceFor(YOGA_STUDIO).rolesOf("person-riley")).toEqual([]);
    expect(await serviceFor(YOGA_STUDIO).rolesOf("person-sam")).toEqual(["owner"]);
  });

  it("a handle nobody writes from yet is nobody: the doors (arch 03 line 165)", async () => {
    expect(await serviceFor(BARBERSHOP).sender("handle-never-seen")).toEqual({
      handleId: "handle-never-seen",
      people: [],
      roles: [],
    });
  });

  it("one handle can be several people, each with their own roles (arch 01 line 55)", async () => {
    const record = withRows(RECORD, {
      personHandles: [{ personId: "person-alex-son", handleId: "handle-alex" }],
    });
    expect(await serviceFor(BARBERSHOP, { record }).sender("handle-alex")).toEqual({
      handleId: "handle-alex",
      people: [
        { personId: "person-alex", roles: ["customer"] },
        { personId: "person-alex-son", roles: [] },
      ],
      roles: ["customer"],
    });
  });

  it("two roles that fit are both given, in K-04's order, so the sender is asked which (S13-31)", async () => {
    const record = withRows(RECORD, {
      roles: [roleRow("role-riley-barber-customer", "person-riley", BARBERSHOP, "customer")],
    });
    const barbershop = serviceFor(BARBERSHOP, { record });
    expect((await barbershop.sender("handle-riley")).roles).toEqual(["staff", "customer"]);
    expect(await barbershop.rolesOf("person-riley")).toEqual(["staff", "customer"]);
  });

  it("an ended role no longer fits (staff stopped or removed: FS line 723)", async () => {
    const barbershop = serviceFor(BARBERSHOP, { record: endRole(RECORD, "role-riley-barber") });
    expect(await barbershop.sender("handle-riley")).toEqual({
      handleId: "handle-riley",
      people: [{ personId: "person-riley", roles: [] }],
      roles: [],
    });
  });
});

describe("booker, person served and payer kept apart (A4-24)", () => {
  it("each part is its own: one person may play all three, or each a different person", async () => {
    const barbershop = serviceFor(BARBERSHOP);
    const own = await barbershop.parties("booking-alex-haircut");
    expect(own).toEqual({
      bookingId: "booking-alex-haircut",
      booker: "person-alex",
      served: "person-alex",
      payer: "person-alex",
    });
    if (own === null) throw new Error("no parties");
    expect(partsOf(own, "person-alex")).toEqual(["booker", "served", "payer"]);

    const employer = await barbershop.parties(CUT_PAID_BY_EMPLOYER.id);
    if (employer === null) throw new Error("no parties");
    expect(partsOf(employer, "person-alex")).toEqual(["booker", "served"]);
    expect(partsOf(employer, "person-alex-employer")).toEqual(["payer"]);

    const kidsCut = await barbershop.parties(KIDS_CUT_FOR_SON.id);
    if (kidsCut === null) throw new Error("no parties");
    expect(partsOf(kidsCut, "person-alex")).toEqual(["booker", "payer"]);
    expect(partsOf(kidsCut, "person-alex-son")).toEqual(["served"]);
    expect(partsOf(kidsCut, "person-sam")).toEqual([]);
  });

  it("a part not on the record stays empty, never filled in from the booker", async () => {
    const parties = await serviceFor(BARBERSHOP).parties(WHO_FOR_NOT_ANSWERED.id);
    expect(parties).toEqual({
      bookingId: WHO_FOR_NOT_ANSWERED.id,
      booker: "person-alex",
      served: null,
      payer: null,
    });
    if (parties === null) throw new Error("no parties");
    expect(partsOf(parties, "person-alex")).toEqual(["booker"]);
  });

  it("another business's booking has no parties here", async () => {
    expect(await serviceFor(BARBERSHOP).parties("booking-alex-workshop")).toBeNull();
    expect(await serviceFor(YOGA_STUDIO).parties("booking-alex-haircut")).toBeNull();
  });
});

describe("one business per service", () => {
  const HANDLES = [...new Set(RECORD.personHandles.map((link) => link.handleId)), "handle-never-seen"];
  const PEOPLE = [...new Set(RECORD.roles.map((row) => row.personId))];
  const BOOKINGS = RECORD.bookings.map((head) => head.id);
  const MATTERS: Matter[] = [
    ...BUSINESS_MATTERS.map((kind): Matter => ({ kind })),
    ...OWNER_ONLY_MATTERS.map((kind): Matter => ({ kind })),
    ...BOOKINGS.map(visit),
  ];
  const BUSINESSES = [BARBERSHOP, YOGA_STUDIO, MOVERS, HOME_SERVICES];

  /** Every answer a service gives about the record's handles, people, bookings and matters. */
  async function answersOf(service: IdentityAccess): Promise<unknown[]> {
    const answers: unknown[] = [];
    for (const handleId of HANDLES) answers.push(await service.sender(handleId));
    for (const personId of PEOPLE) answers.push(await service.rolesOf(personId));
    for (const bookingId of BOOKINGS) answers.push(await service.parties(bookingId));
    for (const matter of MATTERS) answers.push(await service.whoDecides(matter));
    return answers;
  }

  it("a reader that gives every business's role rows, ended ones too, changes no answer", async () => {
    const record = endRole(patWith("money", "team"), "role-avery-barber");
    for (const businessId of BUSINESSES) {
      const scoped = serviceFor(businessId, { record });
      const leaky = createIdentityAccess({
        businessId,
        reader: leakyReaderOf(record),
        adminPowers: adminPowersOf(record),
        servedFacts: SON_ON_FILE,
      });
      expect(await answersOf(leaky)).toEqual(await answersOf(scoped));
    }
  });

  it("an admin's power at one business never counts at another, and the port is asked about this business only", async () => {
    const record = patWith("money", "team", "settings");
    for (const businessId of BUSINESSES) {
      const asked: PowerAsked[] = [];
      const service = createIdentityAccess({
        businessId,
        reader: leakyReaderOf(record),
        adminPowers: adminPowersOf(record, asked),
      });
      await answersOf(service);
      expect(asked.every((question) => question.businessId === businessId)).toBe(true);
      const fee = await service.whoDecides({ kind: "fee" });
      expect(fee).toEqual({
        ok: true,
        deciders: businessId === HOME_SERVICES ? [SAM_OWNER, PAT_ADMIN] : [SAM_OWNER],
      });
    }
  });
});

describe("answers carry ids and labels only", () => {
  it("no answer carries a person's name, number or email, or a business's name (K-08 v1; CQ-59)", async () => {
    const record = patWith("money");
    expect(record.privateValues).toContain("Alex M.");
    expect(record.privateValues).toContain("+15555550101");
    expect(record.privateValues).toContain("alex@example.com");
    const privateValues = new Set(record.privateValues);
    const answers: unknown[] = [];
    for (const businessId of [BARBERSHOP, YOGA_STUDIO, MOVERS, HOME_SERVICES]) {
      const service = serviceFor(businessId, { record });
      for (const link of record.personHandles) answers.push(await service.sender(link.handleId));
      for (const row of record.roles) answers.push(await service.rolesOf(row.personId));
      for (const head of record.bookings) {
        answers.push(await service.parties(head.id), await service.whoDecides(visit(head.id)));
      }
      for (const kind of [...BUSINESS_MATTERS, ...OWNER_ONLY_MATTERS])
        answers.push(await service.whoDecides({ kind }));
    }
    const strings = stringsIn(answers);
    expect(strings.length).toBeGreaterThan(0);
    expect(strings.filter((value) => privateValues.has(value))).toEqual([]);
  });

  it("a missing id or an unknown matter is refused, naming the argument and never a value", async () => {
    expect(() => createIdentityAccess({ businessId: "", reader: readerOf(RECORD) })).toThrow(
      new TypeError("businessId must be a non-empty id"),
    );
    const barbershop = serviceFor(BARBERSHOP);
    await expect(barbershop.sender(" ")).rejects.toThrow(new TypeError("handleId must be a non-empty id"));
    await expect(barbershop.rolesOf("")).rejects.toThrow(new TypeError("personId must be a non-empty id"));
    await expect(barbershop.parties("")).rejects.toThrow(new TypeError("bookingId must be a non-empty id"));
    await expect(barbershop.whoDecides(visit(""))).rejects.toThrow(
      new TypeError("bookingId must be a non-empty id"),
    );
    await expect(barbershop.decides({ kind: "fee" }, "")).rejects.toThrow(
      new TypeError("personId must be a non-empty id"),
    );
    const unknownMatter = JSON.parse('{"kind":"launch"}') as Matter;
    await expect(barbershop.whoDecides(unknownMatter)).rejects.toThrow(
      new TypeError("a matter is a visit, a business matter or an owner-only matter"),
    );
  });
});
