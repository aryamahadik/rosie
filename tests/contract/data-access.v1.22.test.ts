// Contract test for K-05 v1.22, an outbox row carries its own step and line: the schema side (T-1522; T-1474's freeze
// and its QA note, "QA's data-access.v1.22 contract test (mends and sides)"; DL-999, DL-1030, DL-1101;
// contracts/data-access/README.md section "v1.22", items 82 and 83, defaults 206 to 214, "Consumers of v1.22", "What the
// new tasks must hold to" (QA's task), and "Fixtures", v1.22).
//
// data-access.v1.test.ts checks every fixture of every version against the schema of its version (its parts 1, 3 and
// 4); data-access.v1.22.db-side.test.ts is v1.22's database side, each v1.22 exchange through db/repo's commitTurn and
// readOutboxRow (T-1476). This file proves the rest, reading only the committed schemas, fixtures and README:
//   1. v1.22 holds every v1.21 definition under its own name, restates the thirteen and adds the one the README's change
//      log names and no other, names the same calls at its root as v1.21, and is frozen (frozen.json, the README's status
//      line and freeze record).
//   2. v1.22's fixtures, selected by their version, never by a pinned list or count (DL-124, DL-125): each against
//      data-access.v1.22.schema.json at its own definition (the commit under commitTurn.rowLineExchange, the reads under
//      readOutboxRow.exchange), accepted or refused as the index marks it and as README "Fixtures" (v1.22) counts and names
//      them; each accepted one at the same definition of every later version; every accepted fixture of v1 to v1.21 at
//      the same definition of v1.22, each earlier commit, read and reader exchange among them, the frozen
//      read-outbox-row-no-question too; and what v1.22 adds, refused by v1.21 (a row's step, a line from the row).
//   3. the refused fixture for its one fault, mended into its twin (README "Fixtures", v1.22: "put right, it is
//      commit-s1-04-sam-lines"; "It differs ... in that one field and its note alone"): refused as it stands, by errors
//      that name its fault; differing from its twin only at the fault and its note; and with the fault and the note taken
//      from the twin, accepted, and the twin itself. The proof is shown firing on damaged twins.
//   4. what no fixture shows (README "What the new tasks must hold to", QA's task): a lineNo with no step, a negative
//      lineNo, a step not in K-01's form and a rowLine.from other than the two, each refused, each built from an accepted
//      twin by one change, by errors that name it; a step or a line given null refused (default 206); a line from the row
//      taken by the reader mapping (default 214); and a commit whose rows name neither is v1.21's (item 82).
//   5. what the schema leaves to the fixtures (README item 83: "That row is answered whenever the row stores a step, and
//      openQuestion only when it stores none, is the producer's to keep"), read from every accepted readOutboxRow exchange
//      whose row its world holds (K-04's seeds and the exchanges its chain runs first), and shown firing on damaged
//      copies: its line is the row's own pair, from row,
//      when the row stores one, else its question's step at index 0, from openQuestion, else null; the older row read as
//      v1.6's read-outbox-row-s1-02-no-kinds but for the moment (default 212); and the commit's answer naming its rows in
//      commit order, a row's step and line changing nothing in it (item 82).
//   6. its sides (README "QA's task": "adds v1.22 to the fixture part's versions with its sides (C-152, C-087, C-074)"):
//      each side the README's consumers list names, its owner and its tasks, and the producer's side this task gives.

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
const VERSION = "v1.22";
const BEFORE = "v1.21";
/** The definitions README "Fixtures" (v1.22) lists the v1.22 fixtures under: the commit's, and the reads'. */
const COMMIT_DEF = "commitTurn.rowLineExchange";
const READ_DEF = "readOutboxRow.exchange";
const FIXTURE_DEFS: Readonly<Record<string, string>> = { commitTurn: COMMIT_DEF, readOutboxRow: READ_DEF };

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

