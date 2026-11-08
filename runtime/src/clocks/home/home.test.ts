// The clock home (T-591; C-055; S13-35, S13-02, S13-03), run by `npm run test:unit -- runtime/src/clocks/home`. The card's
// checks first: a deadline that would pass the visit is cut to end before it; free cancel ending at noon the day before
// gives a 6pm reminder two evenings before; never two reminders for one booked time; a job sent now gets the urgent clock
// at 2am. Then text hours (9am to 8pm, the owner's and team's from 8am, ending before 8pm as limit 8 reads them: 8:00pm
// itself is outside and 7:59pm the last minute, DL-180), a deadline shown in another zone, and the registry's module.
// Every expected time is worked out by hand from the zone facts below, across the daylight-saving change of Sun Nov 1,
// 2026. Limit 8's own text-hours check (../../dispatch/limit8/text-hours.ts) is imported read-only to hold the home to it.
//
// Zone facts (IANA): America/New_York is UTC-4 (EDT) until 2026-11-01T06:00Z and UTC-5 (EST) after; America/Los_Angeles
// is UTC-7 (PDT) until 2026-11-01T09:00Z and UTC-8 (PST) after; America/Detroit keeps New York's clock. Sat Oct 24, 2026
// at 11am is the master's visit (A7-01); A7-03's values are the contract fixture's (arm-clock.json). Test values only
// (rule 9).
import { describe, expect, it } from "vitest";

import armClock from "../../../../contracts/data-access/fixtures/arm-clock.json";
import { CUSTOMER_OPENS, STAFF_OPENS } from "../../dispatch/limit8/limit8";
import { checkTextHours, minutesOf, type TextWindow } from "../../dispatch/limit8/text-hours";
import { isLabel } from "../../trace";
import { dueOf, DueError } from "../due";
import { instantAtLocal, localDateOf } from "../zone";
import {
  CLOCK_HOME_POINTS,
  clockHomeModule,
  fitDeadline,
  homeDueOf,
  homeNeverDeliveredDueOf,
  inTextHours,
  lastInTextHours,
  nextInTextHours,
  reminderKeyOf,
  reminderOf,
  remindersOf,
  shownTimes,
  textHoursAfter,
  urgentDue,
  wallTimeOf,
  type Audience,
  type HomeDueInput,
  type ReminderInput,
} from "./index";

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const DETROIT = "America/Detroit";
const HOUR = 3_600_000;
const MINUTE = 60_000;

const ms = (iso: string): number => Date.parse(iso);
const iso = (instant: number): string => new Date(instant).toISOString().replace(".000Z", "Z");

/** H04's default text hours, 8am to 8pm (K-04 businesses.text_hours_start and text_hours_end), as limit 8 reads them. */
const H04_HOURS = { start: "08:00", end: "20:00" };

function minutesOfTime(time: string): number {
  const minutes = minutesOf(time);
  if (minutes === null) throw new Error(`${time} is not a time`);
  return minutes;
}

/**
 * The window limit 8 checks a routine send against (limit8.ts windowFor): the business's H04 hours, opened no earlier
 * than the audience's hour (9am for a customer, 8am for the owner and team), ending at H04's "20:00", exclusive.
 */
function limit8Window(audience: Audience): TextWindow {
  const floor = minutesOfTime(audience === "customer" ? CUSTOMER_OPENS : STAFF_OPENS);
  return {
    startMinutes: Math.max(minutesOfTime(H04_HOURS.start), floor),
    endMinutes: minutesOfTime(H04_HOURS.end),
  };
}

/** Limit 8's own text-hours check at send, in New York: true when it would let a routine text go at the instant. */
const limit8Sends = (at: number, audience: Audience): boolean =>
  checkTextHours(at, NY, limit8Window(audience)).inside;

/** A question's clock as the arming would ask the home for it: a customer's set-time question in New York. */
function question(over: Partial<HomeDueInput>): HomeDueInput {
  return {
    deliveredAt: "2026-10-23T14:00:00Z",
    clockLine: null,
    visitStartsAt: "2026-10-24T15:00:00Z",
    zone: NY,
    audience: "customer",
    urgentClockMs: null,
    ...over,
  };
}

/** Sat Oct 24's 11am visit (A7-01), booked Mon Oct 19, with free cancel ending at the given time. */
function saturdayVisit(freeCancelEndsAt: string | null, over: Partial<ReminderInput> = {}): ReminderInput {
  return {
    bookingId: "bk-alex-haircut",
    startsAt: "2026-10-24T15:00:00Z",
    freeCancelEndsAt,
    zone: NY,
    bookedAt: "2026-10-19T14:00:00Z",
    sentNow: false,
    ...over,
  };
}

