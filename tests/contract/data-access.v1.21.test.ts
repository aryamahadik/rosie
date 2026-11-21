// Contract test for K-05 v1.21, a commit asks one open question again, its ask count raised by one: the schema side
// (T-1522; T-1508's freeze and its QA note, "QA's contract test (mends and sides)"; DL-1030, DL-1033, DL-1045, DL-1101;
// contracts/data-access/README.md section "v1.21", item 81, defaults 192 to 199, "Consumers of v1.21", "What the new
// tasks must hold to" (QA's task), and "Fixtures", v1.21).
//
// data-access.v1.test.ts checks every fixture of every version against the schema of its version (its parts 1, 3 and
// 4); data-access.v1.21.db-side.test.ts is v1.21's database side, each v1.21 exchange through db/repo's commitTurn
// (T-1509). This file proves the rest, reading only the committed schemas, fixtures and README:
//   1. v1.21 holds every v1.20 definition under its own name, restates the five and adds the three the README's change
//      log names and no other, names the same calls at its root as v1.20, and is frozen (frozen.json, the README's
//      status line and freeze record).
//   2. v1.21's fixtures, selected by their version, never by a pinned list or count (DL-124, DL-125): each against
//      data-access.v1.21.schema.json at its own definition, commitTurn.askAgainExchange, accepted or refused as the index
//      marks it and as README "Fixtures" (v1.21) counts and names them; each accepted one at the same definition of
//      every later version; and every accepted fixture of v1 to v1.20 at the same definition of v1.21, each earlier
//      commit exchange under commitTurn.exchange or commitTurn.handleIdExchange among them.
//   3. each refused fixture for its one fault, mended into its twin (README "Fixtures", v1.21: "each for one reason: put
//      right, it is commit-s1-02-sam-asks-again"; "differ ... in their fault and their note alone"): refused as it
//      stands, by errors that name its fault; differing from its twin only at the fault and its note; and with the fault
//      and the note taken from the twin, accepted, and the twin itself. The proof is shown firing on damaged twins.
//   4. what no fixture shows (README "What the new tasks must hold to", QA's task): an empty askAgain, a raise with a
//      count or another field, a wrongState naming a live state, and a firing's writes with askAgain, each refused, each
//      built from an accepted twin by one change, by errors that name it; and a commit with askAgain left out is v1.20's.
//   5. what the schema leaves to the fixtures, read from every accepted v1.21 exchange and shown firing on damaged
//      copies: one raise of the question its row asks; one open_question.asked_again entry, its ask count read and one
//      more (default 196); no question opened or closed and no clock row (README "Fixtures", v1.21); a committed raise
//      named in written at the version read plus one, first (defaults 192 and 198); a stale raise's versionChanged naming
//      the question at the version read; a closed question's wrongState naming it (item 81, default 193).
//   6. its sides (README "QA's task": "adds v1.21 to the fixture part's versions with its sides (C-152, C-087)"): each
//      side the README's consumers list names, its owner and its tasks, and the producer's side this task gives.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { CONTRACTS_ROOT, REPO_ROOT, formatErrors, type FixtureEntry } from "./_harness";

// ---------------------------------------------------------------------------------------------------------------
// The contract's files

const DATA_ACCESS_DIR = path.join(CONTRACTS_ROOT, "data-access");
const FIXTURES_DIR = path.join(DATA_ACCESS_DIR, "fixtures");
/** The version this file is written for, and the one before it, which it only adds to. */
const VERSION = "v1.21";
const BEFORE = "v1.20";
/** The definition README "Fixtures" (v1.21) lists every v1.21 fixture under. */
const FIXTURE_DEF = "commitTurn.askAgainExchange";

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** A value a file must hold; a miss is a broken test, never a refusal. */
function must<T>(value: T | null | undefined, what = "a value this test reads"): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A version's major and minor number: v1.21 is [1, 21]. */
function placeOf(version: string): [number, number] {
  const match = /^v(\d+)(?:\.(\d+))?$/.exec(version);
  if (match === null) throw new Error(`the index names a version this test cannot place: ${version}`);
  return [Number(match[1]), Number(match[2] ?? "0")];
}

/** Whether `earlier` is an earlier minor version than `later`, of the same major version. */
function isBefore(earlier: string, later: string): boolean {
  const [major, minor] = placeOf(earlier);
  const [laterMajor, laterMinor] = placeOf(later);
  return major === laterMajor && minor < laterMinor;
}

const index = readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: FixtureEntry[] };
const entries = index.fixtures;
/** v1.21's entries, selected by their version (DL-124, DL-125). */
const ofVersion = entries.filter((entry) => entry.version === VERSION);
const accepted = ofVersion.filter((entry) => entry.expect === "accept");
const refused = ofVersion.filter((entry) => entry.expect === "refuse");
/** Every accepted fixture of a version before v1.21. */
const earlierAccepted = entries.filter(
  (entry) => isBefore(entry.version, VERSION) && entry.expect === "accept",
);
/** Every version the index lists after v1.21, in order: each holds v1.21's accepted fixtures too. */
const LATER = [...new Set(entries.map((entry) => entry.version))]
  .filter((version) => isBefore(VERSION, version))
  .sort((a, b) => placeOf(a)[1] - placeOf(b)[1]);
