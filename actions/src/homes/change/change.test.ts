// The change home (T-594; S13-56), on fixture set v1: the K-04 v1 booking heads read through T-308's identity-and-access
// service, the master's own visit (Alex's haircut with Riley, Sat Oct 24 at 11:00am, $35) and both flows as the merged
// bundle emitter compiles them. One describe per "Proves it with" item: a booking that named a person never offers
// another pro, and on silence moves nobody; a visit today gets the 2-hour deadline, a later visit 7pm the day before;
// silence moves nobody except the running-late case; no offer carries the reason the pro is out; another pro only at the
// same price or lower. Then the rest of S13-56's paths, the registry, the reads and the refusals.

import { beforeAll, describe, expect, it } from "vitest";
import { clockHomeModule } from "../../../../runtime/src/clocks/home";
import { isLabel } from "../../../../runtime/src/trace";
import { contactHome } from "../contact";
import { moneyHome } from "../money";
import { createHomeRegistry, type HomeLogLine, type HomeModule } from "../registry";
import { emittedFlows, objAt, type EmittedFlows } from "../registry/test-support";
import { stopHome } from "../stop";
import {
  BOOKING_HOLDS,
  CHANGE_POINTS,
  CHANGE_REASONS,
  ChangeHomeError,
  LEAVING_REASONS,
  PRO_OUT_REASONS,
  changeHome,
  changeOffer,
  changeRule,
  leaverAccessEnds,
  offerDeadline,
  readChangeBooking,
  standInWhy,
  type ChangeBooking,
  type ChangeBookingRead,
  type ChangeOffer,
  type ChangeReading,
  type ChangeReason,
  type StandIn,
} from "./index";
import {
  ALEX,
  AVERY,
  AVERY_SAME_PRICE,
  DEATH_REPORTED,
  HAIRCUT,
  KIDS_CUT_FOR_SON,
  RILEY,
  S13_56_DOES,
  S13_56_RULES,
  SHOP_ZONE,
  SON_WITH_ALEX_ON_FILE,
  T,
  USD_35,
  USD_40,
  USD_55,
  WORKSHOP,
  bookingOf,
  readBooking,
  readingOf,
  shopReads,
  shopReadsWith,
} from "./test-support";

const FLOWS = ["A", "B"] as const;

let flows: EmittedFlows;
/** Alex's haircut at Lee's Barbershop, read through readChangeBooking (K-04 v1 head; T-308: Alex decides). */
let haircut: ChangeBookingRead;
/** Alex's son's kids cut (T-308's A4-25 example): a minor, so Alex decides as his parent on file. */
let kidsCut: ChangeBookingRead;

beforeAll(async () => {
  flows = await emittedFlows();
  haircut = await readBooking(shopReads(), HAIRCUT);
  kidsCut = await readBooking(
    shopReadsWith([KIDS_CUT_FOR_SON], { [KIDS_CUT_FOR_SON.id]: SON_WITH_ALEX_ON_FILE }),
    KIDS_CUT_FOR_SON.id,
  );
});

/** The haircut, its facts changed as given. */
const haircutWith = (facts: Partial<ChangeBooking> = {}): ChangeBooking => bookingOf(haircut, facts);

/** The offer for the haircut and a reason, offered Friday at 9:00am with Avery standing by. */
const offerFor = (
  reason: ChangeReason,
  facts: Partial<ChangeBooking> = {},
  standIns?: readonly StandIn[],
): ChangeOffer => changeOffer(readingOf(haircutWith(facts), reason, T.fri9am, standIns));

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

describe("S13-56 as the bundle compiles it: the lines the change home rules by", () => {
  it("both flows hold S13-56 as the change home, with every line the module rules by, word for word", () => {
    for (const flow of FLOWS) {
      expect(objAt(flows[flow], ["record", "homes"]).change, flow).toBe("S13-56");
      const step = objAt(flows[flow], ["steps", "S13-56"]);
      expect(step.does, flow).toBe(S13_56_DOES);
      const more = stringList(step.more);
      for (const line of S13_56_RULES) expect(more, `${flow}: ${line}`).toContain(line);
    }
  });

  it("the reads: Alex's haircut is booked at Lee's Barbershop, and Alex decides it (T-308)", () => {
    expect(haircut).toEqual({
      bookingId: HAIRCUT,
      businessId: "biz-lees-barbershop",
      flow: "A",
      stage: "booked",
      deceased: false,
      decides: { ok: true, deciders: [{ personId: ALEX, as: "served" }] },
    });
    expect(kidsCut.decides).toEqual({ ok: true, deciders: [{ personId: ALEX, as: "parentOrGuardian" }] });
  });
});

