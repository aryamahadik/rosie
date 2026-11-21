// Contract test for K-09 v1.11 (T-1496, the S1-04 design ruling's card 27; DL-999): contracts/tool-api/README.md
// "v1.11 (T-1471)", its defaults 179 to 190, "Named rules, v1.11", "Fixtures, v1.11" and "Contract test, v1.11".
//
// tests/contract/tool-api.v1.test.ts selects the index's entries by version (DL-125), so v1.11's ten fixtures already
// join its generic checks: each against its own version's schema and the rule its entry names, every required field,
// and an accepted one accepted by every later minor version. This file is v1.11's own part, as the README's
// "Contract test, v1.11" lists it:
//   1. the version: tool-api.v1.11.schema.json holds every v1.10 definition by $ref and nothing else, so every earlier
//      accepted fixture is accepted by v1.11 (each checked here at its own $defs entry); the index holds exactly the
//      ten fixtures the README names for v1.11, each against its definition and its named rule, and the two accepted
//      commit fixtures pass buttonsAnswerCommit as well as the givesStepKeys their entries name;
//   2. the table (default 180): BUTTONS_OPTIONS is the README's table row for row; its labels are S1-04's buttons in
//      bundle v1 (bundles/v1/bundle/flow/A.json) and in the master's record (fixtures/master's master-A.json), in
//      order, and its Means-line definition is bundle v1's; S1_08_TERM_LINES are those lines of S1-08's card in the
//      master's record, at their places (default 186);
//   3. build-frontier-s1-04.json's labels are S1-04's buttons in bundle v1, word for word, read from the bundle and
//      never typed here; the check fails on a copy with one label changed;
//   4. the README's statements, modeled here from its words (defaults 179 to 183 and 189, the limits of "Fixtures,
//      v1.11", the walk's rows and ids of defaults 131 and 181, `written` by K-05 v1.18 item 77's names), hold on the
//      accepted fixtures, agree with the rules, and each fires on a damaged copy;
//   5. each refused fixture is refused by its rule for its one fault: it differs from the accepted twin its entry and
//      the README name only there, and put right it passes the schema and the rule and is that twin;
//   6. the two rules fire on the damaged copies the README names, each still taken by the schema;
//   7. the security review's copies (a pick's or a text row's `set` carrying a column other than company_id and
//      business_id): default 182's columns, modeled in part 4, refuse them, and what buttonsAnswerCommit answers on them
//      is held here and reported (README: the rule holds what is set, not what else is; a rule that refuses them comes
//      under a new name, if the lead cards one).
//
// The card's proof that the label check fails on a copy: with TOOL_API_FRONTIER_S1_04 set to a copy of
// build-frontier-s1-04.json kept outside the repo, part 3's first test reads that copy instead of the fixture. Unset,
// as always in CI, it reads the fixture the index lists.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { CONTRACTS_ROOT, REPO_ROOT, formatErrors, type FixtureEntry } from "./_harness";

// ---------------------------------------------------------------------------------------------------------------
// The files

const TOOL_API_DIR = path.join(CONTRACTS_ROOT, "tool-api");
const FIXTURES_DIR = path.join(TOOL_API_DIR, "fixtures");
/** Every schema's $id is this base plus its path inside contracts/ (ADR-005; contracts/scripts/lib.mjs). */
const ID_BASE = "https://rosie.invalid/contracts/";
const VERSION = "v1.11";
const PREVIOUS = "v1.10";
/** Bundle v1's flow A: S1-04's buttons there are the frontier's labels (README default 179, "Fixtures, v1.11"). */
const BUNDLE_V1_FLOW_A = path.join(REPO_ROOT, "bundles", "v1", "bundle", "flow", "A.json");
/** The master's record, fixture set v1's copy (compiler/src/load/flow.ts reads the same file). */
const MASTER_A = path.join(REPO_ROOT, "fixtures", "master", "engine", "work", "master", "master-A.json");
const FRONTIER = "build-frontier-s1-04.json";
const COMMIT_ALL = "commit-s1-04.json";
const COMMIT_SOME = "commit-s1-04-some-share.json";
/** The card's proof only: a copy of build-frontier-s1-04.json for part 3's first test to read. Never set in CI. */
const FRONTIER_COPY = process.env.TOOL_API_FRONTIER_S1_04;

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** A value a file must hold; a miss is a broken test, never a refusal. */
function must<T>(value: T | null | undefined, what = "a value this test reads"): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const sorted = (values: readonly string[]): string[] => [...values].sort();

/** An index entry; `rule` names a rule of tool-api.rules.mjs (contracts/common/fixtures-index.meta.schema.json). */
type Entry = FixtureEntry & { rule?: string };

const entries = (readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: Entry[] }).fixtures;
const ownEntries = entries.filter((entry) => entry.version === VERSION);
const entryOf = (file: string): Entry =>
  must(
    entries.find((candidate) => candidate.file === file),
    `the index entry of ${file}`,
  );
const fixture = (file: string): unknown => readJson(path.join(FIXTURES_DIR, ...file.split("/")));
const defOf = (entry: Entry): string => must(entry.def, `the $defs entry of ${entry.file}`);

/** A version's major and minor number: v1 is [1, 0], v1.11 is [1, 11]. */
function placeOf(version: string): [number, number] {
  const match = /^v(\d+)(?:\.(\d+))?$/.exec(version);
  if (match === null) throw new Error(`a version this test cannot place: ${version}`);
  return [Number(match[1]), Number(match[2] ?? "0")];
}
const [MAJOR, MINOR] = placeOf(VERSION);
/** The accepted fixtures of every version before v1.11 (BP 6.4: a minor version only adds). */
const earlierAccepted = entries.filter((entry) => {
  const [major, minor] = placeOf(entry.version);
  return entry.expect === "accept" && major === MAJOR && minor < MINOR;
});

// ---------------------------------------------------------------------------------------------------------------
// The schemas and the validators (the strict Ajv 2020-12 setup of contracts/scripts/lib.mjs)

/** Every `$ref` string in a schema. */
function refsIn(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(refsIn);
  if (!isObj(node)) return [];
  return Object.entries(node).flatMap(([key, child]) =>
    key === "$ref" && typeof child === "string" ? [child] : refsIn(child),
  );
}

/** The schema files K-09's own schemas reach by $ref, transitively (contracts-relative), with their schemas. */
function reachedSchemas(): Map<string, Obj> {
  const reached = new Map<string, Obj>();
  const visit = (relative: string): void => {
    if (reached.has(relative)) return;
    const schema = readJson(path.join(CONTRACTS_ROOT, ...relative.split("/"))) as Obj;
    if (schema.$id !== `${ID_BASE}${relative}`)
      throw new Error(`${relative} has the $id ${JSON.stringify(schema.$id)}`);
    reached.set(relative, schema);
    for (const ref of refsIn(schema)) {
      const target = new URL(ref, `${ID_BASE}${relative}`);
      target.hash = "";
      if (!target.href.startsWith(ID_BASE)) throw new Error(`${relative} refers outside contracts/: ${ref}`);
      visit(target.href.slice(ID_BASE.length));
    }
  };
  for (const name of readdirSync(TOOL_API_DIR).sort()) {
    if (name.endsWith(".schema.json")) visit(`tool-api/${name}`);
  }
  return reached;
}

const SCHEMAS = reachedSchemas();
const strictAjv = new Ajv2020({ strict: true, strictRequired: false });
for (const schema of SCHEMAS.values()) strictAjv.addSchema(structuredClone(schema));

const schemaFileOf = (version: string): string => `tool-api/tool-api.${version}.schema.json`;
const schemaOf = (version: string): Obj => must(SCHEMAS.get(schemaFileOf(version)), schemaFileOf(version));

