// The slot filler on K-03 v1's fixtures (contracts/message-plan/fixtures): a plan with any unfilled or unknown slot
// fails (T-310, "Proves it with": check-unfilled-slot.json fails; refuse-hold-slot.json), and A6-14's confirmation
// fills to final-two-sends.json's words and slot values from the record and code facts.

import { describe, expect, it } from "vitest";
import checkUnfilledSlot from "../../../../contracts/message-plan/fixtures/check-unfilled-slot.json";
import finalTwoSends from "../../../../contracts/message-plan/fixtures/final-two-sends.json";
import refuseHoldSlot from "../../../../contracts/message-plan/fixtures/invalid/refuse-hold-slot.json";
import planBlockReadbackPoll from "../../../../contracts/message-plan/fixtures/plan-block-readback-poll.json";
import planConfirmation from "../../../../contracts/message-plan/fixtures/plan-confirmation-a6-14.json";
import planRelay from "../../../../contracts/message-plan/fixtures/plan-relay-private-a7-12.json";
import planSensitive from "../../../../contracts/message-plan/fixtures/plan-sensitive.json";
import { fillPlan, fillText, type SlotValue } from "./fill";
import { initials } from "./fillers";
import { at, emptySource, sampleSource, usd } from "./test-support";
import type { SlotSource } from "./types";

/** The sample cast for A6-14 (SPEC-master 6): Lee's Barbershop on its own listed name. */
function a614Source(): SlotSource {
  const source = sampleSource();
  return {
    ...source,
    facts: {
      ...source.facts,
      business: {
        name: "Lee's Barbershop",
        displayName: "Lee's Barbershop",
        phone: "+15555550177",
        ownerName: "Sam",
      },
    },
  };
}

describe("check-unfilled-slot.json fails", () => {
  const checked = checkUnfilledSlot.checked;
  const sentText = checked.sends[0]?.text ?? "";
  const valuesCheck = checkUnfilledSlot.checks.find((check) => check.check === "values");

  /** The fixture's code facts: the values its slotValues name, and no service. */
  function factsOfFixture(): SlotSource {
    const source = emptySource();
    return {
      ...source,
      zones: { visit: "America/New_York", business: "America/New_York" },
      facts: {
        business: { name: "Lee's Barbershop", displayName: "Lee's Barbershop" },
        visit: { start: at("2026-10-24T15:00:00Z") },
      },
    };
  }

  it("the fixture's facts are the sample cast's: Lee's Barbershop, Sat Oct 24, 11:00am, and no service", () => {
    expect(checked.slotValues).toEqual([
      { slot: "biz.name", value: "Lee's Barbershop" },
      { slot: "day", value: "Sat Oct 24" },
      { slot: "visit.time", value: "11:00am" },
    ]);
  });

  it("fails the plan line it was filled from, leaving {{svc.intext}} as written, as the fixture's checked parts show", () => {
    // The plan's line: the fixture's words with each filled value put back as its slot.
    const line = checked.slotValues.reduce(
      (text, fact) => text.replace(fact.value, `{{${fact.slot}}}`),
      sentText,
    );
    expect(line).toBe("A reminder: your {{svc.intext}} at {{biz.name}} is {{day}} at {{visit.time}}.");

    const filled = fillPlan({ lines: [{ role: "first", text: line }], question: null }, factsOfFixture());
    expect(filled.ok).toBe(false);
    expect(filled.lines.map((filledLine) => filledLine.text)).toEqual([sentText]);
    expect(filled.slotValues).toEqual(checked.slotValues);
    if (filled.ok) return;
    expect(filled.problems).toEqual([
      { kind: "unfilled", slot: "svc.intext", detail: valuesCheck?.detail, why: null },
    ]);
  });

  it("fails the checked words themselves: '{{' is left in the text", () => {
    const filled = fillText(sentText, factsOfFixture());
    expect(filled.ok).toBe(false);
    expect(filled.text).toBe(sentText);
    expect(filled.text).toContain("{{");
    if (filled.ok) return;
    expect(filled.problems.map((problem) => problem.detail)).toEqual([valuesCheck?.detail]);
  });

  it("passes once the service is a fact", () => {
    const source = factsOfFixture();
    const filled = fillText(sentText, { ...source, facts: { ...source.facts, serviceName: "Haircut" } });
    expect(filled).toEqual({
      ok: true,
      text: "A reminder: your Haircut at Lee's Barbershop is Sat Oct 24 at 11:00am.",
      slotValues: [{ slot: "svc.intext", value: "Haircut" }],
    });
  });
});

