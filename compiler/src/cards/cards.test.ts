// T-144: step cards and fallback text. Proofs of the card:
//   - the 210 distinct decisions in flows A and B each get a card;
//   - the 13 that state a Clock line keep it word for word, and the other 197 carry step 9's default;
//   - the 48 decisions that state no Means line give each of their choices the first sentence of the step it leads to, marked
//     firstSentence (the stand-in), and no choice of any decision is left with no definition;
//   - S1-02's card matches the Means, Never and Safe default lines the master's step printer prints for it.
//
// How the numbers are counted: from the master's own files, master-A.json and master-B.json, read here as plain JSON with a
// walk of this file's own, never through the code under test. A decision is a step with `type: "split"`; the same id in both
// flows (the shared S-steps) counts once. A Clock line is a `more` line that starts with `Clock`; a Means line one that starts
// with `Means`. Counted 210 decisions, 13 with a Clock line, 48 without any Means line (matching the plan's notes, specs.md
// sections 1 and 6). The 48 are decisions, not single choices: the 173 branches of those 48 decisions are the choices that
// take a stand-in, and some decisions that do state Means lines name only some of their branches, so more than 173 choices
// carry a stand-in in all (counted in the test below).
//
// The reference for S1-02 is the master's step printer, run on the read-only copy by the lead (`node step.js A S1-02`); its
// lines are written below as the printer gave them.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { listTradeIds, loadTrade } from "../load/trade";
import { applyTrade } from "../overlay/apply";
import { tradePaths, walkPath } from "../path";
import { compileRecord } from "../record";
import {
  CardError,
  LineError,
  cardOf,
  clockLineOf,
  compileCards,
  compileFallbackTexts,
  compileMasterCards,
  compileTradeCards,
  decisionsOf,
  fallbackTextOf,
  fillRecordSlots,
  firstSentence,
  meansOf,
  neverLines,
  safeDefaultOf,
  type CardStep,
  type StepCard,
} from "./index";

vi.setConfig({ testTimeout: 120_000 });

const WORK = fileURLToPath(new URL("../../../fixtures/master/engine/work/", import.meta.url));

interface RawBranch {
  label: string;
  steps: RawStep[];
  end?: string;
  endText?: string;
}
interface RawStep {
  id: string;
  type?: string;
  q?: string;
  does: string;
  more?: string[];
  say?: unknown[][];
  branches?: RawBranch[];
}

function raw(flow: FlowLetter): { steps: RawStep[] } {
  return JSON.parse(readFileSync(`${WORK}master/master-${flow}.json`, "utf8")) as { steps: RawStep[] };
}

/** Every step of a raw flow, branch steps included (this file's own walk). */
function* rawSteps(steps: RawStep[]): Generator<RawStep> {
  for (const step of steps) {
    yield step;
    for (const branch of step.branches ?? []) yield* rawSteps(branch.steps);
  }
}

/** The distinct decisions of both raw flows by id (the shared S-steps once). */
function rawDecisions(): Map<string, { flow: FlowLetter; step: RawStep }[]> {
  const out = new Map<string, { flow: FlowLetter; step: RawStep }[]>();
  for (const flow of ["A", "B"] as const) {
    for (const step of rawSteps(raw(flow).steps)) {
      if (step.type !== "split") continue;
      const list = out.get(step.id) ?? [];
      list.push({ flow, step });
      out.set(step.id, list);
    }
  }
  return out;
}

const master = loadMaster();
const cards = compileMasterCards(master);
const decisions = rawDecisions();

/** The card of a decision id in the first flow that has it. */
function cardById(id: string): StepCard {
  const card = cards.A[id] ?? cards.B[id];
  if (card === undefined) throw new Error(`no card for ${id}`);
  return card;
}