describe("a booking that named a person never offers another pro, and on silence moves nobody", () => {
  it("for every reason a pro is out: no other pro, the visit called off on silence, and Sam calls them", () => {
    for (const reason of PRO_OUT_REASONS)
      for (const named of [true, null] as const) {
        const offer = offerFor(reason, { named });
        const at = `${reason} named=${String(named)}`;
        expect(offer.path, at).toBe("offer");
        expect(offer.anotherPro, at).toEqual({
          offered: false,
          why: named === true ? "named" : "namedNotKnown",
          standIns: [],
          verdicts: [{ personId: AVERY, why: "allowed" }],
        });
        expect(offer.silence, at).toEqual({ outcome: "callOff", moves: "nobody" });
        expect(offer.personReaches, at).toBe("owner");
        expect(offer.anotherTime.offered && offer.freeCancel, at).toBe(true);
      }
  });

  it("the same booking named nobody: Avery, who passes every check, is offered (the block is the naming alone)", () => {
    for (const reason of PRO_OUT_REASONS) {
      const offer = offerFor(reason, { named: false });
      expect(offer.anotherPro, reason).toEqual({
        offered: true,
        why: "allowed",
        standIns: [AVERY],
        verdicts: [{ personId: AVERY, why: "allowed" }],
      });
      expect(offer.silence, reason).toEqual({ outcome: "callOff", moves: "nobody" });
      expect(offer.personReaches, reason).toBe("none");
    }
  });

  it("a child's booking that named a person, or someone in care: never another pro, and Sam calls them", () => {
    const child = (facts: Partial<ChangeBooking>): ChangeOffer =>
      changeOffer(readingOf(bookingOf(kidsCut, facts), "proCantCome"));
    expect(child({ named: true }).anotherPro.why).toBe("named");
    expect(child({ named: false, inCare: true }).anotherPro.why).toBe("inCare");
    expect(child({ named: false, inCare: null }).anotherPro.why).toBe("inCareNotKnown");
    const blocked: readonly Partial<ChangeBooking>[] = [
      { named: true },
      { named: false, inCare: true },
      { named: false, inCare: null },
    ];
    for (const facts of blocked) {
      const offer = child(facts);
      expect(offer.anotherPro.offered, JSON.stringify(facts)).toBe(false);
      expect(offer.silence, JSON.stringify(facts)).toEqual({ outcome: "callOff", moves: "nobody" });
      expect(offer.personReaches, JSON.stringify(facts)).toBe("owner");
      expect(offer.decides, JSON.stringify(facts)).toEqual(kidsCut.decides);
    }
    expect(child({ named: false, inCare: false }).anotherPro.standIns).toEqual([AVERY]);
  });

  it("the registry's points say the same for a named booking: anotherPro no, silenceMoves nobody", () => {
    const change = readingOf(haircutWith({ named: true }), "proCantCome");
    expect(changeRule("anotherPro", { change })).toBe("no");
    expect(changeRule("silenceMoves", { change })).toBe("nobody");
    expect(changeRule("silenceOutcome", { change })).toBe("callOff");
    expect(changeRule("personReaches", { change })).toBe("owner");
  });
});

