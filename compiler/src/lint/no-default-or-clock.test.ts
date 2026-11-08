// T-155: the lint rule no-safe-default-or-clock, a question without a safe default or a clock (arch 12 line 592; K-01
// v1; NQ-PB-3's default), tested alone: runLint([rule], ...). The cards are the master's own (T-144's compiler on
// master-A.json and master-B.json), a trade's (aba, as its own words lay them) and the K-01 fixtures' (the architect's
// copies of the master's steps), never invented (rule 9).
//
// The counts come from the raw flow files, walked by this file, never through the code under test: a decision is a step
// with `type: "split"` (T-144's reading; over both flows the shared S-steps count once), a Clock line is a `more` line that
// starts with the word Clock, a safe default line one that starts with Safe default. What fails is checked against K-01's
// own check (emit/validate.ts lintMarksOf, the schema's step check): the rule's error falls on exactly the cards the
// schema marks with the rule.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileMasterCards, type StepCard } from "../cards";
import { checkBundlePart, lintMarksOf } from "../emit/validate";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { loadTrade } from "../load/trade";
import { applyTrade, type AppliedStep } from "../overlay/apply";
import {
  NO_DEFAULT_OR_CLOCK_RULE,
  cardHits,
  compiledCardsOf,
  noDefaultOrClock,
  noDefaultOrClockRule,
  type ClockCard,
  type ClockCards,
} from "./no-default-or-clock";
import { masterInput, runLint, tradeInput, type LintHit, type LintInput, type LintResult } from "./runner";

const WORK = fileURLToPath(new URL("../../../fixtures/master/engine/work/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../../../contracts/bundle/fixtures/", import.meta.url));
const FLOWS = ["A", "B"] as const;
const RULE = "no-safe-default-or-clock";

const ERROR_FIX =
  "give its card a safe default (a 'Safe default: ...' line) or a clock (its own 'Clock: ...' line, or step 9's default): with neither, nothing says what happens when nobody answers, or when";
const DEFAULT_FIX =
  "relies on step 9's default (no Clock line of its own; arch 02 line 127): it passes, listed (NQ-PB-3)";
const DEFAULT_ONLY_FIX =
  "relies on step 9's default alone (no Clock line of its own, and no safe default on its card; arch 02 line 127): it passes, listed (NQ-PB-3)";

interface RawBranch {
  label: string;
  steps: RawStep[];
}
interface RawStep {
  id: string;
  type?: string;
  q?: string;
  more?: string[];
  branches?: RawBranch[];
}

/** A decision as this file reads it from a raw flow file. */
interface RawDecision {
  id: string;
  q: string;
  clockLine: boolean;
  safeDefault: boolean;
}

const CLOCK_LINE = /^Clock\b/;
const SAFE_DEFAULT_LINE = /^Safe default\b/;

/** Every step under `steps`, in page order: a step, then its branches' steps (this file's own walk). */
function* rawSteps(steps: readonly RawStep[]): Generator<RawStep> {
  for (const step of steps) {
    yield step;
    for (const branch of step.branches ?? []) yield* rawSteps(branch.steps);
  }
}

function decisionOf(step: { id: string; q?: string; more?: readonly string[] }): RawDecision {
  const more = step.more ?? [];
  return {
    id: step.id,
    q: step.q ?? "",
    clockLine: more.some((line) => CLOCK_LINE.test(line)),
    safeDefault: more.some((line) => SAFE_DEFAULT_LINE.test(line)),
  };
}

/** The decisions of one raw master flow file, in page order. */
function rawDecisions(flow: FlowLetter): RawDecision[] {
  const file = JSON.parse(readFileSync(`${WORK}master/master-${flow}.json`, "utf8")) as { steps: RawStep[] };
  return [...rawSteps(file.steps)].filter((step) => step.type === "split").map(decisionOf);
}

/** The warning (step 9's default) one decision without its own Clock line gets. */
function listed(decision: RawDecision): { step: string; level: string; text: string; fix: string } {
  return {
    step: decision.id,
    level: "warning",
    text: decision.q,
    fix: decision.safeDefault ? DEFAULT_FIX : DEFAULT_ONLY_FIX,
  };
}

