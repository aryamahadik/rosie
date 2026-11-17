// Contract test for K-05 v1.18, the catalog's five reads: what is v1.18's own in the fixture part (T-1434; T-1427's
// handoff; DL-888, DL-903, DL-911, DL-927; contracts/data-access/README.md section "v1.18": "The calls v1.18 adds", items
// 72 to 77, defaults 152 to 166, "Consumers of v1.18", and "Fixtures", v1.18).
//
// K-05's contract test holds v1.18 in three files. data-access.v1.test.ts checks every fixture of every version against
// the schema of its version, every accepted one's required fields and closed objects, its given and its cast's numbers
// (its parts 1, 3 and 4), and, with v1.18 in its WRITTEN_FOR, ties each v1.18 refusal to its reason with its mend (its
// part 2, MENDS) and holds v1.18's consumers in its side list (SIDE_CHECKS: C-096 and C-082 beside C-152).
// data-access.v1.18.db-side.test.ts is v1.18's database side, every fixture through db/repo's five reads (T-1428). This
// file proves the rest, reading only the committed schemas, fixtures and README:
//   1. v1.18's fixtures, selected by their version, never by a pinned list or count (DL-124, DL-125): each against
//      data-access.v1.18.schema.json at its own definition, accepted or refused as the index marks it; the calls the
//      schema adds (its exchanges that v1.17's lacks) are the README's five ("The calls v1.18 adds", items 72 to 76),
//      each shown by an accepted exchange, and no v1.18 fixture is another call's; each accepted exchange's outcome is
//      its call's response or one of its errors; and every accepted fixture of v1 to v1.17 passes the same definition of
//      v1.18 (README "Fixtures", v1.18: "every v1 to v1.17 fixture also passes v1.18").
//   2. each refused fixture for its one fault, mended into its twin (README "Fixtures", v1.18: "each for one reason: put
//      right, each is its accepted twin's"): its twin and the part of it the README names (the request of a refused
//      exchange, whose given and outcome are its twin's; the outcome of a refused answer); refused as it stands, by
//      errors that name its fault; differing from its twin only at the fault; and with the fault taken from the twin,
//      accepted, and the twin itself. The proof is shown firing on damaged twins.
//   3. what the schema leaves to the fixtures, read from every accepted exchange and shown firing on damaged copies: each
//      answer is its request's (the business, the service and the time echoed: default 165) at its read's moment (readAt,
//      the database's now(), which given.now fixes); a notFound names the request's business alone; every row is the
//      request's business's, and a way, a price rule or a tie the request's service's (default 154: nothing under another
//      business); item 77's names, each built from the row's own key in the key's order (default 163); every list in its
//      order (default 164); a price rule answered only while its effective_to is null or after at (default 157), and a
//      rule or a price OK limit only while its [effectiveFrom, effectiveTo) holds at (default 159).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { CONTRACTS_ROOT, formatErrors, type FixtureEntry } from "./_harness";

// ---------------------------------------------------------------------------------------------------------------
// The contract's files

const DATA_ACCESS_DIR = path.join(CONTRACTS_ROOT, "data-access");
const FIXTURES_DIR = path.join(DATA_ACCESS_DIR, "fixtures");
/** The version this file is written for, and the one before it, which it only adds to. */
const VERSION = "v1.18";
const BEFORE = "v1.17";

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

const index = readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: FixtureEntry[] };
const entries = index.fixtures;
/** v1.18's entries, selected by their version (DL-124, DL-125). */
const ofVersion = entries.filter((entry) => entry.version === VERSION);
const accepted = ofVersion.filter((entry) => entry.expect === "accept");
const refused = ofVersion.filter((entry) => entry.expect === "refuse");
/** Every accepted fixture of a version before v1.18. */
const earlierAccepted = entries.filter((entry) => entry.version !== VERSION && entry.expect === "accept");
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

/** `<call>.<part>`: the call a definition belongs to, and its part (exchange, response, errors). */
function defOf(entry: FixtureEntry): { call: string; part: string } {
  const def = must(entry.def, `${entry.file}'s def`);
  const dot = def.lastIndexOf(".");
  if (dot < 1) throw new Error(`${entry.file}: ${def} is no <call>.<part> definition`);
  return { call: def.slice(0, dot), part: def.slice(dot + 1) };
}

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

const idOf = (version: string): string =>
  (readJson(path.join(DATA_ACCESS_DIR, `data-access.${version}.schema.json`)) as { $id: string }).$id;
const keyOf = (version: string, def: string | undefined): string =>
  def === undefined ? idOf(version) : `${idOf(version)}#/$defs/${def}`;

