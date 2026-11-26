// Contract test for K-05 v1.23, a final refusal is parked at once with the passedOn line and Rosie's team's record: the
// schema side (T-1550, T-1529's ruling card 3; T-1531's freeze; DL-1142, DL-1144, DL-1195; contracts/data-access/README.md
// section "v1.23", item 84, "Consumers of v1.23", "What the new tasks must hold to" (QA's task), defaults 216 to 224 and
// "Fixtures", v1.23).
//
// data-access.v1.test.ts checks every fixture of every version against the schema of its version (its parts 1, 3 and
// 4); data-access.v1.23.db-side.test.ts is v1.23's database side, each v1.23 exchange through db/repo's parkTurn (T-1542).
// This file proves the rest, reading only the committed schemas, fixtures and README:
//   1. v1.23 holds every v1.22 definition under its own name, restates the two and adds the six the README's change log
//      names and no other, names the same calls at its root as v1.22, and is frozen (frozen.json, the README's status
//      line and freeze record).
//   2. v1.23's fixtures, selected by their version, never by a pinned list or count (DL-124, DL-125): each against
//      data-access.v1.23.schema.json at parkTurn.lineExchange, accepted or refused as the index marks it and as README
//      "Fixtures" (v1.23) counts and names them; each accepted one at the same definition of every later version; every
//      accepted fixture of v1 to v1.22 at the same definition of v1.23, v1's park-turn among them; and what v1.23 adds,
//      refused by v1.22 (a reason, a row with its plan and final parts).
//   3. each refused fixture for its one fault, mended into its twin (README "Fixtures", v1.23: "put right, it is
//      park-turn-sam-refused-at-once"; "Each refused fixture differs from park-turn-sam-refused-at-once in that one field
//      and its note alone"): refused as it stands, by errors that name its fault; differing from its twin only at the
//      fault and its note; and with the fault and the note taken from the twin, accepted, and the twin itself. The proof
//      is shown firing on damaged twins.
//   4. what no fixture shows (README "What the new tasks must hold to", QA's task): a reason at tries 3 accepted; a park
//      on try 2 without one refused; a from, fault or id that reads as a number refused; a second row, no row, or a row
//      without its plan or final parts refused; a row with versions read, a booking, a question, a copy or another send
//      class refused; the words with straight apostrophes refused; another fixed line beside passedOn refused; and v1's
//      park-turn accepted by v1.23's parkTurn.exchange and refused by parkTurn.lineExchange. Each is one change from an
//      accepted fixture, refused by errors that name the place changed.
//   5. what the schema leaves to the producer and the fixtures (README item 84 and "The schema holds the form": "That the
//      plan's row is the row, that the recipient is the turn's handle, that error_summary follows default 220 ... are the
//      producer's to keep"), read from every accepted v1.23 fixture and shown firing on damaged copies: the row's and the
//      entry's ids by the runtime's rule, the plan's and the final parts' row and channel the row's, the recipient the
//      turn's handle (default 219), one turn.parked entry with the reason's labels or v1's outage path (default 222), the
//      answer the first park's (default 223); the line K-01's passedOn word for word (default 216); and default 220's
//      summary, built from the labels, as the README writes it for park-turn-sam-refused-at-once.
//   6. its sides (README "QA's task": "adds v1.23 with its sides (C-152, C-180)"): each side the README's consumers list
//      names, its owner and its card, and the producer's side this task gives.

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
const VERSION = "v1.23";
const BEFORE = "v1.22";
/** The definition README "Fixtures" (v1.23) lists the v1.23 fixtures under, and the one it narrows. */
const LINE_DEF = "parkTurn.lineExchange";
const PARK_DEF = "parkTurn.exchange";

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

/** A version's major and minor number: v1.23 is [1, 23]. */
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
/** v1.23's entries, selected by their version (DL-124, DL-125). */
const ofVersion = entries.filter((entry) => entry.version === VERSION);
const accepted = ofVersion.filter((entry) => entry.expect === "accept");
const refused = ofVersion.filter((entry) => entry.expect === "refuse");
/** Every accepted fixture of a version before v1.23. */
const earlierAccepted = entries.filter(
  (entry) => isBefore(entry.version, VERSION) && entry.expect === "accept",
);
/** Every version the index lists after v1.23, in order: each holds v1.23's accepted fixtures too. */
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
for (const def of [LINE_DEF, PARK_DEF, "parkReason"]) {
  validatorOf(VERSION, def);
  errorPlaces(VERSION, def, null);
}
errorPlaces(BEFORE, PARK_DEF, null);
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