const entryOf = (file: string): FixtureEntry =>
  must(
    entries.find((candidate) => candidate.file === file),
    `the index entry ${file}`,
  );

const parsed = new Map<string, unknown>();
/** A fresh copy of a fixture of this folder. */
function fixture(file: string): unknown {
  if (!parsed.has(file)) parsed.set(file, readJson(path.join(FIXTURES_DIR, ...file.split("/"))));
  return structuredClone(parsed.get(file));
}

/** A fixture's name as the README writes it: its file's name, without its folder or .json. */
const nameOf = (file: string): string => path.posix.basename(file, ".json");

// ---------------------------------------------------------------------------------------------------------------
// The schemas: every schema under contracts/, as contracts:check loads them, so each $ref resolves; one strict
// validator (Ajv 2020-12, as the T-003 harness sets it), and one that gives every error, for the places they name

const SKIPPED = new Set(["node_modules", "generated"]);

/** Every *.schema.json under `dir`, as contracts:check lists them (node_modules/ and generated/ left out). */
function schemaFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED.has(entry.name) ? [] : schemaFiles(full);
    return entry.isFile() && entry.name.endsWith(".schema.json") ? [full] : [];
  });
}

const schemaById = new Map<string, Record<string, unknown>>();
for (const file of schemaFiles(CONTRACTS_ROOT)) {
  const schema = readJson(file) as Record<string, unknown>;
  schemaById.set(must(schema.$id as string | undefined, `${file}'s $id`), schema);
}

const ajv = new Ajv2020({ strict: true, strictRequired: false });
const errorsAjv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
for (const schema of schemaById.values()) {
  ajv.addSchema(schema);
  errorsAjv.addSchema(structuredClone(schema));
}

const fileOf = (version: string): string => path.join(DATA_ACCESS_DIR, `data-access.${version}.schema.json`);
const idOf = (version: string): string => (readJson(fileOf(version)) as { $id: string }).$id;
const keyOf = (version: string, def: string): string => `${idOf(version)}#/$defs/${def}`;

/** The strict validator of one definition of a version's schema. */
function validatorOf(version: string, def: string): ValidateFunction {
  return must(ajv.getSchema(keyOf(version, def)), `the schema ${keyOf(version, def)}`);
}

/** Whether a value passes one definition of a version's schema. */
const passes = (version: string, def: string, value: unknown): boolean => validatorOf(version, def)(value);

/** The places the schema's errors name in a value: each error's path, with the field a required error misses. */
function errorPlaces(version: string, def: string, value: unknown): string[] {
  const validate = must(errorsAjv.getSchema(keyOf(version, def)), `the schema ${keyOf(version, def)}`);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => {
    const params = error.params as { missingProperty?: string; additionalProperty?: string };
    const steps = error.instancePath
      .split("/")
      .slice(1)
      .map((step) => step.replaceAll("~1", "/").replaceAll("~0", "~"));
    const field = params.missingProperty ?? params.additionalProperty;
    return [...steps, ...(field === undefined ? [] : [field])].join(".");
  });
}

/** A version's definitions, by name, as its file states them. */
const defsOf = (version: string): Record<string, unknown> =>
  must((readJson(fileOf(version)) as { $defs?: Record<string, unknown> }).$defs, `${version}'s $defs`);

/** Whether a definition is the earlier version's own of the same name, by reference and nothing more. */
const refersOn = (def: unknown, before: string, name: string): boolean =>
  isDeepStrictEqual(def, { $ref: `data-access.${before}.schema.json#/$defs/${name}` });

/** The exchanges a version's schema names at its root. */
function exchangesOf(version: string): string[] {
  const root = readJson(fileOf(version)) as { anyOf?: { $ref?: string }[] };
  return (root.anyOf ?? []).map((branch) => must(branch.$ref).replace("#/$defs/", ""));
}

// Compiled while the file loads, so no test pays for a first compile.
for (const entry of ofVersion) {
  validatorOf(VERSION, must(entry.def));
  errorPlaces(VERSION, must(entry.def), null);
}
for (const entry of earlierAccepted) validatorOf(VERSION, must(entry.def));

// ---------------------------------------------------------------------------------------------------------------
// The README

const readme = readFileSync(path.join(DATA_ACCESS_DIR, "README.md"), "utf8");
const readmeLines = readme.split("\n");

