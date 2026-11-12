// Contract test for K-04 v1, the database schema's core part (T-083; ops/plan/02-contracts.md K-04 "Contract test" and
// section 2 item 12; contracts/db-schema/core/README.md "Database rules beyond the table list", "Seed and refused-row
// fixtures", "Producers and consumers").
//
// This is the fixture part. The contract test has two parts: this one, which reads only the committed table list, its
// README and its fixtures, and one part per producer or consumer side, added later by a QA side task that depends on this
// task and on that side's build task. SIDE_CHECKS (at the end) is the list where each side is added.
//
// K-04's fixtures are seed rows and refused rows. Every entry of fixtures/index.json names its `table`, so the T-003
// harness counts it as a seed row and leaves it to this test (common/fixtures-index.meta.schema.json, `table`). The
// schema an entry names is the table list of its version, core.<version>.tables.json: v1 now; a later minor version
// brings its own list and its own entries, each checked against its own list. This file holds v1 and every later
// additive minor version's fixtures (as DL-124 settled for K-06; DL-181): a check of all of a version's fixtures loads
// the accepted fixtures of every version up to it first, and SQL a later version adds is read only with that version's
// own list, so v1's checks still pass when v1.1 comes. The contract project has no database
// (migrating one is the database engineer's side, on SIDE_CHECKS), so this file holds a model of a table list that loads
// a fixture as PostgreSQL would and refuses with the SQLSTATE and the constraint PostgreSQL names: column types in the
// README's input forms, not null and defaults, the primary key, unique keys (partial ones too), foreign keys, CHECK and
// EXCLUDE (their SQL read by a small evaluator that fails loudly on SQL it cannot read), and the README's rules the list
// has no place for. A value outside the README's input forms is refused with the code `form`, never a SQLSTATE: that
// rule is the README's, not PostgreSQL's.
//
// What this part proves:
//   1. every fixture in contracts/db-schema/core/fixtures/index.json is checked against the table list of its version:
//      each accepted fixture loads (alone with its `after` chain, and all of a version's together, so every table gets
//      rows); each refused fixture loads its `after` chain and its action is refused as its `expect` says; none is left
//      out;
//   2. each refusal is tied to its reason: put right as the README says (a time that does not overlap, taken = 10, a new
//      turn id, the barbershop's own scope; the event log's change written as a new row), the same action passes;
//   3. the table list is not vacuous: removing any one required column (not null, no default) from a row of a copy of an
//      accepted fixture makes the copy refused for that column, and so does a column the table does not know; removing a
//      field the README's file format requires makes the file refused; damaged copies that break one CHECK, unique key,
//      foreign key, EXCLUDE or input form are refused by the one each breaks;
//   4. what the table list cannot express, modeled here from the README, each also run on a damaged copy to show that it
//      fires: every update of a versioned table raising its version by one (rule 2, refused as the producer's migration
//      0002 refuses it), row-level security per business (rule 4), the event log never edited (rule 5), the file format,
//      the queue order of waiting rows, a class session's taken seats, the versions an open question or outbox row read,
//      the outbox row's plan and final parts as K-03 v1's rowPlan and finalParts (the open question's options as K-03's)
//      and its channel list as K-03 v1's, and the cast's phone numbers (555-01xx) and emails (example.com; rule 9);
//   5. v1.1 (T-1290; README section "v1.1"): each v1.1 refused fixture refused for its one reason and, put right as the
//      README puts it (db-schema.core.twins.ts), passing; each constraint v1.1 adds the one reason of one of them; v1.1
//      only adding to v1; and every v1 case (each refused fixture and its mend, each damaged copy, a row without its
//      turn id) holding under v1.1's list as under v1's. Its database side is db-schema.core.v1.db-side.test.ts.
//   What needs a producer or consumer side is on SIDE_CHECKS, not checked here: a freshly migrated PostgreSQL schema
//   compared with the table list, the seeds loaded into it and the refused rows refused there, and each consumer's reads
//   and writes through K-05.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { CONTRACTS_ROOT, checkContractFixtures, formatErrors, type FixtureEntry } from "./_harness";
import { PUT_RIGHT_V1_1, putRight } from "./db-schema.core.twins";

// ---------------------------------------------------------------------------------------------------------------
// The contract's files

const CORE_DIR = path.join(CONTRACTS_ROOT, "db-schema", "core");
const FIXTURES_DIR = path.join(CORE_DIR, "fixtures");

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** A value a file must hold; a miss is a broken test, never a refusal. */
function must<T>(value: T | null | undefined, what = "a value this test reads"): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

const index = readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: FixtureEntry[] };
const entries = index.fixtures;
const versions = [...new Set(entries.map((entry) => entry.version))];
const ofVersion = (version: string, expectation: "accept" | "refuse"): FixtureEntry[] =>
  entries.filter((entry) => entry.version === version && entry.expect === expectation);
const acceptedEntries = entries.filter((entry) => entry.expect === "accept");
const refusedEntries = entries.filter((entry) => entry.expect === "refuse");

/** A version's major and minor number: v1 is [1, 0], v1.1 is [1, 1]. */
function placeOf(version: string): [number, number] {
  const match = /^v(\d+)(?:\.(\d+))?$/.exec(version);
  if (match === null) throw new Error(`the index names a version this test cannot place: ${version}`);
  return [Number(match[1]), Number(match[2] ?? "0")];
}

/**
 * The index's versions at or before `version` within its major version, in order (for v1.1: v1, then v1.1). An additive
 * minor version adds to the tables before it, so its fixtures load after the earlier versions' (DL-124, DL-181).
 */
function versionsUpTo(version: string): string[] {
  const [major, minor] = placeOf(version);
  const placed = versions.map((candidate) => ({ candidate, place: placeOf(candidate) }));
  return placed
    .filter(({ place }) => place[0] === major && place[1] <= minor)
    .sort((a, b) => a.place[1] - b.place[1])
    .map(({ candidate }) => candidate);
}

/** The accepted entries of every version up to `version`, the earlier versions' first, each version's in index order. */
const acceptedUpTo = (version: string): FixtureEntry[] =>
  versionsUpTo(version).flatMap((each) => ofVersion(each, "accept"));

type Role = "runtime" | "toolApi";

/** What a refused action must meet (README "Seed and refused-row fixtures"). */
interface Expect {
  sqlstate?: string;
  constraintOneOf?: string[];
  rows?: number;
}

/** A refused fixture's one action, run as `role` under `scope`. */
interface Action {
  role: Role;
  scope: { businessId: string } | null;
  action: "insert" | "update" | "select";
  table: string;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
  where?: Record<string, unknown>;
  expect: Expect;
}

/** A fixture file (README "Seed and refused-row fixtures"): rows loaded after the fixtures `after` names. */
interface FixtureFile {
  after: string[];
  rows: { table: string; values: Record<string, unknown> }[];
  refused?: Action;
}

const fixtureOf = (file: string): FixtureFile =>
  readJson(path.join(FIXTURES_DIR, ...file.split("/"))) as FixtureFile;

// The README's file format, as a schema (the README states it in words and one example; the table list has no place
// for it). A refused action is one insert (values), update (set, where) or select (where), with a scope for a Tool API
// call and none for the runtime side.
const IDENTIFIER = "^[a-z_][a-z0-9_]*$";
const columnValues = { type: "object", propertyNames: { type: "string", pattern: IDENTIFIER } };
const FIXTURE_FILE_SCHEMA = {
  type: "object",
  properties: {
    after: {
      type: "array",
      items: { type: "string", pattern: "^[A-Za-z0-9_.-]+([/][A-Za-z0-9_.-]+)*[.]json$" },
      uniqueItems: true,
    },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: { table: { type: "string", pattern: IDENTIFIER }, values: columnValues },
        required: ["table", "values"],
        additionalProperties: false,
      },
    },
    refused: {
      type: "object",
      properties: {
        role: { enum: ["toolApi", "runtime"] },
        scope: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              properties: { businessId: { type: "string", minLength: 1 } },
              required: ["businessId"],
              additionalProperties: false,
            },
          ],
        },
        action: { enum: ["insert", "update", "select"] },
        table: { type: "string", pattern: IDENTIFIER },
        values: columnValues,
        set: { ...columnValues, minProperties: 1 },
        where: { ...columnValues, minProperties: 1 },
        expect: {
          oneOf: [
            {
              type: "object",
              properties: {
                sqlstate: { type: "string", pattern: "^[0-9A-Z]{5}$" },
                constraintOneOf: {
                  type: "array",
                  items: { type: "string", pattern: IDENTIFIER },
                  minItems: 1,
                  uniqueItems: true,
                },
              },
              required: ["sqlstate"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { rows: { type: "integer", minimum: 0 } },
              required: ["rows"],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ["role", "scope", "action", "table", "expect"],
      additionalProperties: false,
      allOf: [
        {
          if: { properties: { action: { const: "insert" } } },
          then: { required: ["values"], not: { anyOf: [{ required: ["set"] }, { required: ["where"] }] } },
        },
        {
          if: { properties: { action: { const: "update" } } },
          then: { required: ["set", "where"], not: { required: ["values"] } },
        },
        {
          if: { properties: { action: { const: "select" } } },
          then: { required: ["where"], not: { anyOf: [{ required: ["values"] }, { required: ["set"] }] } },
        },
        {
          if: { properties: { role: { const: "toolApi" } } },
          then: { properties: { scope: { type: "object" } } },
          else: { properties: { scope: { type: "null" } } },
        },
      ],
    },
  },
  required: ["after", "rows"],
  additionalProperties: false,
};
const checkFileFormat = new Ajv2020({ strict: true, strictRequired: false, allErrors: true }).compile(
  FIXTURE_FILE_SCHEMA,
);

/** The file-format problems of a fixture file, one line each; empty when it is in the README's format. */
function formatProblems(file: unknown): string[] {
  return checkFileFormat(file) ? [] : formatErrors(checkFileFormat.errors);
}

// ---------------------------------------------------------------------------------------------------------------
// The table list (contracts/db-schema/tables.meta.schema.json)

interface Column {
  name: string;
  type: string;
  null: boolean;
  default?: string;
}
interface UniqueKey {
  name?: string;
  columns: string[];
  where?: string;
}
interface Table {
  name: string;
  columns: Column[];
  primaryKey: string[];
  foreignKeys?: { name?: string; columns: string[]; references: { table: string; columns: string[] } }[];
  unique?: UniqueKey[];
  exclude?: {
    name: string;
    using: string;
    elements: { column?: string; expression?: string; operator: string }[];
    where?: string;
  }[];
  checks?: { name: string; expression: string }[];
  rowLevelSecurity: { scope: "business"; column: string } | { scope: "none"; why: string };
  versioned: boolean;
  versionColumn?: string;
}
interface TableList {
  part: string;
  version: string;
  tables: Table[];
}

const listFile = (version: string): string => path.join(CORE_DIR, `core.${version}.tables.json`);
const lists = new Map<string, TableList>();
function tableListOf(version: string): TableList {
  const known = lists.get(version);
  if (known !== undefined) return known;
  const list = readJson(listFile(version)) as TableList;
  lists.set(version, list);
  return list;
}
const tableOf = (list: TableList, name: string): Table =>
  must(
    list.tables.find((table) => table.name === name),
    `table ${name}`,
  );

/** PostgreSQL's names for a key that names none. */
const primaryKeyName = (table: string): string => `${table}_pkey`;
const uniqueName = (table: string, key: UniqueKey): string =>
  key.name ?? `${table}_${key.columns.join("_")}_key`;

// ---------------------------------------------------------------------------------------------------------------
// Values, read from the README's input forms

interface Ts {
  kind: "ts";
  ms: number;
}
interface TimeOfDay {
  kind: "time";
  seconds: number;
}
interface TsRange {
  kind: "range";
  lower: number | null;
  upper: number | null;
  lowerInc: boolean;
  upperInc: boolean;
  empty: boolean;
}
interface Jsonb {
  kind: "jsonb";
  value: unknown;
}
type Tagged = Ts | TimeOfDay | TsRange | Jsonb;
type Value = null | string | number | boolean | string[] | Uint8Array | Tagged;
type Row = Record<string, Value>;

const isTagged = (value: Value): value is Tagged =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);

/**
 * A refusal as PostgreSQL reports it: its SQLSTATE and, for a constraint or a column, its name. A value not in the
 * README's input form carries the code FORM instead, which is not a SQLSTATE: that rule is the README's, and
 * PostgreSQL alone might take the value (a timestamptz in another zone, a bytea in escape form, an array as '{a,b}').
 */
export class DbError extends Error {
  constructor(
    readonly sqlstate: string,
    message: string,
    readonly constraint: string | null = null,
    readonly column: string | null = null,
  ) {
    super(`${sqlstate} ${message}`);
  }
}

/** The code of a refusal by the README's input forms (README "Seed and refused-row fixtures"); not a SQLSTATE. */
const FORM = "form";

const TS_FORM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const TIME_FORM = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/;
const INTEGER_TEXT = /^\s*[+-]?\d+\s*$/;
const RANGE_FORM = /^([[(])([^,]*),([^,]*)([\])])$/;
const BYTEA_FORM = /^\\x(?:[0-9a-fA-F]{2})*$/;

const bytesOfHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/[0-9a-fA-F]{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
const hexOfBytes = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** README: a timestamptz is written in UTC, ending in Z (FORM); a date that does not exist is PostgreSQL's 22008. */
function timestampOf(text: string, where: string): number {
  if (!TS_FORM.test(text))
    throw new DbError(FORM, `${where}: ${JSON.stringify(text)} is not a timestamptz in UTC ending in Z`);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== text.slice(0, 19))
    throw new DbError("22008", `${where}: date/time field value out of range: ${JSON.stringify(text)}`);
  return ms;
}

/** PostgreSQL's boolean input: a prefix of true, false, yes or no; on, off or of; 1 or 0 (case and spaces aside). */
function booleanOfText(text: string): boolean | null {
  const word = text.trim().toLowerCase();
  const prefixOf = (full: string, least = 1): boolean => word.length >= least && full.startsWith(word);
  if (prefixOf("true") || prefixOf("yes") || prefixOf("on", 2) || word === "1") return true;
  if (prefixOf("false") || prefixOf("no") || prefixOf("off", 2) || word === "0") return false;
  return null;
}

