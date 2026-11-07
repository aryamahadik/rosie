// T-142: sample-value slotting. Proofs of the card (the all-trades scan is in parity.shard-N.test.ts; this file runs on
// the master and on four trades):
//   - every slot the compiler writes is in K-03 v1's vocabulary; an invented slot fails as refuse-unknown-slot.json does
//     (the lint rule `unknown-slot`), and `{{hold}}` is refused (D66);
//   - sample names, businesses, dates, times, places, phone numbers, codes and $ amounts in message lines become slots;
//   - `$2`, the `$49` cap and `1%` stay literal, in S1-25, S1-29 and A9-21 (the record's two.count rows) and everywhere;
//   - a slot a line already holds is never slotted again.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { loadTrade, type LoadedTrade } from "../load/trade";
import { applyTrade, type AppliedStep, type AppliedTrade } from "../overlay/apply";
import { tradePaths, walkPath } from "../path";
import { HoldSlotError, SLOT_NAMES } from "../record";
import {
  FEE_TERMS,
  MalformedSlotError,
  UnknownSlotError,
  checkLines,
  checkSlotNames,
  countFeeTerms,
  eachStep,
  flowLines,
  leftovers,
  pathLines,
  recordLines,
  sampleTable,
  slotApplied,
  slotCounts,
  slotMessage,
  slotNames,
  slotRefs,
  slotText,
  slotVocabulary,
  type SampleTable,
} from "./index";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
vi.setConfig({ testTimeout: 120_000 });

const master = loadMaster();

/** The slots the compiler makes itself, from sample values (everything else a line holds was written by the master). */
const COMPILER_SLOTS = [
  "biz.name",
  "owner.name",
  "pro.name",
  "alex.staff",
  "name.staff",
  "visit.place",
  "biz.phone",
  "visit.code",
  "day",
  "visit.time",
  "arrive",
  "window",
  "ask.by",
  "change.when",
  "price",
  "fee",
  "deposit",
  "rest",
  "paid",
  "change.price",
];

function masterTable(flow: FlowLetter): SampleTable {
  return sampleTable(master, flow, null, master[flow]);
}

