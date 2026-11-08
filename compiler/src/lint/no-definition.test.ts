// T-156: the lint rule choice-without-definition, a choice without a definition (arch 12 line 592; K-01 v1; NQ-PB-3's
// default), tested alone: runLint([rule], ...). The cards are the master's own (T-144's compiler on master-A.json and
// master-B.json), a trade's (aba, as its own words lay them) and the K-01 fixtures' (the architect's copies of the
// master's steps). The failing cases are the K-01 fixture and the master's own steps with some of their words taken
// away, never words invented (rule 9).
//
// The counts come from the raw flow files, walked by this file, never through the code under test: a decision is a step
// with `type: "split"` (T-144's reading; over both flows the shared S-steps count once), and a Means line is a `more`
// line that starts with the word Means (T-144's and specs.md section 6's count: 48 decisions state none). What fails is
// checked against K-01's own check (emit/validate.ts lintMarksOf, the schema's step check): the rule's error falls on
// exactly the cards the schema marks with the rule.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileMasterCards, firstSentence, hasMeansLine, type CardMeans, type StepCard } from "../cards";
import { checkBundlePart, lintMarksOf, lintRuleOrder } from "../emit/validate";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster, parseFlow } from "../load/flow";
import { loadTrade } from "../load/trade";
import { applyTrade, type AppliedStep } from "../overlay/apply";
import {
  CHOICE_WITHOUT_DEFINITION_RULE,
  compiledDecisionsOf,
  decisionHits,
  noDefinition,
  noDefinitionRule,
  type DefinedDecision,
  type DefinitionCard,
} from "./no-definition";
import { masterInput, runLint, tradeInput, type LintHit, type LintInput, type LintResult } from "./runner";

const WORK = fileURLToPath(new URL("../../../fixtures/master/engine/work/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../../../contracts/bundle/fixtures/", import.meta.url));
const FLOWS = ["A", "B"] as const;
const RULE = "choice-without-definition";
const NAME = "choice without a definition";

const ERROR_FIX =
  "write its Means line on the step (Means '<its label>': ...), or lead it to a step or ending words whose first sentence can stand in: with neither, the model is handed the choice with no definition";
const STAND_IN = "the first sentence of the step each leads to, or of its ending words";
const LISTED_TAIL = "(arch 12 line 592): it passes, listed (NQ-PB-3)";

/** The warning of a decision that states no Means line and whose `n` choices all take a stand-in. */
function listed(n: number): string {
  return `relies on stand-ins: it states no Means line, so its ${String(n)} choices take ${STAND_IN} ${LISTED_TAIL}`;
}

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
  does?: string;
  more?: string[];
  branches?: RawBranch[];
}
interface RawFile {
  steps: RawStep[];
}

/** A decision as this file reads it from a raw flow file. */
interface RawDecision {
  id: string;
  q: string;
  /** Some `more` line starts with Means. */
  means: boolean;
  labels: string[];
}

const MEANS_LINE = /^Means\b/;

/** A master flow file as written (a fresh copy each time). */
function rawFile(flow: FlowLetter): RawFile {
  return JSON.parse(readFileSync(`${WORK}master/master-${flow}.json`, "utf8")) as RawFile;
}

/** Every step under `steps`, in page order: a step, then its branches' steps (this file's own walk). */
function* rawSteps(steps: readonly RawStep[]): Generator<RawStep> {
  for (const step of steps) {
    yield step;
    for (const branch of step.branches ?? []) yield* rawSteps(branch.steps);
  }
}

/** A step of a raw flow file by id, branch steps included. */
function rawStepOf(file: RawFile, id: string): RawStep {
  for (const step of rawSteps(file.steps)) if (step.id === id) return step;
  throw new Error(`no step ${id}`);
}

/** A branch of a raw step by label. */
function rawBranchOf(step: RawStep, label: string): RawBranch {
  const found = (step.branches ?? []).find((branch) => branch.label === label);
  if (found === undefined) throw new Error(`${step.id} has no branch '${label}'`);
  return found;
}