describe("a deadline that would pass the visit is cut to end before it (S13-35; RULES 5.1)", () => {
  it("cuts a deadline past an 11am visit to the visit's start, which is inside text hours", () => {
    const held = fitDeadline({
      dueAt: "2026-10-25T14:00:00Z",
      from: "2026-10-23T14:00:00Z",
      visitStartsAt: "2026-10-24T15:00:00Z",
      zone: NY,
      audience: "customer",
    });
    expect(held).toEqual({
      dueAt: "2026-10-24T15:00:00Z",
      dueZone: NY,
      fit: "visitStart",
      cutByVisit: true,
      inTextHours: true,
    });
  });

  it("cuts a deadline past a 7am visit back to 7:59pm the evening before, inside text hours and before the visit", () => {
    // Fri Oct 23 10am to Sat 10am passes Sat's 7am visit; 7am is before a customer's 9am, and 8:00pm itself is outside
    // text hours, so 7:59pm Fri EDT = 23:59Z Fri.
    const held = fitDeadline({
      dueAt: "2026-10-24T14:00:00Z",
      from: "2026-10-23T14:00:00Z",
      visitStartsAt: "2026-10-24T11:00:00Z",
      zone: NY,
      audience: "customer",
    });
    expect(held).toEqual({
      dueAt: "2026-10-23T23:59:00Z",
      dueZone: NY,
      fit: "earlier",
      cutByVisit: true,
      inTextHours: true,
    });
    expect(ms(held.dueAt)).toBeLessThan(ms("2026-10-24T11:00:00Z"));
    expect(limit8Sends(ms(held.dueAt), "customer")).toBe(true);
  });

  it("holds step 9's own visit-start cap to text hours: a 24 h Clock line for a 7am visit ends 7:59pm the evening before", () => {
    const due = homeDueOf(question({ clockLine: "24 h", visitStartsAt: "2026-10-24T11:00:00Z" }));
    expect(due).toEqual({
      dueAt: "2026-10-23T23:59:00Z",
      dueZone: NY,
      fit: "earlier",
      cutByVisit: true,
      inTextHours: true,
      branch: "visitStart",
      clockLineUnread: false,
    });
  });

  it("across the daylight-saving change: a 48 h Clock line for Mon Nov 2's 7am EST visit ends Sun Nov 1 at 7:59pm EST", () => {
    // Delivered Sat Oct 31 10am EDT (14:00Z); 48 h passes Mon 7am EST (12:00Z). 7:59pm EST Sun = 00:59Z Mon, not EDT's
    // 23:59Z Sun.
    const due = homeDueOf(
      question({
        deliveredAt: "2026-10-31T14:00:00Z",
        clockLine: "48 h",
        visitStartsAt: "2026-11-02T12:00:00Z",
      }),
    );
    expect(due.dueAt).toBe("2026-11-02T00:59:00Z");
    expect(due.fit).toBe("earlier");
    expect(due.cutByVisit).toBe(true);
    expect(limit8Sends(ms(due.dueAt), "customer")).toBe(true);
  });

  it("keeps the audience's own hours: an 8am visit holds an owner's deadline, but a customer's ends the evening before", () => {
    const input = {
      dueAt: "2026-10-25T14:00:00Z",
      from: "2026-10-23T14:00:00Z",
      visitStartsAt: "2026-10-24T12:00:00Z",
      zone: NY,
    };
    expect(fitDeadline({ ...input, audience: "owner" }).dueAt).toBe("2026-10-24T12:00:00Z");
    expect(fitDeadline({ ...input, audience: "team" }).dueAt).toBe("2026-10-24T12:00:00Z");
    expect(fitDeadline({ ...input, audience: "customer" }).dueAt).toBe("2026-10-23T23:59:00Z");
  });

  it("moves a night deadline to 9am when that is still before the visit (the earliest safe moment in text hours)", () => {
    // Delivered Fri 7:30pm EDT: step 9's floor is 8:30pm, outside text hours; Sat 9am EDT (13:00Z) is before the 2pm visit.
    const input = question({ deliveredAt: "2026-10-23T23:30:00Z", visitStartsAt: "2026-10-24T18:00:00Z" });
    expect(dueOf(input).dueAt).toBe("2026-10-24T00:30:00Z");
    const due = homeDueOf(input);
    expect(due.dueAt).toBe("2026-10-24T13:00:00Z");
    expect(due.fit).toBe("later");
    expect(due.branch).toBe("deliveryFloor");
    expect(due.inTextHours).toBe(true);
  });

  it("keeps step 9's time, by the visit, when no moment in text hours leaves time to act before it", () => {
    // Delivered Fri 7:30pm EDT for Sat 7am: 9am passes the visit, and 8pm Fri is under the hour after delivery.
    const due = homeDueOf(
      question({ deliveredAt: "2026-10-23T23:30:00Z", visitStartsAt: "2026-10-24T11:00:00Z" }),
    );
    expect(due).toMatchObject({ dueAt: "2026-10-24T00:30:00Z", fit: "asGiven", inTextHours: false });
    expect(ms(due.dueAt)).toBeLessThan(ms("2026-10-24T11:00:00Z"));
  });

  it("leaves a deadline already inside text hours and before the visit as it is: A7-03's arm-clock.json due time", () => {
    const due = homeDueOf(
      question({
        deliveredAt: armClock.request.deliveredAt,
        clockLine: "24 h",
        visitStartsAt: "2026-10-24T15:00:00Z",
        zone: armClock.request.dueZone,
      }),
    );
    expect(due).toMatchObject({
      dueAt: armClock.request.dueAt,
      dueZone: armClock.request.dueZone,
      fit: "asGiven",
      cutByVisit: false,
      inTextHours: true,
      branch: "clockLine",
    });
  });

  it("moves step 9's 8pm with no visit back a minute to 7:59pm: 8:00pm itself is outside text hours", () => {
    // Delivered Fri 2pm EDT: step 9 gives Sat 8pm EDT (00:00Z Sun), which limit 8 holds to Sun 9am; 7:59pm Sat goes.
    const input = question({ deliveredAt: "2026-10-23T18:00:00Z", visitStartsAt: null });
    expect(dueOf(input).dueAt).toBe("2026-10-25T00:00:00Z");
    expect(limit8Sends(ms("2026-10-25T00:00:00Z"), "customer")).toBe(false);
    const due = homeDueOf(input);
    expect(due).toMatchObject({
      dueAt: "2026-10-24T23:59:00Z",
      fit: "earlier",
      branch: "noVisit",
      inTextHours: true,
    });
    expect(limit8Sends(ms(due.dueAt), "customer")).toBe(true);
  });

  it("holds the never-delivered path to the visit and the owner's text hours: a 7am visit's applies 7:59pm the evening before", () => {
    const visit = homeNeverDeliveredDueOf({
      sentAt: "2026-10-23T19:00:00Z",
      visitStartsAt: "2026-10-24T11:00:00Z",
      zone: NY,
      audience: "owner",
      urgentClockMs: null,
    });
    expect(visit).toEqual({
      dueAt: "2026-10-23T23:59:00Z",
      dueZone: NY,
      fit: "earlier",
      cutByVisit: true,
      inTextHours: true,
      branch: "visitStart",
    });
    const noVisit = homeNeverDeliveredDueOf({
      sentAt: "2026-10-23T19:00:00Z",
      visitStartsAt: null,
      zone: NY,
      audience: "owner",
      urgentClockMs: null,
    });
    expect(noVisit).toMatchObject({ dueAt: "2026-10-24T23:59:00Z", fit: "earlier", branch: "dayAfterSend" });
  });

  it("moves any due time that would land at 8:00pm itself to 7:59pm: a Clock line, and a visit at 8pm", () => {
    // Delivered Thu Oct 22 8pm EDT, a 24 h Clock line lands on Fri 8pm EDT (00:00Z Sat): 7:59pm Fri, not Sat's 9am.
    const clockLine = homeDueOf(
      question({
        deliveredAt: "2026-10-23T00:00:00Z",
        clockLine: "24 h",
        visitStartsAt: "2026-10-24T15:00:00Z",
      }),
    );
    expect(clockLine).toMatchObject({
      dueAt: "2026-10-23T23:59:00Z",
      fit: "earlier",
      cutByVisit: false,
      inTextHours: true,
      branch: "clockLine",
    });
    // A deadline past Sat's 8pm visit is cut to 8pm, then back a minute: still before the visit.
    for (const audience of ["customer", "owner", "team"] as const) {
      const visit = fitDeadline({
        dueAt: "2026-10-25T14:00:00Z",
        from: "2026-10-23T14:00:00Z",
        visitStartsAt: "2026-10-25T00:00:00Z",
        zone: NY,
        audience,
      });
      expect(visit).toEqual({
        dueAt: "2026-10-24T23:59:00Z",
        dueZone: NY,
        fit: "earlier",
        cutByVisit: true,
        inTextHours: true,
      });
      expect(limit8Sends(ms(visit.dueAt), audience)).toBe(true);
    }
  });

  it("keeps the hour to act at 8:00pm: when 7:59pm would leave under an hour, 9am if still by the visit, else flagged", () => {
    // Delivered Fri 7pm EDT (23:00Z): step 9's floor is Fri 8pm itself, and 7:59pm is under the hour after delivery.
    const byTwo = question({ deliveredAt: "2026-10-23T23:00:00Z", visitStartsAt: "2026-10-24T18:00:00Z" });
    expect(dueOf(byTwo)).toMatchObject({ dueAt: "2026-10-24T00:00:00Z", branch: "deliveryFloor" });
    expect(homeDueOf(byTwo)).toMatchObject({
      dueAt: "2026-10-24T13:00:00Z",
      fit: "later",
      inTextHours: true,
    });
    // For Sat's 7am visit no moment inside text hours both leaves the hour and comes by the visit: kept, flagged.
    const bySeven = question({ deliveredAt: "2026-10-23T23:00:00Z", visitStartsAt: "2026-10-24T11:00:00Z" });
    expect(homeDueOf(bySeven)).toMatchObject({
      dueAt: "2026-10-24T00:00:00Z",
      fit: "asGiven",
      inTextHours: false,
    });
  });

  it("over every delivery for two days across Nov 1: never past the visit, inside text hours whenever any moment allows, as limit 8 reads them", () => {
    const visits = [
      "2026-11-01T11:00:00Z", // Sun 6am EST
      "2026-11-01T15:00:00Z", // Sun 10am EST
      "2026-11-02T00:30:00Z", // Sun 7:30pm EST
      "2026-11-02T12:30:00Z", // Mon 7:30am EST
      "2026-11-02T19:00:00Z", // Mon 2pm EST
    ];
    const audiences: Audience[] = ["customer", "team"];
    let checked = 0;
    for (const audience of audiences)
      for (const visitStartsAt of visits)
        for (
          let delivered = ms("2026-10-30T04:00:00Z");
          delivered < ms(visitStartsAt);
          delivered += 20 * MINUTE
        ) {
          const input = question({ deliveredAt: iso(delivered), visitStartsAt, audience });
          const due = homeDueOf(input);
          const at = ms(due.dueAt);
          const floor = delivered + HOUR;
          const visit = ms(visitStartsAt);
          expect(at).toBeLessThanOrEqual(visit);
          expect(at).toBeGreaterThanOrEqual(Math.min(ms(dueOf(input).dueAt), floor));
          expect(due.inTextHours).toBe(inTextHours(at, NY, audience));
          // Outside text hours only when no moment inside them lies between the hour after delivery and the visit.
          if (!due.inTextHours) expect(lastInTextHours(visit, NY, audience)).toBeLessThan(floor);
          // Limit 8's own check at send agrees (DL-180): every due time marked inside text hours passes it, never at or
          // after 8:00pm, and one marked outside would be held.
          expect(limit8Sends(at, audience)).toBe(due.inTextHours);
          checked += 1;
        }
    expect(checked).toBeGreaterThan(1000);
  });

  it("refuses a zone the platform does not know and a time that is not one", () => {
    const base = {
      dueAt: "2026-10-24T14:00:00Z",
      from: "2026-10-23T14:00:00Z",
      visitStartsAt: null,
      zone: NY,
      audience: "customer" as const,
    };
    expect(() => fitDeadline({ ...base, zone: "Mars/Olympus" })).toThrow(DueError);
    expect(() => fitDeadline({ ...base, dueAt: "Friday" })).toThrow(DueError);
    expect(() => homeDueOf(question({ zone: "" }))).toThrow(DueError);
  });
});

