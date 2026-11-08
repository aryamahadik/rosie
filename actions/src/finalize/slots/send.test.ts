// 'today' and 'tomorrow' are slots filled at send in the reader's zone (arch 07 line 409; slots.json filledBy "send"):
// the visit's zone, else the business's (CQ-05). T-310, "Proves it with": 'tomorrow' filled at 23:59 and sent at 00:01
// reads 'today'.

import { describe, expect, it } from "vitest";
import { fillAtSend, fillPlan, fillText, type SlotValue } from "./fill";
import { at, sampleSource } from "./test-support";
import type { ReaderZones, SlotSource } from "./types";

const NEW_YORK = "America/New_York";
const LOS_ANGELES = "America/Los_Angeles";

/** Sat Nov 7, 2026, 23:59 in New York (EST since Nov 1: UTC-5). */
const NY_23_59 = "2026-11-08T04:59:00Z";
/** Sun Nov 8, 2026, 00:01 in New York. */
const NY_00_01 = "2026-11-08T05:01:00Z";

function filledAt(filled: string, zones: ReaderZones): SlotSource {
  const source = sampleSource();
  return {
    ...source,
    filledAt: filled,
    zones,
    facts: { ...source.facts, visit: { ...source.facts.visit, start: at("2026-11-08T16:00:00Z", NEW_YORK) } },
  };
}

describe("'tomorrow' filled at 23:59 and sent at 00:01 reads 'today'", () => {
  const zones: ReaderZones = { visit: NEW_YORK, business: NEW_YORK };

  it("binds {{tomorrow}} to the next day when the plan is filled, and words it at send", () => {
    const filled = fillPlan(
      { lines: [{ role: "first", text: "Your visit is {{tomorrow}} at {{visit.time}}." }], question: null },
      filledAt(NY_23_59, zones),
    );
    expect(filled.ok).toBe(true);
    expect(filled.lines).toEqual([{ role: "first", text: "Your visit is {{tomorrow}} at 11:00am." }]);
    expect(filled.slotValues).toEqual([
      { slot: "tomorrow", value: "2026-11-08" },
      { slot: "visit.time", value: "11:00am" },
    ]);

    const text = filled.lines[0]?.text ?? "";
    const sent = fillAtSend(text, filled.slotValues, { sentAt: NY_00_01, zones });
    expect(sent).toEqual({
      ok: true,
      text: "Your visit is today at 11:00am.",
      slotValues: [{ slot: "tomorrow", value: "today" }],
    });
  });

  it("still reads 'tomorrow' when sent before midnight", () => {
    const filled = fillText("See you {{tomorrow}}.", filledAt(NY_23_59, zones));
    const sent = fillAtSend(filled.text, filled.slotValues, { sentAt: "2026-11-08T04:59:30Z", zones });
    expect(sent.ok && sent.text).toBe("See you tomorrow.");
  });

  it("makes a 'today' filled at 23:59 and sent at 00:01 stale: its day has gone by", () => {
    const filled = fillText("We open {{today}} at 9am.", filledAt(NY_23_59, zones));
    expect(filled.slotValues).toEqual([{ slot: "today", value: "2026-11-07" }]);
    const sent = fillAtSend(filled.text, filled.slotValues, { sentAt: NY_00_01, zones });
    expect(sent.ok).toBe(false);
    expect(sent.text).toBe("We open {{today}} at 9am.");
    if (sent.ok) return;
    expect(sent.problems).toEqual([
      expect.objectContaining({
        kind: "stale",
        slot: "today",
        why: "bound to 2026-11-07, sent on 2026-11-08",
      }),
    ]);
  });

  it("reads the day in the visit's zone, not the business's (CQ-05)", () => {
    const visitZones: ReaderZones = { visit: NEW_YORK, business: LOS_ANGELES };
    const filled = fillText("{{tomorrow}} at {{visit.time}}", filledAt(NY_23_59, visitZones));
    expect(filled.slotValues[0]).toEqual({ slot: "tomorrow", value: "2026-11-08" });
    const sent = fillAtSend(filled.text, filled.slotValues, { sentAt: NY_00_01, zones: visitZones });
    expect(sent.ok && sent.text).toBe("Today at 11:00am");
  });

  it("reads the day in the business's zone when the message is about no visit (CQ-05)", () => {
    // 23:59 in New York is 20:59 in Los Angeles: the same day there, so 'tomorrow' still reads 'tomorrow' at 00:01 NY.
    const businessZones: ReaderZones = { visit: null, business: LOS_ANGELES };
    const filled = fillText("{{tomorrow}} works.", filledAt(NY_23_59, businessZones));
    expect(filled.slotValues).toEqual([{ slot: "tomorrow", value: "2026-11-08" }]);
    const sent = fillAtSend(filled.text, filled.slotValues, { sentAt: NY_00_01, zones: businessZones });
    expect(sent.ok && sent.text).toBe("Tomorrow works.");
  });

  it("counts days on the calendar across the change from summer time (Nov 1, 2026: a 25-hour day)", () => {
    // Sat Oct 31, 23:59 EDT (UTC-4); then Sun Nov 1, 23:30 EST and Mon Nov 2, 00:01 EST (UTC-5).
    const filled = fillText("Back {{tomorrow}}.", filledAt("2026-11-01T03:59:00Z", zones));
    expect(filled.slotValues).toEqual([{ slot: "tomorrow", value: "2026-11-01" }]);
    const lateSunday = fillAtSend(filled.text, filled.slotValues, { sentAt: "2026-11-02T04:30:00Z", zones });
    expect(lateSunday.ok && lateSunday.text).toBe("Back today.");
    const monday = fillAtSend(filled.text, filled.slotValues, { sentAt: "2026-11-02T05:01:00Z", zones });
    expect(monday.ok).toBe(false);
  });
});