/** README section "v1.23" (T-1531), through "Consumers of v1.23" and "What the new tasks must hold to". */
const SECTION = sectionStarting(`## ${VERSION} (`);
/** README "Change log": v1.23's row, which names what it restates and adds. */
const CHANGE_LOG = lineStarting(`- ${VERSION}, 2026-11-22 (T-1531`, "v1.23's change log row");
/** README "Fixtures": the paragraph of v1.23's fixtures, which counts them and names the refused ones' twin. */
const FIXTURES_PARAGRAPH = lineStarting(
  `**${VERSION}** (listed with`,
  "the README's v1.23 fixtures paragraph",
);
/** README "Consumers of v1.23": its list, through "What the new tasks must hold to". */
const CONSUMERS = sectionStarting(`### Consumers of ${VERSION}`);
/** README "What the new tasks must hold to": QA's task, which names this file's sides and what no fixture shows. */
const QA_TASK = must(
  CONSUMERS.split("\n").find((line) => line.startsWith("- **QA's task**")),
  "the README's QA's task line of v1.23",
);
/** README "Defaults used (T-1531, v1.23)": defaults 216 to 224. */
const DEFAULTS = sectionStarting("## Defaults used (T-1531, v1.23)");
/** One default of DEFAULTS, by its number. */
const defaultOf = (n: number): string =>
  must(
    DEFAULTS.split("\n").find((line) => line.startsWith(`${String(n)}. `)),
    `README default ${String(n)}`,
  );

// ---------------------------------------------------------------------------------------------------------------
// 1. v1.23 holds every v1.22 definition, restates two and adds six, and is frozen

