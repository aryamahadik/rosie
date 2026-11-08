// The due rule and the arming at a question's first delivery receipt (T-255; C-055), run by
// `npm run test:unit -- runtime/src/clocks/due`. The table covers each branch of arch 02 step 9 'Wait' (architecture.txt
// line 127): a Clock line; 7pm the day before; 2 hours before a same-day visit; the 1-hour-after-delivery floor and the
// visit's start winning; no visit at 8pm the day after delivery; flow A in the business's zone and flow B in the visit
// address's zone across the daylight-saving change of Sun Nov 1, 2026 (S13-03); the never-delivered default at the
// visit or 8pm the day after the send. Then the arming: no receipt, no clock row armed; a second receipt for the same
// message arms nothing twice.
//
// Zone facts the expected times rest on (IANA): America/New_York is UTC-4 (EDT) until 2026-11-01T06:00Z and UTC-5 (EST)
// after; America/Chicago is UTC-5 (CDT) until 2026-11-01T07:00Z and UTC-6 (CST) after. A7-03's values are the contract
// fixtures' (mark-a7-03-delivered-by-key.json, arm-clock.json) and K-04's seeds'. Test values only (rule 9).
import { describe, expect, it } from "vitest";

import markDelivered from "../../../contracts/data-access/fixtures/mark-delivered.json";
import { armAtDelivery, ArmingMemory, type ArmingOptions } from "./arming";
import {
  A7_03_ARM_REQUEST,
  A7_03_CLOCK_ROW,
  A7_03_DELIVERED,
  A7_03_QUESTION,
  ALEX_ACTOR,
  ALEX_HANDLE,
  wireArming as wired,
} from "./arming-support";
import {
  clockLineMs,
  DueError,
  dueOf,
  isDeliveryReceipt,
  neverDeliveredDueOf,
  zoneFor,
  type DueBranch,
} from "./due";

const NY = "America/New_York";
const CHICAGO = "America/Chicago";

interface DueRow {
  name: string;
  deliveredAt: string;
  clockLine: string | null;
  visitStartsAt: string | null;
  zone: string;
  dueAt: string;
  branch: DueBranch;
}

