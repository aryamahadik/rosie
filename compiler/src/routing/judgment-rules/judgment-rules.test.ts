// T-1050: the 67 numbered judgment rules (MC R6; DECISIONS.md D2; K-01 v1 routingTables.judgmentRules).
//   - each flow emits rules 1 to 67 by number: 1 to 59 from S13-23 to S13-29, 60 to 65 from S13-53, 66 and 67 from
//     S13-54, each rule its numbered line word for word;
//   - the emitted list validates against K-01 v1 (bundle.v1.schema.json judgmentRules) and is K-01's own fixture,
//     judgment-rules.json, byte for byte: the emitter's stand-in (emit/standins.ts) holds the same bytes;
//   - every 'judgment rule N' or 'rule N' reference in master-A.json, master-B.json and the 243 trade files resolves to
//     its rule: 0 unresolved, the 87 'judgment rule N' pointers of the two flow files included (39 in master-A.json, 48
//     in master-B.json);
//   - a flow whose rule nodes do not hold the 67 where R6 puts them is refused.
// The reference side is not the module under test: the flow files as written (JSON.parse), K-01's schema and fixture
// with Ajv as the contract harness sets it up, and the numbers MC R6 and D3 write out.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { correctedMaster } from "../../emit/flow";
import { standInJudgmentRules } from "../../emit/standins";
import type { FlowGraph, FlowLetter } from "../../graph/types.ts";
import { loadMaster } from "../../load/flow";
import { listTradeIds, loadTrade, TRADE_DIR, type TradeOp } from "../../load/trade";
import { applyTrade } from "../../overlay/apply";
import {
  JUDGMENT_RULE_STEPS,
  JudgmentRuleError,
  compileJudgmentRules,
  compileTradeJudgmentRules,
  judgmentReferences,
  referencesIn,
  ruleReferences,
  rulesOfStep,
  type FoundReference,
  type JudgmentRules,
} from "./index";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const WORK = `${ROOT}fixtures/master/engine/work/`;
const FLOWS: readonly FlowLetter[] = ["A", "B"];

type Obj = Record<string, unknown>;

function readJson(path: string): Obj {
  return JSON.parse(readFileSync(path, "utf8")) as Obj;
}

const master = loadMaster();
const rules = { A: compileJudgmentRules(master.A), B: compileJudgmentRules(master.B) };
const fixture = readJson(`${ROOT}contracts/bundle/fixtures/judgment-rules.json`);

/** The numbers from `first` to `last`. */
function span(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, k) => first + k);
}

/** Where each number lives, as the flows write them (MC R6 gives 1 to 59 to S13-23 to S13-29 together). */
const BY_STEP: Readonly<Record<string, number[]>> = {
  "S13-23": span(1, 5),
  "S13-24": span(6, 15),
  "S13-25": span(16, 24),
  "S13-26": span(25, 27),
  "S13-27": span(28, 40),
  "S13-28": span(41, 52),
  "S13-29": span(53, 59),
  "S13-53": span(60, 65),
  "S13-54": span(66, 67),
};