describe("a visit today gets the 2-hour deadline, a later visit 7pm the day before", () => {
  it("Saturday's 11:00am visit offered on Friday, or on Wednesday: 7pm Friday, in the shop's zone", () => {
    for (const offeredAt of [T.fri9am, T.wed9am])
      expect(changeOffer(readingOf(haircutWith(), "proCantCome", offeredAt)).deadline, offeredAt).toEqual({
        dueAt: T.fri7pm,
        dueZone: SHOP_ZONE,
        rule: "dayBefore",
      });
  });

  it("a visit offered on its own day: 2 hours before it", () => {
    expect(changeOffer(readingOf(haircutWith(), "proCantCome", T.sat730am)).deadline).toEqual({
      dueAt: T.sat9am,
      dueZone: SHOP_ZONE,
      rule: "sameDay",
    });
    const later = haircutWith({ visitStartsAt: T.visitSat3pm });
    expect(changeOffer(readingOf(later, "closed", T.sat730am)).deadline).toEqual({
      dueAt: T.sat1pm,
      dueZone: SHOP_ZONE,
      rule: "sameDay",
    });
  });

  it("7pm the day before keeps its wall clock across Sun Nov 1's clock change (S13-03)", () => {
    const monday = haircutWith({ visitStartsAt: T.visitMonNov2 });
    expect(changeOffer(readingOf(monday, "weather", T.sat31_9am)).deadline).toEqual({
      dueAt: T.sunNov1_7pmEst,
      dueZone: SHOP_ZONE,
      rule: "dayBefore",
    });
  });

  it("the clock home's cuts (S13-35): an hour left to act, and never past the visit's start", () => {
    expect(changeOffer(readingOf(haircutWith(), "proCantCome", T.fri830pm)).deadline).toEqual({
      dueAt: T.fri930pm,
      dueZone: SHOP_ZONE,
      rule: "timeToAct",
    });
    expect(changeOffer(readingOf(haircutWith(), "proCantCome", T.sat1030am)).deadline).toEqual({
      dueAt: T.visitSat11am,
      dueZone: SHOP_ZONE,
      rule: "visitStart",
    });
  });

  it("the deadline's zone is the visit's: a flow B visit address's when known, else the business's", () => {
    const request = {
      flow: "B" as const,
      visitStartsAt: T.visitSat11am,
      offeredAt: T.fri9am,
      businessZone: SHOP_ZONE,
    };
    // Saturday 11:00am EDT is 10:00am in Chicago, so 7pm Friday there is Sat 00:00Z.
    expect(offerDeadline({ ...request, visitAddressZone: "America/Chicago" })).toEqual({
      dueAt: "2026-10-24T00:00:00Z",
      dueZone: "America/Chicago",
      rule: "dayBefore",
    });
    expect(offerDeadline({ ...request, visitAddressZone: null })).toEqual({
      dueAt: T.fri7pm,
      dueZone: SHOP_ZONE,
      rule: "dayBefore",
    });
    expect(offerDeadline({ ...request, flow: "A", visitAddressZone: "America/Chicago" }).dueZone).toBe(
      SHOP_ZONE,
    );
  });

  it("a deadline is never read in UTC for want of a zone", () => {
    expect(() => offerFor("proCantCome", { businessZone: "Lees/Barbershop" })).toThrow(ChangeHomeError);
    expect(() => offerFor("proCantCome", { businessZone: "Lees/Barbershop" })).toThrow(
      "the visit's zone is not known",
    );
  });

  it("the registry's offerDeadline point names the rule: sameDay or dayBefore", () => {
    expect(changeRule("offerDeadline", { change: readingOf(haircutWith(), "proCantCome", T.sat730am) })).toBe(
      "sameDay",
    );
    expect(changeRule("offerDeadline", { change: readingOf(haircutWith(), "proCantCome", T.fri9am) })).toBe(
      "dayBefore",
    );
  });
});