/** The validator of `version`'s schema at its $defs entry `def`. */
function validatorFor(version: string, def: string): ValidateFunction {
  const target = `${ID_BASE}${schemaFileOf(version)}#/$defs/${def}`;
  return must(strictAjv.getSchema(target), `the schema ${target}`);
}
/** Whether v1.11's schema takes `value` at `def`, with its errors when it does not. */
function takenByV111(def: string, value: unknown): { ok: boolean; why: string } {
  const validate = validatorFor(VERSION, def);
  const ok = validate(value);
  return { ok, why: formatErrors(validate.errors).join("; ") };
}

// Compile every validator the checks call while the file loads, so no single test carries Ajv's compile time on a
// loaded machine (a resource guard, not part of any check). A schema that cannot be had is left to its test.
for (const def of new Set([...earlierAccepted, ...ownEntries].map((entry) => entry.def))) {
  try {
    if (def !== undefined) validatorFor(VERSION, def);
  } catch {
    // Reported by the test that calls validatorFor again.
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The named rules and the tables v1.11 adds (tool-api.rules.mjs)

type Rule = (exchange: unknown) => string[];
interface FieldDef {
  name: string;
  type: string;
}
interface OptionRow {
  label: string;
  definition: string;
  definitionFrom: string;
  fields: readonly FieldDef[];
}
interface ButtonsTable {
  tells: string;
  asks: string;
  options: readonly OptionRow[];
}
const rulesModule = (await import(pathToFileURL(path.join(TOOL_API_DIR, "tool-api.rules.mjs")).href)) as {
  rules: Record<string, Rule>;
  STEP_GIVES: Record<string, readonly string[]>;
  BUTTONS_OPTIONS: Record<string, ButtonsTable | undefined>;
  S1_08_TERM_LINES: readonly { index: number; words: string }[];
};
const { rules, BUTTONS_OPTIONS, S1_08_TERM_LINES } = rulesModule;
const rule = (name: string): Rule => must(rules[name], `the rule ${name}`);
const tableOf = (step: string): ButtonsTable => must(BUTTONS_OPTIONS[step], `BUTTONS_OPTIONS["${step}"]`);
const S1_04 = "S1-04";

// ---------------------------------------------------------------------------------------------------------------
// What the checks read. The fixtures are checked against the schema first (part 1), so a cast to these shapes reads
// only fields the schema gives them.

interface Caller {
  kind: string;
  turnId: string | null;
  requestId: string;
  businessId: string | null;
  personId: string | null;
  traceId: string;
}
interface Target {
  businessId: string | null;
  bookingId: string | null;
}
interface Choice {
  kind: string;
  choiceId: string;
  question: string | null;
  step?: string;
  label?: string;
  branch: string | null;
  definition?: string;
  fields: FieldDef[];
  stakes: string;
  stakesFrom: unknown[];
  target?: Target;
}
interface SeenQuestion {
  openQuestionId: string;
  step: string;
  target: Target;
}
interface Context {
  openQuestions: SeenQuestion[];
  choices: Choice[];
  cards: { step?: string }[];
  facts: unknown[];
  texts: { words?: string }[];
}
interface FieldValue {
  name: string;
  value: unknown;
  words: string;
}
interface DecidedPart {
  part: { verb: string; question?: string | null; choice?: string | null; fields?: FieldValue[] };
  outcome: string;
}
interface StateWrite {
  op: string;
  table: string;
  values?: Obj;
  key?: Obj;
  expectVersion?: number;
  set?: Obj;
}
interface QuestionNew {
  id: string;
  step: string;
  options: unknown[];
  [column: string]: unknown;
}
interface OutboxNew {
  id: string;
  openQuestionId: string | null;
  [column: string]: unknown;
}
interface Written {
  table: string;
  rowId: string;
  version: number;
}
interface PartResult {
  part: number;
  choiceId: string | null;
  result: string;
  limits: { limit: number; result: string; outcome: string | null }[];
  gives: string[];
}
interface Frontier {
  call: string;
  outcome: { context: Context };
}
interface Commit {
  call: string;
  given: {
    stated: {
      step: string;
      gives: string[];
      writes: { state: StateWrite[]; openQuestions: QuestionNew[]; outboxRows: OutboxNew[] };
    };
  };
  request: {
    caller: Caller;
    turn: { id: string; handleId: string; service: string };
    input: { kind: string; decided: { context: Context; decide: { parts: DecidedPart[] } } };
  };
  outcome: {
    result: string;
    parts: PartResult[];
    written: { written: Written[]; outboxRows: { id: string; commitSeq: number }[] };
    openQuestions: { opened: string[]; closed: string[] };
  };
}

const frontierOf = (file: string): Frontier => structuredClone(fixture(file)) as Frontier;
const commitOf = (file: string): Commit => structuredClone(fixture(file)) as Commit;
/** The context a fixture's S1-04 choices sit in: buildFrontier's answer, or the context gateAndCommit was decided on. */
function contextOf(exchange: unknown): Context {
  const call = (exchange as { call: string }).call;
  return call === "buildFrontier"
    ? (exchange as Frontier).outcome.context
    : (exchange as Commit).request.input.decided.context;
}

// ---------------------------------------------------------------------------------------------------------------
// Paths into a JSON value

type Path = (string | number)[];

function getAt(value: unknown, where: Path): unknown {
  let node = value;
  for (const step of where) {
    if (Array.isArray(node) && typeof step === "number") node = node[step];
    else if (isObj(node) && typeof step === "string") node = node[step];
    else throw new Error(`no ${where.join(".")}`);
  }
  return node;
}

function setAt(value: unknown, where: Path, to: unknown): void {
  const parent = getAt(value, where.slice(0, -1));
  const last = must(where.at(-1));
  if (Array.isArray(parent) && typeof last === "number") parent[last] = to;
  else if (isObj(parent) && typeof last === "string") parent[last] = to;
  else throw new Error(`no ${where.join(".")}`);
}

/** The paths at which two values differ (a whole value where its kind or an array's length differs). */
function differences(a: unknown, b: unknown, at: Path = []): Path[] {
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((key) => differences(a[key], b[key], [...at, key]));
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length)
    return a.flatMap((item, k) => differences(item, b[k], [...at, k]));
  return isDeepStrictEqual(a, b) ? [] : [at];
}

const pointerOf = (where: Path): string => where.map((step) => `/${String(step)}`).join("");
/** Whether `where` lies at or under one of `places`. */
const under = (where: Path, places: Path[]): boolean =>
  places.some((place) => isDeepStrictEqual(where.slice(0, place.length), place));

// ---------------------------------------------------------------------------------------------------------------
// Bundle v1, the master's record and the README

const BUNDLE_V1 = readJson(BUNDLE_V1_FLOW_A) as { steps: Record<string, Obj | undefined> };
/** A step of bundle v1's flow A. */
const bundleStep = (step: string): Obj => must(BUNDLE_V1.steps[step], `${step} in bundle v1`);

/** The buttons of `step` in bundle v1: the one message of the step that carries buttons (K-01 `say[].elements`). */
function bundleButtons(step: string): string[] {
  const asked = (bundleStep(step).say as { elements?: { buttons?: string[] } }[]).flatMap(
    (message) => message.elements?.buttons ?? [],
  );
  if (asked.length === 0) throw new Error(`${step} carries no buttons in bundle v1`);
  return asked;
}

const MASTER = readJson(MASTER_A) as { steps: { id: string; say: unknown[][] }[] };
/** The elements of `step`'s messages in the master's record (each message is [from, to, words, elements?]). */
function masterElements(step: string): Obj[] {
  const found = must(
    MASTER.steps.find((candidate) => candidate.id === step),
    `${step} in master-A.json`,
  );
  return found.say.map((message) => message[3]).filter(isObj);
}

const README = readFileSync(path.join(TOOL_API_DIR, "README.md"), "utf8");
/** The README's text from `start` to the next `end` after it. */
function readmeBetween(start: string, end: string): string {
  const from = README.indexOf(start);
  if (from === -1) throw new Error(`the README has no "${start}"`);
  const to = README.indexOf(end, from + start.length);
  if (to === -1) throw new Error(`the README has no "${end}" after "${start}"`);
  return README.slice(from, to);
}

/** The body rows of the first Markdown table after `marker` in the README, each as its trimmed cells. */
function tableAfter(marker: string): string[][] {
  const start = README.indexOf(marker);
  if (start === -1) throw new Error(`the README has no "${marker}"`);
  const rows: string[][] = [];
  for (const line of README.slice(start).split("\n").slice(1)) {
    if (line.startsWith("|"))
      rows.push(
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim()),
      );
    else if (rows.length > 0) break;
  }
  return rows.slice(2);
}
const unquoted = (cell: string): string => cell.replace(/^'(.*)'$/s, "$1");