describe("the send's words", () => {
  const zones: ReaderZones = { visit: NEW_YORK, business: NEW_YORK };
  const bound: SlotValue[] = [
    { slot: "today", value: "2026-11-08" },
    { slot: "tomorrow", value: "2026-11-09" },
  ];

  it("capitalizes a send word that starts a sentence or a line", () => {
    const sent = fillAtSend(
      "{{today}} at 3pm. {{tomorrow}} is full.\n{{tomorrow}} at 9am, or {{today}}?",
      bound,
      {
        sentAt: NY_00_01,
        zones,
      },
    );
    expect(sent.ok && sent.text).toBe("Today at 3pm. Tomorrow is full.\nTomorrow at 9am, or today?");
  });

  it("fails a send slot that was never bound to a day", () => {
    const sent = fillAtSend("See you {{tomorrow}}.", [], { sentAt: NY_00_01, zones });
    expect(sent.ok).toBe(false);
    if (sent.ok) return;
    expect(sent.problems).toEqual([expect.objectContaining({ kind: "unfilled", slot: "tomorrow" })]);
  });

  it("fails a send made before the day it was filled", () => {
    const sent = fillAtSend("See you {{tomorrow}}.", [{ slot: "tomorrow", value: "2026-11-12" }], {
      sentAt: NY_00_01,
      zones,
    });
    expect(sent.ok).toBe(false);
  });

  it("fails any other slot still in the text at send, and a '{{' that opens no slot", () => {
    const sent = fillAtSend("{{svc.intext}} {{today}} {{hold}} {{", bound, { sentAt: NY_00_01, zones });
    expect(sent.ok).toBe(false);
    expect(sent.text).toBe("{{svc.intext}} today {{hold}} {{");
    if (sent.ok) return;
    expect(sent.problems.map((problem) => [problem.kind, problem.slot])).toEqual([
      ["unfilled", "svc.intext"],
      ["unknown", "hold"],
      ["unknown", ""],
    ]);
  });

  it("fails when the reader's zone is not an IANA zone", () => {
    const sent = fillAtSend("{{today}}", bound, {
      sentAt: NY_00_01,
      zones: { visit: null, business: "Mars/Base" },
    });
    expect(sent.ok).toBe(false);
  });

  it("fills the visit's day on a sent-now booking as 'today', worded at send (SPEC-master 5h)", () => {
    const source = filledAt("2026-11-08T15:00:00Z", zones);
    const sentNow: SlotSource = {
      ...source,
      record: source.record === null ? null : { ...source.record, booking: { timing: "sentnow" } },
    };
    const filled = fillText("Riley comes {{day}}, {{arrive}}.", sentNow);
    expect(filled.ok).toBe(true);
    expect(filled.text).toBe("Riley comes {{today}}, arriving in about 60 to 90 minutes.");
    const sent = fillAtSend(filled.text, filled.slotValues, { sentAt: "2026-11-08T15:01:00Z", zones });
    expect(sent.ok && sent.text).toBe("Riley comes today, arriving in about 60 to 90 minutes.");
  });
});
