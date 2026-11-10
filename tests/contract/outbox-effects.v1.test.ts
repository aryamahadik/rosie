// Contract test for K-07, the outbox rows and effect rows (T-086; ops/plan/02-contracts.md K-07 "Contract test" and
// section 2 item 12; contracts/outbox-effects/README.md "Allowed moves", "The retry rules", "Fixtures" and "Producers
// and consumers (02-contracts K-07)").
//
// This is the fixture part. The contract test has two parts: this one, which reads only the committed schemas, the named
// rule's file, the README and the fixtures, and one part per producer or consumer side, added later by a QA side task
// that depends on this task and on that side's build task. SIDE_CHECKS (at the end) is the list where each side is added.
//
// K-07 is frozen at v1 (T-016; frozen.json). Every entry of fixtures/index.json is checked against the schema its own
// `version` names (outbox-effects.<version>.schema.json, at its root, which is any one record: an outbox row's life, an
// effect row's life or a provider event), and entries are selected by version and by what they state, never by a pinned
// list or count (DL-124, DL-125), so a later minor version's fixtures join every generic check here when they land. The
// mends of part 3 and the moves of part 5 are written for v1, the version frozen when this part was written; a later
// minor version's mends and moves join with its QA task.
//
// What this part proves:
//   1. every fixture in contracts/outbox-effects/fixtures/index.json is checked against the schema its version names
//      (the T-003 harness, and again here): accepted ones are accepted, refused ones are refused (by the schema, or by
//      the named rule after the schema takes them), none is left out, and the number checked is the number of entries;
//      an accepted fixture is accepted by every later minor version too (a minor version only adds);
//   2. the named rule runs, none skipped: lifeChain (outbox-effects.rules.mjs) runs on every entry that names it and on
//      every accepted fixture, and each accepted fixture passes it; it fires on a damaged copy the schema still takes
//      for each check the README gives it ("The retry rules" and "lifeChain also checks"), and its constants are the
//      README's numbers;
//   3. each refusal is tied to its reason (DL-124's mend-then-accept proof): the schema's errors name the field the
//      entry names and no other place, or the rule gives its one named line; put right as the entry says ("The same
//      ... passes"), the copy is accepted by the schema and passes lifeChain, and where an accepted twin exists the copy
//      put right is that twin;
//   4. the schema is not vacuous: removing any one required field, at any depth, from a copy of an accepted fixture
//      makes the copy refused (the required fields are read from the schemas' own `required` lists, along the branch of
//      each anyOf, oneOf and if that the fixture takes), and so does one field the schema does not know; the check is
//      shown firing on a schema that stops requiring a field;
//   5. every state move in the fixtures is allowed and no other (02-contracts K-07 "Contract test"): the README's row,
//      part and effect move tables are exactly the moves the schema accepts, every move of every accepted fixture is in
//      them, every move in them appears in an accepted fixture, and each refused fixture that shows another move is
//      refused.
//   What needs a producer or consumer side is on SIDE_CHECKS, not checked here: the doubles accepting every effect
//   request, a repeated effect with one key running once, the migrations giving the table list, and each producer's
//   and consumer's own lives and readings.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { CONTRACTS_ROOT, checkContractFixtures, formatErrors, type FixtureEntry } from "./_harness";

// ---------------------------------------------------------------------------------------------------------------
// The contract's files

const NAME = "outbox-effects";
const K07_DIR = path.join(CONTRACTS_ROOT, NAME);
const FIXTURES_DIR = path.join(K07_DIR, "fixtures");
/** Every schema's $id is this base plus its path inside contracts/ (ADR-005; contracts/scripts/lib.mjs). */
const ID_BASE = "https://rosie.invalid/contracts/";
/** This file, as the README's "Contract test" line names it (join 8's contract report reads it by this name). */
const THIS_FILE = `tests/contract/${NAME}.v1.test.ts`;
/**
 * The versions this file's version-bound proofs were written for (the record kinds, the mends of part 3, the stated
 * columns of part 4, the moves of part 5); a later minor version's join with its QA task. Every other check runs on
 * every version the index names.
 */
const WRITTEN_FOR = ["v1"];

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

/** An index entry; `rule` names a rule of outbox-effects.rules.mjs (contracts/common/fixtures-index.meta.schema.json). */
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

const parsed = new Map<string, unknown>();
/** A fresh copy of a fixture of this folder. */
function fixture(file: string): unknown {
  let value = parsed.get(file);
  if (value === undefined) {
    value = readJson(path.join(FIXTURES_DIR, ...file.split("/")));
    parsed.set(file, value);
  }
  return structuredClone(value);
}

/** A version's major and minor number: v1 is [1, 0], v1.1 is [1, 1]. */
function placeOf(version: string): [number, number] {
  const match = /^v(\d+)(?:\.(\d+))?$/.exec(version);
  if (match === null) throw new Error(`a version this test cannot place: ${version}`);
  return [Number(match[1]), Number(match[2] ?? "0")];
}

/** The versions of K-07's schema files in contracts/outbox-effects/. */
const SCHEMA_VERSIONS = readdirSync(K07_DIR)
  .map((name) => /^outbox-effects\.(v\d+(?:\.\d+)?)\.schema\.json$/.exec(name)?.[1])
  .filter((version): version is string => version !== undefined);

/** The later minor versions of `version` (BP 6.4: a minor version only adds, so it accepts what `version` accepts). */
function laterMinorVersions(version: string): string[] {
  const [major, minor] = placeOf(version);
  return SCHEMA_VERSIONS.filter((other) => {
    const [otherMajor, otherMinor] = placeOf(other);
    return otherMajor === major && otherMinor > minor;
  });
}

const README = readFileSync(path.join(K07_DIR, "README.md"), "utf8");

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

/** The schema files K-07's own schemas reach by $ref, transitively (contracts-relative), with their schemas. */
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
  for (const name of readdirSync(K07_DIR).sort()) {
    if (name.endsWith(".schema.json")) visit(`${NAME}/${name}`);
  }
  return reached;
}

const SCHEMAS = reachedSchemas();
/** The folders whose schemas K-07's $refs reach (common/, message-plan/): the harness loads them beside K-07's. */
const SHARED_FOLDERS = [...new Set([...SCHEMAS.keys()].map((file) => must(file.split("/")[0])))].filter(
  (folder) => folder !== NAME,
);
/** Each loaded schema by its $id, for the required-field walk (part 4) and the enums (part 5). */
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

const schemaIdOf = (version: string): string => `${ID_BASE}${NAME}/${NAME}.${version}.schema.json`;

/** The validator of a version's schema, at a $defs entry or at its root. */
function validatorOf(version: string, def?: string, ajv = strictAjv): ValidateFunction {
  const key = def === undefined ? schemaIdOf(version) : `${schemaIdOf(version)}#/$defs/${def}`;
  return must(ajv.getSchema(key), `the schema ${key}`);
}
/** Whether the schema an entry's version names (at its def, or its root) accepts a value. */
const accepts = (entry: Entry, value: unknown): boolean => validatorOf(entry.version, entry.def)(value);

/**
 * The root's records (its anyOf): each `record` value and the $defs entry that defines it, read from the schema, so a
 * refused fixture's errors are read against its own record's definition (part 3).
 */
function recordDefsOf(version: string): Map<string, string> {
  const root = must(SCHEMA_BY_ID.get(schemaIdOf(version)), `K-07 ${version}`) as {
    anyOf: { $ref: string }[];
    $defs: Record<string, { properties?: { record?: { const?: string } } } | undefined>;
  };
  return new Map(
    root.anyOf.map((branch) => {
      const def = branch.$ref.replace("#/$defs/", "");
      return [must(root.$defs[def]?.properties?.record?.const, `the record ${def} defines`), def];
    }),
  );
}