/** The decisions of one raw master flow file, in page order. */
function rawDecisions(flow: FlowLetter): RawDecision[] {
  return [...rawSteps(rawFile(flow).steps)]
    .filter((step) => step.type === "split")
    .map((step) => ({
      id: step.id,
      q: step.q ?? "",
      means: (step.more ?? []).some((line) => MEANS_LINE.test(line)),
      labels: (step.branches ?? []).map((branch) => branch.label),
    }));
}

function shape(hit: LintHit): { step: string; level: string; field: string; text: string; fix: string } {
  return { step: hit.step, level: hit.level, field: hit.field, text: hit.text, fix: hit.fix };
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
  return runLint([noDefinition], input(flow));
}

/** The rule alone on a flow file as the compiler loads it. */
function lint(file: RawFile, flow: FlowLetter): LintResult {
  return runLint([noDefinition], masterInput(parseFlow(structuredClone(file), flow)));
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
  card?: DefinitionCard;
  lint: string[];
  [field: string]: unknown;
}
interface BundleFile {
  flows: Partial<Record<FlowLetter, { steps: Record<string, BundleStep> }>>;
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES}${name}`, "utf8"));
}

/** A K-01 step's decision: its card, and whether its own `more` states a Means line (T-144's hasMeansLine). */
function bundleDecision(step: BundleStep): DefinedDecision {
  if (step.card === undefined) throw new Error(`${step.id} has no card`);
  return { step: step.id, card: step.card, statesMeans: hasMeansLine(step.more ?? []) };
}

describe("choice-without-definition: a choice without a definition", () => {
  it("fails: refuse-choice-without-definition.json, A6-02's card with the choice '2 Another time' left with no definition", () => {
    const step = fixture("invalid/refuse-choice-without-definition.json") as BundleStep;
    const card = step.card;
    if (card === undefined) throw new Error("the fixture's step has no card");
    // The master's own A6-02 ('Sam replies?') defines '2 Another time' by its Means line; the fixture's card has none.
    expect(step.id).toBe("A6-02");
    expect(card.question).toBe(cardOf("A", "A6-02").question);
    expect(cardOf("A", "A6-02").means.find((entry) => entry.branch === "2 Another time")).toEqual({
      branch: "2 Another time",
      text: "Sam offers another time, read back first.",
      from: "meansLine",
    });
    expect(card.means.find((entry) => entry.branch === "2 Another time")).toEqual({
      branch: "2 Another time",
      from: "none",
    });

    // K-01 refuses the step as written, marks it with this rule alone, and takes it once its lint names the rule.
    expect(checkBundlePart(step, "step")).not.toEqual([]);
    expect(lintMarksOf(step)).toEqual([RULE]);
    expect(checkBundlePart({ ...step, lint: [RULE] }, "step")).toEqual([]);

    // The fixture's decision alone: one error, on the choice with no definition. Its step states a Means line, so it is
    // not listed for its two stand-ins.
    const decision = bundleDecision(step);
    expect(decision.statesMeans).toBe(true);
    const line = `A:A6-02 ${RULE} ${NAME}: branch '2 Another time': ${ERROR_FIX}`;
    const alone = runLint([noDefinitionRule(() => [decision])], input("A"));
    expect(alone.errors).toEqual([line]);
    expect(alone.warnings).toEqual([]);
    expect(alone.rules).toEqual([{ rule: RULE, errors: 1, warnings: 0, allowed: 0 }]);
    expect(alone.hits).toEqual([
      {
        rule: RULE,
        level: "error",
        step: "A6-02",
        field: "branch '2 Another time'",
        text: "2 Another time",
        fix: ERROR_FIX,
        flow: "A",
        trade: null,
        line,
        allowed: false,
        why: null,
      },
    ]);

    // Flow A with the fixture's card for A6-02 and T-144's for every other decision: that one error, and the master's
    // own listing as it is (A6-02 is not in it).
    const rule = noDefinitionRule((ctx) =>
      compiledDecisionsOf(ctx).map((each) => (each.step === "A6-02" ? decision : each)),
    );
    const result = runLint([rule], input("A"));
    const own = masterRun("A");
    expect(result.errors).toEqual([line]);
    expect(own.errors).toEqual([]);
    expect(own.hits.some((hit) => hit.step === "A6-02")).toBe(false);
    expect(result.warnings).toEqual(own.warnings);
  });

  it("fails: B4-01's choice 'A video or phone session' without its ending words, which ends the flow with no step", () => {
    // B4-01 states no Means line, and its choice 'A video or phone session' ends the flow with no step of its own: T-144
    // gives it the first sentence of its ending words.
    const file = rawFile("B");
    const step = rawStepOf(file, "B4-01");
    const video = rawBranchOf(step, "A video or phone session");
    expect(step.more?.some((text) => MEANS_LINE.test(text))).toBe(false);
    expect(video.steps).toEqual([]);
    expect(video.end).toBe("end");
    const ending = video.endText ?? "";
    const before = cardOf("B", "B4-01").means.find((entry) => entry.branch === "A video or phone session");
    expect(before).toEqual({
      branch: "A video or phone session",
      text: firstSentence(ending),
      from: "firstSentence",
    });
    const own = masterRun("B");
    expect(own.hits.filter((hit) => hit.step === "B4-01").map(shape)).toEqual([
      { step: "B4-01", level: "warning", field: "q", text: step.q, fix: listed(3) },
    ]);

    // Without its ending words nothing can stand in: the choice fails, and the decision is still listed for its two
    // other choices.
    delete video.endText;
    const result = lint(file, "B");
    expect(result.errors).toEqual([
      `B:B4-01 ${RULE} ${NAME}: branch 'A video or phone session': ${ERROR_FIX}`,
    ]);
    expect(result.hits.filter((hit) => hit.step === "B4-01").map(shape)).toEqual([
      {
        step: "B4-01",
        level: "warning",
        field: "q",
        text: step.q,
        fix: `relies on stand-ins: it states no Means line, so 2 of its 3 choices take ${STAND_IN} ${LISTED_TAIL}`,
      },
      {
        step: "B4-01",
        level: "error",
        field: "branch 'A video or phone session'",
        text: "A video or phone session",
        fix: ERROR_FIX,
      },
    ]);
    expect(result.hits.filter((hit) => hit.step !== "B4-01")).toEqual(
      own.hits.filter((hit) => hit.step !== "B4-01"),
    );
  });

  it("fails: A5-20's choice 'Not signed in time' when the step it leads to has no words to stand in", () => {
    // A5-20 states no Means line; its choice 'Not signed in time' leads to its own first step, whose first sentence
    // stands in. With that step's `does` taken away there is no first sentence, and its ending words do not stand in
    // for a choice that leads to a step.
    const file = rawFile("A");
    const step = rawStepOf(file, "A5-20");
    const late = rawBranchOf(step, "Not signed in time");
    const first = late.steps[0];
    if (first === undefined) throw new Error("'Not signed in time' has no step");
    expect(step.more?.some((text) => MEANS_LINE.test(text))).toBe(false);
    expect(cardOf("A", "A5-20").means.find((entry) => entry.branch === "Not signed in time")).toEqual({
      branch: "Not signed in time",
      text: firstSentence(first.does ?? ""),
      from: "firstSentence",
    });
    expect(late.endText).toMatch(/\S/);

    first.does = "";
    const result = lint(file, "A");
    expect(result.errors).toEqual([`A:A5-20 ${RULE} ${NAME}: branch 'Not signed in time': ${ERROR_FIX}`]);
    expect(result.hits.filter((hit) => hit.step === "A5-20").map(shape)).toEqual([
      {
        step: "A5-20",
        level: "warning",
        field: "q",
        text: step.q,
        fix: `relies on stand-ins: it states no Means line, so 1 of its 2 choices takes ${STAND_IN} ${LISTED_TAIL}`,
      },
      {
        step: "A5-20",
        level: "error",
        field: "branch 'Not signed in time'",
        text: "Not signed in time",
        fix: ERROR_FIX,
      },
    ]);
    expect(result.hits.filter((hit) => hit.step !== "A5-20")).toEqual(
      masterRun("A").hits.filter((hit) => hit.step !== "A5-20"),
    );
  });

  it("on the master: no choice fails, and exactly 48 decisions are listed as using a stand-in: those that state no Means line", () => {
    const byId = new Map<string, RawDecision>();
    const listedIds = new Set<string>();
    const perFlow: Partial<Record<FlowLetter, number>> = {};
    for (const flow of FLOWS) {
      const decisions = rawDecisions(flow);
      for (const decision of decisions) byId.set(decision.id, decision);
      const result = masterRun(flow);
      expect(result.errors, flow).toEqual([]);
      // Each decision of the flow that states no Means line, listed once in page order, with its question and the
      // number of its choices, every one of which takes a stand-in.
      const expected = decisions
        .filter((decision) => !decision.means)
        .map((decision) => ({
          step: decision.id,
          level: "warning",
          field: "q",
          text: decision.q,
          fix: listed(decision.labels.length),
        }));
      expect(result.hits.map(shape), flow).toEqual(expected);
      expect(result.rules, flow).toEqual([{ rule: RULE, errors: 0, warnings: expected.length, allowed: 0 }]);
      expect(result.warnings, flow).toHaveLength(expected.length);
      expect(result.hits.every((hit) => hit.rule === RULE && !hit.allowed && hit.trade === null)).toBe(true);
      perFlow[flow] = expected.length;
      for (const hit of result.hits) listedIds.add(hit.step);
    }
    expect(perFlow).toEqual({ A: 36, B: 30 });
    expect(byId.size).toBe(210);
    const lacking = [...byId.values()].filter((decision) => !decision.means);
    expect(lacking).toHaveLength(48);
    expect(listedIds.size).toBe(48);
    expect([...listedIds].sort()).toEqual(lacking.map((decision) => decision.id).sort());

    // The 48 hold 173 choices between them (T-144's count), each defined on T-144's card by its stand-in, in each flow
    // that has the decision.
    const choices = new Set<string>();
    for (const decision of lacking)
      for (const label of decision.labels) choices.add(`${decision.id}\u0000${label}`);
    expect(choices.size).toBe(173);
    for (const flow of FLOWS) {
      for (const decision of rawDecisions(flow).filter((each) => !each.means)) {
        const means = cardOf(flow, decision.id).means;
        expect(means.map((entry) => entry.branch)).toEqual(decision.labels);
        expect(
          means.every((entry) => entry.from === "firstSentence"),
          `${flow} ${decision.id}`,
        ).toBe(true);
      }
    }
  });

  it("passes: bundle-mini-a.json and bundle-mini-b.json, K-01's accepted samples, where every choice has a definition", () => {
    for (const [name, flow] of [
      ["bundle-mini-a.json", "A"],
      ["bundle-mini-b.json", "B"],
    ] as const) {
      const bundle = fixture(name) as BundleFile;
      expect(checkBundlePart(bundle), name).toEqual([]);
      const steps = Object.values(bundle.flows[flow]?.steps ?? {}).filter((step) => step.card !== undefined);
      expect(steps.length, name).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step.lint, `${name} ${step.id}`).not.toContain(RULE);
        expect(lintMarksOf(step), `${name} ${step.id}`).not.toContain(RULE);
      }

      const result = runLint([noDefinitionRule(() => steps.map(bundleDecision))], input(flow));
      expect(result.errors, name).toEqual([]);
      // Listed: the steps whose own `more` states no Means line (this file's reading), each once, as a warning.
      const unlisted = steps.filter((step) => (step.more ?? []).some((text) => MEANS_LINE.test(text)));
      const expected = steps.filter((step) => !unlisted.includes(step)).map((step) => step.id);
      expect(result.hits.map((hit) => hit.step).sort(), name).toEqual(expected.sort());
      expect(result.hits.every((hit) => hit.level === "warning" && hit.field === "q")).toBe(true);
    }
  });

  it("reads a trade's own cards: aba's flow A lists each live decision that states no Means line, S1-80 with the one choice aba keeps", () => {
    const trade = loadTrade("aba");
    const applied = applyTrade(master.A, trade);
    const result = runLint([noDefinition], tradeInput(applied, trade));
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
    const one = `relies on stand-ins: it states no Means line, so its 1 choice takes ${STAND_IN} ${LISTED_TAIL}`;
    const expected = live
      .filter((step) => step.type === "split" && !(step.more ?? []).some((text) => MEANS_LINE.test(text)))
      .map((step) => {
        const n = (step.branches ?? []).filter((branch) => branch.off === undefined).length;
        return {
          step: step.id,
          level: "warning",
          field: "q",
          text: step.q ?? "",
          fix: n === 1 ? one : listed(n),
        };
      });
    expect(result.hits.map(shape)).toEqual(expected);

    // aba switches S1-80's 'Yes: spaces or things' off: listed with two choices on the master, with one on aba.
    expect(masterRun("A").hits.find((hit) => hit.step === "S1-80")?.fix).toBe(listed(2));
    expect(result.hits.find((hit) => hit.step === "S1-80")?.fix).toBe(one);
  });

  it("judges one decision as K-01 does: a choice with no definition fails; stand-ins are listed only where the step states no Means line", () => {
    expect(CHOICE_WITHOUT_DEFINITION_RULE).toBe(RULE);
    expect(lintRuleOrder()).toContain(RULE);

    // K-01's own check on the fixture's step marks the rule exactly where the rule errs, for each way of defining its
    // choice '2 Another time': none, its own Means line (the master's), or a stand-in (the first sentence of A6-04, the
    // step it leads to).
    const step = fixture("invalid/refuse-choice-without-definition.json") as BundleStep;
    const base = step.card;
    if (base === undefined) throw new Error("the fixture's step has no card");
    const leadsTo = master.A.steps["A6-04"];
    if (leadsTo === undefined) throw new Error("no step A6-04");
    const ways: [string, CardMeans][] = [
      ["no definition", { branch: "2 Another time", from: "none" }],
      [
        "its Means line",
        { branch: "2 Another time", text: "Sam offers another time, read back first.", from: "meansLine" },
      ],
      ["a stand-in", { branch: "2 Another time", text: firstSentence(leadsTo.does), from: "firstSentence" }],
    ];
    for (const [name, entry] of ways) {
      const card: DefinitionCard = {
        ...base,
        means: base.means.map((each) => (each.branch === entry.branch ? entry : each)),
      };
      for (const statesMeans of [true, false]) {
        const errs = decisionHits({ step: "A6-02", card, statesMeans }).filter(
          (hit) => hit.level === "error",
        );
        expect(lintMarksOf({ ...step, card }).includes(RULE), name).toBe(errs.length > 0);
        expect(errs.length, name).toBe(name === "no definition" ? 1 : 0);
      }
    }

    // S1-60 states no Means line: its two choices take stand-ins, so it is listed; given a Means line it is not.
    const s160 = cardOf("A", "S1-60");
    const at = { rule: RULE, step: "S1-60", field: "q", text: s160.question };
    expect(decisionHits({ step: "S1-60", card: s160, statesMeans: false })).toEqual([
      { ...at, level: "warning", fix: listed(2) },
    ]);
    expect(decisionHits({ step: "S1-60", card: s160, statesMeans: true })).toEqual([]);
    // Every choice with no definition: two errors, and no stand-in to list.
    const bare: DefinitionCard = {
      question: s160.question,
      means: s160.means.map((entry) => ({ branch: entry.branch, from: "none" })),
    };
    expect(decisionHits({ step: "S1-60", card: bare, statesMeans: false })).toEqual(
      s160.means.map((entry) => ({
        rule: RULE,
        level: "error",
        step: "S1-60",
        field: `branch '${entry.branch}'`,
        text: entry.branch,
        fix: ERROR_FIX,
      })),
    );
  });
});
