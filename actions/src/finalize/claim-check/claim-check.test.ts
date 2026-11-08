// The claim check, limit 7 (T-311; C-091; arch 06 line 311; RULES 4.5, 4.6; S13-22), on K-03 v1's plans and one
// shared field set read by each audience.

import { describe, expect, it } from "vitest";
import planRelay from "../../../../contracts/message-plan/fixtures/plan-relay-private-a7-12.json";
import planSensitive from "../../../../contracts/message-plan/fixtures/plan-sensitive.json";
import { ROLES } from "../../domain/identity-access";
import { SLOT_NAMES, type SlotName, type SlotSource } from "../slots";
import {
  SECURE_PAGE_WORDS,
  claimFacts,
  claimPlan,
  claimSlot,
  claimText,
  readerOf,
  type ClaimContext,
  type Reader,
  type SlotClaim,
} from "./index";
import { CARD_COUNTER, RECORD_ROWS, barberSource, sampleValues, therapistSource } from "./test-support";

const OPTION_IDS = ["A7-12/1", "A7-12/2", "A7-12/3"];

function texts(claimed: { readonly lines: readonly { readonly text: string }[] }): string[] {
  return claimed.lines.map((line) => line.text);
}

function claimOf(claims: readonly SlotClaim[], slot: SlotName): SlotClaim | undefined {
  return claims.find((claim) => claim.slot === slot);
}

describe("plan-relay-private-a7-12.json: the private part reads 'Read it on the secure page'", () => {
  it("relays Alex M.'s words to Riley as 'Read it on the secure page' when they were not read clear", () => {
    const claimed = claimPlan(planRelay, barberSource(), { reader: "staff" });
    expect(claimed.ok).toBe(true);
    expect(texts(claimed)).toEqual([
      "Alex M. asks: Read it on the secure page",
      "Read it on the secure page: rosfield.com/v/s03",
    ]);
    expect(claimed.question).toEqual({ text: "Your answer for Alex M.?", optionIds: OPTION_IDS });
    expect(claimed.questionCut).toBe(false);
    expect(claimed.claims).toEqual([
      { slot: "alex.staff", verdict: "show", why: "inAudience" },
      { slot: "relay.quote", verdict: "securePage", why: "privateWords" },
      { slot: "link.secure", verdict: "show", why: "inAudience" },
    ]);
    expect(JSON.stringify(claimed)).not.toContain("Can my son wait");
  });

  it("treats words read as private, or not marked clear, as private (RULES 4.5: when unsure)", () => {
    for (const context of [{ reader: "staff", quoteClear: false }, { reader: "owner" }] as const) {
      const claimed = claimPlan(planRelay, barberSource(), context);
      expect(texts(claimed)[0]).toBe(`Alex M. asks: ${SECURE_PAGE_WORDS}`);
      expect(claimed.slotValues.map((value) => value.slot)).not.toContain("relay.quote");
    }
  });

  it("quotes the words themselves only when they were read and hold nothing private", () => {
    const claimed = claimPlan(planRelay, barberSource(), { reader: "staff", quoteClear: true });
    expect(texts(claimed)[0]).toBe("Alex M. asks: Can my son wait in the shop during my cut?");
    expect(claimOf(claimed.claims, "relay.quote")).toEqual({
      slot: "relay.quote",
      verdict: "show",
      why: "inAudience",
    });
  });

  it("cuts the customer's name with its sentence for a customer reader, the question with it", () => {
    const claimed = claimPlan(planRelay, barberSource(), { reader: "customer", quoteClear: true });
    expect(texts(claimed)).toEqual(["Read it on the secure page: rosfield.com/v/s03"]);
    expect(claimed.question).toBeNull();
    expect(claimed.questionCut).toBe(true);
    expect(claimOf(claimed.claims, "alex.staff")).toEqual({
      slot: "alex.staff",
      verdict: "cut",
      why: "notInAudience",
    });
    expect(JSON.stringify(claimed)).not.toContain("Alex M.");
  });
});

