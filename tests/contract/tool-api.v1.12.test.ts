// Contract test for K-09 v1.12 (T-1506, the ruling's card 8; DL-1018, DL-1030): contracts/tool-api/README.md "v1.12
// (T-1504)", its defaults 192 to 198, "Named rule, v1.12", "Fixtures, v1.12" and "Contract test, v1.12".
//
// tests/contract/tool-api.v1.test.ts selects the index's entries by version (DL-125), so v1.12's five fixtures already
// join its generic checks: each against its own version's schema and the rule its entry names, every required field,
// and an accepted one accepted by every later minor version. This file is v1.12's own part, as the README's "Contract
// test, v1.12" lists it:
//   1. the version: tool-api.v1.12.schema.json holds every v1.11 definition by $ref and nothing else, so every earlier
//      accepted fixture is accepted by v1.12 (each checked here at its own $defs entry); the index holds exactly the
//      five fixtures README "Fixtures, v1.12" names, each taken by v1.12's schema and by v1.11's (no shape changes);
//      askedResendsQuestion passes the accepted one and refuses each refused one, each for its own reason;
//   2. the stored row the accepted fixture rests on: commit-s1-01.json's S1-02 question, stored with no options, no
//      read-back and no booking, to the turn's handle, the caller's person and the caller's business (defaults 192 (d)
//      and 193), its first row the one the re-sent row follows;
//   3. the README's statements, modeled here from its words (default 192's conditions (a) to (g), its row in default
//      131's form, its answer, and default 194's raise), hold on the accepted fixture, agree with the rule on every
//      v1.12 fixture and every damaged copy below, and fire on the refused fixtures and on damaged copies;
//   4. each refused fixture is refused for its one fault: it differs from commit-s1-02-asked.json only there (and in its
//      note), and put right (the second row dropped, the closed list emptied, ask count 1) it is commit-s1-02-asked.json;
//      the asked-twice and read-back fixtures with no row and nothing in written are accepted too, silent;
//   5. the rule fires on damaged copies of the accepted exchange the schema still takes, one fault each: the unmapped end
//      kept beside the row, a safety hold the turn's safety outcome opens, no service on the turn, two open questions,
//      an ask naming another question, a row named for another step, written naming a clock row too, given.after
//      emptied (no stored row), the asked part with a limit run; and on default 192 (d)'s other conditions;
//   6. what stays silent (default 198): commit-s1-02-unmapped-end.json is still answered with no row (unmappedEndAsked).
//
// The card's proof that the check fails on a copy: with TOOL_API_S1_02_ASKED set to a copy of commit-s1-02-asked.json
// kept outside the repo, part 3's first test reads that copy instead of the fixture. Unset, as always in CI, it reads
// the fixture the index lists.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { CONTRACTS_ROOT, formatErrors, type FixtureEntry } from "./_harness";

// ---------------------------------------------------------------------------------------------------------------
// The files

const TOOL_API_DIR = path.join(CONTRACTS_ROOT, "tool-api");
const FIXTURES_DIR = path.join(TOOL_API_DIR, "fixtures");
/** Every schema's $id is this base plus its path inside contracts/ (ADR-005; contracts/scripts/lib.mjs). */
const ID_BASE = "https://rosie.invalid/contracts/";
const VERSION = "v1.12";
const PREVIOUS = "v1.11";
const RULE = "askedResendsQuestion";
const ACCEPTED = "commit-s1-02-asked.json";
/** The fixture the accepted one runs after: it asked S1-02's question first and states its stored row. */
const FIRST_ASK = "commit-s1-01.json";
const UNMAPPED_END = "commit-s1-02-unmapped-end.json";
const TWO_ROWS = "invalid/refuse-s1-02-asked-two-rows.json";
const CLOSED_TWIN = "invalid/refuse-s1-02-asked-question-closed.json";
const TWICE = "invalid/refuse-s1-02-asked-twice.json";
const READ_BACK = "invalid/refuse-s2-22-asked-read-back.json";
/** The card's proof only: a copy of commit-s1-02-asked.json for part 3's first test to read. Never set in CI. */
const ACCEPTED_COPY = process.env.TOOL_API_S1_02_ASKED;

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

/** A version's major and minor number: v1 is [1, 0], v1.12 is [1, 12]. */
function placeOf(version: string): [number, number] {
  const match = /^v(\d+)(?:\.(\d+))?$/.exec(version);
  if (match === null) throw new Error(`a version this test cannot place: ${version}`);
  return [Number(match[1]), Number(match[2] ?? "0")];
}
const [MAJOR, MINOR] = placeOf(VERSION);
/** The accepted fixtures of every version before v1.12 (BP 6.4: a minor version only adds). */
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
/** Whether `version`'s schema takes `value` at `def`, with its errors when it does not. */
function takenBy(version: string, def: string, value: unknown): { ok: boolean; why: string } {
  const validate = validatorFor(version, def);
  const ok = validate(value);
  return { ok, why: formatErrors(validate.errors).join("; ") };
}
const takenByV112 = (def: string, value: unknown): { ok: boolean; why: string } =>
  takenBy(VERSION, def, value);

