// Contract test for K-02 v1, the model's contract (T-081; ops/plan/02-contracts.md K-02 "Contract test" and section 2
// item 12; contracts/model/README.md "Producers and consumers", "Named rules", "Stakes", "Danger words").
//
// This is the fixture part. The contract test has two parts: this one, which reads only the committed fixtures and the
// named rules file, and one part per producer or consumer side, added later by a QA side task that depends on this task
// and on that side's build task. SIDE_CHECKS (at the end) is the list where each side is added.
//
// What this part proves:
//   1. every fixture in contracts/model/fixtures/index.json is checked (the T-003 harness): an accepted one is accepted
//      by its $defs entry, a refused one is refused, none is left out. Two refused fixtures pass the schema and are
//      refused by the named rule their index entry gives (optionOffered, quoteInText), run on the paired fixture exactly
//      as contracts/scripts/check-fixtures.mjs runs it; each rule fires on its fixture and only on that one, and holds
//      on the accepted pairs;
//   2. the schema is not vacuous: removing any one required field from a copy of an accepted fixture makes the copy
//      refused, for that field; each refused fixture is refused for the one reason it shows (mend it and it is accepted);
//   3. what the schema cannot check and the fixtures can show, each also run on a damaged copy to show that it fires:
//      the context (a choice id once, the stakes rule, the meaning-search additions, the 30-day window of recent
//      messages, a fact once), the decide result (routing and reads in order, agreed read from the two reads, the
//      re-read before the one question, each part from a read), a context with its decide result (same turn and bundle,
//      the turn's stakes from the first read's pick), the safety result (tries, timeout marker, the lift of No to
//      Unsure, the safety line a danger word's kind gives) and the hand-off `about` of decide and planner.
//   What needs a producer or consumer side is on SIDE_CHECKS, not checked here (the gate, the frontier builder, the
//   model double, the re-parse of a value from its words and the rest of README "Contract test").

import { readFileSync, readdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { CONTRACTS_ROOT, checkContractFixtures, formatErrors, type FixtureEntry } from "./_harness";

// ---------------------------------------------------------------------------------------------------------------
// The fixtures and the rules

const MODEL_DIR = path.join(CONTRACTS_ROOT, "model");
const FIXTURES_DIR = path.join(MODEL_DIR, "fixtures");
const SCHEMA_FILE = "model.v1.schema.json";

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

const index = readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: RuleEntry[] };
const fixture = (file: string): unknown => readJson(path.join(FIXTURES_DIR, ...file.split("/")));
// A copy of a fixture, read as the shape a check reads (the fixture was checked against the schema first).
const contextOf = (file: string): Context => structuredClone(fixture(file)) as Context;
const decideOf = (file: string): Decide => structuredClone(fixture(file)) as Decide;
const safetyOf = (file: string): SafetyResult => structuredClone(fixture(file)) as SafetyResult;
const plannerOf = (file: string): Planner => structuredClone(fixture(file)) as Planner;
const readOf = (file: string): { parts: DecidePart[] } =>
  structuredClone(fixture(file)) as { parts: DecidePart[] };
const pinOf = (file: string): { bundleId: { hash: string } } =>
  structuredClone(fixture(file)) as { bundleId: { hash: string } };

/** An index entry; `rule` names a rule of model.rules.mjs (contracts/common/fixtures-index.meta.schema.json). */
type RuleEntry = FixtureEntry & { rule?: string };

/** A value a fixture must hold; the fixtures are checked against the schema first, so a miss is a broken test. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("a fixture lacks a value this test reads");
  return value;
}

// What the checks read. The fixtures are checked against the schema first (part 1), so a cast to these shapes reads
// only fields the schema requires.
interface PartField {
  name: string;
  value: unknown;
  words: string;
}
interface DecidePart {
  verb: string;
  quote: string;
  question?: string;
  choice?: string;
  fields?: PartField[];
  questions?: string[];
  unclear?: string;
  why?: string;
  words?: string;
  reason?: string;
  about?: string;
}
interface Read {
  model: string;
  role: string;
  output: { language: string; parts: DecidePart[] };
}
interface Decide {
  turnId: string;
  bundleId: { hash: string; build: number };
  stakes: "high" | "low";
  routing: { first: string; second: string };
  reads: Read[];
  agreed: boolean;
  reread: boolean;
  language: string | null;
  parts: { part: DecidePart; outcome: string }[];
}
interface StakesReason {
  why: string;
  step: string | null;
  ref: string | null;
}
interface Choice {
  choiceId: string;
  kind: string;
  question: string | null;
  stakes: "high" | "low";
  stakesFrom: StakesReason[];
  fields: { name: string; type: string }[];
}
interface Context {
  turnId: string;
  bundleId: { hash: string; build: number };
  flow: string;
  texts: { words: string; sentAt: { utc: string } }[];
  openQuestions: { openQuestionId: string }[];
  choices: Choice[];
  facts: { name: string }[];
  alwaysOn: { flow: string };
  recentMessages: { sentAt: { utc: string } }[];
  meaningSearch: { added: string[]; index: string } | null;
}
interface SafetyResult {
  eventId: string;
  source: string;
  tries: { model: string; result: string }[];
  read: { labels: { outcome: string; tense: string }[] } | null;
  timedOut: boolean;
  dangerWords: { words: string; list: string; kind: string }[];
  outcomes: string[];
  liftedToUnsure: boolean;
}
interface Planner {
  language: string;
  action: { verb: string; about?: string; facts?: string[] };
}
interface Pair {
  context: Context;
  decide: Decide;
}

type Rule = (pair: Pair) => string[];
const rulesFile = path.join(MODEL_DIR, "model.rules.mjs");
const { rules } = (await import(pathToFileURL(rulesFile).href)) as { rules: Record<string, Rule> };
const rule = (name: string): Rule => must(rules[name]);

// Fixtures the checks read, by the pair they form: a context and the decide result made from it.
const PAIRS: readonly { context: string; decide: string }[] = [
  { context: "context-s1-02.json", decide: "decide-s1-02-choose.json" },
  { context: "context-two-requests.json", decide: "decide-two-requests.json" },
];
const CONTEXTS = PAIRS.map((pair) => pair.context);
const DECIDES = index.fixtures
  .filter((entry) => entry.expect === "accept" && entry.def === "decideResult")
  .map((entry) => entry.file);
const SAFETIES = index.fixtures
  .filter((entry) => entry.expect === "accept" && entry.def === "safetyResult")
  .map((entry) => entry.file);
const PLANNERS = index.fixtures
  .filter((entry) => entry.expect === "accept" && entry.def === "plannerOutput")
  .map((entry) => entry.file);
const pairOf = (n: number): Pair => ({
  context: contextOf(must(PAIRS[n]).context),
  decide: decideOf(must(PAIRS[n]).decide),
});

// ---------------------------------------------------------------------------------------------------------------
// Checks that read only fixtures. Each returns one line per problem; an empty list means the check holds.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Context: README "Named rules" (a choice id once), "Stakes", arch 03 lines 181 and 189, arch 02 line 117. */
export function checkContext(context: Context): string[] {
  const problems: string[] = [];
  const ids = context.choices.map((choice) => choice.choiceId);
  for (const id of ids.filter((id, i) => ids.indexOf(id) !== i))
    problems.push(`the choice id ${id} appears twice`);
  if (context.choices.length > 60) problems.push(`${String(context.choices.length)} choices, over 60`);

  // Stakes (arch 01 line 79; README "Stakes"): high has its reasons and low none; one open question's options are all
  // high when any one is; a reason "question" names another option of the same question.
  const byQuestion = new Map<string, Choice[]>();
  for (const choice of context.choices) {
    if ((choice.stakes === "high") !== choice.stakesFrom.length > 0) {
      problems.push(
        choice.stakes === "high"
          ? `${choice.choiceId} is high but gives no reason`
          : `${choice.choiceId} is low but gives a reason`,
      );
    }
    if (choice.question !== null && (choice.kind === "option" || choice.kind === "hub")) {
      byQuestion.set(choice.question, [...(byQuestion.get(choice.question) ?? []), choice]);
    }
    for (const reason of choice.stakesFrom) {
      if (reason.why !== "question") continue;
      const other = context.choices.find((candidate) => candidate.choiceId === reason.ref);
      if (other === undefined || other.choiceId === choice.choiceId || other.question !== choice.question) {
        problems.push(
          `${choice.choiceId} is high because of ${String(reason.ref)}, which is no other option of its question`,
        );
      } else if (other.stakes !== "high") {
        problems.push(
          `${choice.choiceId} is high because ${other.choiceId} is, but ${other.choiceId} is low`,
        );
      }
    }
  }
  for (const [question, options] of byQuestion) {
    const high = options.filter((option) => option.stakes === "high").length;
    if (high > 0 && high < options.length)
      problems.push(`the options of ${question} are not all high, though ${String(high)} of them is`);
  }

  // An option names an open question of the context (arch 01 line 63).
  const questions = new Set(context.openQuestions.map((question) => question.openQuestionId));
  for (const choice of context.choices) {
    if (choice.kind === "option" && (choice.question === null || !questions.has(choice.question)))
      problems.push(
        `${choice.choiceId} is an option of ${String(choice.question)}, which is no open question here`,
      );
  }

  // Meaning search's additions are the choices of kind searchEntry, and no other (arch 03 line 189).
  const entries = context.choices.filter((choice) => choice.kind === "searchEntry").map((c) => c.choiceId);
  const added = context.meaningSearch?.added ?? [];
  if (!isDeepStrictEqual([...entries].sort(), [...added].sort()))
    problems.push(
      `meaning search added [${added.join(", ")}], but the search-entry choices are [${entries.join(", ")}]`,
    );

  // Each fact once (arch 02 line 117).
  const names = context.facts.map((fact) => fact.name);
  for (const name of names.filter((name, i) => names.indexOf(name) !== i))
    problems.push(`the fact ${name} is given twice`);

  // The turn's texts, oldest first (arch 02 line 113); the recent messages, at most 6, up to 30 days old, none after the
  // turn's last text (arch 03 line 181).
  const sent = context.texts.map((text) => Date.parse(text.sentAt.utc));
  if (sent.some((time, i) => i > 0 && time < must(sent[i - 1])))
    problems.push("the texts are not oldest first");
  const last = Math.max(...sent);
  if (context.recentMessages.length > 6)
    problems.push(`${String(context.recentMessages.length)} recent messages, over 6`);
  for (const message of context.recentMessages) {
    const at = Date.parse(message.sentAt.utc);
    if (at < last - 30 * DAY_MS)
      problems.push(`a recent message from ${message.sentAt.utc} is over 30 days old`);
    if (at > last) problems.push(`a recent message from ${message.sentAt.utc} is after the turn's last text`);
  }
  if (context.alwaysOn.flow !== context.flow)
    problems.push(
      `the always-on prefix is flow ${context.alwaysOn.flow}, the turn's flow is ${context.flow}`,
    );
  return problems;
}