describe("free cancel ending at noon the day before gives a 6pm reminder two evenings before (S13-35; RULES 5.4)", () => {
  it("free cancel ends Fri at noon for Sat's 11am visit: the reminder goes Thu at 6pm", () => {
    expect(reminderOf(saturdayVisit("2026-10-23T16:00:00Z"))).toEqual({
      key: "reminder/bk-alex-haircut/2026-10-24T15:00:00Z",
      startsAt: "2026-10-24T15:00:00Z",
      remindAt: "2026-10-22T22:00:00Z",
      zone: NY,
      rule: "beforeFreeCancel",
      none: null,
    });
  });

  it("A7-01's own case: free cancel ends Fri at 11am, so it goes Thu Oct 22 at 6pm", () => {
    expect(reminderOf(saturdayVisit("2026-10-23T15:00:00Z")).remindAt).toBe("2026-10-22T22:00:00Z");
  });

  it("usually 10am the day before: no cutoff, or free cancel ending at 1pm or later the day before", () => {
    expect(reminderOf(saturdayVisit(null))).toMatchObject({
      remindAt: "2026-10-23T14:00:00Z",
      rule: "dayBefore",
    });
    expect(reminderOf(saturdayVisit("2026-10-23T17:00:00Z"))).toMatchObject({
      remindAt: "2026-10-23T14:00:00Z",
      rule: "dayBefore",
    });
    // A minute before 1pm leaves 10am less than 3 hours before the cutoff: back to 6pm Thu.
    expect(reminderOf(saturdayVisit("2026-10-23T16:59:00Z")).remindAt).toBe("2026-10-22T22:00:00Z");
  });

  it("B7-01's case: free cancel until 7am Thu for Thu's 8am visit, so Wed at 10am", () => {
    const reminder = reminderOf(
      saturdayVisit("2026-10-22T11:00:00Z", {
        startsAt: "2026-10-22T12:00:00Z",
        bookedAt: "2026-10-15T14:00:00Z",
      }),
    );
    expect(reminder).toMatchObject({ remindAt: "2026-10-21T14:00:00Z", rule: "dayBefore" });
  });

  it("across the daylight-saving change: noon Sun Nov 1 EST for Mon's 11am gives Sat Oct 31 at 6pm EDT", () => {
    const monday = { startsAt: "2026-11-02T16:00:00Z", bookedAt: "2026-10-26T14:00:00Z" };
    expect(reminderOf(saturdayVisit("2026-11-01T17:00:00Z", monday)).remindAt).toBe("2026-10-31T22:00:00Z");
    expect(reminderOf(saturdayVisit(null, monday)).remindAt).toBe("2026-11-01T15:00:00Z");
  });

  it("a cutoff earlier still walks back through the reminder hours, 6pm then 10am", () => {
    expect(reminderOf(saturdayVisit("2026-10-22T15:00:00Z")).remindAt).toBe("2026-10-21T22:00:00Z"); // Thu 11am: Wed 6pm
    expect(reminderOf(saturdayVisit("2026-10-23T02:00:00Z")).remindAt).toBe("2026-10-22T22:00:00Z"); // Thu 10pm: Thu 6pm
    expect(reminderOf(saturdayVisit("2026-10-23T00:00:00Z")).remindAt).toBe("2026-10-22T14:00:00Z"); // Thu 8pm: Thu 10am
  });

  it("for every cutoff over four days: the latest reminder hour at least 3 hours before it, in text hours, before the visit", () => {
    const visit = ms("2026-11-02T16:00:00Z"); // Mon Nov 2, 11am EST
    const dayBefore = instantAtLocal(NY, localDateOf(visit, NY), -1, 10);
    for (let cutoff = visit - 96 * HOUR; cutoff <= visit + 2 * HOUR; cutoff += 30 * MINUTE) {
      const reminder = reminderOf(
        saturdayVisit(iso(cutoff), { startsAt: iso(visit), bookedAt: "2026-10-20T14:00:00Z" }),
      );
      expect(reminder.remindAt).not.toBeNull();
      const at = ms(reminder.remindAt ?? "");
      const latest = Math.min(cutoff - 3 * HOUR, dayBefore);
      const wall = wallTimeOf(at, NY);
      expect(at).toBeLessThanOrEqual(latest);
      expect(at).toBeLessThan(visit);
      expect(inTextHours(at, NY, "customer")).toBe(true);
      expect([10, 18]).toContain(wall.hour);
      expect(wall.minute).toBe(0);
      // The latest such hour: the next reminder hour after it would be too late.
      const date = localDateOf(at, NY);
      const next = wall.hour === 10 ? instantAtLocal(NY, date, 0, 18) : instantAtLocal(NY, date, 1, 10);
      expect(next).toBeGreaterThan(latest);
    }
  });
});