describe("the due rule: each branch of arch 02 step 9", () => {
  const rows: DueRow[] = [
    {
      name: "a Clock line: A7-03's 24 h from its first delivery receipt (arm-clock.json)",
      deliveredAt: A7_03_ARM_REQUEST.deliveredAt,
      clockLine: "24 h",
      visitStartsAt: "2026-10-24T15:00:00Z",
      zone: NY,
      dueAt: A7_03_ARM_REQUEST.dueAt,
      branch: "clockLine",
    },
    {
      name: "a Clock line with no visit: delivery plus its span",
      deliveredAt: "2026-10-23T14:05:04Z",
      clockLine: "48 hours",
      visitStartsAt: null,
      zone: NY,
      dueAt: "2026-10-25T14:05:04Z",
      branch: "clockLine",
    },
    {
      name: "a Clock line that would pass the visit: the visit's start comes first (S13-35)",
      deliveredAt: "2026-10-23T14:05:04Z",
      clockLine: "24 h",
      visitStartsAt: "2026-10-24T13:00:00Z",
      zone: NY,
      dueAt: "2026-10-24T13:00:00Z",
      branch: "visitStart",
    },
    {
      name: "7pm the day before the visit (Fri Oct 23, 7pm EDT for Sat 11am)",
      deliveredAt: "2026-10-22T14:00:00Z",
      clockLine: null,
      visitStartsAt: "2026-10-24T15:00:00Z",
      zone: NY,
      dueAt: "2026-10-23T23:00:00Z",
      branch: "dayBefore",
    },
    {
      name: "a same-day visit: 2 hours before it (Sat 9am EDT for 11am, delivered 7:30am)",
      deliveredAt: "2026-10-24T11:30:00Z",
      clockLine: null,
      visitStartsAt: "2026-10-24T15:00:00Z",
      zone: NY,
      dueAt: "2026-10-24T13:00:00Z",
      branch: "sameDay",
    },
    {
      name: "the floor: delivered 6:30pm the day before, so 1 hour after delivery, not 7pm",
      deliveredAt: "2026-10-23T22:30:00Z",
      clockLine: null,
      visitStartsAt: "2026-10-24T15:00:00Z",
      zone: NY,
      dueAt: "2026-10-23T23:30:00Z",
      branch: "deliveryFloor",
    },
    {
      name: "the floor on a same-day visit: delivered 8:30am for 11am, so 9:30am, not 9am",
      deliveredAt: "2026-10-24T12:30:00Z",
      clockLine: null,
      visitStartsAt: "2026-10-24T15:00:00Z",
      zone: NY,
      dueAt: "2026-10-24T13:30:00Z",
      branch: "deliveryFloor",
    },
    {
      name: "the visit's start wins: delivered 10:30am for 11am, the floor would pass the start",
      deliveredAt: "2026-10-24T14:30:00Z",
      clockLine: null,
      visitStartsAt: "2026-10-24T15:00:00Z",
      zone: NY,
      dueAt: "2026-10-24T15:00:00Z",
      branch: "visitStart",
    },
    {
      name: "the visit's start wins: a receipt after the visit began is due at once (no clock runs past it)",
      deliveredAt: "2026-10-24T16:00:00Z",
      clockLine: null,
      visitStartsAt: "2026-10-24T15:00:00Z",
      zone: NY,
      dueAt: "2026-10-24T15:00:00Z",
      branch: "visitStart",
    },
    {
      name: "no visit: 8pm the day after delivery (Sat Oct 24, 8pm EDT)",
      deliveredAt: "2026-10-23T14:05:04Z",
      clockLine: null,
      visitStartsAt: null,
      zone: NY,
      dueAt: "2026-10-25T00:00:00Z",
      branch: "noVisit",
    },
    {
      name: "no visit: the day after is the zone's (Fri 11:30pm EDT is Oct 24 in UTC)",
      deliveredAt: "2026-10-24T03:30:00Z",
      clockLine: null,
      visitStartsAt: null,
      zone: NY,
      dueAt: "2026-10-25T00:00:00Z",
      branch: "noVisit",
    },
    {
      name: "7pm the day before, after the change: Sun Nov 1, 7pm EST",
      deliveredAt: "2026-10-30T14:00:00Z",
      clockLine: null,
      visitStartsAt: "2026-11-02T16:00:00Z",
      zone: NY,
      dueAt: "2026-11-02T00:00:00Z",
      branch: "dayBefore",
    },
    {
      name: "no visit, across the change: Sun Nov 1, 8pm EST",
      deliveredAt: "2026-10-31T15:00:00Z",
      clockLine: null,
      visitStartsAt: null,
      zone: NY,
      dueAt: "2026-11-02T01:00:00Z",
      branch: "noVisit",
    },
    {
      name: "a same-day visit on the day of the change: 2 hours of elapsed time",
      deliveredAt: "2026-11-01T05:30:00Z",
      clockLine: null,
      visitStartsAt: "2026-11-01T15:00:00Z",
      zone: NY,
      dueAt: "2026-11-01T13:00:00Z",
      branch: "sameDay",
    },
  ];

  it.each(rows)("$name", (row) => {
    const due = dueOf({
      deliveredAt: row.deliveredAt,
      clockLine: row.clockLine,
      visitStartsAt: row.visitStartsAt,
      zone: row.zone,
    });
    expect(due).toEqual({ dueAt: row.dueAt, dueZone: row.zone, branch: row.branch, clockLineUnread: false });
  });

  it("covers every branch the rule has", () => {
    const branches = new Set(rows.map((row) => row.branch));
    expect([...branches].sort()).toEqual(
      ["clockLine", "dayBefore", "deliveryFloor", "noVisit", "sameDay", "visitStart"].sort(),
    );
  });

  it("a Clock line it cannot read: step 9's default, marked", () => {
    expect(
      dueOf({
        deliveredAt: "2026-10-22T14:00:00Z",
        clockLine: "Clock: Sam answers in 30 minutes; no answer, the time is let go.",
        visitStartsAt: "2026-10-24T15:00:00Z",
        zone: NY,
      }),
    ).toEqual({ dueAt: "2026-10-23T23:00:00Z", dueZone: NY, branch: "dayBefore", clockLineUnread: true });
  });

  it("reads a Clock line as a whole number of minutes, hours or days", () => {
    expect(clockLineMs("24 h")).toBe(24 * 3_600_000);
    expect(clockLineMs("48h")).toBe(48 * 3_600_000);
    expect(clockLineMs(" 30 min ")).toBe(30 * 60_000);
    expect(clockLineMs("2 days")).toBe(2 * 86_400_000);
    expect(clockLineMs("1 Hour")).toBe(3_600_000);
    expect(clockLineMs("0 h")).toBeNull();
    expect(clockLineMs("1.5 h")).toBeNull();
    expect(clockLineMs("within 4 of your text hours")).toBeNull();
    expect(clockLineMs("")).toBeNull();
  });

  it("counts the floor and a span from the receipt's whole second at or after it, and never passes the visit's start", () => {
    expect(
      dueOf({
        deliveredAt: "2026-10-24T13:59:59.400Z",
        clockLine: null,
        visitStartsAt: "2026-10-24T15:00:00Z",
        zone: NY,
      }),
    ).toMatchObject({ dueAt: "2026-10-24T15:00:00Z", branch: "deliveryFloor" });
    expect(
      dueOf({ deliveredAt: "2026-10-23T14:05:04.250Z", clockLine: "24 h", visitStartsAt: null, zone: NY })
        .dueAt,
    ).toBe("2026-10-24T14:05:05Z");
    expect(
      dueOf({
        deliveredAt: "2026-10-24T14:30:00Z",
        clockLine: null,
        visitStartsAt: "2026-10-24T15:00:00.900Z",
        zone: NY,
      }).dueAt,
    ).toBe("2026-10-24T15:00:00Z");
  });

  it("refuses an instant that is not one and a zone the platform does not know", () => {
    const base = { deliveredAt: "2026-10-23T14:05:04Z", clockLine: null, visitStartsAt: null, zone: NY };
    expect(() => dueOf({ ...base, zone: "Mars/Olympus_Mons" })).toThrow(DueError);
    expect(() => dueOf({ ...base, deliveredAt: "not a time" })).toThrow(DueError);
    expect(() => dueOf({ ...base, visitStartsAt: "soon" })).toThrow(DueError);
  });
});

