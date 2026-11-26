// Contract test for K-09 v1.13, a final refusal answers turnRefused and notBuilt is final (T-1550, T-1529's ruling card 3;
// T-1539's freeze, the ruling's card 1; DL-1142, DL-1174, DL-1195): contracts/tool-api/README.md "v1.13 (T-1539)", its
// defaults 216 to 220, "Fixtures, v1.13", "Who reads v1.13" and "Contract test, v1.13".
//
// tests/contract/tool-api.v1.test.ts selects the index's entries by version (DL-125), so v1.13's thirteen fixtures
// already join its generic checks. This file is v1.13's own part, as the README's "Contract test, v1.13" lists it,
// reading only the committed schemas, fixtures, README and the fault lists' own files:
//   1. the version: tool-api.v1.13.schema.json holds every v1.12 definition by $ref but the four section "v1.13" names
//      (gateAndCommit.errors and gateAndCommit.exchange restated, turnRefusedError and notBuiltError added), with v1.12's
//      root, and is frozen;
//   2. the fixtures: the index holds exactly the thirteen README "Fixtures, v1.13" names, each accepted or refused as
//      listed at its own $defs entry; every earlier accepted fixture is accepted by v1.13 at its own entry; and what
//      v1.13 adds is refused by v1.12;
//   3. each refused fixture, mended as its index entry says, is accepted (at gateAndCommit's exchange, turnRefusedError
//      or gateAndCommit's errors), differs from its mend at its one fault alone, and, where the entry names a twin, is
//      that twin;
//   4. default 217's list agrees with the schema and with the fault lists as the code holds them: each list's union read
//      from its file, every fault named final or transient, none left out; the schema accepts a copy with each final
//      fault and refuses each transient one, a from outside the six, and reviewRefused carrying transient;
//   5. turnRefused carries labels only (default 216): each accepted answer holds error, from, fault and ids and nothing
//      more, each a K-08 safeId, and less its error is K-05 v1.23's parkReason; commit-s1-02-refused-step-not-in-bundle's
//      labels are park-turn-sam-refused-at-once's reason field for field; the schema refuses a fault or an id with a space
//      or an at sign, a repeated id and anything beside the labels; and notBuilt is final (defaults 217 to 219), named for
//      gateAndCommit alone, with no seam or step beside its call, and parks with K-05's reason from toolApi;
//   6. the requests of commit-s1-04-refused-second-company and commit-s1-04-not-built differ from those of
//      commit-s1-04-some-share and commit-s1-04 only in their turn's ids.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { CONTRACTS_ROOT, REPO_ROOT, formatErrors, type FixtureEntry } from "./_harness";

// ---------------------------------------------------------------------------------------------------------------
// The files

const TOOL_API_DIR = path.join(CONTRACTS_ROOT, "tool-api");
const FIXTURES_DIR = path.join(TOOL_API_DIR, "fixtures");
const DATA_ACCESS_FIXTURES = path.join(CONTRACTS_ROOT, "data-access", "fixtures");
const VERSION = "v1.13";
const PREVIOUS = "v1.12";
const EXCHANGE = "gateAndCommit.exchange";
const ERRORS = "gateAndCommit.errors";
const TURN_REFUSED = "turnRefusedError";
const NOT_BUILT = "notBuiltError";

const STEP_NOT_IN_BUNDLE = "commit-s1-02-refused-step-not-in-bundle.json";
const SECOND_COMPANY = "commit-s1-04-refused-second-company.json";
const NOT_BUILT_FIXTURE = "commit-s1-04-not-built.json";
/** The K-05 v1.23 park whose reason the walk's refusal is (README "Fixtures, v1.13"). */
const PARK_AT_ONCE = "park-turn-sam-refused-at-once.json";

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

const entries = (readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: FixtureEntry[] }).fixtures;
/** v1.13's entries, selected by their version (DL-125). */
const ownEntries = entries.filter((entry) => entry.version === VERSION);
const ownAccepted = ownEntries.filter((entry) => entry.expect === "accept");
const ownRefused = ownEntries.filter((entry) => entry.expect === "refuse");
const entryOf = (file: string): FixtureEntry =>
  must(
    entries.find((candidate) => candidate.file === file),
    `the index entry of ${file}`,
  );
const parsed = new Map<string, unknown>();
/** A fresh copy of a fixture of K-09's folder. */
function fixture(file: string): unknown {
  if (!parsed.has(file)) parsed.set(file, readJson(path.join(FIXTURES_DIR, ...file.split("/"))));
  return structuredClone(parsed.get(file));
}
const defOf = (entry: FixtureEntry): string => must(entry.def, `the $defs entry of ${entry.file}`);
const nameOf = (file: string): string => path.posix.basename(file);

