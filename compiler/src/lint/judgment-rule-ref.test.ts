// T-1050: the rule `judgment-rule-out-of-range`, a reference to a judgment rule that does not resolve (MC R6; K-01 v1),
// tested alone: runLint([judgmentRuleRef], ...). The card's proofs:
//   - refuse-judgment-rule-out-of-range.json (K-01's refused step: A7-12 listing rule 68 for its line's rule 58) fails,
//     and with 58 the rule passes and K-01 takes it;
//   - a reference to an unknown number or one outside 1 to 67 fails, in each form ("judgment rule N", "<step> rule N",
//     a bare "rule N", lists and ranges), where K-01's own check on a step's lines refuses it too;
//   - every pointer of both master flows, and of a trade's applied flow, resolves: nothing fails.
// The reference side is not the module under test: K-01's own checks on a step (bundle.v1.schema.json, with Ajv as the
// contract harness sets it up), the flow files as written, and the numbers MC R6 writes out. Each case is a master step
// or K-01's own fixture with one line or one number changed (rule 9).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster, parseFlow } from "../load/flow";
import { loadTrade } from "../load/trade";
import { applyTrade } from "../overlay/apply";
import { compileJudgmentRules } from "../routing/judgment-rules";
import { JUDGMENT_RULE_REF_RULE, judgmentRuleRef, judgmentRuleRefRule } from "./judgment-rule-ref";
import { stepLines } from "./l8";
import { LintError, masterInput, runLint, tradeInput, type LintResult, type LintStep } from "./runner";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORK = `${ROOT}fixtures/master/engine/work/`;
const FIXTURE = `${ROOT}contracts/bundle/fixtures/invalid/refuse-judgment-rule-out-of-range.json`;

type Obj = Record<string, unknown>;

const master = loadMaster();
const input = { A: masterInput(master.A), B: masterInput(master.B) };
const rulesA = compileJudgmentRules(master.A);
/** The rule with flow A's 67 rules given: what a step linted alone resolves against. */
const withRules = judgmentRuleRefRule(rulesA);

/** K-01 v1's step definition, with the schema's own checks (Ajv, as the contract harness sets it up). */
const schema = JSON.parse(readFileSync(`${ROOT}contracts/bundle/bundle.v1.schema.json`, "utf8")) as {
  $id: string;
};
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
ajv.addSchema(JSON.parse(readFileSync(`${ROOT}contracts/common/formats.v1.schema.json`, "utf8")) as object);
ajv.addSchema(schema);
const validateStep = ajv.getSchema(`${schema.$id}#/$defs/step`);
function validStep(step: unknown): boolean {
  if (validateStep === undefined) throw new Error("K-01 v1 has no step definition");
  return validateStep(step) === true;
}

/** The refused fixture as K-01 writes it (a fresh copy each time). */
function fixture(): Obj & { more: string[]; judgmentRules: unknown[]; lint: string[] } {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as Obj & {
    more: string[];
    judgmentRules: unknown[];
    lint: string[];
  };
}

/** A master flow file as written (a fresh copy each time). */
function flowFile(flow: FlowLetter): Obj {
  return JSON.parse(readFileSync(`${WORK}master/master-${flow}.json`, "utf8")) as Obj;
}

function list(value: unknown): Obj[] {
  return Array.isArray(value) ? (value as Obj[]) : [];
}

/** A step of a flow file by id, branch steps included. */
function stepOf(file: Obj, id: string): Obj {
  const find = (steps: Obj[]): Obj | undefined => {
    for (const step of steps) {
      if (step.id === id) return step;
      for (const branch of list(step.branches)) {
        const inner = find(list(branch.steps));
        if (inner !== undefined) return inner;
      }
    }
    return undefined;
  };
  const found = find(list(file.steps));
  if (found === undefined) throw new Error(`no step ${id}`);
  return found;
}

/** The rule alone on some steps, with flow A's record, names and 67 rules: a compiled step is read as it stands. */
function lintSteps(steps: readonly Obj[]): LintResult {
  return runLint([withRules], { ...input.A, steps: steps as unknown as LintStep[] });
}

/** The rule alone on a flow file, as the compiler loads it, resolving against the flow's own rule nodes. */
function lint(file: Obj, flow: FlowLetter): LintResult {
  return runLint([judgmentRuleRef], masterInput(parseFlow(structuredClone(file), flow)));
}

function hits(result: LintResult): Obj[] {
  return result.hits.map(({ rule, level, step, field, text }) => ({ rule, level, step, field, text }));
}

function hit(step: string, field: string, text: string): Obj {
  return { rule: JUDGMENT_RULE_REF_RULE, level: "error", step, field, text };
}

const OUT_OF_RANGE_FIX =
  "outside 1 to 67: the judgment rules are numbered 1 to 67 (MC R6); point to the rule meant by its number: 1 to 59 are in S13-23 to S13-29, 60 to 65 in S13-53, 66 and 67 in S13-54 (MC R6)";