/** The README section whose heading starts so, from its heading to the next heading of its level or above. */
function sectionStarting(prefix: string): string {
  const level = must(/^#+/.exec(prefix), `${prefix}'s level`)[0].length;
  const start = readmeLines.findIndex((line) => line.startsWith(prefix));
  if (start < 0) throw new Error(`the README has no heading ${prefix}`);
  const rest = readmeLines.slice(start + 1);
  const end = rest.findIndex((line) => new RegExp(`^#{1,${String(level)}} `).test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** The README's line that starts so; a miss is a broken test. */
const lineStarting = (prefix: string, what: string): string =>
  must(
    readmeLines.find((line) => line.startsWith(prefix)),
    what,
  );

/** The names a README text writes in backticks, leaving out what its parentheses say. */
const namesIn = (text: string): string[] =>
  [...text.replaceAll(/\([^()]*\)/g, "").matchAll(/`([\w.]+)`/g)].map((match) => must(match[1]));

/** The text between two markers of a line; a miss is a broken test. */
function between(text: string, from: RegExp, to: RegExp): string {
  const start = from.exec(text);
  if (start === null) throw new Error(`no ${String(from)} in the README's line`);
  const rest = text.slice(start.index + start[0].length);
  const end = to.exec(rest);
  if (end === null) throw new Error(`no ${String(to)} after ${String(from)}`);
  return rest.slice(0, end.index);
}

const SECTION = sectionStarting(`## ${VERSION} (`);
/** README "Change log": v1.21's first row, which names what it restates and adds. */
const CHANGE_LOG = lineStarting(
  `- ${VERSION}, 2026-11-20 (T-1508): a minor version, frozen`,
  "v1.21's change log row",
);
/** README "Fixtures": the paragraph of v1.21's fixtures, which counts them and names each refused one's twin. */
const FIXTURES_PARAGRAPH = lineStarting(
  `**${VERSION}** (listed with`,
  "the README's v1.21 fixtures paragraph",
);
/** README "Consumers of v1.21": its list, through "What the new tasks must hold to". */
const CONSUMERS = sectionStarting(`### Consumers of ${VERSION}`);
/** README "What the new tasks must hold to": QA's task, which names this file's sides and what no fixture shows. */
const QA_TASK = must(
  CONSUMERS.split("\n").find((line) => line.startsWith("- **QA's task**")),
  "the README's QA's task line of v1.21",
);

// ---------------------------------------------------------------------------------------------------------------
// 1. v1.21 holds every v1.20 definition, restates five and adds three, and is frozen

describe("data-access v1.21: every v1.20 definition held, five restated and three added, as the README names them, and frozen", () => {
  const defs = defsOf(VERSION);
  const before = defsOf(BEFORE);
  const restated = Object.keys(before).filter((name) => !refersOn(defs[name], BEFORE, name));
  const added = Object.keys(defs).filter((name) => !Object.hasOwn(before, name));

  it("holds every v1.20 definition under its own name, each but the restated ones by reference to v1.20's alone", () => {
    expect(Object.keys(before).length).toBeGreaterThan(100);
    expect(Object.keys(before).filter((name) => !Object.hasOwn(defs, name))).toEqual([]);
    for (const name of Object.keys(before)) validatorOf(VERSION, name);
  });

  it("restates the five and adds the three the change log names, and no other (README 'Change log', v1.21)", () => {
    const restatedNamed = namesIn(between(CHANGE_LOG, /Restated: /, / New definitions?: /));
    const addedNamed = namesIn(between(CHANGE_LOG, /New definitions?: /, / accepted and /));
    expect(restated.sort()).toEqual([...restatedNamed].sort());
    expect(added.sort()).toEqual([...addedNamed].sort());
    expect(restated.sort()).toEqual([
      "commitTurn.errors",
      "commitTurn.exchange",
      "commitTurn.handleIdExchange",
      "commitTurn.request",
      "writes",
    ]);
    expect(added.sort()).toEqual([
      "commitTurn.askAgainExchange",
      "openQuestionAskAgain",
      "openQuestionWrongStateError",
    ]);
    // The section's Kind names each as well ("it restates five ...; It adds three").
    for (const name of [...restated, ...added]) expect(SECTION, name).toContain(`\`${name}\``);
  });

  it("names at its root the calls v1.20 names, no call added (README section 'v1.21': 'fireClock and every other call are unchanged')", () => {
    expect(exchangesOf(VERSION)).toEqual(exchangesOf(BEFORE));
    expect(exchangesOf(VERSION)).not.toContain(FIXTURE_DEF);
  });

  it("is frozen: frozen.json lists it, and the README's status line and freeze record name it", () => {
    const frozen = (readJson(path.join(DATA_ACCESS_DIR, "frozen.json")) as { frozen: string[] }).frozen;
    expect(frozen).toContain(VERSION);
    expect(frozen).toContain(BEFORE);
    expect(lineStarting("**Status:", "the README's status line")).toContain(`"${VERSION}"`);
    expect(lineStarting(`Frozen ${VERSION}, `, "v1.21's freeze record")).toContain("reviews required: QA");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. v1.21's fixtures at v1.21 and every later version; every earlier accepted fixture at v1.21

describe("data-access v1.21: each fixture, selected by its version, at v1.21 and every later version", () => {
  it("selects accepted and refused v1.21 fixtures, each under commitTurn.askAgainExchange, as README 'Fixtures' counts and names them", () => {
    expect(accepted.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
    for (const entry of ofVersion) expect(entry.def, entry.file).toBe(FIXTURE_DEF);
    expect(FIXTURES_PARAGRAPH).toContain(`under \`${FIXTURE_DEF}\``);
    expect(FIXTURES_PARAGRAPH).toContain(`Accepted (${String(accepted.length)})`);
    expect(FIXTURES_PARAGRAPH).toContain(`Refused (${String(refused.length)}, in \`fixtures/invalid/\``);
    for (const entry of ofVersion)
      expect(FIXTURES_PARAGRAPH, entry.file).toContain(`\`${nameOf(entry.file)}\``);
    for (const entry of refused) expect(entry.file.startsWith("invalid/"), entry.file).toBe(true);
  });

  for (const entry of ofVersion) {
    it(`${entry.expect === "accept" ? "accepts" : "refuses"} ${entry.file} at ${VERSION} (${FIXTURE_DEF})`, () => {
      const validate = validatorOf(VERSION, must(entry.def));
      const valid = validate(fixture(entry.file));
      expect(valid, formatErrors(validate.errors).join("; ")).toBe(entry.expect === "accept");
    });
  }

  it("accepts each accepted v1.21 fixture at the same definition of every later version (a minor version only adds)", () => {
    for (const version of LATER) {
      for (const entry of accepted) {
        const validate = validatorOf(version, must(entry.def));
        expect(
          validate(fixture(entry.file)),
          `${entry.file} under ${version}: ${formatErrors(validate.errors).join("; ")}`,
        ).toBe(true);
      }
    }
  });

  it("accepts every accepted fixture of v1 to v1.20 at the same definition of v1.21, each earlier commit exchange under commitTurn.exchange or commitTurn.handleIdExchange among them", () => {
    expect(earlierAccepted.length).toBeGreaterThan(0);
    for (const entry of earlierAccepted) {
      const validate = validatorOf(VERSION, must(entry.def));
      expect(
        validate(fixture(entry.file)),
        `${entry.file} (${entry.version}) under ${VERSION}: ${formatErrors(validate.errors).join("; ")}`,
      ).toBe(true);
    }
    expect(QA_TASK).toContain(
      "every earlier commit exchange accepted by v1.21's `commitTurn.exchange` and `commitTurn.handleIdExchange`",
    );
    for (const def of ["commitTurn.exchange", "commitTurn.handleIdExchange"]) {
      expect(
        earlierAccepted.filter((entry) => entry.def === def).length,
        `earlier exchanges under ${def}`,
      ).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Each refused fixture for its one fault, mended into its twin

interface Twin {
  /** The accepted v1.21 exchange the README names as the refused fixture's twin. */
  twin: string;
  /** The places in the refused fixture that carry its one fault, as its index entry and the README state them. */
  faults: string[];
}

/** Each refused v1.21 fixture's twin and fault, as README "Fixtures" (v1.21) and its index entry state them. */
const TWINS: Readonly<Record<string, Twin>> = {
  "invalid/refuse-commit-s1-02-asks-again-twice.json": {
    twin: "commit-s1-02-sam-asks-again.json",
    faults: ["request.writes.openQuestions.askAgain.1"],
  },
  "invalid/refuse-commit-s1-02-asks-again-and-closes.json": {
    twin: "commit-s1-02-sam-asks-again.json",
    faults: ["request.writes.openQuestions.close.0"],
  },
};

/** The one place beside its fault a refused fixture differs from its twin (README "Fixtures", v1.21: "their note"). */
const NOTE = "given.note";

const stepsOf = (at: string): string[] => (at === "" ? [] : at.split("."));

/** The value at a dotted path, or none (found false) where a step is missing. */
function lookUp(value: unknown, at: string): { found: boolean; value: unknown } {
  let node = value;
  for (const step of stepsOf(at)) {
    if (Array.isArray(node) && /^\d+$/.test(step) && Number(step) < node.length) node = node[Number(step)];
    else if (isRecord(node) && Object.hasOwn(node, step)) node = node[step];
    else return { found: false, value: undefined };
  }
  return { found: true, value: node };
}

/** The value at a dotted path; a missing step is a broken test. */
function valueAt(value: unknown, at: string): unknown {
  const looked = lookUp(value, at);
  if (!looked.found) throw new Error(`no ${at}`);
  return looked.value;
}

/** The dotted paths at which two JSON values differ; an item one array holds past the other's end differs alone. */
function differences(a: unknown, b: unknown, at = ""): string[] {
  if (isDeepStrictEqual(a, b)) return [];
  const inside = (step: string | number): string => (at === "" ? String(step) : `${at}.${String(step)}`);
  if (Array.isArray(a) && Array.isArray(b)) {
    const length = Math.max(a.length, b.length);
    return Array.from({ length }, (_, place) =>
      place < a.length && place < b.length ? differences(a[place], b[place], inside(place)) : [inside(place)],
    ).flat();
  }
  if (isRecord(a) && isRecord(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
      Object.hasOwn(a, key) && Object.hasOwn(b, key)
        ? differences(a[key], b[key], inside(key))
        : [inside(key)],
    );
  }
  return [at];
}

/** Whether a place is the field at `at` or inside it. */
const within = (place: string, at: string): boolean => place === at || place.startsWith(`${at}.`);
/** Whether a place is the field at `at`, inside it, or an object that holds it (never the whole value). */
const near = (place: string, at: string): boolean =>
  within(place, at) || (place !== "" && at.startsWith(`${place}.`));

/** Marks a field to take out, in withChange. */
const REMOVE = Symbol("remove");

/** A copy of `value` with the field at `at` set to `to`, or taken out (an array's item spliced out) for REMOVE. */
function withChange(value: unknown, at: string, to: unknown): unknown {
  const copy = structuredClone(value);
  const steps = stepsOf(at);
  const last = must(steps.pop(), `the last step of ${at}`);
  const parent = valueAt(copy, steps.join("."));
  if (Array.isArray(parent) && /^\d+$/.test(last)) {
    if (to === REMOVE) parent.splice(Number(last), 1);
    else parent[Number(last)] = structuredClone(to);
  } else if (isRecord(parent)) {
    if (to === REMOVE) Reflect.deleteProperty(parent, last);
    else parent[last] = structuredClone(to);
  } else {
    throw new Error(`${at} is inside no object`);
  }
  return copy;
}

/** A copy of `value` with each place taken from `right`: its value there, or taken out where `right` holds none. */
function mended(value: unknown, right: unknown, places: readonly string[]): unknown {
  return places.reduce<unknown>((copy, place) => {
    const from = lookUp(right, place);
    return withChange(copy, place, from.found ? from.value : REMOVE);
  }, value);
}

/** How a refused fixture's index entry names its fault and its twin: "its one fault <place>; put right, it is <twin>". */
const showsFault = (fault: string): string => `its one fault ${fault}`;
const showsTwin = (twin: string): string => `put right, it is ${nameOf(twin)}`;

/**
 * Each way a refused fixture fails to be its twin with one fault, none when it is: refused as it stands; the schema's
 * errors name its fault; it differs from its twin only at the fault and its note, and at each fault; with each fault
 * and the note taken from the twin, it is accepted, and is the twin.
 */
export function twinProblems(
  entry: FixtureEntry,
  twin: Twin,
  value: unknown = fixture(entry.file),
): string[] {
  const problems: string[] = [];
  const def = must(entry.def);
  if (passes(entry.version, def, value)) problems.push(`${entry.file} is accepted as it stands`);
  const named = errorPlaces(entry.version, def, value);
  if (!named.some((place) => twin.faults.some((fault) => near(place, fault)))) {
    const names = named.length === 0 ? "" : `: ${named.join("; ")}`;
    problems.push(`the schema's errors name none of ${twin.faults.join(", ")}${names}`);
  }
  const right = fixture(twin.twin);
  const differ = differences(value, right);
  for (const place of differ) {
    if (![...twin.faults, NOTE].some((fault) => within(place, fault))) {
      problems.push(`it differs from ${twin.twin} at ${place}, which is not the fault`);
    }
  }
  for (const fault of twin.faults) {
    if (!differ.some((place) => within(place, fault) || within(fault, place))) {
      problems.push(`the fault ${fault} is not where it differs from ${twin.twin}`);
    }
  }
  const mend = mended(value, right, [...twin.faults, NOTE]);
  if (!passes(entry.version, def, mend)) problems.push(`mended from ${twin.twin}, it is still refused`);
  else if (!isDeepStrictEqual(mend, right)) problems.push(`mended, it is not ${twin.twin}`);
  return problems;
}

describe("data-access v1.21: each refused fixture for its one fault, mended from its twin into its twin", () => {
  it("has a twin for every refused v1.21 fixture and for no other file: an accepted v1.21 exchange, as its index entry and the README name it, with its fault", () => {
    expect(Object.keys(TWINS).sort()).toEqual(refused.map((entry) => entry.file).sort());
    for (const entry of refused) {
      const twin = must(TWINS[entry.file], `${entry.file}'s twin`);
      const twinEntry = entryOf(twin.twin);
      expect([twinEntry.version, twinEntry.expect, twinEntry.def], `${entry.file}'s twin`).toEqual([
        VERSION,
        "accept",
        entry.def,
      ]);
      expect(FIXTURES_PARAGRAPH, entry.file).toContain(`put right, it is \`${nameOf(twin.twin)}\``);
      for (const fault of twin.faults) {
        expect(entry.shows, `${entry.file}: its index entry names its fault`).toContain(showsFault(fault));
        expect(FIXTURES_PARAGRAPH, `${entry.file}: the README names its fault`).toContain(
          `its one fault \`${fault}\``,
        );
      }
      expect(entry.shows, `${entry.file}: its index entry names its twin`).toContain(showsTwin(twin.twin));
    }
  });

  for (const entry of refused) {
    const twin = TWINS[entry.file];
    it(`refuses ${entry.file} for its one fault (${twin?.faults.join(", ") ?? "none"}); mended from ${twin?.twin ?? "no twin"}, it is that twin`, () => {
      expect(twinProblems(entry, must(twin, `${entry.file}'s twin`))).toEqual([]);
    });
  }

  it("has the proof fire on a damaged twin: a fault named elsewhere, another twin, a fixture accepted as it stands", () => {
    const entry = entryOf("invalid/refuse-commit-s1-02-asks-again-twice.json");
    const own = must(TWINS[entry.file]);
    const twin = own.twin;
    expect(twinProblems(entry, own)).toEqual([]);
    const elsewhere = twinProblems(entry, { ...own, faults: ["request.writes.openQuestions.close.0"] });
    expect(elsewhere).toContain(
      `it differs from ${twin} at request.writes.openQuestions.askAgain.1, which is not the fault`,
    );
    expect(elsewhere).toContain(
      `the fault request.writes.openQuestions.close.0 is not where it differs from ${twin}`,
    );
    expect(elsewhere).toContain(`mended from ${twin}, it is still refused`);
    const stale = "commit-s1-02-sam-asks-again-stale.json";
    const other = twinProblems(entry, { ...own, twin: stale });
    expect(other).toContain(`it differs from ${stale} at request.turn.id, which is not the fault`);
    expect(other).toContain(`it differs from ${stale} at outcome.error, which is not the fault`);
    expect(other).toContain(`mended, it is not ${stale}`);
    expect(twinProblems(entry, own, fixture(twin))).toEqual([
      `${entry.file} is accepted as it stands`,
      `the schema's errors name none of ${own.faults.join(", ")}`,
      `the fault ${own.faults.join(", ")} is not where it differs from ${twin}`,
    ]);
    // An index entry or README that named another fault or twin would not hold the phrases the first test reads.
    expect(entry.shows).not.toContain(showsFault("request.writes.openQuestions.close.0"));
    expect(entry.shows).not.toContain(showsTwin(stale));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. What no fixture shows (README "What the new tasks must hold to", QA's task)

const ASK_AGAIN = "commit-s1-02-sam-asks-again.json";
const DEFAULTED = "commit-a7-03-alex-asks-again-defaulted.json";
const FIRE_ONCE = "fire-once.json";
const RAISES = "request.writes.openQuestions.askAgain";

interface Unshown {
  /** What README QA's task says this case shows. */
  readme: string;
  /** The accepted fixture the case is built from, by one change. */
  from: string;
  /** The definitions of v1.21 that refuse the change, each accepting `from` as it stands. */
  defs: string[];
  /** The one change: the place, and its new value. */
  at: string;
  to: unknown;
}

/** Each case README QA's task names that no v1.21 fixture shows, each one change from an accepted fixture. */
const UNSHOWN: readonly Unshown[] = [
  {
    readme: "an empty `askAgain` refused",
    from: ASK_AGAIN,
    defs: [FIXTURE_DEF, "commitTurn.exchange"],
    at: RAISES,
    to: [],
  },
  {
    readme: "a raise with a count or another field refused",
    from: ASK_AGAIN,
    defs: [FIXTURE_DEF, "commitTurn.exchange"],
    at: `${RAISES}.0.askCount`,
    to: 2,
  },
  {
    readme: "a raise with a count or another field refused",
    from: ASK_AGAIN,
    defs: [FIXTURE_DEF, "commitTurn.exchange"],
    at: `${RAISES}.0.status`,
    to: "waiting",
  },
  {
    readme: "`wrongState` naming a live state refused",
    from: DEFAULTED,
    defs: [FIXTURE_DEF, "commitTurn.exchange"],
    at: "outcome.state",
    to: "waiting",
  },
  {
    readme: "`wrongState` naming a live state refused",
    from: DEFAULTED,
    defs: [FIXTURE_DEF, "commitTurn.exchange"],
    at: "outcome.state",
    to: "open",
  },
  {
    readme: "a firing's writes with `askAgain` refused (`fireClock.exchange`)",
    from: FIRE_ONCE,
    defs: ["fireClock.exchange"],
    at: RAISES,
    to: [{ id: "oq-a7-03-alex", expectVersion: 2 }],
  },
];

/** Each way a case fails to show its refusal, none when it does: its fixture accepted, the change refused, named. */
export function unshownProblems(unshown: Unshown): string[] {
  const problems: string[] = [];
  const changed = withChange(fixture(unshown.from), unshown.at, unshown.to);
  for (const def of unshown.defs) {
    if (!passes(VERSION, def, fixture(unshown.from))) problems.push(`${unshown.from} is refused by ${def}`);
    if (passes(VERSION, def, changed)) problems.push(`${unshown.at} changed is accepted by ${def}`);
    else if (!errorPlaces(VERSION, def, changed).some((place) => near(place, unshown.at))) {
      problems.push(`${def}'s errors name no place near ${unshown.at}`);
    }
  }
  return problems;
}

describe("data-access v1.21: what no fixture shows, each one change from an accepted fixture, refused where the change is", () => {
  it("names in README QA's task each case this file shows", () => {
    for (const unshown of UNSHOWN) expect(QA_TASK, unshown.readme).toContain(unshown.readme);
  });

  for (const unshown of UNSHOWN) {
    it(`${unshown.readme}: ${unshown.from} with ${unshown.at} set to ${JSON.stringify(unshown.to)}`, () => {
      expect(unshownProblems(unshown)).toEqual([]);
    });
  }

  it("refuses a wrongState naming a live state as an open question's error alone (openQuestionWrongStateError, commitTurn.errors)", () => {
    const outcome = valueAt(fixture(DEFAULTED), "outcome");
    for (const def of ["openQuestionWrongStateError", "commitTurn.errors"]) {
      expect(passes(VERSION, def, outcome), def).toBe(true);
      for (const state of ["waiting", "open"]) {
        expect(passes(VERSION, def, withChange(outcome, "state", state)), `${def}: ${state}`).toBe(false);
      }
    }
  });

  it("refuses a firing's askAgain with its close emptied too: a firing's writes are v1.1's, so no raise is taken there (default 199)", () => {
    const fire = withChange(fixture(FIRE_ONCE), "request.writes.openQuestions.close", []);
    expect(passes(VERSION, "fireClock.exchange", fire)).toBe(true);
    const raising = withChange(fire, RAISES, [{ id: "oq-a7-03-alex", expectVersion: 2 }]);
    expect(passes(VERSION, "fireClock.exchange", raising)).toBe(false);
    expect(errorPlaces(VERSION, "fireClock.exchange", raising)).toContain(RAISES);
  });

  it("takes a commit with askAgain left out as v1.20's: v1.20 and v1.21 accept it, the narrowing refuses it, and v1.20 refuses the raise", () => {
    const left = withChange(fixture(ASK_AGAIN), RAISES, REMOVE);
    expect(passes(BEFORE, "commitTurn.exchange", left)).toBe(true);
    expect(passes(VERSION, "commitTurn.exchange", left)).toBe(true);
    expect(passes(VERSION, FIXTURE_DEF, left)).toBe(false);
    expect(passes(BEFORE, "commitTurn.exchange", fixture(ASK_AGAIN))).toBe(false);
    expect(errorPlaces(BEFORE, "commitTurn.exchange", fixture(ASK_AGAIN))).toContain(RAISES);
  });

  it("has the case check fire: a change the schema takes, and a fixture the definition refuses as it stands", () => {
    const taken: Unshown = { ...must(UNSHOWN[1]), at: `${RAISES}.0.expectVersion`, to: 2 };
    expect(unshownProblems(taken)).toEqual([
      `${RAISES}.0.expectVersion changed is accepted by ${FIXTURE_DEF}`,
      `${RAISES}.0.expectVersion changed is accepted by commitTurn.exchange`,
    ]);
    const firing: Unshown = { ...must(UNSHOWN[5]), defs: [FIXTURE_DEF] };
    expect(unshownProblems(firing)).toContain(`${FIRE_ONCE} is refused by ${FIXTURE_DEF}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. What the schema leaves to the fixtures, read from them

type Row = Record<string, unknown>;

interface Exchange {
  call: string;
  given: { after: string[]; now: string };
  request: {
    writes: {
      openQuestions: { open: Row[]; close: Row[]; askAgain: Row[] };
      clockRows: { make: Row[]; cancel: Row[] };
      outboxRows: Row[];
      events: Row[];
      state: Row[];
    };
  };
  outcome: Row;
}
const exchangeOf = (file: string): Exchange => fixture(file) as Exchange;

/** The rows of one list of a value (none where it holds no such list). */
const rowsOf = (holder: unknown, list: string): Row[] => {
  const rows = isRecord(holder) ? holder[list] : undefined;
  return Array.isArray(rows) ? (rows as Row[]) : [];
};

/**
 * Each way an accepted v1.21 exchange breaks what the schema leaves to the fixtures (README item 81, defaults 192 to
 * 198, "Fixtures" v1.21), none when it holds: one raise, of the question its one row asks; one asked_again entry for
 * that question, its ask count read and one more; no question opened or closed and no clock row; committed, the raise
 * named first in written at the version read plus one and each row in commit order; refused versionChanged, the
 * question named at the version read with a later one now; refused wrongState, the question named.
 */
export function raiseProblems(exchange: Exchange): string[] {
  const problems: string[] = [];
  const { writes } = exchange.request;
  const raise = must(writes.openQuestions.askAgain[0], "a raise");
  const id = raise.id;
  const read = Number(raise.expectVersion);
  const rows = writes.outboxRows;
  if (rows.length !== 1 || rows[0]?.openQuestionId !== id) {
    problems.push(`the raise of ${String(id)} rides with no one row that asks it`);
  }
  const askedAgain = writes.events.filter((event) => event.kind === "open_question.asked_again");
  const [entry] = askedAgain;
  if (askedAgain.length !== 1 || entry === undefined) {
    problems.push(`${String(askedAgain.length)} open_question.asked_again entries, not one (default 196)`);
  } else {
    if (entry.tableName !== "open_questions" || entry.rowId !== id) {
      problems.push(
        `the asked_again entry names ${String(entry.tableName)} ${String(entry.rowId)}, not ${String(id)}`,
      );
    }
    const before = Number(valueAt(entry, "oldValues.ask_count"));
    const after = Number(valueAt(entry, "newValues.ask_count"));
    if (after !== before + 1) {
      problems.push(
        `the asked_again entry raises ask_count ${String(before)} to ${String(after)}, not by one`,
      );
    }
  }
  const opensOrMakes =
    writes.openQuestions.open.length + writes.openQuestions.close.length + writes.clockRows.make.length;
  if (opensOrMakes + writes.clockRows.cancel.length > 0) {
    problems.push("the commit opens or closes a question or writes a clock row beside the raise");
  }
  const { outcome } = exchange;
  if (outcome.error === "versionChanged") {
    const named = rowsOf(outcome, "changed").find(
      (row) => row.table === "open_questions" && row.rowId === id,
    );
    if (named === undefined) problems.push(`the versionChanged names no open_questions ${String(id)}`);
    else if (named.readVersion !== read || Number(named.currentVersion) <= read) {
      problems.push(
        `the versionChanged names ${String(id)} read ${String(named.readVersion)}, now ${String(named.currentVersion)}, not read ${String(read)} and later now`,
      );
    }
  } else if (outcome.error === "wrongState") {
    if (outcome.table !== "open_questions" || outcome.rowId !== id) {
      problems.push(
        `the wrongState names ${String(outcome.table)} ${String(outcome.rowId)}, not ${String(id)}`,
      );
    }
  } else if ("error" in outcome) {
    problems.push(`the raise is answered ${String(outcome.error)}`);
  } else {
    const written = rowsOf(valueAt(outcome, "committed"), "written");
    const first = written[0];
    if (first?.table !== "open_questions" || first.rowId !== id || first.version !== read + 1) {
      problems.push(
        `written names ${JSON.stringify(first ?? null)} first, not open_questions ${String(id)} at ${String(read + 1)}`,
      );
    }
    const answered = rowsOf(valueAt(outcome, "committed"), "outboxRows").map((row) => row.id);
    if (
      !isDeepStrictEqual(
        answered,
        rows.map((row) => row.id),
      )
    ) {
      problems.push(`the answer's rows ${answered.join(", ")} are not the request's, in order`);
    }
  }
  return problems;
}

describe("data-access v1.21: what the schema leaves to the fixtures, each check also shown firing", () => {
  it("has every accepted v1.21 exchange raise its row's question once, with one entry, at the version read, and answer it as item 81 says", () => {
    for (const entry of accepted) expect(raiseProblems(exchangeOf(entry.file)), entry.file).toEqual([]);
    const answers = accepted.map((entry) => exchangeOf(entry.file).outcome);
    // Each answer item 81 gives is shown: committed, versionChanged and wrongState.
    expect(answers.map((outcome) => String(outcome.error ?? outcome.result)).sort()).toEqual([
      "committed",
      "versionChanged",
      "wrongState",
    ]);
  });

  it("has the checks fire on a damaged copy: written at another version, an entry raising by two, a second entry, a stale raise at the version now, another question named", () => {
    const asks = exchangeOf(ASK_AGAIN);
    const written = must(rowsOf(valueAt(asks.outcome, "committed"), "written")[0]);
    written.version = 3;
    const raised = must(asks.request.writes.events[0]);
    raised.newValues = { ask_count: 3 };
    expect(raiseProblems(asks)).toEqual([
      "the asked_again entry raises ask_count 1 to 3, not by one",
      `written names ${JSON.stringify(written)} first, not open_questions oq-s1-02-sam-1 at 2`,
    ]);
    const twice = exchangeOf(ASK_AGAIN);
    twice.request.writes.events = [must(twice.request.writes.events[0]), ...twice.request.writes.events];
    twice.request.writes.clockRows.cancel = [{ id: "clock-oq-s1-02-sam-1", expectVersion: 1 }];
    expect(raiseProblems(twice)).toEqual([
      "2 open_question.asked_again entries, not one (default 196)",
      "the commit opens or closes a question or writes a clock row beside the raise",
    ]);
    const stale = exchangeOf("commit-s1-02-sam-asks-again-stale.json");
    must(rowsOf(stale.outcome, "changed")[0]).currentVersion = 1;
    expect(raiseProblems(stale)).toEqual([
      "the versionChanged names oq-s1-02-sam-1 read 1, now 1, not read 1 and later now",
    ]);
    const closed = exchangeOf(DEFAULTED);
    closed.outcome.rowId = "oq-s1-02-sam-1";
    must(closed.request.writes.outboxRows[0]).openQuestionId = "oq-s1-02-sam-1";
    expect(raiseProblems(closed)).toEqual([
      "the raise of oq-a7-03-alex rides with no one row that asks it",
      "the wrongState names open_questions oq-s1-02-sam-1, not oq-a7-03-alex",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 6. Its sides (README "Consumers of v1.21"; QA's task: "with its sides (C-152, C-087)")

interface Side {
  /** The component, as the README names it. */
  component: string;
  /** Its owner, as the consumers list's bullet names it, in bold. */
  owner: string;
  /** The tasks the bullet names beside the component. */
  tasks: string[];
}

/** v1.21's sides: the producer's database side and the action-layer engineer's commit (README "Consumers of v1.21"). */
const SIDES: readonly Side[] = [
  { component: "C-152", owner: "Database engineer", tasks: ["T-1509", "T-1513"] },
  { component: "C-087", owner: "Action-layer engineer", tasks: ["T-1505"] },
];

/** This task's database side of v1.21: the producer's (C-152), each v1.21 exchange through db/repo's commitTurn. */
const DB_SIDE = path.join(REPO_ROOT, "tests", "contract", `data-access.${VERSION}.db-side.test.ts`);

describe("data-access v1.21: its sides, as README 'Consumers of v1.21' and QA's task name them", () => {
  it("names in QA's task exactly the components of its sides", () => {
    const named = must(/with its sides \(([^)]*)\)/.exec(QA_TASK), "QA's task's sides")[1] ?? "";
    expect(named.split(/, | and /).sort()).toEqual(SIDES.map((side) => side.component).sort());
  });

  it("puts each side's component under its owner in the consumers list, with its tasks", () => {
    const bullets = CONSUMERS.split("\n").filter((line) => line.startsWith("- **"));
    for (const side of SIDES) {
      const bullet = must(
        bullets.find((line) => /^- \*\*([^*]+?):?\*\*/.exec(line)?.[1] === side.owner),
        `the consumers bullet of ${side.owner}`,
      );
      expect(bullet, side.component).toContain(`${side.component}, ${must(side.tasks[0])}`);
      for (const task of side.tasks) expect(bullet, `${side.component}: ${task}`).toContain(task);
    }
  });

  it("gives the producer's side (C-152) as this task's database side, beside this file", () => {
    expect(existsSync(DB_SIDE)).toBe(true);
    expect(readFileSync(DB_SIDE, "utf8")).toContain("commitTurn");
  });
});