describe("silence moves nobody, except the running-late case", () => {
  it("every reason, every booking: silence moves nobody, and only a pro running late moves the start", () => {
    let cases = 0;
    const outcomes = new Set<string>();
    for (const reason of CHANGE_REASONS)
      for (const named of [true, false, null] as const)
        for (const inCare of [true, false, null] as const)
          for (const holds of BOOKING_HOLDS)
            for (const sentNow of [true, false])
              for (const staffRuleHolds of [true, false, null] as const)
                for (const standIns of [[], [AVERY_SAME_PRICE]] as const) {
                  const offer = offerFor(reason, { named, inCare, holds, sentNow, staffRuleHolds }, standIns);
                  const at = `${reason} ${String(named)} ${String(inCare)} ${holds} ${String(sentNow)} ${String(staffRuleHolds)} ${String(standIns.length)}`;
                  cases += 1;
                  outcomes.add(offer.silence.outcome);
                  if (reason === "proRunningLate") {
                    expect(offer.silence, at).toEqual({ outcome: "laterStartStands", moves: "laterStart" });
                    continue;
                  }
                  expect(offer.silence.moves, at).toBe("nobody");
                  expect(offer.silence.outcome, at).not.toBe("laterStartStands");
                  // Nothing asked keeps the visit as booked; an offer calls it off on silence; nothing else.
                  if (offer.path === "offer") expect(offer.silence.outcome, at).toBe("callOff");
                  else if (offer.path === "businessStaffs")
                    expect(offer.silence.outcome, at).toBe("staysBooked");
                  else expect(offer.silence.outcome, at).toBe("none");
                }
    expect(cases).toBe(CHANGE_REASONS.length * 3 * 3 * BOOKING_HOLDS.length * 2 * 3 * 2);
    expect([...outcomes].sort()).toEqual(["callOff", "laterStartStands", "none", "staysBooked"]);
  });

  it("a pro running late: no reply keeps the later start; moving or cancelling is free; no other pro", () => {
    for (const named of [true, false, null] as const) {
      const offer = offerFor("proRunningLate", { named });
      expect(offer, String(named)).toEqual({
        path: "laterStart",
        notOffered: null,
        anotherPro: { offered: false, why: "noProOut", standIns: [], verdicts: [] },
        anotherTime: { offered: true, before: null },
        freeCancel: true,
        keepLaterStart: true,
        staffedBy: [],
        deadline: null,
        silence: { outcome: "laterStartStands", moves: "laterStart" },
        personReaches: "none",
        fee: "none",
        decides: haircut.decides,
      });
    }
    expect(changeRule("silenceMoves", { change: readingOf(haircutWith(), "proRunningLate") })).toBe(
      "laterStart",
    );
  });

  it("no answer by the deadline: that visit called off, no fee, with every choice free", () => {
    for (const reason of CHANGE_REASONS.filter(
      (each) => !["proRunningLate", "businessCloses", "businessCancels"].includes(each),
    )) {
      const offer = offerFor(reason);
      expect(offer.path, reason).toBe("offer");
      expect(offer.silence, reason).toEqual({ outcome: "callOff", moves: "nobody" });
      expect(offer.fee, reason).toBe("none");
      expect(offer.freeCancel, reason).toBe(true);
    }
  });
});

describe("no offer text carries the reason the pro is out", () => {
  const reasonLabels = CHANGE_REASONS.map((reason) => `"${reason}"`);

  it("every reason a pro is out gives the same offer, which holds no reason at all", () => {
    const bookings: readonly Partial<ChangeBooking>[] = [
      { named: false },
      { named: true },
      { inCare: null },
      { sentNow: true },
      { holds: "classSeat" },
    ];
    for (const facts of bookings) {
      const offers = PRO_OUT_REASONS.map((reason) => offerFor(reason, facts));
      for (const offer of offers) {
        expect(offer, JSON.stringify(facts)).toEqual(offers[0]);
        const json = JSON.stringify(offer);
        for (const label of reasonLabels) expect(json, label).not.toContain(label);
      }
    }
  });

  it("every ruling the registry gets is the same whichever reason the pro is out for, and sayWhyProOut is never", () => {
    const rulings = (reason: ChangeReason): string[] =>
      CHANGE_POINTS.map((point) => changeRule(point, { change: readingOf(haircutWith(), reason) }));
    const first = rulings("proCantCome");
    for (const reason of PRO_OUT_REASONS) expect(rulings(reason), reason).toEqual(first);
    expect(changeRule("sayWhyProOut", { change: readingOf(haircutWith(), "licenseLapse") })).toBe("never");
    expect(changeRule("sayWhyProOut", {})).toBe("never");
  });

  it("no answer names a reason, whatever the reason and whatever the booking", () => {
    for (const reason of CHANGE_REASONS)
      for (const named of [true, false] as const) {
        const json = JSON.stringify(offerFor(reason, { named }));
        for (const label of reasonLabels) expect(json, `${reason}: ${label}`).not.toContain(label);
      }
  });
});