describe("the zone: flow A the business's, flow B the visit address's, across the change of Sun Nov 1 (S13-03)", () => {
  // One visit, Mon Nov 2 at 16:00Z (11am EST, 10am CST), the question delivered Fri Oct 30 (before the change).
  const visit = "2026-11-02T16:00:00Z";
  const deliveredAt = "2026-10-30T14:00:00Z";
  const rows = [
    {
      name: "flow A: the business's zone, never an address's (7pm Sun EST)",
      flow: "A" as const,
      businessZone: NY,
      visitAddressZone: CHICAGO,
      zone: NY,
      from: "business",
      dueAt: "2026-11-02T00:00:00Z",
    },
    {
      name: "flow B: the visit address's zone (7pm Sun CST)",
      flow: "B" as const,
      businessZone: NY,
      visitAddressZone: CHICAGO,
      zone: CHICAGO,
      from: "visitAddress",
      dueAt: "2026-11-02T01:00:00Z",
    },
    {
      name: "flow B with the address's zone not known: the business's (CQ-05)",
      flow: "B" as const,
      businessZone: NY,
      visitAddressZone: null,
      zone: NY,
      from: "business",
      dueAt: "2026-11-02T00:00:00Z",
    },
    {
      name: "flow B with a zone name the platform does not know: the business's",
      flow: "B" as const,
      businessZone: CHICAGO,
      visitAddressZone: "Not/AZone",
      zone: CHICAGO,
      from: "business",
      dueAt: "2026-11-02T01:00:00Z",
    },
  ];

  it.each(rows)("$name", (row) => {
    const chosen = zoneFor({
      flow: row.flow,
      businessZone: row.businessZone,
      visitAddressZone: row.visitAddressZone,
    });
    expect(chosen).toEqual({ zone: row.zone, from: row.from });
    const due = dueOf({ deliveredAt, clockLine: null, visitStartsAt: visit, zone: chosen.zone });
    expect(due).toEqual({ dueAt: row.dueAt, dueZone: row.zone, branch: "dayBefore", clockLineUnread: false });
  });

  it("the same 7pm before the change is an hour earlier in UTC (EDT, then EST)", () => {
    const before = dueOf({
      deliveredAt: "2026-10-22T14:00:00Z",
      clockLine: null,
      visitStartsAt: "2026-10-26T15:00:00Z",
      zone: NY,
    });
    const after = dueOf({ deliveredAt, clockLine: null, visitStartsAt: visit, zone: NY });
    expect(before.dueAt).toBe("2026-10-25T23:00:00Z");
    expect(after.dueAt).toBe("2026-11-02T00:00:00Z");
  });

  it("no visit, or no business zone either", () => {
    expect(zoneFor({ flow: null, businessZone: NY, visitAddressZone: null })).toEqual({
      zone: NY,
      from: "business",
    });
    expect(zoneFor({ flow: "A", businessZone: null, visitAddressZone: CHICAGO })).toEqual({
      zone: "UTC",
      from: "utc",
    });
    expect(zoneFor({ flow: "B", businessZone: null, visitAddressZone: CHICAGO })).toEqual({
      zone: CHICAGO,
      from: "visitAddress",
    });
  });
});