// Compile every validator the checks call while the file loads, so no single test carries Ajv's compile time on a
// loaded machine (a resource guard, not part of any check). A schema that cannot be had is left to its test.
for (const def of new Set([...earlierAccepted, ...ownEntries].map((entry) => entry.def))) {
  try {
    if (def !== undefined) {
      validatorFor(VERSION, def);
      validatorFor(PREVIOUS, def);
    }
  } catch {
    // Reported by the test that calls validatorFor again.
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The named rules (tool-api.rules.mjs)

type Rule = (exchange: unknown) => string[];
const rulesModule = (await import(pathToFileURL(path.join(TOOL_API_DIR, "tool-api.rules.mjs")).href)) as {
  rules: Record<string, Rule>;
  ASKS_BEFORE_SILENT: number;
};
const { rules, ASKS_BEFORE_SILENT } = rulesModule;
const rule = (name: string): Rule => must(rules[name], `the rule ${name}`);
const resends = (exchange: unknown): string[] => rule(RULE)(exchange);

// ---------------------------------------------------------------------------------------------------------------
// What the checks read. The fixtures are checked against the schema first (part 1), so a cast to these shapes reads
// only fields the schema gives them.

interface Target {
  businessId: string | null;
  bookingId: string | null;
}
interface SeenQuestion {
  openQuestionId: string;
  step: string;
  target: Target;
  askCount: number;
}
interface Choice {
  choiceId: string;
  question: string | null;
}
interface DecidedPart {
  part: { verb: string; questions?: string[]; choice?: string | null };
  outcome: string;
}
interface Decide {
  reads: Obj[];
  agreed: boolean;
  reread: boolean;
  parts: DecidedPart[];
  end?: string;
}
/** A question's stored row as a fixture states it (K-05 v1 openQuestionNew; README v1.5 default 136). */
interface StoredQuestion {
  id: string;
  handleId: string;
  personId: string | null;
  businessId: string | null;
  bookingId: string | null;
  step: string;
  options: unknown[];
  readback: unknown;
}
interface Written {
  table: string;
  rowId: string;
  version: number;
}
interface RowWritten {
  id: string;
  commitSeq: number;
}
interface PartResult {
  part: number;
  choiceId: string | null;
  result: string;
  limits: { limit: number; result: string; outcome: unknown }[];
  stoppedBy: unknown;
  gives: string[];
  dependsOnPart: unknown;
}
interface CoreResult {
  call: string;
  response: Obj | null;
}
interface Commit {
  call: string;
  given: { after: string[]; note: string | null };
  request: {
    caller: { businessId: string | null; personId: string | null };
    turn: { id: string; handleId: string; service?: string; chatId?: string | null };
    input: {
      kind: string;
      decided: { context: { openQuestions: SeenQuestion[]; choices: Choice[] }; decide: Decide };
      planner: unknown;
    };
  };
  outcome: {
    result: string;
    repeated: boolean;
    parts: PartResult[];
    planner: unknown;
    core: CoreResult[];
    written: { written: Written[]; outboxRows: RowWritten[] };
    effects: unknown[];
    openQuestions: { opened: string[]; closed: string[] };
    end?: string;
  };
}
/** A fixture an exchange runs after, read loosely: it may be of any call. */
interface Earlier {
  given?: { stated?: { writes?: { openQuestions?: StoredQuestion[] } } | null };
  outcome?: { written?: { written?: Written[]; outboxRows?: RowWritten[] } };
}

const commitOf = (file: string): Commit => structuredClone(fixture(file)) as Commit;

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

const OUTBOX: Path = ["outcome", "written", "outboxRows"];
const WRITTEN: Path = ["outcome", "written", "written"];
const CLOSED: Path = ["outcome", "openQuestions", "closed"];
const QUESTIONS: Path = ["request", "input", "decided", "context", "openQuestions"];
const NOTE: Path = ["given", "note"];

// ---------------------------------------------------------------------------------------------------------------
// The README

const README = readFileSync(path.join(TOOL_API_DIR, "README.md"), "utf8");
/** The README's text from `start` to the next `end` after it. */
function readmeBetween(start: string, end: string): string {
  const from = README.indexOf(start);
  if (from === -1) throw new Error(`the README has no "${start}"`);
  const to = README.indexOf(end, from + start.length);
  if (to === -1) throw new Error(`the README has no "${end}" after "${start}"`);
  return README.slice(from, to);
}

/** README "Fixtures, v1.12": the accepted fixtures with the rule each names, and the refused ones. */
const README_FIXTURES = readmeBetween("### Fixtures, v1.12", "### Who reads v1.12");
const README_ACCEPTED = [...README_FIXTURES.matchAll(/`([\w-]+\.json)` \(rule `(\w+)`\)/g)].map((match) => ({
  file: must(match[1]),
  rule: must(match[2]),
}));
const README_REFUSED = [
  ...new Set(
    [...README_FIXTURES.matchAll(/`(refuse-[\w-]+\.json)`/g)].map((match) => `invalid/${must(match[1])}`),
  ),
];

// ---------------------------------------------------------------------------------------------------------------
// The README's statements, modeled here from its words. Each returns one line per problem; an empty list means the
// statement holds.

/** README default 131: a fixture writes the turn key as a readable stand-in, `sam-asked` for `turn-s1-02-sam-asked`. */
const turnKeyOf = (turnId: string): string | undefined => /^turn-s\d-\d{2}-(.+)$/.exec(turnId)?.[1];
const idStep = (step: string): string => step.toLowerCase();
/** The indices of the parts decide ended in one question: the verb ask, or the outcome oneQuestion (default 192 (a)). */
const askedPartsOf = (exchange: Commit): number[] =>
  exchange.request.input.decided.decide.parts.flatMap((entry, at) =>
    entry.outcome === "oneQuestion" || entry.part.verb === "ask" ? [at] : [],
  );
/** The ids of the rows a core result names anywhere in its response (a core action's own lines, default 134). */
function coreRowIds(exchange: Commit): Set<string> {
  const strings = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(strings)
        : isObj(value)
          ? Object.values(value).flatMap(strings)
          : [];
  return new Set(strings(exchange.outcome.core));
}
/** The outbox rows the answer names that no core result names: the rows a part or the re-send wrote. */
const sentRows = (exchange: Commit): RowWritten[] =>
  exchange.outcome.written.outboxRows.filter((row) => !coreRowIds(exchange).has(row.id));

/**
 * README default 192 (a) and "The answer": a first commit of decided texts, with a part decide ended in one question,
 * every part answered asked or noAction, each part ended in one question answered asked as the gate answers it (its
 * choice for choose or enter, else null; limits 1 to 6 notChecked with no outcome; no stop, no key, nothing it depends
 * on); the answer opens and closes no question and writes no effect.
 */
export function askedAnswerProblems(exchange: Commit): string[] {
  const { outcome } = exchange;
  if (exchange.call !== "gateAndCommit" || exchange.request.input.kind !== "decided")
    return ["an asked turn is a gateAndCommit of decided texts"];
  if (outcome.result !== "committed" || outcome.repeated) return ["an asked turn is a first commit"];
  const asked = askedPartsOf(exchange);
  if (asked.length === 0) return ["decide ended no part in one question"];
  const problems: string[] = [];
  for (const result of outcome.parts)
    if (result.result !== "asked" && result.result !== "noAction")
      problems.push(`part ${String(result.part)} is answered ${result.result}, not asked or noAction`);
  const { parts } = exchange.request.input.decided.decide;
  for (const at of asked) {
    const { part } = must(parts[at]);
    const expected: PartResult = {
      part: at,
      choiceId: part.verb === "choose" || part.verb === "enter" ? (part.choice ?? null) : null,
      result: "asked",
      limits: [1, 2, 3, 4, 5, 6].map((limit) => ({ limit, result: "notChecked", outcome: null })),
      stoppedBy: null,
      gives: [],
      dependsOnPart: null,
    };
    const answered = outcome.parts.find((result) => result.part === at);
    if (!isDeepStrictEqual(answered, expected))
      problems.push(`part ${String(at)} is not answered asked with no limit run, as the gate answers it`);
  }
  if (outcome.openQuestions.opened.length > 0 || outcome.openQuestions.closed.length > 0)
    problems.push("the answer opens or closes a question");
  if (outcome.effects.length > 0) problems.push("the answer writes an effect");
  return problems;
}

/** A question's stored row, as the first commit fixture the exchange runs after that states it, with what it wrote. */
interface Stored {
  file: string;
  row: StoredQuestion;
  /** The version that fixture's written names the question's row at. */
  version: number;
  /** The last commitSeq of the outbox rows that fixture names. */
  commitSeq: number;
}

/**
 * README "Named rule, v1.12" and default 136: a question's stored row is read where a fixture the exchange runs after
 * (given.after) states it, in that fixture's given.stated.writes.openQuestions. Undefined when none states it.
 */
function storedRowOf(exchange: Commit, id: string): Stored | undefined {
  for (const file of exchange.given.after) {
    const earlier = fixture(file) as Earlier;
    const row = earlier.given?.stated?.writes?.openQuestions?.find((question) => question.id === id);
    if (row === undefined) continue;
    const written = earlier.outcome?.written;
    return {
      file,
      row,
      version:
        written?.written?.find((entry) => entry.table === "open_questions" && entry.rowId === id)?.version ??
        Number.NaN,
      commitSeq: Math.max(...(written?.outboxRows ?? []).map((entry) => entry.commitSeq)),
    };
  }
  return undefined;
}

/**
 * README default 192 (b) to (g), 193, 194 and 195 as the exchange shows them: why the turn sends no question again,
 * one reason a line; none when it sends its one open question again. (b) no unmapped end and no planner verb; (f) no
 * core action but the texts' safety outcomes, none opening a hold; (g) a service on the turn; (c) exactly one open
 * question, each asked part about it; (d) about no booking, of the caller's business, and its stored row (as a fixture
 * the exchange runs after states it) with no options, no read-back and no booking, sent to the turn's handle, asked of
 * the caller's person, of the caller's business; (e) asked once.
 */
export function silenceReasons(exchange: Commit): string[] {
  const { request, outcome } = exchange;
  const { decide, context } = request.input.decided;
  const reasons: string[] = [];
  if (decide.end !== undefined) reasons.push("the unmapped end");
  if (request.input.planner !== null) reasons.push("a planner verb");
  const asked = askedPartsOf(exchange);
  for (const result of outcome.parts)
    if (result.result === "asked" && !asked.includes(result.part))
      reasons.push(`part ${String(result.part)} waits for the one question`);
  for (const core of outcome.core) {
    if (core.call !== "recordSafetyOutcome") reasons.push(`a core action, ${core.call}`);
    else if (core.response?.hold !== null && core.response?.hold !== undefined) reasons.push("a safety hold");
  }
  if (typeof request.turn.service !== "string") reasons.push("no service on the turn");
  if (context.openQuestions.length !== 1)
    return [...reasons, `${String(context.openQuestions.length)} open questions`];
  const question = must(context.openQuestions[0]);
  const id = question.openQuestionId;
  for (const at of asked) {
    const { part } = must(decide.parts[at]);
    const about =
      part.verb === "ask"
        ? (part.questions ?? []).every((other) => other === id)
        : part.verb === "choose" &&
          context.choices.find((choice) => choice.choiceId === part.choice)?.question === id;
    if (!about) reasons.push(`part ${String(at)} is not about ${id}`);
  }
  if (question.target.bookingId !== null) reasons.push("about a booking");
  if (question.target.businessId !== request.caller.businessId) reasons.push("another business's");
  if (question.askCount !== 1) reasons.push(`asked ${String(question.askCount)} times, not once`);
  const stored = storedRowOf(exchange, id);
  if (stored === undefined) return [...reasons, "no stored row"];
  const { row } = stored;
  if (row.options.length > 0) reasons.push("stored with options");
  if (row.readback !== null) reasons.push("stored with a read-back");
  if (row.bookingId !== null) reasons.push("stored about a booking");
  if (row.handleId !== request.turn.handleId) reasons.push("sent to another handle");
  if (row.personId !== request.caller.personId) reasons.push("asked of another person");
  if (row.businessId !== request.caller.businessId) reasons.push("stored under another business");
  return reasons;
}

/**
 * README default 192 "The row" and "The answer", and default 194: a turn that sends its one open question again names
 * exactly one row no core result names, `outbox-<the question's step>-<turn key>-1` (default 131: n 1, the turn's only
 * row of that kind and step), after every row of the commit it runs after (its commitSeq follows); and written names
 * the question's row alone, past the version its first commit wrote, since the raise is an update. A turn that stays
 * silent names no such row and writes no row of an open question in its context.
 */
export function resendProblems(exchange: Commit): string[] {
  const problems = askedAnswerProblems(exchange);
  if (problems.length > 0) return problems;
  const reasons = silenceReasons(exchange);
  const sent = sentRows(exchange);
  const written = exchange.outcome.written.written;
  const questionIds = exchange.request.input.decided.context.openQuestions.map((q) => q.openQuestionId);
  if (reasons.length > 0) {
    if (sent.length > 0) problems.push(`the turn stays silent (${reasons.join("; ")}), but sends a row`);
    if (written.some((row) => row.table === "open_questions" && questionIds.includes(row.rowId)))
      problems.push(`the turn stays silent (${reasons.join("; ")}), but raises an ask count`);
    return problems;
  }
  const question = must(exchange.request.input.decided.context.openQuestions[0]);
  const id = question.openQuestionId;
  const stored = must(storedRowOf(exchange, id), `the stored row of ${id}`);
  const key = turnKeyOf(exchange.request.turn.id);
  const rowId = `outbox-${idStep(question.step)}-${String(key)}-1`;
  if (sent.length !== 1) problems.push(`the turn sends ${String(sent.length)} rows, not one`);
  else {
    const row = must(sent[0]);
    if (key === undefined || row.id !== rowId) problems.push(`the row is ${row.id}, not ${rowId}`);
    if (!(row.commitSeq > stored.commitSeq))
      problems.push(`the row's commitSeq ${String(row.commitSeq)} does not follow ${stored.file}'s rows`);
  }
  const raised = written[0];
  if (
    written.length !== 1 ||
    raised?.table !== "open_questions" ||
    raised.rowId !== id ||
    !(raised.version > stored.version)
  )
    problems.push(`written names ${id}'s row alone, past version ${String(stored.version)}`);
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// 1. The version and its fixtures

describe("tool-api v1.12: the version and its fixtures", () => {
  it("holds every v1.11 definition by $ref under its own name and nothing else, with v1.11's root", () => {
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

  it("is frozen, and the index holds exactly the fixtures README 'Fixtures, v1.12' names, each with askedResendsQuestion", () => {
    const frozen = (readJson(path.join(TOOL_API_DIR, "frozen.json")) as { frozen: string[] }).frozen;
    expect(frozen).toContain(VERSION);
    expect(README_FIXTURES).toContain("Accepted (1)");
    expect(README_FIXTURES).toContain("Refused (4)");
    expect(README_ACCEPTED).toEqual([{ file: ACCEPTED, rule: RULE }]);
    const accepted = ownEntries.filter((entry) => entry.expect === "accept");
    expect(accepted.map((entry) => ({ file: entry.file, rule: entry.rule }))).toEqual(README_ACCEPTED);
    const refused = ownEntries.filter((entry) => entry.expect === "refuse").map((entry) => entry.file);
    expect(sorted(refused)).toEqual(sorted(README_REFUSED));
    expect(sorted(README_REFUSED)).toEqual(sorted([TWO_ROWS, CLOSED_TWIN, TWICE, READ_BACK]));
    for (const entry of ownEntries) {
      expect(entry.rule, entry.file).toBe(RULE);
      expect(entry.def, entry.file).toBe("gateAndCommit.exchange");
    }
    expect(ASKS_BEFORE_SILENT).toBe(2);
  });

  it("accepts every earlier accepted fixture (v1 to v1.11), each at its own $defs entry", () => {
    expect(earlierAccepted.length).toBeGreaterThan(100);
    const versions = new Set(earlierAccepted.map((entry) => entry.version));
    expect(versions).toContain(PREVIOUS);
    expect(versions).toContain("v1");
    let checked = 0;
    for (const entry of earlierAccepted) {
      const { ok, why } = takenByV112(defOf(entry), fixture(entry.file));
      expect(ok, `${entry.file} (${entry.version}) under ${VERSION}: ${why}`).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(earlierAccepted.length);
  });

  for (const entry of ownEntries) {
    it(`${entry.file}: v1.12's schema and v1.11's take it at ${String(entry.def)}, and ${RULE} ${entry.expect === "accept" ? "passes" : "refuses"} it`, () => {
      const exchange = fixture(entry.file);
      for (const version of [VERSION, PREVIOUS]) {
        const { ok, why } = takenBy(version, defOf(entry), exchange);
        expect(ok, `${entry.file} under ${version}: ${why}`).toBe(true);
      }
      const problems = rule(must(entry.rule, `the rule ${entry.file} names`))(exchange);
      if (entry.expect === "accept") expect(problems).toEqual([]);
      else expect(problems.length, `${entry.file} must be refused by ${RULE}`).toBeGreaterThan(0);
    });
  }

  it("askedResendsQuestion gives each of the five fixtures its own reason, word for word", () => {
    expect(resends(fixture(ACCEPTED))).toEqual([]);
    expect(resends(fixture(TWO_ROWS))).toEqual([
      "the turn sends oq-s1-02-sam-1 again in one outbox row, not 2",
    ]);
    expect(resends(fixture(CLOSED_TWIN))).toEqual([
      "an asked turn opens and closes no question, but the answer opens [] and closes [oq-s1-02-sam-1]",
    ]);
    expect(resends(fixture(TWICE))).toEqual([
      "the turn sends no question again (oq-s1-02-sam-1 was asked 2 times), but the answer writes outbox-s1-02-sam-asked-1",
      "the turn raises no ask count (oq-s1-02-sam-1 was asked 2 times), but written names oq-s1-02-sam-1",
    ]);
    // README "Fixtures, v1.12" and T-1504's QA note 1: no K-09 fixture states S2-22's question, so the read-back twin is
    // refused through "no stored row stated"; a fixture stating a read-back stored row would reach the read-back line.
    expect(resends(fixture(READ_BACK))).toEqual([
      "the turn sends no question again (no fixture this exchange runs after states oq-s2-22-sam's stored row), but the answer writes outbox-s2-22-sam-hmm-1",
      "the turn raises no ask count (no fixture this exchange runs after states oq-s2-22-sam's stored row), but written names oq-s2-22-sam",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The stored row the accepted fixture rests on

describe("tool-api v1.12: the stored row the accepted fixture rests on", () => {
  it("commit-s1-02-asked.json runs after commit-s1-01.json, which states S1-02's question with no options, no read-back and no booking", () => {
    const exchange = commitOf(ACCEPTED);
    expect(exchange.given.after).toEqual([FIRST_ASK]);
    expect(entryOf(FIRST_ASK).expect).toBe("accept");
    const question = must(exchange.request.input.decided.context.openQuestions[0]);
    const stored = must(storedRowOf(exchange, question.openQuestionId), "the stored row of S1-02's question");
    expect(stored.file).toBe(FIRST_ASK);
    // Default 193: no options as sent, no read-back, about no booking (writes.ts lines 484 and 485; v1.5 default 134).
    expect(stored.row.options).toEqual([]);
    expect(stored.row.readback).toBeNull();
    expect(stored.row.bookingId).toBeNull();
    expect(stored.row.step).toBe("S1-02");
    expect(stored.row.step).toBe(question.step);
    // Default 192 (d): to the turn's handle, asked of the caller's person, of the call's business.
    expect(stored.row.handleId).toBe(exchange.request.turn.handleId);
    expect(stored.row.personId).toBe(exchange.request.caller.personId);
    expect(stored.row.businessId).toBe(exchange.request.caller.businessId);
    // Its first commit wrote it at version 1 with one row, outbox-s1-02-sam-1 at commitSeq 1, which named it.
    expect(stored.version).toBe(1);
    expect(stored.commitSeq).toBe(1);
    expect(commitOf(FIRST_ASK).outcome.openQuestions.opened).toEqual([question.openQuestionId]);
  });

  it("the turn's context shows that question alone, asked once, of the caller's business, about no booking", () => {
    const { context } = commitOf(ACCEPTED).request.input.decided;
    expect(context.openQuestions).toHaveLength(1);
    const question = must(context.openQuestions[0]);
    expect(question.openQuestionId).toBe("oq-s1-02-sam-1");
    expect(question.askCount).toBe(1);
    expect(question.askCount).toBeLessThan(ASKS_BEFORE_SILENT);
    expect(question.target.bookingId).toBeNull();
    expect(question.target.businessId).toBe(commitOf(ACCEPTED).request.caller.businessId);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. The README's statements, modeled here, hold on the accepted fixture and agree with the rule

describe("tool-api v1.12: the README's statements, modeled here, hold and agree with the rule", () => {
  it("commit-s1-02-asked.json sends S1-02's question again in one row and raises its count, as defaults 192 and 194 state", () => {
    // ACCEPTED_COPY is set only for the card's proof, to a copy outside the repo; unset, the fixture is read.
    const file = ACCEPTED_COPY ?? path.join(FIXTURES_DIR, ACCEPTED);
    const exchange = readJson(file) as Commit;
    expect(takenByV112("gateAndCommit.exchange", exchange).ok, file).toBe(true);
    expect(resends(exchange), file).toEqual([]);
    expect(askedAnswerProblems(exchange), file).toEqual([]);
    expect(silenceReasons(exchange), file).toEqual([]);
    expect(resendProblems(exchange), file).toEqual([]);
  });

  it("the row is outbox-s1-02-sam-asked-1 at commitSeq 2, and written names oq-s1-02-sam-1 alone at version 3", () => {
    const exchange = commitOf(ACCEPTED);
    expect(turnKeyOf(exchange.request.turn.id)).toBe("sam-asked");
    expect(sentRows(exchange)).toEqual([{ id: "outbox-s1-02-sam-asked-1", commitSeq: 2 }]);
    expect(exchange.outcome.written.written).toEqual([
      { table: "open_questions", rowId: "oq-s1-02-sam-1", version: 3 },
    ]);
    // Nothing else moves: no question opened or closed, no clock row, no effect, no key; the safety outcome sends no line.
    expect(exchange.outcome.openQuestions).toEqual({ opened: [], closed: [] });
    expect(exchange.outcome.effects).toEqual([]);
    expect(exchange.outcome.parts.flatMap((result) => result.gives)).toEqual([]);
    expect(exchange.outcome.core.map((core) => core.call)).toEqual(["recordSafetyOutcome"]);
    expect(must(exchange.outcome.core[0]).response?.hold).toBeNull();
    expect(must(exchange.outcome.core[0]).response?.safetyLine).toBeNull();
    expect(exchange.outcome.end).toBeUndefined();
  });

  it("agrees with the rule on every v1.12 fixture: it passes the accepted one and refuses each refused one", () => {
    for (const entry of ownEntries) {
      const exchange = commitOf(entry.file);
      const modeled = resendProblems(exchange);
      expect(modeled.length === 0, `${entry.file}: ${modeled.join("; ")}`).toBe(entry.expect === "accept");
      expect(resends(exchange).length === 0, entry.file).toBe(entry.expect === "accept");
    }
  });

  it("the models refuse each refused fixture for its own fault", () => {
    expect(resendProblems(commitOf(TWO_ROWS))).toEqual(["the turn sends 2 rows, not one"]);
    expect(resendProblems(commitOf(CLOSED_TWIN))).toEqual(["the answer opens or closes a question"]);
    expect(silenceReasons(commitOf(TWICE))).toEqual(["asked 2 times, not once"]);
    expect(resendProblems(commitOf(TWICE))).toEqual([
      "the turn stays silent (asked 2 times, not once), but sends a row",
      "the turn stays silent (asked 2 times, not once), but raises an ask count",
    ]);
    expect(silenceReasons(commitOf(READ_BACK))).toEqual(["no stored row"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. Each refused fixture refused for its one fault, and accepted put right (DL-124's mend-then-accept)

/** A refused v1.12 fixture put right as its index entry and README "Contract test, v1.12" say. */
interface Mend {
  /** The fields its one fault sits in: it differs from commit-s1-02-asked.json only there (and in its note). */
  at: Path[];
  /** Puts the fault right, reading only the refused copy. */
  putRight: (copy: unknown) => void;
}

const MENDS: Record<string, Mend> = {
  [TWO_ROWS]: {
    at: [OUTBOX],
    putRight: (copy) => {
      setAt(copy, OUTBOX, (getAt(copy, OUTBOX) as RowWritten[]).slice(0, 1));
    },
  },
  [CLOSED_TWIN]: {
    at: [CLOSED],
    putRight: (copy) => {
      setAt(copy, CLOSED, []);
    },
  },
  [TWICE]: {
    at: [[...QUESTIONS, 0, "askCount"]],
    putRight: (copy) => {
      setAt(copy, [...QUESTIONS, 0, "askCount"], 1);
    },
  },
};

/** README "Contract test, v1.12": the silent mend, no row and nothing in written, for the asked-twice and read-back twins. */
function silenced(copy: unknown): void {
  const exchange = copy as Commit;
  const core = coreRowIds(exchange);
  setAt(
    copy,
    OUTBOX,
    exchange.outcome.written.outboxRows.filter((row) => core.has(row.id)),
  );
  setAt(copy, WRITTEN, []);
}

describe("tool-api v1.12: each refused fixture is refused for its one fault, and accepted put right", () => {
  it("holds a mend for every refused v1.12 fixture built on commit-s1-02-asked.json, and each entry names it", () => {
    expect(sorted(Object.keys(MENDS))).toEqual(sorted([TWO_ROWS, CLOSED_TWIN, TWICE]));
    for (const file of Object.keys(MENDS))
      expect(entryOf(file).shows, file).toContain(`it is ${ACCEPTED}, accepted`);
    expect(entryOf(TWICE).shows).toContain("with no row and nothing in written it is accepted too, silent");
    expect(entryOf(READ_BACK).shows).toContain("with no row and nothing in written it is accepted");
  });

  for (const [file, mend] of Object.entries(MENDS)) {
    it(`${file}: refused for ${mend.at.map(pointerOf).join(" and ")} alone, and put right it is commit-s1-02-asked.json`, () => {
      const entry = entryOf(file);
      expect(entry.version).toBe(VERSION);
      const refused = fixture(file);
      const taken = takenByV112(defOf(entry), refused);
      expect(taken.ok, taken.why).toBe(true);
      expect(resends(refused).length).toBeGreaterThan(0);
      // It differs from the accepted fixture only at the fault, and in its note.
      const changed = differences(refused, fixture(ACCEPTED));
      expect(changed.length).toBeGreaterThan(1);
      for (const where of changed)
        expect(
          under(where, [...mend.at, NOTE]),
          `${file} differs from ${ACCEPTED} at ${pointerOf(where)}`,
        ).toBe(true);
      // Put right, it changes only there, passes the schema, the rule and the models, and is the accepted fixture.
      const right = structuredClone(refused);
      mend.putRight(right);
      const mended = differences(refused, right);
      expect(mended.length, "the mend changes something").toBeGreaterThan(0);
      for (const where of mended)
        expect(under(where, mend.at), `the mend changes ${pointerOf(where)}`).toBe(true);
      const ok = takenByV112(defOf(entry), right);
      expect(ok.ok, ok.why).toBe(true);
      expect(resends(right)).toEqual([]);
      expect(resendProblems(right as Commit)).toEqual([]);
      const accepted = structuredClone(fixture(ACCEPTED));
      setAt(accepted, NOTE, null);
      setAt(right, NOTE, null);
      expect(right, `${file} put right is ${ACCEPTED}`).toEqual(accepted);
    });
  }

  for (const file of [TWICE, READ_BACK]) {
    it(`${file}: with no row and nothing in written it is accepted, silent`, () => {
      const entry = entryOf(file);
      const silent = structuredClone(fixture(file));
      silenced(silent);
      for (const where of differences(fixture(file), silent))
        expect(under(where, [OUTBOX, WRITTEN]), `the silent mend changes ${pointerOf(where)}`).toBe(true);
      expect((silent as Commit).outcome.written.outboxRows).toEqual([]);
      const ok = takenByV112(defOf(entry), silent);
      expect(ok.ok, ok.why).toBe(true);
      expect(resends(silent)).toEqual([]);
      expect(resendProblems(silent as Commit)).toEqual([]);
      // Still silent for its one reason: the models name it.
      expect(silenceReasons(silent as Commit).length).toBe(1);
    });
  }

  it("the read-back twin is S2-22's own turn, with the service and chat id a v1.5 caller puts on the turn", () => {
    const exchange = commitOf(READ_BACK);
    expect(exchange.request.input.decided.context.openQuestions.map((q) => q.step)).toEqual(["S2-22"]);
    expect(exchange.request.turn.service).toBe("imessage");
    expect(exchange.request.turn.chatId).toBe("linq-chat-demo-sam");
    expect(askedAnswerProblems(exchange)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. The rule fires on damaged copies of the accepted exchange the schema still takes, one fault each

/** A damaged copy of commit-s1-02-asked.json: what it breaks, and the rule's lines on it. */
interface Damage {
  name: string;
  damage: (copy: Commit) => void;
  reasons: unknown[];
}

const ROW = "outbox-s1-02-sam-asked-1";
const QUESTION = "oq-s1-02-sam-1";
const silentLines = (because: string): string[] => [
  `the turn sends no question again (${because}), but the answer writes ${ROW}`,
  `the turn raises no ask count (${because}), but written names ${QUESTION}`,
];
const secondQuestion = (copy: Commit): SeenQuestion => ({
  ...structuredClone(must(copy.request.input.decided.context.openQuestions[0])),
  openQuestionId: "oq-s1-04-sam-1",
  step: "S1-04",
});

const DAMAGES: Damage[] = [
  {
    // K-02 v1.2 holds an end only after the one re-read with a refused read, its parts each ending in one question;
    // v1.8's schema then takes an answer with end asked and nothing in written.written, so the raise goes and the row
    // stays: the unmapped end is the copy's one fault the rule reads.
    name: "the unmapped end kept beside the row",
    damage: (copy) => {
      const { decide } = copy.request.input.decided;
      decide.reads.push({ model: "sonnet", role: "reread", refused: { unmappedParts: [0] } });
      decide.reread = true;
      decide.end = "oneQuestion";
      must(decide.parts[0]).outcome = "oneQuestion";
      copy.outcome.end = "asked";
      copy.outcome.written.written = [];
    },
    reasons: [
      `the turn sends no question again (the turn's unmapped end (CQ-199, CQ-203)), but the answer writes ${ROW}`,
    ],
  },
  {
    name: "a safety hold the turn's safety outcome opens",
    damage: (copy) => {
      must(must(copy.outcome.core[0]).response).hold = {
        holdId: "hold-sam-0002",
        releaseRule: "never",
        blocksBooking: false,
      };
    },
    reasons: silentLines("a safety hold"),
  },
  {
    name: "no service on the turn (nor its chat id: both or neither, v1.5 default 135)",
    damage: (copy) => {
      delete copy.request.turn.service;
      delete copy.request.turn.chatId;
    },
    reasons: silentLines("the request's turn names no service"),
  },
  {
    name: "two open questions in the context",
    damage: (copy) => {
      copy.request.input.decided.context.openQuestions.push(secondQuestion(copy));
    },
    reasons: silentLines("2 open questions, not one"),
  },
  {
    name: "an ask naming another question",
    damage: (copy) => {
      must(copy.request.input.decided.decide.parts[0]).part.questions = ["oq-s1-04-sam-1"];
    },
    reasons: silentLines("part 0 asks about another question"),
  },
  {
    name: "a row named for another step",
    damage: (copy) => {
      must(copy.outcome.written.outboxRows[0]).id = "outbox-s1-04-sam-asked-1";
    },
    reasons: [
      "outbox-s1-04-sam-asked-1 is not named outbox-s1-02-<turn key>-<n>, as a row that asks S1-02 is",
    ],
  },
  {
    name: "written naming the question's clock row too",
    damage: (copy) => {
      copy.outcome.written.written.push({ table: "clock_rows", rowId: `clock-${QUESTION}`, version: 2 });
    },
    reasons: [
      `written names ${QUESTION}'s row alone, its ask count raised, not [open_questions/${QUESTION}, clock_rows/clock-${QUESTION}]`,
    ],
  },
  {
    name: "given.after emptied, so no fixture states the stored row",
    damage: (copy) => {
      copy.given.after = [];
    },
    reasons: silentLines(`no fixture this exchange runs after states ${QUESTION}'s stored row`),
  },
  {
    name: "the asked part with a limit run",
    damage: (copy) => {
      must(must(copy.outcome.parts[0]).limits[0]).result = "pass";
    },
    reasons: [expect.stringMatching(/^parts\[0\] is not decide's part 0 asked with no limit run: \{/)],
  },
  // Default 192 (d), the conditions the context and the stored row show.
  {
    name: "the question about a booking",
    damage: (copy) => {
      must(copy.request.input.decided.context.openQuestions[0]).target.bookingId = "booking-sam-1";
    },
    reasons: silentLines(`${QUESTION} is about a booking`),
  },
  {
    name: "the question another business's",
    damage: (copy) => {
      must(copy.request.input.decided.context.openQuestions[0]).target.businessId = "biz-lee-home-services";
    },
    reasons: silentLines(`${QUESTION} is another business's`),
  },
  {
    name: "the stored row sent to another handle",
    damage: (copy) => {
      copy.request.turn.handleId = "handle-alex";
    },
    reasons: silentLines(`${QUESTION} went to another handle (${FIRST_ASK})`),
  },
  {
    name: "the stored row asked of another person",
    damage: (copy) => {
      copy.request.caller.personId = "person-alex";
    },
    reasons: silentLines(`${QUESTION} was asked of another person (${FIRST_ASK})`),
  },
];

describe("tool-api v1.12: askedResendsQuestion fires on damaged copies of the accepted exchange the schema still takes", () => {
  for (const { name, damage, reasons } of DAMAGES) {
    it(`${name}: taken by the schema, refused by the rule and the models, for that fault alone`, () => {
      const copy = commitOf(ACCEPTED);
      damage(copy);
      const taken = takenByV112("gateAndCommit.exchange", copy);
      expect(taken.ok, `the schema takes the copy: ${taken.why}`).toBe(true);
      expect(resends(copy)).toEqual(reasons);
      expect(resendProblems(copy).length, `the models refuse the copy: ${name}`).toBeGreaterThan(0);
    });
  }

  it("the models name each fault: the row's id and n, written's clock row and version, the commitSeq, no stored row, a limit run", () => {
    const named = commitOf(ACCEPTED);
    must(named.outcome.written.outboxRows[0]).id = "outbox-s1-04-sam-asked-1";
    expect(resendProblems(named)).toEqual([`the row is outbox-s1-04-sam-asked-1, not ${ROW}`]);
    const clock = commitOf(ACCEPTED);
    clock.outcome.written.written.push({ table: "clock_rows", rowId: `clock-${QUESTION}`, version: 2 });
    expect(resendProblems(clock)).toEqual([`written names ${QUESTION}'s row alone, past version 1`]);
    // README "Named rule, v1.12": the rule holds the row's form (its step's prefix) and written's names, not the raised
    // version, the row's n or its commitSeq, so as frozen it passes these three copies; the models, from defaults 131,
    // 192 and 194, refuse them. This is reported to the lead; a rule that refuses them comes under a new name.
    const stale = commitOf(ACCEPTED);
    must(stale.outcome.written.written[0]).version = 1;
    expect(resendProblems(stale)).toEqual([`written names ${QUESTION}'s row alone, past version 1`]);
    expect(resends(stale)).toEqual([]);
    const second = commitOf(ACCEPTED);
    must(second.outcome.written.outboxRows[0]).id = "outbox-s1-02-sam-asked-2";
    expect(resendProblems(second)).toEqual([`the row is outbox-s1-02-sam-asked-2, not ${ROW}`]);
    expect(resends(second)).toEqual([]);
    const seq = commitOf(ACCEPTED);
    must(seq.outcome.written.outboxRows[0]).commitSeq = 1;
    expect(resendProblems(seq)).toEqual([`the row's commitSeq 1 does not follow ${FIRST_ASK}'s rows`]);
    expect(resends(seq)).toEqual([]);
    const after = commitOf(ACCEPTED);
    after.given.after = [];
    expect(silenceReasons(after)).toEqual(["no stored row"]);
    const limit = commitOf(ACCEPTED);
    must(must(limit.outcome.parts[0]).limits[0]).result = "pass";
    expect(askedAnswerProblems(limit)).toEqual([
      "part 0 is not answered asked with no limit run, as the gate answers it",
    ]);
    const end = commitOf(ACCEPTED);
    must(DAMAGES[0]).damage(end);
    expect(silenceReasons(end)).toEqual(["the unmapped end"]);
  });

  it("each copy put silent (no row and nothing in written) is accepted, so each fault is a reason to stay silent", () => {
    // The row's own faults (its id, written's clock row, a limit run) are no reason for silence: their copies keep a row
    // the rule reads, so only the copies whose fault is a condition of default 192 are put silent here.
    const conditions = DAMAGES.filter(
      (entry) =>
        ![
          "a row named for another step",
          "written naming the question's clock row too",
          "the asked part with a limit run",
        ].includes(entry.name),
    );
    expect(conditions).toHaveLength(DAMAGES.length - 3);
    for (const { name, damage } of conditions) {
      const copy = commitOf(ACCEPTED);
      damage(copy);
      silenced(copy);
      const taken = takenByV112("gateAndCommit.exchange", copy);
      expect(taken.ok, `${name}: ${taken.why}`).toBe(true);
      expect(resends(copy), name).toEqual([]);
      expect(resendProblems(copy), name).toEqual([]);
      expect(silenceReasons(copy).length, name).toBeGreaterThan(0);
    }
  });

  it("the models and the rule agree on every damaged copy and every copy put silent", () => {
    for (const { name, damage } of DAMAGES) {
      const copy = commitOf(ACCEPTED);
      damage(copy);
      expect(resendProblems(copy).length === 0, name).toBe(resends(copy).length === 0);
      silenced(copy);
      expect(resendProblems(copy).length === 0, `${name}, silent`).toBe(resends(copy).length === 0);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 6. What stays silent (default 198): the unmapped end

describe("tool-api v1.12: what stays silent (default 198)", () => {
  it("commit-s1-02-unmapped-end.json is still answered with no row and nothing written (unmappedEndAsked)", () => {
    const entry = entryOf(UNMAPPED_END);
    expect(entry.expect).toBe("accept");
    expect(entry.rule).toBe("unmappedEndAsked");
    const exchange = commitOf(UNMAPPED_END);
    expect(takenByV112(defOf(entry), exchange).ok).toBe(true);
    expect(rule("unmappedEndAsked")(exchange)).toEqual([]);
    expect(exchange.outcome.end).toBe("asked");
    expect(exchange.outcome.written.outboxRows).toEqual([]);
    expect(exchange.outcome.written.written).toEqual([]);
    expect(exchange.request.input.decided.decide.end).toBe("oneQuestion");
    // Every read refused, so decide kept no part: askedResendsQuestion has no asked part to read here.
    expect(exchange.request.input.decided.decide.parts).toEqual([]);
    expect(resends(exchange)).toEqual([
      "askedResendsQuestion reads a turn with a part decide ended in one question (ask, or oneQuestion)",
    ]);
  });
});