/**
 * A fixture value read as the column's type. README: values are PostgreSQL text input for the column's type (a
 * tstzrange as [start,end), a bytea as \x and hex, a timestamptz in UTC ending in Z), except jsonb (JSON) and text[] (a
 * JSON array); null is SQL null. A JSON number or boolean is its text. A value PostgreSQL refuses is refused with its
 * SQLSTATE, one outside the README's forms with FORM, and one the model cannot read fails the test loudly.
 */
function inputOf(type: string, raw: unknown, where: string): Value {
  if (raw === null) return null;
  const refuse = (code: string, what: string): never => {
    throw new DbError(code, `${where}: ${JSON.stringify(raw)} is not ${what}`);
  };
  const unread = (what: string): never => {
    throw new Error(`${where}: the model reads ${type} input only as ${what}, not ${JSON.stringify(raw)}`);
  };
  switch (type) {
    case "text":
      if (typeof raw === "string") return raw;
      return typeof raw === "number" || typeof raw === "boolean"
        ? String(raw)
        : unread("JSON text, number or boolean");
    case "integer":
    case "bigint": {
      if (typeof raw !== "number" && (typeof raw !== "string" || !INTEGER_TEXT.test(raw)))
        return unread("a JSON number or decimal digits");
      const number = Number(raw);
      if (!Number.isInteger(number)) return refuse("22P02", `valid input for type ${type}`);
      if (type === "integer" && Math.abs(number) > 2_147_483_647)
        return refuse("22003", "in range for type integer");
      return Number.isSafeInteger(number) ? number : unread("a safe integer");
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (typeof raw !== "string") return unread("a JSON boolean or text");
      return booleanOfText(raw) ?? refuse("22P02", "valid input for type boolean");
    }
    case "timestamptz":
      return typeof raw === "string"
        ? { kind: "ts", ms: timestampOf(raw, where) }
        : refuse(FORM, "a timestamptz in UTC ending in Z");
    case "time": {
      const match = typeof raw === "string" ? TIME_FORM.exec(raw) : null;
      if (match === null) return unread("HH:MM or HH:MM:SS");
      const [hours, minutes, seconds] = [Number(match[1]), Number(match[2]), Number(match[3] ?? "0")];
      if (hours > 24 || (hours === 24 && minutes + seconds > 0)) return refuse("22008", "a time of day");
      return { kind: "time", seconds: hours * 3600 + minutes * 60 + seconds };
    }
    case "tstzrange": {
      const match = typeof raw === "string" ? RANGE_FORM.exec(raw) : null;
      if (match === null) return refuse(FORM, "a tstzrange written [start,end)");
      const [, open, from = "", to = "", close] = match;
      const lower = from === "" ? null : timestampOf(from, where);
      const upper = to === "" ? null : timestampOf(to, where);
      if (lower !== null && upper !== null && lower > upper)
        throw new DbError(
          "22000",
          `${where}: range lower bound must be less than or equal to range upper bound`,
        );
      const lowerInc = open === "[" && lower !== null;
      const upperInc = close === "]" && upper !== null;
      const empty = lower !== null && lower === upper && !(lowerInc && upperInc);
      return { kind: "range", lower, upper, lowerInc, upperInc, empty };
    }
    case "jsonb":
      return { kind: "jsonb", value: structuredClone(raw) };
    case "text[]":
      return Array.isArray(raw) && raw.every((item) => typeof item === "string")
        ? [...raw]
        : refuse(FORM, "a JSON array of text");
    case "bytea":
      return typeof raw === "string" && BYTEA_FORM.test(raw)
        ? bytesOfHex(raw.slice(2))
        : refuse(FORM, "a bytea written \\x and hex");
    default:
      throw new Error(`${where}: the model reads no input of type ${type}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The SQL the table list holds (CHECK expressions, unique and EXCLUDE predicates, defaults), read and evaluated with
// SQL's three-valued logic. Only what the list uses is read; anything else fails loudly, so nothing passes unread.

type Node =
  | { op: "literal"; value: Value }
  | { op: "column"; name: string }
  | { op: "or" | "and"; args: Node[] }
  | { op: "not"; arg: Node }
  | { op: "isNull"; arg: Node; negated: boolean }
  | { op: "compare"; operator: string; left: Node; right: Node }
  | { op: "in"; arg: Node; list: Node[]; negated: boolean }
  | { op: "between"; arg: Node; low: Node; high: Node; negated: boolean }
  | { op: "concat" | "match"; left: Node; right: Node }
  | { op: "cast"; arg: Node; type: string }
  | { op: "call"; name: string; args: Node[] };

const TOKEN = String.raw`\s*('(?:[^']|'')*'|\d+|[a-z_][a-z0-9_]*|\|\||::|<=|>=|<>|!=|[=<>~(),])`;
const COMPARISONS = new Set(["=", "<>", "!=", "<", ">", "<=", ">="]);

function tokensOf(sql: string): string[] {
  const pattern = new RegExp(TOKEN, "y");
  const tokens: string[] = [];
  const end = sql.trimEnd().length;
  while (pattern.lastIndex < end) {
    const at = pattern.lastIndex;
    const token = pattern.exec(sql)?.[1];
    if (token === undefined) throw new Error(`the model cannot read this SQL at ${String(at)}: ${sql}`);
    tokens.push(token);
  }
  return tokens;
}

const parsed = new Map<string, Node>();

/** Reads one SQL expression. PostgreSQL's precedence: OR, AND, NOT, IS, comparison, IN and BETWEEN, || and ~, ::. */
function sqlOf(sql: string): Node {
  const known = parsed.get(sql);
  if (known !== undefined) return known;
  const tokens = tokensOf(sql);
  let at = 0;
  const peek = (offset = 0): string | undefined => tokens[at + offset];
  const accept = (token: string): boolean => {
    if (tokens[at] !== token) return false;
    at += 1;
    return true;
  };
  const fail = (wanted: string): Error =>
    new Error(`the model cannot read this SQL (wanted ${wanted} at token ${String(at)}): ${sql}`);
  const want = (token: string): void => {
    if (!accept(token)) throw fail(`"${token}"`);
  };
  const or = (): Node => {
    const args = [and()];
    while (accept("or")) args.push(and());
    return args.length === 1 ? must(args[0]) : { op: "or", args };
  };
  const and = (): Node => {
    const args = [not()];
    while (accept("and")) args.push(not());
    return args.length === 1 ? must(args[0]) : { op: "and", args };
  };
  const not = (): Node => (accept("not") ? { op: "not", arg: not() } : isNull());
  const isNull = (): Node => {
    let node = compare();
    while (accept("is")) {
      const negated = accept("not");
      want("null");
      node = { op: "isNull", arg: node, negated };
    }
    return node;
  };
  const compare = (): Node => {
    const left = membership();
    const operator = peek();
    if (operator === undefined || !COMPARISONS.has(operator)) return left;
    at += 1;
    return { op: "compare", operator, left, right: membership() };
  };
  const membership = (): Node => {
    const arg = other();
    const negated = peek() === "not" && (peek(1) === "in" || peek(1) === "between");
    if (negated) at += 1;
    if (accept("in")) {
      want("(");
      const list = [or()];
      while (accept(",")) list.push(or());
      want(")");
      return { op: "in", arg, list, negated };
    }
    if (accept("between")) {
      const low = other();
      want("and");
      return { op: "between", arg, low, high: other(), negated };
    }
    return arg;
  };
  const other = (): Node => {
    let left = cast();
    for (let operator = peek(); operator === "||" || operator === "~"; operator = peek()) {
      at += 1;
      left = { op: operator === "||" ? "concat" : "match", left, right: cast() };
    }
    return left;
  };
  const cast = (): Node => {
    let node = primary();
    while (accept("::")) {
      const type = must(peek(), "a type after ::");
      at += 1;
      node = { op: "cast", arg: node, type };
    }
    return node;
  };
  const primary = (): Node => {
    const token = peek();
    if (token === undefined) throw fail("a value");
    at += 1;
    if (token === "(") {
      const node = or();
      want(")");
      return node;
    }
    if (token.startsWith("'")) return { op: "literal", value: token.slice(1, -1).replaceAll("''", "'") };
    if (/^\d+$/.test(token)) return { op: "literal", value: Number(token) };
    if (token === "null") return { op: "literal", value: null };
    if (token === "true" || token === "false") return { op: "literal", value: token === "true" };
    if (!/^[a-z_][a-z0-9_]*$/.test(token)) throw fail("a value");
    if (!accept("(")) return { op: "column", name: token };
    const args: Node[] = [];
    if (!accept(")")) {
      args.push(or());
      while (accept(",")) args.push(or());
      want(")");
    }
    return { op: "call", name: token, args };
  };
  const node = or();
  if (at !== tokens.length) throw fail("the end");
  parsed.set(sql, node);
  return node;
}

/** PostgreSQL's now(), the same instant for every row the model writes. */
const NOW: Ts = { kind: "ts", ms: Date.parse("2026-11-07T12:00:00Z") };

function truth(value: Value): boolean | null {
  if (value === null || typeof value === "boolean") return value;
  throw new Error("a condition that is not true, false or null");
}
function textOf(value: Value): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  throw new Error("the model casts only text, numbers and booleans to text");
}
const textArg = (value: Value): string => {
  if (typeof value !== "string") throw new Error("a function takes text here");
  return value;
};
const numberArg = (value: Value): number => {
  if (typeof value !== "number") throw new Error("a function takes a number here");
  return value;
};
const bytesArg = (value: Value): Uint8Array => {
  if (!(value instanceof Uint8Array)) throw new Error("a function takes bytea here");
  return value;
};
const rangeArg = (value: Value): TsRange => {
  if (isTagged(value) && value.kind === "range") return value;
  throw new Error("a function takes a tstzrange here");
};

/** Orders two non-null values of one type: numbers, text, booleans, timestamps and times of day. */
function order(left: Value, right: Value): number {
  if (typeof left === "number" && typeof right === "number") return Math.sign(left - right);
  if (typeof left === "string" && typeof right === "string") return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  if (isTagged(left) && isTagged(right)) {
    if (left.kind === "ts" && right.kind === "ts") return Math.sign(left.ms - right.ms);
    if (left.kind === "time" && right.kind === "time") return Math.sign(left.seconds - right.seconds);
  }
  throw new Error("the model compares only numbers, text, booleans, timestamps and times of day");
}

/** SQL's =: never true for null. */
function sameValue(left: Value, right: Value): boolean {
  if (left === null || right === null) return false;
  if (
    Array.isArray(left) ||
    Array.isArray(right) ||
    left instanceof Uint8Array ||
    right instanceof Uint8Array
  )
    return isDeepStrictEqual(left, right);
  if (isTagged(left) && (left.kind === "range" || left.kind === "jsonb"))
    return isDeepStrictEqual(left, right);
  return order(left, right) === 0;
}

/** tstzrange's &&: the two ranges share at least one instant. */
function overlaps(a: TsRange, b: TsRange): boolean {
  if (a.empty || b.empty) return false;
  const below = (lower: number | null, lowerInc: boolean, upper: number | null, upperInc: boolean): boolean =>
    lower === null || upper === null || lower < upper || (lower === upper && lowerInc && upperInc);
  return below(a.lower, a.lowerInc, b.upper, b.upperInc) && below(b.lower, b.lowerInc, a.upper, a.upperInc);
}

const POSIX_CLASSES: Record<string, string> = {
  space: String.raw`\s`,
  digit: String.raw`\d`,
  alpha: "A-Za-z",
};
const posixRegex = (pattern: string): RegExp =>
  new RegExp(
    pattern.replace(/\[:([a-z]+):\]/g, (_, name: string) => must(POSIX_CLASSES[name], `POSIX class ${name}`)),
  );

function callOf(name: string, args: Value[]): Value {
  const [first = null, second = null, third = null] = args;
  switch (name) {
    case "lower":
      return textArg(first).toLowerCase();
    case "jsonb_typeof": {
      if (!isTagged(first) || first.kind !== "jsonb") throw new Error("jsonb_typeof takes jsonb");
      const json = first.value;
      if (json === null) return "null";
      if (Array.isArray(json)) return "array";
      return typeof json === "object" ? "object" : typeof json;
    }
    case "split_part":
      return textArg(first).split(textArg(second))[numberArg(third) - 1] ?? "";
    case "octet_length":
      return bytesArg(first).length;
    case "encode":
      if (textArg(second) !== "hex") throw new Error("the model encodes only to hex");
      return hexOfBytes(bytesArg(first));
    case "sha256":
      return bytesOfHex(createHash("sha256").update(bytesArg(first)).digest("hex"));
    case "isempty":
      return rangeArg(first).empty;
    case "lower_inf":
      return !rangeArg(first).empty && rangeArg(first).lower === null;
    case "upper_inf":
      return !rangeArg(first).empty && rangeArg(first).upper === null;
    case "cardinality":
      if (!Array.isArray(first)) throw new Error("cardinality takes an array");
      return first.length;
    default:
      throw new Error(`the model has no function ${name}`);
  }
}

function evaluate(node: Node, row: Row): Value {
  switch (node.op) {
    case "literal":
      return node.value;
    case "column":
      if (!(node.name in row)) throw new Error(`no column ${node.name}`);
      return row[node.name] ?? null;
    case "or":
    case "and": {
      const decides = node.op === "or";
      let unknown = false;
      for (const arg of node.args) {
        const value = truth(evaluate(arg, row));
        if (value === decides) return decides;
        if (value === null) unknown = true;
      }
      return unknown ? null : !decides;
    }
    case "not": {
      const value = truth(evaluate(node.arg, row));
      return value === null ? null : !value;
    }
    case "isNull":
      return (evaluate(node.arg, row) === null) !== node.negated;
    case "compare": {
      const left = evaluate(node.left, row);
      const right = evaluate(node.right, row);
      if (left === null || right === null) return null;
      if (node.operator === "=") return sameValue(left, right);
      if (node.operator === "<>" || node.operator === "!=") return !sameValue(left, right);
      const sign = order(left, right);
      if (node.operator === "<") return sign < 0;
      if (node.operator === ">") return sign > 0;
      return node.operator === "<=" ? sign <= 0 : sign >= 0;
    }
    case "in": {
      const value = evaluate(node.arg, row);
      if (value === null) return null;
      let unknown = false;
      for (const item of node.list) {
        const candidate = evaluate(item, row);
        if (candidate === null) unknown = true;
        else if (sameValue(value, candidate)) return !node.negated;
      }
      return unknown ? null : node.negated;
    }
    case "between": {
      const value = evaluate(node.arg, row);
      const low = evaluate(node.low, row);
      const high = evaluate(node.high, row);
      const above = value === null || low === null ? null : order(value, low) >= 0;
      const below = value === null || high === null ? null : order(value, high) <= 0;
      if (above === false || below === false) return node.negated;
      return above === null || below === null ? null : !node.negated;
    }
    case "concat": {
      const left = evaluate(node.left, row);
      const right = evaluate(node.right, row);
      return left === null || right === null ? null : textOf(left) + textOf(right);
    }
    case "match": {
      const text = evaluate(node.left, row);
      const pattern = evaluate(node.right, row);
      if (text === null || pattern === null) return null;
      return posixRegex(textArg(pattern)).test(textArg(text));
    }
    case "cast": {
      if (node.type !== "text") throw new Error(`the model casts only to text, not ${node.type}`);
      const value = evaluate(node.arg, row);
      return value === null ? null : textOf(value);
    }
    case "call": {
      if (node.name === "now" && node.args.length === 0) return NOW;
      const args = node.args.map((arg) => evaluate(arg, row));
      return args.includes(null) ? null : callOf(node.name, args);
    }
  }
}

/** A CHECK or a predicate on a row: true, false, or null (SQL's unknown, which a CHECK lets pass). */
function holds(sql: string, row: Row): boolean | null {
  try {
    return truth(evaluate(sqlOf(sql), row));
  } catch (error) {
    throw new Error(`${sql}: ${error instanceof Error ? error.message : "cannot evaluate"}`, {
      cause: error,
    });
  }
}

const IDENTITY = "generated always as identity";

/** A column's default: its SQL evaluated, a text literal read as the column's type ('08:00' a time, '{}' an array). */
function defaultOf(column: Column, where: string): Value {
  const value = evaluate(sqlOf(must(column.default)), {});
  if (typeof value !== "string" || column.type === "text") return value;
  if (column.type === "text[]") {
    if (value !== "{}") throw new Error(`${where}: the model reads only the empty array literal '{}'`);
    return [];
  }
  return inputOf(column.type, value, where);
}

// ---------------------------------------------------------------------------------------------------------------
// The model database: one table list, its rows, and the two sides of README rule 4

interface Session {
  role: Role;
  businessId: string | null;
}
const RUNTIME: Session = { role: "runtime", businessId: null };
const toolApi = (businessId: string): Session => ({ role: "toolApi", businessId });

/** README rule 5: the application roles may insert and select on event_log, never update or delete it. */
const NEVER_EDITED = new Set(["event_log"]);

/**
 * README rule 2 (line 54): every update of a table with versioned: true raises its version by one. The producer's
 * migration 0002 (lines 12 to 25) refuses any other new version (left as it was, skipped ahead or null) in a BEFORE
 * UPDATE trigger with SQLSTATE 23514 and the constraint <table>_version_raised. A row trigger runs on the rows
 * row-level security lets the update see, and before its check of the new row and every constraint.
 */
function checkVersionRaised(table: Table, old: Row, row: Row): void {
  if (!table.versioned) return;
  const column = must(table.versionColumn, `the version column of ${table.name}`);
  const before = old[column] ?? null;
  if (typeof before !== "number") throw new Error(`${table.name}.${column} holds no version`);
  const after = row[column] ?? null;
  if (after !== before + 1)
    throw new DbError(
      "23514",
      `update of ${table.name} must raise ${column} from ${String(before)} to ${String(before + 1)} (got ${JSON.stringify(after)})`,
      `${table.name}_version_raised`,
      column,
    );
}

/** A database holding one table list, as the fixtures' two sides see it (README rule 4, rule 5). */
export class Database {
  private readonly rows = new Map<string, Row[]>();
  private readonly identities = new Map<string, number>();

  constructor(readonly list: TableList) {
    for (const table of list.tables) this.rows.set(table.name, []);
  }

  rowsOf(name: string): Row[] {
    return must(this.rows.get(name), `the rows of ${name}`);
  }

  private tableNamed(name: string): Table {
    const table = this.list.tables.find((candidate) => candidate.name === name);
    if (table === undefined) throw new DbError("42P01", `relation "${name}" does not exist`);
    return table;
  }

  private columnOf(table: Table, name: string): Column {
    const column = table.columns.find((candidate) => candidate.name === name);
    if (column === undefined)
      throw new DbError("42703", `column "${name}" of relation "${table.name}" does not exist`, null, name);
    return column;
  }

  /** README rule 4: a Tool API call sees only its business's rows (none whose business is null); the runtime, all. */
  private visible(table: Table, row: Row, session: Session): boolean {
    if (session.role === "runtime" || table.rowLevelSecurity.scope === "none") return true;
    const owner = row[table.rowLevelSecurity.column] ?? null;
    return owner !== null && owner === session.businessId;
  }

  insert(session: Session, tableName: string, values: Record<string, unknown>): void {
    const table = this.tableNamed(tableName);
    for (const name of Object.keys(values)) this.columnOf(table, name);
    const row: Row = {};
    for (const column of table.columns) {
      const where = `${table.name}.${column.name}`;
      if (column.default === IDENTITY) {
        if (column.name in values)
          throw new DbError(
            "428C9",
            `cannot insert a non-DEFAULT value into column "${column.name}"`,
            null,
            column.name,
          );
        const next = (this.identities.get(where) ?? 0) + 1;
        this.identities.set(where, next);
        row[column.name] = next;
      } else if (column.name in values) {
        row[column.name] = inputOf(column.type, values[column.name], where);
      } else {
        row[column.name] = column.default === undefined ? null : defaultOf(column, where);
      }
    }
    this.check(session, table, row, null);
    this.rowsOf(table.name).push(row);
  }

  /**
   * PostgreSQL's order: the privilege (rule 5), row-level security's filter (a hidden row is not updated), then for each
   * row the version trigger (rule 2) before the checks of the new row (see check).
   */
  update(
    session: Session,
    tableName: string,
    set: Record<string, unknown>,
    where: Record<string, unknown>,
  ): number {
    const table = this.tableNamed(tableName);
    for (const name of [...Object.keys(set), ...Object.keys(where)]) this.columnOf(table, name);
    if (NEVER_EDITED.has(table.name)) throw new DbError("42501", `permission denied for table ${table.name}`);
    const rows = this.rowsOf(table.name);
    const matching = this.matching(session, table, where);
    for (const old of matching) {
      const row: Row = { ...old };
      for (const [name, raw] of Object.entries(set)) {
        const column = this.columnOf(table, name);
        if (column.default === IDENTITY)
          throw new DbError("428C9", `column "${name}" can only be updated to DEFAULT`, null, name);
        row[name] = inputOf(column.type, raw, `${table.name}.${name}`);
      }
      checkVersionRaised(table, old, row);
      this.check(session, table, row, old);
      rows[rows.indexOf(old)] = row;
    }
    return matching.length;
  }

  select(session: Session, tableName: string, where: Record<string, unknown>): Row[] {
    const table = this.tableNamed(tableName);
    for (const name of Object.keys(where)) this.columnOf(table, name);
    return this.matching(session, table, where);
  }

  private matching(session: Session, table: Table, where: Record<string, unknown>): Row[] {
    const wanted = Object.entries(where).map(
      ([name, raw]) =>
        [name, inputOf(this.columnOf(table, name).type, raw, `${table.name}.${name}`)] as const,
    );
    return this.rowsOf(table.name).filter(
      (row) =>
        this.visible(table, row, session) &&
        wanted.every(([name, value]) => sameValue(row[name] ?? null, value)),
    );
  }

  /** PostgreSQL's order: row-level security's check, not null, CHECK (by name), keys and EXCLUDE, foreign keys. */
  private check(session: Session, table: Table, row: Row, replacing: Row | null): void {
    const value = (data: Row, name: string): Value => data[name] ?? null;
    if (session.role === "toolApi" && table.rowLevelSecurity.scope === "business") {
      const owner = value(row, table.rowLevelSecurity.column);
      if (owner === null || owner !== session.businessId)
        throw new DbError("42501", `new row violates row-level security policy for table "${table.name}"`);
    }
    for (const column of table.columns) {
      if (!column.null && value(row, column.name) === null)
        throw new DbError(
          "23502",
          `null value in column "${column.name}" of relation "${table.name}" violates not-null constraint`,
          null,
          column.name,
        );
    }
    const checks = [...(table.checks ?? [])].sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const check of checks) {
      if (holds(check.expression, row) === false)
        throw new DbError(
          "23514",
          `new row for relation "${table.name}" violates check constraint "${check.name}"`,
          check.name,
        );
    }
    const others = this.rowsOf(table.name).filter((other) => other !== replacing);
    const inKey = (key: { where?: string }, data: Row): boolean =>
      key.where === undefined || holds(key.where, data) === true;
    const keys: UniqueKey[] = [
      { name: primaryKeyName(table.name), columns: table.primaryKey },
      ...(table.unique ?? []),
    ];
    for (const key of keys) {
      if (!inKey(key, row) || key.columns.some((name) => value(row, name) === null)) continue;
      const clash = others.some(
        (other) =>
          inKey(key, other) && key.columns.every((name) => sameValue(value(other, name), value(row, name))),
      );
      const name = uniqueName(table.name, key);
      if (clash) throw new DbError("23505", `duplicate key value violates unique constraint "${name}"`, name);
    }
    for (const exclusion of table.exclude ?? []) {
      if (!inKey(exclusion, row)) continue;
      const clash = others.some(
        (other) =>
          inKey(exclusion, other) &&
          exclusion.elements.every((element) => {
            if (element.column === undefined)
              throw new Error("the model reads EXCLUDE elements on columns only");
            const mine = value(row, element.column);
            const theirs = value(other, element.column);
            if (mine === null || theirs === null) return false;
            if (element.operator === "=") return sameValue(mine, theirs);
            if (element.operator === "&&") return overlaps(rangeArg(mine), rangeArg(theirs));
            throw new Error(`the model has no EXCLUDE operator ${element.operator}`);
          }),
      );
      if (clash)
        throw new DbError(
          "23P01",
          `conflicting key value violates exclusion constraint "${exclusion.name}"`,
          exclusion.name,
        );
    }
    for (const key of table.foreignKeys ?? []) {
      const mine = key.columns.map((name) => value(row, name));
      if (mine.includes(null)) continue;
      const name = key.name ?? `${table.name}_${key.columns.join("_")}_fkey`;
      if (key.references.table.includes("."))
        throw new Error(`the model cannot follow ${name} to another part's table ${key.references.table}`);
      const targets =
        key.references.table === table.name ? [...others, row] : this.rowsOf(key.references.table);
      const found = targets.some((target) =>
        key.references.columns.every((column, at) => sameValue(value(target, column), mine[at] ?? null)),
      );
      if (!found)
        throw new DbError(
          "23503",
          `insert or update on table "${table.name}" violates foreign key constraint "${name}"`,
          name,
        );
    }
  }
}