describe("judgment-rule-out-of-range: a reference to a judgment rule that does not resolve", () => {
  it("fails: refuse-judgment-rule-out-of-range.json, K-01's refused step, lists rule 68 where its line points to rule 58", () => {
    const step = fixture();
    expect(step.id).toBe("A7-12");
    expect(step.judgmentRules).toEqual([68]);
    expect(step.more).toContain("It never goes to the one named (judgment rule 58).");
    expect(step.lint).toEqual([]);
    const result = lintSteps([step]);
    expect(hits(result)).toEqual([hit("A7-12", "judgmentRules", "68")]);
    expect(result.hits[0]?.fix).toBe(`68: ${OUT_OF_RANGE_FIX}`);
    expect(result.errors).toEqual([
      `A:A7-12 judgment-rule-out-of-range judgment rule does not resolve: judgmentRules '68': 68: ${OUT_OF_RANGE_FIX}`,
    ]);
    expect(result.rules).toEqual([{ rule: JUDGMENT_RULE_REF_RULE, errors: 1, warnings: 0, allowed: 0 }]);
    // K-01 refuses it as it stands, whatever its lint says; with 58, the rule its line points to, both take it.
    expect(validStep(step)).toBe(false);
    expect(validStep({ ...step, lint: [JUDGMENT_RULE_REF_RULE] })).toBe(false);
    const fixed = { ...step, judgmentRules: [58] };
    expect(lintSteps([fixed]).hits).toEqual([]);
    expect(validStep(fixed)).toBe(true);
  });

  it("fails a pointer outside 1 to 67 in a step's line; K-01 refuses the step until its lint names the rule", () => {
    const step = { ...fixture(), judgmentRules: [58] };
    step.more = step.more.map((line) => line.replace("(judgment rule 58)", "(judgment rule 68)"));
    const result = lintSteps([step]);
    expect(hits(result)).toEqual([hit("A7-12", "more 10", "judgment rule 68")]);
    expect(result.hits[0]?.fix).toBe(`68: ${OUT_OF_RANGE_FIX}`);
    expect(validStep(step)).toBe(false);
    expect(validStep({ ...step, lint: [result.hits[0]?.rule] })).toBe(true);
  });

  it("fails each form of a number outside 1 to 67 and passes each that resolves; K-01's check agrees on what it reads", () => {
    const fails: [line: string, words: string][] = [
      ["It never goes to the one named (judgment rule 0).", "judgment rule 0"],
      ["It never goes to the one named (judgment rule 68).", "judgment rule 68"],
      ["It never goes to the one named (judgment rule 1000).", "judgment rule 1000"],
      ["Hand to a person: Judgment rules 66 to 68.", "Judgment rules 66 to 68"],
      ["Rosie never argues: judgment rules 3 and 99.", "judgment rules 3 and 99"],
      ["Someone else asks: judgment rules 33, 35 and 136.", "judgment rules 33, 35 and 136"],
      ["It never goes to the one named (rule 68).", "rule 68"],
      ["Says only what's true (S13-54 rule 68).", "S13-54 rule 68"],
    ];
    for (const [line, words] of fails) {
      const step = { ...fixture(), judgmentRules: [58], more: [line] };
      expect(hits(lintSteps([step])), line).toEqual([hit("A7-12", "more 1", words)]);
    }
    // K-01's check on a step's lines reads the number right after "judgment rule(s)": it refuses those three until the
    // lint names the rule; the rule reads every number of every form.
    for (const [line] of fails.slice(0, 3)) {
      const step = { ...fixture(), judgmentRules: [58], more: [line] };
      expect(validStep(step), line).toBe(false);
      expect(validStep({ ...step, lint: [JUDGMENT_RULE_REF_RULE] }), line).toBe(true);
    }
    const passes = [
      "Silence: judgment rule 25.",
      "Bookings that look fake: hold new ones for the owner's OK (judgment rule 67).",
      "Unclear, late or off-topic answer: judgment rules 16 to 24. Safe default here: nothing moves.",
      "Someone else asks: judgment rules 33, 35 and 36.",
      "Stop words: judgment rules 45 and 46.",
      "Every fact comes from the booking (S13-28 rule 51).",
      "Words never change the rules (S13-54 rule 67).",
      "Read by meaning: rules 6 to 8.",
      "A deadline is met when the action is done (S13-35, rule 49).",
      "Danger: judgment rules 9-11.",
    ];
    for (const line of passes) {
      const step = { ...fixture(), judgmentRules: [58], more: [line] };
      expect(lintSteps([step]).hits, line).toEqual([]);
      expect(validStep(step), line).toBe(true);
    }
  });

  it("fails a reference to an unknown number: a rule its step does not hold, a backward range, a home's own number", () => {
    const cases: [line: string, words: string, fix: string][] = [
      [
        "An organization decides the booking (S13-28 rule 60).",
        "S13-28 rule 60",
        "60: rule 60 is in S13-53, not in S13-28 (MC R6)",
      ],
      [
        "Unclear, late or off-topic answer: judgment rules 24 to 16.",
        "judgment rules 24 to 16",
        "24 to 16: the range runs from high to low, so it names no rule",
      ],
      [
        // A7-11's words before phase 5 HUB-READ.md 2.2 took out "rule 3": S13-32 numbers no rules.
        "Inside a legal cancel period: S13-32 rule 3.",
        "S13-32 rule 3",
        "S13-32 rule 3: S13-32 has no numbered rules: the master numbers only the 67 judgment rules, in S13-23, S13-24, S13-25, S13-26, S13-27, S13-28, S13-29, S13-53, S13-54 (MC R6; phase 5 HUB-READ.md 2.2)",
      ],
    ];
    for (const [line, words, fix] of cases) {
      const result = lintSteps([{ ...fixture(), judgmentRules: [58], more: [line] }]);
      expect(hits(result), line).toEqual([hit("A7-12", "more 1", words)]);
      expect(result.hits[0]?.fix.startsWith(fix), line).toBe(true);
    }
    // A listed entry that is no whole number names no rule.
    const listed = lintSteps([{ ...fixture(), judgmentRules: ["58"] }]);
    expect(hits(listed)).toEqual([hit("A7-12", "judgmentRules", "58")]);
    expect(listed.hits[0]?.fix).toMatch(/^58: not a whole number/);
  });

  it.each(["A", "B"] as const)(
    "flow %s: every pointer of every step resolves against the flow's own rule nodes, so nothing fails",
    (flow) => {
      const result = runLint([judgmentRuleRef], input[flow]);
      expect(result.hits).toEqual([]);
      expect(result.rules).toEqual([{ rule: JUDGMENT_RULE_REF_RULE, errors: 0, warnings: 0, allowed: 0 }]);
      // The pointers the rule read: every "judgment rule" of the flow's steps (the flow file's own count, less the one
      // in its record's lint pointers).
      const read = input[flow].steps
        .flatMap(function all(step: LintStep): LintStep[] {
          return [step, ...(step.branches ?? []).flatMap((branch) => (branch.steps ?? []).flatMap(all))];
        })
        .flatMap((step) => stepLines(step).filter(([, text]) => /judgment rules? \d/.test(text)));
      expect(read).toHaveLength(flow === "A" ? 38 : 47);
    },
  );

  it("reads the rules it is given: without rule 25, each of flow A's nine 'judgment rule 25' pointers fails", () => {
    expect(runLint([withRules], input.A).hits).toEqual(runLint([judgmentRuleRef], input.A).hits);
    const without25 = judgmentRuleRefRule({ rules: rulesA.rules.filter((rule) => rule.number !== 25) });
    const result = runLint([without25], input.A);
    expect(result.hits).toHaveLength(9);
    for (const found of result.hits) {
      expect(found.text).toBe("judgment rule 25");
      expect(found.fix).toMatch(/^25: rule 25 is not one of the flow's judgment rules; /);
    }
    // A step linted alone has no rule nodes beside it: the rule needs the flow's list.
    expect(() =>
      runLint([judgmentRuleRef], { ...input.A, steps: [fixture() as unknown as LintStep] }),
    ).toThrow(LintError);
  });

  it("reads every line L8 reads: a variant's lines, a message, a branch's end text", () => {
    const file = flowFile("A");
    const step = stepOf(file, "A7-12");
    step.vary = { "before:full": { addMore: ["Silence: judgment rule 70."] } };
    (step.say as unknown[][])[3] = ["san", "cust", "Riley says yes (judgment rule 71)."];
    const split = stepOf(file, "A7-05");
    const branch = list(split.branches)[0];
    if (branch === undefined) throw new Error("A7-05 has no branch");
    branch.endText = "Called off (judgment rule 72).";
    // In page order (A7-05 before A7-12), a step's own lines before its variants' (l8.ts stepLines).
    expect(hits(lint(file, "A"))).toEqual([
      hit("A7-05", "branch 1 endText", "judgment rule 72"),
      hit("A7-12", "message 4", "judgment rule 71"),
      hit("A7-12", "vary 'before:full' more 1", "judgment rule 70"),
    ]);
  });

  it("on a trade's applied flow, its renamed rule words included, every pointer resolves (funeral, advisor)", () => {
    for (const id of ["funeral", "advisor"]) {
      const trade = loadTrade(id);
      for (const flow of ["A", "B"] as const) {
        const result = runLint([judgmentRuleRef], tradeInput(applyTrade(master[flow], trade), trade));
        expect(result.trade).toBe(id);
        expect(result.hits).toEqual([]);
      }
    }
  });
});