describe("each flow's 67 judgment rules", () => {
  it.each(FLOWS)(
    "flow %s emits rules 1 to 67 by number: 1 to 59 from S13-23 to S13-29, 60 to 65 from S13-53, 66 and 67 from S13-54",
    (flow) => {
      const list = rules[flow].rules;
      expect(list.map((rule) => rule.number)).toEqual(span(1, 67));
      const r6 = (number: number): string[] =>
        number <= 59
          ? ["S13-23", "S13-24", "S13-25", "S13-26", "S13-27", "S13-28", "S13-29"]
          : number <= 65
            ? ["S13-53"]
            : ["S13-54"];
      for (const rule of list) expect(r6(rule.number), String(rule.number)).toContain(rule.step);
      for (const [step, numbers] of Object.entries(BY_STEP))
        expect(rulesOfStep(rules[flow], step).map((rule) => rule.number)).toEqual(numbers);
      expect([...new Set(list.map((rule) => rule.step))]).toEqual([...JUDGMENT_RULE_STEPS]);
    },
  );

  it.each(FLOWS)(
    "flow %s: each rule is its step's numbered line, word for word, without the number",
    (flow) => {
      const file = readJson(`${WORK}master/master-${flow}.json`) as { steps: Obj[] };
      const lines = (id: string): string[] =>
        (file.steps.find((step) => step.id === id)?.more as string[] | undefined) ?? [];
      for (const rule of rules[flow].rules) {
        expect(lines(rule.step), String(rule.number)).toContain(`${String(rule.number)}. ${rule.text}`);
        expect(rule.text).not.toMatch(/^\d/);
      }
      // S13-27's nine lines after rule 36 have no number: they belong to no numbered rule.
      const unnumbered = lines("S13-27").filter((line) => !/^\d+\. /.test(line));
      expect(unnumbered).toHaveLength(9);
      for (const line of unnumbered)
        expect(rules[flow].rules.some((rule) => rule.text.includes(line))).toBe(false);
    },
  );

  it("flows A and B hold the same 67 rules (the nine are shared steps)", () => {
    expect(rules.A).toEqual(rules.B);
    for (const id of JUDGMENT_RULE_STEPS) expect(master.sharedIds).toContain(id);
  });

  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  ajv.addSchema(readJson(`${ROOT}contracts/common/formats.v1.schema.json`));
  ajv.addSchema(readJson(`${ROOT}contracts/bundle/bundle.v1.schema.json`));
  const validate = ajv.getSchema(
    "https://rosie.invalid/contracts/bundle/bundle.v1.schema.json#/$defs/judgmentRules",
  );
  function accepted(value: unknown): string[] {
    if (validate === undefined) throw new Error("K-01 has no judgmentRules definition");
    if (validate(value) === true) return [];
    return (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
  }

  it.each(FLOWS)(
    "flow %s's list validates against K-01 v1 and is K-01's own judgment-rules.json, byte for byte",
    (flow) => {
      expect(accepted(rules[flow])).toEqual([]);
      expect(accepted(fixture)).toEqual([]);
      expect(rules[flow]).toEqual(fixture);
      expect(JSON.stringify(rules[flow])).toBe(JSON.stringify(fixture));
      // The emitter packs its stand-in until the compiled list is passed to it: the same bytes, so no bundle changes.
      expect(JSON.stringify(rules[flow])).toBe(JSON.stringify(standInJudgmentRules().value));
    },
  );

  it("K-01's check is not vacuous: 66 rules, a rule 68 or a rule from S13-30 is refused", () => {
    expect(accepted({ rules: rules.A.rules.slice(1) }).length).toBeGreaterThan(0);
    const [first, ...rest] = rules.A.rules;
    if (first === undefined) throw new Error("no rule 1");
    expect(accepted({ rules: [...rest, { ...first, number: 68 }] }).length).toBeGreaterThan(0);
    expect(accepted({ rules: [{ ...first, step: "S13-30" }, ...rest] }).length).toBeGreaterThan(0);
  });

  it.each(FLOWS)(
    "flow %s: the emitter's flow (corrected and slotted, emit/flow.ts) gives the same list",
    (flow) => {
      expect(compileTradeJudgmentRules(correctedMaster(master, flow))).toEqual(rules[flow]);
    },
  );

  it("a trade's flow keeps every number and step; only its rename pairs change words (aba, cpa, funeral, advisor)", () => {
    const changed: string[] = [];
    for (const id of ["aba", "cpa", "funeral", "advisor"]) {
      const trade = loadTrade(id);
      for (const flow of FLOWS) {
        const own = compileTradeJudgmentRules(applyTrade(master[flow], trade));
        expect(own.rules.map(({ number, step }) => ({ number, step }))).toEqual(
          rules[flow].rules.map(({ number, step }) => ({ number, step })),
        );
        own.rules.forEach((rule, k) => {
          if (rule.text !== rules[flow].rules[k]?.text) changed.push(`${id} ${flow} ${String(rule.number)}`);
        });
      }
    }
    expect(changed).toEqual([
      "funeral A 61",
      "funeral A 65",
      "funeral B 61",
      "funeral B 65",
      "advisor A 47",
      "advisor A 61",
    ]);
    const funeral = compileTradeJudgmentRules(applyTrade(master.A, loadTrade("funeral")));
    expect(funeral.rules[60]?.text).toBe(
      "The person served can't be reached before the visit, like in a hospital? Book it as a request. The director asks their yes in person.",
    );
  });

  it("no trade op touches the nine steps or writes a numbered line on a rule node: every trade keeps the 67", () => {
    const ids = listTradeIds();
    expect(ids).toHaveLength(243);
    const ruleNodes = new Set(
      FLOWS.flatMap((flow) =>
        Object.values(master[flow].steps)
          .filter((step) => step.kind === "rule")
          .map((step) => step.id),
      ),
    );
    const numbered = (op: TradeOp): string[] => {
      const lines: unknown[] = [];
      const deep = (value: unknown): void => {
        if (Array.isArray(value)) (value as unknown[]).forEach(deep);
        else if (typeof value === "object" && value !== null)
          for (const [key, inner] of Object.entries(value))
            if (key === "more" || key === "addMore") lines.push(...(inner as unknown[]));
            else deep(inner);
      };
      deep(op);
      return lines.filter((line): line is string => typeof line === "string" && /^\s*\d{1,3}\.\s/.test(line));
    };
    const found: string[] = [];
    for (const id of ids) {
      const trade = loadTrade(id);
      for (const flow of FLOWS)
        for (const op of trade.flows[flow].ops) {
          if (JUDGMENT_RULE_STEPS.includes(op.at)) found.push(`${id} ${flow} ${op.op} at ${op.at}`);
          if (ruleNodes.has(op.at) && numbered(op).length > 0)
            found.push(`${id} ${flow} numbered at ${op.at}`);
        }
    }
    expect(found).toEqual([]);
  });
});

describe("every reference resolves", () => {
  const files: [name: string, value: unknown][] = [
    ["master-A.json", readJson(`${WORK}master/master-A.json`)],
    ["master-B.json", readJson(`${WORK}master/master-B.json`)],
  ];
  for (const id of listTradeIds()) files.push([`${id}.json`, readJson(`${TRADE_DIR}${id}.json`)]);
  const found = new Map<string, FoundReference[]>(
    files.map(([name, value]) => [name, referencesIn(value, rules.A, name)]),
  );
  const of = (name: string): FoundReference[] => found.get(name) ?? [];
  const r6 = (name: string): FoundReference[] => of(name).filter((reference) => reference.form !== "home");

  it("every 'judgment rule N' or 'rule N' reference by R6's numbers (a pointer, a bare 'rule N', '<one of the nine> rule N') in both flow files and the 243 trade files resolves to its rule: 0 unresolved", () => {
    expect(files).toHaveLength(245);
    const unresolved = files.flatMap(([name]) =>
      r6(name)
        .filter((reference) => reference.problems.length > 0)
        .map((reference) => `${reference.path}: ${reference.words}`),
    );
    expect(unresolved).toEqual([]);
    for (const [name] of files)
      for (const reference of r6(name)) {
        expect(reference.rules.length, `${reference.path}: ${reference.words}`).toBeGreaterThan(0);
        for (const rule of reference.rules) expect(rules.A.rules).toContain(rule);
      }
  });

  it("the flow files' 87 'judgment rule N' pointers are all read: 39 in master-A.json, 48 in master-B.json", () => {
    // The reference count: the pointers as the flow files write them, found in the raw text.
    const raw = (name: string): number =>
      (readFileSync(`${WORK}master/${name}`, "utf8").match(/judgment rules? \d+/g) ?? []).length;
    expect(raw("master-A.json")).toBe(39);
    expect(raw("master-B.json")).toBe(48);
    const pointers = (name: string): FoundReference[] =>
      of(name).filter((reference) => reference.form === "judgment");
    expect(pointers("master-A.json")).toHaveLength(39);
    expect(pointers("master-B.json")).toHaveLength(48);
    expect(pointers("master-A.json").length + pointers("master-B.json").length).toBe(87);
    // Each in a step's more line, but one in each record's lint pointers ("judgment rules 16 to 24").
    const outside = (name: string): string[] =>
      pointers(name)
        .filter(
          (reference) =>
            !/^master-[AB]\.json\.steps\[\d+\](?:\.branches\[\d+\]\.steps\[\d+\])*\.more\[\d+\]$/.test(
              reference.path,
            ),
        )
        .map((reference) => `${reference.path}: ${reference.words}`);
    expect(outside("master-A.json")).toEqual([
      "master-A.json.record.lint.pointers[6]: judgment rules 16 to 24",
    ]);
    expect(outside("master-B.json")).toEqual([
      "master-B.json.record.lint.pointers[6]: judgment rules 16 to 24",
    ]);
    // The rules they name, with lists and ranges spread out: 77 numbers in master-A.json, 88 in master-B.json.
    const named = (name: string): number =>
      pointers(name).reduce((total, reference) => total + reference.rules.length, 0);
    expect(named("master-A.json")).toBe(77);
    expect(named("master-B.json")).toBe(88);
    // Read either way, the card's 87 is all here: the pointers of both flow files (39 + 48), or the rule numbers
    // master-A.json writes (77 by its 39 pointers, lists and ranges spread out, and 10 by its record's 'rule N' cites).
    const cites = of("master-A.json").filter(
      (reference) => reference.form === "bare" || reference.form === "home",
    );
    expect(cites.flatMap((reference) => reference.runs)).toHaveLength(10);
    expect(named("master-A.json") + cites.length).toBe(87);
    // Every rule number D3's templates use is there: 6 to 8, 9 to 11, 16 to 24, 25, 45 and 46, 53 to 58.
    const words = new Set(pointers("master-A.json").map((reference) => reference.words));
    for (const template of [
      "judgment rules 6 to 8",
      "judgment rules 9 to 11",
      "judgment rules 16 to 24",
      "judgment rule 25",
      "judgment rules 45 and 46",
      "judgment rules 53 to 58",
    ])
      expect(words).toContain(template);
  });

  it("the bare 'rule N' of each record's lint table is judgment rule 49 (its words are rule 49's); no trade file holds a reference", () => {
    for (const name of ["master-A.json", "master-B.json"]) {
      const bare = of(name).filter((reference) => reference.form === "bare");
      expect(bare.map((reference) => [reference.words, reference.rules.map((rule) => rule.number)])).toEqual([
        ["rule 49", [49]],
      ]);
      expect(bare[0]?.text).toBe(
        "a deadline is met by when the action is done; the owner may waive (S13-35, rule 49)",
      );
      expect(rules.A.rules[48]?.text.toLowerCase()).toBe(
        "a deadline is met by when the action is done; the owner may waive.",
      );
      expect(of(name).filter((reference) => reference.form === "step")).toEqual([]);
    }
    const trades = files.slice(2).filter(([name]) => of(name).length > 0);
    expect(trades.map(([name]) => name)).toEqual([]);
  });

  it("the 9 home cites of each record's lint table ('S13-55 rule 7') cite a rule of their own home step, never a judgment rule, and stand in no step", () => {
    // A step outside the nine numbers no rules (phase 5 HUB-READ.md 2.2), so these name no judgment rule: they are the
    // lint table's notes (record.lint.banned.phrases[].now, which L8 prints as "the rule now"), in no step.
    for (const name of ["master-A.json", "master-B.json"]) {
      const homes = of(name).filter((reference) => reference.form === "home");
      expect(homes.map((reference) => reference.words)).toEqual([
        "S13-55 rule 7",
        "S13-19 rule 4",
        "S13-32 rule 4",
        "S13-56 rule 3",
        "S13-56 rule 1",
        "S13-55 rule 9",
        "S13-56 rule 5",
        "S13-56 rule 5",
        "S13-55 rule 5",
      ]);
      for (const reference of homes) {
        expect(reference.path).toMatch(/\.record\.lint\.banned\.phrases\[\d+\]\.now$/);
        expect(reference.rules).toEqual([]);
        expect(JUDGMENT_RULE_STEPS).not.toContain(reference.step);
        const flow = master[name === "master-A.json" ? "A" : "B"];
        expect(flow.steps[String(reference.step)]?.kind).toBe("rule");
      }
    }
  });
});

describe("the reference forms", () => {
  const numbers = (text: string): number[][] =>
    judgmentReferences(text, rules.A).map((reference) => reference.rules.map((rule) => rule.number));

  it("reads D3's pointer lines, RULES.md's step forms and the decisions' hyphen ranges", () => {
    // DECISIONS.md D3's templates.
    expect(
      numbers("Unclear, late or off-topic answer: judgment rules 16 to 24. Safe default here: X."),
    ).toEqual([span(16, 24)]);
    expect(numbers("Read by meaning: judgment rules 6 to 8.")).toEqual([span(6, 8)]);
    expect(numbers("Stop words: judgment rules 45 and 46.")).toEqual([[45, 46]]);
    expect(numbers("Someone else asks: judgment rules 33, 35 and 36.")).toEqual([[33, 35, 36]]);
    expect(numbers("Silence: judgment rule 25.")).toEqual([[25]]);
    expect(numbers("Someone else books: judgment rules 60 to 65.")).toEqual([span(60, 65)]);
    // RULES.md's forms: with the step, and a comma before a bare rule.
    expect(numbers("(S13-23, rules 1 and 2)")).toEqual([[1, 2]]);
    expect(numbers("(S13-05, S13-28 rules 41 to 44)")).toEqual([span(41, 44)]);
    expect(numbers("(S13-27 rules 35 and 36, D35, D64)")).toEqual([[35, 36]]);
    expect(numbers("(S13-28 rule 48)")).toEqual([[48]]);
    // MC C6 and the cards: "S13-28 rule 51", "S13-54 rule 67", "judgment rule 25".
    expect(numbers("S13-28 rule 51; S13-54 rule 67; judgment rule 25")).toEqual([[51], [67], [25]]);
    // DECISIONS.md: hyphen ranges, a capital, a list after a range.
    expect(numbers("judgment rules 30-32")).toEqual([[30, 31, 32]]);
    expect(numbers("(M-065, N06; judgment rules 39-40, 57.)")).toEqual([[39, 40, 57]]);
    expect(numbers("Judgment rule 26: money is taken only on the person's yes")).toEqual([[26]]);
  });

  it("names the form and the step of each", () => {
    expect(
      ruleReferences(
        "Danger and welfare: S13-10 (judgment rules 9 to 11). (S13-35, rule 49) (D83, S13-19 rule 4) S13-28 rule 51, S13-55's rule 7",
      ).map(({ words, form, step }) => ({ words, form, step })),
    ).toEqual([
      { words: "judgment rules 9 to 11", form: "judgment", step: null },
      { words: "rule 49", form: "bare", step: null },
      { words: "S13-19 rule 4", form: "home", step: "S13-19" },
      { words: "S13-28 rule 51", form: "step", step: "S13-28" },
      { words: "S13-55's rule 7", form: "home", step: "S13-55" },
    ]);
  });

  it("reads no reference in words that hold none", () => {
    for (const text of [
      "Rosie's rule: a booking never changes just because nobody answered.",
      "Never guess a price, a time, a rule or a reason.",
      "The judgment rules come first. Then each rule has one home:",
      "A rule 3pm start, a rules 2nd look",
      "The court can overrule 5 objections.",
      "Changes go only to the right person (S13-45's one rule).",
    ])
      expect(ruleReferences(text), text).toEqual([]);
  });

  it("does not resolve a number outside 1 to 67, a number its step does not hold, a backward range or a home cite", () => {
    const problems = (text: string, list: JudgmentRules = rules.A): string[] =>
      judgmentReferences(text, list).flatMap((reference) =>
        reference.problems.map((problem) => `${problem.kind} ${problem.words}`),
      );
    expect(problems("judgment rule 0")).toEqual(["out-of-range 0"]);
    expect(problems("judgment rule 68")).toEqual(["out-of-range 68"]);
    expect(problems("judgment rules 66 to 68")).toEqual(["out-of-range 66 to 68"]);
    expect(problems("judgment rules 3 and 99")).toEqual(["out-of-range 99"]);
    expect(problems("judgment rule 1000")).toEqual(["out-of-range 1000"]);
    expect(problems("S13-28 rule 60")).toEqual(["unknown 60"]);
    expect(problems("judgment rules 24 to 16")).toEqual(["unknown 24 to 16"]);
    expect(problems("S13-32 rule 3")).toEqual(["unknown S13-32 rule 3"]);
    const without25 = { rules: rules.A.rules.filter((rule) => rule.number !== 25) };
    expect(problems("Silence: judgment rule 25.", without25)).toEqual(["unknown 25"]);
    expect(problems("judgment rules 1 to 67, S13-54 rule 67, rules 6-8")).toEqual([]);
  });
});

describe("what is refused", () => {
  /** A copy of flow A with `change` made to its steps by id. */
  function changed(change: (steps: FlowGraph["steps"]) => void): FlowGraph {
    const flow = structuredClone(master.A);
    change(flow.steps);
    return flow;
  }
  const more = (steps: FlowGraph["steps"], id: string): string[] => {
    const step = steps[id];
    if (step?.more === undefined) throw new Error(`${id} has no lines`);
    return step.more;
  };

  it("a rule missing, given twice or out of order", () => {
    const missing = changed((steps) => {
      more(steps, "S13-26").splice(0, 1);
    });
    expect(() => compileJudgmentRules(missing)).toThrow(/rule 25 is missing or out of order/);
    const twice = changed((steps) => {
      const lines = more(steps, "S13-26");
      lines.push(lines[0] ?? "");
    });
    expect(() => compileJudgmentRules(twice)).toThrow(/rule 25 is given twice/);
    const swapped = changed((steps) => {
      more(steps, "S13-23").reverse();
    });
    expect(() => compileJudgmentRules(swapped)).toThrow(/rule 1 is missing or out of order/);
    const last = changed((steps) => {
      more(steps, "S13-54").pop();
    });
    expect(() => compileJudgmentRules(last)).toThrow(/66 numbered rules, expected 67/);
  });

  it("a rule in a step R6 does not give it, or a numbered line in another rule node", () => {
    const moved = changed((steps) => {
      const line = more(steps, "S13-53").shift() ?? "";
      more(steps, "S13-29").push(line);
    });
    expect(() => compileJudgmentRules(moved)).toThrow(/S13-29 holds rule 60/);
    const other = changed((steps) => {
      more(steps, "S13-55").push("1. Money first.");
    });
    expect(() => compileJudgmentRules(other)).toThrow(/S13-55 has the numbered line/);
  });

  it("one of the nine steps missing, not a rule node, switched off or holding no numbered line", () => {
    const gone = structuredClone(master.A);
    gone.path = gone.path.filter((step) => step.id !== "S13-54");
    expect(() => compileJudgmentRules(gone)).toThrow(/S13-54 is not a rule node of the flow/);
    const plain = changed((steps) => {
      const step = steps["S13-53"];
      if (step !== undefined) delete step.kind;
    });
    expect(() => compileJudgmentRules(plain)).toThrow(/S13-53 is not a rule node of the flow/);
    const off = changed((steps) => {
      Object.assign(steps["S13-53"] ?? {}, { off: "not offered" });
    });
    expect(() => compileJudgmentRules(off)).toThrow(/S13-53 is switched off/);
    const empty = changed((steps) => {
      const step = steps["S13-54"];
      if (step !== undefined) step.more = ["Says only what's true."];
    });
    expect(() => compileJudgmentRules(empty)).toThrow(/S13-54 holds no numbered rule/);
    expect(() => compileJudgmentRules(empty)).toThrow(JudgmentRuleError);
  });
});