describe("the vocabulary (K-03 v1)", () => {
  it("holds 52 distinct slots: the record's 16, no hold", () => {
    const names = slotNames();
    expect(names).toHaveLength(52);
    expect(new Set(names).size).toBe(52);
    for (const name of SLOT_NAMES) expect(names, name).toContain(name);
    expect(names).not.toContain("hold");
    expect(slotVocabulary().filter((slot) => slot.status === "proposedCQ17")).toHaveLength(15);
  });

  it("holds every slot the compiler makes", () => {
    for (const name of COMPILER_SLOTS) expect(slotNames(), name).toContain(name);
  });

  it("accepts the slots of the master's own lines", () => {
    expect(() => {
      checkSlotNames(
        "{{pay.cancel}} {{svc.intext:Haircut}} {{price:$90}} {{due:$125}} {{keep}} {{alex.staff:Alex M.}} {{biz.name}}",
        "test",
      );
    }).not.toThrow();
  });

  it("refuses an invented slot as the lint rule unknown-slot", () => {
    for (const text of [
      "Hi {{biz.nickname}}",
      "{{pay.mystery}}",
      "{{pro.name2}}",
      "{{owner}}",
      "{{Biz.name}}",
    ]) {
      const bad = () => {
        checkSlotNames(text, "A1-01 say");
      };
      expect(bad, text).toThrow(/A1-01 say/);
      try {
        bad();
        expect.unreachable();
      } catch (error) {
        if (error instanceof MalformedSlotError) continue;
        expect(error, text).toBeInstanceOf(UnknownSlotError);
        expect((error as UnknownSlotError).code).toBe("unknown-slot");
      }
    }
  });

  it("refuses {{hold}} (D66), however it is written", () => {
    for (const text of ["{{hold}}", "{{hold:$40}}", "{{ hold | words }}"]) {
      expect(() => {
        checkSlotNames(text, "A5-01 say");
      }, text).toThrow(HoldSlotError);
    }
  });

  it("refuses braces that are not a slot", () => {
    for (const text of ["{{ }}", "unclosed {{pay.cancel", "stray }} brace"]) {
      expect(() => {
        checkSlotNames(text, "x");
      }, text).toThrow(MalformedSlotError);
    }
  });

  it("fails refuse-unknown-slot.json the same way: its visit.place is outside K-01 v1's closed list", () => {
    const fixture = JSON.parse(
      readFileSync(`${ROOT}contracts/bundle/fixtures/invalid/refuse-unknown-slot.json`, "utf8"),
    ) as { say: { text: string }[] };
    const schema = JSON.parse(readFileSync(`${ROOT}contracts/bundle/bundle.v1.schema.json`, "utf8")) as {
      $defs: { messagesWithUnknownSlot: { contains: { properties: { text: { pattern: string } } } } };
    };
    const pattern = schema.$defs.messagesWithUnknownSlot.contains.properties.text.pattern;
    const list = /\(\?!\(([^)]*)\)/.exec(pattern)?.[1];
    expect(list, "the closed list in the schema").toBeDefined();
    const closed = (list ?? "").split("|").map((name) => name.replace(/\\\./g, "."));
    expect(closed).toHaveLength(36);
    // K-03 holds every K-01 name but hold (D66), and 16 more.
    for (const name of closed) if (name !== "hold") expect(slotNames(), name).toContain(name);

    const message = fixture.say[0];
    expect(message).toBeDefined();
    let caught: unknown;
    try {
      checkSlotNames(message?.text ?? "", "A6-14 say", closed);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnknownSlotError);
    expect((caught as UnknownSlotError).slot).toBe("visit.place");
    expect((caught as UnknownSlotError).code).toBe("unknown-slot");
    // The same line is fine against K-03 v1, which holds the compiler's slots.
    expect(() => {
      checkSlotNames(message?.text ?? "", "A6-14 say");
    }).not.toThrow();
  });

  it("reads a slot's name, example and other words", () => {
    const [ref] = slotRefs("a {{svc.intext:Skin fade|visit}} b");
    expect(ref).toMatchObject({ name: "svc.intext", example: "Skin fade", other: "visit" });
  });
});