describe("never delivered: the default at the visit, or 8pm the day after the send", () => {
  it.each([
    {
      name: "with a visit: at the visit's start",
      sentAt: "2026-10-23T14:05:02Z",
      visitStartsAt: "2026-10-24T15:00:00Z",
      dueAt: "2026-10-24T15:00:00Z",
      branch: "visitStart",
    },
    {
      name: "no visit: 8pm the day after the send (Sat Oct 24, 8pm EDT)",
      sentAt: "2026-10-23T14:05:02Z",
      visitStartsAt: null,
      dueAt: "2026-10-25T00:00:00Z",
      branch: "dayAfterSend",
    },
    {
      name: "no visit, sent late at night: the zone's day after (Fri 11:30pm EDT)",
      sentAt: "2026-10-24T03:30:00Z",
      visitStartsAt: null,
      dueAt: "2026-10-25T00:00:00Z",
      branch: "dayAfterSend",
    },
    {
      name: "no visit, across the change: Sun Nov 1, 8pm EST",
      sentAt: "2026-10-31T15:00:00Z",
      visitStartsAt: null,
      dueAt: "2026-11-02T01:00:00Z",
      branch: "dayAfterSend",
    },
  ])("$name", (row) => {
    expect(neverDeliveredDueOf({ sentAt: row.sentAt, visitStartsAt: row.visitStartsAt, zone: NY })).toEqual({
      dueAt: row.dueAt,
      dueZone: NY,
      branch: row.branch,
    });
  });
});

describe("which receipt arms a question's clock (arch 02 line 127; K-06 routing)", () => {
  it.each([
    { kind: "delivered", service: "imessage", arms: true },
    { kind: "delivered", service: "rcs", arms: true },
    { kind: "delivered", service: "email", arms: true },
    { kind: "delivered", service: null, arms: true },
    { kind: "sent", service: "sms", arms: true },
    { kind: "delivered", service: "sms", arms: true },
    { kind: "sent", service: "imessage", arms: false },
    { kind: "sent", service: "rcs", arms: false },
    { kind: "sent", service: null, arms: false },
    { kind: "failed", service: "imessage", arms: false },
    { kind: "failed", service: "sms", arms: false },
  ])("$kind on $service: $arms", ({ kind, service, arms }) => {
    expect(isDeliveryReceipt(kind, service)).toBe(arms);
  });
});

describe("the arming at A7-03's first delivery receipt", () => {
  it("arms with arm-clock.json's request, opens the question and tells Alex's actor once", async () => {
    const { data, actors, options } = wired();
    const report = await armAtDelivery(A7_03_DELIVERED, options);

    expect(data.armRequests).toEqual([A7_03_ARM_REQUEST]);
    expect(data.armAnswers[0]).toMatchObject({
      result: "armed",
      repeated: false,
      clock: { clockRowId: A7_03_CLOCK_ROW, version: 2, handleId: ALEX_HANDLE },
    });
    expect(data.rowOf(A7_03_CLOCK_ROW)).toMatchObject({ state: "armed", dueAt: A7_03_ARM_REQUEST.dueAt });
    expect(data.openedQuestions).toEqual([A7_03_QUESTION]);
    expect(actors.syncs).toEqual([{ actor: ALEX_ACTOR, handleId: ALEX_HANDLE }]);
    expect(report).toEqual({
      outcome: "armed",
      openQuestionId: A7_03_QUESTION,
      clockRowId: A7_03_CLOCK_ROW,
      branch: "clockLine",
      zoneFrom: "business",
      clockLineUnread: false,
      neverDelivered: "none",
      synced: true,
      errorCode: null,
    });
  });
});