/** What two reads must agree on: every choice and every field value (arch 02 line 119), not the free words. */
function signature(part: DecidePart): unknown {
  return {
    verb: part.verb,
    question: part.question,
    choice: part.choice,
    fields: part.fields?.map((field) => ({ name: field.name, value: field.value })),
    questions: part.questions === undefined ? undefined : [...part.questions].sort(),
    about: part.about,
  };
}
const readsAgree = (a: Read, b: Read): boolean =>
  isDeepStrictEqual(a.output.parts.map(signature), b.output.parts.map(signature));

/** Decide result: arch 02 line 119; arch 06 lines 285 to 289 (Q-26, Q-41); README "Verbs and what code checks". */
export function checkDecide(decide: Decide): string[] {
  const problems: string[] = [];
  const [first, check, reread] = decide.reads;
  if (first === undefined || check === undefined) return ["a decide result has fewer than two reads"];

  // Routing (arch 02 line 119): Haiku twice on low stakes; on high stakes Sonnet first with Haiku checking (Q-26's
  // default, which a later answer changes as data in new fixtures, never in these).
  const wanted =
    decide.stakes === "low" ? { first: "haiku", second: "haiku" } : { first: "sonnet", second: "haiku" };
  if (!isDeepStrictEqual(decide.routing, wanted))
    problems.push(
      `${decide.stakes} stakes route ${wanted.first} then ${wanted.second}, not ${decide.routing.first} then ${decide.routing.second}`,
    );
  if (first.role !== "first" || first.model !== decide.routing.first)
    problems.push("the first read is not the routing's first model in the role first");
  if (check.role !== "check" || check.model !== decide.routing.second)
    problems.push("the second read is not the routing's second model in the role check");
  if (decide.reread) {
    if (reread?.role !== "reread" || reread.model !== "sonnet")
      problems.push("a re-read is the third read, by Sonnet, in the role reread");
    if (decide.reads.length !== 3) problems.push("a re-read ran, but there are not three reads");
  } else if (decide.reads.length !== 2) {
    problems.push("no re-read ran, but there are not two reads");
  }

  // agreed is what the first and check reads really did, on every choice and every field value.
  if (decide.agreed !== readsAgree(first, check))
    problems.push(
      `agreed is ${String(decide.agreed)}, but the two reads ${decide.agreed ? "differ" : "agree"}`,
    );
  // A difference is never a commit: the re-read runs first (Q-41), so one question follows a re-read only.
  if (!decide.agreed && !decide.reread) problems.push("the reads differ and no re-read ran");
  if (decide.parts.some((entry) => entry.outcome === "oneQuestion") && !decide.reread)
    problems.push("a part ends in one question, but no re-read ran first");

  // The language the reads agreed on, or null (CQ-07).
  const language = first.output.language === check.output.language ? first.output.language : null;
  if (decide.language !== language)
    problems.push(`the language is ${String(decide.language)}, the reads give ${String(language)}`);

  // Each part is a part one of the reads returned; with no re-read the parts are the first read's, all going ahead.
  const returned = decide.reads.flatMap((read) => read.output.parts);
  for (const [k, entry] of decide.parts.entries()) {
    if (!returned.some((part) => isDeepStrictEqual(part, entry.part)))
      problems.push(`parts[${String(k)}] is a part no read returned`);
  }
  if (!decide.reread) {
    if (
      !isDeepStrictEqual(
        decide.parts.map((entry) => entry.part),
        first.output.parts,
      )
    )
      problems.push("with no re-read, the parts are not the reads' agreed parts");
    if (decide.parts.some((entry) => entry.outcome !== "go"))
      problems.push("with no re-read, a part does not go ahead");
  }
  return problems;
}