describe("the cards of the 210 decisions", () => {
  it("counts 210 distinct decisions in the master, and each gets a card in the flow it is in", () => {
    expect(decisions.size).toBe(210);
    for (const [id, where] of decisions) {
      for (const { flow } of where) expect(cards[flow][id], `${id} in flow ${flow}`).toBeDefined();
    }
    const ids = new Set([...Object.keys(cards.A), ...Object.keys(cards.B)]);
    expect(ids.size).toBe(210);
    // Nothing else gets a card: every card is a decision of its flow.
    for (const flow of ["A", "B"] as const) {
      for (const id of Object.keys(cards[flow]))
        expect(
          decisions.get(id)?.some((entry) => entry.flow === flow),
          `${id} is a decision of flow ${flow}`,
        ).toBe(true);
    }
  });

  it("gives each card the question, a definition per branch in the branch order, and the branch labels word for word", () => {
    for (const [id, where] of decisions) {
      for (const { flow, step } of where) {
        const card = cards[flow][id];
        expect(card?.question).toBe(step.q);
        expect(card?.means.map((entry) => entry.branch)).toEqual((step.branches ?? []).map((b) => b.label));
      }
    }
  });

  it("keeps the 13 Clock lines word for word and gives the other 197 step 9's default", () => {
    let withLine = 0;
    for (const [id, where] of decisions) {
      const lines = (where[0]?.step.more ?? []).filter((line) => line.startsWith("Clock"));
      expect(lines.length, `${id} has at most one Clock line`).toBeLessThanOrEqual(1);
      const card = cardById(id);
      if (lines.length === 1) {
        withLine += 1;
        expect(card.clock).toEqual({ from: "clockLine", text: lines[0] });
      } else {
        expect(card.clock).toEqual({ from: "step9Default" });
      }
    }
    expect(withLine).toBe(13);
    const fromLine = [...decisions.keys()].filter((id) => cardById(id).clock.from === "clockLine");
    expect(fromLine).toHaveLength(13);
    expect(decisions.size - fromLine.length).toBe(197);
  });

  it("gives every choice of the 48 decisions with no Means line the first sentence of the step it leads to, as a stand-in", () => {
    const without = [...decisions.entries()].filter(
      ([, where]) => !(where[0]?.step.more ?? []).some((line) => line.startsWith("Means")),
    );
    expect(without).toHaveLength(48);
    let choices = 0;
    for (const [id, where] of without) {
      for (const { flow, step } of where) {
        const card = cards[flow][id];
        step.branches?.forEach((branch, k) => {
          choices += 1;
          const entry = card?.means[k];
          expect(entry?.from, `${id} ${branch.label}`).toBe("firstSentence");
          expect(entry?.text, `${id} ${branch.label}`).toMatch(/\S/);
          const first = branch.steps[0];
          // A branch with steps of its own leads to its first step: the stand-in opens that step's `does`.
          if (first !== undefined) expect(first.does.startsWith(entry?.text ?? "\u0000")).toBe(true);
        });
      }
    }
    // The 48 decisions have 173 choices (counted once per decision, as flows A and B give them the same branches).
    const distinct = new Set<string>();
    for (const [id, where] of without)
      for (const branch of where[0]?.step.branches ?? []) distinct.add(`${id}\u0000${branch.label}`);
    expect(distinct.size).toBe(173);
    expect(choices).toBeGreaterThanOrEqual(173);
  });

  it("leaves no choice of any decision without a definition, and marks each stand-in", () => {
    let meansLines = 0;
    let standIns = 0;
    for (const flow of ["A", "B"] as const) {
      for (const [id, card] of Object.entries(cards[flow])) {
        for (const entry of card.means) {
          expect(entry.from, `${flow} ${id} ${entry.branch}`).not.toBe("none");
          expect(entry.text, `${flow} ${id} ${entry.branch}`).toMatch(/\S/);
          if (entry.from === "meansLine") meansLines += 1;
          else standIns += 1;
        }
      }
    }
    expect(meansLines).toBeGreaterThan(0);
    expect(standIns).toBeGreaterThan(0);
  });

  it("takes a Means line only from a line of the step that holds its words", () => {
    for (const flow of ["A", "B"] as const) {
      const byId = new Map<string, RawStep>();
      for (const step of rawSteps(raw(flow).steps)) if (step.type === "split") byId.set(step.id, step);
      for (const [id, card] of Object.entries(cards[flow])) {
        const lines = byId.get(id)?.more ?? [];
        for (const entry of card.means) {
          if (entry.from !== "meansLine") continue;
          expect(
            lines.some((line) => line.startsWith("Means") && line.includes(entry.text ?? "\u0000")),
            `${flow} ${id} ${entry.branch}`,
          ).toBe(true);
        }
      }
    }
  });

  it("carries the Never lines word for word, and the safe default of the 191 decisions that state one", () => {
    let withDefault = 0;
    for (const [id, where] of decisions) {
      const more = where[0]?.step.more ?? [];
      const card = cardById(id);
      expect(card.never).toEqual(more.filter((line) => /^Never\b/.test(line)));
      const line = more.find((candidate) => candidate.startsWith("Safe default"));
      if (line === undefined) {
        expect(card.safeDefault).toBeUndefined();
      } else {
        withDefault += 1;
        expect(line.endsWith(card.safeDefault ?? "\u0000")).toBe(true);
      }
      // A card never has neither a safe default nor a clock: the clock is always its own line or step 9's default.
      expect(["clockLine", "step9Default"]).toContain(card.clock.from);
    }
    expect(withDefault).toBe(191);
  });

  it("gives the two flows' copies of a shared step the same card but for a stand-in", () => {
    let shared = 0;
    for (const id of master.sharedIds) {
      const a = cards.A[id];
      const b = cards.B[id];
      if (a === undefined || b === undefined) {
        expect(a === undefined && b === undefined, `${id} is a decision in both flows or in neither`).toBe(
          true,
        );
        continue;
      }
      shared += 1;
      expect(b.question).toBe(a.question);
      expect(b.never).toEqual(a.never);
      expect(b.safeDefault).toBe(a.safeDefault);
      expect(b.clock).toEqual(a.clock);
      expect(b.means.map((entry) => [entry.branch, entry.from === "meansLine" ? entry.text : null])).toEqual(
        a.means.map((entry) => [entry.branch, entry.from === "meansLine" ? entry.text : null]),
      );
    }
    expect(shared).toBeGreaterThan(0);
  });
});