const freshDb = (version: string): Database => new Database(tableListOf(version));

/** Where a load was refused: the fixture, the row (from 0), its table and the refusal. */
interface Refusal {
  file: string;
  row: number;
  table: string;
  error: DbError;
}

/** Loads a fixture after the fixtures its `after` names (each once, in order); its rows as the runtime side. */
function load(
  db: Database,
  file: string,
  loaded: Set<string>,
  content: FixtureFile = fixtureOf(file),
  chain: string[] = [],
): Refusal | null {
  if (loaded.has(file)) return null;
  if (chain.includes(file)) throw new Error(`the after chain loops: ${[...chain, file].join(" -> ")}`);
  for (const first of content.after) {
    const refusal = load(db, first, loaded, fixtureOf(first), [...chain, file]);
    if (refusal !== null) return refusal;
  }
  for (const [at, row] of content.rows.entries()) {
    try {
      db.insert(RUNTIME, row.table, row.values);
    } catch (error) {
      if (error instanceof DbError) return { file, row: at, table: row.table, error };
      throw error;
    }
  }
  loaded.add(file);
  return null;
}

const shown = (refusal: Refusal | null): string =>
  refusal === null
    ? "loaded"
    : `${refusal.file} row ${String(refusal.row)} (${refusal.table}): ${refusal.error.message}`;

/** A database of one version with these fixtures loaded; a refusal is a broken test here. */
function loadedDb(files: string[], version = "v1"): Database {
  const db = freshDb(version);
  const loaded = new Set<string>();
  for (const file of files) {
    const refusal = load(db, file, loaded);
    if (refusal !== null) throw new Error(shown(refusal));
  }
  return db;
}

function refusalOf(act: () => void): DbError | null {
  try {
    act();
    return null;
  } catch (error) {
    if (error instanceof DbError) return error;
    throw error;
  }
}

type Outcome = { rows: number; error: null } | { rows: null; error: DbError };

/** Runs a refused fixture's action as its role under its scope. */
function run(db: Database, action: Action): Outcome {
  const session: Session =
    action.scope === null ? { role: action.role, businessId: null } : toolApi(action.scope.businessId);
  let rows = 0;
  const error = refusalOf(() => {
    if (action.action === "insert") {
      db.insert(session, action.table, must(action.values, "values"));
      rows = 1;
    } else if (action.action === "update") {
      rows = db.update(session, action.table, must(action.set, "set"), must(action.where, "where"));
    } else {
      rows = db.select(session, action.table, must(action.where, "where")).length;
    }
  });
  return error === null ? { rows, error: null } : { rows: null, error };
}

