// Contract test for K-15 v1, the Google Places port (T-094; ops/plan/02-contracts.md K-15 "Contract test" and section 2
// item 12; contracts/port-places/README.md "Producers and consumers (02-contracts K-15)" and its "Contract test" line,
// "The double", "Opening hours", "No name, address, phone or words in a span or log" and "Fixtures"; S1-09 design card
// 5, ops/reviews/s1-09-design/rule-s1-09.json; DL-1132).
//
// Two parts, as every contract test has them: the fixture part, which reads only the committed schemas, the README and
// the fixtures; and the sides, one per producer or consumer, held on SIDE_CHECKS (at the end). The Places double's side
// is added here, now that T-434's double is on main (S1-09 design card 5). The real adapter's side (T-435, after J-16)
// and the consumers' sides are held on SIDE_CHECKS with what each must show, for the QA side task that adds each.
//
// K-15 is frozen at v1 (T-024; frozen.json). Every entry of fixtures/index.json is checked against the schema its own
// version names. The checks pinned to one fixture (the mends of part 2, the span twins of part 4) and the double's side
// read v1's entries (WRITTEN_FOR), selected by version and by what they state (DL-124, DL-125), so a later minor
// version's fixtures join every generic check when they land, and its own pins join with its QA task.
//
// What this file proves:
//   1. every fixture in contracts/port-places/fixtures/index.json is checked against its $defs entry (the T-003 harness,
//      and again here): accepted ones are accepted, refused ones are refused, none is left out, and the number checked is
//      the number of entries; the index lists exactly the fixtures the README's "Fixtures" names, the plan's among them;
//      every definition the root names, and every answer each call can give, has an accepted fixture;
//   2. each refusal is tied to its one fault (DL-124's mend-then-accept proof): the refused fixture differs from the
//      accepted twin the README names only at its fault, the schema's errors point there, and put right as the README
//      says (the reviews, the rating or the email dropped; the phone in E.164; Google's periods as K-27 spans; the town
//      dropped from the span) it is accepted, and is that twin;
//   3. the schema is not vacuous: removing any one required field, at any depth, from a copy of an accepted fixture
//      makes the copy refused (the fields are read from the schemas' own `required` lists, along the branch the fixture
//      takes at each anyOf, oneOf and if), and so does a field the schema does not know, added to any object of it; the
//      check is shown firing on a copy of the schema that stops requiring a field;
//   4. what the schema leaves to the test (README "Producers and consumers", its "Contract test" line; "Opening hours"),
//      read from the fixtures, each also run on a damaged copy the schema still accepts, to show that it fires: each
//      opening-hours span opens before it closes, in day and time order, and no two spans of a day overlap; a found
//      listing's reference is the one asked; each candidate is listed once and is its own listing's fields; a span's got
//      and decided are its exchange's (candidates the number of candidates, listing the first one's reference, photos
//      the number of photos; an error's code and no decided); the error fixtures share their requests with answer
//      fixtures; span-search.json is K-08 v1's span-places-call.json; no span holds a name, address, phone, website,
//      category, town, photo text or photo credit;
//   5. the double's side (README "The double", "How a test drives the double"; T-434, C-218): it gives exactly the
//      exchange fixtures' answers for their requests, in either order; with an error set, that error (each error fixture
//      and each error the schema defines), then the answer again; noMatch for any other search and notFound for any
//      other reference; never a rating, a review or another field the port never gives, nor a refused fixture's outcome;
//      one span per call, which search.span or details.span accepts and whose got and decided are its call's, rebuilding
//      the span fixtures from their traces; no console line, and no span log line holding a name, address, phone,
//      website, category, town, photo text or photo credit. Each check is shown firing on a damaged double.
//   Not here (SIDE_CHECKS): the real adapter's side (T-435, after J-16: recorded vendor samples), and the consumers'
//   sides (T-635a's lookup and setup steps, C-187's registration screens, C-120's photo text).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

import {
  createPlacesDouble,
  type DetailsOutcome,
  type DetailsRequest,
  type HoursSpan,
  type Listing,
  type ListingCandidate,
  type PlacesCall,
  type PlacesError,
  type SearchOutcome,
  type SearchRequest,
} from "../../adapters/src/places/double";
import { spanLogLine, type OutsideCallSpan } from "../../adapters/src/shared/spans";
import { CONTRACTS_ROOT, describeContractFixtures, formatErrors, type FixtureEntry } from "./_harness";

// ---------------------------------------------------------------------------------------------------------------
// The contract's files

const NAME = "port-places";
const DIR = path.join(CONTRACTS_ROOT, NAME);
const FIXTURES_DIR = path.join(DIR, "fixtures");
/** Every schema's $id is this base plus its path inside contracts/ (ADR-005; contracts/scripts/lib.mjs). */
const ID_BASE = "https://rosie.invalid/contracts/";
/** This file, as the README's "Contract test" lines name it. */
const THIS_FILE = `tests/contract/${NAME}.v1.test.ts`;
/** The version this file's pinned proofs and the double's side were written for (DL-124, DL-125). */
const WRITTEN_FOR = "v1";

type Obj = Record<string, unknown>;
type Path = (string | number)[];

const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** A value a file must hold; a miss is a broken test, never a refusal. */
function must<T>(value: T | null | undefined, what = "a value this test reads"): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

const sorted = (values: readonly string[]): string[] => [...values].sort();

const README = readFileSync(path.join(DIR, "README.md"), "utf8");

/** The README's section that starts at `heading`, up to `end` (by default the next second-level heading). */
function readmeSection(heading: string, end = "\n## "): string {
  const start = README.indexOf(heading);
  if (start === -1) throw new Error(`the README has no section "${heading}"`);
  const stop = README.indexOf(end, start + heading.length);
  return README.slice(start, stop === -1 ? README.length : stop);
}

const index = readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: FixtureEntry[] };
const entries = index.fixtures;
const versions = [...new Set(entries.map((entry) => entry.version))];
const acceptedEntries = entries.filter((entry) => entry.expect === "accept");
const refusedEntries = entries.filter((entry) => entry.expect === "refuse");
const entryOf = (file: string): FixtureEntry =>
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

// What the checks read. The fixtures are checked against the schema first (part 1), so a cast to the double's own
// types (adapters/src/places/double/types.ts, which mirror the schema) reads only fields the schema gives them.
interface SearchExchange {
  call: "search";
  request: SearchRequest;
  outcome: SearchOutcome;
}
interface DetailsExchange {
  call: "details";
  request: DetailsRequest;
  outcome: DetailsOutcome;
}
type Exchange = SearchExchange | DetailsExchange;
type Outcome = SearchOutcome | DetailsOutcome;

/** A K-15 span as a fixture writes it (search.span or details.span, on K-08 v1's span). */
interface SpanFixture {
  trace_id: string;
  span_id: string;
  seq: number;
  at: string;
  bundle_id: { hash: string; build: number };
  turn_id: string | null;
  job_id: string | null;
  handle_ref: string | null;
  business_id: string | null;
  call: string;
  attempt: number;
  got: { step: string } & Obj;
  decided?: Obj;
  outcome: string;
  error_code: string | null;
}

const exchangeOf = (file: string): Exchange => fixture(file) as Exchange;
const spanOf = (file: string): SpanFixture => fixture(file) as SpanFixture;
const defIs = (entry: FixtureEntry, suffix: string): boolean => entry.def?.endsWith(suffix) === true;
const isError = (outcome: Outcome): outcome is PlacesError => "error" in outcome;
const candidatesOf = (outcome: Outcome): readonly ListingCandidate[] =>
  "candidates" in outcome ? outcome.candidates : [];
const listingOf = (outcome: Outcome): Listing | null => ("listing" in outcome ? outcome.listing : null);

const v1Accepted = acceptedEntries.filter((entry) => entry.version === WRITTEN_FOR);
/** v1's accepted exchange fixtures: the double's fixed answers, and the errors a test sets. */
const EXCHANGES = v1Accepted.filter((entry) => defIs(entry, ".exchange")).map((entry) => entry.file);
/** Those whose outcome is an answer: found, noMatch or notFound. */
const ANSWERS = EXCHANGES.filter((file) => !isError(exchangeOf(file).outcome));
/** Those whose outcome is an error. */
const ERRORS = EXCHANGES.filter((file) => isError(exchangeOf(file).outcome));
/** v1's accepted span fixtures. */
const SPANS = v1Accepted.filter((entry) => defIs(entry, ".span")).map((entry) => entry.file);
const v1Refused = refusedEntries.filter((entry) => entry.version === WRITTEN_FOR);

/** The searches v1's answer fixtures answer found. */
const FOUND_SEARCHES: SearchRequest[] = ANSWERS.map(exchangeOf).flatMap((fx) =>
  fx.call === "search" && candidatesOf(fx.outcome).length > 0 ? [fx.request] : [],
);
/** The listings v1's details fixtures give, by reference. */
const LISTINGS = new Map<string, Listing>(
  ANSWERS.map(exchangeOf).flatMap((fx) => {
    const listing = listingOf(fx.outcome);
    return listing === null ? [] : [[listing.listingRef, listing] as const];
  }),
);
/** The answer of v1's fixture for `call` whose result is `result` (no-match.json, details-not-found.json). */
function answerOf(call: string, result: string): Outcome {
  const found = ANSWERS.map(exchangeOf).find(
    (fx) => fx.call === call && "result" in fx.outcome && fx.outcome.result === result,
  );
  return must(found, `a ${call} fixture that answers ${result}`).outcome;
}
const NO_MATCH = answerOf("search", "noMatch");
const NOT_FOUND = answerOf("details", "notFound");

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