describe("S1-02, as the master's step printer prints it", () => {
  // `node step.js A S1-02`, word for word (the lead ran it on the read-only copy).
  const printed = {
    title: "### S1-02 · Asks what work Sam does, and checks each one  ◆ Is each one on Rosie's list?",
    means: [
      "Means 'One isn't on the list yet': a service with a visit that Rosie has no plug-in for.",
      "Means 'Not a service we book': goods with no visit, delivery only, renting a thing alone, or work the law bars.",
    ],
    never: ["Never: set up any of those."],
    safeDefault: "Safe default: draft it as new work, offline until Rosie's team reviews it.",
    branches: [
      { label: "All on the list", firstStep: undefined },
      { label: "One isn't on the list yet", firstStep: "S1-03" },
      { label: "Not a service we book", firstStep: "S1-74" },
    ],
  };

  it("has the printed question", () => {
    expect(printed.title.endsWith(`◆ ${cards.A["S1-02"]?.question ?? ""}`)).toBe(true);
  });

  it("has the printed Means lines for the two branches that have one, and a stand-in for the third", () => {
    const card = cards.A["S1-02"];
    expect(card?.means.map((entry) => entry.branch)).toEqual(printed.branches.map((b) => b.label));
    const given = card?.means.filter((entry) => entry.from === "meansLine") ?? [];
    expect(given.map((entry) => `Means '${entry.branch}': ${entry.text ?? ""}`)).toEqual(printed.means);
    const standIn = card?.means[0];
    expect(standIn?.branch).toBe("All on the list");
    expect(standIn?.from).toBe("firstSentence");
    // The printer shows "rejoins, first step undefined" for it; the choice leads to the step after the rejoin, S1-11.
    const next = master.A.path[master.A.path.findIndex((step) => step.id === "S1-02") + 1];
    expect(next?.does.startsWith(standIn?.text ?? "\u0000")).toBe(true);
  });

  it("has the printed Never and Safe default lines, and step 9's default clock", () => {
    const card = cards.A["S1-02"];
    expect(card?.never).toEqual(printed.never);
    expect(`Safe default: ${card?.safeDefault ?? ""}`).toBe(printed.safeDefault);
    expect(card?.clock).toEqual({ from: "step9Default" });
  });

  it("leads its two other branches to the printed first steps, and has the same card in flow B", () => {
    const step = master.A.steps["S1-02"];
    for (const branch of printed.branches) {
      const found = step?.branches?.find((candidate) => candidate.label === branch.label);
      expect(found?.steps[0]?.id).toBe(branch.firstStep);
    }
    expect(cards.B["S1-02"]).toEqual(cards.A["S1-02"]);
    const decision = decisionsOf(master.A.path).find((entry) => entry.step.id === "S1-02");
    const leads = decision?.branches.map((entry) =>
      entry.leads !== null && "step" in entry.leads ? entry.leads.step.id : null,
    );
    expect(leads?.slice(1)).toEqual(["S1-03", "S1-74"]);
  });
});