describe("never two reminders for one booked time (S13-35; RULES 5.4)", () => {
  it("asking twice for one booked time gives the one reminder, however the time is written", () => {
    const first = reminderOf(saturdayVisit("2026-10-23T16:00:00Z"));
    expect(reminderOf(saturdayVisit("2026-10-23T16:00:00Z"))).toEqual(first);
    const sameTime = reminderOf(
      saturdayVisit("2026-10-23T12:00:00-04:00", { startsAt: "2026-10-24T11:00:00.000-04:00" }),
    );
    expect(sameTime).toEqual(first);
    expect(reminderKeyOf("bk-alex-haircut", "2026-10-24T11:00:00-04:00")).toBe(first.key);
    expect(isLabel(first.key)).toBe(true);
  });

  it("folds a booking's times into one reminder per start, each later day its own, at the earliest cutoff given", () => {
    const request = {
      bookingId: "bk-alex-two-days",
      zone: NY,
      bookedAt: "2026-10-19T14:00:00Z",
      sentNow: false,
      times: [
        { startsAt: "2026-10-25T15:00:00Z", freeCancelEndsAt: null }, // Sun 11am, a second day
        { startsAt: "2026-10-24T15:00:00Z", freeCancelEndsAt: "2026-10-23T17:00:00Z" }, // Sat 11am, Fri 1pm
        { startsAt: "2026-10-24T15:00:00Z", freeCancelEndsAt: "2026-10-23T16:00:00Z" }, // the same time, Fri noon
        { startsAt: "2026-10-24T11:00:00-04:00", freeCancelEndsAt: null }, // the same time again
      ],
    };
    const reminders = remindersOf(request);
    expect(reminders.map((reminder) => [reminder.key, reminder.remindAt])).toEqual([
      ["reminder/bk-alex-two-days/2026-10-24T15:00:00Z", "2026-10-22T22:00:00Z"],
      ["reminder/bk-alex-two-days/2026-10-25T15:00:00Z", "2026-10-24T14:00:00Z"],
    ]);
    expect(new Set(reminders.map((reminder) => reminder.key)).size).toBe(reminders.length);
    expect(remindersOf(request)).toEqual(reminders);
  });

  it("a booking made after the reminder's time gets none: its confirmation carried the facts", () => {
    const late = reminderOf(saturdayVisit("2026-10-23T16:00:00Z", { bookedAt: "2026-10-22T23:00:00Z" }));
    expect(late).toMatchObject({ remindAt: null, rule: null, none: "inConfirmation" });
    const inTime = reminderOf(saturdayVisit("2026-10-23T16:00:00Z", { bookedAt: "2026-10-22T21:00:00Z" }));
    expect(inTime.remindAt).toBe("2026-10-22T22:00:00Z");
  });

  it("refuses a booking id that is not a label, and a time that is not one", () => {
    expect(() => reminderOf(saturdayVisit(null, { bookingId: "Alex's haircut" }))).toThrow(DueError);
    expect(() => reminderOf(saturdayVisit("tomorrow"))).toThrow(DueError);
    expect(() => reminderOf(saturdayVisit(null, { zone: "Mars/Olympus" }))).toThrow(DueError);
  });
});