/** The target question is high when the chosen choice, or any other option of its question, is (arch 01 line 79). */
function pickIsHigh(context: Context, decide: Decide): boolean {
  const first = decide.reads[0];
  for (const part of first?.output.parts ?? []) {
    if (part.verb !== "choose" && part.verb !== "enter") continue;
    const choice = context.choices.find((candidate) => candidate.choiceId === part.choice);
    if (choice === undefined) continue;
    if (choice.stakes === "high") return true;
    if (
      choice.question !== null &&
      context.choices.some((other) => other.question === choice.question && other.stakes === "high")
    )
      return true;
  }
  return false;
}

/** A context with its decide result: the same turn and bundle, and the turn's stakes from the first read's pick. */
export function checkPair({ context, decide }: Pair): string[] {
  const problems: string[] = [];
  if (decide.turnId !== context.turnId)
    problems.push(`the decide result is for ${decide.turnId}, the context for ${context.turnId}`);
  if (!isDeepStrictEqual(decide.bundleId, context.bundleId))
    problems.push("the decide result and the context are pinned to different bundles");
  const stakes = pickIsHigh(context, decide) ? "high" : "low";
  if (decide.stakes !== stakes)
    problems.push(`the turn's stakes are ${decide.stakes}, but the first read's pick makes them ${stakes}`);
  return problems;
}

/** The safety line a timed-out result gets with no read: arch 02 line 111, README "Danger words". */
export function safetyLineOnTimeout(result: SafetyResult): "988 and 911" | "911" | "outage line" {
  if (result.dangerWords.some((word) => word.kind === "selfHarm")) return "988 and 911";
  return result.dangerWords.length > 0 ? "911" : "outage line";
}

const LIFTING_TENSES = ["now", "could restart", "unknown"];

/** Safety result: arch 02 line 111, arch 06 line 283, README "Danger words and the safety line on a timeout". */
export function checkSafety(result: SafetyResult): string[] {
  const problems: string[] = [];
  // One 2 s try per model, Haiku then Sonnet; Sonnet is tried only when Haiku gave no verdict.
  const [haiku, sonnet] = result.tries;
  if (haiku?.model !== "haiku") problems.push("the first try is not Haiku");
  if (sonnet !== undefined && (sonnet.model !== "sonnet" || haiku?.result === "verdict"))
    problems.push("Sonnet is tried only after Haiku gave no verdict");
  const verdict = result.tries.some((attempt) => attempt.result === "verdict");
  if (result.timedOut === verdict)
    problems.push(
      `timedOut is ${String(result.timedOut)}, but the tries ${verdict ? "gave" : "gave no"} verdict`,
    );
  if ((result.read === null) === verdict)
    problems.push(
      `the read is ${result.read === null ? "null" : "set"}, but the tries ${verdict ? "gave" : "gave no"} verdict`,
    );

  const danger = result.dangerWords.length > 0;
  if (result.read === null) {
    // No verdict: a danger word counts as Unsure, none leaves the list empty and the outage line goes.
    if (!isDeepStrictEqual(result.outcomes, danger ? ["Unsure"] : []))
      problems.push("with no read, outcomes are Unsure with a danger word and empty without one");
    if (result.liftedToUnsure !== danger)
      problems.push(
        `liftedToUnsure is ${String(result.liftedToUnsure)}, with ${danger ? "a" : "no"} danger word`,
      );
  } else {
    // A danger word lifts No to Unsure only when the tense is now, could restart or unknown.
    const labels = result.read.labels;
    const lifts = labels.map(
      (label) => danger && label.outcome === "No" && LIFTING_TENSES.includes(label.tense),
    );
    const expected = labels.map((label, k) => (lifts[k] === true ? "Unsure" : label.outcome));
    if (!isDeepStrictEqual(result.outcomes, expected))
      problems.push(`outcomes are [${result.outcomes.join(", ")}], the labels give [${expected.join(", ")}]`);
    if (result.liftedToUnsure !== lifts.some(Boolean))
      problems.push(
        `liftedToUnsure is ${String(result.liftedToUnsure)}, the labels ${lifts.some(Boolean) ? "lift" : "lift none"}`,
      );
  }
  return problems;
}

/** Every hand_off of a decide result (the reads' and the parts') or planner output, with the `about` it carries. */
export function handOffsOf(value: Decide | Planner): { where: string; about: string | undefined }[] {
  if ("action" in value)
    return value.action.verb === "hand_off" ? [{ where: "action", about: value.action.about }] : [];
  const found: { where: string; about: string | undefined }[] = [];
  value.reads.forEach((read, r) => {
    read.output.parts.forEach((part, k) => {
      if (part.verb === "hand_off")
        found.push({ where: `reads[${String(r)}].output.parts[${String(k)}]`, about: part.about });
    });
  });
  value.parts.forEach((entry, k) => {
    if (entry.part.verb === "hand_off")
      found.push({ where: `parts[${String(k)}].part`, about: entry.part.about });
  });
  return found;
}

/** The hand-off code (C-104) routes on `about`, a closed list (arch 06 line 329; README "Verbs"). */
export function checkHandOffs(value: Decide | Planner): string[] {
  return handOffsOf(value)
    .filter((found) => found.about !== "ownerOrStaff" && found.about !== "other")
    .map((found) => `${found.where}: about is ${String(found.about)}, not ownerOrStaff or other`);
}

// ---------------------------------------------------------------------------------------------------------------
// The schema, one validator for everything (the harness's strict Ajv 2020-12 setup, with every error kept)

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
for (const folder of [path.join(CONTRACTS_ROOT, "common"), path.join(CONTRACTS_ROOT, "bundle"), MODEL_DIR]) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".schema.json"))
      ajv.addSchema(readJson(path.join(folder, entry.name)) as object);
  }
}
const schema = readJson(path.join(MODEL_DIR, SCHEMA_FILE)) as {
  $id: string;
  $defs: Record<string, { required?: string[] }>;
};