describe("slotText on the master's sample cast", () => {
  const A = masterTable("A");
  const slot = (text: string): string => slotText(text, masterTable("A"));

  it("turns names, businesses, places and phones into slots, possessives kept", () => {
    expect(slot("Lee's Barbershop · {{svc.intext:Haircut}}")).toBe("{{biz.name}} · {{svc.intext:Haircut}}");
    expect(slot("Riley's next time, and Avery's")).toBe("{{pro.name}}'s next time, and {{pro.name}}'s");
    expect(slot("Sam Lee, Sam and Pat")).toBe("{{owner.name}}, {{owner.name}} and {{name.staff}}");
    expect(slot("Alex M. and Alex, A.M.")).toBe("{{alex.staff}} and {{alex.staff}}, {{alex.staff}}");
    expect(slot("88 Elm St, Springfield")).toBe("{{visit.place}}");
    expect(slot("on Elm St · 1200 Main St")).toBe("on {{visit.place}} · {{visit.place}}");
    expect(slot("call (555) 010-0177")).toBe("call {{biz.phone}}");
    expect(slot("Lee Home Services LLC")).toBe("{{biz.name}}");
  });

  it("turns days, times and deadlines into slots", () => {
    expect(slot("Sat Oct 24 · 11:00am · Riley")).toBe("{{day}} · {{visit.time}} · {{pro.name}}");
    expect(slot("Mon Nov 2, 2026")).toBe("{{day}}");
    expect(slot("late Aug 2027")).toBe("late {{day}}");
    expect(slot("answer by 9:00am Sat")).toBe("answer by {{ask.by}}");
    expect(slot("Cancel by 11:59pm Tue Oct 27")).toBe("Cancel by {{ask.by}}");
    expect(slot("Pay with this link by Thu 11:20am")).toBe("Pay with this link by {{ask.by}}");
    expect(slot("Block Thu Oct 29, 2–5pm?")).toBe("Block {{change.when}}?");
    expect(slot("arriving 8–10am")).toBe("{{arrive}}");
    expect(slot("starts at 9:00am")).toBe("{{arrive}}");
    expect(slot("the 8–10am window")).toBe("the {{window}} window");
    expect(slot("between 8 and 10am")).toBe("between {{window}}");
    expect(slot("6pm the day before")).toBe("{{visit.time}} the day before");
  });

  it("turns $ amounts into the slot of their field, or change.price when no table holds them", () => {
    expect(A.amounts.get("$35")).toEqual(new Set(["price"]));
    expect(slot("A haircut is $35")).toBe("A haircut is {{price}}");
    expect(slot("a $20 no-show fee")).toBe("a {{fee}} no-show fee");
    expect(slot("$40 deposit now")).toBe("{{deposit}} deposit now");
    expect(slot("the $100 rest")).toBe("the {{rest}} rest");
    expect(slot("a $75 house call")).toBe("a {{change.price}} house call");
    expect(slot("$2,400 repipe")).toBe("{{change.price}} repipe");
  });

  it("leaves Rosie's fee terms literal: $2 a booking, the $49 cap, 1%", () => {
    const line =
      "Rosfield charges $2 per booking, never more than $49 a month per person. Plans billed through Rosie: 1%.";
    expect(slot(line)).toBe(line);
    expect(FEE_TERMS).toEqual(["$2", "$49", "1%"]);
    expect(countFeeTerms("$2 and $20, $2,400, 11% and 1%, $49")).toEqual({ $2: 1, $49: 1, "1%": 1 });
  });

  it("leaves real emergency and hotline numbers alone: only 555-010-xxxx is a sample", () => {
    const line = "Call 911, or the hotline at 1-800-799-7233 or 833-372-8311.";
    expect(slot(line)).toBe(line);
    expect(slot("text 555-010-0190")).toBe("text {{biz.phone}}");
  });

  it("never slots a slot again: record slots, amount slots, svc.intext, name.staff and the words inside them", () => {
    for (const line of [
      "{{pay.cancel}}",
      "Free to cancel until {{cutoff:Fri 11am}}.",
      "{{price:$90}} for {{svc.intext:Color and cut|Your visit}}",
      "{{due:$125}} · {{name.staff:Dee W.}} · {{alex.staff:Alex M.}}",
      "{{window:8–10am}} {{day:Sat}}",
    ]) {
      expect(slot(line), line).toBe(line);
    }
  });

  it("leaves no sample value as example words: a slot is written bare", () => {
    const out = slot("Lee's Barbershop, Riley, Sat Oct 24, 11:00am, $35");
    expect(out).toBe("{{biz.name}}, {{pro.name}}, {{day}}, {{visit.time}}, {{price}}");
    for (const ref of slotRefs(out)) expect(ref.example).toBeUndefined();
  });

  it("is idempotent", () => {
    const text =
      "Lee's Barbershop: Riley, Sat Oct 24 · 11:00am, $35, a $75 call, (555) 010-0177, by 9:00am Sat";
    const once = slot(text);
    expect(slot(once)).toBe(once);
  });

  it("slots every string of a message's elements, but not its links, flags or lanes", () => {
    const message = slotMessage(
      [
        "san",
        "cust",
        "You're booked at Lee's Barbershop!",
        {
          card: {
            title: "Lee's Barbershop",
            lines: ["Sat Oct 24 · 11:00am · Riley"],
            link: "https://rosfield.com/v/s03",
          },
          code: "5160",
          buttons: ["Change the time", ["2", "Cancel Sat Oct 24"]],
          stop: "first",
          lang: "es",
        },
      ] as const,
      masterTable("A"),
    );
    expect(message[0]).toBe("san");
    expect(message[2]).toBe("You're booked at {{biz.name}}!");
    expect(message[3]).toEqual({
      card: {
        title: "{{biz.name}}",
        lines: ["{{day}} · {{visit.time}} · {{pro.name}}"],
        link: "https://rosfield.com/v/s03",
      },
      code: "{{visit.code}}",
      buttons: ["Change the time", ["2", "Cancel {{day}}"]],
      stop: "first",
      lang: "es",
    });
  });

  it("slots a check-in code written in a line when the flow's elements carry it", () => {
    const table = masterTable("A");
    table.codes.add("5160");
    expect(slotText("Your code is 5160. Reply 5161 to move it. Total $5160", table)).toBe(
      "Your code is {{visit.code}}. Reply 5161 to move it. Total {{change.price}}",
    );
  });
});