/** README default 180's table: each option's step, label, definition, where its words come from, and fields. */
const README_TABLE = tableAfter("180. **The table**").map((cells) => {
  const fields = must(cells[4]);
  const from = must(cells[3]);
  return {
    step: must(cells[0]),
    label: unquoted(must(cells[1])),
    definition: unquoted(must(cells[2])),
    definitionFrom: from.startsWith("declared")
      ? "declared"
      : from.includes("Means line")
        ? "meansLine"
        : `unread: ${from}`,
    fields:
      fields === "none"
        ? []
        : fields.split(", ").map((cell) => {
            const match = must(/^`(\w+)` \((\w+)\)$/.exec(cell), `a field cell "${cell}"`);
            return { name: must(match[1]), type: must(match[2]) };
          }),
  };
});

/** README default 186: each term line of S1-08's card, its number on the card, its K-01 index and its words. */
const README_TERM_LINES = [
  ...readmeBetween("186. **S1-08's four term lines**", "187. **").matchAll(
    /line (\d+) \(`lines\[(\d+)\]`\) "([^"]+)"/g,
  ),
].map((match) => ({ number: Number(match[1]), index: Number(match[2]), words: must(match[3]) }));

/** README "Fixtures, v1.11": the accepted fixtures with the rule each names, and each refused one with its twin. */
const README_FIXTURES = readmeBetween("### Fixtures, v1.11", "### Who reads v1.11");
const README_ACCEPTED = [...README_FIXTURES.matchAll(/`([\w-]+\.json)` \(rule `(\w+)`\)/g)].map((match) => ({
  file: must(match[1]),
  rule: must(match[2]),
}));
const README_TWINS = new Map<string, string>(
  README_FIXTURES.split("Of `")
    .slice(1)
    .flatMap((part) => {
      const twin = part.slice(0, part.indexOf("`"));
      return [...part.matchAll(/`(refuse-[\w-]+\.json)`/g)].map((match): [string, string] => [
        `invalid/${must(match[1])}`,
        twin,
      ]);
    }),
);

// ---------------------------------------------------------------------------------------------------------------
// The README's statements, modeled here from its words. Each returns one line per problem; an empty list means the
// statement holds.

/**
 * Bundle v1's S1-04 labels on a context (README default 179 and "Fixtures, v1.11": the labels are bundle v1's S1-04
 * buttons, word for word): the option choices of the open question at S1-04, in order, carry the buttons as their
 * label and their branch.
 */
export function labelProblems(context: Context): string[] {
  const question = context.openQuestions.find((candidate) => candidate.step === S1_04);
  if (question === undefined) return ["the context holds no open question at S1-04"];
  const buttons = bundleButtons(S1_04);
  const offered = context.choices.filter(
    (choice) => choice.kind === "option" && choice.question === question.openQuestionId,
  );
  const problems: string[] = [];
  const labels = offered.map((choice) => String(choice.label));
  const branches = offered.map((choice) => String(choice.branch));
  if (!isDeepStrictEqual(labels, buttons))
    problems.push(`the labels are [${labels.join(" | ")}], not bundle v1's buttons [${buttons.join(" | ")}]`);
  if (!isDeepStrictEqual(branches, buttons))
    problems.push(
      `the branches are [${branches.join(" | ")}], not bundle v1's buttons [${buttons.join(" | ")}]`,
    );
  return problems;
}

/**
 * README defaults 179 and 180: each open question at a step of the table is offered one option choice per button of
 * that step in bundle v1, in the buttons' order: label and branch the button, step the question's, definition and
 * fields the table's row for that button, stakes low with no reason (its own walk), target the question's, each with
 * its own id; and the context carries no step card for that step.
 */
export function optionChoiceProblems(context: Context): string[] {
  const problems: string[] = [];
  for (const question of context.openQuestions) {
    const table = BUTTONS_OPTIONS[question.step];
    if (table === undefined) continue;
    const buttons = bundleButtons(question.step);
    const offered = context.choices.filter(
      (choice) => choice.kind === "option" && choice.question === question.openQuestionId,
    );
    if (offered.length !== buttons.length) {
      problems.push(
        `${question.openQuestionId} is offered ${String(offered.length)} option choices, not one per button`,
      );
      continue;
    }
    buttons.forEach((button, at) => {
      const choice = must(offered[at]);
      const where = `${question.step} choice ${String(at + 1)} (${choice.choiceId})`;
      const row = table.options.find((option) => option.label === button);
      if (row === undefined) problems.push(`${question.step}'s button '${button}' has no row in the table`);
      if (choice.label !== button || choice.branch !== button)
        problems.push(`${where} is labelled '${String(choice.label)}', not the button '${button}'`);
      if (choice.step !== question.step) problems.push(`${where} names the step ${String(choice.step)}`);
      if (row !== undefined && choice.definition !== row.definition)
        problems.push(`${where} is not defined by the table's row for '${button}'`);
      if (row !== undefined && !isDeepStrictEqual(choice.fields, [...row.fields]))
        problems.push(`${where} does not carry the table's fields for '${button}'`);
      if (choice.stakes !== "low" || choice.stakesFrom.length > 0)
        problems.push(`${where} is not low with no reason`);
      if (!isDeepStrictEqual(choice.target, question.target))
        problems.push(`${where} names another target than its question`);
    });
    if (new Set(offered.map((choice) => choice.choiceId)).size !== offered.length)
      problems.push(`${question.openQuestionId}'s choices share an id`);
    if (context.cards.some((card) => card.step === question.step))
      problems.push(`${question.step} is a plain step, so the context carries no step card for it`);
  }
  return problems;
}

/** README default 131: a fixture writes the turn key as the handle's sample name, `sam` for `turn-s1-01-sam`. */
function turnKeyOf(turnId: string): string {
  return must(/^turn-s\d-\d{2}-(.+)$/.exec(turnId)?.[1], `the turn key of ${turnId}`);
}
const idStep = (step: string): string => step.toLowerCase();
/** The columns of `actual` that `expected` names, so one row can be compared with the fields a default states. */
const pick = (actual: Obj, expected: Obj): Obj =>
  Object.fromEntries(Object.keys(expected).map((column) => [column, actual[column]]));

/**
 * README defaults 179, 181 and 189 and "Fixtures, v1.11": the answer commits exactly one part, a choose of an option
 * choice of the step, sent to the gate by decide, whose fields are the choice's own with the turn's own words; limits 1
 * to 4 pass, limit 5 is not checked, and limit 6 is not checked on a choose with no field and passes otherwise; the
 * part gives the step's keys; the commit closes the question the choice names; the walk writes the next step's row,
 * which asks nothing, and opens the question of the step it stops at, with no options, no read-back and step 9's
 * clock, and its row, each to the turn's handle and person under the caller's business on the turn's service as a
 * quick reply, with default 131's ids; written names those outbox rows in that order; and each new company takes
 * default 182's id.
 */