function validatorOf(def: string): ValidateFunction {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${def}`);
  if (validate === undefined) throw new Error(`no schema for ${def}`);
  return validate;
}
const accepts = (def: string, value: unknown): boolean => validatorOf(def)(value);

// ---------------------------------------------------------------------------------------------------------------
// 1. Every fixture of the index, checked by the T-003 harness, and the two refused by a named rule

// The harness checks the schema only: an entry that names a `rule` passes the schema and is refused by the rule, so the
// harness reports it as accepted-but-marked-refuse. Those entries are checked below by the rule; every other entry must
// be ok in the harness.
// The model schema $refs K-01's definitions (../bundle) and the shared formats, so both folders are shared schemas.
const report = checkContractFixtures("model", { sharedFolders: ["common", "bundle"] });
const ruled = (entry: RuleEntry): boolean => entry.rule !== undefined;
const accepted = index.fixtures.filter((entry) => entry.expect === "accept");
const refusedBySchema = index.fixtures.filter((entry) => entry.expect === "refuse" && !ruled(entry));
const refusedByRule = index.fixtures.filter((entry) => entry.expect === "refuse" && ruled(entry));

describe("model.v1 fixtures: the index and the count", () => {
  it("checks as many fixtures as fixtures/index.json lists, none left out", () => {
    expect(index.fixtures.length).toBeGreaterThan(0);
    expect(report.entries).toHaveLength(index.fixtures.length);
    expect(report.entries.map((entry) => entry.file)).toEqual(index.fixtures.map((entry) => entry.file));
    expect(report.seedRows).toBe(0);
    expect(report.problems).toEqual([]);
    expect(accepted.length + refusedBySchema.length + refusedByRule.length).toBe(index.fixtures.length);
  });

  it("accepts every entry marked accept and refuses every entry marked refuse, by the schema or by its rule", () => {
    expect(report.passes).toBe(accepted.length);
    expect(report.refusals).toBe(refusedBySchema.length);
    expect(refusedByRule.map((entry) => entry.rule)).toEqual(["optionOffered", "quoteInText"]);
    for (const result of report.entries) {
      const entry = must(index.fixtures.find((candidate) => candidate.file === result.file));
      if (ruled(entry)) {
        // Passes the schema (so the rule alone decides it); the harness's "must be refused" line is for the schema.
        expect(result.outcome, `${result.file} must pass the schema`).toBe("accepted");
        expect(entry.def, result.file).toBe("contextAndDecide");
      } else {
        expect(result.problems, result.file).toEqual([]);
        expect(result.outcome, result.file).toBe(result.expect === "accept" ? "accepted" : "refused");
      }
    }
  });

  it("holds every kind of fixture K-02 names", () => {
    const defs = new Set(index.fixtures.map((entry) => entry.def));
    for (const def of [
      "context",
      "decideResult",
      "safetyResult",
      "plannerOutput",
      "decideRead",
      "contextAndDecide",
    ])
      expect(defs.has(def), def).toBe(true);
    expect(index.fixtures.every((entry) => entry.version === "v1")).toBe(true);
    expect(accepted.length).toBeGreaterThan(0);
    expect(refusedBySchema.length + refusedByRule.length).toBeGreaterThan(0);
  });
});

describe("model.v1 fixtures: each entry", () => {
  for (const entry of accepted) {
    it(`accepts ${entry.file} (${String(entry.def)})`, () => {
      const validate = validatorOf(must(entry.def));
      expect(validate(fixture(entry.file)), formatErrors(validate.errors).join("; ")).toBe(true);
    });
  }
  for (const entry of refusedBySchema) {
    it(`refuses ${entry.file} by the schema (${String(entry.def)})`, () => {
      expect(accepts(must(entry.def), fixture(entry.file))).toBe(false);
    });
  }
  for (const entry of refusedByRule) {
    it(`refuses ${entry.file} by the rule ${String(entry.rule)}, after the schema takes it`, () => {
      const payload = fixture(entry.file) as Pair;
      expect(accepts(must(entry.def), payload), "the pair is valid JSON Schema").toBe(true);
      expect(rule(must(entry.rule))(payload).length).toBeGreaterThan(0);
    });
  }
});

describe("model.v1 fixtures: the named rules", () => {
  const optionNotOffered = fixture("invalid/refuse-option-not-offered.json") as Pair;
  const quoteNotInText = fixture("invalid/refuse-quote-not-in-text.json") as Pair;

  it("optionOffered fires on its fixture, naming the choice, and quoteInText passes it", () => {
    const problems = rule("optionOffered")(optionNotOffered);
    expect(problems.length).toBeGreaterThan(0);
    for (const line of problems) expect(line).toContain("c-99");
    expect(problems.join("\n")).toContain("which the context's choices do not hold");
    expect(rule("quoteInText")(optionNotOffered)).toEqual([]);
  });

  it("quoteInText fires on its fixture, naming the quote, and optionOffered passes it", () => {
    const problems = rule("quoteInText")(quoteNotInText);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain('"Barbershop and plumbing"');
    expect(rule("optionOffered")(quoteNotInText)).toEqual([]);
  });

  for (const [n, pair] of PAIRS.entries()) {
    it(`both rules hold on the accepted pair ${pair.context} with ${pair.decide}`, () => {
      const accepted = pairOf(n);
      expect(accepts("contextAndDecide", accepted)).toBe(true);
      expect(rule("optionOffered")(accepted)).toEqual([]);
      expect(rule("quoteInText")(accepted)).toEqual([]);
    });
  }

  // The damaged copies: each clause of a rule, fired on an accepted pair that is otherwise unchanged.
  const everyPart = (decide: Decide): DecidePart[] => [
    ...decide.reads.flatMap((read) => read.output.parts),
    ...decide.parts.map((entry) => entry.part),
  ];
  const chooseOf = (decide: Decide): DecidePart =>
    must(everyPart(decide).find((part) => part.verb === "choose"));

  it("optionOffered: a choice not offered, a verb the kind does not take, a wrong question, a field not carried, an ask about no question, a repeated id", () => {
    const missing = pairOf(0);
    for (const part of everyPart(missing.decide)) part.choice = "c-99";
    expect(rule("optionOffered")(missing).join("\n")).toContain(
      "chooses c-99, which the context's choices do not hold",
    );
    expect(rule("quoteInText")(missing)).toEqual([]);

    const verb = pairOf(0);
    for (const part of everyPart(verb.decide)) {
      part.verb = "enter";
      delete part.question;
    }
    expect(rule("optionOffered")(verb).join("\n")).toContain(
      "enter takes door, anytime, searchEntry, but c-01 is option",
    );

    const question = pairOf(0);
    for (const part of everyPart(question.decide)) part.question = "oq-other";
    expect(rule("optionOffered")(question).join("\n")).toContain(
      "names the question oq-other, but c-01 answers oq-s1-02",
    );

    const field = pairOf(0);
    for (const part of everyPart(field.decide))
      must(part.fields)[0] = { ...must(must(part.fields)[0]), name: "nope" };
    expect(rule("optionOffered")(field).join("\n")).toContain("the field nope is not one c-01 carries");

    const ask = pairOf(0);
    ask.decide.parts[0] = {
      part: { verb: "ask", quote: "Barbershop", questions: ["oq-nowhere"], unclear: "x" },
      outcome: "go",
    };
    expect(rule("optionOffered")(ask).join("\n")).toContain(
      "asks about oq-nowhere, which no offered choice answers",
    );

    const twice = pairOf(0);
    must(twice.context.choices[1]).choiceId = "c-01";
    expect(rule("optionOffered")(twice).join("\n")).toContain("the choice id c-01 appears twice");
  });

  it("quoteInText: a quote, a field's words, and pass_on's and redact's words not found in the texts", () => {
    const quote = pairOf(0);
    chooseOf(quote.decide).quote = "Barbershop and plumbing";
    expect(rule("quoteInText")(quote).join("\n")).toContain(
      'the quote "Barbershop and plumbing" is not in the turn\'s texts',
    );
    expect(rule("optionOffered")(quote)).toEqual([]);

    const words = pairOf(0);
    must(chooseOf(words.decide).fields)[0] = { name: "kinds", value: "x", words: "Hairdresser" };
    expect(rule("quoteInText")(words).join("\n")).toContain(
      'the words "Hairdresser" of the field kinds are not in the turn\'s texts',
    );

    for (const verb of ["pass_on", "redact"]) {
      const other = pairOf(0);
      other.decide.parts[0] = { part: { verb, quote: "Barbershop", words: "Hairdresser" }, outcome: "go" };
      expect(rule("quoteInText")(other).join("\n")).toContain(
        'the words "Hairdresser" are not in the turn\'s texts',
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The schema is not vacuous

const required = (def: string): string[] => schema.$defs[def]?.required ?? [];

describe("model.v1 fixtures: removing a required field makes an accepted fixture refused", () => {
  for (const entry of accepted) {
    it(`${entry.file} (${String(entry.def)})`, () => {
      const def = must(entry.def);
      const validate = validatorOf(def);
      const original = fixture(entry.file) as Record<string, unknown>;
      expect(validate(original), formatErrors(validate.errors).join("; ")).toBe(true);
      expect(required(def).length, "the schema requires at least one field here").toBeGreaterThan(0);
      for (const field of required(def)) {
        expect(field in original, `${entry.file} has the required field ${field}`).toBe(true);
        const copy = Object.fromEntries(
          Object.entries(structuredClone(original)).filter(([key]) => key !== field),
        );
        expect(validate(copy), `${entry.file} without ${field} must be refused`).toBe(false);
        expect(
          validate.errors?.some(
            (error) => error.keyword === "required" && error.params.missingProperty === field,
          ),
          `${entry.file} without ${field} must be refused for that field`,
        ).toBe(true);
      }
    });
  }

  it("also in the nested parts the contract names: a field's words, a hand-off's about, a danger word's kind, a read's role", () => {
    // `pick` returns the nested object of the copy whose key is removed; the whole copy is then refused.
    const refusedWithout = <V>(
      def: string,
      value: V,
      pick: (copy: V) => object | undefined,
      key: string,
    ): void => {
      expect(accepts(def, value), `${def} is accepted whole`).toBe(true);
      Reflect.deleteProperty(must(pick(value)), key);
      expect(accepts(def, value), `${def} without ${key} must be refused`).toBe(false);
    };
    const handOff = decideOf("decide-hand-off.json");
    refusedWithout("decideResult", handOff, (d) => must(d.reads[0]).output.parts[0], "about");
    const ownerOrStaff = decideOf("decide-hand-off-owner-or-staff.json");
    refusedWithout("decideResult", ownerOrStaff, (d) => d.parts[0]?.part, "about");
    const choose = decideOf("decide-s1-02-choose.json");
    refusedWithout(
      "decideResult",
      choose,
      (d) => must(must(d.reads[0]).output.parts[0]).fields?.[0],
      "words",
    );
    refusedWithout("decideResult", decideOf("decide-s1-02-choose.json"), (d) => d.reads[0], "role");
    refusedWithout("plannerOutput", plannerOf("planner-hand-off.json"), (p) => p.action, "about");
    const selfHarm = safetyOf("safety-timeout-self-harm-word.json");
    refusedWithout("safetyResult", selfHarm, (s) => s.dangerWords[0], "kind");
    const otherWord = safetyOf("safety-timeout-danger-word.json");
    refusedWithout("safetyResult", otherWord, (s) => s.dangerWords[0], "list");
  });
});

describe("model.v1 fixtures: each refused fixture is refused for the one reason it shows", () => {
  it("refuse-unknown-verb.json is accepted once its verb is one of the eight", () => {
    const read = readOf("invalid/refuse-unknown-verb.json");
    expect(must(read.parts[0]).verb).toBe("book");
    must(read.parts[0]).verb = "choose";
    expect(accepts("decideRead", read)).toBe(true);
  });
  it("refuse-value-without-words.json is accepted once the field has its words", () => {
    const read = readOf("invalid/refuse-value-without-words.json");
    const field = must(must(must(read.parts[0]).fields)[0]);
    expect(field.words).toBe("");
    field.words = "Saturday at 2";
    expect(accepts("decideRead", read)).toBe(true);
  });
  it("refuse-planner-books.json is accepted once its verb is one of the five", () => {
    const planner = plannerOf("invalid/refuse-planner-books.json");
    expect(planner.action.verb).toBe("book");
    planner.action.verb = "answer";
    expect(accepts("plannerOutput", planner)).toBe(true);
  });
  it("refuse-over-60-choices.json is accepted once it has 60 choices", () => {
    const context = contextOf("invalid/refuse-over-60-choices.json");
    expect(context.choices).toHaveLength(61);
    context.choices.pop();
    expect(accepts("context", context)).toBe(true);
  });
  it("the two refused by a rule are refused by that rule alone", () => {
    for (const entry of refusedByRule) {
      const pair = fixture(entry.file) as Pair;
      const other = must(Object.keys(rules).find((name) => name !== entry.rule));
      expect(rule(must(entry.rule))(pair), entry.file).not.toEqual([]);
      expect(rule(other)(pair), `${entry.file} passes ${other}`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. What the schema cannot check, read from the fixtures

describe("model.v1 fixtures: the contexts", () => {
  for (const file of CONTEXTS) {
    it(`${file}: a choice id once, the stakes rule, the meaning-search additions, the window of recent messages, a fact once`, () => {
      expect(checkContext(contextOf(file))).toEqual([]);
    });
  }
  it("shows low stakes with no reason in every choice (v1 fixtures hold no high choice; the high side is on SIDE_CHECKS)", () => {
    for (const file of CONTEXTS)
      for (const choice of contextOf(file).choices) {
        expect(choice.stakes, `${file} ${choice.choiceId}`).toBe("low");
        expect(choice.stakesFrom, `${file} ${choice.choiceId}`).toEqual([]);
      }
  });
  it("pins every context and decide result to the bundle id of one of K-01's sample bundles", () => {
    const bundleHashes = ["bundle-v0-skeleton.json", "bundle-mini-a.json", "bundle-mini-b.json"].map(
      (file) =>
        (
          readJson(path.join(CONTRACTS_ROOT, "bundle", "fixtures", file)) as {
            manifest: { bundleId: { hash: string } };
          }
        ).manifest.bundleId.hash,
    );
    const pinned = [...CONTEXTS, ...DECIDES].map((file) => pinOf(file).bundleId.hash);
    expect(pinned.length).toBeGreaterThan(0);
    for (const hash of pinned) expect(bundleHashes).toContain(hash);
  });
});

describe("model.v1 fixtures: the decide results", () => {
  it("shows seven of the eight verbs between the accepted decide fixtures (enter has none: a side task adds one)", () => {
    const verbs = new Set(
      DECIDES.flatMap((file) =>
        decideOf(file).reads.flatMap((read) => read.output.parts.map((part) => part.verb)),
      ),
    );
    expect([...verbs].sort()).toEqual([
      "ask",
      "choose",
      "hand_off",
      "no_op",
      "none_fits",
      "pass_on",
      "redact",
    ]);
  });
  for (const file of DECIDES) {
    it(`${file}: routing and reads in order, agreed from the two reads, the re-read before the one question, every part from a read`, () => {
      expect(checkDecide(decideOf(file))).toEqual([]);
    });
  }
  it("holds the stakes of the high-stakes fixtures: Sonnet reads first and Haiku checks", () => {
    for (const file of [
      "decide-bare-2.json",
      "decide-poll-vote.json",
      "decide-tapback-asks-which.json",
      "decide-reads-disagree.json",
    ]) {
      const decide = decideOf(file);
      expect(decide.stakes, file).toBe("high");
      expect(decide.routing, file).toEqual({ first: "sonnet", second: "haiku" });
    }
  });
  it("shows a disagreement: the reads differ, the one Sonnet re-read ran, and the part ends in one question", () => {
    const decide = decideOf("decide-reads-disagree.json");
    expect(decide.agreed).toBe(false);
    expect(decide.reread).toBe(true);
    expect(decide.parts.map((entry) => entry.outcome)).toEqual(["oneQuestion"]);
  });
});

describe("model.v1 fixtures: a context with its decide result", () => {
  for (const [n, pair] of PAIRS.entries()) {
    it(`${pair.context} with ${pair.decide}: the same turn and bundle, the turn's stakes from the first read's pick`, () => {
      const made = pairOf(n);
      expect(checkContext(made.context)).toEqual([]);
      expect(checkDecide(made.decide)).toEqual([]);
      expect(checkPair(made)).toEqual([]);
    });
  }
});

describe("model.v1 fixtures: the safety results", () => {
  for (const file of SAFETIES) {
    it(`${file}: tries, timeout marker, the lift of No to Unsure`, () => {
      expect(checkSafety(safetyOf(file))).toEqual([]);
    });
  }
  it("gives the safety line on a timeout by each danger word's kind: 911 for other, 988 and 911 for selfHarm", () => {
    const other = safetyOf("safety-timeout-danger-word.json");
    expect(other.timedOut).toBe(true);
    expect(other.dangerWords.map((word) => word.kind)).toEqual(["other"]);
    expect(safetyLineOnTimeout(other)).toBe("911");
    const selfHarm = safetyOf("safety-timeout-self-harm-word.json");
    expect(selfHarm.timedOut).toBe(true);
    expect(selfHarm.dangerWords.map((word) => word.kind)).toEqual(["selfHarm"]);
    expect(safetyLineOnTimeout(selfHarm)).toBe("988 and 911");
    expect(other.outcomes).toEqual(["Unsure"]);
    expect(selfHarm.outcomes).toEqual(["Unsure"]);
  });
  it("shows both kinds, both lists, and a danger word that does not lift No (its tense is over)", () => {
    const words = SAFETIES.flatMap((file) => safetyOf(file).dangerWords);
    expect(new Set(words.map((word) => word.kind))).toEqual(new Set(["selfHarm", "other"]));
    expect(new Set(words.map((word) => word.list))).toEqual(new Set(["general", "plugin"]));
    const over = safetyOf("safety-over-gas-leak.json");
    expect(over.dangerWords).not.toEqual([]);
    expect(over.outcomes).toEqual(["No"]);
    expect(over.liftedToUnsure).toBe(false);
  });
  it("covers the eight outcomes of A3-22 between the accepted safety fixtures", () => {
    const outcomes = new Set(SAFETIES.flatMap((file) => safetyOf(file).outcomes));
    for (const outcome of [
      "No",
      "An emergency",
      "Crisis words",
      "A threat to staff or others",
      "Harm to a child or older adult",
      "Unsafe at home",
      "Needs the business's own line",
      "Unsure",
    ])
      expect(outcomes.has(outcome), outcome).toBe(true);
  });
});

describe("model.v1 fixtures: the hand-offs name whom they are about", () => {
  it("decide-hand-off.json is about other, decide-hand-off-owner-or-staff.json and planner-hand-off.json about ownerOrStaff", () => {
    expect(handOffsOf(decideOf("decide-hand-off.json")).map((found) => found.about)).toEqual([
      "other",
      "other",
      "other",
    ]);
    expect(handOffsOf(decideOf("decide-hand-off-owner-or-staff.json")).map((found) => found.about)).toEqual([
      "ownerOrStaff",
      "ownerOrStaff",
      "ownerOrStaff",
    ]);
    expect(handOffsOf(plannerOf("planner-hand-off.json")).map((found) => found.about)).toEqual([
      "ownerOrStaff",
    ]);
  });
  it("holds in every accepted decide and planner fixture", () => {
    for (const file of DECIDES) expect(checkHandOffs(decideOf(file)), file).toEqual([]);
    for (const file of PLANNERS) expect(checkHandOffs(plannerOf(file)), file).toEqual([]);
  });
});

// Each check above, run on a damaged copy of a sample: a check that never fires proves nothing.
describe("model.v1 fixtures: each check fires on a damaged copy", () => {
  const high: StakesReason = { why: "charge", step: "S11-12", ref: "deposit" };

  it("context: a repeated choice id, a high choice with no reason, a low one with a reason, a split question, a lone search entry, a repeated fact, a stale message", () => {
    const twice = pairOf(0).context;
    must(twice.choices[1]).choiceId = "c-01";
    expect(checkContext(twice)).toEqual(["the choice id c-01 appears twice"]);

    const noReason = pairOf(0).context;
    must(noReason.choices[0]).stakes = "high";
    const lines = checkContext(noReason);
    expect(lines).toContain("c-01 is high but gives no reason");
    expect(lines.join("\n")).toContain("the options of oq-s1-02 are not all high, though 1 of them is");

    const reasonOnLow = pairOf(0).context;
    must(reasonOnLow.choices[0]).stakesFrom = [high];
    expect(checkContext(reasonOnLow)).toEqual(["c-01 is low but gives a reason"]);

    const split = pairOf(0).context;
    must(split.choices[0]).stakes = "high";
    must(split.choices[0]).stakesFrom = [high];
    expect(checkContext(split)).toEqual(["the options of oq-s1-02 are not all high, though 1 of them is"]);

    const dangling = pairOf(0).context;
    for (const choice of dangling.choices.slice(0, 3)) {
      choice.stakes = "high";
      choice.stakesFrom = [{ why: "question", step: null, ref: "c-09" }];
    }
    expect(checkContext(dangling).join("\n")).toContain(
      "c-01 is high because of c-09, which is no other option of its question",
    );

    const search = pairOf(0).context;
    must(search.choices[3]).kind = "searchEntry";
    expect(checkContext(search).join("\n")).toContain(
      "meaning search added [], but the search-entry choices are [c-04]",
    );
    search.meaningSearch = { added: ["c-04"], index: "x" };
    expect(checkContext(search)).toEqual([]);

    const fact = pairOf(1).context;
    fact.facts.push(must(fact.facts[0]));
    expect(checkContext(fact).join("\n")).toContain("is given twice");

    const stale = pairOf(0).context;
    must(stale.recentMessages[0]).sentAt.utc = "2026-08-01T00:00:00Z";
    expect(checkContext(stale).join("\n")).toContain("over 30 days old");
    must(stale.recentMessages[0]).sentAt.utc = "2026-11-01T00:00:00Z";
    expect(checkContext(stale).join("\n")).toContain("is after the turn's last text");

    const prefix = pairOf(0).context;
    prefix.alwaysOn.flow = "B";
    expect(checkContext(prefix).join("\n")).toContain("the always-on prefix is flow B");

    const order = pairOf(0).context;
    order.texts.push({ ...must(order.texts[0]), sentAt: { utc: "2026-10-19T14:00:00Z" } });
    expect(checkContext(order)).toContain("the texts are not oldest first");
  });

  it("decide: routing, roles, agreed, the re-read before the one question, language, a part no read returned", () => {
    const routing = pairOf(0).decide;
    routing.stakes = "high";
    expect(checkDecide(routing).join("\n")).toContain(
      "high stakes route sonnet then haiku, not haiku then haiku",
    );

    const role = pairOf(0).decide;
    must(role.reads[1]).role = "reread";
    expect(checkDecide(role).join("\n")).toContain(
      "the second read is not the routing's second model in the role check",
    );

    const agreed = pairOf(0).decide;
    agreed.agreed = false;
    expect(checkDecide(agreed).join("\n")).toContain("agreed is false, but the two reads agree");

    const differ = pairOf(0).decide;
    must(must(differ.reads[1]).output.parts[0]).choice = "c-02";
    expect(checkDecide(differ).join("\n")).toContain("agreed is true, but the two reads differ");
    differ.agreed = false;
    expect(checkDecide(differ).join("\n")).toContain("the reads differ and no re-read ran");

    const reread = decideOf("decide-reads-disagree.json");
    reread.reads.pop();
    expect(checkDecide(reread).join("\n")).toContain("a re-read ran, but there are not three reads");
    reread.reread = false;
    expect(checkDecide(reread).join("\n")).toContain("a part ends in one question, but no re-read ran first");

    const unmade = decideOf("decide-reads-disagree.json");
    must(unmade.parts[0]).part.unclear = "made up";
    expect(checkDecide(unmade).join("\n")).toContain("parts[0] is a part no read returned");

    const language = pairOf(0).decide;
    language.language = "es";
    expect(checkDecide(language).join("\n")).toContain("the language is es, the reads give en");
    must(language.reads[1]).output.language = "es";
    expect(checkDecide(language).join("\n")).toContain("the language is es, the reads give null");

    const stopped = pairOf(0).decide;
    must(stopped.parts[0]).outcome = "oneQuestion";
    expect(checkDecide(stopped).join("\n")).toContain("with no re-read, a part does not go ahead");
  });

  it("a context with its decide result: another turn, another bundle, stakes that do not follow the pick", () => {
    const turn = pairOf(0);
    turn.decide.turnId = "turn-other";
    expect(checkPair(turn)).toEqual([
      "the decide result is for turn-other, the context for turn-s1-02-sam-kinds",
    ]);

    const bundle = pairOf(0);
    bundle.decide.bundleId.build = 2;
    expect(checkPair(bundle)).toEqual(["the decide result and the context are pinned to different bundles"]);

    const pick = pairOf(0);
    for (const choice of pick.context.choices.slice(0, 3)) {
      choice.stakes = "high";
      choice.stakesFrom = [high];
    }
    expect(checkPair(pick)).toEqual(["the turn's stakes are low, but the first read's pick makes them high"]);
    pick.decide.stakes = "high";
    expect(checkPair(pick)).toEqual([]);

    const sibling = pairOf(0);
    must(sibling.context.choices[1]).stakes = "high";
    expect(checkPair(sibling)).toEqual([
      "the turn's stakes are low, but the first read's pick makes them high",
    ]);
  });

  it("safety: tries, the timeout marker, the lift of No to Unsure, the line by kind", () => {
    const timeout = safetyOf("safety-timeout-danger-word.json");
    const noOutcome = structuredClone(timeout);
    noOutcome.outcomes = [];
    expect(checkSafety(noOutcome).join("\n")).toContain(
      "with no read, outcomes are Unsure with a danger word",
    );
    const noLift = structuredClone(timeout);
    noLift.liftedToUnsure = false;
    expect(checkSafety(noLift).join("\n")).toContain("liftedToUnsure is false, with a danger word");
    const bare = structuredClone(timeout);
    bare.dangerWords = [];
    expect(checkSafety(bare).join("\n")).toContain(
      "with no read, outcomes are Unsure with a danger word and empty without one",
    );
    expect(safetyLineOnTimeout(bare)).toBe("outage line");

    const marker = structuredClone(timeout);
    marker.timedOut = false;
    expect(checkSafety(marker).join("\n")).toContain("timedOut is false, but the tries gave no verdict");

    const tries = structuredClone(timeout);
    must(tries.tries[0]).model = "sonnet";
    expect(checkSafety(tries)).toContain("the first try is not Haiku");

    const kind = safetyOf("safety-timeout-self-harm-word.json");
    must(kind.dangerWords[0]).kind = "other";
    expect(safetyLineOnTimeout(kind)).toBe("911");

    const lifted = safetyOf("safety-unknown-tense.json");
    lifted.dangerWords = [];
    lifted.read = { labels: [{ outcome: "No", tense: "now" }] };
    lifted.outcomes = ["No"];
    expect(checkSafety(lifted)).toEqual([]);
    lifted.dangerWords = [{ words: "fire", list: "general", kind: "other" }];
    expect(checkSafety(lifted).join("\n")).toContain("outcomes are [No], the labels give [Unsure]");
    expect(checkSafety(lifted).join("\n")).toContain("liftedToUnsure is false, the labels lift");
    lifted.outcomes = ["Unsure"];
    lifted.liftedToUnsure = true;
    expect(checkSafety(lifted)).toEqual([]);
    must(must(lifted.read).labels[0]).tense = "over";
    expect(checkSafety(lifted).join("\n")).toContain("outcomes are [Unsure], the labels give [No]");

    const verdict = safetyOf("safety-no.json");
    verdict.tries = [
      { model: "haiku", result: "verdict" },
      { model: "sonnet", result: "verdict" },
    ];
    expect(checkSafety(verdict)).toContain("Sonnet is tried only after Haiku gave no verdict");
  });

  it("hand-offs: an about that is neither ownerOrStaff nor other, or none", () => {
    const decide = decideOf("decide-hand-off.json");
    must(must(decide.reads[0]).output.parts[0]).about = "someone";
    expect(checkHandOffs(decide)).toEqual([
      "reads[0].output.parts[0]: about is someone, not ownerOrStaff or other",
    ]);
    delete must(decide.parts[0]).part.about;
    expect(checkHandOffs(decide).join("\n")).toContain("parts[0].part: about is undefined");

    const planner = plannerOf("planner-hand-off.json");
    delete planner.action.about;
    expect(checkHandOffs(planner)).toEqual(["action: about is undefined, not ownerOrStaff or other"]);
  });

  it("the schema: the stakes rule, an about, a danger word's kind, a re-read, the timeout marker", () => {
    // README "Stakes": the schema refuses a high choice without a reason and a low one with any.
    const context = contextOf("context-s1-02.json");
    expect(accepts("context", context)).toBe(true);
    must(context.choices[0]).stakes = "high";
    expect(accepts("context", context), "high with no reason").toBe(false);
    must(context.choices[0]).stakesFrom = [high];
    expect(accepts("context", context), "high with a reason").toBe(true);
    must(context.choices[0]).stakes = "low";
    expect(accepts("context", context), "low with a reason").toBe(false);

    // The hand-off `about` is the closed list of two, on decide's hand-off and on the planner's.
    for (const about of ["ownerOrStaff", "other"]) {
      const decide = decideOf("decide-hand-off.json");
      for (const part of [
        must(decide.reads[0]).output.parts[0],
        must(decide.reads[1]).output.parts[0],
        must(decide.parts[0]).part,
      ])
        must(part).about = about;
      expect(accepts("decideResult", decide), about).toBe(true);
      const planner = plannerOf("planner-hand-off.json");
      planner.action.about = about;
      expect(accepts("plannerOutput", planner), about).toBe(true);
    }
    const decide = decideOf("decide-hand-off.json");
    must(must(decide.reads[0]).output.parts[0]).about = "someone";
    expect(accepts("decideResult", decide), "decide about someone").toBe(false);
    const planner = plannerOf("planner-hand-off.json");
    planner.action.about = "someone";
    expect(accepts("plannerOutput", planner), "planner about someone").toBe(false);

    // A danger word's kind is selfHarm or other.
    const safety = safetyOf("safety-timeout-self-harm-word.json");
    for (const kind of ["selfHarm", "other"]) {
      must(safety.dangerWords[0]).kind = kind;
      expect(accepts("safetyResult", safety), kind).toBe(true);
    }
    must(safety.dangerWords[0]).kind = "crisis";
    expect(accepts("safetyResult", safety), "kind crisis").toBe(false);

    // A re-read is the third read; a timeout has no read and a verdict has one.
    const reread = decideOf("decide-reads-disagree.json");
    reread.reads.pop();
    expect(accepts("decideResult", reread), "reread with two reads").toBe(false);
    const two = decideOf("decide-s1-02-choose.json");
    two.reread = true;
    expect(accepts("decideResult", two), "re-read set with two reads").toBe(false);
    const timed = safetyOf("safety-timeout-danger-word.json");
    timed.read = { labels: [{ outcome: "No", tense: "now" }] };
    expect(accepts("safetyResult", timed), "timeout with a read").toBe(false);
    const verdict = safetyOf("safety-no.json");
    verdict.read = null;
    expect(accepts("safetyResult", verdict), "verdict with no read").toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The side list. Part two of the contract test: each producer and consumer side of K-02 v1 (02-contracts K-02
// "Contract test"; contracts/model/README.md "Producers and consumers"). A side is added by its own QA side task,
// which depends on this task and on that side's build task and is planned by the lane that builds the side: the task
// sets `check` on its entry (a function that returns one line per problem, empty when the side holds) and nothing
// else here changes. An entry without `check` is a side whose task has not run yet; it is listed, never skipped.

export interface SideCheck {
  /** A short id for the side. */
  id: string;
  side: "producer" | "consumer";
  /** The role that builds the side. */
  owner: string;
  /** The components, spelled as the README's "Producers and consumers" spells them. */
  components: string;
  /** What the side's check does, so the QA side task knows what to build. */
  needs: string;
  /** Set by the side's QA task. */
  check?: () => string[];
}

export const SIDE_CHECKS: readonly SideCheck[] = [
  {
    id: "producer-ai",
    side: "producer",
    owner: "AI engineer",
    components: "C-113, C-114, C-115, C-116, C-117",
    needs:
      "The safety read, the context bundle, decide's two reads, the Sonnet re-read and the planner give outputs the schema accepts, on the fixtures' inputs and through the recorded-model double; the checks above hold on what they produce (routing and reads in order, agreed from the two reads, the re-read before the one question, the lift of No to Unsure, the safety line by the danger word's kind); a value re-parses from its words; a date resolves from the send time in the visit's zone (limit 6); a fact appears once; the planner's facts name facts of the context; at most one question in a planner ask (C-092); the 30-day and 6-message window of recent messages is cut by code.",
  },
  {
    id: "producer-action-layer",
    side: "producer",
    owner: "action-layer engineer",
    components: "C-075, C-079",
    needs:
      "The frontier builder gives the choices, stakes and facts as the context fixtures write them: stakes high for a charge, refund or calendarWrite on the walk, a recordWrite of booked or of a money key, or the any-time row cancel or move, and every option of a question high when one is (README 'Stakes'; no v1 fixture holds a high choice, so this side adds one); a choice it cannot walk is high with the reason unknown; at most 60 choices, a which-booking choice over 60; the meaning-search fallback adds the 3 closest entry steps as searchEntry choices.",
  },
  {
    id: "consumer-gate",
    side: "consumer",
    owner: "action-layer engineer",
    components: "C-080, C-083, C-087, C-104, C-110",
    needs:
      "The policy gate accepts every valid decide output of the fixtures and refuses the refused ones, the two named rules included (a choice not offered, a quote not in the texts, run through the gate and not the rules file); a high-stakes part needs an exact yes (limit 3); one commit per turn; the hand-off code routes on `about` alone (ownerOrStaff to Rosie's team that day, never the person named; other to the owner in text hours, then Rosie's team after 2 days) and never on the reason's words; the Agent API reads free text first.",
  },
  {
    id: "consumer-runtime",
    side: "consumer",
    owner: "runtime engineer",
    components: "C-047, C-174",
    needs:
      "The safety read on arrival takes the safety result of the fixtures: a timeout marker with a danger word counts as Unsure and gets the safety line by the kind of the words matched (911 for other, 988 and 911 for selfHarm), a timeout with none gets the outage line, and a danger word lifts No to Unsure only when the tense is now, could restart or unknown; the AI provider down or slow path reads the same results.",
  },
  {
    id: "consumer-integrations",
    side: "consumer",
    owner: "integrations engineer",
    components: "C-218",
    needs:
      "Nothing in v1 blocks photo reading's fields reaching Google Places in v1.1 (through K-15): the text attachments (attachmentId, mediaType) are read as the schema writes them. Added with the v1.1 task (F14, T-070).",
  },
  {
    id: "consumer-ai",
    side: "consumer",
    owner: "AI engineer",
    components: "C-123",
    needs:
      "The recorded-model double (T-004) replays only outputs of the shapes decideRead, safetyRead and plannerOutput, and refuses a recording that the schema refuses.",
  },
  {
    id: "consumer-qa",
    side: "consumer",
    owner: "QA and eval engineer",
    components: "C-139, C-140",
    needs:
      "The gold-set generator and the eval harness read and write gold labels in the shape of decideRead and safetyRead, and the fixtures here are what they are checked against.",
  },
];

describe("model.v1 sides: the list where each producer and consumer side is added", () => {
  const readme = readFileSync(path.join(MODEL_DIR, "README.md"), "utf8");

  it("names each side once, with its owner, its components and what its check does", () => {
    const ids = SIDE_CHECKS.map((side) => side.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SIDE_CHECKS.filter((side) => side.side === "producer")).toHaveLength(2);
    expect(SIDE_CHECKS.filter((side) => side.side === "consumer")).toHaveLength(5);
    for (const side of SIDE_CHECKS) {
      expect(side.owner, side.id).not.toBe("");
      expect(side.components, side.id).not.toBe("");
      expect(side.needs, side.id).not.toBe("");
    }
  });

  it("names every component the README's producers and consumers list", () => {
    const start = readme.indexOf("## Producers and consumers");
    const listed = readme.slice(start, readme.indexOf("- **Contract test**", start));
    expect(start).toBeGreaterThan(-1);
    const named = new Set(listed.match(/C-\d{3}/g));
    const held = new Set(SIDE_CHECKS.flatMap((side) => side.components.match(/C-\d{3}/g) ?? []));
    // C-120 (photo reading) is v1.1: the consumer-integrations entry holds its place, the README says so.
    for (const component of named) {
      if (component === "C-120") continue;
      expect(held.has(component), component).toBe(true);
    }
  });

  for (const side of SIDE_CHECKS) {
    if (side.check === undefined) continue;
    const check = side.check;
    it(`${side.side} side ${side.id}`, () => {
      expect(check()).toEqual([]);
    });
  }
});