describe("reading the lines", () => {
  it("takes the first sentence, past an abbreviation, a name's initial and an open quotation", () => {
    expect(firstSentence("A plug-in holds what one kind of work needs. More follows.")).toBe(
      "A plug-in holds what one kind of work needs.",
    );
    expect(firstSentence("Say Owen H. has a haircut plan with Riley, every 4 weeks. Then more.")).toBe(
      "Say Owen H. has a haircut plan with Riley, every 4 weeks.",
    );
    expect(
      firstSentence("A low rating: the page asks 'Sorry to hear that. What went wrong?' Then it waits."),
    ).toBe("A low rating: the page asks 'Sorry to hear that. What went wrong?'");
    expect(firstSentence("Back to Alex's Saturday, Sat Oct 24: at 8am, Riley gets the day's bookings.")).toBe(
      "Back to Alex's Saturday, Sat Oct 24: at 8am, Riley gets the day's bookings.",
    );
    expect(firstSentence("Is it done? Yes.")).toBe("Is it done?");
    expect(firstSentence("No full stop here")).toBe("No full stop here");
    expect(firstSentence("  ")).toBe("");
  });

  it("matches Means lines to branch labels: exact, shortened, two on one line, several in one line, numbered", () => {
    const labels = [
      "A new booking",
      "Asks for a person",
      "A child",
      "Passed: it goes ahead",
      "In Spanish",
      "Another language",
      "1 Keep it",
      "2 Cancel it",
      "Never: no fee may be asked",
    ];
    const more = [
      "Means 'A new booking': it asks to book.",
      "Means 'Asks for a person': they want a human. Means 'A child': a young child is writing alone.",
      "Means 'Passed': it goes ahead as booked.",
      "Means 'In Spanish' or 'Another language': the language they speak.",
      "Means 1: keep it. Means 2: cancel it. Several open: Rosie asks which.",
      "Means 'Never: no fee may be asked' (checks on only): a fee-free customer.",
      "Means each case by what happened, in any words.",
    ];
    expect(Object.fromEntries(meansOf(more, labels).map((entry) => [entry.label, entry.text]))).toEqual({
      "A new booking": "it asks to book.",
      "Asks for a person": "they want a human.",
      "A child": "a young child is writing alone.",
      "Passed: it goes ahead": "it goes ahead as booked.",
      "In Spanish": "the language they speak.",
      "Another language": "the language they speak.",
      "1 Keep it": "keep it.",
      "2 Cancel it": "cancel it. Several open: Rosie asks which.",
      "Never: no fee may be asked": "a fee-free customer.",
    });
  });

  it("leaves a shortened label that fits two branches unmatched, and takes the first line for a label named twice", () => {
    expect(
      meansOf(["Means 'Signs': booked like any booking."], ["Signs: booked here", "Signs: at their place"]),
    ).toEqual([]);
    expect(meansOf(["Means 'Yes': one.", "Means 'Yes': two."], ["Yes"])).toEqual([
      { label: "Yes", text: "one." },
    ]);
  });

  it("reads Never lines, the safe default and the Clock line, and refuses two of the last two", () => {
    const more = [
      "Never: set up any of those.",
      "Never book, price or promise a service the business didn't list.",
      "Neverending list.",
      "Safe default: draft it as new work.",
      "Clock: Sam answers in 30 minutes.",
    ];
    expect(neverLines(more)).toEqual([
      "Never: set up any of those.",
      "Never book, price or promise a service the business didn't list.",
    ]);
    expect(safeDefaultOf(more, "X1-01")).toBe("draft it as new work.");
    expect(
      safeDefaultOf(["Safe default, and when the plug-in is silent: an adult must be there."], "X1-01"),
    ).toBe("an adult must be there.");
    expect(safeDefaultOf(["Plain line."], "X1-01")).toBeNull();
    expect(clockLineOf(more, "X1-01")).toBe("Clock: Sam answers in 30 minutes.");
    expect(clockLineOf(["Plain line."], "X1-01")).toBeNull();
    expect(() => safeDefaultOf(["Safe default: a.", "Safe default: b."], "X1-01")).toThrow(LineError);
    expect(() => clockLineOf(["Clock: a.", "Clock: b."], "X1-01")).toThrow(LineError);
  });
});