describe("another pro only with the skill, no license lacking, the staff rules, a yes, at the same price or lower", () => {
  const verdictFor = (standIn: Partial<StandIn>, booked: Partial<ChangeBooking> = {}): string =>
    standInWhy(haircutWith(booked), { ...AVERY_SAME_PRICE, ...standIn });

  it("the price rule: the same price or lower is offered; a higher price, or one not known, is not", () => {
    expect(verdictFor({ price: USD_35 })).toBe("allowed");
    expect(verdictFor({ price: USD_35 }, { price: USD_40 })).toBe("allowed");
    expect(verdictFor({ price: USD_40 })).toBe("higherPrice");
    expect(verdictFor({ price: USD_55 }, { price: USD_40 })).toBe("higherPrice");
    expect(verdictFor({ price: null })).toBe("priceNotKnown");
    expect(verdictFor({ price: USD_35 }, { price: null })).toBe("priceNotKnown");
    expect(verdictFor({ price: { cents: 3500, currency: "EUR" } })).toBe("priceNotKnown");

    const higher = offerFor("proCantCome", {}, [{ ...AVERY_SAME_PRICE, price: USD_40 }]);
    expect(higher.anotherPro).toEqual({
      offered: false,
      why: "noneAllowed",
      standIns: [],
      verdicts: [{ personId: AVERY, why: "higherPrice" }],
    });
    const lower = offerFor("proCantCome", { price: USD_40 }, [AVERY_SAME_PRICE]);
    expect(lower.anotherPro.standIns).toEqual([AVERY]);
    expect(
      changeRule("anotherPro", {
        change: readingOf(haircutWith(), "proCantCome", T.fri9am, [{ ...AVERY_SAME_PRICE, price: USD_55 }]),
      }),
    ).toBe("no");
  });

  it("staff skills arrive with journey 2 (K-22): with no skill recorded, no other pro (fail closed)", () => {
    expect(verdictFor({ skill: null })).toBe("noSkillRecorded");
    expect(verdictFor({ skill: false })).toBe("noSkill");
    const offer = offerFor("proCantCome", {}, [{ ...AVERY_SAME_PRICE, skill: null }]);
    expect(offer.anotherPro).toEqual({
      offered: false,
      why: "noneAllowed",
      standIns: [],
      verdicts: [{ personId: AVERY, why: "noSkillRecorded" }],
    });
    expect(offer.anotherTime.offered && offer.freeCancel).toBe(true);
  });

  it("each other check fails closed: a yes, a license, the staff rules, and never the pro who is out", () => {
    expect(verdictFor({ saidYes: false })).toBe("noYes");
    expect(verdictFor({ licenseLacking: true })).toBe("licenseLacking");
    expect(verdictFor({ licenseLacking: null })).toBe("licenseNotKnown");
    expect(verdictFor({ staffRulesHold: false })).toBe("staffRules");
    expect(verdictFor({ staffRulesHold: null })).toBe("staffRulesNotKnown");
    expect(verdictFor({ personId: RILEY })).toBe("samePro");
    const two = offerFor("proCantCome", {}, [{ ...AVERY_SAME_PRICE, personId: RILEY }, AVERY_SAME_PRICE]);
    expect(two.anotherPro.standIns).toEqual([AVERY]);
    expect(two.anotherPro.verdicts).toEqual([
      { personId: RILEY, why: "samePro" },
      { personId: AVERY, why: "allowed" },
    ]);
  });

  it("only a pro out is covered by another pro: a closed day, a part, a tool, the weather or a class too few", () => {
    for (const reason of ["closed", "partLate", "toolOut", "weather", "tooFewBooked"] as const) {
      const offer = offerFor(reason);
      expect(offer.anotherPro, reason).toEqual({
        offered: false,
        why: "noProOut",
        standIns: [],
        verdicts: [],
      });
      expect(offer.anotherTime, reason).toEqual({ offered: true, before: null });
      expect(offer.freeCancel, reason).toBe(true);
      expect(offer.personReaches, reason).toBe("none");
    }
  });
});

