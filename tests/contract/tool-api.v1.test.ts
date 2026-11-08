// Contract test for K-09, the Tool API (T-088; ops/plan/02-contracts.md K-09 "Contract test" and section 2 item 12;
// contracts/tool-api/README.md "Producers and consumers (02-contracts K-09)", "Named rules", "Fixtures", and each minor
// version's own sections).
//
// This is the fixture part. The contract test has two parts: this one, which reads only the committed schemas, the named
// rules file, the README and the fixtures, and one part per producer or consumer side, added later by a QA side task
// that depends on this task and on that side's build task. SIDE_CHECKS (at the end) is the list where each side is added.
//
// K-09 is frozen at v1 (T-018) and v1.1 (T-050), and each journey adds a minor version that only adds. One
// fixtures/index.json lists every version's fixtures, each entry naming its version. This file holds K-09 v1 and every
// additive minor version's fixtures, as DL-124 settled for K-06 and DL-125 for this shared index: every entry is
// checked against the schema its own `version` names (tool-api.<version>.schema.json, at its $defs entry `def`), and
// entries are selected by version and by what they state, never by a pinned list or count, so a later minor version's
// fixtures join every generic check here when they land. The mends of part 3 are written for the refused fixtures of
// the versions frozen when this part was written (v1 and v1.1); a later version's mends join MENDS with its QA task.
//
// What this part proves:
//   1. every fixture in contracts/tool-api/fixtures/index.json is checked against the schema its version names (the
//      T-003 harness, and again here): accepted ones are accepted, refused ones are refused (by the schema, or after the
//      schema takes them by the named rule their entry gives), none is left out, and the number checked is the number
//      of entries; an accepted fixture is accepted by every later minor version too (a minor version only adds);
//   2. the named rules run, none skipped: each entry's `rule` (tool-api.rules.mjs) runs on its fixture after the schema
//      takes it, and every accepted fixture that states a limit, a step or a clock firing names a rule; the README's
//      contract-test statements are modeled here from the README's own tables (each limit fixture gives its stated
//      outcome; each setup fixture writes its step's keys; limit 6 waits for decide's re-read; each clock fixture keeps
//      the clock turn's rule; each journey 3 key by its one call; the arrival turn), hold on every fixture that states
//      them, agree with the rules file, and each fires on a damaged copy;
//   3. each refusal is tied to its reason (DL-124's mend-then-accept proof): each refused fixture is refused, for the
//      field its entry names (the schema's errors name it, or the rule's one line gives the reason), and its copy put
//      right as the entry and the README say, with that one field changed, is accepted; where the entry names an
//      accepted twin ("as ..."), the mended copy is that twin's request, response or the part the twin shares;
//   4. the schema is not vacuous: removing any one required field, at any depth, from a copy of an accepted fixture
//      makes the copy refused, and so does one field the schema does not know (the required fields are read from the
//      schemas' own `required` lists, along the branch of each anyOf, oneOf and if that the fixture takes);
//   5. what the schema leaves to tests (DL-123, DL-126): a '1 Yes' answered with the texts-off line writes no consent,
//      and a business is told of a STOP with no outbox row exactly when the STOP's call has no turn; each fires on a
//      damaged copy the schema still accepts.
//   What needs a producer or consumer side is on SIDE_CHECKS, not checked here: the Tool API answering each exchange's
//   request with its outcome, the mock generated from the fixtures, and each caller's requests and readings.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { CONTRACTS_ROOT, checkContractFixtures, formatErrors, type FixtureEntry } from "./_harness";

// ---------------------------------------------------------------------------------------------------------------
// The contract's files

const TOOL_API_DIR = path.join(CONTRACTS_ROOT, "tool-api");
const FIXTURES_DIR = path.join(TOOL_API_DIR, "fixtures");
/** Every schema's $id is this base plus its path inside contracts/ (ADR-005; contracts/scripts/lib.mjs). */
const ID_BASE = "https://rosie.invalid/contracts/";

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

/** An index entry; `rule` names a rule of tool-api.rules.mjs (contracts/common/fixtures-index.meta.schema.json). */
type Entry = FixtureEntry & { rule?: string };

const index = readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: Entry[] };
const entries = index.fixtures;
const versions = [...new Set(entries.map((entry) => entry.version))];
const acceptedEntries = entries.filter((entry) => entry.expect === "accept");
const refusedEntries = entries.filter((entry) => entry.expect === "refuse");
const refusedByRule = refusedEntries.filter((entry) => entry.rule !== undefined);
const refusedBySchema = refusedEntries.filter((entry) => entry.rule === undefined);
const entryOf = (file: string): Entry =>
  must(
    entries.find((candidate) => candidate.file === file),
    `the index entry of ${file}`,
  );
const fixture = (file: string): unknown => readJson(path.join(FIXTURES_DIR, ...file.split("/")));

/** A version's major and minor number: v1 is [1, 0], v1.1 is [1, 1]. */
function placeOf(version: string): [number, number] {
  const match = /^v(\d+)(?:\.(\d+))?$/.exec(version);
  if (match === null) throw new Error(`a version this test cannot place: ${version}`);
  return [Number(match[1]), Number(match[2] ?? "0")];
}

/** The versions of K-09's schema files in contracts/tool-api/. */
const SCHEMA_VERSIONS = readdirSync(TOOL_API_DIR)
  .map((name) => /^tool-api\.(v\d+(?:\.\d+)?)\.schema\.json$/.exec(name)?.[1])
  .filter((version): version is string => version !== undefined);