describe("where a choice leads", () => {
  const step = (id: string, extra: Partial<CardStep> = {}): CardStep => ({
    id,
    does: `${id} does it. More.`,
    ...extra,
  });

  it("leads a rejoining empty branch to the next step of its list, or, at a branch's end, to the step after the enclosing split", () => {
    const inner = step("X1-03", {
      type: "split",
      q: "Inner?",
      branches: [
        { label: "Stays", steps: [], end: "merge" },
        { label: "Goes", steps: [step("X1-04")], end: "merge" },
      ],
    });
    const outer = step("X1-02", {
      type: "split",
      q: "Outer?",
      branches: [
        { label: "Down", steps: [inner], end: "merge" },
        { label: "Past", steps: [], end: "merge" },
      ],
    });
    const found = decisionsOf([step("X1-01"), outer, step("X1-05")]);
    const leads = (id: string): (string | null)[] =>
      (found.find((entry) => entry.step.id === id)?.branches ?? []).map((entry) =>
        entry.leads !== null && "step" in entry.leads ? entry.leads.step.id : null,
      );
    expect(leads("X1-02")).toEqual(["X1-03", "X1-05"]);
    expect(leads("X1-03")).toEqual(["X1-05", "X1-04"]);
  });

  it("gives an ending branch with no steps its ending words, and a branch that leads nowhere no definition", () => {
    const split = step("X1-01", {
      type: "split",
      q: "Ends?",
      more: ["Means 'No': nothing."],
      branches: [
        { label: "Yes", steps: [], end: "end", endText: "Ended here. Nothing is set up." },
        { label: "No", steps: [], end: "end", endText: "Unused." },
        { label: "Maybe", steps: [], end: "end" },
      ],
    });
    const card = compileCards([split])["X1-01"];
    expect(card?.means).toEqual([
      { branch: "Yes", text: "Ended here.", from: "firstSentence" },
      { branch: "No", text: "nothing.", from: "meansLine" },
      { branch: "Maybe", from: "none" },
    ]);
    expect(card?.clock).toEqual({ from: "step9Default" });
  });

  it("refuses a decision with no question, and two decisions with one id", () => {
    expect(() => compileCards([step("X1-01", { type: "split", branches: [] })])).toThrow(CardError);
    const twice = step("X1-01", { type: "split", q: "Q?", branches: [] });
    expect(() => compileCards([twice, twice])).toThrow(CardError);
  });
});