describe("no receipt: no clock row armed", () => {
  it("a question with no delivery receipt keeps its clock row waiting: nothing arms it", () => {
    const { data } = wired();
    expect(data.rowOf(A7_03_CLOCK_ROW)).toMatchObject({ state: "waiting", version: 1, dueAt: null });
    expect(data.armRequests).toEqual([]);
  });

  it("a receipt that is not the row's first delivery arms nothing and reads nothing", async () => {
    const { data, facts, actors, options } = wired();
    const report = await armAtDelivery({ ...A7_03_DELIVERED, partNo: 2, firstDelivery: false }, options);
    expect(report.outcome).toBe("notFirst");
    expect(facts.reads).toEqual([]);
    expect(data.armRequests).toEqual([]);
    expect(actors.syncs).toEqual([]);
    expect(data.rowOf(A7_03_CLOCK_ROW).state).toBe("waiting");
  });

  it("a delivered row that asks no question arms nothing (mark-delivered.json)", async () => {
    const { data, facts, options } = wired();
    const report = await armAtDelivery(
      {
        outboxRowId: markDelivered.outcome.outboxRowId,
        partNo: 1,
        tryNo: markDelivered.outcome.tryNo,
        firstDelivery: markDelivered.outcome.firstDelivery,
        openQuestionId: markDelivered.outcome.openQuestionId,
        deliveredAt: markDelivered.request.at,
      },
      options,
    );
    expect(report.outcome).toBe("noQuestion");
    expect(facts.reads).toEqual([]);
    expect(data.armRequests).toEqual([]);
  });

  it("a sent receipt on iMessage and a failed receipt are no delivery: they never reach the arming", () => {
    expect(isDeliveryReceipt("sent", "imessage")).toBe(false);
    expect(isDeliveryReceipt("failed", "imessage")).toBe(false);
  });
});

describe("a second receipt for the same message arms nothing twice", () => {
  it("in one isolate: the second makes no call and tells no actor", async () => {
    const { data, facts, actors, options } = wired();
    await armAtDelivery(A7_03_DELIVERED, options);
    const second = await armAtDelivery(A7_03_DELIVERED, options);

    expect(second).toMatchObject({ outcome: "repeated", clockRowId: A7_03_CLOCK_ROW });
    expect(facts.reads).toEqual([A7_03_QUESTION]);
    expect(data.armRequests).toHaveLength(1);
    expect(actors.syncs).toHaveLength(1);
    expect(data.rowOf(A7_03_CLOCK_ROW).version).toBe(2);
  });

  it("two receipts at once: one arming", async () => {
    const { data, actors, options } = wired();
    data.slow = true;
    const [first, second] = await Promise.all([
      armAtDelivery(A7_03_DELIVERED, options),
      armAtDelivery({ ...A7_03_DELIVERED }, options),
    ]);
    expect(first.outcome).toBe("armed");
    expect(second.outcome).toBe("armed");
    expect(data.armRequests).toHaveLength(1);
    expect(actors.syncs).toHaveLength(1);
  });

  it("in another isolate: K-05 answers with the first arming, repeated, and nothing more is done", async () => {
    const first = wired();
    await armAtDelivery(A7_03_DELIVERED, first.options);
    // Another isolate: its own memory, the same database.
    const other: ArmingOptions = { ...first.options, memory: new ArmingMemory() };
    const report = await armAtDelivery(A7_03_DELIVERED, other);

    expect(first.data.armRequests).toEqual([A7_03_ARM_REQUEST, A7_03_ARM_REQUEST]);
    expect(first.data.armAnswers[1]).toEqual({ ...first.data.armAnswers[0], repeated: true });
    expect(report).toMatchObject({ outcome: "repeated", clockRowId: A7_03_CLOCK_ROW });
    expect(first.actors.syncs).toHaveLength(1);
    expect(first.data.rowOf(A7_03_CLOCK_ROW)).toMatchObject({ state: "armed", version: 2 });
    expect(first.data.openedQuestions).toEqual([A7_03_QUESTION]);
  });
});