/** The later minor versions of `version` (BP 6.4: a minor version only adds, so it accepts what `version` accepts). */
function laterMinorVersions(version: string): string[] {
  const [major, minor] = placeOf(version);
  return SCHEMA_VERSIONS.filter((other) => {
    const [otherMajor, otherMinor] = placeOf(other);
    return otherMajor === major && otherMinor > minor;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The schemas and the validators

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
/** The folders whose schemas K-09's $refs reach: the harness loads them beside tool-api/. */
const SHARED_FOLDERS = [...new Set([...SCHEMAS.keys()].map((file) => must(file.split("/")[0])))].filter(
  (folder) => folder !== "tool-api",
);
/** Each loaded schema by its $id, for the required-field walk (part 4). */
const SCHEMA_BY_ID = new Map([...SCHEMAS.values()].map((schema) => [String(schema.$id), schema]));

// The strict Ajv 2020-12 setup of the harness (contracts/scripts/lib.mjs) for the checks; the same with every error,
// to read why a refused fixture is refused; and a loose one for the required-field walk, which compiles single
// branches of an anyOf, oneOf or if, where strict mode would miss the "type" their parent states.
const strictAjv = new Ajv2020({ strict: true, strictRequired: false });
const explainAjv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
const looseAjv = new Ajv2020({ strict: false });
for (const schema of SCHEMAS.values()) {
  strictAjv.addSchema(structuredClone(schema));
  explainAjv.addSchema(structuredClone(schema));
  looseAjv.addSchema(structuredClone(schema));
}

const schemaIdOf = (version: string): string => `${ID_BASE}tool-api/tool-api.${version}.schema.json`;
const targetOf = (version: string, def: string | undefined): string =>
  def === undefined ? schemaIdOf(version) : `${schemaIdOf(version)}#/$defs/${def}`;

/** A schema version and the $defs entry a value is checked against (the root when none). */
interface SchemaTarget {
  version: string;
  def?: string | undefined;
}

/** The validator of the schema an entry's version names, at its $defs entry. */
function validatorFor(entry: SchemaTarget, ajv = strictAjv): ValidateFunction {
  const target = targetOf(entry.version, entry.def);
  return must(ajv.getSchema(target), `the schema ${target}`);
}
const accepts = (entry: SchemaTarget, value: unknown): boolean => validatorFor(entry)(value);

// Compile every validator the checks call while the file loads, so no single test carries Ajv's compile time on a
// loaded machine (a resource guard, not part of any check). A schema that cannot be had is left to its entry's test.
for (const entry of entries) {
  try {
    validatorFor(entry);
    if (entry.expect === "refuse" && entry.rule === undefined) validatorFor(entry, explainAjv);
    for (const later of laterMinorVersions(entry.version)) validatorFor({ version: later, def: entry.def });
  } catch {
    // Reported by the entry's own test, which calls validatorFor again.
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The named rules and what the checks read

type Rule = (exchange: unknown) => string[];
const rulesModule = (await import(pathToFileURL(path.join(TOOL_API_DIR, "tool-api.rules.mjs")).href)) as {
  rules: Record<string, Rule>;
  STEP_GIVES: Record<string, readonly string[]>;
  J3_STEP_GIVES: Record<string, readonly string[]>;
  KEY_CALL: Record<string, string>;
  ARRIVAL_MARK: string;
  arrivalTurnId: (eventId: string) => string;
};
const { rules } = rulesModule;
const rule = (name: string): Rule => must(rules[name], `the rule ${name}`);

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
interface Turn {
  id: string;
  handleId: string;
  eventIds: string[];
  traceId: string;
}
interface Safety {
  eventId: string;
  source: string;
  timedOut: boolean;
  outcomes: string[];
}
interface LimitLog {
  limit: number;
  result: string;
  outcome: string | null;
}
interface PartResult {
  part: number;
  result: string;
  limits: LimitLog[];
  stoppedBy: { limit: number; outcome: string; action: string } | null;
  gives: string[];
}
interface Decide {
  reread: boolean;
  reads: { model: string; role: string }[];
  parts: { part: { fields?: { name: string }[] }; outcome: string }[];
}
interface Stated {
  limit?: number;
  outcome?: string;
  action?: string;
  step?: string;
  gives?: string[];
}
interface BusinessTold {
  businessId: string;
  outboxRowId: string | null;
}
interface CoreAction {
  call: string;
  request: { caller: Caller };
}
interface CoreResult {
  call: string;
  response: { repeated?: boolean; businessesTold?: BusinessTold[] } | null;
}
interface Exchange {
  call: string;
  given: { stated: Stated | null };
  request: {
    caller: Caller;
    turn?: Turn | null;
    input?: { kind: string; clockRowId?: string; decided?: { decide: Decide } };
    core?: CoreAction[];
    safety?: Safety;
    handleId?: string;
  };
  outcome: {
    result?: string;
    error?: string;
    repeated?: boolean;
    turnId?: string | null;
    clockRowId?: string;
    parts?: unknown[];
    gives?: string[];
    core?: CoreResult[];
    outcomeId?: string;
    hold?: { version?: number } | null;
    consentId?: string | null;
    textsOff?: unknown;
    businessesTold?: BusinessTold[];
  };
}

const exchangeOf = (file: string): Exchange => structuredClone(fixture(file)) as Exchange;
const acceptedExchanges = (): { file: string; exchange: Exchange }[] =>
  acceptedEntries.map((entry) => ({ file: entry.file, exchange: exchangeOf(entry.file) }));

/** A commit's parts, as limits 1 to 6 left them (README "Limits 1 to 6 at the gate"); none for any other outcome. */
const committedParts = (exchange: Exchange): PartResult[] =>
  exchange.outcome.result === "committed" ? ((exchange.outcome.parts ?? []) as PartResult[]) : [];

/** The keys an exchange's outcome wrote: the call's own gives, or the gives of a commit's committed parts. */
function keysWritten(exchange: Exchange): string[] {
  if (Array.isArray(exchange.outcome.gives)) return exchange.outcome.gives;
  return committedParts(exchange)
    .filter((part) => part.result === "committed")
    .flatMap((part) => part.gives);
}

const sorted = (values: readonly string[]): string[] => [...values].sort();

// ---------------------------------------------------------------------------------------------------------------
// The README's tables the checks read

const README = readFileSync(path.join(TOOL_API_DIR, "README.md"), "utf8");

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
const unticked = (cell: string): string => cell.replaceAll("`", "");

/** README "Limits 1 to 6 at the gate": each limit's actions, each with its one kind (ask, refuse or wait). */
const LIMIT_ACTIONS = new Map(
  tableAfter("### Limits 1 to 6 at the gate").map((cells) => [
    unticked(must(cells[1])),
    { limit: Number(must(cells[0]).split(" ")[0]), kind: must(cells[2]) },
  ]),
);

/** The 11 pf keys S1-11 gives (the README's table says "the 11 pf keys"; MC R3), as the rules file lists them. */
const PF_KEYS = (rulesModule.STEP_GIVES["S1-11"] ?? []).filter((key) => key.startsWith("pf."));

/**
 * README "Each step of journeys 1 and 2 and what saveSetupStep writes for it": each row's steps (its twins in brackets
 * left out) and its gives column, the keys those steps give between them. A row of two steps names what either gives:
 * "S2-27, S2-31" gives on_call, which S2-27 gives and S2-31 does not (A-S2.md's gives column, as STEP_GIVES has it).
 */
const README_STEP_ROWS = tableAfter(
  "Each step of journeys 1 and 2 and what `saveSetupStep` writes for it",
).map((cells) => {
  const gives = must(cells[2]);
  return {
    steps: must(cells[0])
      .replace(/\(.*?\)/g, "")
      .split(",")
      .map((step) => step.trim())
      .filter((step) => step !== ""),
    gives:
      gives === "(none)"
        ? []
        : gives === "the 11 pf keys"
          ? PF_KEYS
          : gives.split(",").map((key) => key.trim()),
  };
});
/** Each step's own keys: the rules file's STEP_GIVES (A-S1.md, A-S2.md), held to the README's rows (part 2). */
const stepKeysOf = (step: string): readonly string[] => rulesModule.STEP_GIVES[step] ?? [];
/** Every key some step of journeys 1 and 2 gives, by the README's table. */
const SETUP_KEYS = new Set(README_STEP_ROWS.flatMap((row) => row.gives));

/** README v1.1 "Each key's one call": each journey 3 key, the steps that give it and the one call that writes it. */
const KEY_ROWS = tableAfter("### Each key's one call").map((cells) => ({
  key: must(cells[0]),
  steps: must(cells[1])
    .split(/[,;]/)
    .map((step) => step.trim()),
  call: unticked(must(cells[3])),
}));
const journeyKeysOf = (step: string): string[] =>
  sorted(KEY_ROWS.filter((row) => row.steps.includes(step)).map((row) => row.key));

// ---------------------------------------------------------------------------------------------------------------
// The README's contract-test statements, modeled from its words and tables. Each returns one line per problem; an
// empty list means the statement holds.

/**
 * README "Limits 1 to 6 at the gate" (02-contracts K-09 "Contract test": each limit fixture gives its stated outcome):
 * the stated action is one the README's table gives that limit, with that kind; exactly one part is stopped, by that
 * limit, kind and action; and its limits log that limit, and no other, as failed with that action.
 */
export function checkStatedOutcome(exchange: Exchange): string[] {
  const stated = exchange.given.stated;
  if (stated?.limit === undefined) return ["given.stated names no limit"];
  const { limit, outcome, action } = stated;
  const problems: string[] = [];
  const row = LIMIT_ACTIONS.get(String(action));
  if (row?.limit !== limit || row.kind !== outcome)
    problems.push(
      `the README's table does not give limit ${String(limit)} the action ${String(action)} of kind ${String(outcome)}`,
    );
  if (exchange.call !== "gateAndCommit" || exchange.outcome.result !== "committed")
    problems.push("a stated outcome is a gateAndCommit that committed");
  const stopped = committedParts(exchange).filter((part) => part.result === "stopped");
  if (stopped.length !== 1) problems.push(`${String(stopped.length)} parts are stopped, not one`);
  for (const part of stopped) {
    const by = part.stoppedBy;
    if (by?.limit !== limit || by.outcome !== outcome || by.action !== action)
      problems.push(`parts[${String(part.part)}] is stopped by ${JSON.stringify(by)}`);
    const failed = part.limits.filter((entry) => entry.result === "fail");
    if (!isDeepStrictEqual(failed, [{ limit, result: "fail", outcome: action }]))
      problems.push(`parts[${String(part.part)}].limits logs ${JSON.stringify(failed)} as failed`);
  }
  return problems;
}

/**
 * README "Limits 1 to 6 at the gate" (arch 02 line 119; arch 06 lines 289, 309; Q-41): limit 6 asks its one question
 * only after decide's one Sonnet re-read (a third read, by Sonnet, in the role reread); before it, a value that fails
 * its words is refused before any write (valueFailsWords), naming parts decide sent to the gate and fields they carry.
 */
export function checkLimit6AfterReread(exchange: Exchange): string[] {
  const input = exchange.request.input;
  if (exchange.call !== "gateAndCommit" || input?.kind !== "decided")
    return ["limit 6's wait is read on a gateAndCommit of decided texts"];
  const decide = must(input.decided).decide;
  const problems: string[] = [];
  const third = decide.reads[2];
  if (decide.reread !== (decide.reads.length === 3 && third?.model === "sonnet" && third.role === "reread"))
    problems.push(`decide.reread is ${String(decide.reread)}, but its reads say otherwise`);
  for (const part of committedParts(exchange)) {
    if (part.stoppedBy?.limit === 6 && !decide.reread)
      problems.push(`parts[${String(part.part)}] asks limit 6's one question before decide's re-read`);
  }
  if (exchange.outcome.error === "valueFailsWords") {
    if (decide.reread) problems.push("valueFailsWords after the re-read: limit 6's one question comes then");
    for (const named of (exchange.outcome.parts ?? []) as { part: number; fields: string[] }[]) {
      const sent = decide.parts[named.part];
      const carried = (sent?.part.fields ?? []).map((field) => field.name);
      if (sent?.outcome !== "go") problems.push(`valueFailsWords names part ${String(named.part)}, not sent`);
      for (const name of named.fields.filter((field) => !carried.includes(field)))
        problems.push(
          `valueFailsWords names the field ${name}, which part ${String(named.part)} does not carry`,
        );
    }
  }
  return problems;
}

/**
 * README "A clock's firing" (QUESTIONS.md NQ-RT-4; K-05 v1 fireClock and default 9; CQ-06): a clock turn on the clock
 * row's handle is called as a turn whose id is caller.turnId and requestId, whose one event id is the clock row's id
 * and whose trace is the caller's; a firing with no turn is called by clockFiring with the clock row's id; it carries no
 * safety outcome, and answers fired for that row and that turn, never committed.
 */
export function checkClockTurn(exchange: Exchange): string[] {
  const { caller, turn, input, core } = exchange.request;
  if (exchange.call !== "gateAndCommit" || input?.kind !== "clock")
    return ["a clock turn is a gateAndCommit on a clock's firing"];
  const clockRowId = must(input.clockRowId);
  const problems: string[] = [];
  if (turn === null || turn === undefined) {
    if (caller.kind !== "clockFiring" || caller.turnId !== null || caller.requestId !== clockRowId)
      problems.push("a firing with no turn is called by clockFiring, keyed by its clock row");
  } else {
    if (caller.kind !== "turn" || caller.turnId !== turn.id || caller.requestId !== turn.id)
      problems.push("a clock turn is called as its turn, keyed by its id");
    if (!isDeepStrictEqual(turn.eventIds, [clockRowId]))
      problems.push("a clock turn's one event id is its row's");
    if (turn.traceId !== caller.traceId) problems.push("a clock turn's trace is the firing's own");
  }
  if ((core ?? []).some((action) => action.call === "recordSafetyOutcome"))
    problems.push("a clock turn carries no text, so no safety outcome");
  const { outcome } = exchange;
  if (outcome.result === "committed") problems.push("a clock's firing answers fired, never committed");
  if (
    outcome.result === "fired" &&
    (outcome.clockRowId !== clockRowId || outcome.turnId !== (turn?.id ?? null))
  )
    problems.push("fired names another clock row or turn");
  return problems;
}

/**
 * README "Each step of journeys 1 and 2" (02-contracts K-09: each call writes the key its step gives; A-keys.md): an
 * exchange that states a step of journeys 1 and 2 states every key that step gives, states only keys of those journeys
 * (an automatic step its walk passes gives the rest: arch 03 line 191), and its outcome wrote exactly them.
 */
export function checkSetupKeys(exchange: Exchange): string[] {
  const stated = exchange.given.stated;
  const step = stated?.step;
  if (step === undefined || !/^S[12]-/.test(step)) return ["given.stated names no step of journeys 1 and 2"];
  const statedKeys = stated?.gives ?? [];
  const problems: string[] = [];
  for (const key of stepKeysOf(step))
    if (!statedKeys.includes(key)) problems.push(`${step} gives ${key}, which the fixture does not state`);
  for (const key of statedKeys)
    if (!SETUP_KEYS.has(key)) problems.push(`${key} is no key a step of journeys 1 and 2 gives`);
  if (!isDeepStrictEqual(sorted(keysWritten(exchange)), sorted(statedKeys)))
    problems.push(`the outcome wrote [${keysWritten(exchange).join(", ")}], not [${statedKeys.join(", ")}]`);
  return problems;
}

/**
 * README v1.1 "Each key's one call" (02-contracts section 8): an exchange that states a journey 3 step states exactly
 * the keys the README's table gives that step, its outcome wrote exactly them, and, made alone, its call is the one
 * call the table names for each of them.
 */
export function checkJourneyKeys(exchange: Exchange): string[] {
  const stated = exchange.given.stated;
  const step = stated?.step ?? "";
  const own = journeyKeysOf(step);
  if (own.length === 0) return [`${step} is no journey 3 step that gives a key`];
  const problems: string[] = [];
  if (!isDeepStrictEqual(sorted(stated?.gives ?? []), own))
    problems.push(`${step} gives [${own.join(", ")}], not the stated [${(stated?.gives ?? []).join(", ")}]`);
  if (!isDeepStrictEqual(sorted(keysWritten(exchange)), own))
    problems.push(`the outcome wrote [${keysWritten(exchange).join(", ")}], not [${own.join(", ")}]`);
  if (exchange.call !== "gateAndCommit") {
    for (const row of KEY_ROWS.filter((candidate) => own.includes(candidate.key)))
      if (row.call !== exchange.call)
        problems.push(`${row.key} is written by ${row.call}, not ${exchange.call}`);
  }
  return problems;
}

/** README default 36: an arrival turn's id is the SHA-256 of the UTF-8 bytes of "arrival:" and the event id, in hex. */
const arrivalIdOf = (eventId: string): string =>
  createHash("sha256").update(`arrival:${eventId}`, "utf8").digest("hex");
/** A safety read that holds danger (any outcome but No) or timed out (arch 02 line 111). */
const holdsDangerOrTimedOut = (safety: Safety): boolean =>
  safety.timedOut || safety.outcomes.some((outcome) => outcome !== "No");

/**
 * README v1.1 "The safety record on arrival" (defaults 36, 37, 5): the handle actor records only a text whose read holds
 * danger or timed out, at once, in the text's own arrival turn (its id that text's arrival id, as caller.turnId and
 * requestId; its one event id, handle and trace the text's); the record gives safe and writes its hold at version 1;
 * the at-once release runs under the same kind of id. The batch turn the text joins has an id of its own, never one of
 * its texts' arrival ids, so it commits (repeated false) while each text's record in it answers repeated.
 */
export function checkArrivalTurn(exchange: Exchange): string[] {
  const { request, outcome } = exchange;
  const { caller } = request;
  const problems: string[] = [];
  if (exchange.call === "gateAndCommit") {
    const turn = must(request.turn, "the batch turn");
    for (const eventId of turn.eventIds.filter((id) => arrivalIdOf(id) === turn.id))
      problems.push(`the batch turn's id is ${eventId}'s arrival id`);
    if (caller.kind !== "turn" || caller.turnId !== turn.id || caller.requestId !== turn.id)
      problems.push("the batch turn is called as its own turn");
    if (outcome.result !== "committed" || outcome.repeated !== false || outcome.turnId !== turn.id)
      problems.push("the batch commits under its own id, never as a repeat");
    const records = (outcome.core ?? []).filter((result) => result.call === "recordSafetyOutcome");
    if (records.length === 0) problems.push("the batch carries its texts' safety records");
    if (records.some((result) => result.response?.repeated !== true))
      problems.push("a text recorded on arrival answers repeated in its batch");
    return problems;
  }
  if (caller.kind !== "actorOnArrival") return ["an arrival call is made by actorOnArrival"];
  if (caller.requestId !== caller.turnId || !/^[0-9a-f]{64}$/.test(caller.turnId))
    problems.push("an arrival call's turnId and requestId are its arrival turn's id");
  if (exchange.call === "releaseSafetyHold") return problems;
  const turn = must(request.turn, "the arrival turn");
  const safety = must(request.safety, "the safety read");
  if (turn.id !== arrivalIdOf(safety.eventId) || turn.id !== caller.turnId)
    problems.push(`the arrival turn's id is not ${safety.eventId}'s arrival id`);
  if (!isDeepStrictEqual(turn.eventIds, [safety.eventId]))
    problems.push("its one event id is the text's own");
  if (turn.handleId !== request.handleId || turn.traceId !== caller.traceId)
    problems.push("its handle and trace are the text's own");
  if (safety.source !== "text") problems.push("only a text arrives at the handle actor");
  if (!holdsDangerOrTimedOut(safety))
    problems.push("a read of No has no arrival record: it rides in the turn its text joins");
  if (!isDeepStrictEqual(outcome.gives, ["safe"])) problems.push("the record gives safe");
  if (outcome.repeated === false && outcome.hold !== null && outcome.hold?.version !== 1)
    problems.push("a hold the record wrote is at version 1");
  return problems;
}

/**
 * DL-123 and DL-126 (T-050's security note a, for this test): '1 Yes' answered with the texts-off line writes no
 * consent (README default 50: only START or a fresh yes from that number turns texts back on). The schema's anyOf takes
 * both, so this test holds it.
 */
export function checkTextsOffWritesNoConsent(exchange: Exchange): string[] {
  const { outcome } = exchange;
  if (
    exchange.call !== "confirmBusinessBooking" ||
    outcome.textsOff === null ||
    outcome.textsOff === undefined
  )
    return [];
  return outcome.consentId === null
    ? []
    : [`the texts-off answer writes the consent ${String(outcome.consentId)}`];
}

/** Each STOP's caller with the businesses it told (README default 50), alone or as a core action of a turn. */
function stopNotices(exchange: Exchange): { caller: Caller; told: BusinessTold[] }[] {
  if (exchange.call === "recordStopOrStart")
    return [{ caller: exchange.request.caller, told: exchange.outcome.businessesTold ?? [] }];
  if (exchange.call !== "gateAndCommit") return [];
  return (exchange.request.core ?? []).flatMap((action, k) => {
    const result = exchange.outcome.core?.[k];
    return action.call === "recordStopOrStart" && result?.call === action.call
      ? [{ caller: action.request.caller, told: result.response?.businessesTold ?? [] }]
      : [];
  });
}

/**
 * DL-123 and DL-126 (T-050's security note b, for this test): a business is told of a STOP with no outbox row
 * (businessesTold[].outboxRowId null) exactly when the STOP's call has no turn: a call with no turn writes no outbox
 * row and tells each business through a clock row (README default 56, open gap 43), and a STOP in a turn writes the
 * notice in its own commit (default 50).
 */
export function checkBusinessesToldByCaller(exchange: Exchange): string[] {
  const problems: string[] = [];
  for (const { caller, told } of stopNotices(exchange)) {
    const inTurn = caller.kind === "turn" || caller.turnId !== null;
    for (const business of told) {
      if (inTurn && business.outboxRowId === null)
        problems.push(`${business.businessId} is told with no outbox row by a STOP in a turn`);
      if (!inTurn && business.outboxRowId !== null)
        problems.push(`${business.businessId} is told by an outbox row a STOP with no turn cannot write`);
    }
  }
  return problems;
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

/** A copy of `value` without the property at `where`. */
function without(value: unknown, where: Path): unknown {
  const copy = structuredClone(value);
  Reflect.deleteProperty(getAt(copy, where.slice(0, -1)) as object, must(where.at(-1)));
  return copy;
}

/** Every path to a property inside a plain object of `value` (root properties included), arrays entered. */
function propertyPaths(value: unknown, prefix: Path = []): Path[] {
  if (Array.isArray(value)) return value.flatMap((item: unknown, at) => propertyPaths(item, [...prefix, at]));
  if (!isObj(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    [...prefix, key],
    ...propertyPaths(child, [...prefix, key]),
  ]);
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

/** The JSON pointer Ajv names an instance path by. */
const pointerOf = (where: Path): string =>
  where.map((step) => `/${String(step).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");

// ---------------------------------------------------------------------------------------------------------------
// The required-field walk (part 4): the fields a schema requires of a value, read from the schemas' own `required`
// lists along the branch the value takes at each anyOf, oneOf and if.

/** A place in a loaded schema: the schema's $id and a JSON pointer into it. */
interface Place {
  doc: string;
  pointer: string;
}

const placeName = (place: Place): string => `${place.doc}#${place.pointer}`;

function nodeAt(place: Place): unknown {
  let node: unknown = must(SCHEMA_BY_ID.get(place.doc), `the schema ${place.doc}`);
  if (place.pointer === "") return node;
  for (const part of place.pointer.slice(1).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    node = Array.isArray(node) ? node[Number(key)] : isObj(node) ? node[key] : undefined;
    if (node === undefined) throw new Error(`${placeName(place)} does not exist`);
  }
  return node;
}

const childOf = (place: Place, ...steps: (string | number)[]): Place => ({
  doc: place.doc,
  pointer: `${place.pointer}${pointerOf(steps)}`,
});

function refPlace(ref: string, from: Place): Place {
  const url = new URL(ref, from.doc);
  const pointer = decodeURIComponent(url.hash.slice(1));
  url.hash = "";
  return { doc: url.href, pointer };
}

const looseValidators = new Map<string, ValidateFunction>();
/** Whether the schema at `place` takes `value` (the loose validator: only which branch applies is asked). */
function takes(place: Place, value: unknown): boolean {
  const key = place.pointer === "" ? place.doc : placeName(place);
  let validate = looseValidators.get(key);
  if (validate === undefined) {
    validate = must(looseAjv.getSchema(key), `a validator for ${key}`);
    looseValidators.set(key, validate);
  }
  return validate(value);
}

// JSON Schema 2020-12 keywords that hold no subschema a required field could sit in: annotations, assertions on the
// value itself, and applicators that only refuse (not, contains, propertyNames).
const LEAF_KEYWORDS = new Set([
  "$schema",
  "$comment",
  "$defs",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "type",
  "enum",
  "const",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "not",
  "contains",
  "propertyNames",
]);
// The keywords the walk follows.
const WALKED_KEYWORDS = new Set([
  "$ref",
  "allOf",
  "anyOf",
  "oneOf",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "dependentRequired",
  "properties",
  "patternProperties",
  "additionalProperties",
  "prefixItems",
  "items",
  "required",
]);

const keyOf = (where: Path): string => JSON.stringify(where);

/**
 * The paths (as keyOf strings) of the fields the schema at `place` requires of `value`, found at `at`: every `required`
 * name of every subschema that applies to the value, following $ref, allOf, the then or else an if picks, the
 * dependentSchemas of fields present, properties and items. At an anyOf or oneOf, a field counts only when every branch
 * the value takes requires it. A keyword the walk cannot read fails loudly.
 */
function requiredIn(place: Place, value: unknown, at: Path): Set<string> {
  const node = nodeAt(place);
  const found = new Set<string>();
  if (typeof node === "boolean") return found;
  if (!isObj(node)) throw new Error(`${placeName(place)} is no schema`);
  const addAll = (more: Set<string>): void => {
    for (const key of more) found.add(key);
  };
  for (const [keyword, setting] of Object.entries(node)) {
    if (LEAF_KEYWORDS.has(keyword) || WALKED_KEYWORDS.has(keyword)) continue;
    if (keyword === "$id" && place.pointer === "") continue;
    if ((keyword === "unevaluatedProperties" || keyword === "unevaluatedItems") && setting === false)
      continue;
    throw new Error(`${placeName(place)}: the required-field walk cannot read "${keyword}"`);
  }
  if (typeof node.$ref === "string") addAll(requiredIn(refPlace(node.$ref, place), value, at));
  if (Array.isArray(node.allOf))
    node.allOf.forEach((_branch, k) => {
      addAll(requiredIn(childOf(place, "allOf", k), value, at));
    });
  for (const keyword of ["anyOf", "oneOf"]) {
    const branches = node[keyword];
    if (!Array.isArray(branches)) continue;
    const taken = branches
      .map((_branch, k) => childOf(place, keyword, k))
      .filter((branch) => takes(branch, value));
    if (taken.length === 0)
      throw new Error(`${placeName(place)}: no ${keyword} branch takes ${pointerOf(at)}`);
    const [first, ...rest] = taken.map((branch) => requiredIn(branch, value, at));
    for (const key of must(first)) if (rest.every((set) => set.has(key))) found.add(key);
  }
  if (node.if !== undefined) {
    const branch = takes(childOf(place, "if"), value) ? "then" : "else";
    if (node[branch] !== undefined) addAll(requiredIn(childOf(place, branch), value, at));
  }
  if (isObj(value)) {
    const present = (name: unknown): name is string => typeof name === "string" && Object.hasOwn(value, name);
    for (const name of Array.isArray(node.required) ? node.required : []) {
      if (!present(name)) throw new Error(`${placeName(place)} requires ${String(name)} at ${pointerOf(at)}`);
      found.add(keyOf([...at, name]));
    }
    if (isObj(node.dependentRequired)) {
      for (const [name, names] of Object.entries(node.dependentRequired)) {
        if (!present(name) || !Array.isArray(names)) continue;
        for (const other of names) if (present(other)) found.add(keyOf([...at, other]));
      }
    }
    if (isObj(node.dependentSchemas)) {
      for (const name of Object.keys(node.dependentSchemas).filter(present))
        addAll(requiredIn(childOf(place, "dependentSchemas", name), value, at));
    }
    const properties = isObj(node.properties) ? node.properties : {};
    const patterns = isObj(node.patternProperties) ? Object.keys(node.patternProperties) : [];
    for (const [name, child] of Object.entries(value)) {
      let matched = Object.hasOwn(properties, name);
      if (matched) addAll(requiredIn(childOf(place, "properties", name), child, [...at, name]));
      for (const pattern of patterns.filter((candidate) => new RegExp(candidate, "u").test(name))) {
        matched = true;
        addAll(requiredIn(childOf(place, "patternProperties", pattern), child, [...at, name]));
      }
      if (!matched && isObj(node.additionalProperties))
        addAll(requiredIn(childOf(place, "additionalProperties"), child, [...at, name]));
    }
  }
  if (Array.isArray(value)) {
    const prefix = Array.isArray(node.prefixItems) ? node.prefixItems.length : 0;
    value.forEach((item: unknown, k) => {
      if (k < prefix) addAll(requiredIn(childOf(place, "prefixItems", k), item, [...at, k]));
      else if (isObj(node.items)) addAll(requiredIn(childOf(place, "items"), item, [...at, k]));
    });
  }
  return found;
}

/** The required paths of an entry's fixture, under the schema its version names, at its $defs entry. */
function requiredPathsOf(entry: Entry): Path[] {
  const place: Place = {
    doc: schemaIdOf(entry.version),
    pointer: entry.def === undefined ? "" : pointerOf(["$defs", entry.def]),
  };
  return [...requiredIn(place, fixture(entry.file), [])].map((key) => JSON.parse(key) as Path);
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Every fixture of the index, each against the schema its version names

// The harness checks the schema only: an entry that names a `rule` and is marked refuse passes the schema and is
// refused by the rule, so the harness reports it as accepted-but-marked-refuse. Those entries are checked by the rule
// (part 2); every other entry must be ok in the harness.
const report = checkContractFixtures("tool-api", { sharedFolders: SHARED_FOLDERS });

describe("tool-api fixtures: the index and the count", () => {
  it("checks as many fixtures as fixtures/index.json lists, none left out", () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(report.problems).toEqual([]);
    expect(report.entries.map((result) => result.file)).toEqual(entries.map((entry) => entry.file));
    expect(report.seedRows).toBe(0);
    expect(acceptedEntries.length + refusedBySchema.length + refusedByRule.length).toBe(entries.length);
    const onDisk = readdirSync(FIXTURES_DIR, { recursive: true, encoding: "utf8" })
      .map((file) => file.split(path.sep).join("/"))
      .filter((file) => file.endsWith(".json") && file !== "index.json");
    expect(sorted(onDisk)).toEqual(sorted(entries.map((entry) => entry.file)));
  });

  it("checks exactly as many fixtures as fixtures/index.json has entries, each by its own version's schema", () => {
    let checked = 0;
    for (const entry of entries) {
      const exchange = fixture(entry.file);
      const valid = accepts(entry, exchange);
      if (entry.rule === undefined) {
        expect(valid, entry.file).toBe(entry.expect === "accept");
      } else {
        expect(valid, `${entry.file} passes the schema, so its rule alone decides it`).toBe(true);
        expect(rule(entry.rule)(exchange).length === 0, entry.file).toBe(entry.expect === "accept");
      }
      checked += 1;
    }
    expect(checked).toBe(entries.length);
    expect(report.entries).toHaveLength(checked);
  });

  it("accepts every entry marked accept and refuses every entry marked refuse, by the schema or by its rule", () => {
    expect(report.passes).toBe(acceptedEntries.length);
    expect(report.refusals).toBe(refusedBySchema.length);
    for (const result of report.entries) {
      const entry = entryOf(result.file);
      if (entry.expect === "refuse" && entry.rule !== undefined) {
        // Passes the schema, so the rule alone decides it; the harness's "must be refused" line is for the schema.
        expect(result.outcome, `${result.file} must pass the schema`).toBe("accepted");
      } else {
        expect(result.problems, result.file).toEqual([]);
        expect(result.outcome, result.file).toBe(result.expect === "accept" ? "accepted" : "refused");
      }
    }
  });

  for (const entry of entries) {
    const how =
      entry.expect === "accept"
        ? "accepts"
        : entry.rule === undefined
          ? "refuses"
          : "passes the schema, refused by its rule:";
    it(`${how} ${entry.file} (${entry.version}, ${String(entry.def)})`, () => {
      const result = must(report.entries.find((candidate) => candidate.file === entry.file));
      expect(result.schema).toBe(`tool-api.${entry.version}.schema.json`);
      if (entry.expect === "refuse" && entry.rule !== undefined) {
        expect(result.outcome).toBe("accepted");
        expect(rule(entry.rule)(exchangeOf(entry.file)).length).toBeGreaterThan(0);
      } else {
        expect(result.problems).toEqual([]);
        expect(result.ok).toBe(true);
      }
    });
  }

  it("checks each entry against the schema its version names, and holds every version frozen.json names", () => {
    const frozen = (readJson(path.join(TOOL_API_DIR, "frozen.json")) as { frozen: string[] }).frozen;
    expect(frozen).toEqual(expect.arrayContaining(["v1", "v1.1"]));
    for (const version of frozen) expect(versions, version).toContain(version);
    for (const version of versions) {
      expect(SCHEMA_VERSIONS, `tool-api.${version}.schema.json`).toContain(version);
      expect(
        acceptedEntries.filter((entry) => entry.version === version).length,
        `${version} has accepted fixtures`,
      ).toBeGreaterThan(0);
    }
    for (const result of report.entries)
      expect(result.schema, result.file).toBe(`tool-api.${result.version}.schema.json`);
  });

  it("names a $defs entry on every fixture, an exchange on every accepted one, of the call the fixture names", () => {
    for (const entry of entries) {
      expect(entry.def, entry.file).toBeDefined();
      if (entry.expect === "accept") {
        expect(entry.def, entry.file).toBe(`${exchangeOf(entry.file).call}.exchange`);
      }
    }
  });

  it("accepts every accepted fixture by every later minor version too (a minor version only adds)", () => {
    let checked = 0;
    for (const entry of acceptedEntries) {
      for (const later of laterMinorVersions(entry.version)) {
        const validate = validatorFor({ version: later, def: entry.def });
        expect(
          validate(fixture(entry.file)),
          `${entry.file} under ${later}: ${formatErrors(validate.errors).join("; ")}`,
        ).toBe(true);
        checked += 1;
      }
    }
    if (SCHEMA_VERSIONS.length > 1) expect(checked).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The named rules, run for every entry that names one, and the README's statements modeled here

describe("tool-api fixtures: the named rules are run, none skipped", () => {
  it("has every rule an entry names in tool-api.rules.mjs, the four of v1 and the two v1.1 adds among them", () => {
    expect(Object.keys(rules)).toEqual(
      expect.arrayContaining([
        "statedOutcome",
        "givesStepKeys",
        "rereadBeforeQuestion",
        "clockTurn",
        "givesJourneyKeys",
        "arrivalTurn",
      ]),
    );
    for (const entry of entries) {
      if (entry.rule !== undefined) expect(typeof rules[entry.rule], entry.file).toBe("function");
    }
  });

  for (const entry of entries) {
    if (entry.rule === undefined) continue;
    const name = entry.rule;
    it(`${entry.file}: the schema accepts it and ${name} ${entry.expect === "accept" ? "passes" : "refuses"} it`, () => {
      const exchange = fixture(entry.file);
      const validate = validatorFor(entry);
      expect(validate(exchange), `${entry.file}: ${formatErrors(validate.errors).join("; ")}`).toBe(true);
      const problems = rule(name)(exchange);
      if (entry.expect === "accept") expect(problems, entry.file).toEqual([]);
      else expect(problems.length, `${entry.file} must be refused by ${name}`).toBeGreaterThan(0);
    });
  }

  it("names a rule on every accepted fixture that states a limit, a step or a clock firing, or is made on arrival", () => {
    for (const { file, exchange } of acceptedExchanges()) {
      const named = entryOf(file).rule;
      const stated = exchange.given.stated;
      if (stated !== null) expect(named, `${file} states ${JSON.stringify(stated)}`).toBeDefined();
      if (stated?.limit !== undefined) expect(named, file).toBe("statedOutcome");
      if (stated?.step !== undefined && /^S[12]-/.test(stated.step))
        expect(named, file).toBe("givesStepKeys");
      // An arrival record states A3-22's safe and names arrivalTurn: part 2's model checks its keys too.
      if (stated?.step !== undefined && /^[AB]3-/.test(stated.step))
        expect(["givesJourneyKeys", "arrivalTurn"], file).toContain(named);
      if (exchange.request.input?.kind === "clock") expect(named, file).toBe("clockTurn");
      if (exchange.request.caller.kind === "actorOnArrival") expect(named, file).toBe("arrivalTurn");
    }
  });

  it("holds the README's tables to the rules file: each step's keys, each journey 3 key's steps and its one call", () => {
    expect(PF_KEYS).toHaveLength(11);
    expect(README_STEP_ROWS.length).toBeGreaterThan(25);
    for (const row of README_STEP_ROWS) {
      const between = new Set(row.steps.flatMap((step) => stepKeysOf(step)));
      expect(sorted([...between]), row.steps.join(", ")).toEqual(sorted(row.gives));
    }
    const rowSteps = new Set(README_STEP_ROWS.flatMap((row) => row.steps));
    for (const step of Object.keys(rulesModule.STEP_GIVES)) expect(rowSteps.has(step), step).toBe(true);
    // S2-31 sets nobody on call and gives no key (A-S2.md), though its row with S2-27 names on_call.
    expect(stepKeysOf("S2-27")).toEqual(["on_call"]);
    expect(stepKeysOf("S2-31")).toEqual([]);
    expect(KEY_ROWS.map((row) => row.key).sort()).toEqual(sorted(Object.keys(rulesModule.KEY_CALL)));
    for (const row of KEY_ROWS) expect(row.call, row.key).toBe(rulesModule.KEY_CALL[row.key]);
    const steps = new Set(KEY_ROWS.flatMap((row) => row.steps));
    expect(sorted([...steps])).toEqual(sorted(Object.keys(rulesModule.J3_STEP_GIVES)));
    for (const step of steps)
      expect(journeyKeysOf(step), step).toEqual(sorted(rulesModule.J3_STEP_GIVES[step] ?? []));
    expect(rulesModule.ARRIVAL_MARK).toBe("arrival:");
  });

  it("holds the README's limit table to its kinds: ask, refuse and wait, with an action of each limit 1 to 6", () => {
    expect(new Set([...LIMIT_ACTIONS.values()].map((row) => row.kind))).toEqual(
      new Set(["ask", "refuse", "wait"]),
    );
    expect(new Set([...LIMIT_ACTIONS.values()].map((row) => row.limit))).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(LIMIT_ACTIONS.get("freshReadBack")).toEqual({ limit: 3, kind: "ask" });
    expect(LIMIT_ACTIONS.get("oneQuestion")).toEqual({ limit: 6, kind: "ask" });
  });
});

describe("tool-api fixtures: the README's contract-test statements, modeled here, hold and agree with the rules", () => {
  const stating = (test: (exchange: Exchange) => boolean): { file: string; exchange: Exchange }[] =>
    acceptedExchanges().filter(({ exchange }) => test(exchange));

  it("each limit fixture gives its stated outcome (statedOutcome)", () => {
    const limitFixtures = stating((exchange) => exchange.given.stated?.limit !== undefined);
    expect(new Set(limitFixtures.map(({ exchange }) => exchange.given.stated?.limit))).toEqual(
      new Set([1, 2, 3, 4, 5, 6]),
    );
    for (const { file, exchange } of limitFixtures) {
      expect(checkStatedOutcome(exchange), file).toEqual([]);
      expect(rule("statedOutcome")(exchange), file).toEqual([]);
    }
  });

  it("each stated outcome fires on a damaged copy: another action, a second stopped part, another failed limit", () => {
    const action = exchangeOf("commit-limit-3-no-exact-yes.json");
    setAt(action, ["given", "stated", "action"], "safeDefault");
    expect(checkStatedOutcome(action).length).toBeGreaterThan(0);
    expect(rule("statedOutcome")(action).length).toBeGreaterThan(0);
    const kind = exchangeOf("commit-limit-3-no-exact-yes.json");
    setAt(kind, ["given", "stated", "outcome"], "wait");
    expect(checkStatedOutcome(kind)).toEqual([
      "the README's table does not give limit 3 the action freshReadBack of kind wait",
      expect.stringContaining("parts[0] is stopped by"),
    ]);
    const twice = exchangeOf("commit-limit-2-owner-rule.json");
    const parts = must(twice.outcome.parts);
    parts.push({ ...(structuredClone(parts[0]) as Obj), part: 1 });
    expect(checkStatedOutcome(twice)).toContain("2 parts are stopped, not one");
    expect(rule("statedOutcome")(twice).length).toBeGreaterThan(0);
    const logged = exchangeOf("commit-limit-5-taken.json");
    const limits = must(committedParts(logged)[0]).limits;
    for (const entry of limits) if (entry.result === "fail") entry.outcome = "nothingBooked";
    expect(checkStatedOutcome(logged).length).toBeGreaterThan(0);
    expect(rule("statedOutcome")(logged).length).toBeGreaterThan(0);
  });

  it("limit 6 waits for decide's re-read on every gate fixture of decided texts (rereadBeforeQuestion)", () => {
    const decided = stating(
      (exchange) => exchange.call === "gateAndCommit" && exchange.request.input?.kind === "decided",
    );
    expect(decided.map(({ file }) => file)).toEqual(
      expect.arrayContaining(["commit-limit-6-reread-first.json", "commit-limit-6-value-fails.json"]),
    );
    for (const { file, exchange } of decided) {
      expect(checkLimit6AfterReread(exchange), file).toEqual([]);
      expect(rule("rereadBeforeQuestion")(exchange), file).toEqual([]);
    }
  });

  it("limit 6's wait fires on damaged copies: the question before the re-read, valueFailsWords after it, a field not carried", () => {
    const early = exchangeOf("commit-limit-6-value-fails.json");
    const decide = must(early.request.input?.decided).decide;
    decide.reread = false;
    decide.reads.pop();
    expect(checkLimit6AfterReread(early)).toEqual([
      "parts[0] asks limit 6's one question before decide's re-read",
    ]);
    expect(rule("rereadBeforeQuestion")(early)).toEqual([
      "parts[0] is stopped by limit 6 although decide.reread is not true",
    ]);
    const late = exchangeOf("commit-limit-6-reread-first.json");
    const lateDecide = must(late.request.input?.decided).decide;
    lateDecide.reread = true;
    lateDecide.reads.push({ ...must(lateDecide.reads[0]), model: "sonnet", role: "reread" });
    expect(checkLimit6AfterReread(late)).toEqual([
      "valueFailsWords after the re-read: limit 6's one question comes then",
    ]);
    expect(rule("rereadBeforeQuestion")(late).length).toBeGreaterThan(0);
    const field = exchangeOf("commit-limit-6-reread-first.json");
    setAt(field, ["outcome", "parts", 0, "fields"], ["price"]);
    expect(checkLimit6AfterReread(field)).toEqual([
      "valueFailsWords names the field price, which part 0 does not carry",
    ]);
    expect(rule("rereadBeforeQuestion")(field).length).toBeGreaterThan(0);
  });

  it("each clock fixture keeps the clock turn's rule (clockTurn), and it fires on damaged copies", () => {
    const clocks = stating((exchange) => exchange.request.input?.kind === "clock");
    expect(clocks.length).toBeGreaterThan(0);
    for (const { file, exchange } of clocks) {
      expect(checkClockTurn(exchange), file).toEqual([]);
      expect(rule("clockTurn")(exchange), file).toEqual([]);
    }
    const event = exchangeOf("clock-staff-invite-48h.json");
    setAt(event, ["request", "turn", "eventIds"], ["evt-sam-0001"]);
    expect(checkClockTurn(event)).toEqual(["a clock turn's one event id is its row's"]);
    expect(rule("clockTurn")(event).length).toBeGreaterThan(0);
    const committed = exchangeOf("clock-staff-invite-48h.json");
    setAt(committed, ["outcome", "result"], "committed");
    expect(checkClockTurn(committed)).toEqual(["a clock's firing answers fired, never committed"]);
    expect(rule("clockTurn")(committed).length).toBeGreaterThan(0);
    const turnless = exchangeOf("clock-staff-invite-48h.json");
    setAt(turnless, ["request", "turn"], null);
    expect(checkClockTurn(turnless)).toEqual([
      "a firing with no turn is called by clockFiring, keyed by its clock row",
      "fired names another clock row or turn",
    ]);
    expect(rule("clockTurn")(turnless).length).toBeGreaterThan(0);
  });

  it("each setup fixture writes its step's keys (givesStepKeys), by the README's table", () => {
    const setups = stating((exchange) => /^S[12]-/.test(exchange.given.stated?.step ?? ""));
    expect(setups.length).toBeGreaterThan(10);
    for (const { file, exchange } of setups) {
      expect(checkSetupKeys(exchange), file).toEqual([]);
      expect(rule("givesStepKeys")(exchange), file).toEqual([]);
    }
    const commit = exchangeOf("commit-s1-02.json");
    expect(sorted(keysWritten(commit))).toEqual(sorted(["kinds", ...PF_KEYS]));
  });

  it("the setup keys fire on damaged copies: a key left out, a key of no setup step, a key not written", () => {
    const left = exchangeOf("setup-s1-29-terms.json");
    setAt(left, ["given", "stated", "gives"], ["terms"]);
    setAt(left, ["outcome", "gives"], ["terms"]);
    expect(checkSetupKeys(left)).toEqual(["S1-29 gives bill_card, which the fixture does not state"]);
    expect(rule("givesStepKeys")(left).length).toBeGreaterThan(0);
    const foreign = exchangeOf("setup-s1-27-stripe.json");
    setAt(foreign, ["given", "stated", "gives"], ["stripe", "request"]);
    setAt(foreign, ["outcome", "gives"], ["stripe", "request"]);
    expect(checkSetupKeys(foreign)).toEqual(["request is no key a step of journeys 1 and 2 gives"]);
    expect(rule("givesStepKeys")(foreign).length).toBeGreaterThan(0);
    const unwritten = exchangeOf("take-bookings.json");
    setAt(unwritten, ["outcome", "gives"], []);
    expect(checkSetupKeys(unwritten)).toEqual(["the outcome wrote [], not [staff_live]"]);
    expect(rule("givesStepKeys")(unwritten).length).toBeGreaterThan(0);
  });

  it("each journey 3 fixture writes its step's keys by the key's one call (givesJourneyKeys), by the README's table", () => {
    // Every fixture that states a journey 3 step, the arrival records (whose entries name arrivalTurn) included.
    const journey = stating((exchange) => /^[AB]3-/.test(exchange.given.stated?.step ?? ""));
    expect(journey.length).toBeGreaterThan(5);
    for (const { file, exchange } of journey) {
      expect(checkJourneyKeys(exchange), file).toEqual([]);
      expect(rule("givesJourneyKeys")(exchange), file).toEqual([]);
    }
    const otherCall = exchangeOf("j3-open-request-agent.json");
    otherCall.call = "confirmBusinessBooking";
    expect(checkJourneyKeys(otherCall)).toEqual([
      "request is written by openRequest, not confirmBusinessBooking",
    ]);
    expect(rule("givesJourneyKeys")(otherCall).length).toBeGreaterThan(0);
    const fewer = exchangeOf("j3-confirm-business-booking-yes.json");
    setAt(fewer, ["outcome", "gives"], ["who_for", "times", "customer"]);
    expect(checkJourneyKeys(fewer)).toEqual([
      "the outcome wrote [who_for, times, customer], not [customer, reach_by, times, who_for]",
    ]);
    expect(rule("givesJourneyKeys")(fewer).length).toBeGreaterThan(0);
  });

  it("each arrival fixture keeps the arrival turn (arrivalTurn), its id computed here from the event id", () => {
    const arrivals = acceptedEntries.filter((entry) => entry.rule === "arrivalTurn");
    expect(arrivals.length).toBeGreaterThan(0);
    for (const entry of arrivals) {
      const exchange = exchangeOf(entry.file);
      expect(checkArrivalTurn(exchange), entry.file).toEqual([]);
      expect(rule("arrivalTurn")(exchange), entry.file).toEqual([]);
      for (const eventId of exchange.request.turn?.eventIds ?? [])
        expect(rulesModule.arrivalTurnId(eventId), eventId).toBe(arrivalIdOf(eventId));
    }
    expect(arrivalIdOf("evt-alex-0202")).toBe(
      "bbf088c8c89cea1fde8ac199403e49cb5d7312eeadcc2ec7e4b305e6d1c8b3c1",
    );
  });

  it("the arrival turn fires on damaged copies: a No read, another turn id, a batch under the arrival id", () => {
    const no = exchangeOf("j3-safety-arrival-emergency.json");
    setAt(no, ["request", "safety", "outcomes"], ["No"]);
    expect(checkArrivalTurn(no)).toEqual([
      "a read of No has no arrival record: it rides in the turn its text joins",
    ]);
    expect(rule("arrivalTurn")(no).length).toBeGreaterThan(0);
    const id = exchangeOf("j3-safety-arrival-threat.json");
    const otherId = arrivalIdOf("evt-alex-9999");
    setAt(id, ["request", "turn", "id"], otherId);
    setAt(id, ["request", "caller", "turnId"], otherId);
    setAt(id, ["request", "caller", "requestId"], otherId);
    expect(checkArrivalTurn(id)).toEqual([expect.stringContaining("the arrival turn's id is not")]);
    expect(rule("arrivalTurn")(id).length).toBeGreaterThan(0);
    const batch = exchangeOf("j3-safety-arrival-batch-turn.json");
    const eventId = must(batch.request.turn?.eventIds[0]);
    setAt(batch, ["request", "turn", "id"], arrivalIdOf(eventId));
    expect(checkArrivalTurn(batch)).toContain(`the batch turn's id is ${eventId}'s arrival id`);
    expect(rule("arrivalTurn")(batch).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Each refusal tied to its reason (DL-124's mend-then-accept proof)

/** A refused fixture put right as its index entry and the README say ("with ... it is accepted"). */
interface Mend {
  /** The one field the entry names: the mend changes it and nothing else. */
  at: Path;
  /** The value put right there, read from the fixture the entry names where it names one. */
  to: (refused: unknown) => unknown;
  /** The accepted twin the entry names ("as ..."): the mended copy's `mine` is the twin's `part`, but at `except`. */
  twin?: { file: string; part: Path; mine?: Path; except?: Path[] };
}

const from =
  (file: string, where: Path): (() => unknown) =>
  () =>
    structuredClone(getAt(fixture(file), where));

/**
 * The mend of every refused fixture of the versions frozen when this part was written (v1 and v1.1; each refused for
 * its one fault: README "Fixtures", "Fixtures, v1.1"). A later minor version's refused fixtures are checked by parts 1
 * and 2, and their mends join this list with that version's QA task.
 */
const MENDED_VERSIONS = ["v1", "v1.1"];
const MENDS: Record<string, Mend> = {
  "invalid/refuse-team-without-tick.json": {
    at: ["step", "people", 0, "agreedToTexts"],
    to: () => true,
    twin: { file: "add-team.json", part: ["request", "step", "people", 1], mine: ["step", "people", 0] },
  },
  "invalid/refuse-limit-outcome-wrong-kind.json": {
    at: ["outcome"],
    to: () => must(LIMIT_ACTIONS.get("freshReadBack")).kind,
    twin: { file: "commit-limit-3-no-exact-yes.json", part: ["outcome", "parts", 0, "stoppedBy"] },
  },
  "invalid/refuse-start-from-page.json": { at: ["caller", "kind"], to: () => "turn" },
  "invalid/refuse-start-without-text.json": {
    at: ["inboundEventId"],
    to: from("start-recorded.json", ["request", "inboundEventId"]),
  },
  "invalid/refuse-core-setup-step-not-ready-text.json": {
    at: ["request", "step"],
    to: from("staff-join-ready-text.json", ["request", "step"]),
  },
  "invalid/refuse-limit-6-question-before-reread.json": {
    at: ["request", "input", "decided", "decide"],
    to: from("commit-limit-6-value-fails.json", ["request", "input", "decided", "decide"]),
    twin: {
      file: "commit-limit-6-value-fails.json",
      part: [],
      except: [["given"], ["request", "now"], ["outcome", "committedAt"]],
    },
  },
  "invalid/refuse-texts-without-turn.json": {
    at: ["turn"],
    to: from("stop-recorded.json", ["request", "turn"]),
  },
  "invalid/refuse-email-check-without-person.json": {
    at: ["forPersonId"],
    to: () => "person-sam",
    twin: { file: "email-check-typed.json", part: ["request"] },
  },
  "invalid/refuse-sign-in-acting-for-person.json": {
    at: ["caller", "personId"],
    to: () => null,
    twin: { file: "proof-code-email.json", part: ["request"] },
  },
  "invalid/refuse-j3-agent-request-without-read.json": {
    at: ["safetyOutcomeId"],
    to: from("j3-open-request-agent.json", ["request", "safetyOutcomeId"]),
    twin: { file: "j3-open-request-agent.json", part: ["request"] },
  },
  "invalid/refuse-j3-business-door-from-agent.json": { at: ["caller", "kind"], to: () => "turn" },
  "invalid/refuse-j3-read-back-yes-from-agent.json": { at: ["caller", "kind"], to: () => "page" },
  "invalid/refuse-j3-yes-without-way.json": {
    at: ["consentId"],
    to: from("j3-confirm-business-booking-yes.json", ["outcome", "consentId"]),
    twin: { file: "j3-confirm-business-booking-yes.json", part: ["outcome"] },
  },
  "invalid/refuse-j3-not-yet-left-held.json": {
    at: ["reservation"],
    to: from("j3-confirm-business-booking-not-yet.json", ["outcome", "reservation"]),
    twin: { file: "j3-confirm-business-booking-not-yet.json", part: ["outcome"], except: [["written"]] },
  },
  "invalid/refuse-j3-turn-read-back-words.json": {
    at: ["readBack"],
    to: from("j3-confirm-business-booking-yes.json", ["request", "readBack"]),
    twin: { file: "j3-confirm-business-booking-yes.json", part: ["request"] },
  },
  "invalid/refuse-j3-arrival-record-without-turn.json": {
    at: ["caller", "turnId"],
    to: (refused) => getAt(refused, ["caller", "requestId"]),
    twin: { file: "j3-safety-arrival-emergency.json", part: ["request"] },
  },
  "invalid/refuse-j3-block-from-agent.json": { at: ["caller", "kind"], to: () => "page" },
  "invalid/refuse-j3-check-booking-acting-for-person.json": {
    at: ["caller", "personId"],
    to: () => null,
    twin: { file: "j3-check-booking-first.json", part: ["request"] },
  },
  "invalid/refuse-j3-arrival-record-of-no.json": {
    at: ["request", "safety"],
    // A danger read, as j3-safety-arrival-emergency.json's, of this record's own text (its event id kept, so its
    // arrival turn's id still holds).
    to: (refused) => ({
      ...(structuredClone(getAt(fixture("j3-safety-arrival-emergency.json"), ["request", "safety"])) as Obj),
      eventId: getAt(refused, ["request", "safety", "eventId"]),
    }),
  },
};

/** The one line each rule gives on the fixture it refuses: the reason the entry names (rules are only ever added). */
const RULE_REASONS: Record<string, string[]> = {
  "invalid/refuse-limit-6-question-before-reread.json": [
    "parts[0] is stopped by limit 6 although decide.reread is not true",
  ],
  "invalid/refuse-j3-arrival-record-of-no.json": [
    "a read of No has no arrival record: it rides in the turn its text joins (README default 5)",
  ],
};

/** The copy of a refused fixture put right by its mend. */
function mended(file: string): unknown {
  const mend = must(MENDS[file], `the mend of ${file}`);
  const copy = structuredClone(fixture(file));
  setAt(copy, mend.at, mend.to(copy));
  return copy;
}

describe("tool-api fixtures: each refused fixture is refused for its reason, and accepted put right", () => {
  it("holds a mend for every refused fixture of v1 and v1.1, selected by version, and no other", () => {
    expect(sorted(Object.keys(MENDS))).toEqual(
      sorted(
        refusedEntries.filter((entry) => MENDED_VERSIONS.includes(entry.version)).map((entry) => entry.file),
      ),
    );
    expect(sorted(Object.keys(RULE_REASONS))).toEqual(
      sorted(
        refusedByRule.filter((entry) => MENDED_VERSIONS.includes(entry.version)).map((entry) => entry.file),
      ),
    );
  });

  for (const [file, mend] of Object.entries(MENDS)) {
    it(`${file}: refused for ${pointerOf(mend.at)}, and accepted with only that field put right`, () => {
      const entry = entryOf(file);
      const refused = fixture(file);
      const right = mended(file);
      // The mend changes the field the entry names, and nothing else.
      const changed = differences(refused, right);
      expect(changed.length, "the mend changes something").toBeGreaterThan(0);
      for (const where of changed)
        expect(where.slice(0, mend.at.length), `${file} changes ${pointerOf(where)}`).toEqual(mend.at);
      if (entry.rule === undefined) {
        // Refused by the schema, which names that field among its reasons; put right, it is accepted.
        const explain = validatorFor(entry, explainAjv);
        expect(explain(refused), `${file} is refused`).toBe(false);
        const at = pointerOf(mend.at);
        expect(
          (explain.errors ?? []).some(
            (error) => error.instancePath === at || error.instancePath.startsWith(`${at}/`),
          ),
          `${file}: the schema's errors name ${at}: ${formatErrors(explain.errors).join("; ")}`,
        ).toBe(true);
        expect(
          accepts(entry, right),
          `${file} put right: ${formatErrors(validatorFor(entry).errors).join("; ")}`,
        ).toBe(true);
      } else {
        // Taken by the schema and refused by its rule alone, for the rule's one named reason; put right, the rule passes.
        expect(accepts(entry, refused), `${file} passes the schema`).toBe(true);
        expect(rule(entry.rule)(refused)).toEqual(must(RULE_REASONS[file]));
        expect(accepts(entry, right), `${file} put right passes the schema`).toBe(true);
        expect(rule(entry.rule)(right), `${file} put right`).toEqual([]);
      }
      if (mend.twin !== undefined) {
        const { part, mine = [], except = [] } = mend.twin;
        const twinEntry = entryOf(mend.twin.file);
        expect(twinEntry.expect, mend.twin.file).toBe("accept");
        const theirs = structuredClone(getAt(fixture(mend.twin.file), part));
        const ours = structuredClone(getAt(right, mine));
        for (const where of except) {
          setAt(theirs, where, null);
          setAt(ours, where, null);
        }
        expect(ours, `${file} put right is ${mend.twin.file}'s ${pointerOf(part) || "whole"}`).toEqual(
          theirs,
        );
      }
    });
  }

  it("refuses the limit 6 question and the No read by the models of part 2 too, and passes them put right", () => {
    const limit6 = fixture("invalid/refuse-limit-6-question-before-reread.json") as Exchange;
    expect(checkLimit6AfterReread(limit6)).toEqual([
      "parts[0] asks limit 6's one question before decide's re-read",
    ]);
    expect(
      checkLimit6AfterReread(mended("invalid/refuse-limit-6-question-before-reread.json") as Exchange),
    ).toEqual([]);
    const no = fixture("invalid/refuse-j3-arrival-record-of-no.json") as Exchange;
    expect(checkArrivalTurn(no)).toEqual([
      "a read of No has no arrival record: it rides in the turn its text joins",
    ]);
    expect(checkArrivalTurn(mended("invalid/refuse-j3-arrival-record-of-no.json") as Exchange)).toEqual([]);
    // A read that timed out with a danger word is recorded on arrival too (README v1.1, j3-safety-arrival-timeout.json).
    const timedOut = structuredClone(no);
    setAt(timedOut, ["request", "safety"], {
      ...(structuredClone(getAt(fixture("j3-safety-arrival-timeout.json"), ["request", "safety"])) as Obj),
      eventId: getAt(no, ["request", "safety", "eventId"]),
    });
    expect(checkArrivalTurn(timedOut)).toEqual([]);
    expect(rule("arrivalTurn")(timedOut)).toEqual([]);
  });

  it("refuses a copy that also breaks another field, so each mend puts right the one fault and no more", () => {
    for (const file of Object.keys(MENDS)) {
      const entry = entryOf(file);
      const right = mended(file) as Obj;
      const broken = { ...right, notInTheSchema: 1 };
      expect(accepts(entry, broken), `${file} put right, with a field the schema does not know`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. The schema is not vacuous

describe("tool-api fixtures: removing a required field makes an accepted fixture refused", () => {
  for (const entry of acceptedEntries) {
    it(`${entry.file} (${entry.version})`, () => {
      const validate = validatorFor(entry);
      const original = fixture(entry.file);
      expect(validate(original), formatErrors(validate.errors).join("; ")).toBe(true);
      const required = requiredPathsOf(entry);
      const root = required.filter((where) => where.length === 1).map((where) => String(where[0]));
      expect(root, "an exchange requires its call, given, request and outcome").toEqual(
        expect.arrayContaining(["call", "given", "request", "outcome"]),
      );
      expect(required.length, "the schema requires fields below the root too").toBeGreaterThan(root.length);
      // The walk reaches every caller in the exchange (the request's, and each core action's), all of whose fields
      // are required: who calls, under which business, for whom, the key a repeat is known by and the trace.
      const keys = new Set(required.map(keyOf));
      const callerFields = propertyPaths(original).filter((where) => where.at(-2) === "caller");
      expect(callerFields.length, "the request names its caller").toBeGreaterThanOrEqual(6);
      for (const where of callerFields)
        expect(keys.has(keyOf(where)), `${pointerOf(where)} is required`).toBe(true);
      for (const where of required) {
        expect(
          validate(without(original, where)),
          `${entry.file} without ${pointerOf(where)} must be refused`,
        ).toBe(false);
      }
      expect(
        validate({ ...(original as Obj), notInTheSchema: 1 }),
        `${entry.file} with a field the schema does not know must be refused`,
      ).toBe(false);
    });
  }

  it("reads the required fields from the schemas: nested ones, the branch a value takes, and none that is optional", () => {
    const keys = (file: string): Set<string> => new Set(requiredPathsOf(entryOf(file)).map(keyOf));
    const stop = keys("stop-recorded.json");
    for (const where of [
      ["request", "caller", "kind"],
      ["request", "turn", "eventIds"],
      ["request", "core", 1, "request", "inboundEventId"],
      ["outcome", "core", 1, "response", "stopped"],
      ["outcome", "written", "outboxRows", 0, "commitSeq"],
    ])
      expect(stop.has(keyOf(where)), pointerOf(where)).toBe(true);
    const commit = keys("commit-limit-6-value-fails.json");
    for (const where of [
      ["request", "input", "decided", "context", "texts", 0, "words"],
      ["request", "input", "decided", "decide", "reads", 2, "role"],
      ["outcome", "parts", 0, "stoppedBy", "action"],
    ])
      expect(commit.has(keyOf(where)), pointerOf(where)).toBe(true);
    // Optional fields are present but never counted: given's note, and the fields v1.1 adds to v1's own definitions,
    // which only add optional fields (README "v1.1"); the fields inside an optional one that is present are required.
    const optional = (file: string, where: Path): void => {
      expect(getAt(fixture(file), where), `${file} has ${pointerOf(where)}`).toBeDefined();
      expect(keys(file).has(keyOf(where)), `${file}: ${pointerOf(where)} is optional`).toBe(false);
    };
    optional("stop-recorded.json", ["given", "note"]);
    optional("j3-safety-agent-request.json", ["outcome", "gives"]);
    optional("j3-stop-tells-businesses.json", ["outcome", "businessesTold"]);
    optional("j3-safety-arrival-emergency.json", ["outcome", "hold", "version"]);
    const told = keys("j3-stop-tells-businesses.json");
    for (const field of ["businessId", "fixedLineId", "outboxRowId"])
      expect(told.has(keyOf(["outcome", "businessesTold", 0, field])), field).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. What the schema leaves to tests (DL-123, DL-126)

describe("tool-api fixtures: what the schema leaves to tests", () => {
  it("writes no consent with the texts-off line, on every '1 Yes' that meets a stopped mobile", () => {
    const textsOff = acceptedExchanges().filter(
      ({ exchange }) => exchange.call === "confirmBusinessBooking" && exchange.outcome.textsOff !== null,
    );
    expect(textsOff.length).toBeGreaterThan(0);
    for (const { file, exchange } of acceptedExchanges())
      expect(checkTextsOffWritesNoConsent(exchange), file).toEqual([]);
  });

  it("fires on a texts-off answer that also writes a consent, which the schema still takes", () => {
    const file = "j3-confirm-business-booking-texts-off.json";
    const damaged = exchangeOf(file);
    setAt(damaged, ["outcome", "consentId"], "consent-alex-texts-sam-book");
    expect(accepts(entryOf(file), damaged), "the schema's anyOf takes both").toBe(true);
    expect(checkTextsOffWritesNoConsent(damaged)).toEqual([
      "the texts-off answer writes the consent consent-alex-texts-sam-book",
    ]);
  });

  it("tells a business with no outbox row exactly when the STOP's call has no turn", () => {
    const notices = acceptedExchanges().flatMap(({ exchange }) => stopNotices(exchange));
    expect(notices.some(({ told }) => told.some((business) => business.outboxRowId === null))).toBe(true);
    expect(notices.some(({ told }) => told.some((business) => business.outboxRowId !== null))).toBe(true);
    for (const { file, exchange } of acceptedExchanges())
      expect(checkBusinessesToldByCaller(exchange), file).toEqual([]);
  });

  it("fires on a STOP in a turn that tells a business with no row, and on one with no turn that names a row", () => {
    const inTurn = "j3-stop-tells-businesses.json";
    const noRow = exchangeOf(inTurn);
    const told = must(stopNotices(noRow)[0]).told;
    for (const business of told) business.outboxRowId = null;
    expect(accepts(entryOf(inTurn), noRow), "the schema takes it").toBe(true);
    expect(checkBusinessesToldByCaller(noRow)).toEqual([
      "biz-lees-barbershop is told with no outbox row by a STOP in a turn",
    ]);
    const onReturn = "j3-stop-on-return-tells-businesses.json";
    const withRow = exchangeOf(onReturn);
    for (const business of must(stopNotices(withRow)[0]).told) business.outboxRowId = "out-sam-texts-off";
    expect(accepts(entryOf(onReturn), withRow), "the schema takes it").toBe(true);
    expect(checkBusinessesToldByCaller(withRow)).toEqual([
      "biz-lees-barbershop is told by an outbox row a STOP with no turn cannot write",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The sides: where each producer and consumer side is added

export interface SideCheck {
  id: string;
  side: "producer" | "consumer";
  owner: string;
  components: string[];
  needs: string;
  /** Added by the QA side task for this side; it returns one line per problem. */
  check?: () => string[];
}

/**
 * ops/plan/02-contracts.md K-09 "Contract test": the mock, the action layer and each caller agree on every fixture.
 * Each side's components under their owner as contracts/tool-api/README.md names them ("Producers and consumers
 * (02-contracts K-09)" and "Producers and consumers of v1.1"). Each side is added later by a QA side task that depends
 * on this task and on that side's build task: it fills `check` (and moves its own test beside this one). Until then the
 * side is held here with what it must show, so none is forgotten.
 */
export const SIDE_CHECKS: readonly SideCheck[] = [
  {
    id: "producer-action-layer",
    side: "producer",
    owner: "action-layer engineer",
    components: [
      "C-074 Tool API",
      "C-075 to C-112",
      "C-130 to C-138",
      "C-099 bookings and quotes",
      "C-100 reservations",
      "C-094 identity and access",
      "C-105 block and pause",
      "C-104 safety and hand-offs",
      "C-087 one commit per turn",
    ],
    needs:
      "On PostgreSQL with each fixture's given seeds and chain (given.after), the Tool API answers every accepted fixture's request with its outcome, field for field: the response, or the error with nothing written, a repeat answering repeated; and refuses every invalid one, writing nothing. Each limit fixture's stated outcome comes from the gate (statedOutcome, limit 6 only after decide's re-read: rereadBeforeQuestion), each setup fixture writes its step's keys (givesStepKeys) and each journey 3 key is written by its one call (givesJourneyKeys), a clock's firing keeps the clock turn (clockTurn) and the arrival record its arrival turn (arrivalTurn); no answer holds textsOff with a consentId, and a STOP tells each business with an outbox row exactly when it has a turn.",
  },
  {
    id: "consumer-runtime",
    side: "consumer",
    owner: "runtime engineer",
    components: [
      "C-046 handle actor (the turn loop)",
      "C-047 safety read on arrival",
      "C-051 guard",
      "C-052 guard fixed replies",
      "C-174 AI provider down",
      "C-175 PostgreSQL down",
    ],
    needs:
      "The handle actor's calls match the fixtures' requests (a turn, a core-only STOP turn, a clock turn on the clock row's handle, a START written on return, the arrival record under arrivalTurnId and the batch turn under its own id) and it reads each outcome as the fixtures show it; the guard's fixed replies and the outage paths call sendFixedLine and recordStopOrStart as the fixtures do; it refuses every invalid one, sending none of them.",
  },
  {
    id: "consumer-ai",
    side: "consumer",
    owner: "AI engineer",
    components: ["C-114 context bundle", "C-115", "C-116 decide", "C-117 planner", "C-118 composer"],
    needs:
      "The context passed to decide and the decide result taken back are K-02's fixtures word for word, as buildFrontier and gateAndCommit carry them (A3-19's values as decide's fields in the BOOK turn); the planner's verbs ride inside gateAndCommit and the composer reads composeInput and finalizeMessage as the fixtures show; it refuses every invalid one.",
  },
  {
    id: "consumer-frontend",
    side: "consumer",
    owner: "frontend engineer",
    components: ["C-185 to C-205", "C-197 booking page", "C-192 owner console", "C-199 secure page"],
    needs:
      "Through K-21 and the mock, each page's and console's call is a fixture's request with a page or console caller (the person, a read-back's words and versions and the booker set by the page server, never the browser), and each page shows the fixture's outcome; it refuses every invalid one.",
  },
  {
    id: "consumer-mock",
    side: "consumer",
    owner: "architect",
    components: ["C-186 Tool API mock"],
    needs:
      "The Tool API mock (T-510), generated from these fixtures, answers each accepted exchange's request with its outcome, and every other request, each refused fixture included, fails loudly: it refuses every invalid one.",
  },
  {
    id: "consumer-agent-api",
    side: "consumer",
    owner: "action-layer engineer",
    components: ["C-110 Agent API"],
    needs:
      "The Agent API calls openRequest at door ai only after the request's safety read, never the business's door, a read-back's yes or a block, and reads the outcomes as the fixtures show; it refuses every invalid one.",
  },
  {
    id: "consumer-qa",
    side: "consumer",
    owner: "QA",
    components: ["C-140 eval harness", "C-147 scenario tests", "C-148 end-to-end tests"],
    needs:
      "The eval harness, the scenario tests and the end-to-end tests read committed writes, outcomes and errors in the fixtures' shapes, and each refuses every invalid one.",
  },
];

describe("tool-api sides: the list where each producer and consumer side is added", () => {
  /** A README section from its heading to the line that ends its list. */
  const sectionOf = (heading: string, end: string): string => {
    const start = README.indexOf(heading);
    expect(start, heading).toBeGreaterThan(-1);
    return README.slice(start, README.indexOf(end, start));
  };
  const listed = [
    sectionOf("## Producers and consumers (02-contracts K-09)", "- **Frozen before it"),
    sectionOf("### Producers and consumers of v1.1", "- **Frozen before it"),
  ].join("\n");

  it("names each side once, with the producer and consumers of the README, each consumer refusing every invalid one", () => {
    const ids = SIDE_CHECKS.map((side) => side.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SIDE_CHECKS.filter((side) => side.side === "producer")).toHaveLength(1);
    expect(SIDE_CHECKS.filter((side) => side.side === "consumer").length).toBeGreaterThan(5);
    for (const side of SIDE_CHECKS) {
      expect(side.owner, side.id).not.toBe("");
      expect(side.components.length, side.id).toBeGreaterThan(0);
      expect(side.needs, side.id).not.toBe("");
      expect(side.needs, side.id).toMatch(/refuses every invalid/i);
    }
  });

  it("names every component the README's producers and consumers list, and no other", () => {
    const named = new Set(listed.match(/C-\d{3}/g));
    const held = new Set(SIDE_CHECKS.flatMap((side) => side.components.join(" ").match(/C-\d{3}/g) ?? []));
    expect(named.size).toBeGreaterThan(20);
    expect(sorted([...held])).toEqual(sorted([...named]));
  });

  it("spells each side's owner and components as the README does", () => {
    for (const side of SIDE_CHECKS) {
      expect(listed, side.id).toContain(side.owner);
      for (const component of side.components) expect(listed, side.id).toContain(component);
    }
  });

  it("holds the mock, the action layer and each caller, as 02-contracts K-09's contract test names them", () => {
    const owners = new Set(SIDE_CHECKS.map((side) => side.owner));
    for (const owner of [
      "action-layer engineer",
      "architect",
      "runtime engineer",
      "AI engineer",
      "frontend engineer",
    ])
      expect(owners.has(owner), owner).toBe(true);
    expect(SIDE_CHECKS.find((side) => side.side === "producer")?.components[0]).toBe("C-074 Tool API");
  });

  for (const side of SIDE_CHECKS) {
    if (side.check === undefined) continue;
    const check = side.check;
    it(`${side.side} side ${side.id}`, () => {
      expect(check()).toEqual([]);
    });
  }
});