describe("data-access v1.23: every v1.22 definition held, two restated and six added, as the README names them, and frozen", () => {
  const defs = defsOf(VERSION);
  const before = defsOf(BEFORE);
  const restated = Object.keys(before).filter((name) => !refersOn(defs[name], BEFORE, name));
  const added = Object.keys(defs).filter((name) => !Object.hasOwn(before, name));

  it("holds every v1.22 definition under its own name, each but the restated ones by reference to v1.22's alone", () => {
    expect(Object.keys(before).length).toBeGreaterThan(100);
    expect(Object.keys(before).filter((name) => !Object.hasOwn(defs, name))).toEqual([]);
    for (const name of Object.keys(before)) validatorOf(VERSION, name);
  });

  it("restates the two and adds the six the change log names, and no other (README 'Change log', v1.23)", () => {
    const restatedNamed = namesIn(between(CHANGE_LOG, /Restated: /, / New definitions?: /));
    const addedNamed = namesIn(between(CHANGE_LOG, /New definitions?: /, / accepted and /));
    expect(restated.sort()).toEqual([...restatedNamed].sort());
    expect(added.sort()).toEqual([...addedNamed].sort());
    expect(restated.sort()).toEqual(["parkTurn.exchange", "parkTurn.request"]);
    expect(added.sort()).toEqual([
      "parkReason",
      "parkTurn.lineExchange",
      "parkTurn.lineRequest",
      "parkedLineParts",
      "parkedLinePlan",
      "parkedRowNew",
    ]);
    // The section's Kind names each as well.
    for (const name of [...restated, ...added]) expect(SECTION, name).toContain(`\`${name}\``);
  });

  it("names at its root the calls v1.22 names, no call added (README section 'v1.23': 'Every other call is unchanged')", () => {
    expect(exchangesOf(VERSION)).toEqual(exchangesOf(BEFORE));
    expect(exchangesOf(VERSION)).toContain(PARK_DEF);
    expect(exchangesOf(VERSION)).not.toContain(LINE_DEF);
  });

  it("is frozen: frozen.json lists it, and the README's status line and freeze record name it", () => {
    const frozen = (readJson(path.join(DATA_ACCESS_DIR, "frozen.json")) as { frozen: string[] }).frozen;
    expect(frozen).toContain(VERSION);
    expect(frozen).toContain(BEFORE);
    expect(lineStarting("**Status:", "the README's status line")).toContain(`"${VERSION}"`);
    expect(lineStarting(`Frozen ${VERSION}, `, "v1.23's freeze record")).toContain("reviews required: QA");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. v1.23's fixtures at v1.23 and every later version; every earlier accepted fixture at v1.23

const AT_ONCE = "park-turn-sam-refused-at-once.json";
const REPEAT = "park-turn-sam-refused-repeat.json";
const MAYA = "park-turn-maya-crash-with-line.json";
/** v1's park (item 12), the one v1.23 restates around. */
const V1_PARK = "park-turn.json";

describe("data-access v1.23: each fixture, selected by its version, at v1.23 and every later version", () => {
  it("selects accepted and refused v1.23 fixtures, each under parkTurn.lineExchange, as README 'Fixtures' counts and names them", () => {
    expect(accepted.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
    for (const entry of ofVersion) {
      expect(entry.def, entry.file).toBe(LINE_DEF);
      expect((fixture(entry.file) as { call?: unknown }).call, entry.file).toBe("parkTurn");
    }
    expect(FIXTURES_PARAGRAPH).toContain(`listed with \`"version": "${VERSION}"\` under \`${LINE_DEF}\``);
    expect(FIXTURES_PARAGRAPH).toContain(`Accepted (${String(accepted.length)})`);
    expect(FIXTURES_PARAGRAPH).toContain(
      `Refused (${String(refused.length)}, in \`fixtures/invalid/\`, by \`${LINE_DEF}\``,
    );
    for (const entry of ofVersion)
      expect(FIXTURES_PARAGRAPH, entry.file).toContain(`\`${nameOf(entry.file)}\``);
    for (const entry of refused) expect(entry.file.startsWith("invalid/"), entry.file).toBe(true);
    expect(accepted.map((entry) => entry.file)).toEqual(expect.arrayContaining([AT_ONCE, REPEAT, MAYA]));
  });

  for (const entry of ofVersion) {
    it(`${entry.expect === "accept" ? "accepts" : "refuses"} ${entry.file} at ${VERSION} (${entry.def ?? "root"})`, () => {
      const validate = validatorOf(VERSION, must(entry.def));
      const valid = validate(fixture(entry.file));
      expect(valid, formatErrors(validate.errors).join("; ")).toBe(entry.expect === "accept");
    });
  }

  it("accepts each accepted v1.23 fixture at the same definition of every later version (a minor version only adds)", () => {
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

  it("accepts every accepted fixture of v1 to v1.22 at the same definition of v1.23, v1's park-turn under parkTurn.exchange among them", () => {
    expect(earlierAccepted.length).toBeGreaterThan(0);
    for (const entry of earlierAccepted) {
      const validate = validatorOf(VERSION, must(entry.def));
      expect(
        validate(fixture(entry.file)),
        `${entry.file} (${entry.version}) under ${VERSION}: ${formatErrors(validate.errors).join("; ")}`,
      ).toBe(true);
    }
    expect(entryOf(V1_PARK)).toMatchObject({ version: "v1", def: PARK_DEF, expect: "accept" });
    expect(earlierAccepted.map((entry) => entry.file)).toContain(V1_PARK);
  });

  it("is what takes a park with a reason and a worded row: v1.22's parkTurn.exchange refuses each accepted v1.23 fixture, naming the row's plan or the reason", () => {
    for (const entry of accepted) {
      expect(passes(BEFORE, PARK_DEF, fixture(entry.file)), entry.file).toBe(false);
      expect(errorPlaces(BEFORE, PARK_DEF, fixture(entry.file)), entry.file).toEqual(
        expect.arrayContaining(["request.outboxRows.0.plan", "request.outboxRows.0.finalParts"]),
      );
    }
    expect(errorPlaces(BEFORE, PARK_DEF, fixture(AT_ONCE))).toContain("request.reason");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Each refused fixture for its one fault, mended into its twin

interface Twin {
  /** The accepted v1.23 exchange the README names as the refused fixture's twin. */
  twin: string;
  /** The places in the refused fixture that carry its one fault, as its index entry and the README state them. */
  faults: string[];
}

/** The refused v1.23 fixtures' twin and faults, as README "Fixtures" (v1.23) and their index entries state them. */
const TWINS: Readonly<Record<string, Twin>> = {
  "invalid/refuse-park-turn-sam-refused-no-reason.json": { twin: AT_ONCE, faults: ["request.reason"] },
  "invalid/refuse-park-turn-sam-refused-line-reworded.json": {
    twin: AT_ONCE,
    faults: ["request.outboxRows.0.finalParts.sends.0.text"],
  },
  "invalid/refuse-park-turn-sam-refused-reason-words.json": {
    twin: AT_ONCE,
    faults: ["request.reason.fault"],
  },
};

/** The one place beside its fault a refused fixture differs from its twin (README "Fixtures", v1.23: "its note"). */
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
/**
 * Whether an error's place names `at`: the field at `at`, inside it, or a list or object that holds it, never the
 * whole exchange or its whole request (an anyOf over the two request forms answers there whatever is wrong).
 */
const names = (place: string, at: string): boolean =>
  within(place, at) || (!["", "request"].includes(place) && within(at, place));

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
  if (!named.some((place) => twin.faults.some((fault) => names(place, fault)))) {
    const listed = named.length === 0 ? "" : `: ${named.join("; ")}`;
    problems.push(`the schema's errors name none of ${twin.faults.join(", ")}${listed}`);
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

describe("data-access v1.23: each refused fixture for its one fault, mended from its twin into its twin", () => {
  it("has a twin for every refused v1.23 fixture and for no other file: an accepted v1.23 exchange, as its index entry and the README name it, with its fault", () => {
    expect(Object.keys(TWINS).sort()).toEqual(refused.map((entry) => entry.file).sort());
    expect(FIXTURES_PARAGRAPH).toContain(`each for one reason: put right, it is \`${nameOf(AT_ONCE)}\``);
    for (const entry of refused) {
      const twin = must(TWINS[entry.file], `${entry.file}'s twin`);
      const twinEntry = entryOf(twin.twin);
      expect([twinEntry.version, twinEntry.expect, twinEntry.def], `${entry.file}'s twin`).toEqual([
        VERSION,
        "accept",
        entry.def,
      ]);
      for (const fault of twin.faults) {
        expect(entry.shows, `${entry.file}: its index entry names its fault`).toContain(showsFault(fault));
        expect(FIXTURES_PARAGRAPH, `${entry.file}: the README names its fault`).toContain(
          `\`${nameOf(entry.file)}\``,
        );
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
    const noReason = entryOf("invalid/refuse-park-turn-sam-refused-no-reason.json");
    const own = must(TWINS[noReason.file]);
    expect(twinProblems(noReason, own)).toEqual([]);
    const elsewhere = twinProblems(noReason, { ...own, faults: ["request.parkedAt"] });
    expect(elsewhere).toContain(`it differs from ${AT_ONCE} at request.reason, which is not the fault`);
    expect(elsewhere).toContain(`the fault request.parkedAt is not where it differs from ${AT_ONCE}`);
    expect(elsewhere).toContain(`mended from ${AT_ONCE}, it is still refused`);
    const reworded = entryOf("invalid/refuse-park-turn-sam-refused-line-reworded.json");
    const another = twinProblems(reworded, { ...must(TWINS[reworded.file]), twin: MAYA });
    expect(another).toContain(`it differs from ${MAYA} at request.turn.id, which is not the fault`);
    expect(another).toContain(`mended, it is not ${MAYA}`);
    expect(twinProblems(noReason, own, fixture(AT_ONCE))).toEqual([
      `${noReason.file} is accepted as it stands`,
      `the schema's errors name none of ${own.faults.join(", ")}`,
      `the fault ${own.faults.join(", ")} is not where it differs from ${AT_ONCE}`,
    ]);
    expect(noReason.shows).not.toContain(showsFault("request.parkedAt"));
    expect(reworded.shows).not.toContain(showsTwin(MAYA));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. What no fixture shows (README "What the new tasks must hold to", QA's task)

const ROW_0 = "request.outboxRows.0";
/** A number in the 555-01xx range, as K-04's seeds write Sam's, without its plus sign: it reads as a number. */
const A_NUMBER = "5555550100";

interface Unshown {
  /** What README QA's task says this case shows. */
  readme: string;
  /** The accepted fixture the case is built from, by one change. */
  from: string;
  /** The one change: the place, and its new value. */
  at: string;
  to: unknown;
  /** The place the schema's errors name for it, when that is not the place changed (a required field it leaves out). */
  named?: string;
}

const lineText = (): string => valueAt(fixture(AT_ONCE), `${ROW_0}.finalParts.sends.0.text`) as string;

/** Each refusal README QA's task names that no v1.23 fixture shows, each one change from an accepted fixture. */
const UNSHOWN: readonly Unshown[] = [
  {
    readme: "a park on try 2 without one refused",
    from: MAYA,
    at: "request.turn.tries",
    to: 2,
    named: "request.reason",
  },
  {
    readme: "a `from`, `fault` or id that reads as a number refused",
    from: AT_ONCE,
    at: "request.reason.from",
    to: A_NUMBER,
  },
  {
    readme: "a `from`, `fault` or id that reads as a number refused",
    from: AT_ONCE,
    at: "request.reason.fault",
    to: A_NUMBER,
  },
  {
    readme: "a `from`, `fault` or id that reads as a number refused",
    from: AT_ONCE,
    at: "request.reason.ids.0",
    to: A_NUMBER,
  },
  {
    readme: "a second row, no row, or a row without its plan or final parts refused",
    from: AT_ONCE,
    at: "request.outboxRows.1",
    to: { ...(valueAt(fixture(AT_ONCE), ROW_0) as object), id: "out-turn-sam-refused-1-parked-2" },
  },
  {
    readme: "a second row, no row, or a row without its plan or final parts refused",
    from: AT_ONCE,
    at: "request.outboxRows",
    to: [],
  },
  {
    readme: "a second row, no row, or a row without its plan or final parts refused",
    from: AT_ONCE,
    at: `${ROW_0}.plan`,
    to: REMOVE,
  },
  {
    readme: "a second row, no row, or a row without its plan or final parts refused",
    from: MAYA,
    at: `${ROW_0}.finalParts`,
    to: REMOVE,
  },
  {
    readme: "a row with versions read, a booking, a question, a copy or another send class refused",
    from: AT_ONCE,
    at: `${ROW_0}.versionsRead`,
    to: [{ table: "phones", rowId: "+15555550100", version: 1 }],
  },
  {
    readme: "a row with versions read, a booking, a question, a copy or another send class refused",
    from: AT_ONCE,
    at: `${ROW_0}.bookingId`,
    to: "booking-alex-haircut",
  },
  {
    readme: "a row with versions read, a booking, a question, a copy or another send class refused",
    from: AT_ONCE,
    at: `${ROW_0}.openQuestionId`,
    to: "oq-s1-02-sam-1",
  },
  {
    readme: "a row with versions read, a booking, a question, a copy or another send class refused",
    from: AT_ONCE,
    at: `${ROW_0}.copyOfRowId`,
    to: "outbox-s1-02-sam-1",
  },
  {
    readme: "a row with versions read, a booking, a question, a copy or another send class refused",
    from: MAYA,
    at: `${ROW_0}.sendClass`,
    to: "routine",
  },
  {
    readme: "the words with straight apostrophes refused",
    from: AT_ONCE,
    at: `${ROW_0}.finalParts.sends.0.text`,
    to: lineText().replaceAll("’", "'"),
  },
  {
    readme: "another fixed line beside passedOn refused",
    from: AT_ONCE,
    at: `${ROW_0}.finalParts.fixedLines`,
    to: ["passedOn", "opener"],
  },
];

/** The two definitions of v1.23 a v1.23 park is checked by: the narrowing, and the exchange it narrows. */
const PARK_DEFS = [LINE_DEF, PARK_DEF];

/** Each way a case fails to show its refusal, none when it does: its fixture accepted, the change refused, named. */
export function unshownProblems(unshown: Unshown): string[] {
  const problems: string[] = [];
  const changed = withChange(fixture(unshown.from), unshown.at, unshown.to);
  const place = unshown.named ?? unshown.at;
  for (const def of PARK_DEFS) {
    if (!passes(VERSION, def, fixture(unshown.from))) problems.push(`${unshown.from} is refused by ${def}`);
    if (passes(VERSION, def, changed)) problems.push(`${unshown.at} changed is accepted by ${def}`);
    else if (!errorPlaces(VERSION, def, changed).some((error) => names(error, place))) {
      problems.push(`${def}'s errors name no place near ${place}`);
    }
  }
  return problems;
}

const describeTo = (to: unknown): string => (to === REMOVE ? "taken out" : `set to ${JSON.stringify(to)}`);

describe("data-access v1.23: what no fixture shows, each one change from an accepted fixture, refused where the change is", () => {
  it("names in README QA's task each case this file shows", () => {
    for (const unshown of UNSHOWN) expect(QA_TASK, unshown.readme).toContain(unshown.readme);
    expect(QA_TASK).toContain("a reason at tries 3 accepted");
    expect(QA_TASK).toContain(
      "v1's `park-turn` accepted by v1.23's `parkTurn.exchange` and refused by `parkTurn.lineExchange`",
    );
  });

  for (const unshown of UNSHOWN) {
    it(`${unshown.readme}: ${unshown.from} with ${unshown.at} ${describeTo(unshown.to)}`, () => {
      expect(unshownProblems(unshown)).toEqual([]);
    });
  }

  it("accepts a reason at tries 3 (default 218: on the third try a final refusal names its reason, a crash none)", () => {
    const third = withChange(fixture(AT_ONCE), "request.turn.tries", 3);
    expect(passes(VERSION, LINE_DEF, third)).toBe(true);
    expect(passes(VERSION, PARK_DEF, third)).toBe(true);
    // A crash parks only on the third try: Maya's park, which names none, is v1.23's on try 3 alone.
    expect(valueAt(fixture(MAYA), "request.turn.tries")).toBe(3);
    expect(lookUp(fixture(MAYA), "request.reason").found).toBe(false);
    expect(defaultOf(218)).toContain("so tries 1 and 2 require the reason");
  });

  it("accepts v1's park-turn at v1.23's parkTurn.exchange and refuses it at parkTurn.lineExchange, naming its unworded row", () => {
    expect(passes(VERSION, PARK_DEF, fixture(V1_PARK))).toBe(true);
    expect(passes(VERSION, LINE_DEF, fixture(V1_PARK))).toBe(false);
    expect(errorPlaces(VERSION, LINE_DEF, fixture(V1_PARK))).toEqual(
      expect.arrayContaining([`${ROW_0}.plan`, `${ROW_0}.finalParts`]),
    );
  });

  it("has the case check fire: a change the schema takes, and a fixture the definitions refuse as it stands", () => {
    const taken: Unshown = { ...must(UNSHOWN[1]), to: "toolApi" };
    expect(unshownProblems(taken)).toEqual([
      "request.reason.from changed is accepted by parkTurn.lineExchange",
      "request.reason.from changed is accepted by parkTurn.exchange",
    ]);
    const sendClass = must(UNSHOWN.find((unshown) => unshown.at === `${ROW_0}.sendClass`));
    const unworded: Unshown = { ...sendClass, from: V1_PARK };
    expect(unshownProblems(unworded)).toContain(`${V1_PARK} is refused by ${LINE_DEF}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. What the schema leaves to the producer, read from the fixtures

type Row = Record<string, unknown>;

interface Reason {
  from: string;
  fault: string;
  ids: string[];
}

interface Park {
  call: string;
  given: { k04Seeds: string[]; after: string[]; now: string; note: string };
  request: {
    turn: { id: string; handleId: string; tries: number } & Row;
    parkedAt: string;
    reason?: Reason;
    outboxRows: (Row & { plan: Row; finalParts: Row & { sends: Row[] } })[];
    events: Row[];
  };
  outcome: Row;
}
const parkOf = (file: string): Park => fixture(file) as Park;

/** v1's outage path, the entry's why for a crash (K-05 v1 park-turn.json; default 222). */
const OUTAGE = { outage: "third crash before the commit" };

/**
 * Each way a first park breaks what the README leaves to the producer, none when it holds: the row's and the entry's
 * ids by the runtime's rule (README "Fixtures", v1.23); the plan's and the final parts' row and channel the row's, its
 * recipient the turn's handle (default 219); one turn.parked entry on the turn, by Rosie, nothing sealed, its new
 * values the state and the tries, its why the reason's labels under refused or v1's outage path (default 222); and the
 * answer v1's parked with the row, not repeated, at parkedAt (item 84).
 */
export function parkProblems(park: Park): string[] {
  const problems: string[] = [];
  const { turn, outboxRows, events, reason } = park.request;
  const row = must(outboxRows[0], "the park's row");
  if (row.id !== `out-${turn.id}-parked`)
    problems.push(`the row is ${String(row.id)}, not out-<turn id>-parked`);
  for (const [part, said] of [
    ["plan", "the plan's"],
    ["finalParts", "the final parts'"],
  ] as const) {
    if (row[part].row !== row.id) problems.push(`${said} row is ${String(row[part].row)}, not the row's`);
    if (row[part].channel !== row.channel) problems.push(`${said} channel is not the row's`);
  }
  if (row.recipientHandleId !== turn.handleId)
    problems.push("the row goes to another handle than the turn's");
  const expectedEntry = {
    id: `log-${turn.id}-parked`,
    kind: "turn.parked",
    zone: null,
    actorKind: "rosie",
    actorPersonId: null,
    actorRole: null,
    tableName: "turns",
    rowId: turn.id,
    oldValues: null,
    newValues: { state: "parked", tries: turn.tries },
    sealed: null,
    why: reason === undefined ? OUTAGE : { refused: reason },
    approvedBy: null,
    proofs: null,
  };
  if (events.length !== 1) problems.push(`the park writes ${String(events.length)} entries, not one`);
  else {
    // The entry's business is the row's, as v1's park-turn writes it; the schema and item 12 hold it, not default 222.
    const entry = { ...must(events[0]) };
    Reflect.deleteProperty(entry, "businessId");
    if (!isDeepStrictEqual(entry, expectedEntry)) {
      problems.push(`the entry is not default 222's: ${differences(entry, expectedEntry).join(", ")}`);
    }
  }
  const outcome = park.outcome;
  if (
    outcome.result !== "parked" ||
    outcome.turnId !== turn.id ||
    outcome.parkedAt !== park.request.parkedAt ||
    outcome.repeated !== false
  ) {
    problems.push("the answer is not this park's, first and at its parkedAt");
  }
  const answered = Array.isArray(outcome.outboxRows) ? (outcome.outboxRows as Row[]) : [];
  if (
    !isDeepStrictEqual(
      answered.map((written) => written.id),
      [row.id],
    )
  ) {
    problems.push("the answer does not name the row alone");
  }
  return problems;
}

/** The first parks among v1.23's accepted fixtures: those whose chain runs nothing first. */
const firstParks = accepted.filter((entry) => parkOf(entry.file).given.after.length === 0);

/**
 * Default 220's summary of Rosie's team's record, as the README writes its form: for a refusal `Refused as final
 * (<from>: <fault>) on try <tries> of 3; nothing was committed`, with `; ` and the ids joined by `, ` after the fault
 * when there are ids; for a crash db/repo's fixed text.
 */
function summaryOf(reason: Reason | undefined, tries: number): string {
  if (reason === undefined)
    return "Crashed three times before the commit (try 3 of 3); nothing was committed";
  const ids = reason.ids.length === 0 ? "" : `; ${reason.ids.join(", ")}`;
  return `Refused as final (${reason.from}: ${reason.fault}${ids}) on try ${String(tries)} of 3; nothing was committed`;
}

/** The passedOn line as a K-01 source holds it: an entry { id: "passedOn", text } in a list, or a map's value. */
function passedOnIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(passedOnIn);
  if (!isRecord(value)) return [];
  const own =
    value.id === "passedOn" && typeof value.text === "string"
      ? [value.text]
      : typeof value.passedOn === "string"
        ? [value.passedOn]
        : isRecord(value.passedOn) && typeof value.passedOn.text === "string"
          ? [value.passedOn.text]
          : [];
  return [...own, ...Object.values(value).flatMap(passedOnIn)];
}

describe("data-access v1.23: what the schema leaves to the producer, read from the fixtures, each check also shown firing", () => {
  it("states each first park's row, entry and answer as item 84 and defaults 219 and 222 leave them to the producer", () => {
    expect(firstParks.map((entry) => entry.file).sort()).toEqual([AT_ONCE, MAYA].sort());
    for (const entry of firstParks) expect(parkProblems(parkOf(entry.file)), entry.file).toEqual([]);
    // A refusal names its reason in the entry; a crash keeps v1's outage path, as v1's park-turn writes it.
    expect(must(parkOf(MAYA).request.events[0]).why).toEqual(must(parkOf(V1_PARK).request.events[0]).why);
    expect(FIXTURES_PARAGRAPH).toContain("`out-<turn id>-parked`, `log-<turn id>-parked`");
  });

  it("answers the repeat as the first park, repeated, whatever its body (default 223): the same request two seconds later, after the first", () => {
    const repeat = parkOf(REPEAT);
    const first = parkOf(AT_ONCE);
    expect(repeat.given.after).toEqual([AT_ONCE]);
    expect(differences(repeat.request, first.request)).toEqual(["parkedAt"]);
    expect(Date.parse(repeat.request.parkedAt) - Date.parse(first.request.parkedAt)).toBe(2000);
    expect(repeat.outcome).toEqual({ ...first.outcome, repeated: true });
    expect(defaultOf(223)).toContain("A turn id already parked answers its first park and writes nothing");
  });

  it("carries K-01's passedOn line word for word, its two apostrophes the typographic one, as K-01's fixed lines and bundles/v2 hold it (default 216)", () => {
    const words = lineText();
    expect(words.match(/’/g)).toHaveLength(2);
    expect(words).not.toContain("'");
    expect(passedOnIn(readJson(path.join(CONTRACTS_ROOT, "bundle", "fixtures", "fixed-lines.json")))).toEqual(
      [words],
    );
    const manifest = passedOnIn(readJson(path.join(REPO_ROOT, "bundles", "v2", "bundle", "manifest.json")));
    expect(manifest.length).toBeGreaterThan(0);
    for (const text of manifest) expect(text).toBe(words);
    expect(defaultOf(216)).toContain(`"${words}"`);
    for (const entry of accepted) {
      expect(valueAt(fixture(entry.file), `${ROW_0}.finalParts.sends.0.text`), entry.file).toBe(words);
    }
  });

  it("builds default 220's summary from the labels and the try, as the README writes it for park-turn-sam-refused-at-once and for a crash", () => {
    const atOnce = parkOf(AT_ONCE).request;
    const refusal = summaryOf(atOnce.reason, atOnce.turn.tries);
    expect(refusal).toBe(
      "Refused as final (walk: stepNotInBundle; S1-04) on try 1 of 3; nothing was committed",
    );
    expect(defaultOf(220)).toContain(`\`${refusal}\``);
    expect(FIXTURES_PARAGRAPH).toContain(`\`${refusal}\``);
    const crash = summaryOf(parkOf(MAYA).request.reason, parkOf(MAYA).request.turn.tries);
    expect(defaultOf(220)).toContain(`\`${crash}\``);
    // With no ids, nothing follows the fault (default 220: "with `; ` and the ids ... when there are ids").
    expect(summaryOf({ from: "walk", fault: "notDecided", ids: [] }, 2)).toBe(
      "Refused as final (walk: notDecided) on try 2 of 3; nothing was committed",
    );
    expect(defaultOf(220)).toContain(
      "with `; ` and the ids joined by `, ` after the fault when there are ids",
    );
  });

  it("has the producer's checks fire on damaged copies: another row id, a plan for another row, another handle, words in the why, the tries unstated, a repeat's answer", () => {
    const atOnce = parkOf(AT_ONCE);
    const damaged = (at: string, to: unknown): string[] => parkProblems(withChange(atOnce, at, to) as Park);
    expect(damaged(`${ROW_0}.id`, "out-sam-parked")).toEqual([
      "the row is out-sam-parked, not out-<turn id>-parked",
      "the plan's row is out-turn-sam-refused-1-parked, not the row's",
      "the final parts' row is out-turn-sam-refused-1-parked, not the row's",
      "the answer does not name the row alone",
    ]);
    expect(damaged(`${ROW_0}.plan.row`, "out-turn-maya-0005-parked")).toEqual([
      "the plan's row is out-turn-maya-0005-parked, not the row's",
    ]);
    expect(damaged(`${ROW_0}.finalParts.channel`, "email")).toEqual([
      "the final parts' channel is not the row's",
    ]);
    expect(damaged(`${ROW_0}.recipientHandleId`, "handle-alex")).toEqual([
      "the row goes to another handle than the turn's",
    ]);
    expect(damaged("request.events.0.why", { refused: { from: "walk", fault: "stepNotInBundle" } })).toEqual([
      "the entry is not default 222's: why.refused.ids",
    ]);
    expect(damaged("request.events.0.newValues", { state: "parked" })).toEqual([
      "the entry is not default 222's: newValues.tries",
    ]);
    expect(damaged("request.events.0.why", OUTAGE)).toEqual([
      "the entry is not default 222's: why.outage, why.refused",
    ]);
    expect(damaged("request.events", [])).toEqual(["the park writes 0 entries, not one"]);
    expect(parkProblems(parkOf(REPEAT))).toEqual([
      "the answer is not this park's, first and at its parkedAt",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 6. Its sides (README "Consumers of v1.23"; QA's task: "adds v1.23 with its sides (C-152, C-180)")

interface Side {
  /** The component, as the README names it. */
  component: string;
  /** Its owner, as the consumers list's bullet names it, in bold. */
  owner: string;
  /** The cards the bullet names beside the component. */
  cards: string[];
}

/** v1.23's sides: the producer's database side and the runtime's park (README "Consumers of v1.23"). */
const SIDES: readonly Side[] = [
  { component: "C-152", owner: "Database engineer", cards: ["T-1529's ruling card 4"] },
  { component: "C-180", owner: "Runtime engineer", cards: ["ruling card 6", "card 7"] },
];

/** This task's database side of v1.23: the producer's (C-152), each v1.23 exchange through db/repo's parkTurn. */
const DB_SIDE = path.join(REPO_ROOT, "tests", "contract", `data-access.${VERSION}.db-side.test.ts`);

describe("data-access v1.23: its sides, as README 'Consumers of v1.23' and QA's task name them", () => {
  it("names in QA's task exactly the components of its sides", () => {
    const named = must(/with its sides \(([^)]*)\)/.exec(QA_TASK), "QA's task's sides")[1] ?? "";
    expect(named.split(/, | and /).sort()).toEqual(SIDES.map((side) => side.component).sort());
  });

  it("puts each side's component under its owner in the consumers list, with its cards", () => {
    const bullets = CONSUMERS.split("\n").filter((line) => line.startsWith("- **"));
    for (const side of SIDES) {
      const bullet = must(
        bullets.find((line) => /^- \*\*([^*]+?):?\*\*/.exec(line)?.[1] === side.owner),
        `the consumers bullet of ${side.owner}`,
      );
      expect(bullet, side.component).toContain(`${side.component}, ${must(side.cards[0])}`);
      for (const card of side.cards) expect(bullet, `${side.component}: ${card}`).toContain(card);
    }
  });

  it("gives the producer's side (C-152) as this task's database side, beside this file, as the README's QA line asks", () => {
    expect(CONSUMERS).toContain(
      `its database side in \`tests/contract/data-access.${VERSION}.db-side.test.ts\``,
    );
    expect(existsSync(DB_SIDE)).toBe(true);
    const side = readFileSync(DB_SIDE, "utf8");
    expect(side).toContain("parkTurn");
    expect(side).toContain(LINE_DEF);
  });
});