export function answerProblems(exchange: Commit): string[] {
  const { stated } = exchange.given;
  const table = BUTTONS_OPTIONS[stated.step];
  if (table === undefined) return [`${stated.step} is no step of the table`];
  const { caller, turn } = exchange.request;
  const { context, decide } = exchange.request.input.decided;
  const { outcome } = exchange;
  if (exchange.call !== "gateAndCommit" || outcome.result !== "committed")
    return ["an answer is a gateAndCommit that committed"];
  const problems: string[] = [];
  const gives = rulesModule.STEP_GIVES[stated.step] ?? [];
  if (!isDeepStrictEqual(stated.gives, [...gives]))
    problems.push(`${stated.step} gives [${gives.join(", ")}], not [${stated.gives.join(", ")}]`);
  if (outcome.parts.length !== 1)
    problems.push(`the turn has ${String(outcome.parts.length)} parts, not the one that answers`);
  const result = must(outcome.parts[0], "the part that answers");
  const choice = context.choices.find((candidate) => candidate.choiceId === result.choiceId);
  if (choice?.kind !== "option" || choice.step !== stated.step)
    return [...problems, `the part names no option choice of ${stated.step}`];
  const sent = decide.parts[result.part];
  if (
    sent?.outcome !== "go" ||
    sent.part.verb !== "choose" ||
    sent.part.choice !== choice.choiceId ||
    sent.part.question !== choice.question
  )
    problems.push("decide sent the gate a choose of that choice, naming its question");
  const fields = sent?.part.fields ?? [];
  for (const field of fields) {
    if (!choice.fields.some((carried) => carried.name === field.name))
      problems.push(`the field ${field.name} is not one the choice carries`);
    if (!context.texts.some((text) => (text.words ?? "").includes(field.words)))
      problems.push(`the field ${field.name}'s words are not the turn's own words`);
  }
  const limits = [1, 2, 3, 4, 5, 6].map((limit) => ({
    limit,
    result: limit <= 4 || (limit === 6 && fields.length > 0) ? "pass" : "notChecked",
    outcome: null,
  }));
  if (!isDeepStrictEqual(result.limits, limits))
    problems.push(`the limits log ${JSON.stringify(result.limits)}, not what the gate gives this choose`);
  if (result.result !== "committed" || !isDeepStrictEqual(result.gives, stated.gives))
    problems.push(`the part that answers is committed and gives [${stated.gives.join(", ")}]`);
  if (!isDeepStrictEqual(outcome.openQuestions.closed, [choice.question]))
    problems.push(`the commit closes ${String(choice.question)} alone`);
  const key = turnKeyOf(turn.id);
  const askedId = `oq-${idStep(table.asks)}-${key}-1`;
  if (!isDeepStrictEqual(outcome.openQuestions.opened, [askedId]))
    problems.push(`the commit opens ${askedId} alone`);
  const { openQuestions, outboxRows, state } = stated.writes;
  const question: Obj = {
    id: askedId,
    handleId: turn.handleId,
    personId: caller.personId,
    businessId: caller.businessId,
    bookingId: null,
    step: table.asks,
    options: [],
    readback: null,
    clock: null,
  };
  if (openQuestions.length !== 1 || !isDeepStrictEqual(pick(must(openQuestions[0]), question), question))
    problems.push(`the walk opens ${table.asks}'s question, ${JSON.stringify(question)}, and no other`);
  const rowOf = (step: string, openQuestionId: string | null): Obj => ({
    id: `outbox-${idStep(step)}-${key}-1`,
    recipientHandleId: turn.handleId,
    recipientPersonId: caller.personId,
    businessId: caller.businessId,
    bookingId: null,
    channel: turn.service,
    sendClass: "quick_reply",
    openQuestionId,
    copyOfRowId: null,
  });
  const rows = [rowOf(table.tells, null), rowOf(table.asks, askedId)];
  if (
    outboxRows.length !== rows.length ||
    rows.some((row, at) => !isDeepStrictEqual(pick(must(outboxRows[at]), row), row))
  )
    problems.push(
      `the walk writes ${table.tells}'s row, asking nothing, then ${table.asks}'s row, as default 181 states`,
    );
  const listed = outcome.written.outboxRows.map((row) => row.id);
  if (
    !isDeepStrictEqual(
      listed,
      outboxRows.map((row) => row.id),
    )
  )
    problems.push(`written names the outbox rows [${listed.join(", ")}], not the stated ones`);
  state
    .filter((write) => write.table === "companies" && write.op === "insert")
    .forEach((write, at) => {
      const id = `company-${idStep(stated.step)}-${key}-${String(at + 1)}`;
      if (write.values?.id !== id) problems.push(`new company ${String(at + 1)} is not ${id}`);
    });
  return problems;
}

/** K-05 v1.18 item 77 (README default 181, open gap 150): the two columns each two-column row is named by. */
const TWO_COLUMN_NAMES: Record<string, readonly [string, string] | undefined> = {
  company_kinds: ["company_id", "kind_id"],
  picked_kind_texts: ["picked_kind_id", "pf_key"],
};

/** A state row's name in `written`: its id, or its two key columns' values joined by a slash. */
function rowNameOf(write: StateWrite): string {
  const columns = must(
    write.op === "insert" ? write.values : write.key,
    `the columns of a ${write.table} row`,
  );
  const pair = TWO_COLUMN_NAMES[write.table];
  if (pair !== undefined) return `${String(columns[pair[0]])}/${String(columns[pair[1]])}`;
  if (typeof columns.id === "string") return columns.id;
  throw new Error(`a ${write.table} row this test cannot name: add its key's columns from K-05 item 77`);
}

/**
 * The versioned rows a commit's stated writes name, in the order db/repo answers them (README default 181): the state
 * rows as stated (an insert at version 1, an update one after the version it expects), the questions opened (1), the
 * questions closed (at `closedVersion`) and each opened question's clock row (`clock-<question id>`, default 131: 1).
 */
function writtenOf(exchange: Commit, closedVersion: (id: string) => number): Written[] {
  const { state, openQuestions } = exchange.given.stated.writes;
  return [
    ...state.map((write) => ({
      table: write.table,
      rowId: rowNameOf(write),
      version: write.op === "insert" ? 1 : must(write.expectVersion) + 1,
    })),
    ...openQuestions.map((question) => ({ table: "open_questions", rowId: question.id, version: 1 })),
    ...exchange.outcome.openQuestions.closed.map((id) => ({
      table: "open_questions",
      rowId: id,
      version: closedVersion(id),
    })),
    ...openQuestions.map((question) => ({ table: "clock_rows", rowId: `clock-${question.id}`, version: 1 })),
  ];
}
const closedVersionIn =
  (exchange: Commit) =>
  (id: string): number =>
    exchange.outcome.written.written.find((row) => row.table === "open_questions" && row.rowId === id)
      ?.version ?? Number.NaN;
const writtenKey = (row: Written): string => `${row.table} ${row.rowId} @${String(row.version)}`;

/**
 * README default 181 ("`written`") and open gap 150: written names every versioned row the commit writes, each once at
 * the version it has after the write: one per state row of the stated writes (a two-column row by item 77's name),
 * each question opened, the question closed (once, past the version it was read at, so at least 2) and each opened
 * question's clock row; compared as a set, since K-05 freezes no order.
 */
