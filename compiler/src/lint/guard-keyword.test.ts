// T-159: the rule `guard-keyword-button`, a button whose whole text is a guard keyword (arch 12 line 592; QUESTIONS
// Q-14's default: the lint fails the step), tested alone: runLint([guardKeyword], ...). The card's proofs:
//   - refuse-guard-keyword-button.json (K-01's refused step: S1-37 as the master writes it) fails, and K-01 takes it once
//     its lint names the rule;
//   - on the master, only S1-37's 'Start' fails, in both flows;
//   - the YES and NO buttons (S1-78, A7-12, A8-47, S11-20, B7-16, B8-47) are not reported.
// The guard's words are T-134's keyword list (buildKeywords()), never typed here. The reference side is not the module
// under test: K-01's own checks on a button (bundle.v1.schema.json keywordButton) and on a step, with Ajv as the contract
// harness sets it up; every button of both flows, read through T-134's flowMessages(); and msgtext.js's own check
// (uiProblems, line 95), as lib.js loads it, for the opt-out words. Each case is the master's own steps and words, moved
// within a flow or with one button's words changed, or a trade's own words as the vendored apply() lays them (rule 9).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster, parseFlow } from "../load/flow";
import { loadTrade } from "../load/trade";
import { buildKeywords, flowMessages } from "../msgtext";
import { applyTrade } from "../overlay/apply";
import { makeCjsLoader } from "../overlay/cjs-load";
import { BUILD_DIR } from "../overlay/core";
import {
  GUARD_KEYWORD_RULE,
  guardKeyword,
  guardKeywordRule,
  keywordButtons,
  keywordReader,
} from "./guard-keyword";
import { LintError, masterInput, runLint, tradeInput, type LintResult, type LintStep } from "./runner";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORK = `${ROOT}fixtures/master/engine/work/`;
const FIXTURE = `${ROOT}contracts/bundle/fixtures/invalid/refuse-guard-keyword-button.json`;

type Obj = Record<string, unknown>;

const master = loadMaster();
const keywords = buildKeywords();
/** START, HELP and the opt-out words, as T-134's list writes them. */
const WORDS = [keywords.start, keywords.help, ...keywords.optOut];
const input = { A: masterInput(master.A), B: masterInput(master.B) };

/** K-01 v1's definitions, with the schema's own checks (Ajv, as the contract harness sets it up). */
const schema = JSON.parse(readFileSync(`${ROOT}contracts/bundle/bundle.v1.schema.json`, "utf8")) as {
  $id: string;
};
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
ajv.addSchema(JSON.parse(readFileSync(`${ROOT}contracts/common/formats.v1.schema.json`, "utf8")) as object);
ajv.addSchema(schema);
function definition(name: string): (value: unknown) => boolean {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (validate === undefined) throw new Error(`K-01 v1 has no ${name} definition`);
  return (value) => validate(value) === true;
}
/** K-01's check on one button: its words, trimmed and in any case, are a guard keyword. */
const keywordButton = definition("keywordButton");
const validStep = definition("step");

/** msgtext.js's shape checks as step.js's library reaches them: lib.js's MSG, from a loader of the test's own. */
const MSG = (makeCjsLoader()(`${BUILD_DIR}lib.js`) as { MSG: { uiProblems(elements: unknown): string[] } })
  .MSG;

/** Whether msgtext.js refuses a button because its words are an opt-out word (msgtext.js line 95). */
function optOutByMsgtext(button: unknown): boolean {
  return MSG.uiProblems({ buttons: [button] }).some((problem) => problem.includes("is an opt-out word"));
}

function fix(keyword: string): string {
  return `a tap may send its words, which the guard reads as ${keyword} (arch 02 line 115; msgtext.js line 94): reword the button by what it does, so that its whole text is no guard keyword; Jay approves the new words in the J-18 overlay batch (Q-14)`;
}