/** The schema files K-15's own schemas reach by $ref, transitively (contracts-relative), with their schemas. */
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
  for (const name of readdirSync(DIR).sort()) {
    if (name.endsWith(".schema.json")) visit(`${NAME}/${name}`);
  }
  return reached;
}

const SCHEMAS = reachedSchemas();
/** The folders whose schemas K-15's $refs reach (K-08's event-trace/ and what it reaches), with common/ for the index. */
const SHARED_FOLDERS = sorted([
  ...new Set(["common", ...[...SCHEMAS.keys()].map((file) => must(file.split("/")[0]))]),
]).filter((folder) => folder !== NAME);
/** Each loaded schema by its $id, for the required-field walk (part 3) and the error codes (part 5). */
const SCHEMA_BY_ID = new Map([...SCHEMAS.values()].map((schema) => [String(schema.$id), schema]));

// The strict Ajv 2020-12 setup of the harness (contracts/scripts/lib.mjs) for the checks; the same with every error, to
// read why a refused fixture is refused; and a loose one for the required-field walk, which compiles single branches of
// an anyOf, oneOf or if, where strict mode would miss the "type" their parent states.
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
function validatorOf(version: string, def: string | undefined, ajv: Ajv2020 = strictAjv): ValidateFunction {
  const key = def === undefined ? schemaIdOf(version) : `${schemaIdOf(version)}#/$defs/${def}`;
  return must(ajv.getSchema(key), `the schema ${key}`);
}
const validatorFor = (entry: FixtureEntry, ajv: Ajv2020 = strictAjv): ValidateFunction =>
  validatorOf(entry.version, entry.def, ajv);
/** v1's validator of one definition. */
const v1Def = (def: string): ValidateFunction => validatorOf(WRITTEN_FOR, def);

/** The lines of a refusal by v1's `def`, or none when it accepts the value. */
function refusedBy(def: string, value: unknown): string[] {
  const validate = v1Def(def);
  return validate(value) ? [] : [`K-15 v1 ${def} refuses it: ${formatErrors(validate.errors).join("; ")}`];
}

const V1_SCHEMA = must(SCHEMA_BY_ID.get(schemaIdOf(WRITTEN_FOR)), "K-15 v1's schema") as {
  anyOf: { $ref: string }[];
  $defs: Record<string, Obj>;
};
/** The errors K-15 v1 defines (placesError.error's enum). */
const ERROR_CODES = (
  must(V1_SCHEMA.$defs.placesError, "placesError") as {
    properties: { error: { enum: PlacesError["error"][] } };
  }
).properties.error.enum;

