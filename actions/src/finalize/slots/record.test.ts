// The record's named slots read the first row whose `when` fits the booking's path and record values (K-01
// record.slots; K-03 slots.json "reads"; overlay-core.js slotRow line 766), on K-01's bundle-mini-a.json rows.

import { describe, expect, it } from "vitest";
import { fillText } from "./fill";
import { pickRow, type RecordReading, type SlotRow } from "./record";
import { CARD_COUNTER, sampleSource } from "./test-support";
import type { SlotSource } from "./types";

function reading(changes: Partial<RecordReading>): RecordReading {
  return { ...CARD_COUNTER, ...changes };
}

function source(record: RecordReading): SlotSource {
  return { ...sampleSource(), record };
}

describe("record slot rows: the first that fits", () => {
  it("reads a pack credit's words when the booking holds a credit (rec credit, recOff several)", () => {
    const credit = reading({ before: "card", after: "none", values: ["credit", "card", "written"] });
    expect(fillText("{{pay.price}} · {{pay.took}} · {{pay.late}}", source(credit)).text).toBe(
      "Paid with 1 credit from your pack · Nothing to pay at the visit · may use your credit for this visit",
    );
  });

  it("reads a deposit paid now toward the price, and what goes back (rec paid)", () => {
    const deposit = reading({
      before: "deposit",
      after: "counter",
      values: ["card", "paid", "rest", "keep", "written"],
    });
    const filled = fillText("{{pay.took}}. {{pay.price}}. {{pay.back}}", source(deposit));
    expect(filled.ok && filled.text).toBe(
      "$40 deposit paid, toward the $35. The $35 rest, paid at the chair. The $40 you paid goes back to the card it was paid with.",
    );
  });

  it("reads booking values by group, a group left out reading its first value", () => {
    expect(fillText("{{reach.way}}", source(reading({ booking: { reach: "callsonly" } }))).text).toBe(
      "by phone call",
    );
    expect(fillText("{{reach.to}}", source(reading({ booking: { contact: "switched" } }))).text).toBe(
      "to the new phone or email you gave",
    );
    expect(fillText("{{who.ok}}", source(reading({ booking: { approval: "ownerok" } }))).text).toBe(
      "This is a request: Lee's Barbershop answers first, and nothing is charged for this visit until then.",
    );
    // pay.failed's first row needs approval now AND timing settime: a sent-now booking reads the second row.
    expect(fillText("{{pay.failed}}", source(reading({ booking: { timing: "sentnow" } }))).text).toBe(
      "Your card didn't go through, so nobody is sent yet. Pay with this link within 15 minutes to send someone",
    );
  });

  it("reads switches: no $2 for work whose switch no2 is on", () => {
    expect(fillText("{{two.count}}", source(reading({ switches: ["no2"] }))).text).toBe(
      "No Rosie $2 for this kind of work",
    );
  });

  it("reads fact gates: a trade with no facts list sees every pf row, one that lists facts only its own", () => {
    const rows: Partial<Record<"pay.asks", readonly SlotRow[]>> = {
      "pay.asks": [
        { when: { pf: ["rents"] }, text: "Gear is rented" },
        { when: { factOff: ["rents"] }, text: "No gear" },
      ],
    };
    expect(pickRow(reading({ facts: null, rows }), "pay.asks")).toEqual({ ok: true, text: "Gear is rented" });
    expect(pickRow(reading({ facts: ["weather"], rows }), "pay.asks")).toEqual({ ok: true, text: "No gear" });
  });

  it("takes no row it cannot read, and says why", () => {
    const rows: Partial<Record<"pay.asks", readonly SlotRow[]>> = {
      "pay.asks": [{ when: { hold: ["yes"] }, text: "Held" }, { text: "Never reached" }],
    };
    expect(pickRow(reading({ rows }), "pay.asks")).toEqual({
      ok: false,
      why: "row 1 of pay.asks has a when the filler cannot read",
    });
    expect(pickRow(reading({ rows: {} }), "pay.asks")).toEqual({
      ok: false,
      why: "the bundle's record has no rows for pay.asks",
    });
    const none: Partial<Record<"pay.asks", readonly SlotRow[]>> = {
      "pay.asks": [{ when: { rec: ["full"] }, text: "Paid" }],
    };
    expect(pickRow(reading({ rows: none }), "pay.asks")).toEqual({
      ok: false,
      why: "no row of pay.asks fits this booking's path and record values",
    });
  });

  it("refuses a reading with a choice, booking value or record value K-01 does not know", () => {
    const hold = { ...CARD_COUNTER, before: "hold" } as unknown as RecordReading;
    expect(pickRow(hold, "pay.asks").ok).toBe(false);
    const notsafe = { ...CARD_COUNTER, booking: { reach: "notsafe" } } as unknown as RecordReading;
    expect(pickRow(notsafe, "pay.asks").ok).toBe(false);
    const expert = { ...CARD_COUNTER, values: ["expert"] } as unknown as RecordReading;
    expect(pickRow(expert, "pay.asks").ok).toBe(false);
  });

  it("ignores the step stamps took, ev and wr: the reading is already as the step reads it", () => {
    const rows: Partial<Record<"pay.asks", readonly SlotRow[]>> = {
      "pay.asks": [{ when: { took: "A", ev: "A", wr: false, rec: ["card"] }, text: "Card" }],
    };
    expect(pickRow(reading({ rows }), "pay.asks")).toEqual({ ok: true, text: "Card" });
  });

  it("leaves a record slot unfilled, naming the slot inside its row that has no value", () => {
    const base = sampleSource();
    const filled = fillText("{{pay.cancel}}", { ...base, facts: { ...base.facts, visit: {} } });
    expect(filled.ok).toBe(false);
    expect(filled.text).toBe("{{pay.cancel}}");
    if (filled.ok) return;
    expect(filled.problems).toEqual([
      expect.objectContaining({ slot: "pay.cancel", why: "its row needs {{cutoff}}, with no value" }),
    ]);
  });

  it("stops rows that name each other", () => {
    const rows: Partial<Record<"pay.asks" | "pay.took", readonly SlotRow[]>> = {
      "pay.asks": [{ text: "{{pay.took}}" }],
      "pay.took": [{ text: "{{pay.asks}}" }],
    };
    const filled = fillText("{{pay.asks}}", source(reading({ rows })));
    expect(filled.ok).toBe(false);
  });
});