/** A version's major and minor number: v1.22 is [1, 22]. */
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
/** v1.22's entries, selected by their version (DL-124, DL-125). */
const ofVersion = entries.filter((entry) => entry.version === VERSION);
const accepted = ofVersion.filter((entry) => entry.expect === "accept");
const refused = ofVersion.filter((entry) => entry.expect === "refuse");
/** Every accepted fixture of a version before v1.22. */
const earlierAccepted = entries.filter(
  (entry) => isBefore(entry.version, VERSION) && entry.expect === "accept",
);
/** Every version the index lists after v1.22, in order: each holds v1.22's accepted fixtures too. */
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

/** The call an exchange fixture names. */
const callOf = (file: string): string => String((fixture(file) as { call?: unknown }).call);

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
/** README "Change log": v1.22's row, which names what it restates and adds. */
const CHANGE_LOG = lineStarting(
  `- ${VERSION}, 2026-11-21 (T-1474): a minor version, frozen`,
  "v1.22's change log row",
);
/** README "Fixtures": the paragraph of v1.22's fixtures, which counts them and names the refused one's twin. */
const FIXTURES_PARAGRAPH = lineStarting(
  `**${VERSION}** (listed with`,
  "the README's v1.22 fixtures paragraph",
);
/** README "Consumers of v1.22": its list, through "What the new tasks must hold to". */
const CONSUMERS = sectionStarting(`### Consumers of ${VERSION}`);
/** README "What the new tasks must hold to": QA's task, which names this file's sides and what no fixture shows. */
const QA_TASK = must(
  CONSUMERS.split("\n").find((line) => line.startsWith("- **QA's task**")),
  "the README's QA's task line of v1.22",
);

// ---------------------------------------------------------------------------------------------------------------
// 1. v1.22 holds every v1.21 definition, restates thirteen and adds one, and is frozen