describe("a plan with an unknown slot fails", () => {
  it("fails refuse-hold-slot.json: {{hold}} is refused since D66, and the rest still fills", () => {
    const filled = fillPlan(refuseHoldSlot, a614Source());
    expect(filled.ok).toBe(false);
    expect(filled.lines.map((line) => line.text)).toEqual([
      "You're booked at Lee's Barbershop for Sat Oct 24 at 11:00am.",
      "{{hold:$89}} is held on your card until the visit.",
    ]);
    if (filled.ok) return;
    expect(filled.problems).toEqual([
      {
        kind: "unknown",
        slot: "hold",
        detail: "The slot {{hold}} is refused since D66 (nothing is held), so '{{' is left in the text.",
        why: null,
      },
    ]);
  });

  it("fails a slot outside the vocabulary and a '{{' that opens no slot", () => {
    const filled = fillText("{{visit.room}} at {{biz.name}} {{ and {{{day}}", a614Source());
    expect(filled.ok).toBe(false);
    expect(filled.text).toBe("{{visit.room}} at Lee's Barbershop {{ and {Sat Oct 24");
    if (filled.ok) return;
    expect(filled.problems.map((problem) => [problem.kind, problem.slot])).toEqual([
      ["unknown", "visit.room"],
      ["unknown", ""],
    ]);
  });

  it("passes words with no slot as they are", () => {
    expect(fillText("Thanks, see you then.", emptySource())).toEqual({
      ok: true,
      text: "Thanks, see you then.",
      slotValues: [],
    });
  });
});

describe("A6-14's confirmation (plan-confirmation-a6-14.json) fills to final-two-sends.json", () => {
  it("gives the words of the first send, every slot filled from the record and code facts", () => {
    const filled = fillPlan(planConfirmation, a614Source());
    expect(filled.ok).toBe(true);
    expect(filled.lines.map((line) => line.role)).toEqual(planConfirmation.lines.map((line) => line.role));
    expect(filled.lines.map((line) => line.text).join("\n")).toBe(finalTwoSends.sends[0]?.text);
    expect(filled.question).toBeNull();
  });

  it("gives the slot values the Values check reads, in order of first use", () => {
    const filled = fillPlan(planConfirmation, a614Source());
    const expected: SlotValue[] = finalTwoSends.slotValues.map((fact) => ({
      slot: fact.slot as SlotValue["slot"],
      value: fact.value,
    }));
    expect(filled.slotValues).toEqual(expected);
  });

  it("fails when the booking's record is not read: the money lines have no value", () => {
    const filled = fillPlan(planConfirmation, { ...a614Source(), record: null });
    expect(filled.ok).toBe(false);
    if (filled.ok) return;
    expect(filled.problems.map((problem) => problem.slot)).toEqual(["pay.price", "pay.took", "pay.cancel"]);
  });
});

describe("other K-03 plans", () => {
  it("fills a read-back question with the block's date and time (plan-block-readback-poll.json), keeping its options", () => {
    const filled = fillPlan(planBlockReadbackPoll, a614Source());
    expect(filled.ok).toBe(true);
    expect(filled.lines.map((line) => line.text)).toEqual([
      "Ben T. is booked at 11:00am, inside the block you asked for.",
    ]);
    expect(filled.question).toEqual({
      text: "Block Thu Oct 29, 2–5pm at Lee's Barbershop?",
      optionIds: ["S11-13/1", "S11-13/2"],
    });
  });

  it("quotes a relay in its code-filled slot (plan-relay-private-a7-12.json)", () => {
    const source = a614Source();
    const filled = fillPlan(planRelay, {
      ...source,
      facts: { ...source.facts, relayQuote: "Read it on the secure page" },
    });
    expect(filled.ok).toBe(true);
    expect(filled.lines.map((line) => line.text)).toEqual([
      "Alex M. asks: Read it on the secure page",
      "Read it on the secure page: rosfield.com/v/s03",
    ]);
    expect(filled.question?.text).toBe("Your answer for Alex M.?");
  });

  it("fills a sensitive plan with initials and no service, one ' · ' going with it (plan-sensitive.json; D41)", () => {
    const source = a614Source();
    const filled = fillPlan(planSensitive, { ...source, sensitive: true });
    expect(filled.ok).toBe(true);
    expect(filled.lines.map((line) => line.text)).toEqual([
      "New booking: A.M. · Sat Oct 24 · 11:00am",
      "The details are on the secure page: rosfield.com/v/s03",
    ]);
    expect(filled.slotValues).toContainEqual({ slot: "svc.intext", value: "" });
  });
});