describe("plan-sensitive.json: the sensitive switch", () => {
  it("keeps the service on the secure page and gives staff initials", () => {
    const claimed = claimPlan(planSensitive, therapistSource(), { reader: "staff" });
    expect(claimed.ok).toBe(true);
    expect(texts(claimed)).toEqual([
      "New booking: A.M. · Sat Oct 24 · 11:00am",
      "The details are on the secure page: rosfield.com/v/s03",
    ]);
    expect(claimed.claims).toEqual([
      { slot: "alex.staff", verdict: "sensitiveForm", why: "sensitive" },
      { slot: "svc.intext", verdict: "sensitiveForm", why: "sensitive" },
      { slot: "day", verdict: "show", why: "inAudience" },
      { slot: "visit.time", verdict: "show", why: "inAudience" },
      { slot: "link.secure", verdict: "show", why: "inAudience" },
    ]);
    const all = JSON.stringify(claimed);
    expect(all).not.toContain("First session");
    expect(all).not.toContain("Alex M.");
  });

  it("names the customer and the service with the switch off", () => {
    const source: SlotSource = { ...therapistSource(), sensitive: false };
    const claimed = claimPlan(planSensitive, source, { reader: "staff" });
    expect(texts(claimed)[0]).toBe("New booking: Alex M. · First session · Sat Oct 24 · 11:00am");
    expect(claimed.claims.every((claim) => claim.verdict === "show")).toBe(true);
  });

  it("applies the switch when the record's live switches hold it, though the source says off", () => {
    const source: SlotSource = {
      ...therapistSource(),
      sensitive: false,
      record: { ...CARD_COUNTER, switches: ["sensitive"] },
    };
    const claimed = claimPlan(planSensitive, source, { reader: "staff" });
    expect(texts(claimed)[0]).toBe("New booking: A.M. · Sat Oct 24 · 11:00am");
    expect(claimFacts(["svc.intext", "alex.staff"], source, { reader: "staff" })).toEqual([
      { slot: "svc.intext", value: SECURE_PAGE_WORDS },
      { slot: "alex.staff", value: "A.M." },
    ]);
    expect(claimSlot("relay.quote", source, { reader: "staff", quoteClear: true })).toEqual({
      slot: "relay.quote",
      verdict: "securePage",
      why: "sensitive",
    });
  });

  it("keeps the reason on the secure page: a person's own words, even read clear", () => {
    const claimed = claimPlan(planRelay, therapistSource(), { reader: "staff", quoteClear: true });
    expect(texts(claimed)[0]).toBe(`A.M. asks: ${SECURE_PAGE_WORDS}`);
    expect(claimOf(claimed.claims, "relay.quote")).toEqual({
      slot: "relay.quote",
      verdict: "securePage",
      why: "sensitive",
    });
    expect(JSON.stringify(claimed)).not.toContain("bring my partner");
  });

  it("says 'your visit' to the customer where the plan gives it, else nothing in place of the service", () => {
    const withWords = claimText(
      "See you for {{svc.intext:First session|your visit}} on {{day}}.",
      therapistSource(),
      { reader: "customer" },
    );
    expect(withWords.text).toBe("See you for your visit on Sat Oct 24.");
    const bare = claimText("{{svc.intext:First session}}, {{day}} at {{visit.time}}", therapistSource(), {
      reader: "customer",
    });
    expect(bare.text).toBe("Sat Oct 24 at 11:00am");
  });

  it("gives the business by its display name", () => {
    const source: SlotSource = { ...barberSource(), sensitive: true };
    const claimed = claimText("{{biz.name}}: see you {{day}}.", source, { reader: "customer" });
    expect(claimed.text).toBe("Lee's: see you Sat Oct 24.");
    expect(claimed.claims[0]).toEqual({ slot: "biz.name", verdict: "sensitiveForm", why: "sensitive" });
  });
});

// One shared field set: a line per audience profile, read by each audience in turn.
const FIELD_SET = {
  lines: [
    { role: "first", text: "Your check-in code is {{visit.code}}." }, // the customer only (K-03; K-30 check_in_code)
    { role: "fact", text: "{{alex.staff}} booked a visit." }, // the owner and staff (K-03)
    { role: "fact", text: "{{two.count}}" }, // the owner only (K-03)
    { role: "fact", text: "Due now: {{due}}." }, // the customer and staff (K-03)
    { role: "fact", text: "On {{day}} at {{visit.time}}." }, // every reader (K-03; K-04 reservations.during)
    { role: "action", text: "Where: {{visit.place}}" }, // the secure page only (K-30 booking_addresses.address)
  ],
  question: null,
};

const TWO_COUNT = RECORD_ROWS["two.count"]?.at(-1)?.text;
const ON_THE_DAY = "On Sat Oct 24 at 11:00am.";
const WHERE = `Where: ${SECURE_PAGE_WORDS}`;

function claimsByVerdict(claims: readonly SlotClaim[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const { slot, verdict } of claims) out[verdict] = [...(out[verdict] ?? []), slot];
  return out;
}