export function writtenProblems(exchange: Commit): string[] {
  const listed = exchange.outcome.written.written;
  const problems: string[] = [];
  for (const id of exchange.outcome.openQuestions.closed) {
    const rows = listed.filter((row) => row.table === "open_questions" && row.rowId === id);
    if (rows.length !== 1 || must(rows[0]).version < 2)
      problems.push(`written names the closed question ${id} once, past the version read`);
  }
  const expected = sorted(writtenOf(exchange, closedVersionIn(exchange)).map(writtenKey));
  const actual = sorted(listed.map(writtenKey));
  for (const row of expected.filter((key) => !actual.includes(key))) problems.push(`written lacks ${row}`);
  for (const row of actual.filter((key) => !expected.includes(key)))
    problems.push(`written names ${row}, not stated`);
  if (new Set(actual).size !== actual.length) problems.push("written names a row twice");
  return problems;
}

/** The S1-04 tables whose rows take the business of a placed pick (README default 182 (4)). */
const PICK_ROWS = ["picked_kind_texts", "new_work_drafts", "new_work_draft_blocks"];

/**
 * README defaults 182 and 183, exact in words: a new company is inserted with its id, its owner, its name and no
 * business; a company on file is updated only in its name; a company kind is inserted with its company, kind, business,
 * trade name and its facts and switches; a pick is updated only in its company_id, and its business_id where its
 * company has one (the caller's business); a pick's text and draft rows only in their business_id, the caller's; and
 * a text row given a business is one of a pick placed with that business. Nothing else is written.
 */
export function setColumnProblems(exchange: Commit): string[] {
  const { state } = exchange.given.stated.writes;
  const business = exchange.request.caller.businessId;
  const problems: string[] = [];
  const columns = (row: Obj | undefined): string => sorted(Object.keys(row ?? {})).join(", ");
  const made = state
    .filter((write) => write.table === "companies" && write.op === "insert")
    .map((write) => String(write.values?.id));
  const gained = state
    .filter((write) => write.table === "picked_kinds" && write.set?.business_id !== undefined)
    .map((write) => String(write.key?.id));
  for (const write of state) {
    const name = rowNameOf(write);
    const expect = (wanted: string[], row: Obj | undefined): void => {
      if (columns(row) !== sorted(wanted).join(", "))
        problems.push(
          `the ${write.table} ${write.op} of ${name} sets [${columns(row)}], not [${sorted(wanted).join(", ")}]`,
        );
    };
    if (write.table === "companies" && write.op === "insert") {
      expect(["id", "owner_person_id", "name", "business_id"], write.values);
      if (write.values?.business_id !== null) problems.push(`the new company ${name} names a business`);
    } else if (write.table === "companies" && write.op === "update") {
      expect(["name"], write.set);
    } else if (write.table === "company_kinds" && write.op === "insert") {
      expect(
        ["company_id", "kind_id", "business_id", "trade_name", "pf_facts", "pf_switches_a", "pf_switches_b"],
        write.values,
      );
    } else if (write.table === "picked_kinds" && write.op === "update") {
      const placedNew = made.includes(String(write.set?.company_id));
      expect(placedNew ? ["company_id"] : ["company_id", "business_id"], write.set);
      if (!placedNew && write.set?.business_id !== business)
        problems.push(
          `the pick ${name} takes the business ${String(write.set?.business_id)}, not the caller's`,
        );
    } else if (PICK_ROWS.includes(write.table) && write.op === "update") {
      expect(["business_id"], write.set);
      if (write.set?.business_id !== business)
        problems.push(`the ${write.table} row ${name} takes the business ${String(write.set?.business_id)}`);
      if (write.table === "picked_kind_texts" && !gained.includes(String(write.key?.picked_kind_id)))
        problems.push(`the text row ${name} is no row of a pick placed with the caller's business`);
    } else {
      problems.push(`S1-04 writes no ${write.op} of ${write.table}`);
    }
  }
  return problems;
}

/** Every model of part 4 on an accepted commit fixture. */
const commitModelProblems = (exchange: Commit): string[] => [
  ...optionChoiceProblems(exchange.request.input.decided.context),
  ...answerProblems(exchange),
  ...writtenProblems(exchange),
  ...setColumnProblems(exchange),
];

// ---------------------------------------------------------------------------------------------------------------
// 1. The version and its fixtures