interface Case {
  id: string;
  trade: LoadedTrade;
}

const TRADES = ["aba", "hvac", "cpa", "yoga"];
const cases: Case[] = TRADES.map((id) => ({ id, trade: loadTrade(id) }));

function applyBoth(trade: LoadedTrade): Record<FlowLetter, AppliedTrade> {
  return { A: applyTrade(master.A, trade), B: applyTrade(master.B, trade) };
}

describe.each(cases)("trade $id", ({ trade }) => {
  const applied = applyBoth(trade);

  it.each(["A", "B"] as const)("flow %s: no sample value is left outside a slot", (flow) => {
    const table = sampleTable(master, flow, trade, applied[flow].flow);
    const slotted = slotApplied(applied[flow], table);
    const lines = [...flowLines(slotted.applied.flow), ...recordLines(slotted.applied.flow)];
    expect(lines.length).toBeGreaterThan(1000);
    const left = lines.flatMap((line) =>
      leftovers(line.text, table).map((l) => `${line.at}: ${l.kind} ${l.match}`),
    );
    expect(left).toEqual([]);
  });

  it.each(["A", "B"] as const)(
    "flow %s: every slot written is in K-03 v1, and the sample slots are written",
    (flow) => {
      const table = sampleTable(master, flow, trade, applied[flow].flow);
      const slotted = slotApplied(applied[flow], table);
      const lines = [...flowLines(slotted.applied.flow), ...recordLines(slotted.applied.flow)];
      expect(() => {
        checkLines(lines);
      }).not.toThrow();
      const written = slotCounts(lines);
      for (const name of written.keys()) expect(slotNames(), name).toContain(name);
      for (const name of ["biz.name", "pro.name", "alex.staff", "day", "visit.time", "ask.by", "owner.name"])
        expect(written.get(name) ?? 0, name).toBeGreaterThan(10);
      // What the master wrote stays: record slots and amount slots are counted before and after.
      const before = slotCounts([...flowLines(applied[flow].flow), ...recordLines(applied[flow].flow)]);
      for (const name of SLOT_NAMES) expect(written.get(name) ?? 0, name).toBe(before.get(name) ?? 0);
      for (const name of ["due", "paidnow", "keep"])
        expect(written.get(name) ?? 0, name).toBe(before.get(name) ?? 0);
    },
  );

  it.each(["A", "B"] as const)("flow %s: Rosie's fee terms stay literal, line for line", (flow) => {
    const table = sampleTable(master, flow, trade, applied[flow].flow);
    const slotted = slotApplied(applied[flow], table);
    const before = [...flowLines(applied[flow].flow), ...recordLines(applied[flow].flow)];
    const after = [...flowLines(slotted.applied.flow), ...recordLines(slotted.applied.flow)];
    expect(after).toHaveLength(before.length);
    let total = 0;
    before.forEach((line, k) => {
      const was = countFeeTerms(line.text);
      expect(countFeeTerms(after[k]?.text ?? ""), line.at).toEqual(was);
      total += Object.values(was).reduce((a, b) => a + b, 0);
    });
    expect(total).toBeGreaterThan(10);
  });

  it.each(["A", "B"] as const)(
    "flow %s: S1-25, S1-29 and the A9-21 rows state $2, $49 and 1% literally",
    (flow) => {
      const table = sampleTable(master, flow, trade, applied[flow].flow);
      const slotted = slotApplied(applied[flow], table);
      const states = (lines: { at: string; text: string }[], term: string): number =>
        lines.reduce((n, line) => n + (countFeeTerms(line.text)[term] ?? 0), 0);
      const all = flowLines(slotted.applied.flow);
      const s125 = all.filter((line) => line.at.startsWith("S1-25 "));
      expect(states(s125, "$2"), "S1-25 $2").toBeGreaterThanOrEqual(3);
      expect(states(s125, "$49"), "S1-25 $49").toBeGreaterThanOrEqual(1);
      expect(states(s125, "1%"), "S1-25 1%").toBeGreaterThanOrEqual(1);
      const s129 = all.filter((line) => line.at.startsWith("S1-29 "));
      expect(states(s129, "$2"), "S1-29 $2").toBeGreaterThanOrEqual(1);
      // A9-21 is the home of the record's two.count slot: its rows hold the $2 and the 1%.
      const two = recordLines(slotted.applied.flow).filter((line) => line.at.startsWith("record two.count "));
      expect(two.length).toBeGreaterThan(0);
      expect(states(two, "$2"), "two.count $2").toBeGreaterThanOrEqual(2);
      expect(states(two, "1%"), "two.count 1%").toBeGreaterThanOrEqual(2);
      for (const line of two) expect(line.text).not.toMatch(/\{\{(?:price|fee|change\.price)\}\}/);
    },
  );
});