describe("a job sent now gets the urgent clock at 2am (S13-35; RULES 5.5)", () => {
  const twoAm = "2026-11-03T07:00:00Z"; // Tue Nov 3, 2:00am EST

  it("a question on a job sent now at 2am is due on the plug-in's urgent clock, at night, not held to text hours", () => {
    const due = homeDueOf(
      question({
        deliveredAt: twoAm,
        clockLine: "24 h",
        visitStartsAt: "2026-11-03T07:45:00Z",
        urgentClockMs: 5 * MINUTE,
      }),
    );
    expect(due).toEqual({
      dueAt: "2026-11-03T07:05:00Z",
      dueZone: NY,
      fit: "urgent",
      cutByVisit: false,
      inTextHours: false,
      branch: null,
      clockLineUnread: false,
    });
  });

  it("the same question on a set time waits for text hours instead", () => {
    // Same day, 9:30am EST visit: step 9 gives 7:30am, before a customer's 9am, so 9am EST (14:00Z).
    const due = homeDueOf(question({ deliveredAt: twoAm, visitStartsAt: "2026-11-03T14:30:00Z" }));
    expect(due).toMatchObject({ dueAt: "2026-11-03T14:00:00Z", fit: "later", branch: "sameDay" });
  });

  it("the urgent clock never runs past the arrival estimate", () => {
    const due = urgentDue({
      from: twoAm,
      urgentClockMs: 30 * MINUTE,
      arrivalAt: "2026-11-03T07:20:00Z",
      zone: NY,
      audience: "team",
    });
    expect(due).toMatchObject({ dueAt: "2026-11-03T07:20:00Z", fit: "urgent", cutByVisit: true });
  });

  it("the never-delivered path on a job sent now runs on the urgent clock too", () => {
    const due = homeNeverDeliveredDueOf({
      sentAt: twoAm,
      visitStartsAt: null,
      zone: NY,
      audience: "owner",
      urgentClockMs: 5 * MINUTE,
    });
    expect(due).toMatchObject({ dueAt: "2026-11-03T07:05:00Z", fit: "urgent", branch: null });
  });

  it("a job sent now gets no reminder (B7-55)", () => {
    expect(reminderOf(saturdayVisit("2026-10-23T16:00:00Z", { sentNow: true }))).toMatchObject({
      remindAt: null,
      none: "sentNow",
    });
  });

  it("refuses an urgent clock that is not a length of time", () => {
    for (const urgentClockMs of [0, -MINUTE, 1.5, Number.NaN])
      expect(() =>
        urgentDue({ from: twoAm, urgentClockMs, arrivalAt: null, zone: NY, audience: "customer" }),
      ).toThrow(DueError);
  });
});