/** A version's major and minor number: v1 is [1, 0], v1.13 is [1, 13]. */
function placeOf(version: string): [number, number] {
  const match = /^v(\d+)(?:\.(\d+))?$/.exec(version);
  if (match === null) throw new Error(`a version this test cannot place: ${version}`);
  return [Number(match[1]), Number(match[2] ?? "0")];
}
const [MAJOR, MINOR] = placeOf(VERSION);
/** The accepted fixtures of every version before v1.13 (BP 6.4: a minor version only adds). */
const earlierAccepted = entries.filter((entry) => {
  const [major, minor] = placeOf(entry.version);
  return entry.expect === "accept" && major === MAJOR && minor < MINOR;
});

// ---------------------------------------------------------------------------------------------------------------
// The schemas: every schema under contracts/, as contracts:check loads them, so each $ref resolves; one strict
// validator (Ajv 2020-12, as the T-003 harness sets it)

const SKIPPED = new Set(["node_modules", "generated"]);

function schemaFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED.has(entry.name) ? [] : schemaFiles(full);
    return entry.isFile() && entry.name.endsWith(".schema.json") ? [full] : [];
  });
}

const ajv = new Ajv2020({ strict: true, strictRequired: false });
for (const file of schemaFiles(CONTRACTS_ROOT)) ajv.addSchema(readJson(file) as object);

const schemaOf = (version: string): Obj =>
  readJson(path.join(TOOL_API_DIR, `tool-api.${version}.schema.json`)) as Obj;
const ID_BASE = "https://rosie.invalid/contracts/";

/** The validator of `version`'s K-09 schema at its $defs entry `def`. */
function validatorFor(version: string, def: string): ValidateFunction {
  const target = `${ID_BASE}tool-api/tool-api.${version}.schema.json#/$defs/${def}`;
  return must(ajv.getSchema(target), `the schema ${target}`);
}
/** Whether `version`'s schema takes `value` at `def`, with its errors when it does not. */
function takenBy(version: string, def: string, value: unknown): { ok: boolean; why: string } {
  const validate = validatorFor(version, def);
  const ok = validate(value);
  return { ok, why: formatErrors(validate.errors).join("; ") };
}
const takes = (def: string, value: unknown): boolean => takenBy(VERSION, def, value).ok;

/** K-05 v1.23's parkReason, the three labels a park takes field for field (K-05 v1.23 item 84). */
const PARK_REASON_ID = `${ID_BASE}data-access/data-access.v1.23.schema.json#/$defs/parkReason`;
function parkReason(value: unknown): boolean {
  const validate: ValidateFunction = must(ajv.getSchema(PARK_REASON_ID), PARK_REASON_ID);
  return validate(value);
}

// Compile every validator the checks call while the file loads, so no test carries Ajv's compile time.
for (const def of new Set([...earlierAccepted, ...ownEntries].map((entry) => entry.def))) {
  if (def !== undefined) validatorFor(VERSION, def);
}
for (const def of [EXCHANGE, ERRORS, TURN_REFUSED, NOT_BUILT]) validatorFor(VERSION, def);
validatorFor(PREVIOUS, EXCHANGE);

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

/** README section "v1.13 (T-1539)", up to its defaults. */
const SECTION = readmeBetween("## v1.13 (T-1539)", "### Defaults (T-1539)");
/** One default of v1.13, by its number, up to the next. */
const defaultOf = (n: number): string => readmeBetween(`\n${String(n)}. **`, `\n${String(n + 1)}. **`);
const DEFAULT_217 = defaultOf(217);
/** README "Fixtures, v1.13". */
const README_FIXTURES = readmeBetween("### Fixtures, v1.13", "### Who reads v1.13");
/** README "Contract test, v1.13". */
const CONTRACT_TEST = readmeBetween("**Contract test, v1.13", "### Open gaps, v1.13");

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

/** Marks a field to take out, in setAt. */
const REMOVE = Symbol("remove");

function setAt(value: unknown, where: Path, to: unknown): void {
  const parent = getAt(value, where.slice(0, -1));
  const last = must(where.at(-1));
  if (Array.isArray(parent) && typeof last === "number") parent[last] = to;
  else if (isObj(parent) && typeof last === "string") {
    if (to === REMOVE) Reflect.deleteProperty(parent, last);
    else parent[last] = to;
  } else throw new Error(`no ${where.join(".")}`);
}

