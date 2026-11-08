// Every slot of K-03 v1's vocabulary has a filler (T-310, "Proves it with": every slot in slots.json has a filler; a
// test fails on any slot without one). The vocabulary is read from contracts/message-plan/fixtures/slots.json itself.

import { describe, expect, it } from "vitest";
import slotsJson from "../../../../contracts/message-plan/fixtures/slots.json";
import { fillText } from "./fill";
import { FILLERS } from "./fillers";
import { emptySource, sampleSource } from "./test-support";
import type { SlotSource } from "./types";
import { SLOT_NAMES, isSlotName } from "./vocabulary";

const VOCABULARY = slotsJson.slots;
const NAMES = VOCABULARY.map((slot) => slot.name);

/**
 * What each slot reads with the sample cast's facts (test-support.ts): one entry per slot of slots.json. A send slot
 * stays as written, bound to its day, until the send words it (send.test.ts).
 */
const SAMPLE_FILLS: Readonly<Record<string, string>> = {
  "pay.asks": "A card is saved when you book, for a $20 fee",
  "pay.price": "$35, paid at the chair",
  "pay.took": "The card is saved for a $20 fee",
  "pay.left": "$35, paid at the chair",
  "pay.cancel": "Free to cancel until Fri 11am, then a $20 fee may apply",
  "pay.late": "may charge its $20 fee to the saved card",
  "pay.noshow": "may charge its $20 fee to the saved card",
  "pay.back": "Nothing was charged, and the saved card won't be used.",
  "pay.after": "paid at the chair",
  "pay.staff": "Nothing paid yet · Collect $35 at the counter",
  "pay.failed": "Your card didn't go through. Try another card on this page",
  "clock.pay": "Thu 10:22am, while the page holds your time",
  "two.count":
    "Rosfield's $2 counts at the visit's first check-in code, or when it's marked DONE if no code was entered. A plan billed monthly through Rosfield pays 1% instead",
  "reach.way": "by text",
  "reach.to": "to this number",
  "who.ok": "It's booked as soon as you say yes.",
  "alex.staff": "Alex M.",
  "name.staff": "Ben T.",
  "svc.intext": "Haircut",
  arrive: "arriving 8–10am",
  window: "8–10am",
  cutoff: "Fri 11am",
  day: "Sat Oct 24",
  keep: "$20",
  price: "$35",
  fee: "$20",
  deposit: "$40",
  rest: "$100",
  paid: "$55",
  name: "Haircut",
  paidnow: "$40",
  due: "$35",
  back: "$40",
  later: "$100",
  backlate: "$20",
  today: "{{today}}",
  tomorrow: "{{tomorrow}}",
  "link.secure": "rosfield.com/v/s03",
  "link.pay": "rosfield.com/p/a2",
  "link.chat": "rosfield.com/c/k7",
  "link.chatqr": "rosfield.com/c/k7",
  "biz.name": "Lee's Barbershop",
  "biz.phone": "(555) 555-0177",
  "owner.name": "Sam",
  "pro.name": "Riley",
  "visit.time": "11:00am",
  "visit.place": "88 Elm St, Springfield",
  "visit.code": "5160",
  "ask.by": "9:00am Sat",
  "change.when": "Thu Oct 29, 2–5pm",
  "change.price": "$40",
  "relay.quote": "Can my son wait in the shop during my cut?",
};

/** The source a slot is filled from: the sample cast, on email for the QR code (never in a text). */
function sourceFor(name: string): SlotSource {
  const source = sampleSource();
  return name === "link.chatqr" ? { ...source, channel: "email" } : source;
}

describe("K-03 v1 slot vocabulary and its fillers", () => {
  it("names the same 52 slots, in the same order, as slots.json", () => {
    expect(NAMES).toHaveLength(52);
    expect([...SLOT_NAMES]).toEqual(NAMES);
    expect(Object.keys(FILLERS).sort()).toEqual([...NAMES].sort());
  });

  it("does not take hold, refused since D66", () => {
    expect(NAMES).not.toContain("hold");
    expect(isSlotName("hold")).toBe(false);
  });

  it.each(NAMES)("%s has a filler", (name) => {
    expect(isSlotName(name), `${name} is in slots.json but not in SLOT_NAMES`).toBe(true);
    if (!isSlotName(name)) return;
    const filler = FILLERS[name];
    expect(typeof filler.fill, `${name} has no fill()`).toBe("function");
  });

  it.each(VOCABULARY.map((slot) => [slot.name, slot] as const))(
    "%s's filler fills it as slots.json says: by whom, which value type, which sensitive form",
    (name, slot) => {
      if (!isSlotName(name)) throw new Error(`${name} has no filler`);
      const filler = FILLERS[name];
      expect(filler.filledBy).toBe(slot.filledBy);
      expect(filler.valueType).toBe(slot.valueType);
      expect(filler.sensitiveForm).toBe(slot.sensitiveForm);
    },
  );

  it("has an expected fill for every slot of slots.json and no other", () => {
    expect(Object.keys(SAMPLE_FILLS).sort()).toEqual([...NAMES].sort());
  });

  it.each(NAMES)("%s fills from the record and code facts", (name) => {
    const filled = fillText(`{{${name}}}`, sourceFor(name));
    expect(filled.ok, JSON.stringify(filled)).toBe(true);
    expect(filled.text).toBe(SAMPLE_FILLS[name]);
    expect(filled.slotValues.length).toBe(1);
  });

  it.each(NAMES.filter((name) => name !== "today" && name !== "tomorrow"))(
    "%s is unfilled when the fact it reads is missing",
    (name) => {
      const filled = fillText(`Before {{${name}}} after.`, emptySource());
      expect(filled.ok).toBe(false);
      expect(filled.text).toBe(`Before {{${name}}} after.`);
      if (filled.ok) return;
      expect(filled.problems).toEqual([expect.objectContaining({ kind: "unfilled", slot: name })]);
    },
  );

  it("never fills a slot from its example words, except keep's own words (MC C6; E12, E17)", () => {
    const filled = fillText(
      "{{svc.intext:Skin fade}} · {{price:$45}} · {{day:Thu Oct 22}} · {{keep:massage}}",
      emptySource(),
    );
    expect(filled.ok).toBe(false);
    expect(filled.text).toBe("{{svc.intext:Skin fade}} · {{price:$45}} · {{day:Thu Oct 22}} · massage");
    // keep's own words are the plan's, not a code-supplied value: the Values check never reads them as one.
    expect(filled.slotValues).toEqual([]);
  });

  it("never lets a slot's own words carry a number the model wrote (rule 4)", () => {
    const sensitive: SlotSource = { ...sampleSource(), sensitive: true };
    for (const text of ["{{keep:$20}}", "{{keep:2 massages}}", "Your {{svc.intext:Skin fade|5pm visit}}"]) {
      const filled = fillText(text, sensitive);
      expect(filled.ok, text).toBe(false);
      expect(filled.text).toBe(text);
    }
    const alternate = fillText("Your {{svc.intext:Skin fade|visit}} is set", sensitive);
    expect(alternate).toEqual({ ok: true, text: "Your visit is set", slotValues: [] });
  });
});