describe("one test per audience on one shared field set", () => {
  it("customer: the code, what is due, the day and time; never the owner's or staff's fields", () => {
    const claimed = claimPlan(FIELD_SET, barberSource(), { reader: "customer" });
    expect(claimed.ok).toBe(true);
    expect(texts(claimed)).toEqual(["Your check-in code is 5160.", "Due now: $35.", ON_THE_DAY, WHERE]);
    expect(claimsByVerdict(claimed.claims)).toEqual({
      show: ["visit.code", "due", "day", "visit.time"],
      cut: ["alex.staff", "two.count"],
      securePage: ["visit.place"],
    });
  });

  it("staff: the customer's name, what is due, the day and time; never the code or the owner's $2 line", () => {
    const claimed = claimPlan(FIELD_SET, barberSource(), { reader: "staff" });
    expect(texts(claimed)).toEqual(["Alex M. booked a visit.", "Due now: $35.", ON_THE_DAY, WHERE]);
    expect(claimsByVerdict(claimed.claims)).toEqual({
      show: ["alex.staff", "due", "day", "visit.time"],
      cut: ["visit.code", "two.count"],
      securePage: ["visit.place"],
    });
    expect(JSON.stringify(claimed)).not.toContain("5160");
  });

  it("owner: the customer's name, the $2 line, the day and time; never the code or what the customer owes", () => {
    expect(TWO_COUNT).toBeTypeOf("string");
    const claimed = claimPlan(FIELD_SET, barberSource(), { reader: "owner" });
    expect(texts(claimed)).toEqual(["Alex M. booked a visit.", TWO_COUNT, ON_THE_DAY, WHERE]);
    expect(claimsByVerdict(claimed.claims)).toEqual({
      show: ["alex.staff", "two.count", "day", "visit.time"],
      cut: ["visit.code", "due"],
      securePage: ["visit.place"],
    });
  });

  it("secure page only: every reader reads 'Read it on the secure page', never the place", () => {
    for (const reader of ["customer", "staff", "owner"] as const) {
      const claimed = claimPlan(FIELD_SET, barberSource(), { reader });
      expect(texts(claimed).at(-1)).toBe(WHERE);
      expect(claimOf(claimed.claims, "visit.place")).toEqual({
        slot: "visit.place",
        verdict: "securePage",
        why: "securePageOnly",
      });
      expect(claimed.slotValues.map((value) => value.slot)).not.toContain("visit.place");
      expect(JSON.stringify(claimed)).not.toContain("Elm St");
    }
  });

  it("names the field it was read from: the flow A location shows, the flow B visit address stays on the page", () => {
    const location: ClaimContext = {
      reader: "customer",
      fields: { "visit.place": ["business-setup.locations.address"] },
    };
    expect(texts(claimPlan(FIELD_SET, barberSource(), location)).at(-1)).toBe(
      "Where: 88 Elm St, Springfield",
    );
    const address: ClaimContext = {
      reader: "customer",
      fields: { "visit.place": ["bookings-changes.booking_addresses.address"] },
    };
    expect(texts(claimPlan(FIELD_SET, barberSource(), address)).at(-1)).toBe(WHERE);
  });

  it("a named field never widens the slot's own audience (K-03 v1)", () => {
    const context: ClaimContext = { reader: "staff", fields: { "visit.code": ["core.businesses.name"] } };
    expect(claimSlot("visit.code", barberSource(), context)).toEqual({
      slot: "visit.code",
      verdict: "cut",
      why: "notInAudience",
    });
  });
});

describe("fail closed", () => {
  it("cuts a field no message may show (never), with its sentence", () => {
    const context: ClaimContext = {
      reader: "staff",
      quoteClear: true,
      fields: { "relay.quote": ["core.messages.words"] },
    };
    const claimed = claimText("Riley, a note. {{alex.staff}} asks: {{relay.quote}}", barberSource(), context);
    expect(claimed.text).toBe("Riley, a note.");
    expect(claimOf(claimed.claims, "relay.quote")).toEqual({
      slot: "relay.quote",
      verdict: "cut",
      why: "never",
    });
  });

  it("never shows a field with no known audience: a column no table list holds, or no field named", () => {
    for (const fields of [["business-setup.locations.street"], [], ["core.persons"]]) {
      const context: ClaimContext = { reader: "customer", fields: { "visit.place": fields } };
      const claimed = claimText("You booked. Where: {{visit.place}}", barberSource(), context);
      expect(claimed.text).toBe("You booked.");
      expect(claimed.claims).toEqual([{ slot: "visit.place", verdict: "cut", why: "unknownField" }]);
    }
  });

  it("shows nothing to a reader K-03 does not name", () => {
    const reader = "admin" as unknown as Reader;
    const claimed = claimPlan(FIELD_SET, barberSource(), { reader, quoteClear: true });
    expect(claimed.lines).toEqual([]);
    expect(claimed.claims.every((claim) => claim.verdict === "cut" && claim.why === "notInAudience")).toBe(
      true,
    );
  });

  it("leaves a slot outside the vocabulary for the fill to refuse, so the text never goes", () => {
    const claimed = claimText("Your deposit {{hold}} is kept.", barberSource(), { reader: "customer" });
    expect(claimed.ok).toBe(false);
    expect(claimed.text).toContain("{{hold}}");
    expect(claimed.claims).toEqual([]);
  });

  it("never shows a nested slot past its own audience: a record row is cut or kept back with it", () => {
    const rows = {
      "pay.took": [{ text: "Paid. Your code is {{visit.code}}" }],
      "pay.asks": [{ text: "Asks {{relay.quote}}" }],
    };
    const source: SlotSource = { ...barberSource(), record: { ...CARD_COUNTER, rows } };
    expect(claimSlot("pay.took", source, { reader: "owner" })).toEqual({
      slot: "pay.took",
      verdict: "cut",
      why: "nested",
    });
    expect(claimSlot("pay.took", source, { reader: "customer" })).toEqual({
      slot: "pay.took",
      verdict: "show",
      why: "inAudience",
    });
    const kept = claimText("{{pay.asks}}", source, { reader: "owner" });
    expect(kept.text).toBe(SECURE_PAGE_WORDS);
    expect(kept.claims).toEqual([{ slot: "pay.asks", verdict: "securePage", why: "nested" }]);
  });
});