describe("a path of a trade", () => {
  it("shows only lines the flow's scan has read, with no sample value outside a slot", () => {
    const trade = loadTrade("aba");
    const applied = applyTrade(master.A, trade);
    const table = sampleTable(master, "A", trade, applied.flow);
    const slotted = slotApplied(applied, table);
    const all = new Set(flowLines(slotted.applied.flow).map((line) => `${line.at}\u0000${line.text}`));
    const paths = tradePaths(applied, trade);
    expect(paths.length).toBeGreaterThan(20);
    for (const path of paths.filter((_, k) => k % 6 === 0)) {
      const lines = pathLines(slotted.applied.flow, walkPath(applied, path));
      expect(lines.length).toBeGreaterThan(100);
      for (const line of lines) {
        expect(all.has(`${line.at}\u0000${line.text}`), line.at).toBe(true);
        expect(leftovers(line.text, table), `${line.at}: ${line.text}`).toEqual([]);
      }
    }
  });
});

describe("what slotting leaves alone", () => {
  it("does not change the applied trade it is given", () => {
    const trade = loadTrade("cpa");
    const applied = applyTrade(master.A, trade);
    const copy = structuredClone(applied);
    const table = sampleTable(master, "A", trade, applied.flow);
    const slotted = slotApplied(applied, table);
    expect(applied).toStrictEqual(copy);
    expect(slotted.applied.flow).not.toBe(applied.flow);
    expect(slotted.applied.trade).toBe("cpa");
  });

  it("keeps the shape: the same steps, in the same order, with the same ids", () => {
    const trade = loadTrade("hvac");
    const applied = applyTrade(master.B, trade);
    const table = sampleTable(master, "B", trade, applied.flow);
    const slotted = slotApplied(applied, table);
    const ids = (steps: AppliedStep[]): string[] => {
      const out: string[] = [];
      eachStep(steps, (step) => out.push(step.id));
      return out;
    };
    expect(ids(slotted.applied.flow.steps)).toEqual(ids(applied.flow.steps));
    expect(Object.keys(slotted.applied.flow.record.slots)).toEqual(Object.keys(applied.flow.record.slots));
  });
});