describe("text hours: 9am to 8pm in the person's zone, the owner's and team's from 8am (RULES 4.3)", () => {
  it("opens at 9am for a customer and 8am for the owner and team, and 7:59pm is the last minute: 8:00pm is outside", () => {
    expect(inTextHours(ms("2026-10-23T13:00:00Z"), NY, "customer")).toBe(true); // 9:00am EDT
    expect(inTextHours(ms("2026-10-23T12:59:59Z"), NY, "customer")).toBe(false);
    expect(inTextHours(ms("2026-10-23T12:00:00Z"), NY, "owner")).toBe(true); // 8:00am EDT
    expect(inTextHours(ms("2026-10-23T11:59:59Z"), NY, "team")).toBe(false);
    expect(inTextHours(ms("2026-10-23T23:59:00Z"), NY, "customer")).toBe(true); // 7:59pm EDT
    expect(inTextHours(ms("2026-10-23T23:59:59Z"), NY, "team")).toBe(true);
    expect(inTextHours(ms("2026-10-24T00:00:00Z"), NY, "customer")).toBe(false); // 8:00pm EDT
    expect(inTextHours(ms("2026-10-24T00:00:00Z"), NY, "owner")).toBe(false);
    expect(inTextHours(ms("2026-10-24T00:00:01Z"), NY, "owner")).toBe(false);
    // At 8:00pm itself: back to 7:59pm, or on to Sat's opening.
    expect(iso(lastInTextHours(ms("2026-10-24T00:00:00Z"), NY, "customer"))).toBe("2026-10-23T23:59:00Z");
    expect(iso(nextInTextHours(ms("2026-10-24T00:00:00Z"), NY, "customer"))).toBe("2026-10-24T13:00:00Z");
  });

  it("reads each day's hours on the zone's own calendar across the change of Sun Nov 1", () => {
    expect(inTextHours(ms("2026-11-01T14:00:00Z"), NY, "customer")).toBe(true); // 9am EST
    expect(inTextHours(ms("2026-11-01T13:59:59Z"), NY, "customer")).toBe(false);
    expect(inTextHours(ms("2026-11-02T00:59:00Z"), NY, "customer")).toBe(true); // 7:59pm EST
    expect(inTextHours(ms("2026-11-02T01:00:00Z"), NY, "customer")).toBe(false); // 8pm EST
    expect(inTextHours(ms("2026-11-02T01:00:01Z"), NY, "customer")).toBe(false);
    // Sat Oct 31 9pm EDT: next opening Sun 9am EST, the last minute before closing Sat 7:59pm EDT.
    expect(iso(nextInTextHours(ms("2026-11-01T01:00:00Z"), NY, "customer"))).toBe("2026-11-01T14:00:00Z");
    expect(iso(lastInTextHours(ms("2026-11-01T01:00:00Z"), NY, "customer"))).toBe("2026-10-31T23:59:00Z");
    // Sun Nov 1 1:30am EST (the second 1:30am), before opening: back to Sat 7:59pm EDT, on to the team's 8am EST.
    expect(iso(lastInTextHours(ms("2026-11-01T06:30:00Z"), NY, "team"))).toBe("2026-10-31T23:59:00Z");
    expect(iso(nextInTextHours(ms("2026-11-01T06:30:00Z"), NY, "team"))).toBe("2026-11-01T13:00:00Z");
    // Sun Nov 1 8pm EST: back to 7:59pm EST (00:59Z Mon), not EDT's.
    expect(iso(lastInTextHours(ms("2026-11-02T01:00:00Z"), NY, "customer"))).toBe("2026-11-02T00:59:00Z");
  });

  it("reads text hours as limit 8 does at send: every half minute of a day, and of Sun Nov 1, for every audience", () => {
    const disagree: string[] = [];
    const days = [
      ["2026-10-23T04:00:00Z", "2026-10-24T04:00:00Z"], // Fri Oct 23, EDT
      ["2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"], // Sun Nov 1, 25 hours
    ] as const;
    for (const audience of ["customer", "owner", "team"] as const)
      for (const [from, to] of days)
        for (let at = ms(from); at < ms(to); at += MINUTE / 2)
          if (inTextHours(at, NY, audience) !== limit8Sends(at, audience))
            disagree.push(`${audience} ${iso(at)}`);
    expect(disagree).toEqual([]);
  });

  it("adds N text hours, counting only time inside them: 2 of their text hours", () => {
    const twoHours = 2 * HOUR;
    expect(iso(textHoursAfter(ms("2026-10-23T15:20:04Z"), twoHours, NY, "customer"))).toBe(
      "2026-10-23T17:20:04Z",
    );
    expect(iso(textHoursAfter(ms("2026-10-23T23:30:00Z"), twoHours, NY, "customer"))).toBe(
      "2026-10-24T14:30:00Z",
    );
    expect(iso(textHoursAfter(ms("2026-10-23T10:00:00Z"), twoHours, NY, "customer"))).toBe(
      "2026-10-23T15:00:00Z",
    );
    expect(iso(textHoursAfter(ms("2026-10-23T23:30:00Z"), twoHours, NY, "team"))).toBe(
      "2026-10-24T13:30:00Z",
    );
    // Across Nov 1: Sat 7:30pm EDT plus 2 text hours is Sun 10:30am EST.
    expect(iso(textHoursAfter(ms("2026-10-31T23:30:00Z"), twoHours, NY, "customer"))).toBe(
      "2026-11-01T15:30:00Z",
    );
    // 13 text hours from Fri 9am: 11 on Friday, then 2 more from Sat 9am.
    expect(iso(textHoursAfter(ms("2026-10-23T13:00:00Z"), 13 * HOUR, NY, "customer"))).toBe(
      "2026-10-24T15:00:00Z",
    );
    expect(() => textHoursAfter(ms("2026-10-23T13:00:00Z"), -HOUR, NY, "customer")).toThrow(DueError);
    expect(() => textHoursAfter(Number.NaN, HOUR, NY, "customer")).toThrow(DueError);
  });

  it("a count that runs out at 8:00pm itself gives 7:59pm, never a moment before the count began", () => {
    // 11 text hours from Fri 9am EDT, 2 from 6pm and the team's 12 from 8am all run out at Fri 8pm EDT itself.
    const counts = [
      ["2026-10-23T13:00:00Z", 11 * HOUR, "customer"],
      ["2026-10-23T22:00:00Z", 2 * HOUR, "customer"],
      ["2026-10-23T12:00:00Z", 12 * HOUR, "team"],
    ] as const;
    for (const [from, span, audience] of counts) {
      const at = textHoursAfter(ms(from), span, NY, audience);
      expect(iso(at)).toBe("2026-10-23T23:59:00Z");
      expect(limit8Sends(at, audience)).toBe(true);
    }
    // From inside the last minute, 7:59pm would come before the count began: on to Sat 9am EDT.
    expect(iso(textHoursAfter(ms("2026-10-23T23:59:30Z"), MINUTE / 2, NY, "customer"))).toBe(
      "2026-10-24T13:00:00Z",
    );
    // From 8:00pm itself the count starts at Sat's opening, so a zero span gives Sat 9am.
    expect(iso(textHoursAfter(ms("2026-10-24T00:00:00Z"), 0, NY, "customer"))).toBe("2026-10-24T13:00:00Z");
  });
});