// Compile every validator the checks call while the file loads, so no single test carries Ajv's compile time on a
// loaded machine (a resource guard, not part of any check). A schema that cannot be had is left to its entry's test.
for (const entry of entries) {
  try {
    validatorOf(entry.version, entry.def);
    for (const def of recordDefsOf(entry.version).values()) validatorOf(entry.version, def, explainAjv);
    for (const later of laterMinorVersions(entry.version)) validatorOf(later, entry.def);
  } catch {
    // Reported by the entry's own test, which calls validatorOf again.
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The named rule and the records it reads

type Rule = (record: unknown) => string[];
const rulesModule = (await import(pathToFileURL(path.join(K07_DIR, `${NAME}.rules.mjs`)).href)) as {
  rules: Record<string, Rule>;
  lifeChain: Rule;
  RECEIPT_WAIT_MS: number;
  SECOND_SEND_WAIT_MS: number;
  SAFETY_RETRY_MS: number;
  GIVE_UP_AFTER_MS: number;
  EFFECT_TRIES: number;
  EFFECT_WINDOW_MS: number;
};
const { rules, lifeChain } = rulesModule;
const rule = (name: string): Rule => must(rules[name], `the rule ${name}`);

// What the checks read. The fixtures are checked against the schema first (part 1), so a cast to these shapes reads
// only fields the schema gives them.
interface RowMove {
  subject: "row";
  from: string | null;
  to: string;
  at: string;
  by: string;
  note: string;
}
interface PartMove {
  subject: "part";
  key: string;
  from: string | null;
  to: string;
  at: string;
  by: string;
  errorCode: string | null;
  note: string;
}
interface Part {
  outboxRowId: string;
  partNo: number;
  tryNo: number;
  idempotencyKey: string;
  state: string;
  sentAt: string | null;
  deliveredAt: string | null;
}
interface Claim {
  claimNo: number;
  firstTryAt: string | null;
  nextTryNotBefore: string | null;
}
interface FollowUp {
  why: string;
  outboxRowId: string;
  recipientHandleId: string;
  channel: string;
  at: string;
}
interface OutboxLife {
  record: "outboxRow";
  row: { id: string; state: string; channel: string; recipientHandleId: string };
  parts: Part[];
  claim: Claim | null;
  moves: (RowMove | PartMove)[];
  followUps: FollowUp[];
}
interface EffectMove {
  from: string | null;
  to: string;
  at: string;
  by: string;
  tryOutcome: string | null;
  note: string;
}
interface EffectLife {
  record: "effect";
  effect: { effectId: string; state: string; tries: number; runs: number; firstTryAt: string | null };
  moves: EffectMove[];
  providerEventIds: string[];
}
interface ProviderEventRecord {
  record: "providerEvent";
  event: Obj;
}
type K07Record = OutboxLife | EffectLife | ProviderEventRecord;

const recordOf = (file: string): K07Record => fixture(file) as K07Record;
function outboxOf(file: string): OutboxLife {
  const record = recordOf(file);
  if (record.record !== "outboxRow") throw new Error(`${file} is no outbox row's life`);
  return record;
}
function effectOf(file: string): EffectLife {
  const record = recordOf(file);
  if (record.record !== "effect") throw new Error(`${file} is no effect row's life`);
  return record;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** An instant `ms` after `utc`, written as the fixtures write it (ending in Z, whole seconds when it has no fraction). */
const later = (utc: string, ms: number): string =>
  new Date(Date.parse(utc) + ms).toISOString().replace(/\.000Z$/, "Z");

const sorted = (values: readonly string[]): string[] => [...values].sort();

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

/** The JSON pointer Ajv names an instance path by. */
const pointerOf = (where: Path): string =>
  where.map((step) => `/${String(step).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");

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

const keyOf = (where: Path): string => JSON.stringify(where);

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

/** The required paths of a value under the schema an entry's version names, at its $defs entry or its root. */
function requiredPaths(entry: Entry, value: unknown): Path[] {
  const place: Place = {
    doc: schemaIdOf(entry.version),
    pointer: entry.def === undefined ? "" : pointerOf(["$defs", entry.def]),
  };
  return [...requiredIn(place, value, [])].map((key) => JSON.parse(key) as Path);
}
const requiredPathsOf = (entry: Entry): Path[] => requiredPaths(entry, fixture(entry.file));

/** The required fields whose removal the validator still accepts: none, for a schema that is not vacuous. */
function vacuousPaths(validate: ValidateFunction, value: unknown, paths: readonly Path[]): string[] {
  return paths.filter((where) => validate(without(value, where))).map(pointerOf);
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Every fixture of the index, each against the schema its version names

// The harness checks the schema only: an entry that names a `rule` and is marked refuse passes the schema and is
// refused by the rule, so the harness reports it as accepted-but-marked-refuse. Those entries are checked by the rule
// (part 2); every other entry must be ok in the harness.
const report = checkContractFixtures(NAME, { sharedFolders: SHARED_FOLDERS });

describe("outbox-effects fixtures: the index and the count", () => {
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
      const record = fixture(entry.file);
      const valid = accepts(entry, record);
      if (entry.rule === undefined) {
        expect(valid, entry.file).toBe(entry.expect === "accept");
      } else {
        expect(valid, `${entry.file} passes the schema, so its rule alone decides it`).toBe(true);
        expect(rule(entry.rule)(record).length === 0, entry.file).toBe(entry.expect === "accept");
      }
      checked += 1;
    }
    expect(checked).toBe(entries.length);
    expect(report.entries).toHaveLength(checked);
  });

  it("accepts every entry marked accept and refuses every entry marked refuse, by the schema or by its rule", () => {
    expect(report.passes).toBe(acceptedEntries.length);
    expect(report.refusals).toBe(refusedBySchema.length);
    expect(refusedEntries.length, "the index refuses some fixtures").toBeGreaterThan(0);
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
          : `passes the schema, refused by ${entry.rule}:`;
    it(`${how} ${entry.file} (${entry.version})`, () => {
      const result = must(report.entries.find((candidate) => candidate.file === entry.file));
      expect(result.schema).toBe(`${NAME}.${entry.version}.schema.json`);
      expect(result.def).toBe(entry.def ?? null);
      if (entry.expect === "refuse" && entry.rule !== undefined) {
        expect(result.outcome).toBe("accepted");
        expect(rule(entry.rule)(fixture(entry.file)).length).toBeGreaterThan(0);
      } else {
        expect(result.problems).toEqual([]);
        expect(result.ok).toBe(true);
        // This file's own validator agrees, so parts 2 to 5 judge with the same schema.
        expect(accepts(entry, fixture(entry.file))).toBe(entry.expect === "accept");
      }
    });
  }

  it("checks each entry against the schema its version names, and holds every version frozen.json names", () => {
    const frozen = (readJson(path.join(K07_DIR, "frozen.json")) as { frozen: string[] }).frozen;
    expect(frozen).toContain("v1");
    for (const version of frozen) expect(versions, version).toContain(version);
    for (const version of versions) {
      expect(SCHEMA_VERSIONS, `${NAME}.${version}.schema.json`).toContain(version);
      expect(
        acceptedEntries.filter((entry) => entry.version === version).length,
        `${version} has accepted fixtures`,
      ).toBeGreaterThan(0);
    }
    for (const result of report.entries)
      expect(result.schema, result.file).toBe(`${NAME}.${result.version}.schema.json`);
  });

  it("holds one record in every accepted fixture, of each kind the root names, accepted by its own definition too", () => {
    for (const version of versions) {
      const defs = recordDefsOf(version);
      if (WRITTEN_FOR.includes(version))
        expect(sorted([...defs.keys()]), version).toEqual(sorted(["outboxRow", "effect", "providerEvent"]));
      const kinds = new Set<string>();
      for (const entry of acceptedEntries.filter((candidate) => candidate.version === version)) {
        const record = recordOf(entry.file);
        kinds.add(record.record);
        const validate = validatorOf(version, must(defs.get(record.record), `${entry.file}'s record`));
        expect(validate(record), `${entry.file}: ${formatErrors(validate.errors).join("; ")}`).toBe(true);
      }
      expect(sorted([...kinds]), `${version}: every kind of record has an accepted fixture`).toEqual(
        sorted([...defs.keys()]),
      );
    }
  });

  it("accepts every accepted fixture by every later minor version too (a minor version only adds)", () => {
    let checked = 0;
    let expected = 0;
    for (const entry of acceptedEntries) {
      const laterVersions = laterMinorVersions(entry.version);
      expected += laterVersions.length;
      for (const version of laterVersions) {
        const validate = validatorOf(version, entry.def);
        expect(
          validate(fixture(entry.file)),
          `${entry.file} under ${version}: ${formatErrors(validate.errors).join("; ")}`,
        ).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBe(expected);
    if (SCHEMA_VERSIONS.length > 1) expect(checked).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The named rule, run for every entry that names it and on every accepted fixture

/** A damaged copy of an accepted fixture that the schema still takes and the named rule refuses, for the README's line. */
interface Damage<T> {
  /** The README's words for what lifeChain checks ("The retry rules"; "lifeChain also checks"). */
  check: string;
  file: string;
  damage: (life: T) => void;
  /** Words of the line lifeChain gives the damaged copy. */
  line: string;
}

const partMoveIndex = (life: OutboxLife, key: string, to: string): number => {
  const at = life.moves.findIndex((move) => move.subject === "part" && move.key === key && move.to === to);
  if (at === -1) throw new Error(`no move of ${key} to ${to}`);
  return at;
};
const rowMoveIndex = (life: OutboxLife, to: string): number => {
  const at = life.moves.findIndex((move) => move.subject === "row" && move.to === to);
  if (at === -1) throw new Error(`no row move to ${to}`);
  return at;
};
const claimOf = (life: OutboxLife): Claim => must(life.claim, "the claim");

const OUTBOX_DAMAGES: Damage<OutboxLife>[] = [
  {
    check: "each subject's moves chain `to` -> `from`",
    file: "outbox-delivered.json",
    damage: (life) => {
      must(life.moves[rowMoveIndex(life, "checked")]).from = "stale";
    },
    line: "move 2 starts from stale, but the one before ended in planned",
  },
  {
    check: "and end in its stated state",
    file: "outbox-delivered.json",
    damage: (life) => {
      life.row.state = "sent";
    },
    line: "its moves end in delivered, but its state is sent",
  },
  {
    check: "The key is `<row>/<part>/<try>`",
    file: "outbox-delivered.json",
    damage: (life) => {
      const part = must(life.parts[0]);
      const key = `${life.row.id}/1/2`;
      for (const move of life.moves) if (move.subject === "part") move.key = key;
      part.idempotencyKey = key;
    },
    line: "its key must be out-alex-booked-riley/1/1",
  },
  {
    check: "that a `sending` row has its claim",
    file: "outbox-retry-after-reclaimed.json",
    damage: (life) => {
      life.claim = null;
    },
    line: "a sending row has its claim",
  },
  {
    check: "and `claimNo` counts its claims",
    file: "outbox-claim-lapsed.json",
    damage: (life) => {
      claimOf(life).claimNo = 1;
    },
    line: "claimNo is 1, but the row was claimed 2 times",
  },
  {
    check: "that the claim's `firstTryAt` falls between the first part move and the first part outcome",
    file: "outbox-delivered.json",
    damage: (life) => {
      claimOf(life).firstTryAt = later(must(life.moves[0]).at, 3 * SECOND);
    },
    line: "firstTryAt comes before any part was written",
  },
  {
    check: "and is set once a part has had one",
    file: "outbox-delivered.json",
    damage: (life) => {
      claimOf(life).firstTryAt = null;
    },
    line: "firstTryAt is null, but a part reached sent",
  },
  {
    check: "that `nextTryNotBefore` is set only while the row is `sending` with a part pending",
    file: "outbox-delivered.json",
    damage: (life) => {
      claimOf(life).nextTryNotBefore = later(must(life.moves.at(-1)).at, MINUTE);
    },
    line: "nextTryNotBefore is set only while the row is sending with a part pending",
  },
  {
    check: "that a `superseded` row names exactly one `chatOpenAnswer`",
    file: "outbox-waiting-chat-superseded.json",
    damage: (life) => {
      life.followUps = [];
    },
    line: "a superseded row names the one message it gave way to (chatOpenAnswer)",
  },
  {
    check: "written in the commit that superseded it",
    file: "outbox-waiting-chat-superseded.json",
    damage: (life) => {
      const answer = must(life.followUps[0]);
      answer.at = later(answer.at, MINUTE);
    },
    line: "the one message is written in the commit that supersedes the row",
  },
  {
    check: "to the same mobile",
    file: "outbox-waiting-chat-superseded.json",
    damage: (life) => {
      must(life.followUps[0]).recipientHandleId = "handle-sam";
    },
    line: "the one message goes to the same mobile that texted in",
  },
  {
    check: "and that only a superseded row names one",
    file: "outbox-delivered.json",
    damage: (life) => {
      life.followUps = [
        {
          why: "chatOpenAnswer",
          outboxRowId: "out-alex-chat-open-answer",
          recipientHandleId: life.row.recipientHandleId,
          channel: life.row.channel,
          at: must(life.moves.at(-1)).at,
        },
      ];
    },
    line: "chatOpenAnswer follows only a superseded row",
  },
  {
    check: "retry rule 1: one after a reported failure gets a new key, the next try",
    file: "outbox-fallback-email.json",
    damage: (life) => {
      // Try 2's row written half a second before try 1's failure is reported, the moves kept in time order.
      const failure = partMoveIndex(life, `${life.row.id}/1/1`, "failed");
      const written = partMoveIndex(life, `${life.row.id}/1/2`, "pending");
      const [move] = life.moves.splice(written, 1);
      const failedAt = must(life.moves[failure]).at;
      life.moves.splice(failure, 0, { ...must(move), at: later(failedAt, -SECOND / 2) });
    },
    line: "written before out-alex-confirm-texts-down/1/1 reported its failure",
  },
  {
    check: "retry rule 3: a failed safety line retries every 10 s",
    file: "outbox-safety-retry.json",
    damage: (life) => {
      const failedAt = must(life.moves[partMoveIndex(life, `${life.row.id}/1/1`, "failed")]).at;
      must(life.moves[partMoveIndex(life, `${life.row.id}/1/2`, "pending")]).at = later(failedAt, 4 * SECOND);
    },
    line: "a failed safety line retries every 10 s",
  },
  {
    check:
      "retry rule 4: the second send waits for the words' delivery receipt, at most 10 s after Linq accepts them",
    file: "outbox-two-sends.json",
    damage: (life) => {
      // The words' receipt comes only after the poll went, 2 s after the words were accepted.
      const words = must(life.parts.find((part) => part.partNo === 1));
      const [receipt] = life.moves.splice(partMoveIndex(life, words.idempotencyKey, "delivered"), 1);
      const rowSent = rowMoveIndex(life, "sent");
      const at = later(must(life.moves[rowSent]).at, SECOND);
      life.moves.splice(rowSent + 1, 0, { ...must(receipt), at });
      words.deliveredAt = at;
    },
    line: "the second send waits for the words' receipt, or 10 s after they were accepted",
  },
  {
    check: "retry rule 5: sends still failing after 15 minutes of tries: the row is `failed`",
    file: "outbox-fallback-email.json",
    damage: (life) => {
      must(life.moves[rowMoveIndex(life, "failed")]).at = later(
        must(claimOf(life).firstTryAt),
        12 * MINUTE + 30 * SECOND,
      );
    },
    line: "fails only after 15 minutes of tries from the claim's firstTryAt",
  },
  {
    check: "retry rule 5: and the next way follows",
    file: "outbox-delivered.json",
    damage: (life) => {
      life.followUps = [
        {
          why: "nextWay",
          outboxRowId: "out-alex-confirm-by-email",
          recipientHandleId: "handle-alex-email",
          channel: "email",
          at: must(life.moves.at(-1)).at,
        },
      ];
    },
    line: "nextWay follows only a failed row",
  },
];

const EFFECT_DAMAGES: Damage<EffectLife>[] = [
  {
    check: "each subject's moves start when it is written",
    file: "effect-charge.json",
    damage: (life) => {
      life.moves.shift();
    },
    line: "its first move must start from null (it is written)",
  },
  {
    check: "in time order",
    file: "effect-charge.json",
    damage: (life) => {
      must(life.moves[2]).at = must(life.moves[0]).at;
    },
    line: "move 3 (2026-11-07T15:20:00Z) is earlier than the one before (2026-11-07T15:20:01Z)",
  },
  {
    check: "that `tries` ... match the effect's moves",
    file: "effect-charge.json",
    damage: (life) => {
      life.effect.tries = 2;
    },
    line: "tries is 2, but its last run shows 1",
  },
  {
    check: "that ... `runs` ... match the effect's moves",
    file: "effect-outage-runs-once.json",
    damage: (life) => {
      life.effect.runs = 1;
    },
    line: "runs is 1, but its moves show 2",
  },
  {
    check: "that ... `firstTryAt` match the effect's moves",
    file: "effect-charge.json",
    damage: (life) => {
      life.effect.firstTryAt = must(life.moves[0]).at;
    },
    line: "but its last run's first try went at 2026-11-07T15:20:01Z",
  },
  {
    check: "retry rule 8: at most 5 tries in 10 minutes from the run's start",
    file: "effect-gave-up-outage.json",
    damage: (life) => {
      const start = must(life.moves.find((move) => move.to === "running")).at;
      must(life.moves.at(-1)).at = later(start, 10 * MINUTE + 29 * SECOND);
    },
    line: "its tries span more than 10 minutes",
  },
  {
    check: "retry rule 8: then that service's outage row",
    file: "effect-gave-up-outage.json",
    damage: (life) => {
      // The outage row after the 4th try: one network error fewer.
      life.moves.splice(life.moves.length - 2, 1);
      life.effect.tries = 4;
    },
    line: "takes the outage row only after its 5th try",
  },
];

describe("outbox-effects fixtures: the named rule runs, none skipped", () => {
  it("has every rule an entry names in outbox-effects.rules.mjs, and lifeChain among them", () => {
    expect(Object.keys(rules)).toContain("lifeChain");
    expect(rules.lifeChain).toBe(lifeChain);
    for (const entry of entries) {
      if (entry.rule !== undefined) expect(typeof rules[entry.rule], entry.file).toBe("function");
    }
  });

  it("names lifeChain on every accepted v1 fixture (README 'Fixtures': each names the rule lifeChain)", () => {
    const v1 = acceptedEntries.filter((entry) => entry.version === "v1");
    expect(v1.length).toBeGreaterThan(0);
    for (const entry of v1) expect(entry.rule, entry.file).toBe("lifeChain");
  });

  for (const entry of entries) {
    if (entry.rule === undefined) continue;
    const name = entry.rule;
    it(`${entry.file}: the schema accepts it and ${name} ${entry.expect === "accept" ? "passes" : "refuses"} it`, () => {
      const record = fixture(entry.file);
      const validate = validatorOf(entry.version, entry.def);
      expect(validate(record), `${entry.file}: ${formatErrors(validate.errors).join("; ")}`).toBe(true);
      const problems = rule(name)(record);
      if (entry.expect === "accept") expect(problems, entry.file).toEqual([]);
      else expect(problems.length, `${entry.file} must be refused by ${name}`).toBeGreaterThan(0);
    });
  }

  it("passes lifeChain on every accepted fixture, named or not; a provider event has no moves and passes", () => {
    const kinds = new Set<string>();
    for (const entry of acceptedEntries) {
      const record = recordOf(entry.file);
      kinds.add(record.record);
      expect(lifeChain(record), entry.file).toEqual([]);
    }
    expect(kinds.has("providerEvent"), "a provider event is among them").toBe(true);
  });

  it("holds the rules file's numbers to the README's retry rules", () => {
    const retryRules = README.slice(
      README.indexOf("### The retry rules"),
      README.indexOf("### How a claim lapses"),
    );
    expect(retryRules).toContain("no delivery receipt comes within 1 minute");
    expect(rulesModule.RECEIPT_WAIT_MS).toBe(1 * MINUTE);
    expect(retryRules).toContain("at most 10 s after Linq accepts them");
    expect(rulesModule.SECOND_SEND_WAIT_MS).toBe(10 * SECOND);
    expect(retryRules).toContain("A failed safety line retries every 10 s for 15 minutes");
    expect(rulesModule.SAFETY_RETRY_MS).toBe(10 * SECOND);
    expect(retryRules).toContain("Sends still failing after 15 minutes of tries");
    expect(rulesModule.GIVE_UP_AFTER_MS).toBe(15 * MINUTE);
    expect(retryRules).toContain("at most 5 tries in 10 minutes from the run's start");
    expect(rulesModule.EFFECT_TRIES).toBe(5);
    expect(rulesModule.EFFECT_WINDOW_MS).toBe(10 * MINUTE);
  });

  const runDamage = <T extends OutboxLife | EffectLife>(
    { file, damage, line }: Damage<T>,
    of: (file: string) => T,
  ): void => {
    const damaged = of(file);
    damage(damaged);
    expect(isDeepStrictEqual(damaged, fixture(file)), "the damage changes the fixture").toBe(false);
    const entry = entryOf(file);
    expect(entry.expect).toBe("accept");
    const validate = validatorOf(entry.version, entry.def);
    expect(validate(damaged), `the schema still takes it: ${formatErrors(validate.errors).join("; ")}`).toBe(
      true,
    );
    const problems = lifeChain(damaged);
    expect(
      problems.some((problem) => problem.includes(line)),
      `lifeChain gives "${line}": ${problems.join("; ")}`,
    ).toBe(true);
  };

  for (const damage of OUTBOX_DAMAGES) {
    it(`fires on ${damage.file} damaged so it breaks "${damage.check}"`, () => {
      runDamage(damage, outboxOf);
    });
  }
  for (const damage of EFFECT_DAMAGES) {
    it(`fires on ${damage.file} damaged so it breaks "${damage.check}"`, () => {
      runDamage(damage, effectOf);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Each refusal tied to its reason (DL-124's mend-then-accept proof)

/** A refused fixture put right as its index entry and the README say ("The same ... passes"; "fixed, it passes"). */
interface Mend {
  /** Why it is refused, as its entry's `shows` says. */
  reason: string;
  /**
   * For a fixture the schema refuses: the fields the fault lies in. The schema's errors name one of them, and every
   * error lies at, inside or above one of them (no other fault); the mend changes only them.
   */
  fault: Path[];
  /** What putting it right is, as the entry says. */
  putRight: string;
  /** Puts a copy right. */
  mend: (record: K07Record) => void;
  /** The accepted fixture the copy put right is, but at `except` (where the entry's words differ). */
  twin?: { file: string; except?: Path[] };
}

const asOutbox = (record: K07Record): OutboxLife => {
  if (record.record !== "outboxRow") throw new Error("no outbox row's life");
  return record;
};
const asEffect = (record: K07Record): EffectLife => {
  if (record.record !== "effect") throw new Error("no effect row's life");
  return record;
};
/** The row as the schema reads it: the fields lifeChain needs and the rest of K-04's row. */
const rowOf = (record: K07Record): Obj => asOutbox(record).row;

const MENDS: Record<string, Mend> = {
  "invalid/refuse-sms-channel.json": {
    reason: "it goes through an SMS port, and there is no SMS provider (port is linq or email)",
    fault: [["row", "port"]],
    putRight: "on Linq's sms channel through port linq",
    mend: (record) => {
      rowOf(record).port = "linq";
    },
  },
  "invalid/refuse-sms-row-with-poll.json": {
    reason:
      "a reply on Linq's SMS service goes back in that chat as text only, and this row on sms sends a poll",
    fault: [
      ["row", "channel"],
      ["row", "finalParts"],
    ],
    putRight: "the same row on imessage",
    mend: (record) => {
      const row = rowOf(record);
      row.channel = "imessage";
      setAt(row, ["finalParts", "channel"], "imessage");
    },
    twin: { file: "outbox-two-sends.json" },
  },
  "invalid/refuse-part-without-key.json": {
    reason: "a part has no idempotency key",
    fault: [["parts", 0, "idempotencyKey"]],
    putRight: "with its key, <row>/<part>/<try>",
    mend: (record) => {
      const life = asOutbox(record);
      const part = must(life.parts[0]);
      part.idempotencyKey = `${life.row.id}/${String(part.partNo)}/${String(part.tryNo)}`;
    },
    twin: { file: "outbox-delivered.json" },
  },
  "invalid/refuse-row-move-not-allowed.json": {
    reason: "a delivered row is claimed again (delivered to sending), which is no move",
    fault: [["moves", 8]],
    putRight: "without that move",
    mend: (record) => {
      asOutbox(record).moves.pop();
    },
    twin: { file: "outbox-delivered.json" },
  },
  "invalid/refuse-4006-new-key-too-soon.json": {
    reason:
      "after a 4006, try 2 goes under a new key only 20 s later, and a new key waits 1 minute for a receipt",
    fault: [],
    putRight: "with try 2 and every move after it made the rest of the minute later",
    mend: (record) => {
      const life = asOutbox(record);
      const failedAt = must(life.moves[partMoveIndex(life, `${life.row.id}/1/1`, "failed")]).at;
      const written = partMoveIndex(life, `${life.row.id}/1/2`, "pending");
      const shift =
        rulesModule.RECEIPT_WAIT_MS - (Date.parse(must(life.moves[written]).at) - Date.parse(failedAt));
      for (const move of life.moves.slice(written)) move.at = later(move.at, shift);
      const tryTwo = must(life.parts.find((part) => part.tryNo === 2));
      tryTwo.sentAt = later(must(tryTwo.sentAt), shift);
      tryTwo.deliveredAt = later(must(tryTwo.deliveredAt), shift);
    },
    // Put right, it is outbox-4006-new-key.json but for the note of try 2's move, which says why it was refused.
    twin: { file: "outbox-4006-new-key.json", except: [["moves", 5, "note"]] },
  },
  "invalid/refuse-effect-without-key.json": {
    reason: "the deposit charge has no idempotency key",
    fault: [["effect", "idempotencyKey"]],
    putRight: "with its one key, the effect id",
    mend: (record) => {
      const effect = asEffect(record).effect as unknown as Obj;
      effect.idempotencyKey = effect.effectId;
    },
    twin: { file: "effect-charge.json" },
  },
  "invalid/refuse-decline-retried.json": {
    reason: "a declined card is tried again (declined to running), which is no move",
    fault: [["moves", 3]],
    putRight: "without that move",
    mend: (record) => {
      asEffect(record).moves.pop();
    },
    twin: { file: "effect-charge-declined.json" },
  },
  "invalid/refuse-waiting-with-claim.json": {
    reason: "a row waiting for the chat to open keeps its claim, and a waiting row keeps no claim",
    fault: [["claim"]],
    putRight: "with its claim let go (null)",
    mend: (record) => {
      asOutbox(record).claim = null;
    },
  },
  "invalid/refuse-waiting-by-wrong-actor.json": {
    reason: "markPart puts the row to waiting_chat, and only limit 8 at send (markRow) does it",
    fault: [["moves", 4]],
    putRight: "the same move by markRow",
    mend: (record) => {
      must(asOutbox(record).moves[4]).by = "markRow";
    },
  },
};

/** The lines the named rule gives each fixture it alone refuses: the one reason its entry names. */
const RULE_REASONS: Record<string, string[]> = {
  "invalid/refuse-4006-new-key-too-soon.json": [
    "part out-sam-booked-riley/1/2: after a 4006 a new key waits 1 minute for a delivery receipt (arch 01 line 65)",
  ],
};

/** Where a schema error points: its instance path, and the field a required or unknown-field error names. */
function errorPlace(error: ErrorObject): string {
  const params = error.params as { missingProperty?: string; additionalProperty?: string };
  const field = params.missingProperty ?? params.additionalProperty;
  return field === undefined ? error.instancePath : `${error.instancePath}${pointerOf([field])}`;
}

/** The places the schema's errors name in a record (each once), read against the definition of its own `record`. */
function errorPlaces(entry: Entry, record: unknown): string[] {
  const kind = isObj(record) && typeof record.record === "string" ? record.record : "";
  const validate = validatorOf(entry.version, must(recordDefsOf(entry.version).get(kind), kind), explainAjv);
  return validate(record) ? [] : [...new Set((validate.errors ?? []).map(errorPlace))];
}

/** Whether `place` is at or inside the field at `fault`. */
const within = (place: string, fault: string): boolean => place === fault || place.startsWith(`${fault}/`);
/** Whether `place` is at, inside or above the field at `fault` (the root is above every field). */
const near = (place: string, fault: string): boolean =>
  within(place, fault) || within(fault, place) || place === "";

/** The copy of a refused fixture put right by its mend. */
function mended(file: string, mend = must(MENDS[file], `the mend of ${file}`)): K07Record {
  const copy = recordOf(file);
  mend.mend(copy);
  return copy;
}

/**
 * Each way a mend fails to tie a refusal to its reason, one line each; none when the proof holds. A fixture the schema
 * refuses: refused as it stands, the schema's errors name the fault and no other place, and the mend changes only the
 * fault. A fixture its rule alone refuses: the schema takes it and the rule gives exactly `reasons`. Either way, put
 * right it is accepted and passes lifeChain, and it is its twin where one is named.
 */
export function mendProblems(file: string, mend: Mend, reasons = RULE_REASONS[file]): string[] {
  const entry = entryOf(file);
  const problems: string[] = [];
  const refused = recordOf(file);
  const right = mended(file, mend);
  const changed = differences(refused, right).map(pointerOf);
  if (changed.length === 0) problems.push("the mend changes nothing");
  if (entry.rule === undefined) {
    if (accepts(entry, refused)) problems.push(`${file} is accepted as it stands`);
    const faults = mend.fault.map(pointerOf);
    if (faults.length === 0) problems.push("the mend names no fault");
    const places = errorPlaces(entry, refused);
    if (!places.some((place) => faults.some((fault) => within(place, fault))))
      problems.push(`the schema's errors name none of ${faults.join(", ")}: ${places.join("; ")}`);
    for (const place of places.filter((candidate) => !faults.some((fault) => near(candidate, fault))))
      problems.push(`the schema's errors also name ${place}`);
    for (const place of changed.filter((candidate) => !faults.some((fault) => near(candidate, fault))))
      problems.push(`the mend changes ${place}, outside the fault`);
  } else {
    if (!accepts(entry, refused)) problems.push(`${file} is refused by the schema, not by its rule alone`);
    const lines = rule(entry.rule)(refused);
    if (!isDeepStrictEqual(lines, reasons)) problems.push(`${entry.rule} gives ${JSON.stringify(lines)}`);
  }
  const validate = validatorOf(entry.version, entry.def);
  if (!validate(right))
    problems.push(`put right, it is still refused: ${formatErrors(validate.errors).join("; ")}`);
  const lines = lifeChain(right);
  if (lines.length > 0) problems.push(`put right, lifeChain refuses it: ${lines.join("; ")}`);
  if (mend.twin !== undefined) {
    const { file: twinFile, except = [] } = mend.twin;
    if (entryOf(twinFile).expect !== "accept") problems.push(`${twinFile} is not an accepted fixture`);
    const theirs = fixture(twinFile);
    const ours = structuredClone(right) as unknown;
    for (const where of except) {
      setAt(theirs, where, null);
      setAt(ours, where, null);
    }
    if (!isDeepStrictEqual(ours, theirs)) problems.push(`put right, it is not ${twinFile}`);
  }
  return problems;
}

describe("outbox-effects fixtures: each refused fixture is refused for its reason, and accepted put right", () => {
  it("holds a mend for every refused fixture of the versions it was written for, and a rule's line for each it refuses", () => {
    const written = refusedEntries.filter((entry) => WRITTEN_FOR.includes(entry.version));
    expect(written.length).toBeGreaterThan(0);
    expect(sorted(Object.keys(MENDS))).toEqual(sorted(written.map((entry) => entry.file)));
    expect(sorted(Object.keys(RULE_REASONS))).toEqual(
      sorted(written.filter((entry) => entry.rule !== undefined).map((entry) => entry.file)),
    );
  });

  for (const [file, mend] of Object.entries(MENDS)) {
    it(`${file}: refused because ${mend.reason}; ${mend.putRight}, it is accepted`, () => {
      const entry = entryOf(file);
      if (entry.rule === undefined) {
        // Refused by the schema, whose errors name the fault and no other place.
        expect(accepts(entry, fixture(file)), `${file} is refused as it stands`).toBe(false);
        expect(mend.fault.length, "the fault is named").toBeGreaterThan(0);
      } else {
        // Taken by the schema and refused by its rule alone, for the rule's one named reason.
        expect(rule(entry.rule)(fixture(file))).toEqual(
          must(RULE_REASONS[file], `the rule's line for ${file}`),
        );
      }
      expect(mendProblems(file, mend)).toEqual([]);
      expect(lifeChain(mended(file)), `${file} put right passes lifeChain`).toEqual([]);
    });
  }

  it("has the proof fire on a damaged mend: the fault left, another fault named, the wrong twin, another rule line", () => {
    const file = "invalid/refuse-part-without-key.json";
    const right = must(MENDS[file]);
    expect(mendProblems(file, right)).toEqual([]);
    // A mend that changes another field and leaves the missing key, which lifeChain finds too.
    const leftAlone: Mend = {
      ...right,
      mend: (record) => {
        (must(asOutbox(record).parts[0]) as unknown as Obj).attempts = 2;
      },
    };
    expect(mendProblems(file, leftAlone)).toEqual([
      "the mend changes /parts/0/attempts, outside the fault",
      expect.stringContaining("put right, it is still refused: "),
      expect.stringContaining("put right, lifeChain refuses it: "),
      "put right, it is not outbox-delivered.json",
    ]);
    // The right mend with another field named as the fault: the schema's errors name the missing key.
    expect(mendProblems(file, { ...right, fault: [["parts", 0, "attempts"]] })).toEqual([
      "the schema's errors name none of /parts/0/attempts: /parts/0/idempotencyKey",
      "the schema's errors also name /parts/0/idempotencyKey",
      "the mend changes /parts/0/idempotencyKey, outside the fault",
    ]);
    expect(mendProblems(file, { ...right, twin: { file: "outbox-two-sends.json" } })).toEqual([
      "put right, it is not outbox-two-sends.json",
    ]);
    // The rule's refusal: another line than the reason its entry names, and a mend that changes nothing.
    const ruled = "invalid/refuse-4006-new-key-too-soon.json";
    const ruledMend = must(MENDS[ruled]);
    expect(mendProblems(ruled, ruledMend, ["another line"])).toEqual([
      `lifeChain gives ${JSON.stringify(RULE_REASONS[ruled])}`,
    ]);
    expect(mendProblems(ruled, { ...ruledMend, mend: () => undefined })).toEqual([
      "the mend changes nothing",
      `put right, lifeChain refuses it: ${must(RULE_REASONS[ruled]).join("; ")}`,
      "put right, it is not outbox-4006-new-key.json",
    ]);
  });

  it("puts the 4006 fixture right with exactly the minute the rules file's constant gives, and not a second less", () => {
    const file = "invalid/refuse-4006-new-key-too-soon.json";
    const right = asOutbox(mended(file));
    const failedAt = must(right.moves[partMoveIndex(right, `${right.row.id}/1/1`, "failed")]).at;
    const written = partMoveIndex(right, `${right.row.id}/1/2`, "pending");
    expect(Date.parse(must(right.moves[written]).at) - Date.parse(failedAt)).toBe(
      rulesModule.RECEIPT_WAIT_MS,
    );
    // A second short of the minute, every later move with it, the rule refuses it again for the same reason.
    const short = structuredClone(right);
    for (const move of short.moves.slice(written)) move.at = later(move.at, -SECOND);
    const tryTwo = must(short.parts.find((part) => part.tryNo === 2));
    tryTwo.sentAt = later(must(tryTwo.sentAt), -SECOND);
    tryTwo.deliveredAt = later(must(tryTwo.deliveredAt), -SECOND);
    expect(accepts(entryOf(file), short)).toBe(true);
    expect(lifeChain(short)).toEqual(must(RULE_REASONS[file]));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. The schema is not vacuous

/** The record's own objects the schema closes: the root, each object under it, and each object item of its lists. */
function closedObjects(record: unknown): Path[] {
  if (!isObj(record)) return [];
  const paths: Path[] = [[]];
  for (const [key, value] of Object.entries(record)) {
    if (isObj(value)) paths.push([key]);
    if (!Array.isArray(value)) continue;
    for (const [k, item] of value.entries()) if (isObj(item)) paths.push([key, k]);
  }
  return paths;
}

/**
 * A damaged copy of K-07 v1 whose effect row no longer requires its idempotency key, compiled while the file loads:
 * v1 under an $id of its own beside the real files, so its $refs resolve, with one field fewer in effectRow's `required`.
 */
function damagedWithoutEffectKey(): ValidateFunction {
  const damaged = structuredClone(must(SCHEMA_BY_ID.get(schemaIdOf("v1")), "K-07 v1"));
  const effectRow = must(
    (damaged.$defs as Record<string, { required: string[] } | undefined>).effectRow,
    "effectRow",
  );
  effectRow.required = effectRow.required.filter((field) => field !== "idempotencyKey");
  const damagedId = `${ID_BASE}${NAME}/damaged-for-test.schema.json`;
  damaged.$id = damagedId;
  const ajv = new Ajv2020({ strict: true, strictRequired: false });
  for (const schema of SCHEMAS.values()) ajv.addSchema(structuredClone(schema));
  ajv.addSchema(damaged);
  return must(ajv.getSchema(damagedId), "the damaged schema");
}
const withoutEffectKey = damagedWithoutEffectKey();

describe("outbox-effects fixtures: removing a required field makes an accepted fixture refused", () => {
  for (const entry of acceptedEntries) {
    it(`${entry.file} (${entry.version})`, () => {
      const validate = validatorOf(entry.version, entry.def);
      const original = fixture(entry.file);
      expect(validate(original), formatErrors(validate.errors).join("; ")).toBe(true);
      const required = requiredPathsOf(entry);
      const root = required.filter((where) => where.length === 1).map((where) => String(where[0]));
      expect(root, "a record requires its kind").toContain("record");
      expect(required.length, "the schema requires fields below the root too").toBeGreaterThan(root.length);
      if (WRITTEN_FOR.includes(entry.version)) {
        // K-07 v1 states every column, null where it is empty: each field of the record's own objects (the record,
        // the row, the effect or the event; each part, move and follow-up; the claim) is required. A later minor
        // version may add an optional one.
        const keys = new Set(required.map(keyOf));
        for (const object of closedObjects(original)) {
          for (const field of Object.keys(getAt(original, object) as Obj))
            expect(keys.has(keyOf([...object, field])), `${pointerOf([...object, field])} is required`).toBe(
              true,
            );
        }
      }
      expect(vacuousPaths(validate, original, required), "each removed, the copy must be refused").toEqual(
        [],
      );
      for (const object of closedObjects(original)) {
        const copy = structuredClone(original);
        (getAt(copy, object) as Obj).notInTheSchema = 1;
        expect(
          validate(copy),
          `${pointerOf(object) || "the root"} with a field the schema does not know`,
        ).toBe(false);
      }
    });
  }

  it("reads the required fields from the schemas: nested ones, the branch a value takes, and none that is free", () => {
    const keys = (file: string): Set<string> => new Set(requiredPathsOf(entryOf(file)).map(keyOf));
    const twoSends = keys("outbox-two-sends.json");
    for (const where of [
      ["row", "finalParts", "sends"],
      ["parts", 1, "providerOptionIds"],
      ["claim", "nextTryNotBefore"],
      ["moves", 0, "note"],
      ["moves", 4, "key"],
      ["moves", 4, "errorCode"],
    ])
      expect(twoSends.has(keyOf(where)), pointerOf(where)).toBe(true);
    const charge = keys("effect-charge.json");
    for (const where of [
      ["effect", "idempotencyKey"],
      ["effect", "amount", "cents"],
      ["effect", "amount", "currency"],
      ["moves", 2, "tryOutcome"],
      ["providerEventIds"],
    ])
      expect(charge.has(keyOf(where)), pointerOf(where)).toBe(true);
    // A port's request and a provider event's payload are free objects (their shapes are K-11's, K-14's and K-16's):
    // the fields inside them are present but never counted.
    const free = (file: string, where: Path): void => {
      expect(getAt(fixture(file), where), `${file} has ${pointerOf(where)}`).toBeDefined();
      expect(keys(file).has(keyOf(where)), `${file}: ${pointerOf(where)} is free`).toBe(false);
    };
    free("effect-charge.json", ["effect", "portRequest", "purpose"]);
    const event = fixture("provider-event-stripe.json");
    const payloadField = must(Object.keys(getAt(event, ["event", "payload"]) as Obj)[0], "a payload field");
    free("provider-event-stripe.json", ["event", "payload", payloadField]);
  });

  it("fires on a schema that stops requiring a field: the effect's key removed is then accepted", () => {
    const entry = entryOf("effect-charge.json");
    const original = fixture(entry.file);
    const required = requiredPathsOf(entry);
    expect(vacuousPaths(validatorOf(entry.version), original, required)).toEqual([]);
    expect(withoutEffectKey(original)).toBe(true);
    expect(vacuousPaths(withoutEffectKey, original, required)).toEqual(["/effect/idempotencyKey"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. Every state move in the fixtures is allowed and no other (02-contracts K-07 "Contract test")

/** The version the README's move tables are written for. */
const MOVES_VERSION = "v1";

/** A Markdown table row's trimmed cells; none for a line that is no table row. */
const cellsOf = (line: string): string[] =>
  line.startsWith("|")
    ? line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim())
    : [];

/** The body rows of the README table whose header's first cell is `first`, each as its cells. */
function tableRows(first: string): string[][] {
  const lines = README.split("\n");
  const start = lines.findIndex((line) => cellsOf(line)[0] === first);
  if (start === -1) throw new Error(`the README has no table "${first}"`);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(cellsOf(line));
  }
  return rows;
}

/** One allowed move as a README table gives it: its states and the actors its "By" cell names. */
interface AllowedMove {
  from: string | null;
  to: string;
  by: string[];
}

/** README "Allowed moves": a table's moves ("(new)" is a move from null; "pending or sent" two moves). */
function movesTable(first: string, actors: readonly string[]): AllowedMove[] {
  return tableRows(first).flatMap((cells) => {
    const [left, right] = must(cells[0]).split("→");
    const to = must(right).trim();
    const by = [...must(cells[1]).matchAll(/`([^`]+)`/g)]
      .map((match) => must(match[1]))
      .filter((word) => actors.includes(word));
    const froms: (string | null)[] = must(left).trim() === "(new)" ? [null] : must(left).split(" or ");
    return froms.map((from) => ({ from: from === null ? null : from.trim(), to, by }));
  });
}

const pairOf = (from: string | null, to: string): string => `${String(from)} -> ${to}`;
const moveOf = (from: string | null, to: string, by: string): string => `${pairOf(from, to)} by ${by}`;

const V1_DEFS = (
  must(SCHEMA_BY_ID.get(schemaIdOf(MOVES_VERSION)), `K-07 ${MOVES_VERSION}`) as {
    $defs: Record<string, { enum?: unknown[] } | undefined>;
  }
).$defs;
/** A closed list of the schema's own words. */
function enumOf(def: string): string[] {
  const values = must(V1_DEFS[def]?.enum, `the enum of ${def}`);
  const words = values.filter((value): value is string => typeof value === "string");
  if (words.length !== values.length) throw new Error(`${def} lists more than words`);
  return words;
}
const ROW_STATES = enumOf("rowState");
const PART_STATES = enumOf("partState");
const EFFECT_STATES = enumOf("effectState");
const OUTBOX_ACTORS = enumOf("outboxActor");
const EFFECT_ACTORS = enumOf("effectActor");

const README_ROW_MOVES = movesTable("Row move", OUTBOX_ACTORS);
const README_PART_MOVES = movesTable("Part move", OUTBOX_ACTORS);
const README_EFFECT_MOVES = movesTable("Effect move", EFFECT_ACTORS);

/**
 * The moves a move definition of the schema accepts, each as "from -> to by actor": every state (and null) to every
 * state, by every actor of its list, with each value of the fields the branches tie to a move (a part's error code, an
 * effect's try outcome), at a valid time with a note.
 */
function schemaMoves(
  def: string,
  states: readonly string[],
  actors: readonly string[],
  variants: Obj[],
): Set<string> {
  const validate = validatorOf(MOVES_VERSION, def);
  const found = new Set<string>();
  for (const from of [null, ...states])
    for (const to of states)
      for (const by of actors)
        for (const variant of variants)
          if (
            validate({
              ...variant,
              from,
              to,
              at: "2026-11-07T15:06:31Z",
              by,
              note: "A move this test builds.",
            })
          )
            found.add(moveOf(from, to, by));
  return found;
}
const SCHEMA_ROW_MOVES = schemaMoves("rowMove", ROW_STATES, OUTBOX_ACTORS, [{ subject: "row" }]);
const SCHEMA_PART_MOVES = schemaMoves(
  "partMove",
  PART_STATES,
  OUTBOX_ACTORS,
  [null, "4006"].map((errorCode) => ({ subject: "part", key: "out-alex-booked-riley/1/1", errorCode })),
);
const SCHEMA_EFFECT_MOVES = schemaMoves(
  "effectMove",
  EFFECT_STATES,
  EFFECT_ACTORS,
  [null, "ok", "networkError", "declined"].map((tryOutcome) => ({ tryOutcome })),
);
const pairsOf = (moves: Iterable<string>): Set<string> =>
  new Set([...moves].map((move) => move.replace(/ by .*$/, "")));

/** Each move of a record, by its subject: "row", "part" or "effect". */
function movesIn(record: K07Record): { subject: string; from: string | null; to: string; by: string }[] {
  if (record.record === "providerEvent") return [];
  if (record.record === "effect") return record.moves.map((move) => ({ ...move, subject: "effect" }));
  return record.moves;
}

const movesVersionAccepted = acceptedEntries.filter((entry) => entry.version === MOVES_VERSION);

describe("outbox-effects fixtures: every state move in the fixtures is allowed and no other", () => {
  it("has the README's row states and the states and actors its move tables name, all of them the schema's", () => {
    const readmeStates = tableRows("State").map((cells) => must(cells[0]).replaceAll("`", ""));
    expect(sorted(readmeStates)).toEqual(sorted(ROW_STATES));
    const named = (moves: AllowedMove[]): string[] =>
      sorted([...new Set(moves.flatMap((move) => [move.to, ...(move.from === null ? [] : [move.from])]))]);
    expect(named(README_ROW_MOVES)).toEqual(sorted(ROW_STATES));
    expect(named(README_PART_MOVES)).toEqual(sorted(PART_STATES));
    expect(named(README_EFFECT_MOVES)).toEqual(sorted(EFFECT_STATES));
    expect(sorted([...new Set(README_ROW_MOVES.flatMap((move) => move.by))])).toEqual(sorted(OUTBOX_ACTORS));
  });

  it("allows exactly the README's row moves, each by its one actor, and no other", () => {
    for (const move of README_ROW_MOVES)
      expect(move.by, `${pairOf(move.from, move.to)} names one actor`).toHaveLength(1);
    const readme = README_ROW_MOVES.map((move) => moveOf(move.from, move.to, must(move.by[0])));
    expect(new Set(readme).size, "no row move is listed twice").toBe(readme.length);
    expect(sorted([...SCHEMA_ROW_MOVES])).toEqual(sorted(readme));
  });

  it("allows exactly the README's part moves and no other, each by the actors the README names", () => {
    const readme = README_PART_MOVES.map((move) => pairOf(move.from, move.to));
    expect(sorted([...pairsOf(SCHEMA_PART_MOVES)])).toEqual(sorted([...new Set(readme)]));
    for (const move of README_PART_MOVES) {
      expect(move.by.length, `${pairOf(move.from, move.to)} names an actor`).toBeGreaterThan(0);
      for (const by of move.by)
        expect(SCHEMA_PART_MOVES.has(moveOf(move.from, move.to, by)), moveOf(move.from, move.to, by)).toBe(
          true,
        );
    }
  });

  it("allows exactly the README's effect moves and no other, each by the actors the README names", () => {
    const readme = README_EFFECT_MOVES.map((move) => pairOf(move.from, move.to));
    expect(sorted([...pairsOf(SCHEMA_EFFECT_MOVES)])).toEqual(sorted([...new Set(readme)]));
    for (const move of README_EFFECT_MOVES)
      for (const by of move.by)
        expect(SCHEMA_EFFECT_MOVES.has(moveOf(move.from, move.to, by)), moveOf(move.from, move.to, by)).toBe(
          true,
        );
    // A decline is never retried and a cancelled or succeeded effect never runs again (arch 10 line 542).
    for (const state of ["succeeded", "declined", "cancelled"])
      expect(
        [...pairsOf(SCHEMA_EFFECT_MOVES)].filter((pair) => pair.startsWith(`${state} -> `)),
        state,
      ).toEqual([]);
  });

  it("finds every move of every accepted fixture among the README's moves (a row's by its actor too)", () => {
    const rows = new Set(README_ROW_MOVES.map((move) => moveOf(move.from, move.to, must(move.by[0]))));
    const parts = new Set(README_PART_MOVES.map((move) => pairOf(move.from, move.to)));
    const effects = new Set(README_EFFECT_MOVES.map((move) => pairOf(move.from, move.to)));
    let checked = 0;
    for (const entry of movesVersionAccepted) {
      for (const move of movesIn(recordOf(entry.file))) {
        const where = `${entry.file}: ${move.subject} ${moveOf(move.from, move.to, move.by)}`;
        if (move.subject === "row") expect(rows.has(moveOf(move.from, move.to, move.by)), where).toBe(true);
        else if (move.subject === "part") expect(parts.has(pairOf(move.from, move.to)), where).toBe(true);
        else expect(effects.has(pairOf(move.from, move.to)), where).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(movesVersionAccepted.length);
  });

  it("shows every move of the README's tables in an accepted fixture (a row's by its actor too)", () => {
    const seen = new Set<string>();
    for (const entry of movesVersionAccepted) {
      for (const move of movesIn(recordOf(entry.file))) {
        seen.add(`${move.subject} ${moveOf(move.from, move.to, move.by)}`);
        seen.add(`${move.subject} ${pairOf(move.from, move.to)}`);
      }
    }
    const shown = [
      ...README_ROW_MOVES.map((move) => `row ${moveOf(move.from, move.to, must(move.by[0]))}`),
      ...README_PART_MOVES.map((move) => `part ${pairOf(move.from, move.to)}`),
      ...README_EFFECT_MOVES.map((move) => `effect ${pairOf(move.from, move.to)}`),
    ];
    expect(
      shown.filter((move) => !seen.has(move)),
      "moves no accepted fixture shows",
    ).toEqual([]);
  });

  it("refuses, by the schema, every refused fixture that shows a move outside the README's tables", () => {
    const rows = new Set(README_ROW_MOVES.map((move) => moveOf(move.from, move.to, must(move.by[0]))));
    const parts = new Set(README_PART_MOVES.map((move) => pairOf(move.from, move.to)));
    const effects = new Set(README_EFFECT_MOVES.map((move) => pairOf(move.from, move.to)));
    const allowed = (move: { subject: string; from: string | null; to: string; by: string }): boolean =>
      move.subject === "row"
        ? rows.has(moveOf(move.from, move.to, move.by))
        : (move.subject === "part" ? parts : effects).has(pairOf(move.from, move.to));
    const showing = refusedEntries.filter(
      (entry) =>
        entry.version === MOVES_VERSION && movesIn(recordOf(entry.file)).some((move) => !allowed(move)),
    );
    expect(showing.length).toBeGreaterThan(0);
    for (const entry of showing) {
      expect(entry.rule, entry.file).toBeUndefined();
      expect(accepts(entry, fixture(entry.file)), entry.file).toBe(false);
      // Put right (part 3), its moves are all allowed.
      expect(movesIn(mended(entry.file)).every(allowed), entry.file).toBe(true);
    }
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
 * ops/plan/02-contracts.md K-07 "Contract test" and section 2 item 12: each producer's output and each consumer side
 * against every fixture, the doubles accepting every effect request and a repeated effect with one key running once.
 * Each side's components under their owner as contracts/outbox-effects/README.md names them ("Producers and consumers
 * (02-contracts K-07)"). Each side is added later by a QA side task that depends on this task and on that side's build
 * task: it fills `check` (and moves its own test beside this one). Until then the side is held here with what it must
 * show, so none is forgotten.
 */
export const SIDE_CHECKS: readonly SideCheck[] = [
  {
    id: "producer-action-layer",
    side: "producer",
    owner: "action-layer engineer",
    components: [
      "C-087 one commit per turn (rows at commit)",
      "C-088 to C-093 (final parts)",
      "C-109 effects runner (results)",
    ],
    needs:
      "The commit writes each outbox row planned with no plan, and each effect row pending under its one idempotency key, in the turn's one transaction (commitTurn; a clock firing with no turn by fireClock, the daily reconciliation's refund by reconciliationJob); writePlan writes K-03's final parts as the row moves planned or stale to checked; the effects runner makes exactly the effect fixtures' moves: one key over all its tries, at most 5 tries in 10 minutes then that service's outage row, a decline never retried, a run once more after the outage or cancelled when let go, and a repeated effect with one key runs once. Every life it leaves is one the schema accepts and lifeChain passes, and it refuses every invalid one, writing nothing.",
  },
  {
    id: "producer-database",
    side: "producer",
    owner: "database engineer",
    components: ["C-151 core tables", "C-152 data-access calls"],
    needs:
      "Migrated from a fresh schema, the catalog holds exactly outbox-effects.v1.tables.json's effects, provider_events and outbox_claims beside K-04 v1's outbox tables (README 'The schema addition', with K-05 v1.1); K-05's calls make exactly the README's row, part and effect moves, so each fixture's life replayed leaves its rows as the fixture gives them, a move to waiting_chat deletes the row's claim, and a provider event is stored once by (provider, provider_event_id); and it refuses every invalid one: a move outside the tables, a part or effect with no key, an SMS port.",
  },
  {
    id: "consumer-runtime",
    side: "consumer",
    owner: "runtime engineer",
    components: [
      "C-124 outbox dispatcher",
      "C-125 limit 8",
      "C-126 channel fallback",
      "C-127 two-part send",
      "C-128 allowed formats",
      "C-129 email rows",
      "C-055 clock arming",
      "C-174 to C-176 outage paths",
    ],
    needs:
      "The dispatcher claims rows in commit order and sends and marks parts as the outbox fixtures show: a retry after a timeout or crash reuses the key, one after a reported failure takes the next key, after a 4001 or 4006 only when no receipt came within 1 minute, a safety line every 10 s and every other way at once, each try after any Retry-After, the second send after the words' receipt or 10 s, a lapsed claim taken again keeping firstTryAt and nextTryNotBefore; limit 8 gives held, dropped_stopped, stale, withdrawn and waiting_chat as the fixtures do; after 15 minutes of tries the row fails and the next way follows, an email row with its text row's plan; the clock arms at the first delivery receipt; the outage paths wait, then run once or let go. Every life it leaves passes lifeChain, and it refuses every invalid one, sending none of them.",
  },
  {
    id: "consumer-action-layer",
    side: "consumer",
    owner: "action-layer engineer",
    components: ["C-101 payments and ledger", "C-109 effects runner", "C-112 reconciliation job"],
    needs:
      "Payments and the ledger read each Stripe effect's result and ledger line by its effect id; the effects runner reads the effect rows and their moves as the fixtures give them; the reconciliation job matches charges and refunds to ledger lines by effect id and writes only a stripe_refund, as a job with no turn (reconciliationJob: arch 10 line 550; S12-26); it refuses every invalid one.",
  },
  {
    id: "consumer-integrations",
    side: "consumer",
    owner: "integrations engineer",
    components: [
      "C-206 Linq send",
      "C-208 Linq contacts registrar",
      "C-213 email",
      "C-214 Stripe Connect",
      "C-215 Stripe platform billing",
      "C-216 Google calendar",
      "C-217 Microsoft calendar",
    ],
    needs:
      "Against every effect fixture, the Linq, email, Stripe and calendar doubles accept every effect request (its portRequest in its port's terms, once K-11, K-12, K-14 and K-16 freeze them), and a repeated effect with one key runs once against each; the adapters give back the part results (accepted, delivered, failed with its code: 4001, 4006, 503, 429, poll.failed), the effect results (ok, networkError, declined) and the provider events the fixtures show, Linq's contacts/add among them; it refuses every invalid one.",
  },
  {
    id: "consumer-frontend",
    side: "consumer",
    owner: "frontend engineer",
    components: ["C-194 team console"],
    needs:
      "The team console shows failed rows and effects as the fixtures give them (a failed row with the way that followed, an effect in outage, declined or cancelled; dead letters are K-37's), and it refuses every invalid one.",
  },
  {
    id: "consumer-qa",
    side: "consumer",
    owner: "QA",
    components: ["C-148 end-to-end tests", "C-140 eval harness"],
    needs:
      "The end-to-end tests read outbox rows, parts and their moves as these fixtures give them, so a webhook fixture in gives exactly one outbox row and one send (BP section 10, D-017), counting a same-key retry as one send; the eval harness reads a committed effect row as a harmful wrong action (arch 08 line 447); each refuses every invalid one.",
  },
];

/** A README section from its heading to the line that ends it. */
function sectionOf(heading: string, end: string): string {
  const start = README.indexOf(heading);
  if (start === -1) throw new Error(`the README has no "${heading}"`);
  const stop = README.indexOf(end, start);
  if (stop === -1) throw new Error(`the README's "${heading}" has no "${end}"`);
  return README.slice(start, stop);
}
const SIDES_SECTION = sectionOf("## Producers and consumers (02-contracts K-07)", "- **Contract test**");
/** The README's "Contract test" line: this file's name and the statements the contract test makes. */
const CONTRACT_TEST_LINE = sectionOf("- **Contract test**", "\n");

/** A README list line ("- **Producers:** owner: components; owner: components."), each owner with its components. */
function ownersOf(label: string): Map<string, string> {
  const line = must(
    SIDES_SECTION.split("\n").find((candidate) => candidate.startsWith(`- **${label}:**`)),
    `the README's ${label} line`,
  );
  const owners = new Map<string, string>();
  for (const part of line.slice(`- **${label}:**`.length).split("; ")) {
    const at = part.indexOf(": ");
    owners.set(part.slice(0, at).trim(), part.slice(at + 2));
  }
  return owners;
}
const componentIds = (text: string): string[] => [...text.matchAll(/C-\d{3}/g)].map((match) => match[0]);

describe("outbox-effects sides: the list where each producer and consumer side is added", () => {
  it("names each side once, each with its owner, components and needs, each refusing every invalid one", () => {
    const ids = SIDE_CHECKS.map((side) => side.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SIDE_CHECKS.filter((side) => side.side === "producer").length).toBeGreaterThan(0);
    expect(SIDE_CHECKS.filter((side) => side.side === "consumer").length).toBeGreaterThan(0);
    for (const side of SIDE_CHECKS) {
      expect(side.owner, side.id).not.toBe("");
      expect(side.components.length, side.id).toBeGreaterThan(0);
      expect(side.needs, side.id).not.toBe("");
      expect(side.needs, side.id).toMatch(/refuses every invalid one/i);
    }
  });

  it("holds every owner of the README's producers and consumers as a side, each component under its owner", () => {
    for (const [label, kind] of [
      ["Producers", "producer"],
      ["Consumers", "consumer"],
    ] as const) {
      const owners = ownersOf(label);
      expect(owners.size, label).toBeGreaterThan(0);
      const sides = SIDE_CHECKS.filter((side) => side.side === kind);
      expect(sorted(sides.map((side) => side.owner)), label).toEqual(sorted([...owners.keys()]));
      for (const side of sides) {
        const listed = must(owners.get(side.owner), `${label}: ${side.owner}`);
        for (const component of side.components) expect(listed, side.id).toContain(component);
        expect(sorted(componentIds(side.components.join(" "))), side.id).toEqual(
          sorted(componentIds(listed)),
        );
      }
    }
  });

  it("names every component the README's producers and consumers list, and no other", () => {
    const named = new Set(componentIds(SIDES_SECTION));
    const held = new Set(SIDE_CHECKS.flatMap((side) => componentIds(side.components.join(" "))));
    expect(named.size).toBeGreaterThan(20);
    expect(sorted([...held])).toEqual(sorted([...named]));
  });

  it("is the file the README's contract test names, and holds each statement it makes: the moves here, the rest on the sides", () => {
    expect(
      fileURLToPath(import.meta.url)
        .split(path.sep)
        .join("/")
        .endsWith(THIS_FILE),
    ).toBe(true);
    expect(CONTRACT_TEST_LINE).toContain(`\`${THIS_FILE}\``);
    const statements = CONTRACT_TEST_LINE.slice(
      CONTRACT_TEST_LINE.indexOf(`${THIS_FILE}\`: `) + THIS_FILE.length + 3,
    )
      .replace(/\.\s*$/, "")
      .split("; ");
    expect(statements).toHaveLength(3);
    // The first is part 5's describe, word for word; each other is a side's, word for word.
    expect(must(statements[0])).toBe("every state move in the fixtures is allowed and no other");
    for (const statement of statements.slice(1))
      expect(
        SIDE_CHECKS.some((side) => side.needs.includes(statement)),
        `a side holds "${statement}"`,
      ).toBe(true);
  });

  for (const side of SIDE_CHECKS) {
    if (side.check === undefined) continue;
    const check = side.check;
    it(`${side.side} side ${side.id}`, () => {
      expect(check()).toEqual([]);
    });
  }
});