function shape(hit: LintHit): { step: string; level: string; text: string; fix: string } {
  return { step: hit.step, level: hit.level, text: hit.text, fix: hit.fix };
}

const master = loadMaster();
const inputs = new Map<FlowLetter, LintInput>();
/** The lint's input for a master flow, made once. */
function input(flow: FlowLetter): LintInput {
  const made = inputs.get(flow) ?? masterInput(master[flow]);
  inputs.set(flow, made);
  return made;
}

/** The rule alone on a master flow, on the flow's own cards. */
function masterRun(flow: FlowLetter): LintResult {
  return runLint([noDefaultOrClock], input(flow));
}

/** T-144's cards of both master flows. */
const cards = compileMasterCards(master);
function cardOf(flow: FlowLetter, id: string): StepCard {
  const card = cards[flow][id];
  if (card === undefined) throw new Error(`no card for ${id} in flow ${flow}`);
  return card;
}

/** A compiled step as K-01 writes it: the fields this file reads. */
interface BundleStep {
  id: string;
  more?: string[];
  card?: ClockCard;
  lint: string[];
  [field: string]: unknown;
}
interface BundleFile {
  flows: Partial<Record<FlowLetter, { steps: Record<string, BundleStep> }>>;
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES}${name}`, "utf8"));
}

/** The cards of a K-01 flow graph's steps, by step id: the steps that have one. */
function bundleCards(steps: readonly BundleStep[]): Record<string, ClockCard> {
  const out: Record<string, ClockCard> = {};
  for (const step of steps) if (step.card !== undefined) out[step.id] = step.card;
  return out;
}

/** Only the cards given, whatever the flow linted holds. */
function only(given: ClockCards): (input: unknown) => ClockCards {
  return () => given;
}

describe("no-safe-default-or-clock: a question without a safe default or a clock", () => {
  it("fails: refuse-no-safe-default-or-clock.json, A6-02's card with neither its safe default nor a clock", () => {
    const step = fixture("invalid/refuse-no-safe-default-or-clock.json") as BundleStep;
    const card = step.card;
    if (card === undefined) throw new Error("the fixture's step has no card");
    // The master's own A6-02 ('Sam replies?') states its safe default, and T-144 gives it step 9's default: the fixture's
    // card leaves both out.
    expect(step.id).toBe("A6-02");
    expect(step.more).toContain("Safe default: not booked; nothing is charged for this visit.");
    expect(card.question).toBe(cardOf("A", "A6-02").question);
    expect(cardOf("A", "A6-02").safeDefault).toBe("not booked; nothing is charged for this visit.");
    expect(cardOf("A", "A6-02").clock).toEqual({ from: "step9Default" });
    expect("safeDefault" in card || "clock" in card).toBe(false);

    // K-01 refuses the step as written, marks it with this rule alone, and takes it once its lint names the rule.
    expect(checkBundlePart(step, "step")).not.toEqual([]);
    expect(lintMarksOf(step)).toEqual([RULE]);
    expect(checkBundlePart({ ...step, lint: [RULE] }, "step")).toEqual([]);

    // The rule, given the fixture's card for A6-02 and T-144's for every other decision of flow A.
    const rule = noDefaultOrClockRule((ctx) => ({ ...compiledCardsOf(ctx), "A6-02": card }));
    const result = runLint([rule], input("A"));
    const line = `A:A6-02 ${RULE} no safe default or clock: q 'Sam replies?': ${ERROR_FIX}`;
    expect(result.errors).toEqual([line]);
    expect(result.hits.filter((hit) => hit.level === "error")).toEqual([
      {
        rule: RULE,
        level: "error",
        step: "A6-02",
        field: "q",
        text: "Sam replies?",
        fix: ERROR_FIX,
        flow: "A",
        trade: null,
        line,
        allowed: false,
        why: null,
      },
    ]);
    // Everything else is as on the master: A6-02's own card is listed for step 9's default there.
    const own = masterRun("A");
    expect(own.warnings.filter((text) => text.startsWith("A:A6-02 "))).toHaveLength(1);
    expect(result.warnings).toEqual(own.warnings.filter((text) => !text.startsWith("A:A6-02 ")));
    expect(cardHits("A6-02", card)).toEqual([
      { rule: RULE, level: "error", step: "A6-02", field: "q", text: "Sam replies?", fix: ERROR_FIX },
    ]);
  });

  it("passes: bundle-mini-a.json, whose every card has a safe default and step 9's default", () => {
    const bundle = fixture("bundle-mini-a.json") as BundleFile;
    expect(checkBundlePart(bundle)).toEqual([]);
    const steps = Object.values(bundle.flows.A?.steps ?? {});
    const given = bundleCards(steps);
    expect(Object.keys(given).length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.lint, step.id).not.toContain(RULE);
      expect(lintMarksOf(step), step.id).not.toContain(RULE);
    }

    const result = runLint([noDefaultOrClockRule(only(given))], input("A"));
    expect(result.errors).toEqual([]);
    expect(result.rules).toEqual([
      { rule: RULE, errors: 0, warnings: Object.keys(given).length, allowed: 0 },
    ]);
    const onDefault = Object.entries(given).filter(([, card]) => card.clock?.from === "step9Default");
    expect(onDefault).toHaveLength(Object.keys(given).length);
    expect(result.hits.map(shape).sort((a, b) => a.step.localeCompare(b.step))).toEqual(
      onDefault
        .map(([id, card]) => ({ step: id, level: "warning", text: card.question, fix: DEFAULT_FIX }))
        .sort((a, b) => a.step.localeCompare(b.step)),
    );
  });

  it("passes: bundle-mini-b.json, where B6-16's own Clock line gives no hit and the others are listed", () => {
    const bundle = fixture("bundle-mini-b.json") as BundleFile;
    expect(checkBundlePart(bundle)).toEqual([]);
    const steps = Object.values(bundle.flows.B?.steps ?? {});
    const given = bundleCards(steps);
    for (const step of steps) expect(lintMarksOf(step), step.id).not.toContain(RULE);
    expect(given["B6-16"]?.clock).toEqual({
      from: "clockLine",
      text: "Clock: Jordan takes it within 5 minutes; silence means not booked.",
    });

    const result = runLint([noDefaultOrClockRule(only(given))], input("B"));
    expect(result.errors).toEqual([]);
    const ids = result.hits.map((hit) => hit.step);
    expect(ids).not.toContain("B6-16");
    expect(ids.sort()).toEqual(
      Object.keys(given)
        .filter((id) => id !== "B6-16")
        .sort(),
    );
    expect(result.hits.every((hit) => hit.level === "warning")).toBe(true);
  });

  it("on the master: 13 decisions state a Clock line and give no hit; the other 197 are listed for step 9's default; none fails", () => {
    const byId = new Map<string, RawDecision>();
    const hitIds = new Set<string>();
    for (const flow of FLOWS) {
      const decisions = rawDecisions(flow);
      for (const decision of decisions) byId.set(decision.id, decision);
      const result = masterRun(flow);
      expect(result.errors, flow).toEqual([]);
      // Each decision of the flow without its own Clock line, listed once in page order, with its question.
      const expected = decisions.filter((decision) => !decision.clockLine).map(listed);
      expect(result.hits.map(shape), flow).toEqual(expected);
      expect(result.rules, flow).toEqual([{ rule: RULE, errors: 0, warnings: expected.length, allowed: 0 }]);
      expect(result.warnings, flow).toHaveLength(expected.length);
      expect(result.hits.every((hit) => hit.rule === RULE && hit.field === "q" && !hit.allowed)).toBe(true);
      for (const hit of result.hits) hitIds.add(hit.step);
    }
    expect(byId.size).toBe(210);
    const quiet = [...byId.values()].filter((decision) => !hitIds.has(decision.id));
    expect(quiet.map((decision) => decision.id)).toEqual([
      "A7-05",
      "A7-15",
      "A7-17",
      "A7-23",
      "A7-74",
      "A10-09",
      "B6-16",
      "B7-08",
      "B7-19",
      "B7-20",
      "B7-28",
      "B7-61",
      "B10-09",
    ]);
    expect(quiet).toEqual([...byId.values()].filter((decision) => decision.clockLine));
    expect(hitIds.size).toBe(197);
    expect([...hitIds].every((id) => byId.get(id)?.clockLine === false)).toBe(true);
    // Of the 197, the 19 whose card states no safe default rest on step 9's default alone.
    expect([...hitIds].filter((id) => byId.get(id)?.safeDefault === false)).toHaveLength(19);
  });

  it("reads a trade's own cards: aba's flow A lists each live decision without a Clock line, S1-62 now with no safe default", () => {
    const trade = loadTrade("aba");
    const applied = applyTrade(master.A, trade);
    const result = runLint([noDefaultOrClock], tradeInput(applied, trade));
    expect(result.errors).toEqual([]);
    expect(result.trade).toBe("aba");

    // This file's own walk of the applied flow: a step or a branch an `off` op switched off is left out.
    const live: AppliedStep[] = [];
    const visit = (steps: readonly AppliedStep[]): void => {
      for (const step of steps) {
        if (step.off !== undefined) continue;
        live.push(step);
        for (const branch of step.branches ?? []) if (branch.off === undefined) visit(branch.steps);
      }
    };
    visit(applied.flow.steps);
    const expected = live
      .filter((step) => step.type === "split")
      .map(decisionOf)
      .filter((decision) => !decision.clockLine)
      .map(listed);
    expect(result.hits.map(shape)).toEqual(expected);

    // aba's own words drop S1-62's safe default line (L7 finds the same): it is still listed, not failed.
    const onMaster = masterRun("A").hits.find((hit) => hit.step === "S1-62");
    expect(onMaster?.fix).toBe(DEFAULT_FIX);
    const onTrade = result.hits.find((hit) => hit.step === "S1-62");
    expect(onTrade).toMatchObject({
      level: "warning",
      text: "What does the plug-in say: does this work pay the $2?",
      fix: DEFAULT_ONLY_FIX,
    });
  });

  it("judges one card as K-01 does: neither fails; a safe default alone or a clock alone passes; no Clock line is listed", () => {
    // A7-05 ('Does Alex cancel anyway?') states a Clock line and a safe default.
    const both = cardOf("A", "A7-05");
    const { safeDefault, clock, ...neither } = both;
    if (safeDefault === undefined) throw new Error("A7-05 has no safe default");
    expect(clock.from).toBe("clockLine");
    const at = { rule: RULE, step: "A7-05", field: "q", text: both.question };
    expect(cardHits("A7-05", both)).toEqual([]);
    expect(cardHits("A7-05", { ...neither, clock })).toEqual([]);
    expect(cardHits("A7-05", { ...neither, safeDefault })).toEqual([
      { ...at, level: "warning", fix: DEFAULT_FIX },
    ]);
    expect(cardHits("A7-05", neither)).toEqual([{ ...at, level: "error", fix: ERROR_FIX }]);
    // A5-04 ('What's taken now?') states neither line: T-144 gives it step 9's default, and that is all it has.
    expect(cardHits("A5-04", cardOf("A", "A5-04"))).toEqual([
      {
        rule: RULE,
        step: "A5-04",
        field: "q",
        text: "What's taken now?",
        level: "warning",
        fix: DEFAULT_ONLY_FIX,
      },
    ]);

    // K-01's own check on the fixture's step marks the rule exactly where the rule errs, for each way of giving its card
    // a safe default or a clock.
    const step = fixture("invalid/refuse-no-safe-default-or-clock.json") as BundleStep;
    const base = step.card;
    if (base === undefined) throw new Error("the fixture's step has no card");
    const own = cardOf("A", "A6-02");
    const ownSafe = own.safeDefault;
    if (ownSafe === undefined) throw new Error("A6-02 has no safe default");
    const ways: [string, ClockCard][] = [
      ["neither", base],
      ["a safe default", { ...base, safeDefault: ownSafe }],
      ["step 9's default", { ...base, clock: own.clock }],
      ["a Clock line", { ...base, clock }],
      ["a safe default and step 9's default", { ...base, safeDefault: ownSafe, clock: own.clock }],
    ];
    for (const [name, card] of ways) {
      const errs = cardHits("A6-02", card).some((hit) => hit.level === "error");
      expect(lintMarksOf({ ...step, card }).includes(RULE), name).toBe(errs);
      expect(errs, name).toBe(name === "neither");
    }
    expect(NO_DEFAULT_OR_CLOCK_RULE).toBe(RULE);
  });
});