/** The refused fixture as K-01 writes it (a fresh copy each time). */
function fixture(): Obj & { say: Obj[]; lint: string[] } {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as Obj & { say: Obj[]; lint: string[] };
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

const fileA = flowFile("A");

/** The rule alone on a flow file, as the compiler loads it. */
function lint(file: Obj, flow: FlowLetter): LintResult {
  return runLint([guardKeyword], masterInput(parseFlow(structuredClone(file), flow)));
}

/** The rule alone on some steps, with flow A's record and names: a compiled step is read as it stands. */
function lintSteps(steps: readonly Obj[]): LintResult {
  return runLint([guardKeyword], { ...input.A, steps: steps as unknown as LintStep[] });
}

function hits(result: LintResult): Obj[] {
  return result.hits.map(({ rule, level, step, field, text, fix: what }) => ({
    rule,
    level,
    step,
    field,
    text,
    fix: what,
  }));
}

/** The one hit of a button whose words `text` are the guard's `keyword`. */
function hit(step: string, field: string, text: string, keyword: string): Obj {
  return { rule: GUARD_KEYWORD_RULE, level: "error", step, field, text, fix: fix(keyword) };
}

/** S1-37 as flow A's file writes it, its one button changed (a fresh copy each time). */
function withButton(button: unknown): Obj {
  const step = structuredClone(stepOf(fileA, "S1-37"));
  const elements = (step.say as unknown[][])[1]?.[3] as { buttons: unknown[] };
  expect(elements.buttons).toEqual(["Start"]);
  elements.buttons = [button];
  return step;
}

/** Every button of a flow, read through T-134's flowMessages(): its step, the button, and its label's words. */
function flowButtons(flow: FlowLetter): { step: string; button: unknown; words: string }[] {
  return flowMessages(master[flow]).flatMap(({ step, message }) =>
    (message[3]?.buttons ?? []).map((button) => ({
      step,
      button,
      words: typeof button === "string" ? button : button[1],
    })),
  );
}

describe("guard-keyword-button: a button whose whole text is a guard keyword", () => {
  it("fails: refuse-guard-keyword-button.json, K-01's refused step (S1-37 as the master writes it): 'Start' is START", () => {
    const step = fixture();
    expect(step.id).toBe("S1-37");
    expect(step.lint).toEqual([]);
    const result = lintSteps([step]);
    expect(hits(result)).toEqual([hit("S1-37", "message 2 button 1", "Start", "START")]);
    expect(result.errors).toEqual([
      `A:S1-37 guard-keyword-button button is a guard keyword: message 2 button 1 'Start': ${fix("START")}`,
    ]);
    expect(result.rules).toEqual([{ rule: GUARD_KEYWORD_RULE, errors: 1, warnings: 0, allowed: 0 }]);

    // K-01 refuses the step as it stands, and takes it once its lint names the rule that failed it.
    expect(validStep(step)).toBe(false);
    expect(validStep({ ...step, lint: [result.hits[0]?.rule] })).toBe(true);
  });

  it("passes: the same step with its button in S1-35's own words, 'Start now', which K-01 takes with an empty lint", () => {
    // S1-37 is on S1-35's branch '2 Later, or no reply'; S1-35's own first button is 'Start now'.
    const s135 = flowButtons("A").filter(({ step }) => step === "S1-35");
    expect(s135.map(({ words }) => words)).toContain("Start now");
    const step = fixture();
    const elements = step.say[1]?.elements as { buttons: string[] };
    elements.buttons = ["Start now"];
    expect(lintSteps([step]).hits).toEqual([]);
    expect(validStep(step)).toBe(true);
  });

  it.each(["A", "B"] as const)(
    "flow %s: only S1-37's 'Start' fails, of every button of the flow, as K-01's own check finds",
    (flow) => {
      const result = runLint([guardKeyword], input[flow]);
      expect(hits(result)).toEqual([hit("S1-37", "message 2 button 1", "Start", "START")]);
      expect(result.errors).toEqual([
        `${flow}:S1-37 guard-keyword-button button is a guard keyword: message 2 button 1 'Start': ${fix("START")}`,
      ]);
      expect(result.warnings).toEqual([]);
      expect(result.allowed).toEqual([]);

      // The reference: every button of the flow (T-134's flowMessages), judged by K-01's keywordButton.
      const buttons = flowButtons(flow);
      expect(buttons).toHaveLength(flow === "A" ? 267 : 291);
      const failing = buttons.filter(({ button }) => keywordButton(button));
      expect(failing.map(({ step, words }) => `${step} ${words}`)).toEqual(["S1-37 Start"]);
      // msgtext.js's own check (line 95) refuses none of them: 'Start' is START, which it does not read, as it reads the
      // opt-out words alone (arch 12 line 592 adds the other guard keywords).
      expect(buttons.filter(({ button }) => optOutByMsgtext(button))).toEqual([]);
    },
  );

  it("does not report the YES and NO buttons: S1-78, A7-12, A8-47, S11-20 in flow A; S1-78, B7-16, B8-47, S11-20 in B", () => {
    const cards: Record<FlowLetter, string[]> = {
      A: ["A7-12", "A8-47", "S1-78", "S11-20"],
      B: ["B7-16", "B8-47", "S1-78", "S11-20"],
    };
    for (const flow of ["A", "B"] as const) {
      // The steps with a button whose whole words are Yes or No are the card's six (S1-78 and S11-20 in both flows).
      const yesNo = flowButtons(flow).filter(({ words }) => /^(yes|no)$/i.test(words.trim()));
      expect([...new Set(yesNo.map(({ step }) => step))].sort()).toEqual(cards[flow]);
      expect([...new Set(yesNo.map(({ words }) => words))].sort()).toEqual(["No", "Yes"]);
      // K-01's check agrees that neither is a guard keyword.
      for (const { button } of yesNo) expect(keywordButton(button)).toBe(false);
      const reported = runLint([guardKeyword], input[flow]).hits.map((found) => found.step);
      for (const step of cards[flow]) expect(reported).not.toContain(step);
    }
    const keywordOf = keywordReader();
    for (const words of ["YES", "Yes", "yes", "NO", "No", " no "]) expect(keywordOf(words)).toBeNull();
  });

  it("fails each guard word of T-134's list, trimmed and in any case, as a label or a pair's label; K-01 and msgtext.js agree", () => {
    expect(WORDS).toHaveLength(18);
    for (const word of WORDS) {
      const capital = `${word.charAt(0)}${word.slice(1).toLowerCase()}`;
      const forms: unknown[] = [word, ` ${word.toLowerCase()} `, capital, ["1", word], ["A", capital]];
      for (const button of forms) {
        const words = typeof button === "string" ? button : String((button as string[])[1]);
        const result = lintSteps([withButton(button)]);
        expect(hits(result), JSON.stringify(button)).toEqual([
          hit("S1-37", "message 2 button 1", words, word),
        ]);
        expect(keywordButton(button), JSON.stringify(button)).toBe(true);
        expect(optOutByMsgtext(button), JSON.stringify(button)).toBe(keywords.optOut.includes(word));
      }
    }
  });

  it("passes words that hold a guard word and more, or none: K-01 and msgtext.js read them so too", () => {
    const buttons: unknown[] = [
      "Start now",
      "Stop texts",
      "Cancel visit",
      "STOP ALL",
      "OPT-OUT",
      "Help me",
      "Parar ya",
      "Yes",
      "No",
      ["2", "Later"],
    ];
    for (const button of buttons) {
      expect(lintSteps([withButton(button)]).hits, JSON.stringify(button)).toEqual([]);
      expect(keywordButton(button), JSON.stringify(button)).toBe(false);
      expect(optOutByMsgtext(button), JSON.stringify(button)).toBe(false);
    }
  });

  it("fails a button in a variant's say or addSay, the hit naming the variant; K-01 refuses such a step until its lint names the rule", () => {
    // A variant keyed as A8-45's (pf:sensitive), holding S1-37's own messages.
    expect(Object.keys(stepOf(fileA, "A8-45").vary as Obj)).toContain("pf:sensitive");
    const file = flowFile("A");
    const step = stepOf(file, "S1-37");
    const say = step.say as unknown[];
    step.say = [say[0], say[2]];
    step.vary = { "pf:sensitive": { say: [say[0]], addSay: [say[1], say[2]] } };
    expect(hits(lint(file, "A"))).toEqual([
      hit("S1-37", "vary 'pf:sensitive' message 2 button 1", "Start", "START"),
    ]);
    step.vary = { "pf:sensitive": { say: [say[1]] } };
    expect(hits(lint(file, "A"))).toEqual([
      hit("S1-37", "vary 'pf:sensitive' message 1 button 1", "Start", "START"),
    ]);

    // The compiled step, its button's message moved into a variant's addSay.
    const compiled = fixture();
    const messages = compiled.say;
    const moved = {
      ...compiled,
      say: [messages[0], messages[2]],
      vary: { "pf:sensitive": { addSay: [messages[1]] } },
    };
    expect(hits(lintSteps([moved]))).toEqual([
      hit("S1-37", "vary 'pf:sensitive' message 1 button 1", "Start", "START"),
    ]);
    expect(validStep(moved)).toBe(false);
    expect(validStep({ ...moved, lint: [GUARD_KEYWORD_RULE] })).toBe(true);
  });

  it("reads a message a trade writes with no text, [from, to, elements], and gives each button's keyword back", () => {
    const step = withButton("Start");
    const say = step.say as unknown[][];
    const [from, to, , elements] = say[1] ?? [];
    say[1] = [from, to, elements];
    expect(hits(lintSteps([step]))).toEqual([hit("S1-37", "message 2 button 1", "Start", "START")]);
    expect(keywordButtons(step as unknown as LintStep, keywordReader())).toEqual([
      { field: "message 2 button 1", words: "Start", keyword: "START" },
    ]);
    expect(keywordReader()(" opt out ")).toBe("OPT OUT");
  });

  it("fails a trade's own words as the vendored apply() lays them: carpet's S1-38 'Start' in both flows, after S1-37's own", () => {
    const trade = loadTrade("carpet");
    for (const flow of ["A", "B"] as const) {
      const result = runLint([guardKeyword], tradeInput(applyTrade(master[flow], trade), trade));
      expect(result.trade).toBe("carpet");
      expect(result.hits.map(({ step, field, text }) => ({ step, field, text }))).toEqual([
        { step: "S1-37", field: "message 2 button 1", text: "Start" },
        { step: "S1-38", field: "message 1 button 1", text: "Start" },
      ]);
      expect(result.hits.every((found) => found.level === "error" && found.trade === "carpet")).toBe(true);
    }
  });

  it("does not read a step a trade switched off, nor the steps under a switched-off branch (S1-35's '2 Later, or no reply')", () => {
    expect(lintSteps([{ ...fixture(), off: "not offered" }]).hits).toEqual([]);

    const s135 = structuredClone(stepOf(fileA, "S1-35"));
    expect(lintSteps([s135]).hits.map((found) => found.step)).toEqual(["S1-37"]);
    const later = list(s135.branches).find((branch) => branch.label === "2 Later, or no reply");
    if (later === undefined) throw new Error("S1-35 has no branch '2 Later, or no reply'");
    expect(list(later.steps).map((inner) => inner.id)).toEqual(["S1-36", "S1-37"]);
    later.off = "not offered";
    expect(lintSteps([s135]).hits).toEqual([]);
  });

  it("reads the guard's words from the list it is given, T-134's by default: with YES on the list, the YES buttons fail", () => {
    expect(runLint([guardKeyword], input.A).hits).toEqual(
      runLint([guardKeywordRule(buildKeywords())], input.A).hits,
    );
    // A list that is not the guard's, START put out and YES put in: the rule follows the list, with no words of its own.
    const other = { start: "YES", help: keywords.help, optOut: keywords.optOut };
    const result = runLint([guardKeywordRule(other)], input.A);
    expect([...new Set(result.hits.map((found) => found.step))].sort()).toEqual(["A7-12", "A8-47", "S1-78"]);
    expect(result.hits.every((found) => found.text === "Yes" && found.fix === fix("YES"))).toBe(true);

    // A list with a blank word or with no opt-out word is refused: buttons cannot be judged without the guard's words.
    expect(() => runLint([guardKeywordRule({ ...other, help: " " })], input.A)).toThrow(LintError);
    expect(() => keywordReader({ ...keywords, optOut: [] })).toThrow(LintError);
  });
});