describe("cutting a sentence", () => {
  it("cuts only the sentence that holds the slot", () => {
    const claimed = claimText(
      "Riley says yes. Your code is {{visit.code}}. See you {{day}}.",
      barberSource(),
      {
        reader: "staff",
      },
    );
    expect(claimed.text).toBe("Riley says yes. See you Sat Oct 24.");
  });

  it("reads a slot's example words as part of the slot, never as a sentence end", () => {
    const claimed = claimText("{{alex.staff:Alex M.}} asks. Thanks!", barberSource(), { reader: "customer" });
    expect(claimed.text).toBe("Thanks!");
  });

  it("ends a sentence at a line break, and drops a line left with no words", () => {
    expect(claimText("Booked\n{{visit.code}} is your code", barberSource(), { reader: "owner" }).text).toBe(
      "Booked",
    );
    const claimed = claimPlan(
      { lines: [{ text: "{{visit.code}}" }, { text: "See you {{day}}." }], question: null },
      barberSource(),
      { reader: "staff" },
    );
    expect(texts(claimed)).toEqual(["See you Sat Oct 24."]);
  });
});

describe("claims carry no value", () => {
  it("names slots and closed reasons only, for every slot and reader", () => {
    const every = { lines: SLOT_NAMES.map((slot) => ({ text: `{{${slot}}}` })), question: null };
    for (const source of [barberSource(), therapistSource()]) {
      for (const reader of ["customer", "staff", "owner"] as const) {
        const { claims } = claimPlan(every, source, { reader, quoteClear: true });
        expect(claims.map((claim) => claim.slot)).toEqual([...SLOT_NAMES]);
        const written = JSON.stringify(claims);
        for (const value of sampleValues(source)) expect(written).not.toContain(value);
      }
    }
  });
});

describe("the composer's facts (K-03 composeInput facts)", () => {
  it("gives only what limit 7 lets this reader see", () => {
    const slots: SlotName[] = ["visit.code", "alex.staff", "visit.place", "relay.quote", "day"];
    expect(claimFacts(slots, barberSource(), { reader: "customer" })).toEqual([
      { slot: "visit.code", value: "5160" },
      { slot: "visit.place", value: SECURE_PAGE_WORDS },
      { slot: "relay.quote", value: SECURE_PAGE_WORDS },
      { slot: "day", value: "Sat Oct 24" },
    ]);
    expect(claimFacts(slots, barberSource(), { reader: "staff", quoteClear: true })).toEqual([
      { slot: "alex.staff", value: "Alex M." },
      { slot: "visit.place", value: SECURE_PAGE_WORDS },
      { slot: "relay.quote", value: "Can my son wait in the shop during my cut?" },
      { slot: "day", value: "Sat Oct 24" },
    ]);
  });

  it("under the sensitive switch: the service on the secure page, initials, and nothing code cannot fill", () => {
    const slots: SlotName[] = ["svc.intext", "alex.staff", "day", "pro.name", "visit.code"];
    expect(claimFacts(slots, therapistSource(), { reader: "staff" })).toEqual([
      { slot: "svc.intext", value: SECURE_PAGE_WORDS },
      { slot: "alex.staff", value: "A.M." },
      { slot: "day", value: "Sat Oct 24" },
      { slot: "pro.name", value: "Maya" },
    ]);
    expect(claimFacts(["visit.code"], therapistSource(), { reader: "customer" })).toEqual([]);
  });
});

describe("the recipient's role (identity and access, T-308)", () => {
  it("reads owner and admin as the owner, staff and customer as themselves, and own_business as no reader", () => {
    const expected: Readonly<Record<string, Reader | null>> = {
      owner: "owner",
      admin: "owner",
      staff: "staff",
      own_business: null,
      customer: "customer",
    };
    expect(Object.fromEntries(ROLES.map((role) => [role, readerOf(role)]))).toEqual(expected);
  });
});