describe("sensitive forms (RULES 4.6; S13-22; D41)", () => {
  const sensitive = (): SlotSource => ({ ...sampleSource(), sensitive: true });

  it("shows initials for alex.staff and name.staff, and the display name for biz.name", () => {
    const filled = fillText("{{alex.staff}} moved {{name.staff}} at {{biz.name}}", sensitive());
    expect(filled.ok && filled.text).toBe("A.M. moved B.T. at Lee's");
  });

  it("says the words after '|' for the service, else nothing with one separator next to it", () => {
    expect(fillText("Your {{svc.intext:Skin fade|visit}} is set", sensitive()).text).toBe(
      "Your visit is set",
    );
    expect(fillText("{{svc.intext}} · Sat 11am", sensitive()).text).toBe("Sat 11am");
    expect(fillText("Lee's, {{svc.intext}}, Sat", sensitive()).text).toBe("Lee's, Sat");
    expect(fillText("Your {{name}} is set", sensitive()).text).toBe("Your is set");
  });

  it("keeps every other slot as it is", () => {
    const filled = fillText("{{pro.name}} at {{visit.place}}, code {{visit.code}}", sensitive());
    expect(filled.ok && filled.text).toBe("Riley at 88 Elm St, Springfield, code 5160");
  });

  it("makes initials from each part of a name", () => {
    expect(initials("Alex M.")).toBe("A.M.");
    expect(initials("  dee   w ")).toBe("D.W.");
    expect(initials("Émile Zola")).toBe("É.Z.");
  });
});

describe("value types", () => {
  it("reads a set-start business's arrival as its start (D48)", () => {
    const source = sampleSource();
    const setStart: SlotSource = {
      ...source,
      record: source.record === null ? null : { ...source.record, booking: { times: "setstart" } },
    };
    expect(fillText("The pro {{arrive}} ({{window}})", setStart).text).toBe(
      "The pro starts at 8:00am (8:00am)",
    );
  });

  it("writes a window across noon with both halves, and a change with no end as its start", () => {
    const source = sampleSource();
    const filled = fillText("{{window}} · {{change.when}}", {
      ...source,
      facts: {
        ...source.facts,
        visit: { arrival: { start: at("2026-10-24T15:30:00Z"), end: at("2026-10-24T17:00:00Z") } },
        change: { when: { start: at("2026-10-29T18:00:00Z"), end: null } },
      },
    });
    expect(filled.ok && filled.text).toBe("11:30am–1pm · Thu Oct 29, 2:00pm");
  });

  it("shows each time in the zone it carries (CQ-09; S13-03)", () => {
    const source = sampleSource();
    const filled = fillText("{{day}} {{visit.time}}", {
      ...source,
      facts: { ...source.facts, visit: { start: at("2026-10-24T15:00:00Z", "America/Los_Angeles") } },
    });
    expect(filled.ok && filled.text).toBe("Sat Oct 24 8:00am");
  });

  it("refuses a time that is not an instant in UTC, or a zone that is not an IANA zone", () => {
    const source = sampleSource();
    for (const start of [at("2026-10-24 15:00"), at("2026-10-24T15:00:00Z", "Elm/Street")]) {
      const filled = fillText("{{visit.time}}", { ...source, facts: { ...source.facts, visit: { start } } });
      expect(filled.ok).toBe(false);
    }
  });

  it("refuses a phone that is not E.164 and keeps one outside +1 as stored", () => {
    const source = sampleSource();
    const call = (phone: string) =>
      fillText("{{biz.phone}}", {
        ...source,
        facts: { ...source.facts, business: { name: "Lee's Barbershop", displayName: "Lee's", phone } },
      });
    expect(call("555-0177").ok).toBe(false);
    expect(call("+442071838750").text).toBe("+442071838750");
  });

  it("refuses a link with a space and a blank name", () => {
    const source = sampleSource();
    const filled = fillText("{{link.pay}} {{pro.name}}", {
      ...source,
      facts: { ...source.facts, links: { pay: "rosfield.com/p a2" }, proName: "  " },
    });
    expect(filled.ok).toBe(false);
    if (filled.ok) return;
    expect(filled.problems.map((problem) => problem.slot)).toEqual(["link.pay", "pro.name"]);
  });

  it("puts the chat link's QR code only where a screen shows it: an email, never a text (MC C9)", () => {
    expect(fillText("{{link.chatqr}}", sampleSource()).ok).toBe(false);
    expect(fillText("{{link.chatqr}}", { ...sampleSource(), channel: "email" }).text).toBe(
      "rosfield.com/c/k7",
    );
  });

  it("lists a slot used twice once in the slot values", () => {
    const source = sampleSource();
    const filled = fillText("{{price}} now, {{price}} later", {
      ...source,
      facts: { ...source.facts, amounts: { price: usd(3500) } },
    });
    expect(filled).toEqual({
      ok: true,
      text: "$35 now, $35 later",
      slotValues: [{ slot: "price", value: "$35" }],
    });
  });
});