describe("every journey's can't-make-it and leaving paths", () => {
  it("someone leaving, by asking, removal or quitting: their bookings get the choices above; access ends", () => {
    const cantCome = offerFor("proCantCome");
    for (const reason of LEAVING_REASONS) expect(offerFor(reason), reason).toEqual(cantCome);
    expect(leaverAccessEnds("removal")).toBe("atOnce");
    expect(leaverAccessEnds("leaves")).toBe("atSetTime");
    expect(leaverAccessEnds("quit")).toBe("atSetTime");
    expect(() => leaverAccessEnds("proCantCome")).toThrow("the reason is not someone leaving");
  });

  it("a business that closes, or calls the visit off: called off at once, no fee, nothing to answer", () => {
    for (const reason of ["businessCloses", "businessCancels"] as const) {
      const offer = offerFor(reason);
      expect(offer.path, reason).toBe("calledOff");
      expect(offer.deadline, reason).toBeNull();
      expect(offer.silence, reason).toEqual({ outcome: "none", moves: "nobody" });
      expect(offer.fee, reason).toBe("none");
    }
  });

  it("the owner can't act, and nobody else can: a free cancel with everything back, and Rosie's team acts", () => {
    const offer = offerFor("ownerCantAct");
    expect(offer.path).toBe("offer");
    expect(offer.anotherPro.offered).toBe(false);
    expect(offer.anotherTime.offered).toBe(false);
    expect(offer.freeCancel).toBe(true);
    expect(offer.personReaches).toBe("rosieTeam");
    expect(offer.silence).toEqual({ outcome: "callOff", moves: "nobody" });
  });

  it("a crew, class seat, party or drop-off where nobody was named, with no one in care: the business staffs it", () => {
    for (const holds of ["crew", "classSeat", "party", "dropOff"] as const) {
      const offer = offerFor("proCantCome", { holds, named: false, inCare: false, staffRuleHolds: true });
      expect(offer.path, holds).toBe("businessStaffs");
      expect(offer.silence, holds).toEqual({ outcome: "staysBooked", moves: "nobody" });
      expect(offer.anotherPro.offered || offer.anotherTime.offered || offer.freeCancel, holds).toBe(false);
      const asked: readonly Partial<ChangeBooking>[] = [
        { inCare: true },
        { inCare: null },
        { named: true },
        { staffRuleHolds: false },
        { staffRuleHolds: null },
      ];
      for (const facts of asked)
        expect(
          offerFor("proCantCome", { holds, named: false, inCare: false, staffRuleHolds: true, ...facts })
            .path,
          `${holds} ${JSON.stringify(facts)}`,
        ).toBe("offer");
    }
    expect(offerFor("proCantCome", { holds: "visit", staffRuleHolds: true }).path).toBe("offer");
  });

  it("a job sent now whose pro can't come: a stand-in who passes every check takes it, or it is called off", () => {
    const taken = offerFor("proCantCome", { sentNow: true });
    expect(taken.path).toBe("businessStaffs");
    expect(taken.staffedBy).toEqual([AVERY]);
    expect(taken.silence).toEqual({ outcome: "staysBooked", moves: "nobody" });
    const nobodyTakesIt: readonly (readonly StandIn[])[] = [[], [{ ...AVERY_SAME_PRICE, skill: null }]];
    for (const standIns of nobodyTakesIt) {
      const nobody = offerFor("proCantCome", { sentNow: true }, standIns);
      expect(nobody.path).toBe("calledOff");
      expect(nobody.staffedBy).toEqual([]);
    }
    expect(offerFor("proCantCome", { sentNow: true, named: null }).path).toBe("calledOff");
  });

  it("a need-by date: new times only before it", () => {
    const needBy = { year: 2026, month: 10, day: 30 };
    expect(offerFor("proCantCome", { needBy }).anotherTime).toEqual({ offered: true, before: needBy });
    expect(offerFor("proRunningLate", { needBy }).anotherTime).toEqual({ offered: true, before: needBy });
  });

  it("nothing is offered for a request, a visit under way or over, a death reported, or a visit begun", () => {
    expect(offerFor("proCantCome", { stage: "entry" }).notOffered).toBe("notBooked");
    expect(offerFor("proCantCome", { stage: "checked_in" }).notOffered).toBe("inProgress");
    expect(offerFor("proCantCome", { stage: "done" }).notOffered).toBe("over");
    expect(offerFor("proCantCome", { stage: "cancelled" }).notOffered).toBe("over");
    expect(changeOffer(readingOf(haircutWith(), "proCantCome", T.visitSat11am)).notOffered).toBe(
      "visitStarted",
    );
    const notBooked: readonly Partial<ChangeBooking>[] = [{ stage: "entry" }, { deceased: true }];
    for (const facts of notBooked) {
      const offer = offerFor("proCantCome", facts);
      expect(offer.path).toBe("notOffered");
      expect(offer.anotherPro.offered || offer.anotherTime.offered || offer.freeCancel).toBe(false);
      expect(offer.silence).toEqual({ outcome: "none", moves: "nobody" });
    }
  });

  it("a death reported on the booking (A7-81): the owner decides the rest, so nothing is offered", async () => {
    const read = await readBooking(shopReadsWith([DEATH_REPORTED]), DEATH_REPORTED.id);
    expect(read.deceased).toBe(true);
    expect(read.decides).toEqual({ ok: true, deciders: [{ personId: "person-sam", as: "owner" }] });
    expect(changeOffer(readingOf(bookingOf(read), "proCantCome")).notOffered).toBe("deceased");
  });

  it("nobody on the record may decide (a minor with no parent on file): no other pro, and a person reaches them", async () => {
    const reads = shopReadsWith([KIDS_CUT_FOR_SON], {
      [KIDS_CUT_FOR_SON.id]: { ageBand: "under_18", parentOrGuardianIds: [] },
    });
    const read = await readBooking(reads, KIDS_CUT_FOR_SON.id);
    expect(read.decides).toEqual({ ok: false, why: "noParentOrGuardian" });
    const offer = changeOffer(readingOf(bookingOf(read), "proCantCome"));
    expect(offer.anotherPro.why).toBe("nobodyDecides");
    expect(offer.anotherPro.offered).toBe(false);
    expect(offer.personReaches).toBe("owner");
    expect(offer.silence).toEqual({ outcome: "callOff", moves: "nobody" });
  });
});