describe("tool-api v1.11: the version and its fixtures", () => {
  it("holds every v1.10 definition by $ref under its own name and nothing else, with v1.10's root", () => {
    const own = schemaOf(VERSION);
    const previous = schemaOf(PREVIOUS);
    const ownDefs = own.$defs as Record<string, Obj>;
    const previousDefs = previous.$defs as Record<string, Obj>;
    expect(sorted(Object.keys(ownDefs))).toEqual(sorted(Object.keys(previousDefs)));
    for (const [name, definition] of Object.entries(ownDefs)) {
      expect(definition.$ref, name).toBe(`tool-api.${PREVIOUS}.schema.json#/$defs/${name}`);
      expect(
        Object.keys(definition).filter((key) => key !== "description" && key !== "$comment"),
        name,
      ).toEqual(["$ref"]);
    }
    expect(own.anyOf).toEqual(previous.anyOf);
    expect(own.$id).toBe(`${ID_BASE}${schemaFileOf(VERSION)}`);
  });

  it("is frozen, and the index holds exactly the fixtures README 'Fixtures, v1.11' names, each with its rule", () => {
    const frozen = (readJson(path.join(TOOL_API_DIR, "frozen.json")) as { frozen: string[] }).frozen;
    expect(frozen).toContain(VERSION);
    expect(README_FIXTURES).toContain("Accepted (3).");
    expect(README_FIXTURES).toContain("Refused (7)");
    expect(README_ACCEPTED.map((named) => named.file)).toEqual([FRONTIER, COMMIT_ALL, COMMIT_SOME]);
    const accepted = ownEntries.filter((entry) => entry.expect === "accept");
    expect(accepted.map((entry) => ({ file: entry.file, rule: entry.rule }))).toEqual(README_ACCEPTED);
    const refused = ownEntries.filter((entry) => entry.expect === "refuse");
    expect(sorted(refused.map((entry) => entry.file))).toEqual(sorted([...README_TWINS.keys()]));
    expect(README_TWINS.size).toBe(7);
    for (const entry of ownEntries) expect(entry.def, entry.file).toBeDefined();
  });

  it("accepts every earlier accepted fixture (v1 to v1.10), each at its own $defs entry", () => {
    expect(earlierAccepted.length).toBeGreaterThan(100);
    const versions = new Set(earlierAccepted.map((entry) => entry.version));
    expect(versions).toContain(PREVIOUS);
    expect(versions).toContain("v1");
    let checked = 0;
    for (const entry of earlierAccepted) {
      const { ok, why } = takenByV111(defOf(entry), fixture(entry.file));
      expect(ok, `${entry.file} (${entry.version}) under ${VERSION}: ${why}`).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(earlierAccepted.length);
  });

  for (const entry of ownEntries) {
    const name = entry.rule ?? "(none)";
    it(`${entry.file}: v1.11's schema takes it at ${String(entry.def)}, and ${name} ${entry.expect === "accept" ? "passes" : "refuses"} it`, () => {
      const exchange = fixture(entry.file);
      const { ok, why } = takenByV111(defOf(entry), exchange);
      expect(ok, `${entry.file}: ${why}`).toBe(true);
      expect(entry.def).toBe(`${(exchange as { call: string }).call}.exchange`);
      const problems = rule(must(entry.rule, `the rule ${entry.file} names`))(exchange);
      if (entry.expect === "accept") expect(problems).toEqual([]);
      else expect(problems.length, `${entry.file} must be refused by ${name}`).toBeGreaterThan(0);
    });
  }

  it("commit-s1-04.json and commit-s1-04-some-share.json pass buttonsAnswerCommit too, beside givesStepKeys", () => {
    for (const file of [COMMIT_ALL, COMMIT_SOME]) {
      expect(entryOf(file).rule, file).toBe("givesStepKeys");
      expect(rule("givesStepKeys")(fixture(file)), file).toEqual([]);
      expect(rule("buttonsAnswerCommit")(fixture(file)), file).toEqual([]);
    }
    expect(rule("buttonsOptionChoices")(fixture(FRONTIER))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The table, bundle v1 and the master's record

describe("tool-api v1.11: the table, bundle v1 and the master's record", () => {
  it("BUTTONS_OPTIONS is README default 180's table, row for row: label, definition, its source, fields", () => {
    expect(README_TABLE).toHaveLength(3);
    const fromRules = Object.entries(BUTTONS_OPTIONS).flatMap(([step, table]) =>
      must(table).options.map((option) => ({
        step,
        label: option.label,
        definition: option.definition,
        definitionFrom: option.definitionFrom,
        fields: option.fields.map((field) => ({ name: field.name, type: field.type })),
      })),
    );
    expect(fromRules).toEqual(README_TABLE);
  });

  it("its labels are S1-04's buttons in bundle v1 and in the master's record, in order; its Means line is bundle v1's", () => {
    const table = tableOf(S1_04);
    const labels = table.options.map((option) => option.label);
    expect(labels).toEqual(bundleButtons(S1_04));
    const masterButtons = masterElements(S1_04).flatMap((elements) =>
      Array.isArray(elements.buttons) ? (elements.buttons as string[]) : [],
    );
    expect(masterButtons).toEqual(bundleButtons(S1_04));
    // The master prints a Means line only for "Each is its own" (MASTER-FLOW-A line 95); bundle v1 carries it.
    const means = (bundleStep(S1_04).more as string[]).flatMap((line) => {
      const match = /^Means '(.+)': (.+)$/.exec(line);
      return match === null ? [] : [{ label: must(match[1]), definition: must(match[2]) }];
    });
    expect(means).toEqual(
      table.options
        .filter((option) => option.definitionFrom === "meansLine")
        .map((option) => ({ label: option.label, definition: option.definition })),
    );
    expect(means).toHaveLength(1);
  });

  it("S1-04 is a plain step in bundle v1 (no branches, no card) whose next, S1-08, bundle v1 does not hold", () => {
    const step = bundleStep(S1_04);
    expect(step.branches).toBeUndefined();
    expect(step.card).toBeUndefined();
    expect(step.next).toBe(tableOf(S1_04).tells);
    expect(BUNDLE_V1.steps[tableOf(S1_04).tells]).toBeUndefined();
    expect(step.gives).toEqual([...(rulesModule.STEP_GIVES[S1_04] ?? [])]);
  });

  it("S1_08_TERM_LINES are README default 186's four lines, each S1-08's card line at its place in the master's record", () => {
    expect(README_TERM_LINES).toHaveLength(4);
    for (const line of README_TERM_LINES) expect(line.index, line.words).toBe(line.number - 1);
    expect(S1_08_TERM_LINES.map((line) => ({ index: line.index, words: line.words }))).toEqual(
      README_TERM_LINES.map((line) => ({ index: line.index, words: line.words })),
    );
    const cards = masterElements("S1-08").flatMap((elements) =>
      isObj(elements.card) ? [elements.card as { lines: string[] }] : [],
    );
    expect(cards).toHaveLength(1);
    const lines = must(cards[0]).lines;
    for (const line of S1_08_TERM_LINES)
      expect(lines[line.index], `line ${String(line.index)}`).toBe(line.words);
    // The other lines are the sample story's or carry a slot (Master Corrections C6), and none of them is a term line.
    expect(lines.length).toBeGreaterThan(S1_08_TERM_LINES.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. build-frontier-s1-04.json's labels are S1-04's buttons in bundle v1, word for word

describe("tool-api v1.11: the frontier's labels are bundle v1's S1-04 buttons, word for word", () => {
  it("build-frontier-s1-04.json's option choices carry S1-04's buttons in bundle v1 as label and branch, in order", () => {
    // FRONTIER_COPY is set only for the card's proof, to a copy outside the repo; unset, the fixture is read.
    const file = FRONTIER_COPY ?? path.join(FIXTURES_DIR, FRONTIER);
    const exchange = readJson(file) as Frontier;
    expect(labelProblems(exchange.outcome.context), file).toEqual([]);
  });

  it("every accepted v1.11 fixture that offers S1-04's choices carries bundle v1's buttons as their labels", () => {
    const offering = ownEntries.filter((entry) => entry.expect === "accept");
    expect(offering.map((entry) => entry.file)).toEqual([FRONTIER, COMMIT_ALL, COMMIT_SOME]);
    for (const entry of offering)
      expect(labelProblems(contextOf(fixture(entry.file))), entry.file).toEqual([]);
  });

  it("fails on a copy with one label changed, which the schema still takes", () => {
    const copy = frontierOf(FRONTIER);
    setAt(copy, ["outcome", "context", "choices", 2, "label"], "Each one is its own");
    expect(takenByV111(defOf(entryOf(FRONTIER)), copy).ok).toBe(true);
    expect(labelProblems(copy.outcome.context)).toEqual([
      "the labels are [Some share one | All share one | Each one is its own], not bundle v1's buttons [Some share one | All share one | Each is its own]",
    ]);
    expect(rule("buttonsOptionChoices")(copy).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. The README's statements, modeled here, hold on the accepted fixtures and agree with the rules

describe("tool-api v1.11: the README's statements, modeled here, hold and agree with the rules", () => {
  it("each S1-04 option choice is a button with the table's definition and fields, low with no reason, and no card", () => {
    for (const file of [FRONTIER, COMMIT_ALL, COMMIT_SOME]) {
      const context = contextOf(fixture(file));
      expect(
        context.openQuestions.map((question) => question.step),
        file,
      ).toContain(S1_04);
      expect(optionChoiceProblems(context), file).toEqual([]);
    }
    expect(rule("buttonsOptionChoices")(fixture(FRONTIER))).toEqual([]);
  });

  it("build-frontier-s1-04.json is the three option choices alone, with no card and no fact", () => {
    const { context } = frontierOf(FRONTIER).outcome;
    expect(context.choices.map((choice) => choice.kind)).toEqual(["option", "option", "option"]);
    expect(context.cards).toEqual([]);
    expect(context.facts).toEqual([]);
  });

  it("each answer commits one choose of a button with the gate's limits, closes its question and writes the walk's rows", () => {
    for (const file of [COMMIT_ALL, COMMIT_SOME]) {
      expect(answerProblems(commitOf(file)), file).toEqual([]);
      expect(rule("buttonsAnswerCommit")(fixture(file)), file).toEqual([]);
    }
    // Limit 6 is not checked on the choose with no field, and passes on the one with two text fields.
    const limit6 = (file: string): string | undefined =>
      commitOf(file).outcome.parts[0]?.limits.find((entry) => entry.limit === 6)?.result;
    expect(limit6(COMMIT_ALL)).toBe("notChecked");
    expect(limit6(COMMIT_SOME)).toBe("pass");
  });

  it("each answer's written names one row per versioned row of its stated writes, the closed question and the clock row", () => {
    for (const file of [COMMIT_ALL, COMMIT_SOME]) {
      const exchange = commitOf(file);
      expect(writtenProblems(exchange), file).toEqual([]);
      // The fixtures follow db/repo's order (README default 181), which this model builds.
      expect(exchange.outcome.written.written, file).toEqual(writtenOf(exchange, closedVersionIn(exchange)));
    }
    const names = commitOf(COMMIT_ALL).outcome.written.written.map((row) => row.rowId);
    expect(names).toContain("company-roster-owner-1/plumber");
    expect(names).toContain("pick-roster-plumbing/pf.license");
  });

  it("each answer sets only the columns defaults 182 and 183 name, a business only on a placed pick's rows", () => {
    for (const file of [COMMIT_ALL, COMMIT_SOME]) {
      const exchange = commitOf(file);
      expect(setColumnProblems(exchange), file).toEqual([]);
      expect(commitModelProblems(exchange), file).toEqual([]);
    }
  });

  it("the models fire on damaged copies: a choice's target, S1-08's channel, a field's words, the clock row, a row's name", () => {
    const target = frontierOf(FRONTIER);
    setAt(target, ["outcome", "context", "choices", 1, "target", "businessId"], "biz-other");
    expect(optionChoiceProblems(target.outcome.context)).toEqual([
      "S1-04 choice 2 (c-02) names another target than its question",
    ]);
    const channel = commitOf(COMMIT_ALL);
    setAt(channel, ["given", "stated", "writes", "outboxRows", 0, "channel"], "sms");
    expect(answerProblems(channel)).toEqual([
      "the walk writes S1-08's row, asking nothing, then S1-09's row, as default 181 states",
    ]);
    const words = commitOf(COMMIT_SOME);
    setAt(
      words,
      ["request", "input", "decided", "decide", "parts", 0, "part", "fields", 1, "words"],
      "Lee Plumbing",
    );
    expect(answerProblems(words)).toEqual(["the field company_name's words are not the turn's own words"]);
    const limit = commitOf(COMMIT_ALL);
    setAt(limit, ["outcome", "parts", 0, "limits", 5, "result"], "pass");
    expect(answerProblems(limit)).toEqual([expect.stringContaining("not what the gate gives this choose")]);
    const clock = commitOf(COMMIT_ALL);
    clock.outcome.written.written = clock.outcome.written.written.filter((row) => row.table !== "clock_rows");
    expect(writtenProblems(clock)).toEqual(["written lacks clock_rows clock-oq-s1-09-roster-1 @1"]);
    const named = commitOf(COMMIT_ALL);
    setAt(named, ["outcome", "written", "written", 0, "rowId"], "company-roster-owner-1");
    expect(writtenProblems(named)).toEqual([
      "written lacks company_kinds company-roster-owner-1/plumber @1",
      "written names company_kinds company-roster-owner-1 @1, not stated",
    ]);
    const reread = commitOf(COMMIT_SOME);
    setAt(reread, ["outcome", "written", "written", 18, "version"], 1);
    expect(writtenProblems(reread)).toEqual([
      "written names the closed question oq-s1-04-sam once, past the version read",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. Each refused fixture refused for its one fault, and accepted put right as its twin (DL-124's mend-then-accept)

/** A refused v1.11 fixture put right as its index entry and README "Contract test, v1.11" say. */
interface Mend {
  /** The fields its one fault sits in: it differs from its twin only there (and in its note). */
  at: Path[];
  /** Puts the fault right, reading only the refused copy, bundle v1 and the README's models. */
  putRight: (copy: unknown) => void;
  /** The one line its rule gives. */
  reason: unknown;
}

const CHOICES: Path = ["outcome", "context", "choices"];
const STATE: Path = ["given", "stated", "writes", "state"];

/** "All share one" put right: every pick and company kind in the company the turn runs under, no companies insert. */
function allInTheTurnsCompany(copy: unknown): void {
  const exchange = copy as Commit;
  const { state } = exchange.given.stated.writes;
  const isMade = (write: StateWrite): boolean => write.table === "companies" && write.op === "insert";
  const made = state.filter(isMade).map((write) => String(write.values?.id));
  const company = must(
    state.find((write) => write.table === "picked_kinds" && !made.includes(String(write.set?.company_id)))
      ?.set?.company_id,
    "the company the turn runs under",
  );
  const business = exchange.request.caller.businessId;
  exchange.given.stated.writes.state = state
    .filter((write) => !isMade(write))
    .map((write) => {
      if (write.table === "company_kinds" && made.includes(String(write.values?.company_id)))
        return { ...write, values: { ...write.values, company_id: company, business_id: business } };
      if (write.table === "picked_kinds" && made.includes(String(write.set?.company_id)))
        return { ...write, set: { company_id: company, business_id: business } };
      return write;
    });
  exchange.outcome.written.written = writtenOf(exchange, closedVersionIn(exchange));
}

const MENDS: Record<string, Mend> = {
  "invalid/refuse-s1-04-option-stakes-high.json": {
    at: [
      [...CHOICES, 0, "stakes"],
      [...CHOICES, 0, "stakesFrom"],
    ],
    putRight: (copy) => {
      setAt(copy, [...CHOICES, 0, "stakes"], "low");
      setAt(copy, [...CHOICES, 0, "stakesFrom"], []);
    },
    reason: expect.stringMatching(/^S1-04 option 1 \(c-01\) has stakes high .*, not low with no reason/),
  },
  "invalid/refuse-s1-04-option-label-reworded.json": {
    at: [[...CHOICES, 1, "label"]],
    putRight: (copy) => {
      setAt(copy, [...CHOICES, 1, "label"], bundleButtons(S1_04)[1]);
    },
    reason:
      "S1-04 option 2 (c-02) has the label 'All share one company' and the branch 'All share one', not the button 'All share one'",
  },
  "invalid/refuse-s1-04-option-field-not-in-table.json": {
    at: [[...CHOICES, 2, "fields"]],
    putRight: (copy) => {
      setAt(copy, [...CHOICES, 2, "fields"], []);
    },
    reason: "S1-04 option 3 (c-03) carries the fields [company_name], not the table's []",
  },
  "invalid/refuse-s1-04-commit-question-left-open.json": {
    at: [["outcome", "openQuestions", "closed"]],
    putRight: (copy) => {
      const question = (copy as Commit).request.input.decided.decide.parts[0]?.part.question;
      setAt(copy, ["outcome", "openQuestions", "closed"], [must(question)]);
    },
    reason: "the commit that answers oq-s1-04-roster-1 closes it, but the answer's closed list lacks it",
  },
  "invalid/refuse-s1-04-commit-plan-row-asks.json": {
    at: [["given", "stated", "writes", "outboxRows", 0, "openQuestionId"]],
    putRight: (copy) => {
      setAt(copy, ["given", "stated", "writes", "outboxRows", 0, "openQuestionId"], null);
    },
    reason: "S1-08's row asks no question, but names oq-s1-09-roster-1",
  },
  "invalid/refuse-s1-04-commit-all-share-second-company.json": {
    at: [STATE, ["outcome", "written", "written"]],
    putRight: allInTheTurnsCompany,
    reason:
      "'All share one' places every kept pick in the company the turn runs under and writes no other company",
  },
  "invalid/refuse-s1-04-commit-new-company-with-business.json": {
    at: [[...STATE, 0, "values", "business_id"]],
    putRight: (copy) => {
      setAt(copy, [...STATE, 0, "values", "business_id"], null);
    },
    reason:
      "the new company company-s1-04-sam-1 names the business biz-lees-barbershop; a company has none before its own S1-09",
  },
};

describe("tool-api v1.11: each refused fixture is refused for its one fault, and accepted put right as its twin", () => {
  it("holds a mend for every refused v1.11 fixture, and the README and its entry name its twin", () => {
    const refused = ownEntries.filter((entry) => entry.expect === "refuse").map((entry) => entry.file);
    expect(sorted(Object.keys(MENDS))).toEqual(sorted(refused));
    for (const file of refused) {
      const twin = must(README_TWINS.get(file), `the README's twin of ${file}`);
      expect(entryOf(file).shows, file).toContain(`it is ${twin}, accepted`);
    }
  });

  for (const [file, mend] of Object.entries(MENDS)) {
    it(`${file}: refused for ${mend.at.map(pointerOf).join(" and ")} alone, and put right it is its twin`, () => {
      const entry = entryOf(file);
      const twin = must(README_TWINS.get(file));
      const twinEntry = entryOf(twin);
      expect(entry.version).toBe(VERSION);
      expect(entry.def).toBe(twinEntry.def);
      expect(twinEntry.expect).toBe("accept");
      const name = must(entry.rule);
      const refused = fixture(file);
      // The schema takes it, and its rule alone refuses it, for its one fault.
      const taken = takenByV111(defOf(entry), refused);
      expect(taken.ok, taken.why).toBe(true);
      expect(rule(name)(refused)).toEqual([mend.reason]);
      if (entry.def === "gateAndCommit.exchange") expect(rule("givesStepKeys")(refused)).toEqual([]);
      // It differs from its twin only at the fault, and in its note.
      for (const where of differences(refused, fixture(twin)))
        expect(
          under(where, [...mend.at, ["given", "note"]]),
          `${file} differs from ${twin} at ${pointerOf(where)}`,
        ).toBe(true);
      // Put right, it changes only there, passes the schema and its rule, and is its twin but for the note.
      const right = structuredClone(refused);
      mend.putRight(right);
      const changed = differences(refused, right);
      expect(changed.length, "the mend changes something").toBeGreaterThan(0);
      for (const where of changed)
        expect(under(where, mend.at), `the mend changes ${pointerOf(where)}`).toBe(true);
      const mended = takenByV111(defOf(entry), right);
      expect(mended.ok, mended.why).toBe(true);
      expect(rule(name)(right)).toEqual([]);
      if (entry.def === "gateAndCommit.exchange") {
        expect(rule("givesStepKeys")(right)).toEqual([]);
        expect(commitModelProblems(right as Commit)).toEqual([]);
      } else {
        expect(optionChoiceProblems(contextOf(right))).toEqual([]);
      }
      const theirs = structuredClone(fixture(twin)) as Obj;
      setAt(theirs, ["given", "note"], null);
      setAt(right, ["given", "note"], null);
      expect(right, `${file} put right is ${twin}`).toEqual(theirs);
    });
  }

  it("refuses four of them by the models of part 4 too, each for its own fault", () => {
    expect(answerProblems(commitOf("invalid/refuse-s1-04-commit-question-left-open.json"))).toEqual([
      "the commit closes oq-s1-04-roster-1 alone",
    ]);
    expect(answerProblems(commitOf("invalid/refuse-s1-04-commit-plan-row-asks.json"))).toEqual([
      "the walk writes S1-08's row, asking nothing, then S1-09's row, as default 181 states",
    ]);
    expect(setColumnProblems(commitOf("invalid/refuse-s1-04-commit-new-company-with-business.json"))).toEqual(
      ["the new company company-s1-04-sam-1 names a business"],
    );
    expect(optionChoiceProblems(contextOf(fixture("invalid/refuse-s1-04-option-stakes-high.json")))).toEqual([
      "S1-04 choice 1 (c-01) is not low with no reason",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 6. The named rules fire on damaged copies the schema still takes; 7. the security review's copies

describe("tool-api v1.11: the named rules fire on damaged copies the schema still takes", () => {
  const takes = (file: string, copy: unknown): void => {
    const taken = takenByV111(defOf(entryOf(file)), copy);
    expect(taken.ok, `the schema takes the copy of ${file}: ${taken.why}`).toBe(true);
  };

  it("buttonsOptionChoices: a definition changed, and the choices out of order", () => {
    const definition = frontierOf(FRONTIER);
    setAt(definition, [...CHOICES, 0, "definition"], "some kinds of work share one company.");
    takes(FRONTIER, definition);
    expect(rule("buttonsOptionChoices")(definition)).toEqual([
      "S1-04 option 1 (c-01) is not defined as the table defines 'Some share one'",
    ]);
    expect(optionChoiceProblems(definition.outcome.context)).toEqual([
      "S1-04 choice 1 (c-01) is not defined by the table's row for 'Some share one'",
    ]);
    const order = frontierOf(FRONTIER);
    const choices = order.outcome.context.choices;
    order.outcome.context.choices = [must(choices[1]), must(choices[0]), must(choices[2])];
    takes(FRONTIER, order);
    expect(rule("buttonsOptionChoices")(order)).toEqual(
      expect.arrayContaining([
        "S1-04 option 1 (c-02) has the label 'All share one' and the branch 'All share one', not the button 'Some share one'",
        "S1-04 option 2 (c-01) has the label 'Some share one' and the branch 'Some share one', not the button 'All share one'",
      ]),
    );
    expect(labelProblems(order.outcome.context).length).toBe(2);
  });

  it("buttonsAnswerCommit: rows out of foreign-key order, another person's company, a pick unplaced in its business, a field not the option's", () => {
    const order = commitOf(COMMIT_ALL);
    const state = order.given.stated.writes.state;
    order.given.stated.writes.state = [must(state[2]), must(state[1]), must(state[0]), ...state.slice(3)];
    takes(COMMIT_ALL, order);
    expect(rule("buttonsAnswerCommit")(order)).toEqual([
      "S1-04's rows are out of foreign-key order: companies, company_kinds, picked_kinds, then the rows of a pick that gained a business",
    ]);
    const owner = commitOf(COMMIT_SOME);
    setAt(owner, [...STATE, 0, "values", "owner_person_id"], "person-alex");
    takes(COMMIT_SOME, owner);
    expect(rule("buttonsAnswerCommit")(owner)).toEqual([
      "the new company company-s1-04-sam-1 is owned by person-alex, not the caller's person person-sam",
    ]);
    const unplaced = commitOf(COMMIT_ALL);
    setAt(unplaced, [...STATE, 3, "set"], { company_id: "company-roster-owner-1" });
    takes(COMMIT_ALL, unplaced);
    expect(rule("buttonsAnswerCommit")(unplaced)).toEqual([
      "the pick pick-roster-electrical, placed in company-roster-owner-1, takes the business null, not biz-roster-owner-1",
    ]);
    expect(setColumnProblems(unplaced)).toEqual([
      "the picked_kinds update of pick-roster-electrical sets [company_id], not [business_id, company_id]",
      "the pick pick-roster-electrical takes the business undefined, not the caller's",
    ]);
    const field = commitOf(COMMIT_ALL);
    setAt(
      field,
      ["request", "input", "decided", "decide", "parts", 0, "part", "fields"],
      [{ name: "shared_kinds", value: "all", words: "all" }],
    );
    takes(COMMIT_ALL, field);
    expect(rule("buttonsAnswerCommit")(field)).toEqual([
      "'All share one' carries [company_name], not the field shared_kinds",
    ]);
    expect(answerProblems(field)).toEqual(
      expect.arrayContaining(["the field shared_kinds is not one the choice carries"]),
    );
  });

  it("the security review's copies: default 182's columns refuse a pick's or a text row's other column; buttonsAnswerCommit as frozen passes them", () => {
    const pickRow = commitOf(COMMIT_ALL);
    setAt(pickRow, [...STATE, 2, "set", "owner_person_id"], "person-alex");
    takes(COMMIT_ALL, pickRow);
    expect(setColumnProblems(pickRow)).toEqual([
      "the picked_kinds update of pick-roster-plumbing sets [business_id, company_id, owner_person_id], not [business_id, company_id]",
    ]);
    const textRow = commitOf(COMMIT_ALL);
    setAt(textRow, [...STATE, 4, "set", "picked_kind_id"], "pick-alex-plumbing");
    takes(COMMIT_ALL, textRow);
    expect(setColumnProblems(textRow)).toEqual([
      "the picked_kind_texts update of pick-roster-plumbing/pf.license sets [business_id, picked_kind_id], not [business_id]",
    ]);
    // README "Contract test, v1.11": the rule holds what is set, not what else is, so as frozen it passes both copies.
    // This is reported to the lead; a rule that refuses them comes under a new name (rules are only ever added).
    expect(rule("buttonsAnswerCommit")(pickRow)).toEqual([]);
    expect(rule("buttonsAnswerCommit")(textRow)).toEqual([]);
  });
});