describe("fallback text", () => {
  const first = (flow: FlowLetter): Record<string, string> => compileFallbackTexts(master[flow].path);

  it("is the master line: the first text a step has from Rosie, word for word", () => {
    const texts = first("A");
    expect(texts["S1-02"]).toBe(
      "Hi! I'm Rosie, an automated assistant. I'll set up your business so AI assistants like ChatGPT, Claude and Gemini can book you. What kinds of work do you do? Just type them.",
    );
    // A branch step has its own.
    expect(texts["S1-74"]).toMatch(/^Thanks for telling me\./);
    // The master's own line for S1-03 is the one a branch step (inside S1-02) says.
    expect(texts["S1-03"]).toMatch(/^I don't have that kind of work yet/);
  });

  it("is left out where Rosie says nothing, and is never empty", () => {
    for (const flow of ["A", "B"] as const) {
      const texts = first(flow);
      for (const step of Object.values(master[flow].steps)) {
        const sanTexts = (step.say ?? []).filter(
          (message) => message[0] === "san" && message[2].trim() !== "",
        );
        if (sanTexts.length === 0) expect(texts[step.id], step.id).toBeUndefined();
        else expect(texts[step.id], step.id).toBe(sanTexts[0]?.[2]);
      }
    }
    expect(fallbackTextOf({ id: "X1-01", does: "x", say: [["cust", "san", "Yes"]] })).toBeNull();
  });

  it("keeps its slots as written for the slot filler", () => {
    const texts = first("A");
    const withSlot = Object.values(texts).filter((text) => /\{\{[a-z.]+/.test(text));
    expect(withSlot.length).toBeGreaterThan(0);
  });

  it("fills a record slot with the row of the compiled record that fits the path, and nothing else", () => {
    const view = compileRecord(master.A);
    const texts = first("A");
    const id = Object.entries(texts).find(([, text]) => /\{\{pay\.[a-z]+/.test(text))?.[0];
    expect(id).toBeDefined();
    const line = texts[id ?? ""] ?? "";
    const filled = fillRecordSlots(line, view, null, {});
    expect(filled).not.toMatch(/\{\{pay\./);
    const slotNames = [...line.matchAll(/\{\{\s*(pay\.[a-z]+)/g)].map((match) => match[1] ?? "");
    const rows = slotNames.flatMap((name) =>
      view.record.slots[name as "pay.took"].rows.map((row) => row.text),
    );
    expect(rows.some((row) => filled.includes(row))).toBe(true);
    // Slots that are not the record's stay as written.
    expect(fillRecordSlots("Pay {{price:$35}} to {{alex.staff}}.", view, null, {})).toBe(
      "Pay {{price:$35}} to {{alex.staff}}.",
    );
  });
});

/** Does `actual` equal `written`, where each slot of a written string (`{{pay.back}}`) may stand for any text? */
function fitsWritten(written: unknown, actual: unknown): boolean {
  if (typeof written === "string") {
    if (typeof actual !== "string") return false;
    const parts = written.split(/\{\{[^}]*\}\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`^${parts.join("[\\s\\S]*")}$`).test(actual);
  }
  if (Array.isArray(written)) {
    return (
      Array.isArray(actual) &&
      actual.length === written.length &&
      written.every((item, k) => fitsWritten(item, actual[k]))
    );
  }
  if (typeof written === "object" && written !== null) {
    if (typeof actual !== "object" || actual === null) return false;
    const keys = Object.keys(written);
    return (
      keys.length === Object.keys(actual).length &&
      keys.every((key) =>
        fitsWritten((written as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key]),
      )
    );
  }
  return written === actual;
}

describe("a trade's cards", () => {
  it("leaves out a branch the trade switched off, adds a branch the trade added, and keeps the other cards", () => {
    const aba = loadTrade("aba");
    const abaA = applyTrade(master.A, aba);
    const off = compileTradeCards(abaA)["S1-80"];
    const base = cards.A["S1-80"];
    expect(base?.means.map((entry) => entry.branch)).toContain("Yes: spaces or things");
    expect(off?.means.map((entry) => entry.branch)).not.toContain("Yes: spaces or things");

    const addiction = loadTrade("addiction");
    const added = compileTradeCards(applyTrade(master.A, addiction))["A3-22"];
    const labels = added?.means.map((entry) => entry.branch) ?? [];
    expect(labels).toContain("Crisis words, then still books");
    const own = added?.means.find((entry) => entry.branch === "Crisis words, then still books");
    expect(own?.from).toBe("firstSentence");
    expect(own?.text).toMatch(/\S/);
    expect(labels.length).toBe((cards.A["A3-22"]?.means.length ?? 0) + 1);
  });

  // The card of a decision does not depend on the path: the words a path shows for it (resolveVary) hold the same Means,
  // Never, Safe default and Clock lines as the step as written, on every path of two trades in both flows. The one thing a
  // path changes is a slot in those lines: the master's own Safe default of A6-11 ends in `{{pay.back}}`, which a path's
  // words fill with the record's row for that path. The card keeps the slot, for the slot filler.
  it.each(["aba", "cpa"])(
    "is the same on every path of %s: the path's words change none of its card lines",
    (id) => {
      const trade = loadTrade(id);
      let checked = 0;
      for (const flow of ["A", "B"] as const) {
        const applied = applyTrade(master[flow], trade);
        const asWritten = compileTradeCards(applied);
        const found = new Map(decisionsOf(applied.flow.steps).map((entry) => [entry.step.id, entry]));
        for (const path of tradePaths(applied, trade)) {
          for (const lit of walkPath(applied, path).steps) {
            const decision = found.get(lit.id);
            if (decision === undefined) continue;
            const onPath = cardOf({ step: lit.words, branches: decision.branches });
            expect(
              fitsWritten(asWritten[lit.id], onPath),
              `${id} ${flow} ${lit.id}: ${JSON.stringify(onPath)} against ${JSON.stringify(asWritten[lit.id])}`,
            ).toBe(true);
            checked += 1;
          }
        }
      }
      expect(checked).toBeGreaterThan(100);
    },
  );

  // Applying a trade takes about 0.8 s, so the 243 trades in both flows (6 minutes) are not run on every test run: every
  // 20th trade, in file order, is. (The whole set was run once for this card: no refusal, no card without a question.)
  it("compiles for every 20th of the 243 trades in both flows without a refusal, each with a question per card", () => {
    const all = listTradeIds();
    expect(all).toHaveLength(243);
    const ids = all.filter((_, k) => k % 20 === 0);
    expect(ids).toHaveLength(13);
    for (const id of ids) {
      const trade = loadTrade(id);
      for (const flow of ["A", "B"] as const) {
        const result = compileTradeCards(applyTrade(master[flow], trade));
        expect(Object.keys(result).length, `${id} ${flow}`).toBeGreaterThan(100);
        for (const card of Object.values(result)) expect(card.question).toMatch(/\S/);
      }
    }
  });
});