/** The strict validator of one definition (or the root) of a version's schema. */
function validatorOf(version: string, def: string | undefined): ValidateFunction {
  return must(ajv.getSchema(keyOf(version, def)), `the schema ${keyOf(version, def)}`);
}

/** The places the schema's errors name in a value: each error's path, with the field a required error misses. */
function errorPlaces(version: string, def: string | undefined, value: unknown): string[] {
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

/** The exchanges a version's schema names at its root. */
function exchangesOf(version: string): string[] {
  const root = must(schemaById.get(idOf(version)), `the schema of ${version}`) as {
    anyOf?: { $ref?: string }[];
  };
  return (root.anyOf ?? []).map((branch) => must(branch.$ref).replace("#/$defs/", ""));
}

/** The calls v1.18 adds: the exchanges its schema names that v1.17's does not. */
const ADDED_CALLS = exchangesOf(VERSION)
  .filter((def) => !exchangesOf(BEFORE).includes(def))
  .map((def) => def.replace(/[.]exchange$/, ""));

// Compiled while the file loads, so no test pays for a first compile: each v1.18 entry's definition, with every error
// for a refused one, and v1.18's own definition of each earlier accepted fixture, which part 1 checks it against.
for (const entry of ofVersion) {
  validatorOf(entry.version, entry.def);
  if (entry.expect === "refuse") errorPlaces(entry.version, entry.def, null);
}
for (const entry of earlierAccepted) validatorOf(VERSION, entry.def);
for (const call of ADDED_CALLS) {
  validatorOf(VERSION, `${call}.response`);
  validatorOf(VERSION, `${call}.errors`);
}

// ---------------------------------------------------------------------------------------------------------------
// The README

const readme = readFileSync(path.join(DATA_ACCESS_DIR, "README.md"), "utf8");
const readmeLines = readme.split("\n");

/** A README section's text, from its heading to the next heading of its level or above. */
function sectionOf(heading: string): string {
  const start = readme.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`the README has no ${heading}`);
  const rest = readme.slice(start + heading.length + 2);
  const level = must(/^#+/.exec(heading), `${heading}'s level`)[0].length;
  const end = rest.search(new RegExp(`\\n#{1,${String(level)}} `));
  return end < 0 ? rest : rest.slice(0, end);
}

/** README "The calls v1.18 adds": each bullet's call and its item, "- **`readBusinessKinds`** (item 72): ...". */
const README_CALLS = [
  ...sectionOf("### The calls v1.18 adds").matchAll(/^- \*\*`(\w+)`\*\* \(item (\d+)\)/gm),
].map((match) => ({ call: must(match[1]), item: Number(match[2]) }));

/** README "Fixtures": the paragraph of v1.18's fixtures, which names each refused one's twin. */
const FIXTURES_PARAGRAPH = must(
  readmeLines.find((line) => line.startsWith(`**${VERSION}** (listed with`)),
  `the README's ${VERSION} fixtures paragraph`,
);

// ---------------------------------------------------------------------------------------------------------------
// 1. v1.18's fixtures against the schema of v1.18

describe("data-access v1.18: each fixture, selected by its version, against data-access.v1.18.schema.json", () => {
  it("selects accepted and refused fixtures of v1.18, each of a call v1.18 adds, and the calls it adds are the README's five, items 72 to 76", () => {
    expect(accepted.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
    expect(README_CALLS.map(({ call }) => call).sort()).toEqual([...ADDED_CALLS].sort());
    expect(README_CALLS.map(({ item }) => item)).toEqual([72, 73, 74, 75, 76]);
    for (const entry of ofVersion) {
      expect(ADDED_CALLS, `${entry.file}: a call v1.18 adds`).toContain(defOf(entry).call);
    }
    for (const call of ADDED_CALLS) {
      expect(
        accepted.filter((entry) => entry.def === `${call}.exchange`).length,
        `${call}: an accepted exchange`,
      ).toBeGreaterThan(0);
    }
  });

  for (const entry of ofVersion) {
    it(`${entry.expect === "accept" ? "accepts" : "refuses"} ${entry.file} (${entry.def ?? "root"})`, () => {
      const validate = validatorOf(VERSION, entry.def);
      const valid = validate(fixture(entry.file));
      expect(valid, formatErrors(validate.errors).join("; ")).toBe(entry.expect === "accept");
    });
  }

  it("answers each accepted exchange with its call's response or one of its errors, and names its own call", () => {
    for (const entry of accepted) {
      const { call, part } = defOf(entry);
      expect(part, entry.file).toBe("exchange");
      const exchange = fixture(entry.file) as { call: string; outcome: unknown };
      expect(exchange.call, entry.file).toBe(call);
      const isError = isRecord(exchange.outcome) && "error" in exchange.outcome;
      const validate = validatorOf(VERSION, `${call}.${isError ? "errors" : "response"}`);
      expect(validate(exchange.outcome), `${entry.file}: ${formatErrors(validate.errors).join("; ")}`).toBe(
        true,
      );
    }
    expect(
      accepted.some((entry) => {
        const { outcome } = fixture(entry.file) as { outcome: unknown };
        return isRecord(outcome) && "error" in outcome;
      }),
      "a notFound shown",
    ).toBe(true);
  });

  it("has every accepted fixture of v1 to v1.17 pass the same definition of v1.18 (a minor version only adds)", () => {
    expect(earlierAccepted.length).toBeGreaterThan(0);
    for (const entry of earlierAccepted) {
      const validate = validatorOf(VERSION, entry.def);
      expect(
        validate(fixture(entry.file)),
        `${entry.file} (${entry.version}) under ${VERSION}: ${formatErrors(validate.errors).join("; ")}`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Each refused fixture for its one fault, mended into its twin

/** The part of its twin a refused fixture is, as the README names it: a refused exchange's request, or an outcome. */
type TwinPart = "request" | "outcome";

interface Twin {
  /** The accepted v1.18 exchange the README names as the refused fixture's twin. */
  twin: string;
  /** "request": the fixture is its twin's exchange with one fault in the request; "outcome": its twin's outcome. */
  part: TwinPart;
  /** The places in the refused fixture that carry its one fault. */
  faults: string[];
}

/**
 * Each refused v1.18 fixture's twin, as README "Fixtures" (v1.18) names it ("twin `read-business-kinds-barbershop`, its
 * request"), with the places of its one fault.
 */
const TWINS: Readonly<Record<string, Twin>> = {
  "invalid/refuse-business-kinds-no-business.json": {
    twin: "read-business-kinds-barbershop.json",
    part: "request",
    faults: ["request.businessId"],
  },
  "invalid/refuse-business-kinds-row-by-kind-id.json": {
    twin: "read-business-kinds-lee-home-services.json",
    part: "outcome",
    faults: ["kinds.1.rowId"],
  },
  "invalid/refuse-business-kinds-setup-listing-phone.json": {
    twin: "read-business-kinds-barbershop.json",
    part: "outcome",
    faults: ["setup.listingPhone"],
  },
  "invalid/refuse-business-services-with-extras.json": {
    twin: "read-business-services-lee-home-services.json",
    part: "outcome",
    faults: ["services.0.extras"],
  },
  "invalid/refuse-service-ways-no-service.json": {
    twin: "read-service-ways-haircut.json",
    part: "request",
    faults: ["request.serviceId"],
  },
  "invalid/refuse-service-ways-cutoff-as-interval.json": {
    twin: "read-service-ways-skin-fade.json",
    part: "outcome",
    faults: ["ways.0.cutoffBeforeMinutes"],
  },
  "invalid/refuse-price-rules-at-with-offset.json": {
    twin: "read-price-rules-haircut-before-raise.json",
    part: "request",
    faults: ["request.at"],
  },
  "invalid/refuse-terms-sources-caller-flow.json": {
    twin: "read-terms-sources-dee-skin-fade.json",
    part: "request",
    faults: ["request.flow"],
  },
  "invalid/refuse-terms-sources-rule-with-words.json": {
    twin: "read-terms-sources-dee-skin-fade.json",
    part: "outcome",
    faults: ["rules.0.words"],
  },
};

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

/** The dotted paths at which two JSON values differ; an array whose length changed differs as a whole. */
function differences(a: unknown, b: unknown, at = ""): string[] {
  if (isDeepStrictEqual(a, b)) return [];
  const inside = (step: string | number): string => (at === "" ? String(step) : `${at}.${String(step)}`);
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.flatMap((item: unknown, place) => differences(item, b[place], inside(place)));
  }
  if (isRecord(a) && isRecord(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
      differences(a[key], b[key], inside(key)),
    );
  }
  return [at];
}

/** Whether a place is the field at `at` or inside it. */
const within = (place: string, at: string): boolean => place === at || place.startsWith(`${at}.`);
/** Whether a place is the field at `at`, inside it, or an object that holds it (never the whole value). */
const near = (place: string, at: string): boolean =>
  within(place, at) || (place !== "" && at.startsWith(`${place}.`));

/** The twin's value the refused fixture is, put right: its whole exchange for a refused request, else its outcome. */
const twinValue = (twin: Twin): unknown =>
  twin.part === "request" ? fixture(twin.twin) : valueAt(fixture(twin.twin), "outcome");

/** A copy of `value` with each fault taken from `right`: its value there, or taken out where `right` holds none. */
function mended(value: unknown, right: unknown, faults: readonly string[]): unknown {
  const copy = structuredClone(value);
  for (const fault of faults) {
    const steps = stepsOf(fault);
    const last = must(steps.pop(), `the last step of ${fault}`);
    const parent = valueAt(copy, steps.join("."));
    if (!isRecord(parent) && !Array.isArray(parent)) throw new Error(`${fault} is inside no object`);
    const from = lookUp(right, fault);
    if (from.found) Reflect.set(parent, last, structuredClone(from.value));
    else Reflect.deleteProperty(parent, last);
  }
  return copy;
}

/** A fixture's name as the README writes it: its file's name, without its folder or .json. */
const nameOf = (file: string): string => path.posix.basename(file, ".json");

/** How README "Fixtures" (v1.18) names a refused fixture's twin: "(`refused`, by `def`; twin `twin`, its part)". */
const readmeTwinPhrase = (entry: FixtureEntry, twin: Twin): string =>
  `(\`${nameOf(entry.file)}\`, by \`${must(entry.def)}\`; twin \`${nameOf(twin.twin)}\`, its ${twin.part})`;

/**
 * Each way a refused fixture fails to be its twin with one fault, none when it is: refused as it stands; the schema's
 * errors name its fault; it differs from its twin's part only at the fault, and at each fault; with each fault taken
 * from the twin, it is accepted, and is the twin's part.
 */
export function twinProblems(
  entry: FixtureEntry,
  twin: Twin,
  value: unknown = fixture(entry.file),
): string[] {
  const problems: string[] = [];
  const validate = validatorOf(entry.version, entry.def);
  if (validate(value)) problems.push(`${entry.file} is accepted as it stands`);
  const named = errorPlaces(entry.version, entry.def, value);
  if (!named.some((place) => twin.faults.some((fault) => near(place, fault)))) {
    const names = named.length === 0 ? "" : `: ${named.join("; ")}`;
    problems.push(`the schema's errors name none of ${twin.faults.join(", ")}${names}`);
  }
  const right = twinValue(twin);
  const differ = differences(value, right);
  for (const place of differ) {
    if (!twin.faults.some((fault) => within(place, fault))) {
      problems.push(`it differs from ${twin.twin} at ${place}, which is not the fault`);
    }
  }
  for (const fault of twin.faults) {
    if (!differ.some((place) => within(place, fault) || within(fault, place))) {
      problems.push(`the fault ${fault} is not where it differs from ${twin.twin}`);
    }
  }
  const mend = mended(value, right, twin.faults);
  if (!validate(mend)) problems.push(`mended from ${twin.twin}, it is still refused`);
  else if (!isDeepStrictEqual(mend, right)) {
    problems.push(`mended, it is not ${twin.twin}'s ${twin.part === "request" ? "exchange" : "outcome"}`);
  }
  return problems;
}

describe("data-access v1.18: each refused fixture for its one fault, mended from its twin into its twin", () => {
  it("has a twin for every refused v1.18 fixture and for no other file: an accepted v1.18 exchange of its call, the part the README names", () => {
    expect(Object.keys(TWINS).sort()).toEqual(refused.map((entry) => entry.file).sort());
    for (const entry of refused) {
      const twin = must(TWINS[entry.file], `${entry.file}'s twin`);
      const twinEntry = entryOf(twin.twin);
      const { call, part } = defOf(entry);
      expect([twinEntry.version, twinEntry.expect, twinEntry.def], `${entry.file}'s twin`).toEqual([
        VERSION,
        "accept",
        `${call}.exchange`,
      ]);
      // A refused exchange carries its fault in its request; a refused answer is its call's response.
      expect(part, entry.file).toBe(twin.part === "request" ? "exchange" : "response");
      for (const fault of twin.faults) {
        expect(twin.part === "outcome" || fault.startsWith("request."), `${entry.file}: ${fault}`).toBe(true);
      }
      expect(FIXTURES_PARAGRAPH, `${entry.file}: the README names its twin`).toContain(
        readmeTwinPhrase(entry, twin),
      );
    }
  });

  for (const entry of refused) {
    const twin = TWINS[entry.file];
    it(`refuses ${entry.file} for its one fault (${twin?.faults.join(", ") ?? "none"}); mended from ${twin?.twin ?? "no twin"}, it is that twin's ${twin?.part === "request" ? "exchange" : "outcome"}`, () => {
      const own = must(twin, `${entry.file}'s twin`);
      expect(twinProblems(entry, own)).toEqual([]);
    });
  }

  it("has the proof fire on a damaged twin: a fault named elsewhere, another twin, a fixture accepted as it stands, a phrase the README does not hold", () => {
    const entry = entryOf("invalid/refuse-business-kinds-setup-listing-phone.json");
    const own = must(TWINS[entry.file]);
    expect(twinProblems(entry, own)).toEqual([]);
    const barbershop = "read-business-kinds-barbershop.json";
    expect(twinProblems(entry, { ...own, faults: ["setup.noMoney"] })).toEqual([
      `it differs from ${barbershop} at setup.listingPhone, which is not the fault`,
      `the fault setup.noMoney is not where it differs from ${barbershop}`,
      `mended from ${barbershop}, it is still refused`,
    ]);
    const lee = "read-business-kinds-lee-home-services.json";
    expect(twinProblems(entry, { ...own, twin: lee })).toEqual([
      `it differs from ${lee} at businessId, which is not the fault`,
      `it differs from ${lee} at setup, which is not the fault`,
      `it differs from ${lee} at kinds, which is not the fault`,
      `mended, it is not ${lee}'s outcome`,
    ]);
    expect(twinProblems(entry, own, valueAt(fixture(barbershop), "outcome"))).toEqual([
      `${entry.file} is accepted as it stands`,
      "the schema's errors name none of setup.listingPhone",
      `the fault setup.listingPhone is not where it differs from ${barbershop}`,
    ]);
    // A refused request: its given and outcome are its twin's, so a twin of another given differs beside the fault.
    const noService = entryOf("invalid/refuse-service-ways-no-service.json");
    const ways = must(TWINS[noService.file]);
    expect(twinProblems(noService, ways)).toEqual([]);
    const skinFade = "read-service-ways-skin-fade.json";
    expect(twinProblems(noService, { ...ways, twin: skinFade })).toEqual([
      `it differs from ${skinFade} at given.note, which is not the fault`,
      `it differs from ${skinFade} at outcome.serviceId, which is not the fault`,
      `it differs from ${skinFade} at outcome.ways, which is not the fault`,
      `mended, it is not ${skinFade}'s exchange`,
    ]);
    expect(FIXTURES_PARAGRAPH).not.toContain(readmeTwinPhrase(entry, { ...own, twin: lee }));
    expect(FIXTURES_PARAGRAPH).not.toContain(readmeTwinPhrase(entry, { ...own, part: "request" }));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. What the schema leaves to the fixtures, read from them

type Row = Record<string, unknown>;

interface Exchange {
  call: string;
  given: { k04Seeds: string[]; partSeeds?: string[]; after: string[]; now: string; note?: string };
  request: Row;
  outcome: Row;
}
const exchangeOf = (file: string): Exchange => fixture(file) as Exchange;

/** The rows of one list of an answer (none where it holds no such list). */
const rowsOf = (holder: Row, list: string): Row[] => {
  const rows = holder[list];
  return Array.isArray(rows) ? (rows as Row[]) : [];
};

/**
 * Byte order, as PostgreSQL compares ids under collate "C" (README default 164): UTF-8 orders its bytes as it orders the
 * code points they spell, so two ids are compared code point by code point, a shorter one first where one begins the
 * other.
 */
function bytes(a: unknown, b: unknown): number {
  const left = String(a);
  const right = String(b);
  // Both ids hold the same code points up to `at`, so one place reads both; a code point past U+FFFF takes two units.
  let at = 0;
  while (at < left.length && at < right.length) {
    const mine = left.codePointAt(at) ?? 0;
    const theirs = right.codePointAt(at) ?? 0;
    if (mine !== theirs) return mine - theirs;
    at += mine > 0xffff ? 2 : 1;
  }
  return left.length - right.length;
}
const FLOWS = ["A", "B"];
/** Flow A before flow B. */
const byFlow = (a: Row, b: Row): number => FLOWS.indexOf(String(a.flow)) - FLOWS.indexOf(String(b.flow));
const byId = (a: Row, b: Row): number => bytes(a.id, b.id);

/** Each list's order (README default 164): kinds by (company_id, kind_id), flows A then B, services by (position, id). */
const ORDERS: Readonly<Record<string, { how: string; compare: (a: Row, b: Row) => number }>> = {
  kinds: {
    how: "(companyId, kindId)",
    compare: (a, b) => bytes(a.companyId, b.companyId) || bytes(a.kindId, b.kindId),
  },
  flows: { how: "flow (A, then B)", compare: byFlow },
  services: {
    how: "(position, id)",
    compare: (a, b) => Number(a.position) - Number(b.position) || byId(a, b),
  },
  ways: { how: "id", compare: byId },
  rules: { how: "id", compare: byId },
  ties: { how: "id", compare: byId },
  flowDefaults: { how: "flow (A, then B)", compare: byFlow },
  priceOkLimits: { how: "id", compare: byId },
};

/** The rows' order problem, none when each row comes strictly after the one before it. */
function orderProblems(rows: readonly Row[], list: string, where: string): string[] {
  const order = must(ORDERS[list], `the order of ${list}`);
  const ordered = rows.every((row, place) => place === 0 || order.compare(must(rows[place - 1]), row) < 0);
  return ordered ? [] : [`${where} are not in ${order.how} order`];
}

/** An instant's place in time (each a UTC instant ending in Z, which the schema holds). */
const timeOf = (instant: unknown): number => Date.parse(String(instant));

/**
 * Each way an accepted exchange's answer breaks what the schema leaves to the fixtures (README items 72 to 77, defaults
 * 153 to 165), none when it holds: the answer is its request's (its business, service and time echoed) at its read's
 * moment; a notFound names the request's business; every row is the request's business's, and a way, a price rule and a
 * tie the request's service's; each two-column row is named by item 77's rule; each list is in its order; a price rule
 * is answered while its effective_to is null or after at, and a rule or a price OK limit while its dates hold at.
 */
export function answerProblems(exchange: Exchange): string[] {
  const { request, outcome } = exchange;
  const business = String(request.businessId);
  if ("error" in outcome) {
    const names = outcome.table === "businesses" && outcome.rowId === business;
    return names
      ? []
      : [`the ${String(outcome.error)} names ${String(outcome.table)} ${String(outcome.rowId)}`];
  }
  const problems: string[] = [];
  if (outcome.businessId !== business) {
    problems.push(
      `the answer names the business ${String(outcome.businessId)}, not the request's ${business}`,
    );
  }
  for (const field of ["serviceId", "at"]) {
    if (Object.hasOwn(request, field) && outcome[field] !== request[field]) {
      problems.push(
        `the answer's ${field} is ${String(outcome[field])}, not the request's ${String(request[field])}`,
      );
    }
  }
  if (outcome.readAt !== exchange.given.now) {
    problems.push(
      `the answer is read at ${String(outcome.readAt)}, not at its read's moment ${exchange.given.now}`,
    );
  }
  const ofBusiness = (row: Row, where: string): void => {
    if (row.businessId !== business)
      problems.push(`${where} is ${String(row.businessId)}'s, not ${business}'s`);
  };
  const ofService = (row: Row, where: string): void => {
    if (row.serviceId !== request.serviceId) {
      problems.push(`${where} is of the service ${String(row.serviceId)}, not ${String(request.serviceId)}`);
    }
  };
  const named = (row: Row, where: string, rule: string): void => {
    if (row.rowId !== rule) problems.push(`${where} is named ${String(row.rowId)}, not ${rule} (item 77)`);
  };
  const at = timeOf(request.at);
  const inForce = (row: Row, where: string): void => {
    const ended = row.effectiveTo !== null && timeOf(row.effectiveTo) <= at;
    if (timeOf(row.effectiveFrom) > at || ended)
      problems.push(`${where} is not in force at ${String(request.at)}`);
  };
  const list = (name: string, each: (row: Row, where: string) => void): void => {
    const rows = rowsOf(outcome, name);
    rows.forEach((row, place) => {
      each(row, `${name}.${String(place)}`);
    });
    problems.push(...orderProblems(rows, name, name));
  };
  switch (exchange.call) {
    case "readBusinessKinds":
      if (isRecord(outcome.setup)) ofBusiness(outcome.setup, "setup");
      list("kinds", (kind, where) => {
        ofBusiness(kind, where);
        named(kind, where, `${String(kind.companyId)}/${String(kind.kindId)}`);
        const flows = rowsOf(kind, "flows");
        flows.forEach((flow, place) => {
          named(flow, `${where}.flows.${String(place)}`, `${String(kind.kindId)}/${String(flow.flow)}`);
        });
        problems.push(...orderProblems(flows, "flows", `${where}.flows`));
      });
      break;
    case "readBusinessServices":
      list("services", ofBusiness);
      break;
    case "readServiceWays":
      list("ways", (way, where) => {
        ofBusiness(way, where);
        ofService(way, where);
      });
      break;
    case "readServicePriceRules":
      list("rules", (rule, where) => {
        ofBusiness(rule, where);
        ofService(rule, where);
        const ended = rule.effectiveTo;
        if (typeof ended === "string" && timeOf(ended) <= at) {
          problems.push(`${where} ended at ${ended}, not after at ${String(request.at)}`);
        }
      });
      list("ties", (tie, where) => {
        ofBusiness(tie, where);
        ofService(tie, where);
      });
      break;
    case "readTermsSources":
      list("flowDefaults", (row, where) => {
        ofBusiness(row, where);
        named(row, where, `${String(row.businessId)}/${String(row.flow)}`);
      });
      for (const name of ["rules", "priceOkLimits"]) {
        list(name, (row, where) => {
          ofBusiness(row, where);
          inForce(row, where);
        });
      }
      break;
    default:
      problems.push(`v1.18 adds no call ${exchange.call}`);
  }
  return problems;
}

describe("data-access v1.18: what the schema leaves to the fixtures, each check also shown firing", () => {
  it("has every accepted exchange's answer be its request's: at its read's moment, of the request's business and service alone, item 77's names, each list in its order, the rules in effect or in force at at", () => {
    for (const entry of accepted) expect(answerProblems(exchangeOf(entry.file)), entry.file).toEqual([]);
    const calls = new Set(accepted.map((entry) => exchangeOf(entry.file).call));
    expect([...calls].sort()).toEqual([...ADDED_CALLS].sort());
    // Each list a check reads holds rows in some fixture, so no check passes for want of a row to read.
    const answers = accepted.map((entry) => exchangeOf(entry.file).outcome);
    for (const name of Object.keys(ORDERS).filter((name) => name !== "flows")) {
      expect(
        answers.some((outcome) => rowsOf(outcome, name).length > 0),
        `${name}: a row read`,
      ).toBe(true);
    }
    expect(
      answers.some((outcome) => rowsOf(outcome, "kinds").some((kind) => rowsOf(kind, "flows").length > 1)),
    ).toBe(true);
  });

  it("has the business, echo and moment checks fire on a damaged copy: another business's row, another service, another time, another moment, a notFound of another row", () => {
    const kinds = exchangeOf("read-business-kinds-barbershop.json");
    const setup = kinds.outcome.setup as Row;
    setup.businessId = "biz-lee-home-services";
    expect(answerProblems(kinds)).toEqual(["setup is biz-lee-home-services's, not biz-lees-barbershop's"]);
    const services = exchangeOf("read-business-services-lee-home-services.json");
    must(rowsOf(services.outcome, "services")[0]).businessId = "biz-lees-barbershop";
    expect(answerProblems(services)).toEqual([
      "services.0 is biz-lees-barbershop's, not biz-lee-home-services's",
    ]);
    const ways = exchangeOf("read-service-ways-haircut.json");
    must(rowsOf(ways.outcome, "ways")[1]).serviceId = "svc-lees-skin-fade";
    expect(answerProblems(ways)).toEqual([
      "ways.1 is of the service svc-lees-skin-fade, not svc-lees-haircut",
    ]);
    const tie = exchangeOf("read-price-rules-haircut-tie.json");
    must(rowsOf(tie.outcome, "ties")[0]).businessId = "biz-lee-home-services";
    tie.outcome.at = "2026-11-04T15:00:00Z";
    expect(answerProblems(tie)).toEqual([
      "the answer's at is 2026-11-04T15:00:00Z, not the request's 2026-11-04T14:00:00Z",
      "ties.0 is biz-lee-home-services's, not biz-lees-barbershop's",
    ]);
    const sources = exchangeOf("read-terms-sources-dee-skin-fade.json");
    sources.outcome.businessId = "biz-yoga-studio";
    sources.outcome.readAt = "2026-10-22T22:30:01Z";
    expect(answerProblems(sources)).toEqual([
      "the answer names the business biz-yoga-studio, not the request's biz-lees-barbershop",
      "the answer is read at 2026-10-22T22:30:01Z, not at its read's moment 2026-10-22T22:30:00Z",
    ]);
    const other = exchangeOf("read-service-ways-other-business-service.json");
    other.outcome.serviceId = "svc-lees-haircut";
    expect(answerProblems(other)).toEqual([
      "the answer's serviceId is svc-lees-haircut, not the request's svc-lee-electric-wiring-repair",
    ]);
    const notFound = exchangeOf("read-business-kinds-no-business-row.json");
    expect(answerProblems(notFound)).toEqual([]);
    notFound.outcome.rowId = "biz-lees-barbershop";
    expect(answerProblems(notFound)).toEqual(["the notFound names businesses biz-lees-barbershop"]);
  });

  it("has the name check fire on a damaged copy: a kind, a flow and a flow default named other than by item 77's rule", () => {
    const kinds = exchangeOf("read-business-kinds-lee-home-services.json");
    const plumber = must(rowsOf(kinds.outcome, "kinds")[1]);
    plumber.rowId = "company-lee-home-services/electrician";
    must(rowsOf(plumber, "flows")[0]).rowId = "plumber/B";
    expect(answerProblems(kinds)).toEqual([
      "kinds.1 is named company-lee-home-services/electrician, not company-lee-home-services/plumber (item 77)",
      "kinds.1.flows.0 is named plumber/B, not plumber/A (item 77)",
    ]);
    const sources = exchangeOf("read-terms-sources-after-no-show-count.json");
    must(rowsOf(sources.outcome, "flowDefaults")[1]).rowId = "biz-lee-home-services/B";
    expect(answerProblems(sources)).toEqual([
      "flowDefaults.1 is named biz-lee-home-services/B, not biz-lees-barbershop/B (item 77)",
    ]);
  });

  it("has the order check fire on a damaged copy: kinds, flows, services, ways, rules, limits and flow defaults out of their order", () => {
    const swapped = (holder: Row, name: string): void => {
      const rows = rowsOf(holder, name);
      holder[name] = [...rows].reverse();
    };
    const kinds = exchangeOf("read-business-kinds-lee-home-services.json");
    swapped(kinds.outcome, "kinds");
    swapped(must(rowsOf(kinds.outcome, "kinds")[0]), "flows");
    expect(answerProblems(kinds)).toEqual([
      "kinds.0.flows are not in flow (A, then B) order",
      "kinds are not in (companyId, kindId) order",
    ]);
    const services = exchangeOf("read-business-services-barbershop.json");
    const [first, second, ...rest] = rowsOf(services.outcome, "services");
    services.outcome.services = [must(second), must(first), ...rest];
    expect(answerProblems(services)).toEqual(["services are not in (position, id) order"]);
    // Two services at one position are ordered by id, byte by byte: the haircut before the skin fade.
    must(first).position = 2;
    services.outcome.services = [must(first), must(second), ...rest];
    expect(answerProblems(services)).toEqual([]);
    services.outcome.services = [must(second), must(first), ...rest];
    expect(answerProblems(services)).toEqual(["services are not in (position, id) order"]);
    const ways = exchangeOf("read-service-ways-haircut.json");
    swapped(ways.outcome, "ways");
    expect(answerProblems(ways)).toEqual(["ways are not in id order"]);
    const rules = exchangeOf("read-price-rules-haircut-before-raise.json");
    swapped(rules.outcome, "rules");
    expect(answerProblems(rules)).toEqual(["rules are not in id order"]);
    const sources = exchangeOf("read-terms-sources-after-no-show-count.json");
    swapped(sources.outcome, "flowDefaults");
    swapped(sources.outcome, "priceOkLimits");
    expect(answerProblems(sources)).toEqual([
      "flowDefaults are not in flow (A, then B) order",
      "priceOkLimits are not in id order",
    ]);
  });

  it("has the dates check fire on a damaged copy: a price rule ended at at, a rule not yet in force, a limit ended before at", () => {
    const rules = exchangeOf("read-price-rules-haircut-before-raise.json");
    must(rowsOf(rules.outcome, "rules")[0]).effectiveTo = "2026-10-27T14:00:00Z";
    expect(answerProblems(rules)).toEqual([
      "rules.0 ended at 2026-10-27T14:00:00Z, not after at 2026-10-27T14:00:00Z",
    ]);
    // The $35 still in effect at Oct 27 and closed later is answered (default 157): only an end at or before at is not.
    const before = exchangeOf("read-price-rules-haircut-before-raise.json");
    expect(must(rowsOf(before.outcome, "rules")[0]).effectiveTo).toBe("2026-11-02T05:00:00Z");
    const early = exchangeOf("read-terms-sources-dee-skin-fade.json");
    const noShow = exchangeOf("read-terms-sources-after-no-show-count.json");
    const count = must(rowsOf(noShow.outcome, "rules")[0]);
    early.outcome.rules = [count, ...rowsOf(early.outcome, "rules")];
    must(rowsOf(early.outcome, "priceOkLimits")[0]).effectiveTo = "2026-10-20T13:00:00Z";
    expect(answerProblems(early)).toEqual([
      "rules.0 is not in force at 2026-10-22T22:30:00Z",
      "priceOkLimits.0 is not in force at 2026-10-22T22:30:00Z",
    ]);
  });
});