// Compile every validator the checks call while the file loads, so no single test carries Ajv's compile time on a
// loaded machine (a resource guard, not part of any check). A schema that cannot be had is left to its entry's test.
for (const entry of entries) {
  try {
    validatorFor(entry);
    validatorFor(entry, explainAjv);
  } catch {
    // Reported by the entry's own test, which calls validatorFor again.
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Paths into a JSON value

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

/** Removes the property at `where` from `value` itself. */
function drop(value: unknown, where: Path): void {
  Reflect.deleteProperty(getAt(value, where.slice(0, -1)) as object, must(where.at(-1)));
}

/** A copy of `value` without the property at `where`. */
function without(value: unknown, where: Path): unknown {
  const copy = structuredClone(value);
  drop(copy, where);
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
    return a.flatMap((item: unknown, k) => differences(item, b[k], [...at, k]));
  return isDeepStrictEqual(a, b) ? [] : [at];
}

const keyOf = (where: Path): string => JSON.stringify(where);

/** Every property name at any depth of a value. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item: unknown) => keysOf(item));
  if (isObj(value)) return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
  return [];
}

/** The path of every object in a value, the value itself first when it is one. */
function objectPaths(value: unknown, at: Path = []): Path[] {
  if (Array.isArray(value)) return value.flatMap((item: unknown, k) => objectPaths(item, [...at, k]));
  if (!isObj(value)) return [];
  return [at, ...Object.entries(value).flatMap(([key, child]) => objectPaths(child, [...at, key]))];
}

// ---------------------------------------------------------------------------------------------------------------
// The required-field walk (part 3): the fields a schema requires of a value, read from the schemas' own `required`
// lists along the branch the value takes at each anyOf, oneOf and if.

/** A place in a loaded schema: the schema's $id and a JSON pointer into it. */
interface Place {
  doc: string;
  pointer: string;
}

const placeName = (place: Place): string => `${place.doc}#${place.pointer}`;

function nodeAt(place: Place, schemas: ReadonlyMap<string, Obj>): unknown {
  let node: unknown = must(schemas.get(place.doc), `the schema ${place.doc}`);
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
  const node = nodeAt(place, SCHEMA_BY_ID);
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
    node.allOf.forEach((_branch: unknown, k) => {
      addAll(requiredIn(childOf(place, "allOf", k), value, at));
    });
  for (const keyword of ["anyOf", "oneOf"]) {
    const branches: unknown = node[keyword];
    if (!Array.isArray(branches)) continue;
    const taken = branches
      .map((_branch: unknown, k) => childOf(place, keyword, k))
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
    for (const name of Array.isArray(node.required) ? (node.required as unknown[]) : []) {
      if (!present(name)) throw new Error(`${placeName(place)} requires ${String(name)} at ${pointerOf(at)}`);
      found.add(keyOf([...at, name]));
    }
    if (isObj(node.dependentRequired)) {
      for (const [name, names] of Object.entries(node.dependentRequired)) {
        if (!present(name) || !Array.isArray(names)) continue;
        for (const other of names as unknown[]) if (present(other)) found.add(keyOf([...at, other]));
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
function requiredPaths(entry: FixtureEntry, value: unknown): Path[] {
  const place: Place = {
    doc: schemaIdOf(entry.version),
    pointer: entry.def === undefined ? "" : pointerOf(["$defs", entry.def]),
  };
  return [...requiredIn(place, value, [])].map((key) => JSON.parse(key) as Path);
}

/** The required fields whose removal the validator still accepts: none, for a schema that is not vacuous. */
function vacuousPaths(validate: ValidateFunction, value: unknown, paths: readonly Path[]): string[] {
  return paths.filter((where) => validate(without(value, where))).map(pointerOf);
}

// ---------------------------------------------------------------------------------------------------------------
// Checks the schema leaves to code (README "Producers and consumers", its "Contract test" line; "Opening hours").
// Each returns one line per problem; an empty list means the check holds.

/** Minutes after midnight of an HH:MM time, 24:00 included. */
function minutesOf(time: string): number {
  const [hours = "", minutes = ""] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/** README "Opening hours": each span opens before it closes; the spans in day and time order; no two of a day overlap. */
export function checkHours(hours: readonly HoursSpan[] | null): string[] {
  if (hours === null) return [];
  const problems: string[] = [];
  hours.forEach((span, k) => {
    if (minutesOf(span.opensAt) >= minutesOf(span.closesAt))
      problems.push(
        `span ${String(k + 1)} (day ${String(span.weekday)}) opens at ${span.opensAt}, not before it closes at ${span.closesAt}`,
      );
    const next = hours[k + 1];
    if (
      next !== undefined &&
      (next.weekday < span.weekday ||
        (next.weekday === span.weekday && minutesOf(next.opensAt) < minutesOf(span.opensAt)))
    )
      problems.push(`span ${String(k + 2)} comes before span ${String(k + 1)}: not in day and time order`);
    hours.forEach((other, j) => {
      if (j <= k || other.weekday !== span.weekday) return;
      if (
        minutesOf(other.opensAt) < minutesOf(span.closesAt) &&
        minutesOf(span.opensAt) < minutesOf(other.closesAt)
      )
        problems.push(`spans ${String(k + 1)} and ${String(j + 1)} of day ${String(span.weekday)} overlap`);
    });
  });
  return problems;
}

/** One exchange: a found listing's reference is the one asked, with its hours as above; each candidate listed once. */
export function checkExchange(exchange: Exchange): string[] {
  const problems: string[] = [];
  const listing = listingOf(exchange.outcome);
  if (exchange.call === "details" && listing !== null) {
    if (listing.listingRef !== exchange.request.listingRef)
      problems.push(`details of ${exchange.request.listingRef} found the listing ${listing.listingRef}`);
    problems.push(...checkHours(listing.openingHours));
  }
  const refs = candidatesOf(exchange.outcome).map((candidate) => candidate.listingRef);
  for (const ref of new Set(refs.filter((candidate, k) => refs.indexOf(candidate) !== k)))
    problems.push(`the listing ${ref} is a candidate more than once`);
  return problems;
}

/** README "The double": each candidate is its own listing's name, address, phone and website, as details gives it. */
export function checkCandidates(exchange: Exchange, listings: ReadonlyMap<string, Listing>): string[] {
  return candidatesOf(exchange.outcome).flatMap((candidate) => {
    const listing = listings.get(candidate.listingRef);
    if (listing === undefined) return [`no details answer gives the candidate ${candidate.listingRef}`];
    const { listingRef, name, address, phone, website } = listing;
    return isDeepStrictEqual(candidate, { listingRef, name, address, phone, website })
      ? []
      : [`the candidate ${candidate.listingRef} is not its listing's name, address, phone and website`];
  });
}

/** What a K-15 span says, as a fixture or the double writes it. */
interface SpanLike {
  readonly call: string;
  readonly outcome: string;
  readonly error_code: string | null;
  readonly got?: Readonly<Obj>;
  readonly decided?: Readonly<Obj>;
}

/**
 * README "No name, address, phone or words in a span or log" and its "Contract test" line: a span's got is its request's
 * (searchBy, or the reference asked) and its decided is its answer's (the number of candidates and the first one's
 * reference; found or notFound and the number of photos); an error's span has its code as error_code, the outcome
 * failed or timedOut, and no decided.
 */
export function checkSpan(span: SpanLike, exchange: Exchange): string[] {
  const problems: string[] = [];
  const got = span.got ?? {};
  if (span.call !== exchange.call) problems.push(`a ${span.call} span for a ${exchange.call} call`);
  if (exchange.call === "search" && got.searchBy !== exchange.request.by)
    problems.push(
      `got.searchBy is ${JSON.stringify(got.searchBy)}, not the request's ${exchange.request.by}`,
    );
  if (exchange.call === "details" && got.listing !== exchange.request.listingRef)
    problems.push(
      `got.listing is ${JSON.stringify(got.listing)}, not the reference asked, ${exchange.request.listingRef}`,
    );
  const { outcome } = exchange;
  if (isError(outcome)) {
    if (span.decided !== undefined) problems.push("an error's span has decided");
    if (span.error_code !== outcome.error)
      problems.push(`error_code is ${JSON.stringify(span.error_code)}, not the error ${outcome.error}`);
    if (span.outcome !== "failed" && span.outcome !== "timedOut")
      problems.push(`an error's span has the outcome ${span.outcome}`);
    return problems;
  }
  if (span.outcome !== "ok") problems.push(`an answer's span has the outcome ${span.outcome}`);
  if (span.error_code !== null) problems.push(`an answer's span has the error_code ${span.error_code}`);
  const decided = span.decided ?? {};
  if (exchange.call === "search") {
    const candidates = candidatesOf(outcome);
    if (decided.candidates !== candidates.length)
      problems.push(
        `decided.candidates is ${JSON.stringify(decided.candidates)}, not the answer's ${String(candidates.length)}`,
      );
    const best = candidates[0]?.listingRef;
    if (decided.listing !== best)
      problems.push(
        `decided.listing is ${JSON.stringify(decided.listing)}, not the best candidate's ${JSON.stringify(best)}`,
      );
    return problems;
  }
  if (decided.result !== outcome.result)
    problems.push(`decided.result is ${JSON.stringify(decided.result)}, not the answer's ${outcome.result}`);
  const photos = listingOf(outcome)?.photos.length;
  if (decided.photos !== photos)
    problems.push(
      `decided.photos is ${JSON.stringify(decided.photos)}, not the listing's ${JSON.stringify(photos)}`,
    );
  return problems;
}

/**
 * The words no span or log line may hold (README "No name, address, phone or words in a span or log"): the request's
 * name, town and photo text, and the listing's name, address, phone (as written and as digits), website, categories and
 * photo credits.
 */
function wordsOf(exchanges: readonly Exchange[]): string[] {
  const words = exchanges.flatMap((exchange) => {
    const asked =
      exchange.call === "search"
        ? exchange.request.by === "nameAndTown"
          ? [exchange.request.name, exchange.request.town]
          : [exchange.request.text]
        : [];
    const listing = listingOf(exchange.outcome);
    const shown = [...candidatesOf(exchange.outcome), ...(listing === null ? [] : [listing])].flatMap(
      (found) => [
        found.name,
        found.address,
        ...(found.phone === null ? [] : [found.phone, found.phone.replace(/[^0-9]/g, "")]),
        ...(found.website === null ? [] : [found.website]),
      ],
    );
    const extra =
      listing === null
        ? []
        : [
            ...listing.categories,
            ...listing.photos.flatMap((photo) => photo.authors.map((author) => author.name)),
          ];
    return [...asked, ...shown, ...extra];
  });
  return [...new Set(words)];
}

/** One line for each of `words` that `text` holds. */
export function checkWords(text: string, words: readonly string[]): string[] {
  return words.filter((word) => text.includes(word)).map((word) => `holds ${JSON.stringify(word)}`);
}

// ---------------------------------------------------------------------------------------------------------------
// The refused fixtures' twins and mends (part 2), as the README's "Fixtures" and the index's `shows` state them for v1

/**
 * README "The double": the cast's listing numbers are kept in E.164 by their last four digits, in the fiction range
 * 555-0100 to 555-0199, as K-23 v1's seed keeps them: (555) 010-0177 is kept with the exchange 555 and its last four.
 */
function castE164(national: string): string {
  const digits = national.replace(/[^0-9]/g, "");
  return `+1${digits.slice(0, 3)}555${digits.slice(-4)}`;
}

interface GooglePoint {
  day: number;
  hour: number;
  minute: number;
}
const hhmm = (point: GooglePoint): string =>
  `${String(point.hour).padStart(2, "0")}:${String(point.minute).padStart(2, "0")}`;

/**
 * README "Opening hours": Google's periods as K-27 spans. Google's day is 0 Sunday to 6 Saturday, the port's Sunday 7; a
 * period that closes on the next day at 00:00 closes at 24:00 on its own day (none of v1's periods runs past midnight).
 */
function spansOfPeriods(periods: readonly { open: GooglePoint; close: GooglePoint }[]): HoursSpan[] {
  return periods.map(({ open, close }) => {
    const nextMidnight = close.day === (open.day + 1) % 7 && close.hour === 0 && close.minute === 0;
    if (close.day !== open.day && !nextMidnight) throw new Error("a period past midnight is two spans");
    return {
      weekday: open.day === 0 ? 7 : open.day,
      opensAt: hhmm(open),
      closesAt: nextMidnight ? "24:00" : hhmm(close),
    };
  });
}

interface Mend {
  /** The accepted fixture it is, once its fault is removed (README "Fixtures"; the index's `shows`). */
  twin: string;
  /** Where its one fault is. */
  fault: Path;
  /** Puts the fault right in place, as the README says. */
  mend: (copy: unknown, fault: Path) => void;
}

const dropFault = (copy: unknown, fault: Path): void => {
  drop(copy, fault);
};

const MENDS: Record<string, Mend> = {
  "invalid/refuse-reviews-field.json": {
    twin: "details.json",
    fault: ["outcome", "listing", "reviews"],
    mend: dropFault,
  },
  "invalid/refuse-rating-field.json": {
    twin: "search-by-name.json",
    fault: ["outcome", "candidates", 0, "rating"],
    mend: dropFault,
  },
  "invalid/refuse-email-in-listing.json": {
    twin: "details.json",
    fault: ["outcome", "listing", "email"],
    mend: dropFault,
  },
  "invalid/refuse-phone-national-form.json": {
    twin: "search-by-name.json",
    fault: ["outcome", "candidates", 0, "phone"],
    mend: (copy, fault) => {
      setAt(copy, fault, castE164(String(getAt(copy, fault))));
    },
  },
  "invalid/refuse-vendor-hours.json": {
    twin: "details-lee-home-services.json",
    fault: ["outcome", "listing", "openingHours"],
    mend: (copy, fault) => {
      setAt(copy, fault, spansOfPeriods(getAt(copy, fault) as { open: GooglePoint; close: GooglePoint }[]));
    },
  },
  "invalid/refuse-town-in-span.json": {
    twin: "span-search.json",
    fault: ["got", "town"],
    mend: dropFault,
  },
};

/** The exchange each v1 span fixture is the span of (the index's `shows`: S1-09's search by name, S1-84's details). */
const SPAN_TWINS: Record<string, string> = {
  "span-search.json": "search-by-name.json",
  "span-details.json": "details.json",
};

/**
 * Fields K-15 v1 never gives (README "The listing's fields", "A listing never carries an email", "Opening hours"):
 * Google's rating, rating count and reviews, an email, the map point, the editorial summary, Google's phone and hours
 * fields; with every field a refused exchange fixture adds over its accepted twin.
 */
const NEVER_GIVEN = new Set([
  "rating",
  "userRatingCount",
  "reviews",
  "email",
  "location",
  "editorialSummary",
  "nationalPhoneNumber",
  "internationalPhoneNumber",
  "regularOpeningHours",
  "periods",
  "open",
  "close",
  ...Object.entries(MENDS).flatMap(([file, { twin }]) => {
    if (!file.includes("refuse-") || !defIs(entryOf(file), ".exchange")) return [];
    const twinKeys = new Set(keysOf(fixture(twin)));
    return keysOf(fixture(file)).filter((key) => !twinKeys.has(key));
  }),
]);

// ---------------------------------------------------------------------------------------------------------------
// The double's side (part 5): the double, and the checks of its side, each run on a factory so it can be shown firing on
// a damaged double

/** What the double's side reads: the port's two calls, the test-only error setting and the spans (README "The double"). */
interface DoubleUnderTest {
  search(request: unknown, call?: PlacesCall): Promise<SearchOutcome>;
  details(request: unknown, call?: PlacesCall): Promise<DetailsOutcome>;
  failNext(error: PlacesError): void;
  spans(): readonly OutsideCallSpan[];
}
/** A new double whose spans start at the clock's time. */
type MakeDouble = (now: () => string) => DoubleUnderTest;

/** T-434's double (adapters/src/places/double), on the clock the checks give it. */
const makeDouble: MakeDouble = (now) => createPlacesDouble({ now });
/** The clock the checks give a double: S1-09's search span's own time. */
const AT = spanOf("span-search.json").at;
const atSpanTime = (): string => AT;

function ask(double: DoubleUnderTest, exchange: Exchange, call?: PlacesCall): Promise<Outcome> {
  return exchange.call === "search"
    ? double.search(exchange.request, call)
    : double.details(exchange.request, call);
}

/** The call a span fixture's trace, step and try make, as the double takes them (never a field of the request). */
function traceOf(span: SpanFixture): PlacesCall {
  return {
    trace: {
      traceId: span.trace_id,
      spanId: span.span_id,
      seq: span.seq,
      bundleId: span.bundle_id,
      turnId: span.turn_id,
      jobId: span.job_id,
      handleRef: span.handle_ref,
      businessId: span.business_id,
    },
    step: span.got.step,
    attempt: span.attempt,
  };
}

/** Searches no v1 fixture answers found, made from v1's own requests and listings, each one the schema takes. */
function otherSearches(): SearchRequest[] {
  const towns = [
    ...new Set(FOUND_SEARCHES.flatMap((request) => (request.by === "nameAndTown" ? [request.town] : []))),
  ];
  const asked: SearchRequest[] = [];
  for (const request of FOUND_SEARCHES) {
    if (request.by === "nameAndTown") {
      asked.push(
        { ...request, name: request.name.toLowerCase() },
        { ...request, name: request.name.toUpperCase() },
        { ...request, name: `${request.name} ` },
        { ...request, town: `${request.town} ` },
        { by: "nameAndTown", name: request.town, town: request.name },
        { by: "photoText", text: request.name },
        { by: "photoText", text: `${request.name}, ${request.town}` },
        ...towns.filter((town) => town !== request.town).map((town): SearchRequest => ({ ...request, town })),
      );
    } else {
      const first = must(request.text.split(", ")[0]);
      asked.push(
        { ...request, text: request.text.toLowerCase() },
        { ...request, text: `${request.text}.` },
        { by: "photoText", text: first },
        ...towns.map((town): SearchRequest => ({ by: "nameAndTown", name: first, town })),
      );
    }
  }
  for (const listing of LISTINGS.values()) {
    const town = must(listing.address.split(", ").at(-1));
    asked.push(
      { by: "nameAndTown", name: listing.name, town },
      { by: "nameAndTown", name: listing.name.replace(/ LLC$/, ""), town },
      { by: "photoText", text: `${listing.name}, ${listing.address}` },
    );
  }
  for (const file of ANSWERS) {
    const fx = exchangeOf(file);
    if (fx.call === "search" && candidatesOf(fx.outcome).length === 0) asked.push(fx.request);
  }
  const valid = v1Def("search.request");
  const seen = new Set<string>();
  return asked.filter((request) => {
    const key = JSON.stringify(request);
    if (seen.has(key) || !valid(request) || FOUND_SEARCHES.some((found) => isDeepStrictEqual(found, request)))
      return false;
    seen.add(key);
    return true;
  });
}

/** The listing references the README's "The double" names: its three listings and K-09 v1's stand-in. */
const README_REFS = [
  ...new Set(
    [...readmeSection("## The double").matchAll(/`(places-[a-z0-9-]+)`/g)].map((match) => must(match[1])),
  ),
];

/** References no v1 details fixture answers found, each one the schema takes. */
function otherRefs(): string[] {
  const known = [...LISTINGS.keys()];
  const asked = [
    ...ANSWERS.map(exchangeOf).flatMap((fx) =>
      fx.call === "details" && listingOf(fx.outcome) === null ? [fx.request.listingRef] : [],
    ),
    ...README_REFS,
    ...known.flatMap((ref) => [ref.toUpperCase(), `${ref}-2`, ref.slice(0, -1), `${ref}/`]),
    ...[...LISTINGS.values()].flatMap((listing) => listing.photos.map((photo) => photo.photoRef)),
  ];
  const valid = v1Def("details.request");
  return [...new Set(asked)].filter((ref) => !known.includes(ref) && valid({ listingRef: ref }));
}

const OTHER_SEARCHES = otherSearches();
const OTHER_REFS = otherRefs();

/** README "How a test drives the double", a search and details: exactly each answer fixture's outcome, in either order. */
export async function checkDoubleAnswers(make: MakeDouble): Promise<string[]> {
  const problems: string[] = [];
  for (const order of [ANSWERS, [...ANSWERS].reverse()]) {
    const double = make(atSpanTime);
    for (const file of order) {
      const fixed = exchangeOf(file);
      const outcome = await ask(double, fixed);
      if (!isDeepStrictEqual(outcome, fixed.outcome))
        problems.push(`${file}: the double's answer is not the fixture's`);
      const given = { ...fixed, outcome } as Exchange;
      for (const line of [...refusedBy(`${fixed.call}.exchange`, given), ...checkExchange(given)])
        problems.push(`${file}: ${line}`);
    }
  }
  // Each candidate a found search gives answers details with its own listing (README "The double": its three listings).
  const double = make(atSpanTime);
  for (const request of FOUND_SEARCHES) {
    const outcome = await double.search(request);
    const listings = new Map<string, Listing>();
    for (const candidate of candidatesOf(outcome)) {
      const listing = listingOf(await double.details({ listingRef: candidate.listingRef }));
      if (listing !== null) listings.set(candidate.listingRef, listing);
    }
    for (const line of checkCandidates({ call: "search", request, outcome }, listings))
      problems.push(`the search ${JSON.stringify(request)}: ${line}`);
  }
  return [...new Set(problems)];
}

/**
 * README "An error": with an error fixture's outcome set, the call returns it, and the next call answers as the answer
 * fixture that shares its request does; so for each error K-15 v1 defines, on each call.
 */
export async function checkDoubleErrors(make: MakeDouble): Promise<string[]> {
  const problems: string[] = [];
  const answers = ANSWERS.map(exchangeOf);
  for (const file of ERRORS) {
    const failing = exchangeOf(file);
    if (!isError(failing.outcome)) continue;
    const twin = answers.find(
      (answer) => answer.call === failing.call && isDeepStrictEqual(answer.request, failing.request),
    );
    if (twin === undefined) {
      problems.push(`${file} shares its request with no answer fixture`);
      continue;
    }
    const double = make(atSpanTime);
    double.failNext(failing.outcome);
    if (!isDeepStrictEqual(await ask(double, failing), failing.outcome))
      problems.push(`${file}: with its error set, the call did not return it`);
    if (!isDeepStrictEqual(await ask(double, failing), twin.outcome))
      problems.push(`${file}: the call after the error did not answer as before`);
  }
  for (const code of ERROR_CODES) {
    for (const call of ["search", "details"] as const) {
      const fixed = must(
        answers.find((answer) => answer.call === call),
        `a ${call} answer fixture`,
      );
      const error: PlacesError = { error: code, retryAfterSeconds: null };
      const double = make(atSpanTime);
      double.failNext(error);
      const outcome = await ask(double, fixed);
      if (!isDeepStrictEqual(outcome, error))
        problems.push(`${code} set before a ${call}: the call did not return it`);
      for (const line of refusedBy(`${call}.exchange`, { ...fixed, outcome }))
        problems.push(`${code} set before a ${call}: ${line}`);
      if (!isDeepStrictEqual(await ask(double, fixed), fixed.outcome))
        problems.push(`${code} set before a ${call}: the call after it did not answer as before`);
    }
  }
  return problems;
}

/** README "How a test drives the double": any other search answers noMatch, any other reference notFound. */
export async function checkDoubleOthers(make: MakeDouble): Promise<string[]> {
  const problems: string[] = [];
  const double = make(atSpanTime);
  for (const request of OTHER_SEARCHES) {
    const outcome = await double.search(request);
    if (!isDeepStrictEqual(outcome, NO_MATCH))
      problems.push(`the search ${JSON.stringify(request)} answered ${JSON.stringify(outcome)}, not noMatch`);
  }
  for (const listingRef of OTHER_REFS) {
    const outcome = await double.details({ listingRef });
    if (!isDeepStrictEqual(outcome, NOT_FOUND))
      problems.push(`details of ${listingRef} answered ${JSON.stringify(outcome)}, not notFound`);
  }
  return problems;
}

/**
 * README "The listing's fields" (FS section 10: "Ratings and reviews from Google are not used"): no answer holds a field
 * the port never gives, and a refused exchange fixture's request gets the accepted answer, never the refused outcome.
 */
export async function checkDoubleNever(make: MakeDouble): Promise<string[]> {
  const problems: string[] = [];
  const double = make(atSpanTime);
  const given: [string, Outcome][] = [];
  for (const file of ANSWERS) given.push([file, await ask(double, exchangeOf(file))]);
  for (const entry of v1Refused.filter((candidate) => defIs(candidate, ".exchange"))) {
    const refused = exchangeOf(entry.file);
    const outcome = await ask(double, refused);
    if (isDeepStrictEqual(outcome, refused.outcome))
      problems.push(`${entry.file}: the double gave the refused outcome`);
    for (const line of refusedBy(`${refused.call}.exchange`, { ...refused, outcome }))
      problems.push(`${entry.file}: ${line}`);
    given.push([entry.file, outcome]);
  }
  for (const request of OTHER_SEARCHES) given.push([JSON.stringify(request), await double.search(request)]);
  for (const listingRef of OTHER_REFS) given.push([listingRef, await double.details({ listingRef })]);
  for (const [asked, outcome] of given) {
    for (const key of new Set(keysOf(outcome).filter((name) => NEVER_GIVEN.has(name))))
      problems.push(`${asked}: the answer holds ${key}`);
  }
  return problems;
}

/** The log context a span line is written with (ADR-009), as a staging gate would. */
const LOG = { level: "info", environment: "staging", version: "test-sha" } as const;

/**
 * README "Spans" and "No name, address, phone or words in a span or log": each call writes one span, which search.span
 * or details.span accepts and whose got and decided are its call's; the double writes no console line, and no span's
 * log line holds a name, address, phone, website, category, town, photo text or photo credit.
 */
export async function checkDoubleSpans(make: MakeDouble): Promise<string[]> {
  const problems: string[] = [];
  const spies = [
    vi.spyOn(console, "log").mockImplementation(() => undefined),
    vi.spyOn(console, "info").mockImplementation(() => undefined),
    vi.spyOn(console, "warn").mockImplementation(() => undefined),
    vi.spyOn(console, "error").mockImplementation(() => undefined),
    vi.spyOn(console, "debug").mockImplementation(() => undefined),
    vi.spyOn(console, "trace").mockImplementation(() => undefined),
  ];
  try {
    const double = make(atSpanTime);
    const asked: Exchange[] = [];
    for (const file of [...ANSWERS, ...ERRORS]) {
      const fixed = exchangeOf(file);
      if (isError(fixed.outcome)) double.failNext(fixed.outcome);
      asked.push({ ...fixed, outcome: await ask(double, fixed, { step: "S1-09" }) } as Exchange);
    }
    for (const request of OTHER_SEARCHES)
      asked.push({ call: "search", request, outcome: await double.search(request, { step: "S1-09" }) });
    for (const listingRef of OTHER_REFS) {
      const request = { listingRef };
      asked.push({ call: "details", request, outcome: await double.details(request, { step: "S1-84" }) });
    }
    const spans = double.spans();
    if (spans.length !== asked.length)
      problems.push(`${String(asked.length)} calls wrote ${String(spans.length)} spans`);
    spans.forEach((span, k) => {
      const exchange = asked[k];
      if (exchange === undefined) return;
      const where = `span ${String(k + 1)} (${exchange.call})`;
      const lines =
        span.call === "search" || span.call === "details"
          ? [...refusedBy(`${span.call}.span`, span), ...checkSpan(span, exchange)]
          : [`its call is ${span.call}`];
      for (const line of lines) problems.push(`${where}: ${line}`);
    });
    const written: string[] = [];
    for (const span of spans) {
      try {
        written.push(spanLogLine(span, LOG));
      } catch (error) {
        problems.push(
          `span ${span.span_id}'s log line is refused: ${error instanceof Error ? error.message : ""}`,
        );
      }
    }
    for (const line of checkWords(written.join("\n"), wordsOf(asked)))
      problems.push(`a span log line ${line}`);
    const lines = spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
    if (lines > 0) problems.push(`the double wrote ${String(lines)} console line(s)`);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return problems;
}

/**
 * README "Spans: the double writes each call's span as the adapter would": each span fixture, rebuilt from its trace,
 * step and try with its exchange's request, is the double's span, but for `ms` (the double answers at once) and an
 * `event_id` of null (no inbound event).
 */
export async function checkDoubleSpanFixtures(make: MakeDouble): Promise<string[]> {
  const problems: string[] = [];
  for (const file of SPANS) {
    const twin = SPAN_TWINS[file];
    if (twin === undefined) {
      problems.push(`${file} is the span of no exchange fixture`);
      continue;
    }
    const fixed = spanOf(file);
    const double = make(() => fixed.at);
    await ask(double, exchangeOf(twin), traceOf(fixed));
    const spans = double.spans();
    const [span] = spans;
    if (span === undefined || spans.length !== 1) {
      problems.push(`${file}: the call wrote ${String(spans.length)} spans`);
      continue;
    }
    const apart = differences(span, fixed)
      .map(pointerOf)
      .filter((where) => where !== "/ms" && where !== "/event_id");
    if (apart.length > 0) problems.push(`${file}: the double's span differs at ${apart.join(", ")}`);
    if (span.event_id !== null) problems.push(`${file}: the double's span names an inbound event`);
  }
  return problems;
}

/** The double's whole side, as SIDE_CHECKS runs it. */
const DOUBLE_CHECKS: readonly ((make: MakeDouble) => Promise<string[]>)[] = [
  checkDoubleAnswers,
  checkDoubleErrors,
  checkDoubleOthers,
  checkDoubleNever,
  checkDoubleSpans,
  checkDoubleSpanFixtures,
];

async function doubleSide(make: MakeDouble): Promise<string[]> {
  const problems: string[] = [];
  for (const check of DOUBLE_CHECKS) problems.push(...(await check(make)));
  return problems;
}

/** A double that is T-434's but for `change`, to show a side check firing. */
function damaged(change: (real: DoubleUnderTest) => Partial<DoubleUnderTest>): MakeDouble {
  return (now) => {
    const real = makeDouble(now);
    return {
      search: (request, call) => real.search(request, call),
      details: (request, call) => real.details(request, call),
      failNext: (error) => {
        real.failNext(error);
      },
      spans: () => real.spans(),
      ...change(real),
    };
  };
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Every fixture of the index, checked by the T-003 harness and again here

const report = describeContractFixtures(NAME, { sharedFolders: SHARED_FOLDERS });

describe("port-places.v1 fixtures: the index and the count", () => {
  it("checks as many fixtures as fixtures/index.json lists, none left out", () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(report.problems).toEqual([]);
    expect(report.entries.map((result) => result.file)).toEqual(entries.map((entry) => entry.file));
    expect(report.seedRows).toBe(0);
    expect(report.passes + report.refusals).toBe(entries.length);
    const onDisk = readdirSync(FIXTURES_DIR, { recursive: true, encoding: "utf8" })
      .map((file) => file.split(path.sep).join("/"))
      .filter((file) => file.endsWith(".json") && file !== "index.json");
    expect(sorted(onDisk)).toEqual(sorted(entries.map((entry) => entry.file)));
  });

  it("checks exactly as many fixtures as fixtures/index.json has entries, each by its own version's schema", () => {
    let checked = 0;
    for (const entry of entries) {
      expect(validatorFor(entry)(fixture(entry.file)), entry.file).toBe(entry.expect === "accept");
      checked += 1;
    }
    expect(checked).toBe(entries.length);
    expect(report.entries).toHaveLength(checked);
  });

  it("accepts every entry marked accept and refuses every entry marked refuse", () => {
    expect(report.passes).toBe(acceptedEntries.length);
    expect(report.refusals).toBe(refusedEntries.length);
    expect(refusedEntries.length, "the index refuses some fixtures").toBeGreaterThan(0);
    for (const result of report.entries) {
      expect(result.problems, result.file).toEqual([]);
      expect(result.outcome, result.file).toBe(result.expect === "accept" ? "accepted" : "refused");
    }
  });

  it("names a definition in every entry, checks it by its version's schema, and holds every version frozen.json names", () => {
    const frozen = (readJson(path.join(DIR, "frozen.json")) as { frozen: string[] }).frozen;
    expect(frozen).toContain(WRITTEN_FOR);
    for (const version of frozen) expect(versions, version).toContain(version);
    for (const entry of entries) {
      expect(entry.def, entry.file).toBeDefined();
      expect(must(SCHEMA_BY_ID.get(schemaIdOf(entry.version)), entry.file).$defs).toHaveProperty([
        must(entry.def),
      ]);
    }
    for (const result of report.entries)
      expect(result.schema, result.file).toBe(`${NAME}.${result.version}.schema.json`);
  });

  it("lists exactly the fixtures the README's 'Fixtures' names, the plan's four and its one refusal among them", () => {
    // The section's list paragraph ("Accepted: ... Refused, in `fixtures/invalid/`: ..."); the next names other
    // contracts' files (K-01's bundle-v0-skeleton.json).
    const section = readmeSection("## Fixtures");
    const list = section.slice(
      section.indexOf("Accepted:"),
      section.indexOf("\n\n", section.indexOf("Accepted:")),
    );
    expect(list.startsWith("Accepted:")).toBe(true);
    const named = [...list.matchAll(/`([a-z0-9-]+\.json)`/g)].map((match) => must(match[1]));
    const files = named.map((name) => (name.startsWith("refuse-") ? `invalid/${name}` : name));
    expect(new Set(files).size).toBe(files.length);
    expect(sorted(files)).toEqual(
      sorted(entries.filter((e) => e.version === WRITTEN_FOR).map((e) => e.file)),
    );
    // 02-contracts K-15 "Fixtures": search-by-name, search-by-photo-text, details, no-match; refused refuse-reviews-field.
    for (const file of [
      "search-by-name.json",
      "search-by-photo-text.json",
      "details.json",
      "no-match.json",
      "invalid/refuse-reviews-field.json",
    ])
      expect(files, file).toContain(file);
    for (const file of files)
      expect(file.startsWith("invalid/"), file).toBe(entryOf(file).expect === "refuse");
  });

  it("has an accepted fixture for every definition the root names and every answer and error each call gives", () => {
    const rootDefs = V1_SCHEMA.anyOf.map((branch) => branch.$ref.replace("#/$defs/", ""));
    expect(sorted(rootDefs)).toEqual(
      sorted(["search.exchange", "details.exchange", "search.span", "details.span"]),
    );
    expect(sorted([...new Set(v1Accepted.map((entry) => must(entry.def)))])).toEqual(sorted(rootDefs));
    for (const call of ["search", "details"]) {
      const response = must(V1_SCHEMA.$defs[`${call}.response`]) as { anyOf: { $ref: string }[] };
      const results = response.anyOf.map(
        (branch) =>
          (
            must(V1_SCHEMA.$defs[branch.$ref.replace("#/$defs/", "")]) as {
              properties: { result: { const: string } };
            }
          ).properties.result.const,
      );
      const given = EXCHANGES.map(exchangeOf).filter((fx) => fx.call === call);
      for (const result of results)
        expect(
          given.some((fx) => "result" in fx.outcome && fx.outcome.result === result),
          `${call} ${result}`,
        ).toBe(true);
      expect(
        given.some((fx) => isError(fx.outcome)),
        `${call} has an error fixture`,
      ).toBe(true);
    }
    expect(ANSWERS.length + ERRORS.length).toBe(EXCHANGES.length);
  });

  it("is the contract test the README names", () => {
    expect(README).toContain(`**Contract test:** \`${THIS_FILE}\``);
    expect(readmeSection("## Producers and consumers")).toContain(`\`${THIS_FILE}\``);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Each refused fixture is refused for its one fault

describe("port-places.v1 fixtures: each refused fixture is refused for its one fault, and put right is its twin", () => {
  it("holds a mend for every refused v1 fixture, and every mend names a refused fixture and an accepted twin", () => {
    expect(sorted(Object.keys(MENDS))).toEqual(sorted(v1Refused.map((entry) => entry.file)));
    for (const [file, { twin }] of Object.entries(MENDS)) {
      expect(entryOf(file).expect, file).toBe("refuse");
      expect(entryOf(twin).expect, twin).toBe("accept");
      expect(entryOf(twin).def, file).toBe(entryOf(file).def);
      // The index's own words name the twin (as "<twin>'s ..." or "(... it is <twin>)").
      expect(entryOf(file).shows, file).toContain(twin);
    }
  });

  for (const [file, { twin, fault, mend }] of Object.entries(MENDS)) {
    it(`${file}: differs from ${twin} only at ${pointerOf(fault)}; put right, it is accepted and is ${twin}`, () => {
      const entry = entryOf(file);
      const refused = fixture(file);
      expect(validatorFor(entry)(refused), `${file} is refused`).toBe(false);
      const apart = differences(refused, fixture(twin));
      expect(apart.length, `${file} differs from ${twin}`).toBeGreaterThan(0);
      for (const where of apart)
        expect(pointerOf(where).startsWith(pointerOf(fault)), `${file} differs at ${pointerOf(where)}`).toBe(
          true,
        );
      const explain = validatorFor(entry, explainAjv);
      explain(refused);
      const pointed = (explain.errors ?? []).map((error) =>
        error.keyword === "additionalProperties"
          ? `${error.instancePath}/${String(error.params.additionalProperty)}`
          : error.instancePath,
      );
      expect(
        pointed.some((where) => where.startsWith(pointerOf(fault))),
        `${file}: the schema's errors (${pointed.join(", ")}) point at ${pointerOf(fault)}`,
      ).toBe(true);
      const right = structuredClone(refused);
      mend(right, fault);
      const validate = validatorFor(entry);
      expect(validate(right), `${file} put right: ${formatErrors(validate.errors).join("; ")}`).toBe(true);
      expect(right).toEqual(fixture(twin));
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 3. The schema is not vacuous

describe("port-places.v1 fixtures: removing a required field, or adding an unknown one, makes an accepted fixture refused", () => {
  for (const entry of acceptedEntries) {
    it(`${entry.file} (${String(entry.def)})`, () => {
      const validate = validatorFor(entry);
      const original = fixture(entry.file);
      expect(validate(original), formatErrors(validate.errors).join("; ")).toBe(true);
      const required = requiredPaths(entry, original);
      expect(required.length, "the schema requires at least one field here").toBeGreaterThan(0);
      expect(
        vacuousPaths(validate, original, required),
        `${entry.file}: required fields whose removal passes`,
      ).toEqual([]);
      for (const at of objectPaths(original)) {
        const copy = structuredClone(original);
        (getAt(copy, at) as Obj).notInTheSchema = 1;
        expect(validate(copy), `${entry.file} with an unknown field at ${pointerOf(at) || "(root)"}`).toBe(
          false,
        );
      }
    });
  }

  it("reads the required fields at every depth: the request, the outcome, the listing, each span, photo and credit", () => {
    const required = requiredPaths(entryOf("details.json"), fixture("details.json")).map(pointerOf);
    for (const where of [
      "/call",
      "/request/listingRef",
      "/outcome/result",
      "/outcome/listing/photos",
      "/outcome/listing/phone",
      "/outcome/listing/openingHours/5/closesAt",
      "/outcome/listing/photos/2/authors/0/uri",
    ])
      expect(required, where).toContain(where);
    const search = requiredPaths(
      entryOf("search-by-photo-text.json"),
      fixture("search-by-photo-text.json"),
    ).map(pointerOf);
    expect(search).toContain("/request/text");
    expect(search).toContain("/outcome/candidates/0/website");
    const span = requiredPaths(entryOf("span-search.json"), fixture("span-search.json")).map(pointerOf);
    for (const where of [
      "/hop",
      "/provider",
      "/call",
      "/attempt",
      "/got",
      "/got/searchBy",
      "/decided/candidates",
    ])
      expect(span, where).toContain(where);
  });

  it("fires on a copy of the schema that stops requiring a listing's photos", () => {
    const loose = structuredClone(V1_SCHEMA) as unknown as {
      $id: string;
      $defs: Record<string, { required: string[] } | undefined>;
    };
    loose.$id = `${ID_BASE}${NAME}/${NAME}.v1-without-photos.schema.json`;
    const listing = must(loose.$defs.listing);
    listing.required = listing.required.filter((field) => field !== "photos");
    const ajv = new Ajv2020({ strict: true, strictRequired: false });
    for (const schema of SCHEMAS.values()) ajv.addSchema(structuredClone(schema));
    ajv.addSchema(loose);
    const validate = must(ajv.getSchema(`${loose.$id}#/$defs/details.exchange`));
    const details = fixture("details.json");
    const required = requiredPaths(entryOf("details.json"), details);
    expect(vacuousPaths(validate, details, required)).toEqual(["/outcome/listing/photos"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. What the schema leaves to the test, read from the fixtures

describe("port-places.v1 fixtures: what the schema leaves to the test", () => {
  it("holds for every accepted exchange fixture: hours in order with no overlap, the listing asked, each candidate once", () => {
    const files = acceptedEntries.filter((entry) => defIs(entry, ".exchange")).map((entry) => entry.file);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(checkExchange(exchangeOf(file)), file).toEqual([]);
    // Every listing among them has hours to check, so the check reads them.
    const hours = files.flatMap((file) => listingOf(exchangeOf(file).outcome)?.openingHours ?? []);
    expect(hours.length).toBeGreaterThan(0);
  });

  it("gives each found search's candidates the fields of the listing its details fixture gives", () => {
    expect(FOUND_SEARCHES.length).toBeGreaterThan(0);
    for (const file of ANSWERS) expect(checkCandidates(exchangeOf(file), LISTINGS), file).toEqual([]);
  });

  it("names the README's three listings in the details fixtures, and K-09 v1's stand-in in none", () => {
    expect(sorted(README_REFS.filter((ref) => LISTINGS.has(ref)))).toEqual(sorted([...LISTINGS.keys()]));
    expect(LISTINGS.size).toBe(3);
    expect(README_REFS.filter((ref) => !LISTINGS.has(ref))).toEqual(["places-double-lees-barbershop"]);
  });

  it("shares each error fixture's request with an answer fixture of the same call", () => {
    expect(ERRORS.length).toBeGreaterThan(0);
    for (const file of ERRORS) {
      const failing = exchangeOf(file);
      expect(
        ANSWERS.map(exchangeOf).some(
          (answer) => answer.call === failing.call && isDeepStrictEqual(answer.request, failing.request),
        ),
        file,
      ).toBe(true);
    }
  });

  it("gives each span fixture the got and decided of the exchange it is the span of", () => {
    expect(sorted(Object.keys(SPAN_TWINS))).toEqual(sorted(SPANS));
    for (const [file, twin] of Object.entries(SPAN_TWINS)) {
      expect(entryOf(file).shows, file).toMatch(/S1-09's search|S1-84's details/);
      expect(checkSpan(spanOf(file), exchangeOf(twin)), file).toEqual([]);
    }
  });

  it("has span-search.json be K-08 v1's span-places-call.json, word for word", () => {
    expect(fixture("span-search.json")).toEqual(
      readJson(path.join(CONTRACTS_ROOT, "event-trace", "fixtures", "span-places-call.json")),
    );
  });

  it("holds no name, address, phone, website, category, town, photo text or photo credit in any accepted span", () => {
    const words = wordsOf(EXCHANGES.map(exchangeOf));
    expect(words).toEqual(
      expect.arrayContaining(["Springfield", "Anytown", "Lee's Barbershop LLC", "Barber"]),
    );
    for (const entry of acceptedEntries.filter((candidate) => defIs(candidate, ".span")))
      expect(checkWords(JSON.stringify(fixture(entry.file)), words), entry.file).toEqual([]);
    // The refused span holds the town it searched, which the schema's closed list refuses (part 2).
    expect(checkWords(JSON.stringify(fixture("invalid/refuse-town-in-span.json")), words)).toEqual([
      'holds "Springfield"',
    ]);
  });

  it("fires on damaged copies the schema still accepts: hours out of order, overlapping or closing first", () => {
    const damage = (change: (copy: unknown) => void): DetailsExchange => {
      const copy = exchangeOf("details.json");
      change(copy);
      expect(v1Def("details.exchange")(copy), "the schema accepts the damaged copy").toBe(true);
      return copy as DetailsExchange;
    };
    const hours = ["outcome", "listing", "openingHours"];
    const closingFirst = damage((copy) => {
      setAt(copy, [...hours, 0, "opensAt"], "17:00");
      setAt(copy, [...hours, 0, "closesAt"], "09:00");
    });
    expect(checkExchange(closingFirst)).toEqual([
      "span 1 (day 1) opens at 17:00, not before it closes at 09:00",
    ]);
    const closingAtOnce = damage((copy) => {
      setAt(copy, [...hours, 5, "closesAt"], "10:00");
    });
    expect(checkExchange(closingAtOnce)).toEqual([
      "span 6 (day 6) opens at 10:00, not before it closes at 10:00",
    ]);
    const reversed = damage((copy) => {
      (getAt(copy, hours) as unknown[]).reverse();
    });
    expect(checkExchange(reversed)).toEqual(
      [1, 2, 3, 4, 5].map(
        (k) => `span ${String(k + 1)} comes before span ${String(k)}: not in day and time order`,
      ),
    );
    const overlapping = damage((copy) => {
      (getAt(copy, hours) as unknown[]).splice(1, 0, { weekday: 1, opensAt: "16:00", closesAt: "18:00" });
    });
    expect(checkExchange(overlapping)).toEqual(["spans 1 and 2 of day 1 overlap"]);
    const touching = damage((copy) => {
      (getAt(copy, hours) as unknown[]).splice(1, 0, { weekday: 1, opensAt: "17:00", closesAt: "24:00" });
    });
    expect(checkExchange(touching)).toEqual([]);
  });

  it("fires on damaged copies the schema still accepts: another listing found, a candidate twice or not its listing", () => {
    const other = exchangeOf("details.json");
    setAt(other, ["request", "listingRef"], "places-demo-yoga-studio");
    expect(v1Def("details.exchange")(other)).toBe(true);
    expect(checkExchange(other)).toEqual([
      "details of places-demo-yoga-studio found the listing places-demo-lees-barbershop",
    ]);
    const twice = exchangeOf("search-by-name.json");
    const candidates = getAt(twice, ["outcome", "candidates"]) as unknown[];
    candidates.push(structuredClone(candidates[0]));
    expect(v1Def("search.exchange")(twice)).toBe(true);
    expect(checkExchange(twice)).toEqual([
      "the listing places-demo-lees-barbershop is a candidate more than once",
    ]);
    const renamed = exchangeOf("search-yoga-studio.json");
    setAt(renamed, ["outcome", "candidates", 0, "website"], null);
    expect(v1Def("search.exchange")(renamed)).toBe(true);
    expect(checkCandidates(renamed, LISTINGS)).toEqual([
      "the candidate places-demo-yoga-studio is not its listing's name, address, phone and website",
    ]);
    const unknown = exchangeOf("search-yoga-studio.json");
    setAt(unknown, ["outcome", "candidates", 0, "listingRef"], "places-demo-test-mixed-shop-a");
    expect(checkCandidates(unknown, LISTINGS)).toEqual([
      "no details answer gives the candidate places-demo-test-mixed-shop-a",
    ]);
  });

  it("fires on damaged span copies the schema still accepts: decided or got that is not its exchange's, an error's decided", () => {
    const span = (file: string, change: (copy: SpanFixture) => void): SpanFixture => {
      const copy = spanOf(file);
      change(copy);
      expect(validatorFor(entryOf(file))(copy), `the schema accepts the damaged ${file}`).toBe(true);
      return copy;
    };
    const search = exchangeOf("search-by-name.json");
    const details = exchangeOf("details.json");
    expect(
      checkSpan(
        span("span-search.json", (copy) => {
          setAt(copy, ["decided", "candidates"], 2);
        }),
        search,
      ),
    ).toEqual(["decided.candidates is 2, not the answer's 1"]);
    expect(
      checkSpan(
        span("span-search.json", (copy) => {
          setAt(copy, ["decided", "listing"], "places-demo-yoga-studio");
        }),
        search,
      ),
    ).toEqual([
      'decided.listing is "places-demo-yoga-studio", not the best candidate\'s "places-demo-lees-barbershop"',
    ]);
    expect(
      checkSpan(
        span("span-search.json", (copy) => {
          setAt(copy, ["got", "searchBy"], "photoText");
        }),
        search,
      ),
    ).toEqual(['got.searchBy is "photoText", not the request\'s nameAndTown']);
    expect(
      checkSpan(
        span("span-details.json", (copy) => {
          setAt(copy, ["decided", "photos"], 2);
        }),
        details,
      ),
    ).toEqual(["decided.photos is 2, not the listing's 3"]);
    expect(
      checkSpan(
        span("span-details.json", (copy) => {
          setAt(copy, ["got", "listing"], "places-demo-yoga-studio");
        }),
        details,
      ),
    ).toEqual([
      'got.listing is "places-demo-yoga-studio", not the reference asked, places-demo-lees-barbershop',
    ]);
    const failed = span("span-details.json", (copy) => {
      copy.outcome = "failed";
      copy.error_code = "rateLimited";
    });
    expect(checkSpan(failed, exchangeOf("error-rate-limited.json"))).toEqual(["an error's span has decided"]);
    drop(failed, ["decided"]);
    expect(checkSpan(failed, exchangeOf("error-rate-limited.json"))).toEqual([]);
    expect(checkSpan(failed, details)).toEqual([
      "an answer's span has the outcome failed",
      "an answer's span has the error_code rateLimited",
      "decided.result is undefined, not the answer's found",
      "decided.photos is undefined, not the listing's 3",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. The producer side: the Places double (T-434; C-218; S1-09 design card 5)

describe("port-places.v1 producer side: the Places double", () => {
  it("is asked searches and references no v1 fixture answers found, each one the schema takes", () => {
    expect(OTHER_SEARCHES.length).toBeGreaterThan(FOUND_SEARCHES.length * 5);
    expect(OTHER_REFS.length).toBeGreaterThan(LISTINGS.size * 3);
    for (const request of OTHER_SEARCHES) {
      expect(v1Def("search.request")(request), JSON.stringify(request)).toBe(true);
      expect(FOUND_SEARCHES.some((found) => isDeepStrictEqual(found, request))).toBe(false);
    }
    for (const ref of OTHER_REFS) expect(LISTINGS.has(ref), ref).toBe(false);
    // T-434's handoff: S1-38's second company by its name and town has no search fixture, so it is no match.
    expect(OTHER_SEARCHES).toContainEqual({
      by: "nameAndTown",
      name: "Lee Home Services",
      town: "Springfield",
    });
    expect(OTHER_REFS).toContain("places-double-lees-barbershop");
  });

  it("gives exactly each answer fixture's outcome for its request, in either order, each candidate its own listing", async () => {
    expect(await checkDoubleAnswers(makeDouble)).toEqual([]);
  });

  it("gives each error fixture's outcome and each error K-15 v1 defines when the test sets it, then answers as before", async () => {
    expect(ERROR_CODES).toEqual(["unavailable", "rateLimited", "badRequest"]);
    expect(await checkDoubleErrors(makeDouble)).toEqual([]);
  });

  it("answers any other search noMatch and any other reference notFound, never an error", async () => {
    expect(NO_MATCH).toEqual({ result: "noMatch" });
    expect(NOT_FOUND).toEqual({ result: "notFound" });
    expect(await checkDoubleOthers(makeDouble)).toEqual([]);
  });

  it("never gives a rating, a review or another field the port never gives, nor a refused fixture's outcome", async () => {
    for (const key of ["rating", "reviews", "email", "open", "close"])
      expect(NEVER_GIVEN.has(key), key).toBe(true);
    expect(await checkDoubleNever(makeDouble)).toEqual([]);
  });

  it("writes one span per call that its def accepts, with its call's got and decided, and no console or span line holds words", async () => {
    expect(await checkDoubleSpans(makeDouble)).toEqual([]);
  });

  it("rebuilds each span fixture from its trace, step and try", async () => {
    expect(await checkDoubleSpanFixtures(makeDouble)).toEqual([]);
  });

  it("fires on a double that rates its candidates", async () => {
    const rated = damaged((real) => ({
      search: async (request, call) => {
        const outcome = await real.search(request, call);
        for (const candidate of candidatesOf(outcome)) Object.assign(candidate, { rating: 4.8 });
        return outcome;
      },
    }));
    const answers = await checkDoubleAnswers(rated);
    expect(answers).toContain("search-by-name.json: the double's answer is not the fixture's");
    expect(
      answers.some((line) => line.startsWith("search-by-name.json: K-15 v1 search.exchange refuses it")),
    ).toBe(true);
    expect(await checkDoubleNever(rated)).toContain("search-by-name.json: the answer holds rating");
  });

  it("fires on a double that matches a search loosely, or answers an unknown reference with an error", async () => {
    const loose = damaged((real) => ({
      search: async (request, call) => {
        const outcome = await real.search(request, call);
        const near = FOUND_SEARCHES.find(
          (found) => JSON.stringify(found).toLowerCase() === JSON.stringify(request).toLowerCase(),
        );
        return near === undefined ? outcome : real.search(near, call);
      },
    }));
    const lines = await checkDoubleOthers(loose);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines)
      expect(line).toMatch(/^the search .* answered \{"result":"found",.*, not noMatch$/);
    const erring = damaged((real) => ({
      details: async (request, call) => {
        const outcome = await real.details(request, call);
        return isDeepStrictEqual(outcome, NOT_FOUND)
          ? { error: "unavailable", retryAfterSeconds: null }
          : outcome;
      },
    }));
    const others = await checkDoubleOthers(erring);
    expect(others).toHaveLength(OTHER_REFS.length);
    expect(others).toContain(
      'details of places-double-lees-barbershop answered {"error":"unavailable","retryAfterSeconds":null}, not notFound',
    );
  });

  it("fires on a double that ignores the error the test sets", async () => {
    const deaf = damaged(() => ({
      failNext: () => undefined,
    }));
    const lines = await checkDoubleErrors(deaf);
    expect(lines).toContain("error-unavailable.json: with its error set, the call did not return it");
    expect(lines).toContain("error-rate-limited.json: with its error set, the call did not return it");
    expect(lines).toContain("badRequest set before a details: the call did not return it");
  });

  it("fires on a double whose spans miscount the candidates, or that writes a console line", async () => {
    const miscounting = damaged((real) => ({
      spans: () =>
        real.spans().map((span) => {
          const counted = span.decided?.candidates;
          return typeof counted === "number" && counted > 0
            ? { ...span, decided: { ...span.decided, candidates: counted + 1 } }
            : span;
        }),
    }));
    expect(
      (await checkDoubleSpans(miscounting)).filter((line) => line.endsWith("not the answer's 1")),
    ).toHaveLength(FOUND_SEARCHES.length);
    expect(await checkDoubleSpanFixtures(miscounting)).toEqual([
      "span-search.json: the double's span differs at /decided/candidates",
    ]);
    const chatty = damaged((real) => ({
      search: (request, call) => {
        console.info(JSON.stringify(request));
        return real.search(request, call);
      },
    }));
    expect(
      (await checkDoubleSpans(chatty)).filter((line) => /^the double wrote \d+ console line/.test(line)),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The sides: where each producer and consumer side is added

export interface SideCheck {
  id: string;
  side: "producer" | "consumer";
  owner: string;
  components: string;
  /** The task that adds this side's check (a QA side task, after that side's build task). */
  addedBy: string;
  needs: string;
  /** The side's check, once added; it returns one line per problem. */
  check?: () => Promise<string[]>;
}

/**
 * contracts/port-places/README.md "Producers and consumers (02-contracts K-15)" and its "Contract test" line. Each side
 * is added by a QA side task that depends on this task and on that side's build task: it fills `check`. Until then the
 * side is held here with what it must show, so none is forgotten. The double's side is filled now (S1-09 design card 5).
 */
export const SIDE_CHECKS: readonly SideCheck[] = [
  {
    id: "producer-double",
    side: "producer",
    owner: "integrations engineer",
    components: "C-218 Google Places",
    addedBy: "T-094 (this file), after T-434 (the double)",
    needs:
      "The double gives exactly the exchange fixtures' answers for their requests, noMatch for any other search and notFound for any other reference, each error the test sets and then the answer again, never a rating, a review or another field the port never gives; each call writes one span that search.span or details.span accepts, whose got and decided are its call's; no log line holds a name, address, phone, town, photo text or photo credit.",
    check: () => doubleSide(makeDouble),
  },
  {
    id: "producer-adapter",
    side: "producer",
    owner: "integrations engineer",
    components: "C-218 Google Places",
    addedBy: "T-435's QA side task (the real adapter), after J-16 (Q-24: the key, its project and billing)",
    needs:
      "The adapter, on recorded vendor samples, gives port-level answers the schema accepts (the README's fit rules: E.164 phones, K-27 hours from Google's periods, no candidate without a name or an address, an empty result as noMatch, NOT_FOUND as notFound); its field mask asks for no rating, review or other Enterprise + Atmosphere field; every span it writes passes search.span or details.span, with what the schema leaves to the test (decided's counts and reference); no log line holds a name, address, phone, town, photo text or photo credit, nor the key.",
  },
  {
    id: "consumer-action-layer",
    side: "consumer",
    owner: "action-layer engineer",
    components: "the Tool API's `lookupListing`, `SetupS1_09`",
    addedBy: "T-635a's QA side task (S1-09's settler and writer over the port)",
    needs:
      "lookupListing and S1-09's settler read every accepted search answer as the fixtures write it (found with its candidates, best first; noMatch to S1-76; an error to the placesUnavailable path) and the setup steps take details' prefill (S1-21's hours, S1-84's photos, the categories) for the owner to confirm, keeping only what the owner confirms and the listing's reference; each refuses every refused fixture.",
  },
  {
    id: "consumer-frontend",
    side: "consumer",
    owner: "frontend engineer",
    components: "C-187 registration screens 1 and 2",
    addedBy: "C-187's QA side task (registration screens 1 and 2, through K-21 and K-09)",
    needs:
      "Registration screens 1 and 2 show and confirm a found candidate's name, address, phone and website (B01, B03, B04, B05 [G]) as the search fixtures write them, and show no listing for noMatch.",
  },
  {
    id: "consumer-ai",
    side: "consumer",
    owner: "AI engineer",
    components: "C-120",
    addedBy: "T-669's QA side task (photo reading's K-15 search text, K-02 v1.3)",
    needs:
      "Photo reading's card or listing kind forms a photoText search the schema accepts (02-contracts K-02: the card fixture's search text is a valid K-15 search request), as search-by-photo-text.json's request writes it.",
  },
];

describe("port-places.v1 sides: the list where each producer and consumer side is added", () => {
  const listed = readmeSection("## Producers and consumers", "- **Contract test**");

  it("names each side once, with the producers and consumers of the README", () => {
    const ids = SIDE_CHECKS.map((side) => side.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SIDE_CHECKS.filter((side) => side.side === "producer")).toHaveLength(2);
    expect(SIDE_CHECKS.filter((side) => side.side === "consumer")).toHaveLength(3);
    for (const side of SIDE_CHECKS) {
      expect(side.owner, side.id).not.toBe("");
      expect(side.components, side.id).not.toBe("");
      expect(side.addedBy, side.id).not.toBe("");
      expect(side.needs, side.id).not.toBe("");
    }
    expect(SIDE_CHECKS.filter((side) => side.check !== undefined).map((side) => side.id)).toEqual([
      "producer-double",
    ]);
  });

  it("names every component the README's producers and consumers list, and no other", () => {
    const named = new Set(listed.match(/C-\d{3}/g));
    const held = new Set(SIDE_CHECKS.flatMap((side) => side.components.match(/C-\d{3}/g) ?? []));
    expect(sorted([...held])).toEqual(sorted([...named]));
    expect(sorted([...named])).toEqual(["C-120", "C-187", "C-218"]);
  });

  it("spells each side's owner and components as the README does", () => {
    for (const side of SIDE_CHECKS) {
      expect(listed, side.id).toContain(side.owner);
      for (const component of side.components.split(", ")) expect(listed, side.id).toContain(component);
    }
  });

  for (const side of SIDE_CHECKS) {
    if (side.check === undefined) continue;
    const check = side.check;
    it(`${side.side} side ${side.id}`, async () => {
      expect(await check()).toEqual([]);
    });
  }
});