/** One line per way the outcome misses what the fixture expects; empty when it meets it. */
function expectProblems(outcome: Outcome, wanted: Expect): string[] {
  if (wanted.sqlstate !== undefined) {
    if (outcome.error === null) return [`must be refused with ${wanted.sqlstate}, but passes`];
    const problems: string[] = [];
    if (outcome.error.sqlstate !== wanted.sqlstate)
      problems.push(`must be refused with ${wanted.sqlstate}, but is refused with ${outcome.error.message}`);
    if (
      wanted.constraintOneOf !== undefined &&
      !wanted.constraintOneOf.includes(outcome.error.constraint ?? "")
    )
      problems.push(
        `must be refused by one of ${wanted.constraintOneOf.join(", ")}, but by ${outcome.error.constraint ?? "no constraint"}`,
      );
    return problems;
  }
  if (outcome.error !== null)
    return [`must return ${String(wanted.rows)} rows, but is refused: ${outcome.error.message}`];
  return outcome.rows === wanted.rows
    ? []
    : [`must return ${String(wanted.rows)} rows, but returns ${String(outcome.rows)}`];
}

/** What checking one index entry against its version's table list gives. */
interface EntryCheck {
  file: string;
  outcome: "loaded" | "refused" | "error";
  problems: string[];
}