/** A copy of `value` with the field at `where` set to `to`, or taken out for REMOVE. */
function changed(value: unknown, where: Path, to: unknown): unknown {
  const copy = structuredClone(value);
  setAt(copy, where, to);
  return copy;
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

const NOTE: Path = ["given", "note"];

// ---------------------------------------------------------------------------------------------------------------
// 1. The version

describe("tool-api v1.13: the version", () => {
  const own = schemaOf(VERSION);
  const previous = schemaOf(PREVIOUS);
  const ownDefs = own.$defs as Record<string, Obj>;
  const previousDefs = previous.$defs as Record<string, Obj>;
  const byRef = (name: string): boolean =>
    isDeepStrictEqual(ownDefs[name], { $ref: `tool-api.${PREVIOUS}.schema.json#/$defs/${name}` });

  it("holds every v1.12 definition under its own name, each by $ref but the two it restates, and adds the two section 'v1.13' names", () => {
    expect(Object.keys(previousDefs).filter((name) => !Object.hasOwn(ownDefs, name))).toEqual([]);
    const restated = Object.keys(previousDefs).filter((name) => !byRef(name));
    const added = Object.keys(ownDefs).filter((name) => !Object.hasOwn(previousDefs, name));
    expect(sorted(restated)).toEqual([ERRORS, EXCHANGE]);
    expect(sorted(added)).toEqual([NOT_BUILT, TURN_REFUSED]);
    expect(SECTION).toContain(
      `it restates two, \`${ERRORS}\` (v1.12's by reference, or \`${TURN_REFUSED}\`, or \`${NOT_BUILT}\` naming gateAndCommit) and \`${EXCHANGE}\``,
    );
    expect(SECTION).toContain(`and adds two, \`${TURN_REFUSED}\` and \`${NOT_BUILT}\``);
    expect(CONTRACT_TEST).toContain(
      `\`tool-api.${VERSION}.schema.json\` holds every ${PREVIOUS} definition by \`$ref\` but the four this section names`,
    );
    for (const name of Object.keys(previousDefs)) validatorFor(VERSION, name);
  });

  it("restates gateAndCommit.errors as v1.12's, turnRefused or notBuilt naming gateAndCommit, and names v1.12's calls at its root", () => {
    const errors = must(ownDefs[ERRORS]);
    expect(errors.anyOf).toEqual([
      { $ref: `tool-api.${PREVIOUS}.schema.json#/$defs/${ERRORS}` },
      { $ref: `#/$defs/${TURN_REFUSED}` },
      {
        allOf: [
          { $ref: `#/$defs/${NOT_BUILT}` },
          { type: "object", properties: { call: { const: "gateAndCommit" } } },
        ],
      },
    ]);
    expect(own.anyOf).toEqual(previous.anyOf);
    expect(own.$id).toBe(`${ID_BASE}tool-api/tool-api.${VERSION}.schema.json`);
  });

  it("is frozen: frozen.json lists it, and the README's status line names it", () => {
    const frozen = (readJson(path.join(TOOL_API_DIR, "frozen.json")) as { frozen: string[] }).frozen;
    expect(frozen).toContain(VERSION);
    expect(frozen).toContain(PREVIOUS);
    expect(README.split("\n").find((line) => line.startsWith("**Status:"))).toContain(`"${VERSION}"`);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The fixtures

describe("tool-api v1.13: the fixtures, each at its own $defs entry", () => {
  it("lists exactly the thirteen fixtures README 'Fixtures, v1.13' names, three accepted and ten refused, each by its file", () => {
    expect(README_FIXTURES).toContain(`Accepted (${String(ownAccepted.length)})`);
    expect(README_FIXTURES).toContain(`Refused (${String(ownRefused.length)}), in \`fixtures/invalid/\``);
    expect(ownEntries).toHaveLength(13);
    for (const entry of ownEntries)
      expect(README_FIXTURES, entry.file).toContain(`\`${nameOf(entry.file)}\``);
    const readmeRefused = [
      ...new Set(
        [...README_FIXTURES.matchAll(/`(refuse-[\w-]+\.json)`/g)].map((m) => `invalid/${must(m[1])}`),
      ),
    ];
    expect(sorted(ownRefused.map((entry) => entry.file))).toEqual(sorted(readmeRefused));
    expect(sorted(ownAccepted.map((entry) => entry.file))).toEqual(
      sorted([STEP_NOT_IN_BUNDLE, SECOND_COMPANY, NOT_BUILT_FIXTURE]),
    );
    for (const entry of ownRefused) expect(entry.file.startsWith("invalid/"), entry.file).toBe(true);
    expect(sorted([...new Set(ownEntries.map(defOf))])).toEqual(sorted([EXCHANGE, ERRORS, TURN_REFUSED]));
    expect(CONTRACT_TEST).toContain(
      'the index holds exactly the thirteen fixtures "Fixtures, v1.13" names, each accepted or refused as listed',
    );
  });

  for (const entry of ownEntries) {
    it(`${entry.expect === "accept" ? "accepts" : "refuses"} ${entry.file} at v1.13's ${String(entry.def)}`, () => {
      const { ok, why } = takenBy(VERSION, defOf(entry), fixture(entry.file));
      expect(ok, `${entry.file}: ${why}`).toBe(entry.expect === "accept");
    });
  }

  it("accepts every earlier accepted fixture (v1 to v1.12), each at its own $defs entry", () => {
    expect(earlierAccepted.length).toBeGreaterThan(100);
    const versions = new Set(earlierAccepted.map((entry) => entry.version));
    expect(versions).toContain(PREVIOUS);
    expect(versions).toContain("v1");
    for (const entry of earlierAccepted) {
      const { ok, why } = takenBy(VERSION, defOf(entry), fixture(entry.file));
      expect(ok, `${entry.file} (${entry.version}) under ${VERSION}: ${why}`).toBe(true);
    }
  });

  it("is what answers turnRefused and notBuilt: v1.12's gateAndCommit.exchange refuses each accepted v1.13 exchange, at its outcome", () => {
    for (const entry of ownAccepted) {
      expect(defOf(entry), entry.file).toBe(EXCHANGE);
      const { ok, why } = takenBy(PREVIOUS, EXCHANGE, fixture(entry.file));
      expect(ok, entry.file).toBe(false);
      expect(why, entry.file).toContain("/outcome");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Each refused fixture, mended as its index entry says

interface Mend {
  /** The one fault's place in the refused fixture. */
  at: Path;
  /** Its value put right, or REMOVE. */
  to: unknown;
  /** The words of the fixture's index entry that name the mend. */
  shows: string;
  /** The accepted value it is once mended, when its entry names one: a fixture, and the place in it. */
  twin?: { file: string; at: Path };
}

const OUTCOME: Path = ["outcome"];
const MENDS: Readonly<Record<string, Mend>> = {
  "invalid/refuse-turn-refused-transient-fault.json": {
    at: ["outcome", "fault"],
    to: "stepNotInBundle",
    shows: `with fault stepNotInBundle it is ${STEP_NOT_IN_BUNDLE}, accepted`,
    twin: { file: STEP_NOT_IN_BUNDLE, at: [] },
  },
  "invalid/refuse-turn-refused-fault-words.json": {
    at: ["fault"],
    to: "secondCompany",
    shows: "with fault secondCompany it is that fixture's answer, accepted",
    twin: { file: SECOND_COMPANY, at: OUTCOME },
  },
  "invalid/refuse-turn-refused-id-number.json": {
    at: ["ids"],
    to: ["S1-04"],
    shows: "with ids S1-04 it is that fixture's answer, accepted",
    twin: { file: SECOND_COMPANY, at: OUTCOME },
  },
  "invalid/refuse-turn-refused-with-words.json": {
    at: ["quote"],
    to: REMOVE,
    shows: "without the quote it is that fixture's answer, accepted",
    twin: { file: SECOND_COMPANY, at: OUTCOME },
  },
  "invalid/refuse-turn-refused-from-unclassified.json": {
    at: ["from"],
    to: "companies",
    shows: "with from companies it is that fixture's answer, accepted",
    twin: { file: SECOND_COMPANY, at: OUTCOME },
  },
  "invalid/refuse-turn-refused-ids-twice.json": {
    at: ["ids"],
    to: ["S1-04"],
    shows: "with ids S1-04 once it is that fixture's answer, accepted",
    twin: { file: SECOND_COMPANY, at: OUTCOME },
  },
  "invalid/refuse-turn-refused-read-transient.json": {
    at: ["fault"],
    to: "notFound",
    shows: "with fault notFound the same labels are accepted",
  },
  "invalid/refuse-turn-refused-review-transient.json": {
    at: ["ids"],
    to: ["S1-03", "notFound"],
    shows: "with ids S1-03 and notFound it is accepted",
  },
  "invalid/refuse-turn-refused-commit-still-changed.json": {
    at: ["fault"],
    to: "partNotGated",
    shows: "with fault partNotGated it is accepted",
  },
  "invalid/refuse-not-built-other-call.json": {
    at: ["call"],
    to: "gateAndCommit",
    shows: `with call gateAndCommit it is ${NOT_BUILT_FIXTURE}'s answer, accepted`,
    twin: { file: NOT_BUILT_FIXTURE, at: OUTCOME },
  },
};

/**
 * Each way a refused fixture fails to be refused for its one fault, none when it is: refused as it stands at its own
 * entry; mended, accepted there; the mend changing its fault alone; and, with a twin, differing from it only at the
 * fault (and an exchange's note), and mended, that twin.
 */
export function mendProblems(file: string, mend: Mend, value: unknown = fixture(file)): string[] {
  const problems: string[] = [];
  const def = defOf(entryOf(file));
  if (takes(def, value)) problems.push(`${file} is accepted as it stands`);
  const right = changed(value, mend.at, mend.to);
  if (!takes(def, right)) problems.push(`mended at ${pointerOf(mend.at)}, it is still refused`);
  for (const where of differences(value, right))
    if (!under(where, [mend.at])) problems.push(`the mend changes ${pointerOf(where)}`);
  if (mend.twin !== undefined) {
    const twin = getAt(fixture(mend.twin.file), mend.twin.at);
    const allowed = mend.twin.at.length === 0 ? [mend.at, NOTE] : [mend.at];
    for (const where of differences(value, twin))
      if (!under(where, allowed)) problems.push(`it differs from ${mend.twin.file} at ${pointerOf(where)}`);
    const withNote =
      mend.twin.at.length === 0 ? changed(right, NOTE, getAt(twin, NOTE)) : structuredClone(right);
    if (!isDeepStrictEqual(withNote, twin)) problems.push(`mended, it is not ${mend.twin.file}`);
  }
  return problems;
}

describe("tool-api v1.13: each refused fixture is refused for its one fault, and accepted mended as its entry says", () => {
  it("holds a mend for every refused v1.13 fixture and no other, each named in its index entry", () => {
    expect(sorted(Object.keys(MENDS))).toEqual(sorted(ownRefused.map((entry) => entry.file)));
    for (const [file, mend] of Object.entries(MENDS)) expect(entryOf(file).shows, file).toContain(mend.shows);
    expect(README_FIXTURES).toContain("Each index entry names its mend");
  });

  for (const [file, mend] of Object.entries(MENDS)) {
    it(`${file}: refused at ${String(entryOf(file).def)} for ${pointerOf(mend.at)} alone; mended, accepted${mend.twin === undefined ? "" : `, and ${mend.twin.file}'s ${mend.twin.at.length === 0 ? "exchange" : "answer"}`}`, () => {
      expect(mendProblems(file, mend)).toEqual([]);
    });
  }

  it("has the mend check fire: a mend elsewhere, another twin, a fixture accepted as it stands", () => {
    const words = "invalid/refuse-turn-refused-fault-words.json";
    const own = must(MENDS[words]);
    expect(mendProblems(words, { ...own, at: ["from"], to: "companies" })).toEqual([
      "mended at /from, it is still refused",
      `it differs from ${SECOND_COMPANY} at /fault`,
      `mended, it is not ${SECOND_COMPANY}`,
    ]);
    expect(mendProblems(words, { ...own, twin: { file: STEP_NOT_IN_BUNDLE, at: OUTCOME } })).toEqual([
      `it differs from ${STEP_NOT_IN_BUNDLE} at /from`,
      `mended, it is not ${STEP_NOT_IN_BUNDLE}`,
    ]);
    expect(mendProblems(words, own, getAt(fixture(SECOND_COMPANY), OUTCOME))).toEqual([
      `${words} is accepted as it stands`,
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. Default 217's list, the schema and the fault lists as the code holds them

interface FaultList {
  /** The fault list's file, from the repository's root, and the union type its faults are in. */
  file: string;
  type: string;
  /** The faults default 217 holds final, and transient. */
  final: string[];
  transient: string[];
  /** The ids a copy of turnRefused names for this list: a step, or for a read the read's own name. */
  ids: string[];
}

/** Default 217's six lists, as the README names them, each fault with its list's file and type. */
const FAULT_LISTS: Readonly<Record<string, FaultList>> = {
  walk: {
    file: "actions/src/commit/walk/errors.ts",
    type: "WalkFault",
    final: [
      "flowNotInBundle",
      "stepNotInBundle",
      "branchNotInBundle",
      "pathNotInBundle",
      "stepNotWellFormed",
      "loop",
      "walkTooLong",
      "notDecided",
      "businessNotInScope",
      "noServiceOrChatId",
      "noTurnKey",
      "givesNotStep",
      "settledNotInBundle",
      "settledNotRows",
      "rowNotStep",
      "eventKeyAtWalk",
    ],
    transient: ["questionNotLive"],
    ids: ["S1-04"],
  },
  commit: {
    file: "actions/src/commit/errors.ts",
    type: "CommitFault",
    final: [
      "callerNotTurn",
      "turnIdMismatch",
      "traceIdMismatch",
      "stateTable",
      "outboxRowWithPlan",
      "effectWithoutKey",
      "effectKeyTwice",
      "effectNotWellFormed",
      "idTwice",
      "askAgainNotAlone",
      "noTurnKey",
      "partNotGated",
    ],
    transient: ["wrongState", "stillChanged"],
    ids: [],
  },
  companies: {
    file: "actions/src/tool-api/journey-1/companies/errors.ts",
    type: "CompaniesFault",
    // Default 217: "Final: all nineteen (lines 82 to 100), `secondCompany` among them".
    final: [
      "wrongStep",
      "noPerson",
      "pickNotWellFormed",
      "notOwnPick",
      "noKeptPick",
      "noTurnCompany",
      "twoPicksOneKind",
      "placedElsewhere",
      "notPlaced",
      "placementDisagrees",
      "draftElsewhere",
      "unknownBranch",
      "noSharedKinds",
      "secondSharedGroup",
      "sharedWordNoPick",
      "sharedWordTwoPicks",
      "sharedGroupTooSmall",
      "alreadyPlaced",
      "secondCompany",
    ],
    transient: [],
    ids: ["S1-04"],
  },
  kinds: {
    file: "actions/src/tool-api/journey-1/kinds/errors.ts",
    type: "KindsFault",
    final: [
      "wrongStep",
      "noBranch",
      "noWords",
      "noPerson",
      "branchNotWords",
      "notBookedBesideKept",
      "notAnswered",
      "reviewWrites",
      "reviewRefused",
    ],
    transient: [],
    ids: ["S1-03"],
  },
  kindsRead: {
    file: "actions/src/tool-api/journey-1/kinds/errors.ts",
    type: "KindsReadFault",
    final: ["notFound", "noCatalog"],
    transient: ["transient"],
    ids: ["readPickedKinds"],
  },
  companiesRead: {
    file: "actions/src/tool-api/journey-1/companies/errors.ts",
    type: "CompaniesReadFault",
    final: ["notFound", "unknownFact", "notWellFormed"],
    transient: ["transient"],
    ids: ["readTurnState"],
  },
};

/** A union of string literals as its file holds it: `export type <type> = | "a" | "b";`. */
function unionOf(file: string, type: string): string[] {
  const source = readFileSync(path.join(REPO_ROOT, ...file.split("/")), "utf8");
  const body = must(new RegExp(`export type ${type} =([^;]*);`).exec(source), `${type} in ${file}`)[1] ?? "";
  return [...body.matchAll(/"(\w+)"/g)].map((match) => must(match[1]));
}

/** A turnRefused answer of one list, fault and ids. */
const refusal = (from: string, fault: string, ids: string[]): Obj => ({
  error: "turnRefused",
  from,
  fault,
  ids,
});

/** The part of default 217 that classifies one list: from its "(n) `<from>`:" to the next list's. */
function listText(from: string): string {
  const lists = Object.keys(FAULT_LISTS);
  const start = DEFAULT_217.indexOf(`(${String(lists.indexOf(from) + 1)}) \`${from}\`:`);
  const next = lists.indexOf(from) + 2;
  const end =
    next > lists.length ? DEFAULT_217.indexOf("Every notBuilt") : DEFAULT_217.indexOf(`(${String(next)}) \``);
  if (start < 0 || end < 0) throw new Error(`default 217 has no list ${from}`);
  return DEFAULT_217.slice(start, end);
}

describe("tool-api v1.13: default 217's list agrees with the schema and with the fault lists as the code holds them", () => {
  it("names the six lists, in default 217's order, as turnRefusedError's from takes them", () => {
    const from = (must((schemaOf(VERSION).$defs as Record<string, Obj>)[TURN_REFUSED]).properties as Obj)
      .from as { enum: string[] };
    expect(from.enum).toEqual(Object.keys(FAULT_LISTS));
    expect(DEFAULT_217).toContain("The six lists `from` names");
  });

  for (const [from, list] of Object.entries(FAULT_LISTS)) {
    it(`${from}: every fault of ${list.type} (${list.file}) is named final or transient by default 217, none left out, none added`, () => {
      expect(sorted(unionOf(list.file, list.type))).toEqual(sorted([...list.final, ...list.transient]));
      const text = listText(from);
      expect(text).toContain(`\`${list.type.replace("Fault", "")}`);
      for (const fault of list.transient)
        expect(between(text, "Transient:", "Final:"), fault).toContain(`\`${fault}\``);
      if (from === "companies") {
        expect(list.final).toHaveLength(19);
        expect(text).toContain("Final: all nineteen");
        expect(text).not.toContain("Transient:");
      } else {
        for (const fault of list.final)
          expect(text.slice(text.indexOf("Final:")), fault).toContain(`\`${fault}\``);
      }
    });

    it(`${from}: the schema answers turnRefused for each final fault and refuses each transient one`, () => {
      for (const fault of list.final) {
        const ids = fault === "reviewRefused" ? ["S1-03", "notFound"] : list.ids;
        expect(takes(TURN_REFUSED, refusal(from, fault, ids)), `${from} ${fault}`).toBe(true);
        expect(takes(ERRORS, refusal(from, fault, ids)), `${from} ${fault}`).toBe(true);
      }
      for (const fault of list.transient)
        expect(takes(TURN_REFUSED, refusal(from, fault, list.ids)), `${from} ${fault}`).toBe(false);
    });
  }

  it("refuses kinds' reviewRefused when its ids carry openReviewItem's transient, a read's transient from whichever list, and a from outside the six", () => {
    expect(takes(TURN_REFUSED, refusal("kinds", "reviewRefused", ["S1-03", "transient"]))).toBe(false);
    expect(takes(TURN_REFUSED, refusal("kinds", "reviewRefused", ["S1-03", "notFound"]))).toBe(true);
    for (const from of Object.keys(FAULT_LISTS))
      expect(takes(TURN_REFUSED, refusal(from, "transient", [])), from).toBe(false);
    for (const from of ["listing", "plan", "turnFace", "mobileId", "toolApi"])
      expect(takes(TURN_REFUSED, refusal(from, "secondCompany", ["S1-04"])), from).toBe(false);
    expect(DEFAULT_217).toContain("`reviewRefused` (line 67) unless its ids carry `transient`");
  });
});

/** The text between two markers; a miss is a broken test. */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  if (start < 0) throw new Error(`no ${from}`);
  const end = text.indexOf(to, start + from.length);
  return text.slice(start + from.length, end < 0 ? undefined : end);
}

// ---------------------------------------------------------------------------------------------------------------
// 5. turnRefused carries labels only, and notBuilt is final

/** The accepted turnRefused answers of v1.13: each accepted exchange's outcome that is one. */
const refusedAnswers = ownAccepted
  .map((entry) => ({ file: entry.file, outcome: getAt(fixture(entry.file), OUTCOME) }))
  .filter(({ outcome }) => isObj(outcome) && outcome.error === "turnRefused");

describe("tool-api v1.13: turnRefused carries labels only (default 216), and notBuilt is final (defaults 217 to 219)", () => {
  it("answers each accepted turnRefused with error, from, fault and ids alone, and less its error is K-05 v1.23's parkReason", () => {
    expect(refusedAnswers.map(({ file }) => file).sort()).toEqual(
      sorted([STEP_NOT_IN_BUNDLE, SECOND_COMPANY]),
    );
    for (const { file, outcome } of refusedAnswers) {
      const answer = outcome as Obj;
      expect(Object.keys(answer).sort(), file).toEqual(["error", "fault", "from", "ids"]);
      const reason = { ...answer };
      Reflect.deleteProperty(reason, "error");
      expect(parkReason(reason), file).toBe(true);
    }
    expect(CONTRACT_TEST).toContain(
      "each accepted `turnRefused` answer, less its `error`, is accepted by K-05 v1.23's `parkReason`",
    );
  });

  it("gives commit-s1-02-refused-step-not-in-bundle's labels as park-turn-sam-refused-at-once's reason, field for field", () => {
    const answer = { ...(getAt(fixture(STEP_NOT_IN_BUNDLE), OUTCOME) as Obj) };
    Reflect.deleteProperty(answer, "error");
    const park = readJson(path.join(DATA_ACCESS_FIXTURES, PARK_AT_ONCE)) as { request: { reason: Obj } };
    expect(answer).toEqual(park.request.reason);
    expect(README_FIXTURES).toContain(`the reason K-05 v1.23's \`${PARK_AT_ONCE}\` parks with`);
  });

  it("refuses a fault or an id with a space or an at sign, an id that reads as a number, an id twice, and anything beside the labels", () => {
    const answer = getAt(fixture(SECOND_COMPANY), OUTCOME) as Obj;
    expect(takes(TURN_REFUSED, answer)).toBe(true);
    const copies: [string, Path, unknown][] = [
      ["a fault with a space", ["fault"], "second company"],
      ["a fault with an at sign", ["fault"], "secondCompany@S1-04"],
      ["an id with a space", ["ids", 0], "S1 04"],
      ["an id with an at sign", ["ids", 0], "sam@example.com"],
      ["an id that reads as a number", ["ids", 0], "+15555550100"],
      ["an id twice", ["ids"], ["S1-04", "S1-04"]],
      ["a value beside the labels", ["words"], "Plumbing and electrical share Lee Home Services"],
      ["a fault left out", ["fault"], REMOVE],
    ];
    for (const [what, where, to] of copies) {
      const copy = changed(answer, where, to);
      expect(takes(TURN_REFUSED, copy), what).toBe(false);
      expect(takes(ERRORS, copy), what).toBe(false);
    }
  });

  it("answers notBuilt naming gateAndCommit, final, with nothing beside its call; it parks with K-05's reason from toolApi", () => {
    const answer = getAt(fixture(NOT_BUILT_FIXTURE), OUTCOME);
    expect(answer).toEqual({ error: "notBuilt", call: "gateAndCommit" });
    expect(takes(ERRORS, answer)).toBe(true);
    expect(takes(NOT_BUILT, { error: "notBuilt", call: "composeInput" })).toBe(true);
    expect(takes(ERRORS, { error: "notBuilt", call: "composeInput" })).toBe(false);
    for (const [what, extra] of [
      ["a seam", { seam: "stopReads" }],
      ["a step", { step: "S1-08" }],
    ] as const) {
      expect(takes(NOT_BUILT, { ...(answer as Obj), ...extra }), what).toBe(false);
      expect(takes(ERRORS, { ...(answer as Obj), ...extra }), what).toBe(false);
    }
    // Final (defaults 217 and 219): the runtime parks it at once with this reason (default 218).
    expect(DEFAULT_217).toContain("Every notBuilt is final (default 219)");
    expect(defaultOf(219)).toContain("Final: no retry binds what is missing, only a deploy does");
    expect(defaultOf(218)).toContain(
      '`{"from": "toolApi", "fault": "notBuilt", "ids": [the answer\'s call]}`',
    );
    expect(parkReason({ from: "toolApi", fault: "notBuilt", ids: ["gateAndCommit"] })).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 6. The two S1-04 refusals differ from their twins only in their turn's ids

/**
 * A request's turn's ids, each a fixture's own stand-in (README v1.5 default 131): the ids gateAndCommit.turn carries,
 * its own id, its texts' event ids and its trace ids, wherever the request repeats them (the caller's turn and request
 * ids, the context's and decide's turn id, a text's event id, the core actions' caller and safety read).
 */
function turnIdsOf(request: unknown): Set<unknown> {
  const turn = getAt(request, ["turn"]) as {
    id: string;
    eventIds: string[];
    traceId: string;
    joinedTraceIds: string[];
  };
  return new Set([turn.id, ...turn.eventIds, turn.traceId, ...turn.joinedTraceIds]);
}

/** The places two requests differ at other than by their turn's ids: each a value neither turn names as its own. */
function notTurnIds(a: unknown, b: unknown): string[] {
  const own = turnIdsOf(a);
  const other = turnIdsOf(b);
  return differences(a, b)
    .filter((where) => !(own.has(getAt(a, where)) && other.has(getAt(b, where))))
    .map(pointerOf);
}

describe("tool-api v1.13: the refusals of S1-04's answer are commit-s1-04-some-share's and commit-s1-04's requests but for their turn's ids", () => {
  const pairs: [string, string][] = [
    [SECOND_COMPANY, "commit-s1-04-some-share.json"],
    [NOT_BUILT_FIXTURE, "commit-s1-04.json"],
  ];

  for (const [file, twin] of pairs) {
    it(`${file}'s request is ${twin}'s but for the turn's ids`, () => {
      const request = getAt(fixture(file), ["request"]);
      const twinRequest = getAt(fixture(twin), ["request"]);
      expect(differences(request, twinRequest).length, `${file} has turn ids of its own`).toBeGreaterThan(0);
      expect(notTurnIds(request, twinRequest)).toEqual([]);
    });
  }

  it("has the check fire on a request that differs elsewhere", () => {
    const request = changed(
      getAt(fixture(SECOND_COMPANY), ["request"]),
      ["caller", "personId"],
      "person-alex",
    );
    expect(notTurnIds(request, getAt(fixture("commit-s1-04-some-share.json"), ["request"]))).toEqual([
      "/caller/personId",
    ]);
    expect(CONTRACT_TEST).toContain(
      "the requests of `commit-s1-04-refused-second-company.json` and `commit-s1-04-not-built.json` differ from `commit-s1-04-some-share.json`'s and `commit-s1-04.json`'s only in their turn's ids",
    );
  });
});