describe("data-access v1.22: every v1.21 definition held, thirteen restated and one added, as the README names them, and frozen", () => {
  const defs = defsOf(VERSION);
  const before = defsOf(BEFORE);
  const restated = Object.keys(before).filter((name) => !refersOn(defs[name], BEFORE, name));
  const added = Object.keys(defs).filter((name) => !Object.hasOwn(before, name));

  it("holds every v1.21 definition under its own name, each but the restated ones by reference to v1.21's alone", () => {
    expect(Object.keys(before).length).toBeGreaterThan(100);
    expect(Object.keys(before).filter((name) => !Object.hasOwn(defs, name))).toEqual([]);
    for (const name of Object.keys(before)) validatorOf(VERSION, name);
  });

  it("restates the thirteen and adds the one the change log names, and no other (README 'Change log', v1.22)", () => {
    const restatedNamed = namesIn(between(CHANGE_LOG, /Restated: /, / New definitions?: /));
    const addedNamed = namesIn(between(CHANGE_LOG, /New definitions?: /, / accepted and /));
    expect(restated.sort()).toEqual([...restatedNamed].sort());
    expect(added.sort()).toEqual([...addedNamed].sort());
    expect(restated.sort()).toEqual([
      "commitTurn.askAgainExchange",
      "commitTurn.exchange",
      "commitTurn.handleIdExchange",
      "commitTurn.request",
      "outboxRowNew",
      "readOutboxRow.exchange",
      "readOutboxRow.response",
      "readOutboxRow.v1dot6Response",
      "rowLine",
      "rowReader.exchange",
      "rowReader.ownerExchange",
      "rowReader.request",
      "writes",
    ]);
    expect(added).toEqual([COMMIT_DEF]);
    // The section's Kind names each as well.
    for (const name of [...restated, ...added]) expect(SECTION, name).toContain(`\`${name}\``);
  });

  it("names at its root the calls v1.21 names, no call added (README section 'v1.22': 'fireClock and every other call are unchanged')", () => {
    expect(exchangesOf(VERSION)).toEqual(exchangesOf(BEFORE));
    expect(exchangesOf(VERSION)).not.toContain(COMMIT_DEF);
  });

  it("is frozen: frozen.json lists it, and the README's status line and freeze record name it", () => {
    const frozen = (readJson(path.join(DATA_ACCESS_DIR, "frozen.json")) as { frozen: string[] }).frozen;
    expect(frozen).toContain(VERSION);
    expect(frozen).toContain(BEFORE);
    expect(lineStarting("**Status:", "the README's status line")).toContain(`"${VERSION}"`);
    expect(lineStarting(`Frozen ${VERSION}, `, "v1.22's freeze record")).toContain("reviews required: QA");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. v1.22's fixtures at v1.22 and every later version; every earlier accepted fixture at v1.22

const COMMIT = "commit-s1-04-sam-lines.json";
const READ_S1_08 = "read-outbox-row-s1-08-sam.json";
const OLDER_ROW = "read-outbox-row-s1-02-older-row.json";
const NO_QUESTION = "read-outbox-row-no-question.json";
const NO_KINDS = "read-outbox-row-s1-02-no-kinds.json";
const READER = "row-reader-s1-02-no-role-no-owner.json";

/** The earlier definitions README "Fixtures" (v1.22) says v1.22 still accepts every earlier exchange of. */
const EARLIER_DEFS = [
  "commitTurn.exchange",
  "commitTurn.handleIdExchange",
  "commitTurn.askAgainExchange",
  "readOutboxRow.exchange",
  "rowReader.exchange",
  "rowReader.ownerExchange",
];

describe("data-access v1.22: each fixture, selected by its version, at v1.22 and every later version", () => {
  it("selects accepted and refused v1.22 fixtures, the commits under commitTurn.rowLineExchange and the reads under readOutboxRow.exchange, as README 'Fixtures' counts and names them", () => {
    expect(accepted.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
    for (const entry of ofVersion) expect(entry.def, entry.file).toBe(FIXTURE_DEFS[callOf(entry.file)]);
    expect(FIXTURES_PARAGRAPH).toContain(
      `the commit under \`${COMMIT_DEF}\` and the reads under \`${READ_DEF}\``,
    );
    expect(FIXTURES_PARAGRAPH).toContain(`Accepted (${String(accepted.length)})`);
    expect(FIXTURES_PARAGRAPH).toContain(`Refused (${String(refused.length)}, in \`fixtures/invalid/\``);
    for (const entry of ofVersion)
      expect(FIXTURES_PARAGRAPH, entry.file).toContain(`\`${nameOf(entry.file)}\``);
    for (const entry of refused) expect(entry.file.startsWith("invalid/"), entry.file).toBe(true);
    for (const def of [COMMIT_DEF, READ_DEF]) {
      expect(
        accepted.filter((entry) => entry.def === def).length,
        `an accepted v1.22 exchange under ${def}`,
      ).toBeGreaterThan(0);
    }
  });

  for (const entry of ofVersion) {
    it(`${entry.expect === "accept" ? "accepts" : "refuses"} ${entry.file} at ${VERSION} (${entry.def ?? "root"})`, () => {
      const validate = validatorOf(VERSION, must(entry.def));
      const valid = validate(fixture(entry.file));
      expect(valid, formatErrors(validate.errors).join("; ")).toBe(entry.expect === "accept");
    });
  }

  it("accepts each accepted v1.22 fixture at the same definition of every later version (a minor version only adds)", () => {
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

  it("accepts every accepted fixture of v1 to v1.21 at the same definition of v1.22, each earlier commit, read and reader exchange and the frozen read-outbox-row-no-question among them", () => {
    expect(earlierAccepted.length).toBeGreaterThan(0);
    for (const entry of earlierAccepted) {
      const validate = validatorOf(VERSION, must(entry.def));
      expect(
        validate(fixture(entry.file)),
        `${entry.file} (${entry.version}) under ${VERSION}: ${formatErrors(validate.errors).join("; ")}`,
      ).toBe(true);
    }
    expect(QA_TASK).toContain(
      "every earlier commit, read and reader exchange accepted by v1.22's `commitTurn.exchange`, `readOutboxRow.exchange` and `rowReader.exchange` and their narrowings",
    );
    for (const def of EARLIER_DEFS) {
      expect(
        earlierAccepted.filter((entry) => entry.def === def).length,
        `earlier exchanges under ${def}`,
      ).toBeGreaterThan(0);
    }
    expect(earlierAccepted.map((entry) => entry.file)).toContain(NO_QUESTION);
    expect(
      valueAt(fixture(NO_QUESTION), "outcome.line"),
      "the frozen row that asks nothing reads no line",
    ).toBe(null);
  });

  it("is what takes a row's step and a line from the row: v1.21 refuses both, and v1.1's closed row refuses the step (default 213)", () => {
    expect(passes(BEFORE, "commitTurn.exchange", fixture(COMMIT))).toBe(false);
    expect(errorPlaces(BEFORE, "commitTurn.exchange", fixture(COMMIT))).toContain(
      "request.writes.outboxRows.0.step",
    );
    expect(passes("v1.1", "commitTurn.exchange", fixture(COMMIT))).toBe(false);
    expect(passes(BEFORE, READ_DEF, fixture(READ_S1_08))).toBe(false);
    expect(errorPlaces(BEFORE, READ_DEF, fixture(READ_S1_08))).toContain("outcome.line.from");
    // The older row's read, from its question, is one v1.21 and v1.6 take as they stand: unchanged.
    expect(passes(BEFORE, READ_DEF, fixture(OLDER_ROW))).toBe(true);
    expect(passes("v1.6", "readOutboxRow.v1dot6Response", valueAt(fixture(OLDER_ROW), "outcome"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. The refused fixture for its one fault, mended into its twin

interface Twin {
  /** The accepted v1.22 exchange the README names as the refused fixture's twin. */
  twin: string;
  /** The places in the refused fixture that carry its one fault, as its index entry and the README state them. */
  faults: string[];
}

/** The refused v1.22 fixture's twin and fault, as README "Fixtures" (v1.22) and its index entry state them. */
const TWINS: Readonly<Record<string, Twin>> = {
  "invalid/refuse-commit-s1-04-sam-step-without-line.json": {
    twin: COMMIT,
    faults: ["request.writes.outboxRows.0"],
  },
};

/** The one place beside its fault a refused fixture differs from its twin (README "Fixtures", v1.22: "its note"). */
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

/** How a refused fixture's index entry names its fault and its twin: "its one fault <place>, ...; put right, it is <twin>". */
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

describe("data-access v1.22: the refused fixture for its one fault, mended from its twin into its twin", () => {
  it("has a twin for every refused v1.22 fixture and for no other file: an accepted v1.22 exchange, as its index entry and the README name it, with its fault", () => {
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
    const entry = entryOf("invalid/refuse-commit-s1-04-sam-step-without-line.json");
    const own = must(TWINS[entry.file]);
    expect(twinProblems(entry, own)).toEqual([]);
    const elsewhere = twinProblems(entry, { ...own, faults: ["request.writes.outboxRows.1"] });
    expect(elsewhere).toContain(
      `it differs from ${COMMIT} at request.writes.outboxRows.0.lineNo, which is not the fault`,
    );
    expect(elsewhere).toContain(
      `the fault request.writes.outboxRows.1 is not where it differs from ${COMMIT}`,
    );
    expect(elsewhere).toContain(`mended from ${COMMIT}, it is still refused`);
    const other = "commit-s1-02-sam-asks-again.json";
    const another = twinProblems(entry, { ...own, twin: other });
    expect(another).toContain(`it differs from ${other} at request.turn.id, which is not the fault`);
    expect(another).toContain(`mended, it is not ${other}`);
    expect(twinProblems(entry, own, fixture(COMMIT))).toEqual([
      `${entry.file} is accepted as it stands`,
      `the schema's errors name none of ${own.faults.join(", ")}`,
      `the fault ${own.faults.join(", ")} is not where it differs from ${COMMIT}`,
    ]);
    expect(entry.shows).not.toContain(showsFault("request.writes.outboxRows.1"));
    expect(entry.shows).not.toContain(showsTwin(other));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. What no fixture shows (README "What the new tasks must hold to", QA's task)

const ROW_0 = "request.writes.outboxRows.0";

interface Unshown {
  /** What README QA's task says this case shows. */
  readme: string;
  /** The accepted fixture the case is built from, by one change. */
  from: string;
  /** The definitions of v1.22 that refuse the change, each accepting `from` as it stands. */
  defs: string[];
  /** The one change: the place, and its new value. */
  at: string;
  to: unknown;
}

/** Each case README QA's task names that no v1.22 fixture shows, each one change from an accepted fixture. */
const UNSHOWN: readonly Unshown[] = [
  {
    readme: "a `lineNo` with no step refused",
    from: COMMIT,
    defs: [COMMIT_DEF, "commitTurn.exchange"],
    at: `${ROW_0}.step`,
    to: REMOVE,
  },
  {
    readme: "a negative `lineNo` refused",
    from: COMMIT,
    defs: [COMMIT_DEF, "commitTurn.exchange"],
    at: `${ROW_0}.lineNo`,
    to: -1,
  },
  {
    readme: "a step not in K-01's form refused",
    from: COMMIT,
    defs: [COMMIT_DEF, "commitTurn.exchange"],
    at: `${ROW_0}.step`,
    to: "s1-08",
  },
  {
    readme: "a step not in K-01's form refused",
    from: COMMIT,
    defs: [COMMIT_DEF, "commitTurn.exchange"],
    at: `${ROW_0}.step`,
    to: "S1-8",
  },
  {
    readme: "a `rowLine.from` other than the two refused",
    from: READ_S1_08,
    defs: [READ_DEF],
    at: "outcome.line.from",
    to: "bundle",
  },
  {
    readme: "a `rowLine.from` other than the two refused",
    from: READER,
    defs: ["rowReader.exchange", "rowReader.ownerExchange"],
    at: "request.line.from",
    to: "bundle",
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

const describeTo = (to: unknown): string => (to === REMOVE ? "taken out" : `set to ${JSON.stringify(to)}`);

describe("data-access v1.22: what no fixture shows, each one change from an accepted fixture, refused where the change is", () => {
  it("names in README QA's task each case this file shows", () => {
    for (const unshown of UNSHOWN) expect(QA_TASK, unshown.readme).toContain(unshown.readme);
  });

  for (const unshown of UNSHOWN) {
    it(`${unshown.readme}: ${unshown.from} with ${unshown.at} ${describeTo(unshown.to)}`, () => {
      expect(unshownProblems(unshown)).toEqual([]);
    });
  }

  it("refuses a step or a line given null: both or neither, left out when neither, never null (default 206)", () => {
    for (const field of ["step", "lineNo"]) {
      const nulled = withChange(fixture(COMMIT), `${ROW_0}.${field}`, null);
      expect(passes(VERSION, COMMIT_DEF, nulled), field).toBe(false);
      expect(
        errorPlaces(VERSION, COMMIT_DEF, nulled).some((place) => near(place, `${ROW_0}.${field}`)),
        field,
      ).toBe(true);
    }
    // Both taken out, the row names no line, which is v1.22's one spelling of it.
    const neither = withChange(
      withChange(fixture(COMMIT), `${ROW_0}.step`, REMOVE),
      `${ROW_0}.lineNo`,
      REMOVE,
    );
    expect(passes(VERSION, COMMIT_DEF, neither)).toBe(true);
  });

  it("takes a line from the row in the reader mapping as one from the question (default 214), which v1.21 refuses", () => {
    const fromRow = withChange(fixture(READER), "request.line.from", "row");
    for (const def of ["rowReader.exchange", "rowReader.ownerExchange"]) {
      expect(passes(VERSION, def, fromRow), def).toBe(true);
      expect(passes(BEFORE, def, fromRow), `${BEFORE}'s ${def}`).toBe(false);
    }
  });

  it("takes a commit whose rows name neither as v1.21's, which the narrowing refuses (item 82: 'Left out, the call is v1.21's')", () => {
    const rows = (valueAt(fixture(COMMIT), "request.writes.outboxRows") as unknown[]).length;
    let neither = fixture(COMMIT);
    for (let row = 0; row < rows; row += 1) {
      for (const field of ["step", "lineNo"]) {
        neither = withChange(neither, `request.writes.outboxRows.${String(row)}.${field}`, REMOVE);
      }
    }
    expect(passes(BEFORE, "commitTurn.exchange", neither)).toBe(true);
    expect(passes(VERSION, "commitTurn.exchange", neither)).toBe(true);
    expect(passes(VERSION, COMMIT_DEF, neither)).toBe(false);
  });

  it("has the case check fire: a change the schema takes, and a fixture the definition refuses as it stands", () => {
    const taken: Unshown = { ...must(UNSHOWN[1]), to: 1 };
    expect(unshownProblems(taken)).toEqual([
      `${ROW_0}.lineNo changed is accepted by ${COMMIT_DEF}`,
      `${ROW_0}.lineNo changed is accepted by commitTurn.exchange`,
    ]);
    const read: Unshown = { ...must(UNSHOWN[4]), defs: [COMMIT_DEF] };
    expect(unshownProblems(read)).toContain(`${READ_S1_08} is refused by ${COMMIT_DEF}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. What the schema leaves to the fixtures, read from them

type Row = Record<string, unknown>;

interface Exchange {
  call: string;
  given: { k04Seeds: string[]; after: string[]; now: string };
  request: Row;
  outcome: Row;
}
const exchangeOf = (file: string): Exchange => fixture(file) as Exchange;

/** The rows of one list of a value (none where it holds no such list). */
const rowsOf = (holder: unknown, list: string): Row[] => {
  const rows = isRecord(holder) ? holder[list] : undefined;
  return Array.isArray(rows) ? (rows as Row[]) : [];
};

/** K-04's seeds, which a fixture's given names (given.k04Seeds), each with its own after chain. */
const CORE_SEEDS_DIR = path.join(CONTRACTS_ROOT, "db-schema", "core", "fixtures");

/** A seed file's rows after those of its `after` chain, each named relative to the file that names it, each file once. */
function seedRows(file: string, seen: Set<string>): Row[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const seed = readJson(file) as { after: string[]; rows: Row[] };
  return [
    ...seed.after.flatMap((before) => seedRows(path.join(path.dirname(file), before), seen)),
    ...seed.rows,
  ];
}

/** The exchanges a fixture's chain runs first, in order, each once, then the fixture itself. */
function chainOf(file: string, seen = new Set<string>()): Exchange[] {
  const exchange = exchangeOf(file);
  const before = exchange.given.after.flatMap((step) => {
    if (seen.has(step)) return [];
    seen.add(step);
    return chainOf(step, seen);
  });
  return [...before, exchange];
}

/** An outbox row as a world holds it: its own step and line, and the question it asks. */
interface WorldRow {
  step: unknown;
  lineNo: unknown;
  openQuestionId: unknown;
}

/**
 * The outbox rows and open questions a read's world holds before the read: the K-04 seed rows of every exchange of its
 * chain (snake_case), then the rows and questions each exchange its chain runs first writes (a commit's or a firing's
 * request, camelCase). Rows a fixture's note lists for its database side to write are in neither, so not here.
 */
function worldOf(file: string): { rows: Map<unknown, WorldRow>; questions: Map<unknown, unknown> } {
  const rows = new Map<unknown, WorldRow>();
  const questions = new Map<unknown, unknown>();
  const chain = chainOf(file);
  const seen = new Set<string>();
  for (const exchange of chain) {
    for (const seed of exchange.given.k04Seeds) {
      for (const row of seedRows(path.join(CORE_SEEDS_DIR, seed), seen)) {
        const values = isRecord(row.values) ? row.values : {};
        if (row.table === "outbox_rows") {
          rows.set(values.id, {
            step: values.step ?? null,
            lineNo: values.line_no ?? null,
            openQuestionId: values.open_question_id ?? null,
          });
        } else if (row.table === "open_questions") questions.set(values.id, values.step);
      }
    }
  }
  for (const exchange of chain.slice(0, -1)) {
    const writes = exchange.request.writes;
    for (const row of rowsOf(writes, "outboxRows")) {
      rows.set(row.id, {
        step: row.step ?? null,
        lineNo: row.lineNo ?? null,
        openQuestionId: row.openQuestionId ?? null,
      });
    }
    for (const question of rowsOf(isRecord(writes) ? writes.openQuestions : undefined, "open")) {
      questions.set(question.id, question.step);
    }
  }
  return { rows, questions };
}

/** A line as README item 83 answers it: from the row's own pair, else its question's step at 0, else none. */
type Line = { step: unknown; index: unknown; from: "row" | "openQuestion" } | null;

/**
 * The line README item 83 gives the row a read names, from the rows and questions its world holds: the row's own step
 * and line when it stores them (from row), else the step of the question it asks at index 0 (from openQuestion), else
 * none; undefined when its world holds neither the row nor the question it asks.
 */
function worldLineOf(file: string): Line | undefined {
  const world = worldOf(file);
  const row = world.rows.get(valueAt(fixture(file), "request.outboxRowId"));
  if (row === undefined) return undefined;
  if (typeof row.step === "string") return { step: row.step, index: row.lineNo, from: "row" };
  if (row.openQuestionId === null) return null;
  const step = world.questions.get(row.openQuestionId);
  return step === undefined ? undefined : { step, index: 0, from: "openQuestion" };
}

/** Each way a read's line breaks item 83's order against what its world holds, none when it holds. */
export function lineProblems(file: string, outcome: unknown = valueAt(fixture(file), "outcome")): string[] {
  const expected = worldLineOf(file);
  if (expected === undefined) return [`${file}: its row is in no seed or exchange of its chain`];
  const line = valueAt(outcome, "line");
  return isDeepStrictEqual(line, expected)
    ? []
    : [`${file}: line is ${JSON.stringify(line)}, not ${JSON.stringify(expected)} (item 83)`];
}

/** Every accepted readOutboxRow exchange whose answer is a row and whose world holds the row: item 83 is read on each. */
const readsOfChainRows = entries.filter(
  (entry) =>
    entry.expect === "accept" &&
    entry.def === READ_DEF &&
    lookUp(fixture(entry.file), "outcome.result").value === "outboxRow" &&
    worldLineOf(entry.file) !== undefined,
);

describe("data-access v1.22: what the schema leaves to the fixtures, each check also shown firing", () => {
  it("answers each read's line as item 83 orders it, the row's own pair, else its question's step, else none, against what its world holds, at every version", () => {
    expect(readsOfChainRows.map((entry) => entry.file)).toEqual(
      expect.arrayContaining([READ_S1_08, OLDER_ROW, NO_QUESTION]),
    );
    for (const entry of readsOfChainRows) expect(lineProblems(entry.file), entry.file).toEqual([]);
    const froms = readsOfChainRows.map((entry) => {
      const line = valueAt(fixture(entry.file), "outcome.line");
      return isRecord(line) ? String(line.from) : "none";
    });
    for (const from of ["row", "openQuestion", "none"]) expect(froms, from).toContain(from);
  });

  it("reads the older row as v1.6's read-outbox-row-s1-02-no-kinds but for the moment, from its question, nothing backfilled (default 212)", () => {
    expect(entryOf(NO_KINDS).version).toBe("v1.6");
    expect(FIXTURES_PARAGRAPH).toContain(
      `every field as v1.6's \`${nameOf(NO_KINDS)}\` answers it but the moment`,
    );
    const older = valueAt(fixture(OLDER_ROW), "outcome") as Row;
    const noKinds = valueAt(fixture(NO_KINDS), "outcome") as Row;
    expect(older.readAt).not.toBe(noKinds.readAt);
    expect({ ...older, readAt: null }).toEqual({ ...noKinds, readAt: null });
  });

  it("names the commit's rows in the answer in commit order, after the earlier commit's row, a row's step and line changing nothing in it (item 82)", () => {
    const commit = exchangeOf(COMMIT);
    const rows = rowsOf(commit.request.writes, "outboxRows");
    const answered = rowsOf(valueAt(commit.outcome, "committed"), "outboxRows");
    expect(answered.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    const earlier = chainOf(COMMIT)
      .slice(0, -1)
      .flatMap((step) => rowsOf(step.request.writes, "outboxRows")).length;
    expect(answered.map((row) => row.commitSeq)).toEqual(rows.map((_, place) => earlier + place + 1));
    for (const row of rows) expect(Object.keys(row)).toEqual(expect.arrayContaining(["step", "lineNo"]));
  });

  it("has the line check fire on a damaged copy: another index, a row's line read from its question, the older row read from the row, a row its world does not hold", () => {
    const s108 = valueAt(fixture(READ_S1_08), "outcome");
    const wrongIndex = withChange(s108, "line.index", 1);
    expect(lineProblems(READ_S1_08, wrongIndex)).toEqual([
      `${READ_S1_08}: line is {"step":"S1-08","index":1,"from":"row"}, not {"step":"S1-08","index":0,"from":"row"} (item 83)`,
    ]);
    const fromQuestion = withChange(s108, "line.from", "openQuestion");
    expect(lineProblems(READ_S1_08, fromQuestion)).toHaveLength(1);
    const older = withChange(valueAt(fixture(OLDER_ROW), "outcome"), "line.from", "row");
    expect(lineProblems(OLDER_ROW, older)).toEqual([
      `${OLDER_ROW}: line is {"step":"S1-02","index":0,"from":"row"}, not {"step":"S1-02","index":0,"from":"openQuestion"} (item 83)`,
    ]);
    const noLine = withChange(valueAt(fixture(NO_QUESTION), "outcome"), "line", {
      step: "S1-02",
      index: 0,
      from: "openQuestion",
    });
    expect(lineProblems(NO_QUESTION, noLine)).toHaveLength(1);
    const practice = "read-outbox-row-practice-sensitive.json";
    expect(lineProblems(practice)).toEqual([`${practice}: its row is in no seed or exchange of its chain`]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 6. Its sides (README "Consumers of v1.22"; QA's task: "with its sides (C-152, C-087, C-074)")

interface Side {
  /** The component, as the README names it. */
  component: string;
  /** Its owner, as the consumers list's bullet names it, in bold. */
  owner: string;
  /** The tasks the bullet names beside the component. */
  tasks: string[];
}

/** v1.22's sides: the producer's database side, the turn face's rows and the walk (README "Consumers of v1.22"). */
const SIDES: readonly Side[] = [
  { component: "C-152", owner: "Database engineer", tasks: ["T-1476"] },
  { component: "C-074", owner: "Action-layer engineer", tasks: ["T-1475"] },
  { component: "C-087", owner: "Action-layer engineer", tasks: ["T-1479"] },
];

/** This task's database side of v1.22: the producer's (C-152), each v1.22 exchange through db/repo's calls. */
const DB_SIDE = path.join(REPO_ROOT, "tests", "contract", `data-access.${VERSION}.db-side.test.ts`);

describe("data-access v1.22: its sides, as README 'Consumers of v1.22' and QA's task name them", () => {
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
    const side = readFileSync(DB_SIDE, "utf8");
    for (const call of ["commitTurn", "readOutboxRow"]) expect(side, call).toContain(call);
  });
});