function checkEntry(entry: FixtureEntry, content: FixtureFile = fixtureOf(entry.file)): EntryCheck {
  const result = (outcome: EntryCheck["outcome"], problems: string[]): EntryCheck => ({
    file: entry.file,
    outcome,
    problems,
  });
  const format = formatProblems(content);
  if (format.length > 0)
    return result(
      "error",
      format.map((line) => `file format: ${line}`),
    );
  const problems: string[] = [];
  const about = entry.table ?? "(no table)";
  const after = content.after.filter(
    (first) => !acceptedEntries.some((candidate) => candidate.file === first),
  );
  if (after.length > 0)
    problems.push(`after names fixtures that are not accepted entries: ${after.join(", ")}`);
  try {
    const db = freshDb(entry.version);
    if (entry.expect === "accept") {
      if (content.refused !== undefined) problems.push("an accepted fixture holds no refused action");
      if (!content.rows.some((row) => row.table === about)) problems.push(`its rows write no ${about} row`);
      const refusal = load(db, entry.file, new Set(), content);
      if (refusal !== null) problems.push(`must load, but is refused: ${shown(refusal)}`);
      return result(refusal === null ? "loaded" : "refused", problems);
    }
    const action = content.refused;
    if (action === undefined)
      return result("error", [...problems, "a refused fixture names its refused action"]);
    if (action.table !== about) problems.push(`its action is on ${action.table}, its entry names ${about}`);
    const refusal = load(db, entry.file, new Set(), content);
    if (refusal !== null)
      return result("error", [...problems, `its after chain must load, but: ${shown(refusal)}`]);
    const missed = expectProblems(run(db, action), action.expect);
    return result(missed.length === 0 ? "refused" : "error", [...problems, ...missed]);
  } catch (error) {
    return result("error", [
      ...problems,
      `the model could not check it: ${error instanceof Error ? error.message : ""}`,
    ]);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Every fixture of the index, checked against the table list of its version

// The T-003 harness checks a schema only: every K-04 entry names a table, so it counts each as a seed row, checks the
// index and the folder, and leaves the rows to this test.
const report = checkContractFixtures("db-schema/core");
const results = entries.map((entry) => checkEntry(entry));

describe("db-schema core fixtures: the index, the count and the table list", () => {
  it("has the T-003 harness leave every entry to this test as a seed row, with a valid index that lists every file", () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(report.problems).toEqual([]);
    expect(report.entries.map((result) => result.file)).toEqual(entries.map((entry) => entry.file));
    expect(report.seedRows).toBe(entries.length);
    expect(report.passes + report.refusals).toBe(0);
    for (const result of report.entries) {
      expect(result.outcome, result.file).toBe("seed-row");
      expect(result.ok, result.file).toBe(true);
    }
    const onDisk = readdirSync(FIXTURES_DIR, { recursive: true, encoding: "utf8" })
      .map((file) => file.split(path.sep).join("/"))
      .filter((file) => file.endsWith(".json") && file !== "index.json");
    expect([...onDisk].sort()).toEqual(entries.map((entry) => entry.file).sort());
  });

  it("checks as many fixtures as fixtures/index.json lists, none left out: each accepted one loaded, each refused one refused", () => {
    expect(results.map((result) => result.file)).toEqual(entries.map((entry) => entry.file));
    expect(results.filter((result) => result.outcome === "loaded")).toHaveLength(acceptedEntries.length);
    expect(results.filter((result) => result.outcome === "refused")).toHaveLength(refusedEntries.length);
    expect(acceptedEntries.length + refusedEntries.length).toBe(entries.length);
    expect(results.flatMap((result) => result.problems.map((line) => `${result.file}: ${line}`))).toEqual([]);
  });

  for (const [at, entry] of entries.entries()) {
    const how = entry.expect === "accept" ? "loads" : "refuses";
    it(`${how} ${entry.file} (${entry.version}, table ${entry.table ?? "(none)"})`, () => {
      const result = must(results[at]);
      expect(result.problems).toEqual([]);
      expect(result.outcome).toBe(entry.expect === "accept" ? "loaded" : "refused");
    });
  }

  it("has a table list for each version the index names, valid against tables.meta.schema.json, naming every entry's table", () => {
    const meta = readJson(path.join(CONTRACTS_ROOT, "db-schema", "tables.meta.schema.json")) as object;
    const validate = new Ajv2020({ strict: true, strictRequired: false, allErrors: true }).compile(meta);
    expect(versions).toContain("v1");
    for (const version of versions) {
      expect(existsSync(listFile(version)), `core.${version}.tables.json`).toBe(true);
      const list = tableListOf(version);
      expect(validate(list), formatErrors(validate.errors).join("; ")).toBe(true);
      expect([list.part, list.version]).toEqual(["core", version]);
      for (const entry of entries.filter((candidate) => candidate.version === version))
        expect(
          list.tables.map((table) => table.name),
          entry.file,
        ).toContain(entry.table);
    }
  });

  it("holds accepted and refused fixtures for v1, selected by version and by what each entry says", () => {
    expect(ofVersion("v1", "accept").length).toBeGreaterThan(0);
    expect(ofVersion("v1", "refuse").map((entry) => entry.file)).toEqual(
      expect.arrayContaining([
        "invalid/refuse-overlapping-reservation.json",
        "invalid/refuse-seats-over-capacity.json",
        "invalid/refuse-duplicate-turn-id.json",
        "invalid/refuse-event-log-update.json",
        "invalid/refuse-cross-business-read.json",
      ]),
    );
  });

  // Each version's accepted fixtures load after those of every version up to it, so a minor version whose fixtures
  // seed only its new tables still gives every table rows (DL-181).
  for (const version of versions) {
    it(`loads every accepted fixture of each version up to ${version} together, each once, and every table of core.${version}.tables.json gets rows`, () => {
      const accepted = acceptedUpTo(version);
      expect(accepted.map((entry) => entry.file)).toEqual(
        expect.arrayContaining(ofVersion(version, "accept").map((entry) => entry.file)),
      );
      const db = freshDb(version);
      const loaded = new Set<string>();
      for (const entry of accepted) expect(shown(load(db, entry.file, loaded)), entry.file).toBe("loaded");
      for (const entry of accepted) expect(loaded.has(entry.file), entry.file).toBe(true);
      const empty = tableListOf(version).tables.filter((table) => db.rowsOf(table.name).length === 0);
      expect(empty.map((table) => table.name)).toEqual([]);
    });
  }

  // One check per version: SQL a later version adds fails loudly in that version's own check, never in v1's (DL-181).
  for (const version of versions) {
    it(`reads every CHECK, unique and EXCLUDE predicate and default of core.${version}.tables.json (the model fails loudly on SQL it cannot read)`, () => {
      let read = 0;
      for (const table of tableListOf(version).tables) {
        const sql = [
          ...(table.checks ?? []).map((check) => check.expression),
          ...(table.unique ?? []).flatMap((key) => (key.where === undefined ? [] : [key.where])),
          ...(table.exclude ?? []).flatMap((exclusion) =>
            exclusion.where === undefined ? [] : [exclusion.where],
          ),
          ...table.columns.flatMap((column) =>
            column.default === undefined || column.default === IDENTITY ? [] : [column.default],
          ),
        ];
        for (const expression of sql)
          expect(() => sqlOf(expression), `${table.name}: ${expression}`).not.toThrow();
        read += sql.length;
        for (const exclusion of table.exclude ?? []) {
          expect(exclusion.using, exclusion.name).toBe("gist");
          for (const element of exclusion.elements)
            expect(["=", "&&"], exclusion.name).toContain(element.operator);
        }
      }
      expect(read).toBeGreaterThan(50);
    });
  }

  it("places each version of the index, so a minor version's check loads v1's accepted fixtures first", () => {
    for (const version of versions) expect(versionsUpTo(version), version).toContain(version);
    expect(versionsUpTo("v1")).toEqual(["v1"]);
    expect(acceptedUpTo("v1")).toEqual(ofVersion("v1", "accept"));
    const minor = versionsUpTo("v1.1");
    expect(minor[0]).toBe("v1");
    expect(minor.every((version) => placeOf(version)[0] === 1 && placeOf(version)[1] <= 1)).toBe(true);
    expect(() => placeOf("1.1")).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Each refusal tied to its reason

/** README: "Each is refused for its one reason: without it ... the same action passes." */
interface Mend {
  reason: string;
  putRight: string;
  /** The one path of the action that the mend changes, or null when the mend is another action. */
  changed: string | null;
  mend: (action: Action) => Action;
}

const MENDS: Record<string, Mend> = {
  "invalid/refuse-overlapping-reservation.json": {
    reason: "its time overlaps Alex's booked haircut with Riley (EXCLUDE, 23P01)",
    putRight: "a time that does not overlap, the half hour that starts as the haircut ends",
    changed: "values.during",
    mend: (action) => ({
      ...action,
      values: { ...must(action.values), during: "[2026-10-24T15:30:00Z,2026-10-24T16:00:00Z)" },
    }),
  },
  "invalid/refuse-seats-over-capacity.json": {
    reason: "11 taken is past the workshop's 10 spots (CHECK, 23514)",
    putRight: "taken = 10",
    changed: "set.taken",
    mend: (action) => ({ ...action, set: { ...must(action.set), taken: 10 } }),
  },
  "invalid/refuse-duplicate-turn-id.json": {
    reason: "its turn id is a committed turn's (the primary key, 23505)",
    putRight: "a new turn id",
    changed: "values.id",
    mend: (action) => ({ ...action, values: { ...must(action.values), id: "turn-alex-move-2" } }),
  },
  "invalid/refuse-event-log-update.json": {
    reason: "it edits an event-log row, which the application roles may never update (42501)",
    putRight: "the same change written as a new event-log row by the same side",
    changed: null,
    mend: (action) => ({
      role: action.role,
      scope: action.scope,
      action: "insert",
      table: action.table,
      values: { ...evlog0001(), id: "evlog-0004", ...must(action.set) },
      expect: action.expect,
    }),
  },
  "invalid/refuse-cross-business-read.json": {
    reason: "a yoga studio call reads Lee's Barbershop's booking, which row-level security hides (no row)",
    putRight: "the barbershop's own scope",
    changed: "scope.businessId",
    mend: (action) => ({ ...action, scope: { businessId: "biz-lees-barbershop" } }),
  },
};

function evlog0001(): Record<string, unknown> {
  return must(
    fixtureOf("seed-event-log.json").rows.find((row) => row.values.id === "evlog-0001"),
    "evlog-0001",
  ).values;
}

/** The paths at which two JSON values differ. */
function differences(a: unknown, b: unknown, at = ""): string[] {
  if (isDeepStrictEqual(a, b)) return [];
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isObject(a) || !isObject(b)) return [at];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
    differences(a[key], b[key], at === "" ? key : `${at}.${key}`),
  );
}

describe("db-schema core fixtures: each refusal tied to its reason", () => {
  it("has a mend for every v1 refused fixture, as the README states each one's reason", () => {
    expect(Object.keys(MENDS).sort()).toEqual(
      ofVersion("v1", "refuse")
        .map((entry) => entry.file)
        .sort(),
    );
  });

  for (const entry of ofVersion("v1", "refuse")) {
    const mend = MENDS[entry.file];
    it(`refuses ${entry.file} because ${mend?.reason ?? "(no mend)"}; put right (${mend?.putRight ?? ""}), the same action passes`, () => {
      const { reason, changed, mend: putRight } = must(mend, `a mend for ${entry.file}`);
      expect(reason).not.toBe("");
      const content = fixtureOf(entry.file);
      const action = must(content.refused, "the refused action");
      const db = freshDb(entry.version);
      expect(shown(load(db, entry.file, new Set(), content))).toBe("loaded");
      expect(expectProblems(run(db, action), action.expect)).toEqual([]);
      const right = putRight(structuredClone(action));
      if (changed === null) {
        expect(right.action).toBe("insert");
        const row = evlog0001();
        const written = must(right.values);
        const fields = [...new Set([...Object.keys(row), ...Object.keys(written)])];
        expect(fields.filter((field) => !isDeepStrictEqual(row[field], written[field])).sort()).toEqual([
          "id",
          "new_values",
        ]);
        expect(written.new_values).toEqual(must(action.set).new_values);
      } else {
        expect(differences(action, right)).toEqual([changed]);
      }
      const again = freshDb(entry.version);
      expect(shown(load(again, entry.file, new Set(), content))).toBe("loaded");
      const passed = run(again, right);
      expect(passed.error?.message ?? null).toBeNull();
      expect(passed.rows).toBe(1);
    });
  }

  it("names in each refused fixture's expect only constraints its version's table list holds", () => {
    for (const entry of refusedEntries) {
      const list = tableListOf(entry.version);
      const names = new Set(
        list.tables.flatMap((table) => [
          primaryKeyName(table.name),
          ...(table.unique ?? []).map((key) => uniqueName(table.name, key)),
          ...(table.exclude ?? []).map((exclusion) => exclusion.name),
          ...(table.checks ?? []).map((check) => check.name),
        ]),
      );
      for (const name of must(fixtureOf(entry.file).refused).expect.constraintOneOf ?? [])
        expect(names.has(name), `${entry.file}: ${name}`).toBe(true);
    }
  });

  it("refuses a worker booked at two businesses at once by reservations_no_overlap_per_worker alone (README, No double booking)", () => {
    const db = loadedDb(["seed-reservation.json"]);
    db.insert(RUNTIME, "resources", {
      id: "res-riley-yoga",
      business_id: "biz-yoga-studio",
      kind: "worker",
      name: "Riley",
      person_id: "person-riley",
    });
    const reservation = {
      id: "rsv-riley-yoga",
      business_id: "biz-yoga-studio",
      resource_id: "res-riley-yoga",
      resource_kind: "worker",
      worker_person_id: "person-riley",
      during: "[2026-10-24T15:15:00Z,2026-10-24T15:45:00Z)",
      state: "held",
      held_until: "2026-10-23T14:20:00Z",
      for_agent_token: "agent-token-demo-2",
    };
    const refused = refusalOf(() => {
      db.insert(toolApi("biz-yoga-studio"), "reservations", reservation);
    });
    expect([refused?.sqlstate, refused?.constraint]).toEqual(["23P01", "reservations_no_overlap_per_worker"]);
    const later = { ...reservation, during: "[2026-10-24T15:30:00Z,2026-10-24T16:00:00Z)" };
    expect(
      refusalOf(() => {
        db.insert(toolApi("biz-yoga-studio"), "reservations", later);
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. The table list is not vacuous

describe("db-schema core fixtures: removing a required column makes an accepted fixture refused", () => {
  for (const entry of acceptedEntries) {
    it(`${entry.file} (${entry.version})`, () => {
      const content = fixtureOf(entry.file);
      const list = tableListOf(entry.version);
      let removals = 0;
      for (const [at, row] of content.rows.entries()) {
        const required = tableOf(list, row.table)
          .columns.filter((column) => !column.null && column.default === undefined)
          .map((column) => column.name);
        expect(required.length, `${row.table} has required columns`).toBeGreaterThan(0);
        expect(
          required.filter((name) => !(name in row.values)),
          `row ${String(at)} gives every required column`,
        ).toEqual([]);
        for (const name of required) {
          const copy = structuredClone(content);
          Reflect.deleteProperty(must(copy.rows[at]).values, name);
          const refusal = load(freshDb(entry.version), entry.file, new Set(), copy);
          expect(
            [refusal?.row, refusal?.error.sqlstate, refusal?.error.column],
            `row ${String(at)} without ${name}: ${shown(refusal)}`,
          ).toEqual([at, "23502", name]);
          removals += 1;
        }
        const unknown = structuredClone(content);
        must(unknown.rows[at]).values.not_in_the_table = 1;
        const refusal = load(freshDb(entry.version), entry.file, new Set(), unknown);
        expect([refusal?.row, refusal?.error.sqlstate, refusal?.error.column]).toEqual([
          at,
          "42703",
          "not_in_the_table",
        ]);
      }
      expect(removals).toBeGreaterThan(0);
      for (const field of ["after", "rows"]) {
        const copy: Record<string, unknown> = { ...content };
        Reflect.deleteProperty(copy, field);
        expect(formatProblems(copy).length, `without ${field}`).toBeGreaterThan(0);
      }
      for (const field of ["table", "values"]) {
        const copy = structuredClone(content);
        Reflect.deleteProperty(must(copy.rows[0]), field);
        expect(formatProblems(copy).length, `a row without ${field}`).toBeGreaterThan(0);
      }
    });
  }
});

/** A row's values in a fixture file copy, found by one column's value. */
function valuesWhere(file: FixtureFile, column: string, value: unknown): Record<string, unknown> {
  return must(
    file.rows.find((row) => row.values[column] === value),
    `a row with ${column} = ${JSON.stringify(value)}`,
  ).values;
}

interface Damage {
  base: string;
  does: string;
  damage: (file: FixtureFile) => void;
  sqlstate: string;
  constraint: string | null;
}

const OTHER_HASH = "0".repeat(64);

// Damaged copies of v1 fixtures (frozen, so never edited), each breaking one rule of the table list or one input form.
const DAMAGES: readonly Damage[] = [
  {
    base: "seed-business-head.json",
    does: "a business status outside its closed list",
    damage: (file) => {
      valuesWhere(file, "id", "biz-lees-barbershop").status = "open";
    },
    sqlstate: "23514",
    constraint: "businesses_status_known",
  },
  {
    base: "seed-business-head.json",
    does: "text hours that end before they start",
    damage: (file) => {
      valuesWhere(file, "id", "biz-lees-barbershop").text_hours_end = "07:00";
    },
    sqlstate: "23514",
    constraint: "businesses_text_hours_order",
  },
  {
    base: "seed-person-roles.json",
    does: "an email handle not in lower case",
    damage: (file) => {
      valuesWhere(file, "id", "handle-alex-email").address = "Alex@example.com";
    },
    sqlstate: "23514",
    constraint: "handles_address_form",
  },
  {
    base: "seed-phone-stopped.json",
    does: "a stopped phone with its chat open",
    damage: (file) => {
      valuesWhere(file, "number", "+15555550106").chat_open = true;
    },
    sqlstate: "23514",
    constraint: "phones_stop_closes_chat",
  },
  {
    base: "seed-bundle-registry.json",
    does: "a stored manifest whose sha256 is not its bytes'",
    damage: (file) => {
      valuesWhere(file, "kind", "manifest").sha256 = OTHER_HASH;
    },
    sqlstate: "23514",
    constraint: "bundle_values_sha256_match",
  },
  {
    base: "seed-bundle-registry.json",
    does: "a stored manifest whose byte count is not its length",
    damage: (file) => {
      valuesWhere(file, "kind", "manifest").bytes = 120;
    },
    sqlstate: "23514",
    constraint: "bundle_values_bytes_match",
  },
  {
    base: "seed-bundle-registry.json",
    does: "a second active bundle",
    damage: (file) => {
      file.rows.push({
        table: "bundles",
        values: {
          hash: OTHER_HASH,
          build: 1,
          manifest_key: `bundle/${OTHER_HASH}/1/manifest`,
          built_at: "2026-11-08T08:00:00Z",
          active: true,
          activated_at: "2026-11-08T08:06:00Z",
        },
      });
    },
    sqlstate: "23505",
    constraint: "bundles_one_active",
  },
  {
    base: "seed-outbox-row.json",
    does: "an outbox part whose idempotency key is not (row, part, try)",
    damage: (file) => {
      valuesWhere(file, "idempotency_key", "out-a7-03-alex/1/1").idempotency_key = "out-a7-03-alex/1/2";
    },
    sqlstate: "23514",
    constraint: "outbox_parts_key_form",
  },
  {
    base: "seed-turn.json",
    does: "a turn of no event",
    damage: (file) => {
      valuesWhere(file, "id", "turn-alex-move-1").event_ids = [];
    },
    sqlstate: "23514",
    constraint: "turns_has_events",
  },
  {
    base: "seed-open-question.json",
    does: "a step id that is not a step's",
    damage: (file) => {
      valuesWhere(file, "id", "oq-a7-03-alex").step = "A7-3";
    },
    sqlstate: "23514",
    constraint: "open_questions_step_form",
  },
  {
    base: "seed-clock-row.json",
    does: "a job's clock row owned by a handle",
    damage: (file) => {
      valuesWhere(file, "id", "clock-monthly-billing-2026-12").handle_id = "handle-alex";
    },
    sqlstate: "23514",
    constraint: "clock_rows_job_has_no_handle",
  },
  {
    base: "seed-event-log.json",
    does: "an event of neither a turn nor a job",
    damage: (file) => {
      Reflect.deleteProperty(valuesWhere(file, "id", "evlog-0003"), "job_id");
    },
    sqlstate: "23514",
    constraint: "event_log_turn_or_job",
  },
  {
    base: "seed-flag.json",
    does: "a flag scoped to a phone not written +number",
    damage: (file) => {
      valuesWhere(file, "name", "staging.text-hours-override").scope = "phone:5555550101";
    },
    sqlstate: "23514",
    constraint: "release_flags_scope_form",
  },
  {
    base: "seed-sealing-key.json",
    does: "an erased sealing key that still holds its wrapped key",
    damage: (file) => {
      valuesWhere(file, "person_id", "person-ben").wrapped_key = String.raw`\x00`;
    },
    sqlstate: "23514",
    constraint: "sealing_keys_erased_or_held",
  },
  {
    base: "seed-class-seats.json",
    does: "a seat reservation of no seat",
    damage: (file) => {
      valuesWhere(file, "id", "rsv-alex-workshop").seats = 0;
    },
    sqlstate: "23514",
    constraint: "reservations_seats",
  },
  {
    base: "seed-reservation.json",
    does: "a saved time with no end to its hold",
    damage: (file) => {
      Reflect.deleteProperty(valuesWhere(file, "id", "rsv-alex-saved-avery"), "held_until");
    },
    sqlstate: "23514",
    constraint: "reservations_held_has_end",
  },
  {
    base: "seed-reservation.json",
    does: "a reservation of a resource that does not exist",
    damage: (file) => {
      valuesWhere(file, "id", "rsv-alex-haircut").resource_id = "res-unknown";
    },
    sqlstate: "23503",
    constraint: "reservations_resource_kind_fk",
  },
  {
    base: "seed-thread-messages.json",
    does: "a second chat for one handle",
    damage: (file) => {
      file.rows.push({
        table: "threads",
        values: { id: "thread-alex-chat-2", handle_id: "handle-alex", kind: "chat", version: 1 },
      });
    },
    sqlstate: "23505",
    constraint: "threads_one_chat_per_handle",
  },
  {
    base: "seed-booking-head.json",
    does: "a row for a table the list does not hold",
    damage: (file) => {
      must(file.rows[0]).table = "booking";
    },
    sqlstate: "42P01",
    constraint: null,
  },
  {
    base: "seed-reservation.json",
    does: "a time range whose end comes before its start",
    damage: (file) => {
      valuesWhere(file, "id", "rsv-alex-haircut").during = "[2026-10-24T15:30:00Z,2026-10-24T15:00:00Z)";
    },
    sqlstate: "22000",
    constraint: null,
  },
  {
    base: "seed-turn.json",
    does: "a timestamptz not in UTC ending in Z",
    damage: (file) => {
      valuesWhere(file, "id", "turn-alex-move-1").committed_at = "2026-10-23 14:05:02";
    },
    sqlstate: FORM,
    constraint: null,
  },
  {
    base: "seed-turn.json",
    does: "a date that does not exist",
    damage: (file) => {
      valuesWhere(file, "id", "turn-alex-move-1").committed_at = "2026-02-30T14:05:02Z";
    },
    sqlstate: "22008",
    constraint: null,
  },
  {
    base: "seed-turn.json",
    does: "a text[] that is not a JSON array",
    damage: (file) => {
      valuesWhere(file, "id", "turn-alex-move-1").event_ids = "evt-alex-0007";
    },
    sqlstate: FORM,
    constraint: null,
  },
  {
    base: "seed-turn.json",
    does: "an integer that is not a whole number",
    damage: (file) => {
      valuesWhere(file, "id", "turn-alex-move-1").bundle_build = 1.5;
    },
    sqlstate: "22P02",
    constraint: null,
  },
  {
    base: "seed-reservation.json",
    does: "a tstzrange that is not written [start,end)",
    damage: (file) => {
      valuesWhere(file, "id", "rsv-alex-haircut").during = { from: "2026-10-24T15:00:00Z" };
    },
    sqlstate: FORM,
    constraint: null,
  },
  {
    base: "seed-sealing-key.json",
    does: "a bytea not written \\x and hex",
    damage: (file) => {
      valuesWhere(file, "person_id", "person-alex").wrapped_key = "6b30342d";
    },
    sqlstate: FORM,
    constraint: null,
  },
  {
    base: "seed-outbox-row.json",
    does: "a commit_seq written by the fixture (always left out)",
    damage: (file) => {
      valuesWhere(file, "id", "out-a7-03-alex").commit_seq = 1;
    },
    sqlstate: "428C9",
    constraint: null,
  },
];

describe("db-schema core fixtures: a damaged copy is refused by the one rule it breaks", () => {
  for (const { base, does, damage, sqlstate, constraint } of DAMAGES) {
    it(`${base} with ${does}: ${sqlstate}${constraint === null ? "" : ` ${constraint}`}`, () => {
      expect(shown(load(freshDb("v1"), base, new Set()))).toBe("loaded");
      const copy = fixtureOf(base);
      damage(copy);
      const refusal = load(freshDb("v1"), base, new Set(), copy);
      expect([refusal?.error.sqlstate, refusal?.error.constraint], shown(refusal)).toEqual([
        sqlstate,
        constraint,
      ]);
    });
  }

  it("keeps bundles_one_active to active rows (a partial unique key): a second bundle that is not active loads", () => {
    const copy = fixtureOf("seed-bundle-registry.json");
    copy.rows.push({
      table: "bundles",
      values: {
        hash: OTHER_HASH,
        build: 1,
        manifest_key: `bundle/${OTHER_HASH}/1/manifest`,
        built_at: "2026-11-08T08:00:00Z",
      },
    });
    expect(shown(load(freshDb("v1"), "seed-bundle-registry.json", new Set(), copy))).toBe("loaded");
  });

  it("takes a value as PostgreSQL text input: an integer as decimal digits and a boolean as a word load as their JSON forms do", () => {
    const copy = fixtureOf("seed-booking-head.json");
    const haircut = valuesWhere(copy, "id", "booking-alex-haircut");
    haircut.version = "7";
    haircut.private = "false";
    haircut.deceased = "off";
    const db = freshDb("v1");
    expect(shown(load(db, "seed-booking-head.json", new Set(), copy))).toBe("loaded");
    const row = must(db.rowsOf("bookings").find((candidate) => candidate.id === "booking-alex-haircut"));
    expect([row.version, row.private, row.deceased]).toEqual([7, false, false]);
    haircut.private = "maybe";
    const refusal = load(freshDb("v1"), "seed-booking-head.json", new Set(), copy);
    expect(refusal?.error.sqlstate, shown(refusal)).toBe("22P02");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. What the table list leaves to the README, modeled here

/**
 * README "Queue order": when a saved or booked time is released, the next in line is the waiting row of that resource
 * whose time overlaps it with the earliest queued_at, a tie broken by the lower id.
 */
export function nextInLine(rows: Row[], released: Row): string | null {
  const during = rangeArg(released.during ?? null);
  const waiting = rows.filter(
    (row) =>
      row.state === "waiting" &&
      sameValue(row.resource_id ?? null, released.resource_id ?? null) &&
      overlaps(rangeArg(row.during ?? null), during),
  );
  waiting.sort(
    (a, b) => order(a.queued_at ?? null, b.queued_at ?? null) || order(a.id ?? null, b.id ?? null),
  );
  const first = waiting[0];
  return first === undefined ? null : textArg(first.id ?? null);
}

/**
 * README, No double booking: a reservation of a class session raises taken by its seats in the same commit, so a class
 * session's taken is the seats its held and booked reservations hold.
 */
export function seatProblems(db: Database): string[] {
  return db.rowsOf("class_seats").flatMap((seat) => {
    const held = db
      .rowsOf("reservations")
      .filter(
        (row) =>
          sameValue(row.resource_id ?? null, seat.resource_id ?? null) &&
          (row.state === "held" || row.state === "booked"),
      )
      .reduce((sum, row) => sum + numberArg(row.seats ?? null), 0);
    return held === seat.taken
      ? []
      : [
          `${textArg(seat.resource_id ?? null)}: taken is ${JSON.stringify(seat.taken)}, its reservations hold ${String(held)}`,
        ];
  });
}

/**
 * README, Rows the frozen contracts need from K-04 (K-02): a versions_read reference {table, rowId, version} names a
 * versioned table, a row by its primary key and a version that row has reached.
 */
export function versionReadProblems(db: Database): string[] {
  const problems: string[] = [];
  for (const tableName of ["open_questions", "outbox_rows"]) {
    for (const row of db.rowsOf(tableName)) {
      const read = row.versions_read ?? null;
      if (!isTagged(read) || read.kind !== "jsonb" || !Array.isArray(read.value)) continue;
      for (const reference of read.value as { table: string; rowId: string; version: number }[]) {
        const where = `${tableName} ${textArg(row.id ?? null)}: ${JSON.stringify(reference)}`;
        const table = db.list.tables.find((candidate) => candidate.name === reference.table);
        if (table?.versioned !== true || table.primaryKey.length !== 1) {
          problems.push(`${where} names no versioned table with a one-column key`);
          continue;
        }
        const key = must(table.primaryKey[0]);
        const target = db.rowsOf(table.name).find((candidate) => candidate[key] === reference.rowId);
        const reached = target?.[must(table.versionColumn)];
        if (typeof reached !== "number") problems.push(`${where} names no row`);
        else if (reached < reference.version)
          problems.push(`${where} read a version the row has not reached`);
      }
    }
  }
  return problems;
}

// K-03 v1's shapes, for what the outbox row and the open question store (README, Rows the frozen contracts need).
const k03 = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
for (const folder of ["common", "bundle", "model", "message-plan"]) {
  const dir = path.join(CONTRACTS_ROOT, folder);
  for (const file of readdirSync(dir, { withFileTypes: true })) {
    if (file.isFile() && file.name.endsWith(".schema.json"))
      k03.addSchema(readJson(path.join(dir, file.name)) as object);
  }
}
const MESSAGE_PLAN_V1 = (
  readJson(path.join(CONTRACTS_ROOT, "message-plan", "message-plan.v1.schema.json")) as { $id: string }
).$id;
const k03Def = (def: string): ValidateFunction =>
  must(k03.getSchema(`${MESSAGE_PLAN_V1}#/$defs/${def}`), `K-03 v1 ${def}`);

/** The jsonb values of one column across the accepted fixtures of v1, from their rows as written. */
function storedValues(table: string, column: string): unknown[] {
  return ofVersion("v1", "accept")
    .flatMap((entry) => fixtureOf(entry.file).rows)
    .filter((row) => row.table === table && row.values[column] !== undefined && row.values[column] !== null)
    .map((row) => row.values[column]);
}

/** README rule 2: the tables whose rows are written once or only appended, which carry no version. */
const WRITTEN_ONCE_OR_APPENDED = ["bundle_values", "event_log", "handles", "openers_sent", "person_handles"];

/** A row's primary key as an update's `where`, in the README's input forms (text and integers). */
function keyOf(table: Table, row: Row): Record<string, unknown> {
  return Object.fromEntries(
    table.primaryKey.map((name) => {
      const value = row[name] ?? null;
      if (typeof value !== "string" && typeof value !== "number")
        throw new Error(`the model writes back only text and integer keys, not ${table.name}.${name}`);
      return [name, value];
    }),
  );
}

// README line 84 (rule 9): phone numbers in the 555-01xx range, emails at example.com. A phone number is found as
// E.164 (+ and 8 to 15 digits), as a North American number with or without separators, or as a local 555-0101.
const PHONE_LIKE =
  /\+\d{8,15}\b|\(\d{3}\)\s?\d{3}[ .-]\d{4}\b|\b\d{3}[ .-]\d{3}[ .-]\d{4}\b|(?<![\w+-])\d{3}-\d{4}(?![\w-])|(?<![\w+])1?\d{10}(?!\w)/g;
const IN_555_01XX = /^(?:1?\d{3})?55501\d{2}$/;
const EMAIL_LIKE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const AT_EXAMPLE_COM = /@(?:[\w-]+\.)*example\.com$/i;

/** Every string a fixture file holds, with its path: row values, jsonb inside them and a refused action alike. */
function stringsOf(value: unknown, at = ""): { at: string; text: string }[] {
  if (typeof value === "string") return [{ at, text: value }];
  if (Array.isArray(value)) return value.flatMap((item, place) => stringsOf(item, `${at}[${String(place)}]`));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).flatMap(([key, item]) => stringsOf(item, at === "" ? key : `${at}.${key}`));
  return [];
}

/** The phone numbers and emails a fixture file holds, and one line for each outside README line 84's ranges. */
function castOf(file: unknown): { phones: string[]; emails: string[]; problems: string[] } {
  const cast = { phones: [] as string[], emails: [] as string[], problems: [] as string[] };
  for (const { at, text } of stringsOf(file)) {
    for (const number of text.match(PHONE_LIKE) ?? []) {
      cast.phones.push(number);
      if (!IN_555_01XX.test(number.replace(/\D/g, "")))
        cast.problems.push(`${at}: ${number} is not in the 555-01xx range`);
    }
    for (const email of text.match(EMAIL_LIKE) ?? []) {
      cast.emails.push(email);
      if (!AT_EXAMPLE_COM.test(email)) cast.problems.push(`${at}: ${email} is not at example.com`);
    }
  }
  return cast;
}

describe("db-schema core fixtures: what the table list leaves to the README, each shown firing on a damaged copy", () => {
  for (const version of versions) {
    it(`README rule 2 (${version}): every versioned table has version integer not null default 1, and an update that does not raise it by one is refused by <table>_version_raised (23514, as migration 0002's trigger); the tables written once or appended carry none`, () => {
      const list = tableListOf(version);
      const unversioned = list.tables.filter((table) => !table.versioned).map((table) => table.name);
      expect(unversioned).toEqual(expect.arrayContaining(WRITTEN_ONCE_OR_APPENDED));
      if (version === "v1") expect([...unversioned].sort()).toEqual(WRITTEN_ONCE_OR_APPENDED);
      expect(list.tables.filter((table) => table.versioned).length).toBeGreaterThan(0);
      const db = loadedDb(
        acceptedUpTo(version).map((entry) => entry.file),
        version,
      );
      for (const table of list.tables) {
        const old = must(db.rowsOf(table.name)[0], `a row of ${table.name}`);
        const where = keyOf(table, old);
        const first = must(table.primaryKey[0]);
        const keyAsItIs = { [first]: where[first] };
        if (!table.versioned) {
          if (NEVER_EDITED.has(table.name)) {
            const refused = refusalOf(() => {
              db.update(RUNTIME, table.name, keyAsItIs, where);
            });
            expect(refused?.sqlstate, `${table.name} is never edited (rule 5)`).toBe("42501");
          } else {
            expect(db.update(RUNTIME, table.name, keyAsItIs, where), `${table.name} has no version`).toBe(1);
          }
          continue;
        }
        const column = must(table.versionColumn, `the version column of ${table.name}`);
        expect(
          table.columns.find((candidate) => candidate.name === column),
          table.name,
        ).toMatchObject({ name: "version", type: "integer", null: false, default: "1" });
        const reached = numberArg(old[column] ?? null);
        const unraisedUpdates: [string, Record<string, unknown>][] = [
          ["left out", keyAsItIs],
          ["unchanged", { [column]: reached }],
          ["skipped ahead", { [column]: reached + 2 }],
          ["null", { [column]: null }],
        ];
        for (const [what, set] of unraisedUpdates) {
          const refused = refusalOf(() => {
            db.update(RUNTIME, table.name, set, where);
          });
          expect([refused?.sqlstate, refused?.constraint], `${table.name}, its version ${what}`).toEqual([
            "23514",
            `${table.name}_version_raised`,
          ]);
        }
        expect(db.update(RUNTIME, table.name, { [column]: reached + 1 }, where), table.name).toBe(1);
        expect(must(db.select(RUNTIME, table.name, where)[0])[column], table.name).toBe(reached + 1);
      }
    });
  }

  it("README rule 2 on a damaged copy: refuse-seats-over-capacity's put-right (taken = 10) passes with set.version 4, one above the 3 it read, and is refused by class_seats_version_raised with 3, with 5 or with the version left out", () => {
    const file = "invalid/refuse-seats-over-capacity.json";
    const content = fixtureOf(file);
    const right = must(MENDS[file]).mend(structuredClone(must(content.refused)));
    const set = must(right.set);
    expect([set.taken, set.version, must(right.where).version]).toEqual([10, 4, 3]);
    const withVersion = (version: number | undefined): Outcome => {
      const db = freshDb("v1");
      expect(shown(load(db, file, new Set(), content))).toBe("loaded");
      const damaged = structuredClone(set);
      if (version === undefined) Reflect.deleteProperty(damaged, "version");
      else damaged.version = version;
      return run(db, { ...right, set: damaged });
    };
    const passed = withVersion(4);
    expect([passed.rows, passed.error?.message ?? null]).toEqual([1, null]);
    for (const version of [3, 5, undefined]) {
      const refused = withVersion(version);
      expect(
        [refused.error?.sqlstate, refused.error?.constraint],
        `set.version ${version === undefined ? "left out" : String(version)}`,
      ).toEqual(["23514", "class_seats_version_raised"]);
    }
  });

  it("README rule 4: a Tool API call sees and writes only its own business's rows, a row with no business is seen by no scope, the runtime side runs unscoped", () => {
    const db = loadedDb(["seed-event-log.json", "seed-booking-head.json"]);
    const barber = toolApi("biz-lees-barbershop");
    const yoga = toolApi("biz-yoga-studio");
    expect(db.select(barber, "event_log", { id: "evlog-0001" })).toHaveLength(1);
    expect(db.select(yoga, "event_log", { id: "evlog-0001" })).toHaveLength(0);
    expect(db.select(barber, "event_log", { id: "evlog-0003" })).toHaveLength(0);
    expect(db.select(RUNTIME, "event_log", { id: "evlog-0003" })).toHaveLength(1);
    expect(db.select(yoga, "persons", { id: "person-alex" }), "persons are not per business").toHaveLength(1);
    const booking = {
      id: "booking-alex-beard",
      business_id: "biz-lees-barbershop",
      flow: "A",
      booker_person_id: "person-alex",
    };
    const crossInsert = refusalOf(() => {
      db.insert(yoga, "bookings", booking);
    });
    expect(crossInsert?.sqlstate).toBe("42501");
    expect(
      refusalOf(() => {
        db.insert(barber, "bookings", booking);
      }),
    ).toBeNull();
    // The haircut is at version 7, so an update raises it to 8 (rule 2).
    const done = { stage: "done", version: 8 };
    expect(db.update(yoga, "bookings", done, { id: "booking-alex-haircut" }), "hidden").toBe(0);
    expect(
      db.update(yoga, "bookings", { stage: "done" }, { id: "booking-alex-haircut" }),
      "hidden, so the version trigger never sees it",
    ).toBe(0);
    expect(db.update(barber, "bookings", done, { id: "booking-alex-haircut" })).toBe(1);
    const unraised = refusalOf(() => {
      db.update(barber, "bookings", { business_id: "biz-yoga-studio" }, { id: "booking-alex-beard" });
    });
    expect(
      [unraised?.sqlstate, unraised?.constraint],
      "the version trigger fires before row-level security's check",
    ).toEqual(["23514", "bookings_version_raised"]);
    const moveOut = refusalOf(() => {
      db.update(
        barber,
        "bookings",
        { business_id: "biz-yoga-studio", version: 2 },
        { id: "booking-alex-beard" },
      );
    });
    expect([moveOut?.sqlstate, moveOut?.constraint]).toEqual(["42501", null]);
  });

  it("README rule 5: the event log is never edited by either side, while both insert and read it, and other tables update", () => {
    const db = loadedDb(["seed-event-log.json"]);
    for (const side of [RUNTIME, toolApi("biz-lees-barbershop")]) {
      const edit = refusalOf(() => {
        db.update(side, "event_log", { kind: "open_question.edited" }, { id: "evlog-0001" });
      });
      expect(edit?.sqlstate, side.role).toBe("42501");
      expect(db.select(side, "event_log", { id: "evlog-0001" }), side.role).toHaveLength(1);
    }
    expect(
      refusalOf(() => {
        db.insert(toolApi("biz-lees-barbershop"), "event_log", { ...evlog0001(), id: "evlog-0005" });
      }),
    ).toBeNull();
    expect(
      db.update(RUNTIME, "bookings", { stage: "done", version: 8 }, { id: "booking-alex-haircut" }),
    ).toBe(1);
    const readme = readFileSync(path.join(CORE_DIR, "README.md"), "utf8");
    expect(readme).toContain("**The event log is never edited**");
    expect(readme).toContain("**Row-level security per business**");
  });

  it("README file format: every fixture is in it, and a copy that leaves it is refused", () => {
    for (const entry of entries) expect(formatProblems(fixtureOf(entry.file)), entry.file).toEqual([]);
    const read = fixtureOf("invalid/refuse-cross-business-read.json");
    const turn = fixtureOf("invalid/refuse-duplicate-turn-id.json");
    const damaged: [string, unknown][] = [
      ["a field the format does not know", { ...fixtureOf("seed-flag.json"), notInTheFormat: 1 }],
      ["an after that is not a fixture file", { ...fixtureOf("seed-turn.json"), after: ["seed-turn"] }],
      ["a role that is neither side", { ...read, refused: { ...must(read.refused), role: "admin" } }],
      ["a Tool API call with no scope", { ...read, refused: { ...must(read.refused), scope: null } }],
      [
        "a runtime call with a scope",
        { ...turn, refused: { ...must(turn.refused), scope: { businessId: "biz-lees-barbershop" } } },
      ],
      ["a select that writes values", { ...read, refused: { ...must(read.refused), values: { id: "x" } } }],
      ["an insert with no values", { ...turn, refused: { ...must(turn.refused), values: undefined } }],
      [
        "an action that is none of the three",
        { ...turn, refused: { ...must(turn.refused), action: "delete" } },
      ],
      [
        "an expect of both an error and rows",
        { ...read, refused: { ...must(read.refused), expect: { rows: 0, sqlstate: "42501" } } },
      ],
    ];
    for (const [what, copy] of damaged) {
      const plain = JSON.parse(JSON.stringify(copy)) as unknown;
      expect(formatProblems(plain).length, what).toBeGreaterThan(0);
    }
    const accepted = { ...fixtureOf("seed-turn.json"), refused: must(turn.refused) };
    expect(checkEntry(must(acceptedEntries[0]), accepted).problems).toContain(
      "an accepted fixture holds no refused action",
    );
    const refused = fixtureOf("invalid/refuse-duplicate-turn-id.json");
    Reflect.deleteProperty(refused, "refused");
    expect(checkEntry(must(refusedEntries[0]), refused).problems).toContain(
      "a refused fixture names its refused action",
    );
  });

  it("README queue order: release promotes the waiting row with the earliest queued_at though it was inserted after, a tie by the lower id", () => {
    const db = loadedDb(["seed-reservation.json"]);
    const rows = db.rowsOf("reservations");
    const ids = rows.map((row) => row.id);
    const saved = must(rows.find((row) => row.id === "rsv-alex-saved-avery"));
    expect(ids.indexOf("rsv-agent-waiting-avery")).toBeGreaterThan(
      ids.indexOf("rsv-agent-waiting-avery-second"),
    );
    expect(nextInLine(rows, saved)).toBe("rsv-agent-waiting-avery");
    expect(
      nextInLine(rows, must(rows.find((row) => row.id === "rsv-alex-haircut"))),
      "Riley has no queue",
    ).toBeNull();
    const swapped = fixtureOf("seed-reservation.json");
    valuesWhere(swapped, "id", "rsv-agent-waiting-avery").queued_at = "2026-11-07T15:04:00Z";
    valuesWhere(swapped, "id", "rsv-agent-waiting-avery-second").queued_at = "2026-11-07T15:02:00Z";
    const swappedDb = freshDb("v1");
    expect(shown(load(swappedDb, "seed-reservation.json", new Set(), swapped))).toBe("loaded");
    expect(nextInLine(swappedDb.rowsOf("reservations"), saved)).toBe("rsv-agent-waiting-avery-second");
    const tied = fixtureOf("seed-reservation.json");
    valuesWhere(tied, "id", "rsv-agent-waiting-avery-second").queued_at = "2026-11-07T15:02:00Z";
    const tiedDb = freshDb("v1");
    expect(shown(load(tiedDb, "seed-reservation.json", new Set(), tied))).toBe("loaded");
    expect(nextInLine(tiedDb.rowsOf("reservations"), saved)).toBe("rsv-agent-waiting-avery");
  });

  it("README, No double booking: a class session's taken is the seats its held and booked reservations hold", () => {
    expect(seatProblems(loadedDb(["seed-class-seats.json"]))).toEqual([]);
    const damaged = fixtureOf("seed-class-seats.json");
    valuesWhere(damaged, "resource_id", "res-handstand-workshop").taken = 3;
    const db = freshDb("v1");
    expect(shown(load(db, "seed-class-seats.json", new Set(), damaged))).toBe("loaded");
    expect(seatProblems(db)).toEqual(["res-handstand-workshop: taken is 3, its reservations hold 2"]);
  });

  it("README (K-02): every versions_read names a versioned table's row and a version it has reached; booking v7 is read as v7", () => {
    const together = loadedDb(ofVersion("v1", "accept").map((entry) => entry.file));
    expect(versionReadProblems(together)).toEqual([]);
    expect(storedValues("open_questions", "versions_read")).toEqual([
      [{ table: "bookings", rowId: "booking-alex-haircut", version: 7 }],
    ]);
    const ahead = fixtureOf("seed-open-question.json");
    valuesWhere(ahead, "id", "oq-a7-03-alex").versions_read = [
      { table: "bookings", rowId: "booking-alex-haircut", version: 8 },
      { table: "handles", rowId: "handle-alex", version: 1 },
      { table: "phones", rowId: "booking-alex-haircut", version: 1 },
    ];
    const db = freshDb("v1");
    expect(shown(load(db, "seed-open-question.json", new Set(), ahead))).toBe("loaded");
    expect(versionReadProblems(db)).toHaveLength(3);
  });

  it("README (K-03): the outbox row stores K-03 v1's rowPlan and finalParts, the open question K-03's options, and a damaged one is not K-03's", () => {
    const rowPlan = k03Def("rowPlan");
    const finalParts = k03Def("finalParts");
    const option = k03Def("option");
    const plans = storedValues("outbox_rows", "plan");
    const finals = storedValues("outbox_rows", "final_parts");
    const options = storedValues("open_questions", "options").flatMap((value) => value as unknown[]);
    expect([plans.length, finals.length, options.length].every((count) => count > 0)).toBe(true);
    for (const plan of plans) expect(rowPlan(plan), formatErrors(rowPlan.errors).join("; ")).toBe(true);
    for (const parts of finals)
      expect(finalParts(parts), formatErrors(finalParts.errors).join("; ")).toBe(true);
    for (const item of options) expect(option(item), formatErrors(option.errors).join("; ")).toBe(true);
    expect(rowPlan({ ...(plans[0] as object), notInK03: 1 })).toBe(false);
    const parts = structuredClone(finals[0]) as { sends: { kind: string }[] };
    must(parts.sends[0]).kind = "voice";
    expect(finalParts(parts)).toBe(false);
    expect(option({ id: "A7-03/1" })).toBe(false);
  });

  it("README (K-03): outbox_rows_channel_known holds K-03 v1's channel list, no more and no less, and a channel outside it is refused", () => {
    const k03Channels = (
      readJson(path.join(CONTRACTS_ROOT, "message-plan", "message-plan.v1.schema.json")) as {
        $defs: { channel: { enum: string[] } };
      }
    ).$defs.channel.enum;
    expect(k03Channels.length).toBeGreaterThan(0);
    const check = must(
      tableOf(tableListOf("v1"), "outbox_rows").checks?.find(
        (each) => each.name === "outbox_rows_channel_known",
      ),
      "outbox_rows_channel_known",
    );
    const node = sqlOf(check.expression);
    if (node.op !== "in" || node.negated || node.arg.op !== "column")
      throw new Error(`outbox_rows_channel_known is not a column in a list: ${check.expression}`);
    expect(node.arg.name).toBe("channel");
    const listed = node.list.map((item) => (item.op === "literal" ? textArg(item.value) : "(not a literal)"));
    expect([...listed].sort()).toEqual([...k03Channels].sort());
    for (const channel of k03Channels) expect(holds(check.expression, { channel }), channel).toBe(true);
    const copy = fixtureOf("seed-outbox-row.json");
    valuesWhere(copy, "id", "out-a7-03-alex").channel = "voice";
    const refusal = load(freshDb("v1"), "seed-outbox-row.json", new Set(), copy);
    expect([refusal?.error.sqlstate, refusal?.error.constraint], shown(refusal)).toEqual([
      "23514",
      "outbox_rows_channel_known",
    ]);
  });

  it("README line 84 (rule 9): every phone number in the fixtures is in the 555-01xx range and every email at example.com; a copy with another is caught, though the table list takes it", () => {
    const found = entries.map((entry) => ({ file: entry.file, cast: castOf(fixtureOf(entry.file)) }));
    expect(found.flatMap(({ file, cast }) => cast.problems.map((line) => `${file}: ${line}`))).toEqual([]);
    expect(found.flatMap(({ cast }) => cast.phones).length).toBeGreaterThan(0);
    expect(found.flatMap(({ cast }) => cast.emails).length).toBeGreaterThan(0);
    for (const sample of ["(555) 555-0100", "555-555-0199", "5555550101", "555-0102"])
      expect(castOf({ words: sample }), sample).toEqual({ phones: [sample], emails: [], problems: [] });
    const copy = fixtureOf("seed-person-roles.json");
    valuesWhere(copy, "id", "handle-alex").address = "+15555550200";
    valuesWhere(copy, "id", "handle-alex-email").address = "alex@example.org";
    expect(shown(load(freshDb("v1"), "seed-person-roles.json", new Set(), copy))).toBe("loaded");
    expect(castOf(copy).problems).toEqual([
      "rows[7].values.address: +15555550200 is not in the 555-01xx range",
      "rows[12].values.address: alex@example.org is not at example.com",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. v1.1 (T-1290): each v1.1 refusal tied to its reason, what v1.1 adds, and every v1 case under v1.1's list
//
// README section "v1.1" (T-1273): a minor version of the two outbox tables, whose list restates the whole part (default
// 10), with five refused twins and no accepted seed (default 13). Section 1 checks each v1.1 entry against
// core.v1.1.tables.json, the SQL check reads its list and rule 2 holds its versioned tables. Here: each twin refused for
// its one reason and, put right as the README puts it (db-schema.core.twins.ts, from which the database side,
// db-schema.core.v1.db-side.test.ts, puts it right too), passing; each constraint v1.1 adds the one reason of one twin;
// v1.1 only adding to v1; and every v1 case holding under v1.1's list as under v1's.

const V1_1 = "v1.1";

/** The words of a table list (descriptions, sources, and an index's or a scope's why), which no rule reads. */
const WORDS = new Set(["description", "source", "why"]);

/** A part of a table list without its words, so two versions compare by their rules alone. */
function rulesOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rulesOf);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !WORDS.has(key))
      .map(([key, item]) => [key, rulesOf(item)]),
  );
}

/** Every named constraint of a version's list (primary key, unique, EXCLUDE, CHECK, foreign key) by name, with its rule. */
function constraintRules(version: string): Map<string, unknown> {
  return new Map(
    tableListOf(version).tables.flatMap((table): [string, unknown][] => [
      [primaryKeyName(table.name), table.primaryKey],
      ...(table.unique ?? []).map((key): [string, unknown] => [uniqueName(table.name, key), rulesOf(key)]),
      ...(table.exclude ?? []).map((exclusion): [string, unknown] => [exclusion.name, rulesOf(exclusion)]),
      ...(table.checks ?? []).map((check): [string, unknown] => [check.name, rulesOf(check)]),
      ...(table.foreignKeys ?? []).map((key): [string, unknown] => [
        key.name ?? `${table.name}_${key.columns.join("_")}_fkey`,
        rulesOf(key),
      ]),
    ]),
  );
}

/** The constraints a refused fixture's `expect` names. */
const namedBy = (entry: FixtureEntry): string[] =>
  must(fixtureOf(entry.file).refused, `${entry.file}'s refused action`).expect.constraintOneOf ?? [];

describe("db-schema core v1.1 fixtures: each refused one refused for its one reason, and put right it passes", () => {
  it("has a way to put right every v1.1 refused fixture, as the README's table Refused rows (v1.1) gives each one's fault", () => {
    expect(ofVersion(V1_1, "refuse").length).toBeGreaterThan(0);
    expect(Object.keys(PUT_RIGHT_V1_1).sort()).toEqual(
      ofVersion(V1_1, "refuse")
        .map((entry) => entry.file)
        .sort(),
    );
  });

  for (const entry of ofVersion(V1_1, "refuse")) {
    const fix = PUT_RIGHT_V1_1[entry.file];
    it(`refuses ${entry.file} because ${fix?.reason ?? "(no way to put it right)"}; put right (${fix?.putRight ?? ""}), the same action passes`, () => {
      const right = must(fix, `a way to put right ${entry.file}`);
      expect(right.reason).not.toBe("");
      const content = fixtureOf(entry.file);
      const action = must(content.refused, "the refused action");
      const db = freshDb(entry.version);
      expect(shown(load(db, entry.file, new Set(), content))).toBe("loaded");
      expect(expectProblems(run(db, action), action.expect)).toEqual([]);
      const mended = putRight(action, right);
      expect(differences(action, mended)).toEqual([right.at]);
      const again = freshDb(entry.version);
      expect(shown(load(again, entry.file, new Set(), content))).toBe("loaded");
      const passed = run(again, mended);
      expect(passed.error?.message ?? null).toBeNull();
      expect(passed.rows).toBe(1);
    });
  }

  it("refuses each v1.1 refused fixture by one constraint v1.1 adds: every constraint new in core.v1.1.tables.json is the one reason of exactly one of them, and v1's list holds none", () => {
    const before = constraintRules("v1");
    const added = [...constraintRules(V1_1).keys()].filter((name) => !before.has(name));
    expect(added.length).toBeGreaterThan(0);
    const reasons = ofVersion(V1_1, "refuse").map((entry) => ({ file: entry.file, names: namedBy(entry) }));
    for (const { file, names } of reasons) expect(names, `${file} names its one reason`).toHaveLength(1);
    expect(reasons.flatMap(({ names }) => names).sort()).toEqual([...added].sort());
  });

  it("puts a twin right at one value of a copy: the refused action is left as it was, and a way that names no values.<column> or set.<column>, or a part the action lacks, is a broken test", () => {
    const file = "invalid/refuse-delivered-part-without-time.json";
    const action = must(fixtureOf(file).refused);
    const fix = must(PUT_RIGHT_V1_1[file]);
    expect(must(putRight(action, fix).set).delivered_at).toBe(fix.value);
    expect(must(action.set).delivered_at, "the refused action is left as it was").toBeNull();
    expect(() => putRight(action, { ...fix, at: "delivered_at" })).toThrow("names no values.<column>");
    expect(() => putRight(action, { ...fix, at: "values.delivered_at" })).toThrow("has no values");
  });
});

describe("db-schema core v1.1: every v1 case holds under core.v1.1.tables.json as under core.v1.tables.json", () => {
  it("README section v1.1, Kind: v1.1 only adds to v1 (every v1 table and column kept with its type and default, null dropped from outbox_rows.turn_id alone; each column it adds nullable with no default, after v1's; every v1 constraint, row-level security and version kept)", () => {
    const v1 = tableListOf("v1");
    const later = tableListOf(V1_1);
    expect(later.tables.map((table) => table.name)).toEqual(v1.tables.map((table) => table.name));
    const nullChanged: string[] = [];
    for (const table of v1.tables) {
      const kept = tableOf(later, table.name);
      expect(
        kept.columns.slice(0, table.columns.length).map((column) => column.name),
        `${table.name}: v1's columns first, in v1's order`,
      ).toEqual(table.columns.map((column) => column.name));
      for (const [at, column] of table.columns.entries()) {
        const now = must(kept.columns[at], `${table.name}.${column.name} in v1.1`);
        expect([now.type, now.default], `${table.name}.${column.name}`).toEqual([
          column.type,
          column.default,
        ]);
        if (now.null !== column.null)
          nullChanged.push(`${table.name}.${column.name} null ${String(column.null)} to ${String(now.null)}`);
      }
      for (const column of kept.columns.slice(table.columns.length))
        expect([column.null, column.default], `${table.name}.${column.name}, added in v1.1`).toEqual([
          true,
          undefined,
        ]);
      expect(rulesOf(kept.rowLevelSecurity), table.name).toEqual(rulesOf(table.rowLevelSecurity));
      expect([kept.versioned, kept.versionColumn], table.name).toEqual([
        table.versioned,
        table.versionColumn,
      ]);
    }
    expect(nullChanged).toEqual(["outbox_rows.turn_id null false to true"]);
    const after = constraintRules(V1_1);
    for (const [name, rule] of constraintRules("v1")) expect(after.get(name), name).toEqual(rule);
  });

  for (const entry of ofVersion("v1", "refuse")) {
    const mend = MENDS[entry.file];
    it(`refuses ${entry.file} under v1.1's list as under v1's, because ${mend?.reason ?? "(no mend)"}; put right (${mend?.putRight ?? ""}), the same action passes there`, () => {
      const { mend: putRightV1 } = must(mend, `a mend for ${entry.file}`);
      const content = fixtureOf(entry.file);
      const action = must(content.refused, "the refused action");
      const db = freshDb(V1_1);
      expect(shown(load(db, entry.file, new Set(), content))).toBe("loaded");
      expect(expectProblems(run(db, action), action.expect)).toEqual([]);
      const again = freshDb(V1_1);
      expect(shown(load(again, entry.file, new Set(), content))).toBe("loaded");
      const passed = run(again, putRightV1(structuredClone(action)));
      expect(passed.error?.message ?? null).toBeNull();
      expect(passed.rows).toBe(1);
    });
  }

  for (const { base, does, damage, sqlstate, constraint } of DAMAGES) {
    it(`${base} with ${does}, under v1.1's list: ${sqlstate}${constraint === null ? "" : ` ${constraint}`}`, () => {
      expect(shown(load(freshDb(V1_1), base, new Set()))).toBe("loaded");
      const copy = fixtureOf(base);
      damage(copy);
      const refusal = load(freshDb(V1_1), base, new Set(), copy);
      expect([refusal?.error.sqlstate, refusal?.error.constraint], shown(refusal)).toEqual([
        sqlstate,
        constraint,
      ]);
    });
  }

  it("README section v1.1 (turn_id becomes nullable): the tour's outbox row without its turn id, refused by not null under v1, is refused by outbox_rows_turn_or_job under v1.1, and with a job id in its place v1.1 takes it", () => {
    const withoutTurn = fixtureOf("seed-outbox-row.json");
    Reflect.deleteProperty(valuesWhere(withoutTurn, "id", "out-a7-03-alex"), "turn_id");
    const underV1 = load(freshDb("v1"), "seed-outbox-row.json", new Set(), withoutTurn);
    expect([underV1?.error.sqlstate, underV1?.error.column], shown(underV1)).toEqual(["23502", "turn_id"]);
    const underV1dot1 = load(freshDb(V1_1), "seed-outbox-row.json", new Set(), withoutTurn);
    expect([underV1dot1?.error.sqlstate, underV1dot1?.error.constraint], shown(underV1dot1)).toEqual([
      "23514",
      "outbox_rows_turn_or_job",
    ]);
    // The minute sweep's job id of seed-event-log.json's write with no turn (evlog-0003) stands in for the work's own:
    // README section v1.1 names a clock firing with no turn (CQ-28) as the next work to write such a row.
    valuesWhere(withoutTurn, "id", "out-a7-03-alex").job_id = must(
      fixtureOf("seed-event-log.json").rows.find((row) => row.values.id === "evlog-0003"),
      "evlog-0003",
    ).values.job_id;
    expect(shown(load(freshDb(V1_1), "seed-outbox-row.json", new Set(), withoutTurn))).toBe("loaded");
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
 * contracts/db-schema/core/README.md "Producers and consumers" (02-contracts K-04). Each side is added later by a QA side
 * task that depends on this task and on that side's build task: it fills `check` (and moves its own test beside this
 * one). Until then the side is held here with what it must show, so none is forgotten.
 */
export const SIDE_CHECKS: readonly SideCheck[] = [
  {
    id: "producer-database",
    side: "producer",
    owner: "database engineer",
    components: [
      "C-150 schema baseline",
      "C-151 core tables",
      "C-153 row-level security",
      "C-154 migrations queue",
      "C-155 seeds from fixture set v1",
      "C-156 per-person sealing keys",
      "C-135 double-booking guard",
    ],
    needs:
      "02-contracts K-04 \"Contract test\" and section 2 item 12, against PostgreSQL: migrate a fresh schema; compare the catalog with the table list (every table and column with its type, null and default, every primary key, foreign key, unique key, EXCLUDE, CHECK and index, the row-level security of each business-scoped table, btree_gist, and the README's rules beyond the list: versions, text ids, commit_seq as an identity, the event log's privileges, the sealed fields), allowing the triggers those rules need (DL-110 (5)): 0011's event_log_never_edited, and 0002's <table>_version_raised on each versioned table, which refuses an update that does not raise the version by one with 23514 before row-level security's check, as this file's model does; load the seeds, all accepted fixtures together and each alone with its after chain; and refuse the refused rows with the SQLSTATE and constraint each names, each passing once its one fault is removed, as this file's model shows. Two rules stay in code, with no trigger: reservations.queued_at is written with the row and never changed (README, Queue order), and bookings.flow is written once at booking (the table list's writtenOnceAtBooking).",
  },
  {
    id: "consumer-action-layer",
    side: "consumer",
    owner: "action-layer engineer",
    components: [
      "C-075 frontier builder",
      "C-087 one commit per turn",
      "C-100 reservations",
      "C-134 saved-time rules",
    ],
    needs:
      "Through K-05, on these seeds: accepts every valid fixture's rows and refuses every invalid one; the commit compares and sets each row's version and writes once per turn id; reserve takes an overlapping held or booked time's 23P01 and a class seat past capacity's 23514 as refusals; release promotes the next in line by queued_at, a tie by the lower id; every Tool API call is scoped to one business and sees no other business's rows.",
  },
  {
    id: "consumer-runtime",
    side: "consumer",
    owner: "runtime engineer",
    components: [
      "C-046 handle actor",
      "C-049 turn lease",
      "C-050 bundle pin",
      "C-051 guard",
      "C-054 clock rows, alarm and sweep",
      "C-055 clock arming",
      "C-124 outbox dispatcher",
      "C-125 limit 8 at send",
    ],
    needs:
      "As the unscoped runtime side, on these seeds: accepts every valid fixture's rows and refuses every invalid one; a second commit of a turn id is refused (23505) and read as already committed; the guard reads the phone (chat open, stopped with its stop time) and the handle's bookings; the bundle pin reads the one active bundle; clock rows arm at the first delivery receipt and fire when due, the job rows by the minute sweep; the dispatcher sends outbox parts under their (row, part, try) keys in commit order; limit 8 reads the business's text hours.",
  },
  {
    id: "consumer-release",
    side: "consumer",
    owner: "release engineer",
    components: ["C-013 flags", "C-018 breach and latency monitor", "C-020 deploy script"],
    needs:
      "Accepts every valid fixture's rows and refuses every invalid one; reads release flags by scope (global, business:<id>, phone:<number>); the deploy script publishes the bundle and its copy, then switches the active id, never two active (bundles_one_active); the monitor reads the event log's trace ids.",
  },
  {
    id: "consumer-database-staging",
    side: "consumer",
    owner: "database engineer",
    components: ["C-202 staging seeded state"],
    needs:
      "Staging's seeded state loads these seed fixtures, each with its after chain, and none of the refused rows: accepts every valid fixture and refuses every invalid one.",
  },
  {
    id: "consumer-qa",
    side: "consumer",
    owner: "QA",
    components: ["C-147 scenario tests"],
    needs:
      "The scenario tests start from the seeded state these fixtures give (fixture set v1's demo shops and the master's sample cast, never a real person) and expect the refused rows refused: accepts every valid fixture and refuses every invalid one.",
  },
];

/**
 * The owner groups of the README's "- **Producers:**" or "- **Consumers:**" line: "<owner>[ (...)]: <components>",
 * separated by "; " (an owner is followed by its first ": "; a component may hold one inside its parentheses).
 */
function ownerGroups(
  listed: string,
  label: "Producers" | "Consumers",
): { owner: string; components: string }[] {
  const lead = `- **${label}:** `;
  const line = must(
    listed.split("\n").find((text) => text.startsWith(lead)),
    `the README's ${label} line`,
  );
  return line
    .slice(lead.length)
    .replace(/[.]$/, "")
    .split("; ")
    .map((group) => {
      const at = group.indexOf(": ");
      if (at < 0) throw new Error(`an owner group with no owner: ${group}`);
      return { owner: group.slice(0, at), components: group.slice(at + 2) };
    });
}

describe("db-schema.core.v1 sides: the list where each producer and consumer side is added", () => {
  const readme = readFileSync(path.join(CORE_DIR, "README.md"), "utf8");
  const start = readme.indexOf("## Producers and consumers");
  const listed = readme.slice(start, readme.indexOf("## Defaults used", start));

  it("names each side once, with the producers and consumers of the README", () => {
    const ids = SIDE_CHECKS.map((side) => side.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SIDE_CHECKS.filter((side) => side.side === "producer")).toHaveLength(1);
    expect(SIDE_CHECKS.filter((side) => side.side === "consumer")).toHaveLength(5);
    for (const side of SIDE_CHECKS) {
      expect(side.owner, side.id).not.toBe("");
      expect(side.components.length, side.id).toBeGreaterThan(0);
      expect(side.needs, side.id).not.toBe("");
      if (side.side === "consumer") expect(side.needs, side.id).toMatch(/refuses every invalid/i);
    }
  });

  it("names every component the README's producers and consumers list, and no other", () => {
    expect(start).toBeGreaterThan(-1);
    const named = new Set(listed.match(/C-\d{3}/g));
    const held = new Set(SIDE_CHECKS.flatMap((side) => side.components.join(" ").match(/C-\d{3}/g) ?? []));
    expect(named.size).toBeGreaterThan(20);
    expect([...held].sort()).toEqual([...named].sort());
  });

  it("spells each side's owner and components as the README does", () => {
    for (const side of SIDE_CHECKS) {
      expect(listed, side.id).toContain(side.owner);
      for (const component of side.components) expect(listed, side.id).toContain(component);
    }
  });

  it("puts each side's components under its own owner, in the README's Producers or Consumers line, each owner's group held by one side", () => {
    for (const kind of ["producer", "consumer"] as const) {
      const sides = SIDE_CHECKS.filter((side) => side.side === kind);
      const groups = ownerGroups(listed, kind === "producer" ? "Producers" : "Consumers");
      expect(groups.length, kind).toBe(sides.length);
      for (const group of groups) {
        const owners = sides.filter(
          (side) => group.owner === side.owner || group.owner.startsWith(`${side.owner} (`),
        );
        expect(
          owners.map((side) => side.id),
          `${kind}s: ${group.owner}`,
        ).toHaveLength(1);
        const side = must(owners[0]);
        for (const component of side.components) expect(group.components, side.id).toContain(component);
        expect(new Set(group.components.match(/C-\d{3}/g)), side.id).toEqual(
          new Set(side.components.join(" ").match(/C-\d{3}/g)),
        );
      }
    }
  });

  it("carries in the producer's needs the triggers its catalog check allows (DL-110 (5)) and the two rules that stay in code", () => {
    const producer = must(SIDE_CHECKS.find((side) => side.side === "producer"));
    for (const named of [
      "event_log_never_edited",
      "<table>_version_raised",
      "queued_at",
      "writtenOnceAtBooking",
    ])
      expect(producer.needs, named).toContain(named);
  });

  for (const side of SIDE_CHECKS) {
    if (side.check === undefined) continue;
    const check = side.check;
    it(`${side.side} side ${side.id}`, () => {
      expect(check()).toEqual([]);
    });
  }
});