describe("the change home in the home registry (T-586)", () => {
  const registryOn = (lines: HomeLogLine[] = []) =>
    createHomeRegistry<object>({
      flows,
      modules: [changeHome()],
      log: (line) => {
        lines.push(line);
      },
    });

  it("registers as the change home's one module, beside the stop, money, contact and clock homes, no point shared", () => {
    const modules: readonly HomeModule<never>[] = [
      changeHome(),
      stopHome(),
      moneyHome(),
      contactHome(),
      clockHomeModule,
    ];
    const registry = createHomeRegistry<never>({ flows, modules });
    expect(registry.entry("change")).toEqual({
      home: "change",
      step: "S13-56",
      layer: "actions",
      module: "actions/src/homes/change",
      task: "T-594",
      via: "homeModule",
      built: true,
    });
    expect(changeHome().points).toEqual(CHANGE_POINTS);
  });

  it("a step's words that move a named booking on silence, offer a stand-in or say why: the home wins, logged", () => {
    const lines: HomeLogLine[] = [];
    const registry = registryOn(lines);
    expect(registry.follows("A", "S11-106")).toEqual([]);
    const change = readingOf(haircutWith({ named: true }), "proCantCome");
    const settled = registry.settle({
      flow: "A",
      step: "S11-106",
      claims: [
        { home: "change", point: "silenceMoves", value: "toStandIn" },
        { home: "change", point: "anotherPro", value: "offer" },
        { home: "change", point: "sayWhyProOut", value: "say" },
      ],
      context: { change },
    });
    expect(settled).toMatchObject({
      run: true,
      rulings: {
        changePath: "offer",
        anotherPro: "no",
        anotherTime: "offer",
        freeCancel: "offer",
        offerDeadline: "dayBefore",
        silenceOutcome: "callOff",
        silenceMoves: "nobody",
        personReaches: "owner",
        notReached: "ownerListThenTeam",
        changeFee: "none",
        sayWhyProOut: "never",
        bareOk: "askWhich",
      },
      own: [],
    });
    expect(
      lines.map((line) => [line.msg, line.home, line.home_step, line.point, line.step_said, line.home_said]),
    ).toEqual([
      ["home_wins", "change", "S13-56", "silenceMoves", "toStandIn", "nobody"],
      ["home_wins", "change", "S13-56", "anotherPro", "offer", "no"],
      ["home_wins", "change", "S13-56", "sayWhyProOut", "say", "never"],
    ]);
    for (const line of lines)
      for (const value of Object.values(line)) expect(isLabel(value), String(value)).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(" ");
  });

  it("a step about no booking (S1-03's stand-ins block, 'Nobody moves on silence') settles on the rules alone, failing closed", () => {
    const form = objAt(flows.A, ["steps", "S1-03"]).form;
    expect(form).toContainEqual([
      "7 Stand-ins",
      "Nobody moves on silence · the one path when a pro can't come (S13-56)",
    ]);
    const lines: HomeLogLine[] = [];
    const settled = registryOn(lines).settle({
      flow: "A",
      step: "S1-03",
      claims: [{ home: "change", point: "silenceMoves", value: "nobody" }],
      context: {},
    });
    expect(settled).toEqual({
      run: true,
      flow: "A",
      step: "S1-03",
      rulings: {
        changePath: "offer",
        anotherPro: "no",
        anotherTime: "offer",
        freeCancel: "offer",
        offerDeadline: "dayBeforeOrSameDay",
        silenceOutcome: "callOff",
        silenceMoves: "nobody",
        personReaches: "owner",
        notReached: "ownerListThenTeam",
        changeFee: "none",
        sayWhyProOut: "never",
        bareOk: "askWhich",
      },
      differences: [],
      own: [],
    });
    expect(lines).toEqual([]);
  });

  it("every ruling is a label, on every path; a point it does not settle is refused by label", () => {
    const readings: ChangeReading[] = [
      ...CHANGE_REASONS.map((reason) => readingOf(haircutWith(), reason)),
      readingOf(haircutWith({ stage: "done" }), "proCantCome"),
      readingOf(haircutWith({ holds: "party" }), "quit"),
      readingOf(haircutWith({ sentNow: true }), "removal", T.fri9am, []),
    ];
    for (const change of readings)
      for (const point of CHANGE_POINTS)
        expect(isLabel(changeRule(point, { change })), `${change.reason} ${point}`).toBe(true);
    expect(() => changeRule("chargeOnSilence", {})).toThrow(
      "chargeOnSilence is not a point of the change home",
    );
    expect(() => changeRule("a stand-in moves them", {})).toThrow(
      "the point given is not a point of the change home",
    );
  });
});