describe("a deadline sent to someone in another zone shows their time too (S13-03; RULES 5.2)", () => {
  it("Fri 11am ET shows 8am for someone in Los Angeles, before and after the change", () => {
    expect(shownTimes({ at: "2026-10-23T15:00:00Z", dueZone: NY, personZone: LA })).toEqual([
      { zone: NY, year: 2026, month: 10, day: 23, weekday: 5, hour: 11, minute: 0 },
      { zone: LA, year: 2026, month: 10, day: 23, weekday: 5, hour: 8, minute: 0 },
    ]);
    const monday = shownTimes({ at: "2026-11-02T16:00:00Z", dueZone: NY, personZone: LA });
    expect(monday.map((wall) => [wall.zone, wall.weekday, wall.hour])).toEqual([
      [NY, 1, 11],
      [LA, 1, 8],
    ]);
  });

  it("shows one time when the person's clock reads the same, or their zone is not known", () => {
    for (const personZone of [NY, DETROIT, null, "Mars/Olympus"])
      expect(shownTimes({ at: "2026-10-23T15:00:00Z", dueZone: NY, personZone })).toHaveLength(1);
  });
});

describe("the clock home's module for the home registry (T-586)", () => {
  it("settles its points with labels, the urgent clock and no reminder on a job sent now", () => {
    expect(clockHomeModule.home).toBe("clock");
    expect(new Set(CLOCK_HOME_POINTS).size).toBe(CLOCK_HOME_POINTS.length);
    const setTime = Object.fromEntries(
      CLOCK_HOME_POINTS.map((point) => [point, clockHomeModule.rule(point, {})]),
    );
    expect(setTime).toEqual({
      clockEndsBy: "visitStart",
      clockHours: "textHours",
      remindersPerTime: "one",
      deadlineZones: "theirsToo",
    });
    const sentNow = Object.fromEntries(
      CLOCK_HOME_POINTS.map((point) => [point, clockHomeModule.rule(point, { sentNow: true })]),
    );
    expect(sentNow).toMatchObject({ clockHours: "urgentAnyHour", remindersPerTime: "none" });
    for (const point of CLOCK_HOME_POINTS) {
      expect(isLabel(point)).toBe(true);
      expect(isLabel(setTime[point])).toBe(true);
      expect(isLabel(sentNow[point])).toBe(true);
    }
    expect(() => clockHomeModule.rule("chargeOnSilence", {})).toThrow();
  });
});