describe("reads: the K-04 v1 head and who decides (T-308), for the call's business only", () => {
  it("another business's booking, or none, is never answered; a request with no booking is refused", async () => {
    const reads = shopReads();
    expect(await readChangeBooking(reads, WORKSHOP)).toBeNull();
    expect(await readChangeBooking(reads, "booking-nobody")).toBeNull();
    await expect(readChangeBooking(reads, " ")).rejects.toThrow("the request names no booking");
  });

  it("a head whose id is not the one asked for is no answer", async () => {
    const reads = shopReads();
    const stray = { ...reads, bookingHead: () => reads.bookingHead(HAIRCUT) };
    expect(await readChangeBooking(stray, KIDS_CUT_FOR_SON.id)).toBeNull();
  });
});

describe("a reading the change home cannot read is refused, naming the field, never a value", () => {
  const refused = (reading: unknown): ChangeHomeError => {
    try {
      changeOffer(reading as ChangeReading);
    } catch (error) {
      if (error instanceof ChangeHomeError) return error;
      throw error;
    }
    throw new Error("the reading was not refused");
  };

  it("a reason it does not know, a booking with no id, a bad price, a stand-in it cannot read, no time", () => {
    const good = readingOf(haircutWith(), "proCantCome");
    expect(refused({ ...good, reason: "sick" }).problems).toEqual([
      "the reason is not one the change home knows",
    ]);
    expect(refused({ ...good, booking: { ...good.booking, bookingId: "" } }).problems).toEqual([
      "the booking has no id",
    ]);
    expect(
      refused({ ...good, booking: { ...good.booking, price: { cents: 35.5, currency: "USD" } } }).problems,
    ).toEqual(["the booked price is not minor units with a currency"]);
    expect(refused({ ...good, standIns: [{ ...AVERY_SAME_PRICE, skill: "yes" }] }).problems).toEqual([
      "stand-in 1's skill is not true, false or not known",
    ]);
    expect(refused({ ...good, offeredAt: "Friday" }).problems).toEqual([
      "the offer's time is not an instant",
    ]);
    expect(
      refused({ ...good, booking: { ...good.booking, decides: { ok: true, deciders: [] } } }).problems,
    ).toEqual(["who decides the visit is not T-308's answer"]);
    expect(refused(null).message).toBe("the change home was given no reading");
  });

  it("no message carries a value it was given", () => {
    const good = readingOf(haircutWith(), "proCantCome");
    const errors = [
      refused({ ...good, reason: "sick" }),
      refused({ ...good, booking: { ...good.booking, holds: "a crew of four" } }),
      refused({
        ...good,
        standIns: [
          { ...AVERY_SAME_PRICE, personId: "" },
          { ...AVERY_SAME_PRICE, price: { cents: 3500, currency: "dollars" } },
        ],
      }),
    ];
    for (const error of errors)
      for (const value of ["sick", "a crew of four", "dollars", AVERY, HAIRCUT, ALEX])
        expect(error.message, value).not.toContain(value);
  });
});
